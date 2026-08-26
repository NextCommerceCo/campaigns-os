import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateSourceHtmlManifest } from "./source-html-manifest.mjs";

// The partial-source build contract (#238): a campaign where some active
// CampaignSpec pages have prepared source HTML and the rest assemble from a
// certified template family is the ordinary shape of a template-family
// campaign, and it must be declarable. Without a declaration a missing page
// still blocks prepare-build exactly as before; with one (CampaignSpec
// build_scope.mode "partial", or a per-page manifest skip_reason entry)
// prepare-build reaches a terminal status, the declared pages are recorded as
// out of source scope, and doctor + the stage ladder agree about the result.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

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

const LANDING_HTML = "<main><h1>Landing</h1></main>\n";
const DESKTOP_SHOT = "fixture-desktop-screenshot";
const MOBILE_SHOT = "fixture-mobile-screenshot";

// Four active spec pages (landing, checkout, upsell, receipt), a manifest
// covering only the landing page, and the certified apollo family (the one
// whose catalog entry publishes a complete Template Reference, so the
// template-derived pages carry proven template_baseline coverage and the only
// variable under test is the source-scope declaration).
function withFixture(run, { buildScope = null, manifestSkipEntries = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-partial-build-"));
  try {
    const source = join(dir, "source");
    const target = join(dir, "target");
    const specPath = join(dir, "campaignspec.json");
    mkdirSync(join(source, ".campaigns-os"), { recursive: true });
    mkdirSync(join(source, "_ref"), { recursive: true });
    mkdirSync(target, { recursive: true });

    const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
    if (buildScope) spec.build_scope = buildScope;
    writeJson(specPath, spec);

    writeFileSync(join(source, "landing.html"), LANDING_HTML);
    writeFileSync(join(source, "_ref/landing-desktop.png"), DESKTOP_SHOT);
    writeFileSync(join(source, "_ref/landing-mobile.png"), MOBILE_SHOT);
    writeJson(join(source, ".campaigns-os/source-html-manifest.json"), {
      schema_version: "source-html-manifest/v0",
      generator: "fixture-exporter@1.0.0",
      pages: [
        {
          page_id: "landing",
          page_type: "landing",
          page_url: "landing/",
          path: "landing.html",
          source_hash: sha256(LANDING_HTML),
          screenshot_refs: [
            { id: "source-landing-desktop", kind: "source_screenshot", viewport: "desktop", availability: "available", path: "_ref/landing-desktop.png", sha256: sha256(DESKTOP_SHOT) },
            { id: "source-landing-mobile", kind: "source_screenshot", viewport: "mobile", availability: "available", path: "_ref/landing-mobile.png", sha256: sha256(MOBILE_SHOT) },
          ],
        },
        ...manifestSkipEntries,
      ],
    });
    writeJson(join(target, "package.json"), { private: true });

    return run({ dir, source, target, specPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, cwd) {
  const result = spawnSync("node", [CLI, ...args, "--json"], { cwd, encoding: "utf8" });
  const stdout = String(result.stdout || "");
  let json = null;
  try {
    json = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { status: result.status, stdout, stderr: String(result.stderr || ""), json };
}

function runPrepare(fixture) {
  return runCli([
    "prepare-build",
    "--spec", fixture.specPath,
    "--source", fixture.source,
    "--target", fixture.target,
    "--template-family", "apollo",
    "--no-run-session",
  ], fixture.dir);
}

function readReport(fixture) {
  return readJson(join(fixture.target, ".campaign-runtime/assembly-report.json"));
}

function readPacket(fixture) {
  return readJson(join(fixture.target, "campaign-runtime.build.json"));
}

const TEMPLATE_PAGE_IDS = ["checkout", "upsell", "receipt"];
const PARTIAL_BUILD_SCOPE = {
  mode: "partial",
  reasons: [
    "Only the landing page has prepared source HTML.",
    "The checkout, upsell, and receipt pages are template-derived and carry no source HTML by design.",
  ],
};

test("undeclared scope: a manifest covering fewer pages than the spec still blocks prepare-build", () => withFixture((fixture) => {
  const prepared = runPrepare(fixture);
  assert.equal(prepared.status, 0, prepared.stderr);

  const stage = readReport(fixture).stages.prepare_build;
  assert.equal(stage.status, "blocked");
  const missing = stage.blockers.filter((blocker) => blocker.code === "MISSING_SOURCE_PAGE");
  assert.deepEqual(missing.map((blocker) => blocker.page_id).sort(), [...TEMPLATE_PAGE_IDS].sort());
  assert.equal(stage.declared_out_of_scope, undefined);

  // Doctor and the ladder agree about the blocked packet: doctor refuses with
  // the same blockers instead of exiting 0 and naming a stage `next` rejects.
  const packetPath = join(fixture.target, "campaign-runtime.build.json");
  const doctor = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.notEqual(doctor.status, 0);
  assert.equal(doctor.json.status, "blocked");
  assert.ok(doctor.json.errors.some((issue) => issue.code === "MISSING_SOURCE_PAGE"));

  const next = runCli(["next", "--packet", packetPath, "--no-write"], fixture.dir);
  assert.notEqual(next.status, 0);
  assert.equal(next.json.status, "blocked");
  assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "blocked");
}));

test("CampaignSpec build_scope partial declares the template-derived pages and prepare-build reaches a terminal status", () => withFixture((fixture) => {
  const prepared = runPrepare(fixture);
  assert.equal(prepared.status, 0, prepared.stderr);

  const report = readReport(fixture);
  const stage = report.stages.prepare_build;
  assert.equal(stage.status, "completed_partial");
  assert.deepEqual(stage.blockers, []);
  assert.deepEqual(
    stage.declared_out_of_scope.map((skip) => skip.page_id).sort(),
    [...TEMPLATE_PAGE_IDS].sort(),
  );
  for (const skip of stage.declared_out_of_scope) {
    assert.equal(skip.declared_by, "campaign_spec_build_scope");
    assert.match(skip.skip_reason, /build_scope/);
  }
  assert.ok(report.warnings.some((warning) => warning.code === "SOURCE_SCOPE_PARTIAL"));

  const pages = readPacket(fixture).source_html.pages;
  for (const pageId of TEMPLATE_PAGE_IDS) {
    const mapping = pages.find((page) => page.page_id === pageId);
    assert.ok(mapping, `mapping for ${pageId}`);
    assert.equal(mapping.path, undefined);
    assert.match(mapping.skip_reason, /Declared out of source scope/);
  }

  // Doctor exit 0 now means the command it names will run: the ladder's own
  // picker selects the same stage instead of refusing at prepare-build.
  const packetPath = join(fixture.target, "campaign-runtime.build.json");
  const doctor = runCli(["doctor", "--packet", packetPath], fixture.dir);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.equal(doctor.json.derived.scope.mode, "partial");
  assert.deepEqual(
    doctor.json.derived.scope.out_of_scope_pages.map((page) => page.page_id).sort(),
    [...TEMPLATE_PAGE_IDS].sort(),
  );

  const next = runCli(["next", "--packet", packetPath, "--no-write"], fixture.dir);
  assert.equal(next.json.stage, doctor.json.next.stage);
  assert.notEqual(next.json.stage, "prepare-build");
  assert.equal(next.json.gates.find((gate) => gate.id === "prepare_build")?.status, "pass");
}, { buildScope: PARTIAL_BUILD_SCOPE }));

test("the declaration is idempotent under re-runs of prepare-build", () => withFixture((fixture) => {
  const first = runPrepare(fixture);
  assert.equal(first.status, 0, first.stderr);
  const firstStage = readReport(fixture).stages.prepare_build;
  assert.equal(firstStage.status, "completed_partial");

  // start/prepare-build regenerate source_html.pages[] on every run; the
  // declaration derives from the spec + manifest, so it survives regeneration
  // instead of being overwritten back into a blocker.
  const second = runPrepare(fixture);
  assert.equal(second.status, 0, second.stderr);
  const secondStage = readReport(fixture).stages.prepare_build;
  assert.equal(secondStage.status, "completed_partial");
  assert.deepEqual(
    secondStage.declared_out_of_scope.map((skip) => skip.page_id).sort(),
    firstStage.declared_out_of_scope.map((skip) => skip.page_id).sort(),
  );
  assert.deepEqual(secondStage.blockers, []);
}, { buildScope: PARTIAL_BUILD_SCOPE }));

test("a per-page manifest skip_reason entry declares a page out of scope without build_scope", () => withFixture((fixture) => {
  const prepared = runPrepare(fixture);
  assert.equal(prepared.status, 0, prepared.stderr);

  const stage = readReport(fixture).stages.prepare_build;
  assert.equal(stage.status, "completed_partial");
  assert.deepEqual(stage.blockers, []);
  assert.deepEqual(
    stage.declared_out_of_scope.map((skip) => skip.page_id).sort(),
    [...TEMPLATE_PAGE_IDS].sort(),
  );
  for (const skip of stage.declared_out_of_scope) {
    assert.equal(skip.declared_by, "source_html_manifest");
  }
  const pages = readPacket(fixture).source_html.pages;
  assert.equal(
    pages.find((page) => page.page_id === "checkout")?.skip_reason,
    "Template-derived checkout page; assembles from the apollo family.",
  );
}, {
  manifestSkipEntries: [
    { page_id: "checkout", skip_reason: "Template-derived checkout page; assembles from the apollo family." },
    { page_id: "upsell", skip_reason: "Template-derived upsell page; assembles from the apollo family." },
    { page_id: "receipt", skip_reason: "Template-derived receipt page; assembles from the apollo family." },
  ],
}));

test("manifest page entries require exactly one of path or skip_reason", () => {
  const base = {
    schema_version: "source-html-manifest/v0",
    pages: [{ page_id: "landing", path: "landing.html" }],
  };
  assert.equal(validateSourceHtmlManifest(base).ok, true);

  const skipOnly = { ...base, pages: [{ page_id: "checkout", skip_reason: "Template-derived page." }] };
  assert.equal(validateSourceHtmlManifest(skipOnly).ok, true);

  const both = { ...base, pages: [{ page_id: "landing", path: "landing.html", skip_reason: "also skipped" }] };
  const bothResult = validateSourceHtmlManifest(both);
  assert.equal(bothResult.ok, false);
  assert.ok(bothResult.errors.some((error) => error.code === "manifest.pages[0].skip_reason"));

  const neither = { ...base, pages: [{ page_id: "landing" }] };
  const neitherResult = validateSourceHtmlManifest(neither);
  assert.equal(neitherResult.ok, false);
  assert.ok(neitherResult.errors.some((error) => error.code === "manifest.pages[0].path"));
});
