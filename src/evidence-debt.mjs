// Read-only build binding projection, shared by readback and other readers.
// No stage verdicts, clocks, Git metadata, processes, writes or network calls.
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  computeBuildFingerprint,
  describeBuildOutputDrift,
  pageIdForRoute,
  resolveBuiltSiteScope,
  routeForFile,
} from "./built-site-scope.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";
import { qaRecordedBuildFingerprint, qaRecordedForCurrentBuild } from "./stage-ledger.mjs";

const fingerprint = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const portable = (value) => value.split(sep).join("/");

/**
 * Compare recorded Polish/QA build bindings with bytes under _site/<slug>.
 * `changes` is explicitly against the assembly manifest, which need not be
 * the build an older stage reviewed. We cannot reconstruct an older manifest.
 * Missing inputs remain unknown; a matching binding alone is not a verdict.
 */
export function assessEvidenceDebt({ packet = null, packetPath = null, report = null } = {}) {
  const assembly = report?.stages?.assembly;
  const recordedBuild = fingerprint(assembly?.build_fingerprint);
  // Match polish-gate's sourceBuildFingerprint precedence without reading the
  // capture package (often absent in a fresh checkout).
  const polishBuild = fingerprint(report?.stages?.polish?.source_build_fingerprint)
    || fingerprint(report?.stages?.polish?.evidence?.source_build_fingerprint);
  const qaBuild = qaRecordedBuildFingerprint(report);
  let current = null;
  let scope = null;
  let outputRoot = null;
  let reason = null;
  const target = fingerprint(packet?.assembly?.target_repo);
  const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!packet || !packetPath) reason = "packet_unavailable";
  else if (!target || !slug) reason = "build_output_location_unknown";
  else {
    const targetRepo = resolve(dirname(resolve(packetPath)), target);
    outputRoot = join(targetRepo, "_site", slug);
    try {
      current = computeBuildFingerprint(outputRoot);
      if (!current.ok) reason = "build_output_missing";
      // Resolve only the chosen built directory: never discover another
      // campaign, or fall back to source HTML when _site is absent.
      else scope = resolveBuiltSiteScope(outputRoot);
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
      reason = "build_output_unreadable";
      current = null;
    }
  }
  const currentBuild = current?.ok ? current.fingerprint : null;
  const drift = currentBuild ? describeBuildOutputDrift(assembly, current) : null;
  const manifestKnown = drift?.manifest === "recorded";
  const sharedReason = reason || (!recordedBuild ? "assembly_build_fingerprint_missing"
    : !manifestKnown ? "build_manifest_unavailable" : null);
  const stage = (recorded, matches) => ({
    status: sharedReason || !recorded ? "unknown" : matches ? "current" : "owed",
    matches_current_build: recorded && currentBuild ? matches : null,
    recorded_build_fingerprint: recorded,
    current_build_fingerprint: currentBuild,
    reason: sharedReason || (!recorded ? "stage_build_fingerprint_missing" : matches ? null : "build_fingerprint_changed"),
  });

  const changes = {
    status: sharedReason ? "unknown" : "known",
    reason: sharedReason,
    recorded_build_fingerprint: recordedBuild,
    current_build_fingerprint: currentBuild,
    changed_pages: [],
    unmapped_files: [],
    extra: manifestKnown ? drift.extra : [],
    missing: manifestKnown ? drift.missing : [],
    changed: manifestKnown ? drift.changed : [],
  };
  if (manifestKnown) {
    const pages = new Map((scope?.pages || []).map((page) => [
      portable(relative(outputRoot, page.built_path)),
      { page_id: page.page_id, built_path: portable(relative(outputRoot, page.built_path)) },
    ]));
    // Deleted HTML no longer appears in the disk map. Reuse its route/id
    // projection for those manifest entries, without reading nonexistent files.
    for (const path of drift.missing) {
      if (!path.toLowerCase().endsWith(".html") || path.split("/").some((part) => part.startsWith(".") || part.startsWith("_") || part === "node_modules")) continue;
      pages.set(path, { page_id: pageIdForRoute(routeForFile(outputRoot, join(outputRoot, path))), built_path: path });
    }
    const paths = [...new Set([...drift.extra, ...drift.missing, ...drift.changed])].sort();
    for (const path of paths) {
      const page = pages.get(path);
      if (page) changes.changed_pages.push(page);
      else changes.unmapped_files.push(path);
    }
  }
  return {
    polish: stage(polishBuild, Boolean(polishBuild && currentBuild && polishBuild === currentBuild)),
    qa: stage(qaBuild, qaRecordedForCurrentBuild(report, currentBuild)),
    changes,
  };
}
