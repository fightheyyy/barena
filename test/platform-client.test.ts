import assert from "node:assert/strict";
import test from "node:test";
import {
  BarenaPlatformClient,
  platformConnectionFromEnv,
} from "../src/platform-client";
import { engineEventFromExploreProgress } from "../src/explore";

test("platform client authenticates edge Run lifecycle without exposing the API key", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/v1/ingest/runs")) {
      return new Response(
        JSON.stringify({
          run_id: "run-edge",
          request_id: "req-edge",
          origin: "edge",
          operation: "explore",
          state: "running",
        }),
        { status: 201 },
      );
    }
    if (String(input).endsWith("/events")) {
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify({
        run_id: "run-edge",
        request_id: "req-edge",
        origin: "edge",
        operation: "explore",
        state: "completed",
      }),
      { status: 200 },
    );
  };
  const client = new BarenaPlatformClient(
    {
      url: "http://127.0.0.1:5570",
      apiKey: "sk-lw-test-project-key",
    },
    { fetch: fakeFetch },
  );
  const run = await client.createRun({
    operation: "explore",
    input: { scenario: { scenario_id: "connected" } },
  });
  const event = engineEventFromExploreProgress(run.run_id, {
    schema: "barena.explore_progress.v1",
    sequence: 1,
    timestamp: "2026-07-30T00:00:00.000Z",
    actor: "user_simulator",
    stage: "user_simulator",
    status: "completed",
    turn: 1,
    message: "Please clarify the target.",
  });
  await client.appendEvent(run.run_id, event);
  await client.finishRun(run.run_id, "completed");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(
      new Headers(call.init?.headers).get("authorization"),
      "Bearer sk-lw-test-project-key",
    );
    assert.doesNotMatch(String(call.init?.body ?? ""), /sk-lw-/);
  }
  assert.match(calls[0]!.url, /\/api\/barena\/v1\/ingest\/runs$/);
  assert.equal(event.event_id, "run-edge.1");
  assert.equal(event.attempt_id, "turn-1");
  assert.equal(event.actor, "user_simulator");
  assert.equal(event.payload.source_schema, "barena.explore_progress.v1");
});

test("platform connection requires a complete secure configuration", () => {
  assert.equal(platformConnectionFromEnv({}), undefined);
  assert.throws(
    () =>
      platformConnectionFromEnv({
        BARENA_PLATFORM_URL: "https://barena.example.com",
      }),
    /must be configured together/,
  );
  assert.throws(
    () =>
      new BarenaPlatformClient({
        url: "http://barena.example.com",
        apiKey: "sk-lw-test-project-key",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      new BarenaPlatformClient({
        url: "https://barena.example.com",
        apiKey: "plain-token",
      }),
    /API key is invalid/,
  );

  assert.deepEqual(
    platformConnectionFromEnv({
      BARENA_PLATFORM_URL: "https://barena.example.com",
      BARENA_PLATFORM_API_KEY: "sk-lw-project-key",
    }),
    {
      url: "https://barena.example.com",
      apiKey: "sk-lw-project-key",
    },
  );
  assert.doesNotThrow(
    () =>
      new BarenaPlatformClient({
        url: "https://barena.example.com",
        apiKey: "pkey_legacy-project-key-1234567890",
      })
  );
});
