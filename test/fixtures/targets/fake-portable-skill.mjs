#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] === "probe" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({
    schema: "barena.portable_target_probe.v1",
    status: "ready",
    target: { id: "hermes", version: "paired-skill-test" },
    detail: "Fake portable Skill driver is ready.",
    capabilities: ["prompt_file", "workspace", "skill_selection", "session_identity"],
  }));
  process.exit(0);
}

if (args[0] !== "run" || args[1] !== "--request" || !args[2]) {
  process.stderr.write("usage: fake-portable-skill.mjs probe --json | run --request <request.json>\n");
  process.exit(3);
}

const request = JSON.parse(fs.readFileSync(path.resolve(args[2]), "utf8"));
if (request.schema !== "barena.portable_target_request.v1") {
  process.stderr.write("unsupported portable request schema\n");
  process.exit(3);
}

const prompt = fs.readFileSync(request.prompt.path);
const promptSha256 = crypto.createHash("sha256").update(prompt).digest("hex");
fs.mkdirSync(request.workspace, { recursive: true });
if (request.skill.mode === "path") {
  fs.writeFileSync(path.join(request.workspace, "result.txt"), "BARENA_PORTABLE_SKILL_OK\n", "utf8");
}

process.stdout.write(JSON.stringify({
  schema: "barena.portable_target_result.v1",
  status: "completed",
  detail: request.skill.mode === "path"
    ? "Candidate Skill produced the expected artifact."
    : "Baseline completed without the candidate Skill.",
  session_id: request.session_id,
  payload_texts: ["fake portable Skill driver completed"],
  provider: "offline",
  model: "deterministic-test-driver",
  observed: {
    prompt_sha256: promptSha256,
    workspace: request.workspace,
    skill: {
      mode: request.skill.mode,
      active_skill_names: request.skill.mode === "path" ? [request.skill.name] : [],
      ...(request.skill.mode === "path" && {
        selected_skill_fingerprint: request.skill.fingerprint,
      }),
    },
  },
}));
