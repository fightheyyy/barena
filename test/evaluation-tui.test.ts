import assert from "node:assert/strict";
import test from "node:test";
import { SkillEvaluationResultV1 } from "../src/evaluation/types";
import type { ExploreResultV1 } from "../src/explore";
import {
  AUTO_EXPLORE_MAX_TURNS,
  initialEvaluationTuiState,
  reduceEvaluationTui,
  resolveRoleFromIntent,
} from "../src/tui/evaluation-model";
import { renderEvaluationTui } from "../src/tui/evaluation-render";
import { discoverTuiTargets } from "../src/tui/evaluation-tui";

test("product TUI discovers an explicitly configured DeepSeek Harness command", () => {
  const dshCommand = new URL("./fixtures/targets/fake-dsh.mjs", import.meta.url).pathname;
  const discovery = discoverTuiTargets({ dshCommand });
  const runtime = discovery.runtimes.find((candidate) => candidate.id === "dsh");
  assert.equal(runtime?.installed, true);
  assert.equal(runtime?.command_path, dshCommand);
  assert.equal(runtime?.explore_support, "ready");
});

test("product TUI auto-resolves Base and progressively accepts /agent and /skill overrides", () => {
  const runtimes = [
    {
      id: "xiaobaos" as const,
      display_name: "XiaoBaOS",
      command_name: "xiaoba",
      command_path: "/opt/homebrew/bin/xiaoba",
      installed: true,
      explore_support: "ready" as const,
      detail: "installed; Explore adapter available",
    },
    {
      id: "claude-code" as const,
      display_name: "Claude Code",
      command_name: "claude",
      command_path: "/opt/homebrew/bin/claude",
      installed: true,
      explore_support: "pending" as const,
      detail: "installed; Explore adapter pending",
    },
  ];
  const roles = [
    {
      id: "base",
      display_name: "Base Agent",
      description: "XiaoBaOS default Agent without an active Role.",
      aliases: ["default"],
      path: "/tmp/roles",
      evaluator_role: false,
      base_profile: true,
    },
    {
      id: "secretary-cat",
      display_name: "SecretaryCat",
      description: "Turns incomplete workplace requests into executable plans.",
      aliases: ["秘书猫", "secretary"],
      path: "/tmp/roles/secretary-cat",
      evaluator_role: false,
    },
    {
      id: "xuan-sheng-di-jun",
      display_name: "XuanShengDiJun",
      description: "A taste-sensitive parody Role.",
      aliases: ["炫圣帝君", "炫神"],
      path: "/tmp/roles/xuan-sheng-di-jun",
      evaluator_role: false,
    },
  ];
  const skills = [
    {
      id: "webcli",
      display_name: "webcli",
      description: "Explore web systems.",
      path: "/tmp/skills/webcli",
      scope: "base" as const,
    },
    {
      id: "calendar",
      display_name: "calendar",
      description: "Create and update calendar events.",
      path: "/tmp/roles/secretary-cat/skills/calendar",
      scope: "role" as const,
      role_id: "secretary-cat",
    },
  ];
  let state = initialEvaluationTuiState([], {
    homeMode: "product",
    runtimes,
    xiaobaRoles: roles,
    xiaobaSkills: skills,
  });

  for (const width of [40, 80, 120]) {
    const rendered = renderEvaluationTui(state, {
      width,
      height: 24,
      color: false,
    });
    assert.match(rendered, /What are you evaluating today/);
    assert.match(rendered, /Explore unknown behavior/);
    assert.match(rendered, /Replay (?:a (?:known )?)?Case.*CLI ready/s);
    assert.match(rendered, /Compare(?: releases)?.*CLI ready/s);
    assert.doesNotMatch(rendered, /What Agent behavior should Barena/);
    assert.doesNotMatch(rendered, /^[╭│╰]/m);
    assert.equal(rendered.split("\n").every((line) => line.length <= width), true);
    assert.equal(rendered.split("\n").length <= 24, true);
  }
  assert.doesNotMatch(
    renderEvaluationTui(state, { width: 40, height: 24, color: false }),
    /██████╗/
  );
  assert.match(
    renderEvaluationTui(state, { width: 80, height: 24, color: false }),
    /██████╗/
  );

  let pending = initialEvaluationTuiState([], {
    homeMode: "product",
    runtimes,
    xiaobaRoles: roles,
    xiaobaSkills: skills,
  });
  pending = reduceEvaluationTui(pending, {
    type: "key",
    name: "down",
  }).state;
  pending = reduceEvaluationTui(pending, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(pending.screen, "home");
  assert.equal(pending.selected, 1);

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.screen, "explore_task");
  assert.equal(state.exploreRuntime?.id, "xiaobaos");
  assert.equal(state.exploreRole?.id, "base");
  assert.match(
    renderEvaluationTui(state, { width: 80, height: 24, color: false }),
    /XiaoBaOS \/ Base Agent/
  );
  state = reduceEvaluationTui(state, {
    type: "key",
    text: "/agent secretary-cat",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.exploreRole?.id, "secretary-cat");
  assert.equal(state.screen, "explore_task");

  state = reduceEvaluationTui(state, {
    type: "key",
    text: "/skill",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.screen, "explore_skill");
  state = reduceEvaluationTui(state, {
    type: "key",
    text: "calendar",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.screen, "explore_task");
  assert.equal(state.exploreSkill?.id, "calendar");
  state = reduceEvaluationTui(state, {
    type: "key",
    text: "Use vague planning requests and check whether it asks the right follow-ups",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.screen, "explore_review");
  const review = renderEvaluationTui(state, {
    width: 100,
    height: 30,
    color: false,
  });
  assert.match(review, /Ready to test/);
  assert.match(review, /XiaoBaOS \/ SecretaryCat/);
  assert.match(review, /Focus\s+calendar Skill/);
  assert.match(review, /turn reproducible behavior gaps into Replay Case candidates/);
  assert.match(review, /Press Enter to start/);

  const run = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  });
  assert.equal(run.state.screen, "explore_running");
  assert.deepEqual(run.effect, {
    type: "run_explore",
    runtime: "xiaobaos",
    role: "secretary-cat",
    skill: "calendar",
    task: "Use vague planning requests and check whether it asks the right follow-ups",
    maxTurns: AUTO_EXPLORE_MAX_TURNS,
    timeoutMs: 180_000,
  });
});

test("product TUI routes DeepSeek Harness directly to the natural-language objective", () => {
  const runtimes = [
    {
      id: "xiaobaos" as const,
      display_name: "XiaoBaOS",
      command_name: "xiaoba",
      command_path: "/opt/homebrew/bin/xiaoba",
      installed: true,
      explore_support: "ready" as const,
      detail: "installed; Explore adapter available",
    },
    {
      id: "dsh" as const,
      display_name: "DeepSeek Harness",
      command_name: "dsh",
      command_path: "/opt/homebrew/bin/dsh",
      installed: true,
      explore_support: "ready" as const,
      detail: "installed; Explore adapter available",
    },
  ];
  let state = initialEvaluationTuiState([], { homeMode: "product", runtimes });
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "explore_runtime");
  state = reduceEvaluationTui(state, { type: "key", name: "down" }).state;
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "explore_task");
  assert.equal(state.exploreRuntime?.id, "dsh");
  assert.equal(state.exploreRole, undefined);
  state = reduceEvaluationTui(state, { type: "key", text: "测试部署边界" }).state;
  state = reduceEvaluationTui(state, { type: "key", name: "return" }).state;
  assert.equal(state.screen, "explore_review");
  const transition = reduceEvaluationTui(state, { type: "key", name: "return" });
  assert.equal(transition.state.screen, "explore_running");
  assert.deepEqual(transition.effect, {
    type: "run_explore",
    runtime: "dsh",
    role: "agent",
    task: "测试部署边界",
    maxTurns: AUTO_EXPLORE_MAX_TURNS,
    timeoutMs: 180_000,
  });
});

test("natural intent resolves aliases and a common spoken-name variant", () => {
  const roles = [
    {
      id: "xuan-sheng-di-jun",
      display_name: "XuanShengDiJun",
      aliases: ["炫圣帝君", "炫神"],
      path: "/tmp/xuan",
      evaluator_role: false,
    },
    {
      id: "huang-sheng-di-jun",
      display_name: "HuangShengDiJun",
      aliases: ["黄圣帝君", "黄神"],
      path: "/tmp/huang",
      evaluator_role: false,
    },
  ];
  assert.equal(
    resolveRoleFromIntent("测一下炫圣帝君的品味有没有还原", roles)?.id,
    "xuan-sheng-di-jun"
  );
  assert.equal(
    resolveRoleFromIntent("Test xuan-sheng-di-jun taste", roles)?.id,
    "xuan-sheng-di-jun"
  );
  assert.equal(
    resolveRoleFromIntent("测一下玄圣帝君", roles)?.id,
    "xuan-sheng-di-jun"
  );
});

test("Explore makes Base explicit and treats no /skill as the complete Agent", () => {
  const roles = [
    {
      id: "base",
      display_name: "Base Agent",
      path: "/tmp/roles",
      evaluator_role: false,
      base_profile: true,
    },
    {
      id: "secretary-cat",
      display_name: "SecretaryCat",
      path: "/tmp/secretary",
      evaluator_role: false,
    },
  ];
  let state = initialEvaluationTuiState([], {
    homeMode: "product",
    runtimes: [
      {
        id: "xiaobaos",
        display_name: "XiaoBaOS",
        command_name: "xiaoba",
        installed: true,
        explore_support: "ready",
        detail: "ready",
      },
    ],
    xiaobaRoles: roles,
    initialWorkflow: "explore",
  });
  assert.equal(state.screen, "explore_task");
  assert.equal(state.exploreRole?.id, "base");
  state = reduceEvaluationTui(state, {
    type: "key",
    text: "测试默认 Agent 面对模糊请求时的澄清能力",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "return",
  }).state;
  assert.equal(state.screen, "explore_review");
  assert.equal(state.exploreSkill, undefined);
  const review = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(review, /Base Agent/);
  assert.match(review, /Entire Agent configuration/);
});

test("a positional Explore objective opens one resolved plan instead of setup screens", () => {
  const state = initialEvaluationTuiState([], {
    homeMode: "product",
    initialWorkflow: "explore",
    initialExploreTask: "Give it a vague deployment problem and see whether it clarifies first",
    runtimes: [
      {
        id: "xiaobaos",
        display_name: "XiaoBaOS",
        command_name: "xiaoba",
        installed: true,
        explore_support: "ready",
        detail: "ready",
      },
    ],
    xiaobaRoles: [
      {
        id: "base",
        display_name: "Base Agent",
        path: "/tmp/roles",
        evaluator_role: false,
        base_profile: true,
      },
    ],
  });

  assert.equal(state.screen, "explore_review");
  assert.equal(state.exploreRuntime?.id, "xiaobaos");
  assert.equal(state.exploreRole?.id, "base");
  assert.match(
    renderEvaluationTui(state, { width: 80, height: 24, color: false }),
    /Give it a vague deployment problem/
  );
});

test("Explore TUI presents human phases by default and raw actor events on demand", () => {
  let state = {
    ...initialEvaluationTuiState([], { homeMode: "product" }),
    screen: "explore_running" as const,
    exploreMaxTurns: 4,
    exploreRole: {
      id: "secretary-cat",
      display_name: "SecretaryCat",
      path: "/tmp/roles/secretary-cat",
      evaluator_role: false,
    },
  };
  const base = {
    schema: "barena.explore_progress.v1" as const,
    timestamp: "2026-07-27T10:00:00.000Z",
  };
  state = reduceEvaluationTui(state, {
    type: "explore_progress",
    event: {
      ...base,
      sequence: 1,
      actor: "user_simulator",
      stage: "user_simulator",
      status: "started",
      turn: 1,
      summary: "Generating the next realistic user turn.",
    },
  }).state;
  state = reduceEvaluationTui(state, {
    type: "explore_progress",
    event: {
      ...base,
      sequence: 2,
      actor: "user_simulator",
      stage: "user_simulator",
      status: "completed",
      turn: 1,
      message: "我今天事情有点乱，先帮我排三个优先级。",
      reason: "用信息不完整的请求观察目标 Agent 是否主动组织任务。",
    },
  }).state;
  const userView = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(userView, /\[1 Explore\].*2 Inspect/);
  assert.match(userView, /3 Judge/);
  assert.match(userView, /ReviewerCat\s+waiting for InspectorCat findings/);
  assert.match(userView, /UserCat\s+sent interaction 1/);
  assert.match(userView, /我今天事情有点乱/);
  assert.doesNotMatch(userView, /Reason:/);
  assert.doesNotMatch(userView, /^[╭│╰]/m);

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "d",
    text: "d",
  }).state;
  const detailView = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(detailView, /UserCat/);
  assert.match(detailView, /Reason: 用信息不完整的请求/);
  assert.match(detailView, /not hidden model reasoning/);
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "d",
    text: "d",
  }).state;

  for (const event of [
    {
      ...base,
      sequence: 3,
      actor: "inspector" as const,
      stage: "inspector" as const,
      status: "completed" as const,
      summary: "OTLP 与工作区证据完整，发现一个澄清不足问题。",
      issue_count: 1,
    },
    {
      ...base,
      sequence: 4,
      actor: "reviewer" as const,
      stage: "reviewer" as const,
      status: "started" as const,
      summary: "Reviewing the success criteria.",
    },
    {
      ...base,
      sequence: 5,
      actor: "reviewer" as const,
      stage: "reviewer" as const,
      status: "completed" as const,
      verdict: "fail" as const,
      summary: "任务部分完成，但没有充分确认用户约束。",
    },
  ]) {
    state = reduceEvaluationTui(state, {
      type: "explore_progress",
      event,
    }).state;
  }
  const reviewView = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(reviewView, /✓ 1 Explore.*✓ 2 Inspect.*\[3 Judge\]/);
  assert.match(reviewView, /\[3 Judge\]/);
  assert.match(reviewView, /ReviewerCat\s+verdict fail/);
  assert.match(reviewView, /没有充分确认用户约束/);
  assert.match(reviewView, /InspectorCat\s+1 finding\(s\) recorded/);
});

test("Explore result separates successful evaluation from target outcome and exposes conversation", () => {
  const result = exploreResult();
  let state = reduceEvaluationTui(
    initialEvaluationTuiState([], { homeMode: "product" }),
    { type: "explore_result", result }
  ).state;
  const rendered = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(rendered, /Explore complete\s+NEEDS IMPROVEMENT/);
  assert.match(rendered, /Evaluation\s+complete · evidence retained/);
  assert.match(rendered, /Findings\s+2 behavior gap\(s\)/);
  assert.match(rendered, /Replay Cases\s+1 candidate\(s\) ready/);
  assert.match(rendered, /2 diagnostic observation\(s\) kept in the report/);
  assert.match(rendered, /c opens Replay Cases/);
  assert.doesNotMatch(rendered, /Explore verdict\s+FAIL/);

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "c",
    text: "c",
  }).state;
  assert.equal(state.screen, "explore_cases");
  const cases = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(cases, /Replay Case candidate/);
  assert.match(cases, /用户要求一句话后仍然过度解释/);
  assert.match(cases, /请给我一句克制的朋友圈文案/);

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "b",
    text: "b",
  }).state;
  assert.equal(state.screen, "explore_result");

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "v",
    text: "v",
  }).state;
  assert.equal(state.screen, "explore_transcript");
  const conversation = renderEvaluationTui(state, {
    width: 80,
    height: 24,
    color: false,
  });
  assert.match(conversation, /Conversation\s+1-/);
  assert.match(conversation, /Simulated user · interaction 1/);
  assert.match(conversation, /请给我一句克制的朋友圈文案/);
});

test("legacy paired Skill TUI remains available through compatibility mode", () => {
  const state = initialEvaluationTuiState([], { homeMode: "skill" });
  assert.equal(state.screen, "home");
  assert.match(
    renderEvaluationTui(state, { width: 80, height: 24, color: false }),
    /Run an agent evaluation/
  );
});

test("product TUI keeps utility views behind home shortcuts", () => {
  let state = initialEvaluationTuiState([], { homeMode: "product" });
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "d",
    text: "d",
  }).state;
  assert.equal(state.screen, "dag");
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "escape",
  }).state;
  assert.equal(state.screen, "home");
  assert.equal(state.selected, 0);

  state = reduceEvaluationTui(state, {
    type: "key",
    name: "p",
    text: "p",
  }).state;
  assert.equal(state.screen, "previous");
  state = reduceEvaluationTui(state, {
    type: "key",
    name: "escape",
  }).state;
  state = reduceEvaluationTui(state, {
    type: "key",
    text: "?",
  }).state;
  assert.equal(state.screen, "prerequisites");
});

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
  assert.match(colored, /\x1b\[1;30;48;5;220m ▸ \x1b\[0m/);
  assert.match(colored, /\x1b\[1m1\. XiaobaOS Skill \(recommended\)\x1b\[0m/);
  assert.match(
    renderEvaluationTui(home, { width: 80, height: 24, color: false }),
    />  1\. XiaobaOS Skill \(recommended\)/
  );

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

function exploreResult(): ExploreResultV1 {
  return {
    status: "fail",
    summary:
      "目标 Agent 最终接近用户想要的方向，但仍然过度解释。",
    scenario: {
      objective: "测试风格是否克制",
      target: {
        runtime: "xiaobaos",
        role: "xuan-sheng-di-jun",
      },
    },
    turns: [
      { turn: 1, target: { response: "给出多个候选和解释。" } },
      { turn: 2, target: { response: "最终缩短为一句。" } },
    ],
    transcript: [
      {
        turn: 1,
        role: "user",
        actor: "user_simulator",
        content: "请给我一句克制的朋友圈文案。",
        timestamp: "2026-07-27T10:00:00.000Z",
      },
      {
        turn: 1,
        role: "assistant",
        actor: "target",
        content: "这里有五个候选，我再逐条解释。",
        timestamp: "2026-07-27T10:00:01.000Z",
      },
    ],
    inspector: {
      status: "completed",
      output: {
        summary: "发现两个行为问题和两个诊断信息。",
        evidence_complete: true,
        issues: [
          {
            issue_id: "behavior-1",
            severity: "warning",
            family: "style",
            summary: "固定口头禅破坏克制风格。",
            evidence: ["turn 1"],
          },
          {
            issue_id: "behavior-2",
            severity: "warning",
            family: "instruction_following",
            summary: "用户要求一句话后仍然过度解释。",
            evidence: ["turn 1"],
          },
          {
            issue_id: "diagnostic-1",
            severity: "info",
            family: "telemetry",
            summary: "OTel turn 属性不一致。",
            evidence: ["span 1"],
          },
          {
            issue_id: "diagnostic-2",
            severity: "info",
            family: "runtime",
            summary: "Runtime 调用均成功。",
            evidence: ["span 2"],
          },
        ],
      },
      raw_ref: "/tmp/inspector.txt",
      process: {
        status: "completed",
        detail: "completed",
        exit_code: 0,
        signal: null,
        duration_ms: 1,
      },
    },
    replay_case_candidates: [
      {
        schema: "barena.replay_case_candidate.v1",
        candidate_id: "replay-behavior-2",
        status: "proposed",
        source: {
          explore_run_id: "explore-demo",
          scenario_id: "style-demo",
          issue_id: "behavior-2",
        },
        target: {
          runtime: "xiaobaos",
          role: "xuan-sheng-di-jun",
        },
        prompt: "请给我一句克制的朋友圈文案。",
        issue_summary: "用户要求一句话后仍然过度解释。",
        evidence: ["turn 1"],
      },
    ],
    evidence: {
      evidence_complete: true,
    },
  } as ExploreResultV1;
}
