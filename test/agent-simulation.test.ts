import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSession,
  OpenRuntimeSessionRequest,
  RuntimeCapabilities,
  RuntimeProbeResult,
  RuntimeTurnInput,
  RuntimeTurnResult,
} from "../src/runtime-adapters";
import {
  type AgentSimulationCaseV1,
  runAgentSimulationCase,
  validateAgentSimulationCase,
} from "../src/simulation";

class FakeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "xiaobaos";
  readonly capabilities: RuntimeCapabilities = {
    session_mode: "full-history-replay",
    output_protocol: "text",
    cancellation: true,
    telemetry: "native",
    trace_context_propagation: true,
    target_enumeration: true,
  };
  readonly turns: RuntimeTurnInput[] = [];
  readonly opened: OpenRuntimeSessionRequest[] = [];
  closed = 0;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      runtime_id: this.id,
      status: "ready",
      detail: "fake ready",
      command: "fake-xiaoba",
      capabilities: this.capabilities,
      validated_targets: ["base"],
    };
  }

  async openSession(request: OpenRuntimeSessionRequest): Promise<AgentRuntimeSession> {
    this.opened.push(request);
    return {
      runtime_id: this.id,
      session_id: request.session_id,
      thread_id: request.thread_id,
      workspace: request.workspace,
      target: request.target,
      session_mode: this.capabilities.session_mode,
      opened_at: new Date().toISOString(),
    };
  }

  async sendTurn(_session: AgentRuntimeSession, turn: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    this.turns.push(turn);
    return {
      status: "completed",
      detail: "fake completed",
      assistant: { role: "assistant", content: `heard ${this.turns.map((item) => item.message).join(" then ")}` },
      process: {
        exit_code: 0,
        signal: null,
        duration_ms: 5,
        stdout: "",
        stderr: "",
      },
      telemetry: {
        mode: "native",
        configured: Boolean(turn.telemetry),
        trace_context_propagated: Boolean(turn.telemetry?.traceparent),
      },
      native_trace_refs: [],
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

test("agent simulation uses one Runtime session and persists deterministic evidence", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-agent-simulation-"));
  const adapter = new FakeRuntimeAdapter();
  const result = await runAgentSimulationCase(simulationCase(), {
    runsRoot: path.join(temp, "runs"),
    adapter,
    now: () => new Date("2026-08-12T10:00:00.000Z"),
  });

  assert.equal(result.status, "pass");
  assert.equal(result.turns.length, 2);
  assert.equal(adapter.opened.length, 1);
  assert.equal(adapter.turns.length, 2);
  assert.equal(adapter.closed, 1);
  assert.equal(result.target.session_mode, "full-history-replay");
  assert.equal(result.target.requested_model, "gpt-5.6-sol");
  assert.equal(fs.existsSync(result.evidence.boundary_trace), true);
  assert.equal(
    fs.readFileSync(
      path.join(temp, "runs", result.run_id, "reports", "report.md"),
      "utf8"
    ).includes("Requested model: gpt-5.6-sol"),
    true
  );
});

test("agent simulation case requires explicit source attribution", () => {
  const value = simulationCase();
  value.source.commit = "";
  assert.throws(() => validateAgentSimulationCase(value), /source must include/);
});

test("agent simulation exports one Run trace and parents every Runtime turn", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-simulation-otlp-"));
  const adapter = new FakeRuntimeAdapter();
  const requests: Array<{ authorization?: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await runAgentSimulationCase(simulationCase(), {
      runsRoot: path.join(temp, "runs"),
      adapter,
      telemetry: {
        traces_endpoint: `http://127.0.0.1:${address.port}/v1/otlp/v1/traces`,
        headers: { authorization: "Bearer catena-test-key" },
        protocol: "http/protobuf",
      },
    });

    assert.equal(result.status, "pass");
    assert.equal(result.evidence.catena_observation?.status, "sent");
    assert.equal(result.evidence.catena_observation?.span_count, 5);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer catena-test-key");
    const spans = requests[0].body.resourceSpans[0].scopeSpans[0].spans;
    assert.deepEqual(spans.map((span: any) => span.name), [
      "barena.simulation",
      "barena.turn",
      "barena.turn",
      "barena.assertion",
      "barena.assertion",
    ]);
    const rootAttributes = otlpAttributes(spans[0].attributes);
    assert.equal(rootAttributes["input.value"], undefined);
    assert.equal(rootAttributes["barena.assertion.count"], "2");
    const traceId = Buffer.from(spans[0].traceId, "base64").toString("hex");
    for (let index = 0; index < adapter.turns.length; index += 1) {
      const turnSpanId = Buffer.from(spans[index + 1].spanId, "base64").toString("hex");
      assert.match(
        adapter.turns[index].telemetry?.traceparent ?? "",
        new RegExp(`^00-${traceId}-${turnSpanId}-01$`)
      );
    }
    const persisted = fs.readFileSync(
      path.join(temp, "runs", result.run_id, "reviewer", "simulation-scorecard.json"),
      "utf8"
    );
    assert.equal(persisted.includes("catena-test-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function simulationCase(): AgentSimulationCaseV1 {
  return {
    schema: "barena.agent_simulation_case.v1",
    case_id: "scenario-simulation-contract",
    source: {
      project: "langwatch/scenario",
      url: "https://github.com/langwatch/scenario",
      commit: "660433415b8bf2a6fbe9e4dba803cc8444e1072b",
      license: "Apache-2.0",
    },
    target: { adapter: "xiaobaos", model: "gpt-5.6-sol" },
    turns: [
      { user: "first scripted turn" },
      { user: "second scripted turn" },
    ],
    assertions: {
      final_response: {
        contains_all: ["first scripted turn", "second scripted turn"],
        excludes: ["forbidden"],
      },
    },
    timeout_ms: 2_000,
    isolation: {
      level: "policy_only",
      network: "disabled",
      writable_roots: ["workspace"],
    },
  };
}

function otlpAttributes(attributes: Array<{ key: string; value: Record<string, unknown> }>) {
  return Object.fromEntries(attributes.map(({ key, value }) => [
    key,
    String(value.stringValue ?? value.intValue ?? value.boolValue ?? ""),
  ]));
}
