import { describe, expect, it } from "vitest";
import { judgePair, parseVerdict } from "../src/ee/arena/judge";
import type { ChatClient } from "../src/ee/arena/llm";
import { bradleyTerry, standings } from "../src/ee/arena/ratings";
import { decisionRequest, toChatMessages, toChatTools, withSystemPrompt } from "../src/ee/arena/request";

describe("ratings", () => {
  it("orders a clear chain A > B > C and keeps ratings finite", () => {
    const games = [
      ...Array.from({ length: 5 }, () => ({ a: "A", b: "B", winner: "a" as const })),
      ...Array.from({ length: 5 }, () => ({ a: "B", b: "C", winner: "a" as const })),
    ];
    const ratings = bradleyTerry(["A", "B", "C"], games);
    expect(ratings.get("A")!).toBeGreaterThan(ratings.get("B")!);
    expect(ratings.get("B")!).toBeGreaterThan(ratings.get("C")!);
    expect(Number.isFinite(ratings.get("A"))).toBe(true);
  });

  it("rates evenly matched players the same and counts ties as half wins", () => {
    const result = standings(["X", "Y"], [
      { a: "X", b: "Y", winner: "a" },
      { a: "X", b: "Y", winner: "b" },
      { a: "Y", b: "X", winner: "tie" },
    ]);
    expect(result.get("X")).toMatchObject({ wins: 1, losses: 1, ties: 1, games: 3, winRate: 0.5 });
    expect(result.get("X")!.rating).toBe(result.get("Y")!.rating);
  });

  it("leaves players without games unrated", () => {
    expect(standings(["X", "Y"], []).get("X")).toMatchObject({ games: 0, winRate: null, rating: null });
  });
});

describe("judge", () => {
  it("reads JSON verdicts, with or without surrounding text", () => {
    expect(parseVerdict('{"winner":"B","reason":"reads the file first"}')).toEqual({ winner: "b", reason: "reads the file first" });
    expect(parseVerdict('Sure.\n{"winner": "tie", "reason": "same"}')).toEqual({ winner: "tie", reason: "same" });
    expect(parseVerdict("no idea")).toBeNull();
  });

  // A judge that prefers whatever contains "read" — independent of position.
  const fair: ChatClient = async (req) => {
    const prompt = String(req.messages[1]!.content);
    const a = prompt.split("## Candidate A")[1]!.split("## Candidate B")[0]!;
    return { text: JSON.stringify({ winner: a.includes("read_file") ? "A" : "B", reason: "uses read_file" }), latencyMs: 1 };
  };
  // A judge that always picks the first answer: position bias.
  const biased: ChatClient = async () => ({ text: '{"winner":"A","reason":"first"}', latencyMs: 1 });

  const x = { toolCalls: [{ name: "read_file", input: { path: "notes.txt" } }] };
  const y = { text: "I think it has 3 files." };

  it("keeps a verdict that survives swapping the order", async () => {
    expect(await judgePair(fair, "judge", "rubric", { request: "count files" }, x, y)).toMatchObject({ winner: "a", consistent: true });
    expect(await judgePair(fair, "judge", "rubric", { request: "count files" }, y, x)).toMatchObject({ winner: "b", consistent: true });
  });

  it("gives reasoning models room and retries an empty reply once", async () => {
    const requests: { maxTokens?: number; reasoningEffort?: string }[] = [];
    let calls = 0;
    const flaky: ChatClient = async (req) => {
      requests.push(req);
      calls++;
      // Each order's first attempt comes back empty, as a reasoning model out of tokens does.
      return calls <= 2 ? { latencyMs: 1 } : { text: '{"winner":"tie","reason":"same"}', latencyMs: 1 };
    };
    expect(await judgePair(flaky, "judge", "rubric", {}, x, y)).toMatchObject({ winner: "tie", consistent: true });
    expect(requests[0]).toMatchObject({ reasoningEffort: "low" });
    expect(requests[0]!.maxTokens).toBeGreaterThanOrEqual(2000);
  });

  it("turns position bias into a tie", async () => {
    expect(await judgePair(biased, "judge", "rubric", {}, x, y)).toMatchObject({ winner: "tie", consistent: false });
  });

  it("never shows the judge a model name", async () => {
    const seen: string[] = [];
    const spy: ChatClient = async (req) => {
      seen.push(JSON.stringify(req.messages));
      return { text: '{"winner":"tie","reason":""}', latencyMs: 1 };
    };
    await judgePair(spy, "judge-model", "rubric", { request: "hi" }, { text: "hello" }, { text: "hey" });
    expect(seen.join("")).not.toMatch(/gpt|claude|deepseek|gemini/i);
  });
});

describe("request rebuilding", () => {
  it("cleans Hermes (OpenAI-style) messages for replay", () => {
    const messages = toChatMessages([
      { role: "system", content: "You are Hermes" },
      { role: "user", content: "count files" },
      { role: "assistant", content: "", reasoning_content: "x", tool_calls: [{ id: "c1", call_id: "c1", response_item_id: "r", type: "function", function: { name: "search_files", arguments: '{"pattern":"*"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"total_count":2}' },
    ]);
    expect(messages[2]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_files", arguments: '{"pattern":"*"}' } }] });
    expect(messages[3]).toEqual({ role: "tool", content: '{"total_count":2}', tool_call_id: "c1" });
  });

  it("converts OTel-style messages and flat tool definitions", () => {
    const messages = toChatMessages([
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "weather", arguments: { city: "Paris" } }] },
      { role: "tool", content: "18C" },
    ]);
    expect(messages[1]!.tool_calls![0]!.function).toEqual({ name: "weather", arguments: '{"city":"Paris"}' });
    expect(messages[2]).toEqual({ role: "user", content: "[tool result] 18C" });
    expect(toChatTools([{ type: "function", name: "weather", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "weather", parameters: { type: "object" } } },
    ]);
  });

  it("refuses decisions it can't replay faithfully", async () => {
    const none = await decisionRequest({ kind: "llm", status: "ok", inputHash: null, outputHash: null, attrs: null }, async () => null);
    expect(none).toMatchObject({ ok: false });
    const noTools = await decisionRequest(
      { kind: "llm", status: "ok", inputHash: "m", outputHash: null, attrs: { availableTools: ["read_file"] } },
      async () => JSON.stringify([{ role: "user", content: "hi" }]),
    );
    expect(noTools).toMatchObject({ ok: false, reason: expect.stringContaining("tool definitions") });
    // Schemas damaged by an old plugin's size limit: refuse rather than send them.
    const blobs: Record<string, string> = {
      m: JSON.stringify([{ role: "user", content: "hi" }]),
      t: JSON.stringify([{ type: "function", function: { name: "browser_exec", parameters: { type: "object", properties: { code: "…[truncated by Lucid]" } } } }]),
    };
    const truncated = await decisionRequest(
      { kind: "llm", status: "ok", inputHash: "m", outputHash: null, attrs: { availableTools: ["browser_exec"], toolsRef: "t" } },
      async (key) => blobs[key] ?? null,
    );
    expect(truncated).toMatchObject({ ok: false, reason: expect.stringContaining("cut short") });
  });

  it("appends to or replaces the system prompt for a variant", () => {
    const base = [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }];
    expect(withSystemPrompt(base, "append", "Always read files before answering.")[0]!.content).toBe("Be brief.\n\nAlways read files before answering.");
    expect(withSystemPrompt(base, "replace", "New prompt")[0]!.content).toBe("New prompt");
    expect(withSystemPrompt(base, null, null)).toBe(base);
  });
});
