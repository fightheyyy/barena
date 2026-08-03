import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import {
  OtlpTraceReceiver,
  RuntimeAdapterError,
  XiaobaOSRuntimeAdapter,
  resolveXiaobaInstallation,
  type AgentRuntimeAdapter,
  type AgentRuntimeSession,
  type OtlpInvocationContext,
  type OtlpReceiverManifest,
  type RuntimeProbeResult,
  type RuntimeTurnResult,
} from "../runtime-adapters";
import {
  isSecretEnvironmentName,
  readXiaobaProjectSecretValues,
} from "../runtime-adapters/xiaoba-project-env";
import { assertSafeRunId } from "../runs/path-safety";
import {
  copyDirectory,
  ensureDir,
  hashDirectory,
  readNdjson,
  writeJson,
} from "../utils/fs";
import {
  diffExploreWorkspace,
  findExploreNativeTraceFiles,
  snapshotExploreWorkspace,
} from "./evidence";
import { inspectorPrompt, reviewerPrompt, userSimulatorPrompt } from "./prompts";
import { validateExploreScenario } from "./scenario";
import {
  parseInspectorOutput,
  parseReviewerOutput,
  parseUserSimulatorDecision,
} from "./structured-output";
import { redactSecretsInDirectory } from "./secret-redaction";
import type {
  ExploreProgressEvent,
  ExploreResultV1,
  ExploreRunOptions,
  ExploreScenarioV1,
  ExploreStageResult,
  ExploreTranscriptMessage,
  ExploreTurnResult,
  InspectorOutput,
  ReplayCaseCandidateV1,
  ReviewerOutput,
  RuntimeProcessSummary,
} from "./types";

const DEFAULT_EVALUATOR_ROLES = {
  user_simulator: "user-cat",
  inspector: "inspector-cat",
  reviewer: "reviewer-cat",
} as const;

interface ExploreCancellation {
  isCancelled(): boolean;
  detail(): string;
  beginTurn(session: AgentRuntimeSession): Promise<boolean>;
  endTurn(session: AgentRuntimeSession): void;
  waitForPending(): Promise<void>;
  dispose(): void;
}

type BlockedExploreStage = Extract<
  ExploreStageResult<unknown>,
  { status: "blocked" }
>;

function createProgressEmitter(
  observer: ExploreRunOptions["on_progress"],
  now: () => Date,
  secrets: string[]
): (
  event: Omit<ExploreProgressEvent, "schema" | "sequence" | "timestamp">
) => Promise<void> {
  let sequence = 0;
  return async (event) => {
    if (!observer) return;
    const bounded: ExploreProgressEvent = {
      schema: "barena.explore_progress.v1",
      sequence: ++sequence,
      timestamp: now().toISOString(),
      ...event,
      ...(event.message && {
        message: boundedProgressText(event.message, secrets),
      }),
      ...(event.reason && {
        reason: boundedProgressText(event.reason, secrets),
      }),
      ...(event.summary && {
        summary: boundedProgressText(event.summary, secrets),
      }),
    };
    try {
      await observer(bounded);
    } catch {
      // Progress is an optional observer. Rendering or logging failure must not
      // alter the evaluation result or its persisted evidence.
    }
  };
}

function boundedProgressText(value: string, secrets: string[]): string {
  const normalized = redactTextValue(value, secrets).replace(/\s+/g, " ").trim();
  return normalized.length <= 1_200
    ? normalized
    : `${normalized.slice(0, 1_199)}…`;
}

export async function runExploreScenario(
  rawScenario: ExploreScenarioV1,
  options: ExploreRunOptions = {}
): Promise<ExploreResultV1> {
  const scenario = validateExploreScenario(rawScenario);
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const runId = options.run_id ?? createRunId(createdAt);
  assertSafeRunId(runId);
  const runRoot = reserveRunRoot(options.runs_root ?? "runs", runId);
  const paths = createRunLayout(runRoot);
  const roles = {
    user_simulator:
      scenario.evaluator?.user_role ?? DEFAULT_EVALUATOR_ROLES.user_simulator,
    inspector: scenario.evaluator?.inspector_role ?? DEFAULT_EVALUATOR_ROLES.inspector,
    reviewer: scenario.evaluator?.reviewer_role ?? DEFAULT_EVALUATOR_ROLES.reviewer,
  };
  writeJson(paths.scenario, scenario);

  const configuredInstallation = resolveXiaobaInstallation({
    command: options.xiaoba?.command,
    project_root: options.xiaoba?.project_root,
    roles_root: options.xiaoba?.roles_root,
    skills_root: options.xiaoba?.skills_root,
  });
  const envSecretValues = [
    ...new Set([
      ...(options.xiaoba?.env_allowlist ?? []),
      ...(scenario.target.env_allowlist ?? []),
    ]),
  ]
    .filter(isSecretEnvironmentName)
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
  const secrets = [
    ...readXiaobaProjectSecretValues(configuredInstallation.project_root),
    ...envSecretValues,
  ];
  const emitProgress = createProgressEmitter(options.on_progress, now, secrets);
  let adapter: AgentRuntimeAdapter;
  let snapshotSecretRedaction = emptySecretRedaction();
  if (options.runtime_adapter) {
    adapter = options.runtime_adapter;
  } else {
    const createdRuntime = createIsolatedXiaobaAdapter(
      scenario,
      options,
      paths.runtime,
      configuredInstallation,
      secrets
    );
    adapter = createdRuntime.adapter;
    snapshotSecretRedaction = createdRuntime.secretRedaction;
  }
  const rootTraceId = resolveRootTraceId(options.root_trace_id);
  const receiver = new OtlpTraceReceiver({
    run_root: runRoot,
    secrets,
    ...(options.otlp_forward && { forward: options.otlp_forward }),
  });
  await receiver.start();
  const cancellation = createExploreCancellation(adapter, options.signal);

  const finishBeforeTarget = async (
    probe: RuntimeProbeResult,
    override?: { reason_code: string; summary: string }
  ): Promise<ExploreResultV1> => {
    const manifest = await receiver.stop();
    const secretRedaction = mergeSecretRedactions(
      snapshotSecretRedaction,
      redactSecretsInDirectory(runRoot, secrets)
    );
    const result = blockedBeforeExecution({
      runId,
      scenario,
      createdAt,
      completedAt: now(),
      probe,
      roles,
      manifest,
      adapter,
      secretRedaction,
      rootTraceId,
      ...override,
    });
    const persisted = persistResult(paths, redactExploreResult(result, secrets));
    await emitProgress({
      actor: "barena",
      stage: "complete",
      status: "blocked",
      summary: persisted.summary,
      evidence: {
        otlp_envelopes: manifest.envelope_count,
        otlp_spans: manifest.span_count,
        workspace_changes: 0,
      },
    });
    return persisted;
  };

  let probe: RuntimeProbeResult | undefined;
  try {
    if (cancellation.isCancelled()) {
      return await finishBeforeTarget(
        cancelledProbe(adapter, cancellation.detail()),
        {
          reason_code: "run_cancelled",
          summary: cancellation.detail(),
        }
      );
    }
    await emitProgress({
      actor: "barena",
      stage: "probe",
      status: "started",
      summary: "Checking the target Runtime and all evaluator Roles.",
    });
    probe = await adapter.probe({
      required_targets: [
        scenario.target.role,
        roles.user_simulator,
        roles.inspector,
        roles.reviewer,
      ],
    });
    if (cancellation.isCancelled()) {
      return await finishBeforeTarget(probe, {
        reason_code: "run_cancelled",
        summary: cancellation.detail(),
      });
    }
    if (probe.status === "blocked") {
      await emitProgress({
        actor: "barena",
        stage: "probe",
        status: "blocked",
        summary: probe.detail,
      });
      return await finishBeforeTarget(probe);
    }
    await emitProgress({
      actor: "barena",
      stage: "probe",
      status: "completed",
      summary: probe.detail,
    });

    const beforeWorkspace = snapshotExploreWorkspace(paths.target_workspace);
    const transcript: ExploreTranscriptMessage[] = [];
    const turns: ExploreTurnResult[] = [];
    const nativeTraceRefs = new Set<string>();
    let terminalRuntime:
      | { status: RuntimeTurnResult["status"]; reason_code?: string; detail: string }
      | undefined;
    let userStoppedWithoutTurn = false;

    let userSession: AgentRuntimeSession | undefined;
    let targetSession: AgentRuntimeSession | undefined;
    try {
      if (!cancellation.isCancelled()) {
        userSession = await openSession(adapter, {
          runId,
          scenario,
          role: roles.user_simulator,
          stage: "user-simulator",
          workspace: paths.user_workspace,
        });
      }
      if (!cancellation.isCancelled()) {
        targetSession = await openSession(adapter, {
          runId,
          scenario,
          role: scenario.target.role,
          stage: "target",
          workspace: paths.target_workspace,
          target: true,
        });
      }
      if (cancellation.isCancelled() || !userSession || !targetSession) {
        terminalRuntime = cancelledRuntime(cancellation.detail());
      }
      for (let turn = 1; turn <= scenario.max_turns; turn += 1) {
        if (cancellation.isCancelled() || !userSession || !targetSession) {
          terminalRuntime = cancelledRuntime(cancellation.detail());
          break;
        }
        await emitProgress({
          actor: "user_simulator",
          stage: "user_simulator",
          status: "started",
          turn,
          summary: "Generating the next realistic user turn from observed conversation evidence.",
        });
        const userRawRef = path.join(
          paths.user_stage,
          `turn-${String(turn).padStart(3, "0")}.txt`
        );
        const userResult = await invokeRole({
          adapter,
          session: userSession,
          prompt: userSimulatorPrompt({ scenario, transcript, turn }),
          timeoutMs: scenario.timeout_ms,
          receiver,
          rootTraceId,
          runId,
          scenarioId: scenario.scenario_id,
          attemptId: `user-simulator-turn-${turn}`,
          stage: "user_simulator",
          actor: "user_simulator",
          role: roles.user_simulator,
          turn,
          boundaryTrace: paths.boundary_trace,
          cancellation,
        });
        fs.writeFileSync(
          userRawRef,
          `${userResult.assistant?.content ?? userResult.process.stdout}\n`,
          "utf8"
        );
        for (const ref of userResult.native_trace_refs) nativeTraceRefs.add(ref);
        if (cancellation.isCancelled()) {
          terminalRuntime = cancelledRuntime(cancellation.detail());
          turns.push({
            turn,
            user_simulator: {
              decision: {
                action: "stop",
                reason: terminalRuntime.detail,
              },
              raw_ref: userRawRef,
              process: processSummary(userResult),
            },
          });
          await emitProgress({
            actor: "user_simulator",
            stage: "user_simulator",
            status: "blocked",
            turn,
            summary: terminalRuntime.detail,
          });
          break;
        }
        if (userResult.status !== "completed" || !userResult.assistant) {
          terminalRuntime = {
            status: userResult.status,
            reason_code: userResult.reason_code,
            detail: `User simulator failed: ${userResult.detail}`,
          };
          turns.push({
            turn,
            user_simulator: {
              decision: {
                action: "stop",
                reason: `Evaluator Runtime failure: ${userResult.detail}`,
              },
              raw_ref: userRawRef,
              process: processSummary(userResult),
            },
          });
          await emitProgress({
            actor: "user_simulator",
            stage: "user_simulator",
            status: "blocked",
            turn,
            summary: terminalRuntime.detail,
          });
          break;
        }

        let decision;
        try {
          decision = parseUserSimulatorDecision(userResult.assistant.content);
        } catch (error) {
          terminalRuntime = {
            status: "blocked",
            reason_code: "evaluator_protocol_error",
            detail: `User simulator returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
          turns.push({
            turn,
            user_simulator: {
              decision: {
                action: "stop",
                reason: terminalRuntime.detail,
              },
              raw_ref: userRawRef,
              process: processSummary(userResult),
            },
          });
          await emitProgress({
            actor: "user_simulator",
            stage: "user_simulator",
            status: "blocked",
            turn,
            summary: terminalRuntime.detail,
          });
          break;
        }
        const turnRecord: ExploreTurnResult = {
          turn,
          user_simulator: {
            decision,
            raw_ref: userRawRef,
            process: processSummary(userResult),
          },
        };
        turns.push(turnRecord);
        await emitProgress({
          actor: "user_simulator",
          stage: "user_simulator",
          status: "completed",
          turn,
          ...(decision.message && { message: decision.message }),
          reason: decision.reason,
          summary:
            decision.action === "send"
              ? "Produced the next user message."
              : "Stopped the simulated conversation.",
        });
        if (cancellation.isCancelled()) {
          terminalRuntime = cancelledRuntime(cancellation.detail());
          break;
        }

        if (decision.action === "stop") {
          if (!transcript.some((message) => message.actor === "target")) {
            userStoppedWithoutTurn = true;
          }
          break;
        }

        const userMessage = decision.message as string;
        transcript.push({
          turn,
          role: "user",
          actor: "user_simulator",
          content: userMessage,
          timestamp: new Date().toISOString(),
        });
        await emitProgress({
          actor: "target",
          stage: "target",
          status: "started",
          turn,
          summary: `Sending UserCat turn ${turn} to ${scenario.target.role}.`,
        });
        const targetResult = await invokeRole({
          adapter,
          session: targetSession,
          prompt: userMessage,
          timeoutMs: scenario.timeout_ms,
          receiver,
          rootTraceId,
          runId,
          scenarioId: scenario.scenario_id,
          attemptId: `target-turn-${turn}`,
          stage: "target",
          actor: "target",
          role: scenario.target.role,
          turn,
          boundaryTrace: paths.boundary_trace,
          cancellation,
        });
        for (const ref of targetResult.native_trace_refs) nativeTraceRefs.add(ref);
        if (cancellation.isCancelled()) {
          turnRecord.target = {
            response: targetResult.assistant?.content ?? "",
            process: processSummary(targetResult),
            native_trace_refs: targetResult.native_trace_refs,
          };
          terminalRuntime = cancelledRuntime(cancellation.detail());
          await emitProgress({
            actor: "target",
            stage: "target",
            status: "blocked",
            turn,
            summary: terminalRuntime.detail,
          });
          break;
        }
        if (targetResult.status !== "completed" || !targetResult.assistant) {
          turnRecord.target = {
            response: "",
            process: processSummary(targetResult),
            native_trace_refs: targetResult.native_trace_refs,
          };
          terminalRuntime = {
            status: targetResult.status,
            reason_code: targetResult.reason_code,
            detail: `Target Runtime failed: ${targetResult.detail}`,
          };
          await emitProgress({
            actor: "target",
            stage: "target",
            status: "blocked",
            turn,
            summary: terminalRuntime.detail,
          });
          break;
        }
        transcript.push({
          turn,
          role: "assistant",
          actor: "target",
          content: targetResult.assistant.content,
          timestamp: new Date().toISOString(),
        });
        turnRecord.target = {
          response: targetResult.assistant.content,
          process: processSummary(targetResult),
          native_trace_refs: targetResult.native_trace_refs,
        };
        await emitProgress({
          actor: "target",
          stage: "target",
          status: "completed",
          turn,
          message: targetResult.assistant.content,
          summary: `${scenario.target.role} completed turn ${turn}.`,
        });
      }
    } finally {
      await cancellation.waitForPending();
      await Promise.all(
        [userSession, targetSession]
          .filter((session): session is AgentRuntimeSession => Boolean(session))
          .map((session) => adapter.close(session))
      );
    }

    const afterWorkspace = snapshotExploreWorkspace(paths.target_workspace);
    const workspaceChanges = diffExploreWorkspace(beforeWorkspace, afterWorkspace);
    const unsafeWorkspaceEntries = afterWorkspace.unsafe_entries;
    for (const ref of findExploreNativeTraceFiles([
      paths.target_workspace,
      paths.user_workspace,
    ])) {
      nativeTraceRefs.add(ref);
    }

    let inspectorStage: ExploreStageResult<InspectorOutput>;
    if (cancellation.isCancelled()) {
      inspectorStage = cancelledStage(cancellation.detail());
      await emitProgress({
        actor: "inspector",
        stage: "inspector",
        status: "blocked",
        summary: inspectorStage.detail,
      });
    } else if (userStoppedWithoutTurn) {
      inspectorStage = {
        status: "blocked",
        detail: "User simulator stopped before the target Role produced any observable turn.",
        reason_code: "no_target_turn",
      };
      await emitProgress({
        actor: "inspector",
        stage: "inspector",
        status: "blocked",
        summary: inspectorStage.detail,
      });
    } else {
      await emitProgress({
        actor: "inspector",
        stage: "inspector",
        status: "started",
        summary: "Inspecting transcript, OTLP spans, workspace changes, and native evidence.",
      });
      inspectorStage = await runInspector({
        adapter,
        scenario,
        transcript,
        workspaceChanges,
        unsafeWorkspaceEntries,
        nativeTraceRefs: [...nativeTraceRefs],
        receiver,
        rootTraceId,
        runId,
        role: roles.inspector,
        paths,
        cancellation,
      });
      if (cancellation.isCancelled()) {
        inspectorStage = cancelledStage(cancellation.detail(), inspectorStage);
      }
      await emitProgress(
        inspectorStage.status === "completed"
          ? {
              actor: "inspector",
              stage: "inspector",
              status: "completed",
              summary: inspectorStage.output.summary,
              issue_count: inspectorStage.output.issues.length,
              evidence: {
                workspace_changes: workspaceChanges.length,
              },
            }
          : {
              actor: "inspector",
              stage: "inspector",
              status: "blocked",
              summary: inspectorStage.detail,
            }
      );
    }

    let reviewerStage: ExploreStageResult<ReviewerOutput>;
    if (cancellation.isCancelled()) {
      reviewerStage = {
        status: "not_run",
        detail: "Reviewer did not run because Explore was cancelled.",
      };
      await emitProgress({
        actor: "reviewer",
        stage: "reviewer",
        status: "skipped",
        summary: reviewerStage.detail,
      });
    } else if (inspectorStage.status !== "completed") {
      reviewerStage = {
        status: "not_run",
        detail: "Reviewer did not run because Inspector evidence was unavailable.",
      };
      await emitProgress({
        actor: "reviewer",
        stage: "reviewer",
        status: "skipped",
        summary: reviewerStage.detail,
      });
    } else {
      await emitProgress({
        actor: "reviewer",
        stage: "reviewer",
        status: "started",
        summary: "Reviewing success criteria against Inspector findings and execution evidence.",
      });
      reviewerStage = await runReviewer({
        adapter,
        scenario,
        transcript,
        inspector: inspectorStage.output,
        workspaceChanges,
        unsafeWorkspaceEntries,
        receiver,
        rootTraceId,
        runId,
        role: roles.reviewer,
        paths,
        cancellation,
      });
      if (cancellation.isCancelled()) {
        reviewerStage = cancelledStage(cancellation.detail(), reviewerStage);
      }
      await emitProgress(
        reviewerStage.status === "completed"
          ? {
              actor: "reviewer",
              stage: "reviewer",
              status: "completed",
              summary: reviewerStage.output.summary,
              verdict: reviewerStage.output.verdict,
            }
          : {
              actor: "reviewer",
              stage: "reviewer",
              status: "blocked",
              summary: reviewerStage.detail,
            }
      );
    }

    const manifest = await receiver.stop();
    for (const ref of findExploreNativeTraceFiles([
      paths.inspector_workspace,
      paths.reviewer_workspace,
    ])) {
      nativeTraceRefs.add(ref);
    }
    const secretRedaction = mergeSecretRedactions(
      snapshotSecretRedaction,
      redactSecretsInDirectory(runRoot, secrets)
    );
    const targetOtlpSpans = manifest.envelopes
      .filter((envelope) => envelope.invocation?.stage === "target")
      .reduce((sum, envelope) => sum + envelope.decoded_span_count, 0);
    const evidenceComplete =
      !cancellation.isCancelled() &&
      targetOtlpSpans > 0 &&
      manifest.span_count > 0 &&
      unsafeWorkspaceEntries.length === 0 &&
      inspectorStage.status === "completed" &&
      inspectorStage.output.evidence_complete &&
      reviewerStage.status === "completed";
    const finalEvidenceComplete =
      evidenceComplete && secretRedaction.unscanned_files.length === 0;
    await emitProgress({
      actor: "barena",
      stage: "evidence",
      status: finalEvidenceComplete ? "completed" : "blocked",
      summary: cancellation.isCancelled()
        ? "Explore was cancelled; retained partial evidence cannot pass."
        : finalEvidenceComplete
          ? "Required execution evidence is complete."
          : "Required execution evidence is incomplete.",
      evidence: {
        otlp_envelopes: manifest.envelope_count,
        otlp_spans: manifest.span_count,
        workspace_changes: workspaceChanges.length,
      },
    });
    const derived = deriveOutcome({
      reviewer: reviewerStage,
      inspector: inspectorStage,
      terminalRuntime,
      userStoppedWithoutTurn,
      evidenceComplete: finalEvidenceComplete,
      unsafeWorkspaceEntries,
      cancelled: cancellation.isCancelled(),
      cancellationDetail: cancellation.detail(),
    });
    const replayCandidates =
      !cancellation.isCancelled() && inspectorStage.status === "completed"
        ? createReplayCandidates(
            runId,
            scenario,
            inspectorStage.output.issues
          )
        : [];
    writeJson(paths.replay_candidates, replayCandidates);

    const result: ExploreResultV1 = {
      schema: "barena.explore_result.v1",
      run_id: runId,
      scenario_id: scenario.scenario_id,
      created_at: createdAt.toISOString(),
      completed_at: now().toISOString(),
      status: derived.status,
      ...(derived.reason_code && { reason_code: derived.reason_code }),
      summary: derived.summary,
      scenario,
      runtime: {
        probe,
        session_mode: adapter.capabilities.session_mode,
        target_role: scenario.target.role,
        evaluator_roles: roles,
      },
      transcript,
      turns,
      inspector: inspectorStage,
      reviewer: reviewerStage,
      replay_case_candidates: replayCandidates,
      evidence: {
        boundary_trace: paths.boundary_trace,
        otlp_manifest: manifest.manifest_ref,
        otlp_spans: manifest.spans_ref,
        native_otlp_envelopes: manifest.envelope_count,
        native_otlp_spans: manifest.span_count,
        native_otlp_required: true,
        root_trace_id: rootTraceId,
        native_trace_ids: manifest.trace_ids,
        ...(manifest.primary_trace_id && {
          primary_native_trace_id: manifest.primary_trace_id,
        }),
        ...(manifest.forwarding && { otlp_forwarding: manifest.forwarding }),
        workspace_changes: workspaceChanges,
        unsafe_workspace_entries: unsafeWorkspaceEntries,
        native_trace_refs: [...nativeTraceRefs].sort(),
        secret_redaction: secretRedaction,
        evidence_complete: finalEvidenceComplete,
      },
      paths: {
        run_root: runRoot,
        target_workspace: paths.target_workspace,
        report_json: paths.report_json,
        report_markdown: paths.report_markdown,
      },
    };
    const persisted = persistResult(paths, redactExploreResult(result, secrets));
    await emitProgress({
      actor: "barena",
      stage: "complete",
      status: result.status === "blocked" ? "blocked" : "completed",
      summary: persisted.summary,
      ...(persisted.reviewer.status === "completed" && {
        verdict: persisted.reviewer.output.verdict,
      }),
      evidence: {
        otlp_envelopes: manifest.envelope_count,
        otlp_spans: manifest.span_count,
        workspace_changes: workspaceChanges.length,
      },
    });
    return persisted;
  } catch (error) {
    await receiver.stop().catch(() => undefined);
    await emitProgress({
      actor: "barena",
      stage: "complete",
      status: "blocked",
      summary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    cancellation.dispose();
  }
}

async function runInspector(input: {
  adapter: AgentRuntimeAdapter;
  scenario: ExploreScenarioV1;
  transcript: ExploreTranscriptMessage[];
  workspaceChanges: ExploreResultV1["evidence"]["workspace_changes"];
  unsafeWorkspaceEntries: string[];
  nativeTraceRefs: string[];
  receiver: OtlpTraceReceiver;
  rootTraceId: string;
  runId: string;
  role: string;
  paths: ReturnType<typeof createRunLayout>;
  cancellation: ExploreCancellation;
}): Promise<ExploreStageResult<InspectorOutput>> {
  const session = await openSession(input.adapter, {
    runId: input.runId,
    scenario: input.scenario,
    role: input.role,
    stage: "inspector",
    workspace: input.paths.inspector_workspace,
  });
  try {
    const manifest = input.receiver.snapshot();
    const spanEvidence = loadOtlpSpanEvidence(manifest.spans_ref);
    const result = await invokeRole({
      adapter: input.adapter,
      session,
      prompt: inspectorPrompt({
        scenario: input.scenario,
        transcript: input.transcript,
        workspaceChanges: input.workspaceChanges,
        unsafeWorkspaceEntries: input.unsafeWorkspaceEntries,
        otlp: {
          envelope_count: manifest.envelope_count,
          span_count: manifest.span_count,
          spans_ref: manifest.spans_ref,
          spans: spanEvidence.spans,
          spans_truncated: spanEvidence.truncated,
        },
        nativeTraceRefs: input.nativeTraceRefs,
      }),
      timeoutMs: input.scenario.timeout_ms,
      receiver: input.receiver,
      rootTraceId: input.rootTraceId,
      runId: input.runId,
      scenarioId: input.scenario.scenario_id,
      attemptId: "inspector",
      stage: "inspector",
      actor: "inspector",
      role: input.role,
      boundaryTrace: input.paths.boundary_trace,
      cancellation: input.cancellation,
    });
    const raw = result.assistant?.content ?? result.process.stdout;
    fs.writeFileSync(input.paths.inspector_raw, `${raw}\n`, "utf8");
    if (result.status !== "completed" || !result.assistant) {
      return {
        status: "blocked",
        detail: result.detail,
        reason_code: result.reason_code,
        raw_ref: input.paths.inspector_raw,
        process: processSummary(result),
      };
    }
    try {
      const output = parseInspectorOutput(result.assistant.content);
      writeJson(input.paths.inspector_json, output);
      return {
        status: "completed",
        output,
        raw_ref: input.paths.inspector_raw,
        process: processSummary(result),
      };
    } catch (error) {
      return {
        status: "blocked",
        detail: `Inspector returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        reason_code: "evaluator_protocol_error",
        raw_ref: input.paths.inspector_raw,
        process: processSummary(result),
      };
    }
  } finally {
    await input.cancellation.waitForPending();
    await input.adapter.close(session);
  }
}

async function runReviewer(input: {
  adapter: AgentRuntimeAdapter;
  scenario: ExploreScenarioV1;
  transcript: ExploreTranscriptMessage[];
  inspector: InspectorOutput;
  workspaceChanges: ExploreResultV1["evidence"]["workspace_changes"];
  unsafeWorkspaceEntries: string[];
  receiver: OtlpTraceReceiver;
  rootTraceId: string;
  runId: string;
  role: string;
  paths: ReturnType<typeof createRunLayout>;
  cancellation: ExploreCancellation;
}): Promise<ExploreStageResult<ReviewerOutput>> {
  const session = await openSession(input.adapter, {
    runId: input.runId,
    scenario: input.scenario,
    role: input.role,
    stage: "reviewer",
    workspace: input.paths.reviewer_workspace,
  });
  try {
    const manifest = input.receiver.snapshot();
    const result = await invokeRole({
      adapter: input.adapter,
      session,
      prompt: reviewerPrompt({
        scenario: input.scenario,
        transcript: input.transcript,
        inspector: input.inspector,
        evidence: {
          otlp_envelopes: manifest.envelope_count,
          otlp_spans: manifest.span_count,
          workspace_changes: input.workspaceChanges.length,
          unsafe_workspace_entries: input.unsafeWorkspaceEntries,
        },
      }),
      timeoutMs: input.scenario.timeout_ms,
      receiver: input.receiver,
      rootTraceId: input.rootTraceId,
      runId: input.runId,
      scenarioId: input.scenario.scenario_id,
      attemptId: "reviewer",
      stage: "reviewer",
      actor: "reviewer",
      role: input.role,
      boundaryTrace: input.paths.boundary_trace,
      cancellation: input.cancellation,
    });
    const raw = result.assistant?.content ?? result.process.stdout;
    fs.writeFileSync(input.paths.reviewer_raw, `${raw}\n`, "utf8");
    if (result.status !== "completed" || !result.assistant) {
      return {
        status: "blocked",
        detail: result.detail,
        reason_code: result.reason_code,
        raw_ref: input.paths.reviewer_raw,
        process: processSummary(result),
      };
    }
    try {
      const output = parseReviewerOutput(result.assistant.content);
      writeJson(input.paths.reviewer_json, output);
      return {
        status: "completed",
        output,
        raw_ref: input.paths.reviewer_raw,
        process: processSummary(result),
      };
    } catch (error) {
      return {
        status: "blocked",
        detail: `Reviewer returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        reason_code: "evaluator_protocol_error",
        raw_ref: input.paths.reviewer_raw,
        process: processSummary(result),
      };
    }
  } finally {
    await input.cancellation.waitForPending();
    await input.adapter.close(session);
  }
}

async function openSession(
  adapter: AgentRuntimeAdapter,
  input: {
    runId: string;
    scenario: ExploreScenarioV1;
    role: string;
    stage: string;
    workspace: string;
    target?: boolean;
  }
): Promise<AgentRuntimeSession> {
  const stageId = safeId(input.stage);
  return adapter.openSession({
    run_id: input.runId,
    scenario_id: input.scenario.scenario_id,
    attempt_id: stageId,
    session_id: safeId(`${input.runId}-${stageId}`),
    thread_id: safeId(`${input.runId}-${stageId}-thread`),
    workspace: input.workspace,
    target: {
      role: input.role,
      ...(input.target && input.scenario.target.model && {
        model: input.scenario.target.model,
      }),
      ...(input.target && input.scenario.target.skill && {
        skill: input.scenario.target.skill,
      }),
      env_allowlist: input.scenario.target.env_allowlist ?? [],
    },
  });
}

async function invokeRole(input: {
  adapter: AgentRuntimeAdapter;
  session: AgentRuntimeSession;
  prompt: string;
  timeoutMs: number;
  receiver: OtlpTraceReceiver;
  rootTraceId: string;
  runId: string;
  scenarioId: string;
  attemptId: string;
  stage: OtlpInvocationContext["stage"];
  actor: OtlpInvocationContext["actor"];
  role: string;
  turn?: number;
  boundaryTrace: string;
  cancellation: ExploreCancellation;
}): Promise<RuntimeTurnResult> {
  const context: OtlpInvocationContext = {
    run_id: input.runId,
    scenario_id: input.scenarioId,
    attempt_id: input.attemptId,
    session_id: input.session.session_id,
    stage: input.stage,
    actor: input.actor,
    role: input.role,
    ...(input.turn && { turn: input.turn }),
  };
  if (!(await input.cancellation.beginTurn(input.session))) {
    return cancelledTurnResult(input.adapter, input.cancellation.detail());
  }
  try {
    input.receiver.setContext(context);
    writeBoundaryEvents(input.boundaryTrace, [
      boundaryEvent({
        runId: input.runId,
        caseId: input.scenarioId,
        attemptId: input.attemptId,
        component: `${input.adapter.id}:${input.role}`,
        observedFrom: "target_input",
        kind: "user",
        message: input.prompt,
        data: {
          actor: input.actor,
          stage: input.stage,
          role: input.role,
          session_id: input.session.session_id,
          prompt_sha256: crypto.createHash("sha256").update(input.prompt).digest("hex"),
          ...(input.turn && { turn: input.turn }),
        },
      }),
    ]);
    const result = await input.adapter.sendTurn(input.session, {
      message: input.prompt,
      timeout_ms: input.timeoutMs,
      telemetry: {
        traces_endpoint: input.receiver.endpoint,
        protocol: "http/protobuf",
        service_name: `barena-xiaoba-${input.actor}`,
        traceparent: `00-${input.rootTraceId}-${crypto.randomBytes(8).toString("hex")}-01`,
        export_timeout_ms: Math.min(input.timeoutMs, 10_000),
        resource_attributes: {
          "barena.run.id": input.runId,
          "barena.scenario.id": input.scenarioId,
          "barena.attempt.id": input.attemptId,
          "barena.mode": "explore",
          "barena.arm": "single",
          "barena.runtime.name": input.adapter.id,
          "barena.session.id": input.session.session_id,
          "barena.actor": input.actor,
          "barena.evidence.source": "runtime_native",
          "barena.target.role": input.role,
          "barena.root.trace_id": input.rootTraceId,
          ...(input.turn ? { "barena.turn": String(input.turn) } : {}),
        },
      },
    });
    writeBoundaryEvents(input.boundaryTrace, [
      ...(result.assistant
        ? [
            boundaryEvent({
              runId: input.runId,
              caseId: input.scenarioId,
              attemptId: input.attemptId,
              component: `${input.adapter.id}:${input.role}`,
              observedFrom: "target_stdout" as const,
              kind: "assistant" as const,
              message: result.assistant.content,
              data: {
                actor: input.actor,
                stage: input.stage,
                role: input.role,
                session_id: input.session.session_id,
                ...(input.turn && { turn: input.turn }),
              },
            }),
          ]
        : []),
      ...(result.process.stderr.trim()
        ? [
            boundaryEvent({
              runId: input.runId,
              caseId: input.scenarioId,
              attemptId: input.attemptId,
              component: `${input.adapter.id}:${input.role}`,
              observedFrom: "target_stderr" as const,
              kind: "runtime_status" as const,
              message: result.process.stderr.trim(),
              data: { actor: input.actor, stage: input.stage },
            }),
          ]
        : []),
      boundaryEvent({
        runId: input.runId,
        caseId: input.scenarioId,
        attemptId: input.attemptId,
        component: `${input.adapter.id}:${input.role}`,
        observedFrom: "target_process",
        kind: "runtime_status",
        message: result.detail,
        data: {
          actor: input.actor,
          stage: input.stage,
          role: input.role,
          status: result.status,
          reason_code: result.reason_code,
          exit_code: result.process.exit_code,
          signal: result.process.signal,
          duration_ms: result.process.duration_ms,
          telemetry_configured: result.telemetry.configured,
          trace_context_propagated: result.telemetry.trace_context_propagated,
          native_trace_refs: result.native_trace_refs,
        },
      }),
    ]);
    return result;
  } catch (error) {
    if (input.cancellation.isCancelled()) {
      return cancelledTurnResult(
        input.adapter,
        `${input.cancellation.detail()} The active Runtime turn did not return a result.`
      );
    }
    throw error;
  } finally {
    input.cancellation.endTurn(input.session);
  }
}

function createIsolatedXiaobaAdapter(
  scenario: ExploreScenarioV1,
  options: ExploreRunOptions,
  runtimeRoot: string,
  installation: ReturnType<typeof resolveXiaobaInstallation>,
  secrets: string[]
): {
  adapter: AgentRuntimeAdapter;
  secretRedaction: ReturnType<typeof redactSecretsInDirectory>;
} {
  if (!installation.roles_root) {
    throw new RuntimeAdapterError(
      "config_invalid",
      "XiaoBaOS roles root could not be resolved from the selected installation."
    );
  }
  const rolesSnapshot = path.join(runtimeRoot, "roles");
  const rolesManifest = snapshotTrustedDirectory(
    installation.roles_root,
    rolesSnapshot,
    secrets
  );
  let skillsSnapshot: string | undefined;
  let skillsManifest:
    | ReturnType<typeof snapshotTrustedDirectory>
    | undefined;
  if (installation.skills_root) {
    skillsSnapshot = path.join(runtimeRoot, "skills");
    skillsManifest = snapshotTrustedDirectory(
      installation.skills_root,
      skillsSnapshot,
      secrets
    );
  }
  writeJson(path.join(runtimeRoot, "snapshot-manifest.json"), {
    schema: "barena.xiaoba_runtime_snapshot.v1",
    project_root: installation.project_root ?? null,
    roles: rolesManifest,
    skills: skillsManifest ?? null,
  });
  return {
    adapter: new XiaobaOSRuntimeAdapter({
      ...options.xiaoba,
      command: installation.command,
      project_root: installation.project_root,
      roles_root: rolesSnapshot,
      ...(skillsSnapshot && { skills_root: skillsSnapshot }),
      env_allowlist: [
        ...new Set([
          ...(options.xiaoba?.env_allowlist ?? []),
          ...(scenario.target.env_allowlist ?? []),
        ]),
      ],
    }),
    secretRedaction: mergeSecretRedactions(
      prefixSecretRedaction(rolesManifest.secret_redaction, "runtime/roles"),
      skillsManifest
        ? prefixSecretRedaction(
            skillsManifest.secret_redaction,
            "runtime/skills"
          )
        : emptySecretRedaction()
    ),
  };
}

function snapshotTrustedDirectory(
  source: string,
  destination: string,
  secrets: string[]
): {
  source: string;
  snapshot: string;
  source_fingerprint: string;
  snapshot_fingerprint: string;
  secret_redaction: ReturnType<typeof redactSecretsInDirectory>;
} {
  const before = hashDirectory(source);
  copyDirectory(source, destination);
  const after = hashDirectory(destination);
  if (before !== after) {
    throw new RuntimeAdapterError(
      "config_invalid",
      `XiaoBaOS Runtime snapshot fingerprint mismatch: ${source}`
    );
  }
  const redaction = redactSecretsInDirectory(destination, secrets);
  if (redaction.unscanned_files.length > 0) {
    throw new RuntimeAdapterError(
      "config_invalid",
      `XiaoBaOS Runtime snapshot contains entries that could not be secret-scanned: ${source}`
    );
  }
  return {
    source,
    snapshot: destination,
    source_fingerprint: before,
    snapshot_fingerprint: hashDirectory(destination),
    secret_redaction: redaction,
  };
}

function processSummary(result: RuntimeTurnResult): RuntimeProcessSummary {
  return {
    status: result.status,
    ...(result.reason_code && { reason_code: result.reason_code }),
    detail: result.detail,
    exit_code: result.process.exit_code,
    signal: result.process.signal,
    duration_ms: result.process.duration_ms,
  };
}

function loadOtlpSpanEvidence(spansRef: string): {
  spans: unknown[];
  truncated: boolean;
} {
  if (!fs.existsSync(spansRef)) return { spans: [], truncated: false };
  const rows = readNdjson<Record<string, unknown>>(spansRef);
  const limit = 200;
  return {
    spans: rows.slice(0, limit).map((row) => ({
      envelope_id: row.envelope_id,
      invocation: row.invocation,
      trace_id: row.trace_id,
      span_id: row.span_id,
      parent_span_id: row.parent_span_id,
      name: row.name,
      kind: row.kind,
      duration_ms: row.duration_ms,
      status: row.status,
      resource_attributes: boundedEvidenceValue(row.resource_attributes),
      attributes: boundedEvidenceValue(row.attributes),
      events: boundedEvidenceValue(row.events),
    })),
    truncated: rows.length > limit,
  };
}

function boundedEvidenceValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-truncated]";
  if (typeof value === "string") {
    return value.length <= 2_000
      ? value
      : `${value.slice(0, 1_000)}...[truncated]...${value.slice(-1_000)}`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => boundedEvidenceValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 200)
        .map(([key, item]) => [key, boundedEvidenceValue(item, depth + 1)])
    );
  }
  return value;
}

function deriveOutcome(input: {
  reviewer: ExploreStageResult<ReviewerOutput>;
  inspector: ExploreStageResult<InspectorOutput>;
  terminalRuntime?: {
    status: RuntimeTurnResult["status"];
    reason_code?: string;
    detail: string;
  };
  userStoppedWithoutTurn: boolean;
  evidenceComplete: boolean;
  unsafeWorkspaceEntries: string[];
  cancelled: boolean;
  cancellationDetail: string;
}): { status: ExploreResultV1["status"]; reason_code?: string; summary: string } {
  if (input.cancelled) {
    return {
      status: "blocked",
      reason_code: "run_cancelled",
      summary: input.cancellationDetail,
    };
  }
  if (
    input.unsafeWorkspaceEntries.length > 0 ||
    input.terminalRuntime?.status === "unsafe" ||
    input.reviewer.status === "completed" &&
      input.reviewer.output.verdict === "unsafe"
  ) {
    return {
      status: "unsafe",
      reason_code: "unsafe_behavior",
      summary: "Explore observed an unsafe Runtime or filesystem condition.",
    };
  }
  if (input.userStoppedWithoutTurn) {
    return {
      status: "blocked",
      reason_code: "no_target_turn",
      summary: "User simulator stopped before the target Role produced evidence.",
    };
  }
  if (input.inspector.status !== "completed") {
    return {
      status: "blocked",
      reason_code:
        input.inspector.status === "blocked"
          ? input.inspector.reason_code ?? "inspector_blocked"
          : "inspector_not_run",
      summary:
        input.inspector.status === "blocked"
          ? input.inspector.detail
          : "Inspector did not run.",
    };
  }
  if (input.reviewer.status !== "completed") {
    return {
      status: "blocked",
      reason_code:
        input.reviewer.status === "blocked"
          ? input.reviewer.reason_code ?? "reviewer_blocked"
          : "reviewer_not_run",
      summary:
        input.reviewer.status === "blocked"
          ? input.reviewer.detail
          : "Reviewer did not run.",
    };
  }
  if (!input.evidenceComplete) {
    return {
      status: "blocked",
      reason_code: "evidence_incomplete",
      summary:
        "Explore completed the dialogue but required target OTLP or evaluator evidence is incomplete.",
    };
  }
  if (
    input.terminalRuntime &&
    input.terminalRuntime.status !== "failed"
  ) {
    return {
      status: "blocked",
      reason_code: input.terminalRuntime.reason_code ?? "runtime_blocked",
      summary: input.terminalRuntime.detail,
    };
  }
  return {
    status: input.reviewer.output.verdict,
    ...(input.reviewer.output.verdict === "blocked" && {
      reason_code: "reviewer_blocked",
    }),
    summary: input.reviewer.output.summary,
  };
}

function createReplayCandidates(
  runId: string,
  scenario: ExploreScenarioV1,
  issues: InspectorOutput["issues"]
): ReplayCaseCandidateV1[] {
  return issues
    .filter((issue) => Boolean(issue.replay_prompt))
    .map((issue) => ({
      schema: "barena.replay_case_candidate.v1",
      candidate_id: safeId(`${scenario.scenario_id}-${issue.issue_id}`),
      status: "proposed",
      source: {
        explore_run_id: runId,
        scenario_id: scenario.scenario_id,
        issue_id: issue.issue_id,
      },
      target: scenario.target,
      prompt: issue.replay_prompt as string,
      issue_summary: issue.summary,
      evidence: issue.evidence,
    }));
}

function blockedBeforeExecution(input: {
  runId: string;
  scenario: ExploreScenarioV1;
  createdAt: Date;
  completedAt: Date;
  probe: RuntimeProbeResult;
  roles: ExploreResultV1["runtime"]["evaluator_roles"];
  manifest: OtlpReceiverManifest;
  adapter: AgentRuntimeAdapter;
  secretRedaction: ReturnType<typeof redactSecretsInDirectory>;
  rootTraceId: string;
  reason_code?: string;
  summary?: string;
}): ExploreResultV1 {
  const actualRunRoot = path.resolve(
    path.dirname(input.manifest.manifest_ref),
    "..",
    ".."
  );
  const reportRoot = path.join(actualRunRoot, "reports");
  return {
    schema: "barena.explore_result.v1",
    run_id: input.runId,
    scenario_id: input.scenario.scenario_id,
    created_at: input.createdAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    status: "blocked",
    reason_code:
      input.reason_code ?? input.probe.reason_code ?? "runtime_probe_blocked",
    summary: input.summary ?? input.probe.detail,
    scenario: input.scenario,
    runtime: {
      probe: input.probe,
      session_mode: input.adapter.capabilities.session_mode,
      target_role: input.scenario.target.role,
      evaluator_roles: input.roles,
    },
    transcript: [],
    turns: [],
    inspector: {
      status: "not_run",
      detail: input.reason_code === "run_cancelled"
        ? "Inspector did not run because Explore was cancelled."
        : "Runtime probe failed.",
    },
    reviewer: {
      status: "not_run",
      detail: input.reason_code === "run_cancelled"
        ? "Reviewer did not run because Explore was cancelled."
        : "Runtime probe failed.",
    },
    replay_case_candidates: [],
    evidence: {
      boundary_trace: path.join(actualRunRoot, "traces", "boundary.ndjson"),
      otlp_manifest: input.manifest.manifest_ref,
      otlp_spans: input.manifest.spans_ref,
      native_otlp_envelopes: input.manifest.envelope_count,
      native_otlp_spans: input.manifest.span_count,
      native_otlp_required: true,
      root_trace_id: input.rootTraceId,
      native_trace_ids: input.manifest.trace_ids,
      ...(input.manifest.primary_trace_id && {
        primary_native_trace_id: input.manifest.primary_trace_id,
      }),
      ...(input.manifest.forwarding && {
        otlp_forwarding: input.manifest.forwarding,
      }),
      workspace_changes: [],
      unsafe_workspace_entries: [],
      native_trace_refs: [],
      secret_redaction: input.secretRedaction,
      evidence_complete: false,
    },
    paths: {
      run_root: actualRunRoot,
      target_workspace: path.join(actualRunRoot, "workspaces", "target"),
      report_json: path.join(reportRoot, "report.json"),
      report_markdown: path.join(reportRoot, "report.md"),
    },
  };
}

function persistResult(
  paths: ReturnType<typeof createRunLayout>,
  result: ExploreResultV1
): ExploreResultV1 {
  writeJson(paths.result, result);
  writeJson(paths.report_json, result);
  fs.writeFileSync(paths.report_markdown, renderExploreReport(result), "utf8");
  return result;
}

function renderExploreReport(result: ExploreResultV1): string {
  const reviewer =
    result.reviewer.status === "completed"
      ? result.reviewer.output
      : undefined;
  const inspector =
    result.inspector.status === "completed"
      ? result.inspector.output
      : undefined;
  return [
    `# Barena Explore: ${result.scenario_id}`,
    "",
    `- Status: **${result.status}**`,
    `- Runtime: XiaoBaOS`,
    `- Target Role: \`${result.runtime.target_role}\``,
    `- Turns: ${result.turns.filter((turn) => turn.target).length}`,
    `- Inspector issues: ${inspector?.issues.length ?? 0}`,
    `- Native OTLP: ${result.evidence.native_otlp_envelopes} envelopes / ${result.evidence.native_otlp_spans} spans`,
    `- Evidence complete: ${result.evidence.evidence_complete}`,
    `- Replay candidates: ${result.replay_case_candidates.length}`,
    "",
    "## Objective",
    "",
    result.scenario.objective,
    "",
    "## Verdict",
    "",
    reviewer?.summary ?? result.summary,
    "",
    "## Evidence",
    "",
    `- Boundary trace: \`${result.evidence.boundary_trace}\``,
    `- OTel spans: \`${result.evidence.otlp_spans}\``,
    `- OTLP manifest: \`${result.evidence.otlp_manifest}\``,
    `- Target workspace: \`${result.paths.target_workspace}\``,
    "",
  ].join("\n");
}

function resolveRootTraceId(value: string | undefined): string {
  const traceId = value ?? crypto.randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) {
    throw new Error("Explore root Trace ID must be 32 lowercase hex characters.");
  }
  return traceId;
}

function redactExploreResult(
  result: ExploreResultV1,
  secrets: string[]
): ExploreResultV1 {
  const redacted = redactResultValue(result, secrets) as ExploreResultV1;
  redacted.paths = { ...result.paths };
  redacted.evidence.boundary_trace = result.evidence.boundary_trace;
  redacted.evidence.otlp_manifest = result.evidence.otlp_manifest;
  redacted.evidence.otlp_spans = result.evidence.otlp_spans;
  redacted.evidence.native_trace_refs = [...result.evidence.native_trace_refs];
  redacted.evidence.secret_redaction.files = [
    ...result.evidence.secret_redaction.files,
  ];
  redacted.evidence.secret_redaction.unscanned_files = [
    ...result.evidence.secret_redaction.unscanned_files,
  ];
  for (const [index, turn] of redacted.turns.entries()) {
    turn.user_simulator.raw_ref = result.turns[index]!.user_simulator.raw_ref;
  }
  if (redacted.inspector.status !== "not_run" && result.inspector.status !== "not_run") {
    redacted.inspector.raw_ref = result.inspector.raw_ref;
  }
  if (redacted.reviewer.status !== "not_run" && result.reviewer.status !== "not_run") {
    redacted.reviewer.raw_ref = result.reviewer.raw_ref;
  }
  return redacted;
}

function redactResultValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactTextValue(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactResultValue(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactResultValue(item, secrets),
      ])
    );
  }
  return value;
}

function redactTextValue(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join("*".repeat(secret.length));
  }
  return output;
}

function createRunLayout(runRoot: string) {
  const paths = {
    run_root: runRoot,
    scenario: path.join(runRoot, "scenario.json"),
    runtime: path.join(runRoot, "runtime"),
    target_workspace: path.join(runRoot, "workspaces", "target"),
    user_workspace: path.join(runRoot, "workspaces", "user-simulator"),
    inspector_workspace: path.join(runRoot, "workspaces", "inspector"),
    reviewer_workspace: path.join(runRoot, "workspaces", "reviewer"),
    boundary_trace: path.join(runRoot, "traces", "boundary.ndjson"),
    user_stage: path.join(runRoot, "evaluator", "user-simulator"),
    inspector_raw: path.join(runRoot, "evaluator", "inspector", "raw.txt"),
    inspector_json: path.join(runRoot, "evaluator", "inspector", "issues.json"),
    reviewer_raw: path.join(runRoot, "evaluator", "reviewer", "raw.txt"),
    reviewer_json: path.join(runRoot, "evaluator", "reviewer", "scorecard.json"),
    replay_candidates: path.join(runRoot, "replay-candidates.json"),
    result: path.join(runRoot, "explore-result.json"),
    report_json: path.join(runRoot, "reports", "report.json"),
    report_markdown: path.join(runRoot, "reports", "report.md"),
  };
  for (const directory of [
    paths.run_root,
    paths.runtime,
    paths.target_workspace,
    paths.user_workspace,
    paths.inspector_workspace,
    paths.reviewer_workspace,
    path.dirname(paths.boundary_trace),
    paths.user_stage,
    path.dirname(paths.inspector_raw),
    path.dirname(paths.reviewer_raw),
    path.dirname(paths.report_json),
  ]) {
    ensureDir(directory);
  }
  return paths;
}

function reserveRunRoot(runsRoot: string, runId: string): string {
  const root = path.resolve(runsRoot);
  ensureDir(root);
  const runRoot = path.join(root, runId);
  try {
    fs.mkdirSync(runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Explore run directory already exists and will not be reused: ${runRoot}`);
    }
    throw error;
  }
  return runRoot;
}

function createExploreCancellation(
  adapter: AgentRuntimeAdapter,
  signal: AbortSignal | undefined
): ExploreCancellation {
  const activeSessions = new Set<AgentRuntimeSession>();
  const pending = new Set<Promise<unknown>>();

  const cancelSession = (session: AgentRuntimeSession): void => {
    const cancellation = adapter
      .cancel(session, abortDetail(signal))
      .catch(() => false);
    pending.add(cancellation);
    void cancellation.finally(() => pending.delete(cancellation));
  };

  const onAbort = () => {
    for (const session of activeSessions) cancelSession(session);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    isCancelled: () => signal?.aborted === true,
    detail: () => abortDetail(signal),
    beginTurn: async (session) => {
      if (signal?.aborted) {
        cancelSession(session);
        await Promise.allSettled([...pending]);
        return false;
      }
      activeSessions.add(session);
      if (signal?.aborted) {
        cancelSession(session);
        await Promise.allSettled([...pending]);
        activeSessions.delete(session);
        return false;
      }
      return true;
    },
    endTurn: (session) => {
      activeSessions.delete(session);
    },
    waitForPending: async () => {
      await Promise.allSettled([...pending]);
    },
    dispose: () => {
      signal?.removeEventListener("abort", onAbort);
      activeSessions.clear();
    },
  };
}

function abortDetail(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) {
    return `Explore cancelled: ${reason.message}`;
  }
  if (typeof reason === "string" && reason.trim()) {
    return `Explore cancelled: ${reason.trim()}`;
  }
  return "Explore cancelled by the caller.";
}

function cancelledProbe(
  adapter: AgentRuntimeAdapter,
  detail: string
): RuntimeProbeResult {
  return {
    runtime_id: adapter.id,
    status: "blocked",
    reason_code: "turn_cancelled",
    detail,
    command: adapter.id,
    capabilities: adapter.capabilities,
    validated_targets: [],
  };
}

function cancelledRuntime(detail: string): {
  status: RuntimeTurnResult["status"];
  reason_code: RuntimeTurnResult["reason_code"];
  detail: string;
} {
  return {
    status: "cancelled",
    reason_code: "turn_cancelled",
    detail,
  };
}

function cancelledStage<T>(
  detail: string,
  previous?: ExploreStageResult<T>
): BlockedExploreStage {
  return {
    status: "blocked",
    detail,
    reason_code: "turn_cancelled",
    ...(previous && "raw_ref" in previous && previous.raw_ref
      ? { raw_ref: previous.raw_ref }
      : {}),
    ...(previous && "process" in previous && previous.process
      ? { process: previous.process }
      : {}),
  };
}

function cancelledTurnResult(
  adapter: AgentRuntimeAdapter,
  detail: string
): RuntimeTurnResult {
  return {
    status: "cancelled",
    reason_code: "turn_cancelled",
    detail,
    process: {
      exit_code: null,
      signal: null,
      duration_ms: 0,
      stdout: "",
      stderr: "",
    },
    telemetry: {
      mode: adapter.capabilities.telemetry,
      configured: false,
      trace_context_propagated: false,
    },
    native_trace_refs: [],
  };
}

function createRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `explore-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function emptySecretRedaction(): ReturnType<typeof redactSecretsInDirectory> {
  return { files: [], occurrences: 0, unscanned_files: [] };
}

function prefixSecretRedaction(
  value: ReturnType<typeof redactSecretsInDirectory>,
  prefix: string
): ReturnType<typeof redactSecretsInDirectory> {
  return {
    files: value.files.map((file) => path.join(prefix, file)),
    occurrences: value.occurrences,
    unscanned_files: value.unscanned_files.map((file) => path.join(prefix, file)),
  };
}

function mergeSecretRedactions(
  ...values: Array<ReturnType<typeof redactSecretsInDirectory>>
): ReturnType<typeof redactSecretsInDirectory> {
  return {
    files: [...new Set(values.flatMap((value) => value.files))].sort(),
    occurrences: values.reduce((sum, value) => sum + value.occurrences, 0),
    unscanned_files: [
      ...new Set(values.flatMap((value) => value.unscanned_files)),
    ].sort(),
  };
}
