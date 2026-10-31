import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { type RunListItem, api } from "../api";
import { ago, cost, duration, harnessLabel, plural } from "../format";
import { SyncBanner } from "../syncs";
import { Card, Empty, RunDot, Stat, cx } from "../ui";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "error", label: "With errors" },
  { value: "running", label: "Running" },
];

export function Runs() {
  // Every filter lives in the URL, so a filtered view can be shared or bookmarked.
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const harness = params.get("harness") ?? "";
  const q = params.get("q") ?? "";
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const runs = useInfiniteQuery({
    queryKey: ["runs", status, harness, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" });
      if (status) query.set("status", status);
      if (harness) query.set("harness", harness);
      if (q) query.set("q", q);
      if (pageParam) query.set("before", pageParam);
      return api.runs(query);
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const day = overview.data?.last24h;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Every request your agents handled, newest first.</p>
        </div>
        <Card className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-3 sm:grid-cols-4">
          <Stat label="Runs today" value={day?.runs ?? "—"} hint="Runs that started in the last 24 hours" />
          <Stat label="With errors" value={day?.errors ?? "—"} hint="Runs in the last 24 hours that failed or had a failed step" tone={day?.errors ? "bad" : undefined} />
          <Stat label="Spend today" value={cost(day?.costUsd)} hint="Model cost of the last 24 hours. Claude Code's reported cost when available, otherwise list prices × tokens" />
          <Stat label="Avg duration" value={duration(day?.avgDurationMs)} hint="Average time from the request to the agent's last step" />
        </Card>
      </div>

      <SyncBanner />

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(event) => setParam("q", event.target.value)}
            placeholder="Search requests and answers…"
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pr-3 pl-9 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-400/30 dark:border-zinc-800 dark:bg-zinc-900"
          />
        </label>
        <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setParam("status", filter.value)}
              className={cx(
                "rounded-md px-3 py-1.5 text-sm",
                status === filter.value ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {(overview.data?.harnesses.length ?? 0) > 1 && (
          <select
            value={harness}
            onChange={(event) => setParam("harness", event.target.value)}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <option value="">All agents</option>
            {overview.data?.harnesses.map((h) => (
              <option key={h.harness} value={h.harness}>
                {harnessLabel(h.harness)} ({h.runs})
              </option>
            ))}
          </select>
        )}
      </div>

      <Card className="overflow-hidden">
        {runs.isPending ? (
          <div className="p-6 text-sm text-zinc-500">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<Activity className="size-8" />} title={q || status || harness ? "No runs match these filters" : "No runs yet"}>
            {q || status || harness ? (
              "Try clearing the search or filters."
            ) : (
              <>
                Connect an agent and its runs show up here live. <Link to="/connect" className="text-brand-700 underline">Connect one</Link>.
              </>
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
        {runs.hasNextPage && (
          <button type="button" onClick={() => void runs.fetchNextPage()} className="w-full border-t border-zinc-100 py-3 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
            {runs.isFetchingNextPage ? "Loading…" : "Show older runs"}
          </button>
        )}
      </Card>
    </div>
  );
}

function RunRow({ run }: { run: RunListItem }) {
  const facts = [
    harnessLabel(run.harness),
    run.model,
    run.llmCallCount ? plural(run.llmCallCount, "model call") : null,
    run.toolCallCount ? plural(run.toolCallCount, "tool call") : null,
  ].filter(Boolean);
  return (
    <li>
      <Link to={`/runs/${run.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
        <RunDot status={run.status} errorCount={run.errorCount} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className={cx("truncate text-sm font-medium", run.metadata?.systemTurn && "text-zinc-500 italic")}>{run.name ?? run.input ?? "Untitled run"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
            {facts.map((fact, i) => (
              <span key={i}>{fact}</span>
            ))}
            {run.errorCount > 0 && <span className="text-rose-600 dark:text-rose-400">{plural(run.errorCount, "failed step")}</span>}
            {run.sessionTitle && <span className="truncate text-zinc-400">· {run.sessionTitle}</span>}
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-xs tabular-nums text-zinc-500 sm:block">
          <div className="text-sm text-zinc-900 dark:text-zinc-100" title="Model cost of this run">
            {cost(run.costUsd)}
            {run.costIncomplete > 0 && <span title="Some model calls have no known price, so this is a minimum">+</span>}
          </div>
          <div title="Duration">{duration(run.durationMs)}</div>
        </div>
        <div className="w-20 shrink-0 text-right text-xs text-zinc-400" title={run.startedAt ?? undefined}>
          {ago(run.startedAt)}
        </div>
      </Link>
    </li>
  );
}
