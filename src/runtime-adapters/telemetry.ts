import type { RuntimeTelemetryConfig } from "./types";

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function buildRuntimeEnv(input: {
  runtime_id: string;
  env_allowlist?: string[];
  overrides?: NodeJS.ProcessEnv;
  telemetry?: RuntimeTelemetryConfig;
  correlation?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const names = new Set<string>([...DEFAULT_ENV_ALLOWLIST, ...(input.env_allowlist ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, input.overrides ?? {});
  if (input.telemetry) {
    Object.assign(
      env,
      telemetryEnv(input.telemetry, input.runtime_id, input.correlation ?? {})
    );
  }
  return env;
}

export function telemetryEnv(
  config: RuntimeTelemetryConfig,
  runtimeId: string,
  correlation: Record<string, string>
): NodeJS.ProcessEnv {
  const protocol = config.protocol ?? "http/protobuf";
  const attributes: Record<string, string> = {
    "barena.runtime.id": runtimeId,
    ...correlation,
    ...(config.resource_attributes ?? {}),
  };
  const env: NodeJS.ProcessEnv = {
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_ENDPOINT: baseOtlpEndpoint(config.traces_endpoint),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: config.traces_endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: protocol,
    OTEL_SERVICE_NAME: config.service_name ?? `barena-${runtimeId}`,
    OTEL_RESOURCE_ATTRIBUTES: encodeResourceAttributes(attributes),
    XIAOBA_OBSERVABILITY_ENABLED: "1",
    XIAOBA_OBSERVABILITY_TRACES_EXPORTER: "otlp",
    XIAOBA_OBSERVABILITY_SERVICE_NAME: config.service_name ?? `barena-${runtimeId}`,
    XIAOBA_OBSERVABILITY_OTLP_TRACES_ENDPOINT: config.traces_endpoint,
    XIAOBA_OBSERVABILITY_LOG_PROMPTS: "0",
    XIAOBA_OBSERVABILITY_LOG_TOOL_ARGS: "0",
    XIAOBA_OBSERVABILITY_LOG_FILE_CONTENT: "0",
  };
  if (config.headers && Object.keys(config.headers).length > 0) {
    const headers = Object.entries(config.headers)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join(",");
    env.OTEL_EXPORTER_OTLP_HEADERS = headers;
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = headers;
  }
  if (config.traceparent) env.TRACEPARENT = config.traceparent;
  if (config.tracestate) env.TRACESTATE = config.tracestate;
  if (config.export_timeout_ms) {
    env.OTEL_EXPORTER_OTLP_TIMEOUT = String(config.export_timeout_ms);
    env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = String(config.export_timeout_ms);
  }
  return env;
}

export function baseOtlpEndpoint(tracesEndpoint: string): string {
  return tracesEndpoint.replace(/\/v1\/traces\/?$/, "");
}

function encodeResourceAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .filter(([key, value]) => Boolean(key) && value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(",");
}
