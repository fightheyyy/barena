import crypto from "node:crypto";
import type { RuntimeTelemetryConfig } from "../runtime-adapters";
import type {
  AgentSimulationCaseV1,
  AgentSimulationResultV1,
  AgentSimulationTurnWindow,
  SimulationObservationReceipt,
} from "./types";

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

export interface SimulationTraceContext {
  traceId: string;
  rootSpanId: string;
  upstreamParentSpanId?: string;
  traceFlags: string;
}

export function createSimulationTraceContext(upstreamTraceparent?: string): SimulationTraceContext {
  const upstream = parseTraceparent(upstreamTraceparent);
  const traceId = upstream?.traceId ?? nonZeroHex(16);
  const rootSpanId = nonZeroHex(8);
  return {
    traceId,
    rootSpanId,
    upstreamParentSpanId: upstream?.spanId,
    traceFlags: upstream?.flags ?? "01",
  };
}

export function createSimulationTurnTraceparent(
  context: SimulationTraceContext,
  runId: string,
  turn: number
): string {
  return `00-${context.traceId}-${simulationTurnSpanId(runId, turn)}-${context.traceFlags}`;
}

export async function exportSimulationObservation(input: {
  telemetry: RuntimeTelemetryConfig;
  context: SimulationTraceContext;
  caseDefinition: AgentSimulationCaseV1;
  result: AgentSimulationResultV1;
  threadId: string;
  startedAt: Date;
  endedAt: Date;
  turnWindows: AgentSimulationTurnWindow[];
}): Promise<SimulationObservationReceipt> {
  const spans = simulationSpans(input);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.telemetry.export_timeout_ms ?? 10_000
  );
  try {
    const endpoint = new URL(input.telemetry.traces_endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("Catena observation requires an OTLP/HTTP endpoint.");
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(input.telemetry.headers ?? {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceSpans: [{
          resource: {
            attributes: [
              stringAttribute("service.name", "barena"),
              stringAttribute("agent.runtime", input.caseDefinition.target.adapter),
              stringAttribute("gen_ai.system", input.caseDefinition.target.adapter),
              stringAttribute("catena.source", "barena-simulation"),
              stringAttribute("barena.run.id", input.result.run_id),
              stringAttribute("barena.case.id", input.result.case_id),
              ...(input.result.target.requested_model
                ? [stringAttribute("gen_ai.request.model", input.result.target.requested_model)]
                : []),
            ],
          },
          scopeSpans: [{
            scope: { name: "barena.simulation", version: "0.1.0" },
            spans,
          }],
        }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "failed",
        trace_id: input.context.traceId,
        span_count: spans.length,
        detail: `Catena OTLP endpoint returned HTTP ${response.status}.`,
      };
    }
    return {
      status: "sent",
      trace_id: input.context.traceId,
      span_count: spans.length,
      detail: "Barena boundary observation was accepted by the OTLP endpoint.",
    };
  } catch (error) {
    return {
      status: "failed",
      trace_id: input.context.traceId,
      span_count: spans.length,
      detail: error instanceof Error && error.name === "AbortError"
        ? "Catena OTLP upload timed out."
        : "Catena OTLP upload failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function simulationSpans(input: {
  context: SimulationTraceContext;
  caseDefinition: AgentSimulationCaseV1;
  result: AgentSimulationResultV1;
  threadId: string;
  startedAt: Date;
  endedAt: Date;
  turnWindows: AgentSimulationTurnWindow[];
}): OtlpSpan[] {
  const common = [
    stringAttribute("agent.session.id", input.threadId),
    stringAttribute("barena.run.id", input.result.run_id),
    stringAttribute("barena.case.id", input.result.case_id),
    ...(input.result.target.requested_model
      ? [stringAttribute("gen_ai.request.model", input.result.target.requested_model)]
      : []),
  ];
  const assertionCount = input.result.assertions.length;
  const passedAssertionCount = input.result.assertions.filter(
    (assertion) => assertion.status === "pass"
  ).length;
  const rootEnd = after(new Date(input.endedAt.getTime() + assertionCount + 1), input.startedAt);
  const root: OtlpSpan = {
    traceId: otlpId(input.context.traceId),
    spanId: otlpId(input.context.rootSpanId),
    ...(input.context.upstreamParentSpanId
      ? { parentSpanId: otlpId(input.context.upstreamParentSpanId) }
      : {}),
    name: "barena.simulation",
    kind: 1,
    startTimeUnixNano: unixNano(input.startedAt),
    endTimeUnixNano: unixNano(rootEnd),
    attributes: [
      ...common,
      stringAttribute("output.value", input.result.summary),
      stringAttribute("barena.result.status", input.result.status),
      stringAttribute("barena.run.kind", "simulation"),
      intAttribute("barena.turn.count", input.result.turns.length),
      intAttribute("barena.assertion.count", assertionCount),
      intAttribute("barena.assertion.passed_count", passedAssertionCount),
      boolAttribute("barena.telemetry.configured", input.result.evidence.telemetry_configured),
    ],
    status: status(input.result.status === "pass", input.result.summary),
  };
  const turns = input.result.turns.map((turn, index): OtlpSpan => {
    const window = input.turnWindows[index];
    const start = window?.startedAt ?? input.startedAt;
    const end = after(window?.endedAt ?? input.endedAt, start);
    return {
      traceId: root.traceId,
      spanId: otlpId(simulationTurnSpanId(input.result.run_id, turn.turn)),
      parentSpanId: root.spanId,
      name: "barena.turn",
      kind: 1,
      startTimeUnixNano: unixNano(start),
      endTimeUnixNano: unixNano(end),
      attributes: [
        ...common,
        stringAttribute("agent.turn.id", `turn-${turn.turn}`),
        intAttribute("barena.turn.index", turn.turn),
        stringAttribute("input.value", turn.user),
        stringAttribute("output.value", turn.assistant.map((message) => message.content).join("\n")),
        stringAttribute("barena.turn.status", turn.status),
        intAttribute("barena.process.duration_ms", turn.process.duration_ms),
      ],
      status: status(turn.status === "completed", turn.detail),
    };
  });
  const assertions = input.result.assertions.map((assertion, index): OtlpSpan => {
    const start = new Date(input.endedAt.getTime() + index);
    return {
      traceId: root.traceId,
      spanId: otlpId(stableSpanId(`${input.result.run_id}:assertion:${index}`)),
      parentSpanId: root.spanId,
      name: "barena.assertion",
      kind: 1,
      startTimeUnixNano: unixNano(start),
      endTimeUnixNano: unixNano(new Date(start.getTime() + 1)),
      attributes: [
        ...common,
        intAttribute("barena.assertion.index", index + 1),
        stringAttribute("barena.assertion.kind", assertion.kind),
        intAttribute("barena.assertion.expected_count", assertion.expected.length),
        stringAttribute("input.value", JSON.stringify(assertion.expected)),
        stringAttribute("output.value", assertion.detail),
        stringAttribute("barena.assertion.status", assertion.status),
      ],
      status: status(assertion.status === "pass", assertion.detail),
    };
  });
  return [root, ...turns, ...assertions];
}

function parseTraceparent(value?: string): { traceId: string; spanId: string; flags: string } | undefined {
  const match = value?.trim().toLowerCase().match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.+)?$/
  );
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

function status(ok: boolean, message: string): { code: number; message?: string } {
  return ok ? { code: 1 } : { code: 2, message: message.slice(0, 1_000) };
}

function after(value: Date, lowerBound: Date): Date {
  return value.getTime() > lowerBound.getTime() ? value : new Date(lowerBound.getTime() + 1);
}

function unixNano(value: Date): string {
  return String(BigInt(value.getTime()) * 1_000_000n);
}

function stableSpanId(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function simulationTurnSpanId(runId: string, turn: number): string {
  return stableSpanId(`${runId}:turn:${turn}`);
}

function nonZeroHex(bytes: number): string {
  let value = "";
  while (!value || /^0+$/.test(value)) value = crypto.randomBytes(bytes).toString("hex");
  return value;
}

function otlpId(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value.slice(0, 20_000) } };
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function boolAttribute(key: string, value: boolean): OtlpAttribute {
  return { key, value: { boolValue: value } };
}
