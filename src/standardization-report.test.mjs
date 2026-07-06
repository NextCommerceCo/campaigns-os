import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  attachBuiltOutputDoctor,
  createStandardizationReport,
  discoverPageKitRoots,
  formatStandardizationReportMarkdown,
} from "./standardization-report.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-standardization-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function writeFixtureRoot(root, { sdkVersion = "0.4.18", pageKitVersion = "^0.0.9" } = {}) {
  write(join(root, "package.json"), JSON.stringify({
    scripts: { build: "campaign-build" },
    dependencies: { "next-campaign-page-kit": pageKitVersion },
  }, null, 2));
  write(join(root, "_data", "campaigns.json"), JSON.stringify({
    acme: {
      name: "Acme Funnel",
      sdk_version: sdkVersion,
      store_url: "https://acme.example/",
    },
  }, null, 2));
  write(join(root, ".campaign-runtime", "assembly-report.json"), JSON.stringify({
    template_family: { value: "olympus-mv-single-step", locked: true },
  }, null, 2));
  write(join(root, "src", "acme", "_includes", "payment-methods.html"), "<div data-next-payment-methods></div>");
  write(join(root, "src", "acme", "checkout.html"), `
---
layout: base
---
<html>
  <body>
    <img src="/assets/hero.png" alt="">
    {% raw %}{{ 'image.jpg' | campaign_asset }}{% endraw %}
    <form data-next-checkout="form">
      <div data-next-package-id="1" data-next-shipping-id="2">
        <span data-next-display="package.name">Product</span>
      </div>
    </form>
  </body>
</html>
`);
  write(join(root, "_site", "acme", "index.html"), "<h1>Built Acme</h1>");
  write(join(root, "_site", "acme", "checkout", "index.html"), "<h1>Checkout</h1>");
}

const codes = (root) => root.findings.map((finding) => finding.code);

test("standardization report inventories a Page Kit root and classifies source/version risks", () => {
  withTempDir((dir) => {
    const root = join(dir, "campaign");
    writeFixtureRoot(root);

    const report = createStandardizationReport({ targetRepo: dir });
    assert.equal(report.schema_version, "campaign-standardization-report/v0");
    assert.equal(report.roots.length, 1);
    assert.equal(report.status, "blocked");

    const [entry] = report.roots;
    assert.equal(entry.identity.campaign_slugs[0].slug, "acme");
    assert.deepEqual(entry.identity.sdk_versions, ["0.4.18"]);
    assert.equal(entry.identity.page_kit_dependency.version, "^0.0.9");
    assert.equal(entry.identity.template_family.value, "olympus-mv-single-step");
    assert.equal(entry.identity.template_family.confidence, "artifact");
    assert.equal(entry.source_structure.raw_blocks.count, 1);
    assert.equal(entry.source_structure.payment_methods_include.detected, true);
    assert.equal(entry.runtime_contract.data_next.total_occurrences > 0, true);
    assert.equal(entry.built_output.html_count, 2);
    assert.ok(codes(entry).includes("source.raw_block"));
    assert.ok(codes(entry).includes("source.hardcoded_root_assets"));
    assert.ok(codes(entry).includes("source.document_wrappers"));
    assert.ok(codes(entry).includes("version.sdk_below_preferred_cutoff"));
    assert.ok(codes(entry).includes("version.page_kit_below_preferred_cutoff"));
  });
});

test("standardization report discovers multiple nested Page Kit roots", () => {
  withTempDir((dir) => {
    writeFixtureRoot(join(dir, "alpha"), { sdkVersion: "0.4.25", pageKitVersion: "^0.1.1" });
    writeFixtureRoot(join(dir, "beta"), { sdkVersion: "0.4.28", pageKitVersion: "^0.1.1" });

    const roots = discoverPageKitRoots(dir);
    assert.equal(roots.length, 2);

    const report = createStandardizationReport({ targetRepo: dir, templateFamily: "olympus" });
    assert.equal(report.roots.length, 2);
    assert.deepEqual(report.roots.map((root) => root.identity.template_family.source), ["operator_flag", "operator_flag"]);
  });
});

test("standardization report keeps tentative source heuristics narrow", () => {
  withTempDir((dir) => {
    write(join(dir, "package.json"), JSON.stringify({
      dependencies: { "next-campaign-page-kit": "^0.1.1" },
    }, null, 2));
    write(join(dir, "_data", "campaigns.json"), JSON.stringify({
      acme: { sdk_version: "0.4.25", store_url: "https://acme.example/" },
    }, null, 2));
    write(join(dir, "src", "acme", "checkout.html"), `
---
layout: base
---
<!-- <html> is mentioned in a comment, not used as a document wrapper. -->
{% comment %}<body>also not a wrapper</body>{% endcomment %}
<section>
  <p>Copy says payment-methods, but this is not an include.</p>
  <p>Do not count package.json or order.fetch as runtime bindings.</p>
  <form data-next-checkout="form"></form>
</section>
`);
    write(join(dir, "src", "acme", "assets", "images", "olympus-mv-screenshot.png"), "not really an image");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.source_structure.document_wrappers.count, 0);
    assert.equal(root.source_structure.payment_methods_include.detected, false);
    assert.equal(root.runtime_contract.package_refs.count, 0);
    assert.equal(root.runtime_contract.receipt_surface.detected, false);
    assert.equal(root.identity.template_family.value, null);
    assert.ok(codes(root).includes("source.payment_methods_include_not_detected"));
  });
});

test("standardization report marks built output unresolved when slug scope is ambiguous", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.25", pageKitVersion: "^0.1.1" });
    write(join(dir, "_site", "beta", "index.html"), "<h1>Built Beta</h1>");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.built_output.present, true);
    assert.equal(root.built_output.scope_resolved, false);
    assert.equal(root.built_output.html_count, 0);
    assert.match(formatStandardizationReportMarkdown(report), /Built _site: unresolved/);
    assert.ok(codes(root).includes("built_output.scope_unresolved"));
  });
});

test("standardization markdown is operator-readable", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir);
    const report = createStandardizationReport({ targetRepo: dir });
    const markdown = formatStandardizationReportMarkdown(report);
    assert.match(markdown, /# Campaign Standardization Report/);
    assert.match(markdown, /## campaigns-os-standardization-/);
    assert.match(markdown, /### Source Structure/);
    assert.match(markdown, /source.raw_block/);
    assert.match(markdown, /campaigns-os standardize --target/);
  });
});

test("built-output doctor warnings attach as standardization findings", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.25", pageKitVersion: "^0.1.1" });
    const report = createStandardizationReport({ targetRepo: dir });
    attachBuiltOutputDoctor(report, report.roots[0].id, {
      ok: true,
      status: "ready_with_warnings",
      mode: "built_site",
      warnings: [{ code: "template_contract.literal_residue", message: "Built output contains XXCODE." }],
      errors: [],
      ready: ["Resolved built pages"],
    });

    const root = report.roots[0];
    assert.equal(root.built_output.doctor.status, "ready_with_warnings");
    assert.ok(codes(root).includes("built_doctor.template_contract.literal_residue"));
    assert.ok(root.remediation.safe_agent_repairs.some((item) => item.includes("starter/template residue")));
  });
});
