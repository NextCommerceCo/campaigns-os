// `campaigns-os record <setup|build|polish>` over a real intake: prepare-build
// writes the Build Context and Assembly Report, and each record must move the
// stage `next` recommends without a hand edit — while writing nothing doctor
// would reject and stamping only the fingerprint doctor computes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { parseArgs, polishCaptureCommand } from "./cli.mjs";
import { resolveInvocationPolicy } from "./invocation.mjs";
import { recordCommand, recordStageCommand } from "./stage-record.mjs";
import { withTargetLockSync } from "./target-lock.mjs";
import { readdirSync } from "node:fs";
import {
  INPUT_WARNING_CODES,
  STAGE_KEYS,
  SHA256_PATTERN,
  assertNothingWritten,
  assertRecordRefusal,
  briefJsonOfSize,
  briefWithDesignAuthorityEntries,
  connectedHosts,
  reverseKeys,
  sha256File,
  treeDigest,
  withNetworkGuard,
} from "./input-test-factories.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const POLISH_EVIDENCE = join(ROOT, "fixtures/stage-record/polish-evidence.json");
// Rows that record Polish after an input change and then need Polish current
// read the capture time on page_load (captured_at), which polish capture does
// not write yet. Until it does they carry the node:test `todo` option.
const CLOSES_AFTER_D = { todo: "needs page_load.captured_at from polish capture" };

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
function withLifecycle(run, { mutateSpec = null } = {}) {
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
    if (mutateSpec) mutateSpec(spec);
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

// What page-kit build produces: one page per CampaignSpec page at its route,
// with whatever stylesheet links `head` gives that page.
function buildSite(f, marker = "", head = () => "") {
  for (const page of f.spec.funnels.flatMap((funnel) => funnel.pages)) {
    const route = String(page.page_url || "").replace(/^\/+|\/+$/g, "");
    const file = join(f.target, "_site", f.slug, route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><meta name="next-page-type" content="${page.type}"><title>${page.id}</title>${head(page)}<script src="https://cdn.example.com/campaign-cart@v0.4.37/dist/loader.js"></script></head><body data-next-page="${page.id}"><h1>${page.id}${marker}</h1></body></html>\n`);
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

// A recorded build whose theme gate is blocked the way a generatable brand
// theme leaves it, with the stylesheets each commerce page links set by
// `links`.
function themeReady(f, links) {
  scaffold(f);
  recordOk(f, "setup");
  const context = readJson(f.contextPath);
  context.theme.generated.can_generate = true;
  writeJson(f.contextPath, context);
  const report = readJson(f.reportPath);
  report.theme = { ...report.theme, status: "needs_review" };
  writeJson(f.reportPath, report);
  const css = join(f.target, "_site", f.slug, "css");
  mkdirSync(css, { recursive: true });
  writeFileSync(join(css, "next-core.css"), ":root {}\n");
  writeFileSync(join(css, "brand-theme.css"), ":root { --brand--color--primary: #0a2540; }\n");
  const tag = (name) => `<link rel="stylesheet" href="${name.includes("//") ? name : `/${f.slug}/css/${name}`}">`;
  buildSite(f, "", (page) => (page.type === "landing" ? "" : links(page).map(tag).join("")));
  recordOk(f, "build");
}

test("record theme records the brand layer each commerce page that loads next-core.css loads after it, and the theme gate passes", () => {
  withLifecycle((f) => {
    // The receipt is the design's own markup: neither stylesheet, so no brand layer is owed there.
    themeReady(f, (page) => (page.type === "thankyou" ? [] : ["next-core.css", "brand-theme.css"]));
    assert.equal(doctor(f).derived.theme_gate.code, "theme_gate.generatable_not_applied", "control: the gate blocks before the record");

    const result = recordOk(f, "theme");
    const theme = readJson(f.reportPath).theme;
    assert.equal(theme.status, "applied");
    assert.equal(theme.load_order, "after-next-core");
    assert.equal(theme.css_path, `_site/${f.slug}/css/brand-theme.css`);
    assert.deepEqual(theme.commerce_pages, ["checkout", "upsell"]);
    assert.ok(theme.evidence.some((line) => line.startsWith("receipt: ") && line.includes("loads neither")), theme.evidence.join("\n"));
    assert.deepEqual(result.record, theme);
    assert.ok(validReport(readJson(f.reportPath)), JSON.stringify(validReport.errors));
    assert.equal(doctor(f).derived.theme_gate.code, "theme_gate.applied");
  });
});

test("record theme refuses, naming each page and writing nothing, when a commerce page loads the brand layer before next-core.css, not at all, or from another origin", () => {
  withLifecycle((f) => {
    themeReady(f, (page) => (page.id === "checkout"
      ? ["brand-theme.css", "next-core.css"]
      : page.id === "upsell" ? ["next-core.css"] : ["next-core.css", "https://cdn.example.com/brand-theme.css"]));
    const before = readFileSync(f.reportPath, "utf8");

    const result = record(f, "theme");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checkout: .* links \/[^ ]+\/brand-theme\.css before next-core\.css/);
    assert.match(result.stderr, /upsell: .* links no brand layer/);
    assert.match(result.stderr, /receipt: .* loads its brand layer from another origin/);
    assert.equal(readFileSync(f.reportPath, "utf8"), before);
    assert.equal(doctor(f).derived.theme_gate.code, "theme_gate.generatable_not_applied");
  });
});

// Build and polish recorded on a local-serve packet: the state `record
// deploy` records from.
async function deployReady(f) {
  const packet = readJson(f.packetPath);
  packet.deploy = { ...packet.deploy, target: "local-serve" };
  writeJson(f.packetPath, packet);
  scaffold(f);
  recordOk(f, "setup");
  buildSite(f);
  recordOk(f, "build");
  await capture(f);
  recordOk(f, "polish", ["--evidence", POLISH_EVIDENCE]);
}

// A static server over the built _site/, the way a local preview serves it.
// `redirect` sends one page elsewhere: { page, to }.
async function serveSite(f, redirect = null) {
  const root = join(f.target, "_site");
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://local").pathname);
    if (redirect && path.endsWith(`/${redirect.page}/`)) {
      response.writeHead(302, { location: redirect.to });
      response.end();
      return;
    }
    const file = join(root, path, path.endsWith("/") ? "index.html" : "");
    const found = existsSync(file) && statSync(file).isFile();
    response.writeHead(found ? 200 : 404, { "content-type": "text/html" });
    response.end(found ? readFileSync(file) : "");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/${f.slug}/`, close: () => new Promise((done) => server.close(done)) };
}

test("record deploy records the served local preview on the packet and stages.deploy, and next moves past deploy", async () => {
  await withLifecycle(async (f) => {
    await deployReady(f);
    assert.equal(nextStage(f).stage, "deploy", "control: next stops at deploy before the record");
    const site = await serveSite(f);
    try {
      const dry = await recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": `${site.url}index.html`, "dry-run": true });
      assert.equal(dry.status, "dry_run", "an index.html base URL names the same route root");
      const result = await recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": site.url });
      assert.deepEqual(result.written, [f.packetPath, f.reportPath]);
      assert.equal(readJson(f.packetPath).deploy.preview_url, site.url);
      const deploy = readJson(f.reportPath).stages.deploy;
      assert.equal(deploy.status, "completed");
      assert.deepEqual(deploy.outputs, [site.url]);
      assert.equal(deploy.evidence.length, f.spec.funnels.flatMap((funnel) => funnel.pages).length);
      assert.ok(validReport(readJson(f.reportPath)), JSON.stringify(validReport.errors));
      assert.equal(nextStage(f).stage, "qa");
    } finally {
      await site.close();
    }
  });
});

test("record deploy refuses, writing nothing, a non-loopback URL, the wrong route root, a redirect off the preview, or a preview that does not answer", async () => {
  await withLifecycle(async (f) => {
    await deployReady(f);
    const before = [readFileSync(f.packetPath, "utf8"), readFileSync(f.reportPath, "utf8")];
    const deploy = (url) => recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": url });

    await assert.rejects(deploy(`https://preview.example.test/${f.slug}/`), /not a loopback address/);
    const site = await serveSite(f);
    await assert.rejects(deploy(new URL("/", site.url).href), /route root is \/[^ ]+\//);
    await site.close();
    // A redirect elsewhere is reported, never followed: the probe stays on the preview.
    const redirecting = await serveSite(f, { page: "checkout", to: "http://127.0.0.1:9/elsewhere/" });
    await assert.rejects(deploy(redirecting.url), /checkout\/: redirects to http:\/\/127\.0\.0\.1:9\/elsewhere\/, off this preview/);
    await redirecting.close();
    await assert.rejects(deploy(site.url), /checkout\/: .*\n.*record deploy again|record deploy again/s);
    assert.deepEqual([readFileSync(f.packetPath, "utf8"), readFileSync(f.reportPath, "utf8")], before);
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

test("record build --build-environment records stages.assembly.evidence.build_environment, so local proof needs no hand edit", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    const refused = record(f, "build", ["--build-environment", "dev", "--dry-run"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--build-environment must be one of: development, production \(got "dev"\)/);

    const result = recordOk(f, "build", ["--build-environment", "development"]);
    assert.equal(result.record.evidence.build_environment, "development");
    const report = readJson(f.reportPath);
    assert.equal(report.stages.assembly.evidence.build_environment, "development");
    assert.ok(validReport(report), JSON.stringify(validReport.errors));

    // A later record build without the flag keeps what was recorded.
    recordOk(f, "build");
    assert.equal(readJson(f.reportPath).stages.assembly.evidence.build_environment, "development");
  });
});

test("a record refused for a value outside a schema enum lists the allowed values", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    const report = readJson(f.reportPath);
    report.adapter_decisions = { ...report.adapter_decisions, wrapper_policy: "strip" };
    writeJson(f.reportPath, report);
    const result = record(f, "build", ["--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /adapter_decisions\.wrapper_policy must be equal to one of the allowed values: "strip_document_wrappers", "preserve_document_wrappers", "not_required", "unknown" \(got "strip"\)/);
  });
});

test("every record subcommand accepts --deviation-reason, the flag the deviation notice tells agents to declare", () => {
  // The notice ("Declare intent with --deviation-reason") reaches agents from
  // the tracked commands; record refused the flag as unknown on every stage.
  withLifecycle((f) => {
    scaffold(f);
    const result = record(f, "setup", ["--deviation-reason", "recording setup by hand", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    for (const stage of ["build", "polish", "theme", "deploy"]) {
      const refused = record(f, stage, ["--deviation-reason", "why", "--dry-run"]);
      assert.doesNotMatch(refused.stderr, /Unknown flag/, stage);
    }
    const empty = record(f, "setup", ["--deviation-reason", "--dry-run"]);
    assert.notEqual(empty.status, 0, "a bare --deviation-reason is refused like any value flag");
  });
});

test("on the local preview, record deploy follows next past a polish it carries forward", async () => {
  // next skips a missing polish on the local preview (local-preview-policy:
  // carried forward as a warning), so after record build it answers deploy.
  // record deploy's ladder must read the same rule, or it refuses the stage
  // next just named.
  await withLifecycle(async (f) => {
    const packet = readJson(f.packetPath);
    packet.deploy = { ...packet.deploy, target: "local-serve" };
    writeJson(f.packetPath, packet);
    scaffold(f);
    recordOk(f, "setup");
    buildSite(f);
    recordOk(f, "build");
    assert.equal(readJson(f.reportPath).stages.polish.status, "required");
    assert.equal(doctor(f).derived.polish_gate.status, "carried_forward");
    assert.equal(nextStage(f).stage, "deploy", "next carries the missing polish forward");
    const site = await serveSite(f);
    try {
      const result = await recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": site.url });
      assert.equal(readJson(f.reportPath).stages.deploy.status, "completed", JSON.stringify(result));
      assert.equal(readJson(f.reportPath).stages.polish.status, "required", "polish stays owed; nothing recorded it");
    } finally {
      await site.close();
    }
  });
});

test("doctor and next name a CampaignSpec edited materially after prepare-build, as QA would refuse it", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    const codes = (result) => (result.warnings || []).map((issue) => issue.code);
    assert.ok(f.packet.spec.local_spec_id != null, "a local-spec packet, the kind QA checks");
    assert.ok(!codes(doctor(f)).includes("spec.material_stale"), "control: the spec prepare-build bound");

    const specPath = join(f.dir, "campaignspec.json");
    const spec = readJson(specPath);
    const checkout = spec.funnels.flatMap((funnel) => funnel.pages).find((page) => page.type === "checkout");
    assert.ok(checkout?.packages?.[0] != null, "the example spec has a checkout package, so a material edit is observable");
    checkout.packages[0].qty = Number(checkout.packages[0].qty ?? 1) + 1;
    writeJson(specPath, spec);

    const after = doctor(f);
    const warning = after.warnings.find((issue) => issue.code === "spec.material_stale");
    assert.ok(warning, JSON.stringify(codes(after)));
    assert.equal(warning.message, "CampaignSpec material changed since it was bound; run `record spec` (keeps history). `prepare-build --force` resets every stage and archives their records.");
    assert.equal(warning.detail.bound_material_hash, readJson(f.reportPath).identity.spec_material_hash);
    assert.match(warning.detail.current_material_hash, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(warning.detail.current_material_hash, warning.detail.bound_material_hash);
    const { json } = runJson(["next", "--packet", f.packetPath, "--no-write"], f.dir);
    assert.ok((json.warnings || []).some((issue) => issue.code === "spec.material_stale"), "next shows it before QA does");

    // record spec binds the edited spec: the warning clears.
    const refreshed = runJson(["record", "spec", "--packet", f.packetPath], f.dir);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.json.outcome, "refreshed");
    assert.ok(!codes(doctor(f)).includes("spec.material_stale"), "the refreshed binding is current");
  }, {
    // A local-spec campaign, the kind QA checks the material hash for.
    mutateSpec(spec) {
      spec.spec_identity = { local_spec_id: "record-local-demo", public_route_slug: spec.spec_identity.public_route_slug };
      delete spec.map_id;
    },
  });
});

test("doctor names a saved-Map campaign's cached CampaignSpec edited materially after prepare-build", () => {
  withLifecycle((f) => {
    scaffold(f);
    recordOk(f, "setup");
    const codes = (result) => (result.warnings || []).map((issue) => issue.code);
    assert.ok(f.packet.spec.map_id, "a saved-Map packet");
    assert.ok(!codes(doctor(f)).includes("spec.material_stale"), "control: the spec prepare-build bound");
    const specPath = join(f.dir, "campaignspec.json");
    const spec = readJson(specPath);
    const checkout = spec.funnels.flatMap((funnel) => funnel.pages).find((page) => page.type === "checkout");
    checkout.packages[0].qty = Number(checkout.packages[0].qty ?? 1) + 1;
    writeJson(specPath, spec);
    const after = doctor(f);
    assert.ok(codes(after).includes("spec.material_stale"), JSON.stringify(codes(after)));
    assert.equal(after.derived.input_currency.spec.snapshot_material, "owed");
    assert.equal(after.derived.input_currency.spec.remote_currency, "unconfirmed");
  });
});

// ---------------------------------------------------------------------------
// Rows over this lifecycle: Brief answers
// persist (F2.1-*) and Spec refresh (F2.2-*) through the CLI, plus the node rows
// whose setup needs a recorded campaign (F2.1-W28, B15, B25, I17; F2.2-B8).
//
// Each row runs under withNetworkGuard (src/input-test-factories.mjs): every
// child CLI process gets the guard through NODE_OPTIONS before any Campaigns
// OS module loads in it, and the in-process calls (polish capture with its
// stand-in browser, record deploy with a stand-in fetch, the QA stage write)
// run under the in-process guard; any attempt fails the row. Modules this
// file did not already import are imported inside the row that needs them,
// so a missing module or export fails that row alone.
//
// API assumptions:
// - `record brief|spec --json` prints one JSON object whose `outcome` is the
//   outcome name (unchanged | saved | saved_with_invalidation | refreshed);
//   with --dry-run the object also carries `dry_run: true`.
// - The `binding_unknown` notice is an entry of that object's `notices`
//   array: {code: "binding_unknown", stages: [<stage to re-record>, ...]}.
// - `input_currency` is read from `doctor --no-live-refs --json`
//   `derived.input_currency`.
// - The QA stage write is recordQaStageOutcome (src/cli.mjs:690), fed the
//   verdict `qa run` produces; its qa brief stamp is the verdict's
//   `source_brief_material` and its spec stamp the verdict's `spec_hash`.
// - Refusals: assertRecordRefusal (src/input-test-factories.mjs).
// - What a refusal or an `unchanged` outcome writes (nothing): every file
//   under the fixture directory (the target, which
//   holds the packet, context, report, normalized brief, doctor sidecar and
//   progress snapshots; the source; the spec; the brief file) is byte-compared
//   before and after. A refused record brief|spec also runs with a lifecycle
//   journal selected inside that directory, so a journal line is seen too.
//   The existing ladder refusal of `record polish` (F2.1-B3) appends its
//   lifecycle entry to a selected journal, as every `record` handler refusal
//   does, so no journal is selected there.

const LOCAL_SPEC = Object.freeze({
  // A local-spec campaign, as in the #591 test above.
  mutateSpec(spec) {
    spec.spec_identity = { local_spec_id: "record-local-demo", public_route_slug: spec.spec_identity.public_route_slug };
    delete spec.map_id;
  },
});
const OPERATOR_DECISION = "operator: the change needs no markup change";
const SKIPPED_POLISH = Object.freeze({ status: "skipped", skip_reason: "operator: no Polish pass for this change" });
const TERMINAL_STATUSES = Object.freeze(["completed", "completed_with_warnings", "completed_partial", "skipped"]);

const guardedLifecycle = (run, options) => withNetworkGuard(() => withLifecycle(run, options));
const specPathOf = (f) => join(f.dir, "campaignspec.json");
const briefFileOf = (f, root = f.target) => join(root, "campaign-build-brief.json");
const normalizedOf = (f) => join(f.target, ".campaign-runtime/input/campaign-build-brief.normalized.json");

function stageStatuses(f, keys = STAGE_KEYS) {
  const { stages } = readJson(f.reportPath);
  return Object.fromEntries(keys.map((key) => [key, stages[key]?.status]));
}

function mutateJson(path, mutate) {
  const value = readJson(path);
  mutate(value);
  writeJson(path, value);
  return value;
}

// The guided draft intake wrote, with its two open questions answered. The
// template_residue_policy.block_placeholders default is left out, so a later
// save can write it explicitly (F2.1-W22).
function answeredDraft(f) {
  const brief = readJson(normalizedOf(f));
  brief.brand.cta_style = "solid dark button";
  brief.offer_presentation.bundle_cards.primary_price = "discounted_unit_price";
  delete brief.template_residue_policy.block_placeholders;
  return brief;
}

function recordInput(f, kind, extra = [], env = {}) {
  return runCli(["record", kind, "--packet", f.packetPath, ...extra, "--json"], f.dir, env);
}

// An `unchanged` outcome writes nothing, so every
// stage status is kept and no file under the fixture directory changes.
function recordInputOk(f, kind, outcome, extra = []) {
  const before = outcome === "unchanged" ? { files: treeDigest(f.dir), statuses: stageStatuses(f) } : null;
  const result = recordInput(f, kind, extra);
  assert.equal(result.status, 0, `record ${kind} exits 0: ${result.stderr.slice(0, 600)}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.outcome, outcome, `record ${kind} outcome: ${result.stdout.slice(0, 600)}`);
  if (before) {
    assert.deepEqual(stageStatuses(f), before.statuses, `record ${kind} reading unchanged keeps every stage status`);
    assertNothingWritten(f.dir, before.files, `record ${kind} reading unchanged`);
  }
  return json;
}

// A refused record brief|spec: the exact refusal code, and no file under the
// fixture directory written. No lifecycle journal is selected: the journal line
// belongs to the standard invocation wrapper, as for every other refusal.
function assertRefusedWritingNothing(f, kind, code, extra = []) {
  const before = treeDigest(f.dir);
  assertRecordRefusal(recordInput(f, kind, extra), kind, code);
  assertNothingWritten(f.dir, before, `the refused record ${kind}`);
}

// Writes `brief` as the target's campaign-build-brief.json, then saves it.
function saveBrief(f, brief, outcome = "saved_with_invalidation") {
  writeJson(briefFileOf(f), brief);
  return recordInputOk(f, "brief", outcome);
}

function doctorOk(f, extra = []) {
  const result = runJson(["doctor", "--packet", f.packetPath, "--no-live-refs", ...extra], f.dir);
  assert.ok(result.json && typeof result.json === "object", `doctor --json printed its result: ${result.stderr.slice(0, 400)}`);
  return result.json;
}

function nextOk(f, extra = ["--no-write"]) {
  const result = runJson(["next", "--packet", f.packetPath, ...extra], f.dir);
  assert.ok(result.json && typeof result.json === "object", `next --json printed its result: ${result.stderr.slice(0, 400)}`);
  return result.json;
}

function inputCurrency(f) {
  const currency = doctorOk(f).derived?.input_currency;
  assert.ok(currency && typeof currency === "object" && !Array.isArray(currency), "doctor --json reports derived.input_currency");
  return currency;
}

const inputWarnings = (doctorJson) => [...new Set((doctorJson.warnings || []).map((issue) => issue.code).filter((code) => INPUT_WARNING_CODES.includes(code)))].sort();

function editSpec(f, mutate) {
  return mutateJson(specPathOf(f), mutate);
}

function bumpCheckoutQty(spec) {
  const checkout = spec.funnels.flatMap((funnel) => funnel.pages).find((page) => page.type === "checkout");
  assert.ok(checkout?.packages?.[0] != null, "setup: the example spec has a checkout package");
  checkout.packages[0].qty = Number(checkout.packages[0].qty ?? 1) + 1;
}

// Intake re-run with withLifecycle's arguments (plus `extra`), then the
// prepare-build gate cleared exactly as withLifecycle clears it.
function reintake(f, extra = []) {
  const result = runCli([
    "prepare-build", "--spec", specPathOf(f), "--source", join(f.dir, "source"), "--target", f.target,
    "--template-family", "olympus", "--no-run-session", ...extra, "--json",
  ], f.dir);
  assert.equal(result.status, 0, `setup: intake re-run succeeds: ${result.stderr.slice(0, 600)}`);
  mutateJson(f.reportPath, (report) => {
    report.stages.prepare_build.status = "completed";
    report.stages.prepare_build.blockers = [];
    report.blockers = [];
    report.status = "prepared";
  });
  return result;
}

// Intake re-run with a brief file in the target, so the context records the
// brief path record spec re-derives from.
function reintakeWithBrief(f) {
  writeJson(briefFileOf(f), answeredDraft(f));
  reintake(f);
  const recorded = readJson(f.contextPath).build_brief?.input_path;
  assert.ok(recorded, "setup: the Build Context records the brief path intake used");
  assert.equal(resolve(f.target, recorded), resolve(briefFileOf(f)), "setup: the recorded brief path is the brief file");
}

function writeEvidence(f, name, value) {
  const path = join(f.dir, name);
  writeJson(path, value);
  return path;
}

// setup, build and Polish recorded, the way the record tests above do it.
async function recordThroughPolish(f) {
  scaffold(f);
  recordOk(f, "setup");
  buildSite(f);
  recordOk(f, "build");
  await capture(f);
  recordOk(f, "polish", ["--evidence", POLISH_EVIDENCE]);
  assert.deepEqual(stageStatuses(f, ["setup", "assembly", "polish"]), { setup: "completed", assembly: "completed", polish: "completed" }, "setup: setup, build and Polish are recorded");
}

function recordThroughBuild(f) {
  scaffold(f);
  recordOk(f, "setup");
  buildSite(f);
  recordOk(f, "build");
  assert.deepEqual(stageStatuses(f, ["setup", "assembly"]), { setup: "completed", assembly: "completed" }, "setup: setup and build are recorded");
}

// record deploy on the local preview, with a stand-in fetch answering every
// built page 200, so the probe never leaves the process.
async function recordDeploy(f) {
  mutateJson(f.packetPath, (packet) => {
    packet.deploy = { ...packet.deploy, target: "local-serve" };
  });
  await recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": `http://127.0.0.1:4173/${f.slug}/` }, {
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: null }),
  });
  assert.equal(readJson(f.reportPath).stages.deploy.status, "completed", "setup: deploy is recorded");
}

// The QA stage write `qa run` makes, from a synthetic verdict: the current
// spec material, the brief material bound at run start (or `briefMaterial`),
// one executed test order, `qcResults` and the verdict `assertions` they pair
// with, all at `at`. `selfReferential` names the Assembly Report as the
// stage's full verdict.
async function recordQa(f, { runId = "qa-synthetic-run-0001", qcResults = [], assertions = [], at = new Date().toISOString(), briefMaterial, selfReferential = false } = {}) {
  const { recordQaStageOutcome } = await import("./cli.mjs");
  const { specMaterialHash } = await import("./spec-identity.mjs");
  const { localQaIdentifier } = await import("./spec-source-identity.mjs");
  const { QA_SCHEMA_VERSION } = await import("./qa-verdict.mjs");
  const packet = readJson(f.packetPath);
  const report = readJson(f.reportPath);
  const localId = packet.spec?.local_spec_id ?? null;
  const identifier = localId ? localQaIdentifier(localId) : packet.spec.map_id;
  const verdict = {
    schema_version: QA_SCHEMA_VERSION,
    run_id: runId,
    campaign_slug: identifier,
    ...(localId ? { local_spec_id: localId } : {}),
    spec_hash: specMaterialHash(readJson(specPathOf(f))),
    // What qa run records at run start: the bound brief material.
    source_brief_material: structuredClone(briefMaterial ?? report.build_brief?.material),
    started_at: at,
    completed_at: at,
    runtime: `campaigns-os-node-qa@${readJson(join(ROOT, "package.json")).version}`,
    disposition: "ready",
    assertions,
    exceptions: [],
    test_orders: [{ next_order_id: `${runId}-order-1`, is_test: true, verification: { verified: true } }],
  };
  const verdictPath = join(f.target, "qa-output", identifier, `${runId}.json`);
  writeJson(verdictPath, verdict);
  const sidecarPath = join(f.target, ".campaign-runtime/qa-verdict.json");
  writeJson(sidecarPath, { schema_version: "campaigns-os-qa-verdict-sidecar/v0", run_id: runId, disposition: "ready", assertions: [] });
  const written = recordQaStageOutcome({ packet: f.packetPath }, {
    verdict,
    local_path: selfReferential ? f.reportPath : verdictPath,
    qa_sidecar: { path: sidecarPath },
    qc_results: qcResults,
  });
  assert.equal(written, true, "setup: the QA stage write recorded the verdict");
  const qa = readJson(f.reportPath).stages.qa;
  assert.equal(qa.status, "completed", "setup: QA is completed");
  assert.equal(qa.verdict_run_id, runId, "setup: QA records this verdict");
  return verdict;
}

// ----- F2.1 rows -------------------------------------------------------------

// F2.1-W1: guided intake, the draft copied with brand.cta_style set, saved.
function saveCtaAnswer(f) {
  const draft = readJson(normalizedOf(f));
  assert.deepEqual(draft.questions.map((question) => question.id), ["brand_palette_cta", "bundle_pricing_presentation"], "setup: guided intake left two questions");
  draft.brand.cta_style = "solid accent pill";
  saveBrief(f, draft);
}

test("F2.1-W1: an answer saved with record brief is read back by a new process from the normalized brief", async () => {
  await guardedLifecycle((f) => {
    saveCtaAnswer(f);
    // A new node process, started after the save, reads the normalized brief.
    const read = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      "import { readFileSync } from \"node:fs\"; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(process.argv[1], \"utf8\")).brand.cta_style));",
      normalizedOf(f),
    ], { encoding: "utf8", env: process.env });
    assert.equal(read.status, 0, `setup: the new process read the normalized brief: ${String(read.stderr).slice(0, 400)}`);
    assert.equal(JSON.parse(read.stdout), "solid accent pill");
  });
});

test("F2.1-W2: after the saved answer, doctor's build_brief.guided_questions is a warning naming only bundle_pricing_presentation", async () => {
  await guardedLifecycle((f) => {
    saveCtaAnswer(f);
    const doctorJson = doctorOk(f);
    const guided = doctorJson.warnings.filter((issue) => issue.code === "build_brief.guided_questions");
    assert.equal(guided.length, 1, `one guided-questions warning: ${JSON.stringify(doctorJson.warnings.map((issue) => issue.code))}`);
    assert.equal(doctorJson.errors.some((issue) => issue.code === "build_brief.guided_questions"), false, "it is not an error");
    const named = ["brand_palette_cta", "bundle_pricing_presentation"].filter((id) => new RegExp(`\\b${id}\\b`).test(guided[0].message));
    assert.deepEqual(named, ["bundle_pricing_presentation"]);
  });
});

test("F2.1-W13: after the saved answer, doctor reports no error whose code starts with build_brief.", async () => {
  await guardedLifecycle((f) => {
    saveCtaAnswer(f);
    const doctorJson = doctorOk(f);
    assert.ok(Array.isArray(doctorJson.errors), "setup: doctor printed its errors");
    assert.ok(doctorJson.warnings.some((issue) => issue.code === "build_brief.guided_questions"), "setup: doctor read the saved brief (it reports its open question)");
    assert.equal(doctorJson.errors.filter((issue) => String(issue.code).startsWith("build_brief.")).length, 0, JSON.stringify(doctorJson.errors.map((issue) => issue.code)));
  });
});

// F2.1-W3: a complete guided-file brief saved, then setup, build and Polish.
async function completeBriefThroughPolish(f) {
  saveBrief(f, answeredDraft(f));
  await recordThroughPolish(f);
}

test("F2.1-W3: rewriting the brief file with identical bytes and saving leaves the Assembly Report sha256 unchanged", async () => {
  await guardedLifecycle(async (f) => {
    await completeBriefThroughPolish(f);
    writeFileSync(briefFileOf(f), readFileSync(briefFileOf(f)));
    const before = sha256File(f.reportPath);
    recordInputOk(f, "brief", "unchanged");
    assert.equal(sha256File(f.reportPath), before);
  });
});

// F2.1-W5: as W3, plus deploy and a QA verdict recorded, then brand.cta_style
// changed and saved. `beforeSave` sees the report just before the save.
async function presentationChangeAfterQa(f, beforeSave = () => {}) {
  await completeBriefThroughPolish(f);
  await recordDeploy(f);
  await recordQa(f);
  beforeSave(readJson(f.reportPath));
  const brief = readJson(briefFileOf(f));
  brief.brand.cta_style = "solid accent pill";
  saveBrief(f, brief);
}

test("F2.1-W5: a material presentation change saved with record brief makes build, Polish and QA owed and keeps setup and deploy", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await presentationChangeAfterQa(f);
    assert.deepEqual(stageStatuses(f, ["setup", "assembly", "polish", "deploy", "qa"]), { setup: "completed", assembly: "required", polish: "required", deploy: "completed", qa: "required" });
  });
});

test("F2.1-W9: after the W5 save, stages.assembly.history[-1].reason_code is brief_presentation_changed", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await presentationChangeAfterQa(f);
    const history = readJson(f.reportPath).stages.assembly.history;
    assert.ok(Array.isArray(history) && history.length > 0, "stages.assembly.history[] holds the superseded record");
    assert.equal(history.at(-1).reason_code, "brief_presentation_changed");
  });
});

test("F2.1-W17: the superseded QA record in history keeps the pre-save purchase_proof", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    let before = null;
    await presentationChangeAfterQa(f, (report) => {
      before = report.stages.qa.purchase_proof;
    });
    assert.ok(before && typeof before === "object" && before.order_paths_executed === 1, "setup: stages.qa.purchase_proof is set before the save");
    const history = readJson(f.reportPath).stages.qa.history;
    assert.ok(Array.isArray(history) && history.length > 0, "stages.qa.history[] holds the superseded record");
    assert.deepEqual(history.at(-1).purchase_proof, before);
  });
});

test("F2.1-W18: the superseded Polish record in history keeps the pre-save package page_load capture", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    let before = null;
    await presentationChangeAfterQa(f, (report) => {
      before = report.stages.polish.evidence?.visual_review?.page_load;
    });
    assert.equal(before?.performed_by, "campaigns-os polish capture", "setup: polish carries a package page_load capture before the save");
    const history = readJson(f.reportPath).stages.polish.history;
    assert.ok(Array.isArray(history) && history.length > 0, "stages.polish.history[] holds the superseded record");
    assert.deepEqual(history.at(-1).evidence?.visual_review?.page_load, before);
  });
});

test("F2.1-B3: after the W5 save, record polish with a valid evidence file exits 1", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await presentationChangeAfterQa(f);
    const before = treeDigest(f.dir);
    const result = record(f, "polish", ["--evidence", POLISH_EVIDENCE, "--json"]);
    assert.equal(result.status, 1, result.stderr.slice(0, 400));
    assertNothingWritten(f.dir, before, "the refused record polish");
  });
});

test("F2.1-B10: after the W5 save, record build over the unchanged _site leaves assembly owed", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await presentationChangeAfterQa(f);
    recordOk(f, "build");
    assert.equal(inputCurrency(f).stages.assembly, "owed");
  });
});

// F2.1-W24: after W5, record build with the operator's --deviation-reason
// over the unchanged _site.
async function operatorKeepsOutput(f) {
  await presentationChangeAfterQa(f);
  recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
}

test("F2.1-W24: after W5, record build --deviation-reason over the unchanged _site makes assembly current", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await operatorKeepsOutput(f);
    assert.equal(inputCurrency(f).stages.assembly, "current");
  });
});

test("F2.1-W25: on a legacy packet without build_brief, record build makes assembly current", async () => {
  await guardedLifecycle((f) => {
    mutateJson(f.packetPath, (packet) => {
      delete packet.build_brief;
    });
    assert.equal(Object.hasOwn(readJson(f.packetPath), "build_brief"), false, "setup: the packet has no build_brief");
    recordThroughBuild(f);
    assert.equal(inputCurrency(f).stages.assembly, "current");
  });
});

test("F2.1-W29: after W24, record polish skipped with a skip_reason reads polish not_applicable", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    await operatorKeepsOutput(f);
    recordOk(f, "polish", ["--evidence", writeEvidence(f, "polish-skipped.json", SKIPPED_POLISH)]);
    assert.equal(readJson(f.reportPath).stages.polish.status, "skipped", "setup: Polish is recorded skipped");
    const currency = inputCurrency(f);
    assert.equal(currency.stages.polish, "not_applicable");
    assert.equal(currency.stages.assembly, "current", "the operator's --deviation-reason build stays current (rule 5(ii))");
  });
});

test("next quotes the operator's --deviation-reason in qc_handoff.notes, and writes no notes without that decision", async () => {
  await guardedLifecycle((f) => {
    saveBrief(f, answeredDraft(f));
    recordThroughBuild(f);
    const brief = readJson(briefFileOf(f));
    brief.brand.cta_style = "solid accent pill";
    saveBrief(f, brief);
    recordOk(f, "build");
    assert.equal(inputCurrency(f).stages.assembly, "owed", "setup: the replayed build is owed");
    assert.equal(Object.hasOwn(nextOk(f).qc_handoff, "notes"), false, "no operator decision, no notes");
    recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
    assert.equal(inputCurrency(f).stages.assembly, "current", "setup: the operator's decision makes the build current");
    assert.deepEqual(nextOk(f).qc_handoff.notes, [`Build output kept unchanged after an input change by the operator's decision: "${OPERATOR_DECISION}"`]);
  });
});

test("F2.1-W6: a change to qa_policy.require_checkout_flow alone makes only QA owed", async () => {
  await guardedLifecycle(async (f) => {
    await completeBriefThroughPolish(f);
    await recordQa(f);
    const brief = readJson(briefFileOf(f));
    brief.qa_policy.require_checkout_flow = !brief.qa_policy.require_checkout_flow;
    saveBrief(f, brief);
    assert.deepEqual(stageStatuses(f, ["assembly", "polish", "qa"]), { assembly: "completed", polish: "completed", qa: "required" });
  });
});

test("F2.1-W7: a brief_mode prepared file with one open question, bundle_pricing_presentation, saved, blocks prepare_build", async () => {
  await guardedLifecycle((f) => {
    const brief = readJson(normalizedOf(f));
    brief.brand.cta_style = "solid dark button";
    brief.brief_mode = "prepared";
    assert.equal(brief.offer_presentation.bundle_cards.primary_price, null, "setup: bundle pricing stays unanswered");
    saveBrief(f, brief);
    assert.deepEqual(readJson(normalizedOf(f)).questions.map((question) => question.id), ["bundle_pricing_presentation"], "setup: exactly that question is open");
    assert.equal(readJson(f.reportPath).stages.prepare_build.status, "blocked");
  });
});

test("F2.1-W10: a fresh intake binds report.build_brief.material.presentation as a sha256 fingerprint", async () => {
  await guardedLifecycle((f) => {
    assert.match(String(readJson(f.reportPath).build_brief?.material?.presentation), SHA256_PATTERN);
  });
});

test("F2.1-W12: the same brief file through intake and through record brief gives equal normalized artifacts, ignoring _meta.generated_at", async () => {
  // One target and one brief file at one path. The target is saved with the
  // file in place, intake reads the file, the target is restored, and
  // record brief reads the same file from the same starting state.
  await guardedLifecycle((f) => {
    const strip = (artifact) => ({ ...artifact, _meta: { ...artifact._meta, generated_at: undefined } });
    writeJson(briefFileOf(f), answeredDraft(f));
    const briefBytes = readFileSync(briefFileOf(f));
    const saved = join(f.dir, "target-before");
    cpSync(f.target, saved, { recursive: true });
    const restore = () => {
      rmSync(f.target, { recursive: true, force: true });
      cpSync(saved, f.target, { recursive: true });
    };

    reintake(f);
    assert.equal(resolve(f.target, readJson(f.contextPath).build_brief.input_path), resolve(briefFileOf(f)), "setup: intake read the brief file");
    const viaIntake = readJson(normalizedOf(f));

    restore();
    assert.ok(readFileSync(briefFileOf(f)).equals(briefBytes), "setup: the same brief file, byte for byte, at the same path");
    recordInputOk(f, "brief", "saved_with_invalidation");
    const viaRecord = readJson(normalizedOf(f));

    assert.deepEqual(strip(viaRecord), strip(viaIntake));
  });
});

test("F2.1-W14: a report recording build_brief.mode prepared and a brief file without brief_mode save with _meta.mode_source legacy_report", async () => {
  await guardedLifecycle((f) => {
    for (const path of [f.reportPath, f.contextPath]) {
      mutateJson(path, (artifact) => {
        artifact.build_brief.mode = "prepared";
        delete artifact.build_brief.material;
        delete artifact.build_brief.input_sha256;
      });
    }
    const brief = answeredDraft(f);
    assert.equal(Object.hasOwn(brief, "brief_mode"), false, "setup: the file has no brief_mode");
    saveBrief(f, brief, "saved");
    assert.equal(readJson(normalizedOf(f))._meta.mode_source, "legacy_report");
  });
});

// Positive control for F2.1-W16's trace (not a numbered row): a child that does
// connect (to the loopback discard port) is seen in the NODE_DEBUG=net trace.
test("network trace control: the NODE_DEBUG=net trace records a loopback connection", () => {
  const control = spawnSync(process.execPath, ["-e", "require('node:net').connect(9, '127.0.0.1').on('error', () => {})"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_DEBUG: "net", CAMPAIGNS_OS_TELEMETRY: "off" },
  });
  assert.deepEqual(connectedHosts(String(control.stderr)), ["127.0.0.1"], "the NODE_DEBUG=net trace records a connection");
});

test("F2.1-W16: a material brief change saved with record brief opens no outbound connection", async () => {
  await guardedLifecycle((f) => {
    writeJson(briefFileOf(f), answeredDraft(f));
    const result = recordInput(f, "brief", [], { NODE_DEBUG: "net" });
    assert.equal(result.status, 0, `setup: record brief ran: ${result.stderr.slice(0, 600)}`);
    assert.equal(JSON.parse(result.stdout).outcome, "saved_with_invalidation", "setup: the save is a material change");
    assert.equal(connectedHosts(result.stderr).length, 0, `outbound connections: ${JSON.stringify(connectedHosts(result.stderr))}`);
  });
});

// F2.1-W20..W23: an unchanged-material resave of the W3 brief file.
async function resaveKeepsStatuses(f, rewrite) {
  await completeBriefThroughPolish(f);
  const before = stageStatuses(f);
  rewrite(readJson(briefFileOf(f)));
  recordInputOk(f, "brief", "saved");
  assert.deepEqual(stageStatuses(f), before);
}

test("F2.1-W20: resaving the brief with reversed key order keeps every stage status", async () => {
  await guardedLifecycle((f) => resaveKeepsStatuses(f, (brief) => {
    writeFileSync(briefFileOf(f), `${JSON.stringify(reverseKeys(brief), null, 2)}\n`);
  }));
});

test("F2.1-W21: resaving the brief with tab indentation and a trailing newline keeps every stage status", async () => {
  await guardedLifecycle((f) => resaveKeepsStatuses(f, (brief) => {
    writeFileSync(briefFileOf(f), `${JSON.stringify(brief, null, "\t")}\n\n`);
  }));
});

test("F2.1-W22: resaving the brief with template_residue_policy.block_placeholders: true written explicitly keeps every stage status", async () => {
  await guardedLifecycle((f) => resaveKeepsStatuses(f, (brief) => {
    assert.equal(Object.hasOwn(brief.template_residue_policy, "block_placeholders"), false, "setup: the saved file omitted the default");
    brief.template_residue_policy.block_placeholders = true;
    writeJson(briefFileOf(f), brief);
  }));
});

test("F2.1-W23: resaving the brief with only its _meta changed (generated_at and mode) keeps every stage status", async () => {
  await guardedLifecycle((f) => resaveKeepsStatuses(f, (brief) => {
    brief._meta = { ...brief._meta, generated_at: "2026-01-01T00:00:00.000Z", mode: "prepared" };
    writeJson(briefFileOf(f), brief);
  }));
});

test("F2.1-B1: after W1, a stamped completed assembly reads next build once the normalized brief's brand.cta_style is hand-edited", async () => {
  await guardedLifecycle((f) => {
    saveCtaAnswer(f);
    recordThroughBuild(f);
    assert.equal(nextOk(f).stage, "polish", "setup: assembly is current, so next moves to polish");
    mutateJson(normalizedOf(f), (brief) => {
      brief.brand.cta_style = "outlined ghost button";
    });
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.1-B4: with a brief file in the target and the spec's package qty edited, record brief refuses spec_changed_run_record_spec", async () => {
  await guardedLifecycle((f) => {
    writeJson(briefFileOf(f), answeredDraft(f));
    assert.equal(existsSync(briefFileOf(f, join(f.dir, "source"))), false, "setup: no brief file in the source root");
    editSpec(f, bumpCheckoutQty);
    assertRefusedWritingNothing(f, "brief", "spec_changed_run_record_spec");
  });
});

test("F2.1-B5: a required assembly whose history[0].build_fingerprint equals the current output reads next build", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    const current = doctorOk(f).derived.build_output_fingerprint;
    assert.equal(current.status, "pass", "setup: the recorded build is the current output");
    mutateJson(f.reportPath, (report) => {
      const completed = report.stages.assembly;
      report.stages.assembly = {
        stage: "assembly",
        status: "required",
        required_by: "brief",
        required_for: ["polish", "qa"],
        build_fingerprint: completed.build_fingerprint,
        history: [{ archived_at: new Date().toISOString(), archived_by: "record brief", reason_code: "brief_presentation_changed", ...completed }],
      };
    });
    assert.equal(readJson(f.reportPath).stages.assembly.history[0].build_fingerprint, current.value, "setup: history[0] is bound to the current output");
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.1-B9: different brief files in the source root and the target, with no --brief, refuse brief_path_ambiguous", async () => {
  await guardedLifecycle((f) => {
    const brief = answeredDraft(f);
    writeJson(briefFileOf(f, join(f.dir, "source")), brief);
    writeJson(briefFileOf(f), { ...brief, brand: { ...brief.brand, cta_style: "outlined ghost button" } });
    assert.notEqual(readFileSync(briefFileOf(f, join(f.dir, "source")), "utf8"), readFileSync(briefFileOf(f), "utf8"), "setup: the two files differ");
    assertRefusedWritingNothing(f, "brief", "brief_path_ambiguous");
  });
});

test("F2.1-B11: a brief file of 1 MiB + 1 byte refuses brief_too_large", async () => {
  await guardedLifecycle((f) => {
    writeFileSync(briefFileOf(f), briefJsonOfSize(answeredDraft(f), 1_048_577));
    assert.equal(statSync(briefFileOf(f)).size, 1_048_577, "setup: the file is 1 MiB + 1 byte");
    assertRefusedWritingNothing(f, "brief", "brief_too_large");
  });
});

test("F2.1-B12: a brief file with 513 design_authority entries refuses brief_too_large", async () => {
  await guardedLifecycle((f) => {
    const brief = briefWithDesignAuthorityEntries(answeredDraft(f), 513);
    writeJson(briefFileOf(f), brief);
    assert.equal(Object.keys(readJson(briefFileOf(f)).design_authority).length, 513, "setup: 513 design_authority entries");
    assert.ok(statSync(briefFileOf(f)).size < 1_048_576, "setup: the file is under 1 MiB, so only the entry count can refuse it");
    assertRefusedWritingNothing(f, "brief", "brief_too_large");
  });
});

test("F2.1-B14: build and Polish recorded, spec edited, prepare-build --force, record setup, then record build over unchanged _site leaves assembly owed", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughPolish(f);
    editSpec(f, bumpCheckoutQty);
    reintake(f, ["--force"]);
    recordOk(f, "setup");
    recordOk(f, "build");
    assert.equal(readJson(f.reportPath).stages.assembly.status, "completed", "setup: record build recorded the replay");
    assert.equal(inputCurrency(f).stages.assembly, "owed");
  });
});

test("F2.1-B17: record brief --brief <the normalized brief> refuses brief_source_is_package_artifact", async () => {
  await guardedLifecycle((f) => {
    assert.equal(existsSync(normalizedOf(f)), true, "setup: the normalized brief exists");
    assertRefusedWritingNothing(f, "brief", "brief_source_is_package_artifact", ["--brief", normalizedOf(f)]);
  });
});

test("F2.1-B18: with the spec unchanged and context.spec.active_pages reordered by hand, record brief refuses page_scope_changed", async () => {
  await guardedLifecycle((f) => {
    writeJson(briefFileOf(f), answeredDraft(f));
    mutateJson(f.contextPath, (context) => {
      const [first, second, ...rest] = context.spec.active_pages;
      assert.ok(first && second, "setup: at least two active pages");
      context.spec.active_pages = [second, first, ...rest];
    });
    assertRefusedWritingNothing(f, "brief", "page_scope_changed");
  });
});

test("F2.1-I2: with the normalized brief file deleted, next answers doctor-blocked", async () => {
  await guardedLifecycle((f) => {
    rmSync(normalizedOf(f));
    assert.equal(existsSync(normalizedOf(f)), false, "setup: the normalized brief is gone");
    assert.equal(nextOk(f).stage, "doctor-blocked");
  });
});

for (const [id, label, drop] of [
  ["F2.1-I3", "commerce_zone_findings", (context) => { delete context.commerce_zone_findings; }],
  ["F2.1-I13", "spec.active_pages", (context) => { delete context.spec.active_pages; }],
  ["F2.1-I14", "page_map", (context) => { delete context.page_map; }],
  ["F2.1-I15", "source.asset_crawl", (context) => { delete context.source.asset_crawl; }],
]) {
  test(`${id}: with a brief file in the target and a Build Context without ${label}, record brief refuses brief_inputs_unavailable`, async () => {
    await guardedLifecycle((f) => {
      writeJson(briefFileOf(f), answeredDraft(f));
      mutateJson(f.contextPath, drop);
      assertRefusedWritingNothing(f, "brief", "brief_inputs_unavailable");
    });
  });
}

test("F2.1-I5: record brief --dry-run on a changed brief leaves the report sha256 unchanged", async () => {
  await guardedLifecycle((f) => {
    writeJson(briefFileOf(f), answeredDraft(f));
    const before = sha256File(f.reportPath);
    const dry = recordInputOk(f, "brief", "saved_with_invalidation", ["--dry-run"]);
    assert.equal(dry.dry_run, true, "setup: the dry run ran");
    assert.equal(sha256File(f.reportPath), before);
  });
});

test("F2.1-I6: a skipped Polish stays skipped through a presentation change saved with record brief", async () => {
  await guardedLifecycle((f) => {
    saveBrief(f, answeredDraft(f));
    recordThroughBuild(f);
    recordOk(f, "polish", ["--evidence", writeEvidence(f, "polish-skipped.json", SKIPPED_POLISH)]);
    assert.equal(readJson(f.reportPath).stages.polish.status, "skipped", "setup: Polish is skipped");
    const brief = readJson(briefFileOf(f));
    brief.brand.cta_style = "solid accent pill";
    saveBrief(f, brief);
    assert.equal(readJson(f.reportPath).stages.polish.status, "skipped");
  });
});

const journalLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0);

test("F2.1-I7: record brief --dry-run --lifecycle-journal on a changed brief adds no journal line", async () => {
  await guardedLifecycle((f) => {
    const journal = join(f.dir, "lifecycle.jsonl");
    scaffold(f);
    recordOk(f, "setup", ["--lifecycle-journal", journal]);
    const before = journalLines(journal);
    assert.ok(before > 0, "setup: a recorded command journals to this file");
    writeJson(briefFileOf(f), answeredDraft(f));
    const dry = recordInputOk(f, "brief", "saved_with_invalidation", ["--dry-run", "--lifecycle-journal", journal]);
    assert.equal(dry.dry_run, true, "setup: the dry run ran");
    assert.equal(journalLines(journal), before);
  });
});

// A legacy report: the completed assembly carries no stamps and the report
// no brief binding, as records made before this release.
function legacyAssembly(f) {
  for (const path of [f.reportPath, f.contextPath]) {
    mutateJson(path, (artifact) => {
      delete artifact.build_brief.material;
      delete artifact.build_brief.input_sha256;
    });
  }
  mutateJson(f.reportPath, (report) => {
    for (const key of ["assembly", "polish", "qa"]) {
      delete report.stages[key].source_brief_material;
      delete report.stages[key].source_spec_material_hash;
    }
  });
}

test("F2.1-I8: a legacy report with an unstamped completed assembly makes doctor warn build_brief.binding_unknown", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    legacyAssembly(f);
    const doctorJson = doctorOk(f);
    assert.equal(doctorJson.warnings.some((issue) => issue.code === "build_brief.binding_unknown"), true, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
  });
});

test("F2.1-I9: a legacy report with an unstamped completed assembly reads next build", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    assert.equal(nextOk(f).stage, "polish", "setup: the recorded build moves next to polish");
    legacyAssembly(f);
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.1-I10: with the bound material equal to the file and the assembly brief stamp missing, record brief reads unchanged", async () => {
  await guardedLifecycle((f) => {
    saveBrief(f, answeredDraft(f));
    recordThroughBuild(f);
    mutateJson(f.reportPath, (report) => {
      delete report.stages.assembly.source_brief_material;
    });
    recordInputOk(f, "brief", "unchanged");
  });
});

test("F2.1-I12: with no brief file in the source root or the target and no --brief, record brief refuses brief_file_missing", async () => {
  await guardedLifecycle((f) => {
    for (const root of [join(f.dir, "source"), f.target]) {
      for (const name of ["campaign-build-brief.yaml", "campaign-build-brief.yml", "campaign-build-brief.json"]) {
        assert.equal(existsSync(join(root, name)), false, `setup: no ${name} in ${root}`);
      }
    }
    assertRefusedWritingNothing(f, "brief", "brief_file_missing");
  });
});

test("F2.1-I17: every ladder stage terminal except stages.deploy.status completed_x makes the picker answer deploy", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughPolish(f);
    assert.equal(nextOk(f).stage, "deploy", "setup: build and Polish are current, so the ladder reaches deploy");
    mutateJson(f.reportPath, (report) => {
      report.stages.deploy = { ...report.stages.deploy, status: "completed_x" };
      report.stages.qa = { ...report.stages.qa, status: "completed", completed_at: new Date().toISOString() };
    });
    // Doctor's `next` block is pickNextStage's projection (src/doctor/next-step.mjs buildNextStep).
    assert.equal(doctorOk(f).next.stage, "deploy");
  });
});

// Node rows whose setup needs a recorded campaign. src/input-currency.mjs is
// imported first, so a missing module fails these rows before any setup.
async function currencyNow(f) {
  const { assessInputCurrency } = await import("./input-currency.mjs");
  const { briefMaterialFingerprint } = await import("./build-brief.mjs");
  const { specMaterialHash } = await import("./spec-identity.mjs");
  assert.equal(typeof briefMaterialFingerprint, "function", "src/build-brief.mjs exports briefMaterialFingerprint");
  return assessInputCurrency({
    report: readJson(f.reportPath),
    briefMaterial: briefMaterialFingerprint(readJson(normalizedOf(f))),
    specMaterial: specMaterialHash(readJson(specPathOf(f))),
  });
}

test("F2.1-W28: a second QA verdict recorded with unchanged inputs, archiving the first, reads QA current", async () => {
  await guardedLifecycle(async (f) => {
    await import("./input-currency.mjs");
    await recordQa(f, { runId: "qa-synthetic-run-0001" });
    await recordQa(f, { runId: "qa-synthetic-run-0002" });
    const qa = readJson(f.reportPath).stages.qa;
    assert.deepEqual((qa.history || []).map((entry) => entry.verdict_run_id), ["qa-synthetic-run-0001"], "setup: the first verdict was archived");
    assert.equal((await currencyNow(f)).stages.qa, "current");
  });
});

test("F2.1-B15: stamps copied by hand from report.build_brief.material and identity.spec_material_hash read assembly current", async () => {
  await guardedLifecycle(async (f) => {
    await import("./input-currency.mjs");
    saveBrief(f, readJson(normalizedOf(f)), "saved");
    recordThroughBuild(f);
    // The completed assembly carries no stamps.
    mutateJson(f.reportPath, (report) => {
      delete report.stages.assembly.source_brief_material;
      delete report.stages.assembly.source_spec_material_hash;
    });
    const unstamped = readJson(f.reportPath).stages.assembly;
    assert.equal(unstamped.status, "completed", "setup: assembly is completed");
    assert.deepEqual(["source_brief_material", "source_spec_material_hash"].filter((field) => Object.hasOwn(unstamped, field)), [], "setup: the completed assembly has no stamps");
    // The stamps copied by hand from the current bindings.
    mutateJson(f.reportPath, (report) => {
      assert.ok(report.build_brief.material, "setup: the saved brief bound its material");
      report.stages.assembly.source_brief_material = structuredClone(report.build_brief.material);
      report.stages.assembly.source_spec_material_hash = report.identity.spec_material_hash;
    });
    assert.equal((await currencyNow(f)).stages.assembly, "current");
  });
});

test("F2.1-B25: a QA write whose verdict recorded the brief material at run start, before a qa_policy-only save, reads QA owed", async () => {
  await guardedLifecycle(async (f) => {
    await import("./input-currency.mjs");
    saveBrief(f, answeredDraft(f));
    const runStart = structuredClone(readJson(f.reportPath).build_brief.material);
    assert.ok(runStart, "setup: the brief material bound when qa run starts");
    const brief = readJson(briefFileOf(f));
    brief.qa_policy.require_checkout_flow = !brief.qa_policy.require_checkout_flow;
    saveBrief(f, brief);
    await recordQa(f, { briefMaterial: runStart });
    assert.equal((await currencyNow(f)).stages.qa, "owed");
  });
});

// ----- F2.2 rows -------------------------------------------------------------

test("F2.2-W1: a local-spec checkout qty +1 with the brief unchanged gives doctor input warnings {spec.material_stale}", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    assert.deepEqual(inputWarnings(doctorOk(f)), [], "setup: no input warning before the edit");
    editSpec(f, bumpCheckoutQty);
    assert.deepEqual(inputWarnings(doctorOk(f)), ["spec.material_stale"]);
  }, LOCAL_SPEC);
});

// F2.2-W2: a local-spec lifecycle with deploy and a QA verdict recorded before
// the W1 edit, then record spec. `beforeRefresh` runs just before record spec.
async function specRefreshAfterQa(f, beforeRefresh = () => {}) {
  await recordThroughPolish(f);
  await recordDeploy(f);
  await recordQa(f);
  editSpec(f, bumpCheckoutQty);
  beforeRefresh();
  recordInputOk(f, "spec", "refreshed");
}

test("F2.2-W2: record spec after a material spec edit makes build, Polish and QA owed and keeps setup and deploy", async () => {
  await guardedLifecycle(async (f) => {
    await specRefreshAfterQa(f);
    assert.deepEqual(stageStatuses(f, ["setup", "assembly", "polish", "deploy", "qa"]), { setup: "completed", assembly: "required", polish: "required", deploy: "completed", qa: "required" });
  }, LOCAL_SPEC);
});

test("F2.2-W3: after the W2 refresh, stages.qa.history[-1].reason_code is spec_material_changed", async () => {
  await guardedLifecycle(async (f) => {
    await specRefreshAfterQa(f);
    const history = readJson(f.reportPath).stages.qa.history;
    assert.ok(Array.isArray(history) && history.length > 0, "stages.qa.history[] holds the superseded record");
    assert.equal(history.at(-1).reason_code, "spec_material_changed");
  }, LOCAL_SPEC);
});

test("F2.2-W7: the W2 refresh leaves waivers, qc_accepts, theme and packet.deploy byte-equal to before", async () => {
  await guardedLifecycle(async (f) => {
    let before = null;
    const capture = () => {
      const report = readJson(f.reportPath);
      return [report.waivers, report.qc_accepts, report.theme, readJson(f.packetPath).deploy].map((value) => JSON.stringify(value));
    };
    await specRefreshAfterQa(f, () => {
      mutateJson(f.reportPath, (report) => {
        report.waivers = [{ scope: "polish.synthetic_scope", reason: "synthetic waiver kept across record spec", applies_to: [], waived_by: "Jordan Lee", waived_at: "2026-10-01T10:00:00.000Z", evidence_refs: [] }];
        report.qc_accepts = [{
          schema: "campaigns-os-qc-accept/v0", scope: "qc_accept", result_id: "policy.availability:campaign:store_terms",
          check: "policy.availability", leg: "qa", subject: { check: "policy.availability", page: "campaign", key: "store_terms" },
          state_fingerprint: `sha256:${"a".repeat(64)}`, result_at_accept: "warning", measured_at: "2026-10-01T10:00:00.000Z",
          measured_source: "qa_verdict", reason: "synthetic accept kept across record spec", accepted_by: "Jordan Lee",
          accepted_at: "2026-10-01T10:05:00.000Z", recorded_by: "campaigns-os checkpoint accept",
        }];
      });
      before = capture();
      assert.ok(before.every((value) => value !== undefined && value !== "null"), "setup: each of the four values is present");
    });
    assert.deepEqual(capture(), before);
  }, LOCAL_SPEC);
});

test("F2.2-W4: a spec re-serialized (key order, tabs) with saved_at changed reads record spec unchanged", async () => {
  await guardedLifecycle((f) => {
    const spec = readJson(specPathOf(f));
    const before = readFileSync(specPathOf(f), "utf8");
    writeFileSync(specPathOf(f), `${JSON.stringify(reverseKeys({ ...spec, saved_at: "2026-10-05T12:00:00.000Z" }), null, "\t")}\n`);
    assert.notEqual(readFileSync(specPathOf(f), "utf8"), before, "setup: the spec file bytes changed");
    recordInputOk(f, "spec", "unchanged");
  }, { mutateSpec: (spec) => { spec.saved_at = "2026-10-01T00:00:00.000Z"; } });
});

test("F2.2-W5: on a saved-Map-shaped packet, a stamped completed assembly reads next build once the cached spec's qty is edited", async () => {
  await guardedLifecycle((f) => {
    assert.ok(readJson(f.packetPath).spec.map_id, "setup: a saved-Map packet");
    recordThroughBuild(f);
    assert.equal(nextOk(f).stage, "polish", "setup: assembly is current, so next moves to polish");
    editSpec(f, bumpCheckoutQty);
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.2-W6: a qty edit, a rebuild that changes the output, record build, then record spec keeps assembly completed", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    editSpec(f, bumpCheckoutQty);
    buildSite(f, " (rebuilt for the qty change)");
    assert.equal(doctorOk(f).derived.build_output_fingerprint.status, "stale", "setup: the output bytes differ from the recorded build");
    recordOk(f, "build");
    recordInputOk(f, "spec", "refreshed");
    assert.equal(readJson(f.reportPath).stages.assembly.status, "completed");
    assert.equal(inputCurrency(f).stages.assembly, "current", "the rebuild changed the output, so the build is current (rule 5(i))");
  });
});

// F2.2-W8: a hosted preview packet (not the local-preview carry-forward),
// Polish recorded, a spec-only change, record spec, then the operator's
// --deviation-reason build over the unchanged _site. `afterPolish` runs once
// Polish is recorded. The row names deploy.target "preview", which doctor
// refuses as an unknown target (src/doctor/checks.mjs:200-208, :574-575), so
// next would be doctor-blocked whatever the row tests; "netlify" is a known
// hosted target that keeps the row's purpose (no local-preview carry-forward).
async function hostedSpecChangeKeepsOutput(f, afterPolish = () => {}) {
  mutateJson(f.packetPath, (packet) => {
    packet.deploy = { ...packet.deploy, target: "netlify", preview_url: `https://preview.example.invalid/${f.slug}/` };
  });
  await recordThroughPolish(f);
  assert.equal(nextOk(f).stage, "deploy", "setup: build and Polish are recorded on a hosted preview packet");
  await afterPolish();
  editSpec(f, bumpCheckoutQty);
  recordInputOk(f, "spec", "refreshed");
  recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
}

test("F2.2-W8: on a hosted preview packet, record spec then record build --deviation-reason over the unchanged _site reads next polish", async () => {
  await guardedLifecycle(async (f) => {
    await hostedSpecChangeKeepsOutput(f);
    assert.equal(nextOk(f).stage, "polish");
    assert.equal(inputCurrency(f).stages.assembly, "current", "the operator's --deviation-reason build is current (rule 5(ii))");
  });
});

test("F2.2-W9: as W8, the media.weight QC rows' (id, result) pairs captured before the change are unchanged", async () => {
  await guardedLifecycle(async (f) => {
    const { mediaWeightFixture, polishStandIn, ROUTES } = await import("./qc-test-factories.mjs");
    const { readMediaWeight } = await import("./qc-results.mjs");
    const pairs = () => {
      const report = readJson(f.reportPath);
      const visual = report.stages.polish.evidence.visual_review;
      const read = readMediaWeight({ record: visual.media_weight, pageLoad: visual.page_load, currentBuild: report.stages.assembly.build_fingerprint, qcStandIns: { polish: polishStandIn() } });
      return (Array.isArray(read) ? read : read.results).map((row) => [row.id, row.result]).sort((a, b) => a[0].localeCompare(b[0]));
    };
    let before = null;
    await hostedSpecChangeKeepsOutput(f, () => {
      const buildFingerprint = readJson(f.reportPath).stages.assembly.build_fingerprint;
      const { pageLoad, record: mediaWeight } = mediaWeightFixture({
        buildFingerprint,
        cells: [
          { route: ROUTES[0], resources: [{ path: `/${f.slug}/img/hero.jpg`, bytes: 600_000 }] },
          { route: ROUTES[1], resources: [{ path: `/${f.slug}/img/badge.png`, bytes: 40_000 }] },
        ],
      });
      mutateJson(f.reportPath, (report) => {
        report.stages.polish.evidence.visual_review = { ...report.stages.polish.evidence.visual_review, page_load: pageLoad, media_weight: mediaWeight };
      });
      before = pairs();
      assert.ok(before.length > 0, "setup: the media_weight record yields media.weight rows before the change");
    });
    assert.deepEqual(pairs(), before);
    assert.equal(inputCurrency(f).stages.assembly, "current", "the operator's --deviation-reason build is current (rule 5(ii))");
  });
});

test("F2.2-W10: with the spec edited and no record spec, the progress snapshot next writes has no unknown continuation action", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    editSpec(f, bumpCheckoutQty);
    const next = nextOk(f, ["--no-remit"]);
    assert.equal((next.next_actions || []).some((action) => action.id === "refresh_inputs"), true, `setup: next_actions includes refresh_inputs: ${JSON.stringify((next.next_actions || []).map((action) => action.id))}`);
    const progressRoot = join(f.target, ".campaign-runtime/progress");
    const latest = readdirSync(progressRoot).map((scope) => join(progressRoot, scope, "latest.json")).filter((path) => existsSync(path));
    assert.equal(latest.length, 1, "setup: next wrote one progress snapshot");
    const snapshot = readJson(latest[0]);
    assert.ok(Array.isArray(snapshot.continuation?.action_ids), "setup: the snapshot carries continuation.action_ids");
    // The next actions (refresh_inputs among them) are projected, so the
    // list read below is not empty.
    assert.ok(snapshot.continuation.action_ids.length > 0, "setup: continuation.action_ids holds the projected next actions");
    assert.equal(snapshot.continuation.action_ids.includes("unknown"), false, JSON.stringify(snapshot.continuation.action_ids));
  });
});

// F2.2-W11: Polish recorded, the spec edited (no record spec), then the
// operator's --deviation-reason build over the byte-identical _site.
async function specEditKeepsOutput(f) {
  await recordThroughPolish(f);
  editSpec(f, bumpCheckoutQty);
  recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
}

test("F2.2-W11: with the spec edited and no record spec, record build --deviation-reason over the byte-identical _site makes assembly current", async () => {
  await guardedLifecycle(async (f) => {
    await specEditKeepsOutput(f);
    assert.equal(inputCurrency(f).stages.assembly, "current");
  });
});

test("F2.2-B22: as W11, Polish is required", async () => {
  await guardedLifecycle(async (f) => {
    await specEditKeepsOutput(f);
    assert.equal(readJson(f.reportPath).stages.polish.status, "required");
    assert.equal(inputCurrency(f).stages.assembly, "current", "the operator's --deviation-reason build is current (rule 5(ii))");
  });
});

test("F2.2-B23: after W11, a second spec edit and record build without --deviation-reason over the byte-identical _site leave assembly owed", async () => {
  await guardedLifecycle(async (f) => {
    await specEditKeepsOutput(f);
    editSpec(f, bumpCheckoutQty);
    recordOk(f, "build");
    assert.equal(inputCurrency(f).stages.assembly, "owed");
  });
});

test("F2.2-W12: on an all-stock packet, record spec, a changed rebuild, record build, then Polish recorded skipped reads polish not_applicable", async () => {
  await guardedLifecycle((f) => {
    mutateJson(f.packetPath, (packet) => {
      packet.source_html.pages = packet.source_html.pages.map((page) => ({ page_id: page.page_id, skip_reason: "template stock: no design source" }));
    });
    recordThroughBuild(f);
    editSpec(f, bumpCheckoutQty);
    recordInputOk(f, "spec", "refreshed");
    buildSite(f, " (rebuilt for the qty change)");
    recordOk(f, "build");
    recordOk(f, "polish", ["--evidence", writeEvidence(f, "polish-skipped.json", SKIPPED_POLISH)]);
    assert.equal(readJson(f.reportPath).stages.polish.status, "skipped", "setup: Polish is recorded skipped");
    const currency = inputCurrency(f);
    assert.equal(currency.stages.polish, "not_applicable");
    assert.equal(currency.stages.assembly, "current", "the rebuild changed the output, so the build is current (rule 5(i))");
  });
});

test("F2.2-B1: when the target's SDK pin moves, spec derive leaves report.identity.spec_material_hash unchanged", async () => {
  await guardedLifecycle((f) => {
    scaffold(f);
    const before = readJson(f.reportPath).identity.spec_material_hash;
    const campaigns = join(f.target, "_data/campaigns.json");
    const pinned = readJson(campaigns)[f.spec.campaign.slug].sdk_version;
    mutateJson(campaigns, (entries) => {
      entries[f.spec.campaign.slug].sdk_version = "0.4.40";
    });
    assert.notEqual(pinned, "0.4.40", "setup: the target pin moves");
    const derived = runJson(["spec", "derive", "--packet", f.packetPath], f.dir);
    assert.equal(derived.status, 0, `setup: spec derive succeeds: ${derived.stderr.slice(0, 400)}`);
    assert.equal(readJson(specPathOf(f)).global_config.sdk_version, "0.4.40", "setup: spec derive wrote the moved pin into the spec");
    assert.equal(readJson(f.reportPath).identity.spec_material_hash, before);
  });
});

test("F2.2-B2: report.identity.spec_material_hash hand-set to the edited spec's value, with old stamps, reads next build", async () => {
  await guardedLifecycle(async (f) => {
    const { specMaterialHash } = await import("./spec-identity.mjs");
    recordThroughBuild(f);
    assert.equal(nextOk(f).stage, "polish", "setup: assembly is current, so next moves to polish");
    const edited = editSpec(f, bumpCheckoutQty);
    mutateJson(f.reportPath, (report) => {
      report.identity.spec_material_hash = specMaterialHash(edited);
    });
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.2-B3: after W2, record build over the unchanged _site leaves QA required", async () => {
  await guardedLifecycle(async (f) => {
    await specRefreshAfterQa(f);
    recordOk(f, "build");
    assert.equal(readJson(f.reportPath).stages.qa.status, "required");
    assert.equal(inputCurrency(f).stages.assembly, "owed", "a replay over the unchanged output leaves the build owed (rule 5)");
  }, LOCAL_SPEC);
});

// Every stage recorded, the doctor stage by doctor --write: next answers done
// and the report summary reads completed.
async function recordThroughQa(f, qa = {}) {
  await recordThroughPolish(f);
  await recordDeploy(f);
  await recordQa(f, qa);
  doctorOk(f, ["--write"]);
  assert.equal(nextOk(f).stage, "done", "setup: every stage is recorded and next answers done");
  assert.equal(readJson(f.reportPath).status, "completed", "setup: the report records completed");
}

// The readback STAGES section's stage lines, as {stage: printed status}.
function readbackStages(stdout) {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.startsWith("STAGES"));
  assert.ok(start >= 0, "setup: readback printed the STAGES section");
  const stages = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    const match = /^  ([a-z_]+)\s+(\S+)/.exec(line);
    if (match && STAGE_KEYS.includes(match[1])) stages[match[1]] = match[2];
  }
  return stages;
}

test("F2.2-B4: with every stage completed (done), a spec edit reads next build", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    editSpec(f, bumpCheckoutQty);
    assert.equal(nextOk(f).stage, "build");
  });
});

test("F2.2-B12: with every stage completed and the spec edited (no record spec), doctor --write writes report.status prepared", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    editSpec(f, bumpCheckoutQty);
    const sidecar = join(f.target, ".campaign-runtime/doctor-output.json");
    const sidecarBefore = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : null;
    doctorOk(f, ["--write"]);
    assert.notEqual(existsSync(sidecar) ? readFileSync(sidecar, "utf8") : null, sidecarBefore, "setup: doctor --write wrote its output");
    assert.equal(readJson(f.reportPath).status, "prepared");
  });
});

test("F2.2-B13: with every stage completed and the spec edited (no write), the readback STAGES header shows effective report status prepared", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    editSpec(f, bumpCheckoutQty);
    assert.equal(readJson(f.reportPath).status, "completed", "setup: the report still records completed");
    const readback = runCli(["readback", f.target, "--packet", f.packetPath], f.dir);
    assert.equal(readback.status, 0, `setup: readback ran: ${readback.stderr.slice(0, 400)}`);
    const header = readback.stdout.split("\n").find((line) => line.startsWith("STAGES"));
    assert.ok(header, "setup: readback printed the STAGES section");
    assert.equal(/;\s*effective:\s*([a-z_]+)\]/.exec(header)?.[1], "prepared", header);
  });
});

test("F2.2-B5: a page label-only edit refreshed with record spec makes assembly required", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    editSpec(f, (spec) => {
      const landing = spec.funnels.flatMap((funnel) => funnel.pages).find((page) => page.id === "landing");
      assert.ok(landing, "setup: the example spec has a landing page");
      landing.label = `${landing.label || "Landing"} (edited)`;
    });
    recordInputOk(f, "spec", "refreshed");
    assert.equal(readJson(f.reportPath).stages.assembly.status, "required");
  });
});

// The active-page edits record spec must refuse as page_scope_changed.
function pagesOf(spec) {
  return spec.funnels.flatMap((funnel) => funnel.pages);
}
for (const [id, label, edit] of [
  ["F2.2-B6", "an active page added", (spec) => {
    const funnel = spec.funnels.find((candidate) => candidate.pages.some((page) => page.id === "landing"));
    const landing = funnel.pages.find((page) => page.id === "landing");
    funnel.pages.push({ ...structuredClone(landing), id: "landing-extra", label: "Landing extra", page_url: "landing-extra/" });
  }],
  ["F2.2-B16", "two active pages swapped in order", (spec) => {
    const funnel = spec.funnels.find((candidate) => candidate.pages.length >= 2);
    assert.ok(funnel, "setup: a funnel with two pages");
    [funnel.pages[0], funnel.pages[1]] = [funnel.pages[1], funnel.pages[0]];
  }],
  ["F2.2-B17", "one active page's route changed", (spec) => {
    const upsell = pagesOf(spec).find((page) => page.id === "upsell");
    assert.ok(upsell, "setup: the example spec has an upsell page");
    upsell.page_url = "upsell-moved/";
  }],
]) {
  test(`${id}: with the brief file at the recorded brief path and ${label}, record spec refuses page_scope_changed`, async () => {
    await guardedLifecycle((f) => {
      reintakeWithBrief(f);
      editSpec(f, edit);
      assertRefusedWritingNothing(f, "spec", "page_scope_changed");
    });
  });
}

test("F2.2-B7: with the brief file at the recorded brief path and local_spec_id changed, record spec refuses spec_identity_changed", async () => {
  await guardedLifecycle((f) => {
    reintakeWithBrief(f);
    editSpec(f, (spec) => {
      spec.spec_identity = { ...spec.spec_identity, local_spec_id: "record-local-demo-two" };
    });
    assertRefusedWritingNothing(f, "spec", "spec_identity_changed");
  }, LOCAL_SPEC);
});

for (const [id, label, write] of [
  ["F2.2-B18", "a brief file of 1 MiB + 1 byte", (f) => {
    writeFileSync(briefFileOf(f), briefJsonOfSize(answeredDraft(f), 1_048_577));
    assert.equal(statSync(briefFileOf(f)).size, 1_048_577, "setup: the file is 1 MiB + 1 byte");
  }],
  ["F2.2-B19", "a brief file with 513 design_authority entries", (f) => {
    writeJson(briefFileOf(f), briefWithDesignAuthorityEntries(answeredDraft(f), 513));
    assert.ok(statSync(briefFileOf(f)).size < 1_048_576, "setup: under 1 MiB, so only the entry count can refuse it");
  }],
]) {
  test(`${id}: a spec material edit with ${label} at the recorded brief path refuses brief_too_large`, async () => {
    await guardedLifecycle((f) => {
      reintakeWithBrief(f);
      write(f);
      editSpec(f, bumpCheckoutQty);
      assertRefusedWritingNothing(f, "spec", "brief_too_large");
    });
  });
}

// F2.2-B8: the closed list of eight effective-status readers,
// each judged by its own reading of assembly, polish and qa. The completed
// records carry real completion evidence (a recorded build, a package Polish
// capture, QA with QC results that reproduce, a passing QA gate and purchase
// proof). Each reader first reads them in place (the control: every reader
// reads them current), then reads them again after they move to history[-1]
// behind a `required` stage, where a reader that took completion from
// history would read them current again.
const ARCHIVED_STAGES = Object.freeze(["assembly", "polish", "qa"]);
const LATER_THAN_BUILD = Object.freeze(["polish", "deploy", "qa", "done"]);
const CLOSEOUT_ACTION_IDS = Object.freeze(["run_end", "run_record_closeout", "run_record_present", "run_record_remit_recovery"]);

// [reader, reads any of assembly, polish, qa as current] for each reader, read
// from the report on disk. A ladder refusal reads not-current only when it is
// the refusal of the assembly prerequisite; any other outcome counts as current.
async function effectiveStatusReadings(f, { qaCurrency, fullVerdict }) {
  const { QA_GATE_PLACEHOLDER_TEXT_RESIDUE, qaGatePassedForCurrentBuild } = await import("./stage-ledger.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const { qaStandIns } = await import("./qc-test-factories.mjs");
  const readings = [];
  // 1. pickNextStage: assembly not current routes next to build.
  const next = nextOk(f);
  assert.ok(!String(next.stage).startsWith("doctor-blocked"), `setup: next answered a ladder stage: ${JSON.stringify(next.errors || [])}`);
  readings.push(["pickNextStage", LATER_THAN_BUILD.includes(next.stage)]);
  // 4. Run Record closeout's completion reader: the done branch of next's actions.
  readings.push(["run record closeout", next.stage === "done" || (next.next_actions || []).some((action) => CLOSEOUT_ACTION_IDS.includes(action.id))]);
  // 2. ladderProblems, through record polish and record deploy dry runs.
  const polishRun = record(f, "polish", ["--evidence", POLISH_EVIDENCE, "--dry-run", "--json"]);
  const polishLadder = polishRun.status === 1 && polishRun.stderr.includes("record polish refused") && polishRun.stderr.includes("stages.assembly.status");
  readings.push(["ladderProblems (record polish)", !polishLadder]);
  let deployLadder = false;
  try {
    await recordCommand({ _: ["record", "deploy"], packet: f.packetPath, "base-url": `http://127.0.0.1:4173/${f.slug}/`, "dry-run": true }, {
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: null }),
    });
  } catch (error) {
    deployLadder = String(error?.message).includes("record deploy refused") && String(error?.message).includes("stages.assembly.status");
  }
  readings.push(["ladderProblems (record deploy)", !deployLadder]);
  // 5. Progress: the snapshot next writes, one stage entry per archived stage.
  nextOk(f, ["--no-remit"]);
  const progressRoot = join(f.target, ".campaign-runtime/progress");
  const latest = readdirSync(progressRoot).map((scope) => join(progressRoot, scope, "latest.json")).filter((path) => existsSync(path));
  assert.equal(latest.length, 1, "setup: next wrote one progress snapshot");
  const progressStages = readJson(latest[0]).stages.filter((entry) => ARCHIVED_STAGES.includes(entry.stage));
  assert.deepEqual(progressStages.map((entry) => entry.stage).sort(), [...ARCHIVED_STAGES], "setup: the progress snapshot has an entry for each archived stage");
  readings.push(["progress", progressStages.some((entry) => TERMINAL_STATUSES.includes(entry.status))]);
  // 6. Readback: the STAGES lines of the three stages.
  const readback = runCli(["readback", f.target, "--packet", f.packetPath], f.dir);
  assert.equal(readback.status, 0, `setup: readback ran: ${readback.stderr.slice(0, 400)}`);
  const printed = readbackStages(readback.stdout);
  assert.deepEqual(Object.keys(printed).filter((key) => ARCHIVED_STAGES.includes(key)).sort(), [...ARCHIVED_STAGES], "setup: readback printed the three stage lines");
  readings.push(["readback", ARCHIVED_STAGES.some((key) => TERMINAL_STATUSES.includes(printed[key]))]);
  // 3. deriveAssemblyReportSummary, through doctor --write: anything but
  // `prepared` (the report keeps `completed` until the summary is derived).
  doctorOk(f, ["--write"]);
  const report = readJson(f.reportPath);
  readings.push(["deriveAssemblyReportSummary", report.status !== "prepared"]);
  // 7. and 8., in process, from the report on disk.
  const build = report.stages.assembly.build_fingerprint;
  readings.push(["qaGatePassedForCurrentBuild", qaGatePassedForCurrentBuild(report, QA_GATE_PLACEHOLDER_TEXT_RESIDUE, { buildFingerprint: build, qaCurrency }) !== false]);
  // A QA row with any result but `unexercised` is a current QA result. QA
  // results whose evidence moved to history have no current result.
  const read = readQaResults({ stageEvidence: report.stages.qa.evidence, stage: report.stages.qa, fullVerdict, currentBuild: build, qcStandIns: { qa: qaStandIns() }, qaCurrency });
  const qaRows = Array.isArray(read) ? read : read.results;
  readings.push(["readQaResults", qaRows.some((row) => row.result !== "unexercised")]);
  assert.equal(new Set(readings.map(([name]) => name.replace(/ \(.*\)$/, ""))).size, 8, "setup: all eight listed readers were read");
  return { readings, qaRows };
}

test("F2.2-B8: with assembly, polish and qa required and each history[-1] a completed record stamped with the current inputs, none of the eight readers reports them current", async () => {
  await guardedLifecycle(async (f) => {
    const { QA_GATE_PLACEHOLDER_TEXT_RESIDUE } = await import("./stage-ledger.mjs");
    const { qaAssertionFor, qaObservation, qaRowFor } = await import("./qc-test-factories.mjs");
    const at = new Date(Date.now() - 60_000).toISOString();
    const qcResults = [
      qaRowFor(qaObservation({ check: "policy.presence", key: "store_privacy", outcome: "reachable" }), { measured_at: at }),
      qaRowFor(qaObservation({ check: "policy.availability", key: "store_terms", outcome: "reachable" }), { measured_at: at }),
    ];
    await recordThroughQa(f, { qcResults, assertions: qcResults.map((row) => qaAssertionFor(row)), at });
    // The QA gate pass for the current build, as qa run records it, and the
    // verdict identity in the shape the QA QC reader pairs the full verdict by
    // (stage.identity.verdict_run_id, as src/qc-test-factories.mjs
    // installQaStage writes it).
    mutateJson(f.reportPath, (report) => {
      const qa = report.stages.qa;
      qa.identity = { verdict_run_id: qa.verdict_run_id };
      qa.evidence = { ...qa.evidence, source_build_fingerprint: report.stages.assembly.build_fingerprint, gates: { [QA_GATE_PLACEHOLDER_TEXT_RESIDUE]: { status: "pass" } } };
    });
    const completed = readJson(f.reportPath);
    const fullVerdict = readJson(completed.stages.qa.outputs[0]);

    // Control: in place, the completed records read current in every reader.
    const control = await effectiveStatusReadings(f, { qaCurrency: "current", fullVerdict });
    assert.deepEqual(control.qaRows.map((row) => row.result), ["pass", "pass"], `control: the QA results reproduce and read current in place: ${JSON.stringify(control.qaRows.map((row) => [row.id, row.result, row.reason_code]))}`);
    assert.deepEqual(control.readings.filter(([, reportsCurrent]) => !reportsCurrent), [], "control: every reader reads the completed records current in place");

    // The same records moved to history[-1], stamped with the current inputs.
    const archivedAt = new Date().toISOString();
    mutateJson(f.reportPath, (report) => {
      const stamps = { source_brief_material: structuredClone(report.build_brief?.material), source_spec_material_hash: report.identity.spec_material_hash };
      const entry = ({ history: _history, ...record }) => ({ archived_at: archivedAt, archived_by: "record spec", reason_code: "spec_material_changed", ...record, ...stamps });
      report.stages.assembly = { stage: "assembly", status: "required", required_by: "spec", required_for: ["polish", "qa"], build_fingerprint: report.stages.assembly.build_fingerprint, history: [entry(report.stages.assembly)] };
      report.stages.polish = { stage: "polish", status: "required", required_by: "spec", required_for: ["qa"], history: [entry(report.stages.polish)] };
      report.stages.qa = { stage: "qa", status: "required", required_by: "spec", required_for: [], history: [entry(report.stages.qa)] };
    });
    const report = readJson(f.reportPath);
    for (const key of ARCHIVED_STAGES) {
      assert.equal(report.stages[key].status, "required", `setup: ${key} is required`);
      assert.equal(report.stages[key].history.at(-1).status, "completed", `setup: ${key} history[-1] is a completed record`);
    }
    assert.equal(report.stages.assembly.history.at(-1).build_fingerprint, report.stages.assembly.build_fingerprint, "setup: the archived build is the current output");
    assert.equal(report.stages.polish.history.at(-1).evidence?.visual_review?.page_load?.performed_by, "campaigns-os polish capture", "setup: the archived Polish carries its package capture");
    assert.deepEqual(report.stages.qa.history.at(-1).evidence?.qc_results, completed.stages.qa.evidence.qc_results, "setup: the archived QA carries its QC results");
    assert.equal(report.stages.qa.history.at(-1).evidence.qc_results.length, 2, "setup: the archived QC results are not empty");
    assert.deepEqual(report.stages.qa.history.at(-1).evidence.gates, { [QA_GATE_PLACEHOLDER_TEXT_RESIDUE]: { status: "pass" } }, "setup: the archived QA carries its gate pass");
    assert.equal(report.stages.qa.history.at(-1).purchase_proof?.order_paths_executed, 1, "setup: the archived QA carries its purchase proof");

    const { readings } = await effectiveStatusReadings(f, { qaCurrency: "not_applicable", fullVerdict });
    assert.equal(readings.filter(([, reportsCurrent]) => reportsCurrent).length, 0, JSON.stringify(readings));
  });
});

test("F2.2-B9: with QA stamps current and the QA stage naming the Assembly Report as its full verdict, the QA rows read {evidence_not_reproducible}", async () => {
  await guardedLifecycle(async (f) => {
    const { qaObservation, qaRowFor } = await import("./qc-test-factories.mjs");
    const { readCurrentQcResults } = await import("./qc-results.mjs");
    const measuredAt = new Date(Date.now() - 60_000).toISOString();
    const rows = [
      qaRowFor(qaObservation({ check: "policy.availability", key: "store_terms", outcome: "unreachable" }), { measured_at: measuredAt }),
      qaRowFor(qaObservation({ check: "policy.presence", key: "store_privacy", outcome: "reachable" }), { measured_at: measuredAt }),
    ];
    await recordQa(f, { qcResults: rows, selfReferential: true });
    const report = readJson(f.reportPath);
    assert.equal(report.stages.qa.outputs[0], f.reportPath, "setup: the QA stage names the Assembly Report as its full verdict");
    const { results } = readCurrentQcResults({ report, doctor: { derived: { qc_results: [] } }, targetRepo: f.target, packetPath: f.packetPath, reportPath: f.reportPath });
    const qaRows = results.filter((row) => row.leg === "qa");
    assert.equal(qaRows.length, 2, "setup: both QA rows are read");
    assert.deepEqual([...new Set(qaRows.map((row) => row.reason_code))], ["evidence_not_reproducible"]);
  });
});

test("F2.2-B10: on a gateway-fetched packet whose cached spec qty is edited, doctor warns spec.material_stale", async () => {
  await guardedLifecycle((f) => {
    const packet = readJson(f.packetPath);
    assert.ok(packet.spec.map_id, "setup: a Map packet");
    const cached = join(f.target, ".campaign-runtime/fetched-specs", `${packet.spec.map_id}.json`);
    mkdirSync(dirname(cached), { recursive: true });
    cpSync(specPathOf(f), cached);
    mutateJson(f.packetPath, (value) => {
      value.spec.local_path = ".campaign-runtime/fetched-specs/" + `${packet.spec.map_id}.json`;
    });
    assert.equal(doctorOk(f).warnings.some((issue) => issue.code === "spec.material_stale"), false, "setup: the cached copy matches the bound material");
    mutateJson(cached, bumpCheckoutQty);
    const doctorJson = doctorOk(f);
    assert.equal(doctorJson.warnings.some((issue) => issue.code === "spec.material_stale"), true, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
  });
});

test("F2.2-B11: after F2.1-W24, record polish with the pre-change evidence file, the old page_load still binding the same build, leaves polish owed", CLOSES_AFTER_D, async () => {
  await guardedLifecycle(async (f) => {
    let before = null;
    await presentationChangeAfterQa(f, (report) => {
      before = { pageLoad: report.stages.polish.evidence.visual_review.page_load, build: report.stages.assembly.build_fingerprint };
    });
    recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
    recordOk(f, "polish", ["--evidence", POLISH_EVIDENCE]);
    const report = readJson(f.reportPath);
    assert.equal(report.stages.polish.status, "completed", "setup: record polish recorded Polish");
    assert.equal(report.stages.assembly.build_fingerprint, before.build, "setup: the build is the one the old capture bound");
    assert.deepEqual(report.stages.polish.evidence.visual_review.page_load, before.pageLoad, "setup: the old package page_load is still attached");
    const currency = inputCurrency(f);
    assert.equal(currency.stages.polish, "owed");
    assert.equal(currency.stages.assembly, "current", "the operator's --deviation-reason build is current (rule 5(ii))");
  });
});

// F2.2-B20: Polish recorded, the spec edited (no record spec), then record
// build over the byte-identical _site.
async function specEditReplaysBuild(f) {
  await recordThroughPolish(f);
  editSpec(f, bumpCheckoutQty);
  recordOk(f, "build");
}

test("F2.2-B20: with the spec edited and no record spec, record build over the byte-identical _site reads reason output_unchanged_after_input_change", async () => {
  await guardedLifecycle(async (f) => {
    await specEditReplaysBuild(f);
    const currency = inputCurrency(f);
    assert.equal(currency.reasons.assembly, "output_unchanged_after_input_change");
    assert.equal(currency.stages.assembly, "owed", "a replay over the byte-identical output leaves the build owed (rule 5)");
  });
});

test("F2.2-B21: as B20, Polish is required", async () => {
  await guardedLifecycle(async (f) => {
    await specEditReplaysBuild(f);
    assert.equal(readJson(f.reportPath).stages.polish.status, "required");
    assert.equal(inputCurrency(f).stages.assembly, "owed", "a replay over the byte-identical output leaves the build owed (rule 5)");
  });
});

test("F2.2-B24: after W2, a changed rebuild, a capture, a second spec edit, an operator --deviation-reason build and record polish with that capture leave polish owed", async () => {
  await guardedLifecycle(async (f) => {
    await specRefreshAfterQa(f);
    buildSite(f, " (rebuilt for the qty change)");
    recordOk(f, "build");
    await capture(f);
    editSpec(f, bumpCheckoutQty);
    recordOk(f, "build", ["--deviation-reason", OPERATOR_DECISION]);
    recordOk(f, "polish", ["--evidence", POLISH_EVIDENCE]);
    assert.equal(readJson(f.reportPath).stages.polish.status, "completed", "setup: record polish recorded Polish with the capture");
    const currency = inputCurrency(f);
    assert.equal(currency.stages.polish, "owed");
    assert.equal(currency.stages.assembly, "current", "the operator's --deviation-reason build is current (rule 5(ii))");
  }, LOCAL_SPEC);
});

test("F2.2-I2: with the spec file truncated (invalid JSON), next answers doctor-blocked", async () => {
  await guardedLifecycle((f) => {
    const text = readFileSync(specPathOf(f), "utf8");
    writeFileSync(specPathOf(f), text.slice(0, Math.floor(text.length / 2)));
    assert.throws(() => JSON.parse(readFileSync(specPathOf(f), "utf8")), "setup: the spec no longer parses");
    assert.equal(nextOk(f).stage, "doctor-blocked");
  });
});

test("F2.2-I4: record spec --dry-run after a material edit leaves the report sha256 unchanged", async () => {
  await guardedLifecycle((f) => {
    editSpec(f, bumpCheckoutQty);
    const before = sha256File(f.reportPath);
    const dry = recordInputOk(f, "spec", "refreshed", ["--dry-run"]);
    assert.equal(dry.dry_run, true, "setup: the dry run ran");
    assert.equal(sha256File(f.reportPath), before);
  });
});

test("F2.2-I5: on a guided draft (no brief file), a spec payment-methods change refreshed with record spec archives assembly as spec_material_changed", async () => {
  await guardedLifecycle((f) => {
    assert.equal(readJson(f.contextPath).build_brief.input_path, null, "setup: the brief is the generated guided draft");
    recordThroughBuild(f);
    editSpec(f, (spec) => {
      const methods = spec.campaign.available_payment_methods;
      assert.ok(Array.isArray(methods) && methods.length > 0, "setup: the spec declares payment methods");
      spec.campaign.available_payment_methods = methods.length > 1 ? methods.slice(1) : [...methods, "paypal"];
    });
    recordInputOk(f, "spec", "refreshed");
    const history = readJson(f.reportPath).stages.assembly.history;
    assert.ok(Array.isArray(history) && history.length > 0, "stages.assembly.history[] holds the superseded record");
    assert.equal(history.at(-1).reason_code, "spec_material_changed");
  });
});

test("F2.2-I6: on a saved-Map packet with a readable cache, input_currency.spec.remote_currency is unconfirmed", async () => {
  await guardedLifecycle((f) => {
    assert.ok(readJson(f.packetPath).spec.map_id, "setup: a saved-Map packet");
    assert.ok(existsSync(specPathOf(f)), "setup: the cached spec is readable");
    assert.equal(inputCurrency(f).spec?.remote_currency, "unconfirmed");
  });
});

// F2.2-I7: material equal to the bound identity, the assembly spec stamp removed.
function specStampMissing(f) {
  recordThroughBuild(f);
  mutateJson(f.reportPath, (report) => {
    delete report.stages.assembly.source_spec_material_hash;
  });
  return recordInputOk(f, "spec", "unchanged");
}

test("F2.2-I7: with the material equal to the bound identity and the assembly spec stamp missing, record spec reads unchanged", async () => {
  await guardedLifecycle((f) => {
    specStampMissing(f);
  });
});

test("F2.2-I8: as I7, the binding_unknown notice names exactly [\"assembly\"]", async () => {
  await guardedLifecycle((f) => {
    const result = specStampMissing(f);
    const notices = (result.notices || []).filter((notice) => notice.code === "binding_unknown");
    assert.equal(notices.length, 1, `one binding_unknown notice: ${JSON.stringify(result.notices)}`);
    assert.deepEqual(notices[0].stages, ["assembly"]);
  });
});

test("F2.2-I9: record spec --dry-run --lifecycle-journal after a material edit adds no journal line", async () => {
  await guardedLifecycle((f) => {
    const journal = join(f.dir, "lifecycle.jsonl");
    scaffold(f);
    recordOk(f, "setup", ["--lifecycle-journal", journal]);
    const before = journalLines(journal);
    assert.ok(before > 0, "setup: a recorded command journals to this file");
    editSpec(f, bumpCheckoutQty);
    const dry = recordInputOk(f, "spec", "refreshed", ["--dry-run", "--lifecycle-journal", journal]);
    assert.equal(dry.dry_run, true, "setup: the dry run ran");
    assert.equal(journalLines(journal), before);
  });
});

test("F2.2-I10: a legacy report with unstamped completed stages makes doctor warn spec.binding_unknown", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughPolish(f);
    legacyAssembly(f);
    const doctorJson = doctorOk(f);
    assert.equal(doctorJson.warnings.some((issue) => issue.code === "spec.binding_unknown"), true, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
  });
});

test("F2.2-I11: with the brief file at the recorded brief path and the spec truncated (invalid JSON), record spec refuses spec_unreadable", async () => {
  await guardedLifecycle((f) => {
    reintakeWithBrief(f);
    const text = readFileSync(specPathOf(f), "utf8");
    writeFileSync(specPathOf(f), text.slice(0, Math.floor(text.length / 2)));
    assertRefusedWritingNothing(f, "spec", "spec_unreadable");
  });
});

test("F2.2-I12: intake ran with --brief <file>, the file is deleted and the spec edited: record spec refuses brief_file_missing", async () => {
  await guardedLifecycle((f) => {
    const explicit = join(f.dir, "explicit-brief.json");
    writeJson(explicit, answeredDraft(f));
    reintake(f, ["--brief", explicit]);
    assert.ok(readJson(f.contextPath).intake.brief_path, "setup: the Build Context records the --brief path");
    rmSync(explicit);
    editSpec(f, bumpCheckoutQty);
    assertRefusedWritingNothing(f, "spec", "brief_file_missing");
  });
});

// ----- effective status in progress, record spec outcome and brief paths -----

// The stage statuses of the progress snapshot `next` writes.
function progressStatuses(f) {
  nextOk(f, ["--no-remit"]);
  const progressRoot = join(f.target, ".campaign-runtime/progress");
  const latest = readdirSync(progressRoot).map((scope) => join(progressRoot, scope, "latest.json")).filter((path) => existsSync(path));
  assert.equal(latest.length, 1, "setup: next wrote one progress snapshot");
  return Object.fromEntries(readJson(latest[0]).stages.map((entry) => [entry.stage, entry.status]));
}

test("progress reports build, Polish and QA owed by a CampaignSpec edit as required, as doctor reads them, not unknown", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    editSpec(f, bumpCheckoutQty);
    const currency = inputCurrency(f);
    assert.deepEqual([currency.stages.assembly, currency.stages.polish, currency.stages.qa], ["owed", "owed", "owed"], "setup: doctor reads build, Polish and QA owed");
    const statuses = progressStatuses(f);
    assert.deepEqual([statuses.assembly, statuses.polish, statuses.qa], ["required", "required", "required"]);
    assert.equal(statuses.setup, "completed", "setup carries no input stamps and keeps its recorded status");
  }, LOCAL_SPEC);
});

// A presentation edit made to the normalized brief itself, not to a brief file.
function editNormalizedPresentation(f) {
  mutateJson(normalizedOf(f), (brief) => {
    brief.brand.cta_style = `${brief.brand.cta_style || "solid"} (edited in the normalized brief)`;
  });
}

for (const [label, prepare] of [
  ["the guided draft", () => {}],
  ["the recorded brief file", (f) => reintakeWithBrief(f)],
]) {
  test(`record spec re-derives the brief from ${label} when a brief stamp reads owed, and then reads unchanged`, async () => {
    await guardedLifecycle((f) => {
      prepare(f);
      recordThroughBuild(f);
      editNormalizedPresentation(f);
      const before = inputCurrency(f);
      assert.equal(before.stages.assembly, "owed", "setup: the normalized brief edit makes the build owed");
      assert.equal(before.reasons.assembly, "brief_material_changed", "setup: owed on the brief, not the spec");
      recordInputOk(f, "spec", "refreshed");
      const after = inputCurrency(f);
      assert.ok(!Object.values(after.stages).includes("owed"), `no stage still reads owed: ${JSON.stringify(after.stages)}`);
      recordInputOk(f, "spec", "unchanged");
    });
  });
}

test("record spec reads refreshed, never unchanged, while any stamp reads owed, and a dry run writes nothing", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    editNormalizedPresentation(f);
    const before = treeDigest(f.dir);
    const dry = recordInputOk(f, "spec", "refreshed", ["--dry-run"]);
    assert.equal(dry.dry_run, true);
    assertNothingWritten(f.dir, before, "the record spec dry run");
  });
});

// The brief file intake recorded, replaced by `replace` after the spec edit.
function recordedBriefReplaced(f, replace) {
  reintakeWithBrief(f);
  editSpec(f, bumpCheckoutQty);
  const path = briefFileOf(f);
  rmSync(path);
  return replace(path);
}

// A symlink at `path` to a file without read permission, kept outside the
// fixture directory so the written-nothing digest never reads it. The file
// holds `content`. Returns the cleanup.
function unreadableAt(path, content = "{}\n") {
  const outside = mkdtempSync(join(tmpdir(), "campaigns-os-unreadable-"));
  const file = join(outside, "campaign-build-brief.json");
  writeFileSync(file, content);
  chmodSync(file, 0o000);
  symlinkSync(file, path);
  return () => rmSync(outside, { recursive: true, force: true });
}

// Each replacement returns its cleanup, or nothing.
const NOT_A_READABLE_FILE = [
  ["a directory", (path) => { mkdirSync(path); }],
  ["a named pipe", (path) => { assert.equal(spawnSync("mkfifo", [path]).status, 0, "setup: mkfifo made the pipe"); }],
  ["an unreadable file", unreadableAt],
];

for (const [label, replace] of NOT_A_READABLE_FILE) {
  test(`record spec refuses brief_file_missing when the recorded brief path is ${label}`, async () => {
    await guardedLifecycle((f) => {
      const cleanup = recordedBriefReplaced(f, replace);
      try {
        assertRefusedWritingNothing(f, "spec", "brief_file_missing");
      } finally {
        cleanup?.();
      }
    });
  });

  test(`record spec refuses brief_file_missing, not unchanged, when the spec is unedited and the recorded brief path is ${label}`, async () => {
    await guardedLifecycle((f) => {
      reintakeWithBrief(f);
      const path = briefFileOf(f);
      rmSync(path);
      const cleanup = replace(path);
      try {
        assertRefusedWritingNothing(f, "spec", "brief_file_missing");
      } finally {
        cleanup?.();
      }
    });
  });

  test(`record brief refuses brief_file_missing when --brief names ${label}`, async () => {
    await guardedLifecycle((f) => {
      const path = join(f.dir, "operator-brief.json");
      const cleanup = replace(path);
      try {
        assertRefusedWritingNothing(f, "brief", "brief_file_missing", ["--brief", path]);
      } finally {
        cleanup?.();
      }
    });
  });
}

test("record brief refuses brief_file_missing when the discovered brief file cannot be read", async () => {
  await guardedLifecycle((f) => {
    const cleanup = unreadableAt(briefFileOf(f));
    try {
      assertRefusedWritingNothing(f, "brief", "brief_file_missing");
    } finally {
      cleanup();
    }
  });
});

// ----- Stage records across a forced intake, a cosmetic save and the ladder --

test("prepare-build --force over completed build, Polish and QA with a changed spec archives all three records and records the input change", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    const before = readJson(f.reportPath).stages;
    assert.equal(before.qa.purchase_proof?.order_paths_executed, 1, "setup: QA carries purchase proof");
    editSpec(f, bumpCheckoutQty);
    reintake(f, ["--force"]);
    const { stages } = readJson(f.reportPath);
    for (const key of ["assembly", "polish", "qa"]) {
      const entry = stages[key].history?.at(-1);
      assert.equal(entry?.archived_by, "prepare-build --force", `stages.${key}.history[-1] is the record --force replaced: ${JSON.stringify(stages[key]).slice(0, 400)}`);
      assert.equal(entry.reason_code, "force_reset");
      assert.equal(entry.status, before[key].status, `the archived ${key} record keeps its status`);
      assert.equal(stages[key].input_change?.reason, "spec_material_changed", `stages.${key}.input_change records the spec change`);
    }
    assert.equal(stages.assembly.history.at(-1).build_fingerprint, before.assembly.build_fingerprint);
    assert.equal(stages.qa.history.at(-1).verdict_run_id, before.qa.verdict_run_id, "the archived QA record keeps its verdict");
    assert.deepEqual(stages.qa.history.at(-1).purchase_proof, before.qa.purchase_proof, "the archived QA record keeps its purchase proof");
  });
});

// Each stage's input stamps, serialized, keyed by stage.
function stageStamps(f) {
  const { stages } = readJson(f.reportPath);
  return Object.fromEntries(STAGE_KEYS.map((key) => [key, Object.fromEntries(["source_brief_material", "source_spec_material_hash"]
    .filter((field) => Object.hasOwn(stages[key] || {}, field))
    .map((field) => [field, JSON.stringify(stages[key][field])]))]));
}

test("a reformatted brief save leaves every stage's input stamps unchanged and an unconfirmed completed build unconfirmed", async () => {
  await guardedLifecycle((f) => {
    saveBrief(f, answeredDraft(f));
    recordThroughBuild(f);
    mutateJson(f.reportPath, (report) => {
      delete report.stages.assembly.source_brief_material;
    });
    assert.equal(inputCurrency(f).stages.assembly, "unknown", "setup: the build without a brief stamp is unconfirmed");
    const before = stageStamps(f);
    writeFileSync(briefFileOf(f), `${JSON.stringify(reverseKeys(readJson(briefFileOf(f))), null, 2)}\n`);
    recordInputOk(f, "brief", "saved");
    assert.deepEqual(stageStamps(f), before, "no stage's input stamps change");
    assert.equal(readJson(f.reportPath).stages.assembly.status, "completed");
    assert.equal(inputCurrency(f).stages.assembly, "unknown", "the build stays unconfirmed, not current");
    assert.equal(nextOk(f).stage, "build");
  });
});

// The fixed refusal order puts the size check before the readability check.
function oversizedUnreadableAt(f) {
  const content = briefJsonOfSize(answeredDraft(f), 1_048_577);
  return (path) => {
    const cleanup = unreadableAt(path, content);
    assert.equal(statSync(path).size, 1_048_577, "setup: the brief file is 1 MiB + 1 byte");
    assert.throws(() => readFileSync(path), { code: "EACCES" }, "setup: the brief file cannot be read");
    return cleanup;
  };
}

test("record brief refuses an oversized brief file it also cannot read with brief_too_large", async () => {
  await guardedLifecycle((f) => {
    const cleanup = oversizedUnreadableAt(f)(briefFileOf(f));
    try {
      assertRefusedWritingNothing(f, "brief", "brief_too_large");
    } finally {
      cleanup();
    }
  });
});

test("record spec refuses with brief_too_large when the recorded brief file is oversized and cannot be read", async () => {
  await guardedLifecycle((f) => {
    const cleanup = recordedBriefReplaced(f, oversizedUnreadableAt(f));
    try {
      assertRefusedWritingNothing(f, "spec", "brief_too_large");
    } finally {
      cleanup();
    }
  });
});

test("next answers qa when a qa_policy change after the QA verdict leaves build and Polish current and QA's recorded status completed", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    mutateJson(normalizedOf(f), (brief) => {
      brief.qa_policy.require_checkout_flow = !brief.qa_policy.require_checkout_flow;
    });
    assert.deepEqual(inputCurrency(f).stages, { assembly: "current", polish: "current", qa: "owed" }, "setup: only QA is owed");
    assert.deepEqual(stageStatuses(f, ["assembly", "polish", "qa"]), { assembly: "completed", polish: "completed", qa: "completed" }, "setup: every recorded status stays completed");
    assert.equal(nextOk(f).stage, "qa");
  });
});

test("a presentation change saved with record brief after a QA verdict demotes QA as well as build and Polish", async () => {
  await guardedLifecycle(async (f) => {
    await recordThroughQa(f);
    const before = readJson(f.reportPath);
    const saved = saveBrief(f, answeredDraft(f));
    const after = readJson(f.reportPath);
    assert.equal(saved.input_change?.reason, "brief_presentation_changed", "setup: the save is a presentation change");
    assert.equal(after.build_brief.material.qa_policy, before.build_brief.material.qa_policy, "setup: qa_policy is unchanged, so only presentation reaches QA");
    assert.deepEqual([...saved.demoted].sort(), ["assembly", "polish", "qa"]);
    assert.equal(after.stages.qa.status, "required");
    assert.equal(after.stages.qa.required_by, "brief");
    assert.equal(after.stages.qa.history?.at(-1)?.reason_code, "brief_presentation_changed");
    assert.equal(after.stages.qa.history.at(-1).verdict_run_id, before.stages.qa.verdict_run_id);
  });
});

// ----- current QC results, replay protection, the saved brief source, usage -----

// The QA QC rows `next` and `checkpoint accept` read, through the same
// aggregate and a real doctor run, as [result, reason_code] pairs.
async function currentQaRows(f) {
  const { readCurrentQcResults } = await import("./qc-results.mjs");
  const { qaStandIns } = await import("./qc-test-factories.mjs");
  const { results } = readCurrentQcResults({
    report: readJson(f.reportPath),
    doctor: doctorOk(f),
    spec: readJson(specPathOf(f)),
    targetRepo: f.target,
    packetPath: f.packetPath,
    reportPath: f.reportPath,
    qcStandIns: { qa: qaStandIns() },
  });
  return results.filter((row) => row.leg === "qa").map((row) => [row.result, row.reason_code]);
}

test("after a material CampaignSpec edit, the QA QC rows next and checkpoint accept read are stale_binding, not pass", async () => {
  await guardedLifecycle(async (f) => {
    const { qaAssertionFor, qaObservation, qaRowFor } = await import("./qc-test-factories.mjs");
    const at = new Date(Date.now() - 60_000).toISOString();
    const qcResults = [
      qaRowFor(qaObservation({ check: "policy.presence", key: "store_privacy", outcome: "reachable" }), { measured_at: at }),
      qaRowFor(qaObservation({ check: "policy.availability", key: "store_terms", outcome: "reachable" }), { measured_at: at }),
    ];
    await recordThroughQa(f, { qcResults, assertions: qcResults.map((row) => qaAssertionFor(row)), at });
    mutateJson(f.reportPath, (report) => {
      report.stages.qa.identity = { verdict_run_id: report.stages.qa.verdict_run_id };
    });
    assert.deepEqual(await currentQaRows(f), [["pass", null], ["pass", null]], "control: with current inputs both QA rows read pass");
    editSpec(f, bumpCheckoutQty);
    assert.equal(inputCurrency(f).stages.qa, "owed", "setup: doctor reads QA owed");
    assert.deepEqual(await currentQaRows(f), [["unexercised", "stale_binding"], ["unexercised", "stale_binding"]]);
  });
});

test("a brief save after prepare-build --force keeps the superseded build, so an unchanged rebuild still leaves assembly owed", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    const built = readJson(f.reportPath).stages.assembly.build_fingerprint;
    editSpec(f, bumpCheckoutQty);
    reintake(f, ["--force"]);
    recordOk(f, "setup");
    assert.equal(readJson(f.reportPath).stages.assembly.input_change?.superseded_build_fingerprint, built, "setup: forced intake records the superseded build");
    saveBrief(f, answeredDraft(f));
    assert.equal(readJson(f.reportPath).stages.assembly.input_change?.superseded_build_fingerprint, built, "the save keeps the superseded build");
    recordOk(f, "build");
    assert.equal(readJson(f.reportPath).stages.assembly.build_fingerprint, built, "setup: the rebuild is the superseded output");
    const currency = inputCurrency(f);
    assert.equal(currency.stages.assembly, "owed");
    assert.equal(currency.reasons.assembly, "output_unchanged_after_input_change");
  });
});

for (const [label, save] of [
  ["a new --brief file", (f, second) => {
    const path = join(f.dir, "second-brief.json");
    writeJson(path, second);
    recordInputOk(f, "brief", "saved_with_invalidation", ["--brief", path]);
    return path;
  }],
  ["a brief file found in the target", (f, second) => {
    writeJson(briefFileOf(f), second);
    recordInputOk(f, "brief", "saved_with_invalidation");
    return null;
  }],
]) {
  test(`after intake with --brief, record spec re-derives the brief from ${label} that record brief saved`, async () => {
    await guardedLifecycle((f) => {
      const audience = (value) => {
        const brief = answeredDraft(f);
        brief.campaign_intent.audience = value;
        return brief;
      };
      const first = join(f.dir, "first-brief.json");
      writeJson(first, audience("first audience"));
      reintake(f, ["--brief", first]);
      assert.equal(readJson(normalizedOf(f)).campaign_intent.audience, "first audience", "setup: intake read the first brief");
      const saved = save(f, audience("second audience"));
      assert.equal(readJson(normalizedOf(f)).campaign_intent.audience, "second audience", "setup: record brief saved the second brief");
      editSpec(f, (spec) => {
        const landing = spec.funnels.flatMap((funnel) => funnel.pages).find((page) => page.id === "landing");
        landing.label = `${landing.label || "Landing"} (edited)`;
      });
      recordInputOk(f, "spec", "refreshed");
      assert.equal(readJson(normalizedOf(f)).campaign_intent.audience, "second audience");
      const recorded = readJson(f.contextPath).intake.brief_path;
      if (saved) assert.equal(resolve(f.target, recorded), resolve(saved), "the Build Context records the saved --brief file");
      else assert.equal(recorded, null, "the Build Context no longer records the first --brief file");
    });
  });
}

test("record with an unknown subcommand names every record subcommand, brief and spec included", () => {
  const result = runCli(["record", "bogus", "--packet", "campaign-runtime.build.json"], ROOT);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /record <setup\|build\|polish\|theme\|deploy\|brief\|spec>/);
});

// ----- record spec without brief inputs, and doctor over unreadable inputs ----

for (const [label, drop] of [
  ["commerce_zone_findings", (context) => { delete context.commerce_zone_findings; }],
  ["page_map", (context) => { delete context.page_map; }],
  ["source.asset_crawl", (context) => { delete context.source.asset_crawl; }],
]) {
  for (const extra of [[], ["--dry-run"]]) {
    test(`record spec ${extra.join(" ")} after a spec edit, over a Build Context without ${label}, refuses brief_inputs_unavailable and writes nothing`.replace("spec  ", "spec "), async () => {
      await guardedLifecycle((f) => {
        editSpec(f, bumpCheckoutQty);
        mutateJson(f.contextPath, drop);
        const before = treeDigest(f.dir);
        const result = recordInput(f, "spec", extra);
        assertRecordRefusal(result, "spec", "brief_inputs_unavailable");
        assert.match(result.stderr, new RegExp(`brief_inputs_unavailable: the Build Context lacks ${label.replace(".", "\\.")}\\b`));
        assertNothingWritten(f.dir, before, "the refused record spec");
      });
    });
  }
}

// Makes `path` unreadable (`chmod 000`) or not JSON for the length of `run`.
function withInputSpoiled(path, how, run) {
  const bytes = readFileSync(path);
  if (how === "unreadable") chmodSync(path, 0o000);
  else writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
  try {
    return run();
  } finally {
    chmodSync(path, 0o644);
    writeFileSync(path, bytes);
  }
}

for (const how of ["unreadable", "not JSON"]) {
  test(`doctor warns build_brief.binding_unknown naming the normalized brief when it is ${how} and a recorded build reads unknown for that reason`, async () => {
    await guardedLifecycle((f) => {
      recordThroughBuild(f);
      const doctorJson = withInputSpoiled(normalizedOf(f), how, () => doctorOk(f));
      assert.equal(doctorJson.derived.input_currency.stages.assembly, "unknown", "setup: the build reads unknown");
      const warning = doctorJson.warnings.find((issue) => issue.code === "build_brief.binding_unknown");
      assert.ok(warning, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
      assert.match(warning.message, /campaign-build-brief\.normalized\.json/);
      assert.match(warning.message, /cannot be read/);
      assert.deepEqual(warning.detail?.stages, ["assembly"]);
    });
  });

  test(`doctor warns spec.binding_unknown naming the CampaignSpec when it is ${how} and a recorded build reads unknown for that reason`, async () => {
    await guardedLifecycle((f) => {
      recordThroughBuild(f);
      const doctorJson = withInputSpoiled(specPathOf(f), how, () => doctorOk(f));
      assert.equal(doctorJson.derived.input_currency.stages.assembly, "unknown", "setup: the build reads unknown");
      const warning = doctorJson.warnings.find((issue) => issue.code === "spec.binding_unknown");
      assert.ok(warning, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
      assert.match(warning.message, /campaignspec\.json/);
      assert.match(warning.message, /cannot be read/);
      assert.deepEqual(warning.detail?.stages, ["assembly"]);
    });
  });
}

// One stage with well-formed stamps (assembly) and one with malformed stamps
// (polish), while one input cannot be read: each stage is named once per
// input, by the cause that applies to it.
for (const [code, input, spoiled, fileWord] of [
  ["build_brief.binding_unknown", "brief", normalizedOf, /campaign-build-brief\.normalized\.json/],
  ["spec.binding_unknown", "CampaignSpec", specPathOf, /campaignspec\.json/],
]) {
  test(`doctor names each stage once in ${code} when one stage's stamp is malformed and the ${input} cannot be read`, async () => {
    await guardedLifecycle((f) => {
      recordThroughBuild(f);
      mutateJson(f.reportPath, (report) => {
        report.stages.polish = { ...report.stages.polish, status: "completed", source_brief_material: { presentation: "malformed" }, source_spec_material_hash: "malformed" };
      });
      const doctorJson = withInputSpoiled(spoiled(f), "not JSON", () => doctorOk(f));
      assert.equal(doctorJson.derived.input_currency.stages.assembly, "unknown", "setup: the build reads unknown");
      assert.equal(doctorJson.derived.input_currency.stages.polish, "unknown", "setup: Polish reads unknown");
      const warnings = doctorJson.warnings.filter((issue) => issue.code === code);
      const byStamp = warnings.filter((issue) => /does not say which/.test(issue.message));
      const byFile = warnings.filter((issue) => /cannot be read/.test(issue.message));
      assert.equal(warnings.length, 2, `one ${code} per cause: ${JSON.stringify(warnings)}`);
      assert.equal(byStamp.length, 1, `one ${code} names the malformed stamp: ${JSON.stringify(warnings)}`);
      assert.equal(byFile.length, 1, `one ${code} names the unreadable ${input}: ${JSON.stringify(warnings)}`);
      assert.deepEqual(byStamp[0].detail?.stages, ["polish"], "the malformed stamp names Polish only");
      assert.deepEqual(byFile[0].detail?.stages, ["assembly"], "the unreadable file names the stage whose stamp is well-formed only");
      assert.match(byFile[0].message, fileWord);
    });
  });
}

test("doctor names no unreadable input when the brief and the CampaignSpec read and the build is current", async () => {
  await guardedLifecycle((f) => {
    recordThroughBuild(f);
    const doctorJson = doctorOk(f);
    assert.equal(doctorJson.derived.input_currency.stages.assembly, "current", "setup: the build is current");
    assert.deepEqual(inputWarnings(doctorJson), []);
  });
});

for (const [label, replace] of NOT_A_READABLE_FILE) {
  test(`doctor warns build_brief.input_unsaved, and does not fail, when the saved brief file is ${label}`, async () => {
    await guardedLifecycle((f) => {
      reintakeWithBrief(f);
      const path = briefFileOf(f);
      rmSync(path);
      const cleanup = replace(path);
      try {
        const run = spawnSync(process.execPath, [CLI, "doctor", "--packet", f.packetPath, "--no-live-refs", "--json"], {
          cwd: f.dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" },
        });
        assert.equal(run.error, undefined, `doctor finished: ${run.error?.message}`);
        assert.ok(run.stdout.trim(), `doctor printed its result (exit ${run.status}): ${String(run.stderr).slice(0, 400)}`);
        const doctorJson = JSON.parse(run.stdout);
        const warning = doctorJson.warnings.find((issue) => issue.code === "build_brief.input_unsaved");
        assert.ok(warning, JSON.stringify(doctorJson.warnings.map((issue) => issue.code)));
        assert.match(warning.message, /campaign-build-brief\.json/);
        assert.match(warning.message, /cannot be read|not a regular file|directory/);
      } finally {
        cleanup?.();
      }
    });
  });
}
