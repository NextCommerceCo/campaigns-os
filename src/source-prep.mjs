// Source preparation check (#262): deterministic classification of the common
// unprepared-source failures the docs name as pre-build preparation steps —
// unstripped document wrappers, leftover/broken YAML frontmatter, and internal
// links still pointing at source files instead of CampaignSpec routes. The
// scope is the certified template families' page-kit ingestion expectations
// (docs/quickstart.md "Prepare Raw HTML Source", docs/source-adapters.md);
// this is NOT a general HTML linter. Asset-path rooting stays owned by the
// source asset crawl (source_asset.* codes) so the two checks never disagree
// about the same reference.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectDocumentWrapperNames } from "./adapter-decision-contract.mjs";

export const SOURCE_PREP_DOCUMENT_WRAPPER = "source_html.prep.document_wrapper";
export const SOURCE_PREP_FRONTMATTER_RESIDUE = "source_html.prep.frontmatter_residue";
export const SOURCE_PREP_INTERNAL_LINK_UNROOTED = "source_html.prep.internal_link_unrooted";

export const SOURCE_PREP_CODES = Object.freeze([
  SOURCE_PREP_DOCUMENT_WRAPPER,
  SOURCE_PREP_FRONTMATTER_RESIDUE,
  SOURCE_PREP_INTERNAL_LINK_UNROOTED,
]);

// Every code maps to the doc section that names the preparation step it
// enforces. Keep these pointers in sync with the "Source preparation check"
// section in docs/source-adapters.md.
export const SOURCE_PREP_DOC_POINTERS = Object.freeze({
  [SOURCE_PREP_DOCUMENT_WRAPPER]:
    'docs/quickstart.md "Prepare Raw HTML Source" and docs/source-adapters.md "Source preparation check"',
  [SOURCE_PREP_FRONTMATTER_RESIDUE]:
    'docs/quickstart.md "Prepare Raw HTML Source" and docs/source-adapters.md "Source preparation check"',
  [SOURCE_PREP_INTERNAL_LINK_UNROOTED]:
    'docs/quickstart.md "Prepare Raw HTML Source" and docs/source-adapters.md "Source preparation check"',
});

// Page Kit frontmatter vocabulary used to recognize a leftover frontmatter
// block embedded below content. A bare `---` pair with none of these keys is
// left alone — that is content, not frontmatter, and classifying it would be
// the general-HTML-linting scope this check refuses.
const FRONTMATTER_KEY_PATTERN = /^(?:page_type|layout|permalink|title|description|next_url|decline_url|styles|scripts|meta)\s*:/;

const FENCE_LINE = /^---\s*$/;
const ANCHOR_HREF_PATTERN = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SKIP_PROTOCOL_PATTERN = /^(?:about|blob|data|javascript|mailto|tel):/i;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function safeIsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Splits a page's leading YAML frontmatter (if any) from its body without
 * parsing YAML. Returns fence state so the caller can classify a fence that
 * never closes.
 */
function scanLeadingFrontmatter(lines) {
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (index >= lines.length || !FENCE_LINE.test(lines[index])) {
    return { present: false, unterminated: false, bodyStart: 0 };
  }
  for (let close = index + 1; close < lines.length; close += 1) {
    if (FENCE_LINE.test(lines[close])) {
      return { present: true, unterminated: false, bodyStart: close + 1 };
    }
  }
  return { present: true, unterminated: true, bodyStart: lines.length };
}

function findEmbeddedFrontmatter(lines, bodyStart) {
  const hits = [];
  let open = -1;
  for (let index = bodyStart; index < lines.length; index += 1) {
    if (!FENCE_LINE.test(lines[index])) continue;
    if (open === -1) {
      open = index;
      continue;
    }
    const block = lines.slice(open + 1, index);
    if (block.some((line) => FRONTMATTER_KEY_PATTERN.test(line.trim()))) {
      hits.push({ line: open + 1 });
      open = -1;
      continue;
    }
    // A fence pair without frontmatter keys is content; the closing fence may
    // still open a real leftover block that follows it.
    open = index;
  }
  // An opening fence below content whose frontmatter-key-shaped lines run to
  // EOF without a closing fence is residue too — page-kit would render the
  // fence and keys literally. A trailing keyless fence stays content.
  let unterminated = null;
  if (open !== -1 && lines.slice(open + 1).some((line) => FRONTMATTER_KEY_PATTERN.test(line.trim()))) {
    unterminated = { line: open + 1 };
  }
  return { hits, unterminated };
}

function cleanHref(raw) {
  const value = String(raw || "").trim();
  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("{{") || value.startsWith("{%")) return null;
  if (value.startsWith("//")) return null;
  if (SKIP_PROTOCOL_PATTERN.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return null;
  } catch {
    // Relative and root-relative hrefs are the expected input.
  }
  return value.split("#")[0].split("?")[0].trim();
}

function collectSourceFileLinks({ content, sourceRoot, pagePath, mappedPaths }) {
  const hits = [];
  const seen = new Set();
  const pageDir = dirname(resolve(sourceRoot, pagePath));
  for (const match of String(content || "").matchAll(ANCHOR_HREF_PATTERN)) {
    const cleaned = cleanHref(match[1] ?? match[2] ?? match[3]);
    if (!cleaned || !/\.html?$/i.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    const rootRelative = cleaned.startsWith("/");
    const normalized = cleaned.replace(/^\/+/, "");
    const candidatePaths = rootRelative
      ? [resolve(sourceRoot, normalized)]
      : [resolve(pageDir, cleaned), resolve(sourceRoot, normalized)];
    const resolvesToSourceFile = candidatePaths.some((candidate) => safeIsFile(candidate));
    const targetsMappedPage = mappedPaths.has(toPosixPath(normalized));
    if (!resolvesToSourceFile && !targetsMappedPage) continue;
    seen.add(cleaned);
    hits.push(cleaned);
  }
  return hits;
}

function inspectPageContent({ content, sourceRoot, pagePath, mappedPaths }) {
  const findings = [];
  const wrappers = collectDocumentWrapperNames(content);
  if (wrappers.length) {
    findings.push({ code: SOURCE_PREP_DOCUMENT_WRAPPER, wrappers });
  }

  const lines = String(content || "").split(/\r?\n/);
  const leading = scanLeadingFrontmatter(lines);
  const embedded = findEmbeddedFrontmatter(lines, leading.bodyStart);
  if (leading.unterminated) {
    findings.push({ code: SOURCE_PREP_FRONTMATTER_RESIDUE, variant: "unterminated_leading_fence" });
  }
  if (embedded.hits.length) {
    findings.push({
      code: SOURCE_PREP_FRONTMATTER_RESIDUE,
      variant: "embedded_block",
      lines: embedded.hits.map((hit) => hit.line),
    });
  }
  if (embedded.unterminated) {
    findings.push({
      code: SOURCE_PREP_FRONTMATTER_RESIDUE,
      variant: "unterminated_embedded_block",
      lines: [embedded.unterminated.line],
    });
  }

  const sourceFileLinks = collectSourceFileLinks({ content, sourceRoot, pagePath, mappedPaths });
  if (sourceFileLinks.length) {
    findings.push({ code: SOURCE_PREP_INTERNAL_LINK_UNROOTED, hrefs: sourceFileLinks });
  }
  return findings;
}

function severityForCode(code, { wrapperPolicy }) {
  if (code === SOURCE_PREP_DOCUMENT_WRAPPER) {
    // preserve_document_wrappers is a recorded adapter decision, not silence —
    // the finding stays visible but stops blocking, mirroring how the
    // certification gate downgrades under a recorded waiver.
    return wrapperPolicy === "preserve_document_wrappers" ? "warning" : "error";
  }
  if (code === SOURCE_PREP_FRONTMATTER_RESIDUE) return "error";
  // Internal-link rewrites are sanctioned build-stage work recorded under
  // cta_rewrite_policy; the adapter gates own the completed-assembly block.
  return "warning";
}

function describeFinding(code, pages, { wrapperPolicy }) {
  const docs = SOURCE_PREP_DOC_POINTERS[code];
  const sample = pages.slice(0, 4);
  const more = pages.length > 4 ? `; plus ${pages.length - 4} more page(s)` : "";
  if (code === SOURCE_PREP_DOCUMENT_WRAPPER) {
    const listed = sample.map((page) => `${page.path} (${page.wrappers.join(", ")})`).join("; ");
    const policyNote = wrapperPolicy === "preserve_document_wrappers"
      ? " The adapter contract records wrapper_policy \"preserve_document_wrappers\", so this is reported without blocking."
      : "";
    return `Mapped source HTML is a full browser document, not page-kit-ready source: ${listed}${more}. Strip <!doctype>, <html>, <head>, and <body> so the campaign layout can wrap the page, or record wrapper_policy "preserve_document_wrappers" as an explicit adapter decision.${policyNote} See ${docs}.`;
  }
  if (code === SOURCE_PREP_FRONTMATTER_RESIDUE) {
    const listed = sample.map((page) => {
      const variants = page.variants.map((variant) => {
        if (variant.variant === "unterminated_leading_fence") return "leading --- fence never closes";
        if (variant.variant === "unterminated_embedded_block") {
          return `frontmatter block opened below content at line ${variant.lines.join(", ")} never closes`;
        }
        return `frontmatter block embedded below content at line ${variant.lines.join(", ")}`;
      });
      return `${page.path} (${variants.join("; ")})`;
    }).join("; ");
    return `Mapped source HTML carries leftover or broken YAML frontmatter that page-kit would render literally or misparse: ${listed}${more}. Keep exactly one closed frontmatter block at the very top of the file (or none, when the packet's page_kit.frontmatter projection supplies it). See ${docs}.`;
  }
  const listed = sample.map((page) => `${page.path} -> ${page.hrefs.slice(0, 3).join(", ")}`).join("; ");
  return `Mapped source HTML still links to source files instead of CampaignSpec routes: ${listed}${more}. Replace internal links and CTA destinations with CampaignSpec-derived routes, usually via campaign_link; source filenames like checkout.html are not built campaign URLs. See ${docs}.`;
}

/**
 * Evaluates the page-kit source-preparation expectations for every mapped
 * source page. Deterministic: same files in, same findings out. Unreadable or
 * missing page files are skipped here — source_html.pages.path owns those.
 *
 * @returns {{ checked_page_count: number, findings: Array<{code, severity, message, docs, pages}> }}
 */
export function evaluateSourcePreparation({ sourceRoot, pages = [], wrapperPolicy = null }) {
  const mappedPaths = new Set(
    pages
      .map((page) => (isNonEmptyString(page?.path) ? toPosixPath(page.path) : null))
      .filter(Boolean)
  );
  const byCode = new Map();
  let checked = 0;

  for (const page of pages) {
    if (!isNonEmptyString(page?.path)) continue;
    const fullPath = resolve(sourceRoot, page.path);
    if (!safeIsFile(fullPath)) continue;
    let content;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    checked += 1;
    const pageFindings = inspectPageContent({ content, sourceRoot, pagePath: page.path, mappedPaths });
    for (const finding of pageFindings) {
      if (!byCode.has(finding.code)) byCode.set(finding.code, new Map());
      const pagesForCode = byCode.get(finding.code);
      if (!pagesForCode.has(page.path)) {
        pagesForCode.set(page.path, { page_id: page.page_id || null, path: page.path, wrappers: [], hrefs: [], variants: [] });
      }
      const entry = pagesForCode.get(page.path);
      if (finding.wrappers) entry.wrappers.push(...finding.wrappers);
      if (finding.hrefs) entry.hrefs.push(...finding.hrefs);
      if (finding.variant) entry.variants.push({ variant: finding.variant, lines: finding.lines || [] });
    }
  }

  const findings = [...byCode.entries()]
    .map(([code, pagesForCode]) => {
      const pageList = [...pagesForCode.values()];
      return {
        code,
        severity: severityForCode(code, { wrapperPolicy }),
        message: describeFinding(code, pageList, { wrapperPolicy }),
        docs: SOURCE_PREP_DOC_POINTERS[code],
        pages: pageList.map((page) => ({
          page_id: page.page_id,
          path: page.path,
          ...(page.wrappers.length ? { wrappers: page.wrappers } : {}),
          ...(page.hrefs.length ? { hrefs: page.hrefs } : {}),
          ...(page.variants.length ? { variants: page.variants } : {}),
        })),
      };
    })
    .sort((a, b) => SOURCE_PREP_CODES.indexOf(a.code) - SOURCE_PREP_CODES.indexOf(b.code));

  return { checked_page_count: checked, findings };
}
