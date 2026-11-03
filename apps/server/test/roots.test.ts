import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/ee/arena/llm";
import { errorSignature } from "../src/insights";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { type Grouping, type Symptom, groupByCause } from "../src/roots";

type Problem = { id: string; problem: string; toolName: string | null; runs: number; title: string; via: string };
type Issue = {
  id: string;
  problem: string;
  toolName: string | null;
  runs: number;
  ignored: boolean;
  symptoms: Problem[];
  affected: { runId: string; runName: string | null; problems: string[] }[];
};
type Step = Partial<typeof schema.steps.$inferInsert> & { kind: string };

const failure = (id: string, toolName: string | null, error: string, harness = "claude-code"): Symptom => ({ id, problem: "error", toolName, signature: errorSignature(error), sample: error, harness });

/** Who joined whom: each entry's problem ids, main one first. */
function entries(symptoms: Symptom[], groups = new Map<string, Grouping>()) {
  return groupByCause(symptoms, groups, (a, b) => a.id.localeCompare(b.id)).map((entry) => entry.members.map(({ symptom, via }) => `${symptom.id}:${via}`));
}

describe("one Inbox entry per root cause", () => {
  it("joins the same specific error across tools, but not generic words or people stopping the agent", () => {
    const outage = "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of this action";
    const stopped = "The user doesn't want to proceed with this tool use. The tool use was rejected";
    expect(
      entries([
        failure("a", "Edit", outage),
        failure("b", "Write", outage),
        failure("c", "Bash", "Exit code 1"),
        failure("d", "PowerShell", "Exit code 1"),
        failure("e", "AskUserQuestion", stopped),
        failure("f", "update_plan", stopped),
        // Another agent's same words are another cause.
        failure("g", "Edit", outage, "hermes"),
      ]),
    ).toEqual([["a:root", "b:words"], ["c:root"], ["d:root"], ["e:root"], ["f:root"], ["g:root"]]);
  });

  it("joins failures whose words don't matter: a quota, the model API unreachable, one tool timing out", () => {
    expect(
      entries([
        failure("a", null, "You've hit your session limit · resets 11:30pm (Asia/Karachi)"),
        failure("b", "WebFetch", "Usage limit reached for this plan"),
        failure("c", null, "Can't reach the API server — check your internet or DNS (ENOTFOUND)"),
        failure("d", null, "Connection dropped (ECONNRESET)"),
        failure("e", "computer", "screenshot failed: Screenshot timed out after 5s"),
        failure("f", "computer", "zoom failed: timeout waiting for the page"),
        // Timeouts in another tool, or unreachable sites from a tool, aren't the same cause.
        failure("g", "Grep", "Ripgrep search timed out after 20 seconds"),
        failure("h", "WebFetch", "getaddrinfo ENOTFOUND example.invalid"),
      ]),
    ).toEqual([["a:root", "b:rule"], ["c:root", "d:rule"], ["e:root", "f:rule"], ["g:root"], ["h:root"]]);
  });

  it("puts a give-up after a failure with that failure, joins what the model grouped, and lets the owner split one out", () => {
    const symptoms: Symptom[] = [
      failure("a", "browser_navigate", "Timed out after 30000ms"),
      { id: "b", problem: "refusal", toolName: null, signature: "refusal", sample: "It ended with: I can't open the page", harness: "claude-code", cause: "a" },
      failure("c", "browser_snapshot", "Target page, context or browser has been closed"),
      failure("d", "Read", "File does not exist"),
    ];
    const model = new Map<string, Grouping>([
      ["a", { groupId: "g1", split: false }],
      ["c", { groupId: "g1", split: false }],
      ["d", { groupId: null, split: false }],
    ]);
    expect(entries(symptoms, model)).toEqual([["a:root", "b:run", "c:model"], ["d:root"]]);
    // Split out, it stands alone whatever the rules or the model say; the give-up it caused goes with it.
    expect(entries(symptoms, new Map([...model, ["b", { groupId: null, split: true }]]))).toEqual([["a:root", "c:model"], ["b:root"], ["d:root"]]);
    expect(entries(symptoms, new Map([...model, ["a", { groupId: null, split: true }]]))).toEqual([["a:root", "b:run"], ["c:root"], ["d:root"]]);
  });
});

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
  const post = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const inbox = async () => (await (await app.request("/api/issues")).json()) as { issues: Issue[]; grouping: boolean };
  let n = 0;
  /** A finished run an hour ago, already looked at, with its steps a second apart; and what Lucid confirmed in it. */
  const run = async (name: string, stepList: Step[], finding?: "refusal" | "wrong_answer") => {
    const id = `run-${++n}`;
    const startedAt = new Date(Date.now() - 3_600_000 + n * 1000);
    await db.insert(schema.runs).values({ id, projectId, harness: "hermes", externalId: id, source: "hook", status: "ok", startedAt, endedAt: startedAt, name, scannedAt: new Date() });
    await db.insert(schema.steps).values(
      stepList.map((step, i) => ({ id: `${id}-s${i}`, projectId, runId: id, externalId: `${id}-s${i}`, name: step.toolName ?? "call", status: "ok", startedAt: new Date(startedAt.getTime() + i * 1000), ...step })),
    );
    if (finding) await db.insert(schema.runFindings).values({ projectId, runId: id, kind: finding, status: "confirmed", subject: name.toLowerCase(), evidence: "It ended with: I couldn't open the page.", stepId: `${id}-s0` });
    return id;
  };
  const browser = (tool: string, error: string): Step[] => [{ kind: "llm" }, { kind: "tool", toolName: tool, status: "error", error }];
  return { db, projectId, post, inbox, run, browser };
}

describe("a broken browser tool in the Inbox", () => {
  it("is one entry: its failures, and the give-ups and wrong answers they caused, with every run it broke", async () => {
    const { inbox, run, browser } = await setup();
    const digest1 = await run("Daily digest", browser("browser_navigate", "Timed out after 30000ms waiting for the page"), "refusal");
    const digest2 = await run("Daily digest", browser("browser_navigate", "navigation timeout of 30000 ms exceeded"));
    const research = await run("Research flights to Lisbon", browser("browser_navigate", "Timed out after 30000ms waiting for the page"), "wrong_answer");
    // Unrelated, and too generic to join each other.
    await run("Run the tests", [{ kind: "tool", toolName: "terminal", status: "error", error: "Exit code 1" }]);
    await run("Build it", [{ kind: "tool", toolName: "execute_code", status: "error", error: "Exit code 1" }]);

    const { issues } = await inbox();
    expect(issues).toHaveLength(3);
    const broken = issues[0]!;
    expect(broken).toMatchObject({ problem: "error", toolName: "browser_navigate", runs: 3 });
    expect(broken.symptoms.map((s) => [s.problem, s.runs, s.via])).toEqual([
      ["error", 2, "root"],
      ["error", 1, "rule"],
      ["refusal", 1, "run"],
      ["wrong_answer", 1, "run"],
    ]);
    // Every run it broke, newest first, with what happened in each.
    expect(broken.affected.map((r) => [r.runId, r.runName, r.problems.length])).toEqual([
      [research, "Research flights to Lisbon", 2],
      [digest2, "Daily digest", 1],
      [digest1, "Daily digest", 2],
    ]);
  });

  it("joins differently worded failures the model says share a cause, once, and keeps a split one apart", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatClient = async (request) => {
      const content = String(request.messages[1]?.content ?? "");
      if (!String(request.messages[0]?.content).startsWith("You sort an AI agent's problems")) return { text: "{}", latencyMs: 1 };
      asked.push(request);
      // The browser problems are one cause; the shell one isn't.
      const browserLines = content.split("\n").filter((line) => line.includes("browser_")).map((line) => Number(/^#(\d+)/.exec(line)![1]));
      return { text: JSON.stringify({ groups: [browserLines] }), inputTokens: 800, outputTokens: 20, latencyMs: 2 };
    };
    const { db, post, inbox, run, browser } = await setup(chat);
    await run("Daily digest", browser("browser_navigate", "Timed out after 30000ms waiting for the page"));
    await run("Daily digest", browser("browser_navigate", "Timed out after 30000ms waiting for the page"));
    await run("Research hotels", browser("browser_snapshot", "Target page, context or browser has been closed"), "refusal");
    await run("Run the tests", [{ kind: "tool", toolName: "terminal", status: "error", error: "Exit code 1" }]);

    expect((await inbox()).grouping).toBe(true);
    const until = async () => {
      for (let i = 0; i < 100; i++) {
        const now = await inbox();
        if (!now.grouping) return now.issues;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("still grouping");
    };
    const issues = await until();
    expect(asked).toHaveLength(1);
    expect(String(asked[0]!.messages[1]!.content)).toMatch(/#\d \[hermes\] .* \| tool browser_snapshot \| 1 run \| Target page, context or browser has been closed/);
    expect(issues).toHaveLength(2);
    const broken = issues[0]!;
    expect(broken).toMatchObject({ toolName: "browser_navigate", runs: 3 });
    expect(broken.symptoms.map((s) => [s.toolName, s.problem, s.via])).toEqual([
      ["browser_navigate", "error", "root"],
      ["browser_snapshot", "error", "model"],
      [null, "refusal", "run"],
    ]);
    // Everything read counts as compared: opening the Inbox again doesn't ask again.
    await inbox();
    expect(asked).toHaveLength(1);
    expect(await db.select().from(schema.issueGroups)).toHaveLength(4);

    // "Not the same problem": the snapshot failure leaves, with the give-up it caused, and stays out.
    const snapshot = broken.symptoms[1]!;
    expect((await post(`/api/issues/${snapshot.id}/split`)).status).toBe(200);
    const after = (await inbox()).issues;
    expect(after).toHaveLength(3);
    expect(after.find((i) => i.id === broken.id)!.symptoms.map((s) => s.toolName)).toEqual(["browser_navigate"]);
    expect(after.find((i) => i.id === snapshot.id)!.symptoms.map((s) => s.problem)).toEqual(["error", "refusal"]);
    expect((await post(`/api/issues/${broken.symptoms[0]!.id}/split`)).status).toBe(404);
  });

  it("ignores the whole entry, whichever way it showed up", async () => {
    const { db, post, inbox, run, browser } = await setup();
    await run("Daily digest", browser("browser_navigate", "Timed out after 30000ms waiting for the page"), "refusal");
    await run("Daily digest", browser("browser_navigate", "navigation timeout of 30000 ms exceeded"));
    const [entry] = (await inbox()).issues;
    expect(entry!.symptoms).toHaveLength(3);
    expect((await post(`/api/issues/${entry!.id}/ignore`)).status).toBe(200);
    expect(await db.select().from(schema.ignoredIssues)).toHaveLength(3);
    expect((await inbox()).issues[0]).toMatchObject({ id: entry!.id, ignored: true });
    await post(`/api/issues/${entry!.id}/restore`);
    expect(await db.select().from(schema.ignoredIssues)).toHaveLength(0);
  });
});
