// `campaigns-os record <setup|build|polish>` over a real intake: prepare-build
// writes the Build Context and Assembly Report, and each record must move the
// stage `next` recommends without a hand edit — while writing nothing doctor
// would reject and stamping only the fingerprint doctor computes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { parseArgs, polishCaptureCommand } from "./cli.mjs";
import { resolveInvocationPolicy } from "./invocation.mjs";
import { recordStageCommand } from "./stage-record.mjs";
import { withTargetLockSync } from "./target-lock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const POLISH_EVIDENCE = join(ROOT, "fixtures/stage-record/polish-evidence.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function schemaValidator(file) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  return ajv.compile(readJson(join(ROOT, "schemas", file)));
}
const validReport = schemaValidator("campaign-runtime-assembly-report.v0.schema.json");
const validContext = schemaValidator("campaign-runtime-build-context.v0.schema.json");

function runCli(args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", ...env } });
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function runJson(args, cwd) {
  const result = runCli([...args, "--json"], cwd);
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

// A real prepare-build over the shipped example source and spec (SDK meta
// hints dropped, so a hand-written built page can satisfy doctor), with the
// prepare-build gate made terminal the way a cleared Design Source Package
// leaves it. The target has no campaign output directory yet.
function withLifecycle(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-record-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    const source = join(dir, "source");
    const target = join(dir, "target");
    const specPath = join(dir, "campaignspec.json");
    cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
    const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
    for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
    writeJson(specPath, spec);
    writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
    const prepared = runCli([
      "prepare-build", "--spec", specPath, "--source", source, "--target", target,
      "--template-family", "olympus", "--no-run-session", "--json",
    ], dir);
    assert.equal(prepared.status, 0, prepared.stderr);
    const packetPath = join(target, "campaign-runtime.build.json");
    const contextPath = join(target, ".campaign-runtime/build-context.json");
    const reportPath = join(target, ".campaign-runtime/assembly-report.json");
    const report = readJson(reportPath);
    report.stages.prepare_build.status = "completed";
    report.stages.prepare_build.blockers = [];
    report.blockers = [];
    report.status = "prepared";
    writeJson(reportPath, report);
    const packet = readJson(packetPath);
    const slug = packet.campaign.public_route_slug;
    result = run({ dir, target, packetPath, contextPath, reportPath, spec, packet, slug });
  } catch (error) {
    cleanup();
    throw error;
  }
  if (typeof result?.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

// What setup produces: the campaign output directory and its _data entry.
function scaffold(f) {
  mkdirSync(resolve(f.target, f.packet.assembly.output_dir), { recursive: true });
  const entry = Object.fromEntries([
    "store_name", "store_url", "store_terms", "store_privacy", "store_contact",
    "store_returns", "store_shipping", "store_phone", "store_phone_tel",
  ].map((field) => [field, f.spec.campaign[field]]));
  entry.sdk_version = f.spec.runtime?.sdk_version || f.spec.global_config?.sdk_version;
  writeJson(join(f.target, "_data/campaigns.json"), { [f.spec.campaign.slug]: entry });
}

// What page-kit build produces: one page per CampaignSpec page at its route.
function buildSite(f, marker = "") {
  for (const page of f.spec.funnels.flatMap((funnel) => funnel.pages)) {
    const route = String(page.page_url || "").replace(/^\/+|\/+$/g, "");
    const file = join(f.target, "_site", f.slug, route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><meta name="next-page-type" content="${page.type}"><title>${page.id}</title><script src="https://cdn.example.com/campaign-cart@v0.4.37/dist/loader.js"></script></head><body data-next-page="${page.id}"><h1>${page.id}${marker}</h1></body></html>\n`);
  }
}

// The stage `next` recommends; a doctor-blocked answer carries its errors so
// a failing assertion says which gate stopped the ladder.
function nextStage(f) {
  const { json } = runJson(["next", "--packet", f.packetPath, "--no-write"], f.dir);
  return { stage: json.stage === "doctor-blocked" ? `doctor-blocked: ${json.errors.map((issue) => `${issue.code} ${issue.message}`).join(" | ")}` : json.stage };
}
const doctor = (f) => runJson(["doctor", "--packet", f.packetPath], f.dir).json;
const record = (f, stage, extra = []) => runCli(["record", stage, "--packet", f.packetPath, ...extra], f.dir);

function recordOk(f, stage, extra = []) {
  const result = record(f, stage, [...extra, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// polish capture with a browser adapter standing in for Playwright: every
// route loads one small document, so the package-owned page_load passes.
async function capture(f) {
  const result = await polishCaptureCommand({
    _: ["polish", "capture"], packet: f.packetPath, "base-url": "http://127.0.0.1:4173",
  }, {
    createBrowserAdapter: async () => ({
      async captureRoute({ url, viewport }) {
        return {
          finalDocumentUrl: url,
          responseCollectionStatus: "complete",
          networkidle: { status: "settled", duration_ms: 25 },
          mediaElements: [],
          responses: [{
            request_id: `document-${viewport.key}`, url, resource_type: "Document", status: 200,
            mime_type: "text/html", encoded_data_length: 2_048, is_final_main_document: true,
            document_context_fingerprint: `sha256:${"d".repeat(64)}`,
          }],
        };
      },
      async close() {},
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems || result, null, 2));
}

function snapshotFiles(f) {
  return [f.contextPath, f.reportPath].map((path) => (existsSync(path) ? readFileSync(path, "utf8") : null));
}

test("record setup: next stops recommending setup, and both files validate (control: without it, next still says setup)", () => {
  withLifecycle((f) => {
    scaffold(f);
    // The negative control: the scaffold exists, nothing was hand-edited, and
    // `next` still recommends setup — the state the issue reports.
    assert.equal(nextStage(f).stage, "setup");

    const result = recordOk(f, "setup");
    assert.deepEqual(result.written, [f.contextPath, f.reportPath]);
    const context = readJson(f.contextPath);
    const report = readJson(f.reportPath);
    assert.equal(context.scaffold.required, false);
    assert.equal(report.stages.setup.status, "completed");
    assert.ok(validContext(context), JSON.stringify(validContext.errors));
    assert.ok(validReport(report), JSON.stringify(validReport.errors));
    assert.equal(nextStage(f).stage, "build");
  });
});

test("record build stamps exactly doctor's output fingerprint and next advances to polish", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    assert.equal(nextStage(f).stage, "build", "control: a built site alone does not move next");

    const before = doctor(f).derived.build_output_fingerprint;
    assert.equal(before.status, "missing");
    const result = recordOk(f, "build");
    const report = readJson(f.reportPath);
    assert.equal(result.build_fingerprint, before.value);
    assert.equal(report.stages.assembly.status, "completed");
    assert.equal(report.stages.assembly.build_fingerprint, before.value);
    assert.equal(report.stages.assembly.source_package_material_fingerprint, report.design_source_package.material_fingerprint);
    assert.equal(report.stages.polish.status, "required");
    assert.ok(validReport(report), JSON.stringify(validReport.errors));

    const after = doctor(f);
    assert.equal(after.derived.build_output_fingerprint.status, "pass");
    assert.equal(after.derived.build_output_fingerprint.value, report.stages.assembly.build_fingerprint);
    assert.equal(nextStage(f).stage, "polish");

    // A rebuild is one command again, not a hand edit.
    buildSite(f, " (rebuilt)");
    assert.equal(doctor(f).derived.build_output_fingerprint.status, "stale");
    recordOk(f, "build");
    assert.equal(doctor(f).derived.build_output_fingerprint.status, "pass");
  });
});

test("record polish binds the evidence file to the current build and next advances past polish", async () => {
  await withLifecycle(async (f) => {
      scaffold(f);
      recordOk(f, "setup");
      buildSite(f);
      recordOk(f, "build");
      await capture(f);
      assert.equal(nextStage(f).stage, "polish", "control: capture alone does not complete polish");

      const result = recordOk(f, "polish", ["--evidence", POLISH_EVIDENCE]);
      const report = readJson(f.reportPath);
      const polish = report.stages.polish;
      assert.equal(polish.status, "completed");
      assert.equal(polish.performed_by, "next-campaigns-polish");
      assert.equal(polish.source_build_fingerprint, report.stages.assembly.build_fingerprint);
      assert.equal(polish.source_build_fingerprint, result.build_fingerprint);
      assert.equal(polish.source_package_material_fingerprint, report.design_source_package.material_fingerprint);
      assert.equal(polish.evidence.visual_review.page_load.performed_by, "campaigns-os polish capture", "the captured page_load is kept");
      assert.ok(validReport(report), JSON.stringify(validReport.errors));

      const inspected = doctor(f);
      assert.equal(inspected.derived.polish_gate.status, "pass", JSON.stringify(inspected.derived.polish_gate));
      assert.equal(nextStage(f).stage, "deploy");
  });
});

test("record polish rejects repair_loop_defect given as a string, naming the field, and writes nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    const evidencePath = join(f.dir, "bad-evidence.json");
    writeJson(evidencePath, { ...readJson(POLISH_EVIDENCE), repair_loop_defect: "theme css loads before next-core" });
    const before = snapshotFiles(f);
    const result = record(f, "polish", ["--evidence", evidencePath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repair_loop_defect must be null or an object .*\(got string\)/);
    assert.match(result.stderr, /nothing was written/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

// Shapes only the schemas reject: the evidence-file reader and doctor's report
// checks both accept them, so these refusals come from schema validation alone.
test("record polish refuses a repair_loop_defect only the report schema rejects, naming the field, and writes nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    const report = readJson(f.reportPath);
    report.theme = { status: "applied", css_path: null, load_order: "after-next-core", commerce_pages: [], evidence: [] };
    writeJson(f.reportPath, report);
    const evidencePath = join(f.dir, "empty-code-evidence.json");
    writeJson(evidencePath, { ...readJson(POLISH_EVIDENCE), repair_loop_defect: { code: "" } });
    const before = snapshotFiles(f);
    const result = record(f, "polish", ["--evidence", evidencePath, "--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Assembly Report theme\.repair_loop_defect\.code must NOT have fewer than 1 characters/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

test("record setup refuses a Build Context only the context schema rejects, naming the field, and writes nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    const context = readJson(f.contextPath);
    delete context.scaffold.handoff_artifact;
    writeJson(f.contextPath, context);
    const before = snapshotFiles(f);
    const result = record(f, "setup");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build Context scaffold must have required property 'handoff_artifact'/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

// The ladder `next` walks: a record lands only on a stage `next` has reached.
test("record setup and record build refuse while next answers prepare-build on a non-binding blocker, writing nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    buildSite(f);
    const report = readJson(f.reportPath);
    report.stages.prepare_build.status = "blocked";
    report.stages.prepare_build.blockers = [{ code: "MISSING_SOURCE_PAGE", message: "a source page is missing" }];
    writeJson(f.reportPath, report);
    assert.equal(doctor(f).derived.prepare_build_gate.binding_failure === true, false, "control: not a binding failure");
    assert.equal(nextStage(f).stage, "prepare-build", "control: next answers prepare-build");
    const before = snapshotFiles(f);
    for (const stage of ["setup", "build"]) {
      const result = record(f, stage);
      assert.notEqual(result.status, 0, `record ${stage} must refuse`);
      assert.match(result.stderr, /next answers prepare-build: Stage "prepare_build" is blocked/, stage);
      assert.deepEqual(snapshotFiles(f), before, stage);
    }
  });
});

test("record build refuses while stages.setup is pending even when scaffold.required is false, writing nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    buildSite(f);
    const context = readJson(f.contextPath);
    context.scaffold.required = false;
    writeJson(f.contextPath, context);
    assert.equal(doctor(f).derived.scaffold_required, false, "control: doctor sees no scaffold owed");
    assert.equal(nextStage(f).stage, "setup", "control: next still answers setup");
    const before = snapshotFiles(f);
    const result = record(f, "build");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stages\.setup\.status is "pending", so next answers setup; run campaigns-os record setup first/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

test("record polish records a blocked or skipped Polish from the evidence file, and next keeps Polish blocked", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    const fingerprint = readJson(f.reportPath).stages.assembly.build_fingerprint;
    const file = (name, value) => {
      const path = join(f.dir, name);
      writeJson(path, value);
      return path;
    };

    const before = snapshotFiles(f);
    const noBlockers = record(f, "polish", ["--evidence", file("blocked-bare.json", { status: "blocked" })]);
    assert.notEqual(noBlockers.status, 0);
    assert.match(noBlockers.stderr, /blockers must be a non-empty array .* when status is blocked \(got undefined\)/);
    const noReason = record(f, "polish", ["--evidence", file("skipped-bare.json", { status: "skipped" })]);
    assert.notEqual(noReason.status, 0);
    assert.match(noReason.stderr, /skip_reason must be a non-empty string when status is skipped/);
    assert.deepEqual(snapshotFiles(f), before);

    const blocker = { code: "polish.capture_failed", message: "polish capture could not load the checkout route" };
    recordOk(f, "polish", ["--evidence", file("blocked.json", { status: "blocked", blockers: [blocker] })]);
    const blocked = readJson(f.reportPath).stages.polish;
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.blockers, [blocker]);
    assert.equal(blocked.source_build_fingerprint, fingerprint);
    assert.equal(blocked.completed_at, undefined);
    assert.ok(validReport(readJson(f.reportPath)), JSON.stringify(validReport.errors));
    assert.equal(doctor(f).derived.polish_gate.code, "polish.blocked");
    assert.equal(nextStage(f).stage, "polish");

    recordOk(f, "polish", ["--evidence", file("skipped.json", { status: "skipped", skip_reason: "operator deferred polish to a later run" })]);
    const skipped = readJson(f.reportPath).stages.polish;
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.skip_reason, "operator deferred polish to a later run");
    assert.deepEqual(skipped.blockers, []);
    assert.ok(validReport(readJson(f.reportPath)), JSON.stringify(validReport.errors));
    assert.equal(nextStage(f).stage, "polish");
  });
});

test("record polish refuses evidence the polish gate would reject, naming the missing field, and writes nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    const evidence = readJson(POLISH_EVIDENCE);
    delete evidence.evidence.brand_review;
    const evidencePath = join(f.dir, "incomplete-evidence.json");
    writeJson(evidencePath, evidence);
    const before = snapshotFiles(f);
    const result = record(f, "polish", ["--evidence", evidencePath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /polish\.evidence_incomplete/);
    assert.match(result.stderr, /stages\.polish\.evidence\.brand_review is missing or incomplete/);
    // No capture ran either, so the capture the checkpoint owes is named too.
    assert.match(result.stderr, /required action: campaigns-os polish capture/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

test("record build refuses when doctor cannot compute a fingerprint, and a missing packet, writing nothing", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    const before = snapshotFiles(f);
    const noSite = record(f, "build");
    assert.notEqual(noSite.status, 0);
    assert.match(noSite.stderr, /cannot compute the build output fingerprint/);
    const noPacket = runCli(["record", "build", "--packet", join(f.dir, "missing.json")], f.dir);
    assert.notEqual(noPacket.status, 0);
    assert.match(noPacket.stderr, /Build Packet not found/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

// Doctor refuses the binding (next answers prepare-build with
// next.prepare_build.report_campaign_mismatch), so no record may land on the
// report, whatever the stage.
test("every record refuses a report bound to another campaign, naming doctor's binding code, and writes nothing", async () => {
  await withLifecycle(async (f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    await capture(f);
    const report = readJson(f.reportPath);
    report.identity.public_route_slug = "foreign-campaign";
    writeJson(f.reportPath, report);
    assert.equal(doctor(f).derived.prepare_build_gate.binding_failure, true, "control: doctor refuses this binding");
    const before = snapshotFiles(f);
    for (const [stage, extra] of [["setup", []], ["build", []], ["polish", ["--evidence", POLISH_EVIDENCE]]]) {
      const result = record(f, stage, extra);
      assert.notEqual(result.status, 0, `record ${stage} must refuse`);
      assert.match(result.stderr, /next\.prepare_build\.report_campaign_mismatch/, stage);
      assert.match(result.stderr, /nothing was written/, stage);
      assert.deepEqual(snapshotFiles(f), before, stage);
    }
  });
});

// A packet with no Design Source Package has no prepare-build binding gate;
// the producers' identity match still keeps a record off another campaign's
// report.
test("record setup refuses another campaign's report for a packet without a Design Source Package", () => {
  withLifecycle((f) => {
    scaffold(f);
    const packet = readJson(f.packetPath);
    delete packet.design_source_package;
    writeJson(f.packetPath, packet);
    const report = readJson(f.reportPath);
    report.identity.public_route_slug = "foreign-campaign";
    writeJson(f.reportPath, report);
    assert.equal(doctor(f).derived.prepare_build_gate?.binding_failure === true, false, "control: no binding gate without a Design Source Package");
    const before = snapshotFiles(f);
    const result = record(f, "setup");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /report_campaign_mismatch: Assembly Report campaign identity does not match/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});

// A writer holding the target lock rebuilds the output while record build
// waits for the lock: the record must stamp the output as it is once the lock
// is free, the fingerprint doctor then computes.
test("record build reads doctor's fingerprint under the target lock: a locked writer's rebuild is what gets recorded", async () => {
  await withLifecycle(async (f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    const held = join(f.dir, "lock-held");
    const released = join(f.dir, "lock-released");
    const rebuilt = join(f.target, "_site", f.slug, "index.html");
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync, appendFileSync } from "node:fs";
      import { withTargetLockSync } from ${JSON.stringify(pathToFileURL(join(ROOT, "src/target-lock.mjs")).href)};
      withTargetLockSync(${JSON.stringify(f.target)}, () => {
        writeFileSync(${JSON.stringify(held)}, "");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        appendFileSync(${JSON.stringify(rebuilt)}, "<!-- rebuilt while the lock was held -->\\n");
      }, { command: "test holder" });
      writeFileSync(${JSON.stringify(released)}, "");
    `], { stdio: "ignore" });
    const exited = new Promise((resolveExit) => holder.on("exit", resolveExit));
    while (!existsSync(held)) await new Promise((wake) => setTimeout(wake, 20));

    const result = recordOk(f, "build");
    assert.equal(existsSync(released), true, "record build waited for the holder to release the lock");
    assert.equal(await exited, 0);
    const after = doctor(f).derived.build_output_fingerprint;
    assert.equal(after.status, "pass");
    assert.equal(result.build_fingerprint, after.value);
    assert.equal(readJson(f.reportPath).stages.assembly.build_fingerprint, after.value);
  });
});

// A locked writer rebinds the Build Context's report_path after record was
// invoked and before it holds the target lock: the record must land in the
// report bound once it holds the lock (the one `next` reads), and the report
// bound at invocation must keep its bytes.
test("record setup and build resolve the report under the target lock: a rebind while waiting records into the report now bound, never the old one", () => {
  withLifecycle((f) => {
    scaffold(f);
    const rebind = (name) => () => withTargetLockSync(f.target, () => {
      const context = readJson(f.contextPath);
      writeJson(join(f.target, ".campaign-runtime", name), readJson(resolve(f.target, context.report_path)));
      context.report_path = `.campaign-runtime/${name}`;
      writeJson(f.contextPath, context);
    }, { command: "test rebind" });

    const invoked = readFileSync(f.reportPath, "utf8");
    const setupReport = join(f.target, ".campaign-runtime/rebound-setup.json");
    const setup = recordStageCommand(parseArgs(["record", "setup", "--packet", f.packetPath]), { beforeLock: rebind("rebound-setup.json") });
    assert.equal(setup.report_path, setupReport);
    assert.equal(readJson(setupReport).stages.setup.status, "completed");
    assert.equal(readFileSync(f.reportPath, "utf8"), invoked, "the report bound at invocation is untouched");
    assert.equal(nextStage(f).stage, "build");

    buildSite(f);
    const setupBytes = readFileSync(setupReport, "utf8");
    const buildReport = join(f.target, ".campaign-runtime/rebound-build.json");
    const build = recordStageCommand(parseArgs(["record", "build", "--packet", f.packetPath]), { beforeLock: rebind("rebound-build.json") });
    assert.equal(build.report_path, buildReport);
    assert.equal(readJson(buildReport).stages.assembly.build_fingerprint, doctor(f).derived.build_output_fingerprint.value);
    assert.equal(readFileSync(setupReport, "utf8"), setupBytes, "the report bound at invocation is untouched");
    assert.equal(nextStage(f).stage, "polish");
  });
});

// An unlocked writer (a page-kit build) changes the output after doctor read
// it: the record refuses rather than stamp a fingerprint doctor would call
// stale.
test("record build refuses, writing nothing, when the output changes between doctor's read and the write", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    const before = snapshotFiles(f);
    assert.throws(
      () => recordStageCommand(parseArgs(["record", "build", "--packet", f.packetPath]), {
        afterDoctorRead: () => buildSite(f, " (rebuilt mid-record)"),
      }),
      /record build refused; nothing was written:\n- The built output changed while recording/,
    );
    assert.deepEqual(snapshotFiles(f), before);
    assert.equal(doctor(f).derived.build_output_fingerprint.status, "missing");
  });
});

test("record --dry-run runs every check and writes nothing; an unknown flag is refused before anything, journal included", () => {
  withLifecycle((f) => {
    scaffold(f);
    const before = snapshotFiles(f);
    const dry = recordOk(f, "setup", ["--dry-run"]);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.would_write, [f.contextPath, f.reportPath]);
    assert.deepEqual(snapshotFiles(f), before);

    const journal = join(f.dir, "lifecycle.jsonl");
    const unknown = record(f, "setup", ["--status", "completed", "--lifecycle-journal", journal]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown flag for record setup: --status/);
    assert.equal(existsSync(journal), false);
    assert.deepEqual(snapshotFiles(f), before);
    assert.equal(nextStage(f).stage, "setup");
  });
});

// D1: `build` (the intake alias) and `polish` keep their meaning. `record` is
// its own command, so neither existing command gains a subcommand: the
// issue's `build record` / `polish record` spellings reach the handlers they
// reached before, under the policy they had before.
test("existing build and polish argument forms keep their policy and their refusals", () => {
  withLifecycle((f) => {
    for (const [argv, bare] of [
      [["build", "record", "--packet", f.packetPath], ["build", "--packet", f.packetPath]],
      [["polish", "record", "--packet", f.packetPath], ["polish", "--packet", f.packetPath]],
      [["polish", "capture", "--packet", f.packetPath, "--dry-run"], ["polish", "capture", "--packet", f.packetPath]],
    ]) {
      const args = parseArgs(argv);
      const baseline = parseArgs(bare);
      const { implementsDryRun, ...policy } = resolveInvocationPolicy(args._[0], args);
      const { implementsDryRun: baselineDryRun, ...baselinePolicy } = resolveInvocationPolicy(baseline._[0], baseline);
      assert.deepEqual(policy, baselinePolicy, argv.join(" "));
      assert.equal(implementsDryRun, false);
      assert.equal(baselineDryRun, false);
    }
    const before = snapshotFiles(f);
    const polishRecord = runCli(["polish", "record", "--packet", f.packetPath], f.dir);
    assert.equal(polishRecord.status, 1);
    assert.match(polishRecord.stderr, /Unknown polish subcommand\. Use: campaigns-os polish capture --packet/);
    const buildRecord = runCli(["build", "record", "--packet", f.packetPath, "--no-run-session"], f.dir);
    assert.equal(buildRecord.status, 1);
    assert.match(buildRecord.stderr, /Either --spec <path> or --map-id <id> is required/);
    assert.deepEqual(snapshotFiles(f), before);
  });
});
