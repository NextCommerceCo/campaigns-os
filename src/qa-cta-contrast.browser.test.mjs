// F2.4 frozen fixture rows for QA's browser-primary-cta check on the shared
// contrast helper, real Chromium (contract 2.4 Surfaces "QA verdict,
// browser-primary-cta:<page_id>"; the outcome order, first match:
// fail/missing_route_cta, manual_review/{sdk_not_ready, styles_incomplete,
// fonts_pending}, fail/low_contrast, fail/cta_too_small,
// manual_review/{text_not_rendered, control_loading},
// manual_review/contrast_review, manual_review/cta_disabled, pass).
//
// Each row serves one stub page on 127.0.0.1 and runs the QA browser page
// checks (runBrowserChecks, the `qa run --browser` entry) over it, so page
// eligibility is exercised as QA runs it. The pages reference nothing but
// their own loopback origin.
//
// API assumptions (every row; the contract fixes the outcomes, not where
// the assertion carries them):
// - the assertion keeps its id `browser-primary-cta:<page_id>` and its
//   `status` (pass | fail | manual_review);
// - the outcome's reason code is `evidence.reason`, the field that carries
//   it at BASE_SHA;
// - per-candidate evidence is `evidence.candidates[].elements[]` with
//   {selector_path, contrast_ratio_exact, required_ratio, size_class,
//   review_reason} (contract :1430).
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import {
  assertCaptureCompleted,
  browserTest,
  capturePolish,
  cellsOf,
  htmlPage,
  readabilityRecord,
  readabilitySite,
  respond,
  stall,
} from "./readability-harness.browser.test.mjs";
import { stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const BOX = "display:inline-block;width:160px;height:48px;line-height:48px;text-align:center;text-decoration:none;font-family:sans-serif;font-size:16px;font-weight:400";
const cta = (style, text = "Buy now", { href = "/checkout/", extra = "" } = {}) => `<a href="${href}"${extra} style="${BOX};${style}">${text}</a>`;

// Serves `html` at /lp/ (plus `assets`) and runs QA's browser page checks on
// it with the page's expected next route /checkout/. Returns every
// browser-primary-cta assertion QA produced for the page.
async function primaryCta(html, { pageType = "product", assets = {} } = {}) {
  const origin = await stubOrigin();
  try {
    origin.serve("/lp/", respond("200 OK", "text/html; charset=utf-8", html));
    for (const [path, handler] of Object.entries(assets)) origin.serve(path, handler);
    const { runBrowserChecks } = await import("./qa-browser.mjs");
    const page = { page_id: "landing", page_type: pageType, url: origin.url("/lp/"), expected_next_url: origin.url("/checkout/") };
    const assertions = await runBrowserChecks([{ pages: [page] }], {}, {});
    assert.ok(assertions.some((entry) => entry.id === "browser-load:landing" && entry.status === "pass"), "setup: QA loaded the page");
    return assertions.filter((entry) => entry.id === "browser-primary-cta:landing");
  } finally {
    await origin.close();
  }
}

// The one browser-primary-cta assertion for the page.
function one(found) {
  assert.equal(found.length, 1, `QA reports one browser-primary-cta assertion for the page (found ${found.length})`);
  return found[0];
}
const outcome = (entry) => ({ status: entry.status, reason: entry.evidence?.reason });

// ---------------------------------------------------------------------------

browserTest("F2.4-W13 QA CTA: 24px bold #fff on #e0662b: browser-primary-cta status pass", async () => {
  const entry = one(await primaryCta(htmlPage(cta("width:200px;font-size:24px;font-weight:700;color:#ffffff;background:#e0662b"))));
  assert.equal(entry.status, "pass", `browser-primary-cta status pass (${entry.actual})`);
});

browserTest("F2.4-W14 QA CTA: Tailwind dark on amber oklch: browser-primary-cta status pass", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:oklch(0.21 0.034 264.665);background:oklch(0.828 0.189 84.429)"))));
  assert.equal(entry.status, "pass", `browser-primary-cta status pass (${entry.actual})`);
});

browserTest("F2.4-W15 the same CTA page measured by QA and by Polish at desktop: the label element's contrast_ratio_exact equals its Polish ratio", async () => {
  const html = htmlPage(cta("color:#ffffff;background:#0080aa"));
  const entry = one(await primaryCta(html));
  const qaElements = (entry.evidence?.candidates || []).flatMap((candidate) => candidate?.elements || []);
  assert.equal(qaElements.length, 1, `QA evidence lists the label element (${JSON.stringify(entry.evidence?.candidates)?.slice(0, 300)})`);
  const [label] = qaElements;
  assert.equal(typeof label.contrast_ratio_exact, "number", "QA records the label's exact ratio");

  const site = await readabilitySite({ pages: { cta: html } });
  try {
    const capture = await capturePolish(site);
    assertCaptureCompleted(capture);
    const desktop = cellsOf(readabilityRecord(capture.report), "cta").desktop;
    const matched = desktop.elements.filter((element) => element.selector_path === label.selector_path);
    assert.equal(matched.length, 1, `setup: Polish measured the same label element (${label.selector_path})`);
    assert.equal(label.contrast_ratio_exact, matched[0].ratio, "the label's contrast_ratio_exact equals its Polish ratio");
  } finally {
    await site.close();
  }
});

browserTest("F2.4-B18 QA CTA: anchor #fff/#111 with child span #222: browser-primary-cta status fail", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "Buy <span style=\"color:#222222\">now</span>"))));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "low_contrast" }, `browser-primary-cta status fail (${entry.actual})`);
});

browserTest("F2.4-B20 two route-matching CTAs, the first readable, the second #eee on #fff: browser-primary-cta status fail", async () => {
  const entry = one(await primaryCta(htmlPage(`${cta("color:#ffffff;background:#111111")}<p></p>${cta("color:#eeeeee;background:#ffffff", "Order now")}`)));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "low_contrast" }, `browser-primary-cta status fail (${entry.actual})`);
});

browserTest("F2.4-B22 page with page_type:\"checkout\", expected_next_url, and a route CTA #eee on #fff: browser-primary-cta status fail", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#eeeeee;background:#ffffff", "Complete order")), { pageType: "checkout" }));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "low_contrast" }, `browser-primary-cta status fail (${entry.actual})`);
});

// #fff on #898989 is 3.50:1 (24px/700, large, needs 3); #2c2c2c on #898989
// is 3.99:1 (14px/400, normal, needs 4.5).
browserTest("F2.4-B23 one route CTA, 24px/700 label at 3.5 and a 14px/400 child at 4.0: browser-primary-cta status fail", async () => {
  const entry = one(await primaryCta(htmlPage(cta("width:240px;height:72px;line-height:36px;font-size:24px;font-weight:700;color:#ffffff;background:#898989", "Buy now<br><span style=\"font-size:14px;font-weight:400;color:#2c2c2c\">Free returns</span>"))));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "low_contrast" }, `browser-primary-cta status fail (${entry.actual})`);
});

// Beside F2.4-B23: the failure comes from the child text, not the label, so
// the row cannot pass because the large label was held to 4.5.
browserTest("F2.4-B23 companion: the failing element in the evidence is the 14px child; the 24px/700 label meets 3", async () => {
  const entry = one(await primaryCta(htmlPage(cta("width:240px;height:72px;line-height:36px;font-size:24px;font-weight:700;color:#ffffff;background:#898989", "Buy now<br><span style=\"font-size:14px;font-weight:400;color:#2c2c2c\">Free returns</span>"))));
  const elements = entry.evidence.candidates.flatMap((candidate) => candidate.elements || []);
  assert.equal(elements.length, 2, JSON.stringify(elements));
  const failing = elements.filter((element) => element.contrast_ratio_exact < element.required_ratio);
  assert.equal(failing.length, 1, JSON.stringify(elements));
  assert.match(failing[0].selector_path, />span:nth-of-type\(1\)$/);
  assert.deepEqual([failing[0].size_class, failing[0].required_ratio], ["normal", 4.5]);
  const label = elements.find((element) => element !== failing[0]);
  assert.match(label.selector_path, />a:nth-of-type\(1\)$/);
  assert.deepEqual([label.size_class, label.required_ratio], ["large", 3]);
  assert.ok(label.contrast_ratio_exact >= 3 && label.contrast_ratio_exact < 4.5, `the label reads 3.5:1 (${label.contrast_ratio_exact})`);
});

// The box rule keeps its meaning: no route candidate at least 40x20.
browserTest("QA CTA: a readable route CTA smaller than 40x20 reads fail / cta_too_small", async () => {
  const entry = one(await primaryCta(htmlPage(cta("width:36px;height:18px;line-height:18px;font-size:12px;color:#ffffff;background:#111111", "Go"))));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "cta_too_small" }, entry.actual);
});

// Disabled candidates are not contrast-measured; when every candidate is
// disabled the page is reviewed, at severity warn, never passed.
browserTest("QA CTA: every route candidate disabled reads manual_review / cta_disabled at severity warn, unmeasured", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#eeeeee;background:#ffffff", "Buy now", { extra: " aria-disabled=\"true\"" }))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "cta_disabled" }, entry.actual);
  assert.equal(entry.severity, "warn");
  assert.deepEqual(entry.evidence.candidates.flatMap((candidate) => candidate.elements || []), []);
});

// Text whose own control is disabled is not read, so it never counts as
// rendered text or toward a pass: an enabled route CTA whose only text sits in
// a disabled inner control has nothing measured and reads as having no
// rendered text. cta_disabled stays reserved for every candidate disabled.
const INACTIVE_LABEL = "<span role=\"button\" aria-disabled=\"true\" style=\"color:#eeeeee\">Buy now</span>";

browserTest("QA CTA: an enabled route CTA whose only text is in a disabled inner control reads manual_review / text_not_rendered, never pass", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", INACTIVE_LABEL))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "text_not_rendered" }, entry.actual);
  assert.equal(entry.severity, "warn");
  const [candidate] = entry.evidence.candidates.filter((row) => row.route_matches);
  assert.deepEqual([candidate.disabled, candidate.text_rendered, candidate.contrast_ratio], [false, false, null], JSON.stringify(candidate));
});

browserTest("QA CTA: a readable route CTA beside one whose only text is inactive reads manual_review / text_not_rendered, never pass", async () => {
  const entry = one(await primaryCta(htmlPage(`${cta("color:#ffffff;background:#111111")}<p></p>${cta("color:#ffffff;background:#111111", INACTIVE_LABEL)}`)));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "text_not_rendered" }, entry.actual);
});

// Review members are not compared, so they never count toward a pass either:
// a readable route CTA beside one whose only text is a review member is
// reviewed.
browserTest("QA CTA: a readable route CTA beside one whose only text is a review member reads manual_review / contrast_review", async () => {
  const entry = one(await primaryCta(htmlPage(`${cta("color:#ffffff;background:#111111")}<p></p>${cta("color:#ffffff;background-color:#111111;background-image:linear-gradient(#111,#333)", "Order now")}`)));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, entry.actual);
});

// Text inside an open shadow root in a route CTA is measured too, against
// the background the page paints behind it.
browserTest("QA CTA: unreadable text inside an open shadow root in the route CTA reads fail / low_contrast", async () => {
  const html = htmlPage(`${cta("color:#111111;background:#ffffff", "<span id=\"host\"></span>")}<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<b style=\\"color:#eeeeee\\">Buy now</b>";</script>`);
  const entry = one(await primaryCta(html));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "low_contrast" }, entry.actual);
  const elements = entry.evidence.candidates.flatMap((candidate) => candidate.elements || []);
  assert.equal(elements.length, 1, JSON.stringify(elements));
  assert.match(elements[0].selector_path, />>>b:nth-of-type\(1\)$/);
});

browserTest("F2.4-B26 QA page with expected_next_url and no route-matching control: browser-primary-cta reason missing_route_cta", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "Learn more", { href: "/about/" }))));
  assert.deepEqual(outcome(entry), { status: "fail", reason: "missing_route_cta" }, `browser-primary-cta reason missing_route_cta (${entry.actual})`);
});

browserTest("F2.4-I17 QA CTA: route-matching <a href> 160x48, label 16px/400 #fff on linear-gradient(#111,#333) over #111, no SDK, styles and fonts loaded: browser-primary-cta status manual_review", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background-color:#111111;background-image:linear-gradient(#111,#333)"))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, `browser-primary-cta status manual_review (${entry.actual})`);
});

browserTest("F2.4-I41 QA CTA: route-matching <a href> with no text, 120x44 (visible, at least 40x20): browser-primary-cta reason text_not_rendered", async () => {
  const entry = one(await primaryCta(htmlPage(cta("width:120px;height:44px;background:#111111", ""))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "text_not_rendered" }, `browser-primary-cta reason text_not_rendered (${entry.actual})`);
});

browserTest("F2.4-I42 QA CTA: route-matching control 160x48 with data-next-loading=\"true\" and the label Buy now, 16px/400 #fff on #111: browser-primary-cta reason control_loading", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "Buy now", { extra: " data-next-loading=\"true\"" }))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "control_loading" }, `browser-primary-cta reason control_loading (${entry.actual})`);
});

browserTest("F2.4-I43 QA CTA page with <body data-next-sdk-loading=\"true\">: browser-primary-cta reason sdk_not_ready", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111"), { bodyAttrs: "data-next-sdk-loading=\"true\"" })));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "sdk_not_ready" }, `browser-primary-cta reason sdk_not_ready (${entry.actual})`);
});

browserTest("F2.4-I44 QA CTA page with a link[rel=stylesheet] that 404s: browser-primary-cta reason styles_incomplete", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111"), { head: "<link rel=\"stylesheet\" href=\"/lp/missing.css\">" })));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "styles_incomplete" }, `browser-primary-cta reason styles_incomplete (${entry.actual})`);
});

browserTest("F2.4-I45 QA CTA page whose webfont request stalls: browser-primary-cta reason fonts_pending", async () => {
  const entry = one(await primaryCta(
    htmlPage(cta("font-family:Stalled,sans-serif;color:#ffffff;background:#111111"), { head: "<style>@font-face{font-family:Stalled;src:url(/lp/stalled.woff2) format(\"woff2\")}</style>" }),
    { assets: { "/lp/stalled.woff2": stall() } },
  ));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "fonts_pending" }, `browser-primary-cta reason fonts_pending (${entry.actual})`);
});

// A shadow host's own text inside the route CTA renders through its slot, so
// a translucent wrapper around the slot is seen: the CTA is reviewed, never
// passed.
browserTest("QA CTA: a shadow host's own text slotted beneath a translucent shadow wrapper in the route CTA reads manual_review / contrast_review", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "<span>Buy now<template shadowrootmode=\"open\"><span style=\"opacity:0.3\"><slot></slot></span></template></span>"))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, entry.actual);
  const elements = entry.evidence.candidates.flatMap((candidate) => candidate.elements || []);
  assert.deepEqual(elements.map((element) => element.review_reason), ["opacity"], JSON.stringify(elements));
});

// Text generated through ::before or ::after inside the route CTA is never
// measured, so the CTA is reviewed, never passed on its other text.
const GENERATED = "<style>.generated::before{content:\"Now\";color:#111111}.cta-after::after{content:\" now\";color:#111111}</style>";

browserTest("QA CTA: white-on-black route CTA text plus black-on-black ::before text on a descendant reads manual_review / contrast_review at severity warn", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "Buy <span class=\"generated\"></span>"), { head: GENERATED })));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, entry.actual);
  assert.equal(entry.severity, "warn");
});

browserTest("QA CTA: route CTA text plus ::after text on the candidate itself reads manual_review / contrast_review at severity warn", async () => {
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", "Buy", { extra: " class=\"cta-after\"" }), { head: GENERATED })));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, entry.actual);
  assert.equal(entry.severity, "warn");
});

browserTest("QA CTA: a shadow host's text inside the route CTA assigned to two slots, the second black on black, reads manual_review / contrast_review", async () => {
  const host = `<span id="host">Buy<!---->now</span><script>
const host = document.getElementById("host");
const root = host.attachShadow({ mode: "open", slotAssignment: "manual" });
root.innerHTML = '<span><slot></slot></span><span style="color:#111111"><slot></slot></span>';
const [first, other] = root.querySelectorAll("slot");
const texts = Array.from(host.childNodes).filter((node) => node.nodeType === 3);
first.assign(texts[0]);
other.assign(texts[1]);
</script>`;
  const entry = one(await primaryCta(htmlPage(cta("color:#ffffff;background:#111111", host))));
  assert.deepEqual(outcome(entry), { status: "manual_review", reason: "contrast_review" }, entry.actual);
  const elements = entry.evidence.candidates.flatMap((candidate) => candidate.elements || []);
  assert.deepEqual(elements.map((element) => element.review_reason), ["overlapping_layer"], JSON.stringify(elements));
});
