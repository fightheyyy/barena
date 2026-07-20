import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { importLocalSkill } from "./importer";
import { ensureDir, writeJson } from "../utils/fs";

export interface ImportGithubSkillOptions {
  subjectId?: string;
  subjectsRoot?: string;
  ref?: string;
}

export function importGithubSkill(source: string, options: ImportGithubSkillOptions = {}) {
  const url = normalizeGithubSource(source);
  const subjectsRoot = path.resolve(options.subjectsRoot ?? "subjects");
  const incomingRoot = path.join(subjectsRoot, "_incoming");
  ensureDir(incomingRoot);
  const cloneDir = path.join(incomingRoot, `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const cloneArgs = ["clone", "--depth", "1"];
  if (options.ref) {
    cloneArgs.push("--branch", options.ref);
  }
  cloneArgs.push(url, cloneDir);

  const clone = spawnSync("git", cloneArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (clone.status !== 0) {
    throw new Error(`git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`);
  }

  const skillRoot = findSkillRoot(cloneDir);
  const manifest = importLocalSkill(skillRoot, {
    subjectId: options.subjectId,
    subjectsRoot,
  });
  fs.rmSync(cloneDir, { recursive: true, force: true });
  const githubManifest = {
    ...manifest,
    source: {
      kind: "github" as const,
      uri: url,
    },
    metadata: {
      ...manifest.metadata,
      github_ref: options.ref ?? null,
    },
  };
  writeJson(path.join(githubManifest.paths.subject_root, "subject-manifest.json"), githubManifest);
  return githubManifest;
}

function normalizeGithubSource(source: string): string {
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(source)) {
    return source;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return `https://github.com/${source}.git`;
  }
  throw new Error("GitHub source must be https://github.com/owner/repo or owner/repo");
}

function findSkillRoot(root: string): string {
  const direct = path.join(root, "SKILL.md");
  if (fs.existsSync(direct)) {
    return root;
  }

  const candidates = findFiles(root, "SKILL.md");
  if (candidates.length === 0) {
    throw new Error("GitHub repository does not contain SKILL.md");
  }
  if (candidates.length > 1) {
    const candidateList = candidates.map((candidate) => path.relative(root, candidate)).join(", ");
    throw new Error(`GitHub repository contains multiple SKILL.md files; import a specific local path instead: ${candidateList}`);
  }
  return path.dirname(candidates[0]);
}

function findFiles(root: string, name: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFiles(fullPath, name));
    } else if (entry.isFile() && entry.name === name) {
      matches.push(fullPath);
    }
  }
  return matches;
}
