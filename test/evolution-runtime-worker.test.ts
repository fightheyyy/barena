import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  executeEvolutionRuntimeRequest,
  XiaobaEvolutionRuntime,
  XIAOBA_EVOLUTION_ROLES,
  type XiaobaEvolutionRuntimeOptions,
} from "../src/evolution-runtime";
import { runEvolutionRuntimeWorker } from "../src/evolution-runtime-worker";
import { buildScenarioEvolutionRequest } from "../src/runner-service";
import {
  type AgentRuntimeAdapter,
  type AgentRuntimeSession,
  type OpenRuntimeSessionRequest,
  type RuntimeCapabilities,
  type RuntimeProbeRequest,
  type RuntimeProbeResult,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
} from "../src/runtime-adapters";
import { readNdjson } from "../src/utils/fs";

const FIXTURE_ROOT = path.resolve("test/fixtures/explore/xiaoba-project");
const FIXTURE_ROLES = path.join(FIXTURE_ROOT, "roles");
const FAKE_XIAOBA = path.resolve("test/fixtures/targets/fake-xiaoba-explore.mjs");

test("embedded XiaoBaOS probe requires all four evaluator/evolution roles and sanitizes host details", async () => {
  const adapter = new FakeAdapter();
  adapter.probeResult = {
    ...adapter.probeResult,
    detail: "ready at /private/secret/xiaoba",
    command: "/private/secret/xiaoba",
  };
  const runtime = new XiaobaEvolutionRuntime({ adapter });

  const manifest = await runtime.probe();

  assert.deepEqual(adapter.requiredTargets, XIAOBA_EVOLUTION_ROLES);
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.capabilities.target_runtime_hosted, false);
  assert.deepEqual(
    manifest.roles.map((role) => role.id),
    XIAOBA_EVOLUTION_ROLES
  );
  assert.doesNotMatch(JSON.stringify(manifest), /private\/secret/);
});

test("embedded Runtime executes an allowlisted role turn and always closes its XiaoBa session", async () => {
  const adapter = new FakeAdapter();
  const runtime = new XiaobaEvolutionRuntime({ adapter });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "barena-evolution-turn-"));
  try {
    const result = await runtime.runRoleTurn({
      request_id: "request-001",
      run_id: "run-001",
      role: "inspector-cat",
      prompt: "Inspect the retained trace and return one Finding plus Case.",
      workspace,
      timeout_ms: 5_000,
    });

    assert.equal(result.status, "completed");
    assert.equal(adapter.opened?.target.role, "inspector-cat");
    assert.equal(adapter.turn?.message.includes("Finding"), true);
    assert.equal(adapter.closed, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("embedded Runtime rejects functional roles before opening XiaoBaOS", async () => {
  const adapter = new FakeAdapter();
  const runtime = new XiaobaEvolutionRuntime({ adapter });

  await assert.rejects(
    runtime.runRoleTurn({
      request_id: "request-blocked",
      run_id: "run-blocked",
      role: "engineer-cat" as never,
      prompt: "Modify source code.",
      workspace: path.resolve(os.tmpdir(), "barena-blocked-role"),
      timeout_ms: 5_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("not allowed in the embedded evolution Runtime")
  );
  assert.equal(adapter.opened, undefined);
});

test("versioned worker protocol probes and turns without adding a second Agent abstraction", async () => {
  const adapter = new FakeAdapter();
  const createRuntime = (_options: XiaobaEvolutionRuntimeOptions) =>
    new XiaobaEvolutionRuntime({ adapter });
  const probe = await executeEvolutionRuntimeRequest(
    {
      schema: "barena.xiaoba_evolution_request.v1",
      request_id: "probe-001",
      operation: "probe",
    },
    { createRuntime }
  );
  assert.equal(probe.status, "ok");
  assert.equal(probe.operation, "probe");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "barena-evolution-protocol-"));
  try {
    const turn = await executeEvolutionRuntimeRequest(
      {
        schema: "barena.xiaoba_evolution_request.v1",
        request_id: "turn-001",
        operation: "turn",
        run_id: "run-001",
        role: "reviewer-cat",
        prompt: "Review verifier-backed evidence.",
        workspace,
        timeout_ms: 5_000,
      },
      { createRuntime }
    );
    assert.equal(turn.status, "ok");
    assert.equal(turn.operation, "turn");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const blocked = await executeEvolutionRuntimeRequest({
    schema: "barena.xiaoba_evolution_request.v1",
    request_id: "turn-blocked",
    operation: "turn",
    run_id: "run-001",
    role: "engineer-cat",
    prompt: "Write code.",
    workspace: path.resolve(os.tmpdir(), "barena-evolution-protocol-blocked"),
    timeout_ms: 5_000,
  });
  assert.equal(blocked.status, "error");
  assert.equal(blocked.operation, "unknown");
});

test("worker emits one bounded JSON error response for malformed input", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  stdin.end("{not-json");

  await runEvolutionRuntimeWorker({ stdin, stdout });

  const response = JSON.parse(output.trim()) as {
    schema: string;
    status: string;
    error: { code: string };
  };
  assert.equal(response.schema, "barena.xiaoba_evolution_response.v1");
  assert.equal(response.status, "error");
  assert.equal(response.error.code, "invalid_request");
});

test("Scenario evaluator request derives an isolated workspace and allows only Explore roles", () => {
  const root = path.resolve(os.tmpdir(), "spiral-scenario-evaluator-root");
  const request = buildScenarioEvolutionRequest(
    {
      schema: "barena.xiaoba_scenario_request.v1",
      request_id: "scenario-turn-001",
      project_id: "project/with/untrusted/path",
      scenario_id: "scenario-001",
      run_id: "run-001",
      thread_id: "thread-001",
      role: "user-cat",
      prompt: "Generate one natural user message.",
      timeout_ms: 5_000,
      telemetry: {
        traces_endpoint: "http://spiral-app:5560/api/otel/v1/traces",
        headers: { "x-auth-token": "project-key" },
      },
    },
    root
  );

  assert.equal(request.operation, "turn");
  assert.equal(request.role, "user-cat");
  assert.equal(request.workspace.startsWith(`${root}${path.sep}`), true);
  assert.doesNotMatch(request.workspace, /untrusted\/path/);
  assert.equal(request.telemetry?.headers?.["x-auth-token"], "project-key");
  assert.equal(
    request.telemetry?.resource_attributes?.["barena.scenario.id"],
    "scenario-001"
  );

  assert.throws(
    () =>
      buildScenarioEvolutionRequest(
        {
          schema: "barena.xiaoba_scenario_request.v1",
          request_id: "scenario-turn-blocked",
          project_id: "project-001",
          scenario_id: "scenario-001",
          run_id: "run-001",
          thread_id: "thread-001",
          role: "evolution-cat",
          prompt: "Write a candidate.",
          timeout_ms: 5_000,
        },
        root
      ),
    /role must be user-cat or reviewer-cat/
  );
});

test("real adapter boundary probes and runs EvolutionCat through ordinary chat only", { concurrency: false }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "barena-evolution-fake-cli-"));
  const logPath = path.join(workspace, "argv.ndjson");
  const previousLog = process.env.FAKE_XIAOBA_LOG;
  const previousBanner = process.env.FAKE_XIAOBA_ASCII_BANNER;
  process.env.FAKE_XIAOBA_LOG = logPath;
  process.env.FAKE_XIAOBA_ASCII_BANNER = "1";
  try {
    const runtime = new XiaobaEvolutionRuntime({
      runtime: {
        command: FAKE_XIAOBA,
        project_root: FIXTURE_ROOT,
        roles_root: FIXTURE_ROLES,
        env_allowlist: ["FAKE_XIAOBA_LOG", "FAKE_XIAOBA_ASCII_BANNER"],
      },
    });
    const manifest = await runtime.probe();
    assert.equal(manifest.status, "ready");

    const result = await runtime.runRoleTurn({
      request_id: "fixture-turn",
      run_id: "fixture-run",
      role: "evolution-cat",
      prompt: "Create one minimal Skill candidate.",
      workspace: path.join(workspace, "turn"),
      timeout_ms: 5_000,
    });
    assert.equal(result.status, "completed");
    assert.match(result.assistant?.content ?? "", /candidate_type/);
    assert.doesNotMatch(result.assistant?.content ?? "", /Meow Meow|▀██/);
    const calls = readNdjson<string[]>(logPath);
    assert.equal(
      calls.some((argv) => argv[0] === "chat" && argv.includes("evolution-cat")),
      true
    );
    assert.equal(calls.some((argv) => argv.includes("arena")), false);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_XIAOBA_LOG;
    else process.env.FAKE_XIAOBA_LOG = previousLog;
    if (previousBanner === undefined) delete process.env.FAKE_XIAOBA_ASCII_BANNER;
    else process.env.FAKE_XIAOBA_ASCII_BANNER = previousBanner;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = "xiaobaos";
  readonly capabilities: RuntimeCapabilities = {
    session_mode: "full-history-replay",
    output_protocol: "text",
    cancellation: true,
    telemetry: "native",
    trace_context_propagation: false,
    target_enumeration: true,
  };
  probeResult: RuntimeProbeResult = {
    runtime_id: "xiaobaos",
    status: "ready",
    detail: "ready",
    command: "xiaoba",
    version: "0.2.1",
    capabilities: this.capabilities,
    validated_targets: [...XIAOBA_EVOLUTION_ROLES],
  };
  requiredTargets: string[] = [];
  opened?: OpenRuntimeSessionRequest;
  turn?: RuntimeTurnInput;
  closed = 0;

  async probe(request: RuntimeProbeRequest = {}): Promise<RuntimeProbeResult> {
    this.requiredTargets = request.required_targets ?? [];
    return this.probeResult;
  }

  async openSession(request: OpenRuntimeSessionRequest): Promise<AgentRuntimeSession> {
    this.opened = request;
    return {
      runtime_id: this.id,
      session_id: request.session_id,
      thread_id: request.thread_id,
      workspace: request.workspace,
      target: request.target,
      session_mode: this.capabilities.session_mode,
      opened_at: new Date(0).toISOString(),
    };
  }

  async sendTurn(_session: AgentRuntimeSession, turn: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    this.turn = turn;
    return {
      status: "completed",
      detail: "fake turn completed",
      assistant: { role: "assistant", content: "fake result" },
      process: {
        exit_code: 0,
        signal: null,
        duration_ms: 1,
        stdout: "fake result",
        stderr: "",
      },
      telemetry: {
        mode: "native",
        configured: Boolean(turn.telemetry),
        trace_context_propagated: false,
      },
      native_trace_refs: [],
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
