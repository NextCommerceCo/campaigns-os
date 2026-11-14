import { runWithDeadline } from "./deadline.mjs";
import { specHashOf } from "./spec-hash.mjs";
import {
  CommercialJourneyLimitError,
  PricingState,
  normalizeJourney,
  planScenarios,
} from "./commercial-journey.mjs";
import {
  COMMERCIAL_PARITY_SCHEMA_VERSION,
  CommercialParityLimitError,
  PACKAGE_PRICE_NOT_FILLED,
  PACKAGE_PRICE_NOT_RENDERED,
  PACKAGE_PRICE_UNRESOLVED,
  bundlePriceClaimCount,
  createCommercialParityReport,
  extractCommercialClaims,
  packagePriceClaimCount,
  recurringClaimAbsences,
  recurringClaimAbsentAssertions,
} from "./commercial-parity.mjs";
import { extractRenderedPackageRefs } from "./live-campaign-refs.mjs";

export const COMMERCIAL_QA_LIMITS = Object.freeze({
  max_html_bytes: 2 * 1024 * 1024,
  max_aggregate_html_bytes: 16 * 1024 * 1024,
  max_proxy_bytes: 1024 * 1024,
  max_scenarios: 256,
  max_aggregate_claims: 256,
  concurrency: 4,
  request_timeout_ms: 20_000,
});

const ALLOWED_API_KEY_ENV_NAMES = new Set(["CAMPAIGNS_API_KEY"]);

export class QaResponseLimitError extends Error {
  constructor(kind, limit, actual) {
    super(`${kind} response exceeds ${limit} bytes${actual === null ? "" : ` (${actual})`}.`);
    this.name = "QaResponseLimitError";
    this.code = `${kind}_response_too_large`;
    this.limit = limit;
    this.actual = actual;
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCommercialApiKey(resolved, env = process.env) {
  const packetCampaign = resolved?.packet?.campaign;
  const packetKey = nonEmptyString(packetCampaign?.campaigns_api_key)
    || nonEmptyString(packetCampaign?.api_key);
  if (packetKey) return { value: packetKey, source: "packet" };

  const spec = resolved?.rawSpec || resolved?.spec || {};
  const specKey = nonEmptyString(spec?.campaign?.campaigns_api_key)
    || nonEmptyString(spec?.campaigns_api_key)
    || nonEmptyString(spec?.campaign?.api_key);
  if (specKey) return { value: specKey, source: "spec" };

  const declaredSource = nonEmptyString(packetCampaign?.api_key_source);
  if (declaredSource?.startsWith("env:")) {
    const name = declaredSource.slice("env:".length).trim();
    if (!ALLOWED_API_KEY_ENV_NAMES.has(name)) {
      return { value: null, source: declaredSource, unsupported: true };
    }
    const value = name ? nonEmptyString(env?.[name]) : null;
    if (value) return { value, source: declaredSource };
  }
  return { value: null, source: declaredSource || null };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function responseLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (!present(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Read a response body once while enforcing a byte ceiling during streaming. */
export async function readBoundedResponseText(response, {
  maxBytes,
  kind = "http",
} = {}) {
  const limit = positiveLimit(maxBytes, COMMERCIAL_QA_LIMITS.max_html_bytes);
  const declared = responseLength(response);
  if (declared !== null && declared > limit) {
    throw new QaResponseLimitError(kind, limit, declared);
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength || 0;
        if (received > limit) {
          await reader.cancel().catch(() => {});
          throw new QaResponseLimitError(kind, limit, received);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock?.();
    }
  }

  // Lightweight fetch stubs do not always expose a ReadableStream. Keep that
  // compatibility seam bounded after the stub resolves its text.
  const text = typeof response?.text === "function" ? await response.text() : "";
  const received = new TextEncoder().encode(text).byteLength;
  if (received > limit) throw new QaResponseLimitError(kind, limit, received);
  return text;
}

export function commercialSpecPages(spec, { maxPages = Number.POSITIVE_INFINITY } = {}) {
  const pages = [];
  const seen = new Set();
  const requestedLimit = Number(maxPages);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : Number.POSITIVE_INFINITY;
  if (limit === 0) return pages;
  const funnels = array(spec?.funnels).length
    ? spec.funnels
    : array(spec?.funnel_pages).length
      ? [{ id: "default", pages: spec.funnel_pages }]
      : [];
  for (const funnel of funnels) {
    for (const page of array(funnel?.pages)) {
      if (page?.enabled === false || array(page?.packages).length === 0 || !present(page?.id)) continue;
      const key = `id:${String(page.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(page);
      if (pages.length >= limit) return pages;
    }
  }
  return pages;
}

function captureFailure(page, code, error) {
  return {
    page_id: present(page?.page_id) ? String(page.page_id) : null,
    ...(present(page?.url) ? { url: String(page.url) } : {}),
    price_claims: [],
    recurrence_claims: [],
    vouchers: [],
    extraction_errors: [{
      type: code,
      ...(error ? { message: errorMessage(error) } : {}),
    }],
  };
}

export function captureCommercialClaims(page, html) {
  try {
    return {
      ...extractCommercialClaims(html, {
        pageId: present(page?.page_id) ? String(page.page_id) : null,
        url: page?.url,
      }),
      // Every package the page renders, by the refs doctor reads, so a
      // subscription whose rebill copy yielded no claim is still seen (#533).
      rendered_package_refs: [...extractRenderedPackageRefs(html)],
    };
  } catch (error) {
    const code = error instanceof CommercialParityLimitError
      ? error.code
      : "commercial_html_extraction_error";
    return captureFailure(page, code, error);
  }
}

export function unavailableCommercialCapture(page, error) {
  return captureFailure(page, "commercial_html_unavailable", error);
}

// The deadline rejects with `timeoutCode` whether or not the operation honours
// the abort signal it is handed, so a fetch that ignores its signal cannot
// hold the run open past the request budget.
function withTimeout(operation, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  return runWithDeadline(() => operation(controller.signal), {
    timeoutMs,
    onTimeout: () => controller.abort(),
    timeoutError: () => Object.assign(new Error(`Request exceeded its ${timeoutMs}ms deadline.`), { code: timeoutCode }),
  });
}

export function createPageSourceLoader({
  authCookie = null,
  fetchImpl = globalThis.fetch,
  limits: limitOverrides = {},
} = {}) {
  const maxBytes = positiveLimit(limitOverrides.max_html_bytes, COMMERCIAL_QA_LIMITS.max_html_bytes);
  const maxAggregateBytes = positiveLimit(
    limitOverrides.max_aggregate_html_bytes,
    COMMERCIAL_QA_LIMITS.max_aggregate_html_bytes,
  );
  const timeoutMs = positiveLimit(limitOverrides.request_timeout_ms, COMMERCIAL_QA_LIMITS.request_timeout_ms);
  const cache = new Map();
  let retainedBytes = 0;
  let aggregateLimitReached = false;
  let previousAdmission = Promise.resolve();

  const fetchPage = async (page) => {
    if (!present(page?.url)) {
      return { ok: false, error_code: "missing_url", error: "No page URL was resolved." };
    }
    if (typeof fetchImpl !== "function") {
      return { ok: false, error_code: "page_fetch_unavailable", error: "Fetch is unavailable." };
    }
    if (aggregateLimitReached || retainedBytes >= maxAggregateBytes) {
      return {
        ok: false,
        error_code: "page_html_aggregate_limit",
        error: `Retained page HTML reached the ${maxAggregateBytes}-byte run limit.`,
      };
    }
    try {
      return await withTimeout(async (signal) => {
        const headers = { Accept: "text/html,application/xhtml+xml" };
        if (present(authCookie)) headers.Cookie = String(authCookie);
        const response = await fetchImpl(page.url, { headers, signal });
        if (!response?.ok) {
          return {
            ok: false,
            error_code: "http_status",
            status: response?.status ?? null,
            status_text: response?.statusText || "",
            error: `${response?.status ?? "unknown"} ${response?.statusText || ""}`.trim(),
          };
        }
        const html = await readBoundedResponseText(response, { maxBytes, kind: "page_html" });
        return {
          ok: true,
          status: response.status,
          status_text: response.statusText || "",
          final_url: response.url || null,
          html,
        };
      }, timeoutMs, "page_fetch_timeout");
    } catch (error) {
      return {
        ok: false,
        error_code: error?.name === "AbortError" ? "page_fetch_timeout" : (error?.code || "page_fetch_error"),
        error: errorMessage(error),
      };
    }
  };

  // Requests may finish in any order. Admit their retained bodies in invocation
  // order so aggregate-budget decisions match the sequential runner exactly.
  const load = async (page) => {
    const turn = previousAdmission;
    let release;
    previousAdmission = new Promise(resolve => { release = resolve; });
    try {
      const source = await fetchPage(page);
      await turn;
      if (!present(page?.url) || typeof fetchImpl !== "function") return source;
      if (aggregateLimitReached || retainedBytes >= maxAggregateBytes) {
        return { ok: false, error_code: "page_html_aggregate_limit",
          error: `Retained page HTML reached the ${maxAggregateBytes}-byte run limit.` };
      }
      if (!source.ok) return source;
      const htmlBytes = new TextEncoder().encode(source.html).byteLength;
      if (retainedBytes + htmlBytes > maxAggregateBytes) {
        aggregateLimitReached = true;
        return { ok: false, error_code: "page_html_aggregate_limit",
          error: `Retained page HTML would exceed the ${maxAggregateBytes}-byte run limit.` };
      }
      retainedBytes += htmlBytes;
      return source;
    } finally {
      await turn;
      release();
    }
  };

  return (page) => {
    const key = String(page?.url || `missing:${page?.page_id || "page"}`);
    if (!cache.has(key)) cache.set(key, load(page));
    return cache.get(key);
  };
}

async function previewDescriptor(descriptor, { proxyBase, apiKey, fetchImpl, limits }) {
  const url = `${String(proxyBase).replace(/\/+$/, "")}/api/price-preview`;
  const requestBody = { upsell: descriptor.upsell, scenario: descriptor.body };
  try {
    const { response, text } = await withTimeout(async (signal) => {
      const responseValue = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Campaign-Key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
      const responseText = await readBoundedResponseText(responseValue, {
        maxBytes: limits.max_proxy_bytes,
        kind: "price_preview",
      });
      return { response: responseValue, text: responseText };
    }, limits.request_timeout_ms, "price_preview_timeout");
    let body = null;
    let parseError = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      parseError = error;
    }
    const bodyStatus = Number(body?.status);
    const status = Number.isInteger(bodyStatus) && bodyStatus >= 100 && bodyStatus <= 599
      ? bodyStatus
      : Number(response?.status || 500);
    return {
      envelope: {
        id: descriptor.id,
        status,
        response: body?.data ?? body ?? {},
        ...(present(body?.calculated_at) ? { calculated_at: body.calculated_at } : {}),
        request: { url, body: descriptor.body },
      },
      ok: response?.ok === true && body?.ok !== false && !parseError,
      ...(parseError ? { error_code: "price_preview_invalid_json", error: errorMessage(parseError) } : {}),
      ...(!response?.ok || body?.ok === false
        ? { error_code: `price_preview_status_${status}` }
        : {}),
    };
  } catch (error) {
    return {
      envelope: {
        id: descriptor.id,
        status: 599,
        response: {},
        request: { url, body: descriptor.body },
      },
      ok: false,
      error_code: error?.name === "AbortError" ? "price_preview_timeout" : (error?.code || "price_preview_fetch_error"),
      error: errorMessage(error),
    };
  }
}

export async function mapConcurrent(values, limit, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

// `currency` is the run's currency (`qa run --currency`): every calculate
// request asks for it instead of the Map's campaign currency.
export function planCommercialParity(spec, { maxScenarios = COMMERCIAL_QA_LIMITS.max_scenarios, currency = null } = {}) {
  const limit = positiveLimit(maxScenarios, COMMERCIAL_QA_LIMITS.max_scenarios);
  const pages = commercialSpecPages(spec, { maxPages: limit + 1 });
  const plan = [];
  let overflow = false;
  for (const page of pages) {
    const remaining = limit - plan.length;
    if (remaining <= 0) {
      overflow = true;
      break;
    }
    try {
      plan.push(...planScenarios(page, spec, { maxScenarios: remaining, currency }));
    } catch (error) {
      if (!(error instanceof CommercialJourneyLimitError)) throw error;
      overflow = true;
      break;
    }
  }
  return {
    pages,
    plan,
    overflow,
    observed_scenarios: overflow ? limit + 1 : plan.length,
  };
}

// A package recurs when the spec says so, or carries a recurring price and a
// cadence. Page rows override the campaign catalog per ref, as the journey does.
function isSubscriptionPackage(pkg) {
  return pkg?.is_recurring === true
    || (present(pkg?.price_recurring) && (present(pkg?.interval_count) || present(pkg?.interval)));
}

export function subscriptionPackageRefsByPage(spec, pages) {
  const packageRef = (pkg) => (present(pkg?.ref_id) ? String(pkg.ref_id) : present(pkg?.package_id) ? String(pkg.package_id) : null);
  const catalog = new Map(array(spec?.packages).map((pkg) => [packageRef(pkg), pkg]).filter(([ref]) => ref));
  const byPage = new Map();
  array(pages).forEach((page) => {
    if (!present(page?.id)) return;
    const refs = new Set();
    array(page.packages).forEach((pkg) => {
      const ref = packageRef(pkg);
      if (ref && isSubscriptionPackage({ ...(catalog.get(ref) || {}), ...pkg })) refs.add(ref);
    });
    if (refs.size) byPage.set(String(page.id), refs);
  });
  return byPage;
}

function countBy(values, keyFor) {
  const counts = {};
  values.forEach((value) => {
    const key = keyFor(value);
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function catalogImportedAt(spec) {
  return spec?.catalog_imported_at
    ?? spec?._provenance?.api?.imported_at
    ?? spec?._provenance?.api?.fetched_at
    ?? spec?.campaign?._provenance?.api?.imported_at
    ?? null;
}

function captureClaimCount(capture) {
  return bundlePriceClaimCount(capture)
    + packagePriceClaimCount(capture)
    + array(capture?.recurrence_claims).length
    + array(capture?.vouchers).length;
}

function captureIssues(captures) {
  const issues = [];
  array(captures).forEach((capture) => {
    array(capture?.extraction_errors).forEach((error) => {
      if (error?.type === "commercial_html_claims_limit") {
        issues.push({ code: "commercial_html_claims_limit" });
      }
    });
  });
  return issues;
}

// One reason a run's commercial proof stopped short: what was not compared and
// what to do about it, for an agent that reads only the exceptions list. Text
// only, never a key or a URL: it is persisted.
function cause(code, summary, fix, count = 1) {
  return { code, count, summary, fix };
}

// What each reason a package.price went uncompared means for the operator.
const PACKAGE_PRICE_CAUSES = Object.freeze({
  [PACKAGE_PRICE_NOT_RENDERED]: {
    summary: (count) => `${count} package.price claim(s) in the page source were not read from a rendered page, so they were not compared.`,
    fix: "Run qa run with --browser. If it did, check that the tested URL served this page; prices hidden on purpose need no repair.",
  },
  [PACKAGE_PRICE_NOT_FILLED]: {
    summary: (count) => `The SDK never filled ${count} visible package.price node(s), so a shopper may be reading the template's placeholder price.`,
    fix: "Check that the SDK loaded and that the package ref is on the campaign, then re-run qa run.",
  },
  [PACKAGE_PRICE_UNRESOLVED]: {
    summary: (count) => `${count} package.price claim(s) could not be tied to one calculated price: no package id around the node, no single exact row for the package on the page, or text that is not a money amount.`,
    fix: "Put data-next-package-id around the price, or check it by hand.",
  },
});

const OVER_LIMITS_FIX = "This funnel is over the check's limits, so no re-run will cover it: check these prices by hand and tell the operator.";

/**
 * The causes of an incomplete proof, the ones found while running first. Later
 * causes stay quiet when an earlier one explains them, so a missing key does not
 * also report every page as unpriced. Not every cause has a repair: a store
 * coupon or a run in another currency only says what was not compared.
 */
function incompleteCauses(stopped, commercial, journey) {
  const causes = [...stopped];
  // A page whose capture was refused also counts as missing from the comparison.
  const refused = new Set(array(commercial.invalid_captures).map((capture) => capture.page_id));
  const unread = [
    ...array(commercial.invalid_captures),
    ...array(commercial.missing_pages).filter((page) => !refused.has(page.page_id)),
  ];
  if (unread.length) {
    causes.push(cause(
      "commercial_pages_unread",
      `${unread.length} page(s) could not be read for commercial claims: ${unread.map((page) => page.page_id ?? "(no id)").join(", ")}.`,
      "Fix the page's fetch failure, its URL in the spec or its malformed markup, then re-run qa run. A page over the claim limit needs its prices checked by hand.",
      unread.length,
    ));
  }
  if (causes.length) return causes;

  const inexact = array(journey?.pages).filter((page) => page?.state !== PricingState.Exact);
  if (inexact.length) {
    const named = inexact.map((page) => `${page.page_id} (${page.reason || page.representative_total?.reason || page.state})`);
    return [cause(
      "commercial_page_not_exact",
      `Calculate gave no exact total for ${inexact.length} page(s): ${named.join(", ")}.`,
      "Correct the spec where the reason names it. A store coupon cannot be previewed, so check that page's prices by hand. Re-run qa run if the reason is Stale.",
      inexact.length,
    )];
  }
  if (present(commercial.unresolved_money_claims_reason)) {
    const count = commercial.unresolved_price_claims + commercial.unresolved_recurrence_claims;
    return [cause(
      String(commercial.unresolved_money_claims_reason),
      `${count} price claim(s) in the page source hold the Map currency's fallback text, so they were not compared with totals in the run currency.`,
      "No page repair is owed. A qa run in the campaign's own currency compares them.",
      count,
    )];
  }
  const packagePrices = Object.entries(commercial.package_price_claims?.unresolved || {});
  packagePrices.forEach(([code, count]) => {
    causes.push(cause(code, PACKAGE_PRICE_CAUSES[code].summary(count), PACKAGE_PRICE_CAUSES[code].fix, count));
  });
  const unresolvedPrices = commercial.unresolved_price_claims - packagePrices.reduce((sum, [, count]) => sum + count, 0);
  const unresolved = unresolvedPrices + commercial.unresolved_recurrence_claims + commercial.unresolved_voucher_claims;
  if (unresolved > 0) {
    causes.push(cause(
      "commercial_claims_unresolved",
      `${unresolved} claim(s) could not be tied to one calculated value (${unresolvedPrices} price, ${commercial.unresolved_recurrence_claims} recurring, ${commercial.unresolved_voucher_claims} voucher).`,
      "A page with more than one bound bundle price, or a voucher the plan cannot price, stays uncompared: check these by hand, or declare the voucher in the spec.",
      unresolved,
    ));
  }
  return causes;
}

/** One warn row per named cause: what `exceptions[]` carries and the sidecar keeps. */
function commercialIncompleteAssertions(reasons) {
  return array(reasons).map((entry) => ({
    id: `commercial-parity:incomplete:${entry.code}`,
    family: "pricing",
    page: "campaign",
    status: "warn",
    severity: "warn",
    expected: "the page's commercial claims compared with calculated totals",
    actual: `${entry.summary} Fix: ${entry.fix}`,
    evidence: {
      code: entry.code,
      count: entry.count,
    },
  }));
}

function compactReport(report, journey, plan, executed, issues, observedClaims, claimLimit, plannedScenarioCount = plan.length) {
  const exactPages = array(journey?.pages).filter((page) => page?.state === PricingState.Exact).length;
  const stalePages = array(journey?.pages).filter((page) => page?.state === PricingState.Stale).length;
  const proofComplete = report.coverage_complete
    && issues.length === 0
    && exactPages === array(journey?.pages).length;
  const status = plannedScenarioCount === 0 && issues.length === 0
    ? "not_applicable"
    : !proofComplete
      ? "incomplete"
      : report.findings.length
        ? "mismatch"
        : "pass";
  return {
    schema_version: COMMERCIAL_PARITY_SCHEMA_VERSION,
    status,
    coverage_complete: proofComplete,
    checked_pages: report.checked_pages,
    exact_pages: exactPages,
    stale_pages: stalePages,
    missing_page_count: report.missing_page_count,
    missing_pages: report.missing_pages,
    unmatched_page_count: report.unmatched_page_count,
    unmatched_pages: report.unmatched_pages,
    invalid_capture_count: report.invalid_capture_count,
    invalid_captures: report.invalid_captures,
    planned_scenarios: plannedScenarioCount,
    executed_scenarios: executed.filter((entry) => entry?.envelope).length,
    failed_scenarios: executed.filter((entry) => entry?.ok === false).length,
    extracted_price_claims: report.extracted_price_claims,
    compared_price_claims: report.compared_price_claims,
    unresolved_price_claims: report.unresolved_price_claims,
    package_price_claims: report.package_price_claims,
    extracted_recurrence_claims: report.extracted_recurrence_claims,
    compared_recurrence_claims: report.compared_recurrence_claims,
    unresolved_recurrence_claims: report.unresolved_recurrence_claims,
    extracted_voucher_claims: report.extracted_voucher_claims,
    compared_voucher_claims: report.compared_voucher_claims,
    unresolved_voucher_claims: report.unresolved_voucher_claims,
    ...(present(report.unresolved_money_claims_reason)
      ? { unresolved_money_claims_reason: report.unresolved_money_claims_reason }
      : {}),
    serialized_assertion_count: report.serialized_assertion_count,
    omitted_assertion_count: report.omitted_assertion_count,
    recurring_claim_absences: array(report.recurring_claim_absences),
    observed_claims: observedClaims,
    claim_limit: claimLimit,
    finding_count: report.findings.length,
    finding_counts: countBy(report.findings, (finding) => finding.type),
    findings: report.findings,
    issues: Object.entries(countBy(issues, (issue) => issue.code)).map(([code, count]) => ({ code, count })),
  };
}

function withScenarioOverflowPages(journey, plannedPages) {
  const normalizedPages = array(journey?.pages);
  const normalizedIds = new Set(normalizedPages.map((page) => String(page?.page_id)));
  const reason = "Unresolved: commercial scenario limit exceeded";
  const overflowPages = array(plannedPages)
    .filter((page) => present(page?.id) && !normalizedIds.has(String(page.id)))
    .map((page) => ({
      page_id: String(page.id),
      page_type: page?.type ?? null,
      page_label: page?.label ?? page?.name ?? page?.id ?? null,
      page_order: Number(page?.order) || 0,
      state: PricingState.Unresolved,
      reason,
      rows: [],
      offers: [],
      representative_total: { state: PricingState.Unresolved, reason },
      shipping: { present: false, state: PricingState.Unresolved, reason },
      bumps: [],
    }));
  if (!overflowPages.length) return journey;
  return {
    ...journey,
    state: PricingState.Unresolved,
    reason: journey?.reason || reason,
    pages: [...normalizedPages, ...overflowPages]
      .sort((left, right) => left.page_order - right.page_order),
  };
}

export function unavailableCommercialReport(code, { status = "not_run" } = {}) {
  return {
    schema_version: COMMERCIAL_PARITY_SCHEMA_VERSION,
    status,
    coverage_complete: false,
    checked_pages: 0,
    exact_pages: 0,
    stale_pages: 0,
    missing_page_count: 0,
    missing_pages: [],
    unmatched_page_count: 0,
    unmatched_pages: [],
    invalid_capture_count: 0,
    invalid_captures: [],
    planned_scenarios: 0,
    executed_scenarios: 0,
    failed_scenarios: 0,
    extracted_price_claims: 0,
    compared_price_claims: 0,
    unresolved_price_claims: 0,
    package_price_claims: { extracted: 0, compared: 0, unresolved: {} },
    extracted_recurrence_claims: 0,
    compared_recurrence_claims: 0,
    unresolved_recurrence_claims: 0,
    extracted_voucher_claims: 0,
    compared_voucher_claims: 0,
    unresolved_voucher_claims: 0,
    serialized_assertion_count: 0,
    omitted_assertion_count: 0,
    recurring_claim_absences: [],
    observed_claims: 0,
    claim_limit: COMMERCIAL_QA_LIMITS.max_aggregate_claims,
    finding_count: 0,
    finding_counts: {},
    findings: [],
    issues: [{ code, count: 1 }],
  };
}

/** What a crash in the check reports: the same warn row as any other stop. */
export function crashedCommercialResult() {
  const reason = cause(
    "commercial_runner_error",
    "The commercial parity check crashed before it finished, so no price was compared.",
    "Re-run qa run. If it crashes again, record it with findings add and tell the operator.",
  );
  return {
    assertions: commercialIncompleteAssertions([reason]),
    commercial: { ...unavailableCommercialReport(reason.code, { status: "incomplete" }), incomplete_reasons: [reason] },
  };
}

// One blocker row per currency the calculate endpoint answered in other than
// the run's: expected totals were asked for in `currency` and came back priced
// in another one. Answered codes are compared and named upper-cased, so `usd`
// and `USD` are one row. The rows are few (one per answered currency) and sit
// outside the assertion budget, so a full budget never hides the blocker.
function runCurrencyMismatchAssertions(journey, currency) {
  const requested = String(currency).toUpperCase();
  const answered = new Set();
  array(journey?.warnings).forEach((warning) => {
    if (warning?.type !== "currency_mismatch" || String(warning.requested).toUpperCase() !== requested) return;
    const actual = String(warning.actual).toUpperCase();
    if (actual !== requested) answered.add(actual);
  });
  return [...answered].map((actual) => ({
    id: `commercial-currency:${requested}:${encodeURIComponent(actual)}`,
    family: "pricing",
    page: "campaign",
    status: "fail",
    severity: "blocker",
    expected: `expected totals calculated in the run currency ${requested}`,
    actual: `the calculate endpoint priced in ${actual}`,
    evidence: { code: "currency_mismatch", requested, actual },
  }));
}

/**
 * Run the portable commercial planner against the public proxy contract and
 * serialize proven mismatches into ordinary QA assertions.
 */
export async function runCommercialParity({
  resolved,
  captures = [],
  fetchImpl = globalThis.fetch,
  limits: limitOverrides = {},
  planning = null,
  maxAssertions = Number.POSITIVE_INFINITY,
  currency = null,
} = {}) {
  const limits = {
    ...COMMERCIAL_QA_LIMITS,
    ...Object.fromEntries(Object.entries(limitOverrides).map(([key, value]) => [
      key,
      positiveLimit(value, COMMERCIAL_QA_LIMITS[key]),
    ])),
  };
  const planningSpec = resolved?.rawSpec || resolved?.spec || {};
  const commercialPlanning = planning || planCommercialParity(planningSpec, {
    maxScenarios: limits.max_scenarios,
    currency,
  });
  const plan = commercialPlanning.plan;
  const scenarioOverflow = commercialPlanning.overflow || plan.length > limits.max_scenarios;
  const observedClaims = array(captures).reduce((sum, capture) => sum + captureClaimCount(capture), 0);
  const aggregateClaimOverflow = observedClaims > limits.max_aggregate_claims;
  const orderedPreflightIssues = [
    { exceeded: aggregateClaimOverflow, code: "commercial_aggregate_claim_limit", summary: `The funnel carries ${observedClaims} commercial claims, over the limit of ${limits.max_aggregate_claims}, so none were compared.` },
    { exceeded: scenarioOverflow, code: "commercial_scenario_limit", summary: "The funnel plans more calculate scenarios than the limit, so none ran." },
  ].filter((issue) => issue.exceeded);
  const issues = [
    ...captureIssues(captures),
    ...orderedPreflightIssues.map(({ code }) => ({ code })),
  ];
  // Why calculate did not give this run its answers, said where it is found.
  const stopped = orderedPreflightIssues.map(({ code, summary }) => cause(code, summary, OVER_LIMITS_FIX));
  const apiKeyResolution = resolveCommercialApiKey(resolved);
  const apiKey = apiKeyResolution.value;
  let executed = [];

  if (aggregateClaimOverflow || scenarioOverflow) {
    // Do not execute or compare a partial claim/scenario set. Independent
    // preflight issues above remain visible when multiple ceilings are hit.
  } else if (apiKeyResolution.unsupported) {
    issues.push({ code: "unsupported_campaigns_api_key_source" });
    stopped.push(cause(
      "unsupported_campaigns_api_key_source",
      `The packet's campaign.api_key_source names an environment variable QA refuses to read, so 0 of ${plan.length} planned calculate scenarios ran.`,
      "Use env:CAMPAIGNS_API_KEY, or set campaign.campaigns_api_key in the CampaignSpec, then re-run qa run.",
    ));
  } else if (plan.some((descriptor) => !descriptor?.unresolved) && !present(apiKey)) {
    issues.push({ code: "missing_campaigns_api_key" });
    stopped.push(cause(
      "missing_campaigns_api_key",
      `No campaign key was resolved, so 0 of ${plan.length} planned calculate scenarios ran and no price was compared.`,
      "Set campaign.campaigns_api_key in the CampaignSpec (or the Build Packet) to the campaign's API key, then re-run qa run.",
    ));
  } else if (typeof fetchImpl !== "function") {
    issues.push({ code: "price_preview_fetch_unavailable" });
  } else {
    const executable = plan.filter((descriptor) => !descriptor?.unresolved);
    executed = await mapConcurrent(executable, limits.concurrency, (descriptor) => previewDescriptor(descriptor, {
      proxyBase: resolved?.proxyBase,
      apiKey: String(apiKey || ""),
      fetchImpl,
      limits,
    }));
    const failures = executed.filter((entry) => entry?.ok === false)
      .map((entry) => entry.error_code || "price_preview_failed");
    failures.forEach((code) => issues.push({ code }));
    if (failures.length) {
      stopped.push(cause(
        "price_preview_failed",
        `The calculate endpoint failed for ${failures.length} of ${plan.length} planned scenarios (${[...new Set(failures)].join(", ")}).`,
        "Check that the key belongs to this campaign and that the proxy is reachable, then re-run qa run.",
        failures.length,
      ));
    }
  }

  const journey = normalizeJourney(
    plan,
    executed.map((entry) => entry.envelope),
    resolved?.rawSpec || resolved?.spec || {},
    {
      spec_hash: specHashOf(resolved?.rawSpec || resolved?.spec),
      catalog_imported_at: catalogImportedAt(resolved?.rawSpec || resolved?.spec),
    },
  );
  const parityJourney = scenarioOverflow
    ? withScenarioOverflowPages(journey, commercialPlanning.pages)
    : journey;
  // Under a run currency, a calculate response in another currency means the
  // campaign does not price in it: a blocker, and the comparison below is
  // against totals in the wrong currency, so the proof is incomplete. Without
  // one, the journey's currency_mismatch warning stays where it is.
  const currencyAssertions = present(currency) ? runCurrencyMismatchAssertions(journey, currency) : [];
  currencyAssertions.forEach(() => issues.push({ code: "calculate_currency_mismatch" }));
  // Captures read the page's source HTML, whose bound prices are the authored
  // fallback text in the Map's campaign currency (the SDK replaces them at
  // runtime). Under a run currency the Map does not name, those amounts cannot
  // be compared with totals in the run currency: they stay unresolved, with
  // the reason recorded, instead of reading as mismatches.
  const sourceCurrency = planningSpec?.campaign?.currency ?? planningSpec?.currency;
  const sourceNotInRunCurrency = present(currency)
    && String(sourceCurrency ?? "").toUpperCase() !== String(currency).toUpperCase();
  const parity = createCommercialParityReport(captures, parityJourney, {
    maxAssertions,
    countsOnly: aggregateClaimOverflow,
    ...(sourceNotInRunCurrency ? { unresolvedMoneyClaims: "static_source_not_in_run_currency" } : {}),
  });
  // Subscription packages a page renders with no recurring claim read for
  // them: incomplete evidence (an issue), and a warning naming the package.
  const absences = aggregateClaimOverflow
    ? []
    : recurringClaimAbsences(captures, subscriptionPackageRefsByPage(planningSpec, commercialPlanning.pages));
  absences.forEach(() => issues.push({ code: "recurring_claim_absent" }));
  const absentAssertions = recurringClaimAbsentAssertions(absences, {
    maxAssertions: Math.max(0, maxAssertions - parity.assertions.length),
  });
  parity.recurring_claim_absences = absences;
  const commercial = compactReport(
    parity,
    parityJourney,
    plan,
    executed,
    issues,
    observedClaims,
    limits.max_aggregate_claims,
    commercialPlanning.observed_scenarios ?? plan.length,
  );
  const assertions = [...currencyAssertions, ...parity.assertions, ...absentAssertions];
  if (commercial.status !== "incomplete") return { assertions, commercial };
  // An incomplete run always names a cause in the exceptions list. A currency
  // blocker or an absent rebill claim already wrote its own row.
  const reasons = incompleteCauses(stopped, commercial, parityJourney);
  if (!reasons.length && !currencyAssertions.length && !absentAssertions.length) {
    reasons.push(cause(
      "commercial_coverage_incomplete",
      `Commercial parity stopped short: issues ${array(commercial.issues).map((issue) => issue.code).join(", ") || "none"}.`,
      "Read verdict.commercial for what was and was not compared, and tell the operator.",
    ));
  }
  return {
    assertions: [...assertions, ...commercialIncompleteAssertions(reasons)],
    commercial: { ...commercial, incomplete_reasons: reasons },
  };
}
