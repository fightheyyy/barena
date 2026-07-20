import assert from "node:assert/strict";
import test from "node:test";
import { SkillEvaluationResultV1 } from "../src/evaluation/types";
import { initialEvaluationTuiState, reduceEvaluationTui } from "../src/tui/evaluation-model";
import { renderEvaluationTui } from "../src/tui/evaluation-render";

test("Evaluation TUI walks through native, OpenClaw, and portable Skill paths with explicit confirmation", () => {
  let state = initialEvaluationTuiState();
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "baseline_role");
  assert.equal(state.runtime, "xiaoba");
  state = reduceEvaluationTui(state, { type: "key", text: "engineer-cat" }).state;
  state = reduceEvaluationTui(state, { type: "key", name: "return", text: "\r" }).state;
  assert.equal(state.screen, "candidate");
  state = reduceEvaluationTui(state, { type: "key", text: "/tmp/skill" }).state;
  const skillEffect = reduceEvaluationTui(state, { type: "key", name: "return", text: "\r" }).effect;
  assert.deepEqual(skillEffect, {
    type: "validate_candidate",
    runtime: "xiaoba",
    capability: "skill",
    value: "/tmp/skill",
  });
  state = reduceEvaluationTui(state, { type: "candidate_valid", name: "my-skill" }).state;
  assert.equal(state.screen, "case");
  state = reduceEvaluationTui(state, { type: "key", text: "/tmp/case.json" }).state;
  state = reduceEvaluationTui(state, { type: "case_valid", caseId: "case-1" }).state;
  assert.equal(state.screen, "review");
  state = reduceEvaluationTui(state, { type: "key", name: "right" }).state;
  assert.equal(state.attempts, 3);
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "confirm");
  const enterDoesNothing = reduceEvaluationTui(state, { type: "key", name: "return" });
  assert.equal(enterDoesNothing.state.screen, "confirm");
  assert.equal(enterDoesNothing.effect.type, "none");
  const run = reduceEvaluationTui(state, { type: "key", name: "y", text: "y" });
  assert.equal(run.state.screen, "running");
  assert.equal(run.effect.type, "run");

  let openClaw = initialEvaluationTuiState();
  openClaw = reduceEvaluationTui(openClaw, { type: "key", name: "down" }).state;
  openClaw = reduceEvaluationTui(openClaw, { type: "key", name: "return" }).state;
  assert.equal(openClaw.runtime, "openclaw");
  assert.equal(openClaw.screen, "candidate");
  openClaw = reduceEvaluationTui(openClaw, { type: "key", text: "/tmp/skill" }).state;
  openClaw = reduceEvaluationTui(openClaw, { type: "candidate_valid", name: "my-skill" }).state;
  assert.equal(openClaw.screen, "target");

  let portable = reduceEvaluationTui(initialEvaluationTuiState(), { type: "key", name: "3", text: "3" }).state;
  assert.equal(portable.runtime, "portable");
  assert.equal(portable.screen, "candidate");
  portable = { ...portable, candidateInput: "/tmp/skill" };
  portable = reduceEvaluationTui(portable, { type: "candidate_valid", name: "my-skill" }).state;
  assert.equal(portable.screen, "target_command");
  portable = reduceEvaluationTui(portable, { type: "key", text: "./driver" }).state;
  portable = reduceEvaluationTui(portable, { type: "key", name: "return" }).state;
  assert.equal(portable.screen, "case");
  assert.equal(portable.targetCommand, "./driver");
  portable = { ...portable, casePath: "/tmp/portable-case.json" };
  portable = reduceEvaluationTui(portable, { type: "case_valid", caseId: "portable-1", targetRuntime: "hermes" }).state;
  assert.equal(portable.screen, "review");
  assert.equal(portable.portableRuntime, "hermes");
});

test("TUI renders a responsive guided home, safe review, evidence result, and blocked trace", () => {
  const home = initialEvaluationTuiState();
  for (const width of [40, 80, 120]) {
    const rendered = renderEvaluationTui(home, { width, height: 24, color: false });
    assert.match(rendered, /Run an agent evaluation/);
    assert.match(rendered, /barena guide/);
    assert.match(rendered, /XiaobaOS Skill \(recommended\)/);
    assert.match(rendered, /Hermes\/custom Skill/);
    assert.equal(rendered.split("\n").every((line) => line.length <= width), true);
    assert.equal(rendered.split("\n").length <= 24, true);
  }
  assert.doesNotMatch(renderEvaluationTui(home, { width: 80, height: 24, color: false }), /██████╗/);
  assert.match(renderEvaluationTui(home, { width: 80, height: 34, color: false }), /██████╗/);
  const colored = renderEvaluationTui(home, { width: 80, height: 24, color: true });
  assert.equal(colored.includes("\x1b[38;5;230m"), false);
  assert.equal(colored.includes("\x1b[38;5;220m"), true);

  const result = blockedResult();
  let state = reduceEvaluationTui(home, { type: "result", result, traceEvents: [] }).state;
  const resultView = renderEvaluationTui(state, { width: 80, color: false });
  assert.match(resultView, /HELD/);
  assert.match(resultView, /unverified/);
  state = reduceEvaluationTui(state, { type: "key", name: "t", text: "t" }).state;
  const traceView = renderEvaluationTui(state, { width: 80, color: false });
  assert.match(traceView, /No boundary trace: target was not started/);
});

test("TUI preserves inputs on error and makes paid execution a distinct decision", () => {
  let state = initialEvaluationTuiState();
  state = { ...state, screen: "case", casePath: "./missing.json", candidateInput: "./skill" };
  state = reduceEvaluationTui(state, { type: "error", message: "Case not found", returnScreen: "case" }).state;
  assert.equal(state.screen, "error");
  const errorView = renderEvaluationTui(state, { width: 80, height: 24, color: false });
  assert.match(errorView, /Your previous inputs are preserved/);
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "case");
  assert.equal(state.casePath, "./missing.json");

  state = { ...state, screen: "review", attempts: 2, caseId: "case-1", candidateName: "skill" };
  state = reduceEvaluationTui(state, { type: "key", name: "+", text: "+" }).state;
  assert.equal(state.attempts, 3);
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  const confirmView = renderEvaluationTui(state, { width: 80, height: 24, color: false });
  assert.match(confirmView, /Press y to start; Enter does nothing/);
  state = reduceEvaluationTui(state, { type: "key", name: "n", text: "n" }).state;
  assert.equal(state.screen, "review");
});

test("TUI exposes a responsive core evaluation DAG", () => {
  let state = initialEvaluationTuiState();
  for (let index = 0; index < 4; index += 1) {
    state = reduceEvaluationTui(state, { type: "key", name: "down" }).state;
  }
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "dag");

  for (const width of [40, 80, 120]) {
    const rendered = renderEvaluationTui(state, { width, height: 30, color: false });
    assert.match(rendered, /Barena core evaluation DAG/);
    assert.match(rendered, /UserCat/);
    assert.match(rendered, /Inspector/);
    assert.match(rendered, /Reviewer/);
    assert.match(rendered, /Verifier/);
    assert.equal(rendered.split("\n").every((line) => line.length <= width), true);
  }

  state = reduceEvaluationTui(state, { type: "key", name: "escape" }).state;
  assert.equal(state.screen, "home");
  assert.equal(state.selected, 4);
});

function blockedResult(): SkillEvaluationResultV1 {
  const rate = { numerator: 0, denominator: 0, value: null };
  const selection = { mode: "path" as const, name: "demo", source_path: "/tmp/demo", fingerprint: "abc" };
  return {
    schema: "barena.skill_evaluation.v1",
    evaluation_id: "skill-eval-test",
    created_at: "2026-07-14T00:00:00.000Z",
    request_ref: "/tmp/request.json",
    evaluation_mode: "portable_verifier",
    evidence_profile: "boundary_verified",
    decision: "held",
    reason_code: "binary_not_found",
    summary: "The portable target binary is unavailable.",
    outcome_truth: { status: "unverified", verifier_backed_attempts: 0, total_observed_attempts: 4 },
    effectiveness: { status: "unavailable", baseline_pass_rate: rate, candidate_pass_rate: rate, observed_lift: null },
    quality: { baseline: "blocked", candidate: "blocked", required_evidence_complete: false, target_native_trace_available: false },
    baseline: { selection: { mode: "none" }, counts: { planned: 2, pass: 0, fail: 0, blocked: 2, unsafe: 0 }, pass_rate: rate, stability: "blocked", evidence_complete: false, run_refs: [] },
    candidate: { selection, counts: { planned: 2, pass: 0, fail: 0, blocked: 2, unsafe: 0 }, pass_rate: rate, stability: "blocked", evidence_complete: false, run_refs: [] },
    evidence_refs: [],
    debug_refs: [],
  };
}
