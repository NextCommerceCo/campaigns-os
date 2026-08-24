/**
 * Dependency-free extraction and Exact-only commercial parity comparison.
 *
 * Source HTML is intentional: Campaign Cart replaces authored placeholders
 * after readiness, which can hide an authored mismatch in the rendered DOM.
 */

import {
  CALCULATED_PAIR_EVIDENCE,
  PricingState,
  centsToUsd,
  moneyToCents,
} from "./commercial-journey.mjs";

export const COMMERCIAL_PARITY_SCHEMA_VERSION = "campaigns-os-commercial-parity/v0";

export const COMMERCIAL_PARITY_LIMITS = Object.freeze({
  max_html_bytes: 2 * 1024 * 1024,
  max_nodes: 50_000,
  max_depth: 128,
  max_claims: 500,
});

export class CommercialParityLimitError extends Error {
  constructor(kind, limit, actual) {
    super(`Commercial HTML ${kind} limit exceeded (${actual} > ${limit}).`);
    this.name = "CommercialParityLimitError";
    this.code = `commercial_html_${kind}_limit`;
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
  }
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const RAW_TAGS = new Set(["script", "style", "template", "textarea"]);
const COMPARISON_TAGS = new Set(["del", "s", "strike"]);
const COUNT_WORDS = Object.freeze({
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
});
const MONEY_SOURCE = String.raw`((?:(?:USD|US\$)\s*)?\$\s*\d[\d,]*(?:\.\d{1,2})?)`;
const COUNT_SOURCE = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)`;
const INTERVAL_SOURCE = String.raw`(days?|d|weeks?|wks?|wk|months?|mos?|mo|years?|yrs?|yr)`;

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    dollar: "$",
    euro: "€",
    gt: ">",
    ldquo: "“",
    lt: "<",
    mdash: "—",
    minus: "−",
    nbsp: " ",
    ndash: "–",
    pound: "£",
    quot: '"',
    rdquo: "”",
  };
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      const validScalar = Number.isInteger(parsed)
        && parsed >= 0
        && parsed <= 0x10FFFF
        && !(parsed >= 0xD800 && parsed <= 0xDFFF);
      return validScalar ? String.fromCodePoint(parsed) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function findTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function findRawClosingTag(source, tag, start) {
  let cursor = start;
  while (cursor < source.length) {
    const candidate = source.indexOf("</", cursor);
    if (candidate < 0) return -1;
    const name = source.slice(candidate + 2, candidate + 2 + tag.length);
    const boundary = source[candidate + 2 + tag.length];
    if (name.toLowerCase() === tag && (boundary === ">" || boundary === "/" || /\s/.test(boundary || ""))) {
      return candidate;
    }
    cursor = candidate + 2;
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function extractionLimits(options = {}) {
  const requested = options.limits && typeof options.limits === "object" ? options.limits : {};
  const value = (field) => {
    const candidate = Number(requested[field] ?? COMMERCIAL_PARITY_LIMITS[field]);
    return Number.isInteger(candidate) && candidate > 0
      ? candidate
      : COMMERCIAL_PARITY_LIMITS[field];
  };
  return {
    max_html_bytes: value("max_html_bytes"),
    max_nodes: value("max_nodes"),
    max_depth: value("max_depth"),
    max_claims: value("max_claims"),
  };
}

function parseHtml(sourceValue, limits) {
  const source = String(sourceValue || "");
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > limits.max_html_bytes) {
    throw new CommercialParityLimitError("bytes", limits.max_html_bytes, byteLength);
  }
  const root = { tag: "#root", attrs: Object.create(null), children: [], parent: null };
  const stack = [root];
  const openIndexesByTag = new Map();
  let nodeCount = 0;
  let index = 0;

  const appendText = (text) => {
    if (text) stack.at(-1).children.push(text);
  };

  const pushOpenNode = (node) => {
    const stackIndex = stack.length;
    stack.push(node);
    const indexes = openIndexesByTag.get(node.tag) || [];
    indexes.push(stackIndex);
    openIndexesByTag.set(node.tag, indexes);
  };

  const closeOpenNode = (tag) => {
    const indexes = openIndexesByTag.get(tag);
    if (!indexes?.length) return;
    const stackIndex = indexes.at(-1);
    for (let openIndex = stack.length - 1; openIndex >= stackIndex; openIndex -= 1) {
      const openNode = stack[openIndex];
      const openIndexes = openIndexesByTag.get(openNode.tag);
      openIndexes.pop();
      if (openIndexes.length === 0) openIndexesByTag.delete(openNode.tag);
    }
    stack.length = stackIndex;
  };

  while (index < source.length) {
    const nextTag = source.indexOf("<", index);
    if (nextTag < 0) {
      appendText(source.slice(index));
      break;
    }
    if (nextTag > index) appendText(source.slice(index, nextTag));

    if (source.startsWith("<!--", nextTag)) {
      const commentEnd = source.indexOf("-->", nextTag + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }

    const end = findTagEnd(source, nextTag);
    if (end < 0) {
      appendText(source.slice(nextTag));
      break;
    }
    const token = source.slice(nextTag + 1, end).trim();
    index = end + 1;
    if (!token || token[0] === "!" || token[0] === "?") continue;

    if (token[0] === "/") {
      const closing = token.slice(1).trim().match(/^([a-z][^\s/>]*)/i)?.[1]?.toLowerCase();
      if (!closing) continue;
      closeOpenNode(closing);
      continue;
    }

    const selfClosing = /\/\s*$/.test(token);
    const opening = token.match(/^([a-z][^\s/>]*)/i);
    if (!opening) {
      appendText(source.slice(nextTag, end + 1));
      continue;
    }
    const tag = opening[1].toLowerCase();
    nodeCount += 1;
    if (nodeCount > limits.max_nodes) {
      throw new CommercialParityLimitError("nodes", limits.max_nodes, nodeCount);
    }
    if (stack.length > limits.max_depth) {
      throw new CommercialParityLimitError("depth", limits.max_depth, stack.length);
    }
    const attributeSource = token.slice(opening[0].length).replace(/\/\s*$/, "");
    const node = {
      tag,
      attrs: parseAttributes(attributeSource),
      children: [],
      parent: stack.at(-1),
    };
    stack.at(-1).children.push(node);

    if (RAW_TAGS.has(tag)) {
      const closeStart = findRawClosingTag(source, tag, index);
      if (closeStart < 0) {
        index = source.length;
      } else {
        const closeEnd = findTagEnd(source, closeStart);
        index = closeEnd < 0 ? source.length : closeEnd + 1;
      }
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) pushOpenNode(node);
  }

  return root;
}

function indexNodes(root) {
  const nodes = [];
  const packageAncestor = new Map();
  const nearestToggle = new Map();
  const hidden = new Map();
  const comparison = new Map();
  const pending = [...root.children].reverse();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value === "string") continue;
    nodes.push(value);
    const parent = value.parent;
    packageAncestor.set(value, hasAttribute(parent, "data-next-package-id")
      || packageAncestor.get(parent) === true);
    nearestToggle.set(value, hasAttribute(value, "data-next-package-toggle")
      ? value
      : nearestToggle.get(parent) || null);
    hidden.set(value, nodeIsHidden(value) || hidden.get(parent) === true);
    comparison.set(value, COMPARISON_TAGS.has(value.tag) || comparison.get(parent) === true);
    for (let index = value.children.length - 1; index >= 0; index -= 1) {
      pending.push(value.children[index]);
    }
  }

  const packageCounts = new Map();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    let count = hasAttribute(node, "data-next-package-id") ? 1 : 0;
    array(node.children).forEach((child) => {
      if (child && typeof child !== "string") count += packageCounts.get(child) || 0;
    });
    packageCounts.set(node, count);
  }

  return {
    nodes,
    packageAncestor,
    nearestToggle,
    hidden,
    comparison,
    packageCounts,
  };
}

function hasAttribute(node, name) {
  return Object.prototype.hasOwnProperty.call(node?.attrs || {}, name);
}

function nodeIsHidden(node) {
  if (!node) return false;
  if (hasAttribute(node, "hidden")) return true;
  if (String(node.attrs?.["aria-hidden"] || "").toLowerCase() === "true") return true;
  const style = String(node.attrs?.style || "");
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(style);
}

function textContent(node, options = {}) {
  if (options.excludeComparison && COMPARISON_TAGS.has(node?.tag)) return "";
  let result = "";
  const pending = [...array(node?.children)].reverse();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      result += value;
      continue;
    }
    if (!value || nodeIsHidden(value)) continue;
    if (options.excludeComparison && COMPARISON_TAGS.has(value.tag)) continue;
    for (let index = value.children.length - 1; index >= 0; index -= 1) {
      pending.push(value.children[index]);
    }
  }
  return decodeEntities(result).replace(/\s+/g, " ").trim();
}

function normalizeMoney(value) {
  const text = decodeEntities(value).replace(/[\u00a0\s]+/g, " ").trim();
  const match = text.match(/^(?:(?:USD|US\$)\s*|\$\s*)?([+-]?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/i);
  if (!match) return null;
  const integer = match[2].replace(/,/g, "");
  const normalized = `${match[1]}${integer}.${String(match[3] || "").padEnd(2, "0")}`;
  const cents = moneyToCents(normalized);
  return cents === null ? null : centsToUsd(cents);
}

function positiveInteger(value) {
  if (!present(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function intervalUnit(value) {
  const unit = String(value || "").toLowerCase();
  if (["d", "day", "days"].includes(unit)) return "day";
  if (["wk", "wks", "week", "weeks"].includes(unit)) return "week";
  if (["mo", "mos", "month", "months"].includes(unit)) return "month";
  if (["yr", "yrs", "year", "years"].includes(unit)) return "year";
  return null;
}

function intervalCount(value, fallback = null) {
  if (!present(value)) return fallback;
  const lower = String(value).toLowerCase();
  return positiveInteger(lower) ?? COUNT_WORDS[lower] ?? null;
}

function recurrenceClaims(textValue) {
  const text = decodeEntities(textValue).replace(/\s+/g, " ");
  const claims = [];
  const decorativeContext = (start, end) => {
    const before = text.slice(Math.max(0, start - 64), start);
    const after = text.slice(end, Math.min(text.length, end + 48));
    const comparisonBefore = /\b(?:save|saving|savings|discount|discounted|off|compare|compared|comparison|versus|vs|was|retail|regular(?:ly)?|normally|worth)\b[^.!?;:]{0,32}$/i;
    const comparisonAfter = /^[^.!?;:]{0,24}\b(?:in savings|savings?|discount|off)\b/i;
    return comparisonBefore.test(before) || comparisonAfter.test(after);
  };
  const add = (amountValue, countValue, unitValue, start, end) => {
    if (decorativeContext(start, end)) return;
    const amount = normalizeMoney(amountValue);
    const count = intervalCount(countValue, 1);
    const interval = intervalUnit(unitValue);
    if (amount && count && interval) claims.push({ amount, interval_count: count, interval });
  };

  const slash = new RegExp(`${MONEY_SOURCE}\\s*\\/\\s*${COUNT_SOURCE}?\\s*${INTERVAL_SOURCE}\\b`, "gi");
  const repeating = new RegExp(`${MONEY_SOURCE}\\s*(?:every|per)\\s*${COUNT_SOURCE}?\\s*${INTERVAL_SOURCE}\\b`, "gi");
  const adverb = new RegExp(`${MONEY_SOURCE}\\s+(daily|weekly|monthly|yearly|annually)\\b`, "gi");
  let match;
  while ((match = slash.exec(text)) !== null) add(match[1], match[2], match[3], match.index, slash.lastIndex);
  while ((match = repeating.exec(text)) !== null) add(match[1], match[2], match[3], match.index, repeating.lastIndex);
  while ((match = adverb.exec(text)) !== null) {
    const units = { daily: "day", weekly: "week", monthly: "month", yearly: "year", annually: "year" };
    add(match[1], 1, units[match[2].toLowerCase()], match.index, adverb.lastIndex);
  }

  const seen = new Set();
  return claims.filter((claim) => {
    const key = `${claim.amount}:${claim.interval_count}:${claim.interval}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function governedRecurrenceRoot(packageNode, nodeIndex) {
  if (nodeIndex.packageAncestor.get(packageNode) === true) return null;
  const toggle = nodeIndex.nearestToggle.get(packageNode);
  if (toggle) return nodeIndex.packageCounts.get(toggle) === 1 ? toggle : null;
  return nodeIndex.packageCounts.get(packageNode) === 1 ? packageNode : null;
}

function governedPriceBinding(value) {
  return typeof value === "string" && /^bundle\.[^.]+\.price$/.test(value.trim());
}

function extractPrices(nodeIndex, consumeClaim) {
  const seen = new Set();
  const prices = [];
  const candidates = nodeIndex.nodes.filter((node) => {
    const binding = String(node.attrs?.["data-next-display"] || "").trim();
    const format = String(node.attrs?.["data-next-format"] || "").trim().toLowerCase();
    return governedPriceBinding(binding)
      && format === "currency"
      && nodeIndex.hidden.get(node) !== true
      && nodeIndex.comparison.get(node) !== true;
  });
  const candidateSet = new Set(candidates);
  const candidateCounts = new Map();
  for (let index = nodeIndex.nodes.length - 1; index >= 0; index -= 1) {
    const node = nodeIndex.nodes[index];
    let count = candidateSet.has(node) ? 1 : 0;
    array(node.children).forEach((child) => {
      if (child && typeof child !== "string") count += candidateCounts.get(child) || 0;
    });
    candidateCounts.set(node, count);
  }

  candidates.forEach((node) => {
    const binding = String(node.attrs?.["data-next-display"] || "").trim();
    const format = String(node.attrs?.["data-next-format"] || "").trim().toLowerCase();
    if (!governedPriceBinding(binding)
      || format !== "currency"
      || nodeIndex.hidden.get(node) === true
      || nodeIndex.comparison.get(node) === true
      || candidateCounts.get(node) !== 1) return;
    const value = normalizeMoney(textContent(node, { excludeComparison: true }));
    if (!value) return;
    const key = `${binding}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    consumeClaim();
    prices.push({ binding, value });
  });
  return prices;
}

function extractRecurrences(nodeIndex, errors, consumeClaim) {
  const seenRoots = new Set();
  const seenClaims = new Set();
  const recurrences = [];
  nodeIndex.nodes.forEach((node) => {
    if (hasAttribute(node, "data-next-package-id")
      && positiveInteger(node.attrs["data-next-package-id"]) === null) {
      errors.push({ type: "malformed-package-id" });
      return;
    }
    const packageId = positiveInteger(node.attrs?.["data-next-package-id"]);
    if (packageId === null) return;
    const root = governedRecurrenceRoot(node, nodeIndex);
    if (!root || nodeIndex.hidden.get(root) === true || nodeIndex.comparison.get(root) === true) return;
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    recurrenceClaims(textContent(root, { excludeComparison: true })).forEach((claim) => {
      const key = `${packageId}:${claim.amount}:${claim.interval_count}:${claim.interval}`;
      if (seenClaims.has(key)) return;
      seenClaims.add(key);
      consumeClaim();
      recurrences.push({ package_id: packageId, ...claim });
    });
  });
  return recurrences;
}

function extractVouchers(nodeIndex, errors, consumeClaim) {
  const seen = new Set();
  const vouchers = [];
  nodeIndex.nodes.forEach((node) => {
    if (!hasAttribute(node, "data-next-bundle-vouchers")) return;
    let parsed;
    try {
      parsed = JSON.parse(node.attrs["data-next-bundle-vouchers"]);
    } catch (_error) {
      errors.push({ type: "malformed-voucher-json" });
      return;
    }
    if (!Array.isArray(parsed)
      || parsed.some((value) => typeof value !== "string" || !value.trim())) {
      errors.push({ type: "malformed-voucher-shape" });
      return;
    }
    parsed.forEach((value) => {
      const code = value.trim();
      const key = code.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      consumeClaim();
      vouchers.push({ code });
    });
  });
  return vouchers;
}

/**
 * Extract only contract-governed authored claims from one page's source HTML.
 */
export function extractCommercialClaims(html, options = {}) {
  const limits = extractionLimits(options);
  const root = parseHtml(html, limits);
  const nodeIndex = indexNodes(root);
  const extractionErrors = [];
  let claimCount = 0;
  const consumeClaim = () => {
    claimCount += 1;
    if (claimCount > limits.max_claims) {
      throw new CommercialParityLimitError("claims", limits.max_claims, claimCount);
    }
  };
  const priceClaims = extractPrices(nodeIndex, consumeClaim);
  const recurrenceClaims = extractRecurrences(nodeIndex, extractionErrors, consumeClaim);
  const vouchers = extractVouchers(nodeIndex, extractionErrors, consumeClaim);
  return {
    page_id: present(options.pageId) ? String(options.pageId) : null,
    ...(present(options.url) ? { url: String(options.url) } : {}),
    price_claims: priceClaims,
    recurrence_claims: recurrenceClaims,
    vouchers,
    ...(extractionErrors.length ? { extraction_errors: extractionErrors } : {}),
  };
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPriceClaim(claim) {
  return record(claim)
    && governedPriceBinding(claim.binding)
    && normalizeMoney(claim.value) !== null;
}

function validRecurrenceClaim(claim) {
  return record(claim)
    && positiveInteger(claim.package_id) !== null
    && normalizeMoney(claim.amount) !== null
    && positiveInteger(claim.interval_count) !== null
    && intervalUnit(claim.interval) !== null;
}

function validVoucherClaim(claim) {
  return record(claim) && typeof claim.code === "string" && present(claim.code);
}

function validCapture(capture) {
  if (!record(capture)) return false;
  if (capture.page_id !== undefined
    && capture.page_id !== null
    && (typeof capture.page_id !== "string" || !present(capture.page_id))) return false;
  if (capture.url !== undefined && (typeof capture.url !== "string" || !present(capture.url))) return false;
  if (capture.extraction_errors !== undefined
    && (!Array.isArray(capture.extraction_errors) || capture.extraction_errors.length > 0)) return false;
  return Array.isArray(capture.price_claims)
    && capture.price_claims.every(validPriceClaim)
    && Array.isArray(capture.recurrence_claims)
    && capture.recurrence_claims.every(validRecurrenceClaim)
    && Array.isArray(capture.vouchers)
    && capture.vouchers.every(validVoucherClaim);
}

function captureCandidates(capturesValue) {
  if (Array.isArray(capturesValue)) return capturesValue;
  return capturesValue === undefined || capturesValue === null ? [] : [capturesValue];
}

function partitionCaptures(capturesValue) {
  const valid = [];
  const invalid = [];
  captureCandidates(capturesValue).forEach((capture, index) => {
    if (validCapture(capture)) {
      valid.push(capture);
      return;
    }
    invalid.push({
      index,
      ...(record(capture) && present(capture.page_id) ? { page_id: String(capture.page_id) } : {}),
      ...(record(capture) && present(capture.url) ? { url: String(capture.url) } : {}),
    });
  });
  return { valid, invalid };
}

function priceComparisonClaims(capture, page) {
  const claims = array(capture?.price_claims);
  if (!exactMoneyFact(page?.representative_total)) {
    return { compared: [], unresolved: claims.length };
  }
  const bindings = [...new Set(claims.map((claim) => String(claim.binding)))];
  const explicit = present(page?.representative_price_binding)
    ? String(page.representative_price_binding)
    : null;
  const binding = explicit
    ? (bindings.includes(explicit) ? explicit : null)
    : (bindings.length === 1 ? bindings[0] : null);
  const compared = binding ? claims.filter((claim) => String(claim.binding) === binding) : [];
  return { compared, unresolved: claims.length - compared.length };
}

function pageForCapture(capture, journey) {
  const pages = array(journey?.pages);
  if (present(capture?.page_id)) {
    return pages.find((page) => String(page?.page_id) === String(capture.page_id)) || null;
  }
  return pages.length === 1 ? pages[0] : null;
}

function exactMoneyFact(fact) {
  if (fact?.state !== PricingState.Exact) return null;
  const value = normalizeMoney(fact.value);
  if (!value) return null;
  return { value, cents: moneyToCents(value) };
}

function exactRecurrence(row) {
  const recurrence = row?.recurrence;
  if (row?.state !== PricingState.Exact
    || recurrence?.state !== PricingState.Exact
    || recurrence?.amount?.state !== PricingState.Exact) return null;
  const amount = normalizeMoney(recurrence.amount.value);
  const count = positiveInteger(recurrence.interval_count);
  const interval = intervalUnit(recurrence.interval);
  if (!amount || count === null || !interval) return null;
  return { amount, interval_count: count, interval };
}

function recurrenceEquivalent(claim, truth) {
  if (moneyToCents(claim.amount) !== moneyToCents(truth.amount)) return false;
  if (claim.interval_count === truth.interval_count && claim.interval === truth.interval) return true;

  // Uzzle's accepted monthly disclosure is the one narrow proven equivalence:
  // its API cadence is expressed as 30 days. Do not generalize rate math.
  return (claim.interval_count === 1 && claim.interval === "month"
      && truth.interval_count === 30 && truth.interval === "day")
    || (truth.interval_count === 1 && truth.interval === "month"
      && claim.interval_count === 30 && claim.interval === "day");
}

function recurrenceComparisonClaims(capture, page) {
  const compared = [];
  let unresolved = 0;
  array(capture?.recurrence_claims).forEach((claim) => {
    const packageId = positiveInteger(claim?.package_id);
    const matchingRows = array(page?.rows).filter((row) => String(row?.package_id) === String(packageId));
    const truths = [];
    const seen = new Set();
    matchingRows.map(exactRecurrence).filter(Boolean).forEach((truth) => {
      const key = `${truth.amount}:${truth.interval_count}:${truth.interval}`;
      if (seen.has(key)) return;
      seen.add(key);
      truths.push(truth);
    });
    if (packageId === null || truths.length !== 1) {
      unresolved += 1;
      return;
    }
    compared.push({ claim, truth: truths[0] });
  });
  return { compared, unresolved };
}

function voucherComparisonClaims(capture, page) {
  const compared = [];
  let unresolved = 0;
  array(capture?.vouchers).forEach((voucher) => {
    const code = String(voucher?.code || "").trim();
    const statuses = [...new Set(array(page?.offers)
      .filter((offer) => String(offer?.code || "").toUpperCase() === code.toUpperCase()
        && offer?.calculation_evidence === CALCULATED_PAIR_EVIDENCE
        && offer?.state === PricingState.Exact
        && (offer?.status === "Applied" || offer?.status === "Not applied"))
      .map((offer) => offer.status))];
    if (!code || statuses.length !== 1) {
      unresolved += 1;
      return;
    }
    compared.push({ voucher: { code }, status: statuses[0] });
  });
  return { compared, unresolved };
}

function findingPage(capture, page) {
  return String(capture?.page_id ?? page?.page_id ?? "campaign");
}

/**
 * Pure, Exact-only diff. Unresolved, Stale, unbound, and malformed facts are
 * deliberately silent.
 */
export function diffCommercialParity(capturesValue, journey) {
  const captures = partitionCaptures(capturesValue).valid;
  const findings = [];

  captures.forEach((capture) => {
    const page = pageForCapture(capture, journey);
    if (!page) return;
    const pageId = findingPage(capture, page);
    const source = present(capture.url) ? { url: String(capture.url) } : {};
    const representative = exactMoneyFact(page.representative_total);
    if (representative) {
      priceComparisonClaims(capture, page).compared.forEach((claim) => {
        const claimed = normalizeMoney(claim?.value);
        if (!claimed || !present(claim?.binding) || moneyToCents(claimed) === representative.cents) return;
        findings.push({
          type: "price-claim-mismatch",
          page_id: pageId,
          ...source,
          binding: String(claim.binding),
          claimed,
          calculated: representative.value,
        });
      });
    }

    recurrenceComparisonClaims(capture, page).compared.forEach(({ claim, truth }) => {
      const packageId = positiveInteger(claim?.package_id);
      const claimed = {
        amount: normalizeMoney(claim?.amount),
        interval_count: positiveInteger(claim?.interval_count),
        interval: intervalUnit(claim?.interval),
      };
      if (packageId === null || !claimed.amount || claimed.interval_count === null || !claimed.interval) return;
      if (recurrenceEquivalent(claimed, truth)) return;
      findings.push({
        type: "cadence-disclosure-mismatch",
        page_id: pageId,
        ...source,
        package_id: packageId,
        claimed,
        calculated: truth,
      });
    });

    voucherComparisonClaims(capture, page).compared.forEach(({ voucher, status }) => {
      if (status === "Applied") return;
      const code = voucher.code;
      findings.push({
        type: "voucher-not-applied",
        page_id: pageId,
        ...source,
        code,
        claimed: "Applied",
        calculated: "Not applied",
      });
    });
  });

  return findings;
}

function component(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9._-]+/gi, "-");
}

function cadenceText(value) {
  const plural = value.interval_count === 1 ? value.interval : `${value.interval}s`;
  return `${value.amount} / ${value.interval_count} ${plural}`;
}

function assertionBaseId(finding) {
  if (finding.type === "price-claim-mismatch") {
    return `${finding.type}:${component(finding.page_id)}:${component(finding.binding)}`;
  }
  if (finding.type === "cadence-disclosure-mismatch") {
    return `${finding.type}:${component(finding.page_id)}:package-${component(finding.package_id)}`;
  }
  if (finding.type === "voucher-not-applied") {
    return `${finding.type}:${component(finding.page_id)}:${component(finding.code)}`;
  }
  throw new TypeError(`Unknown commercial parity finding type: ${String(finding?.type)}`);
}

function assertionForFinding(finding, id) {
  const common = {
    id,
    family: "pricing",
    page: finding.page_id || "campaign",
    ...(finding.url ? { url: finding.url } : {}),
    status: "warn",
    severity: "warn",
  };
  if (finding.type === "price-claim-mismatch") {
    return {
      ...common,
      expected: finding.calculated,
      actual: finding.claimed,
      evidence: { type: finding.type, binding: finding.binding },
    };
  }
  if (finding.type === "cadence-disclosure-mismatch") {
    return {
      ...common,
      expected: cadenceText(finding.calculated),
      actual: cadenceText(finding.claimed),
      evidence: {
        type: finding.type,
        package_id: finding.package_id,
        claimed: finding.claimed,
        calculated: finding.calculated,
      },
    };
  }
  if (finding.type === "voucher-not-applied") {
    return {
      ...common,
      expected: "Applied",
      actual: "Not applied",
      evidence: { type: finding.type, code: finding.code },
    };
  }
  throw new TypeError(`Unknown commercial parity finding type: ${String(finding?.type)}`);
}

export function serializeCommercialFindings(findingsValue, options = {}) {
  const findings = array(findingsValue);
  const requestedAssertionLimit = Number(options.maxAssertions);
  const maxAssertions = Number.isInteger(requestedAssertionLimit) && requestedAssertionLimit >= 0
    ? requestedAssertionLimit
    : Number.POSITIVE_INFINITY;
  const overflow = Math.max(0, findings.length - maxAssertions);
  const detailedFindingCount = overflow > 0 && maxAssertions > 0
    ? maxAssertions - 1
    : Math.min(findings.length, maxAssertions);
  const idCounts = new Map();
  const assertions = findings.slice(0, detailedFindingCount).map((finding) => {
    const base = assertionBaseId(finding);
    const count = idCounts.get(base) || 0;
    idCounts.set(base, count + 1);
    const suffix = count === 0 ? "" : `:${count + 1}`;
    return assertionForFinding(finding, `${base}${suffix}`);
  });
  const omittedFindingCount = findings.length - detailedFindingCount;
  if (omittedFindingCount > 0 && maxAssertions > 0) {
    assertions.push({
      id: "commercial-parity:additional-findings",
      family: "pricing",
      page: "campaign",
      status: "warn",
      severity: "warn",
      expected: "Every proven commercial mismatch serialized individually",
      actual: `${omittedFindingCount} additional proven mismatch${omittedFindingCount === 1 ? "" : "es"} retained in verdict.commercial.findings`,
      evidence: {
        type: "commercial-assertion-overflow",
        omitted_finding_count: omittedFindingCount,
      },
    });
  }
  return { assertions, omittedFindingCount };
}

/**
 * Build the runner-facing commercial evidence section and flat QA assertions.
 */
export function createCommercialParityReport(capturesValue, journey, options = {}) {
  const { valid: captures, invalid: invalidCaptures } = partitionCaptures(capturesValue);
  const findings = diffCommercialParity(captures, journey);
  const { assertions, omittedFindingCount } = serializeCommercialFindings(findings, options);
  const captureMatches = captures.map((capture) => ({ capture, page: pageForCapture(capture, journey) }));
  const matched = captureMatches.filter((entry) => entry.page);
  const unmatchedPages = captureMatches.filter((entry) => !entry.page)
    .map(({ capture }) => ({
      page_id: present(capture.page_id) ? String(capture.page_id) : null,
      ...(present(capture.url) ? { url: String(capture.url) } : {}),
    }));
  const pageKeys = new Set(matched.map(({ page }) => String(page.page_id ?? "page")));
  const expectedPages = array(journey?.pages);
  const missingPages = expectedPages
    .filter((page) => !pageKeys.has(String(page?.page_id ?? "page")))
    .map((page) => ({ page_id: present(page?.page_id) ? String(page.page_id) : null }));
  const priceComparisonCounts = matched.reduce((counts, { capture, page }) => {
    const comparison = priceComparisonClaims(capture, page);
    counts.compared += comparison.compared.length;
    counts.unresolved += comparison.unresolved;
    return counts;
  }, { compared: 0, unresolved: 0 });
  const recurrenceComparisonCounts = matched.reduce((counts, { capture, page }) => {
    const comparison = recurrenceComparisonClaims(capture, page);
    counts.compared += comparison.compared.length;
    counts.unresolved += comparison.unresolved;
    return counts;
  }, { compared: 0, unresolved: 0 });
  const voucherComparisonCounts = matched.reduce((counts, { capture, page }) => {
    const comparison = voucherComparisonClaims(capture, page);
    counts.compared += comparison.compared.length;
    counts.unresolved += comparison.unresolved;
    return counts;
  }, { compared: 0, unresolved: 0 });

  return {
    schema_version: COMMERCIAL_PARITY_SCHEMA_VERSION,
    checked_pages: pageKeys.size,
    invalid_capture_count: invalidCaptures.length,
    invalid_captures: invalidCaptures,
    unmatched_page_count: unmatchedPages.length,
    unmatched_pages: unmatchedPages,
    missing_page_count: missingPages.length,
    missing_pages: missingPages,
    coverage_complete: invalidCaptures.length === 0
      && unmatchedPages.length === 0
      && missingPages.length === 0
      && priceComparisonCounts.unresolved === 0
      && recurrenceComparisonCounts.unresolved === 0
      && voucherComparisonCounts.unresolved === 0,
    extracted_price_claims: matched.reduce((sum, { capture }) => sum + array(capture.price_claims).length, 0),
    compared_price_claims: priceComparisonCounts.compared,
    unresolved_price_claims: priceComparisonCounts.unresolved,
    extracted_recurrence_claims: matched.reduce((sum, { capture }) => sum + array(capture.recurrence_claims).length, 0),
    compared_recurrence_claims: recurrenceComparisonCounts.compared,
    unresolved_recurrence_claims: recurrenceComparisonCounts.unresolved,
    extracted_voucher_claims: matched.reduce((sum, { capture }) => sum + array(capture.vouchers).length, 0),
    compared_voucher_claims: voucherComparisonCounts.compared,
    unresolved_voucher_claims: voucherComparisonCounts.unresolved,
    serialized_assertion_count: assertions.length,
    omitted_assertion_count: omittedFindingCount,
    findings,
    assertions,
  };
}
