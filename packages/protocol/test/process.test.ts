import { describe, expect, it } from "vitest";
import { LIMITS, processIngest } from "../src/index.ts";
import { RECEIVED_AT, makeEvent, makeRequest } from "./helpers.ts";

describe("processIngest", () => {
  it("accepts a batch and reports bad events by index without failing the rest", () => {
    const result = processIngest(
      makeRequest([
        makeEvent(),
        makeEvent({ name: "bad name" }),
        makeEvent(),
        makeEvent({ props: { f: { g: { h: { i: 1 } } } } }),
      ]),
      RECEIVED_AT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((e) => e.index)).toEqual([0, 2]);
    expect(result.rejected).toEqual([
      { index: 1, reason: "invalid_name" },
      { index: 3, reason: "props_too_deep" },
    ]);
  });

  it("rejects the whole batch for a broken envelope", () => {
    expect(processIngest(null, RECEIVED_AT)).toEqual({ ok: false, error: "invalid_envelope" });
    expect(processIngest(makeRequest([], { sentAt: "now" }), RECEIVED_AT)).toEqual({
      ok: false,
      error: "invalid_envelope",
    });
    expect(
      processIngest(makeRequest([], { context: { platform: "web" } }), RECEIVED_AT),
    ).toEqual({ ok: false, error: "invalid_envelope" });
    expect(
      processIngest(makeRequest([], { context: { platform: "plan9", release: "1" } }), RECEIVED_AT),
    ).toEqual({ ok: false, error: "invalid_envelope" });
  });

  it("rejects a schema version it does not support, and says so", () => {
    expect(processIngest(makeRequest([], { schemaVersion: 2 }), RECEIVED_AT)).toEqual({
      ok: false,
      error: "unsupported_schema_version",
    });
  });

  it("rejects more events than a batch may hold", () => {
    const events = Array.from({ length: LIMITS.maxEventsPerBatch + 1 }, () => makeEvent());
    expect(processIngest(makeRequest(events), RECEIVED_AT).ok).toBe(false);
    expect(processIngest(makeRequest(events.slice(0, LIMITS.maxEventsPerBatch)), RECEIVED_AT).ok).toBe(true);
  });

  it("accepts an empty batch", () => {
    const result = processIngest(makeRequest([]), RECEIVED_AT);
    expect(result.ok && result.events).toEqual([]);
  });

  it("shifts times by the clock skew of the batch", () => {
    // The client's clock is 10 minutes ahead: it says it is 08:10:00 when it is 08:00:01.
    const result = processIngest(
      makeRequest([makeEvent({ occurredAt: "2026-10-02T08:09:59.000Z" })], {
        sentAt: "2026-10-02T08:10:00.000Z",
      }),
      RECEIVED_AT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skewMs).toBe(-599_000);
    expect(result.events[0]?.event.occurredAt).toBe("2026-10-02T08:00:00.000Z");
    expect(result.events[0]?.event.clamped).toBe(false);
  });

  it("keeps the order of events when it shifts them", () => {
    const result = processIngest(
      makeRequest(
        [
          makeEvent({ occurredAt: "2026-10-02T07:59:00.000Z" }),
          makeEvent({ occurredAt: "2026-10-02T07:59:30.000Z" }),
        ],
        { sentAt: "2026-10-02T07:59:40.000Z" },
      ),
      RECEIVED_AT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.events.map((e) => e.event.occurredAtMs);
    expect(b! - a!).toBe(30_000);
  });

  it("holds an event inside the accepted window", () => {
    const old = processIngest(
      makeRequest([makeEvent({ occurredAt: "2026-09-01T00:00:00.000Z" })]),
      RECEIVED_AT,
    );
    expect(old.ok && old.events[0]?.event.clamped).toBe(true);
    expect(old.ok && old.events[0]?.event.occurredAtMs).toBe(
      RECEIVED_AT + 1000 - LIMITS.maxPastMs - 1000 + 0,
    );

    const future = processIngest(
      makeRequest([makeEvent({ occurredAt: "2026-10-02T09:00:00.000Z" })]),
      RECEIVED_AT,
    );
    expect(future.ok && future.events[0]?.event.occurredAtMs).toBe(RECEIVED_AT + LIMITS.maxFutureMs);
  });

  it("passes context through and strips what it does not know", () => {
    const result = processIngest(
      makeRequest([], {
        context: { platform: "macos", release: "0.2.57", deviceClass: "desktop", extra: "x" },
      }),
      RECEIVED_AT,
    );
    expect(result.ok && result.context).toEqual({
      platform: "macos",
      release: "0.2.57",
      deviceClass: "desktop",
    });
  });
});
