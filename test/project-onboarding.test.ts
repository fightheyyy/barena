import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/main";
import {
  initializeProjectConfig,
  loadProjectConfig,
  providerReadiness,
} from "../src/cli/project-config";
import { loadAgentE2ECase } from "../src/e2e/case-runner";
import { listBuiltinSuites, resolveBuiltinSuite } from "../src/evaluation/builtin-suites";
import { runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { PortableTargetAdapter } from "../src/targets/portable-target-adapter";

const skillsBenchDriver = path.resolve("test/fixtures/targets/fake-skillsbench-portable.mjs");
const dialogueSkill = path.resolve("calibration/skillsbench/dialogue-graph-mini/skill/dialogue-graph");

test("project config stores provider environment references without secret values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-project-config-"));
  const configPath = path.join(root, ".barena", "config.json");
  const secretName = "BARENA_PROJECT_CONFIG_TEST_KEY";
  const secretValue = "must-not-appear-in-config-or-doctor";
  const previous = process.env[secretName];
  process.env[secretName] = secretValue;
  try {
    const initialized = initializeProjectConfig({
      cwd: root,
      configPath,
      target: "hermes",
      targetCommand: "/tmp/hermes-driver",
      provider: "openai",
      model: "test-model",
      credentialEnv: secretName,
      suite: "skillsbench:starter",
      attempts: 3,
    });
    const source = fs.readFileSync(configPath, "utf8");
    const loaded = loadProjectConfig(root, configPath);
    const readiness = providerReadiness(loaded?.config.provider);

    assert.equal(initialized.config.default_target, "hermes");
    assert.equal(loaded?.config.targets.hermes.kind, "portable");
    assert.equal(source.includes(secretName), true);
    assert.equal(source.includes(secretValue), false);
    assert.equal(JSON.stringify(readiness).includes(secretValue), false);
    assert.equal(readiness.status, "ready");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.throws(() => initializeProjectConfig({ cwd: root, configPath, target: "openclaw" }), /already exists/);
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test("SkillsBench starter materializes for portable Agents and preserves structured verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-skillsbench-starter-"));
  const suites = listBuiltinSuites();
  assert.equal(suites[0].aliases.includes("skillsbench:starter"), true);
  assert.equal(suites[0].official_harness_result, false);

  const resolved = resolveBuiltinSuite({
    suite: "skillsbench:starter",
    targetId: "hermes",
    outputRoot: path.join(root, ".barena", "generated"),
    envAllowlist: ["OPENAI_API_KEY"],
  });
  assert.equal(resolved.kind, "portable_cases");
  if (resolved.kind !== "portable_cases") return;
  const loaded = loadAgentE2ECase(resolved.casePaths[0]);
  assert.equal(loaded.caseDefinition.target.adapter, "portable");
  assert.equal(loaded.caseDefinition.target.runtime, "hermes");
  assert.equal(loaded.caseDefinition.assertions.artifacts.some((item) => item.json_checks?.length), true);

  const result = await runSkillEvaluation({
    skillPath: dialogueSkill,
    targetId: "hermes",
    cases: resolved.casePaths,
    attemptsPerArm: 2,
    runsRoot: path.join(root, "runs"),
    targetAdapter: new PortableTargetAdapter({
      command: process.execPath,
      baseArgs: [skillsBenchDriver],
      runtime: "hermes",
    }),
  });
  assert.equal(result.decision, "cleared");
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.baseline.pass_rate.value, 0);
  assert.equal(result.candidate.pass_rate.value, 1);
  assert.equal(result.candidate.run_refs.every((run) =>
    run.scorecard.attempts.every((attempt) => attempt.assertions.every((assertion) => assertion.status === "pass"))
  ), true);
});

test("barena init and target-aware doctor use configured driver and redact provider values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-init-doctor-"));
  const configPath = path.join(root, ".barena", "config.json");
  const driverPath = path.join(root, "hermes-driver.mjs");
  fs.copyFileSync(skillsBenchDriver, driverPath);
  fs.chmodSync(driverPath, 0o755);
  const envName = "BARENA_INIT_DOCTOR_TEST_KEY";
  const envValue = "doctor-secret-value";
  const previous = process.env[envName];
  process.env[envName] = envValue;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    const initExit = await runCli([
      "init",
      "--config", configPath,
      "--target", "hermes",
      "--target-command", driverPath,
      "--provider", "openai",
      "--model", "test-model",
      "--api-key-env", envName,
      "--suite", "skillsbench:starter",
    ]);
    assert.equal(initExit, 0);
    const doctorExit = await runCli(["doctor", "--config", configPath]);
    assert.equal(doctorExit, 0);
    const evalExit = await runCli([
      "eval",
      "skill",
      dialogueSkill,
      "--config", configPath,
      "--attempts", "1",
    ]);
    assert.equal(evalExit, 0);
    const combined = output.join("\n");
    assert.match(combined, /barena\.project_config\.v1/);
    assert.match(combined, /skillsbench:starter/);
    assert.match(combined, /"selected_target": "hermes"/);
    assert.match(combined, /"status": "ready"/);
    assert.match(combined, /"reason_code": "positive_lift"/);
    assert.equal(fs.existsSync(path.join(root, "runs")), true);
    assert.equal(combined.includes(envValue), false);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});
