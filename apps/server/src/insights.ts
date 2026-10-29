// First, rule-based version of the Inbox: failed steps grouped by what failed
// and how, each with a plain-English explanation and a suggested fix. The
// LLM-written root causes come later and use the same shape.

export type Hint = { title: string; why: string; fix: string };

type Rule = { test: RegExp; hint: (tool: string) => Hint };

const RULES: Rule[] = [
  {
    test: /session limit|usage limit|hit your (\w+ )?limit|quota exceeded|insufficient_quota|credit balance/i,
    hint: () => ({
      title: "The agent ran out of usage quota",
      why: "The plan's usage limit or the API quota ran out mid-run, so the run stopped where it was.",
      fix: "Use a smaller model for sub-agents and routine steps, spread heavy work across the limit window, or raise the plan. Arena can tell you which steps a cheaper model handles just as well.",
    }),
  },
  {
    test: /HTTP 401|HTTP 403|unauthori[sz]ed|invalid (api )?key|incorrect api key|user not found|authentication (failed|error)/i,
    hint: () => ({
      title: "The model provider rejected the API key",
      why: "The provider refused the agent's credentials, so no model call succeeded and the run stopped immediately.",
      fix: "Check the provider key the agent uses (for Hermes: `hermes auth` or the key in its .env). It may be revoked, expired, or for a different account.",
    }),
  },
  {
    test: /ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection error|can't reach the api|socket hang up|network/i,
    hint: () => ({
      title: "The agent lost its connection to the model API",
      why: "Requests to the model provider failed at the network level. The harness retries these, but each retry adds delay.",
      fix: "Usually transient. If it keeps happening, check DNS, VPN or proxy settings on this machine.",
    }),
  },
  {
    test: /command not found|is not recognized as (an internal|the name of a cmdlet)|not found in path/i,
    hint: (tool) => ({
      title: `${tool} ran a command that isn't installed`,
      why: "The agent assumed a program exists on this machine. Every retry burns a model call.",
      fix: "List the available tools and shell in the agent's instructions (for Claude Code, CLAUDE.md), or install the missing program.",
    }),
  },
  {
    test: /has not been read yet|read it first|must read/i,
    hint: (tool) => ({
      title: `${tool} edited a file it hadn't read`,
      why: "The harness refuses edits to files the agent hasn't opened in this session.",
      fix: "Tell the agent to read a file before editing it; this usually goes away once that is in its instructions.",
    }),
  },
  {
    test: /string to replace not found|old_string|no match(es)? found|did not match/i,
    hint: (tool) => ({
      title: `${tool} couldn't find the text it wanted to replace`,
      why: "The agent edited from memory and the file content differed (it changed, or whitespace didn't match).",
      fix: "Ask the agent to re-read the file right before editing and to copy the exact text it replaces.",
    }),
  },
  {
    test: /permission|denied|not allowed|blocked by|EACCES|EPERM/i,
    hint: (tool) => ({
      title: `${tool} was blocked by permissions`,
      why: "A permission rule, the sandbox or the OS refused the action.",
      fix: "If the action is expected, allow it in the harness permissions; otherwise tell the agent which actions are off-limits so it stops trying.",
    }),
  },
  {
    test: /timed? ?out|timeout|ETIMEDOUT|deadline exceeded/i,
    hint: (tool) => ({
      title: `${tool} timed out`,
      why: "The call took longer than its time limit, so its work was lost.",
      fix: "Raise the tool's timeout, run long commands in the background, or have the agent narrow the work (smaller queries, fewer files).",
    }),
  },
  {
    test: /\b429\b|rate.?limit|overloaded|\b529\b/i,
    hint: () => ({
      title: "The model provider rate-limited the agent",
      why: "Too many requests or tokens per minute for this account or model.",
      fix: "Add retries with backoff, spread work out, or raise the account's limits.",
    }),
  },
  {
    test: /no such file|ENOENT|does not exist|cannot find (the )?(path|file)/i,
    hint: (tool) => ({
      title: `${tool} looked for a file that isn't there`,
      why: "The agent guessed a path. Wrong paths usually mean it doesn't know the project layout.",
      fix: "Describe the project layout in the agent's instructions, or have it search (glob/grep) before opening files.",
    }),
  },
  {
    test: /interrupted by the user|user (rejected|declined|denied)/i,
    hint: (tool) => ({
      title: `You stopped ${tool}`,
      why: "A person rejected or interrupted this action, which usually means the agent was heading the wrong way.",
      fix: "Look at the decision just before it: what did the agent misunderstand? Add that guidance to its instructions.",
    }),
  },
  {
    test: /exit code [1-9]|exited with|non-zero|failed with code/i,
    hint: (tool) => ({
      title: `${tool} commands are failing`,
      why: "Commands the agent ran exited with an error. Sometimes that's expected (failing tests); repeated failures mean it is guessing.",
      fix: "Open an example run and check whether the agent read the error and changed approach, or retried the same thing.",
    }),
  },
];

export function hintFor(tool: string | null, kind: string, error: string | null): Hint {
  const name = prettyTool(tool) ?? (kind === "llm" || kind === "error" ? "The model API" : "A step");
  const text = error ?? "";
  for (const rule of RULES) if (rule.test.test(text)) return rule.hint(name);
  return {
    title: `${name} failed`,
    why: "This step reported an error.",
    fix: "Open an example run to see what the agent did before and after the failure.",
  };
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
    .replace(/[A-Za-z]:\\[^\s'"]+|\/[\w.-]+(\/[\w.-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 140);
}
