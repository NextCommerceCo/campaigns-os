// `campaigns-os record brief`: save Campaign Build Brief answers without
// re-running intake. `campaigns-os record spec`: bind the CampaignSpec as it
// is now without re-running intake.
//
// The brief file is re-normalized and re-evaluated with the intake products
// the Build Context recorded, through the same artifact function intake
// calls. A save whose material content is unchanged keeps every stage status
// and its evidence; a material change makes the stages the input dependency
// map names owed again (status `required` with input_change), each superseded
// record going whole into its stage's history first. `record spec` rebinds
// the Build Context's and the Assembly Report's spec identity, re-derives the
// brief from the brief file last saved by intake or record brief (never by
// discovery), and makes build, Polish and QA owed again unless a stage was
// already recorded against the new content; waivers, accepts, the theme,
// the packet and the setup and deploy records are never touched, except when
// the active pages changed in a way record spec binds (#531, #721): a move of
// routes alone, or on a handed-off campaign a page added or removed. Then the
// packet's and the Build Context's page-kit projection, the Design Source
// Package's page surfaces and the three references to that package are
// rewritten too, and deploy is owed again when the set of built pages
// changes. Refusals are checked in a fixed order before anything is written;
// --dry-run runs every check and writes nothing.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  BUILD_BRIEF_CANDIDATE_FILENAMES,
  briefMaterialFingerprint,
  createCampaignBuildBriefArtifact,
  loadCampaignBuildBriefFile,
} from "./build-brief.mjs";
import { resolveCampaignWorkspace, targetRepoFor } from "./campaign-workspace.mjs";
import { isObject, optionalString, portableArtifactPaths, relFromDir, resolveFromFile } from "./cli-helpers.mjs";
import { createDesignSourcePackageArtifactReference, hashSerializedDesignSourcePackage, rebindDesignSourcePackagePages, serializeDesignSourcePackage, validateDesignSourcePackage } from "./design-source-package.mjs";
import { readPriorDesignSourceProvenance, recordPendingDesignSourceProvenance } from "./design-source-publication.mjs";
import { writeJsonAtomic } from "./doctor-sidecar.mjs";
import { activeSpecPages, specIdentityMismatch } from "./doctor/checks.mjs";
import {
  INPUT_DEPENDENCY_MAP,
  STAMPED_STAGES,
  absentBriefMaterial,
  assessInputCurrency,
  briefFileUnusable,
  briefIntakeBindings,
  changeReason,
  currentBriefMaterial,
  currentSpecMaterial,
  wellFormedBriefMaterial,
} from "./input-currency.mjs";
import { cmd } from "./install-invocation.mjs";
import { campaignRouteRoot, intakeRouteRoot, normalizePublicRouteSlug, specPublicRouteSlug } from "./route-identity.mjs";
import { projectPageKitTargets, publicRouteForPage } from "./source-html-intake.mjs";
import { staleRoutingHints } from "./spec-derive.mjs";
import { routeMaskedSpecMaterialHash, specHashesMatch } from "./spec-identity.mjs";
import { archiveSupersededRecord, assemblyReportMatchesPacket, campaignHandedOff, commitAssemblyReport, inputChangeFor } from "./stage-ledger.mjs";
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
  if (explicitPath) return { explicit: true, files: [{ path: explicitPath, source: "operator_flag" }] };
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

// An active page as the Build Context records it.
const recordedActivePage = (page) => ({ id: page.id, type: page.type || null, label: page.label || null, page_url: publicRouteForPage(page) });

/**
 * How the CampaignSpec's active pages differ from the ones the Build Context
 * records, split the way record spec binds them (#531, #721): page identity
 * (`added` and `removed` ids, and whether the pages both lists keep are in
 * another order) and routes (`moved`: kept pages whose route changed).
 * `changed` is true when anything differs, or when the context records no
 * pages, or a page id twice (then `unbindable`, as a reorder is).
 */
export function pageScopeChange(spec, context) {
  const recorded = Array.isArray(context?.spec?.active_pages) ? context.spec.active_pages : null;
  const current = activeSpecPages(spec).map(recordedActivePage);
  if (!recorded) return { recorded: false, current, added: [], removed: [], moved: [], reordered: false, unbindable: true, changed: true };
  const recordedIds = recorded.map((page) => page?.id);
  const currentIds = current.map((page) => page.id);
  const duplicate = new Set(recordedIds).size !== recordedIds.length || new Set(currentIds).size !== currentIds.length;
  const added = currentIds.filter((id) => !recordedIds.includes(id));
  const removed = recordedIds.filter((id) => !currentIds.includes(id));
  const keptRecorded = recordedIds.filter((id) => currentIds.includes(id));
  const keptCurrent = currentIds.filter((id) => recordedIds.includes(id));
  const reordered = keptRecorded.length !== keptCurrent.length || keptRecorded.some((id, index) => id !== keptCurrent[index]);
  const recordedById = new Map(recorded.map((page) => [page?.id, page]));
  const moved = current.filter((page) => recordedById.has(page.id) && (page.page_url ?? null) !== (recordedById.get(page.id)?.page_url ?? null)).map((page) => page.id);
  const unbindable = duplicate || reordered;
  return { recorded: true, current, added, removed, moved, reordered, unbindable, changed: unbindable || added.length > 0 || removed.length > 0 || moved.length > 0 };
}

// The files Campaigns OS writes itself, which a brief path must never name.
function packageArtifactPaths(workspace, normalizedPath) {
  return [
    { label: "normalized brief", path: normalizedPath },
    { label: "Build Packet", path: workspace.packetPath },
    { label: "Build Context", path: workspace.contextPath },
    { label: "Assembly Report", path: workspace.reportPath },
    { label: "doctor sidecar", path: workspace.doctorOutPath },
  ].filter((entry) => entry.path);
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The brief-file refusals both refreshes share, in their fixed order:
// too large, a package-owned artifact, then no readable file. Size and
// realpath are read from regular files only. `missingDetail(file)` words the
// last refusal: `file` is null when there is no candidate at all, otherwise
// the candidate with `why` it cannot be read. Returns [code, detail] or null.
function briefFileRefusal(files, packageArtifacts, missingDetail) {
  const regular = files.filter((file) => isRegularFile(file.path));
  for (const file of regular) {
    const large = briefTooLarge(file.path);
    if (large) return ["brief_too_large", large];
  }
  for (const file of regular) {
    const real = realpathOrNull(file.path);
    const artifact = packageArtifacts.find((entry) => real && realpathOrNull(entry.path) === real);
    if (artifact) return ["brief_source_is_package_artifact", `${file.path} is the ${artifact.label}, which Campaigns OS writes itself; save the brief from a campaign-build-brief.json (or .yaml) file of your own.`];
  }
  if (!files.length) return ["brief_file_missing", missingDetail(null)];
  for (const file of files) {
    const why = briefFileUnusable(file.path);
    if (why) return ["brief_file_missing", missingDetail({ ...file, why })];
  }
  return null;
}

// Every record brief refusal, in the fixed order; the first that holds is
// returned as [code, detail], or null when none holds.
function briefRefusal({ candidates, packageArtifacts, context, spec, report }) {
  const fileRefusal = briefFileRefusal(candidates.files, packageArtifacts, (file) => (file
    ? `the ${candidates.explicit ? "--brief file" : "brief file found at"} ${file.path} ${file.why}; save a readable brief file (or pass --brief <file>).`
    : `no ${BUILD_BRIEF_CANDIDATE_FILENAMES.join(", ")} in the source root or the target; copy the normalized draft to campaign-build-brief.json in the target, set the open fields, and run record brief again (or pass --brief <file>).`));
  if (fileRefusal) return fileRefusal;
  if (!candidates.explicit && candidates.files.length > 1) {
    const [first, second] = candidates.files;
    if (!readFileSync(first.path).equals(readFileSync(second.path))) {
      return ["brief_path_ambiguous", `${first.path} and ${second.path} differ; pass --brief <file> to name the one to save.`];
    }
  }
  const missing = briefInputsMissing(context);
  if (missing.length) return ["brief_inputs_unavailable", `the Build Context lacks ${missing.join(", ")}, which evaluating the brief needs; re-run intake to restore it.`];
  const bound = optionalString(report?.identity?.spec_material_hash);
  const current = currentSpecMaterial(spec);
  if (!current || !bound || current !== `sha256:${bound.replace(/^sha256:/, "")}`) {
    return ["spec_changed_run_record_spec", `the CampaignSpec material (${current || "unreadable"}) differs from the one the Assembly Report binds (${bound || "none"}); save the spec change with ${cmd("record")} spec first.`];
  }
  if (pageScopeChange(spec, context).changed) {
    return ["page_scope_changed", `the CampaignSpec's active pages (ids, order or routes) differ from the Build Context's spec.active_pages; bind the page change with ${cmd("record")} spec first (a routes-only change, or a page added or removed after handoff), or re-run intake for any other.`];
  }
  return null;
}

// The intake products evaluating a brief needs that the Build Context lacks.
function briefInputsMissing(context) {
  return [
    ["spec.active_pages", Array.isArray(context?.spec?.active_pages)],
    ["page_map", Array.isArray(context?.page_map)],
    ["source.asset_crawl", context?.source?.asset_crawl != null],
    ["commerce_zone_findings", Array.isArray(context?.commerce_zone_findings)],
  ].filter(([, present]) => !present).map(([field]) => field);
}

const questionIds = (brief) => (Array.isArray(brief?.questions) ? brief.questions.map((question) => question?.id) : []);
const gateCodes = (brief) => (Array.isArray(brief?.gates) ? brief.gates.map((gate) => gate?.code) : []);

/**
 * The brief re-evaluated as intake evaluates it: `briefFile` ({path, source},
 * or null for the generated guided draft) through the same artifact function,
 * with the Build Context's intake products (page_map's source_path read as
 * the draft's path), the report's bound mode and the previous normalized
 * brief. Returns the brief result and its bindings.
 */
function rederiveBrief({ briefFile, spec, context, packet, report, normalizedPath }) {
  const previousNormalizedBrief = readJsonOrNull(normalizedPath);
  const buildBrief = createCampaignBuildBriefArtifact({
    inputPath: briefFile?.path || null,
    inputSource: briefFile?.source || null,
    spec,
    activePages: activeSpecPages(spec),
    pageMappings: context.page_map.map((entry) => ({ page_id: entry.page_id, path: entry.source_path || null, skip_reason: entry.skip_reason || null })),
    templateFamily: context.template?.family || packet.assembly?.template_family || null,
    sourceAssetCrawl: context.source.asset_crawl,
    commerceZoneFindings: context.commerce_zone_findings,
    boundReportMode: assemblyReportMatchesPacket(report, packet) ? optionalString(report.build_brief?.mode) : null,
    previousNormalizedBrief: isObject(previousNormalizedBrief) ? previousNormalizedBrief : null,
  });
  if (buildBrief.inputPath) buildBrief.artifact._meta.input_path = relFromFile(normalizedPath, buildBrief.inputPath);
  return { buildBrief, bindings: briefIntakeBindings(buildBrief) };
}

/**
 * How a re-evaluated brief compares with what the report binds: `unchanged`
 * when the material, mode, status, question ids, gate codes and file sha256
 * all match; `saved_with_invalidation` (with the changed partitions as
 * `causes`) when a material partition differs; `saved` otherwise, including
 * when no well-formed material is bound yet.
 */
function briefSaveOutcome(report, buildBrief, bindings) {
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
  return { outcome: unchanged ? "unchanged" : causes.length ? "saved_with_invalidation" : "saved", causes };
}

// The Build Context and Assembly Report a brief save writes: the brief
// summary and bindings on both, the brief's prompts on the context, and
// prepare_build re-derived from the brief's blockers. No other stage field.
// The saved file becomes the brief source a later refresh reads: the
// context's intake.brief_path names it when it was given with --brief, and
// is cleared when it was found by discovery, as intake records it.
function briefSaveArtifacts({ context, report, buildBrief, bindings, targetRepo }) {
  const briefSummary = {
    ...(isObject(context.build_brief) ? context.build_brief : {}),
    mode: buildBrief.mode,
    status: buildBrief.artifact.status,
    input_path: buildBrief.inputPath ? relFromDir(targetRepo, buildBrief.inputPath) : null,
    question_count: buildBrief.questions.length,
    gate_count: buildBrief.gates.length,
    questions: buildBrief.questions,
    gates: buildBrief.gates,
    ...bindings,
  };
  const explicitSource = buildBrief.inputPath && buildBrief.artifact._meta?.input_source === "operator_flag";
  const nextContext = {
    ...context,
    ...(isObject(context.intake) ? { intake: { ...context.intake, brief_path: explicitSource ? relFromDir(targetRepo, buildBrief.inputPath) : null } } : {}),
    build_brief: briefSummary,
    prompts_required: [
      ...(Array.isArray(context.prompts_required) ? context.prompts_required : []).filter((prompt) => !isBriefBlocker(prompt)),
      ...briefPrompts(buildBrief),
    ],
  };
  const nextReport = {
    ...report,
    build_brief: JSON.parse(JSON.stringify(briefSummary)),
    stages: { ...report.stages, prepare_build: prepareBuildBriefBlockers(report.stages.prepare_build, briefPrepareBuildBlockers(buildBrief)) },
  };
  return { nextContext, nextReport };
}

// The binding_unknown notice: each recorded stage whose inputs cannot be
// confirmed, named to be recorded again.
function bindingUnknownNotices(currency) {
  const unknownStages = STAMPED_STAGES.filter((key) => currency.stages[key] === "unknown");
  return unknownStages.length
    ? [{ code: "binding_unknown", stages: unknownStages, message: `Recorded ${unknownStages.join(", ")} do not say which brief and CampaignSpec content they were made against; record ${unknownStages.join(", ")} again.` }]
    : [];
}

// One refresh run under the target lock (a dry run takes none: it writes nothing).
function underTargetLock(packetPath, command, dryRun, now, run) {
  if (!existsSync(packetPath)) throw new Error(`${command}: Build Packet not found at ${packetPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  const lockedTarget = targetRepoFor(packetPath, JSON.parse(readFileSync(packetPath, "utf8")));
  const timestamp = now().toISOString();
  const locked = () => run({ lockedTarget, timestamp });
  return dryRun ? locked() : withTargetLockSync(lockedTarget, locked, { command });
}

/**
 * Run one `record brief` invocation. Returns the result object the CLI
 * prints; throws a refusal (nothing written) when a check fails.
 */
export function recordBrief({ packetPath, briefPath: explicitBrief = null, contextPath = undefined, reportPath = undefined, dryRun = false }, { now = () => new Date() } = {}) {
  return underTargetLock(packetPath, "record brief", dryRun, now, ({ lockedTarget, timestamp }) => saveBriefUnderLock({
    packetPath, explicitBrief, sidecars: { contextPath, reportPath }, lockedTarget, dryRun, timestamp,
  }));
}

function saveBriefUnderLock({ packetPath, explicitBrief, sidecars, lockedTarget, dryRun, timestamp }) {
  const workspace = resolveCampaignWorkspace(packetPath, { ...sidecars, followContextPointer: true });
  const { packet, contextPath, reportPath, targetRepo } = workspace;
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
  const refusal = briefRefusal({ candidates, packageArtifacts: packageArtifactPaths(workspace, normalizedPath), context, spec, report });
  if (refusal) throw refuseRecord("brief", [`${refusal[0]}: ${refusal[1]}`]);

  const { buildBrief, bindings } = rederiveBrief({ briefFile: candidates.files[0], spec, context, packet, report, normalizedPath });
  const material = bindings.material;
  const { outcome, causes } = briefSaveOutcome(report, buildBrief, bindings);
  const currency = assessInputCurrency({ report, briefMaterial: material, specMaterial: currentSpecMaterial(spec) });
  const notices = bindingUnknownNotices(currency);

  let demoted = [];
  const writes = [];
  if (outcome !== "unchanged") {
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
    const saved = briefSaveArtifacts({ context, report, buildBrief, bindings, targetRepo });
    let nextReport = saved.nextReport;
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
      writeJsonAtomic(packetPath, portableArtifactPaths(nextPacket, targetRepo, { artifactPath: packetPath }));
      writeJsonAtomic(normalizedPath, portableArtifactPaths(buildBrief.artifact, targetRepo, { artifactPath: normalizedPath }));
      writeJsonAtomic(contextPath, portableArtifactPaths(saved.nextContext, targetRepo, { artifactPath: contextPath }));
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

/**
 * Run one `record spec` invocation: bind the CampaignSpec as it is now.
 * Returns the result object the CLI prints; throws a refusal (nothing
 * written) when a check fails.
 */
export function recordSpec({ packetPath, contextPath = undefined, reportPath = undefined, dryRun = false }, { now = () => new Date() } = {}) {
  return underTargetLock(packetPath, "record spec", dryRun, now, ({ lockedTarget, timestamp }) => refreshSpecUnderLock({
    packetPath, sidecars: { contextPath, reportPath }, lockedTarget, dryRun, timestamp,
  }));
}

// The CampaignSpec file and its parse, or null when it cannot be read or parsed.
function readSpecFile(specPath) {
  if (!specPath || !existsSync(specPath)) return null;
  try {
    const bytes = readFileSync(specPath);
    const spec = JSON.parse(bytes.toString("utf8"));
    return isObject(spec) ? { spec, rawHash: createHash("sha256").update(bytes).digest("hex") } : null;
  } catch {
    return null;
  }
}

// A text file written whole or not at all: staged beside it, then renamed.
function writeTextAtomic(path, text) {
  const staged = join(dirname(path), `.${relative(dirname(path), path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, text, { flag: "wx" });
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

// The brief file last saved, by intake or record brief: its --brief path,
// otherwise the file that save found; never discovery. Null when intake
// generated the guided draft and no brief file was saved since.
function recordedBriefFile(context, { targetRepo, previousNormalizedBrief }) {
  const explicit = optionalString(context?.intake?.brief_path);
  if (explicit) return { path: resolve(targetRepo, explicit), source: "operator_flag" };
  const found = optionalString(context?.build_brief?.input_path);
  if (!found) return null;
  return { path: resolve(targetRepo, found), source: optionalString(previousNormalizedBrief?._meta?.input_source) || "target_repo" };
}

// Every record spec refusal, in the fixed order: the spec checks first (the
// page-scope comparison needs a readable spec of the bound identity), then
// the page rebind's own checks, then the recorded brief file. Returns
// { refusal: [code, detail] | null, rebind } where `rebind` is the page
// rebind plan (null when the active pages are the ones recorded).
function specRefusal({ read, specPath, packet, packetPath, report, reportPath, context, targetRepo, briefFile, packageArtifacts }) {
  const refuse = (code, detail) => ({ refusal: [code, detail], rebind: null });
  if (!read) return refuse("spec_unreadable", `the CampaignSpec at ${specPath || "(the packet names no spec.local_path)"} could not be read as a JSON object; restore it, then run ${cmd("record")} spec again.`);
  const packetKind = specIdentityMismatch(read.spec, packet.spec);
  const reportKind = isObject(report.identity) ? specIdentityMismatch(read.spec, report.identity) : null;
  if (packetKind || reportKind) {
    return refuse("spec_identity_changed", `the CampaignSpec's ${(packetKind || reportKind) === "local_spec" ? "local_spec_id" : "map_id"} names another campaign than the ${packetKind ? "Build Packet" : "Assembly Report"} binds; point spec.local_path at this campaign's spec. A new campaign identity needs intake.`);
  }
  const scope = pageScopeChange(read.spec, context);
  const intake = `${cmd("prepare-build")}; with --force it clears recorded stage evidence and operator decisions, archiving the build, Polish and QA records`;
  if (scope.unbindable) {
    return refuse("page_scope_changed", `the CampaignSpec's active pages are ${scope.recorded ? "in another order than" : "not comparable with"} the Build Context's spec.active_pages. record spec binds a move of routes, and after handoff a page added or removed; a reorder needs intake (${intake}).`);
  }
  if ((scope.added.length || scope.removed.length) && !campaignHandedOff(report)) {
    return refuse("page_scope_changed", `the CampaignSpec ${[scope.added.length ? `adds ${scope.added.map((id) => `"${id}"`).join(", ")}` : null, scope.removed.length ? `removes ${scope.removed.map((id) => `"${id}"`).join(", ")}` : null].filter(Boolean).join(" and ")} against the Build Context's spec.active_pages. Before handoff (no deploy or QA completed) the design source decides the pages, and the Design Source Package and the source mapping are built per page, so a page added or removed needs intake (${intake}).`);
  }
  let rebind = null;
  if (scope.changed) {
    const planned = planPageRebind({ spec: read.spec, packet, packetPath, report, reportPath, context, targetRepo, scope });
    if (planned.refusal) return { refusal: planned.refusal, rebind: null };
    rebind = planned;
  }
  if (!briefFile) return { refusal: null, rebind };
  const fileRefusal = briefFileRefusal([briefFile], packageArtifacts, (file) => `the brief file last saved, ${briefFile.path}, ${file?.why || "does not exist"}; restore it, or save a brief file with ${cmd("record")} brief --brief <file>.`);
  return { refusal: fileRefusal, rebind: fileRefusal ? null : rebind };
}

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

/**
 * What binding the changed active pages writes (#531, #721), or the refusal
 * that stops it. Every page is re-projected to its page-kit target (a page's
 * next_url reads the routes of the pages it links to). Refused, in order:
 * a move of the route root or slug, a routing hint left stale, two pages on
 * one target, and a Design Source Package record spec cannot rewrite (one
 * prepare-build did not synthesize, or one edited since it was recorded).
 * Returns the next packet pages and page map, the rewritten package (or
 * null when its bytes do not change), whether the build's targets or the set
 * of built pages changed, and whether the change touched routes alone.
 */
function planPageRebind({ spec, packet, packetPath, report, reportPath, context, targetRepo, scope }) {
  const refuse = (code, detail) => ({ refusal: [code, detail] });
  const slug = normalizePublicRouteSlug(packet.campaign?.public_route_slug);
  const specSlug = specPublicRouteSlug(spec);
  const packetRoot = campaignRouteRoot(packet);
  const declaredRoot = optionalString(spec.spec_identity?.route_root) || optionalString(spec.campaign?.route_root);
  const specRoot = declaredRoot ? intakeRouteRoot(declaredRoot, slug) : null;
  if ((specSlug && specSlug !== slug) || (declaredRoot && specRoot !== packetRoot)) {
    return refuse("route_root_changed", `the CampaignSpec ${specSlug && specSlug !== slug ? `names route slug "${specSlug}"` : `declares route_root ${JSON.stringify(declaredRoot)}`}, but the packet serves the campaign at ${packetRoot || "(no route root)"}; the recorded preview and deploy are rooted there, so moving the route root or slug needs intake (${cmd("prepare-build")}).`);
  }
  const stale = staleRoutingHints(spec, { publicRouteSlug: slug });
  if (stale.length) {
    return refuse("routing_hint_stale", `the CampaignSpec's routing hints name routes their pages no longer have: ${stale.map((hint) => `${hint.page_id} sdk_hints.meta_tags.${hint.tag} ${JSON.stringify(hint.value)} (page "${hint.target_page_id}" routes to ${JSON.stringify(hint.derived_route)})`).join("; ")}. The built meta tag follows the hint, so shoppers would be sent to the old path. Edit each hint to the route shown in the spec (${cmd("spec")} derive rewrites the ones on an edge it re-points after handoff; while the Map is still the spec's source, re-saving it regenerates them), then run ${cmd("record")} spec again.`);
  }

  const activePages = activeSpecPages(spec);
  const pageById = new Map(activePages.map((page) => [page.id, page]));
  const outputDir = optionalString(packet.assembly?.output_dir) || `src/${slug}`;
  const projections = projectPageKitTargets({ specPages: activePages, publicRouteSlug: slug, outputDir });
  const removed = new Set(scope.removed);
  const previousPages = Array.isArray(packet.source_html?.pages) ? packet.source_html.pages : [];
  const nextPages = [];
  for (const entry of previousPages) {
    if (!isObject(entry) || removed.has(entry.page_id)) continue;
    nextPages.push(isObject(entry.page_kit) && projections.has(entry.page_id) ? { ...entry, page_kit: projections.get(entry.page_id) } : entry);
  }
  for (const id of scope.added) {
    nextPages.push({ page_id: id, ...(optionalString(pageById.get(id)?.type) ? { page_type: pageById.get(id).type } : {}), origin: "repo", page_kit: projections.get(id) });
  }
  const byTarget = new Map();
  for (const entry of nextPages) {
    const target = entry.page_kit?.output_path;
    if (!target) continue;
    if (byTarget.has(target)) {
      return refuse("page_kit_target_conflict", `pages "${byTarget.get(target)}" and "${entry.page_id}" both project to page-kit target ${target}; give one page a distinct route, then run ${cmd("record")} spec again.`);
    }
    byTarget.set(target, entry.page_id);
  }
  const kitOf = (entries) => new Map(entries.filter((entry) => isObject(entry?.page_kit)).map((entry) => [entry.page_id, canonicalJson(entry.page_kit)]));
  const differs = (before, after) => before.size !== after.size || [...after].some(([id, kit]) => before.get(id) !== kit);
  const afterKits = kitOf(nextPages);
  // Compared with the Build Context's page map as well as the packet's: a
  // run that stopped after writing the packet leaves the packet already
  // re-projected, and the Context still says what was built.
  const projectionChanged = differs(kitOf(previousPages), afterKits) || differs(kitOf(Array.isArray(context.page_map) ? context.page_map : []), afterKits);
  const routesOf = (entries) => [...new Set(entries.filter((entry) => isObject(entry?.page_kit)).map((entry) => entry.page_kit.public_route))].sort();
  const builtPagesChanged = canonicalJson(routesOf(previousPages)) !== canonicalJson(routesOf(nextPages));
  // A moved page with no page-kit target (out of scope, not built) still
  // moves a URL QA reads, so it counts as a change to what is served.
  const unprojectedMoved = scope.moved.some((id) => !afterKits.has(id));

  const previousMap = Array.isArray(context.page_map) ? context.page_map : [];
  const nextMap = [];
  for (const entry of previousMap) {
    if (!isObject(entry) || removed.has(entry.page_id)) continue;
    if (isObject(entry.page_kit) && projections.has(entry.page_id)) {
      const kit = projections.get(entry.page_id);
      nextMap.push({ ...entry, output_path: relFromDir(targetRepo, resolve(targetRepo, kit.output_path)), page_kit: kit });
    } else nextMap.push(entry);
  }
  for (const id of scope.added) {
    const kit = projections.get(id);
    nextMap.push({ page_id: id, source_path: null, skip_reason: null, output_path: relFromDir(targetRepo, resolve(targetRepo, kit.output_path)), page_kit: kit, origin: "repo" });
  }

  let designSource = null;
  const reference = packet.design_source_package;
  if (isObject(reference)) {
    const packagePath = resolveFromFile(packetPath, reference.path);
    let bytes;
    let value;
    try {
      bytes = readFileSync(packagePath);
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      return refuse("design_source_package_unreadable", `the Design Source Package at ${packagePath} could not be read (${error.message}); restore it, or re-run intake (${cmd("prepare-build")}).`);
    }
    const onDisk = hashSerializedDesignSourcePackage(bytes);
    let rebound;
    let serialized;
    try {
      rebound = rebindDesignSourcePackagePages(value, { activePages, projections });
      serialized = serializeDesignSourcePackage(rebound);
    } catch (error) {
      return refuse("design_source_package_unbindable", `the Design Source Package at ${packagePath} is not a package record spec can re-bind (${error.message}); re-run intake (${cmd("prepare-build")}).`);
    }
    // Only a rebind that changes the package writes it, so only then do the
    // checks on who may rewrite it apply.
    if (serialized !== serializeDesignSourcePackage(value)) {
      const origin = report.design_source_package?.origin ?? null;
      if (origin !== "synthesized") {
        return refuse("design_source_package_operator_supplied", `the Design Source Package at ${packagePath} ${origin === "adopted" ? "was adopted by prepare-build from a package it did not write" : origin ? `has origin ${JSON.stringify(origin)}` : "has no recorded origin (an Assembly Report older than the origin field)"}, so record spec does not rewrite its page routes, which the new pages would change; reconcile it with the new pages and re-run intake (${cmd("prepare-build")}).`);
      }
      const provenance = readPriorDesignSourceProvenance(reportPath, packagePath);
      if (onDisk !== reference.sha256 && !(provenance?.synthesized || []).includes(onDisk)) {
        return refuse("design_source_package_edited", `the Design Source Package at ${packagePath} no longer matches the sha256 the packet records (it was edited since prepare-build wrote it), so record spec does not rewrite it; restore it, or re-run intake (${cmd("prepare-build")} --force regenerates a package it synthesized).`);
      }
      const validation = validateDesignSourcePackage(rebound);
      if (!validation.ok) {
        return refuse("design_source_package_unbindable", `the Design Source Package with the new page routes does not validate (${validation.errors.slice(0, 3).map((error) => `[${error.code}] ${error.message}`).join("; ")}); re-run intake (${cmd("prepare-build")}).`);
      }
      const identity = createDesignSourcePackageArtifactReference(rebound, { serialized });
      designSource = { path: packagePath, serialized, sha256: identity.sha256, material_fingerprint: identity.material_fingerprint };
    }
  }

  // Routes alone: no page added or removed, and nothing but page_url differs
  // from the material the Build Context recorded at the last bind.
  const recordedMasked = optionalString(context.spec?.route_masked_material_hash);
  const routesOnly = !scope.added.length && !scope.removed.length && Boolean(recordedMasked) && recordedMasked === routeMaskedSpecMaterialHash(spec);
  return {
    refusal: null,
    scope,
    nextPages,
    nextMap,
    designSource,
    projectionChanged,
    builtPagesChanged,
    // Nothing the build wrote changes: the same targets, links and routing
    // meta, the same Design Source Package, and only routes moved.
    builtUnchanged: routesOnly && !projectionChanged && !unprojectedMoved && !designSource,
  };
}

/**
 * The Design Source Package reference a record spec run that stopped part
 * way left behind (#531). The rewritten package is published first and the
 * report last, so a run that dies between them leaves the packet, the Build
 * Context or the Assembly Report naming the old sha256 while the package on
 * disk is the new one. When prepare-build's provenance (the report's
 * synthesized reference or the pending record beside the package) vouches
 * for the bytes on disk, and any of the three references names other bytes,
 * this returns the identity to move them to; otherwise null, and doctor
 * reports a mismatch it cannot vouch for.
 */
function designSourceReferenceRepair({ packet, packetPath, context, report, reportPath }) {
  const reference = packet.design_source_package;
  if (!isObject(reference) || report.design_source_package?.origin !== "synthesized") return null;
  const packagePath = resolveFromFile(packetPath, reference.path);
  let bytes;
  let value;
  try {
    bytes = readFileSync(packagePath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const onDisk = hashSerializedDesignSourcePackage(bytes);
  const references = [reference, context.design_source_package, report.design_source_package].filter(isObject);
  if (references.every((ref) => ref.sha256 === onDisk)) return null;
  if (!(readPriorDesignSourceProvenance(reportPath, packagePath)?.synthesized || []).includes(onDisk)) return null;
  const identity = createDesignSourcePackageArtifactReference(value, { serialized: bytes });
  return { path: packagePath, sha256: identity.sha256, material_fingerprint: identity.material_fingerprint };
}

// The currency reasons that mean a stage's stamp differs from the current
// input. The replay reasons are not stamp changes: a refresh cannot clear them.
const STAMP_OWED_REASONS = Object.freeze(["spec_material_changed", "brief_material_changed"]);
const BRIEF_PARTITIONS = Object.freeze(["presentation", "qa_policy"]);

const sameBriefMaterial = (a, b) => wellFormedBriefMaterial(a) && wellFormedBriefMaterial(b)
  && BRIEF_PARTITIONS.every((partition) => a[partition] === b[partition]);

function refreshSpecUnderLock({ packetPath, sidecars, lockedTarget, dryRun, timestamp }) {
  const workspace = resolveCampaignWorkspace(packetPath, { ...sidecars, followContextPointer: true });
  const { packet, contextPath, reportPath, targetRepo } = workspace;
  if (targetRepo !== lockedTarget) throw refuseRecord("spec", [`The Build Packet was retargeted while this refresh waited for the target lock (${lockedTarget} is now ${targetRepo}); run ${cmd("record")} spec again.`]);
  const report = readJsonOrNull(reportPath);
  if (!isObject(report?.stages)) throw new Error(`record spec: no readable Assembly Report at ${reportPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  const context = readJsonOrNull(contextPath);
  if (!isObject(context)) throw new Error(`record spec: no readable Build Context at ${contextPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  const specPath = optionalString(packet.spec?.local_path) ? resolveFromFile(packetPath, packet.spec.local_path) : null;
  const read = readSpecFile(specPath);
  const normalizedPath = optionalString(packet.build_brief?.normalized_path) ? resolveFromFile(packetPath, packet.build_brief.normalized_path) : null;
  const previousNormalizedBrief = readJsonOrNull(normalizedPath);
  const briefFile = normalizedPath ? recordedBriefFile(context, { targetRepo, previousNormalizedBrief }) : null;
  const { refusal, rebind } = specRefusal({ read, specPath, packet, packetPath, report, reportPath, context, targetRepo, briefFile, packageArtifacts: packageArtifactPaths(workspace, normalizedPath) });
  if (refusal) throw refuseRecord("spec", [`${refusal[0]}: ${refusal[1]}`]);

  const { spec, rawHash } = read;
  const material = currentSpecMaterial(spec);
  const boundMaterial = optionalString(report.identity?.spec_material_hash);
  const currentBrief = normalizedPath ? currentBriefMaterial({ packet, packetPath }) : absentBriefMaterial();
  const currency = assessInputCurrency({ report, briefMaterial: currentBrief, specMaterial: material });
  // Unchanged only when the bound material is the spec's and no stage's spec
  // or brief stamp differs from the current input.
  const owedOnStamp = STAMPED_STAGES.filter((key) => STAMP_OWED_REASONS.includes(currency.reasons[key]));
  const notices = bindingUnknownNotices(currency);
  const specChanged = !specHashesMatch(boundMaterial, material);
  // A package reference an earlier, interrupted run left behind is moved
  // with whatever else this run binds (a rewrite this run makes moves them
  // itself).
  const repair = rebind?.designSource ? null : designSourceReferenceRepair({ packet, packetPath, context, report, reportPath });
  // A recovery run never keeps the build: what the interrupted run changed
  // cannot be told from what this one sees, so the stages are owed again.
  const builtUnchanged = Boolean(rebind?.builtUnchanged) && !repair;
  const unchanged = !specChanged && !owedOnStamp.length && !rebind && !repair;

  const writes = [];
  let demoted = [];
  let briefOutcome = null;
  let reason = null;
  if (!unchanged) {
    // The brief re-derived with the new spec, under the record brief rules:
    // an unchanged brief writes nothing of its own, a saved one rewrites the
    // normalized brief and its bindings, and a material change also makes
    // the stages its partitions name owed.
    let brief = null;
    // The context the brief is re-derived from carries the rebound pages, so
    // a page added after handoff is evaluated as the repo page it is.
    const pageContext = rebind ? { ...context, page_map: rebind.nextMap } : context;
    if (normalizedPath) {
      // Checked only when the brief is re-derived: an unchanged result reads
      // nothing the missing intake products would give.
      const missing = briefInputsMissing(context);
      if (missing.length) throw refuseRecord("spec", [`brief_inputs_unavailable: the Build Context lacks ${missing.join(", ")}, which re-deriving the brief needs; re-run intake to restore it.`]);
      brief = rederiveBrief({ briefFile, spec, context: pageContext, packet, report, normalizedPath });
      briefOutcome = briefSaveOutcome(report, brief.buildBrief, brief.bindings);
    }
    const briefSaved = briefOutcome && briefOutcome.outcome !== "unchanged";
    // The normalized brief is rewritten when the save rules say so, and also
    // when the file on disk no longer holds the re-derived material (an edit
    // made to the normalized brief itself, which its source does not carry).
    const briefWritten = Boolean(brief) && (briefSaved || !sameBriefMaterial(brief.bindings.material, currentBrief));
    const newBrief = brief ? brief.bindings.material : currentBrief;
    const saved = briefSaved
      ? briefSaveArtifacts({ context: pageContext, report, buildBrief: brief.buildBrief, bindings: brief.bindings, targetRepo })
      : { nextContext: pageContext, nextReport: report };
    const labels = new Map(activeSpecPages(spec).map((page) => [page.id, page.label || null]));
    const nextContext = {
      ...saved.nextContext,
      spec: {
        ...saved.nextContext.spec,
        hash: rawHash,
        material_hash: material,
        route_masked_material_hash: routeMaskedSpecMaterialHash(spec),
        active_pages: rebind
          ? rebind.scope.current
          : saved.nextContext.spec.active_pages.map((page) => ({ ...page, label: labels.has(page.id) ? labels.get(page.id) : page.label ?? null })),
      },
    };
    let nextReport = { ...saved.nextReport, identity: { ...saved.nextReport.identity, spec_hash: rawHash, spec_material_hash: material } };
    // The rebound pages' Design Source Package: the same path, new bytes, and
    // each of the three references to it moved together (#531).
    let nextPacket = null;
    if (rebind) nextPacket = { ...packet, source_html: { ...packet.source_html, pages: rebind.nextPages } };
    const movedTo = rebind?.designSource || repair;
    if (movedTo) {
      const moved = { sha256: movedTo.sha256, material_fingerprint: movedTo.material_fingerprint };
      const at = (ref) => ref.sha256 !== moved.sha256 || ref.material_fingerprint !== moved.material_fingerprint;
      if (at(packet.design_source_package)) nextPacket = { ...(nextPacket || packet), design_source_package: { ...packet.design_source_package, ...moved } };
      if (isObject(nextContext.design_source_package) && at(nextContext.design_source_package)) nextContext.design_source_package = { ...nextContext.design_source_package, ...moved };
      if (isObject(nextReport.design_source_package) && at(nextReport.design_source_package)) nextReport.design_source_package = { ...nextReport.design_source_package, ...moved };
    }
    // A stage is owed on the spec unless its spec stamp already equals the
    // new material (a build recorded after the edit has recorded the change
    // itself); a completed stage with no spec stamp is owed on it too. It is
    // owed on a brief partition it depends on when the save rules invalidate
    // that partition, or when its stamp of that partition differs from the
    // re-derived brief. The spec reason wins where both apply.
    const briefCauses = briefOutcome?.outcome === "saved_with_invalidation" ? briefOutcome.causes : [];
    // Routes that moved without moving anything the build wrote (the same
    // targets, links and routing meta, #531): a stage made against the bound
    // spec is restamped with the new material instead of made owed again.
    const keptStages = [];
    if (builtUnchanged && specChanged) {
      for (const key of STAMPED_STAGES) {
        const record = nextReport.stages[key];
        if (!COMPLETED_STATUSES.includes(record?.status) || !specHashesMatch(record.source_spec_material_hash, boundMaterial)) continue;
        const restamped = { ...record, source_spec_material_hash: material };
        if (isObject(record.unchanged_output_reason?.for_inputs) && specHashesMatch(record.unchanged_output_reason.for_inputs.spec_material_hash, boundMaterial)) {
          restamped.unchanged_output_reason = { ...record.unchanged_output_reason, for_inputs: { ...record.unchanged_output_reason.for_inputs, spec_material_hash: material } };
        }
        nextReport = { ...nextReport, stages: { ...nextReport.stages, [key]: restamped } };
        keptStages.push(key);
      }
    }
    const causesFor = (key) => {
      const record = nextReport.stages[key];
      const stamp = record?.source_brief_material;
      const specStamp = record?.source_spec_material_hash;
      const specOwed = specStamp ? specStamp !== material : specChanged || COMPLETED_STATUSES.includes(record?.status);
      const causes = specOwed ? ["spec"] : [];
      for (const partition of BRIEF_PARTITIONS) {
        if (!INPUT_DEPENDENCY_MAP[partition].stages[key]) continue;
        const stampDiffers = wellFormedBriefMaterial(stamp) && wellFormedBriefMaterial(newBrief) && stamp[partition] !== newBrief[partition];
        if (briefCauses.includes(partition) || stampDiffers) causes.push(partition);
      }
      return causes;
    };
    const allCauses = specChanged ? ["spec"] : [];
    for (const key of STAMPED_STAGES) {
      const causes = causesFor(key);
      if (!causes.length) continue;
      const applied = demoteStages(nextReport, { causes, now: timestamp, by: "record spec", only: [key] });
      nextReport = applied.report;
      demoted = [...demoted, ...applied.demoted];
      allCauses.push(...causes);
    }
    // Deploy evidence is the list of URLs that answered; when the set of
    // built pages changes, the probe is owed again (#531). A deploy bound to
    // the build fingerprint it probed (#619) is demoted by record build when
    // the rebuilt site differs, so only a deploy recorded before that stamp
    // existed is demoted here.
    if (rebind?.builtPagesChanged) {
      const previousDeploy = nextReport.stages.deploy;
      if (isObject(previousDeploy) && COMPLETED_STATUSES.includes(previousDeploy.status) && !optionalString(previousDeploy.source_build_fingerprint)) {
        const demotedDeploy = { ...previousDeploy, stage: "deploy", status: "required", required_by: "spec", required_for: ["qa"] };
        for (const field of ["source_build_fingerprint", "evidence", "outputs", "completed_at", "recorded_by", "performed_by"]) delete demotedDeploy[field];
        nextReport = { ...nextReport, stages: { ...nextReport.stages, deploy: archiveSupersededRecord(demotedDeploy, previousDeploy, { by: "record spec", reason: "spec_material_changed", at: timestamp }) } };
        demoted = [...demoted, "deploy"];
      }
    }
    reason = changeReason(allCauses);
    const briefNote = briefSaved
      ? `; brief re-derived (${briefOutcome.outcome})`
      : briefWritten ? "; normalized brief re-derived from its source" : "";
    const pageNote = rebind
      ? `; pages ${[rebind.scope.added.length ? `added ${rebind.scope.added.join(", ")}` : null, rebind.scope.removed.length ? `removed ${rebind.scope.removed.join(", ")}` : null, rebind.scope.moved.length ? `moved ${rebind.scope.moved.join(", ")}` : null].filter(Boolean).join("; ")}, page-kit projection ${rebind.projectionChanged ? "rewritten" : "unchanged"}${rebind.designSource ? ", Design Source Package page surfaces rewritten" : ""}${keptStages.length ? `, ${keptStages.join(", ")} kept (nothing built changed)` : ""}`
      : "";
    const repairNote = repair ? `; Design Source Package references moved to ${repair.sha256}, the package an interrupted record spec published` : "";
    nextReport.evidence = [
      ...(Array.isArray(report.evidence) ? report.evidence : []),
      `${timestamp} record spec: CampaignSpec material ${specChanged ? `${boundMaterial || "(none bound)"} -> ${material}` : `${material} already bound`}${briefNote}${pageNote}${repairNote}; ${demoted.length ? `${demoted.join(", ")} owed again` : "no recorded stage was demoted"}${reason ? ` (${reason})` : ""}.`,
    ];
    writes.push(...(rebind?.designSource ? [rebind.designSource.path] : []), ...(nextPacket ? [packetPath] : []), ...(briefWritten ? [normalizedPath] : []), contextPath, reportPath);
    if (!dryRun) {
      // Intake's publication order, the report last: a failure between files
      // leaves the report bound to the old spec material, which reads as owed.
      // The rewritten Design Source Package goes first, vouched for by the
      // pending provenance record until the report records its new sha256,
      // so a run that stops between the two leaves a package the next
      // record spec or prepare-build still knows as its own.
      if (rebind?.designSource) {
        recordPendingDesignSourceProvenance(rebind.designSource.path, [rebind.designSource.sha256, packet.design_source_package.sha256]);
        writeTextAtomic(rebind.designSource.path, rebind.designSource.serialized);
      }
      if (nextPacket) writeJsonAtomic(packetPath, portableArtifactPaths(nextPacket, targetRepo, { artifactPath: packetPath }));
      if (briefWritten) writeJsonAtomic(normalizedPath, portableArtifactPaths(brief.buildBrief.artifact, targetRepo, { artifactPath: normalizedPath }));
      writeJsonAtomic(contextPath, portableArtifactPaths(nextContext, targetRepo, { artifactPath: contextPath }));
      commitAssemblyReport(workspace, () => nextReport, {
        command: "record spec",
        staleReason: "The CampaignSpec was bound with record spec after this doctor snapshot. Re-run doctor (or next) for current state.",
      });
      if (movedTo) recordPendingDesignSourceProvenance(movedTo.path, []);
    }
  }

  const outcome = unchanged ? "unchanged" : "refreshed";
  return {
    ok: true,
    status: dryRun ? "dry_run" : "recorded",
    action: "record",
    stage: "spec",
    outcome,
    dry_run: dryRun,
    spec_path: specPath,
    report_path: reportPath,
    material: { bound: boundMaterial || null, current: material },
    ...(dryRun ? { would_write: writes } : { written: writes }),
    demoted,
    ...(briefOutcome ? { brief: { outcome: briefOutcome.outcome, brief_path: briefFile?.path || null } } : {}),
    ...(rebind ? {
      pages: {
        added: rebind.scope.added,
        removed: rebind.scope.removed,
        moved: rebind.scope.moved,
        projection_changed: rebind.projectionChanged,
        design_source_package_rewritten: Boolean(rebind.designSource),
        built_pages_changed: rebind.builtPagesChanged,
        built_unchanged: builtUnchanged,
      },
    } : {}),
    ...(repair ? { design_source_references_repaired: { sha256: repair.sha256 } } : {}),
    ...(reason ? { input_change: { reason, at: timestamp } } : {}),
    notices,
    note: outcome === "unchanged"
      ? "The CampaignSpec material is the one bound and no stage's stamp is owed; nothing was written."
      : dryRun
        ? "Dry run: every check passed and nothing was written. Re-run without --dry-run to bind the spec."
        : `Bound. Run ${cmd("next")} --packet <packet> for the next stage.`,
  };
}
