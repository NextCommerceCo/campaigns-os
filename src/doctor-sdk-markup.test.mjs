// Static SDK markup checks (#303, #529): the seven codes through the real
// `doctor --built` entry point over the committed bad/good fixture pairs,
// plus the evaluator edge cases the fixtures do not isolate (default swap
// mode, upsell-context exemption, template ownership, unknown attributes,
// registration and non-waivability).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { SDK_ATTRIBUTE_INDEX_VERSION, SDK_CHECKOUT_FIELD_NAMES_SINCE, SDK_DATA_NEXT_ATTRIBUTES, isIndexedSdkAttribute, isKnownCheckoutFieldName } from "./sdk-attribute-index.mjs";
import { SDK_MARKUP, SDK_MARKUP_CODES, evaluateSdkMarkup, scanPageMarkup } from "./sdk-markup.mjs";

const FIXTURE_ROOT = resolve(new URL("../fixtures/sdk-markup", import.meta.url).pathname);
const SLUG = "example-campaign";
const gateOf = (result) => (result.derived?.checkpoint_gates || []).find((gate) => gate.id === SDK_MARKUP) || null;
const markupCodes = (issues) => issues.map((issue) => issue.code).filter((code) => code.startsWith(SDK_MARKUP));
const fixture = (name, variant) => doctorBuiltOutput({ built: join(FIXTURE_ROOT, name, variant), slug: SLUG });

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-sdk-markup-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePage(repo, route, body, pageType = "product") {
  const dir = join(repo, "_site", SLUG, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><head><meta name="next-funnel" content="Example"><meta name="next-page-type" content="${pageType}"></head><body>${body}</body></html>`);
}

const page = (body) => ({ page_id: "p", file: "p.html", content: `<html><body>${body}</body></html>` });
const codeNames = (gate) => [...gate.findings, ...gate.warned].map((item) => item.code_name).sort();

// --- The committed bad/good pairs, one per code ---------------------------------

const BLOCKERS = ["swap-with-add-to-cart", "checkout-not-form", "wrong-field-name", "missing-selector-id-match", "orphaned-upsell-action"];
const ADVISORIES = ["double-selected", "template-double-brace"];
// The literal code string, not a SDK_MARKUP_CODES lookup, so a fixture whose
// code is missing fails on its behavioural assertion rather than a TypeError.
const codeFor = (name) => `${SDK_MARKUP}.${name.replace(/-/g, "_")}`;

for (const name of BLOCKERS) {
  test(`${name}: the bad tree blocks under its own code and the good tree is clean`, () => {
    const bad = fixture(name, "bad");
    assert.equal(bad.ok, false, `${name}/bad must block`);
    assert.equal(bad.status, "blocked");
    assert.ok(markupCodes(bad.errors).every((code) => code === codeFor(name)), `${name}/bad raised ${markupCodes(bad.errors)}`);
    assert.ok(markupCodes(bad.errors).length >= 1);
    assert.match(bad.errors.find((issue) => issue.code === codeFor(name)).message, new RegExp(`^${name.toUpperCase().replace(/-/g, "_")}: `), "the message leads with the kit's code");
    assert.equal(gateOf(bad).status, "blocked");
    assert.equal(gateOf(bad).waivable, false);

    const good = fixture(name, "good");
    assert.equal(good.ok, true, `${name}/good must not block: ${JSON.stringify(good.errors)}`);
    assert.deepEqual(markupCodes([...good.errors, ...good.warnings]), []);
    assert.equal(gateOf(good).status, "pass");
  });
}

for (const name of ADVISORIES) {
  test(`${name}: the bad tree warns under its own code without blocking, and the good tree is clean`, () => {
    const bad = fixture(name, "bad");
    assert.equal(bad.ok, true, `${name}/bad is advisory and must not block`);
    assert.deepEqual(markupCodes(bad.errors), []);
    assert.deepEqual(markupCodes(bad.warnings), [codeFor(name)]);
    assert.equal(gateOf(bad).status, "pass");
    assert.equal(gateOf(bad).code, `${SDK_MARKUP}.advisories`);
    assert.ok(bad.ready.some((note) => /SDK markup checks passed on 1 built page\(s\) with 1 advisory finding\(s\)/.test(note)));

    const good = fixture(name, "good");
    assert.deepEqual(markupCodes([...good.errors, ...good.warnings]), []);
    assert.equal(gateOf(good).code, `${SDK_MARKUP}.pass`);
  });
}

test("wrong-field-name names the SDK spelling for the usual offenders", () => {
  const messages = fixture("wrong-field-name", "bad").errors.map((issue) => issue.message).join("\n");
  assert.match(messages, /"firstName".*the SDK spelling is "fname"/);
  assert.match(messages, /"lastName".*the SDK spelling is "lname"/);
  assert.match(messages, /"zip".*the SDK spelling is "postal"/);
  assert.match(messages, new RegExp(`SDK ${SDK_ATTRIBUTE_INDEX_VERSION.replace(/\\./g, "\\\\.")} maps`));
});

// #529 negative control: a downsell's "No thanks" link beside its offer
// container, not inside it. The SDK never bound it, decline went to "#", and
// every earlier check passed.
test("orphaned-upsell-action: the skip link beside its offer container blocks doctor --built, naming page, action and fix", () => {
  const bad = fixture("orphaned-upsell-action", "bad");
  assert.equal(bad.ok, false);
  const gate = gateOf(bad);
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.findings.map((item) => [item.code_name, item.detail.action]), [["ORPHANED_UPSELL_ACTION", "skip"]]);
  const issue = bad.errors.find((error) => error.code === SDK_MARKUP_CODES.ORPHANED_UPSELL_ACTION.code);
  assert.match(issue.message, /downsell-1/);
  assert.match(issue.message, /data-next-upsell-action="skip"/);
  assert.match(issue.message, /Move it inside the data-next-upsell container/);
});

// --- Evaluator edges ---------------------------------------------------------------

test("SWAP_WITH_ADD_TO_CART also fires on the SDK default (no selection-mode), and says so", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-bundle-selector data-next-selector-id="m"></div><button data-next-action="add-to-cart" data-next-selector-id="m"></button>')] });
  assert.deepEqual(codeNames(gate), ["SWAP_WITH_ADD_TO_CART"]);
  assert.match(gate.findings[0].message, /the SDK default; no data-next-selection-mode set/);
  assert.equal(gate.findings[0].detail.selection_mode_explicit, false);
});

test("an upsell-context selector is select mode by construction and is exempt from SWAP_WITH_ADD_TO_CART", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-bundle-selector data-next-upsell-context data-next-selector-id="u"></div><button data-next-action="add-to-cart" data-next-selector-id="u"></button>')] });
  assert.equal(gate.status, "pass");
});

test("an add-to-cart button with no selector link owes nothing to MISSING_SELECTOR_ID_MATCH", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<button data-next-action="add-to-cart" data-next-package-id="12"></button>')] });
  assert.equal(gate.status, "pass");
});

test("ORPHANED_UPSELL_ACTION blocks on every page type, not only upsell pages, and an action inside its container passes", () => {
  for (const pageType of ["checkout", "upsell", "downsell", "receipt", "product"]) {
    withTempDir((repo) => {
      writePage(repo, "offer", '<div data-next-upsell="offer"></div><button data-next-upsell-action="add">Yes</button>', pageType);
      const result = doctorBuiltOutput({ built: repo, slug: SLUG });
      assert.equal(result.ok, false, `${pageType} page must block`);
      assert.deepEqual(markupCodes(result.errors), [SDK_MARKUP_CODES.ORPHANED_UPSELL_ACTION.code], pageType);
    });
  }
  // Inside its container it passes however deep it sits, including inside a
  // template the SDK clones.
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-upsell="offer"><div><p><a data-next-upsell-action="skip" href="#">No</a></p></div><template><button data-next-upsell-action="add">Yes</button></template></div>')] });
  assert.equal(gate.status, "pass");
});

test("ORPHANED_UPSELL_ACTION names what the shopper cannot do: accept for add/accept, decline for skip/decline; an empty container still counts", () => {
  const cases = [["add", "cannot accept"], ["accept", "cannot accept"], ["skip", "cannot decline"], ["DECLINE", "cannot decline"], ["other", "cannot act on"]];
  for (const [value, phrase] of cases) {
    const gate = evaluateSdkMarkup({ pages: [page(`<div data-next-upsell="offer"></div><button data-next-upsell-action="${value}">x</button>`)] });
    assert.equal(gate.findings.length, 1, value);
    assert.match(gate.findings[0].message, new RegExp(phrase), value);
  }
  // The SDK creates the upsell enhancer for data-next-upsell with any value or none.
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-upsell=""><button data-next-upsell-action="add">Yes</button></div>')] });
  assert.equal(gate.status, "pass");
});

test("CHECKOUT_NOT_FORM is about data-next-checkout exactly, not the checkout-field / -review / -step attributes", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<form data-next-checkout><div data-next-checkout-step="1"><input data-next-checkout-field="email"><span data-next-checkout-review="email"></span></div></form>')] });
  assert.equal(gate.status, "pass");
});

test("DOUBLE_SELECTED counts cards inside the selector only, through nested wrappers, never across selectors", () => {
  const gate = evaluateSdkMarkup({ pages: [page(
    '<div data-next-bundle-selector data-next-selector-id="a"><div class="grid"><div data-next-bundle-card data-next-selected="true"></div><div><div data-next-bundle-card data-next-selected="true"></div></div></div></div>'
    + '<div data-next-bundle-selector data-next-selector-id="b"><div data-next-bundle-card data-next-selected="true"></div></div>',
  )] });
  assert.deepEqual(codeNames(gate), ["DOUBLE_SELECTED"]);
  assert.deepEqual([gate.warned[0].detail.selector_id, gate.warned[0].detail.selected_count], ["a", 2]);
});

test("TEMPLATE_DOUBLE_BRACE covers a template referenced by a *-template-id attribute and one nested in an SDK container, in text or attribute values", () => {
  const referenced = evaluateSdkMarkup({ pages: [page('<div data-next-bundle-selector data-next-bundle-slot-template-id="slot"></div><template id="slot"><img alt="{{slot.name}}"></template>')] });
  assert.deepEqual(codeNames(referenced), ["TEMPLATE_DOUBLE_BRACE"]);
  assert.equal(referenced.warned[0].detail.template_id, "slot");
  const nested = evaluateSdkMarkup({ pages: [page('<div data-next-cart-summary><template><li>{{ item.title }}</li></template></div>')] });
  assert.deepEqual(codeNames(nested), ["TEMPLATE_DOUBLE_BRACE"]);
  assert.match(nested.warned[0].message, /single-brace \(\{item\.title\}\)/);
  const foreign = evaluateSdkMarkup({ pages: [page('<template id="vendor"><div>{{vendor.token}}</div></template>')] });
  assert.equal(foreign.status, "pass");
});

test("a vendor template nested inside SDK chrome is not SDK-owned: only a container's direct <template> child is read", () => {
  const nested = evaluateSdkMarkup({ pages: [page('<div data-next-cart-summary><template><span>{item.name}</span></template><div class="promo"><template id="vendor"><b>{{vendor}}</b></template></div></div>')] });
  assert.equal(nested.status, "pass");
  assert.deepEqual(nested.warned, []);
  const discounts = evaluateSdkMarkup({ pages: [page('<div data-next-cart-summary><div data-next-discounts="offer"><template><span>{{discount.percentage}}</span></template></div></div>')] });
  assert.deepEqual(codeNames(discounts), ["TEMPLATE_DOUBLE_BRACE"]);
});

test("MISSING_SELECTOR_ID_MATCH is not satisfied by a non-selector element echoing the id, and reports one finding per dead id", () => {
  const echoed = evaluateSdkMarkup({ pages: [page('<span data-next-quantity-display data-next-selector-id="main"></span><button data-next-action="add-to-cart" data-next-selector-id="main"></button><button data-next-action="add-to-cart" data-next-selector-id="main"></button>')] });
  assert.deepEqual(codeNames(echoed), ["MISSING_SELECTOR_ID_MATCH"]);
  assert.equal(echoed.findings[0].detail.buttons, 2);
  assert.match(echoed.findings[0].message, /2 add-to-cart buttons/);
  const real = evaluateSdkMarkup({ pages: [page('<div data-next-package-selector data-next-selector-id="main" data-next-selection-mode="select"></div><button data-next-action="add-to-cart" data-next-selector-id="main"></button>')] });
  assert.equal(real.status, "pass");
});

test("a checkout order bump with data-next-is-upsell=\"true\" is not a finding: the upsell tag is the intended default", () => {
  const content = '<html><head><meta name="next-page-type" content="checkout"></head><body><div data-next-package-toggle><div data-next-toggle-card data-next-is-upsell="true" data-next-package-id="7"></div></div></body></html>';
  const gate = evaluateSdkMarkup({ pages: [{ page_id: "checkout", file: "checkout.html", content }] });
  assert.deepEqual(codeNames(gate), []);
  assert.equal(gate.status, "pass");
});

test("markup inside an SDK <template> is scanned, because the SDK clones it into the live DOM", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-cart-summary><template><div data-next-checkout><input data-next-checkout-field="zip"></div></template></div>')] });
  assert.deepEqual(codeNames(gate), ["CHECKOUT_NOT_FORM", "WRONG_FIELD_NAME"]);
  assert.equal(Object.hasOwn(SDK_MARKUP_CODES, "UNKNOWN_ATTRIBUTE"), false, "unknown attributes carry no finding code");
});

test("unknown data-next-* names are collected per campaign as information, not as a finding", () => {
  const scan = scanPageMarkup(page('<input data-next-coupon-input><div data-next-cart-summary data-next-class-active="x"></div>'));
  assert.deepEqual(scan.unknown_attributes, ["data-next-coupon-input"], "data-next-class-* is an indexed prefix");
  assert.deepEqual(scan.findings, []);
  const gate = evaluateSdkMarkup({ pages: [page('<input data-next-coupon-input>'), { ...page('<input data-next-coupon-input>'), page_id: "q", file: "q.html" }] });
  assert.equal(gate.status, "pass");
  assert.deepEqual(gate.unknown_attributes, [{ name: "data-next-coupon-input", pages: ["p.html", "q.html"] }]);
});

test("a blocked gate surfaces one disposition: advisories stay on warned[] and are not also doctor warnings; summaries are bounded", () => {
  const fields = ["firstName", "lastName", "zip", "state", "tel", "apt", "cardnumber"].map((name) => `<input data-next-checkout-field="${name}">`).join("");
  withTempDir((repo) => {
    writePage(repo, "checkout", `<form data-next-checkout>${fields}</form><div data-next-bundle-selector><i data-next-selected="true"></i><i data-next-selected="true"></i></div>`);
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    const gate = gateOf(result);
    assert.equal(gate.status, "blocked");
    assert.equal(gate.findings.length, 7);
    assert.equal(gate.warned.length, 1, "the DOUBLE_SELECTED advisory is kept on the gate");
    assert.deepEqual(markupCodes(result.warnings), [], "but not pushed as a doctor warning while blockers stand");
    assert.equal(markupCodes(result.errors).length, 7);
    assert.match(gate.reason, /7 SDK markup blocker\(s\).*; plus 2 more\).*1 advisory finding\(s\) held in warned\[\]/);
    assert.ok(gate.reason.length < 600, `reason is bounded, got ${gate.reason.length} chars`);
    assert.match(gate.required_actions[0].description, /plus 2 more/);
  });
});

test("the vendored attribute index names its SDK tag and holds the field-name contract the issue lists", () => {
  assert.equal(SDK_ATTRIBUTE_INDEX_VERSION, "0.4.41");
  assert.ok(SDK_DATA_NEXT_ATTRIBUTES.length > 100);
  // The 0.4.41 address block and i18n names, and two names the SDK's 0.4.41
  // attribute docs leave out but its source still reads.
  for (const name of ["data-next-checkout", "data-next-checkout-field", "data-next-bundle-selector", "data-next-selected", "data-next-action", "data-next-address", "data-next-address-lang", "data-next-i18n", "data-next-package-selector", "data-next-remove-item"]) {
    assert.ok(isIndexedSdkAttribute(name), name);
  }
  for (const field of ["email", "fname", "lname", "phone", "address1", "address2", "city", "province", "postal", "country", "cc-number", "cc-month", "cc-year", "exp-year", "cvv", "billing-city"]) {
    assert.ok(isKnownCheckoutFieldName(field), field);
  }
  for (const field of ["firstName", "lastName", "zip", "", "billing-"]) {
    assert.equal(isKnownCheckoutFieldName(field), false, field);
  }
});

// --- Version-gated field names ------------------------------------------------------
// first_name/last_name from SDK 0.4.39 (0.4.40 is the same SDK), phone_number
// from 0.4.41; fname/lname/phone on every version; unknown is judged earlier.

const loaderTag = (version) => `<script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@v${version}/dist/loader.js" type="module"></script>`;
const gatedForm = '<form data-next-checkout><input data-next-checkout-field="first_name"><input data-next-checkout-field="last_name"><input data-next-checkout-field="phone_number"><input data-next-checkout-field="fname"><input data-next-checkout-field="lname"><input data-next-checkout-field="phone"></form>';
const wrongValues = (gate) => gate.findings.filter((item) => item.code_name === "WRONG_FIELD_NAME").map((item) => item.detail.value);

const GATED_ROWS = [
  // [sdk version, field names that block]
  ["0.4.38", ["first_name", "last_name", "phone_number"]],
  ["0.4.39", ["phone_number"]],
  ["0.4.40", ["phone_number"]],
  ["0.4.41", []],
];

test("isKnownCheckoutFieldName: each version-gated name turns on at its since-version, older names on every version", () => {
  for (const [version, blocked] of [...GATED_ROWS, [null, ["first_name", "last_name", "phone_number"]], ["0.4.39-beta.1", ["first_name", "last_name", "phone_number"]], ["v0.4.41", ["first_name", "last_name", "phone_number"]], ["0.04.41", ["first_name", "last_name", "phone_number"]], [" 0.4.41", ["first_name", "last_name", "phone_number"]], ["0.5.0", []]]) {
    for (const field of ["first_name", "last_name", "phone_number"]) {
      assert.equal(isKnownCheckoutFieldName(field, version), !blocked.includes(field), `${field} on ${version}`);
    }
    for (const field of ["fname", "lname", "phone"]) assert.equal(isKnownCheckoutFieldName(field, version), true, `${field} on ${version}`);
  }
});

for (const [version, blocked] of GATED_ROWS) {
  test(`version-gated field names on a page whose loader pins ${version}`, () => {
    const gate = evaluateSdkMarkup({ subject: {}, pages: [page(`${loaderTag(version)}${gatedForm}`)] });
    assert.deepEqual(wrongValues(gate), blocked);
    assert.equal(gate.status, blocked.length ? "blocked" : "pass");
    for (const item of gate.findings) {
      assert.equal(item.detail.sdk_version, version);
      assert.equal(item.detail.sdk_version_source, "loader");
      assert.match(item.message, new RegExp(`maps only from ${item.detail.since.replace(/\./g, "\\.")}, and this page loads SDK ${version.replace(/\./g, "\\.")} \\(its loader pin\\)`));
      assert.equal(item.detail.suggestion, { first_name: "fname", last_name: "lname", phone_number: "phone" }[item.detail.value]);
    }
  });
}

test("a page with no exact loader pin falls back to the campaign pin, and its own pin wins over it", () => {
  const unpinned = page(gatedForm);
  assert.deepEqual(wrongValues(evaluateSdkMarkup({ subject: {}, pages: [unpinned], sdkVersion: "0.4.41" })), []);
  const fallback = evaluateSdkMarkup({ subject: {}, pages: [unpinned], sdkVersion: "0.4.39" });
  assert.deepEqual(wrongValues(fallback), ["phone_number"]);
  assert.equal(fallback.findings[0].detail.sdk_version_source, "campaigns_json");
  assert.equal(fallback.campaign_sdk_version, "0.4.39");
  assert.match(fallback.findings[0].message, /loads SDK 0\.4\.39 \(the campaigns\.json sdk_version\)/);
  // The page's own loader is what the browser runs.
  assert.deepEqual(wrongValues(evaluateSdkMarkup({ subject: {}, pages: [page(`${loaderTag("0.4.38")}${gatedForm}`)], sdkVersion: "0.4.41" })), ["first_name", "last_name", "phone_number"]);
  // A @latest loader names no exact version, so the campaign pin applies.
  const latest = page(`<script src="https://cdn.jsdelivr.net/gh/NextCommerceCo/campaign-cart@latest/dist/loader.js"></script>${gatedForm}`);
  assert.deepEqual(wrongValues(evaluateSdkMarkup({ subject: {}, pages: [latest], sdkVersion: "0.4.41" })), []);
});

test("an unknown SDK version is judged as an earlier SDK, and the message says the version could not be read", () => {
  const gate = evaluateSdkMarkup({ subject: {}, pages: [page(gatedForm)] });
  assert.deepEqual(wrongValues(gate), ["first_name", "last_name", "phone_number"]);
  assert.equal(gate.campaign_sdk_version, null);
  for (const item of gate.findings) {
    assert.equal(item.detail.sdk_version, null);
    assert.match(item.message, /SDK version could not be read .* judged as an earlier SDK\. .*Use "(fname|lname|phone)", which every SDK version maps, or pin the SDK to 0\.4\.(39|41) or later\./);
  }
});

test("doctor --built reads the campaign pin from campaigns.json when the built page has no loader pin", () => {
  for (const [version, blocked] of [["0.4.38", 3], ["0.4.41", 0], ["0.4.41-rc.1", 3]]) {
    withTempDir((repo) => {
      mkdirSync(join(repo, "_data"), { recursive: true });
      writeFileSync(join(repo, "_data", "campaigns.json"), JSON.stringify({ [SLUG]: { name: "Example", sdk_version: version } }));
      writePage(repo, "checkout", gatedForm, "checkout");
      const result = doctorBuiltOutput({ built: repo, slug: SLUG });
      assert.equal(markupCodes(result.errors).length, blocked, `campaigns.json sdk_version ${version}`);
      assert.equal(gateOf(result).campaign_sdk_version, blocked === 3 && version !== "0.4.38" ? null : version, "only an exact released pin is used");
    });
  }
});

test("the version-gated names match the checkout field contract's version_gated_aliases", () => {
  const contract = JSON.parse(readFileSync(new URL("../contracts/campaign-cart-checkout-field-contract.v0.json", import.meta.url), "utf8"));
  const fromContract = Object.fromEntries(Object.entries(contract.version_gated_aliases).map(([name, entry]) => [name, { since: entry.since, sdk_name: entry.canonical }]));
  assert.deepEqual(fromContract, JSON.parse(JSON.stringify(SDK_CHECKOUT_FIELD_NAMES_SINCE)));
  for (const [name, entry] of Object.entries(contract.version_gated_aliases)) {
    assert.ok(contract.canonical_fields.includes(entry.canonical), `${name} → ${entry.canonical} is canonical on every version`);
  }
});

// --- Reach and non-waivability ------------------------------------------------------

test("the gate fires with no packet and no family, is registered in doctor_checks, and offers no waiver", () => {
  withTempDir((repo) => {
    writePage(repo, "landing", '<div data-next-checkout></div>');
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, false);
    assert.ok(result.derived.doctor_checks.includes(SDK_MARKUP));
    const gate = gateOf(result);
    assert.equal(gate.status, "blocked");
    assert.equal(gate.waivable, false);
    assert.equal(gate.required_actions.length, 1);
    assert.equal(gate.required_actions[0].id, "repair_sdk_markup");
    assert.equal(gate.required_actions.some((action) => action.id === "waive_checkpoint"), false);
    assert.equal(result.errors[0].detail.checkpoint_gate.id, SDK_MARKUP);
  });
});

test("unknown attributes surface as one advisory ready line naming the index version, never as a warning", () => {
  withTempDir((repo) => {
    writePage(repo, "landing", '<div data-next-coupon-input></div>');
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, true);
    assert.deepEqual(markupCodes(result.warnings), []);
    assert.ok(result.ready.some((note) => note.includes(`Campaign Cart ${SDK_ATTRIBUTE_INDEX_VERSION} attribute index`) && note.includes("data-next-coupon-input")));
  });
});
