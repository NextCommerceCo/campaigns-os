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
  if (seen.has(path)) throw templateBrandContractError("extends_cycle", `Template brand contract extends cycle at ${path}.`);
  seen.add(path);
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
  if (!isPlainObject(contract) || contract.schema_version !== TEMPLATE_BRAND_CONTRACT_SCHEMA) {
    throw templateBrandContractError(
      "schema_mismatch",
      `Template brand contract ${path} has schema_version "${contract?.schema_version}"; expected "${TEMPLATE_BRAND_CONTRACT_SCHEMA}".`,
    );
  }
  const parentRef = typeof contract.extends === "string" && contract.extends.trim() ? contract.extends.trim() : null;
  if (!parentRef) return contract;
  const parentPath = join(dirname(path), parentRef);
  if (!existsSync(parentPath)) {
    throw templateBrandContractError("extends_missing_parent", `Template brand contract ${path} extends missing file "${parentRef}".`);
  }
  const merged = mergeContractObjects(loadTemplateBrandContractFile(parentPath, seen), contract);
  delete merged.extends;
  return merged;
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
