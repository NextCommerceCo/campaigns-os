import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function runCliJson(args, options = {}) {
  try {
    return JSON.parse(execFileSync(process.execPath, [CLI, ...args], {
      cwd: options.cwd || ROOT,
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
    mkdirSync(resolve(sourceRoot, "assets/products"), { recursive: true });
    mkdirSync(targetRepo, { recursive: true });
    writeFileSync(resolve(targetRepo, "package.json"), JSON.stringify({ dependencies: { "next-campaign-page-kit": "fixture" } }));
    writeFileSync(resolve(sourceRoot, "assets/config.js"), "window.__NEXT_CAMPAIGN__ = {};\n");
    writeFileSync(resolve(sourceRoot, "assets/products/hero.png"), "hero\n");
    writeFileSync(resolve(sourceRoot, "landing.html"), '<script src="/assets/config.js"></script><img src="assets/products/hero.png"><section>Landing</section>');
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
      "--no-run-session",
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
  report.stages.assembly.build_fingerprint = "sha256:test-build";
  mutate(report);
  writeJson(reportPath, report);
}

function validPolishStage(overrides = {}) {
  return {
    stage: "polish",
    status: "completed_with_warnings",
    performed_by: "next-campaigns-polish",
    source_build_fingerprint: "sha256:test-build",
    completed_at: "2026-06-22T00:00:00.000Z",
    inputs: [],
    outputs: [],
    commands: ["next-campaigns-polish"],
    blockers: [],
    warnings: [],
    evidence: {
      visual_review: { screenshots: ["qa-output/checkout-desktop.png", "qa-output/checkout-mobile.png"] },
      brand_review: { logo_checked: true, favicon: "confirmed non-template favicon", colors: ["#123456"] },
      checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
      template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found", product_placeholders: "not found" },
      commerce_flow_review: { shop_single_step: "direct-entry force-package/product-selector limitation reviewed" },
      issues: [],
      commands: ["next-campaigns-polish"],
    },
    ...overrides,
  };
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
    assert.equal(context.source.asset_crawl.schema_version, "source-asset-crawl/v0");
    assert.equal(context.source.asset_crawl.summary.root_assets_path_count, 1);
    assert.equal(report.warnings.some((warning) => warning.code === "SOURCE_ASSET_REWRITE"), true);
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
      (doctor.derived?.doctor_checks || []).slice(-2),
      ["context.shape", "assembly_report.shape"]
    );
  });
});

test("doctor skips missing optional artifact sidecars in the named check trace", () => {
  withPreparedBuild(({ packetPath, contextPath }) => {
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--json"]);
    const checkIds = doctor.derived?.doctor_checks || [];
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(checkIds.at(-1), "context.shape");
    assert.equal(checkIds.includes("assembly_report.shape"), false);
    assert.equal(warningCodes.has("report.adapter_decisions"), false);
  });
});

test("packet-only doctor auto-loads adjacent build sidecars when present", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    const context = readJson(contextPath);
    context.source_adapter = "unknown_adapter";
    writeJson(contextPath, context);

    const report = readJson(reportPath);
    report.proof_policy = "not-an-object";
    writeJson(reportPath, report);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("context.source_adapter"), true);
    assert.equal(warningCodes.has("report.proof_policy"), true);
    assert.ok((doctor.derived?.doctor_checks || []).includes("context.shape"));
    assert.ok((doctor.derived?.doctor_checks || []).includes("assembly_report.shape"));
  });
});

test("packet-only doctor stays packet-scoped when adjacent sidecars are absent", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    rmSync(contextPath, { force: true });
    rmSync(reportPath, { force: true });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("context.adapter_decisions"), false);
    assert.equal(warningCodes.has("report.adapter_decisions"), false);
    assert.equal((doctor.derived?.doctor_checks || []).includes("context.shape"), false);
    assert.equal((doctor.derived?.doctor_checks || []).includes("assembly_report.shape"), false);
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

test("doctor warns when required adapter fields are missing", () => {
  withPreparedBuild(({ packetPath }) => {
    const packet = readJson(packetPath);
    delete packet.source_html.adapter_contract.layout_choice;
    delete packet.source_html.adapter_contract.template_files_copied.paths;
    writeJson(packetPath, packet);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("source_html.adapter_contract.layout_choice"), true);
    assert.equal(warningCodes.has("source_html.adapter_contract.template_files_copied.paths"), true);
  });
});

test("doctor validates proof-policy setup and allowlist fields", () => {
  withPreparedBuild(({ packetPath, reportPath }) => {
    const packet = readJson(packetPath);
    packet.qa.proof_policy.browser_qa_required = "yes";
    delete packet.qa.proof_policy.localhost_development_domain_allowed;
    packet.qa.proof_policy.non_localhost_origin_allowlist_required = false;
    writeJson(packetPath, packet);

    const report = readJson(reportPath);
    delete report.proof_policy.operator_approval_state;
    writeJson(reportPath, report);

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));
    const browserWarning = (doctor.warnings || []).find((issue) => issue.code === "qa.proof_policy.browser_qa_required");

    assert.match(browserWarning.message, /must be a boolean/);
    assert.equal(warningCodes.has("qa.proof_policy.localhost_development_domain_allowed"), true);
    assert.equal(warningCodes.has("qa.proof_policy.non_localhost_origin_allowlist_required"), true);
    assert.equal(warningCodes.has("report.proof_policy.operator_approval_state"), true);
  });
});

test("doctor names unfinished adapter decisions after assembly is recorded complete", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath);
    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(doctor.ok, false);
    assert.equal((doctor.errors || []).some((issue) => issue.code === "polish.evidence_missing"), true);
    assert.equal(warningCodes.has("adapter.raw_html_conversion_status"), true);
    assert.equal(warningCodes.has("adapter.commerce_shell_adoption"), true);
    assert.equal(warningCodes.has("adapter.template_files_copied"), true);
  });
});

test("polish lifecycle gate blocks doctor, next, and qa until distinct evidence exists", () => {
  withPreparedBuild(({ dir, packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.stages.polish.status = "required";
      report.stages.polish.required_by = "build";
      report.stages.polish.required_for = ["qa"];
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    assert.equal(doctor.ok, false);
    assert.equal((doctor.errors || []).some((issue) => issue.code === "polish.evidence_missing"), true);
    assert.equal(doctor.derived?.polish_gate?.status, "blocked");
    assert.match((doctor.errors || []).find((issue) => issue.code === "polish.evidence_missing").message, /Polish evidence missing for current build/);

    const next = runCliJson(["next", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.equal(next.ok, true);
    assert.equal(next.stage, "polish");
    assert.equal(next.stage_blocked, true);
    assert.equal((next.gates || []).find((gate) => gate.id === "polish_gate")?.status, "blocked");

    const qa = runCliJson([
      "qa", "run",
      "--packet", packetPath,
      "--no-post-verdict",
      "--output-dir", join(dir, "qa-output"),
      "--json",
    ]);
    assert.equal(qa.status, "blocked");
    assert.equal(qa.polish_gate.status, "blocked");
    assert.equal(qa.verdict.assertions.some((assertion) => assertion.family === "polish_gate" && assertion.status === "fail"), true);
  });
});

test("next routes back to build when source package changed after assembly", () => {
  withPreparedBuild(({ packetPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.design_source_package = {
        path: ".campaign-runtime/input/design-source-package.json",
        schema_version: "campaign-design-source-package/v0",
        sha256: "sha256:source-full",
        material_fingerprint: "sha256:source-current",
      };
      report.stages.assembly.source_package_material_fingerprint = "sha256:source-old";
      report.stages.polish.status = "required";
      report.stages.polish.required_by = "build";
      report.stages.polish.required_for = ["qa"];
    });

    const next = runCliJson(["next", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.equal((next.errors || []).some((issue) => String(issue.code || "").startsWith("polish.") || issue.code === "next.build.doctor"), false);
    assert.equal(next.stage, "build");
    assert.match(next.picked_reason, /Design Source Package changed after Build/);
    assert.equal((next.gates || []).find((gate) => gate.id === "polish_gate")?.code, "polish.assembly_source_package_stale");
    assert.equal((next.next_actions || []).some((action) => action.command === "next-campaigns-build"), true);

    const explicitPolish = runCliJson(["next", "polish", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.equal(explicitPolish.stage, "polish");
    assert.equal(explicitPolish.status, "blocked");
    assert.equal((explicitPolish.errors || []).some((issue) => issue.code === "next.polish.polish.assembly_source_package_stale"), true);
    assert.equal((explicitPolish.next_actions || []).some((action) => action.command === "next-campaigns-build"), true);
  });
});

test("source package freshness waiver lets next proceed to polish but not past missing polish evidence", () => {
  withPreparedBuild(({ packetPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.design_source_package = {
        path: ".campaign-runtime/input/design-source-package.json",
        schema_version: "campaign-design-source-package/v0",
        sha256: "sha256:source-full",
        material_fingerprint: "sha256:source-current",
      };
      report.waivers = [
        {
          scope: "assembly_source_package_freshness",
          reason: "Operator confirmed the source change does not require rebuilding this run.",
          applies_to: ["stages.assembly.source_package_material_fingerprint"],
          waived_by: "operator",
          waived_at: "2026-06-22T00:00:00.000Z",
          review_condition: "Valid for this run only.",
        },
      ];
      report.stages.assembly.source_package_material_fingerprint = "sha256:source-old";
      report.stages.polish.status = "required";
      report.stages.polish.required_by = "build";
      report.stages.polish.required_for = ["qa"];
    });

    const next = runCliJson(["next", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.equal(next.ok, true);
    assert.equal(next.stage, "polish");
    assert.equal(next.stage_blocked, true);
    assert.match(next.picked_reason, /Polish evidence missing/);
    assert.equal((next.gates || []).find((gate) => gate.id === "polish_gate")?.code, "polish.evidence_missing");
    assert.equal((next.next_actions || []).some((action) => action.command === "next-campaigns-polish"), true);
  });
});

test("valid polish evidence lets next advance beyond polish", () => {
  withPreparedBuild(({ packetPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.stages.polish = validPolishStage();
    });

    const next = runCliJson(["next", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.notEqual(next.stage, "polish");
    assert.equal((next.gates || []).find((gate) => gate.id === "polish_gate")?.status, "pass");
  });
});

test("valid polish evidence under source freshness waiver lets doctor and next advance beyond polish", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.design_source_package = {
        path: ".campaign-runtime/input/design-source-package.json",
        schema_version: "campaign-design-source-package/v0",
        sha256: "sha256:source-full",
        material_fingerprint: "sha256:source-current",
      };
      report.waivers = [
        {
          scope: "assembly_source_package_freshness",
          reason: "Operator confirmed the source change does not require rebuilding this run.",
          applies_to: ["stages.assembly.source_package_material_fingerprint"],
          waived_by: "operator",
          waived_at: "2026-06-22T00:00:00.000Z",
          review_condition: "Valid for this run only.",
        },
      ];
      report.stages.assembly.source_package_material_fingerprint = "sha256:source-old";
      report.stages.polish = validPolishStage({
        source_package_material_fingerprint: "sha256:source-current",
      });
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    assert.equal(doctor.derived?.polish_gate?.status, "waived");
    assert.notEqual(doctor.next?.stage, "assembly");
    assert.notEqual(doctor.next?.stage, "polish");

    const next = runCliJson(["next", "--packet", packetPath, "--report", reportPath, "--json"]);
    assert.notEqual(next.stage, "polish");
    assert.equal((next.gates || []).find((gate) => gate.id === "polish_gate")?.status, "waived");
  });
});

test("doctor verifies declared template slice paths exist after assembly completes", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.adapter_decisions.raw_html_conversion_status = "completed";
      report.adapter_decisions.commerce_shell_adoption = "template_clone_first_verified";
      report.adapter_decisions.template_files_copied = {
        status: "verified_existing_slice",
        required_groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        paths: ["src/runtime-packet-demo", "src/runtime-packet-demo/_includes"],
      };
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("adapter.template_files_copied.paths"), true);
  });
});

test("doctor rejects template slice paths that escape the target repo", () => {
  withPreparedBuild(({ dir, packetPath, contextPath, reportPath }) => {
    mkdirSync(resolve(dir, "outside-slice"), { recursive: true });
    markAssemblyCompleted(reportPath, (report) => {
      report.adapter_decisions.raw_html_conversion_status = "completed";
      report.adapter_decisions.commerce_shell_adoption = "template_clone_first_verified";
      report.adapter_decisions.template_files_copied = {
        status: "verified_existing_slice",
        required_groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        paths: ["../outside-slice"],
      };
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("adapter.template_files_copied.paths"), true);
  });
});

test("doctor warns when template slice paths cannot be verified against target repo", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    const packet = readJson(packetPath);
    packet.assembly.target_repo = "missing-target";
    writeJson(packetPath, packet);
    markAssemblyCompleted(reportPath, (report) => {
      report.adapter_decisions.raw_html_conversion_status = "completed";
      report.adapter_decisions.commerce_shell_adoption = "template_clone_first_verified";
      report.adapter_decisions.template_files_copied = {
        status: "verified_existing_slice",
        required_groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        paths: ["src/checkout.html"],
      };
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("adapter.template_files_copied.paths"), true);
  });
});

test("doctor rejects UNC absolute template slice paths", () => {
  withPreparedBuild(({ packetPath, contextPath, reportPath }) => {
    markAssemblyCompleted(reportPath, (report) => {
      report.adapter_decisions.raw_html_conversion_status = "completed";
      report.adapter_decisions.commerce_shell_adoption = "template_clone_first_verified";
      report.adapter_decisions.template_files_copied = {
        status: "verified_existing_slice",
        required_groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        groups: ["pages", "_includes", "_layouts", "assets/css", "assets/js", "frontmatter_vocabulary"],
        paths: [String.raw`\\server\share\slice`],
      };
    });

    const doctor = runCliJson(["doctor", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--json"]);
    const warningCodes = new Set((doctor.warnings || []).map((issue) => issue.code));

    assert.equal(warningCodes.has("adapter.template_files_copied.paths"), true);
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
    assert.equal(dryRun.proposals.every((finding) => finding.safe_to_share === false), true);
    assert.equal(existsSync(journalPath), false);

    const started = runCliJson(["run", "start", "--packet", packetPath, "--json"], { cwd: dirname(packetPath) });
    const written = runCliJson(["findings", "harvest", "--packet", packetPath, "--context", contextPath, "--report", reportPath, "--write", "--json"], { cwd: dirname(packetPath) });
    assert.equal(written.write, true);
    assert.ok(written.written.length > 0);
    assert.ok(written.written.every((finding) => finding.run_id === started.session.run_id));
    assert.equal(existsSync(journalPath), true);
  });
});
