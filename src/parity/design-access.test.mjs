import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { evaluateDesignAccess } from "./design-access.mjs";
import { resolveDesignFileReferences } from "../design-file-reference.mjs";
import { synthesizeHtmlFunnelDesignSourcePackage } from "../design-source-package.mjs";
import { buildQcHandoff, qcHandoffTextLines } from "../qc-accept.mjs";

const A = "https://www.figma.com/design/SYNTHKEYA0001/synthetic-file?node-id=1-2";
const B = "https://www.figma.com/design/SYNTHKEYB0002/synthetic-other";
const CHANGE = "The design file named for this page differs from the one the Design Source Package records. Rerun intake with `--force` to record the current one.";
const CONFLICT = "The CampaignSpec page and the source-html manifest name different design files or frames for this page (or the manifest's producer file key differs). The package records the CampaignSpec's. Correct the wrong one and rerun intake with `--force`.";
// Independent §3.1 oracle: neither the resolver nor its canonicalizer is used.
const identitySha = (identity) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
const SHA_A = identitySha({ type: "figma", file_key: "SYNTHKEYA0001" });
const SHA_B = identitySha({ type: "figma", file_key: "SYNTHKEYB0002" });
const CID_A = `design-file-${SHA_A.slice(0, 12)}`;
const NOW = "2026-08-22T10:00:00.000Z";
const canonical = (value) => JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
function assertState(result, { reason = "design_reference_conflict", declared = SHA_A, recorded = SHA_A, identities = [], frames = [], type = "figma", declaredBy = "campaign_spec", kind = reason === "design_reference_conflict" ? "spec_vs_manifest" : null, declaredFrames = [] } = {}) {
  const state = { reason_code: reason, recorded_identity_sha256: recorded, declared_identity_sha256: declared, conflict_identities: identities, conflict_frames: frames };
  const subject = { check: "design.access", page: "landing", key: "file" };
  const fingerprint = createHash("sha256").update(canonical({ scope: "qc", subject, state })).digest("hex");
  assert.deepEqual(result, { schema: "campaigns-os-qc-result/v0", id: "design.access:landing:file", check: "design.access", leg: "doctor", subject,
    result: ["design_reference_conflict", "design_reference_missing", "design_reference_changed"].includes(reason) ? "review" : "unexercised", reason_code: reason,
    state, state_fingerprint: `sha256:${fingerprint}`, observation: { type, kind, declared_by: declaredBy, frames_declared: declaredFrames, reader: "none", recorded_contribution_id: recorded == null ? null : `design-file-${recorded.slice(0, 12)}` },
    members: [], accept_eligible: false, coverage: { observed: 1, expected: 1, limits: [] }, measured_at: NOW, producer: "campaigns-os doctor" });
}
function assertRecorded(input, frames = {}) {
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(input);
  const contribution = dsp.contributions.find((entry) => entry.id === CID_A);
  assert.ok(contribution);
  assert.deepEqual(contribution.source_refs, [
    { id: `${CID_A}-file`, kind: "url", url: A, role: "design_file" },
    ...Object.entries(frames).map(([viewport, url]) => ({ id: `${CID_A}-landing-frame-${viewport}`, kind: "url", url, role: `design_frame:${viewport}` })),
  ]);
  assert.deepEqual(contribution.mappings, [{ id: `${CID_A}-landing-coverage`, surface_id: "landing", coverage_role: "reference_only", confidence: "high", source_refs: contribution.source_refs.map((ref) => ref.id), screenshot_refs: [], reference_refs: [] }]);
  assert.equal(dsp.contributions[0].mappings[0].derived_from, CID_A);
}
function inputs(spec = null, manifestFile = null, producer = {}) {
  return { activePages: [{ id: "landing", type: "landing", ...(spec ? { design_source: spec } : {}) }], mappings: [{ page_id: "landing", path: "landing.html" }], manifest: { schema_version: "source-html-manifest/v0", producer_provenance: { source_type: "semantic_figma_export", screenshot_fallback_used: false, semantic_section_count: 1, material_fingerprint: "a".repeat(64), section_exports: [{ section: "hero", node_ids: { desktop: "1:2" } }], ...producer }, files: [{ role: "partial" }, { role: "asset" }], pages: [{ page_id: "landing", path: "landing.html", ...(manifestFile ? { design_file: manifestFile } : {}) }] } };
}
function row(input, recorded = input) {
  const rows = evaluateDesignAccess({ ...input, designSourcePackage: synthesizeHtmlFunnelDesignSourcePackage({ ...recorded, generatedAt: "2026-08-22T10:00:00.000Z" }), measured_at: "2026-08-22T10:00:00.000Z" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accept_eligible, false);
  assert.doesNotMatch(JSON.stringify(rows[0]), /https:/);
  return rows[0];
}
function review(result, reason, text) {
  assert.equal(result.result, "review");
  assert.equal(result.reason_code, reason);
  const handoff = buildQcHandoff({ results: [result] });
  assert.equal(handoff.review[0].summary, text);
  assert.deepEqual(qcHandoffTextLines(handoff).filter((line) => line.includes("design.access:")), [`  - design.access:landing:file@${result.state_fingerprint.slice(7, 19)} ${text}`]);
}

test("P1-B1: spec identity wins a conflicting manifest, review names both identities", () => {
  const input = inputs({ type: "figma", file_url: A }, { file_url: B });
  const result = row(input);
  review(result, "design_reference_conflict", CONFLICT);
  const resolution = resolveDesignFileReferences(input);
  assert.equal(resolution.files[0].file_url, A);
  assertState(result, { identities: [SHA_A, SHA_B].sort() });
  assertRecorded(input);
});
test("P1-B1b: same-file frame conflict keeps spec frames and duplicate identity hashes", () => {
  const input = inputs({ file_url: A, breakpoints: { desktop: A } }, { file_url: A, breakpoints: { desktop: A.replace("1-2", "5-6") } });
  const result = row(input);
  review(result, "design_reference_conflict", CONFLICT);
  assertState(result, { identities: [SHA_A, SHA_A], frames: ["desktop"], declaredFrames: ["desktop"] });
  assertRecorded(input, { desktop: A });
  assert.equal(resolveDesignFileReferences(input).pages[0].declaration.frames.desktop.node_id, "1:2");
});
test("P1-B2: producer key corroborates only, and disagreement is review", () => {
  const input = inputs(null, { file_url: A }, { figma_file_key: "SYNTHKEYZ9999" });
  const result = row(input);
  review(result, "design_reference_conflict", CONFLICT);
  assert.equal(result.observation.kind, "producer_file_key");
  assertState(result, { identities: [SHA_A], declaredBy: "source_html_manifest", kind: "producer_file_key" });
  assertRecorded(input);
  assert.equal(resolveDesignFileReferences(input).files[0].file_url, A);
});

for (const type of ["figma", "other", "sketch", "ai-generated", "penpot", "hand-authored", "custom-tool", "SKETCH"]) {
  for (const channel of ["manifest", "spec"]) {
    test(channel === "spec" && type !== "figma"
      ? `A-P5a: spec ${type} records no contribution even with Figma provenance`
      : `P1-I2: fresh ${channel} ${type} retains the exact identity type after serialized intake`, () => {
      const file = { type, file_url: type === "figma" ? A : "https://design.example.test/f/synthetic-b?x=1#frame" };
      const input = channel === "manifest" ? inputs(null, file) : inputs(file);
      const dsp = JSON.parse(JSON.stringify(synthesizeHtmlFunnelDesignSourcePackage(input)));
      if (channel === "spec" && type !== "figma") {
        assert.equal(dsp.contributions.some((entry) => entry.provenance?.source_type === "design_file"), false);
        assert.ok(dsp.contributions[0].mappings.every((mapping) => !Object.hasOwn(mapping, "derived_from")));
        assert.deepEqual(evaluateDesignAccess({ ...input, designSourcePackage: dsp, measured_at: NOW }), []);
        return;
      }
      const [result] = evaluateDesignAccess({ ...input, designSourcePackage: dsp, measured_at: NOW });
      const sha = identitySha(type === "figma" ? { type, file_key: "SYNTHKEYA0001" } : { type: type.toLowerCase(), url: "https://design.example.test/f/synthetic-b" });
      const declaredBy = channel === "manifest" ? "source_html_manifest" : "campaign_spec";
      assertState(result, { reason: "design_access_missing", recorded: sha, declared: sha, type: type.toLowerCase(), declaredBy });
      assert.equal(result.result, "unexercised");
      assert.equal(result.observation.type, type.toLowerCase());
      assert.equal(result.observation.recorded_contribution_id, `design-file-${sha.slice(0, 12)}`);
      assert.equal(result.accept_eligible, false);
      const changed = structuredClone(input);
      (channel === "manifest" ? changed.manifest.pages[0].design_file : changed.activePages[0].design_source).type = "different-tool";
      const [changedRow] = evaluateDesignAccess({ ...changed, designSourcePackage: dsp, measured_at: NOW });
      const changedSha = identitySha({ type: "different-tool", url: new URL(file.file_url).origin + new URL(file.file_url).pathname });
      assertState(changedRow, { reason: "design_reference_changed", recorded: sha, declared: changedSha, type: "different-tool", declaredBy });
      assert.equal(changedRow.result, "review");
    });
  }
}
for (const shape of ["manifest absent", "declaration removed"]) {
  test(`design access: ${shape} reports missing with both recovery choices`, () => {
    const recorded = inputs(null, { file_url: A });
    const current = structuredClone(recorded);
    if (shape === "manifest absent") current.manifest = null;
    else delete current.manifest.pages[0].design_file;
    const result = row(current, recorded);
    review(result, "design_reference_missing", "The Design Source Package records a design file, but this page no longer has a design-file declaration. Restore the declaration, or rerun intake with `--force` to drop the recorded file.");
    assertState(result, { reason: "design_reference_missing", declared: null, declaredBy: null });
  });
}
test("design access compares the file identity, not later breakpoint selections", () => {
  const recorded = inputs({ file_url: A, breakpoints: { desktop: A } });
  const current = structuredClone(recorded);
  current.activePages[0].design_source.breakpoints.desktop = A.replace("1-2", "9-9");
  assert.equal(row(current, recorded).reason_code, "design_access_missing");
});
test("design access: missing package is unrecorded and unchanged inputs have no row", () => {
  const [result] = evaluateDesignAccess(inputs({ file_url: A }));
  assert.equal(result.result, "unexercised");
  assert.equal(result.reason_code, "design_reference_not_recorded");
  assert.deepEqual(evaluateDesignAccess(inputs()), []);
});

test("design access: malformed package collections cannot crash doctor or prove access", () => {
  const input = inputs({ file_url: A });
  for (const mappings of [null, {}, "invalid", [null]]) {
    const [result] = evaluateDesignAccess({ ...input, designSourcePackage: { surface_identity: [{ id: "landing", kind: "page", mappings: { campaign_spec_page_id: "landing" } }], contributions: [{ provenance: { source_type: "design_file" }, mappings, source_refs: {} }] } });
    assert.equal(result.result, "unexercised");
    assert.equal(result.reason_code, "design_reference_not_recorded");
  }
});
