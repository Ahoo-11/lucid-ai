// "Run one command, click Approve", the way Tailscale and `gh auth login` do
// it (OAuth device authorization, RFC 8628, without the OAuth parts):
//
//   1. The installer on the agent's computer calls POST /api/links/start and
//      prints the link and the short code it gets back.
//   2. The person opens it while signed in and approves (POST /api/links/:code/approve).
//   3. The installer, polling POST /api/links/poll with its secret device
//      code, receives a fresh key for that person's project, exactly once.
//
// So no key is ever shown on screen or pasted into a terminal or a chat.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AppContext, AppEnv } from "./context";
import { schema } from "./db";
import { publicEndpoint } from "./install";
import { createApiKey } from "./keys";
import { requireProject } from "./routes/api";

const { deviceLinks } = schema;

const TTL_MS = 10 * 60_000;
const POLL_SECONDS = 2;
/** What the installers can connect today. */
const AGENTS: Record<string, string> = { "claude-code": "Claude Code", hermes: "Hermes Agent" };
// 32 letters and digits that can't be misread (no 0/O, 1/I): 8 of them, no modulo bias.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function newUserCode() {
  let code = "";
  for (const byte of randomBytes(8)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** "wxyz 2345", "WXYZ2345" and "WXYZ-2345" are the same code. */
export function normalizeCode(input: string) {
  const plain = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : null;
}

/** Whatever the installer sends about itself is shown to a person: keep it short and plain. */
const clean = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[^\p{L}\p{N} ._'()-]/gu, "")
        .trim()
        .slice(0, max)
    : "";

function agentsFrom(value: unknown) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(list.map((agent) => String(agent).trim()).filter((agent) => agent in AGENTS))];
}

const clientAddress = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";

/** Pending links past their time read as expired, whatever their row says. */
function shownStatus(row: { status: string; expiresAt: Date }) {
  if ((row.status === "pending" || row.status === "approved") && row.expiresAt.getTime() < Date.now()) return "expired";
  return row.status;
}

export function linkRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  const { db } = ctx;
  // Starting a link needs no account, so each address gets a few per window.
  const starts = new Map<string, { count: number; resetAt: number }>();

  app.post("/start", async (c) => {
    const now = Date.now();
    const address = clientAddress(c);
    const window = starts.get(address);
    if (window && window.resetAt > now && window.count >= 20) return c.json({ error: "Too many tries. Wait a few minutes and run it again." }, 429);
    starts.set(address, window && window.resetAt > now ? { ...window, count: window.count + 1 } : { count: 1, resetAt: now + TTL_MS });
    if (starts.size > 10_000) starts.clear();

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agents = agentsFrom(body.agents);
    if (!agents.length) return c.json({ error: `Nothing to connect. Supported: ${Object.values(AGENTS).join(", ")}.` }, 400);

    // Links live ten minutes; anything a day old is gone for good.
    await db.delete(deviceLinks).where(lt(deviceLinks.expiresAt, new Date(now - 24 * 60 * 60_000)));
    const [{ open } = { open: 0 }] = await db.select({ open: count() }).from(deviceLinks).where(and(eq(deviceLinks.status, "pending"), gt(deviceLinks.expiresAt, new Date(now))));
    if (open > 5_000) return c.json({ error: "Too many tries. Wait a few minutes and run it again." }, 429);

    const deviceCode = randomBytes(32).toString("base64url");
    const row = {
      id: randomUUID(),
      deviceCodeHash: sha256(deviceCode),
      machine: clean(body.machine, 64) || "A computer",
      os: clean(body.os, 24) || null,
      agents,
      expiresAt: new Date(now + TTL_MS),
    };
    // A clash among 32^8 codes is very unlikely; try a few times anyway.
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      const inserted = await db
        .insert(deviceLinks)
        .values({ ...row, userCode })
        .onConflictDoNothing()
        .returning({ id: deviceLinks.id });
      if (inserted.length) {
        const endpoint = publicEndpoint(c);
        return c.json({ deviceCode, userCode, url: `${endpoint}/link?code=${userCode}`, interval: POLL_SECONDS, expiresIn: TTL_MS / 1000 }, 201);
      }
    }
    return c.json({ error: "Couldn't make a code. Run it again." }, 500);
  });

  // Always 200 with a status, so a shell script only has to read one field.
  app.post("/poll", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { deviceCode?: unknown };
    if (typeof body.deviceCode !== "string") return c.json({ status: "expired" });
    const hash = sha256(body.deviceCode);
    const [row] = await db.select().from(deviceLinks).where(eq(deviceLinks.deviceCodeHash, hash)).limit(1);
    if (!row) return c.json({ status: "expired" });
    const status = shownStatus(row);
    if (status !== "approved") return c.json({ status });
    // Exactly one poll gets the key, however many arrive at once.
    const [claimed] = await db
      .update(deviceLinks)
      .set({ status: "claimed" })
      .where(and(eq(deviceLinks.id, row.id), eq(deviceLinks.status, "approved")))
      .returning({ projectId: deviceLinks.projectId });
    if (!claimed?.projectId) return c.json({ status: "claimed" });
    const names = row.agents.map((agent) => AGENTS[agent] ?? agent).join(", ");
    const key = await createApiKey(db, claimed.projectId, `${row.machine} (${names})`);
    return c.json({ status: "approved", key: key.key, endpoint: publicEndpoint(c) });
  });

  const signedIn = requireProject(ctx);

  app.get("/:code", signedIn, async (c) => {
    const code = normalizeCode(c.req.param("code"));
    const [row] = code ? await db.select().from(deviceLinks).where(eq(deviceLinks.userCode, code)).limit(1) : [];
    if (!row) return c.json({ error: "No such code. Check it, or run the command again." }, 404);
    const status = shownStatus(row);
    // Someone else's approved link: only say it's taken.
    if (row.projectId && row.projectId !== c.get("projectId")) return c.json({ code: row.userCode, status: "taken" });
    return c.json({ code: row.userCode, machine: row.machine, os: row.os, agents: row.agents, status, expiresAt: row.expiresAt.toISOString() });
  });

  const decide = (to: "approved" | "denied") => async (c: Context<AppEnv>) => {
    // JSON only: a cross-site form can't send it, so no one can approve on your behalf.
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const code = normalizeCode(c.req.param("code") ?? "");
    const [updated] = code
      ? await db
          .update(deviceLinks)
          .set({ status: to, projectId: to === "approved" ? c.get("projectId") : null })
          .where(and(eq(deviceLinks.userCode, code), eq(deviceLinks.status, "pending"), gt(deviceLinks.expiresAt, new Date())))
          .returning({ id: deviceLinks.id })
      : [];
    if (!updated) return c.json({ error: "This code expired or was already used. Run the command again for a new one." }, 409);
    return c.json({ ok: true });
  };

  app.post("/:code/approve", signedIn, decide("approved"));
  app.post("/:code/deny", signedIn, decide("denied"));

  return app;
}
