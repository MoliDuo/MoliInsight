import { Hono } from "hono";
import { DAY_MS, dayOf, dayOffset } from "./days.ts";
import type { AppEnv } from "./env.ts";
import { authenticateAdminToken, bearerToken } from "./keys.ts";
import { hasSession } from "./session.ts";
import { eventNames, overviewBetween } from "./stats.ts";

/**
 * `GET /v1/export?app=&from=&to=&limit=&after=&format=`: raw events, oldest first.
 *
 * NDJSON (the default) is a header line, one line per event, and an end line whose `next`
 * is the cursor of the next page (null when the range is exhausted). Pages are bounded, so a
 * response never has to hold a whole database. `format=json` returns the same as one object,
 * for ranges of at most a week.
 *
 * The header of the first page carries what an analyst needs to read the events: the app's
 * catalog, people, devices, releases and a summary, which uses the same queries as the
 * dashboard's overview and event list.
 */
export const exportRoutes = new Hono<AppEnv>();

export const EXPORT_FORMAT_VERSION = 1;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10000;
const MAX_JSON_RANGE_MS = 7 * DAY_MS;
/** Events may be stamped a few minutes ahead of the server (the protocol allows 5), so an open range reaches past now. */
const OPEN_END_MS = 10 * 60 * 1000;

interface Row {
  id: number;
  event_id: string;
  name: string;
  occurred_at: number;
  received_at: number;
  mono: number | null;
  platform: string;
  release: string;
  device_id: string | null;
  person: string | null;
  session_id: string | null;
  correlation_id: string | null;
  route: string | null;
  props: string | null;
}

function instant(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

exportRoutes.get("/v1/export", async (c) => {
  const { now } = c.get("deps");
  const token = bearerToken(c.req.raw);
  const allowed = token
    ? await authenticateAdminToken(c.env, token, now(), (p) => c.executionCtx.waitUntil(p))
    : await hasSession(c);
  if (!allowed) return c.json({ error: "unauthorized" }, 401);

  const slug = c.req.query("app");
  if (!slug) return c.json({ error: "invalid_request", detail: "app is required" }, 400);
  const app = await c.env.DB.prepare("SELECT id, slug, name, retention_days FROM apps WHERE slug = ?1")
    .bind(slug)
    .first<{ id: number; slug: string; name: string; retention_days: number }>();
  if (!app) return c.json({ error: "not_found" }, 404);

  const from = instant(c.req.query("from"), 0);
  const to = instant(c.req.query("to"), now() + OPEN_END_MS);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  if (from === null || to === null) return c.json({ error: "invalid_request", detail: "bad from or to" }, 400);
  const asJson = c.req.query("format") === "json";
  if (c.req.query("format") && c.req.query("format") !== "json" && c.req.query("format") !== "ndjson") {
    return c.json({ error: "invalid_request", detail: "format is ndjson or json" }, 400);
  }
  // Without a lower bound the range starts at the oldest event the app may still hold.
  const start = c.req.query("from") === undefined ? now() - app.retention_days * DAY_MS : from;
  if (asJson && to - start > MAX_JSON_RANGE_MS) {
    return c.json({ error: "range_too_large", detail: "format=json is for ranges of at most 7 days; use ndjson" }, 400);
  }

  let afterAt = start;
  let afterId = 0;
  const after = c.req.query("after");
  if (after) {
    const m = /^(\d+)\.(\d+)$/.exec(after);
    if (!m) return c.json({ error: "invalid_request", detail: "bad cursor" }, 400);
    afterAt = Number(m[1]);
    afterId = Number(m[2]);
  }

  // The cursor is (occurred_at, id). One extra row tells whether another page exists.
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.event_id, e.name, e.occurred_at, e.received_at, e.mono, e.platform, e.release,
            d.device_id, p.name AS person, e.session_id, e.correlation_id, e.route, e.props
     FROM events e
     LEFT JOIN devices d ON d.id = e.device_ref
     LEFT JOIN people p ON p.id = d.person_id
     WHERE e.app_id = ?1 AND e.occurred_at < ?2
       AND (e.occurred_at > ?3 OR (e.occurred_at = ?3 AND e.id > ?4))
     ORDER BY e.occurred_at, e.id
     LIMIT ?5`,
  )
    .bind(app.id, to, afterAt, afterId, limit + 1)
    .all<Row>();

  const page = results.slice(0, limit);
  const last = page.at(-1);
  const events = page.map((r) => ({
    type: "event" as const,
    id: r.event_id,
    name: r.name,
    at: r.occurred_at,
    receivedAt: r.received_at,
    ...(r.mono !== null && { mono: r.mono }),
    platform: r.platform,
    release: r.release,
    ...(r.device_id && { deviceId: r.device_id }),
    ...(r.person && { person: r.person }),
    ...(r.session_id && { sessionId: r.session_id }),
    ...(r.correlation_id && { correlationId: r.correlation_id }),
    ...(r.route && { route: r.route }),
    ...(r.props && { props: JSON.parse(r.props) as unknown }),
  }));
  const end = {
    type: "end" as const,
    count: page.length,
    next: results.length > limit && last ? `${last.occurred_at}.${last.id}` : null,
  };

  const base = {
    type: "header" as const,
    format: "moli-insight-export" as const,
    version: EXPORT_FORMAT_VERSION,
    app: { slug: app.slug, name: app.name },
    from: start,
    to,
    exportedAt: now(),
  };
  const header = after ? base : { ...base, ...(await context(c.env, app, start, to)) };

  if (asJson) return c.json({ header, events, end }, 200, { "cache-control": "no-store" });
  return new Response([header, ...events, end].map((l) => JSON.stringify(l)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
});

async function context(
  env: AppEnv["Bindings"],
  app: { id: number; retention_days: number },
  from: number,
  to: number,
) {
  const offsetMin = dayOffset(env.DAY_OFFSET_MINUTES);
  const [catalog, people, devices] = await env.DB.batch<any>([
    env.DB.prepare("SELECT kind, name, definition FROM catalog_entries WHERE app_id = ?1 ORDER BY kind, name").bind(app.id),
    env.DB.prepare("SELECT name FROM people ORDER BY name"),
    env.DB.prepare(
      `SELECT d.device_id, p.name AS person, d.platform, d.device_class, d.os, d.client, d.last_release,
              d.first_seen_at, d.last_seen_at
       FROM devices d LEFT JOIN people p ON p.id = d.person_id
       WHERE d.app_id = ?1 ORDER BY d.last_seen_at DESC LIMIT 500`,
    ).bind(app.id),
  ]);
  const days = { appId: app.id, from: dayOf(from, offsetMin), to: dayOf(Math.max(from, to - 1), offsetMin), offsetMin };
  const [summary, names] = await Promise.all([
    overviewBetween(env.DB, app.id, from, to, offsetMin),
    eventNames(env.DB, days),
  ]);
  return {
    dayOffsetMinutes: offsetMin,
    retentionDays: app.retention_days,
    catalog: catalog!.results.map((r: any) => ({ kind: r.kind, name: r.name, definition: JSON.parse(r.definition) })),
    people: people!.results.map((r: any) => r.name as string),
    devices: devices!.results.map((r: any) => ({
      deviceId: r.device_id,
      ...(r.person && { person: r.person }),
      platform: r.platform,
      ...(r.device_class && { deviceClass: r.device_class }),
      ...(r.os && { os: r.os }),
      ...(r.client && { client: r.client }),
      ...(r.last_release && { lastRelease: r.last_release }),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    })),
    releases: summary.releases,
    summary: { ...summary.totals, platforms: summary.platforms, people: summary.people, durations: summary.durations },
    eventCounts: names.map((n) => ({ name: n.name, events: n.events })),
  };
}
