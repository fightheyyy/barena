import type { AgentE2EScorecard } from "../e2e/types";
import type { SkillEvaluationResultV1 } from "../evaluation/types";
import type { XiaoBaCapabilityEvaluationResultV1 } from "../evaluation/xiaoba-native-types";

export function renderAgentE2EReport(scorecard: AgentE2EScorecard): string {
  return [
    `# Barena Agent E2E: ${scorecard.case_id}`,
    "",
    `- Decision: ${scorecard.decision}`,
    `- Status: ${scorecard.status}`,
    `- Reason: ${scorecard.reason_code ?? "none"}`,
    `- Evaluation mode: ${scorecard.evaluation_mode}`,
    `- Evidence profile: ${scorecard.evidence_profile}`,
    `- Evaluator: ${scorecard.evaluator.runtime} (${scorecard.evaluator.probe.status})`,
    `- Target: ${scorecard.target.adapter} (${scorecard.target.probe.status})`,
    `- Confidence: ${scorecard.confidence}`,
    `- Isolation: ${scorecard.isolation}`,
    "",
    scorecard.summary,
    "",
  ].join("\n");
}

export function renderEvaluationReport(result: SkillEvaluationResultV1): string {
  const percent = (value: number | null): string => value === null ? "unavailable" : `${Math.round(value * 100)}%`;
  return [
    `# Barena Skill Evaluation: ${result.candidate.selection.mode === "path" ? result.candidate.selection.name : "candidate"}`,
    "",
    `- Decision: ${result.decision}`,
    `- Reason: ${result.reason_code}`,
    `- Evaluation mode: ${result.evaluation_mode ?? "legacy_external_evaluator"}`,
    `- Evidence profile: ${result.evidence_profile ?? "legacy"}`,
    `- Truth: ${result.outcome_truth.status}`,
    `- Baseline pass rate: ${percent(result.effectiveness.baseline_pass_rate.value)}`,
    `- Candidate pass rate: ${percent(result.effectiveness.candidate_pass_rate.value)}`,
    `- Observed lift: ${percent(result.effectiveness.observed_lift)}`,
    `- Candidate stability: ${result.quality.candidate}`,
    `- Required evidence complete: ${result.quality.required_evidence_complete}`,
    "",
    result.summary,
    "",
  ].join("\n");
}

export function renderXiaoBaCapabilityReport(result: XiaoBaCapabilityEvaluationResultV1): string {
  const percent = (value: number | null): string => value === null ? "unavailable" : `${Math.round(value * 100)}%`;
  const live = result.live ? [
    `- Live preflight ready: ${result.live.ready_to_invoke}`,
    `- Model invoked: ${result.live.model_invoked === null ? "unknown" : result.live.model_invoked}`,
    `- Live runtime contract: ${result.live.runtime_contract_status}`,
    `- Automatic paid retry control: ${result.live.retry_control_status}`,
    `- Provider/model: ${result.provider_identity?.provider ?? "not recorded"} / ${result.provider_identity?.model ?? "not recorded"} (${result.provider_identity?.status ?? "not recorded"})`,
    `- Budget / reserved worst case / hard cap: $${result.budget?.budget_usd ?? "not recorded"} / $${result.budget?.calculated_worst_case_usd ?? "not recorded"} / $${result.budget?.hard_limit.cap_usd ?? "not recorded"}`,
    `- Barena attempts: ${result.usage?.observed_barena_attempts ?? 0} of ${result.usage?.planned_barena_attempts ?? result.budget?.planned_barena_attempts ?? "not recorded"}`,
    `- Provider calls: ${result.usage?.provider_calls ?? "not recorded"} observed / ${result.budget?.planned_provider_calls ?? "not recorded"} reserved / ${result.budget?.max_provider_calls ?? "not recorded"} maximum`,
    `- Known estimated cost: ${result.usage?.estimated_cost_usd === null || result.usage?.estimated_cost_usd === undefined ? "not recorded" : `$${result.usage.estimated_cost_usd}`}`,
    `- Redaction / scratch cleanup: ${result.redaction?.status ?? "not recorded"} / ${result.redaction?.scratch_cleanup ?? "not recorded"}`,
  ] : [];
  const casePack = result.case_pack ? [
    `- Case pack: ${result.case_pack.pack_id}`,
    `- Case source: ${result.case_pack.source.kind} @ ${result.case_pack.source.revision}`,
    `- Source tasks: ${result.case_pack.task_ids.join(", ")}`,
    `- Official harness compatible: no (derived projection)`,
  ] : [];
  return [
    `# Barena XiaobaOS ${result.capability_kind} evaluation`, "",
    `- Decision: ${result.decision}`, `- Reason: ${result.reason_code}`,
    `- Truth: ${result.outcome_truth.status}`,
    `- Baseline pass rate: ${percent(result.effectiveness.baseline_pass_rate.value)}`,
    `- Candidate pass rate: ${percent(result.effectiveness.candidate_pass_rate.value)}`,
    `- Observed lift: ${percent(result.effectiveness.observed_lift)}`,
    `- Required evidence complete: ${result.quality.required_evidence_complete}`,
    `- Independent evaluator AgentSessions: no (supported XiaobaOS native contract)`,
    ...casePack,
    ...live,
    "", result.summary, "",
  ].join("\n");
}
