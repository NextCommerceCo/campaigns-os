// Analytics-parity capture + diff for the campaigns-os QA harness.
//
// This is the missing PARITY-QA analytics leg: migration doctrine forbids a
// cutover without a green parity diff, and the SDK-boundary parity zone is the
// live dataLayer event stream + GTM/pixel tag-fires. Runtime-injected GTM is
// invisible to repo scans (a live Meta Purchase tag once lived in a second GTM
// container injected at runtime; legacy `campaign.js` pushes its real events
// from a remote script) — so parity can only be asserted from a LIVE capture,
// baseline (legacy funnel) vs candidate (migrated preview), diffed here.
//
// Contract (see the campaignsjs→SDK-0.4.x migration doctrine, PARITY QA phase):
//  - The canonical SDK `dl_*` commerce set is the BLOCKING gate.
//  - Carried-over 3rd-party tags (GTM / Meta / Everflow / GA4 / …) present on
//    the baseline but missing on the candidate are a WARN regression, not an
//    auto-block (some are intentionally dropped — a human confirms).
//  - Purchase `value`/`currency` are compared client-fired vs client-fired
//    (the harness drives the SAME offer through both funnels). They are NEVER
//    diffed against a backend order total: on one-step headless checkouts tax
//    is computed backend at order-creation time and is NOT in the client value,
//    so a value-vs-total diff would false-fail by the tax amount every order.
//  - `transaction_id` differs legitimately (two different orders), so it is
//    checked for PRESENCE/consistency, not equality.
//
// This module is pure + page-method-only (no direct playwright import), so the
// classification/diff logic is unit-testable and the capture attaches to any
// Playwright page the host harness already owns.

import { SEVERITY, STATUS } from "./qa-verdict.mjs";

// Data layers the SDK and legacy funnels push through. The SDK's GTMAdapter
// mirrors every `dl_*` event to window.dataLayer AND window.ElevarDataLayer;
// the SDK's own dedicated layer is window.NextDataLayer. Legacy funnels push
// to window.dataLayer. We hook all of them and dedup downstream.
export const HOOKED_DATA_LAYERS = Object.freeze([
  "dataLayer",
  "NextDataLayer",
  "ElevarDataLayer",
]);

// Canonical SDK commerce events (subset that the parity gate cares about most).
// dl_purchase is the highest-value check; the others round out the funnel.
export const CANONICAL_COMMERCE_EVENTS = Object.freeze([
  "dl_view_item",
  "dl_add_to_cart",
  "dl_begin_checkout",
  "dl_add_shipping_info",
  "dl_add_payment_info",
  "dl_purchase",
]);

// Default extra hosts treated as analytics tag-fires beyond the well-known ones.
// Everflow (affiliate) often fires from a merchant-custom tracking domain, so it
// is matched by substring and the host list is extensible via args.
const DEFAULT_EXTRA_ANALYTICS_HOST_SUBSTRINGS = Object.freeze(["everflow"]);

// Float compare tolerance for money values (cents).
const VALUE_EPSILON = 0.005;

// ---------------------------------------------------------------------------
// Capture (browser side) — operates on a passed-in Playwright page.
// ---------------------------------------------------------------------------

// JS installed via page.addInitScript BEFORE any page script runs. It wraps the
// push() of each hooked data layer so every pushed event is recorded in order,
// surviving the common `window.dataLayer = window.dataLayer || []` idiom by
// trapping assignment with a getter/setter and re-wrapping push on replacement.
export function analyticsInitScript(layers = HOOKED_DATA_LAYERS) {
  return `(() => {
    const LAYERS = ${JSON.stringify(layers)};
    const store = (window.__nextQaAnalytics = window.__nextQaAnalytics || { events: [] });
    const clone = (value) => {
      try { return JSON.parse(JSON.stringify(value)); }
      catch (_) {
        const out = {};
        for (const k of Object.keys(value || {})) {
          const v = value[k];
          if (typeof v !== "function") out[k] = v;
        }
        return out;
      }
    };
    const record = (layer, args) => {
      for (const arg of args) {
        if (arg && typeof arg === "object") {
          const entry = { layer, data: clone(arg) };
          store.events.push(entry);
          // Mirror to the Node side immediately (exposeBinding survives
          // navigations; this in-page store does not). Fire-and-forget.
          try { window.__nextQaAnalyticsEmit && window.__nextQaAnalyticsEmit(entry); } catch (_) {}
        }
      }
    };
    const wrap = (layer, arr) => {
      if (!Array.isArray(arr) || arr.__nextQaWrapped) return arr;
      // Record anything already present at hook time.
      record(layer, arr);
      const nativePush = arr.push.bind(arr);
      arr.push = (...args) => { record(layer, args); return nativePush(...args); };
      Object.defineProperty(arr, "__nextQaWrapped", { value: true, enumerable: false });
      return arr;
    };
    for (const name of LAYERS) {
      let backing = wrap(name, window[name] || []);
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return backing; },
        set(next) { backing = wrap(name, next || []); },
      });
    }
  })();`;
}

// Attach capture to a page: install the init script + listen for outbound tag
// fires to analytics hosts. Returns a handle whose collect() reads the recorded
// dataLayer events out of the page and normalizes them with the tag fires.
export async function attachAnalyticsCapture(page, options = {}) {
  const extraHosts = Array.isArray(options.extraHosts) ? options.extraHosts : [];
  const tagFires = [];
  // Node-side event accumulator: a funnel traversal navigates through several
  // documents (checkout → upsell → receipt) and each navigation discards the
  // in-page store, so the init script mirrors every event out through this
  // binding. Best-effort — pages without binding support fall back to the
  // per-document store in collect().
  const accumulatedEvents = [];
  let bindingAttached = false;
  if (typeof page.exposeBinding === "function") {
    try {
      await page.exposeBinding("__nextQaAnalyticsEmit", (_source, event) => {
        if (event && typeof event === "object") accumulatedEvents.push(event);
      });
      bindingAttached = true;
    } catch (_) { /* binding may already exist on a reused page */ }
  }
  await page.addInitScript(analyticsInitScript());
  const onRequest = (request) => {
    const url = typeof request.url === "function" ? request.url() : request.url;
    const fire = classifyTagFire(url, extraHosts);
    if (fire) tagFires.push(fire);
  };
  page.on("request", onRequest);
  return {
    tagFires,
    async collect() {
      let events = [];
      try {
        events = await page.evaluate(() => (window.__nextQaAnalytics?.events) || []);
      } catch (_) {
        events = [];
      }
      // The binding stream is authoritative when attached (it saw every
      // document); the current-document read only backfills non-binding pages.
      if (bindingAttached && accumulatedEvents.length >= events.length) {
        events = accumulatedEvents;
      }
      return normalizeCapture({ events, tagFires });
    },
    detach() {
      try { page.off("request", onRequest); } catch (_) { /* page may be closed */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Pure classification + normalization (unit-testable, no browser).
// ---------------------------------------------------------------------------

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

// Classify an outbound request URL as an analytics tag fire, extracting the
// provider kind + container/pixel id + query params (params carry the Meta
// Purchase `eid`/`event_id` dedup key). Returns null for non-analytics hosts.
export function classifyTagFire(urlString, extraHostSubstrings = []) {
  let url;
  try { url = new URL(urlString); }
  catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const params = Object.fromEntries(url.searchParams.entries());
  const fire = (kind, id) => ({ kind, id: id ? String(id) : null, host, params });
  const subs = [...DEFAULT_EXTRA_ANALYTICS_HOST_SUBSTRINGS, ...extraHostSubstrings];

  if (hostMatches(host, "googletagmanager.com")) {
    const id = params.id || null;
    if (id && /^GTM-/i.test(id)) return fire("gtm", id);
    if (id && /^G-/i.test(id)) return fire("ga4", id);
    if (id && /^AW-/i.test(id)) return fire("google_ads", id);
    return fire("gtm", id);
  }
  if (hostMatches(host, "google-analytics.com") || hostMatches(host, "analytics.google.com")) {
    return fire("ga4", params.tid || null);
  }
  if (hostMatches(host, "googleadservices.com") || hostMatches(host, "googlesyndication.com")) {
    return fire("google_ads", params.id || params.tid || null);
  }
  if (hostMatches(host, "facebook.com") || hostMatches(host, "facebook.net")) {
    return fire("meta", params.id || null);
  }
  if (hostMatches(host, "tiktok.com")) {
    return fire("tiktok", params.sdkid || params.tid || null);
  }
  for (const sub of subs) {
    if (sub && host.includes(String(sub).toLowerCase())) {
      return fire(String(sub).toLowerCase().includes("everflow") ? "everflow" : "other", params.id || null);
    }
  }
  return null;
}

// Pull purchase fields out of a pushed dataLayer event, tolerating both the SDK
// shape (`event: dl_purchase`, fields under `.ecommerce`) and arbitrary legacy
// shapes (`event: purchase`/`Purchase`, fields at top level). Returns null when
// the event is not a purchase.
export function extractPurchase(event) {
  if (!event || typeof event !== "object") return null;
  // GA4-only and some legacy funnels push the name as `event_name`, not `event`.
  const name = String(event.event || event.event_name || "").toLowerCase();
  if (name !== "purchase" && name !== "dl_purchase") return null;
  return extractPurchaseFields(event);
}

// Field extraction shared by the main-purchase reader and the per-event
// purchase map (dl_upsell_purchase and friends carry the same GA4 shape).
function extractPurchaseFields(event) {
  if (!event || typeof event !== "object") return null;
  const ec = (event.ecommerce && typeof event.ecommerce === "object") ? event.ecommerce : {};
  // Elevar-style dl_* shape (the campaign-cart SDK's): value/currency live at
  // ecommerce.purchase.actionField.revenue + ecommerce.currencyCode.
  const actionField = (ec.purchase && typeof ec.purchase === "object"
    && ec.purchase.actionField && typeof ec.purchase.actionField === "object")
    ? ec.purchase.actionField
    : {};
  const value = firstNumber([ec.value, ec.revenue, actionField.revenue, event.value, event.revenue]);
  const currency = firstString([ec.currency, ec.currencyCode, event.currency]);
  const transactionId = firstString([
    ec.transaction_id, ec.order_id, actionField.id,
    event.transaction_id, event.order_id, event.order_number,
  ]);
  return { value, currency, transactionId };
}

function firstNumber(candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

// Build a normalized capture: distinct event names, the purchase summary, the
// runtime tag/container/pixel inventory, and the Meta Purchase dedup key.
export function normalizeCapture({ events = [], tagFires = [] } = {}) {
  const rawEvents = events.map((e) => (e && e.data ? e.data : e)).filter(Boolean);
  const eventNames = [];
  let purchase = null;
  // Per-event purchase extraction: upsell purchases (dl_upsell_purchase) carry
  // their own value/currency distinct from the main dl_purchase; keyed here so
  // scenario checks can target a specific purchase-shaped event.
  const purchasesByEvent = {};
  for (const ev of rawEvents) {
    const name = ev && typeof ev === "object" ? String(ev.event || ev.event_name || "") : "";
    if (name && !eventNames.includes(name)) eventNames.push(name);
    if (!purchase) {
      const p = extractPurchase(ev);
      if (p) purchase = p;
    }
    if (name && /purchase/i.test(name) && !purchasesByEvent[name]) {
      const fields = extractPurchaseFields(ev);
      if (fields) purchasesByEvent[name] = fields;
    }
  }

  const inventory = { gtm: [], ga4: [], google_ads: [], meta: [], tiktok: [], everflow: [], other: [] };
  let metaPurchaseEventId = null;
  let metaPurchaseFired = false;
  let ga4PurchaseFired = false;
  for (const fire of tagFires) {
    if (!fire || !inventory[fire.kind]) continue;
    if (fire.id && !inventory[fire.kind].includes(fire.id)) inventory[fire.kind].push(fire.id);
    if (fire.kind === "meta") {
      const ev = fire.params?.ev || fire.params?.event;
      if (ev && String(ev).toLowerCase() === "purchase") {
        metaPurchaseFired = true;
        metaPurchaseEventId = metaPurchaseEventId || fire.params?.eid || fire.params?.event_id || null;
      }
    }
    if (fire.kind === "ga4") {
      // GA4 Measurement Protocol fires carry the event name in `en` (one per
      // event, or en=purchase among batched `&en=` params on /g/collect).
      const en = fire.params?.en || fire.params?.event_name;
      if (en && String(en).toLowerCase() === "purchase") ga4PurchaseFired = true;
    }
  }

  return {
    eventNames,
    purchase: purchase ? { present: true, ...purchase } : { present: false },
    purchasesByEvent,
    inventory,
    metaPurchaseEventId,
    // Purchase can fire from any of three sources (dataLayer event, Meta pixel,
    // GA4) — campaigns that block the SDK event and fire Meta/GA4 manually still
    // "purchased." effectivePurchase() reads these so correctness/parity don't
    // false-fail a deliberate `blockedEvents` setup.
    purchaseSignals: {
      dataLayer: !!purchase,
      meta: metaPurchaseFired,
      ga4: ga4PurchaseFired,
    },
  };
}

// The effective purchase across all fire sources — the source-of-truth answer
// to "did this funnel record a purchase," independent of whether the SDK
// dataLayer event was used or blocked-and-fired-manually via a pixel.
export function effectivePurchase(capture = {}) {
  const p = capture.purchase || { present: false };
  const s = capture.purchaseSignals || {};
  const via = p.present ? "datalayer" : s.meta ? "meta" : s.ga4 ? "ga4" : null;
  return {
    fired: !!(p.present || s.meta || s.ga4),
    via,
    // value/currency/txn are only knowable from the dataLayer event; a
    // pixel-only purchase fires without them in our capture.
    value: p.present ? p.value : null,
    currency: p.present ? p.currency : null,
    transactionId: p.present ? p.transactionId : null,
    metaEventId: capture.metaPurchaseEventId || null,
  };
}

// ---------------------------------------------------------------------------
// Diff → parity assertions (pure; this is the contract enforcement).
// ---------------------------------------------------------------------------

function parityAssertion({ id, status, severity, expected, actual, evidence }) {
  return {
    id,
    family: "analytics-parity",
    page: "analytics",
    status,
    ...(severity ? { severity } : {}),
    expected,
    actual,
    ...(evidence ? { evidence } : {}),
  };
}

function valuesEqual(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(Number(a) - Number(b)) <= VALUE_EPSILON;
}

// Diff a baseline (legacy) capture against a candidate (migrated) capture and
// emit parity assertions. Blockers enforce the canonical commerce gate; WARNs
// flag carried-over-tag regressions for human review.
export function diffAnalyticsParity(baseline, candidate) {
  const assertions = [];
  const b = baseline || {};
  const c = candidate || {};
  const bp = b.purchase || { present: false };
  const cp = c.purchase || { present: false };
  // Source-aware: a campaign may block dl_purchase and fire Purchase manually
  // via the Meta/GA4 pixel. The effective purchase counts ALL sources, so a
  // deliberate `blockedEvents` setup doesn't false-fail.
  const cEff = effectivePurchase(c);

  // 1. Purchase present on candidate — the highest-value blocking check.
  assertions.push(parityAssertion({
    id: "analytics-parity:purchase-present",
    status: cEff.fired ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: "candidate fires a Purchase (dl_purchase, or Meta/GA4 pixel if the SDK event is blocked)",
    actual: cEff.fired ? `purchase fired via ${cEff.via}` : "no purchase fire captured on candidate (dataLayer, Meta, or GA4)",
    evidence: { via: cEff.via, candidate_events: c.eventNames || [], candidate_signals: c.purchaseSignals || {}, baseline_purchase: bp },
  }));

  if (cEff.fired) {
    // 2. Value parity — same offer driven through both funnels, so client-fired
    //    values must match. Compared client-vs-client, never vs a backend total
    //    (tax is excluded from the client value on headless checkouts). Only
    //    knowable when BOTH fired the dataLayer event (a pixel-only purchase
    //    carries no client value in our capture) → else manual review.
    if (bp.present && bp.value !== null && bp.value !== undefined && cp.present && cp.value !== null && cp.value !== undefined) {
      const ok = valuesEqual(bp.value, cp.value);
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-value",
        status: ok ? STATUS.PASS : STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: `client-fired purchase value == baseline (${bp.value})`,
        actual: cp.value,
        evidence: { baseline_value: bp.value, candidate_value: cp.value, note: "client-fired; excludes backend-calculated tax" },
      }));
    } else if (!cp.present) {
      // Candidate fired Purchase pixel-only (e.g. dl_purchase blocked) — the
      // client value isn't in our capture, so value parity can't be asserted.
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-value",
        status: STATUS.MANUAL_REVIEW,
        severity: SEVERITY.WARN,
        expected: "client-fired value to compare",
        actual: `candidate purchase fired via ${cEff.via} (pixel-only) — no client value captured`,
        evidence: { via: cEff.via },
      }));
    } else {
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-value",
        status: STATUS.MANUAL_REVIEW,
        severity: SEVERITY.WARN,
        expected: "baseline purchase value to compare against",
        actual: `no baseline value captured; candidate fired ${cp.value}`,
        evidence: { baseline_value: bp.value ?? null, candidate_value: cp.value },
      }));
    }

    // 3. Currency parity (dataLayer-only; skipped for pixel-only purchases).
    if (cp.present && bp.present && bp.currency) {
      const ok = bp.currency === cp.currency;
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-currency",
        status: ok ? STATUS.PASS : STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: `purchase currency == baseline (${bp.currency})`,
        actual: cp.currency,
        evidence: { baseline_currency: bp.currency, candidate_currency: cp.currency },
      }));
    } else {
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-currency",
        status: STATUS.MANUAL_REVIEW,
        severity: SEVERITY.WARN,
        expected: "baseline purchase currency to compare against",
        actual: `no baseline currency captured; candidate fired ${cp.currency ?? "none"}`,
        evidence: { baseline_currency: null, candidate_currency: cp.currency ?? null },
      }));
    }

    // 4. transaction_id PRESENCE (not equality — different orders have different
    //    ids). Only checkable when the dataLayer event fired.
    if (cp.present) {
      assertions.push(parityAssertion({
        id: "analytics-parity:purchase-transaction-id",
        status: cp.transactionId ? STATUS.PASS : STATUS.FAIL,
        severity: SEVERITY.BLOCKER,
        expected: "candidate purchase carries a non-empty transaction_id",
        actual: cp.transactionId || "missing",
        evidence: { candidate_transaction_id: cp.transactionId || null },
      }));
    }

    // 5. Meta CAPI dedup — candidate's Meta Purchase fire carries an eventID,
    //    consistent with the order id so client + server events dedup.
    const baselineHasMeta = (b.inventory?.meta || []).length > 0;
    const candidateHasMeta = (c.inventory?.meta || []).length > 0;
    if (baselineHasMeta || candidateHasMeta) {
      const eid = c.metaPurchaseEventId;
      const consistent = eid && cp.transactionId && String(eid) === String(cp.transactionId);
      assertions.push(parityAssertion({
        id: "analytics-parity:capi-dedup",
        status: eid ? (consistent ? STATUS.PASS : STATUS.WARN) : STATUS.FAIL,
        severity: eid && !consistent ? SEVERITY.WARN : SEVERITY.BLOCKER,
        expected: "Meta Purchase fire carries an eventID keyed on the order id (CAPI dedup)",
        actual: eid ? `eventID=${eid}` : "no eventID on candidate Meta Purchase",
        evidence: { candidate_event_id: eid || null, candidate_transaction_id: cp.transactionId || null },
      }));
    }
  }

  // 6. Carried-over tag regression — any baseline container/pixel absent on the
  //    candidate is a WARN (likely attribution regression; human confirms drop).
  const kinds = ["gtm", "ga4", "google_ads", "meta", "tiktok", "everflow", "other"];
  for (const kind of kinds) {
    const baselineIds = (b.inventory?.[kind]) || [];
    const candidateIds = new Set((c.inventory?.[kind]) || []);
    for (const id of baselineIds) {
      if (id === null) {
        // Baseline fired this kind with an unknown/null id — can't reliably match
        // against candidate ids, so a human must confirm carryover.
        assertions.push(parityAssertion({
          id: `analytics-parity:carryover:${kind}:present`,
          status: STATUS.MANUAL_REVIEW,
          severity: SEVERITY.WARN,
          expected: `carried-over ${kind} tag (unidentified baseline id) verified on candidate`,
          actual: candidateIds.size > 0
            ? `candidate has ${candidateIds.size} ${kind} id(s) but baseline id was null — verify manually`
            : `no ${kind} tag on candidate`,
          evidence: { kind, id: null, baseline: baselineIds, candidate: [...candidateIds] },
        }));
      } else {
        const present = candidateIds.has(id);
        assertions.push(parityAssertion({
          id: `analytics-parity:carryover:${kind}:${id}`,
          status: present ? STATUS.PASS : STATUS.WARN,
          severity: present ? undefined : SEVERITY.WARN,
          expected: `carried-over ${kind} tag ${id} still fires on candidate`,
          actual: present ? "present" : "absent on candidate",
          evidence: { kind, id, baseline: baselineIds, candidate: [...candidateIds] },
        }));
      }
    }
  }

  return assertions;
}
