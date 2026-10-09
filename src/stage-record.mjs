// `campaigns-os record <setup|build|polish|theme|deploy>`: record a stage's
// completion (or, for theme, an applied brand layer) on the Build Context and
// Assembly Report through one validated command instead of hand-edited JSON.
//
// Every value a record stamps is read from the doctor result the `next` ladder
// itself reads (doctorPacket over the same packet and sidecars), so a record
// can never carry a fingerprint doctor did not compute. The packet is read
// once to name the target lock; under the lock it is re-read and re-checked
// with the report binding, the report, the Build Context and doctor's result,
// and the record is composed on that report, validated against the existing
// schemas and doctor's own report checks, and refused whole (nothing written)
// when any of those fails. --dry-run takes the same path, without the lock,
// and writes nothing.
//
// The Build Context holds setup state only (`scaffold`); build and polish
// completion live on the Assembly Report alone, so `record build` and `record
// polish` validate the context they read but write only the report. `record
// theme` writes `report.theme` only after reading, in each built commerce
// page, that a brand layer stylesheet is linked after next-core.css. `record
// deploy` records a served deploy: the packet's deploy.preview_url and
// stages.deploy, after every built page answers on the served URL (loopback
// for a local-serve packet; https for a hosted one, whose served scripts and
// stylesheets must also match the built output byte for byte).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { BRAND_LAYER_FILENAMES } from "./brand-theme.mjs";
import { ADAPTER_DECISION_SCALAR_VALUES } from "./adapter-decision-contract.mjs";
import { computeBuildFingerprint, resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { resolveCampaignWorkspace, targetRepoFor } from "./campaign-workspace.mjs";
import { isObject, optionalString, portableArtifactPaths, readJsonIfExists, requireArg } from "./cli-helpers.mjs";
import { LOCAL_PROOF_BUILD_ENVIRONMENT, LOCAL_PROOF_PRODUCTION_ENVIRONMENT, isLocalServePacket } from "./local-proof.mjs";
import { polishCarriedForwardForLadder } from "./local-preview-policy.mjs";
import { isLoopbackHostname } from "./remit.mjs";
import { campaignRouteRoot } from "./route-identity.mjs";
import { writeJsonAtomic } from "./doctor-sidecar.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { validateAssemblyReport } from "./doctor/checks.mjs";
import { cmd } from "./install-invocation.mjs";
import { refused } from "./lifecycle.mjs";
import { NEXT_STAGE_ORDER, reportKeyForCliStage, stageIsTerminal } from "./orchestration-stage-contract.mjs";
import {
  POLISH_GATE_REQUIRED_EVIDENCE,
  POLISH_PRODUCER,
  currentSourcePackageMaterialFingerprint,
  evaluatePolishGate,
} from "./polish-gate.mjs";
import { evaluateRecordedHiddenEagerMediaCheckpoint } from "./polish-node.mjs";
import { effectiveStageStatus, effectiveStatusIsTerminal, inputStamps, stageWriteInputs } from "./input-currency.mjs";
import { demoteStages, recordBrief, recordSpec } from "./input-refresh.mjs";
import { applyDerivedAssemblyReportSummary, archiveStageRecord, archiveSupersededRecord, assemblyReportMatchesPacket, commitAssemblyReport, inputChangeFor } from "./stage-ledger.mjs";
import { withTargetLockSync } from "./target-lock.mjs";
import { commerceScopeFromScope } from "./theme-gate.mjs";

export const RECORD_STAGES = Object.freeze(["setup", "build", "polish", "theme", "deploy"]);

// Every flag `record` reads, plus the three any command accepts (run id,
// lifecycle journal, and the deviation reason the deviation notice asks
// agents to declare). Anything else is refused before a file is read.
const RECORD_FLAGS = Object.freeze(["packet", "context", "report", "dry-run", "json", "run-id", "lifecycle-journal", "deviation-reason"]);
const POLISH_RECORD_FLAGS = Object.freeze(["evidence"]);
const DEPLOY_RECORD_FLAGS = Object.freeze(["base-url"]);
const BUILD_RECORD_FLAGS = Object.freeze(["build-environment", "adapter-decision"]);
// `record brief` saves a brief file: --brief names it (otherwise intake's
// discovery finds it).
const BRIEF_RECORD_FLAGS = Object.freeze(["brief"]);
// `record spec` binds the CampaignSpec as it is now; it takes no extra flag.
const RECORD_SUBCOMMANDS = Object.freeze([...RECORD_STAGES, "brief", "spec"]);
// The page-kit environment the built output was rendered in, recorded on
// stages.assembly.evidence.build_environment (local proof mode builds in
// development; doctor and page-kit parity read it).
export const BUILD_ENVIRONMENTS = Object.freeze([LOCAL_PROOF_BUILD_ENVIRONMENT, LOCAL_PROOF_PRODUCTION_ENVIRONMENT]);

// The keys a --evidence file may carry. `evidence` is stages.polish.evidence;
// `repair_loop_defect` is report.theme.repair_loop_defect; `blockers` (status
// blocked) and `skip_reason` (status skipped) land on stages.polish.
const POLISH_EVIDENCE_FILE_KEYS = Object.freeze(["status", "evidence", "repair_loop_defect", "blockers", "skip_reason"]);
const POLISH_COMPLETED_STATUSES = Object.freeze(["completed", "completed_with_warnings"]);
const POLISH_RECORD_STATUSES = Object.freeze([...POLISH_COMPLETED_STATUSES, "blocked", "skipped"]);

const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));
const validators = new Map();
function schemaValidator(file) {
  if (!validators.has(file)) {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    validators.set(file, ajv.compile(JSON.parse(readFileSync(resolve(SCHEMA_DIR, file), "utf8"))));
  }
  return validators.get(file);
}

// The value at an Ajv instancePath (JSON Pointer) in the validated document.
function valueAt(document, pointer) {
  return pointer.split("/").slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, key) => (node == null ? undefined : node[key]), document);
}

// Ajv's instancePath (`/theme/repair_loop_defect`) as the dotted field name
// the rest of the toolkit prints (`theme.repair_loop_defect`).
function schemaProblems(file, value, label) {
  const validate = schemaValidator(file);
  if (validate(value)) return [];
  const seen = new Set();
  const problems = [];
  for (const error of validate.errors || []) {
    const field = error.instancePath.split("/").filter(Boolean).join(".") || "(root)";
    // Ajv's enum message names no values; the allowed list is the remedy.
    const allowed = error.keyword === "enum" && Array.isArray(error.params?.allowedValues)
      ? `: ${error.params.allowedValues.map((allowedValue) => JSON.stringify(allowedValue)).join(", ")} (got ${JSON.stringify(valueAt(value, error.instancePath))})`
      : "";
    const line = `${label} ${field} ${error.message}${allowed}`;
    if (seen.has(line)) continue;
    seen.add(line);
    problems.push(line);
  }
  return problems;
}

function typeName(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

// visual_review keys only `polish capture` writes. `record polish --evidence`
// refuses them by name and carries the captured values forward.
export const PACKAGE_OWNED_VISUAL_REVIEW_KEYS = Object.freeze(["page_load", "media_weight", "readability"]);
export const PACKAGE_OWNED_KEY_REFUSAL = "package_owned_key";

export function refuseRecord(stage, problems) {
  return new Error(`record ${stage} refused; nothing was written:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
}

function parseAdapterDecisions(value) {
  const allowedKeys = Object.keys(ADAPTER_DECISION_SCALAR_VALUES).join(", ");
  const reject = (reason, key = null) => {
    const allowedValues = key && Object.hasOwn(ADAPTER_DECISION_SCALAR_VALUES, key)
      ? ` Allowed values for ${key}: ${ADAPTER_DECISION_SCALAR_VALUES[key].join(", ")}.`
      : "";
    throw refused(`${reason} Allowed keys: ${allowedKeys}.${allowedValues}`);
  };
  if (typeof value !== "string" || !value) reject("--adapter-decision requires a comma-separated list of key=value pairs.");
  const decisions = {};
  for (const pair of value.split(",")) {
    if (!pair) reject("--adapter-decision has an empty pair; use key=value pairs separated by commas.");
    const equal = pair.indexOf("=");
    if (equal < 0) reject(`--adapter-decision pair ${JSON.stringify(pair)} must be key=value.`);
    const key = pair.slice(0, equal);
    const choice = pair.slice(equal + 1);
    if (!key || /\s/.test(key)) reject(`--adapter-decision key ${JSON.stringify(key)} must be a nonempty key without whitespace.`);
    if (key === "wrapper_policy") reject("wrapper_policy is selected at intake with prepare-build --wrapper-policy or the source-html manifest's wrapper_policy option; record build cannot change it.");
    if (!Object.hasOwn(ADAPTER_DECISION_SCALAR_VALUES, key)) reject(`Unknown --adapter-decision key ${JSON.stringify(key)}.`);
    if (Object.hasOwn(decisions, key)) reject(`Duplicate --adapter-decision key ${JSON.stringify(key)} in one list.`);
    const allowed = ADAPTER_DECISION_SCALAR_VALUES[key];
    if (!choice || /\s/.test(choice) || choice.includes("=") || !allowed.includes(choice)) {
      reject(`--adapter-decision ${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(choice)}).`, key);
    }
    decisions[key] = choice;
  }
  return decisions;
}

export function parseRecordArgs(args) {
  const stage = args._[1];
  // The shared argv parser leaves an explicit empty value in positional args.
  if (stage === "build" && args["adapter-decision"] === true && args._.length === 3 && args._[2] === "") {
    parseAdapterDecisions("");
  }
  if (!RECORD_SUBCOMMANDS.includes(stage) || args._.length !== 2) {
    throw refused(`Use: ${cmd("record")} <${RECORD_SUBCOMMANDS.join("|")}> --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--dry-run] [--json]; record polish also takes --evidence <polish-evidence.json>, record deploy --base-url <served url>, record build [--build-environment <${BUILD_ENVIRONMENTS.join("|")}>] [--adapter-decision <key=value[,key=value...]>], and record brief [--brief <yaml|json>].`);
  }
  const known = new Set([...RECORD_FLAGS, ...(stage === "polish" ? POLISH_RECORD_FLAGS : []), ...(stage === "deploy" ? DEPLOY_RECORD_FLAGS : []), ...(stage === "build" ? BUILD_RECORD_FLAGS : []), ...(stage === "brief" ? BRIEF_RECORD_FLAGS : [])]);
  const unknown = Object.keys(args).filter((key) => key !== "_" && !known.has(key));
  if (unknown.length) {
    throw refused(`Unknown flag${unknown.length > 1 ? "s" : ""} for record ${stage}: ${unknown.map((key) => `--${key}`).join(", ")}. Known flags: ${[...known].map((key) => `--${key}`).join(", ")}.`);
  }
  for (const flag of ["context", "report", "run-id", "lifecycle-journal", "deviation-reason", "brief"]) {
    if (Object.hasOwn(args, flag)) requireArg(args, flag);
  }
  if (Object.hasOwn(args, "dry-run") && args["dry-run"] !== true) {
    throw refused(`--dry-run takes no value (got ${JSON.stringify(args["dry-run"])}); write \`--dry-run\` on its own, after the other flags.`);
  }
  if (Object.hasOwn(args, "json") && args.json !== true) throw refused("--json is a boolean flag and takes no value.");
  const buildEnvironment = Object.hasOwn(args, "build-environment") ? args["build-environment"] : null;
  if (buildEnvironment !== null && !BUILD_ENVIRONMENTS.includes(buildEnvironment)) {
    throw refused(`--build-environment must be one of: ${BUILD_ENVIRONMENTS.join(", ")} (got ${JSON.stringify(buildEnvironment)}).`);
  }
  const adapterDecisions = Object.hasOwn(args, "adapter-decision") ? parseAdapterDecisions(args["adapter-decision"]) : null;
  return {
    stage,
    packetPath: resolve(requireArg(args, "packet")),
    evidencePath: stage === "polish" ? resolve(requireArg(args, "evidence")) : null,
    baseUrl: stage === "deploy" ? requireArg(args, "base-url") : null,
    dryRun: args["dry-run"] === true,
    buildEnvironment,
    adapterDecisions,
    briefPath: stage === "brief" && Object.hasOwn(args, "brief") ? resolve(args.brief) : null,
    deviationReason: optionalString(args["deviation-reason"]),
  };
}

// The --evidence file: the polish status, stages.polish.evidence, and the
// optional theme repair-loop defect. Shape errors name the field and the type
// that was given; the polish gate names the fields it still finds incomplete.
export function readPolishEvidenceFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`record polish could not read --evidence ${path}: ${error.message}`);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new Error(`record polish could not parse --evidence ${path} as JSON: ${error.message}`);
  }
  const problems = [];
  if (!isObject(input)) {
    throw refuseRecord("polish", [`--evidence must hold a JSON object with ${POLISH_EVIDENCE_FILE_KEYS.join(", ")} (got ${typeName(input)}).`]);
  }
  for (const key of Object.keys(input)) {
    if (!POLISH_EVIDENCE_FILE_KEYS.includes(key)) problems.push(`--evidence has unknown key "${key}"; accepted keys: ${POLISH_EVIDENCE_FILE_KEYS.join(", ")}.`);
  }
  const status = input.status === undefined ? "completed" : input.status;
  if (!POLISH_RECORD_STATUSES.includes(status)) {
    problems.push(`status must be one of ${POLISH_RECORD_STATUSES.join(", ")} (got ${JSON.stringify(input.status)}).`);
  }
  // A blocked Polish names what blocks it and a skipped one says why; each
  // key belongs to its own status only.
  const blockers = input.blockers;
  if (status === "blocked") {
    if (!Array.isArray(blockers) || !blockers.length || !blockers.every((blocker) => isObject(blocker) && optionalString(blocker.code) && optionalString(blocker.message))) {
      problems.push(`blockers must be a non-empty array of {"code": "...", "message": "..."} objects when status is blocked (got ${typeName(blockers)}).`);
    }
  } else if (blockers !== undefined) {
    problems.push(`blockers is recorded only with status blocked (status is ${JSON.stringify(status)}).`);
  }
  if (status === "skipped") {
    if (!optionalString(input.skip_reason)) problems.push(`skip_reason must be a non-empty string when status is skipped (got ${typeName(input.skip_reason)}).`);
  } else if (input.skip_reason !== undefined) {
    problems.push(`skip_reason is recorded only with status skipped (status is ${JSON.stringify(status)}).`);
  }
  const evidence = input.evidence;
  const evidenceRequired = POLISH_COMPLETED_STATUSES.includes(status);
  if (!isObject(evidence) && (evidenceRequired || evidence !== undefined)) {
    problems.push(`evidence must be an object carrying ${POLISH_GATE_REQUIRED_EVIDENCE.join(", ")} (got ${typeName(evidence)}).`);
  } else if (isObject(evidence)) {
    if (evidence.issues !== undefined && !Array.isArray(evidence.issues)) {
      problems.push(`evidence.issues must be an array ([] when polish found none) (got ${typeName(evidence.issues)}).`);
    }
    if (evidence.commands !== undefined && !Array.isArray(evidence.commands)) {
      problems.push(`evidence.commands must be an array of the commands polish ran (got ${typeName(evidence.commands)}).`);
    }
    if (evidence.visual_review !== undefined && !isObject(evidence.visual_review)) {
      problems.push(`evidence.visual_review must be an object with a screenshots array (got ${typeName(evidence.visual_review)}).`);
    } else if (isObject(evidence.visual_review)) {
      // Package-owned keys are refused by name and listed first, so the
      // refusal leads with its code.
      const owned = PACKAGE_OWNED_VISUAL_REVIEW_KEYS.filter((key) => Object.hasOwn(evidence.visual_review, key));
      if (owned.length) {
        problems.unshift(`${PACKAGE_OWNED_KEY_REFUSAL}: ${owned.map((key) => `evidence.visual_review.${key}`).join(" and ")} ${owned.length === 1 ? "is" : "are"} written only by ${cmd("polish")} capture; remove ${owned.length === 1 ? "it" : "them"} from the file (the captured value on the report is kept).`);
      }
    }
  }
  if (Object.hasOwn(input, "repair_loop_defect") && input.repair_loop_defect !== null && !isObject(input.repair_loop_defect)) {
    problems.push(`repair_loop_defect must be null or an object such as {"code": "...", "message": "..."} (got ${typeName(input.repair_loop_defect)}).`);
  }
  if (problems.length) throw refuseRecord("polish", problems);
  return {
    status,
    evidence: evidence ?? null,
    blockers: status === "blocked" ? blockers : [],
    skipReason: status === "skipped" ? input.skip_reason : null,
    hasRepairLoopDefect: Object.hasOwn(input, "repair_loop_defect"),
    repairLoopDefect: input.repair_loop_defect ?? null,
  };
}

function withoutKeys(object, keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

function stageObject(report, key) {
  return isObject(report?.stages?.[key]) ? report.stages[key] : {};
}

// Each composer returns the next report (a copy) and, for setup, the next
// Build Context, from what doctor computed under the same target lock.
function composeSetup(report, context, { now, recordedBy }) {
  const setup = {
    ...stageObject(report, "setup"),
    stage: "setup",
    status: "completed",
    completed_at: now,
    recorded_by: recordedBy,
    blockers: [],
  };
  const nextReport = { ...report, stages: { ...report.stages, setup } };
  const scaffold = context.scaffold;
  const nextContext = {
    ...context,
    scaffold: {
      ...scaffold,
      required: false,
      mode: scaffold.mode === "blocked" ? "existing" : scaffold.mode,
      handoff_skill: "next-campaigns-build",
      reason: `Setup recorded by ${recordedBy} at ${now}; the campaign output directory exists.`,
    },
  };
  return { report: nextReport, context: nextContext };
}

// The fields a record restates on every write: its input stamps, and the
// operator decision that applies only to the record that carried it.
const STAMP_FIELDS = Object.freeze(["source_brief_material", "source_spec_material_hash"]);
// A replaced record in any of these statuses is checked for an input change.
const REPLACED_COMPLETED_STATUSES = Object.freeze(["completed", "completed_with_warnings", "completed_partial"]);

// The stamps a completed record writes: the inputs current at this write
// (the absent brief value for a packet without a brief). A value that cannot
// be computed is left out, so the record reads unknown rather than current.
function currentStamps(inputs) {
  const stamps = inputStamps(inputs);
  return Object.fromEntries(Object.entries(stamps).filter(([, value]) => value !== null));
}

function composeBuild(report, { now, recordedBy, fingerprint, buildEnvironment = null, adapterDecisions = null, fallbackAdapterDecisions = null, inputs = {}, deviationReason = null }) {
  const nextReport = adapterDecisions ? { ...report, adapter_decisions: { ...(report.adapter_decisions || fallbackAdapterDecisions || {}), ...adapterDecisions } } : report;
  const sourcePackageFingerprint = currentSourcePackageMaterialFingerprint(report);
  const previousAssembly = stageObject(report, "assembly");
  const stamps = currentStamps(inputs);
  // A replaced completed record whose stamps differ from the current inputs
  // records the change now, if nothing recorded it before.
  const writeInputs = stageWriteInputs("assembly", inputs);
  const detected = REPLACED_COMPLETED_STATUSES.includes(previousAssembly.status) ? writeInputs.detectChange(previousAssembly) : null;
  let assembly = {
    ...withoutKeys(previousAssembly, ["source_package_material_fingerprint", "unchanged_output_reason", ...STAMP_FIELDS]),
    ...(buildEnvironment ? { evidence: { ...(isObject(previousAssembly.evidence) ? previousAssembly.evidence : {}), build_environment: buildEnvironment } } : {}),
    stage: "assembly",
    status: "completed",
    build_fingerprint: fingerprint,
    ...(sourcePackageFingerprint ? { source_package_material_fingerprint: sourcePackageFingerprint } : {}),
    ...stamps,
    completed_at: now,
    recorded_by: recordedBy,
    blockers: [],
  };
  if (detected) assembly.input_change = inputChangeFor("assembly", previousAssembly, { at: now, reason: detected });
  // Output identical to the build the input change superseded does not make
  // the build current, unless the operator's --deviation-reason records that
  // the change needs no output change (completed_with_warnings).
  const replayed = isObject(assembly.input_change) && assembly.input_change.superseded_build_fingerprint === fingerprint;
  if (replayed && deviationReason) {
    assembly.status = "completed_with_warnings";
    assembly.unchanged_output_reason = {
      text: deviationReason,
      for_inputs: { brief_material: stamps.source_brief_material ?? null, spec_material_hash: stamps.source_spec_material_hash ?? null },
    };
  }
  if (!replayed || deviationReason) {
    if (writeInputs.stampsCurrent(assembly)) delete assembly.input_change;
  }
  assembly = archiveStageRecord(assembly, previousAssembly, assembly, { by: "record build", reason: detected || "rerecorded", at: now, stageKey: "assembly" });
  // A detected change makes Polish and QA owed through the dependency map.
  // Otherwise Polish evidence bound to this exact output stays and anything
  // else is owed again; the evidence object is kept so `polish capture` has
  // somewhere to attach page_load, and its stale identity fields are removed.
  // A deploy that stamped the build it probed is owed again once the output
  // differs; one with no stamp (recorded before deploy stamped it) is kept.
  const deployOwed = deployAfterBuild(stageObject(report, "deploy"), fingerprint, now);
  const deploy = deployOwed ? { deploy: deployOwed } : {};
  if (detected) {
    const cause = detected === "spec_material_changed" ? "spec" : "presentation";
    const demoted = demoteStages({ ...nextReport, stages: { ...nextReport.stages, assembly, ...deploy } }, { causes: [cause], now, by: "record build", only: ["polish", "qa"] });
    return { report: demoted.report, context: null };
  }
  const previousPolish = stageObject(report, "polish");
  const polishStillCurrent = stageIsTerminal(String(previousPolish.status || ""))
    && optionalString(previousPolish.source_build_fingerprint) === fingerprint;
  const polish = polishStillCurrent
    ? previousPolish
    : {
        ...withoutKeys(previousPolish, ["performed_by", "source_build_fingerprint", "source_package_material_fingerprint", "completed_at", "recorded_by", ...STAMP_FIELDS]),
        stage: "polish",
        status: "required",
        required_by: "build",
        required_for: ["qa"],
      };
  return { report: { ...nextReport, stages: { ...nextReport.stages, assembly, polish, ...deploy } }, context: null };
}

// stages.deploy after a build of `fingerprint`, or null when it is kept: a
// completed deploy whose source_build_fingerprint names other output goes
// whole into history (archived_by "record build", reason_code
// "build_output_changed") and reads required (required_by "build",
// required_for ["qa"]) until record deploy probes this build. As a demotion
// does, the live record loses what was written by the completion (completed_at,
// recorded_by, performed_by) and what describes the old output's probe
// (source_build_fingerprint, evidence, outputs); blockers, warnings, inputs
// and commands are kept.
function deployAfterBuild(previousDeploy, fingerprint, now) {
  const stamped = optionalString(previousDeploy.source_build_fingerprint);
  if (!stamped || stamped === fingerprint || !REPLACED_COMPLETED_STATUSES.includes(previousDeploy.status)) return null;
  const demoted = {
    ...withoutKeys(previousDeploy, ["source_build_fingerprint", "evidence", "outputs", "completed_at", "recorded_by", "performed_by"]),
    stage: "deploy",
    status: "required",
    required_by: "build",
    required_for: ["qa"],
  };
  return archiveSupersededRecord(demoted, previousDeploy, { by: "record build", reason: "build_output_changed", at: now });
}

function composePolish(report, { now, recordedBy, fingerprint, input, inputs = {} }) {
  const previous = stageObject(report, "polish");
  const completed = POLISH_COMPLETED_STATUSES.includes(input.status);
  const writeInputs = stageWriteInputs("polish", inputs);
  const detected = REPLACED_COMPLETED_STATUSES.includes(previous.status) ? writeInputs.detectChange(previous) : null;
  const previousVisual = isObject(previous.evidence?.visual_review) ? previous.evidence.visual_review : {};
  // A blocked or skipped record given no evidence keeps what is there (the
  // capture's bounded evidence stays for diagnosis).
  const evidence = input.evidence
    ? {
        ...input.evidence,
        visual_review: {
          ...input.evidence.visual_review,
          ...Object.fromEntries(PACKAGE_OWNED_VISUAL_REVIEW_KEYS.filter((key) => Object.hasOwn(previousVisual, key)).map((key) => [key, previousVisual[key]])),
        },
      }
    : previous.evidence;
  const sourcePackageFingerprint = currentSourcePackageMaterialFingerprint(report);
  let polish = {
    ...withoutKeys(previous, ["source_package_material_fingerprint", "completed_at", "skip_reason", "evidence", ...STAMP_FIELDS]),
    stage: "polish",
    status: input.status,
    performed_by: POLISH_PRODUCER,
    source_build_fingerprint: fingerprint,
    ...(sourcePackageFingerprint ? { source_package_material_fingerprint: sourcePackageFingerprint } : {}),
    // Only a completed Polish is proof against inputs; a skip or a block
    // carries no stamp.
    ...(completed ? currentStamps(inputs) : {}),
    // A blocked Polish has not completed.
    ...(input.status === "blocked" ? {} : { completed_at: now }),
    recorded_by: recordedBy,
    ...(evidence === undefined ? {} : { evidence }),
    ...(input.skipReason ? { skip_reason: input.skipReason } : {}),
    blockers: input.blockers,
  };
  if (detected) polish.input_change = inputChangeFor("polish", previous, { at: now, reason: detected });
  // The change is cleared only by a completed record stamped with the current
  // inputs whose attached package capture postdates it; any other write
  // (a skip included) carries it.
  if (completed && isObject(polish.input_change) && writeInputs.stampsCurrent(polish)) {
    const capturedAt = polish.evidence?.visual_review?.page_load?.captured_at;
    if (typeof capturedAt === "string" && Date.parse(capturedAt) > Date.parse(polish.input_change.at)) delete polish.input_change;
  }
  polish = archiveStageRecord(polish, previous, polish, { by: "record polish", reason: detected || "rerecorded", at: now, stageKey: "polish" });
  const nextReport = { ...report, stages: { ...report.stages, polish } };
  // A null defect on a report with no theme block says nothing to record.
  if (input.hasRepairLoopDefect && (isObject(report.theme) || input.repairLoopDefect !== null)) {
    if (!isObject(report.theme)) {
      throw refuseRecord("polish", ["repair_loop_defect was given but the report records no theme; omit it, or record the theme first."]);
    }
    nextReport.theme = { ...report.theme, repair_loop_defect: input.repairLoopDefect };
  }
  return { report: nextReport, context: null };
}

// The stylesheet every family's commerce pages load first; the brand layer
// must come after it so its --brand--* values win.
const CORE_STYLESHEET = "next-core.css";

function stylesheetHrefs(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag))
    .map((tag) => (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
}

const hrefName = (href) => href.split(/[?#]/)[0].split("/").pop();
const routeKey = (route) => String(route || "").replace(/^\/+|\/+$/g, "");

// What `record theme` stands on, read from each built commerce page's
// stylesheet links in document order. A page that loads next-core.css renders
// family components, so it must load a brand layer (brand-theme.css or
// checkout-brand.css) after it, and that file must be in the built output. A
// page that loads neither renders the design's own markup and needs no brand
// layer (docs/brand-theme-bridge.md, "Where next-core.css belongs"). Any page
// that breaks the rule is a refusal naming the page.
function brandLayerFacts(doctor) {
  const derived = doctor.derived || {};
  const commerce = commerceScopeFromScope(derived.scope);
  if (!commerce.all.length) {
    throw refuseRecord("theme", ["The campaign ships no commerce pages, so there is no brand layer to record; the theme gate does not apply."]);
  }
  const site = resolveBuiltSiteScope(derived.target_repo, { slug: derived.public_route_slug });
  if (!site.ok) throw refuseRecord("theme", [site.error]);
  const byRoute = new Map(site.pages.map((page) => [routeKey(page.route), page]));
  const byId = new Map(site.pages.map((page) => [page.page_id, page]));
  const problems = [];
  const evidence = [];
  const layers = [];
  const styled = [];
  const unstyled = [];
  for (const page of commerce.built) {
    const label = page.page_id || page.route || page.type;
    const built = byRoute.get(routeKey(page.route)) || byId.get(page.page_id);
    if (!built) {
      problems.push(`${label}: no built page in ${relative(derived.target_repo, site.campaign_dir) || "."}; run the page-kit build, then ${cmd("record")} build.`);
      continue;
    }
    const builtRel = relative(derived.target_repo, built.built_path);
    const hrefs = stylesheetHrefs(readFileSync(built.built_path, "utf8"));
    const core = hrefs.findIndex((href) => hrefName(href) === CORE_STYLESHEET);
    const brand = hrefs.findIndex((href, index) => index > core && BRAND_LAYER_FILENAMES.has(hrefName(href)));
    if (core < 0) {
      if (hrefs.some((href) => BRAND_LAYER_FILENAMES.has(hrefName(href)))) {
        problems.push(`${label}: ${builtRel} links a brand layer but not ${CORE_STYLESHEET}. On a page built from the design's own markup, remove the brand layer; only if the page renders family components, load ${CORE_STYLESHEET} before it.`);
      } else {
        unstyled.push(label);
        evidence.push(`${label}: ${builtRel} loads neither ${CORE_STYLESHEET} nor a brand layer (the design's own markup).`);
      }
      continue;
    }
    if (brand < 0) {
      const early = hrefs.find((href) => BRAND_LAYER_FILENAMES.has(hrefName(href)));
      problems.push(early
        ? `${label}: ${builtRel} links ${early} before ${CORE_STYLESHEET}; list it after ${CORE_STYLESHEET} in the page's frontmatter styles and rebuild.`
        : `${label}: ${builtRel} links no brand layer (${[...BRAND_LAYER_FILENAMES].join(" or ")}) after ${CORE_STYLESHEET}.`);
      continue;
    }
    const href = hrefs[brand].split(/[?#]/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href)) {
      problems.push(`${label}: ${builtRel} loads its brand layer from another origin (${hrefs[brand]}); the brand layer ships with the campaign, so copy it into the campaign assets and link that copy.`);
      continue;
    }
    const file = href.startsWith("/") ? join(site.site_root, href) : resolve(dirname(built.built_path), href);
    if (!existsSync(file)) {
      problems.push(`${label}: ${builtRel} links ${hrefs[brand]}, which is not in the built output.`);
      continue;
    }
    layers.push(file);
    styled.push(label);
    evidence.push(`${label}: ${builtRel} loads ${relative(derived.target_repo, file)} after ${CORE_STYLESHEET}.`);
  }
  if (problems.length) throw refuseRecord("theme", problems);
  if (!styled.length) {
    const outOfScope = commerce.out_of_scope.map((page) => page.page_id || page.route || page.type);
    throw refuseRecord("theme", [!commerce.built.length
      ? `No commerce page is built in this scope (declared but not built: ${outOfScope.join(", ")}); build them, run ${cmd("record")} build, then record theme.`
      : `No built commerce page loads ${CORE_STYLESHEET} (${unstyled.join(", ")}${outOfScope.length ? `; declared but not built: ${outOfScope.join(", ")}` : ""}), so no page renders family components for a brand layer to style. If shipping without one is intended, record that with ${cmd("theme")} waive.`]);
  }
  const cssPath = relative(derived.target_repo, layers[0]);
  const generated = resolve(derived.target_repo, ".campaign-runtime/theme/brand-theme.css");
  if (existsSync(generated)) {
    const same = readFileSync(generated, "utf8") === readFileSync(layers[0], "utf8");
    evidence.push(`${cssPath} ${same ? "matches" : "differs from"} the generated .campaign-runtime/theme/brand-theme.css.`);
  }
  return {
    cssPath,
    commercePages: styled,
    outOfScope: commerce.out_of_scope.map((page) => page.page_id || page.route || page.type),
    evidence,
  };
}

// An applied brand layer replaces any earlier waiver: the gate reads a waiver
// first, and the two answer the same question opposite ways. Other fields
// stay: `warnings` come from theme inspect, and `repair_loop_defect` is what
// `record polish` recorded about the repair loop, history the gate never reads.
function composeTheme(report, { now, recordedBy, layer }) {
  const theme = {
    ...(isObject(report.theme) ? report.theme : {}),
    status: "applied",
    css_path: layer.cssPath,
    load_order: "after-next-core",
    commerce_pages: layer.commercePages,
    evidence: layer.evidence,
    waiver: null,
    recorded_by: recordedBy,
    recorded_at: now,
  };
  return { report: { ...report, theme }, context: null };
}

// The served preview a `record deploy` URL must name, as recorded (origin
// plus the packet's route root, "/<slug>/" or "/" for a root-served
// campaign), and the problems that refuse it. A local-serve packet names a
// loopback http(s) origin. A hosted packet names an https origin unless the
// host is loopback, where http is accepted too.
function deployPreviewUrl(packet, rawUrl) {
  const hosted = !isLocalServePacket(packet);
  if (hosted && !optionalString(packet?.deploy?.target)) {
    return { url: null, hosted, problems: ["This packet records no deploy.target; set it (local-serve, or the hosting target) with " + `${cmd("qa")} policy set --packet <p> --deploy-target <target>.`] };
  }
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { url: null, hosted, problems: [`--base-url ${JSON.stringify(rawUrl)} is not a URL; give the served address, for example ${hosted ? "https://<preview host>/<slug>/" : "http://localhost:<port>/<slug>/"}.`] };
  }
  const problems = [];
  if (!/^https?:$/.test(url.protocol)) problems.push(`--base-url must be http or https (got ${url.protocol}).`);
  else if (!hosted && !isLoopbackHostname(url.hostname)) problems.push(`--base-url ${url.href} is not a loopback address; a local preview (deploy.target local-serve) is served on localhost, 127.0.0.1 or [::1].`);
  else if (hosted && url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) problems.push(`--base-url ${url.href} is plain http; a hosted deploy (deploy.target ${packet.deploy.target}) is recorded over https.`);
  const routeRoot = campaignRouteRoot(packet);
  if (!routeRoot) {
    problems.push("The packet records no campaign.public_route_slug, so the served route root is unknown; record it first.");
  } else if (`/${routeKey(url.pathname.replace(/\/index\.html?$/i, "/"))}/`.replace("//", "/") !== routeRoot) {
    problems.push(`--base-url ${url.href} serves ${url.pathname}, but this campaign's route root is ${routeRoot}; give ${url.origin}${routeRoot}.`);
  }
  return { url: problems.length ? null : `${url.origin}${routeRoot}`, hosted, problems };
}

function scriptSrcs(html) {
  return [...html.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => (match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
}

const sha256Of = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The scripts and stylesheets the built pages load from the preview's own
// origin and the build output holds: each one's served URL, its file under
// _site/ (the host serves _site/ as its origin root) and that file's sha256.
// A reference to another origin, or to a path the build output does not hold,
// is not the build's to compare.
function builtAssets(site, pageUrls) {
  const assets = new Map();
  site.pages.forEach((page, index) => {
    const html = readFileSync(page.built_path, "utf8");
    const pageUrl = new URL(pageUrls[index]);
    for (const ref of [...scriptSrcs(html), ...stylesheetHrefs(html)]) {
      let served;
      try {
        served = new URL(ref, pageUrl);
      } catch {
        continue;
      }
      if (served.origin !== pageUrl.origin) continue;
      served.hash = "";
      let pathname;
      try {
        pathname = decodeURIComponent(served.pathname);
      } catch {
        continue;
      }
      const file = resolve(site.site_root, `.${pathname}`);
      if (!file.startsWith(`${resolve(site.site_root)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) continue;
      if (!assets.has(served.href)) {
        const bytes = readFileSync(file);
        assets.set(served.href, { url: served.href, file, sha256: sha256Of(bytes), size: bytes.byteLength });
      }
    }
  });
  return [...assets.values()];
}

// A file's sha256, or null when it cannot be read (removed, or replaced by a
// directory, since it was listed).
function fileSha256(file) {
  try {
    return sha256Of(readFileSync(file));
  } catch {
    return null;
  }
}

// A served body, read no further than `limit` bytes: a response that says or
// streams more than the built file holds cannot be that file, so the read
// stops there instead of buffering whatever the host sends.
async function readCapped(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.();
    return { bytes: null, error: `Content-Length ${declared} exceeds the built file's ${limit} bytes` };
  }
  const reader = response.body?.getReader?.();
  if (!reader) return { bytes: Buffer.alloc(0) };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { bytes: null, error: `served more than the built file's ${limit} bytes` };
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks) };
}

// One served asset, compared by bytes: it must answer 200, following
// redirects only within the preview's own origin as a page request does.
async function probeAsset(asset, fetchImpl) {
  let current = asset.url;
  try {
    for (let hop = 0; hop <= PROBE_MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const location = response.headers?.get?.("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel?.();
        const next = new URL(location, current);
        if (next.origin !== new URL(asset.url).origin) return { ...asset, served: null, error: `redirects to ${next.href}, off this preview; nothing was requested there` };
        current = next.href;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel?.();
        return { ...asset, served: null, error: `HTTP ${response.status}` };
      }
      const { bytes, error } = await readCapped(response, asset.size);
      return bytes ? { ...asset, served: sha256Of(bytes) } : { ...asset, served: null, error };
    }
    return { ...asset, served: null, error: `more than ${PROBE_MAX_REDIRECTS} redirects` };
  } catch (error) {
    return { ...asset, served: null, error: error?.name === "TimeoutError" ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : String(error?.cause?.code || error?.message || error) };
  }
}

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_REDIRECTS = 3;

// One page request. Redirects are followed only within the preview's own
// origin, so a probe never leaves the machine; a redirect elsewhere is
// reported, not followed.
async function probePage(target, fetchImpl) {
  let current = target;
  try {
    for (let hop = 0; hop <= PROBE_MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await response.body?.cancel();
      const location = response.headers?.get?.("location");
      if (!(response.status >= 300 && response.status < 400) || !location) return { url: target, status: response.status };
      const next = new URL(location, current);
      if (next.origin !== new URL(target).origin) return { url: target, status: null, error: `redirects to ${next.href}, off this preview; nothing was requested there` };
      current = next.href;
    }
    return { url: target, status: null, error: `more than ${PROBE_MAX_REDIRECTS} redirects` };
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : String(error?.cause?.code || error?.message || error);
    // A local static server usually speaks plain http; say so when https fails.
    return { url: target, status: null, error: new URL(target).protocol === "https:" ? `${reason} (over https; a local static server usually serves http)` : reason };
  }
}

/**
 * What only the running server can say, read before the target lock (like
 * the polish --evidence file): the URL names this campaign's served preview,
 * and every built page under it answers (2xx on a local preview, 200 on a
 * hosted one). On a hosted preview every script and stylesheet the built
 * pages load from that origin must also be served byte-identical to the
 * built output; HTML is not compared, since hosts inject markup. The lock
 * re-checks the packet and the built output; the probe is never trusted for
 * either.
 */
export async function probeLocalPreview({ packetPath, baseUrl, fetchImpl = globalThis.fetch }) {
  const packet = readPacketFile("deploy", packetPath);
  const { url, hosted, problems } = deployPreviewUrl(packet, baseUrl);
  if (problems.length) throw refuseRecord("deploy", problems);
  const site = resolveBuiltSiteScope(targetRepoFor(packetPath, packet), { slug: packet.campaign.public_route_slug });
  if (!site.ok) throw refuseRecord("deploy", [site.error]);
  // The built pages, not the bare route root: a funnel often has no index
  // page there, and servers answer that differently (404, a listing).
  const pageUrls = site.pages.map((page) => (routeKey(page.route) ? new URL(`${routeKey(page.route)}/`, url).href : url));
  const targets = [...new Set(pageUrls)];
  // Requested together; the evidence keeps the built pages' order.
  const routes = await Promise.all(targets.map((target) => probePage(target, fetchImpl)));
  const answered = (status) => (hosted ? status === 200 : status >= 200 && status < 300);
  const failed = routes.filter((route) => !answered(route.status));
  if (failed.length) {
    throw refuseRecord("deploy", [
      ...failed.map((route) => `${route.url}: ${route.status ? `HTTP ${route.status}` : route.error}.`),
      hosted
        ? `Deploy the current _site/ build so every page answers HTTP 200 at ${url}, then run ${cmd("record")} deploy again.`
        : `Serve the current _site/ build so every page answers at ${url}, then run ${cmd("record")} deploy again.`,
    ]);
  }
  // The build the probe ran against, so a record build before the lock
  // refuses instead of recording a probe of other output.
  const probedBuild = computeBuildFingerprint(site.campaign_dir);
  const buildFingerprint = probedBuild.ok ? probedBuild.fingerprint : null;
  if (!hosted) return { url, routes, buildFingerprint };
  const assets = await Promise.all(builtAssets(site, pageUrls).map((asset) => probeAsset(asset, fetchImpl)));
  const targetRepo = site.target_repo;
  const differing = assets.filter((asset) => asset.served !== asset.sha256);
  if (differing.length) {
    throw refuseRecord("deploy", [
      ...differing.map((asset) => (asset.served
        ? `${asset.url}: served bytes (${asset.served}) differ from ${relative(targetRepo, asset.file)} (${asset.sha256}).`
        : `${asset.url}: ${asset.error}; ${relative(targetRepo, asset.file)} is in the build output.`)),
      `The preview at ${url} is not serving the recorded build. Deploy the current _site/ build, then run ${cmd("record")} deploy again.`,
    ]);
  }
  return { url, routes, buildFingerprint, assets: assets.map(({ url: assetUrl, file, sha256 }) => ({ url: assetUrl, file, sha256 })) };
}

// A recorded preview (local or hosted): the packet's deploy.preview_url, and stages.deploy
// completed with the URL in outputs (what next reads), the probe as evidence,
// and the build it probed as source_build_fingerprint (doctorFacts has checked
// it equals stages.assembly.build_fingerprint), so a later record build of
// different output makes deploy required again, as it does Polish.
function composeDeploy(report, packet, { now, recordedBy, probe, fingerprint }) {
  const deploy = {
    ...stageObject(report, "deploy"),
    stage: "deploy",
    status: "completed",
    source_build_fingerprint: fingerprint,
    outputs: [probe.url],
    evidence: [
      ...probe.routes.map((route) => `${route.url} answered HTTP ${route.status}`),
      ...(probe.assets || []).map((asset) => `${asset.url} served ${asset.sha256}, as built`),
    ],
    completed_at: now,
    recorded_by: recordedBy,
    blockers: [],
  };
  return {
    report: { ...report, stages: { ...report.stages, deploy } },
    context: null,
    packet: { ...packet, deploy: { ...packet.deploy, preview_url: probe.url } },
  };
}

// Every check a written record must pass, over exactly what would be written.
function validateRecord(stage, { report, context, packet, fingerprint }) {
  const problems = [
    ...schemaProblems("campaign-runtime-assembly-report.v0.schema.json", report, "Assembly Report"),
    ...(context ? schemaProblems("campaign-runtime-build-context.v0.schema.json", context, "Build Context") : []),
  ];
  for (const issue of validateAssemblyReport(report).errors) problems.push(`Assembly Report ${issue.code}: ${issue.message}`);
  if (stage === "polish" && POLISH_COMPLETED_STATUSES.includes(report.stages.polish.status) && !problems.length) {
    // The two gates doctor evaluates over the report it reads, evaluated here
    // over the report this record would write. A blocked or skipped Polish is
    // not a pass the gate could grant; doctor keeps QA blocked on it.
    const hiddenEagerMediaGate = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report });
    const gate = evaluatePolishGate({ report, hiddenEagerMediaGate, currentOutputFingerprint: fingerprint });
    if (gate.status === "blocked") {
      problems.push(`${gate.code}: ${gate.reason}`);
      for (const problem of gate.problems || []) problems.push(problem);
      for (const action of gate.required_actions || []) {
        if (action?.command) problems.push(`required action: ${action.command}${action.description ? ` (${action.description})` : ""}`);
      }
    }
  }
  if (problems.length) throw refuseRecord(stage, problems);
}

// The report must be this packet's before any stage is recorded on it. Two
// checks, both the ones the toolkit already applies: the prepare-build binding
// gate doctor evaluates and `next` consumes (derived.prepare_build_gate; its
// codes are next.prepare_build.context_missing, context_packet_mismatch,
// context_dsp_mismatch, context_report_missing, report_packet_mismatch,
// report_context_mismatch, report_campaign_mismatch and report_dsp_mismatch),
// and the identity match every stage producer requires before it restates an
// outcome into a report (assemblyReportMatchesPacket), which also covers a
// packet with no Design Source Package, where the binding gate is not
// evaluated.
function bindingProblems(doctor, report, packet) {
  const problems = [];
  const gate = doctor.derived?.prepare_build_gate;
  if (gate?.binding_failure === true) {
    for (const issue of gate.issues || []) problems.push(`${issue.code}: ${issue.message}`);
    if (!problems.length) problems.push(gate.reason);
  }
  if (!assemblyReportMatchesPacket(report, packet) && !problems.some((problem) => problem.startsWith("next.prepare_build.report_campaign_mismatch:"))) {
    problems.push("next.prepare_build.report_campaign_mismatch: Assembly Report campaign identity does not match the current Build Packet.");
  }
  if (problems.length) {
    problems.push("Restore or rebind the Build Context and Assembly Report to this Build Packet; a record never lands on another campaign's report.");
  }
  return problems;
}

// The ladder `next` walks (pickNextStage), up to the stage being recorded:
// doctor's prepare-build gate, on which `next` answers prepare-build whenever
// it is set, then every earlier stage terminal by the picker's own predicate.
function ladderProblems(stage, doctor, report) {
  const gate = doctor.derived?.prepare_build_gate;
  if (gate) return [`next answers prepare-build: ${gate.reason}`];
  const problems = [];
  for (const earlier of NEXT_STAGE_ORDER.slice(0, NEXT_STAGE_ORDER.indexOf(stage))) {
    // The same carried-forward rule next's stage picker reads.
    if (earlier === "polish" && polishCarriedForwardForLadder(report, doctor.derived?.polish_gate)) continue;
    // The effective status: a stage owed again by an input change reads
    // required, and one whose inputs cannot be confirmed reads unknown.
    const key = reportKeyForCliStage(earlier);
    const status = String(report.stages[key]?.status || "");
    const effective = effectiveStageStatus(key, report.stages[key], doctor.derived?.input_currency);
    if (!effectiveStatusIsTerminal(effective)) {
      const why = effective === status ? "" : ` (recorded "${status || "(unset)"}"; ${doctor.derived?.input_currency?.reasons?.[key] || "inputs not confirmed"})`;
      problems.push(`stages.${key}.status is "${effective || "(unset)"}"${why}, so next answers ${earlier}; run ${cmd("record")} ${earlier} first.`);
    }
  }
  return problems;
}

// What doctor computed that the record depends on, checked before anything is
// composed: the packet/report binding and the ladder (every stage), the output
// fingerprint (build, polish), the scaffold (setup, build), and the recorded
// build (polish).
function doctorFacts(stage, doctor, report, packet) {
  const derived = doctor.derived || {};
  const binding = bindingProblems(doctor, report, packet);
  if (binding.length) throw refuseRecord(stage, binding);
  // The brand layer is applied to built output, so theme is checked as polish is.
  const ladder = ladderProblems(stage === "theme" ? "polish" : stage, doctor, report);
  if (ladder.length) throw refuseRecord(stage, ladder);
  if (stage === "setup") {
    const outputDir = optionalString(derived.target_output_dir);
    if (!outputDir || !existsSync(outputDir)) {
      throw refuseRecord(stage, [`The campaign output directory ${outputDir || "(unresolved: packet.assembly.target_repo/output_dir)"} does not exist; scaffold it (next-campaigns-os-setup) before recording setup.`]);
    }
    return {};
  }
  const fingerprint = optionalString(derived.build_output_fingerprint?.value);
  if (!fingerprint) {
    const slug = optionalString(derived.public_route_slug) || "<public_route_slug>";
    throw refuseRecord(stage, [`Doctor cannot compute the build output fingerprint: no built output under _site/${slug}/ in the target repo. Run the page-kit build first.`]);
  }
  if (stage === "build" && derived.scaffold_required === true) {
    throw refuseRecord(stage, [`Setup is still required (${derived.scaffold_reason || "Build Context scaffold.required is true"}); run ${cmd("record")} setup first.`]);
  }
  if (stage === "polish" || stage === "theme" || stage === "deploy") {
    const recorded = optionalString(report?.stages?.assembly?.build_fingerprint);
    if (!String(report?.stages?.assembly?.status || "").startsWith("completed") || !recorded) {
      throw refuseRecord(stage, [`Build is not recorded (stages.assembly needs a completed status and build_fingerprint); run ${cmd("record")} build first.`]);
    }
    if (recorded !== fingerprint) {
      throw refuseRecord(stage, [stage === "theme" || stage === "deploy"
        ? `The built output changed since build was recorded (recorded ${recorded}, current ${fingerprint}); run ${cmd("record")} build, then record ${stage} again.`
        : `The built output changed since build was recorded (recorded ${recorded}, current ${fingerprint}); run ${cmd("record")} build, then ${cmd("polish")} capture, then record polish again.`]);
    }
  }
  return {
    fingerprint,
    fingerprintRoot: optionalString(derived.target_repo) && optionalString(derived.build_output_fingerprint?.root)
      ? join(derived.target_repo, derived.build_output_fingerprint.root)
      : null,
  };
}

// The last check before the write: the output doctor fingerprinted is still
// the output on disk. The target lock keeps campaigns-os writers out, but a
// page-kit build does not take it, so the fingerprint is recomputed here with
// doctor's own function over doctor's own root, and a change refuses the
// record instead of stamping a value doctor would then call stale.
function assertOutputUnchanged(stage, facts) {
  if (!facts.fingerprint) return;
  const current = facts.fingerprintRoot ? computeBuildFingerprint(facts.fingerprintRoot) : { ok: false };
  if (!current.ok || current.fingerprint !== facts.fingerprint) {
    throw refuseRecord(stage, [`The built output changed while recording (doctor read ${facts.fingerprint}, now ${current.ok ? current.fingerprint : "no output"}); let the build finish, then run ${cmd("record")} ${stage} again.`]);
  }
}

// Under the lock, the probe is checked against the packet as it is now (it
// could have been retargeted while the probe ran), and the theme gate, which
// blocks deploy, must not be blocked.
function deployFacts(doctor, packet, probe, fingerprint) {
  const { url, problems } = deployPreviewUrl(packet, probe.url);
  if (problems.length) throw refuseRecord("deploy", problems);
  if (url !== probe.url) {
    throw refuseRecord("deploy", [`The packet's route root changed while the preview was probed (probed ${probe.url}, now ${url}); run ${cmd("record")} deploy again.`]);
  }
  // The served assets were compared with the files as they were before the
  // lock; a build since then is a refusal, not a record of other output.
  const rebuilt = (probe.assets || []).filter((asset) => fileSha256(asset.file) !== asset.sha256);
  if (rebuilt.length) {
    throw refuseRecord("deploy", [`The built output changed while the preview was probed (${rebuilt.map((asset) => asset.url).join(", ")}); run ${cmd("record")} build, then record deploy again.`]);
  }
  if (probe.buildFingerprint !== undefined && probe.buildFingerprint !== fingerprint) {
    throw refuseRecord("deploy", [`The built output changed while the preview was probed (probed ${probe.buildFingerprint || "no output"}, now ${fingerprint}); run ${cmd("record")} deploy again.`]);
  }
  const gate = doctor.derived?.theme_gate;
  if (gate?.status === "blocked") {
    throw refuseRecord("deploy", [
      `${gate.code}: ${gate.reason}`,
      ...(gate.required_actions || []).map((action) => `required action: ${action.command || action.description}`),
    ]);
  }
}

/**
 * The `record` command as the CLI runs it: `record deploy` first probes the
 * served preview (asynchronously, before the target lock), then every kind
 * records through recordStageCommand.
 */
export async function recordCommand(args, options = {}) {
  const { stage, packetPath, baseUrl, briefPath, dryRun } = parseRecordArgs(args);
  if (stage === "brief") {
    return recordBrief({
      packetPath,
      briefPath,
      contextPath: args.context ? resolve(args.context) : undefined,
      reportPath: args.report ? resolve(args.report) : undefined,
      dryRun,
    }, options.now ? { now: options.now } : {});
  }
  if (stage === "spec") {
    return recordSpec({
      packetPath,
      contextPath: args.context ? resolve(args.context) : undefined,
      reportPath: args.report ? resolve(args.report) : undefined,
      dryRun,
    }, options.now ? { now: options.now } : {});
  }
  const probe = stage === "deploy" && existsSync(packetPath)
    ? await probeLocalPreview({ packetPath, baseUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })
    : null;
  return recordStageCommand(args, { ...options, probe });
}

function readPacketFile(stage, packetPath) {
  try {
    return JSON.parse(readFileSync(packetPath, "utf8"));
  } catch (error) {
    throw new Error(`record ${stage}: could not read the Build Packet at ${packetPath}: ${error.message}`);
  }
}

/**
 * Run one `record <stage>` invocation. Returns the result object the CLI
 * prints; throws a refusal for bad argv and an Error, before anything is
 * written, for every other reason a record cannot be made.
 *
 * Test seams: `beforeLock` runs after argv and the --evidence file are read
 * and before the target lock is requested; `afterDoctorRead` runs under the
 * target lock, after doctor has read the target and before anything is
 * composed or written.
 */
export function recordStageCommand(args, { now = () => new Date(), beforeLock = null, afterDoctorRead = null, probe = null } = {}) {
  const { stage, packetPath, evidencePath, dryRun, buildEnvironment, adapterDecisions, deviationReason } = parseRecordArgs(args);
  if (!existsSync(packetPath)) throw new Error(`record ${stage}: Build Packet not found at ${packetPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
  if (stage === "deploy" && !probe) throw new Error("record deploy needs the served-route probe; run it through recordCommand.");
  // Operator input, not target state: no campaigns-os writer produces it.
  // For deploy, the probe of the running server (probeLocalPreview).
  const input = stage === "polish" ? readPolishEvidenceFile(evidencePath) : stage === "deploy" ? probe : null;
  const sidecars = {
    contextPath: args.context ? resolve(args.context) : undefined,
    reportPath: args.report ? resolve(args.report) : undefined,
  };
  // The one read before the lock, and only to name the lock: the target repo
  // the packet builds into. Everything the record depends on is read again
  // under it.
  const lockedTarget = targetRepoFor(packetPath, readPacketFile(stage, packetPath));
  if (typeof beforeLock === "function") beforeLock();
  const timestamp = now().toISOString();
  const recordedBy = `campaigns-os record ${stage}`;

  // A dry run writes nothing, so it takes no lock and creates no lock files
  // (the commitAssemblyReport preview convention); it reads in the same order.
  const run = () => recordUnderLock({
    stage, packetPath, sidecars, lockedTarget, input, dryRun, timestamp, recordedBy, afterDoctorRead, buildEnvironment, adapterDecisions, deviationReason,
  });
  const recorded = dryRun ? run() : withTargetLockSync(lockedTarget, run, { command: `record ${stage}` });
  const { composed, facts, layer, reportPath, contextPath, after } = recorded;

  const stageKey = stage === "build" ? "assembly" : stage;
  const writes = [...(composed.context ? [contextPath] : []), ...(composed.packet ? [packetPath] : []), reportPath];
  const ready = stage === "deploy" ? [
    `stages.deploy.status = completed; deploy.preview_url = ${input.url}`,
    ...composed.report.stages.deploy.evidence,
  ] : stage === "theme" ? [
    `theme.status = applied, load_order = after-next-core (${layer.cssPath})`,
    ...layer.evidence,
    ...(layer.outOfScope.length ? [`Not built in this scope, so not checked: ${layer.outOfScope.join(", ")}; run record theme again after building them.`] : []),
  ] : [
    `stages.${stageKey}.status = ${composed.report.stages[stageKey].status}`,
    ...(facts.fingerprint ? [`build output fingerprint ${facts.fingerprint} (doctor derived.build_output_fingerprint.value)`] : []),
    ...(stage === "build" && buildEnvironment ? [`stages.assembly.evidence.build_environment = ${buildEnvironment}`] : []),
    ...(stage === "build" && adapterDecisions ? Object.entries(adapterDecisions).map(([key, value]) => `report.adapter_decisions.${key} = ${value}`) : []),
    ...(stage === "build" ? [`stages.polish.status = ${composed.report.stages.polish.status}`] : []),
    ...(stage === "build" && composed.report.stages.deploy?.required_by === "build" ? [`stages.deploy.status = ${composed.report.stages.deploy.status} (the recorded deploy probed other output; run ${cmd("record")} deploy again)`] : []),
    ...(composed.context ? ["Build Context scaffold.required = false"] : []),
  ];
  return {
    ok: true,
    status: dryRun ? "dry_run" : "recorded",
    action: "record",
    stage,
    dry_run: dryRun,
    report_path: reportPath,
    ...(composed.context ? { context_path: contextPath } : {}),
    ...(dryRun ? { would_write: writes } : { written: writes }),
    build_fingerprint: facts.fingerprint || null,
    record: stage === "theme" ? composed.report.theme : composed.report.stages[stageKey],
    ...(stage === "build" ? { polish: composed.report.stages.polish } : {}),
    ...(composed.context ? { scaffold: composed.context.scaffold } : {}),
    ...(stage === "polish" && input.hasRepairLoopDefect ? { repair_loop_defect: input.repairLoopDefect } : {}),
    ...(after ? { next_stage: after.next?.stage || null, next_stage_reason: after.next?.reason || null } : {}),
    ready,
    note: dryRun
      ? "Dry run: every check passed and nothing was written. Re-run without --dry-run to record."
      : `Recorded. Run ${cmd("next")} --packet <packet> for the next stage.`,
  };
}

// Everything a record reads from the target, in order, all under the target
// lock (except a dry run, which writes nothing): the packet and the Build
// Context's report pointer (the workspace), the report, the Build Context
// (setup), doctor over the same packet and sidecars, the output fingerprint
// re-check, and the post-write doctor read for `next_stage`. No campaigns-os
// writer can rebind, rewrite or republish any of them between the read and
// the write.
// The inputs current at this record, as doctor read them under the lock.
function recordInputs(doctor) {
  const currency = doctor.derived?.input_currency;
  return { briefMaterial: currency?.brief?.current ?? null, specMaterial: currency?.spec?.current ?? null };
}

function recordUnderLock({ stage, packetPath, sidecars, lockedTarget, input, dryRun, timestamp, recordedBy, afterDoctorRead, buildEnvironment = null, adapterDecisions = null, deviationReason = null }) {
  // The same workspace `next` resolves, so the record lands in the report
  // `next` reads now, not the one it read before the lock was free.
  const workspace = resolveCampaignWorkspace(packetPath, { ...sidecars, followContextPointer: true });
  const { packet, contextPath, reportPath } = workspace;
  if (workspace.targetRepo !== lockedTarget) {
    throw refuseRecord(stage, [`The Build Packet was retargeted while this record waited for the target lock (${lockedTarget} is now ${workspace.targetRepo}); run ${cmd("record")} ${stage} again.`]);
  }
  if (!existsSync(reportPath)) throw new Error(`record ${stage}: no Assembly Report at ${reportPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);

  let composed = null;
  let facts = null;
  let layer = null;
  const compose = (report) => {
    if (!isObject(report) || !isObject(report.stages)) throw refuseRecord(stage, [`Assembly Report at ${reportPath} has no stages object.`]);
    const context = stage === "setup" ? readJsonIfExists(contextPath) : null;
    if (stage === "setup" && !isObject(context?.scaffold)) {
      throw new Error(`record setup: no Build Context with a scaffold block at ${contextPath}; run ${cmd("start")} or ${cmd("prepare-build")} first.`);
    }
    // The same doctor call `next` makes, so the record stamps the value
    // doctor computes and refuses whatever binding `next` refuses. Doctor
    // resolves the report binding itself; it must be the report this record
    // is about to write.
    const doctor = doctorPacket(packetPath, sidecars);
    const inspected = optionalString(doctor.derived?.assembly_report_path);
    if (!inspected || resolve(inspected) !== resolve(reportPath)) {
      throw refuseRecord(stage, [`The Build Context rebound the Assembly Report while recording (this record read ${reportPath}, doctor now reads ${inspected || "no report"}); run ${cmd("record")} ${stage} again.`]);
    }
    facts = doctorFacts(stage, doctor, report, packet);
    if (typeof afterDoctorRead === "function") afterDoctorRead();
    if (stage === "theme") layer = brandLayerFacts(doctor);
    if (stage === "deploy") deployFacts(doctor, packet, input, facts.fingerprint);
    const next = stage === "setup"
      ? composeSetup(report, context, { now: timestamp, recordedBy })
      : stage === "build"
        ? composeBuild(report, { now: timestamp, recordedBy, fingerprint: facts.fingerprint, buildEnvironment, adapterDecisions, fallbackAdapterDecisions: adapterDecisions && !report.adapter_decisions ? readJsonIfExists(contextPath)?.adapter_decisions || packet.source_html?.adapter_contract : null, inputs: recordInputs(doctor), deviationReason })
        : stage === "theme"
          ? composeTheme(report, { now: timestamp, recordedBy, layer })
          : stage === "deploy"
            ? composeDeploy(report, packet, { now: timestamp, recordedBy, probe: input, fingerprint: facts.fingerprint })
            : composePolish(report, { now: timestamp, recordedBy, fingerprint: facts.fingerprint, input, inputs: recordInputs(doctor) });
    applyDerivedAssemblyReportSummary(next.report, recordInputs(doctor));
    // The packet's one new value, deploy.preview_url, is checked by
    // deployPreviewUrl; the rest of the packet is as the operator left it.
    validateRecord(stage, { report: next.report, context: next.context, packet, fingerprint: facts.fingerprint });
    assertOutputUnchanged(stage, facts);
    composed = next;
    if (dryRun) return null;
    // Written inside the report's critical section, after every check and
    // before the report itself, so the files move together.
    if (next.context) writeJsonAtomic(contextPath, portableArtifactPaths(next.context, workspace.targetRepo, { artifactPath: contextPath }));
    if (next.packet) writeJsonAtomic(packetPath, portableArtifactPaths(next.packet, workspace.targetRepo, { artifactPath: packetPath }));
    return next.report;
  };
  // Already inside the target lock, which commitAssemblyReport re-enters.
  commitAssemblyReport(workspace, compose, {
    command: `record ${stage}`,
    staleReason: `${stage === "theme" ? "theme" : `stages.${stage === "build" ? "assembly" : stage}`} was recorded after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
    ...(dryRun ? { lock: false } : {}),
  });
  const after = dryRun ? null : doctorPacket(packetPath, sidecars);
  return { composed, facts, layer, reportPath, contextPath, after };
}
