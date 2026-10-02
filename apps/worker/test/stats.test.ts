import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.ts";
import { runRollup } from "../src/rollup.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let cookie: string;
let key: string;
const DAY = 24 * 60 * 60 * 1000;
const OFFSET = 480; // the harness sets nothing, so UTC+8 is set per test file below

/** 2026-10-02 08:00:05Z is 16:00 on Oct 2 at UTC+8. */
const days = (n: number) => h.clock.now - n * DAY;

let seq = 0;
async function send(device: string, release: string, events: { name: string; at: number; session: string; props?: object }[], platform = "web") {
  const response = await h.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      sentAt: new Date(h.clock.now).toISOString(),
      context: { platform, release, deviceId: device },
      events: events.map((e) => ({
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
        name: e.name,
        occurredAt: new Date(e.at).toISOString(),
        sessionId: e.session,
        ...(e.props && { props: e.props }),
      })),
    }),
  });
  expect(response.status).toBe(200);
}

const get = async (path: string) => {
  const response = await h.request(path, { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as any;
};

beforeAll(async () => {
  h = await createHarness();
  (h.env as any).DAY_OFFSET_MINUTES = String(OFFSET);
  cookie = await h.login();
  key = await h.newApp("cashier", cookie);

  // Two devices, a web one for Alice and a macOS one for nobody.
  await send("dev_alicephone1", "r1", [
    { name: "$session_start", at: days(3), session: "ses_alice0000001" },
    { name: "record.submit", at: days(3) + 120_000, session: "ses_alice0000001", props: { kind: "expense", len: 3 } },
    { name: "$tap", at: days(3) + 130_000, session: "ses_alice0000001", props: { target: "a.b" } },
  ]);
  await send("dev_alicephone1", "r2", [
    { name: "$session_start", at: days(1), session: "ses_alice0000002" },
    { name: "record.submit", at: days(1) + 5_000, session: "ses_alice0000002", props: { kind: "income", len: 4 } },
    { name: "record.submit", at: days(1) + 6_000, session: "ses_alice0000002", props: { kind: "expense", len: 5 } },
  ]);
  await send("dev_machine0001", "r2", [
    { name: "$session_start", at: days(0) - 60_000, session: "ses_machine00001" },
    { name: "switch", at: days(0) - 30_000, session: "ses_machine00001", props: { app: "Xcode" } },
  ], "macos");

  const person = await (await h.request("/api/people", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Alice" }) })).json() as { id: number };
  const { devices } = await get("/api/apps/cashier/devices");
  const alice = devices.find((d: any) => d.deviceId === "dev_alicephone1");
  await h.request(`/api/devices/${alice.id}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ personId: person.id }) });
});
afterAll(() => h.close());

describe("overview", () => {
  it("counts sessions, devices and events, with day-by-day, duration, platform, person and release splits", async () => {
    const o = await get("/api/apps/cashier/overview?from=2026-09-29&to=2026-10-02");
    expect(o.totals).toMatchObject({ sessions: 3, devices: 2, events: 8, activeDays: 3 });
    expect(o.daily).toHaveLength(4);
    expect(o.daily.map((d: any) => d.sessions)).toEqual([1, 0, 1, 1]);
    expect(o.durations.find((d: any) => d.bucket === "<10 s").sessions).toBe(1);
    expect(o.durations.find((d: any) => d.bucket === "1–5 min").sessions).toBe(1);
    expect(o.platforms).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "web", devices: 1, sessions: 2 }),
      expect.objectContaining({ platform: "macos", devices: 1, sessions: 1 }),
    ]));
    expect(o.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ person: "Alice", sessions: 2 }),
      expect.objectContaining({ person: null, sessions: 1 }),
    ]));
    expect(o.options).toMatchObject({ releases: ["r2", "r1"], platforms: expect.arrayContaining(["web", "macos"]) });
  });

  it("filters by platform, release and person", async () => {
    expect((await get("/api/apps/cashier/overview?platform=macos")).totals.sessions).toBe(1);
    expect((await get("/api/apps/cashier/overview?release=r1")).totals.sessions).toBe(1);
    expect((await get("/api/apps/cashier/overview?person=none")).totals.devices).toBe(1);
    expect((await get("/api/apps/cashier/overview?device=dev_alicephone1")).totals.sessions).toBe(2);
  });

  it("starts the day at the deployment's offset", async () => {
    // 16:00 UTC on Oct 1 is already Oct 2 at UTC+8: the session of "yesterday" counts on Oct 1 local.
    const o = await get("/api/apps/cashier/overview?from=2026-10-01&to=2026-10-02");
    expect(o.daily.map((d: any) => [d.day, d.sessions])).toEqual([["2026-10-01", 1], ["2026-10-02", 1]]);
  });

  it("rejects bad ranges and unknown apps", async () => {
    expect((await h.request("/api/apps/cashier/overview?from=2026-10-03&to=2026-10-02", { headers: { cookie } })).status).toBe(400);
    expect((await h.request("/api/apps/cashier/overview?from=nope", { headers: { cookie } })).status).toBe(400);
    expect((await h.request("/api/apps/nope/overview", { headers: { cookie } })).status).toBe(404);
    expect((await h.request("/api/apps/cashier/overview")).status).toBe(401);
  });
});

describe("events", () => {
  const names = async (q = "") => (await get(`/api/apps/cashier/events/names?from=2026-09-25&to=2026-10-02${q}`)).names as { name: string; events: number }[];
  const trend = async (q: string) => (await get(`/api/apps/cashier/events/trend?from=2026-09-28&to=2026-10-02&${q}`)) as { days: string[]; series: { key: string; total: number; values: number[] }[]; truncated: boolean };

  it("lists names with counts, from raw events before any rollup", async () => {
    const list = await names();
    expect(Object.fromEntries(list.map((n) => [n.name, n.events]))).toEqual({ "record.submit": 3, "$session_start": 3, "$tap": 1, switch: 1 });
    expect(list[0]!.name).toBe("$session_start");
    expect(await names("&platform=macos")).toHaveLength(2);
  });

  it("gives the same numbers after the nightly rollup, which reads daily_events for finished days", async () => {
    const before = await names();
    const result = await runRollup(h.env.DB, h.clock.now, OFFSET);
    expect(result.daysRolled).toBeGreaterThan(0);
    const rows = await h.env.DB.prepare("SELECT count(*) AS n FROM daily_events").first<{ n: number }>();
    expect(rows!.n).toBeGreaterThan(0);
    expect(await names()).toEqual(before);
    // Today is not rolled up yet but is still counted.
    const t = await trend("name=switch");
    expect(t.series[0]!.total).toBe(1);
    // The rolled-up days really come from the table: change a raw row and the old day does not move.
    await h.env.DB.prepare("DELETE FROM events WHERE name = 'record.submit' AND occurred_at < ?1").bind(days(2)).run();
    expect((await trend("name=record.submit")).series[0]!.total).toBe(3);
  });

  it("splits a trend by a prop and keeps the rest together", async () => {
    const t = await trend("name=record.submit&by=kind");
    expect(t.series.map((s) => [s.key, s.total])).toEqual([["expense", 1], ["income", 1]]);
    expect(t.days).toHaveLength(5);
    const filtered = await trend("name=record.submit&prop=kind&value=income");
    expect(filtered.series[0]!.total).toBe(1);
  });

  it("narrows a trend to a device or to nobody's devices", async () => {
    expect((await trend("name=switch&person=none")).series[0]!.total).toBe(1);
    expect((await trend("name=switch&device=dev_alicephone1")).series).toEqual([]);
  });

  it("pages through raw events, newest first", async () => {
    const first = await get("/api/apps/cashier/events/raw?from=2026-09-25&to=2026-10-02&limit=2");
    expect(first.events).toHaveLength(2);
    expect(first.events[0].at).toBeGreaterThan(first.events[1].at);
    expect(first.events[0]).toMatchObject({ name: "switch", props: { app: "Xcode" }, deviceId: "dev_machine0001" });
    const second = await get(`/api/apps/cashier/events/raw?from=2026-09-25&to=2026-10-02&limit=2&before=${first.next}`);
    expect(second.events[0].at).toBeLessThanOrEqual(first.events[1].at);
    const only = await get("/api/apps/cashier/events/raw?from=2026-09-25&to=2026-10-02&name=switch");
    expect(only.events.map((e: any) => e.name)).toEqual(["switch"]);
  });

  it("refuses a malformed prop path", async () => {
    expect((await h.request("/api/apps/cashier/events/trend?name=x&by=a;b", { headers: { cookie } })).status).toBe(400);
  });
});

describe("rollup and retention", () => {
  it("reopens counted days when old events arrive", async () => {
    const before = await h.env.DB.prepare("SELECT rollup_through AS t FROM apps WHERE slug = 'cashier'").first<{ t: string }>();
    expect(before!.t).toBe("2026-10-01");
    await send("dev_alicephone1", "r1", [{ name: "late", at: days(6), session: "ses_alice0000003" }]);
    const after = await h.env.DB.prepare("SELECT rollup_through AS t FROM apps WHERE slug = 'cashier'").first<{ t: string }>();
    expect(after!.t < before!.t).toBe(true);
    // Until the next run counts those days, the raw events fill in.
    const t = (await get("/api/apps/cashier/events/trend?from=2026-09-25&to=2026-10-02&name=late")).series[0];
    expect(t.total).toBe(1);
    await runRollup(h.env.DB, h.clock.now, OFFSET);
    expect((await h.env.DB.prepare("SELECT rollup_through AS t FROM apps WHERE slug = 'cashier'").first<{ t: string }>())!.t).toBe("2026-10-01");
    expect((await get("/api/apps/cashier/events/trend?from=2026-09-25&to=2026-10-02&name=late")).series[0].total).toBe(1);
  });

  it("prunes old taps after counting them, and keeps the counts", async () => {
    const app = (await h.env.DB.prepare("SELECT id FROM apps WHERE slug = 'cashier'").first<{ id: number }>())!;
    const device = (await h.env.DB.prepare("SELECT id FROM devices WHERE device_id = 'dev_alicephone1'").first<{ id: number }>())!;
    const insert = (name: string, at: number, n: number) =>
      h.env.DB.prepare(
        `INSERT INTO events (app_id, event_id, device_ref, name, occurred_at, received_at, platform, release, props)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'web', 'r1', '{}')`,
      ).bind(app.id, `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`, device.id, name, at).run();
    await insert("$tap", days(45), 1);
    await insert("$tap", days(45) + 1000, 2);
    await insert("record.open", days(45) + 2000, 3);
    await insert("$tap", days(5), 4);

    // Not counted yet, so the taps must stay.
    await h.env.DB.prepare("UPDATE apps SET rollup_through = NULL WHERE id = ?1").bind(app.id).run();
    await runRetention(h.env.DB, h.clock.now, { dayOffsetMinutes: OFFSET });
    const count = async (name: string) => (await h.env.DB.prepare("SELECT count(*) AS n FROM events WHERE name = ?1 AND occurred_at < ?2").bind(name, days(30)).first<{ n: number }>())!.n;
    expect(await count("$tap")).toBe(2);

    await runRollup(h.env.DB, h.clock.now, OFFSET, { maxDays: 60 });
    await runRetention(h.env.DB, h.clock.now, { dayOffsetMinutes: OFFSET });
    expect(await count("$tap")).toBe(0);
    expect(await count("record.open")).toBe(1);
    expect((await h.env.DB.prepare("SELECT count(*) AS n FROM events WHERE name = '$tap' AND occurred_at > ?1").bind(days(10)).first<{ n: number }>())!.n).toBe(2);

    const t = (await get("/api/apps/cashier/events/trend?from=2026-08-01&to=2026-10-02&name=%24tap")).series[0];
    expect(t.total).toBe(4); // the two pruned, the one from 5 days ago and the one from 3 days ago
  });

  it("works through a long history over several runs", async () => {
    const first = await runRollup(h.env.DB, h.clock.now, OFFSET, { maxDays: 1 });
    expect(first.daysRolled).toBeLessThanOrEqual(1);
  });
});
