import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  RunPathError,
  resolveSafeRunRoot,
  resolveTrustedRunFile,
} from "./path-safety";
import {
  isAgentE2ERun,
  isCompleteLegacyClearanceRun,
  isLegacyClearanceRun,
  isRecord,
  isReleaseDecision,
  isSkillEvaluationRun,
  isXiaoBaCapabilityRun,
  resultSchema,
  stringValue,
  type JsonRecord,
  type ReleaseDecision,
} from "./type-guards";

export type RunKind =
  | "legacy_clearance"
  | "agent_e2e"
  | "skill_evaluation"
  | "xiaoba_capability"
  | "unknown";

export type RunHealth = "healthy" | "partial" | "malformed" | "unknown_schema";

export interface RunSummary {
  run_id: string;
  kind: RunKind;
  schema: string;
  decision: ReleaseDecision | "unknown";
  status: string;
  reason: string;
  result_ref: string;
  health: RunHealth;
  warnings: string[];
  created_at?: string;
  subject_id?: string;
}

export interface CatalogRun extends RunSummary {
  run_root: string;
  result: JsonRecord;
}

export class RunCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCatalogError";
  }
}

const RESULT_CANDIDATES = [
  "capability-evaluation.json",
  "skill-evaluation.json",
  "evaluation-result.json",
  path.join("reviewer", "scorecard.json"),
  path.join("reports", "report.json"),
] as const;

export function listRunCatalog(runsRoot = "runs"): RunSummary[] {
  const root = resolveRunsRoot(runsRoot);
  if (!root) return [];

  return runDirectoryNames(root)
    .map((runId) => inspectRunDirectory(root, runId))
    .sort(compareRunSummaries);
}

/**
 * Loads recognized runs in a single catalog pass. Consumers that need both the
 * summary and result (notably the evaluation TUI) should use this instead of
 * calling listRunCatalog followed by loadRunRecord for every run.
 */
export function listRunRecords(runsRoot = "runs"): CatalogRun[] {
  const root = resolveRunsRoot(runsRoot);
  if (!root) return [];

  return runDirectoryNames(root)
    .flatMap((runId): CatalogRun[] => {
      try {
        const runRoot = resolveSafeRunRoot(root, runId);
        const inspected = inspectTrustedRun(runRoot, runId);
        if (!inspected.result || inspected.summary.kind === "unknown") return [];
        if (resultId(inspected.result, inspected.summary.kind) !== runId) return [];
        return [{ ...inspected.summary, run_root: runRoot, result: inspected.result }];
      } catch {
        return [];
      }
    })
    .sort(compareRunSummaries);
}

export function loadRunRecord(runId: string, runsRoot = "runs"): CatalogRun {
  const root = path.resolve(runsRoot);
  let runRoot: string;
  try {
    runRoot = resolveSafeRunRoot(root, runId);
  } catch (error) {
    throw catalogError(error);
  }

  const inspected = inspectTrustedRun(runRoot, runId);
  if (!inspected.result) {
    if (inspected.summary.health === "malformed") {
      throw new RunCatalogError(`Run ${runId} contains malformed result JSON`);
    }
    throw new RunCatalogError(`Run ${runId} has no recognized result schema`);
  }
  if (inspected.summary.kind === "unknown") {
    throw new RunCatalogError(`Run ${runId} has unsupported schema ${inspected.summary.schema}`);
  }
  const embeddedId = resultId(inspected.result, inspected.summary.kind);
  if (embeddedId !== runId) {
    throw new RunCatalogError(`Run identity does not match requested ID ${runId}`);
  }
  return {
    ...inspected.summary,
    run_root: runRoot,
    result: inspected.result,
  };
}

export function getRunSummary(runId: string, runsRoot = "runs"): RunSummary {
  const loaded = loadRunRecord(runId, runsRoot);
  const { result: _result, run_root: _runRoot, ...summary } = loaded;
  return summary;
}

export const listRuns = listRunCatalog;
export const loadRuns = listRunRecords;
export const loadRun = loadRunRecord;
export const showRun = loadRunRecord;

function resolveRunsRoot(runsRoot: string): string | undefined {
  const root = path.resolve(runsRoot);
  if (!fs.existsSync(root)) return undefined;
  if (!fs.statSync(root).isDirectory()) throw new RunCatalogError(`Runs root is not a directory: ${root}`);
  return root;
}

function runDirectoryNames(runsRoot: string): string[] {
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

function inspectRunDirectory(runsRoot: string, runId: string): RunSummary {
  try {
    const runRoot = resolveSafeRunRoot(runsRoot, runId);
    return inspectTrustedRun(runRoot, runId).summary;
  } catch (error) {
    return unknownSummary(runId, "malformed", [safeMessage(error)]);
  }
}

function inspectTrustedRun(runRoot: string, runId: string): { summary: RunSummary; result?: JsonRecord } {
  const parseWarnings: string[] = [];
  const metadata = readRunMetadata(runRoot, parseWarnings);
  let unknown: { record: JsonRecord; schema: string; resultRef: string } | undefined;

  for (const relativeRef of RESULT_CANDIDATES) {
    const candidate = path.join(runRoot, relativeRef);
    if (!fs.existsSync(candidate)) continue;

    let trustedRef: string;
    try {
      trustedRef = resolveTrustedRunFile(runRoot, candidate);
    } catch (error) {
      parseWarnings.push(`${relativeRef}: ${safeMessage(error)}`);
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(trustedRef, "utf8")) as unknown;
    } catch {
      parseWarnings.push(`${relativeRef}: malformed JSON`);
      continue;
    }
    if (!isRecord(value)) {
      parseWarnings.push(`${relativeRef}: result must be a JSON object`);
      continue;
    }

    const schema = resultSchema(value);
    if (schema && recognizedKind(schema) !== "unknown") {
      return { summary: summarizeRecognized(runRoot, runId, value, schema, candidate, metadata, parseWarnings), result: value };
    }
    if (!unknown) {
      unknown = { record: value, schema: schema ?? "unknown", resultRef: candidate };
    }
  }

  if (unknown) {
    return {
      summary: {
        ...unknownSummary(runId, "unknown_schema", [
          ...parseWarnings,
          `Unsupported or missing result schema: ${unknown.schema}`,
        ]),
        schema: unknown.schema,
        result_ref: unknown.resultRef,
      },
      result: unknown.record,
    };
  }
  if (parseWarnings.length > 0) {
    return { summary: unknownSummary(runId, "malformed", parseWarnings) };
  }
  return { summary: unknownSummary(runId, "unknown_schema", ["No recognized result file was found."]) };
}

function readRunMetadata(
  runRoot: string,
  warnings: string[]
): { created_at?: string; subject_id?: string } {
  const manifestRef = path.join(runRoot, "run-manifest.json");
  if (!fs.existsSync(manifestRef)) return {};
  try {
    const trustedRef = resolveTrustedRunFile(runRoot, manifestRef);
    const value = JSON.parse(fs.readFileSync(trustedRef, "utf8")) as unknown;
    if (!isRecord(value)) {
      warnings.push("run-manifest.json: manifest must be a JSON object");
      return {};
    }
    return {
      ...(stringValue(value.created_at) && { created_at: stringValue(value.created_at) }),
      ...(stringValue(value.subject_id) && { subject_id: stringValue(value.subject_id) }),
    };
  } catch (error) {
    warnings.push(`run-manifest.json: ${safeMessage(error)}`);
    return {};
  }
}

function summarizeRecognized(
  runRoot: string,
  directoryId: string,
  result: JsonRecord,
  schema: string,
  resultRef: string,
  metadata: { created_at?: string; subject_id?: string },
  priorWarnings: string[]
): RunSummary {
  const kind = recognizedKind(schema);
  const warnings = [...priorWarnings];
  const embeddedId = resultId(result, kind);
  if (!embeddedId) warnings.push("Result identity is not recorded.");
  else if (embeddedId !== directoryId) warnings.push(`Result identity ${embeddedId} does not match directory ${directoryId}.`);

  const decision = isReleaseDecision(result.decision) ? result.decision : "unknown";
  if (decision === "unknown") warnings.push("Decision is not recorded or invalid.");

  const schemaComplete = isHealthyForKind(result, kind);
  if (!schemaComplete) warnings.push(`Result is a partial ${schema} record.`);
  const packageAssessment = assessResultPackage(runRoot, resultRef, result, kind);
  warnings.push(...packageAssessment.warnings);
  const complete = schemaComplete && packageAssessment.complete;

  return {
    run_id: directoryId,
    kind,
    schema,
    decision,
    status: stringValue(result.status) ?? defaultStatus(kind, decision),
    reason: stringValue(result.reason_code) ?? "not recorded",
    result_ref: resultRef,
    health: complete && embeddedId === directoryId && priorWarnings.length === 0 ? "healthy" : "partial",
    warnings,
    ...((stringValue(result.created_at) ?? metadata.created_at) && {
      created_at: stringValue(result.created_at) ?? metadata.created_at,
    }),
    ...((stringValue(result.subject_id) ?? metadata.subject_id) && {
      subject_id: stringValue(result.subject_id) ?? metadata.subject_id,
    }),
  };
}

function assessResultPackage(
  runRoot: string,
  resultRef: string,
  result: JsonRecord,
  kind: RunKind
): { complete: boolean; warnings: string[] } {
  if (kind !== "xiaoba_capability") return { complete: true, warnings: [] };
  const declaredManifestRef = stringValue(result.package_manifest_ref);
  const defaultManifestRef = path.join(runRoot, "package-manifest.json");
  if (!declaredManifestRef && !fs.existsSync(defaultManifestRef)) {
    // Backward-compatible catalog support for records created before result-package markers.
    return { complete: true, warnings: [] };
  }

  const warnings: string[] = [];
  let manifestRef: string;
  try {
    manifestRef = resolveTrustedRunFile(runRoot, declaredManifestRef ?? defaultManifestRef);
  } catch (error) {
    return { complete: false, warnings: [`Result package marker: ${safeMessage(error)}`] };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestRef, "utf8")) as unknown;
  } catch {
    return { complete: false, warnings: ["Result package marker is malformed JSON."] };
  }
  if (!isRecord(manifest) || manifest.schema !== "barena.result_package.v1" || manifest.status !== "complete") {
    return { complete: false, warnings: ["Result package marker is incomplete or has an unsupported schema."] };
  }
  if (typeof manifest.result_ref !== "string" || !manifest.result_ref) {
    warnings.push("Result package marker does not identify its result file.");
  } else {
    try {
      const markedResult = resolveTrustedRunFile(runRoot, manifest.result_ref);
      if (fs.realpathSync(markedResult) !== fs.realpathSync(resultRef)) {
        warnings.push("Result package marker points at a different result file.");
      }
    } catch (error) {
      warnings.push(`Result package result_ref: ${safeMessage(error)}`);
    }
  }

  const fileEntries = Array.isArray(manifest.files) ? manifest.files : [];
  if (fileEntries.length === 0) warnings.push("Result package marker has no file manifest.");
  const listed = new Set<string>();
  for (const entry of fileEntries) {
    if (!isRecord(entry) || typeof entry.ref !== "string" || typeof entry.sha256 !== "string") {
      warnings.push("Result package marker contains an invalid file entry.");
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      warnings.push(`Result package hash is invalid for ${entry.ref}.`);
      continue;
    }
    try {
      const trustedRef = resolveTrustedRunFile(runRoot, entry.ref);
      const relative = catalogRelativeRef(runRoot, trustedRef);
      if (listed.has(relative)) {
        warnings.push(`Result package marker lists ${relative} more than once.`);
        continue;
      }
      listed.add(relative);
      const observed = crypto.createHash("sha256").update(fs.readFileSync(trustedRef)).digest("hex");
      if (observed !== entry.sha256.toLowerCase()) {
        warnings.push(`Result package hash mismatch for ${relative}.`);
      }
    } catch (error) {
      warnings.push(`Result package file ${entry.ref}: ${safeMessage(error)}`);
    }
  }

  for (const required of ["capability-evaluation.json", "reports/report.json", "reports/report.md"]) {
    if (!listed.has(required)) warnings.push(`Result package is missing required companion ${required}.`);
  }

  try {
    const actual = listCatalogPackageFiles(runRoot)
      .filter((filePath) => fs.realpathSync(filePath) !== fs.realpathSync(manifestRef))
      .map((filePath) => catalogRelativeRef(runRoot, filePath));
    for (const relative of actual) {
      if (!listed.has(relative)) warnings.push(`Result package contains unmanifested file ${relative}.`);
    }
    for (const relative of listed) {
      if (!actual.includes(relative)) warnings.push(`Result package lists stale file ${relative}.`);
    }
  } catch (error) {
    warnings.push(`Result package tree: ${safeMessage(error)}`);
  }

  try {
    const reportJsonRef = resolveTrustedRunFile(runRoot, "reports/report.json");
    const report = JSON.parse(fs.readFileSync(reportJsonRef, "utf8")) as unknown;
    if (!isRecord(report) || resultSchema(report) !== resultSchema(result) || stringValue(report.evaluation_id) !== stringValue(result.evaluation_id)) {
      warnings.push("Result package report.json does not match the primary result schema and identity.");
    }
  } catch (error) {
    warnings.push(`Result package report.json: ${safeMessage(error)}`);
  }

  return { complete: warnings.length === 0, warnings };
}

function listCatalogPackageFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...listCatalogPackageFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
    else throw new RunPathError(`Result package contains a non-regular entry: ${fullPath}`);
  }
  return files.sort();
}

function catalogRelativeRef(root: string, filePath: string): string {
  return path.relative(fs.realpathSync(root), fs.realpathSync(filePath)).split(path.sep).join("/");
}

function isHealthyForKind(result: JsonRecord, kind: RunKind): boolean {
  if (kind === "legacy_clearance") return isCompleteLegacyClearanceRun(result);
  if (kind === "agent_e2e") return isAgentE2ERun(result);
  if (kind === "skill_evaluation") return isSkillEvaluationRun(result);
  if (kind === "xiaoba_capability") return isXiaoBaCapabilityRun(result);
  return false;
}

function recognizedKind(schema: string): RunKind {
  if (schema === "barena.skill_clearance.v0") return "legacy_clearance";
  if (schema === "barena.agent_e2e.v1") return "agent_e2e";
  if (schema === "barena.skill_evaluation.v1") return "skill_evaluation";
  if (schema === "barena.xiaoba_capability_evaluation_result.v1") return "xiaoba_capability";
  return "unknown";
}

function resultId(result: JsonRecord, kind: RunKind): string | undefined {
  if (kind === "skill_evaluation" || kind === "xiaoba_capability") return stringValue(result.evaluation_id);
  return stringValue(result.run_id);
}

function defaultStatus(kind: RunKind, decision: ReleaseDecision | "unknown"): string {
  if (kind === "skill_evaluation" || kind === "xiaoba_capability") {
    return decision === "unknown" ? "not recorded" : "completed";
  }
  return "not recorded";
}

function unknownSummary(runId: string, health: "malformed" | "unknown_schema", warnings: string[]): RunSummary {
  return {
    run_id: runId,
    kind: "unknown",
    schema: "unknown",
    decision: "unknown",
    status: "not recorded",
    reason: "not recorded",
    result_ref: "not recorded",
    health,
    warnings,
  };
}

function compareRunSummaries(left: RunSummary, right: RunSummary): number {
  if (left.created_at && right.created_at) return right.created_at.localeCompare(left.created_at);
  if (left.created_at) return -1;
  if (right.created_at) return 1;
  return right.run_id.localeCompare(left.run_id);
}

function catalogError(error: unknown): RunCatalogError {
  if (error instanceof RunCatalogError) return error;
  if (error instanceof RunPathError) return new RunCatalogError(error.message);
  return new RunCatalogError(safeMessage(error));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
