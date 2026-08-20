import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectLedgerDivergence, nextStage } from "./cli.mjs";
import { buildPageLoadCapture } from "./polish-capture.mjs";
import { buildPolishPageLoadEvidence } from "./polish-page-load.mjs";

// Packet 03 (INV-5 first slice, EN-1): `next` must report ledger-artifact
// divergence instead of answering `doctor-blocked` + "go back to the
// beginning" on repos whose artifacts prove the campaign is already built,
// deployed, and QA'd. Reader-only: detection is a pure projection of
// (report, packet, target-repo contents) — no cwd, no clock, no mtimes —
// and a divergence is always reported as a DISAGREEMENT to inspect, never
// as proof a stage is complete.

const OS_ROOT = new URL("..", import.meta.url).pathname;

const FIXTURE_DEPLOY_URL = "https://preview-fixture.netlify.app";
const MAP_ID = "runtime-packet-demo-k9x2";
const SLUG = "runtime-packet-demo";
const BUILD_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function reportStage(name, status = "pending") {
  return { stage: name, status, inputs: [], outputs: [], commands: [], blockers: [], warnings: [] };
}

function ledgerAllPending({ prepareBuildStatus = "completed" } = {}) {
  return {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "asm_fixture",
    generated_at: "2026-08-01T00:00:00.000Z",
    status: "prepared",
    stages: {
      prepare_build: reportStage("prepare_build", prepareBuildStatus),
      doctor: reportStage("doctor"),
      setup: reportStage("setup"),
      assembly: reportStage("assembly"),
      polish: reportStage("polish"),
      deploy: reportStage("deploy"),
      qa: reportStage("qa"),
    },
  };
}

function writeVerdict(dir, name = "RUN1.json") {
  mkdirSync(join(dir, "qa-output", MAP_ID), { recursive: true });
  writeFileSync(join(dir, "qa-output", MAP_ID, name), JSON.stringify({
    schema_version: "campaigns-os-qa-verdict/v0",
    campaign_slug: MAP_ID,
    verdict: "pass",
    assertions: [],
    test_orders: [],
  }));
}

function writeBuiltOutput(dir) {
  mkdirSync(join(dir, "_site", SLUG), { recursive: true });
  writeFileSync(join(dir, "_site", SLUG, "index.html"), "<html></html>");
}

function cleanPageLoad(packet) {
  const routes = packet.source_html.pages
    .filter((page) => !page.skip_reason)
    .map((page) => page.page_kit.public_route)
    .sort();
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
        encoded_data_length: 1_024,
      }],
    });
  }));
  return buildPolishPageLoadEvidence({
    buildFingerprint: BUILD_FINGERPRINT,
    slug: packet.campaign.public_route_slug,
    routeScope: "all",
    routes,
    viewports,
    captures,
  });
}

// Self-target fixture built from the basic example packet. Without source
// files the doctor is blocked (the exact shape reproduced in audit doc 07:
// a confident `doctor-blocked` answer against a repo whose artifacts show
// finished work).
function selfTargetFixture({ builtOutput = false, deployUrlInReport = false, verdict = false, report = ledgerAllPending() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "next-divergence-"));
  cpSync(join(OS_ROOT, "examples/build-packet.basic.json"), join(dir, "campaign-runtime.build.json"));
  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.target_repo = ".";
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  if (deployUrlInReport) report.stages.deploy.outputs = [FIXTURE_DEPLOY_URL];
  if (builtOutput) writeBuiltOutput(dir);
  if (verdict) writeVerdict(dir);
  writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), JSON.stringify(report, null, 2));
  return { dir, packetPath };
}

// Doctor-green fixture assembled from the examples tree: complete report
// identity, locked template family, commerce catalog present, full polish
// evidence — so `next` reaches real stage picking instead of doctor-blocked.
function doctorGreenFixture() {
  const dir = mkdtempSync(join(tmpdir(), "next-divergence-green-"));
  cpSync(join(OS_ROOT, "examples/build-packet.basic.json"), join(dir, "campaign-runtime.build.json"));
  cpSync(join(OS_ROOT, "examples/campaignspec.v42.basic.json"), join(dir, "campaignspec.v42.basic.json"));
  cpSync(join(OS_ROOT, "examples/source-html"), join(dir, "source-html"), { recursive: true });
  cpSync(join(OS_ROOT, "examples/target-page-kit"), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(join(OS_ROOT, "contracts/commerce-surface-catalog.json"), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "campaign-runtime.build.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));

  const report = JSON.parse(readFileSync(join(OS_ROOT, "examples/assembly-report.example.json"), "utf8"));
  report.identity = {
    map_id: MAP_ID,
    public_route_slug: SLUG,
    campaign_directory: SLUG,
    live_url_path: `/${SLUG}/`,
    spec_hash: "fixture-hash",
  };
  report.template_family = { value: "olympus", locked: true, locked_by: "fixture", commerce_catalog_version: "2", candidates: [] };
  const stages = report.stages;
  stages.prepare_build.status = "completed";
  stages.doctor.status = "completed";
  stages.setup.status = "completed";
  stages.assembly.status = "completed";
  stages.assembly.build_fingerprint = BUILD_FINGERPRINT;
  stages.polish.status = "completed";
  stages.polish.performed_by = "next-campaigns-polish";
  stages.polish.source_build_fingerprint = BUILD_FINGERPRINT;
  stages.polish.completed_at = "2026-08-01T00:00:00.000Z";
  stages.polish.evidence = {
    visual_review: {
      screenshots: ["qa-output/checkout-desktop.png", "qa-output/checkout-mobile.png"],
      page_load: cleanPageLoad(packet),
    },
    brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: true, promo_codes: "none", fonts: "design fonts only", colors: "tokenized" } },
    checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
    template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found" },
    commerce_flow_review: { shop_single_step: "direct-entry force-package/product-selector limitation reviewed" },
    issues: [],
    commands: ["next-campaigns-polish"],
  };
  stages.deploy.status = "pending";
  stages.deploy.outputs = [FIXTURE_DEPLOY_URL];
  stages.qa.status = "pending";

  const runtimeDir = join(dir, "target-page-kit", ".campaign-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "assembly-report.json"), JSON.stringify(report, null, 2));
  return { dir, packetPath };
}

function runNext(packetPath) {
  return nextStage(null, { packet: packetPath, _: [], "no-write": true });
}

// A "start over" recommendation is an ACTION that reruns prepare-build/start
// or re-setup — i.e. an action id/command/skill pointing there. Prose that
// says "do NOT rerun start/prepare-build" is the suppression itself, so
// these checks look at action identities and commands, not raw prose.
function assertNoStartOverRecommendation(result) {
  const actions = result.next_actions || [];
  const ids = actions.map((action) => action.id);
  assert.ok(!ids.includes("rerun_prepare_build"), "no rerun_prepare_build action may appear");
  for (const action of actions) {
    const command = String(action.command || "");
    assert.doesNotMatch(command, /campaigns-os start/, "no `campaigns-os start` command may be recommended");
    assert.doesNotMatch(command, /prepare-build/, "no prepare-build command may be recommended");
    assert.notEqual(command, "next-campaigns-os-setup", "no re-setup skill may be recommended");
  }
}

// ---------------------------------------------------------------------------
// Proof 1 — divergence fixture: built output + deploy URL + verdict against
// an all-pending ledger yields three NAMED divergences (both sides quoted)
// and no "start over" (rerun prepare-build / `campaigns-os start`)
// recommendation.
// ---------------------------------------------------------------------------
test("next reports three named divergences and never recommends starting over", () => {
  const { dir, packetPath } = selfTargetFixture({ builtOutput: true, deployUrlInReport: true, verdict: true });
  const result = runNext(packetPath);

  assert.ok(Array.isArray(result.divergences), "divergences[] must be present");
  assert.deepEqual(result.divergences.map((entry) => entry.code), [
    "divergence.assembly.built_output_present",
    "divergence.deploy.url_present",
    "divergence.qa.verdict_present",
  ]);
  for (const entry of result.divergences) {
    assert.ok(entry.ledger_claim.includes('"pending"'), `divergence ${entry.code} must quote the ledger claim`);
    assert.ok(entry.artifact_evidence.length > 0, `divergence ${entry.code} must quote the artifact evidence`);
  }
  assert.match(result.divergences[0].artifact_evidence, /_site\/runtime-packet-demo\//);
  assert.match(result.divergences[1].artifact_evidence, /https:\/\/preview-fixture\.netlify\.app/);
  assert.match(result.divergences[2].artifact_evidence, /qa-output\/runtime-packet-demo-k9x2\/RUN1\.json/);

  assertNoStartOverRecommendation(result);
  const inspect = (result.next_actions || []).find((action) => action.id === "divergence_inspect");
  assert.ok(inspect, "a divergence_inspect next action must replace the start-over recommendation");
  assert.match(inspect.description, /disagree/i);
  assert.match(inspect.description, /[Ii]nspect/);
  rmSync(dir, { recursive: true, force: true });
});

// The `campaigns-os start` recommendation itself lives on the prepare-build
// branch: with a pending prepare_build ledger AND divergent artifacts, the
// start action must be suppressed and replaced by divergence_inspect.
test("prepare-build start-over action is suppressed when artifacts diverge", () => {
  const { dir, packetPath } = doctorGreenFixture();
  // Rewrite the ledger so prepare_build is pending while the deploy URL
  // artifact stays recorded — the exact "ledger says start over, artifacts
  // say the work happened" shape.
  const reportPath = join(dir, "target-page-kit", ".campaign-runtime/assembly-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.stages.prepare_build.status = "pending";
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const result = runNext(packetPath);
  assert.equal(result.stage, "prepare-build");
  assert.ok((result.divergences || []).length >= 1);
  const ids = (result.next_actions || []).map((action) => action.id);
  assert.ok(ids.includes("divergence_inspect"));
  assertNoStartOverRecommendation(result);
  assert.match(String(result.prompt || ""), /Do not rerun `campaigns-os prepare-build` or `campaigns-os start`/, "prompt must suppress, not recommend, the start-over recovery");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Proof 2 — clean-repo negative control: a genuinely fresh repo (no built
// output, no deploy URL, no verdict) must stay on the ordinary doctor-blocked
// path, with no divergences key and no suppressed blockers. Missing packet-local
// spec evidence now adds the two registered checkpoint repair actions before
// the generic doctor recheck.
// ---------------------------------------------------------------------------
test("clean repo keeps the divergence shape while surfacing missing-spec checkpoint repairs", () => {
  const { dir, packetPath } = selfTargetFixture();
  const result = runNext(packetPath);

  assert.equal("divergences" in result, false, "clean repo must not grow a divergences key");
  // (The fixture's own tmp-dir name contains "divergence", so match the
  // divergence vocabulary specifically, not the bare word.)
  assert.doesNotMatch(JSON.stringify(result), /"divergences"|divergence_inspect|divergence\./, "clean repo output must not mention divergences anywhere");

  // Pre-change shape captured at main@002fdfe for this fixture.
  assert.deepEqual(Object.keys(result), ["ok", "status", "stage", "reason", "errors", "warnings", "ready", "prompt", "gates", "next_actions"]);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.stage, "doctor-blocked");
  assert.deepEqual(result.errors.map((issue) => issue.code), [
    "source_html.root",
    "spec.local_path",
    "page_kit.sdk_version.spec_unavailable",
    "page_kit.store_profile.spec_unavailable",
    "assembly.commerce_catalog.path",
    "identity.map_id",
    "identity.public_route_slug",
    "inputs.packet_path",
    "template_family.value",
    "decisions",
    "evidence",
    "blockers",
    "warnings",
  ]);
  assert.deepEqual((result.next_actions || []).map((action) => action.id), [
    "checkpoint.page_kit.sdk_version.repair_spec",
    "checkpoint.page_kit.store_profile.repair_spec",
    "doctor_recheck",
  ]);
  assert.equal(result.prompt, "Resolve the doctor errors above before continuing. Re-run `campaigns-os doctor --packet <path>` to confirm, then `campaigns-os next --packet <path>` to advance.");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Proof 3 — partial divergence: deploy URL only (ledger deploy pending,
// assembly/polish genuinely recorded, no verdict) yields exactly one
// divergence, and the recommendation points forward to QA — not re-setup.
// ---------------------------------------------------------------------------
test("partial divergence (deploy URL only) points forward to QA, not re-setup", () => {
  const { dir, packetPath } = doctorGreenFixture();
  const result = runNext(packetPath);

  assert.equal(result.stage, "deploy", "pickNextStage ordering is unchanged");
  assert.equal((result.divergences || []).length, 1, "exactly one divergence");
  assert.equal(result.divergences[0].code, "divergence.deploy.url_present");

  const inspect = (result.next_actions || []).find((action) => action.id === "divergence_inspect");
  assert.ok(inspect);
  assert.match(inspect.description, /forward path is QA/);
  assert.match(inspect.description, /campaigns-os next qa --packet/);
  assertNoStartOverRecommendation(result);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Proof 4 — purity: the same fixture at a different absolute path with
// rewritten mtimes yields a byte-identical divergence result. No cwd, no
// clock, no mtime participates.
// ---------------------------------------------------------------------------
test("divergence result is byte-identical across absolute paths and rewritten mtimes", () => {
  const first = selfTargetFixture({ builtOutput: true, deployUrlInReport: true, verdict: true, report: ledgerAllPending() });
  const second = selfTargetFixture({ builtOutput: true, deployUrlInReport: true, verdict: true, report: ledgerAllPending() });
  assert.notEqual(first.dir, second.dir, "fixtures must live at different absolute paths");

  // Rewrite mtimes/atimes on every artifact in the second copy to a
  // different era than the first.
  const past = new Date("2001-01-01T00:00:00.000Z");
  for (const relPath of [
    "campaign-runtime.build.json",
    ".campaign-runtime/assembly-report.json",
    `_site/${SLUG}`,
    `_site/${SLUG}/index.html`,
    `qa-output/${MAP_ID}`,
    `qa-output/${MAP_ID}/RUN1.json`,
  ]) {
    utimesSync(join(second.dir, relPath), past, past);
  }

  const reportFor = (dir) => JSON.parse(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"));
  const packetFor = (dir) => JSON.parse(readFileSync(join(dir, "campaign-runtime.build.json"), "utf8"));

  const directFirst = detectLedgerDivergence(reportFor(first.dir), packetFor(first.dir), first.dir);
  const directSecond = detectLedgerDivergence(reportFor(second.dir), packetFor(second.dir), second.dir);
  assert.equal(JSON.stringify(directFirst), JSON.stringify(directSecond), "detectLedgerDivergence must be a pure projection of repo contents");
  assert.equal(directFirst.length, 3);
  assert.doesNotMatch(JSON.stringify(directFirst), new RegExp(first.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "divergence evidence must not embed absolute paths");

  const fullFirst = runNext(first.packetPath);
  const fullSecond = runNext(second.packetPath);
  assert.equal(JSON.stringify(fullFirst.divergences), JSON.stringify(fullSecond.divergences), "next's divergences[] must be byte-identical across roots");
  rmSync(first.dir, { recursive: true, force: true });
  rmSync(second.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Second negative control — stale built output relative to its packet must
// NOT read as "satisfied": the divergence reports a disagreement to inspect
// and never asserts the stage is complete, regardless of artifact age.
// ---------------------------------------------------------------------------
test("stale built output diverges as a disagreement, never as completion", () => {
  const { dir, packetPath } = selfTargetFixture({ builtOutput: true });
  // Age the built output far behind the packet: if divergence detection ever
  // consulted freshness to claim satisfaction, this is the fixture that
  // would catch it.
  const past = new Date("2001-01-01T00:00:00.000Z");
  utimesSync(join(dir, "_site", SLUG, "index.html"), past, past);
  utimesSync(join(dir, "_site", SLUG), past, past);

  const result = runNext(packetPath);
  assert.equal((result.divergences || []).length, 1);
  const entry = result.divergences[0];
  assert.equal(entry.code, "divergence.assembly.built_output_present");
  // The entry reports disagreement — it never asserts completion or
  // satisfaction, and carries no status/satisfied field to that effect.
  assert.deepEqual(Object.keys(entry), ["code", "stage", "ledger_claim", "artifact_evidence", "message"]);
  assert.match(entry.message, /disagree/);
  assert.match(entry.message, /not proof the stage is complete/);
  assert.doesNotMatch(JSON.stringify(result.divergences), /satisfied/i);

  // And the stage ladder is untouched: nothing was resolved or written.
  const report = JSON.parse(readFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "utf8"));
  assert.equal(report.stages.assembly.status, "pending");
  rmSync(dir, { recursive: true, force: true });
});

// Proof 5 (behavioral, real campaign from audit doc 07) is manual and
// separately authorized; it is intentionally not automated here.

// ---------------------------------------------------------------------------
// Kilo review (#196, src/cli.mjs:5600 + :5604) — a divergent packet is a
// stop-and-reconcile state. The inspection action was previously emitted
// ALONGSIDE the stage-specific actions, so an agent handed a divergence could
// follow `doctor_recheck` / `deploy` / `qa_run` instead of inspecting — the
// same "fix doctor before advancing" instruction this packet exists to
// replace. These proofs pin the suppression by exact action list, so a future
// branch added below the divergence check cannot quietly reintroduce it.
// ---------------------------------------------------------------------------
test("doctor-blocked + divergence emits the inspection action ALONE — no doctor_recheck", () => {
  const { dir, packetPath } = selfTargetFixture({ builtOutput: true, deployUrlInReport: true, verdict: true });
  const result = runNext(packetPath);

  assert.equal(result.stage, "doctor-blocked", "fixture must reproduce the doctor-blocked shape");
  assert.ok((result.divergences || []).length > 0, "fixture must diverge");
  assert.deepEqual(
    (result.next_actions || []).map((action) => action.id),
    ["divergence_inspect"],
    "doctor_recheck must be suppressed — the doctor errors may themselves be artifacts of the stale ledger",
  );
  assertNoStartOverRecommendation(result);
  rmSync(dir, { recursive: true, force: true });
});

test("post-doctor divergence emits the inspection action ALONE — no deploy/advance/qa_run", () => {
  const { dir, packetPath } = doctorGreenFixture();
  const result = runNext(packetPath);

  assert.equal(result.stage, "deploy");
  assert.ok((result.divergences || []).length > 0, "fixture must diverge");
  assert.deepEqual(
    (result.next_actions || []).map((action) => action.id),
    ["divergence_inspect"],
    "stage actions must be suppressed — every one is derived from the same contradictory evidence",
  );
  // Nothing in the list may redo the disputed work.
  for (const action of result.next_actions || []) {
    assert.doesNotMatch(String(action.command || ""), /campaigns-os qa run|campaigns-os doctor/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the inspection action tells the agent the list is deliberately truncated", () => {
  const { dir, packetPath } = doctorGreenFixture();
  const inspect = (runNext(packetPath).next_actions || []).find((action) => action.id === "divergence_inspect");
  assert.ok(inspect);
  assert.match(inspect.description, /ONLY next action/, "an empty-looking action list must not read as a bug");
  assert.match(inspect.description, /Re-run `campaigns-os next --packet .+ --json`/, "must say how to get the normal list back");
  assert.equal(inspect.required, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a CLEAN packet is untouched by the suppression — stage actions still flow", () => {
  const { dir, packetPath } = selfTargetFixture();
  const result = runNext(packetPath);

  assert.equal((result.divergences || []).length, 0, "fixture must be clean");
  assert.deepEqual((result.next_actions || []).map((action) => action.id), [
    "checkpoint.page_kit.sdk_version.repair_spec",
    "checkpoint.page_kit.store_profile.repair_spec",
    "doctor_recheck",
  ]);
  rmSync(dir, { recursive: true, force: true });
});
