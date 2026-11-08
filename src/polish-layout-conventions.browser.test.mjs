// Layout conventions (campaigns-os#700) in real Chromium: one real `polish
// capture` over stub pages under _site/<slug>/ served on 127.0.0.1
// (src/readability-harness.browser.test.mjs), read back through
// readCurrentQcResults with the registry's real rules.
//
// - cro: the CRO review's fixed bar, a paragraph above the purchase button and
//   a stock meter below it, the button's label at 14px;
// - clean: a fixed bar holding one 16px purchase button and nothing else;
// - chrome: a fixed header with a link and text, a fixed bar holding a form
//   field, and a sticky box taller than half the viewport, none of which is
//   a floating CTA container.
//
// Every page is a readability-only cell (a template stock page), measured at
// both widths; the layout conventions apply at mobile only.
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import { browserTest, capturePolish, cellsOf, htmlPage, readabilitySite, routeOf } from "./readability-harness.browser.test.mjs";
import { assertNoNetworkAttempts, doctorOf, readJson } from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const LAYOUT = "layout.conventions";
const BAR = "position:fixed;left:0;right:0;bottom:0;padding:12px;background:#ffffff";
const BUY = (px) => `<a data-next-action="add-to-cart" href="#buy" style="display:block;padding:12px;text-align:center;color:#ffffff;background:#111111;text-decoration:none"><span style="font-size:${px}px">Buy now</span></a>`;

const PAGES = {
  cro: htmlPage(`<main style="padding:16px"><p>Synthetic product page</p></main>
<div id="bar" style="${BAR}"><p style="margin:0 0 8px;font-size:14px">Synthetic flag line</p>${BUY(14)}<div class="stock" style="margin-top:8px"><div style="height:6px;width:40%;background:#c00"></div><span style="font-size:12px">Synthetic stock meter</span></div></div>`),
  clean: htmlPage(`<main style="padding:16px"><p>Synthetic product page</p></main><div id="bar" style="${BAR}">${BUY(16)}</div>`),
  chrome: htmlPage(`<header style="position:fixed;top:0;left:0;right:0;background:#ffffff"><a href="#home">Home</a> <span>Synthetic header</span></header>
<div style="position:fixed;bottom:0;left:0;right:0;background:#ffffff"><input type="email" aria-label="Email"><button type="button">Join</button><span>Synthetic signup</span></div>
<div style="position:sticky;top:0;height:600px;background:#eeeeee"><p>Synthetic tall panel</p><a href="#more">More</a></div>`),
};

let pending = null;
const captured = () => {
  pending ||= (async () => {
    const site = await readabilitySite({ pages: PAGES });
    after(site.close);
    const capture = await capturePolish(site);
    assert.equal(capture.error, null, `setup: polish capture completed (${capture.error?.message})`);
    const record = capture.report.stages.polish?.evidence?.visual_review?.readability;
    assert.ok(record, "setup: polish capture attached the readability record");
    const { loadQcRederivers } = await import("./qc-check-registry.mjs");
    const { readCurrentQcResults } = await import("./qc-results.mjs");
    const { results } = readCurrentQcResults({
      report: readJson(site.f.reportPath),
      doctor: doctorOf(site.f.packetPath),
      spec: readJson(site.f.specPath),
      targetRepo: site.f.targetRepo,
      packetPath: site.f.packetPath,
      rederivers: await loadQcRederivers(),
    });
    return { record, rows: results.filter((row) => row.check === LAYOUT) };
  })();
  return pending;
};

const rowsOf = (rows, name) => rows.filter((row) => row.subject.page === routeOf(name)).map((row) => [row.subject.viewport, row.subject.key, row.result, row.reason_code]).sort();

browserTest("a fixed CTA bar with a paragraph above the button and a stock meter below it: the floating_cta warning names the bar; its 14px label warns with the measured value", async () => {
  const { record, rows } = await captured();
  const cells = cellsOf(record, "cro");
  const [bar] = cells.mobile.layout.floating_ctas;
  assert.equal(cells.mobile.layout.floating_ctas.length, 1, "the probe finds the one floating CTA container");
  assert.equal(bar.selector_path, "html>body>div:nth-of-type(1)", "the container is the fixed bar");
  assert.equal(bar.position, "fixed");
  assert.equal(bar.controls.length, 1, "it holds one control");
  assert.match(bar.controls[0].selector_path, /^html>body>div:nth-of-type\(1\)>a\[data-next-action="add-to-cart"\]/, "the control is the purchase link");
  assert.ok(bar.rect.height > 0 && bar.controls[0].rect.height > 0, "the record keeps both rects");
  assert.deepEqual(bar.other_text, ["html>body>div:nth-of-type(1)>p:nth-of-type(1)", "html>body>div:nth-of-type(1)>div:nth-of-type(1)>span:nth-of-type(1)"], "the flag line and the stock meter are the other text; the button label is not");
  assert.deepEqual(rowsOf(rows, "cro"), [
    ["mobile", "cta_label_size", "warning", "cta_label_too_small"],
    ["mobile", "floating_cta", "warning", "floating_cta_extra_content"],
  ], "two mobile warnings, nothing at desktop");
  const floating = rows.find((row) => row.subject.page === routeOf("cro") && row.subject.key === "floating_cta");
  assert.deepEqual(floating.members.map((member) => member.key), ["html>body>div:nth-of-type(1)"], "the warning names the bar");
  const label = rows.find((row) => row.subject.page === routeOf("cro") && row.subject.key === "cta_label_size");
  assert.equal(label.observation.smallest_px, 14, "the label warning carries the measured size");
  assert.ok(floating.accept_eligible && label.accept_eligible, "both warnings are accept-eligible");
});

browserTest("a fixed bar holding one 16px purchase button: silent (both layout rows pass)", async () => {
  const { record, rows } = await captured();
  assert.equal(cellsOf(record, "clean").mobile.layout.floating_ctas.length, 1, "setup: the probe finds the bar");
  assert.deepEqual(rowsOf(rows, "clean"), [
    ["mobile", "cta_label_size", "pass", null],
    ["mobile", "floating_cta", "pass", null],
  ]);
});

browserTest("a fixed header, a fixed bar holding a form field and a sticky box taller than half the viewport are not floating CTA containers", async () => {
  const { record, rows } = await captured();
  const containers = cellsOf(record, "chrome").mobile.layout.floating_ctas;
  assert.deepEqual(containers.map((entry) => entry.position), ["sticky"], "the probe skips the header and the form; it records the sticky box");
  assert.deepEqual(rowsOf(rows, "chrome"), [
    ["mobile", "cta_label_size", "pass", null],
    ["mobile", "floating_cta", "pass", null],
  ], "the reader drops the tall sticky box");
});
