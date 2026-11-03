import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/ee/arena/llm";
import { AUTO_PER_DAY, parseDiagnosis } from "../src/explain";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type Diagnosis = { status: string; title?: string; summary?: string | null; fix?: string; model?: string; error?: string; auto?: boolean; inputTokens?: number; outputTokens?: number; latencyMs?: number };
type Issue = { id: string; title: string; runs: number; toolName: string | null; diagnosis: Diagnosis | null; ignored: boolean };

/** The Inbox's own passes: grouping by cause, and rating what matters. */
const isGrouping = (request: ChatRequest) => /^You (sort an AI agent's problems|help the owner of AI agents decide)/.test(String(request.messages[0]?.content));

async function setup(diagnoser: ChatClient | undefined) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  // The passes that group by cause and rate importance find nothing here; the model sees only diagnoses.
  const chat: ChatClient | undefined = diagnoser && (async (request) => (isGrouping(request) ? { text: '{"groups": [], "ratings": []}', latencyMs: 1 } : diagnoser(request)));
  const ctx: AppContext = {
    db,
    live: new LiveHub(),
    localMode: true,
    defaultProjectId: projectId,
    log: { info() {}, warn() {}, error: console.error },
    chat,
    ai: chat ? { provider: "baseten", model: MUSE_SPARK, onlyModel: true } : undefined,
  };
  const app = createApp(ctx);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** The same tool failing the same way in each of these runs. */
  const fail = async (tool: string, error: string, prompts: string[]) => {
    for (const prompt of prompts) {
      await post("/v1/hooks/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: prompt, prompt: `Count the lines (${prompt})` });
      await post("/v1/hooks/claude-code", { hook_event_name: "PostToolUseFailure", session_id: "s1", prompt_id: prompt, tool_name: tool, tool_use_id: `t-${tool}-${prompt}`, error });
    }
  };
  // A recurring problem (two runs), and a one-off.
  await fail("Bash", "wc: command not found", ["p1", "p2"]);
  await fail("Read", "EACCES: permission denied", ["p3"]);
  type Inbox = { issues: Issue[]; diagnosisModel: string | null; autoDiagnose: boolean; grouping: boolean };
  /** The Inbox once new problems are grouped by cause: diagnoses wait for that. */
  const issues = async () => {
    for (;;) {
      const inbox = (await (await app.request("/api/issues")).json()) as Inbox;
      if (!inbox.grouping) return inbox;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const diagnose = (id: string) => post(`/api/issues/${id}/diagnose`, {});
  return { app, db, projectId, fail, issues, diagnose };
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

const REPLY = '```json\n{"title": "Unix command used on Windows.", "summary": "Your agent kept retrying a step that can never work here.", "why": "The agent ran wc, which Windows lacks.", "fix": "Add \\"Use PowerShell commands\\" to CLAUDE.md."}\n```';

describe("Inbox diagnoses by Muse Spark", () => {
  it("diagnoses a recurring problem by itself, once, from its evidence, and keeps what it cost", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatClient = async (request) => {
      asked.push(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: REPLY, inputTokens: 640, outputTokens: 120, latencyMs: 2300 };
    };
    const { issues, diagnose } = await setup(chat);

    // Opening the Inbox starts it; opening it again while it runs doesn't pay twice.
    const first = await issues();
    await issues();
    expect(first.diagnosisModel).toBe(MUSE_SPARK);
    const recurring = first.issues.find((i) => i.runs === 2)!;
    const oneOff = first.issues.find((i) => i.runs === 1)!;
    expect(recurring.diagnosis).toEqual({ status: "pending" });
    const later = await until(issues, (r) => r.issues.find((i) => i.id === recurring.id)?.diagnosis?.status === "ready");
    expect(later.issues.find((i) => i.id === recurring.id)!.diagnosis).toMatchObject({
      status: "ready",
      title: "Unix command used on Windows",
      summary: "Your agent kept retrying a step that can never work here.",
      why: "The agent ran wc, which Windows lacks.",
      fix: 'Add "Use PowerShell commands" to CLAUDE.md.',
      model: MUSE_SPARK,
      auto: true,
      inputTokens: 640,
      outputTokens: 120,
      latencyMs: 2300,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ model: MUSE_SPARK, json: true, reasoningEffort: "low" });
    const evidence = String(asked[0]!.messages[1]!.content);
    expect(evidence).toContain("wc: command not found");
    expect(evidence).toContain('tool "Bash"');
    expect(evidence).toContain("Failed 2 times across 2 runs");

    // A one-off waits for the button.
    expect(later.issues.find((i) => i.id === oneOff.id)!.diagnosis).toBeNull();

    // Once diagnosed, opening the Inbox never runs it again; Run again does, as a click.
    await issues();
    expect(asked).toHaveLength(1);
    expect(await (await diagnose(recurring.id)).json()).toEqual({ diagnosis: { status: "pending" } });
    await diagnose(recurring.id);
    const again = await until(issues, (r) => asked.length === 2 && r.issues.find((i) => i.id === recurring.id)?.diagnosis?.status === "ready");
    expect(again.issues.find((i) => i.id === recurring.id)!.diagnosis).toMatchObject({ auto: false });
    expect(asked).toHaveLength(2);
  });

  it("says when the model failed, doesn't retry by itself, and lets it be asked again", async () => {
    let fail = true;
    let calls = 0;
    const { issues, diagnose } = await setup(async () => {
      calls++;
      if (fail) throw new Error("429: rate limited");
      return { text: '{"title": "A", "why": "B", "fix": "C"}', latencyMs: 5 };
    });
    const issue = (await issues()).issues.find((i) => i.runs === 2)!;
    const failed = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "failed");
    const shown = failed.issues.find((i) => i.id === issue.id)!;
    expect(shown.diagnosis).toMatchObject({ status: "failed", error: "429: rate limited", auto: true });
    expect(shown.title).toBeTruthy(); // the rule-based text still shows
    await issues();
    expect(calls).toBe(1);

    fail = false;
    await diagnose(issue.id);
    const fixed = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "ready");
    expect(fixed.issues.find((i) => i.id === issue.id)!.diagnosis).toMatchObject({ status: "ready", title: "A", summary: null });
  });

  it("stops at the daily cap, counting only the last 24 hours", async () => {
    const asked: ChatRequest[] = [];
    const { db, projectId, fail, issues, diagnose } = await setup(async (request) => {
      asked.push(request);
      return { text: '{"title": "A", "why": "B", "fix": "C"}', latencyMs: 5 };
    });
    await fail("Grep", "regex parse error", ["p4", "p5"]);
    // One automatic diagnosis left today; older ones no longer count, and clicks never do.
    const old = new Date(Date.now() - 25 * 3600_000);
    await db.insert(schema.issueExplanations).values([
      ...Array.from({ length: AUTO_PER_DAY - 1 }, (_, i) => ({ projectId, issueId: `today-${i}`, model: MUSE_SPARK, status: "ready", auto: true })),
      ...Array.from({ length: AUTO_PER_DAY }, (_, i) => ({ projectId, issueId: `old-${i}`, model: MUSE_SPARK, status: "ready", auto: true, createdAt: old })),
      { projectId, issueId: "clicked", model: MUSE_SPARK, status: "ready", auto: false },
    ]);

    const first = await issues();
    const recurring = first.issues.filter((i) => i.runs === 2);
    expect(recurring).toHaveLength(2);
    expect(recurring.map((i) => i.diagnosis?.status ?? "none").sort()).toEqual(["none", "pending"]);
    const done = await until(issues, (r) => r.issues.some((i) => i.diagnosis?.status === "ready"));
    expect(asked).toHaveLength(1);
    // The cap is spent: the other one waits for a click, which still works.
    const waiting = done.issues.find((i) => i.runs === 2 && !i.diagnosis)!;
    await issues();
    expect(asked).toHaveLength(1);
    await diagnose(waiting.id);
    await until(async () => asked.length, (n) => n === 2);
    expect(asked).toHaveLength(2);
  });

  it("diagnoses nothing by itself with the switch off, or for an ignored problem", async () => {
    let calls = 0;
    const { app, fail, issues, diagnose } = await setup(async () => {
      calls++;
      return { text: '{"title": "A", "why": "B", "fix": "C"}', latencyMs: 5 };
    });
    const post = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    // Off: nothing starts, the Diagnose button still works, and the setting sticks.
    expect(await (await post("/api/settings/auto-diagnose/off")).json()).toEqual({ autoDiagnose: false });
    const off = await issues();
    expect(off).toMatchObject({ autoDiagnose: false });
    const recurring = off.issues.find((i) => i.runs === 2)!;
    expect(recurring.diagnosis).toBeNull();
    await diagnose(recurring.id);
    await until(async () => calls, (n) => n === 1);

    // Ignored: out of the badge's count and never diagnosed by itself, even with the switch back on.
    await fail("Grep", "regex parse error", ["p4", "p5"]);
    const grep = (await issues()).issues.find((i) => i.toolName === "Grep")!;
    expect((await post(`/api/issues/${grep.id}/ignore`)).status).toBe(200);
    await post("/api/settings/auto-diagnose/on");
    const on = await issues();
    expect(on.autoDiagnose).toBe(true);
    expect(on.issues.find((i) => i.id === grep.id)).toMatchObject({ ignored: true, diagnosis: null });
    expect(calls).toBe(1);

    // Restored, it's back and gets diagnosed.
    await post(`/api/issues/${grep.id}/restore`);
    expect((await issues()).issues.find((i) => i.id === grep.id)).toMatchObject({ ignored: false, diagnosis: { status: "pending" } });
    await until(async () => calls, (n) => n === 2);
    expect((await post("/api/issues/no-such-problem/ignore")).status).toBe(404);
  });

  it("refuses without a model key, for unknown problems, and for form posts", async () => {
    const off = await setup(undefined);
    const issue = (await off.issues()).issues.find((i) => i.runs === 2)!;
    expect((await off.issues()).diagnosisModel).toBeNull();
    expect((await off.diagnose(issue.id)).status).toBe(409);

    const on = await setup(async () => ({ text: "{}", latencyMs: 1 }));
    expect((await on.diagnose("no-such-problem")).status).toBe(404);
    const form = await on.app.request(`/api/issues/${issue.id}/diagnose`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
    expect(form.status).toBe(415);
  });

  it("reads the model's JSON even with fences or chatter around it", () => {
    expect(parseDiagnosis('Sure! {"title": "A", "why": "B", "fix": "C"} Hope that helps')).toEqual({ title: "A", summary: null, why: "B", fix: "C", lesson: null, manual: null });
    // The lesson the agent would get, and the settings change only the owner should make.
    expect(parseDiagnosis('{"title": "A", "why": "B", "fix": "C", "lesson": "In cron runs, never use execute_code.", "manual": ""}')).toMatchObject({
      lesson: "In cron runs, never use execute_code.",
      manual: null,
    });
    expect(parseDiagnosis('{"title": "A", "why": "", "fix": "C"}')).toBeNull();
    expect(parseDiagnosis("no json here")).toBeNull();
  });
});
