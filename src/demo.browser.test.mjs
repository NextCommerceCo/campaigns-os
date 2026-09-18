import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDemo } from "./demo.mjs";
import { DEMO_ROUTES } from "./demo-artifact.mjs";

test("all four offline file pages retain readable desktop/mobile styles and local navigation without network", async t => {
  let browser;
  try { const { chromium } = await import("playwright"); browser = await chromium.launch(); }
  catch (error) { if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error; t.skip("Chromium unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "campaigns-os-demo-browser-")), target = join(root, "sample");
  createDemo(target);
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const network = [], failures = [];
      page.on("request", req => { if (!req.url().startsWith("file:")) network.push(req.url()); });
      page.on("requestfailed", req => failures.push(req.url()));
      for (const route of DEMO_ROUTES) {
        await page.goto(pathToFileURL(join(target, route, "index.html")).href);
        await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
        const state = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          scripts: document.scripts.length,
          forms: document.forms.length,
          badImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length,
          activeControls: document.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])").length,
          bannerVisible: document.querySelector("[data-demo-banner]").getBoundingClientRect().top >= 0,
          navigation: [...document.querySelectorAll("[data-demo-nav]")].map(link => link.href),
          navBoxes: [...document.querySelectorAll("[data-demo-nav]")].map(link => { const box = link.getBoundingClientRect(); return { text: link.textContent, left: box.left, right: box.right, width: box.width, height: box.height }; }),
          typography: getComputedStyle(document.body).fontFamily,
          missingStyles: [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => !link.sheet).length,
          bannerBackground: getComputedStyle(document.querySelector("[data-demo-banner]")).backgroundColor,
          headingSize: parseFloat(getComputedStyle([...document.querySelectorAll("h1")].find(heading => heading.getClientRects().length) || document.querySelector("h2,h3") || document.body).fontSize),
        }));
        assert.equal(state.width, state.viewport, `${route}: horizontal overflow`);
        assert.equal(state.scripts + state.forms + state.badImages + state.activeControls, 0, `${route}: ${JSON.stringify(state)}`);
        assert.equal(state.bannerVisible, true, route);
        assert.match(state.typography, /system-ui/, route);
        assert.equal(state.missingStyles, 0, route);
        assert.equal(state.bannerBackground, "rgb(9, 9, 11)", route);
        assert.ok(state.headingSize >= 16, `${route}: heading readability`);
        if (route === "landing") assert.equal(state.headingSize, viewport.width === 1280 ? 44 : 32);
        assert.deepEqual(state.navBoxes.map(link => link.text), ["Landing", "Checkout", "Offer", "Receipt"]);
        assert.ok(state.navBoxes.every(link => link.left >= 0 && link.right <= state.viewport && link.width > 0 && link.height > 0), `${route}: clipped navigation ${JSON.stringify(state.navBoxes)}`);
        assert.deepEqual(state.navigation, DEMO_ROUTES.map(route => pathToFileURL(join(target, route, "index.html")).href));
        for (const text of ["Landing", "Checkout", "Offer", "Receipt"]) {
          await page.keyboard.press("Tab");
          const focus = await page.evaluate(() => ({
            text: document.activeElement.textContent,
            nav: document.activeElement.hasAttribute("data-demo-nav"),
            outline: getComputedStyle(document.activeElement).outlineStyle,
            width: parseFloat(getComputedStyle(document.activeElement).outlineWidth),
          }));
          assert.equal(focus.text, text, `${route}: keyboard navigation`);
          assert.equal(focus.nav, true);
          assert.equal(focus.outline, "solid");
          assert.ok(focus.width >= 2, `${route}: visible keyboard focus`);
        }
        await page.locator("[data-demo-nav]").nth(3).click();
        assert.equal(page.url(), pathToFileURL(join(target, "receipt/index.html")).href);
      }
      assert.deepEqual(network, []);
      assert.deepEqual(failures, []);
      await page.close();
    }
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
});
