import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createSourceHtmlIntake,
  parseHostPrefixedRoute,
  publicRouteForPage,
  stripHostPrefixedRoutes,
} from "./source-html-intake.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import {
  readSourceHtmlManifestFile,
  SOURCE_HTML_MANIFEST_SCHEMA,
  validateSourceHtmlManifest,
} from "./source-html-manifest.mjs";
import { forwardRouteTarget } from "../campaign-spec/dist/index.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function runCliJson(args) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAMPAIGNS_API_KEY: "" },
  });
  return JSON.parse(output);
}

function runCliJsonAllowFailure(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAMPAIGNS_API_KEY: "" },
  });
  const text = result.stdout.trim();
  if (!text) throw new Error(`CLI produced no JSON. stderr=${result.stderr}`);
  return JSON.parse(text);
}

function withIntakeFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-source-intake-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));

    const files = {
      "figma/landing-page.html": "<section>landing</section>",
      "checkout/index.html": "<section>checkout</section>",
      "ai/upsell-offer.html": "<section>upsell</section>",
      "template/thanks.html": "<section>receipt</section>",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(resolve(sourceRoot, path, ".."), { recursive: true });
      writeFileSync(resolve(sourceRoot, path), content);
    }

    writeJson(resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json"), {
      schema_version: "source-html-manifest/v0",
      generated_at: "2026-06-08T00:00:00.000Z",
      generator: "source-html-intake-test@1.0.0",
      campaign_slug: "runtime-packet-demo",
      root: ".",
      pages: [
        { page_id: "landing", path: "figma/landing-page.html", page_type: "landing" },
        { page_id: "checkout", path: "checkout/index.html", page_type: "checkout" },
        { page_id: "upsell", path: "ai/upsell-offer.html", page_type: "upsell" },
        { page_id: "receipt", path: "template/thanks.html", page_type: "thankyou" },
      ],
    });

    const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
    const checkout = spec.funnels[0].pages.find((page) => page.id === "checkout");
    checkout.page_url = "checkout/step-1/";
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, spec);

    return run({ dir, sourceRoot, targetRepo, specPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prepare-build separates source manifest paths from Page Kit target projection", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const pages = new Map(result.packet.source_html.pages.map((page) => [page.page_id, page]));
    const checkout = pages.get("checkout");
    assert.equal(checkout.path, "checkout/index.html");
    assert.equal(checkout.page_kit.target_path, "step-1.html");
    assert.equal(checkout.page_kit.output_path, "src/runtime-packet-demo/step-1.html");
    assert.equal(checkout.page_kit.public_route, "/runtime-packet-demo/checkout/step-1/");
    assert.equal(checkout.page_kit.page_type, "checkout");
    assert.equal(checkout.page_kit.permalink_required, true);
    assert.equal(checkout.page_kit.frontmatter.permalink, "/runtime-packet-demo/checkout/step-1/");

    const landing = pages.get("landing");
    assert.equal(landing.path, "figma/landing-page.html");
    assert.equal(landing.page_kit.target_path, "landing.html");
    assert.equal(landing.page_kit.page_type, "product");
    assert.equal(landing.page_kit.frontmatter.next_url, "/runtime-packet-demo/checkout/step-1/");

    const receipt = pages.get("receipt");
    assert.equal(receipt.path, "template/thanks.html");
    assert.equal(receipt.page_type, "thankyou");
    assert.equal(receipt.page_kit.page_type, "receipt");
    assert.equal(receipt.page_kit.target_path, "receipt.html");

    const contextCheckout = result.context.page_map.find((page) => page.page_id === "checkout");
    assert.equal(contextCheckout.source_path, "checkout/index.html");
    assert.equal(contextCheckout.output_path, "./src/runtime-packet-demo/step-1.html");
    assert.equal(contextCheckout.page_kit.target_path, "step-1.html");

    const projectionDecisions = result.context.decisions.filter((decision) => decision.id.startsWith("dec_page_kit_target_"));
    assert.equal(projectionDecisions.length, 4);
  });
});

test("prepare-build projects absolute page_url from its path, not its origin", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const spec = readJson(specPath);
    const checkout = spec.funnels[0].pages.find((page) => page.id === "checkout");
    checkout.page_url = "https://preview.example.com/runtime-packet-demo/checkout/step-1/?utm=test";
    writeJson(specPath, spec);

    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const checkoutMapping = result.packet.source_html.pages.find((page) => page.page_id === "checkout");
    assert.equal(checkoutMapping.page_kit.target_path, "step-1.html");
    assert.equal(checkoutMapping.page_kit.output_path, "src/runtime-packet-demo/step-1.html");
    assert.equal(checkoutMapping.page_kit.public_route, "/runtime-packet-demo/checkout/step-1/");
    assert.equal(checkoutMapping.page_kit.frontmatter.permalink, "/runtime-packet-demo/checkout/step-1/");
  });
});

test("public route projection normalizes legacy url values as Page Kit routes", () => {
  assert.equal(
    publicRouteForPage({ type: "checkout", url: "https://preview.example.com/runtime-packet-demo/checkout.html?utm=test#top" }),
    "runtime-packet-demo/checkout/"
  );
  assert.equal(publicRouteForPage({ type: "checkout", url: "checkout.html" }), "checkout/");
});

test("source-html manifest prompts for duplicate page_url values", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const manifestPath = resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.pages[0].page_url = "shared/";
    manifest.pages[1].page_url = "https://preview.example.com/shared/?utm=1";
    writeJson(manifestPath, manifest);

    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    assert.equal(result.context.prompts_required.some((prompt) => prompt.code === "MANIFEST_DUPLICATE_PAGE_URL"), true);
  });
});

test("source-html manifest validator rejects missing page paths", () => {
  const validation = validateSourceHtmlManifest({
    schema_version: "source-html-manifest/v0",
    pages: [{ page_id: "landing" }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => error.code === "manifest.pages[0].path"), true);
});

test("a screenshot record that fails a field test warns per record and names the field", () => {
  const validation = validateSourceHtmlManifest({
    schema_version: "source-html-manifest/v0",
    pages: [
      {
        page_id: "landing",
        path: "landing.html",
        screenshots: [
          { id: "landing-desktop", viewport: "desktop", path: "shots/landing-desktop.png" },
          { id: "landing-mobile", viewport: "mobil", path: "shots/landing-mobile.png" },
        ],
      },
      { page_id: "checkout", path: "checkout.html" },
    ],
  });

  // The manifest is still valid: a typo in optional proof must not throw away
  // pages[], which would silently drop the run to filesystem matching.
  assert.equal(validation.ok, true);
  assert.equal(validation.warnings.length, 1, JSON.stringify(validation.warnings));
  const [warning] = validation.warnings;
  assert.equal(warning.code, "manifest.pages[0].screenshots[1].viewport");
  assert.match(warning.message, /manifest\.pages\[0\]\.screenshots\[1\]/);
  assert.match(warning.message, /page_id "landing"/);
  assert.match(warning.message, /"mobil"/);
  assert.match(warning.message, /desktop, mobile, tablet/);
});

test("each unusable screenshot field test gets its own named diagnostic", () => {
  const cases = [
    [{ id: "a", path: "shots/a.png" }, "viewport"],
    [{ id: "b", viewport: "desktop" }, "evidence"],
    [{ id: "c", viewport: "desktop", availability: "unavailable" }, "unavailable_reason"],
    [{ id: "d", viewport: "desktop", path: "shots/d.png", kind: "render_reference" }, "kind"],
  ];
  for (const [record, field] of cases) {
    const validation = validateSourceHtmlManifest({
      schema_version: "source-html-manifest/v0",
      pages: [{ page_id: "landing", path: "landing.html", screenshot_refs: [record] }],
    });
    assert.equal(validation.ok, true);
    assert.deepEqual(
      validation.warnings.map((entry) => entry.code),
      [`manifest.pages[0].screenshot_refs[0].${field}`],
      JSON.stringify({ record, warnings: validation.warnings }),
    );
  }
});

test("well-formed screenshot records produce no diagnostic", () => {
  const validation = validateSourceHtmlManifest({
    schema_version: "source-html-manifest/v0",
    pages: [{
      page_id: "landing",
      path: "landing.html",
      screenshots: [
        { id: "landing-desktop", viewport: "desktop", path: "shots/landing-desktop.png" },
        { id: "landing-mobile", viewport: "MOBILE", url: "https://source.example.test/landing" },
        { id: "landing-tablet", viewport: "tablet", availability: "unavailable", unavailable_reason: "never captured" },
        "landing-desktop",
      ],
    }],
  });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.warnings, []);
});

test("source-html manifest validator accepts producer provenance and file inventory", () => {
  const validation = validateSourceHtmlManifest({
    schema_version: "source-html-manifest/v0",
    generator: "figma-sections-export@1.0.0",
    producer_provenance: {
      source_type: "semantic_figma_export",
      screenshot_fallback_used: false,
      semantic_section_count: 1,
      breakpoint_image_count: 1,
      material_fingerprint: "a".repeat(64),
      section_exports: [
        {
          section: "hero-1",
          type: "hotspot",
          node_ids: { desktop: "1:2" },
          images: ["images/hero-1/hero-1-desktop.png"],
          warnings: [],
        },
      ],
    },
    files: [
      { path: "landing.html", role: "page", sha256: "b".repeat(64), bytes: 12 },
      { path: "_includes/landing/hero-1.html", role: "partial", sha256: "c".repeat(64), bytes: 34 },
      { path: "assets/images/hero-1/hero-1-desktop.png", role: "asset", sha256: "d".repeat(64), bytes: 56 },
    ],
    pages: [{ page_id: "landing", path: "landing.html" }],
  });

  assert.equal(validation.ok, true);
});

test("source-html manifest validator requires positive semantic section count and file roles", () => {
  const validation = validateSourceHtmlManifest({
    schema_version: "source-html-manifest/v0",
    generator: "figma-sections-export@1.0.0",
    producer_provenance: {
      source_type: "semantic_figma_export",
      screenshot_fallback_used: false,
      semantic_section_count: 0,
      material_fingerprint: "a".repeat(64),
    },
    files: [{ path: "landing.html", sha256: "b".repeat(64) }],
    pages: [{ page_id: "landing", path: "landing.html" }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => error.code === "manifest.producer_provenance.semantic_section_count"), true);
  assert.equal(validation.errors.some((error) => error.code === "manifest.files[0].role"), true);
});

test("doctor blocks Figma exporter manifests without producer provenance", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const manifestPath = resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.generator = "figma-sections-export@1.0.0";
    writeJson(manifestPath, manifest);

    const spec = readJson(specPath);
    const landing = spec.funnels[0].pages.find((page) => page.id === "landing");
    landing.design_source = {
      type: "figma",
      file_url: "https://www.figma.com/design/abc/Figma?node-id=1-2",
    };
    writeJson(specPath, spec);

    const result = runCliJsonAllowFailure([
      "start",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const codes = new Set((result.doctor?.errors || []).map((issue) => issue.code));
    assert.equal(codes.has("source_html.producer_provenance"), true);
  });
});

test("doctor handles Figma design source when manifest generator is missing", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const manifestPath = resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json");
    const manifest = readJson(manifestPath);
    delete manifest.generator;
    writeJson(manifestPath, manifest);

    const spec = readJson(specPath);
    const landing = spec.funnels[0].pages.find((page) => page.id === "landing");
    landing.design_source = {
      type: "figma",
      file_url: "https://www.figma.com/design/abc/Figma?node-id=1-2",
    };
    writeJson(specPath, spec);

    const result = runCliJsonAllowFailure([
      "start",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const codes = new Set((result.doctor?.errors || []).map((issue) => issue.code));
    assert.equal(codes.has("source_html.producer_provenance"), true);
  });
});

test("doctor warns instead of throwing when Figma section export omits node_ids", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    mkdirSync(resolve(sourceRoot, "assets/images/hero-1"), { recursive: true });
    writeFileSync(resolve(sourceRoot, "assets/images/hero-1/hero-1-desktop.png"), "png");

    const manifestPath = resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.generator = "figma-sections-export@1.0.0";
    manifest.producer_provenance = {
      source_type: "semantic_figma_export",
      screenshot_fallback_used: false,
      semantic_section_count: 1,
      breakpoint_image_count: 1,
      material_fingerprint: "a".repeat(64),
      section_exports: [{ section: "hero-1", type: "hotspot" }],
    };
    manifest.files = [
      { path: "figma/landing-page.html", role: "partial", sha256: "b".repeat(64) },
      { path: "assets/images/hero-1/hero-1-desktop.png", role: "asset", sha256: "c".repeat(64) },
    ];
    writeJson(manifestPath, manifest);

    const result = runCliJsonAllowFailure([
      "start",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    const errors = new Set((result.doctor?.errors || []).map((issue) => issue.code));
    const warnings = new Set((result.doctor?.warnings || []).map((issue) => issue.code));
    assert.equal(errors.has("source_html.producer_provenance.section_exports"), false);
    assert.equal(warnings.has("source_html.producer_provenance.section_exports.node_ids"), true);
  });
});

test("published source-html manifest schema agrees with runtime constant", () => {
  const schema = readJson(resolve(ROOT, "schemas/source-html-manifest.v0.schema.json"));

  assert.equal(schema.properties.schema_version.const, SOURCE_HTML_MANIFEST_SCHEMA);
});

test("source-html manifest reader reports schema validation failures", () => {
  withIntakeFixture(({ sourceRoot }) => {
    const manifestPath = resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json");
    const manifest = readJson(manifestPath);
    manifest.pages[0].source_hash = "not-a-sha";
    writeJson(manifestPath, manifest);

    const result = readSourceHtmlManifestFile(sourceRoot);

    assert.equal(result.manifest, null);
    assert.match(result.warning, /failed source-html-manifest\/v0 validation/);
    assert.equal(result.validation.ok, false);
    assert.equal(result.validation.errors.some((error) => error.code === "manifest.pages[0].source_hash"), true);
  });
});

test("select spec pages project to checkout Page Kit page_type", () => {
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: [
      {
        id: "package-select",
        type: "select",
        page_url: "select/",
      },
    ],
    htmlFiles: [{ path: "select.html", basename: "select" }],
    publicRouteSlug: "runtime-packet-demo",
    outputDir: "src/runtime-packet-demo",
  });

  assert.equal(result.mappings.length, 1);
  assert.equal(result.mappings[0].page_kit.page_type, "checkout");
  assert.equal(result.mappings[0].page_kit.frontmatter.page_type, "checkout");
});

test("manifest drafts omit pages with no candidate path and stay schema-valid", () => {
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: [
      { id: "landing", type: "landing" },
      { id: "checkout", type: "checkout" },
    ],
    htmlFiles: [
      { path: "landing.html", basename: "landing", bytes: 10, sha256: "a".repeat(64) },
      { path: "mirror/landing.html", basename: "landing", bytes: 10, sha256: "b".repeat(64) },
    ],
    publicRouteSlug: "runtime-packet-demo",
    outputDir: "src/runtime-packet-demo",
  });

  assert.equal(result.manifestDraft.pages.some((page) => page.page_id === "checkout"), false);
  assert.equal(result.manifestDraft.pages.every((page) => page.path), true);
  assert.equal(validateSourceHtmlManifest(result.manifestDraft).ok, true);
});

test("filesystem fallback reports candidates already assigned to a sibling page", () => {
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: [
      { id: "first", type: "landing" },
      { id: "second", type: "landing" },
    ],
    htmlFiles: [
      { path: "landing.html", basename: "landing", bytes: 10, sha256: "a".repeat(64) },
    ],
    publicRouteSlug: "runtime-packet-demo",
    outputDir: "src/runtime-packet-demo",
  });

  const prompt = result.prompts.find((entry) => entry.page_id === "second" && entry.code === "AMBIGUOUS_SOURCE_PAGE");
  assert.ok(prompt);
  assert.equal(prompt.detail.candidates[0].path, "landing.html");
  assert.equal(prompt.detail.candidates[0].used_by_page_id, "first");
  assert.equal(prompt.detail.manifest_entry.path, "");
  assert.equal(prompt.detail.manifest_entry.path_conflicts, true);
  assert.match(result.mappings.find((entry) => entry.page_id === "second").skip_reason, /already assigned/);
});

test("Page Kit target conflict prompts carry structured detail", () => {
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: [
      { id: "landing-a", type: "landing", page_url: "same/" },
      { id: "landing-b", type: "landing", page_url: "same/" },
    ],
    htmlFiles: [
      { path: "landing-a.html", basename: "landing-a" },
      { path: "landing-b.html", basename: "landing-b" },
    ],
    publicRouteSlug: "runtime-packet-demo",
    outputDir: "src/runtime-packet-demo",
  });

  const prompt = result.prompts.find((entry) => entry.code === "PAGE_KIT_TARGET_CONFLICT");
  assert.ok(prompt);
  assert.deepEqual(prompt.detail, {
    output_path: "src/runtime-packet-demo/same.html",
    existing_page_id: "landing-a",
    conflicting_page_id: "landing-b",
  });
});

test("prepare-build blocks ambiguous filesystem source matches and drafts a manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-source-ambiguous-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeJson(resolve(targetRepo, "package.json"), { dependencies: { "next-campaign-page-kit": "fixture" } });
    writeFileSync(resolve(sourceRoot, "landing.html"), "<main>primary landing</main>");
    mkdirSync(resolve(sourceRoot, "mirror"), { recursive: true });
    writeFileSync(resolve(sourceRoot, "mirror", "landing.html"), "<main>asset mirror landing</main>");
    for (const page of ["checkout", "upsell", "receipt"]) {
      writeFileSync(resolve(sourceRoot, `${page}.html`), `<main>${page}</main>`);
    }

    const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, spec);

    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    assert.equal(result.context.status, "blocked");
    assert.equal(result.context.prompts_required.some((prompt) => prompt.code === "AMBIGUOUS_SOURCE_PAGE"), true);
    assert.equal(result.context.source.ambiguous_candidates.length, 1);
    assert.deepEqual(
      result.context.source.ambiguous_candidates[0].candidates.map((candidate) => candidate.path).sort(),
      ["landing.html", "mirror/landing.html"]
    );
    assert.equal(result.context.source.manifest_draft.schema_version, "source-html-manifest/v0");
    assert.equal(result.report.blockers.some((blocker) => blocker.code === "AMBIGUOUS_SOURCE_PAGE" && blocker.detail?.candidates?.length === 2), true);
    assert.equal(result.report.warnings.some((warning) => warning.code === "AMBIGUOUS_SOURCE_HTML_CANDIDATES"), true);
    const landing = result.packet.source_html.pages.find((page) => page.page_id === "landing");
    assert.match(landing.skip_reason, /Ambiguous source HTML candidates/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Forward-link resolution is type-agnostic (#230): a page that declares any
// routing edge gets a next_url, whatever its type and whichever field carried
// the intent. Before this, twelve checkout-typed pages across ten certified
// fixtures routed through next_page and silently emitted no next_url at all,
// including every hand-off in the three-step shop flow.
//
// This is a GOLDEN comparison, not a presence check. A presence check ("every
// page that declares an edge has some next_url") passes even if the resolver
// picks the WRONG field — reordering the precedence to prefer on_decline kept
// an earlier version of this test green while repointing every upsell's
// forward link at its decline target. Pinning exact values is what makes a
// precedence change fail loudly.
function corpusFrontmatter() {
  const dir = resolve(ROOT, "contracts/fixtures/campaign-specs");
  const emitted = {};
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    const spec = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const funnel of spec.funnels || []) {
      const specPages = funnel.pages || [];
      const result = createSourceHtmlIntake({
        sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
        specPages,
        htmlFiles: specPages.map((page) => ({ path: `${page.id}.html`, basename: page.id })),
        publicRouteSlug: "campaign",
        outputDir: "src/campaign",
      });
      for (const mapping of result.mappings || []) {
        if (!mapping.page_kit) continue;
        emitted[`${name}::${funnel.id}::${mapping.page_id}`] = mapping.page_kit.frontmatter;
      }
    }
  }
  return emitted;
}

// Regenerate after an intentional corpus or routing change:
//   UPDATE_GOLDEN=1 node --test src/source-html-intake.test.mjs
// Then READ the diff. A golden is only worth having if the diff gets reviewed;
// hand-editing it to make this pass defeats the entire point of the file.
const GOLDEN_PATH = "contracts/fixtures/expected/page-kit-frontmatter.golden.json";

test("page-kit frontmatter for the certified corpus matches the golden artifact", () => {
  const goldenPath = resolve(ROOT, GOLDEN_PATH);
  const emitted = corpusFrontmatter();
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(goldenPath, `${JSON.stringify(emitted, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.deepEqual(
    emitted,
    golden,
    `Emitted page-kit frontmatter differs from ${GOLDEN_PATH}. If the change is intentional, regenerate with UPDATE_GOLDEN=1 node --test src/source-html-intake.test.mjs and review the diff.`,
  );
});

test("no certified fixture silently drops a declared forward edge", () => {
  const dir = resolve(ROOT, "contracts/fixtures/campaign-specs");
  const emitted = corpusFrontmatter();
  const dropped = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const spec = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const funnel of spec.funnels || []) {
      for (const page of funnel.pages || []) {
        const key = `${name}::${funnel.id}::${page.id}`;
        if (!(key in emitted)) continue;
        // Ask the resolver, never a local copy of its precedence list: since
        // #234 a declared field the page type cannot satisfy is NOT an edge,
        // and a hardcoded array would flag a correctly-inert success_url on a
        // select page as a dropped edge.
        const declares = forwardRouteTarget(page) !== null;
        if (declares && !emitted[key].next_url) {
          dropped.push(`${key} (type=${page.type}) declares a forward edge but emits no next_url`);
        }
      }
    }
  }
  assert.deepEqual(dropped, []);
});

test("forward-link precedence is specific-before-generic, and wiring proves it end to end", () => {
  const wire = (page) => {
    // Explicit page_url on each target: routes derive from page type when it is
    // absent, which would make three upsell targets share one route.
    const pages = [
      page,
      { id: "accept-target", type: "upsell", page_url: "accept-target/" },
      { id: "success-target", type: "upsell", page_url: "success-target/" },
      { id: "next-target", type: "upsell", page_url: "next-target/" },
      { id: "decline-target", type: "downsell", page_url: "decline-target/" },
    ];
    const result = createSourceHtmlIntake({
      sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
      specPages: pages,
      htmlFiles: pages.map((p) => ({ path: `${p.id}.html`, basename: p.id })),
      publicRouteSlug: "campaign",
      outputDir: "src/campaign",
    });
    return result.mappings.find((m) => m.page_id === page.id).page_kit.frontmatter;
  };

  // on_accept beats everything.
  assert.equal(
    wire({ id: "p", type: "upsell", on_accept: "accept-target", success_url: "success-target", next_page: "next-target" }).next_url,
    "/campaign/accept-target/",
  );
  // success_url beats the generic next_page.
  assert.equal(
    wire({ id: "p", type: "checkout", success_url: "success-target", next_page: "next-target" }).next_url,
    "/campaign/success-target/",
  );
  // next_page is the fallback — and works on a checkout, which is the whole fix.
  assert.equal(wire({ id: "p", type: "checkout", next_page: "next-target" }).next_url, "/campaign/next-target/");
  // A page declaring nothing wires nothing, rather than inventing a route.
  assert.equal("next_url" in wire({ id: "p", type: "checkout" }), false);
});

test("a stray success_url off a checkout does not wire the built page past payment", () => {
  // #234 end to end. This is the layer the reported bug actually broke: the
  // built select page's forward link pointed at the upsell, so a real shopper
  // left the funnel without paying. Asserted on both page types from one spec,
  // because the carve-out is meaningless unless the checkout below still works.
  const pages = [
    { id: "select", type: "select", next_page: "checkout", success_url: "upsell", page_url: "select/" },
    { id: "checkout", type: "checkout", next_page: "select", success_url: "upsell", page_url: "checkout/" },
    { id: "upsell", type: "upsell", on_accept: "receipt", on_decline: "receipt", page_url: "upsell/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ];
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: pages,
    htmlFiles: pages.map((p) => ({ path: `${p.id}.html`, basename: p.id })),
    publicRouteSlug: "campaign",
    outputDir: "src/campaign",
  });
  const frontmatter = (id) => result.mappings.find((m) => m.page_id === id).page_kit.frontmatter;

  assert.equal(frontmatter("select").next_url, "/campaign/checkout/");
  assert.equal(frontmatter("checkout").next_url, "/campaign/upsell/");
});

test("a stray on_accept off an offer page does not wire the built page past payment", () => {
  // The same end-to-end proof for the second gated field. on_accept sits at the
  // top of the precedence list, so this is the shape that still skipped payment
  // after the success_url carve-out landed.
  const pages = [
    { id: "select", type: "select", next_page: "checkout", on_accept: "upsell", page_url: "select/" },
    { id: "checkout", type: "checkout", success_url: "upsell", on_accept: "receipt", page_url: "checkout/" },
    { id: "upsell", type: "upsell", on_accept: "receipt", on_decline: "receipt", page_url: "upsell/" },
    { id: "receipt", type: "thankyou", page_url: "receipt/" },
  ];
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: pages,
    htmlFiles: pages.map((p) => ({ path: `${p.id}.html`, basename: p.id })),
    publicRouteSlug: "campaign",
    outputDir: "src/campaign",
  });
  const frontmatter = (id) => result.mappings.find((m) => m.page_id === id).page_kit.frontmatter;

  assert.equal(frontmatter("select").next_url, "/campaign/checkout/");
  // The checkout keeps its own success_url instead of the shadowing on_accept.
  assert.equal(frontmatter("checkout").next_url, "/campaign/upsell/");
  // The upsell presents the offer, so its on_accept still wins.
  assert.equal(frontmatter("upsell").next_url, "/campaign/receipt/");
});

test("the decline branch is taken wherever it is declared, not only on upsells", () => {
  // Kilo review on #233: de-gating declineUrlForPage had zero assertions, since
  // the corpus only declares on_decline on upsell/downsell pages, which the old
  // type gate already wired.
  const pages = [
    { id: "p", type: "checkout", next_page: "next-target", on_decline: "decline-target" },
    { id: "next-target", type: "upsell", page_url: "next-target/" },
    { id: "decline-target", type: "downsell", page_url: "decline-target/" },
  ];
  const result = createSourceHtmlIntake({
    sourceRoot: resolve(ROOT, "no-source-html-manifest-here"),
    specPages: pages,
    htmlFiles: pages.map((p) => ({ path: `${p.id}.html`, basename: p.id })),
    publicRouteSlug: "campaign",
    outputDir: "src/campaign",
  });
  const frontmatter = result.mappings.find((m) => m.page_id === "p").page_kit.frontmatter;
  assert.equal(frontmatter.next_url, "/campaign/next-target/");
  assert.equal(frontmatter.decline_url, "/campaign/decline-target/");
});

// #531: an older saved Map stored page_url values with the host in them.
const HOST_ROUTE_CASES = [
  ["shop.example.com/route/x/", "/route/x/"],
  ["https://shop.example.com/route/x/", "/route/x/"],
  ["http://shop.example.com/route/x/", "/route/x/"],
  ["//shop.example.com/route/x/", "/route/x/"],
  ["SHOP.Example.com/route/", "/route/"],
  ["localhost:8080/route/", "/route/"],
  ["shop.example.com:8443/route/x/", "/route/x/"],
  ["127.0.0.1:4000/route/x/", "/route/x/"],
  ["192.168.0.255/route/x/", "/route/x/"],
  ["shop.example.com/route/x/?variant=b#offer", "/route/x/?variant=b#offer"],
  ["https://shop.example.com?variant=b", "/?variant=b"],
  ["https://shop.example.com", "/"],
];
const NOT_HOST_ROUTE_CASES = [
  "/route/x/",
  "/",
  "route/x/",
  "v1.2/offer/",
  "300.1.2.3/offer/",
  "999.999.999.999/offer/",
  "256.0.0.1/x/",
  "checkout.html",
  "landing/index.html",
  "//route/x/",
  "shop.example.com",
  "ftp://shop.example.com/route/x/",
  "",
  "   ",
  null,
  undefined,
];

test("parseHostPrefixedRoute keeps the rooted path of a host-prefixed route and leaves every route alone", () => {
  for (const [value, rooted] of HOST_ROUTE_CASES) {
    const parsed = parseHostPrefixedRoute(value);
    assert.ok(parsed, `expected ${JSON.stringify(value)} to read as host-prefixed`);
    assert.equal(parsed.to, rooted, JSON.stringify(value));
    assert.equal(parsed.from, value);
  }
  for (const value of NOT_HOST_ROUTE_CASES) {
    assert.equal(parseHostPrefixedRoute(value), null, `expected ${JSON.stringify(value)} to stay a route`);
  }
  // An absolute URL is a valid SDK routing target doctor already accepts;
  // only the bare and protocol-relative forms count there.
  assert.equal(parseHostPrefixedRoute("https://shop.example.com/route/x/", { routing: true }), null);
  assert.equal(parseHostPrefixedRoute("shop.example.com/route/x/", { routing: true }).to, "/route/x/");
});

test("stripHostPrefixedRoutes records one evidence entry per changed value and returns a clean spec unchanged", () => {
  const clean = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
  const untouched = stripHostPrefixedRoutes(clean);
  assert.equal(untouched.spec, clean);
  assert.deepEqual(untouched.evidence, []);

  const spec = structuredClone(clean);
  const [, checkout, upsell] = spec.funnels[0].pages;
  upsell.page_url = " shop.example.com/runtime-packet-demo/upsell/?b=1#top";
  checkout.sdk_hints.meta_tags["next-success-url"] = "shop.example.com/runtime-packet-demo/upsell/";
  upsell.sdk_hints.meta_tags["next-upsell-accept-url"] = "https://shop.example.com/runtime-packet-demo/receipt/";
  spec.funnel_pages = [{ id: "upsell", page_url: "https://shop.example.com/runtime-packet-demo/upsell/" }];
  const before = structuredClone(spec);

  const { spec: stripped, evidence } = stripHostPrefixedRoutes(spec);
  assert.deepEqual(spec, before, "the input spec is not mutated");
  assert.deepEqual(evidence, [
    { code: "routing_meta.host_stripped", page_id: "checkout", field: "funnels[0].pages[1].sdk_hints.meta_tags.next-success-url", from: "shop.example.com/runtime-packet-demo/upsell/", to: "/runtime-packet-demo/upsell/" },
    { code: "routing_meta.host_stripped", page_id: "upsell", field: "funnels[0].pages[2].page_url", from: " shop.example.com/runtime-packet-demo/upsell/?b=1#top", to: "/runtime-packet-demo/upsell/?b=1#top" },
    { code: "routing_meta.host_stripped", page_id: "upsell", field: "funnel_pages[0].page_url", from: "https://shop.example.com/runtime-packet-demo/upsell/", to: "/runtime-packet-demo/upsell/" },
  ]);
  assert.equal(stripped.funnels[0].pages[2].page_url, "/runtime-packet-demo/upsell/?b=1#top");
  assert.equal(stripped.funnels[0].pages[1].sdk_hints.meta_tags["next-success-url"], "/runtime-packet-demo/upsell/");
  // An absolute URL in a routing meta tag is a valid SDK target: kept.
  assert.equal(stripped.funnels[0].pages[2].sdk_hints.meta_tags["next-upsell-accept-url"], "https://shop.example.com/runtime-packet-demo/receipt/");
  assert.equal(stripped.funnels[0].pages[0].page_url, "landing/");
});

function runCliRaw(args, { preload = null } = {}) {
  const result = spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAMPAIGNS_API_KEY: "", CAMPAIGNS_OS_TELEMETRY: "off" },
  });
  return { status: result.status, stderr: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

function hostPrefixSpec(specPath) {
  const spec = readJson(specPath);
  const [, checkout, upsell] = spec.funnels[0].pages;
  upsell.page_url = "shop.example.com/runtime-packet-demo/upsell/";
  checkout.sdk_hints.meta_tags["next-success-url"] = "shop.example.com/runtime-packet-demo/upsell/";
  return spec;
}

test("start leaves a local spec with host-prefixed routes byte-identical, says it must be edited, and doctor blocks", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    writeJson(specPath, hostPrefixSpec(specPath));
    const bytes = readFileSync(specPath);
    const mtime = statSync(specPath).mtimeMs;
    const result = runCliRaw(["start", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    assert.ok(result.json, result.stderr);

    assert.deepEqual(readFileSync(specPath), bytes, "an operator's spec file is never rewritten");
    assert.equal(statSync(specPath).mtimeMs, mtime);
    assert.equal(result.json.context.spec.hash, createHash("sha256").update(bytes).digest("hex"));
    const report = readJson(resolve(targetRepo, result.json.context.report_path));
    assert.deepEqual(report.evidence, [], "nothing was changed, so nothing is recorded as stripped");

    const notices = result.stderr.split("\n").filter((line) => line.includes("host-prefixed route"));
    assert.equal(notices.length, 1, result.stderr);
    assert.match(notices[0], /must be edited/);
    assert.match(notices[0], /"shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);

    const blocker = (result.json.doctor?.errors || []).find((issue) => issue.code === "routing_meta.host_prefixed");
    assert.ok(blocker, JSON.stringify((result.json.doctor?.errors || []).map((issue) => issue.code)));
    assert.match(blocker.message, /upsell:page_url "shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);
  });
});

test("prepare-build leaves a spec with no host-prefixed route byte-identical and records no evidence", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const bytes = readFileSync(specPath);
    const mtime = statSync(specPath).mtimeMs;
    const result = runCliRaw(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    assert.ok(result.json, result.stderr);
    assert.deepEqual(readFileSync(specPath), bytes);
    assert.equal(statSync(specPath).mtimeMs, mtime, "the spec file is not rewritten");
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(result.json.context.spec.hash, hash);
    assert.equal(result.json.context.spec.material_hash, specMaterialHash(JSON.parse(bytes)));
    const report = readJson(resolve(targetRepo, result.json.context.report_path));
    assert.equal(report.identity.spec_hash, hash);
    assert.deepEqual(report.evidence, []);
    assert.equal(result.stderr.includes("routing_meta.host_stripped"), false);
  });
});

// A preload that stands in for the Map store: globalThis.fetch answers every
// request with `served`, so --map-id runs with no network.
function mapFetchPreload(dir, served) {
  const preload = join(dir, "map-fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ ok: true, data: served }))}, { status: 200, headers: { "content-type": "application/json" } });\n`);
  return preload;
}

function cachedSpecPath(targetRepo, mapId) {
  return resolve(targetRepo, ".campaign-runtime/fetched-specs", `${mapId}.json`);
}

test("start --map-id strips the host at intake, caches the rooted spec, records evidence with the value the Map returned, and says so once", () => {
  withIntakeFixture(({ dir, sourceRoot, targetRepo, specPath }) => {
    const served = hostPrefixSpec(specPath);
    const result = runCliRaw(["start", "--map-id", served.spec_identity.map_id, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"], { preload: mapFetchPreload(dir, served) });
    assert.ok(result.json, result.stderr);
    const cachePath = cachedSpecPath(targetRepo, served.spec_identity.map_id);
    const cached = readJson(cachePath);
    assert.equal(cached.funnels[0].pages[2].page_url, "/runtime-packet-demo/upsell/");
    assert.equal(cached.funnels[0].pages[1].sdk_hints.meta_tags["next-success-url"], "/runtime-packet-demo/upsell/");
    const report = readJson(resolve(targetRepo, result.json.context.report_path));
    assert.deepEqual(report.evidence, [
      { code: "routing_meta.host_stripped", page_id: "checkout", field: "funnels[0].pages[1].sdk_hints.meta_tags.next-success-url", from: "shop.example.com/runtime-packet-demo/upsell/", to: "/runtime-packet-demo/upsell/" },
      { code: "routing_meta.host_stripped", page_id: "upsell", field: "funnels[0].pages[2].page_url", from: "shop.example.com/runtime-packet-demo/upsell/", to: "/runtime-packet-demo/upsell/" },
    ]);
    const hash = createHash("sha256").update(readFileSync(cachePath)).digest("hex");
    assert.equal(report.identity.spec_hash, hash, "the recorded spec hash is the rewritten copy's");
    assert.equal(result.json.context.spec.hash, hash);
    const revision = result.json.context.intake.saved_map_revision;
    assert.equal(revision.map_id, served.spec_identity.map_id);
    assert.equal(revision.local_spec_material_hash, specMaterialHash(cached));

    const upsell = result.json.packet.source_html.pages.find((page) => page.page_id === "upsell");
    assert.equal(upsell.page_kit.public_route, "/runtime-packet-demo/upsell/");
    assert.equal(upsell.page_kit.spec_route, "upsell/");
    const checkout = result.json.packet.source_html.pages.find((page) => page.page_id === "checkout");
    assert.equal(checkout.page_kit.frontmatter.next_url, "/runtime-packet-demo/upsell/");

    const notices = result.stderr.split("\n").filter((line) => line.includes("routing_meta.host_stripped"));
    assert.equal(notices.length, 1, result.stderr);
    assert.match(notices[0], /"shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);
    const doctorCodes = (result.json.doctor?.errors || []).map((issue) => issue.code);
    assert.equal(doctorCodes.includes("routing_meta.host_prefixed"), false, "intake left nothing for doctor to block");
  });
});

// The rewrite writes only a regular file whose real path is in
// <target>/.campaign-runtime/fetched-specs/. A symlinked cache entry or
// fetched-specs directory is left as it is, and doctor blocks instead.
for (const [label, link] of [
  ["the cache entry is a symlink to a file outside the target", ({ dir, targetRepo, mapId }) => {
    const external = join(dir, "operator-spec.json");
    mkdirSync(join(targetRepo, ".campaign-runtime/fetched-specs"), { recursive: true });
    symlinkSync(external, cachedSpecPath(targetRepo, mapId));
    return external;
  }],
  ["fetched-specs is a symlinked directory", ({ dir, targetRepo, mapId }) => {
    const externalDir = join(dir, "elsewhere");
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
    symlinkSync(externalDir, join(targetRepo, ".campaign-runtime/fetched-specs"));
    return join(externalDir, `${mapId}.json`);
  }],
]) {
  test(`start --cached-spec leaves a host-prefixed spec unchanged when ${label}, and doctor blocks`, () => {
    withIntakeFixture(({ dir, sourceRoot, targetRepo, specPath }) => {
      const spec = hostPrefixSpec(specPath);
      const mapId = spec.spec_identity.map_id;
      const external = link({ dir, targetRepo, mapId });
      writeJson(external, spec);
      const bytes = readFileSync(external);
      const result = runCliRaw(["start", "--map-id", mapId, "--cached-spec", "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
      assert.ok(result.json, result.stderr);
      // The fixture has no design-source package, so doctor already blocks and
      // start exits 2 on the base commit as well; the exit is unchanged.
      assert.equal(result.status, 2, result.stderr);

      assert.deepEqual(readFileSync(external), bytes, "a file outside fetched-specs/ is never rewritten");
      assert.equal(result.json.context.spec.hash, createHash("sha256").update(bytes).digest("hex"));
      const report = readJson(resolve(targetRepo, result.json.context.report_path));
      assert.deepEqual(report.evidence, []);
      const notices = result.stderr.split("\n").filter((line) => line.includes("host-prefixed route"));
      assert.equal(notices.length, 1, result.stderr);
      assert.match(notices[0], /could not be normalised in place/);
      const blocker = (result.json.doctor?.errors || []).find((issue) => issue.code === "routing_meta.host_prefixed");
      assert.ok(blocker, JSON.stringify((result.json.doctor?.errors || []).map((issue) => issue.code)));
      assert.match(blocker.message, /upsell:page_url "shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);
    });
  });
}

test("start --cached-spec still rewrites a regular cached copy in fetched-specs/", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const spec = hostPrefixSpec(specPath);
    const cachePath = cachedSpecPath(targetRepo, spec.spec_identity.map_id);
    mkdirSync(join(targetRepo, ".campaign-runtime/fetched-specs"), { recursive: true });
    writeJson(cachePath, spec);
    const result = runCliRaw(["start", "--map-id", spec.spec_identity.map_id, "--cached-spec", "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    assert.ok(result.json, result.stderr);
    assert.equal(readJson(cachePath).funnels[0].pages[2].page_url, "/runtime-packet-demo/upsell/");
    const report = readJson(resolve(targetRepo, result.json.context.report_path));
    assert.deepEqual(report.evidence.map((entry) => entry.field), ["funnels[0].pages[1].sdk_hints.meta_tags.next-success-url", "funnels[0].pages[2].page_url"]);
    assert.equal((result.json.doctor?.errors || []).some((issue) => issue.code === "routing_meta.host_prefixed"), false);
  });
});

test("doctor blocks a host-prefixed route that reaches it without intake, naming the value and its rooted form", () => {
  withIntakeFixture(({ sourceRoot, targetRepo, specPath }) => {
    const prepared = runCliRaw(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    assert.ok(prepared.json, prepared.stderr);
    // The spec is edited after intake, so doctor is the first reader.
    writeJson(specPath, hostPrefixSpec(specPath));

    const doctor = runCliRaw(["doctor", "--packet", prepared.json.packetPath, "--json"]).json;
    const blocker = (doctor.errors || []).find((issue) => issue.code === "routing_meta.host_prefixed");
    assert.ok(blocker, `expected a host-prefix blocker; errors=${JSON.stringify((doctor.errors || []).map((issue) => issue.code))}`);
    assert.match(blocker.message, /upsell:page_url "shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);
    assert.match(blocker.message, /checkout:sdk_hints\.meta_tags\.next-success-url "shop\.example\.com\/runtime-packet-demo\/upsell\/" -> "\/runtime-packet-demo\/upsell\/"/);
    // The ordinary unrooted hints still warn, and only they do.
    const warning = (doctor.warnings || []).find((issue) => issue.code === "routing_meta.runtime_root");
    assert.ok(warning);
    assert.equal(warning.message.includes("shop.example.com"), false);
    assert.match(warning.message, /upsell:next-upsell-accept-url=receipt\//);
  });
});
