// Real-browser proof for the typed-card runner's cart entry step and
// empty-cart guard (campaigns-os#206, runner half). Each case serves one of
// the fixtures under fixtures/qa-cart-entry/ from a local HTTP server and
// drives the actual `runBrowserTestOrders` entry point through Playwright
// Chromium — the same code path `qa run --test-order` takes, with the SDK
// replaced by the fixture shim.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium. The browser-free halves of the same logic are
// covered unconditionally in qa-cart-entry.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { __qaBrowserTestHooks, runBrowserTestOrders } from "./qa-browser.mjs";
import { resolveTestOrderTopology } from "./qa-test-order-topology.mjs";

const { classifyTestOrderCreation } = __qaBrowserTestHooks;
const FIXTURES = new URL("../fixtures/qa-cart-entry/", import.meta.url).pathname;

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

// The card iframes SDK 0.4.41 mounts, in place of the fixtures' iFrame v1
// ones: ids are the Spreedly Checkout SDK's spreedly-hosted-<field>-<suffix>
// and each frame's input carries its own id, as observed live on 0.4.41.
function withNextPaymentCardFields(html) {
  return html
    .replace(/id="spreedly-number-frame-1"/g, 'id="spreedly-hosted-number-k3x9q2"')
    .replace(/id="spreedly-cvv-frame-1"/g, 'id="spreedly-hosted-cvv-k3x9q2"')
    .replace(/&lt;input aria-label=&quot;Card number&quot;&gt;/g, "&lt;input id=&quot;spreedly-hosted-number-input&quot; type=&quot;text&quot;&gt;")
    .replace(/&lt;input aria-label=&quot;CVV&quot;&gt;/g, "&lt;input id=&quot;spreedly-hosted-cvv-input&quot; type=&quot;text&quot;&gt;");
}

// Both generations on one checkout: the iFrame v1 pair stays and the 0.4.41
// pair is added beside it, the page the runner must refuse rather than type
// into whichever frame comes first.
function withBothCardFieldGenerations(html) {
  return html.replace(/(<iframe id="spreedly-cvv-frame-1"[^>]*><\/iframe>)/, (cvv) => `${cvv}
      <iframe id="spreedly-hosted-number-k3x9q2" srcdoc="&lt;input id=&quot;spreedly-hosted-number-input&quot;&gt;"></iframe>
      <iframe id="spreedly-hosted-cvv-k3x9q2" srcdoc="&lt;input id=&quot;spreedly-hosted-cvv-input&quot;&gt;"></iframe>`);
}

const CARD_FIELD_REWRITES = { "next-payment": withNextPaymentCardFields, both: withBothCardFieldGenerations };

// How the card number field misbehaves, injected into checkout. Each acts on
// the number frame's input from the page (srcdoc frames are same-origin):
//   loading         the form carries next-loading-spreedly for 2.5s, and when
//                   it clears the field wipes whatever was typed before, the
//                   way 0.4.41's hosted field drops digits typed before its
//                   script has loaded;
//   drop-once       the first complete number typed is wiped once;
//   always-truncate the field never keeps more than its last four digits.
const CARD_BEHAVIOURS = {
  loading: `form.classList.add("next-loading-spreedly");
    setTimeout(function () { input.value = ""; form.classList.remove("next-loading-spreedly"); }, 2500);`,
  "drop-once": `var dropped = false;
    input.addEventListener("input", function () {
      if (!dropped && input.value.replace(/\\D/g, "").length >= 16) { dropped = true; setTimeout(function () { input.value = ""; }, 50); }
    });`,
  "always-truncate": `input.addEventListener("input", function () {
      var digits = input.value.replace(/\\D/g, "");
      if (digits.length > 4) input.value = digits.slice(-4);
    });`,
};

function withCardBehaviour(html, behaviour) {
  const script = `<script>
(function () {
  var form = document.querySelector("form[data-fixture-checkout]");
  var frame = document.querySelector('iframe[id^="spreedly-hosted-number"], iframe[id^="spreedly-number-frame"]');
  function attach() {
    var input = frame.contentDocument && frame.contentDocument.querySelector("input");
    if (!input) return setTimeout(attach, 10);
    ${CARD_BEHAVIOURS[behaviour]}
  }
  attach();
})();
</script>`;
  return html.replace("</body>", `${script}\n</body>`);
}

// Serves one fixture under /x/ plus the shim and a fake orders API.
// cardFields "next-payment" serves checkout with SDK 0.4.41's card iframes;
// "both" serves the iFrame v1 and 0.4.41 pairs together.
async function serveFixture(name, { cardFields = "iframe-v1", cardBehaviour = null } = {}) {
  const dir = join(FIXTURES, name);
  const orders = [];
  // Page-HTML loads by page name: every checkout load is an SDK boot and a
  // page-view fire, so the tests count them.
  const pageLoads = { landing: 0, checkout: 0, receipt: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, body, type = "text/html; charset=utf-8") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    if (request.method === "POST" && /^\/api\/v1\/orders\/?$/.test(url.pathname)) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const posted = JSON.parse(raw || "{}");
      const order = {
        ref_id: `ref-${orders.length + 1}`,
        number: `${1000 + orders.length + 1}`,
        is_test: true,
        currency: "USD",
        total_incl_tax: "19.00",
        lines: (posted.lines || []).map((line) => ({ product_title: `Package ${line.packageId}`, quantity: line.quantity, price_incl_tax: "19.00" })),
      };
      orders.push(order);
      return send(201, JSON.stringify(order), "application/json");
    }
    if (request.method === "GET" && /^\/api\/v1\/orders\/[^/]+\/?$/.test(url.pathname)) {
      const order = orders.find((candidate) => url.pathname.includes(candidate.ref_id));
      return order ? send(200, JSON.stringify(order), "application/json") : send(404, "{}", "application/json");
    }
    if (url.pathname === "/sdk-shim.js") {
      return send(200, await readFile(join(FIXTURES, "sdk-shim.js")), "text/javascript");
    }
    const page = /^\/x\/(landing|checkout|receipt)\/?$/.exec(url.pathname);
    if (page) {
      pageLoads[page[1]] += 1;
      try {
        const html = await readFile(join(dir, `${page[1]}.html`), "utf8");
        const rewrite = page[1] === "checkout" ? CARD_FIELD_REWRITES[cardFields] : null;
        const rewritten = rewrite ? rewrite(html) : html;
        return send(200, page[1] === "checkout" && cardBehaviour ? withCardBehaviour(rewritten, cardBehaviour) : rewritten);
      } catch {
        return send(404, "not found");
      }
    }
    return send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    orders,
    pageLoads,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function topologies(base, { withLanding = true } = {}) {
  const pages = [
    ...(withLanding
      ? [{ page_id: "landing", page_type: "landing", order: 1, url: `${base}/x/landing/`, expected_next_url: `${base}/x/checkout/` }]
      : []),
    { page_id: "checkout", page_type: "checkout", order: 2, url: `${base}/x/checkout/`, expected_next_url: `${base}/x/receipt/` },
    { page_id: "receipt", page_type: "receipt", order: 3, url: `${base}/x/receipt/` },
  ];
  return [{ funnel_id: "default", funnel_name: "Default", pages }];
}

const ARGS = Object.freeze({
  "test-order": "checkout",
  "step-timeout-ms": 20000,
  "order-timeout-ms": 90000,
  "browser-timeout": 10000,
});

// beforeRun reads the served pages through the same server the run drives.
async function runFixture(name, { withLanding = true, cardFields, cardBehaviour, beforeRun = null } = {}) {
  const server = await serveFixture(name, { cardFields, cardBehaviour });
  try {
    if (beforeRun) await beforeRun(server);
    const result = await runBrowserTestOrders(topologies(server.base, { withLanding }), { ...ARGS }, `qa-cart-entry-${name}`);
    const order = result.orders[0];
    const attemptAssertion = result.assertions.find((entry) => entry.id === "browser-test-order:checkout");
    return { result, order, steps: order?.evidence?.steps || [], assertion: attemptAssertion, server };
  } finally {
    await server.close();
  }
}

const stepsByName = (steps) => Object.fromEntries(steps.map((entry) => [entry.step, entry]));

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed cart-entry proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("landing-entry: the runner enters through the landing page, the SDK lands it on checkout, and it submits a non-empty cart", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry");
  const byName = stepsByName(steps);

  assert.equal(steps[0]?.step, "entered_via_landing", "the entry step is the first rung of the ladder");
  assert.equal(byName.entered_via_landing.status, "ok");
  assert.match(byName.entered_via_landing.detail, /entered via landing page: clicked "Claim your offer" \(package 1\), SDK navigated to checkout/);
  assert.equal(byName.entered_via_landing.evidence.landing_url, `${server.base}/x/landing/`);
  assert.equal(byName.entered_via_landing.evidence.control_text, "Claim your offer");
  assert.equal(byName.entered_via_landing.evidence.package_id, "1");
  assert.equal(byName.entered_via_landing.evidence.control_kind, "add_to_cart");
  assert.equal(byName.entered_via_landing.evidence.landing_resolution, "routes_into_checkout");
  assert.equal(byName.entered_via_landing.evidence.arrived_url, `${server.base}/x/checkout/`);
  assert.equal(byName.entered_via_landing.evidence.checkout_selection_surface.count, 0, "the display-only checkout carries no selection surface");

  assert.equal(byName.opened_checkout.status, "ok");
  assert.match(byName.opened_checkout.detail, /arrived from the entry page via SDK navigation; not re-opened/);
  const { generation, number_frame_id, cvv_frame_id, attempts } = byName.card_fields_filled.evidence;
  assert.deepEqual({ generation, number_frame_id, cvv_frame_id, attempts }, {
    generation: "spreedly-iframe-v1",
    number_frame_id: "spreedly-number-frame-1",
    cvv_frame_id: "spreedly-cvv-frame-1",
    attempts: 1,
  });
  assert.equal(byName.order_submitted.status, "ok");
  assert.deepEqual(byName.order_submitted.evidence.cart_before_submit, {
    empty: false, source: "window.next", count: 1, line_count: 1, package_ids: ["1"],
  });
  assert.equal(server.orders.length, 1, "exactly one order was posted");
  assert.equal(server.pageLoads.checkout, 2, "the selector probe and the SDK's own navigation from the landing page; nothing re-opened it");
  assert.equal(server.pageLoads.landing, 1);
  assert.equal(assertion.status, "pass", assertion.actual);
  assert.equal(assertion.evidence.line_count, 1);
});

browserTest("landing-entry on SDK 0.4.41 card fields: the runner types into the spreedly-hosted iframes and submits the same order", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry", {
    cardFields: "next-payment",
    beforeRun: async ({ base }) => {
      const checkout = await (await fetch(`${base}/x/checkout/`)).text();
      assert.match(checkout, /id="spreedly-hosted-number-k3x9q2"/, "the served checkout carries the 0.4.41 number iframe");
      assert.doesNotMatch(checkout, /spreedly-(number|cvv)-frame/, "and no iFrame v1 frame the old selector could still find");
    },
  });
  const byName = stepsByName(steps);
  assert.equal(byName.card_fields_filled.status, "ok", byName.card_fields_filled.error);
  const { generation, number_frame_id, cvv_frame_id, attempts } = byName.card_fields_filled.evidence;
  assert.deepEqual({ generation, number_frame_id, cvv_frame_id, attempts }, {
    generation: "spreedly-hosted",
    number_frame_id: "spreedly-hosted-number-k3x9q2",
    cvv_frame_id: "spreedly-hosted-cvv-k3x9q2",
    attempts: 1,
  }, "the card step typed into the 0.4.41 frames, not an iFrame v1 fallback");
  assert.equal(byName.order_submitted.status, "ok", byName.order_submitted.detail);
  assert.equal(server.orders.length, 1, "exactly one order was posted");
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("landing-entry with both card-field generations: the card step fails by name and nothing is submitted", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry", { cardFields: "both" });
  const byName = stepsByName(steps);
  assert.equal(byName.card_fields_filled.status, "failed");
  assert.match(
    byName.card_fields_filled.error,
    /expected one card number iframe and one CVV iframe of one generation; found number=\[spreedly-number-frame-1, spreedly-hosted-number-k3x9q2\]/,
  );
  assert.equal(byName.order_submitted, undefined, "the ladder stops at the card step");
  assert.equal(server.orders.length, 0, "no order was posted");
  assert.notEqual(assertion.status, "pass");
});

browserTest("card fields still loading: the runner waits for next-loading-spreedly to clear before typing, so no digits are lost", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry", { cardFields: "next-payment", cardBehaviour: "loading" });
  const byName = stepsByName(steps);
  assert.equal(byName.card_fields_filled.status, "ok", byName.card_fields_filled.error);
  assert.ok(byName.card_fields_filled.evidence.ready_wait_ms > 0, "the step waited for the fields to report ready");
  assert.equal(byName.card_fields_filled.evidence.attempts, 1, "typed once, after ready");
  assert.equal(byName.order_submitted.status, "ok", byName.order_submitted.detail);
  assert.equal(server.orders.length, 1);
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("card field drops the typed number once: the runner reads it back, retypes, and submits", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry", { cardFields: "next-payment", cardBehaviour: "drop-once" });
  const byName = stepsByName(steps);
  assert.equal(byName.card_fields_filled.status, "ok", byName.card_fields_filled.error);
  assert.equal(byName.card_fields_filled.evidence.attempts, 2, "the read-back caught the wiped number and the second attempt kept it");
  assert.equal(byName.order_submitted.status, "ok", byName.order_submitted.detail);
  assert.equal(server.orders.length, 1);
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("card field never keeps the number: the card step fails by name and nothing is submitted", async () => {
  const { steps, assertion, server } = await runFixture("landing-entry", { cardFields: "next-payment", cardBehaviour: "always-truncate" });
  const byName = stepsByName(steps);
  assert.equal(byName.card_fields_filled.status, "failed");
  assert.match(
    byName.card_fields_filled.error,
    /card fields did not keep the typed card after 3 attempts: number field holds 4 digit\(s\) ending 1117 \(typed 16 ending 1117\), CVV field holds 3 digit\(s\)/,
  );
  assert.equal(byName.order_submitted, undefined, "the ladder stops at the card step instead of timing out at submit");
  assert.equal(server.orders.length, 0);
  assert.notEqual(assertion.status, "pass");
});

browserTest("landing-link-entry: a forcePackageId link is a cart entry; the visible link is the one clicked, by index, past a decoy and a hidden twin", async () => {
  const { steps, assertion, server } = await runFixture("landing-link-entry");
  const byName = stepsByName(steps);

  assert.equal(byName.entered_via_landing.status, "ok");
  assert.equal(byName.entered_via_landing.evidence.control_kind, "checkout_link");
  assert.equal(byName.entered_via_landing.evidence.control_text, "Claim your 60% discount");
  assert.equal(byName.entered_via_landing.evidence.package_id, "1");
  assert.equal(byName.entered_via_landing.evidence.arrived_url, `${server.base}/x/checkout/`, "query-redacted arrival at the checkout URL");
  assert.equal(byName.order_submitted.status, "ok");
  assert.equal(byName.order_submitted.evidence.cart_before_submit.count, 1, "the SDK pre-loaded the cart from forcePackageId on arrival");
  assert.equal(server.orders.length, 1);
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("checkout-selector: a checkout that selects for itself skips the entry step and runs the ladder it always ran", async () => {
  const { steps, assertion, server } = await runFixture("checkout-selector");
  const [entry, ...rest] = steps;

  assert.equal(entry.step, "entered_via_landing");
  assert.equal(entry.status, "skipped");
  assert.match(entry.detail, /checkout carries its own package selection surface \(1 bundle_selector, 2 package_card\); cart is entered on checkout/);
  assert.equal(entry.evidence.checkout_selection_surface.excluded, 2, "the summary row and the bump toggle are not counted as a selection surface");

  // The ladder that existed before the entry step, byte-for-byte in step
  // name, status and detail. A change here means an existing family's proof
  // changed shape.
  const shape = rest.map(({ step, status, detail = null }) => ({ step, status, detail }));
  assert.deepEqual(shape, [
    { step: "opened_checkout", status: "ok", detail: "already on checkout from the selector probe; not re-opened" },
    { step: "selected_bundle", status: "ok", detail: "default bundle selection" },
    { step: "bump_state", status: "ok", detail: "1 bump toggle(s), 0 active" },
    { step: "customer_fields_filled", status: "ok", detail: null },
    { step: "coupon_applied", status: "skipped", detail: "no --apply-coupon code requested" },
    { step: "card_fields_filled", status: "ok", detail: null },
    { step: "cart_created", status: "skipped", detail: "no cart API call observed; checkout posts the order directly" },
    { step: "order_submitted", status: "ok", detail: null },
    { step: "hosted_redirect_observed", status: "skipped", detail: "no hosted checkout redirect observed" },
    { step: "upsell_action", status: "skipped", detail: "path has no upsell steps" },
    { step: "receipt_reached", status: "ok", detail: `${server.base}/x/receipt/` },
    { step: "receipt_rendered", status: "ok", detail: "1 buyer-visible rendered item candidate(s) across 1 populated receipt container(s)" },
  ]);
  assert.equal(server.pageLoads.checkout, 1, "the selector probe's load is the path's only checkout load");
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("landing-entry-empty-cart: an empty cart at submit time fails by name, clicks nothing, and spends nothing", async () => {
  const { result, order, steps, assertion, server } = await runFixture("landing-entry-empty-cart");
  const byName = stepsByName(steps);

  assert.equal(byName.entered_via_landing.status, "ok", "the entry step itself succeeded: the control navigated");
  assert.equal(byName.order_submitted.status, "failed");
  assert.match(byName.order_submitted.error, /^cart_empty_before_submit: SDK cart holds 0 item\(s\) at submit time \(read from window\.next\)/);
  assert.equal(byName.order_submitted.evidence.cart_before_submit.empty, true);
  assert.equal(server.orders.length, 0, "no order was posted");

  // Budget semantics from #316: the guard runs before the reservation, so the
  // path is provably not_created and no creation slot was charged to it.
  const attempt = result.assertions.find((entry) => entry.id === "browser-test-order:checkout");
  assert.equal(attempt.status, "fail");
  assert.equal(attempt.evidence.order_creation.classification, "not_created");
  assert.equal(attempt.evidence.order_creation.submissions_reserved, 0);
  assert.equal(attempt.evidence.order_creation.orders_confirmed_created, 0);
  assert.match(attempt.actual, /cart_empty_before_submit/);
  assert.equal(order.ok, false);
  assert.equal(assertion.evidence.order_creation.action, "rerun", "a not_created failure keeps its bounded re-run");
});

browserTest("no-entry-resolvable: no selector on checkout and no entry page is a named failure at the entry step, not a step timeout", async () => {
  const started = Date.now();
  const { result, steps, server } = await runFixture("no-entry-resolvable", { withLanding: false });
  const byName = stepsByName(steps);

  assert.equal(steps[0].step, "entered_via_landing");
  assert.equal(byName.entered_via_landing.status, "failed");
  assert.match(byName.entered_via_landing.error, /^cart_entry_unresolved: checkout carries no package selection surface and no landing\/entry page resolves/);
  assert.equal(byName.order_submitted, undefined, "the ladder stopped at the entry step");
  assert.ok(Date.now() - started < ARGS["step-timeout-ms"], "failed well inside one step budget, not by timing out");
  assert.equal(server.orders.length, 0);

  const attempt = result.assertions.find((entry) => entry.id === "browser-test-order:checkout");
  assert.equal(attempt.status, "fail");
  assert.equal(attempt.evidence.order_creation.classification, "not_created");
  assert.equal(attempt.evidence.order_creation.submissions_reserved, 0);
  assert.equal(classifyTestOrderCreation(result.orders.length ? { ok: false, submit: { reserved: false }, order: result.orders[0], events: {} } : null).creation, "not_created");
});

// The negative of landing-entry: a page whose only "add-to-cart" controls are
// spelled with attributes the SDK never activates on. The runner must not
// click one and then wait out the navigation budget for a hand-off the SDK
// will never make; it fails by name at the entry step, before any click.
browserTest("landing-unwired-controls: a control the SDK never wires is not a cart entry, and the step fails by name before any click", async () => {
  const started = Date.now();
  const { result, steps, server } = await runFixture("landing-unwired-controls");
  const byName = stepsByName(steps);

  assert.equal(steps[0].step, "entered_via_landing");
  assert.equal(byName.entered_via_landing.status, "failed");
  assert.match(byName.entered_via_landing.error, /^cart_entry_control_missing: no add-to-cart control or forcePackageId checkout link/);
  assert.equal(byName.opened_checkout, undefined, "the ladder stopped at the entry step");
  assert.ok(Date.now() - started < ARGS["browser-timeout"], "refused before any click: no navigation wait was spent");
  assert.equal(server.orders.length, 0);

  const attempt = result.assertions.find((entry) => entry.id === "browser-test-order:checkout");
  assert.equal(attempt.status, "fail");
  assert.equal(attempt.evidence.order_creation.classification, "not_created");
  assert.equal(attempt.evidence.order_creation.submissions_reserved, 0);
});

// The same vocabulary drives the primary-CTA recogniser: an unwired control
// is a plain button, so its data-next-url has no navigation semantics and it
// routes nowhere.
browserTest("primary-cta: a control the SDK never wires gets no route from its data-next-url", async () => {
  const { inspectPrimaryCta } = __qaBrowserTestHooks;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const server = await serveFixture("landing-unwired-controls");
  try {
    const page = await browser.newPage();
    await page.goto(`${server.base}/x/landing/`, { waitUntil: "load" });
    const evidence = await inspectPrimaryCta(page, `${server.base}/x/checkout/`);
    assert.equal(evidence.candidates.length, 2, JSON.stringify(evidence.candidates));
    for (const candidate of evidence.candidates) {
      assert.equal(candidate.href, null, `${candidate.text}: a plain button has no href`);
      assert.equal(candidate.route_matches, false, candidate.text);
    }
    assert.equal(evidence.reason, "missing_route_cta");
    await page.close();
  } finally {
    await server.close();
    await browser.close();
  }
});

// Keep the topology helper honest: the runner reads entry from the same
// resolved topology the rest of the ladder uses.
// campaigns-os#321: the primary-CTA recogniser and the ladder's entry step
// read the same cart-entry vocabulary, so the SDK's own add-to-cart button
// (data-next-url, no href) is a route CTA — and a plain forcePackageId link
// still is.
browserTest("primary-cta: the SDK add-to-cart button and the forcePackageId link are both recognised as the route CTA", async () => {
  const { inspectPrimaryCta } = __qaBrowserTestHooks;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const [fixture, expectedText] of [["landing-entry", "Claim your offer"], ["landing-link-entry", "Claim your 60% discount"]]) {
      const server = await serveFixture(fixture);
      try {
        const page = await browser.newPage();
        await page.goto(`${server.base}/x/landing/`, { waitUntil: "load" });
        const evidence = await inspectPrimaryCta(page, `${server.base}/x/checkout/`);
        // Route recognition is what #321 is about; the unstyled fixture
        // anchor legitimately trips the size rule, so assert on the route
        // candidate rather than the overall verdict.
        assert.notEqual(evidence.reason, "missing_route_cta", `${fixture}: ${JSON.stringify(evidence.candidates)}`);
        assert.equal(evidence.primary?.route_matches, true, fixture);
        assert.equal(evidence.primary.text, expectedText, fixture);
        assert.equal(new URL(evidence.primary.href).pathname, "/x/checkout/", fixture);
        await page.close();
      } finally {
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }
});

// The two ways the shared rule can go wrong: honouring data-next-url on an
// element the SDK does not drive, and losing the browser's own anchor
// resolution (a <base href>) by re-parsing href attributes.
browserTest("primary-cta: data-next-url counts only on SDK controls, and a relative anchor resolves against <base href>", async () => {
  const { inspectPrimaryCta } = __qaBrowserTestHooks;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const server = await serveFixture("primary-cta-conflicts");
  try {
    const page = await browser.newPage();
    await page.goto(`${server.base}/x/landing/`, { waitUntil: "load" });
    const evidence = await inspectPrimaryCta(page, `${server.base}/x/checkout/`);
    const texts = evidence.candidates.map((candidate) => candidate.text);
    assert.equal(new Set(texts).size, texts.length, `fixture CTA texts must be unique for a by-text lookup: ${texts.join(" | ")}`);
    const byText = Object.fromEntries(evidence.candidates.map((candidate) => [candidate.text, candidate]));
    assert.equal(new URL(byText["Relative anchor to checkout"].href).pathname, "/x/checkout/", "native <base href> resolution");
    assert.equal(byText["Relative anchor to checkout"].route_matches, true);
    assert.equal(new URL(byText["Support (decoy data-next-url)"].href).pathname, "/support/", "a plain anchor's href wins over a decoy data-next-url");
    assert.equal(byText["Support (decoy data-next-url)"].route_matches, false);
    assert.equal(new URL(byText["SDK control with stray href"].href).pathname, "/x/checkout/", "an SDK control routes by data-next-url");
    assert.equal(byText["SDK control with stray href"].route_matches, true);
    assert.equal(byText["SDK control without data-next-url"].href, null, "an SDK control never navigates by href");
    assert.equal(byText["SDK control without data-next-url"].route_matches, false);
    assert.equal(new URL(byText["SDK control with origin-relative data-next-url"].href).pathname, "/checkout/", "data-next-url resolves against the origin, as the SDK does");
    assert.equal(byText["SDK control with origin-relative data-next-url"].route_matches, false);
    assert.equal(evidence.reason, "ok");
    await page.close();
  } finally {
    await server.close();
    await browser.close();
  }
});

test("fixture topology resolves a checkout the runner can drive", () => {
  const plan = resolveTestOrderTopology(topologies("http://127.0.0.1:1")[0]);
  assert.equal(plan.checkout_url, "http://127.0.0.1:1/x/checkout/");
});
