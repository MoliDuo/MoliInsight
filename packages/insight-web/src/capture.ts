import { cut, safe } from "./util.ts";
import type { Props } from "./types.ts";

export type Emit = (name: string, props?: Props) => void;

/** What a person sees on a control, never its text: data-track, then aria-label, then role or tag. */
const label = (el: Element): string =>
  cut(
    el.closest("[data-track]")?.getAttribute("data-track") ||
      el.closest("[aria-label]")?.getAttribute("aria-label") ||
      el.getAttribute("role") ||
      el.tagName.toLowerCase(),
  );

const INTERACTIVE =
  'a[href],button,summary,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=option],[data-track]';

/** The element that looks clickable, if any: by markup, then an inline handler or `cursor: pointer`. */
const clickable = (target: Element): Element | null => {
  const marked = target.closest(INTERACTIVE);
  if (marked) return marked;
  let el: Element | null = target;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    if ((el as HTMLElement).onclick || getComputedStyle(el).cursor === "pointer") return el;
  }
  return null;
};

/** Inputs change focus or state by themselves, and a disabled control is meant to do nothing. */
const canBeDead = (el: Element): boolean =>
  !el.matches("input,select,textarea,[download],[disabled],[aria-disabled=true]");

const RAGE_MS = 800;
const RAGE_PX = 30;
const DEAD_MS = 1000;

export interface ClickOptions {
  taps: boolean;
  rage: boolean;
  dead: boolean;
}

/** `$tap`, `$rage_tap` and `$dead_tap` from one click listener. */
export function captureClicks(emit: Emit, o: ClickOptions): () => void {
  let recent: { t: number; x: number; y: number }[] = [];
  let rageTimer: ReturnType<typeof setTimeout> | undefined;

  const onClick = safe((e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const hit = clickable(e.target);
    const target = label(hit ?? e.target);

    if (o.taps && hit) emit("$tap", { target });

    if (o.rage) {
      const t = performance.now();
      recent = recent.filter((c) => t - c.t < RAGE_MS && Math.hypot(c.x - e.clientX, c.y - e.clientY) <= RAGE_PX);
      recent.push({ t, x: e.clientX, y: e.clientY });
      if (recent.length >= 3) {
        const count = recent.length;
        clearTimeout(rageTimer);
        rageTimer = setTimeout(
          safe(() => {
            emit("$rage_tap", { target, count });
            recent = [];
          }),
          RAGE_MS,
        );
      }
    }

    if (o.dead && hit && canBeDead(hit)) {
      const href = location.href;
      const focus = document.activeElement;
      let changed = false;
      const watcher = new MutationObserver(() => (changed = true));
      watcher.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(
        safe(() => {
          watcher.disconnect();
          if (!changed && location.href === href && document.activeElement === focus) emit("$dead_tap", { target });
        }),
        DEAD_MS,
      );
    }
  });

  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    clearTimeout(rageTimer);
  };
}

/** The first `file:line` of a stack or a location, without the host or the query. */
const where = (text: unknown): string | undefined => {
  const m = typeof text === "string" ? /([^/\s?#]+)(?:[?#]\S*?)?:(\d+):\d+\)?\s*$/m.exec(text) : null;
  return m ? `${m[1]}:${m[2]}` : undefined;
};

const MAX_ERRORS = 10;

/** `$error` from uncaught errors and unhandled rejections: at most ten a page load, no repeats. */
export function captureErrors(emit: Emit): () => void {
  const seen = new Set<string>();
  const report = (kind: string, message: string, source: string | undefined) => {
    const key = `${kind}|${message}`;
    if (seen.has(key) || seen.size >= MAX_ERRORS) return;
    seen.add(key);
    emit("$error", { kind, message: cut(message), ...(source ? { source } : {}) });
  };
  const onError = safe((e: ErrorEvent) =>
    report("exception", e.message || String(e.error), where(`${e.filename}:${e.lineno}:0`) ?? where(e.error?.stack)),
  );
  const onRejection = safe((e: PromiseRejectionEvent) => {
    const r = e.reason;
    report("rejection", r instanceof Error ? r.message : String(r), where(r?.stack));
  });
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  return () => {
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
  };
}

/** `$screen` from history changes, plus the first screen. */
export function captureScreens(emit: Emit, first: boolean): () => void {
  let from = location.pathname;
  const go = (via: string) => {
    const to = location.pathname;
    if (to === from) return;
    emit("$screen", { screen: cut(to), from: cut(from), via });
    from = to;
  };

  const restores = (["pushState", "replaceState"] as const).map((method) => {
    const original = history[method];
    const via = method === "pushState" ? "push" : "replace";
    const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      safe(go)(via);
      return result;
    };
    history[method] = wrapped;
    // Another library may have wrapped it on top of ours; leave theirs alone.
    return () => {
      if (history[method] === wrapped) history[method] = original;
    };
  });
  const onPop = safe(() => go("back"));
  addEventListener("popstate", onPop);

  if (first) emit("$screen", { screen: cut(from), via: "app" });
  return () => {
    restores.forEach((restore) => restore());
    removeEventListener("popstate", onPop);
  };
}
