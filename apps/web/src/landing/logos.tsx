// Logos of the agents, frameworks and model providers Lucid connects to. The
// SVGs come from Lobe Icons (MIT) and, for OpenTelemetry, Simple Icons (CC0).
// They are committed after review (no scripts or links) and rendered inline,
// so single-color marks take the text color.

import { useId, useMemo } from "react";
import { cx } from "../ui";
import dots from "./agents/dots-felipe.webp";
import grokbot from "./agents/grokbot.svg?raw";
import openclaw from "./agents/openclaw.svg?raw";
import anthropic from "./logos/anthropic.svg?raw";
import claudecode from "./logos/claudecode.svg?raw";
import crewai from "./logos/crewai.svg?raw";
import deepseek from "./logos/deepseek.svg?raw";
import fireworks from "./logos/fireworks.svg?raw";
import gemini from "./logos/gemini.svg?raw";
import github from "./logos/github.svg?raw";
import groq from "./logos/groq.svg?raw";
import hermesagent from "./logos/hermesagent.svg?raw";
import langchain from "./logos/langchain.svg?raw";
import langgraph from "./logos/langgraph.svg?raw";
import meta from "./logos/meta.svg?raw";
import mistral from "./logos/mistral.svg?raw";
import muse from "./logos/muse.svg?raw";
import openai from "./logos/openai.svg?raw";
import openrouter from "./logos/openrouter.svg?raw";
import opentelemetry from "./logos/opentelemetry.svg?raw";
import pydanticai from "./logos/pydanticai.svg?raw";
import together from "./logos/together.svg?raw";
import vercel from "./logos/vercel.svg?raw";
import xai from "./logos/xai.svg?raw";

/** `img`: a picture, for marks that only exist as one (OpenAI's Dots are characters, not a logo). */
export type Brand = { name: string; svg: string } | { name: string; img: string };

export const BRANDS = {
  claudeCode: { name: "Claude Code", svg: claudecode },
  hermes: { name: "Hermes Agent", svg: hermesagent },
  openclaw: { name: "OpenClaw", svg: openclaw },
  grokbot: { name: "Grok Bot", svg: grokbot },
  muse: { name: "Muse", svg: muse },
  dots: { name: "OpenAI Dots", img: dots },
  langgraph: { name: "LangGraph", svg: langgraph },
  langchain: { name: "LangChain", svg: langchain },
  crewai: { name: "CrewAI", svg: crewai },
  pydanticai: { name: "Pydantic AI", svg: pydanticai },
  vercel: { name: "Vercel AI SDK", svg: vercel },
  otel: { name: "OpenTelemetry", svg: opentelemetry },
  openai: { name: "OpenAI", svg: openai },
  meta: { name: "Meta Muse Spark", svg: meta },
  anthropic: { name: "Anthropic", svg: anthropic },
  gemini: { name: "Gemini", svg: gemini },
  openrouter: { name: "OpenRouter", svg: openrouter },
  deepseek: { name: "DeepSeek", svg: deepseek },
  mistral: { name: "Mistral", svg: mistral },
  groq: { name: "Groq", svg: groq },
  xai: { name: "xAI", svg: xai },
  together: { name: "Together AI", svg: together },
  fireworks: { name: "Fireworks", svg: fireworks },
  github: { name: "GitHub", svg: github },
} satisfies Record<string, Brand>;

/** Gradient ids inside a logo would collide when it appears twice on a page, so each copy gets its own. */
function uniqueIds(svg: string, suffix: string) {
  return svg.replace(/id="([^"]+)"/g, `id="$1${suffix}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`);
}

export function BrandMark({ brand, className }: { brand: Brand; className?: string }) {
  const suffix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svg = "svg" in brand ? brand.svg : "";
  const html = useMemo(() => uniqueIds(svg, suffix), [svg, suffix]);
  if ("img" in brand) return <img src={brand.img} alt="" aria-hidden className={cx("shrink-0 object-contain", className)} />;
  return <span aria-hidden className={cx("inline-flex shrink-0 [&>svg]:size-full", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
