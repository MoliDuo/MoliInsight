import { describe, expect, it } from "vitest";
import {
  LIMITS,
  clockSkewMs,
  correctOccurredAt,
  maskDigitRuns,
  scrubProps,
  scrubRoute,
  truncate,
} from "../src/index.ts";

describe("time", () => {
  it("measures skew as receive time minus send time", () => {
    expect(clockSkewMs("2026-10-02T08:00:00.000Z", Date.parse("2026-10-02T08:00:02.500Z"))).toBe(2500);
  });

  it("treats an unreadable sentAt as no skew", () => {
    expect(clockSkewMs("nonsense", 1_000)).toBe(0);
  });

  it("clamps to both edges of the window", () => {
    const received = Date.parse("2026-10-02T08:00:00.000Z");
    expect(correctOccurredAt(received - LIMITS.maxPastMs - 1, 0, received)).toEqual({
      ms: received - LIMITS.maxPastMs,
      clamped: true,
    });
    expect(correctOccurredAt(received + LIMITS.maxFutureMs + 1, 0, received)).toEqual({
      ms: received + LIMITS.maxFutureMs,
      clamped: true,
    });
    expect(correctOccurredAt(received - 1000, 0, received)).toEqual({ ms: received - 1000, clamped: false });
  });
});

describe("scrub", () => {
  it("scrubs routes", () => {
    expect(scrubRoute("/records")).toBe("/records");
    expect(scrubRoute("/records?new")).toBe("/records?new");
    expect(scrubRoute("/records?id=42&q=lunch")).toBe("/records?id&q");
    expect(scrubRoute("/records?=1&&a=")).toBe("/records?a");
    expect(scrubRoute("/records?id=42#frag")).toBe("/records?id");
    expect(scrubRoute("/records#frag")).toBe("/records");
    expect(scrubRoute("/records?")).toBe("/records");
  });

  it("masks only long digit runs", () => {
    expect(maskDigitRuns("HTTP 500 for 12345")).toBe("HTTP 500 for #");
    expect(maskDigitRuns("12.50 and 2026-10-02")).toBe("12.50 and #-10-02");
  });

  it("cuts by characters, not UTF-16 units", () => {
    expect(truncate("😀😀😀", 2)).toBe("😀😀");
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("scrubs strings at any depth", () => {
    expect(scrubProps({ a: { message: "id 123456" }, list: ["x".repeat(300)] })).toEqual({
      a: { message: "id #" },
      list: ["x".repeat(200)],
    });
  });
});
