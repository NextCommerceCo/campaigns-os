import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("consumer proof refuses an unbuilt checkout before packing or installing dependencies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "consumer-missing-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  const script = join(root, "scripts/check-playwright-consumer.mjs");
  copyFileSync(new URL("./check-playwright-consumer.mjs", import.meta.url), script);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /index\.js is missing; run npm run build:spec/);
});
