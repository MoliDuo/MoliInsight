export interface WireEvent {
  id: string;
  name: string;
  occurredAt: string;
  sessionId: string;
  route: string;
  props?: Record<string, unknown>;
}

export const BATCH = 100;
/** The server refuses more than 64 KB, and so does `sendBeacon`. */
const MAX_BYTES = 60_000;

export type Outcome =
  /** Done: take the events out of the queue. */
  | { kind: "sent" }
  /** The server will never take these: take them out too. */
  | { kind: "drop" }
  /** Keep them, try again after `waitMs`. */
  | { kind: "retry"; waitMs: number; /** A failure of the server or the network, which backs off further each time. */ failed: boolean };

const MINUTE = 60_000;

/** `fails` counts consecutive failures; the wait doubles from 15 s up to ten minutes. */
export const backoff = (fails: number): number => Math.min(15_000 * 2 ** (fails - 1), 10 * MINUTE);

/**
 * One request. The status decides what happens to the batch: 401 waits for a
 * sign-in, 429 waits as long as asked, 5xx and network errors back off, and
 * any other 4xx drops the batch because sending it again cannot succeed.
 */
export async function post(endpoint: string, body: unknown, fails: number): Promise<Outcome> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { kind: "sent" };
    if (res.status === 401) return { kind: "retry", waitMs: MINUTE, failed: false };
    if (res.status === 429) {
      const asked = Number(res.headers.get("retry-after"));
      return { kind: "retry", waitMs: Number.isFinite(asked) && asked > 0 ? asked * 1000 : MINUTE, failed: false };
    }
    if (res.status >= 500) return { kind: "retry", waitMs: backoff(fails + 1), failed: true };
    return { kind: "drop" };
  } catch {
    return { kind: "retry", waitMs: backoff(fails + 1), failed: true };
  }
}

/** How many of the first events fit one request: at most 100 and under the size limit. */
export const fit = (build: (events: WireEvent[]) => unknown, events: WireEvent[]): number => {
  let n = Math.min(BATCH, events.length);
  while (n > 1 && JSON.stringify(build(events.slice(0, n))).length > MAX_BYTES) n = Math.ceil(n / 2);
  return n;
};
