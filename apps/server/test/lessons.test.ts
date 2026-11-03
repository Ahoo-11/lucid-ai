import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type Lesson = { id: string; text: string; status: string; deliveredAt: string | null; failuresSince: number | null; runsSince: number | null };
type Issue = { id: string; harness: string; runs: number; lessonsApply: boolean; lesson: Lesson | null };

async function setup() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  // A Hermes cron turn whose execute_code call was blocked, at a given time.
  const blockedTurn = (turn: string, ts: number) =>
    call("POST", "/v1/hooks/hermes", {
      events: [
        { hook: "pre_llm_call", ts, session_id: `cron-${turn}`, turn_id: turn, user_message: "[IMPORTANT: You are running as a scheduled cron job] Check the repos" },
        { hook: "pre_tool_call", ts: ts + 1, session_id: `cron-${turn}`, turn_id: turn, tool_call_id: `${turn}:tool`, tool_name: "execute_code", args: '{"code": "print(1)"}' },
        { hook: "post_tool_call", ts: ts + 2, session_id: `cron-${turn}`, turn_id: turn, tool_call_id: `${turn}:tool`, tool_name: "execute_code", status: "blocked", error_message: "execute_code runs arbitrary local Python" },
        { hook: "post_llm_call", ts: ts + 3, session_id: `cron-${turn}`, turn_id: turn, assistant_response: "Couldn't run it." },
      ],
    });
  const issues = async () => (await call("GET", "/api/issues")).body.issues as Issue[];
  // What a passed fix test leaves behind (fixtest.test.ts runs real ones).
  const passTest = (issueId: string, lesson: string) =>
    db
      .insert(schema.fixTests)
      .values({ projectId, issueId, lesson, status: "passed" })
      .onConflictDoUpdate({ target: [schema.fixTests.projectId, schema.fixTests.issueId], set: { lesson, status: "passed" } });
  return { call, blockedTurn, issues, passTest };
}

describe("lessons: fix it, with the owner's approval", () => {
  it("goes to the agent's plugin once approved, and counts what happens since", async () => {
    const { call, blockedTurn, issues, passTest } = await setup();
    const past = Date.now() / 1000 - 3_600;
    await blockedTurn("t1", past);
    await blockedTurn("t2", past + 60);

    const issue = (await issues()).find((i) => i.runs === 2)!;
    expect(issue).toMatchObject({ harness: "hermes", lessonsApply: true, lesson: null });
    // Nothing reaches the agent before the owner approves.
    expect((await call("GET", "/v1/lessons?harness=hermes")).body).toEqual({ lessons: [] });

    // Nor before the fix passed a test of exactly these words.
    const untested = await call("POST", `/api/issues/${issue.id}/lesson`, { text: "When running as a cron job, never use execute_code." });
    expect(untested.status).toBe(409);
    expect(untested.body.error).toMatch(/Test this fix first/);
    await passTest(issue.id, "When running as a cron job, never use execute_code.");

    const applied = await call("POST", `/api/issues/${issue.id}/lesson`, { text: "  When running as a cron job,\n never use execute_code.  " });
    expect(applied.status).toBe(201);
    const lesson = applied.body.lesson as Lesson;
    expect(lesson).toMatchObject({ text: "When running as a cron job, never use execute_code.", status: "active", deliveredAt: null });
    expect((await issues()).find((i) => i.id === issue.id)!.lesson).toMatchObject({ status: "active", deliveredAt: null, failuresSince: null });

    // The plugin fetches it: only Hermes gets Hermes' lessons, and from now on it's in effect.
    expect((await call("GET", "/v1/lessons?harness=hermes")).body).toEqual({ lessons: [{ id: lesson.id, text: lesson.text }] });
    expect((await call("GET", "/v1/lessons?harness=claude-code")).body).toEqual({ lessons: [] });
    expect((await issues()).find((i) => i.id === issue.id)!.lesson).toMatchObject({ failuresSince: 0, runsSince: 0 });

    // It happens again after the fix: the card says so.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await blockedTurn("t3", Date.now() / 1000 + 5);
    expect((await issues()).find((i) => i.id === issue.id)!.lesson).toMatchObject({ failuresSince: 1, runsSince: 1 });

    // Off: out of the agent's turns. On again: picked up afresh.
    expect((await call("POST", `/api/lessons/${lesson.id}/off`, {})).body.lesson).toMatchObject({ status: "off" });
    expect((await call("GET", "/v1/lessons?harness=hermes")).body).toEqual({ lessons: [] });
    expect((await call("POST", `/api/lessons/${lesson.id}/on`, {})).body.lesson).toMatchObject({ status: "active", deliveredAt: null });

    // A new lesson for the same problem replaces the old one, once it passed its own test.
    expect((await call("POST", `/api/issues/${issue.id}/lesson`, { text: "Use only approved tools in cron runs." })).status).toBe(409);
    await passTest(issue.id, "Use only approved tools in cron runs.");
    const second =(await call("POST", `/api/issues/${issue.id}/lesson`, { text: "Use only approved tools in cron runs." })).body.lesson as Lesson;
    expect((await call("GET", "/v1/lessons?harness=hermes")).body).toEqual({ lessons: [{ id: second.id, text: "Use only approved tools in cron runs." }] });
  });

  it("refuses empty lessons, agents Lucid can't reach yet, and form posts", async () => {
    const { call, blockedTurn, issues } = await setup();
    await blockedTurn("t1", Date.now() / 1000 - 600);
    await blockedTurn("t2", Date.now() / 1000 - 300);
    for (const prompt of ["p1", "p2"]) {
      await call("POST", "/v1/hooks/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: prompt, prompt: "Count lines" });
      await call("POST", "/v1/hooks/claude-code", { hook_event_name: "PostToolUseFailure", session_id: "s1", prompt_id: prompt, tool_name: "Bash", tool_use_id: `b-${prompt}`, error: "wc: command not found" });
    }
    const all = await issues();
    const hermes = all.find((i) => i.harness === "hermes")!;
    const claude = all.find((i) => i.harness === "claude-code")!;
    expect(claude.lessonsApply).toBe(false);

    expect((await call("POST", `/api/issues/${hermes.id}/lesson`, { text: "   " })).status).toBe(400);
    expect((await call("POST", `/api/issues/${claude.id}/lesson`, { text: "Use PowerShell commands." })).status).toBe(409);
    expect((await call("POST", "/api/issues/no-such-problem/lesson", { text: "x" })).status).toBe(404);
    expect((await call("POST", "/api/lessons/no-such-lesson/off", {})).status).toBe(404);
    const { status } = await call("POST", `/api/issues/${hermes.id}/lesson`);
    expect(status).toBe(415);
  });
});
