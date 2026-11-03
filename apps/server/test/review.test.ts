import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import type { ChatClient, ChatRequest } from "../src/ee/arena/llm";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { CHECKS_PER_DAY } from "../src/review";

type Symptom = { id: string; problem: string; toolName: string | null; runs: number; title: string; sample: string | null; via: string };
type Issue = { id: string; problem: string; toolName: string | null; harness: string; runs: number; title: string; sample: string | null; examples: { runId: string }[]; symptoms: Symptom[] };
type Step = Partial<typeof schema.steps.$inferInsert> & { kind: string };

/** The entry a kind of problem ended up in: its own, or the failure it came after. */
const holding = (all: Issue[], problem: string) => all.filter((issue) => issue.symptoms.some((symptom) => symptom.problem === problem));

async function setup(checker?: ChatClient) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  // The passes that group by cause and rate importance find nothing here; the model sees only checks.
  const inboxPass = (request: ChatRequest) => /^You (sort an AI agent's problems|help the owner of AI agents decide)/.test(String(request.messages[0]?.content));
  const chat: ChatClient | undefined = checker && (async (request) => (inboxPass(request) ? { text: '{"groups": [], "ratings": []}', latencyMs: 1 } : checker(request)));
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
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const issues = async () => (await call("GET", "/api/issues")).body.issues as Issue[];
  let n = 0;
  /** A finished run an hour ago, with its steps a second apart. */
  const run = async (fields: Partial<typeof schema.runs.$inferInsert>, stepList: Step[] = []) => {
    const id = `run-${++n}`;
    const startedAt = new Date(Date.now() - 3_600_000 + n * 1000);
    await db.insert(schema.runs).values({ id, projectId, harness: "hermes", externalId: id, source: "hook", status: "ok", startedAt, endedAt: startedAt, name: "Check the repo", ...fields });
    if (stepList.length) {
      await db.insert(schema.steps).values(
        stepList.map((step, i) => ({ id: `${id}-s${i}`, projectId, runId: id, externalId: `${id}-s${i}`, name: step.toolName ?? "call", status: "ok", startedAt: new Date(startedAt.getTime() + i * 1000), ...step })),
      );
    }
    return id;
  };
  return { db, projectId, call, issues, run };
}

/** A decision, then the same failing terminal call `times` times. */
const looping = (times: number, extra: Partial<Step> = {}): Step[] => [
  { kind: "llm", outputPreview: "Calls terminal" },
  ...Array.from({ length: times }, () => ({ kind: "tool", toolName: "terminal", inputHash: "npm-test", inputPreview: '{"command": "npm test"}', status: "error", error: "1 test failed", ...extra })),
];

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

describe("problems no step reported", () => {
  it("finds an agent repeating the same call to no effect, grouped by the tool it repeats", async () => {
    const { issues, run } = await setup();
    const same = (tool: string): Step[] => [{ kind: "llm" }, ...[1, 2, 3].map(() => ({ kind: "tool", toolName: tool, inputHash: "status", outputHash: "pending", inputPreview: "check the job" }))];
    await run({}, same("jobs"));
    await run({ name: "Is it done yet" }, same("jobs"));
    // Not loops: twice only, or the same call getting somewhere different each time.
    await run({}, same("jobs").slice(0, 3));
    await run({}, [{ kind: "llm" }, ...[1, 2, 3].map((i) => ({ kind: "tool", toolName: "terminal", inputHash: "tail", outputHash: `out-${i}`, inputPreview: "tail log" }))]);

    const loops = (await issues()).filter((i) => i.problem === "loop");
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ toolName: "jobs", harness: "hermes", runs: 2, title: "Stuck repeating jobs" });
    expect(loops[0]!.sample).toMatch(/It called jobs 3 times with the same input and got the same result every time: check the job/);
  });

  it("puts a loop of failing calls with the failure it repeats: one cause, one entry", async () => {
    const { issues, run } = await setup();
    await run({}, looping(4));
    await run({ name: "Run the tests again" }, looping(3));
    await run({}, looping(2));

    const all = await issues();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ problem: "error", toolName: "terminal", runs: 3 });
    const loop = all[0]!.symptoms.find((s) => s.problem === "loop")!;
    expect(loop).toMatchObject({ toolName: "terminal", runs: 2, title: "Stuck repeating terminal", via: "run" });
    expect(loop.sample).toMatch(/It called terminal 3 times with the same input and it failed every time: \{"command": "npm test"\}/);
  });

  it("flags a run costing far more than that agent usually does, once it knows what's usual", async () => {
    const few = await setup();
    await few.run({ costUsd: 0.01 });
    await few.run({ costUsd: 0.2 });
    expect((await few.issues()).filter((i) => i.problem === "cost")).toHaveLength(0);

    const { issues, run } = await setup();
    for (let i = 0; i < 10; i++) await run({ costUsd: 0.01, llmCallCount: 2 });
    const spike = await run({ costUsd: 0.12, llmCallCount: 14, inputTokens: 1_000, cacheReadTokens: 90_000 }, [{ kind: "llm", costUsd: 0.01 }, { kind: "llm", costUsd: 0.11 }]);
    // Twice the usual is normal variation, not a spike.
    await run({ costUsd: 0.02 });
    const costs = (await issues()).filter((i) => i.problem === "cost");
    expect(costs).toHaveLength(1);
    expect(costs[0]!.examples[0]!.runId).toBe(spike);
    expect(costs[0]!.sample).toBe("This run cost $0.12, 12× this agent's usual $0.01. It made 14 model calls and read 91,000 tokens.");
  });

  it("counts refusals and wrong answers only once the model confirms them", async () => {
    const asked: ChatRequest[] = [];
    const model: ChatClient = async (request) => {
      asked.push(request);
      const content = String(request.messages[1]?.content ?? "");
      const real = content.includes("can't access that page") || content.includes("all tests pass");
      return { text: JSON.stringify({ problem: real, reason: real ? "The page was reachable with the browser tool." : "Nothing went wrong.", step: 1 }), inputTokens: 900, outputTokens: 40, latencyMs: 3 };
    };
    const { db, projectId, issues, run } = await setup(model);
    await run({ output: "I'm sorry, but I can't access that page." }, [{ kind: "llm", outputPreview: "I can't" }]);
    await run({ output: "I can't find any problems: the repo is healthy." }, [{ kind: "llm" }]);
    await run({ output: "Done, all tests pass.", errorCount: 1 }, [{ kind: "llm" }, { kind: "tool", toolName: "terminal", status: "error", error: "2 failed" }]);

    // Suspected only: nothing shows before the checks are in.
    expect((await issues()).filter((i) => i.problem === "refusal" || i.problem === "wrong_answer")).toHaveLength(0);
    const checked = await until(
      () => db.select().from(schema.runFindings),
      (rows) => rows.filter((r) => r.kind !== "loop" && r.kind !== "cost").every((r) => r.status !== "suspected"),
    );
    expect(checked.filter((r) => r.status === "confirmed").map((r) => r.kind).sort()).toEqual(["refusal", "wrong_answer"]);
    expect(checked.find((r) => r.status === "cleared")).toMatchObject({ kind: "refusal", verdict: "Nothing went wrong.", model: MUSE_SPARK, inputTokens: 900 });
    expect(String(asked[0]!.messages[1]!.content)).toContain("## Its final answer");

    const found = await issues();
    expect(found.find((i) => i.problem === "refusal")).toMatchObject({ title: "Gave up on a task it could do", runs: 1 });
    // The wrong answer came after a failed step, so it's in that failure's entry.
    const [failure] = holding(found, "wrong_answer");
    expect(failure).toMatchObject({ problem: "error", toolName: "terminal" });
    expect(failure!.symptoms.find((s) => s.problem === "wrong_answer")!.sample).toContain("The page was reachable with the browser tool.");
    // The model named step 1, a model call: that's the decision a fix test replays.
    expect(checked.find((r) => r.kind === "refusal" && r.status === "confirmed")!.stepId).toBe(`run-1-s0`);
    expect(projectId).toBeTruthy();
  });

  it("checks nothing with auto-diagnose off or past the daily cap", async () => {
    let calls = 0;
    const model: ChatClient = async () => {
      calls++;
      return { text: '{"problem": true, "reason": "x"}', latencyMs: 1 };
    };
    const off = await setup(model);
    await off.call("POST", "/api/settings/auto-diagnose/off", {});
    await off.run({ output: "I'm unable to do that." }, [{ kind: "llm" }]);
    await off.issues();

    const capped = await setup(model);
    await capped.run({ output: "I'm unable to do that." }, [{ kind: "llm" }]);
    for (let i = 0; i < CHECKS_PER_DAY; i++) await capped.run({ name: `old ${i}`, scannedAt: new Date() });
    await capped.db.insert(schema.runFindings).values(
      Array.from({ length: CHECKS_PER_DAY }, (_, i) => ({ projectId: capped.projectId, runId: `run-${i + 2}`, kind: "refusal", status: "cleared", subject: "x", evidence: "x", model: MUSE_SPARK, checkedAt: new Date() })),
    );
    await capped.issues();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
  });

  it("tests a fix for a found problem on the model call where it went wrong", async () => {
    const { call, issues, run } = await setup(async () => ({ text: "{}", latencyMs: 1 }));
    await run({}, looping(3));
    await run({}, looping(3));
    const [loop] = holding(await issues(), "loop");
    if (!loop) throw new Error("no loop found");
    expect((await call("POST", `/api/issues/${loop.id}/test`, { text: "Stop after the same failure twice." })).status).toBe(200);
    const done = await until(issues, (all) => (all.find((i) => i.id === loop.id) as unknown as { fixTest: { status: string } }).fixTest.status !== "running");
    // These decisions recorded no request, so there's nothing to replay; it says so instead of guessing.
    expect((done.find((i) => i.id === loop.id) as unknown as { fixTest: { status: string; reason: string } }).fixTest).toMatchObject({ status: "untestable" });
  });
});
