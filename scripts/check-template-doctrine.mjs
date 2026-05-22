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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const skillPath = resolve(root, "skills/next-campaigns-build/SKILL.md");
const templatesRoot = resolve(
  process.env.STARTER_TEMPLATES_PATH || resolve(root, "../campaign-cart-starter-templates"),
);

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

// 4. Report.
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
    `${partials.length} partials scanned).`,
);

for (const [varName, doctrineValue] of doctrine) {
  if (!coverage.has(varName)) {
    console.warn(
      `  note: no partial declares a Liquid default for ${varName}=${doctrineValue}. ` +
        `Doctrine applies only to agent overrides today; partials may hardcode rendering.`,
    );
  }
}
