import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type ContextBreakdown, type ContextPartKey, api } from "./api";
import { plural, tokens } from "./format";
import { percent } from "./tokens";
import { LABEL, cx } from "./ui";

/** One ink ramp: the token-kind colours on the same page mean something else. */
const PARTS: Record<ContextPartKey, { label: string; hint: string; color: string }> = {
  history: { label: "Earlier conversation", hint: "The chat before this request, sent again so the agent remembers it", color: "bg-zinc-800 dark:bg-zinc-100" },
  tools: { label: "Tool definitions", hint: "A description of every tool the agent could use, sent with each call", color: "bg-zinc-600 dark:bg-zinc-300" },
  system: { label: "Instructions", hint: "The agent's system prompt: how to behave, its skills, its memory", color: "bg-zinc-400 dark:bg-zinc-500" },
  work: { label: "Work on this request", hint: "What the agent did since: its tool calls, and what they returned", color: "bg-zinc-300 dark:bg-zinc-600" },
  request: { label: "Your request", hint: "The message itself, sent again with every call", color: "bg-zinc-950 dark:bg-white" },
};

const PANEL_WIDTH = 440;
const GUTTER = 16;

/**
 * A small ring at the end of the request: how full the biggest call's
 * context got. A click opens what all those tokens were.
 */
export function ContextRing({ runId, largest, window: contextWindow }: { runId: string; largest: number; window: number | null }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const share = contextWindow ? Math.min(1, largest / contextWindow) : null;

  // Inside the screen: below the ring, else above it, else as low as it fits (over the ring).
  const place = () => {
    const anchor = button.current?.getBoundingClientRect();
    const el = panel.current;
    if (!anchor || !el) return;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - GUTTER * 2);
    el.style.width = `${width}px`;
    el.style.maxHeight = `${window.innerHeight - GUTTER * 2}px`;
    const height = Math.min(el.scrollHeight, window.innerHeight - GUTTER * 2);
    const top =
      anchor.bottom + 8 + height <= window.innerHeight - GUTTER
        ? anchor.bottom + 8
        : anchor.top - 8 - height >= GUTTER
          ? anchor.top - 8 - height
          : Math.max(GUTTER, window.innerHeight - GUTTER - height);
    el.style.top = `${top}px`;
    el.style.left = `${Math.min(Math.max(GUTTER, anchor.left - 16), window.innerWidth - width - GUTTER)}px`;
  };

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState === "open") place();
    };
    const toggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    // Runs before paint whenever it opens or its content arrives, so it never shows misplaced.
    const resize = new ResizeObserver(() => {
      if (el.matches(":popover-open")) place();
    });
    resize.observe(el);
    el.addEventListener("beforetoggle", before);
    el.addEventListener("toggle", toggle);
    return () => {
      resize.disconnect();
      el.removeEventListener("beforetoggle", before);
      el.removeEventListener("toggle", toggle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const title = share !== null ? `What the model read: up to ${tokens(largest)} tokens a call, ${percent(share)} of its context window` : `What the model read: up to ${tokens(largest)} tokens a call`;
  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget={id}
        title={title}
        aria-label="What the model read"
        className={cx(
          "inline-grid size-6 place-items-center rounded-full align-middle text-zinc-700 transition-colors hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/10",
          open && "bg-zinc-900/5 dark:bg-white/10",
        )}
      >
        <Ring share={share} />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="fixed m-0 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-[0_8px_30px_rgba(24,24,27,0.12)] dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-none"
      >
        {open && <Panel runId={runId} largest={largest} contextWindow={contextWindow} onClose={() => panel.current?.hidePopover()} />}
      </div>
    </>
  );
}

/** A thin track with an arc for the share used; dashed when the model's window is unknown. */
export function Ring({ share }: { share: number | null }) {
  const r = 7.5;
  const length = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="size-[18px] -rotate-90" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-zinc-200 dark:stroke-white/15" strokeDasharray={share === null ? "2.2 2.2" : undefined} />
      {share !== null && (
        <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-current" strokeDasharray={`${Math.max(0.06, share) * length} ${length}`} />
      )}
    </svg>
  );
}

function Panel({ runId, largest, contextWindow, onClose }: { runId: string; largest: number; contextWindow: number | null; onClose: () => void }) {
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className={LABEL}>What the model read</div>
        <button type="button" onClick={onClose} className="-m-1.5 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <ContextDetails runId={runId} largest={largest} contextWindow={contextWindow} />
    </div>
  );
}

/** The breakdown itself, for the popover and for the side panel. Reads every call's messages, so only render it on request. */
export function ContextDetails({ runId, largest, contextWindow }: { runId: string; largest: number; contextWindow: number | null }) {
  const query = useQuery({ queryKey: ["run", runId, "context"], queryFn: () => api.runContext(runId), staleTime: 60_000 });
  const data = query.data;
  if (query.isPending) {
    return (
      <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <LoaderCircle className="size-4 animate-spin" /> Reading what was sent…
      </p>
    );
  }
  if (query.isError || !data) return <p className="mt-3 text-sm text-rose-600">Could not load this: {String(query.error?.message ?? "not found")}</p>;
  if (data.calls === 0) {
    return <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">This agent didn't send Lucid the messages behind its model calls, so there's nothing to split.</p>;
  }
  return <Breakdown data={data} largest={largest} contextWindow={contextWindow} />;
}

function Breakdown({ data, largest, contextWindow }: { data: ContextBreakdown; largest: number; contextWindow: number | null }) {
  const [openPart, setOpenPart] = useState<ContextPartKey | null>(null);
  const parts = data.parts.filter((part) => part.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const share = (n: number) => (data.total ? n / data.total : 0);
  const perCall = data.calls ? data.total / data.calls : 0;
  const fresh = parts.filter((part) => part.newTokens > 0).sort((a, b) => b.newTokens - a.newTokens);
  const cut = parts.some((part) => part.cut);
  return (
    <div className="mt-2 space-y-4">
      <div>
        <h3 className="font-display text-lg leading-snug font-bold tracking-tight text-balance">
          {data.measured ? "" : "About "}
          {tokens(data.total)} tokens for a {tokens(data.wrote)}-token request
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          Every model call sends the agent's instructions, its tools and the chat so far again.{" "}
          {data.calls > 1 ? `This run made ${data.calls} calls of about ${tokens(perCall)} each.` : "This run made one call."}
        </p>
      </div>

      <div className="flex h-3 gap-0.5 overflow-hidden rounded-[4px]" aria-hidden>
        {parts.map((part) => (
          <div key={part.key} className={cx("h-full min-w-0.5", PARTS[part.key].color)} style={{ width: `${share(part.tokens) * 100}%` }} title={`${PARTS[part.key].label}: ${percent(share(part.tokens))}`} />
        ))}
      </div>

      <ul className="-mx-2 space-y-0.5">
        {parts.map((part) => {
          const expandable = part.items.length > 1 || (part.items.length === 1 && part.key !== "request");
          const isOpen = openPart === part.key;
          const listed = part.items.reduce((sum, item) => sum + item.tokens, 0);
          return (
            <li key={part.key}>
              <button
                type="button"
                disabled={!expandable}
                onClick={() => setOpenPart(isOpen ? null : part.key)}
                title={PARTS[part.key].hint}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors enabled:hover:bg-zinc-50 dark:enabled:hover:bg-white/[0.04]"
              >
                <span className={cx("size-2.5 shrink-0 rounded-[3px]", PARTS[part.key].color)} aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {PARTS[part.key].label}
                  {part.key === "request" && data.calls > 1 && <span className="ml-1.5 text-xs font-normal text-zinc-400">sent {data.calls} times</span>}
                </span>
                <span className="font-semibold tabular-nums">{tokens(part.tokens)}</span>
                <span className="w-9 text-right text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{percent(share(part.tokens))}</span>
                <span className="w-3.5 text-zinc-400">{expandable && (isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}</span>
              </button>
              {isOpen && (
                <ul className="mt-0.5 mb-2 ml-7 space-y-1 border-l border-zinc-200 pr-7 pl-3 text-xs text-zinc-600 dark:border-white/10 dark:text-zinc-300">
                  {part.items.map((item) => (
                    <li key={item.label} className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate" title={item.label}>
                        {item.label}
                      </span>
                      <span className="tabular-nums">{tokens(item.tokens)}</span>
                    </li>
                  ))}
                  {part.tokens - listed > part.tokens * 0.02 && (
                    <li className="flex items-baseline gap-3 text-zinc-400">
                      <span className="flex-1">Everything else</span>
                      <span className="tabular-nums">{tokens(part.tokens - listed)}</span>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {data.measured && data.newTokens > 0 && fresh[0] && (
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          {data.newTokens >= data.total * 0.98 ? (
            <>None of it came from the prompt cache, so all {tokens(data.newTokens)} was new input.</>
          ) : (
            <>
              The {tokens(data.newTokens)} of new input, the part not read from the cache, was mostly{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{PARTS[fresh[0].key].label.toLowerCase()}</span> ({tokens(fresh[0].newTokens)})
              {fresh[1] && fresh[0].newTokens < data.newTokens * 0.6 && (
                <>
                  {" "}and <span className="font-medium text-zinc-900 dark:text-zinc-100">{PARTS[fresh[1].key].label.toLowerCase()}</span> ({tokens(fresh[1].newTokens)})
                </>
              )}
              .
            </>
          )}
        </p>
      )}

      <div className="space-y-1 border-t border-zinc-100 pt-3 text-xs leading-relaxed text-zinc-500 dark:border-white/[0.06] dark:text-zinc-400">
        {contextWindow && (
          <p>
            Biggest call: {tokens(largest)} of the model's {tokens(contextWindow)} context window ({percent(largest / contextWindow)}).
          </p>
        )}
        {data.uncaptured > 0 && (
          <p>
            {plural(data.uncaptured, "more call")} came without {data.uncaptured === 1 ? "its messages, so it isn't" : "their messages, so they aren't"} split here.
          </p>
        )}
        {cut && <p>Part of it was cut short when captured; Lucid counts what's missing from the provider's total.</p>}
        {data.rebuilt > 0 && (
          <p>
            {data.rebuilt === data.calls ? "These calls" : `${plural(data.rebuilt, "call")} of these`} came without {data.rebuilt === 1 ? "its" : "their"} messages, so Lucid rebuilt them from the chat.{" "}
            {data.measured
              ? "The agent's instructions and tools aren't in the chat: they're the rest of the provider's count."
              : "The agent's instructions and tools aren't in the chat, so the real calls were bigger."}
          </p>
        )}
        <p>{data.measured ? "Sized from what was sent and fitted to the provider's token counts." : "Estimated from what was sent: the provider didn't report token counts."}</p>
      </div>
    </div>
  );
}
