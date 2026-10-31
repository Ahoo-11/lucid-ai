// The model Lucid thinks with: Inbox diagnoses, Arena replays and the Arena
// judge. Meta's Muse Spark on Baseten when BASETEN_API_KEY is set (the Meta
// hackathon credits work with that one model only), otherwise OpenRouter.

import { type ChatClient, openAICompatibleClient } from "./ee/arena/llm";

export const MUSE_SPARK = "meta-models/muse-spark-open-1026";

/** What the rest of Lucid needs to know about its model provider. */
export type AiInfo = {
  provider: "baseten" | "openrouter";
  /** The model Lucid's own features use; null: pick per use (OpenRouter's catalog). */
  model: string | null;
  /** True when the key works with one model only, so that's all Arena offers. */
  onlyModel: boolean;
};

export function aiFromEnv(read: (name: string) => string | undefined, fetchImpl?: typeof fetch): { chat: ChatClient; info: AiInfo } | undefined {
  const baseten = read("BASETEN_API_KEY");
  if (baseten) {
    const model = read("LUCID_AI_MODEL") || MUSE_SPARK;
    return {
      chat: openAICompatibleClient({
        apiKey: baseten,
        fetchImpl,
        baseUrl: read("BASETEN_BASE_URL") || "https://inference.baseten.co/v1",
        // Muse Spark always reasons, at full effort unless asked otherwise, and
        // the thinking counts against max tokens: medium effort, generous room.
        defaults: { minMaxTokens: 16_384, reasoningEffort: "medium" },
      }),
      info: { provider: "baseten", model, onlyModel: true },
    };
  }
  const key = read("LUCID_REPLAY_API_KEY") || read("OPENROUTER_API_KEY");
  if (!key) return undefined;
  return {
    chat: openAICompatibleClient({ apiKey: key, fetchImpl, baseUrl: read("LUCID_REPLAY_BASE_URL") }),
    info: { provider: "openrouter", model: read("LUCID_AI_MODEL") || null, onlyModel: false },
  };
}

/** "Muse Spark" for Meta's model, the model id otherwise. */
export const modelLabel = (model: string) => (/muse-spark/i.test(model) ? "Muse Spark" : model);
