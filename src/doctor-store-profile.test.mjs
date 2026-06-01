import assert from "node:assert/strict";
import { test } from "node:test";

import { validateSpecStoreProfile } from "./cli.mjs";

const codes = (issues) => issues.map((issue) => issue.code);

function run(campaign) {
  const errors = [];
  const warnings = [];
  const ready = [];
  validateSpecStoreProfile({ campaign }, errors, warnings, ready);
  return { errors, warnings, ready };
}

test("R2-B5: a reserved documentation store_url warns", () => {
  const { errors, warnings } = run({ store_url: "https://shop.example.com/", available_payment_methods: ["card"] });
  assert.equal(codes(errors).includes("spec.store_profile"), false);
  assert.ok(codes(warnings).includes("spec.store_profile.placeholder_store_url"));
});

test("R2-B5: a localhost store_url does NOT warn (sanctioned dev domain)", () => {
  const { warnings } = run({ store_url: "https://localhost:3000/", available_payment_methods: ["card"] });
  assert.equal(codes(warnings).includes("spec.store_profile.placeholder_store_url"), false);
});

test("R2-B5: empty available_payment_methods warns", () => {
  const { warnings } = run({ store_url: "https://shop.example-merchant.com/", available_payment_methods: [] });
  assert.ok(codes(warnings).includes("spec.store_profile.no_payment_methods"));
});

test("R2-B5: a real storefront with payment methods is clean", () => {
  const { errors, warnings } = run({ store_url: "https://shop.acmevitamins.com/", available_payment_methods: ["card", "paypal"] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("R2-B5: absent available_payment_methods does not warn (unknown != empty)", () => {
  const { warnings } = run({ store_url: "https://shop.acmevitamins.com/" });
  assert.equal(codes(warnings).includes("spec.store_profile.no_payment_methods"), false);
});

test("R2-B5: a missing store_url is still a hard error (existing behavior)", () => {
  const { errors } = run({ available_payment_methods: ["card"] });
  assert.ok(codes(errors).includes("spec.store_profile"));
});
