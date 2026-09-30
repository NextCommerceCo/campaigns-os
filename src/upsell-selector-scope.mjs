// Upsell selector scope (#270).
//
// A `data-next-bundle-selector` binds to ONE of two baskets. Which one is
// decided entirely by two container attributes, and getting it wrong on an
// upsell page charges the shopper for a package they never chose:
//
//   data-next-upsell-context      -> the post-purchase order. Correct after checkout.
//   data-next-selection-mode      -> "swap" (the DEFAULT) writes the selected
//                                    bundle into the LIVE CART; "select" writes
//                                    nothing anywhere.
//
// The failure this module gates is not a click-time mistake. In the SDK's
// bundle-selector enhancer, a selector without `data-next-upsell-context`
// subscribes to the cart store and runs a sync pass at init; that pass picks a
// default card (`data-next-selected="true"`, or the FIRST card when no card
// declares one) and, in swap mode, applies it to the cart. No click, no
// interaction, no visibility requirement — a `display:none` container does it
// just as well as a visible one. On a page whose funnel role is `upsell`, the
// order is already paid, so the package lands in the shopper's next cart and is
// charged at the next checkout WITHOUT appearing in that checkout's rendered
// order summary. Every layer is silent: the SDK binds it without complaint, the
// built markup looks deliberate, and QA has nothing to assert against.
//
// Hence a static blocker over built output. It needs no browser and no order.
//
// Two attributes clear the gate, and they are not interchangeable:
//
//   - `data-next-upsell-context` is the correct answer. It forces select mode,
//     disables cart writes entirely, and fetches prices with `upsell=true` so
//     the rendered price is upsell pricing.
//   - `data-next-selection-mode="select"` is *sufficient against the charge* —
//     every cart write in the enhancer is gated on `mode === "swap" && !upsell
//     context`, at init and on click alike — but it leaves the selector on
//     non-upsell pricing. It clears the blocker and raises a warning, because a
//     blocker whose message says "this sells into the cart" would be stating
//     something false about markup that provably does not.
//
// Pure: callers read the built HTML and hand it in. Nothing here touches the
// filesystem, so both the packet doctor path and the built-site-only path
// (`doctor --built`) can drive it with the same evaluator.

import { parse } from "parse5";

import { ROUTE_TOKENS } from "./built-site-scope.mjs";
import {
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  projectCheckpointWaiverAssessment,
} from "./checkpoint-waiver.mjs";

export const UPSELL_SELECTOR_SCOPE = "built_output.upsell_selector_scope";

// The funnel roles that put a page after checkout, where the cart is the wrong
// basket. `downsell` is included deliberately: it is the same post-purchase
// position with a different offer, and the SDK draws no distinction.
const POST_PURCHASE_PAGE_TYPES = new Set(["upsell", "downsell"]);

// Opening tags, with quoted attribute values consumed as units so a `>` inside
// an attribute (`data-next-show="param.qty>2"`) does not truncate the tag.
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function hasBareAttribute(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`, "i").test(attrs);
}

function attributeValue(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, "i").exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

// Bound to a real declaration rather than matched as a substring, so a custom
// property or a longer property name that merely ends in "display" cannot be
// read as one (`--card-display:none`, `my-display:none`). Only affects how a
// finding is described, never whether it blocks.
function isDisplayNone(style) {
  return /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i.test(String(style || ""));
}

/**
 * Every `data-next-bundle-selector` container in a built page, with the two
 * attributes that decide which basket it writes to.
 *
 * HTML comments are stripped first: a commented-out selector is inert, and the
 * certified upsell templates carry long explanatory comments that quote the
 * attribute names verbatim.
 *
 * Nothing else is excluded, and the two inclusions are deliberate:
 *
 *   - `display:none` containers, because the cart write happens during the
 *     enhancer's init sync and never consults visibility.
 *   - `<template>` content, which is inert in the abstract — it lives in a
 *     DocumentFragment until something clones it — but is NOT inert here. This
 *     SDK clones it: a selector declares `data-next-bundle-slot-template-id`
 *     and the enhancer renders that template's content into the live DOM, one
 *     slot per configurable unit. `apollo-mv-single-step` ships exactly that
 *     shape today. So a selector authored inside a template on a post-purchase
 *     page reaches the live DOM by the SDK's own machinery, and skipping
 *     templates would be a blind spot precisely where the mechanism is least
 *     obvious to a reader.
 *
 * That is an assumption about THIS SDK, not about HTML in general. If a family
 * ever ships a template that genuinely nothing clones, the finding is a false
 * blocker — visible, named, and waivable, which is the direction this gate errs
 * in on purpose. A false pass is a silent charge.
 */
export function collectBundleSelectors(html) {
  const source = String(html || "").replace(HTML_COMMENT, "");
  const selectors = [];
  let occurrence = 0;
  for (const match of source.matchAll(OPEN_TAG)) {
    const attrs = match[2] || "";
    if (!hasBareAttribute(attrs, "data-next-bundle-selector")) continue;
    const selectionMode = (attributeValue(attrs, "data-next-selection-mode") || "").trim().toLowerCase();
    const upsellScoped = hasBareAttribute(attrs, "data-next-upsell-context");
    selectors.push({
      occurrence: occurrence++,
      selector_id: attributeValue(attrs, "data-next-selector-id"),
      upsell_scoped: upsellScoped,
      // Absent selection-mode means "swap" — the SDK's default, and the reason
      // this defect is so easy to introduce by omission.
      selection_mode: selectionMode || "swap",
      // The single property that decides whether loading the page moves money.
      writes_to_cart: !upsellScoped && selectionMode !== "select",
      hidden: isDisplayNone(attributeValue(attrs, "style"))
        || hasBareAttribute(attrs, "hidden"),
    });
  }
  return selectors;
}

export function isPostPurchasePageType(value) {
  return POST_PURCHASE_PAGE_TYPES.has(String(value || "").toLowerCase().trim());
}

const PAGE_TYPE_META = "next-page-type";
// A `<meta>` tag anywhere in the source text, live or not, and its attributes.
const META_TAG = /<meta\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const TAG_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// The looser pattern this reader replaced. Kept so `mentioned` is a superset
// of what it read: its `\bname=` / `\bcontent=` also match `data-name=` /
// `data-content=`, and it takes mismatched quotes.
const LEGACY_PAGE_TYPE_META = /<meta\b(?=[^>]*\bname=["']next-page-type["'])[^>]*\bcontent=["']([^"']*)["'][^>]*>/gi;

function liveMetaElements(node, found = []) {
  // childNodes only: a <template>'s children live in `content`, a fragment
  // outside the document, so they are skipped here as the browser skips them.
  for (const child of node.childNodes || []) {
    if (child.tagName === "meta") found.push(child);
    liveMetaElements(child, found);
  }
  return found;
}

/**
 * Every `next-page-type` value a built page carries, read two ways. This is
 * the one reader both page-role decisions below share (#529).
 *
 *   live       the metas the browser puts in the document, in document order,
 *              matched as `meta[name="next-page-type"]` matches (the name
 *              exactly; attribute names in any case, attributes in any order,
 *              any quoting). Parsed with parse5, so a meta in a comment, in
 *              <template> content, or in the raw text of <script>, <noscript>
 *              (scripting on, which the SDK needs), <style>, <textarea> or
 *              <title> is not one. Values trimmed; "" when content is absent.
 *   mentioned  every `<meta>`-shaped tag in the source text whose name is
 *              next-page-type in any case or spacing, live or not, plus every
 *              match of the looser pattern this replaced. Values trimmed and
 *              deduplicated, first occurrence first. Wider than that pattern,
 *              never narrower.
 */
export function readBuiltPageTypeMetas(content) {
  const source = String(content || "");
  const live = liveMetaElements(parse(source))
    .map((element) => new Map(element.attrs.map((attr) => [attr.name, attr.value])))
    .filter((attrs) => attrs.get("name") === PAGE_TYPE_META)
    .map((attrs) => (attrs.get("content") ?? "").trim());
  const mentioned = [];
  for (const tag of source.matchAll(META_TAG)) {
    const attrs = new Map();
    for (const attr of tag[1].matchAll(TAG_ATTRIBUTE)) {
      const name = attr[1].toLowerCase();
      if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    if ((attrs.get("name") || "").trim().toLowerCase() === PAGE_TYPE_META) {
      mentioned.push((attrs.get("content") ?? "").trim());
    }
  }
  for (const tag of source.matchAll(LEGACY_PAGE_TYPE_META)) mentioned.push(tag[1].trim());
  return { live, mentioned: [...new Set(mentioned)] };
}

// The role the page declares for itself, or null when it declares none or
// declares it ambiguously. Only live metas count: markup the browser does not
// put in the document is not a declaration. The first live meta is the one a
// `querySelector` reads, so a blank first meta declares nothing; and every
// live meta must agree (case aside), because a page carrying both `checkout`
// and `receipt` has not said which it is.
export function builtPageTypeMeta(content) {
  const [first = "", ...rest] = readBuiltPageTypeMetas(content).live;
  if (!first) return null;
  return rest.every((value) => value.toLowerCase() === first.toLowerCase()) ? first : null;
}

// Whether the route guess is too weak to stand against the page's own meta:
// an upsell read from "oto" / "one-time-offer" alone, with no "upsell" word.
// An explicit "upsell" or "downsell" word is never ambiguous, whatever else
// the route says: the charge comes from the page's place in the funnel, not
// its meta. A route that reads only as checkout needs no relief, since its
// guess is not post-purchase to begin with.
function routeGuessIsAmbiguous(route) {
  if (route === null || route === undefined) return false;
  const value = String(route).toLowerCase().trim();
  if (ROUTE_TOKENS.upsell.test(value) || ROUTE_TOKENS.downsell.test(value)) return false;
  return ROUTE_TOKENS.one_time_offer.test(value);
}

// The type to hand in as `page_type` when the only other source is a guess
// from the built route (resolveBuiltSiteScope's inferPageType). "/checkout-oto/"
// infers as an upsell, but a checkout page with an embedded one-time offer
// declares `checkout` in its meta (#529). So a declared `checkout` (any case)
// replaces the guess, and only when the guess is ambiguous (above). Any other
// declared role leaves the upsell guess, so a meta copied from the product or
// thank-you page cannot lift an oto page out of the gate, and an explicit
// upsell or downsell route keeps its type whatever it declares. The guess also
// stands for a page that declares nothing, or declares it only in inert or
// conflicting markup, and when no route is given. A type declared by a spec
// is not a guess and is passed through as before. Either way the type
// comes back trimmed and lower-cased (" Checkout " is "checkout"), or null.
export function builtPageTypeOverRouteGuess({ route = null, route_type = null, content = "" } = {}) {
  const declared = routeGuessIsAmbiguous(route) ? builtPageTypeMeta(content) : null;
  const type = normalizedPageType(declared) === "checkout" ? declared : route_type;
  return normalizedPageType(type);
}

function normalizedPageType(type) {
  return type == null ? null : String(type).trim().toLowerCase();
}

// A built page's funnel role, from either signal that carries it. The declared
// spec/scope type and the page's own `next-page-type` meta are both consulted
// and either one is enough: the meta is what the SDK actually reads, the
// declared type is what survives when a page ships without the meta, and
// disagreement between them is a reason to check MORE carefully, not less.
// Any next-page-type the page carries counts here, live or mentioned: saying
// "post-purchase" can only add a check, so inert markup that says it errs
// toward a visible, waivable blocker rather than a silent charge.
export function builtPageIsPostPurchase({ page_type = null, content = "" } = {}) {
  if (isPostPurchasePageType(page_type)) return true;
  const { live, mentioned } = readBuiltPageTypeMetas(content);
  return [...live, ...mentioned].some(isPostPurchasePageType);
}

function describeSelector(finding) {
  return finding.selector_id ? `"${finding.selector_id}"` : "(no data-next-selector-id)";
}

function emptyWaiverAssessment() {
  return { active: null, inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 } };
}

/**
 * Evaluate the upsell-selector-scope checkpoint over built pages.
 *
 * @param {{
 *   subject: object,
 *   pages: Array<{ page_id: string, page_type?: string|null, file?: string|null, content: string }>,
 *   waivers?: unknown,
 *   now?: string,
 * }} input
 */
export function evaluateUpsellSelectorScope({ subject, pages = [], waivers = null, now = new Date().toISOString() } = {}) {
  const resolvedSubject = subject && typeof subject === "object" ? subject : {};
  const postPurchasePages = (Array.isArray(pages) ? pages : []).filter((page) => builtPageIsPostPurchase(page));

  if (postPurchasePages.length === 0) {
    return {
      id: UPSELL_SELECTOR_SCOPE,
      scope: UPSELL_SELECTOR_SCOPE,
      status: "not_applicable",
      code: "built_output.upsell_selector_scope.not_applicable",
      reason: "No built upsell or downsell page was available to scan; selector scope becomes mandatory once one is built.",
      waivable: false,
      subject: resolvedSubject,
      state: { findings: [], warned: [] },
      state_fingerprint: null,
      findings: [],
      warned: [],
      pages_scanned: 0,
      selectors_scanned: 0,
      waiver: null,
      waiver_assessment: emptyWaiverAssessment(),
      required_actions: [],
    };
  }

  const findings = [];
  const warned = [];
  let selectorsScanned = 0;
  for (const page of postPurchasePages) {
    for (const selector of collectBundleSelectors(page.content)) {
      selectorsScanned += 1;
      if (selector.upsell_scoped) continue;
      const record = {
        page_id: page.page_id,
        file: page.file || null,
        selector_id: selector.selector_id,
        occurrence: selector.occurrence,
        selection_mode: selector.selection_mode,
        hidden: selector.hidden,
      };
      if (selector.writes_to_cart) findings.push(record);
      else warned.push(record);
    }
  }

  // State is the blocking set only. A warned selector must not shift the
  // fingerprint, or correcting an unrelated pricing note would silently
  // invalidate a waiver recorded against a blocker that has not changed.
  const state = {
    findings: findings
      .map(({ page_id, selector_id, occurrence }) => ({ page_id, selector_id, occurrence }))
      .sort((a, b) => a.page_id.localeCompare(b.page_id)
        || String(a.selector_id).localeCompare(String(b.selector_id))
        || a.occurrence - b.occurrence),
  };

  const warningNote = warned.length
    ? ` ${warned.length} further selector(s) are cart-scoped but carry data-next-selection-mode="select", so they do not write to the cart; they still price without upsell pricing.`
    : "";

  if (findings.length === 0) {
    return {
      id: UPSELL_SELECTOR_SCOPE,
      scope: UPSELL_SELECTOR_SCOPE,
      status: "pass",
      code: warned.length ? "built_output.upsell_selector_scope.cart_scoped_select_mode" : "built_output.upsell_selector_scope.pass",
      reason: `Every bundle selector on ${postPurchasePages.length} built post-purchase page(s) is scoped away from the live cart.${warningNote}`,
      waivable: false,
      subject: resolvedSubject,
      state,
      state_fingerprint: null,
      findings: [],
      warned,
      pages_scanned: postPurchasePages.length,
      selectors_scanned: selectorsScanned,
      waiver: null,
      waiver_assessment: emptyWaiverAssessment(),
      required_actions: [],
    };
  }

  const state_fingerprint = checkpointStateFingerprint({
    scope: UPSELL_SELECTOR_SCOPE,
    subject: resolvedSubject,
    state,
  });
  const checkpoint = { scope: UPSELL_SELECTOR_SCOPE, subject: resolvedSubject, state_fingerprint };
  const waiver_assessment = projectCheckpointWaiverAssessment(
    assessCheckpointWaivers(waivers, checkpoint, { now }),
    checkpoint,
  );
  const waiver = waiver_assessment.active;

  // The message has to carry the whole finding, because the defect's defining
  // property is that nothing else shows it: the selector id (there are usually
  // two selectors on the page and only one is wrong), the page, and what the
  // selector will actually do to a shopper.
  const detail = findings
    .map((finding) => `${describeSelector(finding)} on page "${finding.page_id}"${finding.hidden ? " (hidden)" : ""}`)
    .join("; ");
  const symptom = "Loading the page adds that selector's package to the shopper's LIVE CART with no click, and it is charged at the next checkout without appearing in that checkout's rendered order summary.";
  const remedy = 'Add data-next-upsell-context to each selector listed (the post-purchase basket, and upsell pricing), or delete the selector if it exists only to display a price.';

  return {
    id: UPSELL_SELECTOR_SCOPE,
    scope: UPSELL_SELECTOR_SCOPE,
    status: waiver ? "waived" : "blocked",
    code: waiver ? "built_output.upsell_selector_scope.waived" : UPSELL_SELECTOR_SCOPE,
    reason: waiver
      ? `${findings.length} cart-writing bundle selector(s) on built post-purchase page(s) are accepted under an exact named-human decision: ${detail}.`
      : `${findings.length} bundle selector(s) on built post-purchase page(s) sell into the live cart: ${detail}. Each lacks data-next-upsell-context and is in the default "swap" selection mode. ${symptom} ${remedy}${warningNote}`,
    waivable: true,
    subject: resolvedSubject,
    state,
    state_fingerprint,
    findings,
    warned,
    pages_scanned: postPurchasePages.length,
    selectors_scanned: selectorsScanned,
    waiver,
    waiver_assessment,
    required_actions: waiver ? [] : [
      {
        id: "repair_selectors",
        kind: "edit",
        command: null,
        description: `Add data-next-upsell-context to ${detail}, or remove the selector, then rebuild and re-run doctor.`,
      },
      {
        id: "waive_checkpoint",
        kind: "command",
        command: `campaigns-os checkpoint waive --packet <packet> --gate ${UPSELL_SELECTOR_SCOPE} --reason "<reason>" --waived-by "<named human>" --review-condition "<re-evaluation trigger>"`,
        description: "Record a bounded named-human decision that these exact cart-scoped selectors are intended on a post-purchase page.",
      },
    ],
  };
}
