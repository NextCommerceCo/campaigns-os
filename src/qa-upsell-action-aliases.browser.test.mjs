// The SDK's upsell handler accepts the offer on data-next-upsell-action="add"
// or "accept" and declines it on "skip" or "decline". Real-Chromium proof that
// QA locates an upsell control written in either spelling the same way: the
// test-order upsell step clicks it, the rendered upsell-control rows count it
// and the primary-CTA check takes it as the route control. A value the SDK
// does not read ("maybe") is still no control anywhere.
//
// The test-order rows serve the offer from a routed fake origin, as
// qa-upsell-decline-proxy.browser.test.mjs does; the page-check rows serve a
// stub page on 127.0.0.1 and run runBrowserChecks (the `qa run --browser`
// entry) over it, as qa-primary-cta-routes.browser.test.mjs does.
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";

import { browserTest, htmlPage, respond } from "./readability-harness.browser.test.mjs";
import { stubOrigin } from "./polish-media-weight-harness.browser.test.mjs";
import { assertNoNetworkAttempts } from "./qc-test-factories.mjs";
import { __qaBrowserTestHooks as hooks, runBrowserChecks } from "./qa-browser.mjs";

afterEach(() => assertNoNetworkAttempts());

const ORIGIN = "https://aliases.fixture.test";
const REF = "FIXTUREREF1";
const BOX = "display:inline-block;width:280px;height:48px;line-height:48px;text-align:center;text-decoration:none;font-family:sans-serif;font-size:16px;font-weight:700;color:#ffffff;background:#111111;border:0";

// A single offer whose accept and decline are SDK actions in the given
// spellings on href="#" links. The script stands in for the SDK: the accept
// posts the order upsell and goes to the receipt, the decline goes to the
// downsell. `hideDecline` keeps the in-offer decline hidden behind a visible
// data-upsell-proxy of `proxy` outside the offer, which forwards its click to
// the in-offer action of its own spelling, as the starter upsells.js does.
function offerPage({ accept = "accept", decline = "decline", hideDecline = false, proxy = decline } = {}) {
  return htmlPage(`
<div data-next-upsell="offer" data-next-package-id="7">
  <a data-next-upsell-action="${accept}" href="#" class="button cc-xl" style="${BOX}">Yes, Add to My Order</a>
  <p></p>
  <div class="cc-decline-wrapper"${hideDecline ? ' style="display:none" aria-hidden="true"' : ""}>
    <a data-next-upsell-action="${decline}" href="#" class="upsell-decline" style="${BOX}">No thanks, I'll pass</a>
  </div>
</div>
${hideDecline ? `<section><a data-upsell-proxy="${proxy}" href="#" class="closing-decline" style="${BOX}">No thank you</a></section>` : ""}
<script>
  const ref = new URLSearchParams(location.search).get("ref_id");
  for (const value of ["add", "accept"]) {
    document.querySelector('[data-next-upsell-action="' + value + '"]')?.addEventListener("click", async (event) => {
      event.preventDefault();
      await fetch("/api/v1/orders/" + ref + "/upsells/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      location.href = "/receipt/?ref_id=" + ref;
    });
  }
  for (const value of ["skip", "decline"]) {
    document.querySelector('[data-next-upsell-action="' + value + '"]')?.addEventListener("click", (event) => {
      event.preventDefault();
      location.href = "/downsell/?ref_id=" + ref;
    });
  }
  document.querySelector("[data-upsell-proxy]")?.addEventListener("click", (event) => {
    event.preventDefault();
    const action = event.currentTarget.getAttribute("data-upsell-proxy");
    document.querySelector('[data-next-upsell="offer"] [data-next-upsell-action="' + action + '"]')?.click();
  });
  document.documentElement.classList.add("next-display-ready");
</script>`, { head: "<meta name=\"next-page-type\" content=\"upsell\">" });
}

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

// Serves `html` as the offer at /upsell/, a 201 for its order upsell
// mutation, and a bare page anywhere else, all inside the browser context.
async function openOffer(html) {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1280, height: 720 } });
  const posts = [];
  await context.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/upsell/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (request.method() === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      posts.push(url.pathname);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ref_id: REF, lines: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Next</title><p>Next</p>" });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/upsell/?ref_id=${REF}`, { waitUntil: "load" });
  return { context, page, posts };
}

// Serves `html` at /upsell/ on 127.0.0.1 and runs QA's browser page checks on
// it as an upsell whose accept route is the next route.
async function pageChecks(html) {
  const origin = await stubOrigin();
  try {
    origin.serve("/upsell/", respond("200 OK", "text/html; charset=utf-8", html));
    const page = {
      page_id: "upsell",
      page_type: "upsell",
      url: origin.url("/upsell/"),
      expected_next_url: origin.url("/receipt/"),
      expected_accept_url: origin.url("/receipt/"),
      expected_decline_url: origin.url("/downsell/"),
    };
    const assertions = await runBrowserChecks([{ pages: [page] }], {}, {});
    assert.ok(assertions.some((entry) => entry.id === "browser-load:upsell" && entry.status === "pass"), "setup: QA loaded the page");
    const byId = (id) => {
      const found = assertions.filter((entry) => entry.id === id);
      assert.equal(found.length, 1, `QA reports one ${id} assertion (found ${found.length})`);
      return found[0];
    };
    return {
      accept: byId("browser-upsell-control:upsell:accept"),
      decline: byId("browser-upsell-control:upsell:decline"),
      cta: byId("browser-primary-cta:upsell"),
    };
  } finally {
    await origin.close();
  }
}

const routeRows = (entry) => (entry.evidence?.candidates || []).filter((candidate) => candidate.route_matches);

// ---------------------------------------------------------------------------
// The test-order upsell step.

browserTest("upsell action spellings: an accept written data-next-upsell-action=\"accept\" is clicked by the test-order accept path", async () => {
  const { context, page, posts } = await openOffer(offerPage());
  try {
    const step = await hooks.clickUpsellPath(page, "accept");
    assert.equal(step.error, undefined);
    assert.equal(step.clicked, true);
    assert.equal(posts.length, 1, "the accept click posted the order upsell mutation");
    assert.equal(step.api_response_seen, true);
    assert.match(step.final_url, /\/receipt\/\?ref_id=/);
  } finally {
    await context.close();
  }
});

browserTest("upsell action spellings: a decline written data-next-upsell-action=\"decline\" is clicked by the test-order decline path", async () => {
  const { context, page, posts } = await openOffer(offerPage());
  try {
    const step = await hooks.clickUpsellPath(page, "decline");
    assert.equal(step.error, undefined);
    assert.equal(step.clicked, true);
    assert.equal(posts.length, 0, "a decline posts no upsell");
    assert.match(step.final_url, /\/downsell\/\?ref_id=/);
  } finally {
    await context.close();
  }
});

browserTest("upsell action spellings: a hidden in-offer decline is reached through the visible proxy of the same spelling", async () => {
  const { context, page } = await openOffer(offerPage({ hideDecline: true }));
  try {
    const step = await hooks.clickUpsellPath(page, "decline");
    assert.equal(step.error, undefined);
    assert.equal(step.clicked, true);
    assert.match(step.final_url, /\/downsell\/\?ref_id=/);
  } finally {
    await context.close();
  }
});

browserTest("upsell action spellings: the upsell-page readiness wait ends on a rendered accept or decline control", async () => {
  // No data-next-upsell container: only the action itself can end the wait,
  // and it renders shortly after load.
  const html = htmlPage(`<div id="slot"></div><script>
    document.documentElement.classList.add("next-display-ready");
    setTimeout(() => { document.getElementById("slot").innerHTML = '<a data-next-upsell-action="accept" href="#" style="${BOX}">Yes</a>'; }, 300);
  </script>`);
  const { context, page } = await openOffer(html);
  try {
    const started = Date.now();
    await hooks.waitForUpsellPageReady(page, { "browser-timeout": "20000" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `the wait took ${elapsed}ms; a rendered accept control should end it well before the 20s timeout`);
  } finally {
    await context.close();
  }
});

browserTest("upsell action spellings (control): add and skip are clicked exactly as before", async () => {
  for (const [path, final] of [["accept", /\/receipt\//], ["decline", /\/downsell\//]]) {
    const { context, page } = await openOffer(offerPage({ accept: "add", decline: "skip" }));
    try {
      const step = await hooks.clickUpsellPath(page, path);
      assert.equal(step.error, undefined, path);
      assert.equal(step.clicked, true, path);
      assert.match(step.final_url, final, path);
    } finally {
      await context.close();
    }
  }
});

browserTest("upsell action spellings (control): a value the SDK does not read is no upsell control for either path", async () => {
  for (const path of ["accept", "decline"]) {
    const { context, page } = await openOffer(offerPage({ accept: "maybe", decline: "maybe" }));
    try {
      const step = await hooks.clickUpsellPath(page, path);
      assert.equal(step.clicked, false, path);
      assert.equal(step.error, `Missing upsell control [data-next-upsell-action="${path === "accept" ? "add" : "skip"}"]`, path);
    } finally {
      await context.close();
    }
  }
});

// ---------------------------------------------------------------------------
// The browser page checks: rendered upsell controls and the primary CTA.

browserTest("upsell action spellings: accept and decline controls are counted by the rendered upsell-control rows", async () => {
  const { accept, decline } = await pageChecks(offerPage());
  assert.equal(accept.status, "pass", accept.actual);
  assert.equal(accept.actual, "1 matching control(s)");
  assert.equal(accept.evidence.selector, '[data-next-upsell-action="accept"]');
  assert.equal(decline.status, "pass", decline.actual);
  assert.equal(decline.actual, "1 matching control(s)");
  assert.equal(decline.evidence.selector, '[data-next-upsell-action="decline"]');
});

browserTest("upsell action spellings: an accept written data-next-upsell-action=\"accept\" is the primary-CTA route control when the accept route is the next route", async () => {
  const { cta } = await pageChecks(offerPage());
  assert.equal(cta.status, "pass", cta.actual);
  assert.equal(cta.evidence.reason, "ok");
  const rows = routeRows(cta);
  assert.deepEqual(rows.map((row) => row.selector), ["a.button.cc-xl"], JSON.stringify(cta.evidence.candidates));
  assert.equal(new URL(rows[0].href).pathname, "/receipt/");
  const declineRow = cta.evidence.candidates.find((candidate) => candidate.selector === "a.upsell-decline");
  assert.equal(new URL(declineRow.href).pathname, "/downsell/", "the decline action leads to the page's decline route");
});

browserTest("upsell action spellings (control): add and skip read as before in the rendered upsell-control rows and the primary CTA", async () => {
  const { accept, decline, cta } = await pageChecks(offerPage({ accept: "add", decline: "skip" }));
  assert.equal(accept.status, "pass");
  assert.equal(accept.evidence.selector, '[data-next-upsell-action="add"]');
  assert.equal(decline.status, "pass");
  assert.equal(decline.evidence.selector, '[data-next-upsell-action="skip"]');
  assert.equal(cta.status, "pass", cta.actual);
  assert.deepEqual(routeRows(cta).map((row) => row.selector), ["a.button.cc-xl"]);
});

browserTest("upsell action spellings (control): a value the SDK does not read is not counted and is no primary-CTA route control", async () => {
  const { accept, decline, cta } = await pageChecks(offerPage({ accept: "maybe", decline: "maybe" }));
  for (const entry of [accept, decline]) {
    assert.equal(entry.status, "manual_review");
    assert.equal(entry.actual, "not found");
  }
  assert.equal(accept.evidence.selector, '[data-next-upsell-action="add"]');
  assert.equal(decline.evidence.selector, '[data-next-upsell-action="skip"]');
  assert.equal(cta.status, "fail");
  assert.equal(cta.evidence.reason, "missing_route_cta");
});
