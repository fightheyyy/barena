import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJson } from "../utils/fs";
import { safeRelativePath, verifyArtifactAssertions } from "./artifact-verifier";
import { AgentE2EAttempt, AgentE2ECaseV1, TargetAdapter, TargetSkillConfig } from "./types";

export async function runTargetObservationAttempts(input: {
  caseDefinition: AgentE2ECaseV1;
  caseBaseDir: string;
  runId: string;
  runRoot: string;
  traceId: string;
  targetAdapter: TargetAdapter;
  skill?: TargetSkillConfig;
}): Promise<AgentE2EAttempt[]> {
  const attempts: AgentE2EAttempt[] = [];
  const replayCount = input.caseDefinition.replays ?? 1;
  for (let index = 0; index <= replayCount; index += 1) {
    const attemptId = index === 0 ? "initial" : `replay-${index}`;
    const attemptRoot = index === 0 ? input.runRoot : path.join(input.runRoot, "replays", attemptId);
    const workspace = path.join(attemptRoot, "workspace");
    const tracePath =
      index === 0
        ? path.join(input.runRoot, "traces", "boundary.ndjson")
        : path.join(attemptRoot, "boundary.ndjson");
    ensureDir(workspace);
    copyFixtures(input.caseDefinition, input.caseBaseDir, workspace);

    const target = await input.targetAdapter.execute({
      run_id: input.runId,
      case_id: input.caseDefinition.case_id,
      attempt_id: attemptId,
      trace_id: input.traceId,
      prompt: input.caseDefinition.task.prompt,
      workspace,
      trace_path: tracePath,
      timeout_ms: input.caseDefinition.timeout_ms ?? 180_000,
      target: input.caseDefinition.target,
      skill: input.skill ?? { mode: "none" },
    });
    const assertions = verifyArtifactAssertions(input.caseDefinition, workspace);
    const status: AgentE2EAttempt["status"] =
      target.status === "blocked"
        ? "blocked"
        : target.status === "unsafe"
          ? "unsafe"
          : target.status === "failed" || assertions.some((assertion) => assertion.status === "fail")
            ? "fail"
            : "pass";
    const verifierRef = path.join(attemptRoot, "verifier", "artifact-assertions.json");
    const attempt: AgentE2EAttempt = {
      attempt_id: attemptId,
      status,
      target,
      assertions,
      workspace,
      trace_ref: tracePath,
      verifier_ref: verifierRef,
    };
    attempts.push(attempt);
    writeJson(verifierRef, assertions);
  }
  return attempts;
}

function copyFixtures(caseDefinition: AgentE2ECaseV1, caseBaseDir: string, workspace: string): void {
  for (const fixture of caseDefinition.fixtures ?? []) {
    const destination = path.join(workspace, safeRelativePath(fixture.destination, "fixture destination"));
    const source = path.join(caseBaseDir, safeRelativePath(fixture.source, "fixture source"));
    if (!fs.existsSync(source)) {
      throw new Error(`Fixture source does not exist: ${fixture.source}`);
    }
    ensureDir(path.dirname(destination));
    fs.cpSync(source, destination, { recursive: true });
  }
}
