export interface Env {
  DB: D1Database;
  /** Secret that keys are hashed with (HMAC-SHA256). Changing it invalidates every key. */
  KEY_HMAC_SECRET: string;
  /** Secret that dashboard session cookies are signed with. */
  SESSION_SECRET: string;
  /** The dashboard's own address, such as `https://insight.xiangyu.pro`. The OIDC callback is `<this>/auth/callback`. */
  PUBLIC_URL: string;
  /** Authelia's address, such as `https://auth.xiangyu.pro`. */
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  /** From `moli-authelia add`, shown once. A secret, never a var. */
  OIDC_CLIENT_SECRET: string;
  /** Authelia usernames (`preferred_username`) that may use the dashboard, comma separated. Nobody if empty. */
  OIDC_ALLOWED_USERS: string;
  /** Minutes east of UTC where the dashboard's days begin, such as "480" for UTC+8. Unset means UTC. */
  DAY_OFFSET_MINUTES?: string;
  /** Rate limit per ingest key. Without the binding there is no limit. */
  INGEST_LIMITER?: RateLimit;
  /** Rate limit per device, for direct clients whose key can be extracted. */
  DEVICE_LIMITER?: RateLimit;
}

export interface Deps {
  /** The clock, replaceable in tests. */
  now: () => number;
  /** How the worker calls Authelia, replaceable in tests. */
  fetch: typeof fetch;
}

export type AppEnv = { Bindings: Env; Variables: { deps: Deps; /** The signed-in Authelia username, set by `requireSession`. */ user?: string } };
