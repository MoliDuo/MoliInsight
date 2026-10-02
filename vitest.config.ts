import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Workspace packages export their TypeScript source under the "source" condition.
    conditions: ["source"],
    alias: { "@": fileURLToPath(new URL("./apps/dashboard/src", import.meta.url)) },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}"],
  },
});
