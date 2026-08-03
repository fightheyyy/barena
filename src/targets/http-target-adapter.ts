import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import type {
  AgentE2ECaseV1,
  AgentE2EReasonCode,
  BoundaryObservedFrom,
  BoundaryTraceEvent,
  RuntimeProbeResult,
  TargetAdapter,
  TargetInvocationRequest,
  TargetInvocationResult,
  WorkspaceChange,
} from "../e2e/types";
import { appendNdjson, ensureDir, writeJson } from "../utils/fs";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export type HttpTargetAdapterConfig = NonNullable<
  AgentE2ECaseV1["target"]["http"]
>;

/**
 * Replays the bounded, no-secret HTTP Agent contract produced by Platform
 * Scenario adoption. It intentionally supports neither arbitrary templates
 * nor credentials; unsupported Platform Agents must fail closed before this
 * adapter is constructed.
 */
export class HttpTargetAdapter implements TargetAdapter {
  readonly id = "platform-http";

  constructor(private readonly config: HttpTargetAdapterConfig) {}

  async probe(): Promise<RuntimeProbeResult> {
    const problem = validateConfig(this.config);
    if (problem) {
      return {
        component: "http-target",
        status: "blocked",
        reason_code: "config_invalid",
        detail: problem,
        command: "HTTP POST",
        capabilities: [],
      };
    }
    return {
      component: "http-target",
      status: "ready",
      detail:
        "The no-secret standard HTTP Agent contract is replayable with W3C Trace Context.",
      command: `POST ${redactedURL(this.config.url)}`,
      capabilities: [
        "standard_messages_body",
        "w3c_trace_context",
        "response_artifacts",
      ],
    };
  }

  async execute(
    request: TargetInvocationRequest
  ): Promise<TargetInvocationResult> {
    ensureDir(request.workspace);
    const problem = validateConfig(this.config);
    if (problem) {
      return this.failedInvocation(
        request,
        "blocked",
        "config_invalid",
        problem
      );
    }

    const startedAt = new Date();
    const startedMs = Date.now();
    const traceId =
      request.trace_id && /^[a-f0-9]{32}$/.test(request.trace_id)
        ? request.trace_id
        : crypto.randomBytes(16).toString("hex");
    const spanId = crypto.randomBytes(8).toString("hex");
    const traceparent = `00-${traceId}-${spanId}-01`;
    const sessionId = `${request.run_id}:${request.attempt_id}`;
    const events: BoundaryTraceEvent[] = [
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_input",
        kind: "user",
        message: request.prompt,
        data: {
          method: "POST",
          endpoint: redactedURL(this.config.url),
          trace_id: traceId,
          span_id: spanId,
        },
      }),
    ];
    const body = JSON.stringify({
      thread_id: sessionId,
      messages: [{ role: "user", content: request.prompt }],
    });
    const timeoutMs = Math.min(request.timeout_ms, this.config.timeout_ms);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let status: TargetInvocationResult["status"] = "failed";
    let reasonCode: AgentE2EReasonCode | undefined;
    let detail = "The HTTP Agent did not complete.";
    let payloadTexts: string[] = [];
    let workspaceChanges: WorkspaceChange[] = [];
    let observations: BoundaryObservedFrom[] = ["target_input"];
    let httpStatus: number | undefined;
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          traceparent,
        },
        body,
        signal: controller.signal,
      });
      httpStatus = response.status;
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
        status = "failed";
        reasonCode = "output_limit_exceeded";
        detail = `HTTP Agent response exceeded ${MAX_RESPONSE_BYTES} bytes.`;
      } else if (!response.ok) {
        status = "failed";
        reasonCode = "target_process_failed";
        detail = `HTTP Agent returned ${response.status} ${response.statusText}.`;
        events.push(
          boundaryEvent({
            runId: request.run_id,
            caseId: request.case_id,
            attemptId: request.attempt_id,
            component: this.id,
            observedFrom: "target_stderr",
            kind: "runtime_status",
            message: detail,
            data: { status_code: response.status },
          })
        );
        observations.push("target_stderr", "target_process");
      } else {
        const parsed = parseResponse(responseText, response.headers.get("content-type"));
        const output = extractOutput(parsed, this.config.output_path);
        const responseJSONPath = path.join(request.workspace, "response.json");
        const responseTextPath = path.join(request.workspace, "response.txt");
        writeJson(responseJSONPath, parsed);
        fs.writeFileSync(responseTextPath, `${output}\n`, "utf8");
        workspaceChanges = [responseJSONPath, responseTextPath].map((filePath) => ({
          path: path.relative(request.workspace, filePath),
          change: "created" as const,
          sha256_after: sha256File(filePath),
        }));
        payloadTexts = [output];
        status = "completed";
        detail = "HTTP Agent response was retained as response.json and response.txt.";
        events.push(
          boundaryEvent({
            runId: request.run_id,
            caseId: request.case_id,
            attemptId: request.attempt_id,
            component: this.id,
            observedFrom: "target_stdout",
            kind: "assistant",
            message: output,
            data: { status_code: response.status },
          }),
          ...workspaceChanges.map((change) =>
            boundaryEvent({
              runId: request.run_id,
              caseId: request.case_id,
              attemptId: request.attempt_id,
              component: this.id,
              observedFrom: "workspace",
              kind: "artifact",
              message: `${change.change}: ${change.path}`,
              data: { path: change.path, sha256: change.sha256_after },
            })
          )
        );
        observations.push("target_stdout", "target_process", "workspace");
      }
    } catch (error) {
      if (timedOut) {
        status = "blocked";
        reasonCode = "target_timeout";
        detail = `HTTP Agent did not respond within ${timeoutMs} ms.`;
      } else {
        status = "failed";
        reasonCode = "target_protocol_error";
        detail = `HTTP Agent request failed: ${safeError(error)}`;
      }
      events.push(
        boundaryEvent({
          runId: request.run_id,
          caseId: request.case_id,
          attemptId: request.attempt_id,
          component: this.id,
          observedFrom: "target_stderr",
          kind: "runtime_status",
          message: detail,
        })
      );
      observations.push("target_stderr", "target_process");
    } finally {
      clearTimeout(timeout);
    }

    events.push(
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_process",
        kind: "runtime_status",
        message: detail,
        data: { status, ...(httpStatus !== undefined && { status_code: httpStatus }) },
      })
    );
    writeBoundaryEvents(request.trace_path, events);
    const boundaryOTelPath = boundaryOTelRef(request.trace_path);
    appendNdjson(boundaryOTelPath, [
      {
        schema: "barena.boundary_otel_span.v1",
        trace_id: traceId,
        span_id: spanId,
        name: "barena.http_agent.replay",
        start_time: startedAt.toISOString(),
        end_time: new Date().toISOString(),
        status: status === "completed" ? "OK" : "ERROR",
        attributes: {
          "barena.run.id": request.run_id,
          "barena.case.id": request.case_id,
          "barena.attempt.id": request.attempt_id,
          "barena.provenance.layer": "adapter_boundary",
          "http.request.method": "POST",
          "server.address": new URL(this.config.url).hostname,
          ...(httpStatus !== undefined && { "http.response.status_code": httpStatus }),
        },
      },
    ]);

    return {
      status,
      ...(reasonCode && { reason_code: reasonCode }),
      detail,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - startedMs,
      transport: "http",
      payload_texts: payloadTexts,
      media_refs: [],
      session_id: sessionId,
      native_trace_available: false,
      native_trace_refs: [],
      boundary_trace_refs: [boundaryOTelPath],
      observation_coverage: [...new Set(observations)],
      trace_path: request.trace_path,
      events,
      workspace_changes: workspaceChanges,
    };
  }

  private failedInvocation(
    request: TargetInvocationRequest,
    status: "blocked" | "failed",
    reasonCode: AgentE2EReasonCode,
    detail: string
  ): TargetInvocationResult {
    const event = boundaryEvent({
      runId: request.run_id,
      caseId: request.case_id,
      attemptId: request.attempt_id,
      component: this.id,
      observedFrom: "target_process",
      kind: "runtime_status",
      message: detail,
    });
    writeBoundaryEvents(request.trace_path, [event]);
    return {
      status,
      reason_code: reasonCode,
      detail,
      exit_code: null,
      signal: null,
      duration_ms: 0,
      transport: "http",
      payload_texts: [],
      media_refs: [],
      native_trace_available: false,
      native_trace_refs: [],
      boundary_trace_refs: [],
      observation_coverage: ["target_process"],
      trace_path: request.trace_path,
      events: [event],
      workspace_changes: [],
    };
  }
}

function validateConfig(config: HttpTargetAdapterConfig): string | undefined {
  if (
    Object.keys(config).some(
      (key) => !["url", "method", "output_path", "timeout_ms"].includes(key)
    )
  ) {
    return "HTTP Replay configuration contains unsupported fields.";
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    return "HTTP Replay URL must be absolute.";
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return "HTTP Replay URL must be HTTP(S) without credentials, query, or fragment.";
  }
  if (config.method !== "POST") return "HTTP Replay supports POST only.";
  if (
    config.output_path !== undefined &&
    ![
      "$.response",
      "$.message",
      "$.content",
      "$.choices[0].message.content",
    ].includes(config.output_path)
  ) {
    return "HTTP Replay output path is unsupported.";
  }
  if (
    !Number.isInteger(config.timeout_ms) ||
    config.timeout_ms < 100 ||
    config.timeout_ms > 120_000
  ) {
    return "HTTP Replay timeout must be from 100 to 120000 ms.";
  }
  return undefined;
}

function parseResponse(value: string, contentType: string | null): unknown {
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error("HTTP Agent declared JSON but returned invalid JSON");
    }
  }
  return value;
}

function extractOutput(value: unknown, outputPath: HttpTargetAdapterConfig["output_path"]): string {
  if (!outputPath) return stringify(value);
  let current: unknown = value;
  const segments =
    outputPath === "$.choices[0].message.content"
      ? ["choices", 0, "message", "content"]
      : [outputPath.slice(2)];
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || current[segment] === undefined) return stringify(value);
      current = current[segment];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current)) return stringify(value);
      current = (current as Record<string, unknown>)[segment];
      if (current === undefined) return stringify(value);
    }
  }
  return stringify(current);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function boundaryOTelRef(tracePath: string): string {
  const directory = path.dirname(tracePath);
  const base = path.basename(tracePath, path.extname(tracePath));
  return path.join(directory, `${base}-otel.ndjson`);
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function redactedURL(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid-http-agent-url";
  }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/https?:\/\/[^\s]+/g, "[endpoint]").slice(0, 500);
}
