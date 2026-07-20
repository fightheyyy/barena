export type SubjectType = "skill" | "role" | "role_skill" | "agent";

export type SubjectStatus = "candidate" | "cleared" | "held" | "rejected";

export type ReviewStatus = "pass" | "unstable" | "reopened" | "blocked" | "unsafe";

export type ClearanceDecision = "cleared" | "held" | "rejected";

export type IssueSeverity = "info" | "warning" | "blocking" | "unsafe";

export type StaticScanSeverity = "info" | "warning" | "blocking" | "unsafe";

export interface StaticScanFinding {
  finding_id: string;
  severity: StaticScanSeverity;
  rule_id: string;
  summary: string;
  evidence: string[];
}

export interface StaticScanReport {
  subject_id: string;
  generated_at: string;
  decision: "pass" | "review_required" | "blocked" | "unsafe";
  findings: StaticScanFinding[];
  scanned_files: string[];
}

export interface SubjectManifest {
  subject_id: string;
  type: SubjectType;
  source: {
    kind: "local" | "github" | "snapshot" | "builtin";
    uri: string;
  };
  status: SubjectStatus;
  fingerprint: string;
  imported_at: string;
  paths: {
    source: string;
    subject_root: string;
    scan_report?: string;
  };
  metadata: Record<string, unknown>;
}

export interface RunManifest {
  run_id: string;
  subject_id: string;
  subject_type: SubjectType;
  created_at: string;
  adapter: "xiaoba";
  paths: {
    run_root: string;
    workspace: string;
    traces: string;
    artifacts: string;
    inspector: string;
    reviewer: string;
    scan: string;
    replays: string;
    verifier: string;
    reports: string;
  };
}

export interface UserScenario {
  scenario_id: string;
  prompt: string;
  max_turns: number;
}

export type TraceEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "artifact"
  | "runtime_status";

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  scenario_id: string;
  kind: TraceEventKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface InspectorIssue {
  issue_id: string;
  scenario_id: string;
  family:
    | "missing_artifact"
    | "tool_error"
    | "unsafe_action"
    | "hallucinated_completion"
    | "blocked_runtime"
    | "static_scan"
    | "verifier_failure";
  severity: IssueSeverity;
  summary: string;
  evidence: string[];
  suspected_root_cause?: string;
  replay_intent?: string;
}

export interface ReplayAttempt {
  attempt_id: string;
  status: "pass" | "fail" | "blocked" | "unsafe";
  trace_ref: string;
  artifact_refs: string[];
  issue_count: number;
}

export interface VerifierResult {
  verifier_id: string;
  status: "pass" | "fail" | "blocked";
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface Scorecard {
  scorecard_type: "barena.skill_clearance.v0";
  subject_id: string;
  subject_type: SubjectType;
  run_id: string;
  case_id?: string;
  agent_target?: {
    target_id: string;
    display_name: string;
    category: string;
    ci_focus: string[];
    risk_focus: string[];
  };
  runtime: {
    provider: "barena-deterministic";
    adapter: "xiaoba-compatible";
    xiaoba_invoked: false;
  };
  decision: ClearanceDecision;
  status: ReviewStatus;
  summary: string;
  scan_summary: {
    decision: StaticScanReport["decision"];
    finding_count: number;
    unsafe_count: number;
    blocking_count: number;
  };
  stages: {
    usercat: "completed" | "blocked";
    inspector: "completed" | "blocked";
    reviewer: "completed" | "blocked";
  };
  scores: {
    task_success: number;
    stability: number;
    tool_use_quality: number;
    safety: number;
  };
  issues: InspectorIssue[];
  replay_attempts: {
    planned: number;
    completed: number;
    pass_count: number;
    fail_count: number;
    blocked_count: number;
    trace_refs: string[];
    attempts: ReplayAttempt[];
  };
  verifier_results: VerifierResult[];
  artifact_refs: string[];
  evidence_refs: string[];
  trace_refs: string[];
  replay_refs: string[];
  debug_refs: string[];
}

export interface BarenaCase {
  case_id: string;
  source: {
    kind: "manual" | "trace_derived" | "benchmark_derived";
    uri?: string;
  };
  task: {
    user_seed_path?: string;
    prompt: string;
  };
  workspace_fixture_paths: string[];
  expected_artifacts: string[];
  subject: {
    local_path: string;
  };
  sandbox: {
    network: "disabled" | "allowlisted" | "unrestricted";
    writable_roots: string[];
  };
  labels?: Record<string, unknown>;
  visibility: {
    usercat: string[];
    inspector: string[];
    reviewer: string[];
  };
}
