// Template brand contracts: per-family declarations of required brand-token
// overrides, starter-default residue that must not ship, CSS load-order rules,
// and the selectors QA inspects to prove the brand layer applied.
//
// Contract files live at contracts/template-brand-contract.<family>.v0.json.
// A family without a contract file simply has no brand contract yet — loaders
// return null and callers treat brand checks as not_applicable for it.
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
  const contract = JSON.parse(readFileSync(path, "utf8"));
  if (contract.schema_version !== TEMPLATE_BRAND_CONTRACT_SCHEMA) {
    throw new Error(
      `Template brand contract ${path} has schema_version "${contract.schema_version}"; expected "${TEMPLATE_BRAND_CONTRACT_SCHEMA}".`,
    );
  }
  if (contract.family !== family) {
    throw new Error(`Template brand contract ${path} declares family "${contract.family}"; expected "${family}".`);
  }
  return contract;
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
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null; // fully transparent: not a visible color
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
// display:none. Returns one finding per offending selector. This is a
// deliberately simple, deterministic scan: a selector listed in the
// contract's forbidden_css_hides that appears in a rule whose declaration
// block contains display:none.
export function findForbiddenPriceHides(contract, cssText) {
  const targets = contract?.pricing_surfaces?.forbidden_css_hides;
  if (!Array.isArray(targets) || !targets.length || typeof cssText !== "string") return [];
  const findings = [];
  // Match each rule: selector list + declaration block.
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(cssText)) !== null) {
    const selectorList = match[1].trim();
    const declarations = match[2];
    if (!/display\s*:\s*none/i.test(declarations)) continue;
    for (const target of targets) {
      // Substring match on the selector list; targets are class/attr
      // selectors so this stays precise enough without a CSS parser.
      if (selectorList.includes(target)) {
        findings.push({
          target,
          selector: selectorList.replace(/\s+/g, " "),
        });
      }
    }
  }
  return findings;
}
