import { z } from "zod";

/**
 * Standard events start with `$`. They are grouped into profiles, so a client
 * only has to know the profile that fits its platform:
 *
 * - `core`: every platform. Frozen once the first release ships.
 * - `web`: produced by the web SDK's auto-capture.
 * - `experimental`: designed from a single app. Props may still change inside
 *   v1; extra props are always accepted.
 *
 * Props are validated loosely: required keys must be right, extra keys pass.
 */
export type StandardProfile = "core" | "web" | "experimental";

export interface StandardEventSpec {
  profile: StandardProfile;
  description: string;
  props: z.ZodType;
}

const text = (max: number) => z.string().max(max);
const target = text(200);

export const STANDARD_EVENTS = {
  $session_start: {
    profile: "core",
    description:
      "A session began. A web session ends after 30 minutes without foreground activity; a background program's session is one process run (`appStart` maps here with navType=launch).",
    props: z.looseObject({
      entry: text(200).optional(),
      navType: z.enum(["navigate", "reload", "back_forward", "launch"]).optional(),
    }),
  },
  $error: {
    profile: "core",
    description:
      "An error the user may have hit. `kind` is a short label: exception, rejection, boundary, http, native. `message` is cut to 200 characters and long digit runs are masked.",
    props: z.looseObject({
      kind: text(64),
      message: text(200).optional(),
      source: text(200).optional(),
    }),
  },
  $visibility: {
    profile: "web",
    description: "The page was hidden or shown. `activeMs` is real foreground time since the last change.",
    props: z.looseObject({
      state: z.enum(["hidden", "visible"]),
      activeMs: z.number().nonnegative().optional(),
    }),
  },
  $screen: {
    profile: "web",
    description: "A screen or route was entered.",
    props: z.looseObject({
      screen: text(200),
      from: text(200).optional(),
      via: z.enum(["push", "replace", "back", "link", "app"]).optional(),
    }),
  },
  $tap: {
    profile: "web",
    description:
      "A click or tap. `target` is the `data-track` value, `aria-label` or element role; never the element's text.",
    props: z.looseObject({ target }),
  },
  $rage_tap: {
    profile: "web",
    description: "Three or more taps within 800 ms inside a 30 px radius: the user is hurrying.",
    props: z.looseObject({ target, count: z.int().min(2) }),
  },
  $dead_tap: {
    profile: "web",
    description:
      "A tap on something that looks tappable, after which nothing changed within one second (no DOM change, no URL change, no focus change).",
    props: z.looseObject({ target }),
  },
  $vital: {
    profile: "web",
    description: "A web vital measurement.",
    props: z.looseObject({
      metric: z.enum(["LCP", "INP", "CLS", "FCP", "TTFB"]),
      value: z.number(),
      rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
      screen: text(200).optional(),
    }),
  },
  $op: {
    profile: "experimental",
    description:
      "An operation that takes time: a save, a request, an upload. Lets the dashboard compute p50/p95 and a failure rate for every app alike.",
    props: z.looseObject({
      op: text(64),
      ms: z.number().nonnegative(),
      ok: z.boolean(),
      errorKind: text(64).optional(),
    }),
  },
  $dialog: {
    profile: "experimental",
    description: "A dialog or overlay opened or closed. Shows dialogs that are opened and then cancelled.",
    props: z.looseObject({
      dialog: text(64),
      action: z.enum(["open", "close"]),
      closeBy: text(64).optional(),
      openMs: z.number().nonnegative().optional(),
    }),
  },
  $toast: {
    profile: "experimental",
    description: "A message the user was shown, usually an error. `message` is the app's own wording.",
    props: z.looseObject({
      level: text(32),
      message: text(200).optional(),
    }),
  },
} as const satisfies Record<string, StandardEventSpec>;

export type StandardEventName = keyof typeof STANDARD_EVENTS;

export function isStandardEventName(name: string): name is StandardEventName {
  return Object.hasOwn(STANDARD_EVENTS, name);
}
