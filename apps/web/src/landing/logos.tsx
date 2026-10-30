// Logos of the agents, frameworks and model providers Lucid connects to. The
// SVGs come from Lobe Icons (MIT) and, for OpenTelemetry, Simple Icons (CC0).
// They are committed after review (no scripts or links) and rendered inline,
// so single-color marks take the text color.

import { useId, useMemo } from "react";
import { cx } from "../ui";
import anthropic from "./logos/anthropic.svg?raw";
import claudecode from "./logos/claudecode.svg?raw";
import deepseek from "./logos/deepseek.svg?raw";
import fireworks from "./logos/fireworks.svg?raw";
import gemini from "./logos/gemini.svg?raw";
import github from "./logos/github.svg?raw";
import groq from "./logos/groq.svg?raw";
import hermesagent from "./logos/hermesagent.svg?raw";
import langchain from "./logos/langchain.svg?raw";
import langgraph from "./logos/langgraph.svg?raw";
import mistral from "./logos/mistral.svg?raw";
import openai from "./logos/openai.svg?raw";
import openrouter from "./logos/openrouter.svg?raw";
import opentelemetry from "./logos/opentelemetry.svg?raw";
import together from "./logos/together.svg?raw";
import vercel from "./logos/vercel.svg?raw";
import xai from "./logos/xai.svg?raw";

export type Brand = { name: string; svg: string };

export const BRANDS = {
  claudeCode: { name: "Claude Code", svg: claudecode },
  hermes: { name: "Hermes Agent", svg: hermesagent },
  langgraph: { name: "LangGraph", svg: langgraph },
  langchain: { name: "LangChain", svg: langchain },
  vercel: { name: "Vercel AI SDK", svg: vercel },
  otel: { name: "OpenTelemetry", svg: opentelemetry },
  openai: { name: "OpenAI", svg: openai },
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

/** Only what connects today: native integrations, the proxy, and OpenTelemetry. */
export const AGENTS: Brand[] = [BRANDS.claudeCode, BRANDS.hermes, BRANDS.langgraph, BRANDS.langchain, BRANDS.vercel, BRANDS.otel];
export const PROVIDERS: Brand[] = [
  BRANDS.openai,
  BRANDS.anthropic,
  BRANDS.gemini,
  BRANDS.openrouter,
  BRANDS.deepseek,
  BRANDS.mistral,
  BRANDS.groq,
  BRANDS.xai,
  BRANDS.together,
  BRANDS.fireworks,
];

/** Gradient ids inside a logo would collide when it appears twice on a page, so each copy gets its own. */
function uniqueIds(svg: string, suffix: string) {
  return svg.replace(/id="([^"]+)"/g, `id="$1${suffix}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`);
}

export function BrandMark({ brand, className }: { brand: Brand; className?: string }) {
  const suffix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const html = useMemo(() => uniqueIds(brand.svg, suffix), [brand.svg, suffix]);
  return <span aria-hidden className={cx("inline-flex shrink-0 [&>svg]:size-full", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
