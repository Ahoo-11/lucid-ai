import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/arena/llm";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

const T0 = 1_793_200_000;
const TURN = "s1:task:1";
const TOOLS = [
  { type: "function", function: { name: "search_files", description: "Find files", parameters: { type: "object", properties: { pattern: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];

// Fake models: "good/model" reads the file, "lazy/model" guesses. The judge
// prefers reading. Requests are recorded to check what each replay was sent.
const sent: ChatRequest[] = [];
const fake: ChatClient = async (request) => {
  sent.push(request);
  if (request.model === "judge/model") {
    const prompt = String(request.messages[1]!.content);
    const a = prompt.split("## Candidate A")[1]!.split("## Candidate B")[0]!;
    const b = prompt.split("## Candidate B")[1]!;
    const score = (text: string) => (text.includes("read_file") ? 2 : text.includes("search_files") ? 1 : 0);
    const winner = score(a) === score(b) ? "tie" : score(a) > score(b) ? "A" : "B";
    return { text: JSON.stringify({ winner, reason: "prefers reading" }), latencyMs: 5, costUsd: 0.0001 };
  }
  if (request.model === "good/model") return { toolCalls: [{ id: "x", name: "read_file", input: { path: "notes.txt" } }], latencyMs: 40, inputTokens: 900, outputTokens: 20, costUsd: 0.001 };
  return { text: "There are probably 3 files.", latencyMs: 20, inputTokens: 900, outputTokens: 10, costUsd: 0.0002 };
};

/** `null` = no model key configured. */
async function setup(chat: ChatClient | null = fake) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error }, chat: chat ?? undefined };
  const app = createApp(ctx);
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
    return { status: response.status, body: (await response.json()) as T };
  };
  // One real-shaped Hermes decision: system + user, with full tool schemas.
  await call("POST", "/v1/hooks/hermes", {
    events: [
      { hook: "pre_llm_call", ts: T0, session_id: "s1", turn_id: TURN, user_message: "How many files, and what does notes.txt say?" },
      {
        hook: "pre_api_request",
        ts: T0,
        session_id: "s1",
        turn_id: TURN,
        api_request_id: `${TURN}:api:1`,
        model: "deepseek/deepseek-v4-flash",
        started_at: T0,
        tool_names: ["search_files", "read_file"],
        tools_hash: "abc123",
        tools_def: TOOLS,
        request: { body: { messages: [{ role: "system", content: "You are Hermes." }, { role: "user", content: "How many files, and what does notes.txt say?" }], max_tokens: 2000 } },
      },
      {
        hook: "post_api_request",
        ts: T0 + 2,
        session_id: "s1",
        turn_id: TURN,
        api_request_id: `${TURN}:api:1`,
        started_at: T0,
        ended_at: T0 + 2,
        api_duration: 2,
        usage: { input_tokens: 900, output_tokens: 30 },
        response: { assistant_message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_files", arguments: '{"pattern":"*"}' } }] } },
      },
    ],
  });
  const { body: runs } = await call<{ runs: { id: string }[] }>("GET", "/api/runs");
  const { body: run } = await call<{ steps: { id: string; kind: string }[] }>("GET", `/api/runs/${runs.runs[0]!.id}`);
  const stepId = run.steps.find((s) => s.kind === "llm")!.id;
  return { call, stepId };
}

type Detail = {
  experiment: { revealed: boolean };
  progress: { replays: { done: number; pending: number; total: number }; humanVotes: number; judgeVotes: number; pairs: number; judging: boolean };
  agreement: { compared: number; agreed: number };
  candidates: { id: string; label: string; model?: string; kind?: string; human?: { winRate: number | null; games: number }; judge?: { winRate: number | null; games: number }; sameToolAsOriginal?: number | null }[];
};
type Pair = { pair: { itemId: string; a: { trialId: string; output: { text?: string; toolCalls?: { name: string }[] } }; b: { trialId: string; output: { text?: string; toolCalls?: { name: string }[] } } } | null; progress: { voted: number; total: number } };

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}

describe("Arena API", () => {
  it("replays a captured decision blind, takes votes, and reveals the winner", async () => {
    const { call, stepId } = await setup();
    expect((await call<{ ok: boolean; tools: number }>("GET", `/api/arena/check?step=${stepId}`)).body).toMatchObject({ ok: true, tools: 2 });

    const created = await call<{ id: string; items: number }>("POST", "/api/arena/experiments", {
      stepIds: [stepId],
      judgeModel: "judge/model",
      variants: [{ model: "good/model" }, { model: "lazy/model", systemPrompt: "Answer from memory.", promptMode: "append" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Replays get the exact captured request, plus each variant's prompt change.
    const detail = await waitFor(() => call<Detail>("GET", `/api/arena/experiments/${id}`), (r) => r.body.progress.replays.pending === 0);
    expect(detail.body.progress.replays).toMatchObject({ done: 3, total: 3 });
    const good = sent.find((r) => r.model === "good/model")!;
    expect(good.tools).toHaveLength(2);
    expect(good.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(sent.find((r) => r.model === "lazy/model")!.messages[0]!.content).toBe("You are Hermes.\n\nAnswer from memory.");

    // Blind: no candidate identity before the reveal.
    for (const candidate of detail.body.candidates) {
      expect(candidate.model).toBeUndefined();
      expect(candidate.kind).toBeUndefined();
      expect(candidate.label).toMatch(/^Candidate \d$/);
    }

    // A person votes on every pair, always preferring reading the file.
    let next = (await call<Pair>("GET", `/api/arena/experiments/${id}/pair`)).body;
    expect(JSON.stringify(next)).not.toMatch(/good\/model|lazy\/model|deepseek/);
    while (next.pair) {
      const { pair } = next;
      const score = (o: { text?: string; toolCalls?: { name: string }[] }) => (o.toolCalls?.some((c) => c.name === "read_file") ? 2 : o.toolCalls?.length ? 1 : 0);
      const winner = score(pair.a.output) === score(pair.b.output) ? "tie" : score(pair.a.output) > score(pair.b.output) ? "a" : "b";
      next = (await call<Pair>("POST", `/api/arena/experiments/${id}/votes`, { itemId: pair.itemId, a: pair.a.trialId, b: pair.b.trialId, winner })).body;
    }
    expect(next.progress).toEqual({ voted: 3, total: 3 });

    // The AI judge votes too, and agrees with the person.
    expect((await call<{ started: boolean; pairs: number }>("POST", `/api/arena/experiments/${id}/judge`, {})).body).toMatchObject({ started: true, pairs: 3 });
    const judged = await waitFor(() => call<Detail>("GET", `/api/arena/experiments/${id}`), (r) => r.body.progress.judgeVotes === 3 && !r.body.progress.judging);
    expect(judged.body.agreement).toEqual({ compared: 3, agreed: 3 });

    // Reveal: identities appear, and the file-reading model won.
    const revealed = (await call<Detail>("POST", `/api/arena/experiments/${id}/reveal`)).body;
    const byModel = Object.fromEntries(revealed.candidates.map((c) => [c.kind === "original" ? "original" : c.model, c]));
    expect(byModel["good/model"]!.human).toMatchObject({ winRate: 1, games: 2 });
    expect(byModel["lazy/model"]!.human).toMatchObject({ winRate: 0 });
    expect(byModel.original!.sameToolAsOriginal).toBe(1);
    expect(byModel["good/model"]!.sameToolAsOriginal).toBe(0);
  });

  it("explains why a decision can't be replayed, and needs a key", async () => {
    const { call, stepId } = await setup(null);
    expect((await call<{ error: string }>("POST", "/api/arena/experiments", { stepIds: [stepId], variants: [{ model: "x/y" }] })).body.error).toMatch(/OPENROUTER_API_KEY/);
    expect((await call<{ error: string }>("POST", "/api/arena/experiments", { stepIds: [], variants: [] })).status).toBe(400);
  });
});
