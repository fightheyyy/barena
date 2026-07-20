import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function appendNdjson(filePath: string, rows: unknown[]): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
}

export function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function copyDirectory(source: string, destination: string): void {
  ensureDir(destination);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const base = path.basename(entry);
      return ![".git", "node_modules", "dist", "output", "logs", ".env"].includes(base);
    },
  });
}

export function hashDirectory(root: string): string {
  const requestedRoot = path.resolve(root);
  const absoluteRoot = fs.realpathSync(requestedRoot);
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Directory fingerprint root must be a directory: ${requestedRoot}`);
  }

  const hash = crypto.createHash("sha256");
  hash.update("barena-directory-fingerprint-v2\0");
  for (const entry of listFingerprintEntries(absoluteRoot, absoluteRoot)) {
    const relativeBytes = Buffer.from(entry.relative, "utf8");
    const content = entry.type === "file" ? fs.readFileSync(entry.path) : Buffer.alloc(0);
    const header = Buffer.alloc(13);
    header.writeUInt8(entry.type === "file" ? 1 : 2, 0);
    header.writeUInt32BE(relativeBytes.length, 1);
    header.writeBigUInt64BE(BigInt(content.length), 5);
    hash.update(header);
    hash.update(relativeBytes);
    hash.update(content);
  }
  return hash.digest("hex");
}

interface FingerprintEntry {
  path: string;
  relative: string;
  type: "file" | "directory";
}

function listFingerprintEntries(root: string, current: string): FingerprintEntry[] {
  const entries: FingerprintEntry[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "output", "logs"].includes(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isSymbolicLink()) throw new Error(`Directory fingerprint input may not contain symlinks: ${fullPath}`);
    if (entry.isDirectory()) {
      entries.push({ path: fullPath, relative, type: "directory" });
      entries.push(...listFingerprintEntries(root, fullPath));
    } else if (entry.isFile()) {
      entries.push({ path: fullPath, relative, type: "file" });
    } else {
      throw new Error(`Directory fingerprint input contains a non-regular entry: ${fullPath}`);
    }
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative) || left.type.localeCompare(right.type));
}

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "subject";
}

