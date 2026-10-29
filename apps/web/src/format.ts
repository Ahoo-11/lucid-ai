export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export function cost(usd: number | null | undefined) {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0";
  // Cheap models cost fractions of a cent per run; "<$0.01" would hide the number people compare.
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number | null | undefined) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "—";
  const then = new Date(iso);
  const seconds = (Date.now() - then.getTime()) / 1000;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

const HARNESSES: Record<string, string> = {
  "claude-code": "Claude Code",
  hermes: "Hermes",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  "openai-agents": "OpenAI Agents",
  langchain: "LangChain",
  "vercel-ai": "Vercel AI SDK",
  crewai: "CrewAI",
  "pydantic-ai": "Pydantic AI",
  otel: "OpenTelemetry",
};

export const harnessLabel = (harness: string) => HARNESSES[harness] ?? harness;

/** MCP tools are named mcp__<server>__<tool>; split them so people can read them. */
export function mcpParts(name: string) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!.replace(/_/g, " "), tool: match[2]! } : null;
}

export function toolLabel(name: string) {
  const mcp = mcpParts(name);
  return mcp ? mcp.tool : name;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
