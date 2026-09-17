// Static SDK markup checks (#303): the six codes through the real
// `doctor --built` entry point over the committed bad/good fixture pairs,
// plus the evaluator edge cases the fixtures do not isolate (default swap
// mode, upsell-context exemption, template ownership, unknown attributes,
// registration and non-waivability).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput } from "./cli.mjs";
import { SDK_ATTRIBUTE_INDEX_VERSION, SDK_DATA_NEXT_ATTRIBUTES, isIndexedSdkAttribute, isKnownCheckoutFieldName } from "./sdk-attribute-index.mjs";
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

function writePage(repo, route, body) {
  const dir = join(repo, "_site", SLUG, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><head><meta name="next-funnel" content="Example"><meta name="next-page-type" content="product"></head><body>${body}</body></html>`);
}

const page = (body) => ({ page_id: "p", file: "p.html", content: `<html><body>${body}</body></html>` });
const codeNames = (gate) => [...gate.findings, ...gate.warned].map((item) => item.code_name).sort();

// --- The committed bad/good pairs, one per code ---------------------------------

const BLOCKERS = ["swap-with-add-to-cart", "checkout-not-form", "wrong-field-name", "missing-selector-id-match"];
const ADVISORIES = ["double-selected", "template-double-brace"];
const codeFor = (name) => SDK_MARKUP_CODES[name.toUpperCase().replace(/-/g, "_")].code;

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
  const nested = evaluateSdkMarkup({ pages: [page('<div data-next-order-items><template><li>{{ item.title }}</li></template></div>')] });
  assert.deepEqual(codeNames(nested), ["TEMPLATE_DOUBLE_BRACE"]);
  assert.match(nested.warned[0].message, /single-brace \(\{item\.title\}\)/);
  const foreign = evaluateSdkMarkup({ pages: [page('<template id="vendor"><div>{{vendor.token}}</div></template>')] });
  assert.equal(foreign.status, "pass");
});

test("markup inside an SDK <template> is scanned, because the SDK clones it into the live DOM", () => {
  const gate = evaluateSdkMarkup({ pages: [page('<div data-next-cart-summary><template><div data-next-checkout><input data-next-checkout-field="zip"></div></template></div>')] });
  assert.deepEqual(codeNames(gate), ["CHECKOUT_NOT_FORM", "WRONG_FIELD_NAME"]);
});

test("unknown data-next-* names are collected per campaign as information, not as a finding", () => {
  const scan = scanPageMarkup(page('<input data-next-coupon-input><div data-next-cart-summary data-next-class-active="x"></div>'));
  assert.deepEqual(scan.unknown_attributes, ["data-next-coupon-input"], "data-next-class-* is an indexed prefix");
  assert.deepEqual(scan.findings, []);
  const gate = evaluateSdkMarkup({ pages: [page('<input data-next-coupon-input>'), { ...page('<input data-next-coupon-input>'), page_id: "q", file: "q.html" }] });
  assert.equal(gate.status, "pass");
  assert.deepEqual(gate.unknown_attributes, [{ name: "data-next-coupon-input", pages: ["p.html", "q.html"] }]);
});

test("the vendored attribute index names its SDK tag and holds the field-name contract the issue lists", () => {
  assert.equal(SDK_ATTRIBUTE_INDEX_VERSION, "0.4.38");
  assert.ok(SDK_DATA_NEXT_ATTRIBUTES.length > 100);
  for (const name of ["data-next-checkout", "data-next-checkout-field", "data-next-bundle-selector", "data-next-selected", "data-next-action"]) {
    assert.ok(isIndexedSdkAttribute(name), name);
  }
  for (const field of ["email", "fname", "lname", "phone", "address1", "address2", "city", "province", "postal", "country", "cc-number", "cc-month", "cc-year", "exp-year", "cvv", "billing-city"]) {
    assert.ok(isKnownCheckoutFieldName(field), field);
  }
  for (const field of ["firstName", "lastName", "zip", "", "billing-"]) {
    assert.equal(isKnownCheckoutFieldName(field), false, field);
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
