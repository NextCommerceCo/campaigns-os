/**
 * Template-contract doctor checks ported from the private doctor (ADR-003 step 2).
 * Covers the shared-concern checks now in the public doctor: packages, upsell_refs,
 * spec_family, status, catalog_version.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCommerceCatalog } from "./cli.mjs";

const codes = (issues) => issues.map((issue) => issue.code);

// Run validateCommerceCatalog against a temp catalog + the given spec/contract,
// returning the emitted errors/warnings.
function run({ contract, spec, agentContractVersion = 1, family = "olympus" }) {
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
    validateCommerceCatalog(packet, join(dir, "packet.json"), spec, errors, warnings, ready);
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
