import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { type RunListItem, api } from "../api";
import { ago, cost, duration, harnessLabel, plural } from "../format";
import { SyncBanner } from "../syncs";
import { InOut } from "../tokens";
import { Card, Empty, PageHeader, RunDot, Segmented, StatTile, TabBar, TabItem, cx } from "../ui";
import { Spend } from "./Spend";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "error", label: "With errors" },
  { value: "running", label: "Running" },
];

/** The run list, or what the runs cost (?view=spend). Every filter lives in the URL, so a view can be shared or bookmarked. */
export function Runs() {
  const [params, setParams] = useSearchParams();
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const day = overview.data?.last24h;
  const spend = params.get("view") === "spend";
  const showSpend = (on: boolean) => {
    // Each view keeps only its own settings in the URL.
    const next = new URLSearchParams();
    if (on) next.set("view", "spend");
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-8">
      <PageHeader title="Runs" sub={spend ? "What your agents' model calls cost, and where the tokens go." : "Every request your agents handled, newest first."} />

      {!spend && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Runs today" value={day?.runs ?? "—"} sub="Started in the last 24 hours" hint="Runs that started in the last 24 hours" />
          <StatTile
            label="With errors"
            value={day?.errors ?? "—"}
            sub="Failed, or had a failed step"
            hint="Runs in the last 24 hours that failed or had a failed step"
            tone={day?.errors ? "bad" : undefined}
          />
          <StatTile label="Spend today" value={cost(day?.costUsd)} sub="Model cost, last 24 hours" hint="Model cost of the last 24 hours. Claude Code's reported cost when available, otherwise list prices × tokens" />
          <StatTile label="Avg duration" value={duration(day?.avgDurationMs)} sub="Request to last step" hint="Average time from the request to the agent's last step" />
        </div>
      )}

      <div className="space-y-6">
        <TabBar>
          <TabItem current={!spend} onClick={() => showSpend(false)}>
            All runs
          </TabItem>
          <TabItem current={spend} onClick={() => showSpend(true)}>
            Spend and tokens
          </TabItem>
        </TabBar>

        {spend ? <Spend /> : <RunList />}
      </div>
    </div>
  );
}

function RunList() {
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

  return (
    <div className="space-y-5">
      <SyncBanner />

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(event) => setParam("q", event.target.value)}
            placeholder="Search requests and answers…"
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white pr-3 pl-10 text-sm shadow-[0_1px_2px_rgba(24,24,27,0.04)] outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 dark:border-white/10 dark:bg-zinc-900 dark:focus:border-white/25 dark:focus:ring-white/5"
          />
        </label>
        <Segmented label="Status" options={STATUS_FILTERS} value={status} onChange={(value) => setParam("status", value)} />
        {(overview.data?.harnesses.length ?? 0) > 1 && (
          <select
            value={harness}
            onChange={(event) => setParam("harness", event.target.value)}
            className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-zinc-900"
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
                Connect an agent and its runs show up here live.{" "}
                <Link to="/connect" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-white">
                  Connect one
                </Link>
                .
              </>
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
            {rows.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
        {runs.hasNextPage && (
          <button
            type="button"
            onClick={() => void runs.fetchNextPage()}
            className="w-full border-t border-zinc-100 py-3.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.03]"
          >
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
    run.durationMs != null ? duration(run.durationMs) : null,
  ].filter(Boolean);
  return (
    <li>
      <Link to={`/runs/${run.id}`} className="flex items-start gap-3.5 px-5 py-3.5 transition-colors hover:bg-zinc-50/80 dark:hover:bg-white/[0.03]">
        <RunDot status={run.status} errorCount={run.errorCount} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className={cx("truncate text-sm font-medium", run.metadata?.systemTurn && "text-zinc-500 italic")}>{run.name ?? run.input ?? "Untitled run"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
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
          {run.llmCallCount > 0 && <InOut t={run} />}
        </div>
        <div className="w-20 shrink-0 text-right text-xs text-zinc-400" title={run.startedAt ?? undefined}>
          {ago(run.startedAt)}
        </div>
      </Link>
    </li>
  );
}
