export type RuntimeMessageRole = "system" | "user" | "assistant" | "tool";

export interface RuntimeMessage {
  role: RuntimeMessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export type RuntimeTurnStatus = "completed" | "failed" | "blocked" | "cancelled" | "unsafe";

export type RuntimeReasonCode =
  | "binary_not_found"
  | "binary_not_executable"
  | "cli_contract_missing"
  | "role_not_found"
  | "role_blocked"
  | "credential_missing"
  | "config_invalid"
  | "spawn_error"
  | "session_not_found"
  | "session_closed"
  | "session_busy"
  | "turn_timeout"
  | "turn_cancelled"
  | "output_limit_exceeded"
  | "protocol_error"
  | "process_failed"
  | "runtime_reported_error"
  | "runtime_reported_unsafe";

export type RuntimeSessionMode = "native-resume" | "session-key" | "full-history-replay" | "none";
export type RuntimeOutputProtocol = "jsonl" | "json" | "text";
export type RuntimeTelemetryMode = "native" | "bridge" | "none";

export interface RuntimeCapabilities {
  session_mode: RuntimeSessionMode;
  output_protocol: RuntimeOutputProtocol;
  cancellation: boolean;
  telemetry: RuntimeTelemetryMode;
  trace_context_propagation: boolean;
  target_enumeration: boolean;
}

export interface RuntimeProbeRequest {
  required_targets?: string[];
}

export interface RuntimeProbeResult {
  runtime_id: string;
  status: "ready" | "blocked";
  reason_code?: RuntimeReasonCode;
  detail: string;
  command: string;
  version?: string;
  capabilities: RuntimeCapabilities;
  validated_targets: string[];
}

export interface RuntimeTelemetryConfig {
  traces_endpoint: string;
  headers?: Record<string, string>;
  protocol?: "http/protobuf" | "http/json";
  service_name?: string;
  resource_attributes?: Record<string, string>;
  traceparent?: string;
  tracestate?: string;
  export_timeout_ms?: number;
}

export interface RuntimeTargetConfig {
  role: string;
  model?: string;
  skill?: string;
  env_allowlist?: string[];
}

export interface OpenRuntimeSessionRequest {
  run_id: string;
  scenario_id: string;
  attempt_id: string;
  session_id: string;
  thread_id: string;
  workspace: string;
  target: RuntimeTargetConfig;
}

export interface AgentRuntimeSession {
  runtime_id: string;
  session_id: string;
  thread_id: string;
  workspace: string;
  target: RuntimeTargetConfig;
  session_mode: RuntimeSessionMode;
  opened_at: string;
}

export interface RuntimeTurnInput {
  message: string;
  timeout_ms: number;
  telemetry?: RuntimeTelemetryConfig;
}

export interface RuntimeProcessOutcome {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeTurnResult {
  status: RuntimeTurnStatus;
  reason_code?: RuntimeReasonCode;
  detail: string;
  assistant?: RuntimeMessage;
  process: RuntimeProcessOutcome;
  telemetry: {
    mode: RuntimeTelemetryMode;
    configured: boolean;
    trace_context_propagated: boolean;
  };
  native_trace_refs: string[];
}

export interface AgentRuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  probe(request?: RuntimeProbeRequest): Promise<RuntimeProbeResult>;
  openSession(request: OpenRuntimeSessionRequest): Promise<AgentRuntimeSession>;
  sendTurn(session: AgentRuntimeSession, turn: RuntimeTurnInput): Promise<RuntimeTurnResult>;
  cancel(session: AgentRuntimeSession, reason: string): Promise<boolean>;
  close(session: AgentRuntimeSession): Promise<void>;
}

export interface CliRuntimeAdapterConfig {
  command?: string;
  base_args?: string[];
  project_root?: string;
  roles_root?: string;
  skills_root?: string;
  env_allowlist?: string[];
  env_overrides?: Record<string, string>;
  probe_timeout_ms?: number;
  max_output_bytes?: number;
  kill_grace_ms?: number;
}

export class RuntimeAdapterError extends Error {
  constructor(
    readonly reason_code: RuntimeReasonCode,
    message: string
  ) {
    super(message);
    this.name = "RuntimeAdapterError";
  }
}
