import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { compareVersions, escapeRegExp, extractVersion, listFiles, normalizeString, relPath, rootId, shouldSkipDir, unique } from "./repo-scan.mjs";

function withTree(run) {
  const dir = mkdtempSync(join(tmpdir(), "repo-scan-"));
  try {
    for (const path of ["src/a.html", "src/build/out.html", "_site/index.html", ".git/HEAD", ".campaigns-os/manifest.json", ".hidden/x", "node_modules/pkg/index.js", "README.md"]) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "");
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rel = (dir, files) => files.map((file) => relative(dir, file).split("\\").join("/"));

test("listFiles honours the caller's skip set, never enters .git or node_modules, and keeps .campaigns-os", () => {
  withTree((dir) => {
    const skip = new Set(["_site"]);
    assert.deepEqual(rel(dir, listFiles(dir, { skipDirs: skip })), [".campaigns-os/manifest.json", "README.md", "src/a.html", "src/build/out.html"]);
    // A wider skip set (the ecosystem scanner also skips build/) narrows the walk.
    assert.deepEqual(rel(dir, listFiles(dir, { skipDirs: new Set(["_site", "build"]) })), [".campaigns-os/manifest.json", "README.md", "src/a.html"]);
    // includeRuntime lifts the skip set but still never enters .git / node_modules.
    const runtime = rel(dir, listFiles(dir, { includeRuntime: true, skipDirs: skip }));
    assert.ok(runtime.includes("_site/index.html"));
    assert.ok(runtime.includes(".hidden/x"));
    assert.ok(!runtime.some((file) => file.startsWith(".git/") || file.startsWith("node_modules/")));
    assert.deepEqual(listFiles(join(dir, "missing")), []);
  });
});

test("shouldSkipDir: skip set plus every dot-directory except .campaigns-os", () => {
  const skip = new Set(["_site"]);
  assert.equal(shouldSkipDir("_site", skip), true);
  assert.equal(shouldSkipDir(".git", skip), true);
  assert.equal(shouldSkipDir(".campaigns-os", skip), false);
  assert.equal(shouldSkipDir("src", skip), false);
  assert.equal(shouldSkipDir(".hidden"), true);
});

test("version helpers compare the first x.y.z found and treat an unversioned side as equal", () => {
  assert.deepEqual(extractVersion("next-campaign-page-kit@0.4.38"), [0, 4, 38]);
  assert.equal(extractVersion("latest"), null);
  assert.equal(compareVersions("0.4.38", "0.4.36"), 1);
  assert.equal(compareVersions("0.4.36", "0.4.38"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("latest", "1.0.0"), 0);
});

test("string helpers: escapeRegExp, normalizeString, unique, relPath, rootId", () => {
  assert.equal(new RegExp(escapeRegExp("a.b*c?")).test("a.b*c?"), true);
  assert.equal(new RegExp(escapeRegExp("a.b")).test("axb"), false);
  assert.equal(escapeRegExp(null), "");
  assert.equal(normalizeString("  x  "), "x");
  assert.equal(normalizeString("   "), null);
  assert.equal(normalizeString(3), null);
  assert.deepEqual(unique(["a", "", null, undefined, "a", "b"]), ["a", "b"]);
  assert.equal(relPath("/repo", "/repo"), ".");
  assert.equal(relPath("/repo", "/repo/src/x"), "src/x");
  assert.equal(rootId("/repo", "/repo/src/camp aign"), "src-camp-aign");
  assert.equal(rootId("/repo", "/repo"), ".");
});
