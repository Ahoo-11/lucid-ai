// The normalized model every source is mapped into. Words follow the UI:
// a Session holds Runs (one user request each), a Run holds Steps.
// OTel's trace/span vocabulary stays inside the normalizers.

export type Harness =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "cursor"
  | "opencode"
  | "openai-agents"
  | "langchain"
  | "vercel-ai"
  | "otel"
  | "proxy"
  | "sdk"
  | (string & {});

export type Source = "otlp" | "hook" | "transcript" | "proxy" | "sdk" | "import";

export type StepKind = "llm" | "tool" | "agent" | "handoff" | "guardrail" | "retrieval" | "decision" | "event" | "error";

export type Status = "running" | "ok" | "error";

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

export type SessionUpsert = {
  harness: Harness;
  externalId: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  userRef?: string;
  startedAt?: Date;
  lastEventAt?: Date;
  metadata?: Record<string, unknown>;
};

export type RunUpsert = {
  harness: Harness;
  externalId: string;
  sessionExternalId?: string;
  source: Source;
  name?: string;
  /** The user's request, verbatim. */
  input?: string;
  /** The agent's final answer. */
  output?: string;
  status?: Status;
  startedAt?: Date;
  endedAt?: Date;
  model?: string;
  systemPromptHash?: string;
  metadata?: Record<string, unknown>;
};

export type StepUpsert = {
  externalId: string;
  runExternalId: string;
  parentExternalId?: string;
  kind: StepKind;
  name: string;
  status?: Status;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: Usage;
  /** Cost the harness reported itself; otherwise the server prices `usage`. */
  reportedCostUsd?: number;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  /** Position within the run, for stable ordering when timestamps tie. */
  seq?: number;
  attrs?: StepAttrs;
};

/** Known optional attributes. Anything else a source provides goes in `extra`. */
export type StepAttrs = {
  /** Names of the tools the model could call on this LLM step. */
  availableTools?: string[];
  /** Blob key of the full tool definitions (JSON schemas) sent with this call, for replay. */
  toolsRef?: string;
  /** Reasoning the model showed before acting (thinking blocks, preamble text). */
  reasoning?: string;
  stopReason?: string;
  requestParams?: Record<string, unknown>;
  requestId?: string;
  permissionDecision?: string;
  isSidechain?: boolean;
  agentId?: string;
  extra?: Record<string, unknown>;
};

export type NormalizedBatch = {
  sessions: SessionUpsert[];
  runs: RunUpsert[];
  steps: StepUpsert[];
  /**
   * Payloads shared by many steps, stored once under a stable key, e.g. tool
   * definitions ("tools:<hash>") that every call of a session repeats.
   */
  blobs?: { key: string; content: unknown }[];
};

export const emptyBatch = (): NormalizedBatch => ({ sessions: [], runs: [], steps: [] });

export function mergeBatches(...batches: NormalizedBatch[]): NormalizedBatch {
  return {
    sessions: batches.flatMap((batch) => batch.sessions),
    runs: batches.flatMap((batch) => batch.runs),
    steps: batches.flatMap((batch) => batch.steps),
  };
}
