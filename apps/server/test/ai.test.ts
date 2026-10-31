import { describe, expect, it } from "vitest";
import { MUSE_SPARK, aiFromEnv } from "../src/ai";

/** Records what the client sends and answers like an OpenAI-compatible API. */
function recorder() {
  const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", reasoning_content: "thinking…" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 9 } }));
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const env = (values: Record<string, string>) => (name: string) => values[name];

describe("Lucid's model provider", () => {
  it("uses Muse Spark on Baseten when its key is set, in Baseten's own dialect", async () => {
    const { sent, fetchImpl } = recorder();
    const ai = aiFromEnv(env({ BASETEN_API_KEY: "bt-key", OPENROUTER_API_KEY: "or-key" }), fetchImpl)!;
    expect(ai.info).toEqual({ provider: "baseten", model: MUSE_SPARK, onlyModel: true });

    const result = await ai.chat({ model: MUSE_SPARK, messages: [{ role: "user", content: "hi" }], maxTokens: 512 });
    expect(result).toMatchObject({ text: "ok", inputTokens: 3, outputTokens: 9 });
    expect(sent[0]!.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(sent[0]!.headers.authorization).toBe("Bearer bt-key");
    // It always reasons, and the thinking counts against max_tokens: medium effort, a generous floor.
    expect(sent[0]!.body).toMatchObject({ model: MUSE_SPARK, max_tokens: 16_384, reasoning_effort: "medium" });
    expect(sent[0]!.body).not.toHaveProperty("reasoning");
    expect(sent[0]!.body).not.toHaveProperty("usage");

    await ai.chat({ model: MUSE_SPARK, messages: [], reasoningEffort: "low", maxTokens: 40_000, json: true });
    expect(sent[1]!.body).toMatchObject({ max_tokens: 40_000, reasoning_effort: "low", response_format: { type: "json_object" } });
  });

  it("falls back to OpenRouter, in OpenRouter's dialect, and to nothing without a key", async () => {
    const { sent, fetchImpl } = recorder();
    const ai = aiFromEnv(env({ OPENROUTER_API_KEY: "or-key" }), fetchImpl)!;
    expect(ai.info).toEqual({ provider: "openrouter", model: null, onlyModel: false });
    await ai.chat({ model: "openai/gpt-5-mini", messages: [], reasoningEffort: "low" });
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ reasoning: { effort: "low" }, usage: { include: true } });
    expect(sent[0]!.body).not.toHaveProperty("reasoning_effort");

    expect(aiFromEnv(env({}))).toBeUndefined();
  });
});
