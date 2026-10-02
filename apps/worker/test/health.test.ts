import { describe, expect, it } from "vitest";
import { app } from "../src/index.ts";

describe("worker", () => {
  it("answers the health check", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, schemaVersion: 1 });
  });
});
