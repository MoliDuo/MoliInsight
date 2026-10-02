import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const PUBLIC = fileURLToPath(new URL("../../dashboard/public/", import.meta.url).href);
const HOUR = 3_600_000;

let h: Harness;
let win: Window;
let cookie: string;

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}\n${main().textContent}`);
}
const main = () => win.document.getElementById("main")!;
async function go(hash: string, ready: string) {
  win.location.hash = hash;
  win.dispatchEvent(new win.Event("hashchange"));
  await until(() => main().textContent!.includes(ready), ready);
}

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  const key = await h.newApp("cashier", cookie);
  const t = h.clock.now - 3 * HOUR;
  let n = 0;
  const ev = (device: string, release: string, session: string, name: string, at: number, props?: object) => ({
    context: { platform: "web", release, deviceId: device },
    event: { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name, occurredAt: new Date(at).toISOString(), sessionId: session, ...(props && { props }) },
  });
  const all = [
    ev("dev_analysis0001", "r1", "ses_analysis0001", "$session_start", t),
    ev("dev_analysis0001", "r1", "ses_analysis0001", "record.open", t + 1000),
    ev("dev_analysis0001", "r1", "ses_analysis0001", "record.submit", t + 9000),
    ev("dev_analysis0001", "r1", "ses_analysis0001", "$screen", t + 9500, { screen: "/stats", from: "/ledger" }),
    ev("dev_analysis0001", "r1", "ses_analysis0001", "$rage_tap", t + 9900, { target: "<b>fab</b>", count: 3 }),
    ev("dev_analysis0002", "r2", "ses_analysis0002", "$session_start", t + HOUR),
    ev("dev_analysis0002", "r2", "ses_analysis0002", "record.open", t + HOUR + 1000),
    ev("dev_analysis0002", "r2", "ses_analysis0002", "mystery", t + HOUR + 2000),
  ];
  for (const release of ["r1", "r2"]) {
    const mine = all.filter((e) => e.context.release === release);
    const response = await h.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, sentAt: new Date(h.clock.now).toISOString(), context: mine[0]!.context, events: mine.map((e) => e.event) }),
    });
    expect(response.status).toBe(200);
  }
  const catalog = await h.request("/v1/catalog", {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      events: [
        { name: "record.open", description: "The record dialog opened." },
        { name: "record.submit", description: "A record was submitted." },
        { name: "never.used", description: "Nobody does this." },
      ],
      metrics: [{ name: "submit_rate", description: "Submitted over opened.", kind: "ratio", goodDirection: "up", numerator: { event: "record.submit" }, denominator: { event: "record.open" } }],
      funnels: [{ name: "record_flow", steps: [{ event: "record.open" }, { event: "record.submit" }], windowMs: HOUR, by: "session" }],
    }),
  });
  expect(catalog.status).toBe(200);

  win = new Window({ url: "https://insight.test/#/funnels" });
  const html = readFileSync(`${PUBLIC}index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  win.document.write(html);
  const g = globalThis as any;
  for (const name of ["document", "location", "localStorage", "Node", "URLSearchParams"]) g[name] = (win as any)[name];
  g.addEventListener = win.addEventListener.bind(win);
  g.confirm = () => true;
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => h.request(path, { ...init, headers: { ...(init.headers as object), cookie } }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const name of ["document", "location", "localStorage", "Node", "URLSearchParams", "addEventListener", "confirm"]) delete (globalThis as any)[name];
  await h.close();
});

describe("the analysis pages against the real API", () => {
  it("shows the catalog's metrics, and runs a funnel", async () => {
    // @ts-expect-error the dashboard is plain JavaScript
    await import("../../dashboard/public/admin.js");
    await until(() => main().textContent!.includes("submit_rate"), "the metric");
    expect(main().textContent).toContain("50%"); // one submit of two opens
    const run = [...main().querySelectorAll("button")].find((b) => b.textContent === "record_flow")!;
    run.dispatchEvent(new win.Event("click"));
    await until(() => main().textContent!.includes("个会话进入"), "the funnel result");
    expect(main().textContent).toContain("2 个会话进入");
    expect(main().textContent).toContain("2. record.submit");
  });

  it("lists sessions, and opens one as a timeline", async () => {
    await go("#/sessions", "平台 版本");
    await until(() => main().querySelectorAll("tbody tr").length === 2, "two sessions");
    const link = main().querySelector("tbody a") as unknown as { getAttribute(name: string): string };
    expect(link.getAttribute("href")).toMatch(/^#\/sessions\/ses_analysis000/);
    await go(link.getAttribute("href")!, "会话时间线");
    expect(main().querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(3);
  });

  it("compares releases", async () => {
    await go("#/compare", "对比 B");
    expect(main().textContent).toContain("A r");
    expect(main().textContent).toContain("指标 submit_rate");
  });

  it("shows friction as text, never as markup", async () => {
    await go("#/friction", "连点");
    await until(() => main().textContent!.includes("<b>fab</b>"), "the tap target as text");
    expect(main().querySelector("code b")).toBeNull();
  });

  it("reports performance, navigation, and feature usage", async () => {
    await go("#/performance", "操作耗时");
    await go("#/navigation", "/ledger");
    await go("#/usage", "没登记");
    await until(() => main().textContent!.includes("never.used") && main().textContent!.includes("mystery"), "unused and uncataloged events");
  });
});
