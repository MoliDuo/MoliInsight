import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url).href);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`],
  );
}

// Data from the API reaches the page only as text, which React escapes. This is the rule that keeps it so.
it("never writes HTML into the page", () => {
  const offenders = files(SRC)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});
