// Real-browser proof for the accepted-upsell proof when an upsell mutation's
// body loads late (campaigns-os#505). Each case serves the fixtures under
// fixtures/qa-upsell-correlation/ from a local HTTP server and drives the
// actual `runBrowserTestOrders` entry point through Playwright Chromium: the
// same code path `qa run --test-order` takes.
//
// 1. Two upsell steps, on separate pages (/x/upsell-a/ then /x/upsell-b/, a
//    client-side stepper), post to the same order-upsells URL. Step A's body
//    is held until step B posts, so it lands during B's wait for B's own late
//    body. It must not be taken as B's.
// 2. A single accept whose body never loads and that nothing reads back is
//    unverified. The order the run reports must not read as verified.
// 3. An earlier step's mutation whose waiter expired answers only after this
//    step's click. This step's waiter must not take it as its own response.
// 4. The accept's order upsell POST is redirected (307). The step is judged
//    from the redirect chain's final response, a late final body is matched
//    to the step by the chain's root request, and a chain with no final
//    response is not taken as answered (campaigns-os#516).
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { __qaBrowserTestHooks as hooks, runBrowserTestOrders } from "./qa-browser.mjs";
import { summarizePurchaseProof } from "./qa-verdict.mjs";

const FIXTURES = new URL("../fixtures/qa-upsell-correlation/", import.meta.url).pathname;

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

// `steps` are the offer letters the stepper shows; `receiptReadBack` is
// whether the receipt reads the order back. Every upsell mutation answers 201
// headers at once and holds its body: the previous one's body is released
// when the next mutation arrives, and the last one's never.
async function serveFixture({ steps, receiptReadBack }) {
  const orders = [];
  const upsellPosts = [];
  const held = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, body, type = "text/html; charset=utf-8") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    const upsells = /^\/api\/v1\/orders\/([^/]+)\/upsells\/$/.exec(url.pathname);
    if (request.method === "POST" && upsells) {
      for await (const chunk of request) void chunk;
      const order = orders.find((candidate) => candidate.ref_id === upsells[1]);
      const letter = steps[upsellPosts.length] || "x";
      upsellPosts.push(Date.now());
      // The earlier mutation's body lands now, while this one waits.
      const previous = held.pop();
      if (previous) previous.end(`${JSON.stringify(previous.body)}\n`);
      order.lines.push({ product_title: `Add-on ${letter.toUpperCase()}`, quantity: 1, is_upsell: true, price_incl_tax: "12.00" });
      const body = structuredClone(order);
      setTimeout(() => {
        response.writeHead(201, { "content-type": "application/json" });
        response.write(" ");
        held.push({ end: (text) => response.end(text), body });
      }, previous ? 300 : 0);
      return undefined;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/orders/") {
      for await (const chunk of request) void chunk;
      const order = {
        ref_id: `ref-${orders.length + 1}`,
        number: `${1000 + orders.length + 1}`,
        is_test: true,
        currency: "USD",
        total_incl_tax: "19.00",
        lines: [{ product_title: "Package 1", quantity: 1, is_upsell: false, price_incl_tax: "19.00" }],
      };
      orders.push(order);
      return send(201, JSON.stringify(order), "application/json");
    }
    const detail = /^\/api\/v1\/orders\/([^/]+)\/$/.exec(url.pathname);
    if (request.method === "GET" && detail) {
      const order = orders.find((candidate) => candidate.ref_id === detail[1]);
      return order ? send(200, JSON.stringify(order), "application/json") : send(404, "{}", "application/json");
    }
    if (url.pathname === "/shim.js") return send(200, await readFile(join(FIXTURES, "shim.js")), "text/javascript");
    if (url.pathname === "/x/checkout/") return send(200, await readFile(join(FIXTURES, "checkout.html")));
    if (/^\/x\/upsell-[a-z]\/$/.test(url.pathname)) {
      return send(200, (await readFile(join(FIXTURES, "upsell.html"), "utf8")).replace("__STEPS__", steps.join(",")));
    }
    if (url.pathname === "/x/receipt/") {
      const order = orders.find((candidate) => candidate.ref_id === url.searchParams.get("ref_id"));
      const rows = (order?.lines || []).map((line) => `<div data-next-order-item>${line.product_title} x${line.quantity}</div>`).join("");
      return send(200, (await readFile(join(FIXTURES, "receipt.html"), "utf8"))
        .replace("__READ_BACK__", receiptReadBack ? "yes" : "no")
        .replace("__ROWS__", rows));
    }
    return send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    orders,
    upsellPosts,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function topologies(base, steps) {
  const offerUrl = (index) => (index < steps.length ? `${base}/x/upsell-${steps[index]}/` : `${base}/x/receipt/`);
  const pages = [
    { page_id: "checkout", page_type: "checkout", order: 1, url: `${base}/x/checkout/`, expected_next_url: offerUrl(0) },
    ...steps.map((letter, index) => ({
      page_id: `upsell-${letter}`,
      page_type: "upsell",
      order: index + 2,
      url: offerUrl(index),
      expected_accept_url: offerUrl(index + 1),
      expected_decline_url: offerUrl(index + 1),
    })),
    { page_id: "receipt", page_type: "receipt", order: steps.length + 2, url: `${base}/x/receipt/` },
  ];
  return [{ funnel_id: "default", funnel_name: "Default", pages }];
}

async function runFixture({ steps, receiptReadBack, stepTimeoutMs }) {
  const server = await serveFixture({ steps, receiptReadBack });
  const path = steps.map(() => "accept").join("-");
  try {
    const result = await runBrowserTestOrders(topologies(server.base, steps), {
      "test-order": path,
      "step-timeout-ms": stepTimeoutMs,
      "order-timeout-ms": 150000,
      "browser-timeout": 10000,
    }, `qa-upsell-correlation-${path}`);
    const assertion = result.assertions.find((entry) => entry.id === `browser-test-order:${path}`);
    return { result, order: result.orders[0], assertion, server };
  } finally {
    await server.close();
  }
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed upsell correlation proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("an earlier upsell step's body landing during the next step's wait is not taken as that step's late body", { timeout: 150000 }, async () => {
  const { order, assertion, server } = await runFixture({ steps: ["a", "b"], receiptReadBack: true, stepTimeoutMs: 25000 });

  assert.equal(server.orders.length, 1, "exactly one order was posted");
  assert.equal(server.upsellPosts.length, 2, "each step posted the order upsell mutation once");
  const [stepA, stepB] = order.upsell_steps;
  assert.equal(stepA.api_response_body_read?.timed_out, true, "step A's body read hit the bound");
  assert.equal(stepB.api_response_body_read?.timed_out, true, "step B's body read hit the bound");
  // Step A's body (base line and A's line, no B line) landed while step B
  // waited. Judged as B's, it reads "no new upsell line" and fails B.
  assert.equal(stepB.late_evidence?.source, "order_read_back", `step B was judged from ${stepB.late_evidence?.source}`);
  assert.equal(stepB.verification.accepted_upsell_line_present, true);
  assert.equal(assertion.status, "pass", assertion.actual);
});

browserTest("an accepted upsell nothing could verify is not reported as a verified order", { timeout: 150000 }, async () => {
  const { order, assertion, server } = await runFixture({ steps: ["a"], receiptReadBack: false, stepTimeoutMs: 18000 });

  assert.equal(server.orders.length, 1, "exactly one order was posted: an unverified upsell is not re-run");
  assert.equal(server.upsellPosts.length, 1);
  assert.equal(order.upsell_steps[0].late_evidence?.source, "none");
  assert.equal(assertion.status, "manual_review", assertion.actual);
  assert.match(assertion.actual, /accepted upsell unverified/);
  // What a reader of the order alone sees.
  assert.equal(order.verification.accepted_upsell_line_present, null);
  assert.notEqual(order.verification.verified, true, "an order whose accepted upsell is unverified is not a verified order");
  assert.equal(summarizePurchaseProof({ verdict: { test_orders: [order] } }).orders_verified, 0);
  assert.equal(summarizePurchaseProof({ verdict: { test_orders: [order] } }).orders_created, 1);
});

// Step A's request is posted on load and held; step B's click posts; the
// server then answers A first and B 200ms later. Both carry a marker body.
async function serveStaleWaiter() {
  const REF = "FIXTUREREF6";
  const posts = [];
  let heldA = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const { offer } = JSON.parse(raw || "{}");
      posts.push(offer);
      const answer = () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ref_id: REF, offer }));
      };
      if (offer === "a") {
        heldA = answer;
        return undefined;
      }
      heldA?.();
      setTimeout(answer, 200);
      return undefined;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(await readFile(join(FIXTURES, "stale-waiter.html")));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/x/upsell-b/?ref_id=${REF}`,
    posts,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

browserTest("an earlier step's mutation answering after this step's click is not taken as this step's response", { timeout: 60000 }, async () => {
  const server = await serveStaleWaiter();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url, { waitUntil: "load" });
    // A's request is in flight before this step's click.
    for (let waited = 0; server.posts.length < 1 && waited < 5000; waited += 50) await page.waitForTimeout(50);
    assert.deepEqual(server.posts, ["a"], "step A's mutation was posted before step B's click");

    const step = await hooks.clickUpsellPath(page, "accept");

    assert.deepEqual(server.posts, ["a", "b"]);
    assert.equal(step.api_response_seen, true, "step B's own response is still taken");
    assert.equal(step.api_response_status, 201);
    assert.equal(step.api_response_order_body?.offer, "b", `step B took the response to offer ${step.api_response_order_body?.offer}`);
  } finally {
    await browser.close();
    await server.close();
  }
});

// The order upsell POST answers 307 to a relay URL outside the order-upsells
// pattern, and the browser re-posts there. `final` is how the relay answers:
// "prompt" (201 with the order body), "late" (201 headers at once, the body
// only after the bounded read gave up), or "drop" (the connection is reset,
// so the redirect chain has no final response).
async function serveRedirect({ final }) {
  const REF = "FIXTUREREF7";
  const hops = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      for await (const chunk of request) void chunk;
      hops.push("upsells");
      response.writeHead(307, { location: `/api/v1/orders/${REF}/upsells-relay/` });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells-relay/`) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      hops.push("relay");
      if (final === "drop") return request.socket.destroy();
      const body = JSON.stringify({ ref_id: REF, offer: JSON.parse(raw || "{}").offer, hop: "final" });
      response.writeHead(201, { "content-type": "application/json" });
      if (final === "prompt") return response.end(body);
      response.write(" ");
      setTimeout(() => response.end(body), hooks.RESPONSE_BODY_READ_TIMEOUT_MS + 1500);
      return undefined;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(await readFile(join(FIXTURES, "redirect.html")));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/x/upsell-b/?ref_id=${REF}`,
    hops,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

async function withRedirectPage(final, run) {
  const server = await serveRedirect({ final });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const events = hooks.captureCheckoutEvents(page);
    await page.goto(server.url, { waitUntil: "load" });
    await run({ page, events, server });
  } finally {
    await browser.close();
    await server.close();
  }
}

browserTest("a redirected order upsell mutation is judged from the redirect chain's final response", { timeout: 60000 }, async () => {
  await withRedirectPage("prompt", async ({ page, server }) => {
    const step = await hooks.clickUpsellPath(page, "accept");

    assert.deepEqual(server.hops, ["upsells", "relay"], "the browser followed the 307 and re-posted");
    assert.equal(step.api_response_seen, true);
    assert.equal(step.api_response_status, 201, `step took the HTTP ${step.api_response_status} hop`);
    assert.equal(step.api_response_order_body?.hop, "final");
    assert.equal(step.api_response_order_body?.offer, "b");
  });
});

browserTest("a redirected mutation's late body is matched to this step by the root of its redirect chain", { timeout: 90000 }, async () => {
  await withRedirectPage("late", async ({ page, events }) => {
    const responseIndexBefore = events.responses.length;
    const step = await hooks.clickUpsellPath(page, "accept");

    assert.equal(step.api_response_status, 201, `step took the HTTP ${step.api_response_status} hop`);
    assert.equal(step.api_response_body_read?.timed_out, true, "the final hop's body read hit the bound");
    const late = await hooks.waitForLateUpsellEvidence(events, {
      responseIndexBefore,
      mutationRequest: step[hooks.REQUEST_IDENTITY] || null,
      mutationRespondedAt: step.mutation_responded_at,
      initialLineItems: [],
      expectedItems: [],
      timeoutMs: 10000,
    });
    assert.equal(late.source, "late_upsell_body");
    assert.equal(late.body?.hop, "final");
    assert.equal(late.body?.offer, "b");
  });
});

browserTest("a redirected mutation with no final response is not taken as answered", { timeout: 90000 }, async () => {
  await withRedirectPage("drop", async ({ page, server }) => {
    const step = await hooks.clickUpsellPath(page, "accept");

    // Chromium may retry the reset relay post; no attempt answers it.
    assert.equal(server.hops[0], "upsells");
    assert.ok(server.hops.slice(1).length >= 1 && server.hops.slice(1).every((hop) => hop === "relay"), server.hops.join(","));
    assert.equal(step.api_response_seen, false, `step took the HTTP ${step.api_response_status} hop as the mutation's answer`);
    assert.equal(step.api_response_status, null);
    assert.equal(step.api_response_order_body, null);
    assert.equal(step[hooks.REQUEST_IDENTITY], undefined, "no request identity to match a late body against");
  });
});
