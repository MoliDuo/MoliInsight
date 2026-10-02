import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, createHarness, type Harness } from "./harness.ts";

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
});
afterAll(() => h.close());

const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { cookie }) =>
  h.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("login", () => {
  it("rejects a wrong passphrase and locks out after ten failures", async () => {
    const harness = await createHarness();
    const bad = () =>
      harness.request("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(429);
    // Even the right passphrase waits.
    const right = await harness.request("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    expect(right.status).toBe(429);
    // The window passes.
    harness.clock.now += 16 * 60 * 1000;
    const later = await harness.request("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    expect(later.status).toBe(200);
    await harness.close();
  });

  it("sets an HttpOnly, SameSite=Strict cookie that /api/me accepts", async () => {
    const response = await h.request("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(await (await call("/api/me")).json()).toEqual({ authenticated: true });
    expect(await (await call("/api/me", "GET", undefined, {})).json()).toEqual({ authenticated: false });
  });

  it("refuses a session cookie after it expires or is tampered with", async () => {
    const original = h.clock.now;
    expect((await call("/api/apps", "GET", undefined, { cookie: `${cookie}x` })).status).toBe(401);
    h.clock.now += 31 * 24 * 60 * 60 * 1000;
    expect((await call("/api/apps")).status).toBe(401);
    h.clock.now = original;
  });
});

describe("guards", () => {
  it("requires a session for everything but login", async () => {
    for (const path of ["/api/apps", "/api/people", "/api/admin-tokens"]) {
      expect((await call(path, "GET", undefined, {})).status).toBe(401);
    }
  });

  it("refuses a mutation from another origin", async () => {
    const response = await call("/api/apps", "POST", { slug: "evil", name: "x" }, { cookie, origin: "https://evil.test" });
    expect(response.status).toBe(403);
    const same = await call("/api/apps", "POST", { slug: "good", name: "Good" }, { cookie, origin: "https://insight.test" });
    expect(same.status).toBe(201);
  });
});

describe("apps and keys", () => {
  it("creates, lists, patches and deletes an app", async () => {
    expect((await call("/api/apps", "POST", { slug: "switch", name: "MoliSwitch", retentionDays: 30 })).status).toBe(201);
    expect((await call("/api/apps", "POST", { slug: "switch", name: "again" })).status).toBe(409);
    expect((await call("/api/apps", "POST", { slug: "Bad Slug", name: "x" })).status).toBe(400);

    const list = (await (await call("/api/apps")).json()) as { apps: { slug: string; retentionDays: number }[] };
    expect(list.apps.find((a) => a.slug === "switch")?.retentionDays).toBe(30);

    const patched = await call("/api/apps/switch", "PATCH", { retentionDays: 45 });
    expect(((await patched.json()) as { retentionDays: number }).retentionDays).toBe(45);
    expect((await call("/api/apps/none", "PATCH", { name: "x" })).status).toBe(404);

    expect((await call("/api/apps/switch", "DELETE")).status).toBe(200);
    expect((await call("/api/apps/switch", "DELETE")).status).toBe(404);
  });

  it("shows a key once and never stores it", async () => {
    await call("/api/apps", "POST", { slug: "keyed", name: "Keyed" });
    const created = (await (await call("/api/apps/keyed/keys", "POST", { label: "ci" })).json()) as {
      key: string;
      prefix: string;
    };
    expect(created.key).toMatch(/^mi_/);

    const listed = JSON.stringify(await (await call("/api/apps/keyed/keys")).json());
    expect(listed).not.toContain(created.key);

    const stored = await h.env.DB.prepare("SELECT key_hash, key_prefix FROM app_keys WHERE label = 'ci'").first<{
      key_hash: string;
      key_prefix: string;
    }>();
    expect(stored!.key_hash).not.toContain(created.key);
    expect(created.key.startsWith(stored!.key_prefix)).toBe(true);
  });

  it("issues admin tokens (mia_) and revokes them", async () => {
    const created = (await (await call("/api/admin-tokens", "POST", { label: "mcp" })).json()) as {
      id: number;
      token: string;
    };
    expect(created.token).toMatch(/^mia_/);
    expect((await call(`/api/admin-tokens/${created.id}/revoke`, "POST")).status).toBe(200);
    expect((await call(`/api/admin-tokens/${created.id}/revoke`, "POST")).status).toBe(404);
  });

  it("does not let an ingest key authenticate as an admin token, or the reverse", async () => {
    const { authenticateAdminToken, authenticateIngestKey } = await import("../src/keys.ts");
    const ingestKey = await h.newApp("cross", cookie);
    const admin = (await (await call("/api/admin-tokens", "POST", { label: "x" })).json()) as { token: string };
    expect(await authenticateAdminToken(h.env, ingestKey, h.clock.now, () => {})).toBeNull();
    expect(await authenticateIngestKey(h.env, admin.token, h.clock.now, () => {})).toBeNull();
  });
});

describe("people and devices", () => {
  it("assigns a device to a person and deletes a device with its data", async () => {
    const key = await h.newApp("people-app", cookie);
    const body = {
      schemaVersion: 1,
      sentAt: "2026-10-02T08:00:00.000Z",
      context: { platform: "macos", release: "1.0.0", deviceId: "dev_people0001" },
      events: [
        { id: "00000000-0000-4000-8000-00000000f001", name: "appStart", occurredAt: "2026-10-02T07:59:00.000Z" },
      ],
    };
    const sent = await h.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    expect(sent.status).toBe(200);

    const person = (await (await call("/api/people", "POST", { name: "xiangyu" })).json()) as { id: number };
    expect((await call("/api/people", "POST", { name: "xiangyu" })).status).toBe(409);

    const devices = (await (await call("/api/apps/people-app/devices")).json()) as { devices: { id: number }[] };
    const deviceId = devices.devices[0]!.id;
    expect((await call(`/api/devices/${deviceId}`, "PUT", { personId: person.id })).status).toBe(200);
    expect((await call(`/api/devices/${deviceId}`, "PUT", { personId: 99999 })).status).toBe(404);

    const after = (await (await call("/api/apps/people-app/devices")).json()) as {
      devices: { personName: string }[];
    };
    expect(after.devices[0]!.personName).toBe("xiangyu");

    expect((await call(`/api/devices/${deviceId}`, "DELETE")).status).toBe(200);
    const left = await h.env.DB.prepare("SELECT count(*) AS n FROM events WHERE device_ref = ?1").bind(deviceId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
