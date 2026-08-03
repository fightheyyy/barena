import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compilePlatformCaseForReplay } from "../src/e2e";
import { executeEngineRequest } from "../src/engine-worker";
import { verifyRunPackageV1 } from "../src/engine-protocol";
import { readJson } from "../src/utils/fs";

test("Platform HTTP Case replays through the real Engine with trace context and artifact verification", async () => {
  const requests: Array<{ traceparent?: string; body: unknown }> = [];
  const otlpRequests: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.url === "/api/internal/barena/otel/v1/traces") {
        otlpRequests.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }));
        return;
      }
      requests.push({
        traceparent:
          typeof request.headers.traceparent === "string"
            ? request.headers.traceparent
            : undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ response: "CLARIFIED_AND_COMPLETE" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-http-replay-"));
  const caseBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "barena-http-case-"));
  try {
    const platformCase = validHttpPlatformCase(
      `http://127.0.0.1:${address.port}/chat`
    );
    const result = await executeEngineRequest({
      schema: "barena.engine_request.v1",
      request_id: "request-http-platform-001",
      run_id: "run-http-platform-001",
      operation: "replay",
      runs_root: runsRoot,
      input: { platform_case: platformCase, case_base_dir: caseBaseDir },
    }, {
      platformTelemetry: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "test-only-barena-gateway-secret-32-bytes",
      },
    });
    assert.equal(result.result.decision, "cleared");
    assert.equal(result.result.status, "pass");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.traceparent ?? "", /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      assert.deepEqual(request.body, {
        thread_id: assertString((request.body as Record<string, unknown>).thread_id),
        messages: [
          {
            role: "user",
            content: "Ask for the missing constraint before acting.",
          },
        ],
      });
    }
    const scorecard = result.result;
    assert.equal(scorecard.attempts[0]?.target.transport, "http");
    assert.equal(scorecard.attempts[0]?.target.native_trace_available, false);
    const boundaryRef = scorecard.attempts[0]?.target.boundary_trace_refs?.[0];
    assert.ok(boundaryRef && fs.existsSync(boundaryRef));
    assert.equal(
      fs.readFileSync(
        path.join(runsRoot, "run-http-platform-001", "workspace", "response.txt"),
        "utf8"
      ).trim(),
      "CLARIFIED_AND_COMPLETE"
    );
    const runRoot = path.join(runsRoot, "run-http-platform-001");
    const verified = verifyRunPackageV1(
      runRoot,
      readJson(path.join(runRoot, "run-package.json"))
    );
    assert.equal(verified.status, "complete");
    assert.ok(
      verified.files.some((entry) => entry.ref.endsWith("boundary-otel.ndjson"))
    );
    assert.equal(otlpRequests.length, 1);
    const resourceSpans = (otlpRequests[0]!.body as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    }).resourceSpans;
    const spans = resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    const spanNames = spans.map((span) => span.name);
    assert.ok(spanNames.includes("barena.replay"));
    assert.ok(spanNames.includes("barena.replay.probe"));
    assert.ok(spanNames.includes("barena.replay.verifier"));
    assert.ok(spanNames.includes("barena.http_agent.replay"));
    const traceIds = new Set(
      spans.map((span) =>
        Buffer.from(String(span.traceId), "base64").toString("hex")
      )
    );
    assert.equal(traceIds.size, 1);
    const exportedTraceId = [...traceIds][0]!;
    assert.ok(
      requests.every((request) => request.traceparent?.includes(exportedTraceId)),
      "every isolated attempt must share the exported Replay Trace"
    );
    const boundarySpanIds = spans
      .filter((span) => span.name === "barena.http_agent.replay")
      .map((span) => Buffer.from(String(span.spanId), "base64").toString("hex"));
    assert.equal(boundarySpanIds.length, requests.length);
    for (const request of requests) {
      assert.ok(boundarySpanIds.includes(request.traceparent?.split("-")[2] ?? ""));
    }
    assert.equal(
      otlpRequests[0]!.headers["x-barena-project-id"],
      "project-one"
    );
    assert.match(
      String(otlpRequests[0]!.headers["x-barena-gateway-signature"]),
      /^[a-f0-9]{64}$/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(caseBaseDir, { recursive: true, force: true });
  }
});

test("Platform HTTP compiler fails closed for unsupported replay and secret-shaped runtime fields", () => {
  const unsupported = validHttpPlatformCase("https://agent.example.test/chat");
  const unsupportedRuntime = unsupported.runtime as Record<string, unknown>;
  unsupportedRuntime.replay = {
    supported: false,
    reason: "Bearer authentication cannot be frozen into a Case",
  };
  assert.throws(
    () => compilePlatformCaseForReplay(unsupported),
    /HTTP Replay is unavailable: Bearer authentication/
  );

  const secret = validHttpPlatformCase("https://agent.example.test/chat");
  const secretRuntime = secret.runtime as Record<string, unknown>;
  secretRuntime.authorization = "Bearer do-not-store";
  assert.throws(
    () => compilePlatformCaseForReplay(secret),
    /contains unsupported fields: authorization/
  );
});

function validHttpPlatformCase(url: string): Record<string, unknown> {
  return {
    schema: "barena.case.v1",
    case_id: "case-http-platform-001",
    revision: 1,
    source_issue_id: "issue-http-platform-001",
    source_run_id: "run-platform-source-001",
    source_trace_id: "0123456789abcdef0123456789abcdef",
    title: "HTTP Agent skipped clarification",
    operation: "explore",
    input: {
      schema: "barena.platform_explore_scenario.v1",
      source: {
        kind: "langwatch_scenario_run",
        project_id: "project-one",
        scenario_run_id: "scenario-run-one",
        scenario_id: "scenario-one",
      },
      scenario: {
        name: "Clarification behavior",
        objective: "Ask for the missing constraint before acting.",
        criteria: ["The Agent asks one clarifying question"],
      },
      target: {
        type: "http",
        reference_id: "agent-one",
        name: "XiaoBa HTTP fixture",
      },
    },
    runtime: {
      schema: "barena.platform_http_runtime.v1",
      type: "http",
      reference_id: "agent-one",
      name: "XiaoBa HTTP fixture",
      replay: {
        supported: true,
        url,
        method: "POST",
        output_path: "$.response",
        timeout_ms: 5_000,
      },
    },
    replay_prompt: "Ask for the missing constraint before acting.",
    success_criteria: "The response confirms clarification.",
    verifier: {
      kind: "artifact_assertions",
      artifacts: [{ path: "response.txt", contains: "CLARIFIED" }],
    },
    created_at: "2026-07-31T08:00:00.000Z",
  };
}

function assertString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
