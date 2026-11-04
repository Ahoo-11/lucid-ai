// The universal way in: point any agent's model base URL at Lucid.
//
//   https://<lucid>/p/<lucid key>/<provider>/...   key in the URL (works where
//                                                 only a base URL can be set)
//   https://<lucid>/proxy/<provider>/...          key in an x-lucid-key header
//
// Requests are forwarded untouched to the provider with the agent's own
// provider key; the reply streams straight back. A copy of the exchange is
// recorded after the reply is done, so capture never slows the agent down.
// Only chat/completions (OpenAI-style) and messages (Anthropic-style) calls
// are captured; every other endpoint is passed through as is.

import { type ProxyApi, assembleStream, withoutBlobs } from "@lucid/normalize";
import { type Context, Hono } from "hono";
import type { AppContext } from "./context";
import { type Ingest, describeError, projectForKey } from "./ingestService";
import { batchFor } from "./normalizers";

/** Provider → upstream root. Base URL to give an agent: /proxy/<provider> + the provider's usual path. */
export const DEFAULT_UPSTREAMS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api",
  groq: "https://api.groq.com/openai",
  together: "https://api.together.xyz",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai",
  xai: "https://api.x.ai",
  fireworks: "https://api.fireworks.ai/inference",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Meta's Model API: Muse Spark (muse-spark-1.3, muse-spark-1.1).
  meta: "https://api.meta.ai",
  // Muse Spark (meta-models/muse-spark-open-1026) and other open models, on Baseten.
  baseten: "https://inference.baseten.co",
};

/** Self-hosters add their own (vLLM, Ollama, a company gateway) via LUCID_PROXY_UPSTREAMS='{"name":"http://…"}'. */
export function upstreams(): Record<string, string> {
  try {
    return { ...DEFAULT_UPSTREAMS, ...(JSON.parse(process.env.LUCID_PROXY_UPSTREAMS ?? "{}") as Record<string, string>) };
  } catch {
    return DEFAULT_UPSTREAMS;
  }
}

// Providers known to accept stream_options; used to ask for token usage on streams.
const STREAM_USAGE_PROVIDERS = new Set(["openai", "openrouter", "groq", "deepseek", "together", "xai"]);
// Hop-by-hop headers stay here. Node's fetch also refuses `expect`, which
// PowerShell and .NET send on every POST, so forwarding it fails the call.
const DROP_REQUEST_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding", "expect", "upgrade", "te", "trailer",
  "proxy-connection", "proxy-authorization", "accept-encoding", "cookie", "x-lucid-key",
]);
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
const MAX_BODY = 32 * 1024 * 1024;

function apiFor(path: string): ProxyApi | null {
  if (/\/chat\/completions\/?$/.test(path)) return "openai-chat";
  if (/\/messages\/?$/.test(path)) return "anthropic-messages";
  return null;
}

/** An error the agent's SDK can read: both OpenAI and Anthropic clients look at error.message. */
const proxyError = (c: Context, status: 401 | 404 | 413 | 502, message: string) =>
  c.json({ type: "error", error: { type: "lucid_proxy_error", message } }, status);

export function proxyRoutes(ctx: AppContext, ingest: Ingest) {
  const app = new Hono();

  const record = async (projectId: string, exchange: Record<string, unknown>) => {
    try {
      const { rawId, payload } = await ingest.store(projectId, "proxy", "proxy", exchange);
      await ingest.commit(projectId, rawId, () => batchFor("proxy", "proxy", payload)!, "proxy");
    } catch (error) {
      ctx.log.error(`[proxy] could not record an exchange: ${describeError(error)}`);
    }
  };

  const forward = async (c: Context, key: string | undefined, provider: string, rest: string) => {
    const projectId = await projectForKey(ctx, key);
    if (!projectId) return proxyError(c, 401, "Lucid: missing or invalid Lucid key in the proxy URL (…/p/<key>/…) or x-lucid-key header.");
    const root = upstreams()[provider];
    if (!root) return proxyError(c, 404, `Lucid: unknown provider "${provider}". Known: ${Object.keys(upstreams()).join(", ")}.`);

    const url = new URL(c.req.url);
    const target = `${root.replace(/\/+$/, "")}/${rest}${url.search}`;
    const headers = new Headers();
    c.req.raw.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (!DROP_REQUEST_HEADERS.has(lower) && !lower.startsWith("x-lucid-")) headers.set(name, value);
    });

    const method = c.req.method;
    let body: ArrayBuffer | undefined = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
    if (body && body.byteLength > MAX_BODY) return proxyError(c, 413, "Lucid: request body too large");

    const api = apiFor(`/${rest}`);
    let requestJson: Record<string, unknown> | undefined;
    if (api && body?.byteLength) {
      try {
        requestJson = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
      } catch {
        requestJson = undefined;
      }
      // Ask for token usage on OpenAI-style streams (the last chunk then carries it).
      if (requestJson && api === "openai-chat" && requestJson.stream === true && !requestJson.stream_options && STREAM_USAGE_PROVIDERS.has(provider)) {
        requestJson = { ...requestJson, stream_options: { include_usage: true } };
        const bytes = Buffer.from(JSON.stringify(requestJson));
        body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
    }

    const startedAt = new Date().toISOString();
    const meta = {
      provider,
      api,
      startedAt,
      session: c.req.header("x-lucid-session"),
      run: c.req.header("x-lucid-run"),
      agent: c.req.header("x-lucid-agent"),
      user: c.req.header("x-lucid-user"),
    };

    let upstream: Response;
    try {
      upstream = await fetch(target, { method, headers, body, redirect: "manual", signal: c.req.raw.signal });
    } catch (error) {
      const message = `Lucid could not reach ${provider}: ${(error as Error).message}`;
      if (api && requestJson) void record(projectId, { ...meta, request: withoutBlobs(requestJson), response: null, status: 502, endedAt: new Date().toISOString(), error: message });
      return proxyError(c, 502, message);
    }

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    });
    const capture = !!api && !!requestJson;
    const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");

    if (streaming && upstream.body) {
      if (!capture) return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
      const [toClient, toCapture] = upstream.body.tee();
      void (async () => {
        const text = await new Response(toCapture).text();
        await record(projectId, { ...meta, request: withoutBlobs(requestJson), response: withoutBlobs(assembleStream(api!, text)), status: upstream.status, endedAt: new Date().toISOString() });
      })().catch((error) => ctx.log.error(`[proxy] stream capture failed: ${describeError(error)}`));
      return new Response(toClient, { status: upstream.status, headers: responseHeaders });
    }

    const buffer = await upstream.arrayBuffer();
    if (capture) {
      let responseJson: unknown = null;
      try {
        responseJson = JSON.parse(Buffer.from(buffer).toString("utf8"));
      } catch {
        responseJson = { error: { message: Buffer.from(buffer).toString("utf8").slice(0, 500) } };
      }
      void record(projectId, { ...meta, request: withoutBlobs(requestJson), response: withoutBlobs(responseJson), status: upstream.status, endedAt: new Date().toISOString() });
    }
    return new Response(buffer, { status: upstream.status, headers: responseHeaders });
  };

  const restAfter = (path: string, marker: string) => path.slice(path.indexOf(marker) + marker.length);

  app.all("/proxy/:provider/*", (c) => {
    const provider = c.req.param("provider");
    return forward(c, c.req.header("x-lucid-key"), provider, restAfter(c.req.path, `/proxy/${provider}/`));
  });

  app.all("/p/:key/:provider/*", (c) => {
    const { key, provider } = c.req.param();
    return forward(c, key, provider, restAfter(c.req.path, `/p/${key}/${provider}/`));
  });

  return app;
}
