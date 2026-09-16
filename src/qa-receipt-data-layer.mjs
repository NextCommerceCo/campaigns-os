// Receipt data-layer evidence for browser QA (campaigns-os#325).
//
// The current-SDK bump lane exists to prove one thing: the receipt page pushes
// exactly one `dl_purchase` to `window.NextDataLayer`, and it names the order
// the run just placed. Until now the verdict had no field for that, so the
// operator proved it with a separate read-only browser probe and wrote the
// result into a hand-authored evidence file — the one signal the bump exists
// to prove lived outside the harness's own record.
//
// This module is the assertion. It reads the SDK's own array on the receipt
// document (not the mirrored `window.dataLayer` / `window.ElevarDataLayer`,
// where a GTM adapter legitimately re-pushes the same event) and judges three
// things at once, because they are one question:
//
//   present   — at least one `dl_purchase` was pushed;
//   once      — and only one (#302's rule: a receipt that reports the purchase
//               twice double-counts revenue and is a FAIL, same as none);
//   matching  — and its `ecommerce.transaction_id` is the placed order's
//               number or ref id, so the event is about THIS order and not a
//               replay of an earlier one.
//
// It runs from the typed-card order leg, only on a recognized receipt of an
// order the run actually placed, and independently of the CampaignSpec
// analytics block: the SDK writes this array whether or not any provider is
// declared, so the assertion needs no contract to know what to expect.
//
// `dl_upsell_purchase` is a different event name and is never counted here;
// an accepted upsell legitimately adds one. #302's remaining scope — the same
// rule for outbound Meta / GA4 Purchase fires — slots into the same record
// (`count`, `observed_transaction_ids`) keyed by source; nothing here has to
// move for it.

import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { redactUrlQuery } from "./qa-url-privacy.mjs";

export const RECEIPT_DATA_LAYER = "NextDataLayer";
export const RECEIPT_PURCHASE_EVENT = "dl_purchase";

// The evaluate input. The body is serialised into the page, so it cannot read
// module constants; they arrive through this object.
export const RECEIPT_DATA_LAYER_PROBE_INPUT = Object.freeze({
  layer: RECEIPT_DATA_LAYER,
  event: RECEIPT_PURCHASE_EVENT,
});

// Returns the `page.evaluate` body. Exported as a factory so the unit tests and
// any browser proof drive the same function the QA runner does, not a copy.
// Self-contained on purpose: no closure over module scope.
export function receiptDataLayerProbeScript() {
  return ({ layer, event }) => {
    if (typeof layer !== "string" || !layer || typeof event !== "string" || !event) {
      throw new Error("receipt data-layer probe needs { layer, event } in its input (use RECEIPT_DATA_LAYER_PROBE_INPUT)");
    }
    const value = globalThis[layer];
    const defined = typeof value !== "undefined" && value !== null;
    const isArray = Array.isArray(value);
    const entries = isArray ? value : [];
    const eventCounts = {};
    const purchases = [];
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const name = typeof entry.event === "string" ? entry.event : "";
      if (!name) return;
      eventCounts[name] = (eventCounts[name] || 0) + 1;
      if (name !== event) return;
      const ecommerce = entry.ecommerce && typeof entry.ecommerce === "object" ? entry.ecommerce : {};
      const transactionId = ecommerce.transaction_id;
      purchases.push({
        index,
        transaction_id: transactionId === undefined || transactionId === null || transactionId === ""
          ? null
          : String(transactionId),
        value: typeof ecommerce.value === "number" && Number.isFinite(ecommerce.value) ? ecommerce.value : null,
        currency: typeof ecommerce.currency === "string" && ecommerce.currency ? ecommerce.currency : null,
      });
    });
    return {
      layer,
      event,
      defined,
      is_array: isArray,
      length: entries.length,
      event_counts: eventCounts,
      purchases,
    };
  };
}

function orderReference(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The order's own references, in the order the SDK resolves `transaction_id`
// (`order.number`, then `ref_id`). Either is an acceptable match: the SDK
// reports the number when the API returned one and the ref id otherwise.
export function expectedOrderReferences(order = {}) {
  return [...new Set([orderReference(order?.next_order_id), orderReference(order?.ref_id)].filter(Boolean))];
}

// Judge a probe against the order the run placed. Pure: the record it returns
// is what the verdict's `test_orders[].data_layer` carries and what the
// assertion below reads. `outcome` is the one enumerated answer; `ok` and
// `reason` are its projection for readers that only want pass/fail and why.
//
// Outcomes:
//   pass              one dl_purchase, transaction_id matches the placed order
//   absent            no dl_purchase (or no array at all) — the #325 miss
//   duplicate         more than one dl_purchase — the #302 fail
//   mismatch          one dl_purchase, but it names a different order (or none)
//   order_ref_unknown one dl_purchase, but the run recorded no order number or
//                     ref id to match it against — cannot pass or fail
//   unmeasured        the array could not be read (page closed, evaluate
//                     threw) — a blocker, never a zero-signal reading (#198)
export function assessReceiptDataLayer(probe, order = {}, options = {}) {
  const expectedRefs = expectedOrderReferences(order);
  const base = {
    layer: RECEIPT_DATA_LAYER,
    event: RECEIPT_PURCHASE_EVENT,
    required: true,
    expected_order_refs: expectedRefs,
  };
  const probeError = options.probeError ?? null;
  if (probeError || !probe || typeof probe !== "object") {
    const detail = probeError instanceof Error ? probeError.message : probeError ? String(probeError) : "no probe result";
    return {
      ...base,
      measured: false,
      count: null,
      observed_transaction_ids: null,
      order_ref_match: null,
      outcome: "unmeasured",
      ok: false,
      reason: `window.${RECEIPT_DATA_LAYER} could not be read on the receipt: ${detail}`,
    };
  }

  const purchases = Array.isArray(probe.purchases) ? probe.purchases : [];
  const observedIds = purchases.map((entry) => (entry && typeof entry === "object" ? entry.transaction_id ?? null : null));
  const count = purchases.length;
  const measured = {
    ...base,
    measured: true,
    count,
    observed_transaction_ids: observedIds,
  };
  const eventSummary = () => {
    const counts = probe.event_counts && typeof probe.event_counts === "object" ? probe.event_counts : {};
    const names = Object.keys(counts);
    return names.length ? ` (${probe.length ?? 0} event(s): ${names.map((name) => `${name}×${counts[name]}`).join(", ")})` : " (no events)";
  };

  if (!probe.defined) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "absent",
      ok: false,
      reason: `window.${RECEIPT_DATA_LAYER} is not defined on the receipt document; no ${RECEIPT_PURCHASE_EVENT} was pushed`,
    };
  }
  if (!probe.is_array) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "absent",
      ok: false,
      reason: `window.${RECEIPT_DATA_LAYER} is not an array on the receipt document; no ${RECEIPT_PURCHASE_EVENT} could be read`,
    };
  }
  if (count === 0) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "absent",
      ok: false,
      reason: `no ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER} on the receipt${eventSummary()}`,
    };
  }
  if (count > 1) {
    const ids = observedIds.map((id) => id ?? "(none)").join(", ");
    return {
      ...measured,
      order_ref_match: expectedRefs.length ? observedIds.some((id) => id && expectedRefs.includes(id)) : null,
      outcome: "duplicate",
      ok: false,
      reason: `${RECEIPT_PURCHASE_EVENT} was pushed ${count} times to window.${RECEIPT_DATA_LAYER} on the receipt (transaction ids: ${ids}); one order must report one purchase`,
    };
  }

  const [transactionId] = observedIds;
  if (!expectedRefs.length) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "order_ref_unknown",
      ok: null,
      reason: `one ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER} (transaction_id ${transactionId ?? "(none)"}), but the run recorded no order number or ref id to match it against`,
    };
  }
  const matched = !!transactionId && expectedRefs.includes(transactionId);
  if (!matched) {
    return {
      ...measured,
      order_ref_match: false,
      outcome: "mismatch",
      ok: false,
      reason: transactionId
        ? `one ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER}, but its transaction_id ${transactionId} is not the placed order (${expectedRefs.join(" / ")})`
        : `one ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER}, but it carries no transaction_id to match the placed order (${expectedRefs.join(" / ")})`,
    };
  }
  return {
    ...measured,
    order_ref_match: true,
    outcome: "pass",
    ok: true,
    reason: `one ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER} carrying transaction_id ${transactionId}, the placed order`,
  };
}

const OUTCOME_STATUS = Object.freeze({
  pass: STATUS.PASS,
  order_ref_unknown: STATUS.MANUAL_REVIEW,
});

// The verdict assertion, one per typed-card path that reached a recognized
// receipt. Null when the order carries no data-layer record (receipt not
// reached, external handoff, legacy API order) — like receipt rendering,
// absence of the receipt is the browser-test-order assertion's failure to
// report, not this one's.
export function receiptDataLayerAssertion(page, path, order) {
  const record = order?.data_layer;
  if (!record || typeof record !== "object") return null;
  const status = OUTCOME_STATUS[record.outcome] || STATUS.FAIL;
  const severity = status === STATUS.FAIL ? SEVERITY.BLOCKER : status === STATUS.MANUAL_REVIEW ? SEVERITY.WARN : undefined;
  const probe = order?.evidence?.data_layer;
  return {
    id: `analytics-correctness:data-layer-purchase:${path}`,
    family: "analytics-correctness",
    page: `${page?.page_id || "checkout"}:receipt:${path}`,
    url: redactUrlQuery(order?.final_url) || undefined,
    status,
    ...(severity ? { severity } : {}),
    expected: `exactly one ${RECEIPT_PURCHASE_EVENT} in window.${RECEIPT_DATA_LAYER} on the receipt, carrying the placed order's reference as transaction_id`,
    actual: record.reason,
    evidence: {
      ...record,
      ...(probe && typeof probe === "object"
        ? { event_counts: probe.event_counts || {}, purchases: Array.isArray(probe.purchases) ? probe.purchases : [] }
        : {}),
    },
  };
}
