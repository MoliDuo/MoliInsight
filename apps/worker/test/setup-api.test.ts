import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planUsageImport } from "@moli-insight/protocol";
import { createHarness, type Harness } from "./harness.ts";

const sample = readFileSync(
  fileURLToPath(new URL("../../../packages/protocol/test/fixtures/moliswitch-usage.jsonl", import.meta.url).href),
  "utf8",
);
// Four seconds after the last line of the sample.
const NOW = Date.parse("2026-10-02T06:04:00.000Z");

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = NOW;
  cookie = await h.login();
  await h.newApp("switch", cookie);
});
afterAll(() => h.close());

const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
  h.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const catalog = {
  schemaVersion: 1,
  events: [{ name: "switch", description: "An input source was switched." }],
  metrics: [{ name: "all", description: "Everything.", kind: "ratio", numerator: { event: "switch" }, denominator: { event: "switch" } }],
};

describe("PUT /api/apps/:slug/catalog", () => {
  it("checks a catalog without saving it when dryRun is set", async () => {
    const response = await call("/api/apps/switch/catalog?dryRun=1", "PUT", catalog);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, dryRun: true, events: 1, metrics: 1, funnels: 0 });
    expect(((await (await call("/api/apps/switch/catalog", "GET")).json()) as { catalog: unknown }).catalog).toBeNull();
  });

  it("replaces the catalog, and the dashboard reads it back", async () => {
    const response = await call("/api/apps/switch/catalog", "PUT", catalog);
    expect(await response.json()).toEqual({ ok: true, dryRun: false, events: 1, metrics: 1, funnels: 0 });
    const read = (await (await call("/api/apps/switch/catalog", "GET")).json()) as { catalog: { events: { name: string }[] } };
    expect(read.catalog.events.map((e) => e.name)).toEqual(["switch"]);
  });

  it("lists what is wrong with a bad catalog and keeps the old one", async () => {
    const response = await call("/api/apps/switch/catalog", "PUT", { schemaVersion: 1, events: [{ name: "Bad Name" }] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_catalog");
    expect(body.issues.length).toBeGreaterThan(0);
    expect((await call("/api/apps/switch/catalog", "PUT", "not json")).status).toBe(400);
    const read = (await (await call("/api/apps/switch/catalog", "GET")).json()) as { catalog: { events: unknown[] } };
    expect(read.catalog.events).toHaveLength(1);
  });

  it("needs a session, the same origin, and an app that exists", async () => {
    expect((await call("/api/apps/switch/catalog", "PUT", catalog, {})).status).toBe(401);
    expect((await call("/api/apps/switch/catalog", "PUT", catalog, { cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("/api/apps/nope/catalog", "PUT", catalog)).status).toBe(404);
  });
});

describe("POST /api/apps/:slug/import", () => {
  const options = { platform: "macos", deviceId: "dev_importtest01" } as const;

  it("stores a planned import, and a second import adds nothing", async () => {
    const plan = await planUsageImport(sample, options, NOW);
    expect(plan.events).toBeGreaterThan(0);
    const send = async () => {
      const total = { accepted: 0, duplicates: 0 };
      for (const batch of plan.batches) {
        const response = await call("/api/apps/switch/import", "POST", batch);
        expect(response.status).toBe(200);
        const r = (await response.json()) as { accepted: number; duplicates: number; rejected: unknown[] };
        expect(r.rejected).toEqual([]);
        total.accepted += r.accepted;
        total.duplicates += r.duplicates;
      }
      return total;
    };
    expect(await send()).toEqual({ accepted: plan.events, duplicates: 0 });
    expect(await send()).toEqual({ accepted: 0, duplicates: plan.events });

    const names = (await (await call("/api/apps/switch/events/names?days=30", "GET")).json()) as { names: { name: string; events: number }[] };
    expect(names.names.find((n) => n.name === "$session_start")?.events).toBe(1);
  });

  it("does not use the device limiter, which is for keys that can leak", async () => {
    const before = h.deviceLimiter.calls.length;
    const plan = await planUsageImport(sample, { ...options, deviceId: "dev_importtest02" }, NOW);
    await call("/api/apps/switch/import", "POST", plan.batches[0]);
    expect(h.deviceLimiter.calls.length).toBe(before);
  });

  it("refuses what is not an ingest request", async () => {
    expect((await call("/api/apps/switch/import", "POST", "nope")).status).toBe(400);
    expect((await call("/api/apps/switch/import", "POST", { schemaVersion: 1 })).status).toBe(400);
  });

  it("needs a session, the same origin, and an app that exists", async () => {
    const plan = await planUsageImport(sample, options, NOW);
    expect((await call("/api/apps/switch/import", "POST", plan.batches[0], {})).status).toBe(401);
    expect((await call("/api/apps/switch/import", "POST", plan.batches[0], { cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("/api/apps/nope/import", "POST", plan.batches[0])).status).toBe(404);
  });
});

describe("app slugs", () => {
  it("keeps the names of dashboard pages for the dashboard", async () => {
    for (const slug of ["new", "settings"]) {
      expect((await call("/api/apps", "POST", { slug, name: slug })).status).toBe(400);
    }
  });
});
