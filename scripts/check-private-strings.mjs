#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

// Skip whatever git already ignores, derived live so this scan stays in
// lockstep with .gitignore instead of hand-mirroring it (which drifts: e.g.
// qa-output/ verdict JSON legitimately contains live storefront URLs, so a
// stale mirror would fail `npm run check` locally after a QA run while CI —
// fresh checkout, no output — stays green). `--directory` collapses fully
// ignored dirs to a single entry so we never descend into them.
function gitIgnoredPaths() {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { cwd: root, encoding: "utf8" },
    );
    return new Set(
      out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/\/+$/, "")),
    );
  } catch {
    // Not a git checkout (e.g. an unpacked npm tarball) — rely on the baseline.
    return new Set();
  }
}
const gitIgnored = gitIgnoredPaths();
// Always skipped, even outside a git checkout / when git's ignore list is
// unavailable (a worktree .git is a file, not a dir, so name-matching catches
// both). Mirrors the original hardcoded set so the fallback never widens scope.
const baselineIgnoredDirs = new Set([".git", "node_modules", ".campaign-runtime"]);
const ignoredFiles = new Set(["package-lock.json", "check-private-strings.mjs"]);
const forbidden = [
  /\/Users\//,
  /next-campaigns-ops/,
  /next-mind/,
  /gstack/,
  /campaigns\.apps\.29next\.com/,
  /\bDevin\b/,
  /\bSellmore\b/,
  /\bsellmore\b/,
  /nc-campaigns-proxy/,
  /QA Supervisor/,
];

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (baselineIgnoredDirs.has(entry.name)) continue; // skip by name (a worktree .git is a file, not a dir)
    const fullPath = join(dir, entry.name);
    const rel = relative(root, fullPath);
    if (entry.isDirectory()) {
      if (gitIgnored.has(rel)) continue;
      walk(fullPath);
    } else if (
      entry.isFile() &&
      !ignoredFiles.has(entry.name) &&
      !gitIgnored.has(rel) &&
      statSync(fullPath).size < 2_000_000
    ) {
      const text = readFileSync(fullPath, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) hits.push(`${rel}: ${pattern}`);
      }
    }
  }
}

walk(root);

if (hits.length) {
  console.error("Forbidden private/internal strings found:");
  for (const hit of hits) console.error(`- ${hit}`);
  process.exit(1);
}

console.log("Private string check passed");
