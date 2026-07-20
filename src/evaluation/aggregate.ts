import {
  AttemptCounts,
  EvaluationRunRef,
  ObservedRate,
  SkillEvaluationAggregateInput,
  SkillEvaluationArmResult,
  SkillEvaluationResultV1,
  SkillSelection,
} from "./types";

export function aggregateSkillEvaluation(input: SkillEvaluationAggregateInput): SkillEvaluationResultV1 {
  const baseline = aggregateArm(input.request.baseline, input.baselineRuns, input.request.attempts_per_arm);
  const candidate = aggregateArm(input.request.candidate, input.candidateRuns, input.request.attempts_per_arm);
  const allRuns = [...input.baselineRuns, ...input.candidateRuns];
  const totalObserved = sumCounts(baseline.counts) + sumCounts(candidate.counts);
  const verifierBacked = allRuns.reduce(
    (total, run) => total + run.scorecard.attempts.filter((attempt) => attempt.assertions.length > 0).length,
    0
  );
  const admissionComplete = input.admission
    ? input.admission.decision === "pass" && input.admission.evidence_complete
    : true;
  const evidenceComplete = baseline.evidence_complete && candidate.evidence_complete && admissionComplete;
  const armsComplete = isComplete(baseline) && isComplete(candidate);
  const observedLift = armsComplete && baseline.pass_rate.value !== null && candidate.pass_rate.value !== null
    ? candidate.pass_rate.value - baseline.pass_rate.value
    : null;
  const effectiveness = observedLift === null
    ? "unavailable"
    : observedLift > 0
      ? "improved"
      : observedLift < 0
        ? "regressed"
        : "no_effect";
  const caseRegression = hasCaseRegression(input.baselineRuns, input.candidateRuns);

  const decision = decide({ baseline, candidate, evidenceComplete, effectiveness, caseRegression });
  const targetNative = allRuns.some((run) => run.scorecard.evidence_coverage.target_native_trace);
  const evidenceRefs = [...new Set([
    ...(input.admission?.evidence_refs ?? []),
    ...allRuns.flatMap((run) => [run.scorecard_ref, ...run.scorecard.evidence_refs]),
  ])];

  return {
    schema: "barena.skill_evaluation.v1",
    evaluation_id: input.request.evaluation_id,
    created_at: new Date().toISOString(),
    request_ref: input.requestRef,
    evaluation_mode: "portable_verifier",
    evidence_profile: "boundary_verified",
    decision: decision.decision,
    reason_code: decision.reason,
    summary: decision.summary,
    outcome_truth: {
      status: verifierBacked === 0 ? "unverified" : verifierBacked === totalObserved ? "verified" : "partially_verified",
      verifier_backed_attempts: verifierBacked,
      total_observed_attempts: totalObserved,
    },
    effectiveness: {
      status: effectiveness,
      baseline_pass_rate: baseline.pass_rate,
      candidate_pass_rate: candidate.pass_rate,
      observed_lift: observedLift,
    },
    quality: {
      baseline: baseline.stability,
      candidate: candidate.stability,
      required_evidence_complete: evidenceComplete,
      target_native_trace_available: targetNative,
    },
    baseline,
    candidate,
    ...(input.admission && { admission: input.admission }),
    evidence_refs: evidenceRefs,
    debug_refs: input.debugRefs ?? [],
  };
}

function aggregateArm(
  selection: SkillSelection,
  runs: EvaluationRunRef[],
  attemptsPerArm: number
): SkillEvaluationArmResult {
  const counts: AttemptCounts = {
    planned: runs.length * attemptsPerArm,
    pass: 0,
    fail: 0,
    blocked: 0,
    unsafe: 0,
  };
  for (const run of runs) {
    for (const attempt of run.scorecard.attempts) counts[attempt.status] += 1;
    if (run.scorecard.status === "blocked" && run.scorecard.attempts.length === 0) {
      counts.blocked += attemptsPerArm;
    }
  }
  const denominator = counts.pass + counts.fail + counts.unsafe;
  const passRate: ObservedRate = {
    numerator: counts.pass,
    denominator,
    value: denominator > 0 ? counts.pass / denominator : null,
  };
  const evidenceComplete = runs.length > 0 && runs.every((run) => {
    const scorecard = run.scorecard;
    const profileComplete = scorecard.evaluation_mode === "portable_verifier"
      ? scorecard.evidence_profile === "boundary_verified" && scorecard.evidence_coverage.verifier_evidence
      : scorecard.evidence_coverage.evaluator_traces;
    return scorecard.evidence_coverage.boundary_trace &&
      scorecard.evidence_coverage.workspace_observation &&
      profileComplete &&
      scorecard.attempts.length === attemptsPerArm &&
      scorecard.attempts.every((attempt) => attempt.assertions.length > 0);
  });

  return {
    selection,
    counts,
    pass_rate: passRate,
    stability: stability(counts),
    evidence_complete: evidenceComplete,
    run_refs: runs,
  };
}

function stability(counts: AttemptCounts): SkillEvaluationArmResult["stability"] {
  if (counts.unsafe > 0) return "unsafe";
  if (counts.blocked > 0) return "blocked";
  if (sumCounts(counts) !== counts.planned || counts.planned === 0) return "incomplete";
  if (counts.pass > 0 && counts.fail > 0) return "flaky";
  return counts.pass === counts.planned ? "stable_pass" : "stable_failure";
}

function isComplete(arm: SkillEvaluationArmResult): boolean {
  return arm.counts.blocked === 0 && sumCounts(arm.counts) === arm.counts.planned && arm.counts.planned > 0;
}

function sumCounts(counts: AttemptCounts): number {
  return counts.pass + counts.fail + counts.blocked + counts.unsafe;
}

function decide(input: {
  baseline: SkillEvaluationArmResult;
  candidate: SkillEvaluationArmResult;
  evidenceComplete: boolean;
  effectiveness: SkillEvaluationResultV1["effectiveness"]["status"];
  caseRegression: boolean;
}): { decision: SkillEvaluationResultV1["decision"]; reason: SkillEvaluationResultV1["reason_code"]; summary: string } {
  if (input.candidate.stability === "unsafe") {
    return { decision: "rejected", reason: "unsafe_candidate", summary: "Candidate produced an unsafe attempt." };
  }
  if (input.effectiveness === "regressed" || input.caseRegression) {
    return { decision: "rejected", reason: "skill_regression", summary: "Candidate verifier pass rate regressed against baseline." };
  }
  if (input.baseline.stability === "blocked" || input.candidate.stability === "blocked") {
    const blockedRun = [...input.candidate.run_refs, ...input.baseline.run_refs].find((run) => run.scorecard.status === "blocked");
    return {
      decision: "held",
      reason: blockedRun?.scorecard.reason_code ?? "runtime_blocked",
      summary: blockedRun?.scorecard.summary ?? "Evaluation was blocked before both arms completed.",
    };
  }
  if (!input.evidenceComplete) {
    return { decision: "held", reason: "evidence_incomplete", summary: "Required boundary, workspace, verifier, or profile evidence is incomplete." };
  }
  if (input.baseline.stability === "flaky" || input.candidate.stability === "flaky" ||
      input.baseline.stability === "incomplete" || input.candidate.stability === "incomplete") {
    return { decision: "held", reason: "unstable_result", summary: "At least one paired arm is flaky or incomplete." };
  }
  if (input.effectiveness === "no_effect") {
    return { decision: "held", reason: "no_effect", summary: "Candidate did not improve verifier-backed outcomes over baseline." };
  }
  if (input.effectiveness === "improved" && input.candidate.stability === "stable_pass") {
    return { decision: "cleared", reason: "positive_lift", summary: "Candidate produced a stable, verifier-backed improvement over baseline." };
  }
  return { decision: "held", reason: "unstable_result", summary: "Observed improvement was not stable enough to clear." };
}

function hasCaseRegression(baselineRuns: EvaluationRunRef[], candidateRuns: EvaluationRunRef[]): boolean {
  for (const baseline of baselineRuns) {
    const candidate = candidateRuns.find((run) => run.case_id === baseline.case_id && run.purpose === baseline.purpose);
    if (!candidate) continue;
    const baselineRate = runPassRate(baseline);
    const candidateRate = runPassRate(candidate);
    if (baselineRate !== null && candidateRate !== null && candidateRate < baselineRate) return true;
  }
  return false;
}

function runPassRate(run: EvaluationRunRef): number | null {
  const observed = run.scorecard.attempts.filter((attempt) => attempt.status !== "blocked");
  if (observed.length === 0 || observed.length !== run.scorecard.attempts.length) return null;
  return observed.filter((attempt) => attempt.status === "pass").length / observed.length;
}
