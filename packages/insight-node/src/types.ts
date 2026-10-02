/**
 * The public API of the server SDK, final for v0.1. It uses the standard
 * `Request` and `Response`, so it runs in Next route handlers, Workers and Node 22+.
 */

export type PropValue =
  | string
  | number
  | boolean
  | null
  | PropValue[]
  | { [key: string]: PropValue };
export type Props = { [key: string]: PropValue };

/** The environment variable names apps use. */
export const ENV = {
  url: "INSIGHT_URL",
  key: "INSIGHT_KEY",
} as const;

export interface InsightOptions {
  /** Base URL of MoliInsight. Without it, or without `key`, the SDK turns itself off. */
  url?: string | undefined;
  /** An ingest key (`mi_…`). Never sent to the browser. */
  key?: string | undefined;
  /** Reported as `context.release` of server events. Defaults to `VERCEL_GIT_COMMIT_SHA` when set. */
  release?: string;
  /** Per request to MoliInsight. Default 3000. */
  timeoutMs?: number;
  /** Called with the HTTP status when forwarding fails. Never receives request content. */
  onError?: (info: { status?: number }) => void;
  fetch?: typeof fetch;
}

export interface RelayOptions {
  /** Return false for a request that should not be recorded, typically when nobody is signed in. */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Largest request body in bytes. Default 65536. */
  maxBodyBytes?: number;
}

export interface ServerEvent {
  name: string;
  props?: Props;
  /** Ties this event to client events of the same action. */
  correlationId?: string;
  /** Defaults to now. */
  occurredAt?: Date;
}

export interface Insight {
  /** False when `url` or `key` is missing. Everything below is then a no-op. */
  readonly enabled: boolean;
  /**
   * A route handler that forwards the browser SDK's batches. It does three
   * things: checks the body size, calls `authorize`, and passes the body on.
   *
   * Responses: 204 on success, and always 204 when the SDK is disabled; 401 when
   * `authorize` says no (the browser keeps its queue); 413 when too large; 429
   * with `Retry-After` when MoliInsight is rate limiting; 503 when MoliInsight
   * cannot be reached or fails. The browser backs off on 429 and 5xx.
   */
  relayHandler(options: RelayOptions): (request: Request) => Promise<Response>;
  /** Sends server-side events with `platform: "server"`. Never throws. */
  send(events: ServerEvent[]): Promise<void>;
}

export type CreateInsight = (options?: InsightOptions) => Insight;
