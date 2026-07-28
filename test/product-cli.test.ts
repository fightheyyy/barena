import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/main";
import { resolveBuiltinSuite } from "../src/evaluation/builtin-suites";

const portableDriver = path.resolve("examples/portable-driver.mjs");
const portableCase = path.resolve("examples/portable-case.json");
const skillsBenchDriver = path.resolve(
  "test/fixtures/targets/fake-skillsbench-portable.mjs"
);
const dialogueSkill = path.resolve(
  "calibration/skillsbench/dialogue-graph-mini/skill/dialogue-graph"
);

test("Explore, Replay, and Compare expose real product command help", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) =>
    errors.push(values.map(String).join(" "));
  try {
    assert.equal(await runCli(["explore", "--help"]), 0);
    assert.equal(await runCli(["replay", "--help"]), 0);
    assert.equal(await runCli(["compare", "--help"]), 0);
    assert.equal(await runCli(["not-a-product-command", "--help"]), 3);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const rendered = output.join("\n");
  assert.match(rendered, /UserCat → target Agent → InspectorCat → ReviewerCat/);
  assert.match(rendered, /barena replay <case\.json>/);
  assert.match(rendered, /barena compare <candidate-skill>/);
  assert.match(errors.join("\n"), /Unknown command: not-a-product-command/);
});

test("Replay and Compare execute their existing verifier-backed engines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-product-cli-"));
  const executableSkillsBenchDriver = path.join(
    root,
    "fake-skillsbench-portable.mjs"
  );
  fs.copyFileSync(skillsBenchDriver, executableSkillsBenchDriver);
  fs.chmodSync(executableSkillsBenchDriver, 0o755);
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    const replayExit = await runCli([
      "replay",
      portableCase,
      "--target-command",
      portableDriver,
      "--runs-root",
      path.join(root, "replay-runs"),
    ]);
    assert.equal(replayExit, 0);

    const suite = resolveBuiltinSuite({
      suite: "skillsbench:starter",
      targetId: "hermes",
      outputRoot: path.join(root, "generated"),
    });
    const compareExit = await runCli([
      "compare",
      dialogueSkill,
      "--target",
      "hermes",
      "--target-command",
      executableSkillsBenchDriver,
      "--case",
      suite.casePaths[0],
      "--attempts",
      "1",
      "--runs-root",
      path.join(root, "compare-runs"),
    ]);
    assert.equal(compareExit, 0);
  } finally {
    console.log = originalLog;
  }

  const rendered = output.join("\n");
  assert.match(rendered, /"scorecard_type": "barena\.agent_e2e\.v1"/);
  assert.match(rendered, /"schema": "barena\.skill_evaluation\.v1"/);
  assert.match(rendered, /"reason_code": "positive_lift"/);
});
