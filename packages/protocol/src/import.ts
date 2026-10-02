import type { Props } from "./ingest.ts";

/**
 * Maps one line of a client's local usage log onto an event, for importing
 * files such as MoliSwitch's `usage-YYYY-MM-DD.jsonl`.
 *
 * A line is one flat JSON object: `t` (local time with an offset), `mono`
 * (milliseconds on a monotonic clock), `e` (the event name) and then the
 * event's own fields, which become `props`.
 *
 * The id is derived from the line itself, so importing the same file twice
 * produces the same ids and the server drops the repeats.
 */
export interface ImportedEvent {
  id: string;
  name: string;
  occurredAt: string;
  mono?: number;
  props?: Props;
}

export async function usageLineToEvent(line: string): Promise<ImportedEvent | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { t, mono, e, ...fields } = parsed as Record<string, unknown>;
  if (typeof t !== "string" || typeof e !== "string") return null;

  const event: ImportedEvent = { id: await deterministicUuid(line), name: e, occurredAt: t };
  if (typeof mono === "number") event.mono = mono;
  if (Object.keys(fields).length > 0) event.props = fields as Props;
  return event;
}

/** A name-based UUID (version 5 layout) taken from the SHA-256 of the text. */
export async function deterministicUuid(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
