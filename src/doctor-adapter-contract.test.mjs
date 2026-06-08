import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

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

function withPreparedBuild(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-adapter-contract-"));
  try {
    const sourceRoot = resolve(dir, "source-html");
    const targetRepo = resolve(dir, "target-page-kit");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    writeFileSync(resolve(sourceRoot, "landing.html"), "<section>Landing</section>");
    writeFileSync(resolve(sourceRoot, "checkout.html"), '<section data-commerce-zone="checkout-form"></section>');
    writeFileSync(resolve(sourceRoot, "upsell.html"), '<section data-commerce-zone="upsell-offer"></section>');
    writeFileSync(resolve(sourceRoot, "receipt.html"), '<section data-commerce-zone="receipt-summary"></section>');

    const specPath = resolve(dir, "campaignspec.json");
    writeJson(specPath, readJson(resolve(ROOT, "examples/campaignspec.v42.basic.json")));

    runCliJson([
      "prepare-build",
      "--spec", specPath,
      "--source", sourceRoot,
      "--target", targetRepo,
      "--template-family", "olympus",
      "--json",
    ]);

    return run({
      dir,
      packetPath: resolve(targetRepo, "campaign-runtime.build.json"),
      contextPath: resolve(targetRepo, ".campaign-runtime/build-context.json"),
      reportPath: resolve(targetRepo, ".campaign-runtime/assembly-report.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function markAssemblyCompleted(reportPath, mutate = (report) => report) {
  const report = readJson(reportPath);
  report.stages.assembly.status = "completed";
  mutate(report);
  writeJson(reportPath, report);
}

test("prepare-build emits adapter decisions and proof policy in public artifacts", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    const packet = readJson(packetPath);
    const context = readJson(contextPath);
    const report = readJson(reportPath);

    assert.equal(packet.source_html.adapter_contract.source_asset_strategy, "pagekit_campaign_asset_root");
    assert.equal(packet.source_html.adapter_contract.raw_html_conversion_status, "pending");
    assert.equal(packet.source_html.adapter_contract.wrapper_policy, "strip_document_wrappers");
    assert.equal(packet.source_html.adapter_contract.frontmatter_policy, "pagekit_yaml_frontmatter");
    assert.equal(packet.source_html.adapter_contract.script_style_reference_policy, "frontmatter_or_campaign_asset");
    assert.equal(packet.source_html.adapter_contract.cta_rewrite_policy, "campaignspec_routes_via_campaign_link");
    assert.equal(packet.source_html.adapter_contract.layout_choice, "campaign_layout");
    assert.equal(context.adapter_decisions.commerce_shell_adoption, "template_clone_first_required");
    assert.equal(report.adapter_decisions.template_files_copied.status, "pending");
    assert.equal(packet.qa.proof_policy.browser_qa_required, true);
    assert.equal(report.proof_policy.typed_card_depth, "common");
  });
});

test("doctor routes optional context and assembly report through named artifact checks", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    const context = readJson(contextPath);
    context.source_adapter = "unknown_adapter";
    writeJson(contextPath, context);

    const report = readJson(reportPath);
    report.proof_policy = "not-an-object";
    writeJson(reportPath, report);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("context.source_adapter"), true);
    assert.equal(warningCodes.has("report.proof_policy"), true);
    assert.deepEqual(
      (doctor.derived?.doctor_checks || []).filter((id) => id === "context.shape" || id === "assembly_report.shape"),
      ["context.shape", "assembly_report.shape"]
    );
  });
});

test("doctor warns on unknown adapter policy field values", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    const packet = readJson(packetPath);
    packet.source_html.adapter_contract.wrapper_policy = "definitely_not_strip";
    packet.source_html.adapter_contract.frontmatter_policy = "invent_frontmatter";
    packet.source_html.adapter_contract.script_style_reference_policy = "mystery_loader";
    packet.source_html.adapter_contract.cta_rewrite_policy = "clicks_go_somewhere";
    packet.source_html.adapter_contract.layout_choice = "bespoke_shell";
    writeJson(packetPath, packet);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("source_html.adapter_contract.wrapper_policy"), true);
    assert.equal(warningCodes.has("source_html.adapter_contract.frontmatter_policy"), true);
    assert.equal(warningCodes.has("source_html.adapter_contract.script_style_reference_policy"), true);
    assert.equal(warningCodes.has("source_html.adapter_contract.cta_rewrite_policy"), true);
    assert.equal(warningCodes.has("source_html.adapter_contract.layout_choice"), true);
  });
});

test("doctor names unfinished adapter decisions after assembly is recorded complete", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath);
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(doctor.ok, true);
    assert.equal(warningCodes.has("adapter.raw_html_conversion_status"), true);
    assert.equal(warningCodes.has("adapter.commerce_shell_adoption"), true);
    assert.equal(warningCodes.has("adapter.template_files_copied"), true);
  });
});

test("doctor blocks explicit experimental custom commerce shells on runtime pages", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.adapter_decisions.commerce_shell_adoption = "custom_html_experimental";
    });
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);

    assert.equal(doctor.ok, false);
    assert.equal((doctor.errors || []).some((issue) => issue.code === "adapter.commerce_shell_adoption"), true);
  });
});

test("findings harvest proposes locally and writes only with --write", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath);
    const dryRun = runCliJson(["findings", "harvest", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const journalPath = resolve(packetPath, "..", ".campaign-runtime", "workflow-findings.jsonl");

    assert.equal(dryRun.action, "findings-harvest");
    assert.equal(dryRun.write, false);
    assert.ok(dryRun.count > 0);
    assert.equal(existsSync(journalPath), false);

    const written = runCliJson(["findings", "harvest", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--write", "--json"]);
    assert.equal(written.write, true);
    assert.ok(written.written.length > 0);
    assert.equal(existsSync(journalPath), true);
  });
});
