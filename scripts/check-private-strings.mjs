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
  } catch (error) {
    // A genuine non-checkout is expected and silent: no git binary (ENOENT) or
    // "not a git repository" (e.g. an unpacked npm tarball) — fall back to the
    // baseline. ANY other failure (broken/old git, killed child, permission
    // error) would also narrow scope, but invisibly, re-introducing the
    // false positives this derivation prevents — so leave a breadcrumb on
    // stderr instead of swallowing it.
    const expectedNonCheckout =
      error?.code === "ENOENT" || /not a git repository/i.test(error?.stderr ?? "");
    if (!expectedNonCheckout) {
      console.error(
        `check-private-strings: could not read git-ignored paths (${error?.message ?? error}); ` +
          "scanning all non-baseline files.",
      );
    }
    return new Set();
  }
}
const gitIgnored = gitIgnoredPaths();
// Always skipped, even outside a git checkout / when git's ignore list is
// unavailable (a worktree .git is a file, not a dir, so name-matching catches
// both). Mirrors the original hardcoded set so the fallback never widens scope.
const baselineIgnoredDirs = new Set([".git", "node_modules", ".campaign-runtime"]);
// private-template-sources.json is the one intentional place a private
// provider's org/repo is named: its whole job is to say WHERE a private
// template family's contract lives, not WHAT the family looks like.
const ignoredFiles = new Set(["package-lock.json", "check-private-strings.mjs", "private-template-sources.json"]);
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

      // Versioned parity fixtures in the public package are executable examples,
      // not a storage location for a customer's real run packet. Keep identity,
      // URL, and analytics values visibly synthetic; private evidence belongs in
      // the operator's ignored qa-output or an internal system of record.
      if (rel.startsWith("fixtures/parity/") && rel.endsWith(".json")) {
        try {
          const fixture = JSON.parse(text);
          const synthetic = /^(example|fixture|synthetic)/i;
          if (!synthetic.test(fixture?.campaign?.name ?? "")) {
            hits.push(`${rel}: parity campaign.name must be visibly synthetic`);
          }
          if (!synthetic.test(fixture?.campaign?.slug ?? "")) {
            hits.push(`${rel}: parity campaign.slug must be visibly synthetic`);
          }
          let hostname = null;
          try {
            hostname = new URL(fixture?.candidate_base_url).hostname;
          } catch {
            hits.push(`${rel}: parity candidate_base_url must be a valid example/test URL`);
          }
          if (
            hostname !== null &&
            !(hostname === "example.com" || hostname.endsWith(".example.com") || hostname.endsWith(".test"))
          ) {
            hits.push(`${rel}: parity candidate_base_url must use an example/test host`);
          }
          if (
            fixture?.gtm_container_id &&
            !(/^GTM-/.test(fixture.gtm_container_id) && synthetic.test(fixture.gtm_container_id.replace(/^GTM-/, "")))
          ) {
            hits.push(`${rel}: parity gtm_container_id must be visibly synthetic`);
          }
        } catch {
          hits.push(`${rel}: parity fixture must be valid JSON with synthetic provenance`);
        }
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
