export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const num = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
};

/** OTLP timestamps are nanoseconds since epoch, as a string or number. */
export const fromUnixNano = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === "" || value === "0" || value === 0) return undefined;
  try {
    const ms = Number(BigInt(String(value)) / 1_000_000n);
    return ms > 0 ? new Date(ms) : undefined;
  } catch {
    return undefined;
  }
};

export const firstLine = (text: string | undefined, max = 120) => {
  if (!text) return undefined;
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Plain text from an Anthropic/OpenAI-style content value (string or block array). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isRecord(block)) return "";
      if (typeof block.text === "string") return block.text;
      if (block.type === "tool_result") return contentText(block.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};
