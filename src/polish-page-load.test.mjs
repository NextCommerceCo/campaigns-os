import assert from "node:assert/strict";
import test from "node:test";

import { createCheckpointWaiver } from "./checkpoint-waiver.mjs";
import { buildPageLoadCapture, buildPolishCaptureIntegrity } from "./polish-capture.mjs";
import {
  buildPolishPageLoadEvidence,
  evaluateHiddenEagerMediaCheckpoint,
  HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
} from "./polish-page-load.mjs";

const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function pageLoadCapture(options) {
  const finalDocumentUrl = options.finalDocumentUrl;
  return buildPageLoadCapture({
    requestedDocumentUrl: options.requestedDocumentUrl || finalDocumentUrl,
    ...options,
    responses: [{
      request_id: "main-document",
      url: finalDocumentUrl,
      resource_type: "Document",
      status: 200,
      mime_type: "text/html",
      encoded_data_length: 0,
      is_final_main_document: true,
      document_context_fingerprint: `sha256:${"d".repeat(64)}`,
    }, ...(Array.isArray(options.responses) ? options.responses : [])],
  });
}

function mediaResponse(id, path, bytes) {
  return {
    request_id: id,
    url: `https://cdn.example.test/${path}?credential=private`,
    resource_type: "Media",
    status: 200,
    encoded_data_length: bytes,
  };
}

function mediaElement(path, {
  hidden = true,
  preload = null,
  tagName = "video",
} = {}) {
  return {
    tag_name: tagName,
    current_src: `https://cdn.example.test/${path}?credential=private`,
    src_attribute: null,
    source_src_attributes: [],
    preload_attribute: preload,
    computed_style: { display: hidden ? "none" : "block", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: hidden ? { width: 0, height: 0 } : { width: 1200, height: 600 },
  };
}

function evidenceForCapture(capture, {
  buildFingerprint = BUILD_FINGERPRINT,
  slug = "merchant",
  routes = ["/landing/"],
  viewports = ["desktop"],
} = {}) {
  return buildPolishPageLoadEvidence({
    buildFingerprint,
    slug,
    routeScope: "all",
    routes,
    viewports,
    captures: [capture],
  });
}

test("page-load evidence blocks only hidden eager media strictly above 1,048,576 bytes", () => {
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/?campaign=private",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/?campaign=private",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_200 },
    mediaElements: [
      mediaElement("hidden-too-large.mp4"),
      mediaElement("hidden-boundary.mp4"),
      mediaElement("hidden-none.mp4", { preload: "none" }),
      mediaElement("hidden-metadata.mp3", { preload: "metadata", tagName: "audio" }),
      mediaElement("visible-autoplay.mp4", { hidden: false }),
    ],
    responses: [
      mediaResponse("too-large", "hidden-too-large.mp4", 1_048_577),
      mediaResponse("boundary", "hidden-boundary.mp4", 1_048_576),
      mediaResponse("none", "hidden-none.mp4", 8_000_000),
      mediaResponse("metadata", "hidden-metadata.mp3", 3_000_000),
      mediaResponse("visible", "visible-autoplay.mp4", 20_000_000),
    ],
  });
  const evidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/?campaign=private"],
    viewports: ["desktop"],
    captures: [capture],
  });

  assert.equal(HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES, 1_048_576);
  assert.equal(evidence.measurement.status, "complete");
  assert.deepEqual(evidence.subject, {
    build_fingerprint: BUILD_FINGERPRINT,
    campaign_slug: "merchant",
    route_scope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
  });
  assert.deepEqual(evidence.findings, [{
    code: "polish.hidden_eager_media",
    route: "/landing/",
    viewport: "desktop",
    tag_name: "video",
    element_index: 0,
    sources: ["https://cdn.example.test/hidden-too-large.mp4"],
    source_count: 1,
    resource_ids: ["sha256:c5111468b21f458079a7b46cc808ba721e1f1c65e2e1704595eb77488d144fdb"],
    resource_id_count: 1,
    resource_identity_fingerprint: "sha256:8fe0a19a002099ded939f96496afbc65934bdae32e34cc879580e24657b40ab7",
    transferred_bytes: 1_048_577,
    declared_bytes: 0,
    assessed_bytes: 1_048_577,
    threshold_bytes: 1_048_576,
    preload_attribute: "missing",
    hidden_by: ["display_none"],
  }]);
  const serialized = JSON.stringify(evidence);
  for (const secret of ["credential=", "campaign=private"]) assert.equal(serialized.includes(secret), false, secret);
});

test("aborted-transfer lower-bound bytes still reach the hidden-eager-media threshold", () => {
  // A browser-canceled range request keeps its observed byte count as a
  // non-failed 206 record: the lower bound is real eager transfer and must
  // trip the finding when it exceeds the threshold, while an abort at
  // exactly the threshold passes the strict comparison.
  const abortedCapture = (bytes) => pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_200 },
    mediaElements: [mediaElement("hidden-aborted.mp4")],
    responses: [{
      ...mediaResponse("aborted", "hidden-aborted.mp4", bytes),
      status: 206,
    }],
  });

  const tripped = evidenceForCapture(abortedCapture(HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1));
  assert.equal(tripped.measurement.status, "complete");
  assert.equal(tripped.findings.length, 1);
  assert.equal(tripped.findings[0].code, "polish.hidden_eager_media");
  assert.equal(tripped.findings[0].transferred_bytes, HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1);

  const boundary = evidenceForCapture(abortedCapture(HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES));
  assert.equal(boundary.measurement.status, "complete");
  assert.deepEqual(boundary.findings, []);
});

test("canceled hidden media uses declared size without making capture incomplete", () => {
  const canceledCapture = ({ bytes, declaredBytes, hidden = true, preload = null }) => pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_200 },
    mediaElements: [mediaElement("declared-aborted.mp4", { hidden, preload })],
    responses: [{
      ...mediaResponse("declared-aborted", "declared-aborted.mp4", bytes),
      status: 206,
      canceled: true,
      ...(declaredBytes === undefined ? {} : { declared_data_length: declaredBytes }),
    }],
  });

  const declared = evidenceForCapture(canceledCapture({
    bytes: 300 * 1_024,
    declaredBytes: 40 * 1_024 * 1_024,
  }));
  assert.equal(declared.measurement.status, "complete");
  assert.equal(declared.findings.length, 1);
  assert.equal(declared.findings[0].transferred_bytes, 300 * 1_024);
  assert.equal(declared.findings[0].declared_bytes, 40 * 1_024 * 1_024);
  assert.equal(declared.findings[0].assessed_bytes, 40 * 1_024 * 1_024);

  const declaredOnly = evidenceForCapture(canceledCapture({
    bytes: undefined,
    declaredBytes: 40 * 1_024 * 1_024,
  }));
  assert.equal(declaredOnly.measurement.status, "complete");
  assert.equal(declaredOnly.findings[0].transferred_bytes, 0);
  assert.equal(declaredOnly.findings[0].declared_bytes, 40 * 1_024 * 1_024);

  for (const capture of [
    canceledCapture({ bytes: 300 * 1_024, declaredBytes: 40 * 1_024 * 1_024, hidden: false }),
    canceledCapture({ bytes: 300 * 1_024, declaredBytes: 40 * 1_024 * 1_024, preload: "none" }),
    canceledCapture({ bytes: 300 * 1_024, declaredBytes: 40 * 1_024 * 1_024, preload: "metadata" }),
    canceledCapture({ bytes: 300 * 1_024 }),
    canceledCapture({ bytes: 300 * 1_024, declaredBytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES }),
  ]) {
    const evidence = evidenceForCapture(capture);
    assert.equal(evidence.measurement.status, "complete");
    assert.deepEqual(evidence.findings, []);
  }

  const lowerBoundOnly = evidenceForCapture(canceledCapture({
    bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1,
  }));
  assert.equal(lowerBoundOnly.measurement.status, "complete");
  assert.equal(lowerBoundOnly.findings[0].assessed_bytes, HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1);
});

test("historical v0 captures without declared-size fields remain valid", () => {
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_200 },
    mediaElements: [mediaElement("historical.mp4")],
    responses: [mediaResponse("historical", "historical.mp4", HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1)],
  });
  for (const resource of capture.resource_ledger.entries) {
    delete resource.declared_bytes;
    delete resource.canceled_request_count;
    delete resource.declared_request_count;
  }
  for (const media of capture.media) {
    delete media.declared_bytes;
    for (const resource of media.fetched_resources) delete resource.declared_bytes;
  }
  capture.integrity = buildPolishCaptureIntegrity(capture);

  const evidence = evidenceForCapture(capture);
  assert.equal(evidence.measurement.status, "complete");
  assert.equal(evidence.findings.length, 1);
  assert.equal(evidence.findings[0].declared_bytes, 0);
  assert.equal(evidence.findings[0].assessed_bytes, HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES + 1);
});

test("preload exemptions accept only exact ASCII-case-insensitive none and metadata tokens", () => {
  const preloadAttributes = ["NoNe", "MeTaDaTa", " none ", " metadata "];
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: preloadAttributes.map((preload, index) => mediaElement(`preload-${index}.mp4`, { preload })),
    responses: preloadAttributes.map((unused, index) => mediaResponse(`preload-${index}`, `preload-${index}.mp4`, 2_000_000)),
  });
  const evidence = evidenceForCapture(capture);

  assert.deepEqual(capture.media.map((media) => media.preload_attribute), [
    "none",
    "metadata",
    "other",
    "other",
  ]);
  assert.deepEqual(capture.media.map((media) => media.preload_defers_fetch), [true, true, false, false]);
  assert.deepEqual(evidence.findings.map((finding) => finding.element_index), [2, 3]);
  assert.equal(evaluate(evidence).status, "blocked");
});

test("computed visibility collapse on a media element or ancestor blocks eager media above the threshold", () => {
  for (const [computed_style, ancestor_styles] of [
    [{ display: "block", visibility: "collapse" }, []],
    [{ display: "block", visibility: "visible" }, [{ display: "grid", visibility: "collapse" }]],
  ]) {
    const capture = pageLoadCapture({
      buildFingerprint: BUILD_FINGERPRINT,
      slug: "merchant",
      requestedRoute: "/landing/",
      viewport: "desktop",
      finalDocumentUrl: "https://shop.example.test/landing/",
      responseCollectionStatus: "complete",
      networkidle: { status: "settled", duration_ms: 1_000 },
      mediaElements: [{
        ...mediaElement("collapsed.mp4"),
        computed_style,
        ancestor_styles,
      }],
      responses: [mediaResponse("collapsed", "collapsed.mp4", 1_048_577)],
    });
    const evidence = evidenceForCapture(capture);

    assert.equal(capture.measurement_status, "complete");
    assert.deepEqual(capture.media[0].hidden_by, ["visibility_collapse"]);
    assert.deepEqual(evidence.findings.map((finding) => finding.hidden_by), [["visibility_collapse"]]);
    assert.equal(evaluate(evidence).status, "blocked");
  }
});

test("the threshold applies to aggregate fetched bytes per media element, including split resources", () => {
  const captureFor = (bytesPerResource) => pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "",
      src_attribute: null,
      source_src_attributes: [
        "https://cdn.example.test/part-a.mp4?credential=private",
        "https://cdn.example.test/part-b.mp4?credential=private",
      ],
      preload_attribute: null,
      computed_style: { display: "none", visibility: "visible" },
      ancestor_styles: [],
      bounding_box: { width: 0, height: 0 },
    }],
    responses: [
      mediaResponse("part-a", "part-a.mp4", bytesPerResource),
      mediaResponse("part-b", "part-b.mp4", bytesPerResource),
    ],
  });
  const evidenceFor = (bytesPerResource) => buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [captureFor(bytesPerResource)],
  });

  const over = evidenceFor(600 * 1_024);
  assert.deepEqual(over.findings, [{
    code: "polish.hidden_eager_media",
    route: "/landing/",
    viewport: "desktop",
    tag_name: "video",
    element_index: 0,
    sources: [
      "https://cdn.example.test/part-a.mp4",
      "https://cdn.example.test/part-b.mp4",
    ],
    source_count: 2,
    resource_ids: [
      "sha256:03fba42f92b0606a61a4016000600023b707108cbff2031b7b0e10f603f8f853",
      "sha256:75f221e9a4bc42f1bb46dbe00f1cd431b6331f7ea5ae6fccbc945be0538abb30",
    ],
    resource_id_count: 2,
    resource_identity_fingerprint: "sha256:d004056fc7098c6e67daa9155a38d2777f0796d206d237ecdfb861ab2a101463",
    transferred_bytes: 1_228_800,
    declared_bytes: 0,
    assessed_bytes: 1_228_800,
    threshold_bytes: 1_048_576,
    preload_attribute: "missing",
    hidden_by: ["display_none"],
  }]);
  assert.equal(evaluate(over).status, "blocked");

  const atBoundary = evidenceFor(HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES / 2);
  assert.equal(atBoundary.captures[0].media[0].fetched_bytes, HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES);
  assert.deepEqual(atBoundary.findings, []);
  assert.equal(evaluate(atBoundary).status, "pass");
});

test("query-distinct same-path media stay separately attributed and only the over-threshold element becomes a finding", () => {
  const urls = ["one", "two", "three"].map(
    (variant) => `https://cdn.example.test/same.mp4?variant=${variant}&token=private-${variant}`,
  );
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: urls.map((url) => ({
      ...mediaElement("unused.mp4"),
      current_src: url,
    })),
    responses: urls.map((url, index) => ({
      request_id: `variant-${index}`,
      url,
      resource_type: "Media",
      status: 200,
      encoded_data_length: index === 2 ? 1_048_577 : 600 * 1_024,
    })),
  });
  const evidence = evidenceForCapture(capture);

  assert.equal(evidence.measurement.status, "complete");
  assert.deepEqual(evidence.captures[0].media.map((media) => media.fetched_bytes), [
    600 * 1_024,
    600 * 1_024,
    1_048_577,
  ]);
  assert.equal(evidence.findings.length, 1);
  assert.equal(evidence.findings[0].element_index, 2);
  assert.deepEqual(evidence.findings[0].sources, ["https://cdn.example.test/same.mp4"]);
  assert.equal(JSON.stringify(evidence).includes("variant="), false);
});

test("resource-type ambiguity remains a structurally valid but nonwaivably incomplete capture", () => {
  const url = "https://cdn.example.test/ambiguous.mp4?token=private";
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{ ...mediaElement("unused.mp4"), current_src: url }],
    responses: [
      { request_id: "media", url, resource_type: "Media", status: 206, encoded_data_length: 600_000 },
      { request_id: "fetch", url, resource_type: "Fetch", status: 206, encoded_data_length: 600_000 },
    ],
  });
  const evidence = evidenceForCapture(capture);

  assert.equal(evidence.measurement.status, "incomplete");
  assert.deepEqual(evidence.measurement.incomplete, [{
    route: "/landing/",
    viewport: "desktop",
    problem_codes: ["resource_type_ambiguous"],
  }]);
  const gate = evaluate(evidence);
  assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(gate.waivable, false);
});

function blockingEvidence({
  bytes = 1_048_577,
  buildFingerprint = BUILD_FINGERPRINT,
  networkidle = { status: "settled", duration_ms: 1_200 },
} = {}) {
  const capture = pageLoadCapture({
    buildFingerprint,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle,
    mediaElements: [mediaElement("hidden-too-large.mp4")],
    responses: [mediaResponse("too-large", "hidden-too-large.mp4", bytes)],
  });
  return buildPolishPageLoadEvidence({
    buildFingerprint,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [capture],
  });
}

function evaluate(pageLoad, options = {}) {
  return evaluateHiddenEagerMediaCheckpoint({
    pageLoad,
    buildFingerprint: options.buildFingerprint || BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    waivers: options.waivers || [],
    now: options.now || "2026-08-20T00:00:00.000Z",
  });
}

test("a complete hidden eager-media finding blocks until an exact named-human waiver makes it visibly exceptional", () => {
  const evidence = blockingEvidence();
  const blocked = evaluate(evidence);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.code, "polish.hidden_eager_media");
  assert.equal(blocked.waivable, true);
  assert.match(blocked.state_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(blocked.state, { findings: evidence.findings });

  const waiver = createCheckpointWaiver(blocked, {
    reason: "Approved exception for this captured build",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate before production launch",
  });
  const rawWaiver = {
    ...waiver,
    private_token: "must-not-leak",
    nested: { cookie: "must-not-leak" },
    absolute_path: "/private/tmp/active-capture-secret.json",
  };
  const waived = evaluate(evidence, { waivers: [rawWaiver] });
  assert.equal(waived.status, "waived");
  assert.equal(waived.code, "polish.hidden_eager_media.waived");
  assert.equal(waived.waivable, true);
  assert.deepEqual(waived.waiver, {
    scope: blocked.scope,
    subject: blocked.subject,
    state_fingerprint: blocked.state_fingerprint,
    reason: waiver.reason,
    waived_by: waiver.waived_by,
    waived_at: waiver.waived_at,
    review_condition: waiver.review_condition,
  });
  assert.deepEqual(waived.waiver_assessment.inert_counts, {
    stale: 0,
    foreign: 0,
    malformed: 0,
    expired: 0,
  });
  const serialized = JSON.stringify(waived);
  for (const secret of ["private_token", "must-not-leak", "absolute_path", "/private/tmp/active-capture-secret"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("passing capture ignores historical waivers and networkidle timeout does not create a blocker", () => {
  const evidence = blockingEvidence({
    bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
    networkidle: { status: "timeout", duration_ms: 5_000 },
  });
  const pass = evaluate(evidence, {
    waivers: [{ scope: "polish.hidden_eager_media", private_token: "ignored-history" }],
  });
  assert.equal(pass.status, "pass");
  assert.equal(pass.code, "polish.hidden_eager_media.pass");
  assert.equal(pass.waivable, false);
  assert.deepEqual(pass.findings, []);
  assert.deepEqual(pass.waiver_assessment, {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  });
  assert.equal(JSON.stringify(pass).includes("ignored-history"), false);
});

test("changed findings and changed builds leave an earlier exact waiver inert", () => {
  const original = evaluate(blockingEvidence());
  const waiver = createCheckpointWaiver(original, {
    reason: "Approved for the original capture only",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate before launch",
  });

  const changedFinding = evaluate(blockingEvidence({ bytes: 1_048_578 }), { waivers: [waiver] });
  assert.equal(changedFinding.status, "blocked");
  assert.equal(changedFinding.waiver, null);
  assert.deepEqual(changedFinding.waiver_assessment.inert_counts, {
    stale: 1,
    foreign: 0,
    malformed: 0,
    expired: 0,
  });

  const changedBuildFingerprint = `sha256:${"b".repeat(64)}`;
  const changedBuild = evaluate(
    blockingEvidence({ buildFingerprint: changedBuildFingerprint }),
    { buildFingerprint: changedBuildFingerprint, waivers: [waiver] },
  );
  assert.equal(changedBuild.status, "blocked");
  assert.equal(changedBuild.waiver, null);
  assert.deepEqual(changedBuild.waiver_assessment.inert_counts, {
    stale: 0,
    foreign: 1,
    malformed: 0,
    expired: 0,
  });
});

test("query-only media identity changes stale an exact waiver without exposing the query", () => {
  const evidenceForVariant = (variant) => {
    const mediaUrl = `https://cdn.example.test/same-path.mp4?variant=${variant}&credential=private`;
    const capture = pageLoadCapture({
      buildFingerprint: BUILD_FINGERPRINT,
      slug: "merchant",
      requestedRoute: "/landing/",
      viewport: "desktop",
      finalDocumentUrl: "https://shop.example.test/landing/",
      responseCollectionStatus: "complete",
      networkidle: { status: "settled", duration_ms: 1_000 },
      mediaElements: [{
        ...mediaElement("same-path.mp4"),
        current_src: mediaUrl,
      }],
      responses: [{
        ...mediaResponse(`variant-${variant}`, "same-path.mp4", 2_000_000),
        url: mediaUrl,
      }],
    });
    return evidenceForCapture(capture);
  };
  const firstEvidence = evidenceForVariant("one");
  const first = evaluate(firstEvidence);
  const waiver = createCheckpointWaiver(first, {
    reason: "Approved for one exact asset identity",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate on asset changes",
  });
  const secondEvidence = evidenceForVariant("two");
  const second = evaluate(secondEvidence, { waivers: [waiver] });

  assert.equal(firstEvidence.findings[0].sources[0], secondEvidence.findings[0].sources[0]);
  assert.equal(firstEvidence.findings[0].transferred_bytes, secondEvidence.findings[0].transferred_bytes);
  assert.notDeepEqual(firstEvidence.findings[0].resource_ids, secondEvidence.findings[0].resource_ids);
  assert.notEqual(first.state_fingerprint, second.state_fingerprint);
  assert.equal(second.status, "blocked");
  assert.equal(second.waiver_assessment.inert_counts.stale, 1);
  for (const evidence of [firstEvidence, secondEvidence]) {
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes("variant="), false);
    assert.equal(serialized.includes("credential="), false);
  }
});

test("missing, malformed, stale, and incomplete capture evidence are nonwaivable blockers", () => {
  const exact = evaluate(blockingEvidence());
  const waiver = createCheckpointWaiver(exact, {
    reason: "Would cover only complete current evidence",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate before launch",
  });
  const malformed = { ...blockingEvidence(), schema_version: "unknown" };
  const stale = blockingEvidence({ buildFingerprint: `sha256:${"c".repeat(64)}` });
  const incomplete = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop", "mobile"],
    captures: blockingEvidence().captures,
  });
  const cases = [
    evaluateHiddenEagerMediaCheckpoint({
      pageLoad: null,
      buildFingerprint: BUILD_FINGERPRINT,
      slug: "merchant",
      routeScope: "all",
      routes: ["/landing/"],
      viewports: ["desktop"],
      waivers: [waiver],
    }),
    evaluate(malformed, { waivers: [waiver] }),
    evaluate(stale, { waivers: [waiver] }),
    evaluateHiddenEagerMediaCheckpoint({
      pageLoad: incomplete,
      buildFingerprint: BUILD_FINGERPRINT,
      slug: "merchant",
      routeScope: "all",
      routes: ["/landing/"],
      viewports: ["desktop", "mobile"],
      waivers: [waiver],
    }),
  ];
  assert.deepEqual(cases.map(({ code }) => code), [
    "polish.hidden_eager_media.capture_malformed",
    "polish.hidden_eager_media.capture_malformed",
    "polish.hidden_eager_media.capture_stale",
    "polish.hidden_eager_media.capture_incomplete",
  ]);
  for (const gate of cases) {
    assert.equal(gate.status, "blocked");
    assert.equal(gate.waivable, false);
    assert.equal(gate.state_fingerprint, null);
    assert.equal(gate.waiver, null);
  }
});

test("a malformed route capture cannot self-declare complete and false-pass missing media measurements", () => {
  const valid = blockingEvidence();
  const malformedCapture = structuredClone(valid.captures[0]);
  delete malformedCapture.media[0].fetched_resources;
  malformedCapture.measurement_status = "complete";
  malformedCapture.problems = [];
  const evidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [malformedCapture],
  });

  assert.equal(evidence.measurement.status, "incomplete");
  assert.deepEqual(evidence.measurement.incomplete, [{
    route: "/landing/",
    viewport: "desktop",
    problem_codes: ["capture_integrity_invalid", "capture_shape_invalid"],
  }]);
  const gate = evaluate(evidence);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(gate.waivable, false);
});

test("ledger-derived totals, largest-resource facts, cache/SW/cross-origin counts, and media attribution reject contradictions", () => {
  const base = structuredClone(blockingEvidence().captures[0]);
  const mutations = [
    (capture) => { capture.metrics.total_transferred_bytes += 1; },
    (capture) => { capture.metrics.request_count += 1; },
    (capture) => { capture.metrics.largest_resource.transferred_bytes += 1; },
    (capture) => { capture.metrics.cross_origin_request_count += 1; },
    (capture) => { capture.metrics.cache_request_count += 1; },
    (capture) => { capture.metrics.service_worker_request_count += 1; },
    (capture) => { capture.media[0].fetched_bytes -= 1; },
    (capture) => { capture.media[0].fetched_request_count += 1; },
    (capture) => { capture.media[0].fetched_resources[0].transferred_bytes -= 1; },
    (capture) => { capture.resource_ledger.entries[0].transferred_bytes -= 1; },
  ];

  for (const mutate of mutations) {
    const capture = structuredClone(base);
    mutate(capture);
    const evidence = evidenceForCapture(capture);
    assert.equal(evidence.measurement.status, "incomplete");
    assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_shape_invalid"), true);
    const gate = evaluate(evidence);
    assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
    assert.equal(gate.waivable, false);
  }
});

test("coordinated resource-ID rewriting cannot detach a hidden transfer from its original media source", () => {
  const capture = structuredClone(blockingEvidence({ bytes: 2_000_000 }).captures[0]);
  const rewrittenResourceId = `sha256:${"f".repeat(64)}`;
  capture.resource_ledger.entries[0].resource_id = rewrittenResourceId;
  capture.resource_ledger.entries[0].match_resource_ids = [rewrittenResourceId];
  capture.metrics.largest_resource.resource_id = rewrittenResourceId;
  capture.media[0].fetched_bytes = 0;
  capture.media[0].fetched_request_count = 0;
  capture.media[0].fetched_resources = [];

  const evidence = evidenceForCapture(capture);
  assert.equal(evidence.measurement.status, "incomplete");
  assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_integrity_invalid"), true);
  assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_shape_invalid"), true);
  const gate = evaluate(evidence);
  assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(gate.waivable, false);
});

test("a clean builder artifact round-trips with versioned integrity and no private URL material", () => {
  const evidence = blockingEvidence({ bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES });
  const capture = evidence.captures[0];

  assert.equal(evidence.measurement.status, "complete");
  assert.deepEqual(Object.keys(capture.integrity).sort(), [
    "algorithm",
    "association_fingerprint",
    "projection_fingerprint",
    "schema_version",
  ]);
  assert.equal(capture.integrity.schema_version, "campaigns-os-polish-route-capture-integrity/v0");
  assert.equal(capture.integrity.algorithm, "sha256");
  assert.match(capture.integrity.association_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(capture.integrity.projection_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evaluate(evidence).status, "pass");
  assert.equal(JSON.stringify(capture.integrity).includes("credential="), false);
});

test("missing or mismatched capture integrity is an explicit nonwaivable incomplete result", () => {
  const mutations = [
    (capture) => { delete capture.integrity; },
    (capture) => { capture.integrity.association_fingerprint = `sha256:${"e".repeat(64)}`; },
    (capture) => { capture.integrity.projection_fingerprint = `sha256:${"d".repeat(64)}`; },
  ];

  for (const mutate of mutations) {
    const capture = structuredClone(blockingEvidence().captures[0]);
    mutate(capture);
    const evidence = evidenceForCapture(capture);
    assert.equal(evidence.measurement.status, "incomplete");
    assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_integrity_invalid"), true);
    assert.equal(evaluate(evidence).waivable, false);
  }
});

test("single public-field, resource, and subject mutations invalidate the producer artifact binding", () => {
  const mutations = [
    (capture) => { capture.networkidle.duration_ms += 1; },
    (capture) => { capture.resource_ledger.entries[0].url = "https://cdn.example.test/rewritten.mp4"; },
    (capture) => { capture.subject.build_fingerprint = `sha256:${"b".repeat(64)}`; },
    (capture) => { capture.subject.campaign_slug = "rewritten-merchant"; },
    (capture) => { capture.subject.requested_route = "/rewritten/"; },
    (capture) => { capture.subject.final_document_route = "/rewritten/"; },
    (capture) => { capture.subject.viewport = "mobile"; },
  ];

  for (const mutate of mutations) {
    const capture = structuredClone(blockingEvidence().captures[0]);
    mutate(capture);
    const evidence = evidenceForCapture(capture);
    assert.equal(evidence.measurement.status, "incomplete");
    assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_integrity_invalid"), true);
    const gate = evaluate(evidence);
    assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
    assert.equal(gate.waivable, false);
  }
});

test("a grouped URL cannot self-declare only some same-origin-status requests as cross-origin", () => {
  const url = "https://cdn.example.test/ranged.mp4?token=private";
  const capture = pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: "/landing/",
    viewport: "desktop",
    finalDocumentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [],
    responses: [
      { request_id: "range-1", url, resource_type: "Media", status: 206, encoded_data_length: 100 },
      { request_id: "range-2", url, resource_type: "Media", status: 206, encoded_data_length: 200 },
    ],
  });
  assert.equal(capture.resource_ledger.entries[0].request_count, 2);
  assert.equal(capture.resource_ledger.entries[0].cross_origin_request_count, 2);

  capture.resource_ledger.entries[0].cross_origin_request_count = 1;
  capture.metrics.cross_origin_request_count = 1;
  const evidence = evidenceForCapture(capture);
  assert.equal(evidence.measurement.status, "incomplete");
  assert.equal(evidence.measurement.incomplete[0].problem_codes.includes("capture_shape_invalid"), true);
});

test("capture reuse across build, campaign, route, or viewport bindings is rejected", () => {
  const capture = structuredClone(blockingEvidence().captures[0]);
  const cases = [
    { buildFingerprint: `sha256:${"b".repeat(64)}` },
    { slug: "different-merchant" },
    { routes: ["/upsell/"] },
    { viewports: ["mobile"] },
  ];

  for (const options of cases) {
    const evidence = evidenceForCapture(capture, options);
    assert.equal(evidence.measurement.status, "incomplete");
    assert.equal(evidence.captures[0].problems.some(({ code }) => code === "capture_binding_mismatch"), true);
    const gate = evaluateHiddenEagerMediaCheckpoint({
      pageLoad: evidence,
      buildFingerprint: options.buildFingerprint || BUILD_FINGERPRINT,
      slug: options.slug || "merchant",
      routeScope: "all",
      routes: options.routes || ["/landing/"],
      viewports: options.viewports || ["desktop"],
    });
    assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
    assert.equal(gate.waivable, false);
  }
});

test("page-load evidence projects a fixed privacy-safe capture shape", () => {
  const capture = structuredClone(blockingEvidence().captures[0]);
  capture.private_token = "top-level-secret";
  capture.headers = { cookie: "private-cookie" };
  capture.absolute_path = "/private/tmp/raw-capture-secret.json";
  capture.metrics.debug_response = { authorization: "Bearer private" };
  capture.media[0].raw_dom = "<video data-secret='private'>";
  capture.media[0].fetched_resources[0].headers = { "set-cookie": "private" };
  const evidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [capture],
  });

  assert.equal(evidence.measurement.status, "complete");
  const serialized = JSON.stringify(evidence);
  for (const secret of [
    "private_token", "top-level-secret", "headers", "private-cookie",
    "absolute_path", "/private/tmp/raw-capture-secret", "authorization", "raw_dom", "data-secret", "set-cookie",
  ]) assert.equal(serialized.includes(secret), false, secret);
});

test("finding order and checkpoint fingerprint are stable across route, viewport, and capture input order", () => {
  const captureFor = (route, viewport, path, bytes) => pageLoadCapture({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    requestedRoute: route,
    viewport,
    finalDocumentUrl: `https://shop.example.test${route}`,
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [mediaElement(path)],
    responses: [mediaResponse(`${viewport}-${path}`, path, bytes)],
  });
  const captures = [
    captureFor("/upsell/", "mobile", "upsell.mp4", 2_000_000),
    captureFor("/landing/", "mobile", "landing.mp4", 3_000_000),
  ];
  const build = (orderedCaptures, routes) => buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "selected",
    routes,
    viewports: ["mobile"],
    captures: orderedCaptures,
  });
  const first = build(captures, ["/upsell/", "/landing/"]);
  const second = build([...captures].reverse(), ["/landing/", "/upsell/"]);
  const evaluateSelected = (pageLoad) => evaluateHiddenEagerMediaCheckpoint({
    pageLoad,
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "selected",
    routes: ["/upsell/", "/landing/"],
    viewports: ["mobile"],
  });

  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.subject, second.subject);
  assert.equal(evaluateSelected(first).state_fingerprint, evaluateSelected(second).state_fingerprint);
});

test("malformed capture identities and problem codes are reduced to fixed safe diagnostics", () => {
  const capture = structuredClone(blockingEvidence().captures[0]);
  capture.schema_version = "private-schema-secret";
  capture.performed_by = "private-producer-secret";
  capture.measurement_status = "incomplete";
  capture.problems = [{ code: "cookie_private-secret", count: 1 }];
  const evidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [capture],
  });

  assert.equal(evidence.measurement.status, "incomplete");
  assert.deepEqual(evidence.measurement.incomplete[0].problem_codes, [
    "capture_integrity_invalid",
    "capture_shape_invalid",
  ]);
  const serialized = JSON.stringify(evidence);
  for (const secret of ["private-schema", "private-producer", "cookie_private"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("malformed typed capture fields cannot flow arbitrary strings into the evidence projection", () => {
  const capture = structuredClone(blockingEvidence().captures[0]);
  capture.measurement_status = "private-measurement-secret";
  capture.response_collection.observed_response_count = "private-observed-secret";
  capture.resource_ledger.limit = "private-ledger-secret";
  capture.metrics.total_transferred_bytes = "private-total-secret";
  capture.media[0].element_index = "private-index-secret";
  capture.media[0].fetched_bytes = "private-media-secret";
  capture.problems = [{ code: "cache_observed", count: "private-count-secret" }];
  const evidence = evidenceForCapture(capture);

  assert.equal(evidence.measurement.status, "incomplete");
  assert.equal(evidence.captures[0].problems.some(({ code }) => code === "capture_shape_invalid"), true);
  const serialized = JSON.stringify(evidence);
  for (const secret of [
    "private-measurement", "private-observed", "private-ledger", "private-total", "private-index", "private-media", "private-count",
  ]) assert.equal(serialized.includes(secret), false, secret);
});

test("contradictory hidden and preload projections cannot erase a captured blocker", () => {
  const capture = structuredClone(blockingEvidence().captures[0]);
  capture.media[0].hidden_at_load = false;
  capture.media[0].preload_defers_fetch = true;
  const evidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [capture],
  });

  assert.equal(evidence.measurement.status, "incomplete");
  assert.deepEqual(evidence.measurement.incomplete[0].problem_codes, [
    "capture_integrity_invalid",
    "capture_shape_invalid",
  ]);
  assert.equal(evaluate(evidence).waivable, false);

  const missingCollectionFailure = structuredClone(blockingEvidence().captures[0]);
  missingCollectionFailure.response_collection.observed_response_count = 0;
  missingCollectionFailure.metrics.request_count = 0;
  const missingCollectionEvidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [missingCollectionFailure],
  });
  assert.equal(missingCollectionEvidence.measurement.status, "incomplete");

  const missingSourceFailure = structuredClone(blockingEvidence().captures[0]);
  missingSourceFailure.media[0].sources = ["[non-http-url]"];
  missingSourceFailure.media[0].fetched_bytes = 0;
  missingSourceFailure.media[0].fetched_request_count = 0;
  missingSourceFailure.media[0].fetched_resources = [];
  const missingSourceEvidence = buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: "merchant",
    routeScope: "all",
    routes: ["/landing/"],
    viewports: ["desktop"],
    captures: [missingSourceFailure],
  });
  assert.equal(missingSourceEvidence.measurement.status, "incomplete");
});

test("expired and malformed waiver history stays inert and publishes counts only", () => {
  const blocked = evaluate(blockingEvidence());
  const expired = createCheckpointWaiver(blocked, {
    reason: "Expired decision",
    waivedBy: "Jordan Lee",
    now: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
  });
  const malformed = {
    ...expired,
    expires_at: undefined,
    waived_by: "automation",
    private_token: "malformed-secret",
  };
  const result = evaluate(blockingEvidence(), { waivers: [expired, malformed] });

  assert.equal(result.status, "blocked");
  assert.equal(result.waiver, null);
  assert.deepEqual(result.waiver_assessment, {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 1, expired: 1 },
  });
  assert.equal(JSON.stringify(result).includes("malformed-secret"), false);
});
