import { addDays, dayOf, dayStart, daysBetween } from "./days.ts";

/** What the dashboard can narrow a view by. All optional. */
export interface Filters {
  platform?: string;
  release?: string;
  /** A person's id, or "none" for devices that belong to nobody. */
  person?: "none" | number;
  /** A client's device id ("dev_…"). */
  device?: string;
}

export interface Span {
  appId: number;
  /** Local days, both included. */
  from: string;
  to: string;
  offsetMin: number;
}

const rangeMs = (span: Span) => [dayStart(span.from, span.offsetMin), dayStart(addDays(span.to, 1), span.offsetMin)] as const;

/** Builds `AND …` conditions from filters, numbering bound parameters from `first`. */
function conditions(
  filters: Filters,
  columns: { platform: string; release: string; person: string; device: string },
  first: number,
): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  const bind = (value: unknown) => {
    binds.push(value);
    return `?${first + binds.length - 1}`;
  };
  if (filters.platform) parts.push(`${columns.platform} = ${bind(filters.platform)}`);
  if (filters.release) parts.push(`${columns.release} = ${bind(filters.release)}`);
  if (filters.person === "none") parts.push(`${columns.person} IS NULL`);
  else if (filters.person !== undefined) parts.push(`${columns.person} = ${bind(filters.person)}`);
  if (filters.device) parts.push(`${columns.device} = ${bind(filters.device)}`);
  return { sql: parts.map((p) => ` AND ${p}`).join(""), binds };
}

// ---------------------------------------------------------------------------
// overview: sessions and devices

export const DURATION_BUCKETS = ["<10 s", "10–60 s", "1–5 min", "5–15 min", "15–60 min", ">1 h"];

export interface Totals {
  sessions: number;
  devices: number;
  events: number;
  activeDays: number;
  avgSessionMs: number;
}

export interface Overview {
  totals: Totals;
  daily: { day: string; sessions: number; devices: number; events: number }[];
  durations: { bucket: string; sessions: number }[];
  platforms: { platform: string; devices: number; sessions: number }[];
  people: { person: string | null; devices: number; sessions: number; events: number }[];
  releases: { release: string; devices: number; sessions: number }[];
}

/** Sessions that started in the span. */
export function overview(db: D1Database, span: Span, filters: Filters = {}): Promise<Overview> {
  const [fromMs, toMs] = rangeMs(span);
  return overviewBetween(db, span.appId, fromMs, toMs, span.offsetMin, filters);
}

/** The same for an exact range of instants (`toMs` excluded), which is what the export header uses. */
export async function overviewBetween(
  db: D1Database,
  appId: number,
  fromMs: number,
  toMs: number,
  offsetMin: number,
  filters: Filters = {},
): Promise<Overview> {
  const span = { appId, from: dayOf(fromMs, offsetMin), to: dayOf(Math.max(fromMs, toMs - 1), offsetMin), offsetMin };
  const f = conditions(filters, { platform: "d.platform", release: "s.release", person: "d.person_id", device: "d.device_id" }, 5);
  const from = `FROM sessions s LEFT JOIN devices d ON d.id = s.device_ref LEFT JOIN people p ON p.id = d.person_id
    WHERE s.app_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3 AND ?4 IS NOT NULL${f.sql}`;
  const day = "date((s.started_at + ?4) / 1000, 'unixepoch')";
  const binds = [span.appId, fromMs, toMs, span.offsetMin * 60_000, ...f.binds];
  const run = (sql: string) => db.prepare(sql).bind(...binds);
  const duration = "(s.last_event_at - s.started_at)";

  const [totals, daily, durations, platforms, people, releases] = await db.batch<any>([
    run(`SELECT count(*) AS sessions, count(DISTINCT s.device_ref) AS devices,
                coalesce(sum(s.event_count), 0) AS events, count(DISTINCT ${day}) AS days,
                coalesce(avg(${duration}), 0) AS avg_ms ${from}`),
    run(`SELECT ${day} AS day, count(*) AS sessions, count(DISTINCT s.device_ref) AS devices,
                sum(s.event_count) AS events ${from} GROUP BY day ORDER BY day`),
    run(`SELECT CASE WHEN ${duration} < 10000 THEN 0 WHEN ${duration} < 60000 THEN 1
                     WHEN ${duration} < 300000 THEN 2 WHEN ${duration} < 900000 THEN 3
                     WHEN ${duration} < 3600000 THEN 4 ELSE 5 END AS bucket, count(*) AS sessions
         ${from} GROUP BY bucket`),
    run(`SELECT coalesce(d.platform, '—') AS platform, count(DISTINCT s.device_ref) AS devices,
                count(*) AS sessions ${from} GROUP BY platform ORDER BY sessions DESC`),
    run(`SELECT p.name AS person, count(DISTINCT s.device_ref) AS devices, count(*) AS sessions,
                sum(s.event_count) AS events ${from} GROUP BY p.id ORDER BY sessions DESC`),
    run(`SELECT s.release AS release, count(DISTINCT s.device_ref) AS devices, count(*) AS sessions
         ${from} GROUP BY s.release ORDER BY max(s.started_at) DESC LIMIT 20`),
  ]);

  const t = totals!.results[0];
  const byBucket = new Map<number, number>(durations!.results.map((r: any) => [r.bucket, r.sessions]));
  const byDay = new Map<string, any>(daily!.results.map((r: any) => [r.day, r]));
  return {
    totals: { sessions: t.sessions, devices: t.devices, events: t.events, activeDays: t.days, avgSessionMs: Math.round(t.avg_ms) },
    daily: daysBetween(span.from, span.to).map((d) => {
      const r = byDay.get(d);
      return { day: d, sessions: r?.sessions ?? 0, devices: r?.devices ?? 0, events: r?.events ?? 0 };
    }),
    durations: DURATION_BUCKETS.map((bucket, i) => ({ bucket, sessions: byBucket.get(i) ?? 0 })),
    platforms: platforms!.results.map((r: any) => ({ platform: r.platform, devices: r.devices, sessions: r.sessions })),
    people: people!.results.map((r: any) => ({ person: r.person, devices: r.devices, sessions: r.sessions, events: r.events })),
    releases: releases!.results.map((r: any) => ({ release: r.release, devices: r.devices, sessions: r.sessions })),
  };
}

// ---------------------------------------------------------------------------
// events: counts per day

/** The rollup covers the days before this one; from here on the raw events are counted. */
async function liveFrom(db: D1Database, span: Span): Promise<string> {
  const row = await db.prepare("SELECT rollup_through AS t FROM apps WHERE id = ?1").bind(span.appId).first<{ t: string | null }>();
  return row?.t ? addDays(row.t, 1) : span.from;
}

export interface DailyCount {
  day: string;
  name: string;
  events: number;
}

/**
 * Event counts per day and name: finished days from `daily_events`, the rest from raw events.
 * Only platform and release can narrow it; anything finer needs raw events (see `trend`).
 */
export async function dailyCounts(
  db: D1Database,
  span: Span,
  filters: Pick<Filters, "platform" | "release"> & { name?: string } = {},
): Promise<DailyCount[]> {
  const live = await liveFrom(db, span);
  const rows: DailyCount[] = [];
  const extra = (col: { name: string; platform: string; release: string }, first: number) => {
    const parts: string[] = [];
    const binds: unknown[] = [];
    for (const [key, column] of [["name", col.name], ["platform", col.platform], ["release", col.release]] as const) {
      const value = filters[key];
      if (value) {
        binds.push(value);
        parts.push(` AND ${column} = ?${first + binds.length - 1}`);
      }
    }
    return { sql: parts.join(""), binds };
  };
  const statements: D1PreparedStatement[] = [];
  const rolledTo = live > span.from ? addDays(live, -1) : null;
  if (rolledTo !== null) {
    const x = extra({ name: "name", platform: "platform", release: "release" }, 4);
    statements.push(
      db
        .prepare(
          `SELECT day, name, sum(events) AS events FROM daily_events
           WHERE app_id = ?1 AND day >= ?2 AND day <= ?3${x.sql} GROUP BY day, name`,
        )
        .bind(span.appId, span.from, rolledTo < span.to ? rolledTo : span.to, ...x.binds),
    );
  }
  if (live <= span.to) {
    const x = extra({ name: "name", platform: "platform", release: "release" }, 5);
    statements.push(
      db
        .prepare(
          `SELECT date((occurred_at + ?4) / 1000, 'unixepoch') AS day, name, count(*) AS events FROM events
           WHERE app_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3${x.sql} GROUP BY day, name`,
        )
        .bind(span.appId, dayStart(live, span.offsetMin), dayStart(addDays(span.to, 1), span.offsetMin), span.offsetMin * 60_000, ...x.binds),
    );
  }
  for (const result of statements.length ? await db.batch<DailyCount>(statements) : []) rows.push(...result.results);
  return rows;
}

export async function eventNames(db: D1Database, span: Span, filters: Pick<Filters, "platform" | "release"> = {}) {
  const totals = new Map<string, { events: number; lastDay: string }>();
  for (const r of await dailyCounts(db, span, filters)) {
    const t = totals.get(r.name) ?? { events: 0, lastDay: r.day };
    t.events += r.events;
    if (r.day > t.lastDay) t.lastDay = r.day;
    totals.set(r.name, t);
  }
  return [...totals]
    .map(([name, t]) => ({ name, events: t.events, lastDay: t.lastDay }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// events: one name over time, optionally split by a prop

export interface TrendQuery extends Filters {
  name: string;
  /** Split the series by this prop (a dotted path inside props). */
  by?: string;
  /** Keep only events whose prop equals the value. */
  prop?: string;
  value?: string;
}

export interface Trend {
  days: string[];
  series: { key: string; total: number; values: number[] }[];
  /** The raw scan hit its row cap: the numbers are for the newest events only. */
  truncated: boolean;
}

export const TREND_SCAN_LIMIT = 20_000;
const MAX_SERIES = 8;
export const PROP_PATH = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,3}$/;

export async function trend(db: D1Database, span: Span, q: TrendQuery): Promise<Trend> {
  const days = daysBetween(span.from, span.to);
  const index = new Map(days.map((d, i) => [d, i]));
  const series = new Map<string, number[]>();
  const add = (key: string, day: string, n: number) => {
    const i = index.get(day);
    if (i === undefined) return;
    let values = series.get(key);
    if (!values) series.set(key, (values = new Array<number>(days.length).fill(0)));
    values[i]! += n;
  };
  let truncated = false;

  const needsRaw = q.by || q.prop || q.person !== undefined || q.device;
  if (!needsRaw) {
    for (const r of await dailyCounts(db, span, { name: q.name, ...(q.platform && { platform: q.platform }), ...(q.release && { release: q.release }) })) add(q.name, r.day, r.events);
  } else {
    const [fromMs, toMs] = rangeMs(span);
    const f = conditions(q, { platform: "e.platform", release: "e.release", person: "d.person_id", device: "d.device_id" }, 6);
    const binds: unknown[] = [span.appId, q.name, fromMs, toMs, span.offsetMin * 60_000, ...f.binds];
    const push = (value: unknown) => {
      binds.push(value);
      return `?${binds.length}`;
    };
    const group = q.by ? `CAST(json_extract(e.props, ${push("$." + q.by)}) AS TEXT)` : "NULL";
    const where = q.prop ? ` AND CAST(json_extract(e.props, ${push("$." + q.prop)}) AS TEXT) = ${push(q.value ?? "")}` : "";
    const { results } = await db
      .prepare(
        `SELECT day, g, count(*) AS n FROM (
           SELECT date((e.occurred_at + ?5) / 1000, 'unixepoch') AS day, ${group} AS g
           FROM events e LEFT JOIN devices d ON d.id = e.device_ref
           WHERE e.app_id = ?1 AND e.name = ?2 AND e.occurred_at >= ?3 AND e.occurred_at < ?4${f.sql}${where}
           ORDER BY e.occurred_at DESC LIMIT ${TREND_SCAN_LIMIT}
         ) GROUP BY day, g`,
      )
      .bind(...binds)
      .all<{ day: string; g: string | null; n: number }>();
    let scanned = 0;
    for (const r of results) {
      scanned += r.n;
      add(q.by ? (r.g ?? "（空）") : q.name, r.day, r.n);
    }
    truncated = scanned >= TREND_SCAN_LIMIT;
  }

  const all = [...series].map(([key, values]) => ({ key, values, total: values.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
  const top = all.slice(0, MAX_SERIES);
  if (all.length > MAX_SERIES) {
    const rest = new Array<number>(days.length).fill(0);
    for (const s of all.slice(MAX_SERIES)) s.values.forEach((n, i) => (rest[i]! += n));
    top.push({ key: "其他", values: rest, total: rest.reduce((a, b) => a + b, 0) });
  }
  return { days, series: top, truncated };
}

// ---------------------------------------------------------------------------
// events: the raw rows

export interface RawEvent {
  id: string;
  name: string;
  at: number;
  platform: string;
  release: string;
  deviceId: string | null;
  person: string | null;
  sessionId: string | null;
  correlationId: string | null;
  route: string | null;
  props: unknown;
}

export async function rawEvents(
  db: D1Database,
  span: Span,
  q: Filters & { name?: string; prop?: string; value?: string; before?: string; limit: number },
): Promise<{ events: RawEvent[]; next: string | null }> {
  const [fromMs, toMs] = rangeMs(span);
  const f = conditions(q, { platform: "e.platform", release: "e.release", person: "d.person_id", device: "d.device_id" }, 4);
  const binds: unknown[] = [span.appId, fromMs, toMs, ...f.binds];
  const push = (value: unknown) => {
    binds.push(value);
    return `?${binds.length}`;
  };
  let extra = "";
  if (q.name) extra += ` AND e.name = ${push(q.name)}`;
  if (q.prop) extra += ` AND CAST(json_extract(e.props, ${push("$." + q.prop)}) AS TEXT) = ${push(q.value ?? "")}`;
  if (q.before) {
    const [at, id] = q.before.split(".").map(Number);
    extra += ` AND (e.occurred_at < ${push(at)} OR (e.occurred_at = ${push(at)} AND e.id < ${push(id)}))`;
  }
  const { results } = await db
    .prepare(
      `SELECT e.id, e.event_id, e.name, e.occurred_at, e.platform, e.release, d.device_id, p.name AS person,
              e.session_id, e.correlation_id, e.route, e.props
       FROM events e LEFT JOIN devices d ON d.id = e.device_ref LEFT JOIN people p ON p.id = d.person_id
       WHERE e.app_id = ?1 AND e.occurred_at >= ?2 AND e.occurred_at < ?3${f.sql}${extra}
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${q.limit + 1}`,
    )
    .bind(...binds)
    .all<any>();
  const page = results.slice(0, q.limit);
  const last = page.at(-1);
  return {
    events: page.map((r) => ({
      id: r.event_id,
      name: r.name,
      at: r.occurred_at,
      platform: r.platform,
      release: r.release,
      deviceId: r.device_id,
      person: r.person,
      sessionId: r.session_id,
      correlationId: r.correlation_id,
      route: r.route,
      props: r.props ? JSON.parse(r.props) : null,
    })),
    next: results.length > q.limit && last ? `${last.occurred_at}.${last.id}` : null,
  };
}

/** What the filters can offer for an app: its releases (newest first) and platforms. */
export async function filterOptions(db: D1Database, appId: number) {
  const [releases, platforms] = await db.batch<any>([
    db.prepare("SELECT release FROM sessions WHERE app_id = ?1 GROUP BY release ORDER BY max(started_at) DESC LIMIT 30").bind(appId),
    db.prepare("SELECT DISTINCT platform FROM devices WHERE app_id = ?1").bind(appId),
  ]);
  return {
    releases: releases!.results.map((r: any) => r.release as string),
    platforms: platforms!.results.map((r: any) => r.platform as string),
  };
}

