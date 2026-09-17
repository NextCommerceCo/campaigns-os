// Cross-page campaign identity (#301).
//
// Every page of a built campaign tells the Campaign Cart SDK which campaign it
// belongs to through three signals, and the SDK reads each of them per page
// with no cross-page reconciliation:
//
//   API key      <meta name="next-api-key"> beats window.nextConfig.apiKey
//                (inline, or in the config.js the page loads). Selects the
//                campaign whose packages, prices and orders the page acts on.
//   next-funnel  <meta name="next-funnel">. Attributed onto the order.
//   setAttribution({ funnel })  A script call that overrides the funnel tag.
//
// The failure this module gates is a page borrowed from another funnel: a
// copied upsell or receipt page that still carries the other campaign's API
// key, funnel tag, or setAttribution call. Nothing else notices. The SDK binds
// each page happily, the build succeeds, the page renders, and the order is
// created against (or attributed to) the wrong campaign. It has shipped twice
// and been written up as advice both times; advice is not a gate.
//
// Hence a static blocker over built output that asserts CONSISTENCY only:
//
//   - every API key observed anywhere in the campaign is the same key;
//   - every next-funnel meta is the same value, and once any page carries one,
//     every page that declares a next-page-type (so the SDK is bootstrapped on
//     it) carries one too;
//   - every setAttribution({ funnel }) agrees with the next-funnel of the page
//     that calls it.
//
// Presence is deliberately NOT asserted. Whether a checkout page must call
// setAttribution is a separate question (the SDK reads ?funnel=, then the
// remembered funnel, then the tag, and the platform fills the campaign name
// when the tag is absent), and a campaign whose pages carry no key at all is a
// different defect with its own check.
//
// Not waivable. The two values in a finding cannot both be right, so there is
// no bounded human decision to record — the fix is a one-line edit, and the
// message names the two files and the two values so it is exactly that.
//
// Pure: callers read the built HTML and the local scripts each page loads and
// hand them in. Nothing here touches the filesystem, so the packet doctor path
// and the built-site-only path (`doctor --built`) drive the same evaluator.

export const CAMPAIGN_IDENTITY = "built_output.campaign_identity";

// Finding kinds, each with its own issue code under the gate id.
export const CAMPAIGN_IDENTITY_KINDS = Object.freeze({
  api_key_drift: `${CAMPAIGN_IDENTITY}.api_key_drift`,
  funnel_drift: `${CAMPAIGN_IDENTITY}.funnel_drift`,
  funnel_missing: `${CAMPAIGN_IDENTITY}.funnel_missing`,
  attribution_drift: `${CAMPAIGN_IDENTITY}.attribution_drift`,
});

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SET_ATTRIBUTION_FUNNEL = /setAttribution\s*\(\s*\{[^}]*?\bfunnel\s*:\s*(["'`])([^"'`]*)\1/g;

// A page that is a parked copy rather than a served page: `checkout-backup-2`,
// `upsell-old`, `old-receipt`. The issue names `*-backup-*` and `*-old-*`; the
// segment-anchored form also catches the marker at either end of a segment so
// `upsell-old/` and `old-upsell/` are both skipped, while `bold-claims/` and
// `holdout/` are not. Skipped pages are reported, never silently dropped.
const PARKED_SEGMENT = /(^|-)(backup|old)(-|$)/i;

export function isParkedPage(routeOrFile) {
  const value = String(routeOrFile || "").replace(/\\/g, "/").replace(/\/index\.html?$/i, "").replace(/\.html?$/i, "");
  return value.split("/").some((segment) => PARKED_SEGMENT.test(segment));
}

function metaContent(html, name) {
  const tag = new RegExp(`<meta\\b(?=[^>]*\\bname=["']${name}["'])([^>]*)>`, "i").exec(html);
  if (!tag) return null;
  const content = /\bcontent=["']([^"']*)["']/i.exec(tag[1]);
  return content ? content[1].trim() : "";
}

function hasSrcAttribute(attrs) {
  return /(?:^|\s)src\s*=/i.test(attrs || "");
}

/**
 * Inline `<script>` bodies of a page, in document order. External scripts are
 * the caller's to resolve (they need the filesystem); they arrive as
 * `page.scripts[]`.
 */
export function inlineScriptBodies(html) {
  const source = String(html || "").replace(HTML_COMMENT, "");
  const bodies = [];
  for (const match of source.matchAll(INLINE_SCRIPT)) {
    if (hasSrcAttribute(match[1])) continue;
    if (match[2].trim()) bodies.push(match[2]);
  }
  return bodies;
}

// Walk a JS object literal from its opening brace and return the string value
// of a given key at depth 1, skipping strings, template literals and comments
// so a commented-out `apiKey: "your-api-key"` or a nested
// `googleMaps: { apiKey: "" }` (both present in the starter config.js) cannot
// be read as the campaign key. Returns null when the key is absent or its
// value is not a plain string literal (a computed value is not something a
// static check can compare).
function depthOneStringValue(js, openIndex, key) {
  let depth = 0;
  let i = openIndex;
  const n = js.length;
  const keyPattern = new RegExp(`^(?:${key}|["']${key}["'])\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
  while (i < n) {
    const ch = js[i];
    const next = js[i + 1];
    if (ch === "/" && next === "/") {
      const end = js.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = js.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // At depth 1 a string may be the quoted key itself; test before skipping.
      if (depth === 1) {
        const hit = keyPattern.exec(js.slice(i));
        if (hit) return hit[2];
      }
      i += 1;
      while (i < n && js[i] !== ch) {
        if (js[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth <= 0) return null;
      i += 1;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$.]/.test(js[i - 1]))) {
      const hit = keyPattern.exec(js.slice(i));
      if (hit) return hit[2];
    }
    i += 1;
  }
  return null;
}

/**
 * Every campaign API key a script text declares, with the spelling it used.
 *
 *   window.nextConfig = { apiKey: "…" }      -> "nextConfig.apiKey"
 *   window.nextConfig.apiKey = "…"           -> "nextConfig.apiKey"
 *   nextCampaign.config({ apiKey: "…" })     -> "nextCampaign.config apiKey" (legacy)
 */
export function collectScriptApiKeys(js) {
  const source = String(js || "");
  const keys = [];
  for (const match of source.matchAll(/\bnextConfig\s*=\s*\{/g)) {
    const value = depthOneStringValue(source, match.index + match[0].length - 1, "apiKey");
    if (value != null) keys.push({ source: "nextConfig.apiKey", value: value.trim() });
  }
  for (const match of source.matchAll(/\bnextConfig\s*\.\s*apiKey\s*=\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    keys.push({ source: "nextConfig.apiKey", value: match[2].trim() });
  }
  for (const match of source.matchAll(/\bnextCampaign\s*\.\s*config\s*\(\s*\{/g)) {
    const value = depthOneStringValue(source, match.index + match[0].length - 1, "apiKey");
    if (value != null) keys.push({ source: "nextCampaign.config apiKey", value: value.trim() });
  }
  return keys;
}

export function collectSetAttributionFunnels(js) {
  return [...String(js || "").matchAll(SET_ATTRIBUTION_FUNNEL)].map((match) => match[2].trim());
}

/**
 * The identity signals one built page carries.
 *
 * @param {{ page_id: string, file?: string|null, content: string,
 *   scripts?: Array<{ src: string, file?: string|null, content: string }> }} page
 */
export function collectPageIdentity(page) {
  const html = String(page?.content || "");
  const stripped = html.replace(HTML_COMMENT, "");
  const apiKeyMeta = metaContent(stripped, "next-api-key");
  const apiKeys = [];
  if (apiKeyMeta) apiKeys.push({ source: 'meta name="next-api-key"', where: page.file || page.page_id, value: apiKeyMeta });
  const attributions = [];

  for (const body of inlineScriptBodies(html)) {
    for (const key of collectScriptApiKeys(body)) apiKeys.push({ ...key, source: `inline ${key.source}`, where: page.file || page.page_id });
    for (const funnel of collectSetAttributionFunnels(body)) attributions.push({ where: page.file || page.page_id, value: funnel });
  }
  for (const script of Array.isArray(page?.scripts) ? page.scripts : []) {
    const where = script.file || script.src;
    for (const key of collectScriptApiKeys(script.content)) apiKeys.push({ ...key, source: `${script.src} ${key.source}`, where });
    for (const funnel of collectSetAttributionFunnels(script.content)) attributions.push({ where, value: funnel });
  }

  return {
    page_id: page.page_id,
    file: page.file || null,
    api_key_meta: apiKeyMeta || null,
    api_keys: apiKeys,
    funnel: metaContent(stripped, "next-funnel"),
    page_type: metaContent(stripped, "next-page-type"),
    attributions,
  };
}

function quote(value) {
  return value == null ? "(none)" : `"${value}"`;
}

function gateBase(subject) {
  return {
    id: CAMPAIGN_IDENTITY,
    scope: CAMPAIGN_IDENTITY,
    waivable: false,
    subject: subject && typeof subject === "object" ? subject : {},
    waiver: null,
  };
}

/**
 * Evaluate cross-page campaign identity over built pages.
 *
 * @param {{ subject: object, pages: Array<{ page_id: string, route?: string|null,
 *   file?: string|null, content: string,
 *   scripts?: Array<{ src: string, file?: string|null, content: string }> }> }} input
 */
export function evaluateCampaignIdentity({ subject, pages = [] } = {}) {
  const all = Array.isArray(pages) ? pages : [];
  const skipped = all
    .filter((page) => isParkedPage(page.route ?? page.file ?? page.page_id))
    .map((page) => page.file || page.page_id);
  const scanned = all.filter((page) => !isParkedPage(page.route ?? page.file ?? page.page_id));

  if (scanned.length === 0) {
    return {
      ...gateBase(subject),
      status: "not_applicable",
      code: `${CAMPAIGN_IDENTITY}.not_applicable`,
      reason: "No built page was available to scan; campaign identity becomes mandatory once pages are built.",
      findings: [],
      pages_scanned: 0,
      pages_skipped: skipped,
      identity: null,
      required_actions: [],
    };
  }

  const identities = scanned.map(collectPageIdentity);
  const findings = [];

  // 1. API key: every observed key, from every source on every page, is one
  //    value. Meta and config are compared together on purpose: a page whose
  //    meta names one campaign while its config.js names another is drift
  //    inside a single page, and the SDK's precedence rule only hides it.
  const keyObservations = identities.flatMap((identity) => identity.api_keys.map((key) => ({ page_id: identity.page_id, ...key })));
  const firstKey = keyObservations[0] || null;
  for (const observation of keyObservations.slice(1)) {
    if (observation.value === firstKey.value) continue;
    findings.push({
      kind: "api_key_drift",
      code: CAMPAIGN_IDENTITY_KINDS.api_key_drift,
      a: { page_id: firstKey.page_id, file: firstKey.where, source: firstKey.source, value: firstKey.value },
      b: { page_id: observation.page_id, file: observation.where, source: observation.source, value: observation.value },
      message: `API key differs across pages: ${firstKey.where} has ${quote(firstKey.value)} (${firstKey.source}) but ${observation.where} has ${quote(observation.value)} (${observation.source}). One of these pages was borrowed from another campaign; make both name the same key.`,
    });
    break; // one finding per kind names the first pair; the rest follow from the same edit
  }

  // 2. next-funnel: one value across pages, and present wherever the SDK is
  //    bootstrapped (a page that declares next-page-type is SDK-bound).
  const funnelPages = identities.filter((identity) => identity.funnel);
  const firstFunnel = funnelPages[0] || null;
  for (const identity of funnelPages.slice(1)) {
    if (identity.funnel === firstFunnel.funnel) continue;
    findings.push({
      kind: "funnel_drift",
      code: CAMPAIGN_IDENTITY_KINDS.funnel_drift,
      a: { page_id: firstFunnel.page_id, file: firstFunnel.file || firstFunnel.page_id, value: firstFunnel.funnel },
      b: { page_id: identity.page_id, file: identity.file || identity.page_id, value: identity.funnel },
      message: `next-funnel differs across pages: ${firstFunnel.file || firstFunnel.page_id} has ${quote(firstFunnel.funnel)} but ${identity.file || identity.page_id} has ${quote(identity.funnel)}. Orders from the second page attribute to the other funnel; set the same <meta name="next-funnel"> on both.`,
    });
    break;
  }
  //    "Missing" is judged against the campaign, not in the abstract: a
  //    campaign that tags no page at all is consistent (the platform fills the
  //    campaign name when the tag is absent), and blocking it would be the
  //    presence assertion this check deliberately does not make. Once ANY
  //    page carries the tag, an SDK-bound page without it attributes its
  //    orders differently from the rest, which is drift.
  if (firstFunnel) {
    for (const identity of identities) {
      if (identity.funnel || !identity.page_type) continue;
      findings.push({
        kind: "funnel_missing",
        code: CAMPAIGN_IDENTITY_KINDS.funnel_missing,
        a: { page_id: identity.page_id, file: identity.file || identity.page_id, value: null },
        b: { page_id: firstFunnel.page_id, file: firstFunnel.file || firstFunnel.page_id, value: firstFunnel.funnel },
        message: `${identity.file || identity.page_id} declares next-page-type=${quote(identity.page_type)} but no <meta name="next-funnel">, while ${firstFunnel.file || firstFunnel.page_id} carries ${quote(firstFunnel.funnel)}. Orders from the untagged page attribute differently from the rest; add the same next-funnel meta.`,
      });
    }
  }

  // 3. setAttribution({ funnel }) agrees with the page's own tag. A page with
  //    no tag of its own is held to the campaign's tag (the one every other
  //    page agrees on) so a borrowed script on an untagged page still fails.
  for (const identity of identities) {
    const expected = identity.funnel || (firstFunnel ? firstFunnel.funnel : null);
    if (!expected) continue;
    const expectedWhere = identity.funnel ? identity.file || identity.page_id : firstFunnel.file || firstFunnel.page_id;
    for (const attribution of identity.attributions) {
      if (attribution.value === expected) continue;
      findings.push({
        kind: "attribution_drift",
        code: CAMPAIGN_IDENTITY_KINDS.attribution_drift,
        a: { page_id: identity.page_id, file: expectedWhere, value: expected },
        b: { page_id: identity.page_id, file: attribution.where, value: attribution.value },
        message: `setAttribution({ funnel: ${quote(attribution.value)} }) in ${attribution.where} disagrees with next-funnel ${quote(expected)} in ${expectedWhere}. The call overrides the tag, so orders attribute to ${quote(attribution.value)}; change the call to ${quote(expected)} or remove it.`,
      });
    }
  }

  const identity = {
    api_key: firstKey ? firstKey.value : null,
    api_key_source: firstKey ? firstKey.source : null,
    funnel: firstFunnel ? firstFunnel.funnel : null,
  };

  if (findings.length === 0) {
    return {
      ...gateBase(subject),
      status: "pass",
      code: `${CAMPAIGN_IDENTITY}.pass`,
      reason: `All ${scanned.length} built page(s) agree on campaign identity (API key ${identity.api_key ? "present" : "not declared"}, next-funnel ${quote(identity.funnel)}).`,
      findings: [],
      pages_scanned: scanned.length,
      pages_skipped: skipped,
      identity,
      required_actions: [],
    };
  }

  return {
    ...gateBase(subject),
    status: "blocked",
    code: CAMPAIGN_IDENTITY,
    reason: `${findings.length} campaign identity drift finding(s) across ${scanned.length} built page(s): ${findings.map((finding) => finding.message).join(" ")}`,
    findings,
    pages_scanned: scanned.length,
    pages_skipped: skipped,
    identity,
    required_actions: [
      {
        id: "repair_identity",
        kind: "edit",
        command: null,
        description: `Make every page name the same campaign: ${findings.map((finding) => `${finding.b?.file || finding.a.file} (${finding.kind.replace(/_/g, " ")})`).join("; ")}. Not waivable: two campaign identities on one funnel cannot both be intended.`,
      },
    ],
  };
}
