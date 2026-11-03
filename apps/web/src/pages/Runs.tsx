import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, Search } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router";
import { type SessionListItem, api } from "../api";
import { ago, cost, duration, harnessLabel, plural } from "../format";
import { SyncBanner } from "../syncs";
import { InOut } from "../tokens";
import { Card, Empty, PageHeader, RunDot, Segmented, StatTile } from "../ui";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "error", label: "With errors" },
  { value: "running", label: "Running" },
];

/** The sessions. Every filter lives in the URL, so a view can be shared or bookmarked. */
export function Runs() {
  const [params] = useSearchParams();
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const day = overview.data?.last24h;
  // Cost and tokens moved to the Usage tab; old links still land there.
  if (params.get("view") === "spend") return <Navigate to={`/usage${params.get("days") ? `?days=${params.get("days")}` : ""}`} replace />;

  return (
    <div className="space-y-8">
      <PageHeader title="Sessions" sub="Every conversation with your agents, newest first. Open one to read it like a chat." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Requests today" value={day?.runs ?? "—"} sub="Started in the last 24 hours" hint="Requests that started in the last 24 hours" />
        <StatTile
          label="With errors"
          value={day?.errors ?? "—"}
          sub="Failed, or had a failed step"
          hint="Requests in the last 24 hours that failed or had a failed step"
          tone={day?.errors ? "bad" : undefined}
        />
        <StatTile
          label="Cost today"
          value={cost(day?.costUsd)}
          sub={
            <Link to="/usage?days=1" className="hover:text-zinc-900 hover:underline dark:hover:text-white">
              See usage
            </Link>
          }
          hint="Model cost of the last 24 hours. Claude Code's reported cost when available, otherwise list prices × tokens"
        />
        <StatTile label="Avg duration" value={duration(day?.avgDurationMs)} sub="Request to last step" hint="Average time from the request to the agent's last step" />
      </div>

      <SessionList />
    </div>
  );
}

function SessionList() {
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
  const list = useInfiniteQuery({
    queryKey: ["sessions", status, harness, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" });
      if (status) query.set("status", status);
      if (harness) query.set("harness", harness);
      if (q) query.set("q", q);
      if (pageParam) query.set("before", pageParam);
      return api.sessions(query);
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.sessions) ?? [];

  return (
    <div className="space-y-5">
      <SyncBanner />

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(event) => setParam("q", event.target.value)}
            placeholder="Search requests, answers and session names…"
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
        {list.isPending ? (
          <div className="p-6 text-sm text-zinc-500">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<Activity className="size-8" />} title={q || status || harness ? "No sessions match these filters" : "No sessions yet"}>
            {q || status || harness ? (
              "Try clearing the search or filters."
            ) : (
              <>
                Connect an agent and its conversations show up here live.{" "}
                <Link to="/connect" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-white">
                  Connect one
                </Link>
                .
              </>
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
            {rows.map((row) => (
              <SessionRow key={row.id} row={row} />
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            className="w-full border-t border-zinc-100 py-3.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.03]"
          >
            {list.isFetchingNextPage ? "Loading…" : "Show older sessions"}
          </button>
        )}
      </Card>
    </div>
  );
}

/** One conversation: its name, its latest request when there are several, and what it all cost. */
function SessionRow({ row }: { row: SessionListItem }) {
  const title = row.title ?? row.firstRequest ?? "Untitled session";
  const status = row.running ? "running" : row.failed ? "error" : "ok";
  const facts = [
    harnessLabel(row.harness),
    row.model,
    plural(row.requests, "request"),
    row.toolCallCount ? plural(row.toolCallCount, "tool call") : null,
  ].filter(Boolean);
  return (
    <li>
      <Link to={`/sessions/${row.id}`} className="flex items-start gap-3.5 px-5 py-3.5 transition-colors hover:bg-zinc-50/80 dark:hover:bg-white/[0.03]">
        <RunDot status={status} errorCount={row.errorCount} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {row.requests > 1 && row.lastRequest && row.lastRequest !== title && (
            <div className="mt-0.5 truncate text-[13px] text-zinc-500 dark:text-zinc-400">Latest: {row.lastRequest}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
            {facts.map((fact, i) => (
              <span key={i}>{fact}</span>
            ))}
            {row.errorCount > 0 && <span className="text-rose-600 dark:text-rose-400">{plural(row.errorCount, "failed step")}</span>}
            {row.gitBranch && row.gitBranch !== "HEAD" && <span className="truncate text-zinc-400">· {row.gitBranch}</span>}
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-xs tabular-nums text-zinc-500 sm:block">
          <div className="text-sm text-zinc-900 dark:text-zinc-100" title="Model cost of every request in this session">
            {cost(row.costUsd)}
            {row.costIncomplete > 0 && <span title="Some model calls have no known price, so this is a minimum">+</span>}
          </div>
          {row.llmCallCount > 0 && <InOut t={row} />}
        </div>
        <div className="w-20 shrink-0 text-right text-xs text-zinc-400" title={row.lastStartedAt ?? undefined}>
          {ago(row.lastStartedAt)}
        </div>
      </Link>
    </li>
  );
}
