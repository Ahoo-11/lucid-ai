import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  Check,
  Circle,
  Copy,
  GitBranch,
  Info,
  Search,
  Shield,
  Sparkles,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import type { Status, StepKind } from "./api";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/** White on the paper with a hairline edge; no glow. */
export const SURFACE = "rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/[0.07] dark:bg-zinc-900 dark:shadow-none";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(SURFACE, className)}>{children}</div>;
}

/** Every page starts the same way: a title, one plain line under it, and its actions on the right. */
export function PageHeader({ title, sub, back, children }: { title: ReactNode; sub?: ReactNode; back?: ReactNode; children?: ReactNode }) {
  return (
    <header className="space-y-3">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-display text-[1.75rem] leading-tight font-bold tracking-tight text-balance">{title}</h1>
          {sub && <div className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{sub}</div>}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}

/** Lime is for the one thing to do next; everything else is quiet. */
export const BUTTON = {
  primary:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand-300 px-4 text-sm font-semibold text-zinc-950 ring-1 ring-black/5 ring-inset transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-50",
  dark: "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:pointer-events-none disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
  secondary:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/[0.07]",
  quiet:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-900/5 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white",
} as const;

/** A back link above a page title. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">
      <ArrowLeft className="size-4" />
      {children}
    </Link>
  );
}

/** A few choices side by side, one picked: filters and periods. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-xl bg-zinc-900/[0.05] p-1 dark:bg-white/[0.06]">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cx(
            "rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition",
            option.value === value
              ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,0.08)] ring-1 ring-black/5 dark:bg-zinc-700 dark:text-white dark:ring-white/5"
              : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Tabs drawn as a line, with the current one underlined. */
export function TabBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="tablist" className={cx("flex gap-6 border-b border-zinc-200 text-sm dark:border-white/10", className)}>
      {children}
    </div>
  );
}

export function TabItem({ current, onClick, children }: { current: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current}
      onClick={onClick}
      className={cx(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 pb-3 font-medium transition-colors",
        current ? "border-zinc-900 text-zinc-900 dark:border-white dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}

/** Small mono caps over a number or a section: the one technical touch in the type. */
export const LABEL = "font-mono text-[11px] font-medium tracking-[0.06em] text-zinc-500 uppercase dark:text-zinc-400";

/** A number with its name, and a line on what it means. `aside` sits opposite the name (a change since last period). */
export function StatTile({ label, value, sub, hint, tone, aside }: { label: string; value: ReactNode; sub?: ReactNode; hint?: string; tone?: "bad"; aside?: ReactNode }) {
  return (
    <Card className="min-w-0 px-5 py-4">
      {/* On a narrow tile the aside drops under the name rather than cutting it short. */}
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className={LABEL} title={hint}>
          {label}
        </div>
        {aside}
      </div>
      <div className={cx("mt-2.5 truncate font-display text-[1.75rem] leading-none font-bold tabular-nums", tone === "bad" && "text-rose-600 dark:text-rose-400")} title={hint}>
        {value}
      </div>
      {sub && <div className="mt-2 truncate text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </Card>
  );
}

const STATUS = {
  ok: { label: "Succeeded", dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20" },
  error: { label: "Failed", dot: "bg-rose-500", pill: "bg-rose-50 text-rose-700 ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20" },
  running: { label: "Running", dot: "bg-amber-400 animate-pulse", pill: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20" },
} as const;

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", STATUS[status].dot, className)} title={STATUS[status].label} />;
}

/** A run's dot: amber when it succeeded but some steps failed on the way. */
export function RunDot({ status, errorCount, className }: { status: Status; errorCount: number; className?: string }) {
  if (status === "ok" && errorCount > 0) {
    return <span className={cx("inline-block size-2 shrink-0 rounded-full bg-amber-400", className)} title="Succeeded with failed steps" />;
  }
  return <StatusDot status={status} className={className} />;
}

/** "Succeeded" vs "Succeeded, 2 errors on the way": a run can recover from failed steps. */
export function StatusPill({ status, errorCount = 0 }: { status: Status; errorCount?: number }) {
  const recovered = status === "ok" && errorCount > 0;
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS[recovered ? "running" : status].pill)}
      title={recovered ? "The run finished, but some steps failed along the way" : undefined}
    >
      {recovered ? <span className="inline-block size-2 shrink-0 rounded-full bg-amber-400" /> : <StatusDot status={status} />}
      {recovered ? `Succeeded · ${errorCount} failed step${errorCount === 1 ? "" : "s"}` : STATUS[status].label}
    </span>
  );
}

const KINDS: Record<StepKind, { icon: typeof Sparkles; label: string; color: string; bg: string }> = {
  llm: { icon: Sparkles, label: "Model call", color: "text-brand-700 dark:text-brand-300", bg: "bg-brand-50 dark:bg-brand-400/10" },
  tool: { icon: Wrench, label: "Tool", color: "text-sky-600 dark:text-sky-400", bg: "bg-sky-50 dark:bg-sky-500/10" },
  agent: { icon: Bot, label: "Sub-agent", color: "text-teal-600 dark:text-teal-400", bg: "bg-teal-50 dark:bg-teal-500/10" },
  handoff: { icon: ArrowRightLeft, label: "Handoff", color: "text-teal-600 dark:text-teal-400", bg: "bg-teal-50 dark:bg-teal-500/10" },
  guardrail: { icon: Shield, label: "Guardrail", color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-500/10" },
  retrieval: { icon: Search, label: "Retrieval", color: "text-indigo-600 dark:text-indigo-400", bg: "bg-indigo-50 dark:bg-indigo-500/10" },
  decision: { icon: GitBranch, label: "Decision", color: "text-brand-700 dark:text-brand-300", bg: "bg-brand-50 dark:bg-brand-400/10" },
  event: { icon: Circle, label: "Step", color: "text-zinc-500", bg: "bg-zinc-100 dark:bg-white/[0.07]" },
  error: { icon: AlertTriangle, label: "Error", color: "text-rose-600 dark:text-rose-400", bg: "bg-rose-50 dark:bg-rose-500/10" },
};

export const kindLabel = (kind: StepKind) => (KINDS[kind] ?? KINDS.event).label;

export function KindIcon({ kind, failed, size = "md" }: { kind: StepKind; failed?: boolean; size?: "sm" | "md" }) {
  const meta = failed ? KINDS.error : (KINDS[kind] ?? KINDS.event);
  const Icon = meta.icon;
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-md", meta.bg, meta.color, size === "sm" ? "size-5" : "size-8 rounded-lg")} title={KINDS[kind]?.label}>
      <Icon className={size === "sm" ? "size-3" : "size-4"} />
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint: string; tone?: "bad" }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className={cx(LABEL, "flex items-center gap-1")}>
        {label}
        <Info className="size-3 opacity-50" />
      </div>
      <div className={cx("mt-1.5 truncate text-xl font-semibold tabular-nums", tone === "bad" && "text-rose-600 dark:text-rose-400")}>{value}</div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-zinc-100"
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1 dark:border-white/10">
        <span className="text-xs text-zinc-500">{title ?? "Terminal"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-white/5">{icon}</div>
      <div className="font-display text-lg font-bold tracking-tight">{title}</div>
      <div className="mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{children}</div>
    </div>
  );
}

export function Prose({ text }: { text: string }) {
  return (
    <div className="prose-lucid break-words">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

export function Chip({ children, active, title }: { children: ReactNode; active?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]",
        active ? "bg-brand-300 text-zinc-950" : "bg-zinc-100 text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

export function Section({ title, hint, children, aside }: { title: string; hint?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={LABEL} title={hint}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
