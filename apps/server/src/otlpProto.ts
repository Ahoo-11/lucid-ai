// Decodes OTLP protobuf request bodies into the OTLP/JSON shape the
// normalizers read. Only the messages we consume are declared; field numbers
// follow opentelemetry-proto (common, resource, trace, logs v1).

import protobuf from "protobufjs";

const PROTO = `
syntax = "proto3";
package otlp;

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
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
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
  message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
  message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
}
message Status { string message = 2; int32 code = 3; }

message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  fixed64 observed_time_unix_nano = 11;
  string event_name = 12;
}
`;

const root = protobuf.parse(PROTO, { keepCase: false }).root;
const TraceRequest = root.lookupType("otlp.ExportTraceServiceRequest");
const LogsRequest = root.lookupType("otlp.ExportLogsServiceRequest");

const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);

// OTLP/JSON writes ids as hex and bytes values as base64; protobufjs gives
// Buffers, so convert them the same way the JSON encoding would.
function toJsonShape(value: unknown, key = ""): unknown {
  if (value instanceof Uint8Array) {
    return ID_FIELDS.has(key) ? Buffer.from(value).toString("hex") : Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map((item) => toJsonShape(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonShape(v, k);
    return out;
  }
  return value;
}

// No `bytes` option: protobufjs then keeps the Buffer, which toJsonShape converts.
const CONVERSION = { longs: String, enums: Number, defaults: false, arrays: true };

export function decodeTraces(body: Uint8Array) {
  return toJsonShape(TraceRequest.toObject(TraceRequest.decode(body), CONVERSION));
}

export function decodeLogs(body: Uint8Array) {
  return toJsonShape(LogsRequest.toObject(LogsRequest.decode(body), CONVERSION));
}

/** Test helper: encodes an OTLP/JSON-shaped trace request as protobuf. */
export function encodeTraces(request: unknown) {
  return TraceRequest.encode(TraceRequest.fromObject(fromJsonShape(request) as Record<string, unknown>)).finish();
}

export function encodeLogs(request: unknown) {
  return LogsRequest.encode(LogsRequest.fromObject(fromJsonShape(request) as Record<string, unknown>)).finish();
}

function fromJsonShape(value: unknown, key = ""): unknown {
  if (typeof value === "string" && ID_FIELDS.has(key)) return Buffer.from(value, "hex");
  if (Array.isArray(value)) return value.map((item) => fromJsonShape(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromJsonShape(v, k);
    return out;
  }
  return value;
}
