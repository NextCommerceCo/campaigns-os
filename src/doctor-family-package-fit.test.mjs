import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { assertNoNetworkAttempts, readJson, ROOT, runCli, writeJson } from "./qc-test-factories.mjs";
import { validateCommerceCatalog } from "./doctor/checks.mjs";

afterEach(assertNoNetworkAttempts);

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
  assert.doesNotMatch(issue.message, /olympus-mv-two-step/);
  assert.match(issue.message, /Families that can present it: olympus-mv-single-step, apollo-mv-single-step/);
  assert.match(issue.message, /chosen at intake with --template-family/);
  assert.doesNotMatch(issue.message, /<json>|<html-dir>|<page-kit-dir>|npx --no-install/);
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
  assert.match(issues[0].message, /Families that can present it: olympus-mv-two-step/);
});

test("html routes connect a checkout step to its matrix checkout once", () => {
  const spec = structuredClone(fixture);
  const matrix = spec.funnels[0].pages[0];
  spec.funnels[0].pages = [
    { id: "shipping", type: "checkout_step", next_page: "checkout.html" },
    matrix,
  ];
  const issues = inspect("olympus", spec).warnings.filter((warning) => warning.code === finding);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].detail.fitting_families[0], "olympus-mv-two-step");
});

test("page_url routes connect two package-bearing checkout steps into one warning", () => {
  const spec = structuredClone(fixture);
  const matrix = spec.funnels[0].pages[0];
  spec.funnels[0].pages = [
    { ...structuredClone(matrix), id: "shipping", type: "checkout_step", next_page: "/billing/" },
    { ...structuredClone(matrix), id: "address", page_url: "/billing/", type: "checkout_step", next_page: "checkout.html" },
    matrix,
  ];
  const issues = inspect("olympus", spec).warnings.filter((warning) => warning.code === finding);
  assert.equal(issues.length, 1, "all package-bearing pages on one checkout path should share one warning");
  assert.equal(issues[0].detail.fitting_families[0], "olympus-mv-two-step");
});

test("a stepped funnel makes every checkout warning rank a multi-step family first", () => {
  const spec = structuredClone(fixture);
  spec.funnels.push({
    id: "stepped",
    pages: [
      { id: "select", type: "select", next_page: "payment.html" },
      { ...structuredClone(spec.funnels[0].pages[0]), id: "payment" },
    ],
  });
  const issues = inspect("olympus", spec).warnings.filter((warning) => warning.code === finding);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.detail.fitting_families[0]), ["olympus-mv-two-step", "olympus-mv-two-step"]);
});

test("a select page before checkout also recommends the two-step family", () => {
  const spec = structuredClone(fixture);
  spec.funnels[0].pages[0].type = "select";
  spec.funnels[0].pages[0].next_page = "payment";
  spec.funnels[0].pages.push({ id: "payment", type: "checkout" });
  const { warnings } = inspect("olympus", spec);
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /Families that can present it: olympus-mv-two-step/);
});

test("an unclear base lists shape-matching family choices", () => {
  const { warnings } = inspect("demeter");
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /Families that can present it: apollo-mv-single-step, olympus-mv-single-step/);
  assert.doesNotMatch(issue.message, /<one of:/);
});

test("a completed assembly warning does not advise an ordinary start rerun", () => {
  const { warnings } = inspect("olympus", fixture, { report: { stages: { assembly: { status: "completed" } } } });
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /build-time decision/);
  assert.match(issue.message, /--force.*destructive/);
  assert.doesNotMatch(issue.message, /npx --no-install campaigns-os start/);
});

test("setup stage evidence also suppresses the ordinary start command", () => {
  const { warnings } = inspect("olympus", fixture, { report: { stages: { setup: { status: "completed" } } } });
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /--force.*destructive/);
  assert.doesNotMatch(issue.message, /npx --no-install campaigns-os start/);
});

test("doctor write stage evidence requires force for a family change", () => {
  const { warnings } = inspect("olympus", fixture, { report: { stages: { doctor: { status: "completed" } } } });
  const issue = warnings.find((warning) => warning.code === finding);
  assert.ok(issue);
  assert.match(issue.message, /build-time decision/);
  assert.match(issue.message, /re-running intake with --force \(destructive;/);
  assert.match(issue.message, /Families that can present it: olympus-mv-single-step/);
});

test("doctor --write records stage evidence that changes the next family-fit warning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-family-fit-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source-html");
  const target = join(dir, "target-page-kit");
  const specPath = join(dir, "campaignspec.json");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  cpSync(join(ROOT, "examples/target-page-kit"), target, { recursive: true });
  const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
  spec.funnels[0].pages.find((page) => page.id === "checkout").packages = structuredClone(fixture.funnels[0].pages[0].packages);
  writeJson(specPath, spec);

  const prepared = await runCli([
    "prepare-build", "--spec", specPath, "--source", source, "--target", target,
    "--template-family", "olympus", "--no-run-session", "--no-remit", "--json",
  ]);
  assert.equal(prepared.error, null, `prepare-build threw: ${prepared.error?.message}`);
  assert.equal(prepared.exitCode, 0, `prepare-build failed: ${prepared.stderr.slice(0, 500)} ${prepared.stdout.slice(0, 500)}`);

  const packetPath = join(target, "campaign-runtime.build.json");
  const reportPath = join(target, ".campaign-runtime/assembly-report.json");
  const doctorArgs = ["doctor", "--packet", packetPath, "--no-live-refs", "--no-remit", "--json"];
  const first = await runCli([...doctorArgs, "--no-write"]);
  assert.equal(first.error, null, `first doctor threw: ${first.error?.message}`);
  const firstIssue = first.json?.warnings?.find((warning) => warning.code === finding);
  assert.ok(firstIssue, "first doctor reports the checkout package fit warning");
  assert.match(firstIssue.message, /chosen at intake with --template-family/);
  assert.doesNotMatch(firstIssue.message, /--force/);

  const written = await runCli([...doctorArgs, "--write"]);
  assert.equal(written.error, null, `doctor --write threw: ${written.error?.message}`);
  assert.ok(written.json?.warnings?.some((warning) => warning.code === finding), "doctor --write reports the same fit warning");
  const report = readJson(reportPath);
  assert.notEqual(report.stages.doctor.status, "pending", "doctor --write records the doctor stage");
  assert.deepEqual(report.stages.doctor.commands, ["campaigns-os doctor"]);

  const second = await runCli([...doctorArgs, "--no-write"]);
  assert.equal(second.error, null, `second doctor threw: ${second.error?.message}`);
  const secondIssue = second.json?.warnings?.find((warning) => warning.code === finding);
  assert.ok(secondIssue, "second doctor retains the checkout package fit warning");
  assert.match(secondIssue.message, /build-time decision/);
  assert.match(secondIssue.message, /re-running intake with --force \(destructive;/);
  assert.doesNotMatch(secondIssue.message, /chosen at intake with --template-family/);
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
