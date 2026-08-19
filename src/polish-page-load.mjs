import {
  normalizePageLoadRoute,
  POLISH_CAPTURE_PRODUCER,
  POLISH_ROUTE_CAPTURE_SCHEMA_VERSION,
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
const CAPTURE_PROBLEM_CODES = new Set([
  "cache_observed",
  "capture_shape_invalid",
  "duplicate_request_identity",
  "media_collection_unavailable",
  "media_measurement_failed",
  "media_source_unresolvable",
  "networkidle_measurement_invalid",
  "producer_failed",
  "request_failed",
  "request_identity_invalid",
  "resource_aliases_invalid",
  "resource_url_unresolvable",
  "response_collection_empty",
  "response_collection_failed",
  "response_collection_status_invalid",
  "response_collection_unavailable",
  "service_worker_observed",
  "transfer_size_unavailable",
]);

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeString(value)?.toLocaleLowerCase("en-US"))
    .filter(Boolean))].sort();
}

function normalizedRoutes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizePageLoadRoute)
    .filter(Boolean))].sort();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function emptyWaiverAssessment() {
  return {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  };
}

export function pageLoadCheckpointSubject({ buildFingerprint, slug, routeScope, routes, viewports } = {}) {
  return {
    build_fingerprint: normalizeString(buildFingerprint),
    campaign_slug: normalizeString(slug),
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

function validResourceProjection(resource) {
  return Boolean(resource)
    && typeof resource === "object"
    && !Array.isArray(resource)
    && typeof resource.url === "string"
    && resource.url.trim() !== ""
    && !/[?#]/.test(resource.url)
    && (resource.matched_source == null
      || (typeof resource.matched_source === "string"
        && resource.matched_source.trim() !== ""
        && !/[?#]/.test(resource.matched_source)))
    && isNonnegativeInteger(resource.transferred_bytes)
    && isNonnegativeInteger(resource.request_count);
}

function isSortedUniqueStrings(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return false;
  const canonical = [...new Set(values)].sort();
  return canonical.length === values.length && canonical.every((value, index) => value === values[index]);
}

function validMediaProjection(media) {
  if (!media || typeof media !== "object" || Array.isArray(media)) return false;
  if (media.tag_name !== "video" && media.tag_name !== "audio") return false;
  if (!isNonnegativeInteger(media.element_index)) return false;
  if (!isSortedUniqueStrings(media.sources) || media.sources.some((source) => /[?#]/.test(source))) return false;
  if (media.preload !== null && typeof media.preload !== "string") return false;
  if (typeof media.preload_defers_fetch !== "boolean"
    || typeof media.hidden_at_load !== "boolean"
    || (media.zero_size_at_load !== null && typeof media.zero_size_at_load !== "boolean")) return false;
  if (!isSortedUniqueStrings(media.hidden_by)
    || media.hidden_by.some((kind) => kind !== "display_none" && kind !== "visibility_hidden")) return false;
  if (media.hidden_at_load !== (media.hidden_by.length > 0)) return false;
  if (media.preload_defers_fetch !== (media.preload === "none" || media.preload === "metadata")) return false;
  if (!isNonnegativeInteger(media.fetched_bytes)
    || !isNonnegativeInteger(media.fetched_request_count)
    || !Array.isArray(media.fetched_resources)
    || media.fetched_resources.some((resource) => !validResourceProjection(resource))) return false;
  if (media.fetched_resources.some((resource) => !media.sources.includes(resource.matched_source || resource.url))) return false;
  const resourceUrls = media.fetched_resources.map((resource) => resource.url);
  if (!isSortedUniqueStrings(resourceUrls)) return false;
  const bytes = media.fetched_resources.reduce((sum, resource) => sum + resource.transferred_bytes, 0);
  const requests = media.fetched_resources.reduce((sum, resource) => sum + resource.request_count, 0);
  return bytes === media.fetched_bytes && requests === media.fetched_request_count;
}

function validCaptureShape(capture) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return false;
  if (capture.schema_version !== POLISH_ROUTE_CAPTURE_SCHEMA_VERSION
    || capture.performed_by !== POLISH_CAPTURE_PRODUCER) return false;
  if (capture.measurement_status !== "complete" && capture.measurement_status !== "incomplete") return false;
  if (!capture.response_collection
    || (capture.response_collection.status !== "complete" && capture.response_collection.status !== "failed")
    || !isNonnegativeInteger(capture.response_collection.observed_response_count)) return false;
  if (!capture.networkidle
    || (capture.networkidle.status !== "settled" && capture.networkidle.status !== "timeout")
    || !isNonnegativeInteger(capture.networkidle.duration_ms)) return false;
  if (!capture.metrics || typeof capture.metrics !== "object" || Array.isArray(capture.metrics)) return false;
  for (const field of [
    "total_transferred_bytes",
    "request_count",
    "cross_origin_request_count",
    "cache_request_count",
    "service_worker_request_count",
  ]) {
    if (!isNonnegativeInteger(capture.metrics[field])) return false;
  }
  if (capture.metrics.largest_resource !== null && !validResourceProjection(capture.metrics.largest_resource)) return false;
  if (capture.response_collection.observed_response_count !== capture.metrics.request_count) return false;
  if (!Array.isArray(capture.media) || capture.media.some((media) => !validMediaProjection(media))) return false;
  if (!capture.media.every((media, index) => media.element_index === index)) return false;
  if (!Array.isArray(capture.problems)
    || capture.problems.some((problem) => !problem
      || typeof problem.code !== "string"
      || !problem.code.trim()
      || !CAPTURE_PROBLEM_CODES.has(problem.code)
      || !Number.isInteger(problem.count)
      || problem.count <= 0)) return false;
  const problemCount = (code) => capture.problems
    .filter((problem) => problem.code === code)
    .reduce((sum, problem) => sum + problem.count, 0);
  if ((capture.response_collection.status === "failed") !== (problemCount("response_collection_failed") > 0)) return false;
  if (capture.response_collection.status === "complete") {
    if ((capture.response_collection.observed_response_count === 0)
      !== (problemCount("response_collection_empty") > 0)) return false;
  }
  const unresolvedHiddenEagerMedia = capture.media.filter((media) => media.hidden_at_load
    && !media.preload_defers_fetch
    && media.sources.some((source) => !/^https?:\/\//.test(source))).length;
  if (problemCount("media_source_unresolvable") !== unresolvedHiddenEagerMedia) return false;
  return (capture.measurement_status === "complete") === (capture.problems.length === 0);
}

function projectResource(resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return null;
  return {
    url: typeof resource.url === "string" ? resource.url : null,
    ...(typeof resource.matched_source === "string" ? { matched_source: resource.matched_source } : {}),
    ...(typeof resource.resource_type === "string" ? { resource_type: resource.resource_type } : {}),
    transferred_bytes: resource.transferred_bytes,
    request_count: resource.request_count,
  };
}

function projectMedia(media) {
  const fetchedResources = (Array.isArray(media?.fetched_resources) ? media.fetched_resources : [])
    .map(projectResource)
    .filter(Boolean)
    .sort((a, b) => String(a.url).localeCompare(String(b.url)));
  return {
    tag_name: media?.tag_name,
    element_index: media?.element_index,
    sources: [...(Array.isArray(media?.sources) ? media.sources : [])].sort(),
    preload: media?.preload ?? null,
    preload_defers_fetch: media?.preload_defers_fetch,
    hidden_at_load: media?.hidden_at_load,
    hidden_by: [...(Array.isArray(media?.hidden_by) ? media.hidden_by : [])].sort(),
    zero_size_at_load: media?.zero_size_at_load,
    fetched_bytes: media?.fetched_bytes,
    fetched_request_count: media?.fetched_request_count,
    fetched_resources: fetchedResources,
  };
}

function projectCapture(capture) {
  return {
    schema_version: capture?.schema_version === POLISH_ROUTE_CAPTURE_SCHEMA_VERSION
      ? POLISH_ROUTE_CAPTURE_SCHEMA_VERSION
      : null,
    performed_by: capture?.performed_by === POLISH_CAPTURE_PRODUCER
      ? POLISH_CAPTURE_PRODUCER
      : null,
    route: normalizePageLoadRoute(capture?.route),
    viewport: normalizeString(capture?.viewport)?.toLocaleLowerCase("en-US") || null,
    measurement_status: capture?.measurement_status,
    response_collection: capture?.response_collection && typeof capture.response_collection === "object" ? {
      status: capture.response_collection.status === "complete" || capture.response_collection.status === "failed"
        ? capture.response_collection.status
        : "invalid",
      observed_response_count: capture.response_collection.observed_response_count,
    } : null,
    networkidle: capture?.networkidle && typeof capture.networkidle === "object" ? {
      status: capture.networkidle.status,
      duration_ms: capture.networkidle.duration_ms,
    } : null,
    metrics: capture?.metrics && typeof capture.metrics === "object" ? {
      total_transferred_bytes: capture.metrics.total_transferred_bytes,
      request_count: capture.metrics.request_count,
      largest_resource: projectResource(capture.metrics.largest_resource),
      cross_origin_request_count: capture.metrics.cross_origin_request_count,
      cache_request_count: capture.metrics.cache_request_count,
      service_worker_request_count: capture.metrics.service_worker_request_count,
    } : null,
    media: (Array.isArray(capture?.media) ? capture.media : []).map(projectMedia),
    problems: (Array.isArray(capture?.problems) ? capture.problems : [])
      .filter((problem) => CAPTURE_PROBLEM_CODES.has(problem?.code))
      .map((problem) => ({ code: problem.code, count: problem.count }))
      .sort((a, b) => String(a.code).localeCompare(String(b.code))),
  };
}

function stableFindingSort(a, b) {
  return a.route.localeCompare(b.route)
    || a.viewport.localeCompare(b.viewport)
    || a.element_index - b.element_index
    || a.sources.join("\u0000").localeCompare(b.sources.join("\u0000"));
}

function hiddenEagerMediaFindings(captures) {
  const findings = [];
  for (const capture of captures) {
    for (const media of (Array.isArray(capture?.media) ? capture.media : [])) {
      if (!media?.hidden_at_load || media?.preload_defers_fetch) continue;
      if (!Number.isInteger(media.fetched_bytes)
        || media.fetched_bytes <= HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES) continue;
      findings.push({
        code: HIDDEN_EAGER_MEDIA_SCOPE,
        route: capture.route,
        viewport: capture.viewport,
        tag_name: media.tag_name,
        element_index: media.element_index,
        sources: [...new Set((Array.isArray(media.fetched_resources) ? media.fetched_resources : [])
          .map((resource) => resource?.url)
          .filter(Boolean))].sort(),
        transferred_bytes: media.fetched_bytes,
        threshold_bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
        preload: media.preload,
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
  const records = (Array.isArray(captures) ? captures : [])
    .map((capture) => {
      const shapeValid = validCaptureShape(capture);
      const projected = projectCapture(capture);
      const problems = projected.problems;
      if (!shapeValid && !problems.some((problem) => problem.code === "capture_shape_invalid")) {
        problems.push({ code: "capture_shape_invalid", count: 1 });
      }
      return {
        ...projected,
        measurement_status: shapeValid ? projected.measurement_status : "incomplete",
        problems: problems.sort((a, b) => String(a.code).localeCompare(String(b.code))),
      };
    })
    .sort((a, b) => String(a.route).localeCompare(String(b.route))
      || String(a.viewport).localeCompare(String(b.viewport)));
  const expected = subject.routes.flatMap((route) => subject.viewports.map((viewport) => ({ route, viewport })));
  const counts = new Map();
  for (const capture of records) {
    const key = captureKey(capture.route, capture.viewport);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const expectedKeys = new Set(expected.map(({ route, viewport }) => captureKey(route, viewport)));
  const missing = expected.filter(({ route, viewport }) => !counts.has(captureKey(route, viewport)));
  const duplicate = expected.filter(({ route, viewport }) => (counts.get(captureKey(route, viewport)) || 0) > 1);
  const unexpected = records
    .filter((capture) => !expectedKeys.has(captureKey(capture.route, capture.viewport)))
    .map(({ route, viewport }) => ({ route, viewport }));
  const incomplete = records
    .filter((capture) => capture.measurement_status !== "complete")
    .map(({ route, viewport, problems }) => ({
      route,
      viewport,
      problem_codes: (Array.isArray(problems) ? problems : []).map((problem) => problem?.code).filter(Boolean).sort(),
    }));
  const subjectComplete = Boolean(subject.build_fingerprint
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
    },
    captures: records,
    findings: hiddenEagerMediaFindings(records),
  };
}

function nonwaivableBlock(code, reason, subject) {
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
