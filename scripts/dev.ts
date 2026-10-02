// Starts the worker and the dashboard's Vite server together:
//   the dashboard at http://localhost:5173 (hot reload), proxying /api, /v1 and /mcp to the worker at :8787.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

// wrangler refuses to start without the assets directory, even though Vite serves the pages here.
mkdirSync(new URL("../apps/dashboard/dist/", import.meta.url), { recursive: true });

const run = (name: string, cwd: string, args: string[]) => {
  const child = spawn("npx", args, { cwd: new URL(cwd, import.meta.url), stdio: "inherit" });
  child.on("exit", (code) => {
    console.error(`${name} stopped (${code ?? "signal"})`);
    shutdown(code ?? 1);
  });
  return child;
};

const children = [run("worker", "../apps/worker/", ["wrangler", "dev"]), run("dashboard", "../apps/dashboard/", ["vite"])];
let closing = false;
function shutdown(code: number) {
  if (closing) return;
  closing = true;
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
