#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

const host = process.env.FAKE_XIAOBA_HOST ?? "127.0.0.1";
const requestedPort = Number(process.env.FAKE_XIAOBA_PORT ?? "8899");
const chatMode = process.env.FAKE_XIAOBA_CHAT_MODE ?? "done";
const otlpEndpoint = process.env.FAKE_XIAOBA_OTLP_ENDPOINT;
const otlpApiKey = process.env.FAKE_XIAOBA_OTLP_API_KEY;
const requests = [];
const modelRequests = [];
const threadTurns = new Map();

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error("FAKE_XIAOBA_PORT must be an integer from 0 to 65535");
}
if ((otlpEndpoint && !otlpApiKey) || (!otlpEndpoint && otlpApiKey)) {
  throw new Error(
    "FAKE_XIAOBA_OTLP_ENDPOINT and FAKE_XIAOBA_OTLP_API_KEY must be supplied together",
  );
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJSON(response, 200, { status: "ok", requests: requests.length });
    return;
  }
  if (request.method === "GET" && request.url === "/state") {
    writeJSON(response, 200, {
      requests: requests.map(({ traceId, messageCount, sessionId }) => ({
        trace_id: traceId,
        message_count: messageCount,
        ...(sessionId && { session_id: sessionId }),
      })),
      model_requests: modelRequests,
    });
    return;
  }
  if (
    request.method === "GET" &&
    (request.url === "/v1/models" || request.url === "/go/proxy/v1/models")
  ) {
    writeJSON(response, 200, {
      object: "list",
      data: [
        {
          id: "gpt-5.6-sol",
          object: "model",
          owned_by: "barena-acceptance",
        },
      ],
    });
    return;
  }
  if (
    request.method === "POST" &&
    (request.url === "/v1/chat/completions" ||
      request.url === "/go/proxy/v1/chat/completions")
  ) {
    try {
      const body = await readJSON(request);
      writeJSON(response, 200, deterministicModelCompletion(body));
    } catch (error) {
      writeJSON(response, 400, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "invalid_request_error",
        },
      });
    }
    return;
  }
  if (request.method !== "POST" || request.url !== "/chat") {
    writeJSON(response, 404, { error: "not_found" });
    return;
  }

  try {
    const body = await readJSON(request);
    const messages = Array.isArray(body?.messages) ? body.messages : undefined;
    if (
      !messages ||
      messages.length === 0 ||
      messages.some(
        (message) =>
          !message ||
          typeof message !== "object" ||
          typeof message.role !== "string" ||
          typeof message.content !== "string",
      )
    ) {
      writeJSON(response, 400, { error: "messages_required" });
      return;
    }

    const traceContext = parseTraceparent(request.headers.traceparent);
    if (!traceContext) {
      writeJSON(response, 400, { error: "traceparent_required" });
      return;
    }
    const result = chatResponse({ body, messages });
    const sessionId =
      typeof body.session_id === "string" && body.session_id.trim()
        ? body.session_id.trim()
        : undefined;
    requests.push({
      traceId: traceContext.traceId,
      messageCount: messages.length,
      sessionId,
    });
    await exportOtlpSpan({
      traceContext,
      input: messages.at(-1).content,
      output: result,
      sessionId,
    });
    writeJSON(response, 200, { response: result });
  } catch (error) {
    writeJSON(response, 502, {
      error: "fixture_failure",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function chatResponse({ body, messages }) {
  if (chatMode !== "customer-support") {
    return "DONE: XiaoBaOS completed the requested task and left deterministic evidence for Replay.";
  }

  const threadId =
    typeof body.thread_id === "string" && body.thread_id.trim()
      ? body.thread_id.trim()
      : "default";
  const turn = (threadTurns.get(threadId) ?? 0) + 1;
  threadTurns.set(threadId, turn);
  if (turn === 1) {
    return "很抱歉订单还没有送达。请先提供订单号，我会据此帮你发起物流核查。";
  }
  const lastMessage = messages.at(-1)?.content ?? "";
  return `收到你提供的信息（${lastMessage}）。我现在还不能确认包裹的具体位置，也不会编造物流状态；下一步会提交物流核查，并在承运方返回结果后同步给你。`;
}

function deterministicModelCompletion(body) {
  const model = typeof body?.model === "string" ? body.model : "gpt-5.6-sol";
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const finishTool = tools.find(
    (tool) => tool?.type === "function" && tool?.function?.name === "finish_test",
  );
  const id = `chatcmpl_${crypto.randomBytes(8).toString("hex")}`;
  const base = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    usage: {
      prompt_tokens: 24,
      completion_tokens: 12,
      total_tokens: 36,
    },
  };

  if (finishTool) {
    const criteriaProperties =
      finishTool.function?.parameters?.properties?.criteria?.properties ?? {};
    const criteria = Object.fromEntries(
      Object.keys(criteriaProperties).map((name) => [name, "true"]),
    );
    modelRequests.push({ kind: "judge", model, criteria: Object.keys(criteria) });
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${crypto.randomBytes(8).toString("hex")}`,
                type: "function",
                function: {
                  name: "finish_test",
                  arguments: JSON.stringify({
                    criteria,
                    reasoning:
                      "The target explicitly reported DONE and confirmed deterministic Replay evidence.",
                    verdict: "success",
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
  }

  modelRequests.push({ kind: "user-simulator", model });
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "finish the task and leave deterministic evidence for replay",
        },
        finish_reason: "stop",
      },
    ],
  };
}

server.listen(requestedPort, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture did not bind to a TCP address");
  }
  process.stdout.write(
    `${JSON.stringify({
      fixture: "xiaoba-http-agent",
      url: `http://${host}:${address.port}/chat`,
      health: `http://${host}:${address.port}/healthz`,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function exportOtlpSpan({
  traceContext,
  input,
  output,
  sessionId,
}) {
  if (!otlpEndpoint || !otlpApiKey) return;
  const start = BigInt(Date.now()) * 1_000_000n;
  const spanId = crypto.randomBytes(8).toString("hex");
  const attributes = [
    attribute("gen_ai.operation.name", "chat"),
    attribute("gen_ai.request.model", "xiaoba-http-fixture"),
    attribute("gen_ai.prompt.0.role", "user"),
    attribute("gen_ai.prompt.0.content.0.text", input),
    attribute("gen_ai.completion.0.role", "assistant"),
    attribute("gen_ai.completion.0.content.0.text", output),
    attribute("barena.actor.role", "target-agent"),
    attribute("barena.runtime.id", "xiaoba-http-fixture"),
  ];
  if (sessionId) attributes.push(attribute("barena.session.id", sessionId));

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", "xiaoba-http-fixture"),
            attribute("service.version", "1.0.0"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "barena.acceptance.xiaoba", version: "1.0.0" },
            spans: [
              {
                // OTLP/JSON carries identifiers as lowercase hex. This also
                // keeps the target span in the exact W3C trace received from
                // the Scenario caller instead of creating a base64-named trace.
                traceId: traceContext.traceId,
                spanId,
                parentSpanId: traceContext.parentSpanId,
                name: "xiaoba.role.turn",
                // The LangWatch JSON receiver forwards this object directly to
                // its canonical OTLP schema. Keep enum fields numeric, as they
                // are after a normal protobuf decode (SERVER=2, OK=1).
                kind: 2,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: (start + 2_000_000n).toString(),
                attributes,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  const result = await fetch(otlpEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${otlpApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!result.ok) {
    const detail = (await result.text()).slice(0, 300);
    throw new Error(`OTLP receiver returned ${result.status}: ${detail}`);
  }
}

function parseTraceparent(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i,
  );
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return {
    traceId: match[1].toLowerCase(),
    parentSpanId: match[2].toLowerCase(),
  };
}

function attribute(key, value) {
  return { key, value: { stringValue: String(value) } };
}

async function readJSON(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request_too_large");
  }
  return JSON.parse(body);
}

function writeJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
