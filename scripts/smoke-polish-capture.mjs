#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { polishCaptureCommand } from "../src/cli.mjs";
import { createPolishBrowserAdapter } from "../src/polish-browser.mjs";
import { evaluateRecordedHiddenEagerMediaCheckpoint } from "../src/polish-node.mjs";

const RUN_FLAG = "--run";
const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const EXPECTED_ROUTE = "/runtime-packet-demo/landing/";
const EXAMPLES = new URL("../examples/", import.meta.url);

const MESSAGES = Object.freeze({
  skip: "SKIP: the real Playwright polish-capture smoke is opt-in. Run `node scripts/smoke-polish-capture.mjs --run` after installing Chromium.",
  usage: "FAIL: unsupported smoke arguments. Use `node scripts/smoke-polish-capture.mjs --run`.",
  browser: "FAIL: Playwright Chromium is unavailable. Run `npm run qa:install-browser` in this repository, then retry the opt-in smoke.",
  fixture: "FAIL: the isolated polish-capture smoke fixture could not be prepared.",
  capture: "FAIL: real polish capture did not produce complete passing evidence. Run the focused polish browser, node, and CLI tests before retrying.",
  cleanup: "FAIL: the isolated polish-capture smoke could not clean up all temporary resources.",
  pass: "PASS: real Playwright capture persisted complete clean page-load evidence and the recorded hidden eager-media checkpoint passed.",
});

class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function buildFixture(root) {
  const targetRepo = join(root, "target-page-kit");
  const runtimeDir = join(targetRepo, ".campaign-runtime");
  const builtDir = join(targetRepo, "src", "runtime-packet-demo", "landing");
  const builtPath = join(builtDir, "index.html");
  const packetPath = join(root, "campaign-runtime.build.json");
  const specPath = join(root, "campaign-spec.json");
  const reportPath = join(runtimeDir, "assembly-report.json");
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Polish capture smoke</title>",
    "</head>",
    "<body><main>Clean page-load fixture</main></body>",
    "</html>",
  ].join("");

  mkdirSync(builtDir, { recursive: true });
  writeFileSync(builtPath, html);

  const spec = readJson(new URL("campaignspec.v42.basic.json", EXAMPLES));
  writeJson(specPath, spec);

  const packet = readJson(new URL("build-packet.basic.json", EXAMPLES));
  packet.campaign.route_root = "/runtime-packet-demo/";
  packet.spec.local_path = "campaign-spec.json";
  packet.source_html.pages = [packet.source_html.pages[0]];
  packet.assembly.target_repo = "target-page-kit";
  writeJson(packetPath, packet);

  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.run_id = "asm_polish_capture_smoke";
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.identity.campaign_directory = packet.campaign.campaign_directory;
  report.identity.live_url_path = packet.campaign.live_url_path;
  report.identity.spec_hash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
  report.inputs.packet_path = "../campaign-runtime.build.json";
  report.inputs.spec_path = "../campaign-spec.json";
  report.inputs.target_repo = ".";
  report.stages.assembly.status = "completed";
  report.stages.assembly.build_fingerprint = BUILD_FINGERPRINT;
  report.stages.polish = {
    ...report.stages.polish,
    status: "completed",
    performed_by: "next-campaigns-polish",
    source_build_fingerprint: BUILD_FINGERPRINT,
    completed_at: "2026-08-20T00:00:00.000Z",
    evidence: {
      visual_review: { screenshots: ["qa-output/landing-desktop.png", "qa-output/landing-mobile.png"] },
      brand_review: {
        favicon: { status: "no_source_candidate" },
        brand_bleed: { cleared: true },
      },
      checkout_review: {
        field_labels: "legible",
        bump_compare_price_rule: { equal_compare_price_found: false },
      },
      template_residue_review: {
        starter_favicon: { status: "no_source_candidate" },
      },
      commerce_flow_review: "clean",
      issues: [],
      commands: ["campaigns-os next polish --packet campaign-runtime.build.json"],
    },
  };
  writeJson(reportPath, report);

  return { builtPath, html, packetPath, reportPath, runtimeDir };
}

function startFixtureServer(html) {
  const server = createServer((request, response) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url || "/", "http://smoke.invalid").pathname;
    } catch {
      response.writeHead(400, { "content-length": "0" });
      response.end();
      return;
    }

    if (request.method !== "GET" || pathname !== EXPECTED_ROUTE) {
      response.writeHead(404, { "content-length": "0" });
      response.end();
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(html)),
      "content-type": "text/html; charset=utf-8",
    });
    response.end(html);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The local smoke server did not expose a TCP port."));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeFixtureServer(server) {
  if (!server) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function assertPassingCapture({ result, packet, persistedReport, runtimeDir }) {
  const pageLoad = persistedReport?.stages?.polish?.evidence?.visual_review?.page_load;
  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.equal(result.measurement?.status, "complete");
  assert.equal(result.checkpoint?.status, "pass");
  assert.equal(pageLoad?.measurement?.status, "complete");
  assert.equal(pageLoad?.measurement?.expected_capture_count, 2);
  assert.equal(pageLoad?.measurement?.captured_count, 2);
  assert.equal(pageLoad?.captures?.length, 2);
  assert.equal(pageLoad?.findings?.length, 0);
  assert.deepEqual(pageLoad?.subject?.routes, [EXPECTED_ROUTE]);
  assert.deepEqual(pageLoad?.subject?.viewports, ["desktop", "mobile"]);
  assert.equal(pageLoad.captures.every((capture) => capture.measurement_status === "complete"), true);

  const recordedGate = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report: persistedReport });
  assert.equal(recordedGate.status, "pass");
  assert.equal(recordedGate.code, "polish.hidden_eager_media.pass");
  assert.equal(recordedGate.state_fingerprint, result.checkpoint.state_fingerprint);
  assert.equal(readdirSync(runtimeDir).some((name) => name.endsWith(".tmp")), false);
}

async function runSmoke() {
  let root = null;
  let server = null;
  let browserAdapter = null;
  let cleanupFailed = false;
  try {
    root = mkdtempSync(join(tmpdir(), "campaigns-os-polish-smoke-"));
    let fixture;
    try {
      fixture = buildFixture(root);
      assert.equal(readFileSync(fixture.builtPath, "utf8"), fixture.html);
    } catch {
      throw new SmokeFailure(MESSAGES.fixture);
    }

    let baseUrl;
    try {
      ({ server, baseUrl } = await startFixtureServer(fixture.html));
    } catch {
      throw new SmokeFailure(MESSAGES.fixture);
    }

    try {
      browserAdapter = await createPolishBrowserAdapter();
    } catch {
      throw new SmokeFailure(MESSAGES.browser);
    }

    try {
      let adapterClaimed = false;
      const result = await polishCaptureCommand({
        _: ["polish", "capture"],
        packet: fixture.packetPath,
        "base-url": baseUrl,
      }, {
        createBrowserAdapter: async () => {
          if (adapterClaimed || !browserAdapter) {
            throw new Error("The smoke adapter was already claimed.");
          }
          adapterClaimed = true;
          const claimed = browserAdapter;
          browserAdapter = null;
          return claimed;
        },
      });
      const packet = readJson(fixture.packetPath);
      const persistedReport = readJson(fixture.reportPath);
      assertPassingCapture({ result, packet, persistedReport, runtimeDir: fixture.runtimeDir });
    } catch {
      throw new SmokeFailure(MESSAGES.capture);
    }
  } finally {
    if (browserAdapter) {
      try {
        await browserAdapter.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await closeFixtureServer(server);
    } catch {
      cleanupFailed = true;
    }
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new SmokeFailure(MESSAGES.cleanup);
  }
}

async function main(argv) {
  if (argv.length === 0) {
    console.log(MESSAGES.skip);
    return 0;
  }
  if (argv.length !== 1 || argv[0] !== RUN_FLAG) {
    console.error(MESSAGES.usage);
    return 2;
  }

  try {
    await runSmoke();
    console.log(MESSAGES.pass);
    return 0;
  } catch (error) {
    console.error(error instanceof SmokeFailure ? error.message : MESSAGES.capture);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
