import crypto from "node:crypto";
import {
  BarenaPlatformClient,
  platformConnectionFromEnv,
  type BarenaPlatformConnection,
} from "../platform-client";
import {
  ENGINE_EVENT_SCHEMA_V1,
  type EngineEventV1,
} from "../engine-protocol";
import { buildExploreOtlpPayload } from "../telemetry/explore-otlp-export";
import { runExploreScenario } from "./runner";
import type {
  ExploreProgressEvent,
  ExploreResultV1,
  ExploreRunOptions,
  ExploreScenarioV1,
} from "./types";

export interface ConnectedExploreOptions extends ExploreRunOptions {
  platform?: BarenaPlatformConnection | false;
}

export async function runConnectedExploreScenario(
  scenario: ExploreScenarioV1,
  options: ConnectedExploreOptions = {}
): Promise<ExploreResultV1> {
  const connection =
    options.platform === false
      ? undefined
      : options.platform ?? platformConnectionFromEnv();
  if (!connection) return runExploreScenario(scenario, options);

  const client = new BarenaPlatformClient(connection);
  const rootTraceId = connectedTraceId(options.root_trace_id);
  const remoteRun = await client.createRun({
    operation: "explore",
    input: {
      scenario,
      primary_trace_id: rootTraceId,
      trace_ids: [rootTraceId],
      evidence: {
        primary_trace_id: rootTraceId,
        trace_ids: [rootTraceId],
      },
    },
    runtime: {
      runtime: scenario.target.runtime,
      role: scenario.target.role,
      ...(scenario.target.skill && { skill: scenario.target.skill }),
    },
  });
  let uploadFailure: Error | undefined;
  const progress: ExploreProgressEvent[] = [];
  let lastSequence = 0;
  try {
    const result = await runExploreScenario(scenario, {
      ...options,
      run_id: remoteRun.run_id,
      root_trace_id: rootTraceId,
      otlp_forward: client.otlpForwardOptions(),
      on_progress: async (event) => {
        progress.push(event);
        lastSequence = Math.max(lastSequence, event.sequence);
        try {
          await options.on_progress?.(event);
        } catch {
          // Preserve the core runner's optional observer behavior.
        }
        if (uploadFailure) return;
        try {
          await client.appendEvent(
            remoteRun.run_id,
            engineEventFromExploreProgress(remoteRun.run_id, event, rootTraceId)
          );
        } catch (error) {
          uploadFailure = asError(error);
        }
      },
    });
    if (uploadFailure) {
      throw uploadFailure;
    }
    assertOtlpForwardingComplete(result);
    await client.exportOtlpJson(
      buildExploreOtlpPayload({
        runId: remoteRun.run_id,
        traceId: rootTraceId,
        result,
        progress,
      })
    );
    await client.appendEvent(
      remoteRun.run_id,
      engineEventFromExploreResult(
        remoteRun.run_id,
        lastSequence + 1,
        rootTraceId,
        result
      )
    );
    await client.finishRun(remoteRun.run_id, "completed");
    return result;
  } catch (error) {
    try {
      await client.finishRun(remoteRun.run_id, "failed", safeError(error));
    } catch {
      // Preserve the original endpoint execution or evidence upload error.
    }
    throw error;
  }
}

export function engineEventFromExploreProgress(
  runId: string,
  event: ExploreProgressEvent,
  traceId?: string
): EngineEventV1 {
  const {
    schema: sourceSchema,
    sequence: sourceSequence,
    timestamp: sourceTimestamp,
    actor,
    stage,
    turn,
    ...payload
  } = event;
  return {
    schema: ENGINE_EVENT_SCHEMA_V1,
    event_id: `${runId}.${event.sequence}`,
    run_id: runId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    operation: "explore",
    kind: "progress",
    phase: stage,
    actor,
    ...(traceId && { trace_id: traceId }),
    ...(turn && { attempt_id: `turn-${turn}` }),
    payload: {
      source_schema: sourceSchema,
      source_sequence: sourceSequence,
      source_timestamp: sourceTimestamp,
      ...(turn && { turn }),
      ...payload,
    },
  };
}

export function engineEventFromExploreResult(
  runId: string,
  sequence: number,
  traceId: string,
  result: ExploreResultV1
): EngineEventV1 {
  return {
    schema: ENGINE_EVENT_SCHEMA_V1,
    event_id: `${runId}.${sequence}`,
    run_id: runId,
    sequence,
    timestamp: result.completed_at,
    operation: "explore",
    kind: "terminal",
    phase: "complete",
    actor: "engine",
    trace_id: traceId,
    payload: compactExploreFacts(result),
  };
}

function assertOtlpForwardingComplete(result: ExploreResultV1): void {
  const forwarding = result.evidence.otlp_forwarding;
  if (!forwarding) {
    throw new Error("Connected Explore did not record Platform OTLP forwarding.");
  }
  if (
    forwarding.status === "failed" ||
    forwarding.failed_envelopes > 0 ||
    forwarding.forwarded_envelopes !== forwarding.attempted_envelopes
  ) {
    throw new Error(
      `Connected Explore retained local OTLP but Platform forwarding failed: ${
        forwarding.last_error ??
        `${forwarding.forwarded_envelopes}/${forwarding.attempted_envelopes} envelopes uploaded`
      }`
    );
  }
}

function compactExploreFacts(result: ExploreResultV1): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: "barena.explore_terminal_fact.v1",
    status: result.status,
    ...(result.reason_code && { reason_code: bounded(result.reason_code, 120) }),
    summary: bounded(result.summary, 600),
    scenario: {
      scenario_id: result.scenario_id,
      objective: bounded(result.scenario.objective, 600),
      target: {
        runtime: result.scenario.target.runtime,
        role: result.scenario.target.role,
        ...(result.scenario.target.skill && {
          skill: bounded(result.scenario.target.skill, 120),
        }),
      },
      success_criteria: (result.scenario.success_criteria ?? [])
        .slice(0, 6)
        .map((criterion) => bounded(criterion, 240)),
    },
    transcript: result.transcript.slice(-6).map((message) => ({
      turn: message.turn,
      role: message.role,
      actor: message.actor,
      content: bounded(message.content, 320),
    })),
    inspector:
      result.inspector.status === "completed"
        ? {
            status: "completed",
            summary: bounded(result.inspector.output.summary, 400),
            evidence_complete: result.inspector.output.evidence_complete,
            issues: result.inspector.output.issues.slice(0, 3).map((issue) => ({
              issue_id: bounded(issue.issue_id, 120),
              severity: issue.severity,
              family: bounded(issue.family, 120),
              summary: bounded(issue.summary, 240),
              evidence: issue.evidence
                .slice(0, 2)
                .map((value) => bounded(value, 180)),
              ...(issue.replay_prompt && {
                replay_prompt: bounded(issue.replay_prompt, 240),
              }),
            })),
          }
        : {
            status: result.inspector.status,
            detail: bounded(result.inspector.detail, 400),
          },
    reviewer:
      result.reviewer.status === "completed"
        ? {
            status: "completed",
            verdict: result.reviewer.output.verdict,
            summary: bounded(result.reviewer.output.summary, 400),
            scores: result.reviewer.output.scores,
            criteria: result.reviewer.output.criteria.slice(0, 4).map((item) => ({
              criterion: bounded(item.criterion, 180),
              status: item.status,
              evidence: item.evidence
                .slice(0, 1)
                .map((value) => bounded(value, 180)),
            })),
          }
        : {
            status: result.reviewer.status,
            detail: bounded(result.reviewer.detail, 400),
          },
    evidence: {
      complete: result.evidence.evidence_complete,
      root_trace_id: result.evidence.root_trace_id,
      native_trace_ids: result.evidence.native_trace_ids.slice(0, 16),
      native_otlp_envelopes: result.evidence.native_otlp_envelopes,
      native_otlp_spans: result.evidence.native_otlp_spans,
      workspace_changes: result.evidence.workspace_changes
        .slice(0, 12)
        .map((change) => ({ path: bounded(change.path, 240), change: change.change })),
      unsafe_workspace_entries: result.evidence.unsafe_workspace_entries.length,
      secret_redactions: result.evidence.secret_redaction.occurrences,
      otlp_forwarding: result.evidence.otlp_forwarding
        ? {
            status: result.evidence.otlp_forwarding.status,
            attempted_envelopes:
              result.evidence.otlp_forwarding.attempted_envelopes,
            forwarded_envelopes:
              result.evidence.otlp_forwarding.forwarded_envelopes,
            failed_envelopes: result.evidence.otlp_forwarding.failed_envelopes,
          }
        : null,
    },
    replay_case_candidates: result.replay_case_candidates
      .slice(0, 3)
      .map((candidate) => ({
        candidate_id: bounded(candidate.candidate_id, 120),
        issue_summary: bounded(candidate.issue_summary, 220),
        prompt: bounded(candidate.prompt, 240),
        evidence: candidate.evidence
          .slice(0, 1)
          .map((value) => bounded(value, 180)),
      })),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) <= 10_000) return payload;
  return {
    schema: payload.schema,
    status: payload.status,
    ...(result.reason_code && { reason_code: bounded(result.reason_code, 120) }),
    summary: bounded(result.summary, 500),
    scenario: payload.scenario,
    transcript: result.transcript.slice(-3).map((message) => ({
      turn: message.turn,
      role: message.role,
      content: bounded(message.content, 240),
    })),
    inspector:
      result.inspector.status === "completed"
        ? {
            status: "completed",
            summary: bounded(result.inspector.output.summary, 300),
            evidence_complete: result.inspector.output.evidence_complete,
            issues: result.inspector.output.issues.slice(0, 2).map((issue) => ({
              severity: issue.severity,
              summary: bounded(issue.summary, 200),
            })),
          }
        : { status: result.inspector.status },
    reviewer:
      result.reviewer.status === "completed"
        ? {
            status: "completed",
            verdict: result.reviewer.output.verdict,
            summary: bounded(result.reviewer.output.summary, 300),
            scores: result.reviewer.output.scores,
          }
        : { status: result.reviewer.status },
    evidence: payload.evidence,
    replay_case_candidates: result.replay_case_candidates
      .slice(0, 2)
      .map((candidate) => ({
        issue_summary: bounded(candidate.issue_summary, 180),
        prompt: bounded(candidate.prompt, 220),
      })),
    truncated: true,
  };
}

function connectedTraceId(value: string | undefined): string {
  const traceId = value ?? crypto.randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) {
    throw new Error("Connected Explore Trace ID must be 32 lowercase hex characters.");
  }
  return traceId;
}

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeError(error: unknown): string {
  return asError(error).message.replace(/\s+/g, " ").trim().slice(0, 2_000);
}
