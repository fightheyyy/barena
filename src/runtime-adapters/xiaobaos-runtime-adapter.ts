import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/fs";
import {
  formatMessagesAsPrompt,
  normalizedVersion,
  processFailure,
  processOutcome,
  redactText,
  stripAnsi,
} from "./helpers";
import { RuntimeProcessSupervisor, type SupervisedProcessResult } from "./process-supervisor";
import { resolveXiaobaInstallation, resolveXiaobaRole } from "./registry";
import { buildRuntimeEnv } from "./telemetry";
import {
  readXiaobaProjectSecretValues,
  xiaobaProjectDotenvPath,
} from "./xiaoba-project-env";
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

interface SessionState {
  public_session: AgentRuntimeSession;
  request: OpenRuntimeSessionRequest;
  messages: RuntimeMessage[];
  closed: boolean;
}

export interface XiaobaOSRuntimeAdapterConfig extends CliRuntimeAdapterConfig {
  parse_output?: (stdout: string) => string;
}

export class XiaobaOSRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "xiaobaos";
  readonly capabilities: RuntimeCapabilities = {
    session_mode: "full-history-replay",
    output_protocol: "text",
    cancellation: true,
    telemetry: "native",
    trace_context_propagation: false,
    target_enumeration: true,
  };

  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly projectRoot?: string;
  private readonly rolesRoot?: string;
  private readonly skillsRoot?: string;
  private readonly envAllowlist: string[];
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly parseOutput: (stdout: string) => string;
  private readonly projectSecrets: string[];
  private readonly supervisor = new RuntimeProcessSupervisor();
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: XiaobaOSRuntimeAdapterConfig = {}) {
    const installation = resolveXiaobaInstallation({
      command: config.command,
      project_root: config.project_root,
      roles_root: config.roles_root,
      skills_root: config.skills_root,
    });
    this.command = installation.command.includes(path.sep)
      ? path.resolve(installation.command)
      : installation.command;
    this.baseArgs = config.base_args ?? [];
    this.projectRoot = installation.project_root;
    this.rolesRoot = installation.roles_root;
    this.skillsRoot = config.skills_root
      ? path.resolve(config.skills_root)
      : installation.skills_root;
    this.envAllowlist = config.env_allowlist ?? [];
    this.probeTimeoutMs = config.probe_timeout_ms ?? 5_000;
    this.maxOutputBytes = config.max_output_bytes ?? 4 * 1024 * 1024;
    this.killGraceMs = config.kill_grace_ms ?? 750;
    this.parseOutput = config.parse_output ?? defaultXiaobaOutput;
    this.projectSecrets = readXiaobaProjectSecretValues(this.projectRoot);
    assertNoArenaArgs(this.baseArgs);
  }

  async probe(request: RuntimeProbeRequest = {}): Promise<RuntimeProbeResult> {
    const layoutIssue = this.configuredLayoutIssue();
    if (layoutIssue) {
      return blockedProbe(this.command, this.capabilities, "config_invalid", layoutIssue);
    }

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
    if (
      version.spawn_error ||
      version.exit_code !== 0 ||
      version.timed_out ||
      version.output_limit_exceeded
    ) {
      const reason: RuntimeReasonCode =
        version.spawn_error?.code === "ENOENT" ? "binary_not_found" : "binary_not_executable";
      return blockedProbe(
        this.command,
        this.capabilities,
        reason,
        "XiaoBaOS version probe did not complete successfully."
      );
    }

    const help = await this.supervisor.run({
      key: `${this.id}:probe:chat-help`,
      command: this.command,
      args: [...this.baseArgs, "chat", "--help"],
      env,
      timeout_ms: this.probeTimeoutMs,
      max_output_bytes: this.maxOutputBytes,
      kill_grace_ms: this.killGraceMs,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (
      help.spawn_error ||
      help.exit_code !== 0 ||
      help.timed_out ||
      help.output_limit_exceeded ||
      !helpText.includes("--message") ||
      !helpText.includes("--role")
    ) {
      return {
        ...blockedProbe(
          this.command,
          this.capabilities,
          "cli_contract_missing",
          "XiaoBaOS does not expose the required ordinary chat --message/--role contract."
        ),
        version: normalizedVersion(version.stdout, version.stderr),
      };
    }

    const validatedTargets: string[] = [];
    for (const role of request.required_targets ?? []) {
      const issue = this.roleIssue(role);
      if (issue) {
        return {
          ...blockedProbe(
            this.command,
            this.capabilities,
            issue.reason,
            issue.detail
          ),
          version: normalizedVersion(version.stdout, version.stderr),
          validated_targets: validatedTargets,
        };
      }
      validatedTargets.push(role);
    }
    return {
      runtime_id: this.id,
      status: "ready",
      detail:
        "XiaoBaOS ordinary chat is ready; Barena preserves multi-turn state through explicit full-history replay.",
      command: this.command,
      version: normalizedVersion(version.stdout, version.stderr),
      capabilities: this.capabilities,
      validated_targets: validatedTargets,
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
      throw new RuntimeAdapterError(
        "config_invalid",
        `Runtime session already exists: ${request.session_id}`
      );
    }
    const roleIssue = this.roleIssue(request.target.role);
    if (roleIssue) throw new RuntimeAdapterError(roleIssue.reason, roleIssue.detail);

    const workspace = path.resolve(request.workspace);
    ensureDir(workspace);
    const tempRoot = path.join(workspace, ".barena-tmp");
    ensureDir(tempRoot);
    fs.chmodSync(tempRoot, 0o700);

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
      closed: false,
    });
    return publicSession;
  }

  async sendTurn(
    session: AgentRuntimeSession,
    turn: RuntimeTurnInput
  ): Promise<RuntimeTurnResult> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.public_session.thread_id !== session.thread_id) {
      return immediateFailure(
        this.capabilities,
        turn,
        "session_not_found",
        "XiaoBaOS Runtime session does not exist."
      );
    }
    if (state.closed) {
      return immediateFailure(
        this.capabilities,
        turn,
        "session_closed",
        "XiaoBaOS Runtime session is already closed."
      );
    }
    if (!turn.message.trim()) {
      return immediateFailure(
        this.capabilities,
        turn,
        "protocol_error",
        "XiaoBaOS user turn must not be empty."
      );
    }

    const userMessage: RuntimeMessage = { role: "user", content: turn.message };
    const proposedHistory = [...state.messages, userMessage];
    const prompt = formatMessagesAsPrompt(proposedHistory);
    const target = state.public_session.target;
    const args = [
      ...this.baseArgs,
      "chat",
      "--role",
      target.role,
      "--message",
      prompt,
      ...(target.skill ? ["--skill", target.skill] : []),
    ];
    assertNoArenaArgs(args);

    const envNames = [
      ...new Set([...this.envAllowlist, ...(target.env_allowlist ?? [])]),
    ];
    const secrets = [
      ...this.projectSecrets,
      ...envNames
        .map((name) => process.env[name])
        .filter((value): value is string => Boolean(value)),
    ];
    const result = await this.supervisor.run({
      key: state.public_session.thread_id,
      command: this.command,
      args,
      cwd: state.public_session.workspace,
      env: this.buildEnv(envNames, turn.telemetry, {
        "barena.run.id": state.request.run_id,
        "barena.scenario.id": state.request.scenario_id,
        "barena.attempt.id": state.request.attempt_id,
        "barena.session.id": state.public_session.session_id,
        "barena.mode": "explore",
        "barena.runtime.name": this.id,
        "barena.target.role": target.role,
      }),
      timeout_ms: turn.timeout_ms,
      max_output_bytes: this.maxOutputBytes,
      kill_grace_ms: this.killGraceMs,
    });

    const redactedResult: SupervisedProcessResult = {
      ...result,
      stdout: redactText(stripAnsi(result.stdout), secrets),
      stderr: redactText(stripAnsi(result.stderr), secrets),
    };
    const structuralFailure = processFailure(
      redactedResult,
      this.capabilities,
      turn.telemetry,
      "XiaoBaOS"
    );
    const reportedFailure = xiaobaReportedFailure(
      redactedResult.stdout,
      redactedResult.stderr
    );
    if (
      reportedFailure &&
      !result.spawn_error &&
      !result.busy &&
      !result.cancelled &&
      !result.timed_out &&
      !result.output_limit_exceeded
    ) {
      return {
        ...reportedFailure,
        process: processOutcome(redactedResult),
        telemetry: telemetrySummary(this.capabilities, turn),
        native_trace_refs: findNativeTraceFiles(state.public_session.workspace),
      };
    }
    if (structuralFailure) {
      return {
        ...structuralFailure,
        native_trace_refs: findNativeTraceFiles(state.public_session.workspace),
      };
    }

    const assistantText = this.parseOutput(redactedResult.stdout);
    if (!assistantText.trim()) {
      return {
        status: "blocked",
        reason_code: "protocol_error",
        detail: "XiaoBaOS completed without a machine-observable assistant response.",
        process: processOutcome(redactedResult),
        telemetry: telemetrySummary(this.capabilities, turn),
        native_trace_refs: findNativeTraceFiles(state.public_session.workspace),
      };
    }

    const assistant: RuntimeMessage = { role: "assistant", content: assistantText };
    state.messages.push(userMessage, assistant);
    return {
      status: "completed",
      detail: "XiaoBaOS completed the turn using explicit full-history replay.",
      assistant,
      process: processOutcome(redactedResult),
      telemetry: telemetrySummary(this.capabilities, turn),
      native_trace_refs: findNativeTraceFiles(state.public_session.workspace),
    };
  }

  async cancel(session: AgentRuntimeSession, _reason: string): Promise<boolean> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.closed) return false;
    return this.supervisor.cancel(state.public_session.thread_id);
  }

  async close(session: AgentRuntimeSession): Promise<void> {
    const state = this.sessions.get(session.session_id);
    if (!state || state.closed) return;
    state.closed = true;
    await this.supervisor.close(state.public_session.thread_id);
  }

  private configuredLayoutIssue(): string | undefined {
    if (this.projectRoot && !isDirectory(this.projectRoot)) {
      return `Configured XiaoBaOS project root is not a directory: ${this.projectRoot}`;
    }
    if (!this.rolesRoot) {
      return "XiaoBaOS roles root could not be resolved from configuration or the installed CLI.";
    }
    if (!isDirectory(this.rolesRoot)) {
      return `Configured XiaoBaOS roles root is not a directory: ${this.rolesRoot}`;
    }
    if (this.skillsRoot && !isDirectory(this.skillsRoot)) {
      return `Configured XiaoBaOS skills root is not a directory: ${this.skillsRoot}`;
    }
    return undefined;
  }

  private roleIssue(
    role: string
  ): { reason: "config_invalid" | "role_not_found" | "role_blocked"; detail: string } | undefined {
    if (!isSafeId(role)) {
      return { reason: "config_invalid", detail: "XiaoBaOS Role must be a safe identifier." };
    }
    const layoutIssue = this.configuredLayoutIssue();
    if (layoutIssue) return { reason: "config_invalid", detail: layoutIssue };
    const descriptor = resolveXiaobaRole(this.rolesRoot as string, role);
    if (!descriptor) {
      return {
        reason: "role_not_found",
        detail: `Configured XiaoBaOS Role does not exist or is blocked: ${role}`,
      };
    }
    return undefined;
  }

  private buildEnv(
    names: string[],
    telemetry?: RuntimeTurnInput["telemetry"],
    correlation?: Record<string, string>
  ): NodeJS.ProcessEnv {
    return buildRuntimeEnv({
      runtime_id: this.id,
      env_allowlist: names,
      telemetry,
      correlation,
      overrides: {
        ...(this.projectRoot && { XIAOBA_PROJECT_ROOT: this.projectRoot }),
        ...(this.rolesRoot && { XIAOBA_ROLES_ROOT: this.rolesRoot }),
        ...(this.skillsRoot && { XIAOBA_SKILLS_ROOT: this.skillsRoot }),
        ...(xiaobaProjectDotenvPath(this.projectRoot) && {
          DOTENV_CONFIG_PATH: xiaobaProjectDotenvPath(this.projectRoot),
        }),
        NO_COLOR: "1",
        CI: "1",
      },
    });
  }
}

function blockedProbe(
  command: string,
  capabilities: RuntimeCapabilities,
  reasonCode: RuntimeReasonCode,
  detail: string
): RuntimeProbeResult {
  return {
    runtime_id: "xiaobaos",
    status: "blocked",
    reason_code: reasonCode,
    detail,
    command,
    capabilities,
    validated_targets: [],
  };
}

function immediateFailure(
  capabilities: RuntimeCapabilities,
  turn: RuntimeTurnInput,
  reasonCode: RuntimeReasonCode,
  detail: string
): RuntimeTurnResult {
  return {
    status: "blocked",
    reason_code: reasonCode,
    detail,
    process: {
      exit_code: null,
      signal: null,
      duration_ms: 0,
      stdout: "",
      stderr: "",
    },
    telemetry: telemetrySummary(capabilities, turn),
    native_trace_refs: [],
  };
}

function telemetrySummary(
  capabilities: RuntimeCapabilities,
  turn: RuntimeTurnInput
): RuntimeTurnResult["telemetry"] {
  return {
    mode: capabilities.telemetry,
    configured: Boolean(turn.telemetry),
    trace_context_propagated: Boolean(
      turn.telemetry?.traceparent && capabilities.trace_context_propagation
    ),
  };
}

function xiaobaReportedFailure(
  stdout: string,
  stderr: string
):
  | Pick<RuntimeTurnResult, "status" | "reason_code" | "detail">
  | undefined {
  const output = `${stdout}\n${stderr}`;
  if (/PROVIDER_AUTH_ERROR|模型服务鉴权失败|API Key、模型权限/i.test(output)) {
    return {
      status: "blocked",
      reason_code: "credential_missing",
      detail: "XiaoBaOS reported a provider authentication failure.",
    };
  }
  if (/BARENA_UNSAFE|TARGET_REPORTED_UNSAFE/i.test(output)) {
    return {
      status: "unsafe",
      reason_code: "runtime_reported_unsafe",
      detail: "XiaoBaOS reported unsafe target behavior.",
    };
  }
  const providerCode = output.match(
    /\b(MODEL_RATE_LIMIT|PROVIDER_TIMEOUT|PROVIDER_NETWORK_ERROR|PROVIDER_UPSTREAM_ERROR|PROVIDER_ERROR)\b/i
  )?.[1];
  if (providerCode || /\[?处理失败:/i.test(output)) {
    return {
      status: /retry_budget_exhausted=true/i.test(output) ? "blocked" : "failed",
      reason_code: "runtime_reported_error",
      detail: providerCode
        ? `XiaoBaOS reported ${providerCode.toUpperCase()}.`
        : "XiaoBaOS reported an unsuccessful Agent turn.",
    };
  }
  return undefined;
}

function defaultXiaobaOutput(stdout: string): string {
  const plain = stripAnsi(stdout).replace(/\r/g, "");
  const lines = plain.split("\n");
  const marker = lines.findIndex((line) =>
    line.includes("Your AI Assistant !!! Meow Meow")
  );
  return (marker >= 0 ? lines.slice(marker + 1) : lines)
    .join("\n")
    .replace(/^\s+/, "")
    .trim();
}

function findNativeTraceFiles(root: string): string[] {
  const refs: string[] = [];
  if (!fs.existsSync(root)) return refs;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name === "traces.jsonl") refs.push(fullPath);
    }
  };
  walk(root);
  return refs.sort();
}

function assertNoArenaArgs(args: string[]): void {
  if (args.some((arg) => arg.trim().toLowerCase() === "arena")) {
    throw new Error("XiaoBaOS Runtime adapter may not invoke XiaoBaOS Arena.");
  }
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
