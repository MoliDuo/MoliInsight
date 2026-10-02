import { buildContext } from "./context.ts";
import { captureClicks, captureErrors, captureScreens, type Emit } from "./capture.ts";
import { fit, post, type WireEvent } from "./transport.ts";
import {
  DEVICE_ID_STORAGE_KEY,
  QUEUE_STORAGE_PREFIX,
  STORAGE_KEY_PREFIX,
  type InitOptions,
  type InsightWeb,
  type OpHandle,
  type Props,
  type ScreenVia,
  type VitalMetric,
} from "./types.ts";
import { cut, inBrowser, local, newId, read, readJson, safe, session, uuid, write } from "./util.ts";

const SESSION_KEY = `${STORAGE_KEY_PREFIX}session`;
const TAB_KEY = `${STORAGE_KEY_PREFIX}tab`;
/** A session ends after this long without foreground activity. */
const IDLE_MS = 30 * 60_000;
const FLUSH_EVERY_MS = 15_000;
const FLUSH_AT = 50;
const MAX_QUEUE = 500;
/** A queue untouched for this long belongs to a tab that is gone. */
const ORPHAN_MS = 120_000;
const SESSION_WRITE_MS = 10_000;

/** Everything the SDK does, in one closure. `index.ts` makes the one instance apps use. */
export function createClient(): InsightWeb {
  let options: InitOptions | undefined;
  let on = false;
  let queue: WireEvent[] = [];
  let dirty = false;
  let inflight: Promise<void> | undefined;
  let blockedUntil = 0;
  let fails = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stops: (() => void)[] = [];
  let tabId = "";
  let deviceId: string | undefined;
  let sessionId = "";
  let lastActive = 0;
  let persistedAt = 0;
  let first = true;
  let visible = true;
  let visibleSince = 0;
  const dialogs: Record<string, number | undefined> = {};

  // -- identity ------------------------------------------------------------

  const ensureDeviceId = (): string | undefined => {
    const ls = local();
    let id = read(ls, DEVICE_ID_STORAGE_KEY);
    if (!id && ls) {
      id = newId("dev_");
      write(ls, DEVICE_ID_STORAGE_KEY, id);
      // An id that cannot be kept would look like a new device on every load.
      if (read(ls, DEVICE_ID_STORAGE_KEY) !== id) id = undefined;
    }
    return id;
  };

  /** Returns true when this call started a new session. */
  const touch = (t: number): boolean => {
    let fresh = false;
    if (!sessionId || t - lastActive > IDLE_MS) {
      // Another tab may have been active meanwhile: the session is shared.
      const [id, at] = (read(local(), SESSION_KEY) ?? "").split(".");
      if (id && t - Number(at) <= IDLE_MS) sessionId = id;
      else {
        sessionId = newId("ses_");
        fresh = true;
      }
    }
    lastActive = t;
    if (fresh || t - persistedAt > SESSION_WRITE_MS) {
      persistedAt = t;
      write(local(), SESSION_KEY, `${sessionId}.${t}`);
    }
    return fresh;
  };

  const navType = (): string => {
    const type = (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    return type === "reload" || type === "back_forward" ? type : "navigate";
  };

  // -- queue ---------------------------------------------------------------

  const persist = () => {
    const ls = local();
    if (!ls || !tabId) return;
    write(ls, QUEUE_STORAGE_PREFIX + tabId, queue.length ? JSON.stringify({ t: Date.now(), e: queue }) : null);
    dirty = false;
  };

  /** Takes back this tab's queue after a reload, and the queues of tabs that closed with events unsent. */
  const restore = () => {
    const ls = local();
    if (!ls) return;
    const keys = Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k): k is string => !!k?.startsWith(QUEUE_STORAGE_PREFIX));
    for (const key of keys) {
      const saved = readJson(ls, key) as { t?: number; e?: WireEvent[] } | undefined;
      const mine = key === QUEUE_STORAGE_PREFIX + tabId;
      if (!mine && saved && Date.now() - (saved.t ?? 0) <= ORPHAN_MS) continue; // a tab that is still open
      if (Array.isArray(saved?.e)) queue.unshift(...saved.e);
      write(ls, key, null);
    }
    dirty = queue.length > 0;
  };

  const body = (events: WireEvent[]) => ({
    schemaVersion: 1,
    sentAt: new Date().toISOString(),
    context: buildContext(options!.release, deviceId),
    events,
  });

  const run = async (): Promise<void> => {
    try {
      while (on && queue.length) {
        const batch = queue.slice(0, fit(body, queue));
        const outcome = await post(options!.endpoint, body(batch), fails);
        if (outcome.kind === "retry") {
          blockedUntil = Date.now() + outcome.waitMs;
          if (outcome.failed) fails += 1;
          break;
        }
        const gone = new Set(batch.map((e) => e.id));
        queue = queue.filter((e) => !gone.has(e.id));
        dirty = true;
        fails = 0;
        blockedUntil = 0;
      }
    } catch {
      /* never throw into the app */
    } finally {
      inflight = undefined;
      if (dirty) persist();
    }
  };

  /** Sends what is queued. A call made while a send is running waits for that one. */
  const flushNow = (): Promise<void> => (on && options ? (inflight ??= run()) : Promise.resolve());

  const maybeFlush = () => {
    if (queue.length && Date.now() >= blockedUntil) void flushNow();
  };

  // -- recording -----------------------------------------------------------

  const push = (name: string, props: Props | undefined, t: number) => {
    const event: WireEvent = {
      id: uuid(),
      name,
      occurredAt: new Date(t).toISOString(),
      sessionId,
      route: cut(location.pathname),
      ...(props ? { props } : {}),
    };
    queue.push(event);
    dirty = true;
  };

  const emit: Emit = (name, props) => {
    if (!on) return;
    const t = Date.now();
    if (touch(t)) push("$session_start", { entry: cut(location.pathname), navType: first ? navType() : "navigate" }, t);
    first = false;
    push(name, props, t);
    // The oldest go first when the queue is full.
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (queue.length >= FLUSH_AT) maybeFlush();
  };

  // -- page lifecycle ------------------------------------------------------

  const setVisible = (now: boolean, track: boolean) => {
    if (now === visible) return;
    visible = now;
    const t = performance.now();
    if (track) {
      if (now) emit("$visibility", { state: "visible" });
      else emit("$visibility", { state: "hidden", activeMs: Math.round(t - visibleSince) });
    }
    if (now) visibleSince = t;
    else leave();
  };

  /** The page is going away or out of sight: keep what is queued and try to hand it over. */
  const leave = () => {
    persist();
    if (!queue.length || Date.now() < blockedUntil || !options) return;
    // Called from event handlers that are already guarded. What does not fit waits for the next load.
    const n = fit(body, queue);
    const text = JSON.stringify(body(queue.slice(0, n)));
    if (navigator.sendBeacon(options.endpoint, new Blob([text], { type: "application/json" }))) {
      queue.splice(0, n);
      persist();
    }
  };

  let trackVisibility = true;
  const onVisibility = safe(() => setVisible(document.visibilityState !== "hidden", trackVisibility));
  const onPageHide = safe(() => setVisible(false, trackVisibility));

  // -- start and stop ------------------------------------------------------

  const start = () => {
    const ac = options!.autoCapture === false ? {} : options!.autoCapture ?? {};
    const want = (k: keyof typeof ac): boolean => options!.autoCapture !== false && ac[k] !== false;
    trackVisibility = want("visibility");

    deviceId = ensureDeviceId();
    const ss = session();
    tabId = read(ss, TAB_KEY) ?? newId("");
    write(ss, TAB_KEY, tabId);
    restore();
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

    on = true;
    first = true;
    visible = document.visibilityState !== "hidden";
    visibleSince = performance.now();

    if (want("taps") || want("rage") || want("dead")) {
      stops.push(captureClicks(emit, { taps: want("taps"), rage: want("rage"), dead: want("dead") }));
    }
    if (want("errors")) stops.push(captureErrors(emit));
    if (want("screens")) stops.push(captureScreens(emit, true));

    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("pagehide", onPageHide);
    stops.push(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pagehide", onPageHide);
    });

    timer = setInterval(
      safe(() => {
        if (dirty) persist();
        maybeFlush();
      }),
      FLUSH_EVERY_MS,
    );
    maybeFlush();
  };

  const stop = () => {
    on = false;
    stops.forEach((s) => safe(s)());
    stops = [];
    clearInterval(timer);
    queue = [];
    dirty = false;
    write(local(), QUEUE_STORAGE_PREFIX + tabId, null);
  };

  // -- the public API ------------------------------------------------------

  return {
    init: safe((o: InitOptions) => {
      if (!inBrowser() || on) return;
      options = o;
      if (o.enabled !== false) start();
    }),

    track: safe((name: string, props?: Props) => emit(name, props)),

    trackScreen: safe((screen: string, via?: ScreenVia) =>
      emit("$screen", { screen: cut(screen), ...(via ? { via } : {}) }),
    ),

    reportVital: safe((metric: VitalMetric) => {
      emit("$vital", {
        metric: metric.name,
        value: metric.value,
        ...(metric.rating ? { rating: metric.rating } : {}),
        screen: cut(location.pathname),
      });
    }),

    startOp(op: string): OpHandle {
      const began = performance.now();
      let done = false;
      return {
        end: safe((result) => {
          if (done) return;
          done = true;
          emit("$op", {
            ...result.props,
            op: cut(op, 64),
            ms: Math.round(performance.now() - began),
            ok: result.ok,
            ...(result.errorKind ? { errorKind: cut(result.errorKind, 64) } : {}),
          });
        }),
      };
    },

    trackDialog: safe((name: string, action: "open" | "close", opts?: { closeBy?: string }) => {
      const now = performance.now();
      const openedAt = dialogs[name];
      dialogs[name] = action === "open" ? now : undefined;
      emit("$dialog", {
        dialog: cut(name, 64),
        action,
        ...(opts?.closeBy ? { closeBy: cut(opts.closeBy, 64) } : {}),
        ...(action === "close" && openedAt !== undefined ? { openMs: Math.round(now - openedAt) } : {}),
      });
    }),

    flush: flushNow,

    setEnabled: safe((enabled: boolean) => {
      if (!inBrowser() || !options) return;
      if (enabled && !on) start();
      else if (!enabled && on) stop();
    }),

    getDeviceId: () => (inBrowser() ? ensureDeviceId() : undefined),
  };
}
