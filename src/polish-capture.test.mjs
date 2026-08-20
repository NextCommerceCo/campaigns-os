import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCdpResponses,
  buildPageLoadCapture,
  MAX_PAGE_LOAD_MEDIA_ANCESTORS,
  MAX_PAGE_LOAD_MEDIA_ELEMENTS,
  MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT,
  MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES,
  MAX_PAGE_LOAD_RESPONSE_RECORDS,
  MAX_POLISH_CAPTURE_URL_LENGTH,
  normalizeMediaElement,
} from "./polish-capture.mjs";

const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function boundCapture(overrides = {}) {
  const {
    omitDocumentResponse = false,
    responses: responseOverrides = [],
    ...captureOverrides
  } = overrides;
  const hasDocumentResponse = Array.isArray(responseOverrides)
    && responseOverrides.some((record) => String(record?.resource_type || "").toLowerCase() === "document");
  const responses = Array.isArray(responseOverrides) && !omitDocumentResponse && !hasDocumentResponse
    ? [documentResponse(), ...responseOverrides]
    : responseOverrides;
  return buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    requestedDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [],
    responses,
    ...captureOverrides,
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

function documentResponse(status = 200, overrides = {}) {
  return {
    request_id: `document-${status}`,
    url: "https://shop.example.test/landing/",
    resource_type: "Document",
    status,
    mime_type: "text/html",
    encoded_data_length: 0,
    is_final_main_document: true,
    document_context_fingerprint: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

test("final document evidence requires exactly one matching root-frame HTML 200 response", () => {
  const success = boundCapture({ responses: [documentResponse(200)] });
  assert.equal(success.measurement_status, "complete");

  for (const status of [204, 205, 206, 404, 500]) {
    const capture = boundCapture({ responses: [documentResponse(status)] });
    assert.equal(capture.measurement_status, "incomplete");
    assert.deepEqual(capture.problems, [{ code: "document_response_error", count: 1 }]);
  }

  for (const mime_type of ["application/json", "image/png"]) {
    const capture = boundCapture({ responses: [documentResponse(200, { mime_type })] });
    assert.equal(capture.measurement_status, "incomplete");
    assert.deepEqual(capture.problems, [{ code: "document_response_error", count: 1 }]);
    assert.equal(capture.document_response.mime_type, "other");
  }
  assert.equal(boundCapture({
    responses: [documentResponse(200, { mime_type: "application/xhtml+xml" })],
  }).measurement_status, "complete");

  const crossOriginFinal = boundCapture({
    finalDocumentUrl: "https://other.example.test/landing/",
    responses: [documentResponse(200, { url: "https://other.example.test/landing/" })],
  });
  assert.equal(crossOriginFinal.measurement_status, "incomplete");
  assert.deepEqual(crossOriginFinal.problems, [{ code: "document_response_error", count: 1 }]);
  assert.equal(crossOriginFinal.document_response.origin_matches_capture, false);

  const missing = boundCapture({ responses: [documentResponse(200, {
    url: "https://shop.example.test/not-the-final-document/",
  })] });
  assert.equal(missing.measurement_status, "incomplete");
  assert.equal(missing.problems.some((problem) => problem.code === "document_response_missing"), true);

  const ambiguous = boundCapture({ responses: [
    documentResponse(200, { request_id: "document-one" }),
    documentResponse(200, { request_id: "document-two" }),
  ] });
  assert.equal(ambiguous.measurement_status, "incomplete");
  assert.equal(ambiguous.problems.some((problem) => problem.code === "document_response_ambiguous"), true);

  const sameUrlIframeOnly = boundCapture({ responses: [documentResponse(200, {
    request_id: "same-url-iframe",
    is_final_main_document: false,
    document_context_fingerprint: undefined,
  })] });
  assert.equal(sameUrlIframeOnly.measurement_status, "incomplete");
  assert.equal(sameUrlIframeOnly.problems.some((problem) => problem.code === "document_response_missing"), true);

  const mainWithSameUrlIframe = boundCapture({ responses: [
    documentResponse(200, {
      request_id: "same-url-iframe",
      is_final_main_document: false,
      document_context_fingerprint: undefined,
    }),
    documentResponse(200, { request_id: "main-document" }),
  ] });
  assert.equal(mainWithSameUrlIframe.measurement_status, "complete");
  assert.equal(mainWithSameUrlIframe.document_response.status, "complete");
  assert.equal(mainWithSameUrlIframe.document_response.context_fingerprint, `sha256:${"d".repeat(64)}`);
});

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
  assert.equal(capture.resource_ledger.entries.length, 3);
  assert.notEqual(capture.resource_ledger.entries[0].resource_id, capture.resource_ledger.entries[1].resource_id);
  assert.deepEqual(capture.resource_ledger.entries.map((resource) => resource.url), [
    "https://cdn.example.test/hero.mp4",
    "https://cdn.example.test/hero.mp4",
    "https://shop.example.test/landing/",
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
  assert.equal(capture.response_collection.observed_response_count, 3);
  assert.equal(capture.metrics.request_count, 3);
  assert.equal(capture.metrics.total_transferred_bytes, 2_000_200);
  assert.equal(capture.resource_ledger.entries.length, 3);
  assert.equal(capture.media[0].fetched_bytes, 2_000_200);
  assert.equal(capture.media[0].fetched_request_count, 2);
  assert.equal(capture.media[0].fetched_resources.length, 2);
  assert.deepEqual(capture.problems, []);
});

test("same-request-id redirect hops must be contiguous from zero", () => {
  const result = aggregateCdpResponses([
    {
      request_id: "gapped-redirect",
      redirect_hop: 0,
      url: "https://shop.example.test/media/hero?token=private",
      resource_type: "Media",
      status: 302,
      encoded_data_length: 200,
    },
    {
      request_id: "gapped-redirect",
      redirect_hop: 2,
      url: "https://cdn.example.test/final/hero.mp4?signature=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    },
  ], { documentUrl: "https://shop.example.test/landing/" });

  assert.equal(result.measurement_status, "incomplete");
  assert.equal(result.observed_response_count, 2);
  assert.deepEqual(result.problems, [{ code: "redirect_chain_invalid", count: 1 }]);
});

test("a lone indexed response is a valid redirect hop only at integer index zero", () => {
  const response = {
    request_id: "lone-hop",
    url: "https://cdn.example.test/final/hero.mp4?signature=private",
    resource_type: "Media",
    status: 200,
    encoded_data_length: 2_000_000,
  };
  const valid = aggregateCdpResponses([{ ...response, redirect_hop: 0 }], {
    documentUrl: "https://shop.example.test/landing/",
  });
  assert.equal(valid.measurement_status, "complete");

  for (const redirectHop of [1, -1, "0"]) {
    const invalid = aggregateCdpResponses([{ ...response, redirect_hop: redirectHop }], {
      documentUrl: "https://shop.example.test/landing/",
    });
    assert.equal(invalid.measurement_status, "incomplete");
    assert.deepEqual(invalid.problems, [{ code: "redirect_chain_invalid", count: 1 }]);
  }
});

test("a redirect_chain with a nonobject hop fails closed with a fixed diagnostic", () => {
  const result = aggregateCdpResponses([{
    request_id: "malformed-chain",
    redirect_chain: [
      {
        url: "https://shop.example.test/media/hero?token=private",
        resource_type: "Media",
        status: 302,
        encoded_data_length: 200,
      },
      "private malformed hop payload",
    ],
  }], { documentUrl: "https://shop.example.test/landing/" });

  assert.equal(result.measurement_status, "incomplete");
  assert.deepEqual(result.problems, [{ code: "redirect_chain_invalid", count: 1 }]);
  assert.equal(JSON.stringify(result).includes("private malformed"), false);
});

test("redirect_chain hops cannot redeclare or override the top-level request identity", () => {
  for (const hopRequestId of ["redirected-media", "different-request"]) {
    const result = aggregateCdpResponses([{
      request_id: "redirected-media",
      redirect_chain: [{
        request_id: hopRequestId,
        url: "https://cdn.example.test/final/hero.mp4?signature=private",
        resource_type: "Media",
        status: 200,
        encoded_data_length: 2_000_000,
      }],
    }], { documentUrl: "https://shop.example.test/landing/" });

    assert.equal(result.measurement_status, "incomplete");
    assert.deepEqual(result.problems, [{ code: "redirect_chain_invalid", count: 1 }]);
  }
});

test("redirect_chain ownership cannot be nested or combined with a top-level redirect hop", () => {
  const finalHop = {
    url: "https://cdn.example.test/final/hero.mp4?signature=private",
    resource_type: "Media",
    status: 200,
    encoded_data_length: 2_000_000,
  };
  const ambiguousRecords = [
    {
      request_id: "top-level-hop-and-chain",
      redirect_hop: 0,
      redirect_chain: [finalHop],
    },
    {
      request_id: "nested-chain",
      redirect_chain: [{ ...finalHop, redirect_chain: [] }],
    },
  ];

  for (const record of ambiguousRecords) {
    const result = aggregateCdpResponses([record], { documentUrl: "https://shop.example.test/landing/" });
    assert.equal(result.measurement_status, "incomplete");
    assert.deepEqual(result.problems, [{ code: "redirect_chain_invalid", count: 1 }]);
  }
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

test("preflight legs and transport-API variance do not create resource-type ambiguity", () => {
  const url = "https://campaigns.example.test/api/v1/campaigns";
  const record = (requestId, resourceType, status = 200, bytes = 500) => ({
    request_id: requestId,
    url,
    resource_type: resourceType,
    status,
    encoded_data_length: bytes,
  });
  const entryFor = (capture) => capture.resource_ledger.entries
    .find((entry) => entry.url === url);

  // A CORS preflight shares the URL of the fetch it authorizes.
  const preflighted = boundCapture({
    responses: [record("preflight", "Preflight", 204, 0), record("call", "Fetch")],
  });
  assert.equal(preflighted.measurement_status, "complete");
  assert.equal(entryFor(preflighted).resource_type, "fetch");
  assert.equal(entryFor(preflighted).resource_type_status, "known");

  // fetch and xhr are one programmatic-call class.
  const transports = boundCapture({
    responses: [record("xhr-call", "Xhr"), record("fetch-call", "Fetch")],
  });
  assert.equal(transports.measurement_status, "complete");
  assert.equal(entryFor(transports).resource_type, "fetch");

  // A resource observed under a single transport keeps that transport's type.
  const xhrOnly = boundCapture({
    responses: [record("preflight", "Preflight", 204, 0), record("xhr-call", "Xhr")],
  });
  assert.equal(xhrOnly.measurement_status, "complete");
  assert.equal(entryFor(xhrOnly).resource_type, "xhr");
  assert.equal(entryFor(xhrOnly).resource_type_status, "known");

  // Mixed transports behind a preflight resolve to the merged fetch class.
  const mixed = boundCapture({
    responses: [
      record("preflight", "Preflight", 204, 0),
      record("xhr-call", "Xhr"),
      record("fetch-call", "Fetch"),
    ],
  });
  assert.equal(mixed.measurement_status, "complete");
  assert.equal(entryFor(mixed).resource_type, "fetch");

  // A URL only ever observed as a preflight keeps that identity.
  const preflightOnly = boundCapture({
    responses: [record("preflight-only", "Preflight", 204, 0)],
  });
  assert.equal(preflightOnly.measurement_status, "complete");
  assert.equal(entryFor(preflightOnly).resource_type, "preflight");
  assert.equal(entryFor(preflightOnly).resource_type_status, "known");

  // "Other" is not a preflight marker at this layer (the collector classifies
  // OPTIONS legs as Preflight at the source): a second identity stays visible.
  for (const conflicting of ["Fetch", "Media"]) {
    const conflict = boundCapture({
      responses: [record("other-leg", "Other"), record("typed-leg", conflicting)],
    });
    assert.equal(conflict.measurement_status, "incomplete", conflicting);
    assert.deepEqual(conflict.problems, [{ code: "resource_type_ambiguous", count: 1 }], conflicting);
    assert.equal(entryFor(conflict).resource_type, "unknown", conflicting);
    assert.equal(entryFor(conflict).resource_type_status, "ambiguous", conflicting);
  }

  // Canonicalization is independent of record order.
  const records = [record("preflight", "Preflight", 204, 0), record("call", "Fetch")];
  assert.deepEqual(
    aggregateCdpResponses(records, { documentUrl: "https://shop.example.test/landing/" }),
    aggregateCdpResponses([...records].reverse(), { documentUrl: "https://shop.example.test/landing/" }),
  );
});

test("the overflow sentinel makes measurement incomplete even when the collection completed", () => {
  const capture = boundCapture({
    responseCollectionStatus: "complete",
    responses: [{ capture_problem: "response_record_overflow" }],
  });

  assert.equal(capture.response_collection.status, "complete");
  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(
    capture.problems.find((problem) => problem.code === "response_record_overflow"),
    { code: "response_record_overflow", count: 1 },
  );
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
  const responses = Array.from({ length: MAX_PAGE_LOAD_RESOURCE_LEDGER_ENTRIES }, (_, index) => ({
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

test("raw CDP response normalization stops at its fixed record cap", () => {
  const responses = Array.from({ length: MAX_PAGE_LOAD_RESPONSE_RECORDS + 1 }, (_, index) => ({
    request_id: `bounded-${index}`,
    url: `https://shop.example.test/assets/${index}.js`,
    resource_type: "Script",
    status: 200,
    encoded_data_length: 1,
  }));
  const exact = aggregateCdpResponses(responses.slice(0, MAX_PAGE_LOAD_RESPONSE_RECORDS), {
    documentUrl: "https://shop.example.test/landing/",
  });
  assert.equal(exact.problems.some((problem) => problem.code === "response_record_overflow"), false);

  const over = aggregateCdpResponses(responses, { documentUrl: "https://shop.example.test/landing/" });
  assert.equal(over.observed_response_count, MAX_PAGE_LOAD_RESPONSE_RECORDS);
  assert.deepEqual(
    over.problems.find((problem) => problem.code === "response_record_overflow"),
    { code: "response_record_overflow", count: 1 },
  );
});

test("media element, source, and ancestor projections are capped with explicit incomplete evidence", () => {
  const visibleSourceLess = () => ({
    tag_name: "video",
    current_src: "",
    src_attribute: null,
    source_src_attributes: [],
    preload_attribute: null,
    computed_style: { display: "block", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: { width: 640, height: 360 },
  });
  const exact = boundCapture({
    mediaElements: Array.from({ length: MAX_PAGE_LOAD_MEDIA_ELEMENTS }, visibleSourceLess),
  });
  assert.equal(exact.measurement_status, "complete");
  assert.equal(exact.media.length, MAX_PAGE_LOAD_MEDIA_ELEMENTS);
  assert.equal(exact.media_collection.omitted_element_count, 0);

  const over = boundCapture({
    mediaElements: Array.from({ length: MAX_PAGE_LOAD_MEDIA_ELEMENTS + 1 }, visibleSourceLess),
  });
  assert.equal(over.measurement_status, "incomplete");
  assert.equal(over.media.length, MAX_PAGE_LOAD_MEDIA_ELEMENTS);
  assert.equal(over.media_collection.observed_element_count, MAX_PAGE_LOAD_MEDIA_ELEMENTS + 1);
  assert.equal(over.media_collection.omitted_element_count, 1);
  assert.deepEqual(over.problems, [{ code: "media_element_overflow", count: 1 }]);

  const variableOverflow = boundCapture({
    mediaElements: [{
      ...visibleSourceLess(),
      source_src_attributes: Array.from(
        { length: MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT + 1 },
        (_, index) => `/media/${index}.mp4`,
      ),
      ancestor_styles: Array.from(
        { length: MAX_PAGE_LOAD_MEDIA_ANCESTORS + 1 },
        () => ({ display: "block", visibility: "visible" }),
      ),
    }],
  });
  assert.equal(variableOverflow.measurement_status, "incomplete");
  assert.equal(variableOverflow.media[0].source_src_attributes.length, MAX_PAGE_LOAD_MEDIA_SOURCES_PER_ELEMENT);
  assert.deepEqual(variableOverflow.problems, [
    { code: "media_ancestor_overflow", count: 1 },
    { code: "media_source_overflow", count: 1 },
  ]);
});

test("author-controlled URL inputs have a fixed length cap and never persist oversized values", () => {
  const prefix = "https://cdn.example.test/";
  const exactUrl = `${prefix}${"a".repeat(MAX_POLISH_CAPTURE_URL_LENGTH - prefix.length)}`;
  const overUrl = `${exactUrl}private-overflow`;
  const elementFor = (url) => explicitMediaSource(url, {
    computed_style: { display: "block", visibility: "visible" },
    bounding_box: { width: 640, height: 360 },
  });

  const exact = boundCapture({ mediaElements: [elementFor(exactUrl)] });
  assert.equal(exact.measurement_status, "complete");
  assert.equal(exact.media[0].current_src.length, MAX_POLISH_CAPTURE_URL_LENGTH);

  const over = boundCapture({ mediaElements: [elementFor(overUrl)] });
  assert.equal(over.measurement_status, "incomplete");
  assert.equal(over.media[0].current_src, "[url-too-long]");
  assert.deepEqual(over.problems, [{ code: "url_length_overflow", count: 1 }]);
  assert.equal(JSON.stringify(over).includes("private-overflow"), false);

  const resource = boundCapture({ responses: [{
    request_id: "oversized-resource",
    url: overUrl,
    resource_type: "Script",
    status: 200,
    encoded_data_length: 10,
  }] });
  assert.equal(resource.measurement_status, "incomplete");
  assert.equal(resource.problems.some((problem) => problem.code === "url_length_overflow"), true);
  assert.equal(JSON.stringify(resource).includes("private-overflow"), false);
});

test("capture subject binds build, campaign, requested route, final document route, and viewport", () => {
  const capture = boundCapture({
    requestedRoute: "/landing/?campaign=private",
    finalDocumentUrl: "https://shop.example.test/redirected/?token=private",
    viewport: "MOBILE",
    responses: [documentResponse(200, {
      url: "https://shop.example.test/redirected/?token=private",
      encoded_data_length: 100,
    })],
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
    responses: [documentResponse(200, { encoded_data_length: 100 })],
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
  assert.equal(hidden.preload_attribute, "other");
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

  for (const [computed_style, ancestor_styles] of [
    [{ display: "block", visibility: "collapse" }, []],
    [{ display: "block", visibility: "visible" }, [{ display: "grid", visibility: "collapse" }]],
  ]) {
    const collapsed = normalizeMediaElement({
      tag_name: "video",
      current_src: "/collapsed.mp4",
      src_attribute: null,
      source_src_attributes: [],
      preload_attribute: "auto",
      computed_style,
      ancestor_styles,
      bounding_box: { width: 640, height: 360 },
    }, {
      documentUrl: "https://shop.example.test/landing/",
      elementIndex: 0,
    });
    assert.equal(collapsed.hidden_at_load, true);
    assert.deepEqual(collapsed.hidden_by, ["visibility_collapse"]);
  }
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
    requestedDocumentUrl: "https://shop.example.test/landing/?campaign=private",
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
      documentResponse(200, { url: "https://shop.example.test/landing/?campaign=private" }),
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
    requestedDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "failed",
    networkidle: { status: "timeout", duration_ms: 5_000 },
    producerError: new Error("private cookie=SECRET at /private/tmp/sensitive-capture"),
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.problems, [
    { code: "document_response_missing", count: 1 },
    { code: "media_collection_unavailable", count: 1 },
    { code: "producer_failed", count: 1 },
    { code: "response_collection_failed", count: 1 },
    { code: "response_collection_unavailable", count: 1 },
  ]);
  const serialized = JSON.stringify(capture);
  for (const secret of ["SECRET", "cookie", "/private/tmp/sensitive-capture"]) assert.equal(serialized.includes(secret), false, secret);

  const timedOut = buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    requestedDocumentUrl: "https://shop.example.test/landing/",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "failed",
    networkidle: { status: "invalid", duration_ms: null },
    producerProblem: "producer_timeout",
  });
  assert.equal(timedOut.producer_status, "failed");
  assert.equal(timedOut.problems.some((problem) => problem.code === "producer_timeout"), true);
  assert.equal(timedOut.problems.some((problem) => problem.code === "producer_failed"), false);
});

test("missing computed-style or source enumeration makes media measurement incomplete instead of assuming visible", () => {
  const capture = buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    requestedDocumentUrl: "https://shop.example.test/landing/",
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
      ...documentResponse(),
    }, {
      request_id: "unknown",
      url: "https://cdn.example.test/unknown.mp4",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });

  assert.equal(capture.measurement_status, "incomplete");
  assert.deepEqual(capture.media, []);
  assert.deepEqual(capture.problems, [
    { code: "media_measurement_failed", count: 1 },
    { code: "media_transfer_unattributed", count: 1 },
  ]);
});

test("cross-origin redirect aliases join the final CDP transfer back to the authored media source", () => {
  const capture = buildPageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    requestedDocumentUrl: "https://shop.example.test/landing/",
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
      ...documentResponse(),
    }, {
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
    requestedDocumentUrl: "https://shop.example.test/landing/",
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
      ...documentResponse(),
    }, {
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
    requestedDocumentUrl: "https://shop.example.test/landing/",
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
  assert.deepEqual(capture.problems, [
    { code: "document_response_missing", count: 1 },
    { code: "response_collection_empty", count: 1 },
  ]);
});

test("source-less or transient media fails closed when a positive Media transfer cannot be attributed", () => {
  const mediaElements = [{
    tag_name: "video",
    current_src: "",
    src_attribute: null,
    source_src_attributes: [],
    preload_attribute: null,
    computed_style: { display: "none", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: { width: 0, height: 0 },
  }];
  const hiddenWithoutTransfer = boundCapture({ mediaElements });
  assert.equal(hiddenWithoutTransfer.measurement_status, "complete");

  const hiddenWithTransfer = boundCapture({
    mediaElements,
    responses: [{
      request_id: "dynamic-media",
      url: "https://cdn.example.test/dynamic.mp4?token=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });
  assert.equal(hiddenWithTransfer.measurement_status, "incomplete");
  assert.deepEqual(hiddenWithTransfer.problems, [{ code: "media_transfer_unattributed", count: 1 }]);
  assert.equal(JSON.stringify(hiddenWithTransfer).includes("token="), false);

  const removedBeforeFinalSnapshot = boundCapture({
    mediaElements: [],
    responses: [{
      request_id: "transient-media",
      url: "https://cdn.example.test/transient.mp4?token=private",
      resource_type: "Media",
      status: 200,
      encoded_data_length: 2_000_000,
    }],
  });
  assert.equal(removedBeforeFinalSnapshot.measurement_status, "incomplete");
  assert.deepEqual(removedBeforeFinalSnapshot.problems, [{ code: "media_transfer_unattributed", count: 1 }]);
});
