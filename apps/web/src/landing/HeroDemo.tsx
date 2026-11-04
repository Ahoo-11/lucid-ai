// The hero's sample run, played on a loop from when it scrolls into view:
// steps stream in, two edits fail, the Inbox groups the failure with a fix,
// the run recovers, and Arena replays a decision blind. The wording follows
// what Lucid itself shows.

import { AlertTriangle, CheckCircle2, FlaskConical, Lightbulb, Sparkles, Wrench } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { cx } from "../ui";
import { useClockInView } from "./clock";
import { BRANDS, BrandMark } from "./logos";

const LOOP = 15;
const INBOX = 4;
const FIX = 4.9;
const DONE = 7.3;
const ARENA = 8.3;
const REVEAL = 9.8;
const FADE = 14.3;

type DemoStep = { at: number; kind: "tool" | "llm"; title: string; detail: string; time: string; error?: string };

const STEPS: DemoStep[] = [
  { at: 0.5, kind: "tool", title: "Read", detail: "auth.ts, login.test.ts", time: "0.3s" },
  { at: 1.3, kind: "llm", title: "Model decision", detail: "The expiry check compares the wrong field. Patch session.ts.", time: "2.1s" },
  { at: 2.3, kind: "tool", title: "Edit", detail: "session.ts", time: "0.1s", error: "File has not been read yet. Read it first." },
  { at: 3.2, kind: "tool", title: "Edit", detail: "session.ts", time: "0.1s", error: "String to replace not found in file." },
  { at: 5.8, kind: "tool", title: "Read", detail: "session.ts", time: "0.2s" },
  { at: 6.5, kind: "tool", title: "Edit", detail: "session.ts · +3 −1", time: "0.2s" },
  { at: DONE, kind: "tool", title: "Bash", detail: "npm test · 14 passed", time: "4.8s" },
];

const ANSWERS = [
  { model: "claude-sonnet-4-5", note: "original", cost: "$0.012" },
  { model: "claude-haiku-4-5", note: "", cost: "$0.004" },
];

function Appear({ show, className, children }: { show: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cx("transition duration-500 ease-out motion-reduce:transition-none", show ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0", className)}>
      {children}
    </div>
  );
}

/** A product screen's window controls, as on the landing page's other screens. */
export function WindowDots() {
  return (
    <div className="flex shrink-0 gap-1.5">
      <span className="size-2.5 rounded-full bg-zinc-700" />
      <span className="size-2.5 rounded-full bg-zinc-700" />
      <span className="size-2.5 rounded-full bg-zinc-700" />
    </div>
  );
}

/** A card's place, outlined until the card arrives, so the panel reads as waiting rather than empty. */
function Slot({ show, label, className, children }: { show: boolean; label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx("relative", className)}>
      <div
        className={cx(
          "absolute inset-0 rounded-xl border border-dashed border-white/10 p-4 text-[11px] font-medium text-zinc-600 transition-opacity duration-500 motion-reduce:transition-none",
          show ? "opacity-0" : "opacity-100",
        )}
      >
        {label}
      </div>
      <Appear show={show}>{children}</Appear>
    </div>
  );
}

const minutes = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export function HeroDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const t = useClockInView(ref, 100, 12) % LOOP;
  const progress = Math.min(t, DONE) / DONE;
  const done = t >= DONE;
  return (
    <div
      ref={ref}
      role="img"
      aria-label="A sample run in Lucid: two failed edits are grouped in the Inbox with a suggested fix, then Arena finds a cheaper model that makes the same decision."
      className="relative"
    >
      <div aria-hidden className="relative rounded-2xl bg-zinc-900 p-1.5 shadow-xl shadow-zinc-900/15 ring-1 ring-zinc-900">
        <div className="flex items-center gap-3 px-3 py-2">
          <WindowDots />
          {/* The app's own tabs. */}
          <div className="hidden items-center gap-1 text-xs sm:flex">
            <span className="flex items-center gap-1.5 rounded-md px-2 py-1 text-zinc-500">
              Inbox
              <span className={cx("rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold leading-4 text-white transition-opacity", t >= INBOX ? "opacity-100" : "opacity-0")}>1</span>
            </span>
            <span className="rounded-md bg-white/10 px-2 py-1 text-zinc-100">Sessions</span>
            <span className="rounded-md px-2 py-1 text-zinc-500">Usage</span>
            <span className="rounded-md px-2 py-1 text-zinc-500">Connect</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Sample run
          </div>
        </div>
        <div
          className={cx(
            "grid grid-cols-1 gap-1.5 text-left transition-opacity duration-500 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]",
            t > FADE ? "opacity-0" : "opacity-100",
          )}
        >
          <div className="rounded-xl bg-zinc-950 p-4 ring-1 ring-white/5 sm:p-5">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
              <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/5 ring-1 ring-white/10">
                  <BrandMark brand={BRANDS.claudeCode} className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white">Fix the failing login test</div>
                  <div className="truncate font-mono text-[11px] text-zinc-500 tabular-nums">
                    Claude Code · {minutes(Math.round(progress * 190))} · ${(progress * 0.41).toFixed(2)}
                  </div>
                </div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/20">
                <span className={cx("size-1.5 rounded-full bg-amber-400", !done && "animate-pulse")} />
                {done ? "Succeeded · 2 failed steps" : "Running"}
              </span>
            </div>
            <ol className="mt-4 space-y-1">
              {STEPS.map((step) => (
                <li key={step.at}>
                  <Appear show={t >= step.at}>
                    <StepRow step={step} />
                  </Appear>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-1 content-start gap-1.5">
            <Slot show={t >= INBOX} label="Inbox">
              <div className="rounded-xl bg-zinc-950 p-4 ring-1 ring-rose-500/25">
                <div className="flex items-center justify-between gap-2 text-[11px] font-medium">
                  <span className="flex items-center gap-1.5 text-rose-300">
                    <AlertTriangle className="size-3.5" />
                    New in Inbox
                  </span>
                  <span className="text-zinc-500">12 runs this week</span>
                </div>
                <div className="mt-2 text-sm font-medium text-white">Claude Code edited a file it hadn't read</div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">The harness refuses edits to files the agent hasn't opened, so each try is a wasted model call.</p>
              </div>
            </Slot>
            <Slot show={t >= FIX} label="Suggested fix">
              <div className="rounded-xl bg-brand-300/[0.06] p-4 ring-1 ring-brand-300/25">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-brand-300">
                  <Lightbulb className="size-3.5" />
                  Suggested fix
                </div>
                <p className="mt-2 text-xs text-zinc-300">
                  Add one line to <code className="font-mono text-zinc-100">CLAUDE.md</code>:
                </p>
                <div className="mt-2 rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs text-brand-200 ring-1 ring-white/5">Read a file before you edit it.</div>
              </div>
            </Slot>
            {/* A phone has the run and its fix; Arena gets its own section further down. */}
            <Slot show={t >= ARENA} label="Arena" className="hidden sm:block">
              <div className="rounded-xl bg-zinc-950 p-4 ring-1 ring-white/10">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                  <FlaskConical className="size-3.5 text-brand-300" />
                  Arena · decision 2, replayed blind
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {ANSWERS.map((answer, i) => (
                    <div key={answer.model} className="rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-500">Answer {i + 1}</span>
                        <CheckCircle2 className="size-3.5 text-emerald-400" />
                      </div>
                      <div className={cx("mt-1.5 truncate font-mono text-[11px] transition duration-500", t >= REVEAL ? "text-zinc-200" : "text-zinc-500 blur-[4px]")}>
                        {answer.model}
                      </div>
                      <div className={cx("font-mono text-[11px] text-zinc-500 transition-opacity duration-500", t >= REVEAL ? "opacity-100" : "opacity-0")}>
                        {answer.cost}
                        {answer.note && ` · ${answer.note}`}
                      </div>
                    </div>
                  ))}
                </div>
                <Appear show={t >= REVEAL} className="mt-3 flex items-center gap-1.5 text-xs text-brand-200">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  Same fix from Haiku, for a third of the cost.
                </Appear>
              </div>
            </Slot>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: DemoStep }) {
  const Icon = step.error ? AlertTriangle : step.kind === "llm" ? Sparkles : Wrench;
  return (
    <div className={cx("flex items-start gap-2.5 rounded-lg px-2 py-1.5", step.error && "bg-rose-500/[0.07] ring-1 ring-rose-500/20")}>
      <span
        className={cx(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-md",
          step.error ? "bg-rose-400/10 text-rose-300" : step.kind === "llm" ? "bg-brand-300/10 text-brand-300" : "bg-sky-400/10 text-sky-300",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] text-zinc-200">
            <span className="font-medium">{step.title}</span>
            {step.kind === "tool" && <span className="text-zinc-500"> · {step.detail}</span>}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-600">{step.time}</span>
        </div>
        {step.kind === "llm" && <div className="truncate text-xs italic text-zinc-400">{step.detail}</div>}
        {step.error && <div className="truncate font-mono text-[11px] text-rose-300/90">{step.error}</div>}
      </div>
    </div>
  );
}
