import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    writeFileSync(briefPath, readFileSync(resolve(ROOT, "examples/campaign-build-brief.single-variant-gadget.yaml"), "utf8"));
    return run({ dir, sourceRoot, targetRepo, specPath, briefPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function completePreparedBrief() {
  return {
    schema_version: BUILD_BRIEF_SCHEMA,
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

test("doctor blocks an incomplete prepared Build Brief", () => {
  withBriefFixture(({ sourceRoot, targetRepo, specPath, briefPath }) => {
    writeFileSync(briefPath, [
      "schema_version: campaigns-os-build-brief/v1",
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
