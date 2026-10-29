// Change scope: what a change to built output owes.
//
// A change that touches only some pages' copy, images or styling owes QA on
// those pages; Polish is advisory for it. A change that touches commerce owes
// the full Polish and QA. Commerce here is what a page sends to the Campaign
// Cart SDK or the funnel: the campaign's Page Kit config entry (SDK pin,
// analytics ids, store fields), package, offer and shipping refs, the upsell
// order and routes, and scripts. A file that cannot be mapped to one page
// counts as commerce, and so does any change this module cannot classify.
//
// `record build` keeps a commerce signature beside the build manifest: one
// hash per built page over the page's commerce-bearing markup, plus one hash
// of the campaign's config entry. A later change compares the pages that
// differ against those hashes. It also keeps `build_changes`, one entry per
// recorded rebuild, so a stage that reviewed an older build can still read
// which pages changed since then after the manifest has moved on.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "parse5";

import { inferPageType, pageIdForRoute, routeForFile } from "./built-site-scope.mjs";
import { loadPageKitCampaignEntry } from "./page-kit-campaign-config.mjs";

export const COMMERCE_SIGNATURE_ALGORITHM = "commerce-signature/v1";
export const CHANGE_KINDS = Object.freeze(["none", "page_only", "commerce_affecting", "unknown"]);
// The reasons a change counts as commerce, closed so readers can switch on them.
export const COMMERCE_REASONS = Object.freeze([
  "unmapped_file",
  "page_added",
  "page_removed",
  "checkout_page",
  "commerce_markup_changed",
  "commerce_signature_unavailable",
  "campaign_config_changed",
  "campaign_config_unavailable",
  "change_history_unavailable",
]);
// How many rebuilds `record build` keeps in build_changes, and how many paths
// one entry lists per list. A stage that reviewed a build older than the
// kept history reads its change as unknown, and so owes the full stages.
export const BUILD_CHANGES_LIMIT = 25;
export const CHANGE_PATH_LIMIT = 20;
// CPK page types that take payment or render the checkout surface.
const CHECKOUT_PAGE_TYPES = new Set(["checkout", "checkout_step", "select"]);
// Attribute names that carry package, offer, shipping, upsell or checkout
// identity on built pages: data-next-*, the older os-checkout-* bindings and
// other data-* names for those refs. Inline event handlers (onclick and the
// like) can call the SDK, so they count too.
const COMMERCE_ATTRIBUTE = /^data-next-|^data-[a-z0-9-]*(?:package|offer|shipping|upsell|voucher|coupon)[a-z0-9-]*$|^data-(?:next-)?[a-z0-9-]*template-id$|^os-checkout(?:-|$)|^on[a-z]+$/;
// Attributes that render the checkout surface or take payment. A page that
// carries one is a checkout page whatever its type or route says.
const CHECKOUT_ATTRIBUTE = /^data-next-(?:checkout|payment|express-checkout)(?:-|$)|^os-checkout(?:-|$)/;

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function textOf(node) {
  const children = node.content ? node.content.childNodes : node.childNodes;
  return (children || []).map((child) => (child.nodeName === "#text" ? child.value || "" : "")).join("");
}

// The commerce-bearing facts of one built page, in document order: every
// SDK attribute and inline event handler, every next-* meta tag, every
// script (src, or the inline body), every link target and form action. Copy,
// images and styling are left out, so a copy edit keeps the signature.
// `checkout` is true when the page carries checkout or payment markup.
export function pageCommerceFacts(html) {
  const facts = [];
  let pageType = null;
  let checkout = false;
  const walk = (node) => {
    const children = node.content ? node.content.childNodes : node.childNodes;
    for (const child of children || []) {
      if (child.nodeName && !child.nodeName.startsWith("#")) {
        const tag = child.nodeName.toLowerCase();
        const attrs = new Map((child.attrs || []).map((attr) => [attr.name.toLowerCase(), attr.value]));
        for (const [name, value] of attrs) {
          if (COMMERCE_ATTRIBUTE.test(name)) facts.push(`${tag}[${name}]=${value}`);
          if (CHECKOUT_ATTRIBUTE.test(name)) checkout = true;
        }
        const metaName = String(attrs.get("name") || "").trim().toLowerCase();
        if (tag === "meta" && metaName.startsWith("next-")) {
          facts.push(`meta[${metaName}]=${attrs.get("content") ?? ""}`);
          if (metaName === "next-page-type") pageType = String(attrs.get("content") || "").trim().toLowerCase() || null;
        }
        if (tag === "script") facts.push(attrs.has("src") ? `script[src]=${attrs.get("src")}` : `script=${sha256(textOf(child))}`);
        if (tag === "a" && attrs.has("href")) facts.push(`a[href]=${attrs.get("href")}`);
        if (tag === "form" && attrs.has("action")) facts.push(`form[action]=${attrs.get("action")}`);
      }
      walk(child);
    }
  };
  walk(parse(String(html)));
  return { signature: sha256(facts.join("\n")), page_type: pageType, checkout };
}

// The campaign's own Page Kit config entry, hashed; a missing or unreadable
// entry is its status, so a change from present to absent still differs.
export function campaignConfigFingerprint(targetRepo, publicRouteSlug) {
  const load = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug });
  if (load.status !== "ok") return `unavailable:${load.status}`;
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return sha256(JSON.stringify(canonical(load.entry)));
}

/**
 * The signature `record build` keeps on stages.assembly.commerce_signature:
 * `{ algorithm, campaign_config, pages: { <built path>: sha256 } }` for the
 * pages of a resolved built-site scope (resolveBuiltSiteScope). Null when the
 * scope did not resolve; a page that cannot be read is left out, so a later
 * change to it reads as unclassifiable.
 */
export function buildCommerceSignature({ scope, outputRoot, targetRepo, publicRouteSlug }) {
  if (!scope?.ok) return null;
  const pages = {};
  for (const page of scope.pages) {
    const path = builtPath(outputRoot, page.built_path);
    try {
      pages[path] = pageCommerceFacts(readFileSync(page.built_path, "utf8")).signature;
    } catch { /* left out: an unreadable page cannot be classified later */ }
  }
  return { algorithm: COMMERCE_SIGNATURE_ALGORITHM, campaign_config: campaignConfigFingerprint(targetRepo, publicRouteSlug), pages };
}

function builtPath(outputRoot, file) {
  const relativePath = file.startsWith(outputRoot) ? file.slice(outputRoot.length).replace(/^[\\/]+/, "") : file;
  return relativePath.split(/[\\/]/).join("/");
}

function recordedSignature(assembly) {
  const signature = assembly?.commerce_signature;
  return isObject(signature) && signature.algorithm === COMMERCE_SIGNATURE_ALGORITHM && isObject(signature.pages)
    && typeof signature.campaign_config === "string" ? signature : null;
}

const capped = (items) => items.slice(0, CHANGE_PATH_LIMIT);

/**
 * Classify the drift between a recorded build and the output on disk.
 * `changes` is assessEvidenceDebt's known change list (changed_pages,
 * unmapped_files, extra, missing). `baseline` is the recorded
 * stages.assembly. Returns `{ kind, reasons }`, `kind` one of CHANGE_KINDS
 * and `reasons` the commerce reasons found, each `{ code, path? }`.
 */
export function classifyDrift({ changes, baseline, outputRoot, targetRepo, publicRouteSlug }) {
  if (changes?.status !== "known") return { kind: "unknown", reasons: [] };
  if (!changes.changed_pages.length && !changes.unmapped_files.length) return { kind: "none", reasons: [] };
  const reasons = [];
  for (const path of changes.unmapped_files) reasons.push({ code: "unmapped_file", path });
  const signature = recordedSignature(baseline);
  if (!signature) reasons.push({ code: "commerce_signature_unavailable" });
  else if (signature.campaign_config.startsWith("unavailable:")
    || campaignConfigFingerprint(targetRepo, publicRouteSlug) !== signature.campaign_config) {
    reasons.push({ code: signature.campaign_config.startsWith("unavailable:") ? "campaign_config_unavailable" : "campaign_config_changed" });
  }
  for (const page of changes.changed_pages) {
    if (changes.extra.includes(page.built_path)) { reasons.push({ code: "page_added", path: page.built_path }); continue; }
    if (changes.missing.includes(page.built_path)) { reasons.push({ code: "page_removed", path: page.built_path }); continue; }
    let current;
    try {
      current = pageCommerceFacts(readFileSync(join(outputRoot, page.built_path), "utf8"));
    } catch {
      reasons.push({ code: "commerce_signature_unavailable", path: page.built_path });
      continue;
    }
    const type = current.page_type || inferPageType(routeForFile(outputRoot, join(outputRoot, page.built_path)));
    if (CHECKOUT_PAGE_TYPES.has(type) || current.checkout) reasons.push({ code: "checkout_page", path: page.built_path });
    else if (!signature || !Object.hasOwn(signature.pages, page.built_path)) {
      if (signature) reasons.push({ code: "commerce_signature_unavailable", path: page.built_path });
    } else if (signature.pages[page.built_path] !== current.signature) {
      reasons.push({ code: "commerce_markup_changed", path: page.built_path });
    }
  }
  return { kind: reasons.length ? "commerce_affecting" : "page_only", reasons: capped(reasons) };
}

/**
 * One build_changes entry for a rebuild from `from` to `to`, from the debt
 * assessment of the new output against the previous record.
 */
export function buildChangeEntry({ from, to, at, changes, classification }) {
  return {
    from_build_fingerprint: from,
    build_fingerprint: to,
    recorded_at: at,
    kind: classification.kind,
    changed_pages: changes.status === "known" ? changes.changed_pages.map((page) => ({ page_id: page.page_id, built_path: page.built_path })) : [],
    unmapped_files: changes.status === "known" ? capped(changes.unmapped_files) : [],
    unmapped_file_count: changes.status === "known" ? changes.unmapped_files.length : 0,
    reasons: classification.reasons,
  };
}

function validEntry(entry) {
  return isObject(entry) && typeof entry.from_build_fingerprint === "string" && typeof entry.build_fingerprint === "string"
    && CHANGE_KINDS.includes(entry.kind) && Array.isArray(entry.changed_pages) && Array.isArray(entry.reasons);
}

/**
 * The kept rebuild history after recording `entry`: the previous history
 * with this rebuild appended, trimmed to the entries a stage anchored at one
 * of `anchors` can still walk, and to BUILD_CHANGES_LIMIT.
 */
export function nextBuildChanges(previous, entry, anchors = []) {
  const history = [...(Array.isArray(previous) ? previous.filter(validEntry) : []), entry];
  const wanted = new Set(anchors.filter((anchor) => typeof anchor === "string" && anchor));
  const kept = [];
  let at = entry.build_fingerprint;
  for (let index = history.length - 1; index >= 0 && wanted.size; index -= 1) {
    if (history[index].build_fingerprint !== at) break;
    kept.unshift(history[index]);
    at = history[index].from_build_fingerprint;
    wanted.delete(at);
  }
  return kept.slice(-BUILD_CHANGES_LIMIT);
}

const KIND_RANK = Object.freeze({ none: 0, page_only: 1, commerce_affecting: 2, unknown: 3 });
// The worse of two change kinds; an unrecognized kind reads as unknown.
const rankOf = (kind) => KIND_RANK[kind] ?? KIND_RANK.unknown;
export function worseChangeKind(a, b) {
  const kind = rankOf(a) >= rankOf(b) ? a : b;
  return Object.hasOwn(KIND_RANK, kind) ? kind : "unknown";
}

/**
 * The change a stage that reviewed `anchor` owes for: the recorded rebuilds
 * from `anchor` to the recorded build, then the drift from the recorded build
 * to the output on disk. Returns `{ kind, since_build_fingerprint,
 * changed_pages, unmapped_files, reasons }`; `kind` is unknown when the
 * history does not reach `anchor` or the drift cannot be read.
 */
export function changeSince(anchor, { assembly, drift, driftClassification }) {
  const recorded = typeof assembly?.build_fingerprint === "string" ? assembly.build_fingerprint : null;
  const result = { kind: "none", since_build_fingerprint: anchor || null, changed_pages: [], unmapped_files: [], reasons: [] };
  if (!anchor || !recorded) return { ...result, kind: "unknown" };
  const segments = [];
  if (anchor !== recorded) {
    const history = Array.isArray(assembly.build_changes) ? assembly.build_changes.filter(validEntry) : [];
    let at = recorded;
    for (let index = history.length - 1; index >= 0 && at !== anchor; index -= 1) {
      if (history[index].build_fingerprint !== at) break;
      segments.unshift(history[index]);
      at = history[index].from_build_fingerprint;
    }
    if (at !== anchor) return { ...result, kind: "unknown", reasons: [{ code: "change_history_unavailable" }] };
  }
  const pages = new Map();
  const unmapped = new Set();
  let kind = "none";
  const add = (part, partKind, reasons) => {
    kind = worseChangeKind(kind, partKind);
    for (const page of part.changed_pages || []) pages.set(page.built_path, { page_id: page.page_id, built_path: page.built_path });
    for (const path of part.unmapped_files || []) unmapped.add(path);
    result.reasons.push(...(reasons || []));
  };
  for (const segment of segments) add(segment, segment.kind, segment.reasons);
  if (drift?.status !== "known") kind = "unknown";
  else add(drift, driftClassification?.kind || "unknown", driftClassification?.reasons);
  return {
    ...result,
    kind,
    changed_pages: [...pages.values()].sort((a, b) => a.built_path.localeCompare(b.built_path)),
    unmapped_files: capped([...unmapped].sort()),
    reasons: capped(result.reasons),
  };
}

// The page id a QA topology page has in the change lists: the id of its
// route under the campaign base, as built-site scope derives it.
export function routePageIdForUrl(url, baseUrl) {
  try {
    const base = new URL(baseUrl).pathname.replace(/\/+$/, "");
    const path = new URL(url).pathname;
    const route = (path.startsWith(`${base}/`) || path === base ? path.slice(base.length) : path)
      .replace(/^\/+/, "").replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/i, "").replace(/\/+$/, "");
    return pageIdForRoute(route);
  } catch {
    return null;
  }
}
