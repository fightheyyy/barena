import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentE2ECase, runAgentE2ECase } from "../src/e2e/case-runner";
import type { AgentE2ECaseV1 } from "../src/e2e/types";
import { PortableTargetAdapter } from "../src/targets/portable-target-adapter";

const portableDriver = path.resolve("examples/portable-driver.mjs");
const portableCase = path.resolve("examples/portable-case.json");

test("portable Hermes-compatible driver clears with prompt, session, verifier, and boundary evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-portable-clear-"));
  const loaded = loadAgentE2ECase(portableCase);
  const adapter = driverAdapter();
  const probe = await adapter.probe();
  assert.equal(probe.status, "ready");
  assert.equal(probe.component, "portable-target");

  const scorecard = await runAgentE2ECase(loaded.caseDefinition, loaded.caseBaseDir, {
    runsRoot: path.join(root, "runs"),
    targetAdapter: adapter,
  });
  assert.equal(scorecard.decision, "cleared");
  assert.equal(scorecard.status, "pass");
  assert.equal(scorecard.evaluation_mode, "portable_verifier");
  assert.equal(scorecard.evidence_profile, "boundary_verified");
  assert.equal(scorecard.evaluator.runtime, "barena-portable");
  assert.equal(scorecard.evidence_coverage.evaluator_traces, false);
  assert.equal(scorecard.evidence_coverage.target_native_trace, false);
  assert.equal(scorecard.evidence_coverage.verifier_evidence, true);
  assert.equal(scorecard.confidence, "medium");
  assert.equal(scorecard.attempts.length, 2);
  assert.equal(new Set(scorecard.attempts.map((attempt) => attempt.workspace)).size, 2);
  assert.equal(new Set(scorecard.attempts.map((attempt) => attempt.target.session_id)).size, 2);

  for (const attempt of scorecard.attempts) {
    const inputEvent = attempt.target.events.find((event) => event.provenance.observed_from === "target_input");
    const requestRef = inputEvent?.data?.request_ref;
    assert.equal(typeof requestRef, "string");
    const request = JSON.parse(fs.readFileSync(requestRef as string, "utf8")) as {
      prompt: { path: string; sha256: string };
    };
    const prompt = fs.readFileSync(request.prompt.path);
    assert.equal(crypto.createHash("sha256").update(prompt).digest("hex"), request.prompt.sha256);
    assert.equal(fs.existsSync(attempt.verifier_ref), true);
  }
});

test("portable verifier holds protocol gaps and verifier failures, and rejects unsafe outcomes", async () => {
  const verifierFailure = await runCase("BARENA_DRIVER_NO_ARTIFACT", 0);
  assert.equal(verifierFailure.decision, "held");
  assert.equal(verifierFailure.reason_code, "artifact_assertion_failed");

  const wrongHash = await runCase("BARENA_DRIVER_WRONG_HASH", 0);
  assert.equal(wrongHash.decision, "held");
  assert.equal(wrongHash.reason_code, "target_protocol_error");

  const malformed = await runCase("BARENA_DRIVER_MALFORMED", 0);
  assert.equal(malformed.decision, "held");
  assert.equal(malformed.reason_code, "target_protocol_error");

  const duplicateSession = await runCase("BARENA_DRIVER_DUPLICATE_SESSION", 1);
  assert.equal(duplicateSession.decision, "held");
  assert.equal(duplicateSession.reason_code, "evidence_incomplete");

  const unsafe = await runCase("BARENA_DRIVER_UNSAFE", 0);
  assert.equal(unsafe.decision, "rejected");
  assert.equal(unsafe.reason_code, "target_reported_unsafe");
});

test("portable verifier blocks missing drivers, deadlines, baseline leaks, and invisible candidate Skills", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-portable-blocked-"));
  const missing = await runAgentE2ECase(makeCase("normal", 0), root, {
    runsRoot: path.join(root, "missing-runs"),
    targetAdapter: new PortableTargetAdapter({ command: path.join(root, "missing-driver"), runtime: "hermes" }),
  });
  assert.equal(missing.decision, "held");
  assert.equal(missing.reason_code, "binary_not_found");

  const timeoutCase = makeCase("BARENA_DRIVER_TIMEOUT", 0);
  timeoutCase.timeout_ms = 1_000;
  const timedOut = await runAgentE2ECase(timeoutCase, root, {
    runsRoot: path.join(root, "timeout-runs"),
    targetAdapter: driverAdapter(),
  });
  assert.equal(timedOut.reason_code, "target_timeout");

  const leak = await runCase("BARENA_DRIVER_BASELINE_LEAK", 0);
  assert.equal(leak.reason_code, "baseline_skill_leak");

  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\n", "utf8");
  const invisible = await runAgentE2ECase(makeCase("BARENA_DRIVER_SKILL_INVISIBLE", 0), root, {
    runsRoot: path.join(root, "invisible-runs"),
    targetAdapter: driverAdapter(),
    skill: {
      mode: "path",
      name: "candidate-skill",
      source_path: skillPath,
      fingerprint: hashDirectory(skillPath),
    },
  });
  assert.equal(invisible.reason_code, "skill_not_visible");
});

function driverAdapter(): PortableTargetAdapter {
  return new PortableTargetAdapter({ command: process.execPath, baseArgs: [portableDriver], runtime: "hermes" });
}

async function runCase(prompt: string, replays: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-portable-case-"));
  return runAgentE2ECase(makeCase(prompt, replays), root, {
    runsRoot: path.join(root, "runs"),
    targetAdapter: driverAdapter(),
  });
}

function makeCase(prompt: string, replays: number): AgentE2ECaseV1 {
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: "portable-contract",
    target: { adapter: "portable", runtime: "hermes" },
    task: { prompt },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_PORTABLE_OK" }] },
    replays,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  };
}

function hashDirectory(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const name of fs.readdirSync(root).sort()) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}
