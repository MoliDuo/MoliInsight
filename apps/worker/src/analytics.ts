import type { Catalog } from "@moli-insight/protocol";
import { dayOf } from "./days.ts";
import { conditions, dailyCounts, overview, rangeMs, type Filters, type Span } from "./stats.ts";
import { getPath, matches, percentile, type Where } from "./where.ts";

type Step = { event: string; where?: Where[] | undefined };
type Metric = NonNullable<Catalog["metrics"]>[number];
type Funnel = NonNullable<Catalog["funnels"]>[number];

/** Raw-event scans stop here: the dashboard and MCP never read more rows than this per question. */
export const SCAN_LIMIT = 50_000;

interface Row {
  name: string;
  at: number;
  session: string | null;
  device: number | null;
  props: unknown;
}

const COLUMNS = { platform: "e.platform", release: "e.release", person: "d.person_id", device: "d.device_id" };

/** The events of the given names in a span, oldest first, with their props when asked. */
async function scan(db: D1Database, span: Span, names: string[], filters: Filters, withProps: boolean) {
  const [fromMs, toMs] = rangeMs(span);
  const marks = names.map((_, i) => `?${4 + i}`).join(", ");
  const f = conditions(filters, COLUMNS, 4 + names.length);
  const { results } = await db
    .prepare(
      `SELECT e.name, e.occurred_at AS at, e.session_id AS session, e.device_ref AS device,
              ${withProps ? "e.props" : "NULL"} AS props
       FROM events e LEFT JOIN devices d ON d.id = e.device_ref
       WHERE e.app_id = ?1 AND e.occurred_at >= ?2 AND e.occurred_at < ?3 AND e.name IN (${marks})${f.sql}
       ORDER BY e.occurred_at, e.id LIMIT ${SCAN_LIMIT + 1}`,
    )
    .bind(span.appId, fromMs, toMs, ...names, ...f.binds)
    .all<{ name: string; at: number; session: string | null; device: number | null; props: string | null }>();
  const truncated = results.length > SCAN_LIMIT;
  const rows: Row[] = results.slice(0, SCAN_LIMIT).map((r) => ({
    ...r,
    props: r.props ? (JSON.parse(r.props) as unknown) : undefined,
  }));
  return { rows, truncated };
}

const label = (value: unknown) => (value === undefined || value === null || value === "" ? "（空）" : String(value));

// ---------------------------------------------------------------------------
// metrics: ratios of two events

export interface MetricResult {
  name?: string;
  numerator: number;
  denominator: number;
  ratio: number | null;
  goodDirection?: "up" | "down" | undefined;
  groups: { group: string; numerator: number; denominator: number; ratio: number | null }[];
  daily: { day: string; numerator: number; denominator: number; ratio: number | null }[];
  truncated: boolean;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

export async function metric(
  db: D1Database,
  span: Span,
  def: Pick<Metric, "numerator" | "denominator" | "groupBy"> & { name?: string; goodDirection?: "up" | "down" | undefined },
  filters: Filters = {},
): Promise<MetricResult> {
  const { numerator: num, denominator: den } = def;
  const groupBy = def.groupBy ?? [];
  const simple = !num.where?.length && !den.where?.length && groupBy.length === 0 && filters.person === undefined && !filters.device;
  const base = { ...(def.name !== undefined && { name: def.name }), goodDirection: def.goodDirection };

  const days = new Map<string, { n: number; d: number }>();
  const bump = (day: string, key: "n" | "d", by: number) => {
    const t = days.get(day) ?? { n: 0, d: 0 };
    t[key] += by;
    days.set(day, t);
  };
  let n = 0;
  let d = 0;
  const groups = new Map<string, { n: number; d: number }>();
  let truncated = false;

  if (simple) {
    // Finished days come from the daily counts; no raw scan.
    const pf = { ...(filters.platform && { platform: filters.platform }), ...(filters.release && { release: filters.release }) };
    for (const r of await dailyCounts(db, span, pf)) {
      if (r.name === num.event) { n += r.events; bump(r.day, "n", r.events); }
      if (r.name === den.event) { d += r.events; bump(r.day, "d", r.events); }
    }
  } else {
    const names = [...new Set([num.event, den.event])];
    const { rows, truncated: cut } = await scan(db, span, names, filters, true);
    truncated = cut;
    for (const r of rows) {
      const isN = r.name === num.event && matches(r.props, num.where);
      const isD = r.name === den.event && matches(r.props, den.where);
      if (!isN && !isD) continue;
      const day = dayOf(r.at, span.offsetMin);
      const key = groupBy.map((p) => label(getPath(r.props, p))).join(" / ");
      const g = groups.get(key) ?? { n: 0, d: 0 };
      if (isN) { n += 1; g.n += 1; bump(day, "n", 1); }
      if (isD) { d += 1; g.d += 1; bump(day, "d", 1); }
      groups.set(key, g);
    }
  }
  return {
    ...base,
    numerator: n,
    denominator: d,
    ratio: ratio(n, d),
    groups: groupBy.length
      ? [...groups].map(([group, g]) => ({ group, numerator: g.n, denominator: g.d, ratio: ratio(g.n, g.d) }))
          .sort((a, b) => b.denominator - a.denominator).slice(0, 20)
      : [],
    daily: [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, t]) => ({ day, numerator: t.n, denominator: t.d, ratio: ratio(t.n, t.d) })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// funnels

export interface FunnelResult {
  by: "session" | "device";
  entities: number;
  steps: { event: string; entities: number; fromPrevious: number | null; fromFirst: number | null; medianMsFromPrevious: number | null }[];
  truncated: boolean;
}

/**
 * How far each session (or device) got through the steps, in order, within the window that
 * starts at its first step. An entity counts at the furthest step it reached, once.
 */
export async function funnel(
  db: D1Database,
  span: Span,
  def: { steps: Step[]; windowMs: number; by?: "session" | "device" | undefined },
  filters: Filters = {},
): Promise<FunnelResult> {
  const by = def.by ?? "session";
  const { rows, truncated } = await scan(db, span, [...new Set(def.steps.map((s) => s.event))], filters, def.steps.some((s) => s.where?.length));
  const byEntity = new Map<string, Row[]>();
  for (const r of rows) {
    const id = by === "session" ? r.session : r.device === null ? null : String(r.device);
    if (id === null) continue;
    (byEntity.get(id) ?? byEntity.set(id, []).get(id)!).push(r);
  }

  const reached = new Array<number>(def.steps.length).fill(0);
  const gaps: number[][] = def.steps.map(() => []);
  for (const events of byEntity.values()) {
    let best: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const first = events[i]!;
      if (first.name !== def.steps[0]!.event || !matches(first.props, def.steps[0]!.where)) continue;
      const times = [first.at];
      for (let j = i + 1; j < events.length && times.length < def.steps.length; j++) {
        const e = events[j]!;
        if (e.at - first.at > def.windowMs) break;
        const step = def.steps[times.length]!;
        if (e.name === step.event && matches(e.props, step.where)) times.push(e.at);
      }
      if (times.length > best.length) best = times;
      if (best.length === def.steps.length) break;
    }
    best.forEach((t, k) => {
      reached[k]! += 1;
      if (k > 0) gaps[k]!.push(t - best[k - 1]!);
    });
  }
  return {
    by,
    entities: byEntity.size,
    steps: def.steps.map((s, k) => ({
      event: s.event,
      entities: reached[k]!,
      fromPrevious: k === 0 ? null : ratio(reached[k]!, reached[k - 1]!),
      fromFirst: ratio(reached[k]!, reached[0]!),
      medianMsFromPrevious: k === 0 ? null : percentile(gaps[k]!.sort((a, b) => a - b), 0.5),
    })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// two releases side by side

export async function compareReleases(db: D1Database, span: Span, a: string, b: string, catalog: Catalog | null, filters: Filters = {}) {
  const side = async (release: string) => {
    const f = { ...filters, release };
    const [o, counts, ops, metrics] = await Promise.all([
      overview(db, span, f),
      dailyCounts(db, span, { ...(f.platform && { platform: f.platform }), release }),
      scan(db, span, ["$op"], f, true),
      Promise.all((catalog?.metrics ?? []).map((m) => metric(db, span, m, f).then((r) => ({ name: m.name, goodDirection: m.goodDirection, numerator: r.numerator, denominator: r.denominator, ratio: r.ratio })))),
    ]);
    const count = (name: string) => counts.filter((c) => c.name === name).reduce((sum, c) => sum + c.events, 0);
    const sessions = o.totals.sessions;
    const per = (n: number) => (sessions > 0 ? n / sessions : null);
    const opsFailed = ops.rows.filter((r) => getPath(r.props, "ok") === false).length;
    return {
      release,
      sessions,
      devices: o.totals.devices,
      events: o.totals.events,
      avgSessionMs: o.totals.avgSessionMs,
      errors: count("$error"),
      errorsPerSession: per(count("$error")),
      rageTaps: count("$rage_tap"),
      rageTapsPerSession: per(count("$rage_tap")),
      deadTaps: count("$dead_tap"),
      deadTapsPerSession: per(count("$dead_tap")),
      ops: ops.rows.length,
      opFailureRate: ratio(opsFailed, ops.rows.length),
      metrics,
    };
  };
  const [first, second] = await Promise.all([side(a), side(b)]);
  return { a: first, b: second };
}

// ---------------------------------------------------------------------------
// friction and navigation: the most common values of a prop (or a few)

export interface TopRow {
  values: string[];
  events: number;
  devices: number;
}

/** The most common combinations of prop values for one event name. */
export async function topBy(db: D1Database, span: Span, name: string, paths: string[], filters: Filters = {}, limit = 20): Promise<TopRow[]> {
  const [fromMs, toMs] = rangeMs(span);
  const f = conditions(filters, COLUMNS, 5);
  const binds: unknown[] = [span.appId, fromMs, toMs, name, ...f.binds];
  const cols = paths.map((p, i) => {
    binds.push(`$.${p}`);
    return `CAST(json_extract(e.props, ?${binds.length}) AS TEXT) AS v${i}`;
  });
  const keys = paths.map((_, i) => `v${i}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${keys}, count(*) AS n, count(DISTINCT device) AS devices FROM (
         SELECT ${cols.join(", ")}, e.device_ref AS device
         FROM events e LEFT JOIN devices d ON d.id = e.device_ref
         WHERE e.app_id = ?1 AND e.occurred_at >= ?2 AND e.occurred_at < ?3 AND e.name = ?4${f.sql}
         ORDER BY e.occurred_at DESC LIMIT ${SCAN_LIMIT}
       ) GROUP BY ${keys} ORDER BY n DESC LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<Record<string, any>>();
  return results.map((r) => ({ values: paths.map((_, i) => label(r[`v${i}`])), events: r.n, devices: r.devices }));
}

/** Web profile: where users are hurrying, tapping in vain, or running into errors. */
export async function friction(db: D1Database, span: Span, filters: Filters = {}) {
  const [rage, dead, errors, toasts, dialogs] = await Promise.all([
    topBy(db, span, "$rage_tap", ["target"], filters),
    topBy(db, span, "$dead_tap", ["target"], filters),
    topBy(db, span, "$error", ["kind", "source", "message"], filters),
    topBy(db, span, "$toast", ["level", "message"], filters),
    topBy(db, span, "$dialog", ["dialog", "action", "closeBy"], filters, 60),
  ]);
  const rows = <T>(top: TopRow[], map: (v: string[]) => T) => top.map((t) => ({ ...map(t.values), events: t.events, devices: t.devices }));
  return {
    rageTaps: rows(rage, ([target]) => ({ target })),
    deadTaps: rows(dead, ([target]) => ({ target })),
    errors: rows(errors, ([kind, source, message]) => ({ kind, source, message })),
    toasts: rows(toasts, ([level, message]) => ({ level, message })),
    dialogs: rows(dialogs, ([dialog, action, closeBy]) => ({ dialog, action, closeBy })),
  };
}

/** Web profile: p75 of the web vitals per screen, and p50/p95 and failure rate per operation. */
export async function performance(db: D1Database, span: Span, filters: Filters = {}) {
  const [vitals, ops] = await Promise.all([scan(db, span, ["$vital"], filters, true), scan(db, span, ["$op"], filters, true)]);

  const v = new Map<string, { metric: string; screen: string; values: number[]; good: number; rated: number }>();
  for (const r of vitals.rows) {
    const metricName = label(getPath(r.props, "metric"));
    const screen = label(getPath(r.props, "screen"));
    const value = Number(getPath(r.props, "value"));
    if (!Number.isFinite(value)) continue;
    const t = v.get(`${metricName}|${screen}`) ?? { metric: metricName, screen, values: [], good: 0, rated: 0 };
    t.values.push(value);
    const rating = getPath(r.props, "rating");
    if (rating) { t.rated += 1; if (rating === "good") t.good += 1; }
    v.set(`${metricName}|${screen}`, t);
  }
  const o = new Map<string, { op: string; ms: number[]; failed: number; kinds: Map<string, number> }>();
  const fresh = (op: string) => ({ op, ms: [] as number[], failed: 0, kinds: new Map<string, number>() });
  for (const r of ops.rows) {
    const op = label(getPath(r.props, "op"));
    const t = o.get(op) ?? fresh(op);
    const ms = Number(getPath(r.props, "ms"));
    if (Number.isFinite(ms)) t.ms.push(ms);
    if (getPath(r.props, "ok") === false) {
      t.failed += 1;
      const kind = label(getPath(r.props, "errorKind"));
      t.kinds.set(kind, (t.kinds.get(kind) ?? 0) + 1);
    }
    o.set(op, t);
  }
  return {
    vitals: [...v.values()]
      .map((t) => {
        const s = t.values.sort((x, y) => x - y);
        return { metric: t.metric, screen: t.screen, samples: s.length, p50: percentile(s, 0.5), p75: percentile(s, 0.75), p95: percentile(s, 0.95), goodShare: ratio(t.good, t.rated) };
      })
      .sort((a, b) => b.samples - a.samples)
      .slice(0, 60),
    ops: [...o.values()]
      .map((t) => {
        const s = t.ms.sort((x, y) => x - y);
        const worst = [...t.kinds].sort((x, y) => y[1] - x[1])[0];
        return { op: t.op, calls: Math.max(s.length, t.failed), failureRate: ratio(t.failed, Math.max(s.length, t.failed)), p50: percentile(s, 0.5), p95: percentile(s, 0.95), topErrorKind: worst?.[0] ?? null };
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 60),
    truncated: vitals.truncated || ops.truncated,
  };
}

/** Web profile: how users move between screens. */
export async function navigation(db: D1Database, span: Span, filters: Filters = {}) {
  const edges = (await topBy(db, span, "$screen", ["from", "screen"], filters, 80)).map((t) => ({ from: t.values[0]!, to: t.values[1]!, events: t.events, devices: t.devices }));
  const nexts = new Map<string, typeof edges>();
  for (const e of edges) (nexts.get(e.from) ?? nexts.set(e.from, []).get(e.from)!).push(e);
  const screens = (await topBy(db, span, "$screen", ["screen"], filters, 40)).map((t) => ({
    screen: t.values[0]!,
    visits: t.events,
    devices: t.devices,
    next: (nexts.get(t.values[0]!) ?? []).slice(0, 3).map((e) => ({ screen: e.to, events: e.events })),
  }));
  return { screens, edges };
}

// ---------------------------------------------------------------------------
// sessions

export async function sessionList(
  db: D1Database,
  span: Span,
  filters: Filters,
  { before, limit }: { before?: string | undefined; limit: number },
) {
  const [fromMs, toMs] = rangeMs(span);
  const f = conditions(filters, { platform: "d.platform", release: "s.release", person: "d.person_id", device: "d.device_id" }, 4);
  const binds: unknown[] = [span.appId, fromMs, toMs, ...f.binds];
  let cursor = "";
  if (before) {
    const [at, id] = before.split(".").map(Number);
    binds.push(at, id);
    cursor = ` AND (s.started_at < ?${binds.length - 1} OR (s.started_at = ?${binds.length - 1} AND s.id < ?${binds.length}))`;
  }
  const { results } = await db
    .prepare(
      `SELECT s.id, s.session_id, s.release, s.started_at, s.last_event_at, s.event_count,
              d.device_id, d.platform, p.name AS person
       FROM sessions s LEFT JOIN devices d ON d.id = s.device_ref LEFT JOIN people p ON p.id = d.person_id
       WHERE s.app_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${f.sql}${cursor}
       ORDER BY s.started_at DESC, s.id DESC LIMIT ${limit + 1}`,
    )
    .bind(...binds)
    .all<any>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return {
    sessions: page.map((r) => ({
      sessionId: r.session_id, release: r.release, startedAt: r.started_at, durationMs: r.last_event_at - r.started_at,
      events: r.event_count, deviceId: r.device_id, platform: r.platform, person: r.person,
    })),
    next: results.length > limit && last ? `${last.started_at}.${last.id}` : null,
  };
}

/** One session's events in order, each with the time since the one before. A text version of a replay. */
export async function sessionTimeline(db: D1Database, appId: number, sessionId: string) {
  const session = await db
    .prepare(
      `SELECT s.session_id, s.release, s.started_at, s.last_event_at, s.event_count, d.device_id, d.platform, d.os, d.client, p.name AS person
       FROM sessions s LEFT JOIN devices d ON d.id = s.device_ref LEFT JOIN people p ON p.id = d.person_id
       WHERE s.app_id = ?1 AND s.session_id = ?2`,
    )
    .bind(appId, sessionId)
    .first<any>();
  if (!session) return null;
  // The index is on time, so the session's own time window keeps this from scanning the app.
  const { results } = await db
    .prepare(
      `SELECT name, occurred_at, route, correlation_id, props FROM events
       WHERE app_id = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 AND session_id = ?4
       ORDER BY occurred_at, id LIMIT 1000`,
    )
    .bind(appId, session.started_at, session.last_event_at, sessionId)
    .all<any>();
  let previous = session.started_at as number;
  return {
    sessionId: session.session_id,
    release: session.release,
    startedAt: session.started_at,
    durationMs: session.last_event_at - session.started_at,
    eventCount: session.event_count,
    device: { deviceId: session.device_id, platform: session.platform, os: session.os, client: session.client, person: session.person },
    events: results.map((r) => {
      const item = {
        name: r.name,
        at: r.occurred_at,
        offsetMs: r.occurred_at - session.started_at,
        sincePreviousMs: r.occurred_at - previous,
        ...(r.route && { route: r.route }),
        ...(r.correlation_id && { correlationId: r.correlation_id }),
        ...(r.props && { props: JSON.parse(r.props) as unknown }),
      };
      previous = r.occurred_at;
      return item;
    }),
    truncated: results.length === 1000,
  };
}

// ---------------------------------------------------------------------------
// feature usage against the catalog

export function usage(
  names: { name: string; events: number }[],
  catalog: Catalog | null,
) {
  const seen = new Map(names.map((n) => [n.name, n.events]));
  const cataloged = new Set((catalog?.events ?? []).map((e) => e.name));
  return {
    unused: (catalog?.events ?? []).filter((e) => !seen.has(e.name)).map((e) => ({ name: e.name, description: e.description, tier: e.tier ?? "product" })),
    uncataloged: names.filter((n) => !n.name.startsWith("$") && !cataloged.has(n.name)),
  };
}
