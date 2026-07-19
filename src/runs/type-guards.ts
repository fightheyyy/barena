import type { Scorecard } from "../domain/types";
import type { AgentE2EScorecard } from "../e2e/types";
import type { SkillEvaluationResultV1 } from "../evaluation/types";
import type { XiaoBaCapabilityEvaluationResultV1 } from "../evaluation/xiaoba-native-types";

export type JsonRecord = Record<string, unknown>;
export type ReleaseDecision = "cleared" | "held" | "rejected";

export interface LegacyClearanceRunRecord extends JsonRecord {
  scorecard_type: "barena.skill_clearance.v0";
  run_id: string;
  decision?: ReleaseDecision;
}

export interface AgentE2ERunRecord extends JsonRecord {
  scorecard_type: "barena.agent_e2e.v1";
  run_id: string;
  decision: ReleaseDecision;
  status: string;
  summary: string;
}

export interface SkillEvaluationRunRecord extends JsonRecord {
  schema: "barena.skill_evaluation.v1";
  evaluation_id: string;
  decision: ReleaseDecision;
  reason_code: string;
  summary: string;
}

export interface XiaoBaCapabilityRunRecord extends JsonRecord {
  schema: "barena.xiaoba_capability_evaluation_result.v1";
  evaluation_id: string;
  capability_kind: "skill" | "role";
  decision: ReleaseDecision;
  reason_code: string;
  summary: string;
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReleaseDecision(value: unknown): value is ReleaseDecision {
  return value === "cleared" || value === "held" || value === "rejected";
}

export function resultSchema(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.schema === "string"
    ? value.schema
    : typeof value.scorecard_type === "string"
      ? value.scorecard_type
      : undefined;
}

export function isLegacyClearanceRun(value: unknown): value is LegacyClearanceRunRecord {
  return isRecord(value) &&
    value.scorecard_type === "barena.skill_clearance.v0" &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0;
}

export function isCompleteLegacyClearanceRun(value: unknown): value is Scorecard {
  if (!isLegacyClearanceRun(value)) return false;
  return typeof value.subject_id === "string" &&
    typeof value.subject_type === "string" &&
    isReleaseDecision(value.decision) &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.runtime) &&
    isRecord(value.scan_summary) &&
    isRecord(value.stages) &&
    isRecord(value.scores) &&
    Array.isArray(value.issues) &&
    value.issues.every(isLegacyIssue) &&
    isOptionalAgentTarget(value.agent_target) &&
    isRecord(value.replay_attempts) &&
    Array.isArray(value.verifier_results) &&
    Array.isArray(value.artifact_refs) &&
    Array.isArray(value.evidence_refs) &&
    Array.isArray(value.trace_refs) &&
    Array.isArray(value.replay_refs) &&
    Array.isArray(value.debug_refs);
}

export function isAgentE2ERun(value: unknown): value is AgentE2ERunRecord {
  return isRecord(value) &&
    value.scorecard_type === "barena.agent_e2e.v1" &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0 &&
    isReleaseDecision(value.decision) &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.evaluator) &&
    isRecord(value.target) &&
    Array.isArray(value.attempts);
}

export function isCompleteAgentE2ERun(value: unknown): value is AgentE2EScorecard {
  if (!isAgentE2ERun(value) || !isRecord(value.evaluator) || !isRecord(value.target)) return false;
  const evaluator = value.evaluator;
  const target = value.target;
  return typeof value.case_id === "string" &&
    typeof value.created_at === "string" &&
    isRecord(evaluator.probe) &&
    isRecord(target.probe) &&
    typeof target.adapter === "string" &&
    typeof value.confidence === "string" &&
    typeof value.isolation === "string" &&
    isRecord(value.evidence_coverage) &&
    Array.isArray(value.evidence_refs) &&
    Array.isArray(value.debug_refs);
}

export function isSkillEvaluationRun(value: unknown): value is SkillEvaluationRunRecord {
  return isRecord(value) &&
    value.schema === "barena.skill_evaluation.v1" &&
    typeof value.evaluation_id === "string" &&
    value.evaluation_id.length > 0 &&
    isReleaseDecision(value.decision) &&
    typeof value.reason_code === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.baseline) &&
    isRecord(value.candidate);
}

export function isCompleteSkillEvaluationRun(value: unknown): value is SkillEvaluationResultV1 {
  if (!isSkillEvaluationRun(value) ||
      !isRecord(value.baseline) ||
      !isRecord(value.candidate) ||
      !isRecord(value.outcome_truth) ||
      !isRecord(value.effectiveness) ||
      !isRecord(value.quality)) return false;
  const baseline = value.baseline;
  const candidate = value.candidate;
  const truth = value.outcome_truth;
  const effectiveness = value.effectiveness;
  const quality = value.quality;
  return typeof value.created_at === "string" &&
    typeof value.request_ref === "string" &&
    typeof truth.status === "string" &&
    typeof truth.verifier_backed_attempts === "number" &&
    typeof truth.total_observed_attempts === "number" &&
    typeof effectiveness.status === "string" &&
    isObservedRate(effectiveness.baseline_pass_rate) &&
    isObservedRate(effectiveness.candidate_pass_rate) &&
    isNullableNumber(effectiveness.observed_lift) &&
    typeof quality.baseline === "string" &&
    typeof quality.candidate === "string" &&
    typeof quality.required_evidence_complete === "boolean" &&
    typeof quality.target_native_trace_available === "boolean" &&
    isRecord(baseline.selection) &&
    isRecord(candidate.selection) &&
    Array.isArray(baseline.run_refs) &&
    Array.isArray(candidate.run_refs) &&
    Array.isArray(value.evidence_refs) &&
    Array.isArray(value.debug_refs);
}

export function isXiaoBaCapabilityRun(value: unknown): value is XiaoBaCapabilityRunRecord {
  return isRecord(value) &&
    value.schema === "barena.xiaoba_capability_evaluation_result.v1" &&
    typeof value.evaluation_id === "string" &&
    value.evaluation_id.length > 0 &&
    (value.capability_kind === "skill" || value.capability_kind === "role") &&
    isReleaseDecision(value.decision) &&
    typeof value.reason_code === "string" &&
    typeof value.summary === "string" &&
    isRecord(value.baseline) &&
    isRecord(value.candidate);
}

export function isCompleteXiaoBaCapabilityRun(value: unknown): value is XiaoBaCapabilityEvaluationResultV1 {
  if (!isXiaoBaCapabilityRun(value) ||
      !isRecord(value.baseline) ||
      !isRecord(value.candidate) ||
      !isRecord(value.probe) ||
      !isRecord(value.outcome_truth) ||
      !isRecord(value.effectiveness) ||
      !isRecord(value.quality)) return false;
  const baseline = value.baseline;
  const candidate = value.candidate;
  const truth = value.outcome_truth;
  const effectiveness = value.effectiveness;
  const quality = value.quality;
  return typeof value.created_at === "string" &&
    typeof value.request_ref === "string" &&
    typeof truth.status === "string" &&
    typeof truth.verifier_backed_attempts === "number" &&
    typeof truth.total_planned_attempts === "number" &&
    typeof effectiveness.status === "string" &&
    isObservedRate(effectiveness.baseline_pass_rate) &&
    isObservedRate(effectiveness.candidate_pass_rate) &&
    isNullableNumber(effectiveness.observed_lift) &&
    typeof quality.baseline === "string" &&
    typeof quality.candidate === "string" &&
    typeof quality.required_evidence_complete === "boolean" &&
    isRecord(baseline.selection) &&
    isRecord(candidate.selection) &&
    Array.isArray(baseline.attempts) &&
    Array.isArray(candidate.attempts) &&
    Array.isArray(value.evidence_refs) &&
    Array.isArray(value.debug_refs);
}

function isLegacyIssue(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.severity === "string" &&
    typeof value.family === "string" &&
    typeof value.summary === "string";
}

function isOptionalAgentTarget(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    typeof value.target_id === "string" &&
    typeof value.display_name === "string" &&
    typeof value.category === "string" &&
    Array.isArray(value.ci_focus) &&
    value.ci_focus.every((item) => typeof item === "string") &&
    Array.isArray(value.risk_focus) &&
    value.risk_focus.every((item) => typeof item === "string")
  );
}

function isObservedRate(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.numerator === "number" &&
    typeof value.denominator === "number" &&
    isNullableNumber(value.value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === "number";
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
