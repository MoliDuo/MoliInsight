import { describe, expect, it } from "vitest";
import { getPath, matches, percentile } from "../src/where.ts";

describe("where", () => {
  const props = { kind: "income", n: 5, nested: { a: { b: "x" } }, s: "7" };
  it("reads dotted paths", () => {
    expect(getPath(props, "nested.a.b")).toBe("x");
    expect(getPath(props, "nested.z.b")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });
  it("applies every condition", () => {
    expect(matches(props, undefined)).toBe(true);
    expect(matches(props, [{ prop: "kind", op: "eq", value: "income" }, { prop: "n", op: "gte", value: 5 }])).toBe(true);
    expect(matches(props, [{ prop: "kind", op: "eq", value: "income" }, { prop: "n", op: "gt", value: 5 }])).toBe(false);
    expect(matches(props, [{ prop: "n", op: "eq", value: "5" }])).toBe(true);
    expect(matches(props, [{ prop: "s", op: "lt", value: 10 }])).toBe(true);
    expect(matches(props, [{ prop: "kind", op: "in", value: ["expense", "income"] }])).toBe(true);
    expect(matches(props, [{ prop: "kind", op: "neq", value: "income" }])).toBe(false);
    expect(matches(props, [{ prop: "missing", op: "exists", value: false }])).toBe(true);
    expect(matches(props, [{ prop: "missing", op: "exists" }])).toBe(false);
    expect(matches(props, [{ prop: "kind", op: "gt", value: 1 }])).toBe(false);
  });
  it("takes nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([9], 0.01)).toBe(9);
  });
});
