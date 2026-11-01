import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { compareVersions, latestHermesPlugin, listPlugins, pluginTracker, pluginVersion, requestUpdate, updateOffer } from "../src/plugins";

const ua = (version: string) => ({ "user-agent": `lucid-hermes-plugin/${version}` });

async function setup() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const request = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  return { db, projectId, request };
}

describe("plugin versions and the Update button", () => {
  it("reads versions and compares them like people do", () => {
    expect(pluginVersion("lucid-hermes-plugin/0.4")).toBe("0.4");
    expect(pluginVersion("python-urllib/3.13")).toBeNull();
    expect(compareVersions("0.4", "0.4.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.4.0", "0.5.0")).toBe(-1);
  });

  it("knows each machine's plugin from what it sends, and that old ones need one update by hand", async () => {
    const { request } = await setup();
    await request("POST", "/v1/hooks/hermes", ua("0.3"), { events: [] });
    let plugins = (await request("GET", "/api/plugins")).body.plugins as Record<string, unknown>[];
    expect(plugins).toMatchObject([{ harness: "hermes", machine: "This computer", version: "0.3", latest: latestHermesPlugin(), state: "manual" }]);

    // Pressing Update can't reach a plugin that doesn't know how to update itself.
    expect((await request("POST", `/api/plugins/${plugins[0]!.id}/update`, {}, {})).status).toBe(200);
    expect((await request("GET", "/v1/lessons?harness=hermes", ua("0.3"))).body).toEqual({ lessons: [] });

    // Updated by hand to the version this server hands out: up to date.
    await request("GET", "/v1/lessons?harness=hermes", ua(latestHermesPlugin()));
    plugins = (await request("GET", "/api/plugins")).body.plugins as Record<string, unknown>[];
    expect(plugins[0]).toMatchObject({ version: latestHermesPlugin(), state: "current" });
    expect((await request("POST", "/api/plugins/no-such-plugin/update", {}, {})).status).toBe(404);
    expect((await request("POST", `/api/plugins/${plugins[0]!.id}/update`)).status).toBe(415);
  });

  it("offers the new files after Update, waits for the restart, then calls it done", async () => {
    const { db, projectId } = await setup();
    const note = pluginTracker(db);
    const who = { projectId, keyId: "key-1", harness: "hermes" };
    const newer = "9.9.0"; // a release newer than the plugin running
    await note({ ...who, userAgent: "lucid-hermes-plugin/0.5.0" });
    const [plugin] = await listPlugins(db, projectId, newer);
    expect(plugin).toMatchObject({ version: "0.5.0", state: "outdated" });

    // Nothing is offered until the owner asks.
    expect(await updateOffer(db, { ...who, userAgent: "lucid-hermes-plugin/0.5.0" }, newer)).toBeNull();
    await requestUpdate(db, projectId, plugin!.id);
    expect((await listPlugins(db, projectId, newer))[0]!.state).toBe("updating");
    expect(await updateOffer(db, { ...who, userAgent: "lucid-hermes-plugin/0.5.0" }, newer)).toEqual({
      version: newer,
      files: { "__init__.py": "/install/hermes/lucid/__init__.py", "plugin.yaml": "/install/hermes/lucid/plugin.yaml" },
    });

    // Downloaded, still running the old one: a restart finishes it.
    await note({ ...who, userAgent: "lucid-hermes-plugin/0.5.0", staged: newer });
    expect((await listPlugins(db, projectId, newer))[0]).toMatchObject({ state: "restart", stagedVersion: newer });
    await note({ ...who, userAgent: `lucid-hermes-plugin/${newer}` });
    expect((await listPlugins(db, projectId, newer))[0]).toMatchObject({ version: newer, state: "current", stagedVersion: null });
    expect(await updateOffer(db, { ...who, userAgent: `lucid-hermes-plugin/${newer}` }, newer)).toBeNull();
  });
});
