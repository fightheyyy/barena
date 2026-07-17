import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeSkillRequest,
} from "../src/evaluation/xiaoba-native-input";
import { runXiaoBaNativeEvaluation } from "../src/evaluation/xiaoba-native-runner";
import { XiaoBaCapabilityEvaluationRequestV1 } from "../src/evaluation/xiaoba-native-types";
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

  const trace = loadEvaluationTrace(result);
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

test("XiaoBa native evaluation fails closed for missing binary, unsupported inheritance, collision, and native evidence gaps", async () => {
  const missing = makeFixture();
  const missingRequest = skillRequest(missing, "inherit-base-role");
  missingRequest.xiaoba.binary_path = path.join(missing.root, "not-installed");
  const missingResult = await runXiaoBaNativeEvaluation({ request: missingRequest, runs_root: missing.runsRoot });
  assert.equal(missingResult.decision, "held");
  assert.equal(missingResult.reason_code, "xiaoba_binary_not_found");
  assert.equal(missingResult.evidence_refs.length, 0);

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
  assert.equal(traceResult.evidence_refs.length, 2);
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
