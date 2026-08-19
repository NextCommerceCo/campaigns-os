function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const POLISH_ROUTE_CAPTURE_SCHEMA_VERSION = "campaigns-os-polish-route-capture/v0";
export const POLISH_CAPTURE_PRODUCER = "campaigns-os polish capture";

export function redactCaptureUrl(value, { baseUrl } = {}) {
  const text = normalizeString(value);
  if (!text) return null;
  try {
    const url = baseUrl ? new URL(text, baseUrl) : new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[non-http-url]";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[malformed-url]";
  }
}

function normalizedStyleValue(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validComputedStyle(style) {
  return isPlainObject(style)
    && typeof style.display === "string"
    && style.display.trim() !== ""
    && typeof style.visibility === "string"
    && style.visibility.trim() !== "";
}

function urlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function aggregateCdpResponses(responses, { documentUrl } = {}) {
  const records = Array.isArray(responses) ? responses : [];
  const documentOrigin = urlOrigin(documentUrl);
  const groups = new Map();
  let totalTransferredBytes = 0;
  let crossOriginRequestCount = 0;
  const problemCounts = new Map();
  const addProblem = (code) => problemCounts.set(code, (problemCounts.get(code) || 0) + 1);
  const seenRequestIds = new Set();

  for (const record of records) {
    const url = redactCaptureUrl(record?.url, { baseUrl: documentUrl });
    const resourceType = normalizedStyleValue(record?.resource_type) || "other";
    const transferredBytes = record?.encoded_data_length;
    const requestId = normalizeString(record?.request_id);
    const sourceUrls = record?.source_urls == null ? [] : record.source_urls;
    if (!requestId) addProblem("request_identity_invalid");
    else if (seenRequestIds.has(requestId)) addProblem("duplicate_request_identity");
    else seenRequestIds.add(requestId);
    if (!url || !/^https?:\/\//.test(url)) addProblem("resource_url_unresolvable");
    if (!Array.isArray(sourceUrls)) addProblem("resource_aliases_invalid");
    const aliases = (Array.isArray(sourceUrls) ? sourceUrls : [])
      .map((sourceUrl) => redactCaptureUrl(sourceUrl, { baseUrl: documentUrl }));
    for (const alias of aliases) {
      if (!alias || !/^https?:\/\//.test(alias)) addProblem("resource_aliases_invalid");
    }
    if (record?.from_disk_cache || record?.from_prefetch_cache) addProblem("cache_observed");
    if (record?.from_service_worker) addProblem("service_worker_observed");
    if (record?.failed) addProblem("request_failed");
    if (!Number.isInteger(transferredBytes) || transferredBytes < 0) {
      addProblem("transfer_size_unavailable");
      continue;
    }
    if (!url) continue;
    const origin = urlOrigin(url);
    const crossOrigin = Boolean(origin && documentOrigin && origin !== documentOrigin);
    if (crossOrigin) crossOriginRequestCount += 1;
    totalTransferredBytes += transferredBytes;
    const key = `${url}\u0000${resourceType}`;
    const group = groups.get(key) || {
      url,
      resource_type: resourceType,
      transferred_bytes: 0,
      request_count: 0,
      statuses: new Set(),
      partial_request_count: 0,
      cross_origin: crossOrigin,
      match_urls: new Set([url]),
    };
    group.transferred_bytes += transferredBytes;
    group.request_count += 1;
    if (Number.isInteger(record?.status)) group.statuses.add(record.status);
    if (record?.status === 206) group.partial_request_count += 1;
    group.cross_origin ||= crossOrigin;
    for (const alias of aliases) {
      if (alias && /^https?:\/\//.test(alias)) group.match_urls.add(alias);
    }
    groups.set(key, group);
  }

  const resources = [...groups.values()]
    .map((group) => {
      const { statuses, match_urls: matchUrls, ...projection } = group;
      const normalizedMatchUrls = [...matchUrls].sort();
      return {
        ...projection,
        statuses: [...statuses].sort((a, b) => a - b),
        ...(normalizedMatchUrls.length > 1 ? { match_urls: normalizedMatchUrls } : {}),
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url) || a.resource_type.localeCompare(b.resource_type));
  const largest = [...resources].sort((a, b) => b.transferred_bytes - a.transferred_bytes
    || a.url.localeCompare(b.url)
    || a.resource_type.localeCompare(b.resource_type))[0];
  const problems = [...problemCounts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    measurement_status: problems.length ? "incomplete" : "complete",
    total_transferred_bytes: totalTransferredBytes,
    request_count: records.length,
    cross_origin_request_count: crossOriginRequestCount,
    cache_request_count: records.filter((record) => record?.from_disk_cache || record?.from_prefetch_cache).length,
    service_worker_request_count: records.filter((record) => record?.from_service_worker).length,
    resources,
    largest_resource: largest ? {
      url: largest.url,
      resource_type: largest.resource_type,
      transferred_bytes: largest.transferred_bytes,
      request_count: largest.request_count,
    } : null,
    problems,
  };
}

export function normalizeMediaElement(element, { documentUrl, elementIndex = 0 } = {}) {
  const tagName = normalizedStyleValue(element?.tag_name);
  if (tagName !== "video" && tagName !== "audio") {
    throw new Error("Page-load media capture accepts only video or audio elements.");
  }
  if (!Number.isInteger(elementIndex) || elementIndex < 0
    || !Object.hasOwn(element, "current_src")
    || (element.current_src !== null && typeof element.current_src !== "string")
    || !Object.hasOwn(element, "src")
    || (element.src !== null && typeof element.src !== "string")
    || !Array.isArray(element.source_srcs)
    || element.source_srcs.some((source) => typeof source !== "string")
    || !Object.hasOwn(element, "preload")
    || (element.preload !== null && typeof element.preload !== "string")
    || !validComputedStyle(element.computed_style)
    || !Array.isArray(element.ancestor_styles)
    || element.ancestor_styles.some((style) => !validComputedStyle(style))) {
    throw new Error("Page-load media capture needs complete source and computed-style measurements.");
  }
  const styles = [element?.computed_style, ...(Array.isArray(element?.ancestor_styles) ? element.ancestor_styles : [])];
  const hiddenBy = new Set();
  for (const style of styles) {
    if (normalizedStyleValue(style?.display) === "none") hiddenBy.add("display_none");
    if (normalizedStyleValue(style?.visibility) === "hidden") hiddenBy.add("visibility_hidden");
  }
  const sources = [element?.current_src, element?.src, ...(Array.isArray(element?.source_srcs) ? element.source_srcs : [])]
    .map((source) => redactCaptureUrl(source, { baseUrl: documentUrl }))
    .filter(Boolean);
  const preload = typeof element?.preload === "string"
    ? element.preload.trim().toLocaleLowerCase("en-US")
    : null;
  const width = Number(element?.bounding_box?.width);
  const height = Number(element?.bounding_box?.height);
  return {
    tag_name: tagName,
    element_index: elementIndex,
    sources: [...new Set(sources)].sort(),
    preload,
    preload_defers_fetch: preload === "none" || preload === "metadata",
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
  const status = normalizedStyleValue(value?.status);
  const durationMs = value?.duration_ms;
  if ((status !== "settled" && status !== "timeout")
    || !Number.isInteger(durationMs)
    || durationMs < 0) return null;
  return { status, duration_ms: durationMs };
}

export function buildPageLoadCapture({
  route,
  viewport,
  documentUrl,
  responseCollectionStatus,
  networkidle,
  mediaElements,
  responses,
  producerError,
} = {}) {
  const network = aggregateCdpResponses(responses, { documentUrl });
  const problems = [...network.problems];
  const addCaptureProblem = (code) => {
    const existing = problems.find((problem) => problem.code === code);
    if (existing) existing.count += 1;
    else problems.push({ code, count: 1 });
  };
  if (!Array.isArray(mediaElements)) addCaptureProblem("media_collection_unavailable");
  if (!Array.isArray(responses)) addCaptureProblem("response_collection_unavailable");
  const collectionStatus = normalizedStyleValue(responseCollectionStatus);
  if (collectionStatus === "failed") addCaptureProblem("response_collection_failed");
  else if (collectionStatus !== "complete") addCaptureProblem("response_collection_status_invalid");
  if (collectionStatus === "complete" && Array.isArray(responses) && responses.length === 0) {
    addCaptureProblem("response_collection_empty");
  }
  if (producerError) addCaptureProblem("producer_failed");
  const media = [];
  for (const [elementIndex, element] of (Array.isArray(mediaElements) ? mediaElements : []).entries()) {
    try {
      const normalized = normalizeMediaElement(element, { documentUrl, elementIndex });
      if (normalized.hidden_at_load
        && !normalized.preload_defers_fetch
        && normalized.sources.some((source) => !/^https?:\/\//.test(source))) {
        addCaptureProblem("media_source_unresolvable");
      }
      const matched = network.resources.map((resource) => {
        const matchUrls = Array.isArray(resource.match_urls) ? resource.match_urls : [resource.url];
        const matchedSource = normalized.sources.find((url) => matchUrls.includes(url));
        return matchedSource ? { resource, matchedSource } : null;
      }).filter(Boolean);
      media.push({
        ...normalized,
        fetched_bytes: matched.reduce((sum, { resource }) => sum + resource.transferred_bytes, 0),
        fetched_request_count: matched.reduce((sum, { resource }) => sum + resource.request_count, 0),
        fetched_resources: matched
          .map(({ resource, matchedSource }) => ({
            url: resource.url,
            ...(matchedSource === resource.url ? {} : { matched_source: matchedSource }),
            transferred_bytes: resource.transferred_bytes,
            request_count: resource.request_count,
          }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      });
    } catch {
      addCaptureProblem("media_measurement_failed");
    }
  }
  const settled = normalizedNetworkidle(networkidle);
  if (!settled) addCaptureProblem("networkidle_measurement_invalid");
  problems.sort((a, b) => a.code.localeCompare(b.code));

  return {
    schema_version: POLISH_ROUTE_CAPTURE_SCHEMA_VERSION,
    performed_by: POLISH_CAPTURE_PRODUCER,
    route: normalizePageLoadRoute(route),
    viewport: normalizeString(viewport)?.toLocaleLowerCase("en-US") || null,
    measurement_status: problems.length ? "incomplete" : "complete",
    response_collection: {
      status: collectionStatus === "complete" || collectionStatus === "failed" ? collectionStatus : "invalid",
      observed_response_count: network.request_count,
    },
    networkidle: settled,
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
