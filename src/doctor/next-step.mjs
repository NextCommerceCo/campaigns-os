// The next step doctor recommends, and the gate issues `next` reads from doctor.
import { campaignIdentitiesMatch } from "../spec-source-identity.mjs";
import { polishCarriedForwardForLadder } from "../local-preview-policy.mjs";
import { resolve } from "node:path";
import { orderPathDepthDriftText } from "../proof-policy.mjs";
import { anyAssemblyReportStageBlocked, qaRecordedBuildFingerprint, qaRecordedForCurrentBuild } from "../stage-ledger.mjs";
import {
  SOURCE_PREP_DOCUMENT_WRAPPER,
  SOURCE_PREP_FRONTMATTER_RESIDUE,
  SOURCE_PREP_INTERNAL_LINK_UNROOTED,
} from "../source-prep.mjs";
import {
  NEXT_STAGE_ORDER,
  NEXT_STAGE_OWNERS,
  reportKeyForCliStage,
  stageIsBlocked,
  stageIsTerminal,
} from "../orchestration-stage-contract.mjs";
import { currentBuildFingerprint, evaluatePolishGate } from "../polish-gate.mjs";
import { effectiveStageStatus, effectiveStatusIsTerminal } from "../input-currency.mjs";
import { cmd } from "../install-invocation.mjs";
import { isObject, isNonEmptyString, optionalString, resolveFromFile, addIssue, filesystemPathsMatch } from "../cli-helpers.mjs";
import { orderPathDepthDrift } from "./checks.mjs";

// The orchestration stage contract lives in orchestration-stage-contract.mjs so
// report producers, validators, the `next` picker and the Assembly Report's
// derived summary share one deterministic source for stage order, terminal
// status prefixes, stage owners and CLI-stage/report-key translation.
const POLISH_GATE_BUILD_RERUN_CODES = Object.freeze(new Set([
  "polish.assembly_source_package_fingerprint_missing",
  "polish.assembly_source_package_stale",
]));


function polishGateRequiresBuild(polishGate) {
  return polishGate?.status === "blocked" && POLISH_GATE_BUILD_RERUN_CODES.has(polishGate.code);
}

// Gate → issue, the one way. Doctor reports a blocked gate under the gate's
// own code — the theme gate as a warning, because its fix happens in build —
// and `next` reports the same gate under `next.<stage>.<code>` as an error
// for the stage it blocks. The polish gates ride on the issue's `detail`, so
// "doctor's only errors are the polish gates" is read back from the issues
// themselves rather than decoded from a code prefix.
export function gateIssue(kind, gate, { stage = null } = {}) {
  const commands = (gate?.required_actions || []).map((action) => action?.command).filter(Boolean);
  const run = commands.length ? ` Run: ${commands.join(" | ")}` : "";
  const requiredAction = commands.length ? ` Required action: ${commands.join(" | ")}.` : "";
  switch (kind) {
    case "theme_gate":
      return stage
        ? { severity: "error", code: `next.${stage}.theme_gate`, message: `${gate.reason}${run}`, detail: { theme_gate: gate } }
        : { severity: "warning", code: gate.code, message: `${gate.reason} Polish/deploy/QA are gated until resolved.${run}`, detail: null };
    case "polish_gate":
      return {
        severity: "error",
        code: stage ? `next.${stage}.${gate.code}` : gate.code,
        message: `${gate.reason}${requiredAction || " Run next-campaigns-polish before QA."}`,
        detail: { polish_gate: gate },
      };
    case "polish_checkpoint_gate":
      return {
        severity: "error",
        code: stage ? `next.${stage}.${gate.code}` : gate.code,
        message: stage ? gate.reason : `${gate.reason}${requiredAction}`,
        detail: { polish_checkpoint_gate: gate },
      };
    default:
      throw new Error(`Unknown gate kind: ${kind}`);
  }
}

function pushGateIssue({ errors, warnings }, issue) {
  addIssue(issue.severity === "error" ? errors : warnings, issue.code, issue.message, issue.detail);
}

// Doctor's errors are only the polish gates' projections: the issues carry
// the gate they came from, so this reads data, not a code prefix.
export function doctorErrorsAreOnlyPolishGate(errors = []) {
  return errors.length > 0 && errors.every((issue) => Boolean(issue?.detail?.polish_gate || issue?.detail?.polish_checkpoint_gate));
}

function reportStageBlockerIssues(reportStage, fallbackCode, fallbackMessage) {
  const blockers = Array.isArray(reportStage?.blockers) ? reportStage.blockers : [];
  if (!blockers.length) return [{ code: fallbackCode, message: fallbackMessage }];
  return blockers.map((blocker) => ({
    code: blocker.code || fallbackCode,
    message: blocker.message || fallbackMessage,
    detail: blocker,
  }));
}

function designSourceReferenceMismatches(expected, expectedArtifactPath, actual, actualArtifactPath) {
  if (!isObject(expected) || !isObject(actual)) return ["reference"];
  const mismatches = [];
  for (const field of ["schema_version", "sha256", "material_fingerprint"]) {
    if (expected[field] !== actual[field]) mismatches.push(field);
  }
  const expectedPath = resolveFromFile(expectedArtifactPath, expected.path);
  const actualPath = resolveFromFile(actualArtifactPath, actual.path);
  if (!filesystemPathsMatch(expectedPath, actualPath)) mismatches.push("path");
  return mismatches;
}

function nextPrepareBuildBindingIssues({
  packet,
  packetPath,
  context,
  contextPath,
  report,
  reportPath,
  targetRepo,
  explicitReport,
}) {
  if (!isObject(packet?.design_source_package)) return [];
  const issues = [];
  const push = (code, message, detail = null) => issues.push({ code, message, detail });

  if (!isObject(context)) {
    push(
      "next.prepare_build.context_missing",
      `Build Context is unavailable at ${contextPath}; the Design Source Package lifecycle report cannot be bound to the current packet.`,
    );
  } else {
    const contextPacketPointer = optionalString(context.packet_path);
    const contextPacketPath = contextPacketPointer ? resolve(targetRepo, contextPacketPointer) : null;
    if (!contextPacketPath || !filesystemPathsMatch(contextPacketPath, packetPath)) {
      push(
        "next.prepare_build.context_packet_mismatch",
        "Build Context packet_path does not identify the current Build Packet; refusing to select a lifecycle report from that context.",
        { expected_packet_path: packetPath, recorded_packet_path: contextPacketPath },
      );
    }

    const contextDspMismatches = designSourceReferenceMismatches(
      packet.design_source_package,
      packetPath,
      context.design_source_package,
      contextPath,
    );
    if (contextDspMismatches.length) {
      push(
        "next.prepare_build.context_dsp_mismatch",
        `Build Context Design Source Package reference does not match the current packet (${contextDspMismatches.join(", ")}).`,
        { mismatched_fields: contextDspMismatches },
      );
    }

    if (!explicitReport && !optionalString(context.report_path)) {
      push(
        "next.prepare_build.context_report_missing",
        "Build Context does not record report_path; packet-only next cannot prove which lifecycle report belongs to this packet.",
      );
    }
  }

  if (!isObject(report)) return issues;

  const reportPacketPointer = optionalString(report.inputs?.packet_path);
  const reportPacketPath = reportPacketPointer ? resolve(targetRepo, reportPacketPointer) : null;
  if (!reportPacketPath || !filesystemPathsMatch(reportPacketPath, packetPath)) {
    push(
      "next.prepare_build.report_packet_mismatch",
      "Assembly Report inputs.packet_path does not identify the current Build Packet.",
      { expected_packet_path: packetPath, recorded_packet_path: reportPacketPath },
    );
  }

  const reportContextPointer = optionalString(report.inputs?.context_path);
  const reportContextPath = reportContextPointer ? resolve(targetRepo, reportContextPointer) : null;
  if (!reportContextPath || !filesystemPathsMatch(reportContextPath, contextPath)) {
    push(
      "next.prepare_build.report_context_mismatch",
      "Assembly Report inputs.context_path does not identify the selected Build Context.",
      { expected_context_path: contextPath, recorded_context_path: reportContextPath },
    );
  }

  const expectedMapId = optionalString(packet.spec?.map_id);
  const expectedSlug = optionalString(packet.campaign?.public_route_slug);
  const recordedMapId = optionalString(report.identity?.map_id);
  const recordedSlug = optionalString(report.identity?.public_route_slug);
  if (!campaignIdentitiesMatch(packet.spec, report.identity) || recordedSlug !== expectedSlug) {
    push(
      "next.prepare_build.report_campaign_mismatch",
      "Assembly Report campaign identity does not match the current Build Packet.",
      {
        // Failed identity fields are diagnostic data, never adopted evidence.
        expected: { map_id: expectedMapId, local_spec_id: packet.spec?.local_spec_id ?? null, public_route_slug: expectedSlug },
        recorded: { map_id: recordedMapId, local_spec_id: report.identity?.local_spec_id ?? null, public_route_slug: recordedSlug },
      },
    );
  }

  const reportDspMismatches = designSourceReferenceMismatches(
    packet.design_source_package,
    packetPath,
    report.design_source_package,
    reportPath,
  );
  const contextDspMismatches = isObject(context)
    ? designSourceReferenceMismatches(
        context.design_source_package,
        contextPath,
        report.design_source_package,
        reportPath,
      )
    : [];
  const dspMismatches = [...new Set([...reportDspMismatches, ...contextDspMismatches])];
  if (dspMismatches.length) {
    push(
      "next.prepare_build.report_dsp_mismatch",
      `Assembly Report Design Source Package reference does not match the current packet/context (${dspMismatches.join(", ")}).`,
      { mismatched_fields: dspMismatches },
    );
  }

  return issues;
}

function uniquePrepareBuildBlockers(blockers) {
  const unique = new Map();
  for (const blocker of blockers) {
    if (!isObject(blocker)) continue;
    // Stage and top-level report lists intentionally mirror blockers. Collapse
    // only complete semantic duplicates: field/detail/index evidence must not
    // disappear merely because the user-facing header is the same.
    const canonicalizeBlocker = (value) => {
      if (Array.isArray(value)) return value.map(canonicalizeBlocker);
      if (!isObject(value)) return value;
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => [key, canonicalizeBlocker(value[key])]),
      );
    };
    const key = JSON.stringify(canonicalizeBlocker(blocker));
    if (!unique.has(key)) unique.set(key, blocker);
  }
  return [...unique.values()];
}

function prepareBuildGateIssue(report, { required = false, reportPath = null, bindingIssues = [] } = {}) {
  const stage = report?.stages?.prepare_build;
  if (bindingIssues.length) {
    return {
      stage,
      status: "mismatched",
      blocked: true,
      binding_failure: true,
      issues: bindingIssues,
      reason: `The selected Build Context or Assembly Report is not bound to the current Build Packet (${bindingIssues.map((issue) => issue.code).join(", ")}); refusing to bypass prepare-build.`,
    };
  }
  if (!stage) {
    if (!required) return null;
    const location = reportPath ? ` at ${reportPath}` : "";
    return {
      stage: null,
      status: "missing",
      blocked: true,
      reason: report
        ? `The lifecycle assembly report${location} does not record stages.prepare_build; continuing would bypass the prepare-build gate.`
        : `The lifecycle assembly report${location} is unavailable; continuing would bypass the prepare-build gate. Restore the recorded report or rerun prepare-build/start before continuing.`,
    };
  }
  const status = String(stage.status || "");
  const stageBlockers = Array.isArray(stage.blockers) ? stage.blockers : [];
  const topLevelDspBlockers = (Array.isArray(report?.blockers) ? report.blockers : [])
    .filter((blocker) => blocker?.code === "DESIGN_SOURCE_PACKAGE_NOT_READY");
  const contradictoryBlockers = uniquePrepareBuildBlockers([...stageBlockers, ...topLevelDspBlockers]);
  // report.status is derived from the stages on every write, so a report that
  // has been through commitAssemblyReport reads "blocked" if and only if some
  // stage is blocked, and a blocked QA or doctor stage beside a terminal
  // prepare_build is not a contradiction. The case below can only be a report
  // written before the summary was derived (or hand-edited since): a
  // top-level "blocked" that no recorded stage explains. It is still a
  // contradiction to refuse on, and the next commit of the report heals it.
  const blockedStatusFromPreDerivationReport = report?.status === "blocked" && !anyAssemblyReportStageBlocked(report);
  if (stageIsTerminal(status) && (
    blockedStatusFromPreDerivationReport
    || stageBlockers.length > 0
    || topLevelDspBlockers.length > 0
  )) {
    const contradictions = [
      ...(blockedStatusFromPreDerivationReport ? ["report.status=blocked"] : []),
      ...(stageBlockers.length ? [`stages.prepare_build.blockers=${stageBlockers.length}`] : []),
      ...(topLevelDspBlockers.length ? [`top-level DSP blockers=${topLevelDspBlockers.length}`] : []),
    ];
    return {
      stage,
      status,
      blocked: true,
      blockers: contradictoryBlockers,
      reason: `Stage "prepare_build" claims terminal status "${status}" but retained blocking evidence contradicts it (${contradictions.join(", ")}); resolve the report before continuing.`,
    };
  }
  if (stageIsTerminal(status)) return null;
  return {
    stage,
    status,
    blocked: stageIsBlocked(status),
    reason: stageIsBlocked(status)
      ? `Stage "prepare_build" is blocked (status="${status}"); resolve prepare-build blockers before continuing.`
      : `Stage "prepare_build" has status "${status || "(unset)"}"; rerun prepare-build before continuing.`,
  };
}

function addPrepareBuildGateErrors(errors, report, gate = prepareBuildGateIssue(report)) {
  if (!gate) return false;
  // Doctor's own checks run BEFORE this gate merges in the recorded
  // prepare-build blockers: doctorPacket calls validatePacket/runDoctorChecks
  // first and then surfaces the gate, and nextStage seeds its error list from
  // doctor.errors before calling this (doctor and the ladder agree, #238).
  // Two dedup keys keep the merged list from reporting one problem twice:
  // an exact [code, message, detail] match drops a blocker doctor already
  // surfaced verbatim, and a page-level match drops a MISSING_SOURCE_PAGE
  // blocker when the source-coverage check already named the same missing
  // page under its own code (source_html.pages.coverage).
  const seen = new Set(errors.map((issue) => JSON.stringify([issue.code, issue.message, issue.detail ?? null])));
  const coveredPageIds = new Set(
    errors
      .filter((issue) => issue.code === "source_html.pages.coverage")
      .map((issue) => issue.detail?.page_id)
      .filter(isNonEmptyString),
  );
  const addUnique = (code, message, detail) => {
    const key = JSON.stringify([code, message, detail ?? null]);
    if (seen.has(key)) return;
    if (code === "MISSING_SOURCE_PAGE" && isNonEmptyString(detail?.page_id) && coveredPageIds.has(detail.page_id)) return;
    seen.add(key);
    addIssue(errors, code, message, detail);
  };
  if (Array.isArray(gate.issues) && gate.issues.length) {
    for (const issue of gate.issues) addUnique(issue.code, issue.message, issue.detail || null);
    return true;
  }
  const blockerSource = Array.isArray(gate.blockers) && gate.blockers.length
    ? { blockers: gate.blockers }
    : gate.stage;
  for (const issue of reportStageBlockerIssues(
    blockerSource,
    gate.stage ? "next.prepare_build" : "next.prepare_build.report_unavailable",
    gate.reason,
  )) {
    addUnique(issue.code, issue.message, issue.detail || null);
  }
  return true;
}

// Declared order-path depths that ask for no purchase at all. A packet may
// legitimately declare one: `--test-order off` diagnostics stay intentional.
const ORDER_PATH_DEPTHS_WITHOUT_PURCHASE = new Set(["off", "none", "skip", "not_required", "unspecified"]);

export function assessPurchaseProofCoverage({ packet = null, report = null } = {}) {
  const packetDepth = optionalString(packet?.qa?.proof_policy?.order_path_depth);
  const reportDepth = optionalString(report?.proof_policy?.order_path_depth);
  // The packet is author intent and the report is the assembly-time echo of it,
  // so the packet wins — but only when the two actually agree. A hand-edit or a
  // stale report mirror can leave them disagreeing, and silently preferring the
  // packet then lets a corrupted pair decide the gate. Neither value is
  // trustworthy in that state, so the coverage is genuinely unknown: advisory,
  // never a silent unblock, and named loudly enough that an operator can see
  // which two artifacts to reconcile.
  const drift = orderPathDepthDrift(packet, report);
  if (drift) {
    return {
      state: "unknown",
      // Neither side is trustworthy, so there is no single declared depth to
      // report; both values are exposed structurally so a consumer never has
      // to parse the reason to learn that the two artifacts disagree.
      declared_depth: null,
      declared_depths: { packet: drift.packet, report: drift.report },
      // The reason names the one command that reconciles them (the same text
      // doctor's warning carries); the packet path is substituted by `next`.
      reason: orderPathDepthDriftText({ packetDepth: drift.packet, reportDepth: drift.report }),
    };
  }
  const declared = packetDepth || reportDepth;
  const declaredDepths = { packet: packetDepth || null, report: reportDepth || null };
  if (!declared || ORDER_PATH_DEPTHS_WITHOUT_PURCHASE.has(declared.toLowerCase())) {
    return {
      state: "not_required",
      declared_depth: declared || null,
      declared_depths: declaredDepths,
      reason: "No order-path depth is declared, so no purchase proof is owed.",
    };
  }
  const summary = report?.stages?.qa?.purchase_proof;
  if (!isObject(summary) || !Number.isInteger(summary.order_paths_executed)) {
    return {
      state: "unknown",
      declared_depth: declared,
      declared_depths: declaredDepths,
      reason: "The assembly report's qa stage records no purchase-proof summary, so the depth QA exercised cannot be read from it.",
    };
  }
  if (summary.order_paths_executed > 0) {
    return {
      state: "satisfied",
      declared_depth: declared,
      declared_depths: declaredDepths,
      reason: `QA executed ${summary.order_paths_executed} order path(s) against a declared "${declared}" depth.`,
    };
  }
  return {
    state: "unmet",
    declared_depth: declared,
    declared_depths: declaredDepths,
    reason: `QA recorded zero executed order paths, so a declared "${declared}" order-path depth is not proved. A \`--test-order off\` run is a diagnostic, not purchase proof; re-run QA at the declared depth or change the declared depth deliberately.`,
  };
}

function pickNextStage(report, { errors = [], derived = null }, prepareBuildGate, purchaseProof = null) {
  const polishGate = derived?.polish_gate || evaluatePolishGate({ report });
  const polishCheckpointGate = derived?.polish_checkpoint_gate || null;
  // prepare-build is the earliest lifecycle prerequisite. Surface its
  // authoritative blockers before later doctor findings so a blocked Design
  // Source Package can never be mistaken for permission to enter setup/build.
  if (prepareBuildGate) {
    return {
      stage: "prepare-build",
      reason: prepareBuildGate.reason,
      blocked: true,
    };
  }

  if (errors.length && !doctorErrorsAreOnlyPolishGate(errors)) {
    return {
      stage: "doctor-blocked",
      reason: `Doctor reported ${errors.length} blocker(s); resolve them before any stage runs.`,
    };
  }

  if (!report || !report.stages) {
    return {
      stage: "setup",
      reason: "No assembly report on disk yet. Start with setup (assembly report should appear after prepare-build).",
    };
  }

  // A build made against earlier brief or CampaignSpec content, or one whose
  // inputs cannot be confirmed, is owed before anything downstream of it.
  const inputCurrency = derived?.input_currency || null;
  if (["owed", "unknown"].includes(inputCurrency?.stages?.assembly)) {
    return {
      stage: "build",
      reason: inputCurrency.reasons?.assembly || "input_binding_unknown",
    };
  }

  if (polishGate.status === "blocked") {
    if (polishGateRequiresBuild(polishGate)) {
      return {
        stage: "build",
        reason: polishGate.reason,
      };
    }
    return {
      stage: "polish",
      reason: polishGate.reason,
      blocked: true,
    };
  }

  if (polishCheckpointGate?.status === "blocked") {
    return {
      stage: "polish",
      reason: polishCheckpointGate.reason,
      blocked: true,
    };
  }

  for (const cliStage of NEXT_STAGE_ORDER) {
    // A first local preview may carry missing Polish forward. A theme waiver
    // or prior capture makes the recorded Polish stage owed again.
    if (cliStage === "polish" && polishCarriedForwardForLadder(report, polishGate)) continue;
    const reportKey = reportKeyForCliStage(cliStage);
    const stage = report.stages[reportKey];
    if (!stage) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is not recorded in the assembly report; run "${cliStage}" next.`,
      };
    }
    // The effective status: a stage owed again by an input change reads
    // required, and one whose inputs or raw status cannot be read, unknown.
    const status = effectiveStageStatus(reportKey, stage, inputCurrency);
    if (stageIsBlocked(status)) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is blocked (status="${status}"); unblock before continuing.`,
        blocked: true,
      };
    }
    if (!effectiveStatusIsTerminal(status)) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" has status "${status || "(unset)"}"; run "${cliStage}" next.`,
      };
    }
    if (cliStage === "qa" && qaRecordedBuildFingerprint(report) && currentBuildFingerprint(report)
      && !qaRecordedForCurrentBuild(report, currentBuildFingerprint(report))) {
      return { stage: "qa", reason: "QA was recorded for a different build; run QA against the current build." };
    }
    // A terminal QA status is not the same claim as purchase proof. QA finalizes
    // a verdict and records a terminal status even when no order path ran, so a
    // `--test-order off` diagnostic used to carry the pipeline to "done" against
    // a packet declaring common depth. Only an EXPLICIT zero blocks: an absent
    // summary is unknown and stays advisory.
    if (cliStage === "qa" && purchaseProof?.state === "unmet") {
      return {
        stage: "qa",
        reason: purchaseProof.reason,
      };
    }
  }

  return {
    stage: "done",
    reason: "All stages are in a terminal status (completed / completed_with_warnings / skipped). Pipeline is complete.",
  };
}

// Packet 03 (INV-5 first slice): the deploy-output URL scan that
// buildNextStep's deploySatisfied has always used, extracted so
// detectLedgerDivergence reads the exact same artifact signal instead of
// growing a second, slightly different scan.
function deployUrlFromReportOutputs(report) {
  for (const output of report?.stages?.deploy?.outputs || []) {
    if (/^https?:\/\//.test(String(output))) return String(output);
  }
  return null;
}

function checkpointExceptionPresent(derived) {
  return (Array.isArray(derived?.checkpoint_gates)
      && derived.checkpoint_gates.some((gate) => gate?.status === "waived"))
    || derived?.polish_checkpoint_gate?.status === "waived";
}

function readinessStatus(warnings, derived) {
  if (checkpointExceptionPresent(derived)) return "ready_with_waivers";
  return warnings.length ? "ready_with_warnings" : "ready";
}

// The source-preparation action names only the repairs the findings ask for.
// A document-wrapper finding reported as a warning is the accepted
// preserve_document_wrappers adapter decision (src/source-prep.mjs decides
// the severity from the packet's wrapper_policy); ordering a wrapper strip
// there would undo the decision that cleared the gate, so the strip step is
// offered only when the finding is an error.
function sourcePreparationAction(errors, warnings) {
  const errorCodes = new Set(errors.map((issue) => issue.code));
  const warningCodes = new Set(warnings.map((issue) => issue.code));
  const present = (code) => errorCodes.has(code) || warningCodes.has(code);
  const steps = [];
  if (errorCodes.has(SOURCE_PREP_DOCUMENT_WRAPPER)) steps.push("strip document wrappers");
  if (present(SOURCE_PREP_FRONTMATTER_RESIDUE)) steps.push("repair leftover frontmatter");
  if (present(SOURCE_PREP_INTERNAL_LINK_UNROOTED)) steps.push("route internal links through campaign_link/CampaignSpec routes");
  if (!steps.length) return null;
  const listed = steps.length === 1 ? steps[0] : `${steps.slice(0, -1).join(", ")}, and ${steps[steps.length - 1]}`;
  return `Prepare the mapped source HTML for page-kit ingestion — ${listed} (docs/quickstart.md "Prepare Raw HTML Source") — then rerun ${cmd("doctor")}.`;
}

// Owner and skill for each stage the picker can name. The doctor's `next`
// block is a projection of the same picker the `next` command runs
// (pickNextStage), so the two can no longer disagree about which stage comes
// next: doctor used to carry its own decider with its own vocabulary
// (collect-inputs / assembly / complete) and its own gating, which knew
// neither purchase proof nor the prepare-build gate, and listed the stage it
// recommended inside blocked_stages. The table itself lives on the stage
// contract so the Assembly Report's derived `next` spells owners the same way.
export const DOCTOR_NEXT_STAGE_OWNERS = NEXT_STAGE_OWNERS;

// The code -> action strings doctor prints under `Next:`. They describe the
// repairs the findings ask for and are independent of which stage the picker
// names, so they survive the picker consolidation unchanged.
function doctorNextActions(errors, warnings, derived, { polishBlocked, polishGate, polishCheckpointGate, packetRef = derived.packet_path || "<packet>" }) {
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const onlyPolishErrors = doctorErrorsAreOnlyPolishGate(errors);
  const actions = [];
  if (errors.length && !onlyPolishErrors) {
    actions.push("Resolve packet blockers before assembly.");
  }
  if (codes.has("assembly.template_lock")) actions.push("Lock a template family before commerce wiring.");
  if (codes.has("spec.page_url_html_extension")) {
    actions.push("Update CampaignSpec page_url values to Page Kit public routes such as landing/ or checkout/, not source filenames like landing.html.");
  }
  if (codes.has("spec.route_collision")) {
    actions.push("Fix Campaign Map page_url values so every active page resolves to a unique Page Kit route.");
  }
  if (codes.has("frontmatter.demoOnlyValues") || codes.has("frontmatter.replaceFromSpecOrApi")) {
    actions.push("Use the template agentContract to replace demo values from CampaignSpec/API.");
  }
  if (codes.has("template_contract.brand_contract") || codes.has("template_contract.family_inventory")) {
    actions.push(`Add or repair the selected family's contracts/template-brand-contract.<family>.v0.json, then rerun ${cmd("doctor")} --packet <packet>.`);
  }
  if (codes.has("template_contract.exit_pop") || codes.has("template_contract.exit_pop_residue") || codes.has("template_contract.exit_pop_blank_widget")) {
    actions.push("Strip the default exit-pop widget or wire CampaignSpec checkout exit_intent/promo_code_input to the SDK coupon path before QA.");
  }
  if (codes.has("template_contract.discount_claim_unverified")) {
    actions.push("Confirm any rendered promo discount percentage claims against the build request, merchant notes, or CampaignSpec before launch.");
  }
  if (codes.has("template_contract.placeholder_text_residue")) {
    actions.push("Replace literal template placeholder text (Lorem/Placeholder/TODO/Product Name/Benefit one…four) with CampaignSpec/design copy before QA; the browser residue gate blocks on these terms.");
  }
  if (codes.has("template_contract.demo_asset_residue")) {
    actions.push("Re-skin template demo placeholder assets (spacer SVGs, repeated benefit icons, starter imagery) to the campaign's real assets before launch.");
  }
  if (codes.has("content_residue.needs_merchant_input")) {
    actions.push("Collect the flagged merchant inputs (byline identity, proof data) via the attestation lane, re-inject the slots, and rebuild — the needs-input marker must never ship.");
  }
  if (codes.has("content_residue.unverified_urgency")) {
    actions.push("Blank the urgency slots (countdown/sell-out) or record verified offer urgency in the brief payload's offer.urgency, then rebuild.");
  }
  if (codes.has("proof_attestation.pending_shipped") || codes.has("proof_attestation.non_attestable_shipped")) {
    actions.push("Resolve shipped proof against the brief payload's proof_assets: collect the merchant's click-wrap attestation for attestable items; remove non-attestable proof outright.");
  }
  if (codes.has("scope.partial_build")) {
    actions.push("Build and deploy only the mapped partial-scope pages; label the preview as route/visual-testable, not full-funnel launch-ready.");
  }
  const sourcePrepAction = sourcePreparationAction(errors, warnings);
  if (sourcePrepAction) actions.push(sourcePrepAction);
  if (codes.has("scope.runtime_qa_blocked")) {
    actions.push("Keep checkout/order-proof QA blocked until the out-of-scope runtime pages are built or explicitly delegated to an existing downstream URL.");
  }
  // A recorded setup is not a live scaffold. The picker still names build
  // (and `next build` refuses with next.build.setup), so the recovery is
  // spelled out here rather than by disagreeing with the picker.
  if (codes.has("page_kit.scaffold_required")) {
    actions.push(`Target campaign output directory is missing; run ${cmd("next")} setup --packet ${packetRef} before build.`);
  }
  if (polishBlocked) {
    if (polishGate.status === "blocked") {
      actions.push(`${polishGate.reason} Run next-campaigns-polish and record structured evidence before deploy/QA handoff.`);
    }
    if (polishCheckpointGate?.status === "blocked") {
      actions.push(`${polishCheckpointGate.reason} Run ${cmd("polish")} capture before marking Polish complete.`);
    }
  }
  return actions;
}

// Doctor's `next` block: the `next` command's picker, projected. `stage` and
// `reason` come from pickNextStage over the same report, doctor result and
// purchase-proof summary the `next` command reads; `blocked_stages` lists the
// stages AFTER the picked one that cannot run until it clears, never the
// picked stage itself; `command` is always present.
function buildNextStep(errors, warnings, derived, report = null, packet = null, prepareBuildGate = prepareBuildGateIssue(report), { sidecarArgs = "" } = {}) {
  const polishGate = derived.polish_gate || evaluatePolishGate({ report });
  const polishCheckpointGate = derived.polish_checkpoint_gate || null;
  const assemblyComplete = String(report?.stages?.assembly?.status || "").startsWith("completed");
  const polishBlocked = assemblyComplete
    && (polishGate.status === "blocked" || polishCheckpointGate?.status === "blocked");
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const purchaseProof = report ? assessPurchaseProofCoverage({ packet, report }) : null;
  const picked = pickNextStage(report, { errors, derived }, prepareBuildGate, purchaseProof);
  // The picker's vocabulary and this table must not drift apart: a stage the
  // table does not know would otherwise be relabelled as an operator step and
  // sliced into the whole ladder. Fail loudly instead.
  if (!Object.hasOwn(DOCTOR_NEXT_STAGE_OWNERS, picked.stage)) {
    throw new Error(`Doctor has no owner for next stage "${picked.stage}"; add it to DOCTOR_NEXT_STAGE_OWNERS.`);
  }
  // An explicit --context / --report is carried into every recommended
  // command, so a recovery reads the same artifacts the recommendation did.
  const packetRef = `${derived.packet_path || "<packet>"}${sidecarArgs}`;
  const actions = doctorNextActions(errors, warnings, derived, { polishBlocked, polishGate, polishCheckpointGate, packetRef });
  const deployStatus = String(report?.stages?.deploy?.status || "");
  const deploySatisfied = ["completed", "completed_with_warnings", "ready_with_exceptions"].some((prefix) => deployStatus.startsWith(prefix))
    || Boolean(deployUrlFromReportOutputs(report));
  // qa is not runnable without a URL to test (`next qa` refuses with
  // next.qa.deploy_url), so a picked qa with no deploy URL is blocked too.
  const qaNeedsUrl = codes.has("deploy.preview_url") && !deploySatisfied;
  // build is not runnable over a missing scaffold either (`next build`
  // refuses with next.build.setup); the action list names the setup step.
  // done is not ready while the runtime scope is partial: checkout launch
  // and test orders are still owed, whatever the ladder's stages say.
  const blocked = picked.stage === "doctor-blocked" || picked.stage === "prepare-build" || picked.blocked === true
    || (picked.stage === "qa" && qaNeedsUrl)
    || (picked.stage === "build" && derived.scaffold_required === true)
    || (picked.stage === "done" && codes.has("scope.runtime_qa_blocked"));
  // Stages behind the picked one. done has none; the two pre-ladder states
  // block the whole ladder; a ladder stage blocks what follows it.
  const later = picked.stage === "done"
    ? []
    : picked.stage === "doctor-blocked" || picked.stage === "prepare-build"
      ? [...NEXT_STAGE_ORDER]
      : NEXT_STAGE_ORDER.includes(picked.stage)
        ? NEXT_STAGE_ORDER.slice(NEXT_STAGE_ORDER.indexOf(picked.stage) + 1)
        : [];
  // Scope markers that are not ladder stages but that readers key on: a
  // partial runtime scope blocks checkout launch readiness and test orders
  // whatever stage comes next, and unconfirmed allowed domains block the
  // runtime SDK verification.
  const scopeMarkers = [
    ...(codes.has("scope.runtime_qa_blocked") ? ["checkout-launch-ready", "test-orders"] : []),
    ...(codes.has("campaign.allowed_domains_confirmed") ? ["runtime-sdk-verification"] : []),
  ];
  const gateBlocked = [
    ...(polishBlocked ? NEXT_STAGE_ORDER.slice(NEXT_STAGE_ORDER.indexOf("polish")) : []),
    // QA cannot run against no URL: `next qa` refuses with next.qa.deploy_url.
    ...(qaNeedsUrl ? ["qa"] : []),
  ];
  const owners = DOCTOR_NEXT_STAGE_OWNERS[picked.stage];
  // prepare-build is not a `next <stage>` argument: the stage-less `next`
  // is what prints the recovery actions for it, and it is also the right
  // call after a doctor-blocked repair or at done.
  const command = picked.stage === "doctor-blocked"
    ? `${cmd("doctor")} --packet ${packetRef}`
    : picked.stage === "prepare-build" || picked.stage === "done"
      ? `${cmd("next")} --packet ${packetRef}`
      : `${cmd("next")} ${picked.stage} --packet ${packetRef}`;
  const fallbackAction = picked.stage === "done"
    ? `All stages are recorded as terminal; run ${cmd("next")} to confirm the closeout actions.`
    : `Run ${command}.`;
  return {
    stage: picked.stage,
    status: blocked ? "blocked" : readinessStatus(warnings, derived),
    // The picker's own verdict on the picked stage (a blocked polish gate, a
    // blocked ladder stage, prepare-build), as distinct from `status`, which
    // also folds in what makes the stage unrunnable (no deploy URL, no
    // scaffold). `next` reports it as its own stage_blocked.
    stage_blocked: picked.blocked === true,
    owner: owners.owner,
    default_skill: owners.default_skill,
    command,
    reason: picked.reason,
    actions: actions.length ? actions : [fallbackAction],
    // Gate-blocked stages stay listed even when the recommended stage is
    // runnable (a Design Source Package change after assembly names build,
    // which is allowed, while polish, deploy and qa stay refused).
    blocked_stages: [...new Set([...(blocked ? later : []), ...gateBlocked, ...scopeMarkers])]
      .filter((stage) => stage !== picked.stage),
  };
}

export {
  polishGateRequiresBuild,
  pushGateIssue,
  nextPrepareBuildBindingIssues,
  prepareBuildGateIssue,
  addPrepareBuildGateErrors,
  deployUrlFromReportOutputs,
  checkpointExceptionPresent,
  buildNextStep,
};
