import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  CHECKPOINT_STATUSES,
  COVERAGE_ROLES,
  DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN,
  DESIGN_SOURCE_PACKAGE_SCHEMA,
  MAPPING_CONFIDENCE_LEVELS,
  SOURCE_READINESS_STATUSES,
  computeDesignSourcePackageMaterialFingerprint,
  createDesignSourcePackageArtifactReference,
  designSourcePackageMaterialProjection,
  evaluateDesignSourcePackageReadiness,
  generateDesignSourcePackageReadback,
  hashDesignSourcePackage,
  hashSerializedDesignSourcePackage,
  serializeAndHashDesignSourcePackage,
  serializeDesignSourcePackage,
  synthesizeHtmlFunnelDesignSourcePackage,
  validateDesignSourcePackage,
} from "./design-source-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(ROOT, "schemas/campaign-design-source-package.v0.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const GENERATED_AT = "2026-08-22T10:00:00.000Z";
const NOW = Date.parse(GENERATED_AT);

function sha(char) {
  return char.repeat(64);
}

function sourcePageMapping({ screenshots = true } = {}) {
  return {
    page_id: "landing",
    path: "pages/landing.html",
    page_type: "producer_landing",
    source_hash: sha("a"),
    page_kit: {
      target_path: "index.html",
      output_path: "campaigns/demo/index.html",
      public_route: "/demo/",
      spec_route: "",
      page_type: "product",
      permalink_required: false,
    },
    ...(screenshots ? {
      screenshot_refs: [
        {
          id: "landing-desktop",
          viewport: "desktop",
          path: "source-screens/landing-desktop.png",
          url: "https://source.example.test/landing?viewport=desktop",
          width: 1440,
          height: 900,
          sha256: sha("b"),
          device_profile: "Desktop 1440",
          browser: "chromium",
          captured_at: "2026-08-22T08:00:00.000Z",
        },
        {
          id: "landing-mobile",
          viewport: "mobile",
          path: "source-screens/landing-mobile.png",
          url: "https://source.example.test/landing?viewport=mobile",
          width: 390,
          height: 844,
          sha256: sha("c"),
          device_profile: "Mobile 390",
          browser: "chromium",
          captured_at: "2026-08-22T08:01:00.000Z",
        },
      ],
    } : {}),
  };
}

function completeTemplateFamily() {
  return {
    family: "olympus",
    version: "2026.08.1",
    template_reference: {
      id: "template-reference-olympus",
      family: "olympus",
      version: "2026.08.1",
      contract_path: "contracts/template-brand-contract.olympus.v0.json",
      artifact_path: "references/olympus/2026.08.1",
      sha256: sha("d"),
      standard_viewport_refs: [
        {
          id: "olympus-desktop",
          viewport: "desktop",
          path: "references/olympus/desktop.png",
          url: "https://templates.example.test/olympus/desktop",
          width: 1440,
          height: 900,
          sha256: sha("e"),
          captured_at: "2026-08-20T09:00:00.000Z",
        },
        {
          id: "olympus-mobile",
          viewport: "mobile",
          path: "references/olympus/mobile.png",
          url: "https://templates.example.test/olympus/mobile",
          width: 390,
          height: 844,
          sha256: sha("f"),
          captured_at: "2026-08-20T09:01:00.000Z",
        },
      ],
    },
  };
}

function readyHtmlPackage(overrides = {}) {
  return synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{
      id: "landing",
      type: "landing",
      label: "Offer Landing",
      custom_name: "Summer Offer",
      page_url: "/demo/",
    }],
    mappings: [sourcePageMapping()],
    manifest: {
      schema_version: "source-html-manifest/v0",
      generated_at: "2026-08-21T00:00:00.000Z",
      generator: "agency-exporter@2.1.0",
      producer_provenance: {
        source_type: "agency_html_export",
        generator_version: "2.1.0",
        material_fingerprint: sha("9"),
        section_exports: [
          {
            page_id: "landing",
            section: "hero",
            type: "image",
            images: [
              "assets/hero-wide.png",
              { path: "assets/hero-mobile.png", width: 390, height: 500 },
            ],
          },
        ],
      },
      files: [
        { path: "pages/landing.html", role: "page", sha256: sha("a") },
        { path: "assets/logo.svg", role: "asset", sha256: sha("1") },
      ],
      pages: [{ page_id: "landing", path: "pages/landing.html", source_hash: sha("a") }],
    },
    manifestPath: ".campaigns-os/source-html-manifest.json",
    assetCrawl: {
      schema_version: "source-asset-crawl/v0",
      scanned_files: [{ path: "pages/landing.html", kind: "html", sha256: sha("a") }],
      references: [{
        raw: "../assets/hero.jpg",
        normalized: "assets/hero.jpg",
        source_path: "assets/hero.jpg",
        asset_kind: "image",
        referenced_by: [{ path: "pages/landing.html", page_ids: ["landing"] }],
      }],
    },
    packageId: "map-demo:design-source",
    campaignMapId: "map-demo",
    campaignSlug: "demo",
    sourceRoot: "/prepared-source",
    generatedAt: GENERATED_AT,
    notes: ["Operator-visible administrative note."],
    presentationIntent: {
      summary: "Preserve the agency-authored editorial landing composition.",
      composition: ["Hero before product proof"],
      content_hierarchy: ["Offer before long-form details"],
      imagery: ["Use supplied product photography"],
      copy: ["Retain supplied headline hierarchy"],
      brand: ["Use supplied warm neutral palette"],
      responsive_behavior: ["Stack proof cards on mobile"],
    },
    ...overrides,
  });
}

function runtimeAndSchemaAgreeValid(packageValue) {
  const runtime = validateDesignSourcePackage(packageValue, { now: NOW });
  const schemaOk = validateSchema(packageValue);
  assert.equal(schemaOk, true, JSON.stringify(validateSchema.errors, null, 2));
  assert.deepEqual(runtime, { ok: true, errors: [], warnings: [] });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function refreshDerived(value) {
  value.readiness = evaluateDesignSourcePackageReadiness(value, {
    generatedAt: value.generated_at,
    now: NOW,
  });
  value.readback = generateDesignSourcePackageReadback(value);
  value.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(value);
  return value;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

test("published schema exposes the v0 identity and exact readiness/coverage vocabularies", () => {
  assert.equal(schema.properties.schema_version.const, DESIGN_SOURCE_PACKAGE_SCHEMA);
  assert.equal(schema.$id, "https://nextcommerce.com/schemas/campaign-design-source-package.v0.schema.json");
  assert.deepEqual(schema.$defs.coverageRole.enum, COVERAGE_ROLES);
  assert.deepEqual(schema.$defs.mappingConfidence.enum, MAPPING_CONFIDENCE_LEVELS);
  assert.deepEqual(schema.$defs.checkpointStatus.enum, CHECKPOINT_STATUSES);
  assert.deepEqual(schema.$defs.sourceReadinessStatus.enum, SOURCE_READINESS_STATUSES);
  assert.equal(schema.$defs.checkpointStatus.enum.includes("ready_with_warnings"), false);
  assert.equal(schema.$defs.checkpointStatus.enum.includes("completed_with_warnings"), true);
  assert.equal(schema.$defs.sourceReadinessStatus.enum.includes("ready_with_warnings"), false);
  assert.equal(schema.additionalProperties, false);
});

test("html_funnel synthesis preserves distinct Surface Identity mappings and produces a schema-valid ready package", () => {
  const packageValue = readyHtmlPackage();

  assert.equal(packageValue.schema_version, DESIGN_SOURCE_PACKAGE_SCHEMA);
  assert.equal(packageValue.readiness.status, "ready");
  assert.match(packageValue.material_fingerprint, DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN);
  assert.deepEqual(packageValue.surface_identity[0], {
    id: "campaign",
    kind: "campaign",
    label: "Campaign",
    aliases: ["map-demo", "demo"],
    mappings: { campaign_map_id: "map-demo", campaign_slug: "demo" },
  });
  const landing = packageValue.surface_identity.find((surface) => surface.id === "landing");
  assert.deepEqual(landing.mappings, {
    campaign_spec_page_id: "landing",
    map_builder_label: "Offer Landing",
    map_builder_custom_name: "Summer Offer",
    public_route: "/demo/",
    producer_page_type: "producer_landing",
    source_page_id: "landing",
    source_path: "pages/landing.html",
    page_kit: {
      target_path: "index.html",
      output_path: "campaigns/demo/index.html",
      public_route: "/demo/",
      spec_route: "",
      page_type: "product",
      permalink_required: false,
    },
  });
  const html = packageValue.contributions.find((contribution) => contribution.id === "html-funnel");
  assert.equal(html.mappings[0].coverage_role, "primary_design");
  assert.equal(html.mappings[0].confidence, "high");
  assert.deepEqual(new Set(html.screenshot_refs.map((ref) => ref.viewport)), new Set(["desktop", "mobile"]));
  assert.equal(html.screenshot_refs.some((ref) => ref.path === "assets/hero.jpg"), false);
  assert.equal(html.screenshot_refs.some((ref) => ref.path === "assets/hero-mobile.png"), false);
  assert.ok(html.source_refs.some((ref) => ref.path === "assets/hero.jpg" && ref.kind === "asset"));
  runtimeAndSchemaAgreeValid(packageValue);
});

test("html_funnel synthesis rejects every non-array array input", () => {
  const arrayInputs = [
    "activePages",
    "mappings",
    "pageMappings",
    "sourceScreenshots",
    "sourceGaps",
    "sourceTodos",
    "waivers",
    "divergences",
    "proposedExceptions",
    "notes",
  ];

  for (const inputName of arrayInputs) {
    assert.throws(
      () => synthesizeHtmlFunnelDesignSourcePackage({ [inputName]: {} }),
      new RegExp(`${inputName} must be an array`),
      inputName,
    );
  }
});

test("html_funnel synthesis rejects malformed nested manifest and crawl collections", () => {
  const cases = [
    ["manifest.files", { manifest: { files: {} } }],
    ["manifest.pages", { manifest: { pages: {} } }],
    ["sourceAssetCrawl.scanned_files", { sourceAssetCrawl: { scanned_files: {} } }],
    ["sourceAssetCrawl.references", { sourceAssetCrawl: { references: {} } }],
    ["assetCrawl.scanned_files", { assetCrawl: { scanned_files: {} } }],
    ["assetCrawl.references", { assetCrawl: { references: {} } }],
  ];

  for (const [inputPath, inputs] of cases) {
    assert.throws(
      () => synthesizeHtmlFunnelDesignSourcePackage(inputs),
      new RegExp(`${inputPath.replace(".", "\\.")} must be an array`),
      inputPath,
    );
  }

  const nullableCollections = synthesizeHtmlFunnelDesignSourcePackage({
    manifest: { files: null, pages: null },
    sourceAssetCrawl: { scanned_files: null, references: null },
    generatedAt: GENERATED_AT,
  });
  assert.equal(nullableCollections.readiness.status, "pending");
  runtimeAndSchemaAgreeValid(nullableCollections);
});

test("html_funnel synthesis rejects invalid or blank active page and mapping IDs", () => {
  const invalidIds = [null, {}, "landing", { id: "" }, { id: "   " }];
  for (const activePage of invalidIds) {
    assert.throws(
      () => synthesizeHtmlFunnelDesignSourcePackage({ activePages: [activePage] }),
      /activePages\[0\] must be an object with a non-empty id/,
    );
  }

  const invalidMappings = [null, {}, "landing", { page_id: "" }, { page_id: "   " }];
  for (const inputName of ["mappings", "pageMappings"]) {
    for (const mapping of invalidMappings) {
      assert.throws(
        () => synthesizeHtmlFunnelDesignSourcePackage({ [inputName]: [mapping] }),
        new RegExp(`${inputName}\\[0\\] must be an object with a non-empty page_id`),
      );
    }
  }
});

test("zero-page html_funnel synthesis remains pending and runtime/schema valid", () => {
  const packageValue = synthesizeHtmlFunnelDesignSourcePackage({ generatedAt: GENERATED_AT });

  assert.deepEqual(packageValue.surface_identity.map(({ id, kind }) => ({ id, kind })), [
    { id: "campaign", kind: "campaign" },
  ]);
  assert.equal(packageValue.readiness.status, "pending");
  assert.deepEqual(packageValue.readiness.blocking_reasons, [
    "No page-level Surface Identity is available for source-readiness evaluation.",
  ]);
  runtimeAndSchemaAgreeValid(packageValue);
});

test("colliding source-reference slugs are stable across manifest record order", () => {
  const files = [
    { path: "assets/a b.css", role: "asset", sha256: sha("1") },
    { path: "assets/a-b.css", role: "asset", sha256: sha("2") },
  ];
  const build = (orderedFiles) => readyHtmlPackage({
    manifest: {
      schema_version: "source-html-manifest/v0",
      files: orderedFiles,
      pages: [{ page_id: "landing", path: "pages/landing.html", source_hash: sha("a") }],
    },
  });
  const first = build(files);
  const reversed = build([...files].reverse());
  const idsByPath = (value) => Object.fromEntries(value.contributions[0].source_refs
    .filter((ref) => files.some((file) => file.path === ref.path))
    .map((ref) => [ref.path, ref.id]));

  assert.deepEqual(idsByPath(first), idsByPath(reversed));
  assert.notEqual(idsByPath(first)[files[0].path], idsByPath(first)[files[1].path]);
  assert.equal(first.material_fingerprint, reversed.material_fingerprint);
  runtimeAndSchemaAgreeValid(first);
  runtimeAndSchemaAgreeValid(reversed);
});

test("manifest page permutations are stable and duplicate page IDs fail deterministically", () => {
  const activePages = [
    { id: "landing", type: "landing", label: "Landing" },
    { id: "checkout", type: "checkout", label: "Checkout" },
  ];
  const mappings = [
    { page_id: "landing", path: "pages/landing.html" },
    { page_id: "checkout", path: "pages/checkout.html" },
  ];
  const uniquePages = [
    { page_id: "landing", path: "pages/landing.html", source_hash: sha("1") },
    { page_id: "checkout", path: "pages/checkout.html", source_hash: sha("2") },
  ];
  const build = (pages) => synthesizeHtmlFunnelDesignSourcePackage({
    activePages,
    mappings,
    manifest: { schema_version: "source-html-manifest/v0", pages },
    generatedAt: GENERATED_AT,
  });
  const first = build(uniquePages);
  const reversed = build([...uniquePages].reverse());
  assert.equal(first.material_fingerprint, reversed.material_fingerprint);
  runtimeAndSchemaAgreeValid(first);
  runtimeAndSchemaAgreeValid(reversed);

  const duplicates = [
    { page_id: "landing", path: "pages/landing.html", source_hash: sha("3") },
    { page_id: "landing", path: "pages/alternate.html", source_hash: sha("4") },
  ];
  const messages = [];
  for (const pages of [duplicates, [...duplicates].reverse()]) {
    assert.throws(
      () => build(pages),
      (error) => {
        messages.push(error.message);
        return error instanceof TypeError
          && error.message === 'manifest.pages contains duplicate page_id "landing".';
      },
    );
  }
  assert.deepEqual(messages, [messages[0], messages[0]]);
});

test("renderable primary_design emits typed blocking Source TODOs without explicit desktop/mobile proof", () => {
  const packageValue = readyHtmlPackage({
    mappings: [sourcePageMapping({ screenshots: false })],
    manifest: {
      schema_version: "source-html-manifest/v0",
      producer_provenance: {
        section_exports: [{
          page_id: "landing",
          section: "hero",
          type: "image",
          images: [
            "exports/hero-desktop.png",
            { path: "exports/hero-mobile.png", width: 390, height: 844 },
          ],
        }],
      },
      pages: [{ page_id: "landing", path: "pages/landing.html" }],
    },
    assetCrawl: {
      schema_version: "source-asset-crawl/v0",
      scanned_files: [],
      references: [{
        raw: "screenshots/landing-desktop.png",
        normalized: "screenshots/landing-desktop.png",
        source_path: "screenshots/landing-desktop.png",
        asset_kind: "image",
        referenced_by: [{ page_ids: ["landing"] }],
      }],
    },
  });

  assert.equal(packageValue.readiness.status, "blocked");
  assert.deepEqual(
    packageValue.source_todos.map((todo) => [todo.kind, todo.required_viewports?.[0]]).sort(),
    [
      ["missing_source_screenshot", "desktop"],
      ["missing_source_screenshot", "mobile"],
    ],
  );
  assert.deepEqual(packageValue.contributions[0].screenshot_refs, []);
  assert.ok(packageValue.contributions[0].source_refs.some((ref) => ref.path === "screenshots/landing-desktop.png"));
  runtimeAndSchemaAgreeValid(packageValue);
});

test("section export becomes screenshot proof only when it carries an explicit shared viewport", () => {
  const packageValue = readyHtmlPackage({
    mappings: [sourcePageMapping({ screenshots: false })],
    manifest: {
      schema_version: "source-html-manifest/v0",
      producer_provenance: {
        section_exports: [{
          page_id: "landing",
          section: "page",
          type: "render",
          images: [
            { id: "explicit-desktop", viewport: "desktop", path: "exports/page-desktop.png" },
            { id: "explicit-mobile", viewport_key: "mobile", path: "exports/page-mobile.png" },
          ],
        }],
      },
      pages: [{ page_id: "landing", path: "pages/landing.html" }],
    },
  });

  assert.equal(packageValue.readiness.status, "ready");
  assert.deepEqual(new Set(packageValue.contributions[0].screenshot_refs.map((ref) => ref.viewport)), new Set(["desktop", "mobile"]));
  runtimeAndSchemaAgreeValid(packageValue);
});

test("template baseline is emitted only with linked family/version/contract and standard viewport proof", () => {
  const activePages = [{ id: "checkout", type: "checkout", label: "Checkout", page_url: "/demo/checkout/" }];
  const mappings = [{ page_id: "checkout", skip_reason: "Use selected template" }];

  const missingProof = synthesizeHtmlFunnelDesignSourcePackage({
    activePages,
    mappings,
    templateFamily: "olympus",
    generatedAt: GENERATED_AT,
  });
  assert.equal(missingProof.readiness.status, "blocked");
  assert.ok(missingProof.source_todos.some((todo) => todo.kind === "missing_template_reference"));
  assert.equal(
    missingProof.contributions.flatMap((contribution) => contribution.mappings)
      .some((mapping) => mapping.coverage_role === "template_baseline"),
    false,
  );
  runtimeAndSchemaAgreeValid(missingProof);

  const proven = synthesizeHtmlFunnelDesignSourcePackage({
    activePages,
    mappings,
    templateFamily: completeTemplateFamily(),
    generatedAt: GENERATED_AT,
  });
  const contribution = proven.contributions.find((entry) => entry.id === "template-baseline");
  assert.equal(proven.readiness.status, "ready");
  assert.equal(contribution.mappings[0].coverage_role, "template_baseline");
  assert.equal(contribution.mappings[0].template_reference_id, "template-reference-olympus");
  assert.deepEqual(new Set(contribution.template_reference.standard_viewport_refs.map((ref) => ref.viewport)), new Set(["desktop", "mobile"]));
  runtimeAndSchemaAgreeValid(proven);
});

test("template family linkage with a missing standard viewport yields typed blocking work, never an invented ref", () => {
  const templateFamily = completeTemplateFamily();
  templateFamily.template_reference.standard_viewport_refs.pop();
  const packageValue = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "checkout", type: "checkout", label: "Checkout" }],
    mappings: [{ page_id: "checkout", skip_reason: "Use template" }],
    templateFamily,
    generatedAt: GENERATED_AT,
  });

  assert.equal(packageValue.readiness.status, "blocked");
  assert.ok(packageValue.source_todos.some((todo) =>
    todo.kind === "missing_template_viewport" && todo.required_viewports.includes("mobile")));
  assert.equal(packageValue.contributions.find((entry) => entry.id === "template-baseline").mappings.length, 0);
  runtimeAndSchemaAgreeValid(packageValue);
});

test("attributed Source Gaps and approved time-bound waivers produce their distinct ready states", () => {
  const gapPackage = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "checkout", type: "checkout", label: "Checkout" }],
    mappings: [{ page_id: "checkout", skip_reason: "No bespoke checkout source" }],
    sourceGaps: [{
      id: "gap-checkout-design",
      kind: "coverage_absence",
      scope: "primary_design_coverage",
      applies_to: ["checkout"],
      reason: "Agency source intentionally excludes checkout composition.",
      status: "accepted",
      attributed_by: "design-owner@example.test",
      attributed_at: GENERATED_AT,
    }],
    generatedAt: GENERATED_AT,
  });
  assert.equal(gapPackage.readiness.status, "ready_with_gaps");
  assert.equal(gapPackage.source_todos.length, 0);
  runtimeAndSchemaAgreeValid(gapPackage);

  const waiverPackage = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "landing", type: "landing", label: "Landing" }],
    mappings: [sourcePageMapping({ screenshots: false })],
    waivers: [{
      id: "waiver-landing-capture",
      scope: "source_screenshot",
      applies_to: ["landing"],
      reason: "Canonical source host is unavailable after design-owner approval.",
      status: "approved",
      waived_by: "operator@example.test",
      waived_at: GENERATED_AT,
      expires_at: "2026-09-22T10:00:00.000Z",
    }],
    generatedAt: GENERATED_AT,
  });
  assert.equal(waiverPackage.readiness.status, "ready_with_waivers");
  assert.equal(waiverPackage.source_todos.length, 0);
  runtimeAndSchemaAgreeValid(waiverPackage);
});

test("waiver activity is deterministic for expiry, status, and review-condition boundaries", () => {
  const pageSurface = {
    id: "landing",
    kind: "page",
    label: "Landing",
    aliases: ["landing"],
    mappings: {},
  };
  const cases = [
    ["future expiry", { status: "approved", expires_at: "2026-08-22T10:00:00.001Z" }, "ready_with_waivers"],
    ["expiry equal to now", { status: "approved", expires_at: GENERATED_AT }, "blocked"],
    ["past expiry", { status: "approved", expires_at: "2026-08-22T09:59:59.999Z" }, "blocked"],
    ["invalid expiry", { status: "approved", expires_at: "not-a-date" }, "blocked"],
    ["revoked future waiver", { status: "revoked", expires_at: "2026-08-22T10:00:00.001Z" }, "blocked"],
    ["review condition only", { status: "approved", review_condition: "Review before source host access resumes." }, "ready_with_waivers"],
  ];

  for (const [label, waiverState, expectedStatus] of cases) {
    const readiness = evaluateDesignSourcePackageReadiness({
      generated_at: GENERATED_AT,
      surface_identity: [pageSurface],
      contributions: [],
      source_gaps: [],
      source_todos: [],
      waivers: [{
        id: "waiver-landing-design",
        scope: "primary_design_coverage",
        applies_to: ["landing"],
        reason: "Explicit test waiver.",
        waived_by: "operator@example.test",
        waived_at: GENERATED_AT,
        ...waiverState,
      }],
      divergences: [],
      proposed_exceptions: [],
    }, { generatedAt: GENERATED_AT, now: NOW });

    assert.equal(readiness.status, expectedStatus, label);
  }
});

test("runtime rejects ready when an active page lacks primary, Template Reference baseline, gap, or waiver", () => {
  const forged = readyHtmlPackage();
  forged.contributions[0].mappings = [];
  forged.source_todos = [];
  forged.readiness = {
    status: "ready",
    blocking_reasons: [],
    gap_count: 0,
    todo_count: 0,
    waiver_count: 0,
    generated_at: GENERATED_AT,
  };
  forged.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(forged);

  assert.equal(validateSchema(forged), true, JSON.stringify(validateSchema.errors, null, 2));
  const runtime = validateDesignSourcePackage(forged, { now: NOW });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.readiness_contradiction"));
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.readiness_blockers"));
});

test("current page scope validation rejects a package that omits or contradicts the active intake", () => {
  const packageValue = readyHtmlPackage();
  const validScope = {
    activePages: [{
      id: "landing",
      type: "landing",
      label: "Offer Landing",
      custom_name: "Summer Offer",
      page_url: "/demo/",
    }],
    mappings: [sourcePageMapping()],
    campaignMapId: "map-demo",
    campaignSlug: "demo",
  };
  assert.equal(validateDesignSourcePackage(packageValue, { now: NOW, currentPageScope: validScope }).ok, true);

  const missingPage = validateDesignSourcePackage(packageValue, {
    now: NOW,
    currentPageScope: {
      ...validScope,
      activePages: [...validScope.activePages, { id: "checkout", type: "checkout", label: "Checkout" }],
      mappings: [...validScope.mappings, { page_id: "checkout", skip_reason: "Use template" }],
    },
  });
  assert.equal(missingPage.ok, false);
  assert.ok(missingPage.errors.some((error) => error.code === "design_source_package.current_page_missing"));

  const stalePath = validateDesignSourcePackage(packageValue, {
    now: NOW,
    currentPageScope: {
      ...validScope,
      mappings: [{ ...sourcePageMapping(), path: "pages/revised-landing.html" }],
    },
  });
  assert.equal(stalePath.ok, false);
  assert.ok(stalePath.errors.some((error) =>
    error.code === "design_source_package.current_page_mapping_stale"
    && error.path.endsWith(".source_path")));
});

test("current page scope rejects malformed collections and blank page or mapping IDs", () => {
  const zeroPagePackage = synthesizeHtmlFunnelDesignSourcePackage({ generatedAt: GENERATED_AT });
  const cases = [
    ["non-array activePages", { activePages: {}, mappings: [] }],
    ["non-array mappings", { activePages: [], mappings: {} }],
    ["non-object active page", { activePages: [null], mappings: [] }],
    ["blank active page id", { activePages: [{ id: "   " }], mappings: [] }],
    ["non-object mapping", { activePages: [], mappings: [null] }],
    ["blank mapping page_id", { activePages: [], mappings: [{ page_id: " " }] }],
  ];

  for (const [label, currentPageScope] of cases) {
    const result = validateDesignSourcePackage(zeroPagePackage, {
      now: NOW,
      currentPageScope,
    });
    assert.equal(result.ok, false, label);
    assert.ok(
      result.errors.some((error) => error.code === "design_source_package.current_page_scope"),
      label,
    );
  }
});

test("indexed synthesis and freshness validation preserve page-local material at scale", () => {
  const pageCount = 256;
  const activePages = Array.from({ length: pageCount }, (_, index) => ({
    id: `page-${index}`,
    type: "landing",
    label: `Page ${index}`,
  }));
  const mappings = Array.from({ length: pageCount }, (_, index) => ({
    page_id: `page-${index}`,
    path: `pages/page-${index}.html`,
    coverage_role: "primary_design",
    confidence: "medium",
  }));
  const references = Array.from({ length: pageCount }, (_, index) => ({
    source_path: `assets/asset-${index}.png`,
    normalized: `assets/asset-${index}.png`,
    asset_kind: "image",
    referenced_by: [{ page_ids: [`page-${index}`] }],
  }));
  const inputs = {
    activePages,
    mappings,
    assetCrawl: { schema_version: "source-asset-crawl/v0", references },
    generatedAt: GENERATED_AT,
  };
  const packageValue = synthesizeHtmlFunnelDesignSourcePackage(inputs);
  const html = packageValue.contributions[0];

  assert.equal(html.mappings.length, pageCount);
  assert.equal(html.source_refs.length, pageCount * 2);
  assert.equal(packageValue.source_todos.length, pageCount * 2);
  assert.ok(html.mappings.every((mapping) => mapping.source_refs.length === 2));
  assert.equal(validateDesignSourcePackage(packageValue, {
    now: NOW,
    currentHtmlFunnelScope: inputs,
  }).ok, true);

  const staleAsset = clone(packageValue);
  staleAsset.contributions[0].source_refs
    .find((ref) => ref.path === "assets/asset-127.png").role = "font";
  refreshDerived(staleAsset);
  const staleResult = validateDesignSourcePackage(staleAsset, {
    now: NOW,
    currentHtmlFunnelScope: inputs,
  });
  assert.equal(staleResult.ok, false);
  assert.ok(staleResult.errors.some((error) =>
    error.code === "design_source_package.current_source_material_stale"));
});

test("readiness is independent of contribution order when complete and incomplete primary claims coexist", () => {
  const first = readyHtmlPackage();
  const incomplete = clone(first.contributions[0]);
  incomplete.id = "incomplete-html";
  incomplete.mappings[0].id = "incomplete-landing-coverage";
  incomplete.screenshot_refs = [];
  incomplete.mappings[0].screenshot_refs = [];
  first.contributions.push(incomplete);
  refreshDerived(first);

  const reversed = clone(first);
  reversed.contributions.reverse();
  refreshDerived(reversed);

  assert.equal(first.readiness.status, "ready");
  assert.equal(reversed.readiness.status, "ready");
  assert.equal(first.material_fingerprint, reversed.material_fingerprint);
  runtimeAndSchemaAgreeValid(first);
  runtimeAndSchemaAgreeValid(reversed);
});

test("source readiness accepts only linked source_screenshot proof, never render_reference evidence", () => {
  const packageValue = readyHtmlPackage({
    mappings: [{
      ...sourcePageMapping({ screenshots: false }),
      screenshot_refs: [
        { id: "wrong-desktop", kind: "render_reference", viewport: "desktop", path: "refs/desktop.png" },
        { id: "wrong-mobile", kind: "render_reference", viewport: "mobile", path: "refs/mobile.png" },
      ],
    }],
  });

  assert.equal(packageValue.readiness.status, "blocked");
  assert.deepEqual(packageValue.contributions[0].screenshot_refs, []);
  assert.deepEqual(
    new Set(packageValue.source_todos.flatMap((todo) => todo.required_viewports || [])),
    new Set(["desktop", "mobile"]),
  );
  runtimeAndSchemaAgreeValid(packageValue);
});

test("Template Reference readiness accepts only linked template_reference_screenshot proof", () => {
  const templateFamily = completeTemplateFamily();
  templateFamily.template_reference.standard_viewport_refs[0].kind = "source_screenshot";
  templateFamily.template_reference.standard_viewport_refs[1].kind = "render_reference";
  const packageValue = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "checkout", type: "checkout", label: "Checkout" }],
    mappings: [{ page_id: "checkout", skip_reason: "Use template" }],
    templateFamily,
    generatedAt: GENERATED_AT,
  });

  assert.equal(packageValue.readiness.status, "blocked");
  const templateContribution = packageValue.contributions.find((entry) => entry.id === "template-baseline");
  assert.deepEqual(templateContribution.template_reference.standard_viewport_refs, []);
  assert.equal(templateContribution.mappings.length, 0);
  assert.deepEqual(
    new Set(packageValue.source_todos.flatMap((todo) => todo.required_viewports || [])),
    new Set(["desktop", "mobile"]),
  );
  runtimeAndSchemaAgreeValid(packageValue);
});

test("unknown visual source_ref_id cannot satisfy proof and is rejected cross-record", () => {
  const forged = readyHtmlPackage();
  forged.contributions[0].screenshot_refs[0].source_ref_id = "unknown-source-ref";
  refreshDerived(forged);

  assert.equal(forged.readiness.status, "blocked");
  assert.equal(validateSchema(forged), true, JSON.stringify(validateSchema.errors, null, 2));
  const runtime = validateDesignSourcePackage(forged, { now: NOW });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.visual_source_ref"));
});

test("gap kind/scope and waiver scope must match the readiness defect they excuse", () => {
  const wrongGap = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "checkout", type: "checkout", label: "Checkout" }],
    mappings: [{ page_id: "checkout", skip_reason: "No design" }],
    sourceGaps: [{
      id: "gap-copy-reference",
      kind: "reference_absence",
      scope: "copy_source",
      applies_to: ["checkout"],
      reason: "Copy annotations are missing.",
      status: "accepted",
      attributed_by: "copy-owner@example.test",
    }],
    generatedAt: GENERATED_AT,
  });
  assert.equal(wrongGap.readiness.status, "blocked");
  assert.ok(wrongGap.source_todos.some((todo) => todo.kind === "missing_primary_design"));
  runtimeAndSchemaAgreeValid(wrongGap);

  const wrongWaiver = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [{ id: "landing", type: "landing", label: "Landing" }],
    mappings: [sourcePageMapping({ screenshots: false })],
    waivers: [{
      id: "waiver-copy",
      scope: "copy_source",
      applies_to: ["landing"],
      reason: "Copy owner approved a wording exception.",
      status: "approved",
      waived_by: "operator@example.test",
      waived_at: GENERATED_AT,
      expires_at: "2026-09-22T10:00:00.000Z",
    }],
    generatedAt: GENERATED_AT,
  });
  assert.equal(wrongWaiver.readiness.status, "blocked");
  assert.equal(wrongWaiver.source_todos.filter((todo) => todo.kind === "missing_source_screenshot").length, 2);
  runtimeAndSchemaAgreeValid(wrongWaiver);
});

test("waiver applies_to targets must resolve to package records, surfaces, or supported freshness fields", () => {
  const forged = readyHtmlPackage({
    waivers: [{
      id: "waiver-ghost",
      scope: "source_screenshot",
      applies_to: ["ghost-surface"],
      reason: "Invalid target regression fixture.",
      status: "approved",
      waived_by: "operator@example.test",
      waived_at: GENERATED_AT,
      expires_at: "2026-09-22T10:00:00.000Z",
    }],
  });

  assert.equal(validateSchema(forged), true, JSON.stringify(validateSchema.errors, null, 2));
  const runtime = validateDesignSourcePackage(forged, { now: NOW });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.waiver_target_missing"));
});

test("skipped Source TODO remains blocking and invalid until an approved scoped waiver targets it", () => {
  const unwaived = readyHtmlPackage({
    sourceTodos: [{
      id: "todo-unreadable-reference",
      kind: "unreadable_reference",
      scope: "reference",
      applies_to: ["campaign"],
      description: "Replace the unreadable source reference.",
      status: "skipped",
      owner: "source_preparation",
    }],
  });
  assert.equal(unwaived.readiness.status, "blocked");
  assert.equal(validateSchema(unwaived), true, JSON.stringify(validateSchema.errors, null, 2));
  const unwaivedRuntime = validateDesignSourcePackage(unwaived, { now: NOW });
  assert.equal(unwaivedRuntime.ok, false);
  assert.ok(unwaivedRuntime.errors.some((error) => error.code === "design_source_package.todo_skipped_without_waiver"));

  const waived = readyHtmlPackage({
    sourceTodos: [{
      id: "todo-unreadable-reference",
      kind: "unreadable_reference",
      scope: "reference",
      applies_to: ["campaign"],
      description: "Replace the unreadable source reference.",
      status: "skipped",
      owner: "source_preparation",
    }],
    waivers: [{
      id: "waiver-unreadable-reference",
      scope: "reference",
      applies_to: ["todo-unreadable-reference"],
      reason: "Design owner supplied equivalent signed comparison proof.",
      status: "approved",
      waived_by: "operator@example.test",
      waived_at: GENERATED_AT,
      expires_at: "2026-09-22T10:00:00.000Z",
    }],
  });
  assert.equal(waived.readiness.status, "ready_with_waivers");
  runtimeAndSchemaAgreeValid(waived);
});

test("runtime rejects template_baseline mappings without matching Template Reference proof", () => {
  const forged = readyHtmlPackage();
  forged.contributions[0].mappings[0].coverage_role = "template_baseline";
  forged.contributions[0].mappings[0].template_reference_id = "invented-template-reference";
  forged.readiness.status = "ready";
  forged.readiness.blocking_reasons = [];
  forged.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(forged);

  const runtime = validateDesignSourcePackage(forged, { now: NOW });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.template_baseline_reference"));
});

test("published schema and runtime agree on representative malformed records", () => {
  const valid = readyHtmlPackage();
  const cases = [
    (value) => { value.unknown_admin_bucket = {}; },
    (value) => { value.contributions[0].mappings[0].coverage_role = "full_design"; },
    (value) => { value.contributions[0].screenshot_refs[0].viewport = "wide"; },
    (value) => { value.surface_identity[1].mappings.page_kit.unexpected = true; },
    (value) => { value.source_todos = "none"; },
  ];

  for (const mutate of cases) {
    const malformed = clone(valid);
    mutate(malformed);
    assert.equal(validateSchema(malformed), false, "published schema should reject malformed package");
    assert.equal(validateDesignSourcePackage(malformed, { now: NOW, verifyFingerprint: false }).ok, false, "runtime should reject malformed package");
  }
});

test("schema and runtime both reject an empty Surface Identity catalog", () => {
  const malformed = readyHtmlPackage();
  malformed.surface_identity = [];

  assert.equal(validateSchema(malformed), false);
  const runtime = validateDesignSourcePackage(malformed, {
    now: NOW,
    verifyFingerprint: false,
  });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) =>
    error.code === "design_source_package.campaign_surface"
    && error.path === "$.surface_identity"));
});

test("schema and runtime agree on nullable-string boundaries and administrative note types", () => {
  const valid = readyHtmlPackage();
  const cases = [
    ["numeric contribution note", (value) => { value.contributions[0].notes = 7; }],
    ["numeric visual note", (value) => { value.contributions[0].screenshot_refs[0].notes = 7; }],
    ["empty nullable Surface mapping", (value) => { value.surface_identity[1].mappings.map_builder_label = ""; }],
  ];

  for (const [label, mutate] of cases) {
    const malformed = clone(valid);
    mutate(malformed);
    assert.equal(validateSchema(malformed), false, `${label}: schema should reject`);
    assert.equal(
      validateDesignSourcePackage(malformed, { now: NOW, verifyFingerprint: false }).ok,
      false,
      `${label}: runtime should reject`,
    );
  }
});

test("ID-less explicit source screenshots deduplicate and fingerprint independently of input order", () => {
  const sourceScreenshots = [
    { page_id: "landing", viewport: "desktop", path: "captures/landing-desktop-a.png", width: 1440, height: 900, sha256: sha("4") },
    { page_id: "landing", viewport: "mobile", path: "captures/landing-mobile.png", width: 390, height: 844, sha256: sha("5") },
    { page_id: "landing", viewport: "tablet", path: "captures/landing-tablet.png", width: 768, height: 1024, sha256: sha("6") },
    { page_id: "landing", viewport: "desktop", path: "captures/landing-desktop-b.png", width: 1280, height: 800, sha256: sha("7") },
  ];
  const first = readyHtmlPackage({
    mappings: [sourcePageMapping({ screenshots: false })],
    sourceScreenshots,
  });
  const reversed = readyHtmlPackage({
    mappings: [sourcePageMapping({ screenshots: false })],
    sourceScreenshots: [...sourceScreenshots].reverse(),
  });

  assert.equal(first.contributions[0].screenshot_refs.length, 4);
  assert.equal(reversed.contributions[0].screenshot_refs.length, 4);
  assert.deepEqual(first.contributions[0].screenshot_refs, reversed.contributions[0].screenshot_refs);
  assert.deepEqual(first.contributions[0].mappings[0].screenshot_refs, reversed.contributions[0].mappings[0].screenshot_refs);
  assert.equal(first.material_fingerprint, reversed.material_fingerprint);
  runtimeAndSchemaAgreeValid(first);
  runtimeAndSchemaAgreeValid(reversed);
});

test("administrative timestamps, readback, notes, material_fingerprint field, and key order do not change material fingerprint", () => {
  const original = readyHtmlPackage();
  const originalFingerprint = computeDesignSourcePackageMaterialFingerprint(original);
  const administrative = reverseObjectKeys(clone(original));
  administrative.generated_at = "2030-01-01T00:00:00.000Z";
  administrative.readiness.generated_at = "2030-01-01T00:00:00.000Z";
  administrative.readback.summary = "Reworded administrative readback prose.";
  administrative.readback.handled = ["Entirely different presentation prose."];
  administrative.notes = ["Changed top-level administrative note."];
  administrative.material_fingerprint = `sha256:${sha("0")}`;
  administrative.contributions[0].notes = "Changed contribution note.";
  administrative.contributions[0].mappings[0].notes = "Changed mapping note.";
  administrative.contributions[0].source_refs[0].notes = "Changed source-ref note.";
  administrative.contributions[0].screenshot_refs[0].notes = "Changed screenshot note.";
  administrative.contributions[0].screenshot_refs[0].captured_at = "2035-05-05T05:05:05.000Z";

  assert.equal(computeDesignSourcePackageMaterialFingerprint(administrative), originalFingerprint);
  assert.deepEqual(designSourcePackageMaterialProjection(administrative), designSourcePackageMaterialProjection(original));
});

test("changing one coverage mapping changes the material fingerprint", () => {
  const original = readyHtmlPackage();
  const changed = clone(original);
  changed.contributions[0].mappings[0].confidence = "medium";
  assert.notEqual(
    computeDesignSourcePackageMaterialFingerprint(changed),
    computeDesignSourcePackageMaterialFingerprint(original),
  );
});

test("material projection covers representative ADR-0001 material classes", () => {
  const original = readyHtmlPackage({
    activePages: [
      { id: "landing", type: "landing", label: "Offer Landing", page_url: "/demo/" },
      { id: "checkout", type: "checkout", label: "Checkout", page_url: "/demo/checkout/" },
    ],
    mappings: [sourcePageMapping(), { page_id: "checkout", skip_reason: "Template baseline" }],
    templateFamily: completeTemplateFamily(),
  });
  const baseFingerprint = computeDesignSourcePackageMaterialFingerprint(original);
  const materialMutations = [
    ["contribution identity", (value) => { value.contributions[0].id = "agency-html"; }],
    ["contribution kind", (value) => { value.contributions[0].kind = "agency_source"; }],
    ["provenance", (value) => { value.contributions[0].provenance.generator = "changed-generator"; }],
    ["presentation intent", (value) => { value.contributions[0].presentation_intent.summary = "Changed visual intent"; }],
    ["Surface Identity", (value) => { value.surface_identity[1].label = "Changed Landing Label"; }],
    ["Surface mapping", (value) => { value.surface_identity[1].mappings.public_route = "/changed/"; }],
    ["source ref path", (value) => { value.contributions[0].source_refs[0].path = "changed/source.json"; }],
    ["source ref hash", (value) => { value.contributions[0].source_refs[0].sha256 = sha("2"); }],
    ["screenshot viewport", (value) => { value.contributions[0].screenshot_refs[0].viewport = "tablet"; }],
    ["screenshot url", (value) => { value.contributions[0].screenshot_refs[0].url = "https://changed.example.test/source"; }],
    ["screenshot dimensions", (value) => { value.contributions[0].screenshot_refs[0].width += 1; }],
    ["screenshot path", (value) => { value.contributions[0].screenshot_refs[0].path = "changed/screenshot.png"; }],
    ["screenshot hash", (value) => { value.contributions[0].screenshot_refs[0].sha256 = sha("3"); }],
    ["Template Reference linkage", (value) => {
      value.contributions.find((entry) => entry.id === "template-baseline").template_reference.version = "2026.09.0";
    }],
    ["reference ref path", (value) => {
      value.contributions.find((entry) => entry.id === "template-baseline").reference_refs[0].path = "changed/reference.png";
    }],
    ["Source Gap", (value) => { value.source_gaps.push({
      id: "gap-copy",
      kind: "coverage_absence",
      scope: "copy_source",
      applies_to: ["campaign"],
      reason: "No legal copy annotations were supplied.",
      status: "accepted",
      attributed_by: "operator",
    }); }],
    ["Source TODO", (value) => { value.source_todos.push({
      id: "todo-reference",
      kind: "unreadable_reference",
      scope: "reference",
      applies_to: ["campaign"],
      description: "Replace unreadable reference.",
      status: "completed",
      owner: "source_preparation",
    }); }],
    ["accepted waiver", (value) => { value.waivers.push({
      id: "waiver-proof",
      scope: "source_screenshot",
      applies_to: ["landing"],
      reason: "Source host unavailable after agency sign-off.",
      status: "approved",
      waived_by: "operator@example.test",
      waived_at: GENERATED_AT,
      review_condition: "Review before production deploy",
    }); }],
    ["readiness-affecting divergence", (value) => { value.divergences.push({
      id: "divergence-checkout",
      scope: "checkout_layout",
      applies_to: ["checkout"],
      summary: "SDK-owned payment surface differs from source.",
      status: "accepted",
      recorded_stage: "build",
      readiness_affecting: true,
      attributed_by: "build_owner",
    }); }],
    ["readiness-affecting proposed exception", (value) => { value.proposed_exceptions.push({
      id: "exception-mobile-copy",
      scope: "mobile_copy",
      applies_to: ["landing"],
      reason: "Shorten headline at the mobile breakpoint.",
      status: "proposed",
      readiness_affecting: true,
      proposed_by: "design_owner",
    }); }],
  ];

  for (const [label, mutate] of materialMutations) {
    const changed = clone(original);
    mutate(changed);
    assert.notEqual(computeDesignSourcePackageMaterialFingerprint(changed), baseFingerprint, `${label} must be material`);
  }
});

test("serialization, full artifact hash, and artifact reference are canonical and prefixed", () => {
  const packageValue = readyHtmlPackage();
  const reordered = reverseObjectKeys(clone(packageValue));
  const serialized = serializeDesignSourcePackage(packageValue);
  const result = serializeAndHashDesignSourcePackage(packageValue);

  assert.equal(serialized, serializeDesignSourcePackage(reordered));
  assert.equal(result.serialized, serialized);
  assert.equal(result.sha256, hashDesignSourcePackage(packageValue));
  assert.match(result.sha256, DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN);
  assert.equal(result.material_fingerprint, packageValue.material_fingerprint);
  assert.deepEqual(createDesignSourcePackageArtifactReference(packageValue), {
    path: ".campaign-runtime/input/design-source-package.json",
    schema_version: DESIGN_SOURCE_PACKAGE_SCHEMA,
    sha256: result.sha256,
    material_fingerprint: packageValue.material_fingerprint,
  });

  const administrativeChange = clone(packageValue);
  administrativeChange.generated_at = "2030-01-01T00:00:00.000Z";
  assert.notEqual(hashDesignSourcePackage(administrativeChange), result.sha256, "full audit hash includes administrative fields");
  assert.equal(computeDesignSourcePackageMaterialFingerprint(administrativeChange), packageValue.material_fingerprint);
});

test("full artifact hashing hashes exact supplied bytes for audit/reuse", () => {
  const packageValue = readyHtmlPackage();
  const alternateValidBytes = `${JSON.stringify(reverseObjectKeys(packageValue), null, 4)}\n`;
  const expected = `sha256:${createHash("sha256").update(alternateValidBytes).digest("hex")}`;

  assert.equal(hashSerializedDesignSourcePackage(alternateValidBytes), expected);
  assert.equal(hashSerializedDesignSourcePackage(Buffer.from(alternateValidBytes)), expected);
  assert.equal(
    createDesignSourcePackageArtifactReference(packageValue, { serialized: alternateValidBytes }).sha256,
    expected,
  );
  assert.notEqual(expected, hashDesignSourcePackage(packageValue), "alternate valid bytes have a distinct full audit hash");
  assert.throws(
    () => hashSerializedDesignSourcePackage(packageValue),
    /exact artifact bytes/,
    "object values must use hashDesignSourcePackage instead of pretending to be serialized bytes",
  );
});

test("bare and sha256-prefixed nested digests have one material identity", () => {
  const prefixed = synthesizeHtmlFunnelDesignSourcePackage({
    activePages: [
      { id: "landing", type: "landing", label: "Landing" },
      { id: "checkout", type: "checkout", label: "Checkout" },
    ],
    mappings: [sourcePageMapping(), { page_id: "checkout", skip_reason: "Template baseline" }],
    manifest: {
      schema_version: "source-html-manifest/v0",
      producer_provenance: { material_fingerprint: sha("8") },
      pages: [{ page_id: "landing", path: "pages/landing.html", source_hash: sha("a") }],
    },
    templateFamily: completeTemplateFamily(),
    generatedAt: GENERATED_AT,
  });
  const bare = clone(prefixed);
  const rewriteDigests = (value) => {
    if (Array.isArray(value)) return value.forEach(rewriteDigests);
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string"
        && ["sha256", "manifest_sha256", "producer_material_fingerprint"].includes(key)
        && /^(?:sha256:)?[0-9a-f]{64}$/.test(entry)) {
        value[key] = entry.replace(/^sha256:/, "");
      } else rewriteDigests(entry);
    }
  };
  rewriteDigests(bare);

  assert.equal(
    computeDesignSourcePackageMaterialFingerprint(bare),
    computeDesignSourcePackageMaterialFingerprint(prefixed),
  );
});

test("opaque producer material fingerprints remain material", () => {
  const opaqueA = readyHtmlPackage();
  opaqueA.contributions[0].provenance.producer_material_fingerprint = "opaque-a";
  refreshDerived(opaqueA);

  const opaqueB = clone(opaqueA);
  opaqueB.contributions[0].provenance.producer_material_fingerprint = "opaque-b";
  refreshDerived(opaqueB);

  runtimeAndSchemaAgreeValid(opaqueA);
  runtimeAndSchemaAgreeValid(opaqueB);
  assert.equal(
    designSourcePackageMaterialProjection(opaqueA).contributions[0].provenance
      .producer_material_fingerprint,
    "opaque-a",
  );
  assert.equal(
    designSourcePackageMaterialProjection(opaqueB).contributions[0].provenance
      .producer_material_fingerprint,
    "opaque-b",
  );
  assert.notEqual(opaqueA.material_fingerprint, opaqueB.material_fingerprint);
});

test("runtime rejects stale or invented readback guidance", () => {
  const forged = readyHtmlPackage();
  const originalFingerprint = forged.material_fingerprint;
  forged.readback.summary = "Design Source Package is blocked; do not build.";
  forged.readback.blockers = ["Invented blocker not present in structured records."];
  forged.readback.next_actions = ["Do not build."];

  assert.equal(computeDesignSourcePackageMaterialFingerprint(forged), originalFingerprint);
  assert.equal(validateSchema(forged), true, JSON.stringify(validateSchema.errors, null, 2));
  const runtime = validateDesignSourcePackage(forged, { now: NOW });
  assert.equal(runtime.ok, false);
  assert.ok(runtime.errors.some((error) => error.code === "design_source_package.readback_contradiction"));
});

test("material fingerprint format and canonical v0 projection have a golden digest", () => {
  const fingerprint = computeDesignSourcePackageMaterialFingerprint({
    schema_version: DESIGN_SOURCE_PACKAGE_SCHEMA,
    source_kind: "html_funnel",
    surface_identity: [],
    contributions: [],
    source_gaps: [],
    source_todos: [],
    waivers: [],
    divergences: [],
    proposed_exceptions: [],
  });
  assert.equal(fingerprint, "sha256:eb0957a9d782591050c5dda5fe9bd8d457267ab24eb05c64ca33fc5228fb893b");
});
