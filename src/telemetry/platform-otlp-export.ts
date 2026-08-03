import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EngineEventV1, EngineRequestV1 } from "../engine-protocol";
import { readNdjson } from "../utils/fs";

const INTERNAL_TRACE_PATH = "/api/internal/barena/otel/v1/traces";

export interface PlatformTelemetryConfig {
  baseUrl: string;
  secret: string;
  fetch?: typeof globalThis.fetch;
}

export interface PlatformTraceExportResult {
  status: "exported" | "skipped" | "failed";
  span_count: number;
  detail: string;
}

interface BoundarySpanRecord {
  schema: "barena.boundary_otel_span.v1";
  trace_id: string;
  span_id: string;
  name: string;
  start_time: string;
  end_time: string;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
};

export async function exportPlatformReplayTrace(input: {
  request: EngineRequestV1;
  runRoot: string;
  traceId: string;
  config?: PlatformTelemetryConfig;
}): Promise<PlatformTraceExportResult> {
  const projectId = platformProjectId(input.request);
  if (!projectId) {
    return {
      status: "skipped",
      span_count: 0,
      detail: "Replay is not linked to a Platform project.",
    };
  }
  const config = input.config ?? environmentConfig();
  if (!config) {
    return {
      status: "skipped",
      span_count: 0,
      detail:
        "BARENA_PLATFORM_INTERNAL_URL and BARENA_GATEWAY_SECRET are not configured.",
    };
  }

  try {
    const endpoint = internalEndpoint(config.baseUrl);
    const events = readNdjson<EngineEventV1>(
      path.join(input.runRoot, "events.ndjson")
    );
    const boundaries = findBoundarySpans(
      input.runRoot,
      input.traceId
    );
    const spans = buildReplaySpans({
      request: input.request,
      traceId: input.traceId,
      events,
      boundaries,
    });
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: otlpAttributes({
              "service.name": "barena-replay-engine",
              "service.namespace": "barena",
              "barena.project.id": projectId,
              "barena.provenance.origin": "barena_evaluator",
            }),
          },
          scopeSpans: [
            {
              scope: { name: "github.com/fightheyyy/barena", version: "0.1.0" },
              spans,
            },
          ],
        },
      ],
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const canonical = [
      "POST",
      endpoint.pathname,
      projectId,
      `barena-engine:${input.request.run_id}`,
      timestamp,
      bodyHash,
    ].join("\n");
    const signature = crypto
      .createHmac("sha256", config.secret)
      .update(canonical)
      .digest("hex");
    const response = await (config.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Barena-Project-ID": projectId,
        "X-Barena-Actor-ID": `barena-engine:${input.request.run_id}`,
        "X-Barena-Gateway-Timestamp": timestamp,
        "X-Barena-Gateway-Body-SHA256": bodyHash,
        "X-Barena-Gateway-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
      return {
        status: "failed",
        span_count: spans.length,
        detail: `Platform OTLP ingestion returned HTTP ${response.status}: ${detail}`,
      };
    }
    return {
      status: "exported",
      span_count: spans.length,
      detail: `Exported ${spans.length} Barena-owned spans to project ${projectId}.`,
    };
  } catch (error) {
    return {
      status: "failed",
      span_count: 0,
      detail: `Platform OTLP export failed: ${safeError(error)}`,
    };
  }
}

function buildReplaySpans(input: {
  request: EngineRequestV1;
  traceId: string;
  events: EngineEventV1[];
  boundaries: BoundarySpanRecord[];
}): OtlpSpan[] {
  const rootSpanId = crypto.randomBytes(8).toString("hex");
  const eventDates = input.events.map((event) => new Date(event.timestamp));
  const boundaryStarts = input.boundaries.map(
    (boundary) => new Date(boundary.start_time)
  );
  const boundaryEnds = input.boundaries.map(
    (boundary) => new Date(boundary.end_time)
  );
  const start = minDate([...eventDates, ...boundaryStarts].filter(isDate));
  const end = maxDate([
    ...eventDates,
    ...boundaryEnds,
    new Date(),
  ].filter(isDate));
  const spans: OtlpSpan[] = [
    otlpSpan({
      traceId: input.traceId,
      spanId: rootSpanId,
      name: "barena.replay",
      start,
      end,
      kind: 1,
      status: "OK",
      attributes: {
        "barena.run.id": input.request.run_id,
        "barena.operation": "replay",
        "barena.actor.role": "engine",
        "barena.provenance.layer": "barena_evaluator",
      },
    }),
  ];
  for (const [index, event] of input.events.entries()) {
    const eventStart = new Date(event.timestamp);
    const next = input.events[index + 1];
    const eventEnd = next
      ? new Date(next.timestamp)
      : new Date(Math.max(eventStart.getTime() + 1, end.getTime()));
    const status =
      event.payload.status === "failed" ||
      event.payload.status === "blocked" ||
      event.payload.status === "unsafe"
        ? "ERROR"
        : "OK";
    spans.push(
      otlpSpan({
        traceId: input.traceId,
        spanId: crypto.randomBytes(8).toString("hex"),
        parentSpanId: rootSpanId,
        name: `barena.replay.${event.phase}`,
        start: eventStart,
        end: eventEnd,
        kind: 1,
        status,
        attributes: {
          "barena.run.id": event.run_id,
          "barena.event.id": event.event_id,
          "barena.event.kind": event.kind,
          "barena.actor.role": event.actor,
          "barena.provenance.layer": "barena_evaluator",
          ...(event.attempt_id && {
            "barena.attempt.id": event.attempt_id,
          }),
          ...(typeof event.payload.status === "string" && {
            "barena.phase.status": event.payload.status,
          }),
        },
      })
    );
  }
  for (const boundary of input.boundaries) {
    spans.push(
      otlpSpan({
        traceId: input.traceId,
        spanId: boundary.span_id,
        parentSpanId: rootSpanId,
        name: boundary.name,
        start: new Date(boundary.start_time),
        end: new Date(boundary.end_time),
        kind: 3,
        status: boundary.status,
        attributes: boundary.attributes,
      })
    );
  }
  return spans;
}

function otlpSpan(input: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: Date;
  end: Date;
  kind: number;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}): OtlpSpan {
  return {
    traceId: hexBytes(input.traceId),
    spanId: hexBytes(input.spanId),
    ...(input.parentSpanId && { parentSpanId: hexBytes(input.parentSpanId) }),
    name: input.name,
    kind: input.kind,
    startTimeUnixNano: unixNano(input.start),
    endTimeUnixNano: unixNano(input.end),
    attributes: otlpAttributes(input.attributes),
    status: { code: input.status === "OK" ? 1 : 2 },
  };
}

function otlpAttributes(values: Record<string, string | number | boolean>) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "boolean"
        ? { boolValue: value }
        : typeof value === "number"
          ? Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value }
          : { stringValue: value },
  }));
}

function findBoundarySpans(
  tracesRoot: string,
  traceId: string
): BoundarySpanRecord[] {
  if (!fs.existsSync(tracesRoot)) return [];
  const matches: BoundarySpanRecord[] = [];
  for (const filePath of filesBelow(tracesRoot)) {
    if (!filePath.endsWith("-otel.ndjson")) continue;
    for (const row of readNdjson<unknown>(filePath)) {
      if (!isBoundarySpan(row) || row.trace_id !== traceId) continue;
      matches.push(row);
    }
  }
  return matches.sort((left, right) =>
    left.start_time.localeCompare(right.start_time)
  );
}

function* filesBelow(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (
      entry.isDirectory() &&
      entry.name !== "workspace" &&
      entry.name !== "fixtures"
    ) {
      yield* filesBelow(candidate);
    }
    if (entry.isFile()) yield candidate;
  }
}

function isBoundarySpan(value: unknown): value is BoundarySpanRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === "barena.boundary_otel_span.v1" &&
    typeof row.trace_id === "string" &&
    /^[a-f0-9]{32}$/.test(row.trace_id) &&
    typeof row.span_id === "string" &&
    /^[a-f0-9]{16}$/.test(row.span_id) &&
    typeof row.name === "string" &&
    typeof row.start_time === "string" &&
    typeof row.end_time === "string" &&
    (row.status === "OK" || row.status === "ERROR") &&
    !!row.attributes &&
    typeof row.attributes === "object" &&
    !Array.isArray(row.attributes)
  );
}

function platformProjectId(request: EngineRequestV1): string | undefined {
  const platformCase = record(request.input.platform_case);
  const input = record(platformCase?.input);
  const source = record(input?.source);
  const projectId = source?.project_id;
  return typeof projectId === "string" && projectId.trim()
    ? projectId.trim()
    : undefined;
}

function environmentConfig(): PlatformTelemetryConfig | undefined {
  const baseUrl = process.env.BARENA_PLATFORM_INTERNAL_URL?.trim();
  const secret = process.env.BARENA_GATEWAY_SECRET?.trim();
  return baseUrl && secret ? { baseUrl, secret } : undefined;
}

function internalEndpoint(baseUrl: string): URL {
  const value = new URL(baseUrl);
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) {
    throw new Error("BARENA_PLATFORM_INTERNAL_URL must be an HTTP(S) origin");
  }
  value.pathname = INTERNAL_TRACE_PATH;
  value.search = "";
  value.hash = "";
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hexBytes(value: string): string {
  return Buffer.from(value, "hex").toString("base64");
}

function unixNano(value: Date): string {
  return (BigInt(value.getTime()) * 1_000_000n).toString();
}

function isDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function minDate(values: Date[]): Date {
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

function maxDate(values: Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
