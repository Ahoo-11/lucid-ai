// A session as a chat: each request, the agent's workings on it (folded),
// and its answer, oldest first. The side panel shows the session's numbers
// until a request or a step is picked. Seeing the whole chat explains later
// costs: an agent sends everything said so far with every model call.

import { useQueries, useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { type RunDetail, type SessionRun, type SessionView, api } from "../api";
import { ContextDetails, ContextRing, Ring } from "../context";
import { cost, dateTime, duration, harnessLabel, plural, tokens } from "../format";
import { buildTree } from "../story";
import { InOut, TokenBreakdown, percent } from "../tokens";
import { BackLink, Card, LABEL, Stat, cx } from "../ui";
import { Expandable, StepDetail, Timeline } from "./Run";

/** What the side panel shows: a request's numbers, or one of its steps. */
type Picked = { runId: string; stepId?: string } | null;

/** /sessions/:id opens a session at the top; /runs/:id opens the session at that request, its workings open. */
export function SessionRoute({ by }: { by: "session" | "run" }) {
  const { id = "" } = useParams();
  return <SessionPage key={`${by}:${id}`} sessionKey={by === "run" ? `run:${id}` : id} focus={by === "run" ? id : null} />;
}

const scrollToRequest = (runId: string) => document.getElementById(`request-${runId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

function SessionPage({ sessionKey, focus }: { sessionKey: string; focus: string | null }) {
  const query = useQuery({ queryKey: ["session", sessionKey], queryFn: () => api.session(sessionKey) });
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const [picked, setPicked] = useState<Picked>(null);
  const data = query.data;
  // Steps load per request, when its workings open.
  const openIds = data?.runs.filter((run) => open.has(run.id)).map((run) => run.id) ?? [];
  const details = useQueries({ queries: openIds.map((runId) => ({ queryKey: ["run", runId], queryFn: () => api.run(runId) })) });
  const detailOf = new Map(openIds.map((runId, i) => [runId, details[i]?.data]));

  const scrolled = useRef(false);
  useEffect(() => {
    if (!focus || !data || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(`request-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, data]);

  // j / k walk through the steps of the open workings, like an inbox; Escape goes back to the session's numbers.
  const order = openIds.flatMap((runId) => (detailOf.get(runId)?.steps ?? []).map((step) => ({ runId, stepId: step.externalId })));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") return setPicked(null);
      if (event.key !== "j" && event.key !== "k") return;
      const index = picked?.stepId ? order.findIndex((item) => item.runId === picked.runId && item.stepId === picked.stepId) : -1;
      const next = order[Math.min(order.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
      if (next) setPicked(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (query.isPending) return <div className="text-sm text-zinc-500">Loading the session…</div>;
  if (query.isError || !data) return <div className="text-sm text-rose-600">Could not load this session: {String(query.error?.message ?? "not found")}</div>;

  const toggle = (runId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });

  return (
    <div className="space-y-6">
      <SessionHeader data={data} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <Card className="min-w-0 divide-y divide-zinc-100 dark:divide-white/[0.06]">
          {data.runs.length === 0 && <p className="p-5 text-sm text-zinc-500">No requests in this session yet.</p>}
          {data.runs.map((run, index) => (
            <Exchange
              key={run.id}
              run={run}
              index={index}
              data={data}
              open={open.has(run.id)}
              detail={detailOf.get(run.id)}
              picked={picked}
              onToggle={() => toggle(run.id)}
              onPick={setPicked}
            />
          ))}
        </Card>
        <aside className="min-w-0">
          {/* On a phone a picked step or request opens as a full-screen sheet. */}
          <div
            className={cx(
              "lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto",
              picked && "max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:overflow-y-auto max-lg:bg-paper max-lg:p-4 max-lg:dark:bg-zinc-950",
            )}
          >
            <Viewer data={data} picked={picked} onClose={() => setPicked(null)} onPick={setPicked} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function SessionHeader({ data }: { data: SessionView }) {
  const first = data.runs[0];
  const title = data.session?.title ?? first?.name ?? "Untitled session";
  const harness = data.session?.harness ?? first?.harness;
  // "<synthetic>" is Claude Code's name for messages no model wrote.
  const models = [...new Set(data.runs.map((run) => run.model).filter((model): model is string => !!model && !model.startsWith("<")))];
  const branch = data.session?.gitBranch;
  return (
    <div className="space-y-3">
      <BackLink to="/runs">Sessions</BackLink>
      <div>
        <h1 className="line-clamp-2 font-display text-xl leading-snug font-bold tracking-tight text-balance sm:text-2xl" title={title}>
          {title}
        </h1>
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-sm text-zinc-500 dark:text-zinc-400">
          {harness && <span>{harnessLabel(harness)}</span>}
          {models.length > 0 && <span>{models.length > 2 ? `${models[0]} and ${models.length - 1} more` : models.join(", ")}</span>}
          <span>{plural(data.runs.length, "request")}</span>
          {first && <span>{dateTime(first.startedAt)}</span>}
          {branch && branch !== "HEAD" && <span>on {branch}</span>}
        </div>
      </div>
    </div>
  );
}

function Exchange({
  run,
  index,
  data,
  open,
  detail,
  picked,
  onToggle,
  onPick,
}: {
  run: SessionRun;
  index: number;
  data: SessionView;
  open: boolean;
  detail: RunDetail | undefined;
  picked: Picked;
  onToggle: () => void;
  onPick: (picked: Picked) => void;
}) {
  const isPicked = picked?.runId === run.id && !picked.stepId;
  const system = run.metadata?.systemTurn;
  const ring = run.context > 0 && <ContextRing runId={run.id} largest={run.context} window={data.contextWindow} />;
  return (
    <section id={`request-${run.id}`} className="scroll-mt-24 space-y-3 p-5">
      <div className="flex flex-col items-end gap-1">
        <div
          className={cx(
            "max-w-[88%] min-w-0 rounded-2xl rounded-tr-md px-4 py-2.5",
            system ? "text-zinc-500 italic ring-1 ring-zinc-200 dark:ring-white/10" : "bg-zinc-100 dark:bg-white/[0.07]",
            isPicked && "ring-1 ring-zinc-900/70 dark:ring-white/40",
          )}
        >
          {run.input ? <Expandable text={run.input} end={ring} /> : <p className="text-sm text-zinc-500">The request wasn't captured. {ring}</p>}
        </div>
        <button
          type="button"
          onClick={() => onPick(isPicked ? null : { runId: run.id })}
          title="See this request's numbers in the side panel"
          className={cx(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white",
            isPicked && "bg-zinc-900/5 text-zinc-900 dark:bg-white/10 dark:text-white",
          )}
        >
          {system ? "Sent by the agent's app" : `Request ${index + 1}`} · {dateTime(run.startedAt)}
          <ChevronRight className="size-3" />
        </button>
      </div>
      <Workings run={run} open={open} detail={detail} picked={picked} onToggle={onToggle} onPick={onPick} />
      <Answer run={run} harness={data.session?.harness ?? run.harness} />
    </section>
  );
}

/** Folded to one line: how long, how many calls, what it cost. Opened: every step, with what the agent said between them. */
function Workings({
  run,
  open,
  detail,
  picked,
  onToggle,
  onPick,
}: {
  run: SessionRun;
  open: boolean;
  detail: RunDetail | undefined;
  picked: Picked;
  onToggle: () => void;
  onPick: (picked: Picked) => void;
}) {
  if (run.stepCount === 0) return null;
  const running = run.status === "running";
  const facts = [
    run.durationMs != null && !running ? duration(run.durationMs) : null,
    run.llmCallCount ? plural(run.llmCallCount, "model call") : null,
    run.toolCallCount ? plural(run.toolCallCount, "tool call") : null,
    run.costUsd != null ? cost(run.costUsd) : null,
  ].filter(Boolean);
  return (
    <div className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08]">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-white/[0.03]">
        {open ? <ChevronDown className="size-4 shrink-0 text-zinc-400" /> : <ChevronRight className="size-4 shrink-0 text-zinc-400" />}
        <span className="font-medium">{running ? "Working" : "Workings"}</span>
        {running && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-zinc-400" />}
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {facts.join(" · ")}
          {run.errorCount > 0 && <span className="text-rose-600 dark:text-rose-400"> · {plural(run.errorCount, "failed step")}</span>}
        </span>
        {run.llmCallCount > 0 && <InOut t={run} className="hidden shrink-0 text-xs text-zinc-400 sm:inline" />}
      </button>
      {open && (
        <div className="border-t border-zinc-100 p-2 dark:border-white/[0.06]">
          {detail ? (
            <Timeline
              nodes={buildTree(detail.steps)}
              selected={picked?.runId === run.id ? (picked.stepId ?? null) : null}
              onSelect={(stepId) => onPick({ runId: run.id, stepId })}
            />
          ) : (
            <p className="inline-flex items-center gap-2 px-2 py-1.5 text-sm text-zinc-500">
              <LoaderCircle className="size-4 animate-spin" /> Loading the steps…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Answer({ run, harness }: { run: SessionRun; harness: string }) {
  const who = [harnessLabel(harness), run.model].filter(Boolean).join(" · ");
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
        <Bot className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{who}</div>
        {run.output ? (
          <Expandable text={run.output} lines={10} />
        ) : (
          <p className={cx("mt-1.5 text-sm", run.status === "error" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400")}>
            {run.status === "running" ? "Still working…" : run.status === "error" ? "This request failed before the agent answered." : "No answer was captured."}
          </p>
        )}
      </div>
    </div>
  );
}

function Viewer({ data, picked, onClose, onPick }: { data: SessionView; picked: Picked; onClose: () => void; onPick: (picked: Picked) => void }) {
  // Shares the cache with the open workings; also keeps a step on screen after its workings fold.
  const detail = useQuery({ queryKey: ["run", picked?.runId], queryFn: () => api.run(picked!.runId), enabled: !!picked });
  if (picked?.stepId) {
    const step = detail.data?.steps.find((s) => s.externalId === picked.stepId);
    if (step && detail.data) return <StepDetail step={step} steps={detail.data.steps} onClose={onClose} />;
    return <Card className="p-6 text-sm text-zinc-500">{detail.isPending ? "Loading…" : "This step isn't there anymore."}</Card>;
  }
  const run = picked ? data.runs.find((r) => r.id === picked.runId) : undefined;
  if (run) return <RequestNumbers run={run} index={data.runs.indexOf(run)} data={data} split={detail.data?.costSplit ?? null} onClose={onClose} />;
  return <SessionNumbers data={data} onPick={onPick} />;
}

const sumOf = (runs: SessionRun[], pick: (run: SessionRun) => number | null | undefined) => runs.reduce((total, run) => total + (pick(run) ?? 0), 0);

function SessionNumbers({ data, onPick }: { data: SessionView; onPick: (picked: Picked) => void }) {
  const { runs } = data;
  const totals = {
    inputTokens: sumOf(runs, (r) => r.inputTokens),
    outputTokens: sumOf(runs, (r) => r.outputTokens),
    cacheReadTokens: sumOf(runs, (r) => r.cacheReadTokens),
    cacheWriteTokens: sumOf(runs, (r) => r.cacheWriteTokens),
  };
  const calls = sumOf(runs, (r) => r.llmCallCount);
  const priced = runs.some((r) => r.costUsd != null);
  const incomplete = runs.some((r) => r.costIncomplete > 0);
  const largest = Math.max(0, ...runs.map((r) => r.context));
  return (
    <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
      <div className="p-5">
        <div className={LABEL}>This session</div>
        <div className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          {plural(runs.length, "request")}
          {runs[0] && ` since ${dateTime(runs[0].startedAt)}`}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <Stat label="Agent time" value={duration(sumOf(runs, (r) => r.durationMs))} hint="How long the agent worked on the requests, added up" />
          <Stat
            label="Cost"
            value={priced ? `${cost(sumOf(runs, (r) => r.costUsd))}${incomplete ? "+" : ""}` : "—"}
            hint={incomplete ? "Some model calls have no known price, so this is a minimum" : "Model cost of every request in this session"}
          />
          <Stat label="Model calls" value={calls} hint="How many times the agent asked the model what to do next" />
          <Stat label="Tool calls" value={sumOf(runs, (r) => r.toolCallCount)} hint="Actions the agent took: reading files, running commands, calling APIs, launching sub-agents" />
          <Stat label="Failed steps" value={sumOf(runs, (r) => r.errorCount)} hint="Tool calls or model calls that returned an error" tone={runs.some((r) => r.errorCount > 0) ? "bad" : undefined} />
          <Stat label="Largest context" value={tokens(largest)} hint="The most tokens the model had to read in a single call (new input + cached)" />
        </div>
      </div>
      {calls > 0 && (
        <div className="p-5">
          <TokensHeading t={totals} calls={calls} />
          <TokenBreakdown t={totals} split={data.costSplit} compact />
        </div>
      )}
      {largest > 0 && (
        <div className="p-5">
          <ContextGrowth data={data} largest={largest} onPick={onPick} />
        </div>
      )}
    </Card>
  );
}

function TokensHeading({ t, calls }: { t: Parameters<typeof InOut>[0]["t"]; calls: number }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-[15px] font-semibold">Tokens and cost</h3>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        <InOut t={t} /> · {plural(calls, "model call")}
      </span>
    </div>
  );
}

/**
 * Each request's biggest prompt, in order. In a long chat it climbs: every
 * call carries everything said before it. A bar opens that request.
 */
function ContextGrowth({ data, largest, onPick }: { data: SessionView; largest: number; onPick: (picked: Picked) => void }) {
  const sized = data.runs.map((run, index) => ({ run, index })).filter(({ run }) => run.context > 0);
  const first = sized[0]!.run.context;
  const last = sized[sized.length - 1]!.run.context;
  const dense = sized.length > 40;
  return (
    <section>
      <h3 className="text-[15px] font-semibold">Context per request</h3>
      <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        {sized.length === 1
          ? `The biggest prompt was ${tokens(largest)} tokens.`
          : last > first * 1.3
            ? `Every call sends the chat so far again, so the prompt grew from ${tokens(first)} to ${tokens(last)} tokens.`
            : `The prompt stayed around ${tokens(Math.round((first + last) / 2))} tokens a call.`}
      </p>
      <div className={cx("mt-3 flex h-24 items-end overflow-hidden", dense ? "gap-px" : "gap-[3px]")}>
        {sized.map(({ run, index }) => (
          <button
            key={run.id}
            type="button"
            onClick={() => {
              onPick({ runId: run.id });
              scrollToRequest(run.id);
            }}
            title={`Request ${index + 1}: ${tokens(run.context)} tokens`}
            aria-label={`Request ${index + 1}: ${tokens(run.context)} tokens`}
            className="max-w-6 min-w-px flex-1 rounded-t-[2px] bg-zinc-700 transition-colors hover:bg-zinc-400 dark:bg-zinc-300 dark:hover:bg-zinc-500"
            style={{ height: `${Math.max(4, (run.context / largest) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-zinc-400">
        <span>Request {sized[0]!.index + 1}</span>
        {sized.length > 1 && <span>Request {sized[sized.length - 1]!.index + 1}</span>}
      </div>
      {data.contextWindow && (
        <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="text-zinc-700 dark:text-zinc-200">
            <Ring share={Math.min(1, largest / data.contextWindow)} />
          </span>
          Biggest call: {tokens(largest)} of the model's {tokens(data.contextWindow)} context window ({percent(largest / data.contextWindow)})
        </p>
      )}
    </section>
  );
}

function RequestNumbers({ run, index, data, split, onClose }: { run: SessionRun; index: number; data: SessionView; split: RunDetail["costSplit"]; onClose: () => void }) {
  return (
    <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
      <div className="flex items-start gap-3 p-5">
        <div className="min-w-0 flex-1">
          <div className={LABEL}>
            Request {index + 1} of {data.runs.length}
          </div>
          <div className="mt-0.5 line-clamp-2 font-semibold" title={run.name ?? undefined}>
            {run.name ?? "Untitled request"}
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{dateTime(run.startedAt)}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white">
          Close
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3">
        <Stat label="Duration" value={duration(run.durationMs)} hint="From the request to the agent's last step" />
        <Stat
          label="Cost"
          value={`${cost(run.costUsd)}${run.costIncomplete ? "+" : ""}`}
          hint={run.costIncomplete ? "Some model calls have no known price, so this is a minimum" : "Model cost of this request, including sub-agents"}
        />
        <Stat label="Model calls" value={run.llmCallCount} hint="How many times the agent asked the model what to do next" />
        <Stat label="Tool calls" value={run.toolCallCount} hint="Actions the agent took: reading files, running commands, calling APIs, launching sub-agents" />
        <Stat label="Failed steps" value={run.errorCount} hint="Tool calls or model calls that returned an error" tone={run.errorCount ? "bad" : undefined} />
        <Stat label="Largest context" value={tokens(run.context)} hint="The most tokens the model had to read in a single call (new input + cached)" />
      </div>
      {run.llmCallCount > 0 && (
        <div className="p-5">
          <TokensHeading t={run} calls={run.llmCallCount} />
          <TokenBreakdown t={run} split={split} compact />
        </div>
      )}
      {run.context > 0 && (
        <div className="p-5">
          <div className={LABEL}>What the model read</div>
          <ContextDetails runId={run.id} largest={run.context} contextWindow={data.contextWindow} />
        </div>
      )}
    </Card>
  );
}
