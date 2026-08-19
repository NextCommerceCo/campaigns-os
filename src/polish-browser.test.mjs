import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPolishBrowserAdapter } from "./polish-browser.mjs";
import {
  buildPageLoadCapture,
  MAX_PAGE_LOAD_MEDIA_ANCESTORS,
  MAX_PAGE_LOAD_MEDIA_ELEMENTS,
  MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  MAX_POLISH_CAPTURE_URL_LENGTH,
} from "./polish-capture.mjs";

const DOCUMENT_CONTEXT_FINGERPRINT = `sha256:${createHash("sha256")
  .update("main-frame\u0000main-loader")
  .digest("hex")}`;

function fakeChromium(scenarios = [{}], browserOptions = {}) {
  const calls = [];
  const contexts = [];
  let nextScenario = 0;

  const chromium = {
    async launch(options) {
      calls.push(["launch", options]);
      return {
        async newContext(options) {
          const scenario = scenarios[nextScenario] || {};
          const contextIndex = nextScenario;
          nextScenario += 1;
          calls.push(["newContext", contextIndex, options]);
          const listeners = new Map();
          let frameTreeCall = 0;
          const emit = (event, payload) => {
            calls.push(["emit", contextIndex, event]);
            const isDocumentEvent = payload?.type === "Document";
            const projectedPayload = isDocumentEvent ? {
              frameId: "main-frame",
              loaderId: "main-loader",
              ...payload,
              ...(payload?.response ? {
                response: { mimeType: "text/html", ...payload.response },
              } : {}),
            } : payload;
            for (const listener of listeners.get(event) || []) listener(projectedPayload);
          };
          const session = {
            on(event, listener) {
              calls.push(["on", contextIndex, event]);
              const registered = listeners.get(event) || [];
              registered.push(listener);
              listeners.set(event, registered);
            },
            async send(method, params) {
              calls.push(["send", contextIndex, method, params]);
              if (scenario.sendError?.method === method) throw scenario.sendError.error;
              if (method === "Page.getFrameTree") {
                const frameTree = Array.isArray(scenario.frameTrees)
                  ? scenario.frameTrees[Math.min(frameTreeCall, scenario.frameTrees.length - 1)]
                  : scenario.frameTree;
                frameTreeCall += 1;
                return frameTree || {
                  frameTree: { frame: { id: "main-frame", loaderId: "main-loader" } },
                };
              }
            },
            async detach() {
              calls.push(["detach", contextIndex]);
            },
          };
          const page = {
            async goto(url, options) {
              calls.push(["goto", contextIndex, url, options]);
              await scenario.navigate?.({ emit, url });
              if (scenario.gotoError) throw scenario.gotoError;
            },
            async evaluate(callback, argument) {
              calls.push(["evaluate", contextIndex]);
              return scenario.evaluate
                ? scenario.evaluate(callback, argument)
                : {
                    observed_element_count: (scenario.mediaElements || []).length,
                    elements: (scenario.mediaElements || []).map((element, index) => ({
                      capture_element_id: `media-${index}`,
                      source_overflow_count: 0,
                      ancestor_overflow_count: 0,
                      ...element,
                    })),
                  };
            },
            async waitForLoadState(state, options) {
              calls.push(["waitForLoadState", contextIndex, state, options]);
              await scenario.waitForLoadState?.({ emit, state, options });
              if (scenario.networkidleError) throw scenario.networkidleError;
            },
            url() {
              return scenario.finalUrl || scenario.requestedUrl || "https://shop.example.test/landing/";
            },
          };
          const context = {
            async addCookies(cookies) {
              calls.push(["addCookies", contextIndex, cookies]);
            },
            async newPage() {
              calls.push(["newPage", contextIndex]);
              return page;
            },
            async newCDPSession(receivedPage) {
              assert.equal(receivedPage, page);
              calls.push(["newCDPSession", contextIndex]);
              return session;
            },
            async close() {
              calls.push(["context.close", contextIndex]);
            },
          };
          contexts.push(context);
          return context;
        },
        async close() {
          calls.push(["browser.close"]);
          if (browserOptions.closeError) throw browserOptions.closeError;
        },
      };
    },
  };

  return { chromium, calls, contexts };
}

async function executeDomEvaluator(callback, elements, documentState = {}, argument) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const computedStyleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  documentState.querySelectorAll = (selector) => selector === "video, audio" ? elements : [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentState,
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element) => element.testComputedStyle,
  });
  try {
    return callback(argument);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
    if (computedStyleDescriptor) Object.defineProperty(globalThis, "getComputedStyle", computedStyleDescriptor);
    else delete globalThis.getComputedStyle;
  }
}

test("a route capture configures CDP before navigation and returns a completed response observation", async () => {
  const url = "https://shop.example.test/landing/";
  const fake = fakeChromium([{
    requestedUrl: url,
    finalUrl: url,
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "document-1",
        type: "Document",
        request: { url },
      });
      emit("Network.responseReceived", {
        requestId: "document-1",
        type: "Document",
        response: {
          url,
          status: 200,
          headers: { "set-cookie": "session=private-secret" },
          securityDetails: { subjectName: "private-secret" },
        },
      });
      emit("Network.loadingFinished", {
        requestId: "document-1",
        encodedDataLength: 1_234,
      });
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.deepEqual(fake.calls[0], ["launch", { headless: true }]);
  assert.deepEqual(fake.calls.find(([name]) => name === "newContext"), [
    "newContext",
    0,
    { viewport: { width: 1_440, height: 1_200 }, serviceWorkers: "block" },
  ]);
  const firstListener = fake.calls.findIndex(([name]) => name === "on");
  const navigation = fake.calls.findIndex(([name]) => name === "goto");
  assert.ok(firstListener >= 0 && firstListener < navigation);
  assert.deepEqual(fake.calls.filter(([name]) => name === "send"), [
    ["send", 0, "Network.enable", undefined],
    ["send", 0, "Network.setCacheDisabled", { cacheDisabled: true }],
    ["send", 0, "Network.setBypassServiceWorker", { bypass: true }],
    ["send", 0, "Page.getFrameTree", undefined],
    ["send", 0, "Page.getFrameTree", undefined],
  ]);
  assert.deepEqual(result, {
    finalDocumentUrl: url,
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: result.networkidle.duration_ms },
    mediaElements: [],
    responses: [{
      request_id: "document-1",
      url,
      resource_type: "Document",
      status: 200,
      mime_type: "text/html",
      encoded_data_length: 1_234,
      source_urls: [url],
      from_disk_cache: false,
      from_prefetch_cache: false,
      from_service_worker: false,
      request_served_from_cache: false,
      failed: false,
      is_final_main_document: true,
      document_context_fingerprint: DOCUMENT_CONTEXT_FINGERPRINT,
    }],
  });
  assert.ok(Number.isInteger(result.networkidle.duration_ms));
  assert.ok(result.networkidle.duration_ms >= 0);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
  assert.deepEqual(fake.calls.at(-3), ["detach", 0]);
  assert.deepEqual(fake.calls.at(-2), ["context.close", 0]);
  assert.deepEqual(fake.calls.at(-1), ["browser.close"]);
});

test("main-document response status is preserved for the core terminal-status assessment", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const scenarios = [200, 404, 500].map((status) => ({
    finalUrl: pageUrl,
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: `document-${status}`,
        type: "Document",
        request: { url: pageUrl },
      });
      emit("Network.responseReceived", {
        requestId: `document-${status}`,
        type: "Document",
        response: { url: pageUrl, status },
      });
      emit("Network.loadingFinished", {
        requestId: `document-${status}`,
        encodedDataLength: 1_024,
      });
    },
  }));
  const fake = fakeChromium(scenarios);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const statuses = [];
  for (const viewport of [
    { key: "desktop", width: 1_440, height: 1_200 },
    { key: "mobile", width: 390, height: 844 },
    { key: "desktop", width: 1_440, height: 1_200 },
  ]) {
    const result = await adapter.captureRoute({ url: pageUrl, viewport });
    statuses.push(result.responses[0].status);
  }
  await adapter.close();

  assert.deepEqual(statuses, [200, 404, 500]);
});

test("same-URL iframe documents cannot substitute for the final root-frame response", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const emitDocument = (emit, requestId, frameId, loaderId) => {
    emit("Network.requestWillBeSent", {
      requestId,
      type: "Document",
      frameId,
      loaderId,
      request: { url: pageUrl },
    });
    emit("Network.responseReceived", {
      requestId,
      type: "Document",
      frameId,
      loaderId,
      response: { url: pageUrl, status: 200 },
    });
    emit("Network.loadingFinished", { requestId, encodedDataLength: 1_024 });
  };
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    async navigate({ emit }) {
      emitDocument(emit, "same-url-iframe", "iframe", "iframe-loader");
      emitDocument(emit, "main-document", "main-frame", "main-loader");
    },
  }, {
    finalUrl: pageUrl,
    async navigate({ emit }) {
      emitDocument(emit, "same-url-iframe-only", "iframe", "iframe-loader");
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  const viewport = { key: "desktop", width: 1_440, height: 1_200 };

  const withMain = await adapter.captureRoute({ url: pageUrl, viewport });
  assert.equal(withMain.responses.filter((response) => response.is_final_main_document).length, 1);
  assert.equal(buildPageLoadCapture({
    buildFingerprint: `sha256:${"a".repeat(64)}`,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    requestedDocumentUrl: pageUrl,
    ...withMain,
  }).measurement_status, "complete");

  const iframeOnly = await adapter.captureRoute({ url: pageUrl, viewport });
  const incomplete = buildPageLoadCapture({
    buildFingerprint: `sha256:${"a".repeat(64)}`,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    requestedDocumentUrl: pageUrl,
    ...iframeOnly,
  });
  await adapter.close();
  assert.equal(incomplete.measurement_status, "incomplete");
  assert.equal(incomplete.problems.some((problem) => problem.code === "document_response_missing"), true);
});

test("headed authenticated captures bind parsed cookies to each page origin without a global Cookie header", async () => {
  const fake = fakeChromium([
    { requestedUrl: "https://shop.example.test/one/", finalUrl: "https://shop.example.test/one/" },
    { requestedUrl: "https://account.example.test/two/", finalUrl: "https://account.example.test/two/" },
  ]);
  const adapter = await createPolishBrowserAdapter({
    chromium: fake.chromium,
    headed: true,
    authCookie: "session=private; signed=value=with=equals",
  });

  const first = await adapter.captureRoute({
    url: "https://shop.example.test/one/",
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  const second = await adapter.captureRoute({
    url: "https://account.example.test/two/",
    viewport: { key: "mobile", width: 390, height: 844 },
  });
  await adapter.close();
  await adapter.close();

  assert.deepEqual(fake.calls[0], ["launch", { headless: false }]);
  assert.equal(fake.contexts.length, 2);
  assert.notEqual(fake.contexts[0], fake.contexts[1]);
  assert.deepEqual(fake.calls.filter(([name]) => name === "newContext"), [
    ["newContext", 0, {
      viewport: { width: 1_440, height: 1_200 },
      serviceWorkers: "block",
    }],
    ["newContext", 1, {
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    }],
  ]);
  assert.deepEqual(fake.calls.filter(([name]) => name === "addCookies"), [
    ["addCookies", 0, [
      { name: "session", value: "private", url: "https://shop.example.test" },
      { name: "signed", value: "value=with=equals", url: "https://shop.example.test" },
    ]],
    ["addCookies", 1, [
      { name: "session", value: "private", url: "https://account.example.test" },
      { name: "signed", value: "value=with=equals", url: "https://account.example.test" },
    ]],
  ]);
  for (const [, , contextOptions] of fake.calls.filter(([name]) => name === "newContext")) {
    assert.equal(Object.hasOwn(contextOptions, "extraHTTPHeaders"), false);
  }
  const firstAddCookies = fake.calls.findIndex(([name]) => name === "addCookies");
  const firstNavigation = fake.calls.findIndex(([name]) => name === "goto");
  assert.ok(firstAddCookies >= 0 && firstAddCookies < firstNavigation);
  assert.equal(first.responseCollectionStatus, "complete");
  assert.deepEqual(first.responses, []);
  assert.equal(second.responseCollectionStatus, "complete");
  assert.deepEqual(second.responses, []);
  assert.equal(fake.calls.filter(([name]) => name === "context.close").length, 2);
  assert.equal(fake.calls.filter(([name]) => name === "browser.close").length, 1);
});

test("empty or malformed auth-cookie headers fail before browser launch with one privacy-safe error", async () => {
  const malformed = [
    "",
    "   ",
    "missing-equals-private",
    "=missing-name-private",
    "valid=one;",
    "bad name=private",
    "duplicate=one; duplicate=two-private",
    "control=private\nvalue",
    42,
  ];

  for (const authCookie of malformed) {
    const fake = fakeChromium();
    await assert.rejects(
      createPolishBrowserAdapter({ chromium: fake.chromium, authCookie }),
      (error) => {
        assert.equal(
          error.message,
          "Campaigns OS polish capture received a malformed or empty --auth-cookie value.",
        );
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
    assert.deepEqual(fake.calls, []);
  }
});

test("partial cross-origin responses preserve request aliases and cache or service-worker provenance", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const requestedMediaUrl = "https://assets.example.test/hero.mp4?token=private";
  const responseMediaUrl = "https://cdn.example.test/hero.mp4?token=private";
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "media-1",
        type: "Media",
        request: { url: requestedMediaUrl },
      });
      emit("Network.requestServedFromCache", { requestId: "media-1" });
      emit("Network.responseReceived", {
        requestId: "media-1",
        type: "Media",
        response: {
          url: responseMediaUrl,
          status: 206,
          fromDiskCache: true,
          fromPrefetchCache: true,
          fromServiceWorker: true,
        },
      });
      emit("Network.loadingFinished", { requestId: "media-1", encodedDataLength: 786_432 });
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.equal(result.responseCollectionStatus, "complete");
  assert.deepEqual(result.responses, [{
    request_id: "media-1",
    url: responseMediaUrl,
    resource_type: "Media",
    status: 206,
    encoded_data_length: 786_432,
    source_urls: [requestedMediaUrl],
    from_disk_cache: true,
    from_prefetch_cache: true,
    from_service_worker: true,
    request_served_from_cache: true,
    failed: false,
  }]);
});

test("same-request-id redirects become one parent-owned contiguous chain without double-counting bytes", async () => {
  const requestedUrl = "https://shop.example.test/landing";
  const finalUrl = "https://shop.example.test/landing/";
  const fake = fakeChromium([{
    finalUrl,
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "document-redirect",
        type: "Document",
        request: { url: requestedUrl },
      });
      emit("Network.requestWillBeSent", {
        requestId: "document-redirect",
        type: "Document",
        request: { url: finalUrl },
        redirectResponse: {
          url: requestedUrl,
          status: 302,
          encodedDataLength: 321,
          fromDiskCache: false,
          fromPrefetchCache: false,
          fromServiceWorker: false,
        },
      });
      emit("Network.responseReceived", {
        requestId: "document-redirect",
        type: "Document",
        response: { url: finalUrl, status: 200 },
      });
      emit("Network.loadingFinished", {
        requestId: "document-redirect",
        encodedDataLength: 4_567,
      });
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: requestedUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.equal(result.finalDocumentUrl, finalUrl);
  assert.equal(result.responseCollectionStatus, "complete");
  assert.deepEqual(result.responses, [{
    request_id: "document-redirect",
    redirect_chain: [
      {
        url: requestedUrl,
        resource_type: "Document",
        status: 302,
        encoded_data_length: 321,
        source_urls: [requestedUrl],
        from_disk_cache: false,
        from_prefetch_cache: false,
        from_service_worker: false,
        request_served_from_cache: false,
        failed: false,
        redirect_hop: 0,
      },
      {
        url: finalUrl,
        resource_type: "Document",
        status: 200,
        mime_type: "text/html",
        encoded_data_length: 4_567,
        source_urls: [finalUrl],
        from_disk_cache: false,
        from_prefetch_cache: false,
        from_service_worker: false,
        request_served_from_cache: false,
        failed: false,
        redirect_hop: 1,
        is_final_main_document: true,
        document_context_fingerprint: DOCUMENT_CONTEXT_FINGERPRINT,
      },
    ],
  }]);
  assert.equal(result.responses[0].redirect_chain.reduce(
    (sum, response) => sum + response.encoded_data_length,
    0,
  ), 4_888);
  assert.equal("request_id" in result.responses[0].redirect_chain[0], false);
  assert.equal("redirect_chain" in result.responses[0].redirect_chain[0], false);
});

test("failed and unfinished tracked transfers fail the collection without persisting raw protocol errors", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const failedUrl = "https://cdn.example.test/failed.mp4?token=private";
  const unfinishedUrl = "https://cdn.example.test/unfinished.mp4?token=private";
  const fake = fakeChromium([
    {
      finalUrl: pageUrl,
      async navigate({ emit }) {
        emit("Network.requestWillBeSent", {
          requestId: "failed-media",
          type: "Media",
          request: { url: failedUrl },
        });
        emit("Network.responseReceived", {
          requestId: "failed-media",
          type: "Media",
          response: { url: failedUrl, status: 503 },
        });
        emit("Network.loadingFailed", {
          requestId: "failed-media",
          errorText: "net::ERR_PRIVATE_SECRET",
          canceled: false,
        });
      },
    },
    {
      finalUrl: pageUrl,
      async navigate({ emit }) {
        emit("Network.requestWillBeSent", {
          requestId: "unfinished-media",
          type: "Media",
          request: { url: unfinishedUrl },
        });
      },
    },
  ]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const failed = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  const unfinished = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "mobile", width: 390, height: 844 },
  });
  await adapter.close();

  assert.equal(failed.responseCollectionStatus, "failed");
  assert.deepEqual(failed.responses, [{
    request_id: "failed-media",
    url: failedUrl,
    resource_type: "Media",
    status: 503,
    source_urls: [failedUrl],
    from_disk_cache: false,
    from_prefetch_cache: false,
    from_service_worker: false,
    request_served_from_cache: false,
    failed: true,
  }]);
  assert.equal(JSON.stringify(failed).includes("ERR_PRIVATE_SECRET"), false);

  assert.equal(unfinished.responseCollectionStatus, "failed");
  assert.deepEqual(unfinished.responses, [{
    request_id: "unfinished-media",
    url: unfinishedUrl,
    resource_type: "Media",
    source_urls: [unfinishedUrl],
    from_disk_cache: false,
    from_prefetch_cache: false,
    from_service_worker: false,
    request_served_from_cache: false,
    failed: true,
  }]);
});

test("adapter close projects browser failures without exposing raw paths or secrets", async () => {
  const fake = fakeChromium([], {
    closeError: new Error("close failed at /private/tmp/merchant?token=private"),
  });
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  await assert.rejects(
    adapter.close(),
    (error) => {
      assert.equal(error.message, "Campaigns OS polish capture could not close its browser cleanly.");
      assert.equal(error.message.includes("/private/tmp"), false);
      assert.equal(error.message.includes("token="), false);
      return true;
    },
  );
});

test("only a recognized networkidle timeout is evidence-only; other wait failures throw", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const completedNavigation = async ({ emit }) => {
    emit("Network.requestWillBeSent", {
      requestId: "document",
      type: "Document",
      request: { url: pageUrl },
    });
    emit("Network.responseReceived", {
      requestId: "document",
      type: "Document",
      response: { url: pageUrl, status: 200 },
    });
    emit("Network.loadingFinished", { requestId: "document", encodedDataLength: 900 });
  };
  const timeout = new Error("page.waitForLoadState: Timeout 5000ms exceeded.");
  timeout.name = "TimeoutError";
  const fake = fakeChromium([
    { finalUrl: pageUrl, navigate: completedNavigation, networkidleError: timeout },
    {
      finalUrl: pageUrl,
      navigate: completedNavigation,
      networkidleError: new Error("Protocol timeout while the browser target closed unexpectedly"),
    },
  ]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const timedOut = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  assert.equal(timedOut.responseCollectionStatus, "complete");
  assert.equal(timedOut.networkidle.status, "timeout");
  assert.ok(Number.isInteger(timedOut.networkidle.duration_ms));

  await assert.rejects(
    adapter.captureRoute({
      url: pageUrl,
      viewport: { key: "mobile", width: 390, height: 844 },
    }),
    /browser target closed unexpectedly/,
  );
  await adapter.close();
  assert.equal(fake.calls.filter(([name]) => name === "context.close").length, 2);
});

test("media snapshots use exact authored attributes and preserve DOMContentLoaded visibility", async () => {
  const root = {
    parentElement: null,
    testComputedStyle: { display: "block", visibility: "hidden" },
  };
  const wrapper = {
    parentElement: root,
    testComputedStyle: { display: "none", visibility: "visible" },
  };
  const sources = [
    { getAttribute: (name) => name === "src" ? "video-720.mp4?token=one" : null },
    { getAttribute: () => null },
    { getAttribute: (name) => name === "src" ? " video-1080.mp4?token=two " : null },
  ];
  const video = {
    tagName: "VIDEO",
    currentSrc: "https://cdn.example.test/video-1080.mp4?token=selected",
    src: "https://reflected.invalid/must-not-be-used.mp4",
    preload: "none",
    parentElement: wrapper,
    testComputedStyle: { display: "inline", visibility: "visible" },
    getAttribute(name) {
      if (name === "src") return " authored-video.mp4?token=source ";
      if (name === "preload") return " metadata ";
      return null;
    },
    querySelectorAll(selector) {
      return selector === "source" ? sources : [];
    },
    getBoundingClientRect() {
      return { width: 640.5, height: 0 };
    },
  };
  const pageUrl = "https://shop.example.test/landing/";
  const documentState = {};
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    evaluate: (callback, argument) => executeDomEvaluator(callback, [video], documentState, argument),
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.deepEqual(result.mediaElements, [{
    tag_name: "video",
    current_src: "https://cdn.example.test/video-1080.mp4?token=selected",
    src_attribute: " authored-video.mp4?token=source ",
    source_src_attributes: [
      "video-720.mp4?token=one",
      "",
      " video-1080.mp4?token=two ",
    ],
    observed_source_urls: [
      "https://cdn.example.test/video-1080.mp4?token=selected",
      " authored-video.mp4?token=source ",
      "video-720.mp4?token=one",
      " video-1080.mp4?token=two ",
    ],
    preload_attribute: " metadata ",
    computed_style: { display: "inline", visibility: "visible" },
    ancestor_styles: [
      { display: "none", visibility: "visible" },
      { display: "block", visibility: "hidden" },
    ],
    bounding_box: { width: 640.5, height: 0 },
  }]);
  assert.equal(JSON.stringify(result.mediaElements).includes("reflected.invalid"), false);
  const evaluateIndex = fake.calls.findIndex(([name]) => name === "evaluate");
  const networkidleIndex = fake.calls.findIndex(([name]) => name === "waitForLoadState");
  assert.ok(evaluateIndex >= 0 && evaluateIndex < networkidleIndex);
  assert.equal(fake.calls.filter(([name]) => name === "evaluate").length, 2);
  assert.ok(fake.calls.findLastIndex(([name]) => name === "evaluate") > networkidleIndex);
});

test("post-networkidle media sources merge by stable element identity without losing at-load visibility", async () => {
  let settled = false;
  const documentState = {};
  const dynamicVideo = {
    tagName: "VIDEO",
    parentElement: null,
    get currentSrc() {
      return settled
        ? "https://cdn.example.test/dynamic.mp4?token=private-final"
        : "https://cdn.example.test/dynamic.mp4?token=private-initial";
    },
    get testComputedStyle() {
      return settled
        ? { display: "block", visibility: "visible" }
        : { display: "none", visibility: "visible" };
    },
    getAttribute(name) {
      if (name === "src") return settled ? null : "/dynamic.mp4?token=private-initial";
      if (name === "preload") return null;
      return null;
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return settled ? { width: 640, height: 360 } : { width: 0, height: 0 };
    },
  };
  const initiallyVisible = {
    tagName: "VIDEO",
    parentElement: null,
    currentSrc: "https://cdn.example.test/visible.mp4",
    get testComputedStyle() {
      return settled
        ? { display: "none", visibility: "visible" }
        : { display: "block", visibility: "visible" };
    },
    getAttribute(name) { return name === "preload" ? "auto" : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 640, height: 360 }; },
  };
  const lateVideo = {
    tagName: "VIDEO",
    parentElement: null,
    currentSrc: "https://cdn.example.test/late.mp4",
    testComputedStyle: { display: "none", visibility: "visible" },
    getAttribute(name) { return name === "preload" ? "auto" : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
  const fake = fakeChromium([{
    finalUrl: "https://shop.example.test/landing/",
    evaluate: (callback, argument) => executeDomEvaluator(
      callback,
      settled ? [lateVideo, initiallyVisible, dynamicVideo] : [dynamicVideo, initiallyVisible],
      documentState,
      argument,
    ),
    async waitForLoadState() { settled = true; },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: "https://shop.example.test/landing/",
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.equal(result.mediaElements.length, 3);
  assert.deepEqual(result.mediaElements.map((media) => media.current_src), [
    "https://cdn.example.test/dynamic.mp4?token=private-final",
    "https://cdn.example.test/visible.mp4",
    "https://cdn.example.test/late.mp4",
  ]);
  assert.deepEqual(result.mediaElements.map((media) => media.computed_style.display), [
    "none",
    "block",
    "none",
  ]);
  assert.deepEqual(result.mediaElements[0].observed_source_urls, [
    "https://cdn.example.test/dynamic.mp4?token=private-initial",
    "/dynamic.mp4?token=private-initial",
    "https://cdn.example.test/dynamic.mp4?token=private-final",
  ]);
  assert.equal(result.mediaElements.some((media) => Object.hasOwn(media, "capture_element_id")), false);
});

test("networkidle duration starts before navigation rather than after DOM collection", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    async navigate() {
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.ok(result.networkidle.duration_ms >= 20, String(result.networkidle.duration_ms));
});

test("media collection caps elements, child sources, and ancestor traversal before browser transfer", async () => {
  const element = (index, overrides = {}) => ({
    tagName: "VIDEO",
    parentElement: null,
    currentSrc: `https://cdn.example.test/${index}.mp4`,
    testComputedStyle: { display: "block", visibility: "visible" },
    getAttribute() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 640, height: 360 }; },
    ...overrides,
  });
  const exactElements = Array.from({ length: MAX_PAGE_LOAD_MEDIA_ELEMENTS }, (_, index) => element(index));
  const overElements = [...exactElements, element("overflow")];
  let ancestor = null;
  for (let index = 0; index < MAX_PAGE_LOAD_MEDIA_ANCESTORS + 1; index += 1) {
    ancestor = {
      parentElement: ancestor,
      testComputedStyle: { display: "block", visibility: "visible" },
    };
  }
  const sources = Array.from({ length: MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT + 1 }, (_, index) => ({
    getAttribute: () => `/source-${index}.mp4`,
  }));
  const variableOverflow = element("variable", {
    parentElement: ancestor,
    querySelectorAll: () => sources,
  });
  const documents = [{}, {}, {}];
  const fake = fakeChromium([
    { evaluate: (callback, argument) => executeDomEvaluator(callback, exactElements, documents[0], argument) },
    { evaluate: (callback, argument) => executeDomEvaluator(callback, overElements, documents[1], argument) },
    { evaluate: (callback, argument) => executeDomEvaluator(callback, [variableOverflow], documents[2], argument) },
  ]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  const viewport = { key: "desktop", width: 1_440, height: 1_200 };

  const exact = await adapter.captureRoute({ url: "https://shop.example.test/exact/", viewport });
  assert.equal(exact.mediaElements.length, MAX_PAGE_LOAD_MEDIA_ELEMENTS);
  assert.equal(exact.mediaElements.observed_element_count, MAX_PAGE_LOAD_MEDIA_ELEMENTS);

  const over = await adapter.captureRoute({ url: "https://shop.example.test/over/", viewport });
  assert.equal(over.mediaElements.length, MAX_PAGE_LOAD_MEDIA_ELEMENTS);
  assert.equal(over.mediaElements.observed_element_count, MAX_PAGE_LOAD_MEDIA_ELEMENTS + 1);

  const variable = await adapter.captureRoute({ url: "https://shop.example.test/variable/", viewport });
  await adapter.close();
  assert.equal(variable.mediaElements[0].source_src_attributes.length, MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT);
  assert.equal(variable.mediaElements[0].ancestor_styles.length, MAX_PAGE_LOAD_MEDIA_ANCESTORS);
  assert.ok(variable.mediaElements[0].source_overflow_count > 0);
  assert.ok(variable.mediaElements[0].ancestor_overflow_count > 0);
});

test("network collector caps tracked requests without retaining an unbounded ignored-id set", async () => {
  const scenarioFor = (count) => ({
    async navigate({ emit }) {
      for (let index = 0; index < count; index += 1) {
        const requestId = `request-${index}`;
        const url = `https://shop.example.test/${index}.js`;
        emit("Network.requestWillBeSent", {
          requestId,
          type: "Script",
          request: { url },
        });
        emit("Network.responseReceived", {
          requestId,
          type: "Script",
          response: { url, status: 200, mimeType: "text/javascript" },
        });
        emit("Network.loadingFinished", { requestId, encodedDataLength: 1 });
      }
    },
  });
  const fake = fakeChromium([
    scenarioFor(MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES),
    scenarioFor(MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES + 1),
  ]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  const viewport = { key: "desktop", width: 1_440, height: 1_200 };

  const exact = await adapter.captureRoute({ url: "https://shop.example.test/exact/", viewport });
  assert.equal(exact.responseCollectionStatus, "complete");
  assert.equal(exact.responses.length, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES);

  const over = await adapter.captureRoute({ url: "https://shop.example.test/over/", viewport });
  await adapter.close();
  assert.equal(over.responseCollectionStatus, "failed");
  assert.equal(over.responses.length, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES + 1);
  assert.deepEqual(over.responses.at(-1), { capture_problem: "response_record_overflow" });
});

test("dataReceived preserves a bounded lower byte count for a slow unfinished media transfer", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const mediaUrl = "https://cdn.example.test/slow.mp4?token=private";
  const timeout = new Error("networkidle timed out");
  timeout.name = "TimeoutError";
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    networkidleError: timeout,
    mediaElements: [{
      tag_name: "video",
      current_src: mediaUrl,
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: null,
      computed_style: { display: "none", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "document",
        type: "Document",
        request: { url: pageUrl },
      });
      emit("Network.responseReceived", {
        requestId: "document",
        type: "Document",
        response: { url: pageUrl, status: 200 },
      });
      emit("Network.loadingFinished", { requestId: "document", encodedDataLength: 1_024 });
      emit("Network.requestWillBeSent", {
        requestId: "slow-media",
        type: "Media",
        request: { url: mediaUrl },
      });
      emit("Network.responseReceived", {
        requestId: "slow-media",
        type: "Media",
        response: { url: mediaUrl, status: 206, mimeType: "video/mp4" },
      });
      emit("Network.dataReceived", {
        requestId: "slow-media",
        encodedDataLength: 80 * 1_024 * 1_024,
      });
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();
  const slow = result.responses.find((response) => response.request_id === "slow-media");
  assert.equal(result.networkidle.status, "timeout");
  assert.equal(result.responseCollectionStatus, "failed");
  assert.equal(slow.encoded_data_length, 80 * 1_024 * 1_024);
  assert.equal(slow.failed, true);
  assert.equal(JSON.stringify(result).includes("token="), true, "raw browser observation remains in-memory only");
});

test("a changed main-document loader fails closed instead of merging colliding media IDs", async () => {
  const fake = fakeChromium([{
    frameTrees: [
      { frameTree: { frame: { id: "main-frame", loaderId: "loader-one" } } },
      { frameTree: { frame: { id: "main-frame", loaderId: "loader-two" } } },
    ],
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: "https://shop.example.test/landing/",
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();
  assert.equal(result.responseCollectionStatus, "failed");
  assert.deepEqual(result.responses, [{ capture_problem: "document_context_changed" }]);
});

test("oversized DOM and CDP URLs are replaced before crossing the adapter boundary", async () => {
  const hugeUrl = `https://cdn.example.test/${"a".repeat(MAX_POLISH_CAPTURE_URL_LENGTH)}PRIVATE_TAIL`;
  const documentState = {};
  const video = {
    tagName: "VIDEO",
    parentElement: null,
    currentSrc: hugeUrl,
    testComputedStyle: { display: "block", visibility: "visible" },
    getAttribute(name) { return name === "src" ? hugeUrl : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 640, height: 360 }; },
  };
  const fake = fakeChromium([{
    evaluate: (callback, argument) => executeDomEvaluator(callback, [video], documentState, argument),
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "huge-resource",
        type: "Script",
        request: { url: hugeUrl },
      });
      emit("Network.responseReceived", {
        requestId: "huge-resource",
        type: "Script",
        response: { url: hugeUrl, status: 200, mimeType: "text/javascript" },
      });
      emit("Network.loadingFinished", { requestId: "huge-resource", encodedDataLength: 10 });
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: "https://shop.example.test/landing/",
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();
  assert.equal(result.mediaElements[0].current_src, "[url-too-long]");
  assert.ok(result.mediaElements[0].url_overflow_count > 0);
  assert.equal(result.responses[0].url, "[url-too-long]");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_TAIL"), false);
  assert.ok(serialized.length < 20_000, String(serialized.length));
});

test("capture drains queued CDP lifecycle events before deciding whether transfers are unfinished", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    async navigate({ emit }) {
      emit("Network.requestWillBeSent", {
        requestId: "late-finish",
        type: "Document",
        request: { url: pageUrl },
      });
      emit("Network.responseReceived", {
        requestId: "late-finish",
        type: "Document",
        response: { url: pageUrl, status: 200 },
      });
    },
    async waitForLoadState({ emit }) {
      setImmediate(() => emit("Network.loadingFinished", {
        requestId: "late-finish",
        encodedDataLength: 2_048,
      }));
    },
  }]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });

  const result = await adapter.captureRoute({
    url: pageUrl,
    viewport: { key: "desktop", width: 1_440, height: 1_200 },
  });
  await adapter.close();

  assert.equal(result.responseCollectionStatus, "complete");
  assert.equal(result.responses[0].encoded_data_length, 2_048);
  const finishIndex = fake.calls.findIndex((call) => call[0] === "emit" && call[2] === "Network.loadingFinished");
  const detachIndex = fake.calls.findIndex(([name]) => name === "detach");
  assert.ok(finishIndex >= 0 && finishIndex < detachIndex);
});

test("navigation, DOM, and CDP setup failures throw while still detaching and closing their contexts", async () => {
  const pageUrl = "https://shop.example.test/landing/";
  const fake = fakeChromium([
    { gotoError: new Error("navigation failed") },
    { evaluate: async () => { throw new Error("DOM collection failed"); } },
    {
      sendError: {
        method: "Network.setCacheDisabled",
        error: new Error("CDP setup failed"),
      },
    },
  ]);
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium });
  const viewport = { key: "desktop", width: 1_440, height: 1_200 };

  await assert.rejects(adapter.captureRoute({ url: pageUrl, viewport }), /navigation failed/);
  await assert.rejects(adapter.captureRoute({ url: pageUrl, viewport }), /DOM collection failed/);
  await assert.rejects(adapter.captureRoute({ url: pageUrl, viewport }), /CDP setup failed/);
  await adapter.close();

  assert.equal(fake.calls.filter(([name]) => name === "detach").length, 3);
  assert.equal(fake.calls.filter(([name]) => name === "context.close").length, 3);
});

test("a missing Chromium executable produces an actionable polish-capture error without the raw path", async () => {
  const chromium = {
    async launch() {
      throw new Error("Executable doesn't exist at /private/tmp/chromium?token=private");
    },
  };

  await assert.rejects(
    createPolishBrowserAdapter({ chromium }),
    (error) => {
      assert.match(error.message, /Playwright Chromium is not installed for Campaigns OS polish capture/);
      assert.match(error.message, /npm run qa:install-browser/);
      assert.match(error.message, /campaigns-os polish capture/);
      assert.equal(error.code, "POLISH_BROWSER_UNAVAILABLE");
      assert.equal(error.message.includes("/private/tmp"), false);
      assert.equal(error.message.includes("token="), false);
      return true;
    },
  );
});
