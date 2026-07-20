import { runTargetObservationAttempts } from "../e2e/target-observation";
import type {
  EvaluatorRunRequest,
  EvaluatorRunResult,
  EvaluatorRuntime,
  RuntimeProbeResult,
} from "../e2e/types";

export class BarenaPortableEvaluatorRuntime implements EvaluatorRuntime {
  readonly id = "barena-portable" as const;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "portable-evaluator",
      status: "ready",
      detail: "Barena portable boundary/workspace verifier is ready.",
      command: "barena",
      capabilities: ["boundary_trace", "workspace_observation", "artifact_verifier", "replay"],
    };
  }

  async runCase(request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    const attempts = await runTargetObservationAttempts({
      caseDefinition: request.case_definition,
      caseBaseDir: request.case_base_dir,
      runId: request.run_id,
      runRoot: request.run_root,
      targetAdapter: request.target_adapter,
      skill: request.skill,
    });
    const unsafe = attempts.find((attempt) => attempt.status === "unsafe");
    const blocked = attempts.find((attempt) => attempt.status === "blocked");
    const started = attempts.filter((attempt) => attempt.target.status !== "blocked");
    const sessions = started.map((attempt) => attempt.target.session_id).filter((value): value is string => Boolean(value));
    const sessionEvidenceComplete = sessions.length === started.length && new Set(sessions).size === sessions.length;

    if (unsafe) return portableResult("unsafe", unsafe.target.reason_code ?? "target_reported_unsafe", unsafe.target.detail, attempts);
    if (blocked) return portableResult("blocked", blocked.target.reason_code, blocked.target.detail, attempts);
    if (!sessionEvidenceComplete) {
      return portableResult(
        "blocked",
        "evidence_incomplete",
        "Portable target attempts must report a distinct non-empty session_id for every started attempt.",
        attempts
      );
    }
    return portableResult(
      "completed",
      undefined,
      attempts.every((attempt) => attempt.status === "pass")
        ? "Portable target attempts completed with verifier-backed outcomes."
        : "Portable target attempts completed; at least one deterministic verifier did not pass.",
      attempts
    );
  }
}

function portableResult(
  status: EvaluatorRunResult["status"],
  reasonCode: EvaluatorRunResult["reason_code"],
  detail: string,
  attempts: EvaluatorRunResult["attempts"]
): EvaluatorRunResult {
  return {
    status,
    ...(reasonCode && { reason_code: reasonCode }),
    detail,
    stages: { usercat: "not_applicable", inspectorcat: "not_applicable", reviewercat: "not_applicable" },
    attempts,
    evaluator_trace_refs: [],
  };
}
