// The local preview policy: one place that decides which missing evidence a
// localhost preview carries forward as a warning instead of a blocker.
//
// The local preview is a packet whose deploy target is `local-serve`, served
// from a loopback host. There a campaign must still prove its commerce (store
// and campaign binding, routes, SDK loading, prices, a typed-card order), but
// evidence that only design work or launch produces may be missing. Missing
// evidence is reported as missing, never as passed: a carried-forward gate is
// a warning in doctor, `next` does not stop on it, and QA records it as a
// `warn` row, so the verdict is at best `ready_with_exceptions`. A hosted
// preview or production packet never takes this path, and every check not
// named below keeps its meaning on every path.
//
// Doctor and QA apply this to the gates they evaluate; `next` reads doctor's
// gates. Recording a stage (`record polish`) and the waiver commands keep the
// strict gates; `record deploy` follows next past a carried-forward polish.
import { isLocalServePacket } from "./local-proof.mjs";
import { isLoopbackHostname } from "./remit.mjs";
import { READABILITY_PRODUCER, READABILITY_ROUTE_SOURCE, READABILITY_SCHEMA } from "./polish-readability.mjs";
import { polishRecordIntegrity } from "./qc-results.mjs";

export const LOCAL_PREVIEW_POLICY = "local_preview";
export const CARRIED_FORWARD = "carried_forward";

// The checks carried forward, one by one. Each is evidence the campaign does
// not have yet, not evidence that something is wrong:
// - polish was never recorded for this build;
// - no page-load capture exists, either because polish capture never ran or
//   because every mapped page is template stock and there is no design route
//   to capture (a current readability-only capture clears this demand).
const CARRIED_POLISH_CODES = Object.freeze(new Set([
  "polish.report_missing",
  "polish.evidence_missing",
]));
export const NO_CAPTURABLE_ROUTES_CODE = "polish.hidden_eager_media.no_capturable_routes";
const MISSING_CAPTURE_CODE = "polish.hidden_eager_media.capture_malformed";

// With no generatable brand theme the starter template is the design, so its
// palette and chrome are expected on the local preview: residue findings are
// warnings there, as they are under a waived theme gate.
const STARTER_IS_THE_DESIGN_THEME_CODE = "theme_gate.nothing_generatable";

function loopbackOrAbsent(url) {
  if (url === undefined || url === null || url === "") return true;
  try {
    return isLoopbackHostname(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

export function isLocalPreview(packet, { baseUrl = null } = {}) {
  return isLocalServePacket(packet)
    && loopbackOrAbsent(packet?.deploy?.preview_url)
    && loopbackOrAbsent(baseUrl);
}

export function localPreviewUrlRecorded(packet, report) {
  return Boolean(packet?.deploy?.preview_url)
    && report?.stages?.deploy?.status !== "blocked"
    && isLocalPreview(packet);
}

function currentReadabilityOnlyCapture(report, packet) {
  const record = report?.stages?.polish?.evidence?.visual_review?.readability;
  return record?.schema_version === READABILITY_SCHEMA
    && record.performed_by === READABILITY_PRODUCER
    && record.subject?.route_source === READABILITY_ROUTE_SOURCE
    && record.subject?.campaign_slug === packet?.campaign?.public_route_slug
    && Boolean(report?.stages?.assembly?.build_fingerprint)
    && record.subject.build_fingerprint === report.stages.assembly.build_fingerprint
    && record.integrity === polishRecordIntegrity(record)
    && Array.isArray(record.cells)
    && Array.isArray(record.subject.routes)
    && record.cells.every((cell) => cell?.cell_status === "measured");
}

function pageLoadRecorded(report) {
  return report?.stages?.polish?.evidence?.visual_review?.page_load != null;
}

function carried(gate) {
  return {
    ...gate,
    status: CARRIED_FORWARD,
    carried_forward: { policy: LOCAL_PREVIEW_POLICY, from_status: gate.status, evidence: "missing" },
  };
}

// The hidden eager-media checkpoint, evaluated on its own.
export function applyLocalPreviewToCheckpoint(gate, { packet, report, baseUrl = null } = {}) {
  if (gate?.code === NO_CAPTURABLE_ROUTES_CODE && report?.stages?.polish?.evidence?.visual_review?.readability != null) {
    if (currentReadabilityOnlyCapture(report, packet)) {
      return { ...gate, status: "pass", code: "polish.hidden_eager_media.pass", reason: "The current build has a recorded readability-only capture; no design route can produce page-load evidence.", required_actions: [] };
    }
    return gate;
  }
  if (gate?.status !== "blocked" || !isLocalPreview(packet, { baseUrl })) return gate;
  const missing = gate.code === NO_CAPTURABLE_ROUTES_CODE
    || (gate.code === MISSING_CAPTURE_CODE && !pageLoadRecorded(report));
  return missing ? carried(gate) : gate;
}

// The polish gate folds the checkpoint in, so it is carried forward only when
// whatever it owns from the checkpoint was carried forward too.
export function polishCarriedForwardForLadder(report, gate) {
  return gate?.status === CARRIED_FORWARD
    && !report?.theme?.waiver
    && !report?.stages?.polish?.evidence?.visual_review?.page_load
    && !report?.stages?.polish?.evidence?.visual_review?.readability;
}

export function applyLocalPreviewToPolishGate(gate, { packet, checkpointGate = null, baseUrl = null } = {}) {
  if (gate?.status !== "blocked" || !isLocalPreview(packet, { baseUrl })) return gate;
  const checkpointCarried = checkpointGate?.status === CARRIED_FORWARD;
  if (gate.owned_checkpoint_status === "blocked" && !checkpointCarried) return gate;
  if (gate.owned_checkpoint_only) return checkpointCarried ? carried(gate) : gate;
  return CARRIED_POLISH_CODES.has(gate.code) ? carried(gate) : gate;
}

export function starterResidueIsExpected(themeGate, { packet, baseUrl = null } = {}) {
  return themeGate?.code === STARTER_IS_THE_DESIGN_THEME_CODE && isLocalPreview(packet, { baseUrl });
}

export function carriedForwardMessage(gate) {
  return `Carried forward on the local preview: ${gate.reason} This evidence is missing, not passed; a hosted preview or production run requires it.`;
}
