import { campaignIdentitiesMatch } from "./spec-source-identity.mjs";
// Run Record closeout recognition.
//
// `next` at stage "done" used to demand a Run Record unconditionally, because
// nothing in the CLI ever read `.campaign-runtime/run-records/`. A run that had
// already assembled, closed and remitted its record was still told to make one.
// The fix is not "go quiet whenever any record exists" — that would re-open the
// #171 failure the required action was added to prevent. This module decides,
// from already-read JSON, whether a MATCHING, CURRENT, SUCCESSFULLY CLOSED
// record exists for this exact packet, and names the reason when it does not.
//
// Pure: no filesystem, no clock, no network. The caller reads the records and
// computes the current QA verdict digest; this module only judges.
//
// FAIL OPEN. Every doubt — an unreadable record, an unrecognized remit state, a
// record that cannot be tied to the verdict the report currently points at —
// resolves to "not satisfied", which emits the closeout action. A false demand
// costs one idempotent command; a false silence loses the run's durable record.

/*
 * Closed reason vocabulary (`reason_code` on assessRunRecordCloseout's
 * outcome). `satisfied` is the only value that suppresses the required
 * closeout action; every other value names why it must still fire.
 *
 * - `satisfied`              a matching, current, closed record exists
 * - `no_record`              no readable record for this packet at all
 * - `foreign_campaign`       records exist, none belongs to this campaign
 * - `stale_predates_evidence` the newest matching record is older than the
 *                            producer evidence currently in the report
 * - `outdated_artifacts`     the record does not reference the QA verdict the
 *                            report's qa stage currently points at
 * - `remit_failed`           remit was attempted and failed
 * - `remit_incomplete`       remit never reached a terminal state (pending, or
 *                            a state this version does not recognize)
 */

// Remit outcomes that mean "this record is closed". `ok` is a completed remit.
// `skipped` is the consent-off / --no-remit / local-only path: a deliberate
// non-remit is a closed record, not a failure, and nagging it forever would
// punish every offline operator.
const CLOSED_REMIT_STATES = new Set(["ok", "skipped"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTime(value) {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The newest producer timestamp already recorded in the report. A record minted
 * before this cannot describe the evidence the report now carries.
 *
 * Old-format reports carry stages with no `checked_at` at all; those simply
 * contribute nothing, so an old report yields no freshness floor rather than a
 * fabricated one.
 */
export function latestProducerTimestamp(report) {
  const stages = isObject(report?.stages) ? report.stages : {};
  let latest = null;
  for (const key of ["doctor", "qa"]) {
    const stage = isObject(stages[key]) ? stages[key] : null;
    if (!stage) continue;
    for (const field of ["checked_at", "completed_at"]) {
      const ms = parseTime(stage[field]);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
  }
  return latest;
}

// A record can reference several QA verdicts: a run session retains each blocked
// repair attempt alongside the attempt that finally passed.
function qaVerdictDigests(record) {
  const artifacts = Array.isArray(record?.artifacts) ? record.artifacts : [];
  return artifacts
    .filter((artifact) => isObject(artifact) && artifact.kind === "qa_verdict")
    .map((artifact) => text(artifact.sha256))
    .filter(Boolean);
}

/**
 * Whether `record` was written for the campaign `packet` describes: same map id
 * and same public route slug. Both sides must actually assert an identity. An
 * identity-less record is not evidence about THIS campaign, so it can never
 * satisfy closeout — and `run-record` never re-emits under its id.
 */
export function identityMatches(record, packet) {
  const slug = text(packet?.campaign?.public_route_slug);
  const identity = isObject(record?.identity) ? record.identity : {};
  const recordSlug = text(identity.campaign_slug);
  if (!slug || !recordSlug) return false;
  return campaignIdentitiesMatch(identity, packet?.spec) && recordSlug === slug;
}

function outcome(reason_code, detail, entry = null) {
  return {
    satisfied: reason_code === "satisfied",
    reason_code,
    detail,
    record_id: entry ? text(entry.record?.run_id) : null,
    record_path: entry ? text(entry.path) : null,
    remit_state: entry ? text(entry.record?.remit_state) : null,
  };
}

/**
 * Decide whether this packet's closeout is already satisfied by a durable Run
 * Record on disk.
 *
 * @param {object}   input
 * @param {Array}    input.records  `{ path, record }` entries already read from
 *                                  the target's run-records directory. Entries
 *                                  whose `record` is not an object are ignored
 *                                  rather than fatal: one corrupt file must not
 *                                  hide a good record beside it.
 * @param {object}   input.packet   the Build Packet `next` was called with.
 * @param {object}   input.report   the Assembly Report on disk.
 * @param {string[]} input.currentQaVerdictDigests  SHA-256 of every QA verdict
 *                                  the report's qa stage currently points at.
 *                                  Empty when the caller could not compute one.
 * @param {boolean}  input.qaVerdictRecorded  whether the qa stage declares a
 *                                  verdict output at all. Old-format reports do
 *                                  not, and must not be punished for it.
 */
export function assessRunRecordCloseout({
  records = [],
  packet = null,
  report = null,
  currentQaVerdictDigests = [],
  qaVerdictRecorded = false,
} = {}) {
  const readable = (Array.isArray(records) ? records : []).filter((entry) => isObject(entry?.record));
  if (!readable.length) {
    return outcome("no_record", "No readable Run Record exists for this target; the run has no durable record yet.");
  }

  const entry = latestMatchingRunRecord(readable, packet);
  if (!entry) {
    return outcome("foreign_campaign", "Run Records exist under this target, but none carries this packet's map id and public route slug.");
  }
  const record = entry.record;

  const createdAt = parseTime(record.created_at);
  if (createdAt === null) {
    return outcome("stale_predates_evidence", "The newest matching Run Record has no parseable created_at, so it cannot be shown to cover the current evidence.", entry);
  }
  const floor = latestProducerTimestamp(report);
  if (floor !== null && createdAt < floor) {
    return outcome("stale_predates_evidence", "The newest matching Run Record predates the doctor/QA evidence currently recorded in the assembly report.", entry);
  }

  // Materially outdated = the record does not reference the QA verdict the
  // report points at RIGHT NOW. Deliberately verdict-only: the assembly report's
  // own hash drifts the instant a producer writes a stage, so including it would
  // make every record instantly outdated.
  if (qaVerdictRecorded) {
    const recorded = qaVerdictDigests(record);
    if (!recorded.length) {
      return outcome("outdated_artifacts", "The assembly report records a QA verdict, but the Run Record references no qa_verdict artifact.", entry);
    }
    const current = (Array.isArray(currentQaVerdictDigests) ? currentQaVerdictDigests : []).map(text).filter(Boolean);
    if (!current.length) {
      return outcome("outdated_artifacts", "The QA verdict the assembly report points at could not be read, so it cannot be matched against the Run Record's qa_verdict reference.", entry);
    }
    if (!current.some((digest) => recorded.includes(digest))) {
      return outcome("outdated_artifacts", "The Run Record references a different QA verdict than the one the assembly report's qa stage points at.", entry);
    }
  }

  const remitState = text(record.remit_state);
  if (remitState === "failed") {
    return outcome("remit_failed", "The Run Record exists locally but its remit failed; recover the existing record rather than minting a second one.", entry);
  }
  if (!remitState || !CLOSED_REMIT_STATES.has(remitState)) {
    return outcome("remit_incomplete", `The Run Record's remit never reached a terminal state (remit_state=${remitState || "absent"}); finish the existing record rather than minting a second one.`, entry);
  }

  return outcome("satisfied", remitState === "skipped"
    ? "A matching, current Run Record is closed locally (remit skipped: consent off or --no-remit)."
    : "A matching, current Run Record is closed and remitted.", entry);
}

/**
 * The newest Run Record among `records` that belongs to `packet`'s campaign
 * (identityMatches) and names a `run_id`, or null when none does. Newest
 * matching record wins. A record with an unparseable created_at sorts last:
 * it cannot prove it is current, so it is never preferred over one that can.
 * Equal or unparseable timestamps break the tie on the file path, descending,
 * the way orderRunRecordFileNames orders the directory, so the pick is
 * deterministic and never left to the sort's handling of a 0 comparison. The
 * assessor then judges only this entry — so an older good record cannot mask
 * a newer broken one — and `run-record` re-emits under its id when no session
 * names one. A record without a `run_id` is not a candidate for either: it
 * could not have been written by writeRunRecord, and letting it win would
 * hand run-record nothing to re-emit under, silently minting a second record
 * for a campaign that has one.
 *
 * @param {Array}  records  `{ path, record }` entries; non-object records are
 *                          ignored.
 * @param {object} packet   the Build Packet whose campaign the record must match.
 */
export function latestMatchingRunRecord(records, packet) {
  const matching = (Array.isArray(records) ? records : [])
    .filter((entry) => isObject(entry?.record) && identityMatches(entry.record, packet) && text(entry.record.run_id) !== null);
  if (!matching.length) return null;
  const sorted = [...matching].sort((a, b) => {
    const byTime = (parseTime(b.record.created_at) ?? -1) - (parseTime(a.record.created_at) ?? -1);
    if (byTime !== 0) return byTime;
    const left = text(a.path) || "";
    const right = text(b.path) || "";
    return left < right ? 1 : left > right ? -1 : 0;
  });
  return sorted[0];
}

/** Reason codes whose remedy is recovering the EXISTING record, not a new one. */
export function reasonIsRemitRecovery(reasonCode) {
  return reasonCode === "remit_failed" || reasonCode === "remit_incomplete";
}
