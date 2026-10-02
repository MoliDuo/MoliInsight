const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
  /** Rows per DELETE. */
  batchSize?: number;
  /**
   * DELETE statements per run. On the free plan a Worker may make 50 queries
   * per invocation, so a backlog is worked off over several nights.
   */
  maxBatches?: number;
}

export interface RetentionResult {
  eventsDeleted: number;
  sessionsDeleted: number;
  /** Batches still to do: the run stopped at its limit, not because the data ran out. */
  more: boolean;
}

/**
 * Deletes what is older than each app's retention, in batches so one run never
 * holds the database for long, and clears old login failures.
 */
export async function runRetention(
  db: D1Database,
  nowMs: number,
  { batchSize = 1000, maxBatches = 40 }: RetentionOptions = {},
): Promise<RetentionResult> {
  const { results: apps } = await db
    .prepare("SELECT id, retention_days FROM apps")
    .all<{ id: number; retention_days: number }>();

  let eventsDeleted = 0;
  let sessionsDeleted = 0;
  let batches = 0;
  let more = false;

  for (const app of apps) {
    const cutoff = nowMs - app.retention_days * DAY_MS;

    for (;;) {
      if (batches >= maxBatches) {
        more = true;
        break;
      }
      batches += 1;
      const result = await db
        .prepare(
          `DELETE FROM events WHERE id IN (
             SELECT id FROM events WHERE app_id = ?1 AND occurred_at < ?2 LIMIT ?3)`,
        )
        .bind(app.id, cutoff, batchSize)
        .run();
      eventsDeleted += result.meta.changes;
      if (result.meta.changes < batchSize) break;
    }

    if (batches < maxBatches) {
      batches += 1;
      const result = await db
        .prepare("DELETE FROM sessions WHERE app_id = ?1 AND last_event_at < ?2")
        .bind(app.id, cutoff)
        .run();
      sessionsDeleted += result.meta.changes;
    }
  }

  await db.prepare("DELETE FROM login_failures WHERE at < ?1").bind(nowMs - DAY_MS).run();
  return { eventsDeleted, sessionsDeleted, more };
}
