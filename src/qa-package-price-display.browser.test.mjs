// Real-browser proof that QA reads package.price as the shopper does. The pages
// carry a stand-in for the SDK's product display: it writes the price and adds
// `display-visible`, as the SDK does, after a delay. The page's price reaches
// commercial parity through a real `qa run --browser`, against a local server
// and a stubbed calculate endpoint, so nothing leaves the machine.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";

const { readRenderedPackagePrices } = __qaBrowserTestHooks;

let browser = null;

async function sharedBrowser() {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  return browser;
}

after(async () => {
  if (browser) await browser.close();
  browser = null;
});

async function chromiumAvailable() {
  try {
    await sharedBrowser();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

const browserTest = (name, body) => test(name, async (t) => {
  if (!await chromiumAvailable()) {
    t.skip("Chromium is not available");
    return;
  }
  await body();
});

function fillAfter(ms, text) {
  return `<script>
    setTimeout(() => {
      for (const node of document.querySelectorAll('[data-fill]')) {
        node.textContent = ${JSON.stringify(text)};
        node.classList.add("display-visible");
      }
    }, ${ms});
  </script>`;
}

async function readFrom(html, options) {
  const page = await (await sharedBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    return await readRenderedPackagePrices(page, options);
  } finally {
    await page.close();
  }
}

browserTest("a placeholder the SDK has not filled reads as unfilled, with no text, however plausible it looks", async () => {
  assert.deepEqual(await readFrom(`
    <div data-next-package-id="3"><span data-next-display="package.price" data-next-format="currency">$9.99</span></div>
  `, { timeoutMs: 200 }), [{ binding: "package.price", package_id: 3, filled: false, text: null }]);
});

browserTest("the read waits for a slow fill, so a placeholder still on screen at load is not what it reports", async () => {
  assert.deepEqual(await readFrom(`
    <div data-next-package-id="3"><span data-fill data-next-display="package.price" data-next-format="currency">$9.99</span></div>
    ${fillAfter(400, "$49.99")}
  `, { timeoutMs: 5000 }), [{ binding: "package.price", package_id: 3, filled: true, text: "$49.99" }]);
});

browserTest("scope follows the SDK, and repeated prices are one claim", async () => {
  const claims = await readFrom(`
    <div data-next-package-id="3">
      <span class="display-visible" data-next-display="package.price">$49.99</span>
      <span class="display-visible" data-next-display="package.price">$49.99</span>
      <span class="display-visible" data-next-display="package.8.price">$19.99</span>
      <span class="display-visible" data-next-display="package.price" data-next-package-id="4">$29.99</span>
    </div>
    <span class="display-visible" data-next-display="package.price">$1.00</span>
  `, { timeoutMs: 200 });
  assert.deepEqual(claims, [
    { binding: "package.price", package_id: 3, filled: true, text: "$49.99" },
    { binding: "package.8.price", package_id: 8, filled: true, text: "$19.99" },
    { binding: "package.price", package_id: 4, filled: true, text: "$29.99" },
    { binding: "package.price", package_id: null, filled: true, text: "$1.00" },
  ]);
});

browserTest("a price no shopper reads as the price is not a claim, and an empty unfilled one still is", async () => {
  const claims = await readFrom(`
    <div data-next-package-id="3">
      <span style="display:none" data-next-display="package.price">$1.00</span>
      <div style="visibility:hidden"><span data-next-display="package.price">$2.00</span></div>
      <del><span class="display-visible" data-next-display="package.price">$3.00</span></del>
      <span class="display-visible" data-next-display="package.price" data-next-format="number">4</span>
      <span class="display-visible" data-next-display="package.price_retail">$5.00</span>
      <span class="display-visible" data-next-display="package.name">Knife</span>
    </div>
    <div data-next-package-id="6"><span data-next-display="package.price"></span></div>
    <div data-next-package-id="7"><span class="display-visible" data-next-multiply-quantity data-next-display="package.price">$7.00</span></div>
  `, { timeoutMs: 200 });
  assert.deepEqual(claims, [
    { binding: "package.price", package_id: 6, filled: false, text: null },
    { binding: "package.price", package_id: 7, filled: true, text: null },
  ]);
});

const UPSELL_SOURCE = (fill) => `<!doctype html><html><head><title>Upsell</title></head><body>
  <section data-next-upsell="offer" data-next-package-id="3">
    <p>Yours Today <span data-fill data-next-display="package.price" data-next-format="currency">$9.99</span></p>
    <a data-next-upsell-action="add" href="#">Yes, add it for <span data-fill data-next-display="package.price" data-next-format="currency">$9.99</span></a>
  </section>${fill}</body></html>`;

async function qaRunOver(html, { browser: useBrowser = true } = {}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pageUrl = `${origin}/upsell/`;
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-package-price-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  const spec = {
    schema_version: "4.3",
    campaign: { campaigns_api_key: "campaign-secret", currency: "USD" },
    funnels: [{ id: "default", pages: [{ id: "upsell", type: "upsell", order: 1, enabled: true, packages: [{ ref_id: "3", qty: 1 }] }] }],
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/api/price-preview")) {
      const { scenario } = JSON.parse(options.body);
      const lines = scenario.lines.map((line) => ({ package_id: line.package_id, quantity: line.quantity, discounts: [], original_unit_price: "59.99", unit_price: "49.99", subtotal: "59.99", original_package_price: "59.99", total_discount: "10.00", total: "49.99" }));
      return new Response(JSON.stringify({ ok: true, status: 200, data: { lines, offer_discounts: [], voucher_discounts: [], subtotal: "59.99", total_discount: "10.00", total: "49.99", currency: "USD" }, calculated_at: "2026-11-07T00:00:00.000Z" }), { status: 200 });
    }
    if (url.startsWith(origin)) return previous(input, options);
    return new Response(JSON.stringify({ ok: false, status: 404 }), { status: 404 });
  };
  try {
    return await __qaNodeTestHooks.runResolvedQa({
      _: ["qa", "run"],
      ...(useBrowser ? { browser: true, "browser-timeout": 10000 } : {}),
      "output-dir": outputDir,
      "no-post-verdict": true,
      "no-remit": true,
    }, {
      themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Synthetic fixture." },
      polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Synthetic fixture." },
      checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null, source: "unresolved" },
      brandContract: null, brandContractStatus: "not_evaluated", packetPath, packet: null,
      mapId: "package-price", publicRouteSlug: "package-price", proxyBase: "https://proxy.example.test",
      baseUrl: `${origin}/`, specPath: null, specSource: "test", portalManaged: false,
      rawSpec: spec, spec, specVersion: "4.3", specHash: "sha256:fixture", templateFamily: null,
      commerceStructureContract: null,
      topologies: [{ funnel_id: "default", funnel_name: "Default", weight: 100, pages: [{ page_id: "upsell", page_type: "upsell", label: "Upsell", url: pageUrl, packages: spec.funnels[0].pages[0].packages }] }],
    });
  } finally {
    globalThis.fetch = previous;
    await new Promise((resolve) => server.close(resolve));
    rmSync(outputDir, { recursive: true, force: true });
  }
}

browserTest("qa run --browser compares the filled price, never the placeholder in the source", async () => {
  const { verdict } = await qaRunOver(UPSELL_SOURCE(fillAfter(300, "$49.99")));
  assert.equal(verdict.commercial.status, "pass");
  assert.deepEqual(verdict.commercial.package_price_claims, { extracted: 1, compared: 1, unresolved: {} });
  assert.equal(verdict.commercial.finding_count, 0);
  assert.equal(verdict.exceptions.some((entry) => entry.family === "pricing"), false);
});

browserTest("qa run --browser warns when the filled price is not what calculate charges", async () => {
  const { verdict, ok } = await qaRunOver(UPSELL_SOURCE(fillAfter(100, "$59.99")));
  assert.equal(verdict.commercial.status, "mismatch");
  assert.equal(ok, verdict.disposition !== "blocked");
  const row = verdict.exceptions.find((entry) => entry.id === "price-claim-mismatch:upsell:package.3.price");
  assert.deepEqual([row.status, row.severity, row.expected, row.actual], ["warn", "warn", "49.99", "59.99"]);
});

browserTest("qa run --browser names a price the SDK never filled instead of comparing the placeholder", async () => {
  const { verdict } = await qaRunOver(UPSELL_SOURCE(""));
  assert.equal(verdict.commercial.status, "incomplete");
  assert.equal(verdict.commercial.finding_count, 0);
  assert.ok(verdict.exceptions.some((entry) => entry.id === "commercial-parity:incomplete:package_price_not_filled"));
});
