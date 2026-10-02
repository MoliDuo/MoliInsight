import { DAY_MS, addDays, dayOf, dayStart } from "./days.ts";

/** Events that arrive in volume and are only worth keeping raw for a short time. */
export const HIGH_FREQUENCY_EVENTS = ["$tap", "$visibility"];
export const HIGH_FREQUENCY_DAYS = 30;

/** Days at the end of the rolled-up range that are rebuilt each night, for late arrivals. */
const REBUILD_DAYS = 3;

export interface RollupOptions {
  /** Days rebuilt per run, over all apps. A D1 batch counts once against a Worker's query limit. */
  maxDays?: number;
}

export interface RollupResult {
  daysRolled: number;
  /** The run stopped at its limit, not because everything was up to date. */
  more: boolean;
}

/**
 * Counts raw events per local day into `daily_events`, from where an app left off up to
 * yesterday. The last few days are rebuilt each time. A day's rows are replaced only for the
 * names still present in raw events, so counts of pruned high-frequency events survive.
 */
export async function runRollup(
  db: D1Database,
  nowMs: number,
  offsetMin: number,
  { maxDays = 14 }: RollupOptions = {},
): Promise<RollupResult> {
  const yesterday = addDays(dayOf(nowMs, offsetMin), -1);
  const { results: apps } = await db
    .prepare("SELECT id, rollup_through FROM apps")
    .all<{ id: number; rollup_through: string | null }>();

  let budget = maxDays;
  let rolled = 0;
  let more = false;

  for (const app of apps) {
    let first: string;
    if (app.rollup_through) {
      first = addDays(app.rollup_through, -(REBUILD_DAYS - 1));
    } else {
      const oldest = await db
        .prepare("SELECT min(occurred_at) AS at FROM events WHERE app_id = ?1")
        .bind(app.id)
        .first<{ at: number | null }>();
      if (oldest?.at == null) {
        await db.prepare("UPDATE apps SET rollup_through = ?1 WHERE id = ?2").bind(yesterday, app.id).run();
        continue;
      }
      first = dayOf(oldest.at, offsetMin);
    }
    if (first > yesterday) continue;

    let last = first;
    for (let day = first; day <= yesterday; day = addDays(day, 1)) {
      if (budget === 0) {
        more = true;
        break;
      }
      budget -= 1;
      rolled += 1;
      const from = dayStart(day, offsetMin);
      const to = from + DAY_MS;
      await db.batch([
        db
          .prepare(
            `DELETE FROM daily_events WHERE app_id = ?1 AND day = ?2 AND name IN (
               SELECT DISTINCT name FROM events WHERE app_id = ?1 AND occurred_at >= ?3 AND occurred_at < ?4)`,
          )
          .bind(app.id, day, from, to),
        db
          .prepare(
            `INSERT INTO daily_events (app_id, day, name, platform, release, events)
             SELECT app_id, ?2, name, platform, release, count(*) FROM events
             WHERE app_id = ?1 AND occurred_at >= ?3 AND occurred_at < ?4
             GROUP BY name, platform, release`,
          )
          .bind(app.id, day, from, to),
      ]);
      last = day;
    }
    await db
      .prepare(
        `UPDATE apps SET rollup_through = ?1
         WHERE id = ?2 AND (rollup_through IS NULL OR rollup_through < ?1)`,
      )
      .bind(last, app.id)
      .run();
  }
  return { daysRolled: rolled, more };
}

/**
 * Called when events older than the rolled-up range arrive (an import, a client that was
 * offline for days): moves the mark back so the next run counts those days again.
 */
export function reopenRollup(
  db: D1Database,
  appId: number,
  oldestOccurredAt: number,
  offsetMin: number,
): D1PreparedStatement {
  const day = dayOf(oldestOccurredAt, offsetMin);
  // Days inside the nightly rebuild window need no help.
  return db
    .prepare("UPDATE apps SET rollup_through = ?1 WHERE id = ?2 AND rollup_through >= ?3")
    .bind(addDays(day, -1), appId, addDays(day, REBUILD_DAYS));
}
