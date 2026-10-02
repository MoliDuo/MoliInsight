# MoliInsight Swift client

A small sink for native apps with no backend (MoliSwitch, and anything like it). It talks to `/v1/ingest` directly, so the app holds an **ingest key** (`mi_…`).

- One file of logic: [`InsightSink.swift`](Sources/MoliInsight/InsightSink.swift). No dependencies; Foundation only, macOS 12+.
- Not published as a package. Add this folder as a local Swift package, or copy the two files.
- Tests: `swift test` in this folder. They run on Linux with a fake transport; the Darwin-only paths (Application Support, `URLSession` on a real network) have not been exercised on macOS yet.

## Behaviour

| | |
|---|---|
| Session | one process run: `start()` makes a `ses_…` id and records `$session_start {navType: "launch"}` |
| Device | a random `dev_…` id kept in `<directory>/device-id` |
| Queue | `<directory>/queue.json`, so a crash or a quit loses nothing; capped at 5000 events (oldest dropped) |
| Sending | every 30 s, or at 50 queued; the first send waits 5 s so the opening events share a batch with `$session_start`; at most 100 events and 60 KB per request |
| 401 / 403 | the key is wrong or revoked: pause for 1 hour, keep the queue |
| 429 | wait for `Retry-After` |
| 5xx, no network | back off, keep the queue |
| other 4xx | drop that batch (it would be refused again) |
| `include` / `exclude` | `$` events always pass unless excluded; everything else must be in `include` when it is set |
| Property keys | rewritten if the server would refuse them (`InsightKey.sanitize`) |

## Wiring it into MoliSwitch

Leave the log format alone. `UsageLogging` is already a protocol, so add the sink next to `JSONLUsageLogger`:

```swift
final class InsightUsageLogger: UsageLogging {
    private let sink: InsightSink

    init?(key: String?, release: String) {
        guard let key, !key.isEmpty, let url = URL(string: "https://insight.example.workers.dev") else { return nil }
        var config = InsightConfig(endpoint: url, key: key, release: release)
        // Product events only. key, diag, snapshot and systemInputSourceChanged stay in the local log.
        config.include = ["appStart", "setting", "ruleEdit", "switch", "switchSkipped",
                          "manualSwitch", "fieldFocus", "slashEnd", "error"]
        sink = InsightSink(config: config, directory: appSupport.appendingPathComponent("insight"))
        sink.start()
    }

    func log(_ event: UsageEvent) { sink.record(logLine: event.asLogLine()) }   // {t, mono, e, ...fields}
}
```

Compose the two loggers where the app builds its logger today, and put the "usage log" switch in front of both (`sink.setEnabled(_:)` throws the queue away when turned off).

- `appStart` also becomes a `$session_start`: the sink already sends one per run, so `appStart` can stay as an ordinary event carrying the version details.
- Put the error code in its own `code` prop and keep `message` for text; the server cuts `message` to 200 characters.
- Call `sink.flush { … }` from `applicationWillTerminate` and wait for the completion for a second or two at most.

### The key

The repository is public, so the key is **not in the source**. Either:

1. CI writes it into the build (an `INSIGHT_KEY` secret substituted into an `Info.plist` value or a generated, git-ignored Swift file), or
2. the user pastes it into Settings.

A key inside a shipped binary can be extracted. That is accepted: it can only write, it is rate-limited **per key (120 requests/min) and per device (30 requests/min)**, and it can be revoked in the admin page. Rotate it by creating a new key, shipping it, and revoking the old one.

### Catalog

Keep `telemetry-catalog.json` in the MoliSwitch repo: mark `key`, `diag`, `snapshot` as `tier: debug`, and declare `manual_correction_rate = manualSwitch ÷ switch` grouped by `app`. Uploading catalogs is not built yet (M3/M4); the file format is in [`packages/protocol/schema/catalog-v1.json`](../../packages/protocol/schema/catalog-v1.json).

### Back-filling

For a day that is only in the local JSONL, including the debug events:

```bash
INSIGHT_URL=… INSIGHT_KEY=mi_… node packages/cli/src/bin.ts import usage-2026-10-02.jsonl
```

Importing the same file twice adds nothing.
