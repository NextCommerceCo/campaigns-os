import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TEMPLATE_SLOT_MANIFEST_SCHEMA,
  SLOT_SOURCE_POLICIES,
  loadTemplateSlotManifest,
  templateSlotManifestPath,
  sharedContentCorePath,
  manifestPageSlots,
  declaredSlotKeys,
  commerceOwnedPages,
  urgencySlots,
  proofSlots,
} from "./template-slot-manifest.mjs";

const FAMILIES = [
  "apollo",
  "apollo-mv-single-step",
  "demeter",
  "olympus",
  "olympus-mv-single-step",
  "olympus-mv-two-step",
  "shop-single-step",
  "shop-three-step",
];

test("shared content-slot core parses and declares the schema", () => {
  const core = JSON.parse(readFileSync(sharedContentCorePath(), "utf8"));
  assert.equal(core.schema_version, TEMPLATE_SLOT_MANIFEST_SCHEMA);
  assert.ok(core.pages.presell);
  assert.ok(core.pages.landing);
  assert.equal(core.pages.checkout.commerce_owned, true);
});

test("every family manifest loads, extends the core, and matches its family", () => {
  for (const family of FAMILIES) {
    const manifest = loadTemplateSlotManifest(family);
    assert.ok(manifest, `manifest missing for ${family} at ${templateSlotManifestPath(family)}`);
    assert.equal(manifest.family, family);
    // extends merge pulled the core pages in
    assert.ok(manifestPageSlots(manifest, "presell").length > 0, `${family} presell slots empty`);
    assert.ok(manifestPageSlots(manifest, "landing").length > 0, `${family} landing slots empty`);
    assert.ok(commerceOwnedPages(manifest).has("checkout"), `${family} must mark checkout commerce-owned`);
  }
});

test("every slot carries a description and a known source policy (or is commerce-owned)", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  const pages = ["presell", "landing", "upsell-bundle-stepper", "upsell-bundle-tier-cards", "upsell-bundle-tier-pills", "receipt"];
  for (const page of pages) {
    for (const slot of manifestPageSlots(manifest, page)) {
      assert.ok(slot.description && slot.description.length >= 10, `${page}.${slot.key} lacks a semantic description`);
      if (slot.kind === "commerce") continue;
      assert.ok(
        SLOT_SOURCE_POLICIES.includes(slot.source_policy),
        `${page}.${slot.key} has unknown source_policy "${slot.source_policy}"`,
      );
    }
  }
});

test("copy slots carry length bands", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  for (const slot of manifestPageSlots(manifest, "presell")) {
    if (slot.kind !== "copy") continue;
    assert.ok(slot.length_band_chars, `presell.${slot.key} (copy) lacks length_band_chars`);
    assert.ok(slot.length_band_chars.min <= slot.length_band_chars.max, `presell.${slot.key} band inverted`);
  }
});

test("urgency slots are enumerated and flagged enabled_by_verified_urgency", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  const keys = urgencySlots(manifest, "presell").map((slot) => slot.key).sort();
  assert.deepEqual(keys, ["countdown_label", "sell_out_risk", "sell_out_text"]);
  for (const slot of urgencySlots(manifest, "presell")) {
    assert.equal(slot.source_policy, "spec_truth", `${slot.key} urgency must be spec truth`);
  }
});

test("layout-owned proof surfaces are slots: presell rating + byline; landing reviews/counts", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  const presellProof = new Set(proofSlots(manifest, "presell").map((slot) => slot.key));
  assert.ok(presellProof.has("article_rating_text"), "article_rating_text must be a proof slot");
  assert.ok(presellProof.has("author_name"), "author_name must be a proof slot");
  const landingProof = proofSlots(manifest, "landing");
  assert.ok(landingProof.length >= 40, `expected the landing proof inventory, got ${landingProof.length}`);
  for (const slot of landingProof) {
    assert.equal(slot.source_policy, "merchant_asset_required", `${slot.key}: proof is merchant-supplied, never generated`);
    assert.ok(slot.proof_modality, `${slot.key} lacks proof_modality`);
  }
});

test("title (page meta) is part of the copy slot set on every content page", () => {
  const manifest = loadTemplateSlotManifest("apollo");
  for (const page of ["presell", "landing", "upsell-bundle-stepper", "receipt"]) {
    assert.ok(declaredSlotKeys(manifest, page).has("title"), `${page} must declare title`);
  }
});

test("family overlays declare their family-specific keys", () => {
  const shop = loadTemplateSlotManifest("shop-single-step");
  assert.ok(declaredSlotKeys(shop, "landing").has("cta_params"), "shop family must declare SHARED.cta_params");
  assert.ok(declaredSlotKeys(shop, "receipt").has("receipt_summary"));
  const apollo = loadTemplateSlotManifest("apollo");
  assert.ok(!declaredSlotKeys(apollo, "landing").has("cta_params"), "cta_params is not an apollo key");
  const mv = loadTemplateSlotManifest("apollo-mv-single-step");
  assert.ok(commerceOwnedPages(mv).has("upsell-mv"));
  assert.ok(commerceOwnedPages(mv).has("variant-picker"));
});
