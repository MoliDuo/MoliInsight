# MoliInsight

Self-hosted usage data for the Moli apps: one ingest protocol, one database, one dashboard, and an export that an AI can read. See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the design and [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

Status: M0 (contract) and M1 (ingest, admin, retention, import) are done. SDKs, the dashboard and MCP come next.

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
