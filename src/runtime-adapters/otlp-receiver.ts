import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { appendNdjson, ensureDir, writeJson } from "../utils/fs";
import {
  decodeOtlpTraceJson,
  decodeOtlpTraceRequest,
  type DecodedOtlpSpan,
} from "./otlp-decoder";

export interface OtlpInvocationContext {
  run_id: string;
  scenario_id: string;
  attempt_id: string;
  session_id: string;
  stage: "user_simulator" | "target" | "inspector" | "reviewer";
  actor: "user_simulator" | "target" | "inspector" | "reviewer";
  role: string;
  turn?: number;
}

export interface OtlpEnvelopeRecord {
  envelope_id: string;
  received_at: string;
  content_type: string;
  content_encoding?: string;
  bytes: number;
  sha256: string;
  raw_ref: string;
  decoded_span_count: number;
  decode_error?: string;
  invocation?: OtlpInvocationContext;
}

export interface OtlpSpanRecord extends DecodedOtlpSpan {
  envelope_id: string;
  invocation?: OtlpInvocationContext;
}

export interface OtlpReceiverManifest {
  schema: "barena.otlp_receiver_manifest.v1";
  endpoint: string;
  started_at: string;
  stopped_at?: string;
  envelope_count: number;
  span_count: number;
  trace_ids: string[];
  primary_trace_id?: string;
  forwarding?: {
    endpoint: string;
    status: "idle" | "pending" | "complete" | "failed";
    attempted_envelopes: number;
    forwarded_envelopes: number;
    failed_envelopes: number;
    last_error?: string;
  };
  envelopes: OtlpEnvelopeRecord[];
  manifest_ref: string;
  spans_ref: string;
}

export interface OtlpForwardOptions {
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
  timeout_ms?: number;
  fetch?: typeof globalThis.fetch;
}

export interface OtlpTraceReceiverOptions {
  run_root: string;
  secrets?: string[];
  max_request_bytes?: number;
  max_envelopes?: number;
  forward?: OtlpForwardOptions;
}

export class OtlpTraceReceiver {
  private readonly runRoot: string;
  private readonly envelopeRoot: string;
  private readonly manifestPath: string;
  private readonly spansPath: string;
  private readonly secrets: string[];
  private readonly maxRequestBytes: number;
  private readonly maxEnvelopes: number;
  private readonly forward?: {
    endpoint: URL;
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
    fetch: typeof globalThis.fetch;
  };
  private readonly envelopes: OtlpEnvelopeRecord[] = [];
  private readonly traceIds = new Set<string>();
  private readonly targetTraceIds = new Set<string>();
  private server?: http.Server;
  private endpointValue?: string;
  private context?: OtlpInvocationContext;
  private startedAt?: string;
  private stoppedAt?: string;
  private spanCount = 0;
  private forwardChain: Promise<void> = Promise.resolve();
  private forwardAttempted = 0;
  private forwardSucceeded = 0;
  private forwardFailed = 0;
  private forwardLastError?: string;

  constructor(options: OtlpTraceReceiverOptions) {
    this.runRoot = path.resolve(options.run_root);
    this.envelopeRoot = path.join(this.runRoot, "telemetry", "otlp", "envelopes");
    this.manifestPath = path.join(this.runRoot, "telemetry", "otlp", "manifest.json");
    this.spansPath = path.join(this.runRoot, "telemetry", "otlp", "spans.ndjson");
    this.secrets = (options.secrets ?? []).filter(Boolean);
    this.maxRequestBytes = options.max_request_bytes ?? 16 * 1024 * 1024;
    this.maxEnvelopes = options.max_envelopes ?? 2_000;
    if (options.forward) {
      this.forward = {
        endpoint: validateForwardEndpoint(options.forward.endpoint),
        headers: { ...(options.forward.headers ?? {}) },
        timeoutMs: options.forward.timeout_ms ?? 10_000,
        fetch: options.forward.fetch ?? globalThis.fetch,
      };
    }
  }

  get endpoint(): string {
    if (!this.endpointValue) throw new Error("OTLP receiver has not been started.");
    return this.endpointValue;
  }

  setContext(context: OtlpInvocationContext): void {
    this.context = { ...context };
  }

  async start(): Promise<string> {
    if (this.server) return this.endpoint;
    ensureDir(this.envelopeRoot);
    ensureDir(path.dirname(this.spansPath));
    this.startedAt = new Date().toISOString();
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server as http.Server;
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("OTLP receiver did not bind a loopback TCP port.");
    }
    this.endpointValue = `http://127.0.0.1:${address.port}/v1/traces`;
    this.writeManifest();
    return this.endpointValue;
  }

  async stop(): Promise<OtlpReceiverManifest> {
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await this.forwardChain;
    this.stoppedAt = new Date().toISOString();
    return this.writeManifest();
  }

  snapshot(): OtlpReceiverManifest {
    return this.writeManifest();
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/traces") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (this.envelopes.length >= this.maxEnvelopes) {
      response.statusCode = 429;
      response.end();
      return;
    }
    try {
      const body = await readBody(request, this.maxRequestBytes);
      this.acceptEnvelope(request, body);
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-protobuf");
      response.end(Buffer.alloc(0));
    } catch (error) {
      response.statusCode =
        error instanceof RequestTooLargeError ? 413 : 400;
      response.end();
    }
  }

  private acceptEnvelope(request: IncomingMessage, wireBody: Buffer): void {
    const contentEncoding = headerValue(request.headers["content-encoding"]);
    const decodedBody =
      contentEncoding?.toLowerCase() === "gzip" ? zlib.gunzipSync(wireBody) : wireBody;
    const redactedBody = redactBuffer(decodedBody, this.secrets);
    const envelopeId = `otlp-${String(this.envelopes.length + 1).padStart(4, "0")}`;
    const contentType =
      headerValue(request.headers["content-type"]) ?? "application/x-protobuf";
    const extension = contentType.includes("json") ? "json" : "pb";
    const rawPath = path.join(this.envelopeRoot, `${envelopeId}.${extension}`);
    fs.writeFileSync(rawPath, redactedBody);

    let spans: DecodedOtlpSpan[] = [];
    let decodeError: string | undefined;
    try {
      spans = contentType.includes("json")
        ? decodeOtlpTraceJson(JSON.parse(redactedBody.toString("utf8")) as unknown)
        : decodeOtlpTraceRequest(redactedBody);
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
    const spanRows: OtlpSpanRecord[] = spans.map((span) => ({
      ...span,
      envelope_id: envelopeId,
      ...(this.context && { invocation: { ...this.context } }),
    }));
    if (spanRows.length) appendNdjson(this.spansPath, spanRows);
    this.spanCount += spanRows.length;
    for (const span of spans) {
      if (!/^[a-f0-9]{32}$/.test(span.trace_id)) continue;
      this.traceIds.add(span.trace_id);
      if (this.context?.stage === "target") {
        this.targetTraceIds.add(span.trace_id);
      }
    }

    this.envelopes.push({
      envelope_id: envelopeId,
      received_at: new Date().toISOString(),
      content_type: contentType,
      ...(contentEncoding && { content_encoding: contentEncoding }),
      bytes: redactedBody.length,
      sha256: crypto.createHash("sha256").update(redactedBody).digest("hex"),
      raw_ref: rawPath,
      decoded_span_count: spans.length,
      ...(decodeError && { decode_error: decodeError }),
      ...(this.context && { invocation: { ...this.context } }),
    });
    this.queueForward(redactedBody, contentType);
    this.writeManifest();
  }

  private queueForward(body: Buffer, contentType: string): void {
    if (!this.forward) return;
    this.forwardAttempted += 1;
    const envelope = Buffer.from(body);
    this.forwardChain = this.forwardChain.then(async () => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), this.forward?.timeoutMs);
      try {
        const response = await this.forward!.fetch(this.forward!.endpoint, {
          method: "POST",
          headers: {
            ...this.forward!.headers,
            "content-type": contentType,
          },
          body: envelope,
          signal: abort.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Platform OTLP ingestion returned HTTP ${response.status}`);
        }
        await response.body?.cancel().catch(() => undefined);
        this.forwardSucceeded += 1;
      } catch (error) {
        this.forwardFailed += 1;
        this.forwardLastError = safeForwardError(error);
      } finally {
        clearTimeout(timeout);
        this.writeManifest();
      }
    });
  }

  private writeManifest(): OtlpReceiverManifest {
    const manifest: OtlpReceiverManifest = {
      schema: "barena.otlp_receiver_manifest.v1",
      endpoint: this.endpointValue ?? "not_started",
      started_at: this.startedAt ?? new Date().toISOString(),
      ...(this.stoppedAt && { stopped_at: this.stoppedAt }),
      envelope_count: this.envelopes.length,
      span_count: this.spanCount,
      trace_ids: [...this.traceIds].sort(),
      ...(this.primaryTraceId() && { primary_trace_id: this.primaryTraceId() }),
      ...(this.forward && {
        forwarding: {
          endpoint: this.forward.endpoint.toString(),
          status: this.forwardingStatus(),
          attempted_envelopes: this.forwardAttempted,
          forwarded_envelopes: this.forwardSucceeded,
          failed_envelopes: this.forwardFailed,
          ...(this.forwardLastError && { last_error: this.forwardLastError }),
        },
      }),
      envelopes: [...this.envelopes],
      manifest_ref: this.manifestPath,
      spans_ref: this.spansPath,
    };
    writeJson(this.manifestPath, manifest);
    return manifest;
  }

  private primaryTraceId(): string | undefined {
    return this.targetTraceIds.values().next().value ?? this.traceIds.values().next().value;
  }

  private forwardingStatus(): "idle" | "pending" | "complete" | "failed" {
    if (!this.forwardAttempted) return "idle";
    if (this.forwardFailed) return "failed";
    if (this.forwardSucceeded < this.forwardAttempted) return "pending";
    return "complete";
  }
}

class RequestTooLargeError extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RequestTooLargeError());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function redactBuffer(value: Buffer, secrets: string[]): Buffer {
  const output = Buffer.from(value);
  for (const secret of secrets) {
    const needle = Buffer.from(secret, "utf8");
    if (!needle.length) continue;
    let offset = output.indexOf(needle);
    while (offset >= 0) {
      output.fill(0x2a, offset, offset + needle.length);
      offset = output.indexOf(needle, offset + needle.length);
    }
  }
  return output;
}

function validateForwardEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("OTLP forwarding endpoint must be an absolute URL.");
  }
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "::1";
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "OTLP forwarding endpoint must use HTTPS, except for loopback HTTP, and contain no credentials, query, or fragment."
    );
  }
  return endpoint;
}

function safeForwardError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
