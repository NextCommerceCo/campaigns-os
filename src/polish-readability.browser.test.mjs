// F2.4 frozen fixture rows for the Polish readability probe, real Chromium
// (contract 2.4 "Where it runs", "Element measurement (frozen)", Record,
// Result rules). Each row is a stub page under _site/<slug>/ served on
// 127.0.0.1 (src/readability-harness.browser.test.mjs) and measured by a
// real `polish capture`. SDK state is set statically in the markup.
//
// Most rows share one capture over one built site, one page per row: every
// page is a readability-only cell (a template stock page), measured in its
// own fresh context, and each row reads only its own page's cells and rows.
// W7, W20, W23 and I49 need their own site or clock and capture alone, and
// so do the recapture rows (B11, B27, B28, B29, B31): accept the pair, change
// the page, `record build`, and capture again.
//
// At BASE_SHA the capture completes (the mapped landing page keeps page_load
// working) and attaches no visual_review.readability, so each row fails on
// the record or on readCurrentQcResults listing no readability.contrast row.
//
// API assumptions (every row; the contract fixes the record fields and the
// row keys, not these forms):
// - pair keys are `pair:<fg8>/<bg8>:<size_class>` with fg8/bg8 the 8-digit
//   rrggbbaa hex (compared in lower case);
// - a role's review row is `review:<role>:<reason_code>`, a role coverage row
//   `role:<role>:coverage`, the other keys exactly as the contract's result
//   table spells them (`state:expanded:coverage`, `gap:<reason>`,
//   `inactive_control`, `cell`);
// - the contract names no reason code for a pair `warning`, so warning rows
//   are compared on key and result only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, afterEach } from "node:test";

import {
  CHECK,
  VIEWPORTS,
  assertCaptureCompleted,
  both,
  browserTest,
  capturePolish,
  cellsOf,
  connectionReset,
  htmlPage,
  pageRows,
  readabilityRecord,
  readabilityRows,
  readabilitySite,
  rebuildPages,
  respond,
  routeOf,
  stall,
} from "./readability-harness.browser.test.mjs";
import { ROOT, assertAccepted, assertNoNetworkAttempts, handoffOf, readJson, runAccept, runNext } from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const CLI = join(ROOT, "bin/campaigns-os.mjs");
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const BTN = "border:0;padding:8px 12px;font-size:16px;font-weight:400;font-family:sans-serif";
const P = "margin:0;padding:8px;font-size:16px;font-weight:400";
const ATC = (style, text = "Add to cart", extra = "") => `<button data-next-action="add-to-cart" type="button"${extra} style="${BTN};${style}">${text}</button>`;
const STRIP = "<p style=\"margin:0;padding:8px;color:#ffffff;background:#111111\">Synthetic text</p>";

// One page per row of the shared capture.
const SHARED = ({ other }) => ({
  w3: htmlPage(ATC("font-size:14pt;font-weight:700;color:#ffffff;background:#e0662b")),
  w4: htmlPage(`<p style="${P};font-size:24px;color:#ffffff;background:#e0662b">Large text</p>`),
  w6: htmlPage(`<div data-next-bundle-card="b1" data-next-selected="true" style="${P};color:oklch(0.21 0.034 264.665);background:oklch(0.828 0.189 84.429)">Bundle of three</div>`),
  "w8-checkout": htmlPage(`<p style="${P};color:#ffffff;background:#111111">Checkout</p>`, { head: `<script src="${other.origin}/vendor/analytics.js"></script>` }),
  w9: htmlPage(`<p style="margin:0;padding:8px;font-size:calc(1rem + 0.5vw);font-weight:700;color:#ffffff;background:#111111">Bold heading</p>`),
  w18: htmlPage(`<details open style="padding:8px;color:#ffffff;background:#767676;font-size:16px"><summary>More</summary><p style="margin:0">Panel text</p></details>`),
  w19: htmlPage(`<textarea readonly style="color:#ffffff;background:#767676;font-size:16px;font-weight:400;border:0;width:300px;height:60px">Readonly note</textarea>`),
  w21: htmlPage(`<input type="submit" value="Buy" style="${BTN};color:#ffffff;background:#767676">`),
  w22: htmlPage(`<div data-next-bump="bump-1" class="next-active" style="${P};color:#ffffff;background:#333333">Add the bump</div>`),
  b1: htmlPage(`<p style="${P};color:#ffffff;background:#0080aa">Normal text</p>`),
  b2: htmlPage(`<p style="${P};color:#ffffff;background:#949494">Normal text</p>`),
  b3: htmlPage(`<p style="margin:0;padding:8px;font-size:14pt;font-weight:600;color:#ffffff;background:#e0662b">Semibold text</p>`),
  b5: htmlPage(ATC("color:#eeeeee;background:#ffffff", "Buy now")),
  b6: htmlPage(`<div data-next-bundle-card="b1" data-next-selected="true" style="${P};color:#222222;background:#333333">Selected bundle</div>`),
  b7: htmlPage("<a style=\"color:#fff;background:#111\"><span style=\"color:#222\">x</span></a>"),
  b8: htmlPage(`<div style="padding:8px;background:#ffffff"><p style="${P};color:#ffffff;background:rgba(0,0,0,0.5)">Translucent panel</p></div>`),
  b9: htmlPage(`<div style="padding:8px;background:#000000"><p style="${P};color:rgba(255,255,255,0.3)">Faint text</p></div>`),
  i1: htmlPage(ATC("color:#ffffff;background-color:#111111;background-image:linear-gradient(#111111,#333333)")),
  i2: htmlPage(ATC(`color:#ffffff;background-color:#111111;background-image:url(${PNG_1PX})`)),
  i3: htmlPage(ATC("color:#ffffff;background:#111111;opacity:0.3")),
  i4: htmlPage(`<div style="position:relative;width:240px;height:60px;background:#111111"><img alt="" src="${PNG_1PX}" style="position:absolute;left:0;top:0;width:240px;height:60px"><button data-next-action="add-to-cart" type="button" style="${BTN};position:relative;color:#ffffff;background:transparent">Add to cart</button></div>`),
  i7: htmlPage(`<button disabled style="${BTN};color:#bbbbbb;background:#eeeeee">Unavailable</button>`),
  i8: htmlPage("<span data-next-display=\"package.price\"></span>"),
  i9: htmlPage(STRIP, { head: `<link rel="stylesheet" href="${routeOf("i9")}missing.css">` }),
  i10: htmlPage(Array.from({ length: 2500 }, (_, n) => `<p style="margin:0">Line ${n + 1}</p>`).join(""), { base: "body{margin:0;background:#111111;color:#ffffff;font:16px/1.2 sans-serif}" }),
  i15: htmlPage(`<div data-next-bundle-card="a" style="${P};color:#ffffff;background:#111111">Bundle A</div><div data-next-bundle-card="b" style="${P};color:#ffffff;background:#111111">Bundle B</div>`),
  i16: htmlPage(ATC("color:#ffffff;background:transparent"), { base: ":root{color-scheme:dark}body{margin:0;background:transparent}" }),
  i21: htmlPage(`<button type="button" aria-expanded="false" aria-controls="panel-1" style="${BTN};color:#ffffff;background:#111111">Show details</button><div id="panel-1" hidden><p style="${P};color:#111111">Panel text</p></div>`),
  i22: htmlPage(`<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = "<p>Shadow text</p>";</script>${STRIP}`),
  i23: htmlPage(`<iframe src="${other.origin}/field/" title="Card field" style="width:320px;height:80px;border:0"></iframe>${STRIP}`),
  i24: htmlPage(ATC("color:#bbbbbb;background:#eeeeee", "Add to cart", " class=\"next-disabled\"")),
  i29: htmlPage(ATC("color:#ffffff;background:#111111", "Add to cart", " data-next-loading=\"true\"")),
  i31: htmlPage("<div style=\"opacity:.3\"><div style=\"background:#111\"><span data-next-action=\"add-to-cart\" style=\"color:#fff\">x</span></div></div>"),
  i32: htmlPage("<div style=\"filter:grayscale(1)\"><div style=\"background:#111\"><span data-next-action=\"add-to-cart\" style=\"color:#fff\">x</span></div></div>"),
  i33: htmlPage("<div style=\"mix-blend-mode:multiply\"><div style=\"background:#111\"><span data-next-action=\"add-to-cart\" style=\"color:#fff\">x</span></div></div>"),
  i34: htmlPage("<div style=\"mask-image:linear-gradient(#000,transparent)\"><div style=\"background:#111\"><span data-next-action=\"add-to-cart\" style=\"color:#fff\">x</span></div></div>"),
  i35: htmlPage(STRIP, { bodyAttrs: "data-next-sdk-loading=\"true\"" }),
  i36: htmlPage(`${ATC("color:#ffffff;background:#111111", "Add", " hidden")}${STRIP}`),
  i47: htmlPage(ATC("color:#ffffff;background:#111111", "", " class=\"generated\""), { head: "<style>.generated::before{content:\"Add\"}</style>" }),
  i50: htmlPage(`<p style="${P};font-family:Stalled,sans-serif;color:#ffffff;background:#111111">Webfont text</p>`, { head: `<style>@font-face{font-family:Stalled;src:url(${routeOf("i50")}stalled.woff2) format("woff2")}</style>` }),
  i52: htmlPage("<div style=\"width:120px;height:60px;background:#eeeeee\"></div>"),
  i53: htmlPage(`<div class="layer" style="padding:8px;background:#333333"><span data-next-action="add-to-cart" style="color:#ffffff">Add to cart</span></div>`, { head: "<style>.layer::before{content:\"\";display:block;height:4px;background:#000}</style>" }),
  i54: htmlPage(ATC("font-size:24px;color:#ffffff;background-color:#e0662b;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent")),
  i55: htmlPage(`<a href="" aria-disabled="true" style="display:inline-block;${P};color:#bbbbbb;background:#eeeeee">Unavailable link</a>`),
  "upsell-accept": htmlPage(`<button data-next-upsell-action="accept" type="button" style="${BTN};color:#ffffff;background:#111111">Yes, add it</button>`),
  "upsell-decline": htmlPage(`<button data-next-upsell-action="decline" type="button" style="${BTN};color:#ffffff;background:#111111">No thanks</button>`),
  "upsell-unknown": htmlPage(`<button data-next-upsell-action="maybe" type="button" style="${BTN};color:#ffffff;background:#111111">Maybe later</button>`),
});

let sharedSite = null;
const shared = (() => {
  let pending = null;
  return () => {
    pending ||= (async () => {
      sharedSite = await readabilitySite({
        pages: SHARED,
        assets: { [`${routeOf("i50")}stalled.woff2`]: stall() },
        otherAssets: {
          "/vendor/analytics.js": connectionReset(),
          "/field/": respond("200 OK", "text/html; charset=utf-8", htmlPage("<label>Card number <input placeholder=\"Card number\"></label>")),
        },
      });
      return { site: sharedSite, capture: await capturePolish(sharedSite) };
    })();
    return pending;
  };
})();
after(async () => {
  await sharedSite?.close();
});

// The shared capture's record, after its setup checks.
async function sharedRecord() {
  const { site, capture } = await shared();
  assertCaptureCompleted(capture);
  return { site, record: readabilityRecord(capture.report) };
}

// The shared capture's readability.contrast rows, after its setup checks.
async function sharedRows() {
  const { site } = await sharedRecord();
  const rows = await readabilityRows(site);
  assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
  return rows;
}

const isPair = (key) => key.startsWith("pair:");
const PAIR_SHAPE = /^pair:[0-9a-f]{8}\/[0-9a-f]{8}:(normal|large)$/;
const warningRows = (rows) => rows.map(({ viewport, key, result }) => ({ viewport, key, result }));
const keyed = (key) => (candidate) => candidate === key;

// A pass or warning row: the page's pair rows, exactly one per viewport.
async function assertPair(name, key, result) {
  const rows = pageRows(await sharedRows(), name, isPair);
  if (result === "warning") assert.deepEqual(warningRows(rows), warningRows(both({ key, result })), `${routeOf(name)}: ${key} reads warning in both viewports`);
  else assert.deepEqual(rows, both({ key, result, reason_code: null }), `${routeOf(name)}: ${key} reads ${result} in both viewports`);
}

// A pass or warning row whose colours are composited or non-8-bit: the key
// is checked for its shape and size class only.
async function assertPairShape(name, sizeClass, result) {
  const rows = pageRows(await sharedRows(), name, isPair);
  assert.deepEqual(
    rows.map((row) => ({ viewport: row.viewport, shape: PAIR_SHAPE.test(row.key) && row.key.endsWith(`:${sizeClass}`), result: row.result, ...(result === "pass" ? { reason_code: row.reason_code } : {}) })),
    VIEWPORTS.map((viewport) => ({ viewport, shape: true, result, ...(result === "pass" ? { reason_code: null } : {}) })),
    `${routeOf(name)}: one ${sizeClass} pair row per viewport, reading ${result}`,
  );
}

// A keyed row (review, coverage, gap, inactive_control, cell) in both
// viewports, exactly.
async function assertKeyed(name, key, result, reasonCode) {
  const rows = pageRows(await sharedRows(), name, keyed(key));
  assert.deepEqual(rows, both({ key, result, reason_code: reasonCode }), `${routeOf(name)}: ${key} reads ${result} / ${reasonCode} in both viewports`);
}

// The states of every element the page's cells hold.
async function memberStates(name) {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, name);
  for (const viewport of VIEWPORTS) assert.ok(cells[viewport].elements?.length > 0, `setup (${viewport}): the cell measured the page's text`);
  return VIEWPORTS.map((viewport) => [...new Set(cells[viewport].elements.map((element) => element.state))].sort());
}

// ---------------------------------------------------------------------------
// Working rows

browserTest("F2.4-W3 [data-next-action=\"add-to-cart\"] label 14pt bold (serializes 18.6667px/700), #fff on #e0662b (3.44): pass", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "w3");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => [element.font_size_px, element.font_weight]), [[18.6667, 700]], `setup (${viewport}): Chromium serializes 14pt bold as 18.6667px/700`);
  }
  await assertPair("w3", "pair:ffffffff/e0662bff:large", "pass");
});

browserTest("F2.4-W4 24px/400 at 3.44: pass", async () => {
  await assertPair("w4", "pair:ffffffff/e0662bff:large", "pass");
});

browserTest("F2.4-W6 bundle card, Tailwind oklch(0.21 0.034 264.665) on oklch(0.828 0.189 84.429): pass", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "w6");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => [element.fg_raw, element.bg_layers_raw?.[0]]), [["oklch(0.21 0.034 264.665)", "oklch(0.828 0.189 84.429)"]], `setup (${viewport}): the oklch() pair is what Chromium reports`);
  }
  await assertPairShape("w6", "normal", "pass");
});

browserTest("F2.4-W7 _site/demo/{landing,checkout,upsell,receipt}; landing mapped, others stock: readability cell count = 8", async () => {
  const site = await readabilitySite({ pages: { checkout: htmlPage(STRIP), upsell: htmlPage(STRIP), receipt: htmlPage(STRIP) } });
  try {
    assert.deepEqual(site.names.sort(), ["checkout", "landing", "receipt", "upsell"], "setup: the built site is the four pages");
    const capture = await capturePolish(site);
    assertCaptureCompleted(capture);
    assert.deepEqual(capture.result.capture.routes, [routeOf("landing")], "setup: page_load plans the mapped landing page only");
    const record = readabilityRecord(capture.report);
    assert.equal(record.cells.length, 8, "readability cell count = 8");
  } finally {
    await site.close();
  }
});

browserTest("F2.4-W8 stock checkout loading a failing cross-origin script that is a non-SDK vendor script: that cell's cell_status = measured", async () => {
  const { site, record } = await sharedRecord();
  const cells = cellsOf(record, "w8-checkout");
  assert.ok(site.other.log.some((entry) => entry.target === "/vendor/analytics.js"), "setup: the page requested the cross-origin vendor script (the connection is reset)");
  assert.deepEqual(VIEWPORTS.map((viewport) => cells[viewport].cell_status), ["measured", "measured"], "the checkout cell's cell_status = measured");
});

browserTest("F2.4-W9 bold text with font-size calc(1rem + 0.5vw), 23.2px at 1440 and 17.95px at 390: mobile row size_class = normal", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "w9");
  assert.deepEqual(cells.desktop.elements.map((element) => [element.font_size_px, element.font_weight]), [[23.2, 700]], "setup: 23.2px bold at 1440");
  assert.deepEqual(cells.mobile.elements.map((element) => [element.font_size_px, element.font_weight]), [[17.95, 700]], "setup: 17.95px bold at 390");
  assert.deepEqual(cells.mobile.elements.map((element) => element.size_class), ["normal"], "mobile size_class = normal");
  const rows = pageRows(await sharedRows(), "w9", isPair).filter((row) => row.viewport === "mobile");
  assert.deepEqual(rows.map((row) => row.key.split(":").at(-1)), ["normal"], "the mobile row is keyed :normal");
});

browserTest("F2.4-W18 text inside <details open>, #fff on #767676: member state = expanded", async () => {
  assert.deepEqual(await memberStates("w18"), [["expanded"], ["expanded"]], "member state = expanded");
});

browserTest("F2.4-W19 <textarea readonly> text #fff on #767676: pass", async () => {
  const rows = pageRows(await sharedRows(), "w19");
  assert.deepEqual(rows, both({ key: "pair:ffffffff/767676ff:normal", result: "pass", reason_code: null }), "the readonly textarea is measured and passes; no inactive_control row");
});

browserTest("F2.4-W20 all-stock _site with three routes (every mapping skip_reason); polish capture: readability cell count = 6", async () => {
  const site = await readabilitySite({ pages: { first: htmlPage(STRIP), second: htmlPage(STRIP), third: htmlPage(STRIP) }, mapped: [] });
  try {
    const capture = await capturePolish(site);
    assert.equal(capture.error, null, `polish capture completes on an all-stock campaign (refused: ${capture.error?.message})`);
    const record = readabilityRecord(capture.report);
    assert.equal(record.cells.length, 6, "readability cell count = 6");
  } finally {
    await site.close();
  }
});

browserTest("F2.4-W21 <input type=\"submit\" value=\"Buy\"> #fff on #767676: measured element role = submit_control", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "w21");
  assert.deepEqual(VIEWPORTS.map((viewport) => cells[viewport].elements.map((element) => [element.role, element.review_reason, typeof element.ratio])), [[["submit_control", null, "number"]], [["submit_control", null, "number"]]], "the submit input is measured with role submit_control");
});

browserTest("[data-next-upsell-action=\"accept\"] and \"decline\" (the SDK's spellings of add and skip): measured element role = upsell_accept / upsell_decline; another value is body_text", async () => {
  const { record } = await sharedRecord();
  const roles = (name) => {
    const cells = cellsOf(record, name);
    return VIEWPORTS.map((viewport) => cells[viewport].elements.map((element) => element.role));
  };
  assert.deepEqual(roles("upsell-accept"), [["upsell_accept"], ["upsell_accept"]], "the accept control is measured with role upsell_accept");
  assert.deepEqual(roles("upsell-decline"), [["upsell_decline"], ["upsell_decline"]], "the decline control is measured with role upsell_decline");
  assert.deepEqual(roles("upsell-unknown"), [["body_text"], ["body_text"]], "a control with another upsell action value is not an upsell role");
});

browserTest("F2.4-W22 bump text inside .next-active, #fff on #333: member state = active", async () => {
  assert.deepEqual(await memberStates("w22"), [["active"], ["active"]], "member state = active");
});

browserTest("F2.4-W23 as W20 (all-stock _site, three routes); polish capture: exit code 0", async () => {
  const site = await readabilitySite({ pages: { first: htmlPage(STRIP), second: htmlPage(STRIP), third: htmlPage(STRIP) }, mapped: [] });
  try {
    // The installed CLI itself, so the exit code is the one an operator
    // sees. Run asynchronously: the stub origin serves from this process.
    // Telemetry remit is off (the repo's own opt-out, inherited from the
    // no-network guard's environment); the pages reach nothing but loopback.
    const res = await new Promise((done) => {
      execFile(process.execPath, [CLI, "polish", "capture", "--packet", site.f.packetPath, "--base-url", `${site.same.origin}/`, "--json"], { env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" }, timeout: 300_000 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
    });
    assert.equal(res.code, 0, `exit code 0 (${String(res.stderr).slice(0, 300) || String(res.stdout).slice(0, 300)})`);
  } finally {
    await site.close();
  }
});

// ---------------------------------------------------------------------------
// Broken rows

browserTest("F2.4-B1 16px/400 #ffffff on #0080aa (4.4986): warning", async () => {
  await assertPair("b1", "pair:ffffffff/0080aaff:normal", "warning");
});

browserTest("F2.4-B2 16px/400 at 3.0: warning", async () => {
  await assertPair("b2", "pair:ffffffff/949494ff:normal", "warning");
});

browserTest("F2.4-B3 18.6667px/600 at 3.44: warning", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "b3");
  for (const viewport of VIEWPORTS) assert.deepEqual(cells[viewport].elements.map((element) => [element.font_size_px, element.font_weight]), [[18.6667, 600]], `setup (${viewport}): 18.6667px/600`);
  await assertPair("b3", "pair:ffffffff/e0662bff:normal", "warning");
});

browserTest("F2.4-B5 purchase label #eeeeee on #ffffff: warning", async () => {
  await assertPair("b5", "pair:eeeeeeff/ffffffff:normal", "warning");
});

browserTest("F2.4-B6 card [data-next-selected=\"true\"] text #222 on #333: warning", async () => {
  await assertPair("b6", "pair:222222ff/333333ff:normal", "warning");
});

browserTest("F2.4-B7 <a style=\"color:#fff;background:#111\"><span style=\"color:#222\">x</span></a>: span row warning", async () => {
  await assertPair("b7", "pair:222222ff/111111ff:normal", "warning");
});

browserTest("F2.4-B8 white text on rgba(0,0,0,0.5) over white: warning", async () => {
  await assertPairShape("b8", "normal", "warning");
});

browserTest("F2.4-B9 rgba(255,255,255,0.3) text on #000: warning", async () => {
  await assertPairShape("b9", "normal", "warning");
});

browserTest("F2.4-B30 as B6: member state = selected", async () => {
  assert.deepEqual(await memberStates("b6"), [["selected"], ["selected"]], "member state = selected");
});

// Recapture rows: an accepted pair; the page's markup changes; `record
// build` records the rebuilt output; a second real `polish capture` measures
// the rebuilt page. Each row has its own site whose one stock page, `offer`,
// holds one 16px/400 warning pair, accepted at both widths by one
// `checkpoint accept` naming the handoff's refs.
const OFFER = (style) => htmlPage(`<p style="margin:0;padding:8px;font-weight:400;${style}">Synthetic offer text</p>`);
const lower = (key) => (String(key).startsWith("pair:") ? String(key).toLowerCase() : key);

async function acceptedPair(style) {
  const site = await readabilitySite({ pages: { offer: OFFER(style) } });
  try {
    const capture = await capturePolish(site);
    assertCaptureCompleted(capture);
    const record = readabilityRecord(capture.report);
    const groups = (handoffOf(await runNext(site.f)).open || []).filter((entry) => entry.check === CHECK);
    assert.equal(groups.length, 1, `setup: the handoff lists the warning pair once (${JSON.stringify(groups.map((group) => group.key))})`);
    const refs = (groups[0].results || [groups[0]]).map((entry) => entry.result_ref);
    assert.deepEqual(groups[0].pages, [routeOf("offer")], "setup: the pair is open on the offer page");
    assert.equal(refs.length, 2, "setup: the pair is open at both widths");
    assertAccepted(await runAccept(site.f, refs));
    assert.equal((readJson(site.f.reportPath).qc_accepts || []).length, 2, "setup: checkpoint accept wrote one record per ref");
    return { site, build: record.subject?.build_fingerprint, key: lower(groups[0].key), cells: cellsOf(record, "offer") };
  } catch (error) {
    await site.close();
    throw error;
  }
}

// The page rewritten with `style`, `record build`, and the recapture, whose
// record must be bound to the rebuilt output.
async function rebuildAndRecapture(fixture, style) {
  const build = await rebuildPages(fixture.site, { offer: OFFER(style) });
  assert.notEqual(build, fixture.build, "setup: the rebuild recorded a new build fingerprint");
  const capture = await capturePolish(fixture.site);
  assertCaptureCompleted(capture);
  const record = readabilityRecord(capture.report);
  assert.equal(record.subject?.build_fingerprint, build, "setup: the recapture's record is bound to the rebuilt output");
  return cellsOf(record, "offer");
}

// The offer page's pair rows after the recapture: `key` reads warning at both
// widths.
async function assertRecapturedPair(site, key) {
  const rows = pageRows(await readabilityRows(site), "offer", isPair);
  assert.deepEqual(warningRows(rows), warningRows(both({ key, result: "warning" })), `setup: the recapture's ${key} reads warning at both widths`);
}

// The accepts as every reader assesses them against the current results.
async function assessedAccepts(site) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const accepts = readJson(site.f.reportPath).qc_accepts || [];
  assert.equal(accepts.length, 2, "setup (not the row's assertion): the report holds the two accept records");
  return assessQcAccepts(accepts, await readabilityRows(site));
}

browserTest("F2.4-B11 accepted pair; change the foreground colour; rebuild and recapture: old accept assessment = orphaned", async () => {
  const fixture = await acceptedPair("font-size:16px;color:#ffffff;background:#0080aa");
  try {
    assert.equal(fixture.key, "pair:ffffffff/0080aaff:normal", "setup: the accepted pair is #ffffff on #0080aa");
    await rebuildAndRecapture(fixture, "font-size:16px;color:#f0f0f0;background:#0080aa");
    await assertRecapturedPair(fixture.site, "pair:f0f0f0ff/0080aaff:normal");
    const assessed = await assessedAccepts(fixture.site);
    assert.deepEqual(assessed.map(({ status, why }) => ({ status, why })), [{ status: "orphaned", why: "no_current_result" }, { status: "orphaned", why: "no_current_result" }], "old accept assessment = orphaned");
  } finally {
    await fixture.site.close();
  }
});

browserTest("F2.4-B27 accepted pair; one member's font size changed from 16px to 17px (same colours, same size class); rebuild and recapture: old accept assessment = lapsed", async () => {
  const fixture = await acceptedPair("font-size:16px;color:#ffffff;background:#0080aa");
  try {
    assert.deepEqual(VIEWPORTS.map((viewport) => fixture.cells[viewport].elements.map((element) => element.font_size_px)), [[16], [16]], "setup: the accepted member is 16px");
    const cells = await rebuildAndRecapture(fixture, "font-size:17px;color:#ffffff;background:#0080aa");
    assert.deepEqual(VIEWPORTS.map((viewport) => cells[viewport].elements.map((element) => element.font_size_px)), [[17], [17]], "setup: the recapture measured the 17px member");
    await assertRecapturedPair(fixture.site, fixture.key);
    const assessed = await assessedAccepts(fixture.site);
    assert.deepEqual(assessed.map((entry) => entry.status), ["lapsed", "lapsed"], "old accept assessment = lapsed");
  } finally {
    await fixture.site.close();
  }
});

browserTest("F2.4-B28 accepted pair; change the background colour; rebuild and recapture: old accept assessment = orphaned", async () => {
  const fixture = await acceptedPair("font-size:16px;color:#ffffff;background:#0080aa");
  try {
    assert.equal(fixture.key, "pair:ffffffff/0080aaff:normal", "setup: the accepted pair is #ffffff on #0080aa");
    await rebuildAndRecapture(fixture, "font-size:16px;color:#ffffff;background:#0088b4");
    await assertRecapturedPair(fixture.site, "pair:ffffffff/0088b4ff:normal");
    const assessed = await assessedAccepts(fixture.site);
    assert.deepEqual(assessed.map(({ status, why }) => ({ status, why })), [{ status: "orphaned", why: "no_current_result" }, { status: "orphaned", why: "no_current_result" }], "old accept assessment = orphaned");
  } finally {
    await fixture.site.close();
  }
});

browserTest("F2.4-B29 accepted pair; foreground changed by oklch L +0.0001 so the 8-digit hex is equal and the exact ratio differs; rebuild and recapture: old accept assessment = lapsed", async () => {
  const fixture = await acceptedPair("font-size:16px;color:oklch(0.62 0.1 250);background:#ffffff");
  try {
    const measured = (cells) => VIEWPORTS.map((viewport) => cells[viewport].elements.map((element) => [element.fg_raw, element.ratio]));
    const before = measured(fixture.cells);
    assert.deepEqual(before.map((cell) => cell.map(([fg]) => fg)), [["oklch(0.62 0.1 250)"], ["oklch(0.62 0.1 250)"]], "setup: the accepted foreground is oklch(0.62 0.1 250)");
    const after = measured(await rebuildAndRecapture(fixture, "font-size:16px;color:oklch(0.6201 0.1 250);background:#ffffff"));
    assert.deepEqual(after.map((cell) => cell.map(([fg]) => fg)), [["oklch(0.6201 0.1 250)"], ["oklch(0.6201 0.1 250)"]], "setup: the recapture measured oklch(0.6201 0.1 250)");
    await assertRecapturedPair(fixture.site, fixture.key);
    assert.deepEqual(after.map((cell, at) => cell[0][1] !== before[at][0][1]), [true, true], `setup: the exact ratio differs (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
    const assessed = await assessedAccepts(fixture.site);
    assert.deepEqual(assessed.map((entry) => entry.status), ["lapsed", "lapsed"], "old accept assessment = lapsed");
  } finally {
    await fixture.site.close();
  }
});

browserTest("F2.4-B31 as B11 (accepted pair; foreground changed; rebuild and recapture): the new pair row is in qc_handoff.open: true", async () => {
  const fixture = await acceptedPair("font-size:16px;color:#ffffff;background:#0080aa");
  try {
    await rebuildAndRecapture(fixture, "font-size:16px;color:#f0f0f0;background:#0080aa");
    const keys = (handoffOf(await runNext(fixture.site.f)).open || []).filter((entry) => entry.check === CHECK).map((entry) => lower(entry.key));
    assert.equal(keys.includes("pair:f0f0f0ff/0080aaff:normal"), true, `the new pair row is in qc_handoff.open: ${JSON.stringify(keys)}`);
  } finally {
    await fixture.site.close();
  }
});

// ---------------------------------------------------------------------------
// Incomplete rows

browserTest("F2.4-I1 text in a [data-next-action=\"add-to-cart\"] label over linear-gradient(...): review / background_gradient", async () => {
  await assertKeyed("i1", "review:add_to_cart:background_gradient", "review", "background_gradient");
});

browserTest("F2.4-I2 text in a [data-next-action=\"add-to-cart\"] label over background-image:url(data:…): review / background_image", async () => {
  await assertKeyed("i2", "review:add_to_cart:background_image", "review", "background_image");
});

browserTest("F2.4-I3 [data-next-action=\"add-to-cart\"] label, #fff on #111, with opacity:0.3: review / opacity", async () => {
  await assertKeyed("i3", "review:add_to_cart:opacity", "review", "opacity");
});

browserTest("F2.4-I4 white text in a [data-next-action=\"add-to-cart\"] label over an absolutely positioned sibling <img>: review / overlapping_layer", async () => {
  await assertKeyed("i4", "review:add_to_cart:overlapping_layer", "review", "overlapping_layer");
});

// B4(b) amendment: disabled controls read excluded / inactive_control.
browserTest("F2.4-I7 <button disabled> #bbb on #eee: inactive_control row excluded / inactive_control", async () => {
  await assertKeyed("i7", "inactive_control", "excluded", "inactive_control");
});

browserTest("F2.4-I8 empty [data-next-display=\"package.price\"] (no SDK; no text, zero-size box): role coverage row unexercised / text_not_rendered", async () => {
  await assertKeyed("i8", "role:price:coverage", "unexercised", "text_not_rendered");
});

browserTest("F2.4-I9 a link[rel=stylesheet] that 404s: cell row unexercised / styles_incomplete", async () => {
  await assertKeyed("i9", "cell", "unexercised", "styles_incomplete");
});

browserTest("F2.4-I10 page with 2500 text-bearing elements, probe writes capped: true: every row of that cell has member page_coverage (element_cap_reached): true", async () => {
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "i10");
  assert.deepEqual(VIEWPORTS.map((viewport) => cells[viewport].capped), [true, true], "setup: the probe writes capped: true");
  const rows = (await sharedRows()).filter((row) => row?.subject?.page === routeOf("i10"));
  assert.ok(rows.length > 0, "setup (not the row's assertion): the capped cells list rows");
  const capMember = (row) => (row.members || []).some((member) => member?.key === "page_coverage" && member.result === "unexercised" && member.reason_code === "element_cap_reached");
  assert.deepEqual(rows.map((row) => [row.id, capMember(row)]), rows.map((row) => [row.id, true]), "every row of the cell has the page_coverage member");
});

browserTest("F2.4-I15 bundle group with no selected card at load: role coverage row unexercised / state_not_observed", async () => {
  await assertKeyed("i15", "role:bundle_card:coverage", "unexercised", "state_not_observed");
});

browserTest("F2.4-I16 root color-scheme: dark, transparent backgrounds; text in a [data-next-action=\"add-to-cart\"] label: review / canvas_unknown", async () => {
  await assertKeyed("i16", "review:add_to_cart:canvas_unknown", "review", "canvas_unknown");
});

browserTest("F2.4-I21 accordion button aria-expanded=\"false\" controlling a text panel: state:expanded:coverage row unexercised / state_not_observed", async () => {
  await assertKeyed("i21", "state:expanded:coverage", "unexercised", "state_not_observed");
});

browserTest("F2.4-I22 closed shadow root with text: gap row unexercised / closed_shadow_root", async () => {
  await assertKeyed("i22", "gap:closed_shadow_root", "unexercised", "closed_shadow_root");
});

browserTest("F2.4-I23 visible cross-origin iframe hosting a field: gap row unexercised / cross_origin_text", async () => {
  await assertKeyed("i23", "gap:cross_origin_text", "unexercised", "cross_origin_text");
});

browserTest("F2.4-I24 [data-next-action=\"add-to-cart\"] label marked only by class next-disabled, #bbb on #eee: review / disabled_state_uncertain", async () => {
  await assertKeyed("i24", "review:add_to_cart:disabled_state_uncertain", "review", "disabled_state_uncertain");
});

browserTest("F2.4-I29 [data-next-action=\"add-to-cart\"] with data-next-loading=\"true\": role coverage row unexercised / control_loading", async () => {
  await assertKeyed("i29", "role:add_to_cart:coverage", "unexercised", "control_loading");
});

browserTest("F2.4-I31 <div style=\"opacity:.3\"><div style=\"background:#111\"><span data-next-action=\"add-to-cart\" style=\"color:#fff\">x</span></div></div>: review / opacity", async () => {
  await assertKeyed("i31", "review:add_to_cart:opacity", "review", "opacity");
});

browserTest("F2.4-I32 as I31 with filter:grayscale(1) on the outer div instead of opacity: review / filter", async () => {
  await assertKeyed("i32", "review:add_to_cart:filter", "review", "filter");
});

browserTest("F2.4-I33 as I31 with mix-blend-mode:multiply on the outer div instead of opacity: review / blend_mode", async () => {
  await assertKeyed("i33", "review:add_to_cart:blend_mode", "review", "blend_mode");
});

browserTest("F2.4-I34 as I31 with mask-image:linear-gradient(#000,transparent) on the outer div instead of opacity: review / mask", async () => {
  await assertKeyed("i34", "review:add_to_cart:mask", "review", "mask");
});

browserTest("F2.4-I35 <body data-next-sdk-loading=\"true\"> at probe time: cell row unexercised / sdk_not_ready", async () => {
  await assertKeyed("i35", "cell", "unexercised", "sdk_not_ready");
});

browserTest("F2.4-I36 [data-next-action=\"add-to-cart\"] with the text Add and the hidden attribute: role coverage row unexercised / not_visible_at_load", async () => {
  await assertKeyed("i36", "role:add_to_cart:coverage", "unexercised", "not_visible_at_load");
});

browserTest("F2.4-I47 [data-next-action=\"add-to-cart\"] whose only text is ::before { content: \"Add\" }: role coverage row unexercised / generated_text", async () => {
  await assertKeyed("i47", "role:add_to_cart:coverage", "unexercised", "generated_text");
});

// The probe reads in an isolated world, so no page script can see it start.
// The probe clock stands in (the F1.3-I13 pattern): each time the probe
// waits on it, the page under capture navigates in its own world, and the
// clock never returns, so the probe waits behind the page's busy loop while
// the navigation commits.
const busyAfterLoad = (ms) => `<script>addEventListener("load", () => setTimeout(() => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { const end = performance.now() + ${ms}; while (performance.now() < end) {} channel.port2.postMessage(null); };
  channel.port2.postMessage(null);
}, 0));</script>`;

browserTest("F2.4-I49 page that navigates to a new document during the probe: cell row unexercised / document_changed", async () => {
  const elsewhere = routeOf("i49-elsewhere");
  const site = await readabilitySite({ pages: { i49: htmlPage(STRIP, { head: busyAfterLoad(400) }) }, assets: { [elsewhere]: respond("200 OK", "text/html; charset=utf-8", htmlPage("<p>Synthetic navigation target</p>")) } });
  try {
    let browser = null;
    const probeClock = {
      now: () => 0,
      sleep: () => {
        browser?.contexts().at(-1)?.pages()[0]?.evaluate((target) => location.assign(target), elsewhere).catch(() => {});
        return new Promise(() => {});
      },
    };
    const capture = await capturePolish(site, { probeClock, onLaunch: (launched) => { browser = launched; } });
    assertCaptureCompleted(capture);
    readabilityRecord(capture.report);
    const rows = pageRows(await readabilityRows(site), "i49", keyed("cell"));
    assert.deepEqual(rows, both({ key: "cell", result: "unexercised", reason_code: "document_changed" }), "cell rows read unexercised / document_changed in both viewports");
  } finally {
    await site.close();
  }
});

browserTest("F2.4-I50 page whose webfont request stalls: cell row unexercised / fonts_pending", async () => {
  await assertKeyed("i50", "cell", "unexercised", "fonts_pending");
});

browserTest("F2.4-I52 measured page with no text-bearing elements: cell row unexercised / no_text_measured", async () => {
  await assertKeyed("i52", "cell", "unexercised", "no_text_measured");
});

browserTest("F2.4-I53 <span data-next-action=\"add-to-cart\"> text inside a container that has ::before{content:\"\";background:#000}: review / pseudo_element_background", async () => {
  await assertKeyed("i53", "review:add_to_cart:pseudo_element_background", "review", "pseudo_element_background");
});

browserTest("F2.4-I54 text in a [data-next-action=\"add-to-cart\"] label with background-clip:text and -webkit-text-fill-color:transparent: review / text_fill_background", async () => {
  await assertKeyed("i54", "review:add_to_cart:text_fill_background", "review", "text_fill_background");
});

// B4(b) amendment: disabled controls read excluded / inactive_control.
browserTest("F2.4-I55 <a href aria-disabled=\"true\"> #bbb on #eee: inactive_control row excluded / inactive_control", async () => {
  await assertKeyed("i55", "inactive_control", "excluded", "inactive_control");
});

browserTest("F2.4-I67 as I1: the review / background_gradient row's crop_ref is non-null: true", async () => {
  await assertKeyed("i1", "review:add_to_cart:background_gradient", "review", "background_gradient");
  const { record } = await sharedRecord();
  const cells = cellsOf(record, "i1");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => element.review_reason), ["background_gradient"], `setup (${viewport}): the row's one member is the gradient label`);
  }
  assert.deepEqual(VIEWPORTS.map((viewport) => { const ref = cells[viewport].elements[0].crop_ref; return ref !== null && typeof ref === "object"; }), [true, true], "the review row's crop_ref is non-null");
});

// Card test (not a frozen row): the record never holds the text it measured.
// Every page of the shared capture carries known text (element text, a submit
// input's value, a readonly textarea, CSS generated text, closed shadow root
// and cross-origin frame text); none of it appears anywhere in the record.
browserTest("the readability record persists no text content of the pages it measured", async () => {
  const { record } = await sharedRecord();
  assert.ok(record.cells.some((cell) => cell.elements.length > 0), "setup: the record holds measured elements");
  const serialized = JSON.stringify(record);
  const texts = ["Synthetic text", "Large text", "Bundle of three", "Checkout", "Bold heading", "More", "Panel text", "Readonly note", "Buy", "Add the bump", "Normal text", "Semibold text", "Selected bundle", "Translucent panel", "Faint text", "Unavailable", "Line 1", "Bundle A", "Show details", "Shadow text", "Card number", "Add", "Webfont text"];
  assert.deepEqual(texts.filter((text) => serialized.includes(text)), [], "no page text appears in the record");
});

// ---------------------------------------------------------------------------
// Text in open shadow roots and same-origin frames is measured: each page
// is a readability-only cell of one capture of its own.

const OPEN = (inner) => `<template shadowrootmode="open">${inner}</template>`;
const FRAME = (inner) => `<iframe title="Synthetic frame" srcdoc="<!doctype html><body style='margin:0'>${inner}</body>" style="width:320px;height:120px;border:0"></iframe>`;
const NESTED_PAGES = {
  "shadow-warning": htmlPage(`<div>${OPEN(`<p style="${P};color:#ffffff;background:#949494">Shadow warning text</p>`)}</div>`),
  "frame-warning": htmlPage(FRAME("<p style='margin:0;padding:8px;font-size:16px;font-weight:400;color:#ffffff;background:#949494'>Frame warning text</p>")),
  "shadow-pass": htmlPage(`<div>${OPEN(`<p style="${P};color:#ffffff;background:#111111">Shadow passing text</p>`)}</div>`),
  "frame-pass": htmlPage(FRAME("<p style='margin:0;padding:8px;font-size:16px;font-weight:400;color:#ffffff;background:#111111'>Frame passing text</p>")),
  "shadow-nested": htmlPage(`<section style="background:#0080aa">${OPEN(`<div>${OPEN(`<p style="${P};color:#ffffff">Nested shadow text</p>`)}</div>`)}</section>`),
  "shadow-translucent": htmlPage(`<div data-next-action="add-to-cart" style="background:#111111;color:#ffffff;opacity:0.3">${OPEN(`<span style="${BTN}">Translucent host text</span>`)}</div>`),
  "frame-closed": htmlPage(`${FRAME("<div><template shadowrootmode='closed'><p>Closed frame text</p></template></div>")}${STRIP}`),
};

const nestedCapture = (() => {
  let pending = null;
  let site = null;
  after(async () => {
    await site?.close();
  });
  return () => {
    pending ||= (async () => {
      site = await readabilitySite({ pages: NESTED_PAGES });
      const capture = await capturePolish(site);
      assertCaptureCompleted(capture);
      const record = readabilityRecord(capture.report);
      const rows = await readabilityRows(site);
      assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
      return { site, record, rows };
    })();
    return pending;
  };
})();

async function assertNestedPair(name, key, result) {
  const { rows } = await nestedCapture();
  const found = pageRows(rows, name, isPair);
  if (result === "warning") assert.deepEqual(warningRows(found), warningRows(both({ key, result })), `${routeOf(name)}: ${key} reads warning in both viewports`);
  else assert.deepEqual(found, both({ key, result, reason_code: null }), `${routeOf(name)}: ${key} reads ${result} in both viewports`);
}

browserTest("low-contrast text in an open shadow root reads warning", async () => {
  await assertNestedPair("shadow-warning", "pair:ffffffff/949494ff:normal", "warning");
});

browserTest("low-contrast text in a same-origin iframe reads warning, measured with the frame's window, and its crop is taken", async () => {
  await assertNestedPair("frame-warning", "pair:ffffffff/949494ff:normal", "warning");
  const { record } = await nestedCapture();
  const cells = cellsOf(record, "frame-warning");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => element.selector_path), ["html>body>iframe:nth-of-type(1)>>>html>body>p:nth-of-type(1)"], `${viewport}: the frame's text, named through its frame`);
    assert.equal(cells[viewport].elements[0].crop_ref !== null, true, `${viewport}: the warning's crop is taken`);
  }
});

browserTest("passing text in an open shadow root and in a same-origin iframe reads pass", async () => {
  await assertNestedPair("shadow-pass", "pair:ffffffff/111111ff:normal", "pass");
  await assertNestedPair("frame-pass", "pair:ffffffff/111111ff:normal", "pass");
});

browserTest("text in a nested open shadow root is measured over the outer host's background", async () => {
  await assertNestedPair("shadow-nested", "pair:ffffffff/0080aaff:normal", "warning");
});

browserTest("text in an open shadow root under a translucent add-to-cart host reads review / opacity, and the host's role text is not listed as unrendered", async () => {
  const { rows } = await nestedCapture();
  assert.deepEqual(pageRows(rows, "shadow-translucent", (key) => key.startsWith("review:") || key.startsWith("role:")), both({ key: "review:add_to_cart:opacity", result: "review", reason_code: "opacity" }));
});

browserTest("a closed shadow root inside a same-origin iframe: gap row unexercised / closed_shadow_root", async () => {
  const { rows } = await nestedCapture();
  assert.deepEqual(pageRows(rows, "frame-closed", keyed("gap:closed_shadow_root")), both({ key: "gap:closed_shadow_root", result: "unexercised", reason_code: "closed_shadow_root" }));
});

browserTest("the record persists no text from open shadow roots or same-origin frames", async () => {
  const { record } = await nestedCapture();
  for (const name of Object.keys(NESTED_PAGES)) {
    const cells = cellsOf(record, name);
    for (const viewport of VIEWPORTS) assert.ok(cells[viewport].elements.length > 0, `setup (${routeOf(name)}, ${viewport}): the cell measured the page's text`);
  }
  const serialized = JSON.stringify(record);
  const texts = ["Shadow warning text", "Frame warning text", "Shadow passing text", "Frame passing text", "Nested shadow text", "Translucent host text", "Closed frame text"];
  assert.deepEqual(texts.filter((text) => serialized.includes(text)), []);
});

// ---------------------------------------------------------------------------
// Cell measurability covers every tree the probe measures: a stylesheet that
// has not loaded inside an open shadow root, or inside an open shadow root of
// a same-origin frame, makes the cell read styles_incomplete, never measured.

const READINESS_PAGES = {
  // A script attaches the root after parsing starts, so its stalled
  // stylesheet never holds back DOMContentLoaded: the link's sheet stays null.
  "shadow-styles-pending": htmlPage(`<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<link rel="stylesheet" href="${routeOf("shadow-styles-pending")}stalled.css"><p style="${P};color:#ffffff;background:#111111">Pending shadow text</p>';</script>`),
  "shadow-import-missing": htmlPage(`<div>${OPEN(`<style>@import url(${routeOf("shadow-import-missing")}missing.css);</style><p style="${P};color:#ffffff;background:#111111">Import shadow text</p>`)}</div>`),
  "frame-shadow-styles-missing": htmlPage(FRAME(`<div><template shadowrootmode='open'><link rel='stylesheet' href='${routeOf("frame-shadow-styles-missing")}missing.css'><p style='margin:0;padding:8px;color:#ffffff;background:#111111'>Frame shadow text</p></template></div>`)),
  "shadow-styles-loaded": htmlPage(`<div>${OPEN(`<link rel="stylesheet" href="${routeOf("shadow-styles-loaded")}loaded.css"><p style="${P};color:#ffffff;background:#111111">Loaded shadow text</p>`)}</div>`),
};

const readinessCapture = (() => {
  let pending = null;
  let site = null;
  after(async () => {
    await site?.close();
  });
  return () => {
    pending ||= (async () => {
      site = await readabilitySite({
        pages: READINESS_PAGES,
        assets: {
          [`${routeOf("shadow-styles-pending")}stalled.css`]: stall(),
          [`${routeOf("shadow-styles-loaded")}loaded.css`]: respond("200 OK", "text/css; charset=utf-8", "p{letter-spacing:0}"),
        },
      });
      const capture = await capturePolish(site);
      assertCaptureCompleted(capture);
      const record = readabilityRecord(capture.report);
      const rows = await readabilityRows(site);
      assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
      return { site, record, rows };
    })();
    return pending;
  };
})();

browserTest("a stylesheet still loading inside an open shadow root: cell row unexercised / styles_incomplete, and no pair row", async () => {
  const { site, rows } = await readinessCapture();
  assert.ok(site.same.requested(`${routeOf("shadow-styles-pending")}stalled.css`), "setup: the shadow root's stylesheet was requested");
  assert.deepEqual(pageRows(rows, "shadow-styles-pending", keyed("cell")), both({ key: "cell", result: "unexercised", reason_code: "styles_incomplete" }));
  assert.deepEqual(pageRows(rows, "shadow-styles-pending", isPair), [], "no pair row reads pass before the shadow stylesheet loaded");
});

browserTest("an @import that answered 404 inside an open shadow root: cell row unexercised / styles_incomplete", async () => {
  const { rows } = await readinessCapture();
  assert.deepEqual(pageRows(rows, "shadow-import-missing", keyed("cell")), both({ key: "cell", result: "unexercised", reason_code: "styles_incomplete" }));
});

browserTest("a stylesheet that answered 404 inside an open shadow root of a same-origin iframe: cell row unexercised / styles_incomplete", async () => {
  const { rows } = await readinessCapture();
  assert.deepEqual(pageRows(rows, "frame-shadow-styles-missing", keyed("cell")), both({ key: "cell", result: "unexercised", reason_code: "styles_incomplete" }));
});

browserTest("control: a loaded stylesheet inside an open shadow root leaves the cell measured, and its text reads pass", async () => {
  const { rows } = await readinessCapture();
  assert.deepEqual(pageRows(rows, "shadow-styles-loaded", keyed("cell")), [], "no cell row for a measured cell");
  assert.deepEqual(pageRows(rows, "shadow-styles-loaded", isPair), both({ key: "pair:ffffffff/111111ff:normal", result: "pass", reason_code: null }));
});

// ---------------------------------------------------------------------------
// A shadow host's own text renders inside its open shadow root, through the
// slot that takes it in: it inherits that slot's style, and the shadow tree's
// wrappers around the slot paint over it. A same-origin frame still loading
// its document (the initial blank document standing in for a pending src, or
// a document not yet complete) has text the probe cannot read yet: the cell
// lists it as a gap. A loaded frame, and one blank by design, read as before.

const SLOTTED_PAGES = {
  "slot-host-translucent": htmlPage(`<div data-next-action="add-to-cart" style="${P};color:#ffffff;background:#111111">Slotted host text${OPEN("<span style=\"opacity:0.3\"><slot></slot></span>")}</div>`),
  "slot-host-restyled": htmlPage(`<div style="${P};color:#ffffff;background:#111111">Restyled host text${OPEN("<span style=\"color:#333333\"><slot></slot></span>")}</div>`),
  "slot-host-unassigned": htmlPage(`<div style="${P};color:#ffffff;background:#111111">Unassigned host text${OPEN("<p style=\"margin:0;color:#ffffff;background:#111111\">Shadow text</p>")}</div>`),
  "frame-pending": htmlPage(`<iframe src="${routeOf("frame-pending")}stalled.html" title="Synthetic frame" style="width:320px;height:120px;border:0"></iframe>${STRIP}`),
  "frame-incomplete": htmlPage(`<iframe src="${routeOf("frame-incomplete")}inner.html" title="Synthetic frame" style="width:320px;height:120px;border:0"></iframe>${STRIP}`),
  "frame-blank": htmlPage(`<iframe title="Blank frame" style="width:320px;height:60px;border:0"></iframe><iframe src="about:blank" title="Blank frame" style="width:320px;height:60px;border:0"></iframe>${STRIP}`),
  "frame-src-loaded": htmlPage(`<iframe src="${routeOf("frame-src-loaded")}inner.html" title="Synthetic frame" style="width:320px;height:120px;border:0"></iframe>`),
};
const FRAME_TEXT = "<p style=\"margin:0;padding:8px;font-size:16px;font-weight:400;color:#ffffff;background:#111111\">Frame text</p>";

const slottedCapture = (() => {
  let pending = null;
  let site = null;
  after(async () => {
    await site?.close();
  });
  return () => {
    pending ||= (async () => {
      site = await readabilitySite({
        pages: SLOTTED_PAGES,
        assets: {
          [`${routeOf("frame-pending")}stalled.html`]: stall(),
          [`${routeOf("frame-incomplete")}inner.html`]: respond("200 OK", "text/html; charset=utf-8", htmlPage(`${FRAME_TEXT}<img alt="" src="${routeOf("frame-incomplete")}stalled.png" style="width:1px;height:1px">`)),
          [`${routeOf("frame-incomplete")}stalled.png`]: stall(),
          [`${routeOf("frame-src-loaded")}inner.html`]: respond("200 OK", "text/html; charset=utf-8", htmlPage(FRAME_TEXT)),
        },
      });
      const capture = await capturePolish(site);
      assertCaptureCompleted(capture);
      const record = readabilityRecord(capture.report);
      const rows = await readabilityRows(site);
      assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
      return { site, record, rows };
    })();
    return pending;
  };
})();

const measuredRow = (key) => key.startsWith("pair:") || key.startsWith("review:") || key.startsWith("role:");

browserTest("a shadow host's own text slotted beneath a translucent shadow wrapper reads review / opacity, never pass", async () => {
  const { rows } = await slottedCapture();
  assert.deepEqual(pageRows(rows, "slot-host-translucent", measuredRow), both({ key: "review:add_to_cart:opacity", result: "review", reason_code: "opacity" }));
});

browserTest("a shadow host's own text takes the colour of the slot that renders it", async () => {
  const { rows } = await slottedCapture();
  assert.deepEqual(warningRows(pageRows(rows, "slot-host-restyled", measuredRow)), warningRows(both({ key: "pair:333333ff/111111ff:normal", result: "warning" })));
});

browserTest("a shadow host's own text that no slot takes in is not rendered and not measured", async () => {
  const { record } = await slottedCapture();
  const cells = cellsOf(record, "slot-host-unassigned");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => element.selector_path), ["html>body>div:nth-of-type(1)>>>p:nth-of-type(1)"], `${viewport}: only the shadow root's own text is measured`);
  }
});

browserTest("a visible same-origin iframe still on its initial blank document with a pending src: gap row unexercised / cross_origin_text", async () => {
  const { site, rows } = await slottedCapture();
  assert.ok(site.same.requested(`${routeOf("frame-pending")}stalled.html`), "setup: the frame's src was requested");
  assert.deepEqual(pageRows(rows, "frame-pending", (key) => key.startsWith("gap:")), both({ key: "gap:cross_origin_text", result: "unexercised", reason_code: "cross_origin_text" }));
});

browserTest("a visible same-origin iframe whose document has not finished loading: gap row unexercised / cross_origin_text, and its text is not measured", async () => {
  const { site, record, rows } = await slottedCapture();
  assert.ok(site.same.requested(`${routeOf("frame-incomplete")}stalled.png`), "setup: the frame's document loaded and its image stalled");
  assert.deepEqual(pageRows(rows, "frame-incomplete", (key) => key.startsWith("gap:")), both({ key: "gap:cross_origin_text", result: "unexercised", reason_code: "cross_origin_text" }));
  const cells = cellsOf(record, "frame-incomplete");
  for (const viewport of VIEWPORTS) assert.deepEqual(cells[viewport].elements.map((element) => element.selector_path), ["html>body>p:nth-of-type(1)"], `${viewport}: only the outer text is measured`);
});

browserTest("control: frames blank by design (no src, src about:blank) add no gap, and a loaded same-origin src frame is measured with no gap", async () => {
  const { record, rows } = await slottedCapture();
  assert.deepEqual(pageRows(rows, "frame-blank", (key) => key.startsWith("gap:") || key === "cell"), [], "no gap or cell row for blank frames");
  assert.deepEqual(pageRows(rows, "frame-blank", isPair), both({ key: "pair:ffffffff/111111ff:normal", result: "pass", reason_code: null }));
  assert.deepEqual(pageRows(rows, "frame-src-loaded", (key) => key.startsWith("gap:") || key === "cell"), [], "no gap or cell row for a loaded frame");
  assert.deepEqual(pageRows(rows, "frame-src-loaded", isPair), both({ key: "pair:ffffffff/111111ff:normal", result: "pass", reason_code: null }));
  const cells = cellsOf(record, "frame-src-loaded");
  for (const viewport of VIEWPORTS) assert.deepEqual(cells[viewport].elements.map((element) => element.selector_path), ["html>body>iframe:nth-of-type(1)>>>html>body>p:nth-of-type(1)"], `${viewport}: the frame's text is measured`);
});

browserTest("the record persists no text from slotted host text or frames", async () => {
  const { record } = await slottedCapture();
  const serialized = JSON.stringify(record);
  assert.deepEqual(["Slotted host text", "Restyled host text", "Unassigned host text", "Shadow text", "Frame text", "Synthetic text"].filter((text) => serialized.includes(text)), []);
});

// ---------------------------------------------------------------------------
// A shadow host's text assigned (manual slot assignment) to two differently
// styled slots is never measured through the first slot alone; text in a
// loaded same-origin frame is painted by the frame element and the document
// around it as well; and text any element generates through ::before or
// ::after, not only a role element, is listed as generated_text.

const MANUAL_SLOTS = (second) => `<div id="host" data-next-action="add-to-cart" style="${P};color:#ffffff;background:#111111">First text<!---->Second text</div><script>
const host = document.getElementById("host");
const root = host.attachShadow({ mode: "open", slotAssignment: "manual" });
root.innerHTML = '<span><slot></slot></span><span style="${second}"><slot></slot></span>';
const [first, other] = root.querySelectorAll("slot");
const texts = Array.from(host.childNodes).filter((node) => node.nodeType === 3);
first.assign(texts[0]);
other.assign(texts[1]);
</script>`;
const FRAMED = "<!doctype html><body style='margin:0'><p style='margin:0;padding:8px;color:#ffffff;background:#111111'>Frame text</p></body>";
const GENERATED_STYLE = "<style>.generated::before{content:\"now\"}.generated-after::after{content:\"more\"}.clear::before,.clear::after{content:\" \";display:table}</style>";

const UNOBSERVED_PAGES = {
  "slot-manual-split": htmlPage(MANUAL_SLOTS("color:#111111")),
  "slot-manual-gradient": htmlPage(MANUAL_SLOTS("background-image:linear-gradient(#111111,#333333)")),
  "frame-translucent": htmlPage(`<iframe srcdoc="${FRAMED}" title="Synthetic frame" style="width:320px;height:120px;border:0;opacity:0.3"></iframe>`),
  "frame-outer-filter": htmlPage(`<div style="filter:grayscale(1)"><iframe srcdoc="${FRAMED}" title="Synthetic frame" style="width:320px;height:120px;border:0"></iframe></div>`),
  "generated-descendant": htmlPage(ATC("color:#ffffff;background:#111111", "Add <span class=\"generated\"></span>"), { head: GENERATED_STYLE }),
  "generated-body": htmlPage(`<p class="generated-after" style="${P};color:#ffffff;background:#111111">Body text</p>`, { head: GENERATED_STYLE }),
  "generated-blank": htmlPage(`<p class="clear" style="${P};color:#ffffff;background:#111111">Body text</p>`, { head: GENERATED_STYLE }),
};

const unobservedCapture = (() => {
  let pending = null;
  let site = null;
  after(async () => {
    await site?.close();
  });
  return () => {
    pending ||= (async () => {
      site = await readabilitySite({ pages: UNOBSERVED_PAGES });
      const capture = await capturePolish(site);
      assertCaptureCompleted(capture);
      const record = readabilityRecord(capture.report);
      const rows = await readabilityRows(site);
      assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
      return { record, rows };
    })();
    return pending;
  };
})();

browserTest("a shadow host's text assigned to two slots, the second black on black: review / overlapping_layer, and no pair row passes", async () => {
  const { rows } = await unobservedCapture();
  assert.deepEqual(pageRows(rows, "slot-manual-split", measuredRow), both({ key: "review:add_to_cart:overlapping_layer", result: "review", reason_code: "overlapping_layer" }));
});

browserTest("a shadow host's text assigned to two slots, the second over a gradient: review / background_gradient", async () => {
  const { rows } = await unobservedCapture();
  assert.deepEqual(pageRows(rows, "slot-manual-gradient", measuredRow), both({ key: "review:add_to_cart:background_gradient", result: "review", reason_code: "background_gradient" }));
});

browserTest("text in a loaded same-origin frame whose frame element has opacity 0.3 reads review, never pass", async () => {
  const { record, rows } = await unobservedCapture();
  const cells = cellsOf(record, "frame-translucent");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => [element.selector_path, element.review_reason]), [["html>body>iframe:nth-of-type(1)>>>html>body>p:nth-of-type(1)", "opacity"]], `${viewport}: the frame's text is a review member`);
  }
  assert.deepEqual(pageRows(rows, "frame-translucent", measuredRow), both({ key: "review:body_text:non_solid", result: "review", reason_code: "non_solid_background" }));
});

browserTest("text in a loaded same-origin frame inside a filtered element of the outer document reads review, never pass", async () => {
  const { record, rows } = await unobservedCapture();
  const cells = cellsOf(record, "frame-outer-filter");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => element.review_reason), ["filter"], `${viewport}: the frame's text is a review member`);
  }
  assert.deepEqual(pageRows(rows, "frame-outer-filter", measuredRow), both({ key: "review:body_text:non_solid", result: "review", reason_code: "non_solid_background" }));
});

browserTest("generated text on a descendant of a role element: role coverage row unexercised / generated_text", async () => {
  const { rows } = await unobservedCapture();
  assert.deepEqual(pageRows(rows, "generated-descendant", keyed("role:add_to_cart:coverage")), both({ key: "role:add_to_cart:coverage", result: "unexercised", reason_code: "generated_text" }));
});

browserTest("generated text on body text: role coverage row unexercised / generated_text", async () => {
  const { rows } = await unobservedCapture();
  assert.deepEqual(pageRows(rows, "generated-body", keyed("role:body_text:coverage")), both({ key: "role:body_text:coverage", result: "unexercised", reason_code: "generated_text" }));
});

browserTest("control: blank generated content (a clearfix) adds no generated_text row", async () => {
  const { rows } = await unobservedCapture();
  assert.deepEqual(pageRows(rows, "generated-blank", (key) => key.startsWith("role:")), []);
  assert.deepEqual(pageRows(rows, "generated-blank", isPair), both({ key: "pair:ffffffff/111111ff:normal", result: "pass", reason_code: null }));
});

browserTest("the record persists no slotted, framed or generated text", async () => {
  const { record } = await unobservedCapture();
  const serialized = JSON.stringify(record);
  assert.deepEqual(["First text", "Second text", "Frame text", "Body text", "\"now\"", "\"more\""].filter((text) => serialized.includes(text)), []);
});

// ---------------------------------------------------------------------------
// Text the page paints with something other than its element's CSS colour
// and font: SVG text is painted with its fill; a placeholder with its
// ::placeholder colour, size and weight; the first line or letter with its
// ::first-line or ::first-letter style.

const DRAWING = (inner) => `<svg width="240" height="60" style="display:block">${inner}</svg>`;
const PAINTED_PAGES = {
  "svg-white-fill": htmlPage(DRAWING("<text x=\"8\" y=\"40\" font-size=\"16\" fill=\"#ffffff\">Drawn text</text>")),
  "svg-gradient-fill": htmlPage(`<button data-next-action="add-to-cart" type="button" style="${BTN};color:#111111;background:#ffffff">${DRAWING("<defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#ffffff\"/><stop offset=\"1\" stop-color=\"#eeeeee\"/></linearGradient></defs><text x=\"8\" y=\"40\" font-size=\"16\" fill=\"url(#g)\">Drawn label</text>")}</button>`),
  "placeholder-size": htmlPage("<input data-next-checkout-field=\"email\" placeholder=\"Email address\" style=\"font-size:24px;font-weight:400;color:#ffffff;background:#e0662b;border:0;width:320px;height:48px\">", { head: "<style>input::placeholder{font-size:16px;font-weight:400;color:#ffffff}</style>" }),
  "first-line": htmlPage(`<p class="first-line" data-next-action="add-to-cart" style="${P};color:#111111;background:#ffffff">First line text</p>`, { head: "<style>.first-line::first-line{color:#fafafa}</style>" }),
};

const paintedCapture = (() => {
  let pending = null;
  let site = null;
  after(async () => {
    await site?.close();
  });
  return () => {
    pending ||= (async () => {
      site = await readabilitySite({ pages: PAINTED_PAGES });
      const capture = await capturePolish(site);
      assertCaptureCompleted(capture);
      const record = readabilityRecord(capture.report);
      const rows = await readabilityRows(site);
      assert.ok(rows.length > 0, "readCurrentQcResults lists readability.contrast rows");
      return { record, rows };
    })();
    return pending;
  };
})();

browserTest("white-filled SVG text on a white page reads warning, never a pass on its CSS colour", async () => {
  const { rows } = await paintedCapture();
  assert.deepEqual(warningRows(pageRows(rows, "svg-white-fill", measuredRow)), warningRows(both({ key: "pair:ffffffff/ffffffff:normal", result: "warning" })));
});

browserTest("SVG text with a gradient fill in an add-to-cart control reads review, never pass", async () => {
  const { rows } = await paintedCapture();
  assert.deepEqual(pageRows(rows, "svg-gradient-fill", measuredRow), both({ key: "review:add_to_cart:unparseable_color", result: "review", reason_code: "unparseable_color" }));
});

browserTest("16px placeholder text in a 24px checkout field is normal text: #fff on #e0662b (3.44) reads warning", async () => {
  const { record, rows } = await paintedCapture();
  const cells = cellsOf(record, "placeholder-size");
  for (const viewport of VIEWPORTS) {
    assert.deepEqual(cells[viewport].elements.map((element) => [element.role, element.font_size_px, element.size_class]), [["checkout_hint", 16, "normal"]], `${viewport}: the placeholder's own size`);
  }
  assert.deepEqual(warningRows(pageRows(rows, "placeholder-size", measuredRow)), warningRows(both({ key: "pair:ffffffff/e0662bff:normal", result: "warning" })));
});

browserTest("text whose ::first-line colour differs from its own reads review / pseudo_element_background, never pass", async () => {
  const { rows } = await paintedCapture();
  assert.deepEqual(pageRows(rows, "first-line", measuredRow), both({ key: "review:add_to_cart:pseudo_element_background", result: "review", reason_code: "pseudo_element_background" }));
});
