// The public landing page: what Lucid does, what it plugs into, and that it
// is open source. White like the app, with the app's faint ASCII texture;
// product screens and code stay dark. The only request it makes is for the
// GitHub star count.

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronsRight,
  Coins,
  Copy,
  Dices,
  EyeOff,
  FlaskConical,
  KeyRound,
  Lightbulb,
  Network,
  Plug,
  Radio,
  Repeat,
  ScanSearch,
  Sparkles,
  Star,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { useClock } from "./clock";
import { HeroDemo } from "./HeroDemo";
import { AGENTS, BRANDS, type Brand, BrandMark, PROVIDERS } from "./logos";

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
      <AsciiField theme="light" />
      <Nav stars={stars} />
      <main>
        <Hero stars={stars} />
        <Problem />
        <HowItWorks />
        <Features />
        <OpenSource stars={stars} />
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
  ["#how", "How it works"],
  ["#features", "Features"],
  ["#open-source", "Open source"],
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

const ROTATION: { brand?: Brand; name: string }[] = [
  { brand: BRANDS.claudeCode, name: "Claude Code" },
  { brand: BRANDS.hermes, name: "Hermes Agent" },
  { brand: BRANDS.langgraph, name: "LangGraph" },
  { brand: BRANDS.vercel, name: "Vercel AI SDK" },
  { name: "your agent" },
];

/**
 * The agent in the headline, cycling. The names share one grid cell and the
 * chip takes the width of the one showing, measured again when fonts load or
 * the breakpoint changes the size. The column is held to the chip's width:
 * left to size itself it takes the longest name, and the one showing is then
 * centred in that, off to the right, and cut off.
 */
function AgentChip() {
  const active = Math.floor(useClock(200, 0) / 2.4) % ROTATION.length;
  const previous = (active - 1 + ROTATION.length) % ROTATION.length;
  const items = useRef<(HTMLSpanElement | null)[]>([]);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const item = items.current[active];
    if (!item) return;
    const measure = () => setWidth(item.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(item);
    return () => observer.disconnect();
  }, [active]);
  return (
    <span
      style={{ width }}
      className="inline-grid translate-y-[0.04em] grid-cols-[minmax(0,1fr)] place-items-center overflow-hidden rounded-[0.28em] bg-white pb-[0.06em] align-baseline shadow-[0_1px_2px_rgba(24,24,27,0.05)] ring-1 ring-zinc-900/10 transition-[width] duration-500 ease-out motion-reduce:transition-none"
    >
      {ROTATION.map((item, i) => (
        <span
          key={item.name}
          ref={(element) => {
            items.current[i] = element;
          }}
          className={cx(
            "col-start-1 row-start-1 inline-flex items-center gap-[0.2em] whitespace-nowrap px-[0.26em] transition duration-500 ease-out motion-reduce:transition-none",
            i === active ? "translate-y-0 opacity-100" : i === previous ? "-translate-y-[0.7em] opacity-0" : "translate-y-[0.7em] opacity-0",
          )}
        >
          {item.brand ? <BrandMark brand={item.brand} className="size-[0.72em]" /> : <Bot className="size-[0.72em] text-brand-700" strokeWidth={2.25} />}
          <span className={item.brand ? undefined : "text-brand-700"}>{item.name}</span>
        </span>
      ))}
    </span>
  );
}

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
          MIT core, self-host with Docker
          <ArrowRight className="size-3.5 text-zinc-500" />
        </a>
        <h1 className="mx-auto mt-7 max-w-5xl font-display text-[2.6rem] font-bold leading-[1.08] tracking-[-0.035em] text-zinc-950 sm:text-6xl lg:text-[5.25rem]">
          <span className="sr-only">Make your AI agent smarter every run</span>
          <span aria-hidden className="block">
            Make <AgentChip />
          </span>
          <span aria-hidden className="block">
            smarter{" "}
            <span className="relative whitespace-nowrap">
              every run
              <Underline />
            </span>
          </span>
        </h1>
        <p className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-zinc-600 sm:text-lg">
          See every prompt, tool call and decision your agent makes. Lucid finds where a run broke, tells you how to fix it, and proves which model or prompt does better on your own runs, blind.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <StartFree />
          <GitHubButton stars={stars} />
        </div>
        <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-zinc-500">
          {["Free while in beta", "MIT-licensed core", "Provider keys never stored"].map((item) => (
            <li key={item} className="flex items-center gap-1.5">
              <Check className="size-3.5 text-brand-700" />
              {item}
            </li>
          ))}
        </ul>
        <AgentLineup />
        <LogoWall />
      </div>
      <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-24 sm:px-6">
        <HeroDemo />
      </div>
    </section>
  );
}



/**
 * The agents people know by their faces, standing together as they do in
 * their own marketing: OpenClaw's Molty, Meta Muse's Jolly, Hermes Agent,
 * Grok Bot and OpenAI's dots (Todd, Iggy, Felipe, Alfred). Back to front, in
 * a 865 by 264 picture. Molty and Hermes stand over Jolly's edges.
 * Sources: Molty and Grok Bot from Lobe Icons (MIT), like the logos; the dots
 * from OpenAI's "Introducing dots" page; Jolly cut from a screenshot, as Meta
 * publishes no plain file of it.
 */
const LINEUP: PictureLayer[] = [
  { src: jolly, box: [143, 5, 162, 255] },
  { src: openclaw, box: [2, 46, 186, 186] },
  { src: grokbot, box: [435, 52, 212, 212] },
  { src: hermes, box: [272, 50, 205, 205] },
  { src: todd, box: [627, 64, 118, 118] },
  { src: iggy, box: [740, 67, 122, 122] },
  { src: felipe, box: [606, 132, 125, 125] },
  { src: alfred, box: [738, 134, 124, 124] },
];

/** The lineup through Lucid's ASCII filter, at low power, straight on the page. */
function AgentLineup() {
  return (
    <div className="mx-auto mt-16 max-w-4xl">
      <AsciiPicture layers={LINEUP} size={[865, 264]} alt="OpenClaw, Meta Muse, Hermes Agent, Grok Bot and OpenAI's dots" />
    </div>
  );
}

function LogoWall() {
  return (
    <div className="mx-auto mt-16 max-w-3xl">
      <p className="text-sm text-zinc-600">Plugs into the agents and models you already use</p>
      <LogoRow label="Works with" brands={AGENTS} />
      <LogoRow label="Model providers" brands={PROVIDERS} />
      <p className="mt-6 text-xs text-zinc-500">…and anything that speaks OpenTelemetry or an OpenAI-style API.</p>
    </div>
  );
}

function LogoRow({ label, brands }: { label: string; brands: Brand[] }) {
  return (
    <div className="mt-6">
      <div className="mb-3 font-mono text-[11px] text-zinc-500">{label}</div>
      <ul className="flex flex-wrap justify-center gap-2.5 sm:gap-3">
        {brands.map((brand) => (
          <li key={brand.name}>
            <LogoTile brand={brand} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LogoTile({ brand }: { brand: Brand }) {
  return (
    <span className="group relative flex size-12 items-center justify-center rounded-2xl bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,0.05)] ring-1 ring-zinc-900/10 transition hover:-translate-y-0.5 hover:ring-zinc-900/25 sm:size-14">
      <BrandMark brand={brand} className="size-6 sm:size-7" />
      <span className="sr-only">{brand.name}</span>
      <span
        aria-hidden
        className="pointer-events-none absolute top-full z-10 mt-2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-[11px] text-white opacity-0 transition group-hover:opacity-100"
      >
        {brand.name}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The problem

const PAINS = [
  { icon: EyeOff, title: "Failures hide in retries", text: "The agent retries until something works. The run looks fine; the bill doesn't." },
  { icon: Repeat, title: "The same bug, every day", text: "Without grouping, the twelfth failure looks as new as the first." },
  { icon: Dices, title: "Model roulette", text: "Switching models or prompts is a guess you test in production." },
];

function Problem() {
  return (
    <section id="why" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div>
          <Eyebrow>01 · The problem</Eyebrow>
          <SectionTitle>
            Your agent ran 47 steps, spent $3.20 and failed. <span className="text-zinc-500">Which step broke it?</span>
          </SectionTitle>
          <p className="mt-6 max-w-lg text-zinc-600 sm:text-lg">
            Logs show you everything and explain nothing: span trees, raw JSON, token counts. So you read transcripts until you find the one tool call that went sideways, and hope the next run doesn't do it again.
          </p>
        </div>
        <ul className="space-y-3">
          {PAINS.map((pain) => (
            <li key={pain.title} className="flex gap-4 rounded-2xl bg-white p-5 ring-1 ring-zinc-900/[0.07]">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20">
                <pain.icon className="size-5" />
              </span>
              <div>
                <div className="font-medium text-zinc-950">{pain.title}</div>
                <p className="mt-1 text-sm text-zinc-600">{pain.text}</p>
              </div>
            </li>
          ))}
          <li className="flex gap-4 rounded-2xl bg-brand-50 p-5 ring-1 ring-brand-600/25">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-300 text-zinc-950">
              <Sparkles className="size-5" />
            </span>
            <div>
              <div className="font-medium text-zinc-950">Lucid turns each run into a story</div>
              <p className="mt-1 text-sm text-zinc-600">Read what happened in a minute, see the failure grouped with every run it hit, and get the fix.</p>
            </div>
          </li>
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works

const HOW = [
  { icon: Plug, title: "Connect", text: "Change one URL, run one install command, or point OpenTelemetry at Lucid. Your agent code stays as it is." },
  { icon: ScanSearch, title: "See", text: "Every run becomes a story: what the agent was asked, what it decided, which tools it called, and what it cost." },
  { icon: Lightbulb, title: "Improve", text: "Failures arrive grouped by cause, with a fix. Arena proves which model or prompt does better, blind." },
];

type Snippet = { id: string; label: string; brand?: Brand; title: string; code: (origin: string) => string; note: string };

const SNIPPETS: Snippet[] = [
  {
    id: "proxy",
    label: "Any agent",
    title: "Python · OpenAI SDK",
    code: (origin) => `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${origin}/p/<lucid-key>/openai/v1",\n)\n# Nothing else changes. Lucid records each call and passes it on.`,
    note: "Same idea for Anthropic, Gemini, OpenRouter and seven more providers. Your provider key goes straight through and is never stored.",
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    brand: BRANDS.hermes,
    title: "Where Hermes runs (Windows: irm …/connect.ps1 | iex)",
    code: (origin) => `curl -fsSL ${origin}/connect.sh | sh`,
    note: "Prints a link: click Approve and it installs the Lucid plugin. No key to copy. Events wait on disk while Lucid is unreachable.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    brand: BRANDS.claudeCode,
    title: "Terminal (Windows: irm …/connect.ps1 | iex)",
    code: (origin) => `curl -fsSL ${origin}/connect.sh | sh`,
    note: "Prints a link: click Approve and it adds Lucid's hooks to Claude Code, backing up your settings first. No key to copy.",
  },
  {
    id: "otel",
    label: "OpenTelemetry",
    brand: BRANDS.otel,
    title: "Environment",
    code: (origin) => `export OTEL_EXPORTER_OTLP_ENDPOINT=${origin}\nexport OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<lucid-key>`,
    note: "Reads the OTel GenAI, OpenInference, OpenLLMetry and Vercel AI SDK conventions.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>02 · How it works</Eyebrow>
          <SectionTitle>Connect in a minute. Keep your code.</SectionTitle>
        </div>
        <ol className="mt-14 grid gap-4 md:grid-cols-3">
          {HOW.map((step, i) => (
            <li key={step.title} className="relative rounded-2xl bg-white p-6 ring-1 ring-zinc-900/[0.07]">
              <div className="flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-xl bg-zinc-900/[0.04] text-brand-700 ring-1 ring-zinc-900/10">
                  <step.icon className="size-5" />
                </span>
                <span className="font-display text-5xl font-bold text-zinc-900/[0.06]">{i + 1}</span>
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold text-zinc-950">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{step.text}</p>
            </li>
          ))}
        </ol>
        <Snippets />
      </div>
    </section>
  );
}

function Snippets() {
  const [active, setActive] = useState(SNIPPETS[0]!.id);
  const [copied, setCopied] = useState(false);
  const snippet = SNIPPETS.find((s) => s.id === active) ?? SNIPPETS[0]!;
  const code = snippet.code(window.location.origin);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mx-auto mt-10 max-w-3xl">
      <div role="tablist" aria-label="How your agent connects" className="flex flex-wrap justify-center gap-2">
        {SNIPPETS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === active}
            onClick={() => setActive(s.id)}
            className={cx(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ring-1 transition",
              s.id === active ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-900/10 hover:ring-zinc-900/25",
            )}
          >
            {s.brand ? <BrandMark brand={s.brand} className="size-4" /> : <Plug className="size-4" />}
            {s.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-5 overflow-hidden rounded-2xl bg-zinc-950 text-left ring-1 ring-zinc-900">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
          <span className="text-xs text-zinc-500">{snippet.title}</span>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-white">
            {copied ? <Check className="size-3.5 text-brand-300" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-zinc-300">
          {code.split("\n").map((line, i) => (
            <div key={i}>{highlight(line)}</div>
          ))}
        </pre>
      </div>
      <p className="mt-4 text-center text-sm text-zinc-500">
        {snippet.note} Your Lucid key is on the Connect page once you sign in.
      </p>
    </div>
  );
}

/** Just enough color to read a snippet: comments, strings and the key placeholder. */
function highlight(line: string): ReactNode {
  if (!line) return " ";
  if (/^\s*#/.test(line)) return <span className="text-zinc-500">{line}</span>;
  return line.split(/("[^"]*"|<lucid-key>)/g).map((part, i) =>
    part === "<lucid-key>" ? (
      <span key={i} className="text-sky-300">
        {part}
      </span>
    ) : part.startsWith('"') ? (
      <span key={i} className="text-brand-200">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

// ---------------------------------------------------------------------------
// Features

function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>03 · What you get</Eyebrow>
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
        <ul className="mt-24 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {EXTRAS.map((extra) => (
            <li key={extra.title} className="rounded-2xl bg-white p-5 ring-1 ring-zinc-900/[0.07]">
              <extra.icon className="size-5 text-brand-700" />
              <div className="mt-4 font-medium text-zinc-950">{extra.title}</div>
              <p className="mt-1 text-sm text-zinc-600">{extra.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const EXTRAS = [
  { icon: Coins, title: "Costs you can trust", text: "Per run and per step, priced from the live OpenRouter catalog, cache tokens included." },
  { icon: Radio, title: "Live", text: "Runs stream in while your agent works. No refresh, no batch jobs." },
  { icon: Network, title: "Sub-agents and handoffs", text: "Nested under the step that started them, so a swarm still reads top to bottom." },
  { icon: KeyRound, title: "Your keys stay yours", text: "The proxy forwards your provider key with each request and never stores it." },
];

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
      <div className="px-3 py-2 text-[11px] text-zinc-500">{label}</div>
      <div className="rounded-xl bg-zinc-950 p-5 ring-1 ring-white/5">{children}</div>
    </div>
  );
}

function MockLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium text-zinc-500">{children}</div>;
}

function StoryMock() {
  return (
    <MockFrame label="Runs › Fix the failing login test › Step 2">
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
// Open source

const OPEN_POINTS = [
  { title: "MIT-licensed core", text: "Capture, the run viewer and the Inbox. Fork it, change it, ship it." },
  { title: "Self-host with Docker", text: "Lucid and Postgres in one compose file. Put it behind your own HTTPS." },
  { title: "Your data, your disk", text: "Self-hosted, nothing leaves your server. Hosted, provider keys pass through and are never stored." },
];

function OpenSource({ stars }: { stars: number | null }) {
  return (
    <section id="open-source" className="relative scroll-mt-20 overflow-hidden border-t border-zinc-900/5 py-24 sm:py-32">

      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div>
          <Eyebrow>04 · Open source</Eyebrow>
          <SectionTitle>
            Open source. <span className="text-brand-700">Run it anywhere.</span>
          </SectionTitle>
          <p className="mt-6 max-w-lg text-zinc-600 sm:text-lg">
            Lucid's core is MIT-licensed. Read every line, run it on your own server and keep your traces on your own disk. Or use the hosted version and skip the setup.
          </p>
          <ul className="mt-8 space-y-4">
            {OPEN_POINTS.map((point) => (
              <li key={point.title} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-300 text-zinc-950">
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <div>
                  <div className="font-medium text-zinc-950">{point.title}</div>
                  <p className="text-sm text-zinc-600">{point.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <GitHubButton stars={stars} />
            <a
              href={`${GITHUB_URL}#readme`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-full px-5 py-3 text-[15px] font-medium text-zinc-700 transition hover:text-zinc-950"
            >
              Read the docs
              <ArrowRight className="size-4" />
            </a>
          </div>
        </div>
        <div className="space-y-4">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="block rounded-2xl bg-white p-5 ring-1 ring-zinc-900/10 transition hover:ring-zinc-900/20">
            <div className="flex items-center gap-3">
              <BrandMark brand={BRANDS.github} className="size-6 text-zinc-950" />
              <span className="font-mono text-sm text-zinc-800">
                Ahoo-11 / <span className="font-semibold text-zinc-950">lucid-ai</span>
              </span>
              {stars !== null && (
                <span className="ml-auto flex items-center gap-1 text-sm text-zinc-600 tabular-nums">
                  <Star className="size-4" />
                  {formatStars(stars)}
                </span>
              )}
            </div>
            <p className="mt-3 text-sm text-zinc-600">Observability and blind model testing for AI agents.</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-[#3178c6]" />
                TypeScript
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-[#3572a5]" />
                Python
              </span>
              <span className="rounded-full px-2 py-0.5 ring-1 ring-zinc-900/15">MIT core</span>
            </div>
          </a>
          <div className="overflow-hidden rounded-2xl bg-zinc-950 ring-1 ring-zinc-900">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-2.5">
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="ml-2 text-xs text-zinc-500">Self-host</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-loose text-zinc-300">
              <Prompt>git clone {GITHUB_URL}</Prompt>
              <Prompt>cd lucid-ai/selfhost</Prompt>
              <Prompt>
                echo <span className="text-brand-200">"POSTGRES_PASSWORD=$(openssl rand -hex 16)"</span> &gt; .env
              </Prompt>
              <Prompt>docker compose up -d</Prompt>
              <div className="text-zinc-500"># Open http://localhost:4318 and create the first account</div>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function Prompt({ children }: { children: ReactNode }) {
  return (
    <div>
      <span className="text-brand-300 select-none">$ </span>
      {children}
    </div>
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
    a: "Hosted Lucid is free while it's in beta. The core is open source under MIT, so self-hosting costs nothing but your server.",
  },
  {
    q: "Can I self-host it?",
    a: "Yes. Clone the repo, set a Postgres password, and run docker compose up in selfhost/. Sign-in is built-in email and password, or Clerk if you set its keys.",
  },
];

function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 border-t border-zinc-900/5 py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <div className="text-center">
          <Eyebrow>05 · FAQ</Eyebrow>
          <SectionTitle>Questions, answered</SectionTitle>
        </div>
        <div className="mt-12 divide-y divide-zinc-900/[0.07] rounded-2xl bg-white ring-1 ring-zinc-900/[0.07]">
          {FAQ.map((item) => (
            <details key={item.q} className="group px-5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium text-zinc-950 [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown className="size-5 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-5 text-zinc-600">{item.a}</p>
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
    <section className="relative overflow-hidden border-t border-zinc-900/5 py-24 sm:py-32">

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2">
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
    </section>
  );
}

/** Lucid in the middle, the agents on the inner ring and the model providers on the outer one. */
function Orbit() {
  return (
    <div aria-hidden className="relative mx-auto size-[19rem] [--inner:5.8rem] [--outer:9.5rem] sm:size-[26rem] sm:[--inner:8rem] sm:[--outer:13rem]">
      <div className="absolute inset-0 rounded-full border border-zinc-900/[0.07]" />
      <div className="absolute inset-[19%] rounded-full border border-dashed border-zinc-900/[0.08]" />
      <Ring brands={PROVIDERS} radius="var(--outer)" className="motion-safe:animate-[orbit_90s_linear_infinite]" tileClass="motion-safe:animate-[orbit_90s_linear_infinite_reverse]" />
      <Ring brands={AGENTS} radius="var(--inner)" className="motion-safe:animate-[orbit_60s_linear_infinite_reverse]" tileClass="motion-safe:animate-[orbit_60s_linear_infinite]" />
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
            <a href="#how">How it works</a>
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
            <a href="#open-source">Self-host</a>
          </FooterColumn>
          <FooterColumn title="Account">
            <Link to="/sign-in">Sign in</Link>
            <Link to="/sign-in">Start free</Link>
          </FooterColumn>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-6xl px-4 text-xs text-zinc-400 sm:px-6">© {new Date().getFullYear()} Lucid · MIT-licensed core</div>
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
