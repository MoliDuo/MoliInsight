# Integrating Cashier

The plan for wiring Cashier (Next.js, has a backend) to MoliInsight with the web profile and a relay. Cashier's own repo is not touched by this repository; this is the checklist to follow there. Names and signatures are in [sdk-api.md](sdk-api.md).

## 0. Before starting

1. Deploy MoliInsight (README, "Deploy"), create an app `cashier` and an ingest key in the admin page.
2. Put `INSIGHT_URL` and `INSIGHT_KEY` into the Cashier deployment's environment. The key goes straight into the platform's settings, never through chat or the repo.
3. Get the two packages into Cashier. They are not on npm yet (see sdk-api.md): use `npm pack` tarballs or a git dependency until a scope is chosen.

## 1. Relay

`src/app/api/telemetry/route.ts`:

```ts
import { createInsight } from "@moli-insight/node";
import { requireAuth } from "@/lib/auth";

const insight = createInsight({ url: process.env.INSIGHT_URL, key: process.env.INSIGHT_KEY });

export const POST = insight.relayHandler({
  authorize: async (req) => Boolean(await requireAuth(req)),
});
```

The browser never sees the key. A signed-out user gets 401 and the SDK keeps its queue until they sign in again.

## 2. Browser setup

- `src/instrumentation-client.ts`: `init({ endpoint: "/api/telemetry", release: process.env.NEXT_PUBLIC_GIT_SHA })`, and `trackScreen` from `onRouterTransitionStart`.
- Providers: hand `useReportWebVitals`' metric to `reportVital`.
- `src/lib/sign-out-cleanup.ts` must **not** clear keys starting with `moli_insight_` (the device id would reset on every sign-out).

## 3. Shared entry points

| Place | Emits |
|---|---|
| `useLedgerMutation` (new required `name`) | `$op` through `startOp` |
| `postLedgerQuery` | `$op` |
| Dialog and overlay-history | `$dialog` (`trackDialog`) |
| toast wrapper | `$toast` |
| `error.tsx` | `$error` |

Auto-capture already covers `$session_start`, `$tap`, `$rage_tap`, `$dead_tap`, `$error` (uncaught), `$screen` and `$visibility`. Add `data-track="area.control"` to the controls that matter, such as `topbar.period_next`.

## 4. Business events

- Recording funnel: `record.open`, `record.input`, `record.submit`, `record.result`, `record.abandon`, `record.draft`.
- AI corrections: `detail.edit`.
- Others: filters, period switch, statistics, bulk actions, settings, sign-in.
- Server: `processing.finished` through `insight.send`, with `correlationId` equal to the one carried by `record.submit`.

Props carry types and codes, never amounts, notes or other user text.

## 5. Catalog

Keep `telemetry-catalog.json` in the Cashier repo, with `metrics` (for example abandonment = `record.abandon` ÷ `record.open`) and `funnels`, and update `docs/architecture.md`. Catalog upload to the platform arrives with M3/M4.

## 6. Done when

Use the app for a minute, then export (`GET /v1/export?app=cashier`, see the README) and find `$session_start`, `$screen`, `$tap`, a `$op` and a `record.*` event, with the release set to the git SHA.
