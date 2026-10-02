import { LIMITS } from "./limits.ts";

/** Cuts a string to a number of characters (code points), not UTF-16 units. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

/**
 * Removes query values from a route: `/records?id=42&new` becomes
 * `/records?id&new`. The fragment is dropped. Routes should carry templates and
 * overlay markers only, and this is the net under that rule.
 */
export function scrubRoute(route: string): string {
  const hash = route.indexOf("#");
  const withoutHash = hash === -1 ? route : route.slice(0, hash);
  const question = withoutHash.indexOf("?");
  if (question === -1) return withoutHash;
  const path = withoutHash.slice(0, question);
  const keys = withoutHash
    .slice(question + 1)
    .split("&")
    .map((pair) => pair.split("=")[0] ?? "")
    .filter((key) => key !== "");
  return keys.length > 0 ? `${path}?${keys.join("&")}` : path;
}

/**
 * Masks runs of four or more digits in free text such as error messages,
 * where they are usually ids or amounts. Short numbers such as HTTP status
 * codes stay. Best effort: clients must still keep data out of messages.
 */
export function maskDigitRuns(text: string): string {
  return text.replace(/\d{4,}/g, "#");
}

/** Prop keys whose string values are free text and get digit masking. */
const FREE_TEXT_KEYS = new Set(["message", "error"]);

/**
 * Cuts every string in a props value to the length limit, and masks digit
 * runs in strings under free-text keys. Returns a new value.
 */
export function scrubProps<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    const cut = truncate(value, LIMITS.propStringMaxLength);
    return (key !== undefined && FREE_TEXT_KEYS.has(key) ? maskDigitRuns(cut) : cut) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubProps(item, key)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubProps(v, k);
    return out as T;
  }
  return value;
}
