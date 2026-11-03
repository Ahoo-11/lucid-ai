// The pieces of a session's workings: the step timeline, and the detail of a
// step for the side panel.

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ChevronUp, FlaskConical } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { type Step, api } from "../api";
import { cost, dateTime, duration, mcpParts, plural, tokens, toolLabel } from "../format";
import { type Node, type Row, type Turn, argSummary, contextTokens, toRows, toTurns } from "../story";
import { InOut } from "../tokens";
import { Card, Chip, KindIcon, LABEL, Prose, Section, StatusDot, cx, kindLabel } from "../ui";

/** `end` sits right after the last line of text, or beside "Show all" while the text is cut. */
export function Expandable({ text, lines = 6, end }: { text: string; lines?: number; end?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  const clipped = long && !open;
  return (
    <div>
      <div
        className={cx(
          clipped && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          !!end && !clipped && "[&>.prose-lucid]:inline [&>.prose-lucid>:last-child]:inline",
        )}
      >
        <Prose text={text} />
        {end && !clipped && <span className="ml-1">{end}</span>}
      </div>
      {long && (
        <div className="mt-1.5 flex items-center gap-2">
          <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white">
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {open ? "Show less" : "Show all"}
          </button>
          {clipped && end}
        </div>
      )}
    </div>
  );
}

export function Timeline({ nodes, selected, onSelect, depth = 0 }: { nodes: Node[]; selected: string | null; onSelect: (id: string) => void; depth?: number }) {
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
  if (turn.llm?.outputPreview) return "Wrote the answer";
  return "Thought";
}

/** What the model said on a call, when it said more than which tools it called. */
const saidOn = (step: Step) => (step.outputPreview && !step.outputPreview.startsWith("Calls ") ? step.outputPreview : null);

function StepButton({ step, selected, onSelect, children, meta }: { step: Step; selected: boolean; onSelect: (id: string) => void; children: ReactNode; meta?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(step.externalId)}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-zinc-100 ring-1 ring-zinc-900/70 dark:bg-white/[0.07] dark:ring-white/40" : "hover:bg-zinc-50 dark:hover:bg-white/[0.04]",
      )}
    >
      <KindIcon kind={step.kind} failed={step.status === "error"} size="sm" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{meta}</span>
    </button>
  );
}

/**
 * One model call, what it said, then the actions it took: the agent's words
 * and steps in the order they happened. The last call's words are the answer,
 * shown under the workings, so they aren't repeated here (except in a
 * sub-agent, whose answer goes to its parent).
 */
function TurnRows({ turn, selected, onSelect, depth }: { turn: Turn; selected: string | null; onSelect: (id: string) => void; depth: number }) {
  const said = turn.llm ? saidOn(turn.llm) : null;
  return (
    <li>
      {turn.llm && (
        <StepButton
          step={turn.llm}
          selected={selected === turn.llm.externalId}
          onSelect={onSelect}
          meta={
            <>
              <InOut t={turn.llm} className="hidden sm:inline" />
              <span className="hidden sm:inline"> · </span>
              {duration(turn.llm.durationMs)} · {cost(turn.llm.costUsd)}
            </>
          }
        >
          <span className="font-medium">{chosenLabel(turn)}</span>
        </StepButton>
      )}
      {said && (turn.actions.length > 0 || depth > 0) && (
        <p className="mb-1 ml-9 line-clamp-3 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300" title={said}>
          {said}
        </p>
      )}
      {turn.actions.length > 0 && (
        <ol className={cx("space-y-0.5", turn.llm && "ml-4 border-l border-zinc-200 pl-2 dark:border-white/10")}>
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
        <div className="mt-1 mb-2 ml-5 rounded-xl border border-teal-200/80 bg-teal-50/40 p-2 dark:border-teal-500/20 dark:bg-teal-500/5">
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
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-white/[0.04]"
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

export function StepDetail({ step, steps, onClose }: { step: Step; steps: Step[]; onClose: () => void }) {
  return (
    <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
      <div className="flex items-start gap-3.5 p-5">
        <KindIcon kind={step.kind} failed={step.status === "error"} />
        <div className="min-w-0 flex-1">
          <div className={LABEL}>{kindLabel(step.kind)}</div>
          <div className="mt-0.5 truncate font-semibold">{step.kind === "llm" ? (step.model ?? step.name) : step.name}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <StatusDot status={step.status} />
              {step.status === "ok" ? "Succeeded" : step.status === "error" ? "Failed" : "Running"}
            </span>
            <span>{duration(step.durationMs)}</span>
            <span>{dateTime(step.startedAt)}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white">
          Close
        </button>
      </div>
      {step.error && (
        <div className="bg-rose-50/70 p-5 dark:bg-rose-500/[0.07]">
          <div className={cx(LABEL, "mb-1.5 text-rose-700 dark:text-rose-400")}>Error</div>
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
      <div className="p-5">
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
      <div className="p-5">
        <Section title="What it chose" hint="The model's decision on this call">
          {calls.length ? (
            <div className="space-y-2">
              {calls.map((call, i) => (
                <div key={call.id ?? i}>
                  <div className="mb-1 font-mono text-xs font-semibold">{call.name}</div>
                  <pre className="max-h-48 overflow-auto rounded-xl bg-zinc-50 p-3 font-mono text-[11px] ring-1 ring-zinc-200/70 ring-inset dark:bg-zinc-950 dark:ring-white/10">{pretty(call.input ?? call.arguments ?? {})}</pre>
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
      <div className="p-5">
        <Section title="Why" hint="Reasoning the model showed before acting: its thinking, or what it said before calling tools">
          {reasoning ? (
            <Expandable text={reasoning} lines={8} />
          ) : (
            <p className="text-sm text-zinc-500">No reasoning was shown for this call. The model's thinking may be hidden, or this source doesn't capture it.</p>
          )}
        </Section>
      </div>
      {answer && (
        <div className="p-5">
          <Section title={calls.length ? "Said" : "Answer"}>
            <Expandable text={answer} lines={8} />
          </Section>
        </div>
      )}
      <div className="space-y-3 p-5">
        <Section title="What it knew" hint="Tokens the model read on this call: new input plus input served from the prompt cache">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Mini label="Tokens in" value={tokens(contextTokens(step))} />
            <Mini label="From cache" value={tokens(step.cacheReadTokens)} />
            <Mini label="Tokens out" value={tokens(step.outputTokens)} />
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
      <div className="p-5">
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
        <div className="flex flex-wrap gap-1 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-950">
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
    <div className="rounded-xl bg-zinc-50 px-3 py-2.5 ring-1 ring-zinc-200/70 ring-inset dark:bg-zinc-950 dark:ring-white/10">
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Messages({ messages }: { messages: { role: string; content: unknown }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white">
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {open ? "Hide" : "Show"} the {plural(messages.length, "message")} sent to the model
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {messages.map((message, i) => (
            <div key={i} className="rounded-xl border border-zinc-200 p-3 dark:border-white/10">
              <div className={cx(LABEL, "mb-1.5")}>{message.role}</div>
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
      <div className="p-5">
        <Section title="Input" hint="What the agent passed to this tool">
          {input.isPending && step.inputHash ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : command ? (
            <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-3.5 font-mono text-xs text-zinc-100 ring-1 ring-zinc-900 dark:ring-white/10">$ {command}</pre>
          ) : args !== undefined ? (
            <pre className="max-h-64 overflow-auto rounded-xl bg-zinc-50 p-3 font-mono text-[11px] ring-1 ring-zinc-200/70 ring-inset dark:bg-zinc-950 dark:ring-white/10">{pretty(args)}</pre>
          ) : (
            <p className="text-sm text-zinc-500">No input captured.</p>
          )}
        </Section>
      </div>
      <div className="p-5">
        <Section title={step.kind === "agent" ? "Result" : "Output"} hint="What came back, as the agent saw it">
          {output.isPending && step.outputHash ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : output.data ? (
            step.kind === "agent" ? (
              <Expandable text={String(parse(output.data))} lines={10} />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-xl bg-zinc-50 p-3 font-mono text-[11px] whitespace-pre-wrap ring-1 ring-zinc-200/70 ring-inset dark:bg-zinc-950 dark:ring-white/10">{pretty(parse(output.data))}</pre>
            )
          ) : (
            <p className="text-sm text-zinc-500">{step.status === "running" ? "Still running…" : "No output captured."}</p>
          )}
        </Section>
      </div>
      {decision && (
        <div className="p-5 text-xs text-zinc-500">
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
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-300 text-zinc-950">
        <FlaskConical className="size-4" />
      </span>
      <span>
        <span className="font-medium">Try this decision with another model or prompt</span>
        <span className="block text-xs text-zinc-500">
          {check.data && !check.data.ok ? check.data.reason : "Replays the exact request, then you compare the answers blind in the Arena."}
        </span>
      </span>
    </>
  );
  if (!check.data?.ok) {
    return <div className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-3.5 text-sm opacity-60 grayscale dark:border-white/15">{body}</div>;
  }
  return (
    <Link
      to={`/arena/new?step=${step.id}&run=${step.runId}`}
      className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3.5 text-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/10 dark:hover:bg-white/[0.04]"
    >
      {body}
    </Link>
  );
}
