import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import type {
  AgentE2EReasonCode,
  BoundaryObservedFrom,
  BoundaryTraceEvent,
  PortableTargetProbeV1,
  PortableTargetRequestV1,
  PortableTargetResultV1,
  RuntimeProbeResult,
  TargetAdapter,
  TargetInvocationRequest,
  TargetInvocationResult,
  WorkspaceChange,
} from "../e2e/types";
import { runProcess } from "../runtime/process-runner";
import { ensureDir, writeJson } from "../utils/fs";

export interface PortableTargetAdapterConfig {
  command: string;
  runtime?: string;
  baseArgs?: string[];
  envAllowlist?: string[];
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export class PortableTargetAdapter implements TargetAdapter {
  readonly id: string;
  private readonly command: string;
  private readonly runtime?: string;
  private readonly baseArgs: string[];
  private readonly envAllowlist: string[];
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(config: PortableTargetAdapterConfig) {
    if (!config.command.trim()) throw new Error("Portable target driver command must be non-empty");
    this.command = config.command.includes(path.sep) ? path.resolve(config.command) : config.command;
    this.runtime = config.runtime;
    this.id = config.runtime ? `portable:${config.runtime}` : "portable";
    this.baseArgs = config.baseArgs ?? [];
    this.envAllowlist = config.envAllowlist ?? [];
    this.probeTimeoutMs = config.probeTimeoutMs ?? 5_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
    this.killGraceMs = config.killGraceMs ?? 500;
  }

  async probe(): Promise<RuntimeProbeResult> {
    const result = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "probe", "--json"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (result.spawnError) {
      return blockedProbe(
        this.command,
        result.spawnError.code === "ENOENT" ? "binary_not_found" : "spawn_error",
        processError(result.spawnError)
      );
    }
    if (result.timedOut) return blockedProbe(this.command, "target_timeout", "Portable target probe exceeded its deadline.");
    if (result.outputLimitExceeded) return blockedProbe(this.command, "output_limit_exceeded", "Portable target probe exceeded the output limit.");
    const parsed = parseProbe(result.stdout);
    if (!parsed.value || result.exitCode !== 0) {
      return blockedProbe(this.command, "target_protocol_error", parsed.error ?? "Portable target probe did not exit successfully.");
    }
    if (this.runtime && parsed.value.target.id !== this.runtime) {
      return blockedProbe(
        this.command,
        "target_protocol_error",
        `Portable driver identity ${parsed.value.target.id} does not match requested runtime ${this.runtime}.`
      );
    }
    return {
      component: "portable-target",
      status: parsed.value.status,
      ...(parsed.value.status === "blocked" && { reason_code: "target_reported_error" as const }),
      detail: parsed.value.detail,
      command: this.command,
      version: parsed.value.target.version,
      capabilities: parsed.value.capabilities,
    };
  }

  async execute(request: TargetInvocationRequest): Promise<TargetInvocationResult> {
    ensureDir(request.workspace);
    const privateRoot = path.join(path.dirname(request.workspace), ".portable", request.attempt_id);
    ensureDir(privateRoot);
    fs.chmodSync(privateRoot, 0o700);
    const promptPath = path.join(privateRoot, "prompt.txt");
    const requestPath = path.join(privateRoot, "request.json");
    fs.writeFileSync(promptPath, request.prompt, { encoding: "utf8", mode: 0o600 });
    const promptSha256 = sha256(request.prompt);
    const runtime = request.target.runtime ?? this.runtime;
    if (!runtime || !/^[A-Za-z0-9._-]+$/.test(runtime)) {
      return blockedInvocation(this.id, request, "config_invalid", "Portable cases require a safe target.runtime identity.");
    }
    const envNames = [...new Set([...this.envAllowlist, ...(request.target.env_allowlist ?? [])])];
    const sessionId = `barena-${safeId(request.run_id)}-${safeId(request.case_id)}-${safeId(request.attempt_id)}`;
    const driverRequest: PortableTargetRequestV1 = {
      schema: "barena.portable_target_request.v1",
      run_id: request.run_id,
      case_id: request.case_id,
      attempt_id: request.attempt_id,
      session_id: sessionId,
      deadline: new Date(Date.now() + request.timeout_ms).toISOString(),
      prompt: { path: promptPath, sha256: promptSha256 },
      workspace: request.workspace,
      trace_path: request.trace_path,
      target: {
        runtime,
        ...(request.target.agent && { agent: request.target.agent }),
        ...(request.target.model && { model: request.target.model }),
        ...(request.target.thinking && { thinking: request.target.thinking }),
        env_names: envNames,
      },
      skill: request.skill,
    };
    writeJson(requestPath, driverRequest);
    fs.chmodSync(requestPath, 0o600);

    const before = snapshotWorkspace(request.workspace);
    const events: BoundaryTraceEvent[] = [
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_input",
        kind: "user",
        message: request.prompt,
        data: {
          transport: "prompt_file",
          prompt_sha256: promptSha256,
          request_ref: requestPath,
          session_id: sessionId,
        },
      }),
    ];
    const result = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "run", "--request", requestPath],
      cwd: request.workspace,
      env: this.buildEnv(envNames),
      timeoutMs: request.timeout_ms,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const after = snapshotWorkspace(request.workspace);
    const changes = diffWorkspace(before, after);
    if (result.stderr.trim()) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_stderr",
        kind: "runtime_status",
        message: result.stderr,
        data: { bytes: Buffer.byteLength(result.stderr) },
      }));
    }
    const parsed = parseResult(result.stdout);
    const protocolReason = validateObserved(parsed.value, driverRequest);
    const classification = classify(result, parsed.value, parsed.error ?? protocolReason);
    const payloadTexts = parsed.value?.payload_texts ?? [];
    for (const payload of payloadTexts) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_stdout",
        kind: "assistant",
        message: payload,
      }));
    }
    if (result.stdout.trim()) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_stdout",
        kind: "runtime_status",
        message: parsed.value ? "Parsed one portable target result object." : "Portable target result was not valid.",
        data: { stdout_bytes: Buffer.byteLength(result.stdout), stdout_sha256: sha256(result.stdout) },
      }));
    }
    for (const change of changes) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "workspace",
        kind: "artifact",
        message: `${change.change} workspace/${change.path}`,
        data: { ...change },
      }));
    }
    events.push(boundaryEvent({
      runId: request.run_id,
      caseId: request.case_id,
      attemptId: request.attempt_id,
      component: this.id,
      observedFrom: "target_process",
      kind: "runtime_status",
      message: classification.detail,
      data: {
        status: classification.status,
        reason_code: classification.reasonCode,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      },
    }));
    writeBoundaryEvents(request.trace_path, events);
    const coverage: BoundaryObservedFrom[] = ["target_input", "target_process", "workspace"];
    if (result.stdout.length) coverage.push("target_stdout");
    if (result.stderr.length) coverage.push("target_stderr");
    return {
      status: classification.status,
      ...(classification.reasonCode && { reason_code: classification.reasonCode }),
      detail: classification.detail,
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: result.durationMs,
      transport: "portable_json_driver",
      payload_texts: payloadTexts,
      media_refs: parsed.value?.media_refs ?? [],
      provider: parsed.value?.provider,
      model: parsed.value?.model,
      session_id: parsed.value?.session_id,
      native_trace_available: false,
      observation_coverage: coverage,
      trace_path: request.trace_path,
      events,
      workspace_changes: changes,
    };
  }

  private buildEnv(names: string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      NO_COLOR: "1",
      CI: "1",
    };
    for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
    return env;
  }
}

function parseProbe(stdout: string): { value?: PortableTargetProbeV1; error?: string } {
  const parsed = parseOneObject(stdout, "Portable target probe");
  if (!parsed.value) return { error: parsed.error };
  const value = parsed.value;
  const target = record(value.target);
  if (
    value.schema !== "barena.portable_target_probe.v1" ||
    !["ready", "blocked"].includes(String(value.status)) ||
    !target ||
    typeof target.id !== "string" ||
    !target.id.trim() ||
    typeof value.detail !== "string" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string")
  ) {
    return { error: "Portable target probe object does not satisfy barena.portable_target_probe.v1." };
  }
  return { value: value as unknown as PortableTargetProbeV1 };
}

function parseResult(stdout: string): { value?: PortableTargetResultV1; error?: string } {
  const parsed = parseOneObject(stdout, "Portable target result");
  if (!parsed.value) return { error: parsed.error };
  const value = parsed.value;
  const observed = record(value.observed);
  const skill = record(observed?.skill);
  if (
    value.schema !== "barena.portable_target_result.v1" ||
    !["completed", "failed", "blocked", "unsafe"].includes(String(value.status)) ||
    typeof value.detail !== "string" ||
    !observed ||
    typeof observed.prompt_sha256 !== "string" ||
    typeof observed.workspace !== "string" ||
    !skill ||
    !["none", "path"].includes(String(skill.mode)) ||
    !Array.isArray(skill.active_skill_names) ||
    !skill.active_skill_names.every((item) => typeof item === "string") ||
    (value.payload_texts !== undefined &&
      (!Array.isArray(value.payload_texts) || !value.payload_texts.every((item) => typeof item === "string"))) ||
    (value.media_refs !== undefined &&
      (!Array.isArray(value.media_refs) || !value.media_refs.every((item) => typeof item === "string")))
  ) {
    return { error: "Portable target result object does not satisfy barena.portable_target_result.v1." };
  }
  return { value: value as unknown as PortableTargetResultV1 };
}

function validateObserved(value: PortableTargetResultV1 | undefined, request: PortableTargetRequestV1): string | undefined {
  if (!value) return undefined;
  if (value.observed.prompt_sha256 !== request.prompt.sha256) return "Portable target did not confirm the exact prompt hash.";
  if (path.resolve(value.observed.workspace) !== path.resolve(request.workspace)) return "Portable target reported a different workspace.";
  if (value.observed.skill.mode !== request.skill.mode) return "Portable target reported a different Skill mode.";
  const active = value.observed.skill.active_skill_names;
  if (request.skill.mode === "none" && active.length > 0) return "Portable baseline exposed one or more active Skills.";
  if (request.skill.mode === "path") {
    if (!active.includes(request.skill.name)) return `Portable target did not activate candidate Skill ${request.skill.name}.`;
    if (value.observed.skill.selected_skill_fingerprint !== request.skill.fingerprint) {
      return "Portable target did not confirm the candidate Skill fingerprint.";
    }
  }
  if (value.status !== "blocked" && (!value.session_id || !value.session_id.trim())) {
    return "Portable target result requires a non-empty session_id.";
  }
  return undefined;
}

function classify(
  processResult: Awaited<ReturnType<typeof runProcess>>,
  value: PortableTargetResultV1 | undefined,
  protocolError: string | undefined
): { status: TargetInvocationResult["status"]; reasonCode?: AgentE2EReasonCode; detail: string } {
  if (processResult.spawnError) {
    return {
      status: "blocked",
      reasonCode: processResult.spawnError.code === "ENOENT" ? "binary_not_found" : "spawn_error",
      detail: processError(processResult.spawnError),
    };
  }
  if (processResult.timedOut) return { status: "blocked", reasonCode: "target_timeout", detail: "Portable target exceeded the hard deadline." };
  if (processResult.outputLimitExceeded) {
    return { status: "blocked", reasonCode: "output_limit_exceeded", detail: "Portable target exceeded the captured output limit." };
  }
  if (protocolError || !value) {
    return {
      status: "blocked",
      reasonCode: protocolError?.includes("active Skills")
        ? "baseline_skill_leak"
        : protocolError?.includes("candidate Skill")
          ? "skill_not_visible"
          : "target_protocol_error",
      detail: protocolError ?? "Portable target returned no result.",
    };
  }
  if (processResult.exitCode !== 0 && value.status === "completed") {
    return { status: "blocked", reasonCode: "target_process_failed", detail: "Portable target reported completion but exited unsuccessfully." };
  }
  if (value.status === "unsafe") return { status: "unsafe", reasonCode: "target_reported_unsafe", detail: value.detail };
  if (value.status === "blocked") return { status: "blocked", reasonCode: "target_reported_error", detail: value.detail };
  if (value.status === "failed") return { status: "failed", reasonCode: "target_reported_error", detail: value.detail };
  return { status: "completed", detail: value.detail };
}

function blockedInvocation(
  component: string,
  request: TargetInvocationRequest,
  reason: AgentE2EReasonCode,
  detail: string
): TargetInvocationResult {
  const event = boundaryEvent({
    runId: request.run_id,
    caseId: request.case_id,
    attemptId: request.attempt_id,
    component,
    observedFrom: "target_process",
    kind: "runtime_status",
    message: detail,
    data: { status: "blocked", reason_code: reason },
  });
  writeBoundaryEvents(request.trace_path, [event]);
  return {
    status: "blocked",
    reason_code: reason,
    detail,
    exit_code: null,
    signal: null,
    duration_ms: 0,
    transport: "portable_json_driver",
    payload_texts: [],
    media_refs: [],
    native_trace_available: false,
    observation_coverage: ["target_process"],
    trace_path: request.trace_path,
    events: [event],
    workspace_changes: [],
  };
}

function blockedProbe(command: string, reason: AgentE2EReasonCode, detail: string): RuntimeProbeResult {
  return { component: "portable-target", status: "blocked", reason_code: reason, detail, command, capabilities: [] };
}

function parseOneObject(stdout: string, label: string): { value?: Record<string, unknown>; error?: string } {
  if (!stdout.trim()) return { error: `${label} stdout was empty.` };
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value: value as Record<string, unknown> }
      : { error: `${label} stdout was not one JSON object.` };
  } catch {
    return { error: `${label} stdout was not exactly one valid JSON object.` };
  }
}

function snapshotWorkspace(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.set(relative, sha256(fs.readFileSync(absolute)));
    }
  };
  visit(root);
  return result;
}

function diffWorkspace(before: Map<string, string>, after: Map<string, string>): WorkspaceChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((relative): WorkspaceChange[] => {
    const oldHash = before.get(relative);
    const newHash = after.get(relative);
    if (oldHash === newHash) return [];
    if (!oldHash) return [{ path: relative, change: "created", sha256_after: newHash }];
    if (!newHash) return [{ path: relative, change: "deleted", sha256_before: oldHash }];
    return [{ path: relative, change: "modified", sha256_before: oldHash, sha256_after: newHash }];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function processError(error: NodeJS.ErrnoException): string {
  return error.code === "ENOENT"
    ? "Portable target driver binary was not found."
    : `Portable target driver could not start (${error.code ?? "unknown error"}).`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
