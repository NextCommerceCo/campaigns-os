// Rendered-output content-residue scan + proof-attestation gate.
//
// Scans BUILT campaign output (_site HTML), not frontmatter: layout- or
// script-rendered chrome only exists after the build, which is why
// frontmatter-level checks missed the hardcoded starter countdown chrome.
//
// What it looks for is template residue, never the merchant's own copy: the
// public starter-template demo strings, bracket-style demo stubs, and the
// literal needs-merchant-input marker. Proof and urgency content the merchant
// supplies (reviews, ratings, "Verified Purchase" labels, stock counters,
// countdowns) is the merchant's responsibility and is not scanned. No
// merchant-specific fingerprints are carried in this public package.
//
// Posture (two tiers):
// - hard: the literal needs-merchant-input marker, and starter countdown
//   chrome on a brief-backed build whose brief does not verify the offer
//   urgency — blockers (collect-inputs).
// - review: demo/placeholder residue — warnings; a hit means an unreplaced
//   demo slot or a stale template.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const NEEDS_INPUT_MARKER = /NEEDS[ -]MERCHANT[ -]INPUT/i;

// Countdown chrome as rendered by the starter presell templates.
export const COUNTDOWN_CHROME = /data-countdown-(?:hrs|min|sec)/;

// Bracket-style demo stubs ("[Product]", "[Author Name]", "[Real Review
// Proof Goes Here]"). Requires a capitalized first word so CSS/JS attribute
// selectors ([data-x], [href]) never match.
export const BRACKET_STUB = /\[(?:[A-Z][A-Za-z0-9/&().,'’-]*)(?:\s+[A-Za-z0-9/&().,'’-]+)*\]/;

// Public starter-template demo values that must never survive into a built
// campaign. The templates deliberately keep realistic, proof-shaped demo
// content (demo teaches the SHAPE of typical content); this exact-string list
// is what keeps that demo content from silently shipping — a hit means an
// unreplaced demo slot or a stale template.
export const DEMO_RESIDUE_TERMS = Object.freeze([
  "Sarah Mitchell",
  "Wellness Insider",
  "10 Reasons Why You Need This",
  "10 Reasons Why Thousands Are Switching",
  "Backed by Over 1,200 Five-Star Reviews",
  "Trusted by 50,000+ Happy Customers",
  "Doctor-Formulated for Real Results",
  "Made in an FDA-Registered Facility",
  "Lowest Price of the Year",
  "DEAL ENDING IN:",
  "1,247 reviews",
  "48,312",
  "48,000+",
  "Sandra M.",
  "Derek H.",
  "Sell-Out Risk: High",
]);

const ENTITIES = new Map([
  ["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'],
  ["&#39;", "'"], ["&apos;", "'"], ["&nbsp;", " "], ["&#8217;", "’"], ["&#8212;", "—"],
]);

function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES.get(m.toLowerCase()) ?? m);
}

// Markup view: comments and script/style BODIES removed, tags and attributes
// kept. The scan surface for hard checks — a `<!-- NEEDS MERCHANT INPUT -->`
// note or a `querySelector('[data-countdown-hrs]')` reference must not block,
// but a marker in an alt attribute is shipped content and must.
//
// `keepLines`: every removed span leaves its newlines behind, so a match index
// in the view still maps to the source line number (the doctor reports
// file:line). The default view collapses whitespace and is index-free.
export function markupView(html, { keepLines = false } = {}) {
  const newlines = (span) => span.replace(/[^\n]/g, "");
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, keepLines ? (m) => ` ${newlines(m)} ` : " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, keepLines ? (m) => `<script>${newlines(m)}</script>` : "<script></script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, keepLines ? (m) => `<style>${newlines(m)}</style>` : "<style></style>");
}

// Visible-text view: markup view with tags stripped and entities decoded —
// what a shopper (or screen reader, via appended alt text) actually reads.
// Attribute values (a `placeholder="…"` input hint, a data-* hook) are not
// visible text and never reach this view, which is what lets a static scan
// agree with a browser's body.innerText.
//
// `keepLines` keeps source newlines (see markupView) and inlines each alt text
// where its tag stood instead of appending it, so every index maps to a line.
export function visibleText(html, { keepLines = false } = {}) {
  if (keepLines) {
    const text = markupView(html, { keepLines: true }).replace(/<[^>]*>/g, (tag) => {
      const alt = /\balt="([^"]*)"/i.exec(tag);
      const newlines = tag.replace(/[^\n]/g, "");
      return alt ? ` ${alt[1].replace(/\n/g, " ")} ${newlines}` : ` ${newlines}`;
    });
    return decodeEntities(text).replace(/[^\S\n]+/g, " ");
  }
  const markup = markupView(html);
  const altText = [...markup.matchAll(/\balt="([^"]*)"/gi)].map((m) => m[1]).join(" ");
  return decodeEntities(`${markup.replace(/<[^>]*>/g, " ")} ${altText}`).replace(/\s+/g, " ");
}

function excerptAt(html, index, span = 80) {
  const start = Math.max(0, index - 20);
  return html.slice(start, start + span).replace(/\s+/g, " ").trim();
}

// Pure scan of one rendered HTML document. Returns { hard: [], review: [] };
// each finding: { id, tier, rule?, excerpt }. Every check runs on the markup
// view: attributes count, comments and script/style bodies do not, so
// attribute residue is still caught.
export function scanRenderedHtml(html, { urgencyVerified = false } = {}) {
  const markup = markupView(typeof html === "string" ? html : "");
  const hard = [];
  const review = [];

  const marker = NEEDS_INPUT_MARKER.exec(markup);
  if (marker) {
    hard.push({ id: "needs_merchant_input_marker", tier: "hard", excerpt: excerptAt(markup, marker.index) });
  }

  const countdown = COUNTDOWN_CHROME.exec(markup);
  if (countdown && !urgencyVerified) {
    hard.push({
      id: "unverified_urgency_countdown",
      tier: "hard",
      rule: "Countdown chrome rendered without verified offer urgency (offer.urgency.verified).",
      excerpt: excerptAt(markup, countdown.index),
    });
  }

  const bracket = BRACKET_STUB.exec(markup.replace(/<[^>]*>/g, " "));
  if (bracket) {
    review.push({ id: "bracket_placeholder_stub", tier: "review", excerpt: bracket[0] });
  }

  for (const term of DEMO_RESIDUE_TERMS) {
    const index = markup.indexOf(term);
    if (index !== -1) {
      review.push({ id: "demo_residue_term", tier: "review", term, excerpt: excerptAt(markup, index) });
    }
  }

  return { hard, review };
}

// Walk a built output dir for rendered pages (same skip rules as the
// placeholder-residue walker: page HTML only, never _includes/_layouts).
export function collectRenderedHtmlFiles(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_includes" || entry === "_layouts" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".html")) files.push(full);
    }
  };
  if (existsSync(rootDir) && statSync(rootDir).isDirectory()) walk(rootDir);
  return files;
}

export function scanBuiltOutputContentResidue(outputDir, { urgencyVerified = false } = {}) {
  const findings = [];
  for (const file of collectRenderedHtmlFiles(outputDir)) {
    const { hard, review } = scanRenderedHtml(readFileSync(file, "utf8"), { urgencyVerified });
    for (const finding of [...hard, ...review]) {
      findings.push({ ...finding, file: relative(outputDir, file) });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Proof-attestation gate over the copy-gen brief payload's proof_assets.
//
// The brief payload (layer-2 intake contract) is written by the assembly
// write path at .campaign-runtime/input/brief-payload.json. Each proof asset:
// { id, modality, content, source, verified, attestable, attestation_status }.
// Usable = verified:true OR attestation_status:"accepted". A non-usable asset
// only blocks when its content actually appears in the built output —
// producers are expected to exclude it, and the corpus brief deliberately
// seeds non-usable candidates to test exactly that.
export const BRIEF_PAYLOAD_REL_PATH = ".campaign-runtime/input/brief-payload.json";

export function loadBriefPayload(targetRepo) {
  if (!targetRepo) return null;
  const path = join(targetRepo, BRIEF_PAYLOAD_REL_PATH);
  if (!existsSync(path)) return null;
  try {
    return { path, payload: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

export function briefUrgencyVerified(payload) {
  return payload?.offer?.urgency?.verified === true;
}

function normalizeForMatch(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Pure: attestation findings for one set of proof assets against the
// rendered output. Pass the RAW built HTML (or a concatenation of pages);
// matching happens against the decoded visible-text view so entity encoding
// (`&amp;`) and inline tags (`<strong>` inside a claim) cannot hide shipped
// proof. Returns findings: { id, assetId, modality, state, shipped } where
// state is "verified" | "accepted" | "pending" | "non_attestable".
export function evaluateProofAssets(proofAssets, renderedHtml) {
  const findings = [];
  const haystack = normalizeForMatch(visibleText(renderedHtml || ""));
  for (const asset of Array.isArray(proofAssets) ? proofAssets : []) {
    const verified = asset?.verified === true;
    const accepted = asset?.attestation_status === "accepted";
    const attestable = asset?.attestable === true;
    const state = verified ? "verified" : accepted ? "accepted" : attestable ? "pending" : "non_attestable";
    // Match on the whole normalized content, falling back to a distinctive
    // 60-char prefix for long assets. Fail-closed direction: a false
    // "shipped" costs a review, a false "absent" ships unapproved proof.
    // Short claims ("4.9/5", "89%") still count, but match on token
    // boundaries so "4.9" cannot fire inside "$14.99" — a bare substring
    // scan over the whole visible-text haystack would flag noise.
    const normalized = normalizeForMatch(asset?.content);
    const needle = normalized.slice(0, 60);
    let shipped = false;
    if (needle.length >= 8) {
      shipped = haystack.includes(needle);
    } else if (needle.length >= 3) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      shipped = new RegExp(`(?<![\\w.$])${escaped}(?![\\w.%])`).test(haystack);
    }
    findings.push({ assetId: asset?.id ?? null, modality: asset?.modality ?? null, state, shipped });
  }
  return findings;
}

export function attestationBlockers(findings) {
  return {
    shippedNonAttestable: findings.filter((f) => f.state === "non_attestable" && f.shipped),
    shippedPending: findings.filter((f) => f.state === "pending" && f.shipped),
  };
}
