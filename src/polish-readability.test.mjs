// F2.4 frozen fixture rows for the readability record's rules, reader,
// dispatch, accepts and capture (contract 2.4 Record, Result rules, Accepts;
// Code plan "Tests": rules, reader, grid validation, fixed producer values,
// recomputed routes, crop check, dispatch, output drift, accept provenance,
// ingest refusal). N rows read through readCurrentQcResults with the
// registry's real rules and the real doctor run; C rows drive the CLI
// in-process (record build, next, checkpoint accept, record polish, and
// polish capture with a stub browser adapter).
//
// Every value is synthetic: the shipped example packet and target
// (campaignFixture), stub pages under _site/<slug>/, the synthetic operator
// "Jordan Lee", no network (the factories' guard is installed by the first
// import, before any module under test loads).
//
// Records are written by hand in the contract's record shape (contract 2.4
// Record, :1268-1290). Each element's raw fields (computed colour strings,
// font size and weight) are chosen here; its derived fields (fg_srgb,
// bg_srgb, gamut_clipped, ratio, size_class, required, review_reason) are
// what the shared helper's deriveElementMeasurement returns for them, since
// the reader re-derives every stored element through that helper and must
// find them equal. They are setup inputs, never a row's expected value; a
// row whose record holds an element therefore needs src/contrast.mjs. The
// accept rows whose setup rebuilds and recaptures run against real Chromium
// in src/polish-readability.browser.test.mjs.
//
// API assumptions (every row; the contract fixes the record fields and the
// row keys, not these forms):
// - fg_srgb / bg_srgb are [r, g, b] gamma-encoded sRGB in [0, 1] and
//   bg_layers_raw lists the computed background colours from the element
//   outwards, ending at the opaque layer;
// - pair keys are `pair:<fg8>/<bg8>:<size_class>`, fg8/bg8 the 8-digit
//   rrggbbaa hex, compared in lower case; the other keys as the contract's
//   result table spells them (`cell`, `scope`, `review:<role>:<reason>`,
//   `role:<role>:coverage`);
// - an element with crop_ref null and crop_reason "outside_viewport" has no
//   crop due, so it adds no crop member;
// - integrity is "sha256:" + sha256(canonical JSON of the record minus
//   integrity), the mediaWeightIntegrity pattern (contract :1305).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  OPERATOR,
  OTHER_BUILD_FP,
  ROOT,
  ROUTES,
  SLUG,
  assertAccepted,
  assertIngestRefused,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  doctorOf,
  handoffOf,
  installPolishEvidence,
  mutateReport,
  readJson,
  runAccept,
  runCli,
  runNext,
  sha256,
  snapshot,
  twoCellFixture,
  withRecomputedIntegrity,
  writeJson,
} from "./qc-test-factories.mjs";
import { rgbString } from "./readability-harness.test.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const CHECK = "readability.contrast";
const E = "evidence_not_reproducible";
const STALE = "stale_binding";
const VIEWPORTS = Object.freeze(["desktop", "mobile"]);
const routeOf = (name) => (name === "" ? `/${SLUG}/` : `/${SLUG}/${name}/`);
const pairKey = (fg, bg, sizeClass) => `pair:${fg.slice(1).toLowerCase()}ff/${bg.slice(1).toLowerCase()}ff:${sizeClass}`;
const lower = (key) => (String(key).startsWith("pair:") ? String(key).toLowerCase() : key);

// ---------------------------------------------------------------------------
// Fixture: a campaign whose built output is `pages` (+ the slug root page
// when `root`), recorded by `record build`.

function writePage(f, name, body) {
  const file = name === "" ? join(f.targetRepo, "_site", SLUG, "index.html") : join(f.targetRepo, "_site", SLUG, name, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `<!doctype html><html><head><title>Synthetic</title><style>:root{--cta:#0080aa}</style></head><body><p>${body}</p></body></html>\n`);
}

async function recordBuild(f) {
  const res = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(res.exitCode, 0, `setup: record build records the built output (${res.error?.message || res.stdout.slice(0, 300)})`);
  return readJson(f.reportPath).stages.assembly.build_fingerprint;
}

async function site(t, { pages = ["landing"], root = false } = {}) {
  const f = campaignFixture({ setupCompleted: true });
  t.after(f.cleanup);
  if (root) writePage(f, "", "Synthetic root page");
  for (const name of pages) writePage(f, name, `Synthetic ${name} page`);
  const build = await recordBuild(f);
  assert.match(String(build), /^sha256:[a-f0-9]{64}$/, "setup: record build stamped the build fingerprint");
  assert.equal(readJson(f.reportPath).design_source_package, undefined, "setup: no Design Source Package, so the source binding is null");
  const routes = [...(root ? [routeOf("")] : []), ...pages.map(routeOf)].sort();
  return { f, build, routes };
}

// ---------------------------------------------------------------------------
// Records (contract 2.4 Record)

const THRESHOLDS = Object.freeze({ normal: 4.5, large: 3, large_px: 24, large_bold_px: 18.66, large_bold_weight: 700 });
const LIMITS = Object.freeze({ elements_per_cell: 2000, crops_per_cell: 40, probe_ms_per_cell: 1500, probe_ms_per_run: 120000, crop_ms_per_run: 30000, added_ms_per_run: 300000, routes: 128, route_enumeration: 500 });
const NO_CROP = Object.freeze({ crop_ref: null, crop_reason: "outside_viewport" });

// One measured element's raw fields, opaque 8-bit colours. Its derived
// fields are added by readabilityRecord.
function element({ fg = "#ffffff", bg = "#767676", px = 16, weight = 400, role = "body_text", path = "html>body>p:nth-of-type(1)", state = "default", review = null, crop = NO_CROP } = {}) {
  return {
    role,
    selector_path: path,
    state,
    disabled: false,
    rendered: true,
    font_size_px: px,
    font_weight: weight,
    fg_raw: rgbString(fg),
    fill_raw: rgbString(fg),
    bg_layers_raw: [rgbString(bg)],
    review_reason: review,
    ...crop,
  };
}

// The shared helper, loaded on first use (a missing module fails only the
// rows whose record holds an element).
let toolkit = null;
async function contrastKit() {
  if (!toolkit) {
    const { contrastToolkit } = await import("./contrast.mjs");
    toolkit = contrastToolkit();
  }
  return toolkit;
}

// The element with the fields the helper derives from its raw fields. A
// review trigger given by the row (a probe observation the raw fields do
// not carry) is kept; otherwise review_reason is the helper's.
function measured(kit, raw) {
  const derived = kit.deriveElementMeasurement({ fg_raw: raw.fg_raw, fill_raw: raw.fill_raw, bg_layers_raw: raw.bg_layers_raw, font_size_px: raw.font_size_px, font_weight: raw.font_weight });
  return {
    ...raw,
    size_class: derived.size_class,
    fg_srgb: derived.fg_srgb,
    bg_srgb: derived.bg_srgb,
    gamut_clipped: derived.gamut_clipped,
    ratio: derived.ratio,
    required: derived.required,
    review_reason: raw.review_reason ?? derived.review_reason,
  };
}

async function readabilityRecord({ build, routes, elements = () => [element()], cell = () => ({}), sourceFp = null, measuredAt = new Date(Date.now() - 60_000).toISOString(), uncaptured = [], capped = false }) {
  const raw = routes.flatMap((route) => VIEWPORTS.map((viewport) => ({ route, viewport, elements: elements(route, viewport), extra: cell(route, viewport) })));
  const kit = raw.some((entry) => entry.elements.length > 0) ? await contrastKit() : null;
  return withRecomputedIntegrity({
    schema_version: "campaigns-os-polish-readability/v0",
    performed_by: "campaigns-os polish capture",
    helper_version: "contrast/v1",
    subject: { build_fingerprint: build, source_package_material_fingerprint: sourceFp, campaign_slug: SLUG, route_source: "built_site", routes: [...routes], viewports: [...VIEWPORTS] },
    thresholds: { ...THRESHOLDS },
    limits: { ...LIMITS },
    cells: raw.map(({ route, viewport, elements: own, extra }) => ({
      route,
      viewport,
      page_load_integrity: null,
      cell_status: "measured",
      capped: false,
      coverage_gaps: [],
      elements: own.map((entry) => measured(kit, entry)),
      ...extra,
    })),
    uncaptured_routes: [...uncaptured],
    route_enumeration_capped: capped,
    measured_at: measuredAt,
  });
}

function installReadability(f, record) {
  mutateReport(f, (report) => {
    const polish = report.stages.polish || { stage: "polish" };
    report.stages.polish = {
      ...polish,
      evidence: { ...(polish.evidence || {}), visual_review: { ...(polish.evidence?.visual_review || {}), readability: record } },
    };
  });
}

// Every current QC result as `next` and `checkpoint accept` read them:
// readCurrentQcResults with the registry's real rules and the real doctor.
async function read(f) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const rederivers = await loadQcRederivers();
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const doctor = doctorOf(f.packetPath);
  const { results, coverage } = readCurrentQcResults({ report: readJson(f.reportPath), doctor, spec: readJson(f.specPath), targetRepo: f.targetRepo, packetPath: f.packetPath, rederivers });
  return { doctor, results, coverage, rows: results.filter((row) => row?.check === CHECK) };
}

const outputStatus = (doctor) => doctor?.derived?.build_output_fingerprint?.status;
const project = (row) => ({ page: row.subject?.page ?? null, viewport: row.subject?.viewport ?? null, key: lower(row.subject?.key), result: row.result, reason_code: row.reason_code });
const byText = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const projected = (rows) => rows.map(project).sort(byText);
// The pass rows of a record whose every cell holds the one default element.
const passRows = (routes, key = pairKey("#ffffff", "#767676", "normal")) => routes.flatMap((page) => VIEWPORTS.map((viewport) => ({ page, viewport, key, result: "pass", reason_code: null }))).sort(byText);

// Setup (not the row's assertion): the reader lists the record's rows and
// none of them is unexercised, so a later "every row reads X" cannot hold
// vacuously or because the untouched record was already unreadable.
async function assertReadsAsRecorded(f, routes, label = "the untouched record") {
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", `setup (${label}): doctor's output fingerprint is pass`);
  assert.ok(rows.length > 0, `setup (${label}): readCurrentQcResults lists readability.contrast rows`);
  assert.deepEqual(projected(rows), passRows(routes), `setup (${label}): the record reads as recorded`);
}

// Every row of the record reads result / reason, and there is at least one.
function assertEveryRow(rows, result, reasonCode, label) {
  assert.ok(rows.length > 0, `setup (not the row's assertion): ${label} lists readability.contrast rows`);
  assert.deepEqual([...new Set(rows.map((row) => JSON.stringify([row.result, row.reason_code])))], [JSON.stringify([result, reasonCode])], `${label}: every readability.contrast row reads ${result} / ${reasonCode}`);
}

// A reader-check row: the untouched record reads as recorded, the tampered
// one reads every row unexercised / evidence_not_reproducible.
async function assertTamperedRecord(t, tamper) {
  const { f, build, routes } = await site(t);
  const record = await readabilityRecord({ build, routes });
  installReadability(f, record);
  await assertReadsAsRecorded(f, routes);
  installReadability(f, tamper(structuredClone(record), { build, routes }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is still pass");
  assertEveryRow(rows, "unexercised", E, "the tampered record");
}

// ---------------------------------------------------------------------------
// Accept helpers (Increment 1 substrate)

const readabilityOpen = (handoff) => (handoff.open || []).filter((entry) => entry.check === CHECK);
const refsOf = (group) => (group.results || [group]).map((entry) => entry.result_ref);

async function acceptRefs(f, refs) {
  const res = await runAccept(f, refs);
  assertAccepted(res);
  const accepts = readJson(f.reportPath).qc_accepts || [];
  assert.equal(accepts.length, refs.length, `setup: checkpoint accept wrote one record per ref (${refs.length})`);
  return accepts;
}

async function assess(f) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { results } = await read(f);
  const accepts = readJson(f.reportPath).qc_accepts || [];
  assert.ok(accepts.length > 0, "setup (not the row's assertion): the report holds the accept records");
  return { accepts, assessed: assessQcAccepts(accepts, results), results };
}

// ---------------------------------------------------------------------------
// Producer rows: `polish capture` with a stub browser adapter (the
// src/polish-cli.test.mjs createBrowserAdapter pattern). The mapped landing
// page keeps page_load capturing (so BASE_SHA's capture completes); the
// other pages are template stock and get readability-only cells.
//
// API assumptions (F2.4-I11, I25, I48, I51):
// - readability-only cells call the adapter's probeReadabilityRoute(route,
//   viewport) (contract :1451); a call that rejects with a navigation error
//   records navigation_failed;
// - `probeClock` ({now(), sleep(ms)}, the src/polish-media-weight.mjs:66
//   isProbeClock shape) is passed to polishCaptureCommand in process beside
//   the existing deadline options, and is the clock the readability
//   per-cell probe bound and run budget are measured on.

function mainDocumentResponse(url, viewport) {
  return { request_id: `document-${viewport?.key}`, url, resource_type: "Document", status: 200, mime_type: "text/html", encoded_data_length: 2_048, is_final_main_document: true, document_context_fingerprint: `sha256:${"d".repeat(64)}` };
}

function stubAdapter({ captureRoute, probe }) {
  return async () => ({
    captureRoute: captureRoute || (async ({ url, viewport }) => ({ finalDocumentUrl: url, responseCollectionStatus: "complete", networkidle: { status: "settled", duration_ms: 25 }, mediaElements: [], responses: [mainDocumentResponse(url, viewport)] })),
    probeReadabilityRoute: probe,
    async close() {},
  });
}

// A virtual clock: now() is virtual milliseconds; sleep(ms) settles when the
// virtual time reaches its deadline (advance moves it).
function virtualClock() {
  let now = 0;
  const sleepers = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise((done) => sleepers.push({ at: now + ms, done })),
    advance(ms) {
      now += ms;
      for (const sleeper of sleepers.filter((entry) => entry.at <= now)) {
        sleepers.splice(sleepers.indexOf(sleeper), 1);
        sleeper.done();
      }
    },
  };
}

async function stockSite(t, stock) {
  const fixture = await site(t, { pages: ["landing", ...stock] });
  const packet = readJson(fixture.f.packetPath);
  for (const page of packet.source_html.pages) if (page.page_id !== "landing") page.skip_reason = "Synthetic template stock page with no source mapping.";
  writeJson(fixture.f.packetPath, packet);
  mutateReport(fixture.f, (report) => {
    report.inputs = { ...(report.inputs || {}), packet_path: relative(fixture.f.targetRepo, fixture.f.packetPath) };
  });
  return fixture;
}

async function stubCapture(f, adapter, options = {}) {
  const { polishCaptureCommand } = await import("./cli.mjs");
  let result = null;
  let error = null;
  try {
    result = await polishCaptureCommand({ _: ["polish", "capture"], packet: f.packetPath, "base-url": "http://127.0.0.1:9/" }, { createBrowserAdapter: adapter, ...options });
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error, null, `setup: polish capture returned (${error?.message})`);
  assert.equal(readJson(f.reportPath).stages.polish?.evidence?.visual_review?.page_load?.performed_by, "campaigns-os polish capture", "setup: page_load is attached for the mapped page");
  return result;
}

// The `cell` rows of the given pages, both viewports.
const cellRows = (rows, routes) => projected(rows.filter((row) => routes.includes(row.subject?.page) && row.subject?.key === "cell"));
const cellsReading = (routes, reasonCode) => routes.flatMap((page) => VIEWPORTS.map((viewport) => ({ page, viewport, key: "cell", result: "unexercised", reason_code: reasonCode }))).sort(byText);

// ---------------------------------------------------------------------------
// Working rows

test("F2.4-W2 16px/400 #ffffff on #767676: pass", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#767676", px: 16, weight: 400 })] }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is pass");
  assert.deepEqual(projected(rows), passRows(routes, pairKey("#ffffff", "#767676", "normal")), "the pair row reads pass at both widths");
});

test("F2.4-W10 the same warning pair on 2 pages x 2 widths; one checkpoint accept with the 4 handoff refs: qc_handoff.accepted length = 4", async (t) => {
  const { f, build, routes } = await site(t, { pages: ["landing", "offer"] });
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa" })] }));
  const groups = readabilityOpen(handoffOf(await runNext(f)));
  assert.deepEqual(groups.map((group) => lower(group.key)), [pairKey("#ffffff", "#0080aa", "normal")], "setup: one handoff entry for the pair");
  const refs = refsOf(groups[0]);
  assert.equal(refs.length, 4, "setup: the entry lists the 4 page/width refs");
  await acceptRefs(f, refs);
  const handoff = handoffOf(await runNext(f));
  assert.equal(handoff.accepted.length, 4, `qc_handoff.accepted length = 4: ${JSON.stringify(handoff.accepted.map((entry) => entry.result_ref))}`);
});

test("F2.4-W11 accepted pair; edit the shared CSS variable; rebuild and record build; no recapture: every accept reads lapsed / stale_binding", async (t) => {
  const { f, build, routes } = await site(t, { pages: ["landing", "offer"] });
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa" })] }));
  const groups = readabilityOpen(handoffOf(await runNext(f)));
  assert.equal(groups.length, 1, "setup: the pair is open");
  const accepts = await acceptRefs(f, refsOf(groups[0]));
  for (const name of ["landing", "offer"]) {
    const file = join(f.targetRepo, "_site", SLUG, name, "index.html");
    writeFileSync(file, `<!doctype html><html><head><title>Synthetic</title><style>:root{--cta:#006b8f}</style></head><body><p>Synthetic ${name} page</p></body></html>\n`);
  }
  const rebuilt = await recordBuild(f);
  assert.notEqual(rebuilt, build, "setup: the rebuild recorded a new build fingerprint");
  const handoff = handoffOf(await runNext(f));
  assert.deepEqual(
    (handoff.lapsed || []).map((entry) => [entry.result_id, entry.why]).sort(),
    accepts.map((record) => [record.result_id, STALE]).sort(),
    "every accept reads lapsed / stale_binding",
  );
});

test("F2.4-W12 existing Increment 1 media.weight accept record: assessment = active", async (t) => {
  const { f, build } = await site(t, { pages: ["checkout"], root: true });
  installPolishEvidence(f, twoCellFixture([{ path: `/${SLUG}/img/hero.jpg`, bytes: 600_000 }], { buildFingerprint: build }));
  const open = (handoffOf(await runNext(f)).open || []).filter((entry) => entry.check === "media.weight");
  const refs = open.flatMap(refsOf);
  assert.equal(refs.length, 2, "setup: the two media.weight warnings are open");
  await acceptRefs(f, refs);
  const { assessed } = await assess(f);
  assert.deepEqual(assessed.map((entry) => entry.status), ["active", "active"], "assessment = active");
});

// ---------------------------------------------------------------------------
// Broken rows

test("F2.4-B10 record captured, then a new _site page added (doctor's output fingerprint no longer pass): every row of the record is unexercised / stale_binding, and there is no row for the new route", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build, routes }));
  await assertReadsAsRecorded(f, routes);
  writePage(f, "added", "Synthetic added page");
  const { doctor, rows } = await read(f);
  assert.notEqual(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is no longer pass");
  assertEveryRow(rows, "unexercised", STALE, "the record");
  assert.deepEqual([...new Set(rows.map((row) => row.subject?.page))].sort(), routes, "rows are the record's pages only; none for the new route");
});

test("F2.4-B12 cell with an accepted pair plus a gradient review row; accept command naming the review ref: refusal target_not_warning", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({
    build,
    routes,
    elements: () => [
      element({ fg: "#ffffff", bg: "#0080aa" }),
      element({ fg: "#ffffff", bg: "#111111", role: "add_to_cart", path: "html>body>button[data-next-action=\"add-to-cart\"]:nth-of-type(1)", review: "background_gradient" }),
    ],
  }));
  const handoff = handoffOf(await runNext(f));
  const pair = readabilityOpen(handoff);
  assert.equal(pair.length, 1, "setup: the pair is open");
  await acceptRefs(f, refsOf(pair[0]));
  const review = (handoff.review || []).filter((entry) => entry.check === CHECK && entry.key === "review:add_to_cart:background_gradient");
  assert.equal(review.length, 2, "setup: the gradient review row is listed at both widths");
  const before = snapshot(f);
  const res = await runAccept(f, [review[0].result_ref]);
  assertRefused(res, "target_not_warning");
  assertNothingWritten(f, before);
});

test("F2.4-B13 readability accept record with measured_source:\"polish_media_weight\": assessment inert / malformed", async (t) => {
  const { qcAcceptIntegrity, assessQcAccepts } = await import("./qc-accept.mjs");
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa" })] }));
  const { results, rows } = await read(f);
  const current = rows.find((row) => row.subject?.viewport === "desktop" && row.result === "warning");
  const subject = current?.subject ?? { check: CHECK, page: routes[0], viewport: "desktop", key: pairKey("#ffffff", "#0080aa", "normal") };
  const acceptOf = (measuredSource) => {
    const base = {
      schema: "campaigns-os-qc-accept/v0",
      scope: "qc_accept",
      result_id: current?.id ?? `${CHECK}:${subject.page}:${subject.viewport}:${subject.key}`,
      check: CHECK,
      leg: "polish",
      subject,
      state_fingerprint: current?.state_fingerprint ?? sha256("synthetic state"),
      result_at_accept: "warning",
      measured_at: current?.measured_at ?? new Date(Date.now() - 60_000).toISOString(),
      measured_source: measuredSource,
      reason: "known synthetic",
      accepted_by: OPERATOR,
      accepted_at: new Date(Date.now() - 30_000).toISOString(),
      recorded_by: "campaigns-os checkpoint accept",
    };
    return { ...base, integrity: qcAcceptIntegrity(base) };
  };
  const [assessment] = assessQcAccepts([acceptOf("polish_media_weight")], results);
  assert.deepEqual({ status: assessment.status, why: assessment.why }, { status: "inert", why: "malformed" }, "assessment inert / malformed");
  // Control: the same record with the readability source is a live accept,
  // so only measured_source made it malformed.
  const [control] = assessQcAccepts([acceptOf("polish_readability")], results);
  assert.equal(control.status, "active", "control: the same accept with measured_source polish_readability is active");
});

test("F2.4-B14 media_weight cell fails reproduction; readability record intact: no readability.contrast row has reason evidence_not_reproducible", async (t) => {
  const { f, build, routes } = await site(t, { pages: ["checkout"], root: true });
  assert.deepEqual(routes, [...ROUTES].sort(), "setup: the built pages are the media_weight cells' routes");
  const media = twoCellFixture([{ path: `/${SLUG}/img/hero.jpg`, bytes: 600_000 }], { buildFingerprint: build });
  media.record.cells[0].resources[0].transferred_bytes = 400_000;
  media.record = withRecomputedIntegrity(media.record);
  installPolishEvidence(f, media);
  installReadability(f, await readabilityRecord({ build, routes }));
  const { results, rows } = await read(f);
  const failed = results.filter((row) => row.check === "media.weight" && row.subject?.page === ROUTES[0]);
  assert.ok(failed.length > 0 && failed.every((row) => row.result === "unexercised" && row.reason_code === E), "setup: the media_weight cell fails reproduction");
  assert.ok(rows.length > 0, "setup (not the row's assertion): the intact readability record lists rows");
  assert.deepEqual(rows.filter((row) => row.reason_code === E).map((row) => row.id), [], "no readability.contrast row has reason evidence_not_reproducible");
});

test("F2.4-B15 record polish --evidence file containing visual_review.readability: refusal package_owned_key", async (t) => {
  // A package-owned page_load from `polish capture` (stub adapter) is on the
  // report, so the Polish gate has nothing to refuse: only the evidence
  // file's readability key can make record polish refuse. The refusal is on
  // the key, so the record's cells hold no element.
  const { f, build, routes } = await stockSite(t, []);
  await stubCapture(f, stubAdapter({}));
  const evidence = readJson(join(ROOT, "fixtures/stage-record/polish-evidence.json"));
  evidence.evidence.visual_review.readability = await readabilityRecord({ build, routes, elements: () => [] });
  const evidencePath = join(f.dir, "polish-evidence.json");
  writeJson(evidencePath, evidence);
  const before = snapshot(f);
  const res = await runCli(["record", "polish", "--packet", f.packetPath, "--evidence", evidencePath, "--json"]);
  assertIngestRefused(res, { names: ["readability"] });
  assertNothingWritten(f, before);
});

test("F2.4-B16 the same colours as normal and large text on one page; accept only the :large ref: the :normal row stays in qc_handoff.open", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({
    build,
    routes,
    elements: () => [element({ fg: "#ffffff", bg: "#aaaaaa", px: 16 }), element({ fg: "#ffffff", bg: "#aaaaaa", px: 24, path: "html>body>h2:nth-of-type(1)" })],
  }));
  const normal = pairKey("#ffffff", "#aaaaaa", "normal");
  const large = pairKey("#ffffff", "#aaaaaa", "large");
  const groups = readabilityOpen(handoffOf(await runNext(f)));
  assert.deepEqual(groups.map((group) => lower(group.key)).sort(), [large, normal].sort(), "setup: both size classes are open warnings");
  const largeRefs = refsOf(groups.find((group) => lower(group.key) === large));
  assert.equal(largeRefs.length, 2, "setup: the :large pair is open at both widths");
  await acceptRefs(f, largeRefs);
  const after = readabilityOpen(handoffOf(await runNext(f)));
  assert.deepEqual(after.map((group) => lower(group.key)), [normal], "the :normal row stays in qc_handoff.open");
});

test("F2.4-B21 readability record and accept record reconstructed consistently (integrity recomputed, later accepted_at): accept assessment = active (A1 residual)", async (t) => {
  const { qcAcceptIntegrity } = await import("./qc-accept.mjs");
  const { f, build, routes } = await site(t);
  // A record no capture wrote, made consistent by hand: integrity recomputed.
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa" })] }));
  const { rows } = await read(f);
  const current = rows.find((row) => row.subject?.viewport === "desktop" && row.result === "warning");
  assert.ok(current, "setup: the reconstructed record's pair reads warning");
  const base = {
    schema: "campaigns-os-qc-accept/v0",
    scope: "qc_accept",
    result_id: current.id,
    check: current.check,
    leg: current.leg,
    subject: current.subject,
    state_fingerprint: current.state_fingerprint,
    result_at_accept: "warning",
    measured_at: current.measured_at,
    measured_source: "polish_readability",
    reason: "known synthetic",
    accepted_by: OPERATOR,
    accepted_at: new Date(Date.parse(current.measured_at) + 1000).toISOString(),
    recorded_by: "campaigns-os checkpoint accept",
  };
  mutateReport(f, (report) => {
    report.qc_accepts = [{ ...base, integrity: qcAcceptIntegrity(base) }];
  });
  const { assessed } = await assess(f);
  assert.deepEqual(assessed.map((entry) => entry.status), ["active"], "accept assessment = active");
});

test("F2.4-B24 readability recorded; a _site file edited without record build: readability rows unexercised / stale_binding", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build, routes }));
  await assertReadsAsRecorded(f, routes);
  appendFileSync(join(f.targetRepo, "_site", SLUG, "landing", "index.html"), "<!-- hand edit -->\n");
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "stale", "setup: doctor reads the output as changed since record build");
  assertEveryRow(rows, "unexercised", STALE, "the readability record");
});

test("F2.4-B25 media_weight recorded; a _site file edited without record build: media.weight rows unexercised / stale_binding", async (t) => {
  const { f, build } = await site(t, { pages: ["checkout"], root: true });
  installPolishEvidence(f, twoCellFixture([{ path: `/${SLUG}/img/hero.jpg`, bytes: 600_000 }], { buildFingerprint: build }));
  const weight = (results) => results.filter((row) => row.check === "media.weight");
  const before = weight((await read(f)).results);
  assert.deepEqual(before.map((row) => [row.result, row.reason_code]), [["warning", "image_over_threshold"], ["warning", "image_over_threshold"]], "setup: the media.weight rows read as recorded");
  appendFileSync(join(f.targetRepo, "_site", SLUG, "index.html"), "<!-- hand edit -->\n");
  const { doctor, results } = await read(f);
  assert.equal(outputStatus(doctor), "stale", "setup: doctor reads the output as changed since record build");
  assert.deepEqual(weight(results).map((row) => [row.subject.page, row.result, row.reason_code]).sort(), before.map((row) => [row.subject.page, "unexercised", STALE]).sort(), "media.weight rows unexercised / stale_binding");
});

// ---------------------------------------------------------------------------
// Incomplete rows

test("F2.4-I11 stub probe clock exceeding 1500 ms: cell row unexercised / probe_timeout", async (t) => {
  const { f } = await stockSite(t, ["stock"]);
  const clock = virtualClock();
  const probe = async () => {
    clock.advance(1501);
    await new Promise((done) => setTimeout(done, 0));
    return {};
  };
  await stubCapture(f, stubAdapter({ probe }), { probeClock: clock });
  const { rows } = await read(f);
  assert.deepEqual(cellRows(rows, [routeOf("stock")]), cellsReading([routeOf("stock")], "probe_timeout"), "cell rows read unexercised / probe_timeout");
});

test("F2.4-I12 record bound to an old build fingerprint: every row unexercised / stale_binding", async (t) => {
  const { f, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build: OTHER_BUILD_FP, routes }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is pass");
  assertEveryRow(rows, "unexercised", STALE, "the record");
});

test("F2.4-I13 Polish evidence from 1.52.0 (no readability key): coverage not_captured_by_this_version", async (t) => {
  const { f, build } = await site(t, { pages: ["checkout"], root: true });
  installPolishEvidence(f, twoCellFixture([{ path: `/${SLUG}/img/hero.jpg`, bytes: 600_000 }], { buildFingerprint: build }));
  assert.equal(Object.hasOwn(readJson(f.reportPath).stages.polish.evidence.visual_review, "readability"), false, "setup: the evidence has no readability key");
  const { coverage } = await read(f);
  assert.deepEqual(
    coverage.filter((entry) => entry.check === CHECK).map(({ check, leg, result, reason_code }) => ({ check, leg, result, reason_code })),
    [{ check: CHECK, leg: "polish", result: "unexercised", reason_code: "not_captured_by_this_version" }],
    "coverage lists readability.contrast as not_captured_by_this_version",
  );
});

test("F2.4-I14 element ratio edited in a stored record (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  const { f, build, routes } = await site(t);
  const record = await readabilityRecord({ build, routes });
  installReadability(f, record);
  await assertReadsAsRecorded(f, routes);
  const tampered = structuredClone(record);
  const cell = tampered.cells.find((entry) => entry.viewport === "desktop");
  cell.elements[0].ratio += 0.01;
  installReadability(f, withRecomputedIntegrity(tampered));
  const { rows } = await read(f);
  assertEveryRow(rows.filter((row) => row.subject?.page === cell.route && row.subject?.viewport === "desktop"), "unexercised", E, "the tampered cell");
});

test("F2.4-I25 stub run clock exhausts the 300 s budget after the first readability-only cell: remaining cells' rows unexercised / run_budget_exhausted", async (t) => {
  const stock = [routeOf("stock-a"), routeOf("stock-b")];
  const { f } = await stockSite(t, ["stock-a", "stock-b"]);
  const clock = virtualClock();
  let probes = 0;
  const probe = async () => {
    probes += 1;
    if (probes === 1) clock.advance(300_001);
    await new Promise((done) => setTimeout(done, 0));
    return {};
  };
  await stubCapture(f, stubAdapter({ probe }), { probeClock: clock });
  const { rows } = await read(f);
  const cells = cellRows(rows, stock);
  assert.ok(cells.length > 0, "setup (not the row's assertion): the readability-only cells list cell rows");
  const exhausted = cells.filter((row) => row.result === "unexercised" && row.reason_code === "run_budget_exhausted");
  const all = stock.flatMap((page) => VIEWPORTS.map((viewport) => JSON.stringify([page, viewport])));
  const first = all.filter((cell) => !exhausted.some((row) => JSON.stringify([row.page, row.viewport]) === cell));
  assert.equal(first.length, 1, `every readability-only cell after the first reads run_budget_exhausted (not exhausted: ${first.join(", ")})`);
  assert.equal(exhausted.length, 3, "the three remaining cells' rows read unexercised / run_budget_exhausted");
});

test("F2.4-I26 warning row whose due crop fails (stub): accept_eligible = false", async (t) => {
  const { f, build, routes } = await site(t);
  const record = (crop) => readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa", crop })] });
  const eligible = async () => (await read(f)).rows.filter((row) => row.result === "warning").map((row) => row.accept_eligible);
  installReadability(f, await record(NO_CROP));
  assert.deepEqual(await eligible(), [true, true], "setup: with no crop due, the warning rows are accept-eligible");
  installReadability(f, await record({ crop_ref: null, crop_reason: "crop_unavailable" }));
  assert.deepEqual(await eligible(), [false, false], "accept_eligible = false");
});

test("F2.4-I27 built scope with 129 routes; record over the first 128, with route 129 in uncaptured_routes: route 129 cell rows unexercised / page_not_captured", async (t) => {
  const names = Array.from({ length: 129 }, (_, n) => `r${String(n + 1).padStart(3, "0")}`);
  const { f, build, routes } = await site(t, { pages: names });
  assert.equal(routes.length, 129, "setup: 129 built routes");
  installReadability(f, await readabilityRecord({ build, routes: routes.slice(0, 128), uncaptured: [routes[128]] }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is pass");
  assert.deepEqual(projected(rows.filter((row) => row.subject?.page === routes[128])), cellsReading([routes[128]], "page_not_captured"), "route 129 cell rows read unexercised / page_not_captured");
});

// API assumption (F2.4-I28): with more than 500 built HTML files the route
// enumeration stops at the first 500 routes in route order; the record
// captures the first 128 of them and lists the other 372 as
// uncaptured_routes.
test("F2.4-I28 built scope with 501 HTML files: scope row unexercised / route_enumeration_capped", async (t) => {
  const names = Array.from({ length: 501 }, (_, n) => `r${String(n + 1).padStart(3, "0")}`);
  const { f, build, routes } = await site(t, { pages: names });
  assert.equal(routes.length, 501, "setup: 501 built HTML files");
  installReadability(f, await readabilityRecord({ build, routes: routes.slice(0, 128), uncaptured: routes.slice(128, 500), capped: true }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is pass");
  assert.deepEqual(rows.filter((row) => row.subject?.key === "scope").map((row) => ({ key: row.subject.key, result: row.result, reason_code: row.reason_code })), [{ key: "scope", result: "unexercised", reason_code: "route_enumeration_capped" }], "scope row reads unexercised / route_enumeration_capped");
});

test("F2.4-I30 stored record with a duplicated route/viewport cell (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, cells: [...record.cells, structuredClone(record.cells[0])] }));
});

test("F2.4-I37 stored record with subject.viewports:[\"desktop\"] and desktop cells only (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, subject: { ...record.subject, viewports: ["desktop"] }, cells: record.cells.filter((cell) => cell.viewport === "desktop") }));
});

test("F2.4-I38 stored record whose subject.campaign_slug differs from the packet slug (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, subject: { ...record.subject, campaign_slug: "other-campaign-demo" } }));
});

test("F2.4-I39 stored record with subject.route_source:\"packet\" (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, subject: { ...record.subject, route_source: "packet" } }));
});

// API assumption (F2.4-I40): crop_ref is {path, sha256} with `path` relative
// to the target repo (.campaign-runtime/polish/readability/<hex>.png) and
// `sha256` "sha256:<hex>" of the file's bytes.
test("F2.4-I40 warning row whose crop file is deleted after capture: accept_eligible = false", async (t) => {
  const { f, build, routes } = await site(t);
  const bytes = Buffer.from("synthetic crop bytes, not an image a reader needs to decode\n");
  const hex = createHash("sha256").update(bytes).digest("hex");
  const path = `.campaign-runtime/polish/readability/${hex}.png`;
  mkdirSync(dirname(join(f.targetRepo, path)), { recursive: true });
  writeFileSync(join(f.targetRepo, path), bytes);
  installReadability(f, await readabilityRecord({ build, routes, elements: () => [element({ fg: "#ffffff", bg: "#0080aa", crop: { crop_ref: { path, sha256: `sha256:${hex}` }, crop_reason: null } })] }));
  const eligible = async () => (await read(f)).rows.filter((row) => row.result === "warning").map((row) => row.accept_eligible);
  assert.deepEqual(await eligible(), [true, true], "setup: with its crop file present, the warning rows are accept-eligible");
  rmSync(join(f.targetRepo, path));
  assert.deepEqual(await eligible(), [false, false], "accept_eligible = false");
});

test("F2.4-I48 stub adapter, a readability-only navigation fails (connection refused): cell row unexercised / navigation_failed", async (t) => {
  const { f } = await stockSite(t, ["stock"]);
  const probe = async () => {
    throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9${routeOf("stock")}`);
  };
  await stubCapture(f, stubAdapter({ probe }));
  const { rows } = await read(f);
  assert.deepEqual(cellRows(rows, [routeOf("stock")]), cellsReading([routeOf("stock")], "navigation_failed"), "cell rows read unexercised / navigation_failed");
});

test("F2.4-I51 stub adapter poisoned by a page_load timeout before the readability-only cells: readability-only cells' rows unexercised / producer_timeout", async (t) => {
  const { f } = await stockSite(t, ["stock"]);
  const captureRoute = () => new Promise(() => {});
  const probe = async () => ({});
  const result = await stubCapture(f, stubAdapter({ captureRoute, probe }), { captureCellDeadlineMs: 50 });
  const pageLoad = readJson(f.reportPath).stages.polish.evidence.visual_review.page_load;
  assert.ok(JSON.stringify(pageLoad.captures).includes("producer_timeout"), "setup: the page_load cell timed out and poisoned the adapter");
  assert.equal(result.ok, false, "setup: the capture is blocked by the incomplete page_load");
  const { rows } = await read(f);
  assert.deepEqual(cellRows(rows, [routeOf("stock")]), cellsReading([routeOf("stock")], "producer_timeout"), "readability-only cells' rows read unexercised / producer_timeout");
});

test("F2.4-I56 record whose subject.source_package_material_fingerprint differs from the current value: every row unexercised / stale_binding", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({ build, routes, sourceFp: sha256("synthetic design source package") }));
  const { doctor, rows } = await read(f);
  assert.equal(outputStatus(doctor), "pass", "setup: doctor's output fingerprint is pass");
  assertEveryRow(rows, "unexercised", STALE, "the record");
});

test("F2.4-I57 stored record with a different schema_version: rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, schema_version: "campaigns-os-polish-readability/v9" }));
});

test("F2.4-I58 stored record with performed_by:\"agent\": rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, performed_by: "agent" }));
});

test("F2.4-I59 stored record with helper_version:\"contrast/v0\": rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, helper_version: "contrast/v0" }));
});

test("F2.4-I60 stored record edited without recomputing integrity: rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => {
    record.cells[0].elements[0].selector_path = "html>body>p:nth-of-type(2)";
    return record;
  });
});

test("F2.4-I61 stored record with non-canonical measured_at (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, measured_at: record.measured_at.replace(/\.\d{3}Z$/, "Z").replace("T", " ") }));
});

test("F2.4-I62 stored record with thresholds.normal = 4.4 (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, thresholds: { ...record.thresholds, normal: 4.4 } }));
});

test("F2.4-I63 stored record with limits.routes = 129 (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, limits: { ...record.limits, routes: 129 } }));
});

test("F2.4-I64 stored record with cell_status:\"measured_ok\" (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => {
    record.cells[0].cell_status = "measured_ok";
    return withRecomputedIntegrity(record);
  });
});

test("F2.4-I65 stored record with one route/viewport cell removed (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => withRecomputedIntegrity({ ...record, cells: record.cells.slice(1) }));
});

test("F2.4-I66 stored record with a cell whose route is not in subject.routes (integrity recomputed): rows unexercised / evidence_not_reproducible", async (t) => {
  await assertTamperedRecord(t, (record) => {
    record.cells.at(-1).route = routeOf("not-in-subject");
    return withRecomputedIntegrity(record);
  });
});

test("F2.4-I19 accepted solid pair and a gradient review row in the same cell: qc_handoff.review length = 1", async (t) => {
  const { f, build, routes } = await site(t);
  installReadability(f, await readabilityRecord({
    build,
    routes,
    elements: (route, viewport) => [
      element({ fg: "#ffffff", bg: "#0080aa" }),
      ...(viewport === "desktop" ? [element({ fg: "#ffffff", bg: "#111111", role: "add_to_cart", path: "html>body>button[data-next-action=\"add-to-cart\"]:nth-of-type(1)", review: "background_gradient" })] : []),
    ],
  }));
  const pair = readabilityOpen(handoffOf(await runNext(f)));
  assert.equal(pair.length, 1, "setup: the solid pair is open");
  await acceptRefs(f, refsOf(pair[0]));
  const handoff = handoffOf(await runNext(f));
  assert.equal(handoff.accepted.filter((entry) => entry.check === CHECK).length, 2, "setup: the solid pair is accepted at both widths");
  assert.deepEqual((handoff.review || []).filter((entry) => entry.check !== CHECK).map((entry) => entry.result_ref), [], "setup: no other check has a review entry");
  assert.equal(handoff.review.length, 1, `qc_handoff.review length = 1: ${JSON.stringify(handoff.review.map((entry) => entry.result_ref))}`);
});

test("F2.4-I20 accepted pair; bundle group with no selected card at load in the same cell: qc_handoff.coverage contains state_not_observed: true", async (t) => {
  const { f, build, routes } = await site(t);
  const cardPath = "html>body>div[data-next-bundle-card=\"a\"]:nth-of-type(1)";
  installReadability(f, await readabilityRecord({
    build,
    routes,
    elements: () => [element({ fg: "#ffffff", bg: "#0080aa" }), element({ fg: "#ffffff", bg: "#111111", role: "bundle_card", path: cardPath })],
    cell: () => ({ coverage_gaps: [{ reason: "state_not_observed", role: "bundle_card", selector_path: cardPath }] }),
  }));
  const pair = readabilityOpen(handoffOf(await runNext(f)));
  assert.deepEqual(pair.map((group) => lower(group.key)), [pairKey("#ffffff", "#0080aa", "normal")], "setup: the pair is open");
  await acceptRefs(f, refsOf(pair[0]));
  const handoff = handoffOf(await runNext(f));
  assert.equal(handoff.accepted.filter((entry) => entry.check === CHECK).length, 2, "setup: the pair is accepted at both widths");
  const reasons = (handoff.coverage || []).filter((entry) => entry.check === CHECK).map((entry) => entry.reason_code);
  assert.equal(reasons.includes("state_not_observed"), true, `qc_handoff.coverage contains state_not_observed: ${JSON.stringify(reasons)}`);
});
