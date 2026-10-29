import {
  AlertTriangle,
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
import remarkGfm from "remark-gfm";
import type { Status, StepKind } from "./api";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900", className)}>{children}</div>;
}

const STATUS = {
  ok: { label: "Succeeded", dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400" },
  error: { label: "Failed", dot: "bg-rose-500", pill: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-400" },
  running: { label: "Running", dot: "bg-amber-400 animate-pulse", pill: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400" },
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
  llm: { icon: Sparkles, label: "Model call", color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-500/10" },
  tool: { icon: Wrench, label: "Tool", color: "text-sky-600 dark:text-sky-400", bg: "bg-sky-50 dark:bg-sky-500/10" },
  agent: { icon: Bot, label: "Sub-agent", color: "text-teal-600 dark:text-teal-400", bg: "bg-teal-50 dark:bg-teal-500/10" },
  handoff: { icon: ArrowRightLeft, label: "Handoff", color: "text-teal-600 dark:text-teal-400", bg: "bg-teal-50 dark:bg-teal-500/10" },
  guardrail: { icon: Shield, label: "Guardrail", color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-500/10" },
  retrieval: { icon: Search, label: "Retrieval", color: "text-indigo-600 dark:text-indigo-400", bg: "bg-indigo-50 dark:bg-indigo-500/10" },
  decision: { icon: GitBranch, label: "Decision", color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-500/10" },
  event: { icon: Circle, label: "Step", color: "text-zinc-500", bg: "bg-zinc-100 dark:bg-zinc-800" },
  error: { icon: AlertTriangle, label: "Error", color: "text-rose-600 dark:text-rose-400", bg: "bg-rose-50 dark:bg-rose-500/10" },
};

export const kindLabel = (kind: StepKind) => (KINDS[kind] ?? KINDS.event).label;

export function KindIcon({ kind, failed, size = "md" }: { kind: StepKind; failed?: boolean; size?: "sm" | "md" }) {
  const meta = failed ? KINDS.error : (KINDS[kind] ?? KINDS.event);
  const Icon = meta.icon;
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-md", meta.bg, meta.color, size === "sm" ? "size-5" : "size-7")} title={KINDS[kind]?.label}>
      <Icon className={size === "sm" ? "size-3" : "size-4"} />
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint: string; tone?: "bad" }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        {label}
        <Info className="size-3 opacity-60" />
      </div>
      <div className={cx("mt-0.5 truncate text-lg font-semibold tabular-nums", tone === "bad" && "text-rose-600 dark:text-rose-400")}>{value}</div>
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
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
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
      <div className="mb-3 text-zinc-400">{icon}</div>
      <div className="font-medium">{title}</div>
      <div className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{children}</div>
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
        active ? "bg-violet-600 text-white dark:bg-violet-500" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

export function Section({ title, hint, children, aside }: { title: string; hint?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400" title={hint}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
