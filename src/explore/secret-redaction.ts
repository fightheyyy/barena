import fs from "node:fs";
import path from "node:path";

const MAX_SCANNABLE_FILE_BYTES = 64 * 1024 * 1024;

export interface SecretRedactionResult {
  files: string[];
  occurrences: number;
  unscanned_files: string[];
}

export function redactSecretsInDirectory(
  root: string,
  secrets: string[]
): SecretRedactionResult {
  const absoluteRoot = path.resolve(root);
  const needles = [...new Set(secrets.filter(Boolean))].map((value) =>
    Buffer.from(value, "utf8")
  );
  const files: string[] = [];
  const unscannedFiles: string[] = [];
  let occurrences = 0;
  if (!needles.length || !fs.existsSync(absoluteRoot)) {
    return { files, occurrences, unscanned_files: unscannedFiles };
  }

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, fullPath);
      // DSH installs its own pnpm dependency graph inside the run-private
      // .barena-dsh profile. Those package-manager symlinks are Runtime
      // implementation files, not target evidence, and treating them as
      // unscanned artifacts makes every real DSH run fail closed. Keep
      // scanning the rest of .barena-dsh (notably persisted sessions), while
      // excluding only this Runtime-owned dependency subtree.
      if (isDshRuntimeDependencyDirectory(relative, entry)) continue;
      if (entry.isSymbolicLink()) {
        unscannedFiles.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        unscannedFiles.push(relative);
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_SCANNABLE_FILE_BYTES) {
        unscannedFiles.push(relative);
        continue;
      }
      const content = fs.readFileSync(fullPath);
      let changed = false;
      for (const needle of needles) {
        let offset = content.indexOf(needle);
        while (offset >= 0) {
          content.fill(0x2a, offset, offset + needle.length);
          occurrences += 1;
          changed = true;
          offset = content.indexOf(needle, offset + needle.length);
        }
      }
      if (changed) {
        fs.writeFileSync(fullPath, content);
        files.push(relative);
      }
    }
  };
  walk(absoluteRoot);
  return {
    files: files.sort(),
    occurrences,
    unscanned_files: unscannedFiles.sort(),
  };
}

function isDshRuntimeDependencyDirectory(
  relative: string,
  entry: fs.Dirent
): boolean {
  if (!entry.isDirectory() || entry.name !== "node_modules") return false;
  const parts = relative.split(path.sep);
  return parts.includes(".barena-dsh") && parts.includes("profiles");
}
