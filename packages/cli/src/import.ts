import { BATCH_SIZE, MAX_AGE_MS, planUsageImport } from "@moli-insight/protocol";

export { BATCH_SIZE, MAX_AGE_MS };

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
  const nowMs = (options.now ?? Date.now)();
  const plan = await planUsageImport(text, options, nowMs);
  const summary: ImportSummary = {
    lines: plan.lines,
    unreadable: plan.unreadable,
    filtered: plan.filtered,
    tooOld: plan.tooOld,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    batches: 0,
  };

  for (const body of plan.batches) {
    summary.batches += 1;
    if (options.dryRun) {
      summary.accepted += (body.events as unknown[]).length;
      continue;
    }
    const result = await sendBatch(body, options);
    summary.accepted += result.accepted;
    summary.duplicates += result.duplicates;
    summary.rejected += result.rejected;
    options.log?.(`batch ${summary.batches}: +${result.accepted}, ${result.duplicates} already there, ${result.rejected} rejected`);
  }
  return summary;
}
