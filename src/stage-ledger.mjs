import { campaignIdentitiesMatch } from "./spec-source-identity.mjs";
import { existsSync, readFileSync } from "node:fs";
import { markDoctorSidecarStale, writeDoctorSidecar, writeJsonAtomic } from "./doctor-sidecar.mjs";
import { STATUS as QA_STATUS } from "./qa-verdict.mjs";
import { isPlainObject, normalizeString as optionalString } from "./repo-scan.mjs";
import {
  ASSEMBLY_REPORT_STAGE_KEYS,
  NEXT_STAGE_CONTRACTS,
  NEXT_STAGE_OWNERS,
  stageIsBlocked,
  stageIsTerminal,
} from "./orchestration-stage-contract.mjs";

const PRODUCER_STAGES = new Set(["doctor", "qa"]);

function nonEmptyStrings(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.trim()) : [];
}

function terminalStatus(disposition) {
  if (disposition === "blocked") return "blocked";
  if (disposition === "ready_with_warnings" || disposition === "ready_with_exceptions") return "completed_with_warnings";
  if (disposition === "ready") return "completed";
  throw new Error(`Unsupported producer disposition "${disposition}".`);
}

// Extension fields on a producer stage that the PRODUCER owns, not the
// operator. Everything else on the stage object is someone else's data and
// passes through a producer write untouched (`waivers` is read elsewhere in
// this repo, and out-of-repo consumers read this report too), so this list must
// stay exactly as long as the evidence a producer can actually restate.
//
// Compatibility decision, deliberate and narrow: before this, every hand-authored
// extension field survived the spread, which let a stage carry a refreshed
// status/outputs/timestamp beside a previous run's `verdict_run_id` and an
// `evidence` block describing an already-fixed bug. Latest identity and latest
// status can no longer disagree. The previous pair is not deleted — it is moved,
// with its ORIGINAL status and timestamp, into a bounded `history[]` on the same
// stage. A previous stage with no `checked_at` (the pre-#308 report shape)
// produces a history entry with no `checked_at`: an absent timestamp is
// preserved as absent rather than stamped with now, because manufactured
// provenance is worse than the stale field it replaces. Both schema-legal
// `evidence` shapes archive, object and array alike; an array of operator notes
// is exactly the evidence a producer has no standing to silently drop.
const QA_OWNED_FIELDS = Object.freeze(["verdict_run_id", "evidence", "purchase_proof"]);

// Bounded so a committed handoff artifact cannot grow without limit, and deep
// enough that a couple of repair attempts do not evict the state a reviewer
// came looking for.
const PRODUCER_STAGE_HISTORY_LIMIT = 5;
// The fields a producer restates on every run even when nothing else moved.
// A re-run that reaches the same outcome differs from the previous report in
// these alone, and rewriting the file for them makes every digest taken of
// the report (a Run Record's assembly_report sha256, for one) go stale for
// no information.
const PRODUCER_STAGE_TIMESTAMP_FIELDS = Object.freeze(["checked_at", "completed_at"]);

// `$defs.stage.evidence` is `oneOf: [array, object]`, so an operator or an
// out-of-repo producer may legally have written either shape. Recognize both,
// or the array branch is deleted below with no history entry and the notes it
// carried leave the report entirely.
function evidenceValue(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  return null;
}

// An empty object or array is schema-legal but says nothing. History exists to
// preserve prior identity a reviewer might come looking for; an empty evidence
// block is not that, and archiving one produces a no-op entry that evicts a
// real one from the bounded window. Empty therefore reads as absent.
function meaningfulEvidence(value) {
  const evidence = evidenceValue(value);
  if (!evidence) return null;
  const empty = Array.isArray(evidence) ? evidence.length === 0 : Object.keys(evidence).length === 0;
  return empty ? null : evidence;
}

// Key order is not meaning. `previous` has been round-tripped through disk and
// may come back with its keys in any order, while `incoming` carries whatever
// order the producer happened to build it in; a plain JSON.stringify comparison
// would call those two unequal and archive a new history entry on every
// re-record of an unchanged verdict, which is precisely what the dedup below
// exists to prevent. Canonicalize object keys (arrays keep their order, which
// IS meaning) before comparing.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(canonicalize(a ?? null)) === JSON.stringify(canonicalize(b ?? null));
}

/**
 * Archive the previous producer-owned identity, if there was one, without
 * inventing anything it did not carry.
 */
function archivePreviousIdentity(previous, incoming) {
  const hadIdentity = typeof previous.verdict_run_id === "string" && previous.verdict_run_id.trim()
    ? previous.verdict_run_id.trim()
    : null;
  const hadEvidence = meaningfulEvidence(previous.evidence);
  if (!hadIdentity && !hadEvidence) return null;
  // An unchanged verdict is a re-record, not a new chapter: re-running the same
  // producer against the same verdict must not grow history. Both sides are
  // normalized the same way, so an empty incoming evidence block compares equal
  // to an empty previous one instead of looking like a change.
  if (sameJson(hadIdentity, incoming.verdict_run_id ?? null) && sameJson(hadEvidence, meaningfulEvidence(incoming.evidence))) return null;
  const entry = {};
  if (typeof previous.status === "string" && previous.status.trim()) entry.status = previous.status;
  if (typeof previous.checked_at === "string" && previous.checked_at.trim()) entry.checked_at = previous.checked_at;
  if (hadIdentity) entry.verdict_run_id = hadIdentity;
  if (hadEvidence) entry.evidence = JSON.parse(JSON.stringify(hadEvidence));
  return entry;
}

function withoutStageTimestamps(report, stage) {
  const copy = JSON.parse(JSON.stringify(report ?? null));
  const stageValue = copy?.stages?.[stage];
  if (isPlainObject(stageValue)) {
    for (const field of PRODUCER_STAGE_TIMESTAMP_FIELDS) delete stageValue[field];
  }
  return copy;
}

/**
 * True when `nextReport` restates exactly the outcome `previousReport` already
 * carries for `stage`, differing only in that stage's timestamps. A producer
 * that sees this has nothing to write: the report on disk already says what
 * this run found, and leaving its bytes alone keeps every digest of it valid.
 */
export function producerStageOutcomeUnchanged(previousReport, nextReport, stage) {
  if (!PRODUCER_STAGES.has(stage)) throw new Error("Producer stage must be doctor or qa.");
  return sameJson(withoutStageTimestamps(previousReport, stage), withoutStageTimestamps(nextReport, stage));
}

/**
 * Return an Assembly Report copy with the current doctor/QA producer outcome.
 * The producer supplies its own timestamp and artifact paths; this helper never
 * invents historical completion evidence.
 *
 * `identity` (currently `{ verdict_run_id }`) and `evidence` are the QA
 * producer's own explanation of the run the canonical fields point at.
 * `proof` is the counts-only purchase-proof summary — never order ids, refs,
 * emails or URLs, because this report is committed and rides into the readback
 * bundle.
 */
export function recordProducerStageOutcome(report, {
  stage,
  disposition,
  timestamp,
  command,
  outputs = [],
  blockers = [],
  warnings = [],
  identity = null,
  evidence = null,
  proof = null,
} = {}) {
  if (!PRODUCER_STAGES.has(stage)) throw new Error("Producer stage must be doctor or qa.");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Producer stage timestamp must be a parseable ISO timestamp.");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Assembly Report must be an object.");

  const updated = JSON.parse(JSON.stringify(report));
  const stages = updated.stages && typeof updated.stages === "object" && !Array.isArray(updated.stages)
    ? updated.stages
    : {};
  const previous = stages[stage] && typeof stages[stage] === "object" && !Array.isArray(stages[stage])
    ? stages[stage]
    : {};
  const status = terminalStatus(disposition);
  const next = {
    ...previous,
    stage,
    status,
    inputs: nonEmptyStrings(previous.inputs),
    outputs: nonEmptyStrings(outputs),
    commands: nonEmptyStrings(command ? [command] : []),
    blockers: nonEmptyStrings(blockers),
    warnings: nonEmptyStrings(warnings),
    checked_at: timestamp,
  };
  if (status.startsWith("completed")) next.completed_at = timestamp;
  else delete next.completed_at;

  // Only QA restates a verdict. The doctor stage has no verdict identity and no
  // purchase proof, so it never gains these fields even if a caller passes them.
  if (stage === "qa") {
    const incomingRunId = typeof identity?.verdict_run_id === "string" && identity.verdict_run_id.trim()
      ? identity.verdict_run_id.trim()
      : null;
    const incomingEvidenceSource = evidenceValue(evidence);
    const incomingEvidence = incomingEvidenceSource ? JSON.parse(JSON.stringify(incomingEvidenceSource)) : null;
    const archived = archivePreviousIdentity(previous, { verdict_run_id: incomingRunId, evidence: incomingEvidence });
    for (const field of QA_OWNED_FIELDS) delete next[field];
    if (incomingRunId) next.verdict_run_id = incomingRunId;
    if (incomingEvidence) next.evidence = incomingEvidence;
    if (isPlainObject(proof)) next.purchase_proof = JSON.parse(JSON.stringify(proof));
    if (archived) {
      const priorHistory = Array.isArray(previous.history) ? previous.history.filter(isPlainObject) : [];
      next.history = [...priorHistory, archived].slice(-PRODUCER_STAGE_HISTORY_LIMIT);
    }
  }
  stages[stage] = next;
  updated.stages = stages;
  return updated;
}

// The gates that sit before the ladder, in the order the `next` picker
// consults them: a blocked prepare-build or a blocked doctor holds every
// stage behind it (`blockedStage`). Neither is a ladder step — a pending
// doctor (prepare-build with --no-doctor, or a report written before doctor
// ran) does not hold the ladder, exactly as the picker does not walk it — but
// it does hold "done": the report only reads completed once every recorded
// stage is terminal, and a gate that never recorded an outcome is named
// (`pendingStage`) once the ladder has nothing left to run.
const PRE_LADDER_GATES = Object.freeze([
  Object.freeze({ reportKey: "prepare_build", blockedStage: "prepare-build", pendingStage: "prepare-build" }),
  Object.freeze({ reportKey: "doctor", blockedStage: "doctor-blocked", pendingStage: "doctor" }),
]);

function stageOf(report, key) {
  const stage = report?.stages?.[key];
  return isPlainObject(stage) ? stage : null;
}

function stageBlockers(stage) {
  return Array.isArray(stage?.blockers) ? stage.blockers : [];
}

/**
 * True when any recorded stage on `report` has status "blocked".
 */
export function anyAssemblyReportStageBlocked(report) {
  return ASSEMBLY_REPORT_STAGE_KEYS.some((key) => stageIsBlocked(stageOf(report, key)?.status));
}

// `ownerKey` is the NEXT_STAGE_OWNERS row to spell the owner from; it differs
// from `stage` only for a pending doctor, which the picker has no row for
// (it names doctor-blocked alone) and which the same operator skill owns.
function nextBlock(stage, action, { ownerKey = stage, ...extras } = {}) {
  const owners = NEXT_STAGE_OWNERS[ownerKey];
  return { stage, owner: owners.default_skill, action, ...extras };
}

/**
 * The Assembly Report's top-level summary, computed from the stage ledger it
 * carries and nothing else. Every write of the report restates it
 * (commitAssemblyReport, and prepare-build's initial write), so the summary
 * can never lag the stages: before this it was written once by prepare-build
 * and a finished ladder still read `status: "prepared"`, `next.stage:
 * "setup"`, `blockers: []` beside a blocked or completed QA stage.
 *
 * - `status`: "blocked" when any recorded stage is blocked; "completed" only
 *   when every recorded stage — the pre-ladder gates (prepare_build, doctor)
 *   included — is terminal; otherwise "prepared". A freshly prepared report
 *   whose doctor never ran therefore never reads completed, whatever the
 *   ladder says.
 * - `next`: the first stage that is not terminal, in the order the `next`
 *   command walks — a blocked prepare-build ("prepare-build"), a blocked
 *   doctor ("doctor-blocked"), then the ladder in NEXT_STAGE_CONTRACTS order.
 *   A pending gate does not hold the ladder (the picker does not walk it) but
 *   is named once the ladder is exhausted ("doctor" for a doctor that never
 *   recorded an outcome), and only when every recorded stage is terminal does
 *   `next.stage` read "done". `next.stage` uses the picker's vocabulary (the
 *   `next <stage>` argument, so "build" not "assembly"), `next.owner` names
 *   the skill that owns the stage, and `next.blocked` is true when the named
 *   stage is the one holding the ladder. This is the ledger's own position
 *   only: the `next` command additionally folds in live gates (doctor
 *   findings, purchase-proof coverage, the polish gate) and stays the
 *   authority for what runs next.
 * - `blockers`: the union of the `blockers[]` of every stage currently
 *   blocked, in stage order, exact duplicates collapsed. A stage that was
 *   blocked and later passed contributes nothing, so a blocker cleared by a
 *   re-run leaves the top level with the stage. The entries are the stage's
 *   own blocker values, not copies: the summary is computed for a write, and
 *   the report is serialized right after.
 *
 * Pure: reads `report`, returns a fresh summary, copies nothing else.
 */
export function deriveAssemblyReportSummary(report) {
  if (!isPlainObject(report)) throw new TypeError("deriveAssemblyReportSummary requires an Assembly Report object.");
  const blockers = [];
  const seen = new Set();
  for (const key of ASSEMBLY_REPORT_STAGE_KEYS) {
    const stage = stageOf(report, key);
    if (!stageIsBlocked(stage?.status)) continue;
    for (const blocker of stageBlockers(stage)) {
      const id = JSON.stringify(canonicalize(blocker));
      if (seen.has(id)) continue;
      seen.add(id);
      blockers.push(blocker);
    }
  }
  const anyBlocked = anyAssemblyReportStageBlocked(report);

  let next = null;
  for (const gate of PRE_LADDER_GATES) {
    if (!stageIsBlocked(stageOf(report, gate.reportKey)?.status)) continue;
    next = nextBlock(gate.blockedStage, `Stage "${gate.reportKey}" is blocked; resolve its blockers before any stage runs.`, { blocked: true });
    break;
  }
  if (!next) {
    for (const { cliStage, reportKey } of NEXT_STAGE_CONTRACTS) {
      const status = stageOf(report, reportKey)?.status;
      if (stageIsBlocked(status)) {
        next = nextBlock(cliStage, `Stage "${reportKey}" is blocked; unblock it, then run ${cliStage}.`, { blocked: true });
        break;
      }
      if (!stageIsTerminal(status)) {
        next = nextBlock(cliStage, `Run ${cliStage} with this packet.`);
        break;
      }
    }
  }
  if (!next) {
    for (const gate of PRE_LADDER_GATES) {
      if (stageIsTerminal(stageOf(report, gate.reportKey)?.status)) continue;
      next = nextBlock(gate.pendingStage, `Stage "${gate.reportKey}" has not recorded a terminal outcome; run it before treating the report as complete.`, { ownerKey: gate.blockedStage });
      break;
    }
  }
  if (!next) next = nextBlock("done", "Every stage is terminal; run next to confirm the closeout actions.");

  const status = anyBlocked ? "blocked" : next.stage === "done" ? "completed" : "prepared";
  return { status, next, blockers };
}

/**
 * Restate `report`'s derived summary (`status`, `next`, `blockers`) from its
 * stages, in place, and return it. The report is the caller's own object
 * (the fresh one prepare-build built, or the copy a producer's
 * recordProducerStageOutcome already made), so nothing is cloned here.
 */
export function applyDerivedAssemblyReportSummary(report) {
  return Object.assign(report, deriveAssemblyReportSummary(report));
}

// QA-owned gate evidence on the qa stage. The QA producer records, beside
// its verdict identity, the build it ran against and the outcome of gates a
// static doctor scan can only approximate (`gates.placeholder_text_residue`,
// from summarizePlaceholderTextGate). Doctor reads it back through
// qaGatePassedForCurrentBuild: a pass counts only while
// stages.assembly.build_fingerprint still equals the fingerprint QA saw, so a
// rebuild silently revokes it. Evidence is a QA-owned field, so the next QA
// record replaces it wholesale — a stale pass cannot outlive the run that
// recorded it.
export const QA_GATE_PLACEHOLDER_TEXT_RESIDUE = "placeholder_text_residue";

export function qaGateEvidence(report, gate) {
  const evidence = report?.stages?.qa?.evidence;
  if (!isPlainObject(evidence) || !isPlainObject(evidence.gates)) return null;
  const outcome = evidence.gates[gate];
  if (!isPlainObject(outcome)) return null;
  return {
    status: optionalString(outcome.status),
    source_build_fingerprint: optionalString(evidence.source_build_fingerprint),
  };
}

export function qaGatePassedForCurrentBuild(report, gate, { buildFingerprint }) {
  const outcome = qaGateEvidence(report, gate);
  const current = optionalString(buildFingerprint);
  return Boolean(outcome && outcome.status === QA_STATUS.PASS && current && outcome.source_build_fingerprint === current);
}

/**
 * True when `report` is this packet's Assembly Report: the identity block
 * names the packet's map id and public route slug (both absent on both sides
 * also matches — a report with no identity belongs to a packet with none).
 */
export function assemblyReportMatchesPacket(report, packet) {
  return isPlainObject(report)
    && (report?.identity?.local_spec_id != null || packet?.spec?.local_spec_id != null
      ? campaignIdentitiesMatch(report?.identity, packet?.spec)
      : optionalString(report?.identity?.map_id) === optionalString(packet?.spec?.map_id))
    && optionalString(report?.identity?.public_route_slug) === optionalString(packet?.campaign?.public_route_slug);
}

/**
 * One commit of an edit to the Assembly Report a campaign workspace binds,
 * with the retained doctor sidecar kept honest about it in the same step.
 *
 * `workspace` is `resolveCampaignWorkspace(...)`'s result (or any object with
 * `packet`, `reportPath`, `doctorOutPath`, `targetRepo`). The report is read
 * from `reportPath`, `mutate(report)` returns the report to write — or `null`
 * to leave the file's bytes alone (a re-run that restates what is already on
 * disk, so every digest taken of the file stays valid) — and the write is
 * atomic (tmp + rename), so a concurrent reader never sees a torn report.
 * `null` means the same for an operator edit: nothing to write, so nothing
 * to stamp stale — an edit that finds its change already recorded is a
 * no-op, not an error.
 *
 * Exactly one doctor-freshness strategy is named:
 *
 * - `refreshDoctor(outcome)`: the caller recomputes doctor state (or already
 *   has it) and the sidecar at `doctorOutPath` is rewritten wholesale from
 *   what it returns, stamped `generated_by: command` (#312), which also
 *   clears any stale stamp; return `null` to leave the sidecar as it is. It
 *   runs whether or not the report was written, because a producer that
 *   found nothing new to restate still holds current doctor state.
 * - `staleReason`: the edit changes what doctor would conclude without
 *   recomputing it, so the retained sidecar under `targetRepo`, if any, is
 *   stamped stale (`stale_marked_by: command`) — only when the report was
 *   actually written.
 *
 * `command` is required either way: it is the producer's own name as the
 * sidecar will carry it (`"doctor"`, `"qa run"`, `"theme generate"`), threaded
 * from the caller rather than guessed from argv here.
 *
 * `stage`: a producer (`"doctor"` | `"qa"`) restating its outcome. The write
 * is skipped when the mutated report differs from disk only in that stage's
 * timestamps (`producerStageOutcomeUnchanged`), and the report must be this
 * packet's (`assemblyReportMatchesPacket`) or the edit is skipped — a
 * producer never restates its outcome into another campaign's report, and
 * an absent report is likewise a skip rather than an error, since a producer
 * without a ledger still has a sidecar to keep current. Operator edits
 * (waivers, evidence merges) pass no `stage`: they require the report to
 * exist and bind its identity themselves.
 *
 * Returns `{ written, skipped, report, reportPath, doctorOutPath }` where
 * `skipped` is `null`, `"absent"`, `"identity"` or `"unchanged"` and `report`
 * is what is now on disk (the mutated report when written, else the one read,
 * else `null`).
 */
export function commitAssemblyReport(workspace, mutate, {
  refreshDoctor = null,
  staleReason = null,
  command = null,
  stage = null,
} = {}) {
  const hasRefresh = typeof refreshDoctor === "function";
  const hasStale = typeof staleReason === "string" && staleReason.trim();
  if (hasRefresh === Boolean(hasStale)) {
    throw new TypeError("commitAssemblyReport requires exactly one of refreshDoctor (a function) or staleReason (a string).");
  }
  if (!optionalString(command)) {
    throw new TypeError("commitAssemblyReport requires command: the doctor sidecar names the command that produced it (generated_by) or stamped it stale (stale_marked_by).");
  }
  if (stage !== null && !PRODUCER_STAGES.has(stage)) throw new Error("Producer stage must be doctor or qa.");
  if (typeof mutate !== "function") throw new TypeError("commitAssemblyReport requires a mutate(report) function.");
  const reportPath = optionalString(workspace?.reportPath);
  const doctorOutPath = optionalString(workspace?.doctorOutPath);
  const targetRepo = optionalString(workspace?.targetRepo);
  if (!reportPath) throw new TypeError("commitAssemblyReport requires a workspace with reportPath.");
  if (hasRefresh && !doctorOutPath) throw new TypeError("commitAssemblyReport requires a workspace with doctorOutPath to refresh the doctor sidecar.");
  if (hasStale && !targetRepo) throw new TypeError("commitAssemblyReport requires a workspace with targetRepo to stamp the doctor sidecar stale.");

  const outcome = { written: false, skipped: null, report: null, reportPath, doctorOutPath };
  const finish = () => {
    if (hasRefresh) {
      const doctor = refreshDoctor(outcome);
      if (doctor !== null && doctor !== undefined) writeDoctorSidecar(doctorOutPath, doctor, { command: command.trim() });
    } else if (outcome.written) {
      markDoctorSidecarStale(targetRepo, { command: command.trim(), reason: staleReason.trim() });
    }
    return outcome;
  };

  if (!existsSync(reportPath)) {
    if (stage) {
      outcome.skipped = "absent";
      return finish();
    }
    throw new Error(`Assembly Report not found at ${reportPath}; run prepare-build/start first.`);
  }
  // A torn or hand-edited report fails by name: the raw SyntaxError names
  // neither the file nor the command, and every caller's read of the report
  // (waivers, the polish merge, the producer stage records) goes through
  // here. Only the parse is caught; a read failure (EACCES, EISDIR) is not
  // a malformed report and propagates as itself.
  const raw = readFileSync(reportPath, "utf8");
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Assembly Report at ${reportPath} is not valid JSON: ${error.message}`);
  }
  outcome.report = report;
  if (stage && !assemblyReportMatchesPacket(report, workspace?.packet)) {
    outcome.skipped = "identity";
    return finish();
  }
  const mutated = mutate(report);
  if (mutated === null || mutated === undefined) {
    outcome.skipped = "unchanged";
    return finish();
  }
  if (!isPlainObject(mutated)) throw new TypeError("commitAssemblyReport mutate(report) must return an Assembly Report object, null, or undefined.");
  // The summary is restated on every write, so a report whose top level lags
  // its stages (written before the summary was derived) heals on the next
  // commit; after that the restatement is a no-op and the unchanged check
  // below keeps the file's bytes alone. `mutated` is the mutator's own object
  // (every mutator in this repo returns a copy), so the restatement is in
  // place rather than a second deep clone.
  const next = applyDerivedAssemblyReportSummary(mutated);
  if (stage && producerStageOutcomeUnchanged(report, next, stage)) {
    outcome.skipped = "unchanged";
    return finish();
  }
  writeJsonAtomic(reportPath, next);
  outcome.written = true;
  outcome.report = next;
  return finish();
}
