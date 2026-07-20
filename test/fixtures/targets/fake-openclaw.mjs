import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("openclaw 2026.7.1-test\n");
  process.exit(0);
}

if (args[0] === "agent" && args.includes("--help")) {
  process.stdout.write("openclaw agent --local --message-file --session-key --timeout --json\n");
  process.exit(0);
}

if (args[0] === "skills" && args[1] === "check" && args.includes("--help")) {
  process.stdout.write("openclaw skills check --agent --json\n");
  process.exit(0);
}

const config = process.env.OPENCLAW_CONFIG_PATH && fs.existsSync(process.env.OPENCLAW_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"))
  : {};
const agentId = (() => {
  const index = args.indexOf("--agent");
  return index === -1 ? "main" : args[index + 1];
})();
const agentConfig = config?.agents?.list?.find((agent) => agent.id === agentId);
const eligibleSkills = Array.isArray(agentConfig?.skills)
  ? agentConfig.skills.filter((name) => fs.existsSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR ?? "", "skills", name, "SKILL.md")))
  : [];

if (args[0] === "skills" && args[1] === "check") {
  process.stdout.write(JSON.stringify({ eligible: eligibleSkills.map((name) => ({ name })) }));
  process.exit(0);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const messageFile = valueAfter("--message-file");
const sessionKey = valueAfter("--session-key");
if (!messageFile || !sessionKey) {
  process.stderr.write("missing required fake-openclaw arguments\n");
  process.exit(2);
}

const prompt = fs.readFileSync(messageFile, "utf8");
fs.writeFileSync(
  path.join(process.cwd(), "fake-openclaw-invocation.json"),
  `${JSON.stringify({ args, prompt, sessionKey, eligibleSkills }, null, 2)}\n`,
  "utf8"
);

if (prompt.includes("FAKE_INVALID_JSON")) {
  process.stdout.write("diagnostic before invalid json\n{not-json}\n");
  process.exit(0);
}

if (!prompt.includes("FAKE_NO_ARTIFACT") && (!prompt.includes("FAKE_REQUIRE_SKILL") || eligibleSkills.length > 0)) {
  fs.writeFileSync(path.join(process.cwd(), "result.txt"), "BARENA_E2E_OK\n", "utf8");
}

const meta = {
  durationMs: 12,
  agentMeta: {
    sessionId: sessionKey,
    provider: "fake-provider",
    model: "fake-model"
  },
  stopReason: "completed",
  toolSummary: {
    calls: 1,
    tools: ["write"],
    failures: 0
  },
  ...(prompt.includes("FAKE_META_ERROR") ? { error: "injected fake error" } : {})
};

process.stdout.write(
  JSON.stringify({
    payloads: [
      { text: "working", mediaUrl: null, mediaUrls: [] },
      { text: "done", mediaUrl: null, mediaUrls: [] }
    ],
    meta
  })
);
