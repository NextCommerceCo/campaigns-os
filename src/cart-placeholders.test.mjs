// Fixture rows for raw cart placeholders
// (`built_output.cart_placeholders`), through the real doctor entry points:
// `doctor --built` (doctorBuiltOutput) over the committed
// fixtures/cart-placeholders/<case>/{bad,good} trees or a temp tree built from
// them, and the packet registry (doctorPacket, `next`, `checkpoint accept`)
// over a synthetic packet whose _site/ pages are real built HTML.
//
// API assumption (every row): subject.page is the built page path relative to
// the doctor target, the `file` collectBuiltPageIdentityInputs gives
// ("_site/example-campaign/index.html"), so a result id is
// `cart_placeholders:<that path>:<key>`.
// API assumption (token rows): subject.key and observation.token are the known
// token with its braces ("{item.name}"), the phase-0 stand-in's key form.
// API assumption (F1.5-I1, F1.5-I2): an unknown shape keys on
// shape_sha256 = "sha256:" + hex sha256 of the matched brace string, braces
// included ("{notAToken}"), the 1.0 fingerprint format.
// API assumption (page-level rows): `pass`, `sdk_pin_unverified`,
// `sdk_pin_unknown`, `page_unreadable`, `page_too_large`,
// `candidate_cap_reached`, `finding_cap_reached` and `page_cap_reached` are one
// row per page with subject.key "page". A page holding token or shape results
// has no page-level row unless a cap or a read failure adds one.
// API assumption (every row): subject is exactly {check, page, key} and every row carries members[] (buildQcResult's default []).
// A token or shape result kept on a page over the candidate or finding cap
// carries exactly the 1.0 capped-page member; every other row, page-level and
// cap rows included, carries members [].
// API assumption (F1.5-B1, F1.5-B5): observation.sdk_pin is the bare version
// ("0.4.38", no "v"), with sdk_pin_source "loader".
// API assumption (F1.5-I6, F1.5-I12): the 50 kept results of a page over the
// finding cap are its first 50 distinct tokens in document order.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  OPERATOR,
  ROOT,
  SLUG,
  assertNoNetworkAttempts,
  assertNothingWritten,
  assertRefused,
  campaignFixture,
  delay,
  doctorOf,
  mutateReport,
  readJson,
  refOf,
  runAccept,
  runNext,
  snapshot,
  withNoNetwork,
  writeJson,
} from "./qc-test-factories.mjs";

// No network: importing qc-test-factories.mjs (the only non-builtin static
// import) installs the guard before any module under test loads, so the
// modules below, imported dynamically after it, capture only the guarded fetch
// and http/https. Any attempt recorded during a test fails that test.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");
const { computeBuildFingerprint } = await import("./built-site-scope.mjs");

const CHECK = "cart_placeholders";
const GATE = "built_output.cart_placeholders";
const CAMPAIGN = "example-campaign";
const FIXTURE_ROOT = join(ROOT, "fixtures", "cart-placeholders");
const PAGE = `_site/${CAMPAIGN}/index.html`;
const PAGE_KEY = "page";
const MiB = 1024 * 1024;

const idOf = (page, key) => `${CHECK}:${page}:${key}`;
const shapeKey = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const fixtureTree = (name, variant) => join(FIXTURE_ROOT, name, variant);
const fixturePage = (name, variant) => readFileSync(join(fixtureTree(name, variant), "_site", CAMPAIGN, "index.html"), "utf8");

// A synthetic built page. `pin` is the loader's version spec (null: no loader).
const LOADER = (pin) => `<script src="https://cdn.example.invalid/campaign-cart@${pin}/dist/loader.js"></script>`;
function html({ pin = "v0.4.38", head = "", body }) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Synthetic cart placeholder fixture</title>\n${head}${pin == null ? "" : `${LOADER(pin)}\n`}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
const TEMPLATE_ONLY = "<template><div class=\"cart-row\"><span>{item.name}</span></div></template>\n<p>Synthetic cart page.</p>";

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// A temp `doctor --built` target: _site/example-campaign/<file> per entry,
// optionally seeded from a committed fixture tree.
function tempTree(t, { from = null, pages = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cart-placeholders-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (from) cpSync(from, dir, { recursive: true });
  for (const [file, text] of Object.entries(pages)) writeFile(join(dir, "_site", CAMPAIGN, file), text);
  return dir;
}
const setTreePage = (dir, file, text) => writeFile(join(dir, "_site", CAMPAIGN, file), text);

const builtDoctor = (dir) => withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }));

const rowsOf = (result) => (Array.isArray(result?.derived?.qc_results) ? result.derived.qc_results : []).filter((row) => row?.check === CHECK);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// The complete row shape the setup determines: id, check, subject, result,
// reason_code and the exact members[] (a missing members[] stays undefined).
const summarize = (row) => ({ id: row.id, check: row.check, subject: row.subject, result: row.result, reason_code: row.reason_code, members: row.members });
const expectRow = (page, key, result, reasonCode, members = []) => ({ id: idOf(page, key), check: CHECK, subject: { check: CHECK, page, key }, result, reason_code: reasonCode, members });
const pageRow = (page, result, reasonCode = null) => expectRow(page, PAGE_KEY, result, reasonCode);

// The gate ran as its own doctor check and is not a checkpoint gate.
function assertWired(result) {
  assert.ok(Array.isArray(result?.derived?.doctor_checks) && result.derived.doctor_checks.includes(GATE), `derived.doctor_checks lists ${GATE}: ${JSON.stringify(result?.derived?.doctor_checks)}`);
  assert.equal((result.derived.checkpoint_gates || []).some((gate) => String(gate?.id).startsWith(GATE)), false, `${GATE} is not in derived.checkpoint_gates`);
}

// The exact set of cart_placeholders results, each a well-formed doctor row.
// `result` is a doctor result or the persisted doctor sidecar.
function assertRows(result, expected) {
  const rows = rowsOf(result);
  assert.deepEqual(rows.map(summarize).sort(byId), [...expected].sort(byId), "the exact set of cart_placeholders results, complete rows");
  for (const row of rows) {
    assert.equal(row.schema, "campaigns-os-qc-result/v0", `${row.id} schema`);
    assert.equal(row.leg, "doctor", `${row.id} leg`);
    assert.equal(row.subject.check, CHECK, `${row.id} subject.check`);
    assert.equal(row.producer, "campaigns-os doctor", `${row.id} producer`);
    assert.match(String(row.state_fingerprint), /^sha256:[a-f0-9]{64}$/, `${row.id} state_fingerprint`);
  }
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

// The exact doctor issues the gate raised: warnings[] holds one
// `built_output.cart_placeholders.<reason_code>` issue per warning or review
// result, and errors[] holds none (never escalated).
function assertIssues(result, expected) {
  const issues = (result.warnings || []).filter((issue) => String(issue?.code).startsWith(`${GATE}.`));
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.detail?.qc_result?.id]).sort(),
    expected.map(([reasonCode, id]) => [`${GATE}.${reasonCode}`, id]).sort(),
    "the exact cart_placeholders issues in warnings[]",
  );
  assert.deepEqual((result.errors || []).filter((issue) => String(issue?.code).startsWith(GATE)), [], `${GATE} never raises an error`);
}

// A known live token: warning / live_token on its own row, recording the pin.
function assertLiveToken(row, token, { pin = "0.4.38", where = null } = {}) {
  assert.equal(row.observation?.token, token, `${row.id} observation.token`);
  assert.equal(row.observation?.known, true, `${row.id} observation.known`);
  assert.equal(row.observation?.shape_sha256 ?? null, null, `${row.id} observation.shape_sha256`);
  assert.equal(row.observation?.sdk_pin, pin, `${row.id} observation.sdk_pin`);
  assert.equal(row.observation?.sdk_pin_source, "loader", `${row.id} observation.sdk_pin_source`);
  if (where) assert.deepEqual(row.observation.occurrences.map((occurrence) => occurrence.where), where, `${row.id} occurrences[].where`);
}

const capMember = (reasonCode) => ({ key: "page_coverage", result: "unexercised", reason_code: reasonCode });

// An accept as `checkpoint accept` writes it (createQcAccept), for a result
// measured before it.
function acceptOf({ createQcAccept, qcAcceptAttribution }, row) {
  assert.ok(Number.isFinite(Date.parse(row.measured_at)), `the ${row.id} result carries measured_at`);
  const now = new Date(Date.parse(row.measured_at) + 1000).toISOString();
  return createQcAccept(row, { measuredAt: row.measured_at, attribution: qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now }) });
}

// ---------------------------------------------------------------------------
// Packet entry point: a synthetic packet whose next status is `ready`, with a
// real built page per CampaignSpec route and the build fingerprint recorded.
const PACKET_ROUTES = ["landing", "checkout", "upsell", "receipt"];
const packetRel = (route) => `_site/${SLUG}/${route}/index.html`;
const plainPacketPage = (route) => html({ head: `<meta name="next-page-type" content="${route}">\n`, body: `<p class="cart-line">Synthetic ${route} page.</p>` });

function stampBuild(f) {
  const fingerprint = computeBuildFingerprint(join(f.targetRepo, "_site", SLUG)).fingerprint;
  mutateReport(f, (report) => {
    report.stages.assembly.build_fingerprint = fingerprint;
  });
}

function builtPacket(t, { landing = null } = {}) {
  const f = campaignFixture();
  t.after(f.cleanup);
  for (const route of PACKET_ROUTES) writeFile(join(f.targetRepo, packetRel(route)), route === "landing" && landing ? landing : plainPacketPage(route));
  writeJson(join(f.targetRepo, ".campaign-runtime/page-kit-build-summary.json"), {
    pages: PACKET_ROUTES.map((route) => ({ campaignSlug: SLUG, status: "ok", inputFile: `src/${SLUG}/${route}.html`, url: `/${SLUG}/${route}/`, warnings: [] })),
  });
  stampBuild(f);
  return f;
}

// ---------------------------------------------------------------------------
// Working rows

test("F1.5-W1 tokens only in <template> and in a data-next-cart-items live row; pin 0.4.38: pass", async () => {
  const result = await builtDoctor(fixtureTree("w1-template-and-live-row", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

test("F1.5-W2 {quantity} and {step} inside a quantity-control element; JSON-LD <script> with braces: pass", async () => {
  const result = await builtDoctor(fixtureTree("w2-quantity-control-and-json-ld", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

test("F1.5-W3 data-next-cart-items data-item-template-selector=\"#row\"; #row holds {item.name}: pass", async () => {
  const result = await builtDoctor(fixtureTree("w3-template-selector-id", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

test("F1.5-W4 container data-item-template=\"<li>{item.name}</li>\": pass", async () => {
  const result = await builtDoctor(fixtureTree("w4-data-item-template", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

test("F1.5-W5 {item.name} only in a data-foo attribute (not rendered): pass", async () => {
  const result = await builtDoctor(fixtureTree("w5-data-attribute", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

test("F1.5-W6 pin 0.4.40 (in the verified list); tokens only in <template>: pass", async () => {
  const result = await builtDoctor(fixtureTree("w6-verified-pin-0-4-40", "good"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "pass")]);
  assertIssues(result, []);
});

// ---------------------------------------------------------------------------
// Broken rows

test("F1.5-B1 live {item.name} in text and {subtotal} in alt: warning, 2 results (live_token)", async () => {
  const result = await builtDoctor(fixtureTree("b1-live-text-and-alt", "bad"));
  assertWired(result);
  const rows = assertRows(result, [
    expectRow(PAGE, "{item.name}", "warning", "live_token"),
    expectRow(PAGE, "{subtotal}", "warning", "live_token"),
  ]);
  assertIssues(result, [["live_token", idOf(PAGE, "{item.name}")], ["live_token", idOf(PAGE, "{subtotal}")]]);
  assertLiveToken(rows[idOf(PAGE, "{item.name}")], "{item.name}", { where: ["text"] });
  assertLiveToken(rows[idOf(PAGE, "{subtotal}")], "{subtotal}", { where: ["attr:alt"] });
  for (const row of Object.values(rows)) assert.equal(row.accept_eligible, true, `${row.id} is accept-eligible`);
});

test("F1.5-B2 live {package.name}: warning (live_token)", async () => {
  const result = await builtDoctor(fixtureTree("b2-live-package-token", "bad"));
  assertWired(result);
  const rows = assertRows(result, [expectRow(PAGE, "{package.name}", "warning", "live_token")]);
  assertIssues(result, [["live_token", idOf(PAGE, "{package.name}")]]);
  assertLiveToken(rows[idOf(PAGE, "{package.name}")], "{package.name}", { where: ["text"] });
});

test("F1.5-B3 {step} inside a remove-item element: warning (live_token)", async () => {
  const result = await builtDoctor(fixtureTree("b3-step-in-remove-item", "bad"));
  assertWired(result);
  const rows = assertRows(result, [expectRow(PAGE, "{step}", "warning", "live_token")]);
  assertIssues(result, [["live_token", idOf(PAGE, "{step}")]]);
  assertLiveToken(rows[idOf(PAGE, "{step}")], "{step}", { where: ["text"] });
});

test("F1.5-B4 the F1.5-B1 tree plus an sdk_markup blocker, in --built and packet modes: warning in both modes, still in warnings[] (live_token)", async (t) => {
  const BLOCKER = "built_output.sdk_markup.swap_with_add_to_cart";
  const tree = fixtureTree("b4-live-tokens-with-sdk-markup-blocker", "bad");

  const sdkMarkupErrors = (result) => result.errors.map((issue) => issue.code).filter((code) => code.startsWith("built_output.sdk_markup."));

  const built = await builtDoctor(tree);
  assert.deepEqual(sdkMarkupErrors(built), [BLOCKER], "--built: the sdk_markup blocker stands");
  assert.equal(built.status, "blocked");
  assertWired(built);
  assertRows(built, [expectRow(PAGE, "{item.name}", "warning", "live_token"), expectRow(PAGE, "{subtotal}", "warning", "live_token")]);
  assertIssues(built, [["live_token", idOf(PAGE, "{item.name}")], ["live_token", idOf(PAGE, "{subtotal}")]]);

  const f = builtPacket(t, { landing: fixturePage("b4-live-tokens-with-sdk-markup-blocker", "bad") });
  const packet = doctorOf(f.packetPath, {});
  assert.deepEqual(sdkMarkupErrors(packet), [BLOCKER], "packet: the sdk_markup blocker stands");
  assertWired(packet);
  const landing = packetRel("landing");
  assertRows(packet, [
    expectRow(landing, "{item.name}", "warning", "live_token"),
    expectRow(landing, "{subtotal}", "warning", "live_token"),
    pageRow(packetRel("checkout"), "pass"),
    pageRow(packetRel("upsell"), "pass"),
    pageRow(packetRel("receipt"), "pass"),
  ]);
  assertIssues(packet, [["live_token", idOf(landing, "{item.name}")], ["live_token", idOf(landing, "{subtotal}")]]);
});

test("F1.5-B5 accepted F1.5-B2 at loader pin 0.4.38; the loader changes to 0.4.40: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const dir = tempTree(t, { from: fixtureTree("b2-live-package-token", "bad") });
  const id = idOf(PAGE, "{package.name}");
  const before = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{package.name}", "warning", "live_token")]);
  assertLiveToken(before[id], "{package.name}", { pin: "0.4.38" });
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(before)).map(({ status, why }) => [status, why]), [["active", null]], "precondition: the accept is active on the measured state");

  const html038 = readFileSync(join(dir, "_site", CAMPAIGN, "index.html"), "utf8");
  assert.ok(html038.includes("campaign-cart@v0.4.38/dist/loader.js"), "setup: the page loads campaign-cart@v0.4.38");
  setTreePage(dir, "index.html", html038.replace("campaign-cart@v0.4.38/dist/loader.js", "campaign-cart@v0.4.40/dist/loader.js"));
  const afterRows = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{package.name}", "warning", "live_token")]);
  assertLiveToken(afterRows[id], "{package.name}", { pin: "0.4.40" });
  assert.notEqual(afterRows[id].state_fingerprint, before[id].state_fingerprint, "the pin is bound in the state");
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(afterRows)).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]]);
});

test("F1.5-B6 accepted live_token with two occurrences; one occurrence removed: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const dir = tempTree(t, { pages: { "index.html": html({ body: "<p class=\"cart-line\">{item.name}</p>\n<p class=\"cart-line\">{item.name}</p>" }) } });
  const id = idOf(PAGE, "{item.name}");
  const before = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{item.name}", "warning", "live_token")]);
  assert.deepEqual(before[id].observation.occurrences.map((occurrence) => occurrence.where), ["text", "text"], "setup: two occurrences");
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(before)).map(({ status, why }) => [status, why]), [["active", null]], "precondition: the accept is active on the measured state");

  setTreePage(dir, "index.html", html({ body: "<p class=\"cart-line\">{item.name}</p>\n<p class=\"cart-line\">Synthetic cart line</p>" }));
  const afterRows = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{item.name}", "warning", "live_token")]);
  assert.deepEqual(afterRows[id].observation.occurrences.map((occurrence) => occurrence.where), ["text"], "one occurrence is left");
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(afterRows)).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]]);
});

test("F1.5-B7 accepted live_token; the occurrence moves to a different element: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const dir = tempTree(t, { pages: { "index.html": html({ body: "<p class=\"cart-line\">{item.name}</p>\n<span class=\"cart-note\">Synthetic note</span>" }) } });
  const id = idOf(PAGE, "{item.name}");
  const before = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{item.name}", "warning", "live_token")]);
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(before)).map(({ status, why }) => [status, why]), [["active", null]], "precondition: the accept is active on the measured state");

  setTreePage(dir, "index.html", html({ body: "<p class=\"cart-line\">Synthetic note</p>\n<span class=\"cart-note\">{item.name}</span>" }));
  const afterRows = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{item.name}", "warning", "live_token")]);
  assert.deepEqual(before[id].observation.occurrences.map((occurrence) => occurrence.where), ["text"], "setup: one occurrence");
  assert.deepEqual(afterRows[id].observation.occurrences.map((occurrence) => occurrence.where), ["text"], "still one occurrence");
  const [was] = before[id].observation.occurrences;
  const [now] = afterRows[id].observation.occurrences;
  assert.notEqual(now.element_path, was.element_path, "the occurrence is on another element");
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(afterRows)).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]]);
});

test("F1.5-B8 accepted F1.5-B2; the page gains 2,001 brace candidates, so the kept live_token result acquires the capped-page member: accept lapsed (state_changed)", async (t) => {
  const qcAccept = await import("./qc-accept.mjs");
  const dir = tempTree(t, { from: fixtureTree("b2-live-package-token", "bad") });
  const id = idOf(PAGE, "{package.name}");
  const before = assertRows(await builtDoctor(dir), [expectRow(PAGE, "{package.name}", "warning", "live_token")]);
  const record = acceptOf(qcAccept, before[id]);
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(before)).map(({ status, why }) => [status, why]), [["active", null]], "precondition: the accept is active on the measured state");

  const candidates = Array.from({ length: 2001 }, (_, index) => `<span>{item.c${index + 1}}</span>`).join("");
  const page = readFileSync(join(dir, "_site", CAMPAIGN, "index.html"), "utf8");
  setTreePage(dir, "index.html", page.replace("</body>", `<template>${candidates}</template>\n</body>`));
  const afterRows = assertRows(await builtDoctor(dir), [
    expectRow(PAGE, "{package.name}", "warning", "live_token", [capMember("candidate_cap_reached")]),
    pageRow(PAGE, "unexercised", "candidate_cap_reached"),
  ]);
  assert.equal(afterRows[id].accept_eligible, false, "a result kept on a capped page is not accept-eligible");
  assert.deepEqual(qcAccept.assessQcAccepts([record], Object.values(afterRows)).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]]);
});

// ---------------------------------------------------------------------------
// Incomplete rows

// Unknown brace strings are stored only as shape_sha256, never as text.
function assertShapeNotPersisted(result, text) {
  const persisted = JSON.stringify([rowsOf(result), (result.warnings || []).filter((issue) => String(issue?.code).startsWith(GATE))]);
  assert.equal(persisted.includes(text), false, `the unknown brace string ${text} is never persisted as text`);
}

test("F1.5-I1 live {notAToken}: review (unknown_brace)", async () => {
  const result = await builtDoctor(fixtureTree("i1-unknown-brace", "bad"));
  assertWired(result);
  const key = shapeKey("{notAToken}");
  const rows = assertRows(result, [expectRow(PAGE, key, "review", "unknown_brace")]);
  assertIssues(result, [["unknown_brace", idOf(PAGE, key)]]);
  const row = rows[idOf(PAGE, key)];
  assert.equal(row.observation?.token, null, "an unknown shape has no token");
  assert.equal(row.observation?.known, false);
  assert.equal(row.observation?.shape_sha256, key);
  assert.equal(row.accept_eligible, false);
  assertShapeNotPersisted(result, "notAToken");
});

test("F1.5-I2 live {tax}: review (unknown_brace)", async () => {
  const result = await builtDoctor(fixtureTree("i2-tax", "bad"));
  assertWired(result);
  const key = shapeKey("{tax}");
  const rows = assertRows(result, [expectRow(PAGE, key, "review", "unknown_brace")]);
  assertIssues(result, [["unknown_brace", idOf(PAGE, key)]]);
  const row = rows[idOf(PAGE, key)];
  assert.equal(row.observation?.token, null, "{tax} is not an SDK cart-summary var");
  assert.equal(row.observation?.known, false);
  assert.equal(row.observation?.shape_sha256, key);
  assertShapeNotPersisted(result, "{tax}");
});

test("F1.5-I3 data-item-template-selector=\".row-tpl\"; unowned live {item.name} on that page: review (template_selector_unresolved)", async () => {
  const result = await builtDoctor(fixtureTree("i3-template-selector-unresolved", "bad"));
  assertWired(result);
  const rows = assertRows(result, [expectRow(PAGE, "{item.name}", "review", "template_selector_unresolved")]);
  assertIssues(result, [["template_selector_unresolved", idOf(PAGE, "{item.name}")]]);
  assert.equal(rows[idOf(PAGE, "{item.name}")].accept_eligible, false);
});

test("F1.5-I4 pin 0.4.37; tokens only in <template>: unexercised (sdk_pin_unverified)", async () => {
  const result = await builtDoctor(fixtureTree("i4-pin-unverified", "bad"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "unexercised", "sdk_pin_unverified")]);
  assertIssues(result, []);
});

test("F1.5-I5 no loader on the page; campaigns.json sdk_version 0.4.40; tokens only in <template>: unexercised (sdk_pin_unknown)", async (t) => {
  const dir = tempTree(t, { from: fixtureTree("i5-no-loader-campaigns-json-pin", "bad") });
  assert.equal(readFileSync(join(dir, "_site", CAMPAIGN, "index.html"), "utf8").includes("campaign-cart@"), false, "setup: no loader on the page");
  writeJson(join(dir, "_data", "campaigns.json"), { [CAMPAIGN]: { name: "Example Campaign", sdk_version: "0.4.40", store_url: "https://store.example.invalid" } });
  const result = await builtDoctor(dir);
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "unexercised", "sdk_pin_unknown")]);
  assertIssues(result, []);
});

test("F1.5-I6 51 distinct live known tokens {item.f1}…{item.f51} on one page: cap row unexercised (finding_cap_reached)", async (t) => {
  const tokens = Array.from({ length: 51 }, (_, index) => `{item.f${index + 1}}`);
  const dir = tempTree(t, { pages: { "index.html": html({ body: tokens.map((token) => `<p class="cart-line">${token}</p>`).join("\n") }) } });
  const result = await builtDoctor(dir);
  assertWired(result);
  const kept = tokens.slice(0, 50);
  const rows = assertRows(result, [
    ...kept.map((token) => expectRow(PAGE, token, "warning", "live_token", [capMember("finding_cap_reached")])),
    pageRow(PAGE, "unexercised", "finding_cap_reached"),
  ]);
  for (const token of kept) assert.equal(rows[idOf(PAGE, token)].accept_eligible, false, `${idOf(PAGE, token)} is not accept-eligible`);
});

test("F1.5-I7 loader campaign-cart@latest/dist/loader.js; tokens only in <template>: unexercised (sdk_pin_unknown)", async () => {
  const result = await builtDoctor(fixtureTree("i7-pin-latest", "bad"));
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "unexercised", "sdk_pin_unknown")]);
  assertIssues(result, []);
});

test("F1.5-I8 a built page is a dangling symlink: unexercised (page_unreadable)", async (t) => {
  const dir = tempTree(t, { pages: { "index.html": html({ pin: "v0.4.40", body: TEMPLATE_ONLY }) } });
  symlinkSync("missing-synthetic-page.html", join(dir, "_site", CAMPAIGN, "broken.html"));
  const result = await builtDoctor(dir);
  assertWired(result);
  assertRows(result, [
    pageRow(PAGE, "pass"),
    pageRow(`_site/${CAMPAIGN}/broken.html`, "unexercised", "page_unreadable"),
  ]);
  assertIssues(result, []);
});

test("F1.5-I9 a 6 MiB built page: unexercised (page_too_large)", async (t) => {
  const filler = "<p>Synthetic filler line for the page size cap.</p>\n";
  const body = filler.repeat(Math.ceil((6 * MiB) / filler.length));
  const dir = tempTree(t, { pages: { "index.html": html({ pin: "v0.4.40", body }) } });
  const size = statSync(join(dir, "_site", CAMPAIGN, "index.html")).size;
  assert.ok(size >= 6 * MiB && size < 6 * MiB + 4096, `setup: the page is 6 MiB (${size} bytes)`);
  const result = await builtDoctor(dir);
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "unexercised", "page_too_large")]);
  assertIssues(result, []);
});

test("F1.5-I10 2,001 brace candidates on one page, all inside <template>; pin 0.4.40: page unexercised, no page pass (candidate_cap_reached)", async (t) => {
  const candidates = Array.from({ length: 2001 }, (_, index) => `<span>{item.c${index + 1}}</span>`).join("");
  const dir = tempTree(t, { pages: { "index.html": html({ pin: "v0.4.40", body: `<template>${candidates}</template>\n<p>Synthetic cart page.</p>` }) } });
  const result = await builtDoctor(dir);
  assertWired(result);
  assertRows(result, [pageRow(PAGE, "unexercised", "candidate_cap_reached")]);
  assert.deepEqual(rowsOf(result).filter((row) => row.result === "pass").map((row) => row.id), [], "no page pass");
  assertIssues(result, []);
});

test("F1.5-I11 501 built pages: the 501st page unexercised (page_cap_reached)", async (t) => {
  const names = Array.from({ length: 501 }, (_, index) => `p${String(index).padStart(3, "0")}.html`);
  const dir = tempTree(t, { pages: Object.fromEntries(names.map((name) => [name, html({ pin: "v0.4.40", body: `<p>Synthetic page ${name}.</p>` })])) });
  const result = await builtDoctor(dir);
  assertWired(result);
  assertRows(result, [
    ...names.slice(0, 500).map((name) => pageRow(`_site/${CAMPAIGN}/${name}`, "pass")),
    pageRow(`_site/${CAMPAIGN}/${names[500]}`, "unexercised", "page_cap_reached"),
  ]);
  assertIssues(result, []);
});

test("F1.5-I12 the F1.5-I6 page; checkpoint accept on one kept live_token warning: refused; nothing written (members_unresolved)", async (t) => {
  const tokens = Array.from({ length: 51 }, (_, index) => `{item.f${index + 1}}`);
  const f = builtPacket(t, { landing: html({ head: "<meta name=\"next-page-type\" content=\"landing\">\n", body: tokens.map((token) => `<p class="cart-line">${token}</p>`).join("\n") }) });
  await runNext(f);
  // The persisted doctor sidecar holds exactly the F1.5-I6 set on the landing
  // page (50 kept warnings with the capped-page member, and the cap row) and a
  // page pass on each other route.
  const landing = packetRel("landing");
  const persisted = assertRows(readJson(f.sidecarPath), [
    ...tokens.slice(0, 50).map((token) => expectRow(landing, token, "warning", "live_token", [capMember("finding_cap_reached")])),
    pageRow(landing, "unexercised", "finding_cap_reached"),
    pageRow(packetRel("checkout"), "pass"),
    pageRow(packetRel("upsell"), "pass"),
    pageRow(packetRel("receipt"), "pass"),
  ]);
  const row = persisted[idOf(landing, "{item.f1}")];
  assert.equal(row.accept_eligible, false);
  await delay(5);
  const before = snapshot(f);
  assertRefused(await runAccept(f, [refOf(row)]), "members_unresolved", { names: [row.id] });
  assertNothingWritten(f, before);
  assert.equal(readJson(f.reportPath).qc_accepts, undefined, "no qc_accepts[] was written");
});
