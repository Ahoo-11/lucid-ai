import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { authRoutes } from "./auth";
import type { AppContext } from "./context";
import { createIngest } from "./ingestService";
import { SAFE_URL, installRoutes, publicEndpoint } from "./install";
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
      return c.html(index.replaceAll("__LUCID_ORIGIN__", SAFE_URL.test(origin) ? origin : ""));
    };
    // Before serveStatic, which would send index.html for "/" as it is.
    app.get("/", page);
    app.get("/index.html", page);
    app.use("/*", serveStatic({ root: WEB_DIST }));
    app.get("*", page);
  }
  return app;
}
