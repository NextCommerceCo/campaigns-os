import { campaignIdentitiesMatch, localSpecIdentityFields } from "./spec-source-identity.mjs";
import { NO_CAPTURABLE_ROUTES_CODE } from "./local-preview-policy.mjs";
import { createHash } from "node:crypto";
import { HIDDEN_EAGER_MEDIA_ACTIONS } from "./gate-actions.mjs";
import { dirname, join, resolve } from "node:path";
import { computeBuildFingerprint } from "./built-site-scope.mjs";
import {
  buildPageLoadCapture,
  MAX_POLISH_CAPTURE_URL_LENGTH,
  normalizePageLoadRoute,
  plainHttpDependencyFailures,
} from "./polish-capture.mjs";
import {
  buildMediaWeightCell,
  buildMediaWeightRecord,
  isProbeClock,
  MEDIA_PROBE_LIMITS,
  MEDIA_WEIGHT_PRODUCER,
} from "./polish-media-weight.mjs";
import { MEDIA_WEIGHT_SCHEMA } from "./qc-results.mjs";
import {
  buildPolishPageLoadEvidence,
  evaluateHiddenEagerMediaCheckpoint,
  HIDDEN_EAGER_MEDIA_SCOPE,
  POLISH_PAGE_LOAD_PRODUCER,
  POLISH_PAGE_LOAD_SCHEMA_VERSION,
} from "./polish-page-load.mjs";
import {
  boundedPolishDeadline,
  POLISH_BROWSER_UNAVAILABLE_ERROR_CODE,
  POLISH_CAPTURE_CELL_DEADLINE_MS,
  POLISH_CAPTURE_CLOSE_DEADLINE_MS,
  POLISH_CAPTURE_STARTUP_DEADLINE_MS,
  POLISH_PRODUCER_CLEANUP_ERROR_CODE,
  POLISH_PRODUCER_TIMEOUT_ERROR_CODE,
  polishProducerCleanupError,
  polishProducerTimeoutError,
  READABILITY_ADDED_RUN_MS,
  READABILITY_CROP_RUN_MS,
  READABILITY_PROBE_CELL_MS,
  READABILITY_PROBE_RUN_MS,
  runWithPolishProducerDeadline,
} from "./polish-deadline.mjs";
import {
  buildReadabilityCell,
  buildReadabilityRecord,
  readabilityLimits,
  readabilityObservationOk,
  readabilityRoutes,
  READABILITY_PRODUCER,
  READABILITY_SCHEMA,
  writeReadabilityCrop,
} from "./polish-readability.mjs";
import {
  assemblySourcePackageMaterialFingerprint,
  currentSourcePackageMaterialFingerprint,
} from "./polish-gate.mjs";

export const POLISH_CAPTURE_VIEWPORTS = Object.freeze([
  Object.freeze({ key: "desktop", width: 1_440, height: 1_200 }),
  Object.freeze({ key: "mobile", width: 390, height: 844 }),
]);
export const MAX_POLISH_CAPTURE_ROUTES = 128;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function captureBaseUrl(value) {
  if (typeof value !== "string" || value.length > MAX_POLISH_CAPTURE_URL_LENGTH) {
    throw new Error("polish capture requires a bounded resolvable HTTP(S) --base-url.");
  }
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("polish capture requires a resolvable HTTP(S) --base-url.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("polish capture requires a resolvable HTTP(S) --base-url.");
  }
  return url;
}

function mappedPublicRoute(value, pageId) {
  if (typeof value !== "string" || value.length > MAX_POLISH_CAPTURE_URL_LENGTH) {
    throw new Error(`Polish capture page "${pageId}" has an unresolvable page_kit.public_route.`);
  }
  const raw = nonemptyString(value);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[?#\\]/.test(raw)) {
    throw new Error(`Polish capture page "${pageId}" has an unresolvable page_kit.public_route.`);
  }
  const normalized = normalizePageLoadRoute(raw);
  if (!normalized) throw new Error(`Polish capture page "${pageId}" has an unresolvable page_kit.public_route.`);
  const route = normalized === "/" ? "/" : `${normalized.replace(/\/+$/, "")}/`;
  return route;
}

function mappedSpecRoute(value, pageId) {
  if (typeof value !== "string" || value.length > MAX_POLISH_CAPTURE_URL_LENGTH) {
    throw new Error(`Polish capture page "${pageId}" is missing page_kit.spec_route.`);
  }
  const raw = value.trim();
  if (/[?#\\]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new Error(`Polish capture page "${pageId}" has an unresolvable page_kit.spec_route.`);
  }
  const normalized = raw === "" ? "/" : normalizePageLoadRoute(raw);
  if (!normalized) throw new Error(`Polish capture page "${pageId}" has an unresolvable page_kit.spec_route.`);
  const route = normalized === "/" ? "/" : `${normalized.replace(/\/+$/, "")}/`;
  return route;
}

const NO_CAPTURABLE_ROUTES_ERROR = "no_capturable_routes";

// Whether planPolishCapture refused because every mapping is template stock.
export const isNoCapturableRoutesError = (error) => error?.code === NO_CAPTURABLE_ROUTES_ERROR;

export function planPolishCapture({ packet, baseUrl } = {}) {
  if (!isPlainObject(packet) || !Array.isArray(packet?.source_html?.pages) || packet.source_html.pages.length === 0) {
    throw new Error("polish capture requires packet.source_html.pages mappings.");
  }
  if (packet.source_html.pages.length > MAX_POLISH_CAPTURE_ROUTES) {
    throw new Error(`polish capture supports at most ${MAX_POLISH_CAPTURE_ROUTES} packet route mappings per run.`);
  }
  const base = captureBaseUrl(baseUrl);
  const routes = [];
  let skipped = false;

  for (const mapping of packet.source_html.pages) {
    const pageId = typeof mapping?.page_id === "string" && mapping.page_id.length <= 128
      ? nonemptyString(mapping.page_id)
      : null;
    if (!pageId) throw new Error("Every polish capture page mapping needs page_id.");
    if (nonemptyString(mapping?.skip_reason)) {
      skipped = true;
      continue;
    }
    if (!nonemptyString(mapping?.path)) {
      throw new Error(`Polish capture page "${pageId}" is neither mapped nor explicitly skipped.`);
    }
    if (!isPlainObject(mapping?.page_kit)) {
      throw new Error(`Polish capture page "${pageId}" is missing its page_kit route mapping.`);
    }
    const requestedRoute = mappedPublicRoute(mapping.page_kit.public_route, pageId);
    const specRoute = mappedSpecRoute(mapping.page_kit.spec_route, pageId);
    routes.push({
      page_id: pageId,
      requested_route: requestedRoute,
      spec_route: specRoute,
      url: new URL(requestedRoute, base).href,
    });
  }

  if (routes.length === 0) {
    const error = new Error(
      "polish capture has no mapped non-skipped routes to capture: every mapped page is template stock (skip_reason), so there is no design route to compare."
      + " On a local or hosted preview, missing polish evidence is carried forward as a warning; run `next` for the next stage.",
    );
    error.code = NO_CAPTURABLE_ROUTES_ERROR;
    throw error;
  }
  routes.sort((a, b) => a.requested_route.localeCompare(b.requested_route) || a.page_id.localeCompare(b.page_id));
  for (let index = 1; index < routes.length; index += 1) {
    if (routes[index - 1].requested_route === routes[index].requested_route) {
      throw new Error(
        `Polish capture routes are duplicated at ${routes[index].requested_route} `
        + `(${routes[index - 1].page_id}, ${routes[index].page_id}).`,
      );
    }
  }

  return {
    route_scope: skipped ? "selected" : "all",
    routes,
    viewports: POLISH_CAPTURE_VIEWPORTS,
  };
}

// The recorded actions live in gate-actions.mjs so polish-gate, which this
// module imports, can publish the same capture action without a copy.
function recordedCheckpointActions(gate, { authorityMalformed = false, browserUnavailable = false, plainHttpProductionBuild = false } = {}) {
  const { capture, install_browser, waive, repair, repair_authority, local_proof_rebuild } = HIDDEN_EAGER_MEDIA_ACTIONS;
  if (gate?.status !== "blocked") return [];
  if (authorityMalformed) return [repair_authority, capture];
  if (browserUnavailable) return [install_browser, capture];
  // A production build captured over plain HTTP fails on its protocol-relative
  // vendor loaders; the repair is the environment, never the include, so the
  // rebuild action is named ahead of the recapture.
  if (plainHttpProductionBuild) return [local_proof_rebuild, capture];
  return gate.waivable ? [repair, capture, waive] : [capture];
}

function recordedCaptureHasProblem(pageLoad, code) {
  return Array.isArray(pageLoad?.captures) && pageLoad.captures.some((capture) => Array.isArray(capture?.problems)
    && capture.problems.some((problem) => problem?.code === code));
}

function recordedCaptureIsPlainHttpProductionBuild(pageLoad) {
  return Array.isArray(pageLoad?.captures)
    && pageLoad.captures.some((capture) => plainHttpDependencyFailures(capture).length > 0);
}

function recordedAuthorityBlock({ packet, report, plan = null, now } = {}) {
  const malformed = evaluateHiddenEagerMediaCheckpoint({
    pageLoad: null,
    buildFingerprint: report?.stages?.assembly?.build_fingerprint,
    slug: packet?.campaign?.public_route_slug,
    routeScope: plan?.route_scope || "all",
    routes: plan?.routes?.map((route) => route.requested_route) || [],
    viewports: POLISH_CAPTURE_VIEWPORTS.map((viewport) => viewport.key),
    waivers: Array.isArray(report?.waivers) ? report.waivers : [],
    ...(now === undefined ? {} : { now }),
  });
  return {
    ...malformed,
    reason: "The packet or Assembly Report authority is missing, malformed, or inconsistent; repair it before package capture.",
    required_actions: recordedCheckpointActions(malformed, { authorityMalformed: true }),
  };
}

// Every mapped page is template stock: there is nothing for polish capture to
// measure, which is missing evidence rather than a malformed packet. It stays
// a non-waivable block; the preview policy carries it forward.
function noCapturableRoutesBlock({ packet, report, now } = {}) {
  const block = recordedAuthorityBlock({ packet, report, now });
  return {
    ...block,
    code: NO_CAPTURABLE_ROUTES_CODE,
    reason: "Every mapped page is template stock (skip_reason), so this build has no design route to compare and no page-load evidence.",
    required_actions: [HIDDEN_EAGER_MEDIA_ACTIONS.map_design_route],
  };
}

function recordedCheckpointNotApplicable() {
  return {
    id: HIDDEN_EAGER_MEDIA_SCOPE,
    scope: HIDDEN_EAGER_MEDIA_SCOPE,
    status: "not_applicable",
    checkpoint_status: "not_applicable",
    severity: "info",
    code: "polish.hidden_eager_media.not_applicable",
    reason: "Hidden eager-media page-load evidence is required only after assembly is completed.",
    waivable: false,
    subject: null,
    state: null,
    state_fingerprint: null,
    findings: [],
    waiver: null,
    waiver_assessment: {
      active: null,
      inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
    },
    required_actions: [],
  };
}

export function evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report, now } = {}) {
  const assemblyStatus = nonemptyString(report?.stages?.assembly?.status);
  if (!assemblyStatus?.startsWith("completed")) return recordedCheckpointNotApplicable();

  let plan;
  try {
    plan = planPolishCapture({ packet, baseUrl: "https://polish-capture.invalid" });
  } catch (error) {
    if (error?.code === NO_CAPTURABLE_ROUTES_ERROR) return noCapturableRoutesBlock({ packet, report, now });
    return recordedAuthorityBlock({ packet, report, now });
  }

  const packetSlug = nonemptyString(packet?.campaign?.public_route_slug);
  const reportSlug = nonemptyString(report?.identity?.public_route_slug);
  if (!packetSlug || packetSlug !== reportSlug || !currentBuildFingerprint(report)) {
    return recordedAuthorityBlock({ packet, report, plan, now });
  }

  const gate = evaluateHiddenEagerMediaCheckpoint({
    pageLoad: report?.stages?.polish?.evidence?.visual_review?.page_load,
    buildFingerprint: report?.stages?.assembly?.build_fingerprint,
    slug: packetSlug,
    routeScope: plan.route_scope,
    routes: plan.routes.map((route) => route.requested_route),
    viewports: plan.viewports.map((viewport) => viewport.key),
    waivers: Array.isArray(report?.waivers) ? report.waivers : [],
    ...(now === undefined ? {} : { now }),
  });
  const pageLoad = report?.stages?.polish?.evidence?.visual_review?.page_load;
  return {
    ...gate,
    required_actions: recordedCheckpointActions(gate, {
      browserUnavailable: recordedCaptureHasProblem(pageLoad, "browser_unavailable"),
      plainHttpProductionBuild: recordedCaptureIsPlainHttpProductionBuild(pageLoad),
    }),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// Covers every package-owned capture key: a page_load, media_weight or
// readability record that changes during the browser pass refuses the
// attachment.
function conflictToken(visualReview) {
  const hasPageLoad = Object.hasOwn(visualReview, "page_load");
  const hasMediaWeight = Object.hasOwn(visualReview, "media_weight");
  const hasReadability = Object.hasOwn(visualReview, "readability");
  if (!hasPageLoad && !hasMediaWeight && !hasReadability) return "absent";
  const value = {
    ...(hasPageLoad ? { value: visualReview.page_load } : {}),
    ...(hasMediaWeight ? { media_weight: visualReview.media_weight } : {}),
    ...(hasReadability ? { readability: visualReview.readability } : {}),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function captureReportAncestors(report) {
  if (!isPlainObject(report)
    || !isPlainObject(report.stages)
    || !isPlainObject(report.stages.assembly)
    || !isPlainObject(report.stages.polish)) {
    throw new Error(
      "polish capture requires plain-object stages.polish.evidence.visual_review on the Assembly Report.",
    );
  }
  const evidence = report.stages.polish.evidence;
  if ((evidence !== undefined && !isPlainObject(evidence))
    || (isPlainObject(evidence)
      && evidence.visual_review !== undefined
      && !isPlainObject(evidence.visual_review))) {
    throw new Error(
      "polish capture requires plain-object stages.polish.evidence.visual_review on the Assembly Report.",
    );
  }
  const assemblyStatus = nonemptyString(report.stages.assembly.status);
  if (!assemblyStatus?.startsWith("completed")) {
    throw new Error("polish capture requires completed assembly before browser evidence collection.");
  }
  return {
    assembly: report.stages.assembly,
    visualReview: evidence?.visual_review || {},
  };
}

function bindingPlanProjection(plan) {
  if (!isPlainObject(plan) || !["all", "selected"].includes(plan.route_scope)
    || !Array.isArray(plan.routes) || !Array.isArray(plan.viewports)) {
    throw new Error("polish capture binding requires a valid deterministic route plan.");
  }
  return {
    route_scope: plan.route_scope,
    routes: plan.routes.map((route) => ({
      page_id: route.page_id,
      requested_route: route.requested_route,
      spec_route: route.spec_route,
      url: route.url,
    })),
    viewports: plan.viewports.map((viewport) => ({
      key: viewport.key,
      width: viewport.width,
      height: viewport.height,
    })),
  };
}

// `plan` is null for a campaign with no capturable page_load routes (every
// mapping is template stock), where the capture measures readability only.
export function createPolishCaptureBinding({ packet, report, plan, packetPath, targetRepo } = {}) {
  if (!isPlainObject(packet) || packet.schema_version !== "campaign-runtime-build-packet/v0") {
    throw new Error("polish capture requires a current campaign-runtime-build-packet/v0 packet.");
  }
  if (!isPlainObject(report) || report.schema_version !== "campaign-runtime-assembly-report/v0") {
    throw new Error("polish capture requires a current campaign-runtime-assembly-report/v0 report.");
  }
  const boundPacketPath = nonemptyString(packetPath);
  const boundTargetRepo = nonemptyString(targetRepo);
  if (!boundPacketPath || !boundTargetRepo) {
    throw new Error("polish capture binding requires the resolved packet path and target repo.");
  }
  const { assembly, visualReview } = captureReportAncestors(report);
  const slug = captureCampaignSlug(packet, report);
  const packetMapId = nonemptyString(packet?.spec?.map_id);
  const reportMapId = nonemptyString(report?.identity?.map_id);
  if (!campaignIdentitiesMatch(packet?.spec, report?.identity)) {
    throw new Error("polish capture requires matching packet and Assembly Report campaign identities.");
  }
  const buildFingerprint = currentBuildFingerprint(report);
  if (!buildFingerprint) throw new Error("polish capture requires a strict current Assembly Report build fingerprint.");
  // Bind to the output on disk, not only to the recorded string: a capture of
  // an output that has drifted from what build recorded would be evidence
  // about a build that no longer exists, and an output that changes during the
  // browser pass fails the unchanged-binding assertion after it.
  const outputFingerprint = boundOutputFingerprint(join(resolve(targetRepo), "_site", slug), slug, buildFingerprint);
  const runId = nonemptyString(report.run_id);
  const reportPacketPath = nonemptyString(report?.inputs?.packet_path);
  if (!runId || !reportPacketPath) {
    throw new Error("polish capture requires the Assembly Report run_id and inputs.packet_path identity.");
  }
  const resolvedPacketPath = resolve(boundPacketPath);
  const resolvedTargetRepo = resolve(boundTargetRepo);
  if (resolve(resolvedTargetRepo, reportPacketPath) !== resolvedPacketPath) {
    throw new Error("polish capture requires the Assembly Report packet path identity to match --packet.");
  }
  const packetTargetRepo = nonemptyString(packet?.assembly?.target_repo);
  if (!packetTargetRepo || resolve(dirname(resolvedPacketPath), packetTargetRepo) !== resolvedTargetRepo) {
    throw new Error("polish capture requires the packet target repo identity to match its resolved target.");
  }

  return canonicalize({
    packet: {
      resolved_path: resolvedPacketPath,
      resolved_target_repo: resolvedTargetRepo,
      map_id: packetMapId,
      ...localSpecIdentityFields(packet.spec),
      campaign_slug: slug,
      route_root: nonemptyString(packet?.campaign?.route_root),
      target_repo: nonemptyString(packet?.assembly?.target_repo),
    },
    report: {
      run_id: runId,
      identity: {
        map_id: reportMapId,
        ...localSpecIdentityFields(report.identity),
        public_route_slug: nonemptyString(report?.identity?.public_route_slug),
        spec_hash: nonemptyString(report?.identity?.spec_hash),
      },
      inputs_packet_path: reportPacketPath,
      assembly: {
        status: nonemptyString(assembly.status),
        build_fingerprint: buildFingerprint,
        output_fingerprint: outputFingerprint,
        source_package_material_fingerprint: assemblySourcePackageMaterialFingerprint(report),
      },
      current_source_package_material_fingerprint: currentSourcePackageMaterialFingerprint(report),
      page_load_conflict_token: conflictToken(visualReview),
    },
    plan: plan === null ? null : bindingPlanProjection(plan),
    readability_routes: readabilityRouteProjection(resolvedTargetRepo, slug),
  });
}

// The built routes readability captures, enumerated again for each binding,
// so a route set that changes during the browser pass refuses the attachment.
function readabilityRouteProjection(targetRepo, slug) {
  const built = readabilityRoutes(targetRepo, slug);
  return {
    ok: built.ok === true,
    routes: built.routes,
    uncaptured_routes: built.uncaptured_routes,
    route_enumeration_capped: built.route_enumeration_capped,
  };
}

export function assertPolishCaptureBindingUnchanged(initial, current) {
  if (canonicalJson(initial) !== canonicalJson(current)) {
    throw new Error(
      "Polish capture attachment refused because governing packet/report state or page_load changed during capture.",
    );
  }
  return true;
}

export function mergePolishPageLoadEvidence(report, pageLoad) {
  const { visualReview } = captureReportAncestors(report);
  if (!isPlainObject(pageLoad)
    || pageLoad.schema_version !== POLISH_PAGE_LOAD_SCHEMA_VERSION
    || pageLoad.performed_by !== POLISH_PAGE_LOAD_PRODUCER) {
    throw new Error("polish capture can attach only package-produced page_load evidence.");
  }
  return {
    ...report,
    stages: {
      ...report.stages,
      polish: {
        ...report.stages.polish,
        evidence: {
          ...report.stages.polish.evidence,
          visual_review: {
            ...visualReview,
            page_load: pageLoad,
          },
        },
      },
    },
  };
}

// Attaches the records of one capture. page_load attaches as
// mergePolishPageLoadEvidence does, stamped with `captured_at` when the
// command passes its clock `now` (the time of the merge, outside every
// capture's integrity). Its sibling media_weight attaches under the same
// producer and schema checks, bound to the same page_load subject; a capture
// without media_weight (an adapter that ran no image probe) removes any
// earlier media_weight. With no pageLoad (a campaign with no capturable
// page_load routes), page_load and media_weight stay exactly as they are.
// readability attaches on its own: only a package-produced record bound to
// the current build, whose every shared cell carries the integrity of the
// matching page_load capture; any other value, or none, removes an earlier
// one.
export function mergePolishCaptureEvidence(report, { pageLoad = null, mediaWeight = null, readability = null, now = null } = {}) {
  let merged;
  if (pageLoad === null || pageLoad === undefined) {
    const { visualReview } = captureReportAncestors(report);
    merged = {
      ...report,
      stages: {
        ...report.stages,
        polish: {
          ...report.stages.polish,
          evidence: { ...report.stages.polish.evidence, visual_review: { ...visualReview } },
        },
      },
    };
  } else {
    merged = mergePolishPageLoadEvidence(report, now === null || now === undefined ? pageLoad : { ...pageLoad, captured_at: new Date(now).toISOString() });
    delete merged.stages.polish.evidence.visual_review.media_weight;
    if (mediaWeight !== null && mediaWeight !== undefined) {
      if (!isPlainObject(mediaWeight)
        || mediaWeight.schema_version !== MEDIA_WEIGHT_SCHEMA
        || mediaWeight.performed_by !== MEDIA_WEIGHT_PRODUCER
        || canonicalJson(mediaWeight.subject) !== canonicalJson(pageLoad.subject)) {
        throw new Error("polish capture can attach only package-produced media_weight evidence for the same page_load capture.");
      }
      merged.stages.polish.evidence.visual_review.media_weight = mediaWeight;
    }
  }
  const visualReview = merged.stages.polish.evidence.visual_review;
  delete visualReview.readability;
  if (readabilityAttaches(readability, { buildFingerprint: currentBuildFingerprint(report), pageLoad: visualReview.page_load })) {
    visualReview.readability = readability;
  }
  return merged;
}

function readabilityAttaches(record, { buildFingerprint, pageLoad }) {
  if (!isPlainObject(record)
    || record.schema_version !== READABILITY_SCHEMA
    || record.performed_by !== READABILITY_PRODUCER
    || !buildFingerprint
    || record.subject?.build_fingerprint !== buildFingerprint
    || !Array.isArray(record.cells)) return false;
  const captures = Array.isArray(pageLoad?.captures) ? pageLoad.captures : [];
  return record.cells.every((cell) => cell?.page_load_integrity === null || captures.some((capture) => capture?.subject?.requested_route === cell.route
    && capture?.subject?.viewport === cell.viewport
    && capture?.integrity?.projection_fingerprint === cell.page_load_integrity));
}

// The spec pages the plan skips (no source mapping), for media_weight's
// page_not_captured results: the public route of each one that has a
// resolvable route, and the page id of each one that has none (a skipped
// mapping usually carries no page_kit), so no skipped page is left out.
function uncapturedPages(packet, plan) {
  const captured = new Set(plan.routes.map((route) => route.requested_route));
  const routes = [];
  const pageIds = [];
  for (const mapping of packet.source_html.pages) {
    if (!nonemptyString(mapping?.skip_reason)) continue;
    let route;
    try {
      route = mappedPublicRoute(mapping?.page_kit?.public_route, mapping?.page_id);
    } catch {
      pageIds.push(mapping.page_id);
      continue;
    }
    if (!captured.has(route)) routes.push(route);
  }
  return { routes, pageIds };
}

// The fingerprint of the built output the capture binds to. Every way of not
// having one is a named refusal, parallel to the missing recorded value: no
// built route root (build has not run here), an output the walk cannot read
// (permissions, a file vanishing mid-walk), or an output that no longer
// matches what build recorded. None of them may surface as an uncaught
// filesystem error, and none may bind as a null.
function boundOutputFingerprint(outputRoot, slug, buildFingerprint) {
  let current;
  try {
    current = computeBuildFingerprint(outputRoot);
  } catch (error) {
    throw new Error(
      `polish capture refuses: built output under _site/${slug}/ could not be read to fingerprint it `
      + `(${error?.code || error?.name || "error"}: ${error?.message || error}). Re-run build so the output is readable, then capture.`,
    );
  }
  if (!current.ok) {
    throw new Error(
      `polish capture refuses: built output root _site/${slug}/ is missing under the target repo, so there is no build to bind the capture to. `
      + "Run page-kit build and record stages.assembly.build_fingerprint first.",
    );
  }
  if (current.fingerprint !== buildFingerprint) {
    throw new Error(
      `polish capture refuses: built output under _site/${slug}/ no longer matches stages.assembly.build_fingerprint `
      + `(recorded ${buildFingerprint}, current ${current.fingerprint}). Re-run build and record the current fingerprint first.`,
    );
  }
  return current.fingerprint;
}

function currentBuildFingerprint(report) {
  const fingerprint = report?.stages?.assembly?.build_fingerprint;
  return typeof fingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint
    : null;
}

function captureCampaignSlug(packet, report) {
  const packetSlug = nonemptyString(packet?.campaign?.public_route_slug);
  const reportSlug = nonemptyString(report?.identity?.public_route_slug);
  if (!packetSlug || packetSlug !== reportSlug) {
    throw new Error("polish capture requires matching packet and Assembly Report campaign slugs.");
  }
  return packetSlug;
}

export async function capturePolishPageLoad(options = {}) {
  const plan = planPolishCapture({ packet: options.packet, baseUrl: options.baseUrl });
  return runPolishCapture({ ...options, plan });
}

// The readability-only capture of a campaign with no capturable page_load
// routes (every mapping is template stock): every built route is a
// readability-only cell; page_load and media_weight are not produced. A
// browser that cannot start is recorded on every cell.
export async function capturePolishReadability(options = {}) {
  captureBaseUrl(options.baseUrl);
  return runPolishCapture({ ...options, plan: null });
}

// Readability for one run: the built routes (readabilityRoutes) when the
// adapter has a readability probe or did not start, else null (no record is
// produced).
function readabilityScope({ adapter, startupFailed, targetRepo, slug, plan, baseUrl }) {
  if (!startupFailed && typeof adapter?.probeReadabilityRoute !== "function") return null;
  if (!nonemptyString(targetRepo)) return null;
  const built = readabilityRoutes(resolve(targetRepo), slug);
  if (!built.ok) return null;
  const base = captureBaseUrl(baseUrl);
  const shared = new Set((plan?.routes || []).map((route) => route.requested_route));
  return {
    ...built,
    shared,
    only: built.routes.filter((route) => !shared.has(route)).map((route) => ({ route, url: new URL(route, base).href })),
  };
}

async function runPolishCapture({
  packet,
  report,
  plan,
  baseUrl,
  headed = false,
  authCookie = null,
  createBrowserAdapter,
  adapterStartupDeadlineMs,
  captureCellDeadlineMs,
  adapterCloseDeadlineMs,
  probeClock = null,
  mediaProbeRunBudgetMs,
  targetRepo = null,
  now = new Date(),
} = {}) {
  const slug = captureCampaignSlug(packet, report);
  const buildFingerprint = currentBuildFingerprint(report);
  if (!buildFingerprint) throw new Error("polish capture requires a current Assembly Report build fingerprint.");
  if (typeof createBrowserAdapter !== "function") {
    throw new Error("polish capture requires a browser adapter factory.");
  }
  const startupDeadlineMs = boundedPolishDeadline(
    adapterStartupDeadlineMs,
    POLISH_CAPTURE_STARTUP_DEADLINE_MS,
  );
  const cellDeadlineMs = boundedPolishDeadline(captureCellDeadlineMs, POLISH_CAPTURE_CELL_DEADLINE_MS);
  const closeDeadlineMs = boundedPolishDeadline(
    adapterCloseDeadlineMs,
    POLISH_CAPTURE_CLOSE_DEADLINE_MS,
  );
  // The 1.3 image probe's run budget. Like the deadlines it can only shorten:
  // the CLI never passes it, and a test that spends the budget passes a
  // smaller one so that fewer slow cells spend it.
  const probeRunBudgetMs = boundedPolishDeadline(mediaProbeRunBudgetMs, MEDIA_PROBE_LIMITS.runBudgetMs);

  let adapter = null;
  // Failure is tracked apart from its reason: a rejection may carry any value,
  // including null or undefined.
  let adapterStartupFailed = false;
  let adapterStartupError = null;
  let startupTimedOut = false;
  const adapterPromise = Promise.resolve().then(() => createBrowserAdapter({
    headed: headed === true,
    authCookie: nonemptyString(authCookie),
  }));
  void adapterPromise.then((lateAdapter) => {
    if (!startupTimedOut || typeof lateAdapter?.close !== "function") return;
    void runWithPolishProducerDeadline(() => lateAdapter.close(), {
      timeoutMs: closeDeadlineMs,
      unrefTimer: true,
    }).catch(() => {});
  }, () => {});
  try {
    adapter = await runWithPolishProducerDeadline(() => adapterPromise, {
      timeoutMs: startupDeadlineMs,
      onTimeout() { startupTimedOut = true; },
    });
    if (!adapter || typeof adapter.captureRoute !== "function" || typeof adapter.close !== "function") {
      throw new Error("polish capture browser adapter must provide captureRoute() and close().");
    }
  } catch (error) {
    adapterStartupFailed = true;
    adapterStartupError = error ?? new Error("polish capture browser adapter failed to start.");
  }
  // A browser that did not start leaves every readability-only cell
  // unmeasured: producer_timeout for a startup timeout, else navigation_failed
  // (the status a shared cell reads for the same page_load failure).
  const startupStatus = !adapterStartupFailed ? null
    : adapterStartupError?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE ? "producer_timeout" : "navigation_failed";

  const scope = readabilityScope({ adapter, startupFailed: adapterStartupFailed, targetRepo, slug, plan, baseUrl });
  const clock = isProbeClock(probeClock) ? probeClock : { now: () => performance.now() };
  // The readability budgets, charged on `clock`: probe time, crop time, and
  // all readability work (shared-cell probes and crops, and readability-only
  // cells end to end). Probe and crop time are subtotals of the added work, so
  // a shared cell's probe and crop time is charged once to its own budget and
  // once to the added budget.
  const spentMs = { probe: 0, crop: 0, added: 0 };
  const readabilityProbe = () => ({
    ...(isProbeClock(probeClock) ? { clock: probeClock } : {}),
    cellBoundMs: READABILITY_PROBE_CELL_MS,
    probeRemainingMs: READABILITY_PROBE_RUN_MS - spentMs.probe,
    cropRemainingMs: READABILITY_CROP_RUN_MS - spentMs.crop,
    addedRemainingMs: READABILITY_ADDED_RUN_MS - spentMs.added,
    elementCap: readabilityLimits().elements_per_cell,
    cropsPerCell: readabilityLimits().crops_per_cell,
  });
  const chargeReadability = (observation, addedMs) => {
    if (Number.isFinite(observation?.probe_ms) && observation.probe_ms > 0) spentMs.probe += observation.probe_ms;
    if (Number.isFinite(observation?.crop_ms) && observation.crop_ms > 0) spentMs.crop += observation.crop_ms;
    if (Number.isFinite(addedMs) && addedMs > 0) spentMs.added += addedMs;
  };

  const captures = [];
  // Per cell, beside its capture: the adapter's observation and image probe,
  // for the media_weight record.
  const cellInputs = [];
  // Readability-only cells, each { route, viewport, status, observation }.
  const readabilityOnly = [];
  let probeSpentMs = 0;
  let probed = false;
  // As for startup, a close failure is tracked apart from its reason.
  let adapterCloseFailed = false;
  let adapterCloseError = null;
  let adapterPoisonProblem = null;
  let observedProducerTimeout = false;
  let adapterClosePromise = null;
  // Whether page_load's cells were all run when the adapter failed to close:
  // a close failure after readability-only cells never changes page_load.
  let closeFailedAfterGrid = false;
  let gridDone = false;
  const closeAdapter = async () => {
    if (!adapter || typeof adapter.close !== "function") return;
    if (!adapterClosePromise) {
      adapterClosePromise = runWithPolishProducerDeadline(() => adapter.close(), {
        timeoutMs: closeDeadlineMs,
      });
    }
    return adapterClosePromise;
  };
  // A producer timeout or cleanup failure poisons the adapter for every later
  // cell, and closes it.
  const poison = async (error) => {
    const producerTimedOut = error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
    const producerCleanupFailed = error?.code === POLISH_PRODUCER_CLEANUP_ERROR_CODE;
    if (producerTimedOut) observedProducerTimeout = true;
    if ((producerTimedOut || producerCleanupFailed) && adapter && !adapterPoisonProblem) {
      adapterPoisonProblem = producerTimedOut ? "producer_timeout" : "producer_failed";
      try {
        await closeAdapter();
      } catch (closeError) {
        adapterCloseFailed = true;
        adapterCloseError = closeError;
        closeFailedAfterGrid = gridDone;
      }
    }
  };
  try {
    for (const route of plan?.routes || []) {
      for (const viewport of plan.viewports) {
        let observation;
        let cellFailed = false;
        const readabilityShared = scope?.shared.has(route.requested_route) && scope.routes.includes(route.requested_route);
        try {
          if (adapterStartupFailed) throw adapterStartupError;
          if (adapterPoisonProblem) {
            throw adapterPoisonProblem === "producer_timeout"
              ? polishProducerTimeoutError()
              : polishProducerCleanupError();
          }
          const abortController = new AbortController();
          const imageProbe = {
            ...(isProbeClock(probeClock) ? { clock: probeClock } : {}),
            remainingMs: probeRunBudgetMs - probeSpentMs,
            cellBoundMs: MEDIA_PROBE_LIMITS.cellBoundMs,
            imageCap: MEDIA_PROBE_LIMITS.imageCap,
          };
          observation = await runWithPolishProducerDeadline(
            () => adapter.captureRoute({
              url: route.url,
              viewport,
              signal: abortController.signal,
              imageProbe,
              ...(readabilityShared ? { readabilityProbe: readabilityProbe() } : {}),
            }),
            {
              timeoutMs: cellDeadlineMs,
              onTimeout() { abortController.abort(); },
            },
          );
          if (!isPlainObject(observation)) throw new Error("Browser adapter returned no route observation.");
        } catch (error) {
          const browserUnavailable = error?.code === POLISH_BROWSER_UNAVAILABLE_ERROR_CODE;
          const producerTimedOut = error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
          await poison(error);
          cellFailed = true;
          observation = {
            finalDocumentUrl: route.url,
            responseCollectionStatus: "failed",
            networkidle: { status: "invalid", duration_ms: null },
            producerProblem: browserUnavailable
              ? "browser_unavailable"
              : producerTimedOut ? "producer_timeout" : "producer_failed",
          };
        }
        const probe = !cellFailed && isPlainObject(observation.imageProbe) ? observation.imageProbe : null;
        if (probe) probed = true;
        if (Number.isFinite(probe?.spent_ms) && probe.spent_ms > 0) probeSpentMs += probe.spent_ms;
        if (readabilityShared && !cellFailed) chargeReadability(observation.readability, (observation.readability?.probe_ms || 0) + (observation.readability?.crop_ms || 0));
        cellInputs.push({ route: route.requested_route, viewport: viewport.key, observation: cellFailed ? null : observation, probe });
        captures.push(buildPageLoadCapture({
          buildFingerprint,
          slug,
          requestedRoute: route.requested_route,
          viewport: viewport.key,
          requestedDocumentUrl: route.url,
          finalDocumentUrl: observation.finalDocumentUrl,
          responseCollectionStatus: observation.responseCollectionStatus,
          networkidle: observation.networkidle,
          mediaElements: observation.mediaElements,
          responses: observation.responses,
          producerError: observation.producerError,
          producerProblem: observation.producerProblem,
        }));
      }
    }
    gridDone = true;

    // Readability-only cells, after every page_load cell, each in a fresh
    // context, under the producer cell deadline and the run budgets. A cell
    // that starts once the added budget is spent reads run_budget_exhausted;
    // after a producer timeout, every later cell reads producer_timeout and
    // none is tried again.
    for (const { route, url } of scope?.only || []) {
      for (const viewport of POLISH_CAPTURE_VIEWPORTS) {
        const cell = { route, viewport: viewport.key, status: null, observation: null };
        readabilityOnly.push(cell);
        if (startupStatus) {
          cell.status = startupStatus;
          continue;
        }
        if (adapterPoisonProblem) {
          cell.status = adapterPoisonProblem === "producer_timeout" ? "producer_timeout" : "navigation_failed";
          continue;
        }
        if (!(READABILITY_ADDED_RUN_MS - spentMs.added > 0)) {
          cell.status = "run_budget_exhausted";
          continue;
        }
        const started = clock.now();
        let observation = null;
        try {
          const abortController = new AbortController();
          observation = await runWithPolishProducerDeadline(
            () => adapter.probeReadabilityRoute({ route, url }, viewport, { signal: abortController.signal, probe: readabilityProbe() }),
            {
              timeoutMs: cellDeadlineMs,
              onTimeout() { abortController.abort(); },
            },
          );
        } catch (error) {
          await poison(error);
          cell.status = error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE ? "producer_timeout" : "navigation_failed";
        }
        const elapsedMs = Math.max(0, clock.now() - started);
        chargeReadability(observation, elapsedMs);
        if (cell.status) continue;
        // An observation outside the record vocabulary is no measurement: its
        // probe ran out its bound on the clock, or returned nothing.
        if (readabilityObservationOk(observation)) {
          cell.status = observation.status;
          cell.observation = observation;
        } else {
          cell.status = elapsedMs >= READABILITY_PROBE_CELL_MS ? "probe_timeout" : "document_changed";
        }
      }
    }
  } finally {
    if (adapter && !adapterCloseFailed) {
      try {
        await closeAdapter();
      } catch (error) {
        adapterCloseFailed = true;
        adapterCloseError = error;
        closeFailedAfterGrid = gridDone && readabilityOnly.length > 0;
      }
    }
  }

  const closeProblem = observedProducerTimeout
    || adapterCloseError?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE
    ? "producer_timeout"
    : "producer_failed";
  if (adapterCloseFailed && !closeFailedAfterGrid) {
    captures.length = 0;
    for (const input of cellInputs) Object.assign(input, { observation: null, probe: null });
    for (const route of plan?.routes || []) {
      for (const viewport of plan.viewports) {
        captures.push(buildPageLoadCapture({
          buildFingerprint,
          slug,
          requestedRoute: route.requested_route,
          viewport: viewport.key,
          requestedDocumentUrl: route.url,
          finalDocumentUrl: route.url,
          responseCollectionStatus: "failed",
          networkidle: { status: "invalid", duration_ms: null },
          producerProblem: closeProblem,
        }));
      }
    }
  }

  const readability = scope ? buildRunReadability({
    scope,
    cellInputs,
    readabilityOnly,
    captures,
    // A browser that did not close cleanly leaves every readability cell
    // unmeasured.
    closeStatus: adapterCloseFailed ? (closeProblem === "producer_timeout" ? "producer_timeout" : "navigation_failed") : null,
    report,
    buildFingerprint,
    slug,
    targetRepo,
    now,
  }) : null;
  const withReadability = (result) => (readability ? { ...result, readability } : result);
  if (plan === null) return withReadability({ plan: null });

  const routes = plan.routes.map((route) => route.requested_route);
  const viewports = plan.viewports.map((viewport) => viewport.key);
  const pageLoad = buildPolishPageLoadEvidence({
    buildFingerprint,
    slug,
    routeScope: plan.route_scope,
    routes,
    viewports,
    captures,
  });
  // The image probe's sibling record, when the adapter ran the probe. Each
  // cell is stamped with the integrity of its page_load capture.
  if (!probed) return withReadability({ plan, page_load: pageLoad });
  const uncaptured = uncapturedPages(packet, plan);
  const mediaWeight = buildMediaWeightRecord({
    pageLoad,
    cells: cellInputs.map((input) => buildMediaWeightCell({
      ...input,
      capture: pageLoad.captures.find((capture) => capture.subject.requested_route === input.route
        && capture.subject.viewport === input.viewport),
    })),
    uncapturedRoutes: uncaptured.routes,
    uncapturedPageIds: uncaptured.pageIds,
  });
  return withReadability({ plan, page_load: pageLoad, media_weight: mediaWeight });
}

// The readability record of one run: one cell per captured built route ×
// viewport. A shared cell (a route in page_load's grid) carries its probe from
// the page_load cell and that capture's integrity; it reads producer_timeout
// or navigation_failed when its page_load cell failed, and document_changed
// when the cell returned no readability read. Readability-only cells carry
// their own status.
function buildRunReadability({ scope, cellInputs, readabilityOnly, captures, closeStatus, report, buildFingerprint, slug, targetRepo, now }) {
  const writeCrop = (bytes) => writeReadabilityCrop(resolve(targetRepo), bytes);
  const cells = [];
  for (const route of scope.routes) {
    for (const viewport of POLISH_CAPTURE_VIEWPORTS) {
      const key = viewport.key;
      if (scope.shared.has(route)) {
        const input = cellInputs.find((entry) => entry.route === route && entry.viewport === key);
        const capture = captures.find((entry) => entry.subject.requested_route === route && entry.subject.viewport === key);
        const failed = (Array.isArray(capture?.problems) ? capture.problems : []).find((problem) => ["producer_timeout", "producer_failed", "browser_unavailable"].includes(problem?.code));
        const observation = input?.observation?.readability;
        const status = closeStatus
          ?? (failed ? (failed.code === "producer_timeout" ? "producer_timeout" : "navigation_failed")
            : readabilityObservationOk(observation) ? observation.status : "document_changed");
        cells.push(buildReadabilityCell({
          route,
          viewport: key,
          pageLoadIntegrity: capture?.integrity?.projection_fingerprint ?? null,
          status,
          observation: status === "measured" ? observation : null,
          writeCrop,
        }));
        continue;
      }
      const only = readabilityOnly.find((entry) => entry.route === route && entry.viewport === key);
      const status = closeStatus ?? only?.status ?? "navigation_failed";
      cells.push(buildReadabilityCell({ route, viewport: key, status, observation: status === "measured" ? only.observation : null, writeCrop }));
    }
  }
  return buildReadabilityRecord({
    buildFingerprint,
    sourceFingerprint: currentSourcePackageMaterialFingerprint(report),
    slug,
    routes: scope.routes,
    uncapturedRoutes: scope.uncaptured_routes,
    routeEnumerationCapped: scope.route_enumeration_capped,
    cells,
    measuredAt: now,
  });
}
