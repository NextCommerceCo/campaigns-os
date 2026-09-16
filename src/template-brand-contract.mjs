// Template brand contracts: per-family declarations of required brand-token
// overrides, starter-default residue that must not ship, CSS load-order rules,
// and the selectors QA inspects to prove the brand layer applied.
//
// Contract files live at contracts/template-brand-contract.<family>.v0.json.
// Family contracts may `extends` a shared contract file in the same directory;
// arrays and scalar values replace parent values, object values merge.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TEMPLATE_BRAND_CONTRACT_SCHEMA = "template-brand-contract/v0";

export function templateBrandContractPath(family) {
  if (typeof family !== "string" || !family.trim()) return null;
  return join(ROOT, "contracts", `template-brand-contract.${family.trim()}.v0.json`);
}

export function loadTemplateBrandContract(family) {
  const path = templateBrandContractPath(family);
  if (!path || !existsSync(path)) return null;
  const contract = loadTemplateBrandContractFile(path);
  if (contract.family !== family) {
    throw templateBrandContractError("family_mismatch", `Template brand contract ${path} declares family "${contract.family}"; expected "${family}".`);
  }
  return contract;
}

function loadTemplateBrandContractFile(path, seen = new Set()) {
  let contract = null;
  try {
    contract = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw templateBrandContractError(
      "parse_error",
      `Template brand contract ${path} failed to parse: ${error instanceof Error ? error.message : String(error)}.`,
      error,
    );
  }
  return resolveContractExtendsChain(contract, { dir: dirname(path), label: path, seen });
}

// Walks the `extends` chain starting from an already-parsed contract object,
// resolving each `extends` filename against `dir`. Shared by the on-disk
// loader above and by privately-sourced contract fragments (fetched from a
// third-party repo, not read from a file at `dir`) that still need to extend
// a shared file living in this repo's own contracts/ directory — callers
// pass that directory in as `dir` regardless of where the leaf contract
// itself came from. Exported so private-template-source.mjs reuses this
// instead of re-implementing cycle-detection/merge.
export function resolveContractExtendsChain(contract, { dir, label = dir, seen = new Set() } = {}) {
  if (seen.has(label)) throw templateBrandContractError("extends_cycle", `Template brand contract extends cycle at ${label}.`);
  // The outermost call sees the fully merged contract; validation that spans
  // parent and child fields (a family adding a chrome asset the shared hash
  // map does not cover) has to run there, not per file.
  const outermost = seen.size === 0;
  seen.add(label);
  if (!isPlainObject(contract) || contract.schema_version !== TEMPLATE_BRAND_CONTRACT_SCHEMA) {
    throw templateBrandContractError(
      "schema_mismatch",
      `Template brand contract ${label} has schema_version "${contract?.schema_version}"; expected "${TEMPLATE_BRAND_CONTRACT_SCHEMA}".`,
    );
  }
  const parentRef = typeof contract.extends === "string" && contract.extends.trim() ? contract.extends.trim() : null;
  let resolved = contract;
  if (parentRef) {
    const parentPath = join(dir, parentRef);
    if (!existsSync(parentPath)) {
      throw templateBrandContractError("extends_missing_parent", `Template brand contract ${label} extends missing file "${parentRef}".`);
    }
    resolved = mergeContractObjects(loadTemplateBrandContractFile(parentPath, seen), contract);
    delete resolved.extends;
  }
  if (outermost) paymentChromeAssetHashes(resolved.default_residue?.payment_chrome, { label });
  return resolved;
}

function templateBrandContractError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function mergeContractObjects(parent, child) {
  const merged = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    if (isPlainObject(value) && isPlainObject(parent?.[key])) {
      merged[key] = mergeContractObjects(parent[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Normalize a CSS color to a comparable form. Computed styles come back as
// rgb()/rgba(); contracts declare hex. Compare in rgb space.
export function normalizeCssColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (rgb) {
    // Near-invisible alpha is not a shipped color (and an alpha hack to dodge
    // the forbidden-palette check, e.g. rgba(60,125,255,0.01), should read as
    // "no visible color" — which residue checks treat as suspicious anyway).
    // Above the threshold the alpha is dropped: a half-transparent starter
    // blue still ships the starter palette.
    if (rgb[4] !== undefined && Number(rgb[4]) < 0.1) return null;
    return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
  }
  return null;
}

// Forbidden computed colors for a family, normalized to rgb. Used by browser
// QA to fail commerce pages that still render the starter palette.
export function forbiddenComputedColors(contract) {
  const entries = contract?.qa_inspection?.forbidden_computed_colors;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      token: entry.token || null,
      hex: entry.hex || null,
      rgb: normalizeCssColor(entry.rgb || entry.hex),
    }))
    .filter((entry) => entry.rgb);
}

// The page types template-residue inspection runs against at all. Lives here
// rather than in the browser runner so a consumer that only wants to know
// WHETHER residue checks apply does not have to import the runner.
export const RESIDUE_PAGE_TYPES = ["checkout", "select", "upsell", "downsell", "receipt"];

/**
 * The computed-style (palette) residue checks that will actually run for one
 * contract and page type — the single predicate behind "will QA block this
 * campaign on the starter palette?".
 *
 * Both conditions are load-bearing and neither implies the other: a contract
 * can list forbidden colors with no selector to inspect them on, and it can
 * list selectors with no forbidden color to compare against. Either way the
 * run produces no palette assertion, so anything that warns about one must ask
 * this, not "does a contract exist".
 */
export function paletteResidueStyleChecks(contract, pageType) {
  if (!forbiddenComputedColors(contract).length) return [];
  return styleChecksForPageType(contract, pageType);
}

// The selector half, split out so a caller asking about every page type
// normalizes the forbidden-color list once instead of per type.
function styleChecksForPageType(contract, pageType) {
  const type = String(pageType || "").toLowerCase();
  if (!contract || !RESIDUE_PAGE_TYPES.includes(type)) return [];
  return (contract.qa_inspection?.computed_style_checks || [])
    .filter((check) => (check.page_types || []).includes(type));
}

/**
 * Does this contract produce palette-residue checks on ANY commerce page type?
 *
 * A family outside the certified set — `custom`, `undecided`, or any family the
 * catalog does not carry a contract for — resolves to no contract at all, so
 * browser QA emits no `template-residue:*:style:*` rows for it and there is no
 * starter palette to block on. Warning such an operator that QA will block, and
 * recommending a waiver or a brand-layer rewrite to clear a block that will
 * never happen, is worse than saying nothing.
 */
export function contractHasPaletteResidueChecks(contract) {
  // Normalize the forbidden colors once for the whole sweep: they do not vary
  // by page type, and normalizing a color list five times to answer one
  // question is work nobody asked for.
  if (!forbiddenComputedColors(contract).length) return false;
  return RESIDUE_PAGE_TYPES.some((pageType) => styleChecksForPageType(contract, pageType).length > 0);
}

function escapeContractRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePageTypes(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry).toLowerCase()) : null;
}

// Placeholder text-residue contract (H3.1): literal template copy that must
// never survive into rendered output (Lorem / Placeholder / TODO / Product
// Name ...). Mirrors the forbidden-computed-colors model — data lives in the
// contract (shared-commerce, inherited by every family), matchers compile in
// code — so the gate is data-driven and a family can override the term set.
export function placeholderTextResidueConfig(contract) {
  const cfg = contract?.qa_inspection?.placeholder_text_residue;
  if (!isPlainObject(cfg)) return null;
  const terms = Array.isArray(cfg.terms)
    // Dedupe so a contract that lists a term twice does not double-count the
    // same occurrence in evidence / summarizePlaceholderTerms.
    ? [...new Set(cfg.terms.map((term) => String(term)).filter((term) => term.trim()))]
    : [];
  if (!terms.length) return null;
  return {
    terms,
    pageTypes: normalizePageTypes(cfg.page_types),
    rule: typeof cfg.rule === "string" ? cfg.rule : null,
  };
}

// Pure: every literal placeholder-term occurrence in `text`. Word-boundary,
// case-insensitive; multi-word terms keep flexible internal whitespace so a
// reflowed "Product   Name" still matches. Boundaries only apply where the
// term itself starts/ends with a word char, so "lorem ipsum" still anchors.
export function placeholderTextResidueMatches(text, terms) {
  if (typeof text !== "string" || !text || !Array.isArray(terms) || !terms.length) return [];
  const matches = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    if (!raw) continue;
    const body = escapeContractRegExp(raw).replace(/\s+/g, "\\s+");
    const startBoundary = /^\w/.test(raw) ? "\\b" : "";
    const endBoundary = /\w$/.test(raw) ? "\\b" : "";
    const regex = new RegExp(`${startBoundary}${body}${endBoundary}`, "gi");
    for (const match of text.matchAll(regex)) {
      matches.push({ term: raw, match: match[0], index: match.index ?? 0 });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

// The distinct placeholder terms found, in first-seen order, for verdict copy.
export function summarizePlaceholderTerms(matches) {
  const seen = [];
  for (const match of matches || []) {
    if (!seen.includes(match.term)) seen.push(match.term);
  }
  return seen;
}

// Demo-asset fidelity contract (H3.2): the template's own demo placeholder
// assets (1x1 spacers, starter imagery) that should be re-skinned. Data-driven
// per family so the flag is declarative, not hardcoded: `demo_assets.assets`
// is the whole vocabulary, and a contract with no assets declares no check.
export function demoAssetConfig(contract) {
  const cfg = contract?.demo_assets;
  if (!isPlainObject(cfg)) return null;
  const assets = Array.isArray(cfg.assets)
    ? cfg.assets.map((asset) => String(asset)).filter((asset) => asset.trim())
    : [];
  if (!assets.length) return null;
  return {
    assets,
    assetBasenames: [...new Set(assets.map((asset) => asset.split("/").pop()).filter(Boolean))],
    pageTypes: normalizePageTypes(cfg.page_types),
    rule: typeof cfg.rule === "string" ? cfg.rule : null,
  };
}

const SIMPLE_CLASS_SELECTOR = /^\.([A-Za-z0-9_-]+)$/;

// Selectors/assets belonging to one payment method under the contract's
// default_residue.payment_chrome, plus shared chrome assets (those naming no
// contract method, e.g. upsell-payment-logos.svg) which count as implied residue
// for any unsupported method per the contract rule. One partition for both
// consumers: browser QA (visible selectors + fetched assets) and doctor's static
// scan of the built checkout.
export function paymentChromeArtifacts(chrome, method) {
  const compact = (value) => String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
  const token = compact(method);
  const methodTokens = (chrome?.methods || []).map(compact).filter(Boolean);
  const selectors = (chrome?.selectors || []).filter((selector) => compact(selector).includes(token));
  const assets = (chrome?.assets || []).filter((asset) => {
    const normalized = compact(asset);
    if (normalized.includes(token)) return true;
    return !methodTokens.some((candidate) => normalized.includes(candidate));
  });
  return { selectors, assets };
}

// The shipped bytes of each chrome asset, by basename: `payment_chrome.asset_sha256`
// keyed by the same path `assets[]` lists, lower-cased hex. Browser QA hashes the
// bytes a page actually serves against this map, which is what tells an untouched
// starter strip (residue, whatever its markup says) from one edited in place
// (manual review).
//
// Strict, and run at contract load: a hash that is not 64 hex chars, or a
// listed asset the map does not cover, throws with the asset named. A dropped
// or missing hash would send that asset back to the markup token match — the
// path this map exists to close — and a contract author would learn of the
// typo only from a deployed strip reading as edited. A contract with no
// `asset_sha256` at all declares no hashes (every asset uses the token match),
// which keeps a privately-sourced contract that predates the field loadable.
export function paymentChromeAssetHashes(chrome, { label = "template brand contract" } = {}) {
  const byBasename = new Map();
  if (!isPlainObject(chrome) || chrome.asset_sha256 === undefined) return byBasename;
  if (!isPlainObject(chrome.asset_sha256)) {
    throw templateBrandContractError("payment_chrome_hash_invalid", `${label}: default_residue.payment_chrome.asset_sha256 must be an object keyed by asset path.`);
  }
  for (const [asset, digest] of Object.entries(chrome.asset_sha256)) {
    const basename = String(asset || "").split("/").pop();
    const hex = typeof digest === "string" ? digest.trim().toLowerCase() : "";
    if (!basename || !/^[0-9a-f]{64}$/.test(hex)) {
      throw templateBrandContractError(
        "payment_chrome_hash_invalid",
        `${label}: default_residue.payment_chrome.asset_sha256["${asset}"] is not a 64-char hex sha256 (${JSON.stringify(digest)}).`,
      );
    }
    byBasename.set(basename, hex);
  }
  for (const asset of Array.isArray(chrome.assets) ? chrome.assets : []) {
    const basename = String(asset || "").split("/").pop();
    if (basename && !byBasename.has(basename)) {
      throw templateBrandContractError(
        "payment_chrome_hash_missing",
        `${label}: default_residue.payment_chrome.assets lists "${asset}" with no asset_sha256 entry; record the sha256 of the shipped file or drop the asset.`,
      );
    }
  }
  return byBasename;
}

// Pure, static: the markers in rendered checkout HTML that say a payment method
// shipped. Three sources, in order of authority: the SDK-owned
// data-next-payment-method attribute every starter-template payment-methods
// include renders per method (underscore spelling canonical, legacy hyphen
// accepted); the contract's payment_chrome class selectors for the method
// (simple .class selectors only — a static scan cannot evaluate compound
// selectors or visibility, browser QA does that); and the method-named chrome
// assets by basename. Shared chrome assets that name no method are left to
// browser QA, which fetches them to attribute the mark; a static scan cannot
// tell a paypal strip from a card-only one by its filename.
export function paymentMethodMarkupMatches(html, method, chrome = null) {
  const text = typeof html === "string" ? html : "";
  const canonical = String(method || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!canonical) return [];
  const matches = [];
  const spellings = [...new Set([canonical, canonical.replace(/_/g, "-")])].map(escapeContractRegExp).join("|");
  const attribute = new RegExp(`data-next-payment-method\\s*=\\s*["'](?:${spellings})["']`, "i").exec(text);
  if (attribute) matches.push(attribute[0].replace(/\s+/g, ""));
  const artifacts = paymentChromeArtifacts(chrome, canonical);
  for (const selector of artifacts.selectors) {
    const className = SIMPLE_CLASS_SELECTOR.exec(selector)?.[1];
    if (!className) continue;
    if (new RegExp(`class\\s*=\\s*["'](?:[^"']*\\s)?${escapeContractRegExp(className)}(?:\\s|["'])`, "i").test(text)) matches.push(selector);
  }
  const compact = (value) => String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
  const token = compact(canonical);
  for (const asset of artifacts.assets) {
    if (!compact(asset).includes(token)) continue;
    const basename = asset.split("/").pop();
    if (basename && text.includes(basename)) matches.push(basename);
  }
  return [...new Set(matches)];
}

// The part of a method's payment_chrome a static HTML scan cannot attribute:
// compound selectors (need a live DOM) and shared chrome assets naming no
// method (need a fetch to attribute the mark). Browser QA covers both; doctor
// names them so "no markup found" is never read as "nothing left to check".
export function paymentMethodStaticScanGaps(chrome, method) {
  const canonical = String(method || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!canonical) return { compound_selectors: [], shared_assets: [] };
  const artifacts = paymentChromeArtifacts(chrome, canonical);
  const compact = (value) => String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
  const token = compact(canonical);
  return {
    compound_selectors: artifacts.selectors.filter((selector) => !SIMPLE_CLASS_SELECTOR.test(selector)),
    shared_assets: artifacts.assets.filter((asset) => !compact(asset).includes(token)).map((asset) => asset.split("/").pop()).filter(Boolean),
  };
}


// Pure: which demo-asset basenames are referenced in rendered HTML. Mirrors
// referencedAssetBasenames in qa-browser (payment-chrome residue).
export function referencedDemoAssetBasenames(html, basenames) {
  const text = typeof html === "string" ? html : "";
  return (basenames || []).filter((basename) => basename && text.includes(basename));
}

// Scan campaign CSS text for rules that hide pricing surfaces with
// display:none. Returns one finding per offending selector occurrence.
//
// Deliberately a brace-depth walker, not a flat regex: a flat
// `selector { decls }` regex cannot see inside `@media` / `@supports` /
// `@container` blocks, so a mobile-only price hide would bypass the scan —
// the exact escape this check exists to close. The walker recurses into
// at-rule and CSS-nesting blocks and matches targets against the full
// selector context (ancestor preludes joined with the leaf selector). It is
// still a lint, not a full CSS parser; pathological inputs (braces inside
// attribute-selector strings) may mis-scan, which is acceptable for a
// deterministic warning surface.
export function findForbiddenPriceHides(contract, cssText) {
  const targets = contract?.pricing_surfaces?.forbidden_css_hides;
  if (!Array.isArray(targets) || !targets.length || typeof cssText !== "string") return [];
  const findings = [];
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  scanCssBlock(stripped, [], targets, findings);
  return findings;
}

// Token-boundary match: the target must not be a substring of a longer CSS
// identifier, so ".summary_price" matches ".summary_price.cc-sm" but not
// ".summary_price-row", and a future ".price" target cannot blanket-match
// every ".price-*" class. CSS identifiers also allow code points >= U+0080,
// so those count as identifier characters too (".price" must not match
// inside ".priceΑ" or ".price-événement").
const CSS_IDENT_CHAR = "A-Za-z0-9_\\u0080-\\uFFFF-";

function selectorContextMatches(context, target) {
  const raw = String(target);
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identChar = new RegExp(`^[${CSS_IDENT_CHAR}]$`, "u");
  // Boundary guards apply only where the target itself starts/ends with an
  // identifier character. A target starting with "." or "[" is already
  // delimited by that symbol — and the symbol may legally follow an ident
  // char in compound selectors (div.price-wrapper), so a blanket lookbehind
  // would miss those.
  const pre = identChar.test(raw[0] || "") ? `(?<![${CSS_IDENT_CHAR}])` : "";
  const post = identChar.test(raw[raw.length - 1] || "") ? `(?![${CSS_IDENT_CHAR}])` : "";
  return new RegExp(`${pre}${escaped}${post}`, "u").test(context);
}

function scanCssBlock(text, contextPreludes, targets, findings) {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open === -1) return;
    // Statement at-rules (`@import url(x);`, `@charset "utf-8";`) end with a
    // semicolon and never open a block, so the next rule's prelude is the
    // text AFTER the last `;` — slicing without the split would misread
    // `@import x; .foo { … }` as an at-rule named "@import x; .foo".
    const prelude = text.slice(index, open).split(";").pop().trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = text.slice(open + 1, cursor - (depth === 0 ? 1 : 0));
    if (prelude.startsWith("@")) {
      // Conditional group rules (@media/@supports/@container/@layer) nest
      // full rules: recurse without adding selector context. Declaration-only
      // at-rules (@font-face, @page) cannot hide price rows; recursing into
      // them is harmless because they contain no nested selectors.
      scanCssBlock(body, contextPreludes, targets, findings);
    } else {
      const nestedStart = body.indexOf("{");
      // Own declarations = body text outside any nested blocks (CSS nesting).
      const ownDeclarations = nestedStart === -1 ? body : body.slice(0, body.lastIndexOf(";", nestedStart) + 1);
      const selectorContext = [...contextPreludes, prelude].join(" ").replace(/\s+/g, " ").trim();
      if (/display\s*:\s*none/i.test(ownDeclarations)) {
        for (const target of targets) {
          if (selectorContextMatches(selectorContext, target)) {
            findings.push({ target, selector: selectorContext });
          }
        }
      }
      if (nestedStart !== -1) {
        scanCssBlock(body, [...contextPreludes, prelude], targets, findings);
      }
    }
    index = cursor;
  }
}
