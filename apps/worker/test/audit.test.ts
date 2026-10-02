import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_DAYS } from "../src/audit.ts";
import { runRetention } from "../src/retention.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let cookie: string;
let second: string;
beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  second = await h.login("second");
});
afterAll(() => h.close());

const call = (path: string, method = "GET", body?: unknown, as = cookie) =>
  h.request(path, {
    method,
    headers: { "content-type": "application/json", cookie: as },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Entry { id: number; at: number; user: string; action: string; target: string; detail: Record<string, unknown> }
const log = async (query = "") => (await (await call(`/api/audit${query}`)).json()) as { entries: Entry[]; next: string | null; users: string[] };
const actions = async () => (await log()).entries.map((e) => `${e.user}:${e.action}:${e.target}`).reverse();

describe("the audit log", () => {
  it("records each change under the signed-in user, with what it was about", async () => {
    await call("/api/apps", "POST", { slug: "notes", name: "Notes" });
    await call("/api/apps/notes", "PATCH", { retentionDays: 30 });
    const key = (await (await call("/api/apps/notes/keys", "POST", { label: "ci" })).json()) as { id: number; key: string; prefix: string };
    await call(`/api/keys/${key.id}/revoke`, "POST");
    const token = (await (await call("/api/admin-tokens", "POST", { label: "claude" }, second)).json()) as { id: number; token: string; prefix: string };
    await call(`/api/admin-tokens/${token.id}/revoke`, "POST", undefined, second);
    const person = (await (await call("/api/people", "POST", { name: "Me" })).json()) as { id: number };
    await call(`/api/people/${person.id}`, "DELETE");

    expect(await actions()).toEqual([
      "tester:app.create:notes",
      "tester:app.update:notes",
      "tester:key.create:notes",
      `tester:key.revoke:${key.prefix}`,
      `second:token.create:${token.prefix}`,
      `second:token.revoke:${token.prefix}`,
      "tester:person.create:Me",
      "tester:person.delete:Me",
    ]);
    const { entries } = await log();
    const byAction = (a: string) => entries.find((e) => e.action === a)!;
    expect(byAction("app.create").detail).toEqual({ name: "Notes", retentionDays: 90 });
    expect(byAction("app.update").detail).toEqual({ retentionDays: 30 });
    expect(byAction("key.create").detail).toEqual({ prefix: key.prefix, label: "ci" });
    expect(byAction("key.revoke").detail).toEqual({ label: "ci" });
    expect(entries.every((e) => e.at === h.clock.now)).toBe(true);
  });

  it("never holds a key or token", async () => {
    const key = (await (await call("/api/apps/notes/keys", "POST", { label: "leak-check" })).json()) as { key: string };
    const token = (await (await call("/api/admin-tokens", "POST", { label: "leak-check" })).json()) as { token: string };
    const rows = await h.env.DB.prepare("SELECT * FROM audit_log").all();
    const text = JSON.stringify(rows.results);
    expect(text).not.toContain(key.key);
    expect(text).not.toContain(token.token);
  });

  it("records devices, funnels, the catalog and sign-out", async () => {
    const before = (await log()).entries.length;
    const sdkKey = (await (await call("/api/apps/notes/keys", "POST", { label: "sdk" })).json()) as { key: string };
    await h.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${sdkKey.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1, sentAt: new Date(h.clock.now).toISOString(),
        context: { platform: "web", release: "r1", deviceId: "dev_audit00000001" },
        events: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "x", occurredAt: new Date(h.clock.now).toISOString() }],
      }),
    });
    const device = ((await (await call("/api/apps/notes/devices")).json()) as { devices: { id: number }[] }).devices[0]!;
    const person = (await (await call("/api/people", "POST", { name: "Her" })).json()) as { id: number };
    await call(`/api/devices/${device.id}`, "PUT", { personId: person.id });
    await call(`/api/devices/${device.id}`, "DELETE");
    await call("/api/apps/notes/funnels/flow", "PUT", { name: "flow", steps: [{ event: "a" }, { event: "b" }], windowMs: 60000, by: "session" });
    await call("/api/apps/notes/funnels/flow", "DELETE");
    // A dry run changes nothing and says nothing.
    await call("/api/apps/notes/catalog?dryRun=1", "PUT", { schemaVersion: 1, events: [{ name: "a.b", description: "d" }] });
    await call("/api/apps/notes/catalog", "PUT", { schemaVersion: 1, events: [{ name: "a.b", description: "d" }] });
    await call("/api/logout", "POST");

    const added = (await log()).entries.slice(0, (await log()).entries.length - before).reverse().filter((e) => !e.action.startsWith("key.") && e.action !== "person.create");
    expect(added.map((e) => `${e.action}:${e.target}`)).toEqual([
      "device.assign:dev_audit00000001",
      "device.delete:dev_audit00000001",
      "funnel.save:notes/flow",
      "funnel.delete:notes/flow",
      "catalog.replace:notes",
      "auth.logout:",
    ]);
    expect(added[0]!.detail).toEqual({ person: "Her" });
    expect(added[4]!.detail).toMatchObject({ events: 1 });
  });

  it("leaves out requests that failed", async () => {
    const before = (await log()).entries.length;
    expect((await call("/api/apps", "POST", { slug: "notes", name: "again" })).status).toBe(409);
    expect((await call("/api/apps/none", "DELETE")).status).toBe(404);
    expect((await call("/api/keys/9999/revoke", "POST")).status).toBe(404);
    expect((await call("/api/people", "POST", { name: "" })).status).toBe(400);
    expect((await log()).entries.length).toBe(before);
  });

  it("adds a log's batches up as one import", async () => {
    const send = (n: number) => call("/api/apps/notes/import", "POST", {
      schemaVersion: 1, sentAt: new Date(h.clock.now).toISOString(),
      context: { platform: "macos", release: "1", deviceId: "dev_import0000001" },
      events: [{ id: `00000000-0000-4000-8000-0000000000b${n}`, name: "x", occurredAt: new Date(h.clock.now - 1000).toISOString() }],
    });
    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(200);
    expect((await send(2)).status).toBe(200); // a duplicate
    let imports = (await log()).entries.filter((e) => e.action === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ user: "tester", target: "notes", detail: { batches: 3, accepted: 2, duplicates: 1, rejected: 0 } });
    // Much later, or by someone else, it is a new import.
    h.clock.now += 31 * 60_000;
    await send(3);
    await call("/api/apps/notes/import", "POST", { schemaVersion: 1, sentAt: new Date(h.clock.now).toISOString(), context: { platform: "macos", release: "1", deviceId: "dev_import0000001" }, events: [] }, second);
    imports = (await log()).entries.filter((e) => e.action === "import");
    expect(imports.map((e) => e.user).sort()).toEqual(["second", "tester", "tester"]);
    h.clock.now -= 31 * 60_000;
  });

  it("pages newest first and can be limited to one user", async () => {
    for (let i = 0; i < 40; i++) await h.env.DB.prepare("INSERT INTO audit_log (at, user, action) VALUES (?1, 'tester', 'filler')").bind(h.clock.now).run();
    const first = await log();
    expect(first.entries.length).toBe(50);
    expect(first.next).toBe(String(first.entries.at(-1)!.id));
    const second = await log(`?before=${first.next}`);
    expect(second.entries[0]!.id).toBeLessThan(first.entries.at(-1)!.id);
    expect(first.users).toEqual(["second", "tester"]);
    const only = await log("?user=second");
    expect(only.entries.length).toBeGreaterThan(0);
    expect(only.entries.every((e) => e.user === "second")).toBe(true);
  });

  it("is for signed-in users only", async () => {
    expect((await h.request("/api/audit")).status).toBe(401);
  });

  it("is pruned after a year", async () => {
    const day = 24 * 60 * 60 * 1000;
    await h.env.DB.prepare("INSERT INTO audit_log (at, user, action) VALUES (?1, 'tester', 'old.thing'), (?2, 'tester', 'recent.thing')")
      .bind(h.clock.now - (AUDIT_DAYS + 1) * day, h.clock.now - (AUDIT_DAYS - 1) * day).run();
    await runRetention(h.env.DB, h.clock.now);
    const left = (await h.env.DB.prepare("SELECT action FROM audit_log WHERE action IN ('old.thing','recent.thing')").all<{ action: string }>()).results;
    expect(left.map((r) => r.action)).toEqual(["recent.thing"]);
  });
});
