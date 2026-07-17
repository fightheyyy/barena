import { AgentE2EReasonCode, AgentE2EScorecard } from "../e2e/types";

export type CasePurpose = "effectiveness" | "regression" | "safety";

export type SkillSelection =
  | { mode: "none" }
  | {
      mode: "path";
      name: string;
      source_path: string;
      fingerprint: string;
    };

export interface SkillEvaluationCase {
  case_path: string;
  purpose: CasePurpose;
}

export interface SkillEvaluationRequestV1 {
  schema: "barena.skill_evaluation_request.v1";
  evaluation_id: string;
  created_at: string;
  target: "openclaw";
  evaluator_runtime: "xiaoba-cli";
  baseline: SkillSelection;
  candidate: Extract<SkillSelection, { mode: "path" }>;
  cases: SkillEvaluationCase[];
  attempts_per_arm: number;
}

export interface EvaluationRunRef {
  arm: "baseline" | "candidate";
  case_id: string;
  purpose: CasePurpose;
  run_id: string;
  scorecard_ref: string;
  scorecard: AgentE2EScorecard;
}

export interface AttemptCounts {
  planned: number;
  pass: number;
  fail: number;
  blocked: number;
  unsafe: number;
}

export interface ObservedRate {
  numerator: number;
  denominator: number;
  value: number | null;
}

export type ArmStability =
  | "stable_pass"
  | "stable_failure"
  | "flaky"
  | "blocked"
  | "unsafe"
  | "incomplete";

export interface SkillEvaluationArmResult {
  selection: SkillSelection;
  counts: AttemptCounts;
  pass_rate: ObservedRate;
  stability: ArmStability;
  evidence_complete: boolean;
  run_refs: EvaluationRunRef[];
}

export type SkillEvaluationReasonCode =
  | "unsafe_candidate"
  | "skill_regression"
  | "runtime_blocked"
  | "evidence_incomplete"
  | "unstable_result"
  | "no_effect"
  | "positive_lift"
  | AgentE2EReasonCode;

export interface SkillEvaluationResultV1 {
  schema: "barena.skill_evaluation.v1";
  evaluation_id: string;
  created_at: string;
  request_ref: string;
  decision: "cleared" | "held" | "rejected";
  reason_code: SkillEvaluationReasonCode;
  summary: string;
  outcome_truth: {
    status: "verified" | "partially_verified" | "unverified";
    verifier_backed_attempts: number;
    total_observed_attempts: number;
  };
  effectiveness: {
    status: "improved" | "no_effect" | "regressed" | "unavailable";
    baseline_pass_rate: ObservedRate;
    candidate_pass_rate: ObservedRate;
    observed_lift: number | null;
  };
  quality: {
    baseline: ArmStability;
    candidate: ArmStability;
    required_evidence_complete: boolean;
    target_native_trace_available: boolean;
  };
  baseline: SkillEvaluationArmResult;
  candidate: SkillEvaluationArmResult;
  evidence_refs: string[];
  debug_refs: string[];
}

export interface SkillEvaluationAggregateInput {
  request: SkillEvaluationRequestV1;
  requestRef: string;
  baselineRuns: EvaluationRunRef[];
  candidateRuns: EvaluationRunRef[];
  debugRefs?: string[];
}
