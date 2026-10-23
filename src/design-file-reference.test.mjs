import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesignFileReference, resolveDesignFileReferences } from "./design-file-reference.mjs";

const A = "https://www.figma.com/design/SYNTHKEYA0001/synthetic-file?node-id=1-2";
const B = "https://www.figma.com/design/SYNTHKEYB0002/synthetic-other";
const resolve = (pages, entries, mappings = pages.map((page) => ({ page_id: page.id, path: `${page.id}.html` }))) => resolveDesignFileReferences({ activePages: pages, mappings, manifest: { pages: entries } });

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
