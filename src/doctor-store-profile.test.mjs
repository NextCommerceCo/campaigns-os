import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isLocalhostDevelopmentOrigin, validateSpecStoreProfile } from "./cli.mjs";

const codes = (issues) => issues.map((issue) => issue.code);

function run(campaign) {
  const errors = [];
  const warnings = [];
  const ready = [];
  validateSpecStoreProfile({ campaign }, errors, warnings, ready);
  return { errors, warnings, ready };
}

test("R2-B5: a placeholder/localhost store_url warns", () => {
  const { errors, warnings } = run({ store_url: "https://localhost:3000/", available_payment_methods: ["card"] });
  assert.equal(codes(errors).includes("spec.store_profile"), false);
  assert.ok(codes(warnings).includes("spec.store_profile.placeholder_store_url"));
});

test("R2-B5: empty available_payment_methods warns", () => {
  const { warnings } = run({ store_url: "https://shop.example-merchant.com/", available_payment_methods: [] });
  assert.ok(codes(warnings).includes("spec.store_profile.no_payment_methods"));
});

test("R2-B5: a real storefront with all force-enabled methods supported is clean", () => {
  const { errors, warnings } = run({
    store_url: "https://shop.acmevitamins.com/",
    available_payment_methods: ["card", "paypal", "klarna"],
    available_express_payment_methods: ["apple_pay", "google_pay"],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("warns when checkout-page force-enabled methods are absent from the spec", () => {
  const { warnings } = run({ store_url: "https://shop.acmevitamins.com/", available_payment_methods: ["card"] });
  const warning = warnings.find((issue) => issue.code === "spec.store_profile.payment_methods_default_on");
  assert.ok(warning, "expected a payment_methods_default_on warning");
  for (const method of ["paypal", "klarna", "apple_pay", "google_pay"]) {
    assert.ok(warning.message.includes(method), `warning should name ${method}`);
  }
});

test("pre-build repair text tells the operator to pass show_<method>=false on the include call", () => {
  const { warnings } = run({ store_url: "https://shop.acmevitamins.com/", available_payment_methods: ["card", "apple_pay", "google_pay"] });
  const warning = warnings.find((issue) => issue.code === "spec.store_profile.payment_methods_default_on");
  assert.ok(warning);
  assert.match(warning.message, /Pass show_paypal=false show_klarna=false on that include call/);
  assert.doesNotMatch(warning.message, /remove the show_\* arg/);
  assert.equal(warning.detail.basis, "spec_only");
  assert.deepEqual(warning.detail.methods, ["paypal", "klarna"]);
  assert.equal(warning.detail.repair.include_call, "{% campaign_include 'payment-methods.html' show_paypal=false show_klarna=false %}");
});

const SLUG = "test-campaign";
const CHECKOUT_SPEC = {
  campaign: { store_url: "https://shop.acmevitamins.com/", available_payment_methods: ["card", "apple_pay", "google_pay"] },
  funnel_pages: [
    { id: "landing", type: "landing", enabled: true, page_url: "" },
    { id: "checkout", type: "checkout", enabled: true, page_url: "checkout/" },
  ],
};
const PACKET = { campaign: { public_route_slug: SLUG }, assembly: { template_family: "apollo" } };

function withBuiltCheckout(html, fn) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-store-profile-"));
  try {
    mkdirSync(join(dir, "_site", SLUG, "checkout"), { recursive: true });
    writeFileSync(join(dir, "_site", SLUG, "checkout", "index.html"), html);
    const errors = [];
    const warnings = [];
    const ready = [];
    validateSpecStoreProfile(CHECKOUT_SPEC, errors, warnings, ready, { packet: PACKET, derived: { target_repo: dir }, buildState: {} });
    return fn({ errors, warnings, ready });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a built checkout with no paypal/klarna markup silences the default-on warning", () => {
  withBuiltCheckout(
    '<form data-next-checkout><fieldset><label><input type="radio" name="payment_method" value="card"> Card</label></fieldset></form>',
    ({ warnings, ready }) => {
      assert.equal(codes(warnings).includes("spec.store_profile.payment_methods_default_on"), false);
      const note = ready.find((entry) => entry.includes("Built checkout carries no paypal, klarna payment-method markup"));
      assert.ok(note);
      // The shared chrome strip names no method: the static scan cannot attribute it, so the note says browser QA still checks it.
      assert.match(note, /; left to browser QA: shared chrome asset upsell-payment-logos\.svg$/);
    },
  );
});

test("a built checkout that still renders an unsupported method warns from the built page, naming the markup", () => {
  withBuiltCheckout(
    '<div data-next-payment-method="klarna" class="payment-method"><img class="payment-method__icon--klarna-logo" src="/c/images/klarna-logo.svg"></div>',
    ({ warnings }) => {
      const warning = warnings.find((issue) => issue.code === "spec.store_profile.payment_methods_default_on");
      assert.ok(warning);
      assert.match(warning.message, /^Built checkout still renders klarna/);
      assert.match(warning.message, /_site\/test-campaign\/checkout\/index\.html: klarna \(data-next-payment-method="klarna"/);
      assert.match(warning.message, /Pass show_klarna=false on the checkout page/);
      assert.equal(warning.detail.basis, "built_output");
      assert.deepEqual(warning.detail.methods, ["klarna"]);
      assert.equal(warning.detail.pages.length, 1);
      assert.equal(warning.detail.pages[0].method, "klarna");
      assert.ok(warning.detail.pages[0].markers.includes('data-next-payment-method="klarna"'));
      assert.ok(warning.detail.pages[0].markers.includes(".payment-method__icon--klarna-logo"));
      assert.ok(warning.detail.pages[0].markers.includes("klarna-logo.svg"));
      assert.deepEqual(warning.detail.static_scan_gaps, { compound_selectors: [], shared_assets: ["upsell-payment-logos.svg"] });
    },
  );
});

test("does not false-fire on object-form payment methods ({ code, label })", () => {
  const { warnings } = run({
    store_url: "https://shop.acmevitamins.com/",
    available_payment_methods: [{ code: "card" }, { code: "paypal" }, { code: "klarna" }],
    available_express_payment_methods: [{ code: "apple_pay" }, { code: "google_pay" }],
  });
  assert.equal(codes(warnings).includes("spec.store_profile.payment_methods_default_on"), false);
});

test("R2-B5: absent available_payment_methods does not warn (unknown != empty)", () => {
  const { warnings } = run({ store_url: "https://shop.acmevitamins.com/" });
  assert.equal(codes(warnings).includes("spec.store_profile.no_payment_methods"), false);
});

test("R2-B5: a missing store_url is still a hard error (existing behavior)", () => {
  const { errors } = run({ available_payment_methods: ["card"] });
  const error = errors.find((issue) => issue.code === "spec.store_profile");
  assert.ok(error);
  assert.ok(error.message.includes("campaign.store_url"));
  assert.deepEqual(error.detail.missing_fields, ["campaign.store_url"]);
  assert.equal(error.detail.repair.owner, "operator");
});

test("localhost URLs are globally allowed Development origins for SDK QA", () => {
  assert.equal(isLocalhostDevelopmentOrigin("http://localhost:3000/test-campaign/"), true);
  assert.equal(isLocalhostDevelopmentOrigin("https://localhost:4173"), true);
  assert.equal(isLocalhostDevelopmentOrigin("https://deploy-preview.example.com/demo/"), false);
  assert.equal(isLocalhostDevelopmentOrigin("http://127.0.0.1:3000/demo/"), false);
});
