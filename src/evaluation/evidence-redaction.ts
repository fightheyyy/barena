import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/fs";

const REDACTED = "[REDACTED]";
const REDACTED_VALUE = /^\[REDACTED(?::[^\]]+)?\]$/;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy_authorization",
  "x_api_key",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "auth_token",
  "token",
  "secret",
  "secret_value",
  "password",
  "credential",
  "cookie",
  "set_cookie",
]);

export interface RedactionSecret {
  env_name: string;
  value: string;
}

export interface EvidenceRedactionContext {
  profile: string;
  secrets: RedactionSecret[];
  structured_field_names?: string[];
}

export interface SanitizedCopyResult {
  source_sha256: string;
  sanitized_sha256: string;
  replacement_count: number;
  structured_redaction_count: number;
  kind: "file" | "directory";
  status: "sanitized" | "copied";
}

export interface RetainedSecretScanResult {
  status: "pass" | "fail";
  hits: Array<{ file_ref: string; secret_name: string }>;
  scanned_files: number;
}

interface RedactionStats {
  replacement_count: number;
  structured_redaction_count: number;
}

interface RetainedEntry {
  path: string;
  kind: "file" | "directory";
}

export function sanitizeCopyToRetention(
  source: string,
  destination: string,
  context: EvidenceRedactionContext
): SanitizedCopyResult {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  if (!fs.existsSync(sourcePath)) throw new Error(`Redaction source does not exist: ${sourcePath}`);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Redaction source may not be a symlink: ${sourcePath}`);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Redaction source must be a file or directory: ${sourcePath}`);
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Retained evidence destination already exists: ${destinationPath}`);
  }

  const destinationParent = path.dirname(destinationPath);
  ensureDir(destinationParent);
  const stagingRoot = fs.mkdtempSync(path.join(destinationParent, `.${safeStagingName(path.basename(destinationPath))}.staging-`));
  const stagedPath = path.join(stagingRoot, "payload");
  try {
    const result = stat.isDirectory()
      ? sanitizeDirectoryInto(sourcePath, stagedPath, context)
      : sanitizeFileInto(sourcePath, stagedPath, context);
    if (fs.existsSync(destinationPath)) {
      throw new Error(`Retained evidence destination appeared during capture: ${destinationPath}`);
    }
    fs.renameSync(stagedPath, destinationPath);
    return result;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function writeSanitizedJson(
  destination: string,
  value: unknown,
  context: EvidenceRedactionContext
): SanitizedCopyResult {
  const sourceText = `${JSON.stringify(value, null, 2)}\n`;
  const stats: RedactionStats = { replacement_count: 0, structured_redaction_count: 0 };
  const sanitized = sanitizeValue(value, context, stats);
  const sanitizedText = `${JSON.stringify(sanitized, null, 2)}\n`;
  writeFileAtomically(path.resolve(destination), Buffer.from(sanitizedText, "utf8"));
  return {
    source_sha256: sha256(Buffer.from(sourceText)),
    sanitized_sha256: sha256(Buffer.from(sanitizedText)),
    replacement_count: stats.replacement_count,
    structured_redaction_count: stats.structured_redaction_count,
    kind: "file",
    status: stats.replacement_count || stats.structured_redaction_count ? "sanitized" : "copied",
  };
}

export function sanitizeTextForRetention(
  value: string,
  context: EvidenceRedactionContext
): { text: string; replacement_count: number; structured_redaction_count: number } {
  const stats: RedactionStats = { replacement_count: 0, structured_redaction_count: 0 };
  const text = sanitizeText(value, context, stats);
  return { text, ...stats };
}

export function scanRetainedTreeForSecrets(
  root: string,
  context: EvidenceRedactionContext
): RetainedSecretScanResult {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) return { status: "pass", hits: [], scanned_files: 0 };
  const hits: RetainedSecretScanResult["hits"] = [];
  const entries = listRetainedEntries(absoluteRoot);
  const files = entries.filter((entry) => entry.kind === "file");
  const secrets = normalizedSecrets(context);

  for (const entry of entries) {
    const relative = path.relative(absoluteRoot, entry.path);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      for (const secret of secrets) {
        if (component.includes(secret.value)) {
          hits.push({ file_ref: entry.path, secret_name: secret.env_name });
        }
      }
    }
  }

  for (const entry of files) {
    const bytes = fs.readFileSync(entry.path);
    for (const secret of secrets) {
      if (bytes.includes(Buffer.from(secret.value))) {
        hits.push({ file_ref: entry.path, secret_name: secret.env_name });
      }
    }
    if (!looksBinary(bytes)) {
      for (const fieldName of unredactedStructuredAssignmentsInFile(
        bytes.toString("utf8"),
        path.extname(entry.path).toLowerCase(),
        context
      )) {
        hits.push({ file_ref: entry.path, secret_name: `structured.${fieldName}` });
      }
    }
  }
  const unique = [...new Map(hits.map((hit) => [`${hit.file_ref}\0${hit.secret_name}`, hit])).values()];
  return { status: unique.length === 0 ? "pass" : "fail", hits: unique, scanned_files: files.length };
}

function sanitizeDirectoryInto(
  source: string,
  destination: string,
  context: EvidenceRedactionContext
): SanitizedCopyResult {
  ensureDir(destination);
  let replacementCount = 0;
  let structuredRedactionCount = 0;
  let sanitized = false;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Retained evidence may not copy symlinks: ${sourceEntry}`);
    if (entry.isDirectory()) {
      const result = sanitizeDirectoryInto(sourceEntry, destinationEntry, context);
      replacementCount += result.replacement_count;
      structuredRedactionCount += result.structured_redaction_count;
      sanitized ||= result.status === "sanitized";
    } else if (entry.isFile()) {
      const result = sanitizeFileInto(sourceEntry, destinationEntry, context);
      replacementCount += result.replacement_count;
      structuredRedactionCount += result.structured_redaction_count;
      sanitized ||= result.status === "sanitized";
    } else {
      throw new Error(`Retained evidence source contains a non-regular entry: ${sourceEntry}`);
    }
  }
  return {
    source_sha256: hashDirectoryAllFiles(source),
    sanitized_sha256: hashDirectoryAllFiles(destination),
    replacement_count: replacementCount,
    structured_redaction_count: structuredRedactionCount,
    kind: "directory",
    status: sanitized ? "sanitized" : "copied",
  };
}

function sanitizeFileInto(
  source: string,
  destination: string,
  context: EvidenceRedactionContext
): SanitizedCopyResult {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Retained evidence source must be a regular file: ${source}`);
  }
  const bytes = fs.readFileSync(source);
  const sourceSha256 = sha256(bytes);
  ensureDir(path.dirname(destination));
  if (looksBinary(bytes)) {
    for (const secret of normalizedSecrets(context)) {
      if (bytes.includes(Buffer.from(secret.value))) {
        throw new Error(`Binary evidence contains secret ${secret.env_name} and cannot be retained safely: ${source}`);
      }
    }
    fs.writeFileSync(destination, bytes);
    return {
      source_sha256: sourceSha256,
      sanitized_sha256: sourceSha256,
      replacement_count: 0,
      structured_redaction_count: 0,
      kind: "file",
      status: "copied",
    };
  }

  const stats: RedactionStats = { replacement_count: 0, structured_redaction_count: 0 };
  const sourceText = bytes.toString("utf8");
  const extension = path.extname(source).toLowerCase();
  let sanitizedText: string;
  if (extension === ".json") {
    sanitizedText = sanitizeJsonText(sourceText, context, stats);
  } else if ([".jsonl", ".ndjson"].includes(extension)) {
    sanitizedText = sanitizeNdjsonText(sourceText, context, stats);
  } else {
    sanitizedText = sanitizeText(sourceText, context, stats);
  }
  fs.writeFileSync(destination, sanitizedText, "utf8");
  return {
    source_sha256: sourceSha256,
    sanitized_sha256: sha256(Buffer.from(sanitizedText)),
    replacement_count: stats.replacement_count,
    structured_redaction_count: stats.structured_redaction_count,
    kind: "file",
    status: stats.replacement_count || stats.structured_redaction_count ? "sanitized" : "copied",
  };
}

function sanitizeJsonText(
  text: string,
  context: EvidenceRedactionContext,
  stats: RedactionStats
): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return `${JSON.stringify(sanitizeValue(parsed, context, stats), null, 2)}\n`;
  } catch {
    return sanitizeText(text, context, stats);
  }
}

function sanitizeNdjsonText(
  text: string,
  context: EvidenceRedactionContext,
  stats: RedactionStats
): string {
  const hadTrailingNewline = text.endsWith("\n");
  const rows = text.split(/\r?\n/);
  if (hadTrailingNewline) rows.pop();
  const sanitized = rows.map((line) => {
    if (!line) return line;
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(line) as unknown, context, stats));
    } catch {
      return sanitizeText(line, context, stats);
    }
  }).join("\n");
  return hadTrailingNewline ? `${sanitized}\n` : sanitized;
}

function sanitizeValue(value: unknown, context: EvidenceRedactionContext, stats: RedactionStats): unknown {
  if (typeof value === "string") return sanitizeText(value, context, stats);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, context, stats));
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactStructuredField(key, context)) {
      if (fieldValue !== null && fieldValue !== undefined && fieldValue !== REDACTED) {
        stats.structured_redaction_count += 1;
      }
      result[key] = REDACTED;
    } else {
      result[key] = sanitizeValue(fieldValue, context, stats);
    }
  }
  return result;
}

function sanitizeText(value: string, context: EvidenceRedactionContext, stats: RedactionStats): string {
  let result = replaceExactSecrets(value, context, stats);
  result = replacePattern(
    result,
    /(authorization\s*:\s*(?:bearer\s+)?)(?!\[REDACTED(?:[:][^\]]+)?\])([^\s\r\n]+)/gi,
    stats
  );
  result = result.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*)(\1\s*[:=]\s*["']?)([^\s\r\n,;"']+)/g,
    (match, quote: string, key: string, separator: string, fieldValue: string) => {
      if (!shouldRedactStructuredField(key, context) || REDACTED_VALUE.test(fieldValue)) return match;
      stats.structured_redaction_count += 1;
      return `${quote}${key}${separator}${REDACTED}`;
    }
  );
  for (const secret of normalizedSecrets(context)) {
    const expression = new RegExp(`(${escapeRegExp(secret.env_name)}\\s*=\\s*["']?)(?!\\[REDACTED(?:[:][^\\]]+)?\\])([^\\s\\r\\n"']+)`, "g");
    result = replacePattern(result, expression, stats);
  }
  return result;
}

function unredactedStructuredAssignments(value: string, context: EvidenceRedactionContext): string[] {
  const fields = new Set<string>();
  const authorizationPattern = /authorization\s*:\s*(?:bearer\s+)?([^\s\r\n]+)/gi;
  for (const match of value.matchAll(authorizationPattern)) {
    if (!REDACTED_VALUE.test(match[1])) fields.add("authorization");
  }
  const assignmentPattern = /["']?([A-Za-z_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*)["']?\s*[:=]\s*["']?([^\s\r\n,;"']+)/g;
  for (const match of value.matchAll(assignmentPattern)) {
    const key = match[1];
    const fieldValue = match[2];
    if (shouldRedactStructuredField(key, context) && !REDACTED_VALUE.test(fieldValue)) {
      fields.add(normalizeKey(key));
    }
  }
  return [...fields].sort();
}

function unredactedStructuredAssignmentsInFile(
  value: string,
  extension: string,
  context: EvidenceRedactionContext
): string[] {
  if (extension === ".json") {
    try {
      return unredactedStructuredValues(JSON.parse(value) as unknown, context);
    } catch {
      return unredactedStructuredAssignments(value, context);
    }
  }
  if ([".jsonl", ".ndjson"].includes(extension)) {
    const fields = new Set<string>();
    for (const line of value.split(/\r?\n/).filter(Boolean)) {
      let lineFields: string[];
      try {
        lineFields = unredactedStructuredValues(JSON.parse(line) as unknown, context);
      } catch {
        lineFields = unredactedStructuredAssignments(line, context);
      }
      for (const field of lineFields) fields.add(field);
    }
    return [...fields].sort();
  }
  return unredactedStructuredAssignments(value, context);
}

function unredactedStructuredValues(value: unknown, context: EvidenceRedactionContext): string[] {
  const fields = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      for (const field of unredactedStructuredAssignments(current, context)) fields.add(field);
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, fieldValue] of Object.entries(current as Record<string, unknown>)) {
      if (shouldRedactStructuredField(key, context)) {
        if (typeof fieldValue !== "string" || !REDACTED_VALUE.test(fieldValue)) fields.add(normalizeKey(key));
      } else {
        visit(fieldValue);
      }
    }
  };
  visit(value);
  return [...fields].sort();
}

function replacePattern(value: string, pattern: RegExp, stats: RedactionStats): string {
  return value.replace(pattern, (_match, prefix: string) => {
    stats.structured_redaction_count += 1;
    return `${prefix}${REDACTED}`;
  });
}

function replaceExactSecrets(value: string, context: EvidenceRedactionContext, stats: RedactionStats): string {
  let result = value;
  for (const secret of normalizedSecrets(context)) {
    if (!secret.value || !result.includes(secret.value)) continue;
    const parts = result.split(secret.value);
    stats.replacement_count += parts.length - 1;
    result = parts.join(`[REDACTED:${secret.env_name}]`);
  }
  return result;
}

function shouldRedactStructuredField(value: string, context: EvidenceRedactionContext): boolean {
  const normalized = normalizeKey(value);
  return !isContractCriticalField(normalized) && sensitiveFieldNames(context).has(normalized);
}

function isContractCriticalField(normalized: string): boolean {
  return normalized === "schema" ||
    normalized === "schema_version" ||
    normalized.endsWith("_schema") ||
    normalized === "decision" ||
    normalized.endsWith("_decision") ||
    normalized === "status" ||
    normalized.endsWith("_status") ||
    normalized === "identity" ||
    normalized.startsWith("identity_") ||
    normalized.endsWith("_identity") ||
    normalized === "usage" ||
    normalized.startsWith("usage_") ||
    normalized.endsWith("_usage") ||
    normalized === "evidence" ||
    normalized.startsWith("evidence_") ||
    normalized.endsWith("_evidence") ||
    normalized === "evidence_refs";
}

function sensitiveFieldNames(context: EvidenceRedactionContext): Set<string> {
  return new Set([
    ...SENSITIVE_KEYS,
    ...context.secrets.map((secret) => normalizeKey(secret.env_name)),
    ...(context.structured_field_names ?? []).map(normalizeKey),
  ]);
}

function normalizedSecrets(context: EvidenceRedactionContext): RedactionSecret[] {
  const values = context.secrets
    .filter((secret) => secret.value.length > 0)
    .sort((left, right) => right.value.length - left.value.length || left.env_name.localeCompare(right.env_name));
  return [...new Map(values.map((secret) => [`${secret.env_name}\0${secret.value}`, secret])).values()];
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.\s]+/g, "_")
    .replace(/_+/g, "_");
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashDirectoryAllFiles(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listRegularFiles(root)) {
    hash.update(path.relative(root, filePath));
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listRegularFiles(root: string): string[] {
  return listRetainedEntries(root)
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .sort();
}

function listRetainedEntries(root: string): RetainedEntry[] {
  const entries: RetainedEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Retained evidence tree may not contain symlinks: ${fullPath}`);
    if (entry.isDirectory()) {
      entries.push({ path: fullPath, kind: "directory" });
      entries.push(...listRetainedEntries(fullPath));
    } else if (entry.isFile()) {
      entries.push({ path: fullPath, kind: "file" });
    } else {
      throw new Error(`Retained evidence tree contains a non-regular entry: ${fullPath}`);
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

function writeFileAtomically(destination: string, bytes: Buffer): void {
  const parent = path.dirname(destination);
  ensureDir(parent);
  const stagingRoot = fs.mkdtempSync(path.join(parent, `.${safeStagingName(path.basename(destination))}.staging-`));
  const stagedPath = path.join(stagingRoot, "payload");
  try {
    fs.writeFileSync(stagedPath, bytes);
    fs.renameSync(stagedPath, destination);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function safeStagingName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "retained";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
