import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  BarenaPlatformClient,
  platformConnectionFromEnv,
  type PlatformRunBundleV1,
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
      apiKey: "barena_pat_test-project-key",
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
      "Bearer barena_pat_test-project-key",
    );
    assert.doesNotMatch(String(call.init?.body ?? ""), /barena_pat_/);
  }
  assert.match(calls[0]!.url, /\/v1\/ingest\/runs$/);
  assert.equal(event.event_id, "run-edge.1");
  assert.equal(event.attempt_id, "turn-1");
  assert.equal(event.actor, "user_simulator");
  assert.equal(event.payload.source_schema, "barena.explore_progress.v1");
});

test("platform client keeps explicit legacy proxy paths while origin uses canonical OTLP", async () => {
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    if (String(input).endsWith("/runs")) {
      return new Response(
        JSON.stringify({
          run_id: "run-proxy",
          request_id: "request-proxy",
          origin: "edge",
          operation: "explore",
          state: "running",
        }),
        { status: 201 },
      );
    }
    return new Response("{}", { status: 200 });
  };
  const canonical = new BarenaPlatformClient(
    {
      url: "http://127.0.0.1:5570/v1/ingest/",
      apiKey: "barena_pat_canonical-key",
    },
    { fetch: fakeFetch },
  );
  await canonical.exportOtlpJson({ resourceSpans: [] });

  const legacy = new BarenaPlatformClient(
    {
      url: "http://127.0.0.1:5570/api/barena/",
      apiKey: "sk-lw-legacy-project-key",
    },
    { fetch: fakeFetch },
  );
  await legacy.createRun({ operation: "explore", input: {} });
  await legacy.exportOtlpJson({ resourceSpans: [] });

  assert.deepEqual(urls, [
    "http://127.0.0.1:5570/v1/otlp/v1/traces",
    "http://127.0.0.1:5570/api/barena/v1/ingest/runs",
    "http://127.0.0.1:5570/api/otel/v1/traces",
  ]);
});

test("Run Bundle falls back to the old standalone lifecycle and terminal facts compatibility retry", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let finishAttempts = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    if (String(input).endsWith("/run-bundles")) {
      return new Response("not found", { status: 404 });
    }
    if (String(input).endsWith("/runs")) {
      return new Response(
        JSON.stringify({
          run_id: "run-legacy-remote",
          request_id: "request-legacy-remote",
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
    finishAttempts += 1;
    if (finishAttempts === 1) {
      return new Response(
        JSON.stringify({ detail: 'invalid JSON request: json: unknown field "terminal_fact"' }),
        { status: 400 },
      );
    }
    return new Response(
      JSON.stringify({
        run_id: "run-legacy-remote",
        request_id: "request-legacy-remote",
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
      apiKey: "barena_pat_fallback-key",
    },
    { fetch: fakeFetch },
  );
  const bundle = fixtureRunBundle();
  const synced = await client.syncRunBundle(bundle, "barena:run-local:explore");

  assert.equal(synced.transport, "legacy_lifecycle");
  assert.equal(synced.remote_run_id, "run-legacy-remote");
  assert.equal(calls.length, 5);
  assert.equal(calls[2]!.body.run_id, "run-legacy-remote");
  assert.equal(calls[2]!.body.event_id, "run-legacy-remote.1");
  assert.deepEqual(calls[3]!.body.terminal_fact, bundle.events[0]!.payload);
  assert.equal("terminal_fact" in calls[4]!.body, false);
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
      BARENA_PLATFORM_API_KEY: "barena_pat_project-key",
    }),
    {
      url: "https://barena.example.com",
      apiKey: "barena_pat_project-key",
    },
  );
  assert.doesNotThrow(
    () =>
      new BarenaPlatformClient({
        url: "https://catena.example.com",
        apiKey: "catena_agent_current-bound-key-1234567890",
      })
  );
  assert.doesNotThrow(
    () =>
      new BarenaPlatformClient({
        url: "https://barena.example.com",
        apiKey: "pkey_legacy-project-key-1234567890",
      })
  );
});

function fixtureRunBundle(): PlatformRunBundleV1 {
  const payload = {
    schema: "barena.explore_terminal_fact.v1",
    status: "pass",
    summary: "local result remains authoritative",
  };
  return {
    schema: "barena.run_bundle.v1",
    run: {
      run_id: "run-local",
      operation: "explore",
      state: "completed",
      input: { scenario: { scenario_id: "connected" } },
      created_at: "2026-08-05T00:00:00.000Z",
      updated_at: "2026-08-05T00:00:01.000Z",
    },
    events: [
      {
        schema: "barena.engine_event.v1",
        event_id: "run-local.1",
        run_id: "run-local",
        sequence: 1,
        timestamp: "2026-08-05T00:00:01.000Z",
        operation: "explore",
        kind: "terminal",
        phase: "complete",
        actor: "engine",
        trace_id: "11111111111111111111111111111111",
        payload,
      },
    ],
    terminal_fact_sha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}
