import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  evaluateSourcePreparation,
  SOURCE_PREP_CODES,
  SOURCE_PREP_DOC_POINTERS,
  SOURCE_PREP_DOCUMENT_WRAPPER,
  SOURCE_PREP_FRONTMATTER_RESIDUE,
  SOURCE_PREP_INTERNAL_LINK_UNROOTED,
} from "./source-prep.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const UNPREPARED_ROOT = resolve(ROOT, "fixtures/source-prep/unprepared");
const PREPARED_ROOT = resolve(ROOT, "fixtures/source-prep/prepared");

function findingsByCode(result) {
  return new Map(result.findings.map((finding) => [finding.code, finding]));
}

test("every source-prep code carries a docs pointer", () => {
  for (const code of SOURCE_PREP_CODES) {
    assert.ok(SOURCE_PREP_DOC_POINTERS[code], `missing docs pointer for ${code}`);
  }
});

test("full-document fixture produces the blocking document-wrapper code", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [{ page_id: "landing", path: "full-document.html" }],
  });
  const byCode = findingsByCode(result);
  const finding = byCode.get(SOURCE_PREP_DOCUMENT_WRAPPER);
  assert.ok(finding, "expected document-wrapper finding");
  assert.equal(finding.severity, "error");
  assert.deepEqual(finding.pages[0].wrappers, ["doctype", "html", "head", "body"]);
  assert.match(finding.message, /docs\/quickstart\.md/);
  assert.match(finding.message, /docs\/source-adapters\.md/);
});

test("recorded preserve_document_wrappers adapter decision downgrades the wrapper finding to a warning", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [{ page_id: "landing", path: "full-document.html" }],
    wrapperPolicy: "preserve_document_wrappers",
  });
  const finding = findingsByCode(result).get(SOURCE_PREP_DOCUMENT_WRAPPER);
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /preserve_document_wrappers/);
});

test("unterminated leading frontmatter fence produces the blocking frontmatter-residue code", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [{ page_id: "landing", path: "unterminated-frontmatter.html" }],
  });
  const finding = findingsByCode(result).get(SOURCE_PREP_FRONTMATTER_RESIDUE);
  assert.ok(finding, "expected frontmatter-residue finding");
  assert.equal(finding.severity, "error");
  assert.deepEqual(finding.pages[0].variants.map((variant) => variant.variant), ["unterminated_leading_fence"]);
});

test("frontmatter block embedded below content produces the blocking frontmatter-residue code", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [{ page_id: "upsell", path: "embedded-frontmatter.html" }],
  });
  const finding = findingsByCode(result).get(SOURCE_PREP_FRONTMATTER_RESIDUE);
  assert.ok(finding, "expected frontmatter-residue finding");
  assert.equal(finding.severity, "error");
  assert.deepEqual(finding.pages[0].variants.map((variant) => variant.variant), ["embedded_block"]);
});

test("internal links that still target source files produce the actionable link code as a warning", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [
      { page_id: "landing", path: "source-file-links.html" },
      { page_id: "checkout", path: "checkout.html" },
      { page_id: "upsell", path: "upsell.html" },
    ],
  });
  const finding = findingsByCode(result).get(SOURCE_PREP_INTERNAL_LINK_UNROOTED);
  assert.ok(finding, "expected internal-link finding");
  assert.equal(finding.severity, "warning");
  assert.deepEqual(finding.pages[0].hrefs, ["checkout.html", "/upsell.html"]);
  assert.match(finding.message, /campaign_link/);
});

test("external, anchor, Liquid, and route-shaped links never fire the link code", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-prep-links-"));
  try {
    writeFileSync(join(dir, "landing.html"), [
      '<a href="https://example.com/page.html">external</a>',
      '<a href="#buy">anchor</a>',
      "<a href=\"{% campaign_link 'checkout' %}\">liquid</a>",
      '<a href="/fixture/checkout/">route</a>',
      '<a href="missing.html">unresolvable source-style link</a>',
    ].join("\n"));
    const result = evaluateSourcePreparation({
      sourceRoot: dir,
      pages: [{ page_id: "landing", path: "landing.html" }],
    });
    assert.equal(findingsByCode(result).has(SOURCE_PREP_INTERNAL_LINK_UNROOTED), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source-file link to a mapped page fires even when the file is missing on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-prep-mapped-"));
  try {
    writeFileSync(join(dir, "landing.html"), '<a href="checkout.html">buy</a>');
    const result = evaluateSourcePreparation({
      sourceRoot: dir,
      pages: [
        { page_id: "landing", path: "landing.html" },
        { page_id: "checkout", path: "checkout.html" },
      ],
    });
    const finding = findingsByCode(result).get(SOURCE_PREP_INTERNAL_LINK_UNROOTED);
    assert.ok(finding, "mapped-page link should fire without the target file on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepared fixtures pass the preparation check", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: PREPARED_ROOT,
    pages: [
      { page_id: "landing", path: "landing.html" },
      { page_id: "checkout", path: "checkout.html" },
    ],
  });
  assert.equal(result.checked_page_count, 2);
  assert.deepEqual(result.findings, []);
});

test("closed leading frontmatter plus content fences without frontmatter keys stay clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-prep-clean-"));
  try {
    writeFileSync(join(dir, "landing.html"), [
      "---",
      "page_type: product",
      "title: Clean",
      "---",
      "<section>copy</section>",
      "---",
      "<section>a bare divider pair is content, not frontmatter</section>",
      "---",
      "<section>tail</section>",
    ].join("\n"));
    const result = evaluateSourcePreparation({
      sourceRoot: dir,
      pages: [{ page_id: "landing", path: "landing.html" }],
    });
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or unmapped page files are skipped, not classified", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-prep-skip-"));
  try {
    mkdirSync(dir, { recursive: true });
    const result = evaluateSourcePreparation({
      sourceRoot: dir,
      pages: [
        { page_id: "landing", path: "missing.html" },
        { page_id: "checkout", skip_reason: "out of scope" },
      ],
    });
    assert.equal(result.checked_page_count, 0);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findings aggregate per code across pages with deterministic order", () => {
  const result = evaluateSourcePreparation({
    sourceRoot: UNPREPARED_ROOT,
    pages: [
      { page_id: "landing", path: "full-document.html" },
      { page_id: "presell", path: "embedded-frontmatter.html" },
      { page_id: "offer", path: "source-file-links.html" },
      { page_id: "checkout", path: "checkout.html" },
      { page_id: "upsell", path: "upsell.html" },
    ],
  });
  assert.deepEqual(result.findings.map((finding) => finding.code), [
    SOURCE_PREP_DOCUMENT_WRAPPER,
    SOURCE_PREP_FRONTMATTER_RESIDUE,
    SOURCE_PREP_INTERNAL_LINK_UNROOTED,
  ]);
});
