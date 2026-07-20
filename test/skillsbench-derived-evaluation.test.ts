import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadXiaoBaCasePack } from "../src/evaluation/xiaoba-case-pack";
import { createXiaoBaNativeSkillRequest } from "../src/evaluation/xiaoba-native-input";
import { runXiaoBaNativeEvaluation } from "../src/evaluation/xiaoba-native-runner";
import { verifyArtifactContent, type StructuredArtifactAssertion } from "../src/verifier/artifact-verifier";

const repoRoot = path.resolve(__dirname, "..");
const packRoot = path.join(repoRoot, "calibration", "skillsbench", "dialogue-graph-mini");
const packPath = path.join(packRoot, "case-pack.json");
const skillPath = path.join(packRoot, "skill", "dialogue-graph");
const fakeXiaoBa = path.join(repoRoot, "test", "fixtures", "targets", "fake-xiaoba-native.mjs");
const rolesRoot = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "roles");

test("SkillsBench-derived case packs pin source provenance and fail closed on task drift", () => {
  const loaded = loadXiaoBaCasePack(packPath);
  assert.equal(loaded.manifest.pack_id, "skillsbench-dialogue-graph-mini");
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.cases[0].source?.task_id, "dialogue-parser");
  assert.equal(loaded.cases[0].source?.revision, "5720102e3d6b0d3471b9715995ff96144d9eefb7");
  assert.equal(loaded.cases[0].source?.official_harness_compatible, false);
  assert.equal(loaded.reference.fingerprint.length, 64);

  const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-skillsbench-pack-"));
  fs.cpSync(packRoot, copiedRoot, { recursive: true });
  fs.appendFileSync(path.join(copiedRoot, "source", "dialogue-parser-task.md"), "\nsource drift\n", "utf8");
  assert.throws(() => loadXiaoBaCasePack(path.join(copiedRoot, "case-pack.json")), /hash mismatch/i);
});

test("trusted structured JSON verification rejects a semantic graph near miss", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-structured-verifier-"));
  const artifact = path.join(root, "dialogue.json");
  const assertion: StructuredArtifactAssertion = {
    path: "dialogue.json",
    json_checks: [
      { kind: "required_keys", pointer: "", keys: ["nodes", "edges"] },
      {
        kind: "directed_graph",
        nodes_pointer: "/nodes",
        edges_pointer: "/edges",
        node_id_key: "id",
        edge_from_key: "from",
        edge_to_key: "to",
        start_id: "Start",
        allowed_external_targets: ["End"],
        require_all_nodes_reachable: true,
      },
    ],
  };

  writeJson(artifact, {
    nodes: [{ id: "Start" }, { id: "Choice" }],
    edges: [{ from: "Start", to: "Choice" }, { from: "Choice", to: "End" }],
  });
  assert.equal(verifyArtifactContent(assertion, artifact, "dialogue.json").status, "pass");

  writeJson(artifact, {
    nodes: [{ id: "Start" }, { id: "Choice" }, { id: "Unreachable" }],
    edges: [{ from: "Start", to: "Choice" }, { from: "Choice", to: "End" }],
  });
  const nearMiss = verifyArtifactContent(assertion, artifact, "dialogue.json");
  assert.equal(nearMiss.status, "fail");
  assert.match(nearMiss.detail, /unreachable/i);
});

test("SkillsBench-derived dialogue calibration preserves prompts and clears only the activated candidate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-skillsbench-e2e-"));
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");

  const request = createXiaoBaNativeSkillRequest({
    roleId: "inherit-base-role",
    skillPath,
    casePackPath: packPath,
    attemptsPerArm: 2,
    binaryPath: fakeXiaoBa,
    projectRoot,
    rolesRoot,
    passEnv: [],
  });
  const canonicalPrompt = request.cases[0].task.prompt;
  assert.equal(canonicalPrompt.includes("dialogue-graph"), false);
  assert.equal(request.case_pack?.pack_id, "skillsbench-dialogue-graph-mini");

  const result = await runXiaoBaNativeEvaluation({ request, runs_root: path.join(root, "runs") });
  assert.equal(result.decision, "cleared", `${result.reason_code}: ${result.summary}; baseline=${JSON.stringify(result.baseline.counts)} candidate=${JSON.stringify(result.candidate.counts)} details=${JSON.stringify(result.candidate.attempts.map((attempt) => attempt.assertions))}`);
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.case_pack?.source.revision, "5720102e3d6b0d3471b9715995ff96144d9eefb7");
  assert.deepEqual(result.baseline.counts, { planned: 2, pass: 0, fail: 2, blocked: 0, unsafe: 0 });
  assert.deepEqual(result.candidate.counts, { planned: 2, pass: 2, fail: 0, blocked: 0, unsafe: 0 });
  assert.equal(result.candidate.attempts.every((attempt) => attempt.activation.observed), true);
  assert.equal(result.baseline.attempts.every((attempt) => !attempt.activation.observed), true);

  for (const attempt of [...result.baseline.attempts, ...result.candidate.attempts]) {
    const manifest = JSON.parse(fs.readFileSync(attempt.refs.request_manifest, "utf8")) as { delivered_prompt: string; skill_name?: string };
    assert.equal(manifest.delivered_prompt, canonicalPrompt);
    assert.equal(manifest.delivered_prompt.includes("dialogue-graph\n\n"), false);
  }
  assert.equal(result.candidate.attempts.every((attempt) => attempt.assertions.every((item) => item.status === "pass")), true);
  assert.equal(result.baseline.attempts.every((attempt) => attempt.assertions.some((item) => item.status === "fail")), true);

  const report = fs.readFileSync(
    path.join(root, "runs", result.evaluation_id, "reports", "report.md"),
    "utf8"
  );
  assert.match(report, /Case pack: skillsbench-dialogue-graph-mini/);
  assert.match(report, /Case source: skillsbench @ 5720102e3d6b0d3471b9715995ff96144d9eefb7/);
  assert.match(report, /Source tasks: dialogue-parser/);
  assert.match(report, /Official harness compatible: no \(derived projection\)/);
});

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
