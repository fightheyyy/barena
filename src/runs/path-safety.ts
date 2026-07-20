import fs from "node:fs";
import path from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;
const MAX_RUN_ID_LENGTH = 200;

export type RunReferenceTrust = "trusted" | "untrusted" | "missing";

export interface RunReferenceAssessment {
  ref: string;
  trust: RunReferenceTrust;
  resolved_ref?: string;
  reason?: string;
}

export class RunPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPathError";
  }
}

export function isSafeRunId(runId: string): boolean {
  return runId.length > 0 &&
    runId.length <= MAX_RUN_ID_LENGTH &&
    runId !== "." &&
    runId !== ".." &&
    !path.isAbsolute(runId) &&
    SAFE_RUN_ID.test(runId);
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) {
    throw new RunPathError("Run ID must contain only letters, numbers, dot, underscore, or dash");
  }
}

export function resolveSafeRunRoot(runsRoot: string, runId: string): string {
  assertSafeRunId(runId);
  const root = path.resolve(runsRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new RunPathError(`Runs root does not exist or is not a directory: ${root}`);
  }

  const candidate = path.resolve(root, runId);
  assertLexicallyContained(root, candidate, "Run path escapes the runs root");
  if (!fs.existsSync(candidate)) throw new RunPathError(`Run not found: ${runId}`);

  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  assertContained(realRoot, realCandidate, "Run path resolves outside the runs root");
  if (!fs.statSync(realCandidate).isDirectory()) throw new RunPathError(`Run is not a directory: ${runId}`);
  return candidate;
}

export function resolveTrustedRunFile(runRoot: string, ref: string): string {
  const root = path.resolve(runRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new RunPathError(`Run root does not exist or is not a directory: ${root}`);
  }
  if (!ref.trim()) throw new RunPathError("Run reference must be non-empty");

  const candidate = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
  assertLexicallyContained(root, candidate, "Run reference escapes the run root");
  if (!fs.existsSync(candidate)) throw new RunPathError(`Run reference does not exist: ${ref}`);

  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  assertContained(realRoot, realCandidate, "Run reference resolves outside the run root");
  if (!fs.statSync(realCandidate).isFile()) throw new RunPathError(`Run reference is not a file: ${ref}`);
  return realCandidate;
}

export function assessRunReference(runRoot: string, ref: unknown): RunReferenceAssessment {
  if (typeof ref !== "string" || !ref.trim()) {
    return { ref: typeof ref === "string" ? ref : String(ref), trust: "untrusted", reason: "Reference is not a non-empty string." };
  }
  try {
    return { ref, trust: "trusted", resolved_ref: resolveTrustedRunFile(runRoot, ref) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ref,
      trust: /does not exist/.test(message) ? "missing" : "untrusted",
      reason: message,
    };
  }
}

export function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertLexicallyContained(root: string, candidate: string, message: string): void {
  if (!isPathContained(root, candidate)) throw new RunPathError(message);
}

function assertContained(root: string, candidate: string, message: string): void {
  if (!isPathContained(root, candidate)) throw new RunPathError(message);
}
