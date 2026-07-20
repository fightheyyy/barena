#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] === "probe" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({
    schema: "barena.portable_target_probe.v1",
    status: "ready",
    target: { id: "hermes", version: "offline-conformance-1" },
    detail: "Offline Hermes-compatible portable driver is ready.",
    capabilities: ["prompt_file", "workspace", "skill_selection", "session_identity"],
  }));
  process.exit(0);
}

if (args[0] !== "run" || args[1] !== "--request" || !args[2]) {
  process.stderr.write("usage: portable-driver.mjs probe --json | run --request <request.json>\n");
  process.exit(3);
}

const request = JSON.parse(fs.readFileSync(path.resolve(args[2]), "utf8"));
if (request.schema !== "barena.portable_target_request.v1") {
  process.stderr.write("unsupported portable request schema\n");
  process.exit(3);
}

const prompt = fs.readFileSync(request.prompt.path, "utf8");
const promptSha256 = crypto.createHash("sha256").update(prompt).digest("hex");
if (prompt.includes("BARENA_DRIVER_TIMEOUT")) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (prompt.includes("BARENA_DRIVER_MALFORMED")) {
  process.stdout.write("not-json");
  process.exit(0);
}

fs.mkdirSync(request.workspace, { recursive: true });
if (!prompt.includes("BARENA_DRIVER_NO_ARTIFACT") && !prompt.includes("BARENA_DRIVER_BLOCKED")) {
  fs.writeFileSync(path.join(request.workspace, "result.txt"), "BARENA_PORTABLE_OK\n", "utf8");
}

const selectedSkill = request.skill.mode === "path" ? request.skill.name : undefined;
const activeSkillNames = prompt.includes("BARENA_DRIVER_BASELINE_LEAK")
  ? ["unexpected-skill"]
  : prompt.includes("BARENA_DRIVER_SKILL_INVISIBLE")
    ? []
    : selectedSkill
      ? [selectedSkill]
      : [];
const status = prompt.includes("BARENA_DRIVER_UNSAFE")
  ? "unsafe"
  : prompt.includes("BARENA_DRIVER_BLOCKED")
    ? "blocked"
    : "completed";

process.stdout.write(JSON.stringify({
  schema: "barena.portable_target_result.v1",
  status,
  detail: status === "unsafe"
    ? "Offline driver reported an unsafe outcome."
    : status === "blocked"
      ? "Offline driver reported a blocked outcome."
      : "Offline driver completed the requested workspace task.",
  session_id: prompt.includes("BARENA_DRIVER_DUPLICATE_SESSION") ? "duplicate-session" : request.session_id,
  payload_texts: ["portable driver completed"],
  provider: "offline",
  model: "deterministic-conformance-driver",
  observed: {
    prompt_sha256: prompt.includes("BARENA_DRIVER_WRONG_HASH") ? "0".repeat(64) : promptSha256,
    workspace: request.workspace,
    skill: {
      mode: request.skill.mode,
      active_skill_names: activeSkillNames,
      ...(request.skill.mode === "path" && {
        selected_skill_fingerprint: request.skill.fingerprint,
      }),
    },
  },
}));
