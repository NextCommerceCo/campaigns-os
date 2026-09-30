// Real-browser proof for the checkout commerce-structure row (campaigns-os#532).
//
// The checkout's wrapper and page composition are source-owned, so a checkout
// without the family shell classes warns instead of failing when it still does
// what a checkout has to: fields bound inside the checkout form and a visible
// total. The behaviour probe reads computed visibility and form membership, so
// the fixture under fixtures/qa-commerce-structure/ is served locally and run
// through `runBrowserChecks`, the same entry point `qa run --browser` uses.
// Each break of one behaviour keeps the row a failure.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { runBrowserChecks } from "./qa-browser.mjs";

const FIXTURE = new URL("../fixtures/qa-commerce-structure/design-owned-checkout.html", import.meta.url).pathname;
const catalog = JSON.parse(await readFile(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
const FAMILY_SHELL_SELECTORS = [
  ".checkout-layout__left",
  ".checkout-layout__right",
  ".checkout-wrapper",
  '[data-next-component="shipping-field-row"]',
];

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

// Every request gets the HTML the current test set, so the page load and the
// SDK debugger load read the same document.
let html = "";
let origin = "";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), `fixture carries ${from}`);
  return source.replace(from, to);
}

// The olympus checkout contract reads the wrapper, both layout columns and the
// shipping field row, plus the SDK form, submit and cart summary.
async function structureRow(mutate = (source) => source) {
  html = mutate(await readFile(FIXTURE, "utf8"));
  const page = {
    page_id: "checkout",
    page_type: "checkout",
    url: `${origin}/checkout/`,
    template_family: "olympus",
    commerce_structure_contract: catalog.families.olympus.agentContract.qaStructure.checkout,
    commerce_structure_contract_status: "loaded",
  };
  const assertions = await runBrowserChecks([{ pages: [page] }], {}, {});
  const row = assertions.find((candidate) => candidate.id === "browser-commerce-structure:checkout");
  assert.ok(row, "the checkout emits a commerce-structure row");
  return row;
}

function failedSelectors(row) {
  return row.evidence.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.selectors[0])
    .sort();
}

test("a design-owned checkout that works warns for the missing family shell", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow();
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS, "only the family shell is missing");
  assert.equal(row.status, "warn");
  assert.equal(row.severity, "warn");
  assert.equal(row.evidence.behaviour?.status, "pass");
  assert.match(row.actual, /family shell is source-owned/);
});

// Each break leaves the same four shell misses and nothing else, so the
// behaviour probe is the only thing that can keep the row a failure.
test("an unbound required field keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(source, ' data-next-checkout-field="city"', ""));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.equal(row.evidence.behaviour?.status, "fail");
  assert.deepEqual(row.evidence.behaviour?.fields_bound?.missing, ["city"]);
  assert.equal(row.evidence.behaviour?.checkout_form?.status, "pass");
  assert.equal(row.evidence.behaviour?.total_visible?.status, "pass");
});

// A customer cannot fill a hidden input, a disabled or aria-disabled control,
// or a readonly input, so none binds the field even though it carries the
// attribute inside the form.
test("a required field bound only on a hidden input keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    source,
    '<input type="text" name="city" data-next-checkout-field="city">',
    '<input type="hidden" name="city" data-next-checkout-field="city">',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.deepEqual(row.evidence.behaviour?.fields_bound?.missing, ["city"]);
  assert.equal(row.evidence.behaviour?.status, "fail");
});

test("a required field bound only on a disabled control keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    source,
    '<select name="province" data-next-checkout-field="province">',
    '<select name="province" data-next-checkout-field="province" disabled>',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.deepEqual(row.evidence.behaviour?.fields_bound?.missing, ["province"]);
  assert.equal(row.evidence.behaviour?.status, "fail");
});

test("a required field bound only on a readonly input keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    source,
    '<input type="text" name="postal" data-next-checkout-field="postal">',
    '<input type="text" name="postal" data-next-checkout-field="postal" readonly>',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.deepEqual(row.evidence.behaviour?.fields_bound?.missing, ["postal"]);
  assert.equal(row.evidence.behaviour?.status, "fail");
});

test("a required field bound only on an aria-disabled control keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    source,
    '<select name="country" data-next-checkout-field="country">',
    '<select name="country" data-next-checkout-field="country" aria-disabled="true">',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.deepEqual(row.evidence.behaviour?.fields_bound?.missing, ["country"]);
  assert.equal(row.evidence.behaviour?.status, "fail");
});

// Visibility is not part of binding: a progressive-reveal checkout hides the
// address fields until a country is chosen and still works.
test("required fields hidden until a country is chosen still count as bound", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    replaceOnce(source, '<label class="field">Address', '<div style="display:none"><label class="field">Address'),
    'data-next-checkout-field="postal"></label>',
    'data-next-checkout-field="postal"></label></div>',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "warn");
  assert.equal(row.evidence.behaviour?.fields_bound?.status, "pass");
});

test("a form without data-next-checkout keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  // The catalog's own form rule reads any visible `[data-next-checkout="form"]`,
  // so the attribute moves from the <form> to a wrapper <div>: that rule still
  // passes, but the fields sit in a form the SDK does not submit.
  const row = await structureRow((source) => replaceOnce(
    replaceOnce(source, '<form data-next-checkout="form">', '<div data-next-checkout="form"><form>'),
    "</form>",
    "</form></div>",
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  // No checkout form found is a behaviour failure, never a pass.
  assert.equal(row.evidence.behaviour?.checkout_form?.count, 0);
  assert.equal(row.evidence.behaviour?.checkout_form?.status, "fail");
  assert.equal(row.evidence.behaviour?.fields_bound?.status, "fail");
  assert.equal(row.evidence.behaviour?.status, "fail");
});

test("a checkout with no visible total keeps the missing family shell a failure", async (t) => {
  if (!await chromiumAvailable()) return t.skip("Chromium is unavailable; the browser CI lane runs this test");
  const row = await structureRow((source) => replaceOnce(
    source,
    '<span data-next-display="cart.total">',
    '<span data-next-display="cart.total" style="display:none">',
  ));
  assert.deepEqual(failedSelectors(row), FAMILY_SHELL_SELECTORS);
  assert.equal(row.status, "fail");
  assert.equal(row.evidence.behaviour?.total_visible?.count, 1);
  assert.equal(row.evidence.behaviour?.total_visible?.visible_count, 0);
  assert.equal(row.evidence.behaviour?.total_visible?.status, "fail");
  assert.equal(row.evidence.behaviour?.fields_bound?.status, "pass");
  assert.equal(row.evidence.behaviour?.status, "fail");
});
