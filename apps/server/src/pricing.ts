import { type ModelPricingCatalog, estimateCostUsd, fetchOpenRouterCatalog, resolveModelPricing } from "@lucid/pricing";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { type Db, schema } from "./db";

const { steps } = schema;
const REFRESH_MS = 12 * 60 * 60 * 1000;

let catalog: ModelPricingCatalog | null = null;

export const pricingCatalog = () => catalog;

export function setPricingCatalog(next: ModelPricingCatalog | null) {
  catalog = next;
}

export function priceStep(step: {
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}) {
  const pricing = resolveModelPricing({ provider: step.provider, model: step.model, catalog });
  // Output tokens already include reasoning tokens for Anthropic and OpenAI,
  // so reasoning is not billed separately here.
  const cost = estimateCostUsd(pricing, {
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    cacheReadTokens: step.cacheReadTokens,
    cacheWriteTokens: step.cacheWriteTokens,
  });
  return { costUsd: cost, costSource: pricing.source };
}

/** Prices LLM steps written before the catalog loaded (or for models it lacked). */
export async function repriceUnpriced(db: Db) {
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.kind, "llm"), isNotNull(steps.model), or(isNull(steps.costSource), eq(steps.costSource, "unavailable"))))
    .limit(5000);
  const runIds = new Set<string>();
  for (const row of rows) {
    const { costUsd, costSource } = priceStep(row);
    if (costSource === "unavailable") continue;
    await db.update(steps).set({ costUsd, costSource }).where(eq(steps.id, row.id));
    runIds.add(row.runId);
  }
  return [...runIds];
}

export function startCatalogRefresh(db: Db, onRepriced: (runIds: string[]) => Promise<void>, log = console) {
  const load = async () => {
    try {
      setPricingCatalog(await fetchOpenRouterCatalog());
      const runIds = await repriceUnpriced(db);
      if (runIds.length) await onRepriced(runIds);
    } catch (error) {
      log.warn(`[pricing] could not load the OpenRouter price list: ${(error as Error).message}`);
    }
  };
  void load();
  const timer = setInterval(load, REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
