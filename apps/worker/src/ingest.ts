import { Hono } from "hono";
import { processIngest, type IngestError, type IngestResponse } from "@moli-insight/protocol";
import type { AppEnv } from "./env.ts";
import { BodyTooLarge, UnsupportedEncoding, readBodyText } from "./body.ts";
import { authenticateIngestKey, bearerToken } from "./keys.ts";
import { storeBatch } from "./ingest-store.ts";

/** What a client that was told to slow down should wait. The limiter windows are 10 or 60 seconds. */
const RETRY_AFTER_SECONDS = "60";

function failure(error: IngestError["error"], message?: string): { body: IngestError } {
  return { body: message === undefined ? { error } : { error, message } };
}

export const ingest = new Hono<AppEnv>();

ingest.post("/v1/ingest", async (c) => {
  const { now } = c.get("deps");
  const receivedAt = now();

  const token = bearerToken(c.req.raw);
  const auth = token
    ? await authenticateIngestKey(c.env, token, receivedAt, (p) => c.executionCtx.waitUntil(p))
    : null;
  if (!auth) return c.json(failure("unauthorized").body, 401);

  if (c.env.INGEST_LIMITER) {
    const { success } = await c.env.INGEST_LIMITER.limit({ key: `key:${auth.keyId}` });
    if (!success) {
      c.header("Retry-After", RETRY_AFTER_SECONDS);
      return c.json(failure("rate_limited").body, 429);
    }
  }

  let text: string;
  try {
    text = await readBodyText(c.req.raw);
  } catch (error) {
    if (error instanceof BodyTooLarge) return c.json(failure("payload_too_large").body, 413);
    if (error instanceof UnsupportedEncoding) return c.json(failure("unsupported_encoding").body, 415);
    return c.json(failure("invalid_json", "The body is not valid gzip.").body, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json(failure("invalid_json").body, 400);
  }

  const processed = processIngest(body, receivedAt);
  if (!processed.ok) return c.json(failure(processed.error).body, 400);

  const { deviceId } = processed.context;
  if (c.env.DEVICE_LIMITER && deviceId) {
    const { success } = await c.env.DEVICE_LIMITER.limit({ key: `dev:${auth.appId}:${deviceId}` });
    if (!success) {
      c.header("Retry-After", RETRY_AFTER_SECONDS);
      return c.json(failure("rate_limited").body, 429);
    }
  }

  const stored = await storeBatch(c.env.DB, {
    appId: auth.appId,
    context: processed.context,
    events: processed.events.map((e) => e.event),
    receivedAt,
  });

  const response: IngestResponse = {
    accepted: stored.accepted,
    duplicates: stored.duplicates,
    rejected: processed.rejected,
  };
  return c.json(response, 200);
});
