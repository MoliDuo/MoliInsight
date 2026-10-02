import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageLineToEvent } from "@moli-insight/protocol";
import { createHarness, type Harness } from "./harness.ts";

const lines = readFileSync(
  fileURLToPath(new URL("../../../packages/protocol/test/fixtures/moliswitch-usage.jsonl", import.meta.url).href),
  "utf8",
)
  .trim()
  .split("\n");

let h: Harness;
let key: string;
beforeAll(async () => {
  h = await createHarness();
  // The sample's last line is 2026-10-02T06:03:4x Z.
  h.clock.now = Date.parse("2026-10-02T06:04:00.000Z");
  key = await h.newApp("switch", await h.login());
});
afterAll(() => h.close());

async function importSample() {
  const events = [];
  for (const line of lines) events.push({ ...(await usageLineToEvent(line))!, sessionId: "ses_moliswitch01" });
  const response = await h.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({
      schemaVersion: 1,
      sentAt: new Date(h.clock.now).toISOString(),
      context: { platform: "macos", release: "0.2.57", deviceId: "dev_moliswitch01", deviceClass: "desktop" },
      events,
    }),
  });
  return (await response.json()) as { accepted: number; duplicates: number; rejected: unknown[] };
}

describe("MoliSwitch sample log through the worker", () => {
  it("imports, and importing again adds nothing", async () => {
    expect(await importSample()).toEqual({ accepted: 9, duplicates: 0, rejected: [] });
    expect(await importSample()).toEqual({ accepted: 0, duplicates: 9, rejected: [] });
    const n = await h.env.DB.prepare("SELECT count(*) AS n FROM events").first<{ n: number }>();
    expect(n!.n).toBe(9);
  });

  it("keeps nested props queryable", async () => {
    const row = await h.env.DB.prepare(
      "SELECT json_extract(props, '$.sinceFocusMs') AS v FROM events WHERE name = 'manualSwitch'",
    ).first<{ v: number }>();
    expect(row!.v).toBe(2410.6);
  });
});
