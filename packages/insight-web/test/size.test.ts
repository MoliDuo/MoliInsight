import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const BUDGET = 4096;

describe("bundle size", () => {
  it(`is at most ${BUDGET} bytes gzipped with everything switched on`, async () => {
    const result = await build({
      entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2022",
      write: false,
    });
    const bytes = gzipSync(result.outputFiles[0]!.contents, { level: 9 }).length;
    console.log(`web SDK: ${bytes} bytes gzipped`);
    expect(bytes).toBeLessThanOrEqual(BUDGET);
  });
});
