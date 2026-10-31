import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

async function setup() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: false, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  return createApp(ctx);
}

describe("Hermes installer", () => {
  afterEach(() => {
    delete process.env.LUCID_PUBLIC_URL;
  });

  it("serves a script with this server's public address and the plugin version, without signing in", async () => {
    process.env.LUCID_PUBLIC_URL = "https://lucid.example.com/";
    const app = await setup();
    const response = await app.request("/install/hermes.sh");
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain('LUCID_ENDPOINT="${LUCID_ENDPOINT:-https://lucid.example.com}"');
    expect(script).toContain("Lucid plugin 0.4.0");
    expect(script).toContain("hermes plugins enable lucid");
  });

  it("serves the plugin files and nothing else", async () => {
    const app = await setup();
    const plugin = await app.request("/install/hermes/lucid/__init__.py");
    expect(plugin.status).toBe(200);
    expect(await plugin.text()).toContain("def register(ctx");
    expect((await app.request("/install/hermes/lucid/plugin.yaml")).status).toBe(200);
    expect((await app.request("/install/hermes/lucid/test_lucid_plugin.py")).status).toBe(404);
    expect((await app.request("/install/hermes/lucid/..%2F..%2Fpackage.json")).status).toBe(404);
  });

  it("refuses to put an unsafe address into a shell script", async () => {
    process.env.LUCID_PUBLIC_URL = "https://x.example.com/$(reboot)";
    const app = await setup();
    const response = await app.request("/install/hermes.sh");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("reboot");
  });
});
