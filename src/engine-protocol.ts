import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSafeRunId, isPathContained } from "./runs/path-safety";
import { appendNdjson, readNdjson, writeJson } from "./utils/fs";

export const ENGINE_REQUEST_SCHEMA_V1 = "barena.engine_request.v1" as const;
export const ENGINE_EVENT_SCHEMA_V1 = "barena.engine_event.v1" as const;
export const RUN_PACKAGE_SCHEMA_V1 = "barena.run_package.v1" as const;

export type EngineOperation = "explore" | "replay" | "compare";

export interface EngineRequestV1 {
  schema: typeof ENGINE_REQUEST_SCHEMA_V1;
  request_id: string;
  run_id: string;
  operation: EngineOperation;
  runs_root: string;
  input: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

export interface EngineEventV1 {
  schema: typeof ENGINE_EVENT_SCHEMA_V1;
  event_id: string;
  run_id: string;
  sequence: number;
  timestamp: string;
  operation: EngineOperation;
  kind: string;
  phase: string;
  actor: string;
  attempt_id?: string;
  trace_id?: string;
  payload: Record<string, unknown>;
}

export interface EngineEventDraft {
  kind: string;
  phase: string;
  actor: string;
  attempt_id?: string;
  trace_id?: string;
  payload?: Record<string, unknown>;
}

export type RunPackageStatus =
  | "complete"
  | "cancelled"
  | "interrupted"
  | "failed";

export interface RunPackageFileV1 {
  ref: string;
  kind: string;
  media_type: string;
  size: number;
  sha256: string;
}

export interface RunPackageV1 {
  schema: typeof RUN_PACKAGE_SCHEMA_V1;
  run_id: string;
  status: RunPackageStatus;
  result_ref: string;
  files: RunPackageFileV1[];
}

export interface RunPackageFileInput {
  ref: string;
  kind: string;
  media_type: string;
}

export class EngineProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineProtocolError";
  }
}

export function parseEngineRequestV1(value: unknown): EngineRequestV1 {
  const record = requireRecord(value, "Engine request");
  if (record.schema !== ENGINE_REQUEST_SCHEMA_V1) {
    throw new EngineProtocolError(
      `Engine request schema must be ${ENGINE_REQUEST_SCHEMA_V1}`
    );
  }
  const requestId = requireSafeId(record.request_id, "request_id");
  const runId = requireSafeId(record.run_id, "run_id");
  const operation = requireOperation(record.operation);
  const runsRoot = requireString(record.runs_root, "runs_root");
  if (!path.isAbsolute(runsRoot)) {
    throw new EngineProtocolError("runs_root must be an absolute path");
  }
  const input = requireRecord(record.input, "input");
  const runtime = record.runtime === undefined
    ? undefined
    : requireRecord(record.runtime, "runtime");
  return {
    schema: ENGINE_REQUEST_SCHEMA_V1,
    request_id: requestId,
    run_id: runId,
    operation,
    runs_root: path.resolve(runsRoot),
    input,
    ...(runtime && { runtime }),
  };
}

export function assertEngineRequestV1(
  value: unknown
): asserts value is EngineRequestV1 {
  parseEngineRequestV1(value);
}

export function parseEngineEventV1(value: unknown): EngineEventV1 {
  const record = requireRecord(value, "Engine event");
  if (record.schema !== ENGINE_EVENT_SCHEMA_V1) {
    throw new EngineProtocolError(
      `Engine event schema must be ${ENGINE_EVENT_SCHEMA_V1}`
    );
  }
  const sequence = requirePositiveInteger(record.sequence, "sequence");
  const timestamp = requireTimestamp(record.timestamp, "timestamp");
  const eventId = requireString(record.event_id, "event_id");
  const runId = requireSafeId(record.run_id, "run_id");
  const operation = requireOperation(record.operation);
  const kind = requireToken(record.kind, "kind");
  const phase = requireToken(record.phase, "phase");
  const actor = requireToken(record.actor, "actor");
  const attemptId = record.attempt_id === undefined
    ? undefined
    : requireSafeId(record.attempt_id, "attempt_id");
  const traceId = record.trace_id === undefined
    ? undefined
    : requireTraceId(record.trace_id);
  const payload = requireRecord(record.payload, "payload");
  return {
    schema: ENGINE_EVENT_SCHEMA_V1,
    event_id: eventId,
    run_id: runId,
    sequence,
    timestamp,
    operation,
    kind,
    phase,
    actor,
    ...(attemptId && { attempt_id: attemptId }),
    ...(traceId && { trace_id: traceId }),
    payload,
  };
}

export function assertEngineEventV1(
  value: unknown
): asserts value is EngineEventV1 {
  parseEngineEventV1(value);
}

export class EngineEventWriter {
  readonly events_ref: string;
  private sequence: number;

  constructor(
    private readonly options: {
      run_root: string;
      run_id: string;
      operation: EngineOperation;
      now?: () => Date;
      emit?: (line: string, event: EngineEventV1) => void | Promise<void>;
    }
  ) {
    assertSafeRunId(options.run_id);
    const runRoot = path.resolve(options.run_root);
    if (!fs.existsSync(runRoot) || !fs.statSync(runRoot).isDirectory()) {
      throw new EngineProtocolError(
        `Engine event run root does not exist: ${runRoot}`
      );
    }
    this.events_ref = path.join(runRoot, "events.ndjson");
    const existing = readNdjson<unknown>(this.events_ref).map(parseEngineEventV1);
    for (const [index, event] of existing.entries()) {
      if (event.run_id !== options.run_id) {
        throw new EngineProtocolError(
          `Persisted event ${index + 1} belongs to another run`
        );
      }
      if (event.operation !== options.operation) {
        throw new EngineProtocolError(
          `Persisted event ${index + 1} belongs to another operation`
        );
      }
      if (event.sequence !== index + 1) {
        throw new EngineProtocolError(
          "Persisted Engine event sequence is not contiguous"
        );
      }
    }
    this.sequence = existing.length;
  }

  async write(draft: EngineEventDraft): Promise<EngineEventV1> {
    const sequence = this.sequence + 1;
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    const event = parseEngineEventV1({
      schema: ENGINE_EVENT_SCHEMA_V1,
      event_id: `${this.options.run_id}.${sequence}`,
      run_id: this.options.run_id,
      sequence,
      timestamp,
      operation: this.options.operation,
      kind: draft.kind,
      phase: draft.phase,
      actor: draft.actor,
      ...(draft.attempt_id && { attempt_id: draft.attempt_id }),
      ...(draft.trace_id && { trace_id: draft.trace_id }),
      payload: draft.payload ?? {},
    });
    const line = JSON.stringify(event);
    appendNdjson(this.events_ref, [event]);
    this.sequence = sequence;
    await this.options.emit?.(line, event);
    return event;
  }
}

export function createRunPackageV1(input: {
  run_root: string;
  run_id: string;
  status: RunPackageStatus;
  result_ref: string;
  files: RunPackageFileInput[];
}): RunPackageV1 {
  assertSafeRunId(input.run_id);
  const runRoot = requireDirectory(input.run_root, "run_root");
  const resultRef = requireRunRelativeRef(input.result_ref, "result_ref");
  if (input.files.length === 0) {
    throw new EngineProtocolError("Run package files must not be empty");
  }
  const seen = new Set<string>();
  const files = input.files.map((entry, index): RunPackageFileV1 => {
    const ref = requireRunRelativeRef(entry.ref, `files[${index}].ref`);
    if (seen.has(ref)) {
      throw new EngineProtocolError(`Run package lists ${ref} more than once`);
    }
    seen.add(ref);
    const absolute = resolvePackageFile(runRoot, ref);
    const bytes = fs.readFileSync(absolute);
    return {
      ref,
      kind: requireToken(entry.kind, `files[${index}].kind`),
      media_type: requireMediaType(
        entry.media_type,
        `files[${index}].media_type`
      ),
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
  if (!seen.has(resultRef)) {
    throw new EngineProtocolError(
      "Run package result_ref must also appear in files"
    );
  }
  return parseRunPackageV1({
    schema: RUN_PACKAGE_SCHEMA_V1,
    run_id: input.run_id,
    status: input.status,
    result_ref: resultRef,
    files,
  });
}

export function writeRunPackageV1(
  runRoot: string,
  value: RunPackageV1,
  ref = "run-package.json"
): string {
  const parsed = parseRunPackageV1(value);
  const packageRef = requireRunRelativeRef(ref, "package ref");
  const root = requireDirectory(runRoot, "run_root");
  const destination = path.join(root, ...packageRef.split("/"));
  if (!isPathContained(root, destination)) {
    throw new EngineProtocolError("Run package path escapes the run root");
  }
  writeJson(destination, parsed);
  return destination;
}

export function parseRunPackageV1(value: unknown): RunPackageV1 {
  const record = requireRecord(value, "Run package");
  if (record.schema !== RUN_PACKAGE_SCHEMA_V1) {
    throw new EngineProtocolError(
      `Run package schema must be ${RUN_PACKAGE_SCHEMA_V1}`
    );
  }
  const runId = requireSafeId(record.run_id, "run_id");
  const status = requirePackageStatus(record.status);
  const resultRef = requireRunRelativeRef(record.result_ref, "result_ref");
  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new EngineProtocolError("Run package files must be a non-empty array");
  }
  const seen = new Set<string>();
  const files = record.files.map((value, index): RunPackageFileV1 => {
    const entry = requireRecord(value, `files[${index}]`);
    const ref = requireRunRelativeRef(entry.ref, `files[${index}].ref`);
    if (seen.has(ref)) {
      throw new EngineProtocolError(`Run package lists ${ref} more than once`);
    }
    seen.add(ref);
    const size = requireNonNegativeInteger(entry.size, `files[${index}].size`);
    const sha256 = requireString(entry.sha256, `files[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new EngineProtocolError(`files[${index}].sha256 is invalid`);
    }
    return {
      ref,
      kind: requireToken(entry.kind, `files[${index}].kind`),
      media_type: requireMediaType(
        entry.media_type,
        `files[${index}].media_type`
      ),
      size,
      sha256,
    };
  });
  if (!seen.has(resultRef)) {
    throw new EngineProtocolError(
      "Run package result_ref must also appear in files"
    );
  }
  return {
    schema: RUN_PACKAGE_SCHEMA_V1,
    run_id: runId,
    status,
    result_ref: resultRef,
    files,
  };
}

export function assertRunPackageV1(
  value: unknown
): asserts value is RunPackageV1 {
  parseRunPackageV1(value);
}

export function verifyRunPackageV1(
  runRoot: string,
  value: unknown
): RunPackageV1 {
  const root = requireDirectory(runRoot, "run_root");
  const parsed = parseRunPackageV1(value);
  for (const entry of parsed.files) {
    const absolute = resolvePackageFile(root, entry.ref);
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== entry.size) {
      throw new EngineProtocolError(
        `Run package size mismatch for ${entry.ref}`
      );
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.sha256) {
      throw new EngineProtocolError(
        `Run package hash mismatch for ${entry.ref}`
      );
    }
  }
  return parsed;
}

function requireOperation(value: unknown): EngineOperation {
  if (value !== "explore" && value !== "replay" && value !== "compare") {
    throw new EngineProtocolError(
      "operation must be explore, replay, or compare"
    );
  }
  return value;
}

function requirePackageStatus(value: unknown): RunPackageStatus {
  if (
    value !== "complete" &&
    value !== "cancelled" &&
    value !== "interrupted" &&
    value !== "failed"
  ) {
    throw new EngineProtocolError(
      "Run package status must be complete, cancelled, interrupted, or failed"
    );
  }
  return value;
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EngineProtocolError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireSafeId(value: unknown, label: string): string {
  const id = requireString(value, label);
  try {
    assertSafeRunId(id);
  } catch {
    throw new EngineProtocolError(`${label} must be a safe path segment`);
  }
  return id;
}

function requireToken(value: unknown, label: string): string {
  const token = requireString(value, label);
  if (token.length > 120 || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new EngineProtocolError(
      `${label} must contain only letters, numbers, dot, underscore, or dash`
    );
  }
  return token;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new EngineProtocolError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireTraceId(value: unknown): string {
  const traceId = requireString(value, "trace_id");
  if (!/^[a-f0-9]{32}$/i.test(traceId)) {
    throw new EngineProtocolError("trace_id must be 32 hexadecimal characters");
  }
  return traceId.toLowerCase();
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new EngineProtocolError(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new EngineProtocolError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireMediaType(value: unknown, label: string): string {
  const mediaType = requireString(value, label);
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new EngineProtocolError(`${label} must be a media type`);
  }
  return mediaType.toLowerCase();
}

function requireDirectory(value: string, label: string): string {
  const root = path.resolve(value);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new EngineProtocolError(`${label} does not exist or is not a directory`);
  }
  return fs.realpathSync(root);
}

function requireRunRelativeRef(value: unknown, label: string): string {
  const ref = requireString(value, label);
  if (
    ref.includes("\\") ||
    path.posix.isAbsolute(ref) ||
    ref === "." ||
    ref === ".." ||
    ref.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(ref) !== ref
  ) {
    throw new EngineProtocolError(
      `${label} must be a normalized run-relative POSIX path`
    );
  }
  return ref;
}

function resolvePackageFile(runRoot: string, ref: string): string {
  const parts = ref.split("/");
  let current = runRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      throw new EngineProtocolError(`Run package file does not exist: ${ref}`);
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new EngineProtocolError(`Run package ref may not contain symlinks: ${ref}`);
    }
  }
  const absolute = fs.realpathSync(current);
  if (!isPathContained(runRoot, absolute)) {
    throw new EngineProtocolError(`Run package ref escapes the run root: ${ref}`);
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new EngineProtocolError(`Run package ref is not a file: ${ref}`);
  }
  return absolute;
}
