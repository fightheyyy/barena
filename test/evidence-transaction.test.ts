import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  sanitizeCopyToRetention,
  scanRetainedTreeForSecrets,
  writeSanitizedJson,
  type EvidenceRedactionContext,
} from "../src/evaluation/evidence-redaction";
import { bindXiaoBaLivePolicy } from "../src/evaluation/live-policy";
import { createXiaoBaNativeSkillRequest } from "../src/evaluation/xiaoba-native-input";
import { runXiaoBaNativeEvaluation } from "../src/evaluation/xiaoba-native-runner";
import type {
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaLivePolicyV1,
  XiaoBaNativeAttemptResult,
} from "../src/evaluation/xiaoba-native-types";
import { listRunCatalog } from "../src/runs/catalog";

const repoRoot = path.resolve(__dirname, "..");
const fakeXiaoBa = path.join(repoRoot, "test", "fixtures", "targets", "fake-xiaoba-native.mjs");
const rolesRoot = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "roles");
const skillPath = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "skills", "candidate-skill");
const skillCase = path.join(repoRoot, "docs", "cases", "xiaoba-skill-artifact.json");

const EMPTY_REDACTION: EvidenceRedactionContext = {
  profile: "test",
  secrets: [],
};

test("native artifacts and evidence reject realpath escapes through symlinked ancestors", async (t) => {
  for (const behavior of ["symlink_escape", "artifact_symlink_escape"] as const) {
    await t.test(behavior, async () => {
      const fixture = makeNativeFixture(`barena-realpath-${behavior}-`);
      const binaryPath = writePatchedFakeXiaoBa(fixture.root);
      const request = nativeRequest(fixture, binaryPath);
      request.xiaoba.pass_env = ["FAKE_XIAOBA_BEHAVIOR"];

      const result = await runXiaoBaNativeEvaluation({ request, runs_root: fixture.runsRoot }, {
        environment: {
          PATH: process.env.PATH,
          FAKE_XIAOBA_BEHAVIOR: behavior,
        },
      });
      const attempts = [...result.baseline.attempts, ...result.candidate.attempts];

      assert.equal(result.decision, "held");
      assert.equal(result.reason_code, "xiaoba_artifact_ref_invalid");
      assert.equal(attempts.some((attempt) => attempt.reason_code === "xiaoba_artifact_ref_invalid"), true);
    });
  }
});

test("live scratch setup failures still run guaranteed finally cleanup", async () => {
  const fixture = makeNativeFixture("barena-scratch-finally-");
  const request = minimalLiveRequest(fixture);
  const scratchRoot = path.join(fixture.root, "owned-scratch");
  const cleanupCalls: string[] = [];
  let observedError: unknown;

  try {
    await runXiaoBaNativeEvaluation({
      request,
      runs_root: fixture.runsRoot,
      live_policy_binding: bindXiaoBaLivePolicy(livePolicy()),
    }, {
      environment: liveEnvironment(),
      scratch_root_factory: () => {
        fs.mkdirSync(scratchRoot, { recursive: true });
        fs.writeFileSync(path.join(scratchRoot, "xiaoba-project"), "blocks directory setup\n", "utf8");
        return scratchRoot;
      },
      scratch_cleanup: (ownedRoot) => {
        cleanupCalls.push(ownedRoot);
        fs.rmSync(ownedRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    observedError = error;
  }

  assert.deepEqual(
    cleanupCalls,
    [scratchRoot],
    `scratch cleanup was skipped after setup failure: ${observedError instanceof Error ? observedError.message : String(observedError)}`
  );
  assert.equal(fs.existsSync(scratchRoot), false);
});

test("default live scratch cleanup removes immutable directories without following symlinks", async () => {
  const fixture = makeNativeFixture("barena-scratch-immutable-");
  const request = minimalLiveRequest(fixture);
  const scratchRoot = path.join(fixture.root, "owned-scratch");
  const immutablePrompts = path.join(scratchRoot, "roles", "fixture-role", "prompts");
  const immutablePrompt = path.join(immutablePrompts, "fixture-system-prompt.md");
  const externalRoot = path.join(fixture.root, "external");
  const externalFile = path.join(externalRoot, "keep.txt");

  fs.mkdirSync(immutablePrompts, { recursive: true });
  fs.writeFileSync(immutablePrompt, "immutable\n", "utf8");
  fs.mkdirSync(externalRoot, { recursive: true });
  fs.writeFileSync(externalFile, "outside scratch\n", "utf8");
  fs.symlinkSync(externalRoot, path.join(immutablePrompts, "external-link"), "dir");
  fs.writeFileSync(path.join(scratchRoot, "xiaoba-project"), "blocks directory setup\n", "utf8");
  fs.chmodSync(immutablePrompt, 0o444);
  for (const directory of [immutablePrompts, path.dirname(immutablePrompts), path.join(scratchRoot, "roles"), scratchRoot]) {
    fs.chmodSync(directory, 0o555);
  }
  fs.chmodSync(externalFile, 0o444);
  fs.chmodSync(externalRoot, 0o555);
  const externalRootMode = fs.statSync(externalRoot).mode & 0o777;
  const externalFileMode = fs.statSync(externalFile).mode & 0o777;

  await runXiaoBaNativeEvaluation({
    request,
    runs_root: fixture.runsRoot,
    live_policy_binding: bindXiaoBaLivePolicy(livePolicy()),
  }, {
    environment: liveEnvironment(),
    scratch_root_factory: () => scratchRoot,
  });

  assert.throws(
    () => fs.lstatSync(scratchRoot),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
  assert.equal(fs.readFileSync(externalFile, "utf8"), "outside scratch\n");
  assert.equal(fs.statSync(externalRoot).mode & 0o777, externalRootMode);
  assert.equal(fs.statSync(externalFile).mode & 0o777, externalFileMode);
});

test("injected live scratch cleanup failures remain scratch_cleanup_failed", async () => {
  const fixture = makeNativeFixture("barena-scratch-cleanup-failed-");
  const request = minimalLiveRequest(fixture);
  const scratchRoot = path.join(fixture.root, "owned-scratch");

  const result = await runXiaoBaNativeEvaluation({
    request,
    runs_root: fixture.runsRoot,
    live_policy_binding: bindXiaoBaLivePolicy(livePolicy()),
  }, {
    environment: liveEnvironment(),
    scratch_root_factory: () => {
      fs.mkdirSync(scratchRoot, { recursive: true });
      fs.writeFileSync(path.join(scratchRoot, "xiaoba-project"), "blocks directory setup\n", "utf8");
      return scratchRoot;
    },
    scratch_cleanup: () => {
      throw new Error("injected cleanup failure");
    },
  });

  assert.equal(result.reason_code, "scratch_cleanup_failed");
  assert.equal(fs.lstatSync(scratchRoot).isDirectory(), true);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

test("sanitized directory capture is transactional when a later entry cannot be retained", () => {
  const root = tempRoot("barena-sanitize-transaction-");
  const source = path.join(root, "source");
  const destination = path.join(root, "retained");
  const secret = "binary-secret-6c2af52e";
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "01-safe.txt"), "safe\n", "utf8");
  fs.writeFileSync(path.join(source, "02-secret.bin"), Buffer.concat([
    Buffer.from([0, 1, 2, 3]),
    Buffer.from(secret, "utf8"),
  ]));

  assert.throws(() => sanitizeCopyToRetention(source, destination, {
    profile: "test",
    secrets: [{ env_name: "TEST_BINARY_SECRET", value: secret }],
  }), /binary evidence contains secret/i);
  assert.equal(fs.existsSync(destination), false, "failed capture must not leave a partial destination tree");
});

test("quarantined sanitized evidence has no orphan files, stale refs, or stale manifest entries", async () => {
  const fixture = makeNativeFixture("barena-quarantine-sync-");
  const secret = "quarantine-secret-0de9c3a4";
  const request = minimalLiveRequest(fixture);
  request.xiaoba.binary_path = writePatchedFakeXiaoBa(fixture.root);
  request.xiaoba.pass_env = ["FAKE_XIAOBA_BEHAVIOR", "TEST_RETENTION_SECRET"];
  const policy = livePolicy();
  policy.redaction.secret_env_names = ["TEST_RETENTION_SECRET"];

  const result = await runXiaoBaNativeEvaluation({
    request,
    runs_root: fixture.runsRoot,
    live_policy_binding: bindXiaoBaLivePolicy(policy),
  }, {
    environment: {
      ...liveEnvironment(),
      FAKE_XIAOBA_BEHAVIOR: "binary_evidence_secret",
      TEST_RETENTION_SECRET: secret,
    },
  });

  assert.deepEqual(filesContaining(fixture.runsRoot, secret), []);
  const attempts = [...result.baseline.attempts, ...result.candidate.attempts];
  assert.equal(attempts.length > 0, true);

  for (const attempt of attempts) {
    for (const ref of retainedAttemptRefs(attempt)) {
      assert.equal(fs.existsSync(ref), true, `attempt retained ref is stale: ${ref}`);
    }
    for (const copy of attempt.evidence) {
      assert.equal(fs.existsSync(copy.copied_ref), true, `attempt evidence ref is stale: ${copy.copied_ref}`);
    }

    const manifestRef = attempt.redaction?.manifest_ref;
    assert.equal(typeof manifestRef, "string", "retained attempts must have a redaction manifest");
    assert.equal(fs.existsSync(manifestRef!), true, `redaction manifest is stale: ${manifestRef}`);
    const redactionManifest = readJson<{ entries: Array<{ copied_ref: string; kind: "file" | "directory" }> }>(manifestRef!);
    assert.equal(redactionManifest.entries.every((entry) => fs.existsSync(entry.copied_ref)), true);

    const evidenceManifestRef = path.join(path.dirname(manifestRef!), "evidence-manifest.json");
    assert.equal(fs.existsSync(evidenceManifestRef), true);
    const evidenceManifest = readJson<Array<{ copied_ref: string }>>(evidenceManifestRef);
    assert.deepEqual(
      evidenceManifest.map((entry) => entry.copied_ref).sort(),
      redactionManifest.entries.map((entry) => entry.copied_ref).sort()
    );

    const attemptRoot = path.resolve(path.dirname(manifestRef!), "..");
    const manifestFiles = new Set([path.resolve(manifestRef!), path.resolve(evidenceManifestRef)]);
    for (const retainedFile of walkFiles(attemptRoot).filter((file) => !manifestFiles.has(path.resolve(file)))) {
      assert.equal(
        redactionManifest.entries.some((entry) => entry.kind === "file"
          ? path.resolve(entry.copied_ref) === path.resolve(retainedFile)
          : isInside(entry.copied_ref, retainedFile)),
        true,
        `retained artifact is not represented in the evidence manifest: ${retainedFile}`
      );
    }
  }

  for (const ref of result.evidence_refs) {
    assert.equal(fs.existsSync(ref), true, `result evidence ref is stale: ${ref}`);
  }
});

test("retained secret scanning covers path names as well as file contents", () => {
  const root = tempRoot("barena-retained-path-name-");
  const secret = "path-secret-9d8a21f4";
  const retainedFile = path.join(root, `evidence-${secret}`, "safe.txt");
  fs.mkdirSync(path.dirname(retainedFile), { recursive: true });
  fs.writeFileSync(retainedFile, "safe contents\n", "utf8");

  const scan = scanRetainedTreeForSecrets(root, {
    profile: "test",
    secrets: [{ env_name: "TEST_PATH_SECRET", value: secret }],
  });

  assert.equal(scan.status, "fail");
  assert.equal(scan.hits.some((hit) => hit.secret_name === "TEST_PATH_SECRET"), true);
});

test("structured redaction handles camelCase secrets without erasing contract-critical fields", () => {
  const root = tempRoot("barena-structured-redaction-");
  const destination = path.join(root, "retained.json");
  writeSanitizedJson(destination, {
    schema: "barena.fixture.v1",
    decision: "held",
    status: "complete",
    evidence: {
      status: "verified",
      accessToken: "nested-access-token",
    },
    accessToken: "top-level-access-token",
    refreshToken: "refresh-token",
    proxyAuthorization: "proxy-credential",
    setCookie: "cookie-value",
  }, {
    profile: "test",
    secrets: [],
    structured_field_names: ["schema", "decision", "status", "evidence"],
  });

  const retained = readJson<Record<string, unknown>>(destination);
  assert.equal(retained.schema, "barena.fixture.v1");
  assert.equal(retained.decision, "held");
  assert.equal(retained.status, "complete");
  assert.equal(typeof retained.evidence, "object");
  assert.equal((retained.evidence as Record<string, unknown>).status, "verified");
  assert.equal((retained.evidence as Record<string, unknown>).accessToken, "[REDACTED]");
  assert.equal(retained.accessToken, "[REDACTED]");
  assert.equal(retained.refreshToken, "[REDACTED]");
  assert.equal(retained.proxyAuthorization, "[REDACTED]");
  assert.equal(retained.setCookie, "[REDACTED]");
});

test("structured redaction sanitizes secret assignments embedded inside JSON strings", () => {
  const root = tempRoot("barena-embedded-secret-assignment-");
  const destination = path.join(root, "retained.json");
  const context: EvidenceRedactionContext = {
    profile: "test",
    secrets: [
      { env_name: "XIAOBA_LLM_API_KEY", value: "live-secret-value" },
      { env_name: "XIAOBA_LLM_API_BASE", value: "https://provider.invalid/v1" },
    ],
  };

  writeSanitizedJson(destination, {
    command: 'XIAOBA_LLM_API_KEY="${XIAOBA_LLM_API_KEY}" XIAOBA_LLM_API_BASE="${XIAOBA_LLM_API_BASE}" node worker.js',
  }, context);

  const retained = fs.readFileSync(destination, "utf8");
  assert.equal(retained.includes("live-secret-value"), false);
  assert.equal(retained.includes('XIAOBA_LLM_API_KEY=\\"${XIAOBA_LLM_API_KEY}'), false);
  assert.equal(retained.includes('XIAOBA_LLM_API_BASE=\\"${XIAOBA_LLM_API_BASE}'), false);
  assert.match(retained, /\[REDACTED\]/);
  assert.equal(scanRetainedTreeForSecrets(root, context).status, "pass");
});

test("provider identity claims are revalidated from sanitized retained evidence", async () => {
  const fixture = makeNativeFixture("barena-sanitized-claims-");
  const request = minimalLiveRequest(fixture);
  const policy = livePolicy();
  const providerAlsoUsedAsCredential = policy.provider;

  const result = await runXiaoBaNativeEvaluation({
    request,
    runs_root: fixture.runsRoot,
    live_policy_binding: bindXiaoBaLivePolicy(policy),
  }, {
    environment: {
      PATH: process.env.PATH,
      FAKE_PROVIDER_KEY: providerAlsoUsedAsCredential,
      FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
    },
  });
  const nativeRefs = [...result.baseline.attempts, ...result.candidate.attempts]
    .flatMap((attempt) => attempt.refs.native);

  assert.equal(nativeRefs.length > 0, true);
  assert.equal(nativeRefs.every((ref) => !fs.readFileSync(ref, "utf8").includes(providerAlsoUsedAsCredential)), true);
  assert.notEqual(result.provider_identity?.status, "verified");
  assert.equal(result.quality.required_evidence_complete, false);
});

test("catalog health requires a complete, valid result package marker", async (t) => {
  await t.test("missing marker is partial", () => {
    const fixture = writeCatalogPackage("missing-marker", { marker: "missing", reportMarkdown: true });
    assert.equal(catalogHealth(fixture.runsRoot, fixture.runId), "partial");
  });

  await t.test("complete marker and companion package is healthy", () => {
    const fixture = writeCatalogPackage("complete-marker", { marker: "complete", reportMarkdown: true });
    assert.equal(catalogHealth(fixture.runsRoot, fixture.runId), "healthy");
  });

  await t.test("marker cannot bless a missing companion", () => {
    const fixture = writeCatalogPackage("missing-companion", { marker: "complete", reportMarkdown: false });
    assert.equal(catalogHealth(fixture.runsRoot, fixture.runId), "partial");
  });
});

function makeNativeFixture(prefix: string): { root: string; projectRoot: string; runsRoot: string } {
  const root = tempRoot(prefix);
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
  return { root, projectRoot, runsRoot: path.join(root, "runs") };
}

function nativeRequest(
  fixture: ReturnType<typeof makeNativeFixture>,
  binaryPath = fakeXiaoBa
): XiaoBaCapabilityEvaluationRequestV1 {
  return createXiaoBaNativeSkillRequest({
    roleId: "inherit-base-role",
    skillPath,
    casePaths: [skillCase],
    attemptsPerArm: 1,
    binaryPath,
    projectRoot: fixture.projectRoot,
    rolesRoot,
    passEnv: [],
  });
}

function minimalLiveRequest(fixture: ReturnType<typeof makeNativeFixture>): XiaoBaCapabilityEvaluationRequestV1 {
  const request = nativeRequest(fixture);
  request.cases[0] = {
    ...request.cases[0],
    max_turns: 1,
    replay_attempts: 1,
    max_replay_cases: 1,
    timeout_ms: 5_000,
  };
  return request;
}

function livePolicy(): XiaoBaLivePolicyV1 {
  const verifiedAt = new Date().toISOString();
  return {
    schema: "barena.live_policy.v1",
    provider: "fixture-provider",
    model: "fixture-model",
    credential_env: "FAKE_PROVIDER_KEY",
    api_base_env: "FAKE_PROVIDER_BASE",
    max_input_tokens: 1_000,
    max_output_tokens: 100,
    max_provider_calls: 10,
    pricing: {
      provider: "fixture-provider",
      model: "fixture-model",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      input_usd_per_million_tokens: 1,
      output_usd_per_million_tokens: 2,
      source: "fixture-price-card",
      sourced_at: verifiedAt,
    },
    budget_usd: 5,
    worst_case_usd: 0.02,
    hard_limit: {
      mode: "prepaid_balance",
      verified: true,
      reference: "fixture-hard-limit",
      verified_at: verifiedAt,
      provider: "fixture-provider",
      credential_env: "FAKE_PROVIDER_KEY",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      cap_usd: 5,
    },
    accepted_scan_finding_ids: [],
    retention: { profile: "private-beta-test" },
    redaction: {
      profile: "exact-secret-and-structured-fields",
      secret_env_names: [],
    },
  };
}

function liveEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    FAKE_PROVIDER_KEY: "fixture-provider-key",
    FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
  };
}

function writePatchedFakeXiaoBa(root: string): string {
  const source = fs.readFileSync(fakeXiaoBa, "utf8");
  const original = "new Set([\"invalid_trace\", \"missing_trace\", \"unsafe\", \"blocked\", \"unstable\", \"sandbox_not_enforced\", \"stale\", \"collision\"])";
  const replacement = "new Set([\"invalid_trace\", \"missing_trace\", \"unsafe\", \"blocked\", \"unstable\", \"sandbox_not_enforced\", \"stale\", \"collision\", \"symlink_escape\", \"artifact_symlink_escape\", \"binary_evidence_secret\"])";
  const usercatWrite = "  writeJson(usercatPackagePath, { version: 1, run_id: `${contractRunId}-usercat-1`, status: behavior === \"blocked\" ? \"blocked\" : \"pass\", trace_path: nativeTraceRef });";
  const binaryEvidenceWrite = `${usercatWrite}\n  if (behavior === \"binary_evidence_secret\") {\n    fs.writeFileSync(usercatPackagePath, Buffer.concat([Buffer.from([0]), Buffer.from(process.env.TEST_RETENTION_SECRET || \"missing-secret\")]));\n  }`;
  assert.equal(source.includes(original), true, "fake XiaoBa fixture behavior list changed");
  assert.equal(source.includes(usercatWrite), true, "fake XiaoBa usercat package writer changed");
  const binaryPath = path.join(root, "fake-xiaoba-adversarial.mjs");
  fs.writeFileSync(binaryPath, source.replace(original, replacement).replace(usercatWrite, binaryEvidenceWrite), "utf8");
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function retainedAttemptRefs(attempt: XiaoBaNativeAttemptResult): string[] {
  return [
    attempt.refs.boundary_trace,
    attempt.refs.request_manifest,
    attempt.refs.role_manifest,
    attempt.refs.subject_manifest,
    attempt.refs.clean_runtime,
    attempt.refs.arena_runner,
    attempt.refs.arena_scorecard,
    attempt.refs.arena_run,
    attempt.refs.verifier,
    ...attempt.refs.native,
    ...attempt.refs.evaluator,
    ...attempt.refs.debug,
  ].filter((ref): ref is string => typeof ref === "string" && path.isAbsolute(ref));
}

function filesContaining(root: string, value: string): string[] {
  if (!fs.existsSync(root)) return [];
  return walkFiles(root).filter((filePath) => fs.readFileSync(filePath).includes(Buffer.from(value)));
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
    else if (entry.isSymbolicLink()) throw new Error(`Retained test tree contains a symlink: ${fullPath}`);
  }
  return files.sort();
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeCatalogPackage(
  name: string,
  options: { marker: "missing" | "complete"; reportMarkdown: boolean }
): { runsRoot: string; runId: string } {
  const root = tempRoot(`barena-catalog-package-${name}-`);
  const runsRoot = path.join(root, "runs");
  const runId = name;
  const runRoot = path.join(runsRoot, runId);
  const resultRef = path.join(runRoot, "capability-evaluation.json");
  const reportJsonRef = path.join(runRoot, "reports", "report.json");
  const reportMarkdownRef = path.join(runRoot, "reports", "report.md");
  const policyRef = path.join(runRoot, "preflight", "live-policy.json");
  const result = completeNativeResult(runId);

  writeJson(resultRef, result);
  writeJson(reportJsonRef, result);
  if (options.reportMarkdown) {
    fs.mkdirSync(path.dirname(reportMarkdownRef), { recursive: true });
    fs.writeFileSync(reportMarkdownRef, "# Complete fixture report\n", "utf8");
  }
  writeJson(policyRef, { schema: "barena.xiaoba_live_preflight.v1", status: "ready" });

  if (options.marker === "complete") {
    const files = [resultRef, reportJsonRef, reportMarkdownRef, policyRef].map((fileRef) => ({
      ref: path.relative(runRoot, fileRef),
      sha256: fs.existsSync(fileRef) ? sha256File(fileRef) : "0".repeat(64),
    }));
    writeJson(path.join(runRoot, "package-manifest.json"), {
      schema: "barena.result_package.v1",
      status: "complete",
      result_ref: "capability-evaluation.json",
      files,
    });
  }
  return { runsRoot, runId };
}

function completeNativeResult(evaluationId: string): Record<string, unknown> {
  const emptyArm = {
    selection: {
      mode: "role",
      role: { role_id: "fixture-role", source_path: "inputs/fixture-role", fingerprint: "a".repeat(64) },
    },
    counts: { planned: 1, pass: 0, fail: 0, blocked: 1, unsafe: 0 },
    pass_rate: { numerator: 0, denominator: 0, value: null },
    stability: "blocked",
    evidence_complete: false,
    attempts: [],
  };
  return {
    schema: "barena.xiaoba_capability_evaluation_result.v1",
    evaluation_id: evaluationId,
    created_at: "2026-07-17T00:00:00.000Z",
    request_ref: "evaluation-request.json",
    package_manifest_ref: "package-manifest.json",
    capability_kind: "role",
    decision: "held",
    reason_code: "evidence_incomplete",
    summary: "Fixture package result.",
    probe: {
      status: "blocked",
      binary_path: "fixture-xiaoba",
      project_root: "fixture-project",
      expected_version: "0.1.1",
      capabilities: {},
      checks: [],
      detail: "fixture",
    },
    outcome_truth: { status: "unverified", verifier_backed_attempts: 0, total_planned_attempts: 2 },
    effectiveness: {
      status: "unavailable",
      baseline_pass_rate: { numerator: 0, denominator: 0, value: null },
      candidate_pass_rate: { numerator: 0, denominator: 0, value: null },
      observed_lift: null,
    },
    quality: {
      baseline: "blocked",
      candidate: "blocked",
      required_evidence_complete: false,
      evaluator_stages_are_independent_agent_sessions: false,
      three_evaluator_agent_sessions: false,
      isolation: {},
    },
    baseline: emptyArm,
    candidate: emptyArm,
    evidence_refs: ["preflight/live-policy.json"],
    debug_refs: [],
  };
}

function catalogHealth(runsRoot: string, runId: string): string | undefined {
  return listRunCatalog(runsRoot).find((summary) => summary.run_id === runId)?.health;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
