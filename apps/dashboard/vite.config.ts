import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

// In development the worker (`wrangler dev`) answers /api, /auth, /v1 and /mcp. The worker refuses
// cross-origin writes, so the proxy drops the Origin header that the Vite port would add.
const worker: ProxyOptions = {
  target: "http://localhost:8787",
  configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { "/api": worker, "/auth": worker, "/v1": worker, "/mcp": worker, "/healthz": worker },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
