import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentE2ECase } from "../src/e2e/case-runner";
import { runTargetObservationAttempts } from "../src/e2e/target-observation";
import {
  AgentE2ECaseV1,
  EvaluatorRunRequest,
  EvaluatorRunResult,
  EvaluatorRuntime,
  RuntimeProbeResult,
} from "../src/e2e/types";
import { XiaoBaEvaluatorRuntime } from "../src/evaluators/xiaoba-evaluator-runtime";
import { OpenClawTargetAdapter } from "../src/targets/openclaw-target-adapter";
import { readNdjson, writeJson } from "../src/utils/fs";

const fakeOpenClaw = path.resolve("test/fixtures/targets/fake-openclaw.mjs");
const fakeXiaoBaNoAgent = path.resolve("test/fixtures/evaluators/fake-xiaoba-no-agent.mjs");

test("OpenClaw adapter probes and executes a real child process with provenance-aware evidence", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-openclaw-adapter-"));
  const adapter = fakeOpenClawAdapter();
  const probe = await adapter.probe();
  assert.equal(probe.status, "ready");

  const prompt = "Line one\nquotes: \" ' ; $(touch nope) `touch nope2`\nLine three";
  const caseDefinition = makeCase(prompt, 1);
  const attempts = await runTargetObservationAttempts({
    caseDefinition,
    caseBaseDir: temp,
    runId: "run-test",
    runRoot: temp,
    targetAdapter: adapter,
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts.every((attempt) => attempt.status === "pass"), true);
  const invocations = attempts.map((attempt) =>
    JSON.parse(fs.readFileSync(path.join(attempt.workspace, "fake-openclaw-invocation.json"), "utf8")) as {
      args: string[];
      prompt: string;
      sessionKey: string;
    }
  );
  assert.equal(invocations.every((invocation) => invocation.prompt === prompt), true);
  assert.notEqual(invocations[0].sessionKey, invocations[1].sessionKey);
  assert.equal(invocations.every((invocation) => !invocation.args.includes("--deliver")), true);
  assert.equal(fs.existsSync(path.join(temp, "nope")), false);
  assert.equal(fs.existsSync(path.join(temp, "nope2")), false);

  const events = readNdjson<{ provenance: Record<string, string>; kind: string; data?: Record<string, unknown> }>(
    attempts[0].trace_ref
  );
  assert.equal(events.length > 0, true);
  assert.equal(events.every((event) => event.provenance.recorded_by === "barena"), true);
  assert.equal(events.every((event) => event.provenance.layer === "boundary"), true);
  assert.equal(events.some((event) => event.provenance.observed_from === "workspace" && event.kind === "artifact"), true);
  assert.equal(events.some((event) => event.kind === "tool_call"), false);
  assert.equal(attempts[0].target.native_trace_available, false);
});

test("OpenClaw adapter blocks invalid stdout and a missing binary without fabricating success", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-openclaw-blocked-"));
  const invalidAttempts = await runTargetObservationAttempts({
    caseDefinition: makeCase("FAKE_INVALID_JSON", 0),
    caseBaseDir: temp,
    runId: "run-invalid",
    runRoot: temp,
    targetAdapter: fakeOpenClawAdapter(),
  });
  assert.equal(invalidAttempts[0].status, "blocked");
  assert.equal(invalidAttempts[0].target.reason_code, "target_protocol_error");

  const missing = new OpenClawTargetAdapter({ command: path.join(temp, "missing-openclaw") });
  const probe = await missing.probe();
  assert.equal(probe.status, "blocked");
  assert.equal(probe.reason_code, "binary_not_found");
});

test("XiaoBa evaluator preflight rejects the current skill-role-only Arena contract", async () => {
  const runtime = new XiaoBaEvaluatorRuntime({ command: process.execPath, baseArgs: [fakeXiaoBaNoAgent] });
  const probe = await runtime.probe();

  assert.equal(probe.status, "blocked");
  assert.equal(probe.reason_code, "xiaoba_external_agent_mode_unavailable");
  assert.equal(probe.capabilities.includes("external_agent_mode"), false);
});

test("Agent E2E run fails closed before target execution when XiaoBa cannot drive external agents", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-e2e-fail-closed-"));
  const scorecard = await runAgentE2ECase(makeCase("should not run", 0), temp, {
    runsRoot: path.join(temp, "runs"),
    evaluator: new XiaoBaEvaluatorRuntime({ command: process.execPath, baseArgs: [fakeXiaoBaNoAgent] }),
    targetAdapter: fakeOpenClawAdapter(),
  });

  assert.equal(scorecard.status, "blocked");
  assert.equal(scorecard.decision, "held");
  assert.equal(scorecard.reason_code, "xiaoba_external_agent_mode_unavailable");
  assert.deepEqual(scorecard.attempts, []);
  assert.equal(scorecard.target.status, "not_started");
  assert.equal(scorecard.evidence_coverage.target_native_trace, false);
  assert.equal(scorecard.confidence, "none");
  const runRoot = path.join(temp, "runs", scorecard.run_id);
  assert.equal(fs.existsSync(path.join(runRoot, "reviewer", "scorecard.json")), true);
  assert.equal(fs.existsSync(path.join(runRoot, "workspace", "fake-openclaw-invocation.json")), false);
});

test("Agent E2E orchestration contract carries target replay, verification, and evidence coverage", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-e2e-contract-"));
  const scorecard = await runAgentE2ECase(makeCase("write the asserted artifact", 1), temp, {
    runsRoot: path.join(temp, "runs"),
    evaluator: new TestXiaoBaEvaluator(),
    targetAdapter: fakeOpenClawAdapter(),
  });

  assert.equal(scorecard.status, "pass");
  assert.equal(scorecard.decision, "cleared");
  assert.equal(scorecard.attempts.length, 2);
  assert.equal(scorecard.attempts.every((attempt) => attempt.status === "pass"), true);
  assert.deepEqual(scorecard.evaluator.stages, {
    usercat: "completed",
    inspectorcat: "completed",
    reviewercat: "completed",
  });
  assert.equal(scorecard.evidence_coverage.boundary_trace, true);
  assert.equal(scorecard.evidence_coverage.evaluator_traces, true);
  assert.equal(scorecard.evidence_coverage.target_native_trace, false);
  assert.equal(scorecard.confidence, "high");
});

function fakeOpenClawAdapter(): OpenClawTargetAdapter {
  return new OpenClawTargetAdapter({ command: process.execPath, baseArgs: [fakeOpenClaw] });
}

function makeCase(prompt: string, replays: number): AgentE2ECaseV1 {
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: "fake-openclaw-artifact",
    target: { adapter: "openclaw", agent: "main" },
    task: { prompt },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    replays,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  };
}

class TestXiaoBaEvaluator implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "xiaoba-evaluator",
      status: "ready",
      detail: "Test double for the XiaoBa external-agent contract.",
      command: "test-xiaoba",
      version: "test",
      capabilities: ["arena_execute", "external_agent_mode", "target_driver_manifest"],
    };
  }

  async runCase(request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    const evaluatorTraceRefs = ["usercat", "inspectorcat", "reviewercat"].map((role) => {
      const tracePath = path.join(request.run_root, "traces", "evaluators", `${role}.ndjson`);
      writeJson(tracePath, { runtime: "test-double", role });
      return tracePath;
    });
    const attempts = await runTargetObservationAttempts({
      caseDefinition: request.case_definition,
      caseBaseDir: request.case_base_dir,
      runId: request.run_id,
      runRoot: request.run_root,
      targetAdapter: request.target_adapter,
      skill: request.skill,
    });
    return {
      status: "completed",
      detail: "Test evaluator contract completed.",
      stages: { usercat: "completed", inspectorcat: "completed", reviewercat: "completed" },
      attempts,
      evaluator_trace_refs: evaluatorTraceRefs,
    };
  }
}
