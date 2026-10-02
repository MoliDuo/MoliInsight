import { Hono, type Context } from "hono";
import { z } from "zod";
import { addDays, dayOf, dayOffset, daysBetween, isDay } from "./days.ts";
import type { AppEnv } from "./env.ts";
import { requireSession } from "./session.ts";
import {
  PROP_PATH,
  eventNames,
  filterOptions,
  overview,
  rawEvents,
  trend,
  type Filters,
  type Span,
} from "./stats.ts";

/** What the dashboard reads. All behind the dashboard session. */
export const stats = new Hono<AppEnv>();

const MAX_RANGE_DAYS = 400;

const str = z.string().trim().min(1).max(120).optional();
const Query = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  /** Without `from`: the range is this many days ending at `to` (default 30). */
  days: z.coerce.number().int().min(1).max(400).optional(),
  platform: str,
  release: str,
  person: z.string().regex(/^(none|\d{1,9})$/).optional(),
  device: z.string().regex(/^dev_[A-Za-z0-9]{8,48}$/).optional(),
  name: str,
  by: z.string().regex(PROP_PATH).optional(),
  prop: z.string().regex(PROP_PATH).optional(),
  value: z.string().max(200).optional(),
  before: z.string().regex(/^\d+\.\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Ctx = Context<AppEnv>;

/** Reads the app, the day range (default: the last 30 days) and the filters from a request. */
async function parse(c: Ctx): Promise<{ span: Span; filters: Filters; q: z.infer<typeof Query> } | Response> {
  const parsed = Query.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const q = parsed.data;

  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1").bind(c.req.param("slug")).first<{ id: number }>();
  if (!app) return c.json({ error: "not_found" }, 404);

  const offsetMin = dayOffset(c.env.DAY_OFFSET_MINUTES);
  const to = q.to ?? dayOf(c.get("deps").now(), offsetMin);
  const from = q.from ?? addDays(to, -((q.days ?? 30) - 1));
  if (!isDay(from) || !isDay(to) || from > to || daysBetween(from, to).length > MAX_RANGE_DAYS) {
    return c.json({ error: "invalid_request", detail: "bad range" }, 400);
  }
  const filters: Filters = {
    ...(q.platform && { platform: q.platform }),
    ...(q.release && { release: q.release }),
    ...(q.person && { person: q.person === "none" ? ("none" as const) : Number(q.person) }),
    ...(q.device && { device: q.device }),
  };
  return { span: { appId: app.id, from, to, offsetMin }, filters, q };
}

const isResponse = (value: unknown): value is Response => value instanceof Response;

stats.get("/api/apps/:slug/overview", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const [data, options] = await Promise.all([overview(c.env.DB, p.span, p.filters), filterOptions(c.env.DB, p.span.appId)]);
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...data, options });
});

stats.get("/api/apps/:slug/filters", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  return c.json(await filterOptions(c.env.DB, p.span.appId));
});

stats.get("/api/apps/:slug/events/names", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const names = await eventNames(c.env.DB, p.span, p.filters);
  return c.json({ range: { from: p.span.from, to: p.span.to }, names });
});

stats.get("/api/apps/:slug/events/trend", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  if (!p.q.name) return c.json({ error: "invalid_request", detail: "name is required" }, 400);
  const result = await trend(c.env.DB, p.span, {
    ...p.filters,
    name: p.q.name,
    ...(p.q.by && { by: p.q.by }),
    ...(p.q.prop && { prop: p.q.prop }),
    ...(p.q.value !== undefined && { value: p.q.value }),
  });
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...result });
});

stats.get("/api/apps/:slug/events/raw", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const result = await rawEvents(c.env.DB, p.span, {
    ...p.filters,
    ...(p.q.name && { name: p.q.name }),
    ...(p.q.prop && { prop: p.q.prop }),
    ...(p.q.value !== undefined && { value: p.q.value }),
    ...(p.q.before && { before: p.q.before }),
    limit: p.q.limit,
  });
  return c.json(result);
});
