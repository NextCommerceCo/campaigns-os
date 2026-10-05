// The shared contrast helper in real Chromium. Each check serves a stub page
// on 127.0.0.1 (the markup of a frozen readability row's fixture), injects
// contrastToolkit by Function.prototype.toString() into the page's main world
// and into an isolated world (Page.createIsolatedWorld), and asserts the
// helper fact behind that row. Every page's two readings must be identical.
//
// Browser gate: the loopback harness launches Chromium once at import; with
// CAMPAIGNS_OS_REQUIRE_BROWSER=1 a launch failure fails the file.
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import { contrastToolkit } from "./contrast.mjs";
import { loopbackGuard, stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";
import { browserTest, connectionReset, htmlPage, respond, stall } from "./readability-harness.browser.test.mjs";
import { hexToSrgb, ratioOf } from "./readability-harness.test.mjs";

afterEach(() => assertNoNetworkAttempts());

const kit = contrastToolkit();
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const BTN = "border:0;padding:8px 12px;font-size:16px;font-weight:400;font-family:sans-serif";
const P = "margin:0;padding:8px;font-size:16px;font-weight:400";
const ATC = (style, text = "Add to cart", extra = "") => `<button data-next-action="add-to-cart" type="button"${extra} style="${BTN};${style}">${text}</button>`;
const STRIP = "<p style=\"margin:0;padding:8px;color:#ffffff;background:#111111\">Synthetic text</p>";
// An open shadow root, declared in the markup.
const OPEN = (inner) => `<template shadowrootmode="open">${inner}</template>`;
const FRAME_DOC = "<!doctype html><body style='margin:0'><p style='margin:0;padding:8px;color:#ffffff;background:#111111'>Frame text</p></body>";
// A shadow host whose two text nodes are assigned (manual slot assignment)
// to two slots; the second slot sits in a wrapper styled `second`.
const MANUAL_SLOTS = (second) => `<div id="host" style="${P};color:#ffffff;background:#111111">First text<!---->Second text</div><script>
const host = document.getElementById("host");
const root = host.attachShadow({ mode: "open", slotAssignment: "manual" });
root.innerHTML = '<span><slot></slot></span><span style="${second}"><slot></slot></span>';
const [first, other] = root.querySelectorAll("slot");
const texts = Array.from(host.childNodes).filter((node) => node.nodeType === 3);
first.assign(texts[0]);
other.assign(texts[1]);
</script>`;
const FRAME = (style, doc = FRAME_DOC) => `<iframe srcdoc="${doc}" style="width:320px;height:120px;border:0;${style}"></iframe>`;
const BARE_FRAME_DOC = "<!doctype html><body style='margin:0'><p style='margin:0;padding:8px;color:#222222'>Frame text</p></body>";
const NESTED = (outer) => `<div style="${outer}"><div style="background:#111"><span data-next-action="add-to-cart" style="color:#fff">x</span></div></div>`;

const PAGES = ({ other }) => ({
  b1: htmlPage(`<p style="${P};color:#ffffff;background:#0080aa">Normal text</p>`),
  b2: htmlPage(`<p style="${P};color:#ffffff;background:#949494">Normal text</p>`),
  b3: htmlPage(`<p style="margin:0;padding:8px;font-size:14pt;font-weight:600;color:#ffffff;background:#e0662b">Semibold text</p>`),
  b5: htmlPage(ATC("color:#eeeeee;background:#ffffff", "Buy now")),
  b6: htmlPage(`<div data-next-bundle-card="b1" data-next-selected="true" style="${P};color:#222222;background:#333333">Selected bundle</div>`),
  b7: htmlPage("<a style=\"color:#fff;background:#111\"><span style=\"color:#222\">x</span></a>"),
  b8: htmlPage(`<div style="padding:8px;background:#ffffff"><p style="${P};color:#ffffff;background:rgba(0,0,0,0.5)">Translucent panel</p></div>`),
  b9: htmlPage(`<div style="padding:8px;background:#000000"><p style="${P};color:rgba(255,255,255,0.3)">Faint text</p></div>`),
  w3: htmlPage(ATC("font-size:14pt;font-weight:700;color:#ffffff;background:#e0662b")),
  w4: htmlPage(`<p style="${P};font-size:24px;color:#ffffff;background:#e0662b">Large text</p>`),
  w6: htmlPage(`<div data-next-bundle-card="b1" data-next-selected="true" style="${P};color:oklch(0.21 0.034 264.665);background:oklch(0.828 0.189 84.429)">Bundle of three</div>`),
  w8: htmlPage(`<p style="${P};color:#ffffff;background:#111111">Checkout</p>`, { head: `<script src="${other.origin}/vendor/analytics.js"></script>` }),
  w9: htmlPage(`<p style="margin:0;padding:8px;font-size:calc(1rem + 0.5vw);font-weight:700;color:#ffffff;background:#111111">Bold heading</p>`),
  w14: htmlPage(`<a href="/checkout/" style="display:inline-block;${P};color:oklch(0.21 0.034 264.665);background:oklch(0.828 0.189 84.429)">Buy now</a>`),
  w18: htmlPage(`<details open style="padding:8px;color:#ffffff;background:#767676;font-size:16px"><summary>More</summary><p style="margin:0">Panel text</p></details>`),
  w19: htmlPage(`<textarea readonly style="color:#ffffff;background:#767676;font-size:16px;font-weight:400;border:0;width:300px;height:60px">Readonly note</textarea>`),
  w21: htmlPage(`<input type="submit" value="Buy" style="${BTN};color:#ffffff;background:#767676">`),
  w22: htmlPage(`<div data-next-bump="bump-1" class="next-active" style="${P};color:#ffffff;background:#333333">Add the bump</div>`),
  i1: htmlPage(ATC("color:#ffffff;background-color:#111111;background-image:linear-gradient(#111111,#333333)")),
  i2: htmlPage(ATC(`color:#ffffff;background-color:#111111;background-image:url(${PNG_1PX})`)),
  i3: htmlPage(ATC("color:#ffffff;background:#111111;opacity:0.3")),
  i4: htmlPage(`<div style="position:relative;width:240px;height:60px;background:#111111"><img alt="" src="${PNG_1PX}" style="position:absolute;left:0;top:0;width:240px;height:60px"><button data-next-action="add-to-cart" type="button" style="${BTN};position:relative;color:#ffffff;background:transparent">Add to cart</button></div>`),
  i7: htmlPage(`<button disabled style="${BTN};color:#bbbbbb;background:#eeeeee">Unavailable</button>`),
  i9: htmlPage(STRIP, { head: "<link rel=\"stylesheet\" href=\"/i9/missing.css\">" }),
  i16: htmlPage(ATC("color:#ffffff;background:transparent"), { base: ":root{color-scheme:dark}body{margin:0;background:transparent}" }),
  i24: htmlPage(ATC("color:#bbbbbb;background:#eeeeee", "Add to cart", " class=\"next-disabled\"")),
  i29: htmlPage(ATC("color:#ffffff;background:#111111", "Add to cart", " data-next-loading=\"true\"")),
  i31: htmlPage(NESTED("opacity:.3")),
  i32: htmlPage(NESTED("filter:grayscale(1)")),
  i33: htmlPage(NESTED("mix-blend-mode:multiply")),
  i34: htmlPage(NESTED("mask-image:linear-gradient(#000,transparent)")),
  i35: htmlPage(STRIP, { bodyAttrs: "data-next-sdk-loading=\"true\"" }),
  "sdk-ready": htmlPage(STRIP, { htmlAttrs: "class=\"next-display-ready\"", bodyAttrs: "data-next-sdk-loading=\"true\"" }),
  i50: htmlPage(`<p style="${P};font-family:Stalled,sans-serif;color:#ffffff;background:#111111">Webfont text</p>`, { head: "<style>@font-face{font-family:Stalled;src:url(/i50/stalled.woff2) format(\"woff2\")}</style>" }),
  i53: htmlPage(`<div class="layer" style="padding:8px;background:#333333"><span data-next-action="add-to-cart" style="color:#ffffff">Add to cart</span></div>`, { head: "<style>.layer::before{content:\"\";display:block;height:4px;background:#000}</style>" }),
  i54: htmlPage(ATC("font-size:24px;color:#ffffff;background-color:#e0662b;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent")),
  i55: htmlPage(`<a href="" aria-disabled="true" style="display:inline-block;${P};color:#bbbbbb;background:#eeeeee">Unavailable link</a>`),
  "shadow-opacity": htmlPage(`<div style="background:#111111;color:#222222;opacity:0.3">${OPEN(`<p style="${P}">Shadow text</p>`)}</div>`),
  "shadow-background": htmlPage(`<div style="background:#0080aa">${OPEN(`<p style="${P};color:#ffffff">Shadow text</p>`)}</div>`),
  "shadow-disabled": htmlPage(`<button disabled style="${BTN};color:#bbbbbb;background:#eeeeee"><span>${OPEN("<span>Unavailable</span>")}</span></button>`),
  "shadow-nested": htmlPage(`<section style="background:#0080aa">${OPEN(`<div>${OPEN(`<p style="${P};color:#ffffff">Nested text</p>`)}</div>`)}</section>`),
  "shadow-selected": htmlPage(`<div data-next-bundle-card="b1" data-next-selected="true" style="background:#333333">${OPEN(`<p style="${P};color:#ffffff">Selected bundle</p>`)}</div>`),
  "shadow-positioned-host": htmlPage(`<div style="position:sticky;top:0;background:#111111">${OPEN(`<p style="${P};color:#ffffff">Shadow text</p>`)}</div>`),
  "shadow-overlay": htmlPage(`<div style="position:relative"><div>${OPEN("<div style=\"position:absolute;left:0;top:0;width:240px;height:60px;background:#000000\"></div>")}</div><p style="${P};color:#ffffff;background:#111111">Light text</p></div>`),
  "shadow-slot": htmlPage(`<div style="background:#ffffff">${OPEN("<div style=\"opacity:0.3;background:#000000\"><slot></slot></div>")}<p style="${P};color:#eeeeee">Slotted text</p></div>`),
  "slot-host-translucent": htmlPage(`<div style="${P};color:#ffffff;background:#111111">Host text${OPEN("<span style=\"opacity:0.3\"><slot></slot></span>")}</div>`),
  "slot-host-restyled": htmlPage(`<div style="${P};color:#ffffff;background:#111111">Host text${OPEN("<span style=\"color:#333333;font-size:24px\"><slot></slot></span>")}</div>`),
  "slot-host-unassigned": htmlPage(`<div style="${P};color:#ffffff;background:#111111">Host text${OPEN(`<p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
  "slot-manual-split": htmlPage(MANUAL_SLOTS("color:#111111")),
  "slot-manual-gradient": htmlPage(MANUAL_SLOTS("background-image:linear-gradient(#111111,#333333)")),
  "slot-manual-same": htmlPage(MANUAL_SLOTS("font-style:normal")),
  "frame-translucent": htmlPage(FRAME("opacity:0.3")),
  "frame-outer-filter": htmlPage(`<div style="filter:grayscale(1)">${FRAME("")}</div>`),
  "frame-overlay": htmlPage(`<div style="position:relative">${FRAME("")}<div style="position:absolute;left:0;top:0;width:320px;height:20px;background:#000000"></div></div>`),
  "frame-transparent": htmlPage(`<div style="padding:8px;background:#111111">${FRAME("display:block", BARE_FRAME_DOC)}</div>`),
  "frame-scheme": htmlPage(`<div style="padding:8px;background:#ffffff">${FRAME("display:block", "<!doctype html><html style='color-scheme:dark'><body style='margin:0'><p style='margin:0;padding:8px;color:#222222'>Frame text</p></body></html>")}</div>`),
  "frame-path": htmlPage(`<p style="${P};color:#ffffff;background:#111111">Light text</p><iframe srcdoc="${FRAME_DOC}" style="width:320px;height:120px;border:0"></iframe>`),
  "shadow-link-pending": htmlPage(`<div>${OPEN(`<link rel="stylesheet" href="/shadow-link-pending/stalled.css"><p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
  "shadow-link-missing": htmlPage(`<div>${OPEN(`<link rel="stylesheet" href="/shadow-link-missing/missing.css"><p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
  "shadow-link-loaded": htmlPage(`<div>${OPEN(`<link rel="stylesheet" href="/loaded.css"><p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
  "import-missing": htmlPage(STRIP, { head: "<style>@import url(/import-missing/missing.css);</style>" }),
  "shadow-import-missing": htmlPage(`<div>${OPEN(`<style>@import url(/shadow-import-missing/missing.css);</style><p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
  "shadow-import-loaded": htmlPage(`<div>${OPEN(`<style>@import url(/loaded.css);</style><p style="${P};color:#ffffff;background:#111111">Shadow text</p>`)}</div>`),
});

// Measures every text-bearing element in <body>, in whichever world runs it.
const PROBE = `(() => {
  const kit = (${contrastToolkit.toString()})();
  const elements = Array.from(document.body.querySelectorAll("*")).filter((el) => kit.isTextBearing(el, window));
  return { version: kit.version, measurability: kit.documentMeasurability(document), elements: elements.map((el) => kit.measureTextElement(el, window)) };
})()`;

const guard = loopbackGuard();
let served = null;
async function serve() {
  served ||= (async () => {
    const same = await stubOrigin();
    const other = await stubOrigin();
    for (const [name, html] of Object.entries(PAGES({ other }))) same.serve(`/${name}/`, respond("200 OK", "text/html; charset=utf-8", html));
    same.serve("/i50/stalled.woff2", stall());
    same.serve("/shadow-link-pending/stalled.css", stall());
    same.serve("/loaded.css", respond("200 OK", "text/css; charset=utf-8", "p{letter-spacing:0}"));
    other.serve("/vendor/analytics.js", connectionReset());
    const { chromium } = await import("playwright");
    const browser = guard.instrument(await chromium.launch());
    return { same, other, browser };
  })();
  return served;
}
after(async () => {
  if (!served) return;
  const { same, other, browser } = await served;
  await browser.close();
  await same.close();
  await other.close();
  guard.assertLoopbackOnly();
  assertNoNetworkAttempts();
});

// Measures every text-bearing element in <body>, in each open shadow root
// (recursively) and in each same-origin frame's <body>, with that frame's
// window.
const FLAT_PROBE = `(() => {
  const kit = (${contrastToolkit.toString()})();
  const elements = [];
  const visit = (scope, win) => {
    for (const el of scope.querySelectorAll("*")) {
      if (kit.isTextBearing(el, win)) elements.push(kit.measureTextElement(el, win));
      if (el.shadowRoot) visit(el.shadowRoot, win);
      if (el.localName === "iframe" && el.contentDocument && el.contentDocument.body) visit(el.contentDocument.body, el.contentWindow);
    }
  };
  visit(document.body, window);
  return { version: kit.version, measurability: kit.documentMeasurability(document), elements };
})()`;

async function isolatedWorld(page, expression) {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "contrast-helper-check", grantUniveralAccess: false });
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true });
    assert.equal(exceptionDetails, undefined, `the helper runs in an isolated world (${exceptionDetails?.exception?.description})`);
    return result.value;
  } finally {
    await session.detach();
  }
}

// One page's reading in both worlds, at a viewport width. `settled` waits for
// a setup condition before the probe runs.
async function measure(name, { width = 1440, waitUntil = "load", settled, probe = PROBE } = {}) {
  const { same, browser } = await serve();
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${same.origin}/${name}/`, { waitUntil });
    await settled?.(same);
    const main = await page.evaluate(probe);
    const isolated = await isolatedWorld(page, probe);
    assert.deepEqual(isolated, main, `/${name}/: the main world and an isolated world read the same`);
    assert.equal(main.version, "contrast/v1");
    for (const element of main.elements.filter((measured) => measured.fg_raw !== null)) {
      const { review_reason, ...derived } = kit.deriveElementMeasurement(element);
      assert.deepEqual(derived, Object.fromEntries(Object.keys(derived).map((field) => [field, element[field]])), `/${name}/ ${element.selector_path}: the page's reading re-derives exactly in Node`);
    }
    return main;
  } finally {
    await context.close();
  }
}

// The page's one text-bearing element.
async function only(name, options) {
  const { elements } = await measure(name, options);
  assert.equal(elements.length, 1, `/${name}/ has one text-bearing element (${elements.map((element) => element.selector_path).join(", ")})`);
  return elements[0];
}

const COLOUR_FIELDS = ["fg_raw", "fill_raw", "bg_layers_raw", "fg_srgb", "bg_srgb", "gamut_clipped", "ratio"];

browserTest("F2.4-B1 fixture: #fff on #0080aa measures 4.4986 unrounded, below 4.5, normal size", async () => {
  const element = await only("b1");
  assert.ok(Math.abs(element.ratio - ratioOf(hexToSrgb("#ffffff"), hexToSrgb("#0080aa"))) < 1e-12, `ratio ${element.ratio}`);
  assert.ok(element.ratio > 4.49 && element.ratio < 4.5, `ratio ${element.ratio}`);
  assert.equal(element.size_class, "normal");
  assert.equal(kit.meetsRequirement(element.ratio, element.required), false);
  assert.equal(element.review_reason, null);
});

browserTest("F2.4-B2 fixture: #fff on #949494 measures 3.0 against a 4.5 requirement", async () => {
  const element = await only("b2");
  assert.ok(Math.abs(element.ratio - 3) < 0.05, `ratio ${element.ratio}`);
  assert.equal(element.required, 4.5);
});

browserTest("F2.4-B3 fixture: 18.6667px/600 is normal size, requiring 4.5", async () => {
  const element = await only("b3");
  assert.deepEqual([element.font_size_px, element.font_weight, element.size_class, element.required], [18.6667, 600, "normal", 4.5]);
});

browserTest("F2.4-W3 fixture: 18.6667px/700 is large, requiring 3, and 3.44 meets it", async () => {
  const element = await only("w3");
  assert.deepEqual([element.font_size_px, element.font_weight, element.size_class, element.required], [18.6667, 700, "large", 3]);
  assert.equal(kit.meetsRequirement(element.ratio, element.required), true);
});

browserTest("F2.4-W4 fixture: 24px/400 is large", async () => {
  const element = await only("w4");
  assert.deepEqual([element.font_size_px, element.font_weight, element.size_class], [24, 400, "large"]);
});

browserTest("F2.4-W9 fixture: bold calc(1rem + 0.5vw) is 17.95px and normal at 390, 23.2px and large at 1440", async () => {
  const mobile = await only("w9", { width: 390 });
  const desktop = await only("w9", { width: 1440 });
  assert.deepEqual([mobile.font_size_px, mobile.size_class], [17.95, "normal"]);
  assert.deepEqual([desktop.font_size_px, desktop.size_class], [23.2, "large"]);
});

browserTest("F2.4-B5, B7, B8, B9 fixtures: the requirement is not met; B7's span is measured on its own, B8 composites the background, B9 the foreground", async () => {
  const b5 = await only("b5");
  assert.equal(kit.meetsRequirement(b5.ratio, b5.required), false);

  const b7 = await only("b7");
  assert.match(b7.selector_path, />a:nth-of-type\(1\)>span:nth-of-type\(1\)$/, "the span, not its link, is the text-bearing element");
  assert.equal(b7.fg_raw, "rgb(34, 34, 34)");
  assert.deepEqual(b7.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgb(17, 17, 17)"]);
  assert.equal(kit.meetsRequirement(b7.ratio, b7.required), false);

  const b8 = await only("b8");
  assert.deepEqual(b8.bg_layers_raw, ["rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"]);
  assert.deepEqual(b8.bg_srgb, [0.5, 0.5, 0.5], "half-black over white");
  assert.equal(kit.meetsRequirement(b8.ratio, b8.required), false);

  const b9 = await only("b9");
  assert.equal(b9.fg_raw, "rgba(255, 255, 255, 0.3)");
  assert.deepEqual(b9.fg_srgb, [0.3, 0.3, 0.3], "30% white over black");
  assert.ok(Math.abs(b9.ratio - ratioOf([0.3, 0.3, 0.3], [0, 0, 0])) < 1e-12, `ratio ${b9.ratio}`);
  assert.equal(kit.meetsRequirement(b9.ratio, b9.required), false);
});

browserTest("F2.4-W6, W14 fixtures: the Tailwind oklch pair parses and meets the requirement", async () => {
  for (const name of ["w6", "w14"]) {
    const element = await only(name);
    assert.deepEqual([kit.parseComputedColor(element.fg_raw), kit.parseComputedColor(element.bg_layers_raw[0])], [
      { space: "oklch", coords: [0.21, 0.034, 264.665], alpha: 1 },
      { space: "oklch", coords: [0.828, 0.189, 84.429], alpha: 1 },
    ]);
    assert.equal(kit.meetsRequirement(element.ratio, element.required), true, `/${name}/ ratio ${element.ratio}`);
  }
});

browserTest("F2.4-W21 fixture: <input type=\"submit\" value=\"Buy\"> is text-bearing and measured", async () => {
  const element = await only("w21");
  assert.match(element.selector_path, /input\[type="submit"\]:nth-of-type\(1\)$/);
  assert.equal(typeof element.ratio, "number");
  assert.equal(element.review_reason, null);
});

browserTest("F2.4-I1, I2, I3, I4, I16, I24, I31, I32, I33, I34, I53, I54 fixtures: each element's review_reason", async () => {
  const expected = {
    i1: "background_gradient",
    i2: "background_image",
    i3: "opacity",
    i4: "overlapping_layer",
    i16: "canvas_unknown",
    i24: "disabled_state_uncertain",
    i31: "opacity",
    i32: "filter",
    i33: "blend_mode",
    i34: "mask",
    i53: "pseudo_element_background",
    i54: "text_fill_background",
  };
  const actual = {};
  for (const name of Object.keys(expected)) actual[name] = (await only(name)).review_reason;
  assert.deepEqual(actual, expected);
});

browserTest("F2.4-I7, I55 fixtures: a disabled control is disabled and no colour is read", async () => {
  for (const name of ["i7", "i55"]) {
    const element = await only(name);
    assert.equal(element.disabled, true, `/${name}/ is disabled`);
    assert.deepEqual(COLOUR_FIELDS.map((field) => element[field]), COLOUR_FIELDS.map(() => null), `/${name}/ has no colour fields`);
  }
});

browserTest("F2.4-W19 fixture: a readonly textarea is not disabled", async () => {
  const element = await only("w19");
  assert.equal(element.disabled, false);
  assert.equal(typeof element.ratio, "number");
});

browserTest("F2.4-I29 fixture: a loading control is control_loading", async () => {
  const element = await only("i29");
  assert.equal(element.control_loading, true);
  assert.equal(element.ratio, null);
});

browserTest("F2.4-W18, W22, B30 fixtures: state is expanded, active, selected", async () => {
  assert.deepEqual((await measure("w18")).elements.map((element) => element.state), ["expanded", "expanded"], "the summary and the panel text inside <details open>");
  assert.equal((await only("w22")).state, "active");
  assert.equal((await only("b6")).state, "selected");
});

browserTest("F2.4-I9, I35, I50, W8 fixtures: documentMeasurability reads styles_incomplete, sdk_not_ready, fonts_pending, measurable", async () => {
  assert.deepEqual((await measure("i9")).measurability, { measurable: false, reason: "styles_incomplete" });
  assert.deepEqual((await measure("i35")).measurability, { measurable: false, reason: "sdk_not_ready" });
  assert.deepEqual((await measure("sdk-ready")).measurability, { measurable: true }, "html.next-display-ready is SDK readiness");
  const fontRequested = async (same) => {
    const deadline = Date.now() + 5000;
    while (!same.requested("/i50/stalled.woff2")) {
      assert.ok(Date.now() < deadline, "setup: the page requested its webfont");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  assert.deepEqual((await measure("i50", { waitUntil: "domcontentloaded", settled: fontRequested })).measurability, { measurable: false, reason: "fonts_pending" });
  const { other } = await serve();
  assert.deepEqual((await measure("w8")).measurability, { measurable: true });
  assert.ok(other.requested("/vendor/analytics.js"), "setup: the page requested the failing cross-origin vendor script");
});

browserTest("F2.4-W15 precursor: the same element measured in the main world and in an isolated world has an identical ratio", async () => {
  const { same, browser } = await serve();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${same.origin}/b1/`);
    const ratio = (reading) => reading.elements.map((element) => element.ratio);
    assert.deepEqual(ratio(await isolatedWorld(page, PROBE)), ratio(await page.evaluate(PROBE)));
  } finally {
    await context.close();
  }
});

// Chromium's own conversion into sRGB (color-mix with the colour at 100%)
// agrees with toSrgb in every space. Chromium computes in single precision,
// hence the tolerance.
browserTest("toSrgb agrees with Chromium's conversion of each colour() space and lab, lch, oklab, oklch", async () => {
  const colours = ["color(srgb-linear 0.2 0.4 0.6)", "color(display-p3 0.4 0.5 0.6)", "color(a98-rgb 0.4 0.5 0.6)", "color(prophoto-rgb 0.4 0.5 0.6)", "color(rec2020 0.4 0.5 0.6)", "color(rec2020 0.01 0.02 0.03)", "color(xyz-d50 0.3 0.3 0.3)", "color(xyz-d65 0.3 0.3 0.3)", "lab(50 20 -30)", "lch(60 40 120)", "oklab(0.5 -0.1 0.1)", "oklch(0.6 0.1 250)", "oklch(0.7 0.4 150)"];
  const { browser } = await serve();
  const page = await browser.newPage();
  try {
    const serialized = await page.evaluate((list) => list.map((colour) => {
      const probe = document.createElement("i");
      probe.style.color = `color-mix(in srgb, ${colour} 100%, ${colour})`;
      document.body.append(probe);
      return getComputedStyle(probe).color;
    }), colours);
    for (const [at, colour] of colours.entries()) {
      const chromium = /^color\(srgb (\S+) (\S+) ([^\s)]+)\)$/.exec(serialized[at]).slice(1).map((c) => Math.min(1, Math.max(0, Number(c))));
      const ours = kit.toSrgb(kit.parseComputedColor(colour)).rgb;
      assert.ok(ours.every((c, i) => Math.abs(c - chromium[i]) < 1e-3), `${colour}: ${ours} vs Chromium ${chromium}`);
    }
  } finally {
    await page.close();
  }
});

// Open shadow roots: every walk follows the flat tree, through each host.
const flat = (name) => only(name, { probe: FLAT_PROBE });

browserTest("shadow text inside a host with opacity 0.3 reads review / opacity, over the host's background", async () => {
  const element = await flat("shadow-opacity");
  assert.equal(element.review_reason, "opacity");
  assert.deepEqual(element.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgb(17, 17, 17)"]);
  assert.match(element.selector_path, /^html>body>div:nth-of-type\(1\)>>>p:nth-of-type\(1\)$/);
});

browserTest("shadow text over an opaque host background composites the host's background", async () => {
  const element = await flat("shadow-background");
  assert.deepEqual(element.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgb(0, 128, 170)"]);
  assert.ok(Math.abs(element.ratio - ratioOf(hexToSrgb("#ffffff"), hexToSrgb("#0080aa"))) < 1e-12, `ratio ${element.ratio}`);
  assert.equal(element.review_reason, null);
});

browserTest("shadow text in a host inside a disabled button is disabled and no colour is read", async () => {
  const element = await flat("shadow-disabled");
  assert.equal(element.disabled, true);
  assert.deepEqual(COLOUR_FIELDS.map((field) => element[field]), COLOUR_FIELDS.map(() => null));
});

browserTest("text in a nested open shadow root walks both hosts and names both in its path", async () => {
  const element = await flat("shadow-nested");
  assert.deepEqual(element.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(0, 128, 170)"]);
  assert.equal(element.review_reason, null);
  assert.equal(element.selector_path, "html>body>section:nth-of-type(1)>>>div:nth-of-type(1)>>>p:nth-of-type(1)");
});

browserTest("an ancestor state above the host labels shadow text", async () => {
  assert.equal((await flat("shadow-selected")).state, "selected");
});

browserTest("a positioned host with a background never overlaps its own shadow text; a positioned layer inside a shadow root overlaps light text", async () => {
  const own = await flat("shadow-positioned-host");
  assert.deepEqual([own.review_reason, own.bg_layers_raw], [null, ["rgba(0, 0, 0, 0)", "rgb(17, 17, 17)"]]);
  assert.equal((await flat("shadow-overlay")).review_reason, "overlapping_layer");
});

browserTest("light text slotted into an open shadow root walks through its slot: a translucent shadow wrapper reads review / opacity", async () => {
  const element = await flat("shadow-slot");
  assert.equal(element.review_reason, "opacity");
  assert.equal(element.selector_path, "html>body>div:nth-of-type(1)>>>div:nth-of-type(1)>slot:nth-of-type(1)>>>p:nth-of-type(1)", "the path follows the flat tree through the slot");
});

browserTest("a shadow host's own text walks through the slot that renders it: a translucent shadow wrapper reads review / opacity", async () => {
  const element = await flat("slot-host-translucent");
  assert.equal(element.review_reason, "opacity");
  assert.deepEqual(element.bg_layers_raw, ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(17, 17, 17)"], "the slot, its wrapper, then the host");
  assert.equal(element.selector_path, "html>body>div:nth-of-type(1)", "the element is still the host");
});

browserTest("a shadow host's own text takes its colour and size from the slot that renders it", async () => {
  const element = await flat("slot-host-restyled");
  assert.deepEqual([element.fg_raw, element.font_size_px, element.size_class, element.review_reason], ["rgb(51, 51, 51)", 24, "large", null]);
});

browserTest("a shadow host's own text that no slot takes in is not text-bearing", async () => {
  const element = await flat("slot-host-unassigned");
  assert.equal(element.selector_path, "html>body>div:nth-of-type(1)>>>p:nth-of-type(1)");
});

// A shadow host's text assigned (manual slot assignment) to two slots is
// read through each slot: one slot's reading never stands for text another
// slot paints differently.
browserTest("a shadow host's text assigned to two differently coloured slots reads review / overlapping_layer, never one slot's ratio", async () => {
  const element = await flat("slot-manual-split");
  assert.equal(element.selector_path, "html>body>div:nth-of-type(1)", "setup: the host is the one text-bearing element");
  assert.equal(element.fg_raw, "rgb(255, 255, 255)", "setup: the first slot's reading is recorded");
  assert.equal(element.review_reason, "overlapping_layer");
});

browserTest("a shadow host's text whose second slot sits over a gradient reads review / background_gradient", async () => {
  const element = await flat("slot-manual-gradient");
  assert.equal(element.review_reason, "background_gradient");
});

browserTest("control: a shadow host's text assigned to two slots that read alike is measured", async () => {
  const element = await flat("slot-manual-same");
  assert.deepEqual([element.review_reason, element.fg_raw, element.bg_layers_raw.at(-1)], [null, "rgb(255, 255, 255)", "rgb(17, 17, 17)"]);
  assert.ok(element.ratio > 18, `ratio ${element.ratio}`);
});

// Text in a same-origin frame is painted by the frame element and the
// document around it as well.
const frameText = async (name) => {
  const { elements } = await measure(name, { probe: FLAT_PROBE });
  const inner = elements.filter((element) => element.selector_path.includes("iframe:nth-of-type(1)>>>"));
  assert.equal(inner.length, 1, `/${name}/: the frame's text is measured (${elements.map((element) => element.selector_path).join(", ")})`);
  return inner[0];
};

browserTest("text in a same-origin frame whose frame element has opacity 0.3 reads review / opacity", async () => {
  assert.equal((await frameText("frame-translucent")).review_reason, "opacity");
});

browserTest("text in a same-origin frame inside a filtered element of the outer document reads review / filter", async () => {
  assert.equal((await frameText("frame-outer-filter")).review_reason, "filter");
});

browserTest("text in a same-origin frame under a positioned layer of the outer document reads review / overlapping_layer", async () => {
  assert.equal((await frameText("frame-overlay")).review_reason, "overlapping_layer");
});

browserTest("text in a transparent same-origin frame document is composited over the outer document's background, not a default canvas", async () => {
  const element = await frameText("frame-transparent");
  assert.equal(element.bg_layers_raw.at(-1), "rgb(17, 17, 17)", JSON.stringify(element.bg_layers_raw));
  assert.equal(kit.meetsRequirement(element.ratio, element.required), false, `ratio ${element.ratio}`);
});

browserTest("control: text in a transparent same-origin frame document whose color-scheme differs from its frame element's reads review / canvas_unknown (that frame paints its own canvas)", async () => {
  assert.equal((await frameText("frame-scheme")).review_reason, "canvas_unknown");
});

browserTest("text in a same-origin frame stops at the frame's root, and its path names the frame", async () => {
  const { elements } = await measure("frame-path", { probe: FLAT_PROBE });
  assert.deepEqual(elements.map((element) => element.selector_path), ["html>body>p:nth-of-type(1)", "html>body>iframe:nth-of-type(1)>>>html>body>p:nth-of-type(1)"]);
  assert.deepEqual(elements.map((element) => element.bg_layers_raw), [["rgb(17, 17, 17)"], ["rgb(17, 17, 17)"]]);
});

// Cell measurability reads every tree of the document.
browserTest("a stylesheet in an open shadow root that is still loading or answered 404, or an @import that answered 404 in the document or a shadow root, reads styles_incomplete; loaded ones are measurable", async () => {
  const requested = (path) => async (same) => {
    const deadline = Date.now() + 5000;
    while (!same.requested(path)) {
      assert.ok(Date.now() < deadline, `setup: the page requested ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const incomplete = { measurable: false, reason: "styles_incomplete" };
  assert.deepEqual((await measure("shadow-link-pending", { waitUntil: "commit", settled: requested("/shadow-link-pending/stalled.css") })).measurability, incomplete, "a shadow-root link whose sheet is null");
  assert.deepEqual((await measure("shadow-link-missing")).measurability, incomplete, "a shadow-root link that answered 404");
  assert.deepEqual((await measure("import-missing")).measurability, incomplete, "a document @import that answered 404");
  assert.deepEqual((await measure("shadow-import-missing")).measurability, incomplete, "a shadow-root @import that answered 404");
  assert.deepEqual((await measure("shadow-link-loaded")).measurability, { measurable: true }, "control: a loaded shadow-root link");
  assert.deepEqual((await measure("shadow-import-loaded")).measurability, { measurable: true }, "control: a loaded shadow-root @import");
});
