import { Hono, type Context } from "hono";
import { z } from "zod";
import { addDays, dayOf, dayOffset, daysBetween, isDay } from "./days.ts";
import type { AppEnv } from "./env.ts";
import { audit } from "./audit.ts";
import { requireSession } from "./session.ts";
import { FunnelSchema, type Catalog } from "@moli-insight/protocol";
import {
  topBy,
  compareReleases,
  friction,
  funnel,
  metric,
  navigation,
  performance,
  sessionList,
  sessionTimeline,
  usage,
} from "./analytics.ts";
import { SavedFunnelSchema, loadCatalog, loadSavedFunnels } from "./catalog.ts";
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

// ---------------------------------------------------------------------------
// catalog, metrics, funnels

stats.get("/api/apps/:slug/catalog", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const [catalog, saved] = await Promise.all([loadCatalog(c.env.DB, p.span.appId), loadSavedFunnels(c.env.DB, p.span.appId)]);
  return c.json({ catalog, savedFunnels: saved });
});

const PropList = z.string().regex(new RegExp(`^${PROP_PATH.source.slice(1, -1)}(,${PROP_PATH.source.slice(1, -1)}){0,2}$`));

stats.get("/api/apps/:slug/metrics/:metric", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const catalog = await loadCatalog(c.env.DB, p.span.appId);
  const def = catalog?.metrics?.find((m) => m.name === c.req.param("metric"));
  if (!def) return c.json({ error: "not_found" }, 404);
  const override = PropList.safeParse(c.req.query("groupBy"));
  const result = await metric(c.env.DB, p.span, override.success ? { ...def, groupBy: override.data.split(",") } : def, p.filters);
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...result });
});

/** A funnel from the catalog or the dashboard (by name), or one given in the body. */
async function runFunnel(c: Ctx, body: unknown) {
  const p = await parse(c);
  if (isResponse(p)) return p;
  let def: z.infer<typeof SavedFunnelSchema> | undefined;
  const name = c.req.query("name");
  if (name) {
    const [catalog, saved] = await Promise.all([loadCatalog(c.env.DB, p.span.appId), loadSavedFunnels(c.env.DB, p.span.appId)]);
    def = catalog?.funnels?.find((f) => f.name === name) ?? saved.find((f) => f.name === name);
    if (!def) return c.json({ error: "not_found" }, 404);
  } else {
    const parsed = SavedFunnelSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request", detail: "steps, windowMs" }, 400);
    def = parsed.data;
  }
  const result = await funnel(c.env.DB, p.span, def, p.filters);
  return c.json({ range: { from: p.span.from, to: p.span.to }, windowMs: def.windowMs, ...result });
}

stats.get("/api/apps/:slug/funnel", requireSession, (c) => runFunnel(c, undefined));
stats.post("/api/apps/:slug/funnel", requireSession, async (c) => runFunnel(c, await c.req.json().catch(() => null)));

stats.put("/api/apps/:slug/funnels/:name", requireSession, async (c) => {
  const nameOk = FunnelSchema.shape.name.safeParse(c.req.param("name"));
  const body = SavedFunnelSchema.safeParse(await c.req.json().catch(() => null));
  if (!nameOk.success || !body.success) return c.json({ error: "invalid_request" }, 400);
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1").bind(c.req.param("slug")).first<{ id: number }>();
  if (!app) return c.json({ error: "not_found" }, 404);
  const now = c.get("deps").now();
  await c.env.DB.prepare(
    `INSERT INTO saved_funnels (app_id, name, definition, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (app_id, name) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
  ).bind(app.id, nameOk.data, JSON.stringify(body.data), now).run();
  await audit(c, "funnel.save", `${c.req.param("slug")}/${nameOk.data}`);
  return c.json({ ok: true });
});

stats.delete("/api/apps/:slug/funnels/:name", requireSession, async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM saved_funnels WHERE name = ?2 AND app_id = (SELECT id FROM apps WHERE slug = ?1)",
  ).bind(c.req.param("slug"), c.req.param("name")).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await audit(c, "funnel.delete", `${c.req.param("slug")}/${c.req.param("name")}`);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// comparisons and the web profile's views

stats.get("/api/apps/:slug/compare", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const a = c.req.query("a");
  const b = c.req.query("b");
  if (!a || !b) return c.json({ error: "invalid_request", detail: "a and b are releases" }, 400);
  const catalog: Catalog | null = await loadCatalog(c.env.DB, p.span.appId);
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...(await compareReleases(c.env.DB, p.span, a, b, catalog, p.filters)) });
});

stats.get("/api/apps/:slug/friction", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...(await friction(c.env.DB, p.span, p.filters)) });
});

stats.get("/api/apps/:slug/performance", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...(await performance(c.env.DB, p.span, p.filters)) });
});

stats.get("/api/apps/:slug/navigation", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  return c.json({ range: { from: p.span.from, to: p.span.to }, ...(await navigation(c.env.DB, p.span, p.filters)) });
});

stats.get("/api/apps/:slug/usage", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  const [names, catalog, taps, screens] = await Promise.all([
    eventNames(c.env.DB, p.span, p.filters),
    loadCatalog(c.env.DB, p.span.appId),
    topBy(c.env.DB, p.span, "$tap", ["target"], p.filters, 40),
    topBy(c.env.DB, p.span, "$screen", ["screen"], p.filters, 40),
  ]);
  return c.json({
    range: { from: p.span.from, to: p.span.to },
    ...usage(names, catalog),
    taps: taps.map((t) => ({ target: t.values[0], events: t.events, devices: t.devices })),
    screens: screens.map((t) => ({ screen: t.values[0], events: t.events, devices: t.devices })),
    hasCatalog: catalog !== null,
  });
});

stats.get("/api/apps/:slug/sessions", requireSession, async (c) => {
  const p = await parse(c);
  if (isResponse(p)) return p;
  return c.json(await sessionList(c.env.DB, p.span, p.filters, { before: p.q.before, limit: p.q.limit }));
});

stats.get("/api/apps/:slug/sessions/:id", requireSession, async (c) => {
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1").bind(c.req.param("slug")).first<{ id: number }>();
  if (!app) return c.json({ error: "not_found" }, 404);
  const timeline = await sessionTimeline(c.env.DB, app.id, c.req.param("id"));
  return timeline ? c.json(timeline) : c.json({ error: "not_found" }, 404);
});
