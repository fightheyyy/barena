import type { ArtifactAssertionResult } from "../e2e/types";

export const XIAOBA_NATIVE_CONTRACT_VERSION = "0.1.1" as const;

export type XiaoBaNativeMode = "role" | "role_skill";
export type XiaoBaNativeArm = "baseline" | "candidate";
export type XiaoBaNativeDecision = "pass" | "unstable" | "reopened" | "blocked" | "unsafe";
export type XiaoBaNativeAttemptStatus = "pass" | "fail" | "blocked" | "unsafe";
export type XiaoBaNativeStability =
  | "stable_pass"
  | "stable_failure"
  | "flaky"
  | "blocked"
  | "unsafe"
  | "incomplete";

export type XiaoBaNativeReasonCode =
  | "positive_lift"
  | "no_effect"
  | "capability_regression"
  | "unsafe_candidate"
  | "unstable_result"
  | "evidence_incomplete"
  | "xiaoba_binary_not_found"
  | "xiaoba_version_unsupported"
  | "xiaoba_cli_contract_unavailable"
  | "xiaoba_request_invalid"
  | "xiaoba_source_fingerprint_mismatch"
  | "xiaoba_source_copy_failed"
  | "xiaoba_execution_root_invalid"
  | "xiaoba_subject_import_failed"
  | "xiaoba_subject_snapshot_failed"
  | "xiaoba_subject_type_mismatch"
  | "xiaoba_role_skill_inheritance_unsupported"
  | "xiaoba_skill_excluded"
  | "xiaoba_skill_name_collision"
  | "xiaoba_skill_not_auto_invocable"
  | "xiaoba_skill_not_activated"
  | "xiaoba_baseline_skill_leak"
  | "xiaoba_provider_unconfigured"
  | "xiaoba_sandbox_unavailable"
  | "xiaoba_runner_failed"
  | "xiaoba_timeout"
  | "xiaoba_scorecard_missing"
  | "xiaoba_scorecard_invalid"
  | "xiaoba_native_trace_missing"
  | "xiaoba_stage_evidence_missing"
  | "xiaoba_artifact_ref_invalid"
  | "xiaoba_arena_blocked"
  | "xiaoba_arena_unsafe"
  | "xiaoba_arena_unstable"
  | "xiaoba_arena_reopened"
  | "artifact_assertion_failed";

export interface XiaoBaNativeRoleSource {
  role_id: string;
  source_path: string;
  fingerprint: string;
}

export interface XiaoBaNativeSkillSource {
  name: string;
  source_path: string;
  fingerprint: string;
}

export interface XiaoBaNativeRoleSelection {
  mode: "role";
  role: XiaoBaNativeRoleSource;
}

export interface XiaoBaNativeRoleSkillSelection {
  mode: "role_skill";
  role: XiaoBaNativeRoleSource;
  skill: XiaoBaNativeSkillSource;
}

export interface XiaoBaNativeArtifactAssertion {
  path: string;
  exists?: boolean;
  contains?: string;
}

export interface XiaoBaNativeFixture {
  source_path: string;
  destination: string;
}

export interface XiaoBaNativeCaseV1 {
  schema: "barena.xiaoba_native_case.v1";
  case_id: string;
  purpose: "effectiveness" | "regression" | "safety";
  task: { prompt: string };
  fixtures?: XiaoBaNativeFixture[];
  assertions: { artifacts: XiaoBaNativeArtifactAssertion[] };
  scenario?: string;
  max_turns?: number;
  replay_attempts?: number;
  max_replay_cases?: number;
  timeout_ms?: number;
}

export interface XiaoBaNativeRuntimeConfig {
  binary_path: string;
  project_root: string;
  expected_version: typeof XIAOBA_NATIVE_CONTRACT_VERSION;
  /** Names only. Values are taken from the injected/process environment and never persisted. */
  pass_env: string[];
  surface?: string;
  sandbox_engine?: "macos_seatbelt" | "linux_bubblewrap" | "windows_native";
}

interface XiaoBaCapabilityEvaluationRequestBase {
  schema: "barena.xiaoba_capability_evaluation_request.v1";
  evaluation_id: string;
  created_at: string;
  target_runtime: "xiaoba";
  evaluator_runtime: "xiaoba-cli";
  xiaoba: XiaoBaNativeRuntimeConfig;
  cases: XiaoBaNativeCaseV1[];
  attempts_per_arm: number;
}

export interface XiaoBaSkillEvaluationRequestV1 extends XiaoBaCapabilityEvaluationRequestBase {
  capability_kind: "skill";
  baseline: XiaoBaNativeRoleSelection;
  candidate: XiaoBaNativeRoleSkillSelection;
}

export interface XiaoBaRoleEvaluationRequestV1 extends XiaoBaCapabilityEvaluationRequestBase {
  capability_kind: "role";
  baseline: XiaoBaNativeRoleSelection;
  candidate: XiaoBaNativeRoleSelection;
}

export type XiaoBaCapabilityEvaluationRequestV1 =
  | XiaoBaSkillEvaluationRequestV1
  | XiaoBaRoleEvaluationRequestV1;

export interface XiaoBaNativeProbeResult {
  status: "ready" | "blocked";
  reason_code?: XiaoBaNativeReasonCode;
  binary_path: string;
  project_root: string;
  version?: string;
  expected_version: typeof XIAOBA_NATIVE_CONTRACT_VERSION;
  capabilities: {
    modes: ["base_skill", "role_skill", "role"];
    filesystem_artifacts_authoritative: true;
    sandbox_required: true;
    evaluator_stages_are_independent_agent_sessions: false;
    three_evaluator_agent_sessions: false;
    evaluator_target_process_isolated: false;
    network_disabled_is_hard_boundary: false;
  };
  checks: Array<{ command: string[]; exit_code: number | null; ok: boolean; detail: string }>;
  detail: string;
}

export interface XiaoBaCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
  max_output_bytes: number;
}

export interface XiaoBaCommandResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  output_limit_exceeded: boolean;
  error?: string;
}

export interface XiaoBaCommandRunner {
  run(request: XiaoBaCommandRequest): Promise<XiaoBaCommandResult>;
}

export interface XiaoBaNativeRunnerDependencies {
  command_runner?: XiaoBaCommandRunner;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  nonce?: () => string;
}

export interface RunXiaoBaNativeEvaluationInput {
  request: XiaoBaCapabilityEvaluationRequestV1;
  runs_root?: string;
}

export interface XiaoBaEvidenceCopy {
  layer: "boundary" | "native" | "evaluator" | "verifier" | "debug";
  component: string;
  source_ref: string;
  copied_ref: string;
  kind: "file" | "directory";
  sha256: string;
}

export interface XiaoBaNativeAttemptResult {
  arm: XiaoBaNativeArm;
  case_id: string;
  purpose: XiaoBaNativeCaseV1["purpose"];
  attempt: number;
  status: XiaoBaNativeAttemptStatus;
  reason_code?: XiaoBaNativeReasonCode;
  detail: string;
  mode: XiaoBaNativeMode;
  role_id: string;
  role_fingerprint: string;
  skill_name?: string;
  skill_fingerprint?: string;
  xiaoba_run_id: string;
  execution_root: string;
  workspace_root?: string;
  subject_id?: string;
  native_decision?: XiaoBaNativeDecision;
  process: {
    exit_code: number | null;
    signal: NodeJS.Signals | null;
    duration_ms: number;
    timed_out: boolean;
  };
  activation: {
    required: boolean;
    expected_skill?: string;
    observed: boolean;
  };
  assertions: ArtifactAssertionResult[];
  refs: {
    boundary_trace: string;
    request_manifest: string;
    role_manifest?: string;
    subject_manifest?: string;
    clean_runtime?: string;
    arena_runner?: string;
    arena_scorecard?: string;
    arena_run?: string;
    verifier?: string;
    native: string[];
    evaluator: string[];
    debug: string[];
  };
  evidence: XiaoBaEvidenceCopy[];
}

export interface XiaoBaNativeAttemptCounts {
  planned: number;
  pass: number;
  fail: number;
  blocked: number;
  unsafe: number;
}

export interface XiaoBaNativeObservedRate {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface XiaoBaNativeArmResult {
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection;
  counts: XiaoBaNativeAttemptCounts;
  pass_rate: XiaoBaNativeObservedRate;
  stability: XiaoBaNativeStability;
  evidence_complete: boolean;
  attempts: XiaoBaNativeAttemptResult[];
}

export interface XiaoBaCapabilityEvaluationResultV1 {
  schema: "barena.xiaoba_capability_evaluation_result.v1";
  evaluation_id: string;
  created_at: string;
  request_ref: string;
  capability_kind: "skill" | "role";
  decision: "cleared" | "held" | "rejected";
  reason_code: XiaoBaNativeReasonCode;
  summary: string;
  probe: XiaoBaNativeProbeResult;
  outcome_truth: {
    status: "verified" | "partially_verified" | "unverified";
    verifier_backed_attempts: number;
    total_planned_attempts: number;
  };
  effectiveness: {
    status: "improved" | "no_effect" | "regressed" | "unavailable";
    baseline_pass_rate: XiaoBaNativeObservedRate;
    candidate_pass_rate: XiaoBaNativeObservedRate;
    observed_lift: number | null;
  };
  quality: {
    baseline: XiaoBaNativeStability;
    candidate: XiaoBaNativeStability;
    required_evidence_complete: boolean;
    evaluator_stages_are_independent_agent_sessions: false;
    three_evaluator_agent_sessions: false;
    isolation: {
      sandbox_enforced_for_completed_attempts: boolean;
      evaluator_target_process_isolated: false;
      network_disabled_is_hard_boundary: false;
    };
  };
  baseline: XiaoBaNativeArmResult;
  candidate: XiaoBaNativeArmResult;
  evidence_refs: string[];
  debug_refs: string[];
}
