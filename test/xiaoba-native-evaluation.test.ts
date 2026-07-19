import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeSkillRequest,
  loadXiaoBaNativeCase,
} from "../src/evaluation/xiaoba-native-input";
import { bindXiaoBaLivePolicy } from "../src/evaluation/live-policy";
import { NodeXiaoBaCommandRunner, runXiaoBaNativeEvaluation } from "../src/evaluation/xiaoba-native-runner";
import {
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaCommandRunner,
  XiaoBaLivePolicyV1,
} from "../src/evaluation/xiaoba-native-types";
import { loadEvaluationTrace } from "../src/tui/evaluation-tui";
import { hashDirectory } from "../src/utils/fs";

const fakeXiaoBa = path.resolve("test/fixtures/targets/fake-xiaoba-native.mjs");
const rolesRoot = path.resolve("test/fixtures/xiaoba-native/roles");
const skillPath = path.resolve("test/fixtures/xiaoba-native/skills/candidate-skill");
const skillCase = path.resolve("docs/cases/xiaoba-skill-artifact.json");
const roleCase = path.resolve("docs/cases/xiaoba-role-artifact.json");

test("XiaoBa native Skill evaluation proves stable lift, activation, isolation, and copied evidence", async () => {
  const fixture = makeFixture();
  const request = createXiaoBaNativeSkillRequest({
    roleId: "inherit-base-role",
    skillPath,
    casePaths: [skillCase],
    attemptsPerArm: 2,
    binaryPath: fakeXiaoBa,
    projectRoot: fixture.projectRoot,
    rolesRoot,
    passEnv: [],
  });
  const result = await runXiaoBaNativeEvaluation({ request, runs_root: fixture.runsRoot });

  assert.equal(result.probe.status, "ready");
  assert.equal(result.capability_kind, "skill");
  assert.equal(result.decision, "cleared");
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.effectiveness.observed_lift, 1);
  assert.deepEqual(result.baseline.counts, { planned: 2, pass: 0, fail: 2, blocked: 0, unsafe: 0 });
  assert.deepEqual(result.candidate.counts, { planned: 2, pass: 2, fail: 0, blocked: 0, unsafe: 0 });
  assert.equal(result.candidate.attempts.every((attempt) => attempt.activation.observed), true);
  assert.equal(result.baseline.attempts.every((attempt) => !attempt.activation.observed), true);
  assert.equal(result.quality.required_evidence_complete, true);
  assert.equal(result.admission?.decision, "pass");
  assert.equal(result.admission?.evidence_complete, true);
  assert.equal(result.admission?.evidence_refs.every((ref) => result.evidence_refs.includes(ref)), true);
  assert.equal(result.quality.evaluator_stages_are_independent_agent_sessions, false);
  assert.equal(result.quality.three_evaluator_agent_sessions, false);
  assert.equal(result.quality.isolation.evaluator_target_process_isolated, false);
  assert.equal(result.quality.isolation.network_disabled_is_hard_boundary, false);

  const attempts = [...result.baseline.attempts, ...result.candidate.attempts];
  assert.equal(new Set(attempts.map((attempt) => attempt.execution_root)).size, 4);
  assert.equal(new Set(attempts.map((attempt) => attempt.xiaoba_run_id)).size, 4);
  assert.equal(attempts.every((attempt) => !fs.existsSync(path.join(attempt.execution_root, "roles"))), true);
  assert.equal(attempts.every((attempt) => fs.lstatSync(path.join(attempt.execution_root, "dist")).isSymbolicLink()), true);
  assert.equal(attempts.every((attempt) => attempt.evidence.some((item) => item.layer === "native")), true);

  for (const evidence of attempts.flatMap((attempt) => attempt.evidence)) {
    assert.equal(fs.existsSync(evidence.copied_ref), true);
    const hash = fs.statSync(evidence.copied_ref).isDirectory()
      ? hashDirectory(evidence.copied_ref)
      : crypto.createHash("sha256").update(fs.readFileSync(evidence.copied_ref)).digest("hex");
    assert.equal(hash, evidence.sha256);
  }

  const trace = loadEvaluationTrace(result, path.dirname(result.request_ref));
  assert.equal(trace.some((event) => event.recorded_by === "barena" && event.layer === "boundary"), true);
  assert.equal(trace.some((event) => event.recorded_by === "xiaoba" && event.layer === "native"), true);
});

test("XiaoBa native Role evaluation compares an explicit baseline and candidate Role", async () => {
  const fixture = makeFixture();
  const request = createXiaoBaNativeRoleRequest({
    baselineRoleId: "inherit-base-role",
    candidateRoleId: "candidate-role",
    casePaths: [roleCase],
    attemptsPerArm: 2,
    binaryPath: fakeXiaoBa,
    projectRoot: fixture.projectRoot,
    rolesRoot,
    passEnv: [],
  });
  const result = await runXiaoBaNativeEvaluation({ request, runs_root: fixture.runsRoot });
  assert.equal(result.capability_kind, "role");
  assert.equal(result.baseline.selection.mode, "role");
  assert.equal(result.baseline.selection.role.role_id, "inherit-base-role");
  assert.equal(result.candidate.selection.mode, "role");
  assert.equal(result.candidate.selection.role.role_id, "candidate-role");
  assert.equal(result.decision, "cleared");
  assert.equal(result.effectiveness.observed_lift, 1);
});

test("XiaobaOS native runner continues to accept pinned 0.1.1 requests", async () => {
  const fixture = makeFixture();
  const legacyBinary = path.join(fixture.root, "fake-xiaoba-0.1.1.mjs");
  fs.writeFileSync(legacyBinary, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("0.1.1\\n");
  process.exit(0);
}
const result = spawnSync(process.execPath, [${JSON.stringify(fakeXiaoBa)}, ...args], {
  env: process.env,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
`, "utf8");
  fs.chmodSync(legacyBinary, 0o755);
  const request = skillRequest(fixture, "inherit-base-role");
  request.xiaoba.binary_path = legacyBinary;
  request.xiaoba.expected_version = "0.1.1";

  const result = await runXiaoBaNativeEvaluation({ request, runs_root: fixture.runsRoot });
  assert.equal(result.probe.status, "ready");
  assert.equal(result.probe.version, "0.1.1");
  assert.equal(result.probe.expected_version, "0.1.1");
  assert.equal(result.decision, "cleared");
});

test("XiaoBa native evaluation fails closed for missing binary, unsupported inheritance, collision, and native evidence gaps", async () => {
  const missing = makeFixture();
  const missingRequest = skillRequest(missing, "inherit-base-role");
  missingRequest.xiaoba.binary_path = path.join(missing.root, "not-installed");
  const missingResult = await runXiaoBaNativeEvaluation({ request: missingRequest, runs_root: missing.runsRoot });
  assert.equal(missingResult.decision, "held");
  assert.equal(missingResult.reason_code, "xiaoba_binary_not_found");
  assert.equal(missingResult.admission?.decision, "pass");
  assert.equal(missingResult.evidence_refs.length > 0, true);
  assert.equal(missingResult.evidence_refs.every((ref) => fs.existsSync(ref)), true);

  const inheritance = makeFixture();
  const inheritanceResult = await runXiaoBaNativeEvaluation({
    request: skillRequest(inheritance, "candidate-role"),
    runs_root: inheritance.runsRoot,
  });
  assert.equal(inheritanceResult.reason_code, "xiaoba_role_skill_inheritance_unsupported");

  const collision = makeFixture();
  const collisionResult = await runXiaoBaNativeEvaluation({
    request: skillRequest(collision, "collision-role"),
    runs_root: collision.runsRoot,
  });
  assert.equal(collisionResult.reason_code, "xiaoba_skill_name_collision");

  const traceGap = makeFixture();
  const traceRequest = skillRequest(traceGap, "inherit-base-role");
  traceRequest.cases[0].task.prompt = "FAKE_MISSING_TRACE";
  const traceResult = await runXiaoBaNativeEvaluation({ request: traceRequest, runs_root: traceGap.runsRoot });
  assert.equal(traceResult.decision, "held");
  assert.equal(traceResult.reason_code, "xiaoba_native_trace_missing");
  assert.equal(traceResult.quality.required_evidence_complete, false);
  assert.equal(
    traceResult.evidence_refs.length,
    2 + (traceResult.admission?.evidence_refs.length ?? 0)
  );
  assert.equal([...traceResult.baseline.attempts, ...traceResult.candidate.attempts]
    .every((attempt) => attempt.evidence.some((item) => item.layer === "boundary")), true);

  const sandboxGap = makeFixture();
  const sandboxRequest = skillRequest(sandboxGap, "inherit-base-role");
  sandboxRequest.cases[0].task.prompt = "FAKE_SANDBOX_NOT_ENFORCED";
  const sandboxResult = await runXiaoBaNativeEvaluation({ request: sandboxRequest, runs_root: sandboxGap.runsRoot });
  assert.equal(sandboxResult.decision, "held");
  assert.equal(sandboxResult.reason_code, "xiaoba_sandbox_unavailable");

  const stale = makeFixture();
  const staleRequest = skillRequest(stale, "inherit-base-role");
  staleRequest.cases[0].task.prompt = "FAKE_STALE_RUN";
  const staleResult = await runXiaoBaNativeEvaluation({ request: staleRequest, runs_root: stale.runsRoot });
  assert.equal(staleResult.decision, "held");
  assert.equal(staleResult.reason_code, "xiaoba_scorecard_invalid");
});

test("XiaoBa native aggregation rejects unsafe candidates and holds no-effect pairs", async () => {
  const unsafe = makeFixture();
  const unsafeRequest = skillRequest(unsafe, "inherit-base-role");
  unsafeRequest.cases[0].task.prompt = "FAKE_UNSAFE\nFAKE_REQUIRE_SKILL";
  const unsafeResult = await runXiaoBaNativeEvaluation({ request: unsafeRequest, runs_root: unsafe.runsRoot });
  assert.equal(unsafeResult.decision, "rejected");
  assert.equal(unsafeResult.reason_code, "unsafe_candidate");

  const noEffect = makeFixture();
  const noEffectRequest = skillRequest(noEffect, "inherit-base-role");
  noEffectRequest.cases[0].task.prompt = "Create result.txt with BARENA_XIAOBA_OK without requiring a Skill.";
  const noEffectResult = await runXiaoBaNativeEvaluation({ request: noEffectRequest, runs_root: noEffect.runsRoot });
  assert.equal(noEffectResult.effectiveness.observed_lift, 0);
  assert.equal(noEffectResult.decision, "held");
  assert.equal(noEffectResult.reason_code, "no_effect");
});

test("live hard-limit preflight stops before an injected XiaoBa command runner", async () => {
  const fixture = makeFixture();
  const request = skillRequest(fixture, "inherit-base-role");
  const calls: unknown[] = [];
  const commandRunner: XiaoBaCommandRunner = {
    async run(command) {
      calls.push(command);
      throw new Error("command runner must not execute before live preflight passes");
    },
  };
  const policy = livePolicy();
  policy.hard_limit.verified = false;

  const result = await runXiaoBaNativeEvaluation({
    request,
    runs_root: fixture.runsRoot,
    live_policy_binding: bindXiaoBaLivePolicy(policy),
  }, {
    command_runner: commandRunner,
    environment: {
      PATH: process.env.PATH,
      FAKE_PROVIDER_KEY: "injected-key",
      FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(result.decision, "held");
  assert.equal(result.reason_code, "live_hard_limit_unverified");
  assert.equal(result.live?.ready_to_invoke, false);
});

test("XiaoBa native cases reject empty, duplicate, and vacuous artifact assertions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-native-case-validation-"));
  const casePath = path.join(root, "case.json");
  const base = {
    schema: "barena.xiaoba_native_case.v1",
    case_id: "validation-case",
    purpose: "effectiveness",
    task: { prompt: "validate assertions" },
  };
  for (const artifacts of [
    [],
    [{ path: "result.txt", contains: "" }],
    [{ path: "result.txt" }, { path: "result.txt", contains: "duplicate" }],
    [{ path: "result.txt", exists: false, contains: "contradiction" }],
  ]) {
    fs.writeFileSync(casePath, JSON.stringify({ ...base, assertions: { artifacts } }), "utf8");
    assert.throws(() => loadXiaoBaNativeCase(casePath));
  }
});

test("policy-free native execution strips provider credentials and selectors", async () => {
  const fixture = makeFixture();
  const request = skillRequest(fixture, "inherit-base-role");
  request.xiaoba.pass_env = ["FAKE_PROVIDER_KEY", "FAKE_PROVIDER_BASE", "XIAOBA_LLM_PROVIDER", "SAFE_TEST_VALUE"];
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const delegate = new NodeXiaoBaCommandRunner();
  const commandRunner: XiaoBaCommandRunner = {
    async run(command) {
      calls.push({ args: command.args, env: command.env });
      return delegate.run(command);
    },
  };

  await runXiaoBaNativeEvaluation({ request, runs_root: fixture.runsRoot }, {
    command_runner: commandRunner,
    environment: {
      PATH: process.env.PATH,
      FAKE_PROVIDER_KEY: "must-not-propagate",
      FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
      XIAOBA_LLM_PROVIDER: "must-not-propagate",
      SAFE_TEST_VALUE: "safe-fixture-value",
    },
  });

  assert.equal(calls.length > 0, true);
  assert.equal(calls.every((call) => call.env.FAKE_PROVIDER_KEY === undefined), true);
  assert.equal(calls.every((call) => call.env.FAKE_PROVIDER_BASE === undefined), true);
  assert.equal(calls.every((call) => call.env.XIAOBA_LLM_PROVIDER === undefined), true);
  const execute = calls.find((call) =>
    call.args[0] === "arena" && call.args[1] === "run" && call.args[2] === "execute" && !call.args.includes("--help")
  );
  assert.equal(execute?.env.SAFE_TEST_VALUE, "safe-fixture-value");
});

function skillRequest(
  fixture: ReturnType<typeof makeFixture>,
  roleId: string
): XiaoBaCapabilityEvaluationRequestV1 {
  return createXiaoBaNativeSkillRequest({
    roleId,
    skillPath,
    casePaths: [skillCase],
    attemptsPerArm: 1,
    binaryPath: fakeXiaoBa,
    projectRoot: fixture.projectRoot,
    rolesRoot,
    passEnv: [],
  });
}

function makeFixture(): { root: string; projectRoot: string; runsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-xiaoba-native-test-"));
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
  return { root, projectRoot, runsRoot: path.join(root, "runs") };
}

function livePolicy(): XiaoBaLivePolicyV1 {
  const verifiedAt = new Date().toISOString();
  return {
    schema: "barena.live_policy.v1",
    provider: "fixture-provider",
    model: "fixture-model",
    credential_env: "FAKE_PROVIDER_KEY",
    api_base_env: "FAKE_PROVIDER_BASE",
    max_input_tokens: 1_000,
    max_output_tokens: 100,
    max_provider_calls: 10,
    pricing: {
      provider: "fixture-provider",
      model: "fixture-model",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      input_usd_per_million_tokens: 1,
      output_usd_per_million_tokens: 2,
      source: "fixture-price-card",
      sourced_at: verifiedAt,
    },
    budget_usd: 5,
    worst_case_usd: 0.02,
    hard_limit: {
      mode: "prepaid_balance",
      verified: true,
      reference: "fixture-hard-limit",
      verified_at: verifiedAt,
      provider: "fixture-provider",
      credential_env: "FAKE_PROVIDER_KEY",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      cap_usd: 5,
    },
    accepted_scan_finding_ids: [],
    retention: { profile: "private-beta-test" },
    redaction: { profile: "exact-secret-and-structured-fields", secret_env_names: [] },
  };
}
