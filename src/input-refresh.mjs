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
// the packet and the setup and deploy records are never touched. Refusals
// are checked in a fixed order before anything is written; --dry-run runs
// every check and writes nothing.
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { activeSpecPages, specIdentityMismatch } from "./doctor/checks.mjs";
import {
  INPUT_DEPENDENCY_MAP,
  STAMPED_STAGES,
  absentBriefMaterial,
  assessInputCurrency,
  briefIntakeBindings,
  changeReason,
  currentBriefMaterial,
  currentSpecMaterial,
  wellFormedBriefMaterial,
} from "./input-currency.mjs";
import { cmd } from "./install-invocation.mjs";
import { publicRouteForPage } from "./source-html-intake.mjs";
import { specHashesMatch } from "./spec-identity.mjs";
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

const sameActivePages = (a, b) => a.length === b.length && a.every((page, index) => page.id === b[index]?.id && (page.page_url ?? null) === (b[index]?.page_url ?? null));

// True when the CampaignSpec's active pages (ids, order or routes) differ
// from the ones intake recorded in the Build Context (or none are recorded).
function pageScopeChanged(spec, context) {
  const recorded = Array.isArray(context?.spec?.active_pages) ? context.spec.active_pages : null;
  const derived = activeSpecPages(spec).map((page) => ({ id: page.id, page_url: publicRouteForPage(page) }));
  return !recorded || !sameActivePages(derived, recorded);
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

// Why `path` is not a brief file this run can read, or null when it is one.
// A brief file is a regular file, reached through any symlink, with read
// permission. Nothing here opens the path, so a pipe or socket never blocks.
function briefFileUnusable(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    try {
      lstatSync(path);
      return "is a symlink to nothing";
    } catch {
      return "does not exist";
    }
  }
  if (stats.isDirectory()) return "is a directory, not a file";
  if (!stats.isFile()) return "is not a regular file";
  try {
    accessSync(path, fsConstants.R_OK);
  } catch {
    return "cannot be read";
  }
  return null;
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
  if (pageScopeChanged(spec, context)) {
    return ["page_scope_changed", "the CampaignSpec's active pages (ids, order or routes) differ from the Build Context's spec.active_pages; a page-scope change needs intake."];
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
      writeJsonAtomic(packetPath, nextPacket);
      writeJsonAtomic(normalizedPath, buildBrief.artifact);
      writeJsonAtomic(contextPath, saved.nextContext);
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
// the recorded brief file. Returns [code, detail] or null.
function specRefusal({ read, specPath, packet, report, context, briefFile, packageArtifacts }) {
  if (!read) return ["spec_unreadable", `the CampaignSpec at ${specPath || "(the packet names no spec.local_path)"} could not be read as a JSON object; restore it, then run ${cmd("record")} spec again.`];
  const packetKind = specIdentityMismatch(read.spec, packet.spec);
  const reportKind = isObject(report.identity) ? specIdentityMismatch(read.spec, report.identity) : null;
  if (packetKind || reportKind) {
    return ["spec_identity_changed", `the CampaignSpec's ${(packetKind || reportKind) === "local_spec" ? "local_spec_id" : "map_id"} names another campaign than the ${packetKind ? "Build Packet" : "Assembly Report"} binds; point spec.local_path at this campaign's spec. A new campaign identity needs intake.`];
  }
  if (pageScopeChanged(read.spec, context)) {
    return ["page_scope_changed", `the CampaignSpec's active pages (ids, order or routes) differ from the Build Context's spec.active_pages. The Design Source Package and the source mapping are built per page, so a page-scope change needs intake (${cmd("prepare-build")}); with --force it clears recorded stage evidence and operator decisions, archiving the build, Polish and QA records.`];
  }
  if (!briefFile) return null;
  return briefFileRefusal([briefFile], packageArtifacts, (file) => `the brief file last saved, ${briefFile.path}, ${file?.why || "does not exist"}; restore it, or save a brief file with ${cmd("record")} brief --brief <file>.`);
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
  const refusal = specRefusal({ read, specPath, packet, report, context, briefFile, packageArtifacts: packageArtifactPaths(workspace, normalizedPath) });
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
  const unchanged = !specChanged && !owedOnStamp.length;

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
    if (normalizedPath) {
      const missing = briefInputsMissing(context);
      if (missing.length) throw new Error(`record spec: the Build Context lacks ${missing.join(", ")}, which re-deriving the brief needs; re-run intake to restore it.`);
      brief = rederiveBrief({ briefFile, spec, context, packet, report, normalizedPath });
      briefOutcome = briefSaveOutcome(report, brief.buildBrief, brief.bindings);
    }
    const briefSaved = briefOutcome && briefOutcome.outcome !== "unchanged";
    // The normalized brief is rewritten when the save rules say so, and also
    // when the file on disk no longer holds the re-derived material (an edit
    // made to the normalized brief itself, which its source does not carry).
    const briefWritten = Boolean(brief) && (briefSaved || !sameBriefMaterial(brief.bindings.material, currentBrief));
    const newBrief = brief ? brief.bindings.material : currentBrief;
    const saved = briefSaved
      ? briefSaveArtifacts({ context, report, buildBrief: brief.buildBrief, bindings: brief.bindings, targetRepo })
      : { nextContext: context, nextReport: report };
    const labels = new Map(activeSpecPages(spec).map((page) => [page.id, page.label || null]));
    const nextContext = {
      ...saved.nextContext,
      spec: {
        ...saved.nextContext.spec,
        hash: rawHash,
        material_hash: material,
        active_pages: saved.nextContext.spec.active_pages.map((page) => ({ ...page, label: labels.has(page.id) ? labels.get(page.id) : page.label ?? null })),
      },
    };
    let nextReport = { ...saved.nextReport, identity: { ...saved.nextReport.identity, spec_hash: rawHash, spec_material_hash: material } };
    // A stage is owed on the spec unless its spec stamp already equals the
    // new material (a build recorded after the edit has recorded the change
    // itself); a completed stage with no spec stamp is owed on it too. It is
    // owed on a brief partition it depends on when the save rules invalidate
    // that partition, or when its stamp of that partition differs from the
    // re-derived brief. The spec reason wins where both apply.
    const briefCauses = briefOutcome?.outcome === "saved_with_invalidation" ? briefOutcome.causes : [];
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
    reason = changeReason(allCauses);
    const briefNote = briefSaved
      ? `; brief re-derived (${briefOutcome.outcome})`
      : briefWritten ? "; normalized brief re-derived from its source" : "";
    nextReport.evidence = [
      ...(Array.isArray(report.evidence) ? report.evidence : []),
      `${timestamp} record spec: CampaignSpec material ${specChanged ? `${boundMaterial || "(none bound)"} -> ${material}` : `${material} already bound`}${briefNote}; ${demoted.length ? `${demoted.join(", ")} owed again` : "no recorded stage was demoted"}${reason ? ` (${reason})` : ""}.`,
    ];
    writes.push(...(briefWritten ? [normalizedPath] : []), contextPath, reportPath);
    if (!dryRun) {
      // Intake's publication order, the report last: a failure between files
      // leaves the report bound to the old spec material, which reads as owed.
      if (briefWritten) writeJsonAtomic(normalizedPath, brief.buildBrief.artifact);
      writeJsonAtomic(contextPath, nextContext);
      commitAssemblyReport(workspace, () => nextReport, {
        command: "record spec",
        staleReason: "The CampaignSpec was bound with record spec after this doctor snapshot. Re-run doctor (or next) for current state.",
      });
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
    ...(reason ? { input_change: { reason, at: timestamp } } : {}),
    notices,
    note: outcome === "unchanged"
      ? "The CampaignSpec material is the one bound and no stage's stamp is owed; nothing was written."
      : dryRun
        ? "Dry run: every check passed and nothing was written. Re-run without --dry-run to bind the spec."
        : `Bound. Run ${cmd("next")} --packet <packet> for the next stage.`,
  };
}
