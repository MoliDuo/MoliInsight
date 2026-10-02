import { Hono } from "hono";
import type { AppEnv } from "./env.ts";
import { authenticateAdminToken, bearerToken } from "./keys.ts";
import { hasSession } from "./session.ts";

/**
 * `GET /v1/export?app=&from=&to=&limit=&after=`: raw events as NDJSON, oldest first.
 *
 * The first line describes the export, every other line is one event, and the last line carries
 * the cursor for the next page (`next` is null once the range is exhausted). Pages are bounded,
 * so a response never has to hold a whole database. The full row format is settled in M3.
 */
export const exportRoutes = new Hono<AppEnv>();

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10000;

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
    : (await hasSession(c)) && { tokenId: 0 };
  if (!allowed) return c.json({ error: "unauthorized" }, 401);

  const slug = c.req.query("app");
  if (!slug) return c.json({ error: "invalid_request", detail: "app is required" }, 400);
  const app = await c.env.DB.prepare("SELECT id, slug, name FROM apps WHERE slug = ?1")
    .bind(slug)
    .first<{ id: number; slug: string; name: string }>();
  if (!app) return c.json({ error: "not_found" }, 404);

  const from = instant(c.req.query("from"), 0);
  const to = instant(c.req.query("to"), now() + 1);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  if (from === null || to === null) return c.json({ error: "invalid_request", detail: "bad from or to" }, 400);

  let afterAt = from;
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
  const lines = [
    {
      type: "header",
      format: "moli-insight-export",
      version: 1,
      app: { slug: app.slug, name: app.name },
      from,
      to,
      exportedAt: now(),
    },
    ...page.map((r) => ({
      type: "event",
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
    })),
    {
      type: "end",
      count: page.length,
      next: results.length > limit && last ? `${last.occurred_at}.${last.id}` : null,
    },
  ];
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
});
