import { LIMITS } from "./limits.ts";

/**
 * How far the client's clock is behind the server's: positive when the client
 * is behind. `sentAt` is set when the request is sent, so the gap between
 * `sentAt` and the receive time is the clock error plus network latency.
 */
export function clockSkewMs(sentAt: string, receivedAtMs: number): number {
  const sent = Date.parse(sentAt);
  return Number.isFinite(sent) ? receivedAtMs - sent : 0;
}

export interface CorrectedTime {
  ms: number;
  /** True when the corrected time still fell outside the allowed window. */
  clamped: boolean;
}

/**
 * Shifts an event time by the batch's clock skew, then holds it inside the
 * window the server accepts: no more than 5 minutes after the receive time and
 * no more than 7 days before it.
 */
export function correctOccurredAt(
  occurredAtMs: number,
  skewMs: number,
  receivedAtMs: number,
): CorrectedTime {
  const shifted = occurredAtMs + skewMs;
  const latest = receivedAtMs + LIMITS.maxFutureMs;
  const earliest = receivedAtMs - LIMITS.maxPastMs;
  if (shifted > latest) return { ms: latest, clamped: true };
  if (shifted < earliest) return { ms: earliest, clamped: true };
  return { ms: shifted, clamped: false };
}
