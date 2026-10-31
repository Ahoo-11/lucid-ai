import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Lightbulb, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { type Issue, api } from "../api";
import { ago, plural } from "../format";
import { BRANDS, BrandMark } from "../landing/logos";
import { Card, Empty, KindIcon } from "../ui";

/** Problems that hit more than one run are patterns worth fixing; the rest are listed separately. */
export const isRecurring = (issue: Issue) => issue.runs >= 2;

export function Inbox() {
  const query = useQuery({
    queryKey: ["issues"],
    queryFn: api.issues,
    // While Muse Spark is still writing diagnoses, look again soon.
    refetchInterval: (q) => (q.state.data?.issues.some((issue) => issue.diagnosis?.status === "pending") ? 3_000 : false),
  });
  const [showOneOffs, setShowOneOffs] = useState(false);
  const all = query.data?.issues ?? [];
  const issues = all.filter(isRecurring);
  const oneOffs = all.filter((issue) => !isRecurring(issue));
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">What's going wrong, grouped by cause. The ones hitting the most runs come first.</p>
        {query.data?.diagnosisModel && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {isMuse(query.data.diagnosisModel) && <BrandMark brand={BRANDS.meta} className="size-3.5" />}
            Each problem is diagnosed by {isMuse(query.data.diagnosisModel) ? "Meta's Muse Spark" : query.data.diagnosisModel}, from the steps that failed.
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
            <IssueCard key={issue.id} issue={issue} />
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

function IssueCard({ issue }: { issue: Issue }) {
  // Muse Spark's diagnosis when it's ready; Lucid's rule of thumb meanwhile.
  const ai = issue.diagnosis?.status === "ready" ? issue.diagnosis : null;
  const shown = ai ?? issue;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <KindIcon kind={issue.kind} failed />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-semibold">{shown.title}</h2>
            <div className="text-xs text-zinc-500">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{plural(issue.runs, "run")}</span> · {plural(issue.occurrences, "time")} · last {ago(issue.lastSeen)}
            </div>
          </div>
          {ai ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 ring-1 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-400/20">
              {isMuse(ai.model) && <BrandMark brand={BRANDS.meta} className="size-3.5" />}
              Diagnosed by {modelLabel(ai.model)}
            </span>
          ) : issue.diagnosis?.status === "pending" ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Loader2 className="size-3 animate-spin" />
              Diagnosing this from the failed steps…
            </span>
          ) : null}
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{shown.why}</p>
          <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-500/10">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <span className="font-medium">Suggested fix: </span>
              {shown.fix}
            </div>
          </div>
          {issue.sample && (
            <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-2 font-mono text-[11px] text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400" title="An example of the error message">
              {issue.sample.split("\n").slice(0, 3).join("\n")}
            </pre>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Seen in:</span>
            {issue.examples.map((example) => (
              <Link key={example.runId} to={`/runs/${example.runId}`} className="max-w-64 truncate rounded-md bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
                {example.runName ?? "Run"}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
