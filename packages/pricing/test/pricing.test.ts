import { describe, expect, it } from "vitest";
import { catalogFromOpenRouter, estimateCostUsd, modelPricingKeys, resolveModelPricing } from "../src/index";

const catalog = catalogFromOpenRouter({
  data: [
    {
      id: "anthropic/claude-sonnet-4.5",
      context_length: 200_000,
      pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" },
    },
    { id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002" } },
  ],
});

describe("pricing", () => {
  it("matches Anthropic API ids against OpenRouter's dotted ids", () => {
    const pricing = resolveModelPricing({ provider: "anthropic", model: "claude-sonnet-4-5-20250929", catalog });
    expect(pricing.source).toBe("catalog");
    expect(pricing.inputPerMillion).toBeCloseTo(3);
    expect(pricing.contextLength).toBe(200_000);
  });

  it("prices cache reads and writes at their own rates", () => {
    const pricing = resolveModelPricing({ provider: "anthropic", model: "claude-sonnet-4-5", catalog });
    const cost = estimateCostUsd(pricing, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75);
  });

  it("falls back to the input rate when cache rates are missing", () => {
    const pricing = resolveModelPricing({ model: "openai/gpt-5-mini", catalog });
    expect(estimateCostUsd(pricing, { cacheReadTokens: 4_000_000 })).toBeCloseTo(1);
  });

  it("returns null cost for unknown models instead of $0", () => {
    const pricing = resolveModelPricing({ model: "mystery-model", catalog });
    expect(pricing.source).toBe("unavailable");
    expect(estimateCostUsd(pricing, { inputTokens: 100 })).toBeNull();
  });

  it("treats :free variants as free before the catalog strips the tag", () => {
    expect(resolveModelPricing({ model: "openai/gpt-5-mini:free", catalog }).source).toBe("free");
  });

  it("builds provider-qualified and dated keys", () => {
    expect(modelPricingKeys("claude", "claude-opus-4-1-20250805")).toEqual([
      "anthropic/claude-opus-4-1-20250805",
      "claude-opus-4-1-20250805",
      "anthropic/claude-opus-4-1",
      "claude-opus-4-1",
    ]);
  });
});
