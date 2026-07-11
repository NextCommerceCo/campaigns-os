import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { assessParityCapture, __qaParityCaptureTestHooks } from "./qa-parity-capture.mjs";
import { computeDisposition, SEVERITY, STATUS } from "./qa-verdict.mjs";

const fixture = {
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
