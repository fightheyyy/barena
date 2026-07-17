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
  const hash = crypto.createHash("sha256");
  for (const filePath of listFiles(root)) {
    const relative = path.relative(root, filePath);
    hash.update(relative);
    hash.update(fs.readFileSync(filePath));
  }
  return hash.digest("hex");
}

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "output", "logs"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "subject";
}

