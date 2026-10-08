import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateCommerceCatalog } from "./doctor/checks.mjs";

const catalog = JSON.parse(readFileSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../fixtures/doctor-checkout-variant-packages.json", import.meta.url), "utf8"));
const finding = "template_contract.checkout_package_fit";

function inspect(family, spec = fixture, buildState = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-family-fit-"));
  try {
    writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
    const packet = { assembly: { template_family: family, commerce_catalog: { required: true, path: "catalog.json" } } };
    const errors = [];
    const warnings = [];
    validateCommerceCatalog(packet, join(dir, "packet.json"), spec, errors, warnings, [], {}, buildState);
    return { errors, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("20 checkout variants at quantities 1 through 3 warn on a tiered family and name certified fitting families", () => {
  const { errors, warnings } = inspect("olympus");
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue, "expected checkout package fit warning for 20 distinct variants");
  assert.match(issue.message, /20 variants, some offered at several quantities/);
  assert.match(issue.message, /olympus-mv-single-step/);
  assert.match(issue.message, /apollo-mv-single-step/);
  assert.match(issue.message, /olympus-mv-two-step/);
  assert.match(issue.message, /--template-family olympus-mv-single-step`/);
  assert.deepEqual(errors, [], "the warning must leave doctor unblocked");
});

test("one selectable row without qty does not silence the remaining variant matrix", () => {
  const spec = structuredClone(fixture);
  delete spec.funnels[0].pages[0].packages[0].qty;
  const { warnings } = inspect("olympus", spec);
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue, "the remaining quantity rows still form a variant matrix");
  assert.match(issue.message, /20 variants, some offered at several quantities/);
});

test("selectable rows without any usable qty do not form a variant matrix", () => {
  const spec = structuredClone(fixture);
  for (const pkg of spec.funnels[0].pages[0].packages) pkg.qty = "  ";
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("a checkout_step matrix recommends the matching two-step family once per path", () => {
  const spec = structuredClone(fixture);
  const pages = spec.funnels[0].pages;
  pages[0].type = "checkout_step";
  pages[0].next_page = "shipping";
  pages.push({ ...structuredClone(pages[0]), id: "shipping", next_page: "payment" });
  pages.push({ id: "payment", type: "checkout" });
  const { warnings } = inspect("olympus", spec);
  const issues = warnings.filter((warning) => warning.code === finding);
  assert.equal(issues.length, 1, "two step pages on one path should produce one warning");
  assert.match(issues[0].message, /--template-family olympus-mv-two-step`/);
});

test("a select page before checkout also recommends the two-step family", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].type = "select";
  spec.funnels[0].pages[0].next_page = "payment";
  spec.funnels[0].pages.push({ id: "payment", type: "checkout" });
  const { warnings } = inspect("olympus", spec);
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /--template-family olympus-mv-two-step`/);
});

test("an unclear base lists shape-matching family choices", () => {
  const { warnings } = inspect("demeter");
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /--template-family apollo-mv-single-step`/);
  assert.match(issue.message, /Other matching family: olympus-mv-single-step\./);
  assert.doesNotMatch(issue.message, /<one of:/);
});

test("a completed assembly warning does not advise an ordinary start rerun", () => {
  const { warnings } = inspect("olympus", fixture, { report: { stages: { assembly: { status: "completed" } } } });
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /build-time decision/);
  assert.match(issue.message, /--force.*destructive/);
  assert.doesNotMatch(issue.message, /rerun `npx --no-install campaigns-os start/);
});

test("setup stage evidence also suppresses the ordinary start command", () => {
  const { warnings } = inspect("olympus", fixture, { report: { stages: { setup: { status: "completed" } } } });
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /--force.*destructive/);
  assert.doesNotMatch(issue.message, /rerun `npx --no-install campaigns-os start/);
});

test("the same checkout variants fit a variant-slot family", () => {
  const { warnings } = inspect("olympus-mv-single-step");
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("a family without a declared single main package is not assigned a single-variant limit", () => {
  const { warnings } = inspect("shop-single-step");
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("one variant with quantity tiers fits a tiered family", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [1, 2, 3].map((qty) => ({ ref_id: "variant-01", qty, product_variant_name: "Colour A / Size 1" }));
  const { errors, warnings } = inspect("olympus", spec);
  assert.deepEqual(errors, [], "quantity tiers should leave doctor unblocked");
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("separate package refs for quantity tiers of one variant do not warn", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [1, 2, 3].map((qty) => ({
    ref_id: `tier-${qty}`,
    qty,
    product_variant_name: "Colour A / Size 1",
  }));
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("pack sizes modelled as separate variant names do not warn", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = ["1 Pack", "2 Pack"].map((product_variant_name, index) => ({
    ref_id: `pack-${index + 1}`,
    qty: 1,
    product_variant_name,
  }));
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("pack SKUs do not establish variant identity", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = ["PRODUCT-1PACK", "PRODUCT-2PACK"].map((product_sku, index) => ({
    ref_id: `pack-${index + 1}`,
    qty: index + 1,
    product_sku,
  }));
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("order bumps and upsells never add selectable variants", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [
    { ref_id: "main", qty: 1, product_variant_name: "Colour A / Size 1" },
    { ref_id: "bump", qty: 2, product_variant_name: "Colour A / Size 1", is_order_bump: true },
    { ref_id: "upsell", qty: 1, product_variant_name: "Colour B / Size 1", is_upsell: true },
  ];
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("campaign-spec fixtures stay silent with their certified families", () => {
  const fixtureDir = new URL("../contracts/fixtures/campaign-specs/", import.meta.url);
  for (const path of readdirSync(fixtureDir).filter((name) => name.endsWith(".json"))) {
    const spec = JSON.parse(readFileSync(new URL(path, fixtureDir), "utf8"));
    const families = new Set((spec.funnels || []).flatMap((funnel) => funnel.pages || [])
      .map((page) => page.sdk_hints?.template_family).filter((family) => catalog.families[family]));
    for (const family of families) {
      const { warnings } = inspect(family, spec);
      assert.equal(warnings.some((warning) => warning.code === finding), false, `${family}: ${path}`);
    }
  }
});

test("package refs without variant identity do not warn", () => {
  const spec = structuredClone(fixture);
  for (const pkg of spec.funnels[0].pages[0].packages) delete pkg.product_variant_name;
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("mixed variant identity fields do not establish a comparable matrix", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [
    { ref_id: "a-1", qty: 1, product_variant_name: "Colour A" },
    { ref_id: "a-2", qty: 2, product_variant_name: "Colour A" },
    { ref_id: "b-1", qty: 1, product_sku: "PRODUCT-B" },
  ];
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("variant attributes identify variants when names are absent", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [
    { ref_id: "a-1", qty: 1, variant_attributes: [{ code: "colour", value: "A" }] },
    { ref_id: "a-2", qty: 2, variant_attributes: [{ code: "colour", value: "A" }] },
    { ref_id: "b-1", qty: 1, variant_attributes: [{ code: "colour", value: "B" }] },
  ];
  const { warnings } = inspect("olympus", spec);
  assert.ok(warnings.some((warning) => warning.code === finding));
});

test("product SKU does not identify variants when names and attributes are absent", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].packages = [
    { ref_id: "a", qty: 1, product_sku: "SKU-A" },
    { ref_id: "b", qty: 1, product_sku: "SKU-B" },
  ];
  const { warnings } = inspect("olympus", spec);
  assert.equal(warnings.some((warning) => warning.code === finding), false);
});

test("checkout-flow select and checkout_step pages carrying variants are checked", () => {
  for (const type of ["select", "checkout_step"]) {
    const spec = structuredClone(fixture);
    spec.funnels[0].pages[0].type = type;
    const { warnings } = inspect("olympus", spec);
    assert.ok(warnings.some((warning) => warning.code === finding), `${type} should warn`);
  }
});
