/**
 * Promo discount-percentage claims in page copy, and the largest percentage
 * discount a CampaignSpec declares. Doctor's built-output residue scan and QA
 * commercial parity both read a claim above that maximum as wrong copy, so
 * they share this one reading.
 */

export const DISCOUNT_CLAIM_TOLERANCE = 0.01;

const CLAIM_PATTERN = /\b(?:save(?:\s+up\s+to)?\s+(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)|(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)\s*(?:off|discount)\b)/gi;

/** Every "Save N%", "N% off" or "N% discount" claim in the text. */
export function discountClaimsInText(content) {
  const claims = [];
  for (const match of String(content ?? "").matchAll(CLAIM_PATTERN)) {
    const claimed = Number.parseFloat(match[1] || match[2]);
    if (!Number.isFinite(claimed)) continue;
    claims.push({ index: match.index || 0, text: match[0], claimed_percent: claimed });
  }
  return claims;
}

/** True when a claimed percentage is above the spec maximum. */
export function discountClaimAboveMax(claimedPercent, maxDiscount) {
  return claimedPercent > maxDiscount + DISCOUNT_CLAIM_TOLERANCE;
}

export function maxSpecDiscountPercent(spec) {
  if (!spec || typeof spec !== "object") return null;
  const values = [];

  function visit(value, key = "") {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;

    if (isPercentDiscountBenefit(value, key)) {
      addPercentValue(values, value.value);
    }

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isDiscountPercentKey(entryKey)) addPercentValue(values, entryValue);
      visit(entryValue, entryKey);
    }
  }

  visit(spec);
  return values.length ? Math.max(...values) : null;
}

export function formatDiscountPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)}%`;
}

function isPercentDiscountBenefit(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "value")) return false;
  const type = normalizeSpecKey(value.type || "");
  if (!/(?:^|_)(?:percent|percentage)(?:_|$)/.test(type)) return false;
  const context = normalizeSpecKey(key);
  if (context === "benefit") return true;
  return /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher|package)(?:_|$)/.test(type);
}

function isDiscountPercentKey(key) {
  const normalized = normalizeSpecKey(key);
  const mentionsPercent = /(?:^|_)(?:percent|percentage)(?:_|$)/.test(normalized);
  const mentionsOffer = /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher)(?:_|$)/.test(normalized);
  return mentionsPercent && mentionsOffer;
}

function normalizeSpecKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function addPercentValue(values, value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", "").trim());
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) values.push(parsed);
}
