import assert from "node:assert/strict";
import test from "node:test";

import { createPolishBrowserAdapter } from "./polish-browser.mjs";

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
          const emit = (event, payload) => {
            calls.push(["emit", contextIndex, event]);
            for (const listener of listeners.get(event) || []) listener(payload);
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
            async evaluate(callback) {
              calls.push(["evaluate", contextIndex]);
              return scenario.evaluate
                ? scenario.evaluate(callback)
                : (scenario.mediaElements || []);
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

async function executeDomEvaluator(callback, elements) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const computedStyleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: (selector) => selector === "video, audio" ? elements : [] },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element) => element.testComputedStyle,
  });
  try {
    return callback();
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
        response: { url, status: 200 },
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
      encoded_data_length: 1_234,
      source_urls: [url],
      from_disk_cache: false,
      from_prefetch_cache: false,
      from_service_worker: false,
      request_served_from_cache: false,
      failed: false,
    }],
  });
  assert.ok(Number.isInteger(result.networkidle.duration_ms));
  assert.ok(result.networkidle.duration_ms >= 0);
  assert.deepEqual(fake.calls.at(-3), ["detach", 0]);
  assert.deepEqual(fake.calls.at(-2), ["context.close", 0]);
  assert.deepEqual(fake.calls.at(-1), ["browser.close"]);
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
        encoded_data_length: 4_567,
        source_urls: [finalUrl],
        from_disk_cache: false,
        from_prefetch_cache: false,
        from_service_worker: false,
        request_served_from_cache: false,
        failed: false,
        redirect_hop: 1,
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

test("DOMContentLoaded media collection uses exact authored attributes, every ancestor style, and measured bounds", async () => {
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
  const fake = fakeChromium([{
    finalUrl: pageUrl,
    evaluate: (callback) => executeDomEvaluator(callback, [video]),
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
      assert.equal(error.message.includes("/private/tmp"), false);
      assert.equal(error.message.includes("token="), false);
      return true;
    },
  );
});
