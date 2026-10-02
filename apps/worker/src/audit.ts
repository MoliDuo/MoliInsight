import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { requireSession } from "./session.ts";

/** Audit rows are kept this long; the nightly retention run deletes older ones. */
export const AUDIT_DAYS = 365;
/** Batches of one import arrive as separate requests; those this close together are one row. */
const IMPORT_MERGE_MS = 30 * 60_000;

/**
 * Notes a change in the audit log under the signed-in user. A failure to write the note is
 * logged and swallowed: the change it describes has already happened.
 *
 * Never put a secret in `detail`; a key is its prefix.
 */
export async function audit(
  c: Context<AppEnv>,
  action: string,
  target = "",
  detail: Record<string, unknown> = {},
  user = c.get("user"),
): Promise<void> {
  if (!user) return;
  try {
    await c.env.DB.prepare("INSERT INTO audit_log (at, user, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(c.get("deps").now(), user, action, target, JSON.stringify(detail))
      .run();
  } catch (error) {
    console.error("audit write failed", action, error);
  }
}

/** A log is imported in many requests; they add up in one row for as long as they keep coming. */
export async function auditImport(c: Context<AppEnv>, app: string, counts: { accepted: number; duplicates: number; rejected: number }): Promise<void> {
  const user = c.get("user");
  if (!user) return;
  const now = c.get("deps").now();
  try {
    const last = await c.env.DB.prepare(
      "SELECT id, detail FROM audit_log WHERE action = 'import' AND user = ?1 AND target = ?2 AND at > ?3 ORDER BY id DESC LIMIT 1",
    ).bind(user, app, now - IMPORT_MERGE_MS).first<{ id: number; detail: string }>();
    if (!last) return await audit(c, "import", app, { batches: 1, ...counts });
    const before = JSON.parse(last.detail) as { batches: number; accepted: number; duplicates: number; rejected: number };
    const after = {
      batches: before.batches + 1,
      accepted: before.accepted + counts.accepted,
      duplicates: before.duplicates + counts.duplicates,
      rejected: before.rejected + counts.rejected,
    };
    await c.env.DB.prepare("UPDATE audit_log SET at = ?1, detail = ?2 WHERE id = ?3").bind(now, JSON.stringify(after), last.id).run();
  } catch (error) {
    console.error("audit write failed", "import", error);
  }
}

const PAGE = 50;

export const auditRoutes = new Hono<AppEnv>();

/** `GET /api/audit?before=<id>&user=<name>`: newest first, `next` is the cursor for the page after. */
auditRoutes.get("/api/audit", requireSession, async (c) => {
  const before = Number(c.req.query("before"));
  const user = c.req.query("user");
  const { results } = await c.env.DB.prepare(
    `SELECT id, at, user, action, target, detail FROM audit_log
     WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR user = ?2)
     ORDER BY id DESC LIMIT ?3`,
  )
    .bind(Number.isInteger(before) && before > 0 ? before : null, user || null, PAGE + 1)
    .all<{ id: number; at: number; user: string; action: string; target: string; detail: string }>();
  const page = results.slice(0, PAGE);
  const users = await c.env.DB.prepare("SELECT DISTINCT user FROM audit_log ORDER BY user").all<{ user: string }>();
  return c.json({
    entries: page.map((r) => ({ id: r.id, at: r.at, user: r.user, action: r.action, target: r.target, detail: JSON.parse(r.detail) as unknown })),
    next: results.length > PAGE ? String(page[page.length - 1]!.id) : null,
    users: users.results.map((r) => r.user),
  });
});
