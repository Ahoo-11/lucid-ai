import type { ClerkAuth } from "./clerk";
import type { Db } from "./db";
import type { ChatClient } from "./ee/arena/llm";
import type { LiveHub } from "./live";

export type AppContext = {
  db: Db;
  live: LiveHub;
  /**
   * Local mode: one project, no dashboard login, and ingest without a key is
   * accepted (the server only listens on loopback). Otherwise (hosted) people
   * sign in, each account has its own project, and every sender needs a key.
   */
  localMode: boolean;
  defaultProjectId: string;
  /** Hosted mode: whether new accounts can sign up (default true). */
  signups?: boolean;
  /** Hosted mode with Clerk keys: Clerk handles sign-in instead of email + password. */
  clerk?: ClerkAuth;
  log: Pick<Console, "info" | "warn" | "error">;
  /**
   * Model access for Arena replays and the judge (bring your own key). Unset
   * when no key is configured; the Arena then explains how to add one.
   */
  chat?: ChatClient;
};

export type AppEnv = { Variables: { projectId: string } };
