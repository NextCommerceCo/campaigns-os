// Purchase data-layer evidence for browser QA (campaigns-os#325).
//
// The current-SDK bump lane exists to prove one thing: after a typed-card
// order is placed, the funnel pushes exactly one `dl_purchase` to
// `window.NextDataLayer`, and it names the order the run just placed. Until
// now the verdict had no field for that, so the operator proved it with a
// separate read-only browser probe and wrote the result into a hand-authored
// evidence file — the one signal the bump exists to prove lived outside the
// harness's own record.
//
// This module is the assertion. It judges three things at once, because they
// are one question:
//
//   present   — at least one `dl_purchase` was pushed after the order;
//   once      — and only one (#302's rule: a funnel that reports the purchase
//               twice double-counts revenue and is a FAIL, same as none);
//   matching  — and its `ecommerce.transaction_id` is the placed order's
//               number or ref id, so the event is about THIS order and not a
//               replay of an earlier one.
//
// Where the event fires is the part that was easy to get wrong, and the first
// end-to-end run got it wrong: the SDK raises `dl_purchase` from
// `order:completed`, on the FIRST page opened with `?ref_id=` that fetches the
// order back — the upsell page on a funnel that has one, the receipt only when
// nothing sits between checkout and receipt — and then remembers the
// transaction id per browser and drops the event on every later page of the
// same order (a reload, a new tab, the receipt after an upsell). So the
// reading is the whole post-checkout journey of the order, not a snapshot of
// the terminal document: the runner's data-layer hook records every push on
// every document the path visits, and this module counts the `dl_purchase`
// pushes to the SDK's own array across all of them, keeping a per-document
// breakdown as evidence. A second push on a later document is exactly the
// double count #302 describes.
//
// It counts `window.NextDataLayer` only (not the mirrored `window.dataLayer`
// / `window.ElevarDataLayer`, where a GTM adapter legitimately re-pushes the
// same event), runs only when the run actually placed an order, and needs no
// CampaignSpec analytics block: the SDK writes this array whether or not any
// provider is declared. `dl_upsell_purchase` is a different event name and is
// never counted; an accepted upsell legitimately adds one. #302's remaining
// scope — the same rule for outbound Meta / GA4 Purchase fires — slots into
// the same record keyed by source; nothing here has to move for it.

import { SEVERITY, STATUS } from "./qa-verdict.mjs";
import { redactUrlQuery } from "./qa-url-privacy.mjs";

export const PURCHASE_DATA_LAYER = "NextDataLayer";
export const PURCHASE_EVENT = "dl_purchase";

function orderReference(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The order's own references, in the order the SDK resolves `transaction_id`
// (`order.number`, then `ref_id`). Either is an acceptable match: the SDK
// reports the number when the API returned one and the ref id otherwise.
export function expectedOrderReferences(order = {}) {
  return [...new Set([orderReference(order?.next_order_id), orderReference(order?.ref_id)].filter(Boolean))];
}

// Reduce the capture handle's raw push log to the purchase data-layer probe:
// every push to the SDK's own array, by event name and by document, with the
// purchase-shaped ones carrying their transaction id. Pure, so the same shape
// can be built from a recorded log in tests.
//
// `raw` is `{ complete, events: [{ layer, data, document: { route, generation } }] }`
// from `attachAnalyticsCapture(page).rawEvents()`. An incomplete log (no
// binding) yields `measured: false`: the events it does hold are not the
// journey and cannot be counted as one.
export function purchaseDataLayerProbe(raw, { layer = PURCHASE_DATA_LAYER, event = PURCHASE_EVENT } = {}) {
  const complete = raw?.complete === true;
  const entries = complete && Array.isArray(raw.events) ? raw.events.filter((entry) => entry?.layer === layer) : [];
  const eventCounts = {};
  const purchases = [];
  const documents = new Map();
  entries.forEach((entry, index) => {
    const data = entry.data && typeof entry.data === "object" ? entry.data : null;
    const name = data && typeof data.event === "string" ? data.event : "";
    if (!name) return;
    eventCounts[name] = (eventCounts[name] || 0) + 1;
    const route = entry.document?.route || null;
    const generation = Number.isFinite(entry.document?.generation) ? entry.document.generation : null;
    const key = `${generation ?? "?"}:${route ?? ""}`;
    if (!documents.has(key)) documents.set(key, { route, generation, event_count: 0, purchase_count: 0 });
    const document = documents.get(key);
    document.event_count += 1;
    if (name !== event) return;
    document.purchase_count += 1;
    const ecommerce = data.ecommerce && typeof data.ecommerce === "object" ? data.ecommerce : {};
    const transactionId = ecommerce.transaction_id;
    purchases.push({
      index,
      document_route: route,
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
    measured: complete,
    length: entries.length,
    event_counts: eventCounts,
    documents: [...documents.values()],
    purchases,
  };
}

// Judge a probe against the order the run placed. Pure: the record it returns
// is what the verdict's `test_orders[].data_layer` carries and what the
// assertion below reads. `outcome` is the one enumerated answer; `ok` and
// `reason` are its projection for readers that only want pass/fail and why.
//
// Outcomes:
//   pass              one dl_purchase, transaction_id matches the placed order
//   absent            no dl_purchase anywhere after the order — the #325 miss
//   duplicate         more than one dl_purchase — the #302 fail
//   mismatch          one dl_purchase, but it names a different order (or none)
//   order_ref_unknown one dl_purchase, but the run recorded no order number or
//                     ref id to match it against — cannot pass or fail
//   unmeasured        the layer could not be hooked or read — a blocker, never
//                     a zero-signal reading (#198)
export function assessPurchaseDataLayer(probe, order = {}, options = {}) {
  const expectedRefs = expectedOrderReferences(order);
  const base = {
    layer: PURCHASE_DATA_LAYER,
    event: PURCHASE_EVENT,
    required: true,
    expected_order_refs: expectedRefs,
  };
  const probeError = options.probeError ?? null;
  if (probeError || !probe || typeof probe !== "object" || probe.measured !== true) {
    const detail = probeError instanceof Error
      ? probeError.message
      : probeError
        ? String(probeError)
        : probe && typeof probe === "object"
          ? "the data-layer hook could not mirror pushes out of the page"
          : "no probe result";
    return {
      ...base,
      measured: false,
      count: null,
      observed_transaction_ids: null,
      order_ref_match: null,
      outcome: "unmeasured",
      ok: false,
      reason: `window.${PURCHASE_DATA_LAYER} could not be read after the order: ${detail}`,
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
    const documents = Array.isArray(probe.documents) ? probe.documents.length : 0;
    return names.length
      ? ` (${probe.length ?? 0} event(s) on ${documents} document(s): ${names.map((name) => `${name}×${counts[name]}`).join(", ")})`
      : " (no events on any document)";
  };
  const whereFired = () => {
    const routes = purchases.map((entry) => entry?.document_route || "(unknown document)");
    return routes.length ? ` on ${routes.join(", ")}` : "";
  };

  if (count === 0) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "absent",
      ok: false,
      reason: `no ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER} on any page after the order${eventSummary()}`,
    };
  }
  if (count > 1) {
    const ids = observedIds.map((id) => id ?? "(none)").join(", ");
    return {
      ...measured,
      order_ref_match: expectedRefs.length ? observedIds.some((id) => id && expectedRefs.includes(id)) : null,
      outcome: "duplicate",
      ok: false,
      reason: `${PURCHASE_EVENT} was pushed ${count} times to window.${PURCHASE_DATA_LAYER}${whereFired()} (transaction ids: ${ids}); one order must report one purchase`,
    };
  }

  const [transactionId] = observedIds;
  if (!expectedRefs.length) {
    return {
      ...measured,
      order_ref_match: null,
      outcome: "order_ref_unknown",
      ok: null,
      reason: `one ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER}${whereFired()} (transaction_id ${transactionId ?? "(none)"}), but the run recorded no order number or ref id to match it against`,
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
        ? `one ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER}${whereFired()}, but its transaction_id ${transactionId} is not the placed order (${expectedRefs.join(" / ")})`
        : `one ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER}${whereFired()}, but it carries no transaction_id to match the placed order (${expectedRefs.join(" / ")})`,
    };
  }
  return {
    ...measured,
    order_ref_match: true,
    outcome: "pass",
    ok: true,
    reason: `one ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER}${whereFired()} carrying transaction_id ${transactionId}, the placed order`,
  };
}

const OUTCOME_STATUS = Object.freeze({
  pass: STATUS.PASS,
  order_ref_unknown: STATUS.MANUAL_REVIEW,
});

// The verdict assertion, one per typed-card path that placed an order. Null
// when the order carries no data-layer record (no order was placed, legacy API
// order) — a path that never created an order is the browser-test-order
// assertion's failure to report, not this one's.
export function purchaseDataLayerAssertion(page, path, order) {
  const record = order?.data_layer;
  if (!record || typeof record !== "object") return null;
  const status = OUTCOME_STATUS[record.outcome] || STATUS.FAIL;
  const severity = status === STATUS.FAIL ? SEVERITY.BLOCKER : status === STATUS.MANUAL_REVIEW ? SEVERITY.WARN : undefined;
  const probe = order?.evidence?.data_layer;
  return {
    id: `analytics-correctness:data-layer-purchase:${path}`,
    family: "analytics-correctness",
    page: `${page?.page_id || "checkout"}:order:${path}`,
    url: redactUrlQuery(order?.final_url) || undefined,
    status,
    ...(severity ? { severity } : {}),
    expected: `exactly one ${PURCHASE_EVENT} in window.${PURCHASE_DATA_LAYER} across the pages after the order, carrying the placed order's reference as transaction_id`,
    actual: record.reason,
    evidence: {
      ...record,
      ...(probe && typeof probe === "object"
        ? {
            event_counts: probe.event_counts || {},
            documents: Array.isArray(probe.documents) ? probe.documents : [],
            purchases: Array.isArray(probe.purchases) ? probe.purchases : [],
          }
        : {}),
    },
  };
}
