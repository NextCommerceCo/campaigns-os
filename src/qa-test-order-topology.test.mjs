import test from "node:test";
import assert from "node:assert/strict";

import {
  commonTestOrderPaths,
  fullTestOrderPaths,
  remainingActionDisposition,
  resolveTestOrderTopology,
  terminalAtUrl,
} from "./qa-test-order-topology.mjs";

const SITE = "https://campaign.example/";
const url = (route) => new URL(route, SITE).toString();

function page(pageId, pageType, route, edges = {}) {
  return {
    page_id: pageId,
    page_type: pageType,
    url: url(route),
    ...edges,
  };
}

test("full paths follow actual branches and stop when a shortcut reaches receipt", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell-1/"),
  });
  const topology = {
    funnel_id: "shortcut",
    pages: [
      checkout,
      page("upsell-1", "upsell", "upsell-1/", {
        expected_accept_url: url("upsell-2/"),
        expected_decline_url: url("upsell-2/"),
      }),
      page("upsell-2", "upsell", "upsell-2/", {
        expected_accept_url: url("receipt/"),
        expected_decline_url: url("downsell/"),
      }),
      page("downsell", "downsell", "downsell/", {
        expected_accept_url: url("receipt/"),
        expected_decline_url: url("receipt/"),
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  };

  const resolved = resolveTestOrderTopology(topology, checkout);

  assert.deepEqual(resolved.full_paths, [
    "decline-decline-decline",
    "decline-decline-accept",
    "decline-accept",
    "accept-decline-decline",
    "accept-decline-accept",
    "accept-accept",
  ]);
});

test("full paths retain uneven branches that end at a declared external handoff", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell/"),
  });
  const topology = {
    funnel_id: "external",
    pages: [
      checkout,
      page("upsell", "upsell", "upsell/", {
        expected_accept_url: "https://hosted.example/complete/",
        expected_decline_url: url("downsell/"),
      }),
      page("downsell", "downsell", "downsell/", {
        expected_accept_url: url("receipt/"),
        expected_decline_url: url("receipt/"),
      }),
      page("receipt", "receipt", "receipt/"),
    ],
  };

  const resolved = resolveTestOrderTopology(topology, checkout);

  assert.deepEqual(resolved.full_paths, [
    "decline-decline",
    "decline-accept",
    "accept",
  ]);
  assert.equal(resolved.terminal_paths.at(-1).terminal.kind, "external_handoff");
});

test("full path resolution reports cycles and unresolved terminals without inventing paths", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell/"),
  });
  const topology = {
    funnel_id: "broken",
    pages: [
      checkout,
      page("upsell", "upsell", "upsell/", {
        expected_accept_url: url("upsell/"),
        expected_decline_url: "missing-page-id",
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  };

  const resolved = resolveTestOrderTopology(topology, checkout);

  assert.deepEqual(resolved.full_paths, []);
  assert.deepEqual(resolved.invalid_paths.map(({ path, reason }) => ({ path, reason })), [
    { path: "decline", reason: "unresolved_target" },
    { path: "accept", reason: "cycle" },
  ]);
});

test("runtime safety stops only at recognized terminals, never for a missing offer control", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell/"),
  });
  const topology = {
    funnel_id: "runtime-terminal",
    pages: [
      checkout,
      page("upsell", "upsell", "upsell/", {
        expected_accept_url: "https://hosted.example/complete/",
        expected_decline_url: url("receipt/"),
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  };
  const resolved = resolveTestOrderTopology(topology, checkout);

  assert.equal(terminalAtUrl(resolved, `${url("receipt/")}?ref_id=qa`).kind, "receipt");
  assert.equal(terminalAtUrl(resolved, "https://hosted.example/complete/?ref_id=qa").kind, "external_handoff");
  assert.equal(terminalAtUrl(resolved, url("upsell/")), null);
  assert.equal(terminalAtUrl(resolved, url("missing-controls/")), null);
  assert.equal(remainingActionDisposition(resolved, url("receipt/"), ["accept"]).stop, true);
  assert.deepEqual(remainingActionDisposition(resolved, url("missing-controls/"), ["accept"]), { stop: false });
});

test("full mode refuses to claim exhaustive coverage when a reachable branch is not terminal", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell/"),
  });
  const resolved = resolveTestOrderTopology({
    funnel_id: "incomplete",
    pages: [
      checkout,
      page("upsell", "upsell", "upsell/", {
        expected_accept_url: url("receipt/"),
        expected_decline_url: "missing-page-id",
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  }, checkout);

  assert.throws(
    () => fullTestOrderPaths(resolved),
    /cannot enumerate actual terminal paths.*decline.*unresolved_target/i,
  );
});

test("full mode keeps checkout-only funnels at one order without inferring stray offer pages", () => {
  const checkout = page("checkout", "checkout", "checkout/");
  const resolved = resolveTestOrderTopology({
    funnel_id: "checkout-only",
    pages: [
      checkout,
      page("stray-upsell", "upsell", "stray-upsell/", {
        expected_accept_url: url("receipt/"),
        expected_decline_url: url("receipt/"),
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  }, checkout);

  assert.deepEqual(fullTestOrderPaths(resolved), ["checkout"]);
});

test("common mode dedupes its samples and adds only the shortest real receipt path", () => {
  const zeroCheckout = page("checkout-0", "checkout", "zero/checkout/");
  const zero = resolveTestOrderTopology({ funnel_id: "zero", pages: [zeroCheckout] }, zeroCheckout);
  assert.deepEqual(commonTestOrderPaths(zero), ["checkout"]);

  const oneCheckout = page("checkout-1", "checkout", "one/checkout/", { expected_next_url: url("one/upsell/") });
  const one = resolveTestOrderTopology({ funnel_id: "one", pages: [
    oneCheckout,
    page("upsell-1", "upsell", "one/upsell/", { expected_accept_url: url("one/receipt/"), expected_decline_url: url("one/receipt/") }),
    page("receipt-1", "receipt", "one/receipt/"),
  ] }, oneCheckout);
  assert.deepEqual(commonTestOrderPaths(one), ["checkout", "accept", "decline"]);

  const twoCheckout = page("checkout-2", "checkout", "two/checkout/", { expected_next_url: url("two/upsell-1/") });
  const two = resolveTestOrderTopology({ funnel_id: "two", pages: [
    twoCheckout,
    page("upsell-2a", "upsell", "two/upsell-1/", { expected_accept_url: url("two/upsell-2/"), expected_decline_url: url("two/upsell-2/") }),
    page("upsell-2b", "upsell", "two/upsell-2/", { expected_accept_url: url("two/receipt/"), expected_decline_url: url("two/receipt/") }),
    page("receipt-2", "thankyou", "two/receipt/"),
  ] }, twoCheckout);
  assert.deepEqual(commonTestOrderPaths(two), ["checkout", "accept", "decline", "accept-decline"]);

  const externalCheckout = page("checkout-external", "checkout", "external/checkout/", { expected_next_url: url("external/upsell/") });
  const external = resolveTestOrderTopology({ funnel_id: "external-only", pages: [
    externalCheckout,
    page("upsell-external", "upsell", "external/upsell/", {
      expected_accept_url: "https://hosted.example/accepted/",
      expected_decline_url: "https://hosted.example/declined/",
    }),
  ] }, externalCheckout);
  assert.deepEqual(commonTestOrderPaths(external), ["checkout", "accept", "decline"]);
});

test("an absent same-origin route is unresolved, not an external handoff", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: url("upsell/"),
  });
  const resolved = resolveTestOrderTopology({
    funnel_id: "same-origin-missing",
    pages: [
      checkout,
      page("upsell", "upsell", "upsell/", {
        expected_accept_url: url("missing/"),
        expected_decline_url: url("receipt/"),
      }),
      page("receipt", "thankyou", "receipt/"),
    ],
  }, checkout);

  assert.deepEqual(resolved.invalid_paths.map(({ path, reason }) => ({ path, reason })), [
    { path: "accept", reason: "unresolved_target" },
  ]);
  assert.equal(terminalAtUrl(resolved, url("missing/")), null);
});

test("linear one- and two-offer funnels preserve the established full-path order", () => {
  const oneCheckout = page("checkout-1", "checkout", "one/checkout/", { expected_next_url: url("one/upsell/") });
  const one = resolveTestOrderTopology({ funnel_id: "one", pages: [
    oneCheckout,
    page("upsell-1", "upsell", "one/upsell/", { expected_accept_url: url("one/confirmation/"), expected_decline_url: url("one/confirmation/") }),
    page("receipt-1", "thankyou", "one/confirmation/"),
  ] }, oneCheckout);
  assert.deepEqual(fullTestOrderPaths(one), ["checkout", "decline", "accept"]);
  assert.equal(terminalAtUrl(one, `${url("one/confirmation/")}?ref_id=qa`).kind, "receipt");

  const twoCheckout = page("checkout-2", "checkout", "two/checkout/", { expected_next_url: url("two/upsell-1/") });
  const two = resolveTestOrderTopology({ funnel_id: "two", pages: [
    twoCheckout,
    page("upsell-2a", "upsell", "two/upsell-1/", { expected_accept_url: url("two/upsell-2/"), expected_decline_url: url("two/upsell-2/") }),
    page("upsell-2b", "upsell", "two/upsell-2/", { expected_accept_url: url("two/receipt/"), expected_decline_url: url("two/receipt/") }),
    page("receipt-2", "receipt", "two/receipt/"),
  ] }, twoCheckout);
  assert.deepEqual(fullTestOrderPaths(two), [
    "checkout",
    "decline-decline",
    "decline-accept",
    "accept-decline",
    "accept-accept",
  ]);
});

test("a checkout-level cross-origin handoff is recognized without inventing an action path", () => {
  const checkout = page("checkout", "checkout", "checkout/", {
    expected_next_url: "https://hosted.example/complete/",
  });
  const resolved = resolveTestOrderTopology({ funnel_id: "hosted", pages: [checkout] }, checkout);

  assert.deepEqual(fullTestOrderPaths(resolved), ["checkout"]);
  assert.equal(terminalAtUrl(resolved, "https://hosted.example/complete/?ref_id=qa").kind, "external_handoff");
});
