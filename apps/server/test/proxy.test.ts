import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUser } from "../src/auth";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import { createApiKey, ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

// A stand-in model provider that records what it receives.
const received: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
const TOOLS = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];

const provider = new Hono();
provider.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json()) as { stream?: boolean; messages: { role: string }[] };
  received.push({ path: c.req.path, headers: Object.fromEntries(c.req.raw.headers), body });
  const hasResult = body.messages.some((m) => m.role === "tool");
  if (body.stream) {
    const chunks = [
      { id: "gen-s", model: "test/model", choices: [{ delta: { content: "Sunny " } }] },
      { id: "gen-s", choices: [{ delta: { content: "all day." }, finish_reason: "stop" }] },
      { id: "gen-s", choices: [], usage: { prompt_tokens: 40, completion_tokens: 4 } },
    ];
    const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    return c.body(sse, 200, { "content-type": "text/event-stream" });
  }
  return c.json(
    hasResult
      ? { id: "gen-2", model: "test/model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Bring an umbrella." } }], usage: { prompt_tokens: 60, completion_tokens: 5 } }
      : {
          id: "gen-1",
          model: "test/model",
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }],
          usage: { prompt_tokens: 50, completion_tokens: 12 },
        },
  );
});
provider.post("/v1/messages", async (c) => {
  received.push({ path: c.req.path, headers: Object.fromEntries(c.req.raw.headers), body: await c.req.json() });
  const events = [
    { type: "message_start", message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Claude." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ];
  return c.body(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), 200, { "content-type": "text/event-stream" });
});
provider.get("/v1/models", (c) => c.json({ data: [{ id: "test/model" }] }));

let close = () => {};
beforeAll(async () => {
  const server = serve({ fetch: provider.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LUCID_PROXY_UPSTREAMS = JSON.stringify({ openai: origin, anthropic: origin, fake: origin });
  close = () => server.close();
});
afterAll(() => {
  close();
  delete process.env.LUCID_PROXY_UPSTREAMS;
});

async function setup(localMode: boolean) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const get = async <T>(path: string) => (await (await app.request(path)).json()) as T;
  return { app, db, projectId, get };
}

const waitFor = async <T>(read: () => Promise<T>, done: (v: T) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
};

type Run = { id: string; name: string; status: string; harness: string; llmCallCount: number; toolCallCount: number; output: string | null };

describe("LLM proxy", () => {
  it("forwards an agent's tool loop untouched and records it as one run", async () => {
    const { app, get } = await setup(true);
    received.length = 0;
    const call = (messages: unknown[]) =>
      app.request("/proxy/fake/v1/chat/completions", {
        method: "POST",
        // PowerShell and .NET clients send `expect` on every POST.
        headers: { "content-type": "application/json", authorization: "Bearer sk-provider-key", "x-lucid-agent": "trip-planner", expect: "100-continue" },
        body: JSON.stringify({ model: "test/model", messages, tools: TOOLS }),
      });
    const user = { role: "user", content: "Do I need an umbrella in Paris?" };
    const first = await call([user]);
    const firstBody = (await first.json()) as { id: string };
    expect(first.status).toBe(200);
    expect(firstBody.id).toBe("gen-1");
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] };
    await call([user, assistant, { role: "tool", tool_call_id: "call_1", content: '{"rain":0.9}' }]);

    // The provider got the agent's own key, and nothing of Lucid's.
    expect(received[0]!.headers.authorization).toBe("Bearer sk-provider-key");
    expect(Object.keys(received[0]!.headers).some((h) => h.startsWith("x-lucid"))).toBe(false);

    const { runs } = await waitFor(() => get<{ runs: Run[] }>("/api/runs"), (r) => r.runs[0]?.status === "ok");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ harness: "trip-planner", name: "Do I need an umbrella in Paris?", llmCallCount: 2, toolCallCount: 1, output: "Bring an umbrella." });

    // Every decision that went through the proxy can be replayed in the Arena.
    const detail = await get<{ steps: { id: string; kind: string; externalId: string; status: string }[] }>(`/api/runs/${runs[0]!.id}`);
    expect(detail.steps.find((s) => s.externalId === "call_1")).toMatchObject({ kind: "tool", status: "ok" });
    const decision = detail.steps.find((s) => s.externalId === "gen-1")!;
    expect(await get(`/api/arena/check?step=${decision.id}`)).toEqual({ ok: true, messages: 1, tools: 1 });
  });

  it("streams through unchanged, asks for usage, and records the assembled reply", async () => {
    const { app, get } = await setup(true);
    received.length = 0;
    const response = await app.request("/proxy/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-x", "x-lucid-session": "chat-7" },
      body: JSON.stringify({ model: "test/model", stream: true, messages: [{ role: "user", content: "Weather?" }] }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"content":"Sunny "');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(received[0]!.body.stream_options).toEqual({ include_usage: true });
    const { runs } = await waitFor(() => get<{ runs: Run[] }>("/api/runs"), (r) => r.runs.length > 0 && r.runs[0]!.status === "ok");
    expect(runs[0]).toMatchObject({ output: "Sunny all day.", harness: "proxy" });
  });

  it("needs a Lucid key outside local mode, in the URL or a header, and handles Anthropic streams", async () => {
    const { app, db } = await setup(false);
    // Hosted mode: an account, its own project, and a key for that project.
    const { projectId } = await createUser(db, { email: "dev@example.com", password: "a long enough password" });
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dev@example.com", password: "a long enough password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async <T>(path: string) => (await (await app.request(path, { headers: { cookie } })).json()) as T;
    const body = JSON.stringify({ model: "claude-test", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Hi" }] });
    const headers = { "content-type": "application/json", "x-api-key": "sk-ant-provider", "anthropic-version": "2023-06-01" };
    const denied = await app.request("/proxy/anthropic/v1/messages", { method: "POST", headers, body });
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { message: string } }).error.message).toMatch(/Lucid key/);

    const { key } = await createApiKey(db, projectId, "proxy");
    received.length = 0;
    const ok = await app.request(`/p/${key}/anthropic/v1/messages`, { method: "POST", headers, body });
    expect(await ok.text()).toContain("Hello from Claude.");
    expect(received[0]!.headers["x-api-key"]).toBe("sk-ant-provider");
    expect(received[0]!.headers["anthropic-version"]).toBe("2023-06-01");

    // Hosted mode: the dashboard API isn't behind the ingest key check.
    const { runs } = await waitFor(() => get<{ runs: Run[] }>("/api/runs"), (r) => r.runs.length > 0);
    expect(runs[0]).toMatchObject({ status: "ok", output: "Hello from Claude." });
    expect((await app.request("/runs")).status).not.toBe(401);
  });

  it("passes other endpoints through without recording, and explains unknown providers", async () => {
    const { app, get } = await setup(true);
    const models = await app.request("/proxy/fake/v1/models", { headers: { authorization: "Bearer sk-x" } });
    expect(await models.json()).toEqual({ data: [{ id: "test/model" }] });
    expect((await get<{ runs: Run[] }>("/api/runs")).runs).toHaveLength(0);
    const unknown = await app.request("/proxy/nope/v1/chat/completions", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
  });
});
