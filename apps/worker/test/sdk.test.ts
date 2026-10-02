import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInsight } from "@moli-insight/node";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
let key: string;
beforeAll(async () => {
  h = await createHarness();
  key = await h.newApp("cashier", await h.login());
});
afterAll(() => h.close());

/** The Node SDK, pointed at the worker in this process. */
const sdk = () =>
  createInsight({
    url: "https://insight.test",
    key,
    release: "rel1",
    fetch: ((input: string, init: RequestInit) => h.request(new URL(input).pathname, init)) as unknown as typeof fetch,
  });

const count = async (where = "1") =>
  (await h.env.DB.prepare(`SELECT count(*) AS n FROM events WHERE ${where}`).first<{ n: number }>())!.n;

describe("Node SDK against the worker", () => {
  it("relays a browser batch end to end", async () => {
    const handler = sdk().relayHandler({ authorize: async () => true });
    const response = await handler(
      new Request("https://app.test/api/telemetry", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          sentAt: new Date(h.clock.now).toISOString(),
          context: { platform: "web", release: "abc", deviceId: "dev_relaydevice1" },
          events: [
            { id: "00000000-0000-4000-8000-0000000000e1", name: "record.submit", occurredAt: new Date(h.clock.now - 1000).toISOString(), sessionId: "ses_relaysession1", correlationId: "rec_1" },
          ],
        }),
      }),
    );
    expect(response.status).toBe(204);
    expect(await count("name = 'record.submit' AND correlation_id = 'rec_1'")).toBe(1);
  });

  it("sends a server event that shares the correlation id", async () => {
    await sdk().send([{ name: "processing.finished", props: { ms: 900, ok: true }, correlationId: "rec_1" }]);
    const rows = await h.env.DB.prepare("SELECT name, platform FROM events WHERE correlation_id = 'rec_1' ORDER BY id").all<{
      name: string;
      platform: string;
    }>();
    expect(rows.results).toEqual([
      { name: "record.submit", platform: "web" },
      { name: "processing.finished", platform: "server" },
    ]);
  });

  it("tells the browser to drop a batch the worker refuses for good, and to back off when the key is revoked", async () => {
    const handler = sdk().relayHandler({ authorize: async () => true });
    const bad = await handler(new Request("https://app.test/api/telemetry", { method: "POST", body: "{nope" }));
    expect(bad.status).toBe(400);

    const cookie = await h.login();
    const listed = (await (await h.request("/api/apps/cashier/keys", { headers: { cookie } })).json()) as { keys: { id: number }[] };
    for (const k of listed.keys) await h.request(`/api/keys/${k.id}/revoke`, { method: "POST", headers: { cookie } });
    const revoked = await handler(new Request("https://app.test/api/telemetry", { method: "POST", body: "{}" }));
    expect(revoked.status).toBe(503);
  });
});
