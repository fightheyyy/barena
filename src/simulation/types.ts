import type {
  AgentRuntimeAdapter,
  RuntimeMessage,
  RuntimeProcessOutcome,
  RuntimeProbeResult,
  RuntimeSessionMode,
  RuntimeTelemetryConfig,
} from "../runtime-adapters";

export interface AgentSimulationCaseV1 {
  schema: "barena.agent_simulation_case.v1";
  case_id: string;
  source: {
    project: string;
    url: string;
    commit: string;
    license: string;
  };
  target: {
    adapter: "xiaobaos" | "claude-code" | "codex" | "openclaw";
    role?: string;
    skill?: string;
    model?: string;
    env_allowlist?: string[];
  };
  turns: Array<{ user: string }>;
  assertions: {
    final_response: {
      contains_all?: string[];
      contains_any?: string[];
      excludes?: string[];
      case_sensitive?: boolean;
    };
  };
  timeout_ms: number;
  isolation: {
    level: "policy_only";
    network: "disabled" | "allowlisted" | "unrestricted";
    writable_roots: ["workspace"];
  };
}

export interface AgentSimulationAssertionResult {
  kind: "contains_all" | "contains_any" | "excludes";
  status: "pass" | "fail";
  expected: string[];
  detail: string;
}

export interface AgentSimulationTurnResult {
  turn: number;
  user: string;
  assistant: RuntimeMessage[];
  status: "completed" | "failed" | "blocked" | "cancelled" | "unsafe";
  reason_code?: string;
  detail: string;
  process: Omit<RuntimeProcessOutcome, "stdout" | "stderr">;
}

export interface AgentSimulationTurnWindow {
  turn: number;
  startedAt: Date;
  endedAt: Date;
}

export interface SimulationObservationReceipt {
  status: "sent" | "failed";
  trace_id: string;
  span_count: number;
  detail: string;
}

export interface AgentSimulationResultV1 {
  schema: "barena.agent_simulation_result.v1";
  run_id: string;
  case_id: string;
  created_at: string;
  status: "pass" | "fail" | "blocked";
  reason_code?: string;
  summary: string;
  source: AgentSimulationCaseV1["source"];
  target: {
    adapter: AgentSimulationCaseV1["target"]["adapter"];
    requested_model?: string;
    probe: RuntimeProbeResult;
    session_mode: RuntimeSessionMode;
  };
  turns: AgentSimulationTurnResult[];
  assertions: AgentSimulationAssertionResult[];
  evidence: {
    boundary_trace: string;
    native_trace_collected: boolean;
    telemetry_configured: boolean;
    catena_observation?: SimulationObservationReceipt;
  };
  workspace: string;
}

export interface AgentSimulationRunOptions {
  runsRoot?: string;
  adapter: AgentRuntimeAdapter;
  telemetry?: RuntimeTelemetryConfig;
  now?: () => Date;
}
