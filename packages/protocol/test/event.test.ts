import { describe, expect, it } from "vitest";
import { LIMITS, validateEvent } from "../src/index.ts";
import { makeEvent } from "./helpers.ts";

const reasonOf = (raw: unknown) => {
  const result = validateEvent(raw);
  return result.ok ? "ok" : result.reason;
};

describe("event name", () => {
  it.each(["record.submit", "detail.edit", "appStart", "manualSwitch", "$future_event", "a1.b_2.c"])(
    "accepts %s",
    (name) => expect(reasonOf(makeEvent({ name }))).toBe("ok"),
  );

  it.each(["", "1abc", "has space", "double..dot", "trailing.", "$", "$$tap", "a-b", "x".repeat(65)])(
    "rejects %j",
    (name) => expect(reasonOf(makeEvent({ name }))).toBe("invalid_name"),
  );
});

describe("event fields", () => {
  it("rejects a non-object event", () => {
    expect(reasonOf(null)).toBe("invalid_event");
    expect(reasonOf("x")).toBe("invalid_event");
    expect(reasonOf([])).toBe("invalid_event");
  });

  it("names the field that is wrong", () => {
    expect(reasonOf(makeEvent({ id: "not-a-uuid" }))).toBe("invalid_id");
    expect(reasonOf(makeEvent({ occurredAt: "yesterday" }))).toBe("invalid_time");
    expect(reasonOf(makeEvent({ occurredAt: "2026-10-02T07:59:58" }))).toBe("invalid_time");
    expect(reasonOf(makeEvent({ sessionId: "abc" }))).toBe("invalid_session");
    expect(reasonOf(makeEvent({ correlationId: "has space" }))).toBe("invalid_correlation");
    expect(reasonOf(makeEvent({ mono: -1 }))).toBe("invalid_mono");
    expect(reasonOf(makeEvent({ route: "/".repeat(LIMITS.routeMaxLength + 1) }))).toBe(
      "invalid_route",
    );
  });

  it("accepts a UUIDv4, since native clients have no v7", () => {
    expect(reasonOf(makeEvent({ id: "3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b" }))).toBe("ok");
  });

  it("accepts offsets other than Z", () => {
    expect(reasonOf(makeEvent({ occurredAt: "2026-10-02T14:03:21.482+08:00" }))).toBe("ok");
  });

  it("lets a server-side event leave out the session", () => {
    const { sessionId: _omit, ...event } = makeEvent({ name: "processing.finished" });
    expect(reasonOf(event)).toBe("ok");
  });

  it("ignores fields it does not know, without keeping them", () => {
    const result = validateEvent(makeEvent({ futureField: 1 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).not.toHaveProperty("futureField");
  });
});

describe("props", () => {
  it("accepts scalars, arrays and nested objects", () => {
    const props = { a: 1, b: "x", c: true, d: null, e: [1, "y"], f: { g: { h: 1 } } };
    // props (level 1) > f (2) > g (3)
    expect(reasonOf(makeEvent({ props }))).toBe("ok");
  });

  it("rejects nesting beyond three levels", () => {
    expect(reasonOf(makeEvent({ props: { f: { g: { h: { i: 1 } } } } }))).toBe("props_too_deep");
    expect(reasonOf(makeEvent({ props: { f: { g: [[1]] } } }))).toBe("props_too_deep");
  });

  it("does not recurse deeply on a hostile body", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) nested = { a: nested };
    expect(reasonOf(makeEvent({ props: nested }))).toBe("props_too_deep");
  });

  it("rejects an array of more than 20 items", () => {
    const ok = Array.from({ length: LIMITS.propArrayMaxItems }, (_, i) => i);
    expect(reasonOf(makeEvent({ props: { list: ok } }))).toBe("ok");
    expect(reasonOf(makeEvent({ props: { list: [...ok, 21] } }))).toBe("invalid_props");
  });

  it("rejects keys that cannot be used in a JSON path", () => {
    expect(reasonOf(makeEvent({ props: { "a.b": 1 } }))).toBe("invalid_props");
    expect(reasonOf(makeEvent({ props: { "a-b": 1 } }))).toBe("invalid_props");
    expect(reasonOf(makeEvent({ props: { "1a": 1 } }))).toBe("invalid_props");
  });

  it("cuts long strings instead of rejecting them", () => {
    const result = validateEvent(makeEvent({ props: { note: "あ".repeat(500) } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(String(result.event.props?.note))).toHaveLength(200);
  });

  it("rejects props over 4 KB after cutting", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(150)]),
    );
    expect(reasonOf(makeEvent({ props: wide }))).toBe("props_too_large");
  });

  it("masks long digit runs in message and error, and only there", () => {
    const result = validateEvent(
      makeEvent({
        props: { message: "failed for record 4821734 (HTTP 500)", error: "id 99999", note: "12345678" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.props).toEqual({
        message: "failed for record # (HTTP 500)",
        error: "id #",
        note: "12345678",
      });
    }
  });

  it("removes query values from the route", () => {
    const result = validateEvent(makeEvent({ route: "/records?id=42&new#top" }));
    expect(result.ok && result.event.route).toBe("/records?id&new");
  });
});

describe("standard events", () => {
  it("checks props of a known standard event", () => {
    expect(reasonOf(makeEvent({ name: "$tap", props: { target: "topbar.next" } }))).toBe("ok");
    expect(reasonOf(makeEvent({ name: "$tap", props: {} }))).toBe("invalid_standard_props");
    expect(
      reasonOf(makeEvent({ name: "$vital", props: { metric: "LCP", value: "slow" } })),
    ).toBe("invalid_standard_props");
  });

  it("accepts extra props on a standard event", () => {
    expect(reasonOf(makeEvent({ name: "$op", props: { op: "save", ms: 120, ok: true, extra: 1 } }))).toBe("ok");
  });

  it("accepts a `$` name it does not know, so a newer SDK still works", () => {
    expect(reasonOf(makeEvent({ name: "$future_event", props: { a: 1 } }))).toBe("ok");
  });
});
