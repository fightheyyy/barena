import crypto from "node:crypto";
import type { EngineEventV1, EngineOperation } from "./engine-protocol";
import type { OtlpForwardOptions } from "./runtime-adapters";

export interface BarenaPlatformConnection {
  url: string;
  apiKey: string;
}

export interface PlatformRun {
  run_id: string;
  request_id: string;
  origin: "edge";
  operation: EngineOperation;
  state: string;
}

export type PlatformRunState =
  "completed" | "interrupted" | "cancelled" | "failed";

export interface PlatformRunBundleV1 {
  schema: "barena.run_bundle.v1";
  run: {
    run_id: string;
    request_id?: string;
    operation: EngineOperation;
    state: PlatformRunState;
    input: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    error?: string;
    created_at: string;
    updated_at: string;
  };
  events: EngineEventV1[];
  terminal_fact_sha256: string;
}

export interface PlatformRunBundleSyncResult {
  transport: "run_bundle" | "legacy_lifecycle";
  remote_run_id: string;
  response?: Record<string, unknown>;
}

interface PlatformEndpoints {
  ingest: URL;
  otlp: URL;
}

export class BarenaPlatformClient {
  private readonly ingestBaseURL: URL;
  private readonly otlpURL: URL;
  private readonly apiKey: string;
  private readonly requestFetch: typeof fetch;

  constructor(
    connection: BarenaPlatformConnection,
    dependencies: { fetch?: typeof fetch } = {},
  ) {
    const endpoints = platformEndpoints(connection.url);
    this.ingestBaseURL = endpoints.ingest;
    this.otlpURL = endpoints.otlp;
    this.apiKey = validatePlatformApiKey(connection.apiKey);
    this.requestFetch = dependencies.fetch ?? fetch;
  }

  async createRun(input: {
    operation: EngineOperation;
    input: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  }): Promise<PlatformRun> {
    return this.request<PlatformRun>("runs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async appendEvent(runId: string, event: EngineEventV1): Promise<void> {
    await this.request(`runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  async finishRun(
    runId: string,
    state: PlatformRunState,
    options?: string | {
      error?: string;
      terminal_fact?: Record<string, unknown>;
    },
  ): Promise<PlatformRun> {
    const error = typeof options === "string" ? options : options?.error;
    const terminalFacts =
      typeof options === "string" ? undefined : options?.terminal_fact;
    const pathname = `runs/${encodeURIComponent(runId)}/finish`;
    const basePayload = {
      state,
      ...(error && { error: safeError(error) }),
    };
    try {
      return await this.request<PlatformRun>(pathname, {
        method: "POST",
        body: JSON.stringify({
          ...basePayload,
          ...(terminalFacts && { terminal_fact: terminalFacts }),
        }),
      });
    } catch (requestError) {
      // The standalone Go compatibility server predates terminal_fact and
      // rejects unknown JSON fields. Its terminal Event already carries the
      // same bounded facts, so retry only that explicit protocol mismatch.
      if (!terminalFacts || !isUnknownFinishFieldError(requestError)) {
        throw requestError;
      }
      return this.request<PlatformRun>(pathname, {
        method: "POST",
        body: JSON.stringify(basePayload),
      });
    }
  }

  async syncRunBundle(
    bundle: PlatformRunBundleV1,
    idempotencyKey: string,
  ): Promise<PlatformRunBundleSyncResult> {
    validateRunBundle(bundle);
    const key = validateIdempotencyKey(idempotencyKey);
    try {
      const response = await this.request<Record<string, unknown> | undefined>(
        "run-bundles",
        {
          method: "POST",
          headers: { "idempotency-key": key },
          body: JSON.stringify(bundle),
        },
      );
      return {
        transport: "run_bundle",
        remote_run_id: responseRunId(response) ?? bundle.run.run_id,
        response,
      };
    } catch (error) {
      if (!isUnsupportedRunBundleEndpoint(error)) throw error;
    }

    let remoteRun: PlatformRun | undefined;
    try {
      remoteRun = await this.createRun({
        operation: bundle.run.operation,
        input: bundle.run.input,
        ...(bundle.run.runtime && { runtime: bundle.run.runtime }),
      });
      for (const event of bundle.events) {
        await this.appendEvent(
          remoteRun.run_id,
          remapEventRunId(event, remoteRun.run_id),
        );
      }
      const terminalFacts = terminalEvent(bundle.events)?.payload;
      await this.finishRun(remoteRun.run_id, bundle.run.state, {
        ...(bundle.run.error && { error: bundle.run.error }),
        ...(terminalFacts && { terminal_fact: terminalFacts }),
      });
      return {
        transport: "legacy_lifecycle",
        remote_run_id: remoteRun.run_id,
      };
    } catch (error) {
      if (remoteRun) {
        await this.finishRun(remoteRun.run_id, "failed", safeError(error)).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  otlpForwardOptions(): OtlpForwardOptions {
    return {
      endpoint: this.otlpURL.toString(),
      headers: { authorization: `Bearer ${this.apiKey}` },
      fetch: this.requestFetch,
    };
  }

  async exportOtlpJson(payload: unknown): Promise<void> {
    await this.exportOtlpEnvelope(
      Buffer.from(JSON.stringify(payload), "utf8"),
      "application/json",
    );
  }

  async exportOtlpEnvelope(
    payload: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await this.requestFetch(this.otlpURL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": contentType,
        },
        body: Buffer.from(payload),
        signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Barena Platform returned ${response.status} for OTLP ingestion`);
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      throw new Error(`Barena Platform OTLP export failed: ${safeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T = unknown>(
    pathname: string,
    init: RequestInit,
  ): Promise<T> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    let response: Response;
    try {
      response = await this.requestFetch(new URL(pathname, this.ingestBaseURL), {
        ...init,
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(`Barena Platform request failed: ${safeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        const payload = JSON.parse(text) as {
          detail?: unknown;
          message?: unknown;
        };
        if (typeof payload.detail === "string") detail = payload.detail;
        if (!detail && typeof payload.message === "string") {
          detail = payload.message;
        }
      } catch {
        // The bounded response body below remains the diagnostic fallback.
      }
      throw new PlatformRequestError(
        response.status,
        safeError(detail || text || response.statusText),
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Barena Platform returned invalid JSON");
    }
  }
}

export function platformConnectionFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): BarenaPlatformConnection | undefined {
  const url = environment.BARENA_PLATFORM_URL?.trim() ?? "";
  const apiKey = environment.BARENA_PLATFORM_API_KEY?.trim() ?? "";
  if (!url && !apiKey) return undefined;
  if (!url || !apiKey) {
    throw new Error(
      "BARENA_PLATFORM_URL and BARENA_PLATFORM_API_KEY must be configured together",
    );
  }
  return { url, apiKey };
}

function platformEndpoints(value: string): PlatformEndpoints {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Barena Platform URL must be an absolute URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Barena Platform URL must not contain credentials, a query, or a fragment",
    );
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new Error(
      "Barena Platform URL must use HTTPS, except for a loopback HTTP server",
    );
  }
  const configuredPath = parsed.pathname.replace(/\/+$/, "");
  const origin = new URL(parsed.origin);
  if (!configuredPath) {
    return {
      ingest: new URL("/v1/ingest/", origin),
      otlp: new URL("/v1/otlp/v1/traces", origin),
    };
  }
  if (configuredPath === "/v1/ingest") {
    return {
      ingest: new URL("/v1/ingest/", origin),
      otlp: new URL("/v1/otlp/v1/traces", origin),
    };
  }
  if (
    configuredPath === "/api/barena" ||
    configuredPath === "/api/barena/v1/ingest"
  ) {
    return {
      ingest: new URL("/api/barena/v1/ingest/", origin),
      otlp: new URL("/api/otel/v1/traces", origin),
    };
  }
  throw new Error(
    "Barena Platform URL must be an origin or end with /v1/ingest/ or /api/barena/",
  );
}

function validatePlatformApiKey(value: string): string {
  const apiKey = value.trim();
  const supportedPrefix = [
    "catena_agent_",
    "barena_pat_",
    "sk-lw-",
    "pat-lw-",
    "pkey_",
  ].some((prefix) => apiKey.startsWith(prefix));
  if (
    !supportedPrefix ||
    apiKey.length < 16 ||
    apiKey.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(apiKey)
  ) {
    throw new Error("Barena Platform API key is invalid");
  }
  return apiKey;
}

class PlatformRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Barena Platform returned ${status}: ${detail}`);
    this.name = "PlatformRequestError";
  }
}

function isUnsupportedRunBundleEndpoint(error: unknown): boolean {
  return (
    error instanceof PlatformRequestError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

function isUnknownFinishFieldError(error: unknown): boolean {
  return (
    error instanceof PlatformRequestError &&
    error.status === 400 &&
    /unknown field|terminal_fact/i.test(error.detail)
  );
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 8 ||
    key.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new Error("Barena Platform idempotency key is invalid");
  }
  return key;
}

function validateRunBundle(bundle: PlatformRunBundleV1): void {
  if (bundle.schema !== "barena.run_bundle.v1") {
    throw new Error("Barena Run Bundle schema is invalid");
  }
  const terminal = terminalEvent(bundle.events);
  if (!terminal || terminal !== bundle.events.at(-1)) {
    throw new Error("Barena Run Bundle must end with one terminal Event");
  }
  if (terminal.run_id !== bundle.run.run_id) {
    throw new Error("Barena Run Bundle terminal Event belongs to another Run");
  }
  if (!/^[a-f0-9]{64}$/.test(bundle.terminal_fact_sha256)) {
    throw new Error("Barena Run Bundle terminal fact hash is invalid");
  }
  const terminalBytes = Buffer.from(JSON.stringify(terminal.payload), "utf8");
  if (terminalBytes.length > 12 * 1024) {
    throw new Error("Barena Run Bundle terminal facts exceed 12 KiB");
  }
  if (
    crypto.createHash("sha256").update(terminalBytes).digest("hex") !==
    bundle.terminal_fact_sha256
  ) {
    throw new Error("Barena Run Bundle terminal fact hash does not match");
  }
  if (Buffer.byteLength(JSON.stringify(bundle)) > 1024 * 1024) {
    throw new Error("Barena Run Bundle exceeds the 1 MiB upload limit");
  }
}

function terminalEvent(events: EngineEventV1[]): EngineEventV1 | undefined {
  return [...events].reverse().find((event) => event.kind === "terminal");
}

function remapEventRunId(
  event: EngineEventV1,
  runId: string,
): EngineEventV1 {
  return {
    ...event,
    run_id: runId,
    event_id: `${runId}.${event.sequence}`,
  };
}

function responseRunId(
  response: Record<string, unknown> | undefined,
): string | undefined {
  if (!response) return undefined;
  if (typeof response.run_id === "string") return response.run_id;
  if (
    response.run &&
    typeof response.run === "object" &&
    !Array.isArray(response.run) &&
    typeof (response.run as Record<string, unknown>).run_id === "string"
  ) {
    return (response.run as Record<string, string>).run_id;
  }
  return undefined;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}
