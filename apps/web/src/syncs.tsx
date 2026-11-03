// "Bringing in past runs… 12 of 40": shown while an agent uploads its history,
// so a half-filled Runs list doesn't look like everything there is.

import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { type HistorySync, api } from "./api";
import { harnessLabel } from "./format";
import { SURFACE, cx } from "./ui";

export function useSyncs() {
  const query = useQuery({
    queryKey: ["syncs"],
    queryFn: api.syncs,
    // Often while something is coming in; now and then otherwise, to notice a new one.
    refetchInterval: (q) => (q.state.data?.syncs.some((sync) => !sync.finished) ? 2_000 : 20_000),
  });
  const syncs = query.data?.syncs ?? [];
  return { syncs, active: syncs.filter((sync) => !sync.finished) };
}

const unit = (harness: string) => (harness === "hermes" ? "conversations" : "sessions");

function Bar({ sync }: { sync: HistorySync }) {
  const share = sync.total ? Math.min(1, sync.done / sync.total) : 1;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
      <div
        className={cx("h-full rounded-full transition-[width] duration-700", sync.finished ? "bg-emerald-500" : "bg-brand-500 dark:bg-brand-300")}
        style={{ width: `${Math.max(4, share * 100)}%` }}
      />
    </div>
  );
}

/** Above the runs list: one line per agent whose history is coming in. */
export function SyncBanner() {
  const { syncs } = useSyncs();
  if (!syncs.length) return null;
  return (
    <div className="space-y-2">
      {syncs.map((sync) => (
        <div key={sync.id} className={cx(SURFACE, "flex items-center gap-4 px-5 py-4")}>
          <span
            className={cx(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              sync.finished ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" : "bg-brand-50 text-brand-700 dark:bg-brand-300/10 dark:text-brand-300",
            )}
          >
            {sync.finished ? <Check className="size-4" strokeWidth={2.5} /> : <Loader2 className="size-4 animate-spin" />}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">
                {sync.finished ? `All past runs from ${harnessLabel(sync.harness)} are in` : `Bringing in past runs from ${harnessLabel(sync.harness)}…`}
              </span>
              <span className="text-zinc-500 tabular-nums dark:text-zinc-400">
                {sync.done} of {sync.total} {unit(sync.harness)}
              </span>
            </div>
            <Bar sync={sync} />
            {!sync.finished && <p className="text-xs text-zinc-500 dark:text-zinc-400">Newest first. They keep appearing below, and new runs come in as usual.</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Under an agent's name on the Connect page. */
export function AgentSync({ harness }: { harness: string }) {
  const { syncs } = useSyncs();
  const sync = syncs.find((s) => s.harness === harness);
  if (!sync) return null;
  return (
    <div className="mt-2 max-w-xs space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        {sync.finished ? <Check className="size-3 text-emerald-500" /> : <Loader2 className="size-3 animate-spin" />}
        {sync.finished ? "Past runs synced" : `Syncing past runs · ${sync.done} of ${sync.total}`}
      </div>
      <Bar sync={sync} />
    </div>
  );
}
