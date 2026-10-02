// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectAccepted, names, newClient, setVisibility, stubNetwork, type Net } from "./helpers.ts";

let net: Net;
let insight: ReturnType<typeof newClient>;

const click = (el: Element, x = 10, y = 10) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));

const start = (autoCapture: Parameters<typeof newClient>[0] = {}) => {
  insight = newClient({ autoCapture: {}, ...autoCapture });
  return insight;
};

const sent = async () => {
  await insight.flush();
  return net.posts.flatMap((p) => p.body.events);
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-02T08:00:00.000Z") });
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  net = stubNetwork();
});
afterEach(() => {
  insight?.setEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("taps", () => {
  it("records a tap on a marked control with the data-track name, never its text", async () => {
    document.body.innerHTML = `<button data-track="topbar.period_next">下个月 secret text</button>`;
    start();
    click(document.querySelector("button")!);
    const events = await sent();
    const tap = events.find((e) => e.name === "$tap")!;
    expect(tap.props).toEqual({ target: "topbar.period_next" });
    expect(JSON.stringify(events)).not.toContain("secret text");
    expectAccepted(net.posts[0]!.body);
  });

  it("falls back to aria-label, then role, then the tag; and uses the nearest data-track of an ancestor", async () => {
    document.body.innerHTML = `
      <button id="a" aria-label="关闭">x</button>
      <div id="b" role="button">y</div>
      <a id="c" href="#">z</a>
      <div data-track="card.row"><button id="d">inner</button></div>`;
    start();
    for (const id of ["a", "b", "c", "d"]) click(document.getElementById(id)!);
    const targets = (await sent()).filter((e) => e.name === "$tap").map((e) => e.props.target);
    expect(targets).toEqual(["关闭", "button", "a", "card.row"]);
  });

  it("ignores taps on plain text and empty space", async () => {
    document.body.innerHTML = `<p id="t">just text</p>`;
    start();
    click(document.getElementById("t")!);
    expect(names(await sent())).not.toContain("$tap");
  });

  it("counts an element that only shows cursor: pointer as tappable", async () => {
    document.body.innerHTML = `<div id="x" style="cursor: pointer">card</div>`;
    start();
    click(document.getElementById("x")!);
    expect(names(await sent())).toContain("$tap");
  });

  it("stays off when taps is false", async () => {
    document.body.innerHTML = `<button>go</button>`;
    start({ autoCapture: { taps: false, dead: false, rage: false } });
    click(document.querySelector("button")!);
    expect(names(await sent())).not.toContain("$tap");
  });
});

describe("rage taps", () => {
  it("records three taps within 800 ms and 30 px as one rage tap", async () => {
    document.body.innerHTML = `<button data-track="save.button">save</button>`;
    start({ autoCapture: { dead: false } });
    const b = document.querySelector("button")!;
    click(b, 100, 100);
    await vi.advanceTimersByTimeAsync(200);
    click(b, 104, 98);
    await vi.advanceTimersByTimeAsync(200);
    click(b, 99, 103);
    await vi.advanceTimersByTimeAsync(300);
    click(b, 101, 101);
    await vi.advanceTimersByTimeAsync(900);
    const rage = (await sent()).filter((e) => e.name === "$rage_tap");
    expect(rage).toHaveLength(1);
    expect(rage[0].props).toEqual({ target: "save.button", count: 4 });
    expectAccepted(net.posts[0]!.body);
  });

  it("does not count slow taps or taps far apart", async () => {
    document.body.innerHTML = `<button>a</button>`;
    start({ autoCapture: { dead: false } });
    const b = document.querySelector("button")!;
    for (let i = 0; i < 4; i++) {
      click(b, 10, 10);
      await vi.advanceTimersByTimeAsync(900);
    }
    click(b, 10, 10);
    click(b, 200, 200);
    click(b, 400, 400);
    await vi.advanceTimersByTimeAsync(1000);
    expect(names(await sent())).not.toContain("$rage_tap");
  });
});

describe("dead taps", () => {
  it("records a tap on a button after which nothing changed for a second", async () => {
    document.body.innerHTML = `<button data-track="stats.export">export</button>`;
    start({ autoCapture: { rage: false } });
    click(document.querySelector("button")!);
    await vi.advanceTimersByTimeAsync(1100);
    const dead = (await sent()).filter((e) => e.name === "$dead_tap");
    expect(dead).toHaveLength(1);
    expect(dead[0].props).toEqual({ target: "stats.export" });
    expectAccepted(net.posts[0]!.body);
  });

  it("does not when the page changes in the second after the tap", async () => {
    document.body.innerHTML = `<button id="b">open</button>`;
    start({ autoCapture: { rage: false } });
    document.getElementById("b")!.addEventListener("click", () => setTimeout(() => document.body.append(document.createElement("div")), 300));
    click(document.getElementById("b")!);
    await vi.advanceTimersByTimeAsync(1100);
    expect(names(await sent())).not.toContain("$dead_tap");
  });

  it("does not when the URL or the focus changes", async () => {
    document.body.innerHTML = `<button id="a">go</button><button id="b">focus</button>`;
    start({ autoCapture: { rage: false, screens: false } });
    document.getElementById("a")!.addEventListener("click", () => history.pushState(null, "", "/next"));
    click(document.getElementById("a")!);
    document.getElementById("b")!.addEventListener("click", () => (document.getElementById("b") as HTMLElement).focus());
    click(document.getElementById("b")!);
    await vi.advanceTimersByTimeAsync(1100);
    expect(names(await sent())).not.toContain("$dead_tap");
  });

  it("does not for text, inputs, disabled controls or downloads", async () => {
    document.body.innerHTML = `
      <p id="p">text</p><input id="i" /><button id="d" disabled>off</button><a id="l" href="/f.csv" download>csv</a>`;
    start({ autoCapture: { rage: false } });
    for (const id of ["p", "i", "d", "l"]) click(document.getElementById(id)!);
    await vi.advanceTimersByTimeAsync(1100);
    expect(names(await sent())).not.toContain("$dead_tap");
  });
});

describe("errors", () => {
  it("records an uncaught error with the first frame's file and line, without host or query", async () => {
    start();
    window.dispatchEvent(
      new ErrorEvent("error", { message: "x is not a function", filename: "https://app.example/_next/static/chunks/app.js?v=3", lineno: 42 }),
    );
    const error = (await sent()).find((e) => e.name === "$error")!;
    expect(error.props).toEqual({ kind: "exception", message: "x is not a function", source: "app.js:42" });
    expectAccepted(net.posts[0]!.body);
  });

  it("records an unhandled rejection from the stack", async () => {
    start();
    const reason = new Error("fetch failed");
    reason.stack = "Error: fetch failed\n    at load (https://app.example/assets/main-abc.js:10:5)\n    at run (https://app.example/assets/main-abc.js:20:1)";
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    event.reason = reason;
    window.dispatchEvent(event);
    const error = (await sent()).find((e) => e.name === "$error")!;
    expect(error.props).toEqual({ kind: "rejection", message: "fetch failed", source: "main-abc.js:10" });
  });

  it("cuts long messages, ignores repeats and stops at ten", async () => {
    start();
    const fire = (message: string) => window.dispatchEvent(new ErrorEvent("error", { message, filename: "a.js", lineno: 1 }));
    fire("y".repeat(500));
    fire("same");
    fire("same");
    for (let i = 0; i < 20; i++) fire(`distinct ${i}`);
    const errors = (await sent()).filter((e) => e.name === "$error");
    expect(errors).toHaveLength(10);
    expect(errors[0].props.message).toHaveLength(200);
    expect(errors.filter((e) => e.props.message === "same")).toHaveLength(1);
  });
});

describe("screens", () => {
  it("records the first screen and each history change with where it came from", async () => {
    start();
    history.pushState(null, "", "/records?x=1");
    history.replaceState(null, "", "/stats");
    history.pushState(null, "", "/stats?tab=2"); // same pathname: not a new screen
    window.dispatchEvent(new PopStateEvent("popstate"));
    const screens = (await sent()).filter((e) => e.name === "$screen").map((e) => e.props);
    expect(screens).toEqual([
      { screen: "/", via: "app" },
      { screen: "/records", from: "/", via: "push" },
      { screen: "/stats", from: "/records", via: "replace" },
    ]);
    expectAccepted(net.posts[0]!.body);
  });

  it("records back navigation", async () => {
    start();
    history.pushState(null, "", "/a");
    // What the browser does on Back: the URL changes without going through the patched methods.
    Object.getPrototypeOf(history).replaceState.call(history, null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const last = (await sent()).filter((e) => e.name === "$screen").at(-1)!;
    expect(last.props).toEqual({ screen: "/", from: "/a", via: "back" });
  });

  it("puts history back when disabled", () => {
    const original = history.pushState;
    start();
    expect(history.pushState).not.toBe(original);
    insight.setEnabled(false);
    expect(history.pushState).toBe(original);
  });

  it("stays out of history when screens is false", () => {
    const original = history.pushState;
    start({ autoCapture: { screens: false } });
    expect(history.pushState).toBe(original);
  });
});

describe("visibility", () => {
  it("records hidden with the foreground time, then visible", async () => {
    start();
    await vi.advanceTimersByTimeAsync(4000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("visible");
    const vis = [...net.beacons.flatMap((b) => b.body.events), ...(await sent())].filter((e) => e.name === "$visibility");
    expect(vis.map((e) => e.props.state)).toEqual(["hidden", "visible"]);
    expect(vis[0].props.activeMs).toBe(4000);
  });

  it("flushes through sendBeacon the moment the page is hidden", () => {
    start();
    setVisibility("hidden");
    expect(net.beacons.length).toBeGreaterThan(0);
    expect(net.beacons[0]!.url).toBe("/api/telemetry");
  });

  it("does not record visibility when turned off, but still hands events over", () => {
    start({ autoCapture: { visibility: false } });
    setVisibility("hidden");
    expect(net.beacons.flatMap((b) => b.body.events).some((e) => e.name === "$visibility")).toBe(false);
    expect(net.beacons.length).toBeGreaterThan(0);
  });
});

describe("session start", () => {
  it("records the entry route and how the page was reached", async () => {
    history.replaceState(null, "", "/records");
    start();
    const first = (await sent())[0]!;
    expect(first.name).toBe("$session_start");
    expect(first.props).toEqual({ entry: "/records", navType: "navigate" });
    expectAccepted(net.posts[0]!.body);
  });
});

describe("autoCapture: false", () => {
  it("records nothing by itself", async () => {
    document.body.innerHTML = `<button>go</button>`;
    insight = newClient({ autoCapture: false });
    click(document.querySelector("button")!);
    history.pushState(null, "", "/x");
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "a.js", lineno: 1 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sent()).toEqual([]);
  });
});
