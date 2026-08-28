import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normalizeCodeSet,
  normalizeMoney,
  normalizePackage,
  normalizeSnapshot,
  unwrapEnvelope,
} from "./reconcile-normalize.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/reconcile/${name}`, import.meta.url), "utf8"));

const observed = () => ({
  campaign: fixture("observed-campaign-1602-retrieve.json"),
  packages: fixture("observed-campaign-1602-packages.json"),
  products: fixture("observed-products-by-sku-tacslingbag.json"),
  gatewayGroups: fixture("observed-gateway-groups-list.json"),
});

test("unwraps the paginated envelope every collection actually returns", () => {
  const unwrapped = unwrapEnvelope(fixture("observed-campaign-1602-packages.json"));
  assert.equal(unwrapped.results.length, 4);
  assert.equal(unwrapped.paginated, true);
  assert.equal(unwrapped.has_more, false);
});

test("reports has_more when a cursor is present, so callers cannot assume one page", () => {
  assert.equal(unwrapEnvelope({ next: "http://x/?page=2", results: [] }).has_more, true);
});

test("absorbs all three shapes of a country/method list", () => {
  assert.deepEqual(normalizeCodeSet(["US", "CA"]), ["CA", "US"]);
  assert.deepEqual(normalizeCodeSet([{ code: "US", name: "United States" }]), ["US"]);
  assert.deepEqual(normalizeCodeSet([{ code: "US", label: "United States" }]), ["US"]);
  assert.deepEqual(normalizeCodeSet("US,CA"), ["CA", "US"]);
});

test("compares money as an exact decimal string, never a float", () => {
  assert.equal(normalizeMoney("79.98"), "79.98");
  assert.equal(normalizeMoney("79.9"), "79.90");
  assert.equal(normalizeMoney("80"), "80.00");
  assert.equal(normalizeMoney("not money"), null);
  assert.equal(normalizeMoney(null), null);
});

test("keys package prices by currency and lifts a scalar price into the same shape", () => {
  const fromArray = normalizePackage({ id: 1, prices: [{ currency: "USD", price: "10.5" }] });
  assert.equal(fromArray.prices.USD.price, "10.50");
  const fromScalar = normalizePackage({ id: 2, price: "10.5" });
  assert.equal(fromScalar.prices["*"].price, "10.50");
});

test("keeps interval out of comparable position because it lies when is_recurring is false", () => {
  const snapshot = normalizeSnapshot(observed());
  const [first] = snapshot.packages;
  assert.equal(first.is_recurring, false);
  assert.equal(first.evidence.interval, "month");
  assert.ok(!("interval" in first), "interval must not sit alongside comparable fields");
});

test("drops api_key at the normalization boundary so nothing downstream can emit it", () => {
  const snapshot = normalizeSnapshot(observed());
  assert.ok(!JSON.stringify(snapshot).includes("api_key"));
  assert.ok(!JSON.stringify(snapshot).includes("cmp_pk_"));
});

test("marks a snapshot partial when a resource is absent rather than inventing absence", () => {
  const snapshot = normalizeSnapshot({ campaign: fixture("observed-campaign-1602-retrieve.json") });
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.missing_resources, ["packages"]);
});
