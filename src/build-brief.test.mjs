import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BUILD_BRIEF_NORMALIZED_REL_PATH,
  BUILD_BRIEF_SCHEMA,
  createCampaignBuildBriefArtifact,
  loadCampaignBuildBriefFile,
  validateCampaignBuildBriefArtifact,
} from "./build-brief.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCliJson(args, { allowFailure = false } = {}) {
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CAMPAIGNS_API_KEY: "" },
    });
    return JSON.parse(output);
  } catch (error) {
    if (allowFailure && typeof error.stdout === "string" && error.stdout.trim()) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function withBriefFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-build-brief-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    for (const page of ["landing", "checkout", "upsell", "receipt"]) {
      writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
    }
    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json")));
    const briefPath = resolve(dir, "campaign-build-brief.yaml");
    // A hand-written file is guided unless it sets brief_mode: prepared.
    writeFileSync(briefPath, `${readFileSync(resolve(ROOT, "examples/campaign-build-brief.single-variant-gadget.yaml"), "utf8").trimEnd()}\nbrief_mode: prepared\n`);
    return run({ dir, sourceRoot, targetRepo, specPath, briefPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function completePreparedBrief() {
  return {
    schema_version: BUILD_BRIEF_SCHEMA,
    brief_mode: "prepared",
    campaign_intent: {
      audience: "busy households",
      conversion_goal: "single-product direct response funnel",
      tone: "direct",
    },
    design_authority: {
      checkout: {
        source: "provided_design_export",
        reference: "checkout.html",
      },
    },
    brand: {
      commerce_palette_source: "landing",
      cta_style: "solid button",
      avoid: ["template-default brand colors"],
    },
    media: {
      sold_variants: ["matte black"],
      allow_other_variant_colors: false,
      prefer: ["clean product renders"],
      avoid: ["wrong product variant"],
    },
    offer_presentation: {
      bundle_cards: {
        primary_price: "discounted unit price",
      },
      post_purchase: {},
    },
    promo_urgency: {
      header_claim_source: "none",
      timer_label: "Limited-time offer",
      show_promo_code_in_timer: false,
      exit_pop: { enabled: false },
      forbid_placeholders: true,
    },
    commerce_surfaces: {
      payment_methods_allowed: ["card"],
      hidden_payment_methods: [],
      order_bump: { enabled: false },
      guarantees: {},
    },
    canonical_display: {
      product_name_source: "campaign_spec",
      allow_runtime_name_override: false,
      manual_overrides: {},
    },
    template_residue_policy: {
      block_placeholders: true,
      block_template_favicon: true,
      block_demo_payment_methods: true,
      block_lorem_ipsum: true,
      block_unapproved_tracking_claims: true,
    },
    qa_policy: {
      require_desktop_mobile_screenshots: true,
      require_checkout_flow: true,
      require_post_purchase_flow: true,
      fail_on_visible_placeholders: true,
      compare_live_runtime_data_to_spec: true,
    },
  };
}

test("YAML Build Brief loads and normalizes as a complete prepared artifact", () => {
  withBriefFixture(({ briefPath }) => {
    const loaded = loadCampaignBuildBriefFile(briefPath);
    assert.equal(loaded.format, "yaml");
    const result = createCampaignBuildBriefArtifact({ inputPath: briefPath });
    assert.equal(result.mode, "prepared");
    assert.equal(result.artifact.schema_version, BUILD_BRIEF_SCHEMA);
    assert.equal(result.artifact.status, "complete");
    assert.deepEqual(result.questions, []);
  });
});

test("validateCampaignBuildBriefArtifact blocks incomplete prepared briefs", () => {
  const brief = {
    schema_version: BUILD_BRIEF_SCHEMA,
    status: "needs_answers",
    _meta: { mode: "prepared" },
    questions: [
      {
        id: "brand_palette_cta",
        priority: 2,
        field: "brand",
        question: "Which palette and CTA style should commerce pages use?",
      },
    ],
    gates: [],
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  };
  const result = validateCampaignBuildBriefArtifact(brief);
  assert.ok(result.errors.some((issue) => issue.code === "build_brief.questions_unanswered"));
});

test("validateCampaignBuildBriefArtifact marks complete guided drafts ready", () => {
  const brief = {
    schema_version: BUILD_BRIEF_SCHEMA,
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: {
      payment_methods_allowed: ["card"],
      hidden_payment_methods: [],
    },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: {
      block_placeholders: true,
    },
  };

  const result = validateCampaignBuildBriefArtifact(brief);

  assert.deepEqual(result.errors, []);
  assert.ok(result.ready.some((message) => message.includes("Campaign Build Brief is complete")));
});

test("validateCampaignBuildBriefArtifact does not mark invalid briefs ready", () => {
  const result = validateCampaignBuildBriefArtifact({
    schema_version: "campaigns-os-build-brief/v0",
    status: "complete",
    _meta: { mode: "prepared" },
    questions: [],
    gates: [],
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  assert.ok(result.errors.some((issue) => issue.code === "build_brief.schema_version"));
  assert.deepEqual(result.ready, []);
});

test("prepared briefs with blocker gates stay needs_answers and block assembly", () => {
  withBriefFixture(({ dir }) => {
    const brief = completePreparedBrief();
    brief.media.sold_variants = [];
    brief.media.allow_other_variant_colors = false;
    const briefPath = resolve(dir, "variant-blocker.json");
    writeJson(briefPath, brief);

    const result = createCampaignBuildBriefArtifact({
      inputPath: briefPath,
      activePages: [{ id: "checkout", type: "checkout" }],
      pageMappings: [{ page_id: "checkout", path: "checkout.html" }],
    });

    assert.equal(result.artifact.status, "needs_answers");
    assert.deepEqual(result.questions, []);
    assert.ok(result.blockers.some((gate) => gate.code === "build_brief.variant_rule_incomplete"));
  });
});

test("policy nulls normalize back to safe defaults", () => {
  withBriefFixture(({ dir }) => {
    const brief = completePreparedBrief();
    brief.template_residue_policy.block_demo_payment_methods = null;
    brief.qa_policy.require_checkout_flow = null;
    const briefPath = resolve(dir, "null-policy.json");
    writeJson(briefPath, brief);

    const result = createCampaignBuildBriefArtifact({ inputPath: briefPath });

    assert.equal(result.artifact.template_residue_policy.block_demo_payment_methods, true);
    assert.equal(result.artifact.qa_policy.enforcement.status, "documented_expectation");
    assert.equal(result.artifact.qa_policy.enforcement.enforced_by, "qa.proof_policy and report.proof_policy");
    assert.match(result.artifact.qa_policy.enforcement.note, /Assembly Report report\.proof_policy contract/);
    assert.equal(result.artifact.qa_policy.require_checkout_flow, true);
  });
});

test("guided drafts split multi-color image signals into variant questions", () => {
  const result = createCampaignBuildBriefArtifact({
    sourceAssetCrawl: {
      references: [
        { asset_kind: "image", source_path: "assets/product-black-white-carousel.jpg" },
      ],
    },
  });

  assert.deepEqual(result.artifact.media.sold_variants, []);
  assert.equal(result.artifact.media.allow_other_variant_colors, null);
  assert.ok(result.questions.some((question) => question.id === "variant_media_rules"));
});

test("guided drafts infer order bumps from structured roles only", () => {
  const copyOnly = createCampaignBuildBriefArtifact({
    spec: {
      copy: {
        note: "prepurchase copy review happens before build handoff",
      },
    },
  });
  assert.equal(copyOnly.artifact.commerce_surfaces.order_bump.enabled, false);

  const disabledString = createCampaignBuildBriefArtifact({
    spec: {
      order_bump: "off",
    },
  });
  assert.equal(disabledString.artifact.commerce_surfaces.order_bump.enabled, false);

  const disabledObject = createCampaignBuildBriefArtifact({
    spec: {
      order_bump: {
        enabled: false,
        title: "Add one more",
      },
    },
  });
  assert.equal(disabledObject.artifact.commerce_surfaces.order_bump.enabled, false);

  const prepurchaseKey = createCampaignBuildBriefArtifact({
    spec: {
      prepurchase: true,
    },
  });
  assert.equal(prepurchaseKey.artifact.commerce_surfaces.order_bump.enabled, true);

  const structuredRole = createCampaignBuildBriefArtifact({
    spec: {
      packages: [
        { role: "order_bump", title: "Add one more" },
      ],
    },
  });
  assert.equal(structuredRole.artifact.commerce_surfaces.order_bump.enabled, true);

  const nestedStructuredRole = createCampaignBuildBriefArtifact({
    spec: {
      checkout: {
        order_bump: {
          copy: {
            role: "prepurchase",
          },
        },
      },
    },
  });
  assert.equal(nestedStructuredRole.artifact.commerce_surfaces.order_bump.enabled, true);
});

test("guided drafts ask promo_urgency_copy only about the template's own promo placeholders", () => {
  const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
  // The merchant's own commerce data and design-owned urgency slots: an offer
  // catalog with a bundle discount, and a landing design that carries its own
  // countdown and stock counter. None of it fills a template promo placeholder.
  spec.offers = [{ ref_id: 7, name: "Buy 2, save 20%", condition: { type: "count", value: 2 }, benefit: { type: "package_percentage", value: "20.00" } }];
  const pages = spec.funnels[0].pages;
  pages.find((page) => page.id === "landing").design_hooks = {
    component_slots: { urgency_timer: "Sale ends tonight", stock_counter: "Only 3 left" },
  };

  const ownCopy = createCampaignBuildBriefArtifact({ spec, activePages: pages });
  assert.equal(ownCopy.questions.some((question) => question.id === "promo_urgency_copy"), false);
  assert.equal(ownCopy.artifact.promo_urgency.header_claim_source, "none");
  assert.equal(ownCopy.artifact.promo_urgency.timer_label, "none");

  // exit_intent and promo_code_input are checkout surfaces: on a landing page
  // they fill no template placeholder, as hasExitPop and doctor already say.
  const landingOnly = structuredClone(spec);
  landingOnly.funnels[0].pages.find((page) => page.id === "landing").exit_intent = { enabled: true, offer_ref_id: 7 };
  landingOnly.funnels[0].pages.find((page) => page.id === "landing").promo_code_input = { enabled: true };
  const landing = createCampaignBuildBriefArtifact({ spec: landingOnly, activePages: landingOnly.funnels[0].pages });
  assert.equal(landing.questions.some((question) => question.id === "promo_urgency_copy"), false);

  // A promo-code roster or an exit-intent offer is what fills the template's
  // promo banner, timer and exit-pop, so the question is about those.
  for (const mapped of [
    (draft) => { draft.funnels[0].promo_codes = [{ id: "spring", code: "SPRING10" }]; },
    (draft) => { draft.funnels[0].pages.find((page) => page.id === "checkout").exit_intent = { enabled: true, offer_ref_id: 7 }; },
  ]) {
    const draft = structuredClone(spec);
    mapped(draft);
    const result = createCampaignBuildBriefArtifact({ spec: draft, activePages: draft.funnels[0].pages });
    const question = result.questions.find((entry) => entry.id === "promo_urgency_copy");
    assert.ok(question, "a CampaignSpec promo surface asks how the template's placeholders resolve");
    assert.match(question.question, /template's own promo placeholders/);
    assert.match(question.reason, /source design's own promo, proof and urgency copy is the merchant's content/);
    assert.deepEqual(question.options, ["fill from the campaign's promo codes and offers", "remove the template's promo placeholders"]);
  }
});

test("guided drafts preserve common wallet payment aliases", () => {
  const result = createCampaignBuildBriefArtifact({
    spec: {
      checkout: {
        express_wallets: {
          amazonPay: true,
          cashApp: true,
          sezzle: true,
          venmo: true,
        },
      },
    },
  });

  assert.deepEqual(result.artifact.commerce_surfaces.payment_methods_allowed, ["amazon_pay", "cash_app", "sezzle", "venmo"]);
});

test("prepare-build with --brief writes packet, context, report, and normalized brief references", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath, briefPath }) => {
    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--brief", briefPath,
      "--json",
    ]);

    assert.equal(result.packet.build_brief.mode, "prepared");
    assert.equal(result.packet.build_brief.status, "complete");
    assert.equal(result.context.build_brief.normalized_path, BUILD_BRIEF_NORMALIZED_REL_PATH);
    assert.equal(result.report.build_brief.status, "complete");
    assert.ok(existsSync(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH)));
  });
});

test("prepare-build without a brief writes a guided draft and high-impact questions", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath }) => {
    const result = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    assert.equal(result.packet.build_brief.mode, "guided_draft");
    assert.equal(result.context.build_brief.status, "needs_answers");
    assert.ok(result.context.build_brief.question_count > 0);
    assert.ok(result.context.prompts_required.some((prompt) => prompt.code.startsWith("BUILD_BRIEF_")));
    assert.ok(existsSync(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH)));
  });
});

test("the guided-questions warning says how to record answers, and following it closes the questions", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath }) => {
    const intake = ["--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus"];
    const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
    runCliJson(["prepare-build", ...intake, "--json"]);

    const before = runCliJson(["doctor", "--packet", packetPath, "--json"], { allowFailure: true });
    const warning = before.warnings.find((issue) => issue.code === "build_brief.guided_questions");
    assert.ok(warning, "the guided draft leaves questions open");
    // Each open question names the brief fields that close it, and the
    // message names the file, the command and the cost once evidence exists.
    assert.match(warning.message, /brand_palette_cta \(brand\.commerce_palette_source, brand\.cta_style\)/);
    assert.match(warning.message, /bundle_pricing_presentation \(offer_presentation\.bundle_cards\.primary_price\)/);
    assert.match(warning.message, new RegExp(`copy ${BUILD_BRIEF_NORMALIZED_REL_PATH.replaceAll(".", "\\.")} to campaign-build-brief\\.json in the target repo`));
    assert.match(warning.message, /run (?:\S+ )*record brief --packet <packet>/);
    assert.match(warning.message, /--brief <file>/);
    assert.match(warning.message, /Saving keeps every stage's recorded evidence unless the brief's content changes/);

    // Following the message: copy the draft, set the named fields, re-run.
    const brief = readJson(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH));
    brief.brand.cta_style = "solid dark button";
    brief.offer_presentation.bundle_cards.primary_price = "discounted_unit_price";
    brief.brief_mode = "prepared";
    writeJson(resolve(targetRepo, "campaign-build-brief.json"), brief);
    const rerun = runCliJson(["prepare-build", ...intake, "--json"]);
    assert.equal(rerun.packet.build_brief.mode, "prepared");
    assert.equal(rerun.packet.build_brief.status, "complete");

    const after = runCliJson(["doctor", "--packet", packetPath, "--json"], { allowFailure: true });
    assert.equal(after.warnings.some((issue) => issue.code === "build_brief.guided_questions"), false);
    assert.equal(after.errors.some((issue) => String(issue.code).startsWith("build_brief.")), false);
  });
});

test("doctor blocks an incomplete prepared Build Brief", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath, briefPath }) => {
    writeFileSync(briefPath, [
      "schema_version: campaigns-os-build-brief/v1",
      "brief_mode: prepared",
      "campaign_intent:",
      "  audience: busy households",
      "  conversion_goal: single-product funnel",
      "  tone: direct",
    ].join("\n"));

    const prepared = runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--brief", briefPath,
      "--json",
    ]);
    const preparedPromptCodes = prepared.context.prompts_required.map((prompt) => prompt.code);
    const preparedBlockerCodes = prepared.report.blockers
      .map((blocker) => blocker.code)
      .filter((code) => String(code || "").startsWith("BUILD_BRIEF_"));

    assert.equal(preparedPromptCodes.some((code) => String(code || "").startsWith("BUILD_BRIEF_")), false);
    assert.equal(new Set(preparedBlockerCodes).size, preparedBlockerCodes.length);

    const doctor = runCliJson([
      "doctor",
      "--packet", resolve(targetRepo, "campaign-runtime.build.json"),
      "--json",
    ], { allowFailure: true });

    assert.equal(doctor.ok, false);
    assert.ok(doctor.errors.some((issue) => issue.code === "build_brief.questions_unanswered"));
  });
});

// ---------------------------------------------------------------------------
// Brief answers persist: F2.1-W8 and F2.1-B2. Every command
// runs under the no-network guard (src/input-test-factories.mjs), which also
// reaches the child CLI processes; new exports are imported inside each test.

test("F2.1-W8: a new hand-written complete brief file with no brief_mode and no prior report reads mode guided_draft", async () => {
  const { withNetworkGuard } = await import("./input-test-factories.mjs");
  await withNetworkGuard(() => withBriefFixture(({ dir, sourceRoot, targetRepo, specPath }) => {
    // The :409-440 input: the guided draft with its two open questions
    // answered, written by hand to a brief file (no brief_mode, no _meta).
    const intake = runCliJson(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    assert.equal(intake.packet.build_brief.mode, "guided_draft", "setup: the draft comes from a guided intake");
    const brief = readJson(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH));
    brief.brand.cta_style = "solid dark button";
    brief.offer_presentation.bundle_cards.primary_price = "discounted_unit_price";
    delete brief._meta;
    delete brief.brief_mode;
    const handWritten = resolve(dir, "hand-written-brief.json");
    writeJson(handWritten, brief);
    const context = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
    const spec = readJson(specPath);

    // No previous report is passed: this is a new campaign.
    const result = createCampaignBuildBriefArtifact({
      inputPath: handWritten,
      inputSource: "operator_flag",
      spec,
      activePages: context.spec.active_pages,
      pageMappings: intake.packet.source_html.pages,
      templateFamily: "olympus",
      sourceAssetCrawl: context.source.asset_crawl,
      commerceZoneFindings: context.commerce_zone_findings,
    });
    assert.deepEqual(result.errors, [], "setup: the hand-written file normalizes without errors");
    assert.equal(result.artifact.status, "complete", "setup: the hand-written file answers every question");
    assert.equal(result.mode, "guided_draft");
  }));
});

test("F2.1-B2: a brief file with brief_mode \"maybe\" makes doctor report the error build_brief.brief_mode", async () => {
  const { withNetworkGuard } = await import("./input-test-factories.mjs");
  await withNetworkGuard(() => withBriefFixture(({ dir, sourceRoot, targetRepo, specPath }) => {
    const briefFile = resolve(dir, "campaign-build-brief.json");
    writeJson(briefFile, { ...completePreparedBrief(), brief_mode: "maybe" });
    const intake = runCliJson(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--brief", briefFile, "--no-run-session", "--json"]);
    assert.ok(intake.packet?.build_brief, "setup: intake read the brief file and wrote the packet");
    const doctor = runCliJson(["doctor", "--packet", resolve(targetRepo, "campaign-runtime.build.json"), "--no-live-refs", "--json"], { allowFailure: true });
    assert.ok(Array.isArray(doctor.errors), "setup: doctor printed its result");
    assert.equal(doctor.errors.some((issue) => issue.code === "build_brief.brief_mode"), true, `doctor errors: ${JSON.stringify(doctor.errors.map((issue) => issue.code))}`);
  }));
});

// A normalized brief that is not valid JSON is doctor's existing
// build_brief.normalized_path error, never a crashed doctor (or next).
test("doctor reports build_brief.normalized_path for a normalized brief that is not valid JSON", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath }) => {
    runCliJson(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
    writeFileSync(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH), "{\"schema_version\": ");
    const doctor = runCliJson(["doctor", "--packet", resolve(targetRepo, "campaign-runtime.build.json"), "--no-live-refs", "--json"], { allowFailure: true });
    const issue = doctor.errors.find((entry) => entry.code === "build_brief.normalized_path");
    assert.ok(issue, `doctor errors: ${JSON.stringify(doctor.errors.map((entry) => entry.code))}`);
    assert.match(issue.message, /not valid JSON/);
  });
});

// A normalized brief that parses to JSON other than an object is the same
// error: doctor reports it and next still prints its result.
for (const [label, content] of [["null", "null\n"], ["an array", "[]\n"], ["a number", "42\n"], ["a string", "\"brief\"\n"]]) {
  test(`doctor reports build_brief.normalized_path and next prints its result for a normalized brief that is ${label}`, () => {
    withBriefFixture(({ sourceRoot, targetRepo, specPath }) => {
      runCliJson(["prepare-build", "--spec", specPath, "--source", sourceRoot, "--target", targetRepo, "--template-family", "olympus", "--no-run-session", "--json"]);
      writeFileSync(resolve(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH), content);
      const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
      const doctor = runCliJson(["doctor", "--packet", packetPath, "--no-live-refs", "--json"], { allowFailure: true });
      const issue = doctor.errors.find((entry) => entry.code === "build_brief.normalized_path");
      assert.ok(issue, `doctor errors: ${JSON.stringify(doctor.errors.map((entry) => entry.code))}`);
      assert.match(issue.message, /not a valid brief object/);
      const next = runCliJson(["next", "--packet", packetPath, "--no-write", "--json"], { allowFailure: true });
      assert.equal(typeof next.stage, "string", `next printed its result: ${JSON.stringify(next).slice(0, 400)}`);
    });
  });
}

const sha256Of = (value) => `sha256:${createHash("sha256").update(JSON.stringify(canonicalSorted(value))).digest("hex")}`;
function canonicalSorted(value) {
  if (Array.isArray(value)) return value.map(canonicalSorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSorted(value[key])]));
  return value;
}

test("SUMMARY_FIELDS is the closed list of summary fields, in order", async () => {
  const { SUMMARY_FIELDS } = await import("./build-brief.mjs");
  assert.deepEqual(SUMMARY_FIELDS, [
    "campaign_intent.audience", "campaign_intent.conversion_goal", "campaign_intent.tone",
    "brand.commerce_palette_source", "brand.primary_accent", "brand.cta_style", "brand.avoid",
    "design_authority.<page>.source", "template_residue_policy.block_placeholders",
  ]);
});

// The generated draft, as intake makes it for the example spec.
function exampleDraft(extra = {}) {
  const spec = readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json"));
  const activePages = spec.funnels.flatMap((funnel) => funnel.pages);
  return createCampaignBuildBriefArtifact({ spec, activePages, pageMappings: activePages.map((page) => ({ page_id: page.id, path: `${page.id}.html` })), ...extra });
}

test("a generated draft stamps field_sources default, with value fingerprints, per non-null summary field and per concrete page", () => {
  const { artifact } = exampleDraft();
  const sources = artifact._meta.field_sources;
  const pages = Object.keys(artifact.design_authority);
  assert.ok(pages.length > 0, "setup: the draft names page authority");
  for (const page of pages) {
    assert.deepEqual(sources[`design_authority.${page}.source`], { kind: "default", value_fingerprint: sha256Of(artifact.design_authority[page].source) });
  }
  assert.equal(Object.hasOwn(sources, "design_authority.<page>.source"), false, "the placeholder is never a key");
  assert.equal(artifact.campaign_intent.audience, null, "setup: the draft leaves the audience unset");
  assert.equal(Object.hasOwn(sources, "campaign_intent.audience"), false, "a null value has no entry");
  assert.deepEqual(sources["campaign_intent.tone"], { kind: "default", value_fingerprint: sha256Of(artifact.campaign_intent.tone) });
  assert.deepEqual(sources["template_residue_policy.block_placeholders"], { kind: "default", value_fingerprint: sha256Of(true) });
});

test("a saved brief file stamps an answered or changed field stated, keeps an unchanged one, and a filled default default", () => {
  withBriefFixture(({ dir }) => {
    const draft = exampleDraft().artifact;
    const file = JSON.parse(JSON.stringify(draft));
    file.brand.cta_style = "solid accent pill";
    file.campaign_intent.audience = "busy households";
    delete file.template_residue_policy.block_placeholders;
    const path = resolve(dir, "campaign-build-brief.json");
    writeJson(path, file);
    const { artifact } = exampleDraft({ inputPath: path, inputSource: "operator_flag", previousNormalizedBrief: draft });
    const sources = artifact._meta.field_sources;
    assert.equal(sources["brand.cta_style"].kind, "stated", "an answer to an open question is stated");
    assert.equal(sources["campaign_intent.audience"].kind, "stated", "a value that differs from the previous brief is stated");
    assert.deepEqual(sources["campaign_intent.tone"], draft._meta.field_sources["campaign_intent.tone"], "an unchanged value keeps the previous entry");
    assert.equal(sources["template_residue_policy.block_placeholders"].kind, "default", "a value normalization filled is default");
    assert.equal(artifact._meta.mode_source, "generated", "a file without brief_mode and no prepared report is guided");
  });
});
