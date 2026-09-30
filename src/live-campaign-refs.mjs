// Page refs against the live campaign (#533): the one comparison doctor and QA
// share. A page's `data-next-shipping-id` / package refs were only ever checked
// against the CampaignSpec, so a campaign whose shipping methods or packages
// changed after the Map was saved passed both gates while the SDK silently fell
// back to another method at checkout. This module reads what the live campaign
// serves and says, separately:
//
//   - page vs live: a ref a page renders that the live campaign does not serve
//     (`built_output.shipping_ref_live_missing` / `built_output.package_ref_live_missing`,
//     blockers, whatever the Map says);
//   - Map vs live: refs the CampaignSpec lists that the live campaign does not
//     serve, or the reverse (`spec.campaign_drift`, a warning that never
//     downgrades a page-level blocker).
//
// The read is one GET of `{proxy-base}/api/campaign` under `X-Campaign-Key`
// (with `?ref_id=<id>` when the CampaignSpec names the campaign): NEXT's proxy
// forwards it to the campaign retrieve the Campaign Cart SDK makes in the
// browser and answers with an envelope, `{ ok, status, endpoint,
// requested_ref_id, retrieved_at, data }`, whose `data` is that retrieve's
// body — one campaign, or an array of them. The only credential is the
// public Campaigns API key; no store or Admin credential is reachable from
// here. It takes its fetch and the proxy base as arguments, so a caller that
// passes neither reads nothing. Anything short of one parsed campaign —
// no key, no fetch, a network error, a non-2xx, a timeout, `ok: false`, a body
// that is not the envelope, several campaigns and no ref to pick one — is
// `not_run` with its reason, never a pass and never a fall back to the Map's
// own list.
import { parse as parseHtml } from "parse5";

import { runWithDeadline } from "./deadline.mjs";
import { assertSecureProxyBase } from "./remit.mjs";
import { resolveCampaignsApiKeySource, describeCampaignKeyRejection } from "./campaigns-api-key.mjs";
import { readJsonIfExists, resolveFromFile } from "./cli-helpers.mjs";

export const LIVE_CAMPAIGN_PATH = "/api/campaign";

export const LIVE_CAMPAIGN_TIMEOUT_MS = 10_000;
export const LIVE_CAMPAIGN_MAX_BYTES = 2 * 1024 * 1024;
const LIVE_CAMPAIGN_ERROR_MAX_BYTES = 64 * 1024;

export const LIVE_REF_CODES = Object.freeze({
  shipping: "built_output.shipping_ref_live_missing",
  package: "built_output.package_ref_live_missing",
  drift: "spec.campaign_drift",
  notRun: "built_output.live_refs_not_run",
});

// The refs a page renders, read the way a browser reads the markup: parsed
// with parse5, so any valid attribute syntax is seen (spaces around `=`,
// unquoted or single-quoted values, upper-case names, entity-encoded values)
// and markup the browser never builds into elements is not. One extractor
// feeds the CampaignSpec ref check, the live check and commercial parity.
//
//   - attributes: `data-next-package-id` / `data-package-id` (packages) and
//     `data-next-shipping-id` (shipping), on any element;
//   - inline config: `packageId:` / `shippingId:` keys in `<script>` text and
//     in attribute values (an inline handler or a JSON config attribute);
//   - `<template>` content is read: the SDK clones templates into the live DOM,
//     so a ref there is a ref the shopper can reach;
//   - comments and `<noscript>` content are not: neither becomes an element
//     while the SDK runs.
const PACKAGE_REF_ATTRIBUTES = new Set(["data-next-package-id", "data-package-id"]);
const SHIPPING_REF_ATTRIBUTES = new Set(["data-next-shipping-id"]);
const PACKAGE_CONFIG_KEY = /["']?packageId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi;
const SHIPPING_CONFIG_KEY = /["']?shippingId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi;

export function extractRenderedRefs(content) {
  const packageRefs = new Set();
  const shippingRefs = new Set();
  const readConfig = (text) => {
    for (const match of String(text || "").matchAll(PACKAGE_CONFIG_KEY)) addRenderedRef(packageRefs, match[1] || match[2] || match[3]);
    for (const match of String(text || "").matchAll(SHIPPING_CONFIG_KEY)) addRenderedRef(shippingRefs, match[1] || match[2] || match[3]);
  };
  const visit = (node) => {
    const children = node.content ? node.content.childNodes : node.childNodes;
    for (const child of children || []) {
      if (!child.tagName) continue;
      for (const attr of child.attrs || []) {
        const name = attr.name.toLowerCase();
        if (PACKAGE_REF_ATTRIBUTES.has(name)) addRenderedRef(packageRefs, attr.value);
        else if (SHIPPING_REF_ATTRIBUTES.has(name)) addRenderedRef(shippingRefs, attr.value);
        else readConfig(attr.value);
      }
      if (child.tagName.toLowerCase() === "script") {
        readConfig((child.childNodes || []).map((text) => text.value || "").join(""));
      }
      visit(child);
    }
  };
  visit(parseHtml(String(content || "")));
  return { package_refs: packageRefs, shipping_refs: shippingRefs };
}

export function extractRenderedPackageRefs(content) {
  return extractRenderedRefs(content).package_refs;
}

export function extractRenderedShippingRefs(content) {
  return extractRenderedRefs(content).shipping_refs;
}

function addRenderedRef(refs, value) {
  const ref = String(value || "").trim();
  if (/^[A-Za-z0-9_-]+$/.test(ref)) refs.add(ref);
}

function notRun(reasonCode, reason, extra = {}) {
  return { status: "not_run", reason_code: reasonCode, reason, ...extra };
}

// A ref as the campaign states it: a number or a non-empty string, compared as
// its string form, so `5` on the page and `"5"` in the API are the same ref.
function liveRef(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value.trim())) return value.trim();
  return null;
}

// The campaign body, or null when it is not one. Both lists must be arrays
// (an empty one is a campaign that serves nothing of that kind) and every
// entry must carry a ref, so a partial body is never read as "not served".
export function liveCampaignRefs(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Array.isArray(body.packages) || !Array.isArray(body.shipping_methods)) return null;
  const packages = body.packages.map((pkg) => liveRef(pkg?.ref_id));
  const shipping = body.shipping_methods.map((method) => liveRef(method?.ref_id));
  if (packages.includes(null) || shipping.includes(null)) return null;
  return { package_refs: [...new Set(packages)].sort(), shipping_refs: [...new Set(shipping)].sort() };
}

// The campaign's own ref as the CampaignSpec records it (`campaign.ref_id`,
// the numeric platform id), or null when it names none the proxy's
// `?ref_id=` would take.
export function campaignRefIdFromSpec(spec) {
  const value = spec?.campaign?.ref_id;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

// The proxy's error text as one short line: the envelope's `error` string,
// whitespace collapsed, the key redacted if it were ever echoed, and capped.
// Never the raw body.
function proxyErrorText(body, apiKey) {
  const raw = body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string" ? body.error : "";
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (apiKey && text.includes(apiKey)) text = text.split(apiKey).join("[key]");
  if (text.length > 160) text = `${text.slice(0, 157)}...`;
  return text;
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The one campaign in the envelope's `data`: the object itself, or from an
// array the entry whose ref is the one asked for (or the only entry, when no
// ref was asked for). Returns { campaign } or { notRun }.
function pickCampaign(data, refId) {
  if (!Array.isArray(data)) return { campaign: data };
  if (refId) {
    const matches = data.filter((entry) => liveRef(entry?.ref_id) === refId);
    if (matches.length === 1) return { campaign: matches[0] };
    return matches.length === 0
      ? { notRun: notRun("not_found", `The live campaign read returned ${data.length} campaign(s), none with ref ${refId}, so there was no live campaign to compare against.`) }
      : { notRun: notRun("ambiguous_campaign", `The live campaign read returned ${matches.length} campaigns with ref ${refId}, so it could not tell which one the pages use.`) };
  }
  if (data.length === 1) return { campaign: data[0] };
  return data.length === 0
    ? { notRun: notRun("not_found", "The live campaign read returned no campaign for this key, so there was no live campaign to compare against.") }
    : { notRun: notRun("ambiguous_campaign", `The live campaign read returned ${data.length} campaigns for this key and the CampaignSpec names no campaign.ref_id to pick one, so it could not tell which one the pages use.`) };
}

// One GET of the campaign the key belongs to, through the proxy. `apiKey` is
// the public Campaigns API key; it travels as the X-Campaign-Key header the
// proxy's other routes take and never appears in the result. `campaignRefId`,
// when known, asks the proxy for that one campaign. The proxy base passes the
// same transport gate as every other proxy request: https, or a loopback host
// over http.
export async function readLiveCampaign({
  apiKey,
  proxyBase = null,
  fetchImpl = null,
  campaignRefId = null,
  timeoutMs = LIVE_CAMPAIGN_TIMEOUT_MS,
  maxBytes = LIVE_CAMPAIGN_MAX_BYTES,
  warn = undefined,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return notRun("no_key", "No public Campaigns API key resolved, so the live campaign was not read.");
  }
  if (typeof proxyBase !== "string" || !proxyBase.trim()) {
    return notRun("not_read", "This invocation does not read the live campaign.");
  }
  const refId = campaignRefId == null ? null : String(campaignRefId).trim();
  if (refId !== null && !/^\d+$/.test(refId)) {
    return notRun("unexpected_ref", "The CampaignSpec's campaign.ref_id is not a numeric campaign id, so the live campaign was not read.");
  }
  let url;
  try {
    const { base } = assertSecureProxyBase(proxyBase, { label: "Live campaign read", credential: "the public campaign key", ...(warn ? { warn } : {}) });
    url = `${base}${LIVE_CAMPAIGN_PATH}${refId ? `?ref_id=${refId}` : ""}`;
  } catch (error) {
    return notRun("insecure_proxy_base", `The live campaign was not read: ${error.message}`);
  }
  if (typeof fetchImpl !== "function") {
    return notRun("fetch_unavailable", "No fetch is available in this runtime, so the live campaign was not read.");
  }
  const controller = new AbortController();
  let response;
  let text;
  try {
    ({ response, text } = await runWithDeadline(async () => {
      const value = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", "X-Campaign-Key": apiKey.trim() },
        signal: controller.signal,
      });
      // Loaded here rather than at the top: QA's commercial parity imports
      // this module's extractors, and a static import back would be a cycle.
      const { readBoundedResponseText } = await import("./qa-commercial-parity.mjs");
      if (!value?.ok) {
        // A non-2xx body is read only for the proxy's error line; an
        // unreadable one leaves the status to speak for itself.
        let errorText = null;
        try {
          errorText = await readBoundedResponseText(value, { maxBytes: LIVE_CAMPAIGN_ERROR_MAX_BYTES, kind: "live_campaign" });
        } catch {
          // the status is the finding
        }
        return { response: value, text: errorText };
      }
      return { response: value, text: await readBoundedResponseText(value, { maxBytes, kind: "live_campaign" }) };
    }, {
      timeoutMs,
      onTimeout: () => controller.abort(),
      timeoutError: () => Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: "timeout" }),
      label: "readLiveCampaign",
    }));
  } catch (error) {
    if (error?.code === "timeout") return notRun("timeout", `The live campaign read timed out after ${timeoutMs}ms.`);
    if (error?.code === "live_campaign_response_too_large") return notRun("too_large", `The live campaign response exceeded ${maxBytes} bytes.`);
    return notRun("network_error", `The live campaign read failed before a response: ${error?.message || String(error)}.`);
  }
  const requested = refId ? { campaign_ref_id: refId } : {};
  const parsed = typeof text === "string" ? parseJson(text) : { ok: false };
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : null;
    const said = parsed.ok ? proxyErrorText(parsed.value, apiKey.trim()) : "";
    const because = said ? ` The proxy said: ${said}` : "";
    return notRun(
      status === 404 ? "not_found" : "http_status",
      status === 404
        ? `The live campaign read answered 404${refId ? ` for campaign ref ${refId}` : " for this key"}: no live campaign was found to compare against.${because}`
        : `The live campaign read answered ${status ?? "an unknown status"}, so the live campaign was not read.${because}`,
      { http_status: status, ...requested },
    );
  }
  if (!parsed.ok) return notRun("unparseable", "The live campaign response was not JSON.", requested);
  const envelope = parsed.value;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || typeof envelope.ok !== "boolean") {
    return notRun("unexpected_body", "The live campaign response was not the proxy's envelope ({ ok, data }).", requested);
  }
  if (envelope.ok !== true) {
    const said = proxyErrorText(envelope, apiKey.trim());
    return notRun("proxy_error", `The proxy answered ok: false${said ? `: ${said}` : ""}, so the live campaign was not read.`, requested);
  }
  if (envelope.data == null || typeof envelope.data !== "object") {
    // ok: true with no campaign; the proxy's error line, when it sent one, is
    // the reason.
    const said = proxyErrorText(envelope, apiKey.trim());
    return said
      ? notRun("proxy_error", `The proxy answered with no campaign in its data field: ${said}, so the live campaign was not read.`, requested)
      : notRun("unexpected_body", "The live campaign response carried no campaign in its data field.", requested);
  }
  const picked = pickCampaign(envelope.data, refId);
  if (picked.notRun) return { ...picked.notRun, ...requested };
  const refs = liveCampaignRefs(picked.campaign);
  if (!refs) return notRun("unexpected_body", "The live campaign did not carry package and shipping-method lists with a ref on every entry.", requested);
  return { status: "read", ...requested, ...refs };
}

// The `--no-live-refs` opt-out on `doctor` and `qa run`: no request, and the
// check recorded not_run with reason `disabled`, never a pass.
export function liveRefsDisabled(args) {
  return Boolean(args) && Object.hasOwn(args, "no-live-refs");
}

export function disabledLiveRead() {
  return notRun("disabled", "--no-live-refs was given, so the live campaign was not read.");
}

// An env var whose name says it holds something other than a public campaign
// key. The shared resolver only asks that the name contain CAMPAIGN, so
// `CAMPAIGN_ADMIN_TOKEN` would pass it; this read sends the value off the
// machine, so it also refuses these words.
const NON_PUBLIC_KEY_ENV_WORD = /ADMIN|TOKEN|SECRET|PASSWORD|PRIVATE|STORE/i;

function refusedEnvKeySource(packet, resolved) {
  const source = typeof packet?.campaign?.api_key_source === "string" ? packet.campaign.api_key_source.trim() : "";
  if (!source.startsWith("env:")) return null;
  const envName = source.slice("env:".length).trim();
  if (!NON_PUBLIC_KEY_ENV_WORD.test(envName)) return null;
  // Only when the env source is the one in play: a key from the packet or its
  // CampaignSpec wins over it, and a refused packet or CampaignSpec value is
  // already reported as that.
  const envInPlay = resolved.key
    ? resolved.origin === `env:${envName}`
    : !resolved.rejected || resolved.rejected.kind === "unsupported_env_name" || resolved.rejected.source === `env:${envName}`;
  return envInPlay ? envName : null;
}

// The packet-local CampaignSpec, read the way the key resolver reads it;
// undefined when the packet names none or it cannot be read.
function readPacketLocalSpec(packet, packetPath) {
  const localPath = packet?.spec?.local_path;
  if (typeof localPath !== "string" || !localPath.trim() || typeof packetPath !== "string" || !packetPath.trim()) return undefined;
  try {
    return readJsonIfExists(resolveFromFile(packetPath, localPath)) ?? undefined;
  } catch {
    return undefined;
  }
}

// The key from the packet, its local CampaignSpec, or the declared
// campaign-key env var (the resolver the remit and Map write use; its shape
// and env-name gates apply, plus the stricter env-name gate above), then one
// read, for the campaign the CampaignSpec's `campaign.ref_id` names when it
// names one.
export async function readLiveCampaignForPacket({ packet, packetPath = null, spec = undefined, env = process.env, fetchImpl = null, proxyBase = null, timeoutMs, warn } = {}) {
  const localSpec = spec !== undefined ? spec : readPacketLocalSpec(packet, packetPath);
  const resolved = resolveCampaignsApiKeySource(packet, packetPath, env, localSpec === undefined ? {} : { spec: localSpec });
  const refusedEnv = refusedEnvKeySource(packet, resolved);
  if (refusedEnv) {
    return notRun(
      "key_source_refused",
      `api_key_source "env:${refusedEnv}" names a variable that holds an admin, store or secret credential rather than the public Campaigns API key, so its value was not sent and the live campaign was not read. Point api_key_source at the public campaign key (for example env:CAMPAIGNS_API_KEY).`,
    );
  }
  if (!resolved.key) {
    return resolved.rejected
      ? notRun("key_rejected", describeCampaignKeyRejection(resolved.rejected))
      : notRun("no_key", "No public Campaigns API key resolved from the packet, its local CampaignSpec or the declared env source, so the live campaign was not read.");
  }
  const result = await readLiveCampaign({
    apiKey: resolved.key,
    fetchImpl,
    proxyBase,
    campaignRefId: campaignRefIdFromSpec(localSpec),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(warn ? { warn } : {}),
  });
  return { ...result, key_source: resolved.origin };
}

function sortedRefs(values) {
  return [...new Set([...values].map(String))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// pages: [{ page_id, file?, package_refs, shipping_refs }] (Sets or arrays).
// map: { package_refs, shipping_refs } from the CampaignSpec. live: a
// readLiveCampaign result, or undefined when the caller did not read.
export function evaluateLiveCampaignRefs({ pages = [], map = {}, live } = {}) {
  const checkedPages = pages.filter((page) => page && page.page_id != null);
  if (!live) live = notRun("not_read", "This invocation does not read the live campaign.");
  if (live.status !== "read") {
    return {
      status: "not_run",
      reason_code: live.reason_code,
      reason: live.reason,
      // A read that was attempted and failed is the operator's to see; no key
      // is already reported by the key check, a caller that does not read
      // has nothing to report, and `--no-live-refs` asked for no read.
      attempted: !["no_key", "key_rejected", "not_read", "disabled"].includes(live.reason_code),
      ...(live.http_status !== undefined ? { http_status: live.http_status } : {}),
      checked_pages: checkedPages.length,
      page_findings: [],
      drift: null,
    };
  }
  const livePackages = new Set(live.package_refs);
  const liveShipping = new Set(live.shipping_refs);
  const pageFindings = [];
  for (const page of checkedPages) {
    const missingShipping = sortedRefs(page.shipping_refs || []).filter((ref) => !liveShipping.has(ref));
    const missingPackages = sortedRefs(page.package_refs || []).filter((ref) => !livePackages.has(ref));
    if (missingShipping.length) pageFindings.push({ code: LIVE_REF_CODES.shipping, kind: "shipping", page_id: String(page.page_id), ...(page.file ? { file: page.file } : {}), refs: missingShipping });
    if (missingPackages.length) pageFindings.push({ code: LIVE_REF_CODES.package, kind: "package", page_id: String(page.page_id), ...(page.file ? { file: page.file } : {}), refs: missingPackages });
  }
  const mapPackages = sortedRefs(map.package_refs || []);
  const mapShipping = sortedRefs(map.shipping_refs || []);
  const drift = {
    packages: {
      map_only: mapPackages.filter((ref) => !livePackages.has(ref)),
      live_only: sortedRefs(livePackages).filter((ref) => !mapPackages.includes(ref)),
    },
    shipping_methods: {
      map_only: mapShipping.filter((ref) => !liveShipping.has(ref)),
      live_only: sortedRefs(liveShipping).filter((ref) => !mapShipping.includes(ref)),
    },
  };
  const hasDrift = Object.values(drift).some((side) => side.map_only.length || side.live_only.length);
  return {
    status: pageFindings.length ? "blocked" : "pass",
    checked_pages: checkedPages.length,
    live_package_count: livePackages.size,
    live_shipping_count: liveShipping.size,
    page_findings: pageFindings,
    drift: hasDrift ? drift : null,
  };
}

export function liveRefFindingMessage(finding) {
  const noun = finding.kind === "shipping" ? "shipping ID(s)" : "package ID(s)";
  const effect = finding.kind === "shipping"
    ? "the SDK falls back to another shipping method and the order is charged that method's price"
    : "the SDK cannot add a package the campaign does not serve";
  return `Page "${finding.page_id}" references ${noun} the live campaign does not serve: ${finding.refs.join(", ")}. The CampaignSpec is not the authority here; ${effect}. Point the page at a ${finding.kind === "shipping" ? "shipping method" : "package"} the campaign serves, or restore it in the campaign.`;
}

export function campaignDriftMessage(drift) {
  const parts = [];
  const side = (label, values) => { if (values.length) parts.push(`${label}: ${values.join(", ")}`); };
  side("packages in the CampaignSpec but not the live campaign", drift.packages.map_only);
  side("packages in the live campaign but not the CampaignSpec", drift.packages.live_only);
  side("shipping methods in the CampaignSpec but not the live campaign", drift.shipping_methods.map_only);
  side("shipping methods in the live campaign but not the CampaignSpec", drift.shipping_methods.live_only);
  return `The saved CampaignSpec and the live campaign differ — ${parts.join("; ")}. Re-save the Map from the live campaign so doctor and QA compare against what checkout serves.`;
}

export function liveRefsNotRunMessage(result) {
  return `The live campaign ref check did not run: ${result.reason} Page shipping and package refs were compared against the CampaignSpec only.`;
}
