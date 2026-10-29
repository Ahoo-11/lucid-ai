// Clerk sign-in for hosted Lucid. Clerk owns accounts, sessions and the
// sign-in UI; Lucid verifies the session token on each request and keeps its
// own user → project mapping, created the first time a Clerk user shows up.

import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, schema } from "./db";

const { memberships, projects, users } = schema;

export type ClerkProfile = { email: string | null; emailVerified: boolean; name: string | null };

export type ClerkAuth = {
  publishableKey: string;
  /**
   * The Clerk user id behind a request, from the session token in
   * `Authorization: Bearer` or, for EventSource, the `__session` cookie.
   * `origins` are the frontends allowed to have issued the token.
   */
  identify(request: Request, origins: string[]): Promise<string | null>;
  profile(clerkId: string): Promise<ClerkProfile>;
};

export function clerkAuth(options: { secretKey: string; publishableKey: string }): ClerkAuth {
  const clerk = createClerkClient(options);
  return {
    publishableKey: options.publishableKey,
    async identify(request, origins) {
      const state = await clerk.authenticateRequest(request, { acceptsToken: "session_token", authorizedParties: origins });
      return state.isAuthenticated ? state.toAuth().userId : null;
    },
    async profile(clerkId) {
      const user = await clerk.users.getUser(clerkId);
      const primary = user.primaryEmailAddress;
      return {
        email: primary?.emailAddress.toLowerCase() ?? null,
        emailVerified: primary?.verification?.status === "verified",
        name: user.fullName || user.username || null,
      };
    },
  };
}

export type Account = { userId: string; projectId: string; email: string | null; name: string | null };

async function findAccount(db: Db, clerkId: string): Promise<Account | null> {
  const [row] = await db
    .select({ userId: users.id, projectId: memberships.projectId, email: users.email, name: users.name })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return row ?? null;
}

/**
 * The Lucid account for a Clerk user. First sight creates one (user, project,
 * owner membership). A password account with the same verified email is
 * linked instead, so moving a server to Clerk keeps everyone's data.
 * Returns null for a new user when sign-ups are closed.
 */
export async function accountForClerkUser(db: Db, clerkId: string, profile: () => Promise<ClerkProfile>, options: { signups: boolean }) {
  const existing = await findAccount(db, clerkId);
  if (existing) return existing;

  const { email, emailVerified, name } = await profile();
  if (email && emailVerified) {
    const linked = await db
      .update(users)
      .set({ clerkId })
      .where(and(eq(users.email, email), isNull(users.clerkId)))
      .returning({ id: users.id });
    if (linked.length) return findAccount(db, clerkId);
  }
  if (!options.signups) return null;

  await db.transaction(async (tx) => {
    const userId = randomUUID();
    // A parallel first request may have created it already; then do nothing.
    const created = await tx
      .insert(users)
      .values({ id: userId, clerkId, email: email && emailVerified ? email : null, name })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!created.length) return;
    const projectId = randomUUID();
    await tx.insert(projects).values({ id: projectId, name: name ? `${name}'s agents` : "My agents" });
    await tx.insert(memberships).values({ userId, projectId, role: "owner" });
  });
  return findAccount(db, clerkId);
}
