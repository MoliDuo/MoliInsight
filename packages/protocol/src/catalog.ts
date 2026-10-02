import { z } from "zod";
import { EVENT_NAME_PATTERN, PROP_KEY_PATTERN } from "./ingest.ts";

/**
 * The event catalog: one JSON file kept in each app's own repository and
 * uploaded with `PUT /v1/catalog`. Besides describing events it carries the
 * app's own analysis views (metrics and funnels), so no app-specific code
 * lives in the platform.
 */
const eventName = z.string().max(64).regex(EVENT_NAME_PATTERN);
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** A path into props, such as `app` or `field.role`. At most three segments. */
const propPath = z
  .string()
  .max(200)
  .regex(new RegExp(`^${PROP_KEY_PATTERN.source.slice(1, -1)}(\\.${PROP_KEY_PATTERN.source.slice(1, -1)}){0,2}$`));

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const CatalogPropSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().max(500),
  /** The values this prop can take, when it is a small closed set. */
  enum: z.array(scalar).max(50).optional(),
  /** For numbers, such as "ms". */
  unit: z.string().max(32).optional(),
});

export const CatalogEventSchema = z.object({
  name: eventName,
  description: z.string().max(1000),
  props: z.record(z.string().regex(PROP_KEY_PATTERN), CatalogPropSchema).optional(),
  /**
   * `product` events are uploaded by default. `debug` events are dense and
   * stay in the client's local log unless imported by hand.
   */
  tier: z.enum(["product", "debug"]).optional(),
});

export const WhereSchema = z.object({
  prop: propPath,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"]),
  value: z.union([scalar, z.array(scalar).max(50)]).optional(),
});

/** One event in a metric or a funnel, optionally narrowed by prop conditions. */
export const StepSchema = z.object({
  event: eventName,
  where: z.array(WhereSchema).max(8).optional(),
});

/** A ratio of two event counts, such as manualSwitch / switch or record.abandon / record.open. */
export const MetricSchema = z.object({
  name: slug,
  description: z.string().max(1000),
  kind: z.literal("ratio"),
  numerator: StepSchema,
  denominator: StepSchema,
  /** Props to split the ratio by, such as `app`. */
  groupBy: z.array(propPath).max(3).optional(),
  /** Tells the dashboard and MCP which direction is an improvement. */
  goodDirection: z.enum(["up", "down"]).optional(),
});

export const FunnelSchema = z.object({
  name: slug,
  description: z.string().max(1000).optional(),
  steps: z.array(StepSchema).min(2).max(6),
  /** Time allowed from the first step to the last. */
  windowMs: z.int().positive().max(30 * 24 * 60 * 60 * 1000),
  /** What one pass through the funnel belongs to. */
  by: z.enum(["session", "device"]).optional(),
});

export const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(CatalogEventSchema).max(500),
    metrics: z.array(MetricSchema).max(50).optional(),
    funnels: z.array(FunnelSchema).max(50).optional(),
  })
  .superRefine((catalog, ctx) => {
    const duplicates = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i);
    const groups: [string, string[]][] = [
      ["events", catalog.events.map((e) => e.name)],
      ["metrics", (catalog.metrics ?? []).map((m) => m.name)],
      ["funnels", (catalog.funnels ?? []).map((f) => f.name)],
    ];
    for (const [key, names] of groups) {
      for (const name of new Set(duplicates(names))) {
        ctx.addIssue({ code: "custom", path: [key], message: `duplicate name: ${name}` });
      }
    }
  });

export type Catalog = z.infer<typeof CatalogSchema>;
