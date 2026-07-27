import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { writeJson } from "../src/utils/fs";

interface PackageJson {
  name: string;
  version: string;
  bin: string | Record<string, string>;
}

interface CliResult extends SpawnSyncReturns<string> {
  status: number | null;
}

const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const fakeXiaoba = path.join(repoRoot, "test", "fixtures", "targets", "fake-xiaoba-chat.mjs");

test("private-beta contract suite runs from an isolated Git checkout", () => {
  const gitRoot = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  assert.equal(gitRoot.status, 0);
  assert.equal(path.resolve(gitRoot.stdout.trim()), repoRoot);
});

test("CLI maps cleared, held, rejected, and operational outcomes to exit codes 0, 1, 2, and 3", async (t) => {
  await t.test("cleared", () => assert.equal(
    importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "good-skill")).cli.status,
    0
  ));
  await t.test("held", () => assert.equal(
    importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "no-artifact-skill")).cli.status,
    1
  ));
  await t.test("rejected", () => assert.equal(
    importAndRunClearance(path.join(repoRoot, "test", "fixtures", "skills", "unsafe-skill")).cli.status,
    2
  ));
  await t.test("usage error", () => assert.equal(runPackageCli(["not-a-command"], tempRoot("barena-cli-error-")).status, 3));
});

test("requiring the package root is silent and does not initialize CLI state", () => {
  const cwd = tempRoot("barena-root-import-");
  const before = fs.readdirSync(cwd);
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(repoRoot)})`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readdirSync(cwd), before);
});

test("the package CLI resolves Barena's own version from a non-project CWD", () => {
  const cwd = tempRoot("barena-version-cwd-");
  writeJson(path.join(cwd, "package.json"), { name: "decoy", version: "9.9.9" });
  const result = runPackageCli(["--version"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), readJson<PackageJson>(packageJsonPath).version);
});

test("xiaobaos and xiaoba aliases probe only the ordinary chat target contract", () => {
  const canonical = runPackageCli([
    "e2e", "probe", "--target", "xiaobaos", "--xiaobaos-command", fakeXiaoba,
  ], repoRoot);
  const legacyAlias = runPackageCli([
    "e2e", "probe", "--target", "xiaoba", "--xiaoba-command", fakeXiaoba,
  ], repoRoot);
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(legacyAlias.status, 0, legacyAlias.stderr);
  const canonicalPayload = parseJson<Record<string, unknown>>(canonical.stdout);
  const aliasPayload = parseJson<Record<string, unknown>>(legacyAlias.stdout);
  assert.equal((canonicalPayload.target as Record<string, unknown>).component, "xiaoba-target");
  assert.deepEqual(canonicalPayload, aliasPayload);

  const conflict = runPackageCli([
    "e2e", "probe", "--target", "xiaobaos", "--xiaobaos-command", fakeXiaoba,
    "--xiaoba-command", path.join(repoRoot, "missing-xiaoba"),
  ], repoRoot);
  assert.equal(conflict.status, 3);
  assert.match(conflict.stderr, /must not conflict/);
});

test("packaged CLI completes paired XiaobaOS Skill evaluation without a native Arena contract", () => {
  const root = tempRoot("barena-xiaoba-cli-pair-");
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\nCreate result.txt.\n", "utf8");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "xiaoba-cli-pair",
    target: { adapter: "xiaoba", runtime: "xiaobaos", agent: "secretary-cat" },
    task: { prompt: "Create result.txt." },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });
  const result = runPackageCli([
    "evaluate", "skill", skillPath,
    "--target", "xiaobaos",
    "--case", casePath,
    "--xiaobaos-command", fakeXiaoba,
    "--attempts", "2",
    "--runs-root", path.join(root, "runs"),
  ], root);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson<Record<string, unknown>>(result.stdout);
  assert.equal(payload.decision, "cleared");
  assert.equal(payload.reason_code, "positive_lift");
  assert.equal((payload.effectiveness as Record<string, unknown>).observed_lift, 1);
});

test("legacy XiaobaOS native cases fail closed instead of falling back to Arena", () => {
  const root = tempRoot("barena-legacy-native-rejected-");
  const skillPath = path.join(root, "skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\n", "utf8");
  const nativeCase = path.join(root, "native-case.json");
  writeJson(nativeCase, {
    schema: "barena.xiaoba_native_case.v1",
    case_id: "legacy-native",
    purpose: "effectiveness",
    task: { prompt: "Do the task" },
    assertions: { artifacts: [{ path: "result.txt", exists: true }] },
  });
  const result = runPackageCli([
    "evaluate", "skill", skillPath, "--target", "xiaobaos", "--case", nativeCase,
    "--xiaobaos-command", fakeXiaoba,
  ], root);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /barena\.agent_e2e_case\.v1/);
});

test("run catalog keeps historical native results readable without making them executable", () => {
  const root = tempRoot("barena-run-catalog-");
  const runsRoot = path.join(root, "runs");
  writeJson(path.join(runsRoot, "legacy-native", "capability-evaluation.json"), {
    schema: "barena.xiaoba_capability_evaluation_result.v1",
    evaluation_id: "legacy-native",
    created_at: "2026-07-20T00:00:00.000Z",
    decision: "held",
    reason_code: "live_preflight_only",
    summary: "historical",
    request_ref: "request.json",
    outcome_truth: { status: "unverified", verifier_backed_attempts: 0, total_planned_attempts: 0 },
    effectiveness: {
      status: "unavailable",
      baseline_pass_rate: { numerator: 0, denominator: 0, value: null },
      candidate_pass_rate: { numerator: 0, denominator: 0, value: null },
      observed_lift: null,
    },
    quality: { baseline: "incomplete", candidate: "incomplete", required_evidence_complete: false },
    baseline: { selection: {}, attempts: [], counts: {}, pass_rate: {}, stability: "incomplete", evidence_complete: false },
    candidate: { selection: {}, attempts: [], counts: {}, pass_rate: {}, stability: "incomplete", evidence_complete: false },
    evidence_refs: [],
    debug_refs: [],
  });
  const result = runPackageCli(["list", "runs", "--runs-root", runsRoot], root);
  assert.equal(result.status, 0, result.stderr);
  const entries = parseJson<Array<Record<string, unknown>>>(result.stdout);
  assert.equal(entries[0].kind, "xiaoba_capability");
});

function importAndRunClearance(skillPath: string): { cli: CliResult; payload: Record<string, unknown> } {
  const root = tempRoot("barena-exit-code-");
  const subjectsRoot = path.join(root, "subjects");
  const runsRoot = path.join(root, "runs");
  const imported = runPackageCli(["import", "skill", skillPath, "--subjects-root", subjectsRoot], root);
  assert.equal(imported.status, 0, imported.stderr);
  const manifest = parseJson<{ subject_id: string }>(imported.stdout);
  const cli = runPackageCli([
    "run", manifest.subject_id, "--subjects-root", subjectsRoot, "--runs-root", runsRoot, "--replays", "1",
  ], root);
  return { cli, payload: parseJson<Record<string, unknown>>(cli.stdout) };
}

function runPackageCli(args: string[], cwd: string): CliResult {
  return spawnSync(process.execPath, [packageCliPath(), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  }) as CliResult;
}

function packageCliPath(): string {
  const packageJson = readJson<PackageJson>(packageJsonPath);
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin.barena;
  assert.equal(typeof bin, "string");
  return path.resolve(repoRoot, bin);
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
