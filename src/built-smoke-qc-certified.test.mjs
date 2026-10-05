// F1.6-C1: the built-output smoke checks (built_output.smoke_qc) on the
// rendered certified families (fixtures/certified-families, regenerated, never
// edited). It is the 1.6 reachability assertion the fixtures README asks for;
// it lives here rather than in src/doctor-certified-family-reachability
// .test.mjs because that file imports the doctor statically, before any
// no-network guard could be installed. The gate itself joins
// STATIC_BUILT_OUTPUT_GATES there.
//
// No smoke `warning` (and no
// `review`) on any certified page. Under `doctor --built` every rule reads
// `pass`, except the three the contract leaves unexercised there:
//   - og:image resolution: og_image_base_unknown. The refresh script sets
//     og:image to the absolute https URL FIXTURE_OG_IMAGE (addendum), and in
//     --built mode the deploy base is unknown, so an absolute og:image cannot
//     be mapped (contract 1.6 absolute_same_base_unmapped; F1.6-I8). It is
//     never og_image_remote_not_fetched there: "another host" needs a known
//     base (F1.6-I2 is a packet row);
//   - Tailwind CDN and loopback: build_environment_unknown, on every page.
// The expected page set is read from the fixture manifest and the expected
// anchor targets from the raw HTML with a plain tag scan, never from the gate.
//
// API assumption: the result keys of src/built-smoke-qc.test.mjs (one row per
// page for favicon:link, og:title, og:description, og:image, og:image_target,
// tailwind_cdn:cdn.tailwindcss.com, asset_host:cdn.29next.store and
// loopback:loopback; one anchor:<decoded target> row per distinct in-page
// target of an <a> or <area>), subject.page relative to the doctor target,
// members [], coverage {observed:1, expected:1, limits:[]} when measured and
// {observed:0, expected:1, limits:[<reason>]} when unexercised.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import { ROOT, assertNoNetworkAttempts, withNoNetwork } from "./qc-test-factories.mjs";

// No network: importing qc-test-factories.mjs (the only non-builtin static
// import) installs the guard before any module under test loads, so the doctor,
// imported dynamically below, captures only the guarded fetch and http/https.
// Any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");

const CHECK = "smoke_qc";
const GATE = "built_output.smoke_qc";
const FIXTURE_ROOT = join(ROOT, "fixtures", "certified-families");
const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, "manifest.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), "utf8"));

// The certified set, by the rule src/doctor-certified-family-reachability.test.mjs
// reads from the same files (catalog family + brand contract).
const certified = Object.keys(catalog.families || {})
  .filter((family) => existsSync(join(ROOT, "contracts", `template-brand-contract.${family}.v0.json`)))
  .sort();

// The og:image the refresh script renders into every certified page
// (scripts/refresh-certified-family-fixtures.mjs).
const FIXTURE_OG_IMAGE = "https://example.com/og-image.png";

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members, coverage: row.coverage });
const coverageOf = (result, reasonCode) => (result === "unexercised" ? { observed: 0, expected: 1, limits: [reasonCode] } : { observed: 1, expected: 1, limits: [] });
const expectRow = (page, key, result, reasonCode = null) => ({ id: `${CHECK}:${page}:${key}`, check: CHECK, subject: { check: CHECK, page, key }, result, reason_code: reasonCode, members: [], coverage: coverageOf(result, reasonCode) });

// The distinct decoded in-page targets of the page's <a href="#..."> and
// <area href="#..."> tags. The fixture markup is generated page-kit output:
// double-quoted attributes, no anchors inside <template> (asserted).
function anchorTargets(html) {
  for (const [template] of html.matchAll(/<template\b[\s\S]*?<\/template>/gi)) {
    assert.equal(/<(?:a|area)\b[^>]*\shref="#/i.test(template), false, "setup: no in-page anchor inside <template> on certified output");
  }
  const targets = new Set();
  for (const [, fragment] of html.matchAll(/<(?:a|area)\b[^>]*\shref="#([^"]*)"/gi)) targets.add(decodeURIComponent(fragment));
  return [...targets];
}

// A certified page's rows: `pass` everywhere, the three --built exceptions
// above, one anchor row per target.
function certifiedPageRows(page, html) {
  return [
    expectRow(page, "favicon:link", "pass"),
    expectRow(page, "og:title", "pass"),
    expectRow(page, "og:description", "pass"),
    expectRow(page, "og:image", "pass"),
    expectRow(page, "og:image_target", "unexercised", "og_image_base_unknown"),
    expectRow(page, "tailwind_cdn:cdn.tailwindcss.com", "unexercised", "build_environment_unknown"),
    expectRow(page, "asset_host:cdn.29next.store", "pass"),
    expectRow(page, "loopback:loopback", "unexercised", "build_environment_unknown"),
    ...anchorTargets(html).map((target) => expectRow(page, `anchor:${target}`, "pass")),
  ];
}

test("F1.6-C1 certified families under doctor --built: no 1.6 warning or review on any of the 81 pages; Tailwind and loopback unexercised on all 81 (build_environment_unknown)", async () => {
  assert.deepEqual(manifest.families, certified, "setup: the fixture tree covers the certified set");
  const checked = [];
  for (const family of certified) {
    const result = await withNoNetwork(() => doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family, family }));
    assert.ok(result.derived.doctor_checks.includes(GATE), `${family}: ${GATE} missing from doctor_checks`);
    const rows = (result.derived.qc_results || []).filter((row) => row.check === CHECK);
    const pages = Object.keys(manifest.files).filter((file) => file.startsWith(`_site/${family}/`) && file.endsWith(".html")).sort();
    // Setup: the tree was regenerated with the addendum's og:image input.
    assert.ok((manifest.render_inputs || []).some((input) => String(input).includes(FIXTURE_OG_IMAGE)), `setup: manifest.json render_inputs records og:image ${FIXTURE_OG_IMAGE}`);
    const expected = pages.flatMap((page) => certifiedPageRows(page, readFileSync(join(FIXTURE_ROOT, page), "utf8")));
    assert.deepEqual(rows.map(summarize).sort(byId), expected.sort(byId), `${family}: ${GATE} rows on canonical output, complete rows`);
    const issues = [...result.errors, ...result.warnings].filter((issue) => String(issue.code).startsWith(GATE));
    assert.deepEqual(issues, [], `${family}: ${GATE} raised issues on canonical output`);
    checked.push(...pages);
  }
  assert.equal(checked.length, 81, "every certified page is checked");
});
