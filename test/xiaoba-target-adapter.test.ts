import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentE2ECase } from "../src/e2e/case-runner";
import type { AgentE2ECaseV1 } from "../src/e2e/types";
import { runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { XiaobaTargetAdapter } from "../src/targets/xiaoba-target-adapter";
import { readNdjson, writeJson } from "../src/utils/fs";

const fakeXiaoba = path.resolve("test/fixtures/targets/fake-xiaoba-chat.mjs");

test("XiaobaOS Skill evaluation uses ordinary chat and never invokes XiaobaOS Arena", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-xiaoba-target-"));
  const logPath = path.join(root, "invocations.jsonl");
  const projectRoot = path.join(root, "xiaoba-project");
  const rolesRoot = path.join(projectRoot, "roles");
  const roleRoot = path.join(rolesRoot, "secretary-cat");
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "role.json"), JSON.stringify({ name: "secretary-cat", status: "active" }), "utf8");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\nCreate result.txt.\n", "utf8");
  const casePath = path.join(root, "case.json");
  const caseDefinition: AgentE2ECaseV1 = {
    schema: "barena.agent_e2e_case.v1",
    case_id: "xiaoba-ordinary-chat",
    target: { adapter: "xiaoba", runtime: "xiaobaos", agent: "secretary-cat" },
    task: { prompt: "Create the requested artifact." },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  };
  writeJson(casePath, caseDefinition);
  const adapter = new XiaobaTargetAdapter({
    command: process.execPath,
    baseArgs: [fakeXiaoba, "--invocation-log", logPath],
    projectRoot,
    rolesRoot,
  });

  const probe = await adapter.probe();
  assert.equal(probe.status, "ready");
  assert.equal(probe.component, "xiaoba-target");
  const result = await runSkillEvaluation({
    skillPath,
    targetId: "xiaobaos",
    cases: [casePath],
    attemptsPerArm: 2,
    runsRoot: path.join(root, "runs"),
    targetAdapter: adapter,
  });

  assert.equal(result.decision, "cleared");
  assert.equal(result.reason_code, "positive_lift");
  assert.equal(result.baseline.pass_rate.value, 0);
  assert.equal(result.candidate.pass_rate.value, 1);
  assert.equal(result.quality.target_native_trace_available, true);
  const invocations = readNdjson<{ args: string[]; cwd: string; env: Record<string, string | undefined> }>(logPath);
  assert.equal(invocations.length, 10);
  assert.equal(invocations.every((entry) => !entry.args.includes("arena")), true);
  const chats = invocations.filter((entry) => entry.args[0] === "chat" && !entry.args.includes("--help"));
  assert.equal(chats.length, 4);
  assert.equal(chats.filter((entry) => entry.args.includes("--skill")).length, 2);
  assert.equal(chats.filter((entry) => !entry.args.includes("--skill")).length, 2);
  assert.equal(chats.every((entry) => entry.env.project_root === projectRoot), true);
  assert.equal(chats.every((entry) => entry.env.roles_root === rolesRoot), true);
  assert.equal(new Set(chats.map((entry) => entry.cwd)).size, 4);
});

test("XiaobaOS target adapter rejects Arena in injected base arguments", () => {
  assert.throws(
    () => new XiaobaTargetAdapter({ command: process.execPath, baseArgs: [fakeXiaoba, "arena"] }),
    /may not invoke XiaobaOS Arena/
  );
});

test("cloud-configured XiaobaOS adapter rejects Case requests outside the Runner environment allowlist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-xiaoba-env-boundary-"));
  const projectRoot = path.join(root, "xiaoba-project");
  const rolesRoot = path.join(projectRoot, "roles");
  const roleRoot = path.join(rolesRoot, "secretary-cat");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(
    path.join(roleRoot, "role.json"),
    JSON.stringify({ name: "secretary-cat", status: "active" }),
    "utf8"
  );
  try {
    const scorecard = await runAgentE2ECase(
      {
        schema: "barena.agent_e2e_case.v1",
        case_id: "deny-untrusted-env",
        target: {
          adapter: "xiaoba",
          runtime: "xiaobaos",
          agent: "secretary-cat",
          env_allowlist: ["DATABASE_URL"],
        },
        task: { prompt: "Create result.txt." },
        assertions: { artifacts: [{ path: "result.txt", exists: true }] },
        replays: 0,
        timeout_ms: 5_000,
        isolation: {
          level: "policy_only",
          network: "disabled",
          writable_roots: ["workspace"],
        },
      },
      root,
      {
        runsRoot: path.join(root, "runs"),
        targetAdapter: new XiaobaTargetAdapter({
          command: process.execPath,
          baseArgs: [fakeXiaoba],
          projectRoot,
          rolesRoot,
          envAllowlist: ["XIAOBA_LLM_API_KEY"],
        }),
      }
    );
    assert.equal(scorecard.decision, "held");
    assert.equal(scorecard.reason_code, "config_invalid");
    const boundaryRef = scorecard.attempts[0]?.target.boundary_trace_refs?.[0];
    assert.ok(boundaryRef);
    const span = readNdjson<{ trace_id: string; status: string }>(boundaryRef)[0];
    assert.match(span?.trace_id ?? "", /^[a-f0-9]{32}$/);
    assert.equal(span?.status, "ERROR");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("XiaobaOS target adapter blocks a missing configured Role before ordinary chat", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-xiaoba-role-preflight-"));
  const logPath = path.join(root, "invocations.jsonl");
  const projectRoot = path.join(root, "xiaoba-project");
  const rolesRoot = path.join(projectRoot, "roles");
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(rolesRoot, { recursive: true });
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\nCreate result.txt.\n", "utf8");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "missing-role",
    target: { adapter: "xiaoba", runtime: "xiaobaos", agent: "missing-role" },
    task: { prompt: "Create result.txt." },
    assertions: { artifacts: [{ path: "result.txt", contains: "BARENA_E2E_OK" }] },
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });
  const result = await runSkillEvaluation({
    skillPath,
    targetId: "xiaobaos",
    cases: [casePath],
    attemptsPerArm: 1,
    runsRoot: path.join(root, "runs"),
    targetAdapter: new XiaobaTargetAdapter({
      command: process.execPath,
      baseArgs: [fakeXiaoba, "--invocation-log", logPath],
      projectRoot,
      rolesRoot,
    }),
  });

  assert.equal(result.decision, "held");
  assert.equal(result.baseline.run_refs[0].scorecard.reason_code, "config_invalid");
  assert.equal(result.baseline.run_refs[0].scorecard.attempts[0].target.reason_code, "config_invalid");
  const invocations = readNdjson<{ args: string[] }>(logPath);
  assert.equal(invocations.some((entry) => entry.args[0] === "chat" && !entry.args.includes("--help")), false);
});
