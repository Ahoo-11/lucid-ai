import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { compress } from "hono/compress";
import { authRoutes } from "./auth";
import type { AppContext } from "./context";
import { createIngest } from "./ingestService";
import { SAFE_URL, installRoutes, publicEndpoint } from "./install";
import { linkRoutes } from "./links";
import { proxyRoutes } from "./proxy";
import { apiRoutes } from "./routes/api";
import { ingestRoutes } from "./routes/ingest";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const ingest = createIngest(ctx);
  // Checks the database too, so a release that cannot reach it is never promoted.
  app.get("/healthz", async (c) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch (error) {
      ctx.log.error(`[health] database check failed: ${(error as Error).message}`);
      return c.json({ ok: false, error: "database unreachable" }, 503);
    }
  });
  app.route("/", installRoutes());
  // Before /api: an installer starts and polls a link without signing in.
  app.route("/api/links", linkRoutes(ctx));
  app.route("/api/auth", authRoutes(ctx));
  app.route("/api", apiRoutes(ctx));
  // Before ingest: proxy requests carry the agent's provider key in
  // Authorization, which must be forwarded, not read as a Lucid key.
  app.route("/", proxyRoutes(ctx, ingest));
  app.route("/", ingestRoutes(ctx, ingest));

  // The built dashboard, when present (npm run build). In development Vite
  // serves it and proxies /api and /v1 here.
  if (existsSync(WEB_DIST)) {
    const index = readFileSync(`${WEB_DIST}/index.html`, "utf8");
    // Link previews need absolute URLs. The origin can come from request
    // headers, so only a plain URL goes into the page; otherwise they stay relative.
    const page = (c: Context) => {
      const origin = publicEndpoint(c);
      // Always revalidated, so a new release shows up on the next load.
      c.header("Cache-Control", "no-cache");
      return c.html(index.replaceAll("__LUCID_ORIGIN__", SAFE_URL.test(origin) ? origin : ""));
    };
    // Gzip for the dashboard's files and pages only. Everything above (API,
    // ingest, the LLM proxy) has already answered, so proxied replies stay
    // byte-for-byte what the provider sent.
    app.use("/*", compress());
    app.use("/assets/*", async (c, next) => {
      await next();
      // Bundle names carry a content hash, so a URL never changes meaning.
      if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    // Before serveStatic, which would send index.html for "/" as it is.
    app.get("/", page);
    app.get("/index.html", page);
    app.use("/*", serveStatic({ root: WEB_DIST }));
    // A bundle from an older release: a 404, not the page, which would
    // otherwise be cached for a year under a script's URL.
    app.get("/assets/*", (c) => c.notFound());
    app.get("*", page);
  }
  return app;
}
