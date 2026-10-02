import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createApp } from "../src/index.ts";
import { hashPassword } from "../src/crypto.ts";
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

export const PASSWORD = "correct horse battery staple";

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
  /** A dashboard session cookie, from a real login. */
  login(): Promise<string>;
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
    DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD),
    INGEST_LIMITER: ingestLimiter,
    DEVICE_LIMITER: deviceLimiter,
  } as unknown as Env;

  const clock = { now: Date.parse("2026-10-02T08:00:05.000Z") };
  const app = createApp({ now: () => clock.now });
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
    async login() {
      const response = await harness.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
      return response.headers.get("set-cookie")!.split(";")[0]!;
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
