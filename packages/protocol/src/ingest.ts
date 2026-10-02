import { z } from "zod";
import { LIMITS, SCHEMA_VERSION } from "./limits.ts";

/**
 * `$` is reserved for standard events produced by SDKs. Camel case is allowed
 * because native clients already use it (`appStart`, `manualSwitch`).
 */
export const EVENT_NAME_PATTERN = /^\$?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/** Keys inside `props`. Kept simple so a key can always be used in a JSON path. */
export const PROP_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9]{8,48}$/;
export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{8,48}$/;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export const PLATFORMS = ["web", "ios", "android", "windows", "macos", "server"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const DEVICE_CLASSES = ["phone", "tablet", "desktop"] as const;

const isoDateTime = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// props

export type PropValue =
  | string
  | number
  | boolean
  | null
  | PropValue[]
  | { [key: string]: PropValue };

export type Props = { [key: string]: PropValue };

const propKey = z.string().regex(PROP_KEY_PATTERN);

/**
 * Any JSON value. Depth and total size are checked by `validateEvent`, because
 * JSON Schema cannot express them; a string over the limit is cut, not rejected.
 */
export const PropValueSchema: z.ZodType<PropValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PropValueSchema).max(LIMITS.propArrayMaxItems),
    z.record(propKey, PropValueSchema),
  ]),
);

export const PropsSchema: z.ZodType<Props> = z.record(propKey, PropValueSchema);

// ---------------------------------------------------------------------------
// context: what a whole batch shares

export const ContextSchema = z.object({
  platform: z.enum(PLATFORMS),
  /** The app's version: a git SHA for web apps, a build number for native ones. */
  release: z.string().min(1).max(64),
  /** Omitted by server-side events. */
  deviceId: z.string().regex(DEVICE_ID_PATTERN).optional(),
  deviceClass: z.enum(DEVICE_CLASSES).optional(),
  /** Coarse, such as "iOS 26" or "macOS 26.0". Never a full user agent. */
  os: z.string().max(64).optional(),
  /** Coarse, such as "Safari 26". */
  client: z.string().max(64).optional(),
  viewport: z
    .tuple([z.int().positive().max(100_000), z.int().positive().max(100_000)])
    .optional(),
  locale: z.string().max(35).optional(),
  timeZone: z.string().max(64).optional(),
  /** Running as an installed PWA or app. */
  standalone: z.boolean().optional(),
});
export type Context = z.infer<typeof ContextSchema>;

// ---------------------------------------------------------------------------
// event

export const EventSchema = z.object({
  /** Any UUID. Version 7 is preferred, but Swift and Kotlin only have v4 built in. */
  id: z.uuid(),
  name: z.string().max(LIMITS.eventNameMaxLength).regex(EVENT_NAME_PATTERN),
  /** ISO 8601 with an offset. The server corrects it against `sentAt`. */
  occurredAt: isoDateTime,
  /** Milliseconds on a monotonic clock, for exact intervals between events. */
  mono: z.number().nonnegative().optional(),
  /** Omitted by server-side events. */
  sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
  /** Ties together events of one logical action, such as a client submit and the server's processing. */
  correlationId: z
    .string()
    .min(1)
    .max(LIMITS.correlationIdMaxLength)
    .regex(CORRELATION_ID_PATTERN)
    .optional(),
  /** A route template and overlay markers. Query values are removed by the server. */
  route: z.string().max(LIMITS.routeMaxLength).optional(),
  props: PropsSchema.optional(),
});
export type IngestEvent = z.infer<typeof EventSchema>;

// ---------------------------------------------------------------------------
// request and response

/**
 * What the server checks for the whole batch. Events stay `unknown` here: they
 * are checked one by one, so one bad event never fails the batch.
 */
export const IngestEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** When the request was sent, not when the events were queued. */
  sentAt: isoDateTime,
  context: ContextSchema,
  events: z.array(z.unknown()).max(LIMITS.maxEventsPerBatch),
});

/** A fully valid request. This is what the published JSON Schema describes. */
export const IngestRequestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sentAt: isoDateTime,
  context: ContextSchema,
  events: z.array(EventSchema).max(LIMITS.maxEventsPerBatch),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const REJECT_REASONS = [
  "invalid_event",
  "invalid_id",
  "invalid_name",
  "invalid_time",
  "invalid_mono",
  "invalid_session",
  "invalid_correlation",
  "invalid_route",
  "invalid_props",
  "props_too_deep",
  "props_too_large",
  "invalid_standard_props",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const IngestResponseSchema = z.object({
  accepted: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  rejected: z.array(
    z.object({
      index: z.int().nonnegative(),
      reason: z.enum(REJECT_REASONS),
    }),
  ),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export const ERROR_CODES = [
  "invalid_json",
  "invalid_envelope",
  "unsupported_schema_version",
  "unauthorized",
  "payload_too_large",
  "unsupported_encoding",
  "rate_limited",
] as const;

export const IngestErrorSchema = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string().optional(),
});
export type IngestError = z.infer<typeof IngestErrorSchema>;
