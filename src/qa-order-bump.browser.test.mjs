// Real-browser proof for the order-bump state marker (campaigns-os#323).
//
// The defect is a DOM-resolution one — which element the marker selector picks
// out of a toggle — so it can only be proved in a real layout engine: it turns
// on document order, computed `display`, and the shared checkout CSS that shows
// and hides the tick by the card's state class. The fixture under
// fixtures/qa-order-bump/ carries the shape that produced it: a toggle whose
// own `aria-hidden` checkbox input precedes its rendered tick.
//
// Chromium is not part of `npm ci --ignore-scripts`, so the file skips when it
// cannot launch (CI), matching qa-cart-entry.browser.test.mjs.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ORDER_BUMP_PROBE_INPUT, orderBumpEvidenceScript } from "./qa-order-bump.mjs";

const FIXTURE = new URL("../fixtures/qa-order-bump/aria-hidden-checkbox/checkout.html", import.meta.url).pathname;

// One Chromium for the whole file, launched on first need and closed once at
// the end. The availability check and the probe share it, so a run costs a
// single launch rather than one per entry point.
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
  } catch {
    return false;
  }
}

let evidence = null;

// The probe is a pure read of a static document, so it runs once and every
// assertion reads the same evidence.
async function bumpEvidence() {
  if (evidence) return evidence;
  const page = await (await sharedBrowser()).newPage();
  try {
    await page.setContent(await readFile(FIXTURE, "utf8"), { waitUntil: "load" });
    evidence = await page.evaluate(orderBumpEvidenceScript(), ORDER_BUMP_PROBE_INPUT);
    return evidence;
  } finally {
    await page.close();
  }
}

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test("Playwright Chromium is unavailable; browser-backed order-bump proof skipped (run `npm run qa:install-browser`)", () => {});
}

browserTest("an accepted bump resolves its rendered tick, not the toggle's own aria-hidden checkbox, and reads checked", async () => {
  const { toggles } = await bumpEvidence();
  assert.equal(toggles.length, 7, "all seven visible toggles are read");

  const accepted = toggles.find((toggle) => toggle.packageId === "4");
  assert.equal(accepted.active, true, "the card carries next-in-cart");
  assert.equal(accepted.inputChecked, true);
  assert.equal(accepted.markerResolved, true);
  assert.equal(accepted.markerReadable, true);
  // The heart of #323: the marker is the tick element, never the input.
  assert.equal(accepted.markerTag, "div", "the marker is the rendered tick, not the aria-hidden <input>");
  assert.equal(accepted.markerFamily, "[os-component='check']");
  assert.equal(accepted.markerSignal, "display_toggled", "the CSS hides this tick when unchecked, so its rendering is the state");
  assert.equal(accepted.markerChecked, true, "a rendered tick reads checked");
  assert.equal(accepted.markerAgrees, true);
  assert.equal(accepted.statesAgree, true);
});

browserTest("a declined bump reads unchecked, so the check still catches a real disagreement", async () => {
  const { toggles } = await bumpEvidence();
  const declined = toggles.find((toggle) => toggle.packageId === "5");

  assert.equal(declined.active, false);
  assert.equal(declined.inputChecked, false);
  assert.equal(declined.markerResolved, true, "the tick is still the resolved marker while hidden");
  assert.equal(declined.markerTag, "div");
  assert.equal(declined.markerSignal, "not_rendered");
  assert.equal(declined.markerChecked, false, "a tick that is not rendered reads unchecked");
  assert.equal(declined.statesAgree, true);
});

browserTest("a decorative aria-hidden switch slider is not a state marker", async () => {
  const { toggles } = await bumpEvidence();
  const slider = toggles.find((toggle) => toggle.packageId === "6");

  assert.equal(slider.active, true);
  assert.equal(slider.inputChecked, null, "the switch variant carries no checkbox input");
  assert.equal(slider.markerResolved, false, "no marker element was found at all");
  assert.equal(slider.markerReadable, false);
  assert.equal(slider.markerSignal, null, "null is reserved for no marker found");
  assert.equal(slider.markerFamily, null);
  assert.equal(slider.markerChecked, false);
  assert.equal(slider.markerAgrees, true, "no readable marker is not a disagreement");
  assert.equal(slider.statesAgree, true);
});

browserTest("a declined pseudo-element bump reads unchecked even though its box renders", async () => {
  const { toggles } = await bumpEvidence();
  const declined = toggles.find((toggle) => toggle.packageId === "7");

  assert.equal(declined.active, false);
  assert.equal(declined.inputChecked, false);
  assert.equal(declined.markerResolved, true);
  assert.equal(declined.markerFamily, ".bump-check");
  // The box renders in both states; only the ::after moves. Reading the box's
  // visibility as the state is exactly the regression this guards.
  assert.equal(declined.markerSignal, "pseudo", "a marker with ::after content is read through the pseudo-element");
  assert.equal(declined.markerChecked, false, "a hidden ::after reads unchecked even on a rendered box");
  assert.equal(declined.markerAgrees, true);
  assert.equal(declined.statesAgree, true);
});

browserTest("an accepted pseudo-element bump reads checked from its ::after, not its box", async () => {
  const { toggles } = await bumpEvidence();
  const accepted = toggles.find((toggle) => toggle.packageId === "8");

  assert.equal(accepted.active, true);
  assert.equal(accepted.inputChecked, true);
  assert.equal(accepted.markerResolved, true);
  assert.equal(accepted.markerFamily, ".bump-check");
  assert.equal(accepted.markerSignal, "pseudo");
  assert.equal(accepted.markerChecked, true, "a rendered ::after reads checked");
  assert.equal(accepted.statesAgree, true);
});

browserTest("a rule that does not apply on screen is not evidence of a state-toggled tick", async () => {
  const { toggles } = await bumpEvidence();
  const declined = toggles.find((toggle) => toggle.packageId === "9");

  assert.equal(declined.active, false);
  assert.equal(declined.markerFamily, "[data-next-toggle-check]");
  assert.equal(declined.markerTag, "span");
  // A print-only hiding rule, and an @supports block for a feature no browser
  // has, say nothing about what the buyer sees. Counting either would read this
  // visible, unchecked box as a rendered tick.
  assert.notEqual(declined.markerSignal, "display_toggled", "a print-only rule is not a state affordance");
  assert.equal(declined.markerSignal, "unresolved", "found and rendered, but nothing says which state it is in");
  assert.equal(declined.markerResolved, true, "a marker element was found");
  assert.equal(declined.markerReadable, false, "found is not the same as readable");
  assert.equal(declined.markerChecked, false);
  assert.equal(declined.markerAgrees, true);
  assert.equal(declined.statesAgree, true);
});

browserTest("an absolutely positioned tick is read even when its host box measures zero", async () => {
  const { toggles } = await bumpEvidence();
  const accepted = toggles.find((toggle) => toggle.packageId === "10");

  assert.equal(accepted.active, true);
  assert.equal(accepted.inputChecked, true);
  assert.equal(accepted.markerFamily, ".bump-check");
  assert.equal(accepted.markerResolved, true);
  // The host span is 0x0; the tick is out of flow and visible. A size test on
  // the host alone would disqualify the marker before its state was read.
  assert.equal(accepted.markerSignal, "pseudo", "the zero-sized host is still inspected for its tick");
  assert.equal(accepted.markerChecked, true);
  assert.equal(accepted.statesAgree, true);
});

browserTest("every toggle on the fixture reads aligned, so a bump run can read clean", async () => {
  const { toggles } = await bumpEvidence();
  const misaligned = toggles.filter((toggle) => !toggle.statesAgree);
  assert.deepEqual(misaligned, [], "no toggle reports a false misalignment");
});
