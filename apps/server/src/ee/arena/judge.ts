// LLM judge for blind pairwise comparison. Model names never reach the
// judge, and every pair is judged twice with the order swapped: LLM judges
// favour whichever answer comes first, so a verdict only counts when it
// survives the swap. Otherwise the pair is a tie.

import type { ChatClient, ToolCall } from "./llm";
import type { DecisionContext } from "./request";

export const DEFAULT_RUBRIC =
  "A better next step makes real progress on the user's request: it picks the most appropriate tool with correct arguments, " +
  "or answers directly when no tool is needed. It avoids unnecessary, repeated or risky actions. Judge correctness first, then efficiency. " +
  "Ignore length and style unless they change what the agent does.";

export type Candidate = { text?: string; toolCalls?: ToolCall[] };
export type Verdict = "a" | "b" | "tie";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function renderCandidate(candidate: Candidate) {
  const parts: string[] = [];
  if (candidate.text?.trim()) parts.push(`Says:\n${clip(candidate.text.trim(), 3000)}`);
  for (const call of candidate.toolCalls ?? []) parts.push(`Calls tool ${call.name} with ${clip(JSON.stringify(call.input ?? {}), 1500)}`);
  return parts.join("\n\n") || "(does nothing)";
}

function renderContext(context: DecisionContext) {
  const lines = [`## The user's request\n${clip(context.request ?? "(not captured)", 2000)}`];
  if (context.recent?.length) lines.push(`## Most recent messages\n${context.recent.map((m) => `[${m.role}] ${m.text}`).join("\n\n")}`);
  if (context.tools?.length) lines.push(`## Tools the agent could use\n${context.tools.join(", ")}`);
  return lines.join("\n\n");
}

export function parseVerdict(text: string | undefined): { winner: Verdict; reason: string } | null {
  if (!text) return null;
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { winner?: string; reason?: string };
      const winner = parsed.winner?.trim().toLowerCase();
      if (winner === "a" || winner === "b" || winner === "tie") return { winner, reason: String(parsed.reason ?? "") };
    } catch {
      // fall through to the plain-text match
    }
  }
  const plain = /\b(winner|answer)\s*[:=]\s*"?(A|B|tie)\b/i.exec(text)?.[2]?.toLowerCase();
  return plain === "a" || plain === "b" || plain === "tie" ? { winner: plain, reason: "" } : null;
}

async function askOnce(chat: ChatClient, model: string, rubric: string, context: DecisionContext, first: Candidate, second: Candidate) {
  const request = {
    model,
    json: true,
    // Reasoning models (GPT-5, o-series) spend hidden tokens before answering;
    // a small cap leaves an empty reply. Low effort keeps judging fast and cheap.
    maxTokens: 4000,
    reasoningEffort: "low" as const,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You compare two possible next steps an AI agent could take at the same point in a conversation. " +
          "You are not told which model produced which, and must not guess. " +
          `What makes a step better: ${rubric}\n\n` +
          'Reply with JSON only: {"winner": "A" | "B" | "tie", "reason": "one short sentence"}',
      },
      { role: "user", content: `${renderContext(context)}\n\n## Candidate A\n${renderCandidate(first)}\n\n## Candidate B\n${renderCandidate(second)}` },
    ],
  };
  let result = await chat(request);
  let verdict = parseVerdict(result.text);
  let costUsd = result.costUsd ?? 0;
  if (!verdict) {
    // One retry: empty or malformed replies are usually transient.
    result = await chat(request);
    verdict = parseVerdict(result.text);
    costUsd += result.costUsd ?? 0;
  }
  if (!verdict) throw new Error(`The judge's reply couldn't be read: ${clip(result.text ?? "(empty)", 200)}`);
  return { ...verdict, costUsd };
}

/** Judges x against y in both orders; returns the verdict from x's point of view ("a" = x wins). */
export async function judgePair(chat: ChatClient, model: string, rubric: string, context: DecisionContext, x: Candidate, y: Candidate) {
  const [forward, backward] = await Promise.all([askOnce(chat, model, rubric, context, x, y), askOnce(chat, model, rubric, context, y, x)]);
  const swapped: Verdict = backward.winner === "a" ? "b" : backward.winner === "b" ? "a" : "tie";
  const costUsd = (forward.costUsd ?? 0) + (backward.costUsd ?? 0);
  if (forward.winner === swapped) return { winner: forward.winner, reason: forward.reason, consistent: true, costUsd };
  return {
    winner: "tie" as Verdict,
    reason: `Counted as a tie: the judge changed its mind when the order was swapped (${forward.reason || forward.winner} / ${backward.reason || backward.winner}).`,
    consistent: false,
    costUsd,
  };
}
