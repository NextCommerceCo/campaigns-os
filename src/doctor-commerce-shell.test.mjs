import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectCommerceZones, validateCommerceZoneFindings } from "./cli.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-commerce-shell-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("source adapter records SDK-owned commerce zones as template-shell-required", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "checkout.html"), `
      <main>
        <!-- SDK-OWNED: customer + shipping + payment form is provided by the checkout commerce surface -->
        <section data-commerce-zone="checkout-form"></section>
        <aside data-commerce-zone="order-summary"></aside>
      </main>
    `);

    const findings = inspectCommerceZones(dir, [{ path: "checkout.html" }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sdk_owned_declared, true);
    assert.equal(findings[0].requires_template_shell, true);
    assert.deepEqual(findings[0].commerce_zones, ["checkout-form", "order-summary"]);
    assert.equal(findings[0].action, "adopt_selected_template_family_shell_before_assembly");
  });
});

test("doctor context warning tells builders to adopt the selected template shell", () => {
  const warnings = [];
  const ready = [];
  validateCommerceZoneFindings([
    {
      path: "checkout.html",
      commerce_zones: ["checkout-form", "order-summary"],
      sdk_owned_declared: true,
      requires_template_shell: true,
    },
  ], warnings, ready);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "source_html.commerce_shell_required");
  assert.match(warnings[0].message, /adopt the selected starter-template family shell/);
  assert.match(warnings[0].message, /do not wrap borrowed partials in a custom checkout\/upsell structure/);
});

test("ordinary SDK attributes are inspected without shell-required warning", () => {
  const warnings = [];
  const ready = [];
  validateCommerceZoneFindings([
    {
      path: "landing.html",
      zones: ["sdk_attributes"],
      sdk_attributes: ["data-next-url"],
      sdk_owned_declared: false,
      requires_template_shell: false,
    },
  ], warnings, ready);

  assert.deepEqual(warnings, []);
  assert.ok(ready.some((note) => note.includes("no SDK-owned commerce shell placeholders")));
});

test("non-runtime commerce slots do not require a template shell by themselves", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "landing.html"), `
      <section data-commerce-slot="main-bundle-selector">
        <a data-next-url="checkout">Buy now</a>
      </section>
    `);

    const findings = inspectCommerceZones(dir, [{ path: "landing.html" }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sdk_owned_declared, true);
    assert.equal(findings[0].requires_template_shell, false);
    assert.equal(findings[0].action, "review_and_preserve_catalog_surfaces");
  });
});

test("SDK-owned checkout surface comments require the selected template shell", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "commerce.html"), `
      <main>
        <!-- SDK-owned checkout commerce surface; do not hand-build payment/order summary chrome here. -->
      </main>
    `);

    const findings = inspectCommerceZones(dir, [{ path: "commerce.html" }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sdk_owned_declared, true);
    assert.equal(findings[0].requires_template_shell, true);
    assert.equal(findings[0].action, "adopt_selected_template_family_shell_before_assembly");
  });
});
