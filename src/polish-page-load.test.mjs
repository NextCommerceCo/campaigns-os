import assert from "node:assert/strict";
import test from "node:test";

import { createCheckpointWaiver } from "./checkpoint-waiver.mjs";
import { buildPageLoadCapture } from "./polish-capture.mjs";
import {
  buildPolishPageLoadEvidence,
  evaluateHiddenEagerMediaCheckpoint,
  HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES,
} from "./polish-page-load.mjs";

const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

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
    src: null,
    source_srcs: [],
    preload,
    computed_style: { display: hidden ? "none" : "block", visibility: "visible" },
    ancestor_styles: [],
    bounding_box: hidden ? { width: 0, height: 0 } : { width: 1200, height: 600 },
  };
}

test("page-load evidence blocks only hidden eager media strictly above 1,048,576 bytes", () => {
  const capture = buildPageLoadCapture({
    route: "/landing/?campaign=private",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/?campaign=private",
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
    transferred_bytes: 1_048_577,
    threshold_bytes: 1_048_576,
    preload: null,
    hidden_by: ["display_none"],
  }]);
  const serialized = JSON.stringify(evidence);
  for (const secret of ["credential=", "campaign=private"]) assert.equal(serialized.includes(secret), false, secret);
});

test("the threshold applies to aggregate fetched bytes per media element, including split resources", () => {
  const captureFor = (bytesPerResource) => buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_000 },
    mediaElements: [{
      tag_name: "video",
      current_src: "",
      src: null,
      source_srcs: [
        "https://cdn.example.test/part-a.mp4?credential=private",
        "https://cdn.example.test/part-b.mp4?credential=private",
      ],
      preload: null,
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
    transferred_bytes: 1_228_800,
    threshold_bytes: 1_048_576,
    preload: null,
    hidden_by: ["display_none"],
  }]);
  assert.equal(evaluate(over).status, "blocked");

  const atBoundary = evidenceFor(HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES / 2);
  assert.equal(atBoundary.captures[0].media[0].fetched_bytes, HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES);
  assert.deepEqual(atBoundary.findings, []);
  assert.equal(evaluate(atBoundary).status, "pass");
});

function blockingEvidence({ bytes = 1_048_577, buildFingerprint = BUILD_FINGERPRINT } = {}) {
  const capture = buildPageLoadCapture({
    route: "/landing/",
    viewport: "desktop",
    documentUrl: "https://shop.example.test/landing/",
    responseCollectionStatus: "complete",
    networkidle: { status: "settled", duration_ms: 1_200 },
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
  const evidence = blockingEvidence({ bytes: HIDDEN_EAGER_MEDIA_THRESHOLD_BYTES });
  evidence.captures[0].networkidle = { status: "timeout", duration_ms: 5_000 };
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
    problem_codes: ["capture_shape_invalid"],
  }]);
  const gate = evaluate(evidence);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(gate.waivable, false);
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
  const captureFor = (route, viewport, path, bytes) => buildPageLoadCapture({
    route,
    viewport,
    documentUrl: `https://shop.example.test${route}`,
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
  assert.deepEqual(evidence.measurement.incomplete[0].problem_codes, ["capture_shape_invalid"]);
  const serialized = JSON.stringify(evidence);
  for (const secret of ["private-schema", "private-producer", "cookie_private"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
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
  assert.deepEqual(evidence.measurement.incomplete[0].problem_codes, ["capture_shape_invalid"]);
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
