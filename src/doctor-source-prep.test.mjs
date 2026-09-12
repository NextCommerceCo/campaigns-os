import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function withStartedBuild(sourcePages, run, { extraArgs = [], manifest = null } = {}) {
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

    if (manifest) {
      mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
      writeJson(resolve(sourceRoot, ".campaigns-os/source-html-manifest.json"), manifest);
    }

    runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--no-run-session",
      ...extraArgs,
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

// The wrapper policy has two operator channels — a source-html manifest key and
// a prepare-build flag — because the policy is documented as a choice and was
// previously selectable only by editing the packet the build stage writes.
function manifestWithWrapperPolicy(wrapperPolicy) {
  return {
    schema_version: "source-html-manifest/v0",
    generator: "fixture-producer@1.0.0",
    ...(wrapperPolicy === null ? {} : { wrapper_policy: wrapperPolicy }),
    pages: Object.keys(PREPARED_PAGES).map((page) => ({ page_id: page, path: `${page}.html` })),
  };
}

const WRAPPED_LANDING = {
  ...PREPARED_PAGES,
  landing: readFileSync(resolve(UNPREPARED_FIXTURES, "full-document.html"), "utf8"),
};

test("a manifest wrapper_policy clears the document_wrapper gate at prepare-build", () => {
  withStartedBuild(WRAPPED_LANDING, ({ packetPath }) => {
    assert.equal(readJson(packetPath).source_html.adapter_contract.wrapper_policy, "preserve_document_wrappers");

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const errorCodes = new Set((doctor.errors || []).map((issue) => issue.code));
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(errorCodes.has("source_html.prep.document_wrapper"), false);
    assert.equal(warningCodes.has("source_html.prep.document_wrapper"), true);
  }, { manifest: manifestWithWrapperPolicy("preserve_document_wrappers") });
});

test("the same source without the manifest key still blocks on document wrappers", () => {
  withStartedBuild(WRAPPED_LANDING, ({ packetPath }) => {
    assert.equal(readJson(packetPath).source_html.adapter_contract.wrapper_policy, "strip_document_wrappers");

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    assert.equal(
      (doctor.errors || []).some((issue) => issue.code === "source_html.prep.document_wrapper"),
      true,
    );
  }, { manifest: manifestWithWrapperPolicy(null) });
});

test("the --wrapper-policy flag clears the document_wrapper gate with no manifest", () => {
  withStartedBuild(WRAPPED_LANDING, ({ packetPath }) => {
    assert.equal(readJson(packetPath).source_html.adapter_contract.wrapper_policy, "preserve_document_wrappers");

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const errorCodes = new Set((doctor.errors || []).map((issue) => issue.code));
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(errorCodes.has("source_html.prep.document_wrapper"), false);
    assert.equal(warningCodes.has("source_html.prep.document_wrapper"), true);
  }, { extraArgs: ["--wrapper-policy", "preserve_document_wrappers"] });
});

test("the --wrapper-policy flag wins over the manifest key", () => {
  withStartedBuild(WRAPPED_LANDING, ({ packetPath }) => {
    assert.equal(readJson(packetPath).source_html.adapter_contract.wrapper_policy, "strip_document_wrappers");

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    assert.equal(
      (doctor.errors || []).some((issue) => issue.code === "source_html.prep.document_wrapper"),
      true,
    );
  }, {
    manifest: manifestWithWrapperPolicy("preserve_document_wrappers"),
    extraArgs: ["--wrapper-policy", "strip_document_wrappers"],
  });
});

test("a refused --wrapper-policy leaves no Design Source Package or build state behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-wrapper-policy-state-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    for (const [page, content] of Object.entries(PREPARED_PAGES)) {
      writeFileSync(resolve(sourceRoot, `${page}.html`), content);
    }
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json")));

    for (const badFlag of [["--wrapper-policy", "keep_them_i_guess"], ["--wrapper-policy"]]) {
      assert.throws(() => execFileSync(process.execPath, [
        CLI,
        "prepare-build",
        "--spec", specPath,
        "--source", sourceRoot,
        "--target", targetRepo,
        "--template-family", "olympus",
        ...badFlag,
        "--no-run-session",
        "--json",
      ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

      // The Design Source Package is published partway through prepare-build
      // and is immutable once written: a later refusal would strand it, and
      // the operator's retry through the manifest channel would then fail as
      // stale against a package they never asked for.
      assert.equal(existsSync(resolve(targetRepo, ".campaign-runtime")), false, `${badFlag.join(" ")} wrote build state`);
      assert.equal(existsSync(resolve(targetRepo, "campaign-runtime.build.json")), false, `${badFlag.join(" ")} wrote a packet`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrecognized --wrapper-policy value is refused with the accepted vocabulary", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-wrapper-policy-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    for (const [page, content] of Object.entries(PREPARED_PAGES)) {
      writeFileSync(resolve(sourceRoot, `${page}.html`), content);
    }
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json")));

    assert.throws(() => execFileSync(process.execPath, [
      CLI,
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--wrapper-policy", "keep_them_i_guess",
      "--no-run-session",
      "--json",
    ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error) => {
      assert.match(String(error.stderr), /Unsupported --wrapper-policy/);
      assert.match(String(error.stderr), /preserve_document_wrappers/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
