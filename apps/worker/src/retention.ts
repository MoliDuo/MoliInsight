import { DAY_MS, addDays, dayOf, dayStart } from "./days.ts";
import { HIGH_FREQUENCY_DAYS, HIGH_FREQUENCY_EVENTS } from "./rollup.ts";

export interface RetentionOptions {
  /** Rows per DELETE. */
  batchSize?: number;
  /**
   * DELETE statements per run. On the free plan a Worker may make 50 queries
   * per invocation, so a backlog is worked off over several nights.
   */
  maxBatches?: number;
  /** The deployment's day boundary in minutes east of UTC; high-frequency events are pruned by whole days. */
  dayOffsetMinutes?: number;
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
  { batchSize = 1000, maxBatches = 40, dayOffsetMinutes = 0 }: RetentionOptions = {},
): Promise<RetentionResult> {
  const { results: apps } = await db
    .prepare("SELECT id, retention_days, rollup_through FROM apps")
    .all<{ id: number; retention_days: number; rollup_through: string | null }>();

  let eventsDeleted = 0;
  let sessionsDeleted = 0;
  let batches = 0;
  let more = false;

  for (const app of apps) {
    const cutoff = nowMs - app.retention_days * DAY_MS;

    // Taps and visibility changes pile up and are only wanted raw for a while. They are cut at
    // a day boundary, and only once those days are in daily_events, so their counts survive.
    const pruneDay = dayOf(nowMs - HIGH_FREQUENCY_DAYS * DAY_MS, dayOffsetMinutes);
    if (app.rollup_through !== null && app.rollup_through >= addDays(pruneDay, -1)) {
      const marks = HIGH_FREQUENCY_EVENTS.map((_, i) => `?${i + 3}`).join(", ");
      for (;;) {
        if (batches >= maxBatches) {
          more = true;
          break;
        }
        batches += 1;
        const result = await db
          .prepare(
            `DELETE FROM events WHERE id IN (
               SELECT id FROM events WHERE app_id = ?1 AND occurred_at < ?2 AND name IN (${marks}) LIMIT ${batchSize})`,
          )
          .bind(app.id, dayStart(pruneDay, dayOffsetMinutes), ...HIGH_FREQUENCY_EVENTS)
          .run();
        eventsDeleted += result.meta.changes;
        if (result.meta.changes < batchSize) break;
      }
    }

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
    if (batches < maxBatches) {
      batches += 1;
      await db
        .prepare("DELETE FROM daily_events WHERE app_id = ?1 AND day < ?2")
        .bind(app.id, dayOf(cutoff, dayOffsetMinutes))
        .run();
    }
  }

  await db.prepare("DELETE FROM login_failures WHERE at < ?1").bind(nowMs - DAY_MS).run();
  return { eventsDeleted, sessionsDeleted, more };
}
