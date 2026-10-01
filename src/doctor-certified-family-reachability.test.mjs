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
import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { SDK_MARKUP } from "./sdk-markup.mjs";
import { SCRIPT_SYNTAX, collectBuiltScriptSyntaxInputs } from "./built-script-syntax.mjs";
import { UPSELL_SELECTOR_SCOPE } from "./upsell-selector-scope.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FIXTURE_ROOT = join(ROOT, "fixtures", "certified-families");
const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, "manifest.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), "utf8"));

// Same rule src/doctor/checks.mjs applies (catalog family + brand contract), read from the
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
    const advisoryCodes = result.warnings.map((issue) => issue.code).filter((code) => code.startsWith(SDK_MARKUP) || code.startsWith(SCRIPT_SYNTAX));
    assert.deepEqual(advisoryCodes, [], `${family}: SDK markup or script syntax advisories fired on canonical output`);
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

  test(`${family}: script syntax parses every local script the pages load`, () => {
    // The fixture tree carries every local script the rendered pages load
    // (config.js and the family's js/*.js; #502). The expected set is read
    // from the raw HTML with a plain tag scan, independent of the gate's HTML
    // parser and script extractor, and compared by identity (path and parse
    // kind), so a script the gate stopped reading fails this test rather than
    // passing it by omission. The fixture markup is generated page-kit output:
    // double-quoted attributes, no scripts in comments, templates or noscript.
    const pages = Object.keys(manifest.files).filter((file) => file.startsWith(`_site/${family}/`) && file.endsWith(".html"));
    const expected = new Set();
    for (const rel of pages) {
      const html = readFileSync(join(FIXTURE_ROOT, rel), "utf8");
      for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = /\ssrc="([^"]*)"/i.exec(tag)?.[1];
        if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) continue;
        const path = new URL(src, `http://fixture.invalid/${rel.replace(/^_site\//, "")}`).pathname;
        expected.add(`${join("_site", decodeURIComponent(path))}\u0000${/\stype="module"/i.test(tag) ? "module" : "script"}`);
      }
    }
    assert.ok(expected.size >= 2, `${family}: expected config.js and at least one family script, got ${[...expected].join(", ")}`);
    for (const id of expected) {
      const file = id.split("\u0000")[0];
      assert.ok(existsSync(join(FIXTURE_ROOT, file)), `${family}: ${file} is referenced but not in the fixture tree; rerun scripts/refresh-certified-family-fixtures.mjs`);
    }
    const inputs = collectBuiltScriptSyntaxInputs({
      site_root: join(FIXTURE_ROOT, "_site"),
      campaign_dir: join(FIXTURE_ROOT, "_site", family),
      pages: pages.map((rel) => ({ page_id: rel, built_path: join(FIXTURE_ROOT, rel) })),
    }, FIXTURE_ROOT);
    assert.deepEqual(
      new Set(inputs.scripts.map((script) => `${script.file}\u0000${script.module ? "module" : "script"}`)),
      expected,
      `${family}: the gate does not read exactly the local scripts the pages load`,
    );
    assert.deepEqual(inputs.unresolved, []);
    const gate = gateOf(doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family }), SCRIPT_SYNTAX);
    assert.equal(gate.status, "pass", gate.reason);
    assert.deepEqual(gate.scripts_unresolved, [], `${family}: referenced local scripts were not scanned`);
    assert.deepEqual(gate.warned, []);
    assert.equal(gate.scripts_scanned, expected.size, `${family}: the gate parsed ${gate.scripts_scanned} of ${expected.size} referenced local scripts`);
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
