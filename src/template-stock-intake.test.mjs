import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveAssemblyReportSummary } from "./stage-ledger.mjs";

// Template-stock intake on a family without published Template Reference
// proof, proven on the two-step fixture family. Two mechanics:
//
//   (a) `--design-manifest <path>` reads the source-html manifest from outside
//       the source root, so a read-only source tree still gets its skip
//       declarations and screenshot proof from a file the operator owns;
//   (b) a page declared out of source scope is template stock: intake records
//       `template_stock: true` (and the locked family) on its assembly
//       decision, the Design Source Package carries an accepted coverage gap
//       for it instead of a Template Reference TODO the operator cannot
//       clear, and the TODO that still fires for an undeclared page names the
//       family the packet locked rather than the CampaignSpec hint.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const FIXTURE_SPEC = resolve(ROOT, "contracts/fixtures/campaign-specs/olympus-mv-two-step-configurable.json");
const FAMILY = "olympus-mv-two-step";
const DSP_REL_PATH = ".campaign-runtime/input/design-source-package.json";
const REPORT_REL_PATH = ".campaign-runtime/assembly-report.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Every fixture page except `select` gets prepared HTML plus attested desktop
// and mobile captures; `select` is the template-stock page under test. The
// manifest is written either at the default in-tree path or to a directory
// beside the source root (`external`), which then has no `.campaigns-os/`.
function withFixture(run, { external = false, hint = null, declareSelect = true, stockPageIds = ["select"], selectLast = false, buildScope = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-template-stock-"));
  try {
    const source = join(dir, "source");
    const target = join(dir, "target");
    const specPath = join(dir, "campaignspec.json");
    mkdirSync(join(source, "_ref"), { recursive: true });
    mkdirSync(target, { recursive: true });

    const spec = readJson(FIXTURE_SPEC);
    if (hint) spec.spec_identity.preferred_template_family = hint;
    // With a CampaignSpec build_scope the stock pages are declared by the
    // spec, not by manifest skip entries.
    if (buildScope) spec.build_scope = buildScope;
    // The packet's page mapping follows CampaignSpec order. Listing the select
    // step last tells a consumer that orders template-stock pages by role
    // apart from one that merely echoes the mapping.
    if (selectLast) {
      const funnelPages = spec.funnels[0].pages;
      funnelPages.push(...funnelPages.splice(funnelPages.findIndex((page) => page.id === "select"), 1));
    }
    writeJson(specPath, spec);

    const pages = [];
    const skips = [];
    for (const page of spec.funnels[0].pages) {
      if (stockPageIds.includes(page.id)) {
        if (declareSelect && !buildScope) skips.push({ page_id: page.id, skip_reason: `Template-stock ${page.id} step; the family's own page is the design.` });
        continue;
      }
      const html = `<main><h1>${page.id}</h1></main>\n`;
      const desktop = `desktop-${page.id}`;
      const mobile = `mobile-${page.id}`;
      writeFileSync(join(source, `${page.id}.html`), html);
      writeFileSync(join(source, `_ref/${page.id}-desktop.png`), desktop);
      writeFileSync(join(source, `_ref/${page.id}-mobile.png`), mobile);
      pages.push({
        page_id: page.id,
        path: `${page.id}.html`,
        source_hash: sha256(html),
        screenshots: [
          { id: `source-${page.id}-desktop`, kind: "source_screenshot", viewport: "desktop", availability: "available", path: `_ref/${page.id}-desktop.png`, sha256: sha256(desktop) },
          { id: `source-${page.id}-mobile`, kind: "source_screenshot", viewport: "mobile", availability: "available", path: `_ref/${page.id}-mobile.png`, sha256: sha256(mobile) },
        ],
      });
    }
    const manifest = { schema_version: "source-html-manifest/v0", generator: "fixture-exporter@1.0.0", pages: [...pages, ...skips] };
    const manifestPath = external
      ? join(dir, "handoff", "design-manifest.json")
      : join(source, ".campaigns-os", "source-html-manifest.json");
    writeJson(manifestPath, manifest);
    writeJson(join(target, "package.json"), { private: true });

    return run({ dir, source, target, specPath, manifestPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, cwd) {
  const result = spawnSync("node", [CLI, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" },
  });
  const stdout = String(result.stdout || "");
  let json = null;
  try {
    json = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { status: result.status, stdout, stderr: String(result.stderr || ""), json };
}

function runPrepare(fixture, extraArgs = []) {
  return runCli([
    "prepare-build",
    "--spec", fixture.specPath,
    "--source", fixture.source,
    "--target", fixture.target,
    "--template-family", FAMILY,
    "--no-run-session",
    ...extraArgs,
  ], fixture.dir);
}

function readDsp(fixture) {
  return readJson(join(fixture.target, DSP_REL_PATH));
}

function readReport(fixture) {
  return readJson(join(fixture.target, REPORT_REL_PATH));
}

test("a declared template-stock page clears intake on a family without Template Reference proof", () => withFixture((fixture) => {
  const run = runPrepare(fixture);
  assert.equal(run.status, 0, run.stderr);

  const report = readReport(fixture);
  assert.equal(report.status, "prepared");
  assert.equal(report.stages.prepare_build.status, "completed_partial");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(
    { status: report.status, next: report.next, blockers: report.blockers },
    deriveAssemblyReportSummary(report),
    "the first write and every later commit derive the summary the same way",
  );
  assert.equal(report.next.stage, report.stages.setup.status === "pending" ? "setup" : "build");
  assert.deepEqual(
    report.stages.prepare_build.declared_out_of_scope.map((skip) => skip.page_id),
    ["select"],
  );

  const decision = report.decisions.find((entry) => entry.id === "dec_page_scope_select");
  assert.ok(decision, "the declared page keeps its scope decision");
  assert.equal(decision.template_stock, true);
  assert.equal(decision.template_family, FAMILY);
  assert.match(decision.decision, /template stock/);
  assert.match(decision.decision, new RegExp(`locked ${FAMILY} family`));

  const dsp = readDsp(fixture);
  assert.equal(dsp.readiness.status, "ready_with_gaps");
  assert.deepEqual(dsp.readiness.blocking_reasons, []);
  assert.deepEqual(dsp.source_todos, [], "no Template Reference link TODO for a template-stock page");
  assert.equal(dsp.source_gaps.length, 1);
  const [gap] = dsp.source_gaps;
  assert.equal(gap.id, "template-stock-select");
  assert.equal(gap.kind, "coverage_absence");
  assert.equal(gap.status, "accepted");
  assert.equal(gap.attributed_by, "prepare-build");
  assert.deepEqual(gap.applies_to, ["select"]);
  assert.match(gap.reason, new RegExp(`template stock from the ${FAMILY} family`));

  // A second run reuses the package byte for byte: the gap is part of the
  // synthesized material, not a per-run mutation.
  const before = readFileSync(join(fixture.target, DSP_REL_PATH));
  const rerun = runPrepare(fixture);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.json.designSourcePackageMode, "reused");
  assert.ok(readFileSync(join(fixture.target, DSP_REL_PATH)).equals(before));
}));

test("the Template Reference TODO for an undeclared page names the locked family, not the CampaignSpec hint", () => withFixture((fixture) => {
  const run = runPrepare(fixture);
  assert.equal(run.status, 0, run.stderr);

  const report = readReport(fixture);
  assert.equal(report.status, "blocked", "an undeclared page with no source still blocks");
  assert.ok(report.blockers.some((blocker) => blocker.code === "MISSING_SOURCE_PAGE" && blocker.page_id === "select"));
  // prepare-build's first write spells the summary the way every later commit
  // of the report does: the blocked gate is named in the `next` vocabulary.
  assert.deepEqual(
    { status: report.status, next: report.next, blockers: report.blockers },
    deriveAssemblyReportSummary(report),
  );
  assert.equal(report.next.stage, "prepare-build");
  assert.equal(report.next.owner, "next-campaigns-os");

  const dsp = readDsp(fixture);
  const todo = dsp.source_todos.find((entry) => entry.id === "link-select-template-reference");
  assert.ok(todo, "the undeclared page keeps its Template Reference TODO");
  assert.match(todo.description, new RegExp(`Link ${FAMILY} family/version`));
  assert.doesNotMatch(todo.description, /demeter/);
  assert.equal(readJson(join(fixture.target, "campaign-runtime.build.json")).assembly.template_family, FAMILY);
}, { hint: "demeter", declareSelect: false }));

test("--design-manifest reads the manifest from outside the source root and doctor reads the same file back", () => withFixture((fixture) => {
  assert.ok(!existsSync(join(fixture.source, ".campaigns-os")), "the source root carries no manifest of its own");

  const run = runPrepare(fixture, ["--design-manifest", fixture.manifestPath]);
  assert.equal(run.status, 0, run.stderr);

  const report = readReport(fixture);
  assert.equal(report.status, "prepared");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(
    report.stages.prepare_build.declared_out_of_scope.map((skip) => skip.declared_by),
    ["source_html_manifest"],
  );

  const dsp = readDsp(fixture);
  const htmlFunnel = dsp.contributions.find((contribution) => contribution.kind === "html_funnel");
  assert.equal(
    resolve(join(fixture.target, DSP_REL_PATH), "..", htmlFunnel.provenance.manifest_path),
    fixture.manifestPath,
  );
  assert.equal(htmlFunnel.trust, "structured");
  assert.equal(dsp.readiness.status, "ready_with_gaps");

  // Page paths in the manifest stay relative to --source: the mapped pages
  // resolved and carry their hashes.
  const packet = readJson(join(fixture.target, "campaign-runtime.build.json"));
  const checkout = packet.source_html.pages.find((page) => page.page_id === "checkout");
  assert.equal(checkout.path, "checkout.html");
  assert.equal(checkout.source_hash, sha256("<main><h1>checkout</h1></main>\n"));

  const doctor = runCli(["doctor", "--packet", join(fixture.target, "campaign-runtime.build.json")], fixture.dir);
  assert.ok(doctor.json, doctor.stderr);
  assert.ok(
    doctor.json.ready.includes("Source-html manifest source-html-manifest/v0 validated"),
    `doctor validates the recorded manifest: ${JSON.stringify(doctor.json.ready)}`,
  );
  assert.ok(!doctor.json.errors.some((error) => error.code === "DESIGN_SOURCE_PACKAGE_NOT_READY"));
}, { external: true }));

test("--design-manifest refuses a missing file or an invalid manifest before writing anything", () => withFixture((fixture) => {
  const missing = runPrepare(fixture, ["--design-manifest", join(fixture.dir, "nowhere.json")]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Design manifest does not exist or is not a file/);
  assert.ok(!existsSync(join(fixture.target, "campaign-runtime.build.json")));
  assert.ok(!existsSync(join(fixture.target, DSP_REL_PATH)));

  const bare = runPrepare(fixture, ["--design-manifest"]);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /--design-manifest needs a value/);

  const invalidPath = join(fixture.dir, "handoff", "broken.json");
  writeJson(invalidPath, { schema_version: "source-html-manifest/v0", pages: "not-an-array" });
  const invalid = runPrepare(fixture, ["--design-manifest", invalidPath]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /failed source-html-manifest\/v0 validation/);
  assert.doesNotMatch(invalid.stderr, /Falling back to filesystem matching/);
  assert.ok(!existsSync(join(fixture.target, "campaign-runtime.build.json")));
  assert.ok(!existsSync(join(fixture.target, DSP_REL_PATH)));
}, { external: true }));

// The build stage materialises a template-stock page from the family's own
// page of that role. Doctor treats the declared page as out of scope until
// that built HTML exists — then it is a built page: previewable, no longer a
// reason to block runtime QA, and the ready list says so. Two stock pages,
// declared receipt-before-select, prove the build prompt puts the select step
// first.
test("a materialised template-stock page becomes a built, previewable route and the build prompt lists select first", () => withFixture((fixture) => {
  const run = runPrepare(fixture);
  assert.equal(run.status, 0, run.stderr);
  const packetPath = join(fixture.target, "campaign-runtime.build.json");
  const packet = readJson(packetPath);
  const slug = packet.campaign.public_route_slug;
  assert.deepEqual(
    packet.source_html.pages.filter((page) => page.skip_reason).map((page) => page.page_id),
    ["receipt", "select"],
    "the mapping order under test lists receipt before select",
  );

  const before = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.ok(before.json, before.stderr);
  const outBefore = before.json.derived.scope.out_of_scope_pages.find((page) => page.page_id === "select");
  assert.ok(outBefore, "select is out of scope before the build");
  assert.equal(outBefore.template_stock, true);
  assert.equal(outBefore.template_family, FAMILY);
  assert.ok(!before.json.derived.scope.previewable_routes.some((page) => page.page_id === "select"));
  assert.ok(before.json.warnings.some((issue) => issue.code === "scope.runtime_qa_blocked" && /select:select/.test(issue.message)));
  const stockWarning = before.json.warnings.find((issue) => issue.code === "source_html.pages.skip_reason" && /"select"/.test(issue.message));
  assert.match(stockWarning.message, /is template stock and not built yet/);
  assert.match(stockWarning.message, new RegExp(`materialises it from the ${FAMILY} family`));

  const next = runCli(["next", "build", "--packet", packetPath], fixture.dir);
  assert.ok(next.json, next.stderr);
  assert.match(next.json.prompt, /Template-stock pages \(declared out of source scope; no design source exists for them\): select, receipt\./);

  // The build stage materialises both stock pages; nothing else about the
  // packet or the report changes.
  for (const pageId of ["select", "receipt"]) {
    const built = join(fixture.target, "_site", slug, pageId, "index.html");
    mkdirSync(dirname(built), { recursive: true });
    writeFileSync(built, `<main data-next-page="${pageId}"><h1>${pageId}</h1></main>\n`);
  }

  const after = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.ok(after.json, after.stderr);
  const builtSelect = after.json.derived.scope.built_pages.find((page) => page.page_id === "select");
  assert.ok(builtSelect, "select is a built page once its HTML exists");
  assert.equal(builtSelect.template_stock, true);
  assert.equal(builtSelect.template_family, FAMILY);
  assert.equal(builtSelect.source_path, null);
  assert.ok(after.json.derived.scope.previewable_routes.some((page) => page.page_id === "select"));
  assert.ok(!after.json.derived.scope.out_of_scope_pages.some((page) => page.page_id === "select"));
  assert.ok(!after.json.warnings.some((issue) => issue.code === "scope.runtime_qa_blocked"));
  assert.ok(!after.json.warnings.some((issue) => issue.code === "source_html.pages.skip_reason"));
  assert.ok(
    after.json.ready.some((line) => line === `Template-stock page(s) materialised by the build stage: receipt (${FAMILY}), select (${FAMILY})`),
    JSON.stringify(after.json.ready.filter((line) => /Template-stock/.test(line))),
  );
  assert.equal(after.json.derived.scope.mode, "full");
}, { stockPageIds: ["select", "receipt"], selectLast: true }));

// The same lifecycle when the CampaignSpec build_scope declares the stock
// pages: its reasons name runtime pages, which keeps runtime QA blocked on
// their own until every declared page has been materialised — then the
// declaration is discharged and the scope reads full.
test("a CampaignSpec build_scope partial declaration is discharged once its template-stock pages are built", () => withFixture((fixture) => {
  const run = runPrepare(fixture);
  assert.equal(run.status, 0, run.stderr);
  const packetPath = join(fixture.target, "campaign-runtime.build.json");
  const packet = readJson(packetPath);
  const report = readReport(fixture);
  assert.equal(report.stages.prepare_build.declared_out_of_scope[0].declared_by, "campaign_spec_build_scope");
  assert.equal(report.decisions.find((entry) => entry.id === "dec_page_scope_select").template_stock, true);

  const before = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.ok(before.json, before.stderr);
  assert.equal(before.json.derived.scope.mode, "partial");
  assert.ok(before.json.warnings.some((issue) => issue.code === "scope.runtime_qa_blocked"));

  const built = join(fixture.target, "_site", packet.campaign.public_route_slug, "select", "index.html");
  mkdirSync(dirname(built), { recursive: true });
  writeFileSync(built, "<main><h1>select</h1></main>\n");

  const after = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.ok(after.json, after.stderr);
  assert.equal(after.json.derived.scope.mode, "full");
  assert.deepEqual(after.json.derived.scope.out_of_scope_pages, []);
  assert.ok(after.json.derived.scope.built_pages.some((page) => page.page_id === "select" && page.template_stock === true));
  assert.ok(!after.json.warnings.some((issue) => issue.code === "scope.runtime_qa_blocked" || issue.code === "scope.partial_build"));
  assert.ok(after.json.ready.includes("All mapped CampaignSpec pages are build candidates"));
}, { buildScope: { mode: "partial", reasons: ["The select step is template stock; checkout and receipt come from prepared source."] } }));

// A skip entry whose scope decision carries no template_stock marker — a
// packet prepared before the marker existed, or a hand-authored do-not-build
// declaration — is neither listed for materialisation nor counted as built
// when HTML happens to exist at its route.
test("a skip entry without the template_stock marker keeps the do-not-build reading", () => withFixture((fixture) => {
  const run = runPrepare(fixture);
  assert.equal(run.status, 0, run.stderr);
  const packetPath = join(fixture.target, "campaign-runtime.build.json");
  const reportPath = join(fixture.target, REPORT_REL_PATH);
  const report = readJson(reportPath);
  for (const decision of report.decisions) {
    if (decision.id === "dec_page_scope_select") {
      delete decision.template_stock;
      delete decision.template_family;
    }
  }
  writeJson(reportPath, report);

  const next = runCli(["next", "build", "--packet", packetPath], fixture.dir);
  assert.ok(next.json, next.stderr);
  assert.doesNotMatch(next.json.prompt, /Template-stock pages/);

  const packet = readJson(packetPath);
  const built = join(fixture.target, "_site", packet.campaign.public_route_slug, "select", "index.html");
  mkdirSync(dirname(built), { recursive: true });
  writeFileSync(built, "<main><h1>select</h1></main>\n");
  const doctor = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.ok(doctor.json, doctor.stderr);
  assert.equal(doctor.json.derived.scope.mode, "partial");
  assert.ok(doctor.json.derived.scope.out_of_scope_pages.some((page) => page.page_id === "select" && page.template_stock === undefined));
  const warning = doctor.json.warnings.find((issue) => issue.code === "source_html.pages.skip_reason");
  assert.match(warning.message, /is out of scope for this partial build/);
}));
