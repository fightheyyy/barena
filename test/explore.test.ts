import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/main";
import { createAdHocExploreScenario, runExploreScenario } from "../src/explore";
import type { ExploreProgressEvent } from "../src/explore";
import { userSimulatorPrompt } from "../src/explore/prompts";
import {
  XiaobaOSRuntimeAdapter,
  listXiaobaSkills,
  listXiaobaTargetProfiles,
} from "../src/runtime-adapters";
import { readNdjson } from "../src/utils/fs";

const FIXTURES = path.resolve(__dirname, "fixtures");
const FAKE_XIAOBA = path.join(FIXTURES, "targets", "fake-xiaoba-explore.mjs");
const XIAOBA_PROJECT = path.join(FIXTURES, "explore", "xiaoba-project");
const ROLES_ROOT = path.join(XIAOBA_PROJECT, "roles");
const SKILLS_ROOT = path.join(XIAOBA_PROJECT, "skills");

test("XiaoBaOS discovery exposes explicit Base and installed Skills", () => {
  const profiles = listXiaobaTargetProfiles(ROLES_ROOT);
  assert.equal(profiles[0].id, "base");
  assert.equal(profiles[0].base_profile, true);
  const skills = listXiaobaSkills(SKILLS_ROOT, profiles);
  assert.ok(skills.some((skill) => skill.id === "planning"));
});

test("UserCat prompt stays in a Scenario-style user role instead of judging evidence", () => {
  const scenario = createAdHocExploreScenario({
    role: "secretary-cat",
    task: "帮助一个表达含糊的用户排出今天的优先级。",
    max_turns: 6,
    timeout_ms: 10_000,
  });
  const prompt = userSimulatorPrompt({
    scenario,
    turn: 2,
    transcript: [
      {
        turn: 1,
        role: "user",
        actor: "user_simulator",
        content: "我今天事情有点乱",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
      {
        turn: 1,
        role: "assistant",
        actor: "target",
        content: "你今天有哪些必须完成的事情？",
        timestamp: "2026-07-28T00:00:01.000Z",
      },
    ],
  });

  assert.match(prompt, /你今天不是助手、测试工程师或评审员/);
  assert.match(prompt, /输入简短、只说当前必要的信息/);
  assert.match(prompt, /只有对方问到或对话确实需要时，才补充更多信息/);
  assert.match(prompt, /"speaker": "user"/);
  assert.match(prompt, /"speaker": "agent"/);
  assert.match(prompt, /用户需求已经得到满足.*才 action=stop/s);
  assert.doesNotMatch(prompt, /证据仍不足|验证一个新的真实边界|稳定成功或稳定失败/);
  assert.doesNotMatch(prompt, /"actor": "target"/);
});

test("Explore runs the real four-actor DAG through XiaoBaOS and decodes native OTLP", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const logPath = path.join(root, "xiaoba-argv.ndjson");
  const previousLog = process.env.FAKE_XIAOBA_LOG;
  const previousSecret = process.env.FAKE_XIAOBA_SECRET;
  process.env.FAKE_XIAOBA_LOG = logPath;
  process.env.FAKE_XIAOBA_SECRET = "TEST_ONLY_XIAOBA_SECRET_VALUE";
  t.after(() => restoreEnv("FAKE_XIAOBA_LOG", previousLog));
  t.after(() => restoreEnv("FAKE_XIAOBA_SECRET", previousSecret));

  const scenario = createAdHocExploreScenario({
    role: "secretary-cat",
    task: "帮助一个需求表达不完整的用户形成今天可执行的优先级计划。",
    max_turns: 4,
    timeout_ms: 10_000,
  });
  const progress: ExploreProgressEvent[] = [];
  const result = await runExploreScenario(scenario, {
    runs_root: path.join(root, "runs"),
    now: () => new Date("2026-07-27T10:00:00.000Z"),
    on_progress: (event) => {
      progress.push(event);
    },
    xiaoba: {
      command: FAKE_XIAOBA,
      project_root: XIAOBA_PROJECT,
      roles_root: ROLES_ROOT,
      skills_root: SKILLS_ROOT,
      env_allowlist: ["FAKE_XIAOBA_LOG", "FAKE_XIAOBA_SECRET"],
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.turns.filter((turn) => turn.target).length, 2);
  assert.equal(result.evidence.evidence_complete, true);
  assert.equal(result.evidence.native_otlp_envelopes, 7);
  assert.equal(result.evidence.native_otlp_spans, 7);
  assert.ok(result.evidence.secret_redaction.occurrences >= 1);
  assert.ok(
    result.evidence.secret_redaction.files.some((file) =>
      file.endsWith("secret-fixture.txt")
    )
  );
  assert.equal(
    directoryContains(
      result.paths.run_root,
      Buffer.from("TEST_ONLY_XIAOBA_SECRET_VALUE")
    ),
    false
  );
  assert.equal(result.inspector.status, "completed");
  assert.equal(result.reviewer.status, "completed");
  assert.equal(
    result.reviewer.status === "completed"
      ? result.reviewer.output.scores.task_success
      : 0,
    0.9
  );
  assert.ok(result.evidence.workspace_changes.some((change) => change.path === "plan.md"));
  assert.ok(fs.existsSync(result.paths.report_markdown));

  const spans = readNdjson<{
    name: string;
    trace_id: string;
    span_id: string;
    resource_attributes: Record<string, unknown>;
    invocation?: { stage?: string };
  }>(result.evidence.otlp_spans);
  assert.equal(spans.length, 7);
  assert.ok(spans.some((span) => span.invocation?.stage === "target"));
  assert.ok(spans.every((span) => span.trace_id.length === 32));
  assert.ok(spans.every((span) => span.span_id.length === 16));
  const boundary = readNdjson<{
    attempt_id: string;
    message: string;
    provenance: { observed_from: string };
  }>(result.evidence.boundary_trace);
  const inspectorInput = boundary.find(
    (event) =>
      event.attempt_id === "inspector" &&
      event.provenance.observed_from === "target_input"
  );
  assert.match(inspectorInput?.message ?? "", /xiaoba\.secretary-cat\.turn/);

  const invocations = readNdjson<string[]>(logPath);
  assert.ok(invocations.length >= 9); // version + help + seven Agent calls
  assert.ok(invocations.every((args) => !args.includes("arena")));
  const targetCalls = invocations.filter(
    (args) => args[0] === "chat" && valueAfter(args, "--role") === "secretary-cat"
  );
  assert.equal(targetCalls.length, 2);
  assert.match(
    valueAfter(targetCalls[1], "--message") ?? "",
    /我先按紧急程度给你一个初版/
  );
  assert.deepEqual(
    progress.map((event) => event.sequence),
    progress.map((_, index) => index + 1)
  );
  assert.ok(
    progress.some(
      (event) =>
        event.actor === "user_simulator" &&
        event.status === "completed" &&
        event.message?.includes("今天最应该做的三件事") &&
        event.reason?.includes("低信息量")
    )
  );
  assert.ok(
    progress.some(
      (event) =>
        event.actor === "target" &&
        event.status === "completed" &&
        event.message?.includes("确认今天硬截止")
    )
  );
  assert.ok(
    progress.some(
      (event) =>
        event.actor === "inspector" &&
        event.status === "completed" &&
        event.issue_count === 0
    )
  );
  assert.ok(
    progress.some(
      (event) =>
        event.actor === "reviewer" &&
        event.status === "completed" &&
        event.verdict === "pass"
    )
  );
  assert.equal(progress.at(-1)?.stage, "complete");
});

test("Explore fails closed and preserves raw evidence when Reviewer JSON is invalid", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const previous = process.env.FAKE_XIAOBA_INVALID_REVIEWER;
  process.env.FAKE_XIAOBA_INVALID_REVIEWER = "1";
  t.after(() => restoreEnv("FAKE_XIAOBA_INVALID_REVIEWER", previous));
  const result = await runExploreScenario(
    createAdHocExploreScenario({
      role: "secretary-cat",
      task: "测试一个含糊任务是否会得到可执行计划。",
      max_turns: 3,
      timeout_ms: 10_000,
      env_allowlist: ["FAKE_XIAOBA_INVALID_REVIEWER"],
    }),
    {
      runs_root: path.join(root, "runs"),
      on_progress: () => {
        throw new Error("broken optional observer");
      },
      xiaoba: {
        command: FAKE_XIAOBA,
        project_root: XIAOBA_PROJECT,
        roles_root: ROLES_ROOT,
        skills_root: SKILLS_ROOT,
        env_allowlist: ["FAKE_XIAOBA_INVALID_REVIEWER"],
      },
    }
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reviewer.status, "blocked");
  assert.equal(result.reason_code, "evaluator_protocol_error");
  assert.ok(
    result.reviewer.status === "blocked" &&
      result.reviewer.raw_ref &&
      fs.readFileSync(result.reviewer.raw_ref, "utf8").includes("not json")
  );
});

test("Explore records a blocked report when the selected XiaoBaOS Role is missing", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const result = await runExploreScenario(
    createAdHocExploreScenario({
      role: "missing-role",
      task: "This should stop at preflight.",
      max_turns: 1,
      timeout_ms: 10_000,
    }),
    {
      runs_root: path.join(root, "runs"),
      xiaoba: {
        command: FAKE_XIAOBA,
        project_root: XIAOBA_PROJECT,
        roles_root: ROLES_ROOT,
        skills_root: SKILLS_ROOT,
      },
    }
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.reason_code, "role_not_found");
  assert.equal(result.evidence.native_otlp_envelopes, 0);
  assert.ok(fs.existsSync(result.paths.report_json));
  assert.equal(path.dirname(path.dirname(result.paths.report_json)), result.paths.run_root);
});

test("Explore honors a Server-assigned run ID and cancels an active Runtime turn", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const previousDelay = process.env.FAKE_XIAOBA_DELAY_MS;
  process.env.FAKE_XIAOBA_DELAY_MS = "1000";
  t.after(() => restoreEnv("FAKE_XIAOBA_DELAY_MS", previousDelay));
  const abort = new AbortController();
  const pending = runExploreScenario(
    createAdHocExploreScenario({
      role: "secretary-cat",
      task: "取消一个正在执行的 Explore。",
      max_turns: 3,
      timeout_ms: 5_000,
      env_allowlist: ["FAKE_XIAOBA_DELAY_MS"],
    }),
    {
      runs_root: path.join(root, "runs"),
      run_id: "server-explore-cancel-001",
      signal: abort.signal,
      xiaoba: {
        command: FAKE_XIAOBA,
        project_root: XIAOBA_PROJECT,
        roles_root: ROLES_ROOT,
        skills_root: SKILLS_ROOT,
        env_allowlist: ["FAKE_XIAOBA_DELAY_MS"],
        kill_grace_ms: 25,
      },
    }
  );
  setTimeout(() => abort.abort("requested by test"), 250);
  const result = await pending;

  assert.equal(result.run_id, "server-explore-cancel-001");
  assert.equal(path.basename(result.paths.run_root), "server-explore-cancel-001");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason_code, "run_cancelled");
  assert.match(result.summary, /requested by test/);
  assert.equal(result.evidence.evidence_complete, false);
  assert.ok(fs.existsSync(result.paths.report_json));
});

test("non-interactive barena explore runs the same Scenario contract", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const previousLog = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  t.after(() => {
    console.log = previousLog;
  });
  const exit = await runCli([
    "explore",
    "--runtime",
    "xiaobaos",
    "--role",
    "secretary-cat",
    "--task",
    "帮助用户把含糊任务拆成可执行计划",
    "--max-turns",
    "3",
    "--timeout",
    "10000",
    "--xiaobaos-command",
    FAKE_XIAOBA,
    "--xiaobaos-project-root",
    XIAOBA_PROJECT,
    "--roles-root",
    ROLES_ROOT,
    "--runs-root",
    path.join(root, "runs"),
  ]);
  assert.equal(exit, 0);
  const summary = JSON.parse(lines.at(-1) ?? "{}") as {
    status?: string;
    role?: string;
    otlp?: { spans?: number };
    report?: string;
  };
  assert.equal(summary.status, "pass");
  assert.equal(summary.role, "secretary-cat");
  assert.equal(summary.otlp?.spans, 7);
  assert.ok(summary.report && fs.existsSync(summary.report));
});

test("XiaoBaOS Runtime sessions enforce timeout and explicit cancellation", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const logPath = path.join(root, "xiaoba-session-argv.ndjson");
  const previousDelay = process.env.FAKE_XIAOBA_DELAY_MS;
  const previousLog = process.env.FAKE_XIAOBA_LOG;
  process.env.FAKE_XIAOBA_DELAY_MS = "500";
  process.env.FAKE_XIAOBA_LOG = logPath;
  t.after(() => restoreEnv("FAKE_XIAOBA_DELAY_MS", previousDelay));
  t.after(() => restoreEnv("FAKE_XIAOBA_LOG", previousLog));
  const adapter = new XiaobaOSRuntimeAdapter({
    command: FAKE_XIAOBA,
    project_root: XIAOBA_PROJECT,
    roles_root: ROLES_ROOT,
    skills_root: SKILLS_ROOT,
    env_allowlist: ["FAKE_XIAOBA_DELAY_MS", "FAKE_XIAOBA_LOG"],
    kill_grace_ms: 25,
  });
  const timedSession = await adapter.openSession({
    run_id: "timeout-run",
    scenario_id: "timeout-scenario",
    attempt_id: "target",
    session_id: "timeout-session",
    thread_id: "timeout-thread",
    workspace: path.join(root, "timeout"),
    target: { role: "secretary-cat", env_allowlist: ["FAKE_XIAOBA_DELAY_MS"] },
  });
  const timed = await adapter.sendTurn(timedSession, {
    message: "timeout",
    timeout_ms: 50,
  });
  assert.equal(timed.status, "blocked");
  assert.equal(timed.reason_code, "turn_timeout");
  await adapter.close(timedSession);

  const cancelledSession = await adapter.openSession({
    run_id: "cancel-run",
    scenario_id: "cancel-scenario",
    attempt_id: "target",
    session_id: "cancel-session",
    thread_id: "cancel-thread",
    workspace: path.join(root, "cancel"),
    target: { role: "secretary-cat", env_allowlist: ["FAKE_XIAOBA_DELAY_MS"] },
  });
  const pending = adapter.sendTurn(cancelledSession, {
    message: "cancel",
    timeout_ms: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await adapter.cancel(cancelledSession, "test cancellation"), true);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reason_code, "turn_cancelled");
  await adapter.close(cancelledSession);

  const baseSession = await adapter.openSession({
    run_id: "base-run",
    scenario_id: "base-scenario",
    attempt_id: "target",
    session_id: "base-session",
    thread_id: "base-thread",
    workspace: path.join(root, "base"),
    target: {
      role: "base",
      skill: "planning",
      env_allowlist: ["FAKE_XIAOBA_DELAY_MS", "FAKE_XIAOBA_LOG"],
    },
  });
  const baseTurn = await adapter.sendTurn(baseSession, {
    message: "test the explicit Base profile",
    timeout_ms: 2_000,
  });
  assert.equal(baseTurn.status, "completed");
  await adapter.close(baseSession);
  const baseCall = readNdjson<string[]>(logPath).find(
    (args) => args[0] === "chat" && valueAfter(args, "--role") === "base"
  );
  assert.equal(valueAfter(baseCall ?? [], "--skill"), "planning");
});

function temporaryRoot(t: { after(callback: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-explore-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function directoryContains(root: string, needle: Buffer): boolean {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && directoryContains(candidate, needle)) return true;
    if (entry.isFile() && fs.readFileSync(candidate).indexOf(needle) >= 0) return true;
  }
  return false;
}
