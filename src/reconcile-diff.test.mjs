import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OUTCOME,
  VERDICT,
  canonicalJson,
  createReconciliationReport,
  projectReportForSidecar,
} from "./reconcile-diff.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/reconcile/${name}`, import.meta.url), "utf8"));

const clone = (value) => JSON.parse(JSON.stringify(value));
const spec = () => fixture("desired-campaignspec.json");
const observed = () => ({
  campaign: fixture("observed-campaign-1602-retrieve.json"),
  packages: fixture("observed-campaign-1602-packages.json"),
  products: fixture("observed-products-by-sku-tacslingbag.json"),
  gatewayGroups: fixture("observed-gateway-groups-list.json"),
});
const report = (s = spec(), o = observed()) =>
  createReconciliationReport(s, o, { matrixHash: "sha256:test-matrix" });

const rowFor = (result, scope, field) =>
  result.rows.find((row) => row.scope === scope && row.field === field);

test("the recorded contract run reconciles clean against its own spec", () => {
  const result = report();
  assert.equal(result.outcome, OUTCOME.CLEAN);
  assert.equal(result.exception_count, 0);
  assert.equal(result.coverage_complete, true);
});

// --- one seeded difference per verdict class -------------------------------

test("changed: a drifted package price lands on the exact field", () => {
  const observedState = observed();
  observedState.packages.results.find((p) => p.id === 3).prices[0].price = "44.99";
  const result = report(spec(), observedState);
  assert.equal(result.outcome, OUTCOME.DIFFERENCES);
  const row = rowFor(result, "package[3]", "price");
  assert.equal(row.verdict, VERDICT.CHANGED);
  assert.equal(row.desired, "49.99");
  assert.equal(row.observed, "44.99");
});

test("changed: a removed payment method is caught as a set difference", () => {
  const observedState = observed();
  observedState.campaign.available_payment_methods =
    observedState.campaign.available_payment_methods.filter((m) => m.code !== "google_pay");
  const result = report(spec(), observedState);
  assert.equal(rowFor(result, "campaign", "available_payment_methods").verdict, VERDICT.CHANGED);
});

test("missing_live: an asserted currency absent from prices[] fails only that currency", () => {
  const observedState = observed();
  observedState.packages.results.find((p) => p.id === 1).prices = [];
  const result = report(spec(), observedState);
  const row = rowFor(result, "package[1]", "price");
  assert.equal(row.verdict, VERDICT.MISSING_LIVE);
  assert.equal(row.desired, "79.98");
  // the rest of the package still compared
  assert.equal(rowFor(result, "package[1]", "name").verdict, VERDICT.MATCHED);
});

test("unresolved_binding: a missing live package yields one row, not a field cascade", () => {
  const observedState = observed();
  observedState.packages.results = observedState.packages.results.filter((p) => p.id !== 2);
  const result = report(spec(), observedState);
  const rows = result.rows.filter((row) => row.scope === "package[2]");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, VERDICT.UNRESOLVED_BINDING);
  assert.equal(result.coverage_complete, false, "an unresolved binding must break coverage");
});

test("extra_live: a live package the spec never asserted is reported", () => {
  const observedState = observed();
  observedState.packages.results.push({
    id: 99, name: "Surprise", prices: [{ currency: "USD", price: "1.00" }],
    is_recurring: false, product_sku: "EXAMPLE-GB-SURPRISE01",
  });
  const result = report(spec(), observedState);
  const row = rowFor(result, "package[live:99]", "binding");
  assert.equal(row.verdict, VERDICT.EXTRA_LIVE);
});

test("unsupported: quantity and offers are accounted, never missing_live", () => {
  const result = report();
  const qty = rowFor(result, "package[1]", "qty");
  assert.equal(qty.verdict, VERDICT.UNSUPPORTED);
  assert.equal(rowFor(result, "campaign", "offers").verdict, VERDICT.UNSUPPORTED);
  assert.equal(rowFor(result, "campaign", "offers").asserted_count, 7);
  assert.equal(rowFor(result, "campaign", "campaign_shipping_methods").asserted_count, 2);
  const unsupported = result.rows.filter((row) => row.verdict === VERDICT.UNSUPPORTED);
  assert.ok(unsupported.every((row) => row.verdict !== VERDICT.MISSING_LIVE));
});

test("not_asserted: gateway group is recorded as evidence but never judged", () => {
  const result = report();
  const row = rowFor(result, "campaign", "payment_gateway_group");
  assert.equal(row.verdict, VERDICT.NOT_ASSERTED);
  assert.deepEqual(row.observed, { id: 1, name: "Default" });
  assert.equal(result.exceptions.some((e) => e.field === "payment_gateway_group"), false);
});

// --- the traps the wire actually sets --------------------------------------

test("a one-time package is never called recurring just because interval is populated", () => {
  const result = report();
  for (const ref of ["1", "2", "3", "4"]) {
    assert.equal(rowFor(result, `package[${ref}]`, "is_recurring").verdict, VERDICT.MATCHED);
  }
});

test("every price row is labelled pre-Offer so matched is not read as effective price", () => {
  const result = report();
  const priceRows = result.rows.filter((row) => row.field === "price");
  assert.ok(priceRows.length > 0);
  assert.ok(priceRows.every((row) => row.basis === "pre_offer"));
  assert.equal(result.price_basis, "pre_offer");
  assert.equal(result.offers_affect_price, true);
});

test("partial input is inconclusive, never a set of differences", () => {
  const result = createReconciliationReport(spec(), { campaign: observed().campaign }, {});
  assert.equal(result.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(result.partial_input, true);
  assert.ok(!result.rows.some((row) => row.verdict === VERDICT.MISSING_LIVE && row.scope === "package[1]"));
});

test("an unread second page is inconclusive rather than a pile of missing packages", () => {
  const observedState = observed();
  observedState.packages.next = "https://example.com/api/admin/campaigns/1602/packages/?page=2";
  const result = report(spec(), observedState);
  assert.equal(result.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(result.coverage_complete, false);
});

// --- report envelope --------------------------------------------------------

test("the sidecar projection carries verdicts but no observed or desired values", () => {
  const sidecar = projectReportForSidecar(report());
  const serialized = JSON.stringify(sidecar);
  assert.ok(!serialized.includes("79.98"));
  assert.ok(!serialized.includes("Example Go-Bag Gear Stack"));
  assert.ok(!serialized.includes("api_key"));
  assert.ok(sidecar.rows.every((row) => Object.keys(row).sort().join(",") === "field,scope,verdict"));
  assert.equal(sidecar.exception_count, 0);
});

test("spec, snapshot, and matrix hashes pin every verdict to its contract", () => {
  const result = report();
  assert.match(result.spec_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.snapshot_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.matrix_hash, "sha256:test-matrix");
});

test("canonical JSON is key-order independent, so hashes are stable", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test("same inputs twice produce a byte-identical report", () => {
  const first = report();
  const second = report();
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test("coverage counts accounted rows separately from compared rows", () => {
  const result = report();
  assert.ok(result.accounted_row_count > 0, "unsupported/not_asserted rows must be counted");
  assert.ok(result.compared_row_count > 0);
  // Accounted rows never reduce coverage.
  assert.equal(result.coverage_complete, true);
});

test("a spec asserting nothing still reports rather than silently passing", () => {
  const result = createReconciliationReport({ campaign: {} }, observed(), {});
  const extras = result.rows.filter((row) => row.verdict === VERDICT.EXTRA_LIVE);
  assert.equal(extras.length, 4, "all four live packages are unasserted extras");
});
