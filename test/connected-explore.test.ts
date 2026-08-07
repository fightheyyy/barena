import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAdHocExploreScenario,
  runConnectedExploreScenario,
  type ConnectedExploreSyncRecordV1,
} from "../src/explore";
import type { EngineEventV1 } from "../src/engine-protocol";
import type { PlatformRunBundleV1 } from "../src/platform-client";
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
  const runsRoot = path.join(root, "runs");
  const forwardedSecret = "CONNECTED_ONLY_SECRET_VALUE";
  const previousSecret = process.env.FAKE_XIAOBA_SECRET;
  const previousEcho = process.env.FAKE_XIAOBA_ECHO_VALUE;
  process.env.FAKE_XIAOBA_SECRET = forwardedSecret;
  process.env.FAKE_XIAOBA_ECHO_VALUE = "1";
  t.after(() => restoreEnv("FAKE_XIAOBA_SECRET", previousSecret));
  t.after(() => restoreEnv("FAKE_XIAOBA_ECHO_VALUE", previousEcho));
  const requests: CapturedRequest[] = [];
  let firstCloudRequestSealed: boolean | undefined;
  let locallySealed = false;
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    if (firstCloudRequestSealed === undefined) {
      firstCloudRequestSealed =
        fs.existsSync(runsRoot) &&
        fs.readdirSync(runsRoot).some((runId) =>
          [
            path.join(runsRoot, runId, "explore-result.json"),
            path.join(runsRoot, runId, "telemetry", "otlp", "manifest.json"),
          ].every((filePath) => fs.existsSync(filePath)),
        );
    }
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      contentType: request.headers["content-type"] ?? "",
      idempotencyKey: request.headers["idempotency-key"] ?? "",
      body,
    });
    if (
      request.method === "POST" &&
      request.url === "/v1/ingest/run-bundles"
    ) {
      const bundle = JSON.parse(body.toString("utf8")) as PlatformRunBundleV1;
      locallySealed = [
        path.join(runsRoot, bundle.run.run_id, "explore-result.json"),
        path.join(runsRoot, bundle.run.run_id, "reports", "report.json"),
        path.join(
          runsRoot,
          bundle.run.run_id,
          "telemetry",
          "otlp",
          "manifest.json",
        ),
      ].every((filePath) => fs.existsSync(filePath));
      respondJson(response, 201, {
        schema: "barena.run_bundle_receipt.v1",
        run_bundle_id: "bundle-connected-e2e",
        run: { run_id: bundle.run.run_id },
        events: bundle.events,
        trace_ids: [bundle.events.at(-1)?.trace_id],
      });
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/otlp/v1/traces"
    ) {
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
  const apiKey = "barena_pat_connected-e2e-key";

  const result = await runConnectedExploreScenario(
    createAdHocExploreScenario({
      role: "secretary-cat",
      task: "帮助表达不完整的用户形成今天可执行的优先级计划。",
      max_turns: 4,
      timeout_ms: 10_000,
    }),
    {
      platform: { url: platformURL, apiKey },
      runs_root: runsRoot,
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
  assert.equal(result.evidence.otlp_forwarding, undefined);
  const bundleRequest = requests.find((item) =>
    item.path.endsWith("/v1/ingest/run-bundles")
  );
  assert.ok(bundleRequest);
  const bundle = JSON.parse(
    bundleRequest.body.toString("utf8"),
  ) as PlatformRunBundleV1;
  const rootTraceId = bundle.run.input.primary_trace_id as string;
  assert.match(rootTraceId, /^[a-f0-9]{32}$/);
  assert.deepEqual(bundle.run.input.trace_ids, [rootTraceId]);
  assert.equal(result.evidence.root_trace_id, rootTraceId);

  const events = bundle.events as EngineEventV1[];
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
  assert.equal(
    bundle.terminal_fact_sha256,
    crypto
      .createHash("sha256")
      .update(JSON.stringify(terminal.payload))
      .digest("hex"),
  );
  assert.equal(bundle.run.run_id, result.run_id);
  assert.equal(bundle.run.state, "completed");
  assert.equal(firstCloudRequestSealed, true);
  assert.equal(locallySealed, true);
  assert.equal(
    bundleRequest.idempotencyKey,
    `barena:${result.run_id}:explore`,
  );

  const otlpRequests = requests.filter(
    (item) => item.path === "/v1/otlp/v1/traces"
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
  assert.equal(requests.at(-1)?.path, "/v1/ingest/run-bundles");
  const sync = JSON.parse(
    fs.readFileSync(path.join(result.paths.run_root, "catena", "sync.json"), "utf8"),
  ) as ConnectedExploreSyncRecordV1;
  assert.equal(sync.status, "synced");
  assert.equal(sync.native_otlp.status, "synced");
  assert.equal(sync.native_otlp.synced_envelopes, 7);
  assert.equal(sync.summary_otlp.status, "synced");
  assert.equal(sync.run_bundle.status, "synced");
  assert.equal(sync.run_bundle.transport, "run_bundle");
  assert.equal(sync.run_bundle.remote_run_id, result.run_id);
});

test("Catena failure is recorded without changing the sealed local Explore conclusion", { concurrency: false }, async (t) => {
  const root = temporaryRoot(t);
  const previousEcho = process.env.FAKE_XIAOBA_ECHO_VALUE;
  process.env.FAKE_XIAOBA_ECHO_VALUE = "1";
  t.after(() => restoreEnv("FAKE_XIAOBA_ECHO_VALUE", previousEcho));
  const server = http.createServer(async (request, response) => {
    await readBody(request);
    if (request.url === "/v1/otlp/v1/traces") {
      respondJson(response, 200, { partialSuccess: {} });
      return;
    }
    if (request.url === "/v1/ingest/run-bundles") {
      respondJson(response, 503, { detail: "Catena unavailable" });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const result = await runConnectedExploreScenario(
    createAdHocExploreScenario({
      role: "secretary-cat",
      task: "形成一个今天可执行的优先级计划。",
      max_turns: 4,
      timeout_ms: 10_000,
    }),
    {
      platform: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "barena_pat_cloud-failure-key",
      },
      runs_root: path.join(root, "runs"),
      xiaoba: {
        command: FAKE_XIAOBA,
        project_root: XIAOBA_PROJECT,
        roles_root: ROLES_ROOT,
        skills_root: SKILLS_ROOT,
        env_allowlist: ["FAKE_XIAOBA_ECHO_VALUE"],
      },
    },
  );

  assert.equal(result.status, "pass");
  const sealed = JSON.parse(
    fs.readFileSync(result.paths.report_json, "utf8"),
  ) as { status: string; summary: string };
  assert.equal(sealed.status, "pass");
  assert.equal(sealed.summary, result.summary);
  const sync = JSON.parse(
    fs.readFileSync(path.join(result.paths.run_root, "catena", "sync.json"), "utf8"),
  ) as ConnectedExploreSyncRecordV1;
  assert.equal(sync.status, "failed");
  assert.equal(sync.native_otlp.status, "synced");
  assert.equal(sync.summary_otlp.status, "synced");
  assert.equal(sync.run_bundle.status, "failed");
  assert.match(sync.errors.join("\n"), /Run Bundle.*503.*Catena unavailable/);
});

interface CapturedRequest {
  path: string;
  authorization: string;
  contentType: string;
  idempotencyKey: string;
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
