import { Hono } from "hono";
import { SCHEMA_VERSION } from "@moli-insight/protocol";
import { admin } from "./admin.ts";
import { auditRoutes } from "./audit.ts";
import { catalogRoutes } from "./catalog.ts";
import type { AppEnv, Deps, Env } from "./env.ts";
import { exportRoutes } from "./export.ts";
import { ingest } from "./ingest.ts";
import { dayOffset } from "./days.ts";
import { runRetention } from "./retention.ts";
import { runRollup } from "./rollup.ts";
import { stats } from "./dashboard-api.ts";
import { setup } from "./setup-api.ts";
import { mcp } from "./mcp.ts";
import { oidc } from "./oidc.ts";

export type { Env } from "./env.ts";

export function createApp(deps: Deps = { now: () => Date.now(), fetch: (input, init) => fetch(input, init) }) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, schemaVersion: SCHEMA_VERSION }));
  app.route("/", ingest);
  app.route("/", catalogRoutes);
  app.route("/", exportRoutes);
  app.route("/", oidc);
  app.route("/", admin);
  app.route("/", stats);
  app.route("/", setup);
  app.route("/", auditRoutes);
  app.route("/", mcp);

  return app;
}

export const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller, env, ctx) {
    const offset = dayOffset(env.DAY_OFFSET_MINUTES);
    // Count finished days before anything is pruned.
    ctx.waitUntil(
      runRollup(env.DB, Date.now(), offset).then(() => runRetention(env.DB, Date.now(), { dayOffsetMinutes: offset })),
    );
  },
} satisfies ExportedHandler<Env>;
