import { Hono } from "hono";
import { processIngest, type IngestResponse } from "@moli-insight/protocol";
import { audit, auditImport } from "./audit.ts";
import { BodyTooLarge, UnsupportedEncoding, readBodyText } from "./body.ts";
import { catalogCounts, parseCatalogRequest, saveCatalog } from "./catalog.ts";
import { dayOffset } from "./days.ts";
import type { AppEnv } from "./env.ts";
import { storeBatch } from "./ingest-store.ts";

/**
 * What the command line does with an ingest key, for the dashboard to do with its session:
 * upload an event catalog and import a client's log. They sit behind the same session and
 * same-origin checks as the rest of `/api/*` because `admin` is mounted before them.
 */
export const setup = new Hono<AppEnv>();

async function appId(db: D1Database, slug: string): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM apps WHERE slug = ?1").bind(slug).first<{ id: number }>();
  return row?.id ?? null;
}

/** `PUT /api/apps/:slug/catalog`: replaces the app's catalog. With `?dryRun=1` it only checks the file. */
setup.put("/api/apps/:slug/catalog", async (c) => {
  const id = await appId(c.env.DB, c.req.param("slug"));
  if (id === null) return c.json({ error: "not_found" }, 404);
  const parsed = await parseCatalogRequest(c.req.raw);
  if (!parsed.ok) return c.json(parsed.body, parsed.status);
  const dryRun = c.req.query("dryRun") === "1";
  if (!dryRun) {
    await saveCatalog(c.env.DB, id, parsed.catalog, c.get("deps").now());
    await audit(c, "catalog.replace", c.req.param("slug"), catalogCounts(parsed.catalog));
  }
  return c.json({ ok: true, dryRun, ...catalogCounts(parsed.catalog) });
});

/**
 * `POST /api/apps/:slug/import`: one ingest request, in the same format as `/v1/ingest`, stored
 * through the same path. The dashboard sends a log in batches. The device limiter is skipped:
 * this is the owner, not a client whose key leaked.
 */
setup.post("/api/apps/:slug/import", async (c) => {
  const id = await appId(c.env.DB, c.req.param("slug"));
  if (id === null) return c.json({ error: "not_found" }, 404);
  const receivedAt = c.get("deps").now();

  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(c.req.raw));
  } catch (error) {
    if (error instanceof BodyTooLarge) return c.json({ error: "payload_too_large" }, 413);
    if (error instanceof UnsupportedEncoding) return c.json({ error: "unsupported_encoding" }, 415);
    return c.json({ error: "invalid_json" }, 400);
  }
  const processed = processIngest(body, receivedAt);
  if (!processed.ok) return c.json({ error: processed.error }, 400);

  const stored = await storeBatch(c.env.DB, {
    appId: id,
    context: processed.context,
    events: processed.events.map((e) => e.event),
    receivedAt,
    dayOffsetMin: dayOffset(c.env.DAY_OFFSET_MINUTES),
  });
  const response: IngestResponse = { accepted: stored.accepted, duplicates: stored.duplicates, rejected: processed.rejected };
  await auditImport(c, c.req.param("slug"), { accepted: stored.accepted, duplicates: stored.duplicates, rejected: processed.rejected.length });
  return c.json(response);
});
