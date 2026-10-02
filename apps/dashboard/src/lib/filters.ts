// The controls that apply to every data page. They live in the URL, so a view can be shared.

export interface Filters {
  days?: string;
  from?: string;
  to?: string;
  platform?: string;
  release?: string;
  person?: string;
}

export const RANGES: [string, string][] = [
  ["7", "近 7 天"],
  ["30", "近 30 天"],
  ["90", "近 90 天"],
  ["180", "近 180 天"],
  ["custom", "自定义"],
];

const text = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

export function validateFilters(search: Record<string, unknown>): Filters {
  return {
    days: text(search.days),
    from: text(search.from),
    to: text(search.to),
    platform: text(search.platform),
    release: text(search.release),
    person: text(search.person),
  };
}

type Extra = Record<string, string | number | undefined | null>;

/** The query string the dashboard API expects. A custom range needs both dates. */
export function toQuery(f: Filters, extra: Extra = {}): string {
  const q = new URLSearchParams();
  if (f.days === "custom" && f.from && f.to) {
    q.set("from", f.from);
    q.set("to", f.to);
  } else {
    q.set("days", f.days === "custom" || !f.days ? "30" : f.days);
  }
  for (const key of ["platform", "release", "person"] as const) if (f[key]) q.set(key, f[key]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
}

/** The same range, shifted back by its own length. Used for "versus the period before". */
export function previousRange(f: Filters, range: { from: string; to: string }): Filters {
  const day = 86_400_000;
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  const length = Math.round((to - from) / day) + 1;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { ...f, days: "custom", from: iso(from - length * day), to: iso(from - day) };
}
