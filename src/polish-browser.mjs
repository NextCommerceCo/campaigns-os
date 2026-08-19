import { createHash } from "node:crypto";

import {
  MAX_PAGE_LOAD_MEDIA_ANCESTORS,
  MAX_PAGE_LOAD_MEDIA_ELEMENTS,
  MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  MAX_PAGE_LOAD_RESPONSE_RECORDS,
  MAX_POLISH_CAPTURE_URL_LENGTH,
} from "./polish-capture.mjs";
import {
  boundedPolishDeadline,
  POLISH_BROWSER_CELL_DEADLINE_MS,
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
export const POLISH_BROWSER_UNAVAILABLE_ERROR_CODE = "POLISH_BROWSER_UNAVAILABLE";

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

function boundedCaptureUrl(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_POLISH_CAPTURE_URL_LENGTH ? "[url-too-long]" : value;
}

function projectProtocolResponse(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ...(typeof value.url === "string" ? { url: boundedCaptureUrl(value.url) } : {}),
    ...(Number.isInteger(value.status) ? { status: value.status } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(nonnegativeInteger(value.encodedDataLength) !== undefined
      ? { encodedDataLength: value.encodedDataLength }
      : {}),
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

function captureOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // Use the fixed error below so a URL containing credentials or query data is never echoed.
  }
  throw new Error("Campaigns OS polish capture requires an HTTP(S) capture URL before applying --auth-cookie.");
}

function currentRequest(event = {}) {
  return {
    requestUrl: boundedCaptureUrl(event?.request?.url),
    resourceType: typeof event?.type === "string" ? event.type : null,
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
} = {}) {
  const url = typeof response?.url === "string" && response.url !== ""
    ? response.url
    : current?.requestUrl;
  const sourceUrls = uniqueStrings([current?.requestUrl]);
  const measuredLength = nonnegativeInteger(encodedDataLength);
  const lowerBound = current?.encodedDataObserved
    ? nonnegativeInteger(current.encodedDataLengthLowerBound)
    : undefined;
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

function completeResponseRecord(record) {
  return typeof record?.url === "string"
    && typeof record?.resource_type === "string"
    && Number.isInteger(record?.status)
    && nonnegativeInteger(record?.encoded_data_length) !== undefined;
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
      collectionFailed = true;
      return;
    }
    const record = responseRecord(state.current, options);
    if (record.failed || !completeResponseRecord(record)) collectionFailed = true;
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
            resourceType: typeof event.type === "string" ? event.type : null,
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
      finishCurrent(state, { failed: true });
      collectionFailed = true;
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
        if (state.current) finishCurrent(state, { failed: true });
        if (state.redirected || state.hops.length > 1) {
          responses.push({
            request_id: state.requestId,
            redirect_chain: state.hops.map((hop, redirectHop) => ({
              ...projectRecord(hop),
              redirect_hop: redirectHop,
            })),
          });
        } else if (state.hops.length === 1) {
          responses.push({ request_id: state.requestId, ...projectRecord(state.hops[0]) });
        } else {
          collectionFailed = true;
        }
      }
      if (responseOverflow) responses.push({ capture_problem: "response_record_overflow" });
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

function missingBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /executable doesn't exist|browser.*not found|playwright install|install.*chromium/i.test(message);
}

async function chromiumLauncher(injectedChromium) {
  if (injectedChromium) return injectedChromium;
  try {
    const playwright = await import("playwright");
    return playwright.chromium;
  } catch {
    throw browserUnavailableError([
      "Playwright is not installed for Campaigns OS polish capture.",
      "Run `npm install` from the campaigns-os repo, then rerun `campaigns-os polish capture`.",
    ].join(" "));
  }
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
  const startupPromise = Promise.resolve().then(async () => {
    const chromium = await chromiumLauncher(injectedChromium);
    if (startupTimedOut) throw polishProducerTimeoutError();
    let launchedBrowser;
    try {
      launchedBrowser = await chromium.launch({ headless: headed !== true });
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
  try {
    browser = await runWithPolishProducerDeadline(() => startupPromise, {
      timeoutMs: boundedStartupDeadlineMs,
      onTimeout() { startupTimedOut = true; },
    });
  } catch (error) {
    if (error?.code === POLISH_PRODUCER_TIMEOUT_ERROR_CODE) throw error;
    if (missingBrowserError(error)) {
      throw browserUnavailableError([
        "Playwright Chromium is not installed for Campaigns OS polish capture.",
        "Run `npm run qa:install-browser` from the campaigns-os repo, then rerun `campaigns-os polish capture`.",
      ].join(" "));
    }
    throw error;
  }

  let closed = false;
  let poisonCode = null;
  let closePromise = null;
  return {
    async captureRoute({ url, viewport, signal } = {}) {
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
        }
        if (typeof context?.close === "function" && !contextClosePromise) {
          contextClosePromise = Promise.resolve().then(() => context.close());
        }
        return Promise.allSettled([detachPromise, contextClosePromise].filter(Boolean)).then((results) => {
          if (results.some((result) => result.status === "rejected")) throw polishProducerCleanupError();
        });
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
            network.responses.push({ capture_problem: "document_context_changed" });
          }
          return {
            finalDocumentUrl,
            responseCollectionStatus: network.responseCollectionStatus,
            networkidle,
            mediaElements,
            responses: network.responses,
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
