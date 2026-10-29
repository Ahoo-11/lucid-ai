import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

async function hosted(signups = true) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: false, signups, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  // A tiny cookie jar per person.
  const person = () => {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await app.request(path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.includes("=;") ? "" : set.split(";")[0]!;
      return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null, setCookie: set };
    };
    return { call };
  };
  return { app, person };
}

describe("hosted mode accounts", () => {
  it("signs up, scopes everything to the account's own project, and signs out", async () => {
    const { person } = await hosted();
    const ana = person();
    const bo = person();

    expect((await ana.call("GET", "/api/runs")).status).toBe(401);
    const signup = await ana.call("POST", "/api/auth/signup", { email: "Ana@Example.com", password: "correct horse battery", name: "Ana" });
    expect(signup.status).toBe(201);
    expect(signup.setCookie).toMatch(/lucid_session=.+; .*HttpOnly/i);
    expect((await ana.call("GET", "/api/auth/me")).body).toMatchObject({ mode: "hosted", user: { email: "ana@example.com", name: "Ana" } });

    // Ana's key sends data into Ana's project only.
    const key = (await ana.call("POST", "/api/keys", { name: "laptop" })).body!.key as string;
    await bo.call("POST", "/api/auth/signup", { email: "bo@example.com", password: "another long password" });
    const hook = { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", prompt: "Ana's private prompt" };
    expect((await ana.call("POST", "/v1/hooks/claude-code", hook, { "x-api-key": key })).status).toBe(200);
    expect(((await ana.call("GET", "/api/runs")).body!.runs as unknown[]).length).toBe(1);
    expect(((await bo.call("GET", "/api/runs")).body!.runs as unknown[]).length).toBe(0);
    expect(((await bo.call("GET", "/api/keys")).body!.keys as unknown[]).length).toBe(0);

    await ana.call("POST", "/api/auth/logout", {});
    expect((await ana.call("GET", "/api/runs")).status).toBe(401);
  });

  it("rejects bad sign-ups and wrong passwords, and locks out repeated failures", async () => {
    const { person } = await hosted();
    const p = person();
    expect((await p.call("POST", "/api/auth/signup", { email: "nope", password: "long enough password" })).status).toBe(400);
    expect((await p.call("POST", "/api/auth/signup", { email: "a@b.co", password: "short" })).status).toBe(400);
    expect((await p.call("POST", "/api/auth/signup", { email: "a@b.co", password: "long enough password" })).status).toBe(201);
    expect((await person().call("POST", "/api/auth/signup", { email: "A@B.co", password: "long enough password" })).status).toBe(409);

    const stranger = person();
    expect((await stranger.call("POST", "/api/auth/login", { email: "a@b.co", password: "wrong" })).status).toBe(401);
    for (let i = 0; i < 10; i++) await stranger.call("POST", "/api/auth/login", { email: "a@b.co", password: "wrong" });
    // Locked out even with the right password, for a while.
    expect((await stranger.call("POST", "/api/auth/login", { email: "a@b.co", password: "long enough password" })).status).toBe(429);
  });

  it("only accepts JSON for account changes (CSRF) and can close sign-ups", async () => {
    const { app, person } = await hosted(false);
    const form = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" });
    expect(form.status).toBe(415);
    expect((await person().call("POST", "/api/auth/signup", { email: "c@d.co", password: "long enough password" })).status).toBe(403);
  });
});
