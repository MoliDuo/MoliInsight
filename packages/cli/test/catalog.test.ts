import { describe, expect, it } from "vitest";
import { uploadCatalog } from "../src/index.ts";

const catalog = {
  schemaVersion: 1,
  events: [{ name: "record.open", description: "Opened." }],
  metrics: [{ name: "m", description: "d", kind: "ratio", numerator: { event: "a" }, denominator: { event: "b" } }],
};

describe("uploadCatalog", () => {
  it("puts the checked catalog on the server", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const summary = await uploadCatalog(JSON.stringify(catalog), { url: "https://i.test/base", key: "mi_k", fetch: fetchFn });
    expect(summary).toEqual({ events: 1, metrics: 1, funnels: 0, dryRun: false });
    expect(calls[0]!.url).toBe("https://i.test/v1/catalog");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer mi_k");
  });

  it("sends nothing on a dry run, and nothing invalid", async () => {
    const never = (async () => {
      throw new Error("sent");
    }) as unknown as typeof fetch;
    expect((await uploadCatalog(JSON.stringify(catalog), { url: "https://i.test", key: "k", dryRun: true, fetch: never })).dryRun).toBe(true);
    await expect(uploadCatalog("{", { url: "https://i.test", key: "k", fetch: never })).rejects.toThrow("not valid JSON");
    await expect(
      uploadCatalog(JSON.stringify({ schemaVersion: 1, events: [{ name: "bad name", description: "x" }] }), { url: "https://i.test", key: "k", fetch: never }),
    ).rejects.toThrow("events.0.name");
  });

  it("reports what the server said", async () => {
    const fetchFn = (async () => Response.json({ error: "invalid_catalog", issues: [{ path: "metrics.0", message: "bad" }] }, { status: 400 })) as unknown as typeof fetch;
    await expect(uploadCatalog(JSON.stringify(catalog), { url: "https://i.test", key: "k", fetch: fetchFn })).rejects.toThrow(
      "400 invalid_catalog (metrics.0: bad)",
    );
  });
});
