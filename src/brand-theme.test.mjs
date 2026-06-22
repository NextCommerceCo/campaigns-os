import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  inspectBrandTheme,
  validateAssemblyReportThemeBlock,
  validateGeneratedCss,
  validateThemeContextBlock,
  writeThemeArtifacts,
} from "./brand-theme.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-brand-theme-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function makePacket(dir, pages = [{ page_id: "landing", path: "landing.html" }]) {
  const source = join(dir, "source");
  const target = join(dir, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  const packetPath = join(target, "campaign-runtime.build.json");
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: {
      public_route_slug: "brand-demo",
      campaign_directory: "brand-demo",
      live_url_path: "/brand-demo/",
      allowed_domains_confirmed: true,
    },
    spec: {
      map_id: "brand-demo-k9x2",
      local_path: "../spec.json",
    },
    source_html: {
      root: "../source",
      pages,
    },
    assembly: {
      target_repo: ".",
      output_dir: "src/brand-demo",
      template_family: "olympus",
      template_lock: { locked: true },
    },
    deploy: { target: "unknown" },
    qa: {
      test_orders_allowed: false,
      sandbox_test_card_confirmed: false,
    },
  };
  writeJson(packetPath, packet);
  return { source, target, packet, packetPath };
}

function highConfidenceTokens() {
  return `
:root {
  --brand-primary: #2c3d43;
  --brand-accent: #2dc20b;
  --brand-cta: #2dc20b;
  --surface-bg: #ffffff;
  --surface-card: #f3f7f4;
  --text-primary: #132025;
  --text-secondary: #55676f;
  --border-default: #d7e1dc;
}
`;
}

test("brand theme discovers linked CSS from mapped HTML and maps root-only next-core tokens", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/brand.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/brand.css"), highConfidenceTokens());

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.status, "ready");
    assert.equal(result.confidence, "high");
    assert.equal(result.context_theme.selected_source.source, "mapped_html_reference");
    assert.ok(result.context_theme.mappings.some((mapping) => mapping.target === "--brand--color--primary"));
    assert.ok(result.context_theme.mappings.some((mapping) => mapping.target === "--brand--color--cta-primary"));
    assert.equal(validateGeneratedCss(result.css).ok, true);
    assert.match(result.css, /:root \{/);
    assert.doesNotMatch(result.css, /\.checkout|data-next|button\s*\{/);
  });
});

test("brand theme infers safe CTA tokens from linked button CSS when root tokens are absent", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "styles"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<link rel="stylesheet" href="styles/marketing.css"><main>Landing</main>`);
    writeFileSync(join(source, "styles/marketing.css"), `
.muted-card { background-color: #f6f6f6; }
.cta-button {
  background-color: #e4572e;
  color: #ffffff;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.status, "ready");
    assert.equal(result.confidence, "medium");
    assert.equal(result.context_theme.selected_source.source, "mapped_html_reference");
    assert.ok(result.context_theme.mappings.some((mapping) => (
      mapping.source === "--button-primary-bg"
      && mapping.target === "--brand--color--cta-primary"
      && mapping.value === "#e4572e"
    )));
    assert.match(result.css, /--brand--color--cta-primary: #e4572e;/);
    assert.equal(result.context_theme.generated.can_generate, true);
    assert.equal(result.context_theme.generated.can_auto_generate, false);
  });
});

test("brand theme detects inline :root tokens from mapped HTML without workflow-order assumptions", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    writeFileSync(join(source, "landing.html"), `<style>${highConfidenceTokens()}</style><main>Landing</main>`);

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.context_theme.selected_source.source, "html_inline_root");
    assert.equal(result.context_theme.selected_source.inline_block_index, 0);
    assert.equal(result.confidence, "high");
  });
});

test("brand theme lowers confidence when source tokens match figma exporter defaults after normalization", () => {
  withTempDir((dir) => {
    const { source, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), `
:root {
  --brand-primary: #0F75FF;
  --surface-bg: rgb(255, 255, 255);
  --text-primary: #020b1e;
}
`);

    const result = inspectBrandTheme({ packet, packetPath });

    assert.equal(result.confidence, "low");
    assert.equal(result.context_theme.producer_defaults.matched, true);
    assert.ok(result.warnings.some((warning) => warning.code === "theme.source_tokens.defaults"));
    assert.equal(result.context_theme.generated.can_generate, false);
  });
});

test("generated CSS safety rejects selectors and protected runtime surfaces", () => {
  const result = validateGeneratedCss(`
:root { --brand--color--primary: #123456; }
[data-next-package-id] { display: none; }
`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "theme.css.selector"));
});

test("theme generate writes artifacts and treats identical reruns as current", () => {
  withTempDir((dir) => {
    const { source, target, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());

    const inspection = inspectBrandTheme({ packet, packetPath });
    const first = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true });
    assert.equal(first.ok, true);
    assert.equal(first.wrote.css, true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/brand-theme.css")), true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/theme-report.json")), true);

    const second = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true });
    assert.equal(second.ok, true);
    assert.equal(second.wrote.css, false);
    assert.equal(second.already_current.css, true);
  });
});

test("theme generate refuses different existing CSS without force and prints a safe command", () => {
  withTempDir((dir) => {
    const { source, target, packet, packetPath } = makePacket(dir);
    mkdirSync(join(source, "assets/css"), { recursive: true });
    writeFileSync(join(source, "landing.html"), `<main>Landing</main>`);
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
    mkdirSync(join(target, ".campaign-runtime/theme"), { recursive: true });
    writeFileSync(join(target, ".campaign-runtime/theme/brand-theme.css"), ":root { --brand--color--primary: #000000; }\n");

    const inspection = inspectBrandTheme({ packet, packetPath, force: true });
    const result = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true, packetPath });

    assert.equal(result.ok, false);
    const error = result.errors.find((issue) => issue.code === "theme.generate.exists");
    assert.ok(error);
    assert.match(error.message, new RegExp(`theme generate --packet ${packetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --force`));
    assert.deepEqual(error.detail.safe_commands, [`campaigns-os theme generate --packet ${packetPath} --force`]);
  });
});

test("theme generate reports empty CSS before checking existing artifact overwrite", () => {
  withTempDir((dir) => {
    const { target, packetPath } = makePacket(dir);
    mkdirSync(join(target, ".campaign-runtime/theme"), { recursive: true });
    writeFileSync(join(target, ".campaign-runtime/theme/brand-theme.css"), ":root { --brand--color--primary: #000000; }\n");
    const inspection = {
      errors: [],
      status: "ready",
      context_theme: { generated: { can_generate: true } },
      report: { status: "ready" },
      css: "",
      absolute_paths: {
        report_path: join(target, ".campaign-runtime/theme/theme-report.json"),
        css_path: join(target, ".campaign-runtime/theme/brand-theme.css"),
      },
    };

    const result = writeThemeArtifacts(inspection, { writeCss: true, writeReport: true, packetPath });

    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.code === "theme.generate.empty"), true);
    assert.equal(result.errors.some((error) => error.code === "theme.generate.exists"), false);
  });
});

test("theme validators reject malformed context and applied report load order", () => {
  const contextResult = validateThemeContextBlock({
    status: "ready",
    policy: "auto",
    source_kind: "figma_sections",
    confidence: "high",
    generated: { css_path: "/tmp/brand-theme.css" },
  });
  assert.equal(contextResult.ok, false);
  assert.ok(contextResult.errors.some((error) => error.code === "context.theme.source_kind"));
  assert.ok(contextResult.errors.some((error) => error.code === "context.theme.generated.css_path"));

  const reportResult = validateAssemblyReportThemeBlock({
    status: "applied",
    css_path: "src/demo/assets/css/brand-theme.css",
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: null,
  });
  assert.equal(reportResult.ok, false);
  assert.ok(reportResult.errors.some((error) => error.code === "report.theme.load_order"));

  const looseBackCompatResult = validateAssemblyReportThemeBlock({
    status: "needs_review",
    css_path: null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: {},
  });
  assert.equal(looseBackCompatResult.ok, true);

  const malformedDefectResult = validateAssemblyReportThemeBlock({
    status: "needs_review",
    css_path: null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: [],
    warnings: [],
    repair_loop_defect: "not-an-object",
  });
  assert.equal(malformedDefectResult.ok, false);
  assert.ok(malformedDefectResult.errors.some((error) => error.code === "report.theme.repair_loop_defect"));
});

test("prepare-build records inspect-only theme context and report without writing CSS by default", () => {
  withTempDir((dir) => {
    const source = join(dir, "source");
    const target = join(dir, "target");
    mkdirSync(join(source, "assets/css"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeJson(join(target, "package.json"), { dependencies: { "next-campaign-page-kit": "fixture" } });
    for (const page of ["landing", "checkout", "upsell", "receipt"]) {
      writeFileSync(join(source, `${page}.html`), page === "landing" ? `<link rel="stylesheet" href="assets/css/tokens.css">` : `<main>${page}</main>`);
    }
    writeFileSync(join(source, "assets/css/tokens.css"), highConfidenceTokens());
    const specPath = join(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));

    const output = execFileSync(process.execPath, [
      cli,
      "prepare-build",
      "--spec", specPath,
      "--source", source,
      "--target", target,
      "--template-family", "olympus",
      "--json",
    ], { cwd: root, encoding: "utf8" });
    const result = JSON.parse(output);

    assert.equal(result.context.theme.policy, "inspect_only");
    assert.equal(result.context.theme.confidence, "high");
    assert.equal(result.context.theme.wrote.report, true);
    assert.equal(result.context.theme.wrote.css, false);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/theme-report.json")), true);
    assert.equal(existsSync(join(target, ".campaign-runtime/theme/brand-theme.css")), false);
    assert.equal(result.report.theme.status, "needs_review");
  });
});
