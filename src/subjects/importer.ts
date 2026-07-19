import fs from "node:fs";
import path from "node:path";
import { SubjectManifest } from "../domain/types";
import { copyDirectory, ensureDir, hashDirectory, slugify, writeJson } from "../utils/fs";
import { scanSubjectDirectory } from "./scanner";

export interface ImportSkillOptions {
  subjectId?: string;
  subjectsRoot?: string;
}

export function importLocalSkill(sourcePath: string, options: ImportSkillOptions = {}): SubjectManifest {
  const absoluteSource = path.resolve(sourcePath);
  assertImportSourceSafe(absoluteSource);
  const skillFile = path.join(absoluteSource, "SKILL.md");
  if (!fs.existsSync(skillFile) || !fs.lstatSync(skillFile).isFile()) {
    throw new Error(`Local skill must contain a regular SKILL.md: ${absoluteSource}`);
  }

  const subjectsRoot = path.resolve(options.subjectsRoot ?? "subjects");
  const subjectId = options.subjectId === undefined
    ? slugify(path.basename(absoluteSource))
    : options.subjectId.trim();
  assertSafeSubjectId(subjectId);
  const subjectRoot = path.resolve(subjectsRoot, subjectId);
  assertPathInside(subjectsRoot, subjectRoot, "Subject root escapes subjects root");
  ensureDir(subjectsRoot);
  const realSubjectsRoot = fs.realpathSync(subjectsRoot);

  if (fs.existsSync(subjectRoot)) {
    const existingStat = fs.lstatSync(subjectRoot);
    if (existingStat.isSymbolicLink()) throw new Error(`Subject root may not be a symlink: ${subjectRoot}`);
    assertPathInside(realSubjectsRoot, fs.realpathSync(subjectRoot), "Existing subject root resolves outside subjects root");
    fs.rmSync(subjectRoot, { recursive: true, force: true });
  }
  copyDirectory(absoluteSource, subjectRoot);

  const manifest: SubjectManifest = {
    subject_id: subjectId,
    type: "skill",
    source: {
      kind: "local",
      uri: absoluteSource,
    },
    status: "candidate",
    fingerprint: hashDirectory(subjectRoot),
    imported_at: new Date().toISOString(),
    paths: {
      source: absoluteSource,
      subject_root: subjectRoot,
      scan_report: path.join(subjectRoot, "scan-report.json"),
    },
    metadata: {
      has_skill_md: true,
    },
  };

  const scanReport = scanSubjectDirectory(subjectId, subjectRoot, manifest.paths.scan_report);
  manifest.metadata = {
    ...manifest.metadata,
    scan_decision: scanReport.decision,
    scan_finding_count: scanReport.findings.length,
  };
  writeJson(path.join(subjectRoot, "subject-manifest.json"), manifest);
  return manifest;
}

export function loadSubjectManifest(subjectId: string, subjectsRoot = "subjects"): SubjectManifest {
  assertSafeSubjectId(subjectId);
  const absoluteSubjectsRoot = path.resolve(subjectsRoot);
  if (!fs.existsSync(absoluteSubjectsRoot) || !fs.lstatSync(absoluteSubjectsRoot).isDirectory()) {
    throw new Error(`Subjects root does not exist or is not a directory: ${absoluteSubjectsRoot}`);
  }
  const subjectRoot = path.resolve(absoluteSubjectsRoot, subjectId);
  assertPathInside(absoluteSubjectsRoot, subjectRoot, "Subject root escapes subjects root");
  if (!fs.existsSync(subjectRoot) || fs.lstatSync(subjectRoot).isSymbolicLink() || !fs.lstatSync(subjectRoot).isDirectory()) {
    throw new Error(`Subject not found or subject root is unsafe: ${subjectId} (${subjectRoot})`);
  }
  assertPathInside(
    fs.realpathSync(absoluteSubjectsRoot),
    fs.realpathSync(subjectRoot),
    "Subject root resolves outside subjects root"
  );

  const manifestPath = path.join(subjectRoot, "subject-manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Subject not found: ${subjectId} (${manifestPath})`);
  const manifestStat = fs.lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`Subject manifest path is not a regular file: ${manifestPath}`);
  }
  assertPathInside(fs.realpathSync(subjectRoot), fs.realpathSync(manifestPath), "Subject manifest path resolves outside subject root");

  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!isSubjectManifest(value)) throw new Error(`Subject manifest is malformed: ${manifestPath}`);
  if (value.subject_id !== subjectId) throw new Error(`Subject manifest ID does not match requested subject ID ${subjectId}`);
  if (path.resolve(value.paths.subject_root) !== subjectRoot) {
    throw new Error(`Subject manifest subject root is outside or does not match trusted subject root: ${value.paths.subject_root}`);
  }
  const expectedScanReport = path.join(subjectRoot, "scan-report.json");
  if (value.paths.scan_report !== undefined && path.resolve(value.paths.scan_report) !== expectedScanReport) {
    throw new Error(`Subject manifest scan report path is outside or does not match trusted subject root: ${value.paths.scan_report}`);
  }
  return value;
}

function assertImportSourceSafe(sourceRoot: string): void {
  if (!fs.existsSync(sourceRoot)) throw new Error(`Local skill source does not exist: ${sourceRoot}`);
  const rootStat = fs.lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Local skill source must be a real directory and may not be a symlink: ${sourceRoot}`);
  }
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const entryPath = path.join(sourceRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Local skill import may not contain symlinks: ${entryPath}`);
    if (entry.isDirectory()) assertImportSourceSafe(entryPath);
    else if (!entry.isFile()) throw new Error(`Local skill import contains a non-regular entry: ${entryPath}`);
  }
}

function assertSafeSubjectId(subjectId: string): void {
  if (!subjectId || subjectId === "." || subjectId === ".." || !/^[A-Za-z0-9._-]+$/.test(subjectId)) {
    throw new Error(`Subject ID is unsafe or contains a dot segment: ${subjectId}`);
  }
}

function assertPathInside(root: string, candidate: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function isSubjectManifest(value: unknown): value is SubjectManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const paths = record.paths;
  return typeof record.subject_id === "string" &&
    typeof record.type === "string" &&
    typeof record.source === "object" && record.source !== null &&
    typeof record.status === "string" &&
    typeof record.fingerprint === "string" &&
    typeof record.imported_at === "string" &&
    typeof record.metadata === "object" && record.metadata !== null &&
    typeof paths === "object" && paths !== null &&
    typeof (paths as Record<string, unknown>).source === "string" &&
    typeof (paths as Record<string, unknown>).subject_root === "string" &&
    ((paths as Record<string, unknown>).scan_report === undefined || typeof (paths as Record<string, unknown>).scan_report === "string");
}
