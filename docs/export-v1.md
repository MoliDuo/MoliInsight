# Export format v1

`GET /v1/export?app=<slug>` returns an app's raw events for an AI or a script to read. Needs `Authorization: Bearer mia_…` (an admin token from the admin page) or a dashboard session.

| Query | |
|---|---|
| `app` | the app's slug (required) |
| `from`, `to` | ISO 8601 or epoch milliseconds, `to` excluded. Default: from the start of the app's retention to now |
| `limit` | events per page, default 5000, at most 10000 |
| `after` | the `next` cursor of the previous page |
| `format` | `ndjson` (default) or `json` |

## NDJSON

One JSON object per line, in this order:

1. **`header`**, once. On the first page it also holds everything needed to read the events:
   - `format: "moli-insight-export"`, `version: 1`, `app`, `from`, `to`, `exportedAt` (epoch ms)
   - `dayOffsetMinutes`: where days begin, minutes east of UTC. `retentionDays`
   - `catalog`: the app's catalog entries (`kind`, `name`, `definition`); empty until catalogs are uploaded
   - `people` (names), `devices` (`deviceId`, `person`, `platform`, `deviceClass`, `os`, `client`, `lastRelease`, `firstSeenAt`, `lastSeenAt`; the 500 most recent), `releases` (`release`, `devices`, `sessions`)
   - `summary`: `sessions`, `devices`, `events`, `activeDays`, `avgSessionMs`, `platforms`, `people`, `durations`, for sessions that started in the range. These are the numbers on the dashboard's overview
   - `eventCounts`: `[{ name, events }]`, the dashboard's event list

   Later pages (with `after`) carry only the first six fields.
2. **`event`**, one per event, oldest first:
   `id` (the client's UUID), `name`, `at` (epoch ms, after clock correction), `receivedAt`, `mono`?, `platform`, `release`, `deviceId`?, `person`?, `sessionId`?, `correlationId`?, `route`?, `props`? (object).
3. **`end`**, once: `count` (events in this page) and `next`, the cursor for the next page or `null` when the range is exhausted.

```bash
curl -H "authorization: Bearer mia_…" "$INSIGHT_URL/v1/export?app=switch&from=2026-10-01&limit=2000" > page1.ndjson
tail -1 page1.ndjson        # {"type":"end","count":2000,"next":"1790916539843.812"}
curl -H "authorization: Bearer mia_…" "$INSIGHT_URL/v1/export?app=switch&from=2026-10-01&limit=2000&after=1790916539843.812"
```

Keep `from` and `to` the same across pages.

## JSON

`format=json` returns `{ header, events, end }` as one object. Only for ranges of at most 7 days (otherwise `400 range_too_large`), because a single response cannot hold a large history.

## What the numbers are

- Raw events are kept for the app's retention (90 days by default). `$tap` and `$visibility` are kept raw for 30 days; after that only their daily counts remain (see the dashboard's event list).
- Per-day counts use the deployment's day boundary (`DAY_OFFSET_MINUTES`, UTC+8 by default in `wrangler.jsonc`).
- Deleting a device removes its events from the export; the daily counts, which hold no device identity, keep them.
