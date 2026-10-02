import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/index.js",
  legalComments: "none",
});

const size = gzipSync(readFileSync("dist/index.js"), { level: 9 }).length;
console.log(`dist/index.js: ${size} bytes gzipped`);
