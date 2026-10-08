// Preview policy: one place that decides which missing evidence a preview
// carries forward as a warning instead of a blocker.
//
// The local preview is a packet whose deploy target is `local-serve`, served
// from a loopback host. There a campaign must still prove its commerce (store
// and campaign binding, routes, SDK loading, prices, a typed-card order), but
// evidence that only design work or launch produces may be missing. Missing
// evidence is reported as missing, never as passed: a carried-forward gate is
// a warning in doctor, `next` does not stop on it, and QA records it as a
// `warn` row, so the verdict is at best `ready_with_exceptions`. A hosted
// preview carries forward only the all-template no-capturable-routes
// shape and the missing Polish report/evidence it owns. QA against the
// packet's production URL stays strict. Every other check keeps its meaning.
//
// Doctor and QA apply this to the gates they evaluate; `next` reads doctor's
// gates. Recording a stage (`record polish`) and the waiver commands keep the
// strict gates; `record deploy` follows next past a carried-forward polish.
import { isLocalServePacket } from "./local-proof.mjs";
import { isLoopbackHostname } from "./remit.mjs";
import { hostedTemplateQaAction, HOSTED_TEMPLATE_PREVIEW_URL_ACTION } from "./gate-actions.mjs";
import { normalizePublicRouteSlug } from "./route-identity.mjs";

export const LOCAL_PREVIEW_POLICY = "local_preview";
export const HOSTED_TEMPLATE_PREVIEW_POLICY = "hosted_template_preview";
export const CARRIED_FORWARD = "carried_forward";

// The checks carried forward, one by one. Each is evidence the campaign does
// not have yet, not evidence that something is wrong:
// - polish was never recorded for this build;
// - no page-load capture exists, either because polish capture never ran or
//   because every mapped page is template stock and there is no design route
//   to capture.
const CARRIED_POLISH_CODES = Object.freeze(new Set([
  "polish.report_missing",
  "polish.evidence_missing",
]));
export function polishGateCanCarryPreview(gate) {
  return Boolean(gate?.owned_checkpoint_only || CARRIED_POLISH_CODES.has(gate?.code));
}
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

function comparableUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return null;
  }
}

export function ensureUrlTrailingSlash(value) {
  try {
    const url = new URL(value);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return value.endsWith("/") ? value : `${value}/`;
  }
}

// QA composes a campaign slug onto a site root before testing it. Preview
// policy compares those same targets, ignoring only query and fragment.
export function normalizeQaBaseUrl(value, publicRouteSlug) {
  const baseUrl = typeof value === "string" && value.trim() ? value.trim() : null;
  if (!baseUrl) return null;
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  if (!slug) return ensureUrlTrailingSlash(baseUrl);
  try {
    const url = new URL(ensureUrlTrailingSlash(baseUrl));
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1) === slug) return ensureUrlTrailingSlash(url.toString());
    return new URL(`${slug}/`, url).toString();
  } catch {
    return ensureUrlTrailingSlash(baseUrl);
  }
}

function comparableQaTarget(value, packet) {
  const slug = packet?.campaign?.public_route_slug || packet?.deploy?.live_url_path;
  return comparableUrl(normalizeQaBaseUrl(value, slug));
}

function isHostedTemplatePreview(packet, { baseUrl = null } = {}) {
  const preview = comparableQaTarget(packet?.deploy?.preview_url, packet);
  const production = comparableQaTarget(packet?.deploy?.production_url, packet);
  const tested = baseUrl == null ? preview : comparableQaTarget(baseUrl, packet);
  return Boolean(packet?.deploy?.target && packet.deploy.target !== "local-serve"
    && preview && tested === preview && preview !== production
    && !isLoopbackHostname(new URL(preview).hostname));
}

export function hostedTemplateNeedsUsablePreview(packet, gate) {
  return gate?.code === NO_CAPTURABLE_ROUTES_CODE
    && packet?.deploy?.target && packet.deploy.target !== "local-serve"
    && !isHostedTemplatePreview(packet);
}

export function hostedTemplateNeedsPreviewUrl(packet, gate) {
  return gate?.code === NO_CAPTURABLE_ROUTES_CODE
    && packet?.deploy?.target && packet.deploy.target !== "local-serve"
    && !packet.deploy.preview_url;
}

function pageLoadRecorded(report) {
  return report?.stages?.polish?.evidence?.visual_review?.page_load != null;
}

export function carried(gate, policy = LOCAL_PREVIEW_POLICY, packet = null) {
  const previewUrl = packet?.deploy?.preview_url;
  if (policy === HOSTED_TEMPLATE_PREVIEW_POLICY && !comparableUrl(previewUrl)) return gate;
  return {
    ...gate,
    status: CARRIED_FORWARD,
    ...(policy === HOSTED_TEMPLATE_PREVIEW_POLICY
      ? { required_actions: [hostedTemplateQaAction(previewUrl)] }
      : {}),
    carried_forward: { policy, from_status: gate.status, evidence: "missing" },
  };
}

// The hidden eager-media checkpoint, evaluated on its own.
export function applyLocalPreviewToCheckpoint(gate, { packet, report, baseUrl = null } = {}) {
  if (gate?.status !== "blocked") return gate;
  if (hostedTemplateNeedsUsablePreview(packet, gate)) {
    return { ...gate, required_actions: [HOSTED_TEMPLATE_PREVIEW_URL_ACTION] };
  }
  if (gate.code === NO_CAPTURABLE_ROUTES_CODE && isHostedTemplatePreview(packet, { baseUrl })) {
    return carried(gate, HOSTED_TEMPLATE_PREVIEW_POLICY, packet);
  }
  if (!isLocalPreview(packet, { baseUrl })) return gate;
  const missing = gate.code === NO_CAPTURABLE_ROUTES_CODE
    || (gate.code === MISSING_CAPTURE_CODE && !pageLoadRecorded(report));
  return missing ? carried(gate) : gate;
}

// The polish gate folds the checkpoint in, so it is carried forward only when
// whatever it owns from the checkpoint was carried forward too.
export function polishCarriedForwardForLadder(report, gate) {
  return gate?.status === CARRIED_FORWARD
    && !report?.theme?.waiver
    && !report?.stages?.polish?.evidence?.visual_review?.page_load;
}

export function applyLocalPreviewToPolishGate(gate, { packet, checkpointGate = null, baseUrl = null } = {}) {
  if (gate?.status !== "blocked") return gate;
  // A template-stock map has no route that capture can measure, even when
  // the preview is strict. Do not keep an impossible recapture action.
  const actionableGate = checkpointGate?.code === NO_CAPTURABLE_ROUTES_CODE
    ? { ...gate, required_actions: (gate.required_actions || []).filter((action) => action.id !== "polish.hidden_eager_media.capture") }
    : gate;
  if (polishGateCanCarryPreview(gate) && hostedTemplateNeedsUsablePreview(packet, checkpointGate)) {
    return { ...actionableGate, required_actions: [HOSTED_TEMPLATE_PREVIEW_URL_ACTION] };
  }
  const hostedTemplate = checkpointGate?.code === NO_CAPTURABLE_ROUTES_CODE
    && checkpointGate?.carried_forward?.policy === HOSTED_TEMPLATE_PREVIEW_POLICY
    && isHostedTemplatePreview(packet, { baseUrl });
  if (!hostedTemplate && !isLocalPreview(packet, { baseUrl })) return actionableGate;
  const checkpointCarried = checkpointGate?.status === CARRIED_FORWARD;
  if (gate.owned_checkpoint_status === "blocked" && !checkpointCarried) return actionableGate;
  const policy = hostedTemplate ? HOSTED_TEMPLATE_PREVIEW_POLICY : LOCAL_PREVIEW_POLICY;
  if (gate.owned_checkpoint_only) return checkpointCarried ? carried(actionableGate, policy, packet) : actionableGate;
  return CARRIED_POLISH_CODES.has(gate.code) ? carried(actionableGate, policy, packet) : actionableGate;
}

export function starterResidueIsExpected(themeGate, { packet, baseUrl = null } = {}) {
  return themeGate?.code === STARTER_IS_THE_DESIGN_THEME_CODE && isLocalPreview(packet, { baseUrl });
}

export function carriedForwardMessage(gate) {
  if (gate?.carried_forward?.policy === HOSTED_TEMPLATE_PREVIEW_POLICY) {
    return `Carried forward on the hosted preview: ${gate.reason} This evidence is missing, not passed; production QA still requires it.`;
  }
  return `Carried forward on the local preview: ${gate.reason} This evidence is missing, not passed; production QA still requires it.`;
}
