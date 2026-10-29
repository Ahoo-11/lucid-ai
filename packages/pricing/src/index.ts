// Adapted from Agent-hub's shared/modelPricing.ts, extended with cache and
// reasoning token rates. Prices change constantly, so nothing provider-specific
// is hardcoded beyond a tiny seed: the live OpenRouter catalog is the source.

export type ModelPricingSource =
  /** The harness reported the cost itself (Claude Code's cost_usd). */
  | "reported"
  | "configured"
  | "catalog"
  | "seed"
  | "free"
  | "unavailable";

export type ModelRates = {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Falls back to the input rate when the catalog does not list it. */
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  /** Falls back to the output rate. */
  reasoningPerMillion?: number;
  contextLength?: number;
  /** The provider's own id ("anthropic/claude-haiku-4.5"), needed to call the model. */
  id?: string;
  name?: string;
  /** Whether the model accepts tool definitions (required to replay agent decisions). */
  tools?: boolean;
};

export type ResolvedModelPricing = ModelRates & { source: ModelPricingSource };

/** Keyed by canonical "<provider-slug>/<model>", e.g. "anthropic/claude-opus-4-5". */
export type ModelPricingCatalog = Record<string, ModelRates>;

export type TokenUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
};

// Last-resort rates, carried over from Agent-hub, so a cold start still prices
// the most common OpenAI models. The live catalog supersedes them.
const SEED_PRICING: Array<{ matches: (model: string) => boolean } & ModelRates> = [
  { matches: (m) => m.startsWith("gpt-4o-mini"), inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { matches: (m) => m.startsWith("gpt-4o"), inputPerMillion: 2.5, outputPerMillion: 10 },
  { matches: (m) => m.startsWith("gpt-4.1-nano"), inputPerMillion: 0.1, outputPerMillion: 0.4 },
  { matches: (m) => m.startsWith("gpt-4.1-mini"), inputPerMillion: 0.4, outputPerMillion: 1.6 },
  { matches: (m) => m.startsWith("gpt-4.1"), inputPerMillion: 2, outputPerMillion: 8 },
];

const PROVIDER_SLUGS: Record<string, string> = {
  openai: "openai",
  codex: "openai",
  azureopenai: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  claudecode: "anthropic",
  gemini: "google",
  google: "google",
  googleai: "google",
  vertexai: "google",
  meta: "meta-llama",
  mistral: "mistralai",
};

function nonNegative(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function providerSlug(provider?: string | null) {
  const normalized = (provider ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  return PROVIDER_SLUGS[normalized] ?? normalized;
}

// OpenRouter writes "claude-opus-4.5" where the Anthropic API writes
// "claude-opus-4-5", so dots and dashes are treated as the same separator.
function canonicalModel(model: string) {
  return model.trim().toLowerCase().replace(/\./g, "-");
}

// "gpt-4o-2024-08-06" and "gpt-4o:latest" both bill at the "gpt-4o" rate.
function modelVariants(model: string) {
  const variants = [model];
  const withoutTag = model.replace(/:[a-z0-9._-]+$/i, "");
  if (withoutTag !== model) variants.push(withoutTag);
  const undated = withoutTag.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|v\d+|latest|preview)$/i, "");
  if (undated && undated !== withoutTag) variants.push(undated);
  return [...new Set(variants)];
}

export function modelPricingKeys(provider?: string | null, model?: string | null): string[] {
  const raw = canonicalModel(model ?? "");
  if (!raw) return [];
  const slashIndex = raw.indexOf("/");
  const qualifiedSlug = slashIndex > 0 ? raw.slice(0, slashIndex) : "";
  const bareModel = slashIndex > 0 ? raw.slice(slashIndex + 1) : raw;
  const slug = qualifiedSlug || providerSlug(provider);
  const keys: string[] = [];
  for (const variant of modelVariants(bareModel)) {
    if (slug) keys.push(`${slug}/${variant}`);
    keys.push(variant);
  }
  return [...new Set(keys)];
}

function catalogLookup(catalog: ModelPricingCatalog, provider?: string | null, model?: string | null) {
  const keys = modelPricingKeys(provider, model);
  for (const key of keys) {
    const entry = catalog[key];
    if (entry) return entry;
  }
  // Accept an unambiguous bare-model match from any provider.
  const bareKeys = new Set(keys.filter((key) => !key.includes("/")));
  if (bareKeys.size > 0) {
    for (const [key, entry] of Object.entries(catalog)) {
      if (bareKeys.has(key.slice(key.indexOf("/") + 1))) return entry;
    }
  }
  return null;
}

export function isFreeModelId(model?: string | null) {
  const id = (model ?? "").trim().toLowerCase();
  return id.endsWith(":free") || id === "openrouter/free";
}

export function resolveModelPricing(options: {
  provider?: string | null;
  model?: string | null;
  configured?: ModelRates | null;
  catalog?: ModelPricingCatalog | null;
}): ResolvedModelPricing {
  const configured = options.configured;
  if (configured && (configured.inputPerMillion > 0 || configured.outputPerMillion > 0)) {
    return { ...configured, source: "configured" };
  }
  // Checked before the catalog, whose lookup strips ":free" as a version tag.
  if (isFreeModelId(options.model)) {
    return { inputPerMillion: 0, outputPerMillion: 0, source: "free" };
  }
  if (options.catalog) {
    const entry = catalogLookup(options.catalog, options.provider, options.model);
    if (entry) return { ...entry, source: "catalog" };
  }
  const bare = canonicalModel(options.model ?? "").replace(/^[a-z0-9-]+\//, "");
  const seed = SEED_PRICING.find((entry) => entry.matches(bare));
  if (seed) {
    const { matches: _matches, ...rates } = seed;
    return { ...rates, source: "seed" };
  }
  return { inputPerMillion: 0, outputPerMillion: 0, source: "unavailable" };
}

/**
 * Cost in USD, or null when the model has no known price (so the UI can say
 * "price unknown" instead of showing a wrong $0.00).
 *
 * `inputTokens` follows the Anthropic convention: it excludes cached tokens.
 * Callers holding OTel GenAI usage (where input includes cache reads) must
 * subtract the cached tokens first.
 */
export function estimateCostUsd(pricing: ResolvedModelPricing, usage: TokenUsage): number | null {
  if (pricing.source === "unavailable") return null;
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const reasoning = nonNegative(usage.reasoningTokens);
  return (
    input * pricing.inputPerMillion
    + output * pricing.outputPerMillion
    + cacheRead * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion)
    + cacheWrite * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    + reasoning * (pricing.reasoningPerMillion ?? pricing.outputPerMillion)
  ) / 1_000_000;
}

type OpenRouterModel = {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, string | number | undefined>;
  supported_parameters?: string[];
};

const perMillion = (perToken: unknown) => {
  const value = Number(perToken);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : undefined;
};

/** Converts OpenRouter's public /models payload (per-token prices) into a catalog. */
export function catalogFromOpenRouter(payload: { data?: OpenRouterModel[] }): ModelPricingCatalog {
  const catalog: ModelPricingCatalog = {};
  for (const model of payload.data ?? []) {
    if (!model.id || !model.pricing) continue;
    const input = perMillion(model.pricing.prompt);
    const output = perMillion(model.pricing.completion);
    if (input === undefined || output === undefined) continue;
    catalog[canonicalModel(model.id)] = {
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: perMillion(model.pricing.input_cache_read),
      cacheWritePerMillion: perMillion(model.pricing.input_cache_write),
      reasoningPerMillion: perMillion(model.pricing.internal_reasoning) || undefined,
      contextLength: typeof model.context_length === "number" ? model.context_length : undefined,
      id: model.id,
      name: model.name,
      tools: Array.isArray(model.supported_parameters) ? model.supported_parameters.includes("tools") : undefined,
    };
  }
  return catalog;
}

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export async function fetchOpenRouterCatalog(fetchImpl: typeof fetch = fetch): Promise<ModelPricingCatalog> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenRouter catalog request failed: ${response.status}`);
  return catalogFromOpenRouter((await response.json()) as { data?: OpenRouterModel[] });
}

export function modelContextWindow(catalog: ModelPricingCatalog | null | undefined, provider?: string | null, model?: string | null) {
  if (!catalog) return null;
  const length = catalogLookup(catalog, provider, model)?.contextLength;
  return typeof length === "number" && length > 0 ? length : null;
}
