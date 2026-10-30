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
import { changeSince, classifyDrift } from "./change-scope.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";
import { isFileReadFailure } from "./cart-placeholders.mjs";
import { polishReviewedBuild, qaExtendedBuildFingerprint, qaRecordedBuildFingerprint, qaRecordedForCurrentBuild } from "./stage-ledger.mjs";

export const EVIDENCE_DEBT_STATUSES = Object.freeze(["current", "owed", "unknown"]);

const fingerprint = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const portable = (value) => value.split(sep).join("/");

/**
 * Compare recorded Polish/QA build bindings with bytes under _site/<slug>.
 * `changes` is explicitly against the assembly manifest, which need not be
 * the build an older stage reviewed. We cannot reconstruct an older manifest.
 * Missing build inputs remain unknown; lifecycle-required stages are owed
 * even without a stage binding. A matching binding alone is not a verdict.
 *
 * Each owed stage also carries `change`: what changed since the build that
 * stage reviewed (change-scope.mjs), read from the rebuilds `record build`
 * kept plus the drift on disk. A page-only change makes owed Polish
 * `advisory` and owed QA `scope: "pages"` on `owed_pages`; anything else
 * owes the full stage.
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
  let scopeReason = null;
  let targetRepo = null;
  const target = fingerprint(packet?.assembly?.target_repo);
  const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!packet || !packetPath) reason = "packet_unavailable";
  else if (!target || !slug) reason = "build_output_location_unknown";
  else {
    targetRepo = resolve(dirname(resolve(packetPath)), target);
    outputRoot = join(targetRepo, "_site", slug);
    try {
      current = computeBuildFingerprint(outputRoot);
      if (!current.ok) reason = "build_output_missing";
      // Resolve only the chosen built directory: never discover another
      // campaign, or fall back to source HTML when _site is absent.
      else {
        scope = resolveBuiltSiteScope(outputRoot);
        if (!scope.ok) scopeReason = "build_output_pages_unresolved";
      }
    } catch (error) {
      if (!isFileReadFailure(error)) throw error;
      reason = "build_output_unreadable";
      current = null;
    }
  }
  const currentBuild = current?.ok ? current.fingerprint : null;
  const drift = currentBuild ? describeBuildOutputDrift(assembly, current) : null;
  const manifestKnown = drift?.manifest === "recorded";
  // A missing manifest hides page changes, never a known stage binding.
  const bindingReason = reason || (!recordedBuild ? "assembly_build_fingerprint_missing" : null);
  const changesReason = bindingReason || scopeReason || (!manifestKnown ? "build_manifest_unavailable" : null);
  const stage = (stageRecord, recorded, matches) => {
    // src/stage-record.mjs writes required_by: build; the dependency map in
    // src/input-currency.mjs supplies brief/spec for input-change demotions.
    // This is lifecycle debt even when retained evidence matches the output.
    const required = stageRecord?.status === "required";
    const requiredReason = ["build", "brief", "spec"].includes(stageRecord?.required_by)
      ? `stage_required_by_${stageRecord.required_by}` : "stage_required";
    return {
      status: bindingReason ? "unknown" : required ? "owed" : !recorded ? "unknown" : matches ? "current" : "owed",
      matches_current_build: recorded && currentBuild ? matches : null,
      recorded_build_fingerprint: recorded,
      current_build_fingerprint: currentBuild,
      reason: bindingReason || (required ? requiredReason : !recorded ? "stage_build_fingerprint_missing" : matches ? null : "build_fingerprint_changed"),
    };
  };

  const changes = {
    status: changesReason ? "unknown" : "known",
    reason: changesReason,
    recorded_build_fingerprint: recordedBuild,
    current_build_fingerprint: currentBuild,
    changed_pages: [],
    unmapped_files: [],
    extra: manifestKnown ? drift.extra : [],
    missing: manifestKnown ? drift.missing : [],
    changed: manifestKnown ? drift.changed : [],
  };
  if (manifestKnown && scope?.ok) {
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
  const driftClassification = classifyDrift({ changes, baseline: assembly, outputRoot, targetRepo, publicRouteSlug: slug });
  changes.kind = driftClassification.kind;
  changes.reasons = driftClassification.reasons;
  const changeFor = (anchor) => changeSince(anchor, { assembly, drift: changes, driftClassification });

  // Polish reviewed the build a terminal record is bound to; once `record
  // build` has made it required, the build it reviewed is kept as
  // owed_since_build_fingerprint (polishReviewedBuild). Only a Polish that
  // reviewed a build can be advisory: a blocked or pending one, or one a
  // brief or spec change made required, owes the full stage, before and
  // after record build alike.
  const polishRecord = report?.stages?.polish;
  const polish = stage(polishRecord, polishBuild, Boolean(polishBuild && currentBuild && polishBuild === currentBuild));
  if (polish.status === "owed") {
    const reviewed = polishReviewedBuild(polishRecord);
    polish.change = changeFor(reviewed || polishBuild || fingerprint(polishRecord?.owed_since_build_fingerprint));
    polish.advisory = Boolean(reviewed) && polish.change.kind === "page_only";
  } else {
    polish.change = null;
    polish.advisory = false;
  }
  // QA on the changed pages only extends a completed QA: the change is read
  // from the build that QA checked (qaExtendedBuildFingerprint). A blocked,
  // pending or skipped full run extends nothing and owes the full stage.
  const qaRecord = report?.stages?.qa;
  const qa = stage(qaRecord, qaBuild, qaRecordedForCurrentBuild(report, currentBuild));
  if (qa.status === "owed") {
    const extended = qaExtendedBuildFingerprint(report);
    qa.change = changeFor(extended || qaBuild);
    qa.scope = extended && qaRecord?.status !== "required" && qa.change.kind === "page_only" ? "pages" : "full";
    qa.owed_pages = qa.scope === "pages" ? qa.change.changed_pages : [];
  } else {
    qa.change = null;
    qa.scope = null;
    qa.owed_pages = [];
  }
  return { polish, qa, changes };
}
