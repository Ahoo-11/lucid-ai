// What a run's model calls read, split by where it came from: the agent's
// tool definitions, its instructions, the conversation before this request,
// the request itself, and the work done on it since. A one-line request can
// cost 100k tokens because every call sends all of that again.
//
// Sizes come from the captured messages and tool schemas (about 4 characters
// a token), fitted to the token counts the provider reported, so the parts
// add up to the real totals on the run page.

/** In prompt order: a prompt cache holds the start of the prompt, so it covers these first. */
export const CONTEXT_PARTS = ["tools", "system", "history", "request", "work"] as const;
export type ContextPartKey = (typeof CONTEXT_PARTS)[number];

export type ContextItem = { label: string; tokens: number };
export type ContextPart = {
  key: ContextPartKey;
  tokens: number;
  /** The share of `tokens` that was new input, not read from or written to the cache. */
  newTokens: number;
  /** Biggest pieces first, summed over all calls. */
  items: ContextItem[];
  /** Part of it was cut short when captured, so its size is inferred from the provider's count. */
  cut: boolean;
};

export type ContextBreakdown = {
  /** Model calls split here; `uncaptured` more had no messages to split. */
  calls: number;
  uncaptured: number;
  /** Of `calls`, how many were rebuilt from the conversation (see rebuildMessages): instructions and tool definitions aren't in them. */
  rebuilt: number;
  /** Fitted to provider token counts; false when no call reported any (then it's all estimates). */
  measured: boolean;
  total: number;
  newTokens: number;
  /** About how many tokens the person's own words were. */
  wrote: number;
  parts: ContextPart[];
  perCall: { stepId: string; tokens: number; cached: number }[];
};

export type CallInput = {
  stepId: string;
  /** The messages sent, as captured: OpenAI-style, or OTel's { role, content, toolCalls }. */
  messages: unknown[] | null;
  tools: unknown[] | null;
  /** A sub-agent's call: its "request" is the task its parent wrote, so it counts as work. */
  inSubAgent: boolean;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** The messages were rebuilt from the conversation, not captured: what the provider counted beyond them was the setup. */
  rebuilt?: boolean;
};

/** A step as the conversation rebuild reads it, by external ids, in run order. */
export type TurnStep = { stepId: string; parentId: string | null; kind: string; toolName: string | null; toolCallId: string | null; input: unknown; output: unknown };

const CHARS_PER_TOKEN = 4;
/** Role markers and separators the provider adds around each message. */
const MESSAGE_OVERHEAD = 4;
/** Providers bill an image by its size, not its base64 length; this is a typical one. */
const IMAGE_TOKENS = 1000;
const MAX_ITEMS = 8;
const ADDED_MIN = 8;
const CUT = /…\[truncated by Lucid\]|<\w+ depth limit>/;
const LESSONS = "Lessons from your owner, via Lucid";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const estimate = (text: string) => text.length / CHARS_PER_TOKEN;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Sized = { tokens: number; text: string };

/** A message's content as text, with images counted at a typical size. */
function sizeContent(content: unknown): Sized {
  if (typeof content === "string") return { tokens: estimate(content), text: content };
  if (!Array.isArray(content)) {
    const text = content === null || content === undefined ? "" : JSON.stringify(content);
    return { tokens: estimate(text), text };
  }
  let tokens = 0;
  const texts: string[] = [];
  for (const part of content) {
    const type = isRecord(part) ? String(part.type ?? "") : "";
    if (/image/.test(type)) {
      tokens += IMAGE_TOKENS;
      continue;
    }
    const text = typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : isRecord(part) ? sizeContent(part.content).text : "";
    tokens += estimate(text);
    texts.push(text);
  }
  return { tokens, text: texts.join("\n") };
}

const callsOf = (message: Record<string, unknown>) =>
  (Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(message.toolCalls) ? message.toolCalls : []).filter(isRecord);

const callName = (call: Record<string, unknown>) => String((isRecord(call.function) ? call.function.name : call.name) ?? "a tool");

/** Anthropic-style tool results arrive as user messages made only of tool_result blocks. */
const onlyToolResults = (content: unknown) => Array.isArray(content) && content.length > 0 && content.every((part) => isRecord(part) && part.type === "tool_result");

/** Splits instructions at their markdown headings, so the big sections can be named. */
function sections(text: string): ContextItem[] {
  const out: ContextItem[] = [];
  let label = "Opening";
  let start = 0;
  const heading = /^#{1,3} +(\S.*)$/gm;
  for (const match of text.matchAll(heading)) {
    if (match.index > start) out.push({ label, tokens: estimate(text.slice(start, match.index)) });
    label = clip(match[1]!.trim(), 60);
    start = match.index;
  }
  out.push({ label, tokens: estimate(text.slice(start)) });
  return out;
}

type Part = { tokens: number; items: Map<string, number>; cut: boolean };
const emptyParts = () => Object.fromEntries(CONTEXT_PARTS.map((key) => [key, { tokens: 0, items: new Map(), cut: false }])) as Record<ContextPartKey, Part>;
const add = (part: Part, label: string, tokens: number) => {
  part.tokens += tokens;
  part.items.set(label, (part.items.get(label) ?? 0) + tokens);
};

/** One call's prompt, sized by part (estimates, before fitting). */
export function splitCall(call: CallInput, typed: string | null): Record<ContextPartKey, Part> {
  const parts = emptyParts();
  for (const tool of call.tools ?? []) {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : tool;
    const schema = JSON.stringify(tool);
    add(parts.tools, isRecord(fn) && typeof fn.name === "string" ? fn.name : "Tool", estimate(schema));
    if (CUT.test(schema)) parts.tools.cut = true;
  }

  const messages = (call.messages ?? []).filter(isRecord);
  const real = (message: Record<string, unknown>) => message.role === "user" && !onlyToolResults(message.content);
  let request = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (real(messages[i]!)) {
      request = i;
      break;
    }
  }
  const toolNames = new Map<string, string>();
  messages.forEach((message, i) => {
    const role = String(message.role ?? "");
    const content = sizeContent(message.content);
    const calls = callsOf(message);
    for (const tc of calls) if (typeof tc.id === "string") toolNames.set(tc.id, callName(tc));
    const tokens = content.tokens + estimate(calls.length ? JSON.stringify(calls) : "") + MESSAGE_OVERHEAD;
    const cut = CUT.test(content.text);

    if (role === "system" || role === "developer") {
      const list = sections(content.text);
      const listed = list.reduce((sum, item) => sum + item.tokens, 0);
      for (const item of list) add(parts.system, item.label, listed ? (item.tokens * tokens) / listed : tokens / list.length);
      parts.system.cut ||= cut;
      return;
    }
    if (i === request && !call.inSubAgent) {
      // Agents wrap the request (time, channel, Lucid's lessons); a few tokens over is just rounding.
      const added = typed ? content.tokens - estimate(typed) : 0;
      if (added > ADDED_MIN) {
        add(parts.request, "What you wrote", tokens - added);
        add(parts.request, content.text.includes(LESSONS) ? "Added by the agent, incl. Lucid's lessons" : "Added by the agent", added);
      } else {
        add(parts.request, "What you wrote", tokens);
      }
      parts.request.cut ||= cut;
      return;
    }
    const part = i < request && !call.inSubAgent ? parts.history : parts.work;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
    const label =
      role === "tool" || onlyToolResults(message.content)
        ? `Results from ${typeof message.name === "string" ? message.name : (id && toolNames.get(id)) || "tools"}`
        : role === "assistant"
          ? "The agent's replies and tool calls"
          : i === request
            ? "The task it was given"
            : part === parts.history
              ? "Earlier requests"
              : "Messages from you";
    add(part, label, tokens);
    part.cut ||= cut;
  });
  return parts;
}

const asText = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value));

/** A recorded model reply ({ text, toolCalls }) as the assistant message the next call sends back. */
function assistantMessage(output: unknown) {
  if (!isRecord(output)) return { role: "assistant", content: asText(output) };
  const calls = (Array.isArray(output.toolCalls) ? output.toolCalls : []).filter(isRecord);
  const toolCalls = calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) } }));
  return { role: "assistant", content: asText(output.text), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

/**
 * The messages behind each model call of the last turn, rebuilt from the
 * conversation for calls whose messages weren't sent: Hermes cuts big
 * requests to a preview, and its history keeps none. Every earlier turn's
 * request, replies and tool results, then this turn's up to the call. A
 * sub-agent's calls read only its task and its own work. The agent's
 * instructions and tool definitions aren't in the conversation.
 */
export function rebuildMessages(turns: { input: string | null; steps: TurnStep[] }[]) {
  const out = new Map<string, unknown[]>();
  const main: unknown[] = [];
  turns.forEach((turn, t) => {
    if (turn.input) main.push({ role: "user", content: turn.input });
    const byId = new Map(turn.steps.map((step) => [step.stepId, step]));
    const subAgents = new Map<string, unknown[]>();
    /** The conversation a step is in: the nearest sub-agent above it, or the main one. */
    const conversation = (step: TurnStep) => {
      const seen = new Set<string>();
      for (let id = step.parentId; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
        seen.add(id);
        const agent = byId.get(id);
        if (agent?.kind !== "agent") continue;
        const list = subAgents.get(id) ?? [{ role: "user", content: asText(agent.input) }];
        subAgents.set(id, list);
        return list;
      }
      return main;
    };
    for (const step of turn.steps) {
      if (step.kind === "llm") {
        const list = conversation(step);
        if (t === turns.length - 1) out.set(step.stepId, [...list]);
        list.push(assistantMessage(step.output));
      } else if (step.kind === "tool" || (step.kind === "agent" && step.toolCallId)) {
        // A sub-agent with no call id is where its work hangs, not a result the model read.
        conversation(step).push({ role: "tool", tool_call_id: step.toolCallId ?? undefined, name: step.toolName ?? undefined, content: asText(step.output) });
      }
    }
  });
  return out;
}

/** What a rebuilt call's provider count holds beyond the conversation: Hermes' instructions, memory and skills. */
const UNRECORDED_SETUP = "Instructions and setup (not recorded, sized from the token count)";

/**
 * Fits one call's estimates to what the provider counted. When something was
 * cut short on capture, what's missing most likely belongs to it; for a
 * rebuilt call, to the setup the conversation doesn't hold; otherwise every
 * part is scaled alike.
 */
function fit(parts: Record<ContextPartKey, Part>, measured: number, rebuilt = false) {
  const estimated = CONTEXT_PARTS.reduce((sum, key) => sum + parts[key].tokens, 0);
  if (!measured || !estimated) return;
  if (rebuilt && measured > estimated) {
    add(parts.system, UNRECORDED_SETUP, measured - estimated);
    return;
  }
  const cut = CONTEXT_PARTS.filter((key) => parts[key].cut && parts[key].tokens > 0);
  if (measured > estimated && cut.length) {
    const cutTotal = cut.reduce((sum, key) => sum + parts[key].tokens, 0);
    for (const key of cut) add(parts[key], "Cut short when captured", ((measured - estimated) * parts[key].tokens) / cutTotal);
    return;
  }
  const factor = measured / estimated;
  for (const key of CONTEXT_PARTS) {
    parts[key].tokens *= factor;
    for (const [label, tokens] of parts[key].items) parts[key].items.set(label, tokens * factor);
  }
}

const tokensIn = (call: CallInput) => (call.inputTokens ?? 0) + (call.cacheReadTokens ?? 0) + (call.cacheWriteTokens ?? 0);

export function contextBreakdown(calls: CallInput[], typed: string | null): ContextBreakdown {
  // Calls the provider never counted (a failed request) aren't in the run's
  // totals either, unless no call reported tokens at all.
  const measured = calls.some((call) => tokensIn(call) > 0);
  const counted = measured ? calls.filter((call) => tokensIn(call) > 0) : calls;
  const split = counted.filter((call) => call.messages?.length);
  const totals = emptyParts();
  const newTokens: Record<ContextPartKey, number> = Object.fromEntries(CONTEXT_PARTS.map((key) => [key, 0])) as Record<ContextPartKey, number>;
  const perCall: ContextBreakdown["perCall"] = [];

  for (const call of split) {
    const parts = splitCall(call, typed);
    const total = measured ? tokensIn(call) : CONTEXT_PARTS.reduce((sum, key) => sum + parts[key].tokens, 0);
    if (measured) fit(parts, total, call.rebuilt);
    // New input is whatever comes after the cached start of the prompt.
    const fresh = measured ? (call.inputTokens ?? 0) : total;
    let at = 0;
    for (const key of CONTEXT_PARTS) {
      const part = parts[key];
      const end = at + part.tokens;
      newTokens[key] += Math.max(0, end - Math.max(at, total - fresh));
      at = end;
      totals[key].cut ||= part.cut;
      for (const [label, tokens] of part.items) add(totals[key], label, tokens);
    }
    perCall.push({ stepId: call.stepId, tokens: Math.round(total), cached: Math.round(Math.min(total, call.cacheReadTokens ?? 0)) });
  }

  const parts = CONTEXT_PARTS.map((key) => ({
    key,
    tokens: Math.round(totals[key].tokens),
    newTokens: Math.round(Math.min(newTokens[key], totals[key].tokens)),
    items: [...totals[key].items]
      .map(([label, tokens]) => ({ label, tokens: Math.round(tokens) }))
      .filter((item) => item.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, MAX_ITEMS),
    cut: totals[key].cut,
  }));
  return {
    calls: split.length,
    uncaptured: counted.length - split.length,
    rebuilt: split.filter((call) => call.rebuilt).length,
    measured,
    total: parts.reduce((sum, part) => sum + part.tokens, 0),
    newTokens: parts.reduce((sum, part) => sum + part.newTokens, 0),
    wrote: Math.round(typed ? estimate(typed) : split.length ? parts.find((part) => part.key === "request")!.tokens / split.length : 0),
    parts,
    perCall,
  };
}
