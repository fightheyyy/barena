import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindXiaoBaLivePolicy,
  evaluateXiaoBaLivePreflight,
  loadXiaoBaLivePolicy,
  validateXiaoBaLivePolicy,
  XiaoBaLivePolicyValidationError,
} from "../src/evaluation/live-policy";
import type {
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaLivePolicyBinding,
  XiaoBaLivePolicyPreflight,
  XiaoBaLivePolicyV1,
  XiaoBaLiveRuntimeContractV1,
  XiaoBaProviderCallComponent,
} from "../src/evaluation/xiaoba-native-types";

const repoRoot = path.resolve(__dirname, "..");
const fakeXiaoBa = path.join(repoRoot, "test", "fixtures", "targets", "fake-xiaoba-native.mjs");
const FIXED_NOW = new Date("2026-07-18T12:00:00.000Z");

const FUTURE_LIVE_RUNTIME_CONTRACT: XiaoBaLiveRuntimeContractV1 = {
  schema: "barena.xiaoba_live_runtime_contract.v1",
  xiaoba_version: "0.2.0",
  composite_call_contract: "barena.xiaoba_composite_calls.v1",
  provider_call_record_schema: "barena.provider_call.v1",
  bounds: {
    target_calls_per_turn: 1,
    usercat_calls_per_turn: 1,
    inspector_calls_per_attempt: 0,
    reviewer_calls_per_attempt: 0,
    replay_calls_per_case_turn: 1,
  },
  enforcement: {
    input_token_limit: true,
    output_token_limit: true,
    sdk_max_retries: 0,
    authoritative_per_call_telemetry: true,
    complete_provider_identity: true,
    complete_cost_basis: true,
  },
};

interface ProviderCallRecordFixture {
  schema: string;
  call_id: string;
  arm: "baseline" | "candidate";
  case_id: string;
  attempt: number;
  component: XiaoBaProviderCallComponent;
  provider?: string;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  requested_output_limit: number;
  configured_max_retries: number;
  observed_retries: number;
  estimated_cost_usd: number;
  billed_cost_usd: number | null;
  evidence_ref: string;
}

test("live policy loading binds one source read to exact and canonical hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-live-policy-binding-"));
  const policyPath = path.join(root, "policy.json");
  const equivalentPath = path.join(root, "equivalent-policy.json");
  const policy = livePolicy();
  const sourceText = `${JSON.stringify(reverseObjectKeys(policy), null, 2)}\n`;
  const equivalentText = JSON.stringify(policy);
  const changedPolicy = clonePolicy(policy);
  changedPolicy.provider = "changed-after-first-read";
  changedPolicy.pricing.provider = changedPolicy.provider;
  changedPolicy.hard_limit.provider = changedPolicy.provider;
  fs.writeFileSync(policyPath, sourceText, "utf8");
  fs.writeFileSync(equivalentPath, equivalentText, "utf8");

  const originalReadFileSync = fs.readFileSync;
  const untypedReadFileSync = originalReadFileSync as unknown as (...args: unknown[]) => unknown;
  let policyReads = 0;
  Object.defineProperty(fs, "readFileSync", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): unknown => {
      const value = untypedReadFileSync(...args);
      const file = args[0];
      if (typeof file !== "number" && path.resolve(String(file)) === policyPath) {
        policyReads += 1;
        if (policyReads === 1) {
          fs.writeFileSync(policyPath, JSON.stringify(changedPolicy), "utf8");
        }
      }
      return value;
    },
  });

  let loaded: XiaoBaLivePolicyBinding;
  try {
    loaded = loadXiaoBaLivePolicy(policyPath) as unknown as XiaoBaLivePolicyBinding;
  } finally {
    Object.defineProperty(fs, "readFileSync", {
      configurable: true,
      writable: true,
      value: originalReadFileSync,
    });
  }
  const equivalent = loadXiaoBaLivePolicy(equivalentPath) as unknown as XiaoBaLivePolicyBinding;

  assert.equal(policyReads, 1, "policy source must be read exactly once before parse and hashing");
  assert.equal(loaded.schema, "barena.loaded_live_policy.v1");
  assert.equal(loaded.policy_ref, policyPath);
  assert.equal(loaded.source_text, sourceText);
  assert.equal(loaded.source_sha256, sha256(sourceText));
  assert.notEqual(loaded.source_sha256, equivalent.source_sha256, "formatting changes exact source identity");
  assert.equal(loaded.canonical_sha256, equivalent.canonical_sha256, "equivalent policies share canonical identity");
  assert.deepEqual(loaded.policy, equivalent.policy);
});

test("live policy rejects zero and negative token prices", async (t) => {
  for (const field of ["input_usd_per_million_tokens", "output_usd_per_million_tokens"] as const) {
    for (const value of [0, -0.000001]) {
      await t.test(`${field}=${value}`, () => {
        const policy = livePolicy();
        policy.pricing[field] = value;
        assertPolicyValidationRejected(policy);
      });
    }
  }
});

test("pricing and hard-limit evidence are bound to the selected provider scope", async (t) => {
  const mutations: Array<{ name: string; mutate: (policy: XiaoBaLivePolicyV1) => void }> = [
    { name: "pricing provider", mutate: (policy) => { policy.pricing.provider = "other-provider"; } },
    { name: "pricing model", mutate: (policy) => { policy.pricing.model = "other-model"; } },
    { name: "pricing API base", mutate: (policy) => { policy.pricing.api_base_env = "OTHER_API_BASE"; } },
    { name: "pricing currency", mutate: (policy) => { policy.pricing.currency = "EUR" as "USD"; } },
    { name: "hard-limit provider", mutate: (policy) => { policy.hard_limit.provider = "other-provider"; } },
    { name: "hard-limit credential", mutate: (policy) => { policy.hard_limit.credential_env = "OTHER_API_KEY"; } },
    { name: "hard-limit API base", mutate: (policy) => { policy.hard_limit.api_base_env = "OTHER_API_BASE"; } },
    { name: "hard-limit currency", mutate: (policy) => { policy.hard_limit.currency = "EUR" as "USD"; } },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      const policy = livePolicy();
      mutation.mutate(policy);
      assertPolicyValidationRejected(policy);
    });
  }
});

test("future and stale pricing or hard-limit evidence hold preflight", async (t) => {
  const cases: Array<{
    name: string;
    reason: "live_pricing_stale" | "live_hard_limit_stale";
    mutate: (policy: XiaoBaLivePolicyV1) => void;
  }> = [
    {
      name: "future pricing evidence",
      reason: "live_pricing_stale",
      mutate: (policy) => { policy.pricing.sourced_at = "2126-07-18T12:00:00.000Z"; },
    },
    {
      name: "stale pricing evidence",
      reason: "live_pricing_stale",
      mutate: (policy) => { policy.pricing.sourced_at = "2000-01-01T00:00:00.000Z"; },
    },
    {
      name: "future hard-limit evidence",
      reason: "live_hard_limit_stale",
      mutate: (policy) => { policy.hard_limit.verified_at = "2126-07-18T12:00:00.000Z"; },
    },
    {
      name: "stale hard-limit evidence",
      reason: "live_hard_limit_stale",
      mutate: (policy) => { policy.hard_limit.verified_at = "2000-01-01T00:00:00.000Z"; },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const policy = livePolicy();
      item.mutate(policy);
      const result = evaluateAt(policy, FIXED_NOW);
      assert.equal(result.status, "held");
      assert.equal(result.ready_to_invoke, false);
      assert.equal(result.model_invoked, false);
      assert.equal(result.reason_code, item.reason);
    });
  }
});

test("budget chain requires calculated <= declared <= hard cap <= budget", async (t) => {
  await t.test("valid chain is ready", () => {
    const result = evaluateAt(livePolicy(), FIXED_NOW);
    assert.equal(result.ready_to_invoke, true);
    assert.equal(result.budget.calculated_worst_case_usd, 0.018);
    assert.equal(result.budget.declared_worst_case_usd, 0.03);
    assert.equal(result.budget.hard_limit.cap_usd, 0.04);
    assert.equal(result.budget.budget_usd, 0.05);
  });

  const violations: Array<{
    name: string;
    reason: "live_worst_case_understated" | "live_budget_exceeded";
    mutate: (policy: XiaoBaLivePolicyV1) => void;
  }> = [
    {
      name: "declared worst case below calculation",
      reason: "live_worst_case_understated",
      mutate: (policy) => { policy.worst_case_usd = 0.017; },
    },
    {
      name: "hard cap below declared worst case",
      reason: "live_budget_exceeded",
      mutate: (policy) => { policy.hard_limit.cap_usd = 0.02; },
    },
    {
      name: "hard cap above approved budget",
      reason: "live_budget_exceeded",
      mutate: (policy) => { policy.hard_limit.cap_usd = 0.06; },
    },
  ];

  for (const violation of violations) {
    await t.test(violation.name, () => {
      const policy = livePolicy();
      violation.mutate(policy);
      const result = evaluateAt(policy, FIXED_NOW);
      assert.equal(result.status, "held");
      assert.equal(result.reason_code, violation.reason);
    });
  }
});

test("provider-call reservation is distinct from Barena arm attempts", () => {
  const ready = evaluateAt(livePolicy(), FIXED_NOW);
  assert.equal(ready.budget.planned_barena_attempts, 2);
  assert.equal(ready.budget.planned_provider_calls, 6);
  assert.deepEqual(ready.budget.planned_calls_by_component, {
    target: 2,
    usercat: 2,
    inspector: 0,
    reviewer: 0,
    replay: 2,
  });
  assert.equal(ready.ready_to_invoke, true);

  const attemptSizedReservation = livePolicy();
  attemptSizedReservation.max_provider_calls = 2;
  const held = evaluateAt(attemptSizedReservation, FIXED_NOW);
  assert.equal(held.budget.planned_barena_attempts, 2);
  assert.equal(held.budget.planned_provider_calls, 6);
  assert.equal(held.status, "held");
  assert.equal(held.reason_code, "live_provider_call_limit_insufficient");
});

test("future-contract simulator probe is credential-free and machine-readable", () => {
  const result = spawnSync(process.execPath, [fakeXiaoBa, "arena", "live-contract", "--json"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), FUTURE_LIVE_RUNTIME_CONTRACT);
});

test("fake XiaoBa emits deterministic component provider-call telemetry and adversarial switches", async (t) => {
  const fixture = fakeProject();

  await t.test("default records", () => {
    const run = executeFake(fixture, "pass", "barena-eval-baseline-case-one-1-a1");
    assert.equal(run.scorecard.decision, "pass");
    assert.deepEqual(run.records.map((record) => record.component), [
      "target",
      "usercat",
      "replay",
    ]);
    assert.equal(run.records.every((record) => record.schema === "barena.provider_call.v1"), true);
    assert.equal(run.records.every((record) => record.arm === "baseline"), true);
    assert.equal(run.records.every((record) => record.case_id === "case-one"), true);
    assert.equal(run.records.every((record) => record.attempt === 1), true);
    assert.equal(run.records.every((record) => record.provider === "fixture-provider"), true);
    assert.equal(run.records.every((record) => record.model === "fixture-model"), true);
    assert.equal(new Set(run.records.map((record) => record.call_id)).size, 3);
    assert.equal(run.scorecard.debug_refs.provider_calls, run.providerCallsRef);
  });

  await t.test("missing identity", () => {
    const run = executeFake(fixture, "missing_identity", "barena-eval-baseline-case-one-1-a2");
    assert.equal(run.records.every((record) => record.provider === undefined && record.model === undefined), true);
  });

  await t.test("mismatched identity", () => {
    const run = executeFake(fixture, "mismatched_identity", "barena-eval-baseline-case-one-1-a3");
    assert.equal(run.records.every((record) => record.provider === "fixture-provider-mismatch"), true);
    assert.equal(run.records.every((record) => record.model === "fixture-model-mismatch"), true);
  });

  await t.test("paid retries", () => {
    const run = executeFake(fixture, "retries", "barena-eval-baseline-case-one-1-a4");
    assert.equal(run.records.every((record) => record.configured_max_retries === 1), true);
    assert.equal(run.records.every((record) => record.observed_retries === 1), true);
  });

  await t.test("missing evaluator telemetry", () => {
    const run = executeFake(fixture, "missing_evaluator_telemetry", "barena-eval-baseline-case-one-1-a5");
    assert.deepEqual(run.records.map((record) => record.component), ["target"]);
  });

  await t.test("duplicate call records", () => {
    const run = executeFake(fixture, "duplicate_calls", "barena-eval-baseline-case-one-1-a6");
    assert.equal(run.records.length, 4);
    assert.equal(new Set(run.records.map((record) => record.call_id)).size, 3);
  });

  await t.test("per-call token overrun", () => {
    const run = executeFake(fixture, "per_call_token_overrun", "barena-eval-baseline-case-one-1-a7");
    const target = run.records.find((record) => record.component === "target");
    assert.ok(target);
    assert.equal(target.output_tokens, 11);
    assert.equal(target.requested_output_limit, 10);
  });

  await t.test("reservation overrun", () => {
    const run = executeFake(fixture, "reservation_overrun", "barena-eval-baseline-case-one-1-a8");
    assert.equal(run.records.length, 4);
    assert.equal(new Set(run.records.map((record) => record.call_id)).size, 4);
    assert.equal(run.records.filter((record) => record.component === "target").length, 2);
  });

  await t.test("unsafe is scoped to the selected arm and attempt", () => {
    const selected = {
      FAKE_XIAOBA_SELECTED_ARM: "candidate",
      FAKE_XIAOBA_SELECTED_ATTEMPT: "2",
    };
    assert.equal(executeFake(fixture, "selected_unsafe", "barena-eval-baseline-case-one-2-b1", selected).scorecard.decision, "pass");
    assert.equal(executeFake(fixture, "selected_unsafe", "barena-eval-candidate-case-one-1-b2", selected).scorecard.decision, "pass");
    assert.equal(executeFake(fixture, "selected_unsafe", "barena-eval-candidate-case-one-2-b3", selected).scorecard.decision, "unsafe");
  });

  await t.test("blocked is scoped to the selected arm and attempt", () => {
    const selected = {
      FAKE_XIAOBA_SELECTED_ARM: "baseline",
      FAKE_XIAOBA_SELECTED_ATTEMPT: "1",
    };
    assert.equal(executeFake(fixture, "selected_blocked", "barena-eval-candidate-case-one-1-c1", selected).scorecard.decision, "pass");
    assert.equal(executeFake(fixture, "selected_blocked", "barena-eval-baseline-case-one-1-c2", selected).scorecard.decision, "blocked");
  });
});

function livePolicy(): XiaoBaLivePolicyV1 {
  return {
    schema: "barena.live_policy.v1",
    provider: "fixture-provider",
    model: "fixture-model",
    credential_env: "FAKE_PROVIDER_KEY",
    api_base_env: "FAKE_PROVIDER_BASE",
    max_input_tokens: 1000,
    max_output_tokens: 1000,
    max_provider_calls: 10,
    pricing: {
      provider: "fixture-provider",
      model: "fixture-model",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      input_usd_per_million_tokens: 1,
      output_usd_per_million_tokens: 2,
      source: "fixture-price-card",
      sourced_at: FIXED_NOW.toISOString(),
    },
    budget_usd: 0.05,
    worst_case_usd: 0.03,
    hard_limit: {
      mode: "prepaid_balance",
      verified: true,
      reference: "fixture-hard-limit",
      verified_at: FIXED_NOW.toISOString(),
      provider: "fixture-provider",
      credential_env: "FAKE_PROVIDER_KEY",
      api_base_env: "FAKE_PROVIDER_BASE",
      currency: "USD",
      cap_usd: 0.04,
    },
    accepted_scan_finding_ids: [],
    retention: { profile: "private-beta-test" },
    redaction: {
      profile: "exact-secret-and-structured-fields",
      secret_env_names: [],
      structured_field_names: [],
    },
  };
}

function liveRequest(): XiaoBaCapabilityEvaluationRequestV1 {
  return {
    schema: "barena.xiaoba_capability_evaluation_request.v1",
    evaluation_id: "live-policy-unit",
    created_at: FIXED_NOW.toISOString(),
    target_runtime: "xiaoba",
    evaluator_runtime: "xiaoba-cli",
    capability_kind: "role",
    xiaoba: {
      binary_path: fakeXiaoBa,
      project_root: repoRoot,
      expected_version: "0.1.1",
      pass_env: [],
    },
    baseline: {
      mode: "role",
      role: { role_id: "baseline-role", source_path: repoRoot, fingerprint: "baseline" },
    },
    candidate: {
      mode: "role",
      role: { role_id: "candidate-role", source_path: repoRoot, fingerprint: "candidate" },
    },
    cases: [{
      schema: "barena.xiaoba_native_case.v1",
      case_id: "case-one",
      purpose: "safety",
      task: { prompt: "credential-free preflight" },
      assertions: { artifacts: [] },
      max_turns: 1,
      replay_attempts: 1,
      max_replay_cases: 1,
    }],
    attempts_per_arm: 1,
  };
}

function evaluateAt(policy: XiaoBaLivePolicyV1, now: Date): XiaoBaLivePolicyPreflight {
  return evaluateXiaoBaLivePreflight({
    binding: bindXiaoBaLivePolicy(policy, "/fixture/live-policy.json"),
    request: liveRequest(),
    environment: {
      FAKE_PROVIDER_KEY: "credential-present",
      FAKE_PROVIDER_BASE: "https://provider.invalid/v1",
    },
    runtime_contract: FUTURE_LIVE_RUNTIME_CONTRACT,
    runtime_contract_ref: "/fixture/live-runtime-contract.json",
    now: new Date(now),
  });
}

function assertPolicyValidationRejected(policy: XiaoBaLivePolicyV1): void {
  assert.throws(
    () => validateXiaoBaLivePolicy(policy),
    (error: unknown) => error instanceof XiaoBaLivePolicyValidationError
  );
}

function clonePolicy(policy: XiaoBaLivePolicyV1): XiaoBaLivePolicyV1 {
  return JSON.parse(JSON.stringify(policy)) as XiaoBaLivePolicyV1;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)])
  );
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function fakeProject(): { root: string; subjectId: string; roleId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-fake-live-runtime-"));
  const roleId = "fixture-role";
  const subjectId = "fixture-role-subject";
  const roleRoot = path.join(root, "roles", roleId);
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "role.json"), `${JSON.stringify({ name: roleId })}\n`, "utf8");
  const manifestPath = path.join(root, "arena", "subjects", subjectId, "arena-manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 1,
    subject_id: subjectId,
    subject: { type: "role", name: roleId },
    source: { type: "local_role", path: path.relative(root, roleRoot) },
  }, null, 2)}\n`, "utf8");
  return { root, subjectId, roleId };
}

function executeFake(
  fixture: { root: string; subjectId: string; roleId: string },
  behavior: string,
  runId: string,
  selected: NodeJS.ProcessEnv = {}
): {
  scorecard: { decision: string; debug_refs: { provider_calls: string } };
  records: ProviderCallRecordFixture[];
  providerCallsRef: string;
} {
  const result = spawnSync(process.execPath, [
    fakeXiaoBa,
    "arena", "run", "execute",
    "--mode", "role",
    "--subject", fixture.subjectId,
    "--target-role", fixture.roleId,
    "--run-id", runId,
    "--scenario", "fixture live runtime contract",
    "--replay-attempts", "1",
    "--max-replay-cases", "1",
  ], {
    cwd: fixture.root,
    env: {
      PATH: process.env.PATH ?? "",
      XIAOBA_PROJECT_ROOT: fixture.root,
      XIAOBA_ROLES_ROOT: path.join(fixture.root, "roles"),
      XIAOBA_LLM_PROVIDER: "fixture-provider",
      XIAOBA_LLM_MODEL: "fixture-model",
      XIAOBA_LLM_MAX_TOKENS: "10",
      FAKE_XIAOBA_BEHAVIOR: behavior,
      ...selected,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const scorecard = JSON.parse(result.stdout) as { decision: string; debug_refs: { provider_calls: string } };
  const providerCallsRef = scorecard.debug_refs.provider_calls;
  const providerCallsPath = path.resolve(fixture.root, providerCallsRef);
  const records = fs.readFileSync(providerCallsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderCallRecordFixture);
  return { scorecard, records, providerCallsRef };
}
