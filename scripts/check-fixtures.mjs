#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/**
 * Async variant of runCliJson. Use this when the fixture spins up an
 * in-process HTTP server (e.g. mock proxy for --map-id) — execFileSync
 * blocks the parent event loop, so the spawned child can't connect back
 * to the server. execFile with a Promise wrapper keeps both event loops
 * live during the call.
 */
async function runCliJsonAsync(args, env = process.env) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolveFn, rejectFn) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Mirror runCliJsonAllowFailure's policy: if stdout has parseable
        // JSON, return it even when the CLI exited non-zero (doctor sets
        // process.exitCode=2 when validation fails but still emits a
        // complete result). Only reject when stdout is missing or
        // unparseable AND the process errored.
        if (typeof stdout === "string" && stdout.trim()) {
          try {
            resolveFn(JSON.parse(stdout));
            return;
          } catch {
            // fall through to error branch
          }
        }
        if (error) {
          const wrapped = new Error(`CLI ${args[0]} failed: ${error.message}`);
          wrapped.code = error.code;
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          rejectFn(wrapped);
          return;
        }
        rejectFn(new Error(`CLI ${args[0]} returned non-JSON stdout: ${stdout}`));
      },
    );
  });
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
  "--test-order <off|common|checkout|accept|decline|both|full|accept-decline[-accept...]>",
  "--max-test-orders <n>",
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
  mkdirSync(resolve(skillsTmp, "next-campaigns-build", "references"), { recursive: true });
  writeFileSync(resolve(skillsTmp, "next-campaigns-build", "references", "stale.md"), "stale bundled reference\n");
  const stale = runCliJson(["install-skills", "--target", skillsTmp, "--dry-run", "--json"]);
  const buildSkill = stale.skills?.find((skill) => skill.name === "next-campaigns-build");
  if (buildSkill?.action !== "updated") {
    throw new Error("install-skills should report stale target skills as updated.");
  }
  runCliJson(["install-skills", "--target", skillsTmp, "--json"]);
  if (existsSync(resolve(skillsTmp, "next-campaigns-build", "references", "stale.md"))) {
    throw new Error("install-skills should remove stale bundled reference files when updating a skill.");
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

  const toolingStatusTmp = resolve(skillsTmp, "tooling-status-target");
  const staleToolingStatus = runCliJsonAllowFailure(["tooling", "status", "--target", toolingStatusTmp, "--json"]);
  if (staleToolingStatus.ok !== false || staleToolingStatus.status !== "attention_required") {
    throw new Error("tooling status should require attention when installed skills are stale or missing.");
  }
  if (staleToolingStatus.skills?.stale_count !== dryRun.skills.length) {
    throw new Error("tooling status should surface the stale/missing skill count.");
  }
  if (!staleToolingStatus.actions?.some((action) => action.includes("install-skills"))) {
    throw new Error("tooling status should provide an exact install-skills remediation.");
  }

  runCliJson(["install-skills", "--target", toolingStatusTmp, "--json"]);
  const readyToolingStatus = runCliJson(["tooling", "status", "--target", toolingStatusTmp, "--json"]);
  if (readyToolingStatus.ok !== true || readyToolingStatus.status !== "ready") {
    throw new Error("tooling status should be ready when target skills match bundled skills.");
  }
  if (readyToolingStatus.package?.name !== "@nextcommerce/campaigns-os") {
    throw new Error("tooling status should include the local package identity.");
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
  // Slice 4e: also declare variant_labels on the upsell page so this fixture
  // proves the per-page hint flows through applyManifestToPages (the manifest
  // path), not only matchSourcePages (the filesystem fallback exercised by
  // the assembly-hints fixture). Without this assertion the manifest-path
  // emission lives untested.
  const manifestSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const manifestUpsellPage = manifestSpec.funnels?.[0]?.pages?.find((p) => p.type === "upsell");
  if (!manifestUpsellPage) throw new Error("manifest fixture: example spec has no upsell page; adjust fixture spec.");
  manifestUpsellPage.variant_labels = { primary: "Size", secondary: "Color" };
  writeJson(specPath, manifestSpec);
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
  const expectedPageKitTypes = {
    landing: "product",
    checkout: "checkout",
    upsell: "upsell",
    receipt: "receipt",
  };
  for (const [pageId, expected] of Object.entries(expectedPaths)) {
    const mapping = generatedPacket.source_html.pages.find((page) => page.page_id === pageId);
    if (!mapping || mapping.path !== expected) {
      throw new Error(`source-html manifest fixture: expected ${pageId} -> ${expected}, got ${JSON.stringify(mapping)}`);
    }
    if (mapping.page_type !== ({ landing: "landing", checkout: "checkout", upsell: "upsell", receipt: "thankyou" })[pageId]) {
      throw new Error(`source-html manifest fixture: expected ${pageId} page_type carried through, got ${mapping.page_type}`);
    }
    if (mapping.page_kit?.target_path !== `${pageId}.html`) {
      throw new Error(`source-html manifest fixture: expected ${pageId} page_kit.target_path=${pageId}.html, got ${JSON.stringify(mapping.page_kit)}`);
    }
    if (mapping.page_kit?.page_type !== expectedPageKitTypes[pageId]) {
      throw new Error(`source-html manifest fixture: expected ${pageId} CPK page_type=${expectedPageKitTypes[pageId]}, got ${JSON.stringify(mapping.page_kit)}`);
    }
  }

  // Slice 4e: variant_labels round-trips through the manifest path with both
  // fields preserved on the upsell mapping; non-upsell mappings stay clean.
  const manifestUpsellMapping = generatedPacket.source_html.pages.find((page) => page.page_id === "upsell");
  if (!manifestUpsellMapping?.variant_labels || manifestUpsellMapping.variant_labels.primary !== "Size" || manifestUpsellMapping.variant_labels.secondary !== "Color") {
    throw new Error(`source-html manifest fixture: expected upsell mapping to carry variant_labels={primary:"Size",secondary:"Color"} via applyManifestToPages, got ${JSON.stringify(manifestUpsellMapping)}`);
  }
  for (const otherPageId of ["landing", "checkout", "receipt"]) {
    const otherMapping = generatedPacket.source_html.pages.find((page) => page.page_id === otherPageId);
    if (otherMapping && "variant_labels" in otherMapping) {
      throw new Error(`source-html manifest fixture: non-upsell mapping ${otherPageId} should not carry variant_labels, got ${JSON.stringify(otherMapping)}`);
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

// Slice 5e: mixed-source entry point. One campaign, four pages, each
// nominally produced by a different upstream (figma export, AI agent,
// template-stock copy, hand-authored). Each producer writes into its
// own subdirectory under the source root; a single manifest at the
// source-root level unifies them.
//
// Asserts:
//   - manifest paths can reference subdirectories (not just flat files)
//   - packet.source_html.pages[].path round-trips the subdirectory path
//   - per-page page_type carries through regardless of which subtree
//     the file lives in
//   - decisions[] cites the manifest as the deterministic source for
//     every page, even though physical files live in different trees
//
// This is the realistic shape for "AI-generated landing + template-stock
// checkout/upsell" campaigns. See docs/entry-points.md "Mixed".
const mixedSourceTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-mixed-source-"));
try {
  const sourceRoot = resolve(mixedSourceTmp, "source-html");
  const targetRepo = resolve(mixedSourceTmp, "target-page-kit");
  mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));

  // Four producer subtrees, each writing one page into its own area.
  // Filenames intentionally vary so filesystem matching could not
  // produce these mappings even if it ran.
  const producers = [
    { dir: "figma-export",    file: "landing-page.html",     pageId: "landing",  pageType: "landing" },
    { dir: "ai-generated",    file: "presell-article.html",  pageId: "checkout", pageType: "checkout" },
    { dir: "template-stock",  file: "upsell.html",           pageId: "upsell",   pageType: "upsell" },
    { dir: "hand-authored",   file: "thanks.html",           pageId: "receipt",  pageType: "thankyou" },
  ];
  for (const producer of producers) {
    mkdirSync(resolve(sourceRoot, producer.dir), { recursive: true });
    writeFileSync(
      resolve(sourceRoot, producer.dir, producer.file),
      `<html><body>${producer.dir}/${producer.file}</body></html>`,
    );
  }

  writeJson(resolve(sourceRoot, ".campaigns-os", "source-html-manifest.json"), {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-05-26T00:00:00.000Z",
    generator: "mixed-source-orchestrator@1.0.0",
    campaign_slug: "runtime-packet-demo",
    root: ".",
    pages: producers.map((p) => ({
      page_id: p.pageId,
      path: `${p.dir}/${p.file}`,
      page_type: p.pageType,
    })),
  });

  const specPath = resolve(mixedSourceTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  const generatedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  const expectedTargets = {
    landing: "landing.html",
    checkout: "checkout.html",
    upsell: "upsell.html",
    receipt: "receipt.html",
  };
  for (const producer of producers) {
    const mapping = generatedPacket.source_html.pages.find((p) => p.page_id === producer.pageId);
    if (!mapping) {
      throw new Error(`mixed-source fixture: expected mapping for "${producer.pageId}", got none.`);
    }
    const expectedPath = `${producer.dir}/${producer.file}`;
    if (mapping.path !== expectedPath) {
      throw new Error(`mixed-source fixture: expected ${producer.pageId} -> ${expectedPath}, got ${mapping.path}`);
    }
    if (mapping.page_type !== producer.pageType) {
      throw new Error(`mixed-source fixture: expected ${producer.pageId} page_type=${producer.pageType}, got ${mapping.page_type}`);
    }
    if (mapping.page_kit?.target_path !== expectedTargets[producer.pageId]) {
      throw new Error(`mixed-source fixture: expected ${producer.pageId} Page Kit target ${expectedTargets[producer.pageId]}, got ${JSON.stringify(mapping.page_kit)}`);
    }
    if (mapping.page_kit?.output_path.includes(producer.dir)) {
      throw new Error(`mixed-source fixture: Page Kit output_path should not include producer dir "${producer.dir}", got ${mapping.page_kit.output_path}`);
    }
  }

  const generatedContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  const manifestDecisions = (generatedContext.decisions || []).filter((decision) =>
    decision.decision_type === "deterministic_derivation" && decision.evidence?.some((line) => line.includes("source-html manifest entry"))
  );
  if (manifestDecisions.length !== producers.length) {
    throw new Error(`mixed-source fixture: expected ${producers.length} manifest-sourced decisions (one per producer), got ${manifestDecisions.length}`);
  }
} finally {
  rmSync(mixedSourceTmp, { recursive: true, force: true });
}

// Slice 5a: template-stock entry point. No design_source on the spec,
// no manifest, no figma involvement. Just spec + a source directory
// of HTML files matching standard page-type names. This is Sam's
// nanosocks scaffold pass — clone a starter template, fill the spec,
// ship. See docs/entry-points.md "Template-stock".
//
// The relativePathsTmp fixture earlier in this file already exercises
// the filesystem-matching code path. This block adds a focused
// assertion that names it as the canonical template-stock shape:
// no manifest file should be created, no design_source-aware error
// branch should fire, every active spec page should map via filename
// slug.
const templateStockTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-template-stock-"));
try {
  const sourceRoot = resolve(templateStockTmp, "source-html");
  const targetRepo = resolve(templateStockTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }

  // Spec is the example v4.2 basic — no design_source on any page.
  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const hasAnyDesignSource = (spec.funnels || []).some((funnel) =>
    (funnel.pages || []).some((page) => page.design_source != null),
  );
  if (hasAnyDesignSource) {
    throw new Error("template-stock fixture sanity: example spec carries design_source on some page; pick a different fixture spec.");
  }

  const specPath = resolve(templateStockTmp, "campaignspec.json");
  writeJson(specPath, spec);
  const result = runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // No manifest written to the source root.
  if (existsSync(resolve(sourceRoot, ".campaigns-os/source-html-manifest.json"))) {
    throw new Error("template-stock fixture: no manifest should be written to the source root.");
  }

  // Build context should NOT record a manifest entry.
  const generatedContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  if (generatedContext.source?.manifest) {
    throw new Error(`template-stock fixture: build context should not record a manifest, got ${JSON.stringify(generatedContext.source.manifest)}`);
  }

  // Every active page mapped via filesystem slug — the page filenames
  // should round-trip.
  const generatedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  for (const expected of ["landing.html", "checkout.html", "upsell.html", "receipt.html"]) {
    const mapping = generatedPacket.source_html.pages.find((p) => p.path === expected);
    if (!mapping) {
      throw new Error(`template-stock fixture: expected ${expected} mapping via filesystem slug, got pages=${JSON.stringify(generatedPacket.source_html.pages)}`);
    }
  }

  // Doctor's coverage error variant should NOT include Figma hint text
  // (template-stock path has no design_source set, so no design_source
  // hint applies). This double-checks the design_source-aware branch
  // doesn't accidentally fire on the template-stock path.
  if (result.doctor) {
    const coverageErrors = (result.doctor.errors || []).filter((issue) => issue.code === "source_html.pages.coverage");
    for (const error of coverageErrors) {
      if (error.message.includes("Figma") || error.message.includes("design_source")) {
        throw new Error(`template-stock fixture: coverage error should not mention Figma/design_source on template-stock path, got: ${error.message}`);
      }
    }
  }
} finally {
  rmSync(templateStockTmp, { recursive: true, force: true });
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

// Slice 3: `--map-id` resolves the spec from the proxy Worker.
// Spin a tiny in-process HTTP server that mimics the Map Builder backend's
// /api/spec/<map-id> endpoint, then run `start --map-id` against it.
// Asserts:
//   - fetched spec lands in <target>/.campaign-runtime/fetched-specs/<id>.json
//   - the packet's spec.local_path points at that cache file
//   - --cached-spec re-reads the cache without hitting the network
//   - 404s and ok:false responses surface as clean CLI errors
const { createServer } = await import("node:http");

const mapIdTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-map-id-"));
try {
  const sourceRoot = resolve(mapIdTmp, "source-html");
  const targetRepo = resolve(mapIdTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }
  const exampleSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));

  let fetchCount = 0;
  const server = createServer((req, res) => {
    fetchCount += 1;
    // /api/spec/<id> success path
    if (req.method === "GET" && req.url === "/api/spec/fixture-map-id") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: exampleSpec }));
      return;
    }
    // /api/spec/<id> logical-failure path (200 with ok:false)
    if (req.method === "GET" && req.url === "/api/spec/fixture-not-found") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "spec not found in KV" }));
      return;
    }
    // /api/spec/<id> HTTP-failure path
    if (req.method === "GET" && req.url === "/api/spec/fixture-server-error") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "upstream KV unavailable" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  await new Promise((resolveFn) => server.listen(0, "127.0.0.1", resolveFn));
  const { port } = server.address();
  const proxyBase = `http://127.0.0.1:${port}`;

  try {
    // 1. Happy path: --map-id fetches, caches, and runs start.
    const startResult = await runCliJsonAsync([
      "start",
      "--map-id", "fixture-map-id",
      "--proxy-base", proxyBase,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);
    if (startResult.spec_source?.source !== "remote") {
      throw new Error(`map-id fixture: expected spec_source.source="remote", got ${JSON.stringify(startResult.spec_source)}`);
    }
    if (startResult.spec_source?.mapId !== "fixture-map-id") {
      throw new Error(`map-id fixture: spec_source should record mapId, got ${JSON.stringify(startResult.spec_source)}`);
    }
    const cachePath = resolve(targetRepo, ".campaign-runtime/fetched-specs/fixture-map-id.json");
    if (!existsSync(cachePath)) {
      throw new Error(`map-id fixture: expected cached spec at ${cachePath}`);
    }
    const cachedSpec = readJson(cachePath);
    if (cachedSpec.schema_version !== exampleSpec.schema_version) {
      throw new Error(`map-id fixture: cached spec should round-trip schema_version, got ${cachedSpec.schema_version}`);
    }
    const generatedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
    if (!generatedPacket.spec?.local_path?.includes("fetched-specs/fixture-map-id.json")) {
      throw new Error(`map-id fixture: packet spec.local_path should point at the cached spec, got ${generatedPacket.spec?.local_path}`);
    }
    // Verify the network was actually hit on the first run. Without this,
    // a regression that silently returned a cached spec on a fresh invocation
    // (or a no-op resolveSpecPath) would pass the "spec_source.source=remote"
    // assertion above purely by mislabelling.
    if (fetchCount < 1) {
      throw new Error(`map-id fixture: happy path should have hit the proxy at least once, but server received ${fetchCount} request(s)`);
    }

    // 2. --cached-spec re-reads the cache without a network call.
    fetchCount = 0;
    const cachedResult = await runCliJsonAsync([
      "prepare-build",
      "--map-id", "fixture-map-id",
      "--proxy-base", proxyBase,
      "--cached-spec",
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);
    if (cachedResult.spec_source?.source !== "cache") {
      throw new Error(`map-id fixture: --cached-spec should produce spec_source.source="cache", got ${JSON.stringify(cachedResult.spec_source)}`);
    }
    if (fetchCount !== 0) {
      throw new Error(`map-id fixture: --cached-spec should NOT hit the network, but server received ${fetchCount} request(s)`);
    }
    // The cached-spec packet must still wire spec.local_path at the cache
    // file — the same contract as the remote-fetch path. A future change
    // that resolves the cache differently (e.g. embeds the JSON inline,
    // points at a transient temp file) would silently break downstream
    // stages that read packet.spec.local_path; lock the path here.
    const cachedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
    if (!cachedPacket.spec?.local_path?.includes("fetched-specs/fixture-map-id.json")) {
      throw new Error(`map-id fixture: --cached-spec packet spec.local_path should point at the cache file, got ${cachedPacket.spec?.local_path}`);
    }

    // 3. ok:false response surfaces as a clean CLI error.
    let okFalseError = null;
    try {
      await runCliJsonAsync([
        "prepare-build",
        "--map-id", "fixture-not-found",
        "--proxy-base", proxyBase,
        "--source", sourceRoot,
        "--target", targetRepo,
        "--template-family", "olympus",
        "--json",
      ]);
    } catch (error) {
      okFalseError = String(error.stderr || error.message || "");
    }
    if (!okFalseError || !okFalseError.includes("spec not found in KV")) {
      throw new Error(`map-id fixture: expected ok:false error to surface "spec not found in KV", got: ${okFalseError}`);
    }

    // 4. HTTP 5xx response surfaces as a clean CLI error.
    let httpError = null;
    try {
      await runCliJsonAsync([
        "prepare-build",
        "--map-id", "fixture-server-error",
        "--proxy-base", proxyBase,
        "--source", sourceRoot,
        "--target", targetRepo,
        "--template-family", "olympus",
        "--json",
      ]);
    } catch (error) {
      httpError = String(error.stderr || error.message || "");
    }
    if (!httpError || !httpError.includes("503")) {
      throw new Error(`map-id fixture: expected HTTP 5xx error to include status code, got: ${httpError}`);
    }
  } finally {
    await new Promise((resolveFn) => server.close(resolveFn));
  }
} finally {
  rmSync(mapIdTmp, { recursive: true, force: true });
}

// Slice 4a Phase 2: authoring-time hints flow through prepare-build.
//
// Two halves to exercise:
//   1. campaign.preferred_template_family — packet.assembly.template_family
//      adopts the hint when no --template-family CLI override is given;
//      lock stays unlocked (only operator CLI locks the family); decision
//      log + template_decision_notes cite the hint source.
//   2. Page.upsell_template_pattern — flows from the spec page onto
//      packet.source_html.pages[].upsell_template_pattern so the build
//      stage can read the per-page UI variant without re-parsing the spec.
//
// Also asserts CLI override wins on the campaign-level field.
const assemblyHintsTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-assembly-hints-"));
try {
  const sourceRoot = resolve(assemblyHintsTmp, "source-html");
  const targetRepo = resolve(assemblyHintsTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }

  // Build a spec carrying both hints. Pick the campaign-level family that's
  // distinct from the test's CLI overrides below so the assertions can tell
  // them apart.
  const hintedSpec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  hintedSpec.campaign = hintedSpec.campaign || {};
  hintedSpec.campaign.preferred_template_family = "olympus-mv-single-step";
  const upsellSpecPage = hintedSpec.funnels?.[0]?.pages?.find((p) => p.type === "upsell");
  if (!upsellSpecPage) throw new Error("assembly-hints fixture: example spec has no upsell page; adjust fixture spec.");
  upsellSpecPage.upsell_template_pattern = "mv";
  // Slice 4b: declare a tier range on the upsell page. The packet should
  // surface this on the matching source_html.pages mapping the same way
  // upsell_template_pattern flows through.
  upsellSpecPage.upsell_mv_tiers = { min: 2, max: 4 };
  // Slice 4e: declare variant column labels on the upsell page. Same flow.
  upsellSpecPage.variant_labels = { primary: "Size", secondary: "Color" };

  const specPath = resolve(assemblyHintsTmp, "campaignspec.json");
  writeJson(specPath, hintedSpec);

  // 1. No --template-family override. Packet should adopt the hint and
  //    record the hint source in candidates + decision notes.
  runCliJsonAllowFailure([
    "prepare-build",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--json",
  ]);
  const hintAdoptedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  if (hintAdoptedPacket.assembly?.template_family !== "olympus-mv-single-step") {
    throw new Error(`assembly-hints fixture: expected packet.assembly.template_family to adopt the hint, got ${hintAdoptedPacket.assembly?.template_family}`);
  }
  if (hintAdoptedPacket.assembly?.template_lock?.locked !== false) {
    throw new Error(`assembly-hints fixture: hint should NOT lock the family (only operator CLI locks), got template_lock=${JSON.stringify(hintAdoptedPacket.assembly?.template_lock)}`);
  }
  if (!hintAdoptedPacket.assembly?.template_decision_notes?.includes("hints olympus-mv-single-step")) {
    throw new Error(`assembly-hints fixture: template_decision_notes should mention the hint source, got: ${hintAdoptedPacket.assembly?.template_decision_notes}`);
  }
  const upsellMapping = hintAdoptedPacket.source_html.pages.find((p) => p.page_id === upsellSpecPage.id);
  if (!upsellMapping) {
    throw new Error(`assembly-hints fixture: expected upsell mapping in packet, got ${JSON.stringify(hintAdoptedPacket.source_html.pages)}`);
  }
  if (upsellMapping.upsell_template_pattern !== "mv") {
    throw new Error(`assembly-hints fixture: expected upsell mapping to carry upsell_template_pattern="mv", got ${JSON.stringify(upsellMapping)}`);
  }
  // Slice 4b: tier range round-trips into the same mapping.
  if (!upsellMapping.upsell_mv_tiers || upsellMapping.upsell_mv_tiers.min !== 2 || upsellMapping.upsell_mv_tiers.max !== 4) {
    throw new Error(`assembly-hints fixture: expected upsell mapping to carry upsell_mv_tiers={min:2,max:4}, got ${JSON.stringify(upsellMapping)}`);
  }
  // Slice 4e: variant labels round-trip into the same mapping with both fields preserved.
  if (!upsellMapping.variant_labels || upsellMapping.variant_labels.primary !== "Size" || upsellMapping.variant_labels.secondary !== "Color") {
    throw new Error(`assembly-hints fixture: expected upsell mapping to carry variant_labels={primary:"Size",secondary:"Color"}, got ${JSON.stringify(upsellMapping)}`);
  }
  // Non-upsell mappings should NOT carry the pattern field — it was only set
  // on the upsell spec page, so other mappings stay clean.
  const landingMapping = hintAdoptedPacket.source_html.pages.find((p) => p.page_id !== upsellSpecPage.id);
  if (landingMapping && "upsell_template_pattern" in landingMapping) {
    throw new Error(`assembly-hints fixture: non-upsell mappings should not carry upsell_template_pattern, got ${JSON.stringify(landingMapping)}`);
  }
  if (landingMapping && "upsell_mv_tiers" in landingMapping) {
    throw new Error(`assembly-hints fixture: non-upsell mappings should not carry upsell_mv_tiers, got ${JSON.stringify(landingMapping)}`);
  }
  if (landingMapping && "variant_labels" in landingMapping) {
    throw new Error(`assembly-hints fixture: non-upsell mappings should not carry variant_labels, got ${JSON.stringify(landingMapping)}`);
  }
  const hintContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  const hintCandidate = (hintContext.template?.candidates || []).find((c) => c.source?.includes("preferred_template_family"));
  if (!hintCandidate || hintCandidate.family !== "olympus-mv-single-step") {
    throw new Error(`assembly-hints fixture: build context should record the hint as a candidate, got ${JSON.stringify(hintContext.template?.candidates)}`);
  }

  // 2. CLI override wins on conflict. Spec hint = olympus-mv-single-step,
  //    CLI override = olympus-mv-two-step → packet locks two-step.
  runCliJsonAllowFailure([
    "prepare-build",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus-mv-two-step",
    "--json",
  ]);
  const overridePacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  if (overridePacket.assembly?.template_family !== "olympus-mv-two-step") {
    throw new Error(`assembly-hints fixture: CLI override should win over the hint, got ${overridePacket.assembly?.template_family}`);
  }
  if (overridePacket.assembly?.template_lock?.locked !== true) {
    throw new Error(`assembly-hints fixture: CLI override should lock the family, got ${JSON.stringify(overridePacket.assembly?.template_lock)}`);
  }
  // The hint should still appear in the candidate list (provenance preserved)
  // even though the override won — operators auditing later should see what
  // the spec was hinting at.
  const overrideContext = readJson(resolve(targetRepo, ".campaign-runtime/build-context.json"));
  const stillHintedCandidate = (overrideContext.template?.candidates || []).find((c) => c.source?.includes("preferred_template_family"));
  if (!stillHintedCandidate || stillHintedCandidate.family !== "olympus-mv-single-step") {
    throw new Error(`assembly-hints fixture: hint provenance should survive CLI override, got ${JSON.stringify(overrideContext.template?.candidates)}`);
  }

  // 3. Slice 4b: partial / malformed upsell_mv_tiers shapes should NOT flow
  //    into the packet. Upstream spec validation warns the author; the
  //    consumer side drops the field rather than passing half-state
  //    downstream.
  for (const malformed of [{ min: 5, max: 2 }, { min: 1 }, { min: "1", max: 3 }, "junk", null]) {
    upsellSpecPage.upsell_mv_tiers = malformed;
    writeJson(specPath, hintedSpec);
    runCliJsonAllowFailure([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus-mv-two-step",
      "--json",
    ]);
    const malformedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
    const malformedMapping = malformedPacket.source_html.pages.find((p) => p.page_id === upsellSpecPage.id);
    if (!malformedMapping) {
      throw new Error(`assembly-hints fixture: expected upsell mapping in packet for malformed tier input ${JSON.stringify(malformed)}, got ${JSON.stringify(malformedPacket.source_html.pages)}`);
    }
    if ("upsell_mv_tiers" in malformedMapping) {
      throw new Error(`assembly-hints fixture: malformed tier input ${JSON.stringify(malformed)} should have been dropped, got ${JSON.stringify(malformedMapping)}`);
    }
  }

  // 4. Slice 4e: partial / malformed variant_labels shapes should NOT flow
  //    into the packet. Same posture as the tier-range guard above.
  upsellSpecPage.upsell_mv_tiers = { min: 2, max: 4 };  // reset to a good value
  for (const malformed of [{ primary: "" }, { secondary: "Color" }, { primary: 42, secondary: "Color" }, ["Size", "Color"], "junk", null]) {
    upsellSpecPage.variant_labels = malformed;
    writeJson(specPath, hintedSpec);
    runCliJsonAllowFailure([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus-mv-two-step",
      "--json",
    ]);
    const malformedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
    const malformedMapping = malformedPacket.source_html.pages.find((p) => p.page_id === upsellSpecPage.id);
    if (!malformedMapping) {
      throw new Error(`assembly-hints fixture: expected upsell mapping in packet for malformed variant_labels input ${JSON.stringify(malformed)}, got ${JSON.stringify(malformedPacket.source_html.pages)}`);
    }
    if ("variant_labels" in malformedMapping) {
      throw new Error(`assembly-hints fixture: malformed variant_labels input ${JSON.stringify(malformed)} should have been dropped, got ${JSON.stringify(malformedMapping)}`);
    }
  }

  // 5. Slice 4e: primary-only variant_labels (single-attribute case)
  //    should pass through with the secondary field omitted.
  upsellSpecPage.variant_labels = { primary: "Flavor" };
  writeJson(specPath, hintedSpec);
  runCliJsonAllowFailure([
    "prepare-build",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus-mv-two-step",
    "--json",
  ]);
  const primaryOnlyPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  const primaryOnlyMapping = primaryOnlyPacket.source_html.pages.find((p) => p.page_id === upsellSpecPage.id);
  if (!primaryOnlyMapping?.variant_labels || primaryOnlyMapping.variant_labels.primary !== "Flavor") {
    throw new Error(`assembly-hints fixture: primary-only variant_labels should pass through, got ${JSON.stringify(primaryOnlyMapping)}`);
  }
  if ("secondary" in primaryOnlyMapping.variant_labels) {
    throw new Error(`assembly-hints fixture: primary-only variant_labels should not emit a secondary key, got ${JSON.stringify(primaryOnlyMapping)}`);
  }
} finally {
  rmSync(assemblyHintsTmp, { recursive: true, force: true });
}

// Slice 3 Phase 2: `campaigns-os next` (no stage arg) self-decides the next
// stage from the current report + doctor state. The orchestration loop:
//
//   agent calls `next` → gets stage + prompt → does the work → updates
//   report.stages.<name>.status → calls `next` again → repeat until "done"
//
// Each call re-reads state from disk, so the loop is idempotent and
// recoverable across sessions / machines. This fixture walks the loop
// stage by stage and confirms the picker advances in lockstep with the
// report's recorded state.
const nextOrchestrationTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-next-orchestration-"));
try {
  const sourceRoot = resolve(nextOrchestrationTmp, "source-html");
  const targetRepo = resolve(nextOrchestrationTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page}</body></html>`);
  }
  const specPath = resolve(nextOrchestrationTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  runCliJsonAllowFailure([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
  const reportPath = resolve(targetRepo, ".campaign-runtime/assembly-report.json");

  function nextNoStage() {
    return runCliJsonAllowFailure(["next", "--packet", packetPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  }

  function markStageStatus(reportKey, status, extras = {}) {
    const report = readJson(reportPath);
    report.stages[reportKey] = { ...report.stages[reportKey], status, ...extras };
    writeJson(reportPath, report);
  }

  function setDeployUrl(url) {
    const packet = readJson(packetPath);
    packet.deploy = packet.deploy || {};
    packet.deploy.preview_url = url;
    writeJson(packetPath, packet);
  }

  // A blocked prepare-build record must stop the loop before setup/build,
  // even when the live doctor result is otherwise OK. This protects the
  // assembly report as the durable handoff source of truth.
  markStageStatus("prepare_build", "blocked", {
    blockers: [{ code: "TEST_PREPARE_BLOCK", message: "fixture-induced prepare-build block" }],
  });
  let step = nextNoStage();
  if (step.stage !== "prepare-build" || step.ok !== false) {
    throw new Error(`next-orchestration fixture: blocked prepare_build should stop the picker, got ${JSON.stringify(step)}`);
  }
  if (step.stage_blocked !== true) {
    throw new Error(`next-orchestration fixture: blocked prepare_build should set stage_blocked=true, got ${JSON.stringify(step)}`);
  }
  if (!step.errors?.some((issue) => issue.code === "TEST_PREPARE_BLOCK")) {
    throw new Error(`next-orchestration fixture: prepare_build blockers should surface as next errors, got ${JSON.stringify(step.errors)}`);
  }
  step = runCliJsonAllowFailure(["next", "build", "--packet", packetPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (step.ok !== false || !step.errors?.some((issue) => issue.code === "TEST_PREPARE_BLOCK")) {
    throw new Error(`next-orchestration fixture: explicit next build should respect blocked prepare_build, got ${JSON.stringify(step)}`);
  }
  markStageStatus("prepare_build", "completed", { blockers: [] });

  // After `start` on a target with only package.json (no campaign output
  // dir yet), report stages are: prepare_build=completed, setup=pending
  // (scaffold required), assembly=pending, etc. First `next` should pick
  // setup. This is the realistic agentic shape — start from a fresh target
  // repo, scaffold first, then build.
  step = nextNoStage();
  if (step.stage !== "setup") {
    throw new Error(`next-orchestration fixture: expected first picked stage to be "setup" (scaffold required), got ${step.stage}. picked_reason=${step.picked_reason}`);
  }
  if (!step.picked_reason || !step.picked_reason.includes("setup")) {
    throw new Error(`next-orchestration fixture: picked_reason should reference setup, got: ${step.picked_reason}`);
  }

  // Mark setup completed → picker should advance to build (assembly).
  markStageStatus("setup", "completed");
  step = nextNoStage();
  if (step.stage !== "build") {
    throw new Error(`next-orchestration fixture: after setup completed, expected "build" (assembly), got ${step.stage}. picked_reason=${step.picked_reason}`);
  }
  if (!step.picked_reason || !step.picked_reason.includes("assembly")) {
    throw new Error(`next-orchestration fixture: build picked_reason should reference the assembly report key, got: ${step.picked_reason}`);
  }
  if (!step.prompt || !step.prompt.includes("next-campaigns-build")) {
    throw new Error(`next-orchestration fixture: build prompt should mention next-campaigns-build skill, got: ${step.prompt?.slice(0, 100)}`);
  }

  // Mark assembly completed → picker should advance to polish.
  markStageStatus("assembly", "completed", { build_fingerprint: "sha256:fixture-build" });
  step = nextNoStage();
  if (step.stage !== "polish") {
    throw new Error(`next-orchestration fixture: after assembly completed, expected "polish", got ${step.stage}. picked_reason=${step.picked_reason}`);
  }

  // Mark polish completed with structured evidence → picker should advance to deploy.
  markStageStatus("polish", "completed", {
    performed_by: "next-campaigns-polish",
    source_build_fingerprint: "sha256:fixture-build",
    completed_at: "2026-06-22T00:00:00.000Z",
    evidence: {
      visual_review: { screenshots: ["qa-output/checkout-desktop.png"] },
      brand_review: { favicon: "confirmed non-template favicon", colors: ["#123456"], brand_bleed: { cleared: true } },
      checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
      template_residue_review: { next_blue: "not found", starter_favicon: "not found", placeholders: "not found" },
      commerce_flow_review: { shop_single_step: "direct-entry force-package/product-selector limitation reviewed" },
      issues: [],
      commands: ["next-campaigns-polish"],
    },
  });
  step = nextNoStage();
  if (step.stage !== "deploy") {
    throw new Error(`next-orchestration fixture: after polish completed, expected "deploy", got ${step.stage}. picked_reason=${step.picked_reason}`);
  }
  if (!step.prompt || !step.prompt.includes("Deploy the built campaign")) {
    throw new Error(`next-orchestration fixture: deploy prompt should describe the deploy step, got: ${step.prompt?.slice(0, 100)}`);
  }

  // Mark deploy completed + set preview URL → picker should advance to qa.
  markStageStatus("deploy", "completed");
  setDeployUrl("https://preview.example.com/runtime-packet-demo/");
  step = nextNoStage();
  if (step.stage !== "qa") {
    throw new Error(`next-orchestration fixture: after deploy completed, expected "qa", got ${step.stage}. picked_reason=${step.picked_reason}`);
  }

  // Mark qa completed → picker should return "done".
  markStageStatus("qa", "completed");
  step = nextNoStage();
  if (step.stage !== "done") {
    throw new Error(`next-orchestration fixture: after all stages completed, expected "done", got ${step.stage}. picked_reason=${step.picked_reason}`);
  }
  if (step.ok !== true) {
    throw new Error(`next-orchestration fixture: done status should be ok=true, got ${JSON.stringify(step)}`);
  }

  // Idempotency: a blocked stage should be SURFACED (not skipped). Walk back
  // by setting polish to "blocked" and re-running next — picker should
  // return polish with stage_blocked=true.
  markStageStatus("polish", "blocked", { blockers: [{ code: "TEST_BLOCK", message: "fixture-induced block" }] });
  step = nextNoStage();
  if (step.stage !== "polish") {
    throw new Error(`next-orchestration fixture: blocked stage should be surfaced, got stage=${step.stage}`);
  }
  if (step.stage_blocked !== true) {
    throw new Error(`next-orchestration fixture: blocked stage should set stage_blocked=true, got ${JSON.stringify(step)}`);
  }
  step = runCliJsonAllowFailure(["next", "deploy", "--packet", packetPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (step.ok !== false || !step.errors?.some((issue) => String(issue.code || "").startsWith("next.deploy.polish"))) {
    throw new Error(`next-orchestration fixture: explicit next deploy should not accept blocked polish as handoff-ready, got ${JSON.stringify(step)}`);
  }
  step = runCliJsonAllowFailure(["next", "qa", "--packet", packetPath, "--json"], envWithout("CAMPAIGNS_API_KEY"));
  if (step.ok !== false || !step.errors?.some((issue) => String(issue.code || "").startsWith("next.qa.polish"))) {
    throw new Error(`next-orchestration fixture: explicit next qa should not accept blocked polish as handoff-ready, got ${JSON.stringify(step)}`);
  }

  // completed_with_warnings counts as terminal — picker should NOT pick the
  // stage again. Mark polish back to completed_with_warnings and re-run; the
  // picker should advance past polish to the next non-terminal stage. Since
  // all downstream stages are already completed, it should return "done".
  markStageStatus("polish", "completed_with_warnings");
  step = nextNoStage();
  if (step.stage !== "done") {
    throw new Error(`next-orchestration fixture: completed_with_warnings should be terminal; expected "done", got ${step.stage}`);
  }
} finally {
  rmSync(nextOrchestrationTmp, { recursive: true, force: true });
}

// Slice 5b + 5c: AI-generated entry point end-to-end.
//
// Two halves exercised:
//   1. Producer side — running the reference AI producer emits a v0
//      manifest with sha256 hashes per page entry, generator stamped.
//   2. Consumer side — prepare-build picks up the manifest, threads
//      source_hash onto each packet mapping; doctor's design_source-aware
//      error variant for "ai-generated" fires when a spec page references
//      ai-generated source HTML that isn't present.
const aiGenTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-ai-generated-"));
try {
  const sourceRoot = resolve(aiGenTmp, "source-html");
  const targetRepo = resolve(aiGenTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page} (ai-generated)</body></html>`);
  }

  // 1. Producer side — run the reference AI producer; the manifest must land
  //    at the canonical path and carry source_hash + generator.
  execFileSync(
    "node",
    [
      resolve(root, "scripts/reference-ai-producer.mjs"),
      "--source", sourceRoot,
      "--campaign-slug", "ai-gen-demo",
      "--generator", "reference-ai-producer@test",
    ],
    { stdio: "ignore" },
  );
  const manifestPath = resolve(sourceRoot, ".campaigns-os/source-html-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("ai-generated fixture: producer should have written the manifest at .campaigns-os/source-html-manifest.json");
  }
  const manifest = readJson(manifestPath);
  if (manifest.schema_version !== "source-html-manifest/v0") {
    throw new Error(`ai-generated fixture: manifest schema_version should be source-html-manifest/v0, got ${manifest.schema_version}`);
  }
  if (manifest.generator !== "reference-ai-producer@test") {
    throw new Error(`ai-generated fixture: manifest generator should reflect the --generator flag, got ${manifest.generator}`);
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== 4) {
    throw new Error(`ai-generated fixture: manifest should list 4 pages, got ${JSON.stringify(manifest.pages)}`);
  }
  for (const entry of manifest.pages) {
    if (typeof entry.source_hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.source_hash)) {
      throw new Error(`ai-generated fixture: manifest entry should carry a 64-char hex source_hash, got ${JSON.stringify(entry)}`);
    }
  }

  // 2. Consumer side — declare design_source.type="ai-generated" on the
  //    landing page so doctor's design_source-aware branch is exercised. The
  //    spec example doesn't set design_source by default; we mutate it
  //    before writing the spec file.
  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const landingPage = spec.funnels?.[0]?.pages?.find((p) => p.type === "landing");
  if (!landingPage) throw new Error("ai-generated fixture: example spec missing a landing page; pick a different fixture spec.");
  landingPage.design_source = {
    type: "ai-generated",
    file_url: "https://design-archive.example.com/ai-gen/landing-v1",
    notes: "Produced by Claude on 2026-05-26",
  };
  const specPath = resolve(aiGenTmp, "campaignspec.json");
  writeJson(specPath, spec);

  // Run start → prepare-build is invoked internally; packet should pick up
  // the manifest's source_hash and thread it onto the mapping.
  runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);
  const packet = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  const landingMapping = packet.source_html.pages.find((p) => p.page_id === landingPage.id);
  if (!landingMapping || landingMapping.path !== "landing.html") {
    throw new Error(`ai-generated fixture: landing mapping should resolve via manifest, got ${JSON.stringify(landingMapping)}`);
  }
  if (typeof landingMapping.source_hash !== "string" || landingMapping.source_hash.length !== 64) {
    throw new Error(`ai-generated fixture: landing mapping should carry source_hash from manifest, got ${JSON.stringify(landingMapping)}`);
  }
  // Every mapping should carry source_hash since the manifest set one for every page.
  for (const mapping of packet.source_html.pages) {
    if (!mapping.source_hash) {
      throw new Error(`ai-generated fixture: every manifest-derived mapping should carry source_hash, missing on ${JSON.stringify(mapping)}`);
    }
  }

  // 3. Doctor error variant — delete the landing source HTML so coverage
  //    fails for that page. Doctor should surface the ai-generated
  //    variant of the message (recommend re-running the producing agent).
  rmSync(resolve(sourceRoot, "landing.html"));
  // Also drop the manifest so the coverage failure surfaces through the
  // filesystem-fallback path (which routes through coverageErrorMessage).
  rmSync(manifestPath);
  const aiGenDoctorResult = runCliJsonAllowFailure([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);
  const aiGenCoverageErrors = (aiGenDoctorResult.doctor?.errors || []).filter((issue) => issue.code === "source_html.pages.coverage");
  const aiGenLandingError = aiGenCoverageErrors.find((issue) => issue.detail?.page_id === landingPage.id);
  if (!aiGenLandingError) {
    throw new Error(`ai-generated fixture: doctor should fire a coverage error for the missing landing page, got errors=${JSON.stringify(aiGenCoverageErrors)}`);
  }
  if (!aiGenLandingError.message.includes("ai-generated")) {
    throw new Error(`ai-generated fixture: coverage error message should mention "ai-generated" for the variant hint, got: ${aiGenLandingError.message}`);
  }
  if (!aiGenLandingError.message.includes("re-run the producing agent")) {
    throw new Error(`ai-generated fixture: coverage error message should recommend "re-run the producing agent", got: ${aiGenLandingError.message}`);
  }
} finally {
  rmSync(aiGenTmp, { recursive: true, force: true });
}

// Reference producer auto-discovery should support page-kit-style nested
// index files without collapsing every page to page_id="index", and should
// fail fast when two files still infer the same page id.
const aiGenNestedTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-ai-generated-nested-"));
try {
  const sourceRoot = resolve(aiGenNestedTmp, "source-html");
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    mkdirSync(resolve(sourceRoot, page), { recursive: true });
    writeFileSync(resolve(sourceRoot, page, "index.html"), `<html><body>${page} nested</body></html>`);
  }
  execFileSync(
    "node",
    [
      resolve(root, "scripts/reference-ai-producer.mjs"),
      "--source", sourceRoot,
      "--campaign-slug", "ai-gen-nested-demo",
      "--generator", "reference-ai-producer@test",
    ],
    { stdio: "ignore" },
  );
  const manifest = readJson(resolve(sourceRoot, ".campaigns-os/source-html-manifest.json"));
  const ids = new Set(manifest.pages?.map((entry) => entry.page_id));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    if (!ids.has(page)) {
      throw new Error(`ai-generated nested fixture: nested ${page}/index.html should derive page_id="${page}", got ${JSON.stringify(manifest.pages)}`);
    }
  }

  writeFileSync(resolve(sourceRoot, "landing.html"), "<html><body>duplicate landing</body></html>");
  let duplicateFailed = false;
  try {
    execFileSync(
      "node",
      [
        resolve(root, "scripts/reference-ai-producer.mjs"),
        "--source", sourceRoot,
        "--campaign-slug", "ai-gen-nested-demo",
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
  } catch (error) {
    duplicateFailed = true;
    if (!String(error.stderr || "").includes("duplicate page_id")) {
      throw new Error(`ai-generated nested fixture: duplicate inferred page ids should explain the failure, got stderr=${String(error.stderr || "")}`);
    }
  }
  if (!duplicateFailed) {
    throw new Error("ai-generated nested fixture: duplicate inferred page ids should fail auto-discovery");
  }
} finally {
  rmSync(aiGenNestedTmp, { recursive: true, force: true });
}

// Slice 5d: Hand-authored entry point — same shape as template-stock from
// the consumer's view (no design_source, no manifest) but exercised with
// non-conventional filenames to prove filesystem fallback handles
// designer/dev-authored HTML that doesn't follow canonical slug names.
const handAuthoredTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-hand-authored-"));
try {
  const sourceRoot = resolve(handAuthoredTmp, "source-html");
  const targetRepo = resolve(handAuthoredTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  // Bespoke filenames matching the canonical slugs — filesystem fallback
  // resolves by slug, so these still match the spec pages.
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page} (hand-authored bespoke)</body></html>`);
  }

  // Spec must NOT carry design_source on any page (defining property of the
  // hand-authored entry point per docs/entry-points.md).
  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const hasAnyDesignSource = (spec.funnels || []).some((funnel) =>
    (funnel.pages || []).some((page) => page.design_source != null),
  );
  if (hasAnyDesignSource) {
    throw new Error("hand-authored fixture sanity: example spec carries design_source on some page; pick a different fixture spec.");
  }
  const specPath = resolve(handAuthoredTmp, "campaignspec.json");
  writeJson(specPath, spec);
  const result = runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // No manifest expected.
  if (existsSync(resolve(sourceRoot, ".campaigns-os/source-html-manifest.json"))) {
    throw new Error("hand-authored fixture: no manifest should land in the source root.");
  }

  // Every active spec page should resolve via filesystem fallback.
  const packet = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  for (const expected of ["landing.html", "checkout.html", "upsell.html", "receipt.html"]) {
    const mapping = packet.source_html.pages.find((p) => p.path === expected);
    if (!mapping) {
      throw new Error(`hand-authored fixture: expected ${expected} mapping via filesystem slug, got pages=${JSON.stringify(packet.source_html.pages)}`);
    }
    // Hand-authored path has no source_hash (no manifest to source from).
    if ("source_hash" in mapping) {
      throw new Error(`hand-authored fixture: mapping should not carry source_hash without a manifest, got ${JSON.stringify(mapping)}`);
    }
  }

  // Doctor coverage errors (if any) must not include ai-generated / Figma
  // hint text — the hand-authored path is design_source-less, so only the
  // generic message applies.
  const coverageErrors = (result.doctor?.errors || []).filter((issue) => issue.code === "source_html.pages.coverage");
  for (const error of coverageErrors) {
    if (error.message.includes("Figma") || error.message.includes("ai-generated") || error.message.includes("design_source")) {
      throw new Error(`hand-authored fixture: coverage error should not mention Figma / ai-generated / design_source on the hand-authored path, got: ${error.message}`);
    }
  }
} finally {
  rmSync(handAuthoredTmp, { recursive: true, force: true });
}

// Slice 6: source-hash drift detection.
//
// Producer emits a manifest with sha256 per page → consumer threads the
// hash onto the packet → doctor runs against the packet → operator edits
// the source file on disk → doctor's next run warns about the drift.
//
// Silent when manifest doesn't carry source_hash (backward compat) and when
// the file is unchanged.
const driftTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-drift-"));
try {
  const sourceRoot = resolve(driftTmp, "source-html");
  const targetRepo = resolve(driftTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page} v1</body></html>`);
  }

  // Producer emits a manifest with source_hash on every entry.
  execFileSync(
    "node",
    [
      resolve(root, "scripts/reference-ai-producer.mjs"),
      "--source", sourceRoot,
      "--campaign-slug", "drift-demo",
    ],
    { stdio: "ignore" },
  );

  const specPath = resolve(driftTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  const startResult = runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // 1. Initial doctor run after start — no drift warning expected (file
  //    hashes match the manifest because nothing has been edited).
  const initialDriftWarnings = (startResult.doctor?.warnings || []).filter(
    (issue) => issue.code === "source_html.pages.source_hash",
  );
  if (initialDriftWarnings.length > 0) {
    throw new Error(`drift fixture: no drift warnings expected immediately after start, got ${JSON.stringify(initialDriftWarnings)}`);
  }

  // 2. Operator edits the landing page (changes its hash) and re-runs
  //    doctor against the existing packet. The drift warning should fire
  //    naming the landing file.
  writeFileSync(resolve(sourceRoot, "landing.html"), `<html><body>landing v2 (operator edits)</body></html>`);
  const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
  const driftResult = runCliJsonAllowFailure([
    "doctor",
    "--packet", packetPath,
    "--spec", specPath,
    "--json",
  ]);
  const driftWarnings = (driftResult.warnings || []).filter(
    (issue) => issue.code === "source_html.pages.source_hash",
  );
  if (driftWarnings.length !== 1) {
    throw new Error(`drift fixture: expected exactly one drift warning after editing landing.html, got ${JSON.stringify(driftResult.warnings)}`);
  }
  if (!driftWarnings[0].message.includes("landing.html") || !driftWarnings[0].message.includes("hash mismatch")) {
    throw new Error(`drift fixture: drift warning should name landing.html and "hash mismatch", got: ${driftWarnings[0].message}`);
  }

  // 3. Unedited files stay silent — the warning fires only for the page
  //    whose on-disk content diverged.
  for (const warning of driftWarnings) {
    if (!warning.message.includes("landing.html")) {
      throw new Error(`drift fixture: unexpected drift warning for non-landing page, got: ${warning.message}`);
    }
  }
} finally {
  rmSync(driftTmp, { recursive: true, force: true });
}

// Slice 6 backward-compat: mixed manifest where some entries carry source_hash
// and others don't. The drift check must stay silent on the hash-less entries
// (pre-Slice-6 producers) even after their files are edited. A regression
// where "absent hash" gets treated as "expected empty hash" would always-warn
// on those entries, which is what this fixture guards against.
const mixedManifestTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-mixed-manifest-"));
try {
  const sourceRoot = resolve(mixedManifestTmp, "source-html");
  const targetRepo = resolve(mixedManifestTmp, "target-page-kit");
  mkdirSync(resolve(sourceRoot, ".campaigns-os"), { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  for (const page of ["landing", "checkout", "upsell", "receipt"]) {
    writeFileSync(resolve(sourceRoot, `${page}.html`), `<html><body>${page} v1</body></html>`);
  }

  // Hand-craft a manifest where landing has source_hash but checkout/upsell/
  // receipt do not. Simulates a pre-Slice-6 producer (or one mid-migration).
  const landingHash = createHash("sha256").update(readFileSync(resolve(sourceRoot, "landing.html"))).digest("hex");
  writeJson(resolve(sourceRoot, ".campaigns-os/source-html-manifest.json"), {
    schema_version: "source-html-manifest/v0",
    generated_at: "2026-05-26T00:00:00.000Z",
    generator: "mixed-manifest-test@1.0",
    campaign_slug: "mixed-manifest-demo",
    root: ".",
    pages: [
      { page_id: "landing", path: "landing.html", page_type: "landing", source_hash: landingHash },
      { page_id: "checkout", path: "checkout.html", page_type: "checkout" },
      { page_id: "upsell", path: "upsell.html", page_type: "upsell" },
      { page_id: "receipt", path: "receipt.html", page_type: "thankyou" },
    ],
  });

  const specPath = resolve(mixedManifestTmp, "campaignspec.json");
  writeJson(specPath, readJson(resolve(root, "examples/campaignspec.v42.basic.json")));
  runCliJson([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // Verify the packet carries source_hash for landing and omits it for others.
  const mixedPacket = readJson(resolve(targetRepo, "campaign-runtime.build.json"));
  const landingMapping = mixedPacket.source_html.pages.find((p) => p.page_id === "landing");
  if (landingMapping?.source_hash !== landingHash) {
    throw new Error(`mixed-manifest fixture: landing mapping should carry source_hash, got ${JSON.stringify(landingMapping)}`);
  }
  for (const otherPageId of ["checkout", "upsell", "receipt"]) {
    const otherMapping = mixedPacket.source_html.pages.find((p) => p.page_id === otherPageId);
    if (otherMapping && "source_hash" in otherMapping) {
      throw new Error(`mixed-manifest fixture: ${otherPageId} mapping should not carry source_hash (manifest omitted it), got ${JSON.stringify(otherMapping)}`);
    }
  }

  // Edit checkout.html (which has NO source_hash in the manifest). Doctor
  // should stay silent — there's no hash to compare against.
  writeFileSync(resolve(sourceRoot, "checkout.html"), `<html><body>checkout v2 (edited)</body></html>`);
  const packetPath = resolve(targetRepo, "campaign-runtime.build.json");
  const mixedDoctorResult = runCliJsonAllowFailure([
    "doctor",
    "--packet", packetPath,
    "--spec", specPath,
    "--json",
  ]);
  const mixedDriftWarnings = (mixedDoctorResult.warnings || []).filter(
    (issue) => issue.code === "source_html.pages.source_hash",
  );
  if (mixedDriftWarnings.length > 0) {
    throw new Error(`mixed-manifest fixture: editing a hash-less page should not fire a drift warning, got ${JSON.stringify(mixedDriftWarnings)}`);
  }

  // Edit landing.html (which DOES have source_hash). Doctor should now fire
  // exactly one warning for landing — proving the mixed-manifest case still
  // works for the hashed entries.
  writeFileSync(resolve(sourceRoot, "landing.html"), `<html><body>landing v2 (edited)</body></html>`);
  const mixedDoctorAfterLanding = runCliJsonAllowFailure([
    "doctor",
    "--packet", packetPath,
    "--spec", specPath,
    "--json",
  ]);
  const landingDriftWarnings = (mixedDoctorAfterLanding.warnings || []).filter(
    (issue) => issue.code === "source_html.pages.source_hash",
  );
  if (landingDriftWarnings.length !== 1 || !landingDriftWarnings[0].message.includes("landing.html")) {
    throw new Error(`mixed-manifest fixture: editing landing.html (hash-bearing) should fire one drift warning naming landing, got ${JSON.stringify(landingDriftWarnings)}`);
  }
} finally {
  rmSync(mixedManifestTmp, { recursive: true, force: true });
}

// Slice 5b/5c follow-up: fresh AI-gen campaign where the producer hasn't run
// yet. Every spec page carries design_source.type='ai-generated' but no source
// HTML exists and no manifest is present. matchSourcePages now omits the
// skip_reason mapping for design_source pages, so the packet's
// source_html.pages array can end up empty. Doctor must produce a
// design_source-aware coverage error per active page (not a generic
// "out of scope" or "needs path or skip_reason" message), guiding the
// operator to run the producer.
const freshAiGenTmp = mkdtempSync(resolve(tmpdir(), "campaigns-os-fresh-ai-gen-"));
try {
  const sourceRoot = resolve(freshAiGenTmp, "source-html");
  const targetRepo = resolve(freshAiGenTmp, "target-page-kit");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRepo, { recursive: true });
  writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
  // Intentionally NO .html files, NO manifest. Producer hasn't run.

  // Mark every active page as ai-generated.
  const spec = readJson(resolve(root, "examples/campaignspec.v42.basic.json"));
  const activePages = (spec.funnels?.[0]?.pages || []).filter((p) => p.enabled !== false);
  if (activePages.length === 0) {
    throw new Error("fresh-ai-gen fixture sanity: example spec has no active pages.");
  }
  for (const page of activePages) {
    page.design_source = {
      type: "ai-generated",
      file_url: `https://design-archive.example.com/ai-gen/${page.id}`,
      notes: "Producer scheduled but hasn't run yet",
    };
  }
  const specPath = resolve(freshAiGenTmp, "campaignspec.json");
  writeJson(specPath, spec);

  const result = runCliJsonAllowFailure([
    "start",
    "--spec", specPath,
    "--source", sourceRoot,
    "--target", targetRepo,
    "--template-family", "olympus",
    "--json",
  ]);

  // Packet should still be written (start handles the failure mode by emitting
  // a packet with whatever was resolvable, plus prompts/errors).
  const freshPacketPath = resolve(targetRepo, "campaign-runtime.build.json");
  if (!existsSync(freshPacketPath)) {
    throw new Error("fresh-ai-gen fixture: start should still emit campaign-runtime.build.json even when source coverage fails.");
  }
  const freshPacket = readJson(freshPacketPath);
  // source_html.pages should be empty (no mappings emitted for design_source pages with no source).
  if (!Array.isArray(freshPacket.source_html?.pages) || freshPacket.source_html.pages.length !== 0) {
    throw new Error(`fresh-ai-gen fixture: source_html.pages should be empty when every page is unresolved design_source, got ${JSON.stringify(freshPacket.source_html?.pages)}`);
  }

  // Doctor should fire one coverage error per active page with ai-generated wording.
  const coverageErrors = (result.doctor?.errors || []).filter((issue) => issue.code === "source_html.pages.coverage");
  if (coverageErrors.length !== activePages.length) {
    throw new Error(`fresh-ai-gen fixture: expected ${activePages.length} coverage errors (one per page), got ${coverageErrors.length}: ${JSON.stringify(coverageErrors)}`);
  }
  for (const err of coverageErrors) {
    if (!err.message.includes("ai-generated")) {
      throw new Error(`fresh-ai-gen fixture: every coverage error should mention "ai-generated", got: ${err.message}`);
    }
    if (!err.message.includes("re-run the producing agent")) {
      throw new Error(`fresh-ai-gen fixture: every coverage error should recommend "re-run the producing agent", got: ${err.message}`);
    }
  }
} finally {
  rmSync(freshAiGenTmp, { recursive: true, force: true });
}

console.log("Fixture checks passed");
