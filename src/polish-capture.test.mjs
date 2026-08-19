import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCdpResponses,
  buildPageLoadCapture,
  normalizeMediaElement,
} from "./polish-capture.mjs";

test("media normalization treats computed hidden ancestors as hidden but keeps zero-size visible media evidence-only", () => {
  const hidden = normalizeMediaElement({
    tag_name: "VIDEO",
    current_src: "https://cdn.example.test/hero.mp4?token=private#chapter",
    src: "/hero.mp4?duplicate=1",
    source_srcs: ["https://cdn.example.test/fallback.webm?signature=private"],
    preload: " AUTO ",
    computed_style: { display: "block", visibility: "visible" },
    ancestor_styles: [
      { display: "grid", visibility: "visible" },
      { display: "none", visibility: "visible" },
    ],
    bounding_box: { width: 0, height: 0 },
  }, {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
    elementIndex: 2,
  });

  assert.deepEqual(hidden, {
    tag_name: "video",
    element_index: 2,
    sources: [
      "https://cdn.example.test/fallback.webm",
      "https://cdn.example.test/hero.mp4",
      "https://shop.example.test/hero.mp4",
    ],
    preload: "auto",
    preload_defers_fetch: false,
    hidden_at_load: true,
    hidden_by: ["display_none"],
    zero_size_at_load: true,
  });

  const visibleZeroSize = normalizeMediaElement({
    tag_name: "audio",
    current_src: "",
    src: "/sound.mp3",
    source_srcs: [],
    preload: "metadata",
    computed_style: { display: "block", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: { width: 0, height: 0 },
  }, {
    documentUrl: "https://shop.example.test/landing/",
    elementIndex: 0,
  });

  assert.equal(visibleZeroSize.hidden_at_load, false);
  assert.equal(visibleZeroSize.zero_size_at_load, true);
  assert.equal(visibleZeroSize.preload_defers_fetch, true);
});

test("CDP response aggregation sums range transfers once and keeps cross-origin URLs redacted", () => {
  const responses = [
    {
      request_id: "range-2",
      url: "https://cdn.example.test/media/hero.mp4?signature=second#ignored",
      status: 206,
      resource_type: "Media",
      encoded_data_length: 524_289,
      response_encoded_data_length: 700_000,
    },
    {
      request_id: "css",
      url: "https://shop.example.test/assets/app.css?v=private",
      status: 200,
      resource_type: "Stylesheet",
      encoded_data_length: 123,
    },
    {
      request_id: "range-1",
      url: "https://cdn.example.test/media/hero.mp4?signature=first",
      status: 206,
      resource_type: "Media",
      encoded_data_length: 524_288,
    },
  ];

  const expected = {
    measurement_status: "complete",
    total_transferred_bytes: 1_048_700,
    request_count: 3,
    cross_origin_request_count: 2,
    cache_request_count: 0,
    service_worker_request_count: 0,
    resources: [
      {
        url: "https://cdn.example.test/media/hero.mp4",
        resource_type: "media",
        transferred_bytes: 1_048_577,
        request_count: 2,
        statuses: [206],
        partial_request_count: 2,
        cross_origin: true,
      },
      {
        url: "https://shop.example.test/assets/app.css",
        resource_type: "stylesheet",
        transferred_bytes: 123,
        request_count: 1,
        statuses: [200],
        partial_request_count: 0,
        cross_origin: false,
      },
    ],
    largest_resource: {
      url: "https://cdn.example.test/media/hero.mp4",
      resource_type: "media",
      transferred_bytes: 1_048_577,
      request_count: 2,
    },
    problems: [],
  };

  assert.deepEqual(aggregateCdpResponses(responses, {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
  }), expected);
  assert.deepEqual(aggregateCdpResponses([...responses].reverse(), {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
  }), expected);
  assert.equal(JSON.stringify(expected).includes("signature"), false);
});

test("cached, service-worker, failed, and unfinished CDP responses make measurement explicitly incomplete", () => {
  const result = aggregateCdpResponses([
    {
      request_id: "cached-private-id",
      url: "https://cdn.example.test/cached.mp4?token=private",
      status: 200,
      resource_type: "Media",
      encoded_data_length: 0,
      from_disk_cache: true,
    },
    {
      request_id: "worker-private-id",
      url: "https://shop.example.test/sw.mp4?session=private",
      status: 200,
      resource_type: "Media",
      encoded_data_length: 500,
      from_service_worker: true,
    },
    {
      request_id: "unfinished-private-id",
      url: "https://shop.example.test/unfinished.mp4?secret=private",
      status: 206,
      resource_type: "Media",
      failed: true,
    },
  ], { documentUrl: "https://shop.example.test/landing/" });

  assert.equal(result.measurement_status, "incomplete");
  assert.equal(result.request_count, 3);
  assert.equal(result.total_transferred_bytes, 500);
  assert.deepEqual(result.problems, [
    { code: "cache_observed", count: 1 },
    { code: "request_failed", count: 1 },
    { code: "service_worker_observed", count: 1 },
    { code: "transfer_size_unavailable", count: 1 },
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of ["private-id", "token=", "session=", "secret="]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("page-load capture joins fetched bytes to video/audio sources while networkidle timeout remains evidence-only", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/?campaign=private#hero",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/?campaign=private",
    responseCollectionStatus: "complete",
    networkidle: { status: "timeout", duration_ms: 5_000 },
    mediaElements: [
      {
        tag_name: "video",
        current_src: "https://cdn.example.test/heavy.mp4?signature=private",
        src: null,
        source_srcs: [],
        preload: null,
        computed_style: { display: "none", visibility: "visible" },
        ancestor_styles: [],
        bounding_box: { width: 0, height: 0 },
      },
      {
        tag_name: "video",
        current_src: "",
        src: "/visible-hero.mp4?token=private",
        source_srcs: [],
        preload: "",
        computed_style: { display: "block", visibility: "visible" },
        ancestor_styles: [],
        bounding_box: { width: 1200, height: 600 },
      },
      {
        tag_name: "audio",
        current_src: "",
        src: null,
        source_srcs: ["/hidden-audio.mp3?token=private"],
        preload: "metadata",
        computed_style: { display: "block", visibility: "visible" },
        ancestor_styles: [{ display: "block", visibility: "hidden" }],
        bounding_box: { width: 300, height: 40 },
      },
    ],
    responses: [
      { request_id: "heavy", url: "https://cdn.example.test/heavy.mp4?signature=private", resource_type: "Media", status: 200, encoded_data_length: 1_048_577 },
      { request_id: "hero", url: "https://shop.example.test/visible-hero.mp4?token=private", resource_type: "Media", status: 200, encoded_data_length: 5_000_000 },
      { request_id: "audio", url: "https://shop.example.test/hidden-audio.mp3?token=private", resource_type: "Media", status: 206, encoded_data_length: 2_000_000 },
    ],
  });

  assert.equal(capture.route, "/landing/");
  assert.equal(capture.measurement_status, "complete");
  assert.deepEqual(capture.networkidle, { status: "timeout", duration_ms: 5_000 });
  assert.equal(capture.metrics.total_transferred_bytes, 8_048_577);
  assert.deepEqual(capture.media.map((media) => ({
    tag_name: media.tag_name,
    element_index: media.element_index,
    source: media.sources[0],
    hidden_at_load: media.hidden_at_load,
    preload_defers_fetch: media.preload_defers_fetch,
    fetched_bytes: media.fetched_bytes,
  })), [
    { tag_name: "video", element_index: 0, source: "https://cdn.example.test/heavy.mp4", hidden_at_load: true, preload_defers_fetch: false, fetched_bytes: 1_048_577 },
    { tag_name: "video", element_index: 1, source: "https://shop.example.test/visible-hero.mp4", hidden_at_load: false, preload_defers_fetch: false, fetched_bytes: 5_000_000 },
    { tag_name: "audio", element_index: 2, source: "https://shop.example.test/hidden-audio.mp3", hidden_at_load: true, preload_defers_fetch: true, fetched_bytes: 2_000_000 },
  ]);
  assert.equal(JSON.stringify(capture).includes("private"), false);
});

test("duplicate response identities and unresolvable response URLs cannot produce complete CDP evidence", () => {
  const result = aggregateCdpResponses([
    { request_id: "duplicate", url: "https://cdn.example.test/video.mp4?one=private", resource_type: "Media", status: 206, encoded_data_length: 10 },
    { request_id: "duplicate", url: "https://cdn.example.test/video.mp4?two=private", resource_type: "Media", status: 206, encoded_data_length: 20 },
    { request_id: "", url: "data:video/mp4;base64,PRIVATE", resource_type: "Media", status: 200, encoded_data_length: 30 },
  ], { documentUrl: "https://shop.example.test/landing/" });

  assert.equal(result.measurement_status, "incomplete");
  assert.deepEqual(result.problems, [
    { code: "duplicate_request_identity", count: 1 },
    { code: "request_identity_invalid", count: 1 },
    { code: "resource_url_unresolvable", count: 1 },
  ]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("producer failure or missing media/network collections is explicit and never persists the raw error", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "failed",
    networkidle: { status: "timeout", duration_ms: 5_000 },
    producerError: new Error("private cookie=SECRET at /private/tmp/sensitive-capture"),
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.problems, [
    { code: "media_collection_unavailable", count: 1 },
    { code: "producer_failed", count: 1 },
    { code: "response_collection_failed", count: 1 },
    { code: "response_collection_unavailable", count: 1 },
  ]);
  const serialized = JSON.stringify(capture);
  for (const secret of ["SECRET", "cookie", "/private/tmp/sensitive-capture"]) assert.equal(serialized.includes(secret), false, secret);
});

test("missing computed-style or source enumeration makes media measurement incomplete instead of assuming visible", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://cdn.example.test/unknown.mp4",
      src: null,
      source_srcs: [],
      preload: null,
      computed_style: null,
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    responses: [{
      request_id: "unknown",
      url: "https://cdn.example.test/unknown.mp4",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.media, []);
  assert.deepEqual(capture.problems, [{ code: "media_measurement_failed", count: 1 }]);
});

test("cross-origin redirect aliases join the final CDP transfer back to the authored media source", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://shop.example.test/media/hero?token=private",
      src: null,
      source_srcs: [],
      preload: null,
      computed_style: { display: "none", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    responses: [{
      request_id: "redirected-media",
      url: "https://cdn.example.test/final/hero.mp4?signature=private",
      source_urls: ["https://shop.example.test/media/hero?token=private"],
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });

  assert.equal(capture.measurement_status, "complete");
  assert.equal(capture.media[0].fetched_bytes, 2_000_000);
  assert.deepEqual(capture.media[0].fetched_resources, [{
    url: "https://cdn.example.test/final/hero.mp4",
    matched_source: "https://shop.example.test/media/hero",
    transferred_bytes: 2_000_000,
    request_count: 1,
  }]);
  assert.equal(JSON.stringify(capture).includes("token="), false);
  assert.equal(JSON.stringify(capture).includes("signature="), false);
});

test("hidden eager non-network media sources fail closed while visible and deferred sources remain evidence-only", () => {
  const captureFor = ({ hidden, preload }) => buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "blob:https://shop.example.test/private-object-id",
      src: null,
      source_srcs: [],
      preload,
      computed_style: { display: hidden ? "none" : "block", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: hidden ? { width: 0, height: 0 } : { width: 1200, height: 600 },
    }],
    responses: [{
      request_id: "blob-payload",
      url: "https://cdn.example.test/private-payload.mp4?token=secret",
      resource_type: "XHR",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });

  const hiddenEager = captureFor({ hidden: true, preload: null });
  assert.equal(hiddenEager.measurement_status, "incomplete");
  assert.deepEqual(hiddenEager.problems, [{ code: "media_source_unresolvable", count: 1 }]);
  assert.equal(JSON.stringify(hiddenEager).includes("private-object-id"), false);
  assert.equal(captureFor({ hidden: false, preload: null }).measurement_status, "complete");
  assert.equal(captureFor({ hidden: true, preload: "none" }).measurement_status, "complete");
});

test("an affirmatively empty CDP collection cannot pass a route with hidden eager media", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://cdn.example.test/hidden.mp4",
      src: null,
      source_srcs: [],
      preload: null,
      computed_style: { display: "none", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    responses: [],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.problems, [{ code: "response_collection_empty", count: 1 }]);
});
