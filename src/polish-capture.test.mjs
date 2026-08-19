import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCdpResponses,
  buildPageLoadCapture,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  normalizeMediaElement,
} from "./polish-capture.mjs";

const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function boundCapture(overrides = {}) {
  return buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [],
    responses: [],
    ...overrides,
  });
}

function explicitMediaSource(url, overrides = {}) {
  return {
    tag_name: "video",
    current_src: url,
    src_attribute: null,
    source_src_attributes: [],
    preload_attribute: null,
    computed_style: { display: "none", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: { width: 0, height: 0 },
    ...overrides,
  };
}

test("query-sensitive resource identities keep same-path media transfers attributed to the right element", () => {
  const capture = boundCapture({
    mediaElements: [
      explicitMediaSource("https://cdn.example.test/hero.mp4?variant=one&token=private-one"),
      explicitMediaSource("https://cdn.example.test/hero.mp4?variant=two&token=private-two"),
    ],
    responses: [
      {
        request_id: "variant-one",
        url: "https://cdn.example.test/hero.mp4?variant=one&token=private-one",
        resource_type: "Media",
        status: 200,
        encoded_data_length: 600 * 1_024,
      },
      {
        request_id: "variant-two",
        url: "https://cdn.example.test/hero.mp4?variant=two&token=private-two",
        resource_type: "Media",
        status: 200,
        encoded_data_length: 1_048_577,
      },
    ],
  });

  assert.equal(capture.measurement_status, "complete");
  assert.deepEqual(capture.media.map((media) => media.fetched_bytes), [600 * 1_024, 1_048_577]);
  assert.equal(capture.resource_ledger.entries.length, 2);
  assert.notEqual(capture.resource_ledger.entries[0].resource_id, capture.resource_ledger.entries[1].resource_id);
  assert.deepEqual(capture.resource_ledger.entries.map((resource) => resource.url), [
    "https://cdn.example.test/hero.mp4",
    "https://cdn.example.test/hero.mp4",
  ]);
  const serialized = JSON.stringify(capture);
  for (const secret of ["variant=", "token=", "private-one", "private-two"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES > 0, true);
});

test("media projection keeps DOM properties and content attributes explicit with finite preload values", () => {
  const normalized = normalizeMediaElement({
    tag_name: "VIDEO",
    current_src: "https://cdn.example.test/hero.mp4?selected=private",
    src_attribute: "/hero.mp4?authored=private",
    source_src_attributes: ["/fallback.webm?token=private", ""],
    preload_attribute: "merchant-private-value",
    computed_style: { display: "block", visibility: "visible" },
    ancestor_styles: [{ display: "grid", visibility: "visible" }],
    bounding_box: { width: 0, height: 0 },
  }, {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
    elementIndex: 2,
  });

  assert.equal(normalized.current_src, "https://cdn.example.test/hero.mp4");
  assert.equal(normalized.src_attribute, "https://shop.example.test/hero.mp4");
  assert.deepEqual(normalized.source_src_attributes, ["https://shop.example.test/fallback.webm", null]);
  assert.equal(normalized.preload_attribute, "other");
  assert.equal(normalized.preload_defers_fetch, false);
  assert.equal(normalized.zero_size_at_load, true);
  assert.deepEqual(normalized.source_references.map(({ source_kind, source_index }) => ({ source_kind, source_index })), [
    { source_kind: "current_src", source_index: 0 },
    { source_kind: "src_attribute", source_index: 0 },
    { source_kind: "source_src_attribute", source_index: 0 },
  ]);
  assert.equal(JSON.stringify(normalized).includes("private"), false);
});

test("same-request-id redirect hops are counted once and associate an authored source with the final response", () => {
  const redirectHops = [
    {
      url: "https://shop.example.test/media/hero?token=private",
      resource_type: "Media",
      status: 302,
      encoded_data_length: 200,
    },
    {
      url: "https://cdn.example.test/final/hero.mp4?signature=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    },
  ];
  const capture = boundCapture({
    mediaElements: [explicitMediaSource("https://shop.example.test/media/hero?token=private")],
    responses: [{
      request_id: "redirected-media",
      redirect_chain: redirectHops,
    }],
  });
  const flatCapture = boundCapture({
    mediaElements: [explicitMediaSource("https://shop.example.test/media/hero?token=private")],
    responses: [...redirectHops].reverse().map((hop, reverseIndex) => ({
      request_id: "redirected-media",
      redirect_hop: redirectHops.length - reverseIndex - 1,
      ...hop,
    })),
  });

  assert.equal(capture.measurement_status, "complete");
  assert.deepEqual(flatCapture, capture);
  assert.equal(capture.response_collection.observed_response_count, 2);
  assert.equal(capture.metrics.request_count, 2);
  assert.equal(capture.metrics.total_transferred_bytes, 2_000_200);
  assert.equal(capture.resource_ledger.entries.length, 2);
  assert.equal(capture.media[0].fetched_bytes, 2_000_200);
  assert.equal(capture.media[0].fetched_request_count, 2);
  assert.equal(capture.media[0].fetched_resources.length, 2);
  assert.deepEqual(capture.problems, []);
});

test("contradictory duplicate-hop records remain deterministic across event order", () => {
  const records = [
    {
      request_id: "duplicate-hop",
      url: "https://cdn.example.test/hero.mp4?token=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 100,
      from_memory_cache: true,
    },
    {
      request_id: "duplicate-hop",
      url: "https://cdn.example.test/hero.mp4?token=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 100,
      from_memory_cache: false,
    },
  ];
  const first = aggregateCdpResponses(records, { documentUrl: "https://shop.example.test/landing/" });
  const second = aggregateCdpResponses([...records].reverse(), { documentUrl: "https://shop.example.test/landing/" });

  assert.deepEqual(first, second);
  assert.equal(first.observed_response_count, 1);
  assert.equal(first.request_count, 1);
  assert.equal(first.problems.some(({ code }) => code === "duplicate_request_identity"), true);
});

test("resource-type ambiguity and unknown types use a finite sentinel and fail closed without corrupting capture shape", () => {
  const ambiguous = boundCapture({
    mediaElements: [explicitMediaSource("https://cdn.example.test/hero.mp4?variant=one")],
    responses: [
      {
        request_id: "media-view",
        url: "https://cdn.example.test/hero.mp4?variant=one",
        resource_type: "Media",
        status: 206,
        encoded_data_length: 600,
      },
      {
        request_id: "fetch-view",
        url: "https://cdn.example.test/hero.mp4?variant=one",
        resource_type: "Fetch",
        status: 206,
        encoded_data_length: 700,
      },
    ],
  });
  assert.equal(ambiguous.measurement_status, "incomplete");
  assert.deepEqual(ambiguous.problems, [{ code: "resource_type_ambiguous", count: 1 }]);
  assert.equal(ambiguous.resource_ledger.entries[0].resource_type, "unknown");
  assert.equal(ambiguous.resource_ledger.entries[0].resource_type_status, "ambiguous");
  assert.equal(ambiguous.media[0].fetched_bytes, 1_300);

  const unknown = boundCapture({
    responses: [{
      request_id: "unknown-type",
      url: "https://shop.example.test/asset.bin",
      resource_type: "private-arbitrary-resource-type",
      status: 200,
      encoded_data_length: 10,
    }],
  });
  assert.equal(unknown.resource_ledger.entries[0].resource_type, "unknown");
  assert.deepEqual(unknown.problems, [{ code: "resource_type_unknown", count: 1 }]);
  assert.equal(JSON.stringify(unknown).includes("private-arbitrary"), false);
});

test("generic memory-cache evidence is counted and uses the same fixed incomplete diagnostic", () => {
  const capture = boundCapture({
    responses: [{
      request_id: "memory-cache",
      url: "https://shop.example.test/cached.mp4?token=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 0,
      request_served_from_cache: true,
    }],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.equal(capture.metrics.cache_request_count, 1);
  assert.equal(capture.resource_ledger.entries[0].cache_request_count, 1);
  assert.deepEqual(capture.problems, [{ code: "cache_observed", count: 1 }]);
});

test("the persisted resource ledger is bounded and overflow is explicit", () => {
  const responses = Array.from({ length: MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES + 1 }, (_, index) => ({
    request_id: `request-${index}`,
    url: `https://shop.example.test/assets/${index}.js?token=private-${index}`,
    resource_type: "Script",
    status: 200,
    encoded_data_length: 1,
  }));
  const capture = boundCapture({ responses });

  assert.equal(capture.measurement_status, "incomplete");
  assert.equal(capture.resource_ledger.entries.length, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES);
  assert.equal(capture.resource_ledger.total_resource_count, MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES + 1);
  assert.equal(capture.resource_ledger.omitted_resource_count, 1);
  assert.equal(capture.resource_ledger.omitted_request_count, 1);
  assert.deepEqual(capture.problems, [{ code: "resource_ledger_overflow", count: 1 }]);
  assert.equal(JSON.stringify(capture).includes("token="), false);
});

test("capture subject binds build, campaign, requested route, final document route, and viewport", () => {
  const capture = boundCapture({
    requestedRoute: "/landing/?campaign=private",
    finalDocumentUrl: "https://shop.example.test/redirected/?token=private",
    viewport: "MOBILE",
    responses: [{
      request_id: "document",
      url: "https://shop.example.test/redirected/?token=private",
      resource_type: "Document",
      status: 200,
      encoded_data_length: 100,
    }],
  });

  assert.deepEqual(capture.subject, {
    build_fingerprint: BUILD_FINGERPRINT,
    campaign_slug: "merchant",
    requested_route: "/landing/",
    final_document_route: "/redirected/",
    viewport: "mobile",
  });
  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.problems, [{ code: "final_document_route_mismatch", count: 1 }]);
  assert.equal(JSON.stringify(capture).includes("campaign=private"), false);
});

test("malformed capture bindings fail closed without persisting arbitrary identity values", () => {
  const capture = boundCapture({
    buildFingerprint: "private-build-fingerprint-secret",
    slug: "private/merchant/secret",
    viewport: "desktop private session secret",
    responses: [{
      request_id: "document",
      url: "https://shop.example.test/landing/",
      resource_type: "Document",
      status: 200,
      encoded_data_length: 100,
    }],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.subject, {
    build_fingerprint: null,
    campaign_slug: null,
    requested_route: "/landing/",
    final_document_route: "/landing/",
    viewport: null,
  });
  assert.deepEqual(capture.problems, [{ code: "capture_subject_invalid", count: 1 }]);
  const serialized = JSON.stringify(capture);
  for (const secret of ["private-build", "private/merchant", "private session"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("media normalization treats computed hidden ancestors as hidden but keeps zero-size visible media evidence-only", () => {
  const hidden = normalizeMediaElement({
    tag_name: "VIDEO",
    current_src: "https://cdn.example.test/hero.mp4?token=private#chapter",
    src_attribute: "/hero.mp4?duplicate=1",
    source_src_attributes: ["https://cdn.example.test/fallback.webm?signature=private"],
    preload_attribute: " AUTO ",
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

  assert.equal(hidden.tag_name, "video");
  assert.equal(hidden.element_index, 2);
  assert.equal(hidden.current_src, "https://cdn.example.test/hero.mp4");
  assert.equal(hidden.src_attribute, "https://shop.example.test/hero.mp4");
  assert.deepEqual(hidden.source_src_attributes, ["https://cdn.example.test/fallback.webm"]);
  assert.equal(hidden.preload_attribute, "auto");
  assert.equal(hidden.preload_defers_fetch, false);
  assert.equal(hidden.hidden_at_load, true);
  assert.deepEqual(hidden.hidden_by, ["display_none"]);
  assert.equal(hidden.zero_size_at_load, true);

  const visibleZeroSize = normalizeMediaElement({
    tag_name: "audio",
    current_src: "",
    src_attribute: "/sound.mp3",
    source_src_attributes: [],
    preload_attribute: "metadata",
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
      url: "https://cdn.example.test/media/hero.mp4?signature=same#ignored",
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
      url: "https://cdn.example.test/media/hero.mp4?signature=same",
      status: 206,
      resource_type: "Media",
      encoded_data_length: 524_288,
    },
  ];

  const result = aggregateCdpResponses(responses, {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
  });
  assert.deepEqual(aggregateCdpResponses([...responses].reverse(), {
    documentUrl: "https://shop.example.test/landing/?campaign=private",
  }), result);
  assert.equal(result.measurement_status, "complete");
  assert.equal(result.total_transferred_bytes, 1_048_700);
  assert.equal(result.request_count, 3);
  assert.equal(result.cross_origin_request_count, 2);
  assert.equal(result.resources.length, 2);
  assert.equal(result.resources[0].transferred_bytes, 1_048_577);
  assert.equal(result.resources[0].request_count, 2);
  assert.equal(result.resources[0].partial_request_count, 2);
  assert.deepEqual(result.resources[0].statuses, [206]);
  assert.equal(result.largest_resource.transferred_bytes, 1_048_577);
  assert.equal(JSON.stringify(result).includes("signature"), false);
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
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/?campaign=private#hero",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/?campaign=private",
    responseCollectionStatus: "complete",
    networkidle: { status: "timeout", duration_ms: 5_000 },
    mediaElements: [
      {
        tag_name: "video",
        current_src: "https://cdn.example.test/heavy.mp4?signature=private",
        src_attribute: null,
        source_src_attributes: [],
        preload_attribute: null,
        computed_style: { display: "none", visibility: "visible" },
        ancestor_styles: [],
        bounding_box: { width: 0, height: 0 },
      },
      {
        tag_name: "video",
        current_src: "",
        src_attribute: "/visible-hero.mp4?token=private",
        source_src_attributes: [],
        preload_attribute: "",
        computed_style: { display: "block", visibility: "visible" },
        ancestor_styles: [],
        bounding_box: { width: 1200, height: 600 },
      },
      {
        tag_name: "audio",
        current_src: "",
        src_attribute: null,
        source_src_attributes: ["/hidden-audio.mp3?token=private"],
        preload_attribute: "metadata",
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

  assert.equal(capture.subject.requested_route, "/landing/");
  assert.equal(capture.measurement_status, "complete");
  assert.deepEqual(capture.networkidle, { status: "timeout", duration_ms: 5_000 });
  assert.equal(capture.metrics.total_transferred_bytes, 8_048_577);
  assert.deepEqual(capture.media.map((media) => ({
    tag_name: media.tag_name,
    element_index: media.element_index,
    source: media.current_src || media.src_attribute || media.source_src_attributes[0],
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
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
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
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://cdn.example.test/unknown.mp4",
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: null,
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
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://shop.example.test/media/hero?token=private",
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: null,
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
  assert.equal(capture.media[0].fetched_resources.length, 1);
  assert.equal(capture.media[0].fetched_resources[0].url, "https://cdn.example.test/final/hero.mp4");
  assert.equal(capture.media[0].fetched_resources[0].resource_type, "media");
  assert.equal(capture.media[0].fetched_resources[0].transferred_bytes, 2_000_000);
  assert.equal(capture.media[0].fetched_resources[0].request_count, 1);
  assert.deepEqual(
    capture.media[0].fetched_resources[0].matched_source_resource_ids,
    [capture.media[0].source_references[0].resource_id],
  );
  assert.equal(JSON.stringify(capture).includes("token="), false);
  assert.equal(JSON.stringify(capture).includes("signature="), false);
});

test("hidden eager non-network media sources fail closed while visible and deferred sources remain evidence-only", () => {
  const captureFor = ({ hidden, preload }) => buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "blob:https://shop.example.test/private-object-id",
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: preload,
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
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "https://cdn.example.test/hidden.mp4",
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: null,
      computed_style: { display: "none", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    responses: [],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.problems, [{ code: "response_collection_empty", count: 1 }]);
});
