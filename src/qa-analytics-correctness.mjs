// Analytics CORRECTNESS assessment (single funnel) — the foundation layer the
// migration parity differ sits on top of. Where parity asks "does candidate
// match baseline?", correctness asks "does this funnel fire what its declared
// analytics contract says it should?" — so a funnel can be validated on its own,
// before any migration, and a differ isn't passing two identically-broken funnels.
//
// Driven by the CampaignSpec `analytics` block (campaign-spec AnalyticsContract).
// When no block is declared the assessment can't know the expected container/
// pixel ids, so it emits an INFO inventory only — nothing is gated. The contract
// is what turns observations into pass/fail. (Until the spec authoring tool
// emits the block, real specs won't carry one — so the no-contract path is the
// common case today and must stay non-blocking.)
//
// Source-aware by construction: it keys on OUTBOUND pixel fires (the network
// truth), via effectivePurchase + the capture inventory, so a campaign that
// blocks the SDK dl_* event and fires the pixel manually still passes.

import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { effectivePurchase } from "./qa-analytics-parity.mjs";

// Inventory kinds classifyTagFire can recognize directly. Other declared
// out-of-band vendors (TriplePixel→triplewhale, etc.) can't be auto-detected
// without host wiring, so they degrade to manual review rather than false-fail.
const KNOWN_VENDOR_KINDS = new Set(["gtm", "ga4", "google_ads", "meta", "tiktok", "everflow"]);

// Packet 01 / INV-3(c): when the assessment knows the URL it audited, EVERY
// emitted assertion — pass and fail alike — carries it, top-level and in
// evidence, so a reader of a blocked verdict can always tell what was
// measured (only the sibling :capture assertion used to carry it).
function correctnessAssertion({ id, status, severity, expected, actual, evidence, waiver, url }) {
  return {
    id,
    family: "analytics-correctness",
    page: "analytics",
    status,
    ...(url ? { url } : {}),
    ...(severity ? { severity } : {}),
    ...(waiver ? { waiver } : {}),
    expected,
    actual,
    ...(evidence || url ? { evidence: { ...(url ? { url } : {}), ...(evidence || {}) } } : {}),
  };
}

// The ONLY assertion the QA waiver lane covers today (packet 01, ratified
// I-9/I-16): a recorded `qa waive` decision for purchase-fires. Returns the
// waiver record only for a FAILING assertion — a stale waiver on a passing
// check is inert data, never surfaced.
function purchaseFiresWaiver(options, fired) {
  if (fired) return null;
  const waiver = options?.waivers?.["analytics-correctness:purchase-fires"];
  if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) return null;
  if (typeof waiver.reason !== "string" || !waiver.reason.trim()) return null;
  return {
    reason: waiver.reason.trim(),
    waived_by: (typeof waiver.waived_by === "string" && waiver.waived_by.trim()) || "operator",
    waived_at: (typeof waiver.waived_at === "string" && waiver.waived_at.trim()) || null,
  };
}

function inventoryHas(inventory, kind, id) {
  const ids = inventory[kind] || [];
  return id ? ids.includes(String(id)) : ids.length > 0;
}

// Assess one funnel's capture against its declared analytics contract.
// `contract` is the spec's `analytics` block (may be undefined/empty).
// `options.waivers` is the Assembly Report's recorded `qa waive` decisions
// (packet 01) — consulted ONLY by the purchase-fires blocker below.
// `options.url` is the URL the capture actually visited (the resolved capture
// target) — stamped on every emitted assertion, pass and fail alike.
export function assessAnalyticsCorrectness(capture = {}, contract = {}, options = {}) {
  const assertions = [];
  const auditedUrl = (typeof options.url === "string" && options.url.trim()) ? options.url.trim() : null;
  const emit = (fields) => correctnessAssertion({ url: auditedUrl, ...fields });
  const inventory = capture.inventory || {};
  const providers = (contract && contract.providers) || {};
  const hasContract = !!(contract && (contract.providers || contract.out_of_band_pixels || contract.params || contract.manual_events));

  // No declared contract → can't know expected ids; emit a non-gating inventory
  // so the run still records what fired, and flag that nothing was validated.
  if (!hasContract) {
    assertions.push(emit({
      id: "analytics-correctness:no-contract",
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.INFO,
      expected: "a declared CampaignSpec analytics block to validate against",
      actual: "no analytics contract declared — recorded the observed fires, gated nothing",
      // Fingerprints only — never publish raw container/pixel ids or order
      // fields (value/transaction_id) to the QA portal.
      evidence: {
        inventory: Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, v.length])),
        purchase_signals: capture.purchaseSignals || {},
        purchase_fired: effectivePurchase(capture).fired,
      },
    }));
    return assertions;
  }

  // 1. GTM container fires (blocker when declared + enabled).
  if (providers.gtm && providers.gtm.enabled !== false) {
    const id = providers.gtm.containerId;
    const present = inventoryHas(inventory, "gtm", id);
    assertions.push(emit({
      id: "analytics-correctness:tag:gtm",
      status: present ? STATUS.PASS : STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: `GTM ${id || "container"} fires on the page`,
      actual: present ? "present" : `absent (${(inventory.gtm || []).length} gtm tag(s) fired, none matching)`,
      evidence: { declared: id || null, observed_count: (inventory.gtm || []).length },
    }));
  }

  // 2. Meta pixel fires (blocker when declared + enabled).
  if (providers.facebook && providers.facebook.enabled !== false) {
    const id = providers.facebook.pixelId;
    const present = inventoryHas(inventory, "meta", id);
    assertions.push(emit({
      id: "analytics-correctness:tag:meta",
      status: present ? STATUS.PASS : STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: `Meta pixel ${id || ""} fires on the page`.trim(),
      actual: present ? "present" : `absent (${(inventory.meta || []).length} meta pixel(s) fired, none matching)`,
      evidence: { declared: id || null, observed_count: (inventory.meta || []).length },
    }));
  }

  // 3. Out-of-band pixels declared as carried (Everflow / TriplePixel / …).
  for (const [i, pixel] of (contract.out_of_band_pixels || []).entries()) {
    if (!pixel || !pixel.vendor) continue;
    const vendor = String(pixel.vendor).toLowerCase();
    if (KNOWN_VENDOR_KINDS.has(vendor)) {
      const present = inventoryHas(inventory, vendor, pixel.id);
      assertions.push(emit({
        id: `analytics-correctness:oob:${vendor}`,
        status: present ? STATUS.PASS : STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: `declared out-of-band ${vendor} pixel fires`,
        actual: present ? "present" : "absent",
        evidence: { vendor, declared_id: pixel.id || null, observed_count: (inventory[vendor] || []).length },
      }));
    } else {
      // Vendor host not in the classifier (e.g. TriplePixel→triplewhale.com).
      // Pass its name as --analytics-hosts to capture it; until then, review.
      assertions.push(emit({
        id: `analytics-correctness:oob:${vendor}`,
        status: STATUS.MANUAL_REVIEW,
        severity: SEVERITY.WARN,
        expected: `declared out-of-band ${vendor} pixel fires`,
        actual: `cannot auto-detect "${vendor}" — pass its host via --analytics-hosts to verify`,
        evidence: { vendor, index: i },
      }));
    }
  }

  // 4. Purchase fires — source-aware (dataLayer event OR Meta/GA4 pixel).
  // Packet 01 / ratified I-9: this stays a BLOCKER, with exactly one
  // named-human waiver lane — a recorded `qa waive` decision downgrades the
  // failing blocker to WARN and carries the attribution (reason / waived_by /
  // waived_at) on the assertion, so the verdict shows who accepted it and why.
  // An unwaived failure still blocks (I-16 negative control).
  const eff = effectivePurchase(capture);
  const waiver = purchaseFiresWaiver(options, eff.fired);
  assertions.push(emit({
    id: "analytics-correctness:purchase-fires",
    status: eff.fired ? STATUS.PASS : STATUS.FAIL,
    severity: waiver ? SEVERITY.WARN : SEVERITY.BLOCKER,
    ...(waiver ? { waiver } : {}),
    expected: "a Purchase fires on this page (dl_purchase, or Meta/GA4 pixel if the SDK event is blocked)",
    actual: eff.fired
      ? `fired via ${eff.via}`
      : `no Purchase fire captured (dataLayer, Meta, or GA4)${waiver ? ` — blocker waived by ${waiver.waived_by}${waiver.waived_at ? ` at ${waiver.waived_at}` : ""}: ${waiver.reason}` : ""}`,
    evidence: { via: eff.via, signals: capture.purchaseSignals || {}, ...(waiver ? { waiver } : {}) },
  }));

  return assertions;
}
