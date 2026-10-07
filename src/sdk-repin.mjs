// `sdk repin`: rewrite the hardcoded Campaign Cart SDK pins of a static
// campaign repo (one with no page-kit `_data/campaigns.json`).
//
// The references are the ones the campaign-ecosystem scan already finds: every
// http(s) Campaign Cart URL that points at a loader or dist artifact
// (loader.js, campaign-cart.css), in HTML and script files, HTML comments
// masked. Only a semver pin (`@vX.Y.Z` or `@X.Y.Z`) below the target version is
// rewritten, and only its version segment changes; the leading `v` is kept as
// written. `@latest`, `@main`, commit refs and prerelease refs are reported and
// left alone, as is a pin already at or above the target (never a downgrade).
//
// Preview is the default and writes nothing. `--apply` writes the files and a
// change record at .campaign-runtime/sdk-repin.json (schema
// campaigns-os-sdk-repin/v0) that a Run Record can cite by path and sha256.
// A repo with `_data/campaigns.json` is refused: page-kit owns that pin.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isReleasedSdkVersion } from "../campaign-spec/dist/index.js";
import {
  campaignCartArtifactReferences,
  isCampaignCartHtmlFile,
  listCampaignCartScanFiles,
  listCampaignCartSourceFiles,
  loadSdkSupportPolicy,
} from "./campaign-ecosystem.mjs";
import { refused } from "./lifecycle.mjs";
import { compareVersions, relPath, unique } from "./repo-scan.mjs";

export const SDK_REPIN_SCHEMA = "campaigns-os-sdk-repin/v0";
export const SDK_REPIN_RECORD_REL_PATH = ".campaign-runtime/sdk-repin.json";
const PAGE_KIT_CAMPAIGNS_SUFFIX = "_data/campaigns.json";

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
})();

/** A --target-sdk value repin accepts: a released x.y.z, with or without a leading v. */
export const isRepinTargetVersion = (value) => isReleasedSdkVersion(String(value ?? "").trim().replace(/^v/, ""));

/**
 * Plan the rewrite without touching the target. `targetSdk` is an x.y.z (a
 * leading v is accepted); when absent the policy's preferred_minimum is the
 * target, the same policy the ecosystem scan evaluates pins against. A target
 * that is not a directory, or a target version that is not a released SDK
 * version, is refused (a tagged refusal: one line, nothing journaled).
 */
export function planSdkRepin(options = {}) {
  return planWithSpans(options).plan;
}

// The plan plus the internal rewrite spans (file offsets) runSdkRepin needs;
// the spans never leave this module.
function planWithSpans({ targetRepo, targetSdk = null, sdkSupportPolicy = null } = {}) {
  const target = resolve(targetRepo);
  if (!existsSync(target)) throw refused(`sdk repin: --target ${targetRepo} does not exist.`);
  if (!statSync(target).isDirectory()) throw refused(`sdk repin: --target ${targetRepo} is not a directory.`);
  const policy = loadSdkSupportPolicy(sdkSupportPolicy);
  const explicit = targetSdk !== null && targetSdk !== undefined;
  const toVersion = explicit ? String(targetSdk).trim().replace(/^v/, "") : policy.preferred_minimum;
  if (!isReleasedSdkVersion(toVersion)) {
    throw refused(explicit
      ? `sdk repin: --target-sdk ${targetSdk} is not a released SDK version (x.y.z).`
      : `sdk repin: the SDK support policy (${policy.source}) names no usable preferred_minimum; pass --target-sdk <x.y.z>.`);
  }
  const base = {
    schema_version: SDK_REPIN_SCHEMA,
    target_repo: target,
    to_version: toVersion,
    to_version_source: explicit ? "argument" : "policy.preferred_minimum",
    policy,
  };

  const pageKitData = findPageKitCampaignData(target);
  if (pageKitData.length) {
    return { spans: [], plan: {
      ...base,
      ok: false,
      status: "refused_page_kit",
      message: `${pageKitData.join(", ")} exists: this is a page-kit repo, whose Campaign Cart pin lives in _data/campaigns.json and is owned by page-kit. Use \`campaigns-os page-kit sync --packet <campaign-runtime.build.json>\` to set it from the CampaignSpec; sdk repin rewrites hardcoded pins in static repos only. Nothing was changed.`,
      page_kit_data: pageKitData,
      references: [],
      rewrites: [],
      left_alone: { not_semver: [], at_target: [], newer_than_target: [] },
      files: [],
    } };
  }

  const references = [];
  for (const file of listCampaignCartSourceFiles(target)) {
    const raw = readText(file);
    if (raw === null) continue;
    for (const entry of campaignCartArtifactReferences(raw, { isHtml: isCampaignCartHtmlFile(file) })) {
      // Masking keeps offsets, so the span is the ref in the raw text; a
      // mismatch would mean the two disagree, and nothing is rewritten then.
      if (raw.slice(entry.ref_start, entry.ref_end) !== entry.ref) continue;
      const artifact = /\.css(?:[?#]|$)/i.test(entry.url) ? "css" : "loader";
      const action = !entry.version
        ? "not_semver"
        : compareVersions(entry.version, toVersion) < 0
          ? "rewrite"
          : compareVersions(entry.version, toVersion) === 0 ? "at_target" : "newer_than_target";
      const newRef = action === "rewrite" ? `${entry.ref.startsWith("v") ? "v" : ""}${toVersion}` : null;
      const urlRefStart = entry.ref_start - entry.url_start;
      references.push({
        path: relPath(target, file),
        line: entry.line,
        artifact,
        url: entry.url,
        ref: entry.ref,
        version: entry.version,
        action,
        new_ref: newRef,
        new_url: newRef ? `${entry.url.slice(0, urlRefStart)}${newRef}${entry.url.slice(urlRefStart + entry.ref.length)}` : null,
        ref_start: entry.ref_start,
        ref_end: entry.ref_end,
      });
    }
  }

  const rewrites = references.filter((entry) => entry.action === "rewrite");
  const status = !references.length
    ? "no_references"
    : rewrites.length ? "changes" : "nothing_to_change";
  const spans = rewrites.map(({ path, ref_start, ref_end, ref, new_ref }) => ({ path, ref_start, ref_end, ref, new_ref }));
  return { spans, plan: {
    ...base,
    ok: true,
    status,
    message: statusMessage(status, toVersion),
    references: references.map(publicReference),
    rewrites: rewrites.map(publicReference),
    left_alone: {
      not_semver: references.filter((entry) => entry.action === "not_semver").map(publicReference),
      at_target: references.filter((entry) => entry.action === "at_target").map(publicReference),
      newer_than_target: references.filter((entry) => entry.action === "newer_than_target").map(publicReference),
    },
    files: unique(rewrites.map((entry) => entry.path)),
  } };
}

/**
 * Plan, and with `apply` write. Returns the plan plus `mode`, `applied`,
 * `change_record` and (after a write) `verified`, the re-scan confirming no
 * reference below the target is left.
 */
export function runSdkRepin({ targetRepo, targetSdk = null, apply = false, sdkSupportPolicy = null, now = () => new Date() } = {}) {
  const { plan, spans } = planWithSpans({ targetRepo, targetSdk, sdkSupportPolicy });
  const result = { ...plan };
  result.mode = apply ? "apply" : "preview";
  result.applied = false;
  result.change_record = { path: SDK_REPIN_RECORD_REL_PATH, written: false, sha256: null, record: null };
  if (plan.status !== "changes") return result;

  const record = buildChangeRecord(plan, now());
  result.change_record.record = record;
  if (!apply) return result;

  const byFile = new Map();
  for (const span of spans) {
    if (!byFile.has(span.path)) byFile.set(span.path, []);
    byFile.get(span.path).push(span);
  }
  // Every file is re-read and every span checked BEFORE any file is written,
  // so a file that changed since the plan aborts the run with nothing written.
  const updates = [];
  for (const [path, fileSpans] of byFile) {
    const file = join(plan.target_repo, path);
    let text = readFileSync(file, "utf8");
    // Right to left, so earlier offsets stay valid.
    for (const span of [...fileSpans].sort((a, b) => b.ref_start - a.ref_start)) {
      if (text.slice(span.ref_start, span.ref_end) !== span.ref) {
        throw refused(`sdk repin: ${path} changed between the scan and the write (a pinned reference is no longer where the scan found it); no file was written and no change record was made. Re-run sdk repin to plan against the current files.`);
      }
      text = `${text.slice(0, span.ref_start)}${span.new_ref}${text.slice(span.ref_end)}`;
    }
    updates.push({ file, text });
  }
  for (const { file, text } of updates) writeFileSync(file, text);
  const recordPath = join(plan.target_repo, SDK_REPIN_RECORD_REL_PATH);
  mkdirSync(dirname(recordPath), { recursive: true });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(recordPath, body);
  result.applied = true;
  result.change_record.written = true;
  result.change_record.sha256 = createHash("sha256").update(body).digest("hex");

  const after = planSdkRepin({ targetRepo: plan.target_repo, targetSdk: plan.to_version, sdkSupportPolicy });
  result.verified = after.ok && after.rewrites.length === 0;
  result.message = `Rewrote ${plan.rewrites.length} reference(s) in ${plan.files.length} file(s) to ${plan.to_version}.`;
  return result;
}

// The change record: what moved, with repo-relative paths only, so it can be
// committed and cited (path + sha256) by a Run Record.
function buildChangeRecord(plan, generatedAt) {
  return {
    schema_version: SDK_REPIN_SCHEMA,
    generated_at: generatedAt.toISOString(),
    campaigns_os_version: PACKAGE_VERSION,
    command: "sdk repin",
    to_version: plan.to_version,
    to_version_source: plan.to_version_source,
    from_versions: unique(plan.rewrites.map((entry) => entry.version)).sort(compareVersions),
    files_touched: plan.files,
    reference_count: plan.rewrites.length,
    rewrites: plan.rewrites.map(({ path, line, artifact, ref, new_ref }) => ({ path, line, artifact, from: ref, to: new_ref })),
    left_alone: {
      not_semver: plan.left_alone.not_semver.map(({ path, line, ref }) => ({ path, line, ref })),
      at_target: plan.left_alone.at_target.length,
      newer_than_target: plan.left_alone.newer_than_target.map(({ path, line, ref }) => ({ path, line, ref })),
    },
  };
}

export function formatSdkRepinReport(result) {
  const lines = [];
  const header = result.mode === "apply" ? "sdk repin: apply" : "sdk repin: preview (nothing written; re-run with --apply to write)";
  lines.push(header);
  lines.push(`Target: ${result.target_repo}`);
  lines.push(`Target SDK: ${result.to_version} (${result.to_version_source === "argument" ? "--target-sdk" : `policy preferred_minimum, ${result.policy.source}`})`);
  if (result.status === "refused_page_kit") {
    lines.push(`Refused: ${result.message}`);
    return lines.join("\n");
  }
  if (result.rewrites.length) {
    lines.push(`${result.applied ? "Rewrote" : "Would rewrite"} ${result.rewrites.length} reference(s) in ${result.files.length} file(s):`);
    for (const entry of result.rewrites) {
      lines.push(`  ${entry.path}:${entry.line}  ${entry.url}`);
      lines.push(`    -> ${entry.new_url}`);
    }
  }
  if (result.left_alone.not_semver.length) {
    lines.push(`Left alone, not semver-pinned (${result.left_alone.not_semver.length}):`);
    for (const entry of result.left_alone.not_semver) lines.push(`  ${entry.path}:${entry.line}  @${entry.ref}  ${entry.url}`);
  }
  if (result.left_alone.newer_than_target.length) {
    lines.push(`Left alone, newer than ${result.to_version} (${result.left_alone.newer_than_target.length}):`);
    for (const entry of result.left_alone.newer_than_target) lines.push(`  ${entry.path}:${entry.line}  @${entry.ref}`);
  }
  if (result.left_alone.at_target.length) lines.push(`Already at ${result.to_version}: ${result.left_alone.at_target.length} reference(s).`);
  if (result.status !== "changes") lines.push(result.message);
  if (result.change_record.written) {
    lines.push(`Change record: ${result.change_record.path} (sha256 ${result.change_record.sha256})`);
    lines.push(`Re-scan: ${result.verified ? "no pinned reference below the target remains" : "references below the target remain; inspect the files"}`);
  }
  return lines.join("\n");
}

function statusMessage(status, toVersion) {
  if (status === "no_references") return "No Campaign Cart loader or stylesheet reference was found; nothing to change.";
  if (status === "nothing_to_change") return `No semver-pinned reference is below ${toVersion}; nothing to change.`;
  return `Semver-pinned references below ${toVersion} can be rewritten.`;
}

function publicReference({ path, line, artifact, url, ref, version, action, new_ref, new_url }) {
  return { path, line, artifact, url, ref, version, action, new_ref, new_url };
}

// `_data/campaigns.json` at the target or under any directory the scan walks
// (a page-kit project nested in a larger repo is still page-kit's pin).
function findPageKitCampaignData(target) {
  return listCampaignCartScanFiles(target)
    .map((file) => relPath(target, file))
    .filter((path) => path === PAGE_KIT_CAMPAIGNS_SUFFIX || path.endsWith(`/${PAGE_KIT_CAMPAIGNS_SUFFIX}`))
    .sort();
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
