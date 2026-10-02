// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_ID_STORAGE_KEY, QUEUE_STORAGE_PREFIX } from "../src/types.ts";
import { expectAccepted, names, newClient, setVisibility, stubNetwork, type Net } from "./helpers.ts";

let net: Net;
let clients: ReturnType<typeof newClient>[] = [];
const make = (options: Parameters<typeof newClient>[0] = {}) => {
  const c = newClient(options);
  clients.push(c);
  return c;
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-02T08:00:00.000Z") });
  localStorage.clear();
  sessionStorage.clear();
  net = stubNetwork();
});
afterEach(() => {
  clients.forEach((c) => c.setEnabled(false));
  clients = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("recording and sending", () => {
  it("sends a batch the server accepts, with context and a fresh sentAt", async () => {
    const insight = make();
    insight.track("record.submit", { imageCount: 2, nested: { a: 1 } });
    vi.setSystemTime(new Date("2026-10-02T08:00:09.000Z"));
    await insight.flush();

    expect(net.posts).toHaveLength(1);
    const { url, body } = net.posts[0]!;
    expect(url).toBe("/api/telemetry");
    expect(body.sentAt).toBe("2026-10-02T08:00:09.000Z");
    expect(body.context).toMatchObject({ platform: "web", release: "abc123", deviceClass: "desktop" });
    expect(body.context.deviceId).toMatch(/^dev_[A-Za-z0-9]{20}$/);
    expect(names(body.events)).toEqual(["$session_start", "record.submit"]);
    expect(body.events[1]).toMatchObject({
      name: "record.submit",
      occurredAt: "2026-10-02T08:00:00.000Z",
      props: { imageCount: 2, nested: { a: 1 } },
    });
    expectAccepted(body);
  });

  it("sends nothing when the queue is empty", async () => {
    const insight = make();
    await insight.flush();
    expect(net.posts).toHaveLength(0);
  });

  it("sends on a timer every 15 seconds", async () => {
    const insight = make();
    insight.track("a.b");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(net.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(net.posts).toHaveLength(1);
  });

  it("sends at once when 50 events are queued, and splits at 100 per request", async () => {
    const insight = make();
    for (let i = 0; i < 48; i++) insight.track("x.y");
    expect(net.posts).toHaveLength(0); // 48 events and the $session_start
    insight.track("x.y");
    await vi.advanceTimersByTimeAsync(0);
    expect(net.posts).toHaveLength(1);

    net.posts.length = 0;
    const big = make();
    for (let i = 0; i < 49; i++) big.track("x.y");
    net.script.push(new Response(null, { status: 500 }));
    await big.flush();
    for (let i = 0; i < 150; i++) big.track("x.y");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    net.posts.length = 0;
    await big.flush();
    expect(net.posts.map((p) => p.body.events.length).every((n) => n <= 100)).toBe(true);
  });

  it("keeps batches under the size the server accepts", async () => {
    const insight = make();
    const text = "x".repeat(190);
    for (let i = 0; i < 90; i++) insight.track("big.event", { a: text, b: text, c: text, d: text, e: text, f: text, g: text, h: text, i: text, j: text, k: text, l: text, m: text, n: text, o: text, p: text, q: text, r: text, s: text, t: text });
    await insight.flush();
    for (const post of net.posts) expect(JSON.stringify(post.body).length).toBeLessThanOrEqual(60_000);
    expect(net.posts.length).toBeGreaterThan(1);
  });

  it("drops the oldest events beyond 500", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 503 }));
    insight.track("first.event");
    await insight.flush();
    for (let i = 0; i < 600; i++) insight.track("later.event", { i });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    net.posts.length = 0;
    await insight.flush();
    const all = net.posts.flatMap((p) => p.body.events);
    expect(all).toHaveLength(500);
    expect(names(all)).not.toContain("first.event");
  });
});

describe("failures", () => {
  it("keeps the queue on 401 and tries again after a minute", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 401 }));
    insight.track("a.b");
    await insight.flush();
    expect(net.posts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000); // timers fire, but the pause holds
    expect(net.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(net.posts).toHaveLength(2);
    expect(names(net.posts[1]!.body.events)).toContain("a.b");
  });

  it("waits as long as Retry-After says on 429", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    insight.track("a.b");
    await insight.flush();
    await vi.advanceTimersByTimeAsync(105_000);
    expect(net.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(net.posts).toHaveLength(2);
  });

  it("backs off further on each 5xx and network error, and recovers", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 502 }), new Error("offline"), new Response(null, { status: 503 }));
    insight.track("a.b");
    await insight.flush(); // fails: wait 15 s
    await vi.advanceTimersByTimeAsync(16_000); // retry fails: wait 30 s
    expect(net.posts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(net.posts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(11_000); // third fails: wait 60 s
    expect(net.posts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(61_000); // succeeds
    expect(net.posts).toHaveLength(4);
    net.posts.length = 0;
    insight.track("c.d");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(net.posts).toHaveLength(1);
    expect(names(net.posts[0]!.body.events)).toEqual(["c.d"]);
  });

  it("drops a batch the server will never take (other 4xx)", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 400 }));
    insight.track("a.b");
    await insight.flush();
    net.posts.length = 0;
    await insight.flush();
    expect(net.posts).toHaveLength(0);
  });

  it("never throws, even when fetch itself blows up", async () => {
    const insight = make();
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    insight.track("a.b");
    await expect(insight.flush()).resolves.toBeUndefined();
  });
});

describe("storage and tabs", () => {
  it("writes the queue to this tab's own key when the page is hidden, and hands it to sendBeacon", () => {
    const insight = make();
    insight.track("a.b");
    net.beaconResult = false;
    setVisibility("hidden");
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(QUEUE_STORAGE_PREFIX));
    expect(keys).toHaveLength(1);
    expect(net.beacons).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(keys[0]!)!).e.length).toBeGreaterThan(0);
    insight.setEnabled(false);
  });

  it("drops events from the queue once sendBeacon took them", () => {
    const insight = make();
    insight.track("a.b");
    setVisibility("hidden");
    expect(net.beacons).toHaveLength(1);
    expect(names(net.beacons[0]!.body.events)).toEqual(["$session_start", "a.b"]);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(QUEUE_STORAGE_PREFIX))).toHaveLength(0);
    expectAccepted(net.beacons[0]!.body);
  });

  it("does not beacon while the server said 401 or 429", async () => {
    const insight = make();
    net.script.push(new Response(null, { status: 401 }));
    insight.track("a.b");
    await insight.flush();
    setVisibility("hidden");
    expect(net.beacons).toHaveLength(0);
    expect(Object.keys(localStorage).some((k) => k.startsWith(QUEUE_STORAGE_PREFIX))).toBe(true);
  });

  it("gets its own queue back after a reload", async () => {
    const first = make();
    net.script.push(new Response(null, { status: 401 }));
    first.track("kept.event");
    await first.flush();
    setVisibility("hidden"); // persists
    first.setEnabled(false); // simulates the page going away (clears its key)... restore below
    // setEnabled(false) is a user choice and clears the queue; model a real reload instead:
    localStorage.setItem(
      `${QUEUE_STORAGE_PREFIX}${sessionStorage.getItem("moli_insight_tab")}`,
      JSON.stringify({ t: Date.now(), e: [{ id: "00000000-0000-4000-8000-000000000001", name: "kept.event", occurredAt: "2026-10-02T07:59:00.000Z", sessionId: "ses_aaaaaaaaaaaa", route: "/" }] }),
    );
    setVisibility("visible");
    const second = make();
    await second.flush();
    expect(net.posts.at(-1)!.body.events.map((e) => e.id)).toContain("00000000-0000-4000-8000-000000000001");
  });

  it("adopts the queue of a closed tab, but not that of a tab that is still open", async () => {
    const stale = [{ id: "00000000-0000-4000-8000-0000000000aa", name: "old.tab", occurredAt: "2026-10-02T07:50:00.000Z", sessionId: "ses_aaaaaaaaaaaa", route: "/" }];
    const live = [{ id: "00000000-0000-4000-8000-0000000000bb", name: "live.tab", occurredAt: "2026-10-02T07:59:50.000Z", sessionId: "ses_bbbbbbbbbbbb", route: "/" }];
    localStorage.setItem(`${QUEUE_STORAGE_PREFIX}closedtab`, JSON.stringify({ t: Date.now() - 5 * 60_000, e: stale }));
    localStorage.setItem(`${QUEUE_STORAGE_PREFIX}opentab`, JSON.stringify({ t: Date.now() - 5_000, e: live }));
    const insight = make();
    await insight.flush();
    const sent = net.posts.flatMap((p) => p.body.events.map((e) => e.name));
    expect(sent).toContain("old.tab");
    expect(sent).not.toContain("live.tab");
    expect(localStorage.getItem(`${QUEUE_STORAGE_PREFIX}closedtab`)).toBeNull();
    expect(localStorage.getItem(`${QUEUE_STORAGE_PREFIX}opentab`)).not.toBeNull();
  });

  it("survives storage that throws", async () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, length: 0 });
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    const insight = make();
    insight.track("a.b");
    setVisibility("hidden");
    await insight.flush();
    expect(insight.getDeviceId()).toBeUndefined();
    expect(net.posts.length + net.beacons.length).toBeGreaterThan(0);
  });
});

describe("identity", () => {
  it("keeps one device id under the documented key", () => {
    const insight = make();
    const id = insight.getDeviceId();
    expect(id).toMatch(/^dev_/);
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
    expect(make().getDeviceId()).toBe(id);
  });

  it("keeps the session across a reload, starts a new one after 30 idle minutes, and shares it between tabs", async () => {
    const a = make();
    a.track("one.event");
    await a.flush();
    const session = net.posts[0]!.body.events[0].sessionId as string;

    vi.setSystemTime(Date.now() + 5 * 60_000);
    const reloaded = make(); // same storage: the reload
    reloaded.track("two.event");
    await reloaded.flush();
    const second = net.posts.at(-1)!.body.events;
    expect(second.every((e) => e.sessionId === session)).toBe(true);
    expect(names(second)).not.toContain("$session_start");

    vi.setSystemTime(Date.now() + 31 * 60_000);
    reloaded.track("three.event");
    await reloaded.flush();
    const third = net.posts.at(-1)!.body.events;
    expect(names(third)).toEqual(["$session_start", "three.event"]);
    expect(third[0].sessionId).not.toBe(session);
    expect(third[0].props.navType).toBe("navigate");
  });
});

describe("the API", () => {
  it("times an operation, once", async () => {
    const insight = make();
    const op = insight.startOp("save");
    vi.setSystemTime(Date.now() + 250);
    await vi.advanceTimersByTimeAsync(250);
    op.end({ ok: false, errorKind: "network", props: { retries: 1 } });
    op.end({ ok: true });
    await insight.flush();
    const events = net.posts[0]!.body.events.filter((e) => e.name === "$op");
    expect(events).toHaveLength(1);
    expect(events[0].props).toMatchObject({ op: "save", ok: false, errorKind: "network", retries: 1 });
    expect(events[0].props.ms).toBeGreaterThanOrEqual(250);
    expectAccepted(net.posts[0]!.body);
  });

  it("records dialogs with how long they were open, and web vitals", async () => {
    const insight = make();
    insight.trackDialog("record-detail", "open");
    await vi.advanceTimersByTimeAsync(1200);
    insight.trackDialog("record-detail", "close", { closeBy: "backdrop" });
    insight.reportVital({ name: "LCP", value: 2400.5, rating: "good" });
    insight.trackScreen("/stats", "push");
    await insight.flush();
    const events = net.posts[0]!.body.events;
    expect(events.find((e) => e.props?.action === "close")!.props).toMatchObject({ dialog: "record-detail", closeBy: "backdrop", openMs: 1200 });
    expect(events.find((e) => e.name === "$vital")!.props).toMatchObject({ metric: "LCP", value: 2400.5, rating: "good" });
    expect(events.find((e) => e.name === "$screen")!.props).toEqual({ screen: "/stats", via: "push" });
    expectAccepted(net.posts[0]!.body);
  });

  it("does nothing while disabled, and starts and stops on setEnabled", async () => {
    const insight = make({ enabled: false });
    insight.track("a.b");
    await insight.flush();
    expect(net.posts).toHaveLength(0);
    expect(localStorage.length).toBe(0);

    insight.setEnabled(true);
    insight.track("c.d");
    await insight.flush();
    expect(names(net.posts[0]!.body.events)).toContain("c.d");

    insight.setEnabled(false);
    net.posts.length = 0;
    insight.track("e.f");
    await insight.flush();
    expect(net.posts).toHaveLength(0);
  });

  it("ignores a second init", async () => {
    const insight = make();
    insight.init({ endpoint: "/elsewhere", release: "other" });
    insight.track("a.b");
    await insight.flush();
    expect(net.posts[0]!.url).toBe("/api/telemetry");
  });

  it("does not let a throwing call escape", () => {
    const insight = make();
    expect(() => insight.track(undefined as unknown as string)).not.toThrow();
    expect(() => insight.trackScreen(undefined as unknown as string)).not.toThrow();
    expect(() => insight.startOp(undefined as unknown as string).end({ ok: true })).not.toThrow();
  });
});
