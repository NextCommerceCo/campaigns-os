// Real-browser proof that `qa run --browser` binds each page by the key the
// Campaign Cart SDK sends, not only by what the page declares. The pages load
// the starter templates' config.js shape (it opens with dataLayer/nextReady
// guards, which the static read cannot resolve) and a stand-in for the SDK
// that calls the Campaigns API with that key as `Authorization`. Every
// request is answered by a context route, so nothing leaves the machine:
// `playwright` is resolved to a wrapper that installs the route on each
// browser context.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

const PLAYWRIGHT_URL = import.meta.resolve("playwright");
const WRAPPER = `
import { chromium as real } from ${JSON.stringify(PLAYWRIGHT_URL)};
export const chromium = {
  async launch(options) {
    const browser = await real.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await newContext(contextOptions);
      await context.route("**/*", globalThis.__pageBindingTestRoute);
      return context;
    };
    return browser;
  },
};
`;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "playwright") return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(WRAPPER)}`)}, shortCircuit: true };
  return next(specifier, context);
}
`)}`);

const { runBrowserChecks } = await import("./qa-browser.mjs");
const { __qaNodeTestHooks } = await import("./qa-node.mjs");

async function chromiumAvailable() {
  try {
    const { chromium } = await import(PLAYWRIGHT_URL);
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

const KEY = "binding-browser-canary-4Rq8Lz2W";
const ORIGIN = "https://binding.example.test";
// Matched by its `campaigns.apps` host label; the SDK's own host is not named here.
const API = "https://campaigns.apps.example.test/api/v1/campaigns/";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };

// The key each page's config declares and its SDK sends. Pages not listed
// load no SDK. Keys stay out of URLs: a page URL is recorded in the verdict.
const SENDS = { landing: KEY, offer: "another-key" };
const pageName = (url) => url.pathname.split("/").filter(Boolean)[0] || "";
const config = (key) => `window.dataLayer = window.dataLayer || [];\nwindow.nextReady = window.nextReady || [];\nwindow.nextConfig = { apiKey: ${JSON.stringify(key)} };\n`;
function pageHtml(url) {
  const sdk = SENDS[pageName(url)] ? `<script src="config.js"></script><script>fetch(${JSON.stringify(API)}, { headers: { Authorization: window.nextConfig.apiKey } });</script>` : "";
  return `<!doctype html><html><head><title>Offer</title>${sdk}</head><body><h1>Offer</h1></body></html>`;
}
const isConfig = (url) => url.pathname.endsWith("/config.js");

globalThis.__pageBindingTestRoute = (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.href.startsWith(API)) {
    return route.fulfill(request.method() === "OPTIONS"
      ? { status: 204, headers: CORS }
      : { status: 200, contentType: "application/json", headers: CORS, body: "{}" });
  }
  if (url.origin === ORIGIN && isConfig(url)) return route.fulfill({ status: 200, contentType: "application/javascript", body: config(SENDS[pageName(url)]) });
  if (url.origin === ORIGIN) return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(url) });
  return route.fulfill({ status: 404, body: "" });
};

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed page-binding proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("qa run --browser binds a starter-shaped page by the key the SDK sent, replacing the static read", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "binding-browser-"));
  const page = { page_id: "landing", page_type: "landing", url: `${ORIGIN}/landing/` };
  const spec = { schema_version: "4.3", campaign: { slug: "binding-browser", campaigns_api_key: KEY }, funnels: [] };
  const previous = globalThis.fetch;
  // The static read fetches the page and its config outside the browser.
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/campaign") return new Response(JSON.stringify({ ok: false, status: 404, upstream_shape: "array", error: "No campaign found for this key" }), { status: 404 });
    if (isConfig(url)) return new Response(config(SENDS[pageName(url)]));
    return new Response(pageHtml(url));
  };
  try {
    const result = await __qaNodeTestHooks.runResolvedQa({ _: ["qa", "run"], browser: true, "browser-timeout": 10000, "output-dir": outputDir, "no-post-verdict": true, "no-remit": true }, {
      themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Synthetic fixture." },
      polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Synthetic fixture." },
      checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null, source: "unresolved" },
      brandContract: null, brandContractStatus: "not_evaluated", packetPath: null, packet: null,
      mapId: "binding-browser", publicRouteSlug: "binding-browser", proxyBase: ORIGIN,
      baseUrl: `${ORIGIN}/`, specPath: null, specSource: "test", portalManaged: false,
      rawSpec: spec, spec, specVersion: "4.3", specHash: "sha256:fixture", templateFamily: null,
      commerceStructureContract: null, topologies: [{ funnel_id: "default", pages: [page] }],
    });
    const rows = result.verdict.assertions.filter((entry) => entry.id.startsWith("page-binding:"));
    assert.equal(rows.length, 1, "one row per page: the browser observation replaces the static read");
    assert.equal(rows[0].status, "pass");
    assert.deepEqual(
      { observation: rows[0].evidence.observation, outcome: rows[0].evidence.outcome, source_kinds: rows[0].evidence.source_kinds },
      { observation: "sdk_request", outcome: "match", source_kinds: ["sdk_request"] },
    );
    assert.equal(JSON.stringify(result).includes(KEY), false);
  } finally {
    globalThis.fetch = previous;
    rmSync(outputDir, { recursive: true, force: true });
  }
});

browserTest("a page whose SDK sends another key is a blocker; a page that sends nothing keeps its static read", async () => {
  const pages = [
    { page_id: "offer", page_type: "landing", url: `${ORIGIN}/offer/` },
    { page_id: "about", page_type: "landing", url: `${ORIGIN}/about/` },
  ];
  const assertions = await runBrowserChecks([{ funnel_id: "default", pages }], { "browser-timeout": 10000 }, { bindingExpected: { value: KEY } });
  const offer = assertions.find((entry) => entry.id === "page-binding:offer");
  assert.equal(offer.status, "fail");
  assert.equal(offer.severity, "blocker");
  assert.equal(offer.evidence.observation, "sdk_request");
  assert.equal(assertions.some((entry) => entry.id === "page-binding:about"), false);
  assert.equal(JSON.stringify(assertions).includes("another-key"), false);
  assert.equal(JSON.stringify(assertions).includes(KEY), false);
});
