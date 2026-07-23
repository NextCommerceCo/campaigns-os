#!/usr/bin/env node

/**
 * Contract guard: starter-template frontmatter must stay a subset of the
 * template-slot-manifest content-slot core (plus each family's overlay).
 *
 * Scenario this catches: a template PR adds a new frontmatter key to a shared
 * page (or renames one) without declaring it in the shared content-slot core.
 * Producers assemble against the manifest; an undeclared key is a slot no
 * producer can fill and no doctor check governs — drift becomes a build
 * failure here instead of a discovery inside a campaign build.
 *
 * Direction of the check: template keys ⊆ manifest. The manifest MAY declare
 * slots the checked-out templates do not carry yet (a manifest can run ahead
 * of a template release); those surface as notes, never failures.
 *
 * Reads the starter-templates checkout from STARTER_TEMPLATES_PATH or the
 * sibling ../campaign-cart-starter-templates (same model as
 * check-template-doctrine.mjs; CI pins the sibling checkout to the vendored
 * catalog's _synced_from_sha).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  loadTemplateSlotManifest,
  declaredSlotKeys,
  commerceOwnedPages,
  sharedContentCorePath,
} from "../src/template-slot-manifest.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const templatesRoot = resolve(
  process.env.STARTER_TEMPLATES_PATH || resolve(root, "../campaign-cart-starter-templates"),
);

// Flat frontmatter keys of a page-kit page: lines matching `key: ...` between
// the --- fences at column 0. Nested structure lines are indented and
// deliberately ignored — structured objects are declared via their flat
// parent key (commerce slots). The capture is deliberately WIDE (any
// non-comment token before a colon): a key with unsupported syntax
// (`promo-headline:`, `"quoted":`, uppercase) must reach the subset
// comparison and fail as undeclared, not be silently skipped.
export function flatFrontmatterKeys(text) {
  const keys = [];
  let fences = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === "---") {
      fences += 1;
      if (fences === 2) break;
      continue;
    }
    if (fences !== 1) continue;
    if (/^[#\s-]/.test(line)) continue; // comments, nested lines, list items
    // Capture up to the FIRST colon ([^\s:]+ cannot backtrack across colons),
    // with no trailing-whitespace requirement — a no-space line like
    // `canonical:https://x` still surfaces "canonical" for the subset
    // comparison instead of being silently skipped.
    const match = /^([^\s:]+):/.exec(line);
    if (match) keys.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return keys;
}

// Pure subset check for one family. Returns { violations, notes }.
export function checkFamilyPages(manifest, pages) {
  const skip = commerceOwnedPages(manifest);
  const violations = [];
  const notes = [];
  for (const { page, keys } of pages) {
    if (skip.has(page)) continue;
    const declared = declaredSlotKeys(manifest, page);
    if (!declared.size) {
      violations.push({ page, key: "(page)", reason: "page has no manifest entry and is not commerce-owned" });
      continue;
    }
    for (const key of keys) {
      if (!declared.has(key)) {
        violations.push({ page, key, reason: "frontmatter key not declared in the slot manifest" });
      }
    }
    const present = new Set(keys);
    for (const key of declared) {
      if (!present.has(key)) notes.push({ page, key });
    }
  }
  return { violations, notes };
}

function fail(message) {
  console.error(`check-slot-manifest: ${message}`);
  process.exit(1);
}

function main() {
  if (!existsSync(templatesRoot)) {
    fail(
      `Cannot find starter-templates checkout at ${templatesRoot}.\n` +
        `Set STARTER_TEMPLATES_PATH or check out NextCommerceCo/campaign-cart-starter-templates as a sibling.`,
    );
  }
  const srcRoot = join(templatesRoot, "src");
  if (!existsSync(srcRoot)) fail(`Starter-templates checkout has no src/ at ${srcRoot}.`);

  // Non-family directories (e.g. the composable landing section library) are
  // declared by the shared content-slot core — the contract owns the
  // allowlist, not this script. Anything else without a manifest FAILS: a new
  // or renamed family must ship its slot manifest, not silently bypass CI.
  let core = null;
  try {
    core = JSON.parse(readFileSync(sharedContentCorePath(), "utf8"));
  } catch (error) {
    fail(`Cannot read the shared content-slot core: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(core?.non_family_dirs?.dirs)) {
    // Fail on the REAL problem: without this field every non-family dir would
    // error as "no manifest", which reads as template drift instead of a
    // stale core contract.
    fail(
      `Shared content-slot core at ${sharedContentCorePath()} is missing non_family_dirs.dirs — ` +
        `update the core contract (it owns the non-family directory allowlist).`,
    );
  }
  const EXEMPT_NON_FAMILY_DIRS = new Set(core.non_family_dirs.dirs.map(String));

  let families = 0;
  let pagesChecked = 0;
  const allViolations = [];
  const allNotes = [];
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const family = entry.name;
    const manifest = loadTemplateSlotManifest(family);
    if (!manifest) {
      if (!EXEMPT_NON_FAMILY_DIRS.has(family)) {
        allViolations.push({
          family,
          page: "(family)",
          key: "(manifest)",
          reason: "family directory has no template-slot-manifest and is not an exempt non-family dir",
        });
      }
      continue;
    }
    families += 1;
    const pages = [];
    for (const file of readdirSync(join(srcRoot, family))) {
      if (!file.endsWith(".html")) continue;
      const page = basename(file, ".html");
      const keys = flatFrontmatterKeys(readFileSync(join(srcRoot, family, file), "utf8"));
      pages.push({ page, keys });
      pagesChecked += 1;
    }
    if (!pages.length) {
      allViolations.push({
        family,
        page: "(family)",
        key: "(pages)",
        reason: "manifested family has zero top-level pages — nothing was checked (moved/nested pages bypass the gate)",
      });
      continue;
    }
    const { violations, notes } = checkFamilyPages(manifest, pages);
    for (const v of violations) allViolations.push({ family, ...v });
    for (const n of notes) allNotes.push({ family, ...n });
  }

  if (families === 0) {
    fail("No family in the starter-templates checkout has a slot manifest — nothing was checked.");
  }

  if (allViolations.length) {
    console.error(`check-slot-manifest: ${allViolations.length} undeclared frontmatter key(s).\n`);
    for (const v of allViolations) {
      console.error(`  ${v.family}/${v.page}: ${v.key} — ${v.reason}`);
    }
    console.error(
      `\nDeclare the key in contracts/template-slot-manifest.shared-content-core.v0.json ` +
        `(shared across families) or the family overlay, or mark the page commerce-owned.`,
    );
    process.exit(1);
  }

  console.log(
    `Slot-manifest subset check passed (${families} families, ${pagesChecked} pages).`,
  );
  const noteKeys = [...new Set(allNotes.map((n) => `${n.page}.${n.key}`))];
  if (noteKeys.length) {
    console.log(
      `  note: manifest declares ${noteKeys.length} slot(s) the checkout does not carry yet ` +
        `(manifest may run ahead of a template release): ${noteKeys.slice(0, 6).join(", ")}${noteKeys.length > 6 ? ", …" : ""}`,
    );
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
