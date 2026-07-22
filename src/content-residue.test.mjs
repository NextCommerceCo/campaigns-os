import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanRenderedHtml,
  scanBuiltOutputContentResidue,
  evaluateProofAssets,
  attestationBlockers,
  briefUrgencyVerified,
} from "./content-residue.mjs";

test("needs-merchant-input marker is a hard finding", () => {
  const { hard } = scanRenderedHtml("<p>⚠ NEEDS MERCHANT INPUT: author_name ⚠</p>");
  assert.equal(hard.length, 1);
  assert.equal(hard[0].id, "needs_merchant_input_marker");
});

test("countdown chrome without verified urgency is hard; with verified urgency it is clean", () => {
  const html = '<span data-countdown-hrs>02</span>';
  assert.equal(scanRenderedHtml(html).hard[0].id, "unverified_urgency_countdown");
  assert.equal(scanRenderedHtml(html, { urgencyVerified: true }).hard.length, 0);
});

test("scarcity language is a review hit unless urgency is verified", () => {
  const html = "<p>Only 58 Units Left — Sell-Out Risk: High</p>";
  const unverified = scanRenderedHtml(html);
  assert.ok(unverified.review.some((f) => f.id === "scarcity_theater"));
  const verified = scanRenderedHtml(html, { urgencyVerified: true });
  assert.ok(!verified.review.some((f) => f.id === "scarcity_theater"));
});

test("bracket stubs and demo residue are review findings; CSS attribute selectors are not", () => {
  const { review } = scanRenderedHtml("<h2>[Real Review Proof Goes Here]</h2><style>[data-x]{color:red}</style>");
  assert.ok(review.some((f) => f.id === "bracket_placeholder_stub"));
  const clean = scanRenderedHtml("<style>span[data-countdown-label]{display:none}</style>");
  assert.ok(!clean.review.some((f) => f.id === "bracket_placeholder_stub"));
  const demo = scanRenderedHtml("<em>by Sarah Mitchell · Wellness Insider</em>");
  assert.ok(demo.review.filter((f) => f.id === "demo_residue_term").length >= 2);
});

test("anti-pattern classes: invented counts, verified-buyer chrome, science theater, press marquee", () => {
  const { review } = scanRenderedHtml(
    "<p>Backed by 1,200 reviews. Verified Buyer. Clinically proven. As Seen On TV.</p>",
  );
  const ids = new Set(review.map((f) => f.id));
  for (const id of ["invented_counts", "verified_buyer_chrome", "science_theater", "press_marquee"]) {
    assert.ok(ids.has(id), `expected ${id}`);
  }
});

test("clean generated copy produces no findings", () => {
  const { hard, review } = scanRenderedHtml(
    "<h1>Why Your Neck Hurts Every Morning</h1><p>Instead of one big jolt, the formula spreads support across the morning.</p>",
  );
  assert.equal(hard.length, 0);
  assert.deepEqual(review, []);
});

test("scanBuiltOutputContentResidue walks pages and skips _includes", () => {
  const dir = mkdtempSync(join(tmpdir(), "residue-"));
  mkdirSync(join(dir, "presell"));
  mkdirSync(join(dir, "_includes"));
  writeFileSync(join(dir, "presell", "index.html"), "<p>NEEDS MERCHANT INPUT: x</p>");
  writeFileSync(join(dir, "_includes", "part.html"), "<p>NEEDS MERCHANT INPUT: ignored</p>");
  const findings = scanBuiltOutputContentResidue(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, join("presell", "index.html"));
});

test("proof attestation: usable states ship freely; shipped pending/non-attestable block", () => {
  const assets = [
    { id: "pa-1", modality: "count", content: "89% reported better sleep", verified: false, attestable: true, attestation_status: "accepted" },
    { id: "pa-2", modality: "study", content: "developed with NASA scientists", verified: false, attestable: false, attestation_status: "none" },
    { id: "pa-3", modality: "count", content: "546,000+ happy sleepers", verified: false, attestable: true, attestation_status: "pending" },
  ];
  const shippedAll = "In FluffCo's own survey, 89% reported better sleep. Developed with NASA scientists. 546,000+ happy sleepers.";
  const findings = evaluateProofAssets(assets, shippedAll);
  const { shippedNonAttestable, shippedPending } = attestationBlockers(findings);
  assert.deepEqual(shippedNonAttestable.map((f) => f.assetId), ["pa-2"]);
  assert.deepEqual(shippedPending.map((f) => f.assetId), ["pa-3"]);

  const excluded = evaluateProofAssets(assets, "In FluffCo's own survey, 89% reported better sleep. Nothing else.");
  const blockers = attestationBlockers(excluded);
  assert.equal(blockers.shippedNonAttestable.length, 0, "excluded non-attestable content must not block");
  assert.equal(blockers.shippedPending.length, 0);
});

test("comments and scripts never trigger hard findings; attributes still do", () => {
  const commentOnly = "<!-- NEEDS MERCHANT INPUT docs --><script>document.querySelector('[data-countdown-hrs]')</script>";
  const { hard } = scanRenderedHtml(commentOnly);
  assert.equal(hard.length, 0);
  const inAlt = '<img alt="⚠ NEEDS MERCHANT INPUT: author_name ⚠">';
  assert.equal(scanRenderedHtml(inAlt).hard[0].id, "needs_merchant_input_marker");
});

test("a comment occurrence does not mask a later visible anti-pattern hit", () => {
  const html = "<!-- Verified Buyer component --><p>ok</p><span>Verified Buyer</span>";
  const { review } = scanRenderedHtml(html);
  assert.ok(review.some((f) => f.id === "verified_buyer_chrome"));
});

test("ordinary commerce quantities are not invented counts", () => {
  const { review } = scanRenderedHtml("<p>Choose 3 pairs and save. Buy 2 items today.</p>");
  assert.ok(!review.some((f) => f.id === "invented_counts"));
});

test("attestation matching survives entity encoding, inline tags, and short claims", () => {
  const assets = [
    { id: "pa-a", modality: "study", content: "Smith & Jones study", verified: false, attestable: true, attestation_status: "pending" },
    { id: "pa-b", modality: "count", content: "89%", verified: false, attestable: false, attestation_status: "none" },
  ];
  const html = "<p>Backed by the Smith &amp; Jones <strong>study</strong>. 89% agreed.</p>";
  const { shippedNonAttestable, shippedPending } = attestationBlockers(evaluateProofAssets(assets, html));
  assert.deepEqual(shippedPending.map((f) => f.assetId), ["pa-a"]);
  assert.deepEqual(shippedNonAttestable.map((f) => f.assetId), ["pa-b"]);
});

test("briefUrgencyVerified reads offer.urgency.verified", () => {
  assert.equal(briefUrgencyVerified({ offer: { urgency: { verified: true } } }), true);
  assert.equal(briefUrgencyVerified({ offer: { urgency: { verified: false } } }), false);
  assert.equal(briefUrgencyVerified(null), false);
});
