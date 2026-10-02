import { Hono } from "hono";
import { z } from "zod";
import { verifyPassword } from "./crypto.ts";
import type { AppEnv } from "./env.ts";
import { createKey } from "./keys.ts";
import { endSession, hasSession, requireSameOrigin, requireSession, startSession } from "./session.ts";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const slug = z.string().regex(/^[a-z0-9-]{1,40}$/);
const label = z.string().trim().max(80).default("");

const AppCreate = z.object({
  slug,
  name: z.string().trim().min(1).max(80),
  retentionDays: z.int().min(1).max(3650).default(90),
});
const AppPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  retentionDays: z.int().min(1).max(3650).optional(),
});
const KeyCreate = z.object({ label });
const PersonCreate = z.object({ name: z.string().trim().min(1).max(40) });
const DevicePatch = z.object({ personId: z.int().positive().nullable() });

async function json<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  let body: unknown = {};
  try {
    if (request.headers.get("content-length") !== "0") body = await request.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export const admin = new Hono<AppEnv>();

admin.use("/api/*", requireSameOrigin);

// ---------------------------------------------------------------------------
// session

admin.post("/api/login", async (c) => {
  const { now } = c.get("deps");
  const body = await json(c.req.raw, z.object({ password: z.string().max(200) }));
  if (!body) return c.json({ error: "invalid_request" }, 400);

  const since = now() - LOGIN_WINDOW_MS;
  const failures = await c.env.DB.prepare("SELECT count(*) AS n FROM login_failures WHERE at > ?1")
    .bind(since)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= LOGIN_MAX_FAILURES) {
    c.header("Retry-After", String(LOGIN_WINDOW_MS / 1000));
    return c.json({ error: "too_many_attempts" }, 429);
  }

  const ok =
    c.env.DASHBOARD_PASSWORD_HASH !== undefined &&
    c.env.SESSION_SECRET !== undefined &&
    (await verifyPassword(body.password, c.env.DASHBOARD_PASSWORD_HASH));
  if (!ok) {
    await c.env.DB.prepare("INSERT INTO login_failures (at) VALUES (?1)").bind(now()).run();
    return c.json({ error: "wrong_password" }, 401);
  }
  await startSession(c);
  return c.json({ ok: true });
});

admin.post("/api/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

admin.get("/api/me", async (c) => c.json({ authenticated: await hasSession(c) }));

admin.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/logout" || c.req.path === "/api/me") {
    return next();
  }
  return requireSession(c, next);
});

// ---------------------------------------------------------------------------
// apps

interface AppRow {
  id: number;
  slug: string;
  name: string;
  retention_days: number;
  created_at: number;
  last_event_at: number | null;
  device_count: number;
}

const appJson = (r: AppRow) => ({
  slug: r.slug,
  name: r.name,
  retentionDays: r.retention_days,
  createdAt: r.created_at,
  lastEventAt: r.last_event_at,
  deviceCount: r.device_count,
});

const APP_SELECT = `
  SELECT a.id, a.slug, a.name, a.retention_days, a.created_at,
         (SELECT max(occurred_at) FROM events WHERE app_id = a.id) AS last_event_at,
         (SELECT count(*) FROM devices WHERE app_id = a.id) AS device_count
  FROM apps a`;

admin.get("/api/apps", async (c) => {
  const { results } = await c.env.DB.prepare(`${APP_SELECT} ORDER BY a.slug`).all<AppRow>();
  return c.json({ apps: results.map(appJson) });
});

admin.post("/api/apps", async (c) => {
  const body = await json(c.req.raw, AppCreate);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const { now } = c.get("deps");
  try {
    await c.env.DB.prepare(
      "INSERT INTO apps (slug, name, retention_days, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(body.slug, body.name, body.retentionDays, now())
      .run();
  } catch (error) {
    if (String(error).includes("apps.slug")) return c.json({ error: "slug_taken" }, 409);
    throw error;
  }
  const row = await c.env.DB.prepare(`${APP_SELECT} WHERE a.slug = ?1`).bind(body.slug).first<AppRow>();
  return c.json(appJson(row!), 201);
});

admin.patch("/api/apps/:slug", async (c) => {
  const body = await json(c.req.raw, AppPatch);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const result = await c.env.DB.prepare(
    "UPDATE apps SET name = coalesce(?1, name), retention_days = coalesce(?2, retention_days) WHERE slug = ?3",
  )
    .bind(body.name ?? null, body.retentionDays ?? null, c.req.param("slug"))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(`${APP_SELECT} WHERE a.slug = ?1`)
    .bind(c.req.param("slug"))
    .first<AppRow>();
  return c.json(appJson(row!));
});

/** Deletes the app with all its keys, devices, sessions and events. */
admin.delete("/api/apps/:slug", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM apps WHERE slug = ?1").bind(c.req.param("slug")).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ingest keys

interface KeyRow {
  id: number;
  key_prefix: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const keyJson = (r: KeyRow) => ({
  id: r.id,
  prefix: r.key_prefix,
  label: r.label,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

admin.get("/api/apps/:slug/keys", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.key_prefix, k.label, k.created_at, k.last_used_at, k.revoked_at
     FROM app_keys k JOIN apps a ON a.id = k.app_id
     WHERE a.slug = ?1 ORDER BY k.id DESC`,
  )
    .bind(c.req.param("slug"))
    .all<KeyRow>();
  return c.json({ keys: results.map(keyJson) });
});

/** The key itself is in this response and nowhere else, ever again. */
admin.post("/api/apps/:slug/keys", async (c) => {
  const body = await json(c.req.raw, KeyCreate);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1")
    .bind(c.req.param("slug"))
    .first<{ id: number }>();
  if (!app) return c.json({ error: "not_found" }, 404);

  const created = await createKey("ingest", c.env.KEY_HMAC_SECRET);
  const { now } = c.get("deps");
  const inserted = await c.env.DB.prepare(
    "INSERT INTO app_keys (app_id, key_hash, key_prefix, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
  )
    .bind(app.id, created.hash, created.prefix, body.label, now())
    .first<{ id: number }>();
  return c.json({ id: inserted!.id, key: created.key, prefix: created.prefix }, 201);
});

admin.post("/api/keys/:id/revoke", async (c) => {
  const { now } = c.get("deps");
  const result = await c.env.DB.prepare(
    "UPDATE app_keys SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
  )
    .bind(now(), Number(c.req.param("id")))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// admin tokens

interface TokenRow {
  id: number;
  token_prefix: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

admin.get("/api/admin-tokens", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, token_prefix, label, created_at, last_used_at, revoked_at FROM admin_tokens ORDER BY id DESC",
  ).all<TokenRow>();
  return c.json({
    tokens: results.map((r) => ({
      id: r.id,
      prefix: r.token_prefix,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    })),
  });
});

admin.post("/api/admin-tokens", async (c) => {
  const body = await json(c.req.raw, KeyCreate);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const created = await createKey("admin", c.env.KEY_HMAC_SECRET);
  const { now } = c.get("deps");
  const inserted = await c.env.DB.prepare(
    "INSERT INTO admin_tokens (token_hash, token_prefix, label, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
  )
    .bind(created.hash, created.prefix, body.label, now())
    .first<{ id: number }>();
  return c.json({ id: inserted!.id, token: created.key, prefix: created.prefix }, 201);
});

admin.post("/api/admin-tokens/:id/revoke", async (c) => {
  const { now } = c.get("deps");
  const result = await c.env.DB.prepare(
    "UPDATE admin_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
  )
    .bind(now(), Number(c.req.param("id")))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// people and devices

admin.get("/api/people", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, (SELECT count(*) FROM devices WHERE person_id = p.id) AS device_count
     FROM people p ORDER BY p.name`,
  ).all<{ id: number; name: string; device_count: number }>();
  return c.json({ people: results.map((r) => ({ id: r.id, name: r.name, deviceCount: r.device_count })) });
});

admin.post("/api/people", async (c) => {
  const body = await json(c.req.raw, PersonCreate);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const { now } = c.get("deps");
  try {
    const row = await c.env.DB.prepare("INSERT INTO people (name, created_at) VALUES (?1, ?2) RETURNING id")
      .bind(body.name, now())
      .first<{ id: number }>();
    return c.json({ id: row!.id, name: body.name }, 201);
  } catch (error) {
    if (String(error).includes("people.name")) return c.json({ error: "name_taken" }, 409);
    throw error;
  }
});

admin.delete("/api/people/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM people WHERE id = ?1")
    .bind(Number(c.req.param("id")))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

interface DeviceRow {
  id: number;
  device_id: string;
  person_id: number | null;
  person_name: string | null;
  platform: string;
  device_class: string | null;
  os: string | null;
  client: string | null;
  first_seen_at: number;
  last_seen_at: number;
  last_release: string | null;
}

admin.get("/api/apps/:slug/devices", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.device_id, d.person_id, p.name AS person_name, d.platform, d.device_class,
            d.os, d.client, d.first_seen_at, d.last_seen_at, d.last_release
     FROM devices d
     JOIN apps a ON a.id = d.app_id
     LEFT JOIN people p ON p.id = d.person_id
     WHERE a.slug = ?1
     ORDER BY d.last_seen_at DESC
     LIMIT 200`,
  )
    .bind(c.req.param("slug"))
    .all<DeviceRow>();
  return c.json({
    devices: results.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      personId: r.person_id,
      personName: r.person_name,
      platform: r.platform,
      deviceClass: r.device_class,
      os: r.os,
      client: r.client,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastRelease: r.last_release,
    })),
  });
});

admin.put("/api/devices/:id", async (c) => {
  const body = await json(c.req.raw, DevicePatch);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  try {
    const result = await c.env.DB.prepare("UPDATE devices SET person_id = ?1 WHERE id = ?2")
      .bind(body.personId, Number(c.req.param("id")))
      .run();
    if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  } catch (error) {
    if (String(error).includes("FOREIGN KEY")) return c.json({ error: "person_not_found" }, 404);
    throw error;
  }
  return c.json({ ok: true });
});

/** Deletes the device with its sessions and events. */
admin.delete("/api/devices/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM devices WHERE id = ?1")
    .bind(Number(c.req.param("id")))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
