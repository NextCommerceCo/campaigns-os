// Real-browser proof that browser QA ignores the Netlify deploy-preview
// drawer's failed loader request, and only that (#535). Each case drives the
// exported `runBrowserChecks` entry point through Playwright Chromium, the
// same path `qa run --browser` takes. Every request is answered by a context
// route, so the preview hosts below never leave the machine: `playwright` is
// resolved to a wrapper that installs the route on each browser context.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the whole file skips
// when it cannot launch locally. The browser CI lane requires Chromium.

import test from "node:test";
import assert from "node:assert/strict";
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
      await context.route("**/*", globalThis.__netlifyDrawerTestRoute);
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

const DRAWER_LOADER = "https://netlify-cdp-loader.netlify.app/netlify.js";

// Each page loads the scripts named in its `load` query parameter; every
// script answers 428, so each one logs a "Failed to load resource" error.
// A page with a `redirect` parameter sends the browser on to that URL with
// `location.replace` (a routed HTTP 302 would leave the route: Playwright does
// not intercept the redirected request).
globalThis.__netlifyDrawerTestRoute = (route) => {
  const url = new URL(route.request().url());
  const redirect = url.searchParams.get("redirect");
  if (redirect) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><script>location.replace(${JSON.stringify(redirect)})</script></head></html>` });
  const scripts = url.searchParams.getAll("load");
  if (!scripts.length) return route.fulfill({ status: 428, body: "" });
  const tags = scripts.map((src) => `<script src="${src}"></script>`).join("");
  return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><title>offer</title></head><body><h1>Offer</h1>${tags}</body></html>` });
};

function withScripts(pageUrl, scripts) {
  const url = new URL(pageUrl);
  for (const src of scripts) url.searchParams.append("load", src);
  return url.href;
}

async function consoleErrorsFor(pageUrl, scripts) {
  return consoleErrorsAt(withScripts(pageUrl, scripts));
}

async function consoleErrorsAt(url) {
  const page = { page_id: "offer", page_type: "landing", order: 1, url };
  const assertions = await runBrowserChecks([{ funnel_id: "default", funnel_name: "Default", pages: [page] }], { "browser-timeout": 10000 });
  return assertions.find((entry) => entry.id === "browser-console-errors:offer")?.evidence.messages || [];
}

const FAILED_428 = /^Failed to load resource: the server responded with a status of 428\b/;

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed Netlify drawer proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("the Netlify drawer loader's failed request is ignored on a *.netlify.app preview page", async () => {
  assert.deepEqual(await consoleErrorsFor("https://deploy-preview-7--shop-example.netlify.app/offer/", [DRAWER_LOADER]), []);
  assert.deepEqual(await consoleErrorsFor("https://shop-example.netlify.app/offer/", [DRAWER_LOADER]), []);
});

browserTest("the Netlify drawer loader's failed request is ignored on a deploy-preview subdomain of a custom domain", async () => {
  for (const pageUrl of ["https://deploy-preview-7.shop.example.com/offer/", "https://deploy-preview-7--shop.example.com/offer/"]) {
    assert.deepEqual(await consoleErrorsFor(pageUrl, [DRAWER_LOADER]), [], pageUrl);
  }
});

browserTest("any other failed request on a Netlify host still counts on a preview page", async () => {
  for (const pageUrl of ["https://deploy-preview-7--shop-example.netlify.app/offer/", "https://deploy-preview-7.shop.example.com/offer/"]) {
    const origin = new URL(pageUrl).origin;
    const messages = await consoleErrorsFor(pageUrl, [
      DRAWER_LOADER,
      "https://app.netlify.com/api/cart",
      "https://netlify-cdp-loader.netlify.app/other-resource.js",
      `${origin}/api/cart`,
    ]);
    assert.equal(messages.length, 3, `${pageUrl}: ${JSON.stringify(messages)}`);
    for (const message of messages) assert.match(message, FAILED_428);
  }
});

browserTest("the drawer loader's failed request still counts on a page that is not a Netlify preview host", async () => {
  for (const pageUrl of ["https://shop.example.com/offer/", "https://preview-7.shop.example.com/offer/", "https://deploy-preview-next.shop.example.com/offer/"]) {
    const messages = await consoleErrorsFor(pageUrl, [DRAWER_LOADER]);
    assert.equal(messages.length, 1, `${pageUrl}: ${JSON.stringify(messages)}`);
    assert.match(messages[0], FAILED_428);
  }
});

browserTest("the drawer loader's failed request still counts when a preview URL redirects off the Netlify preview host", async () => {
  const preview = new URL("https://deploy-preview-7--shop-example.netlify.app/offer/");
  preview.searchParams.set("redirect", withScripts("https://shop.example.com/offer/", [DRAWER_LOADER]));
  const messages = await consoleErrorsAt(preview.href);
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.match(messages[0], FAILED_428);
});
