import { Hono } from "hono";
import { SCHEMA_VERSION } from "@moli-insight/protocol";
import { admin } from "./admin.ts";
import type { AppEnv, Deps, Env } from "./env.ts";
import { ingest } from "./ingest.ts";
import { runRetention } from "./retention.ts";

export type { Env } from "./env.ts";

export function createApp(deps: Deps = { now: () => Date.now() }) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, schemaVersion: SCHEMA_VERSION }));
  app.route("/", ingest);
  app.route("/", admin);

  return app;
}

export const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRetention(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;
