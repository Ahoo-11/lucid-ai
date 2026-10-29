// Accounts for hosted mode: email + password, a session cookie, and one
// project per account. Local mode (a server on loopback) skips all of this.

import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "./context";
import { type Db, schema } from "./db";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const { authSessions, memberships, projects, users } = schema;

export const SESSION_COOKIE = "lucid_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export async function createUser(db: Db, input: { email: string; password: string; name?: string }) {
  const userId = randomUUID();
  const projectId = randomUUID();
  await db.insert(users).values({ id: userId, email: input.email, name: input.name || null, passwordHash: await hashPassword(input.password) });
  await db.insert(projects).values({ id: projectId, name: input.name ? `${input.name}'s agents` : "My agents" });
  await db.insert(memberships).values({ userId, projectId, role: "owner" });
  return { userId, projectId };
}

export async function startSession(db: Db, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authSessions).values({ tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
  return token;
}

/** The signed-in user and their project, from the session cookie. */
export async function sessionFor(db: Db, token: string | undefined) {
  if (!token) return null;
  const [row] = await db
    .select({ userId: users.id, email: users.email, name: users.name, projectId: memberships.projectId })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(authSessions.tokenHash, sha256(token)), gt(authSessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

const isSecure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";

function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: isSecure(c), path: "/", maxAge: SESSION_DAYS * 86_400 });
}

const normalizeEmail = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export function authRoutes(ctx: AppContext) {
  const app = new Hono();
  const failures = new Map<string, { count: number; until: number }>();

  // Mutations only accept JSON: a cross-site form can't send it without a
  // CORS preflight, which together with SameSite=Lax cookies blocks CSRF.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && !(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "Send JSON" }, 415);
    }
    return next();
  });

  app.get("/me", async (c) => {
    if (ctx.localMode) return c.json({ mode: "local" });
    const session = await sessionFor(ctx.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ mode: "hosted", user: null, signups: ctx.signups !== false }, 401);
    return c.json({ mode: "hosted", user: { email: session.email, name: session.name }, projectId: session.projectId });
  });

  app.post("/signup", async (c) => {
    if (ctx.localMode) return c.json({ error: "Accounts are only used when Lucid is hosted." }, 400);
    if (ctx.signups === false) return c.json({ error: "Sign-ups are closed on this server." }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return c.json({ error: "Enter a valid email address." }, 400);
    if (typeof body.password !== "string" || body.password.length < 10) return c.json({ error: "Use a password of at least 10 characters." }, 400);
    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) return c.json({ error: "An account with this email already exists. Sign in instead." }, 409);
    const { userId } = await createUser(ctx.db, { email, password: body.password, name: body.name?.trim() });
    setSessionCookie(c, await startSession(ctx.db, userId));
    return c.json({ ok: true }, 201);
  });

  app.post("/login", async (c) => {
    if (ctx.localMode) return c.json({ ok: true });
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = normalizeEmail(body.email);
    const lock = failures.get(email);
    if (lock && lock.count >= MAX_FAILURES && lock.until > Date.now()) {
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    const ok = user && typeof body.password === "string" ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !ok) {
      const next = { count: (lock && lock.until > Date.now() ? lock.count : 0) + 1, until: Date.now() + LOCKOUT_MS };
      failures.set(email, next);
      return c.json({ error: "Wrong email or password." }, 401);
    }
    failures.delete(email);
    setSessionCookie(c, await startSession(ctx.db, user.id));
    return c.json({ ok: true });
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await ctx.db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
