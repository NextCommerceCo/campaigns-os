// Real-browser proof that a checkout built from bundle cards is ordered as the
// page shows it. A starter-shaped bundle card declares its package and the
// per-package quantity only in data-next-bundle-items (bundle-2x is package 1
// at quantity 2); its own data-next-bundle-id is not a package. Each case
// serves fixtures/qa-bundle-order/checkout.html from a local HTTP server and
// drives `runBrowserTestOrders`, the path `qa run --test-order` takes, with
// the SDK replaced by the fixture's inline stand-in. The Campaigns API answers
// on campaigns.apps.localhost, which Chromium resolves to loopback, so nothing
// leaves the machine.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { runBrowserTestOrders } from "./qa-browser.mjs";

const FIXTURE = new URL("../fixtures/qa-bundle-order/checkout.html", import.meta.url).pathname;

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

// Package 1 is one purifier, package 3 the same purifier in a two-pack,
// package 2 the filter the order bump adds, and package 4 a stand only a kit
// card carries.
const PACKAGES = [
  { ref_id: 1, qty: 1, price: "20.00", price_total: "20.00", product_sku: "DEMO-PURIFIER", product_id: 101, product_variant_id: 201, product_title: "Demo Purifier" },
  { ref_id: 2, qty: 1, price: "5.00", price_total: "5.00", product_sku: "DEMO-FILTER", product_id: 102, product_variant_id: 202, product_title: "Demo Filter" },
  { ref_id: 3, qty: 2, price: "19.00", price_total: "38.00", product_sku: "DEMO-PURIFIER", product_id: 101, product_variant_id: 201, product_title: "Demo Purifier" },
  { ref_id: 4, qty: 1, price: "7.00", price_total: "7.00", product_sku: "DEMO-STAND", product_id: 104, product_variant_id: 204, product_title: "Demo Stand" },
];

// Adds one more bundle card to the swap-mode selector, after the 3x tier.
const addCard = (html, card) => html.replace(/\n {4}<\/div>\n {2}<\/div>\n {2}<aside/, `\n      ${card}\n    </div>\n  </div>\n  <aside`);

const PLAIN_CARDS = `<div class="os-cards__vertical">
      <div data-next-selector-card data-next-package-id="1" data-next-selected="true" role="button" class="os-card next-selected">1x Demo Purifier</div>
      <div data-next-selector-card data-next-package-id="3" role="button" class="os-card">2x Demo Purifier</div>
    </div>`;

// Page rewrites, one per variant the cases need.
const VARIANTS = {
  // The starter bundle-selector partial: package id repeated on an inner node.
  starter: (html) => html,
  // Cards whose package identity is data-next-bundle-items alone.
  "items-only": (html) => html.replace(/ class="os-card__content" data-next-package-id="1"/g, ' class="os-card__content"'),
  // No card carries two units of package 1.
  "no-2x": (html) => html.replace(/\n\s*<div data-next-bundle-card data-next-bundle-id="bundle-2x"[\s\S]*?<\/div>\n\s*<\/div>/, ""),
  // A card for the two-pack package 3 in the same selector.
  pack: (html) => addCard(html, `<div data-next-bundle-card data-next-bundle-id="bundle-pack" data-next-bundle-items='[{"packageId":3,"quantity":1}]' role="button" class="os-card"><div class="os-card__content" data-next-package-id="3">Two-pack</div></div>`),
  // A kit card declaring two items: two purifiers and the stand.
  kit: (html) => addCard(html, `<div data-next-bundle-card data-next-bundle-id="bundle-kit" data-next-bundle-items='[{"packageId":1,"quantity":2},{"packageId":4,"quantity":1}]' role="button" class="os-card"><div class="os-card__content" data-next-package-id="1">2x Demo Purifier + Stand</div></div>`),
  // Only the 2x and 3x tiers, with the 3x tier preselected.
  "2x-3x": (html) => html
    .replace(/\n\s*<div data-next-bundle-card data-next-bundle-id="bundle-1x"[\s\S]*?<\/div>\n\s*<\/div>/, "")
    .replace('data-next-bundle-id="bundle-3x"', 'data-next-bundle-id="bundle-3x" data-next-selected="true"'),
  // A plain package-card checkout: no bundle cards at all.
  plain: (html) => html.replace(/<div class="os-cards__vertical">[\s\S]*?\n {4}<\/div>/, PLAIN_CARDS),
};

const RECEIPT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Receipt</title></head>
<body><main><h1>Thank you</h1><div data-next-order-items>Order received.</div></main>
<script>
fetch("/api/v1/orders/" + encodeURIComponent(new URLSearchParams(location.search).get("ref_id")) + "/")
  .then(function (response) { return response.json(); })
  .then(function (order) {
    var receipt = document.querySelector("[data-next-order-items]");
    receipt.textContent = "";
    order.lines.forEach(function (line) {
      var row = document.createElement("div");
      row.setAttribute("data-next-order-item", "");
      row.textContent = line.product_title + " x" + line.quantity;
      receipt.appendChild(row);
    });
  });
</script></body></html>`;

async function serve() {
  const html = await readFile(FIXTURE, "utf8");
  const orders = [];
  const carts = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, body, type = "text/html; charset=utf-8") => {
      response.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
      response.end(body);
    };
    if (request.method === "GET" && url.pathname === "/api/v1/campaigns/") {
      return send(200, JSON.stringify({ name: "Demo campaign", currency: "USD", packages: PACKAGES }), "application/json");
    }
    if (request.method === "POST" && /^\/api\/v1\/orders\/?$/.test(url.pathname)) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const posted = JSON.parse(raw || "{}");
      carts.push((posted.lines || []).map((line) => `${line.packageId}:${line.quantity}`));
      const lines = (posted.lines || []).map((line) => {
        const pkg = PACKAGES.find((candidate) => String(candidate.ref_id) === String(line.packageId));
        return {
          product_title: pkg.product_title,
          product_sku: pkg.product_sku,
          product_id: pkg.product_id,
          variant_id: pkg.product_variant_id,
          quantity: pkg.qty * line.quantity,
          price_incl_tax: (Number(pkg.price_total) * line.quantity).toFixed(2),
          // The platform tags a checkout order bump is_upsell.
          is_upsell: pkg.ref_id === 2,
        };
      });
      const order = {
        ref_id: `ref-${orders.length + 1}`,
        number: `${1000 + orders.length + 1}`,
        is_test: true,
        currency: "USD",
        total_incl_tax: lines.reduce((sum, line) => sum + Number(line.price_incl_tax), 0).toFixed(2),
        lines,
      };
      orders.push(order);
      return send(201, JSON.stringify(order), "application/json");
    }
    if (request.method === "GET" && /^\/api\/v1\/orders\/[^/]+\/?$/.test(url.pathname)) {
      const order = orders.find((candidate) => url.pathname.includes(candidate.ref_id));
      return order ? send(200, JSON.stringify(order), "application/json") : send(404, "{}", "application/json");
    }
    if (url.pathname === "/x/receipt/") return send(200, RECEIPT);
    const checkout = /^\/x\/([a-z0-9-]+)\/checkout\/$/.exec(url.pathname);
    if (checkout && VARIANTS[checkout[1]]) return send(200, VARIANTS[checkout[1]](html));
    return send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    orders,
    carts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The Campaigns API is served on the same port under a campaigns.apps host,
// so the runner captures its packages the way it captures the SDK's call.
async function runVariant(variant, flags) {
  const server = await serve();
  const base = `http://127.0.0.1:${server.port}`;
  const topologies = [{
    funnel_id: "default",
    funnel_name: "Default",
    pages: [
      { page_id: "checkout", page_type: "checkout", order: 1, url: `${base}/x/${variant}/checkout/`, expected_next_url: `${base}/x/receipt/` },
      { page_id: "receipt", page_type: "receipt", order: 2, url: `${base}/x/receipt/` },
    ],
  }];
  try {
    const result = await runBrowserTestOrders(topologies, {
      "test-order": "checkout",
      "step-timeout-ms": 20000,
      "order-timeout-ms": 90000,
      "browser-timeout": 10000,
      ...flags,
    }, `qa-bundle-order-${variant}`);
    const order = result.orders[0];
    const steps = Object.fromEntries((order?.evidence?.steps || []).map((entry) => [entry.step, entry]));
    const parity = result.assertions.find((entry) => entry.id.startsWith("browser-order-display-parity:"));
    return { result, order, steps, parity, posted: server.orders.map((entry) => entry.lines), carts: server.carts };
  } finally {
    await server.close();
  }
}

const orderedUnits = (lines, sku) => lines.filter((line) => line.product_sku === sku).reduce((sum, line) => sum + line.quantity, 0);

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed bundle-order proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("--select-package 1:2 selects the two-unit bundle card by its data-next-bundle-items and the order reconciles clean", async () => {
  const { steps, parity, posted } = await runVariant("items-only", { "select-package": "1:2" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.match(steps.selected_bundle.detail, /1:2 via \[data-next-bundle-id="bundle-2x"\]/);
  assert.equal(posted.length, 1, "exactly one order was posted");
  assert.equal(orderedUnits(posted[0], "DEMO-PURIFIER"), 2);
  assert.equal(parity.status, "pass", parity.actual);
  // The card's bundle id is not a package the order could carry.
  assert.deepEqual(parity.evidence.displayed_package_ids, ["1"]);
  assert.deepEqual(parity.evidence.missing, []);
  assert.equal(parity.evidence.unresolved_lines, undefined);
});

browserTest("--cart 1:2 against bundle cards selects the two-unit card, orders two units and reconciles clean", async () => {
  const { steps, order, parity, posted } = await runVariant("starter", { cart: "1:2" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.equal(posted.length, 1, "exactly one order was posted");
  assert.equal(orderedUnits(posted[0], "DEMO-PURIFIER"), 2, "the order carries the two units --cart asked for");
  assert.deepEqual(order.cart_state.packages.map((entry) => entry.quantity), [2]);
  assert.equal(parity.status, "pass", parity.actual);
  assert.deepEqual(parity.evidence.displayed_package_ids, ["1"]);
});

browserTest("--cart 1:2 when no card carries two units: the one-unit order fails the display-parity row by quantity", async () => {
  const { parity, posted } = await runVariant("no-2x", { cart: "1:2" });

  assert.equal(posted.length, 1);
  assert.equal(orderedUnits(posted[0], "DEMO-PURIFIER"), 1, "the page could only order one unit");
  assert.equal(parity.status, "fail");
  assert.equal(parity.severity, "blocker");
  assert.match(parity.actual, /package 1 requested 2 unit\(s\) \(1 per package × 2\) but persisted 1/);
  assert.deepEqual(parity.evidence.quantity_mismatches.map((entry) => entry.package_ref_id), ["1"]);
});

browserTest("a bare --cart 1 clicks the first rendered card carrying package 1, as before", async () => {
  const { steps, parity, carts } = await runVariant("2x-3x", { cart: "1" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.deepEqual(carts, [["1:2"]], "the 2x card, first in document order, replaced the preselected 3x card");
  assert.equal(parity.status, "pass", parity.actual);
});

browserTest("--select-package 1:2 with --cart 1:2,2:1 keeps the selected bundle and adds the bump", async () => {
  const { steps, parity, posted } = await runVariant("starter", { "select-package": "1:2", cart: "1:2,2:1" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.equal(steps.bump_state.detail, "1 bump toggle(s), 1 active");
  assert.equal(posted.length, 1);
  assert.equal(orderedUnits(posted[0], "DEMO-PURIFIER"), 2, "--cart did not re-select the one-unit card");
  assert.equal(orderedUnits(posted[0], "DEMO-FILTER"), 1);
  assert.equal(parity.status, "pass", parity.actual);
  assert.equal(parity.evidence.order_bump_line_count, 1);
});

// --cart beside --select-package: the card --select-package chose stays
// selected, and a --cart ref it cannot apply without switching cards is named
// in selected_bundle. Same package at the same quantity and a package an order
// bump carries are covered by the case above.
browserTest("--select-package 1:2 with --cart 1:3 keeps the two-unit card and names the unapplied quantity", async () => {
  const { steps, parity, carts } = await runVariant("starter", { "select-package": "1:2", cart: "1:3" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.deepEqual(carts, [["1:2"]]);
  assert.match(steps.selected_bundle.detail, /--cart 1:3 not applied: the card --select-package chose declares 1:2/);
  assert.equal(parity.status, "pass", parity.actual);
});

browserTest("--select-package 1:2 with --cart 3:1 in a swap-mode selector does not switch to the package-3 card", async () => {
  const { steps, parity, carts } = await runVariant("pack", { "select-package": "1:2", cart: "3:1" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.deepEqual(carts, [["1:2"]], "the order is the card --select-package chose");
  assert.match(steps.selected_bundle.detail, /1:2 via \[data-next-bundle-id="bundle-2x"\]/);
  assert.match(steps.selected_bundle.detail, /--cart 3:1 not applied: only another card in the selector --select-package chose carries it/);
  assert.equal(parity.status, "pass", parity.actual);
  assert.deepEqual(parity.evidence.displayed_package_ids, ["1"]);
});

browserTest("plain package cards: --select-package 3 with --cart 1 does not switch to the package-1 card", async () => {
  const { steps, parity, carts } = await runVariant("plain", { "select-package": "3", cart: "1" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.deepEqual(carts, [["3:1"]]);
  assert.match(steps.selected_bundle.detail, /--cart 1:1 not applied: only another card in the selector --select-package chose carries it/);
  assert.equal(parity.status, "pass", parity.actual);
});

browserTest("--select-package 1:2 with --cart for a package no card or control carries names it and keeps the selection", async () => {
  const { steps, parity, carts } = await runVariant("starter", { "select-package": "1:2", cart: "9:1" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.match(steps.selected_bundle.detail, /--cart 9:1 not applied: no rendered card or control carries it/);
  assert.deepEqual(carts, [["1:2"]]);
  assert.equal(parity.status, "pass", parity.actual);
});

browserTest("a card declaring two items is selected by either item and reconciles every item it declares", async () => {
  const strict = await runVariant("kit", { "select-package": "4:1" });
  assert.equal(strict.steps.selected_bundle.status, "ok", strict.steps.selected_bundle.error);
  assert.match(strict.steps.selected_bundle.detail, /4:1 via \[data-next-bundle-id="bundle-kit"\]/);
  assert.deepEqual(strict.carts.map((lines) => [...lines].sort()), [["1:2", "4:1"]]);
  assert.equal(strict.parity.status, "pass", strict.parity.actual);
  assert.deepEqual([...strict.parity.evidence.displayed_package_ids].sort(), ["1", "4"]);

  const cart = await runVariant("kit", { cart: "4:1" });
  assert.deepEqual(cart.carts.map((lines) => [...lines].sort()), [["1:2", "4:1"]]);
  assert.equal(cart.parity.status, "pass", cart.parity.actual);
});

browserTest("control: a plain package-card checkout selects, adds the bump and reconciles as before", async () => {
  const { steps, parity, posted } = await runVariant("plain", { "select-package": "3", cart: "2" });

  assert.equal(steps.selected_bundle.status, "ok", steps.selected_bundle.error);
  assert.equal(
    steps.selected_bundle.detail,
    'selected requested package card(s): 3:1 via [data-next-selector-card][data-next-package-id="3"], [data-next-package-id="3"]',
  );
  assert.equal(steps.bump_state.detail, "1 bump toggle(s), 1 active");
  assert.equal(posted.length, 1);
  assert.equal(orderedUnits(posted[0], "DEMO-PURIFIER"), 2);
  assert.equal(orderedUnits(posted[0], "DEMO-FILTER"), 1);
  assert.equal(parity.status, "pass", parity.actual);
  assert.deepEqual(parity.evidence.displayed_package_ids, ["3", "2"]);
  assert.deepEqual(parity.evidence.matched_quantities, [{ package_ref_id: "3", unit_quantity: 2, purchase_multiplier: 1, persisted_quantity: 2 }]);
});
