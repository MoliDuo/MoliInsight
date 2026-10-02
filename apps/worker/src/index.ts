import { Hono } from "hono";
import { SCHEMA_VERSION } from "@moli-insight/protocol";

export interface Env {
  DB: D1Database;
}

export const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, schemaVersion: SCHEMA_VERSION }));

export default {
  fetch: app.fetch,

  // The retention job arrives with M1. Declared now so the cron trigger in
  // wrangler.jsonc has a handler.
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
