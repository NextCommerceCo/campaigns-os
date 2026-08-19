const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORKIDLE_TIMEOUT_MS = 5_000;

const NETWORK_EVENTS = Object.freeze([
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.requestServedFromCache",
]);

const AUTH_COOKIE_ERROR = "Campaigns OS polish capture received a malformed or empty --auth-cookie value.";
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
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
    requestUrl: typeof event?.request?.url === "string" ? event.request.url : null,
    resourceType: typeof event?.type === "string" ? event.type : null,
    response: null,
    requestServedFromCache: false,
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
  const record = {
    ...(typeof url === "string" && url !== "" ? { url } : {}),
    ...(typeof current?.resourceType === "string" && current.resourceType !== ""
      ? { resource_type: current.resourceType }
      : {}),
    ...(Number.isInteger(response?.status) ? { status: response.status } : {}),
    ...(nonnegativeInteger(encodedDataLength) !== undefined
      ? { encoded_data_length: encodedDataLength }
      : {}),
    source_urls: sourceUrls,
    from_disk_cache: Boolean(response?.fromDiskCache),
    from_prefetch_cache: Boolean(response?.fromPrefetchCache),
    from_service_worker: Boolean(response?.fromServiceWorker),
    request_served_from_cache: Boolean(current?.requestServedFromCache),
    failed: Boolean(failed),
  };
  return record;
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

  function stateFor(requestId) {
    if (typeof requestId !== "string" || requestId === "") {
      collectionFailed = true;
      return null;
    }
    let state = requests.get(requestId);
    if (!state) {
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
    state.hops.push(record);
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
            requestUrl: typeof event.redirectResponse.url === "string" ? event.redirectResponse.url : null,
            resourceType: typeof event.type === "string" ? event.type : null,
            response: null,
            requestServedFromCache: false,
          };
        }
        finishCurrent(state, {
          response: event.redirectResponse,
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
          requestUrl: typeof event?.response?.url === "string" ? event.response.url : null,
          resourceType: typeof event.type === "string" ? event.type : null,
          response: null,
          requestServedFromCache: false,
        };
      }
      if (state.current.response) collectionFailed = true;
      state.current.response = event.response || null;
      if (!state.current.resourceType && typeof event.type === "string") {
        state.current.resourceType = event.type;
      }
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
        };
      }
      state.current.requestServedFromCache = true;
    },
  };

  return {
    listen(session) {
      for (const event of NETWORK_EVENTS) session.on(event, handlers[event]);
    },

    finish() {
      const responses = [];
      for (const state of requests.values()) {
        if (state.current) finishCurrent(state, { failed: true });
        if (state.redirected || state.hops.length > 1) {
          responses.push({
            request_id: state.requestId,
            redirect_chain: state.hops.map((hop, redirectHop) => ({
              ...hop,
              redirect_hop: redirectHop,
            })),
          });
        } else if (state.hops.length === 1) {
          responses.push({ request_id: state.requestId, ...state.hops[0] });
        } else {
          collectionFailed = true;
        }
      }
      return {
        responseCollectionStatus: collectionFailed ? "failed" : "complete",
        responses,
      };
    },
  };
}

async function collectMediaElements(page) {
  return page.evaluate(() => [...document.querySelectorAll("video, audio")].map((element) => {
    const styleProjection = (node) => {
      const style = getComputedStyle(node);
      return { display: style.display, visibility: style.visibility };
    };
    const ancestorStyles = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestorStyles.push(styleProjection(ancestor));
    }
    const bounds = element.getBoundingClientRect();
    return {
      tag_name: element.tagName.toLowerCase(),
      current_src: typeof element.currentSrc === "string" ? element.currentSrc : null,
      src_attribute: element.getAttribute("src"),
      source_src_attributes: [...element.querySelectorAll("source")]
        .map((source) => source.getAttribute("src") ?? ""),
      preload_attribute: element.getAttribute("preload"),
      computed_style: styleProjection(element),
      ancestor_styles: ancestorStyles,
      bounding_box: { width: bounds.width, height: bounds.height },
    };
  }));
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
    throw new Error([
      "Playwright is not installed for Campaigns OS polish capture.",
      "Run `npm install` from the campaigns-os repo, then rerun `campaigns-os polish capture`.",
    ].join(" "));
  }
}

export async function createPolishBrowserAdapter({
  headed = false,
  authCookie = null,
  chromium: injectedChromium,
} = {}) {
  const authCookies = parseAuthCookie(authCookie);
  const chromium = await chromiumLauncher(injectedChromium);
  let browser;
  try {
    browser = await chromium.launch({ headless: headed !== true });
  } catch (error) {
    if (missingBrowserError(error)) {
      throw new Error([
        "Playwright Chromium is not installed for Campaigns OS polish capture.",
        "Run `npm run qa:install-browser` from the campaigns-os repo, then rerun `campaigns-os polish capture`.",
      ].join(" "));
    }
    throw error;
  }

  let closed = false;
  return {
    async captureRoute({ url, viewport } = {}) {
      if (closed) throw new Error("Campaigns OS polish capture browser adapter is already closed.");
      if (!Number.isInteger(viewport?.width) || viewport.width <= 0
        || !Number.isInteger(viewport?.height) || viewport.height <= 0) {
        throw new Error("Campaigns OS polish capture requires a positive integer viewport.");
      }
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: "block",
      });
      let session;
      try {
        if (authCookies.length > 0) {
          const origin = captureOrigin(url);
          await context.addCookies(authCookies.map((cookie) => ({ ...cookie, url: origin })));
        }
        const page = await context.newPage();
        session = await context.newCDPSession(page);
        const collector = createNetworkCollector();
        await session.send("Network.enable");
        await session.send("Network.setCacheDisabled", { cacheDisabled: true });
        await session.send("Network.setBypassServiceWorker", { bypass: true });
        collector.listen(session);

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        const mediaElements = await collectMediaElements(page);
        const networkidleStartedAt = performance.now();
        let networkidle;
        try {
          await page.waitForLoadState("networkidle", { timeout: NETWORKIDLE_TIMEOUT_MS });
          networkidle = { status: "settled", duration_ms: durationSince(networkidleStartedAt) };
        } catch (error) {
          if (!timeoutError(error)) throw error;
          networkidle = { status: "timeout", duration_ms: durationSince(networkidleStartedAt) };
        }
        await drainProtocolEvents();
        const network = collector.finish();
        return {
          finalDocumentUrl: page.url(),
          responseCollectionStatus: network.responseCollectionStatus,
          networkidle,
          mediaElements,
          responses: network.responses,
        };
      } finally {
        if (typeof session?.detach === "function") await session.detach().catch(() => {});
        await context.close().catch(() => {});
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } catch {
        throw new Error("Campaigns OS polish capture could not close its browser cleanly.");
      }
    },
  };
}
