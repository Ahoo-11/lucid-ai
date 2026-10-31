import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type Status = "ok" | "error" | "running";
export type StepKind = "llm" | "tool" | "agent" | "handoff" | "guardrail" | "retrieval" | "decision" | "event" | "error";

export type RunListItem = {
  id: string;
  name: string | null;
  input: string | null;
  output: string | null;
  status: Status;
  harness: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  costIncomplete: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stepCount: number;
  llmCallCount: number;
  toolCallCount: number;
  errorCount: number;
  sessionId: string | null;
  sessionTitle: string | null;
  metadata: { systemTurn?: boolean } | null;
};

export type Step = {
  id: string;
  runId: string;
  externalId: string;
  parentExternalId: string | null;
  kind: StepKind;
  name: string;
  status: Status;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  toolName: string | null;
  inputHash: string | null;
  outputHash: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  error: string | null;
  attrs: {
    availableTools?: string[];
    reasoning?: string;
    stopReason?: string;
    requestParams?: Record<string, unknown>;
    permissionDecision?: string;
    agentId?: string;
    extra?: Record<string, unknown>;
  } | null;
};

export type Session = { id: string; title: string | null; harness: string; cwd: string | null; gitBranch: string | null };

export type RunDetail = {
  run: RunListItem & { input: string | null; output: string | null; systemPromptHash: string | null; reasoningTokens: number };
  session: Session | null;
  steps: Step[];
  sessionRuns: { id: string; name: string | null; startedAt: string | null; status: Status }[];
};

export type Overview = {
  last24h: { runs: number; errors: number; costUsd: number | null; avgDurationMs: number | null };
  harnesses: { harness: string; runs: number; lastAt: string | null }[];
  topTools: { tool: string; calls: number; errors: number; avgMs: number | null }[];
};

export type Issue = {
  id: string;
  kind: StepKind;
  toolName: string | null;
  signature: string;
  sample: string | null;
  occurrences: number;
  runs: number;
  lastSeen: string | null;
  firstSeen: string | null;
  examples: { runId: string; runName: string | null }[];
  /** Lucid's rule-based explanation, shown until (or unless) a model's diagnosis is ready. */
  title: string;
  why: string;
  fix: string;
  /** Written by a model (Muse Spark) from the failing steps, when someone asks; null until then. */
  diagnosis: Diagnosis | null;
  /** The agent it happened in (most recently): the one a lesson goes to. */
  harness: string;
  /** Whether Lucid can apply a lesson in that agent itself; otherwise it's one to copy. */
  lessonsApply: boolean;
  /** The lesson applied for this problem, with its results since it went live. */
  lesson: AppliedLesson | null;
};

export type Diagnosis =
  | { status: "pending" }
  | {
      status: "ready";
      title: string;
      why: string;
      fix: string;
      /** The instruction proposed for the agent; applied only on approval. */
      lesson: string | null;
      /** A settings change only the owner should make; Lucid never applies it. */
      manual: string | null;
      model: string;
      at: string;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number | null;
    }
  | { status: "failed"; error: string; model: string; at: string };

export type AppliedLesson = {
  id: string;
  text: string;
  harness: string;
  status: "active" | "off";
  createdAt: string;
  /** When the agent picked it up; null while waiting. */
  deliveredAt: string | null;
  failuresSince: number | null;
  runsSince: number | null;
};

export type ConnectStatus = {
  endpoint: string;
  localMode: boolean;
  runs: number;
  sources: { source: string; harness: string | null; events: number; lastAt: string | null }[];
  /** Providers the LLM proxy forwards to, including any the server added. */
  providers: string[];
};

export type ApiKey = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

/** An upload of past runs (Hermes backfill, `lucid import`): going, or just finished. */
export type HistorySync = { id: string; harness: string; total: number; done: number; finished: boolean; startedAt: string };

/** A computer asking to connect, from the one-command installer. "taken": another account approved it. */
export type DeviceLink =
  | { code: string; status: "taken" }
  | { code: string; status: "pending" | "approved" | "claimed" | "denied" | "expired"; machine: string; os: string | null; agents: string[]; expiresAt: string };

/** Prices are null for a model on prepaid credits (Muse Spark on Baseten). */
export type ArenaModel = { id: string; name: string; inputPerMillion: number | null; outputPerMillion: number | null; contextLength: number | null };
export type ToolCall = { id?: string; name: string; input?: unknown };
export type Output = { text?: string; toolCalls?: ToolCall[] };
export type DecisionContext = { request?: string; recent?: { role: string; text: string }[]; tools?: string[] };
export type Standing = { wins: number; losses: number; ties: number; games: number; winRate: number | null; rating: number | null };

export type Candidate = {
  id: string;
  label: string;
  kind?: "original" | "replay";
  model?: string | null;
  promptMode?: string | null;
  systemPrompt?: string | null;
  sameToolAsOriginal?: number | null;
  errors?: string[];
  trials: { done: number; failed: number; pending: number };
  avgCostUsd: number | null;
  avgLatencyMs: number | null;
  human?: Standing;
  judge?: Standing;
};

export type Experiment = {
  experiment: { id: string; name: string; judgeModel: string | null; rubric: string | null; revealed: boolean; createdAt: string };
  items: { id: string; runId: string; stepId: string; context: DecisionContext | null }[];
  progress: {
    replays: { done: number; pending: number; failed: number; total: number };
    humanVotes: number;
    judgeVotes: number;
    pairs: number;
    replaying: boolean;
    judging: boolean;
  };
  agreement: { compared: number; agreed: number };
  candidates: Candidate[];
};

export type ExperimentSummary = { id: string; name: string; createdAt: string; revealed: boolean; decisions: number; candidates: number; humanVotes: number; judgeVotes: number; pending: number };

export type BlindPair = {
  pair: { itemId: string; context: DecisionContext | null; a: { trialId: string; output: Output | null }; b: { trialId: string; output: Output | null } } | null;
  progress: { voted: number; total: number };
};

export type VariantInput = { model: string; systemPrompt?: string; promptMode?: "append" | "replace" };

// With Clerk, every call carries the session token. Clerk refreshes it
// (it lives about a minute), so it is fetched per request, not stored.
let tokenSource: (() => Promise<string | null>) | null = null;
export const setTokenSource = (source: typeof tokenSource) => {
  tokenSource = source;
};
const authHeaders = async (): Promise<Record<string, string>> => {
  const token = tokenSource ? await tokenSource() : null;
  return token ? { authorization: `Bearer ${token}` } : {};
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(await authHeaders()), ...init?.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export type AuthConfig = { mode: "local" | "hosted"; provider: "none" | "clerk" | "password"; publishableKey: string | null; signups: boolean };

export type Me =
  | { mode: "local" }
  | { mode: "hosted"; user: { email: string | null; name: string | null } | null; signups?: boolean; projectId?: string; closed?: boolean; error?: string };

const authCall = async (path: string, body?: unknown) => {
  const response = await fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(await authHeaders()) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok && path !== "/me") throw new Error(String(json.error ?? `Request failed (${response.status})`));
  return json;
};

export const api = {
  auth: {
    config: async () => {
      const response = await fetch("/api/auth/config");
      if (!response.ok) throw new Error(`Lucid did not answer (${response.status})`);
      return (await response.json()) as AuthConfig;
    },
    // /me answers 401/403 with a body when signed out or not let in; that's a state, not an error.
    me: () => authCall("/me") as Promise<Me>,
    login: (email: string, password: string) => authCall("/login", { email, password }),
    signup: (email: string, password: string, name: string) => authCall("/signup", { email, password, name }),
    logout: () => authCall("/logout", {}),
  },
  overview: () => request<Overview>("/overview"),
  runs: (params: URLSearchParams) => request<{ runs: RunListItem[]; nextBefore: string | null }>(`/runs?${params}`),
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  issues: () => request<{ issues: Issue[]; diagnosisModel?: string | null }>("/issues"),
  /** Asks the model to diagnose one problem; spends credits, so only on a click. */
  diagnose: (issueId: string) => request<{ diagnosis: Diagnosis }>(`/issues/${encodeURIComponent(issueId)}/diagnose`, { method: "POST", body: "{}" }),
  /** Approves a lesson (as written here) for the problem's agent, from its next turn. */
  applyLesson: (issueId: string, text: string) =>
    request<{ lesson: AppliedLesson }>(`/issues/${encodeURIComponent(issueId)}/lesson`, { method: "POST", body: JSON.stringify({ text }) }),
  setLesson: (lessonId: string, on: boolean) => request<{ lesson: AppliedLesson }>(`/lessons/${encodeURIComponent(lessonId)}/${on ? "on" : "off"}`, { method: "POST", body: "{}" }),
  connect: () => request<ConnectStatus>("/connect/status"),
  keys: () => request<{ keys: ApiKey[] }>("/keys"),
  createKey: (name: string) => request<ApiKey & { key: string }>("/keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeKey: (id: string) => request<{ ok: true }>(`/keys/${id}`, { method: "DELETE" }),
  links: {
    get: (code: string) => request<DeviceLink>(`/links/${encodeURIComponent(code)}`),
    decide: (code: string, decision: "approve" | "deny", historyDays = 0) =>
      request<{ ok: true }>(`/links/${encodeURIComponent(code)}/${decision}`, { method: "POST", body: JSON.stringify({ historyDays }) }),
  },
  syncs: () => request<{ syncs: HistorySync[] }>("/syncs"),
  arena: {
    models: () => request<{ configured: boolean; models: ArenaModel[]; suggestedJudge: string | null; provider?: string }>("/arena/models"),
    check: (stepId: string) => request<{ ok: true; messages: number; tools: number } | { ok: false; reason: string }>(`/arena/check?step=${stepId}`),
    list: () => request<{ experiments: ExperimentSummary[] }>("/arena/experiments"),
    create: (body: { stepIds: string[]; variants: VariantInput[]; judgeModel?: string; name?: string }) =>
      request<{ id: string; items: number; skipped: { stepId: string; reason: string }[] }>("/arena/experiments", { method: "POST", body: JSON.stringify(body) }),
    get: (id: string) => request<Experiment>(`/arena/experiments/${id}`),
    pair: (id: string) => request<BlindPair>(`/arena/experiments/${id}/pair`),
    vote: (id: string, body: { itemId: string; a: string; b: string; winner: "a" | "b" | "tie" }) =>
      request<BlindPair>(`/arena/experiments/${id}/votes`, { method: "POST", body: JSON.stringify(body) }),
    judge: (id: string, model?: string) => request<{ started: boolean; pairs?: number }>(`/arena/experiments/${id}/judge`, { method: "POST", body: JSON.stringify({ model }) }),
    reveal: (id: string) => request<Experiment>(`/arena/experiments/${id}/reveal`, { method: "POST" }),
    retry: (id: string) => request<{ ok: true }>(`/arena/experiments/${id}/retry`, { method: "POST" }),
  },
  blob: async (hash: string) => {
    const response = await fetch(`/api/blobs/${hash}`);
    if (!response.ok) throw new Error("Content not found");
    return response.text();
  },
};

/** Refetches everything on screen when new data arrives (debounced while a session is busy). */
export function useLiveUpdates() {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource("/api/live");
    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("runs", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries(), 400);
    });
    source.onerror = () => setConnected(false);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [queryClient]);
  return connected;
}
