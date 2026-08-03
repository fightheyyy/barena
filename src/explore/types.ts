import type {
  AgentRuntimeAdapter,
  OtlpForwardOptions,
  RuntimeProbeResult,
  RuntimeTurnResult,
  XiaobaOSRuntimeAdapterConfig,
} from "../runtime-adapters";

export interface ExploreScenarioV1 {
  schema: "barena.explore_scenario.v1";
  scenario_id: string;
  target: {
    runtime: "xiaobaos";
    role: string;
    model?: string;
    skill?: string;
    env_allowlist?: string[];
  };
  objective: string;
  user?: {
    persona?: string;
    constraints?: string[];
  };
  success_criteria?: string[];
  max_turns: number;
  timeout_ms: number;
  isolation: {
    level: "policy_only";
    network: "disabled" | "allowlisted" | "unrestricted";
    writable_roots: ["workspace"];
  };
  evaluator?: {
    user_role?: string;
    inspector_role?: string;
    reviewer_role?: string;
  };
}

export interface ExploreTranscriptMessage {
  turn: number;
  role: "user" | "assistant";
  actor: "user_simulator" | "target";
  content: string;
  timestamp: string;
}

export interface UserSimulatorDecision {
  action: "send" | "stop";
  message?: string;
  reason: string;
}

export interface InspectorIssue {
  issue_id: string;
  severity: "info" | "warning" | "blocking" | "unsafe";
  family: string;
  summary: string;
  evidence: string[];
  replay_prompt?: string;
}

export interface InspectorOutput {
  summary: string;
  evidence_complete: boolean;
  issues: InspectorIssue[];
}

export interface ReviewerCriterionResult {
  criterion: string;
  status: "pass" | "fail" | "unknown";
  evidence: string[];
}

export interface ReviewerOutput {
  verdict: "pass" | "fail" | "blocked" | "unsafe";
  summary: string;
  criteria: ReviewerCriterionResult[];
  scores: {
    task_success: number;
    safety: number;
    evidence_quality: number;
  };
}

export type ExploreProgressActor =
  | "barena"
  | "user_simulator"
  | "target"
  | "inspector"
  | "reviewer";

export type ExploreProgressStage =
  | "probe"
  | "user_simulator"
  | "target"
  | "inspector"
  | "reviewer"
  | "evidence"
  | "complete";

export interface ExploreProgressEvent {
  schema: "barena.explore_progress.v1";
  sequence: number;
  timestamp: string;
  actor: ExploreProgressActor;
  stage: ExploreProgressStage;
  status: "started" | "completed" | "blocked" | "skipped";
  turn?: number;
  message?: string;
  reason?: string;
  summary?: string;
  verdict?: ReviewerOutput["verdict"];
  issue_count?: number;
  evidence?: {
    otlp_envelopes?: number;
    otlp_spans?: number;
    workspace_changes?: number;
  };
}

export interface ExploreTurnResult {
  turn: number;
  user_simulator: {
    decision: UserSimulatorDecision;
    raw_ref: string;
    process: RuntimeProcessSummary;
  };
  target?: {
    response: string;
    process: RuntimeProcessSummary;
    native_trace_refs: string[];
  };
}

export interface RuntimeProcessSummary {
  status: RuntimeTurnResult["status"];
  reason_code?: string;
  detail: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
}

export type ExploreStageResult<T> =
  | {
      status: "completed";
      output: T;
      raw_ref: string;
      process: RuntimeProcessSummary;
    }
  | {
      status: "blocked";
      detail: string;
      reason_code?: string;
      raw_ref?: string;
      process?: RuntimeProcessSummary;
    }
  | {
      status: "not_run";
      detail: string;
    };

export interface ExploreWorkspaceChange {
  path: string;
  change: "created" | "modified" | "deleted";
  size_before?: number;
  size_after?: number;
  sha256_before?: string;
  sha256_after?: string;
}

export interface ReplayCaseCandidateV1 {
  schema: "barena.replay_case_candidate.v1";
  candidate_id: string;
  status: "proposed";
  source: {
    explore_run_id: string;
    scenario_id: string;
    issue_id: string;
  };
  target: ExploreScenarioV1["target"];
  prompt: string;
  issue_summary: string;
  evidence: string[];
}

export interface ExploreResultV1 {
  schema: "barena.explore_result.v1";
  run_id: string;
  scenario_id: string;
  created_at: string;
  completed_at: string;
  status: "pass" | "fail" | "blocked" | "unsafe";
  reason_code?: string;
  summary: string;
  scenario: ExploreScenarioV1;
  runtime: {
    probe: RuntimeProbeResult;
    session_mode: string;
    target_role: string;
    evaluator_roles: {
      user_simulator: string;
      inspector: string;
      reviewer: string;
    };
  };
  transcript: ExploreTranscriptMessage[];
  turns: ExploreTurnResult[];
  inspector: ExploreStageResult<InspectorOutput>;
  reviewer: ExploreStageResult<ReviewerOutput>;
  replay_case_candidates: ReplayCaseCandidateV1[];
  evidence: {
    boundary_trace: string;
    otlp_manifest: string;
    otlp_spans: string;
    native_otlp_envelopes: number;
    native_otlp_spans: number;
    native_otlp_required: true;
    root_trace_id: string;
    native_trace_ids: string[];
    primary_native_trace_id?: string;
    otlp_forwarding?: {
      endpoint: string;
      status: "idle" | "pending" | "complete" | "failed";
      attempted_envelopes: number;
      forwarded_envelopes: number;
      failed_envelopes: number;
      last_error?: string;
    };
    workspace_changes: ExploreWorkspaceChange[];
    unsafe_workspace_entries: string[];
    native_trace_refs: string[];
    secret_redaction: {
      files: string[];
      occurrences: number;
      unscanned_files: string[];
    };
    evidence_complete: boolean;
  };
  paths: {
    run_root: string;
    target_workspace: string;
    report_json: string;
    report_markdown: string;
  };
}

export interface ExploreRunOptions {
  runs_root?: string;
  run_id?: string;
  signal?: AbortSignal;
  now?: () => Date;
  runtime_adapter?: AgentRuntimeAdapter;
  root_trace_id?: string;
  otlp_forward?: OtlpForwardOptions;
  xiaoba?: XiaobaOSRuntimeAdapterConfig;
  on_progress?: (
    event: ExploreProgressEvent
  ) => void | Promise<void>;
}
