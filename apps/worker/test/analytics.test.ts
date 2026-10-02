import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRollup } from "../src/rollup.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let cookie: string;
let key: string;
let adminToken: string;
const HOUR = 3_600_000;
const t0 = () => h.clock.now - 24 * HOUR; // "yesterday, this time"

let seq = 0;
async function send(device: string, release: string, events: { name: string; at: number; session: string; props?: object }[]) {
  const response = await h.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      sentAt: new Date(h.clock.now).toISOString(),
      context: { platform: "web", release, deviceId: device },
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

const get = async (path: string, init: RequestInit = {}) => {
  const response = await h.request(path, { ...init, headers: { cookie, ...(init.headers as object) } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as any;
};

const CATALOG = {
  schemaVersion: 1,
  events: [
    { name: "record.open", description: "The record dialog opened." },
    { name: "record.submit", description: "A record was submitted.", props: { kind: { type: "string", description: "expense or income", enum: ["expense", "income"] } } },
    { name: "record.abandon", description: "The dialog was closed without submitting." },
    { name: "never.used", description: "Nobody has done this.", tier: "product" },
    { name: "key", description: "A keystroke.", tier: "debug" },
  ],
  metrics: [
    {
      name: "abandon_rate", description: "Abandoned over opened.", kind: "ratio", goodDirection: "down",
      numerator: { event: "record.abandon" }, denominator: { event: "record.open" }, groupBy: ["source"],
    },
    {
      name: "income_share", description: "Income submits over all submits.", kind: "ratio",
      numerator: { event: "record.submit", where: [{ prop: "kind", op: "eq", value: "income" }] }, denominator: { event: "record.submit" },
    },
  ],
  funnels: [{ name: "record_flow", steps: [{ event: "record.open" }, { event: "record.submit" }], windowMs: HOUR, by: "session" }],
};

beforeAll(async () => {
  h = await createHarness();
  (h.env as any).DAY_OFFSET_MINUTES = "480";
  cookie = await h.login();
  key = await h.newApp("cashier", cookie);
  const token = await h.request("/api/admin-tokens", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  adminToken = ((await token.json()) as any).token;

  const t = t0();
  // S1: a clean pass, release r1.  S2: opens and abandons, r1.  S3: submits too late, r2 (another device).
  await send("dev_aaaaaaaa0001", "r1", [
    { name: "$session_start", at: t, session: "ses_flowone00001" },
    { name: "$screen", at: t + 1000, session: "ses_flowone00001", props: { screen: "/ledger", from: "/" } },
    { name: "record.open", at: t + 5000, session: "ses_flowone00001", props: { source: "fab" } },
    { name: "record.input", at: t + 9000, session: "ses_flowone00001" },
    { name: "record.submit", at: t + 20_000, session: "ses_flowone00001", props: { kind: "expense" } },
    { name: "$op", at: t + 21_000, session: "ses_flowone00001", props: { op: "ledger.save", ms: 180, ok: true } },
    { name: "$vital", at: t + 22_000, session: "ses_flowone00001", props: { metric: "LCP", value: 1800, rating: "good", screen: "/ledger" } },
    { name: "$tap", at: t + 23_000, session: "ses_flowone00001", props: { target: "topbar.next" } },
  ]);
  await send("dev_aaaaaaaa0001", "r1", [
    { name: "$session_start", at: t + 2 * HOUR, session: "ses_flowtwo00001" },
    { name: "$screen", at: t + 2 * HOUR + 500, session: "ses_flowtwo00001", props: { screen: "/stats", from: "/ledger" } },
    { name: "record.open", at: t + 2 * HOUR + 1000, session: "ses_flowtwo00001", props: { source: "menu" } },
    { name: "$dead_tap", at: t + 2 * HOUR + 2000, session: "ses_flowtwo00001", props: { target: "dialog.hint" } },
    { name: "$rage_tap", at: t + 2 * HOUR + 3000, session: "ses_flowtwo00001", props: { target: "dialog.hint", count: 4 } },
    { name: "record.abandon", at: t + 2 * HOUR + 8000, session: "ses_flowtwo00001", props: { source: "menu" } },
    { name: "$error", at: t + 2 * HOUR + 9000, session: "ses_flowtwo00001", props: { kind: "rejection", message: "fetch failed 500" } },
    { name: "$dialog", at: t + 2 * HOUR + 9500, session: "ses_flowtwo00001", props: { dialog: "record", action: "close", closeBy: "backdrop" } },
  ]);
  await send("dev_bbbbbbbb0002", "r2", [
    { name: "$session_start", at: t + 4 * HOUR, session: "ses_flowthree001" },
    { name: "record.open", at: t + 4 * HOUR + 1000, session: "ses_flowthree001", props: { source: "fab" } },
    { name: "record.submit", at: t + 4 * HOUR + 2 * HOUR, session: "ses_flowthree001", props: { kind: "income" } },
    { name: "$op", at: t + 6 * HOUR + 1, session: "ses_flowthree001", props: { op: "ledger.save", ms: 900, ok: false, errorKind: "http" } },
    { name: "$vital", at: t + 6 * HOUR + 2, session: "ses_flowthree001", props: { metric: "LCP", value: 4200, rating: "poor", screen: "/ledger" } },
  ]);
});
afterAll(() => h.close());

describe("the catalog", () => {
  it("is uploaded with an ingest key, checked, and replaced as a whole", async () => {
    const put = (body: unknown, auth = `Bearer ${key}`) =>
      h.request("/v1/catalog", { method: "PUT", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put(CATALOG, "Bearer mi_nope")).status).toBe(401);
    const bad = await put({ schemaVersion: 1, events: [{ name: "bad name", description: "x" }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).issues[0].path).toBe("events.0.name");
    const dup = await put({ schemaVersion: 1, events: [{ name: "a", description: "x" }, { name: "a", description: "y" }] });
    expect(dup.status).toBe(400);

    const response = await put(CATALOG);
    expect(await response.json()).toEqual({ ok: true, events: 5, metrics: 2, funnels: 1 });
    const read = await get("/api/apps/cashier/catalog");
    expect(read.catalog.metrics.map((m: any) => m.name).sort()).toEqual(["abandon_rate", "income_share"]);
    expect(read.catalog.events).toHaveLength(5);

    await put({ ...CATALOG, events: CATALOG.events.slice(0, 2), funnels: [] });
    expect((await get("/api/apps/cashier/catalog")).catalog.events).toHaveLength(2);
    await put(CATALOG);
  });

  it("tells used from unused events", async () => {
    const u = await get("/api/apps/cashier/usage?days=7");
    expect(u.unused.map((e: any) => e.name)).toEqual(expect.arrayContaining(["never.used", "key"]));
    expect(u.uncataloged.map((e: any) => e.name)).toEqual(["record.input"]);
    expect(u.taps[0]).toMatchObject({ target: "topbar.next", events: 1 });
  });
});

describe("metrics", () => {
  it("computes a ratio, split by a group prop", async () => {
    const m = await get("/api/apps/cashier/metrics/abandon_rate?days=7");
    expect(m).toMatchObject({ numerator: 1, denominator: 3, goodDirection: "down" });
    expect(m.ratio).toBeCloseTo(1 / 3);
    expect(m.groups).toEqual([
      { group: "fab", numerator: 0, denominator: 2, ratio: 0 },
      { group: "menu", numerator: 1, denominator: 1, ratio: 1 },
    ]);
    expect(m.daily.reduce((n: number, d: any) => n + d.denominator, 0)).toBe(3);
  });

  it("applies conditions on props", async () => {
    const m = await get("/api/apps/cashier/metrics/income_share?days=7");
    expect(m).toMatchObject({ numerator: 1, denominator: 2, ratio: 0.5 });
    const narrowed = await get("/api/apps/cashier/metrics/income_share?days=7&release=r1");
    expect(narrowed).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it("gives the same answer from the daily counts after the nightly rollup", async () => {
    const before = await get("/api/apps/cashier/metrics/income_share?days=7");
    await runRollup(h.env.DB, h.clock.now, 480);
    expect(await get("/api/apps/cashier/metrics/income_share?days=7")).toEqual(before);
    expect((await h.request("/api/apps/cashier/metrics/nope", { headers: { cookie } })).status).toBe(404);
  });
});

describe("funnels", () => {
  it("counts how far each session got within the window", async () => {
    const f = await get("/api/apps/cashier/funnel?name=record_flow&days=7");
    expect(f.entities).toBe(3);
    expect(f.steps.map((s: any) => s.entities)).toEqual([3, 1]);
    expect(f.steps[1].fromPrevious).toBeCloseTo(1 / 3);
    expect(f.steps[1].medianMsFromPrevious).toBe(15_000);
  });

  it("takes steps in the request, with conditions, and by device", async () => {
    const body = { steps: [{ event: "record.open" }, { event: "record.submit", where: [{ prop: "kind", op: "eq", value: "income" }] }], windowMs: 3 * HOUR };
    const f = await get("/api/apps/cashier/funnel?days=7", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(f.steps.map((s: any) => s.entities)).toEqual([3, 1]);
    const byDevice = await get("/api/apps/cashier/funnel?days=7", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, by: "device" }) });
    expect(byDevice.entities).toBe(2);
    expect(byDevice.steps.map((s: any) => s.entities)).toEqual([2, 1]);
  });

  it("saves a funnel from the dashboard and runs it by name", async () => {
    const put = await h.request("/api/apps/cashier/funnels/open_input", {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ event: "record.open" }, { event: "record.input" }], windowMs: HOUR }),
    });
    expect(put.status).toBe(200);
    expect((await get("/api/apps/cashier/catalog")).savedFunnels.map((f: any) => f.name)).toEqual(["open_input"]);
    const f = await get("/api/apps/cashier/funnel?name=open_input&days=7");
    expect(f.steps.map((s: any) => s.entities)).toEqual([3, 1]);
    const del = await h.request("/api/apps/cashier/funnels/open_input", { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect((await h.request("/api/apps/cashier/funnel?name=open_input", { headers: { cookie } })).status).toBe(404);
  });

  it("rejects a funnel with one step", async () => {
    const r = await h.request("/api/apps/cashier/funnel", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ steps: [{ event: "a" }], windowMs: 1000 }) });
    expect(r.status).toBe(400);
  });
});

describe("releases, friction, performance, navigation", () => {
  it("compares two releases", async () => {
    const c = await get("/api/apps/cashier/compare?a=r1&b=r2&days=7");
    expect(c.a).toMatchObject({ release: "r1", sessions: 2, errors: 1, rageTaps: 1, deadTaps: 1, ops: 1, opFailureRate: 0 });
    expect(c.b).toMatchObject({ release: "r2", sessions: 1, errors: 0, ops: 1, opFailureRate: 1 });
    expect(c.a.errorsPerSession).toBe(0.5);
    expect(c.a.metrics.map((m: any) => m.name)).toEqual(["abandon_rate", "income_share"]);
    expect((await h.request("/api/apps/cashier/compare?a=r1", { headers: { cookie } })).status).toBe(400);
  });

  it("ranks friction", async () => {
    const f = await get("/api/apps/cashier/friction?days=7");
    expect(f.rageTaps).toEqual([{ target: "dialog.hint", events: 1, devices: 1 }]);
    expect(f.deadTaps[0]).toMatchObject({ target: "dialog.hint" });
    expect(f.errors[0]).toMatchObject({ kind: "rejection", events: 1 });
    expect(f.dialogs[0]).toMatchObject({ dialog: "record", action: "close", closeBy: "backdrop" });
  });

  it("reports vitals and operations", async () => {
    const p = await get("/api/apps/cashier/performance?days=7");
    expect(p.vitals).toEqual([expect.objectContaining({ metric: "LCP", screen: "/ledger", samples: 2, p50: 1800, p75: 4200, goodShare: 0.5 })]);
    expect(p.ops).toEqual([expect.objectContaining({ op: "ledger.save", calls: 2, failureRate: 0.5, p50: 180, p95: 900, topErrorKind: "http" })]);
  });

  it("shows where people go next", async () => {
    const n = await get("/api/apps/cashier/navigation?days=7");
    expect(n.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "/", to: "/ledger", events: 1 })]));
    expect(n.screens.find((s: any) => s.screen === "/ledger").next).toEqual([{ screen: "/stats", events: 1 }]);
  });
});

describe("sessions", () => {
  it("lists sessions and plays one back as a timeline", async () => {
    const list = await get("/api/apps/cashier/sessions?days=7&limit=2");
    expect(list.sessions).toHaveLength(2);
    expect(list.next).not.toBeNull();
    expect(list.sessions[0].startedAt).toBeGreaterThan(list.sessions[1].startedAt);
    const t = await get("/api/apps/cashier/sessions/ses_flowtwo00001");
    expect(t.events.map((e: any) => e.name)).toEqual(["$session_start", "$screen", "record.open", "$dead_tap", "$rage_tap", "record.abandon", "$error", "$dialog"]);
    expect(t.events[2]).toMatchObject({ offsetMs: 1000, sincePreviousMs: 500 });
    expect(t.device.deviceId).toBe("dev_aaaaaaaa0001");
    expect((await h.request("/api/apps/cashier/sessions/ses_doesnotexist", { headers: { cookie } })).status).toBe(404);
  });
});

describe("MCP", () => {
  const rpc = async (body: unknown, auth: string | null = `Bearer ${adminToken}`) =>
    h.request("/mcp", { method: "POST", headers: { "content-type": "application/json", ...(auth && { authorization: auth }) }, body: JSON.stringify(body) });
  const tool = async (name: string, args: object) => {
    const r = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as any;
    return { error: r.result.isError === true, data: (r.result.isError ? null : JSON.parse(r.result.content[0].text)) as any, text: r.result.content[0].text as string };
  };

  it("needs an admin token", async () => {
    expect((await rpc({}, null)).status).toBe(401);
    expect((await rpc({}, `Bearer ${key}`)).status).toBe(401);
    expect((await h.request("/mcp", { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(405);
    expect((await h.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${adminToken}`, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  });

  it("speaks the protocol", async () => {
    const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json()) as any;
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "moli-insight" }, capabilities: { tools: {} } });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["list_apps", "get_catalog", "summary", "query_events", "metric", "funnel", "compare_releases", "session_timeline"]));
    expect(list.result.tools[0].inputSchema.type).toBe("object");
    const unknown = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "nope" })).json()) as any;
    expect(unknown.error.code).toBe(-32601);
    const batch = (await (await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }])).json()) as any[];
    expect(batch).toHaveLength(2);
    expect((await rpc("not an object")).status).toBe(200);
  });

  it("answers the questions the plan names", async () => {
    expect((await tool("list_apps", {})).data.apps[0]).toMatchObject({ slug: "cashier", devices: 2 });
    expect((await tool("get_catalog", { app: "cashier" })).data.catalog.metrics).toHaveLength(2);
    const summary = (await tool("summary", { app: "cashier", days: 7 })).data;
    expect(summary.totals.sessions).toBe(3);
    expect(summary.topEvents[0].name).toBeDefined();
    const metric = (await tool("metric", { app: "cashier", name: "abandon_rate", days: 7 })).data;
    expect(metric.ratio).toBeCloseTo(1 / 3);
    const funnel = (await tool("funnel", { app: "cashier", name: "record_flow", days: 7 })).data;
    expect(funnel.steps.map((s: any) => s.entities)).toEqual([3, 1]);
    const adhoc = (await tool("funnel", { app: "cashier", days: 7, steps: [{ event: "record.open" }, { event: "record.abandon" }] })).data;
    expect(adhoc.steps.map((s: any) => s.entities)).toEqual([3, 1]);
    const cmp = (await tool("compare_releases", { app: "cashier", a: "r1", b: "r2", days: 7 })).data;
    expect(cmp.a.sessions).toBe(2);
    const events = (await tool("query_events", { app: "cashier", name: "record.submit", days: 7, limit: 1 })).data;
    expect(events.events).toHaveLength(1);
    expect(events.next).not.toBeNull();
    expect(events.events[0].at).toMatch(/^2026-/);
    const timeline = (await tool("session_timeline", { app: "cashier", sessionId: "ses_flowone00001" })).data;
    expect(timeline.events[0].name).toBe("$session_start");
    expect((await tool("friction", { app: "cashier", days: 7 })).data.rageTaps).toHaveLength(1);
    expect((await tool("performance", { app: "cashier", days: 7 })).data.ops).toHaveLength(1);
    expect((await tool("trend", { app: "cashier", name: "record.submit", by: "kind", days: 7 })).data.series).toHaveLength(2);
  });

  it("returns errors as tool results the model can read, and bounds its arguments", async () => {
    const noApp = await tool("metric", { app: "nope", name: "x" });
    expect(noApp.error).toBe(true);
    expect(noApp.text).toContain("nope");
    expect((await tool("metric", { app: "cashier", name: "x" })).error).toBe(true);
    const r = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_events", arguments: { app: "cashier", limit: 5000 } } })).json()) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("limit");
    const range = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summary", arguments: { app: "cashier", from: "2026-10-03", to: "2026-10-01" } } })).json()) as any;
    expect(range.result.isError).toBe(true);
  });
});
