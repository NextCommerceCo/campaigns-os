import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function writeMultiRouteRoot(root) {
  write(join(root, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "0.3.0" } }));
  write(join(root, "_data/campaigns.json"), JSON.stringify(Object.fromEntries(
    ["route-a", "route-b", "route-c"].map((slug) => [slug, { sdk_version: "0.4.30", store_url: "https://store.example/" }]),
  )));
  for (const slug of ["route-a", "route-b", "route-c"]) {
    write(join(root, `src/${slug}/index.html`), "<div data-next-checkout>{{ 'hero.png' | campaign_asset }}</div>");
    write(join(root, `src/${slug}/_includes/payment-methods.html`), "<div data-next-payment-methods></div>");
    write(join(root, `_site/${slug}/index.html`), "<h1>Example</h1>");
  }
  write(join(root, "src/route-b/index.html"), "{% include 'shared/entry' %}<img src='/assets/b.png'>");
  write(join(root, "src/route-c/index.html"), "{% render 'shared/entry.html' %}");
  write(join(root, "src/route-c/own.html"), "<html><body>Other route</body></html>");
  write(join(root, "src/shared/entry.html"), "{% include 'shared/blocker' %}");
  write(join(root, "src/shared/blocker.html"), "{% raw %}Example{% endraw %}");
}

test("--slug excludes blockers and warnings belonging only to other routes", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    const report = createStandardizationReport({ targetRepo: dir, slug: "route-a", templateFamily: "apollo" });
    assert.ok(!codes(report.roots[0]).includes("source.raw_block"), "another route's shared blocker is outside this audit");
    assert.ok(!codes(report.roots[0]).includes("source.hardcoded_root_assets"));
    assert.ok(!codes(report.roots[0]).includes("source.document_wrappers"));
    assert.notEqual(report.status, "blocked");
  });
});

test("--slug attributes a checkout-contract finding in a shared file to the routes that use it", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    write(join(dir, "src/shared/blocker.html"), '<input data-next-checkout-field="state">');
    const report = createStandardizationReport({ targetRepo: dir, slug: "route-b", templateFamily: "apollo" });
    const binding = report.roots[0].findings.find((item) => item.code === "checkout.unsupported_field_binding");
    assert.ok(binding, "the shared file's stale checkout alias is reported for a route that uses it");
    assert.deepEqual(binding.shared_files, [{ path: "src/shared/blocker.html", routes: ["route-b", "route-c"] }]);
  });
});

test("--slug attributes transitive shared findings and leaves whole-project output unscoped", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    const report = createStandardizationReport({ targetRepo: dir, slug: "route-b", templateFamily: "apollo" });
    const root = report.roots[0];
    const raw = root.findings.find((item) => item.code === "source.raw_block");
    assert.equal(report.status, "blocked");
    assert.deepEqual(raw.shared_files, [{ path: "src/shared/blocker.html", routes: ["route-b", "route-c"] }]);
    assert.deepEqual(raw.evidence[0].routes, ["route-b", "route-c"]);
    assert.ok(codes(root).includes("source.hardcoded_root_assets"));
    assert.ok(!codes(root).includes("source.document_wrappers"), "route-c's own page is not scanned");
    assert.deepEqual(root.source_scope, { route: "route-b", kind: "route", unresolved_reference_count: 0 });
    assert.equal(root.entry_point.name, "Hand-authored");
    assert.match(root.entry_point.command, /campaigns-os doctor --built .* --family apollo --slug route-b --json$/);
    const markdown = formatStandardizationReportMarkdown(report);
    assert.match(markdown, /Source audit: limited to route route-b/);
    assert.match(markdown, /Shared file: src\/shared\/blocker.html; used by routes: route-b, route-c/);
    assert.match(markdown, /Entry point: Hand-authored/);
    assert.match(markdown, /Re-enter: campaigns-os doctor --built .* --slug route-b --json/);
    assert.ok(root.remediation.proof_commands[0].includes("--slug route-b"));

    const whole = createStandardizationReport({ targetRepo: dir, templateFamily: "apollo" });
    assert.ok(codes(whole.roots[0]).includes("source.raw_block"));
    assert.ok(codes(whole.roots[0]).includes("source.document_wrappers"));
    assert.ok(codes(whole.roots[0]).includes("source.hardcoded_root_assets"));
    assert.equal("source_scope" in whole.roots[0], false);
    assert.equal("entry_point" in whole.roots[0], false);
    assert.equal("shared_files" in whole.roots[0].findings.find((item) => item.code === "source.raw_block"), false);
    assert.doesNotMatch(formatStandardizationReportMarkdown(whole), /Source audit:|Entry point:|Shared file:/);
  });
});

test("route scoping follows Page Kit Liquid and layout rules, terminates cycles, and notes variables", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    write(join(dir, "src/route-a/index.html"), `---
page_layout: 'base.html'
---
{% campaign_include 'local.html' %}
{%- include 'shared/plain' -%}
{% render "shared/render.liquid" %}
{% include variable_path %}
{% render another_path %}
{% campaign_include local_path %}
{% include '../outside' %}
{% render '/outside.html' %}
{% campaign_include '../../../../outside.html' %}
`);
    const reachable = [
      ["route-a/_includes/local.html", "{% include 'shared/transitive' %}"],
      ["route-a/_layouts/base.html", "{% include 'shared/from-layout' %}"],
      ["shared/plain.html", "{% include 'shared/cycle' %}"],
      ["shared/render.liquid", ""],
      ["shared/transitive.html", ""],
      ["shared/from-layout.html", ""],
      ["shared/cycle.html", "{% include 'shared/plain' %}"],
    ];
    for (const [path, body] of reachable) write(join(dir, "src", path), `{% raw %}${path}{% endraw %}${body}`);
    write(join(dir, "outside.html"), "{% raw %}Outside src{% endraw %}");
    write(join(dir, "src/shared/variable_path.html"), "{% raw %}Do not guess{% endraw %}");
    write(join(dir, "src/_includes/local.html"), "{% raw %}Wrong include base{% endraw %}");
    write(join(dir, "src/route-a/assets/script.js"), "const anchor = 'data-next-example';");
    const report = createStandardizationReport({ targetRepo: dir, slug: "route-a" });
    const root = report.roots[0];
    assert.equal(root.source_structure.raw_blocks.count, reachable.length);
    assert.deepEqual(root.source_structure.raw_blocks.samples.map((entry) => entry.path).sort(), reachable.map(([path]) => `src/${path}`).sort());
    assert.equal(root.source_scope.unresolved_reference_count, 3);
    assert.match(formatStandardizationReportMarkdown(report), /Unresolved variable Liquid references: 3 \(not guessed; not a blocker\)/);
    assert.ok(root.runtime_contract.data_next.unique_attributes.includes("data-next-example"), "route-local assets stay in scope");
  });
});

test("a route's Build Packet names the continuation command and its runtime artifacts", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    write(join(dir, "campaign-runtime.build.json"), JSON.stringify({ campaign: { public_route_slug: "route-c" } }));
    const packet = join(dir, "campaign-runtime-route-a.build.json");
    write(packet, JSON.stringify({ campaign: { public_route_slug: "route-a" }, assembly: { runtime_dir: ".campaign-runtime/funnels/route-a" } }));
    write(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify({ template_family: "example-other-family" }));
    write(join(dir, ".campaign-runtime/funnels/route-a/build-context.json"), JSON.stringify({ template_family: "apollo" }));
    write(join(dir, ".campaign-runtime/funnels/route-c/build-context.json"), JSON.stringify({ template_family: "example-other-family" }));
    const report = createStandardizationReport({ targetRepo: dir, slug: "route-a" });
    const root = report.roots[0];
    assert.deepEqual(root.entry_point, { name: "Build Packet", packet, command: `campaigns-os next --packet ${packet}` });
    assert.equal(root.identity.template_family.value, "apollo");
    assert.deepEqual(root.runtime_contract.campaign_runtime.artifacts, [".campaign-runtime/funnels/route-a/build-context.json"]);
    assert.ok(root.remediation.proof_commands.includes(root.entry_point.command));
    assert.match(formatStandardizationReportMarkdown(report), /Entry point: Build Packet — .*campaign-runtime-route-a.build.json/);
    assert.match(formatStandardizationReportMarkdown(report), /Re-enter: campaigns-os next --packet/);
    assert.equal(createStandardizationReport({ targetRepo: dir, slug: "route-b" }).roots[0].entry_point.name, "Hand-authored", "another route's packet does not select this route's entry point");
  });
});

test("unknown and escaping slugs stay unresolved without auditing another source or built directory", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    write(join(dir, "outside/index.html"), "{% raw %}Outside project source{% endraw %}");
    for (const slug of ["unknown", "..", "../outside", "route-a/../route-b", "/route-a", "route-a\\route-b"]) {
      const root = createStandardizationReport({ targetRepo: dir, slug }).roots[0];
      assert.equal(root.source_structure.html_file_count, 0, slug);
      assert.equal(root.built_output.scope_resolved, false, slug);
      assert.equal(root.built_output.html_count, 0, slug);
      assert.ok(codes(root).includes("built_output.scope_unresolved"), slug);
      assert.ok(codes(root).includes("source.scope_unresolved"), slug);
      assert.ok(!codes(root).includes("source.raw_block"), slug);
    }
  });
});

test("a scoped audit names missing source and available routes when the route folder does not exist", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    rmSync(join(dir, "_site"), { recursive: true });
    const report = createStandardizationReport({ targetRepo: dir, slug: "nope" });
    const root = report.roots[0];
    const missing = root.findings.find((item) => item.code === "source.scope_unresolved");
    assert.equal(missing.severity, "operator_readiness");
    assert.equal(missing.category, "operator_readiness");
    assert.match(missing.message, /route nope has no source pages to audit/);
    assert.deepEqual(missing.evidence.slug_candidates, ["route-a", "route-b", "route-c"]);
    assert.equal(root.source_scope.scope_resolved, false);
    assert.deepEqual(root.source_scope.slug_candidates, missing.evidence.slug_candidates);
    assert.equal(root.source_structure.page_file_count, 0);
    assert.equal(report.status, "ready_with_warnings");
    const markdown = formatStandardizationReportMarkdown(report);
    assert.match(markdown, /Source audit: not audited — route nope has no source pages to audit; route folders: route-a, route-b, route-c/);
    assert.doesNotMatch(markdown, /Source audit: limited to route|src\/nope\//);
    const home = join(dir, "home");
    mkdirSync(home);
    const before = snapshotTree(dir);
    const cli = runStandardize(home, ["--target", dir, "--slug", "nope", "--no-doctor"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /\[operator_readiness\] source\.scope_unresolved:/);
    assert.match(cli.stdout, /Source audit: not audited/);
    assert.doesNotMatch(cli.stdout, /Source audit: limited to route/);
    assert.deepEqual(snapshotTree(dir), before);
    assert.deepEqual(readdirSync(home), []);
  });
});

test("a scoped audit reports no source pages for empty, assets-only, and include/layout-only route folders", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    mkdirSync(join(dir, "src/empty"));
    for (const populate of [
      () => {},
      () => write(join(dir, "src/empty/assets/example.html"), "<div>Asset</div>"),
      () => {
        write(join(dir, "src/empty/_includes/example.html"), "{% include 'shared/clean' %}");
        write(join(dir, "src/empty/_layouts/base.liquid"), "<main>{{ content }}</main>");
        write(join(dir, "src/shared/clean.html"), "<div>Shared fragment</div>");
      },
    ]) {
      populate();
      const report = createStandardizationReport({ targetRepo: dir, slug: "empty" });
      const root = report.roots[0];
      const missing = root.findings.find((item) => item.code === "source.scope_unresolved");
      assert.equal(missing.severity, "operator_readiness");
      assert.equal(missing.category, "operator_readiness");
      assert.match(missing.message, /route empty has no source pages to audit/);
      assert.deepEqual(missing.evidence.slug_candidates, ["empty", "route-a", "route-b", "route-c"]);
      assert.equal(root.source_scope.scope_resolved, false);
      assert.equal(report.status, "ready_with_warnings");
      const markdown = formatStandardizationReportMarkdown(report);
      assert.match(markdown, /Source audit: not audited — route empty has no source pages to audit; route folders: empty, route-a, route-b, route-c/);
      assert.doesNotMatch(markdown, /Source audit: limited to route/);
    }
  });
});

test("a scoped audit rejects slugs that are not a path segment without displaying a source path from them", () => {
  withTempDir((dir) => {
    writeMultiRouteRoot(dir);
    rmSync(join(dir, "_site"), { recursive: true });
    write(join(dir, "outside/index.html"), "{% raw %}Outside source{% endraw %}");
    for (const slug of [".", "..", "../etc", "../outside", "route-a/../route-b", "/route-a", "route-a\\route-b"]) {
      const report = createStandardizationReport({ targetRepo: dir, slug });
      const root = report.roots[0];
      const missing = root.findings.find((item) => item.code === "source.scope_unresolved");
      assert.equal(missing.severity, "operator_readiness", slug);
      assert.equal(missing.category, "operator_readiness", slug);
      assert.ok(missing.message.includes(`route ${slug} has no source pages to audit`));
      assert.match(missing.message, /slug must be a single path segment/);
      assert.deepEqual(missing.evidence.slug_candidates, ["route-a", "route-b", "route-c"]);
      assert.equal(root.source_structure.html_file_count, 0, slug);
      assert.equal(root.source_scope.scope_resolved, false, slug);
      assert.equal(report.status, "ready_with_warnings", slug);
      assert.ok(!codes(root).includes("source.raw_block"), slug);
      const markdown = formatStandardizationReportMarkdown(report);
      assert.match(markdown, /Source audit: not audited/);
      assert.doesNotMatch(markdown, /Source audit: limited to route/);
      assert.ok(!markdown.includes(`src/${slug}/`), slug);
    }
  });
});

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
    assert.ok(codes(entry).includes("version.sdk_below_minimum_supported"));
    assert.ok(codes(entry).includes("version.page_kit_below_preferred_cutoff"));
  });
});

test("SDK support policy applies to Page Kit roots, bundled and overridden alike", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.28", pageKitVersion: "^0.1.1" });

    const bundled = createStandardizationReport({ targetRepo: dir });
    const [root] = bundled.roots;
    assert.equal(root.version_policy.source, "contracts/campaign-cart-sdk-support-policy.v0.json");
    assert.deepEqual(root.version_policy.evaluations, [
      { version: "0.4.28", source: "campaigns_json", meets_minimum: true, meets_preferred: false },
    ]);
    assert.ok(codes(root).includes("version.sdk_below_preferred_policy"));
    assert.ok(!codes(root).includes("version.sdk_below_minimum_supported"));
    assert.match(formatStandardizationReportMarkdown(bundled), /- Version policy: min 0\.4\.20, preferred 0\.4\.30 \(contracts\/campaign-cart-sdk-support-policy\.v0\.json\)/);

    const strict = createStandardizationReport({
      targetRepo: dir,
      sdkSupportPolicy: { source: "strict-policy", minimum_supported: "0.4.35", preferred_minimum: "0.5.0" },
    });
    const [strictRoot] = strict.roots;
    assert.equal(strictRoot.version_policy.source, "strict-policy");
    assert.equal(strictRoot.status, "blocked");
    const blocker = strictRoot.findings.find((item) => item.code === "version.sdk_below_minimum_supported");
    assert.equal(blocker.severity, "blocker");
    assert.match(blocker.message, /below the minimum supported 0\.4\.35 \(policy: strict-policy\)/);
    assert.match(formatStandardizationReportMarkdown(strict), /- Version policy: min 0\.4\.35, preferred 0\.5\.0 \(strict-policy\)/);
  });
});

test("checkout field contract applies to Page Kit roots that inline checkout bindings", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    const plain = createStandardizationReport({ targetRepo: dir });
    assert.ok(!plain.roots[0].capabilities.includes("checkout_field_contract"));
    assert.equal("checkout_fields" in plain.roots[0], false);

    write(join(dir, "src", "acme", "_includes", "fields.html"), `
<input data-next-checkout-field="fname">
<input data-next-checkout-field="zip">
`);
    const bundled = createStandardizationReport({ targetRepo: dir });
    const [root] = bundled.roots;
    assert.ok(root.capabilities.includes("checkout_field_contract"));
    assert.equal(root.checkout_fields.bindings.length, 2);
    assert.ok(codes(root).includes("checkout.unsupported_field_binding"));

    const custom = createStandardizationReport({
      targetRepo: dir,
      fieldContract: { schema_version: "custom-fields/test", canonical_fields: ["fname", "zip"] },
    });
    assert.equal(custom.roots[0].checkout_fields.contract, "custom-fields/test");
    assert.ok(!codes(custom.roots[0]).includes("checkout.unsupported_field_binding"));

    // Binding discovery follows the effective contract's attributes, so a
    // contract naming another attribute still finds and judges those bindings.
    write(join(dir, "src", "acme", "_includes", "fields.html"), `<input my-checkout-field="zip">`);
    const renamed = createStandardizationReport({
      targetRepo: dir,
      fieldContract: { schema_version: "custom-fields/test", binding_attributes: ["my-checkout-field"], canonical_fields: ["postal"], stale_aliases: { zip: "postal" } },
    });
    assert.ok(renamed.roots[0].capabilities.includes("checkout_field_contract"));
    assert.equal(renamed.roots[0].checkout_fields.bindings.length, 1);
    assert.ok(codes(renamed.roots[0]).includes("checkout.unsupported_field_binding"));
    assert.ok(!createStandardizationReport({ targetRepo: dir }).roots[0].capabilities.includes("checkout_field_contract"));
  });
});

test("standardization report surfaces certification freshness for the inferred family (#263)", () => {
  withTempDir((dir) => {
    const root = join(dir, "campaign");
    writeFixtureRoot(root);

    const report = createStandardizationReport({ targetRepo: dir });
    const [entry] = report.roots;
    const freshness = entry.identity.template_certification_freshness;
    assert.ok(freshness, "an inferred family gets a freshness assessment");
    assert.equal(freshness.family, "olympus-mv-single-step");
    // The vendored snapshot in this repo records verification for the public
    // families, so the report must state the last-verified SDK and current SDK
    // rather than merely saying "certified".
    assert.match(freshness.summary, /last verified against SDK \d+\.\d+\.\d+/);
    assert.ok(freshness.current_sdk_version, "the current SDK is stated");

    const markdown = formatStandardizationReportMarkdown(report);
    assert.match(markdown, /- Certification freshness: /, "the markdown identity block carries the freshness line");
  });
});

test("catalog resolution failure warns once per run and the report still generates (#266 review)", () => {
  withTempDir((dir) => {
    // Two roots prove the warn is one-shot per run, not per root.
    writeFixtureRoot(join(dir, "alpha"));
    writeFixtureRoot(join(dir, "beta"));

    // A schema-mismatched private-template-source allowlist makes
    // resolveCommerceCatalog throw before any per-family handling.
    const badAllowlist = join(dir, "private-template-sources.json");
    writeFileSync(badAllowlist, JSON.stringify({ schema_version: "wrong/v9", sources: {} }));

    const previousEnv = process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(" "));
    try {
      process.env.PRIVATE_TEMPLATE_SOURCES_PATH = badAllowlist;
      const report = createStandardizationReport({ targetRepo: dir });
      assert.equal(report.roots.length, 2, "the report still generates");
      for (const entry of report.roots) {
        assert.equal(entry.identity.template_certification_freshness, null, "freshness degrades to null, not a crash");
      }
      const suppressed = warned.filter((line) => line.startsWith("[standardize] freshness suppressed: "));
      assert.equal(suppressed.length, 1, "exactly one suppression warn per run");
      assert.match(suppressed[0], /schema_version/);
    } finally {
      console.warn = originalWarn;
      if (previousEnv === undefined) delete process.env.PRIVATE_TEMPLATE_SOURCES_PATH;
      else process.env.PRIVATE_TEMPLATE_SOURCES_PATH = previousEnv;
    }
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

test("standardization report handles raw dash forms and unreadable source files", () => {
  withTempDir((dir) => {
    write(join(dir, "package.json"), JSON.stringify({
      dependencies: { "next-campaign-page-kit": "^0.1.1" },
    }, null, 2));
    write(join(dir, "_data", "campaigns.json"), JSON.stringify({
      acme: { sdk_version: "0.4.25", store_url: "https://acme.example/" },
    }, null, 2));
    write(join(dir, "src", "acme", "checkout.html"), `
<section>
  {%-raw-%}{{ 'image.jpg' | campaign_asset }}{%-endraw-%}
  <form data-next-checkout="form"></form>
</section>
`);
    const unreadable = join(dir, "src", "acme", "blocked.html");
    write(unreadable, "<main></main>");
    chmodSync(unreadable, 0);

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];

    assert.equal(root.source_structure.raw_blocks.count, 1);
    assert.equal(root.source_structure.unreadable_files.count, 1);
    assert.ok(codes(root).includes("source.raw_block"));
    assert.ok(codes(root).includes("source.file_unreadable"));
  });
});

test("hardcoded root asset scan ignores scripts and comments", () => {
  withTempDir((dir) => {
    write(join(dir, "package.json"), JSON.stringify({
      dependencies: { "next-campaign-page-kit": "^0.1.1" },
    }, null, 2));
    write(join(dir, "_data", "campaigns.json"), JSON.stringify({
      acme: { sdk_version: "0.4.25", store_url: "https://acme.example/" },
    }, null, 2));
    write(join(dir, "src", "acme", "checkout.html"), `
<!-- <img src="/assets/commented.png"> -->
{% comment %}<a href="/assets/liquid-comment.png"></a>{% endcomment %}
<script>
  const template = '<img src="/assets/script-string.png">';
</script>
<img src="/assets/real.png">
<form data-next-checkout="form"></form>
`);

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    const evidence = root.findings
      .find((finding) => finding.code === "source.hardcoded_root_assets")
      ?.evidence.map((sample) => sample.match).join("\n") || "";

    assert.equal(root.source_structure.hardcoded_root_assets.count, 1);
    assert.match(evidence, /real\.png/);
    assert.doesNotMatch(evidence, /commented|liquid-comment|script-string/);
  });
});

function writeTwoCampaigns(root) {
  write(join(root, "_data", "campaigns.json"), JSON.stringify({
    acme: { name: "Acme Funnel", sdk_version: "0.4.30", store_url: "https://acme.example/" },
    beta: { name: "Beta Funnel", sdk_version: "0.4.30", store_url: "https://beta.example/" },
  }, null, 2));
}

test("standardization report marks built output unresolved when no slug source disambiguates", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.25", pageKitVersion: "^0.1.1" });
    writeTwoCampaigns(dir);
    write(join(dir, "_site", "beta", "index.html"), "<h1>Built Beta</h1>");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.identity.campaign_slug, null);
    assert.equal(root.built_output.present, true);
    assert.equal(root.built_output.scope_resolved, false);
    assert.equal(root.built_output.html_count, 0);
    assert.deepEqual(root.built_output.slug_candidates, ["acme", "beta"]);
    assert.match(formatStandardizationReportMarkdown(report), /Built _site: unresolved/);
    assert.ok(codes(root).includes("built_output.scope_unresolved"));
    assert.ok(root.remediation.proof_commands.some((command) => /doctor --built .* --slug <slug> --json$/.test(command)));
  });
});

test("built output scope defaults to the campaigns.json slug when _site holds a stale sibling", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    write(join(dir, "_site", "stale-old", "index.html"), "<h1>Stale</h1>");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.identity.campaign_slug, "acme");
    assert.equal(root.identity.campaign_slug_source, "campaigns_json");
    assert.equal(root.built_output.scope_resolved, true);
    assert.equal(root.built_output.slug, "acme");
    assert.equal(root.built_output.slug_source, "campaigns_json");
    assert.equal(root.built_output.html_count, 2);
    assert.ok(!codes(root).includes("built_output.scope_unresolved"));
    assert.ok(root.remediation.proof_commands.some((command) => /doctor --built .* --slug acme --json$/.test(command)));
    assert.match(formatStandardizationReportMarkdown(report), /- Built slug: acme \(campaigns_json\)/);
  });
});

test("built output scope ignores root-level html when the campaign slug is known", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    write(join(dir, "_site", "index.html"), "<h1>Site root</h1>");

    const root = createStandardizationReport({ targetRepo: dir }).roots[0];
    assert.equal(root.built_output.scope_resolved, true);
    assert.equal(root.built_output.slug, "acme");
    assert.equal(root.built_output.html_count, 2);
  });
});

test("built output scope falls back to the runtime packet slug when campaigns.json lists several", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    writeTwoCampaigns(dir);
    write(join(dir, "_site", "beta", "index.html"), "<h1>Built Beta</h1>");
    write(join(dir, ".campaign-runtime", "build-packet.json"), JSON.stringify({
      campaign: { public_route_slug: "acme", allowed_domains_confirmed: true },
    }, null, 2));

    const root = createStandardizationReport({ targetRepo: dir }).roots[0];
    assert.equal(root.identity.campaign_slug, "acme");
    assert.equal(root.identity.campaign_slug_source, ".campaign-runtime/build-packet.json");
    assert.equal(root.built_output.scope_resolved, true);
    assert.equal(root.built_output.slug, "acme");
    assert.equal(root.built_output.slug_source, ".campaign-runtime/build-packet.json");
    assert.equal(root.built_output.html_count, 2);

    // Packets that disagree are an ambiguity, not a first-wins pick.
    write(join(dir, ".campaign-runtime", "beta-packet.json"), JSON.stringify({
      campaign: { public_route_slug: "beta", allowed_domains_confirmed: true },
    }, null, 2));
    const ambiguous = createStandardizationReport({ targetRepo: dir }).roots[0];
    assert.equal(ambiguous.identity.campaign_slug, null);
    assert.equal(ambiguous.built_output.scope_resolved, false);
    assert.ok(codes(ambiguous).includes("built_output.scope_unresolved"));
  });
});

test("a derived slug with no built directory is a mismatch finding, never a silent scope", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    rmSync(join(dir, "_site", "acme"), { recursive: true, force: true });
    write(join(dir, "_site", "stale-old", "index.html"), "<h1>Stale</h1>");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.built_output.scope_resolved, false);
    assert.equal(root.built_output.slug, "acme");
    assert.equal(root.built_output.html_count, 0);
    assert.deepEqual(root.built_output.slug_candidates, ["stale-old"]);
    assert.equal(root.built_output.doctor.status, "skipped");
    assert.notEqual(root.status, "ready");
    const mismatch = root.findings.find((item) => item.code === "built_output.slug_mismatch");
    assert.equal(mismatch.severity, "operator_readiness");
    assert.match(mismatch.message, /no acme\/ directory for campaign slug acme \(from campaigns_json\); built directories: stale-old/);
    assert.deepEqual(mismatch.evidence, { expected_slug: "acme", slug_source: "campaigns_json", slug_directory_present: false, slug_candidates: ["stale-old"] });
    assert.equal(root.built_output.slug_directory_present, false);
    assert.ok(!codes(root).includes("built_output.scope_unresolved"));
    assert.match(formatStandardizationReportMarkdown(report), /- Built slug: acme not found \(built directories: stale-old\)/);

    // An explicit --slug that names a missing directory stays the operator's
    // own unresolved scope, not a mismatch against the derived slug.
    const explicit = createStandardizationReport({ targetRepo: dir, slug: "acme" }).roots[0];
    assert.ok(codes(explicit).includes("built_output.scope_unresolved"));
    assert.ok(!codes(explicit).includes("built_output.slug_mismatch"));
  });
});

test("a derived slug whose built directory holds no HTML pages is named as empty, not missing", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    rmSync(join(dir, "_site", "acme"), { recursive: true, force: true });
    write(join(dir, "_site", "acme", "assets", "app.css"), "body{}");
    write(join(dir, "_site", "stale-old", "index.html"), "<h1>Stale</h1>");

    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.equal(root.built_output.scope_resolved, false);
    assert.equal(root.built_output.slug, "acme");
    assert.equal(root.built_output.slug_directory_present, true);
    assert.deepEqual(root.built_output.slug_candidates, ["stale-old"]);
    const mismatch = root.findings.find((item) => item.code === "built_output.slug_mismatch");
    assert.match(mismatch.message, /^Built _site\/acme\/ exists but holds no HTML pages for campaign slug acme \(from campaigns_json\); built directories: stale-old\./);
    assert.ok(!/no acme\/ directory/.test(mismatch.message));
    assert.equal(mismatch.evidence.slug_directory_present, true);
    assert.match(mismatch.next_action, /contains its HTML pages/);
    assert.match(root.built_output.doctor.reason, /exists but holds no HTML pages/);
    assert.match(formatStandardizationReportMarkdown(report), /- Built slug: acme has no HTML pages \(built directories: stale-old\)/);
  });
});

test("capabilities list the inspections that ran, so the doctor appears only once attached", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    const report = createStandardizationReport({ targetRepo: dir });
    const root = report.roots[0];
    assert.deepEqual(root.capabilities, [
      "page_kit_source_contract",
      "sdk_version_policy",
      "campaign_cart_runtime_inventory",
    ]);
    attachBuiltOutputDoctor(report, root.id, { ok: true, status: "ready", mode: "built_site", errors: [], warnings: [], ready: [] });
    assert.ok(root.capabilities.includes("built_output_doctor"));
    attachBuiltOutputDoctor(report, root.id, { ok: true, status: "ready", mode: "built_site", errors: [], warnings: [], ready: [] });
    assert.equal(root.capabilities.filter((name) => name === "built_output_doctor").length, 1);
  });
});

const cli = resolve(import.meta.dirname, "../bin/campaigns-os.mjs");

function runStandardize(cwd, args) {
  return spawnSync(process.execPath, [cli, "standardize", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: cwd, CAMPAIGNS_OS_TELEMETRY: "off" },
  });
}

// Every file under a directory with its size, mtime and content hash: the
// read-only proof compares this before and after a run.
function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path, kind: "dir" });
        walk(path);
      } else {
        const stat = statSync(path);
        entries.push({ path, kind: "file", size: stat.size, mtime: stat.mtimeMs, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      }
    }
  };
  walk(root);
  return entries;
}

test("scoped CLI audits the selected route without writing and prints shared ownership", (t) => {
  withTempDir((dir) => {
    const home = join(dir, "home");
    const target = join(dir, "example-project");
    mkdirSync(home, { recursive: true });
    writeMultiRouteRoot(target);
    const before = snapshotTree(target);
    const clean = runStandardize(home, ["--target", target, "--slug", "route-a", "--family", "apollo", "--no-doctor", "--json"]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.ok(!codes(JSON.parse(clean.stdout).roots[0]).includes("source.raw_block"));
    const shared = runStandardize(home, ["--target", target, "--slug", "route-b", "--family", "apollo", "--no-doctor"]);
    assert.equal(shared.status, 2, shared.stderr);
    assert.match(shared.stdout, /used by routes: route-b, route-c/);
    assert.doesNotMatch(shared.stdout, /source.document_wrappers/);
    assert.deepEqual(snapshotTree(target), before);
    assert.deepEqual(readdirSync(home), []);
    t.diagnostic(shared.stdout.replaceAll(target, "/tmp/example-project").replace(/^Generated: .*$/m, "Generated: <run timestamp>"));
  });
});

test("standardize refuses unknown flags instead of running as if they were absent", () => {
  withTempDir((dir) => {
    const home = join(dir, "home");
    const target = join(dir, "campaign");
    mkdirSync(home, { recursive: true });
    writeFixtureRoot(target, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });

    const bogus = runStandardize(home, ["--target", target, "--bogus", "--json"]);
    assert.equal(bogus.status, 1);
    assert.equal(bogus.stdout, "");
    assert.match(bogus.stderr, /Unknown flag for standardize: --bogus\. Known flags: --target, --family, --template-family, --slug, --sdk-support-policy, --field-contract, --no-doctor, --json, --run-id, --lifecycle-journal\./);

    const joined = runStandardize(home, ["--target", target, "--json", "--no-doctor=maybe"]);
    assert.equal(joined.status, 1);
    assert.match(joined.stderr, /--no-doctor=… is not accepted: a flag takes its value as the next argument, not --flag=value\. Write `--no-doctor` alone for an on\/off flag, or `--no-doctor <value>` for a flag that takes a value\./);
    assert.doesNotMatch(joined.stderr, /maybe/, "the value is never echoed");

    const known = runStandardize(home, ["--target", target, "--no-doctor", "--json"]);
    assert.notEqual(known.status, 1, known.stderr);
    assert.equal(JSON.parse(known.stdout).roots[0].built_output.doctor.reason, "--no-doctor was provided");
  });
});

test("standardize honours --sdk-support-policy on a Page Kit root from the command line", () => {
  withTempDir((dir) => {
    const home = join(dir, "home");
    const target = join(dir, "campaign");
    mkdirSync(home, { recursive: true });
    writeFixtureRoot(target, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    const policyPath = join(dir, "strict-policy.json");
    writeFileSync(policyPath, JSON.stringify({ source: "strict-policy", minimum_supported: "0.4.35", preferred_minimum: "0.5.0" }));

    const plain = runStandardize(home, ["--target", target, "--no-doctor", "--json"]);
    const strict = runStandardize(home, ["--target", target, "--no-doctor", "--json", "--sdk-support-policy", policyPath]);
    // The fixture carries a raw-block blocker, so both runs exit 2; the policy
    // difference shows in the version findings, not the exit code.
    assert.equal(plain.status, 2, plain.stderr);
    assert.equal(strict.status, 2, strict.stderr);
    const plainRoot = JSON.parse(plain.stdout).roots[0];
    const strictRoot = JSON.parse(strict.stdout).roots[0];
    assert.equal(plainRoot.version_policy.source, "contracts/campaign-cart-sdk-support-policy.v0.json");
    assert.equal(strictRoot.version_policy.source, "strict-policy");
    assert.ok(codes(strictRoot).includes("version.sdk_below_minimum_supported"));
    assert.ok(!codes(plainRoot).includes("version.sdk_below_minimum_supported"));
    assert.match(runStandardize(home, ["--target", target, "--no-doctor", "--sdk-support-policy", policyPath]).stdout, /Version policy: min 0\.4\.35, preferred 0\.5\.0 \(strict-policy\)/);
  });
});

test("standardize is read-only: a run with the built-output doctor leaves the target byte-identical", () => {
  withTempDir((dir) => {
    const home = join(dir, "home");
    const target = join(dir, "campaign");
    mkdirSync(home, { recursive: true });
    writeFixtureRoot(target, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
    write(join(target, "_site", "stale-old", "index.html"), "<h1>Stale</h1>");
    const before = snapshotTree(target);

    const json = runStandardize(home, ["--target", target, "--json"]);
    assert.notEqual(json.status, 1, json.stderr);
    const root = JSON.parse(json.stdout).roots[0];
    // The slug came from campaigns.json, so the doctor actually ran here.
    assert.equal(root.built_output.slug, "acme");
    assert.notEqual(root.built_output.doctor.status, "skipped");
    assert.ok(root.capabilities.includes("built_output_doctor"));
    const markdown = runStandardize(home, ["--target", target]);
    assert.notEqual(markdown.status, 1, markdown.stderr);
    assert.match(markdown.stdout, /# Campaign Standardization Report/);

    assert.deepEqual(snapshotTree(target), before);
    assert.deepEqual(readdirSync(home), []);

    const scoped = runStandardize(home, ["--target", target, "--slug", "acme", "--json"]);
    assert.notEqual(scoped.status, 1, scoped.stderr);
    assert.equal(JSON.parse(scoped.stdout).roots[0].source_scope.route, "acme");
    assert.notEqual(JSON.parse(scoped.stdout).roots[0].built_output.doctor.status, "skipped");
    assert.deepEqual(snapshotTree(target), before);
    assert.deepEqual(readdirSync(home), []);
  });
});

// #312 reported `standardize` writing .campaign-runtime/doctor-output.json.
// It never did: the repro copied a target-page-kit example that carried a
// gitignored sidecar from an earlier doctor run in that checkout, and `cp -R`
// copies ignored files. So the proof is in the issue's own shape — a target
// that already holds a sidecar, with and without a built _site, with and
// without --no-doctor — and every byte, mtime and size under the target is
// unchanged afterwards, the sidecar included. A producer's stamp would make
// the mistake impossible to repeat: the sidecar now says who wrote it.
test("standardize never touches an existing doctor sidecar, with or without --no-doctor (#312)", () => {
  for (const withSite of [false, true]) {
    withTempDir((dir) => {
      const home = join(dir, "home");
      const target = join(dir, "campaign");
      mkdirSync(home, { recursive: true });
      writeFixtureRoot(target, { sdkVersion: "0.4.30", pageKitVersion: "^0.1.1" });
      if (withSite) write(join(target, "_site", "acme", "index.html"), "<h1>Built</h1>");
      const sidecar = join(target, ".campaign-runtime", "doctor-output.json");
      write(sidecar, JSON.stringify({ schema_version: "campaigns-os-doctor-output/v0", generated_at: "2026-09-15T03:02:05.568Z", generated_by: "doctor", ok: true, status: "ready_with_warnings" }, null, 2));
      const before = snapshotTree(target);

      for (const args of [["--json"], ["--no-doctor", "--json"], [], ["--slug", "acme", "--json"], ["--slug", "acme", "--no-doctor", "--json"]]) {
        const run = runStandardize(home, ["--target", target, ...args]);
        assert.notEqual(run.status, 1, run.stderr);
        assert.deepEqual(snapshotTree(target), before, `standardize ${args.join(" ")} (site: ${withSite}) changed the target`);
      }
      assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).generated_by, "doctor", "the sidecar still names its real producer");
      assert.deepEqual(readdirSync(home), []);
    });
  }
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

test("built-output doctor codeless findings keep unique codes", () => {
  withTempDir((dir) => {
    writeFixtureRoot(dir, { sdkVersion: "0.4.25", pageKitVersion: "^0.1.1" });
    const report = createStandardizationReport({ targetRepo: dir });
    attachBuiltOutputDoctor(report, report.roots[0].id, {
      ok: false,
      status: "blocked",
      mode: "built_site",
      errors: [{ message: "First codeless error." }, { message: "Second codeless error." }],
      warnings: [{ message: "First codeless warning." }, { message: "Second codeless warning." }],
      ready: [],
    });

    const root = report.roots[0];
    assert.ok(codes(root).includes("built_doctor.error.1"));
    assert.ok(codes(root).includes("built_doctor.error.2"));
    assert.ok(codes(root).includes("built_doctor.warning.1"));
    assert.ok(codes(root).includes("built_doctor.warning.2"));
  });
});
