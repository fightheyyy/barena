import crypto from "node:crypto";
import type {
  ExploreProgressEvent,
  ExploreResultV1,
} from "../explore/types";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number };
}

export function buildExploreOtlpPayload(input: {
  runId: string;
  traceId: string;
  result: ExploreResultV1;
  progress: ExploreProgressEvent[];
}): Record<string, unknown> {
  assertTraceId(input.traceId);
  const rootSpanId = randomSpanId();
  const createdAt = validDate(input.result.created_at, new Date());
  const completedAt = validDate(input.result.completed_at, createdAt);
  const rootStart = new Date(
    Math.min(
      createdAt.getTime(),
      ...input.progress.map((event) =>
        validDate(event.timestamp, createdAt).getTime()
      )
    )
  );
  const rootEnd = new Date(
    Math.max(rootStart.getTime() + 1, completedAt.getTime())
  );
  const spans: OtlpSpan[] = [
    otlpSpan({
      traceId: input.traceId,
      spanId: rootSpanId,
      name: "barena.explore",
      start: rootStart,
      end: rootEnd,
      error:
        input.result.status === "blocked" || input.result.status === "unsafe",
      attributes: {
        "barena.run.id": input.runId,
        "barena.operation": "explore",
        "barena.scenario.id": input.result.scenario_id,
        "barena.target.runtime": input.result.scenario.target.runtime,
        "barena.target.role": input.result.runtime.target_role,
        "barena.result.status": input.result.status,
        "barena.evidence.complete": input.result.evidence.evidence_complete,
        "barena.provenance.layer": "barena_evaluator",
      },
    }),
  ];
  for (const [index, event] of input.progress.entries()) {
    const start = validDate(event.timestamp, rootStart);
    const next = input.progress[index + 1];
    const candidateEnd = next
      ? validDate(next.timestamp, rootEnd)
      : rootEnd;
    const end = new Date(Math.max(start.getTime() + 1, candidateEnd.getTime()));
    spans.push(
      otlpSpan({
        traceId: input.traceId,
        spanId: randomSpanId(),
        parentSpanId: rootSpanId,
        name: `barena.explore.${event.stage}`,
        start,
        end,
        error: event.status === "blocked",
        attributes: {
          "barena.run.id": input.runId,
          "barena.event.sequence": event.sequence,
          "barena.event.actor": event.actor,
          "barena.event.stage": event.stage,
          "barena.event.status": event.status,
          "barena.provenance.layer": "barena_evaluator",
          ...(event.turn && { "barena.turn": event.turn }),
          ...(event.verdict && { "barena.verdict": event.verdict }),
          ...(event.issue_count !== undefined && {
            "barena.issue.count": event.issue_count,
          }),
          ...(event.summary && {
            "barena.event.summary": boundedText(event.summary, 500),
          }),
          ...(event.message && {
            "barena.event.message": boundedText(event.message, 500),
          }),
        },
      })
    );
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttributes({
            "service.name": "barena-explore-engine",
            "service.namespace": "barena",
            "barena.run.id": input.runId,
            "barena.provenance.origin": "barena_evaluator",
          }),
        },
        scopeSpans: [
          {
            scope: {
              name: "github.com/fightheyyy/barena",
              version: "0.1.0",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function otlpSpan(input: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: Date;
  end: Date;
  error: boolean;
  attributes: Record<string, string | number | boolean>;
}): OtlpSpan {
  return {
    traceId: hexBytes(input.traceId),
    spanId: hexBytes(input.spanId),
    ...(input.parentSpanId && { parentSpanId: hexBytes(input.parentSpanId) }),
    name: input.name,
    kind: 1,
    startTimeUnixNano: unixNano(input.start),
    endTimeUnixNano: unixNano(input.end),
    attributes: otlpAttributes(input.attributes),
    status: { code: input.error ? 2 : 1 },
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

function randomSpanId(): string {
  let value = crypto.randomBytes(8).toString("hex");
  while (/^0{16}$/.test(value)) value = crypto.randomBytes(8).toString("hex");
  return value;
}

function assertTraceId(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value) || /^0{32}$/.test(value)) {
    throw new Error("Explore Trace ID must be 32 lowercase hex characters.");
  }
}

function validDate(value: string, fallback: Date): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function unixNano(value: Date): string {
  return (BigInt(value.getTime()) * 1_000_000n).toString();
}

function hexBytes(value: string): string {
  return Buffer.from(value, "hex").toString("base64");
}

function boundedText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}
