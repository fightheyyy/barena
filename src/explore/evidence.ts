import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExploreWorkspaceChange } from "./types";

interface FileObservation {
  size: number;
  sha256?: string;
}

export interface WorkspaceSnapshot {
  files: Map<string, FileObservation>;
  unsafe_entries: string[];
}

const EXCLUDED_TOP_LEVEL = new Set(["logs", ".barena-tmp"]);
const MAX_HASH_BYTES = 32 * 1024 * 1024;

export function snapshotExploreWorkspace(root: string): WorkspaceSnapshot {
  const files = new Map<string, FileObservation>();
  const unsafeEntries: string[] = [];
  if (!fs.existsSync(root)) return { files, unsafe_entries: unsafeEntries };
  const absoluteRoot = path.resolve(root);
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, fullPath);
      const topLevel = relative.split(path.sep)[0];
      if (EXCLUDED_TOP_LEVEL.has(topLevel)) continue;
      if (entry.isSymbolicLink()) {
        unsafeEntries.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        files.set(relative, {
          size: stat.size,
          ...(stat.size <= MAX_HASH_BYTES && {
            sha256: crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex"),
          }),
        });
      } else {
        unsafeEntries.push(relative);
      }
    }
  };
  walk(absoluteRoot);
  return { files, unsafe_entries: unsafeEntries.sort() };
}

export function diffExploreWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): ExploreWorkspaceChange[] {
  const names = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  return names.flatMap((relativePath): ExploreWorkspaceChange[] => {
    const oldValue = before.files.get(relativePath);
    const newValue = after.files.get(relativePath);
    if (
      oldValue?.size === newValue?.size &&
      oldValue?.sha256 === newValue?.sha256
    ) {
      return [];
    }
    if (!oldValue && newValue) {
      return [
        {
          path: relativePath,
          change: "created",
          size_after: newValue.size,
          ...(newValue.sha256 && { sha256_after: newValue.sha256 }),
        },
      ];
    }
    if (oldValue && !newValue) {
      return [
        {
          path: relativePath,
          change: "deleted",
          size_before: oldValue.size,
          ...(oldValue.sha256 && { sha256_before: oldValue.sha256 }),
        },
      ];
    }
    return [
      {
        path: relativePath,
        change: "modified",
        size_before: oldValue?.size,
        size_after: newValue?.size,
        ...(oldValue?.sha256 && { sha256_before: oldValue.sha256 }),
        ...(newValue?.sha256 && { sha256_after: newValue.sha256 }),
      },
    ];
  });
}

export function findExploreNativeTraceFiles(roots: string[]): string[] {
  const refs: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name === "traces.jsonl") refs.push(fullPath);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  }
  return [...new Set(refs)].sort();
}
