import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  buildPageLoadCapture,
  normalizePageLoadRoute,
} from "./polish-capture.mjs";
import {
  buildPolishPageLoadEvidence,
  evaluateHiddenEagerMediaCheckpoint,
  HIDDEN_EAGER_MEDIA_SCOPE,
  POLISH_PAGE_LOAD_PRODUCER,
  POLISH_PAGE_LOAD_SCHEMA_VERSION,
} from "./polish-page-load.mjs";
import {
  assemblySourcePackageMaterialFingerprint,
  currentSourcePackageMaterialFingerprint,
} from "./polish-gate.mjs";

export const POLISH_CAPTURE_VIEWPORTS = Object.freeze([
  Object.freeze({ key: "desktop", width: 1_440, height: 1_200 }),
  Object.freeze({ key: "mobile", width: 390, height: 844 }),
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function captureBaseUrl(value) {
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
  if (typeof value !== "string") {
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

export function planPolishCapture({ packet, baseUrl } = {}) {
  if (!isPlainObject(packet) || !Array.isArray(packet?.source_html?.pages) || packet.source_html.pages.length === 0) {
    throw new Error("polish capture requires packet.source_html.pages mappings.");
  }
  const base = captureBaseUrl(baseUrl);
  const routes = [];
  let skipped = false;

  for (const mapping of packet.source_html.pages) {
    const pageId = nonemptyString(mapping?.page_id);
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

  if (routes.length === 0) throw new Error("polish capture has no mapped non-skipped routes to capture.");
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

const RECORDED_CAPTURE_ACTION = Object.freeze({
  id: "polish.hidden_eager_media.capture",
  kind: "command",
  command: "campaigns-os polish capture --packet <packet> --base-url <url>",
  description: "Capture package-owned page-load evidence for every mapped route and fixed viewport.",
});

const RECORDED_WAIVER_ACTION = Object.freeze({
  id: "polish.hidden_eager_media.waive",
  kind: "command",
  command: "campaigns-os checkpoint waive --packet <packet> --gate polish.hidden_eager_media --reason \"<why>\" --waived-by \"<named human>\" --review-condition \"<trigger>\"",
  description: "Record an exact named-human waiver for the current hidden eager-media findings.",
});

const RECORDED_REPAIR_ACTION = Object.freeze({
  id: "polish.hidden_eager_media.repair",
  kind: "manual",
  command: null,
  description: "Make each reported hidden media element visible, defer it with exact preload=none/metadata, or reduce its aggregate transferred bytes to at most 1,048,576; then recapture.",
});

function recordedCheckpointActions(gate) {
  if (gate?.status !== "blocked") return [];
  return gate.waivable
    ? [RECORDED_REPAIR_ACTION, RECORDED_CAPTURE_ACTION, RECORDED_WAIVER_ACTION]
    : [RECORDED_CAPTURE_ACTION];
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
  } catch {
    const malformed = evaluateHiddenEagerMediaCheckpoint({
      pageLoad: null,
      buildFingerprint: report?.stages?.assembly?.build_fingerprint,
      slug: packet?.campaign?.public_route_slug,
      routeScope: "all",
      routes: [],
      viewports: POLISH_CAPTURE_VIEWPORTS.map((viewport) => viewport.key),
      waivers: Array.isArray(report?.waivers) ? report.waivers : [],
      ...(now === undefined ? {} : { now }),
    });
    return { ...malformed, required_actions: recordedCheckpointActions(malformed) };
  }

  const gate = evaluateHiddenEagerMediaCheckpoint({
    pageLoad: report?.stages?.polish?.evidence?.visual_review?.page_load,
    buildFingerprint: report?.stages?.assembly?.build_fingerprint,
    slug: packet?.campaign?.public_route_slug,
    routeScope: plan.route_scope,
    routes: plan.routes.map((route) => route.requested_route),
    viewports: plan.viewports.map((viewport) => viewport.key),
    waivers: Array.isArray(report?.waivers) ? report.waivers : [],
    ...(now === undefined ? {} : { now }),
  });
  return { ...gate, required_actions: recordedCheckpointActions(gate) };
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

function conflictToken(visualReview) {
  if (!Object.hasOwn(visualReview, "page_load")) return "absent";
  return `sha256:${createHash("sha256").update(canonicalJson({ value: visualReview.page_load })).digest("hex")}`;
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
  if (!packetMapId || packetMapId !== reportMapId) {
    throw new Error("polish capture requires matching packet and Assembly Report map identities.");
  }
  const buildFingerprint = currentBuildFingerprint(report);
  if (!buildFingerprint) throw new Error("polish capture requires a strict current Assembly Report build fingerprint.");
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
      campaign_slug: slug,
      route_root: nonemptyString(packet?.campaign?.route_root),
      target_repo: nonemptyString(packet?.assembly?.target_repo),
    },
    report: {
      run_id: runId,
      identity: {
        map_id: reportMapId,
        public_route_slug: nonemptyString(report?.identity?.public_route_slug),
        spec_hash: nonemptyString(report?.identity?.spec_hash),
      },
      inputs_packet_path: reportPacketPath,
      assembly: {
        status: nonemptyString(assembly.status),
        build_fingerprint: buildFingerprint,
        source_package_material_fingerprint: assemblySourcePackageMaterialFingerprint(report),
      },
      current_source_package_material_fingerprint: currentSourcePackageMaterialFingerprint(report),
      page_load_conflict_token: conflictToken(visualReview),
    },
    plan: bindingPlanProjection(plan),
  });
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

export async function capturePolishPageLoad({
  packet,
  report,
  baseUrl,
  headed = false,
  authCookie = null,
  createBrowserAdapter,
} = {}) {
  const plan = planPolishCapture({ packet, baseUrl });
  const slug = captureCampaignSlug(packet, report);
  const buildFingerprint = currentBuildFingerprint(report);
  if (!buildFingerprint) throw new Error("polish capture requires a current Assembly Report build fingerprint.");
  if (typeof createBrowserAdapter !== "function") {
    throw new Error("polish capture requires a browser adapter factory.");
  }

  let adapter = null;
  let adapterStartupError = null;
  try {
    adapter = await createBrowserAdapter({
      headed: headed === true,
      authCookie: nonemptyString(authCookie),
    });
    if (!adapter || typeof adapter.captureRoute !== "function" || typeof adapter.close !== "function") {
      throw new Error("polish capture browser adapter must provide captureRoute() and close().");
    }
  } catch (error) {
    adapterStartupError = error;
  }

  const captures = [];
  let adapterCloseError = null;
  try {
    for (const route of plan.routes) {
      for (const viewport of plan.viewports) {
        let observation;
        try {
          if (adapterStartupError) throw adapterStartupError;
          observation = await adapter.captureRoute({ url: route.url, viewport });
          if (!isPlainObject(observation)) throw new Error("Browser adapter returned no route observation.");
        } catch (error) {
          observation = {
            finalDocumentUrl: route.url,
            responseCollectionStatus: "failed",
            networkidle: { status: "timeout", duration_ms: 0 },
            producerError: error,
          };
        }
        captures.push(buildPageLoadCapture({
          buildFingerprint,
          slug,
          requestedRoute: route.requested_route,
          viewport: viewport.key,
          finalDocumentUrl: observation.finalDocumentUrl,
          responseCollectionStatus: observation.responseCollectionStatus,
          networkidle: observation.networkidle,
          mediaElements: observation.mediaElements,
          responses: observation.responses,
          producerError: observation.producerError,
        }));
      }
    }
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch (error) {
        adapterCloseError = error;
      }
    }
  }

  if (adapterCloseError) {
    captures.length = 0;
    for (const route of plan.routes) {
      for (const viewport of plan.viewports) {
        captures.push(buildPageLoadCapture({
          buildFingerprint,
          slug,
          requestedRoute: route.requested_route,
          viewport: viewport.key,
          finalDocumentUrl: route.url,
          responseCollectionStatus: "failed",
          networkidle: { status: "timeout", duration_ms: 0 },
          producerError: adapterCloseError,
        }));
      }
    }
  }

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
  const checkpoint = evaluateHiddenEagerMediaCheckpoint({
    pageLoad,
    buildFingerprint,
    slug,
    routeScope: plan.route_scope,
    routes,
    viewports,
    waivers: Array.isArray(report?.waivers) ? report.waivers : [],
  });
  return { plan, page_load: pageLoad, checkpoint };
}
