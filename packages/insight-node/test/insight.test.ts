import { describe, expect, it, vi } from "vitest";
import { processIngest } from "@moli-insight/protocol";
import { createInsight, type InsightOptions } from "../src/index.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeUpstream(script: (Response | Error)[] = []) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array) });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? Response.json({ accepted: 1, duplicates: 0, rejected: [] });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

const configured = (extra: Partial<InsightOptions> = {}) => ({
  url: "https://insight.test/",
  key: "mi_secretkey",
  release: "rel1",
  ...extra,
});

const browserBatch = JSON.stringify({
  schemaVersion: 1,
  sentAt: "2026-10-02T08:00:00.000Z",
  context: { platform: "web", release: "abc" },
  events: [],
});

const post = (body: BodyInit | null = browserBatch, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

const allow = { authorize: async () => true };

describe("when it is not configured", () => {
  it("is disabled without a url or a key, answers 204 and sends nothing", async () => {
    const up = fakeUpstream();
    for (const options of [{}, { url: "https://x.test" }, { key: "mi_k" }]) {
      const insight = createInsight({ ...options, fetch: up.fetch });
      expect(insight.enabled).toBe(false);
      expect((await insight.relayHandler({ authorize: async () => false })(post())).status).toBe(204);
      await insight.send([{ name: "a.b" }]);
    }
    expect(up.calls).toHaveLength(0);
  });
});

describe("relayHandler", () => {
  it("forwards the body untouched with the key, and answers 204", async () => {
    const up = fakeUpstream();
    const handler = createInsight(configured({ fetch: up.fetch })).relayHandler(allow);
    const response = await handler(post());
    expect(response.status).toBe(204);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]).toMatchObject({
      url: "https://insight.test/v1/ingest",
      body: browserBatch,
      headers: { authorization: "Bearer mi_secretkey", "content-type": "application/json" },
    });
  });

  it("passes gzip on", async () => {
    const up = fakeUpstream();
    const handler = createInsight(configured({ fetch: up.fetch })).relayHandler(allow);
    await handler(post(browserBatch, { "content-encoding": "gzip" }));
    expect(up.calls[0]!.headers["content-encoding"]).toBe("gzip");
  });

  it("answers 401 when authorize says no, without calling MoliInsight", async () => {
    const up = fakeUpstream();
    const handler = createInsight(configured({ fetch: up.fetch })).relayHandler({ authorize: async () => false });
    expect((await handler(post())).status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("answers 503 when authorize throws", async () => {
    const handler = createInsight(configured({ fetch: fakeUpstream().fetch })).relayHandler({
      authorize: () => {
        throw new Error("db down");
      },
    });
    expect((await handler(post())).status).toBe(503);
  });

  it("answers 413 for bodies over the limit, by header and by streaming, without forwarding", async () => {
    const up = fakeUpstream();
    const handler = createInsight(configured({ fetch: up.fetch })).relayHandler({ ...allow, maxBodyBytes: 100 });
    expect((await handler(post("x".repeat(200)))).status).toBe(413);

    const streamed = new Request("https://app.test/api/telemetry", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(80)));
          controller.enqueue(new TextEncoder().encode("x".repeat(80)));
          controller.close();
        },
      }),
      // @ts-expect-error duplex is required for streaming bodies in Node
      duplex: "half",
    });
    expect((await handler(streamed)).status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });

  it("defaults the limit to 64 KB", async () => {
    const handler = createInsight(configured({ fetch: fakeUpstream().fetch })).relayHandler(allow);
    expect((await handler(post("x".repeat(65_537)))).status).toBe(413);
    expect((await handler(post("x".repeat(65_536)))).status).toBe(204);
  });

  it("passes 429 and its Retry-After to the browser", async () => {
    const up = fakeUpstream([new Response(null, { status: 429, headers: { "retry-after": "42" } })]);
    const response = await createInsight(configured({ fetch: up.fetch })).relayHandler(allow)(post());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
  });

  it("answers 503 when MoliInsight fails, is unreachable, or refuses this app's key", async () => {
    const statuses: (number | undefined)[] = [];
    const up = fakeUpstream([new Response(null, { status: 500 }), new Error("ECONNREFUSED"), new Response(null, { status: 401 })]);
    const handler = createInsight(configured({ fetch: up.fetch, onError: ({ status }) => statuses.push(status) })).relayHandler(allow);
    expect((await handler(post())).status).toBe(503);
    expect((await handler(post())).status).toBe(503);
    expect((await handler(post())).status).toBe(503);
    expect(statuses).toEqual([500, undefined, 401]);
  });

  it("tells the browser to drop a batch MoliInsight refuses for good", async () => {
    const up = fakeUpstream([new Response(null, { status: 400 }), new Response(null, { status: 413 })]);
    const handler = createInsight(configured({ fetch: up.fetch })).relayHandler(allow);
    expect((await handler(post())).status).toBe(400);
    expect((await handler(post())).status).toBe(413);
  });

  it("reports only the status, never the request or the key", async () => {
    const seen: unknown[] = [];
    const up = fakeUpstream([new Response("secret body from upstream", { status: 500 })]);
    const handler = createInsight(configured({ fetch: up.fetch, onError: (info) => seen.push(info) })).relayHandler(allow);
    await handler(post());
    expect(seen).toEqual([{ status: 500 }]);
    expect(JSON.stringify(seen)).not.toContain("mi_secretkey");
  });

  it("times out", async () => {
    vi.useFakeTimers();
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const pending = createInsight(configured({ fetch: slow, timeoutMs: 500 })).relayHandler(allow)(post());
    await vi.advanceTimersByTimeAsync(600);
    expect((await pending).status).toBe(503);
    vi.useRealTimers();
  });

  it("only takes POST", async () => {
    const handler = createInsight(configured({ fetch: fakeUpstream().fetch })).relayHandler(allow);
    expect((await handler(new Request("https://app.test/api/telemetry"))).status).toBe(405);
  });

  it("does not let a throwing onError break the response", async () => {
    const up = fakeUpstream([new Response(null, { status: 500 })]);
    const handler = createInsight(configured({ fetch: up.fetch, onError: () => { throw new Error("app bug"); } })).relayHandler(allow);
    expect((await handler(post())).status).toBe(503);
  });
});

describe("send", () => {
  it("posts server events the platform accepts, with ids, time and correlation", async () => {
    const up = fakeUpstream();
    const insight = createInsight(configured({ fetch: up.fetch }));
    const at = new Date("2026-10-02T08:00:01.000Z");
    await insight.send([
      { name: "processing.finished", props: { ms: 1200, ok: true }, correlationId: "rec_42", occurredAt: at },
      { name: "processing.failed" },
    ]);
    expect(up.calls).toHaveLength(1);
    const body = JSON.parse(up.calls[0]!.body);
    expect(body.context).toEqual({ platform: "server", release: "rel1" });
    expect(body.events[0]).toMatchObject({ name: "processing.finished", correlationId: "rec_42", occurredAt: at.toISOString(), props: { ms: 1200, ok: true } });
    expect(body.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.events[0].id).not.toBe(body.events[1].id);

    const result = processIngest(body, Date.now());
    expect(result.ok && result.rejected).toEqual([]);
  });

  it("splits more than 100 events", async () => {
    const up = fakeUpstream();
    await createInsight(configured({ fetch: up.fetch })).send(Array.from({ length: 230 }, () => ({ name: "a.b" })));
    expect(up.calls.map((c) => JSON.parse(c.body).events.length)).toEqual([100, 100, 30]);
  });

  it("never throws: failures go to onError", async () => {
    const statuses: unknown[] = [];
    const up = fakeUpstream([new Response(null, { status: 500 }), new Error("offline")]);
    const insight = createInsight(configured({ fetch: up.fetch, onError: (i) => statuses.push(i) }));
    await expect(insight.send([{ name: "a.b" }])).resolves.toBeUndefined();
    await expect(insight.send([{ name: "a.b" }])).resolves.toBeUndefined();
    expect(statuses).toEqual([{ status: 500 }, {}]);
  });

  it("reads the release from VERCEL_GIT_COMMIT_SHA by default", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "deadbeef");
    const up = fakeUpstream();
    await createInsight({ url: "https://x.test", key: "mi_k", fetch: up.fetch }).send([{ name: "a.b" }]);
    expect(JSON.parse(up.calls[0]!.body).context.release).toBe("deadbeef");
    vi.unstubAllEnvs();
  });
});
