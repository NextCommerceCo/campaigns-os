// Raw cart placeholders (`built_output.cart_placeholders`): regression rows
// for the token grammar, loader identity, the ready line, element ownership,
// page depth, ownership values, the loader element and read failures.
// Every page here is synthetic; hosts are example.invalid.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
const { collectCartPlaceholderPages, recordCartPlaceholders } = await import("./doctor/checks.mjs");

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

test("tokenizer: every single-brace pair is a candidate whatever surrounds it; only the inner pair of a balanced {{...}} is not", async (t) => {
  // Before the opening and after the closing brace: nothing, a letter, space,
  // punctuation, a stray brace of either kind (literal or as an entity), and
  // doubled braces. Entities reach the scan decoded.
  const before = ["", "x", " ", "-", "{", "}", "&#123;", "&#125;", "{{", "}}"];
  const after = ["", "y", " ", ".", "}", "{", "&#125;", "&#123;", "}}", "{{"];
  const decode = (s) => s.replaceAll("&#123;", "{").replaceAll("&#125;", "}");
  const cases = [];
  for (const [token, expected] of [["{item.name}", "warning/live_token {item.name}"], ["{subtotal}", "warning/live_token {subtotal}"], ["{tax}", "review/unknown_brace"]]) {
    for (const b of before) {
      for (const a of after) {
        const balanced = decode(b).endsWith("{") && decode(a).startsWith("}");
        cases.push({ text: `${b}${token}${a}`, expected: balanced ? "pass/null page" : expected });
      }
    }
  }
  const seen = (rows) => rows.map((row) => (row.reason_code === "unknown_brace" ? "review/unknown_brace" : `${row.result}/${row.reason_code} ${row.subject.key}`));
  // One evaluation per case keeps every page under the page cap.
  for (const { text, expected } of cases) {
    const byPage = evaluate([
      ["text.html", html({ body: `<p>${text}</p>` })],
      ["attr.html", html({ body: `<img src="data:," alt="${text}">` })],
    ]);
    assert.deepEqual(seen(byPage.get("text.html")), [expected], `${text} in text`);
    assert.deepEqual(seen(byPage.get("attr.html")), [expected], `${text} in alt`);
  }
  assert.equal(cases.filter(({ expected }) => expected === "pass/null page").length, 3 * 3 * 3, "setup: balanced only where both neighbours are braces");

  // The challenged forms by name, and adjacent pairs, all read in one pass.
  const named = evaluate([
    ["known-extra-close.html", html({ body: "<p>{item.name}}</p>" })],
    ["known-stray-open.html", html({ body: "<p>}{item.name}</p>" })],
    ["known-unbalanced-double.html", html({ body: "<p>{{item.name}</p>" })],
    ["bare-extra-close.html", html({ body: "<p>x{subtotal}}y</p>" })],
    ["unknown-extra-close.html", html({ body: "<p>{tax}}</p>" })],
    ["adjacent.html", html({ body: "<p>{item.name}}{subtotal}</p>" })],
    ["balanced.html", html({ body: "<p>{{item.name}} {{{subtotal}}} {{tax}}</p>" })],
  ]);
  assert.deepEqual(summary(named.get("known-extra-close.html")), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(named.get("known-stray-open.html")), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(named.get("known-unbalanced-double.html")), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(named.get("bare-extra-close.html")), ["warning/live_token {subtotal}"]);
  assert.deepEqual(seen(named.get("unknown-extra-close.html")), ["review/unknown_brace"]);
  assert.deepEqual(summary(named.get("adjacent.html")), ["warning/live_token {item.name}", "warning/live_token {subtotal}"]);
  assert.deepEqual(summary(named.get("balanced.html")), ["pass/null page"]);

  // End to end through doctor --built, text and a rendered attribute.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<p>{item.name}}</p>" }))), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<img src=\"data:,\" alt=\"{subtotal}}\">" }))), ["warning/live_token {subtotal}"]);
  assert.deepEqual(seen(await builtDoctor(t, html({ body: "<p>{tax}}</p>" }))), ["review/unknown_brace"]);
});

test("token grammar: a field is any run of non-space, non-brace, non-dot characters, so {<namespace>.first-name} reads warning (live_token) in all seven namespaces", async (t) => {
  const fields = ["first-name", "a-b.c-d.e-f", "x_y-z.0", "9lives", "Prénom", "a:b"];
  const tokens = SDK_TEMPLATE_PLACEHOLDERS.namespaces.flatMap((namespace) => fields.map((field) => `{${namespace}.${field}}`));
  assert.equal(tokens.length, 7 * fields.length, "setup: every namespace");
  const pages = tokens.flatMap((token, i) => [
    [`text-${i}.html`, html({ body: `<p>${token}</p>` })],
    [`attr-${i}.html`, html({ body: `<input type="submit" value="${token}">` })],
  ]);
  const byPage = evaluate(pages);
  tokens.forEach((token, i) => {
    for (const [file, where] of [[`text-${i}.html`, "text"], [`attr-${i}.html`, "attr:value"]]) {
      const rows = byPage.get(file);
      assert.deepEqual(summary(rows), [`warning/live_token ${token}`], `${token} in ${where}`);
      assert.equal(rows[0].observation.known, true);
    }
  });

  // Owned scopes still own the wider fields.
  const owned = evaluate([
    ["template.html", html({ body: "<template><p>{toggle.first-name}</p></template>" })],
    ["list.html", html({ body: "<div data-next-cart-items><p>{item.first-name}</p></div>" })],
  ]);
  for (const [file, rows] of owned) assert.deepEqual(summary(rows), ["pass/null page"], `${file}: owned`);

  // Outside the grammar: whitespace or an empty field, and a hyphenated
  // field in no SDK namespace, are not candidates.
  const outside = evaluate([
    ["space.html", html({ body: "<p>{item.first name} {item. name}</p>" })],
    ["empty.html", html({ body: "<p>{item.} {item..name} {item.name.}</p>" })],
    ["no-namespace.html", html({ body: "<p>{foo.first-name}</p>" })],
  ]);
  for (const [file, rows] of outside) assert.deepEqual(summary(rows), ["pass/null page"], `${file}: not a candidate`);

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<p>{item.first-name}</p>" }))), ["warning/live_token {item.first-name}"]);
});

test("ownership values: an element owns only when its ownership attribute value is exactly a vendored owning value; a case variant, padding or an unknown value owns nothing", async (t) => {
  // data-next-quantity owns {quantity} and {step} only at exactly increase,
  // decrease or set.
  const exact = SDK_TEMPLATE_PLACEHOLDERS.quantity_control.values;
  assert.deepEqual([...exact], ["increase", "decrease", "set"], "setup: the vendored owning values");
  const variants = ["INCREASE", "Increase", "DeCrease", "SET", " increase ", "increase\t", "\tset", "decrease\n", "decrease ", " set", "increase-all", "inc", ""];
  const quantity = (value, token) => html({ body: `<button type="button" data-next-quantity="${value}">${token}</button>` });
  const pages = [];
  for (const token of ["{quantity}", "{step}"]) {
    exact.forEach((value, i) => pages.push([`exact-${token}-${i}.html`, quantity(value, token), "pass/null page"]));
    variants.forEach((value, i) => pages.push([`variant-${token}-${i}.html`, quantity(value, token), `warning/live_token ${token}`]));
  }
  // Presence-selected attributes own at any value; the item template
  // selector resolves only as an exact #id, so a padded one is unresolved.
  const presence = [
    ["remove-item-bare.html", "<button data-next-remove-item>Remove {quantity}</button>"],
    ["remove-item-any.html", "<button data-next-remove-item=\" ANY \">Remove {quantity}</button>"],
    ["quantity-text-any.html", "<span data-next-quantity-text=\"X\">{qty+1}</span>"],
    ["cart-items-any.html", "<div data-next-cart-items=\" Yes \"><p>{item.name}</p></div>"],
    ["order-items-any.html", "<ul data-next-order-items=\"false\"><li>{line.name}</li></ul>"],
    ["selector-exact.html", "<div data-next-cart-items data-item-template-selector=\"#row\"></div>\n<div id=\"row\" hidden><p>{item.name}</p></div>"],
  ];
  for (const [file, body] of presence) pages.push([file, html({ body }), "pass/null page"]);
  for (const [file, selector] of [["selector-padded.html", " #row "], ["selector-tab.html", "#row\t"]]) {
    pages.push([file, html({ body: `<div data-next-cart-items data-item-template-selector="${selector}"></div>\n<div id="row" hidden><p>{item.name}</p></div>` }), "review/template_selector_unresolved {item.name}"]);
  }
  const byPage = evaluate(pages.map(([file, content]) => [file, content]));
  for (const [file, , expected] of pages) assert.deepEqual(summary(byPage.get(file)), [expected], file);

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, quantity("INCREASE", "{quantity}"))), ["warning/live_token {quantity}"]);
  assert.deepEqual(summary(await builtDoctor(t, quantity(" increase ", "{step}"))), ["warning/live_token {step}"]);
  assert.deepEqual(summary(await builtDoctor(t, quantity("increase", "{step}"))), ["pass/null page"]);
});

test("loader element: only a <script> a browser runs as a classic or module script supplies the pin; any other script gives none", async (t) => {
  const SRC = "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js";
  const script = (attrs) => `<script ${attrs} src="${SRC}"></script>`;
  const javascriptTypes = [
    "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
    "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
    "text/x-ecmascript", "text/x-javascript",
  ];
  const accepted = [
    `<script src="${SRC}"></script>`,
    script("type=\"\""),
    ...javascriptTypes.map((type) => script(`type="${type}"`)),
    script("type=\"TEXT/JavaScript\""),
    script("type=\" text/javascript\n\""),
    script("type=\"module\""),
    script("type=\"MODULE\""),
    script("type=\"\tmodule \""),
    script("type=\"module\" nomodule"),
    script("language=\"javascript\""),
    script("language=\"\""),
    script("type=\"\" language=\"vbscript\""),
  ];
  const refused = [
    script("type=\"application/json\""),
    script("type=\"application/ld+json\""),
    script("type=\"text/plain\""),
    script("type=\"importmap\""),
    script("type=\"speculationrules\""),
    script("type=\"text/template\""),
    script("type=\"text/babel\""),
    script("type=\"javascript\""),
    script("type=\"text/javascript; charset=utf-8\""),
    script("type=\"text/javascript \""),
    script("language=\"vbscript\""),
    script("nomodule"),
    script("type=\"text/javascript\" nomodule"),
    `<template>${script("type=\"module\"")}</template>`,
    `<noscript>${script("")}</noscript>`,
    `<svg>${script("")}</svg>`,
    `<svg><script href="${SRC}"></script></svg>`,
    `<svg><foreignObject>${script("")}</foreignObject></svg>`,
    `<math>${script("")}</math>`,
  ];
  const page = (markup) => html({ loaders: [], body: `${markup}\n${TEMPLATE_ONLY}` });
  const byPage = evaluate([
    ...accepted.map((markup, i) => [`accepted-${i}.html`, page(markup)]),
    ...refused.map((markup, i) => [`refused-${i}.html`, page(markup)]),
  ]);
  accepted.forEach((markup, i) => {
    const rows = byPage.get(`accepted-${i}.html`);
    assert.deepEqual(summary(rows), ["pass/null page"], markup);
    assert.equal(rows[0].observation.sdk_pin, "0.4.40", `${markup}: pin`);
  });
  refused.forEach((markup, i) => {
    const rows = byPage.get(`refused-${i}.html`);
    assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"], markup);
    assert.equal(rows[0].observation.sdk_pin, null, `${markup}: no pin`);
  });

  // A non-running look-alike beside the real loader adds no second version.
  const mixed = evaluate([["mixed.html", page(`${script("type=\"application/json\"").replace("v0.4.40", "v0.4.39")}\n<script src="${SRC}"></script>`)]]);
  assert.deepEqual(summary(mixed.get("mixed.html")), ["pass/null page"]);
  assert.equal(mixed.get("mixed.html")[0].observation.sdk_pin, "0.4.40");

  // End to end through doctor --built.
  for (const markup of [script("type=\"application/json\""), script("type=\"text/plain\""), `<svg>${script("")}</svg>`]) {
    const rows = await builtDoctor(t, page(markup));
    assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"], `doctor --built: ${markup}`);
    assert.equal(rows[0].observation.sdk_pin, null);
  }
  assert.deepEqual(summary(await builtDoctor(t, page(script("type=\"module\"")))), ["pass/null page"]);
});

test("read failures: an error reading a built page after the readability precheck, or reading its HTML at all, reads it unexercised (page_unreadable); nothing throws out of the check", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cart-placeholders-hardening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "_site", CAMPAIGN), { recursive: true });
  for (const name of ["a.html", "eio.html", "eacces.html", "z.html"]) writeFileSync(join(dir, "_site", CAMPAIGN, name), html({ body: TEMPLATE_ONLY }));
  // The files exist and pass the precheck; the 1.5 page collection's reads
  // of them fail (other doctor checks read them as usual).
  const failing = new Map([["eio.html", "EIO"], ["eacces.html", "EACCES"]]);
  const realRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function readFileSync(path, ...rest) {
    const inCollection = (new Error().stack || "").includes("collectCartPlaceholderPages");
    const code = inCollection ? failing.get(String(path).split(/[\\/]/).pop()) : null;
    if (code) throw Object.assign(new Error(`${code}: injected read failure`), { code });
    return realRead.call(this, path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const expected = [
    `pass/null _site/${CAMPAIGN}/a.html`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/eacces.html`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/eio.html`,
    `pass/null _site/${CAMPAIGN}/z.html`,
  ];
  const byFile = (rows) => rows.map((row) => `${row.result}/${row.reason_code} ${row.subject.page}`);
  let pages;
  assert.doesNotThrow(() => { pages = collectCartPlaceholderPages(dir, CAMPAIGN); });
  assert.deepEqual(byFile(evaluateCartPlaceholders({ pages, measuredAt: "2026-01-01T00:00:00.000Z" })), expected);
  const built = (await withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }))).derived.qc_results.filter((row) => row.check === "cart_placeholders");
  assert.deepEqual(byFile(built), expected);

  // A page whose HTML cannot be read at all inside the evaluator is
  // unreadable too.
  const throwing = { file: "throws.html", get content() { throw Object.assign(new Error("EIO: injected"), { code: "EIO" }); } };
  let rows;
  assert.doesNotThrow(() => { rows = evaluateCartPlaceholders({ pages: [throwing, { file: "ok.html", content: html({ body: TEMPLATE_ONLY }) }] }); });
  assert.deepEqual(byFile(rows), ["unexercised/page_unreadable throws.html", "pass/null ok.html"]);
  assert.equal(rows[0].accept_eligible, false);
});
