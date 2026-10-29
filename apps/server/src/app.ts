import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { authRoutes } from "./auth";
import type { AppContext } from "./context";
import { createIngest } from "./ingestService";
import { installRoutes } from "./install";
import { proxyRoutes } from "./proxy";
import { apiRoutes } from "./routes/api";
import { ingestRoutes } from "./routes/ingest";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const ingest = createIngest(ctx);
  app.get("/healthz", (c) => c.json({ ok: true }));
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
    app.use("/*", serveStatic({ root: WEB_DIST }));
    app.get("*", (c) => c.html(index));
  }
  return app;
}
