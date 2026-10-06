// F2.1-W15 and F2.1-B6: the history-reader guard (gates never read history
// as proof). The guard is this test code: it scans every
// non-test `src/**/*.mjs` file (a name not ending in `.test.mjs`) and fails
// when a file outside the closed allowlist contains a `.history` member read.
// Existing tests that inspect history (src/stage-ledger.test.mjs) are outside
// the scan. A synthetic violator reaches the scanner only through its own
// input (the file list), never through a file written under src/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { ROOT, withNetworkGuard } from "./input-test-factories.mjs";

const HISTORY_READER_ALLOWLIST = Object.freeze(["src/stage-ledger.mjs", "src/input-refresh.mjs", "src/readback.mjs"]);
const HISTORY_MEMBER_READ = /(?:\?\.|\.)\s*history\b|\[\s*["'`]history["'`]\s*\]/;

// Every non-test .mjs file under src/, as { path (repo-relative), text }.
function sourceFiles(root = ROOT) {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) return [];
    return [{ path: relative(root, path).split("\\").join("/"), text: readFileSync(path, "utf8") }];
  });
  return walk(join(root, "src")).sort((a, b) => a.path.localeCompare(b.path));
}

// The guard: the files outside the allowlist that read `.history`.
function historyReaderGuard(files) {
  const violations = files
    .filter((file) => !file.path.endsWith(".test.mjs") && !HISTORY_READER_ALLOWLIST.includes(file.path))
    .filter((file) => HISTORY_MEMBER_READ.test(file.text))
    .map((file) => file.path)
    .sort();
  return { pass: violations.length === 0, violations };
}

test("F2.1-W15: the history-reader static scan over the non-test tree passes (only allowlisted files read .history)", async () => {
  await withNetworkGuard(() => {
    const files = sourceFiles();
    assert.ok(files.length > 0, "setup: the scan covers a non-empty set of non-test src files");
    assert.equal(files.some((file) => file.path.endsWith(".test.mjs")), false, "setup: no test file is scanned");
    // The matcher is live: the allowlisted ledger reads history, and a test
    // that inspects QA history exists outside the scan.
    assert.equal(HISTORY_MEMBER_READ.test(files.find((file) => file.path === "src/stage-ledger.mjs")?.text ?? ""), true, "setup: src/stage-ledger.mjs reads .history (allowlisted)");
    assert.equal(HISTORY_MEMBER_READ.test(readFileSync(join(ROOT, "src/stage-ledger.test.mjs"), "utf8")), true, "setup: src/stage-ledger.test.mjs reads qa.history and is outside the scan");
    const result = historyReaderGuard(files);
    assert.deepEqual(result, { pass: true, violations: [] });
  });
});

test("F2.1-B6: a synthetic non-test module under src/ reading stage.history makes the history-reader guard fail", async () => {
  await withNetworkGuard(() => {
    const files = sourceFiles();
    assert.equal(historyReaderGuard(files).pass, true, "setup: the tree alone passes the guard");
    const violator = {
      path: "src/synthetic-history-reader.mjs",
      text: "export function assemblyDone(stage) {\n  return stage.history.some((entry) => entry.status === \"completed\");\n}\n",
    };
    const result = historyReaderGuard([...files, violator]);
    assert.deepEqual(result, { pass: false, violations: ["src/synthetic-history-reader.mjs"] });
  });
});
