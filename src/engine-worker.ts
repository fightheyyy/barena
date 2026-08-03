import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  compilePlatformCaseForReplay,
  loadAgentE2ECase,
  runAgentE2ECase,
  XiaobaTargetAdapter,
  type AgentE2ECaseV1,
  type AgentE2EProgressEvent,
  type AgentE2ERunOptions,
  type AgentE2EScorecard,
  type XiaobaTargetAdapterConfig,
} from "./e2e";
import {
  EngineEventWriter,
  EngineProtocolError,
  createRunPackageV1,
  parseEngineRequestV1,
  writeRunPackageV1,
  type EngineEventV1,
  type EngineRequestV1,
  type RunPackageV1,
  type RunPackageFileInput,
} from "./engine-protocol";
import {
  runSkillEvaluation,
  type RunSkillEvaluationInput,
  type SkillEvaluationProgressEvent,
  type SkillEvaluationResultV1,
} from "./evaluation";
import {
  runExploreScenario,
  type ExploreProgressEvent,
  type ExploreResultV1,
  type ExploreRunOptions,
  type ExploreScenarioV1,
} from "./explore";
import type { XiaobaOSRuntimeAdapterConfig } from "./runtime-adapters";
import {
  exportPlatformReplayTrace,
  type PlatformTelemetryConfig,
} from "./telemetry/platform-otlp-export";
import { ensureDir, writeJson } from "./utils/fs";

export interface EngineWorkerOperations {
  explore(
    scenario: ExploreScenarioV1,
    options: ExploreRunOptions
  ): Promise<ExploreResultV1>;
  replay(
    caseDefinition: AgentE2ECaseV1,
    caseBaseDir: string,
    options: AgentE2ERunOptions
  ): Promise<AgentE2EScorecard>;
  compare(input: RunSkillEvaluationInput): Promise<SkillEvaluationResultV1>;
}

export interface ExecuteEngineRequestOptions {
  signal?: AbortSignal;
  emit?: (line: string, event: EngineEventV1) => void | Promise<void>;
  operations?: EngineWorkerOperations;
  platformTelemetry?: PlatformTelemetryConfig;
}

export interface EngineWorkerResult {
  request: EngineRequestV1;
  result: ExploreResultV1 | AgentE2EScorecard | SkillEvaluationResultV1;
  package: RunPackageV1;
  package_ref: string;
}

const DEFAULT_OPERATIONS: EngineWorkerOperations = {
  explore: runExploreScenario,
  replay: runAgentE2ECase,
  compare: runSkillEvaluation,
};

export async function executeEngineRequest(
  rawRequest: unknown,
  options: ExecuteEngineRequestOptions = {}
): Promise<EngineWorkerResult> {
  const request = parseEngineRequestV1(rawRequest);
  const runRoot = path.join(request.runs_root, request.run_id);
  ensureDir(request.runs_root);
  if (fs.existsSync(runRoot)) {
    throw new EngineProtocolError(
      `Run directory already exists and will not be reused: ${runRoot}`
    );
  }

  const operations = options.operations ?? DEFAULT_OPERATIONS;
  let writer: EngineEventWriter | undefined;
  const eventWriter = (): EngineEventWriter => {
    if (writer) return writer;
    if (!fs.existsSync(runRoot) || !fs.statSync(runRoot).isDirectory()) {
      throw new EngineProtocolError(
        "Engine operation emitted progress before reserving its Run directory"
      );
    }
    writeJson(path.join(runRoot, "engine-request.json"), request);
    writer = new EngineEventWriter({
      run_root: runRoot,
      run_id: request.run_id,
      operation: request.operation,
      emit: options.emit,
    });
    return writer;
  };

  try {
    const replayTraceId = request.operation === "replay"
      ? crypto.randomBytes(16).toString("hex")
      : undefined;
    const result = await executeOperation(
      request,
      operations,
      options.signal,
      eventWriter,
      replayTraceId
    );
    const resultRef = primaryResultRef(request.operation);
    const traceId = replayTraceId ?? primaryRetainedTraceId(runRoot, result);
    if (request.operation === "replay" && traceId) {
      const telemetry = await exportPlatformReplayTrace({
        request,
        runRoot,
        traceId,
        ...(options.platformTelemetry && {
          config: options.platformTelemetry,
        }),
      });
      await eventWriter().write({
        kind: "telemetry",
        phase: "telemetry",
        actor: "otel_exporter",
        trace_id: traceId,
        payload: { ...telemetry },
      });
    }
    await eventWriter().write({
      kind: "terminal",
      phase: "complete",
      actor: "engine",
      ...(traceId && { trace_id: traceId }),
      payload: {
        status: options.signal?.aborted ? "cancelled" : "complete",
        result_ref: resultRef,
        ...terminalSummary(result),
      },
    });
    const packageValue = createRunPackageV1({
      run_root: runRoot,
      run_id: request.run_id,
      status: options.signal?.aborted ? "cancelled" : "complete",
      result_ref: resultRef,
      files: collectPackageFiles(runRoot, resultRef, result),
    });
    const packageRef = writeRunPackageV1(runRoot, packageValue);
    return {
      request,
      result,
      package: packageValue,
      package_ref: packageRef,
    };
  } catch (error) {
    if (!fs.existsSync(runRoot)) {
      fs.mkdirSync(runRoot);
    }
    if (fs.existsSync(runRoot)) {
      const errorRef = "engine-error.json";
      const cancelled =
        options.signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      writeJson(path.join(runRoot, errorRef), {
        schema: "barena.engine_error.v1",
        request_id: request.request_id,
        run_id: request.run_id,
        operation: request.operation,
        status: cancelled ? "cancelled" : "failed",
        reason_code: cancelled ? "execution_cancelled" : "engine_failed",
        summary: safeErrorMessage(error),
      });
      await eventWriter().write({
        kind: "terminal",
        phase: "complete",
        actor: "engine",
        payload: {
          status: cancelled ? "cancelled" : "failed",
          result_ref: errorRef,
          reason_code: cancelled ? "execution_cancelled" : "engine_failed",
          summary: safeErrorMessage(error),
        },
      });
      const packageValue = createRunPackageV1({
        run_root: runRoot,
        run_id: request.run_id,
        status: cancelled ? "cancelled" : "failed",
        result_ref: errorRef,
        files: collectPackageFiles(runRoot, errorRef, {
          error_ref: errorRef,
        }),
      });
      writeRunPackageV1(runRoot, packageValue);
    }
    throw error;
  }
}

async function executeOperation(
  request: EngineRequestV1,
  operations: EngineWorkerOperations,
  signal: AbortSignal | undefined,
  writer: () => EngineEventWriter,
  replayTraceId?: string
): Promise<ExploreResultV1 | AgentE2EScorecard | SkillEvaluationResultV1> {
  if (request.operation === "explore") {
    const scenario = requireObjectField(
      request.input,
      "scenario"
    ) as unknown as ExploreScenarioV1;
    return operations.explore(scenario, {
      runs_root: request.runs_root,
      run_id: request.run_id,
      signal,
      xiaoba: xiaobaConfig(request.runtime),
      on_progress: async (event) => writeExploreProgress(writer(), event),
    });
  }

  if (request.operation === "replay") {
    const loaded = replayInput(request.input);
    const targetAdapter =
      loaded.caseDefinition.target.adapter === "xiaoba"
        ? new XiaobaTargetAdapter(xiaobaReplayConfig(request.runtime))
        : undefined;
    return operations.replay(loaded.caseDefinition, loaded.caseBaseDir, {
      runsRoot: request.runs_root,
      run_id: request.run_id,
      ...(replayTraceId && { trace_id: replayTraceId }),
      signal,
      ...(targetAdapter && { targetAdapter }),
      on_progress: async (event) =>
        writeReplayProgress(writer(), event, replayTraceId),
    });
  }

  const compareInput = compareOperationInput(request);
  return operations.compare({
    ...compareInput,
    evaluation_id: request.run_id,
    runsRoot: request.runs_root,
    signal,
    on_progress: async (event) => writeCompareProgress(writer(), event),
  });
}

async function writeExploreProgress(
  writer: EngineEventWriter,
  event: ExploreProgressEvent
): Promise<void> {
  await writer.write({
    kind: "progress",
    phase: event.stage,
    actor: event.actor,
    ...(event.turn && { attempt_id: `turn-${event.turn}` }),
    payload: withoutProgressEnvelope(event),
  });
}

async function writeReplayProgress(
  writer: EngineEventWriter,
  event: AgentE2EProgressEvent,
  traceId?: string
): Promise<void> {
  await writer.write({
    kind: "progress",
    phase: event.phase,
    actor: event.component ?? replayActor(event.phase),
    ...(event.attempt_id && { attempt_id: event.attempt_id }),
    ...(traceId && { trace_id: traceId }),
    payload: withoutProgressEnvelope(event),
  });
}

async function writeCompareProgress(
  writer: EngineEventWriter,
  event: SkillEvaluationProgressEvent
): Promise<void> {
  await writer.write({
    kind: "progress",
    phase: event.phase,
    actor: event.arm ?? compareActor(event.phase),
    ...(event.attempt_id && { attempt_id: event.attempt_id }),
    payload: withoutProgressEnvelope(event),
  });
}

function withoutProgressEnvelope(
  event:
    | ExploreProgressEvent
    | AgentE2EProgressEvent
    | SkillEvaluationProgressEvent
): Record<string, unknown> {
  const {
    schema: sourceSchema,
    sequence: sourceSequence,
    timestamp: sourceTimestamp,
    ...payload
  } = event;
  return {
    source_schema: sourceSchema,
    source_sequence: sourceSequence,
    source_timestamp: sourceTimestamp,
    ...payload,
  };
}

function replayInput(input: Record<string, unknown>): {
  caseDefinition: AgentE2ECaseV1;
  caseBaseDir: string;
} {
  if (input.platform_case !== undefined) {
    if (input.case_path !== undefined || input.case_definition !== undefined) {
      throw new EngineProtocolError(
        "replay input.platform_case cannot be combined with case_path or case_definition"
      );
    }
    if (input.replay_prompt !== undefined) {
      throw new EngineProtocolError(
        "replay_prompt must be frozen in input.platform_case, not supplied as a separate replay input"
      );
    }
    const caseBaseDir = requireAbsolutePath(
      input.case_base_dir,
      "case_base_dir"
    );
    return {
      caseDefinition: compilePlatformCaseForReplay(input.platform_case),
      caseBaseDir,
    };
  }
  if (typeof input.case_path === "string" && input.case_path.trim()) {
    return loadAgentE2ECase(input.case_path);
  }
  const caseDefinition = requireObjectField(
    input,
    "case_definition"
  ) as unknown as AgentE2ECaseV1;
  const caseBaseDir = requireAbsolutePath(input.case_base_dir, "case_base_dir");
  return { caseDefinition, caseBaseDir };
}

function compareOperationInput(
  request: EngineRequestV1
): Omit<
  RunSkillEvaluationInput,
  "evaluation_id" | "runsRoot" | "signal" | "on_progress"
> {
  const skillPath = requireAbsolutePath(request.input.skill_path, "skill_path");
  if (!Array.isArray(request.input.cases)) {
    throw new EngineProtocolError("compare input.cases must be an array");
  }
  const attempts = request.input.attempts_per_arm;
  if (attempts !== undefined && !Number.isInteger(attempts)) {
    throw new EngineProtocolError(
      "compare input.attempts_per_arm must be an integer"
    );
  }
  const accepted = request.input.accepted_scan_finding_ids;
  if (
    accepted !== undefined &&
    (!Array.isArray(accepted) ||
      !accepted.every((value) => typeof value === "string"))
  ) {
    throw new EngineProtocolError(
      "compare input.accepted_scan_finding_ids must be a string array"
    );
  }
  return {
    skillPath,
    cases: request.input.cases as RunSkillEvaluationInput["cases"],
    ...(typeof request.input.target_id === "string" && {
      targetId: request.input.target_id,
    }),
    ...(typeof attempts === "number" && { attemptsPerArm: attempts }),
    ...(accepted && {
      acceptedScanFindingIds: accepted as string[],
    }),
  };
}

function xiaobaConfig(
  runtime: Record<string, unknown> | undefined
): XiaobaOSRuntimeAdapterConfig | undefined {
  if (!runtime) return undefined;
  const raw =
    runtime.xiaoba && typeof runtime.xiaoba === "object" && !Array.isArray(runtime.xiaoba)
      ? (runtime.xiaoba as Record<string, unknown>)
      : runtime;
  const config: XiaobaOSRuntimeAdapterConfig = {};
  for (const key of [
    "command",
    "project_root",
    "roles_root",
    "skills_root",
  ] as const) {
    const value = raw[key];
    if (value !== undefined && typeof value !== "string") {
      throw new EngineProtocolError(`runtime.${key} must be a string`);
    }
    if (typeof value === "string") config[key] = value;
  }
  const allowlist = raw.env_allowlist;
  if (
    allowlist !== undefined &&
    (!Array.isArray(allowlist) ||
      !allowlist.every((value) => typeof value === "string"))
  ) {
    throw new EngineProtocolError("runtime.env_allowlist must be a string array");
  }
  if (allowlist) config.env_allowlist = allowlist as string[];
  return config;
}

function xiaobaReplayConfig(
  runtime: Record<string, unknown> | undefined
): XiaobaTargetAdapterConfig {
  const config = xiaobaConfig(runtime);
  if (!config) return {};
  return {
    ...(config.command && { command: config.command }),
    ...(config.project_root && { projectRoot: config.project_root }),
    ...(config.roles_root && { rolesRoot: config.roles_root }),
    ...(config.env_allowlist && { envAllowlist: config.env_allowlist }),
  };
}

function collectPackageFiles(
  runRoot: string,
  resultRef: string,
  result: unknown
): RunPackageFileInput[] {
  const refs = new Set<string>([
    resultRef,
    "engine-request.json",
    "events.ndjson",
    "reports/report.json",
    "reports/report.md",
  ]);
  collectResultRefs(result, refs);
  const files: RunPackageFileInput[] = [];
  for (const ref of [...refs].sort()) {
    const relative = normalizeCandidateRef(runRoot, ref);
    if (!relative || !isPublicPackageRef(relative)) continue;
    const absolute = path.join(runRoot, ...relative.split("/"));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    files.push({
      ref: relative,
      kind: packageKind(relative, resultRef),
      media_type: mediaType(relative),
    });
  }
  return files;
}

function collectResultRefs(value: unknown, refs: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (key.endsWith("_ref") || key.endsWith("_refs")) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectResultRefs(entry, refs, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(
    value as Record<string, unknown>
  )) {
    collectResultRefs(child, refs, childKey);
  }
}

function primaryRetainedTraceId(runRoot: string, result: unknown): string | undefined {
  const candidates = new Set<string>();
  collectTraceEvidenceRefs(result, candidates);
  const counts = new Map<string, number>();
  for (const candidate of [...candidates].sort()) {
    const evidencePath = containedEvidencePath(runRoot, candidate);
    if (!evidencePath) continue;
    let source: string;
    try {
      source = fs.readFileSync(evidencePath, "utf8");
    } catch {
      continue;
    }
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as unknown;
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const record = row as Record<string, unknown>;
        const traceId = validOtelId(record.trace_id, 32);
        const spanId = validOtelId(record.span_id, 16);
        if (!traceId || !spanId) continue;
        counts.set(traceId, (counts.get(traceId) ?? 0) + 1);
      } catch {
        // Malformed optional trace rows are not evidence and cannot supply ID.
      }
    }
  }
  return [...counts]
    .sort(([leftId, leftCount], [rightId, rightCount]) =>
      rightCount - leftCount || leftId.localeCompare(rightId)
    )[0]?.[0];
}

function collectTraceEvidenceRefs(
  value: unknown,
  refs: Set<string>,
  key = ""
): void {
  if (typeof value === "string") {
    if (
      key === "otlp_spans" ||
      key === "spans_ref" ||
      key === "trace_ref" ||
      key === "trace_refs" ||
      key === "boundary_trace_refs" ||
      key === "native_trace_refs"
    ) {
      refs.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTraceEvidenceRefs(entry, refs, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(
    value as Record<string, unknown>
  )) {
    collectTraceEvidenceRefs(child, refs, childKey);
  }
}

function containedEvidencePath(
  runRoot: string,
  candidate: string
): string | undefined {
  const root = path.resolve(runRoot);
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  if (!pathContained(root, absolute)) return undefined;
  try {
    if (!fs.statSync(absolute).isFile()) return undefined;
    const real = fs.realpathSync(absolute);
    return pathContained(fs.realpathSync(root), real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function pathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validOtelId(value: unknown, length: number): string | undefined {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value) ||
    /^0+$/.test(value)
  ) {
    return undefined;
  }
  return value.toLowerCase();
}

function normalizeCandidateRef(runRoot: string, ref: string): string | undefined {
  const absolute = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(runRoot, ref);
  const relative = path.relative(runRoot, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function isPublicPackageRef(ref: string): boolean {
  return (
    [
      "scenario.json",
      "case.json",
      "evaluation-request.json",
      "explore-result.json",
      "skill-evaluation.json",
      "replay-candidates.json",
      "engine-error.json",
      "engine-request.json",
      "events.ndjson",
    ].includes(ref) ||
    /^(reports|traces|reviewer|evaluator|debug|admission|arms)\//.test(ref)
  );
}

function packageKind(ref: string, resultRef: string): string {
  if (ref === resultRef) return "result";
  if (ref === "events.ndjson") return "events";
  if (ref.startsWith("reports/")) return "report";
  if (ref.startsWith("traces/")) return "trace";
  if (ref.startsWith("debug/")) return "diagnostic";
  return "evidence";
}

function mediaType(ref: string): string {
  if (ref.endsWith(".json")) return "application/json";
  if (ref.endsWith(".ndjson")) return "application/x-ndjson";
  if (ref.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

function primaryResultRef(operation: EngineRequestV1["operation"]): string {
  if (operation === "explore") return "explore-result.json";
  if (operation === "replay") return "reviewer/scorecard.json";
  return "skill-evaluation.json";
}

function terminalSummary(
  result: ExploreResultV1 | AgentE2EScorecard | SkillEvaluationResultV1
): Record<string, unknown> {
  return {
    ...("status" in result && { result_status: result.status }),
    ...("decision" in result && { decision: result.decision }),
    ...("summary" in result && { summary: result.summary }),
  };
}

function replayActor(phase: AgentE2EProgressEvent["phase"]): string {
  if (phase === "attempt") return "target";
  if (phase === "verifier") return "verifier";
  return "engine";
}

function compareActor(phase: SkillEvaluationProgressEvent["phase"]): string {
  if (phase === "admission") return "admission";
  if (phase === "verifier") return "verifier";
  return "engine";
}

function requireObjectField(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new EngineProtocolError(`input.${key} must be an object`);
  }
  return field as Record<string, unknown>;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new EngineProtocolError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

export async function runEngineWorker(input: {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
} = {}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const abort = new AbortController();
  const cancel = (signal: NodeJS.Signals) => {
    abort.abort(`Worker received ${signal}`);
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const source = await readStream(stdin);
    const parsed = JSON.parse(source) as unknown;
    await executeEngineRequest(parsed, {
      signal: abort.signal,
      emit: (line) =>
        new Promise<void>((resolve, reject) => {
          stdout.write(`${line}\n`, (error) =>
            error ? reject(error) : resolve()
          );
        }),
    });
  } catch (error) {
    stderr.write(`${safeErrorMessage(error)}\n`);
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!source) throw new EngineProtocolError("Engine worker stdin is empty");
  return source;
}

if (require.main === module) {
  void runEngineWorker().catch(() => {
    process.exitCode = 1;
  });
}
