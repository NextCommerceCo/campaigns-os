#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "bin/campaigns-os.mjs");
const packet = resolve(root, "examples/build-packet.basic.json");
const catalogPath = resolve(root, "contracts/commerce-surface-catalog.json");

if (!existsSync(packet)) {
  throw new Error(`Missing fixture packet: ${packet}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${relative(root, path)} is not valid JSON: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function hasPath(obj, dotted) {
  const parts = dotted.split(".");
  let current = obj;

  for (const part of parts) {
    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      if (!Array.isArray(current?.[key])) return false;
      current = current[key][0];
      continue;
    }

    if (current == null || !(part in current)) return false;
    current = current[part];
  }

  return true;
}

function validateCatalogFixtures() {
  if (!existsSync(catalogPath)) {
    throw new Error(`Missing contract catalog: ${relative(root, catalogPath)}`);
  }

  const catalog = readJson(catalogPath);
  if (!catalog.sharedFrontmatterVocabulary || typeof catalog.sharedFrontmatterVocabulary !== "object") {
    throw new Error("contracts/commerce-surface-catalog.json is missing sharedFrontmatterVocabulary");
  }

  const families = Object.entries(catalog.families ?? {});
  if (families.length === 0) {
    throw new Error("contracts/commerce-surface-catalog.json has no families");
  }

  for (const [family, entry] of families) {
    const fixtures = entry.agentContract?.fixtures;
    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      throw new Error(`contracts catalog family ${family} has no agentContract.fixtures`);
    }

    for (const fixture of fixtures) {
      const fixturePath = resolve(root, fixture);
      const relativeFixture = relative(root, fixturePath);
      if (relativeFixture.startsWith("..")) {
        throw new Error(`contracts catalog family ${family} points outside repo: ${fixture}`);
      }
      if (!existsSync(fixturePath)) {
        throw new Error(`contracts catalog family ${family} references missing fixture: ${fixture}`);
      }

      const spec = readJson(fixturePath);
      for (const required of ["campaign.id", "campaign.name", "campaign.currency", "campaign.language", "funnels[]"]) {
        if (!hasPath(spec, required)) {
          throw new Error(`${relativeFixture} is missing ${required}`);
        }
      }

      for (const [funnelIndex, funnel] of (spec.funnels ?? []).entries()) {
        if (!Array.isArray(funnel.pages) || funnel.pages.length === 0) {
          throw new Error(`${relativeFixture} funnels[${funnelIndex}].pages must be a non-empty array`);
        }

        for (const [pageIndex, page] of funnel.pages.entries()) {
          for (const required of ["id", "type", "order", "label"]) {
            if (!(required in page)) {
              throw new Error(`${relativeFixture} funnels[${funnelIndex}].pages[${pageIndex}] missing ${required}`);
            }
          }

          if (page.sdk_hints?.template_family && page.sdk_hints.template_family !== family) {
            throw new Error(
              `${relativeFixture} page ${page.id} sdk_hints.template_family=${page.sdk_hints.template_family} does not match catalog family ${family}`,
            );
          }

          if (typeof page.page_url === "string" && /\.html(?:[?#].*)?$/i.test(page.page_url.trim())) {
            throw new Error(`${relativeFixture} page ${page.id} page_url must be a Page Kit public route, not a source filename: ${page.page_url}`);
          }
        }
      }
    }
  }
}

function envWithout(...keys) {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

function runCliJson(args, env = process.env) {
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

validateCatalogFixtures();

const omittedStageArraysTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-report-defaults-"));
try {
  const report = readJson(resolve(root, "examples/assembly-report.example.json"));
  for (const stage of Object.values(report.stages || {})) {
    delete stage.inputs;
    delete stage.outputs;
    delete stage.commands;
    delete stage.blockers;
    delete stage.warnings;
  }
  const omittedReportPath = resolve(omittedStageArraysTmp, "assembly-report.omitted-stage-arrays.json");
  writeJson(omittedReportPath, report);
  const validation = runCliJson(["validate-assembly-report", "--report", omittedReportPath, "--json"]);
  if (!validation.ok) {
    throw new Error("validate-assembly-report should accept omitted stage inputs/outputs/commands/blockers/warnings arrays.");
  }
} finally {
  rmSync(omittedStageArraysTmp, { recursive: true, force: true });
}

const doctor = runCliJson(["doctor", "--packet", packet, "--json"], envWithout("CAMPAIGNS_API_KEY"));
if (doctor.warnings?.some((issue) => issue.code === "campaign.api_key_source")) {
  throw new Error("Doctor should accept CampaignSpec campaign.campaigns_api_key without requiring CAMPAIGNS_API_KEY.");
}
if (!doctor.warnings?.some((issue) => issue.code === "routing_meta.runtime_root")) {
  throw new Error("Doctor should warn when CampaignSpec routing meta tags are not runtime-rooted under the campaign slug.");
}

const routingMetaTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-routing-meta-"));
try {
  const rootedSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const checkout = rootedSpec.funnels?.[0]?.pages?.find((page) => page.id === "checkout");
  const upsell = rootedSpec.funnels?.[0]?.pages?.find((page) => page.id === "upsell");
  checkout.sdk_hints.meta_tags["next-success-url"] = "/runtime-packet-demo/upsell/";
  upsell.sdk_hints.meta_tags["next-upsell-accept-url"] = "/runtime-packet-demo/receipt/";
  upsell.sdk_hints.meta_tags["next-upsell-decline-url"] = "/runtime-packet-demo/receipt/";
  const rootedSpecPath = resolve(routingMetaTmp, "campaignspec-rooted-meta.json");
  writeJson(rootedSpecPath, rootedSpec);

  const rootedPacket = readJson(packet);
  rootedPacket.spec.local_path = rootedSpecPath;
  rootedPacket.source_html.root = resolve(root, "examples/source-html");
  rootedPacket.assembly.target_repo = resolve(root, "examples/target-page-kit");
  rootedPacket.assembly.commerce_catalog.path = catalogPath;
  const rootedPacketPath = resolve(routingMetaTmp, "campaign-runtime.build.json");
  writeJson(rootedPacketPath, rootedPacket);

  const rootedDoctor = runCliJson(["doctor", "--packet", rootedPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (rootedDoctor.warnings?.some((issue) => issue.code === "routing_meta.runtime_root")) {
    throw new Error("Doctor should not warn when CampaignSpec routing meta tags are already runtime-rooted.");
  }
} finally {
  rmSync(routingMetaTmp, { recursive: true, force: true });
}

const skillsTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-skills-"));
try {
  const dryRun = runCliJson(["install-skills", "--target", skillsTmp, "--dry-run", "--json"]);
  if (!dryRun.skills?.length || !dryRun.skills.every((skill) => skill.action === "created")) {
    throw new Error("install-skills dry run should report every missing skill as created.");
  }
  if (existsSync(resolve(skillsTmp, "next-campaigns-os", "SKILL.md"))) {
    throw new Error("install-skills --dry-run should not write skill files.");
  }

  const installed = runCliJson(["install-skills", "--target", skillsTmp, "--json"]);
  if (!installed.skills?.length || !installed.skills.every((skill) => skill.action === "created")) {
    throw new Error("install-skills should create every missing skill on first install.");
  }
  if (!existsSync(resolve(skillsTmp, "next-campaigns-os", "SKILL.md"))) {
    throw new Error("install-skills should write SKILL.md files under the target skills directory.");
  }

  const unchanged = runCliJson(["install-skills", "--target", skillsTmp, "--dry-run", "--json"]);
  if (!unchanged.skills?.every((skill) => skill.action === "unchanged")) {
    throw new Error("install-skills should report unchanged skills when target files match source.");
  }

  writeFileSync(resolve(skillsTmp, "next-campaigns-build", "SKILL.md"), "stale skill\n");
  const stale = runCliJson(["install-skills", "--target", skillsTmp, "--dry-run", "--json"]);
  const buildSkill = stale.skills?.find((skill) => skill.name === "next-campaigns-build");
  if (buildSkill?.action !== "updated") {
    throw new Error("install-skills should report stale target skills as updated.");
  }
} finally {
  rmSync(skillsTmp, { recursive: true, force: true });
}

const marketCopyTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-market-copy-"));
try {
  const sourceRoot = resolve(marketCopyTmp, "source-html");
  const targetRepo = resolve(marketCopyTmp, "target-page-kit");
  const outputDir = resolve(targetRepo, "src/runtime-packet-demo");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));

  for (const page of ["checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }
  writeFileSync(resolve(sourceRoot, "landing.html"), "<html><body>Made in USA and ships from the USA.</body></html>");

  const marketSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  marketSpec.campaign.available_currencies = ["USD", "CAD"];
  marketSpec.campaign.available_shipping_countries = ["US", "CA"];
  const marketSpecPath = resolve(marketCopyTmp, "campaignspec.json");
  writeJson(marketSpecPath, marketSpec);

  const marketPacket = readJson(packet);
  marketPacket.spec.local_path = marketSpecPath;
  marketPacket.source_html.root = sourceRoot;
  marketPacket.assembly.target_repo = targetRepo;
  marketPacket.assembly.output_dir = "src/runtime-packet-demo";
  marketPacket.assembly.commerce_catalog.path = catalogPath;
  const marketPacketPath = resolve(marketCopyTmp, "campaign-runtime.build.json");
  writeJson(marketPacketPath, marketPacket);

  const marketDoctor = runCliJson(["doctor", "--packet", marketPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (!marketDoctor.warnings?.some((issue) => issue.code === "market_copy.us_specific_claims")) {
    throw new Error("Doctor should warn when multi-market specs contain US-specific source/template copy.");
  }

  const singleMarketSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  singleMarketSpec.campaign.currency = "CAD";
  singleMarketSpec.campaign.available_shipping_countries = ["US"];
  delete singleMarketSpec.campaign.available_currencies;
  const singleMarketSpecPath = resolve(marketCopyTmp, "single-market-campaignspec.json");
  writeJson(singleMarketSpecPath, singleMarketSpec);

  const singleMarketPacket = readJson(marketPacketPath);
  singleMarketPacket.spec.local_path = singleMarketSpecPath;
  const singleMarketPacketPath = resolve(marketCopyTmp, "single-market-campaign-runtime.build.json");
  writeJson(singleMarketPacketPath, singleMarketPacket);

  const singleMarketDoctor = runCliJson(["doctor", "--packet", singleMarketPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (singleMarketDoctor.warnings?.some((issue) => issue.code === "market_copy.us_specific_claims")) {
    throw new Error("Doctor should not warn solely because a single-market campaign uses a non-USD default currency.");
  }
} finally {
  rmSync(marketCopyTmp, { recursive: true, force: true });
}

execFileSync(process.execPath, [cli, "next", "build", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

execFileSync(process.execPath, [cli, "qa", "resolve", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

const resolvedQa = runCliJson(["qa", "resolve", "--packet", packet, "--base-url", "https://preview.example.com", "--json"], {
  ...process.env,
  CAMPAIGNS_API_KEY: "fixture-key",
});
const pages = resolvedQa.funnels?.[0]?.pages ?? [];
const checkout = pages.find((page) => page.page_id === "checkout");
const upsell = pages.find((page) => page.page_id === "upsell");
if (resolvedQa.base_url !== "https://preview.example.com/runtime-packet-demo/") {
  throw new Error(`QA base URL should resolve to campaign root, got ${resolvedQa.base_url}`);
}
if (checkout?.url !== "https://preview.example.com/runtime-packet-demo/checkout/") {
  throw new Error(`QA checkout URL should include campaign slug, got ${checkout?.url}`);
}
if (checkout?.expected_meta_tags?.["next-success-url"] !== "/runtime-packet-demo/upsell/") {
  throw new Error(`QA should expect runtime-rooted next-success-url, got ${checkout?.expected_meta_tags?.["next-success-url"]}`);
}
if (upsell?.expected_meta_tags?.["next-upsell-accept-url"] !== "/runtime-packet-demo/receipt/") {
  throw new Error(`QA should expect runtime-rooted next-upsell-accept-url, got ${upsell?.expected_meta_tags?.["next-upsell-accept-url"]}`);
}

console.log("Fixture checks passed");
