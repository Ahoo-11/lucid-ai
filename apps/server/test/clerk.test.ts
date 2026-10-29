import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUser } from "../src/auth";
import type { ClerkAuth, ClerkProfile } from "../src/clerk";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

/** Stands in for Clerk: the bearer token (or __session cookie) is the Clerk user id. */
function fakeClerk(profiles: Record<string, ClerkProfile>) {
  const lookups: string[] = [];
  const clerk: ClerkAuth = {
    publishableKey: "pk_test_lucid",
    async identify(request) {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const cookie = /(?:^|;\s*)__session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const id = bearer ?? cookie;
      return id && profiles[id] ? id : null;
    },
    async profile(id) {
      lookups.push(id);
      return profiles[id]!;
    },
  };
  return { clerk, lookups };
}

const PROFILES: Record<string, ClerkProfile> = {
  user_ada: { email: "ada@example.com", emailVerified: true, name: "Ada" },
  user_bo: { email: "bo@example.com", emailVerified: true, name: "Bo" },
  user_unverified: { email: "owner@example.com", emailVerified: false, name: null },
  user_owner: { email: "owner@example.com", emailVerified: true, name: "Owner" },
};

async function setup(options: { signups?: boolean } = {}) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const { clerk, lookups } = fakeClerk(PROFILES);
  const ctx: AppContext = { db, live: new LiveHub(), localMode: false, defaultProjectId: projectId, signups: options.signups ?? true, clerk, log: { info() {}, warn() {}, error() {} } };
  const app = createApp(ctx);
  const as = (user: string, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${user}`, ...init.headers } });
  return { app, db, as, lookups };
}

describe("Clerk sign-in", () => {
  it("tells the web app to use Clerk, with the publishable key", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/auth/config")).json()).toEqual({ mode: "hosted", provider: "clerk", publishableKey: "pk_test_lucid", signups: true });
  });

  it("creates an account on first sight and reuses it after", async () => {
    const { app, db, as, lookups } = await setup();
    expect((await app.request("/api/runs")).status).toBe(401);
    expect((await as("user_nobody", "/api/runs")).status).toBe(401);

    const me = await (await as("user_ada", "/api/auth/me")).json();
    expect(me).toMatchObject({ mode: "hosted", user: { email: "ada@example.com", name: "Ada" } });
    expect((await as("user_ada", "/api/runs")).status).toBe(200);
    expect(lookups).toEqual(["user_ada"]); // Clerk's user API is asked once, not per request
    const rows = await db.select().from(schema.users).where(eq(schema.users.clerkId, "user_ada"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passwordHash).toBeNull();
  });

  it("keeps each account's data apart", async () => {
    const { as } = await setup();
    expect((await as("user_ada", "/api/keys", { method: "POST", body: JSON.stringify({ name: "ada's key" }) })).status).toBe(201);
    const ada = await (await as("user_ada", "/api/keys")).json();
    const bo = await (await as("user_bo", "/api/keys")).json();
    expect(ada.keys.map((k: { name: string }) => k.name)).toEqual(["ada's key"]);
    expect(bo.keys).toEqual([]);
  });

  it("lets the session cookie read (for live updates) but not change anything", async () => {
    const { app, as } = await setup();
    await as("user_ada", "/api/auth/me");
    const cookie = { cookie: "__session=user_ada" };
    expect((await app.request("/api/overview", { headers: cookie })).status).toBe(200);
    const write = await app.request("/api/keys", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { ...cookie, "content-type": "application/json" } });
    expect(write.status).toBe(401);
  });

  it("turns new users away when sign-ups are closed, but keeps existing ones", async () => {
    const closed = await setup({ signups: false });
    const me = await closed.as("user_bo", "/api/auth/me");
    expect(me.status).toBe(403);
    expect(await me.json()).toMatchObject({ closed: true });
    expect((await closed.as("user_bo", "/api/runs")).status).toBe(403);
    // An account that existed before sign-ups closed still gets in.
    await createUser(closed.db, { email: "ada@example.com", password: "a long password here" });
    expect((await closed.as("user_ada", "/api/runs")).status).toBe(200);
  });

  it("links a password account with the same verified email, and only a verified one", async () => {
    const { db, as } = await setup();
    const { projectId } = await createUser(db, { email: "owner@example.com", password: "a long password here" });

    // Unverified at Clerk: a separate, new account.
    expect((await as("user_unverified", "/api/runs")).status).toBe(200);
    const [unverified] = await db.select().from(schema.users).where(eq(schema.users.clerkId, "user_unverified"));
    expect(unverified!.email).toBeNull();

    // Verified: the existing account (and its project) becomes the Clerk user's.
    await as("user_owner", "/api/runs");
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
    expect(owner!.clerkId).toBe("user_owner");
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, owner!.id));
    expect(membership!.projectId).toBe(projectId);
  });

  it("creates one account when the first requests arrive together", async () => {
    const { db, as } = await setup();
    const responses = await Promise.all(Array.from({ length: 5 }, () => as("user_bo", "/api/runs")));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await db.select().from(schema.users).where(eq(schema.users.clerkId, "user_bo"))).toHaveLength(1);
    expect(await db.select().from(schema.projects)).toHaveLength(2); // the default one plus Bo's
  });

  it("switches the built-in password routes off", async () => {
    const { app } = await setup();
    const login = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.co", password: "x" }), headers: { "content-type": "application/json" } });
    expect(login.status).toBe(404);
  });
});
