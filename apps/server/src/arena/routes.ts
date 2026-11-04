import { Hono } from "hono";
import type { AppContext, AppEnv } from "../context";
import { pricingCatalog } from "../pricing";
import {
  ArenaError,
  type VariantInput,
  checkStep,
  createExperiment,
  experimentDetail,
  listExperiments,
  nextPair,
  recordVote,
  retryFailed,
  reveal,
  runJudge,
} from "./runner";

// Good, cheap judges in order of preference; the first one the catalog lists wins.
const JUDGE_PREFERENCES = ["openai/gpt-5-mini", "google/gemini-2.5-flash", "openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5", "openai/gpt-4o-mini"];

export function arenaRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof ArenaError) return c.json({ error: error.message, details: error.details }, error.status);
    ctx.log.error("[arena]", error);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/models", (c) => {
    // A key used with one model (Muse Spark, from Meta or Baseten): that
    // model is the challenger and the judge.
    if (ctx.ai?.onlyModel && ctx.ai.model) {
      const name = /muse-spark/i.test(ctx.ai.model) ? `Muse Spark (${ctx.ai.provider === "baseten" ? "Meta, on Baseten" : "Meta"})` : ctx.ai.model;
      const only = { id: ctx.ai.model, name, inputPerMillion: null, outputPerMillion: null, contextLength: null };
      return c.json({ configured: !!ctx.chat, models: [only], suggestedJudge: only.id, provider: ctx.ai.provider });
    }
    const catalog = pricingCatalog() ?? {};
    const models = Object.values(catalog)
      .filter((m) => m.id && m.tools)
      .map((m) => ({ id: m.id!, name: m.name ?? m.id!, inputPerMillion: m.inputPerMillion, outputPerMillion: m.outputPerMillion, contextLength: m.contextLength ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const ids = new Set(Object.values(catalog).map((m) => m.id));
    return c.json({ configured: !!ctx.chat, models, suggestedJudge: JUDGE_PREFERENCES.find((id) => ids.has(id)) ?? models[0]?.id ?? null });
  });

  app.get("/check", async (c) => c.json(await checkStep(ctx, c.get("projectId"), c.req.query("step") ?? "")));

  app.get("/experiments", async (c) => c.json({ experiments: await listExperiments(ctx, c.get("projectId")) }));

  app.post("/experiments", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { stepIds?: string[]; variants?: VariantInput[]; name?: string; judgeModel?: string; rubric?: string };
    const created = await createExperiment(ctx, c.get("projectId"), {
      stepIds: body.stepIds ?? [],
      variants: body.variants ?? [],
      name: body.name,
      judgeModel: body.judgeModel,
      rubric: body.rubric,
    });
    return c.json(created, 201);
  });

  app.get("/experiments/:id", async (c) => c.json(await experimentDetail(ctx, c.get("projectId"), c.req.param("id"))));

  app.get("/experiments/:id/pair", async (c) => c.json(await nextPair(ctx, c.get("projectId"), c.req.param("id"))));

  app.post("/experiments/:id/votes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { itemId?: string; a?: string; b?: string; winner?: string };
    await recordVote(ctx, c.get("projectId"), c.req.param("id"), { itemId: body.itemId ?? "", a: body.a ?? "", b: body.b ?? "", winner: body.winner ?? "" });
    return c.json(await nextPair(ctx, c.get("projectId"), c.req.param("id")));
  });

  app.post("/experiments/:id/judge", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    return c.json(await runJudge(ctx, c.get("projectId"), c.req.param("id"), body.model));
  });

  app.post("/experiments/:id/reveal", async (c) => {
    await reveal(ctx, c.get("projectId"), c.req.param("id"));
    return c.json(await experimentDetail(ctx, c.get("projectId"), c.req.param("id")));
  });

  app.post("/experiments/:id/retry", async (c) => {
    await retryFailed(ctx, c.get("projectId"), c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
