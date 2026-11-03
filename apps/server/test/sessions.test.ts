import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type Row = { id: string; sessionId: string | null; title: string | null; firstRequest: string | null; lastRequest: string | null; requests: number; failed: number; costUsd: number | null; inputTokens: number };
type View = { id: string; session: { title: string | null } | null; runs: { id: string; name: string; context: number }[] };

async function setup() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const get = async <T>(path: string) => (await (await app.request(path)).json()) as T;
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
  await db.insert(schema.sessions).values({ id: "chat", projectId, harness: "hermes", externalId: "chat", title: "Telegram chat" });
  const run = (id: string, minutes: number, fields: Partial<typeof schema.runs.$inferInsert> = {}) =>
    db.insert(schema.runs).values({ id, projectId, harness: "hermes", externalId: id, source: "hook", status: "ok", startedAt: at(minutes), name: id, costUsd: 0.01, inputTokens: 100, ...fields });
  await run("hello", 0, { sessionId: "chat" });
  await run("update the plugin", 10, { sessionId: "chat", status: "error", output: "could not reach the server" });
  await run("one-off", 5);
  // Each later call carries the chat so far.
  await db.insert(schema.steps).values([
    { id: "s1", projectId, runId: "hello", externalId: "s1", kind: "llm", name: "call", status: "ok", inputTokens: 5000 },
    { id: "s2", projectId, runId: "update the plugin", externalId: "s2", kind: "llm", name: "call", status: "ok", inputTokens: 2000, cacheReadTokens: 70_000 },
  ]);
  return { get };
}

describe("sessions", () => {
  it("lists a session's requests as one row, and a request without a session as its own", async () => {
    const { get } = await setup();
    const { sessions } = await get<{ sessions: Row[] }>("/api/sessions");
    expect(sessions.map((row) => row.id)).toEqual(["chat", "run:one-off"]);
    expect(sessions[0]).toMatchObject({ title: "Telegram chat", firstRequest: "hello", lastRequest: "update the plugin", requests: 2, failed: 1, costUsd: 0.02, inputTokens: 200 });
    expect(sessions[1]).toMatchObject({ sessionId: null, title: null, firstRequest: "one-off", requests: 1 });
  });

  it("matches a whole session when one request matches, and pages by its latest request", async () => {
    const { get } = await setup();
    expect((await get<{ sessions: Row[] }>("/api/sessions?q=could%20not%20reach")).sessions.map((row) => [row.id, row.requests])).toEqual([["chat", 2]]);
    expect((await get<{ sessions: Row[] }>("/api/sessions?status=error")).sessions.map((row) => row.id)).toEqual(["chat"]);
    const first = await get<{ sessions: Row[]; nextBefore: string | null }>("/api/sessions?limit=1");
    expect(first.nextBefore).toBe("2026-11-01T12:10:00.000Z");
    expect((await get<{ sessions: Row[] }>(`/api/sessions?limit=1&before=${first.nextBefore}`)).sessions.map((row) => row.id)).toEqual(["run:one-off"]);
  });

  it("opens a session oldest first with each request's biggest prompt, also from one of its runs", async () => {
    const { get } = await setup();
    const view = await get<View>("/api/sessions/chat");
    expect(view.session?.title).toBe("Telegram chat");
    expect(view.runs.map((run) => [run.name, run.context])).toEqual([
      ["hello", 5000],
      ["update the plugin", 72_000],
    ]);
    expect((await get<View>("/api/sessions/run:update%20the%20plugin")).id).toBe("chat");
    const solo = await get<View>("/api/sessions/run:one-off");
    expect([solo.id, solo.session, solo.runs.length]).toEqual(["run:one-off", null, 1]);
  });
});
