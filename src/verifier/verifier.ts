import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RunManifest, VerifierResult } from "../domain/types";
import { writeJson } from "../utils/fs";

export function runVerifier(verifierPath: string | null, run: RunManifest): VerifierResult[] {
  if (!verifierPath) {
    return [];
  }

  const absoluteVerifier = path.resolve(verifierPath);
  if (!fs.existsSync(absoluteVerifier)) {
    throw new Error(`Verifier not found: ${absoluteVerifier}`);
  }

  const started = Date.now();
  const command = verifierCommand(absoluteVerifier);
  const result = spawnSync(command.command, command.args, {
    cwd: run.paths.workspace,
    env: {
      ...process.env,
      BARENA_RUN_ROOT: run.paths.run_root,
      BARENA_WORKSPACE: run.paths.workspace,
      BARENA_ARTIFACTS: run.paths.artifacts,
      BARENA_TRACES: run.paths.traces,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const verifierResult: VerifierResult = {
    verifier_id: path.basename(absoluteVerifier),
    status: result.error ? "blocked" : result.status === 0 ? "pass" : "fail",
    command: [command.command, ...command.args].join(" "),
    exit_code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? String(result.error) : result.stderr ?? "",
    duration_ms: Date.now() - started,
  };

  writeJson(path.join(run.paths.verifier, "verifier-results.json"), [verifierResult]);
  return [verifierResult];
}

function verifierCommand(verifierPath: string): { command: string; args: string[] } {
  if (verifierPath.endsWith(".js") || verifierPath.endsWith(".cjs") || verifierPath.endsWith(".mjs")) {
    return { command: process.execPath, args: [verifierPath] };
  }
  return { command: verifierPath, args: [] };
}

