import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronUp, EyeOff, FlaskConical, ListChecks, Plus, Scale, Sparkles, Trophy, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { type BlindPair, type Candidate, type DecisionContext, type Experiment, type Output, type VariantInput, api } from "../api";
import { ago, cost, duration, plural, toolLabel } from "../format";
import { Card, Chip, Empty, Prose, Section, cx } from "../ui";

// ── List ──────────────────────────────────────────────────────────────────

export function Arena() {
  const list = useQuery({ queryKey: ["arena", "list"], queryFn: api.arena.list });
  const experiments = list.data?.experiments ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Arena</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Replay real decisions with other models or prompts, judge them blind, and switch with proof.</p>
      </div>
      {list.isPending ? null : experiments.length === 0 ? (
        <HowItWorks />
      ) : (
        <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {experiments.map((e) => (
            <Link key={e.id} to={`/arena/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <FlaskConical className="size-4 shrink-0 text-brand-600" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{e.name}</div>
                <div className="text-xs text-zinc-500">
                  {plural(e.decisions, "decision")} · {plural(e.candidates, "candidate")} · {plural(e.humanVotes, "vote")}
                  {e.judgeVotes ? ` · ${e.judgeVotes} judge votes` : ""}
                  {e.pending ? ` · ${e.pending} replays running` : ""}
                </div>
              </div>
              <span className={cx("rounded-full px-2 py-0.5 text-xs", e.revealed ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>
                {e.revealed ? "Revealed" : "Blind"}
              </span>
              <span className="w-20 text-right text-xs text-zinc-400">{ago(e.createdAt)}</span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StepCard icon={<ListChecks className="size-5" />} title="1. Pick a real decision">
          Open any run, click a model decision, and choose "Try this decision with another model or prompt".
        </StepCard>
        <StepCard icon={<EyeOff className="size-5" />} title="2. Compare blind">
          The same request goes to the models you pick. You, and optionally an AI judge, vote on unlabeled answers.
        </StepCard>
        <StepCard icon={<Trophy className="size-5" />} title="3. Switch with proof">
          Reveal which was which: "Model X wins 2 of 3 blind votes and costs 40% less."
        </StepCard>
      </div>
      <Card>
        <Empty icon={<FlaskConical className="size-8" />} title="No experiments yet">
          Start from a run. <Link to="/runs" className="text-brand-700 underline dark:text-brand-300">Open your runs</Link>
        </Empty>
      </Card>
    </div>
  );
}

function StepCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-2 text-brand-700 dark:text-brand-300">{icon}</div>
      <div className="font-medium">{title}</div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{children}</p>
    </Card>
  );
}

// ── Shared pieces ─────────────────────────────────────────────────────────

export function OutputView({ output }: { output: Output | null | undefined }) {
  if (!output || (!output.text && !output.toolCalls?.length)) return <p className="text-sm text-zinc-500">Did nothing.</p>;
  return (
    <div className="space-y-3">
      {output.toolCalls?.map((call, i) => (
        <div key={i} className="rounded-lg border border-sky-200 bg-sky-50/60 p-2 dark:border-sky-500/20 dark:bg-sky-500/5">
          <div className="mb-1 text-xs font-semibold text-sky-700 dark:text-sky-300">Uses {toolLabel(call.name)}</div>
          <pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}, null, 2)}</pre>
        </div>
      ))}
      {output.text && (
        <div className="max-h-80 overflow-auto">
          <Prose text={output.text} />
        </div>
      )}
    </div>
  );
}

function ContextView({ context }: { context: DecisionContext | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!context) return null;
  return (
    <div className="space-y-2 text-sm">
      <div>
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">The user asked</span>
        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap">{context.request ?? "(not captured)"}</p>
      </div>
      {(context.recent?.length || context.tools?.length) && (
        <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-300">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? "Hide" : "Show"} what the agent had seen
        </button>
      )}
      {open && (
        <div className="space-y-2">
          {context.recent?.map((m, i) => (
            <div key={i} className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-950">
              <div className="text-[11px] font-semibold uppercase text-zinc-500">{m.role}</div>
              <pre className="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{m.text}</pre>
            </div>
          ))}
          {context.tools?.length ? (
            <div className="flex flex-wrap gap-1">
              {context.tools.map((t) => (
                <Chip key={t}>{toolLabel(t)}</Chip>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ModelInput({ value, onChange, models, placeholder }: { value: string; onChange: (v: string) => void; models: { id: string }[]; placeholder: string }) {
  return (
    <>
      <input
        list="arena-models"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-400/30 dark:border-zinc-800 dark:bg-zinc-900"
      />
      <datalist id="arena-models">
        {models.map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
    </>
  );
}

// ── New experiment ────────────────────────────────────────────────────────

type DraftVariant = { model: string; prompt: string; mode: "append" | "replace"; promptOpen: boolean };
const emptyVariant = (): DraftVariant => ({ model: "", prompt: "", mode: "append", promptOpen: false });

export function NewExperiment() {
  const [params] = useSearchParams();
  const stepId = params.get("step") ?? "";
  const runId = params.get("run") ?? "";
  const navigate = useNavigate();
  const models = useQuery({ queryKey: ["arena", "models"], queryFn: api.arena.models, staleTime: 60_000 });
  const check = useQuery({ queryKey: ["arena", "check", stepId], queryFn: () => api.arena.check(stepId), enabled: !!stepId });
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId), enabled: !!runId });
  const [variants, setVariants] = useState<DraftVariant[]>([emptyVariant()]);
  const [judge, setJudge] = useState("");
  const [allDecisions, setAllDecisions] = useState(false);
  useEffect(() => {
    if (!judge && models.data?.suggestedJudge) setJudge(models.data.suggestedJudge);
  }, [models.data, judge]);
  // A key for one model (Muse Spark on Baseten): it's the challenger, so fill it in.
  const onlyModel = models.data?.provider === "baseten" && models.data.models.length === 1 ? models.data.models[0]!.id : null;
  useEffect(() => {
    if (onlyModel) setVariants((all) => (all.length === 1 && !all[0]!.model ? [{ ...all[0]!, model: onlyModel }] : all));
  }, [onlyModel]);

  const step = run.data?.steps.find((s) => s.id === stepId);
  const otherDecisions = (run.data?.steps ?? []).filter((s) => s.kind === "llm" && s.id !== stepId && s.status === "ok");
  const priceOf = useMemo(() => new Map(models.data?.models.map((m) => [m.id, m]) ?? []), [models.data]);
  // Rough estimate: every replay sees about as much input as the original call.
  const contextTokens = step ? (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0) : 0;
  const decisions = allDecisions ? 1 + otherDecisions.length : 1;
  const estimate = variants.reduce((sum, v) => {
    const price = priceOf.get(v.model.trim());
    return price?.inputPerMillion != null && price.outputPerMillion != null
      ? sum + decisions * ((contextTokens * price.inputPerMillion + 500 * price.outputPerMillion) / 1_000_000)
      : sum;
  }, 0);

  const create = useMutation({
    mutationFn: () =>
      api.arena.create({
        stepIds: allDecisions ? [stepId, ...otherDecisions.map((s) => s.id)] : [stepId],
        judgeModel: judge.trim() || undefined,
        variants: variants
          .filter((v) => v.model.trim())
          .map<VariantInput>((v) => ({ model: v.model.trim(), ...(v.prompt.trim() ? { systemPrompt: v.prompt, promptMode: v.mode } : {}) })),
      }),
    onSuccess: (created) => navigate(`/arena/${created.id}`),
  });

  const update = (i: number, patch: Partial<DraftVariant>) => setVariants((all) => all.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const ready = variants.some((v) => v.model.trim()) && check.data?.ok && models.data?.configured;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={runId ? `/runs/${runId}` : "/arena"} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft className="size-4" /> Back
      </Link>
      <div>
        <h1 className="text-xl font-semibold">Test a decision</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The exact request the agent sent goes to each model you pick. Tools are offered but never run: you compare the next step it would take.
        </p>
      </div>

      {models.data && !models.data.configured && (
        <Card className="border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          Replays need a model key. Set <code className="font-mono">BASETEN_API_KEY</code> (Meta's Muse Spark) or <code className="font-mono">OPENROUTER_API_KEY</code> (one key reaches every model) for the Lucid server and restart it.
        </Card>
      )}
      {check.data && !check.data.ok && <Card className="border-rose-300 bg-rose-50 p-4 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">{check.data.reason}</Card>}

      <Card className="space-y-3 p-4">
        <Section title="The decision" hint="What the agent actually did at this point">
          <p className="text-sm">
            {run.data?.run.name ?? "…"}
            {step?.outputPreview && <span className="block text-zinc-500 dark:text-zinc-400">Original: {step.outputPreview}</span>}
          </p>
          {check.data?.ok && (
            <p className="text-xs text-zinc-500">
              Replays send {plural(check.data.messages, "message")} and {plural(check.data.tools, "tool definition")}, exactly as captured.
            </p>
          )}
        </Section>
        {otherDecisions.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDecisions} onChange={(e) => setAllDecisions(e.target.checked)} className="accent-brand-600" />
            Also test the other {plural(otherDecisions.length, "decision")} in this run (more votes, more confidence)
          </label>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <Section title="Contenders" hint="The original is always included, under a blind label like the others">
          <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-950">
            <Check className="size-4 text-emerald-500" />
            <span className="font-medium">The original</span>
            <span className="text-zinc-500">what the agent actually did{run.data?.run.model ? ` (${run.data.run.model})` : ""}</span>
          </div>
          {variants.map((variant, i) => {
            const price = priceOf.get(variant.model.trim());
            return (
              <div key={i} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <ModelInput value={variant.model} onChange={(model) => update(i, { model })} models={models.data?.models ?? []} placeholder={onlyModel ? `Model, e.g. ${onlyModel}` : "Model, e.g. openai/gpt-5-mini"} />
                  {variants.length > 1 && (
                    <button type="button" onClick={() => setVariants((all) => all.filter((_, j) => j !== i))} className="rounded-md p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" title="Remove">
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                {price && (
                  <div className="text-xs text-zinc-500">
                    {price.name}
                    {price.inputPerMillion != null && price.outputPerMillion != null
                      ? ` · $${price.inputPerMillion.toFixed(2)} / $${price.outputPerMillion.toFixed(2)} per million tokens in / out`
                      : " · runs on your Baseten credits"}
                  </div>
                )}
                {variant.model.trim() && !price && models.data?.models.length ? <div className="text-xs text-amber-600">Not in the tool-capable model list; it may not support tools.</div> : null}
                <button type="button" onClick={() => update(i, { promptOpen: !variant.promptOpen })} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-300">
                  {variant.promptOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  Change the system prompt too
                </button>
                {variant.promptOpen && (
                  <div className="space-y-2">
                    <div className="flex gap-3 text-xs">
                      {(["append", "replace"] as const).map((mode) => (
                        <label key={mode} className="flex items-center gap-1">
                          <input type="radio" checked={variant.mode === mode} onChange={() => update(i, { mode })} className="accent-brand-600" />
                          {mode === "append" ? "Add to the end of the system prompt" : "Replace the system prompt"}
                        </label>
                      ))}
                    </div>
                    <textarea
                      value={variant.prompt}
                      onChange={(e) => update(i, { prompt: e.target.value })}
                      rows={4}
                      placeholder="e.g. Always look at files with your tools before answering questions about them."
                      className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </div>
                )}
              </div>
            );
          })}
          {variants.length < 4 && (
            <button
              type="button"
              // With one model on offer, another contender means the same model with a different prompt.
              onClick={() => setVariants((all) => [...all, onlyModel ? { ...emptyVariant(), model: onlyModel, promptOpen: true } : emptyVariant()])}
              className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-300"
            >
              <Plus className="size-4" /> {onlyModel ? "Add Muse Spark with a different prompt" : "Add another model or prompt"}
            </button>
          )}
        </Section>
      </Card>

      <Card className="space-y-2 p-4">
        <Section title="AI judge (optional)" hint="A second opinion. It never sees model names and votes twice with the order swapped; a verdict counts only if it doesn't flip.">
          <ModelInput value={judge} onChange={setJudge} models={models.data?.models ?? []} placeholder="Judge model" />
        </Section>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-zinc-500">{estimate > 0 ? `Replays cost about ${cost(estimate)} on your key` : ""}</span>
        <button
          type="button"
          disabled={!ready || create.isPending}
          onClick={() => create.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-300 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-brand-200 disabled:opacity-40"
        >
          <FlaskConical className="size-4" />
          {create.isPending ? "Starting…" : "Start the blind test"}
        </button>
      </div>
      {create.isError && <p className="text-sm text-rose-600">{create.error.message}</p>}
    </div>
  );
}

// ── Experiment ────────────────────────────────────────────────────────────

export function ExperimentPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["arena", "experiment", id],
    queryFn: () => api.arena.get(id),
    refetchInterval: (q) => (q.state.data && (q.state.data.progress.replays.pending > 0 || q.state.data.progress.judging) ? 1500 : false),
  });
  const pair = useQuery({ queryKey: ["arena", "pair", id], queryFn: () => api.arena.pair(id), enabled: !!detail.data && detail.data.progress.replays.pending === 0 });
  const models = useQuery({ queryKey: ["arena", "models"], queryFn: api.arena.models, staleTime: 60_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["arena"] });
  const vote = useMutation({
    mutationFn: (winner: "a" | "b" | "tie") => {
      const p = pair.data!.pair!;
      return api.arena.vote(id, { itemId: p.itemId, a: p.a.trialId, b: p.b.trialId, winner });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["arena", "pair", id], next);
      void queryClient.invalidateQueries({ queryKey: ["arena", "experiment", id] });
    },
  });
  const [judgeModel, setJudgeModel] = useState("");
  const judge = useMutation({ mutationFn: () => api.arena.judge(id, judgeModel || undefined), onSuccess: refresh });
  const reveal = useMutation({ mutationFn: () => api.arena.reveal(id), onSuccess: refresh });
  const retry = useMutation({ mutationFn: () => api.arena.retry(id), onSuccess: refresh });

  // 1 / 2 / 3 vote: A, B, tie.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (!pair.data?.pair || vote.isPending) return;
      const winner = ({ "1": "a", "2": "b", "3": "tie" } as const)[event.key as "1" | "2" | "3"];
      if (winner) vote.mutate(winner);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pair.data, vote]);

  if (detail.isPending) return <div className="text-sm text-zinc-500">Loading…</div>;
  if (detail.isError || !detail.data) return <div className="text-sm text-rose-600">{String(detail.error?.message ?? "Not found")}</div>;
  const data = detail.data;
  const { progress } = data;
  const replaying = progress.replays.pending > 0;

  return (
    <div className="space-y-5">
      <Link to="/arena" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft className="size-4" /> Arena
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{data.experiment.name}</h1>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
          <span>{plural(data.items.length, "decision")}</span>
          <span>{plural(data.candidates.length, "candidate")}</span>
          <span>
            Replays {progress.replays.done}/{progress.replays.total}
            {progress.replays.failed ? <span className="text-rose-600"> · {progress.replays.failed} failed</span> : null}
          </span>
          <span>
            Your votes {progress.humanVotes}/{progress.pairs}
          </span>
          <span>
            AI judge {progress.judgeVotes}/{progress.pairs}
          </span>
        </div>
      </div>

      {replaying ? (
        <Card className="flex items-center gap-3 p-5 text-sm">
          <span className="size-2 animate-pulse rounded-full bg-amber-400" />
          Replaying the decision with each candidate… {progress.replays.done} of {progress.replays.total} done.
        </Card>
      ) : pair.data?.pair ? (
        <VotePanel pair={pair.data} index={data.items.findIndex((i) => i.id === pair.data!.pair!.itemId)} total={data.items.length} onVote={(w) => vote.mutate(w)} busy={vote.isPending} />
      ) : (
        <Card className="flex items-center gap-3 p-5 text-sm">
          <Check className="size-4 text-emerald-500" />
          {progress.humanVotes ? "You've voted on every pair." : "Nothing to vote on: no pair of candidates finished."}
          {!data.experiment.revealed && progress.humanVotes > 0 && " Reveal which candidate is which below."}
        </Card>
      )}

      {progress.replays.failed > 0 && (
        <button type="button" onClick={() => retry.mutate()} className="text-sm text-brand-700 underline dark:text-brand-300">
          Retry {plural(progress.replays.failed, "failed replay")}
        </button>
      )}

      <Card className="space-y-3 p-4">
        <Section title="AI judge" hint="Votes on every pair, twice with the order swapped. A verdict that flips counts as a tie.">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-64 flex-1">
              <ModelInput value={judgeModel || data.experiment.judgeModel || ""} onChange={setJudgeModel} models={models.data?.models ?? []} placeholder="Judge model" />
            </div>
            <button
              type="button"
              disabled={replaying || progress.judging || judge.isPending || !(judgeModel || data.experiment.judgeModel)}
              onClick={() => judge.mutate()}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Scale className="size-4" />
              {progress.judging ? "Judging…" : progress.judgeVotes ? "Judge new pairs" : "Ask the AI judge"}
            </button>
          </div>
          {data.agreement.compared > 0 && (
            <p className="text-sm">
              The judge agreed with you on <span className="font-semibold">{data.agreement.agreed} of {data.agreement.compared}</span> pairs you both judged.
            </p>
          )}
          {judge.isError && <p className="text-sm text-rose-600">{judge.error.message}</p>}
        </Section>
      </Card>

      <Results data={data} onReveal={() => reveal.mutate()} revealing={reveal.isPending} />
    </div>
  );
}

function VotePanel({ pair, index, total, onVote, busy }: { pair: BlindPair; index: number; total: number; onVote: (w: "a" | "b" | "tie") => void; busy: boolean }) {
  const p = pair.pair!;
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Which next step is better?</h2>
        <span className="text-xs text-zinc-500">
          Decision {index + 1} of {total} · comparison {pair.progress.voted + 1} of {pair.progress.total}
        </span>
      </div>
      <ContextView context={p.context} />
      <div className="grid gap-3 md:grid-cols-2">
        {(["a", "b"] as const).map((side) => (
          <div key={side} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Response {side.toUpperCase()}</div>
            <OutputView output={p[side].output} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <VoteButton onClick={() => onVote("a")} disabled={busy} hotkey="1">
          A is better
        </VoteButton>
        <VoteButton onClick={() => onVote("tie")} disabled={busy} hotkey="3">
          About the same
        </VoteButton>
        <VoteButton onClick={() => onVote("b")} disabled={busy} hotkey="2">
          B is better
        </VoteButton>
      </div>
    </Card>
  );
}

function VoteButton({ onClick, disabled, hotkey, children }: { onClick: () => void; disabled: boolean; hotkey: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium hover:border-brand-500 hover:bg-brand-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-brand-400/10"
    >
      {children}
      <kbd className="rounded border border-zinc-300 px-1 font-mono text-[10px] text-zinc-500 dark:border-zinc-600">{hotkey}</kbd>
    </button>
  );
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`);

function candidateName(c: Candidate) {
  if (c.kind === "original") return `The original${c.model ? ` (${c.model})` : ""}`;
  if (!c.model) return c.label;
  return c.systemPrompt ? `${c.model} + prompt change` : c.model;
}

function Results({ data, onReveal, revealing }: { data: Experiment; onReveal: () => void; revealing: boolean }) {
  const revealed = data.experiment.revealed;
  const useHuman = data.progress.humanVotes > 0;
  const ranked = [...data.candidates].sort((a, b) => ((useHuman ? b.human : b.judge)?.rating ?? -Infinity) - ((useHuman ? a.human : a.judge)?.rating ?? -Infinity));
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Section title="Standings" hint="Ratings use the Bradley-Terry model (as Elo-style leaderboards do); ties count as half a win.">
          <span />
        </Section>
        {!revealed && (
          <button
            type="button"
            onClick={onReveal}
            disabled={revealing || (data.progress.humanVotes === 0 && data.progress.judgeVotes === 0)}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
            title="Shows which model and prompt each candidate is. Vote first, so the names can't sway you."
          >
            <Sparkles className="size-4" /> Reveal which is which
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr className="border-b border-zinc-100 dark:border-zinc-800">
              <th className="py-2 pr-3 font-medium">Candidate</th>
              <th className="py-2 pr-3 font-medium" title="Your blind votes: wins + half of ties, over comparisons">Your votes</th>
              <th className="py-2 pr-3 font-medium" title="The AI judge's blind votes">AI judge</th>
              <th className="py-2 pr-3 font-medium" title="Average model cost per decision">Cost</th>
              <th className="py-2 pr-3 font-medium" title="Average time to decide">Speed</th>
              {revealed && <th className="py-2 pr-3 font-medium" title="How often it chose the same tools as the original">Same tools as original</th>}
            </tr>
          </thead>
          <tbody>
            {ranked.map((c) => (
              <tr key={c.id} className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/60">
                <td className="py-2 pr-3">
                  <div className="font-medium">{revealed ? candidateName(c) : c.label}</div>
                  {revealed && c.systemPrompt && <div className="max-w-sm truncate text-xs text-zinc-500" title={c.systemPrompt}>{c.promptMode === "replace" ? "Prompt: " : "Added: "}{c.systemPrompt}</div>}
                  {c.trials.failed > 0 && <div className="text-xs text-rose-600">{plural(c.trials.failed, "replay")} failed{revealed && c.errors?.[0] ? `: ${c.errors[0]}` : ""}</div>}
                </td>
                <td className="py-2 pr-3 tabular-nums">
                  {pct(c.human?.winRate)}
                  {c.human?.games ? <span className="ml-1 text-xs text-zinc-400">{c.human.wins}–{c.human.ties}–{c.human.losses}</span> : null}
                </td>
                <td className="py-2 pr-3 tabular-nums">{pct(c.judge?.winRate)}</td>
                <td className="py-2 pr-3 tabular-nums">{cost(c.avgCostUsd)}</td>
                <td className="py-2 pr-3 tabular-nums">{duration(c.avgLatencyMs)}</td>
                {revealed && <td className="py-2 pr-3 tabular-nums">{pct(c.sameToolAsOriginal)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {revealed && <Recommendation data={data} ranked={ranked} useHuman={useHuman} />}
    </Card>
  );
}

function Recommendation({ data, ranked, useHuman }: { data: Experiment; ranked: Candidate[]; useHuman: boolean }) {
  const best = ranked[0];
  const original = data.candidates.find((c) => c.kind === "original");
  if (!best || !original) return null;
  const standing = (c: Candidate) => (useHuman ? c.human : c.judge);
  const votes = useHuman ? data.progress.humanVotes : data.progress.judgeVotes;
  const source = useHuman ? "your blind votes" : "the AI judge's blind votes";
  const thin = data.items.length < 5;
  const costChange = best.avgCostUsd !== null && original.avgCostUsd ? (best.avgCostUsd - original.avgCostUsd) / original.avgCostUsd : null;
  const costText =
    costChange !== null && Math.abs(costChange) >= 0.05 ? `costs ${Math.round(Math.abs(costChange) * 100)}% ${costChange < 0 ? "less" : "more"} per decision than the original` : null;
  // Equal ratings mean nobody won; calling a tie a "win" would push a switch the votes don't support.
  const tied = best.id !== original.id && standing(best)?.rating === standing(original)?.rating;

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 dark:border-brand-400/30 dark:bg-brand-400/10">
      <div className="flex items-start gap-3">
        <Trophy className="mt-0.5 size-5 shrink-0 text-brand-700 dark:text-brand-300" />
        <div className="space-y-1 text-sm">
          {best.id === original.id ? (
            <p className="font-semibold">Keep what you have: the original won {pct(standing(original)?.winRate)} of {source}.</p>
          ) : tied ? (
            <p className="font-semibold">
              No clear winner: {candidateName(best)} tied with the original in {source}
              {costText && costChange! < 0 ? `, and it ${costText}. Worth testing on more decisions.` : "."}
            </p>
          ) : (
            <p className="font-semibold">
              {candidateName(best)} won {pct(standing(best)?.winRate)} of {source}
              {costText ? ` and ${costText}` : ""}.
            </p>
          )}
          <p className="text-zinc-600 dark:text-zinc-300">
            Based on {plural(votes, "vote")} over {plural(data.items.length, "decision")}.
            {thin && " That's a small sample: add more decisions before switching for good."}
          </p>
        </div>
      </div>
    </div>
  );
}
