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
    assert.match(joined.stderr, /Unknown flag for standardize: --no-doctor=maybe\. A flag takes its value as the next argument \(--flag value\), not --flag=value\./);

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
