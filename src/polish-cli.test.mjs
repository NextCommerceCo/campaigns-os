import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { formatPolishCaptureText, main, polishCaptureCommand } from "./cli.mjs";
import { createCheckpointWaiver } from "./checkpoint-waiver.mjs";

const EXAMPLES = new URL("../examples/", import.meta.url);
const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function mainDocumentResponse(url, viewport, overrides = {}) {
  return {
    request_id: `document-${viewport.key}`,
    url,
    resource_type: "Document",
    status: 200,
    mime_type: "text/html",
    encoded_data_length: 2_048,
    is_final_main_document: true,
    document_context_fingerprint: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ explicitReport = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-polish-capture-"));
  const targetRepo = join(dir, "target-page-kit");
  const packetPath = join(dir, "campaign-runtime.build.json");
  const reportPath = explicitReport
    ? join(dir, "reports/custom-assembly-report.json")
    : join(targetRepo, ".campaign-runtime/assembly-report.json");
  mkdirSync(targetRepo, { recursive: true });

  const packet = readJson(new URL("build-packet.basic.json", EXAMPLES));
  packet.campaign.route_root = "/runtime-packet-demo/";
  packet.assembly.target_repo = "target-page-kit";
  writeJson(packetPath, packet);

  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.inputs.packet_path = "../campaign-runtime.build.json";
  report.stages.assembly.status = "completed";
  report.stages.assembly.build_fingerprint = BUILD_FINGERPRINT;
  report.stages.polish.status = "completed_with_warnings";
  report.stages.polish.evidence = {
    visual_review: { screenshots: ["qa-output/landing-desktop.png"] },
  };
  report.evidence = [];
  writeJson(reportPath, report);
  writeJson(join(targetRepo, ".campaign-runtime/doctor-output.json"), {
    ok: true,
    status: "ready",
    retained: "preserve",
  });

  return { dir, packetPath, reportPath, targetRepo };
}

function successfulAdapter() {
  return async () => ({
    async captureRoute({ url, viewport }) {
      return {
        finalDocumentUrl: url,
        responseCollectionStatus: "complete",
        networkidle: { status: "settled", duration_ms: 25 },
        mediaElements: [],
        responses: [mainDocumentResponse(url, viewport)],
      };
    },
    async close() {},
  });
}

function blockingAdapter() {
  return async () => ({
    async captureRoute({ url, viewport }) {
      const mediaUrl = new URL(`/media/hero-${viewport.key}.mp4?private=token`, url).href;
      return {
        finalDocumentUrl: url,
        responseCollectionStatus: "complete",
        networkidle: { status: "settled", duration_ms: 25 },
        mediaElements: [{
          tag_name: "video",
          current_src: mediaUrl,
          src_attribute: mediaUrl,
          source_src_attributes: [],
          preload_attribute: "auto",
          computed_style: { display: "none", visibility: "visible" },
          ancestor_styles: [{ display: "block", visibility: "visible" }],
          bounding_box: { width: 0, height: 0 },
        }],
        responses: [
          mainDocumentResponse(url, viewport),
          {
            request_id: `media-${viewport.key}`,
            url: mediaUrl,
            resource_type: "Media",
            status: 200,
            encoded_data_length: 1_048_577,
          },
        ],
      };
    },
    async close() {},
  });
}

function commandArgs(f, extra = {}) {
  return {
    _: ["polish", "capture"],
    packet: f.packetPath,
    "base-url": "http://127.0.0.1:4173",
    ...extra,
  };
}

test("polish capture merges onto the latest report, preserves unrelated fields, and stales doctor", async () => {
  const f = fixture();
  try {
    const result = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: successfulAdapter(),
      async afterCapture() {
        const latest = readJson(f.reportPath);
        latest.warnings.push({ code: "CONCURRENT_NOTE", message: "Preserve me" });
        latest.stages.polish.evidence.visual_review.screenshots.push("qa-output/landing-mobile.png");
        writeJson(f.reportPath, latest);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.report_path, f.reportPath);
    const persisted = readJson(f.reportPath);
    assert.equal(persisted.stages.polish.status, "completed_with_warnings");
    assert.equal(persisted.warnings.some((warning) => warning.code === "CONCURRENT_NOTE"), true);
    assert.deepEqual(persisted.stages.polish.evidence.visual_review.screenshots, [
      "qa-output/landing-desktop.png",
      "qa-output/landing-mobile.png",
    ]);
    assert.equal(persisted.stages.polish.evidence.visual_review.page_load.performed_by, "campaigns-os polish capture");
    const sidecar = readJson(join(f.targetRepo, ".campaign-runtime/doctor-output.json"));
    assert.equal(sidecar.stale, true);
    assert.equal(sidecar.stale_marked_by, "polish capture");
    assert.equal(sidecar.retained, "preserve");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("polish capture supports an explicit report path and persists blocked incomplete evidence", async () => {
  const f = fixture({ explicitReport: true });
  try {
    const result = await polishCaptureCommand(commandArgs(f, { report: f.reportPath }), {
      createBrowserAdapter: async () => {
        throw new Error("PRIVATE_BROWSER_SECRET /private/tmp/profile");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.checkpoint.waivable, false);
    const persisted = readJson(f.reportPath);
    assert.equal(persisted.stages.polish.status, "completed_with_warnings");
    assert.equal(persisted.stages.polish.evidence.visual_review.page_load.measurement.status, "incomplete");
    assert.equal(readJson(join(f.targetRepo, ".campaign-runtime/doctor-output.json")).stale, true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("PRIVATE_BROWSER_SECRET"), false);
    assert.equal(serialized.includes("/private/tmp/profile"), false);
    const output = formatPolishCaptureText(result);
    assert.match(output, /Capture problems:/);
    assert.match(output, /Route: \/runtime-packet-demo\/landing\//);
    assert.match(output, /Problem codes: .*producer_failed/);
    assert.match(output, /Checkpoint: Package-owned page-load capture is incomplete/);
    assert.match(output, /campaigns-os polish capture --packet <packet> --base-url <url>/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("polish capture text bounds incomplete cells, problem codes, reasons, and action commands", () => {
  const incomplete = Array.from({ length: 80 }, (_, index) => ({
    route: `/route-${index}/?private=route-secret-${index}`,
    viewport: index % 2 ? "mobile" : "desktop",
    problem_codes: [
      "document_response_error",
      "request_failed",
      `PRIVATE_PROBLEM_${index}`,
    ],
  }));
  const output = formatPolishCaptureText({
    status: "blocked",
    measurement: { status: "incomplete", incomplete },
    checkpoint: {
      code: "polish.hidden_eager_media.capture_incomplete",
      reason: "PRIVATE_REASON /private/tmp/profile",
      findings: [],
      required_actions: [
        {
          id: "polish.hidden_eager_media.capture",
          command: "curl https://private.invalid/?token=secret",
        },
        {
          id: "PRIVATE_ACTION",
          command: "PRIVATE_COMMAND",
        },
      ],
    },
    observed_findings: [],
  });

  assert.match(output, /Capture problems:/);
  assert.match(output, /Problem codes: document_response_error, request_failed/);
  assert.match(output, /Additional incomplete capture cells omitted: 16/);
  assert.match(output, /Checkpoint: Package-owned page-load capture is incomplete/);
  assert.match(output, /campaigns-os polish capture --packet <packet> --base-url <url>/);
  assert.doesNotMatch(output, /PRIVATE|private=|token=secret|curl/);
});

test("missing Chromium persists browser_unavailable and prints the install-browser action", async () => {
  const f = fixture();
  try {
    const result = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: async () => {
        const error = new Error("PRIVATE_BROWSER_PATH /private/tmp/chromium");
        error.code = "POLISH_BROWSER_UNAVAILABLE";
        throw error;
      },
    });
    const persisted = readJson(f.reportPath);
    const captures = persisted.stages.polish.evidence.visual_review.page_load.captures;
    const output = formatPolishCaptureText(result);

    assert.equal(result.ok, false);
    assert.equal(captures.every((capture) => capture.problems.some(
      (problem) => problem.code === "browser_unavailable",
    )), true);
    assert.equal(captures.some((capture) => capture.problems.some(
      (problem) => problem.code === "producer_failed",
    )), false);
    assert.ok(result.checkpoint.required_actions.some(
      (action) => action.id === "polish.hidden_eager_media.install_browser",
    ));
    assert.match(output, /Required action: npm run qa:install-browser/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BROWSER_PATH|private\/tmp/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("non-JSON polish capture text names redacted offending media and transferred bytes", async () => {
  const f = fixture();
  try {
    const result = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: blockingAdapter(),
    });
    const output = formatPolishCaptureText(result);

    assert.match(output, /Status: BLOCKED/);
    assert.match(output, /Route: \/runtime-packet-demo\/landing\//);
    assert.match(output, /Viewport: desktop/);
    assert.match(output, /http:\/\/127\.0\.0\.1:4173\/media\/hero-desktop\.mp4/);
    assert.match(output, /Transferred bytes: 1048577/);
    assert.match(output, /Threshold bytes: 1048576/);
    assert.doesNotMatch(output, /private=token|\?private/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("slow unfinished hidden media persists an observed lower-bound finding and text without hanging", async () => {
  const f = fixture();
  try {
    const slowAdapter = async () => ({
      async captureRoute({ url, viewport }) {
        const mediaUrl = new URL(`/media/slow-${viewport.key}.mp4?private=slow-token`, url).href;
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "failed",
          networkidle: { status: "timeout", duration_ms: 5_000 },
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
          responses: [
            mainDocumentResponse(url, viewport),
            {
              request_id: `slow-${viewport.key}`,
              url: mediaUrl,
              resource_type: "Media",
              status: 206,
              encoded_data_length: 80 * 1_024 * 1_024,
              failed: true,
            },
          ],
        };
      },
      async close() {},
    });
    const result = await polishCaptureCommand(commandArgs(f), { createBrowserAdapter: slowAdapter });
    const output = formatPolishCaptureText(result);

    assert.equal(result.ok, false);
    assert.equal(result.measurement.status, "incomplete");
    assert.deepEqual(result.checkpoint.findings, []);
    assert.equal(result.observed_findings.length, 8);
    assert.match(output, /Observed hidden eager-media findings \(measurement incomplete\)/);
    assert.match(output, /Transferred bytes: 83886080/);
    assert.match(output, /slow-desktop\.mp4/);
    assert.doesNotMatch(output, /private=slow-token|slow-token/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("polish capture refuses a governing or page_load race without writing or staling doctor", async () => {
  for (const mutate of [
    ({ report }) => { report.run_id = "asm_concurrent"; },
    ({ report }) => { report.stages.polish.evidence.visual_review.page_load = { concurrent: true }; },
    ({ packet }) => { packet.campaign.route_root = "/concurrent/"; },
  ]) {
    const f = fixture();
    try {
      const beforeSidecar = readFileSync(join(f.targetRepo, ".campaign-runtime/doctor-output.json"), "utf8");
      await assert.rejects(
        polishCaptureCommand(commandArgs(f), {
          createBrowserAdapter: successfulAdapter(),
          async afterCapture() {
            const currentPacket = readJson(f.packetPath);
            const latest = readJson(f.reportPath);
            mutate({ packet: currentPacket, report: latest });
            writeJson(f.packetPath, currentPacket);
            writeJson(f.reportPath, latest);
          },
        }),
        /attachment refused/i,
      );
      const persisted = readJson(f.reportPath);
      assert.equal(persisted.stages.polish.evidence.visual_review.page_load?.performed_by, undefined);
      assert.equal(
        readFileSync(join(f.targetRepo, ".campaign-runtime/doctor-output.json"), "utf8"),
        beforeSidecar,
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("polish capture evaluates concurrent exact waiver additions from the report snapshot it persists", async () => {
  const f = fixture();
  try {
    const result = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: blockingAdapter(),
      async afterCapture({ capture }) {
        assert.equal(capture.checkpoint.status, "blocked");
        const latest = readJson(f.reportPath);
        latest.waivers = [createCheckpointWaiver(capture.checkpoint, {
          reason: "Approved campaign-specific launch exception",
          waivedBy: "Jordan Lee",
          now: "2026-08-20T00:00:00.000Z",
          reviewCondition: "Re-run capture before the next campaign revision",
        })];
        writeJson(f.reportPath, latest);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready_with_waivers");
    assert.equal(result.checkpoint.status, "waived");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("polish capture evaluates concurrent waiver removal from the report snapshot it persists", async () => {
  const f = fixture();
  try {
    const first = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: blockingAdapter(),
    });
    assert.equal(first.checkpoint.status, "blocked");
    const report = readJson(f.reportPath);
    report.waivers = [createCheckpointWaiver(first.checkpoint, {
      reason: "Temporary review exception",
      waivedBy: "Jordan Lee",
      now: "2026-08-20T00:00:00.000Z",
      reviewCondition: "Remove before final launch review",
    })];
    writeJson(f.reportPath, report);

    const result = await polishCaptureCommand(commandArgs(f), {
      createBrowserAdapter: blockingAdapter(),
      async afterCapture({ capture }) {
        assert.equal(capture.checkpoint.status, "waived");
        const latest = readJson(f.reportPath);
        latest.waivers = [];
        writeJson(f.reportPath, latest);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.checkpoint.status, "blocked");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("polish capture dispatch persists unavailable-runtime evidence and exits 2 without requiring an installed browser", async () => {
  const f = fixture();
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  try {
    const packet = readJson(f.packetPath);
    packet.source_html.pages = [packet.source_html.pages[0]];
    writeJson(f.packetPath, packet);
    const output = [];
    console.log = (...values) => output.push(values.join(" "));
    process.exitCode = undefined;

    await main([
      "polish", "capture",
      "--packet", f.packetPath,
      "--base-url", "http://127.0.0.1:1",
      "--json",
    ]);

    assert.equal(process.exitCode, 2);
    assert.equal(JSON.parse(output.join("\n")).status, "blocked");
    assert.equal(
      readJson(f.reportPath).stages.polish.evidence.visual_review.page_load.measurement.status,
      "incomplete",
    );
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    rmSync(f.dir, { recursive: true, force: true });
  }
});
