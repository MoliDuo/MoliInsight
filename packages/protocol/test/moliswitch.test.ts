import { describe, expect, it } from "vitest";
import {
  IngestRequestSchema,
  LIMITS,
  deterministicUuid,
  processIngest,
  usageLineToEvent,
} from "../src/index.ts";
import { fixture } from "./helpers.ts";

/**
 * MoliSwitch is a native macOS background program with no backend. Its local
 * usage log has to fit the protocol without changing its format: these lines
 * are shaped like the ones its AppRuntime writes.
 */
const lines = fixture("moliswitch-usage.jsonl").trim().split("\n");
const context = {
  platform: "macos",
  release: "0.2.57",
  deviceId: "dev_01J9ZK3Q8X4V",
  deviceClass: "desktop",
  os: "macOS 26.0",
  client: "MoliSwitch 0.2.57",
  locale: "zh_CN",
  timeZone: "Asia/Shanghai",
};
const SESSION = "ses_01J9ZK3QMOLI";
const RECEIVED_AT = Date.parse("2026-10-02T06:04:00.000Z");

async function convert() {
  const events = [];
  for (const line of lines) {
    const event = await usageLineToEvent(line);
    expect(event).not.toBeNull();
    events.push({ ...event!, sessionId: SESSION });
  }
  return events;
}

describe("MoliSwitch usage log", () => {
  it("maps every line onto an event", async () => {
    const events = await convert();
    expect(events.map((e) => e.name)).toEqual([
      "appStart",
      "setting",
      "switch",
      "switch",
      "manualSwitch",
      "fieldFocus",
      "systemInputSourceChanged",
      "snapshot",
      "error",
    ]);
    expect(events[4]).toMatchObject({
      name: "manualSwitch",
      occurredAt: "2026-10-02T14:03:21.018+08:00",
      mono: 84224350.1,
      props: { sinceFocusMs: 2410.6, app: "com.tinyspeck.slackmacgap" },
    });
  });

  it("is a valid ingest request, snapshot included", async () => {
    const request = {
      schemaVersion: 1,
      sentAt: "2026-10-02T14:03:40.000+08:00",
      context,
      events: await convert(),
    };
    expect(IngestRequestSchema.safeParse(request).success).toBe(true);
  });

  it("is accepted event by event", async () => {
    const request = {
      schemaVersion: 1,
      sentAt: "2026-10-02T14:03:40.000+08:00",
      context,
      events: await convert(),
    };
    const result = processIngest(request, RECEIVED_AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toEqual([]);
    expect(result.events).toHaveLength(lines.length);
    // 14:03:21.018+08:00 is 06:03:21.018Z. The request says it was sent at 06:03:40Z and
    // arrives at 06:04:00Z, so the clock is 20 s behind and times move forward by 20 s.
    expect(result.skewMs).toBe(20_000);
    expect(result.events[4]?.event.occurredAt).toBe("2026-10-02T06:03:41.018Z");
  });

  it("keeps the dense snapshot inside the size limit", async () => {
    const snapshot = (await convert()).find((e) => e.name === "snapshot");
    const size = new TextEncoder().encode(JSON.stringify(snapshot?.props)).length;
    expect(size).toBeGreaterThan(1000);
    expect(size).toBeLessThan(LIMITS.propsMaxBytes);
  });

  it("masks long digit runs in the error text, error codes of four digits included", async () => {
    const request = {
      schemaVersion: 1,
      sentAt: "2026-10-02T14:03:40.000+08:00",
      context,
      events: await convert(),
    };
    const result = processIngest(request, RECEIVED_AT);
    if (!result.ok) throw new Error("expected ok");
    const error = result.events.find((e) => e.event.name === "error")?.event;
    expect(error?.props?.error).toBe(
      "The file couldn't be opened because it isn't in the correct format (code #, user #)",
    );
  });

  it("gives the same id to the same line, so importing twice adds nothing", async () => {
    const first = await usageLineToEvent(lines[0]!);
    const again = await usageLineToEvent(lines[0]!);
    const other = await usageLineToEvent(lines[1]!);
    expect(first?.id).toBe(again?.id);
    expect(first?.id).not.toBe(other?.id);
    expect(first?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await deterministicUuid("x")).toBe(await deterministicUuid("x"));
  });

  it("skips lines that are not events", async () => {
    expect(await usageLineToEvent("not json")).toBeNull();
    expect(await usageLineToEvent("[1]")).toBeNull();
    expect(await usageLineToEvent('{"e":"x"}')).toBeNull();
  });
});
