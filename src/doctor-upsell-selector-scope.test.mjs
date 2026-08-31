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

import { doctorBuiltOutput } from "./cli.mjs";
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
