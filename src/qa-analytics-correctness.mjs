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

function correctnessAssertion({ id, status, severity, expected, actual, evidence }) {
  return {
    id,
    family: "analytics-correctness",
    page: "analytics",
    status,
    ...(severity ? { severity } : {}),
    expected,
    actual,
    ...(evidence ? { evidence } : {}),
  };
}

function inventoryHas(inventory, kind, id) {
  const ids = inventory[kind] || [];
  return id ? ids.includes(String(id)) : ids.length > 0;
}

// Assess one funnel's capture against its declared analytics contract.
// `contract` is the spec's `analytics` block (may be undefined/empty).
export function assessAnalyticsCorrectness(capture = {}, contract = {}) {
  const assertions = [];
  const inventory = capture.inventory || {};
  const providers = (contract && contract.providers) || {};
  const hasContract = !!(contract && (contract.providers || contract.out_of_band_pixels || contract.params || contract.manual_events));

  // No declared contract → can't know expected ids; emit a non-gating inventory
  // so the run still records what fired, and flag that nothing was validated.
  if (!hasContract) {
    assertions.push(correctnessAssertion({
      id: "analytics-correctness:no-contract",
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.INFO,
      expected: "a declared CampaignSpec analytics block to validate against",
      actual: "no analytics contract declared — recorded the observed fires, gated nothing",
      evidence: { observed_inventory: inventory, purchase: effectivePurchase(capture), events: capture.eventNames || [] },
    }));
    return assertions;
  }

  // 1. GTM container fires (blocker when declared + enabled).
  if (providers.gtm && providers.gtm.enabled !== false) {
    const id = providers.gtm.containerId;
    const present = inventoryHas(inventory, "gtm", id);
    assertions.push(correctnessAssertion({
      id: "analytics-correctness:tag:gtm",
      status: present ? STATUS.PASS : STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: `GTM ${id || "container"} fires on the page`,
      actual: present ? "present" : `absent (observed: ${(inventory.gtm || []).join(", ") || "none"})`,
      evidence: { declared: id || null, observed: inventory.gtm || [] },
    }));
  }

  // 2. Meta pixel fires (blocker when declared + enabled).
  if (providers.facebook && providers.facebook.enabled !== false) {
    const id = providers.facebook.pixelId;
    const present = inventoryHas(inventory, "meta", id);
    assertions.push(correctnessAssertion({
      id: "analytics-correctness:tag:meta",
      status: present ? STATUS.PASS : STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      expected: `Meta pixel ${id || ""} fires on the page`.trim(),
      actual: present ? "present" : `absent (observed: ${(inventory.meta || []).join(", ") || "none"})`,
      evidence: { declared: id || null, observed: inventory.meta || [] },
    }));
  }

  // 3. Out-of-band pixels declared as carried (Everflow / TriplePixel / …).
  for (const [i, pixel] of (contract.out_of_band_pixels || []).entries()) {
    if (!pixel || !pixel.vendor) continue;
    const vendor = String(pixel.vendor).toLowerCase();
    if (KNOWN_VENDOR_KINDS.has(vendor)) {
      const present = inventoryHas(inventory, vendor, pixel.id);
      assertions.push(correctnessAssertion({
        id: `analytics-correctness:oob:${vendor}`,
        status: present ? STATUS.PASS : STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: `declared out-of-band ${vendor} pixel fires`,
        actual: present ? "present" : "absent",
        evidence: { vendor, declared_id: pixel.id || null, observed: inventory[vendor] || [] },
      }));
    } else {
      // Vendor host not in the classifier (e.g. TriplePixel→triplewhale.com).
      // Pass its name as --analytics-hosts to capture it; until then, review.
      assertions.push(correctnessAssertion({
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
  const eff = effectivePurchase(capture);
  assertions.push(correctnessAssertion({
    id: "analytics-correctness:purchase-fires",
    status: eff.fired ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: "a Purchase fires on this page (dl_purchase, or Meta/GA4 pixel if the SDK event is blocked)",
    actual: eff.fired ? `fired via ${eff.via}` : "no Purchase fire captured (dataLayer, Meta, or GA4)",
    evidence: { via: eff.via, signals: capture.purchaseSignals || {} },
  }));

  return assertions;
}
