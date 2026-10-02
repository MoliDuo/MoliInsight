#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { deterministicUuid } from "@moli-insight/protocol";
import { uploadCatalog } from "./catalog.ts";
import { importUsageLog } from "./import.ts";

const USAGE = `usage: moli-insight import [options] <usage-log.jsonl>...
       moli-insight catalog [options] <catalog.json>

Sends a local JSONL usage log (MoliSwitch's usage-YYYY-MM-DD.jsonl) to a
MoliInsight server. Running it again on the same file adds nothing.

  --url <url>         server address            (default: $INSIGHT_URL)
  --key <key>         ingest key of the app     (default: $INSIGHT_KEY)
  --platform <name>   web|ios|android|windows|macos|server   (default: macos)
  --device-id <id>    dev_...                   (default: derived from the host name)
  --release <text>    release, instead of the version in appStart
  --include <names>   only these events, comma separated
  --exclude <names>   leave these events out, comma separated
  --dry-run           read and count, send nothing

catalog replaces the app\'s event catalog (events, metrics, funnels) with the
file. It takes --url, --key and --dry-run.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    key: { type: "string" },
    platform: { type: "string", default: "macos" },
    "device-id": { type: "string" },
    release: { type: "string" },
    include: { type: "string" },
    exclude: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...files] = positionals;
if (values.help || (command !== "import" && command !== "catalog") || files.length === 0) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 2);
}

const url = values.url ?? process.env.INSIGHT_URL;
const key = values.key ?? process.env.INSIGHT_KEY;
if (!values["dry-run"] && (!url || !key)) {
  console.error("Both the server address (--url or INSIGHT_URL) and the ingest key (--key or INSIGHT_KEY) are needed.\n");
  process.exit(2);
}

if (command === "catalog") {
  if (files.length !== 1) {
    console.error("catalog takes exactly one file.\n");
    process.exit(2);
  }
  try {
    const summary = await uploadCatalog(readFileSync(files[0]!, "utf8"), {
      url: url ?? "http://localhost",
      key: key ?? "",
      dryRun: values["dry-run"],
    });
    console.log(
      `${summary.events} events, ${summary.metrics} metrics, ${summary.funnels} funnels ${summary.dryRun ? "checked, nothing sent" : "uploaded"}`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const platforms = ["web", "ios", "android", "windows", "macos", "server"] as const;
const platform = platforms.find((p) => p === values.platform);
if (!platform) {
  console.error(`Unknown platform "${values.platform}".\n`);
  process.exit(2);
}

const names = (text: string | undefined) => (text ? new Set(text.split(",").map((s) => s.trim()).filter(Boolean)) : undefined);
const deviceId =
  values["device-id"] ?? `dev_${(await deterministicUuid(hostname())).replaceAll("-", "").slice(0, 20)}`;
const include = names(values.include);
const exclude = names(values.exclude);

let failed = false;
for (const file of files) {
  console.log(file);
  try {
    const summary = await importUsageLog(readFileSync(file, "utf8"), {
      url: url ?? "http://localhost",
      key: key ?? "",
      platform,
      deviceId,
      ...(values.release ? { release: values.release } : {}),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      dryRun: values["dry-run"],
      log: (line) => console.log(`  ${line}`),
    });
    console.log(
      `  ${summary.lines} lines: ${summary.accepted} ${values["dry-run"] ? "would be sent" : "new"}, ` +
        `${summary.duplicates} already there, ${summary.rejected} rejected by the server, ` +
        `${summary.filtered} filtered out, ${summary.tooOld} older than 7 days, ${summary.unreadable} unreadable`,
    );
  } catch (error) {
    console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
