// The worker's test harness needs the Node environment, so the browser is a happy-dom window
// whose globals are installed by hand before the app and Testing Library are loaded.
import { GlobalWindow } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../worker/test/harness.ts";

type Rtl = typeof import("@testing-library/react");
let act: Rtl["act"], cleanup: Rtl["cleanup"], fireEvent: Rtl["fireEvent"], render: Rtl["render"];
let screen: Rtl["screen"], waitFor: Rtl["waitFor"], within: Rtl["within"];

function installBrowser(url: string) {
  const win = new GlobalWindow({ url });
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    // Elements only accept the window's own event classes, and Node has its own of the same names.
    const own = /^(Custom|Mouse|Keyboard|Focus|Input|Pointer|UI)?Event$/.test(key);
    if ((key in g && !own) || key === "fetch" || key.startsWith("_")) continue;
    try { g[key] = (win as unknown as Record<string, unknown>)[key]; } catch {}
  }
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set("window", win);
  for (const name of ["document", "navigator", "localStorage", "location", "history"]) set(name, (win as unknown as Record<string, unknown>)[name]);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return win;
}

const HOUR = 3_600_000;
let h: Harness;
let cookie: string;
let createAppRouter: typeof import("../src/app.tsx").createAppRouter;
let createMemoryHistory: typeof import("@tanstack/react-router").createMemoryHistory;
let router: ReturnType<typeof createAppRouter>;
let queryClient: typeof import("../src/app.tsx").queryClient;
let App: typeof import("../src/app.tsx").App;

async function ingest(key: string, context: object, events: object[]) {
  const response = await h.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, sentAt: new Date(h.clock.now).toISOString(), context, events }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  const key = await h.newApp("cashier", cookie);
  const t = h.clock.now - 3 * HOUR;
  let n = 0;
  const ev = (session: string, name: string, at: number, props?: object) => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    name, occurredAt: new Date(at).toISOString(), sessionId: session, ...(props && { props }),
  });
  await ingest(key, { platform: "web", release: "r1", deviceId: "dev_analysis0001" }, [
    ev("ses_analysis0001", "$session_start", t),
    ev("ses_analysis0001", "record.open", t + 1000),
    ev("ses_analysis0001", "record.submit", t + 9000, { kind: "income" }),
    ev("ses_analysis0001", "$screen", t + 9500, { screen: "/stats", from: "/ledger" }),
    ev("ses_analysis0001", "$rage_tap", t + 9900, { target: "<b>fab</b>", count: 3 }),
  ]);
  await ingest(key, { platform: "web", release: "r2", deviceId: "dev_analysis0002" }, [
    ev("ses_analysis0002", "$session_start", t + HOUR),
    ev("ses_analysis0002", "record.open", t + HOUR + 1000),
    ev("ses_analysis0002", "record.submit", t + HOUR + 5000, { kind: "expense" }),
    ev("ses_analysis0002", "mystery", t + HOUR + 2000),
  ]);
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

  // An app whose release name is markup.
  const evil = await h.newApp("evil", cookie);
  await ingest(evil, { platform: "web", release: "<img src=x onerror=alert(1)>", deviceId: "dev_dashboard002" }, [
    ev("ses_dashboard002", "$session_start", h.clock.now - 1000),
  ]);

  // The dashboard's own fetch calls, answered by the real worker with the session cookie.
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) =>
    h.request(path, { ...init, headers: { ...(init.headers as object), cookie } }),
  );
  installBrowser("https://insight.test/cashier/overview");
  ({ act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react"));
  ({ App, createAppRouter, queryClient } = await import("../src/app.tsx"));
  ({ createMemoryHistory } = await import("@tanstack/react-router"));
});
afterEach(() => cleanup?.());
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
});

async function open(path: string) {
  cleanup();
  queryClient.clear();
  router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  return render(<App router={router} />);
}

describe("the dashboard against the real API", { timeout: 20_000 }, () => {
  it("draws the overview, and keeps its controls in the URL", async () => {
    await open("/cashier/overview");
    await screen.findByText("平均会话时长");
    await waitFor(() => expect(document.querySelector('span[title="web"]')).not.toBeNull());
    const stat = screen.getByText("会话", { selector: "div" }).parentElement!;
    expect(within(stat).getByText("2")).toBeTruthy(); // two sessions
    expect(document.querySelector('a[href^="/cashier/overview"]')?.className).toContain("bg-muted");

    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "r2" } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ release: "r2" }));
    await waitFor(() => expect(within(screen.getByText("会话", { selector: "div" }).parentElement!).getByText("1")).toBeTruthy());
  });

  it("lists events, and shows a trend and raw rows for one", async () => {
    await open("/cashier/events/record.submit");
    await screen.findByText("原始记录");
    await screen.findByText('{"kind":"income"}');
    expect(await screen.findByText("2 次", {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findAllByText("$session_start")).not.toHaveLength(0);
    expect(await screen.findByText("A record was submitted.")).toBeTruthy();
  });

  it("shows the catalog's metrics, and runs a funnel", async () => {
    await open("/cashier/funnels");
    await screen.findByText("submit_rate");
    await screen.findByText("100%"); // both opens were followed by a submit
    fireEvent.click(screen.getByRole("button", { name: "record_flow" }));
    await screen.findByText(/2 个会话进入/);
    expect(screen.getByText("2. record.submit")).toBeTruthy();
  });

  it("lists sessions, and opens one as a timeline", async () => {
    await open("/cashier/sessions");
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(2));
    const link = document.querySelector("tbody a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/^\/cashier\/sessions\/ses_analysis000/);
    await act(async () => { fireEvent.click(link); });
    await screen.findByText("会话时间线");
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(3));
  });

  it("compares releases", async () => {
    await open("/cashier/compare");
    await screen.findByText(/^A r/);
    expect(await screen.findByText("指标 submit_rate")).toBeTruthy();
  });

  it("reports performance, navigation, and feature usage", async () => {
    await open("/cashier/performance");
    await screen.findByText("操作耗时");
    await open("/cashier/navigation");
    await screen.findByText("/ledger");
    await open("/cashier/usage");
    await screen.findByText("never.used");
    await screen.findByText("mystery");
  });

  it("never turns data into markup", async () => {
    await open("/cashier/friction");
    await screen.findByText("<b>fab</b>");
    expect(document.querySelector("code b")).toBeNull();

    await open("/evil/overview");
    expect((await screen.findAllByText("<img src=x onerror=alert(1)>")).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it("creates a token that shows once, and lists it straight away", async () => {
    await open("/settings/tokens");
    const label = await screen.findByLabelText("备注");
    fireEvent.change(label, { target: { value: "claude-mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "生成令牌" }));
    await screen.findByText(/只显示这一次/);
    expect(document.body.textContent).toMatch(/claude mcp add --transport http moli-insight https:\/\/insight.test\/mcp/);
    await waitFor(() => expect(screen.getAllByText("claude-mcp").length).toBeGreaterThan(0));
  });

  it("checks a catalog before it replaces the old one", async () => {
    await open("/cashier/settings?tab=catalog");
    const box = await screen.findByLabelText("事件目录 JSON");
    const replace = screen.getByRole("button", { name: "替换事件目录" });
    expect((replace as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: JSON.stringify({ schemaVersion: 1, events: [{ name: "Bad Name" }] }) } });
    fireEvent.click(screen.getByRole("button", { name: "先校验" }));
    await screen.findByText("这份目录有问题：");
    expect((replace as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: JSON.stringify({ schemaVersion: 1, events: [{ name: "fresh.event", description: "A new one." }] }) } });
    fireEvent.click(screen.getByRole("button", { name: "先校验" }));
    await screen.findByText(/校验通过：1 个事件/);
    // Nothing was saved yet.
    expect(document.body.textContent).not.toContain("fresh.event A new one");
    await waitFor(() => expect((replace as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(replace);
    fireEvent.click(await screen.findByRole("button", { name: "替换" }));
    await screen.findByText("A new one.", {}, { timeout: 5000 });
  });

  it("shows who is signed in and the record of what they changed", async () => {
    const made = await h.request("/api/people", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Audited" }) });
    expect(made.status).toBe(201);
    await open("/settings/activity");
    await screen.findByText("新建人员");
    const row = screen.getByText("Audited").closest("tr")!;
    expect(row.textContent).toContain("tester");
    // The sidebar names the user.
    expect(within(screen.getByTitle("当前登录的 Authelia 用户")).getByText("tester")).toBeTruthy();
  });

  it("keeps filter values plain in the address bar", async () => {
    await open("/cashier/overview?days=7&release=r1");
    await screen.findByText("平均会话时长");
    // `days=7` must not turn into `days=%227%22`, which is what the router does to number-like strings by default.
    expect(router.history.location.search).toBe("?days=7&release=r1");
  });

  it("offers Authelia sign-in when the session has ended, and says why a sign-in failed", async () => {
    cleanup();
    queryClient.clear();
    vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => h.request(path, init));
    window.happyDOM.setURL("https://insight.test/cashier/overview?days=7"); // the browser's address, which the page links back to
    await open("/cashier/overview?days=7");
    const link = await screen.findByRole("link", { name: "用 Authelia 登录" });
    // It comes back to the page it was on, and there is no password field.
    expect(link.getAttribute("href")).toBe(`/auth/login?next=${encodeURIComponent("/cashier/overview?days=7")}`);
    expect(screen.queryByLabelText("口令")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    cleanup();
    queryClient.clear();
    window.happyDOM.setURL("https://insight.test/?login_error=forbidden");
    await open("/");
    await screen.findByText("这个账号没有权限使用看板");
    window.happyDOM.setURL("https://insight.test/cashier/overview");
    vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) =>
      h.request(path, { ...init, headers: { ...(init.headers as object), cookie } }),
    );
  });
});
