import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Copy, Loader2, ShieldAlert, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { type AppliedLesson, type Diagnosis, type Issue, api } from "../api";
import { ago, harnessLabel, plural } from "../format";
import { BRANDS, BrandMark } from "../landing/logos";
import { Card, Empty, KindIcon, cx } from "../ui";

/** Problems that hit more than one run are patterns worth fixing; the rest are listed separately. */
export const isRecurring = (issue: Issue) => issue.runs >= 2;

/** Enough runs without the failure to call a fix working. */
const FIXED_AFTER_RUNS = 3;

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
  const [showOneOffs, setShowOneOffs] = useState(false);
  const all = query.data?.issues ?? [];
  const issues = all.filter(isRecurring);
  const oneOffs = all.filter((issue) => !isRecurring(issue));
  const model = query.data?.diagnosisModel ?? null;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">What's going wrong, grouped by cause, most runs first. Diagnose one, approve the fix, and watch it stop.</p>
        {model && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {isMuse(model) && <BrandMark brand={BRANDS.meta} className="size-3.5" />}
            Diagnoses by {isMuse(model) ? "Meta's Muse Spark" : model}, only when you press Diagnose.
          </p>
        )}
      </div>
      {query.isPending ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : issues.length === 0 ? (
        <Card>
          <Empty icon={<CheckCircle2 className="size-8 text-emerald-500" />} title="Nothing to fix right now">
            Failed tool calls, API errors and blocked actions show up here, grouped by cause, with a suggested fix. <Link to="/runs" className="text-brand-700 underline">See all runs</Link>.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} model={model} />
          ))}
        </div>
      )}
      {oneOffs.length > 0 && (
        <div className="space-y-3">
          <button type="button" onClick={() => setShowOneOffs(!showOneOffs)} className="inline-flex items-center gap-1 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            {showOneOffs ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            {plural(oneOffs.length, "one-off error")} (seen in a single run)
          </button>
          {showOneOffs && (
            <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {oneOffs.map((issue) => (
                <Link key={issue.id} to={`/runs/${issue.examples[0]?.runId}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <KindIcon kind={issue.kind} failed size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{issue.title}</span>
                    <span className="ml-2 font-mono text-xs text-zinc-500">{issue.signature}</span>
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">{ago(issue.lastSeen)}</span>
                </Link>
              ))}
            </Card>
          )}
        </div>
      )}
    </div>
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

const OUTCOME_PILL: Record<Outcome, { label: string; className: string }> = {
  waiting: { label: "Fix applied", className: "bg-brand-100 text-brand-800 dark:bg-brand-300/15 dark:text-brand-200" },
  live: { label: "Fix live", className: "bg-brand-100 text-brand-800 dark:bg-brand-300/15 dark:text-brand-200" },
  fixed: { label: "Fixed", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  recurring: { label: "Still happening", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
};

function IssueCard({ issue, model }: { issue: Issue; model: string | null }) {
  // The model's diagnosis once someone asked for it; Lucid's rule of thumb until then.
  const ai = issue.diagnosis?.status === "ready" ? issue.diagnosis : null;
  const shown = ai ?? issue;
  const state = outcome(issue.lesson);
  return (
    <Card className={cx("p-4", state === "fixed" && "opacity-80")}>
      <div className="flex items-start gap-3">
        <KindIcon kind={issue.kind} failed={state !== "fixed"} />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="min-w-0">
              <h2 className="font-semibold">{shown.title}</h2>
              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {harnessLabel(issue.harness)}
                {issue.toolName && <> · {issue.toolName}</>} · <span className="font-medium text-zinc-700 dark:text-zinc-300">{plural(issue.runs, "run")}</span> ·{" "}
                {plural(issue.occurrences, "time")} · last {ago(issue.lastSeen)}
              </div>
            </div>
            {state && <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", OUTCOME_PILL[state].className)}>{OUTCOME_PILL[state].label}</span>}
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{shown.why}</p>
          <FixPanel issue={issue} model={model} />
          <Details issue={issue} />
        </div>
      </div>
    </Card>
  );
}

/** The fix: diagnose, approve a lesson, then see whether it worked. */
function FixPanel({ issue, model }: { issue: Issue; model: string | null }) {
  const d = issue.diagnosis;
  const ai = d?.status === "ready" ? d : null;
  return (
    <div className="space-y-3 rounded-xl bg-zinc-50 p-3.5 ring-1 ring-zinc-200/70 dark:bg-white/[0.03] dark:ring-white/10">
      <div className="flex gap-2 text-sm">
        <Wrench className="mt-0.5 size-4 shrink-0 text-zinc-400" />
        <div>
          <span className="font-medium">Fix: </span>
          {(ai ?? issue).fix}
        </div>
      </div>
      {issue.lesson?.status === "active" ? (
        <ActiveLesson issue={issue} lesson={issue.lesson} />
      ) : ai?.lesson ? (
        <LessonEditor key={`${ai.at}${issue.lesson?.id ?? ""}`} issue={issue} proposed={ai.lesson} />
      ) : issue.lesson ? (
        <LessonEditor key={issue.lesson.id} issue={issue} proposed={issue.lesson.text} turnedOff />
      ) : null}
      {ai?.manual && (
        <div className="flex gap-2 rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <span className="font-medium">Do this yourself if you want it: </span>
            {ai.manual} <span className="text-amber-700 dark:text-amber-300/80">Lucid never changes settings or permissions.</span>
          </div>
        </div>
      )}
      {model && <DiagnoseRow issue={issue} diagnosis={d} model={model} />}
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
    <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-white/10">
      <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        <Sparkles className="size-3.5" />
        {turnedOff ? `Lesson for ${agent} (turned off)` : `Lesson for ${agent}`}
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        maxLength={400}
        aria-label="Lesson"
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
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {agent} adds it to every turn from its next one. Nothing on its machine changes; turn it off any time.
            </span>
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
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Add it to {agent}'s instructions. Lucid can't apply lessons in {agent} by itself yet.</span>
          </>
        )}
      </div>
    </div>
  );
}

/** An applied lesson: is the agent using it, and is the failure gone? */
function ActiveLesson({ issue, lesson }: { issue: Issue; lesson: AppliedLesson }) {
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
        Waiting for {agent} to pick it up (within a minute). Lessons need Lucid plugin 0.4 or newer:{" "}
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
        Still happening: {plural(failures, "failure")} in {plural(runs, "run")} since it went live. Edit the lesson or diagnose again.
      </span>
    ),
  };
  return (
    <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-brand-300/60 dark:bg-zinc-950 dark:ring-brand-300/30">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-brand-700 uppercase dark:text-brand-300">
          <Sparkles className="size-3.5" />
          Lesson applied to {agent}
        </div>
        <button
          type="button"
          onClick={() => turnOff.mutate()}
          disabled={turnOff.isPending}
          className="text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-400 dark:hover:text-white"
        >
          Turn off
        </button>
      </div>
      <p className="text-sm">“{lesson.text}”</p>
      {state && <p className="text-xs">{status[state]}</p>}
    </div>
  );
}

/** "1,240 in · 310 out tokens · 3.1 s": what one diagnosis cost, for tuning it. */
function costLine(d: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null }) {
  const parts = [
    d.inputTokens != null && d.outputTokens != null && `${d.inputTokens.toLocaleString()} in · ${d.outputTokens.toLocaleString()} out tokens`,
    d.latencyMs != null && `${(d.latencyMs / 1000).toFixed(1)} s`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The Diagnose button and what came of it. Diagnoses spend credits, so they run only on a click. */
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
  const ask = (label: string) => (
    <button
      type="button"
      onClick={() => diagnose.mutate()}
      className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-transparent dark:ring-white/15 dark:hover:bg-white/5"
    >
      {logo}
      {label}
    </button>
  );

  if (diagnose.isPending || d?.status === "pending") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <Loader2 className="size-3 animate-spin" />
        {name} is reading the failed steps…
      </div>
    );
  }
  if (diagnose.isError) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-rose-600 dark:text-rose-400">{diagnose.error.message}</span>
        {ask("Try again")}
      </div>
    );
  }
  if (d?.status === "ready") {
    const cost = costLine(d);
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1.5 font-medium text-sky-700 dark:text-sky-300">
          {logo}
          Diagnosed by {modelLabel(d.model)}
        </span>
        {cost && (
          <span className="tabular-nums" title="What this diagnosis cost">
            {cost}
          </span>
        )}
        <button type="button" onClick={() => diagnose.mutate()} className="font-medium underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-white">
          Run again
        </button>
      </div>
    );
  }
  if (d?.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-rose-600 dark:text-rose-400" title={d.error}>
          Couldn't diagnose: {d.error.length > 90 ? `${d.error.slice(0, 89)}…` : d.error}
        </span>
        {ask("Try again")}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      {ask(`Diagnose with ${name}`)}
      <span>to get the cause and a lesson you can apply.</span>
    </div>
  );
}

/** The raw error and example runs, folded away: they're for digging, not deciding. */
function Details({ issue }: { issue: Issue }) {
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition group-open:rotate-90" />
        Error and runs
      </summary>
      <div className="mt-2 space-y-2">
        {issue.sample && (
          <pre className="rounded-lg bg-zinc-50 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-600 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-400">
            {issue.sample.split("\n").slice(0, 6).join("\n")}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-500">Seen in:</span>
          {issue.examples.map((example) => (
            <Link key={example.runId} to={`/runs/${example.runId}`} className="max-w-64 truncate rounded-md bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
              {example.runName ?? "Run"}
            </Link>
          ))}
        </div>
      </div>
    </details>
  );
}
