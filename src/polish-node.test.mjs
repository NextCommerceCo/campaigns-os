import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPolishCaptureBindingUnchanged,
  capturePolishPageLoad,
  createPolishCaptureBinding,
  evaluateRecordedHiddenEagerMediaCheckpoint,
  mergePolishPageLoadEvidence,
  MAX_POLISH_CAPTURE_ROUTES,
  planPolishCapture,
  POLISH_CAPTURE_VIEWPORTS,
} from "./polish-node.mjs";

const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function mainDocumentResponse(url, overrides = {}) {
  return {
    request_id: "main-document",
    url,
    resource_type: "Document",
    status: 200,
    mime_type: "text/html",
    encoded_data_length: 1_024,
    is_final_main_document: true,
    document_context_fingerprint: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

function packetWithPages(pages) {
  return {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: "merchant", route_root: "/merchant/" },
    spec: { map_id: "map-test" },
    assembly: { target_repo: "." },
    source_html: { pages },
  };
}

function completedReport(overrides = {}) {
  return {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "asm_test",
    identity: { map_id: "map-test", public_route_slug: "merchant", spec_hash: `sha256:${"b".repeat(64)}` },
    inputs: { packet_path: "campaign-runtime.build.json" },
    stages: {
      assembly: { stage: "assembly", status: "completed", build_fingerprint: BUILD_FINGERPRINT },
      polish: {
        stage: "polish",
        status: "pending",
        evidence: { visual_review: { screenshots: [".campaign-runtime/polish/landing.png"] } },
      },
    },
    waivers: [],
    ...overrides,
  };
}

test("polish capture plan deterministically covers every mapped non-skipped route at both fixed viewports", () => {
  const packet = packetWithPages([
    {
      page_id: "checkout",
      path: "checkout.html",
      page_kit: { public_route: "/merchant/checkout/", spec_route: "checkout/" },
    },
    {
      page_id: "omitted-upsell",
      skip_reason: "Not part of this selected build scope.",
    },
    {
      page_id: "landing",
      path: "landing.html",
      page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
    },
  ]);

  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });

  assert.deepEqual(POLISH_CAPTURE_VIEWPORTS, [
    { key: "desktop", width: 1_440, height: 1_200 },
    { key: "mobile", width: 390, height: 844 },
  ]);
  assert.deepEqual(plan, {
    route_scope: "selected",
    routes: [
      {
        page_id: "checkout",
        requested_route: "/merchant/checkout/",
        spec_route: "/checkout/",
        url: "http://127.0.0.1:4173/merchant/checkout/",
      },
      {
        page_id: "landing",
        requested_route: "/merchant/landing/",
        spec_route: "/landing/",
        url: "http://127.0.0.1:4173/merchant/landing/",
      },
    ],
    viewports: POLISH_CAPTURE_VIEWPORTS,
  });
});

test("polish capture rejects a non-skipped page that is not actually mapped to source output", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);

  assert.throws(
    () => planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" }),
    /page "landing" is neither mapped nor explicitly skipped/i,
  );
});

test("polish capture route planning has an exact fixed matrix cap", () => {
  const pages = Array.from({ length: MAX_POLISH_CAPTURE_ROUTES }, (_, index) => ({
    page_id: `page-${index}`,
    path: `page-${index}.html`,
    page_kit: { public_route: `/merchant/page-${index}/`, spec_route: `page-${index}/` },
  }));
  const exact = planPolishCapture({
    packet: packetWithPages(pages),
    baseUrl: "https://shop.example.test",
  });
  assert.equal(exact.routes.length, MAX_POLISH_CAPTURE_ROUTES);
  assert.throws(
    () => planPolishCapture({
      packet: packetWithPages([...pages, {
        page_id: "overflow",
        path: "overflow.html",
        page_kit: { public_route: "/merchant/overflow/", spec_route: "overflow/" },
      }]),
      baseUrl: "https://shop.example.test",
    }),
    new RegExp(`at most ${MAX_POLISH_CAPTURE_ROUTES}`),
  );
});

test("polish capture orchestrates every route and viewport through the injected browser adapter", async () => {
  const packet = packetWithPages([
    {
      page_id: "landing",
      path: "landing.html",
      page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
    },
    {
      page_id: "checkout",
      path: "checkout.html",
      page_kit: { public_route: "/merchant/checkout/", spec_route: "checkout/" },
    },
  ]);
  const calls = [];
  let closed = 0;
  const createBrowserAdapter = async (options) => {
    assert.deepEqual(options, { headed: false, authCookie: null });
    return {
      async captureRoute({ url, viewport }) {
        calls.push({ url, viewport });
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 250 },
          mediaElements: [],
          responses: [mainDocumentResponse(url, {
            request_id: `${viewport.key}-${calls.length}`,
            encoded_data_length: 1_000,
          })],
        };
      },
      async close() { closed += 1; },
    };
  };

  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    createBrowserAdapter,
  });

  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:4173/merchant/checkout/", viewport: POLISH_CAPTURE_VIEWPORTS[0] },
    { url: "http://127.0.0.1:4173/merchant/checkout/", viewport: POLISH_CAPTURE_VIEWPORTS[1] },
    { url: "http://127.0.0.1:4173/merchant/landing/", viewport: POLISH_CAPTURE_VIEWPORTS[0] },
    { url: "http://127.0.0.1:4173/merchant/landing/", viewport: POLISH_CAPTURE_VIEWPORTS[1] },
  ]);
  assert.equal(closed, 1);
  assert.equal(result.page_load.measurement.status, "complete");
  assert.deepEqual(result.page_load.subject, {
    build_fingerprint: BUILD_FINGERPRINT,
    campaign_slug: "merchant",
    route_scope: "all",
    routes: ["/merchant/checkout/", "/merchant/landing/"],
    viewports: ["desktop", "mobile"],
  });
  assert.deepEqual(result.page_load.captures.map((capture) => [
    capture.subject.requested_route,
    capture.subject.viewport,
  ]), [
    ["/merchant/checkout/", "desktop"],
    ["/merchant/checkout/", "mobile"],
    ["/merchant/landing/", "desktop"],
    ["/merchant/landing/", "mobile"],
  ]);
  assert.equal(result.checkpoint.status, "pass");
});

test("injected producer-to-gate pass controls preserve the exact threshold and preload or visibility exemptions", async (t) => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const cases = [
    { name: "hidden media exactly at 1,048,576 bytes", bytes: 1_048_576, preload: "auto", hidden: true },
    { name: "hidden media with exact preload none", bytes: 2_000_000, preload: "none", hidden: true },
    { name: "hidden media with exact preload metadata", bytes: 2_000_000, preload: "metadata", hidden: true },
    { name: "visible autoplay media above threshold", bytes: 2_000_000, preload: "auto", hidden: false },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const capture = await capturePolishPageLoad({
        packet,
        report: completedReport(),
        baseUrl: "https://shop.example.test",
        createBrowserAdapter: async () => ({
          async captureRoute({ url, viewport }) {
            const mediaUrl = `${url}hero-${viewport.key}.mp4?private=producer-control`;
            return {
              finalDocumentUrl: url,
              responseCollectionStatus: "complete",
              networkidle: { status: "settled", duration_ms: 12 },
              mediaElements: [{
                tag_name: "video",
                current_src: mediaUrl,
                src_attribute: null,
                source_src_attributes: [],
                preload_attribute: scenario.preload,
                computed_style: {
                  display: scenario.hidden ? "none" : "block",
                  visibility: "visible",
                },
                ancestor_styles: [],
                bounding_box: { width: 640, height: 360 },
              }],
              responses: [
                mainDocumentResponse(url, { request_id: `document-${viewport.key}` }),
                {
                  request_id: `media-${viewport.key}`,
                  url: mediaUrl,
                  resource_type: "Media",
                  status: 200,
                  encoded_data_length: scenario.bytes,
                },
              ],
            };
          },
          async close() {},
        }),
      });

      assert.equal(capture.page_load.measurement.status, "complete");
      assert.deepEqual(capture.page_load.findings, []);
      assert.equal(capture.checkpoint.status, "pass");
    });
  }
});

test("producer-to-gate routing accepts HTML 200 and nonwaivably blocks HTTP 404 or 500", async (t) => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  for (const status of [200, 404, 500]) {
    await t.test(String(status), async () => {
      const capture = await capturePolishPageLoad({
        packet,
        report: completedReport(),
        baseUrl: "https://shop.example.test",
        createBrowserAdapter: async () => ({
          async captureRoute({ url, viewport }) {
            return {
              finalDocumentUrl: url,
              responseCollectionStatus: "complete",
              networkidle: { status: "settled", duration_ms: 12 },
              mediaElements: [],
              responses: [mainDocumentResponse(url, {
                request_id: `document-${viewport.key}`,
                status,
              })],
            };
          },
          async close() {},
        }),
      });
      assert.equal(capture.page_load.measurement.status, status === 200 ? "complete" : "incomplete");
      assert.equal(capture.checkpoint.status, status === 200 ? "pass" : "blocked");
      if (status !== 200) {
        assert.equal(capture.checkpoint.code, "polish.hidden_eager_media.capture_incomplete");
        assert.equal(capture.page_load.captures.every((cell) => cell.problems.some(
          (problem) => problem.code === "document_response_error",
        )), true);
      }
    });
  }
});

test("producer-to-gate source history retains a hidden at-load transfer after dynamic source replacement", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const captureFor = (hiddenAtLoad) => capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "https://shop.example.test",
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        const initialSource = `${url}initial-${viewport.key}.mp4?private=initial`;
        const finalSource = `${url}replacement-${viewport.key}.mp4?private=final`;
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [{
            tag_name: "video",
            current_src: finalSource,
            src_attribute: null,
            source_src_attributes: [],
            observed_source_urls: [initialSource, finalSource],
            preload_attribute: null,
            computed_style: {
              display: hiddenAtLoad ? "none" : "block",
              visibility: "visible",
            },
            ancestor_styles: [],
            bounding_box: hiddenAtLoad ? { width: 0, height: 0 } : { width: 640, height: 360 },
          }],
          responses: [
            mainDocumentResponse(url, { request_id: `document-${viewport.key}` }),
            {
              request_id: `initial-media-${viewport.key}`,
              url: initialSource,
              resource_type: "Media",
              status: 200,
              encoded_data_length: 2_000_000,
            },
          ],
        };
      },
      async close() {},
    }),
  });

  const hidden = await captureFor(true);
  assert.equal(hidden.page_load.measurement.status, "complete");
  assert.equal(hidden.checkpoint.status, "blocked");
  assert.equal(hidden.page_load.findings.length, 2);
  assert.equal(hidden.page_load.findings.every((finding) => finding.sources[0].includes("initial-")), true);

  const initiallyVisible = await captureFor(false);
  assert.equal(initiallyVisible.page_load.measurement.status, "complete");
  assert.equal(initiallyVisible.checkpoint.status, "pass");
});

test("capture binding permits unrelated report updates and page-load merge preserves the latest report", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const binding = createPolishCaptureBinding({
    packet,
    report,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  });

  const latest = structuredClone(report);
  latest.warnings = [{ code: "unrelated.concurrent.note" }];
  latest.stages.polish.evidence.visual_review.screenshots.push(".campaign-runtime/polish/mobile.png");
  const latestBinding = createPolishCaptureBinding({
    packet,
    report: latest,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  });
  assert.doesNotThrow(() => assertPolishCaptureBindingUnchanged(binding, latestBinding));

  const pageLoad = {
    schema_version: "campaigns-os-polish-page-load/v0",
    performed_by: "campaigns-os polish capture",
    measurement: { status: "complete", incomplete: [] },
  };
  const merged = mergePolishPageLoadEvidence(latest, pageLoad);
  assert.equal(latest.stages.polish.evidence.visual_review.page_load, undefined);
  assert.deepEqual(merged.warnings, latest.warnings);
  assert.deepEqual(merged.stages.polish.evidence.visual_review.screenshots, [
    ".campaign-runtime/polish/landing.png",
    ".campaign-runtime/polish/mobile.png",
  ]);
  assert.deepEqual(merged.stages.polish.evidence.visual_review.page_load, pageLoad);
  assert.equal(merged.stages.polish.status, "pending");
});

test("capture binding requires explicit resolved packet and target identities", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });

  for (const paths of [
    { packetPath: null, targetRepo: "/tmp/campaign" },
    { packetPath: "/tmp/campaign/campaign-runtime.build.json", targetRepo: null },
  ]) {
    assert.throws(
      () => createPolishCaptureBinding({ packet, report, plan, ...paths }),
      /resolved packet path and target repo/i,
    );
  }
});

test("polish capture rejects routes that collide after Page Kit trailing-slash normalization", () => {
  const packet = packetWithPages([
    {
      page_id: "landing-a",
      path: "landing-a.html",
      page_kit: { public_route: "/merchant/landing", spec_route: "landing" },
    },
    {
      page_id: "landing-b",
      path: "landing-b.html",
      page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
    },
  ]);

  assert.throws(
    () => planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" }),
    /routes are duplicated at \/merchant\/landing\//i,
  );
});

test("capture binding rejects governing report, packet, plan, and page_load changes", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport({
    design_source_package: { material_fingerprint: `sha256:${"c".repeat(64)}` },
  });
  report.stages.assembly.source_package_material_fingerprint = `sha256:${"c".repeat(64)}`;
  const baseUrl = "http://127.0.0.1:4173";
  const options = {
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  };
  const initial = createPolishCaptureBinding({
    packet,
    report,
    plan: planPolishCapture({ packet, baseUrl }),
    ...options,
  });
  const mutations = [
    ({ report: value }) => { value.run_id = "asm_changed"; },
    ({ report: value }) => { value.identity.spec_hash = `sha256:${"d".repeat(64)}`; },
    ({ report: value }) => { value.inputs.packet_path = "changed.build.json"; },
    ({ report: value }) => { value.stages.assembly.build_fingerprint = `sha256:${"e".repeat(64)}`; },
    ({ report: value }) => { value.design_source_package.material_fingerprint = `sha256:${"f".repeat(64)}`; },
    ({ report: value }) => { value.stages.polish.evidence.visual_review.page_load = { stale: true }; },
    ({ packet: value }) => { value.campaign.route_root = "/changed/"; },
    ({ packet: value }) => { value.assembly.target_repo = "changed-target"; },
    ({ plan }) => { plan.viewports[0].width = 1_441; },
  ];

  for (const mutate of mutations) {
    const nextPacket = structuredClone(packet);
    const nextReport = structuredClone(report);
    const nextPlan = structuredClone(planPolishCapture({ packet: nextPacket, baseUrl }));
    mutate({ packet: nextPacket, report: nextReport, plan: nextPlan });
    assert.throws(
      () => {
        const current = createPolishCaptureBinding({
          packet: nextPacket,
          report: nextReport,
          plan: nextPlan,
          ...options,
        });
        assertPolishCaptureBindingUnchanged(initial, current);
      },
      /attachment refused|identity to match/i,
    );
  }
});

test("a malformed existing page_load is replaceable but remains conflict-token bound", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  report.stages.polish.evidence.visual_review.page_load = "legacy malformed evidence";
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const binding = createPolishCaptureBinding({
    packet,
    report,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  });
  const pageLoad = {
    schema_version: "campaigns-os-polish-page-load/v0",
    performed_by: "campaigns-os polish capture",
  };
  assert.deepEqual(mergePolishPageLoadEvidence(report, pageLoad).stages.polish.evidence.visual_review.page_load, pageLoad);

  const changed = structuredClone(report);
  changed.stages.polish.evidence.visual_review.page_load = ["concurrent replacement"];
  const changedBinding = createPolishCaptureBinding({
    packet,
    report: changed,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  });
  assert.throws(() => assertPolishCaptureBindingUnchanged(binding, changedBinding), /attachment refused/i);
});

test("browser adapter startup failure produces complete-matrix nonwaivable incomplete evidence without leaking the error", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    createBrowserAdapter: async () => {
      throw new Error("PRIVATE_ADAPTER_SECRET at /private/tmp/browser-profile");
    },
  });

  assert.equal(result.page_load.captures.length, 2);
  assert.equal(result.page_load.measurement.status, "incomplete");
  assert.deepEqual(result.page_load.measurement.incomplete.map(({ route, viewport }) => [route, viewport]), [
    ["/merchant/landing/", "desktop"],
    ["/merchant/landing/", "mobile"],
  ]);
  assert.equal(result.checkpoint.status, "blocked");
  assert.equal(result.checkpoint.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(result.checkpoint.waivable, false);
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE_ADAPTER_SECRET", "/private/tmp/browser-profile"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("browser adapter close failure fails the matrix closed without leaking its raw error", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    createBrowserAdapter: async () => ({
      async captureRoute({ url }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [],
          responses: [],
        };
      },
      async close() {
        throw new Error("PRIVATE_CLOSE_SECRET /private/tmp/playwright-profile");
      },
    }),
  });

  assert.equal(result.page_load.measurement.status, "incomplete");
  assert.equal(result.checkpoint.status, "blocked");
  assert.equal(result.checkpoint.waivable, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_CLOSE_SECRET"), false);
  assert.equal(serialized.includes("/private/tmp/playwright-profile"), false);
});

test("capture binding accepts missing polish evidence ancestors and preserves a completed polish status on recapture", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const options = {
    packet,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  };

  for (const mutate of [
    (report) => { delete report.stages.polish.evidence; },
    (report) => { report.stages.polish.evidence = {}; },
  ]) {
    const report = completedReport();
    report.stages.polish.status = "completed";
    mutate(report);
    assert.doesNotThrow(() => createPolishCaptureBinding({ ...options, report }));

    const pageLoad = {
      schema_version: "campaigns-os-polish-page-load/v0",
      performed_by: "campaigns-os polish capture",
    };
    const merged = mergePolishPageLoadEvidence(report, pageLoad);
    assert.equal(merged.stages.polish.status, "completed");
    assert.deepEqual(merged.stages.polish.evidence.visual_review.page_load, pageLoad);
  }
});

test("capture binding verifies packet and target path identities after resolving relative paths", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const options = {
    packet,
    report,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  };

  assert.doesNotThrow(() => createPolishCaptureBinding(options));

  const wrongReportPath = structuredClone(report);
  wrongReportPath.inputs.packet_path = "other.build.json";
  assert.throws(
    () => createPolishCaptureBinding({ ...options, report: wrongReportPath }),
    /packet path identity/i,
  );

  const wrongPacketTarget = structuredClone(packet);
  wrongPacketTarget.assembly.target_repo = "../other-target";
  assert.throws(
    () => createPolishCaptureBinding({ ...options, packet: wrongPacketTarget }),
    /target repo identity/i,
  );
});

test("capture binding rejects incompatible report ancestors, unfinished assembly, and stale identity", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const options = {
    packet,
    plan,
    packetPath: "/tmp/campaign/campaign-runtime.build.json",
    targetRepo: "/tmp/campaign",
  };
  const cases = [
    {
      pattern: /plain-object stages\.polish\.evidence\.visual_review/i,
      mutate: (report) => { report.stages.polish.evidence = []; },
    },
    {
      pattern: /plain-object stages\.polish\.evidence\.visual_review/i,
      mutate: (report) => { report.stages.polish.evidence.visual_review = "legacy screenshot list"; },
    },
    {
      pattern: /completed assembly/i,
      mutate: (report) => { report.stages.assembly.status = "pending"; },
    },
    {
      pattern: /strict current Assembly Report build fingerprint/i,
      mutate: (report) => { report.stages.assembly.build_fingerprint = "latest-build"; },
    },
    {
      pattern: /matching packet and Assembly Report campaign slugs/i,
      mutate: (report) => { report.identity.public_route_slug = "other-merchant"; },
    },
  ];

  for (const scenario of cases) {
    const report = completedReport();
    scenario.mutate(report);
    assert.throws(() => createPolishCaptureBinding({ ...options, report }), scenario.pattern);
  }
});

test("recorded hidden eager-media checkpoint is N/A before assembly and fail-closed afterward", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const pending = completedReport();
  pending.stages.assembly.status = "pending";
  delete pending.stages.polish.evidence.visual_review.page_load;
  const notApplicable = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: pending });
  assert.equal(notApplicable.status, "not_applicable");
  assert.equal(notApplicable.waivable, false);

  const completed = completedReport();
  delete completed.stages.polish.evidence.visual_review.page_load;
  const missing = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: completed });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.code, "polish.hidden_eager_media.capture_malformed");
  assert.equal(missing.waivable, false);
  assert.ok(missing.required_actions.some((action) => action.id === "polish.hidden_eager_media.capture"));

  const captured = await capturePolishPageLoad({
    packet,
    report: completed,
    baseUrl: "https://shop.example.test",
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [],
          responses: [mainDocumentResponse(url, { request_id: `document-${viewport.key}` })],
        };
      },
      async close() {},
    }),
  });
  completed.stages.polish.evidence.visual_review.page_load = captured.page_load;
  const pass = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: completed });
  assert.equal(pass.status, "pass");
  assert.deepEqual(pass.required_actions, []);

  const changedPacket = structuredClone(packet);
  changedPacket.source_html.pages[0].page_kit.public_route = "/merchant/changed/";
  const stale = evaluateRecordedHiddenEagerMediaCheckpoint({ packet: changedPacket, report: completed });
  assert.equal(stale.status, "blocked");
  assert.equal(stale.code, "polish.hidden_eager_media.capture_stale");
  assert.equal(stale.waivable, false);
});

test("recorded hidden eager-media checkpoint rejects a foreign report campaign identity", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  const captured = await capturePolishPageLoad({
    packet,
    report,
    baseUrl: "https://shop.example.test",
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [],
          responses: [mainDocumentResponse(url, { request_id: `document-${viewport.key}` })],
        };
      },
      async close() {},
    }),
  });
  report.stages.polish.evidence.visual_review.page_load = captured.page_load;
  report.identity.public_route_slug = "foreign-merchant";

  const gate = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.hidden_eager_media.capture_malformed");
  assert.equal(gate.waivable, false);
  assert.deepEqual(
    gate.required_actions.map((action) => action.id),
    [
      "polish.hidden_eager_media.repair_authority",
      "polish.hidden_eager_media.capture",
    ],
  );
  assert.doesNotMatch(JSON.stringify(gate), /foreign-merchant/);
});

test("recorded hidden eager-media checkpoint gives packet repair actions for a malformed route plan", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
  }]);
  const gate = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: completedReport() });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.hidden_eager_media.capture_malformed");
  assert.equal(gate.waivable, false);
  assert.deepEqual(
    gate.required_actions.map((action) => action.id),
    [
      "polish.hidden_eager_media.repair_authority",
      "polish.hidden_eager_media.capture",
    ],
  );
  assert.match(gate.required_actions[0].description, /repair the packet or assembly report/i);
  assert.equal(gate.required_actions.some((action) => action.id.endsWith(".waive")), false);
  assert.equal(gate.required_actions.some((action) => action.id.endsWith(".repair")), false);
});
