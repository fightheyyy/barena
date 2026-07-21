import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashDirectory } from "../utils/fs";
import { loadXiaoBaNativeCase } from "./xiaoba-native-case";
import type {
  XiaoBaCasePackReference,
  XiaoBaCaseSourceProvenance,
  XiaoBaNativeCaseV1,
} from "./xiaoba-native-types";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;

export interface XiaoBaCasePackV1 {
  schema: "barena.xiaoba_case_pack.v1";
  pack_id: string;
  source: {
    kind: "skillsbench";
    repository: string;
    revision: string;
    license: string;
  };
  cases: Array<{
    case_path: string;
    source_task: {
      task_id: string;
      task_path: string;
      task_sha256: string;
    };
    adaptation: XiaoBaCaseSourceProvenance["adaptation"];
  }>;
}

export interface LoadedXiaoBaCasePack {
  manifest: XiaoBaCasePackV1;
  cases: XiaoBaNativeCaseV1[];
  reference: XiaoBaCasePackReference;
}

export function loadXiaoBaCasePack(manifestPath: string): LoadedXiaoBaCasePack {
  const absoluteManifest = path.resolve(manifestPath);
  requireRegularContainedFile(path.dirname(absoluteManifest), absoluteManifest, "case-pack manifest");
  const packRoot = fs.realpathSync(path.dirname(absoluteManifest));
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, "utf8")) as XiaoBaCasePackV1;
  validateManifest(manifest);

  const caseIds = new Set<string>();
  const taskIds = new Set<string>();
  const taskSources = new Map<string, { task_path: string; task_sha256: string }>();
  const cases = manifest.cases.map((entry, index) => {
    const casePath = resolvePackFile(packRoot, entry.case_path, `cases[${index}].case_path`);
    const taskPath = resolvePackFile(packRoot, entry.source_task.task_path, `cases[${index}].source_task.task_path`);
    const taskBytes = fs.readFileSync(taskPath);
    const taskSha256 = crypto.createHash("sha256").update(taskBytes).digest("hex");
    if (taskSha256 !== entry.source_task.task_sha256.toLowerCase()) {
      throw new Error(`SkillsBench source task hash mismatch for ${entry.source_task.task_id}`);
    }

    const loaded = loadXiaoBaNativeCase(casePath);
    if (loaded.source !== undefined) throw new Error(`Case ${loaded.case_id} must not define source outside its case pack`);
    if (caseIds.has(loaded.case_id)) throw new Error(`Duplicate case_id in case pack: ${loaded.case_id}`);
    const existingTaskSource = taskSources.get(entry.source_task.task_id);
    if (existingTaskSource && (
      existingTaskSource.task_path !== entry.source_task.task_path
      || existingTaskSource.task_sha256 !== taskSha256
    )) {
      throw new Error(`Conflicting SkillsBench source provenance for task_id: ${entry.source_task.task_id}`);
    }
    caseIds.add(loaded.case_id);
    taskIds.add(entry.source_task.task_id);
    taskSources.set(entry.source_task.task_id, {
      task_path: entry.source_task.task_path,
      task_sha256: taskSha256,
    });

    const source: XiaoBaCaseSourceProvenance = {
      kind: "skillsbench",
      repository: manifest.source.repository,
      revision: manifest.source.revision,
      license: manifest.source.license,
      task_id: entry.source_task.task_id,
      task_path: entry.source_task.task_path,
      task_sha256: taskSha256,
      derived: true,
      official_harness_compatible: false,
      adaptation: entry.adaptation,
    };

    if (entry.adaptation.prompt === "verbatim") {
      const upstreamPrompt = extractTaskPrompt(taskBytes.toString("utf8"));
      if (loaded.task.prompt !== upstreamPrompt) {
        throw new Error(`Case ${loaded.case_id} prompt differs from its verbatim SkillsBench task prompt`);
      }
    } else if (entry.adaptation.notes.length === 0) {
      throw new Error(`Adapted case ${loaded.case_id} must record at least one prompt adaptation note`);
    }
    return { ...loaded, source };
  });

  return {
    manifest,
    cases,
    reference: {
      schema: "barena.xiaoba_case_pack_ref.v1",
      pack_id: manifest.pack_id,
      manifest_path: absoluteManifest,
      fingerprint: hashDirectory(packRoot),
      source: manifest.source,
      task_ids: [...taskIds],
    },
  };
}

function validateManifest(value: XiaoBaCasePackV1): void {
  if (!value || value.schema !== "barena.xiaoba_case_pack.v1") {
    throw new Error("Case-pack schema must be barena.xiaoba_case_pack.v1");
  }
  if (!SAFE_ID.test(value.pack_id) || value.pack_id === "." || value.pack_id === "..") {
    throw new Error("Case-pack pack_id must be a safe path segment");
  }
  if (value.source?.kind !== "skillsbench") throw new Error("Phase 1 case packs support source.kind=skillsbench only");
  if (!/^https:\/\//.test(value.source.repository)) throw new Error("Case-pack source.repository must be an HTTPS URL");
  if (!COMMIT.test(value.source.revision)) throw new Error("Case-pack source.revision must be a pinned 40-character commit");
  if (!value.source.license?.trim()) throw new Error("Case-pack source.license must be recorded");
  if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error("Case pack must contain at least one case");

  value.cases.forEach((entry, index) => {
    validatePackRelative(entry.case_path, `cases[${index}].case_path`);
    if (!SAFE_ID.test(entry.source_task?.task_id ?? "")) throw new Error(`cases[${index}].source_task.task_id is invalid`);
    validatePackRelative(entry.source_task.task_path, `cases[${index}].source_task.task_path`);
    if (!SHA256.test(entry.source_task.task_sha256)) throw new Error(`cases[${index}].source_task.task_sha256 is invalid`);
    if (!entry.adaptation || !["verbatim", "adapted"].includes(entry.adaptation.prompt)) {
      throw new Error(`cases[${index}].adaptation.prompt is invalid`);
    }
    if (entry.adaptation.environment !== "fixture_subset") throw new Error(`cases[${index}] must use environment=fixture_subset`);
    if (entry.adaptation.verifier !== "barena_structured_v1") throw new Error(`cases[${index}] must use verifier=barena_structured_v1`);
    if (!Array.isArray(entry.adaptation.notes) || entry.adaptation.notes.some((note) => typeof note !== "string" || !note.trim())) {
      throw new Error(`cases[${index}].adaptation.notes must be a string array`);
    }
  });
}

function extractTaskPrompt(source: string): string {
  if (!source.startsWith("---")) return source.trim();
  const end = source.indexOf("\n---", 3);
  if (end < 0) throw new Error("SkillsBench task.md frontmatter is not closed");
  return source.slice(end + 4).trim();
}

function resolvePackFile(root: string, relativePath: string, label: string): string {
  validatePackRelative(relativePath, label);
  const resolved = path.resolve(root, relativePath);
  requireRegularContainedFile(root, resolved, label);
  return resolved;
}

function requireRegularContainedFile(root: string, filePath: string, label: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`${label} may not be a symbolic link: ${filePath}`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(filePath);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes the case-pack root`);
}

function validatePackRelative(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} escapes the case-pack root`);
}
