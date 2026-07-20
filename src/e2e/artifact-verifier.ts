import path from "node:path";
import { AgentE2ECaseV1, ArtifactAssertionResult } from "./types";
import { verifyArtifactContent } from "../verifier/artifact-verifier";

export function verifyArtifactAssertions(
  caseDefinition: AgentE2ECaseV1,
  workspace: string
): ArtifactAssertionResult[] {
  return caseDefinition.assertions.artifacts.map((assertion) => {
    const relativePath = safeRelativePath(assertion.path, "artifact assertion path");
    const artifactPath = path.join(workspace, relativePath);
    return verifyArtifactContent(assertion, artifactPath, relativePath);
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
