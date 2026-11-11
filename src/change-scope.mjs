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
// A stylesheet or image that built pages link directly (#753) is a change to
// those pages: mapLinkedAssets maps it, and it owes QA on them only. A
// checkout or upsell page reached only that way owes a browser QA run, still
// without test orders: styling cannot change what a page sends to the SDK,
// but it can hide or cover a buy button.
//
// `record build` keeps a commerce signature beside the build manifest: one
// hash per built page over the page's commerce-bearing markup, plus one hash
// of the campaign's config entry. A later change compares the pages that
// differ against those hashes. It also keeps `build_changes`, one entry per
// recorded rebuild, so a stage that reviewed an older build can still read
// which pages changed since then after the manifest has moved on.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { parse } from "parse5";

import { builtAssetReferences } from "./built-script-syntax.mjs";
import { inferPageType, pageIdForRoute, routeForFile } from "./built-site-scope.mjs";
import { htmlScanDocuments, readHtmlScanText } from "./html-scan.mjs";
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
// Reasons that explain a page-only change without making it commerce:
// `linked_asset_changed` names a changed asset and the pages that link it
// (`pages`, their ids); `linked_asset_buy_page` names a checkout or upsell
// page reached only through one, which owes a browser QA run.
export const LINKED_ASSET_REASONS = Object.freeze(["linked_asset_changed", "linked_asset_buy_page"]);
// How many rebuilds `record build` keeps in build_changes, and how many paths
// one entry lists per list. A stage that reviewed a build older than the
// kept history reads its change as unknown, and so owes the full stages.
export const BUILD_CHANGES_LIMIT = 25;
export const CHANGE_PATH_LIMIT = 20;
// CPK page types that take payment or render the checkout surface.
const CHECKOUT_PAGE_TYPES = new Set(["checkout", "checkout_step", "select"]);
// Page types that carry a buy button: checkout and the post-purchase offers.
const BUY_PAGE_TYPES = new Set([...CHECKOUT_PAGE_TYPES, "upsell", "downsell"]);
// What a direct link can map: a stylesheet the browser applies (text/css, so
// .css) and an image format. Anything else a link or img names stays unmapped.
const LINKED_ASSET_EXTENSIONS = Object.freeze({
  stylesheet: new Set([".css"]),
  image: new Set([".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]),
});
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
// `document`, when a function, returns the parse5 tree of `html` (the
// doctor's shared inputs parse once for every consumer).
export function pageCommerceFacts(html, document = null) {
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
  walk(typeof document === "function" ? document() : parse(String(html)));
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
 * Map changed files that built pages link directly to those pages (#753).
 * `files` are changed paths relative to `outputRoot` that are not a page's
 * HTML; `pages` the built-site scope's pages (`page_id`, absolute
 * `built_path`), and `siteRoot` the directory the site is served from. Each
 * page's `<link rel="stylesheet">` and `<img src|srcset>` are read from the
 * run's shared trees and resolved as the browser resolves them
 * (builtAssetReferences). A deleted file maps when a page still names it.
 * A file reached only through `@import` or `url()`, a symlink leaving the
 * site, or a file of another type stays unmapped.
 *
 * Returns `{ linked: [{ path, pages: [{ page_id, built_path }] }], unmapped }`,
 * both in `files` order, page paths relative to `outputRoot`.
 */
export function mapLinkedAssets({ files = [], pages = [], outputRoot, siteRoot }) {
  const candidates = new Map(files.flatMap((path) => {
    const type = Object.keys(LINKED_ASSET_EXTENSIONS).find((kind) => LINKED_ASSET_EXTENSIONS[kind].has(extname(path).toLowerCase()));
    return type ? [[join(outputRoot, path), { path, type }]] : [];
  }));
  if (!candidates.size || !pages.length) return { linked: [], unmapped: [...files] };
  const linkedPages = new Map();
  for (const ref of builtAssetReferences({ site_root: siteRoot, campaign_dir: outputRoot, pages }, candidates.keys()).refs) {
    const served = ref.status === "local" ? [ref.path] : ref.status === "missing" ? ref.candidates || [] : [];
    const file = served.map((path) => candidates.get(path)).find((entry) => entry && entry.type === ref.kind);
    if (!file) continue;
    if (!linkedPages.has(file.path)) linkedPages.set(file.path, new Map());
    const builtPath = relative(outputRoot, ref.built_path).split(sep).join("/");
    linkedPages.get(file.path).set(builtPath, { page_id: ref.page_id, built_path: builtPath });
  }
  return {
    linked: files.filter((path) => linkedPages.has(path)).map((path) => ({
      path, pages: [...linkedPages.get(path).values()].sort((a, b) => a.built_path.localeCompare(b.built_path)),
    })),
    unmapped: files.filter((path) => !linkedPages.has(path)),
  };
}

/**
 * Classify the drift between a recorded build and the output on disk.
 * `changes` is assessEvidenceDebt's known change list (changed_pages,
 * unmapped_files, extra, missing). `baseline` is the recorded
 * stages.assembly. Returns `{ kind, reasons }`, `kind` one of CHANGE_KINDS
 * and `reasons` the commerce reasons found, each `{ code, path? }`, then the
 * LINKED_ASSET_REASONS, which never make a change commerce.
 * `linkedAssets` is mapLinkedAssets's `linked`: a page reached only through
 * one (its own HTML unchanged) is not checked for commerce markup, and a
 * checkout or upsell page among them reads `linked_asset_buy_page`.
 * `pagePaths` is every page of the built-site scope: a changed page is read
 * from the run's shared inputs and takes the tree of that whole set when it
 * is shared (htmlScanDocuments), else it is parsed here. The set is shared
 * only when the run already holds every page's bytes, as doctor's built-output
 * checks do, and its trees fit the parse budget; otherwise (no CampaignSpec,
 * so no built-output checks; no snapshot at all; or a page set past the parse
 * budget) each changed page is parsed per use, as before.
 */
export function classifyDrift({ changes, baseline, outputRoot, targetRepo, publicRouteSlug, pagePaths = [], linkedAssets = [] }) {
  if (changes?.status !== "known") return { kind: "unknown", reasons: [] };
  if (!changes.changed_pages.length && !changes.unmapped_files.length && !linkedAssets.length) return { kind: "none", reasons: [] };
  const reasons = [];
  const signature = recordedSignature(baseline);
  // First, so the list's cap never drops it: `record baseline` reads it.
  if (!signature) reasons.push({ code: "commerce_signature_unavailable" });
  for (const path of changes.unmapped_files) reasons.push({ code: "unmapped_file", path });
  if (signature && (signature.campaign_config.startsWith("unavailable:")
    || campaignConfigFingerprint(targetRepo, publicRouteSlug) !== signature.campaign_config)) {
    reasons.push({ code: signature.campaign_config.startsWith("unavailable:") ? "campaign_config_unavailable" : "campaign_config_changed" });
  }
  const documentOf = htmlScanDocuments(pagePaths);
  const factsOf = (page) => {
    const file = join(outputRoot, page.built_path);
    const html = readHtmlScanText(file);
    return pageCommerceFacts(html, () => documentOf(file, html));
  };
  const typeOf = (page, facts) => facts.page_type || inferPageType(routeForFile(outputRoot, join(outputRoot, page.built_path)));
  for (const page of changes.changed_pages) {
    if (changes.extra.includes(page.built_path)) { reasons.push({ code: "page_added", path: page.built_path }); continue; }
    if (changes.missing.includes(page.built_path)) { reasons.push({ code: "page_removed", path: page.built_path }); continue; }
    let current;
    try {
      current = factsOf(page);
    } catch {
      reasons.push({ code: "commerce_signature_unavailable", path: page.built_path });
      continue;
    }
    const type = typeOf(page, current);
    if (CHECKOUT_PAGE_TYPES.has(type) || current.checkout) reasons.push({ code: "checkout_page", path: page.built_path });
    else if (!signature || !Object.hasOwn(signature.pages, page.built_path)) {
      if (signature) reasons.push({ code: "commerce_signature_unavailable", path: page.built_path });
    } else if (signature.pages[page.built_path] !== current.signature) {
      reasons.push({ code: "commerce_markup_changed", path: page.built_path });
    }
  }
  // Pages whose HTML is unchanged but whose linked stylesheet or image is:
  // their markup still matches its hash, so only a buy page needs a note.
  const markupChanged = new Set(changes.changed_pages.map((page) => page.built_path));
  const linkedOnly = new Map(linkedAssets.flatMap((asset) => asset.pages)
    .filter((page) => !markupChanged.has(page.built_path)).map((page) => [page.built_path, page]));
  const buyPages = [];
  for (const page of [...linkedOnly.values()].sort((a, b) => a.built_path.localeCompare(b.built_path))) {
    let current;
    try {
      current = factsOf(page);
    } catch {
      reasons.push({ code: "commerce_signature_unavailable", path: page.built_path });
      continue;
    }
    if (BUY_PAGE_TYPES.has(typeOf(page, current)) || current.checkout) buyPages.push({ code: "linked_asset_buy_page", path: page.built_path });
  }
  const kind = reasons.length ? "commerce_affecting" : "page_only";
  // After the commerce reasons, so the cap drops notes before causes.
  reasons.push(...buyPages, ...linkedAssets.map((asset) => ({ code: "linked_asset_changed", path: asset.path, pages: asset.pages.map((page) => page.page_id) })));
  return { kind, reasons: capped(reasons) };
}

// True when a kept rebuild was read against a build recorded before markup
// hashes existed (pre-1.62), the one kind of record `record baseline` is for.
export function rebuiltFromBuildWithoutSignature(assembly) {
  return Array.isArray(assembly?.build_changes) && assembly.build_changes.some((entry) => Array.isArray(entry?.reasons)
    && entry.reasons.some((reason) => reason?.code === "commerce_signature_unavailable" && !reason.path));
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
 * changed_pages, unmapped_files, reasons, commerce_rebuild }`; `kind` is
 * unknown when the history does not reach `anchor` or the drift cannot be read.
 * `commerce_rebuild`, when there is one, is the latest recorded rebuild since
 * `anchor` that was not page-only, with the kind of the latest change
 * (`latest_change_kind`), so a page-only edit on top of it can say why it still
 * owes the full stages.
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
  for (const segment of segments) {
    add(segment, segment.kind, segment.reasons);
    if (!["none", "page_only"].includes(segment.kind)) result.commerce_rebuild = { recorded_at: segment.recorded_at ?? null, build_fingerprint: segment.build_fingerprint, kind: segment.kind };
  }
  if (drift?.status !== "known") kind = "unknown";
  else add(drift, driftClassification?.kind || "unknown", driftClassification?.reasons);
  if (result.commerce_rebuild) {
    const driftKind = driftClassification?.kind || "unknown";
    result.commerce_rebuild.latest_change_kind = driftKind === "none" ? segments.at(-1).kind : driftKind;
  }
  return {
    ...result,
    kind,
    changed_pages: [...pages.values()].sort((a, b) => a.built_path.localeCompare(b.built_path)),
    unmapped_files: capped([...unmapped].sort()),
    // Asset notes last, so the cap drops them before a cause or a buy page.
    reasons: capped([...result.reasons.filter((reason) => reason?.code !== "linked_asset_changed"),
      ...result.reasons.filter((reason) => reason?.code === "linked_asset_changed")]),
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
