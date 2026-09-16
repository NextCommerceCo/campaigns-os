#!/usr/bin/env node

/**
 * Contract test: starter-template partial defaults must match next-campaigns-build doctrine.
 *
 * Scenario this catches: doctrine in skills/next-campaigns-build/SKILL.md declares
 * `default \`show_line_total_price=false\`` for prepurchase bumps, but a partial in the
 * templates repo defaults `show_line_total_price=true`. The agent applies doctrine; the
 * gallery renders the partial default. Drift = the bug fixed in templates repo PR #51.
 *
 * v1 scope (per architecture grill, 2026-05-22):
 *   - Parse doctrine from SKILL.md by matching `VAR=VALUE` backtick pairs.
 *   - Parse partial Liquid defaults from {% if VAR == nil %}{% assign VAR = VALUE %}{% endif %}.
 *   - Assert that, for every partial that declares a default for a doctrine variable,
 *     the partial value equals the doctrine value.
 *
 * Out of scope for v1:
 *   - "Missing parameterization" detection (partials that hardcode rendering with no
 *     Liquid param). When the catalog gains `presentationKnobs`, that check should be
 *     added here too — assert each partial parameterizes every knob declared for its surface.
 *   - Pre-fetched/synced template snapshot. v1 reads from a sibling checkout path; CI
 *     adds the sibling via actions/checkout.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { resolveStarterTemplatesSource } from "./starter-templates-path.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const skillPath = resolve(root, "skills/next-campaigns-build/SKILL.md");
const sharedContractPath = resolve(root, "contracts/template-brand-contract.shared-commerce.v0.json");
const catalogPath = resolve(root, "contracts/commerce-surface-catalog.json");
// Validate the partials at the commit the vendored catalog was synced from —
// the tree CI checks out — not whatever a local sibling checkout happens to be
// at. See resolveStarterTemplatesSource for the fallback order.
// An absent pin is a legacy snapshot (CI falls back to the templates' main
// branch; check-catalog-provenance warns); a present pin that is not a commit
// SHA is a contract error and stops here, as it does in CI.
const pinSha = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8"))._synced_from_sha ?? null : null;
if (pinSha !== null && !/^[0-9a-f]{40}$/.test(String(pinSha))) {
  fail(`contracts/commerce-surface-catalog.json _synced_from_sha is malformed (${JSON.stringify(pinSha)}); expected a 40-char commit SHA. Re-run refresh:starter-catalog.`);
}
// The pinned archive lives under the temp dir; remove it on any exit,
// including a signal, which skips the "exit" handler. Registered before the
// archive is made so a signal during extraction is covered too.
let templatesSource = { path: null, kind: "sibling", cleanup() {} };
process.on("exit", () => templatesSource.cleanup());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    templatesSource.cleanup();
    process.exit(1);
  });
}
templatesSource = resolveStarterTemplatesSource(root, { pinSha });
const templatesRoot = templatesSource.path;

function fail(message) {
  console.error(`check-template-doctrine: ${message}`);
  process.exit(1);
}

if (!existsSync(skillPath)) {
  fail(`Missing build-skill doctrine source: ${relative(root, skillPath)}`);
}
if (!existsSync(templatesRoot)) {
  fail(
    `Cannot find starter-templates checkout at ${templatesRoot}.\n` +
      `Set STARTER_TEMPLATES_PATH or check out NextCommerceCo/campaign-cart-starter-templates as a sibling.`,
  );
}

const shortSha = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : "unknown");
function templatesSourceLine(source) {
  switch (source.kind) {
    case "override":
      return `templates: ${source.path} (STARTER_TEMPLATES_PATH; CI pins this checkout to _synced_from_sha=${shortSha(source.pinSha)})`;
    case "sibling_at_pin":
      return `templates: ${source.path} at _synced_from_sha=${shortSha(source.pinSha)}`;
    case "pinned_archive":
      return `templates: read at _synced_from_sha=${shortSha(source.pinSha)} from the sibling checkout (its HEAD ${shortSha(source.headSha)} differs; working tree untouched)`;
    case "sibling_unpinned":
      return (
        `WARNING: validating the sibling checkout at ${source.path} (HEAD ${shortSha(source.headSha)}), ` +
        `NOT the catalog pin _synced_from_sha=${shortSha(source.pinSha)} that CI validates: ${source.reason}. ` +
        `A green result here is not evidence for the CI gate. ` +
        `Fetch the pinned commit into the sibling (git -C ${source.path} fetch origin ${source.pinSha}) ` +
        `or set STARTER_TEMPLATES_PATH to a checkout at that commit.`
      );
    default:
      return `templates: ${source.path} (no catalog pin; CI validates the same tree only by coincidence)`;
  }
}
// Say it before scanning, so the warning survives a failing run's output too.
if (templatesSource.kind === "sibling_unpinned") {
  console.error(`check-template-doctrine: ${templatesSourceLine(templatesSource)}`);
}

// 1. Parse doctrine pairs from SKILL.md.
const skillMd = readFileSync(skillPath, "utf8");
const doctrinePairRegex = /`([a-z_][a-z0-9_]*)=([a-z_][a-z0-9_]*)`/gi;
const doctrine = new Map();
for (const match of skillMd.matchAll(doctrinePairRegex)) {
  const [, name, value] = match;
  // Skip values that aren't simple booleans/identifiers we can compare against
  // Liquid defaults (which serialize as true/false/strings/numbers).
  if (!/^(true|false|\d+)$/.test(value)) continue;
  if (doctrine.has(name) && doctrine.get(name) !== value) {
    fail(
      `Doctrine in ${relative(root, skillPath)} declares ${name} with conflicting values ` +
        `(${doctrine.get(name)} and ${value}). Resolve before this check can pass.`,
    );
  }
  doctrine.set(name, value);
}

if (doctrine.size === 0) {
  fail(
    `Did not extract any doctrine pairs from ${relative(root, skillPath)}. ` +
      `Expected lines like \`default \\\`show_line_total_price=false\\\`\`.`,
  );
}

// 2. Walk the templates repo for every .html file under src/. Permissive on
//    purpose: doctrine variables only live in commerce partials, so scanning
//    layout/landing-section files costs a few extra string ops but never produces
//    false positives. Earlier glob-based scoping missed _layouts/ at depth 3 — a
//    coverage gap better solved by widening than by maintaining brittle globs.
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "_site" || entry.startsWith(".")) continue;
      walk(full, acc);
    } else if (entry.endsWith(".html")) {
      acc.push(full);
    }
  }
  return acc;
}

const partials = walk(resolve(templatesRoot, "src"));

// 3. For each partial, look for Liquid defaults targeting any doctrine variable.
//    Match: {% if VAR == nil %}{% assign VAR = VALUE %}{% endif %}
//    Tolerant of whitespace and the {% ... -%} trim form.
// Escape regex metacharacters before interpolation. Defense-in-depth: the doctrine
// extractor restricts varName to /[a-z_][a-z0-9_]*/ so no metacharacters reach here
// today, but explicit escaping keeps the call site obviously safe if that constraint
// ever relaxes.
function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function partialDefaultRegex(varName) {
  const v = escapeForRegExp(varName);
  // `g` flag so matchAll surfaces every default-assignment of the variable in a
  // partial. A partial declaring the same var twice with conflicting defaults is
  // a real (rare) authoring bug; without `g` we'd only catch the first.
  return new RegExp(
    `\\{%-?\\s*if\\s+${v}\\s*==\\s*nil\\s*-?%\\}` +
      `\\s*\\{%-?\\s*assign\\s+${v}\\s*=\\s*([a-z_0-9'"]+)\\s*-?%\\}`,
    "gi",
  );
}

const violations = [];
const coverage = new Map(); // varName -> count of partials that declare a default

for (const path of partials) {
  const content = readFileSync(path, "utf8");
  for (const [varName, doctrineValue] of doctrine) {
    const matches = [...content.matchAll(partialDefaultRegex(varName))];
    if (matches.length === 0) continue;
    coverage.set(varName, (coverage.get(varName) || 0) + 1);
    for (const match of matches) {
      // Strip Liquid string quotes but preserve case. Case drift on Liquid boolean
      // literals (True/TRUE vs true) is itself a partial-authoring bug we want to
      // surface, not normalize away.
      const partialValue = match[1].replace(/['"]/g, "");
      if (partialValue !== doctrineValue) {
        violations.push({
          file: relative(templatesRoot, path),
          varName,
          partialValue,
          doctrineValue,
        });
      }
    }
  }
}

// 4. Payment-chrome asset hashes. The shared-commerce contract records the
//    sha256 of each chrome asset as the starter ships it
//    (default_residue.payment_chrome.asset_sha256, pinned by asset_pin.sha);
//    browser QA compares served bytes against them to tell an untouched strip
//    from one edited in place. A hash that no longer matches the pinned tree
//    would read every deployed copy of the starter asset as edited, so the
//    contract is checked against the same pinned checkout the partials are.
//    The pin recorded in the contract must be the catalog pin: one commit
//    describes the shipped bytes, not two. Skipped (with a note) when the tree
//    under test is not at the pin, since a drifted sibling proves nothing.
const hashViolations = [];
let hashedAssets = 0;
{
  const contract = existsSync(sharedContractPath) ? JSON.parse(readFileSync(sharedContractPath, "utf8")) : null;
  const chrome = contract?.default_residue?.payment_chrome;
  const hashes = chrome?.asset_sha256 && typeof chrome.asset_sha256 === "object" ? chrome.asset_sha256 : {};
  const contractPin = chrome?.asset_pin?.sha ?? null;
  if (Object.keys(hashes).length > 0) {
    if (pinSha !== null && contractPin !== pinSha) {
      hashViolations.push(
        `${relative(root, sharedContractPath)}: payment_chrome.asset_pin.sha is ${shortSha(contractPin)}, ` +
          `the catalog pin _synced_from_sha is ${shortSha(pinSha)}. Re-hash the assets at the catalog pin and record it.`,
      );
    }
    const atPin = templatesSource.kind === "sibling_at_pin" || templatesSource.kind === "pinned_archive" || templatesSource.kind === "override";
    if (!atPin) {
      console.warn(`  note: payment_chrome.asset_sha256 not verified (templates tree is not at the catalog pin).`);
    } else {
      const families = readdirSync(join(templatesRoot, "src")).filter((entry) => statSync(join(templatesRoot, "src", entry)).isDirectory());
      for (const [asset, expected] of Object.entries(hashes)) {
        for (const family of families) {
          const file = join(templatesRoot, "src", family, "assets", asset);
          if (!existsSync(file)) continue;
          hashedAssets += 1;
          const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
          if (actual !== String(expected).toLowerCase()) {
            hashViolations.push(`src/${family}/assets/${asset}: sha256 ${actual} at the pin; contract records ${expected}.`);
          }
        }
        if (!families.some((family) => existsSync(join(templatesRoot, "src", family, "assets", asset)))) {
          hashViolations.push(`${asset}: hashed in the contract but no family ships it at the pin.`);
        }
      }
    }
  }
}
if (hashViolations.length > 0) {
  console.error(`check-template-doctrine: ${hashViolations.length} payment-chrome asset hash(es) disagree with the pinned starter templates.\n`);
  for (const line of hashViolations) console.error(`  ${line}`);
  console.error(
    `\nRe-hash each asset at the catalog pin (sha256 of the file bytes) into ` +
      `contracts/template-brand-contract.shared-commerce.v0.json default_residue.payment_chrome.asset_sha256, ` +
      `and set asset_pin.sha to that commit.`,
  );
  process.exit(1);
}

// 5. Report.
if (violations.length > 0) {
  console.error(
    `check-template-doctrine: ${violations.length} partial(s) disagree with build-skill doctrine.\n`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}: defaults ${v.varName}=${v.partialValue}, ` +
        `doctrine wants ${v.varName}=${v.doctrineValue}`,
    );
  }
  console.error(
    `\nFix the partial defaults, or update the build doctrine in ` +
      `skills/next-campaigns-build/SKILL.md if the rule has genuinely changed.`,
  );
  process.exit(1);
}

const doctrinePairs = [...doctrine.entries()]
  .map(([k, v]) => `${k}=${v}`)
  .sort()
  .join(", ");
console.log(
  `Template doctrine check passed (${doctrine.size} doctrine pair(s): ${doctrinePairs}; ` +
    `${partials.length} partials scanned; ${hashedAssets} payment-chrome asset hash(es) verified).`,
);
if (templatesSource.kind !== "sibling_unpinned") {
  console.log(`  ${templatesSourceLine(templatesSource)}`);
}

for (const [varName, doctrineValue] of doctrine) {
  if (!coverage.has(varName)) {
    console.warn(
      `  note: no partial declares a Liquid default for ${varName}=${doctrineValue}. ` +
        `Doctrine applies only to agent overrides today; partials may hardcode rendering.`,
    );
  }
}
