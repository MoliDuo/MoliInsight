import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createApp } from "../src/index.ts";
import { signPayload } from "../src/crypto.ts";
import type { Env } from "../src/env.ts";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url).href);

/** Splits a migration into statements. Ours contain no semicolons inside strings. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const USER = "tester";
export const ISSUER = "https://auth.test";
export const CLIENT_ID = "moli-insight";

export class FakeLimiter {
  calls: string[] = [];
  deny = false;
  limit = async ({ key }: { key: string }) => {
    this.calls.push(key);
    return { success: !this.deny };
  };
}

export interface Harness {
  env: Env;
  clock: { now: number };
  ingestLimiter: FakeLimiter;
  deviceLimiter: FakeLimiter;
  pending: Promise<unknown>[];
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Waits for work handed to waitUntil. */
  settle(): Promise<void>;
  close(): Promise<void>;
  /** A dashboard session cookie for an allowed user, signed the way the worker signs it. */
  login(user?: string): Promise<string>;
  /** Replaces how the worker reaches Authelia. */
  authelia: { fetch: typeof fetch };
  /** Creates an app and an ingest key, returns the key. */
  newApp(slug: string, cookie: string): Promise<string>;
}

export async function createHarness(): Promise<Harness> {
  // A throwaway local D1, from the real wrangler config. Nothing is persisted.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url).href),
    persist: false,
  });
  const db = proxy.env.DB;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const sql of statements(readFileSync(`${MIGRATIONS}${file}`, "utf8"))) {
      await db.prepare(sql).run();
    }
  }

  const ingestLimiter = new FakeLimiter();
  const deviceLimiter = new FakeLimiter();
  const env = {
    DB: db,
    KEY_HMAC_SECRET: "test-hmac-secret",
    SESSION_SECRET: "test-session-secret",
    PUBLIC_URL: "https://insight.test",
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: "test-client-secret",
    OIDC_ALLOWED_USERS: `${USER},second`,
    INGEST_LIMITER: ingestLimiter,
    DEVICE_LIMITER: deviceLimiter,
  } as unknown as Env;

  const clock = { now: Date.parse("2026-10-02T08:00:05.000Z") };
  const authelia = { fetch: (() => Promise.reject(new Error("no Authelia in this test"))) as typeof fetch };
  const app = createApp({ now: () => clock.now, fetch: (input, init) => authelia.fetch(input, init) });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  const harness: Harness = {
    env,
    clock,
    ingestLimiter,
    deviceLimiter,
    pending,
    request: (path, init) => Promise.resolve(app.fetch(new Request(`https://insight.test${path}`, init), env, ctx)),
    settle: async () => void (await Promise.all(pending.splice(0))),
    close: () => proxy.dispose(),
    authelia,
    async login(user = USER) {
      const value = await signPayload(env.SESSION_SECRET, "session", { exp: clock.now + 30 * 24 * 60 * 60 * 1000, user });
      return `mi_session=${value}`;
    },
    async newApp(slug, cookie) {
      const headers = { "content-type": "application/json", cookie };
      await harness.request("/api/apps", { method: "POST", headers, body: JSON.stringify({ slug, name: slug }) });
      const response = await harness.request(`/api/apps/${slug}/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "test" }),
      });
      return ((await response.json()) as { key: string }).key;
    },
  };
  return harness;
}
