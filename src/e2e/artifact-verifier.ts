import fs from "node:fs";
import path from "node:path";
import { AgentE2ECaseV1, ArtifactAssertionResult } from "./types";

export function verifyArtifactAssertions(
  caseDefinition: AgentE2ECaseV1,
  workspace: string
): ArtifactAssertionResult[] {
  return caseDefinition.assertions.artifacts.map((assertion) => {
    const relativePath = safeRelativePath(assertion.path, "artifact assertion path");
    const artifactPath = path.join(workspace, relativePath);
    const expectedToExist = assertion.exists ?? true;
    const exists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();

    if (exists !== expectedToExist) {
      return {
        path: relativePath,
        status: "fail",
        detail: expectedToExist ? "Expected artifact does not exist." : "Artifact exists but was expected to be absent.",
      };
    }
    if (!exists || assertion.contains === undefined) {
      return { path: relativePath, status: "pass", detail: "Artifact existence matched the assertion." };
    }
    const contents = fs.readFileSync(artifactPath, "utf8");
    return contents.includes(assertion.contains)
      ? { path: relativePath, status: "pass", detail: "Artifact contains the expected text." }
      : { path: relativePath, status: "fail", detail: "Artifact does not contain the expected text." };
  });
}

export function safeRelativePath(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  return normalized;
}

