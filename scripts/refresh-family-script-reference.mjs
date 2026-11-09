#!/usr/bin/env node
// Refresh contracts/family-script-reference.v0.json and its blobs: the bundled
// reference doctor's family script divergence advisory compares against
// (#729, #730 finding 7). See src/family-script-reference.mjs for the contract.
//
// The source is campaign-cart-starter-templates at the commit the vendored
// commerce-surface catalog was synced from (`_synced_from_sha`), and only that
// commit: a reference at any other commit would describe families the catalog
// does not. It is read with `git show`, so the checkout's working tree and HEAD
// never matter (CI's pinned checkout, the catalog refresh workflow's shallow
// fetch and a local sibling all work).
//
// The explicit list: every `src/<family>/assets/js/**/*.js` of each certified
// public family (in the catalog and carrying a brand contract), recorded under
// the path page-kit builds it to (`js/...`, under the campaign directory). The
// family's `config.js` is generated configuration and is recorded by rule, not
// bundled. A family in contracts/private-template-sources.json is never
// bundled, even if it appears in the catalog.
//
// Usage: node scripts/refresh-family-script-reference.mjs [--check]
//   --check  regenerate in memory and fail if the committed files differ.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FAMILY_SCRIPT_REFERENCE_BLOB_DIR,
  FAMILY_SCRIPT_REFERENCE_FILE,
  FAMILY_SCRIPT_REFERENCE_SCHEMA,
  familyScriptReferenceBlobPath,
  sha256Hex,
  splitLines,
} from "../src/family-script-reference.mjs";
import { resolveStarterTemplatesRoot } from "./starter-templates-path.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const check = process.argv.slice(2).includes("--check");
const catalog = JSON.parse(readFileSync(join(root, "contracts", "commerce-surface-catalog.json"), "utf8"));
const privateFamilies = Object.keys(JSON.parse(readFileSync(join(root, "contracts", "private-template-sources.json"), "utf8")).sources || {}).sort();
const SOURCE_REPO = "NextCommerceCo/campaign-cart-starter-templates";

const sha = catalog._synced_from_sha;
if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) throw new Error(`The catalog's _synced_from_sha is ${JSON.stringify(sha)}; the reference is only generated from the catalog pin.`);
const templates = resolveStarterTemplatesRoot(root);
const git = (args, options = {}) => execFileSync("git", ["-C", templates, ...args], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...options });
try {
  git(["cat-file", "-e", `${sha}^{commit}`]);
} catch {
  throw new Error(`${templates} does not have the catalog pin ${sha}; fetch it there (or set STARTER_TEMPLATES_PATH to a checkout that has it).`);
}

const families = Object.keys(catalog.families || {})
  .filter((family) => existsSync(join(root, "contracts", `template-brand-contract.${family}.v0.json`)))
  .filter((family) => !privateFamilies.includes(family))
  .sort();
const campaigns = JSON.parse(git(["show", `${sha}:_data/campaigns.json`], { encoding: "utf8" }));

const blobs = new Map();
const familyEntries = {};
for (const family of families) {
  const assets = `src/${family}/assets/`;
  const paths = git(["ls-tree", "-r", "--name-only", sha, "--", assets], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path.startsWith(`${assets}js/`) && path.endsWith(".js"))
    .sort();
  if (!paths.length) throw new Error(`Certified family "${family}" has no ${assets}js/**/*.js at ${sha.slice(0, 7)}; the catalog and the templates source disagree.`);
  const sdkVersion = campaigns[family]?.sdk_version;
  if (typeof sdkVersion !== "string" || !sdkVersion) throw new Error(`Certified family "${family}" has no sdk_version in _data/campaigns.json at ${sha.slice(0, 7)}.`);
  familyEntries[family] = {
    sdk_version: sdkVersion,
    scripts: paths.map((path) => {
      const bytes = git(["show", `${sha}:${path}`]);
      const digest = sha256Hex(bytes);
      blobs.set(digest, bytes);
      return { built_path: path.slice(assets.length), source_path: path, sha256: digest, bytes: bytes.length, lines: splitLines(bytes.toString("utf8")).length };
    }),
  };
}

const contract = {
  schema_version: FAMILY_SCRIPT_REFERENCE_SCHEMA,
  purpose: "Bytes, SHA-256 and provenance of the public starter-family scripts doctor's family script divergence advisory compares a campaign's built copies against. Hashes establish equality; the blobs give line and hunk deltas. A filename or path match nominates a candidate; it does not prove the campaign copy descends from the family file.",
  source: {
    repo: SOURCE_REPO,
    sha,
    pin: "contracts/commerce-surface-catalog.json _synced_from_sha",
  },
  generated_by: "scripts/refresh-family-script-reference.mjs",
  blob_path: `${FAMILY_SCRIPT_REFERENCE_BLOB_DIR}/<sha256>.js.txt`,
  compared: "Every src/<family>/assets/js/**/*.js of each certified public family at source.sha, under the path page-kit builds it to below the campaign directory.",
  sdk_applicability: "Each family's sdk_version is the Campaign Cart SDK its _data/campaigns.json entry pins at source.sha: the SDK these files are written against.",
  generated_configuration: [
    {
      built_path: "config.js",
      source_path: "src/<family>/assets/config.js",
      rule: "Not bundled and not compared: page-kit renders campaign values (API key, store details, analytics) into it, so a campaign copy differs from the family file by design.",
    },
  ],
  private_families: {
    families: privateFamilies,
    rule: "Never bundled. Doctor reports the comparison for a private family as unavailable.",
  },
  families: familyEntries,
};

const contractText = `${JSON.stringify(contract, null, 2)}\n`;
const blobDir = join(root, FAMILY_SCRIPT_REFERENCE_BLOB_DIR);
const wanted = new Map([...blobs].map(([digest, bytes]) => [familyScriptReferenceBlobPath(digest), bytes]));

if (check) {
  const problems = [];
  const committed = join(root, FAMILY_SCRIPT_REFERENCE_FILE);
  if (!existsSync(committed) || readFileSync(committed, "utf8") !== contractText) problems.push(`${FAMILY_SCRIPT_REFERENCE_FILE} is stale`);
  for (const [path, bytes] of wanted) {
    const full = join(root, path);
    if (!existsSync(full) || !readFileSync(full).equals(bytes)) problems.push(`${path} is missing or differs`);
  }
  const present = existsSync(blobDir) ? readdirSync(blobDir).map((name) => `${FAMILY_SCRIPT_REFERENCE_BLOB_DIR}/${name}`) : [];
  for (const path of present) if (!wanted.has(path)) problems.push(`${path} is not named by the reference`);
  if (problems.length) {
    console.error(`family script reference check FAILED at catalog pin ${sha.slice(0, 7)}:\n- ${problems.join("\n- ")}\nRun: node scripts/refresh-family-script-reference.mjs`);
    process.exit(1);
  }
  console.log(`family script reference current: ${families.length} families, ${Object.values(familyEntries).reduce((sum, entry) => sum + entry.scripts.length, 0)} scripts, ${wanted.size} blobs at ${sha.slice(0, 7)}`);
} else {
  rmSync(blobDir, { recursive: true, force: true });
  mkdirSync(blobDir, { recursive: true });
  for (const [path, bytes] of wanted) writeFileSync(join(root, path), bytes);
  writeFileSync(join(root, FAMILY_SCRIPT_REFERENCE_FILE), contractText);
  console.log(`Refreshed ${FAMILY_SCRIPT_REFERENCE_FILE}: ${families.length} families, ${wanted.size} blobs at ${sha.slice(0, 7)}`);
}
