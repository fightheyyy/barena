#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const logIndex = rawArgs.indexOf("--invocation-log");
const invocationLog = logIndex >= 0 ? rawArgs[logIndex + 1] : undefined;
const args = logIndex >= 0
  ? rawArgs.filter((_, index) => index !== logIndex && index !== logIndex + 1)
  : rawArgs;

if (invocationLog) {
  fs.mkdirSync(path.dirname(invocationLog), { recursive: true });
  fs.appendFileSync(invocationLog, `${JSON.stringify({ args, cwd: process.cwd(), env: {
    project_root: process.env.XIAOBA_PROJECT_ROOT,
    roles_root: process.env.XIAOBA_ROLES_ROOT,
    skills_root: process.env.XIAOBA_SKILLS_ROOT,
  } })}\n`, "utf8");
}

if (args.includes("arena")) {
  process.stderr.write("Arena must never be invoked by this fixture.\n");
  process.exit(97);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("0.2.0\n");
  process.exit(0);
}

if (args[0] === "chat" && args.includes("--help")) {
  process.stdout.write("xiaoba chat --role <name> --message <message> --skill <name>\n");
  process.exit(0);
}

if (args[0] !== "chat") {
  process.stderr.write("unsupported command\n");
  process.exit(2);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const role = value("--role");
const prompt = value("--message");
const skill = value("--skill");
if (!role || !prompt) {
  process.stderr.write("missing role or message\n");
  process.exit(2);
}

fs.writeFileSync(path.join(process.cwd(), "fake-xiaoba-invocation.json"), JSON.stringify({ args, role, prompt, skill }), "utf8");
if (skill) {
  fs.writeFileSync(path.join(process.cwd(), "result.txt"), "BARENA_E2E_OK\n", "utf8");
}
const traceDir = path.join(process.cwd(), "logs", "sessions", "cli", "fake-session");
fs.mkdirSync(traceDir, { recursive: true });
fs.writeFileSync(path.join(traceDir, "traces.jsonl"), `${JSON.stringify({
  schema_version: 3,
  entry_type: "trace",
  user: { text: prompt },
  assistant: { text: skill ? "candidate completed" : "baseline completed", tool_calls: [] },
})}\n`, "utf8");
process.stdout.write(skill ? "candidate completed\n" : "baseline completed\n");
