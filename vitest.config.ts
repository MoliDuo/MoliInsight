import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages export their TypeScript source under the "source" condition.
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
