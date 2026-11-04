import { describe, expect, it } from "vitest";
import { META_MUSE_SPARK, MUSE_SPARK, OPENROUTER_MUSE_SPARK, aiFromEnv } from "../src/ai";

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
  it("uses Muse Spark on Meta's Model API when a Meta key is set, ahead of the others", async () => {
    const { sent, fetchImpl } = recorder();
    const ai = aiFromEnv(env({ META_API_KEY: "meta-key", BASETEN_API_KEY: "bt-key", OPENROUTER_API_KEY: "or-key" }), fetchImpl)!;
    expect(ai.info).toEqual({ provider: "meta", model: META_MUSE_SPARK, onlyModel: true });
    await ai.chat({ model: META_MUSE_SPARK, messages: [{ role: "user", content: "hi" }], maxTokens: 512 });
    expect(sent[0]!.url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(sent[0]!.headers.authorization).toBe("Bearer meta-key");
    expect(sent[0]!.body).toMatchObject({ model: META_MUSE_SPARK, max_tokens: 16_384, reasoning_effort: "medium" });

    // Meta's own docs name the key MODEL_API_KEY; a model and base can be set too.
    const other = aiFromEnv(env({ MODEL_API_KEY: "m", LUCID_AI_MODEL: "muse-spark-1.1", META_API_BASE: "https://example.test/v1" }), fetchImpl)!;
    expect(other.info).toEqual({ provider: "meta", model: "muse-spark-1.1", onlyModel: true });
    await other.chat({ model: "muse-spark-1.1", messages: [] });
    expect(sent[1]!.url).toBe("https://example.test/v1/chat/completions");
  });

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
    // Lucid's own features use Muse Spark there too, so a lone OpenRouter key still diagnoses.
    expect(ai.info).toEqual({ provider: "openrouter", model: OPENROUTER_MUSE_SPARK, onlyModel: false });
    await ai.chat({ model: "openai/gpt-5-mini", messages: [], reasoningEffort: "low" });
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ reasoning: { effort: "low" }, usage: { include: true } });
    expect(sent[0]!.body).not.toHaveProperty("reasoning_effort");
    // Muse Spark's room to think applies to Muse Spark only.
    expect(sent[0]!.body).not.toHaveProperty("max_tokens");
    await ai.chat({ model: OPENROUTER_MUSE_SPARK, messages: [], maxTokens: 512 });
    expect(sent[1]!.body).toMatchObject({ max_tokens: 16_384, reasoning: { effort: "medium" } });
    // Another OpenAI-compatible API needs its model named.
    expect(aiFromEnv(env({ LUCID_REPLAY_API_KEY: "k", LUCID_REPLAY_BASE_URL: "https://example.test/v1" }))!.info.model).toBeNull();

    expect(aiFromEnv(env({}))).toBeUndefined();
  });
});
