#!/usr/bin/env node

/**
 * check-cart-readiness-contract — QA cart-state contract guard.
 *
 * `next.getCartData().cartLines` is currently ALWAYS an empty array, regardless
 * of cart contents: getCartData() returns cartStore.enrichedItems, which is
 * initialized [] and never populated. The real line items live in the cart
 * store's `items` / `summary.lines`. See NextCommerceCo/campaign-cart#36.
 *
 * Verified live on deployed checkouts (SDK 0.4.18 and 0.4.24): a correctly
 * committed bundle shows populated internal `items` while `cartLines` stays [].
 * So any QA/assertion code that gates on `cartLines` (e.g. `cartLines.length > 0`)
 * silently PASSES on an empty array — a false-positive "cart populated" verdict.
 *
 * This guard fails if QA harness source reaches for `cartLines` as a cart-state
 * signal. The harness intentionally verifies the committed cart via the typed-card
 * order read-back and selection via DOM bundle evidence (see docs/qa-and-test-orders.md);
 * this keeps it that way.
 *
 * Escape hatch: append `cart-readiness-contract:allow` on the same line for a
 * deliberate, reviewed exception. Once #36 ships and `cartLines` is populated,
 * relax or retire this guard (and update docs/qa-and-test-orders.md).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

// QA harness source lives in src/. Scan it (excluding tests, which may reference
// the forbidden token to exercise this very guard) for `cartLines` usage.
const scanDirs = ["src"];
const allowToken = "cart-readiness-contract:allow";
const forbidden = /\bcartLines\b/;

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.mjs$/.test(entry.name)) continue;
    if (/\.test\.mjs$/.test(entry.name)) continue;
    if (statSync(fullPath).size > 2_000_000) continue;
    const rel = relative(root, fullPath);
    const lines = readFileSync(fullPath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!forbidden.test(line)) return;
      if (line.includes(allowToken)) return;
      hits.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
}

for (const dir of scanDirs) {
  const abs = join(root, dir);
  try {
    if (statSync(abs).isDirectory()) walk(abs);
  } catch {
    // directory absent — nothing to scan
  }
}

if (hits.length) {
  console.error("Cart-state contract violation: QA source uses `cartLines`.");
  console.error("");
  for (const hit of hits) console.error(`- ${hit}`);
  console.error("");
  console.error("`getCartData().cartLines` is always [] (campaign-cart#36), so this");
  console.error("silently false-positives on an empty cart. Verify the committed cart via");
  console.error("the typed-card order read-back (receipt line items) or the `cart:updated`");
  console.error("payload (`items` / `summary.lines`); verify selection via DOM bundle");
  console.error("evidence (`[data-next-bundle-card]`). See docs/qa-and-test-orders.md.");
  console.error("Deliberate exception: append `" + allowToken + "` on the line.");
  process.exit(1);
}

console.log("Cart-state contract check passed (no QA reliance on cartLines)");
