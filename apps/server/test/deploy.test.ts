import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { migrationCount, missingMigrations } from "../src/schemaCheck";

async function setup() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: false, defaultProjectId: projectId, log: { info() {}, warn() {}, error() {} } };
  return { app: createApp(ctx), db };
}

describe("deploy checks", () => {
  it("health checks the database", async () => {
    const { app, db } = await setup();
    expect((await app.request("/healthz")).status).toBe(200);
    // A database that stops answering fails the check instead of reporting healthy.
    (db as unknown as { execute: () => Promise<never> }).execute = () => Promise.reject(new Error("connection refused"));
    const down = await app.request("/healthz");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, error: "database unreachable" });
  });

  it("finds no missing migrations on a migrated database, and all of them on an empty one", async () => {
    const { db } = await setup();
    expect(await missingMigrations(async (text) => db.execute(sql.raw(text)) as Promise<{ rows: Record<string, unknown>[] }>)).toEqual([]);
    const empty = new PGlite();
    const missing = await missingMigrations((text) => empty.query(text));
    expect(missing).toHaveLength(migrationCount);
    await empty.close();
  });

  it("puts the forwarded https address into setup snippets behind a TLS proxy", async () => {
    const { app } = await setup();
    const script = await (await app.request("http://lucid.internal:4318/install/hermes.sh", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "lucid.example.com" } })).text();
    expect(script).toContain('LUCID_ENDPOINT="${LUCID_ENDPOINT:-https://lucid.example.com}"');
    // A forged host still cannot inject shell into the script.
    const forged = await app.request("http://lucid.internal:4318/install/hermes.sh", { headers: { "x-forwarded-host": "x.com$(id)" } });
    expect(forged.status).toBe(500);
  });
});
