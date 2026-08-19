#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_DSH_LOG;
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(argv)}\n`, "utf8");
}

if (argv.includes("--version")) {
  console.log("0.1.0-test");
  process.exit(0);
}

if (argv.includes("--help")) {
  console.log("Usage: dsh --profile <name> [--patch <path>] <job>");
  process.exit(0);
}

if (process.env.DSH_TELEMETRY_MODE !== "DISABLED") {
  console.error("DSH_TELEMETRY_MODE must use the public DISABLED enum");
  process.exit(2);
}

if (argv[0] === "plugin") {
  const addIndex = argv.indexOf("add");
  const pluginPath = addIndex >= 0 ? argv[addIndex + 1] : undefined;
  if (!pluginPath || !fs.existsSync(path.join(pluginPath, "package.json"))) {
    console.error("plugin package missing");
    process.exit(2);
  }
  const home = process.env.DSH_HOME;
  if (home) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "plugin-installed.txt"), pluginPath, "utf8");
  }
  console.log("plugin installed");
  process.exit(0);
}

const profileIndex = argv.indexOf("--profile");
if (profileIndex < 0 || argv[profileIndex + 1] !== "headless") {
  console.error("headless profile required");
  process.exit(2);
}
const prompt = argv.at(-1) ?? "";
const home = process.env.DSH_HOME;
if (!home) {
  console.error("DSH_HOME required");
  process.exit(2);
}
const sessions = path.join(home, "sessions");
fs.mkdirSync(sessions, { recursive: true });
const id = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
fs.writeFileSync(
  path.join(sessions, `${id}.jsonl.zstd`),
  `${JSON.stringify({ type: "user", content: prompt })}\n`,
  "utf8"
);
fs.writeFileSync(
  path.join(process.cwd(), "dsh-plan.md"),
  "# DSH plan\n\n1. Clarify the constraint\n2. Produce one bounded next action\n",
  "utf8"
);
const previousVisible = prompt.includes("先确认今天唯一的硬截止");
console.log(
  previousVisible
    ? "半小时可以拆成：5 分钟确认结果、20 分钟完成核心步骤、5 分钟检查。"
    : "先确认今天唯一的硬截止，再完成影响最大的交付。你今天有多少可用时间？"
);
