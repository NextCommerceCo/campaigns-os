// Analytics CORRECTNESS assessment (single funnel) — the foundation layer the
// migration parity differ sits on top of. Where parity asks "does candidate
// match baseline?", correctness has two deliberately separate authorities:
// campaign-root inventory proves declared providers/tags are present, while
// receipt evidence from the canonical typed-card order proves Purchase. A
// campaign-root visit cannot prove (or disprove) a receipt-only event.
//
// Driven by the CampaignSpec `analytics` block (campaign-spec AnalyticsContract).
// When no block is declared the assessment can't know the expected container/
// pixel ids, so it emits an INFO inventory only — nothing is gated. The contract
// is what turns observations into pass/fail. (Until the spec authoring tool
// emits the block, real specs won't carry one — so the no-contract path is the
// common case today and must stay non-blocking.)
//
// Receipt proof is source-aware by construction: it keys on OUTBOUND pixel
// fires (the network truth), via effectivePurchase, so a campaign that blocks
// the SDK dl_* event and fires the pixel manually still passes.

import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { effectivePurchase } from "./qa-analytics-parity.mjs";
import { redactUrlQuery } from "./qa-url-privacy.mjs";

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
// I-9/I-16): a recorded `qa waive` decision for purchase-fires. The caller
// decides eligibility: only a genuine, recognized receipt with no effective
// Purchase may consume the waiver. Missing/unrecognized paths and capture
// errors cannot.
function purchaseFiresWaiver(options, eligible) {
  if (!eligible) return null;
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

// Assess the campaign-root capture against its declared analytics inventory.
// `contract` is the spec's `analytics` block (may be undefined/empty).
// `options.url` is the URL the capture actually visited (the resolved capture
// target) — stamped on every emitted assertion, pass and fail alike.
export function assessAnalyticsInventory(capture = {}, contract = {}, options = {}) {
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
      // Counts only — never publish raw container/pixel ids or any Purchase
      // fields to the QA portal. Root inventory is not Purchase authority.
      evidence: {
        inventory: Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, v.length])),
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

  return assertions;
}

// Finalize the one stable Purchase assertion from the private capture envelope
// returned by the canonical typed-card browser-order run. This function is
// intentionally pure and emits only a fixed, sanitized evidence projection;
// raw captures, event payloads, order identifiers, values, currencies, and URL
// query strings never cross into the verdict.
export function assessReceiptPurchase(receiptAnalytics = {}, options = {}) {
  const plannedPlanIds = Array.isArray(receiptAnalytics?.plannedPlanIds)
    ? receiptAnalytics.plannedPlanIds.map(normalizePlanId).filter(Boolean)
    : [];
  const attempts = Array.isArray(receiptAnalytics?.attempts) ? receiptAnalytics.attempts : [];
  const attemptedPlanIds = attempts.map((attempt) => normalizePlanId(attempt?.planId)).filter(Boolean);
  const receipts = [];
  const unqualifiedPlanIds = [];
  const captureErrorPlanIds = [];
  const noSignalPlanIds = [];

  for (const planId of plannedPlanIds) {
    const attempt = attempts.find((candidate) => normalizePlanId(candidate?.planId) === planId);
    if (!attempt) {
      unqualifiedPlanIds.push(planId);
      continue;
    }
    if (attempt.receiptRecognized !== true) {
      unqualifiedPlanIds.push(planId);
      continue;
    }

    const captureAvailable = !!attempt.capture && typeof attempt.capture === "object";
    const captureError = !!attempt.captureError || !captureAvailable;
    if (captureError) captureErrorPlanIds.push(planId);
    const effective = captureAvailable ? effectivePurchase(attempt.capture) : { fired: false, via: null };
    const signals = receiptSignals(attempt.capture);
    if (!captureError && !effective.fired) noSignalPlanIds.push(planId);
    receipts.push({
      plan_id: planId,
      receipt_url: redactUrlQuery(attempt.receiptUrl),
      purchase_fired: !!effective.fired,
      via: effective.via || null,
      signals,
    });
  }

  const hasBlockingCaptureError = captureErrorPlanIds.length > 0;
  const hasNoSignalReceipt = noSignalPlanIds.length > 0;
  const failed = hasBlockingCaptureError || hasNoSignalReceipt;
  const needsReview = !plannedPlanIds.length || unqualifiedPlanIds.length > 0;
  const waiver = purchaseFiresWaiver(options, hasNoSignalReceipt && !hasBlockingCaptureError);
  const status = failed ? STATUS.FAIL : needsReview ? STATUS.MANUAL_REVIEW : STATUS.PASS;
  const severity = status === STATUS.FAIL
    ? (waiver ? SEVERITY.WARN : SEVERITY.BLOCKER)
    : status === STATUS.MANUAL_REVIEW ? SEVERITY.WARN : undefined;
  const evidence = {
    attempted_plan_ids: attemptedPlanIds,
    receipts,
    unqualified_plan_ids: unique(unqualifiedPlanIds),
    capture_error_plan_ids: unique(captureErrorPlanIds),
  };

  return correctnessAssertion({
    id: "analytics-correctness:purchase-fires",
    status,
    severity,
    ...(waiver ? { waiver } : {}),
    expected: "every deterministic receipt-qualified typed-card order emits Purchase via dataLayer, Meta, or GA4.",
    actual: receiptPurchaseActual({
      plannedCount: plannedPlanIds.length,
      receiptCount: receipts.length,
      firedCount: receipts.filter((receipt) => receipt.purchase_fired).length,
      unqualifiedCount: unique(unqualifiedPlanIds).length,
      captureErrorCount: unique(captureErrorPlanIds).length,
      waiver,
    }),
    evidence,
  });
}

function normalizePlanId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values)];
}

function receiptSignals(capture) {
  const signals = capture?.purchaseSignals || {};
  return {
    dataLayer: !!(capture?.purchase?.present || signals.dataLayer),
    meta: !!signals.meta,
    ga4: !!signals.ga4,
  };
}

function receiptPurchaseActual({ plannedCount, receiptCount, firedCount, unqualifiedCount, captureErrorCount, waiver }) {
  if (!plannedCount) return "no canonical typed-card browser order was planned; Purchase requires receipt-qualified order evidence";
  if (captureErrorCount) return `${captureErrorCount} planned order capture(s) failed; Purchase could not be verified`;
  if (firedCount < receiptCount) {
    const suffix = waiver
      ? ` — blocker waived by ${waiver.waived_by}${waiver.waived_at ? ` at ${waiver.waived_at}` : ""}: ${waiver.reason}`
      : "";
    return `${receiptCount - firedCount} receipt-qualified order(s) emitted no Purchase via dataLayer, Meta, or GA4${suffix}`;
  }
  if (unqualifiedCount) return `${unqualifiedCount} of ${plannedCount} planned order(s) did not reach a recognized receipt`;
  return `${firedCount} of ${plannedCount} receipt-qualified order(s) emitted Purchase`;
}
