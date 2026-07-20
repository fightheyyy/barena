import fs from "node:fs";
import path from "node:path";
import { RuntimeAdapter } from "../adapters/xiaoba/types";
import { inspectTrace } from "../cats/inspector-cat";
import { ReplayAttempt, RunManifest, SubjectManifest, UserScenario } from "../domain/types";
import { ensureDir } from "../utils/fs";

export function runReplayAttempts(
  adapter: RuntimeAdapter,
  subject: SubjectManifest,
  run: RunManifest,
  scenarios: UserScenario[],
  plannedAttempts: number
): ReplayAttempt[] {
  const attempts: ReplayAttempt[] = [];
  for (let index = 1; index <= plannedAttempts; index += 1) {
    const attemptId = `replay-${index}`;
    const attemptRoot = path.join(run.paths.replays, attemptId);
    const artifactsRoot = path.join(attemptRoot, "artifacts");
    const tracePath = path.join(attemptRoot, "trace.ndjson");
    const issuesPath = path.join(attemptRoot, "issues.json");
    ensureDir(artifactsRoot);

    const result = adapter.run({
      subject,
      run,
      scenarios,
      tracePath,
      artifactsRoot,
      attemptId,
    });
    const issues = inspectTrace(run, scenarios, result.events, {
      artifactsRoot,
      outputPath: issuesPath,
    });
    const status = issues.some((issue) => issue.severity === "unsafe")
      ? "unsafe"
      : issues.some((issue) => issue.family === "blocked_runtime")
        ? "blocked"
        : issues.length
          ? "fail"
          : "pass";

    attempts.push({
      attempt_id: attemptId,
      status,
      trace_ref: tracePath,
      artifact_refs: listFiles(artifactsRoot),
      issue_count: issues.length,
    });
  }
  return attempts;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

