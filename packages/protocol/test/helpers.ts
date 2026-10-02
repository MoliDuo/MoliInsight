import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures", name), "utf8");
}

export const RECEIVED_AT = Date.parse("2026-10-02T08:00:01.000Z");

let counter = 0;
/** A valid event with a fresh UUID; fields can be overridden. */
export function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, "0");
  return {
    id: `01926f8e-3c2a-7b1d-9a4e-${suffix}`,
    name: "record.submit",
    occurredAt: "2026-10-02T07:59:58.120Z",
    sessionId: "ses_01J9ZK3Q9A1B",
    ...overrides,
  };
}

export function makeRequest(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sentAt: "2026-10-02T08:00:00.000Z",
    context: { platform: "web", release: "dae13efc", deviceId: "dev_01J9ZK3Q8X4V" },
    events,
    ...overrides,
  };
}
