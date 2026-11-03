import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { StepAttrs } from "./index";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Redaction policy applied at ingest; null = the default (secrets only, see DEFAULT_REDACTION). */
  redaction: jsonb("redaction").$type<{ categories?: string[]; custom?: { name: string; pattern: string }[] } | null>(),
  /** Whether the model diagnoses recurring Inbox problems by itself (within the daily cap). */
  autoDiagnose: boolean("auto_diagnose").notNull().default(true),
  createdAt: createdAt(),
});

// ── Accounts (hosted mode) ──────────────────────────────────────────────
// Local mode has no users: one machine, one project, no login.

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** Null only for Clerk accounts without an email (e.g. phone sign-in). */
  email: text("email").unique(),
  name: text("name"),
  /** scrypt: "<salt hex>:<hash hex>". Null for Clerk accounts. */
  passwordHash: text("password_hash"),
  /** Clerk user id when Clerk handles sign-in. */
  clerkId: text("clerk_id").unique(),
  createdAt: createdAt(),
});

/** Sign-in sessions. Only a hash of the cookie token is stored. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user").on(t.userId)],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** First characters of the key, shown in the UI so people can tell keys apart. */
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
});

/**
 * "Run one command, click Approve": a computer asking to send to a project.
 * The installer polls with a secret device code; the person approves the
 * short user code in the dashboard, and the next poll receives a fresh key.
 */
export const deviceLinks = pgTable("device_links", {
  id: text("id").primaryKey(),
  /** What people compare and type: "WXYZ-2345". */
  userCode: text("user_code").notNull().unique(),
  /** Hash of the secret only the installer knows. */
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  machine: text("machine").notNull(),
  os: text("os"),
  agents: jsonb("agents").$type<string[]>().notNull(),
  /** pending → approved → claimed, or denied. */
  status: text("status").notNull().default("pending"),
  /** Set on approval: the project the key is made for. */
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  /** Chosen on approval: how many days of past runs to bring in (0: none, the default). */
  historyDays: integer("history_days").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/**
 * An upload of past runs in progress (a Hermes backfill, `lucid import`), as
 * reported by the sender, so the dashboard can say "12 of 40" until it's done.
 */
export const historySyncs = pgTable(
  "history_syncs",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** Made up by the sender, one per upload. */
    id: text("id").notNull(),
    harness: text("harness").notNull(),
    total: integer("total").notNull(),
    done: integer("done").notNull().default(0),
    startedAt: ts("started_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.id] }), index("history_syncs_project_updated").on(t.projectId, t.updatedAt)],
);

/**
 * An Inbox problem explained by a model (Muse Spark when Baseten is set up):
 * root cause and fix written from the failing steps, when someone asks for it.
 */
export const issueExplanations = pgTable(
  "issue_explanations",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** The Inbox's id for the problem: its kind, tool and error signature. */
    issueId: text("issue_id").notNull(),
    model: text("model").notNull(),
    /** ready, or failed (asked again with the Diagnose button). */
    status: text("status").notNull(),
    title: text("title"),
    /** One everyday sentence on what it means for the owner: the line the Inbox card shows. */
    summary: text("summary"),
    why: text("why"),
    fix: text("fix"),
    /** The instruction it proposes for the agent; applied only once the owner approves (see lessons). */
    lesson: text("lesson"),
    /** A setting or permission only the owner should change; never applied by Lucid. */
    manual: text("manual"),
    error: text("error"),
    /** Started by Lucid for a recurring problem rather than by a click; these count toward the daily cap. */
    auto: boolean("auto").notNull().default(false),
    /** What the diagnosis cost, to tune the prompt and the daily cap. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.issueId] })],
);

/**
 * A problem in a run that no step reported: the agent looping on the same
 * call, a cost spike, a refusal or give-up it didn't need, or an answer that
 * doesn't match what happened. Rules find loops and cost spikes; refusals and
 * wrong answers start as suspected, and the model's check confirms or clears
 * them. Confirmed ones are grouped into Inbox problems.
 */
export const runFindings = pgTable(
  "run_findings",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    /** loop, cost, refusal or wrong_answer. */
    kind: text("kind").notNull(),
    /** suspected (waiting for the model's check), confirmed, or cleared (the model found nothing wrong). */
    status: text("status").notNull(),
    /** What groups it with others: the tool a loop repeats, otherwise the task. */
    subject: text("subject").notNull(),
    /** What Lucid saw, in plain words. */
    evidence: text("evidence").notNull(),
    /** The model's reason for confirming or clearing a suspected one. */
    verdict: text("verdict"),
    /** The model call where it went wrong: the decision a fix test replays. */
    stepId: text("step_id"),
    /** Set when the model checked it; these count toward the daily cap. */
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    checkedAt: ts("checked_at"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.runId, t.kind] }), index("run_findings_project_status").on(t.projectId, t.status)],
);

/** One replayed decision in a fix test: did the agent, with the fix, avoid the problem? */
export type FixTestResult = { runId: string; runName: string | null; pass: boolean; reason: string; decision: string };

/**
 * The latest test of a fix for an Inbox problem: decisions where it went
 * wrong, replayed with the fix added and judged by the model. A fix reaches
 * an agent only with a passed test of exactly its text.
 */
export const fixTests = pgTable(
  "fix_tests",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    issueId: text("issue_id").notNull(),
    /** The fix tested. A rewrite after a failed round replaces it; the first one is kept in revisedFrom. */
    lesson: text("lesson").notNull(),
    revisedFrom: text("revised_from"),
    /** running, passed, failed, untestable (nothing could be replayed) or error. */
    status: text("status").notNull(),
    results: jsonb("results").$type<FixTestResult[]>(),
    /** The model that replayed and judged. */
    model: text("model"),
    /** The agent's own model, when the replay used another in its place. */
    standIn: text("stand_in"),
    /** Why it couldn't be tested, or what went wrong. */
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.issueId] })],
);

/**
 * An Inbox problem its owner chose to ignore: it leaves the list and the
 * badge, and is never diagnosed by itself. Bringing it back deletes the row.
 */
export const ignoredIssues = pgTable(
  "ignored_issues",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    issueId: text("issue_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.issueId] })],
);

/**
 * An instruction the owner approved for one kind of agent ("When running as a
 * cron job, never use execute_code"). The agent's Lucid plugin fetches the
 * active ones and adds them to every turn; turning one off removes it. Nothing
 * on the agent's machine is edited.
 */
export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** Which agent it's for (hermes, …): only that agent's plugin receives it. */
    harness: text("harness").notNull(),
    /** The Inbox problem it fixes, to count that problem's failures since. */
    issueId: text("issue_id"),
    text: text("text").notNull(),
    /** active or off. */
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    /** First time an agent fetched it while active: from then on it's in the agent's turns. */
    deliveredAt: ts("delivered_at"),
    turnedOffAt: ts("turned_off_at"),
  },
  (t) => [index("lessons_project_harness").on(t.projectId, t.harness)],
);

/**
 * A Lucid plugin installed in an agent on one machine (one per key), with the
 * version it reports, so the dashboard can offer an Update like an app does.
 */
export const agentPlugins = pgTable(
  "agent_plugins",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** The key it sends with ("local" for a keyless local Lucid): one per machine. */
    keyId: text("key_id").notNull(),
    harness: text("harness").notNull(),
    version: text("version").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    /** The owner pressed Update; the plugin gets the new files on its next check-in. */
    updateRequestedAt: ts("update_requested_at"),
    /** The version it downloaded and will run after the agent restarts. */
    stagedVersion: text("staged_version"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_plugins_key").on(t.projectId, t.keyId, t.harness)],
);

/** Every payload exactly as received, so improved normalizers can reprocess history. */
export const rawEvents = pgTable(
  "raw_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    harness: text("harness"),
    payload: jsonb("payload").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    error: text("error"),
  },
  (t) => [index("raw_events_project_received").on(t.projectId, t.receivedAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    harness: text("harness").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title"),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    userRef: text("user_ref"),
    startedAt: ts("started_at"),
    lastEventAt: ts("last_event_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_external").on(t.projectId, t.harness, t.externalId),
    index("sessions_project_last").on(t.projectId, t.lastEventAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    harness: text("harness").notNull(),
    externalId: text("external_id").notNull(),
    source: text("source").notNull(),
    name: text("name"),
    input: text("input"),
    output: text("output"),
    status: text("status").notNull().default("running"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    durationMs: integer("duration_ms"),
    model: text("model"),
    systemPromptHash: text("system_prompt_hash"),
    // Rollups recomputed from steps after every ingest batch.
    stepCount: integer("step_count").notNull().default(0),
    llmCallCount: integer("llm_call_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    /** True when at least one LLM step has no known price, so the total is a floor. */
    costIncomplete: integer("cost_incomplete").notNull().default(0),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** When Lucid last looked at the finished run for loops, cost spikes, refusals and wrong answers (see run_findings). */
    scannedAt: ts("scanned_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  // Not keyed on harness: run ids (prompt ids, trace ids) are globally unique,
  // and spans of one trace can come from services we would label differently.
  (t) => [
    uniqueIndex("runs_external").on(t.projectId, t.externalId),
    index("runs_project_started").on(t.projectId, t.startedAt),
    index("runs_session").on(t.sessionId),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ok"),
    seq: integer("seq"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    durationMs: integer("duration_ms"),
    model: text("model"),
    provider: text("provider"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: doublePrecision("cost_usd"),
    costSource: text("cost_source"),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    inputPreview: text("input_preview"),
    outputPreview: text("output_preview"),
    error: text("error"),
    attrs: jsonb("attrs").$type<StepAttrs>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("steps_external").on(t.runId, t.externalId),
    index("steps_run_order").on(t.runId, t.startedAt, t.seq),
    index("steps_project_tool").on(t.projectId, t.toolName),
  ],
);

/** Content-addressed payloads: the same system prompt sent 500 times is stored once. */
export const blobs = pgTable(
  "blobs",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.hash] })],
);

// ── Arena ────────────────────────────────────────────────────────────────
// An experiment replays captured decisions (LLM steps) with other models or
// prompts. Every candidate, including what originally happened, is judged
// blind: the API hides which model is which until the experiment is revealed.

export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    judgeModel: text("judge_model"),
    /** What "better" means for the judge; editable per experiment. */
    rubric: text("rubric"),
    revealedAt: ts("revealed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("experiments_project").on(t.projectId, t.createdAt)],
);

/** One captured decision under test, with the exact request it was made from. */
export const experimentItems = pgTable("experiment_items", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  runId: text("run_id").notNull(),
  /** Blob holding { messages, tools, params } as replayed. */
  requestHash: text("request_hash").notNull(),
  /** What the user asked, shown to voters as context. */
  context: jsonb("context").$type<{ request?: string; recent?: { role: string; text: string }[]; tools?: string[] }>(),
  seq: integer("seq").notNull().default(0),
});

export const experimentVariants = pgTable("experiment_variants", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  /** Blind label ("Candidate 2"), shuffled at creation so order gives nothing away. */
  alias: integer("alias").notNull(),
  /** "original" = what the agent actually did; "replay" = a re-run. */
  kind: text("kind").notNull(),
  model: text("model"),
  promptMode: text("prompt_mode"),
  systemPrompt: text("system_prompt"),
  temperature: doublePrecision("temperature"),
});

export const experimentTrials = pgTable(
  "experiment_trials",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => experimentItems.id, { onDelete: "cascade" }),
    variantId: text("variant_id").notNull().references(() => experimentVariants.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    output: jsonb("output").$type<{ text?: string; toolCalls?: { id?: string; name: string; input?: unknown }[] }>(),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("trials_item_variant").on(t.itemId, t.variantId)],
);

export const experimentVotes = pgTable(
  "experiment_votes",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => experimentItems.id, { onDelete: "cascade" }),
    /** The trial shown first ("A") and second ("B"). */
    trialA: text("trial_a").notNull(),
    trialB: text("trial_b").notNull(),
    winner: text("winner").notNull(),
    /** "human" or "judge:<model>". */
    judge: text("judge").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("votes_experiment").on(t.experimentId, t.judge)],
);

/**
 * Per transcript file: how many lines were already processed and the parser
 * state carried between uploads (current prompt, pending tool calls, …), so a
 * file can be streamed in chunks and re-sent without duplicating anything.
 */
export const transcriptCursors = pgTable(
  "transcript_cursors",
  {
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    harness: text("harness").notNull(),
    fileKey: text("file_key").notNull(),
    lineCount: integer("line_count").notNull().default(0),
    state: jsonb("state").$type<Record<string, unknown>>(),
    updatedAt: ts("updated_at").notNull().default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.harness, t.fileKey] })],
);
