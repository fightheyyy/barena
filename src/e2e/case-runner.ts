import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BarenaPortableEvaluatorRuntime } from "../evaluators/portable-evaluator-runtime";
import { renderAgentE2EReport } from "../reports/run-renderers";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { ensureDir, readJson, writeJson } from "../utils/fs";
import type {
  AgentE2ECaseV1,
  AgentE2EScorecard,
  BoundaryObservedFrom,
  EvaluatorRuntime,
  TargetAdapter,
  TargetSkillConfig,
} from "./types";

export interface AgentE2ERunOptions {
  runsRoot?: string;
  evaluator?: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
  skill?: TargetSkillConfig;
}

export function loadAgentE2ECase(casePath: string): { caseDefinition: AgentE2ECaseV1; caseBaseDir: string } {
  const absolutePath = path.resolve(casePath);
  const caseDefinition = readJson<AgentE2ECaseV1>(absolutePath);
  validateCase(caseDefinition);
  return { caseDefinition, caseBaseDir: path.dirname(absolutePath) };
}

export async function probeAgentE2E(options: AgentE2ERunOptions = {}): Promise<Record<string, unknown>> {
  const evaluator = options.evaluator ?? new BarenaPortableEvaluatorRuntime();
  const target = options.targetAdapter ?? new OpenClawTargetAdapter();
  const [evaluatorProbe, targetProbe] = await Promise.all([evaluator.probe(), target.probe()]);
  return {
    ready: evaluatorProbe.status === "ready" && targetProbe.status === "ready",
    evaluation_mode: evaluator.id === "barena-portable" ? "portable_verifier" : "external_evaluator",
    evidence_profile: evaluator.id === "barena-portable" ? "boundary_verified" : "evaluator_traced",
    evaluator: evaluatorProbe,
    target: targetProbe,
  };
}

export async function runAgentE2ECase(
  caseDefinition: AgentE2ECaseV1,
  caseBaseDir: string,
  options: AgentE2ERunOptions = {}
): Promise<AgentE2EScorecard> {
  validateCase(caseDefinition);
  if (caseDefinition.target.adapter === "xiaoba") {
    throw new Error("External Agent E2E runner does not accept target.adapter=xiaoba; use XiaobaOS native evaluation");
  }
  const evaluator = options.evaluator ?? new BarenaPortableEvaluatorRuntime();
  const targetAdapter = options.targetAdapter ?? defaultTargetAdapter(caseDefinition);
  const skill = options.skill ?? { mode: "none" };
  const runId = createRunId();
  const runRoot = path.resolve(options.runsRoot ?? "runs", runId);
  for (const directory of [
    runRoot,
    path.join(runRoot, "traces", "evaluators"),
    path.join(runRoot, "traces", "native"),
    path.join(runRoot, "reviewer"),
    path.join(runRoot, "reports"),
    path.join(runRoot, "debug"),
  ]) {
    ensureDir(directory);
  }
  writeJson(path.join(runRoot, "case.json"), caseDefinition);

  const [evaluatorProbe, targetProbe] = await Promise.all([evaluator.probe(), targetAdapter.probe()]);
  const preflightPath = path.join(runRoot, "debug", "preflight.json");
  writeJson(preflightPath, { evaluator: evaluatorProbe, target: targetProbe });
  const evaluationMode = evaluator.id === "barena-portable" ? "portable_verifier" : "external_evaluator";
  const evidenceProfile = evaluator.id === "barena-portable" ? "boundary_verified" : "evaluator_traced";
  if (evaluatorProbe.status !== "ready" || targetProbe.status !== "ready") {
    const blockedProbe = evaluatorProbe.status !== "ready" ? evaluatorProbe : targetProbe;
    return writeScorecard(runRoot, {
      scorecard_type: "barena.agent_e2e.v1",
      run_id: runId,
      case_id: caseDefinition.case_id,
      created_at: new Date().toISOString(),
      evaluation_mode: evaluationMode,
      evidence_profile: evidenceProfile,
      decision: "held",
      status: "blocked",
      reason_code: blockedProbe.reason_code,
      summary: blockedProbe.detail,
      evaluator: { runtime: evaluator.id, probe: evaluatorProbe, stages: blockedStages(evaluator.id) },
      target: { adapter: targetAdapter.id, probe: targetProbe, status: "not_started" },
      attempts: [],
      evidence_coverage: emptyCoverage(),
      confidence: "none",
      evidence_refs: [],
      debug_refs: [preflightPath],
      isolation: "policy_only",
    });
  }

  const evaluation = await evaluator.runCase({
    case_definition: caseDefinition,
    case_base_dir: caseBaseDir,
    run_id: runId,
    run_root: runRoot,
    target_adapter: targetAdapter,
    skill,
  });
  const expectedAttempts = (caseDefinition.replays ?? 1) + 1;
  const observations = uniqueObservations(
    evaluation.attempts.flatMap((attempt) => attempt.target.observation_coverage)
  );
  const boundaryTrace = evaluation.attempts.length > 0 && evaluation.attempts.every((attempt) =>
    attempt.target.events.length > 0 && fs.existsSync(attempt.trace_ref)
  );
  const evaluatorTraces = evaluation.evaluator_trace_refs.length === 3 &&
    evaluation.evaluator_trace_refs.every((ref) => fs.existsSync(ref));
  const workspaceObservation = observations.includes("workspace");
  const verifierEvidence = evaluation.attempts.length === expectedAttempts && evaluation.attempts.every((attempt) =>
    attempt.assertions.length > 0 && fs.existsSync(attempt.verifier_ref)
  );
  const requiredEvidence = boundaryTrace && workspaceObservation && verifierEvidence &&
    (evaluationMode === "portable_verifier" || evaluatorTraces);
  const everyAttemptPassed = evaluation.attempts.length === expectedAttempts &&
    evaluation.attempts.every((attempt) => attempt.status === "pass");
  const anyUnsafe = evaluation.status === "unsafe" ||
    evaluation.attempts.some((attempt) => attempt.status === "unsafe");
  const blocked = evaluation.status === "blocked";
  const status: AgentE2EScorecard["status"] = anyUnsafe
    ? "unsafe"
    : blocked
      ? "blocked"
      : everyAttemptPassed && requiredEvidence
        ? "pass"
        : "unstable";
  const reasonCode = evaluation.reason_code ??
    (!requiredEvidence ? "evidence_incomplete" : status === "unstable" ? "artifact_assertion_failed" : undefined);
  const evidenceRefs = [
    ...evaluation.evaluator_trace_refs,
    ...evaluation.attempts.flatMap((attempt) => [attempt.trace_ref, attempt.verifier_ref]),
  ];
  return writeScorecard(runRoot, {
    scorecard_type: "barena.agent_e2e.v1",
    run_id: runId,
    case_id: caseDefinition.case_id,
    created_at: new Date().toISOString(),
    evaluation_mode: evaluationMode,
    evidence_profile: evidenceProfile,
    decision: anyUnsafe ? "rejected" : status === "pass" ? "cleared" : "held",
    status,
    ...(reasonCode && { reason_code: reasonCode }),
    summary: evaluation.detail,
    evaluator: { runtime: evaluator.id, probe: evaluatorProbe, stages: evaluation.stages },
    target: {
      adapter: targetAdapter.id,
      probe: targetProbe,
      status: evaluation.attempts[evaluation.attempts.length - 1]?.target.status ?? "not_started",
    },
    attempts: evaluation.attempts,
    evidence_coverage: {
      boundary_trace: boundaryTrace,
      evaluator_traces: evaluatorTraces,
      verifier_evidence: verifierEvidence,
      target_native_trace: false,
      workspace_observation: workspaceObservation,
      observations,
    },
    confidence: confidence({
      evaluationMode,
      boundaryTrace,
      evaluatorTraces,
      verifierEvidence,
      workspaceObservation,
      attempts: evaluation.attempts.length,
    }),
    evidence_refs: evidenceRefs,
    debug_refs: [preflightPath],
    isolation: "policy_only",
  });
}

function defaultTargetAdapter(caseDefinition: AgentE2ECaseV1): TargetAdapter {
  if (caseDefinition.target.adapter === "openclaw") {
    return new OpenClawTargetAdapter({ envAllowlist: caseDefinition.target.env_allowlist });
  }
  throw new Error("target.adapter=portable requires a PortableTargetAdapter, normally via --target-command");
}

function validateCase(value: AgentE2ECaseV1): void {
  if (!value || value.schema !== "barena.agent_e2e_case.v1") {
    throw new Error("Case schema must be barena.agent_e2e_case.v1");
  }
  if (!value.case_id?.trim() || value.case_id === "." || value.case_id === ".." || !/^[a-zA-Z0-9._-]+$/.test(value.case_id)) {
    throw new Error("case_id must be a safe path segment and may not be . or ..");
  }
  if (!value.target || !["openclaw", "portable", "xiaoba"].includes(value.target.adapter)) {
    throw new Error("Case target.adapter must be openclaw, portable, or xiaoba");
  }
  if (value.target.adapter === "portable" &&
      (!value.target.runtime || !/^[A-Za-z0-9._-]+$/.test(value.target.runtime))) {
    throw new Error("Portable cases require target.runtime as a safe identifier");
  }
  if (!value.task?.prompt?.trim()) throw new Error("Case task.prompt must be non-empty");
  if (!value.assertions || !Array.isArray(value.assertions.artifacts) || value.assertions.artifacts.length === 0) {
    throw new Error("Case assertions.artifacts must be a non-empty array");
  }
  const assertionPaths = new Set<string>();
  for (const assertion of value.assertions.artifacts) {
    const relative = safeCaseRelative(assertion.path, "artifact assertion path");
    if (assertionPaths.has(relative)) throw new Error(`Duplicate artifact assertion path: ${relative}`);
    assertionPaths.add(relative);
    if (assertion.contains !== undefined && !assertion.contains.trim()) {
      throw new Error(`Artifact assertion contains must be non-empty: ${relative}`);
    }
    if (assertion.exists === false && assertion.contains !== undefined) {
      throw new Error(`Artifact assertion cannot combine exists=false with contains: ${relative}`);
    }
  }
  const fixtureDestinations = new Set<string>();
  for (const fixture of value.fixtures ?? []) {
    if (!fixture.source?.trim()) throw new Error("Fixture source must be non-empty");
    const destination = safeCaseRelative(fixture.destination, "fixture destination");
    if (fixtureDestinations.has(destination)) throw new Error(`Duplicate fixture destination: ${destination}`);
    fixtureDestinations.add(destination);
  }
  const envNames = value.target.env_allowlist ?? [];
  if (new Set(envNames).size !== envNames.length ||
      envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Case target.env_allowlist must contain unique valid environment names");
  }
  if (value.replays !== undefined &&
      (!Number.isInteger(value.replays) || value.replays < 0 || value.replays > 10)) {
    throw new Error("Case replays must be an integer from 0 to 10");
  }
  if (value.timeout_ms !== undefined &&
      (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1000)) {
    throw new Error("Case timeout_ms must be an integer of at least 1000");
  }
  if (value.isolation?.level !== "policy_only" ||
      value.isolation.writable_roots?.length !== 1 ||
      value.isolation.writable_roots[0] !== "workspace") {
    throw new Error("Phase 1 requires isolation.level=policy_only and writable_roots=[workspace]");
  }
}

function safeCaseRelative(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  return normalized;
}

function blockedStages(id: EvaluatorRuntime["id"]): AgentE2EScorecard["evaluator"]["stages"] {
  return id === "barena-portable"
    ? { usercat: "not_applicable", inspectorcat: "not_applicable", reviewercat: "not_applicable" }
    : { usercat: "blocked", inspectorcat: "blocked", reviewercat: "blocked" };
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `agent-e2e-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function writeScorecard(runRoot: string, scorecard: AgentE2EScorecard): AgentE2EScorecard {
  writeJson(path.join(runRoot, "reviewer", "scorecard.json"), scorecard);
  writeJson(path.join(runRoot, "reports", "report.json"), scorecard);
  fs.writeFileSync(path.join(runRoot, "reports", "report.md"), renderAgentE2EReport(scorecard), "utf8");
  return scorecard;
}

function emptyCoverage(): AgentE2EScorecard["evidence_coverage"] {
  return {
    boundary_trace: false,
    evaluator_traces: false,
    verifier_evidence: false,
    target_native_trace: false,
    workspace_observation: false,
    observations: [],
  };
}

function uniqueObservations(observations: BoundaryObservedFrom[]): BoundaryObservedFrom[] {
  return [...new Set(observations)];
}

function confidence(input: {
  evaluationMode: AgentE2EScorecard["evaluation_mode"];
  boundaryTrace: boolean;
  evaluatorTraces: boolean;
  verifierEvidence: boolean;
  workspaceObservation: boolean;
  attempts: number;
}): AgentE2EScorecard["confidence"] {
  if (!input.boundaryTrace || !input.verifierEvidence) return "none";
  if (!input.workspaceObservation) return "low";
  if (input.evaluationMode === "portable_verifier") return "medium";
  return input.evaluatorTraces && input.attempts > 1 ? "high" : "medium";
}
