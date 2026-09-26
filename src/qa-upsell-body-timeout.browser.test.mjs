// Real-browser proof that the upsell step does not hang on a mutation body the
// page never waited for.
//
// clickUpsellPath reads the order upsell mutation's body for evidence after
// the response arrives. When the page navigates away as soon as the headers
// land, before the body finishes loading, Playwright's response.text() can
// wait indefinitely, and the whole test-order run hangs with it. The fixture
// server sends the 201 headers and part of the body, then holds the rest; the
// fixture page (fixtures/qa-upsell-accept/navigate-before-body/) navigates to
// the thank-you page without reading it.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch locally. The browser CI lane requires Chromium.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { __qaBrowserTestHooks as hooks } from "./qa-browser.mjs";

const FIXTURE = new URL("../fixtures/qa-upsell-accept/navigate-before-body/upsell.html", import.meta.url).pathname;
const REF = "FIXTUREREF2";

let browser = null;
// Closed in after() as well, so a regression fails on the test timeout
// instead of holding the process open on the parked response.
const servers = new Set();

async function sharedBrowser() {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  return browser;
}

after(async () => {
  for (const server of servers) await server.close();
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

// A loopback server rather than route.fulfill: a fulfilled route always
// delivers the whole body, and the defect needs a body that is still loading
// when the page leaves.
async function startServer() {
  const html = await readFile(FIXTURE, "utf8");
  const posts = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    if (request.method === "POST" && url.pathname === `/api/v1/orders/${REF}/upsells/`) {
      posts.push(Date.now());
      response.writeHead(201, { "content-type": "application/json" });
      response.write(`{"ref_id":"${REF}","lines":[`);
      return; // the rest of the body never arrives
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(url.pathname.startsWith("/upsell/") ? html : "<!doctype html><title>Thanks</title><p>Thanks</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handle = {
    origin,
    posts,
    async close() {
      if (!servers.delete(handle)) return;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  servers.add(handle);
  return handle;
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; browser-backed upsell body-timeout proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("an accept that navigates before the mutation body loads completes and still reports the response", { timeout: 30000 }, async () => {
  const server = await startServer();
  const context = await (await sharedBrowser()).newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/upsell/?ref_id=${REF}`, { waitUntil: "load" });

    const started = Date.now();
    const step = await hooks.clickUpsellPath(page, "accept");
    const elapsed = Date.now() - started;

    assert.equal(server.posts.length, 1, "the accept posted the order upsell mutation once");
    assert.equal(step.clicked, true);
    assert.equal(step.api_response_seen, true, "the mutation response was seen");
    assert.equal(step.api_response_status, 201);
    assert.equal(step.api_response_order_body, null, "an unread body is reported as absent, not waited for");
    assert.match(step.final_url, /\/thank-you\/\?ref_id=/);
    // The floor proves the body read really stayed pending until the bound
    // fired. Without it, a navigation that aborted the request and made
    // response.text() reject at once would also produce a null body quickly,
    // and the old unbounded read already handled that case.
    const bound = hooks.RESPONSE_BODY_READ_TIMEOUT_MS;
    assert.ok(elapsed >= bound - 100, `accept path took ${elapsed}ms; the body read gave up before the ${bound}ms bound, so the pending read was not exercised`);
    assert.ok(elapsed < 15000, `accept path took ${elapsed}ms; expected well under 15s`);
  } finally {
    await context.close();
    await server.close();
  }
});
