import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadAgentE2ECase, runAgentE2ECase } from "../e2e/case-runner";
import { EvaluatorRuntime, TargetAdapter } from "../e2e/types";
import { BarenaPortableEvaluatorRuntime } from "../evaluators/portable-evaluator-runtime";
import { renderEvaluationReport } from "../reports/run-renderers";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { XiaobaTargetAdapter } from "../targets/xiaoba-target-adapter";
import { ensureDir, hashDirectory, writeJson } from "../utils/fs";
import { aggregateSkillEvaluation } from "./aggregate";
import { prepareStaticAdmission, type StaticAdmissionReportV1 } from "./static-admission";
import {
  CasePurpose,
  EvaluationRunRef,
  SkillEvaluationCase,
  SkillEvaluationProgressEvent,
  SkillEvaluationRequestV1,
  SkillEvaluationResultV1,
  SkillSelection,
} from "./types";

export interface RunSkillEvaluationInput {
  skillPath: string;
  cases: Array<string | SkillEvaluationCase>;
  evaluation_id?: string;
  targetId?: string;
  attemptsPerArm?: number;
  runsRoot?: string;
  evaluator?: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
  acceptedScanFindingIds?: string[];
  signal?: AbortSignal;
  on_progress?: (
    event: SkillEvaluationProgressEvent
  ) => void | Promise<void>;
}

export async function runSkillEvaluation(input: RunSkillEvaluationInput): Promise<SkillEvaluationResultV1> {
  const evaluationId = input.evaluation_id === undefined
    ? createEvaluationId()
    : validateExecutionId(input.evaluation_id, "evaluation_id");
  throwIfAborted(input.signal);
  const candidate = loadSkillSelection(input.skillPath);
  const targetId = normalizeTargetId(input.targetId ?? targetIdFromAdapter(input.targetAdapter));
  const cases = normalizeCases(input.cases);
  const casePaths = cases.map((entry) => entry.case_path);
  if (new Set(casePaths).size !== casePaths.length) throw new Error("Case references must be unique");
  const loadedCases = new Map(casePaths.map((casePath) => [casePath, loadAgentE2ECase(casePath)]));
  for (const loaded of loadedCases.values()) validateCaseTarget(loaded.caseDefinition, targetId);
  const caseIds = [...loadedCases.values()].map((loaded) => loaded.caseDefinition.case_id);
  if (new Set(caseIds).size !== caseIds.length) throw new Error("Loaded case IDs must be unique");
  const attemptsPerArm = input.attemptsPerArm ?? 2;
  if (!Number.isInteger(attemptsPerArm) || attemptsPerArm < 1 || attemptsPerArm > 11) {
    throw new Error("attemptsPerArm must be an integer from 1 to 11");
  }
  if (cases.length === 0) throw new Error("At least one case is required");

  const runsRoot = path.resolve(input.runsRoot ?? "runs");
  const evaluationRoot = path.join(runsRoot, evaluationId);
  reserveExecutionRoot(runsRoot, evaluationRoot, "Evaluation");
  const emitProgress = createProgressEmitter(input.on_progress, evaluationId);

  try {
    await emitProgress({
      phase: "admission",
      status: "started",
      summary: "Checking the candidate Skill before target execution.",
    });
    throwIfAborted(input.signal);
    const admission = prepareStaticAdmission({
      evaluation_root: evaluationRoot,
      subjects: [{
        relation: "candidate",
        subject_kind: "skill",
        subject_id: candidate.name,
        source_path: candidate.source_path,
        fingerprint: candidate.fingerprint,
      }],
      accepted_finding_ids: input.acceptedScanFindingIds,
    });
    const admittedCandidate = admission.subjects.find((subject) =>
      subject.relation === "candidate" && subject.subject_kind === "skill"
    );
    const request: SkillEvaluationRequestV1 = {
      schema: "barena.skill_evaluation_request.v1",
      evaluation_id: evaluationId,
      created_at: new Date().toISOString(),
      target: targetId,
      evaluator_runtime: "barena-portable",
      evaluation_mode: "portable_verifier",
      evidence_profile: "boundary_verified",
      baseline: { mode: "none" },
      candidate: admittedCandidate
        ? { ...candidate, source_path: admittedCandidate.snapshot_path }
        : candidate,
      cases,
      attempts_per_arm: attemptsPerArm,
    };
    const requestRef = path.join(evaluationRoot, "evaluation-request.json");
    writeJson(requestRef, request);
    await emitProgress({
      phase: "admission",
      status: admission.report.decision === "pass"
        ? "completed"
        : admission.report.decision === "rejected"
          ? "unsafe"
          : "blocked",
      reason_code: admission.report.reason_code,
      summary: admission.report.summary,
    });
    throwIfAborted(input.signal);

    if (admission.report.decision !== "pass") {
      const result = staticAdmissionResult(request, requestRef, admission.report);
      await emitProgress({
        phase: "aggregate",
        status: result.decision === "rejected" ? "unsafe" : "blocked",
        decision: result.decision,
        reason_code: result.reason_code,
        summary: result.summary,
      });
      throwIfAborted(input.signal);
      writeEvaluationResult(evaluationRoot, result);
      await emitProgress({
        phase: "complete",
        status: result.decision === "rejected" ? "unsafe" : "blocked",
        decision: result.decision,
        reason_code: result.reason_code,
        summary: result.summary,
      });
      return result;
    }
    const evaluator = input.evaluator ?? new BarenaPortableEvaluatorRuntime();
    const baselineRuns = await runArm({
      arm: "baseline",
      selection: request.baseline,
      cases,
      loadedCases,
      attemptsPerArm,
      evaluationRoot,
      evaluator,
      targetAdapter: input.targetAdapter,
      candidateName: request.candidate.name,
      signal: input.signal,
      emitProgress,
    });
    throwIfAborted(input.signal);
    const candidateRuns = await runArm({
      arm: "candidate",
      selection: request.candidate,
      cases,
      loadedCases,
      attemptsPerArm,
      evaluationRoot,
      evaluator,
      targetAdapter: input.targetAdapter,
      candidateName: request.candidate.name,
      signal: input.signal,
      emitProgress,
    });
    throwIfAborted(input.signal);
    await emitProgress({
      phase: "aggregate",
      status: "started",
      summary: "Comparing verifier-backed baseline and candidate evidence.",
    });
    throwIfAborted(input.signal);
    const result = aggregateSkillEvaluation({
      request,
      requestRef,
      baselineRuns,
      candidateRuns,
      admission: admission.report,
    });
    await emitProgress({
      phase: "aggregate",
      status: result.decision === "rejected"
        ? "unsafe"
        : result.decision === "held"
          ? "blocked"
          : "completed",
      decision: result.decision,
      reason_code: result.reason_code,
      summary: result.summary,
    });
    throwIfAborted(input.signal);
    writeEvaluationResult(evaluationRoot, result);
    await emitProgress({
      phase: "complete",
      status: result.decision === "rejected"
        ? "unsafe"
        : result.decision === "held"
          ? "blocked"
          : "completed",
      decision: result.decision,
      reason_code: result.reason_code,
      summary: result.summary,
    });
    return result;
  } catch (error) {
    const cancelled = isAbortError(error) || input.signal?.aborted === true;
    await emitProgress({
      phase: "complete",
      status: cancelled ? "cancelled" : "failed",
      ...(cancelled && { reason_code: "execution_cancelled" as const }),
      summary: cancelled ? abortDetail(input.signal) : errorDetail(error),
    });
    throw error;
  }
}

function staticAdmissionResult(
  request: SkillEvaluationRequestV1,
  requestRef: string,
  admission: StaticAdmissionReportV1
): SkillEvaluationResultV1 {
  const planned = request.cases.length * request.attempts_per_arm;
  const emptyArm = (selection: SkillSelection): SkillEvaluationResultV1["baseline"] => ({
    selection,
    counts: { planned, pass: 0, fail: 0, blocked: 0, unsafe: 0 },
    pass_rate: { numerator: 0, denominator: 0, value: null },
    stability: "incomplete",
    evidence_complete: false,
    run_refs: [],
  });
  const rate = { numerator: 0, denominator: 0, value: null };
  return {
    schema: "barena.skill_evaluation.v1",
    evaluation_id: request.evaluation_id,
    created_at: new Date().toISOString(),
    request_ref: requestRef,
    evaluation_mode: "portable_verifier",
    evidence_profile: "boundary_verified",
    decision: admission.decision === "rejected" ? "rejected" : "held",
    reason_code: admission.reason_code,
    summary: admission.summary,
    outcome_truth: {
      status: "unverified",
      verifier_backed_attempts: 0,
      total_observed_attempts: 0,
    },
    effectiveness: {
      status: "unavailable",
      baseline_pass_rate: rate,
      candidate_pass_rate: rate,
      observed_lift: null,
    },
    quality: {
      baseline: "incomplete",
      candidate: "incomplete",
      required_evidence_complete: false,
      target_native_trace_available: false,
    },
    baseline: emptyArm(request.baseline),
    candidate: emptyArm(request.candidate),
    admission,
    evidence_refs: admission.evidence_refs,
    debug_refs: [],
  };
}

function writeEvaluationResult(root: string, result: SkillEvaluationResultV1): SkillEvaluationResultV1 {
  writeJson(path.join(root, "skill-evaluation.json"), result);
  ensureDir(path.join(root, "reports"));
  writeJson(path.join(root, "reports", "report.json"), result);
  fs.writeFileSync(path.join(root, "reports", "report.md"), renderEvaluationReport(result), "utf8");
  return result;
}

export function loadSkillSelection(skillPath: string): Extract<SkillSelection, { mode: "path" }> {
  const sourcePath = path.resolve(skillPath);
  const manifestPath = path.join(sourcePath, "SKILL.md");
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Skill directory does not exist: ${sourcePath}`);
  }
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`Skill directory must contain SKILL.md: ${sourcePath}`);
  }
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const name = frontmatterName(manifest) ?? path.basename(sourcePath);
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error("Skill frontmatter name must contain only letters, numbers, dot, underscore, or dash");
  }
  return { mode: "path", name, source_path: sourcePath, fingerprint: hashDirectory(sourcePath) };
}

function normalizeCases(cases: Array<string | SkillEvaluationCase>): SkillEvaluationCase[] {
  return cases.map((entry) => typeof entry === "string"
    ? { case_path: path.resolve(entry), purpose: "effectiveness" as CasePurpose }
    : { case_path: path.resolve(entry.case_path), purpose: entry.purpose });
}

async function runArm(input: {
  arm: "baseline" | "candidate";
  selection: SkillSelection;
  cases: SkillEvaluationCase[];
  loadedCases: Map<string, ReturnType<typeof loadAgentE2ECase>>;
  attemptsPerArm: number;
  evaluationRoot: string;
  evaluator: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
  candidateName: string;
  signal?: AbortSignal;
  emitProgress: (
    event: Omit<
      SkillEvaluationProgressEvent,
      "schema" | "sequence" | "timestamp" | "evaluation_id"
    >
  ) => Promise<void>;
}): Promise<EvaluationRunRef[]> {
  const refs: EvaluationRunRef[] = [];
  await input.emitProgress({
    phase: "arm",
    status: "started",
    arm: input.arm,
    planned_attempts: input.cases.length * input.attemptsPerArm,
    summary: `Starting ${input.arm} arm.`,
  });
  throwIfAborted(input.signal);
  for (const caseEntry of input.cases) {
    throwIfAborted(input.signal);
    const loaded = input.loadedCases.get(caseEntry.case_path);
    if (!loaded) throw new Error(`Prepared case is missing: ${caseEntry.case_path}`);
    const caseDefinition = { ...loaded.caseDefinition, replays: input.attemptsPerArm - 1 };
    const armRunsRoot = path.join(input.evaluationRoot, "arms", input.arm, loaded.caseDefinition.case_id);
    const targetAdapter = input.targetAdapter ?? defaultAdapter(loaded.caseDefinition);
    await input.emitProgress({
      phase: "case",
      status: "started",
      arm: input.arm,
      case_id: loaded.caseDefinition.case_id,
      planned_attempts: input.attemptsPerArm,
      summary: `Running ${loaded.caseDefinition.case_id} on the ${input.arm} arm.`,
    });
    throwIfAborted(input.signal);
    const scorecard = await runAgentE2ECase(caseDefinition, loaded.caseBaseDir, {
      runsRoot: armRunsRoot,
      evaluator: input.evaluator,
      targetAdapter,
      signal: input.signal,
      on_progress: async (event) => {
        if (!["probe", "attempt", "verifier"].includes(event.phase)) return;
        await input.emitProgress({
          phase: event.phase as "probe" | "attempt" | "verifier",
          status: event.status,
          arm: input.arm,
          case_id: loaded.caseDefinition.case_id,
          run_id: event.run_id,
          planned_attempts: event.planned_attempts,
          attempt_index: event.attempt_index,
          attempt_id: event.attempt_id,
          attempt_status: event.attempt_status,
          verifier_passed: event.verifier_passed,
          summary: event.summary,
        });
      },
      skill: input.selection.mode === "none" && loaded.caseDefinition.target.adapter === "xiaoba"
        ? { mode: "none", excluded_name: input.candidateName }
        : input.selection,
    });
    refs.push({
      arm: input.arm,
      case_id: loaded.caseDefinition.case_id,
      purpose: caseEntry.purpose,
      run_id: scorecard.run_id,
      scorecard_ref: path.join(armRunsRoot, scorecard.run_id, "reviewer", "scorecard.json"),
      scorecard,
    });
    await input.emitProgress({
      phase: "case",
      status: scorecard.status === "unsafe"
        ? "unsafe"
        : scorecard.status === "blocked"
          ? "blocked"
          : "completed",
      arm: input.arm,
      case_id: loaded.caseDefinition.case_id,
      run_id: scorecard.run_id,
      decision: scorecard.decision,
      reason_code: scorecard.reason_code,
      summary: scorecard.summary,
    });
    throwIfAborted(input.signal);
  }
  await input.emitProgress({
    phase: "arm",
    status: refs.some((run) => run.scorecard.status === "unsafe")
      ? "unsafe"
      : refs.some((run) => run.scorecard.status === "blocked")
        ? "blocked"
        : "completed",
    arm: input.arm,
    planned_attempts: input.cases.length * input.attemptsPerArm,
    summary: `${input.arm} arm completed ${refs.length}/${input.cases.length} cases.`,
  });
  throwIfAborted(input.signal);
  return refs;
}

function frontmatterName(manifest: string): string | undefined {
  const match = manifest.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const name = match[1].match(/^name:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  return name?.trim();
}

function createEvaluationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `skill-eval-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function validateExecutionId(value: string, label: string): string {
  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} must be a safe path segment and may not be . or ..`);
  }
  return value;
}

function reserveExecutionRoot(parentRoot: string, executionRoot: string, label: string): void {
  ensureDir(parentRoot);
  try {
    fs.mkdirSync(executionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${label} directory already exists and will not be reused: ${executionRoot}`);
    }
    throw error;
  }
}

function createProgressEmitter(
  observer: RunSkillEvaluationInput["on_progress"],
  evaluationId: string
): (
  event: Omit<
    SkillEvaluationProgressEvent,
    "schema" | "sequence" | "timestamp" | "evaluation_id"
  >
) => Promise<void> {
  let sequence = 0;
  return async (event) => {
    if (!observer) return;
    const progress: SkillEvaluationProgressEvent = {
      schema: "barena.skill_evaluation_progress.v1",
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      evaluation_id: evaluationId,
      ...event,
      ...(event.summary && { summary: boundedProgressText(event.summary) }),
    };
    try {
      await observer(progress);
    } catch {
      // Progress is observational. A renderer or protocol consumer failure
      // must not change evaluator truth or persisted evidence.
    }
  };
}

function boundedProgressText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 1_200
    ? normalized
    : `${normalized.slice(0, 1_199)}…`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error(abortDetail(signal));
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortDetail(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return `Execution cancelled: ${reason.message}`;
  if (typeof reason === "string" && reason.trim()) return `Execution cancelled: ${reason.trim()}`;
  return "Execution cancelled by the caller.";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetIdFromAdapter(adapter: TargetAdapter | undefined): string {
  if (!adapter || adapter.id === "openclaw") return "openclaw";
  if (adapter.id === "xiaobaos") return "xiaobaos";
  return adapter.id.startsWith("portable:") ? adapter.id.slice("portable:".length) : adapter.id;
}

function normalizeTargetId(value: string): string {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Skill evaluation target must be a safe runtime identifier");
  }
  return value;
}

function validateCaseTarget(
  caseDefinition: ReturnType<typeof loadAgentE2ECase>["caseDefinition"],
  targetId: string
): void {
  if (targetId === "openclaw") {
    if (caseDefinition.target.adapter !== "openclaw") {
      throw new Error("OpenClaw Skill evaluation requires case target.adapter=openclaw");
    }
    return;
  }
  if (targetId === "xiaobaos") {
    if (caseDefinition.target.adapter !== "xiaoba" || caseDefinition.target.runtime !== "xiaobaos") {
      throw new Error("XiaobaOS Skill evaluation requires case target.adapter=xiaoba and target.runtime=xiaobaos");
    }
    return;
  }
  if (caseDefinition.target.adapter !== "portable" || caseDefinition.target.runtime !== targetId) {
    throw new Error(`Portable Skill evaluation for ${targetId} requires case target.adapter=portable and target.runtime=${targetId}`);
  }
}

function defaultAdapter(caseDefinition: ReturnType<typeof loadAgentE2ECase>["caseDefinition"]): TargetAdapter {
  if (caseDefinition.target.adapter === "openclaw") {
    return new OpenClawTargetAdapter({ envAllowlist: caseDefinition.target.env_allowlist });
  }
  if (caseDefinition.target.adapter === "xiaoba") {
    return new XiaobaTargetAdapter({ envAllowlist: caseDefinition.target.env_allowlist });
  }
  throw new Error("Portable Skill evaluation requires an explicit PortableTargetAdapter");
}
