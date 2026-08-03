import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  executeEngineRequest,
  runEngineWorker,
  type EngineWorkerOperations,
} from "../src/engine-worker";
import {
  parseEngineEventV1,
  verifyRunPackageV1,
} from "../src/engine-protocol";
import {
  compilePlatformCaseForReplay,
  type AgentE2ECaseV1,
  type AgentE2ERunOptions,
  type AgentE2EScorecard,
} from "../src/e2e";
import type { ExploreResultV1 } from "../src/explore";
import { createAdHocExploreScenario } from "../src/explore";
import { readJson, readNdjson, writeJson } from "../src/utils/fs";

test("Node Engine Worker maps Explore progress to durable NDJSON and a verified Run package", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-worker-"));
  const emitted: string[] = [];
  try {
    const result = await executeEngineRequest(
      {
        schema: "barena.engine_request.v1",
        request_id: "request-worker-001",
        run_id: "server-run-001",
        operation: "explore",
        runs_root: runsRoot,
        input: {
          scenario: {
            schema: "barena.explore_scenario.v1",
            scenario_id: "worker-smoke",
          },
        },
      },
      {
        operations: fakeOperations(),
        emit: (line) => {
          emitted.push(line);
        },
      }
    );

    const runRoot = path.join(runsRoot, "server-run-001");
    const persisted = readNdjson<unknown>(path.join(runRoot, "events.ndjson")).map(
      parseEngineEventV1
    );
    assert.equal(result.result.run_id, "server-run-001");
    assert.deepEqual(
      emitted.map((line) => JSON.parse(line)),
      persisted
    );
    assert.deepEqual(
      persisted.map((event) => [event.sequence, event.phase, event.actor]),
      [
        [1, "probe", "barena"],
        [2, "target", "target"],
        [3, "complete", "engine"],
      ]
    );
    assert.equal(persisted[1].attempt_id, "turn-1");
    assert.equal(persisted.at(-1)?.trace_id, undefined);

    const packageValue = readJson(path.join(runRoot, "run-package.json"));
    const verified = verifyRunPackageV1(runRoot, packageValue);
    assert.equal(verified.run_id, "server-run-001");
    assert.equal(verified.result_ref, "explore-result.json");
    assert.deepEqual(
      verified.files.map((entry) => entry.ref).sort(),
      [
        "engine-request.json",
        "events.ndjson",
        "explore-result.json",
        "reports/report.json",
        "reports/report.md",
      ]
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("Node Engine Worker retains a failed Run without reusing an existing identity", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-worker-fail-"));
  const request = {
    schema: "barena.engine_request.v1",
    request_id: "request-worker-fail",
    run_id: "server-run-fail",
    operation: "explore",
    runs_root: runsRoot,
    input: {
      scenario: {
        schema: "barena.explore_scenario.v1",
        scenario_id: "worker-failure",
      },
    },
  };
  try {
    const operations = fakeOperations();
    operations.explore = async (_scenario, options) => {
      const runRoot = path.join(options.runs_root as string, options.run_id as string);
      fs.mkdirSync(runRoot);
      await options.on_progress?.({
        schema: "barena.explore_progress.v1",
        sequence: 1,
        timestamp: new Date().toISOString(),
        actor: "barena",
        stage: "probe",
        status: "started",
      });
      throw new Error("injected engine failure");
    };
    await assert.rejects(
      executeEngineRequest(request, { operations }),
      /injected engine failure/
    );
    const runRoot = path.join(runsRoot, "server-run-fail");
    assert.equal(readJson<{ status: string }>(path.join(runRoot, "engine-error.json")).status, "failed");
    assert.equal(
      verifyRunPackageV1(
        runRoot,
        readJson(path.join(runRoot, "run-package.json"))
      ).status,
      "failed"
    );
    await assert.rejects(
      executeEngineRequest(request, { operations }),
      /already exists and will not be reused/
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("Node Engine Worker compiles an immutable Platform Case into the existing Replay path", async () => {
  const runsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "barena-worker-platform-case-")
  );
  const caseBaseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "barena-platform-case-base-")
  );
  const operations = fakeOperations();
  let observed:
    | {
        caseDefinition: AgentE2ECaseV1;
        caseBaseDir: string;
        options: AgentE2ERunOptions;
      }
    | undefined;
  operations.replay = async (caseDefinition, observedBaseDir, options) => {
    observed = {
      caseDefinition,
      caseBaseDir: observedBaseDir,
      options,
    };
    return writeFakeReplayResult(
      caseDefinition,
      options,
      "11111111111111111111111111111111"
    );
  };

  try {
    const platformCase = validPlatformCase();
    const result = await executeEngineRequest(
      {
        schema: "barena.engine_request.v1",
        request_id: "request-platform-replay-001",
        run_id: "server-platform-replay-001",
        operation: "replay",
        runs_root: runsRoot,
        input: {
          platform_case: platformCase,
          case_base_dir: caseBaseDir,
        },
        runtime: {
          xiaoba: {
            command: path.resolve(
              "test/fixtures/targets/fake-xiaoba-chat.mjs"
            ),
          },
        },
      },
      { operations }
    );

    assert.ok(observed);
    assert.equal(observed.caseBaseDir, caseBaseDir);
    assert.equal(observed.options.targetAdapter?.id, "xiaobaos");
    assert.deepEqual(observed.caseDefinition, {
      schema: "barena.agent_e2e_case.v1",
      case_id: "case-platform-001",
      target: {
        adapter: "xiaoba",
        runtime: "xiaobaos",
        agent: "secretary-cat",
        model: "fixture-model",
        env_allowlist: ["FIXTURE_API_KEY"],
      },
      task: {
        prompt: "Reproduce the reviewed failure with a fixed prompt.",
      },
      assertions: {
        artifacts: [
          {
            path: "result.txt",
            contains: "REVIEWED_FIX",
          },
        ],
      },
      timeout_ms: 12_000,
      isolation: {
        level: "policy_only",
        network: "disabled",
        writable_roots: ["workspace"],
      },
    });
    assert.equal(result.result.case_id, "case-platform-001");

    const events = readNdjson<unknown>(
      path.join(runsRoot, "server-platform-replay-001", "events.ndjson")
    ).map(parseEngineEventV1);
    assert.equal(
      events.at(-1)?.trace_id,
      observed.options.trace_id
    );
    assert.match(observed.options.trace_id ?? "", /^[a-f0-9]{32}$/);
    assert.equal(
      events.every((event) => event.trace_id === observed?.options.trace_id),
      true
    );
    assert.equal(events.at(-1)?.payload.decision, "cleared");
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(caseBaseDir, { recursive: true, force: true });
  }
});

test("Platform Case compiler defaults replay prompt to the source Explore objective", () => {
  const platformCase = validPlatformCase();
  delete platformCase.replay_prompt;
  const compiled = compilePlatformCaseForReplay(platformCase);
  assert.equal(
    compiled.task.prompt,
    "Create result.txt only after checking the requested constraint."
  );
  assert.equal(compiled.case_id, "case-platform-001");
});

test("Node Engine Worker rejects malformed or unsupported Platform Cases before Replay", async () => {
  const runsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "barena-worker-platform-reject-")
  );
  const caseBaseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "barena-platform-reject-base-")
  );
  let replayCalls = 0;
  const operations = fakeOperations();
  operations.replay = async () => {
    replayCalls += 1;
    throw new Error("Replay must not run for an invalid Platform Case");
  };
  const cases: Array<{
    name: string;
    mutate: (value: Record<string, unknown>) => void;
    error: RegExp;
  }> = [
    {
      name: "schema",
      mutate: (value) => {
        value.schema = "barena.case.v2";
      },
      error: /schema must be barena\.case\.v1/,
    },
    {
      name: "runtime",
      mutate: (value) => {
        value.runtime = { runtime: "openclaw" };
      },
      error: /Unsupported Platform Case Runtime: openclaw/,
    },
    {
      name: "verifier",
      mutate: (value) => {
        value.verifier = { kind: "artifact_assertions", artifacts: [] };
      },
      error: /verifier\.artifacts must be a non-empty array/,
    },
    {
      name: "assertion",
      mutate: (value) => {
        value.verifier = {
          kind: "artifact_assertions",
          artifacts: [{ path: "../escape.txt" }],
        };
      },
      error: /artifact assertion path must stay inside the workspace/,
    },
    {
      name: "assertion type",
      mutate: (value) => {
        value.verifier = {
          kind: "artifact_assertions",
          artifacts: [{ path: "result.txt", exists: "yes" }],
        };
      },
      error: /artifact assertion exists must be boolean/i,
    },
    {
      name: "skill",
      mutate: (value) => {
        const input = value.input as Record<string, unknown>;
        const scenario = input.scenario as Record<string, unknown>;
        const target = scenario.target as Record<string, unknown>;
        target.skill = "unrepresentable-skill";
      },
      error: /does not support source Explore target\.skill/,
    },
  ];

  try {
    for (const [index, entry] of cases.entries()) {
      const platformCase = validPlatformCase();
      entry.mutate(platformCase);
      const runId = `server-platform-reject-${index + 1}`;
      await assert.rejects(
        executeEngineRequest(
          {
            schema: "barena.engine_request.v1",
            request_id: `request-platform-reject-${index + 1}`,
            run_id: runId,
            operation: "replay",
            runs_root: runsRoot,
            input: {
              platform_case: platformCase,
              case_base_dir: caseBaseDir,
            },
          },
          { operations }
        ),
        entry.error,
        entry.name
      );
      const runRoot = path.join(runsRoot, runId);
      assert.equal(
        verifyRunPackageV1(
          runRoot,
          readJson(path.join(runRoot, "run-package.json"))
        ).status,
        "failed"
      );
    }
    assert.equal(replayCalls, 0);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(caseBaseDir, { recursive: true, force: true });
  }
});

test("NDJSON Worker executes the real XiaoBaOS Explore Engine end to end", { concurrency: false }, async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-worker-xiaoba-"));
  const projectRoot = path.resolve("test/fixtures/explore/xiaoba-project");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  try {
    const request = {
      schema: "barena.engine_request.v1",
      request_id: "request-real-xiaoba-001",
      run_id: "server-real-xiaoba-001",
      operation: "explore",
      runs_root: runsRoot,
      input: {
        scenario: createAdHocExploreScenario({
          role: "secretary-cat",
          task: "帮助信息不完整的用户形成可执行计划。",
          max_turns: 3,
          timeout_ms: 10_000,
        }),
      },
      runtime: {
        xiaoba: {
          command: path.resolve("test/fixtures/targets/fake-xiaoba-explore.mjs"),
          project_root: projectRoot,
          roles_root: path.join(projectRoot, "roles"),
          skills_root: path.join(projectRoot, "skills"),
        },
      },
    };
    const pending = runEngineWorker({ stdin, stdout, stderr });
    stdin.end(JSON.stringify(request));
    await pending;
    stdout.end();
    stderr.end();

    assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "");
    const events = Buffer.concat(stdoutChunks)
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => parseEngineEventV1(JSON.parse(line)));
    assert.ok(events.some((event) => event.actor === "user_simulator"));
    assert.ok(events.some((event) => event.actor === "target"));
    assert.ok(events.some((event) => event.actor === "inspector"));
    assert.ok(events.some((event) => event.actor === "reviewer"));
    assert.equal(events.at(-1)?.kind, "terminal");

    const runRoot = path.join(runsRoot, request.run_id);
    const result = readJson<ExploreResultV1>(
      path.join(runRoot, "explore-result.json")
    );
    assert.equal(result.status, "pass");
    assert.equal(result.evidence.native_otlp_spans, 7);
    const spans = readNdjson<{ trace_id: string }>(
      result.evidence.otlp_spans
    );
    assert.ok(spans.length > 0);
    assert.equal(events.at(-1)?.trace_id, spans[0].trace_id);
    assert.equal(
      verifyRunPackageV1(
        runRoot,
        readJson(path.join(runRoot, "run-package.json"))
      ).status,
      "complete"
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

function validPlatformCase(): Record<string, unknown> {
  return {
    schema: "barena.case.v1",
    case_id: "case-platform-001",
    revision: 1,
    source_issue_id: "issue-platform-001",
    source_run_id: "run-platform-001",
    source_trace_id: "01010101010101010101010101010101",
    title: "Agent skipped the reviewed constraint",
    operation: "explore",
    input: {
      scenario: {
        schema: "barena.explore_scenario.v1",
        scenario_id: "source-explore-001",
        target: {
          runtime: "xiaobaos",
          role: "secretary-cat",
          model: "fixture-model",
          env_allowlist: ["FIXTURE_API_KEY"],
        },
        objective:
          "Create result.txt only after checking the requested constraint.",
        success_criteria: ["result.txt contains the reviewed marker"],
        max_turns: 4,
        timeout_ms: 12_000,
        isolation: {
          level: "policy_only",
          network: "disabled",
          writable_roots: ["workspace"],
        },
      },
    },
    runtime: {
      runtime: "xiaobaos",
      role: "secretary-cat",
    },
    success_criteria: "result.txt contains the reviewed marker",
    replay_prompt: "Reproduce the reviewed failure with a fixed prompt.",
    verifier: {
      kind: "artifact_assertions",
      artifacts: [
        {
          path: "result.txt",
          contains: "REVIEWED_FIX",
        },
      ],
    },
    created_at: "2026-07-31T08:00:00.000Z",
  };
}

function writeFakeReplayResult(
  caseDefinition: AgentE2ECaseV1,
  options: AgentE2ERunOptions,
  traceId: string
): AgentE2EScorecard {
  const runRoot = path.join(
    options.runsRoot as string,
    options.run_id as string
  );
  const spanRef = path.join(runRoot, "traces", "native", "spans.ndjson");
  fs.mkdirSync(path.dirname(spanRef), { recursive: true });
  fs.mkdirSync(path.join(runRoot, "reviewer"), { recursive: true });
  fs.mkdirSync(path.join(runRoot, "reports"), { recursive: true });
  const secondaryTraceId = "22222222222222222222222222222222";
  const spans = [
    {
      trace_id: secondaryTraceId,
      span_id: "2222222222222222",
      name: "secondary",
    },
    {
      trace_id: traceId,
      span_id: "1111111111111111",
      name: "primary-1",
    },
    {
      trace_id: traceId,
      span_id: "1111111111111112",
      name: "primary-2",
    },
  ];
  fs.writeFileSync(
    spanRef,
    `${spans.map((span) => JSON.stringify(span)).join("\n")}\n`,
    "utf8"
  );
  const scorecard = {
    scorecard_type: "barena.agent_e2e.v1",
    run_id: options.run_id,
    case_id: caseDefinition.case_id,
    status: "pass",
    decision: "cleared",
    summary: "Replay passed with retained span evidence.",
    attempts: [
      {
        target: {
          native_trace_refs: [spanRef],
        },
      },
    ],
    evidence_refs: [spanRef],
  } as unknown as AgentE2EScorecard;
  writeJson(path.join(runRoot, "reviewer", "scorecard.json"), scorecard);
  writeJson(path.join(runRoot, "reports", "report.json"), scorecard);
  fs.writeFileSync(
    path.join(runRoot, "reports", "report.md"),
    "# Replay passed\n",
    "utf8"
  );
  return scorecard;
}

function fakeOperations(): EngineWorkerOperations {
  return {
    explore: async (_scenario, options) => {
      const runRoot = path.join(options.runs_root as string, options.run_id as string);
      fs.mkdirSync(runRoot);
      fs.mkdirSync(path.join(runRoot, "reports"), { recursive: true });
      await options.on_progress?.({
        schema: "barena.explore_progress.v1",
        sequence: 1,
        timestamp: new Date("2026-07-30T10:00:00.000Z").toISOString(),
        actor: "barena",
        stage: "probe",
        status: "completed",
        summary: "Runtime ready.",
      });
      await options.on_progress?.({
        schema: "barena.explore_progress.v1",
        sequence: 2,
        timestamp: new Date("2026-07-30T10:00:01.000Z").toISOString(),
        actor: "target",
        stage: "target",
        status: "completed",
        turn: 1,
        summary: "Target completed.",
      });
      const result = {
        schema: "barena.explore_result.v1",
        run_id: options.run_id,
        scenario_id: "worker-smoke",
        status: "pass",
        summary: "Verified.",
      } as unknown as ExploreResultV1;
      writeJson(path.join(runRoot, "explore-result.json"), result);
      writeJson(path.join(runRoot, "reports", "report.json"), result);
      fs.writeFileSync(
        path.join(runRoot, "reports", "report.md"),
        "# Verified\n",
        "utf8"
      );
      return result;
    },
    replay: async () => {
      throw new Error("not used");
    },
    compare: async () => {
      throw new Error("not used");
    },
  };
}
