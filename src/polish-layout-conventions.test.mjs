// Layout conventions (campaigns-os#700): the layout.conventions check read
// from the readability record. Two design-independent conventions from the
// shared commerce brand contract's layout_conventions block, measured at the
// mobile viewport and reported as warnings an operator can accept:
// - floating_cta: a floating (position fixed or sticky) CTA container holds
//   its control alone, one link or button and no other visible text;
// - cta_label_size: the primary CTA label is at least 16px, read from the
//   readability elements Polish already records.
//
// Records are written by hand in the readability record shape, as in
// src/polish-readability.test.mjs; each element's derived fields are what
// the shared contrast helper derives from its raw fields. Rows are read
// through readCurrentQcResults with the registry's real rules and the real
// doctor run; accepts go through the real `next` and `checkpoint accept`.
// The probe that records a cell's layout runs in real Chromium in
// src/polish-layout-conventions.browser.test.mjs.
//
// Every value is synthetic: the shipped example packet and target
// (campaignFixture), stub pages under _site/<slug>/, no network.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  ROOT,
  SLUG,
  assertAccepted,
  assertNoNetworkAttempts,
  campaignFixture,
  doctorOf,
  handoffOf,
  mutateReport,
  readJson,
  runAccept,
  runCli,
  runNext,
  withRecomputedIntegrity,
} from "./qc-test-factories.mjs";
import { rgbString } from "./readability-harness.test.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const LAYOUT = "layout.conventions";
const READABILITY = "readability.contrast";
const NOT_CAPTURED = "not_captured_by_this_version";
const E = "evidence_not_reproducible";
const VIEWPORTS = Object.freeze(["desktop", "mobile"]);
const MOBILE = Object.freeze({ width: 390, height: 844 });
const routeOf = (name) => `/${SLUG}/${name}/`;

// The shared contract's block, without its prose: what a record stores.
const CONTRACT = JSON.parse(readFileSync(join(ROOT, "contracts", "template-brand-contract.shared-commerce.v0.json"), "utf8"));
const stripProse = (value) => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([field]) => field !== "rule").map(([field, entry]) => [field, stripProse(entry)]))
  : value);
const CONVENTIONS = stripProse(CONTRACT.layout_conventions);

// ---------------------------------------------------------------------------
// Fixture

function writePage(f, name) {
  const file = join(f.targetRepo, "_site", SLUG, name, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `<!doctype html><html><head><title>Synthetic</title></head><body><p>Synthetic ${name} page</p></body></html>\n`);
}

async function site(t, pages = ["landing"]) {
  const f = campaignFixture({ setupCompleted: true });
  t.after(f.cleanup);
  for (const name of pages) writePage(f, name);
  const res = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(res.exitCode, 0, `setup: record build records the built output (${res.error?.message || res.stdout.slice(0, 300)})`);
  return { f, build: readJson(f.reportPath).stages.assembly.build_fingerprint, routes: pages.map(routeOf).sort() };
}

// ---------------------------------------------------------------------------
// Records

const NO_CROP = Object.freeze({ crop_ref: null, crop_reason: "outside_viewport" });

// One element's raw fields: white on #222222 (passes contrast at any size).
function element({ px = 16, role = "body_text", path = "html>body>p:nth-of-type(1)" } = {}) {
  return { role, selector_path: path, state: "default", disabled: false, rendered: true, font_size_px: px, font_weight: 400, fg_raw: rgbString("#ffffff"), fill_raw: rgbString("#ffffff"), bg_layers_raw: [rgbString("#222222")], review_reason: null, ...NO_CROP };
}

let kit = null;
async function measured(raw) {
  if (!kit) kit = (await import("./contrast.mjs")).contrastToolkit();
  const derived = kit.deriveElementMeasurement({ fg_raw: raw.fg_raw, fill_raw: raw.fill_raw, bg_layers_raw: raw.bg_layers_raw, font_size_px: raw.font_size_px, font_weight: raw.font_weight });
  return { ...raw, size_class: derived.size_class, fg_srgb: derived.fg_srgb, bg_srgb: derived.bg_srgb, gamut_clipped: derived.gamut_clipped, ratio: derived.ratio, required: derived.required, review_reason: derived.review_reason };
}

const BAR = "html>body>div:nth-of-type(1)";
const BUTTON = `${BAR}>a:nth-of-type(1)`;
const LABEL = `${BUTTON}>span:nth-of-type(1)`;

// A floating CTA container as the probe records it.
function floating({ path = BAR, position = "fixed", height = 140, controls = [BUTTON], other = [] } = {}) {
  return {
    selector_path: path,
    position,
    rect: { x: 0, y: MOBILE.height - height, width: MOBILE.width, height },
    controls: controls.map((selector_path, index) => ({ selector_path, rect: { x: 16, y: MOBILE.height - height + 12 + 56 * index, width: 358, height: 48 } })),
    other_text: other,
    other_text_count: other.length,
  };
}

// A readability record over `routes` at both viewports. `elements(route,
// viewport)` gives each cell's raw elements; `layout(route, viewport)` its
// floating CTA containers (null: the cell records no layout). With
// `conventions` null the record predates the layout check.
async function record({ build, routes, elements = () => [element()], layout = () => [], conventions = CONVENTIONS }) {
  const cells = [];
  for (const route of routes) {
    for (const viewport of VIEWPORTS) {
      const containers = layout(route, viewport);
      cells.push({
        route,
        viewport,
        page_load_integrity: null,
        cell_status: "measured",
        capped: false,
        coverage_gaps: [],
        elements: await Promise.all(elements(route, viewport).map(measured)),
        ...(conventions && containers ? { layout: { viewport: viewport === "mobile" ? { ...MOBILE } : { width: 1440, height: 1200 }, floating_ctas: containers } } : {}),
      });
    }
  }
  return withRecomputedIntegrity({
    schema_version: "campaigns-os-polish-readability/v0",
    performed_by: "campaigns-os polish capture",
    helper_version: "contrast/v1",
    subject: { build_fingerprint: build, source_package_material_fingerprint: null, campaign_slug: SLUG, route_source: "built_site", routes: [...routes], viewports: [...VIEWPORTS] },
    thresholds: { normal: 4.5, large: 3, large_px: 24, large_bold_px: 18.66, large_bold_weight: 700 },
    limits: { elements_per_cell: 2000, crops_per_cell: 40, probe_ms_per_cell: 1500, probe_ms_per_run: 120000, crop_ms_per_run: 30000, added_ms_per_run: 300000, routes: 128, route_enumeration: 500 },
    ...(conventions ? { layout_conventions: structuredClone(conventions) } : {}),
    cells,
    uncaptured_routes: [],
    route_enumeration_capped: false,
    measured_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

function install(f, readability) {
  mutateReport(f, (report) => {
    const polish = report.stages.polish || { stage: "polish" };
    report.stages.polish = { ...polish, evidence: { ...(polish.evidence || {}), visual_review: { ...(polish.evidence?.visual_review || {}), readability } } };
  });
}

async function read(f) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers();
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const doctor = doctorOf(f.packetPath);
  assert.equal(doctor.derived?.build_output_fingerprint?.status, "pass", "setup: the built output is the one record build recorded");
  const { results, coverage } = readCurrentQcResults({ report: readJson(f.reportPath), doctor, spec: readJson(f.specPath), targetRepo: f.targetRepo, packetPath: f.packetPath, rederivers });
  return { results, coverage, layout: results.filter((row) => row.check === LAYOUT), readability: results.filter((row) => row.check === READABILITY) };
}

const project = (row) => [row.subject.page, row.subject.viewport, row.subject.key, row.result, row.reason_code];
const projected = (rows) => rows.map(project).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const keyed = (rows, key) => rows.find((row) => row.subject.key === key);

// The fixed bar of the CRO review: a paragraph above the button and a stock
// meter below it, beside the button's own label.
const CRO_BAR = floating({ other: [`${BAR}>p:nth-of-type(1)`, `${BAR}>div:nth-of-type(1)>span:nth-of-type(1)`] });

// ---------------------------------------------------------------------------
// Rows

test("a fixed CTA bar with a paragraph above the button and a stock meter below it: one floating_cta warning naming the bar and its other text, accept-eligible", async (t) => {
  const { f, build, routes } = await site(t);
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 18 })], layout: (route, viewport) => (viewport === "mobile" ? [CRO_BAR] : []) }));
  const { layout } = await read(f);
  assert.deepEqual(projected(layout), [
    [routeOf("landing"), "mobile", "cta_label_size", "pass", null],
    [routeOf("landing"), "mobile", "floating_cta", "warning", "floating_cta_extra_content"],
  ], "the mobile cell reads one floating_cta warning; the 18px label passes; desktop has no layout rows");
  const row = keyed(layout, "floating_cta");
  assert.deepEqual(row.members, [{ key: BAR, result: "warning", reason_code: "floating_cta_extra_content" }], "the member names the bar");
  assert.deepEqual(row.observation.containers[0].other_text, CRO_BAR.other_text, "the observation names the paragraph and the stock meter");
  assert.equal(row.observation.containers[0].controls[0].selector_path, BUTTON, "the observation names the control");
  assert.equal(row.accept_eligible, true, "the warning is accept-eligible");

  const open = (handoffOf(await runNext(f)).open || []).filter((entry) => entry.check === LAYOUT);
  assert.equal(open.length, 1, "next lists the warning in the QC handoff");
  assert.match(open[0].summary, new RegExp(`floating CTA should hold its control alone: ${BAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(fixed\\) holds 1 control; other text html>body>div:nth-of-type\\(1\\)>p`), `the handoff summary names the bar and its other text: ${open[0].summary}`);
});

test("a 14px mobile CTA label: one cta_label_size warning with the measured value, accept-eligible", async (t) => {
  const { f, build, routes } = await site(t);
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 14 }), element()] }));
  const { layout, readability } = await read(f);
  assert.deepEqual(projected(layout), [
    [routeOf("landing"), "mobile", "cta_label_size", "warning", "cta_label_too_small"],
    [routeOf("landing"), "mobile", "floating_cta", "pass", null],
  ], "the mobile cell reads one cta_label_size warning; with no floating bar floating_cta passes");
  const row = keyed(layout, "cta_label_size");
  assert.deepEqual(row.members, [{ key: LABEL, result: "warning", reason_code: "cta_label_too_small" }], "the member names the label");
  assert.equal(row.observation.smallest_px, 14, "the observation carries the measured size");
  assert.equal(row.observation.min_font_size_px, 16, "and the minimum");
  assert.equal(row.accept_eligible, true, "the warning is accept-eligible");
  assert.ok(readability.length > 0 && readability.every((entry) => entry.result === "pass"), "readability rows are unchanged");

  const open = (handoffOf(await runNext(f)).open || []).filter((entry) => entry.check === LAYOUT);
  assert.equal(open.length, 1, "next lists the warning in the QC handoff");
  assert.match(open[0].summary, /CTA label under 16px: .*span:nth-of-type\(1\) 14px \(add_to_cart\)/, `the handoff summary carries the measured value: ${open[0].summary}`);
});

test("a page meeting both conventions: its layout rows all pass and the handoff lists no layout warning", async (t) => {
  const { f, build, routes } = await site(t);
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 16 }), element({ px: 12 })], layout: (route, viewport) => (viewport === "mobile" ? [floating()] : [floating()]) }));
  const { layout, coverage } = await read(f);
  assert.deepEqual(projected(layout), [
    [routeOf("landing"), "mobile", "cta_label_size", "pass", null],
    [routeOf("landing"), "mobile", "floating_cta", "pass", null],
  ], "both conventions pass; 12px body text is not a CTA label");
  assert.equal(coverage.filter((entry) => entry.check === LAYOUT).length, 0, "the check is not listed as silent");
  const open = (handoffOf(await runNext(f)).open || []).filter((entry) => entry.check === LAYOUT);
  assert.deepEqual(open, [], "no layout warning is open");
});

test("both warnings accept through checkpoint accept, and next lists them accepted", async (t) => {
  const { f, build, routes } = await site(t);
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 14 })], layout: (route, viewport) => (viewport === "mobile" ? [CRO_BAR] : []) }));
  const open = (handoffOf(await runNext(f)).open || []).filter((entry) => entry.check === LAYOUT);
  assert.deepEqual(open.map((entry) => [entry.key, entry.accept_eligible]).sort(), [["cta_label_size", true], ["floating_cta", true]], "setup: both warnings are open and accept-eligible");
  const res = await runAccept(f, open.map((entry) => entry.result_ref));
  assertAccepted(res);
  const handoff = handoffOf(await runNext(f));
  assert.deepEqual((handoff.open || []).filter((entry) => entry.check === LAYOUT), [], "no layout warning is open after the accept");
  assert.equal((handoff.accepted || []).filter((entry) => String(entry.result_ref).startsWith(LAYOUT) || entry.check === LAYOUT).length, 2, `both are accepted: ${JSON.stringify(handoff.accepted)}`);
});

test("two controls in one floating bar, or a sticky bar: a warning; a box taller than half the viewport is not a floating CTA", async (t) => {
  const { f, build, routes } = await site(t, ["landing", "offer", "select"]);
  const bars = {
    [routeOf("landing")]: [floating({ controls: [BUTTON, `${BAR}>button:nth-of-type(1)`] })],
    [routeOf("offer")]: [floating({ position: "sticky", other: [`${BAR}>p:nth-of-type(1)`] })],
    [routeOf("select")]: [floating({ height: 500, other: [`${BAR}>p:nth-of-type(1)`] })],
  };
  install(f, await record({ build, routes, layout: (route, viewport) => (viewport === "mobile" ? bars[route] : []) }));
  const { layout } = await read(f);
  assert.deepEqual(projected(layout.filter((row) => row.subject.key === "floating_cta")), [
    [routeOf("landing"), "mobile", "floating_cta", "warning", "floating_cta_extra_content"],
    [routeOf("offer"), "mobile", "floating_cta", "warning", "floating_cta_extra_content"],
    [routeOf("select"), "mobile", "floating_cta", "pass", null],
  ], "two controls warn, a sticky bar with other text warns, a 500px box at 844px is not read");
});

test("a readability record from before the layout check: no layout rows, the check reads not captured, readability unchanged", async (t) => {
  const { f, build, routes } = await site(t);
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 14 })], conventions: null }));
  const { layout, readability, coverage } = await read(f);
  assert.deepEqual(layout, [], "no layout rows");
  assert.ok(readability.length > 0 && readability.every((row) => row.result === "pass"), "readability rows read as recorded");
  assert.deepEqual(coverage.filter((entry) => entry.check === LAYOUT).map((entry) => [entry.leg, entry.result, entry.reason_code]), [["polish", "unexercised", NOT_CAPTURED]], "the handoff lists the check as not captured by this version");
});

test("a record whose stored layout conventions differ from the contract's, or a measured cell with no layout: not reproducible", async (t) => {
  const { f, build, routes } = await site(t);
  const changed = structuredClone(CONVENTIONS);
  changed.cta_label.min_font_size_px = 12;
  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 14 })], conventions: changed }));
  let read1 = await read(f);
  assert.ok(read1.layout.length > 0 && read1.layout.every((row) => row.result === "unexercised" && row.reason_code === E), `every layout row is not reproducible: ${JSON.stringify(projected(read1.layout))}`);
  assert.ok(read1.readability.every((row) => row.result === "unexercised" && row.reason_code === E), "the record as a whole is not reproducible");

  install(f, await record({ build, routes, elements: () => [element({ role: "add_to_cart", path: LABEL, px: 14 })], layout: (route, viewport) => (viewport === "mobile" ? null : []) }));
  read1 = await read(f);
  assert.deepEqual(projected(read1.layout), [
    [routeOf("landing"), "mobile", "cell", "unexercised", E],
    [routeOf("landing"), "mobile", "cta_label_size", "unexercised", E],
    [routeOf("landing"), "mobile", "floating_cta", "unexercised", E],
  ], "the mobile cell's layout rows are not reproducible");
  assert.ok(read1.readability.length > 0 && read1.readability.every((row) => row.result === "pass"), "its readability rows still read");
});

// ---------------------------------------------------------------------------
// Producer: the cell and record builders keep the probe's layout

test("buildReadabilityCell keeps the probe's floating CTA rects; buildReadabilityRecord stores the conventions only when a cell recorded layout", async () => {
  const { buildReadabilityCell, buildReadabilityRecord, LAYOUT_CONVENTIONS } = await import("./polish-readability.mjs");
  const bar = { ...CRO_BAR, extra: "dropped", controls: CRO_BAR.controls.map((control) => ({ ...control, text: "dropped" })) };
  const observation = { status: "measured", capped: false, coverage_gaps: [], elements: [], viewport: { ...MOBILE }, layout: { viewport: { ...MOBILE }, floating_ctas: [bar] } };
  const cell = buildReadabilityCell({ route: routeOf("landing"), viewport: "mobile", status: "measured", observation });
  assert.deepEqual(cell.layout, { viewport: { ...MOBILE }, floating_ctas: [CRO_BAR] }, "the cell keeps the container and control rects and nothing else");
  const bare = buildReadabilityCell({ route: routeOf("landing"), viewport: "desktop", status: "measured", observation: { ...observation, layout: undefined } });
  assert.equal(Object.hasOwn(bare, "layout"), false, "an observation without layout records none");
  const args = { buildFingerprint: `sha256:${"a".repeat(64)}`, slug: SLUG, routes: [routeOf("landing")] };
  assert.deepEqual(buildReadabilityRecord({ ...args, cells: [cell, bare] }).layout_conventions, CONVENTIONS, "the record stores the contract's conventions");
  assert.deepEqual(LAYOUT_CONVENTIONS, CONVENTIONS, "the conventions are the shared contract's block without its prose");
  assert.equal(Object.hasOwn(buildReadabilityRecord({ ...args, cells: [bare] }), "layout_conventions"), false, "a record with no layout stores no conventions");
});
