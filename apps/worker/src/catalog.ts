import { Hono } from "hono";
import { CatalogSchema, FunnelSchema, type Catalog } from "@moli-insight/protocol";
import { z } from "zod";
import { BodyTooLarge, UnsupportedEncoding, readBodyText } from "./body.ts";
import type { AppEnv } from "./env.ts";
import { authenticateIngestKey, bearerToken } from "./keys.ts";

/** An app's catalog as the app uploaded it, or null if it never did. */
export async function loadCatalog(db: D1Database, appId: number): Promise<Catalog | null> {
  const { results } = await db
    .prepare("SELECT kind, definition FROM catalog_entries WHERE app_id = ?1 ORDER BY kind, name")
    .bind(appId)
    .all<{ kind: "event" | "metric" | "funnel"; definition: string }>();
  if (results.length === 0) return null;
  const catalog: Catalog = { schemaVersion: 1, events: [], metrics: [], funnels: [] };
  for (const r of results) {
    const definition = JSON.parse(r.definition);
    if (r.kind === "event") catalog.events.push(definition);
    else if (r.kind === "metric") catalog.metrics!.push(definition);
    else catalog.funnels!.push(definition);
  }
  return catalog;
}

const ROWS_PER_STATEMENT = 19; // five bound values per row, 100 per statement

/** Replaces an app's catalog. One batch, so readers see the old catalog or the new one. */
export async function saveCatalog(db: D1Database, appId: number, catalog: Catalog, now: number): Promise<void> {
  const rows: [string, string, string][] = [
    ...catalog.events.map((e) => ["event", e.name, JSON.stringify(e)] as [string, string, string]),
    ...(catalog.metrics ?? []).map((m) => ["metric", m.name, JSON.stringify(m)] as [string, string, string]),
    ...(catalog.funnels ?? []).map((f) => ["funnel", f.name, JSON.stringify(f)] as [string, string, string]),
  ];
  const statements = [db.prepare("DELETE FROM catalog_entries WHERE app_id = ?1").bind(appId)];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const part = rows.slice(i, i + ROWS_PER_STATEMENT);
    const values = part.map((_, k) => `(?1, ?${2 + k * 3}, ?${3 + k * 3}, ?${4 + k * 3}, ?${2 + part.length * 3})`).join(", ");
    statements.push(
      db
        .prepare(`INSERT INTO catalog_entries (app_id, kind, name, definition, updated_at) VALUES ${values}`)
        .bind(appId, ...part.flat(), now),
    );
  }
  await db.batch(statements);
}

// ---------------------------------------------------------------------------
// funnels saved from the dashboard

export const SavedFunnelSchema = FunnelSchema.omit({ name: true });
export type SavedFunnel = z.infer<typeof SavedFunnelSchema> & { name: string };

export async function loadSavedFunnels(db: D1Database, appId: number): Promise<SavedFunnel[]> {
  const { results } = await db
    .prepare("SELECT name, definition FROM saved_funnels WHERE app_id = ?1 ORDER BY name")
    .bind(appId)
    .all<{ name: string; definition: string }>();
  return results.map((r) => ({ ...(JSON.parse(r.definition) as z.infer<typeof SavedFunnelSchema>), name: r.name }));
}

// ---------------------------------------------------------------------------

/** `PUT /v1/catalog`: an app uploads its event catalog with its ingest key. */
export const catalogRoutes = new Hono<AppEnv>();

const CATALOG_LIMITS = { sent: 256 * 1024, decompressed: 512 * 1024 };

catalogRoutes.put("/v1/catalog", async (c) => {
  const { now } = c.get("deps");
  const token = bearerToken(c.req.raw);
  const auth = token ? await authenticateIngestKey(c.env, token, now(), (p) => c.executionCtx.waitUntil(p)) : null;
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  if (c.env.INGEST_LIMITER) {
    const { success } = await c.env.INGEST_LIMITER.limit({ key: `key:${auth.keyId}` });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
  }

  let text: string;
  try {
    text = await readBodyText(c.req.raw, CATALOG_LIMITS);
  } catch (error) {
    if (error instanceof BodyTooLarge) return c.json({ error: "payload_too_large" }, 413);
    if (error instanceof UnsupportedEncoding) return c.json({ error: "unsupported_encoding" }, 415);
    return c.json({ error: "invalid_request" }, 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_request", message: "the body is not JSON" }, 400);
  }
  const parsed = CatalogSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_catalog", issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) },
      400,
    );
  }
  await saveCatalog(c.env.DB, auth.appId, parsed.data, now());
  return c.json({ ok: true, events: parsed.data.events.length, metrics: parsed.data.metrics?.length ?? 0, funnels: parsed.data.funnels?.length ?? 0 });
});
