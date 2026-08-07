import assert from "node:assert/strict";
import test from "node:test";
import {
  bindRunnerOwnedEngineRequest,
  bindRunnerOwnedEvolutionRequest,
  buildScenarioEvolutionRequest,
  createSpiralRunnerServer,
} from "../src/runner-service";

test("Runner binds its trusted XiaoBaOS installation over caller-controlled execution fields", () => {
  const trustedRuntime = {
    command: "/usr/local/bin/xiaoba",
    project_root: "/opt/xiaoba",
    roles_root: "/opt/xiaoba/roles",
    env_allowlist: ["XIAOBA_LLM_API_KEY", "XIAOBA_LLM_MODEL"],
  };
  const bound = bindRunnerOwnedEngineRequest(
    {
      schema: "barena.engine_request.v1",
      request_id: "request-one",
      run_id: "run-one",
      operation: "replay",
      runs_root: "/var/lib/spiral/runs",
      input: {},
      runtime: {
        runtime: "xiaobaos",
        role: "secretary-cat",
        xiaoba: {
          command: "/tmp/untrusted",
          env_allowlist: ["DATABASE_URL"],
        },
      },
    },
    trustedRuntime,
  ) as Record<string, unknown>;

  const runtime = bound.runtime as Record<string, unknown>;
  assert.equal(runtime.runtime, "xiaobaos");
  assert.equal(runtime.role, "secretary-cat");
  assert.deepEqual(runtime.xiaoba, trustedRuntime);
  assert.equal(JSON.stringify(bound).includes("/tmp/untrusted"), false);
  assert.equal(JSON.stringify(bound).includes("DATABASE_URL"), false);
});

test("Runner owns Evolution executable and clamps the hard turn deadline", () => {
  const trustedRuntime = {
    command: "/usr/local/bin/xiaoba",
    roles_root: "/opt/xiaoba/roles",
    env_allowlist: ["XIAOBA_LLM_API_KEY"],
  };
  const bound = bindRunnerOwnedEvolutionRequest(
    {
      schema: "barena.xiaoba_evolution_request.v1",
      request_id: "inspector-one",
      operation: "turn",
      run_id: "job-one",
      role: "inspector-cat",
      prompt: "Inspect retained evidence.",
      workspace: "/var/lib/spiral/evolution/job-one/inspector-one",
      timeout_ms: 900_000,
      runtime: {
        command: "/tmp/untrusted",
        env_allowlist: ["DATABASE_URL"],
        env_overrides: {
          XIAOBA_LLM_PROVIDER: "openai",
          XIAOBA_LLM_API_BASE: "https://owner.example.test/v1",
          XIAOBA_LLM_API_KEY: "owner-secret",
          XIAOBA_LLM_MODEL: "owner-model",
        },
      },
    },
    120_000,
    trustedRuntime,
  ) as Record<string, unknown>;

  assert.equal(bound.timeout_ms, 120_000);
  assert.deepEqual(bound.runtime, {
    ...trustedRuntime,
    env_overrides: {
      XIAOBA_LLM_PROVIDER: "openai",
      XIAOBA_LLM_API_BASE: "https://owner.example.test/v1",
      XIAOBA_LLM_API_KEY: "owner-secret",
      XIAOBA_LLM_MODEL: "owner-model",
    },
  });
  assert.equal(JSON.stringify(bound).includes("/tmp/untrusted"), false);
  assert.equal(JSON.stringify(bound).includes("DATABASE_URL"), false);
});

test("Runner rejects arbitrary Evolution model environment overrides", () => {
  assert.throws(
    () => bindRunnerOwnedEvolutionRequest({
      schema: "barena.xiaoba_evolution_request.v1",
      request_id: "inspector-two",
      operation: "turn",
      run_id: "job-two",
      role: "inspector-cat",
      prompt: "Inspect retained evidence.",
      workspace: "/var/lib/spiral/evolution/job-two/inspector-two",
      timeout_ms: 30_000,
      runtime: {
        env_overrides: {
          XIAOBA_LLM_PROVIDER: "openai",
          XIAOBA_LLM_API_BASE: "https://owner.example.test/v1",
          XIAOBA_LLM_API_KEY: "owner-secret",
          DATABASE_URL: "postgres://forbidden",
        },
      },
    }),
    /not allowed/,
  );
});

test("Scenario evaluator turns share the Runner hard deadline", () => {
  const bound = buildScenarioEvolutionRequest(
    {
      schema: "barena.xiaoba_scenario_request.v1",
      request_id: "user-turn-one",
      project_id: "project-one",
      scenario_id: "scenario-one",
      run_id: "run-one",
      thread_id: "thread-one",
      role: "user-cat",
      prompt: "Continue as the simulated user.",
      timeout_ms: 900_000,
    },
    "/var/lib/spiral/evolution",
    120_000,
  );

  assert.equal(bound.timeout_ms, 120_000);
});

test("Runner rejects an invalid Evolution deadline during startup", () => {
  assert.throws(
    () => createSpiralRunnerServer({ evolutionTurnTimeoutMs: 0 }),
    /evolutionTurnTimeoutMs must be an integer from 1000 to 900000/,
  );
});

test("Evolution-only Runner does not expose target execution routes", async (t) => {
  const server = createSpiralRunnerServer({ mode: "evolution" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  for (const route of [
    "/v1/engine/run",
    "/v1/scenario/turn",
    "/v1/engine/runs/demo/cancel",
  ]) {
    const response = await fetch(origin + route, { method: "POST" });
    assert.equal(response.status, 404, route);
  }
});

test("Runner rejects an unknown deployment mode", () => {
  assert.throws(
    () => createSpiralRunnerServer({ mode: "managed" as never }),
    /CATENA_RUNNER_MODE must be all or evolution/,
  );
});
