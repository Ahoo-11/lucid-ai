import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FlaskConical } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { type RunDetail, type Step, api } from "../api";
import { cost, dateTime, duration, harnessLabel, mcpParts, plural, tokens, toolLabel } from "../format";
import { type Node, type Row, type Turn, argSummary, buildTree, contextTokens, story, toRows, toTurns } from "../story";
import { Card, Chip, KindIcon, Prose, Section, Stat, StatusDot, StatusPill, cx, kindLabel } from "../ui";

export function RunPage() {
  const { id = "" } = useParams();
  const query = useQuery({ queryKey: ["run", id], queryFn: () => api.run(id) });
  const [selected, setSelected] = useState<string | null>(null);
  const data = query.data;
  const tree = useMemo(() => (data ? buildTree(data.steps) : []), [data]);
  const order = useMemo(() => data?.steps.map((step) => step.externalId) ?? [], [data]);

  // j / k walk through steps, like an inbox.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key !== "j" && event.key !== "k") return;
      const index = selected ? order.indexOf(selected) : -1;
      const next = order[Math.min(order.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
      if (next) setSelected(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected]);

  if (query.isPending) return <div className="text-sm text-zinc-500">Loading run…</div>;
  if (query.isError || !data) return <div className="text-sm text-rose-600">Could not load this run: {String(query.error?.message ?? "not found")}</div>;

  const { run } = data;
  const step = data.steps.find((s) => s.externalId === selected) ?? null;
  const context = Math.max(0, ...data.steps.filter((s) => s.kind === "llm").map(contextTokens));

  return (
    <div className="space-y-5">
      <RunHeader data={data} />

      <Card className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Duration" value={duration(run.durationMs)} hint="From the request to the agent's last step" />
        <Stat
          label="Cost"
          value={`${cost(run.costUsd)}${run.costIncomplete ? "+" : ""}`}
          hint={run.costIncomplete ? "Some model calls have no known price, so this is a minimum" : "Total model cost of this run, including sub-agents"}
        />
        <Stat label="Model calls" value={run.llmCallCount} hint="How many times the agent asked the model what to do next" />
        <Stat label="Tool calls" value={run.toolCallCount} hint="Actions the agent took: reading files, running commands, calling APIs, launching sub-agents" />
        <Stat label="Failed steps" value={run.errorCount} hint="Tool calls or model calls that returned an error" tone={run.errorCount ? "bad" : undefined} />
        <Stat
          label="Largest context"
          value={tokens(context)}
          hint="The most tokens the model had to read in a single call (new input + cached). Large contexts are slower and cost more."
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <div className="min-w-0 space-y-5">
          <RequestAndAnswer data={data} />
          <Card className="p-4">
            <Section title="What happened" hint="Each model decision and the actions it led to. Press j / k to step through.">
              <Timeline nodes={tree} selected={selected} onSelect={setSelected} />
            </Section>
          </Card>
        </div>
        <div className="min-w-0">
          <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
            {step ? (
              <StepDetail step={step} steps={data.steps} onClose={() => setSelected(null)} />
            ) : (
              <Card className="p-5 text-sm text-zinc-500 dark:text-zinc-400">
                <div className="font-medium text-zinc-900 dark:text-zinc-100">Pick a step</div>
                <p className="mt-1">
                  Click any decision to see what the agent knew, which tools it could have used, what it chose and why. Click an action to see its input and result.
                </p>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunHeader({ data }: { data: RunDetail }) {
  const { run, session, sessionRuns } = data;
  const index = sessionRuns.findIndex((r) => r.id === run.id);
  const prev = index > 0 ? sessionRuns[index - 1] : undefined;
  const next = index >= 0 && index < sessionRuns.length - 1 ? sessionRuns[index + 1] : undefined;
  const parts = story(buildTree(data.steps), run.status);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-sm text-zinc-500">
        <Link to="/runs" className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
          <ArrowLeft className="size-4" /> Runs
        </Link>
        {sessionRuns.length > 1 && (
          <div className="flex items-center gap-1">
            <span className="mr-1 hidden sm:inline">
              Request {index + 1} of {sessionRuns.length} in this session
            </span>
            <NavButton to={prev && `/runs/${prev.id}`} label="Previous request">
              <ChevronLeft className="size-4" />
            </NavButton>
            <NavButton to={next && `/runs/${next.id}`} label="Next request">
              <ChevronRight className="size-4" />
            </NavButton>
          </div>
        )}
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className={cx("text-xl font-semibold", run.metadata?.systemTurn && "text-zinc-500 italic")}>{run.name ?? "Untitled run"}</h1>
          <StatusPill status={run.status} errorCount={run.errorCount} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-zinc-500 dark:text-zinc-400">
          <span>{harnessLabel(run.harness)}</span>
          {run.model && <span>{run.model}</span>}
          <span>{dateTime(run.startedAt)}</span>
          {session?.title && <span className="truncate">Session: {session.title}</span>}
          {session?.gitBranch && session.gitBranch !== "HEAD" && <span>on {session.gitBranch}</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs" title="The run in one line: tools used in order, repeats grouped">
        {parts.map((part, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="size-3 text-zinc-400" />}
            <span
              className={cx(
                "rounded-md px-2 py-0.5 font-medium",
                part.kind === "end"
                  ? part.status === "error"
                    ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
                    : part.status === "running"
                      ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                  : part.kind === "agent"
                    ? "bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
              )}
            >
              {part.label}
              {part.count > 1 && ` ×${part.count}`}
              {part.failed > 0 && <span className="text-rose-600 dark:text-rose-400"> ({part.failed} failed)</span>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function NavButton({ to, label, children }: { to?: string; label: string; children: ReactNode }) {
  if (!to) return <span className="rounded-md p-1 opacity-30">{children}</span>;
  return (
    <Link to={to} title={label} className="rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
      {children}
    </Link>
  );
}

function Expandable({ text, lines = 6 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div>
      <div className={cx(!open && long && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
        <Prose text={text} />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-300">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function RequestAndAnswer({ data }: { data: RunDetail }) {
  const { run } = data;
  return (
    <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
      <div className="p-4">
        <Section title="Request" hint="What the agent was asked, verbatim">
          {run.input ? <Expandable text={run.input} /> : <p className="text-sm text-zinc-500">The request wasn't captured.</p>}
        </Section>
      </div>
      <div className="p-4">
        <Section title="Answer" hint="The agent's final reply">
          {run.output ? (
            <Expandable text={run.output} />
          ) : (
            <p className="text-sm text-zinc-500">{run.status === "running" ? "Still working…" : "No final answer was captured."}</p>
          )}
        </Section>
      </div>
    </Card>
  );
}

function Timeline({ nodes, selected, onSelect, depth = 0 }: { nodes: Node[]; selected: string | null; onSelect: (id: string) => void; depth?: number }) {
  const rows = toRows(toTurns(nodes));
  if (rows.length === 0) return <p className="text-sm text-zinc-500">No steps captured yet.</p>;
  return (
    <ol className="space-y-1">
      {rows.map((row, i) =>
        row.type === "repeat" ? (
          <RepeatRow key={i} row={row} selected={selected} onSelect={onSelect} depth={depth} />
        ) : (
          <TurnRows key={i} turn={row.turn} selected={selected} onSelect={onSelect} depth={depth} />
        ),
      )}
    </ol>
  );
}

function chosenLabel(turn: Turn) {
  const tools = [...new Set(turn.actions.filter((a) => a.step.kind === "tool" || a.step.kind === "agent").map((a) => (a.step.kind === "agent" ? "a sub-agent" : toolLabel(a.step.toolName ?? a.step.name))))];
  if (tools.length) return `Decided to use ${tools.join(", ")}`;
  if (turn.llm?.status === "error") return "Model call failed";
  if (turn.llm?.outputPreview) return "Answered";
  return "Thought";
}

function StepButton({ step, selected, onSelect, children, meta }: { step: Step; selected: boolean; onSelect: (id: string) => void; children: ReactNode; meta?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(step.externalId)}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-brand-50 ring-1 ring-brand-400 dark:bg-brand-400/10 dark:ring-brand-400/40" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
      )}
    >
      <KindIcon kind={step.kind} failed={step.status === "error"} size="sm" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{meta}</span>
    </button>
  );
}

function TurnRows({ turn, selected, onSelect, depth }: { turn: Turn; selected: string | null; onSelect: (id: string) => void; depth: number }) {
  return (
    <li>
      {turn.llm && (
        <StepButton step={turn.llm} selected={selected === turn.llm.externalId} onSelect={onSelect} meta={<>{duration(turn.llm.durationMs)} · {cost(turn.llm.costUsd)}</>}>
          <span className="font-medium">{chosenLabel(turn)}</span>
          {turn.llm.outputPreview && !turn.llm.outputPreview.startsWith("Calls ") && (
            <span className="ml-2 text-zinc-500 dark:text-zinc-400">{turn.llm.outputPreview}</span>
          )}
        </StepButton>
      )}
      {turn.actions.length > 0 && (
        <ol className={cx("space-y-0.5", turn.llm && "ml-4 border-l border-zinc-200 pl-2 dark:border-zinc-800")}>
          {turn.actions.map((action) => (
            <ActionRow key={action.step.externalId} node={action} selected={selected} onSelect={onSelect} depth={depth} />
          ))}
        </ol>
      )}
    </li>
  );
}

function ActionRow({ node, selected, onSelect, depth }: { node: Node; selected: string | null; onSelect: (id: string) => void; depth: number }) {
  const { step } = node;
  const [open, setOpen] = useState(depth === 0);
  const arg = argSummary(step);
  const mcp = step.toolName ? mcpParts(step.toolName) : null;
  const label = step.kind === "agent" ? `Sub-agent: ${step.name}` : toolLabel(step.toolName ?? step.name);
  return (
    <li>
      <div className="flex items-center">
        {node.children.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} className="mr-0.5 rounded p-0.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" title={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <StepButton
            step={step}
            selected={selected === step.externalId}
            onSelect={onSelect}
            meta={
              <>
                {step.status === "running" ? "running" : duration(step.durationMs)}
                {node.children.length > 0 && ` · ${plural(node.children.length, "step")}`}
              </>
            }
          >
            <span className={cx("font-medium", step.status === "error" && "text-rose-600 dark:text-rose-400")}>{label}</span>
            {mcp && <span className="ml-1.5 text-xs text-zinc-400">{mcp.server}</span>}
            {arg && <span className="ml-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">{arg}</span>}
            {step.status === "error" && step.error && <span className="ml-2 text-xs text-rose-600/80 dark:text-rose-400/80">{step.error.split("\n")[0]}</span>}
          </StepButton>
        </div>
      </div>
      {open && node.children.length > 0 && (
        <div className="mt-1 mb-2 ml-5 rounded-lg border border-teal-200 bg-teal-50/40 p-2 dark:border-teal-500/20 dark:bg-teal-500/5">
          <Timeline nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
        </div>
      )}
    </li>
  );
}

function RepeatRow({ row, selected, onSelect, depth }: { row: Extract<Row, { type: "repeat" }>; selected: string | null; onSelect: (id: string) => void; depth: number }) {
  const [open, setOpen] = useState(false);
  const ids = row.turns.flatMap((turn) => [turn.llm?.externalId, ...turn.actions.map((a) => a.step.externalId)]);
  const containsSelected = selected !== null && ids.includes(selected);
  const total = row.turns.reduce((sum, turn) => sum + (turn.llm?.durationMs ?? 0) + turn.actions.reduce((s, a) => s + (a.step.durationMs ?? 0), 0), 0);
  if (open || containsSelected) {
    return (
      <li>
        <button type="button" onClick={() => setOpen(false)} className="mb-1 inline-flex items-center gap-1 px-2 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          <ChevronDown className="size-3.5" /> {row.tool} ×{row.turns.length}
        </button>
        <ol className="space-y-1">
          {row.turns.map((turn, i) => (
            <TurnRows key={i} turn={turn} selected={selected} onSelect={onSelect} depth={depth} />
          ))}
        </ol>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        title="Consecutive decisions that each used this tool once and succeeded"
      >
        <KindIcon kind="tool" size="sm" />
        <span className="flex-1">
          <span className="font-medium">{row.tool}</span>
          <span className="ml-2 text-zinc-500">×{row.turns.length} in a row</span>
        </span>
        <span className="text-xs tabular-nums text-zinc-400">{duration(total)}</span>
        <ChevronRight className="size-3.5 text-zinc-400" />
      </button>
    </li>
  );
}

function useBlob(hash: string | null) {
  return useQuery({ queryKey: ["blob", hash], queryFn: () => api.blob(hash!), enabled: !!hash, staleTime: Infinity });
}

const parse = (text: string | undefined) => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

function StepDetail({ step, steps, onClose }: { step: Step; steps: Step[]; onClose: () => void }) {
  return (
    <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
      <div className="flex items-start gap-3 p-4">
        <KindIcon kind={step.kind} failed={step.status === "error"} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-zinc-500">{kindLabel(step.kind)}</div>
          <div className="truncate font-semibold">{step.kind === "llm" ? (step.model ?? step.name) : step.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <StatusDot status={step.status} />
              {step.status === "ok" ? "Succeeded" : step.status === "error" ? "Failed" : "Running"}
            </span>
            <span>{duration(step.durationMs)}</span>
            <span>{dateTime(step.startedAt)}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          Close
        </button>
      </div>
      {step.error && (
        <div className="bg-rose-50 p-4 dark:bg-rose-500/10">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">Error</div>
          <pre className="font-mono text-xs whitespace-pre-wrap text-rose-800 dark:text-rose-300">{step.error}</pre>
        </div>
      )}
      {step.kind === "llm" ? <DecisionDetail step={step} steps={steps} /> : <ActionDetail step={step} />}
    </Card>
  );
}

type ToolCall = { id?: string; name: string; input?: unknown; arguments?: unknown };

function DecisionDetail({ step, steps }: { step: Step; steps: Step[] }) {
  const output = useBlob(step.outputHash);
  const input = useBlob(step.inputHash);
  const parsed = parse(output.data) as { text?: string; toolCalls?: ToolCall[] } | string | undefined;
  const answer = typeof parsed === "string" ? parsed : parsed?.text;
  const calls = typeof parsed === "object" ? (parsed?.toolCalls ?? []) : [];
  // Fall back to the actions up to the next model call, for sources that don't record the call list.
  const followed = calls.map((call) => call.name);
  if (!calls.length) {
    for (const next of steps.slice(steps.indexOf(step) + 1)) {
      if (next.kind === "llm") break;
      if (next.kind === "tool" || next.kind === "agent") followed.push(next.toolName ?? next.name);
    }
  }
  const available = step.attrs?.availableTools ?? [];
  const chosen = new Set(followed);
  const reasoning = step.attrs?.reasoning;
  const params = step.attrs?.requestParams ?? {};
  const messages = parse(input.data);

  return (
    <>
      <div className="space-y-2 p-4">
        <Section
          title="What it could choose from"
          hint="The tools the model was offered on this call. Highlighted: the ones it picked."
          aside={available.length > 0 && <span className="text-xs text-zinc-500">{plural(available.length, "tool")} · picked {chosen.size}</span>}
        >
          {available.length ? (
            <ToolChoices available={available} chosen={chosen} />
          ) : (
            <p className="text-sm text-zinc-500">This source didn't report which tools were offered.</p>
          )}
        </Section>
      </div>
      <div className="space-y-2 p-4">
        <Section title="What it chose" hint="The model's decision on this call">
          {calls.length ? (
            <div className="space-y-2">
              {calls.map((call, i) => (
                <div key={call.id ?? i}>
                  <div className="mb-1 font-mono text-xs font-semibold">{call.name}</div>
                  <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-[11px] dark:bg-zinc-950">{pretty(call.input ?? call.arguments ?? {})}</pre>
                </div>
              ))}
            </div>
          ) : followed.length ? (
            <p className="text-sm">Used {followed.join(", ")}.</p>
          ) : step.status === "error" ? (
            <p className="text-sm">Nothing: the call failed before the model could choose.</p>
          ) : step.status === "running" ? (
            <p className="text-sm text-zinc-500">Waiting for the model…</p>
          ) : (
            <p className="text-sm">Answered without using a tool.</p>
          )}
        </Section>
      </div>
      <div className="space-y-2 p-4">
        <Section title="Why" hint="Reasoning the model showed before acting: its thinking, or what it said before calling tools">
          {reasoning ? (
            <Expandable text={reasoning} lines={8} />
          ) : (
            <p className="text-sm text-zinc-500">No reasoning was shown for this call. The model's thinking may be hidden, or this source doesn't capture it.</p>
          )}
        </Section>
      </div>
      {answer && (
        <div className="space-y-2 p-4">
          <Section title={calls.length ? "Said" : "Answer"}>
            <Expandable text={answer} lines={8} />
          </Section>
        </div>
      )}
      <div className="space-y-3 p-4">
        <Section title="What it knew" hint="Tokens the model read on this call: new input plus input served from the prompt cache">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Mini label="Context" value={tokens(contextTokens(step))} />
            <Mini label="From cache" value={tokens(step.cacheReadTokens)} />
            <Mini label="Wrote" value={tokens(step.outputTokens)} />
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs text-zinc-500">
            {Object.entries(params)
              .filter(([, value]) => value !== undefined && value !== null)
              .map(([key, value]) => (
                <Chip key={key}>
                  {key}: {String(value)}
                </Chip>
              ))}
            <Chip title={costTitle(step)}>cost: {cost(step.costUsd)}</Chip>
          </div>
        </Section>
        {Array.isArray(messages) && messages.length > 0 && <Messages messages={messages as { role: string; content: unknown }[]} />}
      </div>
      <div className="p-4">
        <TryInArena step={step} />
      </div>
    </>
  );
}

/**
 * Picked tools first, then built-in tools, then MCP tools folded into one chip
 * per server: a 50-tool list is unreadable, a dozen chips is not.
 */
function ToolChoices({ available, chosen }: { available: string[]; chosen: Set<string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const picked = available.filter((tool) => chosen.has(tool));
  const builtIn = available.filter((tool) => !chosen.has(tool) && !mcpParts(tool));
  const servers = new Map<string, string[]>();
  for (const tool of available) {
    const mcp = mcpParts(tool);
    if (mcp && !chosen.has(tool)) servers.set(mcp.server, [...(servers.get(mcp.server) ?? []), mcp.tool]);
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {picked.map((tool) => (
          <Chip key={tool} active title={tool}>
            {toolLabel(tool)}
          </Chip>
        ))}
        {builtIn.map((tool) => (
          <Chip key={tool}>{tool}</Chip>
        ))}
        {[...servers].map(([server, tools]) => (
          <button key={server} type="button" onClick={() => setOpen(open === server ? null : server)} title={`${tools.length} tools from the ${server} MCP server`}>
            <Chip>
              {server} · {tools.length}
              {open === server ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </Chip>
          </button>
        ))}
      </div>
      {open && (
        <div className="flex flex-wrap gap-1 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-950">
          {servers.get(open)?.map((tool) => (
            <Chip key={tool}>{tool}</Chip>
          ))}
        </div>
      )}
    </div>
  );
}

const costTitle = (step: Step) =>
  step.costSource === "reported"
    ? "Reported by the harness"
    : step.costSource === "catalog" || step.costSource === "seed"
      ? "Estimated from list prices × tokens"
      : "No known price for this model";

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-950">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Messages({ messages }: { messages: { role: string; content: unknown }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-300">
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {open ? "Hide" : "Show"} the {plural(messages.length, "message")} sent to the model
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {messages.map((message, i) => (
            <div key={i} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
              <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">{message.role}</div>
              <pre className="max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{pretty(message.content)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionDetail({ step }: { step: Step }) {
  const input = useBlob(step.inputHash);
  const output = useBlob(step.outputHash);
  const args = parse(input.data);
  const command = args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string" ? (args as { command: string }).command : null;
  const decision = step.attrs?.permissionDecision;
  return (
    <>
      <div className="space-y-2 p-4">
        <Section title="Input" hint="What the agent passed to this tool">
          {input.isPending && step.inputHash ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : command ? (
            <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs text-zinc-100">$ {command}</pre>
          ) : args !== undefined ? (
            <pre className="max-h-64 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-[11px] dark:bg-zinc-950">{pretty(args)}</pre>
          ) : (
            <p className="text-sm text-zinc-500">No input captured.</p>
          )}
        </Section>
      </div>
      <div className="space-y-2 p-4">
        <Section title={step.kind === "agent" ? "Result" : "Output"} hint="What came back, as the agent saw it">
          {output.isPending && step.outputHash ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : output.data ? (
            step.kind === "agent" ? (
              <Expandable text={String(parse(output.data))} lines={10} />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-[11px] whitespace-pre-wrap dark:bg-zinc-950">{pretty(parse(output.data))}</pre>
            )
          ) : (
            <p className="text-sm text-zinc-500">{step.status === "running" ? "Still running…" : "No output captured."}</p>
          )}
        </Section>
      </div>
      {decision && (
        <div className="p-4 text-xs text-zinc-500">
          Permission: <span className="font-medium text-zinc-700 dark:text-zinc-300">{decision === "accept" ? "allowed" : decision}</span>
        </div>
      )}
    </>
  );
}

function TryInArena({ step }: { step: Step }) {
  const check = useQuery({ queryKey: ["arena", "check", step.id], queryFn: () => api.arena.check(step.id), staleTime: 60_000 });
  const body = (
    <>
      <FlaskConical className="size-4 shrink-0 text-brand-700 dark:text-brand-300" />
      <span>
        <span className="font-medium">Try this decision with another model or prompt</span>
        <span className="block text-xs text-zinc-500">
          {check.data && !check.data.ok ? check.data.reason : "Replays the exact request, then you compare the answers blind in the Arena."}
        </span>
      </span>
    </>
  );
  if (!check.data?.ok) {
    return <div className="flex items-center gap-3 rounded-lg border border-dashed border-zinc-300 p-3 text-sm opacity-70 dark:border-zinc-700">{body}</div>;
  }
  return (
    <Link
      to={`/arena/new?step=${step.id}&run=${step.runId}`}
      className="flex items-center gap-3 rounded-lg border border-dashed border-brand-400 p-3 text-sm hover:bg-brand-50 dark:border-brand-400/40 dark:hover:bg-brand-400/10"
    >
      {body}
    </Link>
  );
}
