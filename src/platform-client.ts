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

export class BarenaPlatformClient {
  private readonly baseURL: URL;
  private readonly apiKey: string;
  private readonly requestFetch: typeof fetch;

  constructor(
    connection: BarenaPlatformConnection,
    dependencies: { fetch?: typeof fetch } = {},
  ) {
    this.baseURL = validatePlatformURL(connection.url);
    this.apiKey = validatePlatformApiKey(connection.apiKey);
    this.requestFetch = dependencies.fetch ?? fetch;
  }

  async createRun(input: {
    operation: EngineOperation;
    input: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  }): Promise<PlatformRun> {
    return this.request<PlatformRun>("v1/ingest/runs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async appendEvent(runId: string, event: EngineEventV1): Promise<void> {
    await this.request(`v1/ingest/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  async finishRun(
    runId: string,
    state: PlatformRunState,
    error?: string,
  ): Promise<PlatformRun> {
    return this.request<PlatformRun>(
      `v1/ingest/runs/${encodeURIComponent(runId)}/finish`,
      {
        method: "POST",
        body: JSON.stringify({
          state,
          ...(error && { error: safeError(error) }),
        }),
      },
    );
  }

  otlpForwardOptions(): OtlpForwardOptions {
    return {
      endpoint: this.otlpEndpoint().toString(),
      headers: { authorization: `Bearer ${this.apiKey}` },
      fetch: this.requestFetch,
    };
  }

  async exportOtlpJson(payload: unknown): Promise<void> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await this.requestFetch(this.otlpEndpoint(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
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
      response = await this.requestFetch(new URL(pathname, this.baseURL), {
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
      throw new Error(
        `Barena Platform returned ${response.status}: ${safeError(
          detail || text || response.statusText,
        )}`,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Barena Platform returned invalid JSON");
    }
  }

  private otlpEndpoint(): URL {
    return new URL("/api/otel/v1/traces", this.baseURL);
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

function validatePlatformURL(value: string): URL {
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
  if (!configuredPath) {
    parsed.pathname = "/api/barena/";
  } else if (configuredPath === "/api/barena") {
    parsed.pathname = "/api/barena/";
  } else {
    throw new Error(
      "Barena Platform URL must be an origin or end with /api/barena/",
    );
  }
  return parsed;
}

function validatePlatformApiKey(value: string): string {
  const apiKey = value.trim();
  const supportedPrefix = ["sk-lw-", "pat-lw-", "pkey_"].some((prefix) =>
    apiKey.startsWith(prefix)
  );
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

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}
