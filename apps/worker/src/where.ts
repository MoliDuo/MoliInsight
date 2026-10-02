import type { z } from "zod";
import type { WhereSchema } from "@moli-insight/protocol";

export type Where = z.infer<typeof WhereSchema>;

/** The value at a dotted path inside props, or undefined. */
export function getPath(props: unknown, path: string): unknown {
  let value: unknown = props;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const same = (a: unknown, b: unknown) =>
  a === b || (a != null && b != null && typeof a !== "object" && typeof b !== "object" && String(a) === String(b));

const num = (value: unknown) => (value === null || value === "" || typeof value === "object" ? NaN : Number(value));

function holds(found: unknown, w: Where): boolean {
  const target = w.value;
  switch (w.op) {
    case "exists":
      return (found !== undefined) === (target !== false);
    case "eq":
      return same(found, target);
    case "neq":
      return !same(found, target);
    case "in":
      return Array.isArray(target) && target.some((t) => same(found, t));
    default: {
      const a = num(found);
      const b = num(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return w.op === "gt" ? a > b : w.op === "gte" ? a >= b : w.op === "lt" ? a < b : a <= b;
    }
  }
}

/** Whether props satisfy every condition. No conditions means yes. */
export function matches(props: unknown, where: Where[] | undefined): boolean {
  return !where?.length || where.every((w) => holds(getPath(props, w.prop), w));
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}
