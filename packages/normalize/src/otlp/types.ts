// OTLP/JSON shapes (protobuf payloads are decoded into the same shape by the
// server). Ids are lowercase hex; timestamps are unix nanos as strings.

export type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};

export type KeyValue = { key: string; value?: AnyValue };

export type Resource = { attributes?: KeyValue[] };
export type Scope = { name?: string; version?: string };

export type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  events?: { timeUnixNano?: string | number; name?: string; attributes?: KeyValue[] }[];
  status?: { code?: number | string; message?: string };
};

export type ExportTraceServiceRequest = {
  resourceSpans?: { resource?: Resource; scopeSpans?: { scope?: Scope; spans?: OtlpSpan[] }[] }[];
};

export type OtlpLogRecord = {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number | string;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
  spanId?: string;
  eventName?: string;
};

export type ExportLogsServiceRequest = {
  resourceLogs?: { resource?: Resource; scopeLogs?: { scope?: Scope; logRecords?: OtlpLogRecord[] }[] }[];
};

export type Attributes = Record<string, unknown>;

export function anyValue(value: AnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(anyValue);
  if (value.kvlistValue) return attributes(value.kvlistValue.values);
  if (value.bytesValue !== undefined) return value.bytesValue;
  return undefined;
}

export function attributes(list: KeyValue[] | undefined): Attributes {
  const out: Attributes = {};
  for (const item of list ?? []) if (item?.key) out[item.key] = anyValue(item.value);
  return out;
}

/**
 * Rebuilds `prefix.{i}.rest` keys (OpenInference / OpenLLMetry flattening) into
 * an array of objects keyed by `rest`.
 */
export function indexedList(attrs: Attributes, prefix: string): Attributes[] {
  const items: Attributes[] = [];
  const head = `${prefix}.`;
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(head)) continue;
    const rest = key.slice(head.length);
    const dot = rest.indexOf(".");
    const index = Number(dot === -1 ? rest : rest.slice(0, dot));
    if (!Number.isInteger(index)) continue;
    const field = dot === -1 ? "" : rest.slice(dot + 1);
    items[index] ??= {};
    items[index]![field] = value;
  }
  return items.filter(Boolean);
}
