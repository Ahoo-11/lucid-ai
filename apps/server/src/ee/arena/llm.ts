// Calls any OpenAI-compatible chat API (OpenRouter by default, so one key
// reaches every model). Replays send the captured messages and tool schemas
// but never execute a tool: we compare the next decision, not its effects.

export type ToolCall = { id?: string; name: string; input?: unknown };

export type ChatMessage = {
  role: string;
  content: unknown;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  /** For reasoning models: how much hidden thinking to spend (OpenRouter's unified setting). */
  reasoningEffort?: "low" | "medium" | "high";
};

export type ChatResult = {
  text?: string;
  toolCalls?: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  /** Billed cost when the provider reports it (OpenRouter does). */
  costUsd?: number;
  latencyMs: number;
  finishReason?: string;
};

export type ChatClient = (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;

const parseArgs = (raw: unknown) => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export function openAICompatibleClient(options: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): ChatClient {
  const baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (request, signal) => {
    const started = Date.now();
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        "x-title": "Lucid Arena",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
        usage: { include: true },
      }),
      signal: signal ?? AbortSignal.timeout(180_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; metadata?: { raw?: unknown; provider_name?: string } };
      choices?: { message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    if (!response.ok || body.error) {
      // OpenRouter wraps provider failures as "Provider returned error"; the
      // provider's own message (what actually went wrong) is in metadata.raw.
      const raw = body.error?.metadata?.raw;
      const detail = raw === undefined ? "" : ` (${body.error?.metadata?.provider_name ?? "provider"}: ${typeof raw === "string" ? raw : JSON.stringify(raw)})`;
      throw new Error(`${response.status}: ${body.error?.message ?? response.statusText}${detail}`.slice(0, 1000));
    }
    const choice = body.choices?.[0];
    const message = choice?.message;
    const text = typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((p) => (p as { text?: string }).text ?? "").join("") : undefined;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call) => ({ id: call.id, name: call.function!.name!, input: parseArgs(call.function!.arguments) }));
    return {
      text: text?.trim() ? text : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : undefined,
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason,
    };
  };
}
