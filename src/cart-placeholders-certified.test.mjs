// F1.5-C1: the raw cart placeholder gate (built_output.cart_placeholders) on
// the rendered certified families (fixtures/certified-families, regenerated,
// never edited). It is the 1.5 reachability assertion the fixtures README asks
// for; it lives here rather than in src/doctor-certified-family-reachability
// .test.mjs because that file imports the doctor statically, before any
// no-network guard could be installed.
//
// The gate is a QC gate, not a checkpoint gate, so it is proved on its
// derived.qc_results rows: exactly one page-level `pass` row per certified page
// (loader pin 0.4.40), and no live_token, unknown_brace or other result
// anywhere. The expected page set is read from the fixture manifest, not from
// the gate.
//
// API assumption: a page-level row has subject exactly {check, page, key:"page"}
// with subject.page the page path relative to the doctor target, and
// members [] (src/cart-placeholders.test.mjs).
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

const CHECK = "cart_placeholders";
const GATE = "built_output.cart_placeholders";
const FIXTURE_ROOT = join(ROOT, "fixtures", "certified-families");
const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, "manifest.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "contracts", "commerce-surface-catalog.json"), "utf8"));

// The certified set, by the rule src/doctor-certified-family-reachability.test.mjs
// reads from the same files (catalog family + brand contract).
const certified = Object.keys(catalog.families || {})
  .filter((family) => existsSync(join(ROOT, "contracts", `template-brand-contract.${family}.v0.json`)))
  .sort();

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members });
const pagePass = (page) => ({ id: `${CHECK}:${page}:page`, check: CHECK, subject: { check: CHECK, page, key: "page" }, result: "pass", reason_code: null, members: [] });

test("F1.5-C1 certified families under doctor --built (loader pin 0.4.40): built_output.cart_placeholders passes on all 81 pages (zero live_token, zero unknown_brace)", async () => {
  assert.deepEqual(manifest.families, certified, "setup: the fixture tree covers the certified set");
  const passed = [];
  for (const family of certified) {
    const result = await withNoNetwork(() => doctorBuiltOutput({ built: FIXTURE_ROOT, slug: family, family }));
    assert.ok(result.derived.doctor_checks.includes(GATE), `${family}: ${GATE} missing from doctor_checks`);
    const rows = (result.derived.qc_results || []).filter((row) => row.check === CHECK);
    const pages = Object.keys(manifest.files).filter((file) => file.startsWith(`_site/${family}/`) && file.endsWith(".html")).sort();
    assert.deepEqual(rows.map(summarize).sort(byId), pages.map(pagePass).sort(byId), `${family}: ${GATE} is one pass row per canonical page, complete rows`);
    const issues = [...result.errors, ...result.warnings].filter((issue) => String(issue.code).startsWith(GATE));
    assert.deepEqual(issues, [], `${family}: ${GATE} raised issues on canonical output`);
    passed.push(...pages);
  }
  assert.equal(passed.length, 81, "every certified page passes");
});
