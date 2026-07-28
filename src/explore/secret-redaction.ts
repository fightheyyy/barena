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
