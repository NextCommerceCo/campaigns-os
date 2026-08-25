// QA topology edge resolution (#230).
//
// extractTopologies is one of the three call sites unified onto the shared
// resolver, and it was the only one with no test at all: hard-wiring both
// expected_next_url and expected_decline_url to null left the entire suite
// green. That is not merely a coverage gap — checkout.expected_next_url is
// handed to createTestOrder as the live success_url on a real order POST, so
// the one field that reaches the order API was the one nothing asserted on.

import test from "node:test";
import assert from "node:assert/strict";
import { __qaNodeTestHooks } from "./qa-node.mjs";

const { extractTopologies } = __qaNodeTestHooks;

const BASE = "https://shop.example.test/campaign/";

function topologyFor(pages) {
  const [topology] = extractTopologies(
    { funnels: [{ id: "f", name: "F", weight: 100, pages }] },
    { baseUrl: BASE, publicRouteSlug: "campaign" },
  );
  return Object.fromEntries(topology.pages.map((page) => [page.page_id, page]));
}

test("a checkout routing through next_page gets a forward URL", () => {
  // The twelve-page case, at the QA layer: before the shared resolver this read
  // `next_page || success_url`, so it happened to work here while build-time
  // wiring dropped it. Both now answer identically.
  const byId = topologyFor([
    { id: "checkout", type: "checkout", next_page: "upsell", page_url: "checkout/" },
    { id: "upsell", type: "upsell", on_accept: "receipt", on_decline: "receipt", page_url: "upsell/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ]);
  assert.equal(byId.checkout.expected_next_url, `${BASE}upsell/`);
});

test("a checkout routing through success_url is unchanged", () => {
  const byId = topologyFor([
    { id: "checkout", type: "checkout", success_url: "receipt", page_url: "checkout/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ]);
  assert.match(byId.checkout.expected_next_url, /\/campaign\/receipt\/$/);
});

test("forward precedence at the QA layer matches build-time wiring", () => {
  // A page declaring several forward fields must resolve the SAME way here as
  // in source intake, or the QA expectation contradicts the built page.
  const byId = topologyFor([
    { id: "p", type: "upsell", on_accept: "a", success_url: "s", next_page: "n", page_url: "p/" },
    { id: "a", type: "upsell", page_url: "a/" },
    { id: "s", type: "upsell", page_url: "s/" },
    { id: "n", type: "upsell", page_url: "n/" },
  ]);
  assert.match(byId.p.expected_next_url, /\/campaign\/a\/$/);
});

test("accept and decline branches resolve independently", () => {
  const byId = topologyFor([
    { id: "upsell", type: "upsell", on_accept: "receipt", on_decline: "downsell", page_url: "upsell/" },
    { id: "downsell", type: "downsell", on_accept: "receipt", on_decline: "receipt", page_url: "downsell/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ]);
  assert.match(byId.upsell.expected_accept_url, /\/campaign\/receipt\/$/);
  assert.match(byId.upsell.expected_decline_url, /\/campaign\/downsell\/$/);
});

test("a page declaring no route resolves to no URL, rather than inventing one", () => {
  const byId = topologyFor([
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ]);
  assert.equal(byId.receipt.expected_next_url ?? null, null);
  assert.equal(byId.receipt.expected_decline_url ?? null, null);
});

test("padded route targets resolve, rather than degrading to a raw string", () => {
  // Normalization regression guard: an untrimmed target used to miss the page
  // map and fall through as a literal, so QA compared against " receipt ".
  const byId = topologyFor([
    { id: "checkout", type: "checkout", success_url: "  receipt  ", page_url: "checkout/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ]);
  assert.match(byId.checkout.expected_next_url, /\/campaign\/receipt\/$/);
});
