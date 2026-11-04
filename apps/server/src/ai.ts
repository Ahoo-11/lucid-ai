// The model Lucid thinks with: Inbox diagnoses, fix tests, Arena replays and
// the Arena judge. The first key that's set picks the provider:
//   META_API_KEY (or MODEL_API_KEY)  Meta's Model API, Muse Spark
//   BASETEN_API_KEY                  Muse Spark on Baseten
//   OPENROUTER_API_KEY               any model, through OpenRouter
//   LUCID_REPLAY_API_KEY             any OpenAI-compatible API (with LUCID_REPLAY_BASE_URL)

import { type ChatClient, openAICompatibleClient } from "./arena/llm";

/** Muse Spark on Meta's own Model API (api.meta.ai), its latest version. */
export const META_MUSE_SPARK = "muse-spark-1.3";
/** Muse Spark as Baseten serves it. */
export const MUSE_SPARK = "meta-models/muse-spark-open-1026";
/** Muse Spark on OpenRouter. */
export const OPENROUTER_MUSE_SPARK = "meta/muse-spark-1.3";

/** What the rest of Lucid needs to know about its model provider. */
export type AiInfo = {
  provider: "meta" | "baseten" | "openrouter";
  /** The model Lucid's own features use; null: pick per use (OpenRouter's catalog). */
  model: string | null;
  /** True when the key is used with one model only, so that's all Arena offers. */
  onlyModel: boolean;
};

// Muse Spark always reasons, at full effort unless asked otherwise, and the
// thinking counts against max tokens: medium effort, generous room.
const MUSE_DEFAULTS = { minMaxTokens: 16_384, reasoningEffort: "medium" } as const;

export function aiFromEnv(read: (name: string) => string | undefined, fetchImpl?: typeof fetch): { chat: ChatClient; info: AiInfo } | undefined {
  const meta = read("META_API_KEY") || read("MODEL_API_KEY");
  if (meta) {
    return {
      chat: openAICompatibleClient({ apiKey: meta, fetchImpl, baseUrl: read("META_API_BASE") || "https://api.meta.ai/v1", defaults: MUSE_DEFAULTS }),
      info: { provider: "meta", model: read("LUCID_AI_MODEL") || META_MUSE_SPARK, onlyModel: true },
    };
  }
  const baseten = read("BASETEN_API_KEY");
  if (baseten) {
    return {
      chat: openAICompatibleClient({ apiKey: baseten, fetchImpl, baseUrl: read("BASETEN_BASE_URL") || "https://inference.baseten.co/v1", defaults: MUSE_DEFAULTS }),
      info: { provider: "baseten", model: read("LUCID_AI_MODEL") || MUSE_SPARK, onlyModel: true },
    };
  }
  const key = read("LUCID_REPLAY_API_KEY") || read("OPENROUTER_API_KEY");
  if (!key) return undefined;
  // OpenRouter reaches every model; Lucid's own features use Muse Spark there too unless told
  // otherwise. Another API (LUCID_REPLAY_BASE_URL) needs LUCID_AI_MODEL for them.
  const baseUrl = read("LUCID_REPLAY_BASE_URL");
  return {
    chat: openAICompatibleClient({ apiKey: key, fetchImpl, baseUrl, defaults: { ...MUSE_DEFAULTS, forModels: /muse-spark/i } }),
    info: { provider: "openrouter", model: read("LUCID_AI_MODEL") || (baseUrl ? null : OPENROUTER_MUSE_SPARK), onlyModel: false },
  };
}

/** Where Lucid's model runs, in words: "Meta" or "Baseten" for Muse Spark, else OpenRouter. */
export const providerLabel = (provider: AiInfo["provider"]) => ({ meta: "Meta", baseten: "Baseten", openrouter: "OpenRouter" })[provider];

/** "Muse Spark" for Meta's model, the model id otherwise. */
export const modelLabel = (model: string) => (/muse-spark/i.test(model) ? "Muse Spark" : model);
