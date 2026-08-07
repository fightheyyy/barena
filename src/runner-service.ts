import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { executeEngineRequest } from "./engine-worker";
import { executeEvolutionRuntimeRequest } from "./evolution-runtime";
import type {
  XiaobaEvolutionWorkerRequestV1,
  XiaobaEvolutionWorkerResponseV1,
} from "./evolution-runtime/types";
import type { RuntimeTelemetryConfig } from "./runtime-adapters";
import type { PlatformTelemetryConfig } from "./telemetry/platform-otlp-export";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_ADDR = "0.0.0.0:8790";
const ENGINE_PATH = "/v1/engine/run";
const EVOLUTION_PATH = "/v1/evolution/run";
const SCENARIO_TURN_PATH = "/v1/scenario/turn";
const DEFAULT_EVOLUTION_TURN_TIMEOUT_MS = 120_000;
const SCENARIO_ROLES = new Set(["user-cat", "reviewer-cat"] as const);
const OWNER_MODEL_ENV_NAMES = new Set([
  "XIAOBA_LLM_PROVIDER",
  "XIAOBA_LLM_API_BASE",
  "XIAOBA_LLM_API_KEY",
  "XIAOBA_LLM_MODEL",
]);

export interface SpiralRunnerServiceOptions {
  address?: string;
  runsRoot?: string;
  evolutionRoot?: string;
  evolutionTurnTimeoutMs?: number;
  mode?: "all" | "evolution";
}

interface RunnerServiceConfig {
  host: string;
  port: number;
  runsRoot: string;
  evolutionRoot: string;
  evolutionTurnTimeoutMs: number;
  mode: "all" | "evolution";
}

/**
 * Internal execution-plane service used by spiral-core. It deliberately keeps
 * the existing Barena request/event schemas and XiaoBa evolution protocol on
 * the wire; HTTP only replaces local child-process ownership.
 */
export function createSpiralRunnerServer(
  options: SpiralRunnerServiceOptions = {},
): http.Server {
  const config = serviceConfig(options);
  const engineRequests = new Map<string, AbortController>();

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, {
          status: "ok",
          service: "spiral-runner",
          mode: config.mode,
        });
        return;
      }
      if (request.method === "GET" && request.url === "/readyz") {
        const probe = await executeEvolutionRuntimeRequest({
          schema: "barena.xiaoba_evolution_request.v1",
          request_id: "spiral-runner-readiness",
          operation: "probe",
          runtime: evolutionRuntimeConfig(),
        });
        const runtimeReady =
          probe.status === "ok" &&
          probe.operation === "probe" &&
          probe.runtime.status === "ready";
        writeJson(response, runtimeReady ? 200 : 503, {
          status: runtimeReady ? "ready" : "blocked",
          service: "spiral-runner",
          mode: config.mode,
          ...(config.mode === "all" && {
            engine_protocol: "barena.engine_request.v1",
            event_protocol: "barena.engine_event.v1",
            scenario_protocol: "barena.xiaoba_scenario_request.v1",
          }),
          evolution_protocol: "barena.xiaoba_evolution_request.v1",
          evolution_runtime:
            probe.status === "ok" && probe.operation === "probe"
              ? probe.runtime.status
              : "blocked",
        });
        return;
      }
      if (
        config.mode === "all" &&
        request.method === "POST" &&
        request.url === ENGINE_PATH
      ) {
        await handleEngineRequest(request, response, config, engineRequests);
        return;
      }
      if (request.method === "POST" && request.url === EVOLUTION_PATH) {
        await handleEvolutionRequest(request, response, config);
        return;
      }
      if (
        config.mode === "all" &&
        request.method === "POST" &&
        request.url === SCENARIO_TURN_PATH
      ) {
        await handleScenarioTurnRequest(request, response, config);
        return;
      }
      const cancelMatch = request.url?.match(
        /^\/v1\/engine\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/cancel$/,
      );
      if (config.mode === "all" && request.method === "POST" && cancelMatch) {
        const runId = cancelMatch[1]!;
        const active = engineRequests.get(runId);
        active?.abort("spiral-core requested cancellation");
        writeJson(response, active ? 202 : 200, {
          status: active ? "cancelling" : "not_running",
          run_id: runId,
        });
        return;
      }
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: "runner_error",
          detail: safeMessage(error),
        });
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
}

export async function startSpiralRunnerService(
  options: SpiralRunnerServiceOptions = {},
): Promise<http.Server> {
  const config = serviceConfig(options);
  const server = createSpiralRunnerServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleEngineRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RunnerServiceConfig,
  active: Map<string, AbortController>,
): Promise<void> {
  const input = bindRunnerOwnedEngineRequest(await readJson(request));
  const engine = objectValue(input, "Engine request");
  const runId = safeIdentifier(engine.run_id, "run_id");
  const requestedRoot = absolutePath(engine.runs_root, "runs_root");
  if (requestedRoot !== config.runsRoot) {
    throw new Error(
      "Engine request runs_root is outside the configured shared volume",
    );
  }
  if (active.has(runId)) {
    writeJson(response, 409, { error: "run_already_active", run_id: runId });
    return;
  }

  const abort = new AbortController();
  active.set(runId, abort);
  let completed = false;
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    trailer: "X-Spiral-Runner-Status, X-Spiral-Runner-Error",
  });
  response.flushHeaders();
  response.on("close", () => {
    if (!completed) abort.abort("spiral-core disconnected");
  });
  try {
    const platformTelemetry = platformTelemetryConfig();
    await executeEngineRequest(input, {
      signal: abort.signal,
      emit: async (line) => writeLine(response, line),
      ...(platformTelemetry && { platformTelemetry }),
    });
    completed = true;
    response.addTrailers({ "X-Spiral-Runner-Status": "ok" });
    response.end();
  } catch (error) {
    completed = true;
    response.addTrailers({
      "X-Spiral-Runner-Status": "error",
      "X-Spiral-Runner-Error": Buffer.from(safeMessage(error))
        .toString("base64url")
        .slice(0, 2_000),
    });
    response.end();
  } finally {
    active.delete(runId);
  }
}

async function handleEvolutionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RunnerServiceConfig,
): Promise<void> {
  const input = bindRunnerOwnedEvolutionRequest(
    await readJson(request),
    config.evolutionTurnTimeoutMs,
  );
  const value = objectValue(input, "Evolution request");
  if (value.operation === "turn") {
    const workspace = absolutePath(value.workspace, "workspace");
    if (!insideRoot(config.evolutionRoot, workspace)) {
      throw new Error(
        "Evolution request workspace is outside the configured shared volume",
      );
    }
  }
  const abort = new AbortController();
  let completed = false;
  response.on("close", () => {
    if (!completed) abort.abort("spiral-core disconnected");
  });
  const result = await executeEvolutionRuntimeRequest(input, {
    signal: abort.signal,
  });
  completed = true;
  writeJson(response, 200, result);
}

async function handleScenarioTurnRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RunnerServiceConfig,
): Promise<void> {
  const input = await readJson(request);
  const evaluatorRequest = buildScenarioEvolutionRequest(
    input,
    config.evolutionRoot,
    config.evolutionTurnTimeoutMs,
  );
  fs.mkdirSync(evaluatorRequest.workspace, { recursive: true, mode: 0o700 });

  const abort = new AbortController();
  let completed = false;
  response.on("close", () => {
    if (!completed) abort.abort("spiral-app disconnected");
  });
  const result = await executeEvolutionRuntimeRequest(evaluatorRequest, {
    signal: abort.signal,
  });
  completed = true;
  writeJson(response, 200, scenarioResponse(result));
}

/**
 * Converts the internal Scenario contract into the existing restricted
 * XiaoBaOS role-turn protocol. The caller never controls a filesystem path and
 * can select only the two roles required by Scenario Explore.
 */
export function buildScenarioEvolutionRequest(
  input: unknown,
  evolutionRoot: string,
  maxTurnTimeoutMs = DEFAULT_EVOLUTION_TURN_TIMEOUT_MS,
): Extract<XiaobaEvolutionWorkerRequestV1, { operation: "turn" }> {
  const value = objectValue(input, "Scenario evaluator request");
  if (value.schema !== "barena.xiaoba_scenario_request.v1") {
    throw new Error("schema must be barena.xiaoba_scenario_request.v1");
  }
  const requestId = safeIdentifier(value.request_id, "request_id");
  const projectId = boundedIdentifier(value.project_id, "project_id");
  const scenarioId = boundedIdentifier(value.scenario_id, "scenario_id");
  const sourceRunId = boundedIdentifier(value.run_id, "run_id");
  const threadId = boundedIdentifier(value.thread_id, "thread_id");
  const role = boundedIdentifier(value.role, "role");
  if (!SCENARIO_ROLES.has(role as "user-cat" | "reviewer-cat")) {
    throw new Error("role must be user-cat or reviewer-cat");
  }
  const prompt = boundedText(value.prompt, "prompt", 1_000_000);
  const timeoutMs = Math.min(
    boundedInteger(value.timeout_ms, "timeout_ms", 1, 900_000),
    boundedInteger(maxTurnTimeoutMs, "maxTurnTimeoutMs", 1_000, 900_000),
  );
  const root = path.resolve(evolutionRoot);
  const workspace = path.join(
    root,
    "scenario",
    digestId(projectId),
    digestId(sourceRunId),
    role,
    requestId,
  );
  if (!insideRoot(root, workspace)) {
    throw new Error("derived Scenario workspace is outside the evolution root");
  }
  return {
    schema: "barena.xiaoba_evolution_request.v1",
    request_id: requestId,
    operation: "turn",
    run_id: `scenario-${digestId(sourceRunId)}`,
    role: role as "user-cat" | "reviewer-cat",
    prompt,
    workspace,
    timeout_ms: timeoutMs,
    ...(value.telemetry !== undefined && {
      telemetry: scenarioTelemetry(value.telemetry, {
        projectId,
        scenarioId,
        sourceRunId,
        threadId,
        role,
      }),
    }),
    runtime: evolutionRuntimeConfig(),
  };
}

function scenarioResponse(result: XiaobaEvolutionWorkerResponseV1): unknown {
  if (result.status === "ok" && result.operation === "turn") {
    return {
      schema: "barena.xiaoba_scenario_response.v1",
      request_id: result.request_id,
      status: "ok",
      result: result.result,
    };
  }
  return {
    schema: "barena.xiaoba_scenario_response.v1",
    request_id: result.request_id,
    status: "error",
    error:
      result.status === "error"
        ? result.error
        : {
            code: "runtime_error",
            detail: "XiaoBaOS returned an unexpected evaluator response.",
          },
  };
}

function scenarioTelemetry(
  value: unknown,
  identity: {
    projectId: string;
    scenarioId: string;
    sourceRunId: string;
    threadId: string;
    role: string;
  },
): RuntimeTelemetryConfig {
  const telemetry = objectValue(value, "telemetry");
  const endpoint = boundedText(
    telemetry.traces_endpoint,
    "telemetry.traces_endpoint",
    2_048,
  );
  const headers = optionalStringRecord(
    telemetry.headers,
    "telemetry.headers",
    16,
  );
  return {
    traces_endpoint: endpoint,
    protocol:
      telemetry.protocol === "http/json" ? "http/json" : "http/protobuf",
    service_name: `spiral-scenario-${identity.role}`,
    ...(headers && { headers }),
    resource_attributes: {
      "spiral.project.id": identity.projectId,
      "barena.scenario.id": identity.scenarioId,
      "barena.run.id": identity.sourceRunId,
      "langwatch.thread.id": identity.threadId,
      "barena.evaluator.role": identity.role,
    },
    export_timeout_ms: 10_000,
  };
}

function digestId(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function serviceConfig(
  options: SpiralRunnerServiceOptions,
): RunnerServiceConfig {
  const address =
    options.address ?? process.env.SPIRAL_RUNNER_ADDR ?? DEFAULT_ADDR;
  const match = address.match(/^(.+):(\d{1,5})$/);
  if (!match) throw new Error("SPIRAL_RUNNER_ADDR must be host:port");
  const port = Number.parseInt(match[2]!, 10);
  if (port < 1 || port > 65_535) {
    throw new Error("SPIRAL_RUNNER_ADDR port is invalid");
  }
  return {
    host: match[1]!,
    port,
    runsRoot: path.resolve(
      options.runsRoot ??
        process.env.SPIRAL_RUNS_ROOT ??
        "/var/lib/spiral/runs",
    ),
    evolutionRoot: path.resolve(
      options.evolutionRoot ??
        process.env.SPIRAL_EVOLUTION_ROOT ??
        "/var/lib/spiral/evolution",
    ),
    evolutionTurnTimeoutMs: boundedInteger(
      options.evolutionTurnTimeoutMs ??
        environmentInteger(
          "SPIRAL_EVOLUTION_TURN_TIMEOUT_MS",
          DEFAULT_EVOLUTION_TURN_TIMEOUT_MS,
          1_000,
          900_000,
        ),
      "evolutionTurnTimeoutMs",
      1_000,
      900_000,
    ),
    mode: runnerMode(options.mode ?? process.env.CATENA_RUNNER_MODE),
  };
}

function runnerMode(value: string | undefined): "all" | "evolution" {
  const mode = value?.trim() || "all";
  if (mode !== "all" && mode !== "evolution") {
    throw new Error("CATENA_RUNNER_MODE must be all or evolution");
  }
  return mode;
}

function evolutionRuntimeConfig(): Record<string, unknown> {
  return {
    command: process.env.SPIRAL_XIAOBA_COMMAND ?? "xiaoba",
    ...(process.env.SPIRAL_XIAOBA_PROJECT_ROOT && {
      project_root: path.resolve(process.env.SPIRAL_XIAOBA_PROJECT_ROOT),
    }),
    ...(process.env.SPIRAL_XIAOBA_ROLES_ROOT && {
      roles_root: path.resolve(process.env.SPIRAL_XIAOBA_ROLES_ROOT),
    }),
    ...(process.env.SPIRAL_XIAOBA_SKILLS_ROOT && {
      skills_root: path.resolve(process.env.SPIRAL_XIAOBA_SKILLS_ROOT),
    }),
    env_allowlist: envList(process.env.SPIRAL_XIAOBA_ENV_ALLOWLIST),
    probe_timeout_ms: 7_500,
  };
}

/**
 * Replaces caller-supplied execution details with the Runner's trusted XiaoBaOS
 * installation and credential allowlist. Runtime identity fields remain
 * inspectable, but a Case can neither select an executable nor request an
 * arbitrary process environment variable from the cloud worker.
 */
export function bindRunnerOwnedEngineRequest(
  input: unknown,
  trustedRuntime: Record<string, unknown> = evolutionRuntimeConfig(),
): unknown {
  const engine = objectValue(input, "Engine request");
  const runtime =
    engine.runtime === undefined
      ? {}
      : objectValue(engine.runtime, "Engine request runtime");
  return {
    ...engine,
    runtime: {
      ...runtime,
      xiaoba: trustedRuntime,
    },
  };
}

/**
 * The execution plane, not an HTTP caller, owns the XiaoBaOS executable,
 * credential allowlist, and hard turn deadline. This keeps a compromised
 * control-plane request from selecting an arbitrary process or pinning a
 * Runner indefinitely.
 */
export function bindRunnerOwnedEvolutionRequest(
  input: unknown,
  maxTurnTimeoutMs = DEFAULT_EVOLUTION_TURN_TIMEOUT_MS,
  trustedRuntime: Record<string, unknown> = evolutionRuntimeConfig(),
): unknown {
  const value = objectValue(input, "Evolution request");
  const callerRuntime = value.runtime === undefined
    ? {}
    : objectValue(value.runtime, "Evolution request runtime");
  const ownerModel = value.operation === "turn"
    ? ownerModelEnvironment(callerRuntime.env_overrides)
    : undefined;
  const timeoutCeiling = boundedInteger(
    maxTurnTimeoutMs,
    "maxTurnTimeoutMs",
    1_000,
    900_000,
  );
  return {
    ...value,
    ...(value.operation === "turn" && {
      timeout_ms: Math.min(
        boundedInteger(value.timeout_ms, "timeout_ms", 1, 900_000),
        timeoutCeiling,
      ),
    }),
    runtime: {
      ...trustedRuntime,
      ...(ownerModel && { env_overrides: ownerModel }),
    },
  };
}

function ownerModelEnvironment(value: unknown): Record<string, string> {
  const record = objectValue(value, "runtime.env_overrides");
  const entries = Object.entries(record);
  if (entries.length !== OWNER_MODEL_ENV_NAMES.size) {
    throw new Error("runtime.env_overrides must contain the complete owner model configuration");
  }
  const result: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    if (!OWNER_MODEL_ENV_NAMES.has(name)) {
      throw new Error("runtime.env_overrides contains a variable that is not allowed");
    }
    result[name] = boundedText(rawValue, `runtime.env_overrides.${name}`, 16_384);
  }
  for (const name of OWNER_MODEL_ENV_NAMES) {
    if (!result[name]) {
      throw new Error("runtime.env_overrides is missing an owner model variable");
    }
  }
  return result;
}

function platformTelemetryConfig(): PlatformTelemetryConfig | undefined {
  const baseUrl = process.env.BARENA_PLATFORM_INTERNAL_URL?.trim();
  const secret = process.env.BARENA_GATEWAY_SECRET?.trim();
  return baseUrl && secret ? { baseUrl, secret } : undefined;
}

function environmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  return boundedInteger(Number(raw), name, minimum, maximum);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += value.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request body is too large");
    chunks.push(value);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!source) throw new Error("request body is empty");
  return JSON.parse(source) as unknown;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  return boundedText(value, label, 512);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function optionalStringRecord(
  value: unknown,
  label: string,
  maxEntries: number,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, label);
  const entries = Object.entries(record);
  if (entries.length > maxEntries) {
    throw new Error(`${label} exceeds ${maxEntries} entries`);
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      throw new Error(`${label} contains an invalid key`);
    }
    result[key] = boundedText(rawValue, `${label}.${key}`, 4_096);
  }
  return result;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function envList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function writeLine(response: ServerResponse, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    response.once("error", onError);
    if (response.write(`${line}\n`)) {
      response.off("error", onError);
      resolve();
      return;
    }
    response.once("drain", () => {
      response.off("error", onError);
      resolve();
    });
  });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

if (require.main === module) {
  void startSpiralRunnerService()
    .then((server) => {
      const stop = () => server.close(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((error) => {
      process.stderr.write(`${safeMessage(error)}\n`);
      process.exitCode = 1;
    });
}
