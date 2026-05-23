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

function assertRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} should be a non-empty string`);
  }
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) {
    throw new Error(`${label} should be relative, got ${value}`);
  }
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

function runCliJsonAllowFailure(args, env = process.env) {
  try {
    return runCliJson(args, env);
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function runCliText(args, env = process.env) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    encoding: "utf8",
  });
}

validateCatalogFixtures();

const qaRunHelp = runCliText(["qa", "run", "--help"]);
for (const expected of [
  "campaigns-os qa — Node/npm spec-aware QA",
  "--test-order <off|checkout|accept|decline|both>",
  "--allow-test-orders",
  "--sandbox-test-card-confirmed",
]) {
  if (!qaRunHelp.includes(expected)) {
    throw new Error(`qa run --help should include ${expected}`);
  }
}

const relativePathsTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-relative-paths-"));
try {
  const specDir = resolve(relativePathsTmp, "specs");
  const sourceRoot = resolve(relativePathsTmp, "source-html");
  const targetRepo = resolve(relativePathsTmp, "target-page-kit");
  mkdirSync(specDir, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }

  const specPath = resolve(specDir, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
  const generatedPacket = readJson(packetPath);
  assertRelativePath(generatedPacket.spec.local_path, "packet.spec.local_path");
  assertRelativePath(generatedPacket.source_html.root, "packet.source_html.root");
  assertRelativePath(generatedPacket.assembly.target_repo, "packet.assembly.target_repo");
  assertRelativePath(generatedPacket.assembly.commerce_catalog.path, "packet.assembly.commerce_catalog.path");

  const generatedContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  assertRelativePath(generatedContext.spec.path, "context.spec.path");
  assertRelativePath(generatedContext.source.root, "context.source.root");

  const generatedReport = readJson(resolve(targetRepo, ".campaign-runtime/assembly-report.json"));
  assertRelativePath(generatedReport.inputs.spec_path, "report.inputs.spec_path");
  assertRelativePath(generatedReport.inputs.source.root, "report.inputs.source.root");

  const generatedDoctorOutput = readJson(resolve(targetRepo, ".campaign-runtime/doctor-output.json"));
  assertRelativePath(generatedDoctorOutput.derived.packet_path, "doctor.derived.packet_path");
  assertRelativePath(generatedDoctorOutput.derived.source_root, "doctor.derived.source_root");
  assertRelativePath(generatedDoctorOutput.derived.target_repo, "doctor.derived.target_repo");
  assertRelativePath(generatedDoctorOutput.derived.target_output_dir, "doctor.derived.target_output_dir");
  assertRelativePath(generatedDoctorOutput.derived.spec_path, "doctor.derived.spec_path");
  if (generatedDoctorOutput.next?.command?.includes(relativePathsTmp)) {
    throw new Error("doctor.next.command should not leak the temp workspace absolute path.");
  }

  const generatedDoctor = runCliJson(["doctor", "--packet", packetPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (!generatedDoctor.ok) {
    throw new Error("Doctor should accept generated relative packet paths.");
  }

  const strippedDoctor = runCliJson(["doctor", "--packet", packetPath, "--strip-paths", "--json"], envWithout("CAMPAIGNS_API_KEY"));
  assertRelativePath(strippedDoctor.derived.packet_path, "doctor --strip-paths derived.packet_path");
  assertRelativePath(strippedDoctor.derived.source_root, "doctor --strip-paths derived.source_root");
} finally {
  rmSync(relativePathsTmp, { recursive: true, force: true });
}

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

const qaPolicyTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-qa-policy-"));
try {
  const policyPacketPath = resolve(qaPolicyTmp, "campaign-runtime.build.json");
  writeJson(policyPacketPath, readJson(packet));
  const policy = runCliJson([
    "qa", "policy", "set",
    "--packet", policyPacketPath,
    "--test-orders-allowed", "true",
    "--sandbox-test-card-confirmed", "true",
    "--allowed-domains-confirmed", "true",
    "--preview-url", "https://deploy-preview.example.com/runtime-packet-demo/",
    "--production-url", "https://preview.example.com/runtime-packet-demo/",
    "--deploy-target", "netlify",
    "--json",
  ]);
  if (!policy.ok || policy.action !== "qa-policy-set") {
    throw new Error("qa policy set should return an ok qa-policy-set result.");
  }
  if (!policy.changed?.length) {
    throw new Error("qa policy set should report changed fields.");
  }
  const updated = readJson(policyPacketPath);
  if (updated.qa?.test_orders_allowed !== true || updated.qa?.sandbox_test_card_confirmed !== true) {
    throw new Error("qa policy set should persist QA test-order flags.");
  }
  if (updated.campaign?.allowed_domains_confirmed !== true) {
    throw new Error("qa policy set should persist campaign allowed-domain confirmation.");
  }
  if (updated.deploy?.preview_url !== "https://deploy-preview.example.com/runtime-packet-demo/") {
    throw new Error("qa policy set should persist deploy preview URL updates.");
  }
  if (updated.deploy?.production_url !== "https://preview.example.com/runtime-packet-demo/" || updated.deploy?.target !== "netlify") {
    throw new Error("qa policy set should persist deploy updates.");
  }
} finally {
  rmSync(qaPolicyTmp, { recursive: true, force: true });
}

const doctor = runCliJson(["doctor", "--packet", packet, "--json"], envWithout("CAMPAIGNS_API_KEY"));
if (doctor.warnings?.some((issue) => issue.code === "campaign.api_key_source")) {
  throw new Error("Doctor should accept CampaignSpec campaign.campaigns_api_key without requiring CAMPAIGNS_API_KEY.");
}
if (!doctor.warnings?.some((issue) => issue.code === "routing_meta.runtime_root")) {
  throw new Error("Doctor should warn when CampaignSpec routing meta tags are not runtime-rooted under the campaign slug.");
}

const sdkMismatchTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-sdk-mismatch-"));
try {
  const targetRepo = resolve(sdkMismatchTmp, "target-page-kit");
  mkdirSync(resolve(targetRepo, "_data"), { recursive: true });
  mkdirSync(resolve(targetRepo, "src", "runtime-packet-demo"), { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  writeJson(resolve(targetRepo, "_data", "campaigns.json"), {
    "runtime-packet-demo": { sdk_version: "0.4.17" },
  });

  const mismatchPacket = readJson(packet);
  mismatchPacket.spec.local_path = resolve(root, "examples/campaignspec.v42.basic.json");
  mismatchPacket.source_html.root = resolve(root, "examples/source-html");
  mismatchPacket.assembly.target_repo = targetRepo;
  mismatchPacket.assembly.commerce_catalog.path = catalogPath;
  const mismatchPacketPath = resolve(sdkMismatchTmp, "campaign-runtime.build.json");
  writeJson(mismatchPacketPath, mismatchPacket);

  const mismatchDoctor = runCliJson(["doctor", "--packet", mismatchPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (!mismatchDoctor.warnings?.some((issue) => issue.code === "page_kit.sdk_version")) {
    throw new Error("Doctor should warn when target campaigns.json sdk_version differs from CampaignSpec.");
  }
} finally {
  rmSync(sdkMismatchTmp, { recursive: true, force: true });
}

const missingSpecPacket = readJson(packet);
delete missingSpecPacket.spec.local_path;
const missingSpecTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-missing-spec-"));
try {
  const missingSpecPacketPath = resolve(missingSpecTmp, "campaign-runtime.build.json");
  writeJson(missingSpecPacketPath, missingSpecPacket);
  const missingSpecDoctor = runCliJsonAllowFailure(["doctor", "--packet", missingSpecPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (!missingSpecDoctor.errors?.some((issue) => issue.code === "spec.local_path")) {
    throw new Error("Doctor should block assembly when local CampaignSpec JSON is missing.");
  }
} finally {
  rmSync(missingSpecTmp, { recursive: true, force: true });
}

const builtOutputTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-built-output-"));
try {
  const sourceRoot = resolve(builtOutputTmp, "source-html");
  const targetRepo = resolve(builtOutputTmp, "target-page-kit");
  const specPath = resolve(builtOutputTmp, "campaignspec.json");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(resolve(targetRepo, "src", "runtime-packet-demo"), { recursive: true });
  mkdirSync(resolve(targetRepo, "_site", "runtime-packet-demo", "landing"), { recursive: true });
  mkdirSync(resolve(targetRepo, "_site", "runtime-packet-demo", "checkout"), { recursive: true });
  mkdirSync(resolve(targetRepo, "_site", "runtime-packet-demo", "upsell"), { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }

  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const upsell = spec.funnels[0].pages.find((page) => page.id === "upsell");
  upsell.packages[0].product_purchase_availability = "unavailable";
  upsell.packages.push({ ref_id: "PKG_A", name: "String-ref upsell", product_purchase_availability: "available" });
  spec.shipping_methods.push({ ref_id: "SHIP_A", name: "String-ref shipping" });
  writeJson(specPath, spec);

  writeFileSync(
    resolve(targetRepo, "_site", "runtime-packet-demo", "landing", "index.html"),
    [
      "<html><head>",
      "<title>Landing</title>",
      "</head><body>",
      '<a data-next-package-id="PKG_METALESS" href="/runtime-packet-demo/checkout/">Buy</a>',
      "<script>window.next = {};</script>",
      "</body></html>",
    ].join("")
  );
  writeFileSync(
    resolve(targetRepo, "_site", "runtime-packet-demo", "checkout", "index.html"),
    [
      "<html><head>",
      '<meta name="next-page-type" content="checkout">',
      '<meta name="next-success-url" content="/runtime-packet-demo/upsell/">',
      '<script src="/runtime-packet-demo/js/config.js"></script>',
      "</head><body>",
      '<div data-next-bundle-card data-next-shipping-id="2" data-next-bundle-items=\'[{"packageId":999,"quantity":1}]\'></div>',
      '<div data-next-package-id="PKG_B" data-next-shipping-id="SHIP_B"></div>',
      "<script>window.next = {};</script>",
      "</body></html>",
    ].join("")
  );
  writeFileSync(
    resolve(targetRepo, "_site", "runtime-packet-demo", "upsell", "index.html"),
    [
      "<html><head>",
      '<meta name="next-page-type" content="upsell">',
      '<meta name="next-upsell-accept-url" content="/runtime-packet-demo/receipt/">',
      '<meta name="next-upsell-decline-url" content="/runtime-packet-demo/receipt/">',
      "</head><body><script>window.next = {};</script></body></html>",
    ].join("")
  );

  const outputPacket = readJson(packet);
  outputPacket.spec.local_path = specPath;
  outputPacket.source_html.root = sourceRoot;
  outputPacket.assembly.target_repo = targetRepo;
  outputPacket.assembly.commerce_catalog.path = catalogPath;
  const outputPacketPath = resolve(builtOutputTmp, "campaign-runtime.build.json");
  writeJson(outputPacketPath, outputPacket);

  const outputDoctor = runCliJson(["doctor", "--packet", outputPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  for (const code of ["built_output.script_missing", "built_output.package_ref", "built_output.shipping_ref", "spec.package_unavailable"]) {
    if (!outputDoctor.warnings?.some((issue) => issue.code === code)) {
      throw new Error(`Doctor should warn for ${code}.`);
    }
  }
  const packageRefMessages = outputDoctor.warnings
    .filter((issue) => issue.code === "built_output.package_ref")
    .map((issue) => issue.message)
    .join("\n");
  if (!packageRefMessages.includes("PKG_METALESS") || !packageRefMessages.includes("PKG_B")) {
    throw new Error("Doctor should validate rendered string package refs against CampaignSpec, including pages without sdk_hints.meta_tags.");
  }
  const shippingRefWarning = outputDoctor.warnings.find((issue) => issue.code === "built_output.shipping_ref");
  if (!shippingRefWarning?.message?.includes("SHIP_B")) {
    throw new Error("Doctor should validate rendered string shipping refs against CampaignSpec.");
  }
} finally {
  rmSync(builtOutputTmp, { recursive: true, force: true });
}

const partialScopeTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-partial-scope-"));
try {
  const partialPacket = readJson(packet);
  partialPacket.source_html.root = resolve(root, "examples/source-html");
  partialPacket.spec.local_path = resolve(root, "examples/campaignspec.v42.basic.json");
  partialPacket.assembly.target_repo = resolve(root, "examples/target-page-kit");
  partialPacket.assembly.commerce_catalog.path = catalogPath;
  partialPacket.source_html.pages = [
    { page_id: "landing", path: "landing.html" },
    { page_id: "checkout", skip_reason: "Existing downstream checkout remains unchanged for this partial build." },
    { page_id: "upsell", skip_reason: "Existing downstream upsell remains unchanged for this partial build." },
    { page_id: "receipt", skip_reason: "Existing downstream receipt remains unchanged for this partial build." },
  ];
  const partialPacketPath = resolve(partialScopeTmp, "campaign-runtime.partial-build.json");
  writeJson(partialPacketPath, partialPacket);

  const partialDoctor = runCliJson(["doctor", "--packet", partialPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (partialDoctor.derived?.scope?.mode !== "partial") {
    throw new Error("Doctor should classify packets with explicit skip reasons as partial scope.");
  }
  if (!partialDoctor.derived.scope.previewable_routes?.some((page) => page.page_id === "landing")) {
    throw new Error("Doctor should list mapped pages as previewable routes for partial builds.");
  }
  if (!partialDoctor.derived.scope.blocked_runtime_pages?.some((page) => page.page_id === "checkout")) {
    throw new Error("Doctor should mark skipped checkout/runtime pages as blocked for launch QA.");
  }
  if (!partialDoctor.warnings?.some((issue) => issue.code === "scope.partial_build")) {
    throw new Error("Doctor should emit a partial build scope warning.");
  }
  if (!partialDoctor.next?.blocked_stages?.includes("checkout-launch-ready")) {
    throw new Error("Doctor next step should block checkout launch readiness for partial runtime scope.");
  }
} finally {
  rmSync(partialScopeTmp, { recursive: true, force: true });
}

const unusedShippingTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-unused-shipping-"));
try {
  const sourceRoot = resolve(unusedShippingTmp, "source-html");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(resolve(sourceRoot, "landing.html"), "---\npage_type: product\n---\n<section>Landing</section>\n");
  writeFileSync(
    resolve(sourceRoot, "checkout.html"),
    [
      "---",
      "page_type: checkout",
      "shipping_methods:",
      "  standard: 2",
      "  free: 1",
      "---",
      "<section>Checkout</section>",
    ].join("\n")
  );
  writeFileSync(resolve(sourceRoot, "upsell.html"), "---\npage_type: upsell\n---\n<section>Upsell</section>\n");
  writeFileSync(resolve(sourceRoot, "receipt.html"), "---\npage_type: receipt\n---\n<section>Receipt</section>\n");

  const shopPacket = readJson(packet);
  shopPacket.source_html.root = sourceRoot;
  shopPacket.spec.local_path = resolve(root, "examples/campaignspec.v42.basic.json");
  shopPacket.assembly.target_repo = resolve(root, "examples/target-page-kit");
  shopPacket.assembly.template_family = "shop-single-step";
  shopPacket.assembly.commerce_catalog.path = catalogPath;
  shopPacket.assembly.template_lock = {
    locked: true,
    locked_by: "fixture",
    confidence: "high",
    evidence: ["contracts/fixtures/campaign-specs/shop-single-step-upsell-receipt.json"],
  };
  const shopPacketPath = resolve(unusedShippingTmp, "campaign-runtime.shop-single-step.json");
  writeJson(shopPacketPath, shopPacket);

  const shopDoctor = runCliJson(["doctor", "--packet", shopPacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  const warning = shopDoctor.warnings?.find((issue) => issue.code === "template_contract.shipping_unused");
  if (!warning?.message?.includes("shop-single-step") || !warning.message.includes("checkout.html")) {
    throw new Error("Doctor should warn when a non-shipping template family carries copied shipping frontmatter.");
  }
} finally {
  rmSync(unusedShippingTmp, { recursive: true, force: true });
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
  writeFileSync(
    resolve(sourceRoot, "landing.html"),
    '<html><body>Made in USA and ships from the USA. Save $59.99 today. Call 1-800-555-1234. <span data-next-display="bundle.main.price">$49.99</span><span data-skip-market-lint="true">$999.99 1-800-555-0000 ships from the USA</span></body></html>',
  );

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
  const currencyWarning = marketDoctor.warnings?.find((issue) => issue.code === "copy.hardcoded_currency_symbol");
  if (!currencyWarning?.message.includes('source:landing.html:1 "$59.99"')) {
    throw new Error("Doctor should warn with file and line for hardcoded currency symbols outside SDK-bound copy.");
  }
  if (currencyWarning.message.includes("$999.99") || currencyWarning.message.includes("$49.99")) {
    throw new Error("Doctor should skip hardcoded currency symbols inside SDK-bound or data-skip-market-lint regions.");
  }
  const phoneWarning = marketDoctor.warnings?.find((issue) => issue.code === "copy.hardcoded_phone");
  if (!phoneWarning?.message.includes('source:landing.html:1 "1-800-555-1234"')) {
    throw new Error("Doctor should warn with file and line for hardcoded phone numbers that differ from campaign.store_phone.");
  }
  if (phoneWarning.message.includes("1-800-555-0000")) {
    throw new Error("Doctor should skip hardcoded phone numbers inside data-skip-market-lint regions.");
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

const manifestTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-source-html-manifest-"));
try {
  const sourceRoot = resolve(manifestTmp, "source-html");
  const targetRepo = resolve(manifestTmp, "target-page-kit");
  mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  // Source files use non-standard filenames so filesystem matching could NOT
  // produce these mappings — the only way to map them is via the manifest.
  for (const file of ["landing-section-a.html", "checkout-step.html", "upsell-step.html", "receipt-step.html"]) {
    writeFileSync(resolve(sourceRoot, file), `<html><body>${file}</body></html>`);
  }
  writeJson(resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json"), {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-05-23T00:00:00.000Z",
    generator: "figma-sections-export@1.0.0",
    campaign_slug: "runtime-packet-demo",
    root: ".",
    pages: [
      { page_id: "landing", path: "landing-section-a.html", page_type: "landing" },
      { page_id: "checkout", path: "checkout-step.html", page_type: "checkout" },
      { page_id: "upsell", path: "upsell-step.html", page_type: "upsell" },
      { page_id: "receipt", path: "receipt-step.html", page_type: "thankyou" },
    ],
  });

  const specPath = resolve(manifestTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
  const generatedPacket = readJson(packetPath);
  const expectedPaths = {
    landing: "landing-section-a.html",
    checkout: "checkout-step.html",
    upsell: "upsell-step.html",
    receipt: "receipt-step.html",
  };
  for (const [pageId, expected] of Object.entries(expectedPaths)) {
    const mapping = generatedPacket.source_html.pages.find((page) => page.page_id === pageId);
    if (!mapping || mapping.path !== expected) {
      throw new Error(`source-html manifest fixture: expected ${pageId} -> ${expected}, got ${JSON.stringify(mapping)}`);
    }
    if (mapping.page_type !== ({ landing: "landing", checkout: "checkout", upsell: "upsell", receipt: "thankyou" })[pageId]) {
      throw new Error(`source-html manifest fixture: expected ${pageId} page_type carried through, got ${mapping.page_type}`);
    }
  }

  const generatedContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  if (generatedContext.source?.manifest?.schema_version !== "source-html-manifest/v0") {
    throw new Error("Build context should record the manifest schema_version when present.");
  }
  if (generatedContext.source.manifest.page_count !== 4) {
    throw new Error(`Build context should record manifest page_count=4, got ${generatedContext.source.manifest.page_count}`);
  }
  const manifestDecisions = (generatedContext.decisions || []).filter((decision) =>
    decision.decision_type === "deterministic_derivation" && decision.evidence?.some((line) => line.includes("source-html manifest entry"))
  );
  if (manifestDecisions.length !== 4) {
    throw new Error(`Expected 4 manifest-sourced page-map decisions, got ${manifestDecisions.length}`);
  }
} finally {
  rmSync(manifestTmp, { recursive: true, force: true });
}

// Source-html manifest with a duplicate page_id. The first entry wins (deterministic);
// each subsequent occurrence must surface as a MANIFEST_DUPLICATE_PAGE prompt
// rather than silently dropping. Also exercises the manifest-specific skip_reason
// when a spec page has no manifest entry — its text must reference the manifest,
// not the generic filesystem fallback message.
const manifestDuplicateTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-manifest-duplicate-"));
try {
  const sourceRoot = resolve(manifestDuplicateTmp, "source-html");
  const targetRepo = resolve(manifestDuplicateTmp, "target-page-kit");
  mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const file of ["landing-real.html", "landing-shadow.html", "checkout.html", "upsell.html", "receipt.html"]) {
    writeFileSync(resolve(sourceRoot, file), `<html><body>${file}</body></html>`);
  }
  // landing appears twice; the `upsell` spec page is intentionally absent from
  // the manifest so MISSING_SOURCE_PAGE fires with the manifest-specific message.
  writeJson(resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json"), {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-05-23T00:00:00.000Z",
    generator: "figma-sections-export@1.0.0",
    campaign_slug: "runtime-packet-demo",
    root: ".",
    pages: [
      { page_id: "landing",  path: "landing-real.html",   page_type: "landing" },
      { page_id: "landing",  path: "landing-shadow.html", page_type: "landing" },
      { page_id: "checkout", path: "checkout.html",       page_type: "checkout" },
      { page_id: "receipt",  path: "receipt.html",        page_type: "thankyou" },
    ],
  });

  const specPath = resolve(manifestDuplicateTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  const prepResult = runCliJsonAllowFailure([
    "prepare-build",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // Assert duplicate prompt fired. Prompts live on the build context as
  // prompts_required (not at the prepare-build --json root).
  const prompts = prepResult.context?.prompts_required || [];
  const duplicatePrompt = prompts.find((p) => p.code === "MANIFEST_DUPLICATE_PAGE");
  if (!duplicatePrompt) {
    throw new Error(`manifest-duplicate fixture: expected MANIFEST_DUPLICATE_PAGE prompt, got: ${JSON.stringify(prompts.map((p) => p.code))}`);
  }
  if (!duplicatePrompt.message.includes("landing-real.html") || !duplicatePrompt.message.includes("landing-shadow.html")) {
    throw new Error(`manifest-duplicate fixture: duplicate prompt should name both first and duplicate paths, got: ${duplicatePrompt.message}`);
  }

  // First entry wins — the packet should map landing to landing-real.html, not the shadow.
  const generatedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  const landingMapping = generatedPacket.source_html.pages.find((p) => p.page_id === "landing");
  if (!landingMapping || landingMapping.path !== "landing-real.html") {
    throw new Error(`manifest-duplicate fixture: expected landing -> landing-real.html (first entry wins), got ${JSON.stringify(landingMapping)}`);
  }

  // The upsell spec page is absent from the manifest. Its skip_reason should
  // reference the manifest by path so operators know we consulted it — not
  // the legacy filesystem-fallback message.
  const upsellMapping = generatedPacket.source_html.pages.find((p) => p.page_id === "upsell");
  if (!upsellMapping || !upsellMapping.skip_reason) {
    throw new Error(`manifest-duplicate fixture: expected upsell to carry skip_reason, got ${JSON.stringify(upsellMapping)}`);
  }
  if (!upsellMapping.skip_reason.includes("source-html manifest")) {
    throw new Error(`manifest-duplicate fixture: upsell skip_reason should name the manifest (so operators know it was consulted), got: ${upsellMapping.skip_reason}`);
  }
} finally {
  rmSync(manifestDuplicateTmp, { recursive: true, force: true });
}

const designSourceTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-design-source-"));
try {
  // No manifest, no source file for `landing` — but spec carries design_source.
  // Doctor should emit the design_source-aware coverage error.
  const sourceRoot = resolve(designSourceTmp, "source-html");
  const targetRepo = resolve(designSourceTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(resolve(targetRepo, "src", "runtime-packet-demo"), { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  // Intentionally omit landing.html so the coverage check fires.
  for (const page of ["checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }

  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const landing = spec.funnels[0].pages.find((page) => page.id === "landing");
  landing.design_source = {
    type: "figma",
    file_url: "https://www.figma.com/design/abc123/Test?node-id=143-10518",
    breakpoints: {
      desktop: "https://www.figma.com/design/abc123/Test?node-id=143-10518",
    },
  };
  const specPath = resolve(designSourceTmp, "campaignspec.json");
  writeJson(specPath, spec);

  const designSourcePacket = readJson(packet);
  designSourcePacket.spec.local_path = specPath;
  designSourcePacket.source_html.root = sourceRoot;
  designSourcePacket.assembly.target_repo = targetRepo;
  designSourcePacket.assembly.commerce_catalog.path = catalogPath;
  // Drop landing from packet pages to force the coverage error.
  designSourcePacket.source_html.pages = designSourcePacket.source_html.pages.filter((page) => page.page_id !== "landing");
  const designSourcePacketPath = resolve(designSourceTmp, "campaign-runtime.build.json");
  writeJson(designSourcePacketPath, designSourcePacket);

  const designSourceDoctor = runCliJsonAllowFailure(["doctor", "--packet", designSourcePacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  const coverageError = designSourceDoctor.errors?.find((issue) => issue.code === "source_html.pages.coverage");
  if (!coverageError) {
    throw new Error("Doctor should emit source_html.pages.coverage when an active page is unmapped.");
  }
  if (!coverageError.message.includes("Design is in Figma")) {
    throw new Error(`Doctor coverage error should reference design_source when present, got: ${coverageError.message}`);
  }
  if (!coverageError.message.includes("https://www.figma.com/design/abc123/Test")) {
    throw new Error(`Doctor coverage error should include the Figma file_url, got: ${coverageError.message}`);
  }
  if (!coverageError.detail || coverageError.detail.design_source?.type !== "figma") {
    throw new Error("Doctor coverage error should carry a detail payload describing design_source.");
  }

  // Second variant: design_source set but no file_url -> different message.
  landing.design_source = { type: "figma", file_url: "" };
  writeJson(specPath, spec);
  const noFileUrlDoctor = runCliJsonAllowFailure(["doctor", "--packet", designSourcePacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  const noFileUrlError = noFileUrlDoctor.errors?.find((issue) => issue.code === "source_html.pages.coverage");
  if (!noFileUrlError?.message.includes("file_url is missing")) {
    throw new Error(`Doctor should call out missing design_source.file_url, got: ${noFileUrlError?.message}`);
  }

  // Third variant: no design_source -> generic message preserved.
  delete landing.design_source;
  writeJson(specPath, spec);
  const genericDoctor = runCliJsonAllowFailure(["doctor", "--packet", designSourcePacketPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  const genericError = genericDoctor.errors?.find((issue) => issue.code === "source_html.pages.coverage");
  if (!genericError || genericError.message.includes("Figma") || genericError.message.includes("design_source")) {
    throw new Error(`Doctor should keep the generic coverage error when design_source is absent, got: ${genericError?.message}`);
  }
} finally {
  rmSync(designSourceTmp, { recursive: true, force: true });
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
