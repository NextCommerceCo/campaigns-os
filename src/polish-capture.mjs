import { createHash } from "node:crypto";

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedToken(value) {
  return normalizeString(value)?.toLocaleLowerCase("en-US") || "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const POLISH_ROUTE_CAPTURE_SCHEMA_VERSION = "campaigns-os-polish-route-capture/v0";
export const POLISH_CAPTURE_PRODUCER = "campaigns-os polish capture";
export const MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES = 2_048;
export const POLISH_RESOURCE_TYPES = Object.freeze([
  "cspviolationreport",
  "document",
  "eventsource",
  "fetch",
  "font",
  "image",
  "manifest",
  "media",
  "other",
  "ping",
  "prefetch",
  "preflight",
  "script",
  "signedexchange",
  "stylesheet",
  "texttrack",
  "unknown",
  "websocket",
  "xhr",
]);
export const POLISH_PRELOAD_ATTRIBUTES = Object.freeze([
  "auto",
  "empty",
  "metadata",
  "missing",
  "none",
  "other",
]);

const KNOWN_RESOURCE_TYPES = new Set(POLISH_RESOURCE_TYPES.filter((value) => value !== "unknown"));

function resolvedCaptureUrl(value, { baseUrl } = {}) {
  const text = normalizeString(value);
  if (!text) return { status: "empty", canonical: null, projected: null, origin: null };
  try {
    const url = baseUrl ? new URL(text, baseUrl) : new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { status: "non_http", canonical: null, projected: "[non-http-url]", origin: null };
    }
    url.hash = "";
    url.username = "";
    url.password = "";
    return {
      status: "http",
      canonical: url.href,
      projected: `${url.origin}${url.pathname}`,
      origin: url.origin,
    };
  } catch {
    return { status: "malformed", canonical: null, projected: "[malformed-url]", origin: null };
  }
}

export function redactCaptureUrl(value, { baseUrl } = {}) {
  return resolvedCaptureUrl(value, { baseUrl }).projected;
}

function resourceId(canonicalUrl) {
  return `sha256:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
}

function resolvedResource(value, { baseUrl } = {}) {
  const resolved = resolvedCaptureUrl(value, { baseUrl });
  return {
    ...resolved,
    resource_id: resolved.canonical ? resourceId(resolved.canonical) : null,
  };
}

function validComputedStyle(style) {
  return isPlainObject(style)
    && typeof style.display === "string"
    && style.display.trim() !== ""
    && typeof style.visibility === "string"
    && style.visibility.trim() !== "";
}

function addProblemCount(problemCounts, code, count = 1) {
  if (!Number.isInteger(count) || count <= 0) return;
  problemCounts.set(code, (problemCounts.get(code) || 0) + count);
}

function projectedProblems(problemCounts) {
  return [...problemCounts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function normalizeResourceType(value) {
  const token = normalizedToken(value);
  return KNOWN_RESOURCE_TYPES.has(token)
    ? { value: token, status: "known" }
    : { value: "unknown", status: "unknown" };
}

function genericCacheFlag(record) {
  return Boolean(record?.from_cache
    || record?.from_disk_cache
    || record?.from_memory_cache
    || record?.from_prefetch_cache
    || record?.request_served_from_cache
    || record?.served_from_cache);
}

function privateRecordSortKey(record, documentUrl) {
  const resolved = resolvedCaptureUrl(record?.url, { baseUrl: documentUrl });
  const aliases = Array.isArray(record?.source_urls)
    ? record.source_urls.map((value) => resolvedCaptureUrl(value, { baseUrl: documentUrl }).canonical).sort()
    : record?.source_urls == null ? [] : ["[invalid-aliases]"];
  return JSON.stringify([
    resolved.canonical,
    normalizedToken(record?.resource_type),
    Number.isInteger(record?.status) ? record.status : null,
    Number.isInteger(record?.encoded_data_length) ? record.encoded_data_length : null,
    Number.isInteger(record?.redirect_hop) ? record.redirect_hop : null,
    aliases,
    genericCacheFlag(record),
    Boolean(record?.from_service_worker),
    Boolean(record?.failed),
  ]);
}

function flattenResponseRecords(responses, problemCounts) {
  const flattened = [];
  for (const record of (Array.isArray(responses) ? responses : [])) {
    if (Array.isArray(record?.redirect_chain)) {
      if (record.redirect_chain.length === 0) {
        addProblemCount(problemCounts, "request_identity_invalid");
        continue;
      }
      record.redirect_chain.forEach((hop, redirectHop) => {
        flattened.push({
          ...record,
          ...(isPlainObject(hop) ? hop : {}),
          redirect_chain: undefined,
          redirect_hop: Number.isInteger(hop?.redirect_hop) ? hop.redirect_hop : redirectHop,
        });
      });
    } else {
      flattened.push(record);
    }
  }
  return flattened;
}

function prepareResponseRecords(responses, { documentUrl, problemCounts }) {
  const flattened = flattenResponseRecords(responses, problemCounts);
  const invalidIdentity = [];
  const byRequestId = new Map();
  for (const record of flattened) {
    const requestId = normalizeString(record?.request_id);
    if (!requestId) {
      addProblemCount(problemCounts, "request_identity_invalid");
      invalidIdentity.push({ record, chain: [record] });
      continue;
    }
    const group = byRequestId.get(requestId) || [];
    group.push(record);
    byRequestId.set(requestId, group);
  }

  const prepared = [...invalidIdentity];
  for (const group of byRequestId.values()) {
    if (group.length === 1) {
      prepared.push({ record: group[0], chain: group });
      continue;
    }
    const hops = group.map((record) => record?.redirect_hop);
    const validRedirectChain = hops.every((hop) => Number.isInteger(hop) && hop >= 0)
      && new Set(hops).size === hops.length;
    if (validRedirectChain) {
      const chain = [...group].sort((a, b) => a.redirect_hop - b.redirect_hop
        || privateRecordSortKey(a, documentUrl).localeCompare(privateRecordSortKey(b, documentUrl)));
      for (const record of chain) prepared.push({ record, chain });
      continue;
    }
    addProblemCount(problemCounts, "duplicate_request_identity", group.length - 1);
    const selected = [...group]
      .sort((a, b) => privateRecordSortKey(a, documentUrl).localeCompare(privateRecordSortKey(b, documentUrl)))[0];
    prepared.push({ record: selected, chain: [selected] });
  }
  return prepared;
}

function resourceLedgerSort(a, b) {
  return a.url.localeCompare(b.url) || a.resource_id.localeCompare(b.resource_id);
}

function largestResourceProjection(resources) {
  const largest = [...resources].sort((a, b) => b.transferred_bytes - a.transferred_bytes
    || a.url.localeCompare(b.url)
    || a.resource_id.localeCompare(b.resource_id))[0];
  return largest ? {
    resource_id: largest.resource_id,
    url: largest.url,
    resource_type: largest.resource_type,
    transferred_bytes: largest.transferred_bytes,
    request_count: largest.request_count,
  } : null;
}

export function aggregateCdpResponses(responses, { documentUrl } = {}) {
  const problemCounts = new Map();
  const documentOrigin = resolvedCaptureUrl(documentUrl).origin;
  const groups = new Map();
  let unattributedRequestCount = 0;
  const prepared = prepareResponseRecords(responses, { documentUrl, problemCounts });

  for (const { record, chain } of prepared) {
    const resolved = resolvedResource(record?.url, { baseUrl: documentUrl });
    if (resolved.status !== "http") {
      addProblemCount(problemCounts, "resource_url_unresolvable");
      unattributedRequestCount += 1;
      continue;
    }
    const transferredBytes = record?.encoded_data_length;
    const resourceType = normalizeResourceType(record?.resource_type);
    const cacheObserved = genericCacheFlag(record);
    const fromServiceWorker = Boolean(record?.from_service_worker);
    const failed = Boolean(record?.failed);
    const crossOrigin = Boolean(documentOrigin && resolved.origin !== documentOrigin);
    const sourceUrls = record?.source_urls == null ? [] : record.source_urls;
    if (!Array.isArray(sourceUrls)) addProblemCount(problemCounts, "resource_aliases_invalid");

    const matchResources = [resolved];
    for (const alias of (Array.isArray(sourceUrls) ? sourceUrls : [])) {
      const aliasResource = resolvedResource(alias, { baseUrl: documentUrl });
      if (aliasResource.status !== "http") addProblemCount(problemCounts, "resource_aliases_invalid");
      else matchResources.push(aliasResource);
    }
    for (const hop of chain) {
      const hopResource = resolvedResource(hop?.url, { baseUrl: documentUrl });
      if (hopResource.status === "http") matchResources.push(hopResource);
    }

    if (cacheObserved) addProblemCount(problemCounts, "cache_observed");
    if (fromServiceWorker) addProblemCount(problemCounts, "service_worker_observed");
    if (failed) addProblemCount(problemCounts, "request_failed");
    const transferMeasured = Number.isInteger(transferredBytes) && transferredBytes >= 0;
    if (!transferMeasured) addProblemCount(problemCounts, "transfer_size_unavailable");

    const group = groups.get(resolved.resource_id) || {
      resource_id: resolved.resource_id,
      url: resolved.projected,
      resource_type: resourceType.value,
      resource_type_status: resourceType.status,
      observed_resource_types: new Set(),
      transferred_bytes: 0,
      request_count: 0,
      unmeasured_request_count: 0,
      failed_request_count: 0,
      statuses: new Set(),
      partial_request_count: 0,
      cross_origin_request_count: 0,
      cache_request_count: 0,
      service_worker_request_count: 0,
      match_resource_ids: new Set([resolved.resource_id]),
    };
    group.observed_resource_types.add(resourceType.value);
    if (resourceType.status === "unknown") group.resource_type_status = "unknown";
    if (transferMeasured) group.transferred_bytes += transferredBytes;
    else group.unmeasured_request_count += 1;
    group.request_count += 1;
    if (failed) group.failed_request_count += 1;
    if (Number.isInteger(record?.status)) group.statuses.add(record.status);
    if (record?.status === 206) group.partial_request_count += 1;
    if (crossOrigin) group.cross_origin_request_count += 1;
    if (cacheObserved) group.cache_request_count += 1;
    if (fromServiceWorker) group.service_worker_request_count += 1;
    for (const match of matchResources) group.match_resource_ids.add(match.resource_id);
    groups.set(resolved.resource_id, group);
  }

  const allResources = [...groups.values()].map((group) => {
    const observedTypes = [...group.observed_resource_types];
    if (observedTypes.length > 1) {
      group.resource_type = "unknown";
      group.resource_type_status = "ambiguous";
      addProblemCount(problemCounts, "resource_type_ambiguous");
    } else if (group.resource_type_status === "unknown") {
      group.resource_type = "unknown";
      addProblemCount(problemCounts, "resource_type_unknown");
    }
    const { observed_resource_types: ignored, statuses, match_resource_ids: matchIds, ...projection } = group;
    return {
      ...projection,
      statuses: [...statuses].sort((a, b) => a - b),
      match_resource_ids: [...matchIds].sort(),
    };
  }).sort(resourceLedgerSort);

  const resources = allResources.slice(0, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES);
  const omittedResources = allResources.slice(MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES);
  if (omittedResources.length) {
    addProblemCount(problemCounts, "resource_ledger_overflow", omittedResources.length);
  }
  const sum = (field) => resources.reduce((total, resource) => total + resource[field], 0);
  const problems = projectedProblems(problemCounts);

  return {
    measurement_status: problems.length ? "incomplete" : "complete",
    observed_response_count: prepared.length,
    unattributed_request_count: unattributedRequestCount,
    total_transferred_bytes: sum("transferred_bytes"),
    request_count: sum("request_count"),
    cross_origin_request_count: sum("cross_origin_request_count"),
    cache_request_count: sum("cache_request_count"),
    service_worker_request_count: sum("service_worker_request_count"),
    resources,
    resource_ledger: {
      limit: MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
      total_resource_count: allResources.length,
      omitted_resource_count: omittedResources.length,
      omitted_request_count: omittedResources.reduce((sum, resource) => sum + resource.request_count, 0),
    },
    largest_resource: largestResourceProjection(resources),
    problems,
  };
}

function normalizedPreloadAttribute(value) {
  if (value === null) return "missing";
  const token = normalizedToken(value);
  if (!token) return "empty";
  return token === "auto" || token === "metadata" || token === "none" ? token : "other";
}

function sourceReference(value, sourceKind, sourceIndex, documentUrl) {
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  const resolved = resolvedResource(value, { baseUrl: documentUrl });
  return {
    source_kind: sourceKind,
    source_index: sourceIndex,
    url: resolved.projected,
    resource_id: resolved.resource_id,
  };
}

function sourceReferenceSort(a, b) {
  const ranks = { current_src: 0, src_attribute: 1, source_src_attribute: 2 };
  return ranks[a.source_kind] - ranks[b.source_kind]
    || a.source_index - b.source_index
    || String(a.resource_id).localeCompare(String(b.resource_id));
}

export function normalizeMediaElement(element, { documentUrl, elementIndex = 0 } = {}) {
  const tagName = normalizedToken(element?.tag_name);
  if (tagName !== "video" && tagName !== "audio") {
    throw new Error("Page-load media capture accepts only video or audio elements.");
  }
  if (!Number.isInteger(elementIndex) || elementIndex < 0
    || !Object.hasOwn(element, "current_src")
    || (element.current_src !== null && typeof element.current_src !== "string")
    || !Object.hasOwn(element, "src_attribute")
    || (element.src_attribute !== null && typeof element.src_attribute !== "string")
    || !Array.isArray(element.source_src_attributes)
    || element.source_src_attributes.some((source) => typeof source !== "string")
    || !Object.hasOwn(element, "preload_attribute")
    || (element.preload_attribute !== null && typeof element.preload_attribute !== "string")
    || !validComputedStyle(element.computed_style)
    || !Array.isArray(element.ancestor_styles)
    || element.ancestor_styles.some((style) => !validComputedStyle(style))) {
    throw new Error("Page-load media capture needs complete source and computed-style measurements.");
  }

  const styles = [element.computed_style, ...element.ancestor_styles];
  const hiddenBy = new Set();
  for (const style of styles) {
    if (normalizedToken(style.display) === "none") hiddenBy.add("display_none");
    if (normalizedToken(style.visibility) === "hidden") hiddenBy.add("visibility_hidden");
  }
  const currentSrc = sourceReference(element.current_src, "current_src", 0, documentUrl);
  const srcAttribute = sourceReference(element.src_attribute, "src_attribute", 0, documentUrl);
  const sourceSrcAttributes = element.source_src_attributes
    .map((source, index) => sourceReference(source, "source_src_attribute", index, documentUrl));
  const sourceReferences = [currentSrc, srcAttribute, ...sourceSrcAttributes]
    .filter(Boolean)
    .sort(sourceReferenceSort);
  const preloadAttribute = normalizedPreloadAttribute(element.preload_attribute);
  const width = Number(element?.bounding_box?.width);
  const height = Number(element?.bounding_box?.height);

  return {
    tag_name: tagName,
    element_index: elementIndex,
    current_src: currentSrc?.url || null,
    src_attribute: srcAttribute?.url || null,
    source_src_attributes: sourceSrcAttributes.map((source) => source?.url || null),
    source_references: sourceReferences,
    preload_attribute: preloadAttribute,
    preload_defers_fetch: preloadAttribute === "none" || preloadAttribute === "metadata",
    hidden_at_load: hiddenBy.size > 0,
    hidden_by: [...hiddenBy].sort(),
    zero_size_at_load: Number.isFinite(width) && Number.isFinite(height) ? (width <= 0 || height <= 0) : null,
  };
}

export function normalizePageLoadRoute(value) {
  const text = normalizeString(value);
  if (!text) return null;
  try {
    const url = new URL(text, "https://capture.invalid/");
    return url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
  } catch {
    return null;
  }
}

function normalizedNetworkidle(value) {
  const status = normalizedToken(value?.status);
  const durationMs = value?.duration_ms;
  if ((status !== "settled" && status !== "timeout")
    || !Number.isInteger(durationMs)
    || durationMs < 0) return { status: "invalid", duration_ms: null };
  return { status, duration_ms: durationMs };
}

function normalizedViewport(value) {
  const token = normalizeString(value)?.toLocaleLowerCase("en-US") || null;
  return token && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(token) ? token : null;
}

function normalizedBuildFingerprint(value) {
  const fingerprint = normalizeString(value);
  return fingerprint && /^sha256:[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

function normalizedCampaignSlug(value) {
  const slug = normalizeString(value);
  return slug && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug) ? slug : null;
}

function captureSubject({ buildFingerprint, slug, requestedRoute, finalDocumentUrl, viewport }) {
  return {
    build_fingerprint: normalizedBuildFingerprint(buildFingerprint),
    campaign_slug: normalizedCampaignSlug(slug),
    requested_route: normalizePageLoadRoute(requestedRoute),
    final_document_route: resolvedCaptureUrl(finalDocumentUrl).status === "http"
      ? normalizePageLoadRoute(finalDocumentUrl)
      : null,
    viewport: normalizedViewport(viewport),
  };
}

function mediaFetchedResources(media, resources) {
  const sourceIds = new Set(media.source_references
    .map((reference) => reference.resource_id)
    .filter(Boolean));
  return resources.flatMap((resource) => {
    const matchedSourceIds = resource.match_resource_ids.filter((id) => sourceIds.has(id));
    if (!matchedSourceIds.length) return [];
    return [{
      resource_id: resource.resource_id,
      url: resource.url,
      resource_type: resource.resource_type,
      transferred_bytes: resource.transferred_bytes,
      request_count: resource.request_count,
      matched_source_resource_ids: matchedSourceIds.sort(),
    }];
  }).sort((a, b) => a.url.localeCompare(b.url) || a.resource_id.localeCompare(b.resource_id));
}

export function buildPageLoadCapture({
  buildFingerprint,
  slug,
  requestedRoute,
  viewport,
  finalDocumentUrl,
  responseCollectionStatus,
  networkidle,
  mediaElements,
  responses,
  producerError,
} = {}) {
  const network = aggregateCdpResponses(responses, { documentUrl: finalDocumentUrl });
  const problemCounts = new Map(network.problems.map(({ code, count }) => [code, count]));
  const addCaptureProblem = (code, count = 1) => addProblemCount(problemCounts, code, count);
  const subject = captureSubject({ buildFingerprint, slug, requestedRoute, finalDocumentUrl, viewport });
  if (Object.values(subject).some((value) => value === null)) addCaptureProblem("capture_subject_invalid");
  if (subject.requested_route && subject.final_document_route
    && subject.requested_route !== subject.final_document_route) {
    addCaptureProblem("final_document_route_mismatch");
  }
  if (!Array.isArray(mediaElements)) addCaptureProblem("media_collection_unavailable");
  if (!Array.isArray(responses)) addCaptureProblem("response_collection_unavailable");
  const collectionStatus = normalizedToken(responseCollectionStatus);
  if (collectionStatus === "failed") addCaptureProblem("response_collection_failed");
  else if (collectionStatus !== "complete") addCaptureProblem("response_collection_status_invalid");
  if (collectionStatus === "complete" && Array.isArray(responses) && network.observed_response_count === 0) {
    addCaptureProblem("response_collection_empty");
  }
  if (producerError) addCaptureProblem("producer_failed");

  const media = [];
  let failedMediaElementCount = 0;
  for (const [elementIndex, element] of (Array.isArray(mediaElements) ? mediaElements : []).entries()) {
    try {
      const normalized = normalizeMediaElement(element, { documentUrl: finalDocumentUrl, elementIndex });
      if (normalized.hidden_at_load
        && !normalized.preload_defers_fetch
        && normalized.source_references.some((reference) => reference.resource_id === null)) {
        addCaptureProblem("media_source_unresolvable");
      }
      const fetchedResources = mediaFetchedResources(normalized, network.resources);
      media.push({
        ...normalized,
        fetched_bytes: fetchedResources.reduce((sum, resource) => sum + resource.transferred_bytes, 0),
        fetched_request_count: fetchedResources.reduce((sum, resource) => sum + resource.request_count, 0),
        fetched_resources: fetchedResources,
      });
    } catch {
      failedMediaElementCount += 1;
      addCaptureProblem("media_measurement_failed");
    }
  }
  const settled = normalizedNetworkidle(networkidle);
  if (settled.status === "invalid") addCaptureProblem("networkidle_measurement_invalid");
  const problems = projectedProblems(problemCounts);

  return {
    schema_version: POLISH_ROUTE_CAPTURE_SCHEMA_VERSION,
    performed_by: POLISH_CAPTURE_PRODUCER,
    subject,
    measurement_status: problems.length ? "incomplete" : "complete",
    producer_status: producerError ? "failed" : "complete",
    response_collection: {
      status: collectionStatus === "complete" || collectionStatus === "failed" ? collectionStatus : "invalid",
      observed_response_count: network.observed_response_count,
      unattributed_response_count: network.unattributed_request_count,
    },
    media_collection: {
      status: !Array.isArray(mediaElements) ? "failed" : failedMediaElementCount ? "partial" : "complete",
      observed_element_count: Array.isArray(mediaElements) ? mediaElements.length : 0,
      failed_element_count: failedMediaElementCount,
    },
    networkidle: settled,
    resource_ledger: {
      ...network.resource_ledger,
      entries: network.resources,
    },
    metrics: {
      total_transferred_bytes: network.total_transferred_bytes,
      request_count: network.request_count,
      largest_resource: network.largest_resource,
      cross_origin_request_count: network.cross_origin_request_count,
      cache_request_count: network.cache_request_count,
      service_worker_request_count: network.service_worker_request_count,
    },
    media,
    problems,
  };
}
