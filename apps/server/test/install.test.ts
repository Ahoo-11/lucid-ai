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
    expect(script).toContain("Lucid plugin 0.5.1");
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

  it("fills the one command with what its link sets up, the key left as a slot", async () => {
    process.env.LUCID_PUBLIC_URL = "https://lucid.example.com";
    const app = await setup();
    const script = async (path: string) => {
      const response = await app.request(path);
      return { status: response.status, text: await response.text() };
    };

    const agents = await script("/connect.sh");
    expect(agents.text).toContain('LUCID_FOR="agents"');
    expect(agents.text).toContain("LUCID_ENV=''");

    const project = await script("/connect.sh?for=project&ai=openrouter");
    expect(project.text).toContain('LUCID_FOR="project"');
    expect(project.text).toContain("LUCID_ENV='LUCID_BASE_URL=https://lucid.example.com/p/__LUCID_KEY__/openrouter/v1'");
    expect((await script("/connect.ps1?for=project&ai=anthropic")).text).toContain("@'\nANTHROPIC_BASE_URL=https://lucid.example.com/p/__LUCID_KEY__/anthropic\n'@");

    const tracing = await script("/connect.sh?for=tracing");
    expect(tracing.text).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=https://lucid.example.com\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_EXPORTER_OTLP_HEADERS=x-api-key=__LUCID_KEY__");

    // The Baseten key is OpenClaw's own setting, written as is.
    const openclaw = await script("/connect.sh?for=openclaw&ai=baseten");
    expect(openclaw.text).toContain('baseUrl: "https://lucid.example.com/p/__LUCID_KEY__/baseten/v1"');
    expect(openclaw.text).toContain('apiKey: "${BASETEN_API_KEY}"');

    // Anything else is refused in words the shell can print as they are.
    const unknown = await script("/connect.sh?for=project&ai=$(reboot)");
    expect(unknown.status).toBe(400);
    expect(unknown.text).toMatch(/^echo "Lucid: unknown AI provider reboot\. Copy the command from Lucid again\." >&2; exit 1/);
    expect((await script("/connect.ps1?for=everything")).text).toContain('Write-Host "Lucid: unknown setup everything.');
  });

  it("refuses to put an unsafe address into a shell script", async () => {
    process.env.LUCID_PUBLIC_URL = "https://x.example.com/$(reboot)";
    const app = await setup();
    const response = await app.request("/install/hermes.sh");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("reboot");
  });
});
