import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  evaluatePageKitBuildSummary,
  PAGE_KIT_BUILD_SUMMARY_REL_PATH,
  readPageKitBuildSummary,
} from "./page-kit-build-summary.mjs";

const SLUG = "test-campaign";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-build-summary-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scaffoldTargetRepo(dir, { summary = null, builtPages = [] } = {}) {
  const targetRepo = join(dir, "target");
  mkdirSync(join(targetRepo, "_site", SLUG), { recursive: true });
  for (const rel of builtPages) {
    const path = join(targetRepo, "_site", SLUG, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<html><body>built</body></html>");
  }
  if (summary !== null) {
    const path = join(targetRepo, PAGE_KIT_BUILD_SUMMARY_REL_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof summary === "string" ? summary : JSON.stringify(summary));
  }
  return targetRepo;
}

function summaryPage(overrides = {}) {
  return {
    inputFile: `src/${SLUG}/landing.html`,
    outputFile: `_site/${SLUG}/landing/index.html`,
    campaignSlug: SLUG,
    url: `/${SLUG}/landing/`,
    status: "built",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

const codes = (issues) => issues.map((issue) => issue.code);

test("build summary: silent when the campaign has no built _site yet", () => {
  withTempDir((dir) => {
    const targetRepo = join(dir, "target");
    mkdirSync(targetRepo, { recursive: true });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG });
    assert.deepEqual(result, { errors: [], warnings: [], ready: [] });
  });
});

test("build summary: missing artifact warns with the capture command", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir);
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG });
    assert.deepEqual(codes(result.warnings), ["built_output.build_summary_missing"]);
    assert.match(result.warnings[0].message, /campaign-build --json/);
    assert.match(result.warnings[0].message, /0\.1\.4/);
    assert.equal(result.errors.length, 0);
  });
});

test("build summary: unparsable artifact warns invalid", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, { summary: "{not json" });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG });
    assert.deepEqual(codes(result.warnings), ["built_output.build_summary_invalid"]);
  });
});

test("build summary: clean summary produces a ready note and no issues", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: { built: 1, errors: 0, warnings: 0, pages: [summaryPage()] },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.ok(result.ready.some((note) => note.includes("Page Kit build summary verified")));
    assert.match(result.ready[0], /no build errors, shape warnings or asset warnings$/);
  });
});

test("build summary: page error is a doctor error once assembly is complete", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: {
        pages: [
          summaryPage(),
          summaryPage({
            inputFile: `src/${SLUG}/checkout.html`,
            url: `/${SLUG}/checkout/`,
            status: "error",
            errors: [{ code: "RENDER_FAILED", message: "Liquid render failed" }],
          }),
        ],
      },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.deepEqual(codes(result.errors), ["built_output.build_page_error"]);
    assert.match(result.errors[0].message, /Liquid render failed/);
    assert.equal(result.ready.length, 0);
  });
});

test("build summary: page error stays a warning before assembly completes", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: { pages: [summaryPage({ status: "error", errors: [{ code: "X", message: "boom" }] })] },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: false });
    assert.equal(result.errors.length, 0);
    assert.deepEqual(codes(result.warnings), ["built_output.build_page_error"]);
  });
});

test("build summary: shape warnings surface per page; DUPLICATE_OUTPUT escalates post-assembly", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: {
        pages: [
          summaryPage({
            warnings: [{ code: "NESTED_NO_PERMALINK", message: "nested page file without permalink" }],
          }),
          summaryPage({
            inputFile: `src/${SLUG}/upsell.html`,
            url: `/${SLUG}/upsell/`,
            warnings: [{ code: "DUPLICATE_OUTPUT", message: "output file collides — last write wins" }],
          }),
        ],
      },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.deepEqual(codes(result.errors), ["built_output.build_page_warning_escalated"]);
    assert.match(result.errors[0].message, /DUPLICATE_OUTPUT/);
    assert.deepEqual(codes(result.warnings), ["built_output.build_page_warning"]);
    assert.match(result.warnings[0].message, /NESTED_NO_PERMALINK/);
  });
});

test("build summary: a failed page's shape warnings survive alongside the error", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: {
        pages: [
          summaryPage({
            status: "error",
            errors: [{ code: "RENDER_FAILED", message: "Liquid render failed" }],
            warnings: [{ code: "NESTED_NO_PERMALINK", message: "nested page file without permalink" }],
          }),
        ],
      },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.deepEqual(codes(result.errors), ["built_output.build_page_error"]);
    assert.deepEqual(codes(result.warnings), ["built_output.build_page_warning"]);
    assert.match(result.warnings[0].message, /NESTED_NO_PERMALINK/);
  });
});

test("build summary: page-kit 0.3.0 assetWarnings surface as non-blocking warnings and suppress the ready note", () => {
  withTempDir((dir) => {
    // The 0.3.0 shape: .html under assets/ is neither built nor copied, and
    // each ignored file is reported in a top-level assetWarnings array, never
    // in pages[].warnings. Another campaign's entry is not this campaign's.
    const ignored = (file) => ({ code: "ASSET_IGNORED", file, message: "ignored, .html files under assets/ are not copied to _site/" });
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: {
        built: 1,
        errors: 0,
        warnings: 2,
        pages: [summaryPage()],
        assetWarnings: [ignored(`src/${SLUG}/assets/embeds/video.html`), ignored("src/other-campaign/assets/terms.html")],
      },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.equal(result.errors.length, 0, "an ignored assets file is a warning even after assembly");
    assert.deepEqual(codes(result.warnings), ["built_output.build_asset_warning"]);
    assert.match(result.warnings[0].message, /ASSET_IGNORED/);
    assert.match(result.warnings[0].message, /assets\/embeds\/video\.html/);
    assert.deepEqual(result.warnings[0].detail, { file: `src/${SLUG}/assets/embeds/video.html`, warning_code: "ASSET_IGNORED" });
    assert.equal(result.ready.length, 0, "the no-warnings ready note needs both lists empty");
  });
});

test("build summary: a 0.3.0 summary with an empty assetWarnings array still reads clean", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, { summary: { pages: [summaryPage()], assetWarnings: [] } });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG, assemblyComplete: true });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ready.length, 1);
  });
});

test("build summary: warns when no summary pages match the campaign slug", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: { pages: [summaryPage({ campaignSlug: "other-campaign" })] },
    });
    const result = evaluatePageKitBuildSummary({ targetRepo, publicRouteSlug: SLUG });
    assert.deepEqual(codes(result.warnings), ["built_output.build_summary_no_pages"]);
    assert.deepEqual(result.warnings[0].detail.summary_slugs, ["other-campaign"]);
  });
});

test("build summary: stale artifact warns when built pages are newer", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, {
      summary: { pages: [summaryPage()] },
      builtPages: ["landing/index.html"],
    });
    const summaryPath = join(targetRepo, PAGE_KIT_BUILD_SUMMARY_REL_PATH);
    const past = new Date(Date.now() - 60_000);
    utimesSync(summaryPath, past, past);

    const builtPath = join(targetRepo, "_site", SLUG, "landing", "index.html");
    const result = evaluatePageKitBuildSummary({
      targetRepo,
      publicRouteSlug: SLUG,
      activePages: [{ id: "landing" }],
      builtPathForPage: () => builtPath,
    });
    assert.deepEqual(codes(result.warnings), ["built_output.build_summary_stale"]);
  });
});

test("readPageKitBuildSummary: rejects summaries without a pages array", () => {
  withTempDir((dir) => {
    const targetRepo = scaffoldTargetRepo(dir, { summary: { built: 2 } });
    const { summary, error } = readPageKitBuildSummary(targetRepo);
    assert.equal(summary, null);
    assert.match(error, /pages\[\] array/);
  });
});
