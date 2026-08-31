import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { __qaBrowserTestHooks } from "./qa-browser.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/qa-offer-surface/exit-intent-declared-not-built.json", import.meta.url),
  "utf8",
));

test("a declared exit_intent that the build never shipped is a blocker, not a silent pass", () => {
  const { declaredOfferSurface, exitIntentSurfaceAssertion } = __qaBrowserTestHooks;
  const declaration = declaredOfferSurface(fixture.page, "exit_intent");
  assert.deepEqual(declaration, { surface: "exit_intent", offer_code: "EXIT10" });

  const result = exitIntentSurfaceAssertion({
    page: fixture.page,
    declaration,
    evidence: fixture.browser_evidence.exit_intent,
  });

  assert.equal(result.id, "browser-exit-intent-surface:checkout");
  assert.equal(result.family, "browser-runtime");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.match(result.expected, /EXIT10/);
  assert.match(result.actual, /no exit-intent markup/);
  // The regression this exists for: this build produced 130 passing assertions
  // and none of them mentioned the surface it declared and never built.
  assert.equal(result.evidence.declared.offer_code, "EXIT10");
});

test("an exit-intent surface carrying the declared code passes; one that cannot be tied to it is manual_review", () => {
  const { declaredOfferSurface, exitIntentSurfaceAssertion } = __qaBrowserTestHooks;
  const declaration = declaredOfferSurface(fixture.page, "exit_intent");

  const wired = exitIntentSurfaceAssertion({
    page: fixture.page,
    declaration,
    evidence: fixture.built_variants.exit_intent_wired,
  });
  assert.equal(wired.status, "pass");
  assert.equal(wired.severity, undefined);
  assert.match(wired.actual, /carrying offer code EXIT10/);

  const unwired = exitIntentSurfaceAssertion({
    page: fixture.page,
    declaration,
    evidence: fixture.built_variants.exit_intent_present_unwired,
  });
  assert.equal(unwired.status, "manual_review");
  assert.equal(unwired.severity, "warn");
  assert.match(unwired.actual, /no offer-code hook matching EXIT10/);
  assert.match(unwired.actual, /found SAVE5/);
});

test("a declared exit_intent with no offer_code is manual_review — presence is all that is checkable", () => {
  const { declaredOfferSurface, exitIntentSurfaceAssertion } = __qaBrowserTestHooks;
  const page = { ...fixture.page, exit_intent: { enabled: true } };
  const declaration = declaredOfferSurface(page, "exit_intent");
  assert.equal(declaration.offer_code, null);

  const result = exitIntentSurfaceAssertion({
    page,
    declaration,
    evidence: fixture.built_variants.exit_intent_wired,
  });
  assert.equal(result.status, "manual_review");
  assert.match(result.actual, /declares no offer_code/);
});

test("promo_code_input: absent is a blocker, visible passes, present-but-hidden is manual_review", () => {
  const { declaredOfferSurface, promoCodeSurfaceAssertion } = __qaBrowserTestHooks;
  const declaration = declaredOfferSurface(fixture.page, "promo_code_input");
  const build = (evidence) => promoCodeSurfaceAssertion({ page: fixture.page, declaration, evidence });

  const absent = build(fixture.browser_evidence.promo_code_input);
  assert.equal(absent.id, "browser-promo-code-surface:checkout");
  assert.equal(absent.status, "fail");
  assert.equal(absent.severity, "blocker");

  const visible = build(fixture.built_variants.promo_code_input_visible);
  assert.equal(visible.status, "pass");

  // A collapsed "Have a coupon?" disclosure is the common real shape; the
  // typed-card runner reveals it before typing, so a static read cannot call
  // it broken.
  const hidden = build(fixture.built_variants.promo_code_input_behind_disclosure);
  assert.equal(hidden.status, "manual_review");
  assert.equal(hidden.severity, "warn");
});

test("only enabled === true declares an offer surface, matching the tiers-mode coupon gate", () => {
  const { declaredOfferSurface } = __qaBrowserTestHooks;
  assert.equal(declaredOfferSurface({ exit_intent: { offer_code: "NOPE" } }, "exit_intent"), null);
  assert.equal(declaredOfferSurface({ exit_intent: { enabled: false, offer_code: "NOPE" } }, "exit_intent"), null);
  assert.equal(declaredOfferSurface({}, "exit_intent"), null);
  assert.equal(declaredOfferSurface({ promo_code_input: null }, "promo_code_input"), null);
});

test("exit-intent selectors cover the starter-family template shape and hand-rolled equivalents", () => {
  const { EXIT_INTENT_SURFACE_SELECTORS } = __qaBrowserTestHooks;
  // The starter families wrap the pop in <template data-template="exit-intent">
  // and hang the mapped code off [data-exit-intent-action]; scanning only the
  // live document would report a correctly built pop as missing, which is why
  // the collector walks template content too.
  assert.ok(EXIT_INTENT_SURFACE_SELECTORS.includes('template[data-template="exit-intent"]'));
  assert.ok(EXIT_INTENT_SURFACE_SELECTORS.includes("[data-exit-intent-action]"));
  assert.ok(EXIT_INTENT_SURFACE_SELECTORS.includes("#exit-intent-popup"));
});
