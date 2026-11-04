import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/arena/llm";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { estimate } from "../src/priority";

type Importance = { level: string; reason: string; by: string | null };
type Issue = { id: string; title: string; runs: number; importance: Importance };

const DAY = 24 * 3_600_000;
const isRating = (request: ChatRequest) => String(request.messages[0]?.content).startsWith("You help the owner of AI agents decide what to fix first");

async function setup(chat?: ChatClient) {
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
  type Inbox = { issues: Issue[]; grouping: boolean; rating: boolean };
  const inbox = async () => (await (await app.request("/api/issues")).json()) as Inbox;
  /** The Inbox once grouping and rating have run. */
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const now = await inbox();
      if (!now.grouping && !now.rating) return now.issues;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("still busy");
  };
  let n = 0;
  /** A finished run `ago` ms ago whose one tool failed with this error. */
  const fail = async (error: string, ago = 3_600_000, tool: string | null = "terminal") => {
    const id = `run-${++n}`;
    const startedAt = new Date(Date.now() - ago + n * 1000);
    await db.insert(schema.runs).values({ id, projectId, harness: "hermes", externalId: id, source: "hook", status: "error", startedAt, endedAt: startedAt, name: `Task ${n}`, scannedAt: new Date() });
    await db.insert(schema.steps).values({ id: `${id}-s0`, projectId, runId: id, externalId: `${id}-s0`, kind: tool ? "tool" : "llm", name: tool ?? "call", toolName: tool, status: "error", error, startedAt });
  };
  return { db, inbox, settled, fail };
}

describe("how much each Inbox problem matters", () => {
  it("estimates from how often it happened this week until the model rates it", () => {
    const now = new Date();
    expect(estimate({ week: 6, lastSeen: now })).toMatchObject({ level: "high", reason: "Happened in 6 runs this week.", by: null });
    expect(estimate({ week: 3, lastSeen: now })).toMatchObject({ level: "medium" });
    expect(estimate({ week: 1, lastSeen: now })).toMatchObject({ level: "low", reason: "Happened once this week." });
    expect(estimate({ week: 0, lastSeen: new Date(Date.now() - 20 * DAY) })).toMatchObject({ level: "low", reason: "Not seen in over two weeks." });
  });

  it("shows the estimate without a model key", async () => {
    const { inbox, fail } = await setup();
    for (let i = 0; i < 6; i++) await fail("Model is unavailable", 3_600_000, null);
    await fail("1 test failed", 20 * DAY);
    await fail("1 test failed", 20 * DAY);
    const { issues, rating } = await inbox();
    expect(rating).toBe(false);
    expect(issues.map((issue) => [issue.runs, issue.importance.level, issue.importance.by])).toEqual([
      [6, "high", null],
      [2, "low", null],
    ]);
  });

  it("has the model rate recurring problems side by side, after grouping, and not again until a day has passed", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatClient = async (request) => {
      if (!isRating(request)) return { text: '{"groups": []}', latencyMs: 1 };
      asked.push(request);
      // The old test failures matter most to this owner; the model, not the count, decides.
      const lines = String(request.messages[1]!.content).split("\n");
      const ratings = lines.map((line, i) => (line.includes("tests") || line.includes("terminal") ? { n: i + 1, priority: "high", why: "Releases stay blocked." } : { n: i + 1, priority: "low", why: "Retries get through." }));
      return { text: JSON.stringify({ ratings }), inputTokens: 600, outputTokens: 60, latencyMs: 2 };
    };
    const { db, inbox, settled, fail } = await setup(chat);
    for (let i = 0; i < 6; i++) await fail("Model is unavailable", 3_600_000, null);
    await fail("1 test failed", 20 * DAY);
    await fail("1 test failed", 20 * DAY);
    await fail("Read failed: no such file", 3_600_000, "read_file");

    // New problems are grouped first; rating waits for that.
    const first = await inbox();
    expect(first.grouping).toBe(true);
    expect(first.rating).toBe(false);
    const issues = await settled();
    expect(asked).toHaveLength(1);
    const sent = String(asked[0]!.messages[1]!.content);
    expect(sent).toMatch(/#\d \[hermes\] .* \| 6 runs, 6 in the last 7 days, last 1 h ago/);
    expect(sent).toMatch(/2 runs, 0 in the last 7 days, last 20 days ago \| tool terminal/);
    // One-offs keep the estimate.
    expect(sent).not.toContain("read_file");
    expect(issues.map((issue) => [issue.runs, issue.importance.level, issue.importance.reason, issue.importance.by])).toEqual([
      [6, "low", "Retries get through.", MUSE_SPARK],
      [2, "high", "Releases stay blocked.", MUSE_SPARK],
      [1, "low", "Happened once this week.", null],
    ]);

    // Opening it again doesn't rate again; a day-old rating does, once the spacing allows.
    await inbox();
    expect(asked).toHaveLength(1);
    await db.update(schema.issuePriorities).set({ ratedAt: new Date(Date.now() - 2 * DAY) });
    expect((await inbox()).rating).toBe(false);
    expect(asked).toHaveLength(1);
  });
});
