export type AgentE2ERunStatus = "completed" | "failed" | "blocked" | "unsafe";

export type AgentE2EReasonCode =
  | "binary_not_found"
  | "binary_not_executable"
  | "cli_contract_missing"
  | "config_invalid"
  | "credential_missing"
  | "spawn_error"
  | "target_timeout"
  | "output_limit_exceeded"
  | "target_protocol_error"
  | "target_process_failed"
  | "target_reported_error"
  | "xiaoba_binary_not_found"
  | "xiaoba_cli_error"
  | "xiaoba_external_agent_mode_unavailable"
  | "xiaoba_external_agent_driver_unimplemented"
  | "case_invalid"
  | "artifact_assertion_failed"
  | "skill_manifest_invalid"
  | "skill_stage_failed"
  | "skill_dependency_missing"
  | "skill_not_visible"
  | "baseline_skill_leak"
  | "openclaw_workspace_binding_failed"
  | "skill_eligibility_probe_failed";

export type TargetSkillConfig =
  | { mode: "none" }
  | {
      mode: "path";
      name: string;
      source_path: string;
      fingerprint: string;
    };

export interface AgentE2ECaseV1 {
  schema: "barena.agent_e2e_case.v1";
  case_id: string;
  target: {
    adapter: "openclaw" | "xiaoba";
    agent?: string;
    model?: string;
    thinking?: string;
    env_allowlist?: string[];
  };
  task: {
    prompt: string;
  };
  fixtures?: Array<{
    source: string;
    destination: string;
  }>;
  assertions: {
    artifacts: Array<{
      path: string;
      exists?: boolean;
      contains?: string;
    }>;
  };
  replays?: number;
  timeout_ms?: number;
  isolation: {
    level: "policy_only";
    network: "disabled" | "allowlisted" | "unrestricted";
    writable_roots: ["workspace"];
  };
}

export interface RuntimeProbeResult {
  component: "xiaoba-evaluator" | "xiaoba-native-target" | "openclaw-target";
  status: "ready" | "blocked";
  reason_code?: AgentE2EReasonCode;
  detail: string;
  command: string;
  version?: string;
  capabilities: string[];
}

export type BoundaryObservedFrom =
  | "target_input"
  | "target_stdout"
  | "target_stderr"
  | "target_process"
  | "workspace";

export interface EvidenceProvenance {
  recorded_by: "barena";
  layer: "boundary";
  observed_from: BoundaryObservedFrom;
  component: string;
}

export type BoundaryTraceEventKind = "user" | "assistant" | "artifact" | "runtime_status";

export interface BoundaryTraceEvent {
  timestamp: string;
  run_id: string;
  case_id: string;
  attempt_id: string;
  kind: BoundaryTraceEventKind;
  message: string;
  provenance: EvidenceProvenance;
  data?: Record<string, unknown>;
}

export interface TargetInvocationRequest {
  run_id: string;
  case_id: string;
  attempt_id: string;
  prompt: string;
  workspace: string;
  trace_path: string;
  timeout_ms: number;
  target: AgentE2ECaseV1["target"];
  skill: TargetSkillConfig;
}

export interface TargetInvocationResult {
  status: AgentE2ERunStatus;
  reason_code?: AgentE2EReasonCode;
  detail: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  transport: "embedded";
  payload_texts: string[];
  media_refs: string[];
  provider?: string;
  model?: string;
  session_id?: string;
  native_trace_available: false;
  observation_coverage: BoundaryObservedFrom[];
  trace_path: string;
  events: BoundaryTraceEvent[];
  workspace_changes: WorkspaceChange[];
}

export interface TargetAdapter {
  readonly id: string;
  probe(): Promise<RuntimeProbeResult>;
  execute(request: TargetInvocationRequest): Promise<TargetInvocationResult>;
}

export interface EvaluatorRunRequest {
  case_definition: AgentE2ECaseV1;
  case_base_dir: string;
  run_id: string;
  run_root: string;
  target_adapter: TargetAdapter;
  skill: TargetSkillConfig;
}

export interface EvaluatorRunResult {
  status: "completed" | "blocked" | "unsafe";
  reason_code?: AgentE2EReasonCode;
  detail: string;
  stages: {
    usercat: "completed" | "blocked";
    inspectorcat: "completed" | "blocked";
    reviewercat: "completed" | "blocked";
  };
  attempts: AgentE2EAttempt[];
  evaluator_trace_refs: string[];
}

export interface EvaluatorRuntime {
  readonly id: "xiaoba-cli";
  probe(): Promise<RuntimeProbeResult>;
  runCase(request: EvaluatorRunRequest): Promise<EvaluatorRunResult>;
}

export interface WorkspaceChange {
  path: string;
  change: "created" | "modified" | "deleted";
  sha256_before?: string;
  sha256_after?: string;
}

export interface ArtifactAssertionResult {
  path: string;
  status: "pass" | "fail";
  detail: string;
}

export interface AgentE2EAttempt {
  attempt_id: string;
  status: "pass" | "fail" | "blocked" | "unsafe";
  target: TargetInvocationResult;
  assertions: ArtifactAssertionResult[];
  workspace: string;
  trace_ref: string;
}

export interface AgentE2EScorecard {
  scorecard_type: "barena.agent_e2e.v1";
  run_id: string;
  case_id: string;
  created_at: string;
  decision: "cleared" | "held" | "rejected";
  status: "pass" | "unstable" | "blocked" | "unsafe";
  reason_code?: AgentE2EReasonCode;
  summary: string;
  evaluator: {
    runtime: "xiaoba-cli";
    probe: RuntimeProbeResult;
    stages: {
      usercat: "completed" | "blocked";
      inspectorcat: "completed" | "blocked";
      reviewercat: "completed" | "blocked";
    };
  };
  target: {
    adapter: string;
    probe: RuntimeProbeResult;
    status: AgentE2ERunStatus | "not_started";
  };
  attempts: AgentE2EAttempt[];
  evidence_coverage: {
    boundary_trace: boolean;
    evaluator_traces: boolean;
    target_native_trace: boolean;
    workspace_observation: boolean;
    observations: BoundaryObservedFrom[];
  };
  confidence: "none" | "low" | "medium" | "high";
  evidence_refs: string[];
  debug_refs: string[];
  isolation: "policy_only";
}
