import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { renderXiaoBaCapabilityReport } from "../reports/run-renderers";
import { appendNdjson, ensureDir, hashDirectory, readJson, writeJson } from "../utils/fs";
import { verifyArtifactContent } from "../verifier/artifact-verifier";
import type { ArtifactAssertionResult } from "../e2e/types";
import {
  prepareStaticAdmission,
  type PreparedStaticAdmissionSubject,
  type StaticAdmissionReportV1,
  type StaticAdmissionSubjectInput,
} from "./static-admission";
import {
  sanitizeCopyToRetention,
  sanitizeTextForRetention,
  scanRetainedTreeForSecrets,
  writeSanitizedJson,
  type EvidenceRedactionContext,
} from "./evidence-redaction";
import {
  collectLiveSecretValues,
  estimatedUsageCostUsd,
  evaluateXiaoBaLivePreflight,
  validateXiaoBaLivePolicyBinding,
  validateXiaoBaLiveRuntimeContract,
} from "./live-policy";
import {
  RunXiaoBaNativeEvaluationInput,
  XIAOBA_NATIVE_CONTRACT_VERSION,
  XIAOBA_NATIVE_CONTRACT_VERSIONS,
  XiaoBaAggregateUsage,
  XiaoBaAttemptRedaction,
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaCapabilityEvaluationResultV1,
  XiaoBaCommandRequest,
  XiaoBaCommandResult,
  XiaoBaCommandRunner,
  XiaoBaEvidenceCopy,
  XiaoBaLivePolicyBinding,
  XiaoBaLivePolicyPreflight,
  XiaoBaLivePolicyV1,
  XiaoBaLiveRuntimeContractV1,
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
  XiaoBaObservedUsage,
  XiaoBaProviderCallRecord,
  XiaoBaProviderIdentityEvidence,
  XiaoBaRedactionSummary,
  XiaoBaNativeRoleSelection,
  XiaoBaNativeRoleSource,
  XiaoBaNativeRoleSkillSelection,
  XiaoBaNativeRunnerDependencies,
  XiaoBaNativeRuntimeConfig,
  XiaoBaNativeSkillSource,
  isXiaoBaNativeContractVersion,
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
const PROVIDER_CALL_COMPONENTS = new Set(["target", "usercat", "inspector", "reviewer", "replay"]);
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
  observation: XiaoBaTraceObservation;
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

interface XiaoBaTraceObservation {
  activation_observed: boolean;
  trace_entries: number;
  provider_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  observed_providers: string[];
  observed_models: string[];
  usage_evidence_refs: string[];
  identity_evidence_refs: string[];
  missing_usage_fields: string[];
}

interface XiaoBaProviderCallObservation {
  records: XiaoBaProviderCallRecord[];
  raw_call_count: number;
  observed_providers: string[];
  observed_models: string[];
  identity_errors: string[];
  errors: string[];
  evidence_refs: string[];
}

interface LiveExecutionLedger {
  planned_barena_attempts: number;
  planned_provider_calls: number;
  observed_barena_attempts: number;
  consumed_provider_call_reservation: number;
  call_records: XiaoBaProviderCallRecord[];
  model_invoked: boolean | null;
}

interface LiveExecutionContext {
  binding: XiaoBaLivePolicyBinding;
  policy: XiaoBaLivePolicyV1;
  preflight: XiaoBaLivePolicyPreflight;
  redaction: EvidenceRedactionContext;
  runtime_contract: XiaoBaLiveRuntimeContractV1;
  ledger: LiveExecutionLedger;
}

interface LiveArmFailure {
  reason: XiaoBaNativeReasonCode;
  summary: string;
}

interface RunArmOutcome {
  attempts: XiaoBaNativeAttemptResult[];
  failure?: LiveArmFailure;
}

interface CapturedAttemptEvidence {
  copies: XiaoBaEvidenceCopy[];
  refs: XiaoBaNativeAttemptResult["refs"];
  redaction: XiaoBaAttemptRedaction;
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
  private readonly scratchRootFactory: (prefix: string) => string;
  private readonly scratchCleanup: (scratchRoot: string) => void;

  constructor(dependencies: XiaoBaNativeRunnerDependencies = {}) {
    this.commandRunner = dependencies.command_runner ?? new NodeXiaoBaCommandRunner();
    this.environment = dependencies.environment ?? process.env;
    this.now = dependencies.now ?? (() => new Date());
    this.nonce = dependencies.nonce ?? (() => crypto.randomBytes(4).toString("hex"));
    this.scratchRootFactory = dependencies.scratch_root_factory ?? ((prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    this.scratchCleanup = dependencies.scratch_cleanup ?? removeOwnedScratchRoot;
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
      if (!ok) return blockedProbe(config, checks, "xiaoba_cli_contract_unavailable", "Required XiaobaOS Arena CLI help contract is unavailable.", version);
    }
    if (!isXiaoBaNativeContractVersion(config.expected_version) || version !== config.expected_version) {
      return blockedProbe(
        config,
        checks,
        "xiaoba_version_unsupported",
        `Expected XiaobaOS ${config.expected_version}; supported versions are ${XIAOBA_NATIVE_CONTRACT_VERSIONS.join(", ")}; observed ${version ?? "unknown"}.`,
        version
      );
    }
    return {
      status: "ready",
      binary_path: path.resolve(config.binary_path),
      project_root: path.resolve(config.project_root),
      version,
      expected_version: config.expected_version,
      capabilities: probeCapabilities(),
      checks,
      detail: `XiaobaOS ${version} native Arena contract is ready.`,
    };
  }

  async run(input: RunXiaoBaNativeEvaluationInput): Promise<XiaoBaCapabilityEvaluationResultV1> {
    validateRequest(input.request);
    if (input.preflight_only && !input.live_policy_binding) {
      throw new XiaoBaNativeError("live_policy_required", "--preflight-only requires an explicit bound live policy.");
    }
    let liveBinding: XiaoBaLivePolicyBinding | undefined;
    try {
      liveBinding = input.live_policy_binding
        ? validateXiaoBaLivePolicyBinding(input.live_policy_binding)
        : undefined;
    } catch (error) {
      throw new XiaoBaNativeError(
        "live_policy_binding_invalid",
        error instanceof Error ? error.message : String(error)
      );
    }
    const livePolicy = liveBinding?.policy;
    const liveRedaction = livePolicy
      ? redactionContext(livePolicy, this.environment, paidEnvironmentNames(livePolicy))
      : undefined;
    const runsRoot = path.resolve(input.runs_root ?? "runs");
    ensureDir(runsRoot);
    const evaluationRoot = path.join(runsRoot, input.request.evaluation_id);
    if (fs.existsSync(evaluationRoot)) {
      throw new XiaoBaNativeError("xiaoba_execution_root_invalid", `Evaluation root already exists: ${evaluationRoot}`);
    }
    ensureDir(evaluationRoot);
    const requestRef = path.join(evaluationRoot, "evaluation-request.json");
    const preflightRedactionEntries: Array<Record<string, unknown>> = [];
    const preflightRedactionManifestRef = liveRedaction
      ? path.join(evaluationRoot, "preflight", "redaction-manifest.json")
      : undefined;
    const retainJson = (component: string, destination: string, value: unknown): void => {
      if (!liveRedaction) {
        writeJson(destination, value);
        return;
      }
      const sanitized = writeSanitizedJson(destination, value, liveRedaction);
      const entry = {
        component,
        retained_ref: destination,
        source_sha256: sanitized.source_sha256,
        sanitized_sha256: sanitized.sanitized_sha256,
        replacement_count: sanitized.replacement_count,
        structured_redaction_count: sanitized.structured_redaction_count,
        sanitization_status: sanitized.status,
      };
      const existing = preflightRedactionEntries.findIndex((item) => item.component === component);
      if (existing >= 0) preflightRedactionEntries[existing] = entry;
      else preflightRedactionEntries.push(entry);
    };
    const writePreflightRedactionManifest = (): void => {
      if (!liveRedaction || !preflightRedactionManifestRef) return;
      writeSanitizedJson(preflightRedactionManifestRef, {
        schema: "barena.redaction_manifest.v1",
        profile: liveRedaction.profile,
        generated_at: this.now().toISOString(),
        entries: preflightRedactionEntries,
      }, liveRedaction);
    };
    retainJson("evaluation-request", requestRef, input.request);
    const retainedPolicyRef = livePolicy && liveRedaction
      ? path.join(evaluationRoot, "preflight", "live-policy-input.json")
      : undefined;
    if (retainedPolicyRef && livePolicy) retainJson("live-policy-input", retainedPolicyRef, livePolicy);
    const retainedPolicySha256 = retainedPolicyRef && fs.existsSync(retainedPolicyRef)
      ? crypto.createHash("sha256").update(fs.readFileSync(retainedPolicyRef)).digest("hex")
      : undefined;
    writePreflightRedactionManifest();

    const admission = prepareStaticAdmission({
      evaluation_root: evaluationRoot,
      subjects: admissionSubjects(input.request),
      accepted_finding_ids: livePolicy?.accepted_scan_finding_ids ?? input.accepted_scan_finding_ids,
      now: this.now,
    });
    if (admission.report.decision !== "pass") {
      const probe = blockedProbe(
        input.request.xiaoba,
        [],
        admission.report.reason_code,
        admission.report.summary
      );
      const result = staticAdmissionResult(input.request, requestRef, probe, admission.report);
      if (livePolicy) attachLiveNotReady(result, input, livePolicy, retainedPolicyRef, preflightRedactionManifestRef);
      return liveRedaction
        ? this.finalizeLiveResult(evaluationRoot, result, liveRedaction)
        : this.writeResult(evaluationRoot, result);
    }

    let staged: Record<XiaoBaNativeArm, StagedSelection>;
    try {
      staged = stageRequest(input.request, admission.subjects);
    } catch (error) {
      const failure = nativeError(error, "xiaoba_source_copy_failed");
      const detail = liveRedaction ? sanitizeTextForRetention(failure.message, liveRedaction).text : failure.message;
      const probe = blockedProbe(input.request.xiaoba, [], failure.reason_code, detail);
      const result = blockedResult(input.request, requestRef, probe, failure.reason_code, detail, admission.report);
      if (livePolicy) attachLiveNotReady(result, input, livePolicy, retainedPolicyRef, preflightRedactionManifestRef);
      return liveRedaction
        ? this.finalizeLiveResult(evaluationRoot, result, liveRedaction)
        : this.writeResult(evaluationRoot, result);
    }

    const request = snapshotRequestFixtures(
      requestWithStagedSources(input.request, staged),
      evaluationRoot
    );
    retainJson("evaluation-request", requestRef, request);
    writePreflightRedactionManifest();

    let liveContext: LiveExecutionContext | undefined;
    let preflightRef: string | undefined;
    if (liveBinding && livePolicy && liveRedaction) {
      const policyOnlyPreflight = evaluateXiaoBaLivePreflight({
        binding: liveBinding,
        request,
        environment: this.environment,
        retained_policy_ref: retainedPolicyRef,
        retained_policy_sha256: retainedPolicySha256,
        now: this.now(),
      });
      let runtimeContract: XiaoBaLiveRuntimeContractV1 | undefined;
      let runtimeContractRef: string | undefined;
      if (policyOnlyPreflight.reason_code === "live_runtime_contract_unsupported") {
        const runtimeProbe = await this.probeLiveRuntimeContract(request.xiaoba, evaluationRoot, liveRedaction);
        runtimeContract = runtimeProbe.contract;
        runtimeContractRef = runtimeProbe.ref;
      }
      const preflight = runtimeContract
        ? evaluateXiaoBaLivePreflight({
            binding: liveBinding,
            request,
            environment: this.environment,
            runtime_contract: runtimeContract,
            runtime_contract_ref: runtimeContractRef,
            retained_policy_ref: retainedPolicyRef,
        retained_policy_sha256: retainedPolicySha256,
            now: this.now(),
          })
        : policyOnlyPreflight;
      preflightRef = path.join(evaluationRoot, "preflight", "live-policy.json");
      if (preflightRedactionManifestRef) preflight.redaction.manifest_ref = preflightRedactionManifestRef;
      retainJson("live-policy-preflight", preflightRef, preflight);
      writePreflightRedactionManifest();
      if (!preflight.ready_to_invoke || !runtimeContract) {
        const probe = blockedProbe(
          request.xiaoba,
          [],
          preflight.reason_code ?? "live_runtime_contract_unsupported",
          preflight.summary
        );
        const result = blockedResult(
          request,
          requestRef,
          probe,
          preflight.reason_code ?? "live_runtime_contract_unsupported",
          preflight.summary,
          admission.report
        );
        attachLiveResult(result, input, preflight, preflightRef, [], []);
        return this.finalizeLiveResult(evaluationRoot, result, liveRedaction);
      }
      liveContext = {
        binding: liveBinding,
        policy: livePolicy,
        preflight,
        redaction: liveRedaction,
        runtime_contract: runtimeContract,
        ledger: {
          planned_barena_attempts: preflight.budget.planned_barena_attempts,
          planned_provider_calls: preflight.budget.planned_provider_calls,
          observed_barena_attempts: 0,
          consumed_provider_call_reservation: 0,
          call_records: [],
          model_invoked: false,
        },
      };
    }

    const probe = await this.probe(request.xiaoba);
    const probeRef = path.join(evaluationRoot, "debug", "xiaoba-probe.json");
    if (liveRedaction) writeSanitizedJson(probeRef, probe, liveRedaction);
    else writeJson(probeRef, probe);
    if (probe.status === "blocked") {
      const result = blockedResult(
        request,
        requestRef,
        probe,
        probe.reason_code ?? "xiaoba_cli_contract_unavailable",
        probe.detail,
        admission.report
      );
      result.debug_refs = [probeRef];
      if (liveContext && preflightRef) attachLiveResult(result, input, liveContext.preflight, preflightRef, [], [], liveContext.ledger);
      return liveRedaction
        ? this.finalizeLiveResult(evaluationRoot, result, liveRedaction)
        : this.writeResult(evaluationRoot, result);
    }

    let preparedPlanRef: string | undefined;
    if (liveContext && preflightRef) {
      try {
        preparedPlanRef = await this.prepareLiveExecutionPlan(request, staged, evaluationRoot, liveContext);
      } catch (error) {
        const failure = nativeError(error, "xiaoba_runner_failed");
        const result = blockedResult(
          request,
          requestRef,
          probe,
          failure.reason_code,
          sanitizeTextForRetention(failure.message, liveContext.redaction).text,
          admission.report
        );
        result.debug_refs = [probeRef];
        attachLiveResult(result, input, liveContext.preflight, preflightRef, [], [], liveContext.ledger);
        return this.finalizeLiveResult(evaluationRoot, result, liveContext.redaction);
      }
    }

    if (input.preflight_only && liveContext && preflightRef) {
      const result = blockedResult(
        request,
        requestRef,
        probe,
        "live_preflight_only",
        "Live preflight completed successfully; provider execution was intentionally not started.",
        admission.report
      );
      result.debug_refs = [probeRef, ...(preparedPlanRef ? [preparedPlanRef] : [])];
      attachLiveResult(result, input, liveContext.preflight, preflightRef, [], [], liveContext.ledger);
      return liveRedaction
        ? this.finalizeLiveResult(evaluationRoot, result, liveRedaction)
        : this.writeResult(evaluationRoot, result);
    }

    const baselineRun = await this.runArm(request, "baseline", staged.baseline, evaluationRoot, liveContext);
    const baselineAttempts = baselineRun.attempts;
    if (liveContext && preflightRef && baselineRun.failure) {
      const result = aggregateResult(
        request,
        requestRef,
        probe,
        baselineAttempts,
        [],
        admission.report,
        this.now()
      );
      applyDecisionProposal(result, "held", baselineRun.failure.reason, baselineRun.failure.summary);
      result.quality.required_evidence_complete = false;
      if (preparedPlanRef) result.debug_refs = [...new Set([...result.debug_refs, preparedPlanRef])];
      attachLiveResult(result, input, liveContext.preflight, preflightRef, baselineAttempts, [], liveContext.ledger);
      return this.finalizeLiveResult(evaluationRoot, result, liveContext.redaction);
    }

    const candidateRun = await this.runArm(request, "candidate", staged.candidate, evaluationRoot, liveContext);
    const candidateAttempts = candidateRun.attempts;
    const result = aggregateResult(
      request,
      requestRef,
      probe,
      baselineAttempts,
      candidateAttempts,
      admission.report,
      this.now()
    );
    if (liveContext && preflightRef) {
      if (candidateRun.failure) {
        applyDecisionProposal(result, "held", candidateRun.failure.reason, candidateRun.failure.summary);
        result.quality.required_evidence_complete = false;
      } else if (
        request.attempts_per_arm === 1 &&
        result.decision === "cleared" &&
        result.reason_code === "positive_lift"
      ) {
        applyDecisionProposal(
          result,
          "held",
          "insufficient_live_replays",
          "A single live attempt per arm proves the safety boundary and evidence chain only; it cannot clear the candidate."
        );
      }
      if (preparedPlanRef) result.debug_refs = [...new Set([...result.debug_refs, preparedPlanRef])];
      attachLiveResult(result, input, liveContext.preflight, preflightRef, baselineAttempts, candidateAttempts, liveContext.ledger);
      return this.finalizeLiveResult(evaluationRoot, result, liveContext.redaction);
    }
    return this.writeResult(evaluationRoot, result);
  }

  private async runArm(
    request: XiaoBaCapabilityEvaluationRequestV1,
    arm: XiaoBaNativeArm,
    staged: StagedSelection,
    evaluationRoot: string,
    live?: LiveExecutionContext
  ): Promise<RunArmOutcome> {
    const attempts: XiaoBaNativeAttemptResult[] = [];
    for (const caseDefinition of request.cases) {
      for (let attempt = 1; attempt <= request.attempts_per_arm; attempt += 1) {
        const result = await this.runAttempt(request, arm, staged, caseDefinition, attempt, evaluationRoot, live);
        attempts.push(result);
        if (live) {
          const remainingReservedCalls = Math.max(
            0,
            live.ledger.planned_provider_calls - live.ledger.consumed_provider_call_reservation
          );
          const failure = liveArmFailure(arm, [result], live.policy, remainingReservedCalls);
          if (failure) return { attempts, failure };
        }
      }
    }
    return { attempts };
  }

  private async runAttempt(
    request: XiaoBaCapabilityEvaluationRequestV1,
    arm: XiaoBaNativeArm,
    staged: StagedSelection,
    caseDefinition: XiaoBaNativeCaseV1,
    attempt: number,
    evaluationRoot: string,
    live?: LiveExecutionContext
  ): Promise<XiaoBaNativeAttemptResult> {
    const attemptRoot = path.join(evaluationRoot, "arms", arm, caseDefinition.case_id, `attempt-${attempt}`);
    let scratchRoot: string | undefined;
    let attemptResult: XiaoBaNativeAttemptResult | undefined;
    let cleanupVerified = !live;

    try {
      scratchRoot = live
        ? this.scratchRootFactory(`barena-xiaoba-${safeRunId(request.evaluation_id, arm, caseDefinition.case_id, attempt, this.nonce()).slice(0, 80)}-`)
        : attemptRoot;
      const executionRoot = path.join(scratchRoot, "xiaoba-project");
      const homeRoot = path.join(scratchRoot, "home");
      const seedRoot = path.join(scratchRoot, "workspace-seed");
      const boundaryTrace = path.join(scratchRoot, "traces", "boundary.ndjson");
      const requestManifest = path.join(scratchRoot, "request-manifest.json");
      if (live) ensureDir(path.dirname(attemptRoot));
      else ensureDir(attemptRoot);
      ensureDir(executionRoot);
      ensureDir(homeRoot);
      ensureDir(seedRoot);

      const runId = safeRunId(request.evaluation_id, arm, caseDefinition.case_id, attempt, this.nonce());
      const deliveredPrompt = caseDefinition.task.prompt;
      const boundaryContext: BoundaryContext = {
        run_id: runId,
        case_id: caseDefinition.case_id,
        attempt_id: `attempt-${attempt}`,
      };
      const passEnvNames = live
        ? paidPassEnvNames(live.policy)
        : policyFreePassEnv(request.xiaoba.pass_env);
      const requestManifestValue = {
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
        pass_env_names: passEnvNames,
        ...(live && {
          provider: live.policy.provider,
          model: live.policy.model,
          max_input_tokens: live.policy.max_input_tokens,
          max_output_tokens: live.policy.max_output_tokens,
          max_provider_calls: live.policy.max_provider_calls,
        }),
        created_at: this.now().toISOString(),
      };
      writeJson(requestManifest, requestManifestValue);
      const setupEnv = setupRuntimeEnvironment(
        this.environment,
        executionRoot,
        staged.roles_root,
        homeRoot
      );
      const executeEnv = live
        ? paidRuntimeEnvironment(
            this.environment,
            executionRoot,
            staged.roles_root,
            homeRoot,
            live.policy,
            caseDefinition,
            requireLiveRuntimeContract(live.preflight)
          )
        : policyFreeRuntimeEnvironment(this.environment, request.xiaoba, executionRoot, staged.roles_root, homeRoot);
      const commandResults: XiaoBaCommandResult[] = [];
      let roleManifest = "";
      let subjectManifest = "";

      try {
      bindDist(request.xiaoba.project_root, executionRoot);
      if (fs.existsSync(path.join(executionRoot, "roles"))) {
        throw new XiaoBaNativeError("xiaoba_execution_root_invalid", "Execution root contains a forbidden roles shadow.");
      }
      materializeFixtures(caseDefinition, seedRoot);
      const roleSnapshot = await this.executeBoundaryCommand(
        request.xiaoba,
        executionRoot,
        setupEnv,
        boundaryTrace,
        ["arena", "snapshot", "role", staged.selection.role.role_id],
        boundaryContext
      );
      commandResults.push(roleSnapshot);
      assertCommand(roleSnapshot, "xiaoba_subject_snapshot_failed", "Role snapshot failed.");
      roleManifest = findSubjectManifest(executionRoot, "role", staged.selection.role.role_id);

      if (staged.selection.mode === "role_skill") {
        const imported = await this.executeBoundaryCommand(
          request.xiaoba,
          executionRoot,
          setupEnv,
          boundaryTrace,
          ["arena", "import", "skill", staged.skill_path!],
          boundaryContext
        );
        commandResults.push(imported);
        assertCommand(imported, "xiaoba_subject_import_failed", "Skill import failed.");
        subjectManifest = findSubjectManifest(executionRoot, "skill", staged.selection.skill.name);
      } else {
        subjectManifest = roleManifest;
      }
      const subjectId = stringField(readJson<JsonRecord>(subjectManifest), "subject_id", "arena subject manifest");
      const args = arenaExecuteArgs(
        request,
        staged.selection,
        caseDefinition,
        subjectId,
        runId,
        seedRoot,
        deliveredPrompt,
        passEnvNames
      );
      if (live) {
        const reservedCalls = Object.values(providerCallReservationForCase(
          caseDefinition,
          requireLiveRuntimeContract(live.preflight)
        ))
          .reduce((sum, value) => sum + value, 0);
        if (
          live.ledger.observed_barena_attempts >= live.ledger.planned_barena_attempts ||
          live.ledger.consumed_provider_call_reservation + reservedCalls > live.ledger.planned_provider_calls
        ) {
          throw new XiaoBaNativeError("usage_limit_exceeded", "No conservative provider-call reservation remains for paid execution.");
        }
        live.ledger.observed_barena_attempts += 1;
        live.ledger.consumed_provider_call_reservation += reservedCalls;
        live.ledger.model_invoked = null;
      }
      const executed = await this.executeBoundaryCommand(
        request.xiaoba,
        executionRoot,
        executeEnv,
        boundaryTrace,
        args,
        boundaryContext,
        caseDefinition.timeout_ms ?? DEFAULT_TIMEOUT_MS
      );
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
        require_provider_calls: Boolean(live),
      });
      const captured = live
        ? captureSanitizedEvidence(
            attemptRoot,
            scratchRoot,
            executionRoot,
            boundaryTrace,
            requestManifest,
            validated,
            live.redaction
          )
        : legacyCapturedEvidence(attemptRoot, executionRoot, boundaryTrace, requestManifest, validated);
      const expectedSkill = request.capability_kind === "skill"
        ? request.candidate.skill.name
        : staged.selection.mode === "role_skill" ? staged.selection.skill.name : undefined;
      const retainedObservation = live
        ? traceObservation(captured.refs.native, expectedSkill)
        : validated.observation;
      const assertionsPassed = validated.assertions.every((assertion) => assertion.status === "pass");
      const activationEvidenceComplete = staged.selection.mode !== "role_skill" || retainedObservation.activation_observed;
      const status = validated.decision === "unsafe"
        ? "unsafe"
        : validated.decision === "blocked"
          ? "blocked"
          : validated.decision === "pass" && validated.stages_passed && assertionsPassed && activationEvidenceComplete
            ? "pass"
            : "fail";
      const reasonCode: XiaoBaNativeReasonCode | undefined = status === "pass"
        ? undefined
        : validated.decision === "unsafe"
          ? "xiaoba_arena_unsafe"
          : validated.decision === "blocked"
            ? "xiaoba_arena_blocked"
            : validated.decision === "unstable"
              ? "xiaoba_arena_unstable"
              : validated.decision === "reopened"
                ? "xiaoba_arena_reopened"
                : !activationEvidenceComplete
                  ? "xiaoba_skill_not_activated"
                  : !assertionsPassed
                    ? "artifact_assertion_failed"
                    : "unstable_result";
          const callObservation = live
        ? providerCallRecordsFromEvidence(
            captured.refs.evaluator,
            arm,
            caseDefinition,
            attempt,
            live.policy,
            requireLiveRuntimeContract(live.preflight)
          )
        : undefined;
      if (live && callObservation) {
        live.ledger.call_records.push(...callObservation.records);
        live.ledger.model_invoked = callObservation.records.length > 0 ? true : null;
      }
      const providerIdentity = live && callObservation
        ? providerIdentityFromCallRecords(live.policy, callObservation)
        : undefined;
      const usage = live && callObservation
        ? usageFromCallRecords(live.policy, callObservation)
        : undefined;
      attemptResult = {
        arm,
        case_id: caseDefinition.case_id,
        purpose: caseDefinition.purpose,
        attempt,
        status,
        ...(reasonCode && { reason_code: reasonCode }),
        detail: status === "pass"
          ? "Native Arena and Barena artifact assertions passed."
          : `Native decision=${validated.decision}; assertions_passed=${assertionsPassed}.`,
        mode: staged.selection.mode,
        role_id: staged.selection.role.role_id,
        role_fingerprint: staged.selection.role.fingerprint,
        ...(staged.selection.mode === "role_skill" && {
          skill_name: staged.selection.skill.name,
          skill_fingerprint: staged.selection.skill.fingerprint,
        }),
        xiaoba_run_id: runId,
        execution_root: live ? scratchRef(scratchRoot, executionRoot) : executionRoot,
        workspace_root: live ? scratchRef(scratchRoot, validated.workspace_root) : validated.workspace_root,
        subject_id: validated.subject_id,
        native_decision: validated.decision,
        process: processSummary(commandResults[commandResults.length - 1]),
        activation: {
          required: staged.selection.mode === "role_skill",
          ...(staged.selection.mode === "role_skill" && { expected_skill: staged.selection.skill.name }),
          observed: retainedObservation.activation_observed,
        },
        ...(providerIdentity && { provider_identity: providerIdentity }),
        ...(usage && { usage }),
        ...(live && { redaction: captured.redaction }),
        assertions: validated.assertions,
        refs: captured.refs,
        evidence: captured.copies,
      };
    } catch (error) {
      const failure = nativeError(error, "xiaoba_runner_failed");
      const failureMessage = live
        ? sanitizeTextForRetention(failure.message, live.redaction).text
        : failure.message;
      appendBoundary(boundaryTrace, boundaryContext, {
        kind: "runtime_status",
        message: failureMessage,
        data: { status: "blocked", reason_code: failure.reason_code },
      });
      const captured = live
        ? captureSanitizedBlockedEvidence(
            attemptRoot,
            scratchRoot,
            boundaryTrace,
            requestManifest,
            roleManifest,
            subjectManifest,
            live.redaction,
            path.join(executionRoot, "arena", "runs", runId, "debug", "provider-calls.ndjson")
          )
        : legacyCapturedBlockedEvidence(attemptRoot, boundaryTrace, requestManifest, roleManifest, subjectManifest);
      attemptResult = {
        ...blockedAttempt(
          request,
          arm,
          staged.selection,
          caseDefinition,
          attempt,
          live ? scratchRef(scratchRoot, executionRoot) : executionRoot,
          captured.refs.boundary_trace,
          failure.reason_code,
          failureMessage,
          runId,
          processSummary(commandResults[commandResults.length - 1])
        ),
        refs: captured.refs,
        ...(live && { redaction: captured.redaction }),
        evidence: captured.copies,
      };
      if (live && captured.refs.evaluator.length > 0) {
        const callObservation = providerCallRecordsFromEvidence(
          captured.refs.evaluator,
          arm,
          caseDefinition,
          attempt,
          live.policy,
          requireLiveRuntimeContract(live.preflight)
        );
        live.ledger.call_records.push(...callObservation.records);
        live.ledger.model_invoked = callObservation.raw_call_count > 0 ? true : live.ledger.model_invoked;
        attemptResult.provider_identity = providerIdentityFromCallRecords(live.policy, callObservation);
        attemptResult.usage = usageFromCallRecords(live.policy, callObservation);
      }
      }
    } finally {
      if (live && scratchRoot) {
        cleanupVerified = cleanupScratchRoot(scratchRoot, this.scratchCleanup);
      }
      if (live && !cleanupVerified && !attemptResult) {
        throw new XiaoBaNativeError(
          "scratch_cleanup_failed",
          "Raw XiaobaOS scratch cleanup could not be verified after setup or capture failed."
        );
      }
    }

    if (!attemptResult) {
      throw new XiaoBaNativeError("xiaoba_runner_failed", "XiaobaOS attempt ended without a result.");
    }
    if (live) {
      const previous = attemptResult.redaction ?? emptyAttemptRedaction(live.redaction.profile);
      const redactionResult: XiaoBaAttemptRedaction = {
        ...previous,
        scratch_cleanup: cleanupVerified ? "verified" : "failed",
      };
      attemptResult.redaction = redactionResult;
      if (!cleanupVerified) {
        if (attemptResult.status !== "unsafe") {
          attemptResult.status = "blocked";
          attemptResult.reason_code = "scratch_cleanup_failed";
          attemptResult.detail = "Raw XiaobaOS scratch cleanup could not be verified.";
        } else {
          attemptResult.detail += " Raw XiaobaOS scratch cleanup also could not be verified.";
        }
      } else if (redactionResult.status !== "verified") {
        if (attemptResult.status !== "unsafe") {
          attemptResult.status = "blocked";
          attemptResult.reason_code = redactionResult.retained_secret_scan === "fail"
            ? "retained_secret_detected"
            : "redaction_failed";
          attemptResult.detail = "Retained evidence redaction could not be verified.";
        } else {
          attemptResult.detail += " Retained evidence redaction also could not be verified.";
        }
      }
    }
    return attemptResult;
  }

  private async prepareLiveExecutionPlan(
    request: XiaoBaCapabilityEvaluationRequestV1,
    staged: Record<XiaoBaNativeArm, StagedSelection>,
    evaluationRoot: string,
    live: LiveExecutionContext
  ): Promise<string> {
    const entries: Array<Record<string, unknown>> = [];
    for (const arm of ["baseline", "candidate"] as const) {
      for (const caseDefinition of request.cases) {
        for (let attempt = 1; attempt <= request.attempts_per_arm; attempt += 1) {
          const scratchRoot = this.scratchRootFactory(
            `barena-xiaoba-prepared-${safeRunId(request.evaluation_id, arm, caseDefinition.case_id, attempt, this.nonce()).slice(0, 72)}-`
          );
          try {
            const executionRoot = path.join(scratchRoot, "xiaoba-project");
            const homeRoot = path.join(scratchRoot, "home");
            const seedRoot = path.join(scratchRoot, "workspace-seed");
            const boundaryTrace = path.join(scratchRoot, "traces", "boundary.ndjson");
            ensureDir(executionRoot);
            ensureDir(homeRoot);
            ensureDir(seedRoot);
            bindDist(request.xiaoba.project_root, executionRoot);
            materializeFixtures(caseDefinition, seedRoot);
            const setupEnv = setupRuntimeEnvironment(
              this.environment,
              executionRoot,
              staged[arm].roles_root,
              homeRoot
            );
            const runId = safeRunId(request.evaluation_id, arm, caseDefinition.case_id, attempt, this.nonce());
            const context: BoundaryContext = {
              run_id: runId,
              case_id: caseDefinition.case_id,
              attempt_id: `attempt-${attempt}`,
            };
            const roleSnapshot = await this.executeBoundaryCommand(
              request.xiaoba,
              executionRoot,
              setupEnv,
              boundaryTrace,
              ["arena", "snapshot", "role", staged[arm].selection.role.role_id],
              context
            );
            assertCommand(roleSnapshot, "xiaoba_subject_snapshot_failed", "Prepared Role snapshot failed.");
            const roleManifest = findSubjectManifest(
              executionRoot,
              "role",
              staged[arm].selection.role.role_id
            );
            let subjectManifest = roleManifest;
            if (staged[arm].selection.mode === "role_skill") {
              const imported = await this.executeBoundaryCommand(
                request.xiaoba,
                executionRoot,
                setupEnv,
                boundaryTrace,
                ["arena", "import", "skill", staged[arm].skill_path!],
                context
              );
              assertCommand(imported, "xiaoba_subject_import_failed", "Prepared Skill import failed.");
              subjectManifest = findSubjectManifest(
                executionRoot,
                "skill",
                staged[arm].selection.skill.name
              );
            }
            const subjectId = stringField(readJson<JsonRecord>(subjectManifest), "subject_id", "prepared subject manifest");
            const deliveredPrompt = caseDefinition.task.prompt;
            const args = arenaExecuteArgs(
              request,
              staged[arm].selection,
              caseDefinition,
              subjectId,
              runId,
              seedRoot,
              deliveredPrompt,
              paidPassEnvNames(live.policy)
            );
            entries.push({
              arm,
              case_id: caseDefinition.case_id,
              attempt,
              xiaoba_run_id: runId,
              role_manifest_sha256: hashDirectory(path.dirname(roleManifest)),
              subject_manifest_sha256: hashDirectory(path.dirname(subjectManifest)),
              fixture_seed_sha256: hashDirectory(seedRoot),
              provider_call_reservation: providerCallReservationForCase(
                caseDefinition,
                requireLiveRuntimeContract(live.preflight)
              ),
              execute_args: args,
            });
          } finally {
            if (!cleanupScratchRoot(scratchRoot, this.scratchCleanup)) {
              throw new XiaoBaNativeError(
                "scratch_cleanup_failed",
                "Prepared live execution scratch cleanup could not be verified."
              );
            }
          }
        }
      }
    }
    const ref = path.join(evaluationRoot, "preflight", "prepared-plan.json");
    writeSanitizedJson(ref, {
      schema: "barena.xiaoba_prepared_plan.v1",
      evaluation_id: request.evaluation_id,
      policy_source_sha256: live.binding.source_sha256,
      policy_canonical_sha256: live.binding.canonical_sha256,
      planned_barena_attempts: live.preflight.budget.planned_barena_attempts,
      planned_provider_calls: live.preflight.budget.planned_provider_calls,
      entries,
    }, live.redaction);
    return ref;
  }

  private async probeLiveRuntimeContract(
    config: XiaoBaNativeRuntimeConfig,
    evaluationRoot: string,
    redaction: EvidenceRedactionContext
  ): Promise<{ contract?: XiaoBaLiveRuntimeContractV1; ref: string }> {
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-xiaoba-live-contract-"));
    const ref = path.join(evaluationRoot, "debug", "xiaoba-live-runtime-contract.json");
    try {
      const homeRoot = path.join(probeRoot, "home");
      ensureDir(path.join(homeRoot, "tmp"));
      const result = await this.commandRunner.run({
        command: path.resolve(config.binary_path),
        args: ["arena", "live-contract", "--json"],
        cwd: path.resolve(config.project_root),
        env: {
          PATH: this.environment.PATH,
          HOME: homeRoot,
          TMPDIR: path.join(homeRoot, "tmp"),
          XIAOBA_HOME: homeRoot,
          XIAOBA_PROJECT_ROOT: path.resolve(config.project_root),
          NO_COLOR: "1",
          CI: "1",
        },
        timeout_ms: 30_000,
        max_output_bytes: MAX_OUTPUT_BYTES,
      });
      let contract: XiaoBaLiveRuntimeContractV1 | undefined;
      let parseError: string | undefined;
      if (result.exit_code === 0 && !result.timed_out && !result.output_limit_exceeded && !result.error) {
        try {
          contract = validateXiaoBaLiveRuntimeContract(JSON.parse(result.stdout));
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }
      writeSanitizedJson(ref, {
        command: [config.binary_path, "arena", "live-contract", "--json"],
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        output_limit_exceeded: result.output_limit_exceeded,
        ...(result.error && { error: result.error }),
        ...(parseError && { parse_error: parseError }),
        status: contract ? "verified" : "unsupported",
        ...(contract && { contract }),
      }, redaction);
      return { ...(contract && { contract }), ref };
    } finally {
      fs.rmSync(probeRoot, { recursive: true, force: true });
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
    appendBoundary(tracePath, context, { kind: "runtime_status", message: "Starting XiaobaOS CLI command.", data: { command: [config.binary_path, ...args] } });
    const result = await this.commandRunner.run({
      command: path.resolve(config.binary_path), args, cwd, env, timeout_ms: timeoutMs, max_output_bytes: MAX_OUTPUT_BYTES,
    });
    appendBoundary(tracePath, context, {
      kind: "runtime_status",
      message: "XiaobaOS CLI command completed.",
      data: {
        command: [config.binary_path, ...args], exit_code: result.exit_code, signal: result.signal,
        duration_ms: result.duration_ms, timed_out: result.timed_out, output_limit_exceeded: result.output_limit_exceeded,
      },
    });
    return result;
  }

  private finalizeLiveResult(
    root: string,
    result: XiaoBaCapabilityEvaluationResultV1,
    redaction: EvidenceRedactionContext
  ): XiaoBaCapabilityEvaluationResultV1 {
    const preWriteScan = scanRetainedTreeForSecrets(root, redaction);
    if (preWriteScan.status === "fail") {
      quarantineRetainedSecretHits(root, result, preWriteScan.hits, redaction);
      applyDecisionProposal(
        result,
        "held",
        "retained_secret_detected",
        "Retained evidence contained a secret and was quarantined; this run is not shareable."
      );
      result.quality.required_evidence_complete = false;
    }
    const quarantinedScan = scanRetainedTreeForSecrets(root, redaction);
    const attempts = [...result.baseline.attempts, ...result.candidate.attempts];
    const previousRedaction = result.redaction;
    const summary = summarizeRedaction(
      attempts,
      redaction.profile,
      preWriteScan.status === "fail" ? preWriteScan : quarantinedScan,
      quarantinedScan.status
    );
    if (previousRedaction) {
      summary.manifest_refs = [...new Set([...previousRedaction.manifest_refs, ...summary.manifest_refs])];
      summary.replacement_count = Math.max(previousRedaction.replacement_count, summary.replacement_count);
      summary.structured_redaction_count = Math.max(
        previousRedaction.structured_redaction_count,
        summary.structured_redaction_count
      );
    }
    result.redaction = summary;
    if (quarantinedScan.status === "fail") {
      applyDecisionProposal(
        result,
        "held",
        "retained_secret_detected",
        "Retained evidence secret scanning failed closed."
      );
      result.quality.required_evidence_complete = false;
    }

    this.writeResult(root, result, redaction);
    const persistedScan = scanRetainedTreeForSecrets(root, redaction);
    if (persistedScan.status === "pass") return result;

    fs.rmSync(path.join(root, "package-manifest.json"), { force: true });
    quarantineRetainedSecretHits(root, result, persistedScan.hits, redaction);
    applyDecisionProposal(
      result,
      "held",
      "retained_secret_detected",
      "Persisted result or report evidence failed the retained-secret scan and was quarantined."
    );
    result.quality.required_evidence_complete = false;
    result.redaction = {
      ...(result.redaction ?? summarizeRedaction(attempts, redaction.profile, persistedScan, "fail")),
      status: "failed",
      retained_secret_scan: "fail",
      secret_hits: [
        ...(result.redaction?.secret_hits ?? []),
        ...persistedScan.hits.map((hit) => `${path.relative(root, hit.file_ref)}:${hit.secret_name}`),
      ],
    };
    this.writeResult(root, result, redaction);
    const finalScan = scanRetainedTreeForSecrets(root, redaction);
    if (finalScan.status === "fail") {
      fs.rmSync(path.join(root, "package-manifest.json"), { force: true });
      quarantineRetainedSecretHits(root, result, finalScan.hits, redaction);
      throw new XiaoBaNativeError(
        "retained_secret_detected",
        "Retained result files could not be written without a secret; unsafe files were removed."
      );
    }
    return result;
  }

  private writeResult(
    root: string,
    result: XiaoBaCapabilityEvaluationResultV1,
    redaction?: EvidenceRedactionContext
  ): XiaoBaCapabilityEvaluationResultV1 {
    ensureDir(root);
    const manifestRef = path.join(root, "package-manifest.json");
    const stagingRoot = fs.mkdtempSync(path.join(root, ".result-package-staging-"));
    const stagedResultRef = path.join(stagingRoot, "capability-evaluation.json");
    const stagedReportJsonRef = path.join(stagingRoot, "reports", "report.json");
    const stagedReportMarkdownRef = path.join(stagingRoot, "reports", "report.md");
    const stagedManifestRef = path.join(stagingRoot, "package-manifest.json");
    const finalResultRef = path.join(root, "capability-evaluation.json");
    const finalReportJsonRef = path.join(root, "reports", "report.json");
    const finalReportMarkdownRef = path.join(root, "reports", "report.md");

    result.package_manifest_ref = "package-manifest.json";
    fs.rmSync(manifestRef, { force: true });
    try {
      if (redaction) {
        writeSanitizedJson(stagedResultRef, result, redaction);
        writeSanitizedJson(stagedReportJsonRef, result, redaction);
        const report = sanitizeTextForRetention(renderXiaoBaCapabilityReport(result), redaction).text;
        ensureDir(path.dirname(stagedReportMarkdownRef));
        fs.writeFileSync(stagedReportMarkdownRef, report, "utf8");
        const stagedScan = scanRetainedTreeForSecrets(stagingRoot, redaction);
        if (stagedScan.status === "fail") {
          throw new XiaoBaNativeError(
            "retained_secret_detected",
            "The staged result package contains retained secrets and was not published."
          );
        }
      } else {
        writeJson(stagedResultRef, result);
        writeJson(stagedReportJsonRef, result);
        ensureDir(path.dirname(stagedReportMarkdownRef));
        fs.writeFileSync(stagedReportMarkdownRef, renderXiaoBaCapabilityReport(result), "utf8");
      }

      const stagedFiles = new Map<string, string>([
        ["capability-evaluation.json", stagedResultRef],
        ["reports/report.json", stagedReportJsonRef],
        ["reports/report.md", stagedReportMarkdownRef],
      ]);
      const files = resultPackageFiles(root, stagedFiles);
      writeJson(stagedManifestRef, {
        schema: "barena.result_package.v1",
        status: "complete",
        result_ref: "capability-evaluation.json",
        created_at: this.now().toISOString(),
        files,
      });

      ensureDir(path.dirname(finalReportJsonRef));
      fs.renameSync(stagedResultRef, finalResultRef);
      fs.renameSync(stagedReportJsonRef, finalReportJsonRef);
      fs.renameSync(stagedReportMarkdownRef, finalReportMarkdownRef);
      fs.renameSync(stagedManifestRef, manifestRef);
      return result;
    } catch (error) {
      fs.rmSync(manifestRef, { force: true });
      throw error;
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
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
    return blockedProbe(config, checks, "xiaoba_binary_not_found", `XiaobaOS binary does not exist: ${binary}`);
  }
  const entrypoint = path.join(projectRoot, "dist", "index.js");
  if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) {
    checks.push({ command: [entrypoint], exit_code: null, ok: false, detail: "dist/index.js does not exist." });
    return blockedProbe(config, checks, "xiaoba_cli_contract_unavailable", `XiaobaOS project root has no dist/index.js: ${projectRoot}`);
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
    expected_version: config.expected_version, capabilities: probeCapabilities(), checks, detail,
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

function setupRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
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
  return env;
}

function policyFreeRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  config: XiaoBaNativeRuntimeConfig,
  executionRoot: string,
  rolesRoot: string,
  homeRoot: string
): NodeJS.ProcessEnv {
  const env = setupRuntimeEnvironment(source, executionRoot, rolesRoot, homeRoot);
  for (const name of policyFreePassEnv(config.pass_env)) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

function paidRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  executionRoot: string,
  rolesRoot: string,
  homeRoot: string,
  policy: XiaoBaLivePolicyV1,
  caseDefinition: XiaoBaNativeCaseV1,
  runtimeContract: XiaoBaLiveRuntimeContractV1,
): NodeJS.ProcessEnv {
  const env = setupRuntimeEnvironment(source, executionRoot, rolesRoot, homeRoot);
  for (const name of [policy.credential_env, policy.api_base_env]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  env.XIAOBA_LLM_PROVIDER = policy.provider;
  env.XIAOBA_LLM_MODEL = policy.model;
  env.XIAOBA_LLM_MAX_TOKENS = String(policy.max_output_tokens);
  env.XIAOBA_ARENA_LIVE_MODE = "barena";
  env.XIAOBA_ARENA_MAX_INPUT_TOKENS = String(policy.max_input_tokens);
  env.XIAOBA_ARENA_MAX_PROVIDER_CALLS = String(
    Object.values(providerCallReservationForCase(caseDefinition, runtimeContract))
      .reduce((sum, value) => sum + value, 0)
  );
  env.XIAOBA_ARENA_CREDENTIAL_ENV = policy.credential_env;
  env.XIAOBA_ARENA_API_BASE_ENV = policy.api_base_env;
  return env;
}

function requireLiveRuntimeContract(preflight: XiaoBaLivePolicyPreflight): XiaoBaLiveRuntimeContractV1 {
  const contract = preflight.runtime_contract.contract;
  if (!contract) {
    throw new XiaoBaNativeError(
      "live_runtime_contract_unsupported",
      "Paid XiaobaOS execution requires a verified live runtime contract."
    );
  }
  return contract;
}

function policyFreePassEnv(names: string[]): string[] {
  return [...new Set(names.filter((name) =>
    !/(api[_-]?key|provider[_-]?key|[_-]key$|api[_-]?base|provider[_-]?base|secret|token|password|credential|auth|^xiaoba_llm_(provider|model|max_tokens)$)/i.test(name)
  ))].sort();
}

function paidPassEnvNames(policy: XiaoBaLivePolicyV1): string[] {
  return [
    policy.credential_env,
    policy.api_base_env,
    "XIAOBA_LLM_PROVIDER",
    "XIAOBA_LLM_MODEL",
    "XIAOBA_LLM_MAX_TOKENS",
    "XIAOBA_ARENA_LIVE_MODE",
    "XIAOBA_ARENA_MAX_INPUT_TOKENS",
    "XIAOBA_ARENA_MAX_PROVIDER_CALLS",
    "XIAOBA_ARENA_CREDENTIAL_ENV",
    "XIAOBA_ARENA_API_BASE_ENV",
  ];
}

function paidEnvironmentNames(policy: XiaoBaLivePolicyV1): string[] {
  return [policy.credential_env, policy.api_base_env];
}

function validateRequest(request: XiaoBaCapabilityEvaluationRequestV1): void {
  if (request.schema !== "barena.xiaoba_capability_evaluation_request.v1" || request.target_runtime !== "xiaoba" || request.evaluator_runtime !== "xiaoba-cli") {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "Invalid XiaobaOS capability evaluation request schema/runtime.");
  }
  assertSafeId(request.evaluation_id, "evaluation_id");
  if (!isXiaoBaNativeContractVersion(request.xiaoba.expected_version)) {
    throw new XiaoBaNativeError(
      "xiaoba_version_unsupported",
      `Request must pin a supported XiaobaOS version: ${XIAOBA_NATIVE_CONTRACT_VERSIONS.join(", ")}.`
    );
  }
  if (!Number.isInteger(request.attempts_per_arm) || request.attempts_per_arm < 1 || request.attempts_per_arm > 11) {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "attempts_per_arm must be an integer from 1 to 11.");
  }
  if (!request.cases.length) throw new XiaoBaNativeError("xiaoba_request_invalid", "At least one case is required.");
  const caseIds = new Set<string>();
  for (const item of request.cases) {
    if (item.schema !== "barena.xiaoba_native_case.v1") throw new XiaoBaNativeError("xiaoba_request_invalid", "Invalid XiaobaOS native case schema.");
    assertSafeId(item.case_id, "case_id");
    if (caseIds.has(item.case_id)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Duplicate case_id: ${item.case_id}`);
    caseIds.add(item.case_id);
    if (!item.task.prompt.trim()) throw new XiaoBaNativeError("xiaoba_request_invalid", `Case ${item.case_id} has an empty prompt.`);
    if (!item.assertions?.artifacts?.length) throw new XiaoBaNativeError("xiaoba_request_invalid", `Case ${item.case_id} requires at least one artifact assertion.`);
    const assertionPaths = new Set<string>();
    for (const assertion of item.assertions.artifacts) {
      const relative = safeRelative(assertion.path, "artifact assertion path");
      if (assertionPaths.has(relative)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Duplicate artifact assertion path: ${relative}`);
      assertionPaths.add(relative);
      if (assertion.contains !== undefined && !assertion.contains.trim()) {
        throw new XiaoBaNativeError("xiaoba_request_invalid", `Artifact assertion contains must be non-empty: ${relative}`);
      }
      if (assertion.exists === false && assertion.contains !== undefined) {
        throw new XiaoBaNativeError("xiaoba_request_invalid", `Artifact assertion cannot combine exists=false with contains: ${relative}`);
      }
    }
    const fixtureDestinations = new Set<string>();
    for (const fixture of item.fixtures ?? []) {
      const destination = safeRelative(fixture.destination, "fixture destination");
      if (fixtureDestinations.has(destination)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Duplicate fixture destination: ${destination}`);
      fixtureDestinations.add(destination);
      const source = path.resolve(fixture.source_path);
      if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) {
        throw new XiaoBaNativeError("xiaoba_request_invalid", `Fixture source is missing or symbolic: ${source}`);
      }
    }
    for (const [name, value] of [["max_turns", item.max_turns], ["replay_attempts", item.replay_attempts], ["max_replay_cases", item.max_replay_cases]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new XiaoBaNativeError("xiaoba_request_invalid", `${name} must be a positive integer.`);
      }
    }
    if (item.timeout_ms !== undefined && (!Number.isInteger(item.timeout_ms) || item.timeout_ms < 1000)) throw new XiaoBaNativeError("xiaoba_request_invalid", "timeout_ms must be at least 1000.");
  }
  if (new Set(request.xiaoba.pass_env).size !== request.xiaoba.pass_env.length) {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "pass_env names must be unique.");
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

function admissionSubjects(request: XiaoBaCapabilityEvaluationRequestV1): StaticAdmissionSubjectInput[] {
  if (request.capability_kind === "skill") {
    return [
      {
        relation: "common",
        subject_kind: "role",
        subject_id: request.candidate.role.role_id,
        source_path: request.candidate.role.source_path,
        fingerprint: request.candidate.role.fingerprint,
      },
      {
        relation: "candidate",
        subject_kind: "skill",
        subject_id: request.candidate.skill.name,
        source_path: request.candidate.skill.source_path,
        fingerprint: request.candidate.skill.fingerprint,
      },
    ];
  }
  return [
    {
      relation: "baseline",
      subject_kind: "role",
      subject_id: request.baseline.role.role_id,
      source_path: request.baseline.role.source_path,
      fingerprint: request.baseline.role.fingerprint,
    },
    {
      relation: "candidate",
      subject_kind: "role",
      subject_id: request.candidate.role.role_id,
      source_path: request.candidate.role.source_path,
      fingerprint: request.candidate.role.fingerprint,
    },
  ];
}

function requirePreparedSubject(
  prepared: PreparedStaticAdmissionSubject[],
  relation: "baseline" | "common" | "candidate",
  kind: "role" | "skill",
  subjectId: string
): PreparedStaticAdmissionSubject {
  const subject = prepared.find((entry) =>
    entry.relation === relation && entry.subject_kind === kind && entry.subject_id === subjectId
  );
  if (!subject) {
    throw new XiaoBaNativeError(
      "xiaoba_source_copy_failed",
      `Static admission did not produce the required ${relation} ${kind} snapshot for ${subjectId}.`
    );
  }
  return subject;
}

function stageRequest(
  request: XiaoBaCapabilityEvaluationRequestV1,
  prepared: PreparedStaticAdmissionSubject[]
): Record<XiaoBaNativeArm, StagedSelection> {
  const stageRole = (
    relation: "baseline" | "common" | "candidate",
    selection: XiaoBaNativeRoleSelection
  ): StagedSelection => {
    const role = requirePreparedSubject(prepared, relation, "role", selection.role.role_id);
    const stagedSelection: XiaoBaNativeRoleSelection = {
      ...selection,
      role: { ...selection.role, source_path: role.snapshot_path },
    };
    return {
      selection: stagedSelection,
      roles_root: path.dirname(role.snapshot_path),
      role_path: role.snapshot_path,
    };
  };

  if (request.capability_kind === "role") {
    return {
      baseline: stageRole("baseline", request.baseline),
      candidate: stageRole("candidate", request.candidate),
    };
  }

  const commonRole = requirePreparedSubject(
    prepared,
    "common",
    "role",
    request.candidate.role.role_id
  );
  const candidateSkill = requirePreparedSubject(
    prepared,
    "candidate",
    "skill",
    request.candidate.skill.name
  );
  const skillMetadata = parseSkillMetadata(path.join(candidateSkill.snapshot_path, "SKILL.md"));
  if (skillMetadata.name !== request.candidate.skill.name) {
    throw new XiaoBaNativeError(
      "xiaoba_request_invalid",
      `Skill name mismatch: request=${request.candidate.skill.name}, manifest=${skillMetadata.name}.`
    );
  }
  preflightRoleSkill(
    commonRole.snapshot_path,
    candidateSkill.snapshot_path,
    request.candidate.skill.name,
    skillMetadata.autoInvocable
  );
  const baseline: XiaoBaNativeRoleSelection = {
    ...request.baseline,
    role: { ...request.baseline.role, source_path: commonRole.snapshot_path },
  };
  const candidate: XiaoBaNativeRoleSkillSelection = {
    ...request.candidate,
    role: { ...request.candidate.role, source_path: commonRole.snapshot_path },
    skill: { ...request.candidate.skill, source_path: candidateSkill.snapshot_path },
  };
  const rolesRoot = path.dirname(commonRole.snapshot_path);
  return {
    baseline: {
      selection: baseline,
      roles_root: rolesRoot,
      role_path: commonRole.snapshot_path,
    },
    candidate: {
      selection: candidate,
      roles_root: rolesRoot,
      role_path: commonRole.snapshot_path,
      skill_path: candidateSkill.snapshot_path,
    },
  };
}

function requestWithStagedSources(
  request: XiaoBaCapabilityEvaluationRequestV1,
  staged: Record<XiaoBaNativeArm, StagedSelection>
): XiaoBaCapabilityEvaluationRequestV1 {
  if (request.capability_kind === "skill") {
    if (staged.baseline.selection.mode !== "role" || staged.candidate.selection.mode !== "role_skill") {
      throw new XiaoBaNativeError("xiaoba_request_invalid", "Staged Skill evaluation selections are invalid.");
    }
    return {
      ...request,
      baseline: staged.baseline.selection,
      candidate: staged.candidate.selection,
    };
  }
  if (staged.baseline.selection.mode !== "role" || staged.candidate.selection.mode !== "role") {
    throw new XiaoBaNativeError("xiaoba_request_invalid", "Staged Role evaluation selections are invalid.");
  }
  return {
    ...request,
    baseline: staged.baseline.selection,
    candidate: staged.candidate.selection,
  };
}

function snapshotRequestFixtures(
  request: XiaoBaCapabilityEvaluationRequestV1,
  evaluationRoot: string
): XiaoBaCapabilityEvaluationRequestV1 {
  const snapshotRoot = path.join(evaluationRoot, "preflight", "fixture-snapshots");
  const cases = request.cases.map((caseDefinition) => {
    const fixtures = caseDefinition.fixtures?.map((fixture, index) => {
      const source = path.resolve(fixture.source_path);
      assertNoSymbolicLinks(source, `fixture source for ${caseDefinition.case_id}`);
      const destination = path.join(
        snapshotRoot,
        caseDefinition.case_id,
        `${String(index + 1).padStart(3, "0")}-${path.basename(source)}`
      );
      ensureDir(path.dirname(destination));
      fs.cpSync(source, destination, { recursive: fs.statSync(source).isDirectory(), errorOnExist: true, force: false });
      makeTreeReadOnly(destination);
      return { ...fixture, source_path: destination };
    });
    return { ...caseDefinition, ...(fixtures && { fixtures }) };
  });
  return { ...request, cases } as XiaoBaCapabilityEvaluationRequestV1;
}

function assertNoSymbolicLinks(root: string, label: string): void {
  if (!fs.existsSync(root)) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} does not exist: ${root}`);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} may not be a symbolic link: ${root}`);
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new XiaoBaNativeError("xiaoba_request_invalid", `${label} must be a regular file or directory: ${root}`);
    return;
  }
  for (const entry of fs.readdirSync(root)) assertNoSymbolicLinks(path.join(root, entry), label);
}

function makeTreeReadOnly(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) makeTreeReadOnly(path.join(root, entry));
    fs.chmodSync(root, 0o555);
  } else if (stat.isFile()) {
    fs.chmodSync(root, stat.mode & 0o111 ? 0o555 : 0o444);
  }
}

function preflightRoleSkill(rolePath: string, skillPath: string, skillName: string, autoInvocable: boolean): void {
  const configPath = path.join(rolePath, "role.json");
  if (!fs.existsSync(configPath)) throw new XiaoBaNativeError("xiaoba_request_invalid", `Role has no role.json: ${rolePath}`);
  const config = readJson<JsonRecord>(configPath);
  if (config.inheritBaseSkills === false) throw new XiaoBaNativeError("xiaoba_role_skill_inheritance_unsupported", "Role has inheritBaseSkills=false; XiaobaOS would omit the candidate Skill.");
  if (!autoInvocable) throw new XiaoBaNativeError("xiaoba_skill_not_auto_invocable", "Paired Skill evaluation requires auto activation with the identical prompt in both arms.");
  const normalized = skillName.toLowerCase();
  const exclusions = Array.isArray(config.excludeBaseSkills) ? config.excludeBaseSkills.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
  const pathSegments = path.resolve(skillPath).split(path.sep).map((v) => v.toLowerCase());
  if (XIAOBA_011_DEFAULT_EXCLUDED_SKILLS.has(normalized) || exclusions.includes(normalized) || exclusions.some((item) => pathSegments.includes(item))) {
    throw new XiaoBaNativeError("xiaoba_skill_excluded", `XiaobaOS excludes candidate Skill ${skillName} for this Role.`);
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
  if (!fs.existsSync(entrypoint)) throw new XiaoBaNativeError("xiaoba_cli_contract_unavailable", `XiaobaOS dist entrypoint is missing: ${entrypoint}`);
  const destination = path.join(executionRoot, "dist");
  fs.symlinkSync(source, destination, "dir");
  if (path.resolve(fs.realpathSync(destination)) !== path.resolve(fs.realpathSync(source))) throw new XiaoBaNativeError("xiaoba_execution_root_invalid", "XiaobaOS dist binding did not resolve to the pinned project root.");
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
  prompt: string,
  passEnvNames: string[] = request.xiaoba.pass_env
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
  for (const name of passEnvNames) args.push("--pass-env", name);
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
  require_provider_calls: boolean;
}): ValidatedArenaArtifacts {
  const runRoot = path.join(input.executionRoot, "arena", "runs", input.runId);
  assertInside(input.executionRoot, runRoot, "Arena run root");
  const cleanRuntime = requiredFileInside(
    input.executionRoot,
    path.join(runRoot, "clean-runtime.json"),
    "xiaoba_scorecard_missing",
    "clean-runtime.json"
  );
  const arenaRunner = requiredFileInside(
    input.executionRoot,
    path.join(runRoot, "arena-runner.json"),
    "xiaoba_scorecard_missing",
    "arena-runner.json"
  );
  const arenaScorecard = requiredFileInside(
    input.executionRoot,
    path.join(runRoot, "arena-scorecard.json"),
    "xiaoba_scorecard_missing",
    "arena-scorecard.json"
  );
  const arenaRun = requiredFileInside(
    input.executionRoot,
    path.join(runRoot, "arena-run.json"),
    "xiaoba_scorecard_invalid",
    "arena-run.json"
  );
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
    debug.provider_calls,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const required of [debug.usercat_package, debug.inspector_analysis, debug.inspector_cases, debug.reviewer_scorecard, debug.reviewer_report]) {
    if (typeof required !== "string" || !required) throw new XiaoBaNativeError("xiaoba_stage_evidence_missing", "Arena scorecard is missing required evaluator-stage debug refs.");
  }
  if (input.require_provider_calls && (typeof debug.provider_calls !== "string" || !debug.provider_calls)) {
    throw new XiaoBaNativeError(
      "live_provider_call_telemetry_unverified",
      "Arena scorecard is missing the authoritative provider-call record ref."
    );
  }
  const evaluatorRefs = [...new Set(evaluatorRaw.map((ref) => resolveRunRef(input.executionRoot, ref)))];
  const debugRefs = [cleanRuntime, arenaRunner, arenaScorecard, arenaRun, input.roleManifest, input.subjectManifest];
  for (const ref of debugRefs) {
    requiredFileInside(input.executionRoot, ref, "xiaoba_artifact_ref_invalid", "Arena debug evidence ref");
  }
  const expectedSkill = input.request.capability_kind === "skill"
    ? input.request.candidate.skill.name
    : input.selection.mode === "role_skill" ? input.selection.skill.name : undefined;
  const observation = traceObservation(nativeRefs, expectedSkill);
  if (input.selection.mode === "role_skill" && !observation.activation_observed) throw new XiaoBaNativeError("xiaoba_skill_not_activated", `Native traces do not prove activation of ${input.selection.skill.name}.`);
  if (input.selection.mode === "role" && input.request.capability_kind === "skill" && observation.activation_observed) throw new XiaoBaNativeError("xiaoba_baseline_skill_leak", "Baseline native trace activated the candidate Skill.");
  const workspaceRoot = stringField(roots, "workspace_root", "clean runtime roots");
  assertInside(input.executionRoot, workspaceRoot, "workspace_root");
  const assertions = verifyAssertions(input.caseDefinition.assertions.artifacts, workspaceRoot);
  const verifierPath = path.join(path.dirname(input.executionRoot), "verifier", "artifact-assertions.json");
  writeJson(verifierPath, assertions);
  return {
    subject_id: input.subjectId, workspace_root: workspaceRoot, decision: decision as XiaoBaNativeDecision,
    observation, assertions, role_manifest: input.roleManifest,
    subject_manifest: input.subjectManifest, clean_runtime: cleanRuntime, arena_runner: arenaRunner,
    arena_scorecard: arenaScorecard, arena_run: arenaRun, verifier: verifierPath,
    native_refs: [...new Set(nativeRefs)], evaluator_refs: evaluatorRefs, debug_refs: debugRefs, stages_passed: stagesPassed,
  };
}

function traceObservation(traceRefs: string[], expectedSkill?: string): XiaoBaTraceObservation {
  let activationObserved = false;
  let traceEntries = 0;
  let providerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let inputComplete = true;
  let outputComplete = true;
  const providers = new Set<string>();
  const models = new Set<string>();
  const usageEvidence = new Set<string>();
  const identityEvidence = new Set<string>();

  for (const ref of new Set(traceRefs)) {
    requiredFile(ref, "xiaoba_native_trace_missing");
    for (const line of fs.readFileSync(ref, "utf8").split(/\r?\n/).filter(Boolean)) {
      let entry: JsonRecord;
      try {
        entry = JSON.parse(line) as JsonRecord;
      } catch {
        throw new XiaoBaNativeError("xiaoba_native_trace_missing", `Native trace is not valid NDJSON: ${ref}`);
      }
      if (entry.schema_version !== 3 || entry.entry_type !== "trace") continue;
      traceEntries += 1;
      const visibility = Array.isArray(entry.tool_visibility) ? entry.tool_visibility : [];
      if (expectedSkill && visibility.some((item) => isRecord(item) && item.activeSkillName === expectedSkill)) {
        activationObserved = true;
      }

      const provider = firstString(
        entry.provider,
        entry.provider_id,
        nestedValue(entry, "llm", "provider"),
        nestedValue(entry, "runtime", "provider"),
        nestedValue(entry, "metadata", "provider")
      );
      const model = firstString(
        entry.model,
        entry.model_id,
        nestedValue(entry, "llm", "model"),
        nestedValue(entry, "runtime", "model"),
        nestedValue(entry, "metadata", "model")
      );
      const retainedProvider = provider && !isRedactedEvidenceValue(provider) ? provider : undefined;
      const retainedModel = model && !isRedactedEvidenceValue(model) ? model : undefined;
      if (retainedProvider) providers.add(retainedProvider);
      if (retainedModel) models.add(retainedModel);
      if (retainedProvider || retainedModel) identityEvidence.add(ref);

      const usage = firstRecord(entry.usage, entry.tokens, nestedValue(entry, "llm", "usage"));
      const input = firstNonNegativeInteger(
        usage?.input_tokens,
        usage?.prompt_tokens,
        usage?.prompt,
        entry.input_tokens,
        entry.prompt_tokens
      );
      const output = firstNonNegativeInteger(
        usage?.output_tokens,
        usage?.completion_tokens,
        usage?.completion,
        entry.output_tokens,
        entry.completion_tokens
      );
      const calls = firstPositiveInteger(
        usage?.provider_calls,
        usage?.call_count,
        entry.provider_calls,
        entry.provider_call_count
      ) ?? 1;
      providerCalls += calls;
      if (input === undefined) inputComplete = false;
      else inputTokens += input;
      if (output === undefined) outputComplete = false;
      else outputTokens += output;
      if (input !== undefined || output !== undefined) usageEvidence.add(ref);
    }
  }
  if (traceEntries === 0) {
    throw new XiaoBaNativeError("xiaoba_native_trace_missing", "No session-log-v3 trace entries were found.");
  }
  const missingUsageFields: string[] = [];
  if (!inputComplete) missingUsageFields.push("input_tokens");
  if (!outputComplete) missingUsageFields.push("output_tokens");
  if (providerCalls === 0) missingUsageFields.push("provider_calls");
  return {
    activation_observed: activationObserved,
    trace_entries: traceEntries,
    provider_calls: providerCalls,
    input_tokens: inputComplete ? inputTokens : null,
    output_tokens: outputComplete ? outputTokens : null,
    observed_providers: [...providers].sort(),
    observed_models: [...models].sort(),
    usage_evidence_refs: [...usageEvidence].sort(),
    identity_evidence_refs: [...identityEvidence].sort(),
    missing_usage_fields: missingUsageFields,
  };
}

function verifyAssertions(assertions: XiaoBaNativeArtifactAssertion[], workspace: string): ArtifactAssertionResult[] {
  return assertions.map((assertion) => {
    const relative = safeRelative(assertion.path, "artifact assertion path");
    const artifact = path.join(workspace, relative);
    assertInside(workspace, artifact, "artifact assertion path");
    if (fs.existsSync(artifact) && fs.lstatSync(artifact).isSymbolicLink()) {
      throw new XiaoBaNativeError(
        "xiaoba_artifact_ref_invalid",
        `artifact assertion path may not be a symbolic link: ${artifact}`
      );
    }
    return verifyArtifactContent(assertion, artifact, relative);
  });
}

function legacyCapturedEvidence(
  attemptRoot: string,
  executionRoot: string,
  boundary: string,
  requestManifest: string,
  validated: ValidatedArenaArtifacts
): CapturedAttemptEvidence {
  const copies: XiaoBaEvidenceCopy[] = [];
  const add = (layer: XiaoBaEvidenceCopy["layer"], component: string, source: string): XiaoBaEvidenceCopy => {
    if (layer === "native" || layer === "evaluator" || layer === "debug") {
      assertInside(executionRoot, source, `${layer} evidence ref`);
    }
    requiredPath(source, layer === "native" ? "xiaoba_native_trace_missing" : "xiaoba_artifact_ref_invalid");
    const index = copies.length + 1;
    const destination = path.join(attemptRoot, "evidence", layer, `${String(index).padStart(3, "0")}-${path.basename(source)}`);
    ensureDir(path.dirname(destination));
    const stat = fs.statSync(source);
    fs.cpSync(source, destination, { recursive: stat.isDirectory() });
    const copied: XiaoBaEvidenceCopy = {
      layer,
      component,
      source_ref: source,
      copied_ref: destination,
      kind: stat.isDirectory() ? "directory" : "file",
      sha256: hashPath(destination),
    };
    copies.push(copied);
    return copied;
  };
  const boundaryCopy = add("boundary", "barena-boundary-trace", boundary);
  const verifierCopy = add("verifier", "barena-artifact-verifier", validated.verifier);
  const nativeCopies = validated.native_refs.map((ref) => add("native", "xiaoba-target-agent-session", ref));
  const evaluatorCopies = validated.evaluator_refs.map((ref) => add("evaluator", "xiaoba-arena-stage", ref));
  for (const ref of validated.debug_refs) add("debug", "xiaoba-arena", ref);
  writeJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies);
  return {
    copies,
    refs: {
      boundary_trace: boundaryCopy.copied_ref,
      request_manifest: requestManifest,
      role_manifest: validated.role_manifest,
      subject_manifest: validated.subject_manifest,
      clean_runtime: validated.clean_runtime,
      arena_runner: validated.arena_runner,
      arena_scorecard: validated.arena_scorecard,
      arena_run: validated.arena_run,
      verifier: verifierCopy.copied_ref,
      native: nativeCopies.map((copy) => copy.copied_ref),
      evaluator: evaluatorCopies.map((copy) => copy.copied_ref),
      debug: validated.debug_refs,
    },
    redaction: emptyAttemptRedaction("not-applicable"),
  };
}

function legacyCapturedBlockedEvidence(
  attemptRoot: string,
  boundary: string,
  requestManifest: string,
  roleManifest: string,
  subjectManifest: string
): CapturedAttemptEvidence {
  const copies: XiaoBaEvidenceCopy[] = [];
  let boundaryRef = boundary;
  if (fs.existsSync(boundary) && fs.statSync(boundary).isFile()) {
    const destination = path.join(attemptRoot, "evidence", "boundary", `001-${path.basename(boundary)}`);
    ensureDir(path.dirname(destination));
    fs.copyFileSync(boundary, destination);
    const evidence: XiaoBaEvidenceCopy = {
      layer: "boundary",
      component: "barena-boundary-trace",
      source_ref: boundary,
      copied_ref: destination,
      kind: "file",
      sha256: hashPath(destination),
    };
    copies.push(evidence);
    boundaryRef = destination;
  }
  writeJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies);
  return {
    copies,
    refs: {
      boundary_trace: boundaryRef,
      request_manifest: requestManifest,
      ...(roleManifest && { role_manifest: roleManifest }),
      ...(subjectManifest && { subject_manifest: subjectManifest }),
      native: [],
      evaluator: [],
      debug: [],
    },
    redaction: emptyAttemptRedaction("not-applicable"),
  };
}

function captureSanitizedPath(
  source: string,
  destination: string,
  redaction: EvidenceRedactionContext
): ReturnType<typeof sanitizeCopyToRetention> {
  try {
    return sanitizeCopyToRetention(source, destination, redaction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new XiaoBaNativeError(
      /contains secret|retained secret/i.test(message) ? "retained_secret_detected" : "redaction_failed",
      message
    );
  }
}

function captureSanitizedEvidence(
  attemptRoot: string,
  scratchRoot: string,
  executionRoot: string,
  boundary: string,
  requestManifest: string,
  validated: ValidatedArenaArtifacts,
  redaction: EvidenceRedactionContext
): CapturedAttemptEvidence {
  if (fs.existsSync(attemptRoot)) fs.rmSync(attemptRoot, { recursive: true, force: true });
  try {
    const copies: XiaoBaEvidenceCopy[] = [];
    const add = (
    layer: XiaoBaEvidenceCopy["layer"],
    component: string,
    source: string,
    retainedPath?: string
  ): XiaoBaEvidenceCopy => {
    if (layer === "native" || layer === "evaluator" || layer === "debug") {
      assertInside(executionRoot, source, `${layer} evidence ref`);
    }
    requiredPath(source, layer === "native" ? "xiaoba_native_trace_missing" : "xiaoba_artifact_ref_invalid");
    const index = copies.length + 1;
    const destination = retainedPath ?? path.join(
      attemptRoot,
      "evidence",
      layer,
      `${String(index).padStart(3, "0")}-${path.basename(source)}`
    );
    const sanitized = captureSanitizedPath(source, destination, redaction);
    const copied: XiaoBaEvidenceCopy = {
      layer,
      component,
      source_ref: scratchRef(scratchRoot, source),
      copied_ref: destination,
      kind: sanitized.kind,
      sha256: sanitized.sanitized_sha256,
      source_sha256: sanitized.source_sha256,
      sanitized_sha256: sanitized.sanitized_sha256,
      replacement_count: sanitized.replacement_count,
      structured_redaction_count: sanitized.structured_redaction_count,
      sanitization_status: sanitized.status,
    };
    copies.push(copied);
    return copied;
  };

  const boundaryCopy = add("boundary", "barena-boundary-trace", boundary, path.join(attemptRoot, "traces", "boundary.ndjson"));
  const requestCopy = add("boundary", "barena-request-manifest", requestManifest, path.join(attemptRoot, "request-manifest.json"));
  const verifierCopy = add("verifier", "barena-artifact-verifier", validated.verifier);
  const nativeCopies = validated.native_refs.map((ref) => add("native", "xiaoba-target-agent-session", ref));
  const evaluatorCopies = validated.evaluator_refs.map((ref) => add("evaluator", "xiaoba-arena-stage", ref));
  const cleanRuntimeCopy = add("debug", "xiaoba-clean-runtime", validated.clean_runtime);
  const arenaRunnerCopy = add("debug", "xiaoba-arena-runner", validated.arena_runner);
  const arenaScorecardCopy = add("debug", "xiaoba-arena-scorecard", validated.arena_scorecard);
  const arenaRunCopy = add("debug", "xiaoba-arena-run", validated.arena_run);
  const roleManifestCopy = add("debug", "xiaoba-role-manifest", validated.role_manifest);
  const subjectManifestCopy = validated.subject_manifest === validated.role_manifest
    ? roleManifestCopy
    : add("debug", "xiaoba-subject-manifest", validated.subject_manifest);

  const initialScan = scanRetainedTreeForSecrets(attemptRoot, redaction);
  if (initialScan.status === "fail") {
    throw new XiaoBaNativeError(
      "retained_secret_detected",
      `Sanitized evidence still contains retained secrets: ${initialScan.hits.map((hit) => hit.secret_name).join(", ")}`
    );
  }
  const finalScan = scanRetainedTreeForSecrets(attemptRoot, redaction);
  const manifestRef = path.join(attemptRoot, "evidence", "redaction-manifest.json");
  const replacementCount = copies.reduce((sum, copy) => sum + (copy.replacement_count ?? 0), 0);
  const structuredRedactionCount = copies.reduce(
    (sum, copy) => sum + (copy.structured_redaction_count ?? 0),
    0
  );
  writeSanitizedJson(manifestRef, {
    schema: "barena.redaction_manifest.v1",
    profile: redaction.profile,
    generated_at: new Date().toISOString(),
    entries: copies,
    replacement_count: replacementCount,
    structured_redaction_count: structuredRedactionCount,
    retained_secret_scan: finalScan,
  }, redaction);
  writeSanitizedJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies, redaction);
  return {
    copies,
    refs: {
      boundary_trace: boundaryCopy.copied_ref,
      request_manifest: requestCopy.copied_ref,
      role_manifest: roleManifestCopy.copied_ref,
      subject_manifest: subjectManifestCopy.copied_ref,
      clean_runtime: cleanRuntimeCopy.copied_ref,
      arena_runner: arenaRunnerCopy.copied_ref,
      arena_scorecard: arenaScorecardCopy.copied_ref,
      arena_run: arenaRunCopy.copied_ref,
      verifier: verifierCopy.copied_ref,
      native: nativeCopies.map((copy) => copy.copied_ref),
      evaluator: evaluatorCopies.map((copy) => copy.copied_ref),
      debug: [
        cleanRuntimeCopy,
        arenaRunnerCopy,
        arenaScorecardCopy,
        arenaRunCopy,
        roleManifestCopy,
        subjectManifestCopy,
      ].map((copy) => copy.copied_ref),
    },
    redaction: {
      status: initialScan.status === "pass" && finalScan.status === "pass" ? "verified" : "failed",
      profile: redaction.profile,
      manifest_ref: manifestRef,
      replacement_count: replacementCount,
      structured_redaction_count: structuredRedactionCount,
      retained_secret_scan: finalScan.status,
      scratch_cleanup: "not_run",
      secret_hits: initialScan.hits.map((hit) => `${path.relative(attemptRoot, hit.file_ref)}:${hit.secret_name}`),
    },
  };
  } catch (error) {
    fs.rmSync(attemptRoot, { recursive: true, force: true });
    throw error;
  }
}

function captureSanitizedBlockedEvidence(
  attemptRoot: string,
  scratchRoot: string,
  boundary: string,
  requestManifest: string,
  roleManifest: string,
  subjectManifest: string,
  redaction: EvidenceRedactionContext,
  providerCallRef?: string
): CapturedAttemptEvidence {
  fs.rmSync(attemptRoot, { recursive: true, force: true });
  try {
    const copies: XiaoBaEvidenceCopy[] = [];
    const addIfFile = (
      layer: XiaoBaEvidenceCopy["layer"],
      component: string,
      source: string,
      retainedPath?: string
    ): XiaoBaEvidenceCopy | undefined => {
      if (!source || !fs.existsSync(source)) return undefined;
      assertInside(scratchRoot, source, `${layer} blocked evidence ref`);
      if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) return undefined;
      const destination = retainedPath ?? path.join(
        attemptRoot,
        "evidence",
        layer,
        `${String(copies.length + 1).padStart(3, "0")}-${path.basename(source)}`
      );
      const sanitized = captureSanitizedPath(source, destination, redaction);
      const copy: XiaoBaEvidenceCopy = {
        layer,
        component,
        source_ref: scratchRef(scratchRoot, source),
        copied_ref: destination,
        kind: sanitized.kind,
        sha256: sanitized.sanitized_sha256,
        source_sha256: sanitized.source_sha256,
        sanitized_sha256: sanitized.sanitized_sha256,
        replacement_count: sanitized.replacement_count,
        structured_redaction_count: sanitized.structured_redaction_count,
        sanitization_status: sanitized.status,
      };
      copies.push(copy);
      return copy;
    };
    const boundaryCopy = addIfFile("boundary", "barena-boundary-trace", boundary, path.join(attemptRoot, "traces", "boundary.ndjson"));
    const requestCopy = addIfFile("boundary", "barena-request-manifest", requestManifest, path.join(attemptRoot, "request-manifest.json"));
    const roleCopy = addIfFile("debug", "xiaoba-role-manifest", roleManifest);
    const subjectCopy = subjectManifest === roleManifest
      ? roleCopy
      : addIfFile("debug", "xiaoba-subject-manifest", subjectManifest);
    const providerCallCopy = providerCallRef
      ? addIfFile("evaluator", "xiaoba-provider-call-records", providerCallRef)
      : undefined;
    const initialScan = scanRetainedTreeForSecrets(attemptRoot, redaction);
    if (initialScan.status === "fail") {
      throw new XiaoBaNativeError("retained_secret_detected", "Blocked evidence could not be sanitized safely.");
    }
    const finalScan = scanRetainedTreeForSecrets(attemptRoot, redaction);
    const replacementCount = copies.reduce((sum, copy) => sum + (copy.replacement_count ?? 0), 0);
    const structuredRedactionCount = copies.reduce((sum, copy) => sum + (copy.structured_redaction_count ?? 0), 0);
    const manifestRef = path.join(attemptRoot, "evidence", "redaction-manifest.json");
    writeSanitizedJson(manifestRef, {
      schema: "barena.redaction_manifest.v1",
      profile: redaction.profile,
      entries: copies,
      replacement_count: replacementCount,
      structured_redaction_count: structuredRedactionCount,
      retained_secret_scan: finalScan,
    }, redaction);
    writeSanitizedJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies, redaction);
    return {
      copies,
      refs: {
        boundary_trace: boundaryCopy?.copied_ref ?? path.join(attemptRoot, "traces", "boundary.ndjson"),
        request_manifest: requestCopy?.copied_ref ?? path.join(attemptRoot, "request-manifest.json"),
        ...(roleCopy && { role_manifest: roleCopy.copied_ref }),
        ...(subjectCopy && { subject_manifest: subjectCopy.copied_ref }),
        native: [],
        evaluator: providerCallCopy ? [providerCallCopy.copied_ref] : [],
        debug: [roleCopy, subjectCopy].filter((copy): copy is XiaoBaEvidenceCopy => Boolean(copy)).map((copy) => copy.copied_ref),
      },
      redaction: {
        status: initialScan.status === "pass" && finalScan.status === "pass" ? "verified" : "failed",
        profile: redaction.profile,
        manifest_ref: manifestRef,
        replacement_count: replacementCount,
        structured_redaction_count: structuredRedactionCount,
        retained_secret_scan: finalScan.status,
        scratch_cleanup: "not_run",
        secret_hits: initialScan.hits.map((hit) => `${path.relative(attemptRoot, hit.file_ref)}:${hit.secret_name}`),
      },
    };
  } catch {
    return writeQuarantinedAttemptPlaceholder(attemptRoot, redaction);
  }
}

function writeQuarantinedAttemptPlaceholder(
  attemptRoot: string,
  redaction: EvidenceRedactionContext
): CapturedAttemptEvidence {
  fs.rmSync(attemptRoot, { recursive: true, force: true });
  const boundaryRef = path.join(attemptRoot, "traces", "boundary.ndjson");
  const requestRef = path.join(attemptRoot, "request-manifest.json");
  const boundaryWrite = writeSanitizedJson(boundaryRef, {
    schema: "barena.quarantined_boundary.v1",
    status: "blocked",
    reason_code: "retained_secret_detected",
  }, redaction);
  const requestWrite = writeSanitizedJson(requestRef, {
    schema: "barena.quarantined_request.v1",
    status: "blocked",
    reason_code: "retained_secret_detected",
  }, redaction);
  const copies: XiaoBaEvidenceCopy[] = [
    {
      layer: "boundary",
      component: "barena-quarantined-boundary",
      source_ref: "scratch://quarantined",
      copied_ref: boundaryRef,
      kind: "file",
      sha256: boundaryWrite.sanitized_sha256,
      source_sha256: boundaryWrite.source_sha256,
      sanitized_sha256: boundaryWrite.sanitized_sha256,
      replacement_count: boundaryWrite.replacement_count,
      structured_redaction_count: boundaryWrite.structured_redaction_count,
      sanitization_status: boundaryWrite.status,
    },
    {
      layer: "boundary",
      component: "barena-quarantined-request",
      source_ref: "scratch://quarantined",
      copied_ref: requestRef,
      kind: "file",
      sha256: requestWrite.sanitized_sha256,
      source_sha256: requestWrite.source_sha256,
      sanitized_sha256: requestWrite.sanitized_sha256,
      replacement_count: requestWrite.replacement_count,
      structured_redaction_count: requestWrite.structured_redaction_count,
      sanitization_status: requestWrite.status,
    },
  ];
  const manifestRef = path.join(attemptRoot, "evidence", "redaction-manifest.json");
  writeSanitizedJson(path.join(attemptRoot, "evidence", "evidence-manifest.json"), copies, redaction);
  writeSanitizedJson(manifestRef, {
    schema: "barena.redaction_manifest.v1",
    profile: redaction.profile,
    status: "failed",
    entries: copies,
    replacement_count: copies.reduce((sum, copy) => sum + (copy.replacement_count ?? 0), 0),
    structured_redaction_count: copies.reduce((sum, copy) => sum + (copy.structured_redaction_count ?? 0), 0),
    retained_secret_scan: { status: "fail", hits: [], scanned_files: copies.length },
  }, redaction);
  return {
    copies,
    refs: {
      boundary_trace: boundaryRef,
      request_manifest: requestRef,
      native: [],
      evaluator: [],
      debug: [],
    },
    redaction: {
      ...emptyAttemptRedaction(redaction.profile),
      status: "failed",
      manifest_ref: manifestRef,
      retained_secret_scan: "fail",
    },
  };
}

function redactionContext(
  policy: XiaoBaLivePolicyV1,
  environment: NodeJS.ProcessEnv,
  passEnv: string[]
): EvidenceRedactionContext {
  return {
    profile: policy.redaction.profile,
    secrets: collectLiveSecretValues(policy, environment, passEnv),
    structured_field_names: policy.redaction.structured_field_names,
  };
}

function providerCallRecordsFromEvidence(
  evidenceRefs: string[],
  arm: XiaoBaNativeArm,
  caseDefinition: XiaoBaNativeCaseV1,
  attempt: number,
  policy: XiaoBaLivePolicyV1,
  runtimeContract: XiaoBaLiveRuntimeContractV1,
): XiaoBaProviderCallObservation {
  const refs = [...new Set(evidenceRefs.filter((ref) => /provider-calls.*\.ndjson$/i.test(path.basename(ref))))].sort();
  const records: XiaoBaProviderCallRecord[] = [];
  const errors: string[] = [];
  const identityErrors: string[] = [];
  const callIds = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  let rawCallCount = 0;
  for (const ref of refs) {
    if (!fs.existsSync(ref) || !fs.statSync(ref).isFile()) {
      errors.push(`missing_provider_call_evidence:${ref}`);
      continue;
    }
    for (const [index, line] of fs.readFileSync(ref, "utf8").split(/\r?\n/).filter(Boolean).entries()) {
      let value: JsonRecord;
      try {
        value = JSON.parse(line) as JsonRecord;
      } catch {
        errors.push(`invalid_provider_call_json:${path.basename(ref)}:${index + 1}`);
        continue;
      }
      if (value.schema !== "barena.provider_call.v1") {
        errors.push(`invalid_provider_call_schema:${path.basename(ref)}:${index + 1}`);
        continue;
      }
      rawCallCount += 1;
      const callId = typeof value.call_id === "string" && value.call_id.trim() ? value.call_id.trim() : undefined;
      const rawProvider = typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : undefined;
      const rawModel = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
      if (rawProvider) providers.add(rawProvider);
      else identityErrors.push(`missing_provider_identity:${path.basename(ref)}:${index + 1}`);
      if (rawModel) models.add(rawModel);
      else identityErrors.push(`missing_model_identity:${path.basename(ref)}:${index + 1}`);
      const component = typeof value.component === "string" && PROVIDER_CALL_COMPONENTS.has(value.component)
        ? value.component as XiaoBaProviderCallRecord["component"]
        : undefined;
      const provider = rawProvider;
      const model = rawModel;
      const inputTokens = nonNegativeIntegerValue(value.input_tokens);
      const outputTokens = nonNegativeIntegerValue(value.output_tokens);
      const requestedOutputLimit = positiveIntegerValue(value.requested_output_limit);
      const configuredMaxRetries = nonNegativeIntegerValue(value.configured_max_retries);
      const observedRetries = nonNegativeIntegerValue(value.observed_retries);
      const billedCost = value.billed_cost_usd === undefined || value.billed_cost_usd === null
        ? null
        : nonNegativeNumberValue(value.billed_cost_usd);
      if (
        !callId || !component || !provider || !model || inputTokens === undefined || outputTokens === undefined ||
        requestedOutputLimit === undefined || configuredMaxRetries === undefined || observedRetries === undefined ||
        billedCost === undefined
      ) {
        errors.push(`incomplete_provider_call_record:${path.basename(ref)}:${index + 1}`);
        continue;
      }
      if (callIds.has(callId)) {
        errors.push(`duplicate_provider_call_id:${callId}`);
        continue;
      }
      callIds.add(callId);
      records.push({
        schema: "barena.provider_call.v1",
        call_id: callId,
        arm,
        case_id: caseDefinition.case_id,
        attempt,
        component,
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        requested_output_limit: requestedOutputLimit,
        configured_max_retries: configuredMaxRetries,
        observed_retries: observedRetries,
        estimated_cost_usd: estimatedUsageCostUsd(inputTokens, outputTokens, policy),
        billed_cost_usd: billedCost,
        evidence_ref: ref,
      });
    }
  }
  const reserved = providerCallReservationForCase(caseDefinition, runtimeContract);
  for (const component of PROVIDER_CALL_COMPONENTS) {
    const observed = records.filter((record) => record.component === component).length;
    if (observed > reserved[component as keyof typeof reserved]) {
      errors.push(`provider_call_reservation_exceeded:${component}:${observed}>${reserved[component as keyof typeof reserved]}`);
    }
  }
  const requiredComponents: Array<"target" | "usercat"> = ["target"];
  if ((caseDefinition.max_turns ?? 4) > 1) requiredComponents.push("usercat");
  for (const component of requiredComponents) {
    if (!records.some((record) => record.component === component)) {
      errors.push(`missing_provider_call_component:${component}`);
    }
  }
  return {
    records,
    raw_call_count: rawCallCount,
    observed_providers: [...providers].sort(),
    observed_models: [...models].sort(),
    identity_errors: [...new Set(identityErrors)].sort(),
    errors: [...new Set(errors)].sort(),
    evidence_refs: refs,
  };
}

function providerCallReservationForCase(
  caseDefinition: XiaoBaNativeCaseV1,
  runtimeContract: XiaoBaLiveRuntimeContractV1,
): Record<XiaoBaProviderCallRecord["component"], number> {
  const maxTurns = caseDefinition.max_turns ?? 4;
  const replayAttempts = caseDefinition.replay_attempts ?? 1;
  const maxReplayCases = caseDefinition.max_replay_cases ?? 1;
  return {
    target: maxTurns * runtimeContract.bounds.target_calls_per_turn,
    usercat: Math.max(0, maxTurns - 1) * runtimeContract.bounds.usercat_calls_per_turn,
    inspector: runtimeContract.bounds.inspector_calls_per_attempt,
    reviewer: runtimeContract.bounds.reviewer_calls_per_attempt,
    replay: replayAttempts * maxReplayCases * maxTurns * runtimeContract.bounds.replay_calls_per_case_turn,
  };
}

function providerIdentityFromCallRecords(
  policy: XiaoBaLivePolicyV1,
  observation: XiaoBaProviderCallObservation
): XiaoBaProviderIdentityEvidence {
  const providers = observation.observed_providers;
  const models = observation.observed_models;
  const mismatch = providers.some((provider) => provider !== policy.provider) ||
    models.some((model) => model !== policy.model);
  const complete = observation.raw_call_count > 0 && observation.identity_errors.length === 0;
  return {
    provider: policy.provider,
    model: policy.model,
    source: observation.raw_call_count > 0 ? "live_policy_and_trace" : "live_policy",
    status: mismatch ? "mismatch" : complete ? "verified" : "unverified",
    observed_providers: providers,
    observed_models: models,
    evidence_refs: observation.evidence_refs,
  };
}

function usageFromCallRecords(
  policy: XiaoBaLivePolicyV1,
  observation: XiaoBaProviderCallObservation
): XiaoBaObservedUsage {
  const inputTokens = observation.records.reduce((sum, record) => sum + record.input_tokens, 0);
  const outputTokens = observation.records.reduce((sum, record) => sum + record.output_tokens, 0);
  const billedComplete = observation.records.length > 0 && observation.records.every((record) => record.billed_cost_usd !== null);
  const complete = observation.records.length > 0 && observation.errors.length === 0;
  const estimatedCost = observation.records.length > 0
    ? estimatedUsageCostUsd(inputTokens, outputTokens, policy)
    : null;
  const billedCost = billedComplete
    ? roundUsd(observation.records.reduce((sum, record) => sum + Number(record.billed_cost_usd), 0))
    : null;
  return {
    status: complete ? "complete" : observation.raw_call_count > 0 ? "incomplete" : "not_observed",
    provider_calls: observation.raw_call_count || null,
    input_tokens: observation.records.length ? inputTokens : null,
    output_tokens: observation.records.length ? outputTokens : null,
    total_tokens: observation.records.length ? inputTokens + outputTokens : null,
    estimated_cost_usd: estimatedCost,
    billed_cost_usd: billedCost,
    cost_basis: billedCost !== null ? "billed" : estimatedCost !== null ? "estimated" : "unavailable",
    call_records: observation.records,
    evidence_refs: observation.evidence_refs,
    missing_fields: observation.errors,
  };
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function providerIdentityFromObservation(
  policy: XiaoBaLivePolicyV1,
  observation: XiaoBaTraceObservation,
  evidenceRefs: string[]
): XiaoBaProviderIdentityEvidence {
  const providers = observation.observed_providers;
  const models = observation.observed_models;
  const missing = providers.length === 0 || models.length === 0;
  const mismatch = providers.some((provider) => provider !== policy.provider) ||
    models.some((model) => model !== policy.model);
  return {
    provider: policy.provider,
    model: policy.model,
    source: providers.length || models.length ? "live_policy_and_trace" : "live_policy",
    status: mismatch ? "mismatch" : missing ? "unverified" : "verified",
    observed_providers: providers,
    observed_models: models,
    evidence_refs: evidenceRefs,
  };
}

function usageFromObservation(
  policy: XiaoBaLivePolicyV1,
  observation: XiaoBaTraceObservation,
  evidenceRefs: string[]
): XiaoBaObservedUsage {
  const missingFields = [...observation.missing_usage_fields];
  const complete = observation.provider_calls > 0 &&
    observation.input_tokens !== null &&
    observation.output_tokens !== null &&
    missingFields.length === 0;
  const estimatedCost = complete
    ? estimatedUsageCostUsd(observation.input_tokens!, observation.output_tokens!, policy)
    : null;
  return {
    status: complete ? "complete" : observation.provider_calls > 0 ? "incomplete" : "not_observed",
    provider_calls: observation.provider_calls || null,
    input_tokens: observation.input_tokens,
    output_tokens: observation.output_tokens,
    total_tokens: observation.input_tokens !== null && observation.output_tokens !== null
      ? observation.input_tokens + observation.output_tokens
      : null,
    estimated_cost_usd: estimatedCost,
    billed_cost_usd: null,
    cost_basis: estimatedCost === null ? "unavailable" : "estimated",
    call_records: [],
    evidence_refs: evidenceRefs,
    missing_fields: missingFields,
  };
}

function liveArmFailure(
  arm: XiaoBaNativeArm,
  attempts: XiaoBaNativeAttemptResult[],
  policy: XiaoBaLivePolicyV1,
  remainingPlannedCalls = 0
): LiveArmFailure | undefined {
  const blocked = attempts.find((attempt) => attempt.status === "blocked");
  if (blocked) return { reason: blocked.reason_code ?? "xiaoba_runner_failed", summary: blocked.detail };
  const unsafe = attempts.find((attempt) => attempt.status === "unsafe");
  if (unsafe) {
    return {
      reason: "xiaoba_arena_unsafe",
      summary: arm === "baseline"
        ? "Baseline native execution is unsafe; candidate execution was not started."
        : "Candidate native execution is unsafe; later paid attempts were not started.",
    };
  }
  if (arm === "baseline") {
    const invalidBaseline = attempts.find((attempt) =>
      ["xiaoba_arena_unstable", "xiaoba_arena_reopened"].includes(String(attempt.reason_code))
    );
    if (invalidBaseline) {
      return {
        reason: invalidBaseline.reason_code ?? "xiaoba_arena_unstable",
        summary: `Baseline native execution is ${invalidBaseline.native_decision ?? invalidBaseline.status}; candidate execution was not started.`,
      };
    }
  }
  const identityMismatch = attempts.find((attempt) => attempt.provider_identity?.status === "mismatch");
  if (identityMismatch) {
    return { reason: "provider_identity_mismatch", summary: `${capitalizeArm(arm)} provider-call identity does not match the bound live policy.` };
  }
  const identityMissing = attempts.find((attempt) => attempt.provider_identity?.status !== "verified");
  if (identityMissing) {
    return { reason: "provider_identity_unverified", summary: `${capitalizeArm(arm)} provider-call records do not verify provider and model identity for every call.` };
  }
  const usageMissing = attempts.find((attempt) => attempt.usage?.status !== "complete");
  if (usageMissing || attempts.length === 0) {
    return {
      reason: arm === "baseline" ? "baseline_usage_incomplete" : "candidate_usage_incomplete",
      summary: `${capitalizeArm(arm)} target/evaluator provider-call usage or cost evidence is incomplete.`,
    };
  }
  const records = attempts.flatMap((attempt) => attempt.usage?.call_records ?? []);
  if (records.some((record) => record.configured_max_retries !== 0 || record.observed_retries !== 0)) {
    return {
      reason: "live_retry_control_unverified",
      summary: `${capitalizeArm(arm)} provider-call evidence reports configured or observed automatic retries.`,
    };
  }
  if (records.some((record) =>
    record.input_tokens > policy.max_input_tokens ||
    record.output_tokens > policy.max_output_tokens ||
    record.requested_output_limit > policy.max_output_tokens
  )) {
    return {
      reason: "usage_limit_exceeded",
      summary: `${capitalizeArm(arm)} contains a provider call that exceeds its per-call token ceiling.`,
    };
  }
  const redactionFailure = attempts.find((attempt) =>
    attempt.redaction?.status !== "verified" ||
    attempt.redaction.retained_secret_scan !== "pass" ||
    attempt.redaction.scratch_cleanup !== "verified"
  );
  if (redactionFailure) {
    return {
      reason: redactionFailure.reason_code ?? "redaction_failed",
      summary: `${capitalizeArm(arm)} evidence redaction or scratch cleanup is incomplete.`,
    };
  }
  const calls = records.length;
  const inputTokens = records.reduce((sum, record) => sum + record.input_tokens, 0);
  const outputTokens = records.reduce((sum, record) => sum + record.output_tokens, 0);
  const cost = estimatedUsageCostUsd(inputTokens, outputTokens, policy);
  const perCallWorstCase = estimatedUsageCostUsd(
    policy.max_input_tokens,
    policy.max_output_tokens,
    policy
  );
  const effectiveCap = Math.min(policy.budget_usd, policy.hard_limit.cap_usd);
  const cannotReserveRemainingCalls = calls + remainingPlannedCalls > policy.max_provider_calls ||
    cost + perCallWorstCase * remainingPlannedCalls > effectiveCap + Number.EPSILON;
  if (calls > policy.max_provider_calls || cost > effectiveCap + Number.EPSILON || cannotReserveRemainingCalls) {
    return {
      reason: "usage_limit_exceeded",
      summary: `${capitalizeArm(arm)} observed usage or the conservative remaining reservation exceeds the bound live policy.`,
    };
  }
  return undefined;
}

function attachLiveNotReady(
  result: XiaoBaCapabilityEvaluationResultV1,
  input: RunXiaoBaNativeEvaluationInput,
  policy: XiaoBaLivePolicyV1,
  retainedPolicyRef?: string,
  preflightRedactionManifestRef?: string
): void {
  result.live = {
    enabled: true,
    preflight_only: Boolean(input.preflight_only),
    ready_to_invoke: false,
    model_invoked: false,
    no_automatic_paid_retry: false,
    retry_control_status: "unverified",
    runtime_contract_status: "unsupported",
    ...(retainedPolicyRef && { policy_ref: retainedPolicyRef }),
    ...(input.live_policy_binding && {
      source_policy_ref: input.live_policy_binding.policy_ref,
      source_policy_sha256: input.live_policy_binding.source_sha256,
      canonical_policy_sha256: input.live_policy_binding.canonical_sha256,
    }),
  };
  result.provider_identity = {
    provider: policy.provider,
    model: policy.model,
    source: "live_policy",
    status: "configured",
    evidence_refs: retainedPolicyRef ? [retainedPolicyRef] : [],
  };
  result.redaction = {
    status: preflightRedactionManifestRef ? "verified" : "not_run",
    profile: policy.redaction.profile,
    manifest_refs: preflightRedactionManifestRef ? [preflightRedactionManifestRef] : [],
    replacement_count: 0,
    structured_redaction_count: 0,
    retained_secret_scan: preflightRedactionManifestRef ? "pass" : "not_run",
    scratch_cleanup: "not_run",
    secret_hits: [],
  };
  result.evidence_refs = [...new Set([
    ...result.evidence_refs,
    ...(retainedPolicyRef ? [retainedPolicyRef] : []),
    ...(preflightRedactionManifestRef ? [preflightRedactionManifestRef] : []),
  ])];
}

function attachLiveResult(
  result: XiaoBaCapabilityEvaluationResultV1,
  input: RunXiaoBaNativeEvaluationInput,
  preflight: XiaoBaLivePolicyPreflight,
  preflightRef: string,
  baselineAttempts: XiaoBaNativeAttemptResult[],
  candidateAttempts: XiaoBaNativeAttemptResult[],
  ledger?: LiveExecutionLedger
): void {
  const attempts = [...baselineAttempts, ...candidateAttempts];
  const usage = aggregateLiveUsage(preflight, baselineAttempts, candidateAttempts);
  const identity = aggregateProviderIdentity(preflight.provider_identity, attempts);
  const redaction = summarizeRedaction(
    attempts,
    preflight.redaction.profile,
    { status: "pass", hits: [] },
    attempts.length === 0 ? "not_run" : attempts.every((attempt) => attempt.redaction?.retained_secret_scan === "pass") ? "pass" : "fail"
  );
  if (preflight.redaction.manifest_ref) {
    redaction.manifest_refs = [...new Set([preflight.redaction.manifest_ref, ...redaction.manifest_refs])];
    if (attempts.length === 0) {
      redaction.status = "verified";
      redaction.retained_secret_scan = "pass";
    }
  }
  result.live = {
    enabled: true,
    preflight_only: Boolean(input.preflight_only),
    ready_to_invoke: preflight.ready_to_invoke,
    model_invoked: ledger?.model_invoked ?? (attempts.length === 0 ? false : null),
    no_automatic_paid_retry: preflight.budget.enforcement.no_automatic_paid_retry,
    retry_control_status: preflight.budget.enforcement.retry_control_status,
    runtime_contract_status: preflight.runtime_contract.status,
    ...(preflight.policy_ref && { policy_ref: preflight.policy_ref }),
    ...(preflight.source_policy_ref && { source_policy_ref: preflight.source_policy_ref }),
    ...(preflight.source_policy_sha256 && { source_policy_sha256: preflight.source_policy_sha256 }),
    ...(preflight.canonical_policy_sha256 && { canonical_policy_sha256: preflight.canonical_policy_sha256 }),
    ...(preflight.retained_policy_sha256 && { retained_policy_sha256: preflight.retained_policy_sha256 }),
    preflight_ref: preflightRef,
  };
  result.provider_identity = identity;
  result.usage = usage;
  const observedCost = usage.estimated_cost_usd;
  result.budget = {
    ...preflight.budget,
    observed_estimated_cost_usd: observedCost,
    remaining_budget_usd: observedCost === null
      ? null
      : roundUsd(Math.max(0, preflight.budget.budget_usd - observedCost)),
  };
  result.redaction = redaction;
  result.evidence_refs = [...new Set([
    ...result.evidence_refs,
    preflightRef,
    ...(preflight.policy_ref ? [preflight.policy_ref] : []),
    ...(preflight.redaction.manifest_ref ? [preflight.redaction.manifest_ref] : []),
    ...attempts.flatMap((attempt) => attempt.redaction?.manifest_ref ? [attempt.redaction.manifest_ref] : []),
  ])];
  if (attempts.length > 0 && (
    usage.status !== "complete" || identity.status !== "verified" || redaction.status !== "verified"
  )) {
    result.quality.required_evidence_complete = false;
  }
  const blockingAttempt = attempts.find((attempt) => attempt.status === "blocked");
  if (!blockingAttempt && usage.status === "complete" && (!usage.within_provider_call_limit || !usage.within_budget)) {
    applyDecisionProposal(
      result,
      "held",
      "usage_limit_exceeded",
      "Observed provider calls or estimated cost exceeded the bound live policy."
    );
  }
  if (!blockingAttempt && identity.status === "mismatch") {
    applyDecisionProposal(
      result,
      "held",
      "provider_identity_mismatch",
      "Observed provider/model identity does not match the live policy."
    );
  } else if (!blockingAttempt && attempts.length > 0 && identity.status !== "verified") {
    applyDecisionProposal(
      result,
      "held",
      "provider_identity_unverified",
      "Observed evidence does not verify provider/model identity for every provider call."
    );
  }
}

function aggregateLiveUsage(
  preflight: XiaoBaLivePolicyPreflight,
  baselineAttempts: XiaoBaNativeAttemptResult[],
  candidateAttempts: XiaoBaNativeAttemptResult[]
): XiaoBaAggregateUsage {
  const attempts = [...baselineAttempts, ...candidateAttempts];
  const observed = attempts.filter((attempt) => attempt.usage);
  const callRecords = attempts.flatMap((attempt) => attempt.usage?.call_records ?? []);
  const complete = attempts.length === preflight.budget.planned_barena_attempts &&
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.usage?.status === "complete");
  const known = (field: "provider_calls" | "input_tokens" | "output_tokens"): number | null => {
    const values = attempts
      .map((attempt) => attempt.usage?.[field])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const providerCalls = known("provider_calls");
  const inputTokens = known("input_tokens");
  const outputTokens = known("output_tokens");
  const estimatedCost = inputTokens !== null && outputTokens !== null
    ? roundUsd((
        inputTokens * preflight.budget.pricing.input_usd_per_million_tokens +
        outputTokens * preflight.budget.pricing.output_usd_per_million_tokens
      ) / 1_000_000)
    : attempts
        .map((attempt) => attempt.usage?.estimated_cost_usd)
        .filter((value): value is number => typeof value === "number")
        .reduce<number | null>((sum, value) => sum === null ? value : sum + value, null);
  const billedComplete = callRecords.length > 0 && callRecords.every((record) => record.billed_cost_usd !== null);
  const billedCost = billedComplete
    ? roundUsd(callRecords.reduce((sum, record) => sum + Number(record.billed_cost_usd), 0))
    : null;
  const missingFields = [...new Set([
    ...attempts.flatMap((attempt) => attempt.usage?.missing_fields ?? ["usage"]),
    ...(attempts.length < preflight.budget.planned_barena_attempts ? ["unobserved_attempts"] : []),
  ])].sort();
  const plannedPerArm = preflight.budget.planned_barena_attempts / 2;
  const baselineComplete = baselineAttempts.length === plannedPerArm && baselineAttempts.every((attempt) => attempt.usage?.status === "complete");
  const candidateComplete = candidateAttempts.length === plannedPerArm && candidateAttempts.every((attempt) => attempt.usage?.status === "complete");
  const effectiveCap = Math.min(preflight.budget.budget_usd, preflight.budget.hard_limit.cap_usd);
  return {
    status: complete ? "complete" : attempts.length > 0 ? "incomplete" : "not_observed",
    provider_calls: providerCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    estimated_cost_usd: estimatedCost === null ? null : roundUsd(estimatedCost),
    billed_cost_usd: billedCost,
    cost_basis: billedCost !== null ? "billed" : estimatedCost === null ? "unavailable" : "estimated",
    call_records: callRecords,
    evidence_refs: [...new Set(attempts.flatMap((attempt) => attempt.usage?.evidence_refs ?? []))],
    missing_fields: complete ? [] : missingFields,
    planned_attempts: preflight.budget.planned_barena_attempts,
    observed_attempts: observed.length,
    planned_barena_attempts: preflight.budget.planned_barena_attempts,
    observed_barena_attempts: attempts.length,
    baseline_complete: baselineComplete,
    candidate_complete: candidateComplete,
    within_provider_call_limit: providerCalls !== null && providerCalls <= preflight.budget.max_provider_calls,
    within_budget: estimatedCost !== null && estimatedCost <= effectiveCap + Number.EPSILON,
  };
}

function aggregateProviderIdentity(
  configured: XiaoBaProviderIdentityEvidence,
  attempts: XiaoBaNativeAttemptResult[]
): XiaoBaProviderIdentityEvidence {
  if (attempts.length === 0) return configured;
  const providers = [...new Set(attempts.flatMap((attempt) => attempt.provider_identity?.observed_providers ?? []))].sort();
  const models = [...new Set(attempts.flatMap((attempt) => attempt.provider_identity?.observed_models ?? []))].sort();
  const statuses = attempts.map((attempt) => attempt.provider_identity?.status ?? "unverified");
  const status = statuses.includes("mismatch")
    ? "mismatch"
    : statuses.every((value) => value === "verified")
      ? "verified"
      : "unverified";
  return {
    provider: configured.provider,
    model: configured.model,
    source: providers.length || models.length ? "live_policy_and_trace" : "live_policy",
    status,
    observed_providers: providers,
    observed_models: models,
    evidence_refs: [...new Set(attempts.flatMap((attempt) => attempt.provider_identity?.evidence_refs ?? []))],
  };
}

function summarizeRedaction(
  attempts: XiaoBaNativeAttemptResult[],
  profile: string,
  scan: { status: "pass" | "fail"; hits: Array<{ file_ref: string; secret_name: string }> },
  finalScanStatus: "pass" | "fail" | "not_run"
): XiaoBaRedactionSummary {
  const records = attempts.map((attempt) => attempt.redaction).filter((value): value is XiaoBaAttemptRedaction => Boolean(value));
  const noAttempts = records.length === 0;
  const attemptFailure = records.some((record) => record.status !== "verified");
  const cleanup = noAttempts
    ? "not_run"
    : records.every((record) => record.scratch_cleanup === "verified") ? "verified" : "failed";
  const retainedScan = finalScanStatus;
  return {
    status: noAttempts && finalScanStatus === "not_run"
      ? "not_run"
      : attemptFailure || scan.status === "fail" || finalScanStatus === "fail" || cleanup === "failed" ? "failed" : "verified",
    profile,
    manifest_refs: records.flatMap((record) => record.manifest_ref ? [record.manifest_ref] : []),
    replacement_count: records.reduce((sum, record) => sum + record.replacement_count, 0),
    structured_redaction_count: records.reduce((sum, record) => sum + record.structured_redaction_count, 0),
    retained_secret_scan: retainedScan,
    scratch_cleanup: cleanup,
    secret_hits: [
      ...records.flatMap((record) => record.secret_hits),
      ...scan.hits.map((hit) => `${hit.file_ref}:${hit.secret_name}`),
    ],
  };
}

function emptyAttemptRedaction(profile: string): XiaoBaAttemptRedaction {
  return {
    status: "not_run",
    profile,
    replacement_count: 0,
    structured_redaction_count: 0,
    retained_secret_scan: "not_run",
    scratch_cleanup: "not_run",
    secret_hits: [],
  };
}

function scratchRef(scratchRoot: string, value: string): string {
  const relative = path.relative(path.resolve(scratchRoot), path.resolve(value));
  if (relative === "" || relative === ".") return "scratch://";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return `scratch-external://${path.basename(value)}`;
  }
  return `scratch://${relative.split(path.sep).join("/")}`;
}

function cleanupScratchRoot(scratchRoot: string, cleanup: (root: string) => void): boolean {
  try {
    cleanup(scratchRoot);
  } catch {
    return false;
  }
  try {
    fs.lstatSync(scratchRoot);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function removeOwnedScratchRoot(scratchRoot: string): void {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(scratchRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Owned scratch root is not a directory: ${scratchRoot}`);
  }

  restoreScratchDirectoryPermissions(scratchRoot, rootStat);
  fs.rmSync(scratchRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

function restoreScratchDirectoryPermissions(directory: string, stat: fs.Stats): void {
  if ((stat.mode & 0o700) !== 0o700) {
    fs.chmodSync(directory, stat.mode | 0o700);
  }
  for (const entry of fs.readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const entryStat = fs.lstatSync(entryPath);
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue;
    restoreScratchDirectoryPermissions(entryPath, entryStat);
  }
}

function quarantineRetainedSecretHits(
  root: string,
  result: XiaoBaCapabilityEvaluationResultV1,
  hits: Array<{ file_ref: string; secret_name: string }>,
  redaction: EvidenceRedactionContext
): void {
  const absoluteRoot = path.resolve(root);
  const attempts = [...result.baseline.attempts, ...result.candidate.attempts];
  const hitPaths = [...new Set(hits.map((hit) => path.resolve(hit.file_ref)))]
    .filter((hitPath) => isContainedOrEqual(absoluteRoot, hitPath));
  const removals = new Set(hitPaths);
  const affected = new Set<XiaoBaNativeAttemptResult>();

  for (const attempt of attempts) {
    const attemptRoot = retainedAttemptRoot(absoluteRoot, attempt);
    if (hitPaths.some((hitPath) => pathsOverlap(attemptRoot, hitPath))) affected.add(attempt);
    for (const copy of attempt.evidence) {
      if (hitPaths.some((hitPath) => pathsOverlap(copy.copied_ref, hitPath))) {
        removals.add(path.resolve(copy.copied_ref));
        affected.add(attempt);
      }
    }
  }

  for (const removal of [...removals].sort((left, right) => left.length - right.length)) {
    if (!isContainedOrEqual(absoluteRoot, removal)) continue;
    try {
      fs.chmodSync(path.dirname(removal), 0o755);
    } catch {
      // Continue to the removal attempt and fail closed on the next scan.
    }
    try {
      fs.rmSync(removal, { force: true, recursive: true });
    } catch {
      // The next retained-tree scan will keep the run held.
    }
  }

  for (const attempt of attempts) {
    const originalCopies = attempt.evidence;
    attempt.evidence = originalCopies.filter((copy) => retainedPathExists(copy.copied_ref));
    const lostCopy = attempt.evidence.length !== originalCopies.length;
    if (lostCopy) affected.add(attempt);
    pruneAttemptRefs(attempt);
    if (!affected.has(attempt)) continue;

    if (attempt.status !== "unsafe") {
      attempt.status = "blocked";
      attempt.reason_code = "retained_secret_detected";
      attempt.detail = "Retained attempt evidence was quarantined after secret scanning.";
    } else {
      attempt.detail += " Retained attempt evidence was also quarantined after secret scanning.";
    }
    attempt.activation.observed = false;
    attempt.assertions = [];
    if (attempt.provider_identity) {
      attempt.provider_identity.status = "unverified";
      attempt.provider_identity.evidence_refs = attempt.provider_identity.evidence_refs.filter(retainedPathExists);
    }
    if (attempt.usage) {
      attempt.usage = {
        ...attempt.usage,
        status: "incomplete",
        call_records: attempt.usage.call_records.map((record) => ({
          ...record,
          evidence_ref: retainedPathExists(record.evidence_ref)
            ? record.evidence_ref
            : "quarantined://provider-call-evidence",
        })),
        evidence_refs: attempt.usage.evidence_refs.filter(retainedPathExists),
        missing_fields: [...new Set([...attempt.usage.missing_fields, "quarantined_evidence"])].sort(),
      };
    }

    const attemptRoot = retainedAttemptRoot(absoluteRoot, attempt);
    const hitNames = hits
      .filter((hit) => pathsOverlap(attemptRoot, path.resolve(hit.file_ref)))
      .map((hit) => hit.secret_name);
    const replacementCount = attempt.evidence.reduce((sum, copy) => sum + (copy.replacement_count ?? 0), 0);
    const structuredRedactionCount = attempt.evidence.reduce(
      (sum, copy) => sum + (copy.structured_redaction_count ?? 0),
      0
    );
    attempt.redaction = {
      ...(attempt.redaction ?? emptyAttemptRedaction(redaction.profile)),
      status: "failed",
      replacement_count: replacementCount,
      structured_redaction_count: structuredRedactionCount,
      retained_secret_scan: "fail",
      secret_hits: [...new Set([
        ...(attempt.redaction?.secret_hits ?? []),
        ...hitNames.map((name) => `quarantined:${name}`),
      ])],
    };

    if (fs.existsSync(attemptRoot) && fs.statSync(attemptRoot).isDirectory()) {
      const evidenceManifestRef = path.join(attemptRoot, "evidence", "evidence-manifest.json");
      const redactionManifestRef = path.join(attemptRoot, "evidence", "redaction-manifest.json");
      writeSanitizedJson(evidenceManifestRef, attempt.evidence, redaction);
      writeSanitizedJson(redactionManifestRef, {
        schema: "barena.redaction_manifest.v1",
        profile: redaction.profile,
        status: "failed",
        entries: attempt.evidence,
        replacement_count: replacementCount,
        structured_redaction_count: structuredRedactionCount,
        retained_secret_scan: {
          status: "fail",
          hits: [...new Set(hitNames)].map((secret_name) => ({ secret_name })),
          scanned_files: attempt.evidence.length,
        },
      }, redaction);
      attempt.redaction.manifest_ref = redactionManifestRef;
    } else {
      delete attempt.redaction.manifest_ref;
    }
  }

  result.baseline.evidence_complete = retainedArmEvidenceComplete(result.baseline);
  result.candidate.evidence_complete = retainedArmEvidenceComplete(result.candidate);
  result.quality.required_evidence_complete = false;
  result.outcome_truth.status = "unverified";
  result.outcome_truth.verifier_backed_attempts = attempts.filter((attempt) => attempt.assertions.length > 0).length;
  result.evidence_refs = [...new Set([
    ...result.evidence_refs.filter(retainedPathExists),
    ...attempts.flatMap((attempt) => attempt.evidence.map((copy) => copy.copied_ref)),
    ...attempts.flatMap((attempt) => attempt.redaction?.manifest_ref ? [attempt.redaction.manifest_ref] : []),
  ])];
  result.debug_refs = [...new Set(attempts.flatMap((attempt) => attempt.refs.debug).filter(retainedPathExists))];
  if (!retainedPathExists(result.request_ref)) result.request_ref = "quarantined://evaluation-request";
  if (result.live?.policy_ref && !retainedPathExists(result.live.policy_ref)) delete result.live.policy_ref;
  if (result.live?.preflight_ref && !retainedPathExists(result.live.preflight_ref)) delete result.live.preflight_ref;
  if (result.provider_identity) {
    result.provider_identity.status = "unverified";
    result.provider_identity.evidence_refs = result.provider_identity.evidence_refs.filter(retainedPathExists);
  }
  if (result.usage) {
    result.usage = {
      ...result.usage,
      status: "incomplete",
      call_records: result.usage.call_records.map((record) => ({
        ...record,
        evidence_ref: retainedPathExists(record.evidence_ref)
          ? record.evidence_ref
          : "quarantined://provider-call-evidence",
      })),
      evidence_refs: result.usage.evidence_refs.filter(retainedPathExists),
      missing_fields: [...new Set([...result.usage.missing_fields, "quarantined_evidence"])].sort(),
    };
  }
  if (result.admission) {
    result.admission.evidence_refs = result.admission.evidence_refs.filter(retainedPathExists);
    for (const subject of result.admission.subjects) {
      if (!retainedPathExists(subject.snapshot_ref)) subject.snapshot_ref = "quarantined://snapshot";
      if (!retainedPathExists(subject.scan_ref)) subject.scan_ref = "quarantined://scan";
    }
    result.admission.evidence_complete = result.admission.evidence_refs.length === result.admission.subjects.length + 1 &&
      result.admission.subjects.every((subject) => retainedPathExists(subject.snapshot_ref) && retainedPathExists(subject.scan_ref));
  }
  if (result.redaction) {
    result.redaction.manifest_refs = result.redaction.manifest_refs.filter(retainedPathExists);
  }
  reconcileRetainedManifests(absoluteRoot, redaction);
}

function pruneAttemptRefs(attempt: XiaoBaNativeAttemptResult): void {
  attempt.refs.native = attempt.refs.native.filter(retainedPathExists);
  attempt.refs.evaluator = attempt.refs.evaluator.filter(retainedPathExists);
  attempt.refs.debug = attempt.refs.debug.filter(retainedPathExists);
  if (!retainedPathExists(attempt.refs.boundary_trace)) attempt.refs.boundary_trace = "quarantined://boundary";
  if (!retainedPathExists(attempt.refs.request_manifest)) attempt.refs.request_manifest = "quarantined://request";
  for (const key of [
    "role_manifest",
    "subject_manifest",
    "clean_runtime",
    "arena_runner",
    "arena_scorecard",
    "arena_run",
    "verifier",
  ] as const) {
    const ref = attempt.refs[key];
    if (ref && !retainedPathExists(ref)) delete attempt.refs[key];
  }
}

function retainedAttemptRoot(root: string, attempt: XiaoBaNativeAttemptResult): string {
  return path.join(root, "arms", attempt.arm, attempt.case_id, `attempt-${attempt.attempt}`);
}

function retainedArmEvidenceComplete(arm: XiaoBaNativeArmResult): boolean {
  return arm.attempts.length === arm.counts.planned && arm.attempts.every((attempt) =>
    attempt.redaction?.status === "verified" &&
    attempt.evidence.some((entry) => entry.layer === "boundary") &&
    attempt.evidence.some((entry) => entry.layer === "native") &&
    attempt.evidence.some((entry) => entry.layer === "evaluator") &&
    attempt.evidence.some((entry) => entry.layer === "verifier") &&
    attempt.evidence.every((entry) => retainedPathExists(entry.copied_ref))
  );
}

function reconcileRetainedManifests(root: string, redaction: EvidenceRedactionContext): void {
  for (const manifestRef of findFilesNamed(root, "evidence-manifest.json")) {
    try {
      const value = readJson<unknown>(manifestRef);
      if (!Array.isArray(value)) continue;
      writeSanitizedJson(
        manifestRef,
        value.filter((entry) => isRecord(entry) && typeof entry.copied_ref === "string" && retainedPathExists(entry.copied_ref)),
        redaction
      );
    } catch {
      fs.rmSync(manifestRef, { force: true });
    }
  }
  for (const manifestRef of findFilesNamed(root, "redaction-manifest.json")) {
    try {
      const value = readJson<JsonRecord>(manifestRef);
      if (!Array.isArray(value.entries)) continue;
      const entries = value.entries.filter((entry) => {
        if (!isRecord(entry)) return false;
        const retainedRef = typeof entry.copied_ref === "string"
          ? entry.copied_ref
          : typeof entry.retained_ref === "string" ? entry.retained_ref : undefined;
        return retainedRef === undefined || retainedPathExists(retainedRef);
      });
      writeSanitizedJson(manifestRef, {
        ...value,
        entries,
        replacement_count: entries.reduce((sum, entry) => sum + Number(isRecord(entry) ? entry.replacement_count ?? 0 : 0), 0),
        structured_redaction_count: entries.reduce(
          (sum, entry) => sum + Number(isRecord(entry) ? entry.structured_redaction_count ?? 0 : 0),
          0
        ),
      }, redaction);
    } catch {
      fs.rmSync(manifestRef, { force: true });
    }
  }
}

function retainedPathExists(value: string): boolean {
  return path.isAbsolute(value) && fs.existsSync(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return isContainedOrEqual(resolvedLeft, resolvedRight) || isContainedOrEqual(resolvedRight, resolvedLeft);
}

function capitalizeArm(arm: XiaoBaNativeArm): string {
  return arm === "baseline" ? "Baseline" : "Candidate";
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isRedactedEvidenceValue(value: string): boolean {
  return /^\[REDACTED(?::[^\]]+)?\]$/.test(value.trim());
}

function firstRecord(...values: unknown[]): JsonRecord | undefined {
  return values.find((value): value is JsonRecord => isRecord(value));
}

function nestedValue(value: JsonRecord, objectKey: string, fieldKey: string): unknown {
  const nested = value[objectKey];
  return isRecord(nested) ? nested[fieldKey] : undefined;
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
}

function hashPath(value: string): string {
  if (fs.statSync(value).isDirectory()) return hashDirectory(value);
  return crypto.createHash("sha256").update(fs.readFileSync(value)).digest("hex");
}

function resultPackageFiles(
  root: string,
  stagedFiles: Map<string, string>
): Array<{ ref: string; sha256: string }> {
  const files = new Map<string, string>();
  for (const filePath of listResultPackageFiles(root)) {
    const relative = packageRelativeRef(root, filePath);
    if (relative === "package-manifest.json" || stagedFiles.has(relative)) continue;
    files.set(relative, filePath);
  }
  for (const [relative, stagedPath] of stagedFiles) files.set(relative, stagedPath);
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, filePath]) => ({
      ref,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    }));
}

function listResultPackageFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".result-package-staging-")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...listResultPackageFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
    else throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `Result package contains a non-regular entry: ${fullPath}`);
  }
  return files.sort();
}

function packageRelativeRef(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function aggregateResult(
  request: XiaoBaCapabilityEvaluationRequestV1,
  requestRef: string,
  probe: XiaoBaNativeProbeResult,
  baselineAttempts: XiaoBaNativeAttemptResult[],
  candidateAttempts: XiaoBaNativeAttemptResult[],
  admission: StaticAdmissionReportV1,
  now: Date
): XiaoBaCapabilityEvaluationResultV1 {
  const planned = request.cases.length * request.attempts_per_arm;
  const baseline = aggregateArm(request.baseline, baselineAttempts, planned);
  const candidate = aggregateArm(request.candidate, candidateAttempts, planned);
  const complete = armComplete(baseline) && armComplete(candidate);
  const lift = complete && baseline.pass_rate.value !== null && candidate.pass_rate.value !== null
    ? candidate.pass_rate.value - baseline.pass_rate.value : null;
  const effectiveness = lift === null ? "unavailable" : lift > 0 ? "improved" : lift < 0 ? "regressed" : "no_effect";
  const evidenceComplete = baseline.evidence_complete && candidate.evidence_complete &&
    admission.decision === "pass" && admission.evidence_complete;
  const regression = effectiveness === "regressed" || hasCaseRegression(baselineAttempts, candidateAttempts);
  const verdict = decideResult(baseline, candidate, evidenceComplete, effectiveness, regression);
  const all = [...baselineAttempts, ...candidateAttempts];
  const verifierBacked = all.filter((item) => item.assertions.length > 0).length;
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1", evaluation_id: request.evaluation_id,
    created_at: now.toISOString(), request_ref: requestRef, ...(request.case_pack && { case_pack: request.case_pack }), capability_kind: request.capability_kind,
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
    baseline, candidate, admission,
    evidence_refs: [...new Set([
      ...admission.evidence_refs,
      ...all.flatMap((item) => item.evidence.map((entry) => entry.copied_ref)),
    ])],
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

function applyDecisionProposal(
  result: XiaoBaCapabilityEvaluationResultV1,
  decision: XiaoBaCapabilityEvaluationResultV1["decision"],
  reason: XiaoBaNativeReasonCode,
  summary: string
): void {
  const rank = { cleared: 1, held: 2, rejected: 3 } as const;
  if (rank[decision] < rank[result.decision]) return;
  if (rank[decision] === rank[result.decision] && reasonPriority(reason) < reasonPriority(result.reason_code)) return;
  result.decision = decision;
  result.reason_code = reason;
  result.summary = summary;
}

function reasonPriority(reason: XiaoBaNativeReasonCode): number {
  if (reason === "unsafe_candidate" || reason === "capability_regression") return 100;
  if (reason === "xiaoba_arena_unsafe") return 90;
  if (["retained_secret_detected", "redaction_failed", "scratch_cleanup_failed"].includes(reason)) return 80;
  if (["usage_limit_exceeded", "live_retry_control_unverified", "provider_identity_mismatch"].includes(reason)) return 70;
  if (["provider_identity_unverified", "baseline_usage_incomplete", "candidate_usage_incomplete"].includes(reason)) return 60;
  if (["evidence_incomplete", "xiaoba_stage_evidence_missing", "xiaoba_native_trace_missing"].includes(reason)) return 50;
  if (reason === "insufficient_live_replays") return 10;
  return 40;
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

function staticAdmissionResult(
  request: XiaoBaCapabilityEvaluationRequestV1,
  requestRef: string,
  probe: XiaoBaNativeProbeResult,
  admission: StaticAdmissionReportV1
): XiaoBaCapabilityEvaluationResultV1 {
  const result = blockedResult(
    request,
    requestRef,
    probe,
    admission.reason_code,
    admission.summary,
    admission
  );
  result.decision = admission.decision === "rejected" ? "rejected" : "held";
  return result;
}

function blockedResult(
  request: XiaoBaCapabilityEvaluationRequestV1,
  requestRef: string,
  probe: XiaoBaNativeProbeResult,
  reason: XiaoBaNativeReasonCode,
  summary: string,
  admission?: StaticAdmissionReportV1
): XiaoBaCapabilityEvaluationResultV1 {
  const planned = request.cases.length * request.attempts_per_arm;
  const empty = (selection: XiaoBaNativeRoleSelection | XiaoBaNativeRoleSkillSelection): XiaoBaNativeArmResult => ({
    selection, counts: { planned, pass: 0, fail: 0, blocked: planned, unsafe: 0 },
    pass_rate: { numerator: 0, denominator: 0, value: null }, stability: "blocked", evidence_complete: false, attempts: [],
  });
  const rate = { numerator: 0, denominator: 0, value: null };
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1", evaluation_id: request.evaluation_id,
    created_at: new Date().toISOString(), request_ref: requestRef, ...(request.case_pack && { case_pack: request.case_pack }), capability_kind: request.capability_kind,
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
    baseline: empty(request.baseline),
    candidate: empty(request.candidate),
    ...(admission && { admission }),
    evidence_refs: admission?.evidence_refs ?? [],
    debug_refs: [],
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
  if (/provider[^\n]*(unconfigured|not configured|missing|required)|\.env not found|API key[^\n]*(missing|required|invalid)/i.test(text)) {
    return "xiaoba_provider_unconfigured";
  }
  if (/(sandbox|seatbelt|bubblewrap)[^\n]*(unavailable|not enforced|failed|denied|missing)/i.test(text)) {
    return "xiaoba_sandbox_unavailable";
  }
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
  if (!fs.existsSync(value) || fs.lstatSync(value).isSymbolicLink() || !fs.statSync(value).isFile()) {
    throw new XiaoBaNativeError(reason, `Required file is missing or not a regular file: ${value}`);
  }
  return value;
}

function requiredFileInside(
  root: string,
  value: string,
  reason: XiaoBaNativeReasonCode,
  label: string
): string {
  assertInside(root, value, label);
  return requiredFile(value, reason);
}

function requiredPath(value: string, reason: XiaoBaNativeReasonCode): string {
  if (!fs.existsSync(value) || fs.lstatSync(value).isSymbolicLink()) {
    throw new XiaoBaNativeError(reason, `Required evidence path is missing or is a symbolic link: ${value}`);
  }
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
  const resolvedRoot = path.resolve(root);
  const resolvedValue = path.resolve(value);
  if (!isContainedOrEqual(resolvedRoot, resolvedValue)) {
    throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} escapes its allowed root: ${value}`);
  }
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} allowed root is unavailable: ${resolvedRoot}`);
  }

  let existing = resolvedValue;
  while (!pathEntryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} has no existing contained ancestor: ${value}`);
    }
    existing = parent;
  }

  let realRoot: string;
  let realExisting: string;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} contains an unresolved symbolic link: ${value}`);
  }
  if (!isContainedOrEqual(realRoot, realExisting)) {
    throw new XiaoBaNativeError("xiaoba_artifact_ref_invalid", `${label} resolves outside its allowed root: ${value}`);
  }
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathEntryExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
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
