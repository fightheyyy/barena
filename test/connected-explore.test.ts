import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAdHocExploreScenario,
  runConnectedExploreScenario,
} from "../src/explore";
import type { EngineEventV1 } from "../src/engine-protocol";
import { OtlpTraceReceiver } from "../src/runtime-adapters";

const FIXTURES = path.resolve(__dirname, "fixtures");
const FAKE_XIAOBA = path.join(FIXTURES, "targets", "fake-xiaoba-explore.mjs");
const XIAOBA_PROJECT = path.join(FIXTURES, "explore", "xiaoba-project");
const ROLES_ROOT = path.join(XIAOBA_PROJECT, "roles");
const SKILLS_ROOT = path.join(XIAOBA_PROJECT, "skills");

test("OTLP receiver retains locally, forwards only redacted bytes, and records failure honestly", async (t) => {
  const root = temporaryRoot(t);
  const forwarded: Array<{ body: Buffer; headers: Headers }> = [];
  const receiver = new OtlpTraceReceiver({
    run_root: path.join(root, "success"),
    secrets: ["TOP_SECRET"],
    forward: {
      endpoint: "http://127.0.0.1:5570/api/otel/v1/traces",
      headers: { authorization: "Bearer sk-lw-secret-key" },
      fetch: async (_input, init) => {
        forwarded.push({
          body: Buffer.from(init?.body as Uint8Array),
          headers: new Headers(init?.headers),
        });
        return new Response("{}", { status: 200 });
      },
    },
  });
  const endpoint = await receiver.start();
  const traceId = "11111111111111111111111111111111";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlpJson(traceId, "TOP_SECRET")),
  });
  assert.equal(response.status, 200);
  const manifest = await receiver.stop();

  assert.equal(manifest.forwarding?.status, "complete");
  assert.equal(manifest.forwarding?.forwarded_envelopes, 1);
  assert.deepEqual(manifest.trace_ids, [traceId]);
  assert.equal(manifest.primary_trace_id, traceId);
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0]!.headers.get("authorization"),
    "Bearer sk-lw-secret-key"
  );
  assert.doesNotMatch(forwarded[0]!.body.toString("utf8"), /TOP_SECRET/);
  assert.doesNotMatch(
    fs.readFileSync(manifest.envelopes[0]!.raw_ref, "utf8"),
    /TOP_SECRET/
  );
  assert.doesNotMatch(
    fs.readFileSync(manifest.manifest_ref, "utf8"),
    /sk-lw-secret-key/
  );

  const failed = new OtlpTraceReceiver({
    run_root: path.join(root, "failed"),
    forward: {
      endpoint: "http://127.0.0.1:5570/api/otel/v1/traces",
      fetch: async () => new Response("unavailable", { status: 503 }),
    },
  });
  const failedEndpoint = await failed.start();
  assert.equal(
    (
      await fetch(failedEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpJson(traceId, "visible")),
      })
    ).status,
    200
  );
  const failedManifest = await failed.stop();
  assert.equal(failedManifest.forwarding?.status, "failed");
  assert.equal(failedManifest.forwarding?.failed_envelopes, 1);
  assert.equal(fs.existsSync(failedManifest.envelopes[0]!.raw_ref), true);
});

test("connected Explore closes Run, Trace, terminal facts, and evolution correlation", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const forwardedSecret = "CONNECTED_ONLY_SECRET_VALUE";
  const previousSecret = process.env.FAKE_XIAOBA_SECRET;
  const previousEcho = process.env.FAKE_XIAOBA_ECHO_VALUE;
  process.env.FAKE_XIAOBA_SECRET = forwardedSecret;
  process.env.FAKE_XIAOBA_ECHO_VALUE = "1";
  t.after(() => restoreEnv("FAKE_XIAOBA_SECRET", previousSecret));
  t.after(() => restoreEnv("FAKE_XIAOBA_ECHO_VALUE", previousEcho));
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      contentType: request.headers["content-type"] ?? "",
      body,
    });
    if (request.method === "POST" && request.url === "/api/barena/v1/ingest/runs") {
      respondJson(response, 201, {
        run_id: "run-connected-e2e",
        request_id: "request-connected-e2e",
        origin: "edge",
        operation: "explore",
        state: "running",
      });
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/events")) {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/finish")) {
      respondJson(response, 200, {
        run_id: "run-connected-e2e",
        request_id: "request-connected-e2e",
        origin: "edge",
        operation: "explore",
        state: "completed",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/otel/v1/traces") {
      respondJson(response, 200, { partialSuccess: {} });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformURL = `http://127.0.0.1:${address.port}`;
  const apiKey = "sk-lw-connected-e2e-key";

  const result = await runConnectedExploreScenario(
    createAdHocExploreScenario({
      role: "secretary-cat",
      task: "帮助表达不完整的用户形成今天可执行的优先级计划。",
      max_turns: 4,
      timeout_ms: 10_000,
    }),
    {
      platform: { url: platformURL, apiKey },
      runs_root: path.join(root, "runs"),
      xiaoba: {
        command: FAKE_XIAOBA,
        project_root: XIAOBA_PROJECT,
        roles_root: ROLES_ROOT,
        skills_root: SKILLS_ROOT,
        env_allowlist: ["FAKE_XIAOBA_SECRET", "FAKE_XIAOBA_ECHO_VALUE"],
      },
    }
  );

  assert.equal(
    result.status,
    "pass",
    JSON.stringify({
      summary: result.summary,
      reason_code: result.reason_code,
      inspector: result.inspector,
      reviewer: result.reviewer,
    })
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(forwardedSecret));
  assert.equal(result.evidence.otlp_forwarding?.status, "complete");
  assert.equal(result.evidence.otlp_forwarding?.forwarded_envelopes, 7);
  const createRequest = requests.find((item) =>
    item.path.endsWith("/v1/ingest/runs")
  );
  assert.ok(createRequest);
  const createPayload = JSON.parse(createRequest.body.toString("utf8")) as {
    input: { primary_trace_id: string; trace_ids: string[] };
  };
  const rootTraceId = createPayload.input.primary_trace_id;
  assert.match(rootTraceId, /^[a-f0-9]{32}$/);
  assert.deepEqual(createPayload.input.trace_ids, [rootTraceId]);
  assert.equal(result.evidence.root_trace_id, rootTraceId);

  const eventRequests = requests.filter((item) => item.path.endsWith("/events"));
  const events = eventRequests.map(
    (item) => JSON.parse(item.body.toString("utf8")) as EngineEventV1
  );
  assert.ok(events.length > 8);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1)
  );
  assert.ok(events.every((event) => event.trace_id === rootTraceId));
  assert.ok(events.slice(0, -1).every((event) => event.kind === "progress"));
  const terminal = events.at(-1)!;
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.actor, "engine");
  assert.equal(terminal.payload.schema, "barena.explore_terminal_fact.v1");
  assert.equal(terminal.payload.status, "pass");
  assert.ok("inspector" in terminal.payload);
  assert.ok("reviewer" in terminal.payload);
  assert.ok("replay_case_candidates" in terminal.payload);
  assert.ok(Buffer.byteLength(JSON.stringify(terminal.payload)) < 12 * 1024);
  assert.doesNotMatch(JSON.stringify(terminal.payload), /\/Users\/|\/private\/var\//);

  const otlpRequests = requests.filter(
    (item) => item.path === "/api/otel/v1/traces"
  );
  assert.equal(otlpRequests.length, 8);
  assert.equal(
    otlpRequests.filter((item) => item.contentType.includes("protobuf")).length,
    7
  );
  const summaryTrace = otlpRequests.find((item) =>
    item.contentType.includes("json")
  );
  assert.ok(summaryTrace);
  assert.match(summaryTrace.body.toString("utf8"), /barena\.explore/);
  assert.ok(
    summaryTrace.body
      .toString("utf8")
      .includes(Buffer.from(rootTraceId, "hex").toString("base64"))
  );

  assert.ok(requests.every((item) => item.authorization === `Bearer ${apiKey}`));
  assert.ok(requests.every((item) => !item.body.includes(apiKey)));
  assert.ok(requests.every((item) => !item.body.includes(forwardedSecret)));
  const finish = requests.at(-1)!;
  assert.ok(finish.path.endsWith("/finish"));
  assert.equal(JSON.parse(finish.body.toString("utf8")).state, "completed");
});

interface CapturedRequest {
  path: string;
  authorization: string;
  contentType: string;
  body: Buffer;
}

function otlpJson(traceId: string, value: string): Record<string, unknown> {
  const now = (BigInt(Date.now()) * 1_000_000n).toString();
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "receiver-test" } },
            { key: "test.secret", value: { stringValue: value } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "receiver-test" },
            spans: [
              {
                traceId: Buffer.from(traceId, "hex").toString("base64"),
                spanId: Buffer.from("2222222222222222", "hex").toString("base64"),
                name: "receiver.test",
                kind: 1,
                startTimeUnixNano: now,
                endTimeUnixNano: now,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

function temporaryRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-connected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
