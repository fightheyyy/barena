import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTargetObservationAttempts } from "../src/e2e/target-observation";
import {
  EvaluatorRunRequest,
  EvaluatorRunResult,
  EvaluatorRuntime,
  RuntimeProbeResult,
} from "../src/e2e/types";
import { loadSkillSelection, runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { OpenClawTargetAdapter } from "../src/targets/openclaw-target-adapter";
import { readNdjson, writeJson } from "../src/utils/fs";

const fakeOpenClaw = path.resolve("test/fixtures/targets/fake-openclaw.mjs");

test("paired OpenClaw Skill evaluation clears stable portable verifier lift", async () => {
  const fixture = makeEvaluationFixture("FAKE_REQUIRE_SKILL");
  const result = await runSkillEvaluation({
    skillPath: fixture.skillPath,
    cases: [fixture.casePath],
    attemptsPerArm: 2,
    runsRoot: fixture.runsRoot,
    targetAdapter: fakeOpenClawAdapter(),
  });

  assert.equal(result.decision, "cleared");
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.evaluation_mode, "portable_verifier");
  assert.equal(result.evidence_profile, "boundary_verified");
  assert.equal(result.outcome_truth.status, "verified");
  assert.equal(result.effectiveness.observed_lift, 1);
  assert.equal(result.quality.baseline, "stable_failure");
  assert.equal(result.quality.candidate, "stable_pass");
  assert.equal(result.quality.required_evidence_complete, true);
  assert.equal(result.admission?.decision, "pass");
  assert.equal(result.baseline.run_refs.length, 1);
  assert.equal(result.candidate.run_refs.length, 1);
  assert.equal([...result.baseline.run_refs, ...result.candidate.run_refs]
    .every((run) => run.scorecard.evaluator.runtime === "barena-portable"), true);
});

test("paired Skill evaluation holds a candidate that passes but does not beat baseline", async () => {
  const fixture = makeEvaluationFixture("artifact can be produced without a Skill");
  const result = await runSkillEvaluation({
    skillPath: fixture.skillPath,
    cases: [fixture.casePath],
    attemptsPerArm: 2,
    runsRoot: fixture.runsRoot,
    targetAdapter: fakeOpenClawAdapter(),
  });

  assert.equal(result.baseline.pass_rate.value, 1);
  assert.equal(result.candidate.pass_rate.value, 1);
  assert.equal(result.effectiveness.observed_lift, 0);
  assert.equal(result.decision, "held");
  assert.equal(result.reason_code, "no_effect");
});

test("Skill evaluation validates SKILL.md and persists an honest paired blocked result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-skill-validation-"));
  assert.throws(() => loadSkillSelection(root), /must contain SKILL\.md/);

  const fixture = makeEvaluationFixture("should never reach target");
  const result = await runSkillEvaluation({
    skillPath: fixture.skillPath,
    cases: [fixture.casePath],
    attemptsPerArm: 2,
    runsRoot: fixture.runsRoot,
    evaluator: new BlockedXiaoBaEvaluator(),
    targetAdapter: fakeOpenClawAdapter(),
  });
  assert.equal(result.decision, "held");
  assert.equal(result.reason_code, "xiaoba_external_agent_mode_unavailable");
  assert.equal(result.effectiveness.observed_lift, null);
  assert.equal(result.outcome_truth.status, "unverified");
  assert.equal(result.baseline.run_refs.length, 1);
  assert.equal(result.candidate.run_refs.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.runsRoot, result.evaluation_id, "skill-evaluation.json")), true);
});

function makeEvaluationFixture(prompt: string): { skillPath: string; casePath: string; runsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-skill-evaluation-"));
  const skillPath = path.join(root, "skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: test-skill\n---\nUse this Skill to create result.txt.\n", "utf8");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "skill-effectiveness",
    target: { adapter: "openclaw", agent: "main" },
    task: { prompt },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });
  return { skillPath, casePath, runsRoot: path.join(root, "runs") };
}

function fakeOpenClawAdapter(): OpenClawTargetAdapter {
  return new OpenClawTargetAdapter({ command: process.execPath, baseArgs: [fakeOpenClaw] });
}

class TestXiaoBaEvaluator implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "xiaoba-evaluator",
      status: "ready",
      detail: "Test double for XiaoBa external-agent evaluation.",
      command: "test-xiaoba",
      capabilities: ["arena_execute", "external_agent_mode", "target_driver_manifest"],
    };
  }

  async runCase(request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    const evaluatorTraceRefs = ["usercat", "inspectorcat", "reviewercat"].map((role) => {
      const tracePath = path.join(request.run_root, "traces", "evaluators", `${role}.ndjson`);
      fs.writeFileSync(tracePath, `${JSON.stringify({ role, runtime: "test-xiaoba" })}\n`, "utf8");
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
      detail: "Test XiaoBa evaluator completed all roles.",
      stages: { usercat: "completed", inspectorcat: "completed", reviewercat: "completed" },
      attempts,
      evaluator_trace_refs: evaluatorTraceRefs,
    };
  }
}

class BlockedXiaoBaEvaluator implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "xiaoba-evaluator",
      status: "blocked",
      reason_code: "xiaoba_external_agent_mode_unavailable",
      detail: "Test XiaoBa does not expose external-agent mode.",
      command: "test-xiaoba",
      capabilities: [],
    };
  }

  async runCase(_request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    throw new Error("runCase must not run after blocked preflight");
  }
}
