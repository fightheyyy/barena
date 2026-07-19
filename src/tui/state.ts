import fs from "node:fs";
import path from "node:path";
import type { SubjectManifest } from "../domain/types";
import { listRunCatalog, type RunSummary } from "../runs/catalog";
import { readJson } from "../utils/fs";

export type TuiRunSummary = RunSummary;

export interface TuiState {
  subjects_root: string;
  runs_root: string;
  subjects: SubjectManifest[];
  runs: TuiRunSummary[];
}

export interface TuiStateOptions {
  subjectsRoot?: string;
  runsRoot?: string;
}

export function loadTuiState(options: TuiStateOptions = {}): TuiState {
  const subjectsRoot = path.resolve(options.subjectsRoot ?? "subjects");
  const runsRoot = path.resolve(options.runsRoot ?? "runs");
  return {
    subjects_root: subjectsRoot,
    runs_root: runsRoot,
    subjects: loadSubjects(subjectsRoot),
    runs: listRunCatalog(runsRoot),
  };
}

function loadSubjects(subjectsRoot: string): SubjectManifest[] {
  if (!fs.existsSync(subjectsRoot)) return [];
  return fs.readdirSync(subjectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(subjectsRoot, entry.name, "subject-manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => readJson<SubjectManifest>(manifestPath))
    .sort((a, b) => a.subject_id.localeCompare(b.subject_id));
}
