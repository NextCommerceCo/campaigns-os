import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeBuildFingerprint } from "./built-site-scope.mjs";
import { contrastToolkit } from "./contrast.mjs";
import { createPolishBrowserAdapter } from "./polish-browser.mjs";
import { buildPolishCaptureIntegrity } from "./polish-capture.mjs";

import {
  assertPolishCaptureBindingUnchanged,
  capturePolishPageLoad,
  capturePolishReadability,
  createPolishCaptureBinding,
  evaluateRecordedHiddenEagerMediaCheckpoint,
  mergePolishCaptureEvidence,
  mergePolishPageLoadEvidence,
  MAX_POLISH_CAPTURE_ROUTES,
  planPolishCapture,
  POLISH_CAPTURE_VIEWPORTS,
} from "./polish-node.mjs";

// A built output the capture bindings can bind to: the binding refuses a
// missing route root and a recorded fingerprint the output does not match, so
// the recorded value in every fixture report is the output's real value.
const BUILT_REPO = mkdtempSync(join(tmpdir(), "campaigns-os-polish-node-"));
mkdirSync(join(BUILT_REPO, "_site", "merchant", "landing"), { recursive: true });
writeFileSync(join(BUILT_REPO, "_site", "merchant", "landing", "index.html"), "<html><body>Landing</body></html>");
const BUILT_PACKET_PATH = join(BUILT_REPO, "campaign-runtime.build.json");
const BUILD_FINGERPRINT = computeBuildFingerprint(join(BUILT_REPO, "_site", "merchant")).fingerprint;
test.after(() => rmSync(BUILT_REPO, { recursive: true, force: true }));

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

// Capture returns the plan and the page-load evidence only. The checkpoint is
// evaluated once, against the report the evidence is recorded on, the way the
// command does after it re-reads the report.
function recordedCheckpoint(packet, capture, report = completedReport()) {
  return evaluateRecordedHiddenEagerMediaCheckpoint({
    packet,
    report: mergePolishPageLoadEvidence(report, capture.page_load),
  });
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
  assert.equal(recordedCheckpoint(packet, result).status, "pass");
});

test("polish capture returns the plan and page-load evidence only; the checkpoint is evaluated on the recorded report", async () => {
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

  assert.deepEqual(Object.keys(result).sort(), ["page_load", "plan"]);
  assert.equal(Object.hasOwn(result, "checkpoint"), false);
  assert.equal(recordedCheckpoint(packet, result).status, "pass");
});

test("polish capture stamps page_load.captured_at from the merge clock, outside every capture's integrity and the checkpoint", async () => {
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
  const mergeClock = new Date(Date.UTC(2026, 9, 5, 8, 30, 15, 250));
  const merged = mergePolishCaptureEvidence(completedReport(), { pageLoad: result.page_load, now: mergeClock });
  const pageLoad = merged.stages.polish.evidence.visual_review.page_load;

  assert.equal(pageLoad.captured_at, "2026-10-05T08:30:15.250Z", "captured_at is the injected merge clock as canonical ISO");
  assert.equal(Object.hasOwn(result.page_load, "captured_at"), false, "the capture itself carries no time; the merge stamps it");
  assert.ok(pageLoad.captures.length > 0, "setup: the capture holds cells");
  for (const capture of pageLoad.captures) {
    assert.deepEqual(buildPolishCaptureIntegrity(capture), capture.integrity, `${capture.subject.requested_route} ${capture.subject.viewport}: its integrity still validates`);
  }
  const { captured_at: _stamp, ...unstamped } = pageLoad;
  const withoutStamp = structuredClone(merged);
  withoutStamp.stages.polish.evidence.visual_review.page_load = unstamped;
  const checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: merged, now: mergeClock.toISOString() });
  assert.equal(checkpoint.status, "pass", "setup: the stamped capture passes the checkpoint");
  assert.deepEqual(checkpoint, evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: withoutStamp, now: mergeClock.toISOString() }), "the checkpoint result is identical without captured_at");
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
      assert.equal(recordedCheckpoint(packet, capture).status, "pass");
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
      const checkpoint = recordedCheckpoint(packet, capture);
      assert.equal(checkpoint.status, status === 200 ? "pass" : "blocked");
      if (status !== 200) {
        assert.equal(checkpoint.code, "polish.hidden_eager_media.capture_incomplete");
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
  assert.equal(recordedCheckpoint(packet, hidden).status, "blocked");
  assert.equal(hidden.page_load.findings.length, 2);
  assert.equal(hidden.page_load.findings.every((finding) => finding.sources[0].includes("initial-")), true);

  const initiallyVisible = await captureFor(false);
  assert.equal(initiallyVisible.page_load.measurement.status, "complete");
  assert.equal(recordedCheckpoint(packet, initiallyVisible).status, "pass");
});

test("capture binding refuses a built output that drifted from the recorded fingerprint and pins the output during the browser pass", () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const report = completedReport();
  const plan = planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" });
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-polish-binding-"));
  try {
    const outputRoot = join(dir, "_site", "merchant", "landing");
    mkdirSync(outputRoot, { recursive: true });
    // A different output from the shared fixture's, so the shared recorded
    // value is a stale record here.
    writeFileSync(join(outputRoot, "index.html"), "<html><body>Landing (rebuilt)</body></html>");
    const paths = { packetPath: join(dir, "campaign-runtime.build.json"), targetRepo: dir };

    // No built route root at all: refused by name, never bound as a null.
    assert.throws(
      () => createPolishCaptureBinding({ packet, report, plan, packetPath: paths.packetPath, targetRepo: join(dir, "unbuilt") }),
      /built output root _site\/merchant\/ is missing under the target repo/,
    );

    // Recorded string differs from the output on disk: refused by name.
    assert.throws(
      () => createPolishCaptureBinding({ packet, report, plan, ...paths }),
      /built output under _site\/merchant\/ no longer matches stages\.assembly\.build_fingerprint/,
    );

    // Recorded the way build records it: bound, and the binding carries the
    // output value so a rebuild mid-capture fails the unchanged assertion.
    const current = computeBuildFingerprint(join(dir, "_site", "merchant")).fingerprint;
    const bound = structuredClone(report);
    bound.stages.assembly.build_fingerprint = current;
    const initial = createPolishCaptureBinding({ packet, report: bound, plan, ...paths });
    assert.equal(initial.report.assembly.output_fingerprint, current);

    writeFileSync(join(outputRoot, "index.html"), "<html><body>Landing v2</body></html>");
    assert.throws(
      () => createPolishCaptureBinding({ packet, report: bound, plan, ...paths }),
      /no longer matches/,
    );

    // An output the walk cannot read is a named refusal, not an uncaught
    // filesystem error.
    if (process.getuid?.() !== 0) {
      chmodSync(join(outputRoot, "index.html"), 0o000);
      try {
        assert.throws(
          () => createPolishCaptureBinding({ packet, report: bound, plan, ...paths }),
          /could not be read to fingerprint it \(EACCES/,
        );
      } finally {
        chmodSync(join(outputRoot, "index.html"), 0o644);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
  });

  const latest = structuredClone(report);
  latest.warnings = [{ code: "unrelated.concurrent.note" }];
  latest.stages.polish.evidence.visual_review.screenshots.push(".campaign-runtime/polish/mobile.png");
  const latestBinding = createPolishCaptureBinding({
    packet,
    report: latest,
    plan,
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
    { packetPath: null, targetRepo: BUILT_REPO },
    { packetPath: BUILT_PACKET_PATH, targetRepo: null },
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
      /attachment refused|identity to match|no longer matches stages\.assembly\.build_fingerprint/i,
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
  const checkpoint = recordedCheckpoint(packet, result);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.code, "polish.hidden_eager_media.capture_incomplete");
  assert.equal(checkpoint.waivable, false);
  const serialized = JSON.stringify({ ...result, checkpoint });
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
  const checkpoint = recordedCheckpoint(packet, result);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.waivable, false);
  const serialized = JSON.stringify({ ...result, checkpoint });
  assert.equal(serialized.includes("PRIVATE_CLOSE_SECRET"), false);
  assert.equal(serialized.includes("/private/tmp/playwright-profile"), false);
});

test("a bounded per-cell producer timeout retires the adapter and safely completes the matrix", {
  timeout: 500,
}, async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  let calls = 0;
  let closed = 0;
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    captureCellDeadlineMs: 20,
    adapterCloseDeadlineMs: 20,
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        throw new Error(`PRIVATE_OVERLAP_${viewport.key}`);
      },
      async close() { closed += 1; },
    }),
  });

  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(result.page_load.measurement.status, "incomplete");
  assert.deepEqual(result.page_load.measurement.incomplete, ["desktop", "mobile"].map((viewport) => ({
    route: "/merchant/landing/",
    viewport,
    problem_codes: [
      "document_response_missing",
      "media_collection_unavailable",
      "networkidle_measurement_invalid",
      "producer_timeout",
      "response_collection_failed",
      "response_collection_unavailable",
    ],
  })));
  const checkpoint = recordedCheckpoint(packet, result);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.waivable, false);
  assert.equal(JSON.stringify({ ...result, checkpoint }).includes("POLISH_PRODUCER_TIMEOUT"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_OVERLAP"), false);
});

test("a signal-honoring timed-out adapter still projects the fixed timeout instead of its raw abort error", {
  timeout: 500,
}, async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  let calls = 0;
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    captureCellDeadlineMs: 20,
    adapterCloseDeadlineMs: 20,
    createBrowserAdapter: async () => ({
      async captureRoute({ signal }) {
        calls += 1;
        return new Promise((unusedResolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("PRIVATE_ABORT_ERROR /private/tmp/browser-profile"));
          }, { once: true });
        });
      },
      async close() {
        throw new Error("PRIVATE_CLOSE_AFTER_TIMEOUT /private/tmp/browser-profile");
      },
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.page_load.captures.every((capture) => capture.problems.some(
    (problem) => problem.code === "producer_timeout",
  )), true);
  assert.equal(result.page_load.captures.some((capture) => capture.problems.some(
    (problem) => problem.code === "producer_failed",
  )), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ABORT_ERROR|PRIVATE_CLOSE_AFTER_TIMEOUT|private\/tmp/);
});

test("a fixed producer cleanup failure retires the adapter and synthesizes remaining cells", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  let calls = 0;
  let closes = 0;
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    createBrowserAdapter: async () => ({
      async captureRoute() {
        calls += 1;
        if (calls > 1) throw new Error("PRIVATE_OVERLAPPING_CONTEXT");
        const error = new Error("Campaigns OS polish capture could not clean up its producer resources.");
        error.code = "POLISH_PRODUCER_CLEANUP_FAILED";
        throw error;
      },
      async close() { closes += 1; },
    }),
  });

  assert.equal(calls, 1);
  assert.equal(closes, 1);
  assert.equal(result.page_load.captures.every((capture) => capture.problems.some(
    (problem) => problem.code === "producer_failed",
  )), true);
  assert.equal(result.page_load.captures.some((capture) => capture.problems.some(
    (problem) => problem.code === "producer_timeout",
  )), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OVERLAPPING_CONTEXT/);
});

test("a never-resolving adapter close is bounded and projects producer_timeout without raw data", {
  timeout: 500,
}, async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    captureCellDeadlineMs: 20,
    adapterCloseDeadlineMs: 20,
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 1 },
          mediaElements: [],
          responses: [mainDocumentResponse(url, { request_id: `document-${viewport.key}` })],
        };
      },
      async close() { return new Promise(() => {}); },
    }),
  });

  assert.equal(result.page_load.measurement.status, "incomplete");
  assert.equal(result.page_load.captures.every((capture) => capture.problems.some(
    (problem) => problem.code === "producer_timeout",
  )), true);
  assert.equal(result.page_load.captures.some((capture) => capture.problems.some(
    (problem) => problem.code === "producer_failed",
  )), false);
  const checkpoint = recordedCheckpoint(packet, result);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.waivable, false);
  assert.equal(JSON.stringify({ ...result, checkpoint }).includes("POLISH_PRODUCER_TIMEOUT"), false);
});

test("a never-resolving adapter startup yields full-matrix timeout evidence and closes a late adapter", {
  timeout: 500,
}, async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  let resolveFactory;
  let captures = 0;
  let closes = 0;
  const factoryPromise = new Promise((resolve) => { resolveFactory = resolve; });
  const result = await capturePolishPageLoad({
    packet,
    report: completedReport(),
    baseUrl: "http://127.0.0.1:4173",
    adapterStartupDeadlineMs: 20,
    adapterCloseDeadlineMs: 20,
    createBrowserAdapter: async () => factoryPromise,
  });

  assert.equal(result.page_load.captures.length, 2);
  assert.equal(result.page_load.captures.every((capture) => capture.problems.some(
    (problem) => problem.code === "producer_timeout",
  )), true);
  const checkpoint = recordedCheckpoint(packet, result);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.waivable, false);
  resolveFactory({
    async captureRoute() {
      captures += 1;
      throw new Error("PRIVATE_LATE_CAPTURE");
    },
    async close() { closes += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captures, 0);
  assert.equal(closes, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_LATE_CAPTURE"), false);
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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
    packetPath: BUILT_PACKET_PATH,
    targetRepo: BUILT_REPO,
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

// ---------------------------------------------------------------------------
// Readability deadlines in the browser adapter: every browser call of the
// readability path is a step of a readability bound, so a stalled call ends
// as a recorded cell status and never reaches the adapter cell deadline.

// A virtual clock: now() is virtual milliseconds; sleep(ms) settles when the
// virtual time reaches its deadline (advance moves it).
function virtualClock() {
  let now = 0;
  const sleepers = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise((done) => sleepers.push({ at: now + ms, done })),
    advance(ms) {
      now += ms;
      for (const sleeper of sleepers.filter((entry) => entry.at <= now)) {
        sleepers.splice(sleepers.indexOf(sleeper), 1);
        sleeper.done();
      }
    },
  };
}

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LOW_CONTRAST = contrastToolkit().deriveElementMeasurement({ fg_raw: "rgb(255, 255, 255)", fill_raw: "rgb(255, 255, 255)", bg_layers_raw: ["rgb(148, 148, 148)"], font_size_px: 16, font_weight: 400 });
// The probe's read of a page with one low-contrast paragraph in the viewport,
// so one crop is due.
const WARNING_READ = {
  status: "measured",
  capped: false,
  coverage_gaps: [],
  viewport: { width: 1_440, height: 1_200 },
  elements: [{
    role: "body_text", selector_path: "html>body>p:nth-of-type(1)", state: "default", disabled: false, rendered: true,
    font_size_px: 16, font_weight: 400, size_class: LOW_CONTRAST.size_class,
    fg_raw: "rgb(255, 255, 255)", fill_raw: "rgb(255, 255, 255)", bg_layers_raw: ["rgb(148, 148, 148)"],
    fg_srgb: LOW_CONTRAST.fg_srgb, bg_srgb: LOW_CONTRAST.bg_srgb, gamut_clipped: LOW_CONTRAST.gamut_clipped,
    ratio: LOW_CONTRAST.ratio, required: LOW_CONTRAST.required, review_reason: null, crop_ref: null, crop_reason: null,
    rect: { x: 0, y: 0, width: 200, height: 40 },
  }],
};
const DESKTOP = { key: "desktop", width: 1_440, height: 1_200 };
const LANDING_URL = "http://127.0.0.1:4173/merchant/landing/";

// A Chromium stand-in for the real adapter's `chromium` seam. Navigation
// answers at once with no network events, the image probe reads no images and
// the readability probe reads WARNING_READ. `hold({ method, afterCrop })` may
// return a promise a CDP command waits on first (`afterCrop`: a screenshot was
// already taken in that context); `holdContext()` the same for newContext.
function readabilityChromium({ hold = () => null, holdContext = () => null } = {}) {
  const calls = [];
  let contexts = 0;
  const chromium = {
    async launch() {
      return {
        async newContext() {
          const index = contexts;
          contexts += 1;
          calls.push(["newContext", index]);
          await holdContext();
          let afterCrop = false;
          const session = {
            on() {},
            async send(method, params) {
              calls.push(["send", index, method]);
              await hold({ method, afterCrop });
              if (method === "Page.captureScreenshot") {
                afterCrop = true;
                return { data: PNG_1PX };
              }
              if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame", loaderId: "main-loader" } } };
              if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
              if (method === "DOM.getDocument") return { root: { nodeName: "#document", children: [] } };
              if (method === "Runtime.callFunctionOn") {
                return { result: { value: params.functionDeclaration.includes("readabilityProbe") ? structuredClone(WARNING_READ) : { observed_count: 0, images: [], dpr: 1 } } };
              }
              return {};
            },
            async detach() {},
          };
          const page = {
            async goto() { return { status: () => 200 }; },
            async evaluate() { return { observed_element_count: 0, elements: [] }; },
            async waitForLoadState() {},
            url: () => LANDING_URL,
          };
          return {
            async addCookies() {},
            async newPage() { return page; },
            async newCDPSession() { return session; },
            async close() { calls.push(["context.close", index]); },
          };
        },
        async close() { calls.push(["browser.close"]); },
      };
    },
  };
  return { chromium, calls };
}

const readabilityOptions = (clock, overrides = {}) => ({
  ...(clock ? { clock } : {}),
  cellBoundMs: 1_500,
  probeRemainingMs: 120_000,
  cropRemainingMs: 30_000,
  addedRemainingMs: 300_000,
  elementCap: 2_000,
  cropsPerCell: 40,
  ...overrides,
});
const never = () => new Promise(() => {});
const sent = (calls, method) => calls.filter((call) => call[0] === "send" && call[2] === method).length;

test("a shared cell's crop re-read is a crop step: stalled past the crop bound, it ends there, is charged to crop_ms, and its crop reads crop_unavailable", async () => {
  const clock = virtualClock();
  const fake = readabilityChromium({
    hold: ({ method, afterCrop }) => {
      if (method !== "Page.getFrameTree" || !afterCrop) return null;
      clock.advance(25);
      return never();
    },
  });
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium, cellDeadlineMs: 2_000 });
  try {
    const observation = await adapter.captureRoute({ url: LANDING_URL, viewport: DESKTOP, readabilityProbe: readabilityOptions(clock, { cropRemainingMs: 20, addedRemainingMs: 40 }) });
    assert.equal(sent(fake.calls, "Page.captureScreenshot"), 1, "setup: the due crop was taken");
    const { readability } = observation;
    assert.equal(readability.status, "measured", "the measurement stands");
    assert.deepEqual(readability.crops, [], "no crop the re-read could not confirm is kept");
    assert.equal(readability.elements[0].crop_reason, "crop_unavailable");
    assert.equal(readability.crop_ms, 25, "the re-read's time is charged to crop_ms");
  } finally {
    await adapter.close();
  }
});

test("a shared cell's crops stop at the cell deadline's headroom: the page_load cell returns, never POLISH_PRODUCER_TIMEOUT, and the adapter stays usable", async () => {
  const fake = readabilityChromium({ hold: ({ method }) => (method === "Page.captureScreenshot" ? never() : null) });
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium, cellDeadlineMs: 1_500 });
  try {
    const observation = await adapter.captureRoute({ url: LANDING_URL, viewport: DESKTOP, readabilityProbe: readabilityOptions(null) });
    assert.equal(observation.finalDocumentUrl, LANDING_URL, "the page_load observation is returned");
    assert.equal(observation.readability.status, "measured");
    assert.equal(observation.readability.elements[0].crop_reason, "crop_unavailable", "the stalled crop is unavailable");
    assert.ok(observation.readability.crop_ms < 1_500, `crop time stays inside the cell (${observation.readability.crop_ms} ms)`);
    const next = await adapter.captureRoute({ url: LANDING_URL, viewport: DESKTOP });
    assert.equal(next.finalDocumentUrl, LANDING_URL, "the next cell runs: the adapter is not poisoned");
  } finally {
    await adapter.close();
  }
});

test("a readability-only cell's document re-read stalled past the added budget reads run_budget_exhausted and closes its context", async () => {
  const clock = virtualClock();
  const fake = readabilityChromium({
    hold: ({ method }) => {
      if (method !== "Page.getFrameTree") return null;
      clock.advance(50);
      return never();
    },
  });
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium, cellDeadlineMs: 2_000 });
  try {
    const observation = await adapter.probeReadabilityRoute({ route: "/merchant/stock/", url: "http://127.0.0.1:4173/merchant/stock/" }, DESKTOP, { probe: readabilityOptions(clock, { addedRemainingMs: 40 }) });
    assert.equal(observation.status, "run_budget_exhausted");
    assert.ok(fake.calls.some((call) => call[0] === "context.close" && call[1] === 0), "the cell's context is closed");
  } finally {
    await adapter.close();
  }
});

test("a readability-only cell whose context creation outlasts the added budget reads run_budget_exhausted, and the late context is closed", async () => {
  const clock = virtualClock();
  const fake = readabilityChromium({
    holdContext: () => {
      clock.advance(50);
      return new Promise((resolve) => setTimeout(resolve, 300));
    },
  });
  const adapter = await createPolishBrowserAdapter({ chromium: fake.chromium, cellDeadlineMs: 200 });
  try {
    const observation = await adapter.probeReadabilityRoute({ route: "/merchant/stock/", url: "http://127.0.0.1:4173/merchant/stock/" }, DESKTOP, { probe: readabilityOptions(clock, { addedRemainingMs: 40 }) });
    assert.equal(observation.status, "run_budget_exhausted");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(fake.calls.some((call) => call[0] === "context.close" && call[1] === 0), "the context created after the bound ended is closed");
    assert.equal(sent(fake.calls, "Page.getFrameTree"), 0, "no CDP command follows the ended bound");
  } finally {
    await adapter.close();
  }
});

test("polish capture: a stalled crop re-read in a shared cell leaves page_load as a capture without readability, and the readability cells are recorded", async () => {
  const packet = packetWithPages([{
    page_id: "landing",
    path: "landing.html",
    page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
  }]);
  const run = async ({ targetRepo }) => {
    const clock = virtualClock();
    const fake = readabilityChromium({
      hold: ({ method, afterCrop }) => {
        if (method !== "Page.getFrameTree" || !afterCrop) return null;
        clock.advance(25);
        return never();
      },
    });
    return capturePolishPageLoad({
      packet,
      report: completedReport(),
      baseUrl: "http://127.0.0.1:4173",
      targetRepo,
      probeClock: clock,
      createBrowserAdapter: () => createPolishBrowserAdapter({ chromium: fake.chromium, cellDeadlineMs: 2_000 }),
    });
  };
  const problems = (pageLoad) => pageLoad.captures.map((capture) => [capture.subject.viewport, (capture.problems || []).map((problem) => problem.code).sort()]);
  const withReadability = await run({ targetRepo: BUILT_REPO });
  const without = await run({ targetRepo: null });
  assert.equal(without.readability, undefined, "setup: the comparison run measures no readability");
  assert.deepEqual(problems(withReadability.page_load), problems(without.page_load), "page_load reads the same with the stalled readability work");
  assert.ok(!problems(withReadability.page_load).some(([, codes]) => codes.includes("producer_timeout")), "no page_load cell reads producer_timeout");
  assert.deepEqual(withReadability.readability.cells.map((cell) => [cell.viewport, cell.cell_status, cell.elements.map((element) => element.crop_reason)]), [["desktop", "measured", ["crop_unavailable"]], ["mobile", "measured", ["crop_unavailable"]]]);
});

// A browser the run cannot obtain or keep is recorded on every readability
// cell the run owed, on the all-stock path and after a page_load grid; it is
// never a thrown failure or a missing record, and page_load reads the same as
// the run without readability.
function landingAndStockRepo(t) {
  const targetRepo = mkdtempSync(join(tmpdir(), "campaigns-os-polish-node-stock-"));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  for (const page of ["landing", "stock"]) {
    mkdirSync(join(targetRepo, "_site", "merchant", page), { recursive: true });
    writeFileSync(join(targetRepo, "_site", "merchant", page, "index.html"), `<html><body>${page}</body></html>`);
  }
  const report = completedReport();
  report.stages.assembly.build_fingerprint = computeBuildFingerprint(join(targetRepo, "_site", "merchant")).fingerprint;
  return { targetRepo, report };
}

const MAPPED_LANDING_PACKET = packetWithPages([{
  page_id: "landing",
  path: "landing.html",
  page_kit: { public_route: "/merchant/landing/", spec_route: "landing/" },
}]);
const ALL_STOCK_PACKET = packetWithPages([
  { page_id: "landing", path: "landing.html", skip_reason: "Synthetic template stock page." },
  { page_id: "stock", path: "stock.html", skip_reason: "Synthetic template stock page." },
]);
const BUILT_ROUTES = ["/merchant/landing/", "/merchant/stock/"];
const cellStatuses = (record) => record.cells.map((cell) => [cell.route, cell.viewport, cell.cell_status]);
const everyCell = (status) => BUILT_ROUTES.flatMap((route) => ["desktop", "mobile"].map((viewport) => [route, viewport, status]));
const unresolvedFactory = () => {
  let resolveFactory;
  const factoryPromise = new Promise((resolve) => { resolveFactory = resolve; });
  return { factory: async () => factoryPromise, resolveFactory };
};
const launchFailure = async () => {
  throw new Error("PRIVATE_LAUNCH_SECRET at /private/tmp/browser-profile");
};

async function allStockCapture(t, options) {
  const { targetRepo, report } = landingAndStockRepo(t);
  return capturePolishReadability({
    packet: ALL_STOCK_PACKET,
    report,
    baseUrl: "http://127.0.0.1:4173",
    targetRepo,
    probeClock: virtualClock(),
    adapterCloseDeadlineMs: 20,
    ...options,
  });
}

async function mappedCaptureWithAndWithoutReadability(t, options) {
  const { targetRepo, report } = landingAndStockRepo(t);
  const run = (repo) => capturePolishPageLoad({
    packet: MAPPED_LANDING_PACKET,
    report,
    baseUrl: "http://127.0.0.1:4173",
    targetRepo: repo,
    probeClock: virtualClock(),
    adapterCloseDeadlineMs: 20,
    ...options(),
  });
  return { withReadability: await run(targetRepo), without: await run(null) };
}

test("all-stock capture: an adapter startup timeout records every built route at both widths as producer_timeout and closes the late adapter", {
  timeout: 2_000,
}, async (t) => {
  const { factory, resolveFactory } = unresolvedFactory();
  const result = await allStockCapture(t, { adapterStartupDeadlineMs: 15, createBrowserAdapter: factory });
  assert.equal(result.page_load, undefined, "no page_load is produced");
  assert.equal(result.media_weight, undefined, "no media_weight is produced");
  assert.deepEqual(cellStatuses(result.readability), everyCell("producer_timeout"));
  assert.deepEqual(result.readability.subject.routes, BUILT_ROUTES);
  let probes = 0;
  let closes = 0;
  resolveFactory({
    async captureRoute() {},
    async probeReadabilityRoute() { probes += 1; },
    async close() { closes += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 0, "the late adapter measures nothing");
  assert.equal(closes, 1, "the late adapter is closed");
});

test("all-stock capture: a browser launch failure records every built route at both widths as navigation_failed without leaking the error", async (t) => {
  const result = await allStockCapture(t, { createBrowserAdapter: launchFailure });
  assert.equal(result.page_load, undefined, "no page_load is produced");
  assert.deepEqual(cellStatuses(result.readability), everyCell("navigation_failed"));
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE_LAUNCH_SECRET", "/private/tmp/browser-profile"]) assert.equal(serialized.includes(secret), false, secret);
});


test("mapped capture: an adapter startup timeout records the readability-only cells after the grid as producer_timeout and leaves page_load unchanged", {
  timeout: 2_000,
}, async (t) => {
  const { withReadability, without } = await mappedCaptureWithAndWithoutReadability(t, () => ({
    adapterStartupDeadlineMs: 15,
    createBrowserAdapter: unresolvedFactory().factory,
  }));
  assert.equal(without.readability, undefined, "setup: the comparison run measures no readability");
  assert.deepEqual(withReadability.page_load, without.page_load, "page_load reads the same");
  assert.deepEqual(withReadability.media_weight, without.media_weight, "media_weight reads the same");
  assert.deepEqual(cellStatuses(withReadability.readability), everyCell("producer_timeout"));
});

test("mapped capture: a browser launch failure records the readability-only cells after the grid as navigation_failed and leaves page_load unchanged", async (t) => {
  const { withReadability, without } = await mappedCaptureWithAndWithoutReadability(t, () => ({ createBrowserAdapter: launchFailure }));
  assert.equal(without.readability, undefined, "setup: the comparison run measures no readability");
  assert.deepEqual(withReadability.page_load, without.page_load, "page_load reads the same");
  assert.deepEqual(withReadability.media_weight, without.media_weight, "media_weight reads the same");
  assert.deepEqual(cellStatuses(withReadability.readability), everyCell("navigation_failed"));
  assert.equal(JSON.stringify(withReadability).includes("PRIVATE_LAUNCH_SECRET"), false);
});

// A rejection carries no reason: the failure is the rejection, not its value.
for (const [label, reason] of [["null", null], ["undefined", undefined]]) {
  const rejectsWith = async () => { throw reason; };

  test(`all-stock capture: a browser factory rejecting with ${label} records every built route at both widths as navigation_failed`, async (t) => {
    const result = await allStockCapture(t, { createBrowserAdapter: rejectsWith });
    assert.equal(result.page_load, undefined, "no page_load is produced");
    assert.equal(result.media_weight, undefined, "no media_weight is produced");
    assert.ok(result.readability, "the readability record is present");
    assert.deepEqual(cellStatuses(result.readability), everyCell("navigation_failed"));
    assert.deepEqual(result.readability.subject.routes, BUILT_ROUTES);
  });

  test(`mapped capture: a browser factory rejecting with ${label} records the readability-only cells after the grid as navigation_failed and page_load reads as a launch failure`, async (t) => {
    const { withReadability, without } = await mappedCaptureWithAndWithoutReadability(t, () => ({ createBrowserAdapter: rejectsWith }));
    const launchFailed = await mappedCaptureWithAndWithoutReadability(t, () => ({ createBrowserAdapter: launchFailure }));
    assert.equal(without.readability, undefined, "setup: the comparison run measures no readability");
    assert.deepEqual(withReadability.page_load, without.page_load, "page_load reads the same");
    assert.deepEqual(withReadability.media_weight, without.media_weight, "media_weight reads the same");
    assert.deepEqual(withReadability.page_load, launchFailed.withReadability.page_load, "page_load reads as a launch failure");
    assert.ok(withReadability.readability, "the readability record is present");
    assert.deepEqual(cellStatuses(withReadability.readability), everyCell("navigation_failed"));
  });

  test(`mapped capture: a browser close rejecting with ${label} reads as a close failure on page_load and readability`, async (t) => {
    const adapter = (close) => async () => ({
      async captureRoute({ url }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 12 },
          mediaElements: [],
          responses: [],
        };
      },
      async probeReadabilityRoute() { return null; },
      close,
    });
    const rejected = await mappedCaptureWithAndWithoutReadability(t, () => ({ createBrowserAdapter: adapter(rejectsWith) }));
    const closeFailed = await mappedCaptureWithAndWithoutReadability(t, () => ({
      createBrowserAdapter: adapter(async () => { throw new Error("PRIVATE_CLOSE_SECRET"); }),
    }));
    assert.deepEqual(rejected.without.page_load, closeFailed.without.page_load, "page_load reads as a close failure");
    assert.deepEqual(rejected.withReadability.page_load, closeFailed.withReadability.page_load);
    assert.deepEqual(cellStatuses(rejected.withReadability.readability), everyCell("navigation_failed"));
  });
}

