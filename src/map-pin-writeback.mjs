// The one write the toolkit makes to a saved Map: the repo SDK pin into the
// Map's Build hints field (`global_config.sdk_version`, plus the
// `runtime.sdk_version` alias when the Map declares it), #415. The repo pin is
// what ships and the Map field is a build hint (#413), so after a bump the Map
// reads stale until someone re-saves it by hand; `spec derive --write-map`
// closes that from the toolkit with the pin the plan already derived. Nothing
// else on the Map is touched: the record read back from the proxy is sent back
// with exactly the pin fields changed, so an authored field is never rewritten
// from a local copy that may be behind the Map.
//
// Transport: GET /api/maps/<id> (the /api/spec alias the other Map read uses)
// then PUT /api/maps/<id> on the same proxy Worker. The PUT is guarded twice by
// the receiver — `X-Campaign-Key` must match the key stored on the Map, and
// `X-Spec-Hash` (the hash the GET returned) turns a save that landed in
// between into a 409 instead of an overwrite. The campaign key is the
// public-by-design Campaigns API key the packet already carries (the remit
// rail sends the same header); it is a request credential all the same, so the
// proxy base goes through the same TLS gate as every other credential-bearing
// request. `fetchImpl` is parameterized for tests, as in spec-fetch.mjs.

import { compareReleasedSdkVersions, resolveSpecSdkPin } from "./page-kit-sdk-version.mjs";
import { assertSecureProxyBase, DEFAULT_REMIT_TIMEOUT_MS } from "./remit.mjs";
import { DEFAULT_PROXY_BASE, fetchSpecByMapId } from "./spec-fetch.mjs";
import { isReleasedSdkVersion } from "../campaign-spec/dist/index.js";

export const MAP_PIN_FIELD = "global_config.sdk_version";
export const MAP_PIN_ALIAS_FIELD = "runtime.sdk_version";

// Whether the repo pin may be written over the Map's. The rule mirrors the
// spec side of `spec derive` (a spec pin ahead of the repo is never moved
// backwards) and the repo side of `page-kit sync` (a configured pin is never
// lowered): the write goes forward or not at all.
//
//   write             — the Map declares no pin, or one behind the repo pin
//   unchanged         — the Map already carries the repo pin
//   map_ahead         — the Map pin is newer than the repo pin: a bump the
//                       repo never received, doctor's blocked state and
//                       page-kit sync's repair; nothing is written
//   map_pin_unreadable — the Map declares a pin that is not a released
//                       version, or two declarations that disagree; a value
//                       this rule cannot order is not overwritten silently
//
// `repoPin` must already be a released MAJOR.MINOR.PATCH (the derive plan
// checked it before it became a derived value); anything else is refused
// here too so a caller cannot push an unreleased pin into the Map.
export function mapPinWritebackDecision({ repoPin, mapSpec }) {
  if (!isReleasedSdkVersion(repoPin)) {
    return { decision: "repo_pin_invalid", map_pin: null, detail: `the repo pin ${JSON.stringify(repoPin)} is not a released MAJOR.MINOR.PATCH version; nothing is written to the Map.` };
  }
  const pin = resolveSpecSdkPin(mapSpec);
  if (pin.status === "spec_missing") {
    return { decision: "write", map_pin: null, detail: "the Map declares no Campaign Cart SDK version; the repo pin is recorded as its Build hint." };
  }
  if (pin.status !== "ok") {
    const declared = pin.status === "spec_conflict"
      ? `${MAP_PIN_FIELD} ${JSON.stringify(mapSpec?.global_config?.sdk_version)} and ${MAP_PIN_ALIAS_FIELD} ${JSON.stringify(mapSpec?.runtime?.sdk_version)} disagree`
      : `${pin.invalid_declarations.join(" and ")} ${pin.invalid_declarations.map((field) => JSON.stringify(field === MAP_PIN_FIELD ? mapSpec?.global_config?.sdk_version : mapSpec?.runtime?.sdk_version)).join(" / ")} is not a released MAJOR.MINOR.PATCH version`;
    return { decision: "map_pin_unreadable", map_pin: null, detail: `the Map's pin cannot be ordered against the repo pin (${declared}); re-save the Map's Build hints (Campaign Cart SDK version) by hand to ${repoPin}.` };
  }
  const order = compareReleasedSdkVersions(pin.value, repoPin);
  if (order === 0) return { decision: "unchanged", map_pin: pin.value, detail: `the Map already records ${repoPin}.` };
  if (order > 0) {
    return { decision: "map_ahead", map_pin: pin.value, detail: `the Map records ${pin.value}, ahead of the repo pin ${repoPin}; the write goes forward or not at all. If ${pin.value} should ship, bump the repo (page-kit sync moves the pin forward from the spec); if ${repoPin} is right, lower the Map's Build hints by hand.` };
  }
  return { decision: "write", map_pin: pin.value, detail: `the Map records ${pin.value}, behind the repo pin ${repoPin}.` };
}

// The Map record with exactly the pin fields moved: the canonical field, and
// the alias only when the Map already declares it (never created). Every
// other byte of the record is the receiver's own read-back, so the PUT
// re-states what the Map holds rather than what a local copy remembers.
export function applyMapPin(record, repoPin) {
  const next = { ...record, global_config: { ...(record?.global_config ?? {}), sdk_version: repoPin } };
  if (record?.runtime != null && typeof record.runtime === "object" && Object.hasOwn(record.runtime, "sdk_version")) {
    next.runtime = { ...record.runtime, sdk_version: repoPin };
  }
  return next;
}

function identityOf(record) {
  const identity = record?.spec_identity;
  return {
    spec_hash: typeof identity?.spec_hash === "string" ? identity.spec_hash : null,
    saved_at: typeof identity?.saved_at === "string" ? identity.saved_at : (typeof record?.saved_at === "string" ? record.saved_at : null),
  };
}

function failure(result, reason, detail) {
  return { ...result, status: "failed", reason, detail };
}

/**
 * Read the Map, decide, and (unless `dryRun`) PUT the repo pin back.
 *
 * Returns a result document, never throws past a programming error:
 *   { status: written | would_write | unchanged | refused | failed,
 *     reason, detail, map_id, proxy_base, field, before, after,
 *     spec_identity: { before: {spec_hash, saved_at}, after: {…} | null },
 *     warnings: string[] }
 *
 * `refused` reasons are the decision's (map_ahead, map_pin_unreadable,
 * repo_pin_invalid). `failed` reasons: proxy_base_insecure, map_id_missing,
 * key_missing, map_not_found, map_unreadable, key_mismatch,
 * map_changed_underneath, map_rejected, http_error, network_error,
 * response_invalid.
 */
export async function writeMapSdkPin({
  mapId,
  repoPin,
  campaignKey,
  proxyBase = DEFAULT_PROXY_BASE,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REMIT_TIMEOUT_MS,
  warn = undefined,
} = {}) {
  const result = {
    status: "failed",
    reason: null,
    detail: null,
    map_id: typeof mapId === "string" && mapId.trim() ? mapId.trim() : null,
    proxy_base: null,
    field: MAP_PIN_FIELD,
    before: null,
    after: repoPin ?? null,
    spec_identity: { before: null, after: null },
    warnings: [],
    recorded: null,
  };
  if (!result.map_id) return failure(result, "map_id_missing", "the packet names no Map ID (spec.map_id), so there is no Map to write the pin to.");
  if (typeof campaignKey !== "string" || !campaignKey.trim()) {
    return failure(result, "key_missing", "no Campaigns API key was found in the packet, its local CampaignSpec or the declared env source; the Map write needs it as X-Campaign-Key.");
  }
  let base;
  try {
    ({ base } = assertSecureProxyBase(proxyBase, { label: "spec derive --write-map", credential: "the Campaigns API key", ...(warn ? { warn } : {}) }));
  } catch (error) {
    return failure(result, "proxy_base_insecure", error.message);
  }
  result.proxy_base = base;
  if (typeof fetchImpl !== "function") return failure(result, "network_error", "Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");

  let record;
  try {
    record = await fetchSpecByMapId(result.map_id, { proxyBase: base, fetchImpl });
  } catch (error) {
    const message = String(error?.message || error);
    if (/failed: 404\b/.test(message)) return failure(result, "map_not_found", `Map ${result.map_id} was not found on ${base}; nothing was written.`);
    return failure(result, /network error/.test(message) ? "network_error" : "map_unreadable", `${message}; nothing was written to the Map.`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return failure(result, "map_unreadable", `Map ${result.map_id} did not read back as a CampaignSpec object; nothing was written.`);
  }
  result.spec_identity.before = identityOf(record);
  const decision = mapPinWritebackDecision({ repoPin, mapSpec: record });
  result.before = decision.map_pin;
  result.detail = decision.detail;
  if (decision.decision === "unchanged") return { ...result, status: "unchanged", reason: "unchanged" };
  if (decision.decision !== "write") return { ...result, status: "refused", reason: decision.decision };
  if (dryRun) return { ...result, status: "would_write", reason: "dry_run" };

  const body = applyMapPin(record, repoPin);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Campaign-Key": campaignKey.trim(),
    ...(result.spec_identity.before.spec_hash ? { "X-Spec-Hash": result.spec_identity.before.spec_hash } : {}),
  };
  const url = `${base}/api/maps/${encodeURIComponent(result.map_id)}`;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === "function") timer.unref();
  let response;
  try {
    response = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}) });
  } catch (error) {
    return failure(result, "network_error", `Map write network error: ${String(error?.message || error)} (${url}); the Map may be unchanged.`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const receiverError = typeof payload?.error === "string" ? payload.error : null;
  if (response.status === 403) return failure(result, "key_mismatch", `the Map's stored campaign key does not match the packet's (${receiverError || "403"}); nothing was written. Point the packet at the Map's campaign, or re-save the Map under this key.`);
  if (response.status === 404) return failure(result, "map_not_found", `Map ${result.map_id} was not found for writing (${receiverError || "404"}); nothing was written.`);
  if (response.status === 409) return failure(result, "map_changed_underneath", `the Map was saved by someone else between the read and the write (${receiverError || "409"}); nothing was written. Derive again to write against the current save.`);
  if (response.status === 400 || response.status === 422) {
    const count = Array.isArray(payload?.violations) ? payload.violations.filter((row) => row?.severity === "error").length : 0;
    return failure(result, "map_rejected", `the proxy refused the Map as re-stated with the pin (${receiverError || response.status}${count ? `; ${count} error-severity violation${count === 1 ? "" : "s"}` : ""}); nothing was written. The Map needs a re-save in the builder first.`);
  }
  if (!response.ok) return failure(result, "http_error", `Map write failed: ${response.status} ${response.statusText || ""}`.trim() + ` (${url}); the Map may be unchanged.`);
  if (!payload || payload.ok === false) return failure(result, "response_invalid", `the proxy answered ${response.status} without an ok body (${receiverError || "unreadable JSON"}); the Map may or may not have been written. Read the Map back before deriving again.`);
  result.spec_identity.after = identityOf(payload);
  for (const warning of Array.isArray(payload.warnings) ? payload.warnings : []) {
    const text = typeof warning === "string" ? warning : (typeof warning?.message === "string" ? warning.message : null);
    if (text) result.warnings.push(text);
  }
  return { ...result, status: "written", reason: "written" };
}
