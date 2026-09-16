import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `package.json` exports that browser-targeted consumers bundle directly
// (esbuild, Vite). Their transitive static import graph must stay free of
// Node built-ins (`node:*`): a bundler resolving `node:crypto` for the browser
// fails the whole build, and a consumer should not need a shim to use a
// dependency-free contract module.
const BROWSER_CONSUMABLE_EXPORTS = ["./commercial-journey", "./commercial-parity", "./text-safety"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

// Static `import … from "x"`, `export … from "x"` and side-effect `import "x"`
// specifiers. Comments are stripped first so a mention in prose does not count.
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(filePath) {
  const source = stripComments(readFileSync(filePath, "utf8"));
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) specifiers.push(match[1] ?? match[2]);
  return specifiers;
}

/**
 * Walk the static import graph from `entryFile`, following relative `.mjs`
 * specifiers only. Returns the first `node:` specifier found as
 * `{ file, specifier }`, or null when the graph is clean.
 */
function firstNodeBuiltinImport(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importSpecifiers(file)) {
      if (specifier.startsWith("node:")) return { file, specifier };
      if (specifier.startsWith(".") && specifier.endsWith(".mjs")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return null;
}

function entryFileFor(exportKey) {
  const entry = packageJson.exports[exportKey];
  assert.ok(entry, `package.json exports has no ${exportKey} entry`);
  const target = typeof entry === "string" ? entry : entry.import ?? entry.default;
  assert.ok(typeof target === "string", `package.json exports ${exportKey} names no import target`);
  return resolve(repoRoot, target);
}

test("the import-graph walker sees a node: import through a relative re-export chain", () => {
  // `spec-identity.mjs` hashes with node:crypto; the walker must report it
  // from any entry that reaches it, naming the file that carries the import.
  const hit = firstNodeBuiltinImport(resolve(repoRoot, "src/spec-identity.mjs"));
  assert.deepEqual(hit, { file: resolve(repoRoot, "src/spec-identity.mjs"), specifier: "node:crypto" });
});

for (const exportKey of BROWSER_CONSUMABLE_EXPORTS) {
  test(`package export ${exportKey} reaches no node: built-in through its static import graph`, () => {
    const hit = firstNodeBuiltinImport(entryFileFor(exportKey));
    assert.equal(
      hit,
      null,
      hit
        ? `${exportKey} reaches "${hit.specifier}" via ${hit.file.slice(repoRoot.length + 1)}; browser bundlers cannot resolve it`
        : undefined,
    );
  });
}
