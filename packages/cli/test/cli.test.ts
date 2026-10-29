import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// config.ts reads LUCID_HOME at import time, so point it at a temp dir first.
const home = mkdtempSync(join(tmpdir(), "lucid-cli-"));
process.env.LUCID_HOME = home;
const { applyConnect, applyDisconnect } = await import("../src/claudeCode");
const { sessionTranscripts, syncTranscript } = await import("../src/transcripts");
const { connectHermes, importHermes } = await import("../src/hermes");
const { createApp } = await import("../../../apps/server/src/app");
const { openDb } = await import("../../../apps/server/src/db");
const { ensureDefaultProject } = await import("../../../apps/server/src/keys");
const { LiveHub } = await import("../../../apps/server/src/live");

const COMMAND = '"node" "/x/lucid.mjs" hook --harness claude-code';

describe("connect / disconnect", () => {
  const userHook = { type: "command", command: "echo mine" };
  const settings = { model: "opus", env: { FOO: "1" }, hooks: { Stop: [{ hooks: [userHook] }] } };

  it("adds hooks for every event, keeps the user's own hooks, and is idempotent", () => {
    const once = applyConnect(settings, COMMAND, { OTEL_LOGS_EXPORTER: "otlp" });
    const twice = applyConnect(once, COMMAND, { OTEL_LOGS_EXPORTER: "otlp" });
    expect(twice).toEqual(once);
    expect(once.model).toBe("opus");
    expect(once.env).toEqual({ FOO: "1", OTEL_LOGS_EXPORTER: "otlp" });
    expect(once.hooks!.Stop).toEqual([{ hooks: [userHook] }, { hooks: [{ type: "command", command: COMMAND, async: true, timeout: 30 }] }]);
    expect(once.hooks!.PostToolUse![0]!.matcher).toBe("*");
  });

  it("removes exactly what it added", () => {
    const connected = applyConnect(settings, COMMAND, { OTEL_LOGS_EXPORTER: "otlp" });
    expect(applyDisconnect(connected, ["OTEL_LOGS_EXPORTER"])).toEqual(settings);
  });
});

describe("transcript sync against a live server", () => {
  let endpoint = "";
  let close: () => void = () => {};
  let get: <T>(path: string) => Promise<T>;

  beforeAll(async () => {
    const { db } = await openDb();
    const projectId = await ensureDefaultProject(db);
    const app = createApp({ db, live: new LiveHub(), localMode: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    get = async (path) => (await (await fetch(`${endpoint}${path}`)).json()) as never;
  });
  afterAll(() => close());

  it("uploads only appended lines and picks up sub-agent files", async () => {
    const fixtures = join(import.meta.dirname, "../../normalize/test/fixtures");
    const mainLines = readFileSync(join(fixtures, "claude-session.jsonl"), "utf8").split("\n").filter(Boolean);
    const project = join(home, "projects", "repo");
    mkdirSync(join(project, "sess-1", "subagents"), { recursive: true });
    const mainPath = join(project, "sess-1.jsonl");

    // First part, plus half a line still being written.
    writeFileSync(mainPath, `${mainLines.slice(0, 7).join("\n")}\n${mainLines[7]!.slice(0, 20)}`);
    const target = { endpoint };
    const [main] = sessionTranscripts(mainPath);
    expect((await syncTranscript(target, main!)).sent).toBe(7);

    writeFileSync(mainPath, `${mainLines.join("\n")}\n`);
    expect((await syncTranscript(target, main!)).sent).toBe(mainLines.length - 7);
    expect((await syncTranscript(target, main!)).sent).toBe(0);

    writeFileSync(join(project, "sess-1", "subagents", "agent-agent-a.jsonl"), readFileSync(join(fixtures, "claude-subagent.jsonl")));
    writeFileSync(join(project, "sess-1", "subagents", "agent-agent-a.meta.json"), JSON.stringify({ toolUseId: "toolu_3", description: "Find the test files" }));
    const files = sessionTranscripts(mainPath);
    expect(files.map((f) => f.fileKey)).toEqual(["sess-1", "sess-1/agent-agent-a"]);
    expect(files[1]!.file).toMatchObject({ kind: "subagent", parentToolUseId: "toolu_3" });
    await syncTranscript(target, files[1]!);

    const { runs } = await get<{ runs: { id: string; name: string; status: string }[] }>("/api/runs");
    expect(runs).toHaveLength(2);
    const explore = runs.find((run) => run.name.startsWith("Explore"))!;
    const { steps } = await get<{ steps: { externalId: string; status: string }[] }>(`/api/runs/${explore.id}`);
    expect(steps.find((step) => step.externalId === "toolu_3")?.status).toBe("ok");
  });

  it("installs the Hermes plugin and imports Hermes history from state.db", async () => {
    const hermes = join(home, "hermes-home");
    mkdirSync(join(hermes, "plugins"), { recursive: true });
    const calls: string[][] = [];
    const result = connectHermes({ endpoint }, { home: hermes, run: (args) => (calls.push(args), { ok: true, output: "" }) });
    expect(calls).toEqual([["plugins", "enable", "lucid"]]);
    expect(readFileSync(join(result.pluginDir, "plugin.yaml"), "utf8")).toContain("name: lucid");
    expect(readFileSync(join(result.pluginDir, "__init__.py"), "utf8")).toContain("def register(ctx");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject({ endpoint });

    // A state.db with the columns Hermes uses (older versions lack some; the importer adapts).
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(hermes, "state.db"));
    db.exec(`create table sessions (id text primary key, source text, model text, parent_session_id text, started_at real, ended_at real, title text, estimated_cost_usd real);
             create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, finish_reason text, reasoning text);`);
    const now = Date.now() / 1000;
    db.prepare("insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?)").run("h-1", "cli", "deepseek/deepseek-v4-flash", null, now - 60, now - 10, "Hermes chat", 0.01);
    db.prepare("insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?)").run("h-old", "cli", "x", null, now - 30 * 86_400, now - 30 * 86_400, "Old", 0);
    const insert = db.prepare("insert into messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason) values (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("h-1", "user", "List the files", null, null, null, now - 59, null);
    insert.run("h-1", "assistant", "", null, JSON.stringify([{ id: "c1", type: "function", function: { name: "terminal", arguments: '{"command":"ls"}' } }]), null, now - 55, "tool_calls");
    insert.run("h-1", "tool", "a.txt\nb.txt", "c1", null, "terminal", now - 54, null);
    insert.run("h-1", "assistant", "Two files.", null, null, null, now - 50, "stop");
    db.close();

    const imported = await importHermes({ endpoint }, { days: 7, home: hermes });
    expect(imported).toMatchObject({ sessions: 1, runs: 1, failed: 0 });
    const { runs } = await get<{ runs: { id: string; name: string; harness: string; toolCallCount: number }[] }>("/api/runs?harness=hermes");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: "List the files", toolCallCount: 1 });
    // Importing again is idempotent.
    await importHermes({ endpoint }, { days: 7, home: hermes });
    expect((await get<{ runs: unknown[] }>("/api/runs?harness=hermes")).runs).toHaveLength(1);
  });

  it("recovers when the server lost its copy (409 → resend from the start)", async () => {
    const path = join(home, "projects", "repo", "sess-2.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", promptId: "p-x", sessionId: "sess-2", timestamp: "2026-10-27T11:00:00Z", message: { role: "user", content: "hello" } })}\n`);
    const [file] = sessionTranscripts(path);
    const cursors = join(home, "cursors.json");
    // Pretend we already sent 50 lines that the server never stored.
    writeFileSync(cursors, JSON.stringify({ ...JSON.parse(readFileSync(cursors, "utf8")), "sess-2": { lines: 50, bytes: 1 } }));
    appendFileSync(path, `${JSON.stringify({ type: "custom-title", customTitle: "Recovered", sessionId: "sess-2" })}\n`);
    await syncTranscript({ endpoint }, file!);
    const { runs } = await get<{ runs: { name: string }[] }>("/api/runs?q=hello");
    expect(runs.map((run) => run.name)).toEqual(["hello"]);
  });
});
