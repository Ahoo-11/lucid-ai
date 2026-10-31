import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { normalizeCode } from "../src/links";
import { LiveHub } from "../src/live";

async function hosted() {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: false, signups: true, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const signUp = async (email: string) => {
    const { cookie } = await call("POST", "/api/auth/signup", { email, password: "a long enough password" });
    return { cookie: cookie! };
  };
  return { app, db, call, signUp };
}

describe("connect links (run one command, click Approve)", () => {
  afterEach(() => {
    delete process.env.LUCID_PUBLIC_URL;
  });

  it("hands a key for the approver's project to the installer, exactly once", async () => {
    process.env.LUCID_PUBLIC_URL = "https://lucid.example.com";
    const { call, signUp } = await hosted();
    const start = await call("POST", "/api/links/start", { machine: "Ana's laptop", os: "macOS", agents: ["claude-code", "hermes", "nope"] });
    expect(start.status).toBe(201);
    const { deviceCode, userCode, url } = start.body as { deviceCode: string; userCode: string; url: string };
    expect(userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(url).toBe(`https://lucid.example.com/link?code=${userCode}`);
    expect((await call("POST", "/api/links/poll", { deviceCode })).body).toEqual({ status: "pending" });

    // Seeing and approving it needs an account; the installer side never does.
    expect((await call("GET", `/api/links/${userCode}`)).status).toBe(401);
    const ana = await signUp("ana@example.com");
    const shown = await call("GET", `/api/links/${userCode.toLowerCase().replace("-", "")}`, undefined, { cookie: ana.cookie });
    expect(shown.body).toMatchObject({ code: userCode, machine: "Ana's laptop", os: "macOS", agents: ["claude-code", "hermes"], status: "pending" });
    expect((await call("POST", `/api/links/${userCode}/approve`, {}, { cookie: ana.cookie })).status).toBe(200);
    // Approving twice, or someone else approving it, is refused.
    expect((await call("POST", `/api/links/${userCode}/approve`, {}, { cookie: ana.cookie })).status).toBe(409);

    const claimed = await call("POST", "/api/links/poll", { deviceCode });
    expect(claimed.body).toMatchObject({ status: "approved", endpoint: "https://lucid.example.com" });
    const key = claimed.body!.key as string;
    expect(key).toMatch(/^lucid_live_/);
    expect((await call("POST", "/api/links/poll", { deviceCode })).body).toEqual({ status: "claimed" });

    // The key is Ana's, named after the computer and its agents.
    const keys = (await call("GET", "/api/keys", undefined, { cookie: ana.cookie })).body!.keys as { name: string }[];
    expect(keys.map((k) => k.name)).toEqual(["Ana's laptop (Claude Code, Hermes Agent)"]);
    const hook = { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", prompt: "hello" };
    expect((await call("POST", "/v1/hooks/claude-code", hook, { "x-api-key": key })).status).toBe(200);
    expect(((await call("GET", "/api/runs", undefined, { cookie: ana.cookie })).body!.runs as unknown[]).length).toBe(1);

    // Another account only learns that the code is taken.
    const bo = await signUp("bo@example.com");
    expect((await call("GET", `/api/links/${userCode}`, undefined, { cookie: bo.cookie })).body).toEqual({ code: userCode, status: "taken" });
  });

  it("stops at a decline, and expires after ten minutes", async () => {
    const { call, db, signUp } = await hosted();
    const ana = await signUp("ana@example.com");

    const declined = (await call("POST", "/api/links/start", { machine: "box", agents: "hermes" })).body as { deviceCode: string; userCode: string };
    expect((await call("POST", `/api/links/${declined.userCode}/deny`, {}, { cookie: ana.cookie })).status).toBe(200);
    expect((await call("POST", "/api/links/poll", { deviceCode: declined.deviceCode })).body).toEqual({ status: "denied" });

    const late = (await call("POST", "/api/links/start", { machine: "box", agents: ["hermes"] })).body as { deviceCode: string; userCode: string };
    await db.update(schema.deviceLinks).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.deviceLinks.userCode, late.userCode));
    expect((await call("POST", `/api/links/${late.userCode}/approve`, {}, { cookie: ana.cookie })).status).toBe(409);
    expect((await call("POST", "/api/links/poll", { deviceCode: late.deviceCode })).body).toEqual({ status: "expired" });
    expect((await call("POST", "/api/links/poll", { deviceCode: "made-up" })).body).toEqual({ status: "expired" });
  });

  it("refuses links with nothing to connect, and approvals sent as a form", async () => {
    const { app, call, signUp } = await hosted();
    expect((await call("POST", "/api/links/start", { machine: "box", agents: ["muse"] })).status).toBe(400);
    const { userCode } = (await call("POST", "/api/links/start", { machine: "box", agents: ["hermes"] })).body as { userCode: string };
    const ana = await signUp("ana@example.com");
    const form = await app.request(`/api/links/${userCode}/approve`, { method: "POST", headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
    expect(form.status).toBe(415);
  });

  it("brings in past runs only when the approver asks for them", async () => {
    const { call, signUp } = await hosted();
    const ana = await signUp("ana@example.com");
    const approveWith = async (body: Record<string, unknown>) => {
      const { deviceCode, userCode } = (await call("POST", "/api/links/start", { machine: "box", agents: ["hermes"] })).body as { deviceCode: string; userCode: string };
      await call("POST", `/api/links/${userCode}/approve`, body, { cookie: ana.cookie });
      return (await call("POST", "/api/links/poll", { deviceCode })).body!.historyDays;
    };
    expect(await approveWith({})).toBe(0);
    expect(await approveWith({ historyDays: 30 })).toBe(30);
    expect(await approveWith({ historyDays: 7 })).toBe(7);
    expect(await approveWith({ historyDays: 9999 })).toBe(0);
  });

  it("reads codes however people type them", () => {
    expect(normalizeCode("wxyz 2345")).toBe("WXYZ-2345");
    expect(normalizeCode("WXYZ-2345")).toBe("WXYZ-2345");
    expect(normalizeCode("WXYZ-234")).toBeNull();
  });
});

describe("syncing past runs", () => {
  it("shows an upload's progress until it finishes, and only to its own project", async () => {
    const { call, db, signUp } = await hosted();
    const ana = await signUp("ana@example.com");
    const key = (await call("POST", "/api/keys", { name: "laptop" }, { cookie: ana.cookie })).body!.key as string;
    const report = (body: Record<string, unknown>) => call("POST", "/v1/syncs", body, { "x-api-key": key });
    const shown = async (cookie: string) => (await call("GET", "/api/syncs", undefined, { cookie })).body!.syncs as Record<string, unknown>[];

    expect((await call("POST", "/v1/syncs", { id: "s1", harness: "hermes", total: 40, done: 0 })).status).toBe(401);
    expect((await report({ id: "s1", harness: "hermes", total: 40, done: 0 })).status).toBe(200);
    expect((await report({ id: "s1", harness: "hermes", total: 40, done: 12 })).status).toBe(200);
    expect(await shown(ana.cookie)).toMatchObject([{ id: "s1", harness: "hermes", total: 40, done: 12, finished: false }]);

    const bo = await signUp("bo@example.com");
    expect(await shown(bo.cookie)).toEqual([]);

    await report({ id: "s1", harness: "hermes", total: 40, done: 40, finished: true });
    expect(await shown(ana.cookie)).toMatchObject([{ done: 40, finished: true }]);

    // A sender that went quiet (Hermes closed mid-way) drops off rather than spinning forever.
    await report({ id: "s2", harness: "claude-code", total: 5, done: 1 });
    await db.update(schema.historySyncs).set({ updatedAt: new Date(Date.now() - 4 * 60_000) }).where(eq(schema.historySyncs.id, "s2"));
    expect((await shown(ana.cookie)).map((s) => s.id)).toEqual(["s1"]);

    expect((await report({ id: "bad id!", harness: "hermes", total: 1 })).status).toBe(400);
    expect((await report({ id: "s3", harness: "hermes", total: -1 })).status).toBe(400);
  });
});

describe("one-command installers", () => {
  afterEach(() => {
    delete process.env.LUCID_PUBLIC_URL;
  });

  it("serves both scripts with this server's address and no key in them", async () => {
    process.env.LUCID_PUBLIC_URL = "https://lucid.example.com";
    const { app } = await hosted();
    const sh = await (await app.request("/connect.sh")).text();
    expect(sh).toMatch(/^#!\/bin\/sh\n/);
    expect(sh).toContain('LUCID_ENDPOINT="${LUCID_ENDPOINT:-https://lucid.example.com}"');
    expect(sh).not.toContain("\r");
    expect(sh).not.toContain("__LUCID_ENDPOINT__");
    // Under "curl | sh" the rest of the script is on stdin: no program it runs may read it.
    for (const line of sh.split("\n").filter((l) => /^\s*(if .*&& )?(node|hermes) /.test(l) || /\b(node "|hermes plugins|open "|xdg-open ")/.test(l))) {
      if (!line.trim().startsWith("say")) expect(line).toContain("</dev/null");
    }
    const ps1 = await (await app.request("/connect.ps1")).text();
    expect(ps1).toContain("'https://lucid.example.com'");
    expect(ps1).not.toContain("__LUCID_ENDPOINT__");
    // Plain ASCII, so Windows PowerShell's console shows it as written.
    expect(/^[\x00-\x7F]*$/.test(ps1)).toBe(true);
  });

  it("refuses to put an unsafe address into either script", async () => {
    process.env.LUCID_PUBLIC_URL = "https://x.example.com/$(reboot)";
    const { app } = await hosted();
    for (const path of ["/connect.sh", "/connect.ps1"]) {
      const response = await app.request(path);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("reboot");
    }
  });
});
