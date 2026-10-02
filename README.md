# MoliInsight

Self-hosted usage data for the Moli apps: one ingest protocol, one database, one dashboard, and an export that an AI can read. See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the design and [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

Status: M0 (contract), M1 (ingest, admin, retention, import), the M2 SDKs (web, node, Swift), M3 (dashboard overview and event browser, daily counts, export format) and M4 (event catalog, funnels and ratios, sessions, release comparison, friction, performance, MCP) are done. Wiring the SDKs into Cashier and MoliSwitch is what remains.

## Run it locally

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run hash-password -w @moli-insight/worker -- "your passphrase"   # paste the output into .dev.vars
npm run migrate:local
npm run dev -w @moli-insight/worker                                  # http://localhost:8787
```

Open the address, sign in, create an app and a key. Then send data:

```bash
curl -X POST http://localhost:8787/v1/ingest \
  -H "authorization: Bearer mi_..." \
  -d @packages/protocol/test/fixtures/request-valid.json
```

Import a MoliSwitch usage log (running it twice adds nothing):

```bash
INSIGHT_URL=http://localhost:8787 INSIGHT_KEY=mi_... \
  node packages/cli/src/bin.ts import ~/path/to/usage-2026-10-02.jsonl
```

The dashboard (overview, events, funnels and metrics, sessions, release comparison, friction, performance, navigation, feature usage, apps) is at the worker's address. Days begin at `DAY_OFFSET_MINUTES` in `apps/worker/wrangler.jsonc` (480 = UTC+8); change it before the first night's rollup, or old daily counts stay on the old boundary.

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
npm run deploy -w @moli-insight/worker
```

## Check

`npm run check` runs the type check, all tests and verifies that the generated JSON Schemas are up to date.

Describe an app's events, ratio metrics and funnels once, in a catalog file that lives in the app's repository ([format](docs/protocol-v1.md#8-事件目录)):

```bash
INSIGHT_URL=http://localhost:8787 INSIGHT_KEY=mi_... \
  node packages/cli/src/bin.ts catalog telemetry-catalog.json   # replaces the app's catalog; --dry-run only checks it
```

Let Claude query the data over MCP (admin token, [tools](docs/protocol-v1.md#8b-mcp)):

```bash
claude mcp add --transport http moli-insight http://localhost:8787/mcp --header "Authorization: Bearer mia_..."
```
