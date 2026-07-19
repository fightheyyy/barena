import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { PortableTargetAdapter } from "../src/targets/portable-target-adapter";
import { writeJson } from "../src/utils/fs";

const fakePortableSkill = path.resolve("test/fixtures/targets/fake-portable-skill.mjs");

test("paired portable Skill evaluation clears stable Hermes-compatible lift", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-portable-skill-"));
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(
    path.join(skillPath, "SKILL.md"),
    "---\nname: candidate-skill\n---\nCreate result.txt with the required marker.\n",
    "utf8"
  );
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "portable-skill-lift",
    target: { adapter: "portable", runtime: "hermes" },
    task: { prompt: "Create result.txt containing BARENA_PORTABLE_SKILL_OK." },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_PORTABLE_SKILL_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });

  const result = await runSkillEvaluation({
    skillPath,
    targetId: "hermes",
    cases: [casePath],
    attemptsPerArm: 2,
    runsRoot: path.join(root, "runs"),
    targetAdapter: new PortableTargetAdapter({
      command: process.execPath,
      baseArgs: [fakePortableSkill],
      runtime: "hermes",
    }),
  });

  assert.equal(result.decision, "cleared");
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.baseline.pass_rate.value, 0);
  assert.equal(result.candidate.pass_rate.value, 1);
  assert.equal(result.effectiveness.observed_lift, 1);
  assert.equal(result.quality.baseline, "stable_failure");
  assert.equal(result.quality.candidate, "stable_pass");
  assert.equal(result.evidence_profile, "boundary_verified");
  assert.equal(result.quality.target_native_trace_available, false);
  assert.equal(result.baseline.counts.planned, 2);
  assert.equal(result.candidate.counts.planned, 2);
  assert.equal(result.baseline.run_refs[0].scorecard.confidence, "medium");
  assert.equal(result.candidate.run_refs[0].scorecard.confidence, "medium");

  const baselineAttempts = result.baseline.run_refs.flatMap((run) => run.scorecard.attempts);
  const candidateAttempts = result.candidate.run_refs.flatMap((run) => run.scorecard.attempts);
  assert.equal(baselineAttempts.length, 2);
  assert.equal(candidateAttempts.length, 2);
  assert.equal(new Set([...baselineAttempts, ...candidateAttempts].map((attempt) => attempt.target.session_id)).size, 4);
  assert.deepEqual(
    baselineAttempts.map((attempt) => attempt.target.status),
    ["completed", "completed"]
  );
  assert.deepEqual(
    candidateAttempts.map((attempt) => attempt.target.status),
    ["completed", "completed"]
  );
});
