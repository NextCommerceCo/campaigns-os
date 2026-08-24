import {
  CommercialJourneyLimitError,
  PricingState,
  normalizeJourney,
  planScenarios,
} from "./commercial-journey.mjs";
import {
  COMMERCIAL_PARITY_SCHEMA_VERSION,
  CommercialParityLimitError,
  createCommercialParityReport,
  extractCommercialClaims,
} from "./commercial-parity.mjs";

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

export function commercialPageIds(spec, options = {}) {
  return new Set(commercialSpecPages(spec, options).filter((page) => present(page?.id)).map((page) => String(page.id)));
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
    return extractCommercialClaims(html, {
      pageId: present(page?.page_id) ? String(page.page_id) : null,
      url: page?.url,
    });
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

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
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

  const load = async (page) => {
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
        const htmlBytes = new TextEncoder().encode(html).byteLength;
        if (retainedBytes + htmlBytes > maxAggregateBytes) {
          aggregateLimitReached = true;
          return {
            ok: false,
            error_code: "page_html_aggregate_limit",
            error: `Retained page HTML would exceed the ${maxAggregateBytes}-byte run limit.`,
          };
        }
        retainedBytes += htmlBytes;
        return {
          ok: true,
          status: response.status,
          status_text: response.statusText || "",
          html,
        };
      }, timeoutMs);
    } catch (error) {
      return {
        ok: false,
        error_code: error?.code || (error?.name === "AbortError" ? "page_fetch_timeout" : "page_fetch_error"),
        error: errorMessage(error),
      };
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
    }, limits.request_timeout_ms);
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
      error_code: error?.code || (error?.name === "AbortError" ? "price_preview_timeout" : "price_preview_fetch_error"),
      error: errorMessage(error),
    };
  }
}

async function mapConcurrent(values, limit, operation) {
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

export function planCommercialParity(spec, { maxScenarios = COMMERCIAL_QA_LIMITS.max_scenarios } = {}) {
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
      plan.push(...planScenarios(page, spec, { maxScenarios: remaining }));
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
  return array(capture?.price_claims).length
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

function journeySpecHash(spec) {
  return spec?.spec_hash ?? spec?.spec_identity?.spec_hash ?? null;
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
    extracted_recurrence_claims: report.extracted_recurrence_claims,
    compared_recurrence_claims: report.compared_recurrence_claims,
    unresolved_recurrence_claims: report.unresolved_recurrence_claims,
    extracted_voucher_claims: report.extracted_voucher_claims,
    compared_voucher_claims: report.compared_voucher_claims,
    unresolved_voucher_claims: report.unresolved_voucher_claims,
    serialized_assertion_count: report.serialized_assertion_count,
    omitted_assertion_count: report.omitted_assertion_count,
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
    extracted_recurrence_claims: 0,
    compared_recurrence_claims: 0,
    unresolved_recurrence_claims: 0,
    extracted_voucher_claims: 0,
    compared_voucher_claims: 0,
    unresolved_voucher_claims: 0,
    serialized_assertion_count: 0,
    omitted_assertion_count: 0,
    observed_claims: 0,
    claim_limit: COMMERCIAL_QA_LIMITS.max_aggregate_claims,
    finding_count: 0,
    finding_counts: {},
    findings: [],
    issues: [{ code, count: 1 }],
  };
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
  });
  const plan = commercialPlanning.plan;
  const scenarioOverflow = commercialPlanning.overflow || plan.length > limits.max_scenarios;
  const observedClaims = array(captures).reduce((sum, capture) => sum + captureClaimCount(capture), 0);
  const aggregateClaimOverflow = observedClaims > limits.max_aggregate_claims;
  const issues = captureIssues(captures);
  if (aggregateClaimOverflow) issues.push({ code: "commercial_aggregate_claim_limit" });
  if (scenarioOverflow) issues.push({ code: "commercial_scenario_limit" });
  const apiKeyResolution = resolveCommercialApiKey(resolved);
  const apiKey = apiKeyResolution.value;
  let executed = [];

  if (aggregateClaimOverflow || scenarioOverflow) {
    // Do not execute or compare a partial claim/scenario set. Independent
    // preflight issues above remain visible when multiple ceilings are hit.
  } else if (apiKeyResolution.unsupported) {
    issues.push({ code: "unsupported_campaigns_api_key_source" });
  } else if (plan.some((descriptor) => !descriptor?.unresolved) && !present(apiKey)) {
    issues.push({ code: "missing_campaigns_api_key" });
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
    executed.filter((entry) => entry?.ok === false).forEach((entry) => {
      issues.push({ code: entry.error_code || "price_preview_failed" });
    });
  }

  const journey = normalizeJourney(
    plan,
    executed.map((entry) => entry.envelope),
    resolved?.rawSpec || resolved?.spec || {},
    {
      spec_hash: journeySpecHash(resolved?.rawSpec || resolved?.spec),
      catalog_imported_at: catalogImportedAt(resolved?.rawSpec || resolved?.spec),
    },
  );
  const parityJourney = scenarioOverflow
    ? withScenarioOverflowPages(journey, commercialPlanning.pages)
    : journey;
  const parity = createCommercialParityReport(captures, parityJourney, {
    maxAssertions,
    countsOnly: aggregateClaimOverflow,
  });
  return {
    assertions: parity.assertions,
    commercial: compactReport(
      parity,
      parityJourney,
      plan,
      executed,
      issues,
      observedClaims,
      limits.max_aggregate_claims,
      commercialPlanning.observed_scenarios ?? plan.length,
    ),
  };
}
