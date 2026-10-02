/**
 * Writes the JSON Schema files in `schema/` from the Zod schemas, which are the
 * single source of truth. `--check` compares instead of writing, so CI fails
 * when a schema changed and its JSON file did not.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CatalogSchema, IngestRequestSchema, IngestResponseSchema } from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    file: "schema/ingest-v1.json",
    id: "https://insight.moli.invalid/schema/ingest-v1.json",
    title: "MoliInsight ingest request v1",
    schema: IngestRequestSchema,
  },
  {
    file: "schema/ingest-response-v1.json",
    id: "https://insight.moli.invalid/schema/ingest-response-v1.json",
    title: "MoliInsight ingest response v1",
    schema: IngestResponseSchema,
  },
  {
    file: "schema/catalog-v1.json",
    id: "https://insight.moli.invalid/schema/catalog-v1.json",
    title: "MoliInsight event catalog v1",
    schema: CatalogSchema,
  },
] as const;

const check = process.argv.includes("--check");
let stale = false;

for (const target of targets) {
  const json = z.toJSONSchema(target.schema, { target: "draft-2020-12", io: "input" });
  const text =
    JSON.stringify({ ...json, $id: target.id, title: target.title }, null, 2) + "\n";
  const path = resolve(root, target.file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      console.error(`stale: ${target.file} (run npm run schema)`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${target.file}`);
  }
}

if (stale) process.exit(1);
