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
  "--test-order <off|checkout|accept|decline|both|full|accept-decline[-accept...]>",
  "--max-test-orders <n>",
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
  if (!existsSync(resolve(skillsTmp, "next-campaigns-os", "references", "session-intake.md"))) {
    throw new Error("install-skills should write bundled skill reference files.");
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

  const codexDryRun = runCliJson(["install-skills", "--platform", "codex", "--dry-run", "--json"]);
  if (codexDryRun.platform !== "codex" || !String(codexDryRun.target_directory || "").endsWith(".codex/skills")) {
    throw new Error("install-skills --platform codex should target ~/.codex/skills.");
  }

  const allDryRun = runCliJson(["install-skills", "--platform", "all", "--dry-run", "--json"]);
  const platforms = new Set((allDryRun.targets || []).map((target) => target.platform));
  for (const platform of ["claude", "codex", "agents"]) {
    if (!platforms.has(platform)) {
      throw new Error(`install-skills --platform all should include ${platform}.`);
    }
  }
  if (!allDryRun.skills?.every((skill) => skill.platform)) {
    throw new Error("install-skills --platform all should annotate each skill with its target platform.");
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
