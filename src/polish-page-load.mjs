import { createHash } from "node:crypto";

import {
  buildPolishCaptureIntegrity,
  canonicalJson,
  captureOrigin,
  documentResponseAcceptable,
  hiddenEagerSourceUnresolved,
  ledgerProblemCounts,
  MAX_PAGE_LOAD_MEDIA_ANCESTORS,
  MAX_PAGE_LOAD_MEDIA_ELEMENTS,
  MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  mediaCollectionStatus,
  mediaFetchTotals,
  mediaFetchedResources,
  normalizedBuildFingerprint,
  normalizedCampaignSlug,
  normalizedNetworkidle,
  normalizedViewport,
  normalizePageLoadRoute,
  originMatchesCapture,
  POLISH_CAPTURE_PRODUCER,
  POLISH_CAPTURE_INTEGRITY_ALGORITHM,
  POLISH_CAPTURE_INTEGRITY_SCHEMA_VERSION,
  POLISH_CAPTURE_WARNING_PROBLEM_CODES,
  POLISH_PRELOAD_ATTRIBUTES,
  POLISH_RESOURCE_TYPES,
  POLISH_ROUTE_CAPTURE_SCHEMA_VERSION,
  preloadDefersFetch,
  producerStatus,
  resourceLedgerMetrics,
  resourceLedgerSort,
  resourceTypeKnown,
  responseCollectionProblemCode,
  sourceReferenceSort,
  unattributedMediaTransfers,
  failedRequestProblemCode,
  polishCaptureMeasurementStatus,
  redactCaptureUrl,
} from "./polish-capture.mjs";
import {
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  projectCheckpointWaiverAssessment,
} from "./checkpoint-waiver.mjs";

export const HIDDEN_EAGER_MEDIA_SCOPE = "polish.hidden_eager_media";
export const HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES = 1_048_576;
export const POLISH_PAGE_LOAD_SCHEMA_VERSION = "campaigns-os-polish-page-load/v0";
export const POLISH_PAGE_LOAD_PRODUCER = POLISH_CAPTURE_PRODUCER;
const MAX_HIDDEN_EAGER_MEDIA_FINDING_RESOURCES = 64;

const RESOURCE_TYPES = new Set(POLISH_RESOURCE_TYPES);
const PRELOAD_ATTRIBUTES = new Set(POLISH_PRELOAD_ATTRIBUTES);
const RESOURCE_TYPE_STATUSES = new Set(["ambiguous", "known", "unknown"]);
const SOURCE_KINDS = new Set(["current_src", "observed_source", "source_src_attribute", "src_attribute"]);
const SOURCE_SENTINELS = new Set(["[malformed-url]", "[non-http-url]", "[url-too-long]"]);
export const POLISH_CAPTURE_PROBLEM_CODES = Object.freeze([
  "browser_unavailable",
  "cache_observed",
  "capture_binding_mismatch",
  "capture_integrity_invalid",
  "capture_shape_invalid",
  "capture_subject_invalid",
  "cross_origin_request_failed",
  "dependency_request_failed",
  "duplicate_request_identity",
  "document_response_ambiguous",
  "document_response_error",
  "document_response_missing",
  "document_context_changed",
  "final_document_route_mismatch",
  "media_collection_unavailable",
  "media_element_overflow",
  "media_measurement_failed",
  "media_ancestor_overflow",
  "media_source_unresolvable",
  "media_source_overflow",
  "media_transfer_unattributed",
  "networkidle_measurement_invalid",
  "producer_failed",
  "producer_timeout",
  "redirect_chain_invalid",
  "request_identity_invalid",
  "resource_aliases_invalid",
  "resource_ledger_overflow",
  "resource_type_ambiguous",
  "resource_type_unknown",
  "resource_url_unresolvable",
  "response_collection_empty",
  "response_collection_failed",
  "response_collection_status_invalid",
  "response_collection_unavailable",
  "response_record_overflow",
  "service_worker_observed",
  "transfer_size_unavailable",
  "url_length_overflow",
]);
const CAPTURE_PROBLEM_CODES = new Set(POLISH_CAPTURE_PROBLEM_CODES);
const CAPTURE_WARNING_PROBLEM_CODES = new Set(POLISH_CAPTURE_WARNING_PROBLEM_CODES);
const MAX_CAPTURE_WARNING_ORIGINS = 32;

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeString(value)?.toLocaleLowerCase("en-US"))
    .filter((value) => value && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
    .filter(Boolean))].sort();
}

function normalizedRoutes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizePageLoadRoute)
    .filter(Boolean))].sort();
}

function emptyWaiverAssessment() {
  return {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  };
}

function pageLoadCheckpointSubject({ buildFingerprint, slug, routeScope, routes, viewports } = {}) {
  return {
    build_fingerprint: normalizedBuildFingerprint(buildFingerprint),
    campaign_slug: normalizedCampaignSlug(slug),
    route_scope: normalizeString(routeScope)?.toLocaleLowerCase("en-US") || null,
    routes: normalizedRoutes(routes),
    viewports: normalizedStrings(viewports),
  };
}

function captureKey(route, viewport) {
  return `${route}\u0000${viewport}`;
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function projectedInteger(value) {
  return isNonnegativeInteger(value) ? value : null;
}

function projectedBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function isSha256(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSortedUnique(values, compare = (a, b) => a.localeCompare(b)) {
  if (!Array.isArray(values)) return false;
  const canonical = [...new Set(values)].sort(compare);
  return canonical.length === values.length && canonical.every((value, index) => value === values[index]);
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//.test(value) || /[?#]/.test(value)) return null;
  const projected = redactCaptureUrl(value);
  return projected && /^https?:\/\//.test(projected) ? projected : null;
}

function safeSourceUrl(value) {
  if (value === null) return null;
  if (SOURCE_SENTINELS.has(value)) return value;
  return safeHttpUrl(value) || "[malformed-url]";
}

// A subject is valid when the producer's normalizers leave every field as
// stated and none of them null.
function validCaptureSubject(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return false;
  const projected = projectCaptureSubject(subject);
  return Object.values(projected).every((value) => value !== null)
    && canonicalJson(projected) === canonicalJson(subject);
}

function projectCaptureSubject(subject) {
  return {
    build_fingerprint: normalizedBuildFingerprint(subject?.build_fingerprint),
    campaign_slug: normalizedCampaignSlug(subject?.campaign_slug),
    requested_route: normalizePageLoadRoute(subject?.requested_route),
    final_document_route: normalizePageLoadRoute(subject?.final_document_route),
    viewport: normalizedViewport(subject?.viewport),
  };
}

function hasOwn(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function hasDeclaredLedgerShape(resource) {
  return hasOwn(resource, "declared_bytes")
    || hasOwn(resource, "canceled_request_count")
    || hasOwn(resource, "declared_request_count");
}

function validResourceLedgerEntry(resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return false;
  if (!isSha256(resource.resource_id) || safeHttpUrl(resource.url) !== resource.url) return false;
  if (!RESOURCE_TYPES.has(resource.resource_type)
    || !RESOURCE_TYPE_STATUSES.has(resource.resource_type_status)) return false;
  if ((resource.resource_type_status === "known") !== resourceTypeKnown(resource.resource_type)) return false;
  for (const field of [
    "transferred_bytes",
    "request_count",
    "unmeasured_request_count",
    "failed_request_count",
    "partial_request_count",
    "cross_origin_request_count",
    "cache_request_count",
    "service_worker_request_count",
  ]) {
    if (!isNonnegativeInteger(resource[field])) return false;
  }
  const declaredShape = hasDeclaredLedgerShape(resource);
  if (declaredShape && (!isNonnegativeInteger(resource.declared_bytes)
    || !isNonnegativeInteger(resource.canceled_request_count)
    || !isNonnegativeInteger(resource.declared_request_count))) return false;
  for (const field of [
    "unmeasured_request_count",
    "failed_request_count",
    "partial_request_count",
    "cross_origin_request_count",
    "cache_request_count",
    "service_worker_request_count",
  ]) {
    if (resource[field] > resource.request_count) return false;
  }
  if (declaredShape && (resource.canceled_request_count > resource.request_count
    || resource.declared_request_count > resource.request_count
    || resource.declared_request_count > resource.canceled_request_count
    || (resource.declared_request_count === 0 && resource.declared_bytes !== 0))) return false;
  if (resource.cross_origin_request_count !== 0
    && resource.cross_origin_request_count !== resource.request_count) return false;
  if (!isSortedUnique(resource.statuses, (a, b) => a - b)
    || resource.statuses.some((status) => !Number.isInteger(status))) return false;
  if ((resource.partial_request_count > 0) !== resource.statuses.includes(206)) return false;
  if (!isSortedUnique(resource.match_resource_ids)
    || resource.match_resource_ids.some((id) => !isSha256(id))
    || !resource.match_resource_ids.includes(resource.resource_id)) return false;
  return true;
}

function projectResourceLedgerEntry(resource) {
  return {
    resource_id: isSha256(resource?.resource_id) ? resource.resource_id : null,
    url: safeHttpUrl(resource?.url),
    resource_type: RESOURCE_TYPES.has(resource?.resource_type) ? resource.resource_type : "unknown",
    resource_type_status: RESOURCE_TYPE_STATUSES.has(resource?.resource_type_status)
      ? resource.resource_type_status
      : "unknown",
    transferred_bytes: projectedInteger(resource?.transferred_bytes),
    request_count: projectedInteger(resource?.request_count),
    ...(hasDeclaredLedgerShape(resource) ? {
      declared_bytes: projectedInteger(resource?.declared_bytes),
      canceled_request_count: projectedInteger(resource?.canceled_request_count),
      declared_request_count: projectedInteger(resource?.declared_request_count),
    } : {}),
    unmeasured_request_count: projectedInteger(resource?.unmeasured_request_count),
    failed_request_count: projectedInteger(resource?.failed_request_count),
    statuses: (Array.isArray(resource?.statuses) ? resource.statuses : [])
      .filter(Number.isInteger)
      .sort((a, b) => a - b),
    partial_request_count: projectedInteger(resource?.partial_request_count),
    cross_origin_request_count: projectedInteger(resource?.cross_origin_request_count),
    cache_request_count: projectedInteger(resource?.cache_request_count),
    service_worker_request_count: projectedInteger(resource?.service_worker_request_count),
    match_resource_ids: (Array.isArray(resource?.match_resource_ids) ? resource.match_resource_ids : [])
      .filter(isSha256)
      .sort(),
  };
}

function validResourceLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return false;
  if (ledger.limit !== MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES
    || !isNonnegativeInteger(ledger.total_resource_count)
    || !isNonnegativeInteger(ledger.omitted_resource_count)
    || !isNonnegativeInteger(ledger.omitted_request_count)
    || !Array.isArray(ledger.entries)
    || ledger.entries.length > ledger.limit
    || ledger.entries.some((resource) => !validResourceLedgerEntry(resource))) return false;
  if (ledger.total_resource_count !== ledger.entries.length + ledger.omitted_resource_count) return false;
  if (!isSortedUnique(ledger.entries, resourceLedgerSort)) return false;
  return new Set(ledger.entries.map((resource) => resource.resource_id)).size === ledger.entries.length;
}

function projectResourceLedger(ledger) {
  return {
    limit: projectedInteger(ledger?.limit),
    total_resource_count: projectedInteger(ledger?.total_resource_count),
    omitted_resource_count: projectedInteger(ledger?.omitted_resource_count),
    omitted_request_count: projectedInteger(ledger?.omitted_request_count),
    entries: (Array.isArray(ledger?.entries) ? ledger.entries : [])
      .slice(0, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES)
      .map(projectResourceLedgerEntry)
      .sort(resourceLedgerSort),
  };
}

function projectLargestResource(resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return null;
  return {
    resource_id: isSha256(resource.resource_id) ? resource.resource_id : null,
    url: safeHttpUrl(resource.url),
    resource_type: RESOURCE_TYPES.has(resource.resource_type) ? resource.resource_type : "unknown",
    transferred_bytes: projectedInteger(resource.transferred_bytes),
    request_count: projectedInteger(resource.request_count),
  };
}

function projectMetrics(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  return {
    total_transferred_bytes: projectedInteger(metrics.total_transferred_bytes),
    request_count: projectedInteger(metrics.request_count),
    largest_resource: projectLargestResource(metrics.largest_resource),
    cross_origin_request_count: projectedInteger(metrics.cross_origin_request_count),
    cache_request_count: projectedInteger(metrics.cache_request_count),
    service_worker_request_count: projectedInteger(metrics.service_worker_request_count),
  };
}

function validSourceReference(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  if (!SOURCE_KINDS.has(reference.source_kind) || !isNonnegativeInteger(reference.source_index)) return false;
  if ((reference.source_kind === "current_src" || reference.source_kind === "src_attribute")
    && reference.source_index !== 0) return false;
  const safeUrl = safeSourceUrl(reference.url);
  if (safeUrl !== reference.url) return false;
  return safeHttpUrl(reference.url)
    ? isSha256(reference.resource_id)
    : reference.resource_id === null && SOURCE_SENTINELS.has(reference.url);
}

function projectSourceReference(reference) {
  return {
    source_kind: SOURCE_KINDS.has(reference?.source_kind) ? reference.source_kind : null,
    source_index: projectedInteger(reference?.source_index),
    url: safeSourceUrl(reference?.url),
    resource_id: isSha256(reference?.resource_id) ? reference.resource_id : null,
  };
}

function explicitSourceDescriptors(media) {
  const descriptors = [];
  if (media.current_src !== null) descriptors.push({ source_kind: "current_src", source_index: 0, url: media.current_src });
  if (media.src_attribute !== null) descriptors.push({ source_kind: "src_attribute", source_index: 0, url: media.src_attribute });
  media.source_src_attributes.forEach((url, sourceIndex) => {
    if (url !== null) descriptors.push({ source_kind: "source_src_attribute", source_index: sourceIndex, url });
  });
  media.observed_source_urls.forEach((url, sourceIndex) => {
    if (url !== null) descriptors.push({ source_kind: "observed_source", source_index: sourceIndex, url });
  });
  return descriptors.sort(sourceReferenceSort);
}

function validFetchedResource(resource) {
  return Boolean(resource)
    && typeof resource === "object"
    && !Array.isArray(resource)
    && isSha256(resource.resource_id)
    && safeHttpUrl(resource.url) === resource.url
    && RESOURCE_TYPES.has(resource.resource_type)
    && isNonnegativeInteger(resource.transferred_bytes)
    && (!hasOwn(resource, "declared_bytes") || isNonnegativeInteger(resource.declared_bytes))
    && isNonnegativeInteger(resource.request_count)
    && isSortedUnique(resource.matched_source_resource_ids)
    && resource.matched_source_resource_ids.every(isSha256);
}

function projectFetchedResource(resource) {
  return {
    resource_id: isSha256(resource?.resource_id) ? resource.resource_id : null,
    url: safeHttpUrl(resource?.url),
    resource_type: RESOURCE_TYPES.has(resource?.resource_type) ? resource.resource_type : "unknown",
    transferred_bytes: projectedInteger(resource?.transferred_bytes),
    request_count: projectedInteger(resource?.request_count),
    ...(hasOwn(resource, "declared_bytes") ? { declared_bytes: projectedInteger(resource?.declared_bytes) } : {}),
    matched_source_resource_ids: (Array.isArray(resource?.matched_source_resource_ids)
      ? resource.matched_source_resource_ids
      : []).filter(isSha256).sort(),
  };
}

function validMediaProjection(media, ledgerEntries) {
  if (!media || typeof media !== "object" || Array.isArray(media)) return false;
  if (media.tag_name !== "video" && media.tag_name !== "audio") return false;
  if (!isNonnegativeInteger(media.element_index)) return false;
  if (safeSourceUrl(media.current_src) !== media.current_src
    || safeSourceUrl(media.src_attribute) !== media.src_attribute
    || !Array.isArray(media.source_src_attributes)
    || media.source_src_attributes.some((value) => safeSourceUrl(value) !== value)
    || !Array.isArray(media.observed_source_urls)
    || media.observed_source_urls.some((value) => safeSourceUrl(value) !== value)
    || media.source_src_attributes.length > MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT
    || media.observed_source_urls.length > MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT) return false;
  if (!Array.isArray(media.source_references)
    || media.source_references.some((reference) => !validSourceReference(reference))
    || !isSortedUnique(media.source_references, sourceReferenceSort)) return false;
  const descriptors = explicitSourceDescriptors(media);
  const referenceDescriptors = media.source_references.map(({ source_kind, source_index, url }) => ({
    source_kind,
    source_index,
    url,
  }));
  if (canonicalJson(descriptors) !== canonicalJson(referenceDescriptors)) return false;
  if (!PRELOAD_ATTRIBUTES.has(media.preload_attribute)
    || typeof media.preload_defers_fetch !== "boolean"
    || media.preload_defers_fetch !== preloadDefersFetch(media.preload_attribute)) return false;
  if (typeof media.hidden_at_load !== "boolean"
    || (media.zero_size_at_load !== null && typeof media.zero_size_at_load !== "boolean")) return false;
  if (!isSortedUnique(media.hidden_by)
    || media.hidden_by.some((kind) => kind !== "display_none"
      && kind !== "visibility_hidden"
      && kind !== "visibility_collapse")
    || media.hidden_at_load !== (media.hidden_by.length > 0)) return false;
  if (!isNonnegativeInteger(media.fetched_bytes)
    || (hasOwn(media, "declared_bytes") && !isNonnegativeInteger(media.declared_bytes))
    || !isNonnegativeInteger(media.fetched_request_count)
    || !Array.isArray(media.fetched_resources)
    || media.fetched_resources.some((resource) => !validFetchedResource(resource))) return false;
  const expected = mediaFetchedResources(media, ledgerEntries);
  const projectedFetched = media.fetched_resources.map(projectFetchedResource).sort(resourceLedgerSort);
  if (canonicalJson(projectedFetched) !== canonicalJson(expected)) return false;
  const totals = mediaFetchTotals(expected);
  return media.fetched_bytes === totals.fetched_bytes
    && (hasOwn(media, "declared_bytes") ? media.declared_bytes === totals.declared_bytes : totals.declared_bytes === 0)
    && media.fetched_request_count === totals.fetched_request_count;
}

function projectMedia(media) {
  return {
    tag_name: media?.tag_name === "video" || media?.tag_name === "audio" ? media.tag_name : null,
    element_index: projectedInteger(media?.element_index),
    current_src: safeSourceUrl(media?.current_src),
    src_attribute: safeSourceUrl(media?.src_attribute),
    source_src_attributes: (Array.isArray(media?.source_src_attributes) ? media.source_src_attributes : [])
      .map(safeSourceUrl),
    observed_source_urls: (Array.isArray(media?.observed_source_urls) ? media.observed_source_urls : [])
      .map(safeSourceUrl),
    source_references: (Array.isArray(media?.source_references) ? media.source_references : [])
      .map(projectSourceReference)
      .sort(sourceReferenceSort),
    preload_attribute: PRELOAD_ATTRIBUTES.has(media?.preload_attribute) ? media.preload_attribute : "other",
    preload_defers_fetch: projectedBoolean(media?.preload_defers_fetch),
    hidden_at_load: projectedBoolean(media?.hidden_at_load),
    hidden_by: (Array.isArray(media?.hidden_by) ? media.hidden_by : [])
      .filter((kind) => kind === "display_none"
        || kind === "visibility_hidden"
        || kind === "visibility_collapse")
      .sort(),
    zero_size_at_load: media?.zero_size_at_load === null ? null : projectedBoolean(media?.zero_size_at_load),
    fetched_bytes: projectedInteger(media?.fetched_bytes),
    fetched_request_count: projectedInteger(media?.fetched_request_count),
    ...(hasOwn(media, "declared_bytes") ? { declared_bytes: projectedInteger(media?.declared_bytes) } : {}),
    fetched_resources: (Array.isArray(media?.fetched_resources) ? media.fetched_resources : [])
      .map(projectFetchedResource)
      .sort(resourceLedgerSort),
  };
}

function problemCount(capture, code) {
  return capture.problems
    .filter((problem) => problem.code === code)
    .reduce((sum, problem) => sum + problem.count, 0);
}

function validProblems(capture) {
  if (!Array.isArray(capture.problems)
    || capture.problems.some((problem) => !problem
      || typeof problem !== "object"
      || Array.isArray(problem)
      || !CAPTURE_PROBLEM_CODES.has(problem.code)
      || !Number.isInteger(problem.count)
      || problem.count <= 0)) return false;
  if (!isSortedUnique(capture.problems.map(({ code }) => code))) return false;
  return capture.measurement_status === polishCaptureMeasurementStatus(capture.problems);
}

// The demoted failures behind a capture warning, read back off the ledger:
// which hosts they went to and which resource roles were demoted. The roles
// matter because the demotion is a trade-off, not a fact about the page — a
// warning that names only its origins leaves the operator unable to see
// which beacon roles were forgiven. The role vocabulary is the beacon
// allowlist in polish-capture.mjs, so the type list is bounded by that closed
// set and needs no separate cap; the origin list is unbounded and is capped
// by the caller.
function captureWarningAttribution(capture) {
  const entries = Array.isArray(capture?.resource_ledger?.entries) ? capture.resource_ledger.entries : [];
  const origins = new Set();
  const resourceTypes = new Set();
  for (const resource of entries) {
    if (resource.failed_request_count === 0) continue;
    if (failedRequestProblemCode({
      crossOrigin: resource.cross_origin_request_count > 0,
      resourceType: resource.resource_type,
    }) !== "cross_origin_request_failed") continue;
    // A ledger URL has already passed safeHttpUrl in validResourceLedger, so a
    // parse failure here is a bug worth throwing on, not a case to swallow.
    const origin = captureOrigin(resource.url);
    if (origin === null) throw new Error("polish capture: resource ledger URL is not an HTTP(S) URL");
    origins.add(origin);
    resourceTypes.add(resource.resource_type);
  }
  return { origins: [...origins].sort(), resourceTypes: [...resourceTypes].sort() };
}

function projectCaptureIntegrity(integrity) {
  return {
    schema_version: integrity?.schema_version === POLISH_CAPTURE_INTEGRITY_SCHEMA_VERSION
      ? POLISH_CAPTURE_INTEGRITY_SCHEMA_VERSION
      : null,
    algorithm: integrity?.algorithm === POLISH_CAPTURE_INTEGRITY_ALGORITHM
      ? POLISH_CAPTURE_INTEGRITY_ALGORITHM
      : null,
    association_fingerprint: isSha256(integrity?.association_fingerprint)
      ? integrity.association_fingerprint
      : null,
    projection_fingerprint: isSha256(integrity?.projection_fingerprint)
      ? integrity.projection_fingerprint
      : null,
  };
}

function validCaptureIntegrity(capture) {
  const integrity = projectCaptureIntegrity(capture?.integrity);
  if (Object.values(integrity).some((value) => value === null)) return false;
  const expected = buildPolishCaptureIntegrity(projectCapturePayload(capture));
  return canonicalJson(integrity) === canonicalJson(expected);
}

// An origin field is trusted only when it is exactly what the one origin
// parser returns for itself: no path, no query, no credentials, no case drift.
function safeOrigin(value) {
  return captureOrigin(value) === value ? value : null;
}

function projectDocumentResponse(value) {
  const statuses = new Set(["ambiguous", "complete", "error", "missing"]);
  const mimeTypes = new Set(["html", "other", "unknown", "xhtml"]);
  return {
    status: statuses.has(value?.status) ? value.status : "missing",
    url: safeHttpUrl(value?.url),
    resource_id: isSha256(value?.resource_id) ? value.resource_id : null,
    http_status: Number.isInteger(value?.http_status) && value.http_status >= 100 && value.http_status <= 599
      ? value.http_status
      : null,
    mime_type: mimeTypes.has(value?.mime_type) ? value.mime_type : "unknown",
    context_fingerprint: isSha256(value?.context_fingerprint) ? value.context_fingerprint : null,
    capture_origin: safeOrigin(value?.capture_origin),
    final_origin: safeOrigin(value?.final_origin),
    origin_matches_capture: projectedBoolean(value?.origin_matches_capture),
  };
}

function validDocumentResponse(capture, entries) {
  if (!capture.document_response || typeof capture.document_response !== "object"
    || Array.isArray(capture.document_response)) return false;
  const projected = projectDocumentResponse(capture.document_response);
  if (canonicalJson(projected) !== canonicalJson(capture.document_response)) return false;
  if (projected.origin_matches_capture
    !== originMatchesCapture(projected.capture_origin, projected.final_origin)) return false;
  const problemStatus = problemCount(capture, "document_response_ambiguous") > 0
    ? "ambiguous"
    : problemCount(capture, "document_response_missing") > 0
      ? "missing"
      : problemCount(capture, "document_response_error") > 0 ? "error" : "complete";
  if (projected.status !== problemStatus) return false;
  if (projected.status === "missing" || projected.status === "ambiguous") {
    return projected.resource_id === null
      && projected.http_status === null
      && projected.mime_type === "unknown"
      && projected.context_fingerprint === null;
  }
  if (!projected.resource_id || !projected.context_fingerprint) return false;
  const resource = entries.find((entry) => entry.resource_id === projected.resource_id);
  if (!resource || resource.resource_type !== "document" || resource.url !== projected.url) return false;
  if (projected.http_status !== null && !resource.statuses.includes(projected.http_status)) return false;
  return (projected.status === "complete") === documentResponseAcceptable(projected);
}

// The shape rules. Each names one statement a capture makes about itself
// and recomputes it from the ledger, the media list or the problems with the
// producer's own derivation (imported from polish-capture.mjs), so the
// producer and the validator cannot drift apart. A "stated"/"derived" rule
// holds when the two canonicalize to the same bytes; a "holds" rule is a
// structural check the derivations rely on. Order matters: a rule may assume
// every rule before it held, and the first failure is the one reported.
const CAPTURE_SHAPE_RULES = Object.freeze([
  { name: "capture_object", holds: (capture) => Boolean(capture) && typeof capture === "object" && !Array.isArray(capture) },
  { name: "schema_version", holds: (capture) => capture.schema_version === POLISH_ROUTE_CAPTURE_SCHEMA_VERSION },
  { name: "performed_by", holds: (capture) => capture.performed_by === POLISH_CAPTURE_PRODUCER },
  {
    name: "measurement_status_token",
    holds: (capture) => capture.measurement_status === "complete" || capture.measurement_status === "incomplete",
  },
  { name: "subject", holds: (capture) => validCaptureSubject(capture.subject) },
  { name: "problems", holds: (capture) => validProblems(capture) },
  { name: "integrity", holds: (capture) => validCaptureIntegrity(capture) },
  {
    name: "producer_status",
    holds: (capture) => capture.producer_status === "complete" || capture.producer_status === "failed",
    stated: (capture) => capture.producer_status,
    derived: (capture) => producerStatus(capture.problems),
  },
  {
    name: "response_collection_fields",
    holds: (capture) => Boolean(capture.response_collection)
      && ["complete", "failed", "invalid"].includes(capture.response_collection.status)
      && isNonnegativeInteger(capture.response_collection.observed_response_count)
      && isNonnegativeInteger(capture.response_collection.unattributed_response_count),
  },
  {
    name: "response_collection_status",
    stated: (capture) => ["response_collection_failed", "response_collection_status_invalid"]
      .filter((code) => problemCount(capture, code) > 0),
    derived: (capture) => [responseCollectionProblemCode(capture.response_collection.status)].filter(Boolean),
  },
  {
    name: "response_collection_empty",
    stated: (capture) => problemCount(capture, "response_collection_empty") > 0,
    derived: (capture) => capture.response_collection.status === "complete"
      && capture.response_collection.observed_response_count === 0,
  },
  {
    name: "media_collection_fields",
    holds: (capture) => Boolean(capture.media_collection)
      && ["complete", "failed", "partial"].includes(capture.media_collection.status)
      && ["observed_element_count", "failed_element_count", "omitted_element_count",
        "source_overflow_element_count", "ancestor_overflow_element_count"]
        .every((field) => isNonnegativeInteger(capture.media_collection[field])),
  },
  {
    name: "media_collection_status",
    stated: (capture) => capture.media_collection.status,
    derived: (capture) => (problemCount(capture, "media_collection_unavailable") > 0
      ? (mediaCollectionStatus(capture.media_collection) === "complete" ? "failed" : "invalid")
      : mediaCollectionStatus(capture.media_collection)),
  },
  {
    name: "media_collection_counts",
    stated: (capture) => [
      capture.media_collection.failed_element_count,
      capture.media_collection.omitted_element_count,
      capture.media_collection.source_overflow_element_count,
      capture.media_collection.ancestor_overflow_element_count,
    ],
    derived: (capture) => [
      problemCount(capture, "media_measurement_failed"),
      problemCount(capture, "media_element_overflow"),
      problemCount(capture, "media_source_overflow"),
      problemCount(capture, "media_ancestor_overflow"),
    ],
  },
  {
    name: "networkidle",
    holds: (capture) => Boolean(capture.networkidle) && typeof capture.networkidle === "object",
    stated: (capture) => capture.networkidle,
    derived: (capture) => normalizedNetworkidle(capture.networkidle),
  },
  {
    name: "networkidle_problem",
    stated: (capture) => problemCount(capture, "networkidle_measurement_invalid") > 0,
    derived: (capture) => capture.networkidle.status === "invalid",
  },
  { name: "resource_ledger", holds: (capture) => validResourceLedger(capture.resource_ledger) },
  { name: "document_response", holds: (capture) => validDocumentResponse(capture, capture.resource_ledger.entries) },
  {
    name: "metrics",
    holds: (capture) => Boolean(capture.metrics) && typeof capture.metrics === "object" && !Array.isArray(capture.metrics),
    stated: (capture) => projectMetrics(capture.metrics),
    derived: (capture) => resourceLedgerMetrics(capture.resource_ledger.entries),
  },
  {
    name: "response_accounting",
    stated: (capture) => capture.response_collection.observed_response_count,
    derived: (capture) => capture.metrics.request_count
      + capture.resource_ledger.omitted_request_count
      + capture.response_collection.unattributed_response_count,
  },
  {
    name: "resource_ledger_overflow",
    stated: (capture) => problemCount(capture, "resource_ledger_overflow"),
    derived: (capture) => capture.resource_ledger.omitted_resource_count,
  },
  {
    name: "media",
    holds: (capture) => Array.isArray(capture.media)
      && capture.media.length <= MAX_PAGE_LOAD_MEDIA_ELEMENTS
      && capture.media.every((media) => validMediaProjection(media, capture.resource_ledger.entries))
      && isSortedUnique(capture.media.map((media) => media.element_index), (a, b) => a - b),
  },
  {
    name: "media_element_accounting",
    holds: (capture) => capture.media_collection.status === "failed"
      || (capture.media.every((media, index) => media.element_index === index)
        && capture.media_collection.observed_element_count === capture.media.length
          + capture.media_collection.failed_element_count
          + capture.media_collection.omitted_element_count),
  },
  {
    name: "media_source_unresolvable",
    stated: (capture) => problemCount(capture, "media_source_unresolvable"),
    derived: (capture) => capture.media.filter(hiddenEagerSourceUnresolved).length,
  },
  {
    name: "media_transfer_unattributed",
    stated: (capture) => problemCount(capture, "media_transfer_unattributed"),
    derived: (capture) => unattributedMediaTransfers(capture.media, capture.resource_ledger.entries).length,
  },
  {
    name: "final_document_route_mismatch",
    stated: (capture) => problemCount(capture, "final_document_route_mismatch") > 0,
    derived: (capture) => capture.subject.final_document_route !== capture.subject.requested_route,
  },
  // The ledger-implied problem counts and the collection verdict can only be
  // recomputed when no entry was omitted: an omitted entry contributed to
  // the counts but is not there to recompute from.
  {
    name: "dependency_failure_voids_collection",
    holds: (capture) => capture.resource_ledger.omitted_resource_count > 0
      || ledgerProblemCounts(capture.resource_ledger.entries).dependency_request_failed === 0
      || capture.response_collection.status !== "complete",
  },
  {
    name: "ledger_problem_counts",
    stated: (capture) => (capture.resource_ledger.omitted_resource_count > 0
      ? null
      : Object.fromEntries(Object.keys(ledgerProblemCounts([]))
        .map((code) => [code, problemCount(capture, code)]))),
    derived: (capture) => (capture.resource_ledger.omitted_resource_count > 0
      ? null
      : ledgerProblemCounts(capture.resource_ledger.entries)),
  },
]);

export const POLISH_CAPTURE_SHAPE_RULES = Object.freeze(CAPTURE_SHAPE_RULES.map((rule) => rule.name));

// The name of the first shape rule the capture breaks, or null when every
// rule holds. The name is one of POLISH_CAPTURE_SHAPE_RULES and never
// carries capture content.
export function captureShapeViolation(capture) {
  for (const rule of CAPTURE_SHAPE_RULES) {
    if (rule.holds && !rule.holds(capture)) return rule.name;
    if (rule.stated && canonicalJson(rule.stated(capture)) !== canonicalJson(rule.derived(capture))) return rule.name;
  }
  return null;
}

function projectCapturePayload(capture) {
  const problemCounts = new Map();
  for (const problem of (Array.isArray(capture?.problems) ? capture.problems : [])) {
    if (!CAPTURE_PROBLEM_CODES.has(problem?.code)) continue;
    const count = Number.isInteger(problem.count) && problem.count > 0 ? problem.count : 1;
    problemCounts.set(problem.code, (problemCounts.get(problem.code) || 0) + count);
  }
  return {
    schema_version: capture?.schema_version === POLISH_ROUTE_CAPTURE_SCHEMA_VERSION
      ? POLISH_ROUTE_CAPTURE_SCHEMA_VERSION
      : null,
    performed_by: capture?.performed_by === POLISH_CAPTURE_PRODUCER ? POLISH_CAPTURE_PRODUCER : null,
    subject: projectCaptureSubject(capture?.subject),
    measurement_status: capture?.measurement_status === "complete" || capture?.measurement_status === "incomplete"
      ? capture.measurement_status
      : "incomplete",
    producer_status: capture?.producer_status === "complete" || capture?.producer_status === "failed"
      ? capture.producer_status
      : "invalid",
    response_collection: capture?.response_collection && typeof capture.response_collection === "object" ? {
      status: ["complete", "failed", "invalid"].includes(capture.response_collection.status)
        ? capture.response_collection.status
        : "invalid",
      observed_response_count: projectedInteger(capture.response_collection.observed_response_count),
      unattributed_response_count: projectedInteger(capture.response_collection.unattributed_response_count),
    } : null,
    document_response: projectDocumentResponse(capture?.document_response),
    media_collection: capture?.media_collection && typeof capture.media_collection === "object" ? {
      status: ["complete", "failed", "partial"].includes(capture.media_collection.status)
        ? capture.media_collection.status
        : "failed",
      observed_element_count: projectedInteger(capture.media_collection.observed_element_count),
      failed_element_count: projectedInteger(capture.media_collection.failed_element_count),
      omitted_element_count: projectedInteger(capture.media_collection.omitted_element_count),
      source_overflow_element_count: projectedInteger(capture.media_collection.source_overflow_element_count),
      ancestor_overflow_element_count: projectedInteger(capture.media_collection.ancestor_overflow_element_count),
    } : null,
    networkidle: capture?.networkidle && typeof capture.networkidle === "object" ? {
      status: ["invalid", "settled", "timeout"].includes(capture.networkidle.status)
        ? capture.networkidle.status
        : "invalid",
      duration_ms: capture.networkidle.duration_ms === null ? null : projectedInteger(capture.networkidle.duration_ms),
    } : null,
    resource_ledger: projectResourceLedger(capture?.resource_ledger),
    metrics: projectMetrics(capture?.metrics),
    media: (Array.isArray(capture?.media) ? capture.media : []).map(projectMedia),
    problems: [...problemCounts]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function projectCapture(capture) {
  return {
    ...projectCapturePayload(capture),
    integrity: projectCaptureIntegrity(capture?.integrity),
  };
}

function addProjectedProblem(problems, code) {
  if (!problems.some((problem) => problem.code === code)) problems.push({ code, count: 1 });
}

function captureBindingMatches(capture, pageSubject) {
  const subject = capture?.subject;
  return subject?.build_fingerprint === pageSubject.build_fingerprint
    && subject?.campaign_slug === pageSubject.campaign_slug
    && subject?.requested_route === subject?.final_document_route
    && pageSubject.routes.includes(subject?.requested_route)
    && pageSubject.viewports.includes(subject?.viewport);
}

function stableFindingSort(a, b) {
  return String(a.route).localeCompare(String(b.route))
    || String(a.viewport).localeCompare(String(b.viewport))
    || a.element_index - b.element_index
    || a.sources.join("\u0000").localeCompare(b.sources.join("\u0000"))
    || String(a.resource_identity_fingerprint).localeCompare(String(b.resource_identity_fingerprint));
}

function hiddenEagerMediaFindings(captures) {
  const findings = [];
  for (const capture of captures) {
    for (const media of (Array.isArray(capture?.media) ? capture.media : [])) {
      if (!media?.hidden_at_load || media?.preload_defers_fetch) continue;
      const assessedBytes = Math.max(media?.fetched_bytes || 0, media?.declared_bytes || 0);
      if (!Number.isInteger(assessedBytes)
        || assessedBytes <= HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES) continue;
      const allSources = [...new Set((Array.isArray(media.fetched_resources) ? media.fetched_resources : [])
        .map((resource) => resource?.url)
        .filter(Boolean))].sort();
      const allResourceIds = [...new Set((Array.isArray(media.fetched_resources) ? media.fetched_resources : [])
        .map((resource) => resource?.resource_id)
        .filter(isSha256))].sort();
      findings.push({
        code: HIDDEN_EAGER_MEDIA_SCOPE,
        route: capture.subject.requested_route,
        viewport: capture.subject.viewport,
        tag_name: media.tag_name,
        element_index: media.element_index,
        sources: allSources.slice(0, MAX_HIDDEN_EAGER_MEDIA_FINDING_RESOURCES),
        source_count: allSources.length,
        resource_ids: allResourceIds.slice(0, MAX_HIDDEN_EAGER_MEDIA_FINDING_RESOURCES),
        resource_id_count: allResourceIds.length,
        resource_identity_fingerprint: `sha256:${createHash("sha256")
          .update(JSON.stringify(allResourceIds))
          .digest("hex")}`,
        transferred_bytes: media.fetched_bytes,
        declared_bytes: media.declared_bytes || 0,
        assessed_bytes: assessedBytes,
        threshold_bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
        preload_attribute: media.preload_attribute,
        hidden_by: [...(Array.isArray(media.hidden_by) ? media.hidden_by : [])].sort(),
      });
    }
  }
  return findings.sort(stableFindingSort);
}

export function buildPolishPageLoadEvidence({
  buildFingerprint,
  slug,
  routeScope,
  routes,
  viewports,
  captures,
} = {}) {
  const subject = pageLoadCheckpointSubject({ buildFingerprint, slug, routeScope, routes, viewports });
  const shapeViolations = new Map();
  const records = (Array.isArray(captures) ? captures : [])
    .map((capture) => {
      const integrityValid = validCaptureIntegrity(capture);
      const shapeViolation = captureShapeViolation(capture);
      const bindingValid = captureBindingMatches(capture, subject);
      const projected = projectCapture(capture);
      if (!integrityValid) addProjectedProblem(projected.problems, "capture_integrity_invalid");
      if (shapeViolation) addProjectedProblem(projected.problems, "capture_shape_invalid");
      if (!bindingValid) addProjectedProblem(projected.problems, "capture_binding_mismatch");
      projected.problems.sort((a, b) => a.code.localeCompare(b.code));
      const record = {
        ...projected,
        measurement_status: !shapeViolation && bindingValid ? projected.measurement_status : "incomplete",
      };
      shapeViolations.set(record, shapeViolation);
      return record;
    })
    .sort((a, b) => String(a.subject.requested_route).localeCompare(String(b.subject.requested_route))
      || String(a.subject.viewport).localeCompare(String(b.subject.viewport)));
  const expected = subject.routes.flatMap((route) => subject.viewports.map((viewport) => ({ route, viewport })));
  const counts = new Map();
  for (const capture of records) {
    const key = captureKey(capture.subject.requested_route, capture.subject.viewport);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const expectedKeys = new Set(expected.map(({ route, viewport }) => captureKey(route, viewport)));
  const missing = expected.filter(({ route, viewport }) => !counts.has(captureKey(route, viewport)));
  const duplicate = expected.filter(({ route, viewport }) => (counts.get(captureKey(route, viewport)) || 0) > 1);
  const unexpected = records
    .filter((capture) => !expectedKeys.has(captureKey(capture.subject.requested_route, capture.subject.viewport)))
    .map((capture) => ({
      route: capture.subject.requested_route,
      viewport: capture.subject.viewport,
    }));
  // A cell whose capture failed the shape rules also names the first rule it
  // broke, so a reader can see which statement the capture could not back
  // up without re-running the rules. A cell that is incomplete for another
  // reason carries no such field.
  const incomplete = records
    .filter((capture) => capture.measurement_status !== "complete")
    .map((capture) => ({
      route: capture.subject.requested_route,
      viewport: capture.subject.viewport,
      problem_codes: capture.problems.map((problem) => problem.code).sort(),
      ...(shapeViolations.get(capture) ? { shape_violation: shapeViolations.get(capture) } : {}),
    }));
  // Complete captures that still carry warning-class problems. They do not
  // block, but the operator and the merchant should see them in the verdict
  // without opening the assembly report.
  const warnings = records
    .filter((capture) => capture.measurement_status === "complete"
      && capture.problems.some((problem) => CAPTURE_WARNING_PROBLEM_CODES.has(problem.code)))
    .map((capture) => {
      const { origins, resourceTypes } = captureWarningAttribution(capture);
      return {
        route: capture.subject.requested_route,
        viewport: capture.subject.viewport,
        problem_codes: capture.problems
          .filter((problem) => CAPTURE_WARNING_PROBLEM_CODES.has(problem.code))
          .map((problem) => problem.code)
          .sort(),
        resource_types: resourceTypes,
        failed_origins: origins.slice(0, MAX_CAPTURE_WARNING_ORIGINS),
        failed_origin_count: origins.length,
      };
    });
  const subjectComplete = Boolean(isSha256(subject.build_fingerprint)
    && subject.campaign_slug
    && subject.route_scope
    && subject.routes.length
    && subject.viewports.length);
  const measurementComplete = subjectComplete
    && missing.length === 0
    && duplicate.length === 0
    && unexpected.length === 0
    && incomplete.length === 0;

  return {
    schema_version: POLISH_PAGE_LOAD_SCHEMA_VERSION,
    performed_by: POLISH_PAGE_LOAD_PRODUCER,
    threshold_bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
    subject,
    measurement: {
      status: measurementComplete ? "complete" : "incomplete",
      expected_capture_count: expected.length,
      captured_count: records.length,
      missing,
      duplicate,
      unexpected,
      incomplete,
      warnings,
    },
    captures: records,
    findings: hiddenEagerMediaFindings(records),
  };
}

// A block carries the recomputed measurement when it has one, so a verdict
// reader can see which route and viewport failed and on which problem code
// without opening the assembly report. The measurement is the deterministic
// projection this module already computes (routes, viewports, problem codes,
// origin-only warning hosts); it names no URL.
function nonwaivableBlock(code, reason, subject, measurement = null) {
  return {
    id: HIDDEN_EAGER_MEDIA_SCOPE,
    scope: HIDDEN_EAGER_MEDIA_SCOPE,
    status: "blocked",
    checkpoint_status: "blocked",
    severity: "blocker",
    code,
    reason,
    waivable: false,
    subject,
    state: null,
    state_fingerprint: null,
    findings: [],
    measurement,
    waiver: null,
    waiver_assessment: emptyWaiverAssessment(),
  };
}

export function evaluateHiddenEagerMediaCheckpoint({
  pageLoad,
  buildFingerprint,
  slug,
  routeScope,
  routes,
  viewports,
  waivers = [],
  now = new Date().toISOString(),
} = {}) {
  const subject = pageLoadCheckpointSubject({ buildFingerprint, slug, routeScope, routes, viewports });
  if (!pageLoad || typeof pageLoad !== "object" || Array.isArray(pageLoad)
    || pageLoad.schema_version !== POLISH_PAGE_LOAD_SCHEMA_VERSION
    || pageLoad.performed_by !== POLISH_PAGE_LOAD_PRODUCER
    || pageLoad.threshold_bytes !== HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES) {
    return nonwaivableBlock(
      "polish.hidden_eager_media.capture_malformed",
      "Package-owned page-load evidence is missing or malformed; incomplete capture evidence cannot be waived.",
      subject,
    );
  }
  if (canonicalJson(pageLoad.subject) !== canonicalJson(subject)) {
    return nonwaivableBlock(
      "polish.hidden_eager_media.capture_stale",
      "Page-load evidence does not match the current build fingerprint, campaign, route scope, routes, and viewports.",
      subject,
    );
  }
  const recomputed = buildPolishPageLoadEvidence({
    buildFingerprint,
    slug,
    routeScope,
    routes,
    viewports,
    captures: pageLoad.captures,
  });
  if (recomputed.measurement.status !== "complete") {
    return nonwaivableBlock(
      "polish.hidden_eager_media.capture_incomplete",
      "Page-load capture failed or lacks complete route and viewport measurement; incomplete capture evidence cannot be waived.",
      subject,
      recomputed.measurement,
    );
  }
  if (canonicalJson(pageLoad.measurement) !== canonicalJson(recomputed.measurement)
    || canonicalJson(pageLoad.findings) !== canonicalJson(recomputed.findings)) {
    return nonwaivableBlock(
      "polish.hidden_eager_media.capture_malformed",
      "Page-load measurement or findings do not match the package-owned deterministic projection.",
      subject,
    );
  }

  const findings = recomputed.findings;
  const state = { findings };
  const state_fingerprint = checkpointStateFingerprint({
    scope: HIDDEN_EAGER_MEDIA_SCOPE,
    subject,
    state,
  });
  const checkpoint = { scope: HIDDEN_EAGER_MEDIA_SCOPE, subject, state_fingerprint };
  const waiver_assessment = findings.length
    ? projectCheckpointWaiverAssessment(
      assessCheckpointWaivers(waivers, checkpoint, { now }),
      checkpoint,
    )
    : emptyWaiverAssessment();
  const waiver = findings.length ? waiver_assessment.active : null;
  const status = findings.length ? (waiver ? "waived" : "blocked") : "pass";
  return {
    id: HIDDEN_EAGER_MEDIA_SCOPE,
    scope: HIDDEN_EAGER_MEDIA_SCOPE,
    status,
    checkpoint_status: status === "waived" ? "ready_with_waivers" : status === "pass" ? "ready" : "blocked",
    severity: status === "waived" ? "warn" : status === "pass" ? "info" : "blocker",
    code: status === "waived"
      ? "polish.hidden_eager_media.waived"
      : status === "pass"
        ? "polish.hidden_eager_media.pass"
        : HIDDEN_EAGER_MEDIA_SCOPE,
    reason: status === "waived"
      ? `Page-load evidence has ${findings.length} hidden eager-media finding(s) covered by an exact named-human checkpoint waiver.`
      : status === "pass"
        ? "Page-load evidence has no hidden eager media above 1,048,576 bytes."
        : `Page-load evidence has ${findings.length} hidden eager-media finding(s) above 1,048,576 bytes.`,
    waivable: findings.length > 0,
    subject,
    state,
    state_fingerprint,
    findings,
    waiver,
    waiver_assessment,
  };
}
