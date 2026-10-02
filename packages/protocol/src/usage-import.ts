import { deterministicUuid, usageLineToEvent, type ImportedEvent } from "./import.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The server clamps older events to its seven-day floor, so sending them only distorts the data. */
export const MAX_AGE_MS = 7 * DAY_MS;
export const BATCH_SIZE = 100;

export type ImportPlatform = "web" | "ios" | "android" | "windows" | "macos" | "server";

export interface UsageImportOptions {
  platform: ImportPlatform;
  deviceId: string;
  /** Overrides the release found in `appStart`. */
  release?: string;
  /** Only these event names. */
  include?: ReadonlySet<string>;
  /** Not these event names. */
  exclude?: ReadonlySet<string>;
}

export interface UsageImportCounts {
  lines: number;
  /** Lines that are not a usage event. */
  unreadable: number;
  filtered: number;
  /** Older than the server accepts. */
  tooOld: number;
}

export interface UsageImportPlan extends UsageImportCounts {
  /** Ingest requests, at most `BATCH_SIZE` events each, in the order to send them. */
  batches: Record<string, unknown>[];
  /** Events across all batches. */
  events: number;
}

interface Group {
  release: string;
  sessionId: string;
  os?: string;
  locale?: string;
  timeZone?: string;
  events: (ImportedEvent & { sessionId: string })[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

async function sessionIdFor(deviceId: string, startedAt: string): Promise<string> {
  const hash = (await deterministicUuid(`${deviceId}|${startedAt}`)).replaceAll("-", "");
  return `ses_${hash.slice(0, 20)}`;
}

/**
 * A process run is a session: every `appStart` opens one, and its version,
 * OS and locale describe the batches that follow until the next `appStart`.
 */
async function group(lines: string[], options: UsageImportOptions, counts: UsageImportCounts, nowMs: number): Promise<Group[]> {
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    counts.lines += 1;
    const event = await usageLineToEvent(line);
    if (!event) {
      counts.unreadable += 1;
      continue;
    }
    const at = Date.parse(event.occurredAt);
    if (Number.isNaN(at)) {
      counts.unreadable += 1;
      continue;
    }

    if (event.name === "appStart" || current === null) {
      const props = (event.name === "appStart" ? event.props : undefined) ?? {};
      current = {
        release: options.release ?? str(props.version) ?? "unknown",
        sessionId: await sessionIdFor(options.deviceId, event.occurredAt),
        ...(str(props.macOS) ? { os: String(props.macOS).replace(/^Version\s+/, "").replace(/\s*\(.*$/, "") } : {}),
        ...(str(props.locale) ? { locale: str(props.locale)! } : {}),
        ...(str(props.timeZone) ? { timeZone: str(props.timeZone)! } : {}),
        events: [],
      };
      groups.push(current);
      // A process run is a session, so the standard event that says so goes in with it.
      // Its id comes from the line too: importing again must not add a second one.
      const fresh = nowMs - at <= MAX_AGE_MS;
      if (fresh && !options.exclude?.has("$session_start") && (!options.include || options.include.has("$session_start"))) {
        current.events.push({
          id: await deterministicUuid(`session|${line}`),
          name: "$session_start",
          occurredAt: event.occurredAt,
          props: { navType: "launch" },
          sessionId: current.sessionId,
        });
      }
    }

    if (options.include && !options.include.has(event.name)) {
      counts.filtered += 1;
    } else if (options.exclude?.has(event.name)) {
      counts.filtered += 1;
    } else if (nowMs - at > MAX_AGE_MS) {
      counts.tooOld += 1;
    } else {
      current.events.push({ ...event, sessionId: current.sessionId });
    }
  }
  return groups;
}

/**
 * Turns the text of a MoliSwitch usage log into ingest requests. Nothing is sent here, so the
 * command line and the dashboard share it. The same lines always produce the same event and
 * session ids, so importing a file twice adds nothing.
 */
export async function planUsageImport(text: string, options: UsageImportOptions, nowMs: number): Promise<UsageImportPlan> {
  const counts: UsageImportCounts = { lines: 0, unreadable: 0, filtered: 0, tooOld: 0 };
  const groups = await group(text.split("\n"), options, counts, nowMs);
  const batches: Record<string, unknown>[] = [];
  let events = 0;

  for (const g of groups) {
    for (let i = 0; i < g.events.length; i += BATCH_SIZE) {
      const part = g.events.slice(i, i + BATCH_SIZE);
      events += part.length;
      batches.push({
        schemaVersion: 1,
        sentAt: new Date(nowMs).toISOString(),
        context: {
          platform: options.platform,
          release: g.release,
          deviceId: options.deviceId,
          ...(options.platform === "macos" || options.platform === "windows" ? { deviceClass: "desktop" } : {}),
          ...(g.os ? { os: `macOS ${g.os}` } : {}),
          ...(g.locale ? { locale: g.locale } : {}),
          ...(g.timeZone ? { timeZone: g.timeZone } : {}),
        },
        events: part,
      });
    }
  }
  return { ...counts, batches, events };
}
