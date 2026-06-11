// Page Kit build summary gate: consumes the machine-readable summary that
// `campaign-build --json` (next-campaign-page-kit >= 0.1.4) emits, so doctor
// verifies what Page Kit actually built — resolved routes, per-page status,
// and shape warnings — instead of only inspecting rendered _site HTML.
//
// Doctrine: dogfood runs on pre-assembled AI HTML never tripped Page Kit
// routing surprises (NESTED_NO_PERMALINK, DUPLICATE_OUTPUT) because those
// pages were hand-tuned to be correct. Real designer-exported source will
// trip them. The build step must capture the summary as an artifact:
//
//   npx campaign-build --json > .campaign-runtime/page-kit-build-summary.json
//
// and this module turns that artifact into doctor issues every consumer
// (next, doctor, qa) shares. A missing artifact is a warning, not a block,
// so target repos on page-kit < 0.1.4 keep working while the fleet upgrades.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PAGE_KIT_BUILD_SUMMARY_REL_PATH = ".campaign-runtime/page-kit-build-summary.json";
export const PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND = `npx campaign-build --json > ${PAGE_KIT_BUILD_SUMMARY_REL_PATH}`;
export const PAGE_KIT_BUILD_SUMMARY_MIN_PAGE_KIT = "0.1.4";

// Page Kit shape warnings that mean the rendered funnel can silently differ
// from what the author intended; once assembly is complete these escalate to
// the same severity as a failed page.
const ESCALATED_WARNING_CODES = new Set(["DUPLICATE_OUTPUT", "NO_CAMPAIGN"]);

export function readPageKitBuildSummary(targetRepo) {
  const path = join(targetRepo, PAGE_KIT_BUILD_SUMMARY_REL_PATH);
  if (!existsSync(path)) return { path, summary: null, error: null };
  try {
    const summary = JSON.parse(readFileSync(path, "utf8"));
    if (!summary || typeof summary !== "object" || !Array.isArray(summary.pages)) {
      return { path, summary: null, error: "summary is not an object with a pages[] array" };
    }
    return { path, summary, error: null };
  } catch (error) {
    return { path, summary: null, error: error.message };
  }
}

/**
 * Evaluate the captured Page Kit build summary for one campaign.
 *
 * Pure with respect to doctor state: returns { errors, warnings, ready }
 * issue lists ({ code, message, detail? } / strings for ready) and lets the
 * caller route them through its own addIssue so formatting stays uniform.
 *
 * Returns empty lists when there is nothing to verify yet (no built _site
 * for the campaign), mirroring the built_output.* checks' gating.
 */
export function evaluatePageKitBuildSummary({
  targetRepo,
  publicRouteSlug,
  activePages = [],
  assemblyComplete = false,
  builtPathForPage = null,
}) {
  const errors = [];
  const warnings = [];
  const ready = [];
  const result = { errors, warnings, ready };

  if (!targetRepo || !publicRouteSlug) return result;
  const siteRoot = join(targetRepo, "_site", publicRouteSlug);
  if (!existsSync(siteRoot)) return result;

  const issueTarget = assemblyComplete ? errors : warnings;
  const { path, summary, error } = readPageKitBuildSummary(targetRepo);

  if (!summary && !error) {
    warnings.push({
      code: "built_output.build_summary_missing",
      message:
        `No Page Kit build summary at ${PAGE_KIT_BUILD_SUMMARY_REL_PATH}. ` +
        `Capture one with \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\` (requires next-campaign-page-kit >= ${PAGE_KIT_BUILD_SUMMARY_MIN_PAGE_KIT}) ` +
        `so doctor can verify resolved routes and Page Kit shape warnings instead of guessing from rendered HTML alone.`,
      detail: { expected_path: PAGE_KIT_BUILD_SUMMARY_REL_PATH },
    });
    return result;
  }

  if (!summary) {
    warnings.push({
      code: "built_output.build_summary_invalid",
      message: `Page Kit build summary at ${PAGE_KIT_BUILD_SUMMARY_REL_PATH} is unreadable (${error}). Re-capture it with \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\`.`,
      detail: { expected_path: PAGE_KIT_BUILD_SUMMARY_REL_PATH, parse_error: error },
    });
    return result;
  }

  // Staleness: if any built page for this campaign is newer than the summary,
  // the summary describes an older build and its verdicts cannot be trusted.
  if (typeof builtPathForPage === "function") {
    const summaryMtime = statSync(path).mtimeMs;
    const staleSources = activePages
      .map((page) => builtPathForPage(page))
      .filter((builtPath) => builtPath && existsSync(builtPath) && statSync(builtPath).mtimeMs > summaryMtime + 1);
    if (staleSources.length > 0) {
      warnings.push({
        code: "built_output.build_summary_stale",
        message:
          `Page Kit build summary predates ${staleSources.length} built page(s); the build ran again without re-capturing. ` +
          `Re-run \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\`.`,
        detail: { newer_pages: staleSources.length },
      });
      return result;
    }
  }

  const campaignPages = summary.pages.filter((page) => page && page.campaignSlug === publicRouteSlug);
  if (campaignPages.length === 0) {
    warnings.push({
      code: "built_output.build_summary_no_pages",
      message:
        `Page Kit build summary has no pages for campaign slug "${publicRouteSlug}". ` +
        `The capture may have run against a different campaign or before this campaign's source existed; re-run \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\`.`,
      detail: { slug: publicRouteSlug, summary_slugs: [...new Set(summary.pages.map((p) => p?.campaignSlug).filter(Boolean))] },
    });
    return result;
  }

  let failed = 0;
  let flagged = 0;
  for (const page of campaignPages) {
    const pageWarnings = Array.isArray(page.warnings) ? page.warnings : [];
    const pageErrors = Array.isArray(page.errors) ? page.errors : [];

    if (page.status === "error" || pageErrors.length > 0) {
      failed += 1;
      issueTarget.push({
        code: "built_output.build_page_error",
        message:
          `Page Kit failed to build "${page.inputFile}"${page.url ? ` (${page.url})` : ""}: ` +
          `${pageErrors.map((e) => e.message || e.code).join("; ") || "status=error"}.`,
        detail: { input_file: page.inputFile, url: page.url ?? null, errors: pageErrors },
      });
      continue;
    }

    for (const warning of pageWarnings) {
      flagged += 1;
      const target = ESCALATED_WARNING_CODES.has(warning.code) ? issueTarget : warnings;
      target.push({
        code: "built_output.build_page_warning",
        message:
          `Page Kit flagged "${page.inputFile}"${page.url ? ` (${page.url})` : ""}: [${warning.code}] ${warning.message}`,
        detail: { input_file: page.inputFile, url: page.url ?? null, warning_code: warning.code },
      });
    }
  }

  if (failed === 0 && flagged === 0) {
    ready.push(
      `Page Kit build summary verified for "${publicRouteSlug}": ${campaignPages.length} page(s) built, no build errors or shape warnings`
    );
  }

  return result;
}
