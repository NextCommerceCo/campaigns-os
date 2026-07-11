// Fixture-driven parity capture. The assessment core deliberately has no
// browser dependency: saved order/capture evidence can be replayed for
// regression tests and negative controls without touching a live campaign.

import { assessAnalyticsCorrectness } from "./qa-analytics-correctness.mjs";
import {
  diffAnalyticsParity,
  effectivePurchase,
  normalizeCapture,
} from "./qa-analytics-parity.mjs";
import { captureAnalyticsForUrls, runBrowserTestOrders } from "./qa-browser.mjs";
import { SEVERITY, STATUS } from "./qa-verdict.mjs";

const MONEY_EPSILON = 0.005;

function parityAssertion({ id, status, severity, expected, actual, evidence }) {
  return {
    id,
    family: "parity-capture",
    page: "parity",
    status,
    ...(severity ? { severity } : {}),
    expected,
    actual,
    ...(evidence ? { evidence } : {}),
  };
}

function normalizedCapture(capture) {
  if (!capture || typeof capture !== "object") return normalizeCapture();
  if (Array.isArray(capture.eventNames) && capture.inventory) return capture;
  return normalizeCapture(capture);
}

function moneyEqual(actual, expected) {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - Number(expected)) <= MONEY_EPSILON;
}

function lineValue(line, priceField) {
  const candidates = [line?.[priceField], line?.price, line?.line_total, line?.total];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function persistedLines(order) {
  if (Array.isArray(order?.final_receipt_line_items)) {
    return order.final_receipt_line_items;
  }
  return Array.isArray(order?.receipt_line_items) ? order.receipt_line_items : [];
}

function matchingPersistedLines(order, expectedLine) {
  const expectedTitle = String(expectedLine.title || "").trim().toLowerCase();
  return persistedLines(order).filter((line) => {
    const title = String(line?.title || line?.name || "").trim().toLowerCase();
    return title === expectedTitle
      && Number(line?.quantity || 0) === Number(expectedLine.quantity)
      && Boolean(line?.is_upsell) === Boolean(expectedLine.is_upsell);
  });
}

function analyticsContract(expectedAnalytics = {}) {
  const inventory = expectedAnalytics.candidate_inventory || {};
  const providers = {};
  const outOfBand = [];

  for (const [rawKind, rawIds] of Object.entries(inventory)) {
    const ids = Array.isArray(rawIds) ? rawIds.filter(Boolean).map(String) : [];
    if (!ids.length) continue;
    const kind = rawKind === "facebook" ? "meta" : rawKind;
    if (kind === "gtm") {
      providers.gtm = { enabled: true, containerId: ids[0] };
      for (const id of ids.slice(1)) outOfBand.push({ vendor: "gtm", id });
    } else if (kind === "meta") {
      providers.facebook = { enabled: true, pixelId: ids[0] };
      for (const id of ids.slice(1)) outOfBand.push({ vendor: "meta", id });
    } else {
      for (const id of ids) outOfBand.push({ vendor: kind, id });
    }
  }

  return {
    providers,
    out_of_band_pixels: outOfBand,
    // Keeps the contract path active even for a purchase-only fixture.
    manual_events: expectedAnalytics.purchase_expected ? [expectedAnalytics.purchase_event] : [],
  };
}

function assessPersistedLine(scenario, order) {
  const expectedLine = scenario.expected_order_readback?.line_item || {};
  const matches = matchingPersistedLines(order, expectedLine);
  const values = matches.map((line) => lineValue(line, expectedLine.price_field));
  const ok = values.length > 0
    && values.every((value) => moneyEqual(value, expectedLine.expected_line_total));
  return parityAssertion({
    id: `parity-capture:${scenario.scenario_id}:persisted-line`,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: `persisted ${expectedLine.is_upsell ? "upsell" : "order"} line total ${expectedLine.expected_line_total} ${scenario.currency}`,
    actual: matches.length
      ? `matching persisted line total(s): ${values.map((value) => value ?? "missing").join(", ")}`
      : "matching persisted order line absent",
    evidence: {
      source: Array.isArray(order?.final_receipt_line_items)
        ? "final_receipt_line_items"
        : "receipt_line_items",
      expected_title: expectedLine.title || null,
      expected_quantity: expectedLine.quantity ?? null,
      expected_is_upsell: expectedLine.is_upsell ?? null,
      expected_line_total: expectedLine.expected_line_total ?? null,
      observed_line_totals: values,
      persisted_order_total_incl_tax: order?.verification?.total_incl_tax ?? null,
      persisted_order_currency: order?.verification?.currency ?? null,
    },
  });
}

function assessPurchase(scenario, capture) {
  const expected = scenario.expected_purchase || {};
  const effective = effectivePurchase(capture);
  const eventPresent = (capture.eventNames || []).includes(expected.event);
  const ok = eventPresent
    && effective.via === "datalayer"
    && moneyEqual(effective.value, expected.value)
    && effective.currency === expected.currency;
  return parityAssertion({
    id: `parity-capture:${scenario.scenario_id}:purchase-value`,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: `${expected.event} client-fired value ${expected.value} ${expected.currency}`,
    actual: eventPresent
      ? `${effective.value ?? "missing"} ${effective.currency || "missing"} via ${effective.via || "none"}`
      : `${expected.event} absent`,
    evidence: {
      event_present: eventPresent,
      observed_events: capture.eventNames || [],
      purchase_via: effective.via,
      client_value: effective.value,
      client_currency: effective.currency,
      note: "client-fired purchase value only; never compared with backend total_incl_tax",
    },
  });
}

// Pure assessment core. The persisted order readback and the client analytics
// capture are independent proof legs; the paired summary only passes when both
// have no blocker failure.
export function assessParityCapture({ fixture, scenario, order, capture, baselineCapture = null }) {
  if (!fixture || !scenario) throw new Error("Parity assessment requires fixture and scenario data.");
  if (scenario.scenario_type !== "funnel_offer") {
    throw new Error(`Parity capture scenario ${scenario.scenario_id} must be a funnel_offer.`);
  }

  const candidate = normalizedCapture(capture);
  const assertions = [];
  const persisted = assessPersistedLine(scenario, order || {});
  const purchase = assessPurchase(scenario, candidate);
  assertions.push(persisted, purchase);

  const correctness = assessAnalyticsCorrectness(
    candidate,
    analyticsContract(fixture.expected_analytics),
  ).map((assertion) => ({ ...assertion, family: "parity-capture" }));
  assertions.push(...correctness);

  if (baselineCapture) {
    assertions.push(...diffAnalyticsParity(normalizedCapture(baselineCapture), candidate));
  }

  const orderBlocked = persisted.status === STATUS.FAIL && persisted.severity === SEVERITY.BLOCKER;
  const analyticsBlocked = assertions.some((assertion) => (
    assertion !== persisted
    && assertion.status === STATUS.FAIL
    && assertion.severity === SEVERITY.BLOCKER
  ));
  assertions.push(parityAssertion({
    id: `parity-capture:${scenario.scenario_id}:paired-summary`,
    status: !orderBlocked && !analyticsBlocked ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: "persisted order proof and analytics proof both pass without blocker failures",
    actual: `order=${orderBlocked ? "blocked" : "pass"}, analytics=${analyticsBlocked ? "blocked" : "pass"}`,
    evidence: { order_blocked: orderBlocked, analytics_blocked: analyticsBlocked },
  }));

  return assertions;
}

function scenarioCart(scenario, args) {
  if (args.cart) return String(args.cart);
  if (typeof scenario.cart === "string") return scenario.cart;
  if (!Array.isArray(scenario.cart)) return undefined;
  const parts = scenario.cart.map((item) => {
    const packageId = item?.package_id ?? item?.packageId ?? item?.ref_id;
    return packageId == null ? null : `${packageId}:${Number(item.quantity || 1)}`;
  }).filter(Boolean);
  return parts.length ? parts.join(",") : undefined;
}

function scenarioUrl(baseUrl, scenario) {
  const route = scenario.checkout_path || scenario.checkout_url || "";
  if (!route) return baseUrl;
  return new URL(route, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function scenarioTopology(baseUrl, scenario) {
  const checkoutUrl = scenarioUrl(baseUrl, scenario);
  const depth = String(scenario.funnel_path || "").split("-").filter((step) => step === "accept" || step === "decline").length;
  return [{
    topology_id: `parity-${scenario.scenario_id}`,
    pages: [
      { page_id: "checkout", page_type: "checkout", url: checkoutUrl },
      ...Array.from({ length: depth }, (_, index) => ({
        page_id: `offer-${index + 1}`,
        page_type: "upsell",
      })),
    ],
  }];
}

export function resolveParityScenario(fixture, scenarioId) {
  const matches = (fixture?.scenarios || []).filter((scenario) => (
    scenario.scenario_id === scenarioId || scenario.offer === scenarioId
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `Parity scenario selector "${scenarioId}" is ambiguous.`
      : `Parity scenario "${scenarioId}" was not found in the fixture.`);
  }
  return matches[0];
}

// Thin live driver: use the existing typed-card traversal/readback while the
// shared analytics hooks observe the candidate funnel; capture an optional
// baseline URL through the same browser helper.
export async function runParityCapture({ fixture, scenarioId, args = {} }) {
  const scenario = resolveParityScenario(fixture, scenarioId);
  const baseUrl = String(args["base-url"] || fixture.candidate_base_url || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Parity capture requires a candidate base URL.");

  const driverArgs = {
    ...args,
    "test-order": scenario.funnel_path,
    ...(scenarioCart(scenario, args) ? { cart: scenarioCart(scenario, args) } : {}),
  };
  const orderResult = await runBrowserTestOrders(
    scenarioTopology(baseUrl, scenario),
    driverArgs,
    args.run_id || "parity-capture",
    { captureAnalytics: true },
  );
  const order = orderResult.orders[0] || {};
  const baselineUrl = args.baseline || args["analytics-baseline"] || fixture.baseline_url || null;
  const captures = {
    candidate: orderResult.captures?.[0] || normalizeCapture(),
    ...(baselineUrl ? await captureAnalyticsForUrls({ baseline: baselineUrl }, driverArgs) : {}),
  };
  const assertions = [
    ...orderResult.assertions,
    ...assessParityCapture({
      fixture,
      scenario,
      order,
      capture: captures.candidate,
      baselineCapture: captures.baseline || null,
    }),
  ];
  return { assertions, orders: orderResult.orders, captures };
}
