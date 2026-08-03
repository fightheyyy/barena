import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BarenaPortableEvaluatorRuntime } from "../evaluators/portable-evaluator-runtime";
import { renderAgentE2EReport } from "../reports/run-renderers";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { HttpTargetAdapter } from "../targets/http-target-adapter";
import { XiaobaTargetAdapter } from "../targets/xiaoba-target-adapter";
import { validateStructuredJsonCheck } from "../verifier/artifact-verifier";
import { ensureDir, readJson, writeJson } from "../utils/fs";
import type {
  AgentE2ECaseV1,
  AgentE2EProgressEvent,
  AgentE2EScorecard,
  BoundaryObservedFrom,
  EvaluatorRuntime,
  TargetAdapter,
  TargetSkillConfig,
} from "./types";

export interface AgentE2ERunOptions {
  runsRoot?: string;
  run_id?: string;
  trace_id?: string;
  evaluator?: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
  skill?: TargetSkillConfig;
  signal?: AbortSignal;
  on_progress?: (
    event: AgentE2EProgressEvent
  ) => void | Promise<void>;
}

export function loadAgentE2ECase(casePath: string): { caseDefinition: AgentE2ECaseV1; caseBaseDir: string } {
  const absolutePath = path.resolve(casePath);
  const caseDefinition = readJson<AgentE2ECaseV1>(absolutePath);
  validateAgentE2ECase(caseDefinition);
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
  validateAgentE2ECase(caseDefinition);
  const runId = options.run_id === undefined
    ? createRunId()
    : validateExecutionId(options.run_id, "run_id");
  const traceId = options.trace_id === undefined
    ? crypto.randomBytes(16).toString("hex")
    : validateTraceId(options.trace_id);
  throwIfAborted(options.signal);
  const evaluator = options.evaluator ?? new BarenaPortableEvaluatorRuntime();
  const targetAdapter = options.targetAdapter ?? defaultTargetAdapter(caseDefinition);
  const skill = options.skill ?? { mode: "none" };
  const runsRoot = path.resolve(options.runsRoot ?? "runs");
  const runRoot = path.join(runsRoot, runId);
  reserveExecutionRoot(runsRoot, runRoot, "Run");
  const emitProgress = createProgressEmitter(options.on_progress, runId);
  for (const directory of [
    path.join(runRoot, "traces", "evaluators"),
    path.join(runRoot, "traces", "native"),
    path.join(runRoot, "reviewer"),
    path.join(runRoot, "reports"),
    path.join(runRoot, "debug"),
  ]) {
    ensureDir(directory);
  }
  writeJson(path.join(runRoot, "case.json"), caseDefinition);

  try {
    const expectedAttempts = (caseDefinition.replays ?? 1) + 1;
    await emitProgress({
      phase: "probe",
      status: "started",
      planned_attempts: expectedAttempts,
      summary: "Checking evaluator and target readiness.",
    });
    throwIfAborted(options.signal);
    const [evaluatorProbe, targetProbe] = await Promise.all([evaluator.probe(), targetAdapter.probe()]);
    await emitProgress({
      phase: "probe",
      component: "evaluator",
      status: evaluatorProbe.status === "ready" ? "completed" : "blocked",
      ...(evaluatorProbe.reason_code && { reason_code: evaluatorProbe.reason_code }),
      summary: evaluatorProbe.detail,
    });
    await emitProgress({
      phase: "probe",
      component: "target",
      status: targetProbe.status === "ready" ? "completed" : "blocked",
      ...(targetProbe.reason_code && { reason_code: targetProbe.reason_code }),
      summary: targetProbe.detail,
    });
    throwIfAborted(options.signal);
    const preflightPath = path.join(runRoot, "debug", "preflight.json");
    writeJson(preflightPath, { evaluator: evaluatorProbe, target: targetProbe });
    const evaluationMode = evaluator.id === "barena-portable" ? "portable_verifier" : "external_evaluator";
    const evidenceProfile = evaluator.id === "barena-portable" ? "boundary_verified" : "evaluator_traced";
    if (evaluatorProbe.status !== "ready" || targetProbe.status !== "ready") {
      const blockedProbe = evaluatorProbe.status !== "ready" ? evaluatorProbe : targetProbe;
      await emitProgress({
        phase: "aggregate",
        status: "blocked",
        reason_code: blockedProbe.reason_code,
        summary: blockedProbe.detail,
      });
      throwIfAborted(options.signal);
      const scorecard = writeScorecard(runRoot, {
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
      await emitProgress({
        phase: "complete",
        status: "blocked",
        decision: scorecard.decision,
        reason_code: scorecard.reason_code,
        summary: scorecard.summary,
      });
      return scorecard;
    }

    await emitProgress({
      phase: "attempt",
      status: "started",
      planned_attempts: expectedAttempts,
      summary: `Executing ${expectedAttempts} isolated attempt${expectedAttempts === 1 ? "" : "s"}.`,
    });
    throwIfAborted(options.signal);
    const evaluation = await evaluator.runCase({
      case_definition: caseDefinition,
      case_base_dir: caseBaseDir,
      run_id: runId,
      run_root: runRoot,
      trace_id: traceId,
      target_adapter: targetAdapter,
      skill,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    for (const [attemptIndex, attempt] of evaluation.attempts.entries()) {
      await emitProgress({
        phase: "attempt",
        status: attempt.status === "blocked"
          ? "blocked"
          : attempt.status === "unsafe"
            ? "unsafe"
            : "completed",
        planned_attempts: expectedAttempts,
        attempt_index: attemptIndex + 1,
        attempt_id: attempt.attempt_id,
        attempt_status: attempt.status,
        ...(attempt.target.reason_code && { reason_code: attempt.target.reason_code }),
        summary: attempt.target.detail,
      });
      await emitProgress({
        phase: "verifier",
        status: "completed",
        planned_attempts: expectedAttempts,
        attempt_index: attemptIndex + 1,
        attempt_id: attempt.attempt_id,
        attempt_status: attempt.status,
        verifier_passed:
          attempt.assertions.length > 0 &&
          attempt.assertions.every((assertion) => assertion.status === "pass"),
        summary: `${attempt.assertions.filter((assertion) => assertion.status === "pass").length}/${attempt.assertions.length} artifact assertions passed.`,
      });
      throwIfAborted(options.signal);
    }
    await emitProgress({
      phase: "aggregate",
      status: "started",
      planned_attempts: expectedAttempts,
      summary: "Aggregating verifier-backed attempt evidence.",
    });
    throwIfAborted(options.signal);
    const observations = uniqueObservations(
      evaluation.attempts.flatMap((attempt) => attempt.target.observation_coverage)
    );
    const boundaryTrace = evaluation.attempts.length > 0 && evaluation.attempts.every((attempt) =>
      attempt.target.events.length > 0 && fs.existsSync(attempt.trace_ref)
    );
    const evaluatorTraces = evaluation.evaluator_trace_refs.length === 3 &&
      evaluation.evaluator_trace_refs.every((ref) => fs.existsSync(ref));
    const workspaceObservation = observations.includes("workspace");
    const targetNativeTrace = evaluation.attempts.length === expectedAttempts &&
      evaluation.attempts.every((attempt) => attempt.target.native_trace_available);
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
      ...evaluation.attempts.flatMap((attempt) => attempt.target.boundary_trace_refs ?? []),
      ...evaluation.attempts.flatMap((attempt) => attempt.target.native_trace_refs ?? []),
    ];
    const scorecard: AgentE2EScorecard = {
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
        target_native_trace: targetNativeTrace,
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
    };
    await emitProgress({
      phase: "aggregate",
      status: scorecard.status === "unsafe"
        ? "unsafe"
        : scorecard.status === "blocked"
          ? "blocked"
          : "completed",
      decision: scorecard.decision,
      ...(scorecard.reason_code && { reason_code: scorecard.reason_code }),
      summary: scorecard.summary,
    });
    throwIfAborted(options.signal);
    writeScorecard(runRoot, scorecard);
    await emitProgress({
      phase: "complete",
      status: scorecard.status === "unsafe"
        ? "unsafe"
        : scorecard.status === "blocked"
          ? "blocked"
          : "completed",
      decision: scorecard.decision,
      ...(scorecard.reason_code && { reason_code: scorecard.reason_code }),
      summary: scorecard.summary,
    });
    return scorecard;
  } catch (error) {
    const cancelled = isAbortError(error) || options.signal?.aborted === true;
    await emitProgress({
      phase: "complete",
      status: cancelled ? "cancelled" : "failed",
      ...(cancelled && { reason_code: "execution_cancelled" as const }),
      summary: cancelled ? abortDetail(options.signal) : errorDetail(error),
    });
    throw error;
  }
}

function validateTraceId(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(
      "trace_id must be a non-zero lowercase 32-character hexadecimal value"
    );
  }
  return value;
}

function defaultTargetAdapter(caseDefinition: AgentE2ECaseV1): TargetAdapter {
  if (caseDefinition.target.adapter === "http") {
    if (!caseDefinition.target.http) {
      throw new Error("HTTP cases require target.http configuration");
    }
    return new HttpTargetAdapter(caseDefinition.target.http);
  }
  if (caseDefinition.target.adapter === "openclaw") {
    return new OpenClawTargetAdapter({ envAllowlist: caseDefinition.target.env_allowlist });
  }
  if (caseDefinition.target.adapter === "xiaoba") {
    return new XiaobaTargetAdapter({ envAllowlist: caseDefinition.target.env_allowlist });
  }
  throw new Error("target.adapter=portable requires a PortableTargetAdapter, normally via --target-command");
}

export function validateAgentE2ECase(value: AgentE2ECaseV1): void {
  if (!value || value.schema !== "barena.agent_e2e_case.v1") {
    throw new Error("Case schema must be barena.agent_e2e_case.v1");
  }
  if (!value.case_id?.trim() || value.case_id === "." || value.case_id === ".." || !/^[a-zA-Z0-9._-]+$/.test(value.case_id)) {
    throw new Error("case_id must be a safe path segment and may not be . or ..");
  }
  if (!value.target || !["http", "openclaw", "portable", "xiaoba"].includes(value.target.adapter)) {
    throw new Error("Case target.adapter must be http, openclaw, portable, or xiaoba");
  }
  if (value.target.adapter === "portable" &&
      (!value.target.runtime || !/^[A-Za-z0-9._-]+$/.test(value.target.runtime))) {
    throw new Error("Portable cases require target.runtime as a safe identifier");
  }
  if (value.target.adapter === "http") {
    validateHttpTarget(value.target.http);
  } else if (value.target.http !== undefined) {
    throw new Error("Case target.http is valid only for target.adapter=http");
  }
  if (!value.task?.prompt?.trim()) throw new Error("Case task.prompt must be non-empty");
  if (!value.assertions || !Array.isArray(value.assertions.artifacts) || value.assertions.artifacts.length === 0) {
    throw new Error("Case assertions.artifacts must be a non-empty array");
  }
  const assertionPaths = new Set<string>();
  for (const assertion of value.assertions.artifacts) {
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
      throw new Error("Each artifact assertion must be an object");
    }
    const relative = safeCaseRelative(assertion.path, "artifact assertion path");
    if (assertionPaths.has(relative)) throw new Error(`Duplicate artifact assertion path: ${relative}`);
    assertionPaths.add(relative);
    if (assertion.exists !== undefined && typeof assertion.exists !== "boolean") {
      throw new Error(`Artifact assertion exists must be boolean: ${relative}`);
    }
    if (assertion.contains !== undefined && typeof assertion.contains !== "string") {
      throw new Error(`Artifact assertion contains must be a string: ${relative}`);
    }
    if (assertion.contains !== undefined && !assertion.contains.trim()) {
      throw new Error(`Artifact assertion contains must be non-empty: ${relative}`);
    }
    if (assertion.exists === false && assertion.contains !== undefined) {
      throw new Error(`Artifact assertion cannot combine exists=false with contains: ${relative}`);
    }
    if (assertion.exists === false && assertion.json_checks !== undefined) {
      throw new Error(`Artifact assertion cannot combine exists=false with json_checks: ${relative}`);
    }
    if (assertion.json_checks !== undefined) {
      if (!Array.isArray(assertion.json_checks) || assertion.json_checks.length === 0) {
        throw new Error(`Artifact assertion json_checks must be non-empty: ${relative}`);
      }
      assertion.json_checks.forEach((check, index) => {
        validateStructuredJsonCheck(check, `${relative}.json_checks[${index}]`);
      });
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

function validateHttpTarget(value: AgentE2ECaseV1["target"]["http"]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HTTP cases require target.http as an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["url", "method", "output_path", "timeout_ms"].includes(key))) {
    throw new Error("Case target.http supports only url, method, output_path, and timeout_ms");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error("Case target.http.url must be an absolute URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Case target.http.url must be HTTP(S) without credentials, query, or fragment"
    );
  }
  if (value.method !== "POST") {
    throw new Error("Case target.http.method must be POST");
  }
  if (
    value.output_path !== undefined &&
    ![
      "$.response",
      "$.message",
      "$.content",
      "$.choices[0].message.content",
    ].includes(value.output_path)
  ) {
    throw new Error("Case target.http.output_path is unsupported");
  }
  if (
    !Number.isInteger(value.timeout_ms) ||
    value.timeout_ms < 100 ||
    value.timeout_ms > 120_000
  ) {
    throw new Error("Case target.http.timeout_ms must be from 100 to 120000");
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
  observer: AgentE2ERunOptions["on_progress"],
  runId: string
): (
  event: Omit<AgentE2EProgressEvent, "schema" | "sequence" | "timestamp" | "run_id">
) => Promise<void> {
  let sequence = 0;
  return async (event) => {
    if (!observer) return;
    const progress: AgentE2EProgressEvent = {
      schema: "barena.agent_e2e_progress.v1",
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      run_id: runId,
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
