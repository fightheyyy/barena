import type { StructuredArtifactAssertion } from "../verifier/artifact-verifier";

export type AgentE2ERunStatus = "completed" | "failed" | "blocked" | "unsafe";

export type AgentE2EReasonCode =
  | "execution_cancelled"
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
  | "target_reported_unsafe"
  | "evidence_incomplete"
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
  | "skill_eligibility_probe_failed"
  | "openclaw_private_beta_not_supported";

export type TargetSkillConfig =
  | { mode: "none"; excluded_name?: string }
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
    adapter: "http" | "openclaw" | "portable" | "xiaoba";
    runtime?: string;
    agent?: string;
    model?: string;
    thinking?: string;
    env_allowlist?: string[];
    http?: {
      url: string;
      method: "POST";
      output_path?:
        | "$.response"
        | "$.message"
        | "$.content"
        | "$.choices[0].message.content";
      timeout_ms: number;
    };
  };
  task: {
    prompt: string;
  };
  fixtures?: Array<{
    source: string;
    destination: string;
  }>;
  assertions: {
    artifacts: StructuredArtifactAssertion[];
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
  component: "http-target" | "xiaoba-evaluator" | "portable-evaluator" | "xiaoba-native-target" | "xiaoba-target" | "openclaw-target" | "portable-target";
  status: "ready" | "blocked" | "not_started";
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
  trace_id?: string;
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
  transport: "embedded" | "http" | "portable_json_driver";
  payload_texts: string[];
  media_refs: string[];
  provider?: string;
  model?: string;
  session_id?: string;
  native_trace_available: boolean;
  native_trace_refs?: string[];
  boundary_trace_refs?: string[];
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
  trace_id: string;
  target_adapter: TargetAdapter;
  skill: TargetSkillConfig;
  signal?: AbortSignal;
}

export interface EvaluatorRunResult {
  status: "completed" | "blocked" | "unsafe";
  reason_code?: AgentE2EReasonCode;
  detail: string;
  stages: {
    usercat: "completed" | "blocked" | "not_applicable";
    inspectorcat: "completed" | "blocked" | "not_applicable";
    reviewercat: "completed" | "blocked" | "not_applicable";
  };
  attempts: AgentE2EAttempt[];
  evaluator_trace_refs: string[];
}

export interface EvaluatorRuntime {
  readonly id: "xiaoba-cli" | "barena-portable";
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
  verifier_ref: string;
}

export interface AgentE2EScorecard {
  scorecard_type: "barena.agent_e2e.v1";
  run_id: string;
  case_id: string;
  created_at: string;
  evaluation_mode: "portable_verifier" | "external_evaluator";
  evidence_profile: "boundary_verified" | "evaluator_traced";
  decision: "cleared" | "held" | "rejected";
  status: "pass" | "unstable" | "blocked" | "unsafe";
  reason_code?: AgentE2EReasonCode;
  summary: string;
  evaluator: {
    runtime: "xiaoba-cli" | "barena-portable";
    probe: RuntimeProbeResult;
    stages: {
      usercat: "completed" | "blocked" | "not_applicable";
      inspectorcat: "completed" | "blocked" | "not_applicable";
      reviewercat: "completed" | "blocked" | "not_applicable";
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
    verifier_evidence: boolean;
    target_native_trace: boolean;
    workspace_observation: boolean;
    observations: BoundaryObservedFrom[];
  };
  confidence: "none" | "low" | "medium" | "high";
  evidence_refs: string[];
  debug_refs: string[];
  isolation: "policy_only";
}

export type AgentE2EProgressPhase =
  | "probe"
  | "attempt"
  | "verifier"
  | "aggregate"
  | "complete";

export type AgentE2EProgressStatus =
  | "started"
  | "completed"
  | "blocked"
  | "unsafe"
  | "cancelled"
  | "failed";

export interface AgentE2EProgressEvent {
  schema: "barena.agent_e2e_progress.v1";
  sequence: number;
  timestamp: string;
  run_id: string;
  phase: AgentE2EProgressPhase;
  status: AgentE2EProgressStatus;
  component?: "evaluator" | "target";
  planned_attempts?: number;
  attempt_index?: number;
  attempt_id?: string;
  attempt_status?: AgentE2EAttempt["status"];
  verifier_passed?: boolean;
  decision?: AgentE2EScorecard["decision"];
  reason_code?: AgentE2EReasonCode;
  summary?: string;
}

export interface PortableTargetProbeV1 {
  schema: "barena.portable_target_probe.v1";
  status: "ready" | "blocked";
  target: { id: string; version?: string };
  detail: string;
  capabilities: string[];
}

export interface PortableTargetRequestV1 {
  schema: "barena.portable_target_request.v1";
  run_id: string;
  case_id: string;
  attempt_id: string;
  session_id: string;
  deadline: string;
  prompt: { path: string; sha256: string };
  workspace: string;
  trace_path: string;
  target: {
    runtime: string;
    agent?: string;
    model?: string;
    thinking?: string;
    env_names: string[];
  };
  skill: TargetSkillConfig;
}

export interface PortableTargetResultV1 {
  schema: "barena.portable_target_result.v1";
  status: AgentE2ERunStatus;
  detail: string;
  session_id?: string;
  payload_texts?: string[];
  media_refs?: string[];
  provider?: string;
  model?: string;
  observed: {
    prompt_sha256: string;
    workspace: string;
    skill: {
      mode: TargetSkillConfig["mode"];
      active_skill_names: string[];
      selected_skill_fingerprint?: string;
    };
  };
}
