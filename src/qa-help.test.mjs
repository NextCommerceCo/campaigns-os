import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

test("qa help describes topology-derived common and full test-order coverage", () => {
  const output = execFileSync(process.execPath, [CLI, "qa", "help"], { encoding: "utf8" });

  assert.match(output, /common.*checkout, first-offer accept\/decline/s);
  assert.match(output, /deduplicated shortest real receipt path.*at most 4 orders/s);
  assert.match(output, /full.*every actual terminal path/s);
  assert.match(output, /cycles, missing routes, and reachable nonterminals.*block before browser launch/s);
  assert.match(output, /default cap is 6; overflow names the exact raise/s);
  assert.match(output, /Commercial pages are checked automatically against \/api\/price-preview/s);
  assert.match(output, /no commercial sidecar or extra catalog flag is required/s);
});
