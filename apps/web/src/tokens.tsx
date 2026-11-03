import type { CostSplit } from "./api";
import { cost, tokens } from "./format";
import { cx } from "./ui";

export type TokenCounts = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens?: number | null;
};

/** Everything the model read: new input, plus input read from or written to the prompt cache. */
export const tokensIn = (t: TokenCounts) => (t.inputTokens ?? 0) + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0);

const exact = (n: number | null | undefined) => (n ?? 0).toLocaleString();

/** The exact counts behind "38k in · 1.2k out", for a hover title. */
export const tokenTitle = (t: TokenCounts) =>
  [
    `New input: ${exact(t.inputTokens)}`,
    `Cache reads: ${exact(t.cacheReadTokens)}`,
    `Cache writes: ${exact(t.cacheWriteTokens)}`,
    `Output: ${exact(t.outputTokens)}`,
    t.reasoningTokens ? `(of which thinking: ${exact(t.reasoningTokens)})` : null,
  ]
    .filter(Boolean)
    .join("\n");

/** "38k in · 1.2k out", with every kind of token on hover. */
export function InOut({ t, className }: { t: TokenCounts; className?: string }) {
  return (
    <span className={cx("tabular-nums", className)} title={tokenTitle(t)}>
      {tokens(tokensIn(t))} in · {tokens(t.outputTokens)} out
    </span>
  );
}

/** The four kinds of token a provider bills, in the chart colours' fixed order. */
const KINDS = [
  { key: "input", count: "inputTokens", label: "New input", color: "bg-series-1", hint: "Text the model read for the first time: the request, tool results, files" },
  { key: "cacheRead", count: "cacheReadTokens", label: "Cache reads", color: "bg-series-2", hint: "Earlier context the model read again from the prompt cache, at a discount" },
  { key: "cacheWrite", count: "cacheWriteTokens", label: "Cache writes", color: "bg-series-3", hint: "Context saved to the prompt cache for later calls, at a small premium" },
  { key: "output", count: "outputTokens", label: "Output", color: "bg-series-4", hint: "What the model wrote, including its thinking" },
] as const;

export const percent = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

/**
 * Where the money goes: how many tokens of each kind, what they cost at list
 * prices, and their share of the cost (of the tokens, when no price is known).
 */
export function TokenBreakdown({ t, split, compact }: { t: TokenCounts; split: CostSplit | null; compact?: boolean }) {
  const priced = split && split.input + split.cacheRead + split.cacheWrite + split.output > 0 ? split : null;
  const rows = KINDS.map((kind) => ({ ...kind, tokens: t[kind.count] ?? 0, usd: priced ? priced[kind.key] : null }));
  const base = priced ? rows.reduce((sum, row) => sum + row.usd!, 0) : rows.reduce((sum, row) => sum + row.tokens, 0);
  const shareOf = (row: (typeof rows)[number]) => (base ? (priced ? row.usd! : row.tokens) / base : 0);
  if (!base) return <p className="text-sm text-zinc-500 dark:text-zinc-400">No tokens recorded.</p>;
  return (
    <div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-[4px]" aria-hidden>
        {rows
          .filter((row) => shareOf(row) > 0)
          .map((row) => (
            <div key={row.key} className={cx("h-full min-w-0.5", row.color)} style={{ width: `${shareOf(row) * 100}%` }} title={`${row.label}: ${percent(shareOf(row))}`} />
          ))}
      </div>
      <dl className={cx("mt-4 grid grid-cols-2 gap-x-6 gap-y-4", !compact && "sm:grid-cols-4")}>
        {rows.map((row) => (
          <div key={row.key} title={row.hint}>
            <dt className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              <span className={cx("size-2 shrink-0 rounded-[2px]", row.color)} aria-hidden />
              {row.label}
            </dt>
            <dd className="mt-1 text-sm">
              <span className="font-semibold">{tokens(row.tokens)}</span> <span className="text-zinc-500 dark:text-zinc-400">tokens</span>
            </dd>
            <dd className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
              {row.usd != null ? `${cost(row.usd)} · ${percent(shareOf(row))} of cost` : `${percent(shareOf(row))} of tokens`}
              {row.key === "output" && t.reasoningTokens ? ` · ${tokens(t.reasoningTokens)} thinking` : ""}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
