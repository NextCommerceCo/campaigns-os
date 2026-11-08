// Doctor's advisory read of the starter-template vendor keys (#689): whether
// the vendors the CampaignSpec declares under analytics.vendors and the
// vendors the target's _data/campaigns.json entry switches on agree.
//
// A vendor adapter loads when its id key in the entry is non-empty (absent or
// empty is off), so the entry is what ships. The spec is what the Map says
// should ship, and spec derive mirrors the id from the entry back into it.
// Every finding is a warning: a vendor that is off, on by accident or pointed
// at a placeholder account loses or pollutes attribution, but never an order,
// and the operator may have a reason. Read-only: nothing is written.
import { ANALYTICS_VENDORS, isPlaceholderVendorId } from "../campaign-spec/dist/index.js";
import { PAGE_KIT_CAMPAIGNS_REL_PATH } from "./page-kit-campaign-config.mjs";
import { SPEC_DERIVE_COMMAND } from "./page-kit-sdk-version.mjs";

export const PAGE_KIT_ANALYTICS_VENDORS_SCOPE = "page_kit.analytics_vendors";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The analytics kill switch the Map Builder honours: with it set, the spec
// compiler writes no vendor key, so the spec declares no vendor.
function analyticsDisabled(analytics) {
  return isPlainObject(analytics) && (analytics.enabled === false || analytics.mode === "disabled");
}

// The template gate is `campaign.<key> and campaign.<key> != ""`: any value
// but an absent, null, false or blank one switches the vendor on.
function keySwitchesVendorOn(value) {
  if (value === undefined || value === null || value === false) return false;
  return typeof value !== "string" || value.trim() !== "";
}

// The vendors the spec declares, keyed by vendor: an object entry not turned
// off with enabled:false. A declared vendor with no id is still declared (the
// AnalyticsContractShape rule names the missing id).
function declaredVendors(analytics) {
  const declared = new Map();
  if (!isPlainObject(analytics) || analyticsDisabled(analytics) || !isPlainObject(analytics.vendors)) return declared;
  for (const { key } of ANALYTICS_VENDORS) {
    const vendor = analytics.vendors[key];
    if (isPlainObject(vendor) && vendor.enabled !== false) declared.set(key, vendor);
  }
  return declared;
}

// Compare the spec's vendors with the target entry. `targetLoad` is the
// loadPageKitCampaignEntry result doctor already holds. Returns the vendors
// either side switches on and one finding per disagreement; findings name keys
// and vendors only, never a value read from campaigns.json.
export function evaluatePageKitAnalyticsVendors({ spec, targetLoad }) {
  // Without a readable spec there is nothing to compare the entry with; the
  // spec checks report why it is unreadable.
  if (!isPlainObject(spec) || targetLoad?.status !== "ok" || !isPlainObject(targetLoad.entry)) {
    return { scope: PAGE_KIT_ANALYTICS_VENDORS_SCOPE, status: "not_applicable", vendors: [], findings: [] };
  }
  const entry = targetLoad.entry;
  const slug = targetLoad.public_route_slug;
  const source = (key) => `${PAGE_KIT_CAMPAIGNS_REL_PATH}[${slug}].${key}`;
  const analytics = spec?.analytics;
  const disabled = analyticsDisabled(analytics);
  const declared = declaredVendors(analytics);
  const vendors = [];
  const findings = [];
  const finding = (code, def, message, repair) => findings.push({
    code: `${PAGE_KIT_ANALYTICS_VENDORS_SCOPE}.${code}`,
    vendor: def.key,
    id_key: def.idKey,
    message,
    repair,
  });

  for (const def of ANALYTICS_VENDORS) {
    const field = `analytics.vendors.${def.key}`;
    const raw = Object.hasOwn(entry, def.idKey) ? entry[def.idKey] : undefined;
    const on = keySwitchesVendorOn(raw);
    const specVendor = declared.get(def.key);
    if (on || specVendor) vendors.push(def.key);
    if (specVendor && !on) {
      finding(
        "key_missing",
        def,
        `The CampaignSpec declares ${field}, but ${source(def.idKey)} is absent or empty, so the template never loads ${def.label} and it receives no events. Set the key (the Map's spec compiler writes it), or remove the vendor from the Map if the campaign should not send to ${def.label}.`,
        { kind: "edit", target: source(def.idKey) },
      );
      continue;
    }
    if (!specVendor && on) {
      // spec derive can record an undeclared vendor; it cannot undo an
      // authored "off", so that case is pointed at the Map instead.
      const turnedOff = disabled
        ? "turns analytics off (analytics.enabled false or mode disabled)"
        : isPlainObject(analytics?.vendors?.[def.key]) ? `turns ${field} off (enabled: false)` : null;
      finding(
        "undeclared",
        def,
        turnedOff
          ? `${source(def.idKey)} switches ${def.label} on, but the CampaignSpec ${turnedOff}. The template loads ${def.label} on every page regardless. Clear the key if ${def.label} should be off, or turn it back on in the Map.`
          : `${source(def.idKey)} switches ${def.label} on, but the CampaignSpec does not declare ${field}. The template loads ${def.label} on every page. Record it in the spec with \`${SPEC_DERIVE_COMMAND}\` (or in the Map), or clear the key if ${def.label} should be off.`,
        turnedOff ? { kind: "edit", target: source(def.idKey) } : { kind: "command", command: SPEC_DERIVE_COMMAND },
      );
      continue;
    }
    if (!specVendor) continue;
    const value = typeof raw === "string" ? raw.trim() : null;
    if (value !== null && isPlaceholderVendorId(value)) {
      finding(
        "key_placeholder",
        def,
        `${source(def.idKey)} holds a placeholder, not a real ${def.label} id. The template loads ${def.label} for any non-empty value, so events go to an account that does not exist. Replace it with the merchant's id.`,
        { kind: "edit", target: source(def.idKey) },
      );
      continue;
    }
    const specId = typeof specVendor.id === "string" ? specVendor.id.trim() : "";
    if (specId && value !== null && value !== specId) {
      finding(
        "id_mismatch",
        def,
        `${source(def.idKey)} and ${field}.id name different ${def.label} ids. The campaigns.json value is what ships; \`${SPEC_DERIVE_COMMAND}\` mirrors it into the spec, or correct the key if the spec is right.`,
        { kind: "command", command: SPEC_DERIVE_COMMAND },
      );
    }
  }

  return {
    scope: PAGE_KIT_ANALYTICS_VENDORS_SCOPE,
    status: findings.length ? "advisory" : "ok",
    vendors,
    findings,
  };
}
