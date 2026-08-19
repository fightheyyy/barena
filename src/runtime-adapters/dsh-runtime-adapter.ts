import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  formatMessagesAsPrompt,
  normalizedVersion,
  processFailure,
  processOutcome,
  redactText,
  stripAnsi,
} from "./helpers";
import { RuntimeProcessSupervisor, type SupervisedProcessResult } from "./process-supervisor";
import { buildRuntimeEnv } from "./telemetry";
import {
  RuntimeAdapterError,
  type AgentRuntimeAdapter,
  type AgentRuntimeSession,
  type CliRuntimeAdapterConfig,
  type OpenRuntimeSessionRequest,
  type RuntimeCapabilities,
  type RuntimeMessage,
  type RuntimeProbeRequest,
  type RuntimeProbeResult,
  type RuntimeReasonCode,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
} from "./types";

interface DshSessionState {
  public_session: AgentRuntimeSession;
  request: OpenRuntimeSessionRequest;
  messages: RuntimeMessage[];
  dsh_home: string;
  plugin_prepared: boolean;
  closed: boolean;
}

export interface DshRuntimeAdapterConfig extends CliRuntimeAdapterConfig {
  profile?: string;
  patch_path?: string;
  plugin_path?: string;
  parse_output?: (stdout: string) => string;
}

/**
 * Public-CLI adapter for DeepSeek Harness.
 *
 * DSH's headless command creates one fresh persisted session per invocation.
 * Barena therefore preserves a multi-turn test by replaying the complete
 * visible conversation. It does not import DSH packages or claim native resume.
 */
export class DshRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "dsh";
  readonly capabilities: RuntimeCapabilities = {
    session_mode: "full-history-replay",
    output_protocol: "text",
    cancellation: true,
    telemetry: "bridge",
    trace_context_propagation: false,
    target_enumeration: false,
  };

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly profile: string;
  private readonly patchPath?: string;
  private readonly pluginPath?: string;
  private readonly envAllowlist: string[];
  private readonly envOverrides: Record<string, string>;
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly parseOutput: (stdout: string) => string;
  private readonly supervisor = new RuntimeProcessSupervisor();
  private readonly sessions = new Map<string, DshSessionState>();

  constructor(config: DshRuntimeAdapterConfig = {}) {
    const command = config.command ?? "dsh";
    this.command = command.includes(path.sep) ? path.resolve(command) : command;
    this.baseArgs = [...(config.base_args ?? [])];
    this.profile = config.profile?.trim() || "headless";
    if (!isSafeId(this.profile)) {
      throw new RuntimeAdapterError("config_invalid", "DSH profile must be a safe identifier.");
    }
    this.patchPath = config.patch_path
      ? validateDshPatch(config.patch_path)
      : undefined;
    this.pluginPath = config.plugin_path
      ? validateDshPluginPackage(config.plugin_path)
      : undefined;
    this.envAllowlist = [...new Set(config.env_allowlist ?? [])];
    this.envOverrides = { ...(config.env_overrides ?? {}) };
    this.probeTimeoutMs = config.probe_timeout_ms ?? 8_000;
    this.maxOutputBytes = config.max_output_bytes ?? 4 * 1024 * 1024;
    this.killGraceMs = config.kill_grace_ms ?? 1_000;
    this.parseOutput = config.parse_output ?? defaultDshOutput;
  }

  async probe(_request: RuntimeProbeRequest = {}): Promise<RuntimeProbeResult> {
    const env = this.buildEnv(this.envAllowlist);
    const version = await this.supervisor.run({
      key: `${this.id}:probe:version`,
      command: this.command,
      args: [...this.baseArgs, "--version"],
      env,
      timeout_ms: this.probeTimeoutMs,
      max_output_bytes: this.maxOutputBytes,
      kill_grace_ms: this.killGraceMs,
    });
    if (version.spawn_error || version.exit_code !== 0 || version.timed_out || version.output_limit_exceeded) {
      const reason: RuntimeReasonCode =
        version.spawn_error?.code === "ENOENT" ? "binary_not_found" : "binary_not_executable";
      return blockedProbe(this.command, this.capabilities, reason, "DeepSeek Harness version probe did not complete successfully.");
    }
    const help = await this.supervisor.run({
      key: `${this.id}:probe:help`,
      command: this.command,
      args: [...this.baseArgs, "--help"],
      env,
      timeout_ms: this.probeTimeoutMs,
      max_output_bytes: this.maxOutputBytes,
      kill_grace_ms: this.killGraceMs,
    });
    if (help.spawn_error || help.exit_code !== 0 || help.timed_out || help.output_limit_exceeded) {
      const reason: RuntimeReasonCode =
        help.spawn_error?.code === "ENOENT" ? "binary_not_found" : "binary_not_executable";
      return blockedProbe(this.command, this.capabilities, reason, "DeepSeek Harness CLI probe did not complete successfully.");
    }
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (!helpText.includes("--profile")) {
      return blockedProbe(
        this.command,
        this.capabilities,
        "cli_contract_missing",
        "DeepSeek Harness CLI does not expose the required public --profile contract."
      );
    }
    return {
      runtime_id: this.id,
      status: "ready",
      detail: `DeepSeek Harness public headless profile '${this.profile}' is available.`,
      command: this.command,
      version: normalizedVersion(version.stdout, version.stderr),
      capabilities: this.capabilities,
      validated_targets: [],
    };
  }

  async openSession(request: OpenRuntimeSessionRequest): Promise<AgentRuntimeSession> {
    for (const [label, value] of [
      ["run_id", request.run_id],
      ["scenario_id", request.scenario_id],
      ["attempt_id", request.attempt_id],
      ["session_id", request.session_id],
      ["thread_id", request.thread_id],
    ] as const) {
      if (!isSafeId(value)) {
        throw new RuntimeAdapterError("config_invalid", `${label} must be a safe identifier.`);
      }
    }
    if (this.sessions.has(request.session_id)) {
      throw new RuntimeAdapterError("config_invalid", `Runtime session already exists: ${request.session_id}`);
    }
    const workspace = path.resolve(request.workspace);
    fs.mkdirSync(workspace, { recursive: true });
    const dshHome = path.join(workspace, ".barena-dsh", request.session_id);
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(dshHome, 0o700);
    const publicSession: AgentRuntimeSession = {
      runtime_id: this.id,
      session_id: request.session_id,
      thread_id: request.thread_id,
      workspace,
      target: {
        ...request.target,
        env_allowlist: [...new Set(request.target.env_allowlist ?? [])],
      },
      session_mode: this.capabilities.session_mode,
      opened_at: new Date().toISOString(),
    };
    this.sessions.set(request.session_id, {
      public_session: publicSession,
      request: { ...request, workspace },
      messages: [],
      dsh_home: dshHome,
      plugin_prepared: !this.pluginPath,
      closed: false,
    });
    return publicSession;
  }

  async sendTurn(session: AgentRuntimeSession, turn: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.public_session.thread_id !== session.thread_id) {
      return immediateFailure(this.capabilities, turn, "session_not_found", "DeepSeek Harness session does not exist.");
    }
    if (state.closed) {
      return immediateFailure(this.capabilities, turn, "session_closed", "DeepSeek Harness session is already closed.");
    }
    if (!turn.message.trim()) {
      return immediateFailure(this.capabilities, turn, "protocol_error", "DeepSeek Harness user turn must not be empty.");
    }

    const envNames = [...new Set([...this.envAllowlist, ...(state.public_session.target.env_allowlist ?? [])])];
    const env = this.buildEnv(envNames, state.dsh_home);
    if (!state.plugin_prepared && this.pluginPath) {
      const prepared = await this.supervisor.run({
        key: `${state.public_session.thread_id}:plugin`,
        command: this.command,
        args: [
          ...this.baseArgs,
          "plugin",
          "--profile",
          this.profile,
          "add",
          this.pluginPath,
          "--ignore-scripts",
        ],
        cwd: state.public_session.workspace,
        env,
        timeout_ms: turn.timeout_ms,
        max_output_bytes: this.maxOutputBytes,
        kill_grace_ms: this.killGraceMs,
      });
      const safePrepared = sanitizeProcess(prepared, secretsFor(envNames, this.envOverrides));
      const failure = processFailure(safePrepared, this.capabilities, turn.telemetry, "DeepSeek Harness Plugin setup");
      if (failure) {
        await exportDshBridgeSpan({ state, turn, result: failure, startedAt: new Date(Date.now() - safePrepared.duration_ms) });
        return { ...failure, native_trace_refs: findDshEvidence(state.dsh_home) };
      }
      state.plugin_prepared = true;
    }

    const userMessage: RuntimeMessage = { role: "user", content: turn.message };
    const prompt = formatMessagesAsPrompt([...state.messages, userMessage]);
    const startedAt = new Date();
    const raw = await this.supervisor.run({
      key: state.public_session.thread_id,
      command: this.command,
      args: [
        ...this.baseArgs,
        "--profile",
        this.profile,
        ...(this.patchPath ? ["--patch", this.patchPath] : []),
        prompt,
      ],
      cwd: state.public_session.workspace,
      env,
      timeout_ms: turn.timeout_ms,
      max_output_bytes: this.maxOutputBytes,
      kill_grace_ms: this.killGraceMs,
    });
    const result = sanitizeProcess(raw, secretsFor(envNames, this.envOverrides));
    const failure = processFailure(result, this.capabilities, turn.telemetry, "DeepSeek Harness");
    if (failure) {
      await exportDshBridgeSpan({ state, turn, result: failure, startedAt });
      return { ...failure, native_trace_refs: findDshEvidence(state.dsh_home) };
    }
    const assistantText = this.parseOutput(result.stdout);
    if (!assistantText.trim()) {
      const blocked: RuntimeTurnResult = {
        status: "blocked",
        reason_code: "protocol_error",
        detail: "DeepSeek Harness completed without an observable final assistant response.",
        process: processOutcome(result),
        telemetry: telemetrySummary(this.capabilities, turn),
        native_trace_refs: findDshEvidence(state.dsh_home),
      };
      await exportDshBridgeSpan({ state, turn, result: blocked, startedAt });
      return blocked;
    }
    const assistant: RuntimeMessage = { role: "assistant", content: assistantText };
    state.messages.push(userMessage, assistant);
    const completed: RuntimeTurnResult = {
      status: "completed",
      detail: `DeepSeek Harness completed the turn with profile '${this.profile}' using explicit full-history replay.`,
      assistant,
      process: processOutcome(result),
      telemetry: telemetrySummary(this.capabilities, turn),
      native_trace_refs: findDshEvidence(state.dsh_home),
    };
    await exportDshBridgeSpan({ state, turn, result: completed, startedAt });
    return completed;
  }

  async cancel(session: AgentRuntimeSession, _reason: string): Promise<boolean> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.closed) return false;
    return this.supervisor.cancel(state.public_session.thread_id) ||
      this.supervisor.cancel(`${state.public_session.thread_id}:plugin`);
  }

  async close(session: AgentRuntimeSession): Promise<void> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.closed) return;
    state.closed = true;
    await this.supervisor.close(state.public_session.thread_id);
    await this.supervisor.close(`${state.public_session.thread_id}:plugin`);
  }

  private buildEnv(names: string[], dshHome?: string): NodeJS.ProcessEnv {
    return buildRuntimeEnv({
      runtime_id: this.id,
      env_allowlist: names,
      overrides: {
        ...this.envOverrides,
        ...(dshHome && { DSH_HOME: dshHome }),
        DSH_PERMISSION_MODE: "workspace-write",
        // DSH's public config enum uses DISABLED; "OFF" is not accepted by
        // the shipped profile and would make a real headless run fail at boot.
        DSH_TELEMETRY_MODE: "DISABLED",
        NO_COLOR: "1",
        CI: "1",
      },
    });
  }
}

function blockedProbe(command: string, capabilities: RuntimeCapabilities, reasonCode: RuntimeReasonCode, detail: string): RuntimeProbeResult {
  return { runtime_id: "dsh", status: "blocked", reason_code: reasonCode, detail, command, capabilities, validated_targets: [] };
}

function immediateFailure(capabilities: RuntimeCapabilities, turn: RuntimeTurnInput, reasonCode: RuntimeReasonCode, detail: string): RuntimeTurnResult {
  return {
    status: "blocked",
    reason_code: reasonCode,
    detail,
    process: { exit_code: null, signal: null, duration_ms: 0, stdout: "", stderr: "" },
    telemetry: telemetrySummary(capabilities, turn),
    native_trace_refs: [],
  };
}

function telemetrySummary(capabilities: RuntimeCapabilities, turn: RuntimeTurnInput): RuntimeTurnResult["telemetry"] {
  return {
    mode: capabilities.telemetry,
    configured: Boolean(turn.telemetry),
    trace_context_propagated: false,
  };
}

function sanitizeProcess(result: SupervisedProcessResult, secrets: string[]): SupervisedProcessResult {
  return {
    ...result,
    stdout: redactText(stripAnsi(result.stdout), secrets),
    stderr: redactText(stripAnsi(result.stderr), secrets),
  };
}

function secretsFor(names: string[], overrides: Record<string, string>): string[] {
  return [
    ...Object.entries(overrides)
      .filter(([name]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
      .map(([, value]) => value),
    ...names
      .filter((name) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value)),
  ];
}

function defaultDshOutput(stdout: string): string {
  return stripAnsi(stdout).trim();
}

function validateDshPatch(input: string): string {
  const patch = path.resolve(input);
  if (!fs.existsSync(patch) || !fs.statSync(patch).isFile() || fs.lstatSync(patch).isSymbolicLink()) {
    throw new RuntimeAdapterError("config_invalid", `DSH patch is not a regular file: ${patch}`);
  }
  return patch;
}

function validateDshPluginPackage(input: string): string {
  const root = path.resolve(input);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new RuntimeAdapterError("config_invalid", `DSH Plugin path is not a regular directory: ${root}`);
  }
  rejectPackageSymlinks(root);
  const manifestPath = path.join(root, "package.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin must contain package.json.");
  }
  let manifest: {
    name?: unknown;
    version?: unknown;
    scripts?: unknown;
    dsh?: { bundle?: { patch?: unknown } };
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin package.json is invalid JSON.");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim().startsWith("dsh-plugin-")) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin package name must begin with dsh-plugin-.");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin package.json must declare a version.");
  }
  if (
    manifest.scripts !== undefined &&
    (typeof manifest.scripts !== "object" || manifest.scripts === null ||
      Object.keys(manifest.scripts as Record<string, unknown>).length > 0)
  ) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin package.json must not declare lifecycle scripts.");
  }
  const patch = manifest.dsh?.bundle?.patch;
  if (patch !== "./cordis.patch.yml") {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin package.json must set dsh.bundle.patch to ./cordis.patch.yml.");
  }
  const patchPath = path.resolve(root, patch);
  if (patchPath !== root && !patchPath.startsWith(`${root}${path.sep}`)) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin patch must stay inside the package root.");
  }
  if (!fs.existsSync(patchPath) || !fs.statSync(patchPath).isFile() || fs.lstatSync(patchPath).isSymbolicLink()) {
    throw new RuntimeAdapterError("config_invalid", "DSH Plugin patch file does not exist or is unsafe.");
  }
  return root;
}

function rejectPackageSymlinks(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new RuntimeAdapterError("config_invalid", `DSH Plugin packages must not contain symlinks: ${full}`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
}

function findDshEvidence(root: string): string[] {
  const refs: string[] = [];
  const walk = (directory: string): void => {
    if (refs.length >= 200) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (refs.length >= 200 || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:jsonl(?:\.zstd)?|sqlite|db)$/i.test(entry.name)) refs.push(full);
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  return refs.sort();
}

async function exportDshBridgeSpan(input: {
  state: DshSessionState;
  turn: RuntimeTurnInput;
  result: RuntimeTurnResult;
  startedAt: Date;
}): Promise<void> {
  if (!input.turn.telemetry) return;
  const context = parseTraceparent(input.turn.telemetry.traceparent);
  const traceId = context?.traceId ?? nonZeroHex(16);
  const spanId = nonZeroHex(8);
  const end = new Date(Math.max(Date.now(), input.startedAt.getTime() + 1));
  const assistant = input.result.assistant?.content ?? "";
  const attributes = {
    "service.name": input.turn.telemetry.service_name ?? "barena-dsh-target",
    "agent.runtime": "dsh",
    "gen_ai.system": "deepseek-harness",
    "catena.node.kind": "turn",
    "barena.provenance.layer": "adapter_bridge",
    "barena.run.id": input.state.request.run_id,
    "barena.scenario.id": input.state.request.scenario_id,
    "barena.attempt.id": input.state.request.attempt_id,
    "agent.session.id": input.state.public_session.session_id,
    "input.value": input.turn.message,
    "output.value": assistant,
    "barena.turn.status": input.result.status,
  };
  const body = {
    resourceSpans: [{
      resource: { attributes: otlpAttributes({
        "service.name": attributes["service.name"],
        "agent.runtime": attributes["agent.runtime"],
        "gen_ai.system": attributes["gen_ai.system"],
        "barena.provenance.layer": attributes["barena.provenance.layer"],
      }) },
      scopeSpans: [{
        scope: { name: "github.com/fightheyyy/barena/dsh-adapter", version: "0.1.0" },
        spans: [{
          traceId: Buffer.from(traceId, "hex").toString("base64"),
          spanId: Buffer.from(spanId, "hex").toString("base64"),
          ...(context && { parentSpanId: Buffer.from(context.parentSpanId, "hex").toString("base64") }),
          name: "barena.dsh.turn",
          kind: 1,
          startTimeUnixNano: unixNano(input.startedAt),
          endTimeUnixNano: unixNano(end),
          attributes: otlpAttributes(attributes),
          status: input.result.status === "completed"
            ? { code: 1 }
            : { code: 2, message: input.result.detail.slice(0, 1_000) },
        }],
      }],
    }],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.turn.telemetry.export_timeout_ms ?? 10_000);
  try {
    await fetch(input.turn.telemetry.traces_endpoint, {
      method: "POST",
      headers: { ...(input.turn.telemetry.headers ?? {}), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // The Explore evidence gate observes the missing envelope and blocks. A
    // telemetry transport failure must not be rewritten as target behavior.
  } finally {
    clearTimeout(timeout);
  }
}

function parseTraceparent(value?: string): { traceId: string; parentSpanId: string } | undefined {
  const match = value?.trim().toLowerCase().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(?:-.+)?$/);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], parentSpanId: match[2] };
}

function nonZeroHex(bytes: number): string {
  let value = crypto.randomBytes(bytes).toString("hex");
  while (/^0+$/.test(value)) value = crypto.randomBytes(bytes).toString("hex");
  return value;
}

function unixNano(value: Date): string {
  return (BigInt(value.getTime()) * 1_000_000n).toString();
}

function otlpAttributes(values: Record<string, string | number | boolean>) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "boolean"
      ? { boolValue: value }
      : typeof value === "number"
        ? { intValue: String(value) }
        : { stringValue: value },
  }));
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}
