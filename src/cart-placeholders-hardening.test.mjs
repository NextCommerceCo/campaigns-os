// Raw cart placeholders (`built_output.cart_placeholders`): regression rows
// for the token grammar, loader identity, the ready line, element ownership
// and page depth.
// Every page here is synthetic; hosts are example.invalid.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import { assertNoNetworkAttempts, withNoNetwork } from "./qc-test-factories.mjs";

// No network: qc-test-factories.mjs installs the guard before the modules
// under test load, so they are imported dynamically after it.
afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const { evaluateCartPlaceholders } = await import("./cart-placeholders.mjs");
const { SDK_TEMPLATE_PLACEHOLDERS } = await import("./sdk-attribute-index.mjs");
const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");
const { recordCartPlaceholders } = await import("./doctor/checks.mjs");

const CAMPAIGN = "example-campaign";
const PAGE = `_site/${CAMPAIGN}/index.html`;
const LOADER = (src) => `<script src="${src}"></script>`;
const VERIFIED_LOADER = "https://cdn.example.invalid/campaign-cart@v0.4.38/dist/loader.js";
const html = ({ loaders = [VERIFIED_LOADER], body }) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Synthetic cart placeholder page</title>\n${loaders.map(LOADER).join("\n")}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const TEMPLATE_ONLY = "<template><div class=\"cart-row\"><span>{item.name}</span></div></template>\n<p>Synthetic cart page.</p>";

// One page per entry, evaluated together; the rows of each page as
// "result/reason_code key" strings, plus the page-level sdk_pin.
function evaluate(pages) {
  const rows = evaluateCartPlaceholders({ pages: pages.map(([file, content]) => ({ file, content })), measuredAt: "2026-01-01T00:00:00.000Z" });
  const byPage = new Map(pages.map(([file]) => [file, []]));
  for (const row of rows) byPage.get(row.subject.page).push(row);
  return byPage;
}
const summary = (rows) => rows.map((row) => `${row.result}/${row.reason_code} ${row.subject.key}`);

async function builtDoctorRun(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "cart-placeholders-hardening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "_site", CAMPAIGN), { recursive: true });
  writeFileSync(join(dir, "_site", CAMPAIGN, "index.html"), content);
  return withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }));
}
async function builtDoctor(t, content) {
  const result = await builtDoctorRun(t, content);
  return (result.derived.qc_results || []).filter((row) => row.check === "cart_placeholders");
}

test("token grammar: namespaced paths of any depth in all seven namespaces and every bare token, live, read warning (live_token)", async (t) => {
  const tokens = [];
  for (const namespace of SDK_TEMPLATE_PLACEHOLDERS.namespaces) {
    for (const path of ["name", "property.name", "a.b.c", "a1.b_2.c3.d4.e5"]) tokens.push(`{${namespace}.${path}}`);
  }
  for (const name of [...SDK_TEMPLATE_PLACEHOLDERS.cart_summary_vars, ...SDK_TEMPLATE_PLACEHOLDERS.live_tokens]) tokens.push(`{${name}}`);
  for (const form of ["qty*2", "qty+1", "qty-1", "qty5"]) tokens.push(`{${form}}`);
  assert.equal(tokens.length, 7 * 4 + SDK_TEMPLATE_PLACEHOLDERS.cart_summary_vars.length + 3 + 4, "setup: every namespace at four depths and every bare token");

  const pages = tokens.flatMap((token, i) => [
    [`text-${i}.html`, html({ body: `<p>${token}</p>` })],
    [`attr-${i}.html`, html({ body: `<img src="data:," alt="${token}">` })],
  ]);
  const byPage = evaluate(pages);
  tokens.forEach((token, i) => {
    for (const [file, where] of [[`text-${i}.html`, "text"], [`attr-${i}.html`, "attr:alt"]]) {
      const rows = byPage.get(file);
      assert.deepEqual(summary(rows), [`warning/live_token ${token}`], `${token} in ${where}`);
      assert.equal(rows[0].observation.token, token);
      assert.equal(rows[0].observation.known, true);
      assert.deepEqual(rows[0].observation.occurrences.map((o) => o.where), [where]);
    }
  });

  // Owned forms stay owned at depth; the {qty} forms inside quantity text.
  const owned = evaluate([
    ["template.html", html({ body: "<template><p>{item.property.name}</p><p>{toggle.a.b.c}</p></template>" })],
    ["list.html", html({ body: "<div data-next-cart-items><p>{line.property.name} {discount.a.b}</p></div>" })],
    ["qty.html", html({ body: "<span data-next-quantity-text=\"{qty} items\">{qty*2} {qty+1} {qty-1}</span>" })],
  ]);
  for (const [file, rows] of owned) assert.deepEqual(summary(rows), ["pass/null page"], `${file}: owned`);

  // Outside the grammar: a three-part path in no SDK namespace is not a
  // candidate; a one-dot path in no namespace is an unknown brace.
  const outside = evaluate([
    ["deep-unknown.html", html({ body: "<p>{foo.bar.baz}</p>" })],
    ["one-dot-unknown.html", html({ body: "<p>{foo.bar}</p>" })],
  ]);
  assert.deepEqual(summary(outside.get("deep-unknown.html")), ["pass/null page"]);
  assert.deepEqual(outside.get("one-dot-unknown.html").map((row) => `${row.result}/${row.reason_code}`), ["review/unknown_brace"]);

  // End to end, the dotted path through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<p>{item.property.name}</p>" }))), ["warning/live_token {item.property.name}"]);
});

test("loader identity: only a URL whose package segment is exactly campaign-cart is the SDK loader; anything else gives no pin", async (t) => {
  const notLoaders = [
    "https://cdn.example.invalid/not-campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/xcampaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/gh/example/my-campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/npm/@other/campaign-cart@0.4.40/dist/loader.js",
    "https://campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/other.js?u=/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js.map",
    "https://cdn.example.invalid/campaign-cart@v0.4.40/extra/dist/loader.js",
  ];
  const byPage = evaluate(notLoaders.map((src, i) => [`fake-${i}.html`, html({ loaders: [src], body: TEMPLATE_ONLY })]));
  notLoaders.forEach((src, i) => {
    const rows = byPage.get(`fake-${i}.html`);
    assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"], src);
    assert.equal(rows[0].observation.sdk_pin, null, `${src}: no pin`);
    assert.equal(rows[0].observation.sdk_pin_source, null, `${src}: no pin source`);
  });

  const loaders = [
    "https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/npm/@nextcommerce/campaign-cart@0.4.40/dist/loader.js",
    "/vendor/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js?cache=1#x",
  ];
  const real = evaluate(loaders.map((src, i) => [`real-${i}.html`, html({ loaders: [src], body: TEMPLATE_ONLY })]));
  loaders.forEach((src, i) => {
    const rows = real.get(`real-${i}.html`);
    assert.deepEqual(summary(rows), ["pass/null page"], src);
    assert.equal(rows[0].observation.sdk_pin, "0.4.40", `${src}: pin`);
  });

  // A look-alike next to the real loader adds no second version.
  const mixed = evaluate([["mixed.html", html({ loaders: [notLoaders[0].replace("v0.4.40", "v0.4.39"), VERIFIED_LOADER], body: TEMPLATE_ONLY })]]);
  assert.deepEqual(summary(mixed.get("mixed.html")), ["pass/null page"]);
  assert.equal(mixed.get("mixed.html")[0].observation.sdk_pin, "0.4.38");

  // End to end, the look-alike alone through doctor --built.
  const rows = await builtDoctor(t, html({ loaders: [notLoaders[0]], body: TEMPLATE_ONLY }));
  assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"]);
  assert.equal(rows[0].observation.sdk_pin, null);
});

test("loader identity: the scope and package segments match exactly, case included; the host does not", async (t) => {
  const miscased = [
    "https://cdn.example.invalid/npm/@NextCommerce/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/npm/@NEXTCOMMERCE/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/npm/%40NextCommerce/campaign-cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/npm/@nextcommerce/Campaign-Cart@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/CAMPAIGN-CART@v0.4.40/dist/loader.js",
    "https://cdn.example.invalid/campaign-cart@v0.4.40/Dist/loader.js",
    "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/Loader.js",
  ];
  const byPage = evaluate(miscased.map((src, i) => [`miscased-${i}.html`, html({ loaders: [src], body: TEMPLATE_ONLY })]));
  miscased.forEach((src, i) => {
    const rows = byPage.get(`miscased-${i}.html`);
    assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"], src);
    assert.equal(rows[0].observation.sdk_pin, null, `${src}: no pin`);
  });

  // The packet doctor and doctor --built read the same.
  for (const src of miscased.slice(0, 2)) {
    const derived = { qc_results: [] };
    recordCartPlaceholders({ subject: null, pages: [{ file: PAGE, content: html({ loaders: [src], body: TEMPLATE_ONLY }) }], warnings: [], ready: [], derived });
    const packet = derived.qc_results.filter((row) => row.check === "cart_placeholders");
    assert.deepEqual(packet.map((row) => `${row.result}/${row.reason_code}`), ["unexercised/sdk_pin_unknown"], `packet doctor: ${src}`);
    const built = await builtDoctor(t, html({ loaders: [src], body: TEMPLATE_ONLY }));
    assert.deepEqual(summary(built), ["unexercised/sdk_pin_unknown page"], `doctor --built: ${src}`);
    assert.equal(built[0].observation.sdk_pin, null);
  }

  // The host is not a path segment: its case does not matter.
  const host = evaluate([["host.html", html({ loaders: ["https://CDN.Example.INVALID/npm/@nextcommerce/campaign-cart@v0.4.40/dist/loader.js"], body: TEMPLATE_ONLY })]]);
  assert.deepEqual(summary(host.get("host.html")), ["pass/null page"]);
  assert.equal(host.get("host.html")[0].observation.sdk_pin, "0.4.40");
});

test("loader identity: an opaque-scheme src is never the loader, and any Campaign Cart loader without an exact version leaves the page's pin unknown", async (t) => {
  const PAYLOAD = "//campaign-cart@v0.4.40/dist/loader.js";
  const VERSIONED = "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js";
  const VERSIONLESS = "https://cdn.example.invalid/campaign-cart/dist/loader.js";
  // [loaders on the page, expected page row, expected sdk_pin]
  const cases = [
    [[`data:text/javascript,void%200;%0A${PAYLOAD}`], "unexercised/sdk_pin_unknown page", null],
    [[`DATA:text/javascript,${PAYLOAD}`], "unexercised/sdk_pin_unknown page", null],
    [[`javascript:void(0)${PAYLOAD}`], "unexercised/sdk_pin_unknown page", null],
    [[`java\nscript:void(0)${PAYLOAD}`], "unexercised/sdk_pin_unknown page", null],
    [[` javascript:void(0)${PAYLOAD}`], "unexercised/sdk_pin_unknown page", null],
    [[`blob:https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js`], "unexercised/sdk_pin_unknown page", null],
    [[`ftp://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js`], "unexercised/sdk_pin_unknown page", null],
    [[`file:///srv/campaign-cart@v0.4.40/dist/loader.js`], "unexercised/sdk_pin_unknown page", null],
    // An opaque look-alike beside the real loader adds nothing.
    [[`data:text/javascript,${PAYLOAD.replace("v0.4.40", "v0.4.39")}`, VERSIONED], "pass/null page", "0.4.40"],
    // A versionless loader, alone or beside a versioned one, gives no pin.
    [[VERSIONLESS], "unexercised/sdk_pin_unknown page", null],
    [[VERSIONLESS, VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [[VERSIONED, VERSIONLESS], "unexercised/sdk_pin_unknown page", null],
    [["/vendor/campaign-cart/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [["https://cdn.example.invalid/npm/@nextcommerce/campaign-cart/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [["https://cdn.example.invalid/campaign-cart@/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [["https://cdn.example.invalid/campaign-cart@latest/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [["https://cdn.example.invalid/campaign-cart@0.4.40-beta.1/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    [["https://cdn.example.invalid/campaign-cart%40v0.4.39/dist/loader.js", VERSIONED], "unexercised/sdk_pin_unknown page", null],
    // Protocol-relative and percent-encoded forms of the versioned loader.
    [["//cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js"], "pass/null page", "0.4.40"],
    [["https://cdn.example.invalid/campaign-cart%40v0.4.40/dist/loader.js"], "pass/null page", "0.4.40"],
    [[VERSIONED, "https://cdn.example.invalid/npm/@nextcommerce/campaign-cart@0.4.40/dist/loader.js"], "pass/null page", "0.4.40"],
  ];
  const byPage = evaluate(cases.map(([loaders], i) => [`case-${i}.html`, html({ loaders, body: TEMPLATE_ONLY })]));
  cases.forEach(([loaders, expected, pin], i) => {
    const rows = byPage.get(`case-${i}.html`);
    assert.deepEqual(summary(rows), [expected], JSON.stringify(loaders));
    assert.equal(rows[0].observation.sdk_pin, pin, `${JSON.stringify(loaders)}: pin`);
  });

  // End to end through doctor --built: data:, javascript: and the mixed pair.
  for (const loaders of [[`data:text/javascript,void%200;%0A${PAYLOAD}`], [`javascript:void(0)${PAYLOAD}`], [VERSIONLESS, VERSIONED]]) {
    const rows = await builtDoctor(t, html({ loaders, body: TEMPLATE_ONLY }));
    assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"], `doctor --built: ${JSON.stringify(loaders)}`);
    assert.equal(rows[0].observation.sdk_pin, null);
  }
});

test("ready line: written only when the check has no unexercised result on any page", async (t) => {
  const readyLines = (result) => (result.ready || []).filter((line) => line.startsWith("Cart placeholder check"));

  // doctor --built: a page with no loader is unexercised, so no ready line.
  const missing = await builtDoctorRun(t, html({ loaders: [], body: TEMPLATE_ONLY }));
  assert.deepEqual(missing.derived.qc_results.filter((row) => row.check === "cart_placeholders").map((row) => `${row.result}/${row.reason_code}`), ["unexercised/sdk_pin_unknown"]);
  assert.deepEqual(readyLines(missing), []);
  // A passing page keeps its ready line.
  const passing = await builtDoctorRun(t, html({ body: TEMPLATE_ONLY }));
  assert.equal(readyLines(passing).length, 1);

  // The recorder both entry points share: one unexercised page among
  // passing and warning pages withholds the line.
  const run = (pages) => {
    const ready = [];
    recordCartPlaceholders({ subject: null, pages, warnings: [], ready, derived: { qc_results: [] } });
    return readyLines({ ready });
  };
  assert.deepEqual(run([
    { file: "a.html", content: html({ body: TEMPLATE_ONLY }) },
    { file: "b.html", content: html({ body: "<p>{item.name}</p>" }) },
    { file: "c.html", content: html({ loaders: ["https://cdn.example.invalid/campaign-cart@latest/dist/loader.js"], body: TEMPLATE_ONLY }) },
  ]), []);
  assert.deepEqual(run([{ file: "big.html", bytes: 6 * 1024 * 1024 }]), []);
  assert.deepEqual(run([{ file: "gone.html", unreadable: true }]), []);
  assert.equal(run([
    { file: "a.html", content: html({ body: TEMPLATE_ONLY }) },
    { file: "b.html", content: html({ body: "<p>{item.name}</p>" }) },
  ]).length, 1);
});

test("ownership before scanning: an owned element's own text attributes are owned; quantity-control and remove-item own only their innerHTML", async (t) => {
  const ownedPages = [
    ["selector-target.html", "<div data-next-cart-items data-item-template-selector=\"#row\"></div>\n<div id=\"row\" hidden title=\"{item.name}\"><span>{item.price}</span></div>"],
    ["template.html", "<template title=\"{item.name}\" aria-label=\"{subtotal}\"><p>{item.price}</p></template>"],
    ["cart-items.html", "<div data-next-cart-items title=\"{item.name}\"><p>{item.price}</p></div>"],
    ["order-items.html", "<ul data-next-order-items aria-label=\"{line.total}\"><li>{line.name}</li></ul>"],
    ["quantity-text.html", "<span data-next-quantity-text=\"{qty} items\" title=\"{qty}\" aria-label=\"{qty+1}\">1 item</span>"],
    ["button-input-in-list.html", "<div data-next-cart-items><input type=\"button\" value=\"{item.name}\"></div>"],
  ];
  const byPage = evaluate(ownedPages.map(([file, body]) => [file, html({ body })]));
  for (const [file] of ownedPages) assert.deepEqual(summary(byPage.get(file)), ["pass/null page"], `${file}: owned`);

  // The SDK rewrites only these elements' innerHTML, so their own
  // attributes print as written.
  const live = evaluate([
    ["quantity-control.html", html({ body: "<button type=\"button\" data-next-quantity=\"increase\" title=\"{step}\">+{step}</button>" })],
    ["remove-item.html", html({ body: "<button type=\"button\" data-next-remove-item aria-label=\"{quantity}\">Remove {quantity}</button>" })],
    ["quantity-text-other.html", html({ body: "<span data-next-quantity-text=\"{qty} items\" title=\"{item.name}\">1 item</span>" })],
  ]);
  assert.deepEqual(summary(live.get("quantity-control.html")), ["warning/live_token {step}"]);
  assert.deepEqual(live.get("quantity-control.html")[0].observation.occurrences.map((o) => o.where), ["attr:title"]);
  assert.deepEqual(summary(live.get("remove-item.html")), ["warning/live_token {quantity}"]);
  assert.deepEqual(live.get("remove-item.html")[0].observation.occurrences.map((o) => o.where), ["attr:aria-label"]);
  assert.deepEqual(summary(live.get("quantity-text-other.html")), ["warning/live_token {item.name}"]);

  // End to end, the selector-owned row through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: ownedPages[0][1] }))), ["pass/null page"]);
});

test("depth: a deeply nested page within the byte cap never throws; nesting past a browser parser's depth reads unexercised (page_unreadable)", () => {
  const nested = (depth, inner) => `${"<div>".repeat(depth)}${inner}${"</div>".repeat(depth)}`;
  const pages = [
    ["deep-6000.html", html({ body: nested(6000, "<p>{item.name}</p>") })],
    ["deep-100000.html", html({ body: nested(100000, "<p>{item.name}</p>") })],
    ["deep-near-cap.html", html({ body: `${"<b>".repeat(1_700_000)}{item.name}` })],
    ["deep-template.html", html({ body: `<template>${nested(6000, "<p>{item.name}</p>")}</template>` })],
    ["deep-500.html", html({ body: nested(500, "<p>{item.name}</p>") })],
  ];
  for (const [file, content] of pages) assert.ok(Buffer.byteLength(content) < 5 * 1024 * 1024, `setup: ${file} is under the byte cap`);
  let byPage;
  assert.doesNotThrow(() => { byPage = evaluate(pages); });
  for (const file of ["deep-6000.html", "deep-100000.html", "deep-near-cap.html", "deep-template.html"]) {
    const rows = byPage.get(file);
    assert.deepEqual(summary(rows), ["unexercised/page_unreadable page"], file);
    assert.equal(rows[0].accept_eligible, false, `${file}: not accept-eligible`);
  }
  // Within the depth a browser builds, the page is scanned in full.
  assert.deepEqual(summary(byPage.get("deep-500.html")), ["warning/live_token {item.name}"]);
});
