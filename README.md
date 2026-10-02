# MoliInsight

Self-hosted usage data for the Moli apps: one ingest protocol, one database, one dashboard, and an export that an AI can read. See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the design and [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

Status: M0 (contract), M1 (ingest, admin, retention, import), the M2 SDKs (web, node, Swift), M3 (dashboard overview and event browser, daily counts, export format) and M4 (event catalog, funnels and ratios, sessions, release comparison, friction, performance, MCP) are done. Wiring the SDKs into Cashier and MoliSwitch is what remains.

## Run it locally

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars               # fill in the secrets; see Sign-in below
npm run migrate:local
npm run dev                                                          # worker on :8787, dashboard with hot reload on http://localhost:5173
```

`npm run dev` starts `wrangler dev` and the Vite dev server together; Vite proxies `/api`, `/v1` and `/mcp` to the worker. Open http://localhost:5173, sign in with Authelia, and the setup wizard creates your first app and key, shows the code to paste into your app, and tells you when the first event arrives. (The worker alone serves the last built dashboard at :8787; `npm run build` rebuilds it, and `dev` and `deploy` do that for you.)

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

The dashboard is a React single-page app in `apps/dashboard` (Vite, Tailwind, TanStack Query and Router, Recharts). Pages: overview with change against the previous period, events, sessions, funnels and metrics, release comparison, friction, performance, navigation, feature usage, and per-app settings (keys, devices, event catalog upload with a dry run, MoliSwitch import, export, retention, delete) plus people, admin tokens and the activity log. Filters live in the URL, so any view can be shared as a link. Days begin at `DAY_OFFSET_MINUTES` in `apps/worker/wrangler.jsonc` (480 = UTC+8); change it before the first night's rollup, or old daily counts stay on the old boundary.

Read the data back (needs a dashboard session, or an admin token `mia_…` from the admin page; the format is in [docs/export-v1.md](docs/export-v1.md)):

```bash
curl -H "authorization: Bearer mia_..." "http://localhost:8787/v1/export?app=switch&limit=1000"
# NDJSON: a header line, one line per event, an end line with `next`; pass it back as &after=
```

SDKs: [docs/sdk-api.md](docs/sdk-api.md). Swift client for apps without a backend: [clients/swift](clients/swift/README.md). Cashier wiring: [docs/integration-cashier.md](docs/integration-cashier.md).

## Sign-in

Signing in to the dashboard is Authelia's (OIDC authorization code with PKCE); there is no password of our own. The client is `moli-insight`, registered on xiangyu-box (see `docs/sop/authelia-登记客户端.md` in MoliSpec):

```bash
cd /work/MoliSpec/tools/authelia
./moli-authelia add moli-insight --name "MoliInsight" \
  --redirect https://insight.xiangyu.pro/auth/callback \
  --redirect http://localhost:5173/auth/callback      # the second is for `npm run dev`
```

`CLIENT_SECRET` is shown once: put it in `OIDC_CLIENT_SECRET` (`wrangler secret put` in production, `.dev.vars` locally). Who may use the dashboard is `OIDC_ALLOWED_USERS` in `apps/worker/wrangler.jsonc`, a list of Authelia usernames. Everyone else is turned away even with a valid Authelia login, and taking a name off the list ends their session at once. To end every session, change `SESSION_SECRET`.

The sidebar shows who is signed in, and the Activity page (操作记录) lists who changed what: sign-ins and refusals, apps, keys, tokens, people, devices, funnels, catalog uploads and log imports (one row per import, however many batches). It records changes, not views, never holds a key or token (only its prefix), and keeps a year.

Export and MCP use admin tokens (`mia_…`), not this sign-in, so what they do is not in the Activity page.

## Deploy

```bash
npx wrangler d1 create moli-insight           # put the id into apps/worker/wrangler.jsonc
npm run migrate:remote -w @moli-insight/worker
npx wrangler secret put KEY_HMAC_SECRET       # in apps/worker
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OIDC_CLIENT_SECRET    # from `moli-authelia add`, see Sign-in
npm run deploy -w @moli-insight/worker       # builds the dashboard first
npm run migrate:remote -w @moli-insight/worker
```

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
