// Reachability proof for the static built-output gates (#206 ON-2 closeout,
// failure mode #5): every gate that can block on built markup is shown to
// PASS on the real rendered output of every certified starter family. A gate
// that has never passed a real page has no business blocking one.
//
// The rendered families live in fixtures/certified-families/ (regenerated,
// never edited — see its README). This file is where a new built-output gate
// adds its line, in the same PR that adds the gate.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CAMPAIGN_IDENTITY } from "./campaign-identity.mjs";
import { doctorBuiltOutput } from "./cli.mjs";
import { SDK_MARKUP } from "./sdk-markup.mjs";
import { SCRIPT_SYNTAX } from "./built-script-syntax.mjs";
import { UPSELL_SELECTOR_SCOPE } from "./upsell-selector-scope.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FIXTURE_ROOT = join(ROOT, "fixtures", "certified-families");
const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, "manifest.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), "utf8"));

// Same rule cli.mjs applies (catalog family + brand contract), read from the
// files so this test cannot drift from the certified set by forgetting one.
const certified = Object.keys(catalog.families || {})
  .filter((family) => existsSync(join(ROOT, "contracts", `template-brand-contract.${family}.v0.json`)))
  .sort();

// The gates this file vouches for. Every id here must come back pass or
// not_applicable on every family; `blocked` on canonical output is the #5
// failure mode by definition.
const STATIC_BUILT_OUTPUT_GATES = [UPSELL_SELECTOR_SCOPE, CAMPAIGN_IDENTITY, SDK_MARKUP, SCRIPT_SYNTAX];

const gateOf = (result, id) => (result.derived?.checkpoint_gates || []).find((gate) => gate.id === id) || null;

test("the rendered fixture tree covers every certified family", () => {
  assert.ok(certified.length >= 8, `expected the certified set, got ${certified.join(", ")}`);
  assert.deepEqual(manifest.families, certified, "a newly certified family needs the fixture tree regenerated (scripts/refresh-certified-family-fixtures.mjs)");
  for (const family of certified) {
    assert.ok(existsSync(join(FIXTURE_ROOT, "_site", family, "checkout", "index.html")) || existsSync(join(FIXTURE_ROOT, "_site", family, "information", "index.html")), `${family} has no rendered checkout page`);
  }
});

test("the fixture tree was rendered from the catalog's pinned templates commit", (t) => {
  // Diagnostic rather than a failure: the catalog refresh workflow cannot
  // render (no page-kit in CI), so a hard assertion would turn every catalog
  // sync red until a human regenerates locally. Stale canonical output is
  // still real output; the proof stands, and the diagnostic says to refresh.
  if (manifest.source_sha !== catalog._synced_from_sha) {
    t.diagnostic(`fixtures/certified-families is rendered from ${manifest.source_sha.slice(0, 7)} but the catalog is synced from ${String(catalog._synced_from_sha).slice(0, 7)}; run scripts/refresh-certified-family-fixtures.mjs`);
  }
  assert.match(manifest.source_sha, /^[0-9a-f]{40}$/);
});

for (const family of certified) {
  test(`${family}: every static built-output gate passes on the canonical render`, () => {
    const result = doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family, family });
    for (const id of STATIC_BUILT_OUTPUT_GATES) {
      const gate = gateOf(result, id);
      assert.ok(gate, `${family}: ${id} did not run`);
      assert.ok(
        gate.status === "pass" || gate.status === "not_applicable",
        `${family}: ${id} is ${gate.status} on canonical output — ${gate.reason}`,
      );
      assert.ok(result.derived.doctor_checks.includes(id), `${family}: ${id} missing from doctor_checks`);
    }
    const blockingCodes = result.errors.map((issue) => issue.code).filter((code) => STATIC_BUILT_OUTPUT_GATES.some((id) => code.startsWith(id)));
    assert.deepEqual(blockingCodes, [], `${family}: static gates raised errors on canonical output`);
    // The advisory codes hold to the same bar: a warning that fires on every
    // canonical page is noise, not a signal.
    const advisoryCodes = result.warnings.map((issue) => issue.code).filter((code) => code.startsWith(SDK_MARKUP));
    assert.deepEqual(advisoryCodes, [], `${family}: SDK markup advisories fired on canonical output`);
  });

  test(`${family}: SDK markup scans every page and its only advisory is the templates' own data-next-* hooks`, () => {
    const gate = gateOf(doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family }), SDK_MARKUP);
    assert.equal(gate.status, "pass");
    assert.equal(gate.code, `${SDK_MARKUP}.pass`);
    assert.ok(gate.pages_scanned >= 7, `${family}: only ${gate.pages_scanned} page(s) scanned`);
    // Not asserted empty on purpose: the templates carry hooks of their own
    // (data-next-catalog-component and friends) that the SDK never reads.
    // They are information on the gate; a change here is a templates change.
    assert.ok(Array.isArray(gate.unknown_attributes));
  });

  test(`${family}: script syntax parses the shared config.js the pages load`, () => {
    // The fixture tree carries HTML and config.js only; the family's js/*.js
    // files are listed as unresolved, not judged. config.js is the proof the
    // gate reads a real local script and passes it.
    const gate = gateOf(doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family }), SCRIPT_SYNTAX);
    assert.equal(gate.status, "pass", gate.reason);
    assert.ok(gate.scripts_scanned >= 1, `${family}: no local script parsed`);
  });

  test(`${family}: campaign identity resolves the key from the shared config.js and one funnel`, () => {
    const gate = gateOf(doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family }), CAMPAIGN_IDENTITY);
    assert.equal(gate.status, "pass");
    assert.ok(gate.pages_scanned >= 7, `${family}: only ${gate.pages_scanned} page(s) scanned`);
    assert.deepEqual(gate.pages_skipped, []);
    assert.ok(gate.identity.funnel, `${family}: no next-funnel resolved`);
    assert.ok(gate.identity.api_key, `${family}: no API key resolved — the shared config.js was not followed`);
    assert.match(gate.identity.api_key_source, /config\.js nextConfig\.apiKey$/);
  });
}
