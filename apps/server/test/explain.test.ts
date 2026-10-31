import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/ee/arena/llm";
import { parseDiagnosis } from "../src/explain";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type Diagnosis = { status: string; title?: string; fix?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number };
type Issue = { id: string; title: string; runs: number; diagnosis: Diagnosis | null };

async function setup(chat: ChatClient | undefined) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
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
  // The same tool failing the same way in two runs: a recurring problem.
  for (const prompt of ["p1", "p2"]) {
    await post("/v1/hooks/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: prompt, prompt: `Count the lines (${prompt})` });
    await post("/v1/hooks/claude-code", { hook_event_name: "PostToolUseFailure", session_id: "s1", prompt_id: prompt, tool_name: "Bash", tool_use_id: `t-${prompt}`, error: "wc: command not found" });
  }
  const issues = async () => (await (await app.request("/api/issues")).json()) as { issues: Issue[]; diagnosisModel: string | null };
  const diagnose = (id: string) => post(`/api/issues/${id}/diagnose`, {});
  return { app, issues, diagnose };
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

describe("Inbox diagnoses by Muse Spark", () => {
  it("runs only when asked, from the problem's evidence, and keeps what it cost", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatClient = async (request) => {
      asked.push(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        text: '```json\n{"title": "Unix command used on Windows.", "why": "The agent ran wc, which Windows lacks.", "fix": "Add \\"Use PowerShell commands\\" to CLAUDE.md."}\n```',
        inputTokens: 640,
        outputTokens: 120,
        latencyMs: 2300,
      };
    };
    const { issues, diagnose } = await setup(chat);

    // Opening the Inbox, again and again, never calls the model.
    const first = await issues();
    await issues();
    expect(first.diagnosisModel).toBe(MUSE_SPARK);
    const issue = first.issues.find((i) => i.runs === 2)!;
    expect(issue.diagnosis).toBeNull();
    expect(asked).toHaveLength(0);

    // Asking twice while it runs pays once.
    expect(await (await diagnose(issue.id)).json()).toEqual({ diagnosis: { status: "pending" } });
    await diagnose(issue.id);
    const later = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "ready");
    expect(later.issues.find((i) => i.id === issue.id)!.diagnosis).toMatchObject({
      status: "ready",
      title: "Unix command used on Windows",
      why: "The agent ran wc, which Windows lacks.",
      fix: 'Add "Use PowerShell commands" to CLAUDE.md.',
      model: MUSE_SPARK,
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

    // Run again replaces it; the Inbox still never starts one by itself.
    await issues();
    expect(asked).toHaveLength(1);
    await diagnose(issue.id);
    await until(async () => asked.length, (n) => n === 2);
    expect(asked).toHaveLength(2);
  });

  it("says when the model failed, and lets it be asked again", async () => {
    let fail = true;
    const { issues, diagnose } = await setup(async () => {
      if (fail) throw new Error("429: rate limited");
      return { text: '{"title": "A", "why": "B", "fix": "C"}', latencyMs: 5 };
    });
    const issue = (await issues()).issues.find((i) => i.runs === 2)!;
    await diagnose(issue.id);
    const failed = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "failed");
    const shown = failed.issues.find((i) => i.id === issue.id)!;
    expect(shown.diagnosis).toMatchObject({ status: "failed", error: "429: rate limited" });
    expect(shown.title).toBeTruthy(); // the rule-based text still shows

    fail = false;
    await diagnose(issue.id);
    const fixed = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "ready");
    expect(fixed.issues.find((i) => i.id === issue.id)!.diagnosis).toMatchObject({ status: "ready", title: "A" });
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
    expect(parseDiagnosis('Sure! {"title": "A", "why": "B", "fix": "C"} Hope that helps')).toEqual({ title: "A", why: "B", fix: "C", lesson: null, manual: null });
    // The lesson the agent would get, and the settings change only the owner should make.
    expect(parseDiagnosis('{"title": "A", "why": "B", "fix": "C", "lesson": "In cron runs, never use execute_code.", "manual": ""}')).toMatchObject({
      lesson: "In cron runs, never use execute_code.",
      manual: null,
    });
    expect(parseDiagnosis('{"title": "A", "why": "", "fix": "C"}')).toBeNull();
    expect(parseDiagnosis("no json here")).toBeNull();
  });
});
