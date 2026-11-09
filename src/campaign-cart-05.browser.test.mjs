// Real-Chromium proof that browser QA reads a Campaign Cart SDK 0.5 page
// (fixtures/sdk-05): the readiness wait ends on html[data-next-ready] and
// stops on html[data-next-error], the checkout behaviour probe and the
// test-order form fill find data-next-field inputs inside a bare
// form[data-next-checkout], the card expiry is typed into card.expiry, and
// the upsell step clicks data-next-action="acceptUpsell".
//
// The pages are the committed fixture's built HTML, served from a routed fake
// origin; every other request (the jsDelivr loader among them) is aborted. A
// small inline script stands in for the SDK: it marks the page ready, writes
// the cart total, and posts the order upsell on an acceptUpsell click.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach } from "node:test";

import { browserTest } from "./readability-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";
import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

afterEach(() => assertNoNetworkAttempts());

const ORIGIN = "https://sdk05.fixture.test";
const REF = "FIXTUREREF05";
const fixture = (name) => readFileSync(new URL(`../fixtures/sdk-05/_site/example-campaign/${name}/index.html`, import.meta.url), "utf8");

// The fixture page with a stand-in SDK script before </body>.
function withSdk(html, script) {
  return html.replace("</body>", `<script>${script}</script></body>`);
}

const READY = `setTimeout(() => {
  for (const total of document.querySelectorAll('[data-next-query="cart.total"]')) total.textContent = "$39.00";
  document.documentElement.setAttribute("data-next-ready", "");
}, 200);`;

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
  assertNoNetworkAttempts();
});

async function open(path, html) {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1280, height: 900 } });
  const posts = [];
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === path) return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (request.method() === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      posts.push(url.pathname);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ref_id: REF, lines: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Next</title><p>Next</p>" });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${path}?ref_id=${REF}`, { waitUntil: "load" });
  return { context, page, posts };
}

browserTest("SDK 0.5: the readiness wait ends on html[data-next-ready] with no data-next-sdk-loading or next-display-ready", async () => {
  const { context, page } = await open("/checkout/", withSdk(fixture("checkout"), READY));
  try {
    const wait = await hooks.waitForSdkDisplayReady(page);
    assert.equal(wait.state, "ready");
    assert.ok(wait.ms < 5000, `waited ${wait.ms}ms`);
  } finally {
    await context.close();
  }
});

browserTest("SDK 0.5: the readiness wait stops at once on html[data-next-error] and names the error", async () => {
  const { context, page } = await open("/checkout/", withSdk(fixture("checkout"), 'document.documentElement.setAttribute("data-next-error", "config");'));
  try {
    const wait = await hooks.waitForSdkDisplayReady(page);
    assert.deepEqual([wait.state, wait.error], ["error", "config"]);
    assert.ok(wait.ms < 2000, `waited ${wait.ms}ms; the 15 s cap was not waited out`);
  } finally {
    await context.close();
  }
});

browserTest("SDK 0.5: the checkout behaviour probe finds the bare form[data-next-checkout], every required field by data-next-field, and the data-next-query total", async () => {
  const { context, page } = await open("/checkout/", withSdk(fixture("checkout"), READY));
  try {
    await hooks.waitForSdkDisplayReady(page);
    const behaviour = await hooks.inspectCheckoutBehaviour(page);
    assert.equal(behaviour.status, "pass", JSON.stringify(behaviour));
    assert.equal(behaviour.checkout_form.count, 1);
    assert.deepEqual(behaviour.fields_bound.missing, []);
    assert.equal(behaviour.total_visible.visible_count, 1);
    assert.equal(await hooks.hasVisibleCheckoutFields(page), true);
  } finally {
    await context.close();
  }
});

browserTest("SDK 0.5: the test-order form fill types into data-next-field inputs and card.expiry", async () => {
  const { context, page } = await open("/checkout/", withSdk(fixture("checkout"), READY));
  try {
    await hooks.waitForSdkDisplayReady(page);
    await hooks.fillCheckoutFields(page, {}, "qa@example.test", { actionTimeoutMs: 5000 });
    await hooks.fillCardExpiry(page, "12", "2030");
    const values = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("[data-next-field]"))
      .filter((field) => "value" in field && field.type !== "radio" && field.type !== "checkbox")
      .map((field) => [field.getAttribute("data-next-field"), field.value])));
    assert.deepEqual(values, {
      email: "qa@example.test",
      first_name: "QA",
      last_name: "Playwright",
      line1: "1600 Amphitheatre Pkwy",
      line2: "",
      city: "Mountain View",
      state: "CA",
      postcode: "94043",
      country: "US",
      phone_number: "",
      "card.expiry": "12 / 30",
    });
  } finally {
    await context.close();
  }
});

const UPSELL_SDK = `document.documentElement.setAttribute("data-next-ready", "");
document.querySelector('[data-next-action="acceptUpsell"]').addEventListener("click", async () => {
  await fetch("/api/v1/orders/${REF}/upsells/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  location.href = "/receipt/?ref_id=${REF}";
});
document.querySelector('[data-next-action="skipUpsell"]').addEventListener("click", () => { location.href = "/receipt/?ref_id=${REF}"; });`;

browserTest("SDK 0.5: the upsell step clicks data-next-action=\"acceptUpsell\" and sees the order upsell posted", async () => {
  const { context, page, posts } = await open("/upsell/", withSdk(fixture("upsell"), UPSELL_SDK));
  try {
    const step = await hooks.clickUpsellPath(page, "accept");
    assert.equal(step.error, undefined);
    assert.equal(step.clicked, true);
    assert.equal(posts.length, 1);
    assert.equal(step.api_response_seen, true);
    assert.match(step.final_url, /\/receipt\/\?ref_id=/);
  } finally {
    await context.close();
  }
});

browserTest("SDK 0.5: acceptUpsell and skipUpsell count as the rendered upsell controls", async () => {
  const { context, page } = await open("/upsell/", withSdk(fixture("upsell"), UPSELL_SDK));
  try {
    const rows = await hooks.renderedUpsellControlAssertions(page, {
      page_id: "upsell",
      page_type: "upsell",
      url: `${ORIGIN}/upsell/`,
      expected_accept_url: `${ORIGIN}/receipt/`,
      expected_decline_url: `${ORIGIN}/receipt/`,
    });
    assert.deepEqual(rows.map((row) => [row.status, row.evidence.selector]), [
      ["pass", '[data-next-action="acceptUpsell"]'],
      ["pass", '[data-next-action="skipUpsell"]'],
    ]);
  } finally {
    await context.close();
  }
});
