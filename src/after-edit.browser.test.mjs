// Real-browser copy-edit proof. Like qa-currency.browser.test.mjs, serve a
// synthetic built tree on loopback and skip only when Chromium cannot launch.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEditCommand, afterEditExitCode, afterEditTextLines } from "./after-edit.mjs";
import { specFetchCommand, specDeriveWithMapWriteback, specDeriveTextLines, recordQaStageOutcome } from "./cli.mjs";
import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import { currentPacketInputs, inputStamps } from "./input-currency.mjs";
import { recordCommand } from "./stage-record.mjs";
import { runQa } from "./qa-node.mjs";
import { buildPageLoadCapture } from "./polish-capture.mjs";
import { buildPolishPageLoadEvidence } from "./polish-page-load.mjs";

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch (error) {
    if (process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1") throw error;
    return false;
  }
}

const browserTest = await chromiumAvailable() ? test : test.skip;
const SLUG = "synthetic-campaign";
const HTML = '<!doctype html><html class="next-display-ready"><head><title>Example page</title><meta name="next-page-type" content="product"></head><body><h1>Example headline</h1></body></html>';
function write(path, body) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
const writeJson = (path, body) => write(path, `${JSON.stringify(body, null, 2)}\n`);

browserTest("copy edit with the real page QA browser lane ends QA is current", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "after-edit-browser-"));
  const output = join(root, "_site", SLUG);
  const loads = [];
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      posts += 1;
      response.writeHead(405);
      return response.end();
    }
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === `/${SLUG}/landing/`) {
      loads.push(url.pathname);
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(readFileSync(join(output, "landing", "index.html")));
    }
    // Favicon requests do not cause a fixture-only console error.
    response.writeHead(url.pathname === "/favicon.ico" ? 204 : 404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const packetPath = join(root, "campaign-runtime.build.json");
    const reportPath = join(root, ".campaign-runtime", "assembly-report.json");
    const specPath = join(root, "campaign-spec.json");
    const store = { store_name: "Synthetic Store", store_url: "https://shop.example.test/" };
    const spec = {
      schema_version: "4.3", spec_identity: { map_id: "synthetic-map", public_route_slug: SLUG },
      campaign: { name: "Synthetic campaign", slug: SLUG, ...store }, global_config: { sdk_version: "0.4.40" },
      funnels: [{ id: "main", pages: [{ id: "landing", type: "landing", page_url: "landing/", order: 1 }] }],
    };
    const packet = {
      schema_version: "campaign-runtime-build-packet/v0", campaign: { public_route_slug: SLUG },
      spec: { map_id: "synthetic-map", local_path: "campaign-spec.json" },
      assembly: { target_repo: ".", output_dir: `src/${SLUG}` },
      deploy: { target: "local-serve", preview_url: base },
      source_html: { pages: [{ page_id: "landing", origin: "repo", page_kit: { public_route: `/${SLUG}/landing/`, spec_route: "landing/" } }] },
    };
    writeJson(packetPath, packet);
    writeJson(specPath, spec);
    const configPath = join(root, "_data", "campaigns.json");
    writeJson(configPath, { [SLUG]: { sdk_version: "0.4.40", ...store } });
    const sourcePath = join(root, "src", SLUG, "landing.html");
    const page = (html) => {
      write(sourcePath, `---\npage_type: product\n---\n${html}`);
      write(join(output, "landing", "index.html"), html);
      utimesSync(sourcePath, 1_000, 1_000);
      utimesSync(join(output, "landing", "index.html"), 2_000, 2_000);
    };
    page(HTML);
    utimesSync(configPath, 1_000, 1_000);
    const original = computeBuildFingerprint(output);
    const route = `/${SLUG}/landing/`;
    const viewports = ["desktop", "mobile"];
    const pageLoad = buildPolishPageLoadEvidence({
      buildFingerprint: original.fingerprint, slug: SLUG, routeScope: "all", routes: [route], viewports,
      captures: viewports.map((viewport) => buildPageLoadCapture({
        buildFingerprint: original.fingerprint, slug: SLUG, requestedRoute: route, viewport,
        requestedDocumentUrl: `${base}${route}`, finalDocumentUrl: `${base}${route}`,
        responseCollectionStatus: "complete", networkidle: { status: "settled", duration_ms: 10 }, mediaElements: [],
        responses: [{ request_id: `document-${viewport}`, url: `${base}${route}`, resource_type: "Document", status: 200,
          mime_type: "text/html", is_final_main_document: true, document_context_fingerprint: `sha256:${"d".repeat(64)}`, encoded_data_length: 1024 }],
      })),
    });
    const report = {
      schema_version: "campaign-runtime-assembly-report/v0", run_id: "synthetic-run", generated_at: "2026-11-01T00:00:00Z", status: "prepared",
      identity: { map_id: "synthetic-map", public_route_slug: SLUG, campaign_directory: SLUG, live_url_path: `/${SLUG}/`, spec_hash: "synthetic-spec", spec_material_hash: specMaterialHash(spec) },
      inputs: { packet_path: "campaign-runtime.build.json", context_path: ".campaign-runtime/build-context.json", spec_path: "campaign-spec.json", source: { kind: "html_funnel", root: "source" }, target_repo: "." },
      template_family: { value: "olympus", locked: true }, decisions: [], evidence: [], blockers: [], warnings: [],
      next: { stage: "build", owner: "build", action: "Record build" }, stages: {},
    };
    for (const stage of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) report.stages[stage] = { stage, status: "completed" };
    Object.assign(report.stages.assembly, { build_fingerprint: original.fingerprint, build_manifest: buildManifestEntries(original) });
    Object.assign(report.stages.polish, { source_build_fingerprint: original.fingerprint, evidence: { visual_review: { page_load: pageLoad } } });
    Object.assign(report.stages.qa, { evidence: { qc_build_fingerprint: original.fingerprint, qc_results: [] }, purchase_proof: { order_paths_executed: 3, declared_depth: "common" } });
    for (const stage of ["assembly", "polish", "qa"]) Object.assign(report.stages[stage], inputStamps(currentPacketInputs({ packet, packetPath })));
    writeJson(reportPath, report);
    writeJson(join(root, ".campaign-runtime", "build-context.json"), { spec: { active_pages: spec.funnels[0].pages }, page_map: [], scaffold: { required: false } });
    await recordCommand({ _: ["record", "build"], packet: packetPath });
    page(HTML.replace("Example headline", "Revised headline"));
    const calls = [];
    let qa;
    const result = await afterEditCommand({ _: ["after-edit"], packet: packetPath, "run-qa": true, "no-live-refs": true }, {
      specFetch: specFetchCommand, specDerive: specDeriveWithMapWriteback, specDeriveTextLines, recordQaStageOutcome,
      // Copy alone does not owe a browser. Exercise that optional lane with
      // the real producer, preserving its page scope and default order modes.
      runQa: async (args) => { calls.push(args); qa = await runQa({ ...args, browser: true }); return qa; },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].page, ["landing"]);
    assert.equal(afterEditExitCode(result), 0, afterEditTextLines(result).join("\n"));
    assert.equal(result.steps.find((row) => row.step === "run_qa").status, "done");
    assert.ok(qa.verdict.assertions.some((row) => row.id === "browser-load:landing" && row.status === "pass"));
    assert.deepEqual(qa.verdict.test_orders, []);
    assert.equal(posts, 0, "no order or publish request");
    assert.ok(loads.length >= 2, "static and browser QA both requested the changed page");
    assert.equal(result.ci.status, "current");
    assert.match(afterEditTextLines(result).join("\n"), /Owed after QA:\n[\s\S]*QA is current/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
