import type { Insight, InsightOptions, Props, RelayOptions, ServerEvent } from "./types.ts";

export * from "./types.ts";

const DEFAULT_MAX_BODY = 65_536;
const DEFAULT_TIMEOUT_MS = 3000;
const BATCH = 100;
const RETRY_AFTER_FALLBACK = "60";

const empty = (status: number, headers?: Record<string, string>) => new Response(null, { status, ...(headers ? { headers } : {}) });

const envOf = (name: string): string | undefined => {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value || undefined;
};

/**
 * Reads a request body up to `limit` bytes. Returns undefined when it is
 * larger, without reading the rest.
 */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function createInsight(options: InsightOptions = {}): Insight {
  const base = options.url?.replace(/\/+$/, "");
  const key = options.key;
  const enabled = Boolean(base && key);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const release = options.release ?? envOf("VERCEL_GIT_COMMIT_SHA") ?? "unknown";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const fail = (status?: number) => {
    try {
      options.onError?.(status === undefined ? {} : { status });
    } catch {
      /* the callback is the app's; its bugs stay out of ours */
    }
  };

  /** One POST to /v1/ingest. Resolves to the response, or undefined when MoliInsight cannot be reached. */
  const forward = async (body: BodyInit, headers: Record<string, string>): Promise<Response | undefined> => {
    try {
      return await doFetch(`${base}/v1/ingest`, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  };

  return {
    enabled,

    relayHandler({ authorize, maxBodyBytes = DEFAULT_MAX_BODY }: RelayOptions) {
      return async (request: Request): Promise<Response> => {
        if (!enabled) return empty(204);
        if (request.method !== "POST") return empty(405, { allow: "POST" });

        // Cheap checks first: nobody pays for reading the body of a request that is refused anyway.
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBodyBytes) return empty(413);

        let allowed: boolean;
        try {
          allowed = await authorize(request);
        } catch {
          return empty(503);
        }
        if (!allowed) return empty(401);

        const body = await readLimited(request, maxBodyBytes).catch(() => null);
        if (body === undefined) return empty(413);
        if (body === null) return empty(400);

        const headers: Record<string, string> = {
          "content-type": request.headers.get("content-type") ?? "application/json",
        };
        const encoding = request.headers.get("content-encoding");
        if (encoding) headers["content-encoding"] = encoding;

        const upstream = await forward(body as BodyInit, headers);
        if (!upstream) {
          fail();
          return empty(503);
        }
        if (upstream.ok) return empty(204);
        fail(upstream.status);
        if (upstream.status === 429) {
          return empty(429, { "retry-after": upstream.headers.get("retry-after") ?? RETRY_AFTER_FALLBACK });
        }
        // 401 here means this app's own key is wrong: nothing the browser can fix, and not its user's fault.
        // Other 4xx mean the batch itself is refused for good, which the browser must drop, not retry.
        if (upstream.status === 401 || upstream.status >= 500) return empty(503);
        return empty(upstream.status === 413 ? 413 : 400);
      };
    },

    async send(events: ServerEvent[]): Promise<void> {
      if (!enabled) return;
      try {
        for (let i = 0; i < events.length; i += BATCH) {
          const batch = events.slice(i, i + BATCH).map((e) => ({
            id: crypto.randomUUID(),
            name: e.name,
            occurredAt: (e.occurredAt ?? new Date()).toISOString(),
            ...(e.correlationId ? { correlationId: e.correlationId } : {}),
            ...(e.props ? { props: e.props as Props } : {}),
          }));
          const response = await forward(
            JSON.stringify({
              schemaVersion: 1,
              sentAt: new Date().toISOString(),
              context: { platform: "server", release },
              events: batch,
            }),
            { "content-type": "application/json" },
          );
          if (!response) fail();
          else if (!response.ok) fail(response.status);
        }
      } catch {
        fail();
      }
    },
  };
}
