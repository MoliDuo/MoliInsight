// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.ts";

describe("server-side rendering", () => {
  it("makes every call a no-op that does not throw", async () => {
    expect(() => {
      sdk.init({ endpoint: "/api/telemetry", release: "abc" });
      sdk.track("a.b", { x: 1 });
      sdk.trackScreen("/x");
      sdk.reportVital({ name: "LCP", value: 1 });
      sdk.trackDialog("d", "open");
      sdk.setEnabled(true);
      sdk.startOp("save").end({ ok: true });
    }).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(sdk.getDeviceId()).toBeUndefined();
  });
});
