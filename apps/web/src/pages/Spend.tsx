import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight, Coins } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type Usage, api } from "../api";
import { ago, cost, harnessLabel, plural, tokens } from "../format";
import { InOut, TokenBreakdown, percent, tokenTitle, tokensIn } from "../tokens";
import { Card, Empty, cx } from "../ui";

const PERIODS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

/** What the agents' model calls cost over a period, and which tokens, models and agents it went to. */
export function Spend() {
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
    <div className="space-y-5">
      <div className="flex w-fit rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            type="button"
            onClick={() => setDays(period.days)}
            aria-pressed={days === period.days}
            className={cx(
              "rounded-md px-3 py-1.5 text-sm",
              days === period.days ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
            )}
          >
            {period.label}
          </button>
        ))}
      </div>

      {!data || !totals ? (
        <div className="text-sm text-zinc-500">{usage.isError ? `Couldn't load spend: ${usage.error.message}` : "Loading…"}</div>
      ) : totals.runs === 0 ? (
        <Card>
          <Empty icon={<Coins className="size-8" />} title="No runs in this period">
            Spend and tokens show up here once your agents run.
          </Empty>
        </Card>
      ) : (
        <div className={cx("space-y-5 transition-opacity", usage.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Spend" value={`${cost(totals.costUsd)}${totals.unpricedRuns ? "+" : ""}`}>
              {plural(totals.runs, "run")} · {perRun(totals)} a run
            </Tile>
            <Tile label="Input tokens" value={tokens(tokensIn(totals))} title={tokenTitle(totals)}>
              {percent(totals.cacheReadTokens / Math.max(1, tokensIn(totals)))} read from cache
            </Tile>
            <Tile label="Output tokens" value={tokens(totals.outputTokens)}>
              {totals.reasoningTokens ? `${tokens(totals.reasoningTokens)} of it thinking` : `${tokens(totals.outputTokens / Math.max(1, totals.llmCalls))} per model call`}
            </Tile>
            <Tile label="Model calls" value={totals.llmCalls.toLocaleString()}>
              {tokens(tokensIn(totals) / Math.max(1, totals.llmCalls))} tokens read per call
            </Tile>
          </div>

          <Panel title="Spend over time">
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

          {data.top.length > 0 && (
            <Panel title="Most expensive runs" flush>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.top.map((run) => (
                  <li key={run.id}>
                    <Link to={`/runs/${run.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{run.name ?? "Untitled run"}</div>
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
              {plural(totals.unpricedRuns, "run")} used a model with no known price, so its cost isn't counted (the totals show a +).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Average cost of a run; unknown ("—") when no price was known. */
const perRun = (row: { costUsd: number | null; runs: number }) => (row.costUsd == null ? cost(null) : cost(row.costUsd / Math.max(1, row.runs)));

function Tile({ label, value, title, children }: { label: string; value: string; title?: string; children: ReactNode }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold" title={title}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{children}</div>
    </Card>
  );
}

function Panel({ title, note, flush, children }: { title: string; note?: string; flush?: boolean; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <h2 className="px-5 pt-4 text-sm font-semibold">{title}</h2>
      <div className={flush ? "mt-3" : "px-5 pt-4 pb-5"}>{children}</div>
      {note && <p className="border-t border-zinc-100 px-5 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">{note}</p>}
    </Card>
  );
}

type Bucket = { start: Date; label: string; short: string; costUsd: number; tokensIn: number; tokensOut: number; runs: number };

/** The period in the viewer's own hours (24 hours) or days, with each UTC hour from the server added in. */
function buckets(data: Usage): Bucket[] {
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

function SpendChart({ data }: { data: Usage }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const rows = buckets(data);
  const max = niceMax(Math.max(...rows.map((row) => row.costUsd)));
  if (!max) return <p className="text-sm text-zinc-500 dark:text-zinc-400">No cost was recorded in this period: the models used have no known price.</p>;
  // A label every few bars, so they never collide.
  const every = data.days === 1 ? 6 : rows.length > 10 ? 5 : 1;
  const shown = hover === null ? null : rows[hover]!;
  const describe = (row: Bucket) => `${row.label}: ${cost(row.costUsd)}, ${tokens(row.tokensIn)} tokens in, ${tokens(row.tokensOut)} out, ${plural(row.runs, "run")}`;
  return (
    <div>
      <div className="flex">
        <div className="flex h-44 w-14 shrink-0 flex-col justify-between pr-2 text-right text-[11px] text-zinc-400 tabular-nums">
          <span className="-translate-y-1/2">{cost(max)}</span>
          <span>{cost(max / 2)}</span>
          <span className="translate-y-1/2">$0</span>
        </div>
        <div className="relative h-44 flex-1 border-b border-zinc-300 dark:border-zinc-700">
          <div className="absolute inset-x-0 top-0 border-t border-zinc-100 dark:border-zinc-800" aria-hidden />
          <div className="absolute inset-x-0 top-1/2 border-t border-zinc-100 dark:border-zinc-800" aria-hidden />
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
                {tokens(shown.tokensIn)} in · {tokens(shown.tokensOut)} out · {plural(shown.runs, "run")}
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
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">{data.days === 1 ? "Hour" : "Day"}</th>
                <th className="px-3 py-1.5 text-right font-medium">Spend</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens in</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens out</th>
                <th className="px-3 py-1.5 text-right font-medium">Runs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
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

const TH = "px-3 py-2 text-right font-medium whitespace-nowrap first:pl-5 first:text-left last:pr-5";
const TD = "px-3 py-2.5 text-right tabular-nums whitespace-nowrap first:pl-5 first:text-left last:pr-5";

/** A thin bar for a row's share of the period's spend. */
function Share({ value, total }: { value: number | null; total: number | null }) {
  const share = total && value ? value / total : 0;
  return (
    <span className="flex items-center justify-end gap-2" title={`${percent(share)} of the spend`}>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{percent(share)}</span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <span className="block h-full rounded-full bg-series-1" style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  );
}

function ModelTable({ data }: { data: Usage }) {
  if (!data.models.length) return <p className="px-5 pb-5 text-sm text-zinc-500">No model calls in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-zinc-100 bg-zinc-50/60 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-white/[0.02] dark:text-zinc-400">
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
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
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

function AgentTable({ data }: { data: Usage }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-zinc-100 bg-zinc-50/60 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-white/[0.02] dark:text-zinc-400">
          <tr>
            <th className={TH}>Agent</th>
            <th className={TH}>Runs</th>
            <th className={TH}>Tokens in</th>
            <th className={TH}>Tokens out</th>
            <th className={TH}>Cost</th>
            <th className={TH}>Per run</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
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
