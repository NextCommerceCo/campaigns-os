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
  if (actual === null || actual === undefined || actual === "") return false;
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - Number(expected)) <= MONEY_EPSILON;
}

// Money strings must be plain decimals ("45.00"): Number() alone would also
// coerce hex/exponent forms ("0x2d" → 45), which no real order readback emits
// — treat those as unparseable rather than silently equal.
const DECIMAL_MONEY_PATTERN = /^-?\d+(\.\d+)?$/;

function lineValue(line, priceField) {
  const candidate = line?.[priceField];
  if (candidate === null || candidate === undefined || candidate === "") return null;
  if (typeof candidate === "string" && !DECIMAL_MONEY_PATTERN.test(candidate.trim())) return null;
  const value = Number(candidate);
  return Number.isFinite(value) ? value : null;
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
    // Persisted lines append the variant to the product title
    // ("Example Accessory - Blue / S"), so the fixture's product title
    // matches exact-or-prefix; quantity + is_upsell stay exact.
    const titleMatches = title === expectedTitle || title.startsWith(`${expectedTitle} -`);
    return titleMatches
      && Number(line?.quantity || 0) === Number(expectedLine.quantity)
      && Boolean(line?.is_upsell) === Boolean(expectedLine.is_upsell);
  });
}

function assessPersistedLine(scenario, order) {
  const expectedLine = scenario.expected_order_readback?.line_item || {};
  const matches = matchingPersistedLines(order, expectedLine);
  const values = matches.map((line) => lineValue(line, expectedLine.price_field));
  const declaredFieldAbsent = matches.length > 0
    && matches.every((line) => line?.[expectedLine.price_field] === null
      || line?.[expectedLine.price_field] === undefined
      || line?.[expectedLine.price_field] === "");
  const expectedRoute = scenario.upsell_route || scenario.expected_upsell_path || null;
  const observedRoute = observedUpsellRoute(order, expectedRoute);
  const routeMatches = !observedRoute || routePathMatches(observedRoute, expectedRoute);
  const ok = values.length > 0
    && !declaredFieldAbsent
    && routeMatches
    && values.every((value) => moneyEqual(value, expectedLine.expected_line_total));
  return parityAssertion({
    id: `parity-capture:${scenario.scenario_id}:persisted-line`,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: `persisted ${expectedLine.is_upsell ? "upsell" : "order"} line total ${expectedLine.expected_line_total} ${scenario.currency}`,
    actual: !matches.length
      ? "matching persisted order line absent"
      : declaredFieldAbsent
        ? `declared price field ${expectedLine.price_field} was absent from matching persisted evidence`
        : !routeMatches
          ? `persisted line observed after unexpected offer page ${observedRoute}; expected ${expectedRoute}`
          : `matching persisted ${expectedLine.price_field} total(s): ${values.map((value, index) => (
            value ?? `unparseable(${JSON.stringify(matches[index]?.[expectedLine.price_field] ?? null)})`
          )).join(", ")}`,
    evidence: {
      source: Array.isArray(order?.final_receipt_line_items)
        ? "final_receipt_line_items"
        : "receipt_line_items",
      expected_title: expectedLine.title || null,
      expected_quantity: expectedLine.quantity ?? null,
      expected_is_upsell: expectedLine.is_upsell ?? null,
      expected_line_total: expectedLine.expected_line_total ?? null,
      declared_price_field: expectedLine.price_field || null,
      declared_price_field_absent: declaredFieldAbsent,
      observed_line_totals: values,
      expected_upsell_route: expectedRoute,
      observed_upsell_route: observedRoute,
      upsell_route_matches: routeMatches,
      persisted_order_total_incl_tax: order?.verification?.total_incl_tax ?? null,
      persisted_order_currency: order?.verification?.currency ?? null,
    },
  });
}

function observedUpsellRoute(order, expectedRoute) {
  const explicit = [
    ...(Array.isArray(order?.evidence?.upsell_page_urls) ? order.evidence.upsell_page_urls : []),
    order?.evidence?.upsell_page_url,
    ...(Array.isArray(order?.upsell_steps) ? order.upsell_steps.map((step) => step?.offer_url) : []),
    order?.upsell?.offer_url,
  ].find((value) => typeof value === "string" && value.trim());
  if (explicit) return explicit;
  const finalUrl = typeof order?.final_url === "string" ? order.final_url : null;
  if (!finalUrl || !expectedRoute) return null;
  try {
    const path = new URL(finalUrl, "https://parity.invalid/").pathname;
    return /(?:oto|upsell)/i.test(path) ? finalUrl : null;
  } catch {
    return null;
  }
}

function routePathMatches(observed, expected) {
  if (!expected) return true;
  // Hosts may serve pretty URLs ("/campaign/oto-accessory") for fixture
  // routes authored as files ("oto-snatch-thong.html"), and the observed URL
  // carries the deploy prefix — so compare .html-stripped paths suffix-wise.
  const normalize = (value) => {
    const path = new URL(value, "https://parity.invalid/").pathname
      .replace(/\/+$/, "")
      .replace(/\.html$/i, "");
    return path.startsWith("/") ? path : `/${path}`;
  };
  try {
    const observedPath = normalize(observed);
    const expectedPath = normalize(expected);
    return observedPath === expectedPath || observedPath.endsWith(expectedPath);
  } catch {
    return false;
  }
}

function assessPurchase(scenario, capture) {
  const expected = scenario.expected_purchase || {};
  const effective = effectivePurchase(capture);
  const eventPresent = (capture.eventNames || []).includes(expected.event);
  // The scenario names WHICH purchase-shaped event carries the offer's value:
  // an upsell scenario checks dl_upsell_purchase, a main-order scenario
  // dl_purchase. Values are read per-event so the whole-cart main purchase
  // never masks or pollutes the offer-level expectation.
  const observed = (capture.purchasesByEvent || {})[expected.event]
    || (expected.event === "dl_purchase" && capture.purchase?.present ? capture.purchase : null);
  // expected.value null = "a finite client value must be present" without
  // pinning the amount (a scenario that doesn't pin the checkout cart can't
  // honestly pin the main-order purchase value; the offer amount is proven by
  // the persisted-line check instead).
  const valueOk = observed !== null && (expected.value === null
    ? Number.isFinite(Number(observed.value))
    : moneyEqual(observed.value, expected.value));
  const ok = eventPresent
    && valueOk
    && observed.currency === expected.currency;
  return parityAssertion({
    id: `parity-capture:${scenario.scenario_id}:purchase-value`,
    status: ok ? STATUS.PASS : STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
    expected: `${expected.event} client-fired value ${expected.value} ${expected.currency}`,
    actual: eventPresent
      ? `${observed?.value ?? "missing"} ${observed?.currency || "missing"} (${expected.event})`
      : `${expected.event} absent`,
    evidence: {
      event_present: eventPresent,
      observed_events: capture.eventNames || [],
      observed_purchase_events: Object.keys(capture.purchasesByEvent || {}),
      purchase_via: effective.via,
      client_value: observed?.value ?? null,
      client_currency: observed?.currency ?? null,
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

  // Unexpected extra upsell lines are surfaced for review: the blocking check
  // scopes to the declared offer line, so a stray persisted upsell charge
  // would otherwise ride along invisibly.
  const expectedLine = scenario.expected_order_readback?.line_item || {};
  const matched = new Set(matchingPersistedLines(order || {}, expectedLine));
  const strayUpsells = persistedLines(order || {}).filter((line) => line?.is_upsell && !matched.has(line));
  if (strayUpsells.length) {
    assertions.push(parityAssertion({
      id: `parity-capture:${scenario.scenario_id}:unexpected-upsell-lines`,
      status: STATUS.MANUAL_REVIEW,
      severity: SEVERITY.WARN,
      expected: "no persisted upsell lines beyond the scenario's declared offer",
      actual: `${strayUpsells.length} unmatched persisted upsell line(s)`,
      evidence: {
        unmatched_upsell_lines: strayUpsells.map((line) => ({
          title: line?.title || line?.name || null,
          quantity: line?.quantity ?? null,
          // Stable keys regardless of the scenario's declared price_field, so a
          // consumer can read the value without knowing which field was declared
          // (avoids an inconsistent computed JSON key across scenarios).
          declared_price_field: expectedLine.price_field || "price",
          declared_price_field_value: line?.[expectedLine.price_field || "price"] ?? null,
        })),
      },
    }));
  }

  const correctness = assessAnalyticsCorrectness(
    candidate,
    fixture.analytics_contract || {},
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
        ...(index === 0 && scenario.upsell_route
          ? { url: new URL(scenario.upsell_route, `${baseUrl.replace(/\/+$/, "")}/`).toString() }
          : {}),
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

export const __qaParityCaptureTestHooks = Object.freeze({ scenarioTopology });
