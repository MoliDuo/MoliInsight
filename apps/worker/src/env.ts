export interface Env {
  DB: D1Database;
  /** Secret that keys are hashed with (HMAC-SHA256). Changing it invalidates every key. */
  KEY_HMAC_SECRET: string;
  /** Secret that dashboard session cookies are signed with. */
  SESSION_SECRET: string;
  /** `pbkdf2-sha256$…`, made by `npm run hash-password`. */
  DASHBOARD_PASSWORD_HASH: string;
  /** Rate limit per ingest key. Without the binding there is no limit. */
  INGEST_LIMITER?: RateLimit;
  /** Rate limit per device, for direct clients whose key can be extracted. */
  DEVICE_LIMITER?: RateLimit;
}

export interface Deps {
  /** The clock, replaceable in tests. */
  now: () => number;
}

export type AppEnv = { Bindings: Env; Variables: { deps: Deps } };
