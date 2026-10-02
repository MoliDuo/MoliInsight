import { KEY_PREFIXES } from "@moli-insight/protocol";
import { hmacHex, randomToken } from "./crypto.ts";
import type { Env } from "./env.ts";

/** How often `last_used_at` is refreshed, so a busy key does not cost a write per request. */
const LAST_USED_REFRESH_MS = 10 * 60 * 1000;

export type KeyKind = keyof typeof KEY_PREFIXES;

export interface NewKey {
  /** The secret itself. Shown once, never stored. */
  key: string;
  hash: string;
  /** The first characters, kept so a person can tell keys apart. */
  prefix: string;
}

export async function createKey(kind: KeyKind, hmacSecret: string): Promise<NewKey> {
  const key = KEY_PREFIXES[kind] + randomToken(24);
  return { key, hash: await hmacHex(hmacSecret, key), prefix: key.slice(0, KEY_PREFIXES[kind].length + 4) };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

export interface IngestAuth {
  keyId: number;
  appId: number;
}

/** Finds the live ingest key a bearer token belongs to. Null for an unknown or revoked key. */
export async function authenticateIngestKey(
  env: Env,
  token: string,
  nowMs: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<IngestAuth | null> {
  if (!token.startsWith(KEY_PREFIXES.ingest)) return null;
  const hash = await hmacHex(env.KEY_HMAC_SECRET, token);
  const row = await env.DB.prepare(
    "SELECT id, app_id, last_used_at FROM app_keys WHERE key_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: number; app_id: number; last_used_at: number | null }>();
  if (!row) return null;

  if (row.last_used_at === null || nowMs - row.last_used_at > LAST_USED_REFRESH_MS) {
    waitUntil(
      env.DB.prepare("UPDATE app_keys SET last_used_at = ?1 WHERE id = ?2").bind(nowMs, row.id).run(),
    );
  }
  return { keyId: row.id, appId: row.app_id };
}

/** Finds the live admin token a bearer token belongs to. Used by export and MCP. */
export async function authenticateAdminToken(
  env: Env,
  token: string,
  nowMs: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<{ tokenId: number } | null> {
  if (!token.startsWith(KEY_PREFIXES.admin)) return null;
  const hash = await hmacHex(env.KEY_HMAC_SECRET, token);
  const row = await env.DB.prepare(
    "SELECT id, last_used_at FROM admin_tokens WHERE token_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: number; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || nowMs - row.last_used_at > LAST_USED_REFRESH_MS) {
    waitUntil(
      env.DB.prepare("UPDATE admin_tokens SET last_used_at = ?1 WHERE id = ?2").bind(nowMs, row.id).run(),
    );
  }
  return { tokenId: row.id };
}
