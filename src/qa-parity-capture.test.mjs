import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { assessParityCapture, __qaParityCaptureTestHooks } from "./qa-parity-capture.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const fixture = {
  analytics_contract: {
    mode: "auto",
    providers: {
      gtm: { enabled: true, containerId: "GTM-TEST123" },
    },
    manual_events: [
      { event: "dl_purchase", page: "upsell-1", trigger: "page-load" },
    ],
  },
  expected_analytics: {
    purchase_event: "dl_purchase",
    purchase_expected: true,
    candidate_inventory: { gtm: ["GTM-TEST123"] },
  },
};

const scenario = {
  scenario_id: "fixture-offer",
  scenario_type: "funnel_offer",
  currency: "USD",
  upsell_route: "oto-fixture.html",
  expected_order_readback: {
    line_item: {
      title: "Fixture Upsell",
      quantity: 2,
      is_upsell: true,
      price_field: "price_incl_tax",
      expected_line_total: 45,
    },
  },
  expected_purchase: { event: "dl_purchase", value: 45, currency: "USD" },
};

function order(lineTotal = 45) {
  return {
    receipt_line_items: [{
      ref_id: "fixture-line",
      title: "Fixture Upsell",
      quantity: 2,
      is_upsell: true,
      price_incl_tax: lineTotal,
    }],
    verification: { total_incl_tax: 51.5, currency: "USD" },
  };
}

function capture({ value = 45, currency = "USD", purchase = true, gtm = true } = {}) {
  return normalizeCapture({
    events: purchase ? [{
      layer: "dataLayer",
      data: { event: "dl_purchase", ecommerce: { value, currency, transaction_id: "fixture-order" } },
    }] : [],
    tagFires: gtm
      ? [{ kind: "gtm", id: "GTM-TEST123", host: "googletagmanager.com", params: {} }]
      : [],
  });
}

const byId = (assertions) => Object.fromEntries(assertions.map((assertion) => [assertion.id, assertion]));
const blockerFailures = (assertions) => assertions.filter((assertion) => (
  assertion.status === STATUS.FAIL && assertion.severity === SEVERITY.BLOCKER
));

test("known-good persisted voucher total + purchase + GTM has no blocker failures", () => {
  const assertions = assessParityCapture({ fixture, scenario, order: order(), capture: capture() });
  assert.deepEqual(blockerFailures(assertions), []);
  assert.ok(["ready", "ready_with_exceptions"].includes(computeDisposition(assertions)));
  assert.equal(byId(assertions)["parity-capture:fixture-offer:paired-summary"].status, STATUS.PASS);
});

test("negative control: dropped voucher persisted at base total blocks", () => {
  const assertions = assessParityCapture({
    fixture,
    scenario,
    order: { ...order(90), voucher_code: null },
    capture: capture(),
  });
  const persisted = byId(assertions)["parity-capture:fixture-offer:persisted-line"];
  assert.equal(persisted.status, STATUS.FAIL);
  assert.equal(persisted.severity, SEVERITY.BLOCKER);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("derived price cannot substitute for an absent declared persisted field", () => {
  const missingDeclaredField = order();
  delete missingDeclaredField.receipt_line_items[0].price_incl_tax;
  missingDeclaredField.receipt_line_items[0].price = 45;

  const assertions = assessParityCapture({ fixture, scenario, order: missingDeclaredField, capture: capture() });
  const persisted = byId(assertions)["parity-capture:fixture-offer:persisted-line"];
  assert.equal(persisted.status, STATUS.FAIL);
  assert.equal(persisted.severity, SEVERITY.BLOCKER);
  assert.match(persisted.actual, /declared price field price_incl_tax was absent/);
});

test("declared persisted price field remains authoritative", () => {
  const assertions = assessParityCapture({ fixture, scenario, order: order(45), capture: capture() });
  assert.equal(byId(assertions)["parity-capture:fixture-offer:persisted-line"].status, STATUS.PASS);
});

test("offer page mismatch blocks persisted-line proof when route evidence is present", () => {
  const assertions = assessParityCapture({
    fixture,
    scenario,
    order: { ...order(), evidence: { upsell_page_url: "https://example.test/other-oto.html" } },
    capture: capture(),
  });
  const persisted = byId(assertions)["parity-capture:fixture-offer:persisted-line"];
  assert.equal(persisted.status, STATUS.FAIL);
  assert.match(persisted.actual, /unexpected offer page/);
});

test("offer-looking final URL mismatch blocks persisted-line proof", () => {
  const assertions = assessParityCapture({
    fixture,
    scenario,
    order: { ...order(), final_url: "https://example.test/wrong-oto.html" },
    capture: capture(),
  });
  assert.equal(byId(assertions)["parity-capture:fixture-offer:persisted-line"].status, STATUS.FAIL);
});

test("scenario topology carries distinct checkout and first-offer URLs", () => {
  const { scenarioTopology } = __qaParityCaptureTestHooks;
  const root = scenarioTopology("https://example.test", {
    ...scenario,
    scenario_id: "root",
    checkout_path: "checkout.html",
    upsell_route: "oto-thong.html",
    funnel_path: "accept",
  });
  const v1 = scenarioTopology("https://example.test", {
    ...scenario,
    scenario_id: "v1",
    checkout_path: "v1/checkout.html",
    upsell_route: "v1/oto-bodysuit.html",
    funnel_path: "accept",
  });

  assert.deepEqual(root[0].pages.map((page) => page.url), [
    "https://example.test/checkout.html",
    "https://example.test/oto-thong.html",
  ]);
  assert.deepEqual(v1[0].pages.map((page) => page.url), [
    "https://example.test/v1/checkout.html",
    "https://example.test/v1/oto-bodysuit.html",
  ]);
  assert.notDeepEqual(root[0].pages, v1[0].pages);
});

test("parity selects the aligned whole-journey capture even when receipt topology is unrecognized", () => {
  const { parityJourneyAttempt } = __qaParityCaptureTestHooks;
  const journey = capture();
  const selected = parityJourneyAttempt({
    journeyAnalytics: {
      plannedPlanIds: ["accept"],
      attempts: [{ planId: "accept", capture: journey }],
    },
    receiptAnalytics: {
      plannedPlanIds: ["accept"],
      attempts: [{ planId: "accept", receiptRecognized: false }],
    },
  }, "accept");

  assert.equal(selected.capture, journey);
  assert.equal(selected.planId, "accept");
});

test("parity capture failures expose only a stable code and message", () => {
  const { parityCaptureFailureAssertion } = __qaParityCaptureTestHooks;
  const assertion = parityCaptureFailureAssertion(
    { scenario_id: "fixture-offer", funnel_path: "accept" },
    {
      planId: "accept",
      captureError: {
        code: "analytics_capture_unreadable",
        message: "analytics capture could not be read from the settled page",
        raw: "page.evaluate failed at https://shop.example/receipt/?ref_id=secret",
      },
    },
  );

  assert.equal(assertion.actual, "analytics capture could not be read from the settled page");
  assert.deepEqual(assertion.evidence, {
    plan_id: "accept",
    error_code: "analytics_capture_unreadable",
  });
  assert.doesNotMatch(JSON.stringify(assertion), /page\.evaluate|shop\.example|ref_id|secret/);
});

test("missing dl_purchase blocks the analytics leg", () => {
  const assertions = assessParityCapture({ fixture, scenario, order: order(), capture: capture({ purchase: false }) });
  const purchase = byId(assertions)["parity-capture:fixture-offer:purchase-value"];
  assert.equal(purchase.status, STATUS.FAIL);
  assert.equal(purchase.severity, SEVERITY.BLOCKER);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("wrong purchase currency blocks", () => {
  const assertions = assessParityCapture({ fixture, scenario, order: order(), capture: capture({ currency: "CAD" }) });
  assert.equal(byId(assertions)["parity-capture:fixture-offer:purchase-value"].status, STATUS.FAIL);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("missing declared GTM container uses correctness contract and blocks", () => {
  const assertions = assessParityCapture({ fixture, scenario, order: order(), capture: capture({ gtm: false }) });
  const inventory = byId(assertions)["analytics-correctness:tag:gtm"];
  assert.equal(inventory.family, "parity-capture");
  assert.equal(inventory.status, STATUS.FAIL);
  assert.equal(inventory.severity, SEVERITY.BLOCKER);
  assert.equal(computeDisposition(assertions), "blocked");
});

test("baseline capture reuses analytics parity diff", () => {
  const assertions = assessParityCapture({
    fixture,
    scenario,
    order: order(),
    capture: capture(),
    baselineCapture: capture(),
  });
  const parity = byId(assertions)["analytics-parity:purchase-value"];
  assert.equal(parity.family, "analytics-parity");
  assert.equal(parity.status, STATUS.PASS);
});

test("persisted-line cents tolerance accepts 45.004 and rejects 45.01", () => {
  const edgePass = assessParityCapture({ fixture, scenario, order: order(45.004), capture: capture() });
  assert.equal(byId(edgePass)["parity-capture:fixture-offer:persisted-line"].status, STATUS.PASS);

  const edgeFail = assessParityCapture({ fixture, scenario, order: order(45.01), capture: capture() });
  assert.equal(byId(edgeFail)["parity-capture:fixture-offer:persisted-line"].status, STATUS.FAIL);
});

test("non-decimal money strings never coerce to a passing value", () => {
  // Number("0x2d") === 45; a hex-string price must read as unparseable, not 45.
  const assertions = assessParityCapture({ fixture, scenario, order: order("0x2d"), capture: capture() });
  const persisted = byId(assertions)["parity-capture:fixture-offer:persisted-line"];
  assert.equal(persisted.status, STATUS.FAIL);
  assert.equal(computeDisposition(assertions), "blocked");

  const decimalString = assessParityCapture({ fixture, scenario, order: order("45.00"), capture: capture() });
  assert.equal(byId(decimalString)["parity-capture:fixture-offer:persisted-line"].status, STATUS.PASS);
});

test("stray persisted upsell lines surface a manual-review warning", () => {
  const withStray = order();
  withStray.receipt_line_items.push({
    ref_id: "stray-line",
    title: "Upsell Adjustment",
    quantity: 1,
    is_upsell: true,
    price_incl_tax: 45,
  });
  const assertions = assessParityCapture({ fixture, scenario, order: withStray, capture: capture() });
  const stray = byId(assertions)["parity-capture:fixture-offer:unexpected-upsell-lines"];
  assert.equal(stray.status, STATUS.MANUAL_REVIEW);
  assert.equal(stray.severity, SEVERITY.WARN);
  // Review-grade, not blocking: the declared-line proof still decides the gate.
  assert.equal(byId(assertions)["parity-capture:fixture-offer:paired-summary"].status, STATUS.PASS);
});

test("hex/exponent purchase values are unparseable, not silently equal", () => {
  for (const value of ["0x2d", "4.5e1", "0b101101"]) {
    const assertions = assessParityCapture({ fixture, scenario, order: order(), capture: capture({ value }) });
    const purchase = byId(assertions)["parity-capture:fixture-offer:purchase-value"];
    assert.equal(purchase.status, STATUS.FAIL, value);
    assert.equal(purchase.severity, SEVERITY.BLOCKER, value);
  }

  const plain = assessParityCapture({ fixture, scenario, order: order(), capture: capture({ value: "45.00" }) });
  assert.equal(byId(plain)["parity-capture:fixture-offer:purchase-value"].status, STATUS.PASS);
});

test("an unpinned expected purchase value still rejects non-decimal client values", () => {
  const unpinned = { ...scenario, expected_purchase: { event: "dl_purchase", value: null, currency: "USD" } };
  const hex = assessParityCapture({ fixture, scenario: unpinned, order: order(), capture: capture({ value: "0x2d" }) });
  assert.equal(byId(hex)["parity-capture:fixture-offer:purchase-value"].status, STATUS.FAIL);

  const plain = assessParityCapture({ fixture, scenario: unpinned, order: order(), capture: capture({ value: "45.00" }) });
  assert.equal(byId(plain)["parity-capture:fixture-offer:purchase-value"].status, STATUS.PASS);
});

test("a fixture-supplied cross-origin baseline does not carry the candidate preview credential", () => {
  const { baselineCaptureArgs } = __qaParityCaptureTestHooks;
  const args = { "auth-cookie": "session=preview-secret", viewport: "1280x800" };
  const candidateBaseUrl = "https://preview.example.test/campaign";

  const hostile = baselineCaptureArgs(args, {
    baselineUrl: "https://attacker.example/collect",
    operatorBaseline: null,
    candidateBaseUrl,
  });
  assert.equal(Object.hasOwn(hostile, "auth-cookie"), false);
  assert.equal(hostile.viewport, "1280x800");

  const sameHost = baselineCaptureArgs(args, {
    baselineUrl: "https://preview.example.test/legacy",
    operatorBaseline: null,
    candidateBaseUrl,
  });
  assert.equal(sameHost["auth-cookie"], "session=preview-secret");

  const operatorNamed = baselineCaptureArgs(args, {
    baselineUrl: "https://legacy.example.test/campaign",
    operatorBaseline: "https://legacy.example.test/campaign",
    candidateBaseUrl,
  });
  assert.equal(operatorNamed["auth-cookie"], "session=preview-secret");
});

test("non-money types are unparseable rather than coerced into a passing value", () => {
  for (const value of [true, [45], ["45"], { valueOf: () => 45 }]) {
    const assertions = assessParityCapture({ fixture, scenario, order: order(value), capture: capture() });
    const persisted = byId(assertions)["parity-capture:fixture-offer:persisted-line"];
    assert.equal(persisted.status, STATUS.FAIL, JSON.stringify(value));
    assert.equal(persisted.severity, SEVERITY.BLOCKER, JSON.stringify(value));
  }
});

test("an unreadable expectation cannot be satisfied by any observation", () => {
  const unreadable = {
    ...scenario,
    expected_order_readback: {
      line_item: { ...scenario.expected_order_readback.line_item, expected_line_total: "0x2d" },
    },
  };
  const assertions = assessParityCapture({ fixture, scenario: unreadable, order: order(45), capture: capture() });
  assert.equal(byId(assertions)["parity-capture:fixture-offer:persisted-line"].status, STATUS.FAIL);
});
