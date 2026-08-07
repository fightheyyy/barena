import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BarenaPlatformClient,
  platformConnectionFromEnv,
  type BarenaPlatformConnection,
  type PlatformRunBundleV1,
  type PlatformRunBundleSyncResult,
} from "../platform-client";
import {
  ENGINE_EVENT_SCHEMA_V1,
  type EngineEventV1,
} from "../engine-protocol";
import { buildExploreOtlpPayload } from "../telemetry/explore-otlp-export";
import type { OtlpReceiverManifest } from "../runtime-adapters";
import { readJson, writeJson } from "../utils/fs";
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

export type ConnectedExploreSyncStatus = "pending" | "failed" | "synced";

export interface ConnectedExploreSyncRecordV1 {
  schema: "barena.catena_sync.v1";
  run_id: string;
  trace_id: string;
  status: ConnectedExploreSyncStatus;
  attempted_at: string;
  completed_at?: string;
  run_bundle_ref: string;
  run_bundle_sha256: string;
  native_otlp: {
    status: ConnectedExploreSyncStatus;
    attempted_envelopes: number;
    synced_envelopes: number;
    failed_envelopes: number;
  };
  summary_otlp: {
    status: ConnectedExploreSyncStatus;
  };
  run_bundle: {
    status: ConnectedExploreSyncStatus;
    transport?: PlatformRunBundleSyncResult["transport"];
    remote_run_id?: string;
  };
  errors: string[];
}

export async function runConnectedExploreScenario(
  scenario: ExploreScenarioV1,
  options: ConnectedExploreOptions = {}
): Promise<ExploreResultV1> {
  if (options.platform === false) return runExploreScenario(scenario, options);
  let connection: BarenaPlatformConnection | undefined;
  let connectionError: Error | undefined;
  try {
    connection = options.platform ?? platformConnectionFromEnv();
  } catch (error) {
    connectionError = asError(error);
  }
  if (!connection && !connectionError) {
    return runExploreScenario(scenario, options);
  }

  const rootTraceId = connectedTraceId(options.root_trace_id);
  const progress: ExploreProgressEvent[] = [];
  const { platform: _platform, ...localOptions } = options;
  const result = await runExploreScenario(scenario, {
    ...localOptions,
    root_trace_id: rootTraceId,
    // Catena synchronization starts only after runExploreScenario has stopped
    // its receiver, redacted evidence, and persisted the terminal result.
    otlp_forward: undefined,
    on_progress: async (event) => {
      progress.push(event);
      await options.on_progress?.(event);
    },
  });

  await syncRetainedExplore({
    result,
    progress,
    traceId: rootTraceId,
    connection,
    connectionError,
  });
  return result;
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

async function syncRetainedExplore(input: {
  result: ExploreResultV1;
  progress: ExploreProgressEvent[];
  traceId: string;
  connection?: BarenaPlatformConnection;
  connectionError?: Error;
}): Promise<void> {
  const runRoot = path.resolve(input.result.paths.run_root);
  const bundle = buildRunBundle(input.result, input.progress, input.traceId);
  const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const bundleRef = path.join(runRoot, "catena", "run-bundle.json");
  const syncRef = path.join(runRoot, "catena", "sync.json");
  writeJson(bundleRef, bundle);

  const record: ConnectedExploreSyncRecordV1 = {
    schema: "barena.catena_sync.v1",
    run_id: input.result.run_id,
    trace_id: input.traceId,
    status: "pending",
    attempted_at: new Date().toISOString(),
    run_bundle_ref: bundleRef,
    run_bundle_sha256: crypto
      .createHash("sha256")
      .update(bundleBytes)
      .digest("hex"),
    native_otlp: {
      status: "pending",
      attempted_envelopes: input.result.evidence.native_otlp_envelopes,
      synced_envelopes: 0,
      failed_envelopes: 0,
    },
    summary_otlp: { status: "pending" },
    run_bundle: { status: "pending" },
    errors: [],
  };
  writeJson(syncRef, record);

  if (input.connectionError || !input.connection) {
    failPendingSync(record);
    addSyncError(
      record,
      "connection",
      input.connectionError ?? new Error("Catena connection is unavailable"),
    );
    finishSyncRecord(syncRef, record);
    return;
  }

  let client: BarenaPlatformClient;
  try {
    client = new BarenaPlatformClient(input.connection);
  } catch (error) {
    failPendingSync(record);
    addSyncError(record, "connection", error);
    finishSyncRecord(syncRef, record);
    return;
  }

  try {
    const envelopes = retainedOtlpEnvelopes(input.result);
    record.native_otlp.attempted_envelopes = envelopes.length;
    for (const envelope of envelopes) {
      try {
        const body = readVerifiedEnvelope(runRoot, envelope);
        await client.exportOtlpEnvelope(body, envelope.content_type);
        record.native_otlp.synced_envelopes += 1;
      } catch (error) {
        record.native_otlp.failed_envelopes += 1;
        addSyncError(record, `native OTLP ${envelope.envelope_id}`, error);
      }
    }
    record.native_otlp.status =
      record.native_otlp.failed_envelopes > 0 ? "failed" : "synced";
  } catch (error) {
    record.native_otlp.status = "failed";
    record.native_otlp.failed_envelopes =
      record.native_otlp.attempted_envelopes;
    addSyncError(record, "native OTLP manifest", error);
  }

  try {
    await client.exportOtlpJson(
      buildExploreOtlpPayload({
        runId: input.result.run_id,
        traceId: input.traceId,
        result: input.result,
        progress: input.progress,
      }),
    );
    record.summary_otlp.status = "synced";
  } catch (error) {
    record.summary_otlp.status = "failed";
    addSyncError(record, "Barena summary OTLP", error);
  }

  try {
    const synced = await client.syncRunBundle(
      bundle,
      `barena:${input.result.run_id}:explore`,
    );
    record.run_bundle = {
      status: "synced",
      transport: synced.transport,
      remote_run_id: synced.remote_run_id,
    };
  } catch (error) {
    record.run_bundle.status = "failed";
    addSyncError(record, "Run Bundle", error);
  }

  record.status =
    record.native_otlp.status === "synced" &&
    record.summary_otlp.status === "synced" &&
    record.run_bundle.status === "synced"
      ? "synced"
      : "failed";
  finishSyncRecord(syncRef, record);
}

function buildRunBundle(
  result: ExploreResultV1,
  progress: ExploreProgressEvent[],
  traceId: string,
): PlatformRunBundleV1 {
  const events = progress.map((event) =>
    engineEventFromExploreProgress(result.run_id, event, traceId),
  );
  const lastSequence = events.reduce(
    (maximum, event) => Math.max(maximum, event.sequence),
    0,
  );
  const terminal = engineEventFromExploreResult(
    result.run_id,
    lastSequence + 1,
    traceId,
    result,
  );
  events.push(terminal);
  const traceIds = [
    ...new Set([traceId, ...result.evidence.native_trace_ids]),
  ].slice(0, 64);
  return {
    schema: "barena.run_bundle.v1",
    run: {
      run_id: result.run_id,
      operation: "explore",
      state: "completed",
      input: {
        scenario: result.scenario,
        primary_trace_id: traceId,
        trace_ids: traceIds,
        evidence: {
          primary_trace_id: traceId,
          trace_ids: traceIds,
        },
      },
      runtime: {
        runtime: result.scenario.target.runtime,
        role: result.runtime.target_role,
        ...(result.scenario.target.skill && {
          skill: result.scenario.target.skill,
        }),
      },
      created_at: result.created_at,
      updated_at: result.completed_at,
    },
    events,
    terminal_fact_sha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(terminal.payload))
      .digest("hex"),
  };
}

function retainedOtlpEnvelopes(
  result: ExploreResultV1,
): OtlpReceiverManifest["envelopes"] {
  const manifestPath = containedRunFile(
    result.paths.run_root,
    result.evidence.otlp_manifest,
  );
  const manifest = readJson<OtlpReceiverManifest>(manifestPath);
  if (manifest.schema !== "barena.otlp_receiver_manifest.v1") {
    throw new Error("retained OTLP manifest schema is invalid");
  }
  if (manifest.envelopes.length !== manifest.envelope_count) {
    throw new Error("retained OTLP manifest envelope count does not match");
  }
  if (manifest.envelope_count !== result.evidence.native_otlp_envelopes) {
    throw new Error("retained OTLP manifest does not match Explore evidence");
  }
  return manifest.envelopes;
}

function readVerifiedEnvelope(
  runRoot: string,
  envelope: OtlpReceiverManifest["envelopes"][number],
): Buffer {
  if (
    !/^application\/(?:json|x-protobuf|protobuf)(?:\s*;[^\r\n]*)?$/i.test(
      envelope.content_type,
    )
  ) {
    throw new Error("retained OTLP envelope content type is invalid");
  }
  const filePath = containedRunFile(runRoot, envelope.raw_ref);
  const body = fs.readFileSync(filePath);
  if (body.length !== envelope.bytes) {
    throw new Error("retained OTLP envelope size does not match");
  }
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  if (hash !== envelope.sha256) {
    throw new Error("retained OTLP envelope hash does not match");
  }
  return body;
}

function containedRunFile(runRoot: string, candidate: string): string {
  const requestedRoot = path.resolve(runRoot);
  const requested = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(requestedRoot, candidate);
  const relative = path.relative(requestedRoot, requested);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("retained evidence path escapes the Explore Run");
  }
  const root = fs.realpathSync(requestedRoot);
  const actual = fs.realpathSync(requested);
  const actualRelative = path.relative(root, actual);
  if (
    actualRelative === ".." ||
    actualRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(actualRelative) ||
    !fs.statSync(actual).isFile()
  ) {
    throw new Error("retained evidence is not a regular Run file");
  }
  return actual;
}

function failPendingSync(record: ConnectedExploreSyncRecordV1): void {
  record.status = "failed";
  record.native_otlp.status = "failed";
  record.native_otlp.failed_envelopes =
    record.native_otlp.attempted_envelopes;
  record.summary_otlp.status = "failed";
  record.run_bundle.status = "failed";
}

function addSyncError(
  record: ConnectedExploreSyncRecordV1,
  stage: string,
  error: unknown,
): void {
  if (record.errors.length >= 8) return;
  const detail = `${stage}: ${safeError(error)}`.slice(0, 500);
  if (!record.errors.includes(detail)) record.errors.push(detail);
}

function finishSyncRecord(
  syncRef: string,
  record: ConnectedExploreSyncRecordV1,
): void {
  record.completed_at = new Date().toISOString();
  writeJson(syncRef, record);
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
