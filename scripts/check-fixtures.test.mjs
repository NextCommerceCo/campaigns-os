import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const examplesRoot = resolve(root, "examples");

// Every file under examples/, tracked or not, keyed by relative path with its
// content hash. Ignored files count: the checkout is the unit, not `git status`.
function snapshotTree(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) snapshotTree(full, base, out);
    else out.set(relative(base, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return out;
}

test("the fixture check leaves the examples tree byte-identical", { timeout: 180_000 }, () => {
  const before = snapshotTree(examplesRoot);
  const result = execFileSync(process.execPath, [resolve(root, "scripts/check-fixtures.mjs")], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.match(result, /Fixture checks passed/);
  const after = snapshotTree(examplesRoot);
  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
  assert.deepEqual({ added, removed, changed }, { added: [], removed: [], changed: [] });
  // A sidecar left behind by an earlier run would be in `before` too; refuse it outright.
  assert.equal(
    existsSync(resolve(examplesRoot, "target-page-kit/.campaign-runtime")),
    false,
    "examples/target-page-kit carries a .campaign-runtime sidecar; the fixture check must run against a staged copy",
  );
});
