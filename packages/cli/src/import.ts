import { deterministicUuid, usageLineToEvent, type ImportedEvent } from "@moli-insight/protocol";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The server clamps older events to its seven-day floor, so sending them only distorts the data. */
export const MAX_AGE_MS = 7 * DAY_MS;
export const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 60_000;

export interface ImportOptions {
  url: string;
  key: string;
  platform: "web" | "ios" | "android" | "windows" | "macos" | "server";
  deviceId: string;
  /** Overrides the release found in `appStart`. */
  release?: string;
  /** Only these event names. */
  include?: ReadonlySet<string>;
  /** Not these event names. */
  exclude?: ReadonlySet<string>;
  dryRun?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ImportSummary {
  lines: number;
  /** Lines that are not a usage event. */
  unreadable: number;
  filtered: number;
  /** Older than the server accepts. */
  tooOld: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  batches: number;
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
async function group(
  lines: string[],
  options: ImportOptions,
  summary: ImportSummary,
  nowMs: number,
): Promise<Group[]> {
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    summary.lines += 1;
    const event = await usageLineToEvent(line);
    if (!event) {
      summary.unreadable += 1;
      continue;
    }
    const at = Date.parse(event.occurredAt);
    if (Number.isNaN(at)) {
      summary.unreadable += 1;
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
    }

    if (options.include && !options.include.has(event.name)) {
      summary.filtered += 1;
    } else if (options.exclude?.has(event.name)) {
      summary.filtered += 1;
    } else if (nowMs - at > MAX_AGE_MS) {
      summary.tooOld += 1;
    } else {
      current.events.push({ ...event, sessionId: current.sessionId });
    }
  }
  return groups;
}

async function sendBatch(body: unknown, options: ImportOptions): Promise<{ accepted: number; duplicates: number; rejected: number }> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const endpoint = new URL("/v1/ingest", options.url);

  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.key}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`network error: ${String(error)}`);
    }

    if (response?.ok) {
      const json = (await response.json()) as { accepted: number; duplicates: number; rejected: unknown[] };
      return { accepted: json.accepted, duplicates: json.duplicates, rejected: json.rejected.length };
    }
    if (response) {
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new Error(`the server answered ${response.status}: ${await response.text()}`);
      }
    }
    const retryAfter = Number(response?.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
    await sleep(Math.min(wait, MAX_WAIT_MS));
  }
}

/** Imports the text of one JSONL file. Safe to run again: the same lines produce the same event ids. */
export async function importUsageLog(text: string, options: ImportOptions): Promise<ImportSummary> {
  const summary: ImportSummary = {
    lines: 0,
    unreadable: 0,
    filtered: 0,
    tooOld: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    batches: 0,
  };
  const nowMs = (options.now ?? Date.now)();
  const groups = await group(text.split("\n"), options, summary, nowMs);

  for (const g of groups) {
    for (let i = 0; i < g.events.length; i += BATCH_SIZE) {
      const events = g.events.slice(i, i + BATCH_SIZE);
      summary.batches += 1;
      if (options.dryRun) {
        summary.accepted += events.length;
        continue;
      }
      const body = {
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
        events,
      };
      const result = await sendBatch(body, options);
      summary.accepted += result.accepted;
      summary.duplicates += result.duplicates;
      summary.rejected += result.rejected;
      options.log?.(`batch ${summary.batches}: +${result.accepted}, ${result.duplicates} already there, ${result.rejected} rejected`);
    }
  }
  return summary;
}
