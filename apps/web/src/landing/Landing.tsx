// The public landing page: what Lucid is, the agents it watches, what you
// get, and the questions people ask. White like the app, with its faint ASCII
// texture; product screens stay dark. The only request it makes is for the
// GitHub star count.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronsRight, FlaskConical, Lightbulb, Plus, Sparkles, Star } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { AsciiField, AsciiPicture, type PictureLayer } from "../ascii";
import { GITHUB_REPO, GITHUB_URL, Logo, Underline } from "../brand";
import { cx } from "../ui";
import alfred from "./agents/dots-alfred.webp";
import felipe from "./agents/dots-felipe.webp";
import iggy from "./agents/dots-iggy.webp";
import todd from "./agents/dots-todd.webp";
import grokbot from "./agents/grokbot.svg?raw";
import jolly from "./agents/jolly.webp";
import openclaw from "./agents/openclaw.svg?raw";
import hermes from "./logos/hermesagent.svg?raw";
import { HeroDemo, WindowDots } from "./HeroDemo";
import { CONNECTS_TODAY } from "../pages/ConnectWizard";
import { BRANDS, type Brand, BrandMark } from "./logos";

export function Landing() {
  const stars = useGitHubStars();

  // The nav links jump to sections on this page.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, []);
  return (
    // Its own stacking context, so the ASCII field sits above the page colour and under everything else.
    <div className="relative isolate min-h-dvh overflow-x-clip bg-paper text-zinc-900">
      <AsciiField theme="light" scrolls />
      <Nav stars={stars} />
      <main>
        <Hero stars={stars} />
        <Features />
        <Faq />
        <FinalCta stars={stars} />
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces

function useGitHubStars() {
  const query = useQuery({
    queryKey: ["github-stars"],
    queryFn: async () => {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`);
      // Private, renamed or rate-limited: the buttons still work, just without a count.
      if (!response.ok) return null;
      return ((await response.json()) as { stargazers_count?: number }).stargazers_count ?? null;
    },
    staleTime: 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // "0 stars" reads as "nobody uses it": the count shows once there's a few.
  return query.data != null && query.data >= SHOW_STARS_FROM ? query.data : null;
}

const SHOW_STARS_FROM = 10;

const formatStars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function StartFree({ className, children = "Start free" }: { className?: string; children?: ReactNode }) {
  return (
    <Link
      to="/sign-in"
      className={cx(
        "group inline-flex items-center justify-center gap-2 rounded-full bg-brand-300 px-6 py-3 text-[15px] font-semibold text-zinc-950 ring-1 ring-black/5 ring-inset transition hover:bg-brand-200",
        className,
      )}
    >
      {children}
      <ChevronsRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function GitHubButton({ stars }: { stars: number | null }) {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-[15px] font-medium text-zinc-950 shadow-[0_1px_2px_rgba(24,24,27,0.05)] ring-1 ring-zinc-900/15 transition hover:bg-zinc-50"
    >
      <BrandMark brand={BRANDS.github} className="size-[18px]" />
      Star on GitHub
      {stars !== null && (
        <span className="flex items-center gap-1 rounded-full bg-zinc-900/[0.07] px-2 py-0.5 text-xs tabular-nums text-zinc-700">
          <Star className="size-3" />
          {formatStars(stars)}
        </span>
      )}
    </a>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="font-mono text-xs tracking-wide text-brand-700">{children}</div>;
}

function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx("mt-3 font-display text-3xl font-bold leading-[1.1] tracking-[-0.02em] text-balance text-zinc-950 sm:text-5xl", className)}>{children}</h2>;
}

// ---------------------------------------------------------------------------
// Nav

const NAV = [
  ["#features", "Features"],
  ["#faq", "FAQ"],
] as const;

function Nav({ stars }: { stars: number | null }) {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-900/5 bg-paper/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5 font-display text-xl font-bold tracking-tight text-zinc-950">
          <Logo />
          Lucid
        </a>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map(([href, label]) => (
            <a key={href} href={href} className="rounded-full px-3 py-1.5 text-sm text-zinc-600 transition hover:bg-zinc-900/[0.04] hover:text-zinc-950">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-900/[0.04] hover:text-zinc-950 sm:inline-flex"
          >
            <BrandMark brand={BRANDS.github} className="size-4" />
            {stars !== null ? <span className="tabular-nums">{formatStars(stars)}</span> : "GitHub"}
          </a>
          <Link to="/sign-in" className="rounded-full px-4 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-900/15 transition hover:bg-zinc-900/[0.04]">
            Sign in
          </Link>
          <Link to="/sign-in" className="rounded-full bg-brand-300 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-brand-200">
            Start free
          </Link>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hero

function Hero({ stars }: { stars: number | null }) {
  return (
    <section id="top" className="relative scroll-mt-20">
      <div className="relative mx-auto max-w-6xl px-4 pt-14 text-center sm:px-6 sm:pt-20">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-zinc-900/[0.04] py-1 pr-3 pl-1 text-xs text-zinc-700 ring-1 ring-zinc-900/10 transition hover:ring-zinc-900/25"
        >
          <span className="rounded-full bg-brand-300 px-2 py-0.5 font-semibold text-zinc-950">Open source</span>
          MIT licensed, self-host with Docker
          <ArrowRight className="size-3.5 text-zinc-500" />
        </a>
        <h1 className="mx-auto mt-7 max-w-5xl font-display text-[2.6rem] font-bold leading-[1.05] tracking-[-0.035em] text-balance text-zinc-950 sm:text-6xl lg:text-[4.75rem]">
          <span className="block">AI Agent Observability,</span>
          <span className="block">
            Made{" "}
            <span className="relative whitespace-nowrap">
              Simple
              <Underline />
            </span>{" "}
            for Everyone
          </span>
        </h1>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <StartFree />
          <GitHubButton stars={stars} />
        </div>
        <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-zinc-500">
          {["Free while in beta", "MIT licensed", "Provider keys never stored"].map((item) => (
            <li key={item} className="flex items-center gap-1.5">
              <Check className="size-3.5 text-brand-700" />
              {item}
            </li>
          ))}
        </ul>
        <AgentLineup />
      </div>
      <LogoBand />
      <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-24 sm:px-6 sm:pt-20">
        <HeroDemo />
      </div>
    </section>
  );
}

/**
 * The agents people know by their faces, standing together as they do in
 * their own marketing: OpenClaw's Molty, Meta Muse's Jolly, Hermes Agent,
 * Grok Bot and OpenAI's dots (Todd, Iggy, Felipe, Alfred). Back to front, in
 * a 865 by 264 picture. Molty and Hermes stand over Jolly's edges, and
 * Molty's claw hides a bite the screenshot left in Jolly's side.
 * Sources: Molty and Grok Bot from Lobe Icons (MIT), like the logos; the dots
 * from OpenAI's "Introducing dots" page; Jolly cut from a screenshot, as Meta
 * publishes no plain file of it.
 */
const LINEUP: PictureLayer[] = [
  { src: jolly, box: [143, 29, 149, 235] },
  { src: openclaw, box: [2, 68, 186, 186] },
  { src: grokbot, box: [435, 52, 212, 212] },
  { src: hermes, box: [272, 50, 205, 205] },
  { src: todd, box: [627, 64, 118, 118] },
  { src: iggy, box: [740, 67, 122, 122] },
  { src: felipe, box: [606, 132, 125, 125] },
  { src: alfred, box: [738, 134, 124, 124] },
];

/** The lineup through Lucid's ASCII filter, at low power, straight on the page. They stand on the logo band's top line. */
function AgentLineup() {
  return (
    <div className="mx-auto mt-14 max-w-4xl sm:mt-16">
      <AsciiPicture layers={LINEUP} size={[865, 264]} alt="OpenClaw, Meta Muse, Hermes Agent, Grok Bot and OpenAI's dots" />
    </div>
  );
}

/** What connects today, as a band across the page between the hero and the demo. */
function LogoBand() {
  return (
    <div>
      <div className="border-y border-zinc-900/[0.08] bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-5 sm:flex-row sm:gap-6 sm:px-6">
          <p className="shrink-0 text-center text-sm leading-snug sm:border-r sm:border-zinc-900/[0.08] sm:pr-6 sm:text-left">
            <span className="font-medium text-zinc-950">Works with</span>
            <span className="text-zinc-500 sm:block"> the agents you already use</span>
          </p>
          <LogoStrip brands={CONNECTS_TODAY} />
        </div>
      </div>
      <p className="mt-4 px-4 text-center text-xs text-balance text-zinc-500">…and anything that speaks OpenTelemetry or an OpenAI-style API.</p>
    </div>
  );
}

/**
 * The logos gliding left, "as seen on" style. The row is there twice and
 * moves by half its width, so it loops without a seam. It pauses under the
 * pointer, and holds still (and scrolls) for people who ask for less motion.
 */
function LogoStrip({ brands }: { brands: Brand[] }) {
  return (
    <div className="w-full min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] motion-reduce:overflow-x-auto">
      <div className="flex w-max motion-safe:animate-[marquee_50s_linear_infinite] hover:[animation-play-state:paused]">
        {[0, 1].map((copy) => (
          <ul key={copy} aria-hidden={copy === 1 || undefined} className={cx("flex shrink-0 items-center py-2", copy === 1 && "motion-reduce:hidden")}>
            {brands.map((brand) => (
              <li key={brand.name} className="flex shrink-0 items-center gap-2.5 pr-10 text-sm font-medium whitespace-nowrap text-zinc-700">
                <BrandMark brand={brand} className="size-6" />
                {brand.name}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Features

function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>01 · What you get</Eyebrow>
          <SectionTitle>
            See it. Fix it. <span className="text-brand-700">Prove it.</span>
          </SectionTitle>
        </div>
        <div className="mt-16 space-y-20 sm:space-y-28">
          <FeatureRow
            step="See it"
            title="Read any run like a story"
            text="Outcome first, then every step in plain words: what the model was asked, which tools it was offered, what it chose and why. Sub-agents nest under the step that started them."
            points={["Prompts, reasoning and tool inputs side by side", "Cost per step, cache tokens included", "New runs appear while the agent works"]}
            visual={<StoryMock />}
          />
          <FeatureRow
            flip
            step="Fix it"
            title="Every failure grouped, with the fix"
            text="The Inbox groups failed steps by cause across all your runs, explains why each one happens and suggests the fix. The ones hitting the most runs come first, so you fix patterns, not one-offs."
            points={["Grouped by what failed and how", "A plain-English cause for each group", "A fix you can paste into your agent's instructions"]}
            visual={<InboxMock />}
          />
          <FeatureRow
            step="Prove it"
            title="Find the better model, blind"
            text="Replay a real decision from your runs with other models or a changed prompt. Tools are offered but never run. Vote on unlabeled answers, let an AI judge vote too, then reveal which was which."
            points={["Your exact requests, full tool schemas included", "The judge never sees model names", "Try prompts, not just models"]}
            visual={<ArenaMock />}
          />
        </div>
      </div>
    </section>
  );
}

function FeatureRow({ step, title, text, points, visual, flip }: { step: string; title: string; text: string; points: string[]; visual: ReactNode; flip?: boolean }) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={cx(flip && "lg:order-2")}>
        <div className="inline-flex items-center gap-2 rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-600/25">{step}</div>
        <h3 className="mt-4 font-display text-2xl font-bold tracking-tight text-balance text-zinc-950 sm:text-4xl">{title}</h3>
        <p className="mt-4 leading-relaxed text-zinc-600 sm:text-lg">{text}</p>
        <ul className="mt-6 space-y-2.5">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-sm text-zinc-700">
              <Check className="mt-0.5 size-4 shrink-0 text-brand-700" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <div className={cx(flip && "lg:order-1")}>{visual}</div>
    </div>
  );
}

function MockFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="rounded-2xl bg-zinc-900 p-1.5 shadow-xl shadow-zinc-900/15 ring-1 ring-zinc-900">
      <div className="flex items-center gap-3 px-3 py-2">
        <WindowDots />
        <span className="min-w-0 truncate text-[11px] text-zinc-500">{label}</span>
      </div>
      <div className="rounded-xl bg-zinc-950 p-5 ring-1 ring-white/5">{children}</div>
    </div>
  );
}

function MockLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium text-zinc-500">{children}</div>;
}

function StoryMock() {
  return (
    <MockFrame label="Sessions › Fix the failing login test › Step 2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
        <span className="flex size-6 items-center justify-center rounded-md bg-brand-300/10 text-brand-300">
          <Sparkles className="size-3.5" />
        </span>
        <span className="font-medium text-zinc-200">Model decision</span>
        <span className="font-mono text-zinc-500">claude-sonnet-4-5</span>
        <span className="ml-auto font-mono text-[11px] text-zinc-500 tabular-nums">2.1s · $0.012</span>
      </div>
      <div className="mt-5">
        <MockLabel>Asked</MockLabel>
        <p className="mt-1 text-sm text-zinc-300">"The login test fails after the token refactor. Fix it."</p>
      </div>
      <div className="mt-5">
        <MockLabel>Offered 14 tools, chose one</MockLabel>
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
          <span className="rounded-md bg-brand-300 px-1.5 py-0.5 font-semibold text-zinc-950">Edit</span>
          {["Read", "Grep", "Bash", "Write", "Glob", "+8"].map((tool) => (
            <span key={tool} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-zinc-400">
              {tool}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-5">
        <MockLabel>Why</MockLabel>
        <p className="mt-1.5 border-l-2 border-brand-300/40 pl-3 text-sm italic leading-relaxed text-zinc-400">
          The test expects a 401 for an expired token. session.ts compares issuedAt instead of expiresAt, so expired tokens still pass.
        </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/5 pt-3 font-mono text-[11px] text-zinc-500">
        <span>12.4k in</span>
        <span>9.8k cached</span>
        <span>412 out</span>
      </div>
    </MockFrame>
  );
}

const ISSUES = [
  { title: "Claude Code edited a file it hadn't read", runs: 12 },
  { title: "Bash ran a command that isn't installed", runs: 7 },
  { title: "The model provider rate-limited the agent", runs: 4 },
];

function InboxMock() {
  return (
    <MockFrame label="Inbox · grouped by cause, most runs first">
      <ul className="space-y-2">
        {ISSUES.map((issue, i) => (
          <li key={issue.title} className={cx("rounded-xl ring-1", i === 0 ? "bg-white/[0.03] ring-white/10" : "ring-white/5")}>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-rose-400/10 text-rose-300">
                <AlertTriangle className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{issue.title}</span>
              <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] tabular-nums text-zinc-400">{issue.runs} runs</span>
              <ChevronDown className={cx("size-4 shrink-0 text-zinc-500", i !== 0 && "-rotate-90")} />
            </div>
            {i === 0 && (
              <div className="space-y-3 border-t border-white/5 px-3 py-3">
                <div>
                  <MockLabel>Why it happens</MockLabel>
                  <p className="mt-1 text-sm text-zinc-400">The harness refuses edits to files the agent hasn't opened in this session.</p>
                </div>
                <div className="rounded-lg bg-brand-300/[0.06] p-3 ring-1 ring-brand-300/20">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-brand-300">
                    <Lightbulb className="size-3.5" />
                    Fix
                  </div>
                  <p className="mt-1 text-sm text-zinc-300">Tell the agent to read a file before editing it. This usually goes away once it's in its instructions.</p>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}

const ARENA_ANSWERS = [
  { text: "Edit session.ts to compare expiresAt instead of issuedAt.", model: "claude-sonnet-4-5", note: "original", cost: "$0.012" },
  { text: "Edit session.ts: check expiresAt against the current time.", model: "claude-haiku-4-5", note: "", cost: "$0.004" },
  { text: "Read session.ts first, then fix the expiry check.", model: "claude-sonnet-4-5", note: "new prompt", cost: "$0.011" },
];

function ArenaMock() {
  const [revealed, setRevealed] = useState(false);
  return (
    <MockFrame label="Arena · sample experiment">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <FlaskConical className="size-4 text-brand-300" />
          Which next step is better?
        </div>
        <button
          type="button"
          onClick={() => setRevealed(!revealed)}
          className="rounded-full bg-white/[0.06] px-3 py-1 text-xs font-medium text-zinc-200 ring-1 ring-white/10 transition hover:bg-white/10"
        >
          {revealed ? "Hide models" : "Reveal models"}
        </button>
      </div>
      <ol className="mt-4 space-y-2">
        {ARENA_ANSWERS.map((answer, i) => (
          <li key={answer.text} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.07]">
            <div className="flex items-center gap-2 text-[11px]">
              <kbd className="flex size-5 items-center justify-center rounded bg-white/10 font-mono text-zinc-300">{i + 1}</kbd>
              <span className={cx("font-mono transition duration-300", revealed ? "text-zinc-200" : "text-zinc-500 blur-[4px] select-none")}>
                {revealed ? `${answer.model}${answer.note && ` · ${answer.note}`}` : "hidden-until-reveal"}
              </span>
              <span className={cx("ml-auto font-mono text-zinc-500 transition-opacity", revealed ? "opacity-100" : "opacity-0")}>{answer.cost}</span>
            </div>
            <p className="mt-2 text-sm text-zinc-300">{answer.text}</p>
          </li>
        ))}
      </ol>
      <div className={cx("mt-4 grid transition-[grid-template-rows] duration-300", revealed ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <p className="rounded-lg bg-brand-300/[0.06] p-3 text-sm text-zinc-300 ring-1 ring-brand-300/20">
            <span className="font-medium text-brand-200">Haiku made the same call for a third of the cost.</span> The new prompt read the file first, which avoids the failed edit.
          </p>
        </div>
      </div>
    </MockFrame>
  );
}

// ---------------------------------------------------------------------------
// FAQ

const FAQ = [
  {
    q: "Which agents does Lucid work with?",
    a: "Claude Code and Hermes Agent connect natively. Anything that calls OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Mistral, Groq, xAI, Together or Fireworks works through the proxy, including LangChain, LangGraph and your own code. Frameworks that export OpenTelemetry (GenAI, OpenInference, OpenLLMetry, Vercel AI SDK) work too.",
  },
  {
    q: "Do I have to change my code?",
    a: "Usually one line: the model's base URL. Claude Code and Hermes take one command and a click on Approve, with no key to copy. OpenTelemetry users set two environment variables.",
  },
  {
    q: "Does Lucid see my API keys?",
    a: "Your provider key travels with each request to the provider, and Lucid never stores it. Lucid only needs its own project key to know whose runs these are.",
  },
  {
    q: "How is this different from other tracing tools?",
    a: "Tracing tools show you spans. Lucid is built around fixing: each run reads as a story, failures arrive grouped by cause with a suggested fix, and Arena replays your real decisions against other models and prompts, blind.",
  },
  {
    q: "Is it free?",
    a: "Hosted Lucid is free while it's in beta. Lucid is open source under the MIT license, so self-hosting costs nothing but your server.",
  },
  {
    q: "Can I self-host it?",
    a: "Yes. Clone the repo, set a Postgres password, and run docker compose up in selfhost/. Sign-in is built-in email and password, or Clerk if you set its keys.",
  },
];

function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-16">
        <div className="text-center lg:sticky lg:top-28 lg:self-start lg:text-left">
          <Eyebrow>02 · FAQ</Eyebrow>
          <SectionTitle>Questions, answered</SectionTitle>
          <p className="mt-5 text-zinc-600">
            Something else?{" "}
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="font-medium text-zinc-950 underline decoration-zinc-900/25 underline-offset-4 transition hover:decoration-zinc-900">
              Ask on GitHub
            </a>
          </p>
        </div>
        <div className="divide-y divide-zinc-900/[0.07] rounded-2xl bg-white ring-1 ring-zinc-900/[0.07]">
          {FAQ.map((item) => (
            <details key={item.q} className="group px-5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium text-zinc-950 [&::-webkit-details-marker]:hidden">
                {item.q}
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-900/[0.04] text-zinc-600 transition group-open:rotate-45 group-open:bg-zinc-900 group-open:text-white group-hover:bg-zinc-900/[0.08] group-open:group-hover:bg-zinc-900">
                  <Plus className="size-4" />
                </span>
              </summary>
              <p className="-mt-1 pr-10 pb-5 leading-relaxed text-zinc-600">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Closing call to action

function FinalCta({ stars }: { stars: number | null }) {
  return (
    <section className="border-t border-zinc-900/5 pt-24 pb-16 sm:pt-32 sm:pb-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid items-center gap-12 overflow-hidden rounded-[2rem] bg-white px-6 py-12 ring-1 ring-zinc-900/[0.07] sm:p-12 lg:grid-cols-2 xl:p-16">
          <div className="text-center lg:text-left">
            <h2 className="font-display text-4xl font-bold leading-[1.05] tracking-[-0.03em] text-balance text-zinc-950 sm:text-6xl">
              Stop guessing why your agent <span className="text-brand-700">failed.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-md text-zinc-600 sm:text-lg lg:mx-0">Connect your first agent in a minute. Free while in beta, open source for good.</p>
            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <StartFree />
              <GitHubButton stars={stars} />
            </div>
          </div>
          <Orbit />
        </div>
      </div>
    </section>
  );
}

/** Lucid in the middle, and around it everything that connects today. */
function Orbit() {
  return (
    // Sized so the logo tiles, which stick out past the ring, stay inside the card at every width.
    <div
      aria-hidden
      className="relative mx-auto size-[15rem] [--outer:7.5rem] sm:size-[24rem] sm:[--outer:12rem] lg:size-[22rem] lg:[--outer:11rem] xl:size-[24rem] xl:[--outer:12rem]"
    >
      <div className="absolute inset-0 rounded-full border border-zinc-900/[0.07]" />
      <div className="absolute inset-[19%] rounded-full border border-dashed border-zinc-900/[0.08]" />
      <Ring brands={CONNECTS_TODAY} radius="var(--outer)" className="motion-safe:animate-[orbit_90s_linear_infinite]" tileClass="motion-safe:animate-[orbit_90s_linear_infinite_reverse]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-20 items-center justify-center rounded-full bg-brand-300 ring-1 ring-black/10 sm:size-24">
          <span className="size-8 rounded-full bg-zinc-950 sm:size-10" />
        </span>
      </div>
    </div>
  );
}

function Ring({ brands, radius, className, tileClass }: { brands: Brand[]; radius: string; className: string; tileClass: string }) {
  return (
    <div className={cx("absolute inset-0", className)}>
      {brands.map((brand, i) => {
        const angle = (i / brands.length) * 360;
        return (
          <div key={brand.name} className="absolute top-1/2 left-1/2 size-0" style={{ transform: `rotate(${angle}deg) translateY(calc(-1 * ${radius})) rotate(${-angle}deg)` }}>
            <div className={cx("absolute -top-5 -left-5 size-10 sm:-top-6 sm:-left-6 sm:size-12", tileClass)}>
              <span className="flex size-full items-center justify-center rounded-xl bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,0.05)] ring-1 ring-zinc-900/10">
                <BrandMark brand={brand} className="size-5 sm:size-6" />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer

function Footer() {
  return (
    <footer className="border-t border-zinc-900/5 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5 font-display text-lg font-bold text-zinc-950">
            <Logo />
            Lucid
          </div>
          <p className="mt-3 text-sm text-zinc-500">Observability and blind model testing for AI agents.</p>
        </div>
        <div className="grid grid-cols-2 gap-10 text-sm sm:grid-cols-3">
          <FooterColumn title="Product">
            <a href="#features">Features</a>
            <a href="#faq">FAQ</a>
          </FooterColumn>
          <FooterColumn title="Open source">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={`${GITHUB_URL}#readme`} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a href={`${GITHUB_URL}/tree/main/selfhost`} target="_blank" rel="noreferrer">
              Self-host
            </a>
          </FooterColumn>
          <FooterColumn title="Account">
            <Link to="/sign-in">Sign in</Link>
            <Link to="/sign-in">Start free</Link>
          </FooterColumn>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-6xl px-4 text-xs text-zinc-400 sm:px-6">© {new Date().getFullYear()} Lucid · MIT licensed</div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-medium text-zinc-700">{title}</div>
      <div className="mt-3 flex flex-col gap-2 text-zinc-500 [&>a:hover]:text-zinc-950 [&>a]:transition">{children}</div>
    </div>
  );
}
