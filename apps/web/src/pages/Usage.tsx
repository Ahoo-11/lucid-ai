import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, Coins } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type Usage as UsageData, api } from "../api";
import { ago, cost, duration, harnessLabel, plural, tokens, toolLabel } from "../format";
import { InOut, TokenBreakdown, percent, tokenTitle, tokensIn } from "../tokens";
import { Card, Empty, LABEL, PageHeader, Segmented, StatTile, cx } from "../ui";

const PERIODS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

/** The Usage tab: what the agents' model calls cost over a period, and which tokens, models and agents it went to. */
export function Usage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Usage" sub="What your agents' model calls cost, and where the tokens go." />
      <UsageView />
    </div>
  );
}

function UsageView() {
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find((period) => String(period.days) === params.get("days"))?.days ?? 7;
  // The last period stays on screen, dimmed, while the next one loads.
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(days), placeholderData: keepPreviousData });
  const setDays = (next: number) => {
    const search = new URLSearchParams(params);
    if (next === 7) search.delete("days");
    else search.set("days", String(next));
    setParams(search, { replace: true });
  };
  const data = usage.data;
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <Segmented label="Period" options={PERIODS.map((period) => ({ value: period.days, label: period.label }))} value={days} onChange={setDays} />

      {!data || !totals ? (
        <div className="text-sm text-zinc-500">{usage.isError ? `Couldn't load usage: ${usage.error.message}` : "Loading…"}</div>
      ) : totals.runs === 0 ? (
        <Card>
          <Empty icon={<Coins className="size-8" />} title="No requests in this period">
            Cost and tokens show up here once your agents work.
          </Empty>
        </Card>
      ) : (
        <div className={cx("space-y-6 transition-opacity", usage.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Total cost"
              value={`${cost(totals.costUsd)}${totals.unpricedRuns ? "+" : ""}`}
              sub={`${perRun(totals)} a request`}
              hint={totals.unpricedRuns ? "Some requests used a model with no known price, so this is a minimum" : "Model cost of every request in the period"}
              aside={<Change now={totals.costUsd ?? 0} before={data.previous.costUsd ?? 0} days={days} show={cost} />}
            />
            <StatTile
              label="Input tokens"
              value={tokens(tokensIn(totals))}
              hint={tokenTitle(totals)}
              sub={`${percent(totals.cacheReadTokens / Math.max(1, tokensIn(totals)))} read from cache`}
              aside={<Change now={tokensIn(totals)} before={tokensIn(data.previous)} days={days} show={tokens} />}
            />
            <StatTile
              label="Output tokens"
              value={tokens(totals.outputTokens)}
              sub={totals.reasoningTokens ? `${tokens(totals.reasoningTokens)} of it thinking` : `${tokens(totals.outputTokens / Math.max(1, totals.llmCalls))} per model call`}
              aside={<Change now={totals.outputTokens} before={data.previous.outputTokens} days={days} show={tokens} />}
            />
            <StatTile
              label="Model calls"
              value={totals.llmCalls.toLocaleString()}
              sub={`${tokens(tokensIn(totals) / Math.max(1, totals.llmCalls))} read per call · biggest ${tokens(totals.largestContext)}`}
              hint="How many times the agents asked a model what to do next, and how many tokens a call read on average and at most"
              aside={<Change now={totals.llmCalls} before={data.previous.llmCalls} days={days} show={(n) => n.toLocaleString()} />}
            />
            <StatTile
              label="Sessions"
              value={totals.sessions.toLocaleString()}
              sub={`${plural(totals.runs, "request")} · ${duration(totals.agentMs)} of agent time`}
              hint="Conversations with a request in the period, and how long the agents worked on them, added up"
              aside={<Change now={totals.sessions} before={data.previous.sessions} days={days} show={(n) => n.toLocaleString()} />}
            />
            <StatTile
              label="Tool calls"
              value={totals.toolCalls.toLocaleString()}
              sub={`${(totals.toolCalls / Math.max(1, totals.runs)).toFixed(1)} per request`}
              hint="Actions the agents took: reading files, running commands, calling APIs, launching sub-agents"
              aside={<Change now={totals.toolCalls} before={data.previous.toolCalls} days={days} show={(n) => n.toLocaleString()} />}
            />
            <StatTile
              label="Failed steps"
              value={totals.failedSteps.toLocaleString()}
              tone={totals.failedSteps ? "bad" : undefined}
              sub={totals.failedRuns ? `In ${plural(totals.failedRuns, "request")} (${percent(totals.failedRuns / Math.max(1, totals.runs))})` : "Nothing failed"}
              hint="Tool calls or model calls that returned an error, and the requests they were in"
              aside={<Change now={totals.failedSteps} before={data.previous.failedSteps} days={days} show={(n) => n.toLocaleString()} />}
            />
            <StatTile
              label="Saved by the cache"
              value={totals.cacheSavedUsd == null ? "—" : cost(Math.max(0, totals.cacheSavedUsd))}
              sub={
                totals.cacheSavedUsd == null
                  ? "No known prices for these models"
                  : totals.cacheSavedUsd > 0
                    ? `${tokens(totals.cacheReadTokens)} tokens read from cache`
                    : "Writing the cache cost more than it saved"
              }
              hint="What the agents would have paid, at list prices, had the prompt cache not served the repeated part of each prompt, minus the premium for writing it"
            />
          </div>

          <Panel title="Cost over time">
            <SpendChart data={data} />
          </Panel>

          <Panel
            title="Where the money goes"
            note={totals.split ? "Cost by kind of token is estimated from list prices; the totals use the cost an agent reports, when it does." : undefined}
          >
            <TokenBreakdown t={totals} split={totals.split} />
          </Panel>

          <Panel title="By model" flush>
            <ModelTable data={data} />
          </Panel>
          <Panel title="By agent" flush>
            <AgentTable data={data} />
          </Panel>
          {data.tools.length > 0 && (
            <Panel title="Most used tools" flush>
              <ToolTable data={data} />
            </Panel>
          )}

          {data.top.length > 0 && (
            <Panel title="Most expensive requests" flush>
              <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
                {data.top.map((run) => (
                  <li key={run.id}>
                    <Link to={`/runs/${run.id}`} className="flex items-center gap-3 px-6 py-3.5 transition-colors hover:bg-zinc-50/80 dark:hover:bg-white/[0.03]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{run.name ?? "Untitled request"}</div>
                        <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {[harnessLabel(run.harness), run.model, ago(run.startedAt)].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-medium tabular-nums">{cost(run.costUsd)}</div>
                        <InOut t={run} className="text-xs text-zinc-500 dark:text-zinc-400" />
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-zinc-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {totals.unpricedRuns > 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {plural(totals.unpricedRuns, "request")} used a model with no known price, so its cost isn't counted (the totals show a +).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Up or down since the period before ("↑ 23%"). Plain ink, not red or green:
 * more tokens can be more work done, not a problem.
 */
function Change({ now, before, days, show }: { now: number; before: number; days: number; show: (n: number) => string }) {
  if (!now && !before) return null;
  const span = days === 1 ? "24 hours" : `${days} days`;
  const title = `The ${span} before: ${show(before)}`;
  if (!before) {
    return (
      <span className="shrink-0 text-xs text-zinc-400" title={title}>
        new
      </span>
    );
  }
  const ratio = now / before;
  const Arrow = ratio > 1 ? ArrowUp : ArrowDown;
  // "↑ 47×" reads better than "↑ 4600%".
  const size = ratio >= 2 ? `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio).toLocaleString("en-US")}×` : percent(Math.abs(ratio - 1));
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-zinc-500 tabular-nums dark:text-zinc-400" title={title}>
      {Math.abs(ratio - 1) < 0.005 ? (
        "same"
      ) : (
        <>
          <Arrow className="size-3" />
          {size}
        </>
      )}
    </span>
  );
}

/** Average cost of a request; unknown ("—") when no price was known. */
const perRun = (row: { costUsd: number | null; runs: number }) => (row.costUsd == null ? cost(null) : cost(row.costUsd / Math.max(1, row.runs)));

function Panel({ title, note, flush, children }: { title: string; note?: string; flush?: boolean; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <h2 className="px-6 pt-5 text-[15px] font-semibold">{title}</h2>
      <div className={flush ? "mt-4" : "px-6 pt-5 pb-6"}>{children}</div>
      {note && <p className="border-t border-zinc-100 bg-zinc-50/60 px-6 py-3 text-xs text-zinc-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-zinc-400">{note}</p>}
    </Card>
  );
}

type Bucket = { start: Date; label: string; short: string; costUsd: number; tokensIn: number; tokensOut: number; runs: number };

/** The period in the viewer's own hours (24 hours) or days, with each UTC hour from the server added in. */
function buckets(data: UsageData): Bucket[] {
  const hourly = data.days === 1;
  const out: Bucket[] = [];
  const make = (start: Date): Bucket => ({
    start,
    label: hourly
      ? start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
      : start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    short: hourly ? start.toLocaleTimeString(undefined, { hour: "numeric" }) : start.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    runs: 0,
  });
  const now = new Date();
  if (hourly) {
    const first = new Date(now);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() - 23);
    for (let i = 0; i < 24; i++) {
      const start = new Date(first);
      start.setHours(first.getHours() + i);
      out.push(make(start));
    }
  } else {
    const day = new Date(data.since);
    day.setHours(0, 0, 0, 0);
    for (; day <= now; day.setDate(day.getDate() + 1)) out.push(make(new Date(day)));
  }
  for (const row of data.hours) {
    const at = Date.parse(row.at);
    let bucket: Bucket | undefined;
    for (const candidate of out) if (candidate.start.getTime() <= at) bucket = candidate;
    if (!bucket) continue;
    bucket.costUsd += row.costUsd ?? 0;
    bucket.tokensIn += tokensIn(row);
    bucket.tokensOut += row.outputTokens;
    bucket.runs += row.runs;
  }
  return out;
}

/** A round axis top just above the largest value: 1, 2, 2.5 or 5 times a power of ten. */
function niceMax(value: number) {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((m) => m * power >= value) ?? 10) * power;
}

function SpendChart({ data }: { data: UsageData }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const rows = buckets(data);
  const max = niceMax(Math.max(...rows.map((row) => row.costUsd)));
  if (!max) return <p className="text-sm text-zinc-500 dark:text-zinc-400">No cost was recorded in this period: the models used have no known price.</p>;
  // A label every few bars, so they never collide.
  const every = data.days === 1 ? 6 : rows.length > 10 ? 5 : 1;
  const shown = hover === null ? null : rows[hover]!;
  const describe = (row: Bucket) => `${row.label}: ${cost(row.costUsd)}, ${tokens(row.tokensIn)} tokens in, ${tokens(row.tokensOut)} out, ${plural(row.runs, "request")}`;
  return (
    <div>
      <div className="flex">
        <div className="flex h-44 w-14 shrink-0 flex-col justify-between pr-2 text-right text-[11px] text-zinc-400 tabular-nums">
          <span className="-translate-y-1/2">{cost(max)}</span>
          <span>{cost(max / 2)}</span>
          <span className="translate-y-1/2">$0</span>
        </div>
        <div className="relative h-44 flex-1 border-b border-zinc-300 dark:border-zinc-700">
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-zinc-200 dark:border-white/10" aria-hidden />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-200 dark:border-white/10" aria-hidden />
          <div className="absolute inset-0 flex items-end">
            {rows.map((row, i) => (
              <button
                key={row.start.getTime()}
                type="button"
                aria-label={describe(row)}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="group flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none"
              >
                <span
                  className={cx("w-[70%] max-w-6 rounded-t-[4px] bg-series-1 transition-opacity group-focus-visible:ring-2 group-focus-visible:ring-zinc-400", hover !== null && hover !== i && "opacity-50")}
                  style={{ height: `${(row.costUsd / max) * 100}%`, minHeight: row.costUsd > 0 ? 2 : 0 }}
                />
              </button>
            ))}
          </div>
          {shown && hover !== null && (
            <div
              className={cx(
                "pointer-events-none absolute top-1 z-10 w-max rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900",
                hover < 2 ? "translate-x-0" : hover > rows.length - 3 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${((hover + 0.5) / rows.length) * 100}%` }}
            >
              <div className="text-sm font-semibold tabular-nums">{cost(shown.costUsd)}</div>
              <div className="text-zinc-500 dark:text-zinc-400">{shown.label}</div>
              <div className="mt-1 tabular-nums">
                {tokens(shown.tokensIn)} in · {tokens(shown.tokensOut)} out · {plural(shown.runs, "request")}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-14 flex pt-1.5">
        {rows.map((row, i) => (
          <span key={row.start.getTime()} className="min-w-0 flex-1 overflow-visible text-center text-[11px] whitespace-nowrap text-zinc-400">
            {/* Half of them on a phone. */}
            {i % every === 0 && <span className={(i / every) % 2 ? "hidden sm:inline" : undefined}>{row.short}</span>}
          </span>
        ))}
      </div>
      <button type="button" onClick={() => setTable(!table)} aria-expanded={table} className="mt-3 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">
        {table ? "Hide the numbers" : "See the numbers"}
      </button>
      {table && (
        <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-zinc-200 dark:border-white/10">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">{data.days === 1 ? "Hour" : "Day"}</th>
                <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens in</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens out</th>
                <th className="px-3 py-1.5 text-right font-medium">Requests</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
              {rows.map((row) => (
                <tr key={row.start.getTime()}>
                  <td className="px-3 py-1.5">{row.label}</td>
                  <td className="px-3 py-1.5 text-right">{cost(row.costUsd)}</td>
                  <td className="px-3 py-1.5 text-right">{row.tokensIn.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{row.tokensOut.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{row.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TH = `${LABEL} px-3 py-2.5 text-right whitespace-nowrap first:pl-6 first:text-left last:pr-6`;
const TD = "px-3 py-3 text-right tabular-nums whitespace-nowrap first:pl-6 first:text-left last:pr-6";

/** A thin bar for a row's share of the period's spend. */
function Share({ value, total }: { value: number | null; total: number | null }) {
  const share = total && value ? value / total : 0;
  return (
    <span className="flex items-center justify-end gap-2" title={`${percent(share)} of the cost`}>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{percent(share)}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
        <span className="block h-full rounded-full bg-series-1" style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  );
}

function ModelTable({ data }: { data: UsageData }) {
  if (!data.models.length) return <p className="px-6 pb-6 text-sm text-zinc-500">No model calls in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <tr>
            <th className={TH}>Model</th>
            <th className={TH}>Calls</th>
            <th className={TH}>Tokens in</th>
            <th className={TH}>Tokens out</th>
            <th className={TH}>Cost</th>
            <th className={TH}>
              <span className="sr-only">Share</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
          {data.models.map((row) => (
            <tr key={`${row.model}\u0000${row.provider}`}>
              <td className={cx(TD, "max-w-56")}>
                <div className="truncate font-medium" title={row.model ?? undefined}>
                  {row.model ?? "Unknown model"}
                </div>
                {row.provider && <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.provider}</div>}
              </td>
              <td className={TD}>{row.calls.toLocaleString()}</td>
              <td className={TD} title={tokenTitle(row)}>
                {tokens(tokensIn(row))}
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{percent(row.cacheReadTokens / Math.max(1, tokensIn(row)))} cached</div>
              </td>
              <td className={TD}>{tokens(row.outputTokens)}</td>
              <td className={TD} title={row.unpriced ? `${plural(row.unpriced, "call")} with no known price` : undefined}>
                {row.unpriced === row.calls ? "—" : `${cost(row.costUsd)}${row.unpriced ? "+" : ""}`}
              </td>
              <td className={TD}>
                <Share value={row.costUsd} total={data.totals.costUsd} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolTable({ data }: { data: UsageData }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <tr>
            <th className={TH}>Tool</th>
            <th className={TH}>Calls</th>
            <th className={TH}>Failed</th>
            <th className={TH}>Avg time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
          {data.tools.map((row) => (
            <tr key={row.tool}>
              <td className={cx(TD, "max-w-56")}>
                <div className="truncate font-medium" title={row.tool}>
                  {toolLabel(row.tool)}
                </div>
              </td>
              <td className={TD}>{row.calls.toLocaleString()}</td>
              <td className={cx(TD, row.failed > 0 && "text-rose-600 dark:text-rose-400")}>
                {row.failed ? `${row.failed.toLocaleString()} (${percent(row.failed / row.calls)})` : "0"}
              </td>
              <td className={TD}>{duration(row.avgMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentTable({ data }: { data: UsageData }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <tr>
            <th className={TH}>Agent</th>
            <th className={TH}>Requests</th>
            <th className={TH}>Tokens in</th>
            <th className={TH}>Tokens out</th>
            <th className={TH}>Cost</th>
            <th className={TH}>Per request</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
          {data.agents.map((row) => (
            <tr key={row.harness}>
              <td className={cx(TD, "font-medium")}>
                <Link to={`/runs?harness=${encodeURIComponent(row.harness)}`} className="hover:underline">
                  {harnessLabel(row.harness)}
                </Link>
              </td>
              <td className={TD}>{row.runs.toLocaleString()}</td>
              <td className={TD} title={tokenTitle(row)}>
                {tokens(tokensIn(row))}
              </td>
              <td className={TD}>{tokens(row.outputTokens)}</td>
              <td className={TD}>{cost(row.costUsd)}</td>
              <td className={TD}>{perRun(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
