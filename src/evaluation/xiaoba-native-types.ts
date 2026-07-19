import type { ArtifactAssertionResult } from "../e2e/types";
import type { StructuredArtifactAssertion } from "../verifier/artifact-verifier";
import type { StaticAdmissionReasonCode, StaticAdmissionReportV1 } from "./static-admission";

export const XIAOBA_NATIVE_CONTRACT_VERSIONS = ["0.1.1", "0.2.0"] as const;
export type XiaoBaNativeContractVersion = (typeof XIAOBA_NATIVE_CONTRACT_VERSIONS)[number];
export const XIAOBA_NATIVE_CONTRACT_VERSION: XiaoBaNativeContractVersion = "0.2.0";

export function isXiaoBaNativeContractVersion(value: unknown): value is XiaoBaNativeContractVersion {
  return typeof value === "string" && (XIAOBA_NATIVE_CONTRACT_VERSIONS as readonly string[]).includes(value);
}

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
  | "live_policy_required"
  | "live_preflight_only"
  | "live_policy_binding_invalid"
  | "live_hard_limit_unverified"
  | "live_pricing_stale"
  | "live_hard_limit_stale"
  | "live_worst_case_understated"
  | "live_budget_exceeded"
  | "live_provider_call_limit_insufficient"
  | "live_smoke_configuration_invalid"
  | "live_runtime_contract_unsupported"
  | "live_retry_control_unverified"
  | "live_provider_call_telemetry_unverified"
  | "provider_call_record_invalid"
  | "provider_identity_mismatch"
  | "provider_identity_unverified"
  | "baseline_usage_incomplete"
  | "candidate_usage_incomplete"
  | "usage_limit_exceeded"
  | "redaction_failed"
  | "retained_secret_detected"
  | "scratch_cleanup_failed"
  | "insufficient_live_replays"
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
  | "artifact_assertion_failed"
  | StaticAdmissionReasonCode;

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

export type XiaoBaNativeArtifactAssertion = StructuredArtifactAssertion;

export interface XiaoBaCaseSourceProvenance {
  kind: "skillsbench";
  repository: string;
  revision: string;
  license: string;
  task_id: string;
  task_path: string;
  task_sha256: string;
  derived: true;
  official_harness_compatible: false;
  adaptation: {
    prompt: "verbatim" | "adapted";
    environment: "fixture_subset";
    verifier: "barena_structured_v1";
    notes: string[];
  };
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
  source?: XiaoBaCaseSourceProvenance;
}

export interface XiaoBaCasePackReference {
  schema: "barena.xiaoba_case_pack_ref.v1";
  pack_id: string;
  manifest_path: string;
  fingerprint: string;
  source: {
    kind: "skillsbench";
    repository: string;
    revision: string;
    license: string;
  };
  task_ids: string[];
}

export interface XiaoBaNativeRuntimeConfig {
  binary_path: string;
  project_root: string;
  expected_version: XiaoBaNativeContractVersion;
  /** Names only. Values are taken from the injected/process environment and never persisted. */
  pass_env: string[];
  surface?: string;
  sandbox_engine?: "macos_seatbelt" | "linux_bubblewrap" | "windows_native";
}

export type XiaoBaHardLimitMode =
  | "provider_account_limit"
  | "provider_project_limit"
  | "api_key_limit"
  | "metering_proxy"
  | "prepaid_balance";

export interface XiaoBaLivePolicyV1 {
  schema: "barena.live_policy.v1";
  provider: string;
  model: string;
  credential_env: string;
  api_base_env: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_provider_calls: number;
  pricing: {
    provider: string;
    model: string;
    api_base_env: string;
    currency: "USD";
    input_usd_per_million_tokens: number;
    output_usd_per_million_tokens: number;
    source: string;
    sourced_at: string;
  };
  budget_usd: number;
  worst_case_usd: number;
  hard_limit: {
    mode: XiaoBaHardLimitMode;
    verified: boolean;
    reference: string;
    verified_at: string;
    provider: string;
    credential_env: string;
    api_base_env: string;
    currency: "USD";
    cap_usd: number;
  };
  accepted_scan_finding_ids: string[];
  retention: { profile: string };
  redaction: {
    profile: string;
    secret_env_names: string[];
    structured_field_names?: string[];
  };
}

export interface XiaoBaLivePolicyBinding {
  schema: "barena.loaded_live_policy.v1";
  policy: XiaoBaLivePolicyV1;
  policy_ref: string;
  source_text: string;
  source_sha256: string;
  canonical_sha256: string;
}

export interface XiaoBaLiveRuntimeContractV1 {
  schema: "barena.xiaoba_live_runtime_contract.v1";
  xiaoba_version: XiaoBaNativeContractVersion;
  composite_call_contract: "barena.xiaoba_composite_calls.v1";
  provider_call_record_schema: "barena.provider_call.v1";
  bounds: {
    target_calls_per_turn: 1;
    usercat_calls_per_turn: 1;
    inspector_calls_per_attempt: 0;
    reviewer_calls_per_attempt: 0;
    replay_calls_per_case_turn: 1;
  };
  enforcement: {
    input_token_limit: true;
    output_token_limit: true;
    sdk_max_retries: 0;
    authoritative_per_call_telemetry: true;
    complete_provider_identity: true;
    complete_cost_basis: true;
  };
}

export type XiaoBaProviderCallComponent =
  | "target"
  | "usercat"
  | "inspector"
  | "reviewer"
  | "replay";

export interface XiaoBaProviderCallRecord {
  schema: "barena.provider_call.v1";
  call_id: string;
  arm: XiaoBaNativeArm;
  case_id: string;
  attempt: number;
  component: XiaoBaProviderCallComponent;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  requested_output_limit: number;
  configured_max_retries: number;
  observed_retries: number;
  estimated_cost_usd: number;
  billed_cost_usd: number | null;
  evidence_ref: string;
}

export interface XiaoBaProviderIdentityEvidence {
  provider: string;
  model: string;
  source: "live_policy" | "trace" | "live_policy_and_trace";
  status: "configured" | "verified" | "unverified" | "mismatch";
  observed_providers?: string[];
  observed_models?: string[];
  evidence_refs: string[];
}

export interface XiaoBaBudgetEvidence {
  budget_usd: number;
  declared_worst_case_usd: number;
  calculated_worst_case_usd: number;
  max_input_tokens_per_call: number;
  max_output_tokens_per_call: number;
  max_provider_calls: number;
  planned_barena_attempts: number;
  planned_provider_calls: number;
  planned_calls_by_component: Record<XiaoBaProviderCallComponent, number>;
  pricing: XiaoBaLivePolicyV1["pricing"];
  hard_limit: XiaoBaLivePolicyV1["hard_limit"];
  enforcement: {
    hard_limit_verified: boolean;
    retry_control_status: "verified" | "unverified";
    no_automatic_paid_retry: boolean;
    provider_call_telemetry_status: "verified" | "unverified";
    per_call_input_limit_verified: boolean;
    per_call_output_limit_env: "XIAOBA_LLM_MAX_TOKENS";
    local_estimate_is_not_hard_limit: true;
  };
}

export interface XiaoBaLivePolicyPreflight {
  schema: "barena.xiaoba_live_preflight.v1";
  status: "ready" | "held";
  ready_to_invoke: boolean;
  model_invoked: false;
  reason_code?: XiaoBaNativeReasonCode;
  summary: string;
  policy_ref?: string;
  source_policy_ref?: string;
  policy_sha256?: string;
  source_policy_sha256?: string;
  canonical_policy_sha256?: string;
  retained_policy_sha256?: string;
  runtime_contract: {
    status: "verified" | "unsupported";
    contract?: XiaoBaLiveRuntimeContractV1;
    evidence_refs: string[];
  };
  provider_identity: XiaoBaProviderIdentityEvidence;
  credentials: {
    credential_env: string;
    credential_present: boolean;
    api_base_env: string;
    api_base_present: boolean;
  };
  budget: XiaoBaBudgetEvidence;
  retention: XiaoBaLivePolicyV1["retention"];
  redaction: {
    profile: string;
    secret_env_names: string[];
    structured_field_names: string[];
    manifest_ref?: string;
  };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface XiaoBaObservedUsage {
  status: "complete" | "incomplete" | "not_observed";
  provider_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  billed_cost_usd: number | null;
  cost_basis: "estimated" | "billed" | "unavailable";
  call_records: XiaoBaProviderCallRecord[];
  evidence_refs: string[];
  missing_fields: string[];
}

export interface XiaoBaAttemptRedaction {
  status: "verified" | "failed" | "not_run";
  profile: string;
  manifest_ref?: string;
  replacement_count: number;
  structured_redaction_count: number;
  retained_secret_scan: "pass" | "fail" | "not_run";
  scratch_cleanup: "verified" | "failed" | "not_run";
  secret_hits: string[];
}

export interface XiaoBaAggregateUsage extends XiaoBaObservedUsage {
  /** Backward-compatible aliases for Barena attempt counts. */
  planned_attempts: number;
  observed_attempts: number;
  planned_barena_attempts: number;
  observed_barena_attempts: number;
  baseline_complete: boolean;
  candidate_complete: boolean;
  within_provider_call_limit: boolean;
  within_budget: boolean;
}

export interface XiaoBaRedactionSummary {
  status: "verified" | "failed" | "not_run";
  profile: string;
  manifest_refs: string[];
  replacement_count: number;
  structured_redaction_count: number;
  retained_secret_scan: "pass" | "fail" | "not_run";
  scratch_cleanup: "verified" | "failed" | "not_run";
  secret_hits: string[];
}

interface XiaoBaCapabilityEvaluationRequestBase {
  schema: "barena.xiaoba_capability_evaluation_request.v1";
  evaluation_id: string;
  created_at: string;
  target_runtime: "xiaoba";
  evaluator_runtime: "xiaoba-cli";
  xiaoba: XiaoBaNativeRuntimeConfig;
  cases: XiaoBaNativeCaseV1[];
  case_pack?: XiaoBaCasePackReference;
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
  expected_version: XiaoBaNativeContractVersion;
  live_runtime_contract?: XiaoBaLiveRuntimeContractV1;
  live_runtime_contract_ref?: string;
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
  scratch_root_factory?: (prefix: string) => string;
  scratch_cleanup?: (scratchRoot: string) => void;
}

export interface RunXiaoBaNativeEvaluationInput {
  request: XiaoBaCapabilityEvaluationRequestV1;
  runs_root?: string;
  accepted_scan_finding_ids?: string[];
  live_policy_binding?: XiaoBaLivePolicyBinding;
  preflight_only?: boolean;
}

export interface XiaoBaEvidenceCopy {
  layer: "boundary" | "native" | "evaluator" | "verifier" | "debug";
  component: string;
  source_ref: string;
  copied_ref: string;
  kind: "file" | "directory";
  /** Backward-compatible alias for sanitized_sha256. */
  sha256: string;
  source_sha256?: string;
  sanitized_sha256?: string;
  replacement_count?: number;
  structured_redaction_count?: number;
  sanitization_status?: "sanitized" | "copied" | "failed";
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
  provider_identity?: XiaoBaProviderIdentityEvidence;
  usage?: XiaoBaObservedUsage;
  redaction?: XiaoBaAttemptRedaction;
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
  package_manifest_ref?: string;
  case_pack?: XiaoBaCasePackReference;
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
  admission?: StaticAdmissionReportV1;
  live?: {
    enabled: true;
    preflight_only: boolean;
    ready_to_invoke: boolean;
    model_invoked: boolean | null;
    no_automatic_paid_retry: boolean;
    retry_control_status: "verified" | "unverified";
    runtime_contract_status: "verified" | "unsupported";
    policy_ref?: string;
    source_policy_ref?: string;
    source_policy_sha256?: string;
    canonical_policy_sha256?: string;
    retained_policy_sha256?: string;
    preflight_ref?: string;
  };
  provider_identity?: XiaoBaProviderIdentityEvidence;
  budget?: XiaoBaBudgetEvidence & {
    observed_estimated_cost_usd: number | null;
    remaining_budget_usd: number | null;
  };
  usage?: XiaoBaAggregateUsage;
  redaction?: XiaoBaRedactionSummary;
  evidence_refs: string[];
  debug_refs: string[];
}
