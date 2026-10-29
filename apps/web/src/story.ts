// Turns a run's flat steps into what the Run page shows: a tree (sub-agents
// as branches), "turns" (one model decision plus the actions it triggered),
// and a one-line story ("Read ×4 → Bash ×2 (1 failed) → Answered").

import type { Status, Step } from "./api";
import { toolLabel } from "./format";

export type Node = { step: Step; children: Node[] };

/** A model decision and the actions that followed it, or actions with no captured decision. */
export type Turn = { llm?: Step; actions: Node[] };

/** Several consecutive turns that each just used the same tool successfully. */
export type Row = { type: "turn"; turn: Turn } | { type: "repeat"; tool: string; turns: Turn[] };

export function buildTree(steps: Step[]): Node[] {
  const nodes = new Map(steps.map((step) => [step.externalId, { step, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.step.parentExternalId ? nodes.get(node.step.parentExternalId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function toTurns(nodes: Node[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const node of nodes) {
    // A framework's root span (e.g. "invoke_agent Support") wraps the whole run:
    // show what is inside it rather than one opaque row.
    if (nodes.length === 1 && node.step.kind === "agent" && node.children.length > 0 && !node.step.toolName) {
      return toTurns(node.children);
    }
    if (node.step.kind === "llm") {
      current = { llm: node.step, actions: [] };
      turns.push(current);
    } else {
      if (!current) {
        current = { actions: [] };
        turns.push(current);
      }
      current.actions.push(node);
    }
  }
  return turns;
}

const singleTool = (turn: Turn) =>
  turn.actions.length === 1 && turn.actions[0]!.step.kind === "tool" && turn.actions[0]!.step.status === "ok" && !hasAnswerText(turn)
    ? toolLabel(turn.actions[0]!.step.toolName ?? turn.actions[0]!.step.name)
    : null;

function hasAnswerText(turn: Turn) {
  const preview = turn.llm?.outputPreview;
  return !!preview && !preview.startsWith("Calls ");
}

export function toRows(turns: Turn[], minRepeat = 3): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < turns.length) {
    const tool = singleTool(turns[i]!);
    let j = i + 1;
    if (tool) while (j < turns.length && singleTool(turns[j]!) === tool) j++;
    if (tool && j - i >= minRepeat) rows.push({ type: "repeat", tool, turns: turns.slice(i, j) });
    else for (let k = i; k < j; k++) rows.push({ type: "turn", turn: turns[k]! });
    i = j;
  }
  return rows;
}

export type StoryPart = { label: string; count: number; failed: number; kind: "tool" | "agent" | "end"; status?: Status };

export function story(nodes: Node[], runStatus: Status): StoryPart[] {
  const parts: StoryPart[] = [];
  const actions = toTurns(nodes).flatMap((turn) => turn.actions);
  for (const { step } of actions) {
    if (step.kind !== "tool" && step.kind !== "agent") continue;
    const label = step.kind === "agent" ? "Sub-agent" : toolLabel(step.toolName ?? step.name);
    const last = parts[parts.length - 1];
    if (last && last.label === label) {
      last.count++;
      if (step.status === "error") last.failed++;
    } else {
      parts.push({ label, count: 1, failed: step.status === "error" ? 1 : 0, kind: step.kind === "agent" ? "agent" : "tool" });
    }
  }
  const end = runStatus === "ok" ? "Answered" : runStatus === "error" ? "Failed" : "Working…";
  parts.push({ label: end, count: 1, failed: 0, kind: "end", status: runStatus });
  return parts;
}

// Claude Code and Hermes argument names, most telling first.
const ARG_KEYS = ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "goal", "code", "description", "prompt"];

/** The argument that tells two calls of the same tool apart: a path, command, pattern, url… */
export function argSummary(step: Pick<Step, "inputPreview">): string | undefined {
  const preview = step.inputPreview;
  if (!preview) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(preview);
  } catch {
    // A clipped preview isn't valid JSON; pick the first telling "key": "value" out of it.
    for (const key of ARG_KEYS) {
      const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview);
      if (match && match[1]!.trim() && match[1]!.trim() !== ".") return shorten(key, match[1]!);
    }
    return undefined;
  }
  if (typeof input === "string") return input.slice(0, 120);
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    // "." or "" says nothing (Hermes search_files sends path "."); try the next key.
    if (typeof value === "string" && value.trim() && value.trim() !== ".") return shorten(key, value);
  }
  const firstString = Object.values(record).find((value) => typeof value === "string") as string | undefined;
  return firstString?.slice(0, 120);
}

function shorten(key: string, value: string) {
  if (key.endsWith("path")) {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value;
  }
  const line = value.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function contextTokens(step: Step) {
  return (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0);
}
