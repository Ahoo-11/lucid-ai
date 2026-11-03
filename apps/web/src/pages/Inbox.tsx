import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  EyeOff,
  FileText,
  FlaskConical,
  Globe,
  Info,
  Loader2,
  Pencil,
  Plug,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  UserRound,
  Wrench,
  Repeat,
  TrendingUp,
  Ban,
  MessageSquareWarning,
} from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { type AppliedLesson, type Diagnosis, type FixTest, type Issue, type ProblemKind, api } from "../api";
import { ago, harnessLabel, plural } from "../format";
import { BRANDS, BrandMark } from "../landing/logos";
import { BUTTON, CopyButton, Empty, LABEL, PageHeader, SURFACE, TabBar, TabItem, cx } from "../ui";

/** Problems that hit more than one run are patterns worth fixing; the rest are listed separately. */
export const isRecurring = (issue: Issue) => issue.runs >= 2;

/** Enough runs without the failure to call a fix working. */
const FIXED_AFTER_RUNS = 3;

/** Where a problem stands: it decides the list it's in, its pill and its place. */
type Stage = "needs" | "still" | "diagnosing" | "sent" | "live" | "fixed" | "once" | "ignored";

function stageOf(issue: Issue): Stage {
  if (issue.ignored) return "ignored";
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

type Tone = "rose" | "amber" | "sky" | "emerald" | "zinc";

const PILL: Record<Tone, string> = {
  rose: "bg-rose-50 text-rose-700 ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
  sky: "bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  zinc: "bg-zinc-100 text-zinc-600 ring-zinc-500/10 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-white/10",
};

const STAGE: Record<Stage, { label: string; tone: Tone; rank: number }> = {
  still: { label: "Still happening", tone: "amber", rank: 0 },
  needs: { label: "Needs a fix", tone: "rose", rank: 1 },
  diagnosing: { label: "Diagnosing", tone: "zinc", rank: 2 },
  sent: { label: "Fix sent", tone: "sky", rank: 0 },
  live: { label: "Fix live", tone: "emerald", rank: 1 },
  fixed: { label: "Fixed", tone: "emerald", rank: 0 },
  once: { label: "One-off", tone: "zinc", rank: 0 },
  ignored: { label: "Ignored", tone: "zinc", rank: 0 },
};

/** The Inbox's lists: the three tiles at the top, and the two links under the list. */
type View = "needs" | "fixing" | "fixed" | "once" | "ignored";

const VIEW_OF: Record<Stage, View> = { needs: "needs", still: "needs", diagnosing: "needs", sent: "fixing", live: "fixing", fixed: "fixed", once: "once", ignored: "ignored" };

/** A card's pill only when it says more than the list it's in: no "Needs a fix" on every card under Need a fix. */
const SAYS_MORE = (stage: Stage) => !(["needs", "fixed", "once", "ignored"] as Stage[]).includes(stage);

const TILES: { view: View; label: string; dot: string }[] = [
  { view: "needs", label: "Need a fix", dot: "bg-rose-500" },
  { view: "fixing", label: "Being fixed", dot: "bg-sky-500" },
  { view: "fixed", label: "Fixed", dot: "bg-emerald-500" },
];

const EMPTY: Record<View, [title: string, text: string]> = {
  needs: ["Nothing needs a fix", "When an agent keeps failing the same way, it shows up here with a fix you can approve."],
  fixing: ["No fixes being tried", "Approve a fix and Lucid watches whether the problem stops."],
  fixed: ["Nothing fixed yet", `A fix lands here once the agent runs ${FIXED_AFTER_RUNS} times without the problem.`],
  once: ["No one-off problems", "Problems that happened in a single run show up here."],
  ignored: ["Nothing ignored", "Problems you ignore wait here, in case you want them back."],
};

const WIDE = "(min-width: 1024px)";

/** Side by side on a wide screen; on a phone the problem opens over the list. */
function useWide() {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(WIDE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => matchMedia(WIDE).matches,
  );
}

export function Inbox() {
  const query = useQuery({
    queryKey: ["issues"],
    queryFn: api.issues,
    // Soon again while a diagnosis or a fix test runs, or while an agent hasn't picked up a lesson yet.
    refetchInterval: (q) =>
      q.state.data?.issues.some((issue) => issue.diagnosis?.status === "pending" || issue.fixTest?.status === "running")
        ? 3_000
        : q.state.data?.issues.some((issue) => issue.lesson?.status === "active" && !issue.lesson.deliveredAt)
          ? 10_000
          : false,
  });
  const wide = useWide();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const view: View = (Object.keys(EMPTY) as View[]).find((v) => v === params.get("view")) ?? "needs";
  const all = query.data?.issues ?? [];
  const model = query.data?.diagnosisModel ?? null;
  const count = (v: View) => all.filter((issue) => VIEW_OF[stageOf(issue)] === v).length;
  // Server order is most runs first; within a list, what needs you comes first.
  const shown = all.filter((issue) => VIEW_OF[stageOf(issue)] === view).sort((a, b) => STAGE[stageOf(a)].rank - STAGE[stageOf(b)].rank);
  const picked = params.get("problem");
  const selected = all.find((issue) => issue.id === picked) ?? (wide ? shown[0] : undefined);

  const update = (change: (next: URLSearchParams) => void, sheet = false) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        change(next);
        return next;
      },
      // On a phone, opening a problem is a step Back undoes.
      { replace: !sheet, state: sheet ? { sheet: true } : undefined },
    );
  const select = (id: string | null) => update((next) => (id ? next.set("problem", id) : next.delete("problem")), !wide && !!id);
  const showView = (v: View) =>
    update((next) => {
      if (v === "needs") next.delete("view");
      else next.set("view", v);
      next.delete("problem");
    });
  const close = () => ((location.state as { sheet?: boolean } | null)?.sheet ? navigate(-1) : select(null));
  // Ignoring one moves on to the next problem in the list.
  const afterIgnore = (id: string) => {
    const at = shown.findIndex((issue) => issue.id === id);
    select(wide ? (shown[at + 1]?.id ?? shown[at - 1]?.id ?? null) : null);
  };

  // On a wide screen the first problem is open from the start, and stays put when it changes list.
  useEffect(() => {
    if (wide && !picked && shown[0]) select(shown[0].id);
  });
  // The open problem covers the page on a phone; the page behind it shouldn't scroll.
  const sheet = !wide && !!selected;
  useEffect(() => {
    if (!sheet) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sheet]);

  const panel = selected && (
    <ProblemPanel
      // A new diagnosis, lesson or finished test starts the fix over from its words.
      key={`${selected.id}:${selected.diagnosis?.status === "ready" ? selected.diagnosis.at : ""}:${selected.lesson?.id ?? ""}:${selected.lesson?.status ?? ""}:${selected.fixTest?.status === "running" ? "" : (selected.fixTest?.at ?? "")}`}
      issue={selected}
      model={model}
      onClose={wide ? undefined : close}
      onIgnored={() => afterIgnore(selected.id)}
    />
  );

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-start lg:gap-8 xl:grid-cols-[29rem_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <PageHeader title="Inbox" sub="Problems your agents keep running into, and fixes you can approve.">
          {model && query.data && <AutoDiagnose model={model} on={query.data.autoDiagnose} />}
        </PageHeader>

        <div className="grid grid-cols-3 gap-3">
          {TILES.map((tile) => (
            <button
              key={tile.view}
              type="button"
              onClick={() => showView(tile.view)}
              aria-pressed={view === tile.view}
              className={cx(
                SURFACE,
                "px-3 py-3.5 text-left transition-colors sm:px-4",
                view === tile.view
                  ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-200 dark:ring-zinc-200"
                  : "hover:border-zinc-300 dark:hover:border-white/20",
              )}
            >
              <span className="block font-display text-[1.75rem] leading-none font-bold tabular-nums">{query.isPending ? "–" : count(tile.view)}</span>
              <span className="mt-2.5 flex items-baseline gap-1.5 text-xs leading-tight font-medium text-zinc-500 dark:text-zinc-400">
                <span className={cx("size-1.5 shrink-0 -translate-y-px rounded-full", tile.dot)} aria-hidden />
                <span>{tile.label}</span>
              </span>
            </button>
          ))}
        </div>

        {view === "once" || view === "ignored" ? (
          <button type="button" onClick={() => showView("needs")} className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">
            <ArrowLeft className="size-4" />
            {view === "once" ? "One-off problems" : "Ignored problems"}
          </button>
        ) : null}

        {query.isPending ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : shown.length === 0 ? (
          <div className={SURFACE}>
            <Empty icon={<CheckCircle2 className="size-7 text-emerald-500" />} title={EMPTY[view][0]}>
              {EMPTY[view][1]}{" "}
              {view === "needs" && (
                <Link to="/runs" className="font-medium text-zinc-700 underline underline-offset-2 dark:text-zinc-200">
                  See all runs
                </Link>
              )}
            </Empty>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {shown.map((issue) => (
              <li key={issue.id}>
                <ProblemCard issue={issue} model={model} selected={selected?.id === issue.id} onSelect={() => select(issue.id)} />
              </li>
            ))}
          </ul>
        )}

        {(view === "needs" || view === "fixing" || view === "fixed") && (count("once") > 0 || count("ignored") > 0) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-sm text-zinc-500 dark:text-zinc-400">
            {count("once") > 0 && <MoreLink label={`One-off problems (${count("once")})`} onClick={() => showView("once")} />}
            {count("ignored") > 0 && <MoreLink label={`Ignored (${count("ignored")})`} onClick={() => showView("ignored")} />}
          </div>
        )}
      </div>

      {wide ? (
        <aside className="sticky top-24 h-[calc(100dvh-7.5rem)] min-w-0">
          {panel || (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-white/15 dark:text-zinc-400">
              When a problem shows up, what happened and the fix open here.
            </div>
          )}
        </aside>
      ) : (
        panel && (
          <div role="dialog" aria-modal="true" aria-label="Problem" className="fixed inset-0 z-30 bg-white motion-safe:animate-[rise_.18s_ease-out] dark:bg-zinc-900">
            {panel}
          </div>
        )
      )}
    </div>
  );
}

function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-0.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100">
      {label}
      <ChevronRight className="size-4" />
    </button>
  );
}

/** The switch for diagnosing recurring problems without a click. */
function AutoDiagnose({ model, on }: { model: string; on: boolean }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setAutoDiagnose(next),
    onSuccess: ({ autoDiagnose }) => queryClient.setQueryData<{ autoDiagnose: boolean }>(["issues"], (old) => old && { ...old, autoDiagnose }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  const value = toggle.isPending ? toggle.variables : on;
  return (
    <label
      className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300"
      title={`${modelLabel(model)} diagnoses each recurring problem by itself (up to 20 a day), and checks runs that may have given up or answered wrong (up to 30 a day). Off: only when you click.`}
    >
      {isMuse(model) && <BrandMark brand={BRANDS.meta} className="size-4" />}
      <span>
        Auto-diagnose<span className="hidden sm:inline"> with {modelLabel(model)}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={`Auto-diagnose with ${modelLabel(model)}`}
        onClick={() => toggle.mutate(!value)}
        className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", value ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-300 dark:bg-zinc-700")}
      >
        <span className={cx("size-4 rounded-full transition-transform", value ? "translate-x-[18px] bg-white dark:bg-zinc-900" : "translate-x-0.5 bg-white dark:bg-zinc-300")} />
      </button>
    </label>
  );
}

function Pill({ stage }: { stage: Stage }) {
  const { label, tone } = STAGE[stage];
  return <span className={cx("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset", PILL[tone])}>{label}</span>;
}

/** The problems no step reports, in a word: on cards before the agent's name, and in the panel. */
const PROBLEM_LABEL: Record<Exclude<ProblemKind, "error">, string> = { loop: "Loop", cost: "Cost spike", refusal: "Gave up", wrong_answer: "Wrong answer" };

/** How Lucid finds each of them, for the Evidence tab. */
const FOUND_HOW: Record<Exclude<ProblemKind, "error">, string> = {
  loop: "Lucid looks for the same call, with the same input, made three or more times with the same result.",
  cost: "Lucid compares each run with what that agent's runs usually cost: three times the usual or more is a spike.",
  refusal: "Runs that end with the agent refusing or giving up are checked by Muse Spark, which decides whether it could have done the task.",
  wrong_answer: "Runs that answered despite failed steps, and a few spot checks, are read by Muse Spark against what the tools returned.",
};

/** A picture of what went wrong: a loop, a cost spike, a refusal, a wrong answer, or where it broke. */
function iconFor(issue: Issue) {
  if (issue.problem === "loop") return Repeat;
  if (issue.problem === "cost") return TrendingUp;
  if (issue.problem === "refusal") return Ban;
  if (issue.problem === "wrong_answer") return MessageSquareWarning;
  const tool = (issue.toolName ?? "").toLowerCase();
  if (issue.kind === "llm") return Sparkles;
  if (tool.startsWith("mcp__")) return Plug;
  if (/web|fetch|browser|http|url|navigate/.test(tool)) return Globe;
  if (/bash|shell|terminal|exec|command|code|run/.test(tool)) return SquareTerminal;
  if (/read|write|edit|file|glob|grep|patch|notebook|search/.test(tool)) return FileText;
  if (/agent|task|delegate/.test(tool)) return Bot;
  return Wrench;
}

function ProblemIcon({ issue, large }: { issue: Issue; large?: boolean }) {
  const Icon = iconFor(issue);
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300", large ? "size-11" : "size-9")} aria-hidden>
      <Icon className={large ? "size-5" : "size-[18px]"} />
    </span>
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

const readyDiagnosis = (issue: Issue) => (issue.diagnosis?.status === "ready" ? issue.diagnosis : null);

/** The card's line under the headline: what it means for you, or how the fix is doing. */
function summaryOf(issue: Issue, stage: Stage, model: string | null): ReactNode {
  const agent = harnessLabel(issue.lesson?.harness ?? issue.harness);
  const runs = issue.lesson?.runsSince ?? 0;
  const failures = issue.lesson?.failuresSince ?? 0;
  const ai = readyDiagnosis(issue);
  switch (stage) {
    case "still":
      return `The fix didn't stop it: ${plural(failures, "failure")} in ${plural(runs, "run")} since it went live.`;
    case "sent":
      return `Waiting for ${agent} to pick up the fix.`;
    case "live":
      return runs ? `No failures in ${plural(runs, "run")} since the fix went live.` : `The fix is live in ${agent}. Results show after its next runs.`;
    case "fixed":
      return `No failures in ${plural(runs, "run")} since the fix went live.`;
    case "diagnosing":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" />
          {model ? modelLabel(model) : "Lucid"} is looking into this…
        </span>
      );
    default:
      return ai?.summary ?? (ai ?? issue).why;
  }
}

function ProblemCard({ issue, model, selected, onSelect }: { issue: Issue; model: string | null; selected: boolean; onSelect: () => void }) {
  const stage = stageOf(issue);
  const ai = readyDiagnosis(issue);
  const watching = issue.lesson?.status === "active" && issue.lesson.deliveredAt;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cx(
        SURFACE,
        "flex w-full items-start gap-3.5 p-4 text-left transition-colors",
        selected ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-200 dark:ring-zinc-200" : "hover:border-zinc-300 dark:hover:border-white/20",
      )}
    >
      <ProblemIcon issue={issue} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          <span className="pt-0.5 text-[15px] leading-snug font-semibold">{(ai ?? issue).title}</span>
          {SAYS_MORE(stage) && <Pill stage={stage} />}
        </span>
        <span className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{summaryOf(issue, stage, model)}</span>
        <span className="mt-2.5 block text-xs text-zinc-400 dark:text-zinc-500">
          {issue.problem !== "error" && `${PROBLEM_LABEL[issue.problem]} · `}
          {harnessLabel(issue.harness)} · {plural(issue.runs, "run")}
          {watching ? ` · fix live ${ago(issue.lesson!.deliveredAt)}` : issue.lastSeen && ` · ${ago(issue.lastSeen)}`}
        </span>
      </span>
    </button>
  );
}

const { primary: PRIMARY, secondary: SECONDARY, quiet: QUIET } = BUTTON;

type Tab = "diagnosis" | "runs" | "error";

/** One problem, opened: what happened and the fix, the runs it hit, and the raw error. */
function ProblemPanel({ issue, model, onClose, onIgnored }: { issue: Issue; model: string | null; onClose?: () => void; onIgnored: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("diagnosis");
  const stage = stageOf(issue);
  const ai = readyDiagnosis(issue);
  const agent = harnessLabel(issue.harness);
  const active = issue.lesson?.status === "active" ? issue.lesson : null;
  // The fix to approve, newest first: the model's diagnosis, the words last tested (the owner's edit, or a rewrite), or the one turned off.
  const latest = active
    ? null
    : [
        ai?.lesson ? { text: ai.lesson, at: ai.at, from: "diagnosis" } : null,
        issue.fixTest ? { text: issue.fixTest.lesson, at: issue.fixTest.at, from: "test" } : null,
        issue.lesson ? { text: issue.lesson.text, at: issue.lesson.createdAt, from: "turned off" } : null,
      ]
        .filter((candidate) => candidate !== null)
        .sort((a, b) => b.at.localeCompare(a.at))[0];
  const proposed = latest?.text ?? null;
  const turnedOff = latest?.from === "turned off";
  const [text, setText] = useState(proposed ?? "");
  const [copied, setCopied] = useState(false);
  // The test of exactly these words, if there is one: Apply waits for it to pass.
  const test = issue.fixTest && sameWords(issue.fixTest.lesson, text) ? issue.fixTest : null;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["issues"] });
  const patch = (change: Partial<Issue>) =>
    queryClient.setQueryData<{ issues: Issue[] }>(["issues"], (old) => old && { ...old, issues: old.issues.map((i) => (i.id === issue.id ? { ...i, ...change } : i)) });

  const apply = useMutation({ mutationFn: () => api.applyLesson(issue.id, text), onSettled: refresh });
  const turnOff = useMutation({ mutationFn: () => api.setLesson(active!.id, false), onSettled: refresh });
  const ignore = useMutation({
    mutationFn: (on: boolean) => api.ignoreIssue(issue.id, on),
    onSuccess: ({ ignored }) => {
      patch({ ignored });
      if (ignored) onIgnored();
    },
    onSettled: refresh,
  });
  const diagnose = useMutation({
    mutationFn: () => api.diagnose(issue.id),
    // Show it as running at once, so "Run again" doesn't flash the old one.
    onSuccess: ({ diagnosis }) => patch({ diagnosis }),
    onSettled: refresh,
  });
  const runTest = useMutation({
    mutationFn: () => api.testFix(issue.id, text),
    onSuccess: ({ fixTest }) => patch({ fixTest }),
    onSettled: refresh,
  });
  const pending = diagnose.isPending || issue.diagnosis?.status === "pending";
  const testing = runTest.isPending || issue.fixTest?.status === "running";
  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true));
  const error = [apply, turnOff, ignore, diagnose, runTest].find((m) => m.isError)?.error;

  const primary = issue.ignored ? (
    <button type="button" onClick={() => ignore.mutate(false)} disabled={ignore.isPending} className={SECONDARY}>
      Bring it back
    </button>
  ) : active ? (
    <button type="button" onClick={() => turnOff.mutate()} disabled={turnOff.isPending} className={SECONDARY}>
      {turnOff.isPending && <Loader2 className="size-3.5 animate-spin" />}
      Turn off fix
    </button>
  ) : proposed && issue.lessonsApply && test?.status === "passed" ? (
    <button type="button" onClick={() => apply.mutate()} disabled={apply.isPending} className={PRIMARY}>
      {apply.isPending && <Loader2 className="size-3.5 animate-spin" />}
      {turnedOff ? `Apply to ${agent} again` : `Apply fix to ${agent}`}
    </button>
  ) : proposed && issue.lessonsApply && test?.status === "untestable" ? (
    <button type="button" onClick={copy} className={SECONDARY} title="It couldn't be tested, so Lucid won't apply it. You can still add it yourself.">
      <Copy className="size-3.5" />
      {copied ? "Copied" : "Copy fix"}
    </button>
  ) : proposed && issue.lessonsApply ? (
    <button type="button" onClick={() => runTest.mutate()} disabled={testing || !text.trim() || !model} className={PRIMARY}>
      {testing ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
      {testing ? "Testing…" : test ? "Test again" : "Test fix"}
    </button>
  ) : proposed ? (
    <button type="button" onClick={copy} disabled={!text.trim()} className={PRIMARY}>
      <Copy className="size-3.5" />
      {copied ? "Copied" : "Copy fix"}
    </button>
  ) : model && !ai && !pending ? (
    <button type="button" onClick={() => diagnose.mutate()} className={PRIMARY}>
      {isMuse(model) && <BrandMark brand={BRANDS.meta} className="size-4" />}
      {issue.diagnosis?.status === "failed" ? "Try again" : `Diagnose with ${modelLabel(model)}`}
    </button>
  ) : null;

  return (
    <div className={cx("flex h-full flex-col", onClose ? "bg-white dark:bg-zinc-900" : cx(SURFACE, "overflow-hidden"))}>
      {onClose && (
        <div className="flex h-14 shrink-0 items-center border-b border-zinc-100 px-2 dark:border-white/[0.07]">
          <button type="button" onClick={onClose} className={QUIET}>
            <ArrowLeft className="size-4" />
            Inbox
          </button>
        </div>
      )}
      <div className="shrink-0 px-6 pt-6">
        <div className="flex items-start gap-4">
          <ProblemIcon issue={issue} large />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl leading-snug font-bold tracking-tight text-balance">{(ai ?? issue).title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
              <Pill stage={stage} />
              <span>
                {issue.problem !== "error" && `${PROBLEM_LABEL[issue.problem]} · `}
                {agent} · {plural(issue.runs, issue.problem === "error" ? "failed run" : "run")}
                {issue.lastSeen && ` · last ${ago(issue.lastSeen)}`}
              </span>
            </div>
          </div>
        </div>
        <TabBar className="mt-6">
          <TabItem current={tab === "diagnosis"} onClick={() => setTab("diagnosis")}>
            Diagnosis
          </TabItem>
          <TabItem current={tab === "runs"} onClick={() => setTab("runs")}>
            Runs <span className="rounded-full bg-zinc-100 px-1.5 text-xs tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{issue.runs}</span>
          </TabItem>
          <TabItem current={tab === "error"} onClick={() => setTab("error")}>
            {issue.problem === "error" ? "Error" : "Evidence"}
          </TabItem>
        </TabBar>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {tab === "diagnosis" && (
          <div className="space-y-6">
            {pending && (
              <div className="flex items-center gap-2.5 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-300">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                {model ? modelLabel(model) : "Lucid"} is reading the failed steps. This takes a few seconds.
              </div>
            )}
            <Block icon={Info} title="What happened">
              {(ai ?? issue).why}
            </Block>
            {active ? (
              <ActiveFix lesson={active} />
            ) : (
              <Block icon={Wrench} title={ai ? "Recommended fix" : "How to fix it"}>
                <FixSteps text={(ai ?? issue).fix} />
                {proposed && (
                  <Change agent={agent} text={text} onChange={setText} turnedOff={turnedOff} locked={testing}>
                    {issue.lessonsApply ? (
                      <TestStatus test={test} edited={!!issue.fixTest && !test} running={testing} model={model} agent={agent} />
                    ) : (
                      <p>Paste it into {agent}'s instructions. Lucid can't apply or test it there by itself yet.</p>
                    )}
                  </Change>
                )}
              </Block>
            )}
            {ai?.manual && (
              <section className="rounded-xl bg-amber-50/70 p-4 ring-1 ring-amber-200/70 ring-inset dark:bg-white/[0.03] dark:ring-white/10">
                <h3 className="flex items-center gap-2.5 text-sm font-semibold text-amber-900 dark:text-amber-300">
                  <span className="grid size-6 place-items-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                    <UserRound className="size-3.5" />
                  </span>
                  Do this yourself
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-amber-950/80 dark:text-zinc-300">
                  {ai.manual} <span className="text-amber-800/70 dark:text-zinc-500">Lucid never changes settings or permissions.</span>
                </p>
              </section>
            )}
            {model && <DiagnosedBy diagnosis={issue.diagnosis} onRunAgain={() => diagnose.mutate()} busy={pending} />}
          </div>
        )}
        {tab === "runs" && <RunsTab issue={issue} />}
        {tab === "error" && <ErrorTab issue={issue} />}
      </div>

      <div className="shrink-0 border-t border-zinc-100 bg-zinc-50/60 px-6 py-3.5 dark:border-white/[0.07] dark:bg-white/[0.02]">
        {error && <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">{error.message}</p>}
        <div className="flex items-center gap-2">
          {primary}
          {!issue.ignored && !active && (
            <button type="button" onClick={() => ignore.mutate(true)} disabled={ignore.isPending} className={cx(QUIET, "ml-auto")} title="Take it out of the Inbox. It won't be diagnosed by itself.">
              <EyeOff className="size-4" />
              Ignore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A part of the diagnosis: a small icon, a heading, and plain text. No box, so the panel isn't boxes in a box. */
function Block({ icon: Icon, title, aside, children }: { icon: typeof Info; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="grid size-6 place-items-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-white/[0.07] dark:text-zinc-400">
            <Icon className="size-3.5" />
          </span>
          {title}
        </h3>
        {aside}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-zinc-600 sm:pl-[2.125rem] dark:text-zinc-300">{children}</div>
    </section>
  );
}

/** The fix as steps when it has a few sentences; as a line when it has one. */
function FixSteps({ text }: { text: string }) {
  const steps = text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((step) => step.trim())
    .filter(Boolean);
  if (steps.length < 2) return <p>{text}</p>;
  return (
    <ul className="space-y-1.5">
      {steps.map((step) => (
        <li key={step} className="flex gap-2">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{step}</span>
        </li>
      ))}
    </ul>
  );
}

/** The instruction the agent gets: read it, change it if you like, test it, then approve it below. */
function Change({
  agent,
  text,
  onChange,
  turnedOff,
  locked,
  children,
}: { agent: string; text: string; onChange: (text: string) => void; turnedOff: boolean; locked: boolean; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="mt-4">
      <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 py-1 pr-1 pl-3 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
          <span>{turnedOff ? `Was in ${agent}'s instructions (turned off)` : `Adds to ${agent}'s instructions`}</span>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            // Words under test stay put until the result is in.
            disabled={locked}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-zinc-900/5 hover:text-zinc-900 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Pencil className="size-3" />
            {editing ? "Done" : "Edit"}
          </button>
        </div>
        <div className="border-l-2 border-emerald-500 dark:border-emerald-400">
          {editing ? (
            <textarea
              value={text}
              onChange={(event) => onChange(event.target.value)}
              rows={3}
              maxLength={400}
              autoFocus
              // Typing carries on from the end of the instruction.
              onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)}
              aria-label={`Instruction for ${agent}`}
              className="block w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-zinc-900 outline-none dark:text-zinc-100"
            />
          ) : (
            <p className="px-3 py-2.5 text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">{text}</p>
          )}
        </div>
      </div>
      <div className="mt-2.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{children}</div>
    </div>
  );
}

/** The same fix, give or take spaces: what the server compares a test with. */
const sameWords = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Where the fix stands: untested, being tested, or how it did on past runs, run by run. */
function TestStatus({ test, edited, running, model, agent }: { test: FixTest | null; edited: boolean; running: boolean; model: string | null; agent: string }) {
  const [open, setOpen] = useState(false);
  if (!model) return <p>Testing a fix needs a model key (BASETEN_API_KEY) on the Lucid server; until then it can't be applied.</p>;
  if (running) {
    return (
      <p className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        {modelLabel(model)} is replaying up to 3 past runs with this fix. This takes a minute or two.
      </p>
    );
  }
  if (!test || test.status === "running") {
    return (
      <p className="flex items-start gap-1.5">
        <FlaskConical className="mt-px size-3.5 shrink-0" />
        {edited ? "You changed the fix since its test. Test it again before it goes to " : "Not tested yet. Every fix is tested on past runs before it goes to "}
        {agent}.
      </p>
    );
  }
  if (test.status === "untestable" || test.status === "error") {
    return (
      <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        {test.status === "untestable" ? `Can't be tested, so Lucid won't apply it: ${test.reason}` : `The test didn't finish: ${test.reason}`}
      </p>
    );
  }
  const passed = test.results.filter((result) => result.pass).length;
  const total = test.results.length;
  const cost = costLine({ inputTokens: test.inputTokens, outputTokens: test.outputTokens, latencyMs: test.latencyMs });
  return (
    <div className="space-y-1.5">
      <p className={cx("flex items-start gap-1.5 font-medium", test.status === "passed" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
        {test.status === "passed" ? <CircleCheck className="mt-px size-3.5 shrink-0" /> : <TriangleAlert className="mt-px size-3.5 shrink-0" />}
        <span>
          {test.status === "passed" ? `Passed on ${total} of ${total} past runs.` : `Failed on ${total - passed} of ${total} past runs.`}{" "}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="font-normal text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400">
            {open ? "Hide details" : "Details"}
          </button>
        </span>
      </p>
      {test.revisedFrom && <p>{modelLabel(test.model)} rewrote the fix after the first version failed, then tested it again.</p>}
      {test.standIn && (
        <p>
          Replayed with {modelLabel(test.model)} standing in for {test.standIn}, the model {agent} uses.
        </p>
      )}
      {test.status === "passed" && <p>{agent} follows it from its next turn once applied. You can turn it off any time.</p>}
      {open && (
        <ul className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-white/[0.03]">
          {test.results.map((result) => (
            <li key={result.runId} className="flex gap-2">
              {result.pass ? <CircleCheck className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <CircleX className="mt-px size-3.5 shrink-0 text-rose-600 dark:text-rose-400" />}
              <span className="min-w-0">
                <Link to={`/runs/${result.runId}`} className="font-medium text-zinc-700 hover:underline dark:text-zinc-200">
                  {result.runName ?? "A past run"}
                </Link>
                : {result.reason}
                <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-400" title={result.decision}>
                  {result.decision}
                </span>
              </span>
            </li>
          ))}
          {cost.text && (
            <li className="text-zinc-400" title={cost.title}>
              Test cost: {cost.text}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** An applied lesson: is the agent using it, and is the failure gone? */
function ActiveFix({ lesson }: { lesson: AppliedLesson }) {
  const agent = harnessLabel(lesson.harness);
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
      <span>
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
        Still happening: {plural(failures, "failure")} in {plural(runs, "run")} since it went live. Turn it off and diagnose it again.
      </span>
    ),
  };
  return (
    <Block icon={Wrench} title={`Fix in ${agent}`}>
      <p className="border-l-2 border-emerald-500 pl-3 text-zinc-900 dark:border-emerald-400 dark:text-zinc-100">{lesson.text}</p>
      {state && <p className="mt-3 text-sm">{status[state]}</p>}
    </Block>
  );
}

/** "1,730 tokens · 3.5 s": what one diagnosis cost, with the in/out split on hover. */
function costLine(d: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null }) {
  const tokens = d.inputTokens != null && d.outputTokens != null ? d.inputTokens + d.outputTokens : null;
  const text = [tokens != null && `${tokens.toLocaleString()} tokens`, d.latencyMs != null && `${(d.latencyMs / 1000).toFixed(1)} s`].filter(Boolean).join(" · ");
  const title = tokens != null ? `${d.inputTokens!.toLocaleString()} in, ${d.outputTokens!.toLocaleString()} out` : undefined;
  return { text, title };
}

/** Who diagnosed it and what it cost, or why it couldn't. */
function DiagnosedBy({ diagnosis: d, onRunAgain, busy }: { diagnosis: Diagnosis | null; onRunAgain: () => void; busy: boolean }) {
  if (busy || !d || d.status === "pending") return null;
  const again = (label: string) => (
    <button type="button" onClick={onRunAgain} className="font-medium underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-white">
      {label}
    </button>
  );
  if (d.status === "failed") {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-100 pt-4 text-xs text-zinc-500 dark:border-white/[0.07] dark:text-zinc-400">
        <span className="text-rose-600 dark:text-rose-400" title={d.error}>
          Couldn't diagnose: {d.error.length > 90 ? `${d.error.slice(0, 89)}…` : d.error}
        </span>
        {again("Try again")}
      </p>
    );
  }
  const cost = costLine(d);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-100 pt-4 text-xs text-zinc-500 dark:border-white/[0.07] dark:text-zinc-400">
      <span className="inline-flex items-center gap-1.5">
        {isMuse(d.model) && <BrandMark brand={BRANDS.meta} className="size-3.5" />}
        Diagnosed by {modelLabel(d.model)} {ago(d.at)}
      </span>
      {cost.text && (
        <span className="tabular-nums" title={cost.title}>
          · {cost.text}
        </span>
      )}
      <span aria-hidden>·</span>
      {again("Run again")}
    </p>
  );
}

/** The runs it hit, newest first, to open and read. */
function RunsTab({ issue }: { issue: Issue }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        Failed {plural(issue.occurrences, "time")} in {plural(issue.runs, "run")}
        {issue.firstSeen && `, first ${ago(issue.firstSeen)}`}
        {issue.lastSeen && `, last ${ago(issue.lastSeen)}`}.
      </p>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 dark:divide-white/[0.07] dark:border-white/10">
        {issue.examples.map((example) => (
          <li key={example.runId}>
            <Link to={`/runs/${example.runId}`} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-white/[0.03]">
              <span className="size-2 shrink-0 rounded-full bg-rose-500" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{example.runName ?? "Run"}</span>
              <ChevronRight className="size-4 shrink-0 text-zinc-400" />
            </Link>
          </li>
        ))}
      </ul>
      {issue.runs > issue.examples.length && <p className="text-xs text-zinc-500 dark:text-zinc-400">The latest {issue.examples.length} are shown.</p>}
    </div>
  );
}

/** The raw error: for digging, not deciding. For a problem no step reported, what Lucid saw instead. */
function ErrorTab({ issue }: { issue: Issue }) {
  if (issue.problem !== "error") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">What Lucid saw in the newest run:</p>
        <div className="rounded-xl border border-zinc-200 p-4 text-sm leading-relaxed whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere] dark:border-white/10 dark:text-zinc-300">
          {issue.sample}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{FOUND_HOW[issue.problem]}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        {issue.toolName ? (
          <>
            The <span className="font-mono text-[13px]">{issue.toolName}</span> step failed with:
          </>
        ) : (
          "The step failed with:"
        )}
      </p>
      {issue.sample ? (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10">
          <div className="flex justify-end border-b border-zinc-200 bg-zinc-50 px-1 py-0.5 dark:border-white/10 dark:bg-white/[0.03]">
            <CopyButton text={issue.sample} />
          </div>
          <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">{issue.sample}</pre>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No message was recorded.</p>
      )}
    </div>
  );
}
