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
import { isProbeClock } from "./polish-media-weight.mjs";
import {
  readabilityCropTargets,
  readabilityObservationOk,
  readabilityProbeSource,
} from "./polish-readability.mjs";
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

// The <img> reader the media-weight image probe runs after network
// observation closed, in an isolated world: every DOM method, getter and
// window property it uses is that world's own, so page scripts can neither
// change what it reads nor see that it ran. It walks the document in
// shadow-including tree order (an element, then its shadow tree, then its
// children), reaching open shadow roots through element.shadowRoot and
// closed ones through `closedRoots` (resolved into this world over CDP); it
// does not enter an iframe's document. It returns the <img> count,
// window.devicePixelRatio and, for the first `limits.images` <img>: the
// element path (the CSS child path from <body>, every step
// "tag:nth-of-type(n)", with a "#shadow-root" step after a shadow host),
// currentSrc (http(s) as is; any other scheme as the scheme alone), loading,
// complete, natural size, the rendered box in CSS px, computed object-fit and
// whether it is hidden (checkVisibility: it or a flat-tree ancestor is not
// displayed, or it is not visible). It reads only; it never scrolls and
// starts no load.
function readImageElements(limits, ...closedRoots) {
  const closedRootOf = new Map(closedRoots.filter((root) => root?.host).map((root) => [root.host, root]));
  const source = (value) => {
    if (typeof value !== "string" || value === "") return { url: null, svg: false };
    if (/^https?:/i.test(value)) return { url: value.length <= limits.urlLength ? value : "[url-too-long]", svg: false };
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    return { url: scheme ? `${scheme[1].toLowerCase()}:` : null, svg: /^data:image\/svg\+xml[;,]/i.test(value) };
  };
  const found = [];
  let observedCount = 0;
  // Work still to do, last first: an element to visit, or a parent (the
  // document, an element or a shadow root) whose children are still to list.
  const pending = [{ parent: document, path: "" }];
  while (pending.length) {
    const item = pending.pop();
    if (item.element) {
      if (item.element instanceof HTMLImageElement) {
        observedCount += 1;
        if (found.length < limits.images) found.push(item);
      }
      pending.push({ parent: item.element, path: item.path });
      const shadowRoot = item.element.shadowRoot ?? closedRootOf.get(item.element);
      if (shadowRoot) pending.push({ parent: shadowRoot, path: `${item.path}>#shadow-root` });
      continue;
    }
    const children = [];
    const counts = new Map();
    for (let child = item.parent.firstElementChild; child; child = child.nextElementSibling) {
      const index = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, index);
      const tag = child.tagName.toLowerCase();
      const path = child === document.body || child === document.documentElement
        ? tag
        : `${item.path ? `${item.path}>` : ""}${tag}:nth-of-type(${index})`;
      children.push({ element: child, path });
    }
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  const images = found.map(({ element: image, path }) => {
    const src = source(image.currentSrc);
    const style = getComputedStyle(image);
    const bounds = image.getBoundingClientRect();
    return {
      element_path: path,
      current_src: src.url,
      svg_data: src.svg,
      loading: image.loading,
      complete: image.complete,
      natural: [image.naturalWidth, image.naturalHeight],
      rendered: [bounds.width, bounds.height],
      object_fit: style.objectFit,
      hidden: !image.checkVisibility({ visibilityProperty: true }),
    };
  });
  return { dpr: window.devicePixelRatio, observed_count: observedCount, images };
}

// The backend node ids of the main document's closed shadow roots, from a
// DOM.getDocument tree read with pierce. Open roots the read reaches itself
// and user-agent roots are not the page's. An iframe's document is entered
// only with `frameOwners`: a closed root inside it, which the main frame's
// world cannot resolve, is named by the main document's iframe that holds
// it (once per iframe).
function closedShadowRoots(root, { frameOwners = false } = {}) {
  const found = [];
  const pending = [[root, null]];
  while (pending.length) {
    const [node, owner] = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (node.shadowRootType === "closed" && Number.isInteger(owner ?? node.backendNodeId)) found.push(owner ?? node.backendNodeId);
    if (Array.isArray(node.shadowRoots)) pending.push(...node.shadowRoots.map((child) => [child, owner]));
    if (Array.isArray(node.children)) pending.push(...node.children.map((child) => [child, owner]));
    if (frameOwners && node.contentDocument) pending.push([node.contentDocument, owner ?? node.backendNodeId]);
  }
  return [...new Set(found)];
}

const BOUND_ENDED = Symbol("bound ended");
// Readability work in a cell ends this long before the adapter cell deadline,
// so a readability bound, not that deadline, is what stops it.
const READABILITY_CELL_HEADROOM_MS = 1_000;
const realProbeClock = Object.freeze({
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }),
});

function imageRead(value, imageCap) {
  return value && typeof value === "object" && Number.isInteger(value.observed_count) && Array.isArray(value.images)
    && value.images.length <= imageCap
    ? value
    : null;
}

// The media-weight image probe, run after collector.finish so it cannot
// delay the network window or add to the ledger. Its steps, in order: an
// isolated world (Page.createIsolatedWorld); the node tree (DOM.getDocument,
// piercing shadow roots) and each closed shadow root resolved into that world
// (DOM.resolveNode); the one read (Runtime.callFunctionOn of
// readImageElements in that world), which is the only source of the listing,
// geometry, computed style and device pixel ratio; and the Page.getFrameTree
// re-read. The probe's bound is the smaller of the cell bound and the run
// budget left. Every step races one deadline on `clock` at that bound, and
// none starts once it has passed. spent_ms, on `clock` from the first step to
// the return, is what the run budget is charged. The probe is cancelled when
// its bound ends it, on its timer or on `clock` whichever is first, or when it
// returns: every CDP command, and every step's result, checks that first, so
// a step that settles late issues nothing more. A probe its bound ends reads
// probe_timeout, or probe_budget_exhausted where the run budget left was the
// smaller bound, never complete; it names its images only when its read had
// returned. A cell that starts once the run budget is spent starts no step
// and reads probe_budget_exhausted with no images. The re-read discards the
// probe as document_context_changed when the main frame has another id or
// loaderId than page_load's own re-read found; so does a step that failed
// (its execution context destroyed).
// Returns { status, dpr, images, spent_ms }.
async function probeImageElements(options) {
  const token = { cancelled: false };
  try {
    return await runImageProbe(options, token);
  } finally {
    token.cancelled = true;
  }
}

// One probe's bound on `clock`, from `started`: the guard run before every
// command the probe issues and before it acts on any step's result (the probe
// is cancelled once the token is, or once the clock reaches the bound; the
// clock is read even when no timer has fired, so a step that settles past the
// bound ahead of a queued timer issues nothing more, and a passed bound
// cancels the token too), the guarded CDP send, and one step: started only
// inside the bound and raced against it. A step that settles past the bound
// reads BOUND_ENDED, not its result. `hardMs`, when given, is a second bound
// in real time from now (the adapter cell deadline's headroom), whatever
// `clock` is; `hardEnded()` tells whether it is the one that ended. Which
// bound ended is recorded when it ends: by the timer that fired, or by the
// clock read that found it passed (the real-time bound first), so a timer
// that fires before performance.now() reaches its end still names its bound.
function boundedProbeSteps({ clock, session, token, started, boundMs, hardMs = Infinity }) {
  const boundEnd = started + boundMs;
  const hardEnd = performance.now() + hardMs;
  let endedBy = null;
  const end = (by) => {
    if (token.cancelled) return;
    token.cancelled = true;
    endedBy = by;
  };
  const hardEnded = () => endedBy === "hard";
  const cancelled = () => {
    if (performance.now() >= hardEnd) end("hard");
    else if (clock.now() >= boundEnd) end("clock");
    return token.cancelled;
  };
  const send = (method, params) => (cancelled()
    ? Promise.reject(new Error("The probe was cancelled."))
    : session.send(method, params));
  const deadline = Promise.race([
    clock.sleep(boundMs).then(() => end("clock")),
    ...(Number.isFinite(hardMs) ? [realProbeClock.sleep(Math.max(0, hardMs)).then(() => end("hard"))] : []),
  ]).then(() => BOUND_ENDED);
  const step = async (start) => {
    if (cancelled()) return BOUND_ENDED;
    const settled = await Promise.race([Promise.resolve().then(start).then((value) => ({ value }), (error) => ({ error })), deadline]);
    return cancelled() ? BOUND_ENDED : settled;
  };
  return { cancelled, hardEnded, send, step };
}

// The isolated-world read a probe makes, each step inside its bound: an
// isolated world on the main frame (Page.createIsolatedWorld); the node tree
// (DOM.getDocument, piercing shadow roots) and each closed shadow root
// resolved into that world (DOM.resolveNode); and the one read
// (Runtime.callFunctionOn of `functionDeclaration` in that world, with
// `leadingArgs` and then the closed roots, passed by object id so the
// function receives the root nodes themselves; with `frameOwners`, also the
// iframes holding closed roots, see closedShadowRoots). Returns BOUND_ENDED
// when the bound ended a step, null when a step failed (its execution
// context destroyed), or { value } of the read.
async function isolatedWorldRead({ steps, mainFrame, worldName, functionDeclaration, leadingArgs, frameOwners = false }) {
  const { send, step } = steps;
  const world = await step(() => send("Page.createIsolatedWorld", {
    frameId: mainFrame.id,
    worldName,
    grantUniveralAccess: false,
  }));
  if (world === BOUND_ENDED) return BOUND_ENDED;
  const contextId = world.value?.executionContextId;
  if (world.error || !Number.isInteger(contextId)) return null;
  const tree = await step(() => send("DOM.getDocument", { depth: -1, pierce: true }));
  if (tree === BOUND_ENDED) return BOUND_ENDED;
  if (tree.error) return null;
  const roots = await step(() => Promise.all(closedShadowRoots(tree.value?.root, { frameOwners })
    .map((backendNodeId) => send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }))));
  if (roots === BOUND_ENDED) return BOUND_ENDED;
  const rootIds = roots.error ? null : roots.value.map((resolved) => resolved?.object?.objectId);
  if (!rootIds || !rootIds.every((objectId) => typeof objectId === "string")) return null;
  const evaluated = await step(() => send("Runtime.callFunctionOn", {
    functionDeclaration,
    executionContextId: contextId,
    arguments: [...leadingArgs, ...rootIds.map((objectId) => ({ objectId }))],
    returnByValue: true,
  }));
  if (evaluated === BOUND_ENDED) return BOUND_ENDED;
  if (evaluated.error || evaluated.value?.exceptionDetails) return null;
  return { value: evaluated.value?.result?.value };
}

// The Page.getFrameTree re-read inside the bound: BOUND_ENDED, or whether the
// main frame still has `mainFrame`'s id and loaderId (false when it does not,
// or the re-read failed).
async function sameMainDocument({ steps, mainFrame }) {
  const reread = await steps.step(() => steps.send("Page.getFrameTree"));
  if (reread === BOUND_ENDED) return BOUND_ENDED;
  if (reread.error) return false;
  const frame = reread.value?.frameTree?.frame;
  return frame?.id === mainFrame.id && frame?.loaderId === mainFrame.loaderId;
}

async function runImageProbe({ session, mainFrame, documentContextChanged, probe }, token) {
  const clock = isProbeClock(probe.clock) ? probe.clock : realProbeClock;
  const limits = { images: probe.imageCap, urlLength: MAX_POLISH_CAPTURE_URL_LENGTH };
  const started = clock.now();
  const spent = () => Math.max(0, clock.now() - started);
  let read = null;
  const outcome = (status) => ({ status, dpr: read?.dpr ?? null, images: read?.images ?? [], spent_ms: spent() });
  if (!(probe.remainingMs > 0)) return { ...outcome("probe_budget_exhausted"), spent_ms: 0 };
  if (documentContextChanged || typeof mainFrame?.id !== "string") return outcome("document_context_changed");
  const boundMs = Math.min(probe.cellBoundMs, probe.remainingMs);
  // The status of a probe its bound ended.
  const boundEnded = probe.remainingMs < probe.cellBoundMs ? "probe_budget_exhausted" : "probe_timeout";
  const steps = boundedProbeSteps({ clock, session, token, started, boundMs });

  const called = await isolatedWorldRead({
    steps,
    mainFrame,
    worldName: "campaigns-os-polish-image-probe",
    functionDeclaration: readImageElements.toString(),
    leadingArgs: [{ value: limits }],
  });
  if (called === BOUND_ENDED) return outcome(boundEnded);
  if (called === null) return outcome("document_context_changed");
  read = imageRead(called.value, probe.imageCap);
  if (!read) return outcome("document_context_changed");
  const same = await sameMainDocument({ steps, mainFrame });
  if (same === BOUND_ENDED) return outcome(boundEnded);
  if (!same) return outcome("document_context_changed");
  if (read.observed_count > probe.imageCap) return outcome("image_cap_reached");
  return steps.cancelled() ? outcome(boundEnded) : outcome("complete");
}

// The readability probe of one cell (src/polish-readability.mjs), after the
// page has loaded, and the cell's crops after it. The probe is the image
// probe's isolated-world read of readabilityProbeSource and its main-frame
// re-read: a main frame with another id or loaderId than `mainFrame`, or a
// failed step, reads document_changed. Its bound is the smaller of the cell
// bound (READABILITY_PROBE_CELL_MS) and what is left of the run's probe and
// added budgets, on `clock`, and it also ends at `cellLeftMs` (the adapter
// cell deadline's headroom, in real time); a probe its bound ends reads
// probe_timeout, or run_budget_exhausted where a run budget was the smaller
// bound. A measured cell then takes its crops (readabilityCropTargets) as
// viewport-clip screenshots, at most `cropsPerCell`, and reads the main frame
// once more, every one of those steps inside one crop bound: what is left of
// the run's crop and added budgets on `clock`, and of the cell headroom. A crop target outside the
// viewport reads outside_viewport; one past the count or the bound, or whose
// screenshot failed, crop_unavailable; so does every crop taken when the
// bound ends before the re-read. crop_ms runs from the first crop step to the
// end of the re-read.
// Returns { status, capped, coverage_gaps, elements, crops, probe_ms, crop_ms }.
async function probeReadabilityDocument(options) {
  const token = { cancelled: false };
  const cropToken = { cancelled: false };
  try {
    return await runReadabilityProbe(options, token, cropToken);
  } finally {
    token.cancelled = true;
    cropToken.cancelled = true;
  }
}

async function runReadabilityProbe({ session, mainFrame, documentContextChanged, probe }, token, cropToken) {
  const clock = isProbeClock(probe.clock) ? probe.clock : realProbeClock;
  const started = clock.now();
  const spent = () => Math.max(0, clock.now() - started);
  const unmeasured = (status) => ({ status, capped: false, coverage_gaps: [], elements: [], crops: [], probe_ms: spent(), crop_ms: 0 });
  const runLeft = Math.min(probe.probeRemainingMs, probe.addedRemainingMs);
  // The cell deadline's headroom, in real time.
  const cellEndsAt = performance.now() + (Number.isFinite(probe.cellLeftMs) ? probe.cellLeftMs : Infinity);
  const cellLeft = () => cellEndsAt - performance.now();
  if (!(runLeft > 0)) return { ...unmeasured("run_budget_exhausted"), probe_ms: 0 };
  if (!(cellLeft() > 0)) return { ...unmeasured("probe_timeout"), probe_ms: 0 };
  if (documentContextChanged || typeof mainFrame?.id !== "string") return unmeasured("document_changed");
  const boundMs = Math.min(probe.cellBoundMs, runLeft);
  const steps = boundedProbeSteps({ clock, session, token, started, boundMs, hardMs: cellLeft() });
  // The status of a probe its bound ended.
  const bound = () => (!steps.hardEnded() && runLeft < probe.cellBoundMs ? "run_budget_exhausted" : "probe_timeout");

  const called = await isolatedWorldRead({
    steps,
    mainFrame,
    worldName: "campaigns-os-polish-readability-probe",
    functionDeclaration: readabilityProbeSource(),
    leadingArgs: [{ value: { elements: probe.elementCap } }],
    frameOwners: true,
  });
  if (called === BOUND_ENDED) return unmeasured(bound());
  if (called === null || !readabilityObservationOk(called.value)) return unmeasured("document_changed");
  const same = await sameMainDocument({ steps, mainFrame });
  if (same === BOUND_ENDED) return unmeasured(bound());
  if (!same) return unmeasured("document_changed");
  if (steps.cancelled()) return unmeasured(bound());
  const read = called.value;
  const probeMs = spent();
  if (read.status !== "measured") return { ...unmeasured(read.status), probe_ms: probeMs };

  // Crops, after every measurement in the cell.
  const cropStarted = clock.now();
  const cropSpent = () => Math.max(0, clock.now() - cropStarted);
  const cropLeft = Math.min(probe.cropRemainingMs, probe.addedRemainingMs - probeMs);
  const crops = [];
  const elements = read.elements;
  const viewport = read.viewport || {};
  const targets = readabilityCropTargets(elements);
  const cropSteps = cropLeft > 0 && cellLeft() > 0 ? boundedProbeSteps({ clock, session, token: cropToken, started: cropStarted, boundMs: cropLeft, hardMs: cellLeft() }) : null;
  for (const [taken, index] of targets.entries()) {
    const element = elements[index];
    const rect = element.rect || {};
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const width = Math.min(viewport.width, rect.x + rect.width) - x;
    const height = Math.min(viewport.height, rect.y + rect.height) - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      element.crop_reason = "outside_viewport";
      continue;
    }
    if (taken >= probe.cropsPerCell || !cropSteps || cropSteps.cancelled()) {
      element.crop_reason = "crop_unavailable";
      continue;
    }
    const shot = await cropSteps.step(() => cropSteps.send("Page.captureScreenshot", {
      format: "png",
      clip: { x, y, width, height, scale: 1 },
      captureBeyondViewport: false,
    }));
    if (shot === BOUND_ENDED || shot.error || typeof shot.value?.data !== "string" || shot.value.data === "") {
      element.crop_reason = "crop_unavailable";
      continue;
    }
    crops.push({ element: index, data: shot.value.data });
  }
  // The crops are of the measured document only: the re-read is a crop step.
  // When the bound ends first, no crop taken can be shown to be of it.
  const cropped = crops.length ? await sameMainDocument({ steps: cropSteps, mainFrame }) : true;
  const cropMs = targets.length ? cropSpent() : 0;
  if (cropped === BOUND_ENDED) {
    for (const crop of crops.splice(0)) elements[crop.element].crop_reason = "crop_unavailable";
  } else if (!cropped) {
    return { ...unmeasured("document_changed"), probe_ms: probeMs, crop_ms: cropMs };
  }
  return {
    status: "measured",
    capped: read.capped,
    coverage_gaps: read.coverage_gaps,
    elements,
    crops,
    probe_ms: probeMs,
    crop_ms: cropMs,
  };
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
  // One cell in a fresh browser context: the context (viewport, service
  // workers blocked, the auth cookies), its page and CDP session, `work`
  // under the adapter cell deadline, and the context closed under the cleanup
  // bound. A timeout or a failed cleanup poisons the adapter for every later
  // cell. `work` also gets `cellLeftMs()`, the time left before the cell
  // deadline less the readability headroom. With `setup` ({ step, ended }),
  // each setup call is a `step` of the caller's bound (boundedProbeSteps); a
  // bound that ends during setup makes the cell return `ended()` instead of
  // running `work`, and a context created after that is closed.
  const inCaptureContext = async ({ url, viewport, signal, setup = null }, work) => {
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
    let setupEnded = false;
    // One setup call: under the caller's bound when there is one.
    const settle = async (start) => {
      if (!setup) return awaitActive(start());
      const settled = await setup.step(start);
      assertActive();
      if (settled === BOUND_ENDED) {
        setupEnded = true;
        throw BOUND_ENDED;
      }
      if (settled.error) throw settled.error;
      return settled.value;
    };
    const cellStartedAt = performance.now();
    const cellLeftMs = () => boundedCellDeadlineMs - (performance.now() - cellStartedAt) - READABILITY_CELL_HEADROOM_MS;
    let observation;
    let operationError = null;
    try {
      observation = await runWithPolishProducerDeadline(async () => {
        assertActive();
        // The context is kept as soon as it exists, so cleanup closes it; one
        // that arrives after the setup bound ended is closed at once.
        const newContext = () => Promise.resolve(browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          serviceWorkers: "block",
        })).then((created) => {
          if (setupEnded) void Promise.resolve().then(() => created?.close()).catch(() => {});
          else context = created;
          return created;
        });
        if (setup) await settle(newContext);
        else await newContext();
        assertActive();
        if (authCookies.length > 0) {
          const origin = captureOrigin(url);
          // Fixed message: a URL containing credentials or query data is never echoed.
          if (origin === null) throw new Error("Campaigns OS polish capture requires an HTTP(S) capture URL before applying --auth-cookie.");
          await settle(() => context.addCookies(authCookies.map((cookie) => ({ ...cookie, url: origin }))));
        }
        const page = await settle(() => context.newPage());
        session = setup ? await settle(() => context.newCDPSession(page)) : await context.newCDPSession(page);
        assertActive();
        return work({ page, session, awaitActive, cellLeftMs });
      }, {
        timeoutMs: boundedCellDeadlineMs,
        onTimeout: triggerTimeout,
        signal,
      });
    } catch (error) {
      if (error === BOUND_ENDED && setup) observation = setup.ended();
      else operationError = error;
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
  };
  return {
    // `imageProbe` ({ clock, remainingMs, cellBoundMs, imageCap }) opts the
    // cell into the media-weight image probe; the observation then carries
    // `imageProbe` beside the page-load fields. `readabilityProbe` ({ clock,
    // cellBoundMs, probeRemainingMs, cropRemainingMs, addedRemainingMs,
    // elementCap, cropsPerCell }) opts it into the readability probe, run
    // after the image probe; the observation then carries `readability`.
    async captureRoute({ url, viewport, signal, imageProbe: probeOptions = null, readabilityProbe: readabilityOptions = null } = {}) {
      return inCaptureContext({ url, viewport, signal }, async ({ page, session, awaitActive, cellLeftMs }) => {
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
          ? await awaitActive(probeImageElements({ session, mainFrame, documentContextChanged, probe: probeOptions }))
          : null;
        const readability = readabilityOptions && typeof readabilityOptions === "object"
          ? await awaitActive(probeReadabilityDocument({ session, mainFrame, documentContextChanged, probe: { ...readabilityOptions, cellLeftMs: cellLeftMs() } }))
          : null;
        return {
          finalDocumentUrl,
          responseCollectionStatus: network.responseCollectionStatus,
          networkidle,
          mediaElements,
          responses: network.responses,
          ...(imageProbe ? { imageProbe } : {}),
          ...(readability ? { readability } : {}),
        };
      });
    },

    // A readability-only cell: a fresh context like captureRoute's, `goto`
    // until domcontentloaded, the network-idle wait (a timeout is recorded,
    // not a failure), then the readability probe (`probe` as captureRoute's
    // readabilityProbe). Navigation is bounded by the added run budget left
    // as well; a navigation that fails, or answers with an HTTP error, reads
    // navigation_failed, and one the budget cut, run_budget_exhausted.
    // Returns the probe's result and `networkidle`.
    async probeReadabilityRoute(route, viewport, { signal, probe = {} } = {}) {
      const clock = isProbeClock(probe.clock) ? probe.clock : realProbeClock;
      const cellStarted = clock.now();
      const addedLeft = () => probe.addedRemainingMs - Math.max(0, clock.now() - cellStarted);
      const unmeasured = (status, networkidle = null) => ({ status, capped: false, coverage_gaps: [], elements: [], crops: [], probe_ms: 0, crop_ms: 0, networkidle });
      // Every browser call of the cell is a step of a bound: the added budget
      // left on `clock` (a cell that starts with none makes no call), and the
      // cell deadline's headroom in real time. A bound the added budget ends
      // reads run_budget_exhausted; one the cell deadline's headroom ends,
      // probe_timeout. The setup calls (context, page, CDP session) have their
      // own bound, so it never cancels the page's steps.
      const token = { cancelled: false };
      const setupToken = { cancelled: false };
      let cdp = null;
      const bounded = (boundMs, hardMs, stepsToken = token) => boundedProbeSteps({ clock, session: { send: (method, params) => cdp.send(method, params) }, token: stepsToken, started: clock.now(), boundMs, hardMs });
      try {
        const setupSteps = bounded(probe.addedRemainingMs, boundedCellDeadlineMs - READABILITY_CELL_HEADROOM_MS, setupToken);
        const setup = { step: setupSteps.step, ended: () => unmeasured(setupSteps.hardEnded() ? "probe_timeout" : "run_budget_exhausted") };
        return await inCaptureContext({ url: route?.url, viewport, signal, setup }, async ({ page, session, awaitActive, cellLeftMs }) => {
          cdp = session;
          const addedAtStart = addedLeft();
          const cellAtStart = cellLeftMs();
          if (!(addedAtStart > 0)) return unmeasured("run_budget_exhausted");
          if (!(cellAtStart > 0)) return unmeasured("probe_timeout");
          const steps = bounded(addedAtStart, cellAtStart);
          const boundEnded = () => (steps.hardEnded() ? "probe_timeout" : "run_budget_exhausted");
          const navigationTimeout = Math.max(1, Math.min(NAVIGATION_TIMEOUT_MS, Math.floor(addedAtStart), Math.floor(cellAtStart)));
          const navigationStartedAt = performance.now();
          const navigated = await awaitActive(steps.step(() => page.goto(route.url, { waitUntil: "domcontentloaded", timeout: navigationTimeout })));
          if (navigated === BOUND_ENDED) return unmeasured(boundEnded());
          if (navigated.error) {
            if (navigated.error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) throw navigated.error;
            const cutByAdded = navigationTimeout < NAVIGATION_TIMEOUT_MS && navigationTimeout === Math.max(1, Math.floor(addedAtStart));
            return unmeasured(timeoutError(navigated.error) && cutByAdded ? "run_budget_exhausted" : "navigation_failed");
          }
          if (!navigated.value || navigated.value.status() >= 400) return unmeasured("navigation_failed");
          const initialTree = await awaitActive(steps.step(() => steps.send("Page.getFrameTree")));
          if (initialTree === BOUND_ENDED) return unmeasured(boundEnded());
          if (initialTree.error) return unmeasured("document_changed");
          const initialMainFrame = initialTree.value?.frameTree?.frame;
          const idleTimeout = Math.max(1, Math.min(NETWORKIDLE_TIMEOUT_MS, Math.floor(addedLeft()), Math.floor(cellLeftMs())));
          const idle = await awaitActive(steps.step(() => page.waitForLoadState("networkidle", { timeout: idleTimeout })));
          if (idle === BOUND_ENDED) return unmeasured(boundEnded());
          if (idle.error && !timeoutError(idle.error)) throw idle.error;
          const networkidle = { status: idle.error ? "timeout" : "settled", duration_ms: durationSince(navigationStartedAt) };
          const finalTree = await awaitActive(steps.step(() => steps.send("Page.getFrameTree")));
          if (finalTree === BOUND_ENDED) return unmeasured(boundEnded(), networkidle);
          if (finalTree.error) return unmeasured("document_changed", networkidle);
          const mainFrame = finalTree.value?.frameTree?.frame;
          const documentContextChanged = typeof initialMainFrame?.id !== "string"
            || typeof initialMainFrame?.loaderId !== "string"
            || initialMainFrame.id !== mainFrame?.id
            || initialMainFrame.loaderId !== mainFrame?.loaderId;
          const readability = await awaitActive(probeReadabilityDocument({
            session,
            mainFrame,
            documentContextChanged,
            probe: { ...probe, addedRemainingMs: addedLeft(), cellLeftMs: cellLeftMs() },
          }));
          return { ...readability, networkidle };
        });
      } finally {
        token.cancelled = true;
        setupToken.cancelled = true;
      }
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
