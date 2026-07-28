import protobuf from "protobufjs";

const OTLP_TRACE_PROTO = `
syntax = "proto3";
package barena.otlp;

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;
}

message Event {
  fixed64 time_unix_nano = 1;
  string name = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  repeated KeyValue attributes = 4;
  uint32 dropped_attributes_count = 5;
  fixed32 flags = 6;
}

message Status {
  string message = 2;
  int32 code = 3;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}
`;

export interface DecodedOtlpEvent {
  name: string;
  time_unix_nano?: string;
  attributes: Record<string, unknown>;
}

export interface DecodedOtlpSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  trace_state?: string;
  name: string;
  kind: number;
  start_time_unix_nano?: string;
  end_time_unix_nano?: string;
  duration_ms?: number;
  status: { code: number; message?: string };
  resource_attributes: Record<string, unknown>;
  scope: {
    name?: string;
    version?: string;
    attributes: Record<string, unknown>;
  };
  attributes: Record<string, unknown>;
  events: DecodedOtlpEvent[];
}

type ProtoRecord = Record<string, unknown>;

const root = protobuf.parse(OTLP_TRACE_PROTO, { keepCase: true }).root;
const exportRequestType = root.lookupType("barena.otlp.ExportTraceServiceRequest");

export function decodeOtlpTraceRequest(buffer: Buffer): DecodedOtlpSpan[] {
  const decoded = exportRequestType.decode(buffer);
  const object = exportRequestType.toObject(decoded, {
    longs: String,
    bytes: String,
    enums: Number,
    defaults: false,
    arrays: true,
    objects: true,
    oneofs: true,
  }) as ProtoRecord;
  return flattenTraceRequest(object);
}

export function decodeOtlpTraceJson(value: unknown): DecodedOtlpSpan[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OTLP JSON request must be an object.");
  }
  return flattenTraceRequest(normalizeJsonKeys(value as ProtoRecord) as ProtoRecord);
}

function flattenTraceRequest(request: ProtoRecord): DecodedOtlpSpan[] {
  const output: DecodedOtlpSpan[] = [];
  for (const resourceSpans of records(request.resource_spans)) {
    const resource = record(resourceSpans.resource);
    const resourceAttributes = keyValues(resource.attributes);
    for (const scopeSpans of records(resourceSpans.scope_spans)) {
      const scope = record(scopeSpans.scope);
      const scopeValue = {
        ...(stringValue(scope.name) && { name: stringValue(scope.name) }),
        ...(stringValue(scope.version) && { version: stringValue(scope.version) }),
        attributes: keyValues(scope.attributes),
      };
      for (const span of records(scopeSpans.spans)) {
        const start = stringNumber(span.start_time_unix_nano);
        const end = stringNumber(span.end_time_unix_nano);
        output.push({
          trace_id: bytesHex(span.trace_id),
          span_id: bytesHex(span.span_id),
          ...(bytesHex(span.parent_span_id) && {
            parent_span_id: bytesHex(span.parent_span_id),
          }),
          ...(stringValue(span.trace_state) && {
            trace_state: stringValue(span.trace_state),
          }),
          name: stringValue(span.name) ?? "",
          kind: numberValue(span.kind),
          ...(start && { start_time_unix_nano: start }),
          ...(end && { end_time_unix_nano: end }),
          ...(durationMilliseconds(start, end) !== undefined && {
            duration_ms: durationMilliseconds(start, end),
          }),
          status: {
            code: numberValue(record(span.status).code),
            ...(stringValue(record(span.status).message) && {
              message: stringValue(record(span.status).message),
            }),
          },
          resource_attributes: resourceAttributes,
          scope: scopeValue,
          attributes: keyValues(span.attributes),
          events: records(span.events).map((event) => ({
            name: stringValue(event.name) ?? "",
            ...(stringNumber(event.time_unix_nano) && {
              time_unix_nano: stringNumber(event.time_unix_nano),
            }),
            attributes: keyValues(event.attributes),
          })),
        });
      }
    }
  }
  return output;
}

function keyValues(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of records(value)) {
    const key = stringValue(entry.key);
    if (!key) continue;
    result[key] = anyValue(record(entry.value));
  }
  return result;
}

function anyValue(value: ProtoRecord): unknown {
  if ("string_value" in value) return String(value.string_value ?? "");
  if ("bool_value" in value) return Boolean(value.bool_value);
  if ("int_value" in value) return stringNumber(value.int_value) ?? "0";
  if ("double_value" in value) return numberValue(value.double_value);
  if ("bytes_value" in value) return bytesHex(value.bytes_value);
  if ("array_value" in value) {
    return records(record(value.array_value).values).map((entry) => anyValue(entry));
  }
  if ("kvlist_value" in value) {
    return keyValues(record(value.kvlist_value).values);
  }
  return null;
}

function records(value: unknown): ProtoRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ProtoRecord =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];
}

function record(value: unknown): ProtoRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProtoRecord)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringNumber(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function bytesHex(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return value.toLowerCase();
  }
  return Buffer.from(value, "base64").toString("hex");
}

function durationMilliseconds(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  try {
    const delta = BigInt(end) - BigInt(start);
    return Number(delta) / 1_000_000;
  } catch {
    return undefined;
  }
}

function normalizeJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonKeys);
  if (!value || typeof value !== "object") return value;
  const output: ProtoRecord = {};
  for (const [key, item] of Object.entries(value as ProtoRecord)) {
    output[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] =
      normalizeJsonKeys(item);
  }
  return output;
}
