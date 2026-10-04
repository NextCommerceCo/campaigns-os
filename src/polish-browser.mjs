import { createHash } from "node:crypto";
import { invocationPrefixFor } from "./install-mode.mjs";
import { dirname as installModeDirname, resolve as installModeResolve } from "node:path";
import { fileURLToPath as installModeFileUrl } from "node:url";
const PACKAGE_ROOT = installModeResolve(installModeDirname(installModeFileUrl(import.meta.url)), "..");

import {
  captureOrigin,
  captureProblemRecord,
  MAX_PAGE_LOAD_MEDIA_ANCESTORS,
  MAX_PAGE_LOAD_MEDIA_ELEMENTS,
  MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  MAX_PAGE_LOAD_RESPONSE_RECORDS,
  MAX_POLISH_CAPTURE_URL_LENGTH,
  redirectChainRecord,
  singleResponseRecord,
} from "./polish-capture.mjs";
import { launchPackageChromium, PLAYWRIGHT_INSTALL_HINT } from "./browser-launch.mjs";
import {
  boundedPolishDeadline,
  POLISH_BROWSER_CELL_DEADLINE_MS,
  POLISH_BROWSER_UNAVAILABLE_ERROR_CODE,
  POLISH_BROWSER_CLEANUP_DEADLINE_MS,
  POLISH_BROWSER_STARTUP_DEADLINE_MS,
  POLISH_PRODUCER_CLEANUP_ERROR_CODE,
  POLISH_PRODUCER_TIMEOUT_ERROR_CODE,
  polishProducerCleanupError,
  polishProducerTimeoutError,
  runWithPolishProducerDeadline,
} from "./polish-deadline.mjs";

const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORKIDLE_TIMEOUT_MS = 5_000;

const NETWORK_EVENTS = Object.freeze([
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.dataReceived",
  "Network.requestServedFromCache",
]);

const AUTH_COOKIE_ERROR = "Campaigns OS polish capture received a malformed or empty --auth-cookie value.";
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function browserUnavailableError(message) {
  const error = new Error(message);
  error.code = POLISH_BROWSER_UNAVAILABLE_ERROR_CODE;
  return error;
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

// A non-http(s) URL (data:, blob:, about:, an extension scheme) is kept as
// its scheme alone: the payload of a data: URL is page content, not a
// network address, and bounding it by length would misreport a long inline
// image as an overflow instead of what it is.
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

function boundedCaptureUrl(value) {
  if (typeof value !== "string") return null;
  const scheme = URL_SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return `${scheme}:`;
  return value.length > MAX_POLISH_CAPTURE_URL_LENGTH ? "[url-too-long]" : value;
}

function responseHeader(response, name) {
  if (!response?.headers || typeof response.headers !== "object" || Array.isArray(response.headers)) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function decimalHeaderInteger(value) {
  const token = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(token)) return undefined;
  const parsed = Number(token);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function declaredResponseLength(response) {
  const contentRange = responseHeader(response, "content-range");
  if (typeof contentRange === "string") {
    const match = /^bytes\s+\d+\s*-\s*\d+\s*\/\s*(\d+)\s*$/i.exec(contentRange.trim());
    const total = decimalHeaderInteger(match?.[1]);
    if (total !== undefined) return total;
  }
  return decimalHeaderInteger(responseHeader(response, "content-length"));
}

function projectProtocolResponse(value) {
  if (!value || typeof value !== "object") return null;
  const declaredDataLength = declaredResponseLength(value);
  return {
    ...(typeof value.url === "string" ? { url: boundedCaptureUrl(value.url) } : {}),
    ...(Number.isInteger(value.status) ? { status: value.status } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(nonnegativeInteger(value.encodedDataLength) !== undefined
      ? { encodedDataLength: value.encodedDataLength }
      : {}),
    ...(declaredDataLength !== undefined ? { declaredDataLength } : {}),
    fromDiskCache: Boolean(value.fromDiskCache),
    fromPrefetchCache: Boolean(value.fromPrefetchCache),
    fromServiceWorker: Boolean(value.fromServiceWorker),
  };
}

function parseAuthCookie(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string" || value.trim() === "") throw new Error(AUTH_COOKIE_ERROR);
  const cookies = [];
  const names = new Set();
  for (const rawPair of value.split(";")) {
    const pair = rawPair.trim();
    const separator = pair.indexOf("=");
    if (!pair || separator <= 0) throw new Error(AUTH_COOKIE_ERROR);
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name)
      || /[\u0000-\u001f\u007f;]/.test(cookieValue)
      || names.has(name)) {
      throw new Error(AUTH_COOKIE_ERROR);
    }
    names.add(name);
    cookies.push({ name, value: cookieValue });
  }
  return cookies;
}

function observedResourceType(event = {}) {
  const type = typeof event?.type === "string" ? event.type : null;
  // Newer CDP protocol versions report the CORS preflight leg as "Preflight";
  // older ones report it as "Other". The request method identifies it either
  // way, so classify at the source — aggregation cannot tell an older-protocol
  // preflight apart from a genuine "Other" request sharing the URL.
  if (type === "Other" && event?.request?.method === "OPTIONS") return "Preflight";
  return type;
}

function currentRequest(event = {}) {
  return {
    requestUrl: boundedCaptureUrl(event?.request?.url),
    resourceType: observedResourceType(event),
    response: null,
    requestServedFromCache: false,
    frameId: typeof event?.frameId === "string" ? event.frameId : null,
    loaderId: typeof event?.loaderId === "string" ? event.loaderId : null,
    encodedDataLengthLowerBound: 0,
    encodedDataObserved: false,
  };
}

function responseRecord(current, {
  response = current?.response,
  encodedDataLength,
  failed = false,
  canceled = false,
} = {}) {
  const url = typeof response?.url === "string" && response.url !== ""
    ? response.url
    : current?.requestUrl;
  const sourceUrls = uniqueStrings([current?.requestUrl]);
  const measuredLength = nonnegativeInteger(encodedDataLength);
  const lowerBound = current?.encodedDataObserved
    ? nonnegativeInteger(current.encodedDataLengthLowerBound)
    : undefined;
  const declaredLength = canceled ? nonnegativeInteger(response?.declaredDataLength) : undefined;
  const retainedLength = measuredLength === undefined
    ? lowerBound
    : lowerBound === undefined ? measuredLength : Math.max(measuredLength, lowerBound);
  return {
    ...(typeof url === "string" && url !== "" ? { url } : {}),
    ...(typeof current?.resourceType === "string" && current.resourceType !== ""
      ? { resource_type: current.resourceType }
      : {}),
    ...(Number.isInteger(response?.status) ? { status: response.status } : {}),
    ...(typeof response?.mimeType === "string" && response.mimeType !== ""
      ? { mime_type: response.mimeType }
      : {}),
    ...(retainedLength !== undefined
      ? { encoded_data_length: retainedLength }
      : {}),
    ...(declaredLength !== undefined ? { declared_data_length: declaredLength } : {}),
    ...(canceled ? { canceled: true } : {}),
    source_urls: sourceUrls,
    from_disk_cache: Boolean(response?.fromDiskCache),
    from_prefetch_cache: Boolean(response?.fromPrefetchCache),
    from_service_worker: Boolean(response?.fromServiceWorker),
    request_served_from_cache: Boolean(current?.requestServedFromCache),
    failed: Boolean(failed),
    __frame_id: current?.frameId || null,
    __loader_id: current?.loaderId || null,
  };
}

function attributableResponseRecord(record) {
  return typeof record?.url === "string" && record.url !== ""
    && typeof record?.resource_type === "string" && record.resource_type !== "";
}

function completeResponseRecord(record) {
  return typeof record?.url === "string"
    && typeof record?.resource_type === "string"
    && Number.isInteger(record?.status)
    && (nonnegativeInteger(record?.encoded_data_length) !== undefined
      || (record?.canceled === true && nonnegativeInteger(record?.declared_data_length) !== undefined));
}

function createNetworkCollector() {
  const requests = new Map();
  let collectionFailed = false;
  let responseRecordCount = 0;
  let responseOverflow = false;

  function stateFor(requestId) {
    if (typeof requestId !== "string" || requestId === "") {
      collectionFailed = true;
      return null;
    }
    let state = requests.get(requestId);
    if (!state) {
      if (requests.size >= MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES) {
        responseOverflow = true;
        collectionFailed = true;
        return null;
      }
      state = { requestId, hops: [], current: null, redirected: false };
      requests.set(requestId, state);
    }
    return state;
  }

  function finishCurrent(state, options = {}) {
    if (!state?.current) {
      // A canceled terminal event with nothing in flight is either a
      // duplicate after the load already finished (dropped is only consulted
      // for zero-hop states, so the emitted record is unaffected) or an abort
      // that raced listener attachment; neither is a measurement failure.
      if (options.canceled) {
        if (state) state.dropped = true;
      } else {
        collectionFailed = true;
      }
      return;
    }
    const record = responseRecord(state.current, options);
    if (options.canceled) {
      // Browser-canceled loads (aborted media range requests, fetches cut off
      // by navigation) are normal page behavior, not measurement failures.
      // Keep complete records as observed responses; drop incomplete ones
      // without failing the collection.
      if (!completeResponseRecord(record)) {
        state.dropped = true;
      } else if (responseRecordCount >= MAX_PAGE_LOAD_RESPONSE_RECORDS) {
        // Unlike the non-canceled cap path this does not fail the collection:
        // the drop is normal page behavior, but the overflow sentinel still
        // projects a problem downstream so the loss is never silent.
        responseOverflow = true;
        state.dropped = true;
      } else {
        state.hops.push(record);
        responseRecordCount += 1;
      }
      state.current = null;
      return;
    }
    // A failed load is recorded as failed and left to capture attribution
    // (polish-capture.mjs decides whether the failure voids the collection by
    // origin and role). The collection itself fails only when the record
    // cannot be attributed — no URL or resource type to attribute it by — or
    // when a non-failed load is missing its terminal measurement.
    if (record.failed ? !attributableResponseRecord(record) : !completeResponseRecord(record)) {
      collectionFailed = true;
    }
    if (responseRecordCount >= MAX_PAGE_LOAD_RESPONSE_RECORDS) {
      responseOverflow = true;
      collectionFailed = true;
    } else {
      state.hops.push(record);
      responseRecordCount += 1;
    }
    state.current = null;
  }

  const handlers = {
    "Network.requestWillBeSent"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state) return;
      if (event.redirectResponse) {
        state.redirected = true;
        if (!state.current) {
          collectionFailed = true;
          state.current = {
            requestUrl: boundedCaptureUrl(event.redirectResponse.url),
            resourceType: observedResourceType(event),
            response: null,
            requestServedFromCache: false,
            frameId: typeof event?.frameId === "string" ? event.frameId : null,
            loaderId: typeof event?.loaderId === "string" ? event.loaderId : null,
            encodedDataLengthLowerBound: 0,
            encodedDataObserved: false,
          };
        }
        finishCurrent(state, {
          response: projectProtocolResponse(event.redirectResponse),
          encodedDataLength: event.redirectResponse.encodedDataLength,
        });
      } else if (state.current || state.hops.length > 0) {
        collectionFailed = true;
        if (state.current) finishCurrent(state, { failed: true });
      }
      state.current = currentRequest(event);
    },

    "Network.responseReceived"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state) return;
      if (!state.current) {
        collectionFailed = true;
        state.current = {
          requestUrl: boundedCaptureUrl(event?.response?.url),
          resourceType: typeof event.type === "string" ? event.type : null,
          response: null,
          requestServedFromCache: false,
          frameId: typeof event?.frameId === "string" ? event.frameId : null,
          loaderId: typeof event?.loaderId === "string" ? event.loaderId : null,
          encodedDataLengthLowerBound: 0,
          encodedDataObserved: false,
        };
      }
      if (state.current.response) collectionFailed = true;
      state.current.response = projectProtocolResponse(event.response);
      if (!state.current.resourceType && typeof event.type === "string") {
        state.current.resourceType = event.type;
      }
      if (!state.current.frameId && typeof event.frameId === "string") state.current.frameId = event.frameId;
      if (!state.current.loaderId && typeof event.loaderId === "string") state.current.loaderId = event.loaderId;
    },

    "Network.loadingFinished"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state) return;
      finishCurrent(state, { encodedDataLength: event.encodedDataLength });
    },

    "Network.loadingFailed"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state) return;
      const canceled = event.canceled === true
        || event.errorText === "net::ERR_ABORTED";
      if (canceled) {
        finishCurrent(state, { failed: false, canceled: true });
        return;
      }
      finishCurrent(state, { failed: true });
    },

    "Network.dataReceived"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state?.current) {
        collectionFailed = true;
        return;
      }
      const encodedDataLength = nonnegativeInteger(event.encodedDataLength);
      if (encodedDataLength === undefined) {
        collectionFailed = true;
        return;
      }
      state.current.encodedDataObserved = true;
      const next = state.current.encodedDataLengthLowerBound + encodedDataLength;
      if (!Number.isSafeInteger(next)) {
        state.current.encodedDataLengthLowerBound = Number.MAX_SAFE_INTEGER;
        collectionFailed = true;
      } else {
        state.current.encodedDataLengthLowerBound = next;
      }
    },

    "Network.requestServedFromCache"(event = {}) {
      const state = stateFor(event.requestId);
      if (!state) return;
      if (!state.current) {
        collectionFailed = true;
        state.current = {
          requestUrl: null,
          resourceType: null,
          response: null,
          requestServedFromCache: false,
          frameId: null,
          loaderId: null,
          encodedDataLengthLowerBound: 0,
          encodedDataObserved: false,
        };
      }
      state.current.requestServedFromCache = true;
    },
  };

  return {
    listen(session) {
      for (const event of NETWORK_EVENTS) session.on(event, handlers[event]);
    },

    finish({ mainFrameId, mainLoaderId, finalDocumentUrl } = {}) {
      const responses = [];
      const comparableFinalUrl = comparableDocumentUrl(finalDocumentUrl);
      const contextFingerprint = documentContextFingerprint(mainFrameId, mainLoaderId);
      const projectRecord = (record) => {
        const { __frame_id: frameId, __loader_id: loaderId, ...projection } = record;
        const finalMainDocument = projection.resource_type === "Document"
          && frameId === mainFrameId
          && loaderId === mainLoaderId
          && comparableDocumentUrl(projection.url) === comparableFinalUrl;
        return finalMainDocument && contextFingerprint
          ? { ...projection, is_final_main_document: true, document_context_fingerprint: contextFingerprint }
          : projection;
      };
      for (const state of requests.values()) {
        // A request still in flight when the capture window closes (an
        // autoplaying video stream, a long-poll) is cut off by the capture
        // itself — account for it like a browser-canceled load, not a failure.
        if (state.current) finishCurrent(state, { failed: false, canceled: true });
        if (state.redirected || state.hops.length > 1) {
          responses.push(redirectChainRecord(state.requestId, state.hops.map(projectRecord)));
        } else if (state.hops.length === 1) {
          responses.push(singleResponseRecord(state.requestId, projectRecord(state.hops[0])));
        } else if (!state.dropped) {
          collectionFailed = true;
        }
      }
      if (responseOverflow) responses.push(captureProblemRecord("response_record_overflow"));
      return {
        responseCollectionStatus: collectionFailed ? "failed" : "complete",
        responses,
      };
    },
  };
}

async function collectMediaElements(page) {
  return page.evaluate((limits) => {
    const registryKey = "__campaigns_os_polish_media_registry_v1__";
    let registry = document[registryKey];
    if (!registry) {
      registry = { ids: new WeakMap(), nextId: 0 };
      Object.defineProperty(document, registryKey, { configurable: true, value: registry });
    }
    const captureId = (element) => {
      let id = registry.ids.get(element);
      if (!id) {
        id = `media-${registry.nextId}`;
        registry.nextId += 1;
        registry.ids.set(element, id);
      }
      return id;
    };
    const styleProjection = (node) => {
      const style = getComputedStyle(node);
      return { display: style.display, visibility: style.visibility };
    };
    const boundedUrl = (value, overflow) => {
      if (typeof value !== "string") return value;
      if (value.length <= limits.urlLength) return value;
      overflow.count += 1;
      return "[url-too-long]";
    };
    const nodes = document.querySelectorAll("video, audio");
    const elements = Array.prototype.slice.call(nodes, 0, limits.mediaElements).map((element) => {
      const urlOverflow = { count: 0 };
      const ancestorStyles = [];
      let ancestor = element.parentElement;
      while (ancestor && ancestorStyles.length < limits.ancestors) {
        ancestorStyles.push(styleProjection(ancestor));
        ancestor = ancestor.parentElement;
      }
      const sources = element.querySelectorAll("source");
      const bounds = element.getBoundingClientRect();
      return {
        capture_element_id: captureId(element),
        tag_name: element.tagName.toLowerCase(),
        current_src: typeof element.currentSrc === "string" ? boundedUrl(element.currentSrc, urlOverflow) : null,
        src_attribute: boundedUrl(element.getAttribute("src"), urlOverflow),
        source_src_attributes: Array.prototype.slice.call(sources, 0, limits.sources)
          .map((source) => boundedUrl(source.getAttribute("src") ?? "", urlOverflow)),
        preload_attribute: element.getAttribute("preload"),
        computed_style: styleProjection(element),
        ancestor_styles: ancestorStyles,
        bounding_box: { width: bounds.width, height: bounds.height },
        source_overflow_count: Math.max(0, sources.length - limits.sources),
        ancestor_overflow_count: ancestor ? 1 : 0,
        url_overflow_count: urlOverflow.count,
      };
    });
    return { observed_element_count: nodes.length, elements };
  }, {
    mediaElements: MAX_PAGE_LOAD_MEDIA_ELEMENTS,
    sources: MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
    ancestors: MAX_PAGE_LOAD_MEDIA_ANCESTORS,
    urlLength: MAX_POLISH_CAPTURE_URL_LENGTH,
  });
}

// The <img> reader the media-weight image probe runs in the page, after
// network observation closed. It reads the first `limits.images` <img> in
// document order and returns their count, each one's element path (the CSS
// child path from <body>, every step "tag:nth-of-type(n)"), currentSrc
// (http(s) as is; any other scheme as the scheme alone) and loading, plus
// window.devicePixelRatio. With `limits.geometry` it also reads complete,
// natural size, the rendered box in CSS px, computed object-fit and whether
// the image or an ancestor is not displayed or the image is not visible. It
// reads only; it never scrolls and starts no load.
function readImageElements(limits) {
  const nodes = document.querySelectorAll("img");
  const pathOf = (element) => {
    const steps = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (node === document.body || node === document.documentElement) {
        steps.unshift(tag);
        break;
      }
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      steps.unshift(`${tag}:nth-of-type(${index})`);
    }
    return steps.join(">");
  };
  const source = (value) => {
    if (typeof value !== "string" || value === "") return { url: null, svg: false };
    if (/^https?:/i.test(value)) return { url: value.length <= limits.urlLength ? value : "[url-too-long]", svg: false };
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    return { url: scheme ? `${scheme[1].toLowerCase()}:` : null, svg: /^data:image\/svg\+xml[;,]/i.test(value) };
  };
  const images = Array.prototype.slice.call(nodes, 0, limits.images).map((image) => {
    const elementPath = pathOf(image);
    const src = source(image.currentSrc);
    const entry = { element_path: elementPath, current_src: src.url, svg_data: src.svg, loading: image.loading };
    if (!limits.geometry) return entry;
    const style = getComputedStyle(image);
    let hidden = style.visibility !== "visible";
    for (let node = image; node && !hidden; node = node.parentElement) {
      if (getComputedStyle(node).display === "none") hidden = true;
    }
    const bounds = image.getBoundingClientRect();
    return {
      ...entry,
      complete: image.complete,
      natural: [image.naturalWidth, image.naturalHeight],
      rendered: [bounds.width, bounds.height],
      object_fit: style.objectFit,
      hidden,
    };
  });
  return { dpr: window.devicePixelRatio, observed_count: nodes.length, images };
}

// The image probe: one page.evaluate of readImageElements in the page's own
// world.
async function collectImageElements(page, limits) {
  return page.evaluate(readImageElements, { ...limits, geometry: true });
}

// The <img> identities alone, read in an isolated world (page scripts cannot
// observe or slow it), so a cell whose probe is cut or never runs still names
// each image. `send` is the probe's guarded CDP send.
async function listImageElements(send, frameId, limits) {
  const world = await send("Page.createIsolatedWorld", {
    frameId,
    worldName: "campaigns-os-polish-image-listing",
    grantUniveralAccess: false,
  });
  const evaluated = await send("Runtime.evaluate", {
    expression: `(${readImageElements.toString()})(${JSON.stringify({ ...limits, geometry: false })})`,
    contextId: world?.executionContextId,
    returnByValue: true,
  });
  if (evaluated?.exceptionDetails || !evaluated?.result) throw new Error("The image listing did not evaluate.");
  return evaluated.result.value;
}

const BOUND_ENDED = Symbol("bound ended");
const realProbeClock = Object.freeze({
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }),
});

function imageListing(value, imageCap) {
  return value && typeof value === "object" && Number.isInteger(value.observed_count) && Array.isArray(value.images)
    && value.images.length <= imageCap
    ? value
    : null;
}

// The media-weight image probe, run after collector.finish so it cannot
// delay the network window or add to the ledger. Its steps, in order: the
// <img> listing (Page.createIsolatedWorld and Runtime.evaluate), the
// Page.enable that arms the navigation watch, the probe's page.evaluate and
// the Page.getFrameTree re-read. The cell's bound is the smaller of the cell
// bound and the run budget left. Every step after the listing races one
// deadline on `clock` at that bound and none starts once it has passed; the
// listing races a wall-clock timer of at most listingBoundMs and that bound.
// spent_ms, on `clock` from the first step to the return, covers every step
// and is what the run budget is charged. The probe is cancelled when a bound
// ends it, on its timer or on `clock` whichever is first, or it returns: every
// CDP command and page.evaluate, and every step's result, checks that first,
// so a step that settles late (the listing's Runtime.evaluate after a late
// Page.createIsolatedWorld) issues nothing more. A probe its bound ends
// reads probe_timeout, or probe_budget_exhausted where the run budget left was the
// smaller bound, never complete. A cell that starts once the run budget is
// spent starts no step, not even the listing, and reads
// probe_budget_exhausted with no images. After the probe it re-reads the
// main frame: a navigation requested or committed during the probe, or a
// probe that failed (its execution context destroyed), discards it as
// document_context_changed.
// Returns { status, dpr, images, spent_ms }.
async function probeImageElements(options) {
  const token = { cancelled: false };
  try {
    return await runImageProbe(options, token);
  } finally {
    token.cancelled = true;
  }
}

async function runImageProbe({ page, session, mainFrame, documentContextChanged, probe }, token) {
  const clock = typeof probe.clock?.now === "function" && typeof probe.clock?.sleep === "function" ? probe.clock : realProbeClock;
  const limits = { images: probe.imageCap, urlLength: MAX_POLISH_CAPTURE_URL_LENGTH };
  const started = clock.now();
  const spent = () => Math.max(0, clock.now() - started);
  const exhausted = !(probe.remainingMs > 0);
  const boundMs = Math.min(probe.cellBoundMs, probe.remainingMs);
  // The status of a probe its bound ended.
  const boundEnded = probe.remainingMs < probe.cellBoundMs ? "probe_budget_exhausted" : "probe_timeout";
  let listing = null;
  const outcome = (status, read = null) => ({
    status,
    dpr: (read ?? listing)?.dpr ?? null,
    images: (status === "complete" ? read : listing)?.images ?? [],
    spent_ms: spent(),
  });
  if (exhausted) return { ...outcome("probe_budget_exhausted"), spent_ms: 0 };
  if (documentContextChanged || typeof mainFrame?.id !== "string") return outcome("document_context_changed");
  const listingMs = Math.min(probe.listingBoundMs, boundMs);
  const listingEnd = started + listingMs;
  const boundEnd = started + boundMs;
  // The probe's one guard, run before every command it issues
  // (Page.createIsolatedWorld and Runtime.evaluate in the listing, Page.enable,
  // the probe's page.evaluate, Page.getFrameTree) and before it acts on any
  // step's result: the probe is cancelled once the token is, or once the probe
  // clock reaches `deadline`, the bound of the step in flight. The clock is
  // read even when no timer has fired, so a step that settles past its bound
  // ahead of a queued timer issues nothing more; a passed deadline cancels the
  // token too.
  const cancelled = (deadline) => {
    if (!token.cancelled && clock.now() >= deadline) token.cancelled = true;
    return token.cancelled;
  };
  const guarded = (deadline, issue) => (cancelled(deadline)
    ? Promise.reject(new Error("The image probe was cancelled."))
    : issue());
  const sendBy = (deadline) => (method, params) => guarded(deadline, () => session.send(method, params));

  const listingEnded = listingMs < probe.listingBoundMs ? boundEnded : "probe_timeout";
  let listingTimer;
  try {
    const listed = await Promise.race([
      listImageElements(sendBy(listingEnd), mainFrame.id, limits),
      new Promise((resolve) => {
        listingTimer = setTimeout(() => {
          token.cancelled = true;
          resolve(BOUND_ENDED);
        }, listingMs);
      }),
    ]);
    if (listed === BOUND_ENDED || cancelled(listingEnd)) return outcome(listingEnded);
    listing = imageListing(listed, probe.imageCap);
  } catch {
    return outcome(cancelled(listingEnd) ? listingEnded : "document_context_changed");
  } finally {
    clearTimeout(listingTimer);
  }
  if (!listing) return outcome("document_context_changed");
  if (listing.observed_count > probe.imageCap) return outcome("image_cap_reached");
  if (cancelled(boundEnd)) return outcome(boundEnded);

  const send = sendBy(boundEnd);
  const deadline = clock.sleep(boundEnd - clock.now()).then(() => {
    token.cancelled = true;
    return BOUND_ENDED;
  });
  // One probe step: started only inside the bound, and raced against it. A
  // step that settles past the bound reads BOUND_ENDED, not its result.
  const step = async (start) => {
    if (cancelled(boundEnd)) return BOUND_ENDED;
    const settled = await Promise.race([Promise.resolve().then(start).then((value) => ({ value }), (error) => ({ error })), deadline]);
    return cancelled(boundEnd) ? BOUND_ENDED : settled;
  };
  let navigated = false;
  const watched = [];
  const watch = (event, frameOf) => {
    const listener = (payload) => {
      if (frameOf(payload) === mainFrame.id) navigated = true;
    };
    session.on(event, listener);
    watched.push([event, listener]);
  };
  try {
    const enabled = await step(() => send("Page.enable"));
    if (enabled === BOUND_ENDED) return outcome(boundEnded);
    if (enabled.error) return outcome("document_context_changed");
    watch("Page.frameRequestedNavigation", (payload) => payload?.frameId);
    watch("Page.frameStartedLoading", (payload) => payload?.frameId);
    watch("Page.frameNavigated", (payload) => payload?.frame?.id);
    const read = await step(() => guarded(boundEnd, () => collectImageElements(page, limits)));
    if (read === BOUND_ENDED) return outcome(boundEnded);
    if (read.error) return outcome("document_context_changed");
    const reread = await step(() => send("Page.getFrameTree"));
    if (reread === BOUND_ENDED) return outcome(boundEnded);
    if (reread.error) return outcome("document_context_changed");
    const frame = reread.value?.frameTree?.frame;
    if (navigated || frame?.id !== mainFrame.id || frame?.loaderId !== mainFrame.loaderId) return outcome("document_context_changed");
    const value = imageListing(read.value, probe.imageCap);
    if (!value) return outcome("document_context_changed");
    if (value.observed_count > probe.imageCap) return outcome("image_cap_reached");
    return cancelled(boundEnd) ? outcome(boundEnded) : outcome("complete", value);
  } catch {
    return outcome(cancelled(boundEnd) ? boundEnded : "document_context_changed");
  } finally {
    for (const [event, listener] of watched) {
      if (typeof session.off === "function") session.off(event, listener);
    }
  }
}

function preferredResolvedValue(finalValue, initialValue) {
  return typeof finalValue === "string" && finalValue !== "" ? finalValue : initialValue;
}

function observedMediaSources(...elements) {
  return [...new Set(elements.flatMap((element) => [
    element?.current_src,
    element?.src_attribute,
    ...(Array.isArray(element?.source_src_attributes) ? element.source_src_attributes : []),
    ...(Array.isArray(element?.observed_source_urls) ? element.observed_source_urls : []),
  ]).filter((value) => typeof value === "string" && value !== ""))];
}

function mergeMediaElementSnapshots(initialSnapshot, finalSnapshot) {
  const initialElements = Array.isArray(initialSnapshot?.elements) ? initialSnapshot.elements : [];
  const finalElements = Array.isArray(finalSnapshot?.elements) ? finalSnapshot.elements : [];
  const initialById = new Map(initialElements.map((element) => [element?.capture_element_id, element]));
  const finalById = new Map(finalElements.map((element) => [element?.capture_element_id, element]));
  if ([...initialById.keys(), ...finalById.keys()].some((id) => typeof id !== "string" || id === "")
    || initialById.size !== initialElements.length
    || finalById.size !== finalElements.length) {
    throw new Error("Campaigns OS polish capture could not correlate bounded media snapshots.");
  }
  const ids = [...initialById.keys(), ...finalById.keys().filter((id) => !initialById.has(id))];
  const merged = ids.slice(0, MAX_PAGE_LOAD_MEDIA_ELEMENTS).map((id) => {
    const initial = initialById.get(id);
    const final = finalById.get(id);
    const atLoad = initial || final;
    const resolved = final || initial;
    const {
      capture_element_id: ignoredId,
      source_overflow_count: initialSourceOverflow,
      ancestor_overflow_count: initialAncestorOverflow,
      url_overflow_count: initialUrlOverflow,
      ...projection
    } = atLoad;
    const sourceHistory = observedMediaSources(atLoad, resolved);
    const sourceOverflowCount = Math.max(initialSourceOverflow || 0, resolved?.source_overflow_count || 0)
      + Math.max(0, sourceHistory.length - MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT);
    const ancestorOverflowCount = Math.max(initialAncestorOverflow || 0, resolved?.ancestor_overflow_count || 0);
    const urlOverflowCount = Math.max(initialUrlOverflow || 0, resolved?.url_overflow_count || 0);
    return {
      ...projection,
      current_src: preferredResolvedValue(resolved?.current_src, atLoad?.current_src),
      src_attribute: preferredResolvedValue(resolved?.src_attribute, atLoad?.src_attribute),
      source_src_attributes: Array.isArray(resolved?.source_src_attributes)
        && resolved.source_src_attributes.length > 0
        ? resolved.source_src_attributes
        : atLoad.source_src_attributes,
      observed_source_urls: sourceHistory.slice(0, MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT),
      ...(sourceOverflowCount > 0 ? { source_overflow_count: sourceOverflowCount } : {}),
      ...(ancestorOverflowCount > 0 ? { ancestor_overflow_count: ancestorOverflowCount } : {}),
      ...(urlOverflowCount > 0 ? { url_overflow_count: urlOverflowCount } : {}),
    };
  });
  const initialCount = nonnegativeInteger(initialSnapshot?.observed_element_count) || initialElements.length;
  const finalCount = nonnegativeInteger(finalSnapshot?.observed_element_count) || finalElements.length;
  const observedElementCount = Math.max(initialCount, finalCount, ids.length);
  Object.defineProperty(merged, "observed_element_count", {
    configurable: false,
    enumerable: false,
    value: observedElementCount,
  });
  return merged;
}

function comparableDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function documentContextFingerprint(frameId, loaderId) {
  if (typeof frameId !== "string" || frameId === ""
    || typeof loaderId !== "string" || loaderId === "") return null;
  return `sha256:${createHash("sha256").update(`${frameId}\u0000${loaderId}`).digest("hex")}`;
}

function timeoutError(error) {
  return error?.name === "TimeoutError";
}

function durationSince(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function drainProtocolEvents() {
  await new Promise((resolve) => setImmediate(resolve));
}

function polishBrowserMissing(kind, error) {
  return browserUnavailableError(kind === "package"
    ? [
      "Playwright is not installed for Campaigns OS polish capture.",
      PLAYWRIGHT_INSTALL_HINT,
      "Then rerun `campaigns-os polish capture`.",
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    ].join(" ")
    : [
      "Playwright Chromium is not installed for Campaigns OS polish capture.",
      installBrowserHint("polish"),
    ].join(" "));
}

export async function createPolishBrowserAdapter({
  headed = false,
  authCookie = null,
  chromium: injectedChromium,
  cellDeadlineMs,
  cleanupDeadlineMs,
  startupDeadlineMs,
} = {}) {
  const authCookies = parseAuthCookie(authCookie);
  const boundedCellDeadlineMs = boundedPolishDeadline(cellDeadlineMs, POLISH_BROWSER_CELL_DEADLINE_MS);
  const boundedCleanupDeadlineMs = boundedPolishDeadline(
    cleanupDeadlineMs,
    POLISH_BROWSER_CLEANUP_DEADLINE_MS,
  );
  const boundedStartupDeadlineMs = boundedPolishDeadline(
    startupDeadlineMs,
    POLISH_BROWSER_STARTUP_DEADLINE_MS,
  );
  let browser;
  let startupTimedOut = false;
  const startupAbort = new AbortController();
  const startupPromise = Promise.resolve().then(async () => {
    let launchedBrowser;
    try {
      launchedBrowser = await launchPackageChromium({
        headed,
        chromium: injectedChromium,
        onMissing: polishBrowserMissing,
        signal: startupAbort.signal,
      });
    } catch (error) {
      if (startupTimedOut) throw polishProducerTimeoutError();
      throw error;
    }
    if (startupTimedOut) {
      if (typeof launchedBrowser?.close === "function") {
        void runWithPolishProducerDeadline(() => launchedBrowser.close(), {
          timeoutMs: boundedCleanupDeadlineMs,
          unrefTimer: true,
        }).catch(() => {});
      }
      throw polishProducerTimeoutError();
    }
    return launchedBrowser;
  });
  browser = await runWithPolishProducerDeadline(() => startupPromise, {
    timeoutMs: boundedStartupDeadlineMs,
    onTimeout() {
      startupTimedOut = true;
      startupAbort.abort(polishProducerTimeoutError());
    },
  });

  let closed = false;
  let poisonCode = null;
  let closePromise = null;
  return {
    // `imageProbe` ({ clock, remainingMs, cellBoundMs, imageCap,
    // listingBoundMs }) opts the cell into the media-weight image probe; the
    // observation then carries `imageProbe` beside the page-load fields.
    async captureRoute({ url, viewport, signal, imageProbe: probeOptions = null } = {}) {
      if (closed) throw new Error("Campaigns OS polish capture browser adapter is already closed.");
      if (poisonCode === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) throw polishProducerTimeoutError();
      if (poisonCode === POLISH_PRODUCER_CLEANUP_ERROR_CODE) throw polishProducerCleanupError();
      if (typeof url !== "string" || url.length > MAX_POLISH_CAPTURE_URL_LENGTH) {
        throw new Error("Campaigns OS polish capture requires a bounded HTTP(S) capture URL.");
      }
      if (!Number.isInteger(viewport?.width) || viewport.width <= 0
        || !Number.isInteger(viewport?.height) || viewport.height <= 0) {
        throw new Error("Campaigns OS polish capture requires a positive integer viewport.");
      }
      let context;
      let session;
      let timedOut = false;
      let detachPromise = null;
      let contextClosePromise = null;
      const cleanupResources = () => {
        if (typeof session?.detach === "function" && !detachPromise) {
          detachPromise = Promise.resolve().then(() => session.detach());
          // Context closure is authoritative. CDP detach commonly rejects when
          // that same close wins the race, so observe but never await or expose it.
          void detachPromise.catch(() => {});
        }
        if (typeof context?.close === "function" && !contextClosePromise) {
          contextClosePromise = Promise.resolve().then(() => context.close());
        }
        if (!context) return Promise.resolve();
        if (!contextClosePromise) return Promise.reject(polishProducerCleanupError());
        return contextClosePromise.catch(() => { throw polishProducerCleanupError(); });
      };
      const assertActive = () => {
        if (!timedOut) return;
        poisonCode = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
        void cleanupResources().catch(() => {});
        throw polishProducerTimeoutError();
      };
      const awaitActive = async (promise) => {
        try {
          const value = await promise;
          assertActive();
          return value;
        } catch (error) {
          assertActive();
          throw error;
        }
      };
      const triggerTimeout = () => {
        timedOut = true;
        poisonCode = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
        void cleanupResources().catch(() => {});
      };
      if (signal?.aborted) triggerTimeout();
      else if (typeof signal?.addEventListener === "function") {
        signal.addEventListener("abort", triggerTimeout, { once: true });
      }
      let observation;
      let operationError = null;
      try {
        observation = await runWithPolishProducerDeadline(async () => {
          assertActive();
          context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            serviceWorkers: "block",
          });
          assertActive();
          if (authCookies.length > 0) {
            const origin = captureOrigin(url);
            // Fixed message: a URL containing credentials or query data is never echoed.
            if (origin === null) throw new Error("Campaigns OS polish capture requires an HTTP(S) capture URL before applying --auth-cookie.");
            await awaitActive(context.addCookies(authCookies.map((cookie) => ({ ...cookie, url: origin }))));
          }
          const page = await awaitActive(context.newPage());
          session = await context.newCDPSession(page);
          assertActive();
          const collector = createNetworkCollector();
          await awaitActive(session.send("Network.enable"));
          await awaitActive(session.send("Network.setCacheDisabled", { cacheDisabled: true }));
          await awaitActive(session.send("Network.setBypassServiceWorker", { bypass: true }));
          collector.listen(session);

          const navigationStartedAt = performance.now();
          await awaitActive(page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }));
          const initialFrameTree = await awaitActive(session.send("Page.getFrameTree"));
          const initialMainFrame = initialFrameTree?.frameTree?.frame;
          const initialMediaElements = await awaitActive(collectMediaElements(page));
          let networkidle;
          try {
            await awaitActive(page.waitForLoadState("networkidle", { timeout: NETWORKIDLE_TIMEOUT_MS }));
            networkidle = { status: "settled", duration_ms: durationSince(navigationStartedAt) };
          } catch (error) {
            if (!timeoutError(error)) throw error;
            networkidle = { status: "timeout", duration_ms: durationSince(navigationStartedAt) };
          }
          const finalMediaElements = await awaitActive(collectMediaElements(page));
          await awaitActive(drainProtocolEvents());
          const frameTree = await awaitActive(session.send("Page.getFrameTree"));
          const mainFrame = frameTree?.frameTree?.frame;
          const finalDocumentUrl = page.url();
          const documentContextChanged = typeof initialMainFrame?.id !== "string"
            || typeof initialMainFrame?.loaderId !== "string"
            || initialMainFrame.id !== mainFrame?.id
            || initialMainFrame.loaderId !== mainFrame?.loaderId;
          const mediaElements = mergeMediaElementSnapshots(
            documentContextChanged ? { observed_element_count: 0, elements: [] } : initialMediaElements,
            finalMediaElements,
          );
          const network = collector.finish({
            mainFrameId: mainFrame?.id,
            mainLoaderId: mainFrame?.loaderId,
            finalDocumentUrl,
          });
          if (documentContextChanged) {
            network.responseCollectionStatus = "failed";
            network.responses.push(captureProblemRecord("document_context_changed"));
          }
          const imageProbe = probeOptions && typeof probeOptions === "object"
            ? await awaitActive(probeImageElements({ page, session, mainFrame, documentContextChanged, probe: probeOptions }))
            : null;
          return {
            finalDocumentUrl,
            responseCollectionStatus: network.responseCollectionStatus,
            networkidle,
            mediaElements,
            responses: network.responses,
            ...(imageProbe ? { imageProbe } : {}),
          };
        }, {
          timeoutMs: boundedCellDeadlineMs,
          onTimeout: triggerTimeout,
          signal,
        });
      } catch (error) {
        operationError = error;
        if (error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) {
          poisonCode = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
        }
      } finally {
        if (typeof signal?.removeEventListener === "function") {
          signal.removeEventListener("abort", triggerTimeout);
        }
      }
      let cleanupError = null;
      try {
        await runWithPolishProducerDeadline(cleanupResources, { timeoutMs: boundedCleanupDeadlineMs });
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) {
        poisonCode = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
        throw cleanupError;
      }
      if (operationError?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) {
        poisonCode = POLISH_PRODUCER_TIMEOUT_ERROR_CODE;
        throw operationError;
      }
      if (cleanupError) {
        poisonCode = POLISH_PRODUCER_CLEANUP_ERROR_CODE;
        throw polishProducerCleanupError();
      }
      if (operationError) throw operationError;
      return observation;
    },

    async close() {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          try {
            await runWithPolishProducerDeadline(() => browser.close(), {
              timeoutMs: boundedCleanupDeadlineMs,
            });
          } catch (error) {
            if (error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) throw error;
            throw new Error("Campaigns OS polish capture could not close its browser cleanly.");
          }
        })();
      }
      return closePromise;
    },
  };
}

// The browser-install step spelled for the install this package runs from:
// the checkout script from a checkout, otherwise `qa install-browser` through
// the prefix that runs THIS copy (see install-mode.mjs).
function installBrowserHint(kind) {
  const prefix = invocationPrefixFor(PACKAGE_ROOT);
  const rerun = kind === "polish" ? `then rerun \`${prefix} polish capture\`.` : "then rerun the QA command.";
  const install = prefix === "campaigns-os"
    ? "Run `npm run qa:install-browser` from the checkout (or `campaigns-os qa install-browser`),"
    : `Run \`${prefix} qa install-browser\`,`;
  return `${install} ${rerun}`;
}
