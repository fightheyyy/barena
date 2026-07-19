import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { runTargetObservationAttempts } from "../src/e2e/target-observation";
import type {
  EvaluatorRunRequest,
  EvaluatorRunResult,
  EvaluatorRuntime,
  RuntimeProbeResult,
} from "../src/e2e/types";
import { runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { OpenClawTargetAdapter } from "../src/targets/openclaw-target-adapter";

interface PackageJson {
  name: string;
  version: string;
  bin: string | Record<string, string>;
}

interface CliResult extends SpawnSyncReturns<string> {
  status: number | null;
}

interface InvocationRecord {
  args: string[];
  env?: {
    provider?: string;
    model?: string;
    max_tokens?: string;
    credential_present?: boolean;
    api_base_present?: boolean;
  };
}

interface NativeFixture {
  root: string;
  projectRoot: string;
  rolesRoot: string;
  runsRoot: string;
  casePath: string;
  skillPath: string;
  policyPath: string;
  wrapperPath: string;
  invocationLog: string;
}

type JsonRecord = Record<string, unknown>;

const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const fakeXiaoBa = path.join(repoRoot, "test", "fixtures", "targets", "fake-xiaoba-native.mjs");
const fakeOpenClaw = path.join(repoRoot, "test", "fixtures", "targets", "fake-openclaw.mjs");
const fixtureRolesRoot = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "roles");
const fixtureSkillPath = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "skills", "candidate-skill");
const fixtureCasePath = path.join(repoRoot, "docs", "cases", "xiaoba-skill-artifact.json");

test("private-beta contract suite runs from an isolated Git checkout", () => {
  const gitRoot = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  assert.equal(
    gitRoot.status,
    0,
    "contract test must run from an isolated Git checkout, not the protected non-Git source tree"
  );
  assert.equal(
    path.resolve(gitRoot.stdout.trim()),
    repoRoot,
    "contract test repository root must be the active Git top level"
  );
});

test("CLI maps cleared, held, rejected, and operational outcomes to exit codes 0, 1, 2, and 3", async (t) => {
  await t.test("cleared is exit 0", () => {
    const result = importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "good-skill"));
    assert.equal(result.payload.decision, "cleared");
    assert.equal(result.cli.status, 0, result.cli.stderr);
  });

  await t.test("held is exit 1 after JSON output", () => {
    const result = importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "no-artifact-skill"));
    assert.equal(result.payload.decision, "held");
    assert.equal(result.cli.status, 1, result.cli.stderr);
  });

  await t.test("rejected is exit 2 after JSON output", () => {
    const result = importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "unsafe-skill"));
    assert.equal(result.payload.decision, "rejected");
    assert.equal(result.cli.status, 2, result.cli.stderr);
  });

  await t.test("usage or command errors are exit 3", () => {
    const root = tempRoot("barena-cli-error-");
    const result = runPackageCli(["not-a-command"], root);
    assert.equal(result.status, 3, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
});

test("requiring the package root is silent and does not initialize a CLI, TUI, or filesystem state", () => {
  const cwd = tempRoot("barena-root-import-");
  const beforeTree = snapshotTree(cwd);
  const probe = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(repoRoot)})`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, "");
  assert.equal(probe.stderr, "");
  assert.deepEqual(snapshotTree(cwd), beforeTree);
});

test("the package CLI resolves Barena's own version from a non-project CWD", () => {
  const cwd = tempRoot("barena-version-cwd-");
  writeJson(path.join(cwd, "package.json"), { name: "cwd-decoy", version: "9.9.9" });
  const result = runPackageCli(["--version"], cwd);
  const packageJson = readJson<PackageJson>(packageJsonPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("XiaobaOS public target and flags preserve xiaoba compatibility and reject conflicts", () => {
  const canonical = runPackageCli([
    "e2e", "probe",
    "--target", "xiaobaos",
    "--xiaobaos-command", fakeXiaoBa,
    "--xiaobaos-project-root", repoRoot,
  ], repoRoot);
  const legacy = runPackageCli([
    "e2e", "probe",
    "--target", "xiaoba",
    "--xiaoba-command", fakeXiaoBa,
    "--xiaoba-project-root", repoRoot,
  ], repoRoot);
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(legacy.status, 0, legacy.stderr);
  const canonicalProbe = parseJson<JsonRecord>(canonical.stdout);
  const legacyProbe = parseJson<JsonRecord>(legacy.stdout);
  for (const field of ["status", "binary_path", "project_root", "version", "expected_version"]) {
    assert.deepEqual(canonicalProbe[field], legacyProbe[field]);
  }
  assert.equal(canonicalProbe.version, "0.2.0");

  const conflict = runPackageCli([
    "e2e", "probe",
    "--target", "xiaobaos",
    "--xiaobaos-command", fakeXiaoBa,
    "--xiaoba-command", path.join(repoRoot, "missing-xiaoba"),
    "--xiaobaos-project-root", repoRoot,
  ], repoRoot);
  assert.equal(conflict.status, 3);
  assert.match(conflict.stderr, /must not conflict/);
});

test("run catalog classifies legacy clearance, agent E2E, skill evaluation, native capability, and partial legacy without directory-name heuristics", () => {
  const root = tempRoot("barena-run-catalog-");
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  writeJson(path.join(runsRoot, "alpha", "reviewer", "scorecard.json"), legacyScorecard("alpha"));
  writeJson(path.join(runsRoot, "bravo", "reviewer", "scorecard.json"), agentScorecard("bravo"));
  writeJson(path.join(runsRoot, "charlie", "skill-evaluation.json"), skillEvaluation("charlie"));
  writeJson(path.join(runsRoot, "delta", "capability-evaluation.json"), nativeEvaluation("delta"));
  writeJson(path.join(runsRoot, "echo", "reviewer", "scorecard.json"), {
    scorecard_type: "barena.skill_clearance.v0",
    run_id: "echo",
    decision: "held",
  });

  const result = runPackageCli(["list", "runs", "--runs-root", runsRoot], root);
  assert.equal(result.status, 0, result.stderr);
  const summaries = parseJson<Array<Record<string, unknown>>>(result.stdout);
  const observed = Object.fromEntries(summaries.map((summary) => [String(summary.run_id), {
    kind: summary.kind,
    schema: summary.schema,
    health: summary.health,
  }]));

  assert.deepEqual(observed, {
    alpha: { kind: "legacy_clearance", schema: "barena.skill_clearance.v0", health: "healthy" },
    bravo: { kind: "agent_e2e", schema: "barena.agent_e2e.v1", health: "healthy" },
    charlie: { kind: "skill_evaluation", schema: "barena.skill_evaluation.v1", health: "healthy" },
    delta: { kind: "xiaoba_capability", schema: "barena.xiaoba_capability_evaluation_result.v1", health: "healthy" },
    echo: { kind: "legacy_clearance", schema: "barena.skill_clearance.v0", health: "partial" },
  });
  const partial = summaries.find((summary) => summary.run_id === "echo");
  assert.equal(Array.isArray(partial?.warnings), true);
  assert.equal((partial?.warnings as unknown[]).length > 0, true);
});

test("run catalog contains malformed and unknown schemas instead of crashing or trusting them", () => {
  const root = tempRoot("barena-run-catalog-invalid-");
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(runsRoot, "malformed", "reviewer"), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, "malformed", "reviewer", "scorecard.json"), "{not-json\n", "utf8");
  writeJson(path.join(runsRoot, "unknown", "reviewer", "scorecard.json"), {
    schema: "barena.future_result.v99",
    run_id: "unknown",
    decision: "cleared",
  });

  const result = runPackageCli(["list", "runs", "--runs-root", runsRoot], root);
  assert.equal(result.status, 0, result.stderr);
  const summaries = parseJson<Array<Record<string, unknown>>>(result.stdout);
  const byId = new Map(summaries.map((summary) => [summary.run_id, summary]));

  assert.equal(byId.get("malformed")?.kind, "unknown");
  assert.equal(byId.get("malformed")?.health, "malformed");
  assert.equal(byId.get("unknown")?.kind, "unknown");
  assert.equal(byId.get("unknown")?.health, "unknown_schema");
  assert.equal(byId.get("unknown")?.decision, "unknown");
});

test("show reads each recognized run kind and tolerates partial legacy data", async (t) => {
  const root = tempRoot("barena-run-show-");
  const runsRoot = path.join(root, "runs");
  writeJson(path.join(runsRoot, "legacy", "reviewer", "scorecard.json"), legacyScorecard("legacy"));
  writeJson(path.join(runsRoot, "agent", "reviewer", "scorecard.json"), agentScorecard("agent"));
  writeJson(path.join(runsRoot, "skill", "skill-evaluation.json"), skillEvaluation("skill"));
  writeJson(path.join(runsRoot, "native", "capability-evaluation.json"), nativeEvaluation("native"));
  writeJson(path.join(runsRoot, "partial", "reviewer", "scorecard.json"), {
    scorecard_type: "barena.skill_clearance.v0",
    run_id: "partial",
  });

  for (const runId of ["legacy", "agent", "skill", "native", "partial"]) {
    await t.test(runId, () => {
      const result = runPackageCli(["show", runId, "--runs-root", runsRoot], root);
      assert.equal(result.status, 0, `run=${runId}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      const shown = parseJson<Record<string, unknown>>(result.stdout);
      assert.equal(shown.run_id ?? shown.evaluation_id, runId);
    });
  }
});

test("run readers reject traversal, absolute paths, and symlink escapes without disclosing outside evidence", async (t) => {
  const root = tempRoot("barena-run-path-safety-");
  const runsRoot = path.join(root, "runs");
  const outsideRoot = path.join(root, "outside-run");
  const sentinel = "OUTSIDE_RUN_SECRET_7cf8d29c";
  writeJson(path.join(outsideRoot, "reviewer", "scorecard.json"), {
    ...legacyScorecard("outside-run"),
    summary: sentinel,
  });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.symlinkSync(outsideRoot, path.join(runsRoot, "linked-run"), "dir");

  const cases: Array<{ name: string; runId: string }> = [
    { name: "traversal", runId: "../outside-run" },
    { name: "absolute", runId: outsideRoot },
    { name: "symlink", runId: "linked-run" },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const result = runPackageCli(["scorecard", item.runId, "--runs-root", runsRoot], root);
      assert.equal(result.status, 3, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(result.stdout.includes(sentinel), false);
      assert.equal(result.stderr.includes(sentinel), false);
    });
  }
});

test("paired static admission rejects an unsafe candidate before any XiaoBa command", () => {
  const fixture = makeNativeFixture({
    skillPath: path.join(repoRoot, "test", "fixtures", "skills", "unsafe-skill"),
    wrapperMode: "fail",
  });
  const result = runNativeEvaluationCli(fixture);

  assert.deepEqual(readInvocations(fixture.invocationLog), []);
  assert.equal(result.status, 2, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "rejected");
});

test("paired static admission holds a blocking candidate before any XiaoBa command", () => {
  const root = tempRoot("barena-blocking-candidate-");
  const skillPath = path.join(root, "skill");
  fs.cpSync(fixtureSkillPath, skillPath, { recursive: true });
  fs.appendFileSync(path.join(skillPath, "SKILL.md"), "\nsend_text(\"external side effect\")\n", "utf8");
  const fixture = makeNativeFixture({ skillPath, wrapperMode: "fail" });
  const result = runNativeEvaluationCli(fixture);

  assert.deepEqual(readInvocations(fixture.invocationLog), []);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "held");
});

test("paired static admission holds an unsafe common Role without attributing it to the candidate", () => {
  const root = tempRoot("barena-common-unsafe-role-");
  const rolesRoot = path.join(root, "roles");
  fs.cpSync(fixtureRolesRoot, rolesRoot, { recursive: true });
  fs.appendFileSync(
    path.join(rolesRoot, "inherit-base-role", "prompts", "fixture-system-prompt.md"),
    "\nBARENA_UNSAFE\n",
    "utf8"
  );
  const fixture = makeNativeFixture({ rolesRoot, wrapperMode: "fail" });
  const result = runNativeEvaluationCli(fixture);

  assert.deepEqual(readInvocations(fixture.invocationLog), []);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "held");
});

test("review-required admission needs explicit accepted finding IDs before XiaoBa commands", () => {
  const root = tempRoot("barena-review-required-skill-");
  const skillPath = path.join(root, "skill");
  fs.cpSync(fixtureSkillPath, skillPath, { recursive: true });
  fs.appendFileSync(path.join(skillPath, "SKILL.md"), "\nTOKEN\n", "utf8");
  const fixture = makeNativeFixture({ skillPath, wrapperMode: "fail" });
  const result = runNativeEvaluationCli(fixture);

  assert.deepEqual(readInvocations(fixture.invocationLog), []);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "held");
});

test("the OpenClaw paired path shares static admission and never executes an unsafe candidate", async () => {
  const root = tempRoot("barena-openclaw-static-admission-");
  const runsRoot = path.join(root, "runs");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "unsafe-openclaw-candidate",
    target: { adapter: "openclaw", agent: "main" },
    task: { prompt: "FAKE_REQUIRE_SKILL" },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });

  const result = await runSkillEvaluation({
    skillPath: path.join(repoRoot, "test", "fixtures", "skills", "unsafe-skill"),
    cases: [casePath],
    attemptsPerArm: 1,
    runsRoot,
    evaluator: new FixtureExternalEvaluator(),
    targetAdapter: new OpenClawTargetAdapter({ command: process.execPath, baseArgs: [fakeOpenClaw] }),
  });

  assert.deepEqual(findFiles(runsRoot, "fake-openclaw-invocation.json"), []);
  assert.equal(result.decision, "rejected");
});

test("live policy rejects missing provider, model, and usage limits before XiaoBa commands", async (t) => {
  const invalidPolicies: Array<{ name: string; mutate: (policy: JsonRecord) => void }> = [
    { name: "provider", mutate: (policy) => { delete policy.provider; } },
    { name: "model", mutate: (policy) => { delete policy.model; } },
    {
      name: "usage limits",
      mutate: (policy) => {
        delete policy.max_input_tokens;
        delete policy.max_output_tokens;
        delete policy.max_provider_calls;
      },
    },
  ];

  for (const item of invalidPolicies) {
    await t.test(item.name, () => {
      const fixture = makeNativeFixture({ wrapperMode: "fail" });
      const policy = validLivePolicy();
      item.mutate(policy);
      writeJson(fixture.policyPath, policy);
      const result = runNativeEvaluationCli(fixture);

      assert.deepEqual(readInvocations(fixture.invocationLog), []);
      assert.equal(result.status, 3, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    });
  }
});

test("live policy rejects missing pricing, hard-limit metadata, and budget fields before XiaoBa commands", async (t) => {
  const invalidPolicies: Array<{ name: string; mutate: (policy: JsonRecord) => void }> = [
    { name: "pricing", mutate: (policy) => { delete policy.pricing; } },
    { name: "hard-limit metadata", mutate: (policy) => { delete policy.hard_limit; } },
    {
      name: "budget fields",
      mutate: (policy) => {
        delete policy.budget_usd;
        delete policy.worst_case_usd;
      },
    },
  ];

  for (const item of invalidPolicies) {
    await t.test(item.name, () => {
      const fixture = makeNativeFixture({ wrapperMode: "fail" });
      const policy = validLivePolicy();
      item.mutate(policy);
      writeJson(fixture.policyPath, policy);
      const result = runNativeEvaluationCli(fixture);

      assert.deepEqual(readInvocations(fixture.invocationLog), []);
      assert.equal(result.status, 3, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    });
  }
});

test("live policy holds unverified or over-budget runs before XiaoBa commands", async (t) => {
  const blockedPolicies: Array<{ name: string; mutate: (policy: JsonRecord) => void }> = [
    {
      name: "hard limit is not verified",
      mutate: (policy) => {
        policy.hard_limit = { ...(policy.hard_limit as JsonRecord), verified: false };
      },
    },
    {
      name: "worst case exceeds the five dollar budget",
      mutate: (policy) => {
        policy.budget_usd = 5;
        policy.worst_case_usd = 5.01;
      },
    },
  ];

  for (const item of blockedPolicies) {
    await t.test(item.name, () => {
      const fixture = makeNativeFixture({ wrapperMode: "fail" });
      const policy = validLivePolicy();
      item.mutate(policy);
      writeJson(fixture.policyPath, policy);
      const result = runNativeEvaluationCli(fixture);

      assert.deepEqual(readInvocations(fixture.invocationLog), []);
      assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    });
  }
});

test("stock XiaoBa without a LiveSafety runtime contract is held before paid execution", () => {
  const fixture = makeNativeFixture({ wrapperMode: "fail" });
  const result = runNativeEvaluationCli(fixture);
  const invocations = readInvocations(fixture.invocationLog);

  assert.equal(invocations.some((item) => isArenaExecution(item.args)), false);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.reason_code, "live_runtime_contract_unsupported");
  assert.equal((payload.live as JsonRecord).ready_to_invoke, false);
  assert.equal((payload.live as JsonRecord).model_invoked, false);
});

test("--preflight-only proves readiness without starting either paid arm", () => {
  const fixture = makeNativeFixture({ wrapperMode: "delegate" });
  const result = runNativeEvaluationCli(fixture, {}, ["--preflight-only"]);
  const invocations = readInvocations(fixture.invocationLog);

  assert.equal(invocations.some((item) => isArenaExecution(item.args)), false);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.reason_code, "live_preflight_only");
  assert.equal((payload.live as JsonRecord).ready_to_invoke, true);
  assert.equal((payload.live as JsonRecord).preflight_only, true);
  assert.equal((payload.provider_identity as JsonRecord).status, "configured");
});

test("one-attempt smoke preflight rejects extra turns before paid execution", () => {
  const fixture = makeNativeFixture({ wrapperMode: "delegate" });
  const caseDefinition = readJson<JsonRecord>(fixture.casePath);
  caseDefinition.max_turns = 2;
  writeJson(fixture.casePath, caseDefinition);
  const result = runNativeEvaluationCli(fixture);

  assert.equal(readInvocations(fixture.invocationLog).some((item) => isArenaExecution(item.args)), false);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(parseJson<Record<string, unknown>>(result.stdout).reason_code, "live_smoke_configuration_invalid");
});

test("retained evidence redacts an injected secret and records a redaction manifest", () => {
  const secret = "barena-test-secret-4a91c0d7";
  const fixture = makeNativeFixture({
    wrapperMode: "delegate",
    prompt: `FAKE_REQUIRE_SKILL\nCreate result.txt. Test credential: ${secret}`,
  });
  const policy = validLivePolicy();
  policy.redaction = {
    profile: "exact-secret-and-structured-fields",
    secret_env_names: ["BARENA_TEST_SECRET"],
  };
  writeJson(fixture.policyPath, policy);
  runNativeEvaluationCli(fixture, { BARENA_TEST_SECRET: secret });

  assert.deepEqual(filesContaining(fixture.runsRoot, secret), []);
  const manifests = findFiles(fixture.runsRoot, "redaction-manifest.json");
  assert.equal(manifests.length > 0, true);
  const manifest = readJson<{ entries: Array<Record<string, unknown>>; retained_secret_scan: { status: string } }>(manifests[0]);
  assert.equal(manifest.retained_secret_scan.status, "pass");
  assert.equal(manifest.entries.some((entry) => Number(entry.replacement_count) > 0), true);
  assert.equal(manifest.entries.every((entry) => typeof entry.source_sha256 === "string"), true);
  assert.equal(manifest.entries.every((entry) => typeof entry.sanitized_sha256 === "string"), true);
});

test("baseline usage incompleteness fails fast before the candidate arm", () => {
  const fixture = makeNativeFixture({
    wrapperMode: "missing-baseline-usage",
    prompt: "FAKE_REQUIRE_SKILL\nFAKE_BASELINE_USAGE_MISSING\nCreate result.txt.",
  });
  const result = runNativeEvaluationCli(fixture);
  const execution = readInvocations(fixture.invocationLog).filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 0);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.reason_code, "baseline_usage_incomplete");
});

test("live baseline stops after the first failed paid attempt", () => {
  const fixture = makeNativeFixture({
    wrapperMode: "missing-baseline-usage",
    prompt: "FAKE_REQUIRE_SKILL\nCreate result.txt.",
  });
  const policy = validLivePolicy();
  policy.max_provider_calls = 20;
  policy.worst_case_usd = 0.03;
  writeJson(fixture.policyPath, policy);
  const result = runNativeEvaluationCli(fixture, {}, ["--attempts", "2"]);
  const execution = readInvocations(fixture.invocationLog).filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 0);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(parseJson<Record<string, unknown>>(result.stdout).reason_code, "baseline_usage_incomplete");
});

test("identity, retry, and evaluator-telemetry failures stop before the next paid attempt", async (t) => {
  const cases: Array<{
    mode: "identity-mismatch" | "retries" | "missing-evaluator-telemetry" | "post-call-failure";
    reason: string;
  }> = [
    { mode: "identity-mismatch", reason: "provider_identity_mismatch" },
    { mode: "retries", reason: "live_retry_control_unverified" },
    { mode: "missing-evaluator-telemetry", reason: "baseline_usage_incomplete" },
  ];
  for (const item of cases) {
    await t.test(item.mode, () => {
      const fixture = makeNativeFixture({ wrapperMode: item.mode });
      const policy = validLivePolicy();
      policy.max_provider_calls = 20;
      policy.worst_case_usd = 0.03;
      writeJson(fixture.policyPath, policy);
      const result = runNativeEvaluationCli(fixture, {}, ["--attempts", "2"]);
      const execution = readInvocations(fixture.invocationLog).filter((invocation) => isArenaExecution(invocation.args));

      assert.equal(execution.filter((invocation) => flagValue(invocation.args, "mode") === "role").length, 1);
      assert.equal(execution.filter((invocation) => flagValue(invocation.args, "mode") === "role_skill").length, 0);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(parseJson<Record<string, unknown>>(result.stdout).reason_code, item.reason);
    });
  }
});

test("post-call command failure preserves known spend and stops the run", () => {
  const fixture = makeNativeFixture({ wrapperMode: "post-call-failure" });
  const result = runNativeEvaluationCli(fixture);
  const execution = readInvocations(fixture.invocationLog).filter((invocation) => isArenaExecution(invocation.args));

  assert.equal(execution.length, 1);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.reason_code, "xiaoba_runner_failed");
  assert.equal((payload.live as JsonRecord).model_invoked, true);
  assert.equal((payload.usage as JsonRecord).provider_calls, 3);
  assert.equal(Number((payload.usage as JsonRecord).estimated_cost_usd) > 0, true);
});

test("an unsafe live baseline holds before the candidate arm", () => {
  const fixture = makeNativeFixture({
    wrapperMode: "delegate",
    prompt: "FAKE_UNSAFE\nFAKE_REQUIRE_SKILL\nCreate result.txt.",
  });
  const result = runNativeEvaluationCli(fixture);
  const execution = readInvocations(fixture.invocationLog).filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 0);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "held");
  assert.equal(payload.reason_code, "xiaoba_arena_unsafe");
  assert.equal((payload.usage as JsonRecord).provider_calls, 3);
  assert.equal(Number((payload.usage as JsonRecord).estimated_cost_usd) > 0, true);
  assert.equal((payload.usage as JsonRecord).baseline_complete, true);
  assert.equal((payload.usage as JsonRecord).candidate_complete, false);
  assert.equal(Number((payload.budget as JsonRecord).remaining_budget_usd) < 5, true);
});

test("baseline token overrun holds before the candidate arm", () => {
  const fixture = makeNativeFixture({ wrapperMode: "baseline-over-limit" });
  const result = runNativeEvaluationCli(fixture);
  const execution = readInvocations(fixture.invocationLog).filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 0);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(parseJson<Record<string, unknown>>(result.stdout).reason_code, "usage_limit_exceeded");
});

test("live unsafe candidate remains rejected instead of becoming an insufficient-replay hold", () => {
  const fixture = makeNativeFixture({ wrapperMode: "candidate-unsafe" });
  const result = runNativeEvaluationCli(fixture);
  const execution = readInvocations(fixture.invocationLog).filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 1);
  assert.equal(result.status, 2, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "rejected");
  assert.equal(payload.reason_code, "unsafe_candidate");
});

test("a one-attempt-per-arm live smoke accounts for physical calls and never retries", () => {
  const fixture = makeNativeFixture({ wrapperMode: "delegate" });
  const result = runNativeEvaluationCli(fixture);
  const invocations = readInvocations(fixture.invocationLog);
  const execution = invocations.filter((item) => isArenaExecution(item.args));

  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role").length, 1);
  assert.equal(execution.filter((item) => flagValue(item.args, "mode") === "role_skill").length, 1);
  const nonPaid = invocations.filter((item) => !isArenaExecution(item.args));
  assert.equal(nonPaid.length > 0, true);
  assert.equal(nonPaid.every((item) => item.env?.credential_present === false), true);
  assert.equal(nonPaid.every((item) => item.env?.api_base_present === false), true);
  assert.equal(nonPaid.every((item) => item.env?.provider === undefined && item.env?.model === undefined), true);
  assert.equal(execution.every((item) => item.env?.credential_present === true && item.env?.api_base_present === true), true);
  assert.equal(result.status, 1, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "held");
  assert.equal(payload.reason_code, "insufficient_live_replays");
  assert.equal((payload.provider_identity as JsonRecord).status, "verified");
  assert.equal((payload.usage as JsonRecord).status, "complete");
  assert.equal((payload.usage as JsonRecord).provider_calls, 6);
  assert.equal((payload.budget as JsonRecord).max_output_tokens_per_call, 100);
  assert.equal(((payload.budget as JsonRecord).enforcement as JsonRecord).no_automatic_paid_retry, true);
  assert.equal((payload.redaction as JsonRecord).status, "verified");
  assert.equal((payload.redaction as JsonRecord).scratch_cleanup, "verified");
  assert.equal(execution.every((item) => flagValues(item.args, "pass-env").includes("XIAOBA_LLM_MAX_TOKENS")), true);
  assert.equal(execution.every((item) => item.env?.max_tokens === "100"), true);
});

class FixtureExternalEvaluator implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "xiaoba-evaluator",
      status: "ready",
      detail: "Fixture evaluator for OpenClaw paired admission coverage.",
      command: "fixture-xiaoba",
      capabilities: ["arena_execute", "external_agent_mode", "target_driver_manifest"],
    };
  }

  async runCase(request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    const evaluatorTraceRefs = ["usercat", "inspectorcat", "reviewercat"].map((role) => {
      const tracePath = path.join(request.run_root, "traces", "evaluators", `${role}.ndjson`);
      writeJson(tracePath, { role, runtime: "fixture-xiaoba" });
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
      detail: "Fixture evaluator completed the paired run.",
      stages: { usercat: "completed", inspectorcat: "completed", reviewercat: "completed" },
      attempts,
      evaluator_trace_refs: evaluatorTraceRefs,
    };
  }
}

function importAndRunClearance(skillPath: string): { cli: CliResult; payload: Record<string, unknown> } {
  const root = tempRoot("barena-exit-code-");
  const subjectsRoot = path.join(root, "subjects");
  const runsRoot = path.join(root, "runs");
  const imported = runPackageCli(["import", "skill", skillPath, "--subjects-root", subjectsRoot], root);
  assert.equal(imported.status, 0, imported.stderr);
  const manifest = parseJson<{ subject_id: string }>(imported.stdout);
  const cli = runPackageCli([
    "run",
    manifest.subject_id,
    "--subjects-root",
    subjectsRoot,
    "--runs-root",
    runsRoot,
    "--replays",
    "1",
  ], root);
  return { cli, payload: parseJson<Record<string, unknown>>(cli.stdout) };
}

function runPackageCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [packageCliPath(), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1", ...extraEnv },
  });
  return result as CliResult;
}

function packageCliPath(): string {
  const packageJson = readJson<PackageJson>(packageJsonPath);
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin.barena;
  assert.equal(typeof bin, "string", "package.json must expose bin.barena");
  return path.resolve(repoRoot, bin);
}

function makeNativeFixture(options: {
  rolesRoot?: string;
  skillPath?: string;
  prompt?: string;
  wrapperMode: "fail" | "delegate" | "missing-baseline-usage" | "baseline-over-limit" | "candidate-unsafe" | "identity-mismatch" | "retries" | "missing-evaluator-telemetry" | "post-call-failure";
}): NativeFixture {
  const root = tempRoot("barena-native-private-beta-");
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
  const caseDefinition = readJson<JsonRecord>(fixtureCasePath);
  caseDefinition.max_turns = 1;
  caseDefinition.replay_attempts = 1;
  caseDefinition.max_replay_cases = 1;
  caseDefinition.timeout_ms = 5_000;
  if (options.prompt) caseDefinition.task = { prompt: options.prompt };
  const casePath = path.join(root, "case.json");
  writeJson(casePath, caseDefinition);
  const policyPath = path.join(root, "live-policy.json");
  writeJson(policyPath, validLivePolicy());
  const invocationLog = path.join(root, "xiaoba-invocations.ndjson");
  const wrapperPath = path.join(root, "fake-xiaoba-wrapper.mjs");
  writeXiaoBaWrapper(wrapperPath, invocationLog, options.wrapperMode);
  return {
    root,
    projectRoot,
    rolesRoot: options.rolesRoot ?? fixtureRolesRoot,
    runsRoot: path.join(root, "runs"),
    casePath,
    skillPath: options.skillPath ?? fixtureSkillPath,
    policyPath,
    wrapperPath,
    invocationLog,
  };
}

function runNativeEvaluationCli(
  fixture: NativeFixture,
  extraEnv: NodeJS.ProcessEnv = {},
  extraArgs: string[] = []
): CliResult {
  return runPackageCli([
    "evaluate",
    "skill",
    fixture.skillPath,
    "--target",
    "xiaoba",
    "--role",
    "inherit-base-role",
    "--case",
    fixture.casePath,
    "--attempts",
    "1",
    "--xiaoba-command",
    fixture.wrapperPath,
    "--xiaoba-project-root",
    fixture.projectRoot,
    "--roles-root",
    fixture.rolesRoot,
    "--runs-root",
    fixture.runsRoot,
    "--live-policy",
    fixture.policyPath,
    ...extraArgs,
  ], fixture.root, {
    FAKE_PROVIDER_KEY: "fixture-provider-key",
    FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
    ...extraEnv,
  });
}

function validLivePolicy(): JsonRecord {
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

function writeXiaoBaWrapper(
  wrapperPath: string,
  invocationLog: string,
  mode: "fail" | "delegate" | "missing-baseline-usage" | "baseline-over-limit" | "candidate-unsafe" | "identity-mismatch" | "retries" | "missing-evaluator-telemetry" | "post-call-failure"
): void {
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const fake = ${JSON.stringify(fakeXiaoBa)};
const log = ${JSON.stringify(invocationLog)};
const mode = ${JSON.stringify(mode)};
const argv = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({
  args: argv,
  env: {
    provider: process.env.XIAOBA_LLM_PROVIDER,
    model: process.env.XIAOBA_LLM_MODEL,
    max_tokens: process.env.XIAOBA_LLM_MAX_TOKENS,
    credential_present: Boolean(process.env.FAKE_PROVIDER_KEY),
    api_base_present: Boolean(process.env.FAKE_PROVIDER_BASE),
  },
}) + "\\n", "utf8");
if (mode === "fail") {
  process.stderr.write("fixture wrapper must not be invoked before admission\\n");
  process.exit(71);
}
const flag = (name) => {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const childEnv = { ...process.env };
if (argv[0] === "arena" && argv[1] === "run" && argv[2] === "execute") {
  if (mode === "candidate-unsafe" && flag("mode") === "role_skill") childEnv.FAKE_XIAOBA_BEHAVIOR = "unsafe";
  if (mode === "identity-mismatch") childEnv.FAKE_XIAOBA_BEHAVIOR = "mismatched_identity";
  if (mode === "retries") childEnv.FAKE_XIAOBA_BEHAVIOR = "retries";
  if (mode === "missing-evaluator-telemetry") childEnv.FAKE_XIAOBA_BEHAVIOR = "missing_evaluator_telemetry";
  if (mode === "post-call-failure") childEnv.FAKE_XIAOBA_BEHAVIOR = "post_call_failure";
}
const child = spawnSync(process.execPath, [fake, ...argv], {
  cwd: process.cwd(),
  env: childEnv,
  encoding: "utf8",
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (["missing-baseline-usage", "baseline-over-limit"].includes(mode) && child.status === 0 && argv[0] === "arena" && argv[1] === "run" && argv[2] === "execute") {
  if (flag("mode") === "role") {
    const runId = flag("run-id");
    const projectRoot = process.env.XIAOBA_PROJECT_ROOT;
    const calls = path.join(projectRoot, "arena", "runs", runId, "debug", "provider-calls.ndjson");
    const rows = fs.readFileSync(calls, "utf8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
    for (const row of rows) {
      if (mode === "missing-baseline-usage") {
        delete row.input_tokens;
        delete row.output_tokens;
      } else if (row.component === "target") {
        row.output_tokens = 101;
      }
    }
    fs.writeFileSync(calls, rows.map((row) => JSON.stringify(row)).join("\\n") + "\\n", "utf8");
  }
}
process.exit(child.status ?? 1);
`;
  fs.writeFileSync(wrapperPath, source, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
}

function readInvocations(filePath: string): InvocationRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InvocationRecord);
}

function isArenaExecution(args: string[]): boolean {
  return args[0] === "arena" && args[1] === "run" && args[2] === "execute" && !args.includes("--help");
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function legacyScorecard(runId: string): JsonRecord {
  return {
    scorecard_type: "barena.skill_clearance.v0",
    subject_id: `subject-${runId}`,
    subject_type: "skill",
    run_id: runId,
    runtime: { provider: "barena-deterministic", adapter: "xiaoba-compatible", xiaoba_invoked: false },
    decision: "cleared",
    status: "pass",
    summary: "fixture legacy clearance",
    scan_summary: { decision: "pass", finding_count: 0, unsafe_count: 0, blocking_count: 0 },
    stages: { usercat: "completed", inspector: "completed", reviewer: "completed" },
    scores: { task_success: 1, stability: 1, tool_use_quality: 1, safety: 1 },
    issues: [],
    replay_attempts: { planned: 1, completed: 1, pass_count: 1, fail_count: 0, blocked_count: 0, trace_refs: [], attempts: [] },
    verifier_results: [],
    artifact_refs: [],
    evidence_refs: [],
    trace_refs: [],
    replay_refs: [],
    debug_refs: [],
  };
}

function agentScorecard(runId: string): JsonRecord {
  return {
    scorecard_type: "barena.agent_e2e.v1",
    run_id: runId,
    case_id: `case-${runId}`,
    created_at: "2026-07-17T00:00:00.000Z",
    decision: "held",
    status: "blocked",
    summary: "fixture agent E2E",
    evaluator: { runtime: "xiaoba-cli", probe: { status: "blocked" }, stages: {} },
    target: { adapter: "openclaw", probe: { status: "ready" }, status: "not_started" },
    attempts: [],
    evidence_coverage: {},
    confidence: "none",
    evidence_refs: [],
    debug_refs: [],
    isolation: "policy_only",
  };
}

function skillEvaluation(evaluationId: string): JsonRecord {
  return {
    schema: "barena.skill_evaluation.v1",
    evaluation_id: evaluationId,
    created_at: "2026-07-17T00:00:00.000Z",
    decision: "held",
    reason_code: "no_effect",
    summary: "fixture skill evaluation",
    baseline: { counts: {}, run_refs: [] },
    candidate: { counts: {}, run_refs: [] },
    evidence_refs: [],
    debug_refs: [],
  };
}

function nativeEvaluation(evaluationId: string): JsonRecord {
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1",
    evaluation_id: evaluationId,
    created_at: "2026-07-17T00:00:00.000Z",
    capability_kind: "skill",
    decision: "held",
    reason_code: "no_effect",
    summary: "fixture native capability evaluation",
    baseline: { counts: {}, attempts: [] },
    candidate: { counts: {}, attempts: [] },
    evidence_refs: [],
    debug_refs: [],
  };
}

function filesContaining(root: string, value: string): string[] {
  if (!fs.existsSync(root)) return [];
  return walkFiles(root).filter((filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8").includes(value);
    } catch {
      return false;
    }
  }).map((filePath) => path.relative(root, filePath));
}

function findFiles(root: string, basename: string): string[] {
  return fs.existsSync(root) ? walkFiles(root).filter((filePath) => path.basename(filePath) === basename) : [];
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function snapshotTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        entries.push(`d:${relative}`);
        visit(fullPath);
      } else if (entry.isFile()) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
        entries.push(`f:${relative}:${digest}`);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l:${relative}:${fs.readlinkSync(fullPath)}`);
      }
    }
  };
  visit(root);
  return entries.sort();
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseJson<T>(value: string): T {
  assert.notEqual(value.trim(), "", "expected CLI JSON output");
  return JSON.parse(value) as T;
}
