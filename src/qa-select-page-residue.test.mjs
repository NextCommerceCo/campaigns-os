// Reachability proof for the `select` page type (#207).
//
// Making `select` a real PageType turned on QA coverage that the shipped brand
// contracts already declared but that could never fire: no spec-valid page
// could carry the type, so `templateResidueAssertions` returned early for the
// selector step and every `page_types: [..., "select", ...]` entry was inert.
//
// Turning a gate on is the risky half of this change — ON-2 re-ranked
// "gate-first, capability-later" as a live failure mode after a checkpoint
// shipped that could not pass on any real page. So these tests do not merely
// assert the checks now RUN on a selector page; they assert a real branded
// selector page PASSES them. A gate that cannot pass is the bug being guarded
// against here.

import test from "node:test";
import assert from "node:assert/strict";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { forbiddenComputedColors, loadTemplateBrandContract } from "./template-brand-contract.mjs";

const {
  RESIDUE_PAGE_TYPES,
  computedStyleResidueAssertions,
  logoResidueAssertion,
} = __qaBrowserTestHooks;

const contract = loadTemplateBrandContract("olympus-mv-two-step");
const forbidden = forbiddenComputedColors(contract);
const selectPage = { page_id: "select", page_type: "select", url: "https://example.test/c/select/" };

// Mirrors the scoping in templateResidueAssertions: a check applies to a page
// when its page_types names that page's contract type.
const checksFor = (pageType) =>
  (contract.qa_inspection?.computed_style_checks || []).filter((check) => (check.page_types || []).includes(pageType));

test("the selector step is inside the commerce residue scope", () => {
  // Before #207 this list was ["checkout", "upsell", "downsell", "receipt"] and
  // the selector page fell out of residue checking entirely.
  assert.ok(RESIDUE_PAGE_TYPES.includes("select"));
  // The projection and the other commerce surfaces are unchanged.
  assert.deepEqual([...RESIDUE_PAGE_TYPES], ["checkout", "select", "upsell", "downsell", "receipt"]);
});

test("the contract declares selector-scoped style checks, and they now resolve", () => {
  const checks = checksFor("select");
  // Guard the intent, not a specific id: the contract must scope at least one
  // computed-style check to the selector step, whatever it is called. If this
  // fails, the contract moved — update the proof below to match.
  assert.ok(
    checks.length >= 1,
    `expected olympus-mv-two-step to scope at least one computed_style_check to "select"; found ${checks.length}. The contract moved — update this reachability proof.`,
  );
  // Every select-scoped check must also be a real, runnable check.
  for (const check of checks) {
    assert.ok(check.id, "a select-scoped check is missing an id");
    assert.ok(check.selector, `select-scoped check ${check.id} is missing a selector`);
  }
  // The known one, pinned separately so a rename is a clear, single failure
  // rather than an opaque count mismatch.
  const bundleCard = checks.find((check) => check.id === "selected_bundle_card");
  assert.ok(bundleCard, `expected a "selected_bundle_card" check scoped to select; found: ${checks.map((c) => c.id).join(", ")}`);
  assert.equal(bundleCard.selector, ".os-card.next-selected");
  // It was always declared for both surfaces; only checkout could ever reach it.
  assert.deepEqual(bundleCard.page_types, ["checkout", "select"]);
});

test("reachability: a branded selector page PASSES every newly scoped style check", () => {
  // Whatever the contract scopes to select must be passable on a real branded
  // page — proved for all of them, so adding a check to the contract cannot
  // quietly introduce an unpassable gate.
  for (const check of checksFor("select")) {
    const result = computedStyleResidueAssertions({
      page: selectPage,
      evidence: [{
        id: check.id,
        selector: check.selector,
        optional: check.optional,
        found: true,
        // A real brand's selected-card treatment — arcticclip's palette.
        properties: { "border-color": "rgb(11, 32, 24)", "outline-color": "rgb(232, 255, 105)" },
      }],
      forbidden,
      severity: "blocker",
    })[0];

    assert.equal(result.status, "pass", `select-scoped check ${check.id} cannot pass on a branded page`);
    assert.equal(result.severity, undefined);
    assert.equal(result.page, selectPage.page_id);
  }
});

test("reachability: a branded selector-page logo PASSES the newly scoped logo check", () => {
  const logo = contract.default_residue?.logo;
  assert.ok((logo.page_types || []).includes("select"));

  const result = logoResidueAssertion({
    page: selectPage,
    logo,
    sources: ["https://cdn.example.test/arcticclip/logo.svg"],
    severity: "blocker",
  });
  assert.equal(result.status, "pass");
});

test("the gate still bites: starter residue on a selector page is a blocker", () => {
  // The point of turning coverage on. An unbranded selector step shipping the
  // starter palette now fails where it previously passed silently.
  const check = checksFor("select").find((entry) => entry.id === "selected_bundle_card");
  const result = computedStyleResidueAssertions({
    page: selectPage,
    evidence: [{
      id: check.id,
      selector: check.selector,
      optional: check.optional,
      found: true,
      properties: { "border-color": "rgb(60, 125, 255)" },
    }],
    forbidden,
    severity: "blocker",
  })[0];

  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");

  const starterLogo = logoResidueAssertion({
    page: selectPage,
    logo: contract.default_residue.logo,
    sources: ["/c/select/images/next-logo.png"],
    severity: "blocker",
  });
  assert.equal(starterLogo.status, "fail");
});

test("a selector page with no rendered bundle card is skipped, not blocked", () => {
  // selected_bundle_card is optional: a selector step whose cards are not in the
  // selected state when the check runs must not become a false blocker. This is
  // the failure mode that would make the new coverage unreachable in practice.
  const check = checksFor("select").find((entry) => entry.id === "selected_bundle_card");
  const result = computedStyleResidueAssertions({
    page: selectPage,
    evidence: [{ id: check.id, selector: check.selector, optional: true, found: false, properties: {} }],
    forbidden,
    severity: "blocker",
  })[0];

  assert.notEqual(result.status, "fail");
});
