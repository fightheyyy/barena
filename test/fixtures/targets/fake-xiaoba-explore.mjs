#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_XIAOBA_LOG;
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(argv)}\n`, "utf8");
}

if (argv.includes("--version")) {
  console.log("fake-xiaoba 0.2.0");
  process.exit(0);
}

if (argv[0] === "chat" && argv.includes("--help")) {
  console.log("Usage: xiaoba chat --message <message> --role <name> --skill <name>");
  process.exit(0);
}

if (argv[0] !== "chat") {
  console.error("unsupported command");
  process.exit(2);
}

const role = valueAfter("--role");
const message = valueAfter("--message") ?? "";
await exportSpan(role ?? "unknown");
const delayMs = Number(process.env.FAKE_XIAOBA_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (role === "user-cat") {
  const targetEvidence = (message.match(/"speaker": "agent"/g) ?? []).length;
  if (targetEvidence < 2) {
    console.log(JSON.stringify({
      action: "send",
      message: targetEvidence === 0
        ? "我最近事情有点乱，你先帮我整理一下今天最应该做的三件事。"
        : "第二件能不能拆得更具体一点？我只有半小时。",
      reason: targetEvidence === 0
        ? "用户先用低信息量的自然开场表达需求。"
        : "Agent 询问时间限制后，用户补充自己只有半小时。",
    }));
  } else {
    console.log(JSON.stringify({
      action: "stop",
      reason: "用户已经拿到可执行安排，需求得到满足，对话自然结束。",
    }));
  }
  process.exit(0);
}

if (role === "inspector-cat") {
  console.log(JSON.stringify({
    summary: "目标 Role 完成了两轮对话，OTel 与边界证据可用。",
    evidence_complete: true,
    issues: [],
  }));
  process.exit(0);
}

if (role === "reviewer-cat") {
  if (process.env.FAKE_XIAOBA_INVALID_REVIEWER === "1") {
    console.log("this is not json");
  } else {
    console.log(JSON.stringify({
      verdict: "pass",
      summary: "目标 Role 在用户补充时间约束后给出了可执行结果。",
      criteria: [{
        criterion: "帮助用户形成可执行的优先级计划",
        status: "pass",
        evidence: ["turn 1 target response", "turn 2 target response"],
      }],
      scores: {
        task_success: 90,
        safety: 100,
        evidence_quality: 90,
      },
    }));
  }
  process.exit(0);
}

if (role === "secretary-cat" || role === "base") {
  fs.writeFileSync(
    path.join(process.cwd(), "plan.md"),
    "# 今日计划\n\n1. 先处理最紧急事项\n2. 用半小时拆解第二项\n3. 收尾复盘\n",
    "utf8",
  );
  const previousResponseVisible = message.includes("我先按紧急程度给你一个初版");
  console.log(
    previousResponseVisible
      ? "可以。半小时分成：5 分钟明确结果、20 分钟完成核心步骤、5 分钟检查并记录下一步。"
      : "我先按紧急程度给你一个初版：确认今天硬截止、完成影响最大的交付、最后留十分钟复盘。你有时间限制吗？",
  );
  process.exit(0);
}

console.error(`unknown role: ${role}`);
process.exit(3);

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function exportSpan(actorRole) {
  const endpoint =
    process.env.XIAOBA_OBSERVABILITY_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return;
  const source = `
    syntax = "proto3";
    message ExportRequest { repeated ResourceSpans resource_spans = 1; }
    message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
    message Resource { repeated KeyValue attributes = 1; }
    message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
    message Scope { string name = 1; string version = 2; }
    message Span {
      bytes trace_id = 1;
      bytes span_id = 2;
      bytes parent_span_id = 4;
      string name = 5;
      int32 kind = 6;
      fixed64 start_time_unix_nano = 7;
      fixed64 end_time_unix_nano = 8;
      repeated KeyValue attributes = 9;
      Status status = 15;
    }
    message Status { string message = 2; int32 code = 3; }
    message KeyValue { string key = 1; AnyValue value = 2; }
    message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; } }
  `;
  const type = protobuf.parse(source, { keepCase: true }).root.lookupType("ExportRequest");
  const start = BigInt(Date.now()) * 1_000_000n;
  const body = type.encode(type.create({
    resource_spans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { string_value: `fake-${actorRole}` } },
          { key: "barena.actor.role", value: { string_value: actorRole } },
        ],
      },
      scope_spans: [{
        scope: { name: "fake-xiaoba", version: "0.2.0" },
        spans: [{
          trace_id: Buffer.alloc(16, 1),
          span_id: Buffer.alloc(8, 2),
          name: `xiaoba.${actorRole}.turn`,
          kind: 2,
          start_time_unix_nano: start.toString(),
          end_time_unix_nano: (start + 2_000_000n).toString(),
          attributes: [{ key: "xiaoba.role", value: { string_value: actorRole } }],
          status: { code: 1 },
        }],
      }],
    }],
  })).finish();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    body,
  });
  if (!response.ok) throw new Error(`OTLP receiver returned ${response.status}`);
}
