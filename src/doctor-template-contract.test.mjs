/**
 * Template-contract doctor checks ported from the private doctor (ADR-003 step 2).
 * Covers the shared-concern checks now in the public doctor: packages, upsell_refs,
 * spec_family, status, catalog_version.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCommerceCatalog, validateTemplateFamilyInventory } from "./cli.mjs";

const codes = (issues) => issues.map((issue) => issue.code);

// Run validateCommerceCatalog against a temp catalog + the given spec/contract,
// returning the emitted errors/warnings.
function run({ contract, spec, agentContractVersion = 1, family = "olympus", targetHtml = null }) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-tmpl-contract-"));
  try {
    const catalog = {
      agentContractVersion,
      sharedFrontmatterVocabulary: {},
      families: { [family]: { agentContract: contract } },
    };
    writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
    const packet = {
      assembly: {
        template_family: family,
        commerce_catalog: { required: true, family, path: "catalog.json" },
      },
    };
    const errors = [];
    const warnings = [];
    const ready = [];
    const derived = {};
    const buildState = {};
    if (targetHtml !== null) {
      const outputDir = join(dir, "out");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "index.html"), targetHtml);
      derived.target_output_dir = outputDir;
      buildState.report = { stages: { assembly: { status: "completed" } } };
    }
    validateCommerceCatalog(packet, join(dir, "packet.json"), spec, errors, warnings, ready, derived, buildState);
    return { errors, warnings, ready };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// olympus-like contract: requires a checkout main package, supports upsell offers.
const checkoutContract = {
  status: "agent-ready",
  frontmatter: { requiredWhenCloning: ["packages.main_package"], optionalWhenSupported: ["upsell_offer"] },
};

function specWith(pages) {
  return { campaign: {}, funnels: [{ id: "main", pages }] };
}

test("template_contract.packages errors when an olympus checkout has no package refs", () => {
  const { errors } = run({
    contract: checkoutContract,
    spec: specWith([{ id: "checkout", type: "checkout" }]),
  });
  assert.ok(codes(errors).includes("template_contract.packages"));
});

test("template_contract.packages clean when the checkout declares a package ref", () => {
  const { errors } = run({
    contract: checkoutContract,
    spec: specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]),
  });
  assert.equal(codes(errors).includes("template_contract.packages"), false);
});

test("template_contract.upsell_refs errors when an upsell page has no package/offer refs", () => {
  const { errors } = run({
    contract: checkoutContract,
    spec: specWith([
      { id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] },
      { id: "upsell", type: "upsell" },
    ]),
  });
  assert.ok(codes(errors).includes("template_contract.upsell_refs"));
});

test("template_contract.upsell_refs clean when the upsell declares an offer ref", () => {
  const { errors } = run({
    contract: checkoutContract,
    spec: specWith([
      { id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] },
      { id: "upsell", type: "upsell", offers: [{ ref_id: "9" }] },
    ]),
  });
  assert.equal(codes(errors).includes("template_contract.upsell_refs"), false);
});

test("template_contract.spec_family errors when a page family disagrees with the packet family", () => {
  const { errors } = run({
    contract: checkoutContract,
    spec: specWith([
      { id: "checkout", type: "checkout", packages: [{ ref_id: "1" }], sdk_hints: { template_family: "limos" } },
    ]),
  });
  assert.ok(codes(errors).includes("template_contract.spec_family"));
});

test("template_contract.status warns when the contract is not agent-ready", () => {
  const { warnings } = run({
    contract: { ...checkoutContract, status: "draft" },
    spec: specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]),
  });
  assert.ok(codes(warnings).includes("template_contract.status"));
});

test("template_contract.catalog_version warns when agentContractVersion is not 1", () => {
  const { warnings } = run({
    contract: checkoutContract,
    agentContractVersion: 2,
    spec: specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]),
  });
  assert.ok(codes(warnings).includes("template_contract.catalog_version"));
});

test("template_contract.brand_contract errors when a promoted catalog family has no residue/pricing contract", () => {
  const { errors } = run({
    family: "fixture-promoted-family",
    contract: checkoutContract,
    spec: specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]),
  });
  assert.ok(codes(errors).includes("template_contract.brand_contract"));
  assert.equal(errors.find((issue) => issue.code === "template_contract.brand_contract").detail.reason, "missing_file");
});

test("limos default exit-pop warns when CampaignSpec has no governed offer surface", () => {
  const { warnings } = run({
    family: "limos",
    contract: checkoutContract,
    spec: specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]),
  });
  assert.ok(codes(warnings).includes("template_contract.exit_pop"));
});

test("limos default exit-pop is clean when CampaignSpec owns checkout exit_intent", () => {
  const { warnings } = run({
    family: "limos",
    contract: checkoutContract,
    spec: specWith([{
      id: "checkout",
      type: "checkout",
      packages: [{ ref_id: "1" }],
      exit_intent: { enabled: true, offer_ref_id: "offer-10", offer_code: "EXIT10" },
    }]),
  });
  assert.equal(codes(warnings).includes("template_contract.exit_pop"), false);
});

test("limos default exit-pop still warns when exit_intent is declared away from checkout", () => {
  const { warnings } = run({
    family: "limos",
    contract: checkoutContract,
    spec: specWith([
      {
        id: "landing",
        type: "landing",
        exit_intent: { enabled: true, offer_ref_id: "offer-10", offer_code: "EXIT10" },
      },
      { id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] },
    ]),
  });
  assert.ok(codes(warnings).includes("template_contract.exit_pop"));
});

test("limos exit-pop residue scan anchors coupon code literals", () => {
  const spec = specWith([{ id: "checkout", type: "checkout", packages: [{ ref_id: "1" }] }]);
  const similarCode = run({
    family: "limos",
    contract: checkoutContract,
    spec,
    targetHtml: '<button data-coupon-code="EXIT10BONUS">Apply</button>',
  });
  assert.equal(codes(similarCode.warnings).includes("template_contract.exit_pop_residue"), false);

  const defaultCode = run({
    family: "limos",
    contract: checkoutContract,
    spec,
    targetHtml: '<button data-coupon-code="EXIT10">Apply</button>',
  });
  assert.ok(codes(defaultCode.warnings).includes("template_contract.exit_pop_residue"));
});

test("template family inventory rejects empty required values", () => {
  const errors = [];
  const ready = [];
  validateTemplateFamilyInventory({
    family: "fixture",
    family_inventory: {
      supported_pages: [],
      required_sdk_anchors: {},
      theme_insertion_point: " ",
      default_color_residue: [],
      pricing_presentation: "",
      bundle_picker: "",
      order_bump: "",
      upsell_downsell: "",
      exit_pop: {},
      qa_selectors: [],
    },
  }, errors, ready);
  assert.ok(codes(errors).includes("template_contract.family_inventory"));
  assert.match(errors[0].message, /supported_pages/);
  assert.equal(ready.length, 0);
});

test("ported checks are exempt for a custom family (matches the private doctor)", () => {
  // custom + agentContractVersion:2 + no checkout packages would trip
  // catalog_version + packages for an automatable family; custom is exempt.
  const { errors, warnings } = run({
    family: "custom",
    agentContractVersion: 2,
    contract: { ...checkoutContract, status: "draft" },
    spec: specWith([{ id: "checkout", type: "checkout" }]),
  });
  for (const code of ["template_contract.packages", "template_contract.upsell_refs", "template_contract.spec_family"]) {
    assert.equal(codes(errors).includes(code), false, `${code} should not fire for custom`);
  }
  for (const code of ["template_contract.status", "template_contract.catalog_version"]) {
    assert.equal(codes(warnings).includes(code), false, `${code} should not fire for custom`);
  }
});
