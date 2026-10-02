# MoliInsight

Self-hosted usage data for the Moli apps: one ingest protocol, one database, one dashboard, and an export that an AI can read. See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the design and [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

Status: M0 (contract), M1 (ingest, admin, retention, import), the M2 SDKs (web, node, Swift), M3 (dashboard overview and event browser, daily counts, export format) and M4 (event catalog, funnels and ratios, sessions, release comparison, friction, performance, MCP) are done. Wiring the SDKs into Cashier and MoliSwitch is what remains.

## Run it locally

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run hash-password -w @moli-insight/worker -- "your passphrase"   # paste the output into .dev.vars
npm run migrate:local
npm run dev                                                          # worker on :8787, dashboard with hot reload on http://localhost:5173
```

`npm run dev` starts `wrangler dev` and the Vite dev server together; Vite proxies `/api`, `/v1` and `/mcp` to the worker. Open http://localhost:5173, sign in, and the setup wizard creates your first app and key, shows the code to paste into your app, and tells you when the first event arrives. (The worker alone serves the last built dashboard at :8787; `npm run build` rebuilds it, and `dev` and `deploy` do that for you.)

You can also send data by hand:

```bash
curl -X POST http://localhost:8787/v1/ingest \
  -H "authorization: Bearer mi_..." \
  -d @packages/protocol/test/fixtures/request-valid.json
```

Import a MoliSwitch usage log (running it twice adds nothing). In the dashboard this is app settings → Import and export; from a shell:

```bash
INSIGHT_URL=http://localhost:8787 INSIGHT_KEY=mi_... \
  node packages/cli/src/bin.ts import ~/path/to/usage-2026-10-02.jsonl
```

The dashboard is a React single-page app in `apps/dashboard` (Vite, Tailwind, TanStack Query and Router, Recharts). Pages: overview with change against the previous period, events, sessions, funnels and metrics, release comparison, friction, performance, navigation, feature usage, and per-app settings (keys, devices, event catalog upload with a dry run, MoliSwitch import, export, retention, delete) plus people and admin tokens. Filters live in the URL, so any view can be shared as a link. Days begin at `DAY_OFFSET_MINUTES` in `apps/worker/wrangler.jsonc` (480 = UTC+8); change it before the first night's rollup, or old daily counts stay on the old boundary.

Read the data back (needs the dashboard cookie, or an admin token `mia_…` from the admin page; the format is in [docs/export-v1.md](docs/export-v1.md)):

```bash
curl -H "authorization: Bearer mia_..." "http://localhost:8787/v1/export?app=switch&limit=1000"
# NDJSON: a header line, one line per event, an end line with `next`; pass it back as &after=
```

SDKs: [docs/sdk-api.md](docs/sdk-api.md). Swift client for apps without a backend: [clients/swift](clients/swift/README.md). Cashier wiring: [docs/integration-cashier.md](docs/integration-cashier.md).

## Deploy

```bash
npx wrangler d1 create moli-insight           # put the id into apps/worker/wrangler.jsonc
npm run migrate:remote -w @moli-insight/worker
npx wrangler secret put KEY_HMAC_SECRET       # in apps/worker
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DASHBOARD_PASSWORD_HASH
npm run deploy -w @moli-insight/worker       # builds the dashboard first
```

Generating the password hash stays a command-line step, because it ends up in a secret.

## Check

`npm run check` runs the type check (including the dashboard), all tests, verifies that the generated JSON Schemas are up to date, and builds the dashboard.

Describe an app's events, ratio metrics and funnels once, in a catalog file that lives in the app's repository ([format](docs/protocol-v1.md#8-事件目录)). Upload it in the dashboard (app settings → Event catalog; it checks the file first and lists problems) or from a shell:

```bash
INSIGHT_URL=http://localhost:8787 INSIGHT_KEY=mi_... \
  node packages/cli/src/bin.ts catalog telemetry-catalog.json   # replaces the app's catalog; --dry-run only checks it
```

Let Claude query the data over MCP (admin token, [tools](docs/protocol-v1.md#8b-mcp); the dashboard's admin tokens page shows this command with your address filled in):

```bash
claude mcp add --transport http moli-insight http://localhost:8787/mcp --header "Authorization: Bearer mia_..."
```
