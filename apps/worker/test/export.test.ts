import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let cookie: string;
beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  const switchKey = await h.newApp("switch", cookie);
  const cashierKey = await h.newApp("cashier", cookie);
  const send = (key: string, platform: string, events: unknown[]) =>
    h.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        sentAt: new Date(h.clock.now).toISOString(),
        context: { platform, release: "r1", deviceId: `dev_${platform}device1` },
        events,
      }),
    });
  const at = (s: number) => new Date(h.clock.now - s * 1000).toISOString();
  const ev = (n: number, name: string, s: number, extra = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    occurredAt: at(s),
    sessionId: "ses_exportsession1",
    ...extra,
  });
  await send(switchKey, "macos", [ev(1, "switch", 30, { props: { app: "Xcode" } }), ev(2, "manualSwitch", 20)]);
  await send(cashierKey, "web", [ev(3, "$tap", 10, { props: { target: "topbar.period_next" } }), ev(4, "record.open", 5)]);
});
afterAll(() => h.close());

const lines = async (response: Response) =>
  (await response.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

describe("GET /v1/export", () => {
  it("needs a session or an admin token", async () => {
    expect((await h.request("/v1/export?app=switch")).status).toBe(401);
    expect((await h.request("/v1/export?app=switch", { headers: { authorization: "Bearer mia_nope" } })).status).toBe(401);
  });

  it("reads each app's events as NDJSON, oldest first, with a header and an end line", async () => {
    const got = await lines(await h.request("/v1/export?app=switch", { headers: { cookie } }));
    expect(got.map((l) => l.type)).toEqual(["header", "event", "event", "end"]);
    expect(got[0]).toMatchObject({ format: "moli-insight-export", version: 1, app: { slug: "switch" } });
    expect(got.slice(1, 3).map((l) => l.name)).toEqual(["switch", "manualSwitch"]);
    expect(got[1]).toMatchObject({ platform: "macos", props: { app: "Xcode" }, deviceId: "dev_macosdevice1" });
    expect(got[3]).toEqual({ type: "end", count: 2, next: null });

    const cashier = await lines(await h.request("/v1/export?app=cashier", { headers: { cookie } }));
    expect(cashier.filter((l) => l.type === "event").map((l) => l.name)).toEqual(["$tap", "record.open"]);
  });

  it("pages with a cursor", async () => {
    const first = await lines(await h.request("/v1/export?app=switch&limit=1", { headers: { cookie } }));
    expect(first.filter((l) => l.type === "event")).toHaveLength(1);
    const next = first.at(-1)!.next as string;
    expect(next).toMatch(/^\d+\.\d+$/);
    const second = await lines(await h.request(`/v1/export?app=switch&limit=1&after=${next}`, { headers: { cookie } }));
    expect(second.filter((l) => l.type === "event").map((l) => l.name)).toEqual(["manualSwitch"]);
    expect(second.at(-1)!.next).toBeNull();
  });

  it("filters by time range and works with an admin token", async () => {
    const created = await h.request("/api/admin-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "t" }),
    });
    const { token } = (await created.json()) as { token: string };
    const from = new Date(h.clock.now - 25_000).toISOString();
    const got = await lines(await h.request(`/v1/export?app=switch&from=${from}`, { headers: { authorization: `Bearer ${token}` } }));
    expect(got.filter((l) => l.type === "event").map((l) => l.name)).toEqual(["manualSwitch"]);
  });

  it("rejects an unknown app and a bad cursor", async () => {
    expect((await h.request("/v1/export?app=nope", { headers: { cookie } })).status).toBe(404);
    expect((await h.request("/v1/export?app=switch&after=x", { headers: { cookie } })).status).toBe(400);
    expect((await h.request("/v1/export", { headers: { cookie } })).status).toBe(400);
  });
});
