import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateCommerceCatalog } from "./doctor/checks.mjs";

// campaigns-os#658: a family that puts package selection on a `select` page
// needs the Map to declare one ahead of checkout, or QA finds no add-to-cart
// control on the entry page and every order path fails after the build.

const catalog = JSON.parse(readFileSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), "utf8"));
const finding = "template_contract.select_step_missing";

function inspect(family, spec) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-select-step-"));
  try {
    writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
    const packet = { assembly: { template_family: family, commerce_catalog: { required: true, path: "catalog.json" } } };
    const errors = [];
    const warnings = [];
    validateCommerceCatalog(packet, join(dir, "packet.json"), spec, errors, warnings, [], {}, {});
    return { errors, warnings: warnings.filter((warning) => warning.code === finding), allErrors: errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function spec(pages, extraFunnels = []) {
  return {
    schema_version: "5.0",
    shipping_methods: [],
    funnels: [{ id: "default", pages }, ...extraFunnels],
  };
}

const landingToCheckout = () => [
  { id: "landing", type: "landing", next_page: "checkout" },
  { id: "checkout", type: "checkout" },
];

test("a two-step family whose Map routes landing straight to checkout warns before build and names the fix", () => {
  const { warnings, allErrors } = inspect("olympus-mv-two-step", spec(landingToCheckout()));
  assert.equal(warnings.length, 1, "expected one select-step warning");
  assert.match(warnings[0].message, /olympus-mv-two-step/);
  assert.match(warnings[0].message, /Checkout "checkout"/);
  assert.match(warnings[0].message, /add a Select page between the entry page and checkout in Map Builder/);
  assert.deepEqual(warnings[0].detail, { funnel_id: "default", checkout_page_id: "checkout", template_family: "olympus-mv-two-step" });
  assert.equal(allErrors.some((error) => error.code === finding), false, "the finding is a warning, not a blocker");
});

test("a select page between the entry page and checkout silences the warning", () => {
  const pages = [
    { id: "landing", type: "landing", next_page: "select" },
    { id: "select", type: "select", next_page: "checkout.html" },
    { id: "checkout", type: "checkout" },
  ];
  assert.deepEqual(inspect("olympus-mv-two-step", spec(pages)).warnings, []);
});

test("a family whose checkout carries its own selector stays silent on landing -> checkout", () => {
  for (const family of ["olympus", "olympus-mv-single-step", "apollo-mv-single-step"]) {
    assert.deepEqual(inspect(family, spec(landingToCheckout())).warnings, [], family);
  }
});

test("a disabled select page, or one that routes nowhere near checkout, does not count", () => {
  const disabled = [
    { id: "landing", type: "landing", next_page: "select" },
    { id: "select", type: "select", next_page: "checkout", enabled: false },
    { id: "checkout", type: "checkout" },
  ];
  assert.equal(inspect("olympus-mv-two-step", spec(disabled)).warnings.length, 1, "disabled select");
  const dangling = [
    { id: "landing", type: "landing", next_page: "checkout" },
    { id: "select", type: "select" },
    { id: "checkout", type: "checkout" },
  ];
  assert.equal(inspect("olympus-mv-two-step", spec(dangling)).warnings.length, 1, "select with no route to checkout");
});

test("each checkout path is judged on its own", () => {
  const stepped = {
    id: "stepped",
    pages: [
      { id: "landing-b", type: "landing", next_page: "select-b" },
      { id: "select-b", type: "select", next_page: "checkout-b" },
      { id: "checkout-b", type: "checkout" },
    ],
  };
  const { warnings } = inspect("olympus-mv-two-step", spec(landingToCheckout(), [stepped]));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].detail.funnel_id, "default");
});

test("a checkout path pinned to another family is judged by that family", () => {
  const pages = [
    { id: "select", type: "select", next_page: "checkout", is_entry: true },
    { id: "checkout", type: "checkout" },
    { id: "information", type: "checkout_step", next_page: "billing", is_entry: true, sdk_hints: { template_family: "shop-three-step" } },
    { id: "billing", type: "checkout", sdk_hints: { template_family: "shop-three-step" } },
  ];
  assert.deepEqual(inspect("olympus-mv-two-step", spec(pages)).warnings, []);
});

test("campaign-spec fixtures stay silent with their certified families", () => {
  const fixtureDir = new URL("../contracts/fixtures/campaign-specs/", import.meta.url);
  for (const path of readdirSync(fixtureDir).filter((name) => name.endsWith(".json"))) {
    const fixture = JSON.parse(readFileSync(new URL(path, fixtureDir), "utf8"));
    const families = new Set((fixture.funnels || []).flatMap((funnel) => funnel.pages || [])
      .map((page) => page.sdk_hints?.template_family).filter((family) => catalog.families[family]));
    for (const family of families) {
      assert.deepEqual(inspect(family, fixture).warnings, [], `${family}: ${path}`);
    }
  }
});
