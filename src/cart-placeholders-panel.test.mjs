// Raw cart placeholders (`built_output.cart_placeholders`): ownership per
// kind, whitespace in a field, for/event scripts, the row template the SDK
// reads (CSS identifiers included), exactly balanced double braces, symbolic
// links under the campaign directory, and read failures versus defects.
// Every page here is synthetic; hosts are example.invalid.
import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { resolveBuiltSiteScope } = await import("./built-site-scope.mjs");
const { doctorBuiltOutput } = await import("./doctor/inspect.mjs");
const { collectCartPlaceholderPages } = await import("./doctor/checks.mjs");

const CAMPAIGN = "example-campaign";
const LOADER = (src) => `<script src="${src}"></script>`;
const VERIFIED_LOADER = "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js";
const html = ({ loaders = [VERIFIED_LOADER], body }) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Synthetic cart placeholder page</title>\n${loaders.map(LOADER).join("\n")}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const TEMPLATE_ONLY = "<template><div class=\"cart-row\"><span>{item.name}</span></div></template>\n<p>Synthetic cart page.</p>";

// One page per entry, evaluated together; the rows of each page.
function evaluate(pages) {
  const rows = evaluateCartPlaceholders({ pages: pages.map(([file, content]) => ({ file, content })), measuredAt: "2026-01-01T00:00:00.000Z" });
  const byPage = new Map(pages.map(([file]) => [file, []]));
  for (const row of rows) byPage.get(row.subject.page).push(row);
  return byPage;
}
const summary = (rows) => rows.map((row) => `${row.result}/${row.reason_code} ${row.subject.key}`);
const byFile = (rows) => rows.map((row) => `${row.result}/${row.reason_code} ${row.subject.page}`);

function builtTree(t) {
  const dir = mkdtempSync(join(tmpdir(), "cart-placeholders-panel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "_site", CAMPAIGN), { recursive: true });
  return dir;
}
async function builtDoctorRows(dir) {
  const result = await withNoNetwork(() => doctorBuiltOutput({ built: dir, slug: CAMPAIGN }));
  return (result.derived.qc_results || []).filter((row) => row.check === "cart_placeholders");
}
async function builtDoctor(t, content) {
  const dir = builtTree(t);
  writeFileSync(join(dir, "_site", CAMPAIGN, "index.html"), content);
  return builtDoctorRows(dir);
}

test("ownership per kind: an item list owns only its descendants and quantity text only its text content, so their own text attributes are live; a <template> and the row template an item list reads own their own attributes too", async (t) => {
  // [page, body, expected rows]
  const cases = [
    // The item list's and quantity text's own attributes print as written.
    ["cart-items-title.html", "<div data-next-cart-items title=\"{item.name}\"><p>{item.price}</p></div>", ["warning/live_token {item.name}"]],
    ["cart-items-aria.html", "<div data-next-cart-items aria-label=\"{subtotal}\"></div>", ["warning/live_token {subtotal}"]],
    ["order-items-aria.html", "<ul data-next-order-items aria-label=\"{subtotal}\"><li>{line.name}</li></ul>", ["warning/live_token {subtotal}"]],
    ["order-items-title.html", "<ul data-next-order-items title=\"{item.name}\"></ul>", ["warning/live_token {item.name}"]],
    ["quantity-text-qty.html", "<span data-next-quantity-text=\"{qty} items\" title=\"{qty}\">1 item</span>", ["warning/live_token {qty}"]],
    ["quantity-text-qty-plus.html", "<span data-next-quantity-text=\"{qty} items\" aria-label=\"{qty+1}\">1 item</span>", ["warning/live_token {qty+1}"]],
    ["input-list.html", "<input type=\"submit\" data-next-cart-items value=\"{item.name}\">", ["warning/live_token {item.name}"]],
    // What is inside them stays owned.
    ["cart-items-inside.html", "<div data-next-cart-items><p title=\"{item.name}\">{item.price}</p></div>", ["pass/null page"]],
    ["order-items-inside.html", "<ul data-next-order-items><li aria-label=\"{line.total}\">{line.name}</li></ul>", ["pass/null page"]],
    ["quantity-text-inside.html", "<span data-next-quantity-text=\"{qty} items\">{qty} {qty*2}</span>", ["pass/null page"]],
    // A <template> and a row template own their own attributes and content.
    ["template-self.html", "<template title=\"{item.name}\"><p>{item.price}</p></template>", ["pass/null page"]],
    ["selector-row-self.html", "<div data-next-cart-items data-item-template-selector=\"#row\"></div>\n<div id=\"row\" hidden title=\"{item.name}\"><p>{item.price}</p></div>", ["pass/null page"]],
    ["id-row-self.html", "<div data-next-cart-items data-item-template-id=\"row\"></div>\n<div id=\"row\" hidden title=\"{item.name}\"><p>{item.price}</p></div>", ["pass/null page"]],
    ["order-id-row-self.html", "<div data-next-order-items data-item-template-id=\"row\"></div>\n<div id=\"row\" hidden aria-label=\"{item.name}\">{item.price}</div>", ["pass/null page"]],
  ];
  const byPage = evaluate(cases.map(([file, body]) => [file, html({ body })]));
  for (const [file, , expected] of cases) assert.deepEqual(summary(byPage.get(file)), expected, file);
  assert.deepEqual(byPage.get("cart-items-title.html")[0].observation.occurrences.map((o) => o.where), ["attr:title"]);
  assert.deepEqual(byPage.get("quantity-text-qty.html")[0].observation.occurrences.map((o) => o.where), ["attr:title"]);

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: cases[0][1] }))), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(await builtDoctor(t, html({ body: cases[4][1] }))), ["warning/live_token {qty}"]);
});

test("field grammar: a field is any run of characters other than a brace or `.`, whitespace included, so {package.product title} and {item.property.delivery note} read warning (live_token) when live", async (t) => {
  const fields = ["product title", "property.delivery note", "a\tb", "line\nbreak", "nb sp", " lead", "trail ", "a b.c d"];
  const tokens = SDK_TEMPLATE_PLACEHOLDERS.namespaces.flatMap((namespace) => fields.map((field) => `{${namespace}.${field}}`));
  const pages = tokens.flatMap((token, i) => [
    [`text-${i}.html`, html({ body: `<p>${token}</p>` })],
    [`attr-${i}.html`, html({ body: `<img src="data:," title="${token}">` })],
  ]);
  const byPage = evaluate(pages);
  tokens.forEach((token, i) => {
    for (const [file, where] of [[`text-${i}.html`, "text"], [`attr-${i}.html`, "attr:title"]]) {
      const rows = byPage.get(file);
      assert.deepEqual(summary(rows), [`warning/live_token ${token}`], `${JSON.stringify(token)} in ${where}`);
      assert.equal(rows[0].observation.known, true);
    }
  });

  // Owned scopes own them; outside a namespace, or with an empty field, they
  // are still not candidates.
  const other = evaluate([
    ["template.html", html({ body: "<template><p>{package.product title}</p></template>" })],
    ["list.html", html({ body: "<div data-next-cart-items><p>{item.property.delivery note}</p></div>" })],
    ["no-namespace.html", html({ body: "<p>{foo.product title} {not a token}</p>" })],
    ["empty.html", html({ body: "<p>{item.} {item.a..b}</p>" })],
  ]);
  for (const [file, rows] of other) assert.deepEqual(summary(rows), ["pass/null page"], file);

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<p>{package.product title}</p>\n<p>{item.property.delivery note}</p>" }))), [
    "warning/live_token {package.product title}",
    "warning/live_token {item.property.delivery note}",
  ]);
});

test("loader eligibility: a classic script with both `for` and `event` never runs unless it is the window's onload handler, so it supplies no pin", async (t) => {
  const SRC = "https://cdn.example.invalid/campaign-cart@v0.4.40/dist/loader.js";
  const script = (attrs) => `<script ${attrs} src="${SRC}"></script>`;
  // [markup, runs]
  const table = [
    [script("for=\"button\" event=\"onclick\""), false],
    [script("for=\"window\" event=\"onclick\""), false],
    [script("for=\"button\" event=\"onload\""), false],
    [script("for=\"\" event=\"\""), false],
    [script("for event"), false],
    [script("type=\"text/javascript\" for=\"document\" event=\"onload\""), false],
    [script("for=\"windows\" event=\"onload\""), false],
    [script("for=\"window\" event=\"onload\""), true],
    [script("for=\"window\" event=\"onload()\""), true],
    [script("for=\" WINDOW\t\" event=\"\nOnLoad() \""), true],
    [script("for=\"button\""), true],
    [script("event=\"onclick\""), true],
    // A module script is not subject to the rule.
    [script("type=\"module\" for=\"button\" event=\"onclick\""), true],
  ];
  const page = (markup) => html({ loaders: [], body: `${markup}\n${TEMPLATE_ONLY}` });
  const byPage = evaluate(table.map(([markup], i) => [`case-${i}.html`, page(markup)]));
  table.forEach(([markup, runs], i) => {
    const rows = byPage.get(`case-${i}.html`);
    assert.deepEqual(summary(rows), [runs ? "pass/null page" : "unexercised/sdk_pin_unknown page"], markup);
    assert.equal(rows[0].observation.sdk_pin, runs ? "0.4.40" : null, `${markup}: pin`);
  });

  // A non-running loader beside the real one adds no second version.
  const mixed = evaluate([["mixed.html", page(`${script("for=\"button\" event=\"onclick\"").replace("v0.4.40", "v0.4.39")}\n<script src="${SRC}"></script>`)]]);
  assert.deepEqual(summary(mixed.get("mixed.html")), ["pass/null page"]);
  assert.equal(mixed.get("mixed.html")[0].observation.sdk_pin, "0.4.40");

  // End to end through doctor --built.
  const rows = await builtDoctor(t, page(table[0][0]));
  assert.deepEqual(summary(rows), ["unexercised/sdk_pin_unknown page"]);
  assert.equal(rows[0].observation.sdk_pin, null);
});

test("row template resolution matches the SDK: a non-empty data-item-template-id wins over the selector, an empty attribute is not read, and a selector that is no valid CSS selector is unresolved", async (t) => {
  const ROW = "<div id=\"row\" hidden><p>{item.name}</p></div>";
  const TPL = "<template id=\"tpl\"><p>{item.price}</p></template>";
  const list = (attrs) => `<div data-next-cart-items ${attrs}></div>`;
  // [page, body, expected rows]
  const cases = [
    // The id wins: the selector's target is never read, so its token is live.
    ["id-wins.html", `${list("data-item-template-id=\"tpl\" data-item-template-selector=\"#row\"")}\n${TPL}\n${ROW}`, ["warning/live_token {item.name}"]],
    ["id-wins-missing.html", `${list("data-item-template-id=\"nowhere\" data-item-template-selector=\"#row\"")}\n${ROW}`, ["warning/live_token {item.name}"]],
    ["id-wins-order.html", `<ul data-next-order-items data-item-template-id="tpl" data-item-template-selector="#row"></ul>\n${TPL}\n${ROW}`, ["warning/live_token {item.name}"]],
    // With an id, an unresolvable selector is never read either.
    ["id-wins-unresolvable.html", `${list("data-item-template-id=\"tpl\" data-item-template-selector=\".row-tpl\"")}\n${TPL}\n${ROW}`, ["warning/live_token {item.name}"]],
    // An empty id falls through to the selector; an empty selector to the list.
    ["empty-id.html", `${list("data-item-template-id=\"\" data-item-template-selector=\"#row\"")}\n${ROW}`, ["pass/null page"]],
    ["empty-selector.html", `${list("data-item-template-selector=\"\"")}\n${ROW}`, ["warning/live_token {item.name}"]],
    // Not a valid CSS selector: the SDK's querySelector throws.
    ["digit.html", `${list("data-item-template-selector=\"#1row\"")}\n<div id="1row" hidden><p>{item.name}</p></div>`, ["review/template_selector_unresolved {item.name}"]],
    ["dash-digit.html", `${list("data-item-template-selector=\"#-1row\"")}\n<div id="-1row" hidden><p>{item.name}</p></div>`, ["review/template_selector_unresolved {item.name}"]],
    ["hash-only.html", `${list("data-item-template-selector=\"#\"")}\n${ROW}`, ["review/template_selector_unresolved {item.name}"]],
    // Valid #id selectors resolve.
    ["dash.html", `${list("data-item-template-selector=\"#-row\"")}\n<div id="-row" hidden><p>{item.name}</p></div>`, ["pass/null page"]],
    ["double-dash.html", `${list("data-item-template-selector=\"#--1\"")}\n<div id="--1" hidden><p>{item.name}</p></div>`, ["pass/null page"]],
    ["underscore.html", `${list("data-item-template-selector=\"#_row-2\"")}\n<div id="_row-2" hidden><p>{item.name}</p></div>`, ["pass/null page"]],
  ];
  const byPage = evaluate(cases.map(([file, body]) => [file, html({ body })]));
  for (const [file, , expected] of cases) assert.deepEqual(summary(byPage.get(file)), expected, file);

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: cases[0][1] }))), ["warning/live_token {item.name}"]);
  assert.deepEqual(summary(await builtDoctor(t, html({ body: cases[6][1] }))), ["review/template_selector_unresolved {item.name}"]);
});

test("a symbolic link under the campaign directory is one unexercised (page_unreadable) row at its path, never followed, when it is named .html, points at a directory, or points at something that cannot be inspected; a link to a regular file not named .html is no page and no row; existing page-scope callers are unchanged", async (t) => {
  const dir = builtTree(t);
  const campaign = join(dir, "_site", CAMPAIGN);
  writeFileSync(join(campaign, "index.html"), html({ body: TEMPLATE_ONLY }));
  mkdirSync(join(dir, "elsewhere", "checkout"), { recursive: true });
  writeFileSync(join(dir, "elsewhere", "checkout", "index.html"), html({ body: "<p>{item.name}</p>" }));
  // Links to directories.
  symlinkSync(join("..", "..", "elsewhere", "checkout"), join(campaign, "checkout"));
  mkdirSync(join(campaign, "nested"));
  symlinkSync(join("..", "..", "..", "elsewhere"), join(campaign, "nested", "more"));
  // Links named .html (any case): one to a page, one to nothing.
  symlinkSync(join("..", "..", "elsewhere", "checkout", "index.html"), join(campaign, "offer.html"));
  symlinkSync("missing.html", join(campaign, "Gone.HTML"));
  // A link to a regular file not named .html: no page.
  writeFileSync(join(dir, "elsewhere", "logo.svg"), "<svg/>");
  symlinkSync(join("..", "..", "elsewhere", "logo.svg"), join(campaign, "logo.svg"));
  // A dangling link (ENOENT), a link to itself (ELOOP), and a link to a
  // directory inside an unsearchable one (EACCES), none named .html.
  symlinkSync("missing-dir", join(campaign, "dangling"));
  symlinkSync("loop", join(campaign, "loop"));
  mkdirSync(join(dir, "elsewhere", "locked", "checkout"), { recursive: true });
  writeFileSync(join(dir, "elsewhere", "locked", "checkout", "index.html"), html({ body: "<p>{item.name}</p>" }));
  symlinkSync(join("..", "..", "elsewhere", "locked", "checkout"), join(campaign, "locked"));

  const expected = [
    `unexercised/page_unreadable _site/${CAMPAIGN}/Gone.HTML`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/checkout`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/dangling`,
    `pass/null _site/${CAMPAIGN}/index.html`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/locked`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/loop`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/nested/more`,
    `unexercised/page_unreadable _site/${CAMPAIGN}/offer.html`,
  ];
  chmodSync(join(dir, "elsewhere", "locked"), 0o000);
  try {
    assert.throws(() => fs.statSync(join(campaign, "locked")), { code: "EACCES" }, "setup: the locked target cannot be stat'ed");
    assert.throws(() => fs.statSync(join(campaign, "loop")), { code: "ELOOP" }, "setup: the loop cannot be stat'ed");
    assert.equal(fs.statSync(join(campaign, "logo.svg")).isFile(), true, "setup: the .svg link reaches a regular file");
    const pages = collectCartPlaceholderPages(dir, CAMPAIGN);
    assert.deepEqual(byFile(evaluateCartPlaceholders({ pages, measuredAt: "2026-01-01T00:00:00.000Z" })), expected);
    assert.deepEqual(byFile(await builtDoctorRows(dir)), expected);
  } finally {
    chmodSync(join(dir, "elsewhere", "locked"), 0o755);
  }

  // Inspecting a link's target catches only file-system errors: an injected
  // EACCES reads the target uninspectable (the .svg link becomes a row, the
  // directory link stays one); an injected TypeError throws. A link named
  // .html is a row without its target being inspected.
  const inject = new Map();
  const realStat = fs.statSync;
  t.mock.method(fs, "statSync", function statSync(path, ...rest) {
    if (inject.has(String(path))) throw inject.get(String(path));
    return realStat.call(this, path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const rowsNow = () => byFile(evaluateCartPlaceholders({ pages: collectCartPlaceholderPages(dir, CAMPAIGN), measuredAt: "2026-01-01T00:00:00.000Z" }));
  const eacces = () => Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
  inject.set(join(campaign, "checkout"), eacces());
  inject.set(join(campaign, "logo.svg"), eacces());
  inject.set(join(campaign, "offer.html"), new TypeError("injected defect"));
  assert.deepEqual(rowsNow(), [...expected.slice(0, 5), `unexercised/page_unreadable _site/${CAMPAIGN}/logo.svg`, ...expected.slice(5)], "EACCES");
  for (const name of ["checkout", "logo.svg"]) {
    const defect = new TypeError(`injected defect at ${name}`);
    inject.clear();
    inject.set(join(campaign, name), defect);
    assert.throws(() => collectCartPlaceholderPages(dir, CAMPAIGN), (thrown) => thrown === defect, defect.message);
  }
  inject.clear();

  // Without the option the page scope is as before: only real pages, no
  // linked entries.
  const scope = resolveBuiltSiteScope(dir, { slug: CAMPAIGN });
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.pages.map((page) => page.route), [""]);
  assert.equal("linked_pages" in scope, false);
  const linked = resolveBuiltSiteScope(dir, { slug: CAMPAIGN, includeLinkedPages: true });
  assert.deepEqual(linked.pages, scope.pages);
  assert.deepEqual(linked.linked_pages.map((page) => page.route), ["Gone", "checkout", "dangling", "locked", "loop", "nested/more", "offer"]);
});

test("read failures versus defects: a file-system read failure reads the page unexercised (page_unreadable); any other error throws out of the check", async (t) => {
  const page = (file, error) => ({ file, get content() { throw error; } });
  const ok = { file: "ok.html", content: html({ body: TEMPLATE_ONLY }) };
  for (const code of ["ENOENT", "EACCES", "EIO", "ELOOP", "EISDIR", "ENOTDIR"]) {
    const rows = evaluateCartPlaceholders({ pages: [page("bad.html", Object.assign(new Error(`${code}: injected`), { code })), ok] });
    assert.deepEqual(byFile(rows), ["unexercised/page_unreadable bad.html", "pass/null ok.html"], code);
  }
  for (const error of [new TypeError("injected defect"), new ReferenceError("injected defect"), new assert.AssertionError({ message: "injected defect" }), new Error("no code"), Object.assign(new Error("odd code"), { code: "ERR_INVALID_ARG_TYPE" }), new RangeError("Invalid array length")]) {
    assert.throws(() => evaluateCartPlaceholders({ pages: [page("bad.html", error), ok] }), (thrown) => thrown === error, `${error.name}: ${error.message}`);
  }

  // The page collection reads the same in every helper that probes the file
  // system (the readability precheck and the read itself): an injected
  // TypeError throws, an injected file-system error reads unreadable.
  const dir = builtTree(t);
  for (const name of ["a.html", "defect.html"]) writeFileSync(join(dir, "_site", CAMPAIGN, name), html({ body: TEMPLATE_ONLY }));
  const inject = { readFileSync: null, accessSync: null };
  for (const name of Object.keys(inject)) {
    const real = fs[name];
    t.mock.method(fs, name, function injected(path, ...rest) {
      const inCollection = (new Error().stack || "").includes("collectCartPlaceholderPages");
      if (inject[name] && inCollection && String(path).endsWith("defect.html")) throw inject[name];
      return real.call(this, path, ...rest);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const name of Object.keys(inject)) {
    for (const key of Object.keys(inject)) inject[key] = null;
    inject[name] = new TypeError("injected defect");
    assert.throws(() => collectCartPlaceholderPages(dir, CAMPAIGN), (thrown) => thrown === inject[name], `${name}: TypeError`);
    for (const code of ["EIO", "EACCES"]) {
      inject[name] = Object.assign(new Error(`${code}: injected`), { code });
      assert.deepEqual(byFile(evaluateCartPlaceholders({ pages: collectCartPlaceholderPages(dir, CAMPAIGN) })), [
        `pass/null _site/${CAMPAIGN}/a.html`,
        `unexercised/page_unreadable _site/${CAMPAIGN}/defect.html`,
      ], `${name}: ${code}`);
    }
  }
});

test("double braces: only an exactly balanced {{...}} (one brace each side, no further brace next to either) leaves its inner pair to the double-brace check; any other brace run leaves it a candidate, at the start, middle or end of text or an attribute", async (t) => {
  // [form, expected rows]
  const forms = [
    ["{{{item.name}}", ["warning/live_token {item.name}"]],
    ["{{{item.name}}}", ["warning/live_token {item.name}"]],
    ["{{item.name}}}", ["warning/live_token {item.name}"]],
    ["{{{{item.name}}}}", ["warning/live_token {item.name}"]],
    ["}{{item.name}}", ["warning/live_token {item.name}"]],
    ["{{item.name}}{", ["warning/live_token {item.name}"]],
    ["{{{subtotal}}", ["warning/live_token {subtotal}"]],
    ["{{{tax}}}", ["review/unknown_brace"]],
    // Exactly balanced: left to the double-brace check.
    ["{{item.name}}", ["pass/null page"]],
    ["{{tax}}", ["pass/null page"]],
  ];
  const positions = [(form) => form, (form) => `${form} tail`, (form) => `head ${form} tail`, (form) => `head ${form}`];
  const locations = [(text) => `<p>${text}</p>`, (text) => `<img src="data:," alt="${text}">`, (text) => `<img src="data:," title="${text}">`];
  const cases = forms.flatMap(([form, expected]) => positions.flatMap((at) => locations.map((where) => ({ body: where(at(form)), expected }))));
  const byPage = evaluate(cases.map(({ body }, i) => [`case-${i}.html`, html({ body })]));
  // An unknown brace's key is a hash, so it is compared by reason alone.
  const seen = (rows) => rows.map((row) => (row.reason_code === "unknown_brace" ? "review/unknown_brace" : `${row.result}/${row.reason_code} ${row.subject.key}`));
  cases.forEach(({ body, expected }, i) => assert.deepEqual(seen(byPage.get(`case-${i}.html`)), expected, body));

  // End to end through doctor --built: the unbalanced form at the start of text.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: "<p>{{{item.name}}</p>" }))), ["warning/live_token {item.name}"]);
});

test("row template selector: an #id selector is read per CSS identifier syntax, non-ASCII code points and escapes included, and resolved by id; a string that is no valid selector stays unresolved", async (t) => {
  const row = (id) => `<div id="${id}" hidden><p>{item.name}</p></div>`;
  const list = (selector) => `<div data-next-cart-items data-item-template-selector="${selector}"></div>`;
  // [selector, the row's id, expected rows]
  const cases = [
    // Valid: resolved by the id the identifier names.
    ["#résumé", "résumé", ["pass/null page"]],
    ["#行", "行", ["pass/null page"]],
    ["#😀row", "😀row", ["pass/null page"]],
    ["#-é", "-é", ["pass/null page"]],
    [String.raw`#\31 row`, "1row", ["pass/null page"]],
    [String.raw`#\31row`, "1row", ["pass/null page"]],
    [String.raw`#\000031 row`, "1row", ["pass/null page"]],
    [String.raw`#r\E9sum\E9`, "résumé", ["pass/null page"]],
    [String.raw`#-\31 row`, "-1row", ["pass/null page"]],
    [String.raw`#\-row`, "-row", ["pass/null page"]],
    [String.raw`#a\.b`, "a.b", ["pass/null page"]],
    // Resolved by id: an escape names its decoded id, never its spelling.
    [String.raw`#\31 row`, String.raw`\31 row`, ["warning/live_token {item.name}"]],
    // Not a valid selector, or not an #id selector: unresolved.
    ["#1row", "1row", ["review/template_selector_unresolved {item.name}"]],
    ["#-1row", "-1row", ["review/template_selector_unresolved {item.name}"]],
    ["#résumé!", "résumé!", ["review/template_selector_unresolved {item.name}"]],
    ["##résumé", "#résumé", ["review/template_selector_unresolved {item.name}"]],
    ["#rés umé", "rés umé", ["review/template_selector_unresolved {item.name}"]],
    [" #résumé", "résumé", ["review/template_selector_unresolved {item.name}"]],
    ["résumé", "résumé", ["review/template_selector_unresolved {item.name}"]],
  ];
  const byPage = evaluate(cases.map(([selector, id], i) => [`case-${i}.html`, html({ body: `${list(selector)}\n${row(id)}` })]));
  cases.forEach(([selector, id, expected], i) => assert.deepEqual(summary(byPage.get(`case-${i}.html`)), expected, `${selector} -> id ${id}`));

  // End to end through doctor --built.
  assert.deepEqual(summary(await builtDoctor(t, html({ body: `${list("#résumé")}\n${row("résumé")}` }))), ["pass/null page"]);
  assert.deepEqual(summary(await builtDoctor(t, html({ body: `${list(String.raw`#\31 row`)}\n${row("1row")}` }))), ["pass/null page"]);
});

test("this file's header and test names state behaviour in plain words, with no item labels or process names", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const header = source.slice(0, source.indexOf("\nimport ")).split("\n").filter((line) => line.startsWith("//")).join("\n");
  const names = [...source.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((match) => match[1]);
  assert.ok(header.length > 0, "setup: a header");
  assert.ok(names.length > 0, "setup: the test names");
  const PROCESS_WORDS = /\b[A-Z]\d+(?:-[A-Z]?\d+)?\b|\b(?:PR|panel|findings?|reviewers?|verdict|director|Kilo|Opus|Codex)\b/i;
  for (const text of [header, ...names]) assert.doesNotMatch(text, PROCESS_WORDS);
});
