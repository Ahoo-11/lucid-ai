import {
  type ExportLogsServiceRequest,
  type ExportTraceServiceRequest,
  type HermesEvent,
  type HermesMessageRow,
  type HermesSessionRow,
  type ProxyExchange,
  normalizeProxyExchange,
  normalizeClaudeHook,
  normalizeHermesEvents,
  normalizeHermesHistory,
  normalizeOtlpLogs,
  normalizeOtlpTraces,
} from "@lucid/normalize";
import type { NormalizedBatch } from "@lucid/schema";

/**
 * The normalizer for a stored raw event, or null when the source needs state
 * kept outside the payload (transcripts carry per-file parser state, so they
 * are reprocessed by re-uploading the file instead).
 */
export function batchFor(source: string, harness: string | null, payload: unknown): NormalizedBatch | null {
  if (source === "otlp_traces") return normalizeOtlpTraces(payload as ExportTraceServiceRequest);
  if (source === "otlp_logs") return normalizeOtlpLogs(payload as ExportLogsServiceRequest);
  if (source === "hook" && harness === "claude-code") return normalizeClaudeHook(payload);
  if (source === "hook" && harness === "hermes") {
    // The Hermes plugin batches: { events: [{ hook, ts, ...kwargs }] }.
    return normalizeHermesEvents((payload as { events?: HermesEvent[] }).events ?? [payload as HermesEvent]);
  }
  if (source === "proxy") return normalizeProxyExchange(payload as ProxyExchange);
  if (source === "import" && harness === "hermes") {
    return normalizeHermesHistory(payload as { sessions: HermesSessionRow[]; messages: HermesMessageRow[] });
  }
  return null;
}
