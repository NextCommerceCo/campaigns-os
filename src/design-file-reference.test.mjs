import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesignFileReference, resolveDesignFileReferences } from "./design-file-reference.mjs";

const A = "https://www.figma.com/design/SYNTHKEYA0001/synthetic-file?node-id=1-2";
const B = "https://www.figma.com/design/SYNTHKEYB0002/synthetic-other";
const resolve = (pages, entries, mappings = pages.map((page) => ({ page_id: page.id, path: `${page.id}.html` }))) => resolveDesignFileReferences({ activePages: pages, mappings, manifest: { pages: entries } });

test("R4-3: only a valid branch key replaces the file key", () => {
  for (const kind of ["file", "design", "proto", "board"]) {
    for (const suffix of ["branch", "branch/", "branch/my-name", "name/branch", "name/branch/my-name"]) {
      assert.deepEqual(normalizeDesignFileReference({ file_url: `https://www.figma.com/${kind}/KEY1/${suffix}` }).declaration.identity,
        { type: "figma", file_key: "KEY1" }, `${kind}/${suffix}`);
    }
    assert.deepEqual(normalizeDesignFileReference({ file_url: `https://www.figma.com/${kind}/KEY1/name/branch/BRANCH2` }).declaration.identity,
      { type: "figma", file_key: "BRANCH2" });
  }
});

test("design reference normalization: identity, branch, URL fallback, frame nodes and unusable declarations", () => {
  const normal = (value) => normalizeDesignFileReference(value).declaration;
  assert.deepEqual(normal({ file_url: A }).identity, { type: "figma", file_key: "SYNTHKEYA0001" });
  assert.deepEqual(normal({ type: "FIGMA", file_url: `${A.split("?")[0]}/branch/SYNTHBRANCH0001` }).identity, { type: "figma", file_key: "SYNTHBRANCH0001" });
  assert.deepEqual(normal({ file_url: "https://design.example.test/f/synthetic-b?q=x#y" }).identity, { type: "other", url: "https://design.example.test/f/synthetic-b" });
  for (const file_url of [42, "", "relative", "http://design.example.test/f", null]) assert.equal(normal({ file_url }), null);
  const frames = normalizeDesignFileReference({ file_url: A, breakpoints: { desktop: A, mobile: "bad" } });
  assert.deepEqual(frames.declaration.frames, { desktop: { url: A, node_id: "1:2" } });
  assert.equal(frames.warnings.length, 1);
});

test("P1-B7: duplicate matching paths are ambiguous; a distinct second path keeps the unique match", () => {
  const entries = [{ page_id: "landing", path: "landing.html", design_file: { file_url: A } }, { page_id: "landing", path: "landing.html", design_file: { file_url: B } }];
  assert.deepEqual(resolve([{ id: "landing" }], entries), { pages: [], files: [] });
  entries[1].path = "landing-old.html";
  assert.equal(resolve([{ id: "landing" }], entries).pages[0].declaration.file_url, A);
});

test("P1-I4: skipped declarations create no resolved page or file", () => {
  assert.deepEqual(resolve([{ id: "landing" }], [{ page_id: "landing", skip_reason: "template stock", design_file: { file_url: A } }], [{ page_id: "landing", skip_reason: "template stock" }]), { pages: [], files: [] });
});

const exportManifest = () => ({
  producer_provenance: { source_type: "semantic_figma_export", screenshot_fallback_used: false, semantic_section_count: 1, material_fingerprint: "a".repeat(64), section_exports: [{ section: "hero", node_ids: { desktop: "1:2" } }] },
  files: [{ role: "partial" }, { role: "asset" }],
});
test("A-P5: spec lineage uses all of the existing provenance gate's blockers", () => {
  const args = { activePages: [{ id: "landing", design_source: { file_url: A } }], mappings: [{ page_id: "landing", path: "landing.html" }], manifest: exportManifest() };
  assert.equal(resolveDesignFileReferences(args).files.length, 1);
  for (const invalidate of [
    (m) => { delete m.producer_provenance; },
    (m) => { m.producer_provenance.source_type = "hand_authored"; },
    (m) => { m.producer_provenance.screenshot_fallback_used = true; },
    (m) => { m.producer_provenance.semantic_section_count = 0; },
    (m) => { m.producer_provenance.material_fingerprint = "invalid"; },
    (m) => { m.producer_provenance.section_exports = []; },
    (m) => { m.files = [{ role: "asset" }]; },
    (m) => { m.files = [{ role: "partial" }]; },
  ]) {
    const input = structuredClone(args);
    invalidate(input.manifest);
    assert.deepEqual(resolveDesignFileReferences(input), { pages: [], files: [] });
    input.manifest.pages = [{ page_id: "landing", path: "landing.html", design_file: { file_url: B } }];
    assert.equal(resolveDesignFileReferences(input).files[0].file_url, B, "manifest channel remains its own evidence");
  }
});
