#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "probe" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({
    schema: "barena.portable_target_probe.v1",
    status: "ready",
    target: { id: "hermes", version: "skillsbench-fixture-1" },
    detail: "SkillsBench portable fixture is ready.",
    capabilities: ["prompt_file", "workspace", "skill_selection", "session_identity"],
  }));
  process.exit(0);
}

if (args[0] !== "run" || args[1] !== "--request" || !args[2]) process.exit(3);
const request = JSON.parse(fs.readFileSync(path.resolve(args[2]), "utf8"));
const prompt = fs.readFileSync(request.prompt.path, "utf8");
const active = request.skill.mode === "path" ? [request.skill.name] : [];

if (request.skill.mode === "path") {
  fs.mkdirSync(request.workspace, { recursive: true });
  fs.writeFileSync(path.join(request.workspace, "solution.py"), "def parse_script(text: str):\n    return {}\n", "utf8");
  fs.writeFileSync(path.join(request.workspace, "dialogue.json"), JSON.stringify({
    nodes: [
      { id: "Start", text: "start", speaker: "Narrator", type: "line" },
      { id: "A", text: "a", speaker: "Guide", type: "line" },
      { id: "TavernChoice", text: "choose", speaker: "", type: "choice" },
      { id: "B", text: "b", speaker: "Guide", type: "line" },
      { id: "LoopChoice", text: "loop", speaker: "", type: "choice" },
      { id: "C", text: "c", speaker: "Guide", type: "line" },
      { id: "Exit", text: "exit", speaker: "Guide", type: "line" },
    ],
    edges: [
      { from: "Start", to: "A", text: "" },
      { from: "A", to: "TavernChoice", text: "" },
      { from: "TavernChoice", to: "B", text: "one" },
      { from: "B", to: "LoopChoice", text: "" },
      { from: "LoopChoice", to: "TavernChoice", text: "again" },
      { from: "LoopChoice", to: "C", text: "continue" },
      { from: "C", to: "Exit", text: "" },
      { from: "Exit", to: "End", text: "" },
      { from: "TavernChoice", to: "Exit", text: "leave" },
    ],
  }), "utf8");
}

process.stdout.write(JSON.stringify({
  schema: "barena.portable_target_result.v1",
  status: "completed",
  detail: "SkillsBench fixture completed.",
  session_id: request.session_id,
  provider: "offline",
  model: "skillsbench-fixture",
  observed: {
    prompt_sha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    workspace: request.workspace,
    skill: {
      mode: request.skill.mode,
      active_skill_names: active,
      ...(request.skill.mode === "path" && { selected_skill_fingerprint: request.skill.fingerprint }),
    },
  },
}));
