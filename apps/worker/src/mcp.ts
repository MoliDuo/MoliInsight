import { Hono } from "hono";
import { FunnelSchema, StepSchema } from "@moli-insight/protocol";
import { z } from "zod";
import { compareReleases, friction, funnel, metric, performance, sessionList, sessionTimeline } from "./analytics.ts";
import { loadCatalog, loadSavedFunnels } from "./catalog.ts";
import { addDays, dayOf, dayOffset, daysBetween, isDay } from "./days.ts";
import type { AppEnv } from "./env.ts";
import { authenticateAdminToken, bearerToken } from "./keys.ts";
import { eventNames, filterOptions, overview, rawEvents, trend, PROP_PATH, type Filters, type Span } from "./stats.ts";

/**
 * `POST /mcp`: the Model Context Protocol over Streamable HTTP, so an AI assistant can ask
 * questions of the data. Stateless: every request is a JSON-RPC message answered with JSON.
 * Needs an admin token. Every tool bounds what it returns.
 */
export const mcp = new Hono<AppEnv>();

const SERVER = { name: "moli-insight", version: "0.1.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_OUTPUT_CHARS = 120_000;
const MAX_RANGE_DAYS = 400;

// ---------------------------------------------------------------------------
// arguments

const app = z.string().regex(/^[a-z0-9-]{1,40}$/).describe("The app's slug, from list_apps.");
const range = {
  days: z.int().min(1).max(MAX_RANGE_DAYS).optional().describe("The last N days up to today (default 30). Ignored when from is given."),
  from: z.string().optional().describe("First day, YYYY-MM-DD, in the deployment's local days."),
  to: z.string().optional().describe("Last day, YYYY-MM-DD (default today)."),
};
const filters = {
  platform: z.string().max(40).optional(),
  release: z.string().max(120).optional(),
  person: z.string().max(40).optional().describe("A person's name as listed in the export header, or \"none\" for devices nobody owns."),
  device: z.string().regex(/^dev_[A-Za-z0-9]{8,48}$/).optional(),
};
const prop = z.string().regex(PROP_PATH).describe("A path into props, such as kind or field.role.");
const limit = (max: number, fallback: number) => z.int().min(1).max(max).default(fallback);

const Tools = {
  list_apps: {
    description: "The apps this server holds data for, with their retention and when they last sent an event.",
    args: z.object({}),
  },
  get_catalog: {
    description: "An app's event catalog: what each event means, its props, the ratio metrics and funnels the app defined, and funnels saved on the dashboard. Read this first to know which events and metrics exist.",
    args: z.object({ app }),
  },
  summary: {
    description: "How an app is used over a range: sessions, active devices, days of use, average session length, per-day counts, splits by platform, person and release, and the most frequent events.",
    args: z.object({ app, ...range, ...filters }),
  },
  trend: {
    description: "Daily counts of one event, optionally split by a prop's values (top 8) or narrowed to events whose prop equals a value.",
    args: z.object({ app, name: z.string().max(64), by: prop.optional(), prop: prop.optional(), value: z.string().max(200).optional(), ...range, ...filters }),
  },
  query_events: {
    description: "Raw events, newest first. Always bounded by limit (at most 200); page with `before` from the previous result's `next`.",
    args: z.object({ app, name: z.string().max(64).optional(), prop: prop.optional(), value: z.string().max(200).optional(), ...range, ...filters, limit: limit(200, 50), before: z.string().regex(/^\d+\.\d+$/).optional() }),
  },
  metric: {
    description: "A ratio metric from the app's catalog (for example manual_correction_rate = manualSwitch / switch), with its daily values and, if the metric has groupBy, the ratio per group.",
    args: z.object({ app, name: z.string().max(64).describe("A metric name from get_catalog."), ...range, ...filters }),
  },
  funnel: {
    description: "How far sessions (or devices) get through 2 to 6 events in order within a time window. Give `name` for a funnel from the catalog or the dashboard, or give `steps`.",
    args: z.object({
      app,
      name: z.string().max(64).optional(),
      steps: z.array(StepSchema).min(2).max(6).optional(),
      windowMs: FunnelSchema.shape.windowMs.optional().describe("Time allowed from the first step to the last, in ms (default 1 hour)."),
      by: z.enum(["session", "device"]).optional(),
      ...range,
      ...filters,
    }),
  },
  compare_releases: {
    description: "Two releases side by side over the same range: sessions, errors, rage taps and dead taps per session, operation failure rate, and every catalog metric.",
    args: z.object({ app, a: z.string().max(120), b: z.string().max(120), ...range, platform: filters.platform }),
  },
  sessions: {
    description: "Recent sessions, newest first, each with device, person, release, length and event count. Use session_timeline on one of them.",
    args: z.object({ app, ...range, ...filters, limit: limit(100, 30), before: z.string().regex(/^\d+\.\d+$/).optional() }),
  },
  session_timeline: {
    description: "One session's events in order, each with the time since the previous one: a text version of a replay.",
    args: z.object({ app, sessionId: z.string().regex(/^ses_[A-Za-z0-9]{8,48}$/) }),
  },
  friction: {
    description: "Web apps: the controls with the most rage taps and dead taps, the errors and toasts users hit, and how dialogs were closed.",
    args: z.object({ app, ...range, ...filters }),
  },
  performance: {
    description: "Web apps: web vitals per screen (p50, p75, p95) and per-operation p50, p95 and failure rate.",
    args: z.object({ app, ...range, ...filters }),
  },
} as const;

type ToolName = keyof typeof Tools;

class ToolError extends Error {}

async function resolve(env: AppEnv["Bindings"], now: number, a: { app: string; days?: number | undefined; from?: string | undefined; to?: string | undefined } & Filters & { person?: unknown }) {
  const row = await env.DB.prepare("SELECT id FROM apps WHERE slug = ?1").bind(a.app).first<{ id: number }>();
  if (!row) throw new ToolError(`There is no app "${a.app}". Call list_apps.`);
  const offsetMin = dayOffset(env.DAY_OFFSET_MINUTES);
  const to = a.to ?? dayOf(now, offsetMin);
  const from = a.from ?? addDays(to, -((a.days ?? 30) - 1));
  if (!isDay(from) || !isDay(to) || from > to || daysBetween(from, to).length > MAX_RANGE_DAYS) {
    throw new ToolError("The range is not valid: use YYYY-MM-DD days, from before to, at most 400 days.");
  }
  const f: Filters = {};
  if (a.platform) f.platform = a.platform;
  if (a.release) f.release = a.release;
  if (a.device) f.device = a.device;
  if (typeof a.person === "string") {
    if (a.person === "none") f.person = "none";
    else {
      const person = await env.DB.prepare("SELECT id FROM people WHERE name = ?1").bind(a.person).first<{ id: number }>();
      if (!person) throw new ToolError(`There is no person "${a.person}".`);
      f.person = person.id;
    }
  }
  const span: Span = { appId: row.id, from, to, offsetMin };
  return { span, filters: f };
}

const drop = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

async function call(name: ToolName, raw: unknown, env: AppEnv["Bindings"], now: number): Promise<unknown> {
  const parsed = Tools[name].args.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ToolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const a = parsed.data as any;

  if (name === "list_apps") {
    const { results } = await env.DB.prepare(
      `SELECT a.slug, a.name, a.retention_days, (SELECT max(occurred_at) FROM events WHERE app_id = a.id) AS last_event_at,
              (SELECT count(*) FROM devices WHERE app_id = a.id) AS devices FROM apps a ORDER BY a.slug`,
    ).all<any>();
    return { apps: results.map((r) => ({ slug: r.slug, name: r.name, retentionDays: r.retention_days, lastEventAt: r.last_event_at ? new Date(r.last_event_at).toISOString() : null, devices: r.devices })) };
  }

  const { span, filters: f } = await resolve(env, now, a);
  const range_ = { from: span.from, to: span.to };

  switch (name) {
    case "get_catalog":
      return { catalog: await loadCatalog(env.DB, span.appId), savedFunnels: await loadSavedFunnels(env.DB, span.appId) };
    case "summary": {
      const [o, names, options] = await Promise.all([overview(env.DB, span, f), eventNames(env.DB, span, f), filterOptions(env.DB, span.appId)]);
      return { range: range_, ...o, topEvents: names.slice(0, 20), releases: o.releases, available: options };
    }
    case "trend":
      return { range: range_, ...(await trend(env.DB, span, { ...f, name: a.name, ...(a.by && { by: a.by }), ...(a.prop && { prop: a.prop }), ...(a.value !== undefined && { value: a.value }) })) };
    case "query_events": {
      const r = await rawEvents(env.DB, span, { ...f, ...(a.name && { name: a.name }), ...(a.prop && { prop: a.prop }), ...(a.value !== undefined && { value: a.value }), ...(a.before && { before: a.before }), limit: a.limit });
      return { range: range_, events: r.events.map((e) => drop({ ...e, at: new Date(e.at).toISOString() })), next: r.next };
    }
    case "metric": {
      const catalog = await loadCatalog(env.DB, span.appId);
      const def = catalog?.metrics?.find((m) => m.name === a.name);
      if (!def) throw new ToolError(`The catalog has no metric "${a.name}". Metrics: ${(catalog?.metrics ?? []).map((m) => m.name).join(", ") || "none"}.`);
      return { range: range_, description: def.description, ...(await metric(env.DB, span, def, f)) };
    }
    case "funnel": {
      let def: { steps: z.infer<typeof StepSchema>[]; windowMs: number; by?: "session" | "device" | undefined } | undefined;
      if (a.name) {
        const [catalog, saved] = await Promise.all([loadCatalog(env.DB, span.appId), loadSavedFunnels(env.DB, span.appId)]);
        def = catalog?.funnels?.find((x) => x.name === a.name) ?? saved.find((x) => x.name === a.name);
        if (!def) throw new ToolError(`No funnel named "${a.name}". Pass steps instead, or see get_catalog.`);
      } else if (a.steps) {
        def = { steps: a.steps, windowMs: a.windowMs ?? 3_600_000, by: a.by };
      } else {
        throw new ToolError("Give either name or steps.");
      }
      if (a.by) def = { ...def, by: a.by };
      return { range: range_, windowMs: def.windowMs, ...(await funnel(env.DB, span, def, f)) };
    }
    case "compare_releases":
      return { range: range_, ...(await compareReleases(env.DB, span, a.a, a.b, await loadCatalog(env.DB, span.appId), f)) };
    case "sessions": {
      const r = await sessionList(env.DB, span, f, { before: a.before, limit: a.limit });
      return { sessions: r.sessions.map((s) => drop({ ...s, startedAt: new Date(s.startedAt).toISOString() })), next: r.next };
    }
    case "session_timeline": {
      const t = await sessionTimeline(env.DB, span.appId, a.sessionId);
      if (!t) throw new ToolError(`No session ${a.sessionId} in this app.`);
      return t;
    }
    case "friction":
      return { range: range_, ...(await friction(env.DB, span, f)) };
    case "performance":
      return { range: range_, ...(await performance(env.DB, span, f)) };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const TOOL_LIST = Object.entries(Tools).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: z.toJSONSchema(t.args, { io: "input", target: "draft-7" }),
}));

async function handle(msg: Rpc, env: AppEnv["Bindings"], now: number): Promise<object | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg.id, -32600, "Invalid request");
  const notification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: "Usage data of the Moli apps. Start with list_apps, then get_catalog for the app you care about. Every tool takes a day range; keep ranges and limits small.",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOL_LIST });
    case "tools/call": {
      const name = msg.params?.name as ToolName;
      if (!Object.hasOwn(Tools, name)) return fail(msg.id, -32602, `Unknown tool: ${String(msg.params?.name)}`);
      try {
        const text = JSON.stringify(await call(name, msg.params?.arguments, env, now));
        if (text.length > MAX_OUTPUT_CHARS) {
          return ok(msg.id, { isError: true, content: [{ type: "text", text: "The result is too large. Use a shorter range, a filter or a smaller limit." }] });
        }
        return ok(msg.id, { content: [{ type: "text", text }] });
      } catch (error) {
        if (error instanceof ToolError) return ok(msg.id, { isError: true, content: [{ type: "text", text: error.message }] });
        console.error("mcp tool failed", name, error instanceof Error ? error.message : "");
        return ok(msg.id, { isError: true, content: [{ type: "text", text: "The query failed on the server." }] });
      }
    }
    default:
      return notification ? null : fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

mcp.all("/mcp", async (c) => {
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "forbidden_origin" }, 403);

  const { now } = c.get("deps");
  const token = bearerToken(c.req.raw);
  const allowed = token ? await authenticateAdminToken(c.env, token, now(), (p) => c.executionCtx.waitUntil(p)) : null;
  if (!allowed) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="moli-insight"' });

  if (c.req.method !== "POST") return c.body(null, 405, { allow: "POST" });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail(null, -32700, "Parse error"), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0 || messages.length > 20) return c.json(fail(null, -32600, "Invalid request"), 400);
  const replies = (await Promise.all(messages.map((m) => handle(m as Rpc, c.env, now())))).filter((r) => r !== null);
  if (replies.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]!);
});
