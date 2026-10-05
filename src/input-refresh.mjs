// `campaigns-os record brief`: save Campaign Build Brief answers without
// re-running intake.
//
// The brief file is re-normalized and re-evaluated with the intake products
// the Build Context recorded, through the same artifact function intake
// calls. A save whose material content is unchanged keeps every stage status
// and its evidence; a material change makes the stages the frozen dependency
// map names owed again (status `required` with input_change), each superseded
// record going whole into its stage's history first. Refusals are checked in
// a fixed order before anything is written; --dry-run runs every check and
// writes nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  BUILD_BRIEF_CANDIDATE_FILENAMES,
  briefMaterialFingerprint,
  createCampaignBuildBriefArtifact,
  loadCampaignBuildBriefFile,
} from "./build-brief.mjs";
import { resolveCampaignWorkspace, targetRepoFor } from "./campaign-workspace.mjs";
import { isObject, optionalString, relFromDir, resolveFromFile } from "./cli-helpers.mjs";
import { writeJsonAtomic } from "./doctor-sidecar.mjs";
import { activeSpecPages } from "./doctor/checks.mjs";
import {
  INPUT_DEPENDENCY_MAP,
  STAMPED_STAGES,
  assessInputCurrency,
  briefIntakeBindings,
  changeReason,
  currentSpecMaterial,
  wellFormedBriefMaterial,
} from "./input-currency.mjs";
import { cmd } from "./install-invocation.mjs";
import { publicRouteForPage } from "./source-html-intake.mjs";
import { archiveSupersededRecord, assemblyReportMatchesPacket, commitAssemblyReport, inputChangeFor } from "./stage-ledger.mjs";
import { refuseRecord } from "./stage-record.mjs";
import { withTargetLockSync } from "./target-lock.mjs";

// A brief file over this size, or with more design_authority entries than
// this, is refused before anything is read further.
const BRIEF_MAX_BYTES = 1024 * 1024;
const BRIEF_MAX_DESIGN_AUTHORITY_ENTRIES = 512;
const BRIEF_PROMPT_PREFIX = "BUILD_BRIEF_";
const BRIEF_GATE_PREFIX = "build_brief.";
const COMPLETED_STATUSES = Object.freeze(["completed", "completed_with_warnings", "completed_partial"]);

const isBriefBlocker = (entry) => typeof entry?.code === "string" && (entry.code.startsWith(BRIEF_PROMPT_PREFIX) || entry.code.startsWith(BRIEF_GATE_PREFIX));

function toConstantCase(value) {
  return String(value || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function relFromFile(filePath, targetPath) {
  const rel = relative(dirname(resolve(filePath)), resolve(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function readJsonOrNull(path) {
  try {
    return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * The prepare_build status the stage's remaining blockers give: blocked with
 * any blocker, completed_partial when pages are declared out of source scope,
 * completed otherwise.
 */
export function prepareBuildStageStatus({ blockers = [], declaredScopeSkips = [] } = {}) {
  if (blockers.length) return "blocked";
  return declaredScopeSkips.length ? "completed_partial" : "completed";
}

/**
 * The brief's prepare_build blockers, as intake derives them from a brief
 * result: every blocking gate, and each open question when the brief is
 * prepared.
 */
export function briefPrepareBuildBlockers(buildBrief) {
  return [
    ...buildBrief.blockers.map((gate) => ({ code: gate.code, stage: "prepare_build", message: gate.message, field: gate.field || null })),
    ...(buildBrief.mode === "prepared"
      ? buildBrief.questions.map((question) => ({ code: `${BRIEF_PROMPT_PREFIX}${toConstantCase(question.id)}`, stage: "prepare_build", message: question.question, field: question.field }))
      : []),
  ];
}

// The questions a guided brief asks the operator, as intake writes them to
// context.prompts_required.
function briefPrompts(buildBrief) {
  if (buildBrief.mode === "prepared") return [];
  return buildBrief.questions.map((question) => ({
    code: `${BRIEF_PROMPT_PREFIX}${toConstantCase(question.id)}`,
    stage: "prepare_build",
    message: question.question,
    detail: { field: question.field, reason: question.reason, options: question.options, blocking: question.blocking },
  }));
}

/**
 * prepare_build with its brief blockers replaced by `briefBlockers` and every
 * other blocker kept; the status follows from what remains.
 */
export function prepareBuildBriefBlockers(stage, briefBlockers) {
  const current = isObject(stage) ? stage : { stage: "prepare_build" };
  const kept = (Array.isArray(current.blockers) ? current.blockers : []).filter((blocker) => !isBriefBlocker(blocker));
  const blockers = [...kept, ...briefBlockers];
  const declaredScopeSkips = Array.isArray(current.declared_out_of_scope) ? current.declared_out_of_scope : [];
  return { ...current, status: prepareBuildStageStatus({ blockers, declaredScopeSkips }), blockers };
}

/**
 * Apply the dependency map for the changed inputs (`causes`, any of
 * "presentation", "qa_policy", "spec"): on each stage the map makes owed whose
 * raw status is not skipped, write input_change; a completed record also goes
 * whole into history and is demoted to `required`, keeping only what
 * describes the output (assembly's build_fingerprint, Polish's evidence).
 * `only` limits the stages touched (record build writes assembly itself).
 * Returns the report copy and the stages it demoted.
 */
export function demoteStages(report, { causes, now, by, only = null }) {
  const reason = changeReason(causes);
  const owed = new Map();
  for (const cause of causes) {
    for (const [key, requirement] of Object.entries(INPUT_DEPENDENCY_MAP[cause]?.stages || {})) {
      if (!owed.has(key)) owed.set(key, { ...requirement, required_for: [...requirement.required_for] });
    }
  }
  // A combined change names the winning cause's requirement.
  const winner = ["spec", "presentation", "qa_policy"].find((cause) => causes.includes(cause));
  const stages = { ...(isObject(report?.stages) ? report.stages : {}) };
  const demoted = [];
  for (const key of STAMPED_STAGES) {
    if (!owed.has(key) || (only && !only.includes(key))) continue;
    const previous = isObject(stages[key]) ? stages[key] : { stage: key };
    if (previous.status === "skipped") continue;
    const requirement = INPUT_DEPENDENCY_MAP[winner]?.stages?.[key] || owed.get(key);
    let next = { ...previous, input_change: inputChangeFor(key, previous, { at: now, reason }) };
    if (COMPLETED_STATUSES.includes(previous.status)) {
      next = archiveSupersededRecord(next, previous, { by, reason, at: now });
      for (const field of ["completed_at", "recorded_by", "performed_by", "unchanged_output_reason", "source_brief_material", "source_spec_material_hash"]) delete next[field];
      if (key === "qa") for (const field of ["verdict_run_id", "evidence", "purchase_proof"]) delete next[field];
      next.status = "required";
      next.required_by = requirement.required_by;
      next.required_for = [...requirement.required_for];
      demoted.push(key);
    }
    stages[key] = next;
  }
  return { report: { ...report, stages }, demoted };
}

/**
 * The previous report's brief mode (when it is this campaign's report) and
 * the previous normalized brief, read before an intake or save replaces them.
 */
export function priorBriefInputsForIntake({ reportPath, briefPath, identity }) {
  const report = readJsonOrNull(reportPath);
  const boundReportMode = report && assemblyReportMatchesPacket(report, identity) ? optionalString(report.build_brief?.mode) : null;
  const previous = readJsonOrNull(briefPath);
  return { boundReportMode, previousNormalizedBrief: isObject(previous) ? previous : null };
}

function fileSha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The brief file candidates: an explicit --brief, or the first candidate name
// found in the source root and in the target (intake's discovery order).
function briefCandidates(explicitPath, { sourceRoot, targetRepo }) {
  if (explicitPath) return { explicit: true, files: existsSync(explicitPath) ? [{ path: explicitPath, source: "operator_flag" }] : [] };
  const files = [];
  for (const [root, source] of [[sourceRoot, "source_root"], [targetRepo, "target_repo"]]) {
    if (!root) continue;
    const found = BUILD_BRIEF_CANDIDATE_FILENAMES.map((name) => join(root, name)).find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (found && !files.some((file) => realpathOrNull(file.path) === realpathOrNull(found))) files.push({ path: found, source });
  }
  return { explicit: false, files };
}

function briefTooLarge(path) {
  if (statSync(path).size > BRIEF_MAX_BYTES) return `${path} is ${statSync(path).size} bytes; the limit is ${BRIEF_MAX_BYTES} bytes (1 MiB).`;
  let value;
  try {
    value = loadCampaignBuildBriefFile(path).value;
  } catch {
    return null;
  }
  const entries = isObject(value?.design_authority) ? Object.keys(value.design_authority).length : 0;
  return entries > BRIEF_MAX_DESIGN_AUTHORITY_ENTRIES ? `${path} has ${entries} design_authority entries; the limit is ${BRIEF_MAX_DESIGN_AUTHORITY_ENTRIES}.` : null;
}

const sameActivePages = (a, b) => a.length === b.length && a.every((page, index) => page.id === b[index]?.id && (page.page_url ?? null) === (b[index]?.page_url ?? null));

// Every refusal, in the frozen order; the first that holds is returned as
// [code, detail], or null when none holds.
function briefRefusal({ candidates, packageArtifacts, context, spec, report }) {
  for (const file of candidates.files) {
    const large = briefTooLarge(file.path);
    if (large) return ["brief_too_large", large];
  }
  for (const file of candidates.files) {
    const real = realpathOrNull(file.path);
    const artifact = packageArtifacts.find((entry) => real && realpathOrNull(entry.path) === real);
    if (artifact) return ["brief_source_is_package_artifact", `${file.path} is the ${artifact.label}, which Campaigns OS writes itself; save the brief from a campaign-build-brief.json (or .yaml) file of your own.`];
  }
  if (!candidates.files.length) {
    return ["brief_file_missing", candidates.explicit
      ? "the --brief file does not exist."
      : `no ${BUILD_BRIEF_CANDIDATE_FILENAMES.join(", ")} in the source root or the target; copy the normalized draft to campaign-build-brief.json in the target, set the open fields, and run record brief again (or pass --brief <file>).`];
  }
  if (!candidates.explicit && candidates.files.length > 1) {
    const [first, second] = candidates.files;
    if (!readFileSync(first.path).equals(readFileSync(second.path))) {
      return ["brief_path_ambiguous", `${first.path} and ${second.path} differ; pass --brief <file> to name the one to save.`];
    }
  }
  const missing = [
    ["spec.active_pages", Array.isArray(context?.spec?.active_pages)],
    ["page_map", Array.isArray(context?.page_map)],
    ["source.asset_crawl", context?.source?.asset_crawl != null],
    ["commerce_zone_findings", Array.isArray(context?.commerce_zone_findings)],
  ].filter(([, present]) => !present).map(([field]) => field);
  if (missing.length) return ["brief_inputs_unavailable", `the Build Context lacks ${missing.join(", ")}, which evaluating the brief needs; re-run intake to restore it.`];
  const bound = optionalString(report?.identity?.spec_material_hash);
  const current = currentSpecMaterial(spec);
  if (!current || !bound || current !== `sha256:${bound.replace(/^sha256:/, "")}`) {
    return ["spec_changed_run_record_spec", `the CampaignSpec material (${current || "unreadable"}) differs from the one the Assembly Report binds (${bound || "none"}); save the spec change with ${cmd("record")} spec first.`];
  }
  const derived = activeSpecPages(spec).map((page) => ({ id: page.id, page_url: publicRouteForPage(page) }));
  if (!sameActivePages(derived, context.spec.active_pages)) {
    return ["page_scope_changed", "the CampaignSpec's active pages (ids, order or routes) differ from the Build Context's spec.active_pages; a page-scope change needs intake."];
  }
  return null;
}

const questionIds = (brief) => (Array.isArray(brief?.questions) ? brief.questions.map((question) => question?.id) : []);
const gateCodes = (brief) => (Array.isArray(brief?.gates) ? brief.gates.map((gate) => gate?.code) : []);

/**
 * Run one `record brief` invocation. Returns the result object the CLI
 * prints; throws a refusal (nothing written) when a check fails.
 */
export function recordBrief({ packetPath, briefPath: explicitBrief = null, contextPath = undefined, reportPath = undefined, dryRun = false }, { now = () => new Date() } = {}) {
  if (!existsSync(packetPath)) throw new Error(`record brief: Build Packet not found at ${packetPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  const lockedTarget = targetRepoFor(packetPath, JSON.parse(readFileSync(packetPath, "utf8")));
  const timestamp = now().toISOString();
  const run = () => saveBriefUnderLock({ packetPath, explicitBrief, sidecars: { contextPath, reportPath }, lockedTarget, dryRun, timestamp });
  return dryRun ? run() : withTargetLockSync(lockedTarget, run, { command: "record brief" });
}

function saveBriefUnderLock({ packetPath, explicitBrief, sidecars, lockedTarget, dryRun, timestamp }) {
  const workspace = resolveCampaignWorkspace(packetPath, { ...sidecars, followContextPointer: true });
  const { packet, contextPath, reportPath, targetRepo, doctorOutPath } = workspace;
  if (targetRepo !== lockedTarget) throw refuseRecord("brief", [`The Build Packet was retargeted while this save waited for the target lock (${lockedTarget} is now ${targetRepo}); run ${cmd("record")} brief again.`]);
  if (!isObject(packet.build_brief)) throw refuseRecord("brief", [`The Build Packet records no Campaign Build Brief; run ${cmd("start")} or ${cmd("prepare-build")} to create one.`]);
  const report = readJsonOrNull(reportPath);
  if (!isObject(report?.stages)) throw new Error(`record brief: no readable Assembly Report at ${reportPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  const context = readJsonOrNull(contextPath);
  const normalizedPath = resolveFromFile(packetPath, packet.build_brief.normalized_path);
  const specPath = optionalString(packet.spec?.local_path) ? resolveFromFile(packetPath, packet.spec.local_path) : null;
  const spec = readJsonOrNull(specPath);
  const sourceRoot = optionalString(packet.source_html?.root) ? resolveFromFile(packetPath, packet.source_html.root) : null;
  const candidates = briefCandidates(explicitBrief ? resolve(explicitBrief) : null, { sourceRoot, targetRepo });
  const packageArtifacts = [
    { label: "normalized brief", path: normalizedPath },
    { label: "Build Packet", path: packetPath },
    { label: "Build Context", path: contextPath },
    { label: "Assembly Report", path: reportPath },
    { label: "doctor sidecar", path: doctorOutPath },
  ].filter((entry) => entry.path);
  const refusal = briefRefusal({ candidates, packageArtifacts, context, spec, report });
  if (refusal) throw refuseRecord("brief", [`${refusal[0]}: ${refusal[1]}`]);

  const briefFile = candidates.files[0];
  const previousNormalizedBrief = readJsonOrNull(normalizedPath);
  const buildBrief = createCampaignBuildBriefArtifact({
    inputPath: briefFile.path,
    inputSource: briefFile.source,
    spec,
    activePages: activeSpecPages(spec),
    pageMappings: context.page_map.map((entry) => ({ page_id: entry.page_id, path: entry.source_path || null, skip_reason: entry.skip_reason || null })),
    templateFamily: context.template?.family || packet.assembly?.template_family || null,
    sourceAssetCrawl: context.source.asset_crawl,
    commerceZoneFindings: context.commerce_zone_findings,
    boundReportMode: assemblyReportMatchesPacket(report, packet) ? optionalString(report.build_brief?.mode) : null,
    previousNormalizedBrief: isObject(previousNormalizedBrief) ? previousNormalizedBrief : null,
  });
  buildBrief.artifact._meta.input_path = relFromFile(normalizedPath, buildBrief.inputPath);
  const bindings = briefIntakeBindings(buildBrief);
  const material = bindings.material;
  const bound = report.build_brief?.material;
  // Bound material not of its closed shape is treated as not bound: the save
  // rebinds it, and each stage still reads by its own stamps.
  const boundPresent = wellFormedBriefMaterial(bound);
  const causes = boundPresent ? ["presentation", "qa_policy"].filter((partition) => bound[partition] !== material[partition]) : [];
  const unchanged = boundPresent && !causes.length
    && report.build_brief?.mode === buildBrief.mode
    && report.build_brief?.status === buildBrief.artifact.status
    && JSON.stringify(questionIds(report.build_brief)) === JSON.stringify(questionIds(buildBrief.artifact))
    && JSON.stringify(gateCodes(report.build_brief)) === JSON.stringify(gateCodes(buildBrief.artifact))
    && report.build_brief?.input_sha256 === bindings.input_sha256;
  const outcome = unchanged ? "unchanged" : causes.length ? "saved_with_invalidation" : "saved";
  const currency = assessInputCurrency({ report, briefMaterial: material, specMaterial: currentSpecMaterial(spec) });
  const unknownStages = STAMPED_STAGES.filter((key) => currency.stages[key] === "unknown");
  const notices = unknownStages.length
    ? [{ code: "binding_unknown", stages: unknownStages, message: `Recorded ${unknownStages.join(", ")} do not say which brief and CampaignSpec content they were made against; record ${unknownStages.join(", ")} again.` }]
    : [];

  let demoted = [];
  let nextReport = null;
  const writes = [];
  if (outcome !== "unchanged") {
    const briefSummary = {
      ...(isObject(context.build_brief) ? context.build_brief : {}),
      mode: buildBrief.mode,
      status: buildBrief.artifact.status,
      input_path: relFromDir(targetRepo, buildBrief.inputPath),
      question_count: buildBrief.questions.length,
      gate_count: buildBrief.gates.length,
      questions: buildBrief.questions,
      gates: buildBrief.gates,
      ...bindings,
    };
    const nextPacket = {
      ...packet,
      build_brief: {
        ...packet.build_brief,
        mode: buildBrief.mode,
        status: buildBrief.artifact.status,
        input_path: relFromFile(packetPath, buildBrief.inputPath),
        question_count: buildBrief.questions.length,
        gate_count: buildBrief.gates.length,
        ...bindings,
      },
    };
    const nextContext = {
      ...context,
      build_brief: briefSummary,
      prompts_required: [
        ...(Array.isArray(context.prompts_required) ? context.prompts_required : []).filter((prompt) => !isBriefBlocker(prompt)),
        ...briefPrompts(buildBrief),
      ],
    };
    nextReport = {
      ...report,
      build_brief: JSON.parse(JSON.stringify(briefSummary)),
      stages: { ...report.stages, prepare_build: prepareBuildBriefBlockers(report.stages.prepare_build, briefPrepareBuildBlockers(buildBrief)) },
    };
    if (outcome === "saved_with_invalidation") {
      const applied = demoteStages(nextReport, { causes, now: timestamp, by: "record brief" });
      nextReport = applied.report;
      demoted = applied.demoted;
      nextReport.evidence = [
        ...(Array.isArray(report.evidence) ? report.evidence : []),
        `${timestamp} record brief: brief ${causes.join(" and ")} changed; ${demoted.length ? `${demoted.join(", ")} owed again` : "no recorded stage was demoted"} (${changeReason(causes)}).`,
      ];
    }
    writes.push(packetPath, normalizedPath, contextPath, reportPath);
    if (!dryRun) {
      // Intake's publication order, the report last: a failure between files
      // leaves the report bound to the old material, which reads as owed.
      writeJsonAtomic(packetPath, nextPacket);
      writeJsonAtomic(normalizedPath, buildBrief.artifact);
      writeJsonAtomic(contextPath, nextContext);
      commitAssemblyReport(workspace, () => nextReport, {
        command: "record brief",
        staleReason: "The Campaign Build Brief was saved after this doctor snapshot. Re-run doctor (or next) for current state.",
      });
    }
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "recorded",
    action: "record",
    stage: "brief",
    outcome,
    dry_run: dryRun,
    brief_path: buildBrief.inputPath,
    normalized_path: normalizedPath,
    report_path: reportPath,
    material,
    ...(dryRun ? { would_write: writes } : { written: writes }),
    demoted,
    ...(outcome === "saved_with_invalidation" ? { input_change: { reason: changeReason(causes), at: timestamp } } : {}),
    notices,
    note: outcome === "unchanged"
      ? "The brief is unchanged; nothing was written."
      : dryRun
        ? "Dry run: every check passed and nothing was written. Re-run without --dry-run to save."
        : `Saved. Run ${cmd("next")} --packet <packet> for the next stage.`,
  };
}
