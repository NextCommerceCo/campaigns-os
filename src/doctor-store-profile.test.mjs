import assert from "node:assert/strict";
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
