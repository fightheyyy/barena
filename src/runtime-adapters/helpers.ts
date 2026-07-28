import type {
  RuntimeCapabilities,
  RuntimeMessage,
  RuntimeProcessOutcome,
  RuntimeReasonCode,
  RuntimeTelemetryConfig,
  RuntimeTurnResult,
} from "./types";
import type { SupervisedProcessResult } from "./process-supervisor";

export function formatMessagesAsPrompt(messages: RuntimeMessage[]): string {
  return messages
    .map((message) => {
      const label = message.name ? `${message.role}:${message.name}` : message.role;
      return `<${label}>\n${message.content}\n</${label}>`;
    })
    .join("\n\n");
}

export function processOutcome(result: SupervisedProcessResult): RuntimeProcessOutcome {
  return {
    exit_code: result.exit_code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function processFailure(
  result: SupervisedProcessResult,
  capabilities: RuntimeCapabilities,
  telemetry: RuntimeTelemetryConfig | undefined,
  runtimeName: string
): RuntimeTurnResult | undefined {
  const base = {
    process: processOutcome(result),
    telemetry: {
      mode: capabilities.telemetry,
      configured: Boolean(telemetry),
      trace_context_propagated: Boolean(
        telemetry?.traceparent && capabilities.trace_context_propagation
      ),
    },
    native_trace_refs: [],
  } satisfies Pick<RuntimeTurnResult, "process" | "telemetry" | "native_trace_refs">;

  if (result.busy) {
    return failure("blocked", "session_busy", `${runtimeName} already has an active turn for this session.`, base);
  }
  if (result.spawn_error) {
    const reason: RuntimeReasonCode =
      result.spawn_error.code === "ENOENT" ? "binary_not_found" : "spawn_error";
    return failure("blocked", reason, `${runtimeName} process could not be started.`, base);
  }
  if (result.cancelled) {
    return failure("cancelled", "turn_cancelled", `${runtimeName} turn was cancelled.`, base);
  }
  if (result.timed_out) {
    return failure("blocked", "turn_timeout", `${runtimeName} exceeded the hard deadline.`, base);
  }
  if (result.output_limit_exceeded) {
    return failure(
      "blocked",
      "output_limit_exceeded",
      `${runtimeName} exceeded the captured output limit.`,
      base
    );
  }
  if (result.exit_code !== 0) {
    return failure(
      "failed",
      "process_failed",
      `${runtimeName} exited with code ${String(result.exit_code)}.`,
      base
    );
  }
  return undefined;
}

export function normalizedVersion(stdout: string, stderr: string): string | undefined {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

export function stripAnsi(value: string): string {
  return value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)?)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

export function redactText(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => (secret ? redacted.split(secret).join("[REDACTED]") : redacted),
    value
  );
}

function failure(
  status: RuntimeTurnResult["status"],
  reasonCode: RuntimeReasonCode,
  detail: string,
  base: Pick<RuntimeTurnResult, "process" | "telemetry" | "native_trace_refs">
): RuntimeTurnResult {
  return { status, reason_code: reasonCode, detail, ...base };
}
