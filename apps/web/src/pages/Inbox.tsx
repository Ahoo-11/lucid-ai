import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Copy, Loader2, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { type AppliedLesson, type Diagnosis, type Issue, api } from "../api";
import { ago, harnessLabel, plural } from "../format";
import { BRANDS, BrandMark } from "../landing/logos";
import { Card, Empty, cx } from "../ui";

/** Problems that hit more than one run are patterns worth fixing; the rest are listed separately. */
export const isRecurring = (issue: Issue) => issue.runs >= 2;

/** Enough runs without the failure to call a fix working. */
const FIXED_AFTER_RUNS = 3;

/** Where a problem stands: it decides the card's place, dot and pill. */
type Stage = "needs" | "still" | "diagnosing" | "sent" | "live" | "fixed" | "once";

function stageOf(issue: Issue): Stage {
  const state = outcome(issue.lesson);
  if (state === "fixed") return "fixed";
  if (state === "live") return "live";
  if (state === "waiting") return "sent";
  if (state === "recurring") return "still";
  if (!isRecurring(issue)) return "once";
  return issue.diagnosis?.status === "pending" ? "diagnosing" : "needs";
}

/** Recurring problems with no working fix yet: what the Inbox badge counts. */
export const needsFix = (issue: Issue) => ["needs", "still", "diagnosing"].includes(stageOf(issue));

const STAGE: Record<Stage, { dot: string; pill?: [label: string, className: string]; rank: number }> = {
  needs: { dot: "bg-rose-500", pill: ["Needs a fix", "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300"], rank: 0 },
  still: { dot: "bg-amber-500", pill: ["Still happening", "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"], rank: 0 },
  diagnosing: { dot: "animate-pulse bg-zinc-300 dark:bg-zinc-600", rank: 1 },
  sent: { dot: "bg-sky-500", pill: ["Fix sent", "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300"], rank: 2 },
  live: { dot: "bg-emerald-500", pill: ["Fix live", "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"], rank: 2 },
  fixed: { dot: "bg-emerald-500", pill: ["Fixed", "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"], rank: 3 },
  once: { dot: "bg-zinc-300 dark:bg-zinc-600", rank: 3 },
};

export function Inbox() {
  const query = useQuery({
    queryKey: ["issues"],
    queryFn: api.issues,
    // Soon again while a diagnosis runs, or while an agent hasn't picked up a lesson yet.
    refetchInterval: (q) =>
      q.state.data?.issues.some((issue) => issue.diagnosis?.status === "pending")
        ? 3_000
        : q.state.data?.issues.some((issue) => issue.lesson?.status === "active" && !issue.lesson.deliveredAt)
          ? 10_000
          : false,
  });
  // One card open at a time, and one folded list.
  const [open, setOpen] = useState<string | null>(null);
  const [fold, setFold] = useState<"fixed" | "once" | null>(null);
  const all = query.data?.issues ?? [];
  // What needs you first, then what's being diagnosed, then fixes being watched.
  const current = all.filter((issue) => STAGE[stageOf(issue)].rank < 3).sort((a, b) => STAGE[stageOf(a)].rank - STAGE[stageOf(b)].rank);
  const fixed = all.filter((issue) => stageOf(issue) === "fixed");
  const oneOffs = all.filter((issue) => stageOf(issue) === "once");
  const model = query.data?.diagnosisModel ?? null;
  const card = (issue: Issue) => (
    <IssueCard key={issue.id} issue={issue} model={model} open={open === issue.id} onToggle={() => setOpen(open === issue.id ? null : issue.id)} />
  );
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Problems your agents keep running into, and a fix you can approve.</p>
        {model && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {isMuse(model) && <BrandMark brand={BRANDS.meta} className="size-3.5" />}
            {isMuse(model) ? "Meta's Muse Spark" : model} diagnoses each recurring problem by itself, up to 20 a day.
          </p>
        )}
      </div>
      {query.isPending ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : current.length === 0 ? (
        <Card>
          <Empty icon={<CheckCircle2 className="size-8 text-emerald-500" />} title="Nothing to fix right now">
            When an agent keeps failing the same way, it shows up here with a fix. <Link to="/runs" className="text-brand-700 underline">See all runs</Link>.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-3">{current.map(card)}</div>
      )}
      {(fixed.length > 0 || oneOffs.length > 0) && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 text-sm text-zinc-500 dark:text-zinc-400">
            {fixed.length > 0 && <Fold label={`Fixed (${fixed.length})`} open={fold === "fixed"} onClick={() => setFold(fold === "fixed" ? null : "fixed")} />}
            {fixed.length > 0 && oneOffs.length > 0 && <span aria-hidden>·</span>}
            {oneOffs.length > 0 && <Fold label={`One-off errors (${oneOffs.length})`} open={fold === "once"} onClick={() => setFold(fold === "once" ? null : "once")} />}
          </div>
          {fold === "fixed" && fixed.map(card)}
          {fold === "once" && oneOffs.map(card)}
        </div>
      )}
    </div>
  );
}

function Fold({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open} className="inline-flex items-center gap-1 font-medium hover:text-zinc-900 dark:hover:text-zinc-100">
      <ChevronRight className={cx("size-4 transition", open && "rotate-90")} />
      {label}
    </button>
  );
}

const isMuse = (model: string) => /muse-spark/i.test(model);
/** "Muse Spark" for Meta's model, the model id otherwise. */
const modelLabel = (model: string) => (isMuse(model) ? "Muse Spark" : model);

type Outcome = "waiting" | "live" | "fixed" | "recurring";

/** Where an applied lesson stands: not picked up yet, live, working, or not working. */
function outcome(lesson: AppliedLesson | null): Outcome | null {
  if (!lesson || lesson.status !== "active") return null;
  if (!lesson.deliveredAt) return "waiting";
  if ((lesson.failuresSince ?? 0) > 0) return "recurring";
  return (lesson.runsSince ?? 0) >= FIXED_AFTER_RUNS ? "fixed" : "live";
}

/** The card's one line under the headline: what it means for you, or how the fix is doing. */
function summaryOf(issue: Issue, stage: Stage, model: string | null): ReactNode {
  const agent = harnessLabel(issue.lesson?.harness ?? issue.harness);
  const runs = issue.lesson?.runsSince ?? 0;
  const failures = issue.lesson?.failuresSince ?? 0;
  const ai = issue.diagnosis?.status === "ready" ? issue.diagnosis : null;
  switch (stage) {
    case "still":
      return `The fix didn't stop it: ${plural(failures, "failure")} in ${plural(runs, "run")} since it went live.`;
    case "sent":
      return `Fix sent. Waiting for ${agent} to pick it up.`;
    case "live":
      return runs ? `The fix is live in ${agent}: no failures in ${plural(runs, "run")} so far.` : `The fix is live in ${agent}. Results show after its next runs.`;
    case "fixed":
      return `Working: no failures in ${plural(runs, "run")} since the fix went live.`;
    default:
      if (issue.diagnosis?.status === "pending") {
        return (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" />
            {model ? modelLabel(model) : "Lucid"} is looking into this…
          </span>
        );
      }
      return ai?.summary ?? (ai ?? issue).why;
  }
}

function IssueCard({ issue, model, open, onToggle }: { issue: Issue; model: string | null; open: boolean; onToggle: () => void }) {
  // The model's diagnosis once there is one; Lucid's rule of thumb until then.
  const ai = issue.diagnosis?.status === "ready" ? issue.diagnosis : null;
  const stage = stageOf(issue);
  const { dot, pill } = STAGE[stage];
  const watching = issue.lesson?.status === "active" && issue.lesson.deliveredAt;
  // Without a summary from the model the card's line is already "what happened"; don't say it twice.
  const whyOnCard = (stage === "needs" || stage === "once") && issue.diagnosis?.status !== "pending" && !ai?.summary;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", dot)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-semibold">{(ai ?? issue).title}</h2>
            {pill && <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", pill[1])}>{pill[0]}</span>}
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{summaryOf(issue, stage, model)}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {harnessLabel(issue.harness)} · {plural(issue.runs, "run")}
              {watching ? ` · fix live ${ago(issue.lesson!.deliveredAt)}` : issue.lastSeen && ` · last ${ago(issue.lastSeen)}`}
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="rounded-full px-3 py-1 text-xs font-medium ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:ring-white/15 dark:hover:bg-white/5"
            >
              {open ? "Hide" : stage === "needs" || stage === "still" || stage === "once" ? "See details and fix" : "Details"}
            </button>
          </div>
          {open && <Details issue={issue} model={model} whyOnCard={whyOnCard} />}
        </div>
      </div>
    </Card>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      {children}
    </div>
  );
}

const BOX = "rounded-lg bg-zinc-50 px-3 py-2.5 text-sm leading-relaxed ring-1 ring-zinc-200/70 dark:bg-white/[0.03] dark:ring-white/10";

/** The opened card: what happened, the fix to approve, what only you can change, and where it came from. */
function Details({ issue, model, whyOnCard }: { issue: Issue; model: string | null; whyOnCard: boolean }) {
  const [raw, setRaw] = useState(false);
  const ai = issue.diagnosis?.status === "ready" ? issue.diagnosis : null;
  const agent = harnessLabel(issue.harness);
  return (
    <div className="mt-4 space-y-4 border-t border-zinc-100 pt-4 dark:border-white/10">
      {!whyOnCard && (
        <Section label="What happened">
          <div className={BOX}>{(ai ?? issue).why}</div>
        </Section>
      )}
      {issue.lesson?.status === "active" ? (
        <Section label={`Fix for ${harnessLabel(issue.lesson.harness)}`}>
          <ActiveLesson lesson={issue.lesson} />
        </Section>
      ) : ai?.lesson ? (
        <Section label={`Fix for ${agent}`}>
          <LessonEditor key={`${ai.at}${issue.lesson?.id ?? ""}`} issue={issue} proposed={ai.lesson} />
        </Section>
      ) : issue.lesson ? (
        <Section label={`Fix for ${agent} (turned off)`}>
          <LessonEditor key={issue.lesson.id} issue={issue} proposed={issue.lesson.text} turnedOff />
        </Section>
      ) : (
        <Section label="How to fix it">
          <div className={BOX}>{(ai ?? issue).fix}</div>
        </Section>
      )}
      {ai?.manual && (
        <Section label="Do this yourself">
          <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            {ai.manual} <span className="text-amber-700 dark:text-amber-300/80">Lucid never changes settings or permissions.</span>
          </div>
        </Section>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
        {model && <DiagnoseRow issue={issue} diagnosis={issue.diagnosis} model={model} />}
        <button type="button" onClick={() => setRaw(!raw)} aria-expanded={raw} className="inline-flex items-center gap-0.5 font-medium hover:text-zinc-900 dark:hover:text-white">
          <ChevronRight className={cx("size-3.5 transition", raw && "rotate-90")} />
          Error and runs
        </button>
      </div>
      {raw && <ErrorAndRuns issue={issue} />}
    </div>
  );
}

/** The lesson Muse Spark proposed, editable, applied only when the owner says so. */
function LessonEditor({ issue, proposed, turnedOff }: { issue: Issue; proposed: string; turnedOff?: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(proposed);
  const [copied, setCopied] = useState(false);
  const agent = harnessLabel(issue.harness);
  const apply = useMutation({
    mutationFn: () => api.applyLesson(issue.id, text),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  return (
    <div className="space-y-2.5 rounded-lg bg-white p-3 ring-1 ring-emerald-300/70 dark:bg-zinc-950 dark:ring-emerald-400/25">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        maxLength={400}
        aria-label={`Lesson for ${agent}`}
        className="w-full resize-y rounded-md bg-transparent text-sm leading-relaxed outline-none"
      />
      {apply.isError && <p className="text-xs text-rose-600 dark:text-rose-400">{apply.error.message}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {issue.lessonsApply ? (
          <>
            <button
              type="button"
              onClick={() => apply.mutate()}
              disabled={apply.isPending || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-300 px-3.5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-brand-200 disabled:opacity-50"
            >
              {apply.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {turnedOff ? `Apply to ${agent} again` : `Apply to ${agent}`}
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{agent} follows it from its next turn. Turn it off any time.</span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-zinc-200 hover:bg-zinc-50 dark:ring-white/15 dark:hover:bg-white/5"
            >
              <Copy className="size-3.5" />
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Paste it into {agent}'s instructions. Lucid can't apply it there by itself yet.</span>
          </>
        )}
      </div>
    </div>
  );
}

/** An applied lesson: is the agent using it, and is the failure gone? */
function ActiveLesson({ lesson }: { lesson: AppliedLesson }) {
  const queryClient = useQueryClient();
  const agent = harnessLabel(lesson.harness);
  const turnOff = useMutation({
    mutationFn: () => api.setLesson(lesson.id, false),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  const state = outcome(lesson);
  const failures = lesson.failuresSince ?? 0;
  const runs = lesson.runsSince ?? 0;
  const status: Record<Outcome, ReactNode> = {
    waiting: (
      <span className="text-zinc-500 dark:text-zinc-400">
        <Loader2 className="mr-1 inline size-3.5 animate-spin" />
        Waiting for {agent} to pick it up (within a minute). This needs Lucid plugin 0.4 or newer:{" "}
        <Link to="/connect" className="font-medium text-zinc-700 underline underline-offset-2 dark:text-zinc-200">
          check and update it
        </Link>
        .
      </span>
    ),
    live: (
      <span className="text-zinc-600 dark:text-zinc-300">
        Live in {agent} since {ago(lesson.deliveredAt)}. {runs ? `No failures in ${plural(runs, "run")} so far.` : "Results show after its next runs."}
      </span>
    ),
    fixed: (
      <span className="font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="mr-1 inline size-3.5" />
        Working: no failures in {plural(runs, "run")} since it went live {ago(lesson.deliveredAt)}.
      </span>
    ),
    recurring: (
      <span className="text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mr-1 inline size-3.5" />
        Still happening: {plural(failures, "failure")} in {plural(runs, "run")} since it went live. Turn it off and diagnose again.
      </span>
    ),
  };
  return (
    <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-emerald-300/70 dark:bg-zinc-950 dark:ring-emerald-400/25">
      <p className="text-sm">“{lesson.text}”</p>
      <div className="flex items-start justify-between gap-3 text-xs">
        {state && <p>{status[state]}</p>}
        <button
          type="button"
          onClick={() => turnOff.mutate()}
          disabled={turnOff.isPending}
          className="shrink-0 font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-400 dark:hover:text-white"
        >
          Turn off
        </button>
      </div>
    </div>
  );
}

/** "1,730 tokens · 3.5 s": what one diagnosis cost, with the in/out split on hover. */
function costLine(d: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null }) {
  const tokens = d.inputTokens != null && d.outputTokens != null ? d.inputTokens + d.outputTokens : null;
  const text = [tokens != null && `${tokens.toLocaleString()} tokens`, d.latencyMs != null && `${(d.latencyMs / 1000).toFixed(1)} s`].filter(Boolean).join(" · ");
  const title = tokens != null ? `${d.inputTokens!.toLocaleString()} in, ${d.outputTokens!.toLocaleString()} out` : undefined;
  return { text, title };
}

/** Who diagnosed it and what it cost, or the button to ask for one. */
function DiagnoseRow({ issue, diagnosis: d, model }: { issue: Issue; diagnosis: Diagnosis | null; model: string }) {
  const queryClient = useQueryClient();
  const diagnose = useMutation({
    mutationFn: () => api.diagnose(issue.id),
    // Show it as running at once, so "Run again" doesn't flash the old one.
    onSuccess: ({ diagnosis }) =>
      queryClient.setQueryData<{ issues: Issue[] }>(["issues"], (old) => old && { ...old, issues: old.issues.map((i) => (i.id === issue.id ? { ...i, diagnosis } : i)) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  const name = modelLabel(model);
  const logo = isMuse(model) && <BrandMark brand={BRANDS.meta} className="size-3.5" />;
  const link = (label: string) => (
    <button type="button" onClick={() => diagnose.mutate()} className="font-medium underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-white">
      {label}
    </button>
  );

  if (diagnose.isPending || d?.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" />
        {name} is reading the failed steps…
      </span>
    );
  }
  if (diagnose.isError) {
    return (
      <>
        <span className="text-rose-600 dark:text-rose-400">{diagnose.error.message}</span>
        {link("Try again")}
      </>
    );
  }
  if (d?.status === "ready") {
    const cost = costLine(d);
    return (
      <>
        <span className="inline-flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-200">
          {logo}
          Diagnosed by {modelLabel(d.model)}
        </span>
        {cost.text && (
          <span className="tabular-nums" title={cost.title}>
            {cost.text}
          </span>
        )}
        {link("Run again")}
      </>
    );
  }
  if (d?.status === "failed") {
    return (
      <>
        <span className="text-rose-600 dark:text-rose-400" title={d.error}>
          Couldn't diagnose: {d.error.length > 90 ? `${d.error.slice(0, 89)}…` : d.error}
        </span>
        {link("Try again")}
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={() => diagnose.mutate()}
      className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 font-medium text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-transparent dark:text-zinc-200 dark:ring-white/15 dark:hover:bg-white/5"
    >
      {logo}
      Diagnose with {name}
    </button>
  );
}

/** The raw error and example runs: for digging, not deciding. */
function ErrorAndRuns({ issue }: { issue: Issue }) {
  return (
    <div className="space-y-2 text-xs">
      {issue.sample && (
        <pre className="rounded-lg bg-zinc-50 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-600 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-400">
          {issue.sample.split("\n").slice(0, 6).join("\n")}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">
          {issue.toolName ? `${issue.toolName}, ` : ""}
          {plural(issue.occurrences, "time")} in:
        </span>
        {issue.examples.map((example) => (
          <Link key={example.runId} to={`/runs/${example.runId}`} className="max-w-64 truncate rounded-md bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
            {example.runName ?? "Run"}
          </Link>
        ))}
      </div>
    </div>
  );
}
