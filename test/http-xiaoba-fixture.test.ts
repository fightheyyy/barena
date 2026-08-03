import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

test("XiaoBa HTTP acceptance fixture requires trace context and exports the same trace", async () => {
  let receivedTraceId = "";
  const otlp = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
    receivedTraceId = exportedSpan.traceId;
    assert.equal(request.headers.authorization, "Bearer fixture-project-key");
    assert.equal(exportedSpan.kind, 2);
    assert.equal(exportedSpan.status.code, 1);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  otlp.listen(0, "127.0.0.1");
  await once(otlp, "listening");
  const otlpAddress = otlp.address();
  assert(otlpAddress && typeof otlpAddress !== "string");

  const child = spawn(
    process.execPath,
    [resolve("test/fixtures/targets/fake-xiaoba-http-agent.mjs")],
    {
      env: {
        ...process.env,
        FAKE_XIAOBA_PORT: "0",
        FAKE_XIAOBA_OTLP_ENDPOINT: `http://127.0.0.1:${otlpAddress.port}/v1/traces`,
        FAKE_XIAOBA_OTLP_API_KEY: "fixture-project-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const line = await firstLine(child.stdout!);
    const fixture = JSON.parse(line) as { url: string };
    const traceId = "11111111111111111111111111111111";
    const response = await fetch(fixture.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        traceparent: `00-${traceId}-2222222222222222-01`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "finish the task" }],
        session_id: "session-one",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      response:
        "DONE: XiaoBaOS completed the requested task and left deterministic evidence for Replay.",
    });
    assert.equal(receivedTraceId, traceId);

    const missingTrace = await fetch(fixture.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "finish the task" }],
      }),
    });
    assert.equal(missingTrace.status, 400);

    const fixtureBase = new URL(fixture.url).origin;
    const simulatedUser = await fetch(
      `${fixtureBase}/go/proxy/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "simulate a user" }],
        }),
      },
    );
    assert.equal(simulatedUser.status, 200);
    assert.equal(
      (await simulatedUser.json()).choices[0].message.content,
      "finish the task and leave deterministic evidence for replay",
    );

    const judged = await fetch(`${fixtureBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        tools: [
          {
            type: "function",
            function: {
              name: "finish_test",
              parameters: {
                type: "object",
                properties: {
                  criteria: {
                    type: "object",
                    properties: { reports_done: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    });
    assert.equal(judged.status, 200);
    const judgedBody = await judged.json();
    assert.equal(
      judgedBody.choices[0].message.tool_calls[0].function.name,
      "finish_test",
    );
    assert.deepEqual(
      JSON.parse(
        judgedBody.choices[0].message.tool_calls[0].function.arguments,
      ).criteria,
      { reports_done: "true" },
    );
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolveClose) => otlp.close(() => resolveClose()));
  }
});

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline);
  }
  throw new Error("fixture exited before announcing its URL");
}
