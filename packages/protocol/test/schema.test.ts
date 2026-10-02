import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { fixture, makeEvent, makeRequest } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(resolve(here, "../schema", name), "utf8"));

function compile(name: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  addFormats(ajv);
  return ajv.compile(load(name));
}

describe("ingest-v1.json", () => {
  const validate = compile("ingest-v1.json");

  it("accepts the example request", () => {
    expect(validate(JSON.parse(fixture("request-valid.json")))).toBe(true);
  });

  it.each([
    ["an event name with a space", makeRequest([makeEvent({ name: "bad name" })])],
    ["a name over 64 characters", makeRequest([makeEvent({ name: "a".repeat(65) })])],
    ["a doubled $ prefix", makeRequest([makeEvent({ name: "$$tap" })])],
    ["a prop key with a dot", makeRequest([makeEvent({ props: { "a.b": 1 } })])],
    ["an array of more than 20", makeRequest([makeEvent({ props: { a: Array(21).fill(1) } })])],
    ["an unknown platform", makeRequest([], { context: { platform: "plan9", release: "1" } })],
    ["a missing release", makeRequest([], { context: { platform: "web" } })],
    ["schema version 2", makeRequest([], { schemaVersion: 2 })],
    ["more than 100 events", makeRequest(Array.from({ length: 101 }, () => makeEvent()))],
    ["a time without an offset", makeRequest([makeEvent({ occurredAt: "2026-10-02T07:59:58" })])],
  ])("rejects %s", (_label, request) => {
    expect(validate(request)).toBe(false);
  });
});

describe("ingest-response-v1.json", () => {
  const validate = compile("ingest-response-v1.json");

  it("accepts the documented response", () => {
    expect(validate({ accepted: 98, duplicates: 1, rejected: [{ index: 3, reason: "props_too_large" }] })).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(validate({ accepted: 0, duplicates: 0, rejected: [{ index: 0, reason: "because" }] })).toBe(false);
  });
});

describe("catalog-v1.json", () => {
  const validate = compile("catalog-v1.json");

  it("accepts a catalog", () => {
    expect(validate({ schemaVersion: 1, events: [{ name: "record.submit", description: "A record was saved." }] })).toBe(true);
  });

  it("rejects the old bare-array shape", () => {
    expect(validate([{ name: "record.submit", description: "x" }])).toBe(false);
  });
});
