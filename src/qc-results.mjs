// The shared QC result contract: one result shape,
// one storage rule per leg, and the readers that re-derive every stored result
// from its raw package capture on every read.
//
// Storage per leg:
// - doctor: derived.qc_results[], recomputed from built HTML on every run;
// - polish: stages.polish.evidence.visual_review.media_weight, re-derived from
//   its cells and cross-checked against the page_load capture;
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
import { sameFile } from "./fs-identity.mjs";
import { buildPolishCaptureIntegrity, canonicalJson, captureOrigin, mediaFetchedResources } from "./polish-capture.mjs";
import { currentBuildFingerprint } from "./polish-gate.mjs";
import { sidecarPathForPacket } from "./qa-sidecar.mjs";
import { QA_ASSERTION_FAMILY_VOCABULARY, QA_SCHEMA_VERSION, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { QC_CHECK_REGISTRY, loadedQcRederivers, qcChecksForLeg } from "./qc-check-registry.mjs";
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

// QA verdict mapping per result (contract 1.0 Result rules). unexercised is
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

export function resolvePolishRules({ qcStandIns, rederivers } = {}) {
  const standIn = qcStandIns?.polish;
  if (isPlainObject(standIn)) return { status: "loaded", rules: standIn };
  const entry = (rederivers || loadedQcRederivers())?.["media.weight"];
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

// A unit re-deriver's output, checked against the 1.0 vocabulary.
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
// Polish reader site (media_weight against its page_load capture)

// Unkeyed tamper evidence over every field but `integrity`, the canonical-JSON
// + sha256 pattern of buildPolishCaptureIntegrity.
export function mediaWeightIntegrity(record) {
  const { integrity: _ignored, ...rest } = record || {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

const inVocabulary = (vocabulary, field, value) => Array.isArray(vocabulary?.[field]) && vocabulary[field].includes(value);
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

// The subjects a cell lists whatever happens to it: one weight result per
// resource, one per unfetched <video>, one oversize result per <img>.
function cellSubjects(cell) {
  const route = cell?.route ?? null;
  const viewport = cell?.viewport ?? null;
  const subjects = [];
  for (const resource of Array.isArray(cell?.resources) ? cell.resources : []) {
    subjects.push({ check: "media.weight", page: route, viewport, key: resource?.resource_id ?? null });
  }
  for (const video of Array.isArray(cell?.videos) ? cell.videos : []) {
    if (Array.isArray(video?.resource_ids) && video.resource_ids.length) continue;
    subjects.push({ check: "media.weight", page: route, viewport, key: `video:${video?.element_index}` });
  }
  for (const image of Array.isArray(cell?.images) ? cell.images : []) {
    subjects.push({ check: "media.oversize", page: route, viewport, key: `${image?.resource_id}:${image?.element_path}` });
  }
  return subjects;
}

function recordVocabularyOk(record, vocabulary) {
  return record.cells.every((cell) => isPlainObject(cell)
    && isNonEmptyString(cell.route)
    && isNonEmptyString(cell.viewport)
    && Array.isArray(record.subject?.routes) && record.subject.routes.includes(cell.route)
    && Array.isArray(record.subject?.viewports) && record.subject.viewports.includes(cell.viewport)
    && typeof cell.dpr === "number" && cell.dpr > 0
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
      && typeof image.complete === "boolean"
      && typeof image.hidden === "boolean"
      && isPair(image.natural)
      && isPair(image.rendered)
      && inVocabulary(vocabulary, "object_fit", image.object_fit)
      && inVocabulary(vocabulary, "loading", image.loading))
    && Array.isArray(cell.videos) && cell.videos.every((video) => isPlainObject(video)
      && Number.isInteger(video.element_index)
      && Array.isArray(video.resource_ids) && video.resource_ids.every(isNonEmptyString)
      && typeof video.declared_origin_equal === "boolean"));
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

// The chain the ledger implies for a requested href, never the record's: the
// final hop is the one entry that names the requested href in its
// match_resource_ids and answered with a non-redirect status (the requested
// entry itself when it was not redirected), and the hops are that final entry
// plus every redirect entry it names. Null when the ledger does not single out
// one final hop. The ledger keeps no Location, so it fixes the hop set and
// both ends; it cannot order intermediate hops.
function ledgerChain(requestedId, entries, byId) {
  const requested = byId.get(requestedId);
  if (!requested) return null;
  let final = requested;
  if (isRedirectEntry(requested)) {
    const finals = entries.filter((entry) => !isRedirectEntry(entry) && Array.isArray(entry.match_resource_ids) && entry.match_resource_ids.includes(requestedId));
    if (finals.length !== 1) return null;
    [final] = finals;
  }
  if (!Array.isArray(final.match_resource_ids)) return null;
  const hops = new Set([final.resource_id, requestedId]);
  for (const id of final.match_resource_ids) {
    const entry = byId.get(id);
    if (entry && entry !== final && isRedirectEntry(entry)) hops.add(id);
  }
  return { final, hops };
}

// Every field of a cell that has a raw counterpart, checked against the
// page_load capture for the same route and viewport. True when it re-derives.
// Every set the reader consumes is derived from the capture and required to
// match exactly: each resource's hop set and final hop (ledgerChain), the
// cell's resource set (the chains partition the capture's ledger: every entry
// in exactly one resource's chain), and the cell's video set (every <video>
// media element). A truncated chain, a dropped resource or a dropped video
// does not re-derive.
function cellReproduces(cell, capture) {
  if (!isPlainObject(capture) || !isPlainObject(capture.integrity)) return false;
  if (!sameJson(buildPolishCaptureIntegrity(capture), capture.integrity)) return false;
  if (cell.page_load_integrity !== capture.integrity.projection_fingerprint) return false;
  if (cell.capture_status !== capture.measurement_status) return false;
  const finalOrigin = capture.document_response?.final_origin;
  if (!isNonEmptyString(finalOrigin) || cell.document_origin !== finalOrigin) return false;
  if (!Array.isArray(capture.resource_ledger?.entries) || !capture.resource_ledger.entries.every((entry) => isPlainObject(entry) && isNonEmptyString(entry.resource_id))) return false;
  const entries = capture.resource_ledger.entries;
  const byId = new Map(entries.map((entry) => [entry.resource_id, entry]));
  if (byId.size !== entries.length) return false;
  const covered = new Set();
  for (const resource of cell.resources) {
    const { chain } = resource;
    if (chain[0].resource_id !== resource.resource_id || chain[0].url !== resource.url) return false;
    const expected = ledgerChain(resource.resource_id, entries, byId);
    if (!expected) return false;
    const { final } = expected;
    const chainIds = chain.map((hop) => hop.resource_id);
    if (chain.at(-1).resource_id !== final.resource_id
      || new Set(chainIds).size !== chainIds.length
      || chainIds.length !== expected.hops.size
      || !chainIds.every((id) => expected.hops.has(id))) return false;
    for (const [index, hop] of chain.entries()) {
      const entry = byId.get(hop.resource_id);
      if (!entry || hop.url !== entry.url || !Array.isArray(entry.statuses) || !entry.statuses.includes(hop.status)) return false;
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
  const media = Array.isArray(capture.media) ? capture.media : [];
  const videoIndexes = media.filter((element) => isPlainObject(element) && element.tag_name === "video").map((element) => element.element_index).sort((a, b) => a - b);
  const listedIndexes = cell.videos.map((video) => video.element_index).sort((a, b) => a - b);
  if (!sameJson(listedIndexes, videoIndexes)) return false;
  for (const video of cell.videos) {
    const element = media.find((candidate) => candidate?.element_index === video.element_index);
    if (!isPlainObject(element) || !Array.isArray(element.source_references)) return false;
    const fetched = mediaFetchedResources(element, entries.filter((entry) => Array.isArray(entry?.match_resource_ids))).map((entry) => entry.resource_id).sort();
    if (!sameJson([...video.resource_ids].sort(), fetched)) return false;
    const declaredSameOrigin = element.source_references.some((reference) => captureOrigin(reference?.url) === finalOrigin);
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

export function readMediaWeight({ record, pageLoad, currentBuild = null, qcStandIns = null, rederivers = null } = {}) {
  if (record === undefined || record === null) return [];
  const measuredAt = validTime(record?.measured_at) ? record.measured_at : null;
  const cells = Array.isArray(record?.cells) ? record.cells.filter(isPlainObject) : [];
  const unreproduced = (subject) => unreproducedRow({ subject, check: subject.check }, E, { leg: "polish", measuredAt });
  const cellResult = (check, route, viewport) => unreproduced({ check, page: route, viewport, key: "cell" });
  // A failed cell: one result per subject it lists, and one per 1.3 check it
  // lists no subject for, so a failed cell, even one listing nothing, is
  // never silent.
  const failCell = (cell) => {
    const subjects = cellSubjects(cell);
    return [
      ...subjects.map(unreproduced),
      ...POLISH_CHECKS.filter((check) => !subjects.some((subject) => subject.check === check)).map((check) => cellResult(check, cell?.route ?? null, cell?.viewport ?? null)),
    ];
  };
  // A record-level failure: every listed cell fails, and every route ×
  // viewport that the record or page_load declares or captured but no cell
  // lists gets one result per 1.3 check, so a missing route is never silent.
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
      ...[...unlisted.values()].flatMap(({ route, viewport }) => POLISH_CHECKS.map((check) => cellResult(check, route, viewport))),
    ];
    return rows.length ? rows : [unreproduced({ check: "media.weight", page: null, key: "media_weight" })];
  };
  const resolved = resolvePolishRules({ qcStandIns, rederivers });
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
    || !recordVocabularyOk(record, rules.vocabulary)) return failAll();

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

  // Both enclosing subjects are bound to the current build; an absent, null
  // or other build on either reads stale_binding.
  const recordBound = isNonEmptyString(currentBuild)
    && record.subject.build_fingerprint === currentBuild
    && pageLoad.subject.build_fingerprint === currentBuild;
  const results = [];
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
    if (!Array.isArray(derived) || !derived.every((item) => ["media.weight", "media.oversize"].includes(item?.check) && validDerived(item, item.check) && own.has(canonicalJson(item.subject)))) {
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

// ---------------------------------------------------------------------------
// Every current result, per leg, and the silence rule

const QA_ALWAYS = Object.freeze(["tracking.url", "tracking.order", "tracking.tag"]);
const QA_CONTENT = Object.freeze(["content_param"]);
const QA_POLICY = Object.freeze(["policy.presence", "policy.availability"]);
const POLISH_CHECKS = Object.freeze(qcChecksForLeg("polish"));
const STORE_POLICY_FIELDS = Object.freeze(Object.keys(STORE_PAGE_MATCHERS));

// Applicability is decided without the leg running: 1.1 always, 1.2 when
// analytics.params.content is non-empty, 1.4 when a store policy field is.
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
    const captured = isPlainObject(visual?.page_load) && visual.media_weight != null;
    const failed = captured && resolvePolishRules({ qcStandIns, rederivers }).status === "failed";
    for (const check of POLISH_CHECKS) {
      if (!hasRow("polish", check)) entries.push(silence("polish", check, silentReason(failed)));
    }
  }
  return entries;
}

// Every current QC result `next` and `checkpoint accept` judge, read from
// data already on disk: the doctor run, the Assembly Report, and the full QA
// verdict the QA stage names. No request is made.
export function readCurrentQcResults({ report, doctor, spec = null, targetRepo, packetPath = null, reportPath = null, qcStandIns = null, rederivers = null }) {
  const currentBuild = currentBuildFingerprint(report);
  const doctorResults = (Array.isArray(doctor?.derived?.qc_results) ? doctor.derived.qc_results : []).filter((row) => isPlainObject(row) && row.leg === "doctor");
  const visual = report?.stages?.polish?.evidence?.visual_review;
  const polishResults = isPlainObject(visual) && visual.media_weight != null
    ? readMediaWeight({ record: visual.media_weight, pageLoad: visual.page_load, currentBuild, qcStandIns, rederivers })
    : [];
  const qaStage = report?.stages?.qa;
  const qaResults = Array.isArray(qaStage?.evidence?.qc_results)
    ? readQaResults({
      stageEvidence: qaStage.evidence,
      stage: qaStage,
      fullVerdict: readQaFullVerdict({ stage: qaStage, targetRepo, packetPath, reportPath }),
      currentBuild,
      qcStandIns,
      rederivers,
    })
    : [];
  const results = [...doctorResults, ...polishResults, ...qaResults];
  return { results, coverage: handoffCoverage({ report, spec, results, qcStandIns, rederivers }) };
}
