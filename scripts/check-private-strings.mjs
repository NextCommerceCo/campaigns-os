#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  // Internal issue-tracker IDs must not leak into the public package. The words
  // "Linear" / "dogfood" stay allowed — boundary docs reference them
  // (e.g. "does not require Linear access") — so only the opaque IDs are forbidden.
  // No trailing \b: an ID with a suffix (SELL-362a) must still trip. Kept as
  // \d+ rather than [A-Za-z0-9]+ so SELL-abc, which is not an ID shape, does not
  // match, and case-sensitive because /i would flag legitimate commerce terms —
  // "down-sell-2" is a real page-type fixture in src/built-site-scope.test.mjs.
  /\bSELL-\d+/,
  /\bNEXTON-\d+/,
];

// Real merchant, partner and product names must not appear in the public
// package. They are listed as SHA-256 digests of the lowercased name, spaces
// removed, so this public file does not itself publish them. Each file is
// split into lowercase alphanumeric tokens; every run of 1 to
// MAX_NAME_TOKENS adjacent tokens, joined, is hashed and compared, so a name
// of up to four words matches however it is spaced or punctuated.
// To add a name (up to four words):
//   printf %s "<name>" | tr -cd '[:alnum:]' | tr A-Z a-z | shasum -a 256
const forbiddenNameDigests = new Set([
  "c2c3ea48cb89889662a1b6cd117f2b3f143f355c775a0c79bcd46abbe0da8880",
  "c1d055b43d41642c66c2e36351d1091c0fe48c4e92d87b2bb747792928066a96",
  "6c32526bc655d7a0aefc30608a76b5f9e8fdc7471728ebc2f02d0fc4a869dd9f",
  "a3de97924989e2869faf58c8f0e09f1f9649888107d846981c6255383aae4d97",
  "db456ee00056496fb02d96376e41f2380bbf519e6802066e53210fd8651a81d8",
  "c8e00fc5f30b63090f85aefb03f9da5bbd4c1b139d61cbaf83a3394ecb9b5ba6",
  "b4bddef55932b9c0c5b53b69cc00dcfc318e51231a7cc04f8f8e9885560db1e8",
  "0a2f0014d5c79bde9794ff66ef2c27607c3dafb69cd57c5ca7d65c0b83c0f4cc",
  "8b654d33637291362b9d348be89cfc184a29cb23f5688b459dbb08e68bfb05f4",
  "db314b92af6fa36c1dbd3b9e925dc2dceccdda99853954170983bfc7487e63c2",
  "88d16ff00370dfab8664564f49fbb8c7fec5395d4e61371c13656320045afc5b",
  "6c262aa794ce2c453cb42e655ab4c0286958c610d6b072e52449d089c2a4510c",
  "b5c21cb4fcb0c4d110a13c676c785e4bfde7cbffca22049dedfb99f8113fc652",
  "c8e02b6b4ace04008590c7928711319a558ddecfc53873b29ae494e6ca8430a7",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const MAX_NAME_TOKENS = 4;

export function hasForbiddenName(text, digests = forbiddenNameDigests) {
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    let candidate = "";
    for (let n = 0; n < MAX_NAME_TOKENS && i + n < tokens.length; n += 1) {
      candidate += tokens[i + n];
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (digests.has(sha256(candidate))) return true;
    }
  }
  return false;
}

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
      if (hasForbiddenName(text)) hits.push(`${rel}: real merchant/partner name (hashed denylist)`);

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

function main() {
  walk(root);

  if (hits.length) {
    console.error("Forbidden private/internal strings found:");
    for (const hit of hits) console.error(`- ${hit}`);
    process.exit(1);
  }

  console.log("Private string check passed");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
