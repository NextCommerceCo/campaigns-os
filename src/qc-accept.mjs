// Operator accepts of QC warnings. An accept is stored
// apart from the measurement, in report.qc_accepts[], and changes only a
// result's disposition (open → operator_accepted). It never changes the
// result, doctor status, `next` status, QA disposition, or a stage status.
//
// Records are checked on every read (assessQcAccepts). The integrity checksum
// is unkeyed tamper evidence, not proof of authorship: a record a process with
// the same file access fully reconstructs reads as active, and that is the
// documented outcome.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { isNamedHuman, validateWaiverAttribution } from "./checkpoint-waiver.mjs";
import { DOCTOR_SIDECAR_SCHEMA } from "./doctor-sidecar.mjs";
import { cmd } from "./install-invocation.mjs";
import { canonicalJson } from "./polish-capture.mjs";
import { QC_CHECK_REGISTRY } from "./qc-check-registry.mjs";
import { QC_LEGS, QC_REASON, fingerprint12, qcResultRef } from "./qc-results.mjs";
import { shellToken } from "./shell-token.mjs";

export const QC_ACCEPT_SCHEMA = "campaigns-os-qc-accept/v0";
export const QC_ACCEPT_SCOPE = "qc_accept";
export const QC_ACCEPT_RECORDER = "campaigns-os checkpoint accept";
export const QC_ACCEPT_STATUSES = Object.freeze(["active", "lapsed", "orphaned", "expired", "inert"]);
export const QC_DISPOSITION = Object.freeze({ OPEN: "open", OPERATOR_ACCEPTED: "operator_accepted" });
// The evidence an accept's measurement came from: the doctor sidecar, the
// full QA verdict, or, on the Polish leg, the package-owned record the
// accepted check is read from (QC_CHECK_REGISTRY `record`).
const QC_LEG_SOURCES = Object.freeze({ doctor: "doctor_sidecar", qa: "qa_full_verdict" });
export const QC_POLISH_RECORD_SOURCES = Object.freeze({ media_weight: "polish_media_weight", readability: "polish_readability" });

// Null for a Polish check with no record, or a leg with no source.
export function measuredSourceFor(leg, check) {
  if (leg !== "polish") return Object.hasOwn(QC_LEG_SOURCES, leg) ? QC_LEG_SOURCES[leg] : null;
  const entry = Object.hasOwn(QC_CHECK_REGISTRY, check) ? QC_CHECK_REGISTRY[check] : null;
  return entry?.leg === "polish" && Object.hasOwn(QC_POLISH_RECORD_SOURCES, entry.record) ? QC_POLISH_RECORD_SOURCES[entry.record] : null;
}

// The command's closed refusal list.
export const QC_ACCEPT_REFUSALS = Object.freeze({
  ACCEPTED_BY_REQUIRED: "accepted_by_required",
  ATTRIBUTION_INVALID: "attribution_invalid",
  NO_PERSISTED_FINDING: "no_persisted_finding",
  CHANGED_SINCE_HANDOFF: "changed_since_handoff",
  TARGET_NOT_WARNING: "target_not_warning",
  MEMBERS_UNRESOLVED: "members_unresolved",
});

// The producers that stamp the retained doctor sidecar (generated_by).
export const DOCTOR_SIDECAR_PRODUCERS = Object.freeze(["doctor", "next", "qa run", "start", "build"]);

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// A typed refusal: `code` is one of QC_ACCEPT_REFUSALS, and `refused` names
// each offending ref with its own code.
export class QcAcceptRefusal extends Error {
  constructor(code, message, refused = []) {
    super(message);
    this.name = "QcAcceptRefusal";
    this.code = code;
    this.refused = refused;
  }
}

// Unkeyed sha256 over the canonical projection of every field but integrity
// (the buildPolishCaptureIntegrity pattern).
export function qcAcceptIntegrity(record) {
  const { integrity: _ignored, ...rest } = isPlainObject(record) ? record : {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

// --accepted-by is checked here first so the refusal names the flag the
// operator typed; the shared rule (isNamedHuman) is the waiver lanes'.
export function checkAcceptedBy(acceptedBy) {
  if (!isNonEmptyString(acceptedBy)) {
    throw new QcAcceptRefusal(QC_ACCEPT_REFUSALS.ACCEPTED_BY_REQUIRED, "checkpoint accept requires --accepted-by \"<operator's name>\": the named person who decided this accept. There is no default.");
  }
  if (!isNamedHuman(acceptedBy)) {
    throw new QcAcceptRefusal(QC_ACCEPT_REFUSALS.ATTRIBUTION_INVALID, `checkpoint accept refuses --accepted-by ${JSON.stringify(acceptedBy)}: it must name the operator who decided, not a placeholder or automation identity.`);
  }
}

// Attribution through the shared waiver rule (label "accept", no bound
// required). Returns the normalized fields; throws attribution_invalid.
export function qcAcceptAttribution({ reason, acceptedBy, now, expiresAt = null, reviewCondition = null }) {
  checkAcceptedBy(acceptedBy);
  try {
    const attribution = validateWaiverAttribution({ reason, waivedBy: acceptedBy, now, expiresAt, reviewCondition, requireBound: false, label: "accept" });
    return {
      reason: attribution.reason,
      accepted_by: attribution.waived_by,
      accepted_at: attribution.waived_at,
      ...(attribution.expires_at ? { expires_at: attribution.expires_at } : {}),
      ...(attribution.review_condition ? { review_condition: attribution.review_condition } : {}),
    };
  } catch (error) {
    throw new QcAcceptRefusal(QC_ACCEPT_REFUSALS.ATTRIBUTION_INVALID, `checkpoint accept refused: ${error.message}`);
  }
}

export function createQcAccept(result, { measuredAt, attribution }) {
  const record = {
    schema: QC_ACCEPT_SCHEMA,
    scope: QC_ACCEPT_SCOPE,
    result_id: result.id,
    check: result.check,
    leg: result.leg,
    subject: result.subject,
    state_fingerprint: result.state_fingerprint,
    result_at_accept: "warning",
    measured_at: measuredAt,
    measured_source: measuredSourceFor(result.leg, result.check),
    ...attribution,
    recorded_by: QC_ACCEPT_RECORDER,
  };
  return { ...record, integrity: qcAcceptIntegrity(record) };
}

function malformed(record) {
  return !(isPlainObject(record)
    && record.schema === QC_ACCEPT_SCHEMA
    && record.scope === QC_ACCEPT_SCOPE
    && record.recorded_by === QC_ACCEPT_RECORDER
    && isNonEmptyString(record.result_id)
    && isNonEmptyString(record.check)
    && QC_LEGS.includes(record.leg)
    && isPlainObject(record.subject)
    && FINGERPRINT.test(record.state_fingerprint || "")
    && record.result_at_accept === "warning"
    && validTime(record.measured_at)
    && isNonEmptyString(record.measured_source)
    && record.measured_source === measuredSourceFor(record.leg, record.check)
    && typeof record.reason === "string"
    && typeof record.accepted_by === "string"
    && typeof record.accepted_at === "string"
    && FINGERPRINT.test(record.integrity || ""));
}

function attributionValid(record) {
  if (!isNamedHuman(record.accepted_by)) return false;
  try {
    validateWaiverAttribution({
      reason: record.reason,
      waivedBy: record.accepted_by,
      now: record.accepted_at,
      expiresAt: record.expires_at ?? null,
      reviewCondition: record.review_condition ?? null,
      requireBound: false,
      label: "accept",
    });
    return true;
  } catch {
    return false;
  }
}

// Classifies one record by the first matching rule of the ordered table.
function assessOne(record, currentById, nowMs) {
  if (malformed(record)) return { status: "inert", why: "malformed" };
  if (record.integrity !== qcAcceptIntegrity(record)) return { status: "inert", why: "integrity_mismatch" };
  if (!attributionValid(record)) return { status: "inert", why: "attribution_invalid" };
  if (!(Date.parse(record.accepted_at) > Date.parse(record.measured_at))) return { status: "inert", why: "accepted_not_after_measurement" };
  const current = currentById.get(record.result_id);
  if (!current) return { status: "orphaned", why: "no_current_result" };
  if (current.result === "unexercised" && [QC_REASON.STALE_BINDING, QC_REASON.EVIDENCE_NOT_REPRODUCIBLE].includes(current.reason_code)) {
    return { status: "lapsed", why: current.reason_code, current };
  }
  if (current.state_fingerprint !== record.state_fingerprint
    || current.check !== record.check
    || current.leg !== record.leg
    || canonicalJson(current.subject) !== canonicalJson(record.subject)) {
    return { status: "lapsed", why: "state_changed", current };
  }
  if (current.result !== "warning") return { status: "inert", why: "target_not_warning", current };
  if (current.accept_eligible !== true) return { status: "inert", why: "members_unresolved", current };
  if (record.expires_at != null && Date.parse(record.expires_at) <= nowMs) return { status: "expired", why: "expired", current };
  return { status: "active", why: null, current };
}

// One assessment per record, in input order: {status, why, applied}. When
// several records are active for one result the newest accepted_at is the
// applied one, as in assessCheckpointWaivers.
export function assessQcAccepts(records, currentResults, { now = new Date().toISOString() } = {}) {
  const list = Array.isArray(records) ? records : [];
  const currentById = new Map((Array.isArray(currentResults) ? currentResults : []).filter((row) => isPlainObject(row) && isNonEmptyString(row.id)).map((row) => [row.id, row]));
  const nowMs = Date.parse(now);
  const assessed = list.map((record) => ({ ...assessOne(record, currentById, nowMs), applied: false }));
  const newest = new Map();
  assessed.forEach((assessment, index) => {
    if (assessment.status !== "active") return;
    const id = list[index].result_id;
    const time = Date.parse(list[index].accepted_at);
    if (!newest.has(id) || time >= newest.get(id).time) newest.set(id, { index, time });
  });
  for (const { index } of newest.values()) assessed[index].applied = true;
  return assessed.map(({ current: _current, ...rest }) => rest);
}

// A bounded projection of a valid record, like projectCheckpointWaiver: the
// raw record never reaches an output.
export function projectQcAccept(record) {
  if (malformed(record) || record.integrity !== qcAcceptIntegrity(record)) return null;
  return {
    result_ref: `${record.result_id}@${fingerprint12(record.state_fingerprint)}`,
    result_id: record.result_id,
    check: record.check,
    leg: record.leg,
    state_fingerprint: record.state_fingerprint,
    measured_at: record.measured_at,
    measured_source: record.measured_source,
    reason: record.reason.trim(),
    accepted_by: record.accepted_by.trim().replace(/\s+/g, " "),
    accepted_at: record.accepted_at,
    ...(record.expires_at == null ? {} : { expires_at: record.expires_at }),
    ...(record.review_condition == null ? {} : { review_condition: String(record.review_condition).trim() }),
  };
}

// ---------------------------------------------------------------------------
// "The finding must have existed first."

export function parseQcResultRef(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const at = text.lastIndexOf("@");
  if (at <= 0) return null;
  const id = text.slice(0, at);
  const prefix = text.slice(at + 1);
  return /^[a-f0-9]{12}$/.test(prefix) ? { ref: text, id, prefix } : null;
}

// Doctor precondition: the persisted sidecar was written by a package
// producer and holds the row with this id and fingerprint. A stale stamp does
// not matter; the row is compared with the fresh recomputation anyway.
export function doctorSidecarRow(sidecarPath, result) {
  if (!isNonEmptyString(sidecarPath) || !existsSync(sidecarPath)) return null;
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(sidecar) || sidecar.schema_version !== DOCTOR_SIDECAR_SCHEMA || !DOCTOR_SIDECAR_PRODUCERS.includes(sidecar.generated_by)) return null;
  const rows = Array.isArray(sidecar.derived?.qc_results) ? sidecar.derived.qc_results : [];
  return rows.find((row) => isPlainObject(row) && row.id === result.id && row.state_fingerprint === result.state_fingerprint && row.leg === "doctor") || null;
}

// Checks every ref against the current results, all or nothing. Returns the
// accept records to write, or throws a QcAcceptRefusal naming each offending
// ref. `results` are the reader-site results; `sidecarPath` the persisted
// doctor sidecar; `now` the command clock.
export function planQcAccepts({ refs, results, sidecarPath, now, attribution }) {
  const byId = new Map(results.map((row) => [row.id, row]));
  const refused = [];
  const records = [];
  for (const { ref, id, prefix } of refs) {
    const current = byId.get(id);
    const refuse = (code, detail) => refused.push({ result_ref: ref, refusal_code: code, detail });
    if (!current) {
      refuse(QC_ACCEPT_REFUSALS.CHANGED_SINCE_HANDOFF, `"${id}" has no current result; it changed since the handoff; re-run \`next\``);
      continue;
    }
    // The prefix the operator saw is compared first, so a result whose state
    // changed since the handoff is named as changed, whatever it reads now.
    if (fingerprint12(current.state_fingerprint) !== prefix) {
      refuse(QC_ACCEPT_REFUSALS.CHANGED_SINCE_HANDOFF, `"${id}" changed since the handoff; re-run \`next\``);
      continue;
    }
    if (current.result !== "warning") {
      refuse(QC_ACCEPT_REFUSALS.TARGET_NOT_WARNING, `"${id}" reads ${current.result}${current.reason_code ? ` (${current.reason_code})` : ""}; only a warning can be accepted`);
      continue;
    }
    if (current.accept_eligible !== true) {
      refuse(QC_ACCEPT_REFUSALS.MEMBERS_UNRESOLVED, `"${id}" is a warning with members still in review or unexercised; resolve them first`);
      continue;
    }
    let measuredAt = current.measured_at;
    if (current.leg === "doctor") {
      const persisted = doctorSidecarRow(sidecarPath, current);
      if (!persisted) {
        refuse(QC_ACCEPT_REFUSALS.NO_PERSISTED_FINDING, `"${id}" is not on record in the doctor snapshot that \`next\` writes; run \`next\`, show the handoff, then accept`);
        continue;
      }
      measuredAt = persisted.measured_at;
    }
    if (!validTime(measuredAt) || !(Date.parse(measuredAt) < Date.parse(now))) {
      refuse(QC_ACCEPT_REFUSALS.NO_PERSISTED_FINDING, `"${id}" has no measurement recorded before this command`);
      continue;
    }
    records.push(createQcAccept(current, { measuredAt, attribution }));
  }
  if (refused.length) {
    const lead = refused[0].refusal_code;
    throw new QcAcceptRefusal(lead, `checkpoint accept refused; nothing was written: ${refused.map((entry) => entry.detail).join("; ")}.`, refused);
  }
  return records;
}

// ---------------------------------------------------------------------------
// The QC handoff `next` prints

const LEG_ORDER = Object.freeze({ doctor: 0, polish: 1, qa: 2 });
const compareText = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));

// A readability colour pair reads as its roles, colours, ratio and
// requirement: `<roles>: <fg8> on <bg8>, <ratio>:1, needs <required>:1
// (<size_class> text)`, from the row's observation (the lowest ratio of the
// rows given). Null for any other row.
function readabilityPairSummary(rows) {
  const pairs = rows.map((row) => (row?.check === "readability.contrast" && String(row.subject?.key ?? "").startsWith("pair:") && isPlainObject(row.observation) ? row.observation : null));
  if (!pairs.length || pairs.some((observation) => observation === null)) return null;
  const roles = [...new Set(pairs.flatMap((observation) => (Array.isArray(observation.roles) ? observation.roles : [])))].sort(compareText);
  const lowest = pairs.reduce((low, observation) => (observation.ratio < low.ratio ? observation : low));
  return `${roles.join(", ")}: ${lowest.fg8} on ${lowest.bg8}, ${lowest.display_ratio}:1, needs ${lowest.required}:1 (${lowest.size_class} text)`;
}

// The crop path of a readability review row: its first member's crop.
// Undefined for a review row with no crop, and for any other row.
function readabilityReviewCrop(row) {
  if (row?.check !== "readability.contrast" || row.result !== "review") return undefined;
  const members = Array.isArray(row.observation?.members) ? row.observation.members : [];
  const ref = members.find((member) => isPlainObject(member?.crop_ref))?.crop_ref;
  return typeof ref?.path === "string" ? ref.path : undefined;
}

function handoffEntry(row) {
  const crop = readabilityReviewCrop(row);
  return {
    result_ref: qcResultRef(row),
    check: row.check,
    leg: row.leg,
    page: row.subject?.page ?? null,
    ...(row.subject?.viewport == null ? {} : { viewport: row.subject.viewport }),
    key: row.subject?.key ?? null,
    result: row.result,
    reason_code: row.reason_code,
    accept_eligible: row.accept_eligible === true,
    members: Array.isArray(row.members) ? row.members : [],
    summary: readabilityPairSummary([row]) ?? `${row.check} ${row.result}${row.reason_code ? ` (${row.reason_code})` : ""} on ${row.subject?.page ?? "(no page)"}${row.subject?.key == null ? "" : `: ${row.subject.key}`}`,
    ...(crop === undefined ? {} : { crop }),
  };
}

// Sorted by check, then key, then page.
const byCheckKeyPage = (a, b) => compareText(a.check, b.check) || compareText(a.key, b.key) || compareText(a.page, b.page) || compareText(a.viewport, b.viewport) || compareText(a.result_ref, b.result_ref);

// Open warnings grouped by check, then by key across pages (and viewports):
// a layout-shared defect is one entry listing its pages. The entry carries its
// first page's fields, `pages`, and `results`, which keeps every page's result
// with its own ref, accept eligibility and members, so every member stays
// visible. The entry is accept-eligible only when every result in it is.
function groupOpenWarnings(entries, rows = []) {
  const groups = new Map();
  for (const entry of [...entries].sort(byCheckKeyPage)) {
    const key = JSON.stringify([entry.check, entry.key]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].map((results) => {
    const [lead] = results;
    const pages = [...new Set(results.map((entry) => entry.page).filter((page) => page != null))];
    return {
      ...lead,
      pages,
      accept_eligible: results.every((entry) => entry.accept_eligible),
      summary: results.length > 1
        ? readabilityPairSummary(results.map((entry) => rows.find((row) => qcResultRef(row) === entry.result_ref))) ?? `${lead.check} ${lead.result}${lead.reason_code ? ` (${lead.reason_code})` : ""} on ${pages.join(", ")}${lead.key == null ? "" : `: ${lead.key}`}`
        : lead.summary,
      results,
    };
  });
}

// The accept command for the invocation that produced the handoff: this
// install's spelling of the command, the packet `next` read and, when `next`
// read a report other than the packet's default one, `--report` naming it
// (checkpoint accept never follows the Build Context pointer). Only the
// operator's reason and name are left as placeholders.
function acceptCommand(refs, { packetPath, reportPath }) {
  const packet = packetPath == null ? "<packet>" : shellToken(packetPath);
  const report = reportPath == null ? "" : ` --report ${shellToken(reportPath)}`;
  return cmd("checkpoint", `accept --packet ${packet}${report} ${refs.map((ref) => `--result ${shellToken(ref)}`).join(" ")} --reason "<operator's reason>" --accepted-by "<operator's name>"`);
}

// `reportPath` is given only when it is not the packet's default report
// (explicitReportPath).
export function buildQcHandoff({ results, coverage = [], accepts, now = new Date().toISOString(), packetPath = null, reportPath = null }) {
  const records = Array.isArray(accepts) ? accepts : [];
  const assessed = assessQcAccepts(records, results, { now });
  const applied = new Map();
  const lapsed = [];
  const inert = [];
  assessed.forEach((assessment, index) => {
    const record = records[index];
    if (assessment.applied) applied.set(record.result_id, record);
    if (assessment.status === "inert") inert.push({ result_id: isPlainObject(record) && typeof record.result_id === "string" ? record.result_id : null, why: assessment.why });
    if (assessment.status === "lapsed") {
      const current = results.find((row) => row.id === record.result_id);
      lapsed.push({
        ...handoffEntry(current),
        result_id: record.result_id,
        accepted_by: record.accepted_by,
        accepted_at: record.accepted_at,
        why: assessment.why,
      });
    }
  });
  const open = [];
  const review = [];
  const accepted = [];
  for (const row of results) {
    const record = applied.get(row.id);
    if (record) {
      accepted.push({
        ...handoffEntry(row),
        disposition: QC_DISPOSITION.OPERATOR_ACCEPTED,
        accepted_by: record.accepted_by,
        accepted_at: record.accepted_at,
        reason: record.reason,
      });
      continue;
    }
    if (row.result === "warning") open.push({ ...handoffEntry(row), disposition: QC_DISPOSITION.OPEN });
    else if (row.result === "review") review.push({ ...handoffEntry(row), disposition: QC_DISPOSITION.OPEN });
  }
  const grouped = new Map();
  for (const row of results) {
    if (row.result !== "unexercised" && row.result !== "excluded") continue;
    const key = JSON.stringify([row.leg, row.check, row.result, row.reason_code]);
    const entry = grouped.get(key) || { check: row.check, leg: row.leg, result: row.result, reason_code: row.reason_code, count: 0, pages: [] };
    entry.count += 1;
    if (row.subject?.page != null && !entry.pages.includes(row.subject.page)) entry.pages.push(row.subject.page);
    grouped.set(key, entry);
  }
  const coverageEntries = [...grouped.values(), ...coverage]
    .map((entry) => ({ ...entry, pages: [...entry.pages].sort(compareText) }))
    .sort((a, b) => (LEG_ORDER[a.leg] ?? 9) - (LEG_ORDER[b.leg] ?? 9) || compareText(a.check, b.check) || compareText(a.reason_code, b.reason_code) || compareText(a.result, b.result));
  const openGroups = groupOpenWarnings(open, results);
  review.sort(byCheckKeyPage);
  lapsed.sort(byCheckKeyPage);
  accepted.sort(byCheckKeyPage);
  inert.sort((a, b) => compareText(a.result_id, b.result_id) || compareText(a.why, b.why));
  const eligible = openGroups.flatMap((group) => group.results).filter((entry) => entry.accept_eligible).map((entry) => entry.result_ref);
  return {
    open: openGroups,
    review,
    lapsed,
    coverage: coverageEntries,
    accepted,
    inert_accepts: inert,
    accept_command: eligible.length ? acceptCommand(eligible, { packetPath, reportPath }) : null,
  };
}

// The "QC handoff" text section of `next`.
export function qcHandoffTextLines(handoff) {
  if (!isPlainObject(handoff)) return [];
  const lines = ["QC handoff:"];
  const section = (title, entries, format) => {
    if (!entries?.length) return;
    lines.push(`  ${title}:`);
    for (const entry of entries) {
      const [first, ...rest] = [format(entry)].flat();
      lines.push(`  - ${first}`, ...rest);
    }
  };
  const members = (entry) => (entry.members?.length ? ` [members: ${entry.members.map((member) => `${member.key} ${member.result}${member.reason_code ? ` (${member.reason_code})` : ""}`).join(", ")}]` : "");
  const openLine = (entry) => `${entry.result_ref} ${entry.summary}${entry.accept_eligible ? "" : " (not accept-eligible)"}${members(entry)}`;
  section("Open warnings", handoff.open, (entry) => (entry.results?.length > 1
    ? [entry.summary, ...entry.results.map((result) => `      ${openLine(result)}`)]
    : openLine(entry)));
  section("Review", handoff.review, (entry) => `${entry.result_ref} ${entry.summary}${entry.crop ? ` crop: ${entry.crop}` : ""}${members(entry)}`);
  section("Lapsed accepts", handoff.lapsed, (entry) => `${entry.result_ref} ${entry.summary}; accepted by ${entry.accepted_by} at ${entry.accepted_at}; lapsed: ${entry.why}`);
  section("Coverage", handoff.coverage, (entry) => `${entry.leg} ${entry.check}: ${entry.result} (${entry.reason_code})${entry.count ? ` x${entry.count}` : ""}${entry.pages.length ? ` on ${entry.pages.join(", ")}` : ""}`);
  section("Accepted", handoff.accepted, (entry) => `${entry.result_ref} accepted by ${entry.accepted_by} at ${entry.accepted_at}: ${entry.reason}${members(entry)}`);
  section("Inert accepts", handoff.inert_accepts, (entry) => `${entry.result_id ?? "(no result id)"}: ${entry.why}`);
  if (lines.length === 1) lines.push("  (no QC results)");
  if (handoff.accept_command) lines.push(`  Accept only with the operator's decision: ${handoff.accept_command}`);
  return lines;
}
