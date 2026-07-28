import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const validationRoot = path.join(
  process.cwd(),
  "docs",
  "benchmarks",
  "skillsbench-v1.1"
);

test("published SkillsBench validation keeps selection, result, and poster evidence aligned", () => {
  const selectionBytes = fs.readFileSync(
    path.join(validationRoot, "barena-validation-24.json")
  );
  const selection = JSON.parse(selectionBytes.toString("utf8"));
  const result = JSON.parse(
    fs.readFileSync(path.join(validationRoot, "results", "latest.json"), "utf8")
  );
  const poster = JSON.parse(
    fs.readFileSync(path.join(validationRoot, "poster", "manifest.json"), "utf8")
  );

  const selectionSha256 = crypto
    .createHash("sha256")
    .update(selectionBytes)
    .digest("hex");

  assert.equal(selection.schema, "barena.skillsbench_selection.v1");
  assert.equal(selection.tasks.length, 24);
  assert.equal(new Set(selection.tasks.map((entry: { category: string }) => entry.category)).size, 8);
  assert.equal(result.schema, "barena.skillsbench_validation_result.v1");
  assert.equal(result.selection_sha256, selectionSha256);
  assert.equal(result.plan.planned_rollouts, 144);
  assert.equal(result.evidence.imported_result_count, 144);
  assert.equal(result.evidence.scored_result_count, 90);
  assert.equal(result.evidence.unscored_result_count, 54);

  const pairs = result.aggregate.paired_trials;
  assert.equal(pairs.pair_count, 36);
  assert.equal(pairs.rollout_count, 72);
  assert.equal(pairs.task_count, 14);
  assert.equal(pairs.baseline.passed, 14);
  assert.equal(pairs.candidate.passed, 20);
  assert.equal(pairs.transitions.candidate_only, 8);
  assert.equal(pairs.transitions.baseline_only, 2);
  assert.ok(Math.abs(pairs.observed_lift - 1 / 6) < Number.EPSILON);
  assert.equal(pairs.mcnemar_exact_p_value, 0.109375);

  const completeTasks = result.aggregate.complete_tasks;
  assert.equal(completeTasks.task_count, 9);
  assert.deepEqual(completeTasks.decisions, {
    cleared: 2,
    held: 7,
    rejected: 0,
  });

  assert.equal(poster.source_validation_id, result.validation_id);
  assert.deepEqual(poster.exact_content.paired_trials, pairs);
  assert.deepEqual(poster.exact_content.complete_tasks, completeTasks);
  assert.ok(
    fs.statSync(
      path.join(
        validationRoot,
        "poster",
        "barena-skillsbench-black-gold.png"
      )
    ).size > 0
  );
});
