import {
  EventSchema,
  IngestEnvelopeSchema,
  type Context,
  type Props,
  type RejectReason,
} from "./ingest.ts";
import { LIMITS } from "./limits.ts";
import { clockSkewMs, correctOccurredAt } from "./time.ts";
import { scrubProps, scrubRoute } from "./scrub.ts";
import { STANDARD_EVENTS, isStandardEventName } from "./standard-events.ts";

/**
 * How many nesting levels a value has, counting up to `cap + 1` and then
 * stopping, so a hostile deeply nested body cannot make this recurse deeply.
 * A primitive has 0 levels; an object or array has one more than its deepest child.
 */
export function nestingDepth(value: unknown, cap: number, level = 0): number {
  if (value === null || typeof value !== "object") return level;
  if (level >= cap + 1) return level + 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  let deepest = level + 1;
  for (const child of children) {
    const depth = nestingDepth(child, cap, level + 1);
    if (depth > deepest) deepest = depth;
    if (deepest > cap) return deepest;
  }
  return deepest;
}

export interface NormalizedEvent {
  id: string;
  name: string;
  /** ISO 8601 in UTC with milliseconds, after clock correction. */
  occurredAt: string;
  occurredAtMs: number;
  mono?: number;
  sessionId?: string;
  correlationId?: string;
  route?: string;
  props?: Props;
  /** The corrected time still fell outside the accepted window and was moved to its edge. */
  clamped: boolean;
}

export type ValidatedEvent = Omit<NormalizedEvent, "occurredAt" | "occurredAtMs" | "clamped"> & {
  occurredAtMs: number;
};

const FIELD_REASON: Record<string, RejectReason> = {
  id: "invalid_id",
  name: "invalid_name",
  occurredAt: "invalid_time",
  mono: "invalid_mono",
  sessionId: "invalid_session",
  correlationId: "invalid_correlation",
  route: "invalid_route",
  props: "invalid_props",
};

export type EventCheck =
  | { ok: true; event: ValidatedEvent }
  | { ok: false; reason: RejectReason };

/**
 * Checks one event and cleans it: strings in props are cut, digit runs in
 * messages are masked, query values leave the route. It does not touch the time;
 * that needs the batch's clock skew (see `processIngest`).
 */
export function validateEvent(raw: unknown): EventCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_event" };
  }
  const props = (raw as { props?: unknown }).props;
  if (props !== undefined && nestingDepth(props, LIMITS.propsMaxDepth) > LIMITS.propsMaxDepth) {
    return { ok: false, reason: "props_too_deep" };
  }

  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return { ok: false, reason: FIELD_REASON[field] ?? "invalid_event" };
  }
  const input = parsed.data;

  if (isStandardEventName(input.name)) {
    const standard = STANDARD_EVENTS[input.name].props.safeParse(input.props ?? {});
    if (!standard.success) return { ok: false, reason: "invalid_standard_props" };
  }

  const event: ValidatedEvent = {
    id: input.id,
    name: input.name,
    occurredAtMs: Date.parse(input.occurredAt),
  };
  if (input.mono !== undefined) event.mono = input.mono;
  if (input.sessionId !== undefined) event.sessionId = input.sessionId;
  if (input.correlationId !== undefined) event.correlationId = input.correlationId;
  if (input.route !== undefined) event.route = scrubRoute(input.route);
  if (input.props !== undefined) {
    const cleaned = scrubProps(input.props);
    if (new TextEncoder().encode(JSON.stringify(cleaned)).length > LIMITS.propsMaxBytes) {
      return { ok: false, reason: "props_too_large" };
    }
    event.props = cleaned;
  }
  return { ok: true, event };
}

export type ProcessResult =
  | {
      ok: false;
      error: "invalid_envelope" | "unsupported_schema_version";
    }
  | {
      ok: true;
      context: Context;
      /** Positive when the client's clock is behind the server's. */
      skewMs: number;
      events: { index: number; event: NormalizedEvent }[];
      rejected: { index: number; reason: RejectReason }[];
    };

/**
 * The pure core of `POST /v1/ingest`, after authentication, decompression and
 * JSON parsing: checks the envelope, then every event on its own, corrects the
 * times, and says what was accepted and what was not. Storing and de-duplicating
 * are the server's job. One bad event never fails the batch.
 */
export function processIngest(body: unknown, receivedAtMs: number): ProcessResult {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const version = (body as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version !== 1) {
      return { ok: false, error: "unsupported_schema_version" };
    }
  }
  const envelope = IngestEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { ok: false, error: "invalid_envelope" };

  const { context, sentAt, events } = envelope.data;
  const skewMs = clockSkewMs(sentAt, receivedAtMs);

  const accepted: { index: number; event: NormalizedEvent }[] = [];
  const rejected: { index: number; reason: RejectReason }[] = [];
  events.forEach((raw, index) => {
    const checked = validateEvent(raw);
    if (!checked.ok) {
      rejected.push({ index, reason: checked.reason });
      return;
    }
    const { occurredAtMs, ...rest } = checked.event;
    const corrected = correctOccurredAt(occurredAtMs, skewMs, receivedAtMs);
    accepted.push({
      index,
      event: {
        ...rest,
        occurredAt: new Date(corrected.ms).toISOString(),
        occurredAtMs: corrected.ms,
        clamped: corrected.clamped,
      },
    });
  });

  return { ok: true, context, skewMs, events: accepted, rejected };
}
