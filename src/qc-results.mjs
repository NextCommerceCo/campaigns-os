// The shared QC results: one result shape,
// one storage rule per leg, and the readers that re-derive every stored result
// from its raw package capture on every read.
//
// Storage per leg:
// - doctor: derived.qc_results[], recomputed from built HTML on every run;
// - polish: one package-owned record per stages.polish.evidence.visual_review
//   key (POLISH_RECORDS): media_weight, re-derived from its cells and
//   cross-checked against the page_load capture, and readability, whose
//   elements are re-derived through the shared contrast helper and whose
//   route set is recomputed from the built output;
// - qa: stages.qa.evidence.qc_results[] beside qc_build_fingerprint,
//   re-derived from the qc.* assertions of the full QA verdict.
//
// A reader never reports `pass` for an input it could not re-derive: a failed
// check reads `unexercised` with stale_binding or evidence_not_reproducible,
// and a leg with no rows for an applicable check is listed in the handoff
// coverage (silence is not a result). The committed QA sidecar,
// stages.qa.waivers and report.waivers[] are never read here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { campaignSidecarPaths } from "./campaign-workspace.mjs";
import { checkpointStateFingerprint } from "./checkpoint-waiver.mjs";
import { contrastToolkit } from "./contrast.mjs";
import { sameFile } from "./fs-identity.mjs";
import { buildPolishCaptureIntegrity, canonicalJson, captureOrigin, mediaFetchedResources } from "./polish-capture.mjs";
import { currentBuildFingerprint, currentSourcePackageMaterialFingerprint } from "./polish-gate.mjs";
import { sidecarPathForPacket } from "./qa-sidecar.mjs";
import { QA_ASSERTION_FAMILY_VOCABULARY, QA_SCHEMA_VERSION, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { QC_CHECK_REGISTRY, loadedQcRederivers, qcChecksForLeg, qcChecksForRecord } from "./qc-check-registry.mjs";
import { STORE_PAGE_MATCHERS } from "./spec-derive-store.mjs";

export const QC_RESULT_SCHEMA = "campaigns-os-qc-result/v0";
export const QC_RESULTS = Object.freeze(["pass", "warning", "review", "unexercised", "excluded"]);
export const QC_LEGS = Object.freeze(["doctor", "polish", "qa"]);
export const QC_REASON = Object.freeze({
  STALE_BINDING: "stale_binding",
  EVIDENCE_NOT_REPRODUCIBLE: "evidence_not_reproducible",
  LEG_NOT_RUN: "leg_not_run",
  NOT_CAPTURED: "not_captured_by_this_version",
});
export const QC_PRODUCERS = Object.freeze({
  doctor: "campaigns-os doctor",
  polish: "campaigns-os polish capture",
  qa: "campaigns-os qa run",
});
export const MEDIA_WEIGHT_SCHEMA = "campaigns-os-polish-media-weight/v0";
const PAGE_LOAD_SCHEMA = "campaigns-os-polish-page-load/v0";
const ROUTE_CAPTURE_SCHEMA = "campaigns-os-polish-route-capture/v0";
// The binding fields of the page_load subject (pageLoadCheckpointSubject) and
// of one route capture's subject (captureSubject), exactly, besides
// build_fingerprint. The build binding is read apart: absent, null or another
// build is staleness (stale_binding), never a malformed subject.
const PAGE_LOAD_SUBJECT_FIELDS = Object.freeze(["campaign_slug", "route_scope", "routes", "viewports"]);
const CAPTURE_SUBJECT_FIELDS = Object.freeze(["campaign_slug", "requested_route", "final_document_route", "viewport"]);
const QA_RUNTIME_PREFIX = "campaigns-os-node-qa@";
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const E = QC_REASON.EVIDENCE_NOT_REPRODUCIBLE;

// Result precedence when members aggregate into one row (excluded is ignored).
const PRECEDENCE = Object.freeze(["warning", "review", "unexercised", "pass"]);

// QA verdict mapping per result. unexercised is
// manual_review + warn, after src/qa-browser.mjs's unexercised-path precedent,
// never skipped: skipped is invisible to computeDisposition and exceptions[].
export const QC_QA_ASSERTION_STATUS = Object.freeze({
  pass: Object.freeze({ status: STATUS.PASS, severity: SEVERITY.INFO }),
  warning: Object.freeze({ status: STATUS.WARN, severity: SEVERITY.WARN }),
  review: Object.freeze({ status: STATUS.MANUAL_REVIEW, severity: SEVERITY.WARN }),
  unexercised: Object.freeze({ status: STATUS.MANUAL_REVIEW, severity: SEVERITY.WARN }),
  excluded: Object.freeze({ status: STATUS.SKIPPED, severity: SEVERITY.INFO }),
});

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const sameJson = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// ---------------------------------------------------------------------------
// Result shape

export function qcResultId(subject) {
  return [subject?.check, subject?.page, ...(subject?.viewport == null ? [] : [subject.viewport]), subject?.key].map((part) => String(part ?? "")).join(":");
}

export function qcStateFingerprint({ subject, state }) {
  return checkpointStateFingerprint({ scope: "qc", subject, state });
}

export const fingerprint12 = (fingerprint) => String(fingerprint || "").replace(/^sha256:/, "").slice(0, 12);
export const qcResultRef = (result) => `${result.id}@${fingerprint12(result.state_fingerprint)}`;

// Only a warning whose members are all resolved can be accepted.
export function qcAcceptEligible(result, members = []) {
  return result === "warning" && !(Array.isArray(members) ? members : []).some((member) => member?.result === "review" || member?.result === "unexercised");
}

function validMember(member) {
  return isPlainObject(member)
    && member.key != null
    && QC_RESULTS.includes(member.result)
    && (member.result === "pass" ? member.reason_code == null : isNonEmptyString(member.reason_code));
}

export function buildQcResult({ check, leg, subject, result, reason_code = null, state, observation = {}, members = [], accept_eligible = undefined, coverage, measured_at, producer = QC_PRODUCERS[leg] }) {
  if (!isNonEmptyString(check) || !isPlainObject(subject) || subject.check !== check) throw new TypeError("buildQcResult needs a check and a subject naming it.");
  if (!QC_LEGS.includes(leg)) throw new TypeError(`buildQcResult leg must be one of ${QC_LEGS.join(", ")}.`);
  if (!QC_RESULTS.includes(result)) throw new TypeError(`buildQcResult result must be one of ${QC_RESULTS.join(", ")}.`);
  if (result !== "pass" && !isNonEmptyString(reason_code)) throw new TypeError("buildQcResult needs a reason_code unless the result is pass.");
  if (!Array.isArray(members) || !members.every(validMember)) throw new TypeError("buildQcResult members must be {key, result, reason_code} entries.");
  const eligible = qcAcceptEligible(result, members) && accept_eligible !== false;
  return {
    schema: QC_RESULT_SCHEMA,
    id: qcResultId(subject),
    check,
    leg,
    result,
    reason_code: result === "pass" ? null : reason_code,
    subject,
    state_fingerprint: qcStateFingerprint({ subject, state }),
    observation,
    members,
    accept_eligible: eligible,
    coverage: coverage ?? { observed: 1, expected: 1, limits: [] },
    measured_at,
    producer,
  };
}

// Members aggregate as warning > review > unexercised > pass; excluded members
// are ignored, and a row of only excluded members is excluded. A capped page
// adds the page_coverage member, so its kept results are never accept-eligible.
export function aggregateQcResults(members, { capReason = null } = {}) {
  const all = [...(Array.isArray(members) ? members : []), ...(capReason ? [{ key: "page_coverage", result: "unexercised", reason_code: capReason }] : [])];
  const counted = all.filter((member) => member.result !== "excluded");
  const result = counted.length ? PRECEDENCE.find((value) => counted.some((member) => member.result === value)) || "unexercised" : "excluded";
  const lead = result === "pass" ? null : all.find((member) => member.result === result);
  return { result, reason_code: lead ? lead.reason_code : null, members: all, accept_eligible: qcAcceptEligible(result, all) };
}

// A QA verdict assertion for a result, in an existing family, id prefixed qc.
export function toQaAssertion(row, { family = "browser-runtime", expected = null, actual = null } = {}) {
  if (!QA_ASSERTION_FAMILY_VOCABULARY.includes(family)) throw new TypeError(`toQaAssertion family must be an existing QA assertion family (got ${family}).`);
  const { status, severity } = QC_QA_ASSERTION_STATUS[row.result];
  return {
    id: `qc.${row.id}`,
    family,
    page: row.subject?.page ?? null,
    status,
    severity,
    ...(expected == null ? {} : { expected }),
    actual: actual ?? `${row.check} ${row.result}${row.reason_code ? ` (${row.reason_code})` : ""}`,
    evidence: { qc: { result_id: row.id, observation: row.observation, ...(row.result === "excluded" ? { reason_code: row.reason_code } : {}) } },
  };
}

export function toDoctorIssue(row) {
  return {
    code: `built_output.${row.check}.${row.reason_code}`,
    message: `${row.check} ${row.result} on ${row.subject?.page ?? "(no page)"} (${row.subject?.key ?? "(no key)"}): ${row.reason_code}.`,
    detail: { qc_result: row },
  };
}

// The single doctor wiring point: every result lands in derived.qc_results;
// warning and review results also become warnings[] issues. Doctor status
// rules are unchanged, and unexercised/excluded stay in derived only.
export function recordQcResults({ derived, warnings, results }) {
  if (!Array.isArray(derived.qc_results)) derived.qc_results = [];
  for (const row of Array.isArray(results) ? results : []) {
    derived.qc_results.push(row);
    if (row.result === "warning" || row.result === "review") warnings.push(toDoctorIssue(row));
  }
  return derived.qc_results;
}

// ---------------------------------------------------------------------------
// Rederivers: an in-process stand-in (tests only) or the registry module.

function qaRederiver(check, { qcStandIns, rederivers }) {
  const standIn = qcStandIns?.qa?.[check];
  if (typeof standIn === "function") return { status: "loaded", rederive: standIn };
  const entry = (rederivers || loadedQcRederivers())?.[check];
  if (!entry) return { status: Object.hasOwn(QC_CHECK_REGISTRY, check) ? "unresolved" : "unknown" };
  if (entry.status === "loaded" && typeof entry.rederive !== "function") return { status: "failed" };
  return entry;
}

// The rules of the record a Polish check is read from. A stand-in is
// `qcStandIns.polish[check]`, or `qcStandIns.polish` itself for the
// media_weight checks.
export function resolvePolishRules({ check = "media.weight", qcStandIns, rederivers } = {}) {
  const standIn = isPlainObject(qcStandIns?.polish?.[check]) ? qcStandIns.polish[check]
    : QC_CHECK_REGISTRY[check]?.record === "media_weight" && isPlainObject(qcStandIns?.polish) ? qcStandIns.polish : null;
  if (standIn) return { status: "loaded", rules: standIn };
  const entry = (rederivers || loadedQcRederivers())?.[check];
  if (!entry) return { status: "unresolved" };
  if (entry.status !== "loaded") return entry;
  const rules = entry.rederive;
  return isPlainObject(rules) && typeof rules.evaluate === "function" && isPlainObject(rules.thresholds) && isPlainObject(rules.vocabulary)
    ? { status: "loaded", rules }
    : { status: "failed" };
}

// A result the reader could not re-derive. What the stored row claims is kept
// only to name it (id, subject, fingerprint); its result never survives.
function unreproducedRow(base, reasonCode, { leg, measuredAt = null }) {
  const subject = isPlainObject(base?.subject) ? base.subject : { check: base?.check ?? null, page: base?.page ?? null, key: base?.key ?? null };
  const check = isNonEmptyString(base?.check) ? base.check : subject.check ?? null;
  return {
    schema: QC_RESULT_SCHEMA,
    id: isNonEmptyString(base?.id) ? base.id : qcResultId(subject),
    check,
    leg,
    result: "unexercised",
    reason_code: reasonCode,
    subject,
    state_fingerprint: FINGERPRINT.test(base?.state_fingerprint || "") ? base.state_fingerprint : qcStateFingerprint({ subject, state: { reason_code: reasonCode } }),
    observation: {},
    members: [],
    accept_eligible: false,
    coverage: { observed: 0, expected: null, limits: [reasonCode] },
    measured_at: validTime(measuredAt) ? measuredAt : validTime(base?.measured_at) ? base.measured_at : null,
    producer: QC_PRODUCERS[leg],
  };
}

const staleRow = (row) => ({
  ...row,
  result: "unexercised",
  reason_code: QC_REASON.STALE_BINDING,
  accept_eligible: false,
  coverage: { ...(isPlainObject(row.coverage) ? row.coverage : {}), limits: [QC_REASON.STALE_BINDING] },
});

// A check re-deriver's output, checked against the QC result vocabulary.
function validDerived(derived, check) {
  return isPlainObject(derived)
    && derived.check === check
    && isPlainObject(derived.subject)
    && derived.subject.check === check
    && QC_RESULTS.includes(derived.result)
    && (derived.result === "pass" ? derived.reason_code == null : isNonEmptyString(derived.reason_code))
    && (derived.members === undefined || (Array.isArray(derived.members) && derived.members.every(validMember)))
    && typeof derived.accept_eligible === "boolean"
    && (derived.coverage === undefined || isPlainObject(derived.coverage))
    && Object.hasOwn(derived, "state");
}

// ---------------------------------------------------------------------------
// QA reader site

// The Inputs checks on the full QA verdict. Returns null when it passes.
// Every qc.* assertion takes part in pairing, so none may be skipped: an
// entry that is not an assertion object, a qc.* assertion whose evidence.qc
// is not {result_id: non-empty string, observation: object}, or QC evidence
// on an assertion whose id is not qc.* fails the whole verdict.
export function qaFullVerdictProblem(verdict, stage) {
  if (!isPlainObject(verdict)) return "full_verdict_absent";
  if (verdict.schema_version !== QA_SCHEMA_VERSION) return "verdict_schema";
  if (typeof verdict.runtime !== "string" || !verdict.runtime.startsWith(QA_RUNTIME_PREFIX)) return "verdict_runtime";
  const runId = stage?.identity?.verdict_run_id;
  if (!isNonEmptyString(runId) || verdict.run_id !== runId) return "verdict_run_id";
  if (!Array.isArray(verdict.assertions)) return "verdict_assertions";
  for (const assertion of verdict.assertions) {
    if (!isPlainObject(assertion)) return "verdict_assertions";
    const isQc = typeof assertion.id === "string" && assertion.id.startsWith("qc.");
    const carriesQc = isPlainObject(assertion.evidence) && Object.hasOwn(assertion.evidence, "qc");
    if (!isQc && !carriesQc) continue;
    const qc = assertion.evidence?.qc;
    if (!isQc || !isPlainObject(qc) || !isNonEmptyString(qc.result_id) || !isPlainObject(qc.observation)) return "qc_assertion_malformed";
  }
  return null;
}

// The full verdict the QA stage names: its outputs[] entry under
// {target}/qa-output/. Evidence refers to itself when that file is the
// committed QA sidecar or the Assembly Report. That is decided on the file
// itself, after every symlink and directory alias resolves (a symlinked
// qa-output/ included), and on its device and inode (a hard link), whatever
// the stage's other outputs[] say; such a verdict reads as absent. This is the
// only file a QC reader opens from a path held in a record.
export function readQaFullVerdict({ stage, targetRepo, packetPath = null, reportPath = null }) {
  if (!isPlainObject(stage) || !isNonEmptyString(targetRepo)) return null;
  const outputDir = resolve(targetRepo, "qa-output");
  const inside = (root, path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const outputs = (Array.isArray(stage.outputs) ? stage.outputs : []).filter(isNonEmptyString).map((path) => resolve(targetRepo, path));
  const candidates = outputs.filter((path) => inside(outputDir, path));
  if (candidates.length !== 1 || !existsSync(candidates[0]) || !existsSync(outputDir)) return null;
  try {
    const real = realpathSync(candidates[0]);
    const stats = statSync(real);
    if (!stats.isFile()) return null;
    if (!inside(realpathSync(outputDir), real)) return null;
    const forbidden = [
      reportPath,
      campaignSidecarPaths(targetRepo).reportPath,
      isNonEmptyString(packetPath) ? sidecarPathForPacket(packetPath) : null,
      ...outputs.filter((path) => path !== candidates[0]),
    ].filter(isNonEmptyString);
    for (const path of forbidden) {
      if (sameFile(real, path)) return null;
      if (!existsSync(path)) continue;
      const other = statSync(path);
      if (other.dev === stats.dev && other.ino === stats.ino) return null;
    }
    return JSON.parse(readFileSync(real, "utf8"));
  } catch {
    return null;
  }
}

export function readQaResults({ stageEvidence, stage = null, fullVerdict = null, currentBuild = null, qcStandIns = null, rederivers = null } = {}) {
  const stored = Array.isArray(stageEvidence?.qc_results) ? stageEvidence.qc_results : null;
  if (!stored) return [];
  const verdictOk = qaFullVerdictProblem(fullVerdict, stage) === null;
  const measuredAt = verdictOk ? (validTime(fullVerdict.completed_at) ? fullVerdict.completed_at : fullVerdict.started_at) : null;
  const bound = isNonEmptyString(currentBuild) && stageEvidence.qc_build_fingerprint === currentBuild;

  // Rows pair with assertions by evidence.qc.result_id, never by assertion id.
  // A passing verdict holds only well-formed QC evidence (qaFullVerdictProblem),
  // so the only assertions passed over here carry none.
  const paired = new Map();
  const duplicated = new Set();
  for (const assertion of verdictOk ? fullVerdict.assertions : []) {
    if (typeof assertion.id !== "string" || !assertion.id.startsWith("qc.")) continue;
    const resultId = assertion.evidence.qc.result_id;
    if (paired.has(resultId)) duplicated.add(resultId);
    paired.set(resultId, assertion);
  }

  const read = new Map();
  stored.forEach((row, index) => {
    const id = isPlainObject(row) && isNonEmptyString(row.id) ? row.id : `qc_results[${index}]`;
    if (read.has(id)) {
      read.set(id, unreproducedRow(read.get(id), E, { leg: "qa", measuredAt }));
      return;
    }
    read.set(id, readQaRow(isPlainObject(row) ? row : { id }, { verdictOk, assertion: duplicated.has(id) ? null : paired.get(id), measuredAt, qcStandIns, rederivers, bound }));
  });
  // A verdict result_id with no row: synthesized, never silent.
  for (const [resultId, assertion] of paired) {
    if (read.has(resultId)) continue;
    const observation = assertion.evidence.qc.observation;
    const check = isNonEmptyString(observation?.check) ? observation.check : resultId.split(":")[0];
    read.set(resultId, unreproducedRow({ id: resultId, check, subject: { check, page: assertion.page ?? null, key: null } }, E, { leg: "qa", measuredAt }));
  }
  return [...read.values()];
}

function readQaRow(row, { verdictOk, assertion, measuredAt, qcStandIns, rederivers, bound }) {
  const fail = () => unreproducedRow(row, E, { leg: "qa", measuredAt });
  if (!verdictOk || !assertion) return fail();
  if (row.schema !== QC_RESULT_SCHEMA || row.producer !== QC_PRODUCERS.qa || row.leg !== "qa" || !isNonEmptyString(row.check)) return fail();
  const observation = assertion.evidence.qc.observation;
  if (!sameJson(row.observation, observation)) return fail();
  if (!QA_ASSERTION_FAMILY_VOCABULARY.includes(assertion.family)) return fail();
  const rederiver = qaRederiver(row.check, { qcStandIns, rederivers });
  if (rederiver.status === "missing") {
    const notCaptured = unreproducedRow(row, QC_REASON.NOT_CAPTURED, { leg: "qa", measuredAt });
    return bound ? notCaptured : staleRow(notCaptured);
  }
  if (rederiver.status !== "loaded") return fail();
  let derived = null;
  try {
    derived = rederiver.rederive(observation);
  } catch {
    derived = null;
  }
  if (!validDerived(derived, row.check)) return fail();
  const members = derived.members ?? [];
  const coverage = derived.coverage ?? { observed: 1, expected: 1, limits: [] };
  const stateFingerprint = qcStateFingerprint({ subject: derived.subject, state: derived.state });
  const reasonCode = derived.result === "pass" ? null : derived.reason_code;
  const expected = QC_QA_ASSERTION_STATUS[derived.result];
  if (row.id !== qcResultId(derived.subject)
    || !sameJson(row.subject, derived.subject)
    || row.result !== derived.result
    || (row.reason_code ?? null) !== reasonCode
    || !sameJson(row.members ?? [], members)
    || row.accept_eligible !== derived.accept_eligible
    || !sameJson(row.coverage, coverage)
    || row.state_fingerprint !== stateFingerprint
    || assertion.status !== expected.status
    || assertion.severity !== expected.severity) return fail();
  const result = {
    schema: QC_RESULT_SCHEMA,
    id: row.id,
    check: row.check,
    leg: "qa",
    result: derived.result,
    reason_code: reasonCode,
    subject: derived.subject,
    state_fingerprint: stateFingerprint,
    observation,
    members,
    accept_eligible: derived.accept_eligible && qcAcceptEligible(derived.result, members),
    coverage,
    measured_at: measuredAt,
    producer: QC_PRODUCERS.qa,
  };
  return bound ? result : staleRow(result);
}

// ---------------------------------------------------------------------------
// Polish reader sites (media_weight against its page_load capture, and
// readability)

// Unkeyed tamper evidence of a package-owned Polish record over every field
// but `integrity`, the canonical-JSON + sha256 pattern of
// buildPolishCaptureIntegrity.
export function polishRecordIntegrity(record) {
  const { integrity: _ignored, ...rest } = record || {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}
export const mediaWeightIntegrity = polishRecordIntegrity;

const inVocabulary = (vocabulary, field, value) => Array.isArray(vocabulary?.[field]) && vocabulary[field].includes(value);
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

// The subjects a cell lists whatever happens to it: one weight result per
// resource, one per unfetched <video>, one per probed <img> whose currentSrc
// binds to no resource (mediaChainBinder: "img:<element_path>"), one oversize result per
// <img>, and one oversize result keyed "cell" for a cell that lists no <img>
// (so an image-free page is never silent).
function cellSubjects(cell) {
  const route = cell?.route ?? null;
  const viewport = cell?.viewport ?? null;
  const subjects = [];
  const resources = Array.isArray(cell?.resources) ? cell.resources : [];
  const images = Array.isArray(cell?.images) ? cell.images : [];
  for (const resource of resources) {
    subjects.push({ check: "media.weight", page: route, viewport, key: resource?.resource_id ?? null });
  }
  for (const video of Array.isArray(cell?.videos) ? cell.videos : []) {
    if (Array.isArray(video?.resource_ids) && video.resource_ids.length) continue;
    subjects.push({ check: "media.weight", page: route, viewport, key: `video:${video?.element_index}` });
  }
  const bind = mediaChainBinder(resources);
  const unledgered = new Set();
  for (const image of images) {
    if (bind(image?.resource_id).status !== "absent") continue;
    const key = `img:${image?.element_path}`;
    if (unledgered.has(key)) continue;
    unledgered.add(key);
    subjects.push({ check: "media.weight", page: route, viewport, key });
  }
  for (const image of images) {
    subjects.push({ check: "media.oversize", page: route, viewport, key: `${image?.resource_id}:${image?.element_path}` });
  }
  if (!images.length) subjects.push({ check: "media.oversize", page: route, viewport, key: "cell" });
  return subjects;
}

// A value the image probe observed, or null where the cell's probe did not
// complete and so observed nothing (dpr and image geometry have no raw
// counterpart; only their vocabulary is checked).
const observedOrNull = (cell, value, check) => check(value) || (cell.probe_status !== "complete" && value === null);

function recordVocabularyOk(record, vocabulary) {
  return record.cells.every((cell) => isPlainObject(cell)
    && isNonEmptyString(cell.route)
    && isNonEmptyString(cell.viewport)
    && Array.isArray(record.subject?.routes) && record.subject.routes.includes(cell.route)
    && Array.isArray(record.subject?.viewports) && record.subject.viewports.includes(cell.viewport)
    && observedOrNull(cell, cell.dpr, (dpr) => typeof dpr === "number" && dpr > 0)
    && isNonEmptyString(cell.page_load_integrity)
    && inVocabulary(vocabulary, "capture_status", cell.capture_status)
    && inVocabulary(vocabulary, "probe_status", cell.probe_status)
    && Array.isArray(cell.resources) && cell.resources.every((resource) => isPlainObject(resource)
      && isNonEmptyString(resource.resource_id)
      && inVocabulary(vocabulary, "measurement", resource.measurement)
      && typeof resource.failed === "boolean"
      && typeof resource.final_origin_equal === "boolean"
      && Number.isFinite(resource.transferred_bytes)
      && (resource.declared_bytes === null || Number.isFinite(resource.declared_bytes))
      && Array.isArray(resource.chain) && resource.chain.length > 0 && resource.chain.every(isPlainObject))
    && Array.isArray(cell.images) && cell.images.every((image) => isPlainObject(image)
      && (image.resource_id === null || isNonEmptyString(image.resource_id))
      && isNonEmptyString(image.element_path)
      && observedOrNull(cell, image.complete, (value) => typeof value === "boolean")
      && observedOrNull(cell, image.hidden, (value) => typeof value === "boolean")
      && observedOrNull(cell, image.natural, isPair)
      && observedOrNull(cell, image.rendered, isPair)
      && observedOrNull(cell, image.object_fit, (value) => inVocabulary(vocabulary, "object_fit", value))
      && inVocabulary(vocabulary, "loading", image.loading))
    && Array.isArray(cell.videos) && cell.videos.every((video) => isPlainObject(video)
      && Number.isInteger(video.element_index)
      && Array.isArray(video.resource_ids) && video.resource_ids.every(isNonEmptyString)
      && typeof video.declared_origin_equal === "boolean"));
}

// The page_load fields the cell checks read, each required present with the
// producer's type. A missing or ill-typed field never stands in for 0, false,
// complete or an empty list: the cell does not re-derive.
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const LEDGER_COUNTS = Object.freeze([
  "transferred_bytes",
  "declared_bytes",
  "request_count",
  "declared_request_count",
  "failed_request_count",
  "cache_request_count",
  "unmeasured_request_count",
  "canceled_request_count",
  "partial_request_count",
  "cross_origin_request_count",
]);
const MEDIA_TAGS = Object.freeze(["video", "audio"]);
const SOURCE_KINDS = Object.freeze(["current_src", "src_attribute", "source_src_attribute", "observed_source"]);

// A resource_ledger entry: its identity, URL and type, every byte count and
// request counter (mediaFetchedResources copies request_count and
// declared_bytes too), its statuses, and the identity set it matched (which
// always holds its own resource_id).
function ledgerEntryOk(entry) {
  return isPlainObject(entry)
    && isNonEmptyString(entry.resource_id)
    && isNonEmptyString(entry.url)
    && isNonEmptyString(entry.resource_type)
    && LEDGER_COUNTS.every((field) => isCount(entry[field]))
    && Array.isArray(entry.statuses) && entry.statuses.every(Number.isInteger)
    && Array.isArray(entry.match_resource_ids) && entry.match_resource_ids.every(isNonEmptyString)
    && entry.match_resource_ids.includes(entry.resource_id);
}

// A media[] element: its tag, its index, every source reference's kind, index,
// URL and resolved resource_id (null when the ledger cannot identify the
// source), and every fetched resource's identity and the source identities it
// matched. The capture checksum covers the source and fetched-resource
// associations, so each of those fields is read too.
function mediaElementOk(element) {
  return isPlainObject(element)
    && MEDIA_TAGS.includes(element.tag_name)
    && isCount(element.element_index)
    && Array.isArray(element.source_references)
    && element.source_references.every((reference) => isPlainObject(reference)
      && SOURCE_KINDS.includes(reference.source_kind)
      && isCount(reference.source_index)
      && isNonEmptyString(reference.url)
      && Object.hasOwn(reference, "resource_id")
      && (reference.resource_id === null || isNonEmptyString(reference.resource_id)))
    && Array.isArray(element.fetched_resources)
    && element.fetched_resources.every((resource) => isPlainObject(resource)
      && isNonEmptyString(resource.resource_id)
      && Array.isArray(resource.matched_source_resource_ids)
      && resource.matched_source_resource_ids.every(isNonEmptyString));
}

// A cell resource's own URL and type, and each chain hop's identity, URL and
// status, which the cell checks compare with the ledger. A null status is
// left to the chain check, which allows it only on a final hop that failed
// with no HTTP response.
function cellResourceShapeOk(resource) {
  return isNonEmptyString(resource.url)
    && isNonEmptyString(resource.type)
    && resource.chain.every((hop) => isNonEmptyString(hop.resource_id) && isNonEmptyString(hop.url) && (Number.isInteger(hop.status) || hop.status === null));
}

function ledgerMeasurement(entry) {
  if (entry.cache_request_count > 0) return "cached";
  if (entry.unmeasured_request_count > 0) return "unmeasured";
  if (entry.canceled_request_count > 0 || entry.partial_request_count > 0) return "lower_bound";
  return "complete";
}

// A redirect answer: the hop continues to another URL. Every other status
// (a 2xx, a 304, an error) ends the chain.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const isRedirectEntry = (entry) => Array.isArray(entry.statuses) && entry.statuses.length > 0 && entry.statuses.every((status) => REDIRECT_STATUSES.has(status));
const mixesRedirect = (entry) => Array.isArray(entry.statuses) && entry.statuses.some((status) => REDIRECT_STATUSES.has(status)) && !isRedirectEntry(entry);

// The one binding of a requested href (the identity an element used) to a
// request chain, read from the page_load ledger alone, so it is the same
// whatever order the requests came in. The producer builds every resource's
// chain with it and the reader checks every resource's chain against it.
// - "bound": the ledger singles out one chain. Its final hop is the one entry
//   that names the requested href in its match_resource_ids and answered
//   with a non-redirect status (the requested entry itself when it was not
//   redirected); its hops are that final entry plus every redirect entry it
//   names. The ledger keeps no Location, so it fixes the hop set and both
//   ends; it cannot order intermediate hops.
// - "ambiguous": the href stands for more than one chain, or a hop of its
//   chain also belongs to another chain. No result may be read from any one
//   of those chains. That is the case when:
//   - any entry of the chain, or any entry its final hop names, mixes a
//     redirect and a non-redirect status (one request through that URL was
//     answered, another redirected);
//   - it only redirected and no single final hop names it;
//   - it was answered directly and a redirect entry names it too (it is one
//     chain's final hop and another chain's start);
//   - a hop answered more requests than the requested href did (that hop
//     also started a chain of its own).
// - "absent": no ledger entry has that id.
export function bindLedgerChain(requestedId, entries, byId = new Map(entries.map((entry) => [entry?.resource_id, entry]))) {
  const requested = byId.get(requestedId);
  if (!requested) return { status: "absent" };
  if (mixesRedirect(requested)) return { status: "ambiguous" };
  let final = requested;
  if (isRedirectEntry(requested)) {
    const finals = entries.filter((entry) => !isRedirectEntry(entry) && Array.isArray(entry.match_resource_ids) && entry.match_resource_ids.includes(requestedId));
    if (finals.length !== 1) return { status: "ambiguous" };
    [final] = finals;
  }
  if (!Array.isArray(final.match_resource_ids)) return { status: "ambiguous" };
  const hops = new Set([final.resource_id, requestedId]);
  for (const id of final.match_resource_ids) {
    const entry = byId.get(id);
    if (entry && mixesRedirect(entry)) return { status: "ambiguous" };
    if (entry && entry !== final && isRedirectEntry(entry)) hops.add(id);
  }
  if (final === requested && hops.size > 1) return { status: "ambiguous" };
  if ([...hops].some((id) => byId.get(id)?.request_count !== requested.request_count)) return { status: "ambiguous" };
  return { status: "bound", final, hops };
}

// The one binding of a cell's elements to its resources, read from the
// record: an element identity (an <img>'s currentSrc id, a <video>'s fetched
// ledger ids) binds to the resource whose chain holds it. The 1.3 rules
// (src/polish-media-weight.mjs) and the reader's subject list both bind
// through it. Returns { status: "bound", resource } when exactly one
// resource's chain holds the id, { status: "ambiguous" } when more than one
// does, and { status: "absent" } when none does.
export function mediaChainBinder(resources) {
  const holders = new Map();
  for (const resource of Array.isArray(resources) ? resources : []) {
    for (const hop of Array.isArray(resource?.chain) ? resource.chain : []) {
      const id = hop?.resource_id;
      if (!holders.has(id)) holders.set(id, new Set());
      holders.get(id).add(resource);
    }
  }
  return (id) => {
    const found = id === null || id === undefined ? undefined : holders.get(id);
    if (!found) return { status: "absent" };
    return found.size === 1 ? { status: "bound", resource: [...found][0] } : { status: "ambiguous" };
  };
}

// The ledger types an <img> request can be recorded under: its own (image),
// a type merged with another load of the same URL (unknown), or a hint that
// fetched it first (other, prefetch). An <img> bound to a document, script,
// stylesheet or any other entry did not load from it.
const IMAGE_REQUEST_TYPES = new Set(["image", "other", "prefetch", "unknown"]);

// Every field of a cell that has a raw counterpart, checked against the
// page_load capture for the same route and viewport. True when it re-derives.
// Every set the reader consumes is derived from the capture and required to
// match exactly: each resource's hop set and final hop (bindLedgerChain; a
// requested href the ledger binds to more than one chain, or whose chain
// shares a hop with another chain, does not re-derive, whatever the request
// order), the cell's resource set (the chains partition
// the capture's ledger: every entry in exactly one resource's chain), each
// <img> identity (null, or one resource's requested href), and the cell's
// video set (every <video> media element). A truncated chain, a dropped resource or a dropped video
// does not re-derive. Every raw field read is first required present and well
// typed (ledgerEntryOk, mediaElementOk): a ledger, media list, counter, byte
// count, status list, origin or identity set that is missing or ill typed
// does not re-derive either.
function cellReproduces(cell, capture) {
  if (!isPlainObject(capture) || !isPlainObject(capture.integrity)) return false;
  if (!sameJson(buildPolishCaptureIntegrity(capture), capture.integrity)) return false;
  if (cell.page_load_integrity !== capture.integrity.projection_fingerprint) return false;
  if (!isNonEmptyString(capture.measurement_status) || cell.capture_status !== capture.measurement_status) return false;
  const finalOrigin = isPlainObject(capture.document_response) ? capture.document_response.final_origin : null;
  if (!isNonEmptyString(finalOrigin) || captureOrigin(finalOrigin) !== finalOrigin || cell.document_origin !== finalOrigin) return false;
  if (!isPlainObject(capture.resource_ledger) || !Array.isArray(capture.resource_ledger.entries) || !capture.resource_ledger.entries.every(ledgerEntryOk)) return false;
  if (!Array.isArray(capture.media) || !capture.media.every(mediaElementOk)) return false;
  const entries = capture.resource_ledger.entries;
  const byId = new Map(entries.map((entry) => [entry.resource_id, entry]));
  if (byId.size !== entries.length) return false;
  const media = capture.media;
  if (new Set(media.map((element) => element.element_index)).size !== media.length) return false;
  const covered = new Set();
  for (const resource of cell.resources) {
    if (!cellResourceShapeOk(resource)) return false;
    const { chain } = resource;
    if (chain[0].resource_id !== resource.resource_id || chain[0].url !== resource.url) return false;
    const expected = bindLedgerChain(resource.resource_id, entries, byId);
    if (expected.status !== "bound") return false;
    const { final } = expected;
    const chainIds = chain.map((hop) => hop.resource_id);
    if (chain.at(-1).resource_id !== final.resource_id
      || new Set(chainIds).size !== chainIds.length
      || chainIds.length !== expected.hops.size
      || !chainIds.every((id) => expected.hops.has(id))) return false;
    for (const [index, hop] of chain.entries()) {
      const entry = byId.get(hop.resource_id);
      if (!entry || hop.url !== entry.url || !Array.isArray(entry.statuses)) return false;
      // A final hop whose request failed with no HTTP response carries no status.
      const noResponse = index === chain.length - 1 && entry.statuses.length === 0 && entry.failed_request_count > 0 && hop.status === null;
      if (!noResponse && !entry.statuses.includes(hop.status)) return false;
      if (!final.match_resource_ids.includes(hop.resource_id)) return false;
      // Every hop but the last answered with a redirect; the last did not.
      if (REDIRECT_STATUSES.has(hop.status) !== (index < chain.length - 1)) return false;
      if (covered.has(hop.resource_id)) return false;
      covered.add(hop.resource_id);
    }
    if (resource.type !== final.resource_type
      || resource.transferred_bytes !== final.transferred_bytes
      || resource.declared_bytes !== (final.declared_request_count > 0 ? final.declared_bytes : null)
      || resource.failed !== (final.failed_request_count > 0)
      || resource.measurement !== ledgerMeasurement(final)
      || resource.final_origin_equal !== (final.cross_origin_request_count === 0)) return false;
  }
  if (covered.size !== byId.size) return false;
  // Every <img> identity is null (its currentSrc has no ledger entry: weight
  // not_in_ledger) or exactly the requested href of one resource, whose chain
  // the ledger binds (above) and whose entry an <img> request can produce. A
  // re-cased or unknown id, a redirect or final hop, or a document or script
  // entry does not re-derive.
  const heads = new Set(cell.resources.map((resource) => resource.resource_id));
  for (const image of cell.images) {
    if (image.resource_id === null) continue;
    if (!heads.has(image.resource_id) || !IMAGE_REQUEST_TYPES.has(byId.get(image.resource_id).resource_type)) return false;
  }
  const videoIndexes = media.filter((element) => element.tag_name === "video").map((element) => element.element_index).sort((a, b) => a - b);
  const listedIndexes = cell.videos.map((video) => video.element_index).sort((a, b) => a - b);
  if (!sameJson(listedIndexes, videoIndexes)) return false;
  for (const video of cell.videos) {
    const element = media.find((candidate) => candidate.element_index === video.element_index);
    if (!element) return false;
    const fetched = mediaFetchedResources(element, entries).map((entry) => entry.resource_id).sort();
    if (!sameJson([...video.resource_ids].sort(), fetched)) return false;
    const declaredSameOrigin = element.source_references.some((reference) => captureOrigin(reference.url) === finalOrigin);
    if (video.declared_origin_equal !== declaredSameOrigin) return false;
  }
  return true;
}

const cellKey = (route, viewport) => JSON.stringify([route, viewport]);
const uniqueStrings = (list) => Array.isArray(list) && list.length > 0 && list.every(isNonEmptyString) && new Set(list).size === list.length;
// A subject without its build binding, and whether its other fields are
// exactly `fields`.
const unbound = (subject) => {
  if (!isPlainObject(subject)) return subject;
  const { build_fingerprint: _build, ...rest } = subject;
  return rest;
};
const hasExactly = (object, fields) => isPlainObject(object) && sameJson(Object.keys(unbound(object)).sort(), [...fields].sort());

// The routes of spec pages the run did not capture (no source mapping),
// listed in the record as uncaptured_routes (absent reads as none). The
// page_load capture records that pages were skipped only as route_scope
// "selected", so a list is accepted only then, and only of routes it did not
// capture. Null when the list is malformed.
function uncapturedRoutesOf(record) {
  if (!Object.hasOwn(record, "uncaptured_routes")) return [];
  const routes = record.uncaptured_routes;
  if (!Array.isArray(routes)) return null;
  if (!routes.length) return routes;
  return uniqueStrings(routes)
    && record.subject.route_scope === "selected"
    && routes.every((route) => route.startsWith("/") && !record.subject.routes.includes(route))
    ? routes
    : null;
}

// The page ids of skipped spec pages whose public route the run could not
// resolve, listed as uncaptured_page_ids (absent reads as none); accepted, like
// uncaptured_routes, only under route_scope "selected". Null when malformed.
function uncapturedPageIdsOf(record) {
  if (!Object.hasOwn(record, "uncaptured_page_ids")) return [];
  const pageIds = record.uncaptured_page_ids;
  if (!Array.isArray(pageIds)) return null;
  if (!pageIds.length) return pageIds;
  return uniqueStrings(pageIds) && record.subject.route_scope === "selected" ? pageIds : null;
}

// The record's declared subject: exactly the page_load subject fields, each
// well formed. Its routes × viewports is the declared cell grid.
function declaredSubjectOk(subject) {
  return hasExactly(subject, PAGE_LOAD_SUBJECT_FIELDS)
    && isNonEmptyString(subject.campaign_slug)
    && ["all", "selected"].includes(subject.route_scope)
    && uniqueStrings(subject.routes)
    && uniqueStrings(subject.viewports);
}

const declaredGrid = (subject) => (Array.isArray(subject?.routes) ? subject.routes : [])
  .flatMap((route) => (Array.isArray(subject?.viewports) ? subject.viewports : []).map((viewport) => ({ route, viewport })));

// The page_load measurement summary agrees with the declared grid and the
// captures: it expects every declared cell, counts every capture, and lists
// nothing missing, duplicated or unexpected; any cell it calls incomplete is
// a declared one.
function measurementSummaryOk(measurement, grid, captureCount) {
  const gridKeys = new Set(grid.map(({ route, viewport }) => cellKey(route, viewport)));
  return isPlainObject(measurement)
    && measurement.expected_capture_count === grid.length
    && measurement.captured_count === captureCount
    && ["missing", "duplicate", "unexpected"].every((field) => Array.isArray(measurement[field]) && measurement[field].length === 0)
    && Array.isArray(measurement.incomplete)
    && measurement.incomplete.every((entry) => isPlainObject(entry) && gridKeys.has(cellKey(entry.route, entry.viewport)));
}

// A route capture's own identity and binding, against the record's declared
// subject: producer and schema, exactly the capture subject fields, the same
// campaign, a document that stayed on the requested route, and a declared
// route and viewport. Returns "fail" when any of that does not hold, else
// "stale" when the capture's build is absent, null or not the current build,
// else null.
function captureBindingProblem(capture, subject, currentBuild) {
  const own = capture?.subject;
  if (capture?.schema_version !== ROUTE_CAPTURE_SCHEMA
    || capture?.performed_by !== QC_PRODUCERS.polish
    || !hasExactly(own, CAPTURE_SUBJECT_FIELDS)
    || own.campaign_slug !== subject.campaign_slug
    || !isNonEmptyString(own.requested_route)
    || own.final_document_route !== own.requested_route
    || !subject.routes.includes(own.requested_route)
    || !subject.viewports.includes(own.viewport)) return "fail";
  return isNonEmptyString(currentBuild) && own.build_fingerprint === currentBuild ? null : "stale";
}

const PAGE_NOT_CAPTURED = "page_not_captured";

// Built output that no longer matches the recorded build: doctor's
// derived.build_output_fingerprint, whose status is pass only when the
// output under _site/<slug>/ is the one `record build` recorded. Any other
// value, null included, is drift. A caller that passes no value (undefined)
// reads without the output check.
const outputDrifted = (buildOutput) => buildOutput !== undefined && buildOutput?.status !== "pass";

export function readMediaWeight({ record, pageLoad, currentBuild = null, buildOutput = undefined, qcStandIns = null, rederivers = null } = {}) {
  if (record === undefined || record === null) return [];
  const checks = POLISH_RECORDS.media_weight.checks;
  const measuredAt = validTime(record?.measured_at) ? record.measured_at : null;
  const cells = Array.isArray(record?.cells) ? record.cells.filter(isPlainObject) : [];
  const unreproduced = (subject) => unreproducedRow({ subject, check: subject.check }, E, { leg: "polish", measuredAt });
  const cellResult = (check, route, viewport) => unreproduced({ check, page: route, viewport, key: "cell" });
  // A failed cell: one result per subject it lists, and one per media_weight
  // check it lists no subject for, so a failed cell, even one listing
  // nothing, is never silent.
  const failCell = (cell) => {
    const subjects = cellSubjects(cell);
    return [
      ...subjects.map(unreproduced),
      ...checks.filter((check) => !subjects.some((subject) => subject.check === check)).map((check) => cellResult(check, cell?.route ?? null, cell?.viewport ?? null)),
    ];
  };
  // A record-level failure: every listed cell fails, and every route ×
  // viewport that the record or page_load declares or captured but no cell
  // lists gets one result per media_weight check, so a missing route is never
  // silent.
  const failAll = () => {
    const listed = new Set(cells.map((cell) => cellKey(cell.route, cell.viewport)));
    const unlisted = new Map();
    const note = (route, viewport) => {
      const key = cellKey(route, viewport);
      if (isNonEmptyString(route) && isNonEmptyString(viewport) && !listed.has(key)) unlisted.set(key, { route, viewport });
    };
    for (const { route, viewport } of [...declaredGrid(record?.subject), ...declaredGrid(pageLoad?.subject)]) note(route, viewport);
    for (const capture of Array.isArray(pageLoad?.captures) ? pageLoad.captures : []) note(capture?.subject?.requested_route, capture?.subject?.viewport);
    for (const entry of Array.isArray(pageLoad?.measurement?.missing) ? pageLoad.measurement.missing : []) note(entry?.route, entry?.viewport);
    const rows = [
      ...cells.flatMap(failCell),
      ...[...unlisted.values()].flatMap(({ route, viewport }) => checks.map((check) => cellResult(check, route, viewport))),
    ];
    return rows.length ? rows : [unreproduced({ check: "media.weight", page: null, key: "media_weight" })];
  };
  const resolved = resolvePolishRules({ check: checks[0], qcStandIns, rederivers });
  if (resolved.status === "missing") return [];
  if (resolved.status !== "loaded") return failAll();
  const { rules } = resolved;

  // Record level: producer, integrity, thresholds, the declared subject and
  // its binding to page_load, the page_load measurement summary, and the
  // record vocabulary. Any failure makes every result unreproducible.
  if (!isPlainObject(record)
    || record.schema_version !== MEDIA_WEIGHT_SCHEMA
    || record.performed_by !== QC_PRODUCERS.polish
    || !measuredAt
    || record.integrity !== mediaWeightIntegrity(record)
    || !sameJson(record.thresholds, rules.thresholds)
    || !declaredSubjectOk(record.subject)
    || !isPlainObject(pageLoad)
    || pageLoad.schema_version !== PAGE_LOAD_SCHEMA
    || pageLoad.performed_by !== QC_PRODUCERS.polish
    || !sameJson(unbound(record.subject), unbound(pageLoad.subject))
    || !Array.isArray(pageLoad.captures)
    || !measurementSummaryOk(pageLoad.measurement, declaredGrid(record.subject), pageLoad.captures.length)
    || !Array.isArray(record.cells)
    || cells.length !== record.cells.length
    || !recordVocabularyOk(record, rules.vocabulary)
    || uncapturedRoutesOf(record) === null
    || uncapturedPageIdsOf(record) === null) return failAll();

  // The declared grid (routes × viewports) is the capture set and the cell
  // set: exactly one page_load capture and one cell per declared route and
  // viewport, none missing, none added, none twice.
  const gridKeys = declaredGrid(record.subject).map(({ route, viewport }) => cellKey(route, viewport));
  const captureByKey = new Map();
  for (const capture of pageLoad.captures) {
    const key = cellKey(capture?.subject?.requested_route, capture?.subject?.viewport);
    if (!isPlainObject(capture) || captureByKey.has(key)) return failAll();
    captureByKey.set(key, capture);
  }
  const cellKeys = cells.map((cell) => cellKey(cell.route, cell.viewport));
  if (new Set(cellKeys).size !== cellKeys.length
    || cellKeys.length !== gridKeys.length
    || captureByKey.size !== gridKeys.length
    || !gridKeys.every((key) => captureByKey.has(key) && cellKeys.includes(key))) return failAll();

  // Both enclosing subjects are bound to the current build, and the built
  // output is still that build's; an absent, null or other build on either,
  // or output drift, reads stale_binding.
  const recordBound = isNonEmptyString(currentBuild)
    && record.subject.build_fingerprint === currentBuild
    && pageLoad.subject.build_fingerprint === currentBuild
    && !outputDrifted(buildOutput);
  const results = [];
  // A spec page with no source mapping: one result per 1.3 check and viewport,
  // unexercised / page_not_captured; keyed "cell" on its public route, or
  // "page:<page_id>" with no page when it has no resolvable route.
  const uncaptured = [
    ...uncapturedRoutesOf(record).map((route) => ({ page: route, key: "cell" })),
    ...uncapturedPageIdsOf(record).map((pageId) => ({ page: null, key: `page:${pageId}` })),
  ];
  for (const { page, key } of uncaptured) {
    for (const viewport of record.subject.viewports) {
      for (const check of checks) {
        const subject = { check, page, viewport, key };
        const row = unreproducedRow({ subject, check }, PAGE_NOT_CAPTURED, { leg: "polish", measuredAt });
        results.push(recordBound ? row : staleRow(row));
      }
    }
  }
  for (const cell of cells) {
    const capture = captureByKey.get(cellKey(cell.route, cell.viewport));
    const binding = captureBindingProblem(capture, record.subject, currentBuild);
    if (binding === "fail" || !cellReproduces(cell, capture)) {
      results.push(...failCell(cell));
      continue;
    }
    const bound = recordBound && binding === null;
    let derived;
    try {
      derived = rules.evaluate(cell, record.thresholds);
    } catch {
      derived = null;
    }
    // Every derived subject is one the cell lists (cellSubjects), exactly:
    // its own page, viewport and key, and no other field.
    const own = new Set(cellSubjects(cell).map((subject) => canonicalJson(subject)));
    if (!Array.isArray(derived) || !derived.every((item) => checks.includes(item?.check) && validDerived(item, item.check) && own.has(canonicalJson(item.subject)))) {
      results.push(...failCell(cell));
      continue;
    }
    for (const item of derived) {
      const members = item.members ?? [];
      const row = {
        schema: QC_RESULT_SCHEMA,
        id: qcResultId(item.subject),
        check: item.check,
        leg: "polish",
        result: item.result,
        reason_code: item.result === "pass" ? null : item.reason_code,
        subject: item.subject,
        state_fingerprint: qcStateFingerprint({ subject: item.subject, state: item.state }),
        observation: isPlainObject(item.observation) ? item.observation : {},
        members,
        accept_eligible: item.accept_eligible && qcAcceptEligible(item.result, members),
        coverage: item.coverage ?? { observed: 1, expected: 1, limits: [] },
        measured_at: measuredAt,
        producer: QC_PRODUCERS.polish,
      };
      results.push(bound ? row : staleRow(row));
    }
  }
  return results;
}

// The readability record's subject fields besides build_fingerprint.
const READABILITY_SUBJECT_FIELDS = Object.freeze(["source_package_material_fingerprint", "campaign_slug", "route_source", "routes", "viewports"]);
const READABILITY_DERIVED_FIELDS = Object.freeze(["fg_srgb", "bg_srgb", "gamut_clipped", "ratio", "size_class", "required"]);
const contrast = contrastToolkit();
const canonicalTime = (value) => validTime(value) && new Date(value).toISOString() === value;

// Every derived field of a stored element re-derives exactly from its raw
// computed colours and font through the shared contrast helper.
function readabilityElementReproduces(element) {
  let derived;
  try {
    derived = contrast.deriveElementMeasurement({
      fg_raw: element.fg_raw,
      fill_raw: element.fill_raw,
      bg_layers_raw: element.bg_layers_raw,
      font_size_px: element.font_size_px,
      font_weight: element.font_weight,
    });
  } catch {
    return false;
  }
  return READABILITY_DERIVED_FIELDS.every((field) => Object.hasOwn(element, field) && sameJson(element[field], derived[field]));
}

// A crop reference resolves when its file under the target repo holds bytes
// whose sha256 is the one recorded.
function readabilityCropResolves(ref, targetRepo) {
  if (!isNonEmptyString(targetRepo) || !isPlainObject(ref) || !isNonEmptyString(ref.path) || !isNonEmptyString(ref.sha256)) return false;
  try {
    const file = resolve(targetRepo, ref.path);
    if (!statSync(file).isFile()) return false;
    return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}` === ref.sha256;
  } catch {
    return false;
  }
}

// The readability record (contract 2.4 Result rules), read in precedence
// order:
// 1. the record and cell reader checks (producer, schema, helper version,
//    integrity, canonical measured_at, the constant thresholds and limits,
//    the fixed producer values, the vocabulary, the exact routes × viewports
//    grid, every element re-derived through the shared helper, and each
//    shared cell's page_load integrity) → evidence_not_reproducible;
// 2. the binding (build, source package, and doctor's output fingerprint)
//    → every row stale_binding, before any route-set result;
// 3. the built route set, recomputed from _site/<slug>/: a captured route
//    the record lacks, or one over the route cap, reads page_not_captured;
//    a recorded route outside it, or different uncaptured routes or
//    enumeration cap, → evidence_not_reproducible;
// 4. the rows READABILITY_QC_RULES.evaluate derives from each cell.
// `campaignSlug` is the packet's slug; a missing one never matches.
export function readReadability({ record, pageLoad = null, currentBuild = null, currentSource = null, buildOutput = null, campaignSlug = null, targetRepo = null, qcStandIns = null, rederivers = null } = {}) {
  if (record === undefined || record === null) return [];
  const [check] = POLISH_RECORDS.readability.checks;
  const measuredAt = canonicalTime(record?.measured_at) ? record.measured_at : null;
  const cells = Array.isArray(record?.cells) ? record.cells.filter(isPlainObject) : [];
  const subjectOf = (page, viewport, key) => ({ check, page, viewport, key });
  const rowOf = (subject, reasonCode) => unreproducedRow({ subject, check }, reasonCode, { leg: "polish", measuredAt });
  const unique = (rows) => [...new Map(rows.map((row) => [row.id, row])).values()];
  let rules = null;
  // A failed cell: one result per row the cell names and its `cell` row, so
  // a failed cell is never silent and an accept of one of its rows lapses
  // rather than orphans. The keys come from rules.rowKeys, which reads
  // neither the record's thresholds nor any field the checks reject.
  const failCell = (cell) => {
    let named = [];
    try {
      named = typeof rules?.rowKeys === "function" ? rules.rowKeys(cell) : [];
    } catch {
      named = [];
    }
    const keys = [...new Set([...(Array.isArray(named) ? named.filter(isNonEmptyString) : []), "cell"])];
    return keys.map((key) => rowOf(subjectOf(cell?.route ?? null, cell?.viewport ?? null, key), E));
  };
  // A record-level failure: every listed cell fails; every route the subject
  // or a cell names, at every recorded or fixed viewport, that no cell lists
  // gets its `cell` row; and the uncaptured routes and the enumeration cap
  // keep the rows they would read.
  const failAll = () => {
    const listed = new Set(cells.map((cell) => cellKey(cell.route, cell.viewport)));
    const routes = [...(Array.isArray(record?.subject?.routes) ? record.subject.routes : []), ...cells.map((cell) => cell.route)].filter(isNonEmptyString);
    const uncaptured = (Array.isArray(record?.uncaptured_routes) ? record.uncaptured_routes : []).filter(isNonEmptyString);
    let fixed = [];
    try {
      fixed = Array.isArray(rules?.viewports) ? rules.viewports : [];
    } catch {
      fixed = [];
    }
    const viewports = [...(Array.isArray(record?.subject?.viewports) ? record.subject.viewports : []), ...fixed].filter(isNonEmptyString);
    const grid = [...new Set([...routes, ...uncaptured])].flatMap((route) => [...new Set(viewports)].map((viewport) => ({ route, viewport })));
    const rows = [
      ...cells.flatMap(failCell),
      ...grid.filter(({ route, viewport }) => !listed.has(cellKey(route, viewport))).map(({ route, viewport }) => rowOf(subjectOf(route, viewport, "cell"), E)),
      ...(record?.route_enumeration_capped === true ? [rowOf(subjectOf(null, null, "scope"), E)] : []),
    ];
    return unique(rows.length ? rows : [rowOf(subjectOf(null, null, "readability"), E)]);
  };
  const evaluate = (cell, cropAvailable) => {
    try {
      return rules.evaluate(cell, record.thresholds, { cropAvailable });
    } catch {
      return null;
    }
  };
  const resolved = resolvePolishRules({ check, qcStandIns, rederivers });
  if (resolved.status === "missing") return [];
  if (resolved.status !== "loaded") return failAll();
  ({ rules } = resolved);
  if (typeof rules.routes !== "function" || typeof rules.cellShapeOk !== "function") return failAll();

  // 1. Record level.
  const subject = record?.subject;
  const viewports = rules.viewports;
  if (!isPlainObject(record)
    || record.schema_version !== rules.schema_version
    || record.performed_by !== QC_PRODUCERS.polish
    || record.helper_version !== rules.helper_version
    || record.helper_version !== contrast.version
    || !measuredAt
    || record.integrity !== polishRecordIntegrity(record)
    || !sameJson(record.thresholds, rules.thresholds)
    || !sameJson(record.limits, rules.limits)
    || !hasExactly(subject, READABILITY_SUBJECT_FIELDS)
    || !(subject.source_package_material_fingerprint === null || isNonEmptyString(subject.source_package_material_fingerprint))
    || !sameJson(subject.viewports, viewports)
    || subject.route_source !== rules.route_source
    || !isNonEmptyString(campaignSlug)
    || subject.campaign_slug !== campaignSlug
    || !uniqueStrings(subject.routes)
    || !Array.isArray(record.uncaptured_routes)
    || !(record.uncaptured_routes.length === 0 || uniqueStrings(record.uncaptured_routes))
    || record.uncaptured_routes.some((route) => subject.routes.includes(route))
    || typeof record.route_enumeration_capped !== "boolean"
    || !Array.isArray(record.cells)
    || cells.length !== record.cells.length
    || !cells.every((cell) => rules.cellShapeOk(cell))) return failAll();
  // The cell set is exactly routes × viewports: none missing, none added,
  // none twice, every cell's route and viewport in the subject.
  const gridKeys = declaredGrid(subject).map(({ route, viewport }) => cellKey(route, viewport));
  const cellKeys = cells.map((cell) => cellKey(cell.route, cell.viewport));
  if (new Set(cellKeys).size !== cellKeys.length
    || cellKeys.length !== gridKeys.length
    || !cells.every((cell) => subject.routes.includes(cell.route) && subject.viewports.includes(cell.viewport))) return failAll();

  // Cell level: every element re-derives, and a shared cell's page_load
  // integrity is that route × viewport's capture integrity.
  const captures = Array.isArray(pageLoad?.captures) ? pageLoad.captures : [];
  const cellReadable = (cell) => {
    if (!cell.elements.every(readabilityElementReproduces)) return false;
    if (cell.page_load_integrity === null) return true;
    const matching = captures.filter((capture) => capture?.subject?.requested_route === cell.route && capture?.subject?.viewport === cell.viewport);
    if (matching.length !== 1) return false;
    const [capture] = matching;
    return isPlainObject(capture.integrity)
      && sameJson(buildPolishCaptureIntegrity(capture), capture.integrity)
      && capture.integrity.projection_fingerprint === cell.page_load_integrity;
  };

  // 2. Binding.
  const bound = isNonEmptyString(currentBuild)
    && subject.build_fingerprint === currentBuild
    && subject.source_package_material_fingerprint === (isNonEmptyString(currentSource) ? currentSource : null)
    && !outputDrifted(buildOutput ?? null);

  // 3. The recomputed route set, read only when the output is the build's.
  const results = [];
  const notCaptured = (route) => subject.viewports.map((viewport) => rowOf(subjectOf(route, viewport, "cell"), PAGE_NOT_CAPTURED));
  const scopeRow = () => rowOf(subjectOf(null, null, "scope"), "route_enumeration_capped");
  if (bound) {
    let built;
    try {
      built = rules.routes(targetRepo, campaignSlug);
    } catch {
      built = null;
    }
    if (!isPlainObject(built) || built.ok !== true
      || !subject.routes.every((route) => built.routes.includes(route))
      || !sameJson(record.uncaptured_routes, built.uncaptured_routes)
      || record.route_enumeration_capped !== built.route_enumeration_capped) return failAll();
    for (const route of built.routes.filter((route) => !subject.routes.includes(route))) results.push(...notCaptured(route));
  }
  for (const route of record.uncaptured_routes) results.push(...notCaptured(route).map((row) => (bound ? row : staleRow(row))));
  if (record.route_enumeration_capped) results.push(bound ? scopeRow() : staleRow(scopeRow()));

  // 4. The rows.
  const cropAvailable = (ref) => rules.cropRefShapeOk?.(ref) === true && readabilityCropResolves(ref, targetRepo);
  for (const cell of cells) {
    if (!cellReadable(cell)) {
      results.push(...failCell(cell));
      continue;
    }
    const derived = evaluate(cell, cropAvailable);
    // Every derived subject is the cell's own page and viewport, each key once.
    const keys = Array.isArray(derived) ? derived.map((item) => item?.subject?.key) : [];
    if (!Array.isArray(derived) || new Set(keys).size !== keys.length || !derived.every((item) => item?.check === check
      && validDerived(item, check)
      && hasExactly(item.subject, ["check", "page", "viewport", "key"])
      && item.subject.page === cell.route
      && item.subject.viewport === cell.viewport
      && isNonEmptyString(item.subject.key))) {
      results.push(...failCell(cell));
      continue;
    }
    for (const item of derived) {
      const members = item.members ?? [];
      const row = {
        schema: QC_RESULT_SCHEMA,
        id: qcResultId(item.subject),
        check,
        leg: "polish",
        result: item.result,
        reason_code: item.result === "pass" ? null : item.reason_code,
        subject: item.subject,
        state_fingerprint: qcStateFingerprint({ subject: item.subject, state: item.state }),
        observation: isPlainObject(item.observation) ? item.observation : {},
        members,
        accept_eligible: item.accept_eligible && qcAcceptEligible(item.result, members),
        coverage: item.coverage ?? { observed: 1, expected: 1, limits: [] },
        measured_at: measuredAt,
        producer: QC_PRODUCERS.polish,
      };
      results.push(bound ? row : staleRow(row));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Every current result, per leg, and the silence rule

const QA_ALWAYS = Object.freeze(["tracking.url", "tracking.order", "tracking.tag"]);
const QA_CONTENT = Object.freeze(["content_param"]);
const QA_POLICY = Object.freeze(["policy.presence", "policy.availability"]);
const POLISH_CHECKS = Object.freeze(qcChecksForLeg("polish"));
// The Polish dispatch: each package-owned visual_review record, the checks
// read from it, and its reader. Each record is read, and its silence judged,
// on its own.
const POLISH_RECORDS = Object.freeze({
  media_weight: Object.freeze({ checks: Object.freeze(qcChecksForRecord("media_weight")), read: readMediaWeight }),
  readability: Object.freeze({ checks: Object.freeze(qcChecksForRecord("readability")), read: readReadability }),
});
const STORE_POLICY_FIELDS = Object.freeze(Object.keys(STORE_PAGE_MATCHERS));

// Applicability is decided without the leg running: the tracking checks
// always, the content-param check when analytics.params.content is non-empty,
// the policy-link checks when a store policy field is.
export function applicableQaChecks(spec) {
  const content = spec?.analytics?.params?.content;
  const hasContent = Array.isArray(content) ? content.length > 0 : isPlainObject(content) && Object.keys(content).length > 0;
  const hasPolicy = STORE_POLICY_FIELDS.some((field) => isNonEmptyString(spec?.campaign?.[field]));
  return [...QA_ALWAYS, ...(hasContent ? QA_CONTENT : []), ...(hasPolicy ? QA_POLICY : [])];
}

// A leg has a stage record unless the stage is absent or is the pending
// placeholder prepare-build seeds (status pending, nothing recorded). Any other
// stage, whatever its status, is a recorded leg.
function stageRecorded(stage) {
  if (!isPlainObject(stage)) return false;
  if (stage.status !== "pending") return true;
  return isPlainObject(stage.evidence)
    || (isPlainObject(stage.identity) && Object.keys(stage.identity).length > 0)
    || (Array.isArray(stage.outputs) && stage.outputs.length > 0);
}

const silence = (leg, check, reasonCode) => ({ check, leg, result: "unexercised", reason_code: reasonCode, count: 0, pages: [] });

// The handoff coverage entries for applicable checks a leg holds no row for.
// A leg with no stage record reads leg_not_run. A recorded leg never makes an
// applicable check silent: no row reads not_captured_by_this_version (the
// record predates the check, its module is missing or not yet loaded, or the
// loaded rules gave no row), except that a module that failed to load reads
// evidence_not_reproducible when the record holds the leg's QC evidence.
export function handoffCoverage({ report, spec, results = [], qcStandIns = null, rederivers = null }) {
  const entries = [];
  const hasRow = (leg, check) => results.some((row) => row.leg === leg && row.check === check);
  const silentReason = (failed) => (failed ? E : QC_REASON.NOT_CAPTURED);

  const qaStage = report?.stages?.qa;
  const qaChecks = applicableQaChecks(spec);
  if (!stageRecorded(qaStage)) {
    for (const check of qaChecks) entries.push(silence("qa", check, QC_REASON.LEG_NOT_RUN));
  } else {
    const captured = Array.isArray(qaStage.evidence?.qc_results);
    for (const check of qaChecks) {
      if (hasRow("qa", check)) continue;
      entries.push(silence("qa", check, silentReason(captured && qaRederiver(check, { qcStandIns, rederivers }).status === "failed")));
    }
  }

  const polishStage = report?.stages?.polish;
  if (!stageRecorded(polishStage)) {
    for (const check of POLISH_CHECKS) entries.push(silence("polish", check, QC_REASON.LEG_NOT_RUN));
  } else {
    const visual = polishStage.evidence?.visual_review;
    for (const [name, { checks }] of Object.entries(POLISH_RECORDS)) {
      const captured = name === "media_weight" ? isPlainObject(visual?.page_load) && visual.media_weight != null : visual?.[name] != null;
      for (const check of checks) {
        if (hasRow("polish", check)) continue;
        const failed = captured && resolvePolishRules({ check, qcStandIns, rederivers }).status === "failed";
        entries.push(silence("polish", check, silentReason(failed)));
      }
    }
  }
  return entries;
}

// The campaign slug the Polish records bind to: the packet's, read from
// packetPath; with no readable packet, the Assembly Report's (which capture
// requires to equal the packet's). Null when neither names one.
function packetCampaignSlug({ packetPath, report }) {
  if (isNonEmptyString(packetPath)) {
    try {
      const slug = JSON.parse(readFileSync(packetPath, "utf8"))?.campaign?.public_route_slug;
      return isNonEmptyString(slug) ? slug : null;
    } catch {
      // No readable packet: fall through to the report.
    }
  }
  const slug = report?.identity?.public_route_slug;
  return isNonEmptyString(slug) ? slug : null;
}

// Every current QC result `next` and `checkpoint accept` judge, read from
// data already on disk: the doctor run, the Assembly Report, and the full QA
// verdict the QA stage names. No request is made.
export function readCurrentQcResults({ report, doctor, spec = null, targetRepo, packetPath = null, reportPath = null, qcStandIns = null, rederivers = null }) {
  const currentBuild = currentBuildFingerprint(report);
  const doctorResults = (Array.isArray(doctor?.derived?.qc_results) ? doctor.derived.qc_results : []).filter((row) => isPlainObject(row) && row.leg === "doctor");
  const visual = report?.stages?.polish?.evidence?.visual_review;
  const recorded = isPlainObject(visual) ? Object.entries(POLISH_RECORDS).filter(([name]) => visual[name] != null) : [];
  const polishContext = recorded.length ? {
    pageLoad: visual.page_load,
    currentBuild,
    currentSource: currentSourcePackageMaterialFingerprint(report),
    buildOutput: doctor?.derived?.build_output_fingerprint ?? null,
    campaignSlug: packetCampaignSlug({ packetPath, report }),
    targetRepo,
    qcStandIns,
    rederivers,
  } : null;
  const polishResults = recorded.flatMap(([name, { read }]) => read({ ...polishContext, record: visual[name] }));
  const qaStage = report?.stages?.qa;
  const qaResults = Array.isArray(qaStage?.evidence?.qc_results)
    ? readQaResults({
      stageEvidence: qaStage.evidence,
      stage: qaStage,
      fullVerdict: readQaFullVerdict({ stage: qaStage, targetRepo, packetPath, reportPath }),
      currentBuild,
      qaCurrency: doctor?.derived?.input_currency?.stages?.qa,
      qcStandIns,
      rederivers,
    })
    : [];
  const results = [...doctorResults, ...polishResults, ...qaResults];
  return { results, coverage: handoffCoverage({ report, spec, results, qcStandIns, rederivers }) };
}
