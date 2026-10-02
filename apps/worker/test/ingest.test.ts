import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const valid = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../packages/protocol/test/fixtures/request-valid.json", import.meta.url).href),
    "utf8",
  ),
);

let h: Harness;
let key: string;

beforeAll(async () => {
  h = await createHarness();
  key = await h.newApp("cashier", await h.login());
});
afterAll(() => h.close());
beforeEach(() => {
  h.ingestLimiter.deny = false;
  h.deviceLimiter.deny = false;
});

const post = (body: unknown, headers: Record<string, string> = {}, k: string | null = key) =>
  h.request("/v1/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}), ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });

const count = async (sql: string, ...binds: unknown[]) =>
  (await h.env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

const batch = (n: number, prefix: string) => ({
  ...valid,
  events: Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${prefix}${String(i).padStart(12 - prefix.length, "0")}`,
    name: "record.open",
    occurredAt: "2026-10-02T07:59:00.000Z",
    sessionId: "ses_bulkbulk01",
  })),
});

describe("POST /v1/ingest", () => {
  it("accepts a good batch and stores device, session and events", async () => {
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

    expect(await count("SELECT count(*) AS n FROM events")).toBe(2);
    const device = await h.env.DB.prepare("SELECT * FROM devices").first<Record<string, unknown>>();
    expect(device).toMatchObject({ device_id: "dev_01J9ZK3Q8X4V", platform: "web", last_release: "dae13efc" });
    const session = await h.env.DB.prepare("SELECT * FROM sessions").first<Record<string, unknown>>();
    expect(session).toMatchObject({ session_id: "ses_01J9ZK3Q9A1B", event_count: 2 });
  });

  it("counts a replay as duplicates and adds nothing", async () => {
    const response = await post(valid);
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(await count("SELECT count(*) AS n FROM events")).toBe(2);
    expect(await count("SELECT event_count AS n FROM sessions")).toBe(2);
  });

  it("accepts the rest of a batch and reports the invalid events", async () => {
    const body = structuredClone(valid);
    body.events = [
      { id: "00000000-0000-4000-8000-0000000000a1", name: "ok.event", occurredAt: "2026-10-02T07:59:00.000Z" },
      { id: "not-a-uuid", name: "bad.id", occurredAt: "2026-10-02T07:59:00.000Z" },
      { id: "00000000-0000-4000-8000-0000000000a3", name: "$tap", occurredAt: "2026-10-02T07:59:00.000Z" },
    ];
    const response = await post(body);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { accepted: number; rejected: { index: number }[] };
    expect(json.accepted).toBe(1);
    expect(json.rejected.map((r) => r.index)).toEqual([1, 2]);
  });

  it("stores a batch larger than one INSERT statement", async () => {
    const response = await post(batch(100, "b"));
    expect(await response.json()).toEqual({ accepted: 100, duplicates: 0, rejected: [] });
    expect(await count("SELECT event_count AS n FROM sessions WHERE session_id = 'ses_bulkbulk01'")).toBe(100);
    const again = await post(batch(100, "b"));
    expect(await again.json()).toEqual({ accepted: 0, duplicates: 100, rejected: [] });
  });

  it("rejects a bad key, a revoked key and a missing key with 401", async () => {
    expect((await post(valid, {}, "mi_nope")).status).toBe(401);
    expect((await post(valid, {}, null)).status).toBe(401);
    const cookie = await h.login();
    const second = await h.newApp("revoked-app", cookie);
    expect((await post(valid, {}, second)).status).toBe(200);
    const keys = await h.request("/api/apps/revoked-app/keys", { headers: { cookie } });
    const [{ id }] = ((await keys.json()) as { keys: { id: number }[] }).keys as [{ id: number }];
    await h.request(`/api/keys/${id}/revoke`, { method: "POST", headers: { cookie } });
    expect((await post(valid, {}, second)).status).toBe(401);
  });

  it("keeps each app's events apart even with the same event id", async () => {
    const other = await h.newApp("other", await h.login());
    const response = await post(valid, {}, other);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
  });

  it("rejects malformed JSON and an unsupported schema version with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect(((await (await post({ ...valid, schemaVersion: 2 })).json()) as { error: string }).error).toBe(
      "unsupported_schema_version",
    );
  });

  it("accepts gzip and rejects other encodings and corrupt gzip", async () => {
    const body = batch(1, "c");
    const zipped = gzipSync(JSON.stringify(body));
    expect((await post(new Uint8Array(zipped), { "content-encoding": "gzip" })).status).toBe(200);
    expect((await post("{}", { "content-encoding": "br" })).status).toBe(415);
    expect((await post(new Uint8Array([1, 2, 3, 4]), { "content-encoding": "gzip" })).status).toBe(400);
  });

  it("rejects bodies over the limits with 413", async () => {
    expect((await post("x".repeat(65 * 1024))).status).toBe(413);
    const bomb = gzipSync("a".repeat(600 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect((await post(new Uint8Array(bomb), { "content-encoding": "gzip" })).status).toBe(413);
  });

  it("answers 429 with Retry-After when a limiter says no", async () => {
    h.ingestLimiter.deny = true;
    const byKey = await post(batch(1, "d"));
    expect(byKey.status).toBe(429);
    expect(byKey.headers.get("retry-after")).toBe("60");
    h.ingestLimiter.deny = false;
    h.deviceLimiter.deny = true;
    expect((await post(batch(1, "d"))).status).toBe(429);
    expect(await count("SELECT count(*) AS n FROM events WHERE id IS NOT NULL AND event_id LIKE '%d0%'")).toBe(0);
  });

  it("scrubs route queries and long digit runs on the way in", async () => {
    const body = batch(1, "e");
    body.events[0]!.name = "scrub.check";
    (body.events[0] as Record<string, unknown>).route = "/records?token=abc&page=2";
    (body.events[0] as Record<string, unknown>).props = { message: "order 123456 failed" };
    await post(body);
    const row = await h.env.DB.prepare("SELECT route, props FROM events WHERE name = 'scrub.check'").first<{
      route: string;
      props: string;
    }>();
    expect(row!.route).not.toContain("abc");
    expect(row!.props).not.toContain("123456");
  });

  it("refreshes last_used_at on the key at most every ten minutes", async () => {
    await h.settle();
    const read = () => h.env.DB.prepare("SELECT last_used_at AS t FROM app_keys WHERE label = 'test' ORDER BY id LIMIT 1").first<{ t: number }>();
    const first = (await read())!.t;
    h.clock.now += 60_000;
    await post(batch(1, "f"));
    await h.settle();
    expect((await read())!.t).toBe(first);
    h.clock.now += 11 * 60_000;
    await post(batch(1, "f"));
    await h.settle();
    expect((await read())!.t).toBeGreaterThan(first);
  });
});
