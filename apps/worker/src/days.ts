const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The deployment's day boundary, as minutes east of UTC. Unset means UTC. */
export function dayOffset(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && Math.abs(n) <= 14 * 60 ? n : 0;
}

/** `YYYY-MM-DD` of an instant, in the day boundary's time zone. */
export function dayOf(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * MINUTE_MS).toISOString().slice(0, 10);
}

/** The instant a local day begins. */
export function dayStart(day: string, offsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMin * MINUTE_MS;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function isDay(value: string): boolean {
  return DAY_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && addDays(value, 0) === value;
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}
