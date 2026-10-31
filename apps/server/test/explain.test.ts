import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/ee/arena/llm";
import { parseDiagnosis } from "../src/explain";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type Issue = { id: string; title: string; runs: number; diagnosis: null | { status: string; title?: string; fix?: string; model?: string } };

async function setup(chat: ChatClient) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error }, chat, ai: { provider: "baseten", model: MUSE_SPARK, onlyModel: true } };
  const app = createApp(ctx);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // The same tool failing the same way in two runs: a recurring problem.
  for (const prompt of ["p1", "p2"]) {
    await post("/v1/hooks/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: prompt, prompt: `Count the lines (${prompt})` });
    await post("/v1/hooks/claude-code", { hook_event_name: "PostToolUseFailure", session_id: "s1", prompt_id: prompt, tool_name: "Bash", tool_use_id: `t-${prompt}`, error: "wc: command not found" });
  }
  const issues = async () => (await (await app.request("/api/issues")).json()) as { issues: Issue[]; diagnosisModel: string | null };
  return { issues };
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
  it("diagnoses a recurring problem once, in the background, from its evidence", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatClient = async (request) => {
      asked.push(request);
      return { text: '```json\n{"title": "Unix command used on Windows.", "why": "The agent ran wc, which Windows lacks.", "fix": "Add \\"Use PowerShell commands\\" to CLAUDE.md."}\n```', latencyMs: 5 };
    };
    const { issues } = await setup(chat);

    const first = await issues();
    expect(first.diagnosisModel).toBe(MUSE_SPARK);
    const issue = first.issues.find((i) => i.runs === 2)!;
    expect(issue.title).toBeTruthy(); // the rule-based text shows meanwhile
    expect(issue.diagnosis?.status).toMatch(/pending|ready/);

    const later = await until(issues, (r) => r.issues.find((i) => i.id === issue.id)?.diagnosis?.status === "ready");
    expect(later.issues.find((i) => i.id === issue.id)!.diagnosis).toEqual({
      status: "ready",
      title: "Unix command used on Windows",
      why: "The agent ran wc, which Windows lacks.",
      fix: 'Add "Use PowerShell commands" to CLAUDE.md.',
      model: MUSE_SPARK,
    });

    // It saw the evidence, asked for JSON at low effort, and asked only once.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ model: MUSE_SPARK, json: true, reasoningEffort: "low" });
    const evidence = String(asked[0]!.messages[1]!.content);
    expect(evidence).toContain("wc: command not found");
    expect(evidence).toContain('tool "Bash"');
    expect(evidence).toContain("Failed 2 times across 2 runs");
    await issues();
    expect(asked).toHaveLength(1);
  });

  it("falls back to the rules when the model fails", async () => {
    const { issues } = await setup(async () => {
      throw new Error("429: rate limited");
    });
    await issues();
    const after = await until(issues, (r) => r.issues.every((i) => i.diagnosis === null));
    const issue = after.issues.find((i) => i.runs === 2)!;
    expect(issue.diagnosis).toBeNull();
    expect(issue.title).toBeTruthy();
  });

  it("reads the model's JSON even with fences or chatter around it", () => {
    expect(parseDiagnosis('Sure! {"title": "A", "why": "B", "fix": "C"} Hope that helps')).toEqual({ title: "A", why: "B", fix: "C" });
    expect(parseDiagnosis('{"title": "A", "why": "", "fix": "C"}')).toBeNull();
    expect(parseDiagnosis("no json here")).toBeNull();
  });
});
