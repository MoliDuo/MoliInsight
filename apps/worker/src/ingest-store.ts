import type { Context, NormalizedEvent } from "@moli-insight/protocol";

/**
 * D1 allows 100 bound parameters per statement. Events go in several rows per
 * statement: the values every row shares are bound once and reused by number
 * (?1…?5), so a row costs 8 parameters and a statement holds 11 rows.
 */
const EVENT_ROWS_PER_STATEMENT = 11;
const SESSION_ROWS_PER_STATEMENT = 24;

export interface StoreInput {
  appId: number;
  context: Context;
  events: NormalizedEvent[];
  receivedAt: number;
}

export interface StoreResult {
  /** Events that were new. */
  accepted: number;
  /** Events whose id the app had already sent. */
  duplicates: number;
}

const DEVICE_REF = "(SELECT id FROM devices WHERE app_id = ?1 AND device_id = ?5)";

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Writes one validated batch: the device, then the events, then the sessions.
 *
 * `INSERT OR IGNORE … RETURNING` hands back only the rows that were actually
 * inserted. That gives an exact duplicate count and exact per-session counts,
 * so a retried batch does not inflate a session's event count.
 */
export async function storeBatch(db: D1Database, input: StoreInput): Promise<StoreResult> {
  const { appId, context, events, receivedAt } = input;
  if (events.length === 0) return { accepted: 0, duplicates: 0 };

  const deviceId = context.deviceId ?? null;
  const firstOccurred = Math.min(...events.map((e) => e.occurredAtMs));

  const statements: D1PreparedStatement[] = [];
  if (deviceId !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO devices
             (app_id, device_id, platform, device_class, os, client, locale, time_zone,
              first_seen_at, last_seen_at, last_release)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (app_id, device_id) DO UPDATE SET
             platform     = excluded.platform,
             device_class = coalesce(excluded.device_class, device_class),
             os           = coalesce(excluded.os, os),
             client       = coalesce(excluded.client, client),
             locale       = coalesce(excluded.locale, locale),
             time_zone    = coalesce(excluded.time_zone, time_zone),
             first_seen_at = min(first_seen_at, excluded.first_seen_at),
             last_seen_at = max(last_seen_at, excluded.last_seen_at),
             last_release = excluded.last_release`,
        )
        .bind(
          appId,
          deviceId,
          context.platform,
          context.deviceClass ?? null,
          context.os ?? null,
          context.client ?? null,
          context.locale ?? null,
          context.timeZone ?? null,
          firstOccurred,
          receivedAt,
          context.release,
        ),
    );
  }
  const eventStatementCount = Math.ceil(events.length / EVENT_ROWS_PER_STATEMENT);

  for (const rows of chunk(events, EVENT_ROWS_PER_STATEMENT)) {
    const values = rows.map((_, i) => {
      const b = 6 + i * 8;
      return (
        `(?1, ?${b}, ?${b + 1}, ?${b + 2}, ?2, ?${b + 3}, ?3, ?4, ${DEVICE_REF}, ` +
        `?${b + 4}, ?${b + 5}, ?${b + 6}, ?${b + 7})`
      );
    });
    const bindings: unknown[] = [appId, receivedAt, context.platform, context.release, deviceId];
    for (const e of rows) {
      bindings.push(
        e.id,
        e.name,
        e.occurredAtMs,
        e.mono ?? null,
        e.sessionId ?? null,
        e.correlationId ?? null,
        e.route ?? null,
        e.props === undefined ? null : JSON.stringify(e.props),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO events
             (app_id, event_id, name, occurred_at, received_at, mono, platform, release,
              device_ref, session_id, correlation_id, route, props)
           VALUES ${values.join(", ")}
           RETURNING session_id, occurred_at`,
        )
        .bind(...bindings),
    );
  }

  const results = await db.batch<{ session_id: string | null; occurred_at: number }>(statements);
  const eventResults = results.slice(results.length - eventStatementCount);

  const sessions = new Map<string, { count: number; first: number; last: number }>();
  let accepted = 0;
  for (const result of eventResults) {
    for (const row of result.results) {
      accepted += 1;
      if (row.session_id === null) continue;
      const session = sessions.get(row.session_id);
      if (session) {
        session.count += 1;
        session.first = Math.min(session.first, row.occurred_at);
        session.last = Math.max(session.last, row.occurred_at);
      } else {
        sessions.set(row.session_id, { count: 1, first: row.occurred_at, last: row.occurred_at });
      }
    }
  }

  if (sessions.size > 0) {
    const sessionStatements = chunk([...sessions], SESSION_ROWS_PER_STATEMENT).map((rows) => {
      const values = rows.map((_, i) => {
        const b = 4 + i * 4;
        return `(?1, ?${b}, (SELECT id FROM devices WHERE app_id = ?1 AND device_id = ?3), ?2, ?${b + 1}, ?${b + 2}, ?${b + 3})`;
      });
      const bindings: unknown[] = [appId, context.release, deviceId];
      for (const [sessionId, s] of rows) bindings.push(sessionId, s.first, s.last, s.count);
      return db
        .prepare(
          `INSERT INTO sessions
             (app_id, session_id, device_ref, release, started_at, last_event_at, event_count)
           VALUES ${values.join(", ")}
           ON CONFLICT (app_id, session_id) DO UPDATE SET
             device_ref    = coalesce(device_ref, excluded.device_ref),
             started_at    = min(started_at, excluded.started_at),
             last_event_at = max(last_event_at, excluded.last_event_at),
             event_count   = event_count + excluded.event_count`,
        )
        .bind(...bindings);
    });
    await db.batch(sessionStatements);
  }

  return { accepted, duplicates: events.length - accepted };
}
