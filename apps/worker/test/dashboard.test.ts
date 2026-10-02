import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const PUBLIC = fileURLToPath(new URL("../../dashboard/public/", import.meta.url).href);

let h: Harness;
let win: Window;
let cookie: string;
const DAY = 24 * 60 * 60 * 1000;

/** Waits until the page has drawn something that satisfies `check`. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}\n${win.document.getElementById("main")!.textContent}`);
}

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  const key = await h.newApp("cashier", cookie);
  const at = (days: number, s = 0) => new Date(h.clock.now - days * DAY + s * 1000).toISOString();
  await h.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      sentAt: new Date(h.clock.now).toISOString(),
      context: { platform: "web", release: "r1", deviceId: "dev_dashboard001" },
      events: [
        { id: "00000000-0000-4000-8000-0000000000a1", name: "$session_start", occurredAt: at(1), sessionId: "ses_dashboard001" },
        { id: "00000000-0000-4000-8000-0000000000a2", name: "record.submit", occurredAt: at(1, 40), sessionId: "ses_dashboard001", props: { kind: "expense" } },
        { id: "00000000-0000-4000-8000-0000000000a3", name: "record.submit", occurredAt: at(0, -30), sessionId: "ses_dashboard001", props: { kind: "income" } },
      ],
    }),
  });

  // A browser, talking to the real worker through the dashboard's own fetch calls.
  win = new Window({ url: "https://insight.test/#/overview" });
  const html = readFileSync(`${PUBLIC}index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  win.document.write(html);
  const g = globalThis as any;
  for (const name of ["document", "location", "localStorage", "Node", "URLSearchParams"]) g[name] = (win as any)[name];
  g.addEventListener = win.addEventListener.bind(win);
  g.confirm = () => true;
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) =>
    h.request(path, { ...init, headers: { ...(init.headers as object), cookie } }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const name of ["document", "location", "localStorage", "Node", "URLSearchParams", "addEventListener", "confirm"]) delete (globalThis as any)[name];
  await h.close();
});

const main = () => win.document.getElementById("main")!;

describe("the dashboard pages against the real API", () => {
  it("draws the overview", async () => {
    // @ts-expect-error the dashboard is plain JavaScript
    await import("../../dashboard/public/admin.js");
    await until(() => main().textContent!.includes("平均会话时长"), "the overview");
    const text = main().textContent!;
    expect(text).toContain("概览");
    expect(main().querySelectorAll(".stat b")[0]!.textContent).toBe("1"); // one session
    expect(main().querySelector("svg.chart")).not.toBeNull();
    expect(text).toContain("web");
    expect(win.document.querySelector('nav a[href="#/overview"]')!.className).toBe("current");
  });

  it("lists events, and shows a trend and raw rows for one", async () => {
    win.location.hash = "#/events/record.submit";
    win.dispatchEvent(new win.Event("hashchange"));
    await until(() => main().textContent!.includes("原始记录") && main().querySelectorAll("tbody tr").length > 0, "the event detail");
    const text = main().textContent!;
    expect(text).toContain("record.submit");
    expect(text).toContain("$session_start");
    expect(text).toContain("2 次");
    expect(text).toContain('{"kind":"income"}');
  });

  it("never turns data into markup", async () => {
    const key = await h.newApp("evil", cookie);
    await h.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        sentAt: new Date(h.clock.now).toISOString(),
        context: { platform: "web", release: "<img src=x onerror=alert(1)>", deviceId: "dev_dashboard002" },
        events: [{ id: "00000000-0000-4000-8000-0000000000b1", name: "$session_start", occurredAt: new Date(h.clock.now - 1000).toISOString(), sessionId: "ses_dashboard002" }],
      }),
    });
    win.location.hash = "#/overview";
    win.dispatchEvent(new win.Event("hashchange"));
    await until(() => main().textContent!.includes("平均会话时长"), "the overview again");
    const picker = main().querySelector(".controls select") as unknown as { value: string; dispatchEvent(e: unknown): void };
    picker.value = "evil";
    picker.dispatchEvent(new win.Event("change"));
    await until(() => main().textContent!.includes("<img src=x"), "the release name as text");
    expect(main().querySelector("img")).toBeNull();
  });
});
