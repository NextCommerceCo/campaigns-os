// Doctor wiring for the upsell selector-scope gate (#270).
//
// The unit tests in upsell-selector-scope.test.mjs cover the evaluator. These
// cover the three things the issue actually turns on: that the gate is reached
// from BOTH doctor entry points, that it is reached on every invocation rather
// than only the one that follows assembly, and that the committed regression
// fixture still reproduces.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { doctorBuiltOutput } from "./doctor/inspect.mjs";
import { UPSELL_SELECTOR_SCOPE } from "./upsell-selector-scope.mjs";

const FIXTURE_ROOT = resolve(new URL("../fixtures/upsell-selector-scope", import.meta.url).pathname);
const SLUG = "example-campaign";
const codes = (issues) => issues.map((issue) => issue.code);

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-upsell-scope-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePage(repo, route, html) {
  const dir = route ? join(repo, "_site", SLUG, route) : join(repo, "_site", SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

const UPSELL_HEAD = '<meta name="next-page-type" content="upsell">';
const UNSCOPED = '<div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x" style="display:none"></div>';
const SCOPED = '<div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div>';

function gateOf(result) {
  return (result.derived?.checkpoint_gates || []).find((gate) => gate.id === UPSELL_SELECTOR_SCOPE) || null;
}

// --- The committed regression fixture ----------------------------------------

test("#270 regression fixture: the unscoped selector on the built upsell page blocks", () => {
  const result = doctorBuiltOutput({ built: FIXTURE_ROOT, slug: SLUG });

  assert.equal(result.ok, false, "built markup that charges a shopper must block, not warn");
  assert.equal(result.status, "blocked");
  assert.ok(codes(result.errors).includes(UPSELL_SELECTOR_SCOPE));

  const gate = gateOf(result);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.findings.length, 1, "only the unscoped selector is a finding");
  assert.deepEqual(
    { page: gate.findings[0].page_id, id: gate.findings[0].selector_id, hidden: gate.findings[0].hidden },
    { page: "upsell-2", id: "upsell-bundle-1x", hidden: true },
  );
  // The whole defect is that it is invisible, so the message has to carry it.
  const issue = result.errors.find((error) => error.code === UPSELL_SELECTOR_SCOPE);
  assert.match(issue.message, /"upsell-bundle-1x"/);
  assert.match(issue.message, /LIVE CART/);
  assert.equal(issue.detail.checkpoint_gate.id, UPSELL_SELECTOR_SCOPE);
});

test("#270 regression fixture: the landing page's cart selector is left alone", () => {
  const gate = gateOf(doctorBuiltOutput({ built: FIXTURE_ROOT, slug: SLUG }));
  assert.equal(gate.pages_scanned, 2, "index is a landing page and is not scanned");
  assert.equal(gate.findings.every((finding) => finding.page_id !== "index"), true);
});

test("#270 fixture with the offending selector removed is clean", () => {
  // Proves the fixture blocks because of the one selector rather than because
  // of anything else it happens to contain.
  withTempDir((repo) => {
    cpSync(join(FIXTURE_ROOT, "_site"), join(repo, "_site"), { recursive: true });
    const page = join(repo, "_site", SLUG, "upsell-2", "index.html");
    const original = readFileSync(page, "utf8");
    const cleaned = original.replace(
      /<div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x"[\s\S]*?<\/div>\s*<\/div>/,
      "",
    );
    assert.notEqual(cleaned, original, "the fixture still carries the selector this test removes");
    writeFileSync(page, cleaned);

    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(codes(result.errors).includes(UPSELL_SELECTOR_SCOPE), false);
    assert.equal(gateOf(result).status, "pass");
  });
});

// --- Reached on every invocation, not only after assembly --------------------

test("the gate fires with no assembly report and no template family", () => {
  // The field instance arrived during a later human review round, on a
  // page-kit campaign inspected through `doctor --built` with no packet, no
  // report, and often no --family. A gate that needed any of those would have
  // watched this defect ship.
  withTempDir((repo) => {
    writePage(repo, "upsell-2", `<html><head>${UPSELL_HEAD}</head><body>${UNSCOPED}${SCOPED}</body></html>`);
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, false);
    assert.equal(gateOf(result).status, "blocked");
    assert.ok(result.derived.doctor_checks.includes(UPSELL_SELECTOR_SCOPE));
  });
});

test("the gate reads next-page-type when the route name says nothing about the funnel", () => {
  withTempDir((repo) => {
    // "special-offer" infers as a generic page; the meta is what the SDK reads.
    writePage(repo, "special-offer", `<html><head>${UPSELL_HEAD}</head><body>${UNSCOPED}</body></html>`);
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(gateOf(result).status, "blocked");
  });
});

test("#529: a checkout page with an embedded offer is not flagged because its route reads as an offer", () => {
  // "checkout-oto-1" infers as an upsell from the route name alone; the page's
  // own meta says checkout, which is what the SDK reads.
  const offer = `<main><div data-next-upsell="offer">${UNSCOPED}</div></main>`;
  withTempDir((repo) => {
    writePage(repo, "checkout-oto-1", `<html><head><meta name="next-page-type" content="checkout"></head><body>${offer}</body></html>`);
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(codes(result.errors).includes(UPSELL_SELECTOR_SCOPE), false);
    assert.equal(gateOf(result).status, "not_applicable");
  });
  // Genuine post-purchase pages under the same route are still flagged: by
  // the meta, and by the route guess when the page declares nothing.
  for (const head of [UPSELL_HEAD, '<meta name="next-page-type" content="downsell">', ""]) {
    withTempDir((repo) => {
      writePage(repo, "checkout-oto-1", `<html><head>${head}</head><body>${offer}</body></html>`);
      assert.equal(gateOf(doctorBuiltOutput({ built: repo, slug: SLUG })).status, "blocked", head || "(no meta)");
    });
  }
});

test("#529: an upsell route whose meta was copied from another page still blocks doctor --built", () => {
  // The meta says product, checkout or receipt; the route says upsell, and
  // the order is already paid there, so the selector still charges.
  const offer = `<main><div data-next-upsell="offer">${UNSCOPED}</div></main>`;
  for (const meta of ["product", "checkout", "receipt"]) {
    withTempDir((repo) => {
      writePage(repo, "upsell-1", `<html><head><meta name="next-page-type" content="${meta}"></head><body>${offer}</body></html>`);
      const result = doctorBuiltOutput({ built: repo, slug: SLUG });
      assert.ok(codes(result.errors).includes(UPSELL_SELECTOR_SCOPE), meta);
      assert.equal(gateOf(result).status, "blocked", meta);
    });
  }
});

test("#529: an oto route takes its role only from a checkout meta, and blocks with any other meta or none", () => {
  const offer = `<main><div data-next-upsell="offer">${UNSCOPED}</div></main>`;
  const CHECKOUT_HEAD = '<meta name="next-page-type" content="checkout">';
  const cases = [
    ["checkout-oto-v2", CHECKOUT_HEAD, "not_applicable"],
    ["oto-1", CHECKOUT_HEAD, "not_applicable"],
    ["oto-1", "", "blocked"],
    ["oto-1", UPSELL_HEAD, "blocked"],
    // A meta copied from the product or thank-you page is not a checkout.
    ["oto-1", '<meta name="next-page-type" content="product">', "blocked"],
    ["one-time-offer", '<meta name="next-page-type" content="receipt">', "blocked"],
  ];
  for (const [route, head, status] of cases) {
    withTempDir((repo) => {
      writePage(repo, route, `<html><head>${head}</head><body>${offer}</body></html>`);
      assert.equal(gateOf(doctorBuiltOutput({ built: repo, slug: SLUG })).status, status, `${route} ${head || "(no meta)"}`);
    });
  }
});

test("#529: a checkout meta the browser never reads does not lift an upsell page out of the gate", () => {
  // Each head names checkout only in markup that is not the page's meta, or
  // names it ambiguously; the upsell route's blocker stands, with or without
  // a family.
  const inert = [
    `<!-- <meta name="next-page-type" content="checkout"> -->${UPSELL_HEAD}`,
    '<!-- <meta name="next-page-type" content="checkout"> -->',
    '<noscript><meta name="next-page-type" content="checkout"></noscript>',
    '<meta name="next-page-type" content="checkout"><meta name="next-page-type" content="receipt">',
  ];
  for (const family of [undefined, "olympus"]) {
    for (const head of inert) {
      withTempDir((repo) => {
        writePage(repo, "upsell-1", `<html><head>${head}</head><body>${UNSCOPED}</body></html>`);
        assert.equal(gateOf(doctorBuiltOutput({ built: repo, slug: SLUG, family })).status, "blocked", `${family || "(no family)"} ${head}`);
      });
    }
  }
});

test("a built campaign with no post-purchase page reports not_applicable, not pass", () => {
  withTempDir((repo) => {
    writePage(repo, "", "<html><body><h1>Landing</h1></body></html>");
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, true);
    assert.equal(gateOf(result).status, "not_applicable");
  });
});

test("the gate is registered as a waivable checkpoint, so `next` can offer the waiver", () => {
  withTempDir((repo) => {
    writePage(repo, "upsell-2", `<html><head>${UPSELL_HEAD}</head><body>${UNSCOPED}</body></html>`);
    const gate = gateOf(doctorBuiltOutput({ built: repo, slug: SLUG }));
    assert.equal(gate.waivable, true);
    const waive = gate.required_actions.find((action) => action.id === "waive_checkpoint");
    assert.match(waive.command, new RegExp(`--gate ${UPSELL_SELECTOR_SCOPE}`));
  });
});

test("a warning-only result also emits a ready line, so 'ran clean' and 'did not run' differ", () => {
  withTempDir((repo) => {
    writePage(
      repo,
      "upsell-2",
      `<html><head>${UPSELL_HEAD}</head><body>`
        + '<div data-next-bundle-selector data-next-selector-id="display" data-next-selection-mode="select"></div>'
        + `${SCOPED}</body></html>`,
    );
    const result = doctorBuiltOutput({ built: repo, slug: SLUG });
    assert.equal(result.ok, true);
    assert.equal(gateOf(result).status, "pass");
    assert.ok(codes(result.warnings).includes("built_output.upsell_selector_scope.cart_scoped_select_mode"));
    assert.ok(
      result.ready.some((note) => note.includes("Upsell selector-scope scan found 0 cart-writing selector(s)")),
      "a warning-only result must still confirm the scan ran",
    );
  });
});
