import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendNdjson, copyDirectory, ensureDir, hashDirectory, readJson, writeJson } from "../utils/fs";
import type { ArtifactAssertionResult } from "../e2e/types";
import {
  RunXiaoBaNativeEvaluationInput,
  XIAOBA_NATIVE_CONTRACT_VERSION,
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaCapabilityEvaluationResultV1,
  XiaoBaCommandRequest,
  XiaoBaCommandResult,
  XiaoBaCommandRunner,
  XiaoBaEvidenceCopy,
  XiaoBaNativeArm,
  XiaoBaNativeArmResult,
  XiaoBaNativeArtifactAssertion,
  XiaoBaNativeAttemptCounts,
  XiaoBaNativeAttemptResult,
  XiaoBaNativeCaseV1,
  XiaoBaNativeDecision,
  XiaoBaNativeObservedRate,
  XiaoBaNativeProbeResult,
  XiaoBaNativeReasonCode,
  XiaoBaNativeRoleSelection,
  XiaoBaNativeRoleSource,
  XiaoBaNativeRoleSkillSelection,
  XiaoBaNativeRunnerDependencies,
  XiaoBaNativeRuntimeConfig,
  XiaoBaNativeSkillSource,
} from "./xiaoba-native-types";

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FINGERPRINT = /^[a-f0-9]{64}$/i;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REQUIRED_EXECUTE_HELP = [
  "base_skill|role_skill|role",
  "--subject",
  "--target-role",
  "--run-id",
  "--workspace-seed",
  "--message",
  "--pass-env",
  "--replay-attempts",
  "--max-replay-cases",
];
const XIAOBA_011_DEFAULT_EXCLUDED_SKILLS = new Set([
  "webcli",
  "officecli",
  "officecli-docx",
  "officecli-pptx",
  "officecli-xlsx",
  "vision-analysis",
  "sub-agent",
  "background-task-runner",
]);

type JsonRecord = Record<string, unknown>;

interface StagedSelection {
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection;
  roles_root: string;
  role_path: string;
  skill_path?: string;
}

interface ValidatedArenaArtifacts {
  subject_id: string;
  workspace_root: string;
  decision: XiaoBaNativeDecision;
  activation_observed: boolean;
  assertions: ArtifactAssertionResult[];
  role_manifest: string;
  subject_manifest: string;
  clean_runtime: string;
  arena_runner: string;
  arena_scorecard: string;
  arena_run: string;
  verifier: string;
  native_refs: string[];
  evaluator_refs: string[];
  debug_refs: string[];
  stages_passed: boolean;
}

interface BoundaryContext {
  run_id: string;
  case_id: string;
  attempt_id: string;
}

class XiaoBaNativeError extends Error {
  constructor(readonly reason_code: XiaoBaNativeReasonCode, message: string) {
    super(message);
  }
}

export class NodeXiaoBaCommandRunner implements XiaoBaCommandRunner {
  run(request: XiaoBaCommandRequest): Promise<XiaoBaCommandResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let outputLimitExceeded = false;
      let spawnError: string | undefined;
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeout_ms);
      const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
        if (outputLimitExceeded) return;
        const current = target === "stdout" ? stdout : stderr;
        if (stdout.length + stderr.length + chunk.length > request.max_output_bytes) {
          outputLimitExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (target === "stdout") stdout = Buffer.concat([current, chunk]);
        else stderr = Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.on("error", (error) => { spawnError = error.message; });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exit_code: code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          duration_ms: Date.now() - started,
          timed_out: timedOut,
          output_limit_exceeded: outputLimitExceeded,
          ...(spawnError && { error: spawnError }),
        });
      });
    });
  }
}

export class XiaoBaNativeEvaluationRunner {
  private readonly commandRunner: XiaoBaCommandRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(dependencies: XiaoBaNativeRunnerDependencies = {}) {
    this.commandRunner = dependencies.command_runner ?? new NodeXiaoBaCommandRunner();
    this.environment = dependencies.environment ?? process.env;
    this.now = dependencies.now ?? (() => new Date());
    this.nonce = dependencies.nonce ?? (() => crypto.randomBytes(4).toString("hex"));
  }

  async probe(config: XiaoBaNativeRuntimeConfig): Promise<XiaoBaNativeProbeResult> {
    const checks: XiaoBaNativeProbeResult["checks"] = [];
    const base = probeBase(config, checks);
    if (base) return base;
    const commands: Array<{ args: string[]; required?: string[] }> = [
      { args: ["--version"] },
      { args: ["arena", "--help"], required: ["skill", "snapshot", "runtime", "run"] },
      { args: ["arena", "import", "skill", "--help"], required: ["<path>"] },
      { args: ["arena", "snapshot", "role", "--help"], required: ["role-id"] },
      { args: ["arena", "runtime", "prepare", "--help"], required: ["base_skill|role_skill|role"] },
      { args: ["arena", "run", "execute", "--help"], required: REQUIRED_EXECUTE_HELP },
    ];
    let version: string | undefined;
    for (const command of commands) {
      const result = await this.commandRunner.run({
        command: path.resolve(config.binary_path),
        args: command.args,
        cwd: path.resolve(config.project_root),
        env: probeEnvironment(this.environment),
        timeout_ms: 15_000,
        max_output_bytes: MAX_OUTPUT_BYTES,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (command.args.length === 1 && command.args[0] === "--version") {
        version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
      }
      const missing = (command.required ?? []).filter((value) => !output.includes(value));
      const ok = result.exit_code === 0 && !result.timed_out && !result.output_limit_exceeded && missing.length === 0;
      checks.push({
        command: [config.binary_path, ...command.args],
        exit_code: result.exit_code,
        ok,
        detail: ok ? "CLI contract present." : `CLI check failed${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`,
      });
      if (!ok) return blockedProbe(config, checks, "xiaoba_cli_contract_unavailable", "Required XiaoBa Arena CLI help contract is unavailable.", version);
    }
    if (version !== config.expected_version || version !== XIAOBA_NATIVE_CONTRACT_VERSION) {
      return blockedProbe(config, checks, "xiaoba_version_unsupported", `Expected XiaoBa ${XIAOBA_NATIVE_CONTRACT_VERSION}, observed ${version ?? "unknown"}.`, version);
    }
    return {
      status: "ready",
      binary_path: path.resolve(config.binary_path),
      project_root: path.resolve(config.project_root),
      version,
      expected_version: XIAOBA_NATIVE_CONTRACT_VERSION,
      capabilities: probeCapabilities(),
      checks,
      detail: "XiaoBa 0.1.1 native Arena contract is ready.",
    };
  }

  async run(input: RunXiaoBaNativeEvaluationInput): Promise<XiaoBaCapabilityEvaluationResultV1> {
    validateRequest(input.request);
    const runsRoot = path.resolve(input.runs_root ?? "runs");
    ensureDir(runsRoot);
    const evaluationRoot = path.join(runsRoot, input.request.evaluation_id);
    if (fs.existsSync(evaluationRoot)) {
      throw new XiaoBaNativeError("xiaoba_execution_root_invalid", `Evaluation root already exists: ${evaluationRoot}`);
    }
    ensureDir(evaluationRoot);
    const requestRef = path.join(evaluationRoot, "evaluation-request.json");
    writeJson(requestRef, input.request);
    const probe = await this.probe(input.request.xiaoba);
    const probeRef = path.join(evaluationRoot, "debug", "xiaoba-probe.json");
    writeJson(probeRef, probe);
    if (probe.status === "blocked") {
      const result = blockedResult(input.request, requestRef, probe, probe.reason_code ?? "xiaoba_cli_contract_unavailable", probe.detail);
      result.debug_refs = [probeRef];
      return this.writeResult(evaluationRoot, result);
    }

    let staged: Record<XiaoBaNativeArm, StagedSelection>;
    try {
      staged = stageRequest(input.request, evaluationRoot);
    } catch (error) {
      const failure = nativeError(error, "xiaoba_source_copy_failed");
      const result = blockedResult(input.request, requestRef, probe, failure.reason_code, failure.message);
      result.debug_refs = [probeRef];
      return this.writeResult(evaluationRoot, result);
    }

    const baselineAttempts = await this.runArm(input.request, "baseline", staged.baseline, evaluationRoot);
    const candidateAttempts = await this.runArm(input.request, "candidate", staged.candidate, evaluationRoot);
    return this.writeResult(
      evaluationRoot,
      aggregateResult(input.request, requestRef, probe, baselineAttempts, candidateAttempts, this.now())
    );
  }

  private async runArm(
    request: XiaoBaCapabilityEvaluationRequestV1,
    arm: XiaoBaNativeArm,
    staged: StagedSelection,
    evaluationRoot: string
  ): Promise<XiaoBaNativeAttemptResult[]> {
    const attempts: XiaoBaNativeAttemptResult[] = [];
    for (const caseDefinition of request.cases) {
      for (let attempt = 1; attempt <= request.attempts_per_arm; attempt += 1) {
        attempts.push(await this.runAttempt(request, arm, staged, caseDefinition, attempt, evaluationRoot));
      }
    }
    return attempts;
  }

  private async runAttempt(
    request: XiaoBaCapabilityEvaluationRequestV1,
    arm: XiaoBaNativeArm,
    staged: StagedSelection,
    caseDefinition: XiaoBaNativeCaseV1,
    attempt: number,
    evaluationRoot: string
  ): Promise<XiaoBaNativeAttemptResult> {
    const attemptRoot = path.join(evaluationRoot, "arms", arm, caseDefinition.case_id, `attempt-${attempt}`);
    const executionRoot = path.join(attemptRoot, "xiaoba-project");
    const homeRoot = path.join(attemptRoot, "home");
    const seedRoot = path.join(attemptRoot, "workspace-seed");
    const boundaryTrace = path.join(attemptRoot, "traces", "boundary.ndjson");
    ensureDir(executionRoot);
    ensureDir(homeRoot);
    ensureDir(seedRoot);
    bindDist(request.xiaoba.project_root, executionRoot);
    if (fs.existsSync(path.join(executionRoot, "roles"))) {
      return blockedAttempt(request, arm, staged.selection, caseDefinition, attempt, executionRoot, boundaryTrace,
        "xiaoba_execution_root_invalid", "Execution root contains a forbidden roles shadow.");
    }
    materializeFixtures(caseDefinition, seedRoot);
    const runId = safeRunId(request.evaluation_id, arm, caseDefinition.case_id, attempt, this.nonce());
    const deliveredPrompt = request.capability_kind === "skill"
      ? `${request.candidate.skill.name}\n\n${caseDefinition.task.prompt}`
      : caseDefinition.task.prompt;
    const requestManifest = path.join(attemptRoot, "request-manifest.json");
    const boundaryContext: BoundaryContext = {
      run_id: runId,
      case_id: caseDefinition.case_id,
      attempt_id: `attempt-${attempt}`,
    };
    writeJson(requestManifest, {
      version: 1,
      evaluation_id: request.evaluation_id,
      arm,
      case_id: caseDefinition.case_id,
      attempt,
      xiaoba_run_id: runId,
      mode: staged.selection.mode,
      role_id: staged.selection.role.role_id,
      role_fingerprint: staged.selection.role.fingerprint,
      ...(staged.selection.mode === "role_skill" && {
        skill_name: staged.selection.skill.name,
        skill_fingerprint: staged.selection.skill.fingerprint,
      }),
      delivered_prompt: deliveredPrompt,
      execution_root: executionRoot,
      roles_root: staged.roles_root,
      pass_env_names: request.xiaoba.pass_env,
      created_at: this.now().toISOString(),
    });
    const env = runtimeEnvironment(this.environment, request.xiaoba, executionRoot, staged.roles_root, homeRoot);
    const commandResults: XiaoBaCommandResult[] = [];
    let roleManifest = "";
    let subjectManifest = "";
    try {
      const roleSnapshot = await this.executeBoundaryCommand(request.xiaoba, executionRoot, env, boundaryTrace,
        ["arena", "snapshot", "role", staged.selection.role.role_id], boundaryContext);
      commandResults.push(roleSnapshot);
      assertCommand(roleSnapshot, "xiaoba_subject_snapshot_failed", "Role snapshot failed.");
      roleManifest = findSubjectManifest(executionRoot, "role", staged.selection.role.role_id);

      if (staged.selection.mode === "role_skill") {
        const imported = await this.executeBoundaryCommand(request.xiaoba, executionRoot, env, boundaryTrace,
          ["arena", "import", "skill", staged.skill_path!], boundaryContext);
        commandResults.push(imported);
        assertCommand(imported, "xiaoba_subject_import_failed", "Skill import failed.");
        subjectManifest = findSubjectManifest(executionRoot, "skill", staged.selection.skill.name);
      } else {
        subjectManifest = roleManifest;
      }
      const subjectId = stringField(readJson<JsonRecord>(subjectManifest), "subject_id", "arena subject manifest");
      const args = arenaExecuteArgs(request, staged.selection, caseDefinition, subjectId, runId, seedRoot, deliveredPrompt);
      const executed = await this.executeBoundaryCommand(request.xiaoba, executionRoot, env, boundaryTrace, args, boundaryContext,
        caseDefinition.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      commandResults.push(executed);
      assertCommand(executed, commandReason(executed), "Arena execution failed.");
      const validated = validateArenaArtifacts({
        request,
        arm,
        selection: staged.selection,
        caseDefinition,
        executionRoot,
        runId,
        subjectId,
        roleManifest,
        subjectManifest,
      });
      const evidence = captureEvidence(attemptRoot, executionRoot, boundaryTrace, validated);
      const assertionsPassed = validated.assertions.every((assertion) => assertion.status === "pass");
      const status = validated.decision === "unsafe"
        ? "unsafe"
        : validated.decision === "blocked"
          ? "blocked"
          : validated.decision === "pass" && validated.stages_passed && assertionsPassed
            ? "pass"
            : "fail";
      const reasonCode: XiaoBaNativeReasonCode | undefined = status === "pass"
        ? undefined
        : !assertionsPassed
          ? "artifact_assertion_failed"
          : validated.decision === "unsafe"
            ? "xiaoba_arena_unsafe"
            : validated.decision === "blocked"
              ? "xiaoba_arena_blocked"
              : validated.decision === "unstable"
                ? "xiaoba_arena_unstable"
                : validated.decision === "reopened"
                  ? "xiaoba_arena_reopened"
                  : "unstable_result";
      return {
        arm,
        case_id: caseDefinition.case_id,
        purpose: caseDefinition.purpose,
        attempt,
        status,
        ...(reasonCode && { reason_code: reasonCode }),
        detail: status === "pass" ? "Native Arena and Barena artifact assertions passed." : `Native decision=${validated.decision}; assertions_passed=${assertionsPassed}.`,
        mode: staged.selection.mode,
        role_id: staged.selection.role.role_id,
        role_fingerprint: staged.selection.role.fingerprint,
        ...(staged.selection.mode === "role_skill" && {
          skill_name: staged.selection.skill.name,
          skill_fingerprint: staged.selection.skill.fingerprint,
        }),
        xiaoba_run_id: runId,
        execution_root: executionRoot,
        workspace_root: validated.workspace_root,
        subject_id: validated.subject_id,
        native_decision: validated.decision,
        process: processSummary(commandResults[commandResults.length - 1]),
        activation: {
          required: staged.selection.mode === "role_skill",
          ...(staged.selection.mode === "role_skill" && { expected_skill: staged.selection.skill.name }),
          observed: validated.activation_observed,
        },
        assertions: validated.assertions,
        refs: {
          boundary_trace: boundaryTrace,
          request_manifest: requestManifest,
          role_manifest: validated.role_manifest,
          subject_manifest: validated.subject_manifest,
          clean_runtime: validated.clean_runtime,
          arena_runner: validated.arena_runner,
          arena_scorecard: validated.arena_scorecard,
          arena_run: validated.arena_run,
          verifier: validated.verifier,
          native: validated.native_refs,
          evaluator: validated.evaluator_refs,
          debug: validated.debug_refs,
        },
        evidence,
      };
    } catch (error) {
      const failure = nativeError(error, "xiaoba_runner_failed");
      appendBoundary(boundaryTrace, boundaryContext, {
        kind: "runtime_status",
        message: failure.message,
        data: { status: "blocked", reason_code: failure.reason_code },
      });
      const blockedEvidence = captureBlockedBoundary(attemptRoot, boundaryTrace);
      return {
        ...blockedAttempt(request, arm, staged.selection, caseDefinition, attempt, executionRoot, boundaryTrace,
          failure.reason_code, failure.message, runId, processSummary(commandResults[commandResults.length - 1])),
        refs: {
          boundary_trace: boundaryTrace,
          request_manifest: requestManifest,
          ...(roleManifest && { role_manifest: roleManifest }),
          ...(subjectManifest && { subject_manifest: subjectManifest }),
          native: [], evaluator: [], debug: [],
        },
        evidence: blockedEvidence,
      };
    }
  }

  private async executeBoundaryCommand(
    config: XiaoBaNativeRuntimeConfig,
    cwd: string,
    env: NodeJS.ProcessEnv,
    tracePath: string,
    args: string[],
    context: BoundaryContext,
    timeoutMs = 30_000
  ): Promise<XiaoBaCommandResult> {
    appendBoundary(tracePath, context, { kind: "runtime_status", message: "Starting XiaoBa CLI command.", data: { command: [config.binary_path, ...args] } });
    const result = await this.commandRunner.run({
      command: path.resolve(config.binary_path), args, cwd, env, timeout_ms: timeoutMs, max_output_bytes: MAX_OUTPUT_BYTES,
    });
    appendBoundary(tracePath, context, {
      kind: "runtime_status",
      message: "XiaoBa CLI command completed.",
      data: {
        command: [config.binary_path, ...args], exit_code: result.exit_code, signal: result.signal,
        duration_ms: result.duration_ms, timed_out: result.timed_out, output_limit_exceeded: result.output_limit_exceeded,
      },
    });
    return result;
  }

  private writeResult(root: string, result: XiaoBaCapabilityEvaluationResultV1): XiaoBaCapabilityEvaluationResultV1 {
    const resultRef = path.join(root, "capability-evaluation.json");
    writeJson(resultRef, result);
    ensureDir(path.join(root, "reports"));
    writeJson(path.join(root, "reports", "report.json"), result);
    fs.writeFileSync(path.join(root, "reports", "report.md"), renderReport(result), "utf8");
    return result;
  }
}

export function probeXiaoBaNativeRuntime(
  config: XiaoBaNativeRuntimeConfig,
  dependencies: XiaoBaNativeRunnerDependencies = {}
): Promise<XiaoBaNativeProbeResult> {
  return new XiaoBaNativeEvaluationRunner(dependencies).probe(config);
}

export function runXiaoBaNativeEvaluation(
  input: RunXiaoBaNativeEvaluationInput,
  dependencies: XiaoBaNativeRunnerDependencies = {}
): Promise<XiaoBaCapabilityEvaluationResultV1> {
  return new XiaoBaNativeEvaluationRunner(dependencies).run(input);
}

function probeBase(config: XiaoBaNativeRuntimeConfig, checks: XiaoBaNativeProbeResult["checks"]): XiaoBaNativeProbeResult | undefined {
  const binary = path.resolve(config.binary_path);
  const projectRoot = path.resolve(config.project_root);
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    checks.push({ command: [binary, "--version"], exit_code: null, ok: false, detail: "Binary does not exist." });
    return blockedProbe(config, checks, "xiaoba_binary_not_found", `XiaoBa binary does not exist: ${binary}`);
  }
  const entrypoint = path.join(projectRoot, "dist", "index.js");
  if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) {
    checks.push({ command: [entrypoint], exit_code: null, ok: false, detail: "dist/index.js does not exist." });
    return blockedProbe(config, checks, "xiaoba_cli_contract_unavailable", `XiaoBa project root has no dist/index.js: ${projectRoot}`);
  }
  return undefined;
}

function blockedProbe(
  config: XiaoBaNativeRuntimeConfig,
  checks: XiaoBaNativeProbeResult["checks"],
  reason: XiaoBaNativeReasonCode,
  detail: string,
  version?: string
): XiaoBaNativeProbeResult {
  return {
    status: "blocked", reason_code: reason, binary_path: path.resolve(config.binary_path),
    project_root: path.resolve(config.project_root), ...(version && { version }),
    expected_version: XIAOBA_NATIVE_CONTRACT_VERSION, capabilities: probeCapabilities(), checks, detail,
  };
}

function probeCapabilities(): XiaoBaNativeProbeResult["capabilities"] {
  return {
    modes: ["base_skill", "role_skill", "role"],
    filesystem_artifacts_authoritative: true,
    sandbox_required: true,
    evaluator_stages_are_independent_agent_sessions: false,
    three_evaluator_agent_sessions: false,
    evaluator_target_process_isolated: false,
    network_disabled_is_hard_boundary: false,
  };
}

function probeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: source.PATH, HOME: source.HOME, TMPDIR: source.TMPDIR, NO_COLOR: "1", CI: "1" };
}

function runtimeEnvironment(
  source: NodeJS.ProcessEnv,
  config: XiaoBaNativeRuntimeConfig,
  executionRoot: string,
  rolesRoot: string,
  homeRoot: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: homeRoot,
    TMPDIR: path.join(homeRoot, "tmp"),
    XIAOBA_HOME: homeRoot,
    XIAOBA_PROJECT_ROOT: executionRoot,
    XIAOBA_ROLES_ROOT: rolesRoot,
    NO_COLOR: "1",
    CI: "1",
  };
  ensureDir(env.TMPDIR!);
  for (const name of config.pass_env) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

function validateRequest(request: XiaoBaCapabilityEvaluationRequestV1): void {
  if (request.schema !== "barena.xiaoba_capability_evaluation_request.v1" || request.target_runtime !== "xiaoba" || request.evaluator_runtime !== "xiaoba-cli") {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "Invalid XiaoBa capability evaluation request schema/runtime.");
  }
  assertSafeId(request.evaluation_id, "evaluation_id");
  if (request.xiaoba.expected_version !== XIAOBA_NATIVE_CONTRACT_VERSION) {
    throw new XiaoBaNativeError("xiaoba_version_unsupported", `Request must pin XiaoBa ${XIAOBA_NATIVE_CONTRACT_VERSION}.`);
  }
  if (!Number.isInteger(request.attempts_per_arm) || request.attempts_per_arm < 1 || request.attempts_per_arm > 11) {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "attempts_per_arm must be an integer from 1 to 11.");
  }
  if (!request.cases.length) throw new XiaoBaNativeError("xiaoba_request_invalid", "At least one case is required.");
  const caseIds = new Set<string>();
  for (const item of request.cases) {
    if (item.schema !== "barena.xiaoba_native_case.v1") throw new XiaoBaNativeError("xiaoba_request_invalid", "Invalid XiaoBa native case schema.");
    assertSafeId(item.case_id, "case_id");
    if (caseIds.has(item.case_id)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Duplicate case_id: ${item.case_id}`);
    caseIds.add(item.case_id);
    if (!item.task.prompt.trim()) throw new XiaoBaNativeError("xiaoba_request_invalid", `Case ${item.case_id} has an empty prompt.`);
    if (!item.assertions?.artifacts?.length) throw new XiaoBaNativeError("xiaoba_request_invalid", `Case ${item.case_id} requires at least one artifact assertion.`);
    for (const assertion of item.assertions.artifacts) safeRelative(assertion.path, "artifact assertion path");
    for (const fixture of item.fixtures ?? []) safeRelative(fixture.destination, "fixture destination");
    if (item.max_turns !== undefined && (!Number.isInteger(item.max_turns) || item.max_turns < 1)) throw new XiaoBaNativeError("xiaoba_request_invalid", "max_turns must be positive.");
    if (item.timeout_ms !== undefined && (!Number.isInteger(item.timeout_ms) || item.timeout_ms < 1000)) throw new XiaoBaNativeError("xiaoba_request_invalid", "timeout_ms must be at least 1000.");
  }
  for (const name of request.xiaoba.pass_env) if (!ENV_NAME.test(name)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Invalid pass_env name: ${name}`);
  validateRole(request.baseline.role);
  validateRole(request.candidate.role);
  if (request.capability_kind === "skill") {
    validateSkill(request.candidate.skill);
    if (request.baseline.mode !== "role" || request.candidate.mode !== "role_skill") throw new XiaoBaNativeError("xiaoba_request_invalid", "Skill evaluation requires role baseline and role_skill candidate.");
    if (request.baseline.role.role_id !== request.candidate.role.role_id || request.baseline.role.fingerprint !== request.candidate.role.fingerprint) {
      throw new XiaoBaNativeError("xiaoba_request_invalid", "Skill evaluation requires the same Role id and fingerprint in both arms.");
    }
  } else if (request.baseline.mode !== "role" || request.candidate.mode !== "role") {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "Role evaluation requires explicit role baseline and candidate.");
  }
}

function validateRole(role: XiaoBaNativeRoleSource): void {
  assertSafeId(role.role_id, "role_id");
  if (!FINGERPRINT.test(role.fingerprint)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Invalid Role fingerprint for ${role.role_id}.`);
}

function validateSkill(skill: XiaoBaNativeSkillSource): void {
  assertSafeId(skill.name, "skill name");
  if (!FINGERPRINT.test(skill.fingerprint)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Invalid Skill fingerprint for ${skill.name}.`);
}

function stageRequest(request: XiaoBaCapabilityEvaluationRequestV1, root: string): Record<XiaoBaNativeArm, StagedSelection> {
  const stage = (arm: XiaoBaNativeArm, selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection): StagedSelection => {
    const rolesRoot = path.join(root, "inputs", arm, "roles");
    const rolePath = path.join(rolesRoot, selection.role.role_id);
    stageDirectory(selection.role.source_path, rolePath, selection.role.fingerprint, `Role ${selection.role.role_id}`);
    const stagedSelection = { ...selection, role: { ...selection.role, source_path: rolePath } } as typeof selection;
    if (selection.mode === "role") return { selection: stagedSelection, roles_root: rolesRoot, role_path: rolePath };
    const skillPath = path.join(root, "inputs", arm, "skills", selection.skill.name);
    stageDirectory(selection.skill.source_path, skillPath, selection.skill.fingerprint, `Skill ${selection.skill.name}`);
    const skillMetadata = parseSkillMetadata(path.join(skillPath, "SKILL.md"));
    if (skillMetadata.name !== selection.skill.name) throw new XiaoBaNativeError("xiaoba_request_invalid", `Skill name mismatch: request=${selection.skill.name}, manifest=${skillMetadata.name}.`);
    preflightRoleSkill(rolePath, skillPath, selection.skill.name, skillMetadata.autoInvocable);
    return {
      selection: { ...stagedSelection, skill: { ...selection.skill, source_path: skillPath } } as XiaoBaNativeRoleSkillSelection,
      roles_root: rolesRoot, role_path: rolePath, skill_path: skillPath,
    };
  };
  return { baseline: stage("baseline", request.baseline), candidate: stage("candidate", request.candidate) };
}

function stageDirectory(sourceValue: string, destination: string, expectedFingerprint: string, label: string): void {
  const source = path.resolve(sourceValue);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new XiaoBaNativeError("xiaoba_source_copy_failed", `${label} source is not a directory: ${source}`);
  assertNoUnsafeEntries(source);
  const sourceFingerprint = hashDirectory(source);
  if (sourceFingerprint !== expectedFingerprint) throw new XiaoBaNativeError("xiaoba_source_fingerprint_mismatch", `${label} source fingerprint changed.`);
  copyDirectory(source, destination);
  const copiedFingerprint = hashDirectory(destination);
  if (copiedFingerprint !== expectedFingerprint) throw new XiaoBaNativeError("xiaoba_source_fingerprint_mismatch", `${label} immutable copy fingerprint differs.`);
  makeReadOnly(destination);
}

function makeReadOnly(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) makeReadOnly(full);
    else if (entry.isFile()) fs.chmodSync(full, 0o444);
  }
  fs.chmodSync(root, 0o555);
}

function assertNoUnsafeEntries(root: string): void {
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "output", "logs"].includes(entry.name)) continue;
      if (entry.name === ".env") throw new XiaoBaNativeError("xiaoba_source_copy_failed", `Source input may not contain .env: ${path.join(current, entry.name)}`);
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new XiaoBaNativeError("xiaoba_source_copy_failed", `Source input may not contain symlinks: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (!entry.isFile()) throw new XiaoBaNativeError("xiaoba_source_copy_failed", `Source input contains a non-regular entry: ${full}`);
    }
  };
  visit(root);
}

function preflightRoleSkill(rolePath: string, skillPath: string, skillName: string, autoInvocable: boolean): void {
  const configPath = path.join(rolePath, "role.json");
  if (!fs.existsSync(configPath)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Role has no role.json: ${rolePath}`);
  const config = readJson<JsonRecord>(configPath);
  if (config.inheritBaseSkills === false) throw new XiaoBaNativeError("xiaoba_role_skill_inheritance_unsupported", "Role has inheritBaseSkills=false; XiaoBa 0.1.1 would omit the candidate Skill.");
  if (!autoInvocable) throw new XiaoBaNativeError("xiaoba_skill_not_auto_invocable", "Paired Skill evaluation requires auto activation with the identical prompt in both arms.");
  const normalized = skillName.toLowerCase();
  const exclusions = Array.isArray(config.excludeBaseSkills) ? config.excludeBaseSkills.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
  const pathSegments = path.resolve(skillPath).split(path.sep).map((v) => v.toLowerCase());
  if (XIAOBA_011_DEFAULT_EXCLUDED_SKILLS.has(normalized) || exclusions.includes(normalized) || exclusions.some((item) => pathSegments.includes(item))) {
    throw new XiaoBaNativeError("xiaoba_skill_excluded", `XiaoBa 0.1.1 excludes candidate Skill ${skillName} for this Role.`);
  }
  const localSkills = path.join(rolePath, "skills");
  if (fs.existsSync(localSkills)) {
    for (const manifest of findFilesNamed(localSkills, "SKILL.md")) {
      if (parseSkillMetadata(manifest).name.toLowerCase() === normalized) {
        throw new XiaoBaNativeError("xiaoba_skill_name_collision", `Role-local Skill shadows candidate name ${skillName}.`);
      }
    }
  }
}

function parseSkillMetadata(manifestPath: string): { name: string; autoInvocable: boolean } {
  if (!fs.existsSync(manifestPath)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Skill has no SKILL.md: ${manifestPath}`);
  const text = fs.readFileSync(manifestPath, "utf8");
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) throw new XiaoBaNativeError("xiaoba_request_invalid", `Skill has no YAML frontmatter: ${manifestPath}`);
  const name = yamlScalar(frontmatter, "name");
  if (!name) throw new XiaoBaNativeError("xiaoba_request_invalid", `Skill frontmatter has no name: ${manifestPath}`);
  const claudeFormat = yamlScalar(frontmatter, "invocable") !== undefined || yamlScalar(frontmatter, "autoInvocable") !== undefined;
  const autoValue = claudeFormat ? yamlScalar(frontmatter, "autoInvocable") : yamlScalar(frontmatter, "auto-invocable");
  const invocable = yamlScalar(frontmatter, "invocable");
  return { name, autoInvocable: autoValue !== "false" && (!claudeFormat || invocable !== "user") };
}

function yamlScalar(frontmatter: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = frontmatter.match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "m"))?.[1]?.trim();
  if (!raw) return undefined;
  return raw.replace(/^['"]|['"]$/g, "");
}

function bindDist(projectRootValue: string, executionRoot: string): void {
  const source = path.resolve(projectRootValue, "dist");
  const entrypoint = path.join(source, "index.js");
  if (!fs.existsSync(entrypoint)) throw new XiaoBaNativeError("xiaoba_cli_contract_unavailable", `XiaoBa dist entrypoint is missing: ${entrypoint}`);
  const destination = path.join(executionRoot, "dist");
  fs.symlinkSync(source, destination, "dir");
  if (path.resolve(fs.realpathSync(destination)) !== path.resolve(fs.realpathSync(source))) throw new XiaoBaNativeError("xiaoba_execution_root_invalid", "XiaoBa dist binding did not resolve to the pinned project root.");
}

function materializeFixtures(caseDefinition: XiaoBaNativeCaseV1, seedRoot: string): void {
  for (const fixture of caseDefinition.fixtures ?? []) {
    const source = path.resolve(fixture.source_path);
    const destination = path.join(seedRoot, safeRelative(fixture.destination, "fixture destination"));
    if (!fs.existsSync(source)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Fixture source does not exist: ${source}`);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new XiaoBaNativeError("xiaoba_request_invalid", `Fixture source may not be a symlink: ${source}`);
    ensureDir(path.dirname(destination));
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  }
}

function arenaExecuteArgs(
  request: XiaoBaCapabilityEvaluationRequestV1,
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection,
  item: XiaoBaNativeCaseV1,
  subjectId: string,
  runId: string,
  seedRoot: string,
  prompt: string
): string[] {
  const args = [
    "arena", "run", "execute", "--mode", selection.mode, "--subject", subjectId,
    "--target-role", selection.role.role_id, "--run-id", runId,
    "--surface", request.xiaoba.surface ?? "pet", "--workspace-seed", seedRoot,
    "--scenario", item.scenario ?? `${item.purpose}:${item.case_id}`,
    "--message", prompt, "--max-turns", String(item.max_turns ?? 4), "--scenario-count", "1",
    "--replay-attempts", String(item.replay_attempts ?? 1),
    "--max-replay-cases", String(item.max_replay_cases ?? 1),
    "--timeout-ms", String(item.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    "--sandbox-mode", "workspace_write", "--network", "disabled",
  ];
  if (request.xiaoba.sandbox_engine) args.push("--sandbox-engine", request.xiaoba.sandbox_engine);
  for (const name of request.xiaoba.pass_env) args.push("--pass-env", name);
  return args;
}

function findSubjectManifest(executionRoot: string, type: "skill" | "role", name: string): string {
  const root = path.join(executionRoot, "arena", "subjects");
  const matches = fs.existsSync(root) ? findFilesNamed(root, "arena-manifest.json").filter((file) => {
    const manifest = readJson<JsonRecord>(file);
    const subject = recordField(manifest, "subject", "arena subject manifest");
    if (subject.type !== type) return false;
    if (type === "role") return recordField(manifest, "role", "arena role manifest").id === name;
    return subject.name === name;
  }) : [];
  if (matches.length !== 1) throw new XiaoBaNativeError(type === "role" ? "xiaoba_subject_snapshot_failed" : "xiaoba_subject_import_failed", `Expected exactly one ${type} manifest for ${name}, found ${matches.length}.`);
  return matches[0];
}

function validateArenaArtifacts(input: {
  request: XiaoBaCapabilityEvaluationRequestV1;
  arm: XiaoBaNativeArm;
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection;
  caseDefinition: XiaoBaNativeCaseV1;
  executionRoot: string;
  runId: string;
  subjectId: string;
  roleManifest: string;
  subjectManifest: string;
}): ValidatedArenaArtifacts {
  const runRoot = path.join(input.executionRoot, "arena", "runs", input.runId);
  const cleanRuntime = requiredFile(path.join(runRoot, "clean-runtime.json"), "xiaoba_scorecard_missing");
  const arenaRunner = requiredFile(path.join(runRoot, "arena-runner.json"), "xiaoba_scorecard_missing");
  const arenaScorecard = requiredFile(path.join(runRoot, "arena-scorecard.json"), "xiaoba_scorecard_missing");
  const arenaRun = requiredFile(path.join(runRoot, "arena-run.json"), "xiaoba_scorecard_invalid");
  const runtime = readJson<JsonRecord>(cleanRuntime);
  const runner = readJson<JsonRecord>(arenaRunner);
  const scorecard = readJson<JsonRecord>(arenaScorecard);
  const run = readJson<JsonRecord>(arenaRun);
  assertIdentity(runtime, input.runId, input.selection.mode, input.subjectId, "clean-runtime.json");
  assertIdentity(scorecard, input.runId, input.selection.mode, input.subjectId, "arena-scorecard.json", true);
  assertIdentity(run, input.runId, input.selection.mode, input.subjectId, "arena-run.json");
  if (runner.run_id !== input.runId || runner.sandbox_enforced !== true) throw new XiaoBaNativeError("xiaoba_sandbox_unavailable", "arena-runner.json does not prove sandbox enforcement.");
  if (scorecard.scorecard_type !== "arena" || scorecard.arena_run_error !== undefined) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", "Arena scorecard type/error contract is invalid.");
  const sandbox = recordField(scorecard, "sandbox", "arena scorecard");
  if (sandbox.enforced !== true) throw new XiaoBaNativeError("xiaoba_sandbox_unavailable", "Arena scorecard does not prove sandbox.enforced=true.");
  const targetProfile = recordField(scorecard, "target_profile", "arena scorecard");
  if (targetProfile.active_role_id !== input.selection.role.role_id) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", "Arena target Role does not match the requested Role.");
  const roots = recordField(runtime, "roots", "clean runtime");
  for (const key of ["run_root", "home_root", "skills_root", "roles_root", "workspace_root", "tmp_root"]) {
    assertInside(input.executionRoot, stringField(roots, key, "clean runtime roots"), `clean runtime ${key}`);
  }
  const runtimeManifestValue = stringField(runtime, "subject_manifest_path", "clean runtime");
  const runtimeManifest = path.isAbsolute(runtimeManifestValue)
    ? path.resolve(runtimeManifestValue)
    : path.resolve(input.executionRoot, runtimeManifestValue);
  assertInside(input.executionRoot, runtimeManifest, "clean runtime subject_manifest_path");
  if (runtimeManifest !== path.resolve(input.subjectManifest)) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", "Clean runtime subject manifest does not match the imported subject.");
  const decision = scorecard.decision;
  if (!["pass", "unstable", "reopened", "blocked", "unsafe"].includes(String(decision))) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `Invalid native decision: ${String(decision)}`);
  const stages = recordField(scorecard, "stages", "arena scorecard");
  const stageNames = ["usercat", "inspector", "reviewer"];
  const stagesPassed = stageNames.every((name) => recordField(stages, name, `stage ${name}`).status === "pass");
  for (const name of stageNames) {
    const status = recordField(stages, name, `stage ${name}`).status;
    if (!["pass", "fail", "blocked"].includes(String(status))) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `Invalid ${name} stage status.`);
  }
  const evidence = recordField(scorecard, "evidence", "arena scorecard");
  const nativeRefs = stringArray(evidence.trace_refs, "evidence.trace_refs")
    .map((ref) => resolveRunRef(input.executionRoot, ref, "xiaoba_native_trace_missing"));
  nativeRefs.push(...stringArray(evidence.replay_trace_refs ?? [], "evidence.replay_trace_refs")
    .map((ref) => resolveRunRef(input.executionRoot, ref, "xiaoba_native_trace_missing")));
  if (nativeRefs.length === 0) throw new XiaoBaNativeError("xiaoba_native_trace_missing", "Arena scorecard contains no native target trace refs.");
  const debug = recordField(scorecard, "debug_refs", "arena scorecard");
  const evaluatorRaw = [
    debug.usercat_package,
    ...(Array.isArray(debug.usercat_packages) ? debug.usercat_packages : []),
    debug.inspector_analysis,
    debug.inspector_cases,
    debug.reviewer_scorecard,
    debug.reviewer_report,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const required of [debug.usercat_package, debug.inspector_analysis, debug.inspector_cases, debug.reviewer_scorecard, debug.reviewer_report]) {
    if (typeof required !== "string" || !required) throw new XiaoBaNativeError("xiaoba_stage_evidence_missing", "Arena scorecard is missing required evaluator-stage debug refs.");
  }
  const evaluatorRefs = [...new Set(evaluatorRaw.map((ref) => resolveRunRef(input.executionRoot, ref)))];
  const debugRefs = [cleanRuntime, arenaRunner, arenaScorecard, arenaRun, input.roleManifest, input.subjectManifest];
  const expectedSkill = input.request.capability_kind === "skill"
    ? input.request.candidate.skill.name
    : input.selection.mode === "role_skill" ? input.selection.skill.name : undefined;
  const activationObserved = traceActivation(nativeRefs, expectedSkill);
  if (input.selection.mode === "role_skill" && !activationObserved) throw new XiaoBaNativeError("xiaoba_skill_not_activated", `Native traces do not prove activation of ${input.selection.skill.name}.`);
  if (input.selection.mode === "role" && input.request.capability_kind === "skill" && activationObserved) throw new XiaoBaNativeError("xiaoba_baseline_skill_leak", "Baseline native trace activated the candidate Skill.");
  const workspaceRoot = stringField(roots, "workspace_root", "clean runtime roots");
  assertInside(input.executionRoot, workspaceRoot, "workspace_root");
  const assertions = verifyAssertions(input.caseDefinition.assertions.artifacts, workspaceRoot);
  const verifierPath = path.join(path.dirname(input.executionRoot), "verifier", "artifact-assertions.json");
  writeJson(verifierPath, assertions);
  return {
    subject_id: input.subjectId, workspace_root: workspaceRoot, decision: decision as XiaoBaNativeDecision,
    activation_observed: activationObserved, assertions, role_manifest: input.roleManifest,
    subject_manifest: input.subjectManifest, clean_runtime: cleanRuntime, arena_runner: arenaRunner,
    arena_scorecard: arenaScorecard, arena_run: arenaRun, verifier: verifierPath,
    native_refs: [...new Set(nativeRefs)], evaluator_refs: evaluatorRefs, debug_refs: debugRefs, stages_passed: stagesPassed,
  };
}

function traceActivation(traceRefs: string[], expectedSkill?: string): boolean {
  let observed = false;
  let traceEntries = 0;
  for (const ref of traceRefs) {
    requiredFile(ref, "xiaoba_native_trace_missing");
    for (const line of fs.readFileSync(ref, "utf8").split(/\r?\n/).filter(Boolean)) {
      let entry: JsonRecord;
      try { entry = JSON.parse(line) as JsonRecord; } catch { throw new XiaoBaNativeError("xiaoba_native_trace_missing", `Native trace is not valid NDJSON: ${ref}`); }
      if (entry.schema_version !== 3 || entry.entry_type !== "trace") continue;
      traceEntries += 1;
      const visibility = Array.isArray(entry.tool_visibility) ? entry.tool_visibility : [];
      if (expectedSkill && visibility.some((item) => isRecord(item) && item.activeSkillName === expectedSkill)) observed = true;
    }
  }
  if (traceEntries === 0) throw new XiaoBaNativeError("xiaoba_native_trace_missing", "No session-log-v3 trace entries were found.");
  return observed;
}

function verifyAssertions(assertions: XiaoBaNativeArtifactAssertion[], workspace: string): ArtifactAssertionResult[] {
  return assertions.map((assertion) => {
    const relative = safeRelative(assertion.path, "artifact assertion path");
    const artifact = path.join(workspace, relative);
    assertInside(workspace, artifact, "artifact assertion path");
    const expected = assertion.exists ?? true;
    const exists = fs.existsSync(artifact) && fs.statSync(artifact).isFile();
    if (exists !== expected) return { path: relative, status: "fail", detail: expected ? "Expected artifact does not exist." : "Artifact exists but was expected to be absent." };
    if (!exists || assertion.contains === undefined) return { path: relative, status: "pass", detail: "Artifact existence matched the assertion." };
    return fs.readFileSync(artifact, "utf8").includes(assertion.contains)
      ? { path: relative, status: "pass", detail: "Artifact contains the expected text." }
      : { path: relative, status: "fail", detail: "Artifact does not contain the expected text." };
  });
}

function captureEvidence(attemptRoot: string, executionRoot: string, boundary: string, validated: ValidatedArenaArtifacts): XiaoBaEvidenceCopy[] {
  const copies: XiaoBaEvidenceCopy[] = [];
  const add = (layer: XiaoBaEvidenceCopy["layer"], component: string, source: string): void => {
    if (layer === "native" || layer === "evaluator" || layer === "debug") assertInside(executionRoot, source, `${layer} evidence ref`);
    requiredPath(source, layer === "native" ? "xiaoba_native_trace_missing" : "xiaoba_artifact_ref_invalid");
    const index = copies.length + 1;
    const destination = path.join(attemptRoot, "evidence", layer, `${String(index).padStart(3, "0")}-${path.basename(source)}`);
    ensureDir(path.dirname(destination));
    const stat = fs.statSync(source);
    fs.cpSync(source, destination, { recursive: stat.isDirectory() });
    copies.push({ layer, component, source_ref: source, copied_ref: destination, kind: stat.isDirectory() ? "directory" : "file", sha256: hashPath(destination) });
  };
  add("boundary", "barena", boundary);
  add("verifier", "barena-artifact-verifier", validated.verifier);
  for (const ref of validated.native_refs) add("native", "xiaoba-target-agent-session", ref);
  for (const ref of validated.evaluator_refs) add("evaluator", "xiaoba-arena-stage", ref);
  for (const ref of validated.debug_refs) add("debug", "xiaoba-arena", ref);
  writeJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies);
  return copies;
}

function captureBlockedBoundary(attemptRoot: string, boundary: string): XiaoBaEvidenceCopy[] {
  if (!fs.existsSync(boundary) || !fs.statSync(boundary).isFile()) return [];
  const destination = path.join(attemptRoot, "evidence", "boundary", `001-${path.basename(boundary)}`);
  ensureDir(path.dirname(destination));
  fs.copyFileSync(boundary, destination);
  const evidence: XiaoBaEvidenceCopy[] = [{
    layer: "boundary",
    component: "barena",
    source_ref: boundary,
    copied_ref: destination,
    kind: "file",
    sha256: hashPath(destination),
  }];
  writeJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), evidence);
  return evidence;
}

function hashPath(value: string): string {
  if (fs.statSync(value).isDirectory()) return hashDirectory(value);
  return crypto.createHash("sha256").update(fs.readFileSync(value)).digest("hex");
}

function aggregateResult(
  request: XiaoBaCapabilityEvaluationRequestV1,
  requestRef: string,
  probe: XiaoBaNativeProbeResult,
  baselineAttempts: XiaoBaNativeAttemptResult[],
  candidateAttempts: XiaoBaNativeAttemptResult[],
  now: Date
): XiaoBaCapabilityEvaluationResultV1 {
  const planned = request.cases.length * request.attempts_per_arm;
  const baseline = aggregateArm(request.baseline, baselineAttempts, planned);
  const candidate = aggregateArm(request.candidate, candidateAttempts, planned);
  const complete = armComplete(baseline) && armComplete(candidate);
  const lift = complete && baseline.pass_rate.value !== null && candidate.pass_rate.value !== null
    ? candidate.pass_rate.value - baseline.pass_rate.value : null;
  const effectiveness = lift === null ? "unavailable" : lift > 0 ? "improved" : lift < 0 ? "regressed" : "no_effect";
  const evidenceComplete = baseline.evidence_complete && candidate.evidence_complete;
  const regression = effectiveness === "regressed" || hasCaseRegression(baselineAttempts, candidateAttempts);
  const verdict = decideResult(baseline, candidate, evidenceComplete, effectiveness, regression);
  const all = [...baselineAttempts, ...candidateAttempts];
  const verifierBacked = all.filter((item) => item.assertions.length > 0).length;
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1", evaluation_id: request.evaluation_id,
    created_at: now.toISOString(), request_ref: requestRef, capability_kind: request.capability_kind,
    decision: verdict.decision, reason_code: verdict.reason, summary: verdict.summary, probe,
    outcome_truth: {
      status: verifierBacked === 0 ? "unverified" : verifierBacked === planned * 2 ? "verified" : "partially_verified",
      verifier_backed_attempts: verifierBacked, total_planned_attempts: planned * 2,
    },
    effectiveness: {
      status: effectiveness, baseline_pass_rate: baseline.pass_rate,
      candidate_pass_rate: candidate.pass_rate, observed_lift: lift,
    },
    quality: {
      baseline: baseline.stability, candidate: candidate.stability,
      required_evidence_complete: evidenceComplete,
      evaluator_stages_are_independent_agent_sessions: false,
      three_evaluator_agent_sessions: false,
      isolation: {
        sandbox_enforced_for_completed_attempts:
          all.some((item) => item.status !== "blocked") &&
          all.filter((item) => item.status !== "blocked").every((item) => Boolean(item.refs.arena_runner)),
        evaluator_target_process_isolated: false,
        network_disabled_is_hard_boundary: false,
      },
    },
    baseline, candidate,
    evidence_refs: [...new Set(all.flatMap((item) => item.evidence.map((entry) => entry.copied_ref)))],
    debug_refs: [...new Set(all.flatMap((item) => item.refs.debug))],
  };
}

function aggregateArm(
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection,
  attempts: XiaoBaNativeAttemptResult[],
  planned: number
): XiaoBaNativeArmResult {
  const counts: XiaoBaNativeAttemptCounts = { planned, pass: 0, fail: 0, blocked: 0, unsafe: 0 };
  for (const attempt of attempts) counts[attempt.status] += 1;
  const denominator = counts.pass + counts.fail + counts.unsafe;
  const passRate: XiaoBaNativeObservedRate = { numerator: counts.pass, denominator, value: denominator ? counts.pass / denominator : null };
  const evidenceComplete = attempts.length === planned && attempts.every((item) =>
    item.evidence.some((entry) => entry.layer === "boundary") &&
    item.evidence.some((entry) => entry.layer === "native") &&
    item.evidence.some((entry) => entry.layer === "evaluator") &&
    item.evidence.some((entry) => entry.layer === "verifier")
  );
  return { selection, counts, pass_rate: passRate, stability: stability(counts), evidence_complete: evidenceComplete, attempts };
}

function stability(counts: XiaoBaNativeAttemptCounts): XiaoBaNativeArmResult["stability"] {
  if (counts.unsafe) return "unsafe";
  if (counts.blocked) return "blocked";
  const observed = counts.pass + counts.fail + counts.unsafe + counts.blocked;
  if (observed !== counts.planned || counts.planned === 0) return "incomplete";
  if (counts.pass && counts.fail) return "flaky";
  return counts.pass === counts.planned ? "stable_pass" : "stable_failure";
}

function armComplete(arm: XiaoBaNativeArmResult): boolean {
  return arm.counts.blocked === 0 && arm.attempts.length === arm.counts.planned && arm.counts.planned > 0;
}

function decideResult(
  baseline: XiaoBaNativeArmResult,
  candidate: XiaoBaNativeArmResult,
  evidenceComplete: boolean,
  effectiveness: XiaoBaCapabilityEvaluationResultV1["effectiveness"]["status"],
  regression: boolean
): { decision: XiaoBaCapabilityEvaluationResultV1["decision"]; reason: XiaoBaNativeReasonCode; summary: string } {
  if (candidate.stability === "unsafe") return { decision: "rejected", reason: "unsafe_candidate", summary: "Candidate produced an unsafe native attempt." };
  if (regression) return { decision: "rejected", reason: "capability_regression", summary: "Candidate regressed verifier-backed outcomes for at least one paired case." };
  const blocked = [...candidate.attempts, ...baseline.attempts].find((item) => item.status === "blocked");
  if (blocked) return { decision: "held", reason: blocked.reason_code ?? "xiaoba_runner_failed", summary: blocked.detail };
  if (!evidenceComplete) return { decision: "held", reason: "evidence_incomplete", summary: "Required boundary, native, evaluator-stage, or verifier evidence is incomplete." };
  if ([baseline.stability, candidate.stability].some((value) => value === "flaky" || value === "incomplete")) return { decision: "held", reason: "unstable_result", summary: "At least one paired arm is flaky or incomplete." };
  if (effectiveness === "no_effect") return { decision: "held", reason: "no_effect", summary: "Candidate did not improve verifier-backed outcomes over baseline." };
  if (effectiveness === "improved" && candidate.stability === "stable_pass") return { decision: "cleared", reason: "positive_lift", summary: "Candidate produced a stable, verifier-backed improvement over baseline." };
  return { decision: "held", reason: "unstable_result", summary: "Observed improvement was not stable enough to clear." };
}

function hasCaseRegression(baseline: XiaoBaNativeAttemptResult[], candidate: XiaoBaNativeAttemptResult[]): boolean {
  for (const caseId of new Set(baseline.map((item) => item.case_id))) {
    const before = passRate(baseline.filter((item) => item.case_id === caseId));
    const after = passRate(candidate.filter((item) => item.case_id === caseId));
    if (before !== null && after !== null && after < before) return true;
  }
  return false;
}

function passRate(attempts: XiaoBaNativeAttemptResult[]): number | null {
  if (!attempts.length || attempts.some((item) => item.status === "blocked")) return null;
  return attempts.filter((item) => item.status === "pass").length / attempts.length;
}

function blockedResult(
  request: XiaoBaCapabilityEvaluationRequestV1,
  requestRef: string,
  probe: XiaoBaNativeProbeResult,
  reason: XiaoBaNativeReasonCode,
  summary: string
): XiaoBaCapabilityEvaluationResultV1 {
  const planned = request.cases.length * request.attempts_per_arm;
  const empty = (selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection): XiaoBaNativeArmResult => ({
    selection, counts: { planned, pass: 0, fail: 0, blocked: planned, unsafe: 0 },
    pass_rate: { numerator: 0, denominator: 0, value: null }, stability: "blocked", evidence_complete: false, attempts: [],
  });
  const rate = { numerator: 0, denominator: 0, value: null };
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1", evaluation_id: request.evaluation_id,
    created_at: new Date().toISOString(), request_ref: requestRef, capability_kind: request.capability_kind,
    decision: "held", reason_code: reason, summary, probe,
    outcome_truth: { status: "unverified", verifier_backed_attempts: 0, total_planned_attempts: planned * 2 },
    effectiveness: { status: "unavailable", baseline_pass_rate: rate, candidate_pass_rate: rate, observed_lift: null },
    quality: {
      baseline: "blocked", candidate: "blocked", required_evidence_complete: false,
      evaluator_stages_are_independent_agent_sessions: false,
      three_evaluator_agent_sessions: false,
      isolation: {
        sandbox_enforced_for_completed_attempts: false,
        evaluator_target_process_isolated: false,
        network_disabled_is_hard_boundary: false,
      },
    },
    baseline: empty(request.baseline), candidate: empty(request.candidate), evidence_refs: [], debug_refs: [],
  };
}

function blockedAttempt(
  request: XiaoBaCapabilityEvaluationRequestV1,
  arm: XiaoBaNativeArm,
  selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection,
  caseDefinition: XiaoBaNativeCaseV1,
  attempt: number,
  executionRoot: string,
  boundaryTrace: string,
  reason: XiaoBaNativeReasonCode,
  detail: string,
  runId = "not-started",
  process = processSummary(undefined)
): XiaoBaNativeAttemptResult {
  return {
    arm, case_id: caseDefinition.case_id, purpose: caseDefinition.purpose, attempt, status: "blocked",
    reason_code: reason, detail, mode: selection.mode, role_id: selection.role.role_id,
    role_fingerprint: selection.role.fingerprint,
    ...(selection.mode === "role_skill" && { skill_name: selection.skill.name, skill_fingerprint: selection.skill.fingerprint }),
    xiaoba_run_id: runId, execution_root: executionRoot, process,
    activation: { required: selection.mode === "role_skill", ...(selection.mode === "role_skill" && { expected_skill: selection.skill.name }), observed: false },
    assertions: [], refs: { boundary_trace: boundaryTrace, request_manifest: path.join(path.dirname(boundaryTrace), "..", "request-manifest.json"), native: [], evaluator: [], debug: [] }, evidence: [],
  };
}

function processSummary(result: XiaoBaCommandResult | undefined): XiaoBaNativeAttemptResult["process"] {
  return result ? { exit_code: result.exit_code, signal: result.signal, duration_ms: result.duration_ms, timed_out: result.timed_out }
    : { exit_code: null, signal: null, duration_ms: 0, timed_out: false };
}

function commandReason(result: XiaoBaCommandResult): XiaoBaNativeReasonCode {
  if (result.timed_out) return "xiaoba_timeout";
  const text = `${result.stdout}\n${result.stderr}`;
  if (/provider|\.env not found|API key/i.test(text)) return "xiaoba_provider_unconfigured";
  if (/sandbox|seatbelt|bubblewrap/i.test(text)) return "xiaoba_sandbox_unavailable";
  return "xiaoba_runner_failed";
}

function assertCommand(result: XiaoBaCommandResult, reason: XiaoBaNativeReasonCode, label: string): void {
  if (result.exit_code !== 0 || result.timed_out || result.output_limit_exceeded || result.error) {
    const detail = result.error ?? result.stderr.trim().slice(0, 800) ?? "unknown error";
    throw new XiaoBaNativeError(reason, `${label} ${detail}`.trim());
  }
}

function assertIdentity(
  value: JsonRecord,
  runId: string,
  mode: string,
  subjectId: string,
  label: string,
  arenaScorecard = false
): void {
  const observedRunId = arenaScorecard ? value.arena_run_id : value.run_id;
  if (observedRunId !== runId || value.review_mode !== mode || value.subject_id !== subjectId) {
    throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `${label} run/mode/subject identity mismatch.`);
  }
}

function requiredFile(value: string, reason: XiaoBaNativeReasonCode): string {
  if (!fs.existsSync(value) || !fs.statSync(value).isFile()) throw new XiaoBaNativeError(reason, `Required file is missing: ${value}`);
  return value;
}

function requiredPath(value: string, reason: XiaoBaNativeReasonCode): string {
  if (!fs.existsSync(value)) throw new XiaoBaNativeError(reason, `Required evidence path is missing: ${value}`);
  return value;
}

function resolveRunRef(
  root: string,
  value: string,
  reason: XiaoBaNativeReasonCode = "xiaoba_artifact_ref_invalid"
): string {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  assertInside(root, resolved, "Arena evidence ref");
  requiredPath(resolved, reason);
  return resolved;
}

function assertInside(root: string, value: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} escapes its allowed root: ${value}`);
  }
}

function safeRelative(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} must be a non-empty relative path.`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} must stay inside the workspace.`);
  return normalized;
}

function assertSafeId(value: string, label: string): void {
  if (!value?.trim() || !SAFE_ID.test(value)) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} must contain only letters, numbers, dot, underscore, or dash.`);
}

function safeRunId(evaluationId: string, arm: string, caseId: string, attempt: number, nonce: string): string {
  return ["barena", evaluationId, arm, caseId, String(attempt), nonce].join("-").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180);
}

function findFilesNamed(root: string, name: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findFilesNamed(full, name));
    else if (entry.isFile() && entry.name === name) files.push(full);
  }
  return files.sort();
}

function appendBoundary(filePath: string, context: BoundaryContext, event: { kind: string; message: string; data?: JsonRecord }): void {
  appendNdjson(filePath, [{
    timestamp: new Date().toISOString(), run_id: context.run_id, case_id: context.case_id,
    attempt_id: context.attempt_id, kind: event.kind, message: event.message,
    provenance: { recorded_by: "barena", layer: "boundary", observed_from: "target_process", component: "xiaoba-native-arena" },
    ...(event.data && { data: event.data }),
  }]);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: JsonRecord, key: string, label: string): JsonRecord {
  const result = value[key];
  if (!isRecord(result)) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `${label}.${key} must be an object.`);
  return result;
}

function stringField(value: JsonRecord, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `${label}.${key} must be a non-empty string.`);
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new XiaoBaNativeError("xiaoba_scorecard_invalid", `${label} must be a string array.`);
  return value;
}

function nativeError(error: unknown, fallback: XiaoBaNativeReasonCode): XiaoBaNativeError {
  return error instanceof XiaoBaNativeError ? error : new XiaoBaNativeError(fallback, error instanceof Error ? error.message : String(error));
}

function renderReport(result: XiaoBaCapabilityEvaluationResultV1): string {
  const percent = (value: number | null): string => value === null ? "unavailable" : `${Math.round(value * 100)}%`;
  return [
    `# Barena XiaoBa ${result.capability_kind} evaluation`, "",
    `- Decision: ${result.decision}`, `- Reason: ${result.reason_code}`,
    `- Truth: ${result.outcome_truth.status}`,
    `- Baseline pass rate: ${percent(result.effectiveness.baseline_pass_rate.value)}`,
    `- Candidate pass rate: ${percent(result.effectiveness.candidate_pass_rate.value)}`,
    `- Observed lift: ${percent(result.effectiveness.observed_lift)}`,
    `- Required evidence complete: ${result.quality.required_evidence_complete}`,
    `- Independent evaluator AgentSessions: no (XiaoBa 0.1.1 contract)`, "", result.summary, "",
  ].join("\n");
}
