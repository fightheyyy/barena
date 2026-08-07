import path from "node:path";
import type { RuntimeTelemetryConfig } from "../runtime-adapters";
import {
  isXiaobaEvolutionRole,
  XiaobaEvolutionRuntime,
  type XiaobaEvolutionRuntimeOptions,
} from "./xiaoba-evolution-runtime";
import type {
  XiaobaEvolutionRuntimeConfigV1,
  XiaobaEvolutionWorkerRequestV1,
  XiaobaEvolutionWorkerResponseV1,
} from "./types";

export class EvolutionRuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionRuntimeProtocolError";
  }
}

export interface ExecuteEvolutionRuntimeRequestOptions {
  signal?: AbortSignal;
  createRuntime?: (options: XiaobaEvolutionRuntimeOptions) => XiaobaEvolutionRuntime;
}

export async function executeEvolutionRuntimeRequest(
  input: unknown,
  options: ExecuteEvolutionRuntimeRequestOptions = {}
): Promise<XiaobaEvolutionWorkerResponseV1> {
  let request: XiaobaEvolutionWorkerRequestV1;
  try {
    request = parseEvolutionRuntimeRequestV1(input);
  } catch (error) {
    return errorResponse("unknown", "unknown", "invalid_request", safeMessage(error));
  }

  const runtime = (options.createRuntime ?? ((runtimeOptions) => new XiaobaEvolutionRuntime(runtimeOptions)))({
    runtime: request.runtime,
  });
  try {
    if (request.operation === "probe") {
      return {
        schema: "barena.xiaoba_evolution_response.v1",
        request_id: request.request_id,
        operation: "probe",
        status: "ok",
        runtime: await runtime.probe(),
      };
    }
    return {
      schema: "barena.xiaoba_evolution_response.v1",
      request_id: request.request_id,
      operation: "turn",
      status: "ok",
      result: await runtime.runRoleTurn(request, options.signal),
    };
  } catch (error) {
    return errorResponse(
      request.request_id,
      request.operation,
      "runtime_error",
      publicRuntimeError(error)
    );
  }
}

export function parseEvolutionRuntimeRequestV1(
  input: unknown
): XiaobaEvolutionWorkerRequestV1 {
  const value = objectValue(input, "request");
  if (value.schema !== "barena.xiaoba_evolution_request.v1") {
    throw new EvolutionRuntimeProtocolError(
      "schema must be barena.xiaoba_evolution_request.v1"
    );
  }
  const requestId = safeIdentifier(value.request_id, "request_id");
  const runtime = optionalRuntimeConfig(value.runtime);
  if (value.operation === "probe") {
    return {
      schema: "barena.xiaoba_evolution_request.v1",
      request_id: requestId,
      operation: "probe",
      ...(runtime && { runtime }),
    };
  }
  if (value.operation !== "turn") {
    throw new EvolutionRuntimeProtocolError("operation must be probe or turn");
  }
  const runId = safeIdentifier(value.run_id, "run_id");
  const role = stringValue(value.role, "role");
  if (!isXiaobaEvolutionRole(role)) {
    throw new EvolutionRuntimeProtocolError(
      "role must be one of user-cat, inspector-cat, reviewer-cat, evolution-cat"
    );
  }
  const prompt = boundedString(value.prompt, "prompt", 1_000_000);
  const workspace = stringValue(value.workspace, "workspace");
  if (!path.isAbsolute(workspace)) {
    throw new EvolutionRuntimeProtocolError("workspace must be an absolute path");
  }
  const timeoutMs = integerValue(value.timeout_ms, "timeout_ms", 1, 900_000);
  const telemetry = optionalTelemetry(value.telemetry);
  return {
    schema: "barena.xiaoba_evolution_request.v1",
    request_id: requestId,
    operation: "turn",
    run_id: runId,
    role,
    prompt,
    workspace: path.resolve(workspace),
    timeout_ms: timeoutMs,
    ...(telemetry && { telemetry }),
    ...(runtime && { runtime }),
  };
}

function optionalRuntimeConfig(value: unknown): XiaobaEvolutionRuntimeConfigV1 | undefined {
  if (value === undefined) return undefined;
  const config = objectValue(value, "runtime");
  return {
    ...(optionalString(config.command, "runtime.command") && {
      command: optionalString(config.command, "runtime.command"),
    }),
    ...(optionalString(config.project_root, "runtime.project_root") && {
      project_root: optionalAbsolutePath(config.project_root, "runtime.project_root"),
    }),
    ...(optionalString(config.roles_root, "runtime.roles_root") && {
      roles_root: optionalAbsolutePath(config.roles_root, "runtime.roles_root"),
    }),
    ...(optionalString(config.skills_root, "runtime.skills_root") && {
      skills_root: optionalAbsolutePath(config.skills_root, "runtime.skills_root"),
    }),
    ...(config.env_allowlist !== undefined && {
      env_allowlist: envAllowlist(config.env_allowlist),
    }),
    ...(config.env_overrides !== undefined && {
      env_overrides: boundedEnvironmentRecord(config.env_overrides),
    }),
    ...(config.probe_timeout_ms !== undefined && {
      probe_timeout_ms: integerValue(
        config.probe_timeout_ms,
        "runtime.probe_timeout_ms",
        1,
        60_000
      ),
    }),
    ...(config.max_output_bytes !== undefined && {
      max_output_bytes: integerValue(
        config.max_output_bytes,
        "runtime.max_output_bytes",
        1_024,
        64 * 1024 * 1024
      ),
    }),
    ...(config.kill_grace_ms !== undefined && {
      kill_grace_ms: integerValue(
        config.kill_grace_ms,
        "runtime.kill_grace_ms",
        1,
        60_000
      ),
    }),
  };
}

function boundedEnvironmentRecord(value: unknown): Record<string, string> {
  const record = objectValue(value, "runtime.env_overrides");
  const entries = Object.entries(record);
  if (entries.length > 8) {
    throw new EvolutionRuntimeProtocolError(
      "runtime.env_overrides exceeds 8 entries"
    );
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EvolutionRuntimeProtocolError(
        "runtime.env_overrides contains an invalid name"
      );
    }
    result[key] = boundedString(rawValue, `runtime.env_overrides.${key}`, 16_384);
  }
  return result;
}

function optionalTelemetry(value: unknown): RuntimeTelemetryConfig | undefined {
  if (value === undefined) return undefined;
  const telemetry = objectValue(value, "telemetry");
  const endpoint = boundedString(telemetry.traces_endpoint, "telemetry.traces_endpoint", 2_048);
  return {
    traces_endpoint: endpoint,
    ...(telemetry.headers !== undefined && {
      headers: boundedStringRecord(telemetry.headers, "telemetry.headers", 32, 4_096),
    }),
    ...(telemetry.resource_attributes !== undefined && {
      resource_attributes: boundedStringRecord(
        telemetry.resource_attributes,
        "telemetry.resource_attributes",
        64,
        2_048
      ),
    }),
    ...(optionalString(telemetry.service_name, "telemetry.service_name") && {
      service_name: optionalString(telemetry.service_name, "telemetry.service_name"),
    }),
    ...(optionalString(telemetry.traceparent, "telemetry.traceparent") && {
      traceparent: optionalString(telemetry.traceparent, "telemetry.traceparent"),
    }),
    ...(optionalString(telemetry.tracestate, "telemetry.tracestate") && {
      tracestate: optionalString(telemetry.tracestate, "telemetry.tracestate"),
    }),
    ...(telemetry.protocol === "http/protobuf" || telemetry.protocol === "http/json"
      ? { protocol: telemetry.protocol }
      : {}),
    ...(telemetry.export_timeout_ms !== undefined && {
      export_timeout_ms: integerValue(
        telemetry.export_timeout_ms,
        "telemetry.export_timeout_ms",
        1,
        120_000
      ),
    }),
  };
}

function boundedStringRecord(
  value: unknown,
  label: string,
  maxEntries: number,
  maxValueBytes: number
): Record<string, string> {
  const record = objectValue(value, label);
  const entries = Object.entries(record);
  if (entries.length > maxEntries) {
    throw new EvolutionRuntimeProtocolError(
      `${label} exceeds ${maxEntries} entries`
    );
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      throw new EvolutionRuntimeProtocolError(`${label} contains an invalid key`);
    }
    result[key] = boundedString(rawValue, `${label}.${key}`, maxValueBytes);
  }
  return result;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvolutionRuntimeProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvolutionRuntimeProtocolError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

function boundedString(value: unknown, label: string, max: number): string {
  const result = stringValue(value, label);
  if (Buffer.byteLength(result, "utf8") > max) {
    throw new EvolutionRuntimeProtocolError(`${label} exceeds ${max} bytes`);
  }
  return result;
}

function safeIdentifier(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) {
    throw new EvolutionRuntimeProtocolError(`${label} must be a safe identifier`);
  }
  return result;
}

function integerValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new EvolutionRuntimeProtocolError(
      `${label} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value as number;
}

function optionalAbsolutePath(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!path.isAbsolute(result)) {
    throw new EvolutionRuntimeProtocolError(`${label} must be an absolute path`);
  }
  return path.resolve(result);
}

function envAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new EvolutionRuntimeProtocolError("runtime.env_allowlist must be an array of at most 64 names");
  }
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) {
      throw new EvolutionRuntimeProtocolError("runtime.env_allowlist contains an invalid name");
    }
    return entry;
  }))];
}

function errorResponse(
  requestId: string,
  operation: "probe" | "turn" | "unknown",
  code: "invalid_request" | "runtime_error",
  detail: string
): XiaobaEvolutionWorkerResponseV1 {
  return {
    schema: "barena.xiaoba_evolution_response.v1",
    request_id: requestId,
    operation,
    status: "error",
    error: { code, detail },
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Invalid Evolution Runtime request")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function publicRuntimeError(error: unknown): string {
  if (error instanceof EvolutionRuntimeProtocolError) return safeMessage(error);
  if (error instanceof Error && error.name === "AbortError") {
    return "Evolution Runtime request was cancelled.";
  }
  return "Embedded XiaoBaOS could not complete the requested role turn.";
}
