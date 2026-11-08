// Real-browser proof for `qa run --currency` on the typed-card order path:
// the runner's first load of each order path carries ?currency=<CODE>, the
// entry page is loaded as tagged, and no later runner load re-adds it. Serves
// the fixtures under fixtures/qa-cart-entry/ from a local HTTP server and
// records every page-HTML request the browser makes.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium. The
// browser-free halves are covered in qa-currency.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "./cli.mjs";
import { QA_RUN_CURRENCY, runBrowserTestOrders } from "./qa-browser.mjs";
import { __qaNodeTestHooks, runQaCli } from "./qa-node.mjs";

const { runResolvedQa, withEntryCurrency } = __qaNodeTestHooks;
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

// Serves one fixture under /x/ plus the shim, a fake orders API whose orders
// come out in `orderCurrency`, and a price-preview endpoint that answers in
// `priceCurrency` (null: the requested currency). Records each page-HTML
// request as { page, currency } in arrival order, and the currency each
// price-preview scenario asked for. /x/ serves the landing page, as a built
// site's slug root does.
async function serveFixture(name, { orderCurrency = "GBP", priceCurrency = null } = {}) {
  const dir = join(FIXTURES, name);
  const orders = [];
  const loads = [];
  const previews = [];
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
        currency: orderCurrency,
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
    if (request.method === "POST" && url.pathname === "/api/price-preview") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const { scenario } = JSON.parse(raw || "{}");
      previews.push(scenario?.currency ?? null);
      const lines = (scenario?.lines || []).map((line) => ({ package_id: line.package_id, quantity: line.quantity, discounts: [], subtotal: "19.00", original_package_price: "19.00", total_discount: "0.00", total: "19.00" }));
      const data = { lines, offer_discounts: [], voucher_discounts: [], subtotal: "19.00", total_discount: "0.00", total: "19.00", currency: priceCurrency ?? scenario?.currency };
      return send(200, JSON.stringify({ ok: true, status: 200, data, calculated_at: "2026-10-29T00:00:00.000Z" }), "application/json");
    }
    if (url.pathname === "/sdk-shim.js") {
      return send(200, await readFile(join(FIXTURES, "sdk-shim.js")), "text/javascript");
    }
    const page = /^\/x\/(?:(landing|checkout|receipt)\/?)?$/.exec(url.pathname);
    if (page) {
      const name = page[1] || "landing";
      loads.push({ page: name, currency: url.searchParams.get("currency") });
      try {
        return send(200, await readFile(join(dir, `${name}.html`), "utf8"));
      } catch {
        return send(404, "not found");
      }
    }
    return send(404, "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, orders, loads, previews, close: () => new Promise((resolve) => server.close(resolve)) };
}

function topologies(base) {
  return [{
    funnel_id: "default",
    funnel_name: "Default",
    pages: [
      { page_id: "landing", page_type: "landing", order: 1, url: `${base}/x/landing/?utm_source=newsletter`, expected_next_url: `${base}/x/checkout/` },
      { page_id: "checkout", page_type: "checkout", order: 2, url: `${base}/x/checkout/`, expected_next_url: `${base}/x/receipt/` },
      { page_id: "receipt", page_type: "receipt", order: 3, url: `${base}/x/receipt/` },
    ],
  }];
}

const ARGS = Object.freeze({
  "test-order": "checkout",
  "step-timeout-ms": 20000,
  "order-timeout-ms": 90000,
  "browser-timeout": 10000,
});

// The run as runResolvedQa hands it to the order runner: entry pages tagged,
// the validated code under QA_RUN_CURRENCY.
async function runFixture(name, currency) {
  const server = await serveFixture(name);
  try {
    const tree = currency ? withEntryCurrency(topologies(server.base), currency).topologies : topologies(server.base);
    const args = currency ? { ...ARGS, currency, [QA_RUN_CURRENCY]: currency } : { ...ARGS };
    const result = await runBrowserTestOrders(tree, args, `qa-currency-${name}`);
    return { result, loads: server.loads, orders: server.orders };
  } finally {
    await server.close();
  }
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed currency proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("landing entry: the probe (the path's first load) and the tagged entry page carry ?currency; the SDK's own hops are left alone", async () => {
  const { result, loads, orders } = await runFixture("landing-entry", "GBP");
  assert.equal(result.assertions.find((entry) => entry.id === "browser-test-order:checkout")?.status, "pass");
  assert.equal(orders.length, 1);
  assert.deepEqual(loads.slice(0, 2), [{ page: "checkout", currency: "GBP" }, { page: "landing", currency: "GBP" }]);
  // After the entry page the SDK navigates; the runner loads nothing else.
  assert.deepEqual(loads.slice(2).map((load) => load.page), ["checkout", "receipt"]);
  assert.deepEqual(loads.slice(2).map((load) => load.currency), [null, null]);
});

browserTest("checkout with its own selector: the probe is the path's only runner load and carries ?currency; checkout is not re-opened", async () => {
  const { result, loads } = await runFixture("checkout-selector", "EUR");
  assert.equal(result.assertions.find((entry) => entry.id === "browser-test-order:checkout")?.status, "pass");
  assert.deepEqual(loads, [{ page: "checkout", currency: "EUR" }, { page: "receipt", currency: null }]);
});

browserTest("control: without a run currency no load carries ?currency, and a raw --currency on args is not read", async () => {
  const plain = await runFixture("landing-entry", null);
  assert.equal(plain.loads.some((load) => load.currency !== null), false);

  const server = await serveFixture("checkout-selector");
  try {
    await runBrowserTestOrders(topologies(server.base), { ...ARGS, currency: "GBP" }, "qa-currency-raw");
    assert.equal(server.loads.some((load) => load.currency !== null), false);
  } finally {
    await server.close();
  }
});

browserTest("qa run end to end: runResolvedQa hands the runner the validated code, so `--currency gbp` loads the probe with currency=GBP", async () => {
  const server = await serveFixture("checkout-selector");
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-currency-browser-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  try {
    const spec = { schema_version: "4.3", campaign: { currency: "USD" }, funnels: [{ id: "default", pages: [{ id: "landing", type: "landing", order: 1 }, { id: "checkout", type: "checkout", order: 2 }, { id: "receipt", type: "receipt", order: 3 }] }] };
    const resolved = {
      themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Test fixture has no theme context." },
      polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Test fixture has no assembly report." },
      checkpointGates: [],
      qaWaivers: {},
      analyticsCaptureTarget: { url: null, source: "unresolved" },
      brandContract: null,
      brandContractStatus: "not_evaluated",
      packetPath,
      packet: null,
      mapId: "currency-browser-run",
      publicRouteSlug: "x",
      proxyBase: server.base,
      baseUrl: `${server.base}/x/`,
      specPath: null,
      specSource: "test",
      portalManaged: false,
      rawSpec: spec,
      spec,
      specVersion: "4.3",
      specHash: "sha256:test",
      templateFamily: null,
      commerceStructureContract: null,
      topologies: topologies(server.base),
    };
    await runResolvedQa({ _: ["qa", "run"], ...ARGS, currency: "gbp", "output-dir": outputDir, "no-post-verdict": true, "no-live-refs": true, json: true }, resolved);
    const runnerLoads = server.loads.filter((load) => load.page === "checkout");
    assert.ok(runnerLoads.length > 0, "the order path loaded the checkout");
    assert.ok(runnerLoads.some((load) => load.currency === "GBP"), JSON.stringify(server.loads));
    assert.equal(server.loads.some((load) => load.currency !== null && load.currency !== "GBP"), false);
  } finally {
    await server.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

// --- The orders and expected totals are checked against --currency (#713) --

// The fixture's checkout with a package row the commercial planner prices.
function pricedSpec() {
  return {
    schema_version: "4.3",
    campaign: { currency: "USD", campaigns_api_key: "campaign-key" },
    funnels: [{ id: "default", pages: [
      { id: "landing", type: "landing", order: 1 },
      { id: "checkout", type: "checkout", order: 2, enabled: true, packages: [{ ref_id: "1", qty: 1 }] },
      { id: "receipt", type: "receipt", order: 3 },
    ] }],
  };
}

function resolvedFor(server, packetPath, spec) {
  return {
    themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Test fixture has no theme context." },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Test fixture has no assembly report." },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath,
    packet: null,
    mapId: "currency-order-check",
    publicRouteSlug: "x",
    proxyBase: server.base,
    baseUrl: `${server.base}/x/`,
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec: spec,
    spec,
    specVersion: "4.3",
    specHash: "sha256:test",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: topologies(server.base),
  };
}

async function runQaAgainst(serverOptions, extraArgs) {
  const server = await serveFixture("checkout-selector", serverOptions);
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-currency-order-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  try {
    const result = await runResolvedQa({ _: ["qa", "run"], ...ARGS, "output-dir": outputDir, "no-post-verdict": true, "no-live-refs": true, json: true, ...extraArgs }, resolvedFor(server, packetPath, pricedSpec()));
    return { verdict: result.verdict, orders: server.orders, previews: server.previews };
  } finally {
    await server.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const row = (verdict, id) => verdict.assertions.find((entry) => entry.id === id);

browserTest("--currency GBP: an order the store places in USD is a blocker and the verdict is blocked", async () => {
  const { verdict, orders, previews } = await runQaAgainst({ orderCurrency: "USD" }, { currency: "gbp" });
  assert.equal(orders.length, 1);
  assert.equal(row(verdict, "browser-test-order:checkout")?.status, "pass", "the order itself was created");
  const currency = row(verdict, "browser-order-currency:checkout");
  assert.equal(currency?.status, "fail");
  assert.equal(currency?.severity, "blocker");
  assert.deepEqual(currency?.evidence, { requested: "GBP", order_currency: "USD" });
  assert.equal(verdict.disposition, "blocked");
  assert.ok(previews.length > 0 && previews.every((code) => code === "GBP"), JSON.stringify(previews));
});

browserTest("--currency GBP: a GBP order passes its currency row, with expected totals requested in GBP", async () => {
  const { verdict, previews } = await runQaAgainst({ orderCurrency: "GBP" }, { currency: "GBP" });
  assert.equal(row(verdict, "browser-order-currency:checkout")?.status, "pass");
  assert.equal(verdict.assertions.some((entry) => entry.id.startsWith("commercial-currency:")), false);
  assert.ok(previews.length > 0 && previews.every((code) => code === "GBP"), JSON.stringify(previews));
});

browserTest("control: without --currency a USD order gets no currency row and expected totals ask for the campaign currency", async () => {
  const { verdict, previews } = await runQaAgainst({ orderCurrency: "USD" }, {});
  assert.equal(row(verdict, "browser-test-order:checkout")?.status, "pass");
  assert.equal(verdict.assertions.some((entry) => entry.id.startsWith("browser-order-currency:")), false);
  assert.ok(previews.length > 0 && previews.every((code) => code === "USD"), JSON.stringify(previews));
});

// Through the CLI: `qa run --site` builds the topology from a _site/<slug>/
// tree, so the exit code is the one an operator sees.
async function cliExitCode(orderCurrency) {
  const server = await serveFixture("checkout-selector", { orderCurrency });
  const repo = mkdtempSync(join(tmpdir(), "campaigns-os-qa-currency-cli-"));
  for (const [route, file] of [["", "landing"], ["checkout", "checkout"], ["receipt", "receipt"]]) {
    const dir = route ? join(repo, "_site", "x", route) : join(repo, "_site", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), readFileSync(join(FIXTURES, "checkout-selector", `${file}.html`), "utf8"));
  }
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  try {
    const result = await runQaCli(parseArgs([
      "qa", "run", "--site", repo, "--base-url", server.base, "--family", "olympus", "--slug", "x",
      "--currency", "GBP", "--test-order", "checkout", "--test-country", "US",
      "--step-timeout-ms", "20000", "--order-timeout-ms", "90000", "--browser-timeout", "10000",
      "--output-dir", join(repo, "qa-output"), "--no-post-verdict", "--no-remit", "--no-live-refs", "--json",
    ]));
    return { exitCode: process.exitCode, verdict: result.verdict, orders: server.orders.length };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    await server.close();
    rmSync(repo, { recursive: true, force: true });
  }
}

browserTest("qa run --site --currency GBP exits 4 when the order comes out in USD", async () => {
  const usd = await cliExitCode("USD");
  assert.equal(usd.orders, 1, JSON.stringify(row(usd.verdict, "browser-test-order:checkout")?.actual));
  assert.equal(row(usd.verdict, "browser-order-currency:checkout")?.severity, "blocker");
  assert.equal(usd.exitCode, 4);

  // The same run with a GBP order: the currency row passes, and the CLI's
  // exit code follows whatever else the verdict holds.
  const gbp = await cliExitCode("GBP");
  assert.equal(row(gbp.verdict, "browser-order-currency:checkout")?.status, "pass");
  assert.equal(gbp.exitCode, gbp.verdict.disposition === "blocked" ? 4 : 0);
});
