// First, rule-based version of the Inbox: failed steps grouped by what failed
// and how, each with a plain-English explanation and a suggested fix. The
// LLM-written root causes come later and use the same shape.

export type Hint = { title: string; why: string; fix: string };

/**
 * When failures this rule matches have one cause whatever their exact words:
 * for the whole agent (its quota), for the agent's model calls (a rejected
 * key, an unreachable API), or per tool (the same tool timing out). "never":
 * not even the same words in another tool (people stopping the agent decide
 * each time). Unset: the same words in several tools are one cause.
 */
type Join = "agent" | "model" | "tool" | "never";

type Rule = { id: string; join?: Join; test: RegExp; hint: (tool: string) => Hint };

const RULES: Rule[] = [
  {
    id: "quota",
    join: "agent",
    test: /session limit|usage limit|hit your (\w+ )?limit|quota exceeded|insufficient_quota|credit balance/i,
    hint: () => ({
      title: "The agent ran out of usage quota",
      why: "The plan's usage limit or the API quota ran out mid-run, so the run stopped where it was.",
      fix: "Use a smaller model for sub-agents and routine steps, spread heavy work across the limit window, or raise the plan. Arena can tell you which steps a cheaper model handles just as well.",
    }),
  },
  {
    id: "auth",
    join: "model",
    test: /HTTP 401|HTTP 403|unauthori[sz]ed|invalid (api )?key|incorrect api key|user not found|authentication (failed|error)|missing authentication/i,
    hint: () => ({
      title: "The model provider rejected the API key",
      why: "The provider refused the agent's credentials, so no model call succeeded and the run stopped immediately.",
      fix: "Check the provider key the agent uses (for Hermes: `hermes auth` or the key in its .env). It may be revoked, expired, or for a different account.",
    }),
  },
  {
    id: "network",
    join: "model",
    test: /ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection (error|lost|dropped|refused)|can't reach the api|no response from (the )?api|socket hang up|network/i,
    hint: () => ({
      title: "The agent lost its connection to the model API",
      why: "Requests to the model provider failed at the network level. The harness retries these, but each retry adds delay.",
      fix: "Usually transient. If it keeps happening, check DNS, VPN or proxy settings on this machine.",
    }),
  },
  {
    id: "missing-command",
    test: /command not found|is not recognized as (an internal|the name of a cmdlet)|not found in path/i,
    hint: (tool) => ({
      title: `${tool} ran a command that isn't installed`,
      why: "The agent assumed a program exists on this machine. Every retry burns a model call.",
      fix: "List the available tools and shell in the agent's instructions (for Claude Code, CLAUDE.md), or install the missing program.",
    }),
  },
  {
    id: "unread",
    test: /has not been read yet|read it first|must read/i,
    hint: (tool) => ({
      title: `${tool} edited a file it hadn't read`,
      why: "The harness refuses edits to files the agent hasn't opened in this session.",
      fix: "Tell the agent to read a file before editing it; this usually goes away once that is in its instructions.",
    }),
  },
  {
    id: "stale-edit",
    test: /string to replace not found|old_string|no match(es)? found|did not match/i,
    hint: (tool) => ({
      title: `${tool} couldn't find the text it wanted to replace`,
      why: "The agent edited from memory and the file content differed (it changed, or whitespace didn't match).",
      fix: "Ask the agent to re-read the file right before editing and to copy the exact text it replaces.",
    }),
  },
  {
    id: "permission",
    test: /permission|denied|not allowed|blocked by|EACCES|EPERM/i,
    hint: (tool) => ({
      title: `${tool} was blocked by permissions`,
      why: "A permission rule, the sandbox or the OS refused the action.",
      fix: "If the action is expected, allow it in the harness permissions; otherwise tell the agent which actions are off-limits so it stops trying.",
    }),
  },
  {
    id: "timeout",
    join: "tool",
    test: /timed? ?out|timeout|ETIMEDOUT|deadline exceeded/i,
    hint: (tool) => ({
      title: `${tool} timed out`,
      why: "The call took longer than its time limit, so its work was lost.",
      fix: "Raise the tool's timeout, run long commands in the background, or have the agent narrow the work (smaller queries, fewer files).",
    }),
  },
  {
    id: "rate-limit",
    join: "model",
    test: /\b429\b|rate.?limit|overloaded|\b529\b/i,
    hint: () => ({
      title: "The model provider rate-limited the agent",
      why: "Too many requests or tokens per minute for this account or model.",
      fix: "Add retries with backoff, spread work out, or raise the account's limits.",
    }),
  },
  {
    id: "missing-file",
    test: /no such file|ENOENT|does not exist|cannot find (the )?(path|file)/i,
    hint: (tool) => ({
      title: `${tool} looked for a file that isn't there`,
      why: "The agent guessed a path. Wrong paths usually mean it doesn't know the project layout.",
      fix: "Describe the project layout in the agent's instructions, or have it search (glob/grep) before opening files.",
    }),
  },
  {
    id: "stopped",
    join: "never",
    test: /interrupted by the user|user (rejected|declined|denied)|doesn't want to proceed/i,
    hint: (tool) => ({
      title: `You stopped ${tool}`,
      why: "A person rejected or interrupted this action, which usually means the agent was heading the wrong way.",
      fix: "Look at the decision just before it: what did the agent misunderstand? Add that guidance to its instructions.",
    }),
  },
  {
    id: "exit-code",
    test: /exit code [1-9]|exited with|non-zero|failed with code/i,
    hint: (tool) => ({
      title: `${tool} commands are failing`,
      why: "Commands the agent ran exited with an error. Sometimes that's expected (failing tests); repeated failures mean it is guessing.",
      fix: "Open an example run and check whether the agent read the error and changed approach, or retried the same thing.",
    }),
  },
];

const ruleFor = (error: string | null) => RULES.find((rule) => rule.test.test(error ?? ""));

export function hintFor(tool: string | null, kind: string, error: string | null): Hint {
  const name = prettyTool(tool) ?? (kind === "llm" || kind === "error" ? "The model API" : "A step");
  const rule = ruleFor(error);
  if (rule) return rule.hint(name);
  return {
    title: `${name} failed`,
    why: "This step reported an error.",
    fix: "Open an example run to see what the agent did before and after the failure.",
  };
}

/**
 * What failures with one cause share, whatever their words (see Join): the
 * agent's quota, its model calls being refused or unreachable, one tool timing
 * out. Null when the words matter.
 */
export function causeKey(failure: { toolName: string | null; harness: string; sample: string | null }) {
  const rule = ruleFor(failure.sample);
  if (!rule?.join || rule.join === "never") return null;
  if (rule.join === "agent" || !failure.toolName) return `agent\u0000${failure.harness}\u0000${rule.id}`;
  return rule.join === "tool" ? `tool\u0000${failure.toolName}\u0000${rule.id}` : null;
}

/** Whether the same words failing in another tool are the same cause: specific words, not "Exit code 1". */
export function sharesWords(failure: { signature: string; sample: string | null }) {
  return ruleFor(failure.sample)?.join !== "never" && failure.signature.length >= 24 && /[a-z]{3,}\W+[a-z]{3,}\W+[a-z]{3,}/i.test(failure.signature);
}

/** "mcp__Claude_Browser__computer" → "computer (Claude_Browser)": MCP names are long and repetitive. */
export function prettyTool(tool: string | null) {
  const match = tool ? /^mcp__(.+?)__(.+)$/.exec(tool) : null;
  return match ? `${match[2]} (${match[1]})` : tool;
}

/** Collapses numbers, times, paths and ids so the same failure groups together. */
export function errorSignature(error: string | null) {
  return (error ?? "")
    .split(/\r?\n/)[0]!
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "<time>")
    .replace(/\((?:[A-Z][a-z]+\/[A-Za-z_]+|UTC[^)]*)\)/g, "")
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>)\]]+/gi, "<url>")
    .replace(/[A-Za-z]:\\[^\s'"]+|\/[\w.-]+(\/[\w.-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 140);
}
