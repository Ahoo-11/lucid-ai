// Lucid's brand pieces, shared by the landing page and the sign-in screens:
// the mark, the hand-drawn underline, the trace line and the grid backdrop.

import { useEffect } from "react";
import { cx } from "./ui";

export const GITHUB_REPO = "Ahoo-11/lucid-ai";
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

const LOGO_SIZES = { md: ["size-7", "size-3"], lg: ["size-10", "size-4"], xl: ["size-14", "size-6"] } as const;

export function Logo({ size = "md" }: { size?: keyof typeof LOGO_SIZES }) {
  const [outer, inner] = LOGO_SIZES[size];
  return (
    <span className={cx("relative flex shrink-0 items-center justify-center rounded-full bg-brand-300 shadow-lg shadow-brand-400/20", outer)}>
      <span className={cx("rounded-full bg-zinc-950", inner)} />
    </span>
  );
}

/** A hand-drawn lime stroke under the last words of a headline; the parent must be `relative`. */
export function Underline() {
  return (
    <svg aria-hidden viewBox="0 0 300 24" preserveAspectRatio="none" className="absolute -bottom-[0.14em] left-0 h-[0.24em] w-full text-brand-300">
      <path
        d="M4 16 C 70 6, 140 4, 190 11 S 270 20, 296 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        pathLength={1}
        className="[stroke-dasharray:1] motion-safe:animate-[draw_1.2s_0.4s_ease-out_both]"
      />
    </svg>
  );
}

const TRACE_PATH = "M-10 20 C 80 30, 160 80, 130 160 S 30 260, 110 310 S 240 360, 250 430";

/** A run's trace, drawn as a line: one step failed (rose), the last one landed (lime). */
export function TraceLine({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 260 440" fill="none" className={className}>
      <path d={TRACE_PATH} stroke="rgba(255,255,255,0.13)" strokeWidth="1.5" />
      <path d={TRACE_PATH} stroke="#d8f84a" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="36 444" className="opacity-70 motion-safe:animate-[trace_8s_linear_infinite]" />
      <circle cx="130" cy="160" r="5" fill="#09090b" stroke="#fb7185" strokeWidth="1.5" />
      <circle cx="110" cy="310" r="4" fill="#09090b" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
      <circle cx="250" cy="430" r="5" fill="#d8f84a" />
    </svg>
  );
}

const GRID = {
  backgroundImage: "linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)",
  backgroundSize: "56px 56px",
};

/** A faint grid with a lime glow, fading out from the top edge or from the center. */
export function GridGlow({ from = "top" }: { from?: "top" | "center" }) {
  const top = from === "top";
  return (
    <>
      <div
        className={cx(
          "absolute inset-0",
          top ? "[mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)]" : "[mask-image:radial-gradient(ellipse_65%_55%_at_50%_50%,black,transparent)]",
        )}
        style={GRID}
      />
      <div
        className={cx(
          "absolute left-1/2 -translate-x-1/2 rounded-full bg-brand-300/[0.09] blur-[120px]",
          top ? "top-[-20rem] h-[36rem] w-[64rem]" : "top-1/2 h-[26rem] w-[36rem] -translate-y-1/2",
        )}
      />
    </>
  );
}

/** For pages that are dark whatever the system theme: keep overscroll, scrollbars and form controls dark too. */
export function useDarkDocument() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = { background: root.style.backgroundColor, scheme: root.style.colorScheme };
    root.style.backgroundColor = "#09090b";
    root.style.colorScheme = "dark";
    return () => {
      root.style.backgroundColor = previous.background;
      root.style.colorScheme = previous.scheme;
    };
  }, []);
}
