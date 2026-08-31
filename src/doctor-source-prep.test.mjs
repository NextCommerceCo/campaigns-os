import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const UNPREPARED_FIXTURES = resolve(ROOT, "fixtures/source-prep/unprepared");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function runCliJson(args) {
  try {
    return JSON.parse(execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CAMPAIGNS_API_KEY: "" },
    }));
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

const PREPARED_PAGES = {
  landing: '---\npage_type: product\n---\n<section>Landing</section>\n<a href="{% campaign_link "checkout" %}">Buy</a>',
  checkout: '<section data-commerce-zone="checkout-form">Checkout</section>',
  upsell: '<section data-commerce-zone="upsell-offer">Upsell</section>',
  receipt: '<section data-commerce-zone="receipt-summary">Receipt</section>',
};

function withStartedBuild(sourcePages, run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-source-prep-doctor-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    for (const [page, content] of Object.entries(sourcePages)) {
      writeFileSync(resolve(sourceRoot, `${page}.html`), content);
    }
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json")));

    runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--no-run-session",
      "--json",
    ]);
    const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
    return run({ dir, sourceRoot, packetPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("doctor blocks unprepared source with actionable preparation codes", () => {
  const unprepared = {
    ...PREPARED_PAGES,
    landing: readFileSync(resolve(UNPREPARED_FIXTURES, "full-document.html"), "utf8"),
    upsell: readFileSync(resolve(UNPREPARED_FIXTURES, "embedded-frontmatter.html"), "utf8"),
    receipt: '<section>Receipt</section>\n<a href="landing.html">Back to landing</a>',
  };
  withStartedBuild(unprepared, ({ packetPath }) => {
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const errorCodes = new Set((doctor.errors || []).map((issue) => issue.code));
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(doctor.ok, false);
    assert.equal(doctor.status, "blocked");
    assert.equal(errorCodes.has("source_html.prep.document_wrapper"), true);
    assert.equal(errorCodes.has("source_html.prep.frontmatter_residue"), true);
    assert.equal(warningCodes.has("source_html.prep.internal_link_unrooted"), true);

    assert.equal(doctor.next.stage, "collect-inputs");
    assert.equal(doctor.next.status, "blocked");
    assert.ok(doctor.next.actions.some((action) => action.includes("Prepare Raw HTML Source")));

    const wrapperError = doctor.errors.find((issue) => issue.code === "source_html.prep.document_wrapper");
    assert.match(wrapperError.message, /docs\/quickstart\.md/);
    assert.ok(Array.isArray(wrapperError.detail?.pages));
    assert.equal(wrapperError.detail.pages[0].path, "landing.html");

    assert.deepEqual(doctor.derived.source_preparation.finding_codes, [
      "source_html.prep.document_wrapper",
      "source_html.prep.frontmatter_residue",
      "source_html.prep.internal_link_unrooted",
    ]);
    assert.ok(doctor.derived.doctor_checks.includes("source_html.preparation"));
  });
});

test("doctor passes prepared source and records the preparation check as ready", () => {
  withStartedBuild(PREPARED_PAGES, ({ packetPath }) => {
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const allCodes = new Set([...(doctor.errors || []), ...(doctor.warnings || [])].map((issue) => issue.code));

    for (const code of ["source_html.prep.document_wrapper", "source_html.prep.frontmatter_residue", "source_html.prep.internal_link_unrooted"]) {
      assert.equal(allCodes.has(code), false, `unexpected ${code}`);
    }
    assert.equal(doctor.derived.source_preparation.checked_page_count, 4);
    assert.deepEqual(doctor.derived.source_preparation.finding_codes, []);
    assert.ok(doctor.ready.some((line) => line.includes("page-kit preparation check")));
  });
});

test("a recorded preserve_document_wrappers decision reports wrappers without blocking", () => {
  const unprepared = {
    ...PREPARED_PAGES,
    landing: readFileSync(resolve(UNPREPARED_FIXTURES, "full-document.html"), "utf8"),
  };
  withStartedBuild(unprepared, ({ packetPath }) => {
    const packet = readJson(packetPath);
    packet.source_html.adapter_contract.wrapper_policy = "preserve_document_wrappers";
    writeJson(packetPath, packet);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const errorCodes = new Set((doctor.errors || []).map((issue) => issue.code));
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(errorCodes.has("source_html.prep.document_wrapper"), false);
    assert.equal(warningCodes.has("source_html.prep.document_wrapper"), true);
  });
});

test("source edits after start are re-checked on the next doctor run", () => {
  withStartedBuild(PREPARED_PAGES, ({ sourceRoot, packetPath }) => {
    const clean = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    assert.deepEqual(clean.derived.source_preparation.finding_codes, []);

    writeFileSync(
      resolve(sourceRoot, "landing.html"),
      readFileSync(resolve(UNPREPARED_FIXTURES, "full-document.html"), "utf8")
    );
    const regressed = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    assert.equal(
      (regressed.errors || []).some((issue) => issue.code === "source_html.prep.document_wrapper"),
      true
    );
  });
});
