import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { XiaoBaEvaluatorRuntime } from "../evaluators/xiaoba-evaluator-runtime";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { ensureDir, readJson, writeJson } from "../utils/fs";
import {
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
  const evaluator = options.evaluator ?? new XiaoBaEvaluatorRuntime();
  const target = options.targetAdapter ?? new OpenClawTargetAdapter();
  const [evaluatorProbe, targetProbe] = await Promise.all([evaluator.probe(), target.probe()]);
  return {
    ready: evaluatorProbe.status === "ready" && targetProbe.status === "ready",
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
  if (caseDefinition.target.adapter !== "openclaw") {
    throw new Error("External Agent E2E runner supports only target.adapter=openclaw; use XiaoBa native evaluation for target.adapter=xiaoba");
  }
  const evaluator = options.evaluator ?? new XiaoBaEvaluatorRuntime();
  const skill = options.skill ?? { mode: "none" };
  const targetAdapter = options.targetAdapter ?? new OpenClawTargetAdapter({
    envAllowlist: caseDefinition.target.env_allowlist,
  });
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

  if (evaluatorProbe.status === "blocked" || targetProbe.status === "blocked") {
    const blockedProbe = evaluatorProbe.status === "blocked" ? evaluatorProbe : targetProbe;
    return writeScorecard(runRoot, {
      scorecard_type: "barena.agent_e2e.v1",
      run_id: runId,
      case_id: caseDefinition.case_id,
      created_at: new Date().toISOString(),
      decision: "held",
      status: "blocked",
      reason_code: blockedProbe.reason_code,
      summary: blockedProbe.detail,
      evaluator: {
        runtime: "xiaoba-cli",
        probe: evaluatorProbe,
        stages: { usercat: "blocked", inspectorcat: "blocked", reviewercat: "blocked" },
      },
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
  const observations = uniqueObservations(
    evaluation.attempts.flatMap((attempt) => attempt.target.observation_coverage)
  );
  const everyAttemptPassed = evaluation.attempts.length > 0 && evaluation.attempts.every((attempt) => attempt.status === "pass");
  const anyUnsafe = evaluation.status === "unsafe" || evaluation.attempts.some((attempt) => attempt.status === "unsafe");
  const blocked = evaluation.status === "blocked";
  const status: AgentE2EScorecard["status"] = anyUnsafe
    ? "unsafe"
    : blocked
      ? "blocked"
      : everyAttemptPassed
        ? "pass"
        : "unstable";
  const evidenceRefs = [
    ...evaluation.evaluator_trace_refs,
    ...evaluation.attempts.map((attempt) => attempt.trace_ref),
  ];
  const boundaryTrace = evaluation.attempts.some((attempt) => attempt.target.events.length > 0);
  const evaluatorTraces = evaluation.evaluator_trace_refs.length === 3;
  const workspaceObservation = observations.includes("workspace");

  return writeScorecard(runRoot, {
    scorecard_type: "barena.agent_e2e.v1",
    run_id: runId,
    case_id: caseDefinition.case_id,
    created_at: new Date().toISOString(),
    decision: anyUnsafe ? "rejected" : status === "pass" ? "cleared" : "held",
    status,
    reason_code: evaluation.reason_code,
    summary: evaluation.detail,
    evaluator: { runtime: "xiaoba-cli", probe: evaluatorProbe, stages: evaluation.stages },
    target: {
      adapter: targetAdapter.id,
      probe: targetProbe,
      status: evaluation.attempts[evaluation.attempts.length - 1]?.target.status ?? "not_started",
    },
    attempts: evaluation.attempts,
    evidence_coverage: {
      boundary_trace: boundaryTrace,
      evaluator_traces: evaluatorTraces,
      target_native_trace: false,
      workspace_observation: workspaceObservation,
      observations,
    },
    confidence: confidence({ boundaryTrace, evaluatorTraces, workspaceObservation, attempts: evaluation.attempts.length }),
    evidence_refs: evidenceRefs,
    debug_refs: [preflightPath],
    isolation: "policy_only",
  });
}

function validateCase(value: AgentE2ECaseV1): void {
  if (!value || value.schema !== "barena.agent_e2e_case.v1") {
    throw new Error("Case schema must be barena.agent_e2e_case.v1");
  }
  if (!value.case_id?.trim() || !/^[a-zA-Z0-9._-]+$/.test(value.case_id)) {
    throw new Error("case_id must contain only letters, numbers, dot, underscore, or dash");
  }
  if (!value.target || !["openclaw", "xiaoba"].includes(value.target.adapter)) {
    throw new Error("Case target.adapter must be openclaw or xiaoba");
  }
  if (!value.task?.prompt?.trim()) {
    throw new Error("Case task.prompt must be non-empty");
  }
  if (!value.assertions || !Array.isArray(value.assertions.artifacts)) {
    throw new Error("Case assertions.artifacts must be an array");
  }
  if (value.replays !== undefined && (!Number.isInteger(value.replays) || value.replays < 0 || value.replays > 10)) {
    throw new Error("Case replays must be an integer from 0 to 10");
  }
  if (value.timeout_ms !== undefined && (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1000)) {
    throw new Error("Case timeout_ms must be an integer of at least 1000");
  }
  if (
    value.isolation?.level !== "policy_only" ||
    value.isolation.writable_roots?.length !== 1 ||
    value.isolation.writable_roots[0] !== "workspace"
  ) {
    throw new Error("Phase 1 requires isolation.level=policy_only and writable_roots=[workspace]");
  }
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

function renderAgentE2EReport(scorecard: AgentE2EScorecard): string {
  return [
    `# Barena Agent E2E: ${scorecard.case_id}`,
    "",
    `- Decision: ${scorecard.decision}`,
    `- Status: ${scorecard.status}`,
    `- Reason: ${scorecard.reason_code ?? "none"}`,
    `- XiaoBa evaluator: ${scorecard.evaluator.probe.status}`,
    `- Target: ${scorecard.target.adapter} (${scorecard.target.probe.status})`,
    `- Confidence: ${scorecard.confidence}`,
    `- Isolation: ${scorecard.isolation}`,
    "",
    scorecard.summary,
    "",
  ].join("\n");
}

function emptyCoverage(): AgentE2EScorecard["evidence_coverage"] {
  return {
    boundary_trace: false,
    evaluator_traces: false,
    target_native_trace: false,
    workspace_observation: false,
    observations: [],
  };
}

function uniqueObservations(observations: BoundaryObservedFrom[]): BoundaryObservedFrom[] {
  return [...new Set(observations)];
}

function confidence(input: {
  boundaryTrace: boolean;
  evaluatorTraces: boolean;
  workspaceObservation: boolean;
  attempts: number;
}): AgentE2EScorecard["confidence"] {
  if (!input.boundaryTrace || !input.evaluatorTraces) return "none";
  if (!input.workspaceObservation) return "low";
  return input.attempts > 1 ? "high" : "medium";
}
