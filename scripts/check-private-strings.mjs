#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
// Mirror the gitignored build/output dirs: scanning them produces false
// positives (e.g. qa-output/ verdict JSON legitimately contains live
// campaigns.apps.29next.com URLs) on files git never commits, so `npm run
// check` would fail locally after a QA run while CI — which has no such
// output in a fresh checkout — stays green.
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  ".campaign-runtime",
  "qa-output",
  "coverage",
  "dist",
]);
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
    if (ignoredDirs.has(entry.name)) continue; // skip by name (worktree .git is a file, not a dir)
    const fullPath = join(dir, entry.name);
    const rel = relative(root, fullPath);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && !ignoredFiles.has(entry.name) && statSync(fullPath).size < 2_000_000) {
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
