import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listAgentTargets, importAgentTarget } from "../src/agents/targets";
import { runClearance } from "../src/domain/clearance";
import { importLocalSkill } from "../src/subjects/importer";
import { loadScorecard, renderMarkdown } from "../src/reports/report";

test("lists the built-in agent CI targets", () => {
  const targets = listAgentTargets();
  const ids = targets.map((target) => target.target_id).sort();

  assert.deepEqual(ids, ["hermes", "openclaw", "opencode", "xiaoba"]);
  assert.equal(targets.every((target) => target.ci_focus.length > 0), true);
  assert.equal(targets.every((target) => target.risk_focus.length > 0), true);
});

test("imports and runs a built-in agent target", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-agent-target-"));
  const subject = importAgentTarget("opencode", {
    subjectsRoot: path.join(temp, "subjects"),
  });

  const scorecard = runClearance(subject, { runsRoot: path.join(temp, "runs"), replays: 1 });
  const report = renderMarkdown(scorecard);

  assert.equal(subject.type, "agent");
  assert.equal(subject.source.kind, "builtin");
  assert.equal(subject.metadata.scan_decision, "pass");
  assert.equal(scorecard.decision, "cleared");
  assert.equal(scorecard.subject_type, "agent");
  assert.equal(scorecard.agent_target?.target_id, "opencode");
  assert.equal(scorecard.agent_target?.category, "coding_agent");
  assert.equal(scorecard.replay_attempts.completed, 1);
  assert.equal(scorecard.replay_attempts.pass_count, 1);
  assert.equal(scorecard.artifact_refs.some((artifact) => artifact.endsWith("code-change-artifact.txt")), true);
  assert.equal(report.includes("## Agent Target"), true);
  assert.equal(report.includes("OpenCode (opencode)"), true);
  assert.equal(report.includes("code task success"), true);
});

test("imports and clears a good local skill", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-good-"));
  const subject = importLocalSkill(path.resolve("test/fixtures/skills/good-skill"), {
    subjectsRoot: path.join(temp, "subjects"),
  });

  const scorecard = runClearance(subject, { runsRoot: path.join(temp, "runs") });

  assert.equal(subject.subject_id, "good-skill");
  assert.equal(scorecard.decision, "cleared");
  assert.equal(scorecard.status, "pass");
  assert.equal(scorecard.issues.length, 0);
  assert.equal(scorecard.scores.safety, 1);
  assert.equal(scorecard.runtime.xiaoba_invoked, false);
  assert.equal(scorecard.replay_attempts.completed, 3);
  assert.equal(scorecard.replay_attempts.pass_count, 3);
  assert.equal(fs.existsSync(path.join(temp, "runs", scorecard.run_id, "reports", "report.json")), true);
  assert.equal(loadScorecard(scorecard.run_id, path.join(temp, "runs")).decision, "cleared");
});

test("rejects a skill with unsafe instructions", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-unsafe-"));
  const subject = importLocalSkill(path.resolve("test/fixtures/skills/unsafe-skill"), {
    subjectsRoot: path.join(temp, "subjects"),
  });

  const scorecard = runClearance(subject, { runsRoot: path.join(temp, "runs") });

  assert.equal(scorecard.decision, "rejected");
  assert.equal(scorecard.status, "unsafe");
  assert.equal(scorecard.issues.some((issue) => issue.family === "static_scan"), true);
  assert.equal(scorecard.replay_attempts.completed, 0);
  assert.equal(scorecard.scores.safety, 0);
});

test("holds a skill that claims completion without artifacts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-missing-artifact-"));
  const subject = importLocalSkill(path.resolve("test/fixtures/skills/no-artifact-skill"), {
    subjectsRoot: path.join(temp, "subjects"),
  });

  const scorecard = runClearance(subject, { runsRoot: path.join(temp, "runs"), replays: 2 });

  assert.equal(scorecard.decision, "held");
  assert.equal(scorecard.status, "unstable");
  assert.equal(scorecard.issues.some((issue) => issue.family === "hallucinated_completion"), true);
  assert.equal(scorecard.replay_attempts.completed, 2);
  assert.equal(scorecard.replay_attempts.fail_count, 2);
});

test("records verifier pass and failure", () => {
  const passTemp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-verifier-pass-"));
  const passSubject = importLocalSkill(path.resolve("test/fixtures/skills/good-skill"), {
    subjectsRoot: path.join(passTemp, "subjects"),
  });
  const passScorecard = runClearance(passSubject, {
    runsRoot: path.join(passTemp, "runs"),
    verifierPath: path.resolve("test/fixtures/verifiers/pass.js"),
  });
  assert.equal(passScorecard.verifier_results[0].status, "pass");
  assert.equal(passScorecard.decision, "cleared");

  const failTemp = fs.mkdtempSync(path.join(os.tmpdir(), "barena-verifier-fail-"));
  const failSubject = importLocalSkill(path.resolve("test/fixtures/skills/good-skill"), {
    subjectsRoot: path.join(failTemp, "subjects"),
  });
  const failScorecard = runClearance(failSubject, {
    runsRoot: path.join(failTemp, "runs"),
    verifierPath: path.resolve("test/fixtures/verifiers/fail.js"),
  });
  assert.equal(failScorecard.verifier_results[0].status, "fail");
  assert.equal(failScorecard.decision, "held");
  assert.equal(failScorecard.issues.some((issue) => issue.family === "verifier_failure"), true);
});
