#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const ignoredDirs = new Set([".git", "node_modules", ".campaign-runtime"]);
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
  // Internal issue-tracker IDs must not leak into the public package. The words
  // "Linear" / "dogfood" are intentionally allowed — boundary docs reference them
  // (e.g. "does not require Linear access") — so only the opaque IDs are forbidden.
  /\bSELL-\d+\b/,
  /\bNEXTON-\d+\b/,
];

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
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
