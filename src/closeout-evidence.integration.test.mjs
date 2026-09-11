// Producer -> saved artifacts -> consumers.
//
// The 2026-09-11 shadow-campaign validation run failed in the seam between
// them: helpers with idealized inputs all agreed, while the bytes actually on
// disk told `next` two contradictory stories — stage "done" beside a required
// demand for a Run Record that already existed, and a refreshed QA status beside
// a previous run's identity and an already-fixed "remaining blocker".
//
// So every case here runs the real producer, lets it write real files, and then
// asks the real consumers about those files. No hand-built report is asserted
// against a hand-built expectation.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { nextStage, recordQaStageOutcome } from "./cli.mjs";
import { buildPageLoadCapture } from "./polish-capture.mjs";
import { buildPolishPageLoadEvidence } from "./polish-page-load.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const MAP_ID = "runtime-packet-demo-k9x2";
const SLUG = "runtime-packet-demo";
const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const DEPLOY_URL = "https://preview-fixture.netlify.app";

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function cleanPageLoad(packet) {
  const routes = packet.source_html.pages.filter((page) => !page.skip_reason).map((page) => page.page_kit.public_route).sort();
  const viewports = ["desktop", "mobile"];
  const captures = routes.flatMap((route) => viewports.map((viewport) => {
    const url = `https://preview.example.test${route}`;
    return buildPageLoadCapture({
      buildFingerprint: BUILD_FINGERPRINT,
      slug: packet.campaign.public_route_slug,
      requestedRoute: route,
      viewport,
      requestedDocumentUrl: url,
      finalDocumentUrl: url,
      responseCollectionStatus: "complete",
      networkidle: { status: "settled", duration_ms: 10 },
      mediaElements: [],
      responses: [{
        request_id: `document-${route}-${viewport}`,
        url,
        resource_type: "Document",
        status: 200,
        mime_type: "text/html",
        is_final_main_document: true,
        document_context_fingerprint: `sha256:${"d".repeat(64)}`,
        encoded_data_length: 1024,
      }],
    });
  }));
  return buildPolishPageLoadEvidence({ buildFingerprint: BUILD_FINGERPRINT, slug: packet.campaign.public_route_slug, routeScope: "all", routes, viewports, captures });
}

// A doctor-green target whose ladder is complete up to (and including) deploy,
// with QA left for the producer to record. Mirrors the fixture shape used by
// next-divergence.test.mjs so this exercises the same real picker path.
function target({ prefix = "closeout-evidence-", orderPathDepth = "common", mutateReport = null } = {}) {
  const dir = tempDir(prefix);
  cpSync(join(ROOT, "examples/build-packet.basic.json"), join(dir, "campaign-runtime.build.json"));
  cpSync(join(ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
  cpSync(join(ROOT, "examples/source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(ROOT, "examples/target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(join(ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.qa.proof_policy.order_path_depth = orderPathDepth;
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));

  const report = JSON.parse(readFileSync(join(ROOT, "examples/assembly-report.example.json"), "utf8"));
  report.identity = { map_id: MAP_ID, public_route_slug: SLUG, campaign_directory: SLUG, live_url_path: `/${SLUG}/`, spec_hash: "fixture-hash" };
  report.template_family = { value: "olympus", locked: true, locked_by: "fixture", commerce_catalog_version: "2", candidates: [] };
  report.proof_policy = { ...packet.qa.proof_policy };
  const stages = report.stages;
  for (const key of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy"]) stages[key].status = "completed";
  stages.assembly.build_fingerprint = BUILD_FINGERPRINT;
  stages.polish.performed_by = "next-campaigns-polish";
  stages.polish.source_build_fingerprint = BUILD_FINGERPRINT;
  stages.polish.completed_at = "2026-08-01T00:00:00.000Z";
  stages.polish.evidence = {
    visual_review: { screenshots: ["qa-output/checkout-desktop.png", "qa-output/checkout-mobile.png"], page_load: cleanPageLoad(packet) },
    brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: true, promo_codes: "none", fonts: "design fonts only", colors: "tokenized" } },
    checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
    template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found" },
    commerce_flow_review: { shop_single_step: "direct-entry force-package/product-selector limitation reviewed" },
    issues: [],
    commands: ["next-campaigns-polish"],
  };
  stages.deploy.outputs = [DEPLOY_URL];
  stages.qa.status = "pending";
  if (mutateReport) mutateReport(report);

  const runtimeDir = join(dir, "target-page-kit", ".campaign-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const reportPath = join(runtimeDir, "assembly-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { dir, packetPath, reportPath };
}

// A synthesized verdict. Not copied from any run: no merchant, campaign, order
// or customer value appears anywhere in this repository.
function verdict({ runId, completedAt, orders = 1 }) {
  return {
    schema_version: "1.0",
    run_id: runId,
    campaign_slug: MAP_ID,
    public_route_slug: SLUG,
    started_at: completedAt,
    completed_at: completedAt,
    disposition: "ready",
    assertions: [],
    exceptions: [],
    test_orders: Array.from({ length: orders }, (unused, index) => ({
      path: "accept",
      ok: true,
      next_order_id: `9000${index}`,
      ref_id: `SYNTH-REF-${index}`,
      qa_email: "qa@example.invalid",
      is_test: true,
      checkout_url: "https://example.invalid/checkout",
      verification: { verified: true },
    })),
  };
}

// The producer, writing real files exactly as `qa run` does.
function runProducer({ dir, packetPath }, { runId, completedAt, orders = 1 }) {
  const built = verdict({ runId, completedAt, orders });
  const localDir = join(dir, "qa-output", MAP_ID);
  mkdirSync(localDir, { recursive: true });
  const localPath = join(localDir, `${runId}.json`);
  writeFileSync(localPath, JSON.stringify(built, null, 2));
  const recorded = recordQaStageOutcome({ packet: packetPath, _: [] }, { verdict: built, local_path: localPath });
  assert.equal(recorded, true, "the QA producer must own its assembly-report stage");
  return { verdict: built, localPath };
}

function writeRunRecord({ dir, packetPath }, runId) {
  const out = JSON.parse(execFileSync("node", [
    CLI, "run-record",
    "--packet", packetPath,
    "--journal", join(dir, "workflow-findings.jsonl"),
    "--run-id", runId,
    "--no-remit",
    "--json",
  ], { encoding: "utf8" }));
  assert.equal(out.written, true);
  return out;
}

function runNext(packetPath) {
  return nextStage(null, { packet: packetPath, _: [], "no-write": true });
}

function action(result, id) {
  return (result.next_actions || []).find((entry) => entry.id === id) || null;
}

function readReport(reportPath) {
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

test("a closed Run Record for the current verdict stops next demanding a second one", () => {
  const fixture = target();
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z" });

  const before = runNext(fixture.packetPath);
  assert.equal(before.stage, "done", "the ladder must reach done once QA is recorded");
  assert.equal(action(before, "run_record_closeout")?.required, true, "with no record on disk, closeout stays required");

  const record = writeRunRecord(fixture, "run_synth_0000000001");
  assert.equal(record.record.remit_state, "skipped", "--no-remit is a closed, local-only record");

  const after = runNext(fixture.packetPath);
  assert.equal(after.stage, "done");
  assert.equal(action(after, "run_record_closeout"), null, "a matching, current, closed record satisfies closeout");
  const pointer = action(after, "run_record_present");
  assert.ok(pointer, "next must still name the durable record");
  assert.notEqual(pointer.required, true);
  assert.match(pointer.description, /run_synth_0000000001/);
});

test("a new verdict moves the stage identity forward and re-opens the closeout demand", () => {
  const fixture = target();
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z" });
  writeRunRecord(fixture, "run_synth_0000000001");
  assert.equal(action(runNext(fixture.packetPath), "run_record_closeout"), null);

  runProducer(fixture, { runId: "SYNTHRUN000000000000000002", completedAt: "2026-09-11T04:00:00.000Z" });
  const qa = readReport(fixture.reportPath).stages.qa;
  assert.equal(qa.verdict_run_id, "SYNTHRUN000000000000000002", "latest identity must follow the latest verdict");
  assert.deepEqual(qa.history.map((entry) => entry.verdict_run_id), ["SYNTHRUN000000000000000001"]);
  assert.equal(qa.history[0].checked_at, "2026-09-11T02:00:00.000Z", "history keeps the ORIGINAL timestamp");

  const stale = runNext(fixture.packetPath);
  const closeout = action(stale, "run_record_closeout");
  assert.ok(closeout, "a record tied to the previous verdict cannot close the new one");
  assert.equal(closeout.required, true);
  assert.match(closeout.description, /outdated_artifacts/);

  writeRunRecord(fixture, "run_synth_0000000002");
  assert.equal(action(runNext(fixture.packetPath), "run_record_closeout"), null);
});

test("the written assembly report still validates through the supported validator", () => {
  const fixture = target();
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z" });
  const out = JSON.parse(execFileSync("node", [CLI, "validate-assembly-report", "--report", fixture.reportPath, "--json"], { encoding: "utf8" }));
  assert.equal(out.ok, true, JSON.stringify(out.errors || out));
});

test("the recorded purchase proof is counts-only and carries no order identity", () => {
  const fixture = target();
  const produced = runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z", orders: 2 });
  const qa = readReport(fixture.reportPath).stages.qa;
  assert.deepEqual(qa.purchase_proof, {
    declared_order_path_depth: "common",
    declared_typed_card_depth: "common",
    order_paths_executed: 2,
    orders_created: 2,
    orders_verified: 2,
    all_orders_test_mode: true,
  });
  const serialized = JSON.stringify(readReport(fixture.reportPath));
  for (const order of produced.verdict.test_orders) {
    for (const leak of [order.next_order_id, order.ref_id, order.qa_email, order.checkout_url]) {
      assert.equal(serialized.includes(leak), false, `the assembly report must not carry ${leak}`);
    }
  }
});

test("a --test-order off run cannot carry a declared common depth to done", () => {
  const fixture = target();
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z", orders: 0 });
  const result = runNext(fixture.packetPath);
  assert.equal(result.stage, "qa", "zero executed order paths cannot satisfy a declared common depth");
  assert.match(result.picked_reason, /order-path depth is not proved/, "next must say WHY it refused done");
  assert.ok(action(result, "qa_run"), "the operator is handed the QA command, not just a refusal");
  assert.equal(action(result, "run_record_closeout"), null, "a run that is not done does not get a terminal closeout action");
});

test("an intentional no-order diagnostic policy still reaches done unchanged", () => {
  const fixture = target({ prefix: "closeout-evidence-nodepth-", orderPathDepth: "off" });
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z", orders: 0 });
  const result = runNext(fixture.packetPath);
  assert.equal(result.stage, "done");
  assert.equal(action(result, "purchase_proof_unknown"), null);
});

// Old-format leg. Shape reproduced from the pre-#308 report on record: stages
// with no `checked_at`, a `completed_at` on a stage that is not completed, and a
// hand-authored verdict_run_id / evidence pair. Synthesized, not copied.
test("an old-format report is read, advised about, and migrated without loss", () => {
  const fixture = target({
    prefix: "closeout-evidence-legacy-",
    mutateReport(report) {
      for (const stage of Object.values(report.stages)) delete stage.checked_at;
      report.stages.qa.status = "completed_with_warnings";
      report.stages.qa.completed_at = "2026-09-10T09:00:00.000Z";
      report.stages.qa.verdict_run_id = "HANDAUTHOREDRUN0000000001";
      report.stages.qa.evidence = { remaining_blocker: "a blocker that has since been fixed" };
      report.stages.qa.waivers = ["operator-approved exception"];
    },
  });

  // Consumers must read it without throwing, and an absent purchase-proof
  // summary must be an advisory, never a new block on a finished campaign.
  const legacy = runNext(fixture.packetPath);
  assert.equal(legacy.stage, "done", "an unknown proof summary must not un-finish an existing campaign");
  const advisory = action(legacy, "purchase_proof_unknown");
  assert.ok(advisory, "unknown coverage is stated, not silently assumed");
  assert.notEqual(advisory.required, true);
  assert.equal(action(legacy, "run_record_closeout")?.required, true);
  assert.equal(JSON.parse(execFileSync("node", [CLI, "validate-assembly-report", "--report", fixture.reportPath, "--json"], { encoding: "utf8" })).ok, true);
  writeRunRecord(fixture, "run_synth_legacy001");

  // The first producer write migrates the hand-authored pair into history
  // rather than deleting it, and does not invent a timestamp it never had.
  runProducer(fixture, { runId: "SYNTHRUN000000000000000001", completedAt: "2026-09-11T02:00:00.000Z" });
  const qa = readReport(fixture.reportPath).stages.qa;
  assert.equal(qa.verdict_run_id, "SYNTHRUN000000000000000001");
  assert.equal(qa.evidence?.remaining_blocker, undefined, "a resolved blocker cannot survive beside a passing status");
  assert.equal(qa.history.length, 1);
  assert.equal(qa.history[0].verdict_run_id, "HANDAUTHOREDRUN0000000001");
  assert.equal(qa.history[0].evidence.remaining_blocker, "a blocker that has since been fixed");
  assert.equal(Object.hasOwn(qa.history[0], "checked_at"), false, "a stage with no checked_at gets no invented one");
  assert.deepEqual(qa.waivers, ["operator-approved exception"], "unrelated extension fields survive");
});

test("a satisfied record in one target never satisfies another", () => {
  const a = target({ prefix: "closeout-evidence-a-" });
  const b = target({ prefix: "closeout-evidence-b-" });
  runProducer(a, { runId: "SYNTHRUN00000000000000000A", completedAt: "2026-09-11T02:00:00.000Z" });
  runProducer(b, { runId: "SYNTHRUN00000000000000000B", completedAt: "2026-09-11T02:00:00.000Z" });
  writeRunRecord(a, "run_synth_targeta01");

  assert.equal(action(runNext(a.packetPath), "run_record_closeout"), null);
  const closeout = action(runNext(b.packetPath), "run_record_closeout");
  assert.ok(closeout, "target B has no record of its own and must still be told so");
  assert.equal(closeout.required, true);

  // Neither run may reach into the other's records directory.
  assert.equal(existsSync(join(b.dir, ".campaign-runtime/run-records")), false);
  assert.deepEqual(readdirSync(join(a.dir, ".campaign-runtime/run-records")), ["run_synth_targeta01.json"]);
});
