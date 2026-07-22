// Rendered-output content-residue scan + proof-attestation gate.
//
// Scans BUILT campaign output (_site HTML), not frontmatter: layout- or
// script-rendered proof/urgency chrome only exists after the build, which is
// why frontmatter-level checks missed the hardcoded rating/countdown chrome.
//
// Pattern provenance: the generic anti-pattern classes distilled from the
// 2026-07 winning-campaign content audit (invented counts, fabricated
// verified-buyer chrome, fictional bylines, borrowed authority, science
// theater, scarcity theater, fake comparisons, unlinked press marquees).
// Only GENERIC patterns and the public starter-template demo strings live
// here; merchant-specific residue fingerprints are deliberately not carried
// in this public package.
//
// Posture (fail closed, two tiers):
// - hard: the literal needs-merchant-input marker, and urgency chrome
//   rendered without verified offer urgency — blockers (collect-inputs).
// - review: anti-pattern hits and demo/placeholder residue — warnings that
//   feed the review/attestation queue; a hit means "remove or demand
//   brief/source evidence", never "make it more plausible".
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
// campaign (the templates de-fabricated these; hits mean a stale template or
// unreplaced demo frontmatter).
export const DEMO_RESIDUE_TERMS = Object.freeze([
  "Sarah Mitchell",
  "Wellness Insider",
  "10 Reasons Why You Need This",
  "Lowest Price of the Year",
  "DEAL ENDING IN:",
  "1,247 reviews",
  "48,312",
  "48,000+",
  "Sandra M.",
  "Derek H.",
  "Sell-Out Risk: High",
]);

// Generic anti-pattern classes (review tier). Each id is stable so the
// attestation/review UX can key on it.
export const CONTENT_ANTI_PATTERNS = Object.freeze([
  {
    id: "invented_counts",
    antiPattern: 1,
    rule: "Counts/ratings/percent-recommend claims require a real, brief-sourced basis.",
    regex: /\b\d{1,3}(?:,\d{3})*\+?\s+(?:reviews?|ratings?|customers?|users?|famil(?:y|ies)|wearers?|sold|pairs|people)\b|\b(?:4\.[5-9]|5\.0)\s*(?:\/\s*5|stars?)|\b(?:9[0-9]|100)%\b[^<]{0,60}\b(?:recommend|reported|said|would)\b/i,
  },
  {
    id: "verified_buyer_chrome",
    antiPattern: 2,
    rule: "'Verified' labels must resolve to a real approved review source.",
    regex: /Verified\s+(?:Buyer|Customer|Purchase)|What\s+(?:Our\s+)?Customers\s+(?:Think|Say)|Real\s+(?:People|Customers)[^<]{0,20}Real\s+(?:Results|Relief)|5[- ]Star\s+Review/i,
  },
  {
    id: "byline_persona",
    antiPattern: 3,
    rule: "Advertorial identities must be real, brief-supplied, and authorized.",
    regex: /Mom\s+of\s+Two|Consumer\s+Report|Review\s+Team|Wellness\s+Educator|Licensed\s+(?:Physiotherapist|Professional)/i,
  },
  {
    id: "borrowed_authority",
    antiPattern: 4,
    rule: "Expert/clinician/institution references require name, credential, permission, and source.",
    regex: /\bDr\.\s+[A-Z]|\bM\.?D\.?\b|doctor[- ]recommended|clinically\s+(?:recognized|recommended)|expert\s+(?:says|recommends)/i,
  },
  {
    id: "press_marquee",
    antiPattern: 8,
    rule: "Press mentions require a brief-supplied working URL for the exact merchant and product.",
    regex: /As\s+Seen\s+(?:On|In)|Featured\s+(?:On|In)/i,
  },
  {
    id: "science_theater",
    antiPattern: 9,
    rule: "Study/clinical/certification claims require citation metadata and approved wording.",
    regex: /peer[- ]reviewed|science[- ]backed|backed\s+by\s+science|stud(?:y|ies)\s+(?:show|prove|confirm)|researchers\s+found|clinically\s+(?:proven|shown|tested)|NASA[- ]developed/i,
  },
  {
    id: "scarcity_theater",
    antiPattern: 10,
    rule: "Urgency renders only from a real, approved promotion window or live inventory source.",
    regex: /ENDS\s+AT\s+MIDNIGHT|Offer\s+Expires|Deal\s+Ending|Only\s+\d+\s+(?:Units\s+)?Left|Stock\s+(?:Levels?\s+)?Low|\d+%\s+Sold|Sell[- ]?Out\s+Risk|supplies\s+are\s+limited/i,
  },
  {
    id: "fake_comparison",
    antiPattern: 11,
    rule: "Tested-N/showdown framing requires a brief-supplied comparison matrix and test record.",
    regex: /(?:we\s+)?tested\s+\d+\s+(?:contenders|products|devices|gloves|combinations|brands)|only\s+one\s+(?:survived|worked|stood)|Competitor\s+[12]\b/i,
  },
]);

function isHtmlComment(html, index) {
  const open = html.lastIndexOf("<!--", index);
  if (open === -1) return false;
  const close = html.indexOf("-->", open);
  return close !== -1 && close > index;
}

function excerptAt(html, index, span = 80) {
  const start = Math.max(0, index - 20);
  return html.slice(start, start + span).replace(/\s+/g, " ").trim();
}

// Pure scan of one rendered HTML document. Returns { hard: [], review: [] };
// each finding: { id, tier, rule?, excerpt }.
export function scanRenderedHtml(html, { urgencyVerified = false } = {}) {
  const text = typeof html === "string" ? html : "";
  const hard = [];
  const review = [];

  const marker = NEEDS_INPUT_MARKER.exec(text);
  if (marker) {
    hard.push({ id: "needs_merchant_input_marker", tier: "hard", excerpt: excerptAt(text, marker.index) });
  }

  const countdown = COUNTDOWN_CHROME.exec(text);
  if (countdown && !urgencyVerified) {
    hard.push({
      id: "unverified_urgency_countdown",
      tier: "hard",
      rule: "Countdown chrome rendered without verified offer urgency (offer.urgency.verified).",
      excerpt: excerptAt(text, countdown.index),
    });
  }

  const bracket = BRACKET_STUB.exec(text);
  if (bracket && !isHtmlComment(text, bracket.index)) {
    review.push({ id: "bracket_placeholder_stub", tier: "review", excerpt: excerptAt(text, bracket.index) });
  }

  for (const term of DEMO_RESIDUE_TERMS) {
    const index = text.indexOf(term);
    if (index !== -1) {
      review.push({ id: "demo_residue_term", tier: "review", term, excerpt: excerptAt(text, index) });
    }
  }

  for (const pattern of CONTENT_ANTI_PATTERNS) {
    if (pattern.id === "scarcity_theater" && urgencyVerified) continue;
    const match = pattern.regex.exec(text);
    if (match && !isHtmlComment(text, match.index)) {
      review.push({
        id: pattern.id,
        tier: "review",
        antiPattern: pattern.antiPattern,
        rule: pattern.rule,
        excerpt: excerptAt(text, match.index),
      });
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
// concatenated rendered text. Returns findings:
// { id, assetId, modality, state, shipped } where state is
// "verified" | "accepted" | "pending" | "non_attestable".
export function evaluateProofAssets(proofAssets, renderedText) {
  const findings = [];
  const haystack = normalizeForMatch(renderedText);
  for (const asset of Array.isArray(proofAssets) ? proofAssets : []) {
    const verified = asset?.verified === true;
    const accepted = asset?.attestation_status === "accepted";
    const attestable = asset?.attestable === true;
    const state = verified ? "verified" : accepted ? "accepted" : attestable ? "pending" : "non_attestable";
    // Match on a distinctive prefix of the asset content; short contents
    // match whole. Whitespace-normalized, case-insensitive.
    const needle = normalizeForMatch(asset?.content).slice(0, 60);
    const shipped = needle.length >= 8 && haystack.includes(needle);
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
