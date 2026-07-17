import fs from "node:fs";
import path from "node:path";
import { Scorecard, SubjectManifest } from "../domain/types";
import { readJson } from "../utils/fs";

export interface TuiRunSummary {
  run_id: string;
  created_at?: string;
  subject_id?: string;
  scorecard?: Scorecard;
}

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
    runs: loadRuns(runsRoot),
  };
}

function loadSubjects(subjectsRoot: string): SubjectManifest[] {
  if (!fs.existsSync(subjectsRoot)) {
    return [];
  }
  return fs
    .readdirSync(subjectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(subjectsRoot, entry.name, "subject-manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => readJson<SubjectManifest>(manifestPath))
    .sort((a, b) => a.subject_id.localeCompare(b.subject_id));
}

function loadRuns(runsRoot: string): TuiRunSummary[] {
  if (!fs.existsSync(runsRoot)) {
    return [];
  }
  return fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runRoot = path.join(runsRoot, entry.name);
      const manifestPath = path.join(runRoot, "run-manifest.json");
      const scorecardPath = path.join(runRoot, "reviewer", "scorecard.json");
      const manifest = fs.existsSync(manifestPath)
        ? readJson<{ created_at?: string; subject_id?: string }>(manifestPath)
        : {};
      return {
        run_id: entry.name,
        created_at: manifest.created_at,
        subject_id: manifest.subject_id,
        scorecard: fs.existsSync(scorecardPath) ? readJson<Scorecard>(scorecardPath) : undefined,
      };
    })
    .sort((a, b) => (b.created_at ?? b.run_id).localeCompare(a.created_at ?? a.run_id));
}

