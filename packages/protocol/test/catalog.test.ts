import { describe, expect, it } from "vitest";
import { CatalogSchema } from "../src/index.ts";

const base = {
  schemaVersion: 1,
  events: [
    {
      name: "switch",
      description: "The app switched the input method.",
      props: { ok: { type: "boolean", description: "Whether the system accepted it." } },
    },
    { name: "manualSwitch", description: "The user switched it back by hand." },
    { name: "key", description: "A key press.", tier: "debug" },
  ],
  metrics: [
    {
      name: "manual_correction_rate",
      description: "Share of automatic switches the user corrected.",
      kind: "ratio",
      numerator: { event: "manualSwitch" },
      denominator: { event: "switch", where: [{ prop: "ok", op: "eq", value: true }] },
      groupBy: ["app"],
      goodDirection: "down",
    },
  ],
  funnels: [
    {
      name: "record_flow",
      steps: [{ event: "record.open" }, { event: "record.input" }, { event: "record.submit" }],
      windowMs: 30 * 60 * 1000,
      by: "session",
    },
  ],
};

describe("catalog", () => {
  it("accepts events, metrics and funnels", () => {
    expect(CatalogSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a catalog with events only", () => {
    expect(CatalogSchema.safeParse({ schemaVersion: 1, events: [] }).success).toBe(true);
  });

  it("rejects duplicate names", () => {
    const dup = { ...base, events: [base.events[0], base.events[0]] };
    expect(CatalogSchema.safeParse(dup).success).toBe(false);
  });

  it("limits a funnel to 2 to 6 steps", () => {
    const one = { ...base, funnels: [{ ...base.funnels[0], steps: [{ event: "a" }] }] };
    const seven = {
      ...base,
      funnels: [{ ...base.funnels[0], steps: Array.from({ length: 7 }, (_, i) => ({ event: `e${i}` })) }],
    };
    expect(CatalogSchema.safeParse(one).success).toBe(false);
    expect(CatalogSchema.safeParse(seven).success).toBe(false);
  });

  it("only takes prop paths of up to three segments", () => {
    const deep = { ...base, metrics: [{ ...base.metrics[0], groupBy: ["a.b.c.d"] }] };
    const ok = { ...base, metrics: [{ ...base.metrics[0], groupBy: ["field.role"] }] };
    expect(CatalogSchema.safeParse(deep).success).toBe(false);
    expect(CatalogSchema.safeParse(ok).success).toBe(true);
  });
});
