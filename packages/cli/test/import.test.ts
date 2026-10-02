import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IngestRequestSchema, processIngest } from "@moli-insight/protocol";
import { importUsageLog, type ImportOptions } from "../src/index.ts";

const sample = readFileSync(
  fileURLToPath(new URL("../../protocol/test/fixtures/moliswitch-usage.jsonl", import.meta.url).href),
  "utf8",
);

// Four seconds after the last line of the sample.
const NOW = Date.parse("2026-10-02T06:04:00.000Z");

/** A server that remembers event ids, so a second import can be told from a first. */
function fakeServer(script: (Response | Error)[] = []) {
  const seen = new Set<string>();
  const requests: { auth: string; body: any }[] = [];
  const fetchFn = (async (_url: URL, init: RequestInit) => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const body = JSON.parse(init.body as string);
    requests.push({ auth: (init.headers as Record<string, string>).authorization!, body });
    const processed = processIngest(body, NOW);
    if (!processed.ok) return new Response(JSON.stringify({ error: processed.error }), { status: 400 });
    let accepted = 0;
    let duplicates = 0;
    for (const { event } of processed.events) {
      if (seen.has(event.id)) duplicates += 1;
      else (seen.add(event.id), (accepted += 1));
    }
    return Response.json({ accepted, duplicates, rejected: processed.rejected });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, requests, seen };
}

const base = (extra: Partial<ImportOptions> = {}): ImportOptions => ({
  url: "https://insight.test",
  key: "mi_testkey",
  platform: "macos",
  deviceId: "dev_testdevice001",
  now: () => NOW,
  sleep: async () => {},
  ...extra,
});

describe("importUsageLog", () => {
  it("sends valid batches with the key and the context from appStart", async () => {
    const server = fakeServer();
    const summary = await importUsageLog(sample, base({ fetch: server.fetch }));
    expect(summary).toMatchObject({ lines: 9, unreadable: 0, accepted: 9, duplicates: 0, rejected: 0, batches: 1 });

    const [request] = server.requests;
    expect(request!.auth).toBe("Bearer mi_testkey");
    expect(IngestRequestSchema.safeParse(request!.body).success).toBe(true);
    expect(request!.body.context).toMatchObject({
      platform: "macos",
      release: "0.2.57",
      deviceClass: "desktop",
      locale: "zh_CN",
      timeZone: "Asia/Shanghai",
    });
    const sessions = new Set(request!.body.events.map((e: any) => e.sessionId));
    expect(sessions.size).toBe(1);
  });

  it("adds nothing when the same file is imported again", async () => {
    const server = fakeServer();
    await importUsageLog(sample, base({ fetch: server.fetch }));
    const again = await importUsageLog(sample, base({ fetch: server.fetch }));
    expect(again).toMatchObject({ accepted: 0, duplicates: 9 });
    expect(server.seen.size).toBe(9);
  });

  it("filters by event name", async () => {
    const server = fakeServer();
    const only = await importUsageLog(sample, base({ fetch: server.fetch, include: new Set(["switch", "manualSwitch"]) }));
    expect(only).toMatchObject({ accepted: 3, filtered: 6 });
    const without = await importUsageLog(sample, base({ fetch: fakeServer().fetch, exclude: new Set(["snapshot", "systemInputSourceChanged"]) }));
    expect(without.accepted).toBe(7);
  });

  it("skips events older than the server accepts", async () => {
    const server = fakeServer();
    const later = NOW + 8 * 24 * 60 * 60 * 1000;
    const summary = await importUsageLog(sample, base({ fetch: server.fetch, now: () => later }));
    expect(summary).toMatchObject({ tooOld: 9, accepted: 0, batches: 0 });
    expect(server.requests).toHaveLength(0);
  });

  it("counts unreadable lines and ignores blank ones", async () => {
    const server = fakeServer();
    const text = `not json\n\n{"e":"x"}\n${sample}`;
    const summary = await importUsageLog(text, base({ fetch: server.fetch }));
    expect(summary).toMatchObject({ unreadable: 2, accepted: 9 });
  });

  it("splits at 100 events and at every appStart", async () => {
    const lines = Array.from({ length: 250 }, (_, i) =>
      JSON.stringify({ t: "2026-10-02T14:03:10.215+08:00", mono: i, e: "switch", n: i }),
    ).join("\n");
    const server = fakeServer();
    const summary = await importUsageLog(lines, base({ fetch: server.fetch }));
    expect(summary).toMatchObject({ accepted: 250, batches: 3 });

    const restart = JSON.stringify({ t: "2026-10-02T14:03:30.000+08:00", mono: 1, e: "appStart", version: "0.3.0" });
    const two = await importUsageLog(`${sample}${restart}\n`, base({ fetch: fakeServer().fetch }));
    expect(two.batches).toBe(2);
  });

  it("does not send anything on a dry run", async () => {
    const server = fakeServer();
    const summary = await importUsageLog(sample, base({ fetch: server.fetch, dryRun: true }));
    expect(summary.accepted).toBe(9);
    expect(server.requests).toHaveLength(0);
  });

  it("waits and retries on 429 and 5xx, honouring Retry-After", async () => {
    const waits: number[] = [];
    const server = fakeServer([
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      new Response("oops", { status: 503 }),
      new Error("connection reset"),
    ]);
    const summary = await importUsageLog(sample, base({ fetch: server.fetch, sleep: async (ms) => void waits.push(ms) }));
    expect(summary.accepted).toBe(9);
    expect(waits).toEqual([7000, 1000, 2000]);
  });

  it("fails at once on 401 and gives up after repeated 5xx", async () => {
    await expect(
      importUsageLog(sample, base({ fetch: fakeServer([new Response("no", { status: 401 })]).fetch })),
    ).rejects.toThrow(/401/);
    const flaky = fakeServer(Array.from({ length: 5 }, () => new Response("down", { status: 502 })));
    await expect(importUsageLog(sample, base({ fetch: flaky.fetch }))).rejects.toThrow(/502/);
  });
});
