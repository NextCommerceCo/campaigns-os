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

    runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--brief", briefPath,
      "--json",
    ]);

    const doctor = runCliJson([
      "doctor",
      "--packet", resolve(targetRepo, "campaign-runtime.build.json"),
      "--json",
    ], { allowFailure: true });

    assert.equal(doctor.ok, false);
    assert.ok(doctor.errors.some((issue) => issue.code === "build_brief.questions_unanswered"));
  });
});
