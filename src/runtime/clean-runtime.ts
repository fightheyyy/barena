import crypto from "node:crypto";
import path from "node:path";
import { RunManifest, SubjectManifest } from "../domain/types";
import { ensureDir, writeJson } from "../utils/fs";

export interface CreateRunOptions {
  runsRoot?: string;
}

export function createCleanRun(subject: SubjectManifest, options: CreateRunOptions = {}): RunManifest {
  const runsRoot = path.resolve(options.runsRoot ?? "runs");
  const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const runRoot = path.join(runsRoot, runId);
  const manifest: RunManifest = {
    run_id: runId,
    subject_id: subject.subject_id,
    subject_type: subject.type,
    created_at: new Date().toISOString(),
    adapter: "xiaoba",
    paths: {
      run_root: runRoot,
      workspace: path.join(runRoot, "workspace"),
      traces: path.join(runRoot, "traces"),
      artifacts: path.join(runRoot, "artifacts"),
      inspector: path.join(runRoot, "inspector"),
      reviewer: path.join(runRoot, "reviewer"),
      scan: path.join(runRoot, "scan"),
      replays: path.join(runRoot, "replays"),
      verifier: path.join(runRoot, "verifier"),
      reports: path.join(runRoot, "reports"),
    },
  };

  for (const dir of Object.values(manifest.paths)) {
    ensureDir(dir);
  }
  writeJson(path.join(runRoot, "run-manifest.json"), manifest);
  return manifest;
}
