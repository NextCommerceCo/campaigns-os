import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import {
  detectFrameworks,
  discoverCampaignCartAppRoots,
  scanCampaignCartAppRoot,
} from "./campaign-ecosystem.mjs";

export const STANDARDIZATION_REPORT_SCHEMA = "campaign-standardization-report/v0";

const PAGE_KIT_PACKAGE_NAMES = [
  "next-campaign-page-kit",
  "@nextcommerce/campaign-page-kit",
];

const PREFERRED_SDK_MIN = "0.4.20";
const PREFERRED_PAGE_KIT_MIN = "0.1.1";
const MAX_SAMPLE_COUNT = 8;
const SKIP_DIRS = new Set([
  ".git",
  ".campaign-runtime",
  "_site",
  "node_modules",
  "qa-output",
  "dist",
]);
const STRUCTURE_EXTENSIONS = new Set([".html", ".liquid"]);
const TEXT_EXTENSIONS = new Set([".html", ".liquid", ".js", ".css"]);
const RAW_BLOCK_PATTERN = /{%-?\s*raw\s*-?%}/g;
const HARDCODED_ROOT_ASSET_ATTR_PATTERN = /\b(?:src|href)\s*=\s*(["'])\/assets\/[^"']*\1/g;
const HARDCODED_ROOT_ASSET_URL_PATTERN = /\burl\(\s*(["']?)\/assets\/[^)"']*\1\s*\)/g;

export function createStandardizationReport({
  targetRepo,
  slug = null,
  templateFamily = null,
  generatedAt = new Date().toISOString(),
  fieldContract = null,
  sdkSupportPolicy = null,
} = {}) {
  if (!targetRepo) throw new Error("createStandardizationReport requires targetRepo");
  const target = resolve(targetRepo);
  const pageKitRootPaths = discoverPageKitRoots(target);
  const roots = pageKitRootPaths.map((rootPath) => scanPageKitRoot({
    targetRepo: target,
    rootPath,
    requestedSlug: normalizeString(slug),
    explicitTemplateFamily: normalizeString(templateFamily),
  }));
  const appRoots = discoverCampaignCartAppRoots(target, { excludeRoots: pageKitRootPaths });
  for (const discovered of appRoots) {
    const root = scanCampaignCartAppRoot({
      targetRepo: target,
      rootPath: discovered.rootPath,
      evidence: discovered.evidence,
      fieldContract,
      sdkSupportPolicy,
      excludeRoots: [
        ...pageKitRootPaths,
        ...appRoots.map((entry) => entry.rootPath),
      ],
    });
    finalizeRoot(root);
    roots.push(root);
  }
  const report = {
    schema_version: STANDARDIZATION_REPORT_SCHEMA,
    generated_at: generatedAt,
    target_repo: target,
    status: "unknown",
    ok: false,
    summary: null,
    roots,
    errors: [],
    recommendation: {
      home: "staged_split",
      summary: "Keep the read-only source/runtime scanner in public campaigns-os first; layer private repo discovery, issue creation, and merchant ops context in an internal campaign-ops wrapper.",
    },
  };

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    report.errors.push({
      code: "target.not_found",
      message: `Target repo does not exist or is not a directory: ${target}`,
    });
  } else if (roots.length === 0) {
    report.errors.push({
      code: "campaign.root_not_found",
      message: "No campaign root was detected. Expected a Page Kit root (package.json with next-campaign-page-kit or _data/campaigns.json) or portable Campaign Cart evidence (loader script, next-campaign-id meta, window.nextConfig, or data-next-* anchors).",
    });
  }

  finalizeReport(report);
  return report;
}

export function attachBuiltOutputDoctor(report, rootId, doctorResult) {
  const root = (report?.roots || []).find((entry) => entry.id === rootId);
  if (!root?.built_output) return report;
  root.built_output.doctor = summarizeDoctorResult(doctorResult);
  if (doctorResult?.errors?.length) {
    for (const [index, issue] of doctorResult.errors.entries()) {
      root.findings.push(finding({
        severity: "blocker",
        category: "standardization_blocker",
        code: builtDoctorFindingCode(issue, "error", index),
        message: issue.message || String(issue),
        evidence: issue.detail || null,
        next_action: "Resolve built-output doctor blockers, then rerun the standardization report.",
      }));
    }
  }
  if (doctorResult?.warnings?.length) {
    for (const [index, issue] of doctorResult.warnings.entries()) {
      root.findings.push(finding({
        severity: "warning",
        category: "standardization_warning",
        code: builtDoctorFindingCode(issue, "warning", index),
        message: issue.message || String(issue),
        evidence: issue.detail || null,
        next_action: "Use the built-output doctor finding as the concrete repair target.",
      }));
    }
  }
  finalizeRoot(root);
  finalizeReport(report);
  return report;
}

export function formatStandardizationReportMarkdown(report) {
  const lines = [];
  lines.push("# Campaign Standardization Report");
  lines.push("");
  lines.push(`Status: ${String(report.status || "unknown").toUpperCase()}`);
  lines.push(`Target: ${report.target_repo || "(unknown)"}`);
  lines.push(`Generated: ${report.generated_at || "(unknown)"}`);
  lines.push("");
  lines.push("## Summary");
  const summary = report.summary || {};
  lines.push(`- Campaign roots: ${summary.root_count ?? 0}`);
  lines.push(`- Findings: ${summary.blockers ?? 0} blocker(s), ${summary.warnings ?? 0} warning(s), ${summary.operator_readiness ?? 0} operator-readiness item(s)`);
  lines.push(`- Home recommendation: ${report.recommendation?.home || "unknown"} - ${report.recommendation?.summary || ""}`);
  if (report.errors?.length) {
    lines.push("");
    lines.push("## Errors");
    for (const error of report.errors) lines.push(`- [${error.code}] ${error.message}`);
  }

  for (const root of report.roots || []) {
    if (root.implementation?.kind === "campaign_cart_app") {
      appendCampaignCartAppMarkdown(lines, root);
      continue;
    }
    const rootLabel = root.identity.page_kit_root_relative === "."
      ? `${root.identity.repo} (repo root)`
      : root.identity.page_kit_root_relative;
    lines.push("");
    lines.push(`## ${rootLabel || root.identity.page_kit_root}`);
    lines.push("");
    lines.push("### Identity");
    lines.push(`- Status: ${String(root.status || "unknown").toUpperCase()}`);
    lines.push(`- Implementation: ${root.implementation?.kind || "page_kit"}`);
    lines.push(`- Slug(s): ${root.identity.campaign_slugs.map((entry) => entry.slug).join(", ") || "(none)"}`);
    lines.push(`- SDK: ${root.identity.sdk_versions.join(", ") || "(unknown)"}`);
    lines.push(`- Page Kit: ${root.identity.page_kit_dependency?.name || "(unknown)"} ${root.identity.page_kit_dependency?.version || "(unknown)"}`);
    lines.push(`- Template family: ${root.identity.template_family.value || "(unknown)"} (${root.identity.template_family.source || "unknown"})`);
    lines.push(`- Campaigns OS artifacts: ${root.identity.has_campaign_runtime ? "yes" : "no"}`);
    lines.push(`- Built _site: ${formatBuiltSiteState(root)}`);
    lines.push("");
    lines.push("### Source Structure");
    lines.push(`- HTML files: ${root.source_structure.html_file_count}; pages: ${root.source_structure.page_file_count}; includes: ${root.source_structure.include_file_count}; layouts: ${root.source_structure.layout_file_count}`);
    lines.push(`- Helpers: campaign_asset=${root.source_structure.helper_counts.campaign_asset}, campaign_include=${root.source_structure.helper_counts.campaign_include}, campaign_link=${root.source_structure.helper_counts.campaign_link}`);
    lines.push(`- Raw blocks: ${root.source_structure.raw_blocks.count}; document wrappers in pages: ${root.source_structure.document_wrappers.count}; hardcoded /assets refs: ${root.source_structure.hardcoded_root_assets.count}; unreadable files: ${root.source_structure.unreadable_files.count}`);
    lines.push(`- Payment methods include: ${root.source_structure.payment_methods_include.detected ? "detected" : "not detected"}`);
    lines.push("");
    lines.push("### Runtime Contract");
    lines.push(`- data-next anchors: ${root.runtime_contract.data_next.total_occurrences} occurrence(s), ${root.runtime_contract.data_next.unique_attributes.length} unique attribute(s)`);
    lines.push(`- Package refs: ${root.runtime_contract.package_refs.count}; shipping refs: ${root.runtime_contract.shipping_refs.count}`);
    lines.push(`- Source manifest: ${root.runtime_contract.source_html_manifest.present ? "present" : "missing"}`);
    lines.push("");
    lines.push("### Built Output");
    lines.push(`- Built pages: ${root.built_output.html_count || 0}`);
    lines.push(`- Doctor: ${root.built_output.doctor.status || "not_run"}${root.built_output.doctor.reason ? ` (${root.built_output.doctor.reason})` : ""}`);
    if (root.findings.length) {
      lines.push("");
      lines.push("### Findings");
      for (const item of root.findings) {
        lines.push(`- [${item.severity}] ${item.code}: ${item.message}`);
      }
    }
    lines.push("");
    lines.push("### Remediation");
    appendList(lines, "Safe agent repairs", root.remediation.safe_agent_repairs);
    appendList(lines, "Clarification needed", root.remediation.clarification_needed);
    appendList(lines, "Product or merchant risks", root.remediation.product_or_merchant_risks);
    appendList(lines, "Proof commands", root.remediation.proof_commands);
  }

  return `${lines.join("\n")}\n`;
}

function appendCampaignCartAppMarkdown(lines, root) {
  const rootLabel = root.identity.campaign_root_relative === "."
    ? `${root.identity.repo} (repo root)`
    : root.identity.campaign_root_relative;
  lines.push("");
  lines.push(`## ${rootLabel || root.identity.campaign_root}`);
  lines.push("");
  lines.push("### Identity");
  lines.push(`- Status: ${String(root.status || "unknown").toUpperCase()}`);
  lines.push(`- Implementation: ${root.implementation.kind}`);
  lines.push(`- Frameworks: ${root.implementation.frameworks.join(", ") || "(none detected)"}`);
  lines.push(`- Campaign ID(s): ${root.identity.campaign_ids.join(", ") || "(unknown)"}`);
  lines.push(`- SDK loader version(s): ${root.identity.sdk_versions.join(", ") || "(undiscovered)"}`);
  lines.push(`- Version policy: min ${root.version_policy.minimum_supported || "(none)"}, preferred ${root.version_policy.preferred_minimum || "(none)"} (${root.version_policy.source})`);
  lines.push(`- Campaigns OS artifacts: ${root.identity.has_campaign_runtime ? "yes" : "no"}`);
  lines.push("");
  lines.push("### Checkout Fields");
  lines.push(`- Bindings: ${root.checkout_fields.bindings.length}; unsupported stale aliases: ${root.checkout_fields.unsupported.length}; unknown: ${root.checkout_fields.unknown.length}`);
  for (const entry of root.checkout_fields.unsupported.slice(0, 8)) {
    lines.push(`- Stale alias \`${entry.value}\` -> \`${entry.canonical}\` (${entry.path}:${entry.line})`);
  }
  lines.push("");
  lines.push("### Payment Interaction");
  lines.push(`- SDK payment_method radios: ${root.payment.sdk_method_radios.detected ? "detected" : "not detected"}; hidden radios: ${root.payment.hidden_radios.detected ? "yes" : "no"}; custom triggers: ${root.payment.custom_triggers.detected ? "yes" : "no"}`);
  lines.push(`- Synchronization script: ${root.payment.synchronization_script.detected ? "detected" : "not detected"}; proof state: ${root.payment.proof_state}`);
  lines.push("");
  lines.push("### Runtime Contract");
  lines.push(`- data-next anchors: ${root.runtime_contract.data_next.total_occurrences} occurrence(s), ${root.runtime_contract.data_next.unique_attributes.length} unique attribute(s)`);
  if (root.findings.length) {
    lines.push("");
    lines.push("### Findings");
    for (const item of root.findings) {
      const confidence = item.confidence ? ` (confidence: ${item.confidence})` : "";
      lines.push(`- [${item.severity}] ${item.code}: ${item.message}${confidence}`);
    }
  }
  lines.push("");
  lines.push("### Remediation");
  appendList(lines, "Safe agent repairs", root.remediation.safe_agent_repairs);
  appendList(lines, "Clarification needed", root.remediation.clarification_needed);
  appendList(lines, "Product or merchant risks", root.remediation.product_or_merchant_risks);
  appendList(lines, "Proof commands", root.remediation.proof_commands);
}

export function discoverPageKitRoots(targetRepo) {
  const target = resolve(targetRepo);
  if (!existsSync(target) || !statSync(target).isDirectory()) return [];
  const roots = [];
  const seen = new Set();

  function addRoot(dir) {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  }

  if (isPageKitRoot(target)) {
    addRoot(target);
    return roots;
  }

  function walk(dir, depth) {
    if (depth > 4) return;
    for (const entry of safeReadDir(dir)) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(entry.name)) continue;
      const child = join(dir, entry.name);
      if (isPageKitRoot(child)) {
        addRoot(child);
        continue;
      }
      walk(child, depth + 1);
    }
  }

  walk(target, 1);
  return roots.sort();
}

function scanPageKitRoot({
  targetRepo,
  rootPath,
  requestedSlug = null,
  explicitTemplateFamily = null,
}) {
  const files = listFiles(rootPath);
  const structureFiles = files.filter((file) => STRUCTURE_EXTENSIONS.has(extname(file).toLowerCase()));
  const sourceFiles = files.filter((file) => TEXT_EXTENSIONS.has(extname(file).toLowerCase()));
  const campaigns = readCampaigns(rootPath);
  const packageInfo = readPackageInfo(rootPath);
  const runtime = readRuntimeArtifacts(rootPath, targetRepo, files);
  const sourceScan = scanSourceFiles(rootPath, structureFiles, sourceFiles, campaigns.slugs);
  const templateFamily = inferTemplateFamily({
    explicitTemplateFamily,
    runtime,
    files,
    rootPath,
  });
  const builtOutput = inspectBuiltOutput(rootPath, requestedSlug);
  const root = {
    id: rootId(targetRepo, rootPath),
    status: "unknown",
    ok: false,
    implementation: {
      kind: "page_kit",
      evidence: pageKitImplementationEvidence(rootPath, packageInfo),
      frameworks: detectFrameworks(rootPath),
    },
    capabilities: [
      "page_kit_source_contract",
      "sdk_version_policy",
      "built_output_doctor",
      "campaign_cart_runtime_inventory",
    ],
    identity: {
      repo: basename(targetRepo),
      target_repo: targetRepo,
      page_kit_root: rootPath,
      page_kit_root_relative: relPath(targetRepo, rootPath),
      campaign_slug: requestedSlug || (campaigns.slugs.length === 1 ? campaigns.slugs[0].slug : null),
      campaign_slugs: campaigns.slugs,
      sdk_versions: unique(campaigns.slugs.map((entry) => entry.sdk_version).filter(Boolean)),
      page_kit_dependency: packageInfo.page_kit_dependency,
      template_family: templateFamily,
      has_campaign_runtime: runtime.present,
      has_built_site: builtOutput.present,
    },
    source_structure: sourceScan.source_structure,
    runtime_contract: {
      data_next: sourceScan.runtime_contract.data_next,
      checkout_surface: sourceScan.runtime_contract.checkout_surface,
      upsell_surface: sourceScan.runtime_contract.upsell_surface,
      receipt_surface: sourceScan.runtime_contract.receipt_surface,
      package_refs: sourceScan.runtime_contract.package_refs,
      shipping_refs: sourceScan.runtime_contract.shipping_refs,
      campaign_runtime: runtime.summary,
      source_html_manifest: runtime.source_html_manifest,
    },
    built_output: builtOutput,
    findings: [
      ...campaigns.findings,
      ...packageInfo.findings,
      ...sourceScan.findings,
      ...runtime.findings,
      ...builtOutput.findings,
    ],
    remediation: {
      safe_agent_repairs: [],
      clarification_needed: [],
      product_or_merchant_risks: [],
      proof_commands: [],
    },
  };
  addVersionFindings(root);
  addTemplateFamilyFindings(root);
  finalizeRoot(root);
  return root;
}

function finalizeReport(report) {
  const rootCounts = { blockers: 0, warnings: 0, operator_readiness: 0 };
  for (const root of report.roots || []) {
    for (const item of root.findings || []) {
      if (item.severity === "blocker") rootCounts.blockers += 1;
      else if (item.severity === "warning") rootCounts.warnings += 1;
      else if (item.severity === "operator_readiness") rootCounts.operator_readiness += 1;
    }
  }
  const hasBlockingError = Boolean(report.errors?.length);
  report.summary = {
    root_count: report.roots?.length || 0,
    blockers: rootCounts.blockers + (hasBlockingError ? report.errors.length : 0),
    warnings: rootCounts.warnings,
    operator_readiness: rootCounts.operator_readiness,
    blocked_roots: (report.roots || []).filter((root) => root.status === "blocked").length,
    warning_roots: (report.roots || []).filter((root) => root.status === "ready_with_warnings").length,
    ready_roots: (report.roots || []).filter((root) => root.status === "ready").length,
  };
  report.status = report.summary.blockers > 0
    ? "blocked"
    : report.summary.warnings || report.summary.operator_readiness
      ? "ready_with_warnings"
      : "ready";
  report.ok = report.status !== "blocked";
}

function finalizeRoot(root) {
  dedupeFindings(root);
  if (root.implementation?.kind !== "campaign_cart_app") {
    root.remediation = buildRemediation(root);
  }
  if (root.findings.some((item) => item.severity === "blocker")) {
    root.status = "blocked";
  } else if (root.findings.some((item) => item.severity === "warning" || item.severity === "operator_readiness")) {
    root.status = "ready_with_warnings";
  } else {
    root.status = "ready";
  }
  root.ok = root.status !== "blocked";
}

function pageKitImplementationEvidence(rootPath, packageInfo) {
  const evidence = [];
  if (existsSync(join(rootPath, "_data", "campaigns.json"))) {
    evidence.push({ signal: "campaigns_json", strength: "strong", path: "_data/campaigns.json", detail: null });
  }
  if (packageInfo.page_kit_dependency) {
    evidence.push({
      signal: "page_kit_dependency",
      strength: "strong",
      path: "package.json",
      detail: `${packageInfo.page_kit_dependency.name}@${packageInfo.page_kit_dependency.version}`,
    });
  }
  return evidence;
}

function isPageKitRoot(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  if (existsSync(join(dir, "_data", "campaigns.json"))) return true;
  const pkg = readJsonFile(join(dir, "package.json"));
  if (!pkg.ok) return false;
  return Boolean(findPageKitDependency(pkg.value));
}

function readCampaigns(rootPath) {
  const campaignsPath = join(rootPath, "_data", "campaigns.json");
  if (!existsSync(campaignsPath)) {
    return {
      slugs: [],
      findings: [finding({
        severity: "blocker",
        category: "standardization_blocker",
        code: "page_kit.campaigns_json_missing",
        message: "Missing _data/campaigns.json; campaign slug and SDK version cannot be confirmed.",
        next_action: "Add or restore _data/campaigns.json before treating this as a modern CPK root.",
      })],
    };
  }
  const parsed = readJsonFile(campaignsPath);
  if (!parsed.ok || !isObject(parsed.value)) {
    return {
      slugs: [],
      findings: [finding({
        severity: "blocker",
        category: "standardization_blocker",
        code: "page_kit.campaigns_json_invalid",
        message: `Could not parse _data/campaigns.json: ${parsed.error}`,
        next_action: "Fix campaigns.json before running version or slug checks.",
      })],
    };
  }
  const slugs = Object.entries(parsed.value).map(([slug, entry]) => ({
    slug,
    name: normalizeString(entry?.name),
    sdk_version: normalizeString(entry?.sdk_version),
    store_url: normalizeString(entry?.store_url),
  }));
  return { slugs, findings: [] };
}

function readPackageInfo(rootPath) {
  const packagePath = join(rootPath, "package.json");
  if (!existsSync(packagePath)) {
    return {
      page_kit_dependency: null,
      findings: [finding({
        severity: "warning",
        category: "standardization_warning",
        code: "page_kit.package_json_missing",
        message: "Missing package.json; Page Kit dependency version cannot be confirmed.",
        next_action: "Restore package.json or identify the Page Kit build command source.",
      })],
    };
  }
  const parsed = readJsonFile(packagePath);
  if (!parsed.ok) {
    return {
      page_kit_dependency: null,
      findings: [finding({
        severity: "warning",
        category: "standardization_warning",
        code: "page_kit.package_json_invalid",
        message: `Could not parse package.json: ${parsed.error}`,
        next_action: "Fix package.json before checking Page Kit dependency drift.",
      })],
    };
  }
  const dep = findPageKitDependency(parsed.value);
  return {
    page_kit_dependency: dep,
    findings: dep ? [] : [finding({
      severity: "warning",
      category: "standardization_warning",
      code: "page_kit.dependency_missing",
      message: "No next-campaign-page-kit dependency was found in package.json.",
      next_action: "Confirm whether this root is built by Page Kit or another wrapper.",
    })],
  };
}

function findPageKitDependency(pkg) {
  const deps = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  };
  for (const name of PAGE_KIT_PACKAGE_NAMES) {
    if (typeof deps[name] === "string") return { name, version: deps[name] };
  }
  return null;
}

function readRuntimeArtifacts(rootPath, targetRepo, rootFiles = []) {
  const runtimeDirs = unique([join(rootPath, ".campaign-runtime"), join(targetRepo, ".campaign-runtime")]);
  const artifactFiles = [];
  for (const dir of runtimeDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    artifactFiles.push(...listFiles(dir, { includeRuntime: true }).map((file) => ({
      path: file,
      relative_path: relPath(rootPath, file),
    })));
  }
  const sourceManifestFiles = [
    ...rootFiles.filter((file) => file.endsWith(".campaigns-os/source-html-manifest.json")),
    ...runtimeDirs.flatMap((dir) => listFiles(dir, { includeRuntime: true })
      .filter((file) => file.endsWith("source-html-manifest.json"))),
  ];
  const present = artifactFiles.length > 0;
  const findings = [];
  if (!present) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "campaigns_os.artifacts_missing",
      message: "No .campaign-runtime artifacts were found for this root.",
      next_action: "Generate or attach Campaigns OS build context before treating runtime provenance as confirmed.",
    }));
  }
  if (!sourceManifestFiles.length) {
    findings.push(finding({
      severity: "operator_readiness",
      category: "operator_readiness",
      code: "campaigns_os.source_manifest_missing",
      message: "No source-html manifest was found; Figma/source producer provenance is not confirmed.",
      next_action: "Attach .campaigns-os/source-html-manifest.json when source producer proof matters.",
    }));
  }
  return {
    present,
    artifactFiles,
    source_html_manifest: {
      present: sourceManifestFiles.length > 0,
      paths: sourceManifestFiles.map((file) => relPath(rootPath, file)),
    },
    summary: {
      present,
      artifact_count: artifactFiles.length,
      artifacts: artifactFiles.slice(0, 40).map((file) => file.relative_path),
    },
    findings,
  };
}

function scanSourceFiles(rootPath, structureFiles, sourceFiles, slugs) {
  const findings = [];
  const helperCounts = {
    campaign_asset: 0,
    campaign_include: 0,
    campaign_link: 0,
  };
  const rawBlocks = [];
  const hardcodedAssets = [];
  const unreadableFiles = [];
  const documentWrappers = [];
  const paymentMethodFiles = [];
  const dataNextCounts = new Map();
  const checkoutFiles = new Set();
  const upsellFiles = new Set();
  const receiptFiles = new Set();
  const packageRefs = [];
  const shippingRefs = [];

  const includeFiles = structureFiles.filter((file) => relPath(rootPath, file).includes("/_includes/"));
  const layoutFiles = structureFiles.filter((file) => relPath(rootPath, file).includes("/_layouts/"));
  const pageFiles = structureFiles.filter((file) => {
    const rel = relPath(rootPath, file);
    return !rel.includes("/_includes/") && !rel.includes("/_layouts/") && !rel.includes("/assets/");
  });

  for (const file of sourceFiles) {
    const rel = relPath(rootPath, file);
    const readResult = safeReadText(file);
    if (!readResult.ok) {
      unreadableFiles.push({
        path: rel,
        line: 1,
        match: readResult.error,
      });
      continue;
    }
    const content = readResult.value;
    if (STRUCTURE_EXTENSIONS.has(extname(file).toLowerCase())) {
      helperCounts.campaign_asset += countLiteral(content, "campaign_asset");
      helperCounts.campaign_include += countLiteral(content, "campaign_include");
      helperCounts.campaign_link += countLiteral(content, "campaign_link");
      collectPatternSamples(rawBlocks, rootPath, file, content, RAW_BLOCK_PATTERN);
      collectHardcodedAssetSamples(hardcodedAssets, rootPath, file, content, slugs);
      if (isPaymentMethodsInclude(file, content)) {
        paymentMethodFiles.push(rel);
      }
      const documentWrapperIndex = pageFiles.includes(file) ? documentWrapperMatchIndex(content) : -1;
      if (documentWrapperIndex >= 0) {
        documentWrappers.push(sample(rootPath, file, content, documentWrapperIndex, "document wrapper"));
      }
      if (/checkout/i.test(rel) || /data-next-checkout|data-next-action=["'](?:create-order|add-to-cart)/i.test(content)) {
        checkoutFiles.add(rel);
      }
      if (/upsell/i.test(rel) || /data-next-upsell/i.test(content)) {
        upsellFiles.add(rel);
      }
      if (/receipt|thank/i.test(rel) || /\bdata-next-(?:order|receipt)[a-zA-Z0-9_-]*/i.test(content)) {
        receiptFiles.add(rel);
      }
      collectDataNextAttributes(dataNextCounts, content);
      collectPatternSamples(packageRefs, rootPath, file, content, /(?:\bpackageId\b|\bpackage_id\b|\bdata-next-package-id\b|\bdata-next-display=["']package\.[^"']+["'])/g);
      collectPatternSamples(shippingRefs, rootPath, file, content, /(?:shippingId|shipping_id|data-next-shipping-id|shipping\.)/g);
    } else {
      collectDataNextAttributes(dataNextCounts, content);
    }
  }

  if (unreadableFiles.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "source.file_unreadable",
      message: `${unreadableFiles.length} source file(s) could not be read; skipped files may hide standardization issues.`,
      evidence: unreadableFiles.slice(0, MAX_SAMPLE_COUNT),
      next_action: "Fix file permissions or remove unreadable source artifacts, then rerun the standardization report.",
    }));
  }
  if (rawBlocks.length) {
    findings.push(finding({
      severity: "blocker",
      category: "standardization_blocker",
      code: "source.raw_block",
      message: `${rawBlocks.length} Liquid raw block(s) found; raw blocks can suppress Page Kit helpers and runtime Liquid.`,
      evidence: rawBlocks.slice(0, MAX_SAMPLE_COUNT),
      next_action: "Remove raw blocks and preserve only the page-owned HTML that should bypass Liquid.",
    }));
  }
  if (hardcodedAssets.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "source.hardcoded_root_assets",
      message: `${hardcodedAssets.length} hardcoded /assets or /<slug>/assets reference(s) found in source.`,
      evidence: hardcodedAssets.slice(0, MAX_SAMPLE_COUNT),
      next_action: "Rewrite portable local assets through the campaign_asset helper.",
    }));
  }
  if (documentWrappers.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "source.document_wrappers",
      message: `${documentWrappers.length} page file(s) still contain document wrappers.`,
      evidence: documentWrappers.slice(0, MAX_SAMPLE_COUNT),
      next_action: "Move document-level markup into layouts and keep page files body-owned.",
    }));
  }
  if (!paymentMethodFiles.length) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "source.payment_methods_include_not_detected",
      message: "No payment-methods include was detected; this is tentative because some template families inline or rename the surface.",
      next_action: "Confirm the template family before treating this as a repair task.",
    }));
  }
  if (!helperCounts.campaign_asset) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "source.campaign_asset_missing",
      message: "No campaign_asset helper usage was detected.",
      next_action: "Confirm asset references are portable through Page Kit before standardizing this repo.",
    }));
  }
  if (sumMap(dataNextCounts) === 0) {
    findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "runtime.data_next_missing",
      message: "No data-next-* runtime anchors were detected in source.",
      next_action: "Confirm whether this campaign contains SDK-owned checkout, upsell, or receipt surfaces.",
    }));
  }

  return {
    source_structure: {
      html_file_count: structureFiles.length,
      page_file_count: pageFiles.length,
      include_file_count: includeFiles.length,
      layout_file_count: layoutFiles.length,
      helper_counts: helperCounts,
      raw_blocks: { count: rawBlocks.length, samples: rawBlocks.slice(0, MAX_SAMPLE_COUNT) },
      hardcoded_root_assets: { count: hardcodedAssets.length, samples: hardcodedAssets.slice(0, MAX_SAMPLE_COUNT) },
      unreadable_files: { count: unreadableFiles.length, samples: unreadableFiles.slice(0, MAX_SAMPLE_COUNT) },
      document_wrappers: { count: documentWrappers.length, samples: documentWrappers.slice(0, MAX_SAMPLE_COUNT) },
      payment_methods_include: {
        detected: paymentMethodFiles.length > 0,
        paths: unique(paymentMethodFiles).slice(0, MAX_SAMPLE_COUNT),
      },
    },
    runtime_contract: {
      data_next: summarizeDataNext(dataNextCounts),
      checkout_surface: { detected: checkoutFiles.size > 0, files: [...checkoutFiles].slice(0, MAX_SAMPLE_COUNT) },
      upsell_surface: { detected: upsellFiles.size > 0, files: [...upsellFiles].slice(0, MAX_SAMPLE_COUNT) },
      receipt_surface: { detected: receiptFiles.size > 0, files: [...receiptFiles].slice(0, MAX_SAMPLE_COUNT) },
      package_refs: { count: packageRefs.length, samples: packageRefs.slice(0, MAX_SAMPLE_COUNT) },
      shipping_refs: { count: shippingRefs.length, samples: shippingRefs.slice(0, MAX_SAMPLE_COUNT) },
    },
    findings,
  };
}

function inspectBuiltOutput(rootPath, requestedSlug) {
  const siteRoot = join(rootPath, "_site");
  if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
    return {
      present: false,
      scope_resolved: false,
      site_root: siteRoot,
      slug: requestedSlug || null,
      html_count: 0,
      pages: [],
      doctor: { status: "skipped", reason: "no built _site found" },
      findings: [finding({
        severity: "operator_readiness",
        category: "operator_readiness",
        code: "built_output.site_missing",
        message: "No built _site directory was found; built-output doctor was skipped.",
        next_action: "Run the Page Kit build in an isolated worktree when deeper proof is needed.",
      })],
    };
  }
  const scope = resolveBuiltSiteScope(rootPath, { slug: requestedSlug || null });
  if (!scope.ok) {
    return {
      present: true,
      scope_resolved: false,
      site_root: siteRoot,
      slug: requestedSlug || null,
      html_count: 0,
      pages: [],
      slug_candidates: scope.slug_candidates || [],
      doctor: { status: "skipped", reason: scope.error || "built scope could not be resolved" },
      findings: [finding({
        severity: "operator_readiness",
        category: "operator_readiness",
        code: "built_output.scope_unresolved",
        message: scope.error || "Built output exists but scope could not be resolved.",
        evidence: scope.slug_candidates?.length ? { slug_candidates: scope.slug_candidates } : null,
        next_action: "Pass --slug when a repo has multiple built campaign outputs.",
      })],
    };
  }
  return {
    present: true,
    scope_resolved: true,
    site_root: scope.site_root,
    slug: scope.slug || null,
    html_count: scope.html_count,
    pages: scope.pages.map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
    doctor: { status: "not_run", reason: "doctor not attached yet" },
    findings: [],
  };
}

function addVersionFindings(root) {
  for (const version of root.identity.sdk_versions) {
    if (compareVersions(version, PREFERRED_SDK_MIN) < 0) {
      root.findings.push(finding({
        severity: "warning",
        category: "standardization_warning",
        code: "version.sdk_below_preferred_cutoff",
        message: `Campaign Cart SDK ${version} is below the preferred ${PREFERRED_SDK_MIN}+ sample cutoff.`,
        next_action: "Confirm whether the campaign intentionally pins the SDK before recommending an upgrade.",
      }));
    }
  }
  const depVersion = root.identity.page_kit_dependency?.version;
  if (extractVersion(depVersion) && compareVersions(depVersion, PREFERRED_PAGE_KIT_MIN) < 0) {
    root.findings.push(finding({
      severity: "warning",
      category: "standardization_warning",
      code: "version.page_kit_below_preferred_cutoff",
      message: `Page Kit dependency ${root.identity.page_kit_dependency.version} is below the preferred ${PREFERRED_PAGE_KIT_MIN}+ sample cutoff.`,
      next_action: "Check migration notes before bumping next-campaign-page-kit.",
    }));
  }
}

function addTemplateFamilyFindings(root) {
  if (!root.identity.template_family.value) {
    root.findings.push(finding({
      severity: "operator_readiness",
      category: "operator_readiness",
      code: "template_family.unknown",
      message: "Template family is unknown; family-specific source and built-output checks remain tentative.",
      next_action: "Rerun with --family <template-family> or attach Campaigns OS assembly artifacts.",
    }));
  } else if (root.identity.template_family.confidence === "tentative") {
    root.findings.push(finding({
      severity: "operator_readiness",
      category: "operator_readiness",
      code: "template_family.tentative",
      message: `Template family inferred as ${root.identity.template_family.value}, but only from source hints.`,
      next_action: "Confirm the family against CampaignSpec or .campaign-runtime before treating family-specific findings as blockers.",
    }));
  }
}

function buildRemediation(root) {
  const safe = [];
  const clarification = [];
  const risks = [];
  for (const item of root.findings) {
    if (item.code === "source.hardcoded_root_assets") safe.push("Rewrite hardcoded /assets refs through campaign_asset.");
    if (item.code === "source.document_wrappers") safe.push("Move page-level document wrappers into layouts.");
    if (item.code === "source.raw_block") safe.push("Remove Liquid raw blocks while preserving intended page-owned markup.");
    if (item.code === "built_doctor.template_contract.literal_residue") safe.push("Remove generic starter/template residue from built source assets and pages.");
    if (item.code === "template_family.unknown" || item.code === "template_family.tentative") clarification.push("Confirm the template family from CampaignSpec or Campaigns OS artifacts.");
    if (item.code === "source.payment_methods_include_not_detected") clarification.push("Confirm whether the template family expects payment-methods.html or an equivalent include.");
    if (item.code === "campaigns_os.source_manifest_missing") clarification.push("Find CampaignSpec/Map ID or source-html manifest before relying on provenance.");
    if (item.code.startsWith("version.")) risks.push("Version bumps can affect SDK/Page Kit runtime behavior; confirm against campaign QA scope before changing.");
  }
  if (!root.identity.campaign_slugs.some((entry) => entry.store_url)) {
    risks.push("Production storefront/deploy URL is unknown.");
  }
  const proof = [
    `campaigns-os standardize --target ${shellQuote(root.identity.page_kit_root)} --json`,
  ];
  const family = root.identity.template_family.value;
  const familyConfirmed = family && root.identity.template_family.confidence !== "tentative";
  if (root.built_output.present && familyConfirmed) {
    const slugFlag = root.built_output.slug ? ` --slug ${shellQuote(root.built_output.slug)}` : "";
    proof.push(`campaigns-os doctor --built ${shellQuote(root.identity.page_kit_root)} --family ${shellQuote(family)}${slugFlag} --json`);
  } else if (root.built_output.present) {
    proof.push(`campaigns-os doctor --built ${shellQuote(root.identity.page_kit_root)} --family <template-family> --json`);
  }
  return {
    safe_agent_repairs: unique(safe),
    clarification_needed: unique(clarification),
    product_or_merchant_risks: unique(risks),
    proof_commands: proof,
  };
}

function inferTemplateFamily({ explicitTemplateFamily, runtime, files, rootPath }) {
  if (explicitTemplateFamily) {
    return { value: explicitTemplateFamily, source: "operator_flag", confidence: "explicit" };
  }
  const runtimeCandidates = [];
  for (const artifact of runtime.artifactFiles || []) {
    if (!artifact.path.endsWith(".json")) continue;
    const parsed = readJsonFile(artifact.path);
    if (!parsed.ok) continue;
    const value = firstStringAt(parsed.value, [
      ["template", "value"],
      ["template_family", "value"],
      ["assembly", "template_family"],
      ["template_family"],
      ["campaign", "template_family"],
      ["spec", "preferred_template_family"],
    ]);
    if (value) runtimeCandidates.push({ value, path: relPath(rootPath, artifact.path) });
  }
  if (runtimeCandidates.length) {
    return { value: runtimeCandidates[0].value, source: runtimeCandidates[0].path, confidence: "artifact" };
  }
  const sourceHint = inferTemplateFamilyFromPaths(files, rootPath);
  if (sourceHint) {
    return { value: sourceHint, source: "source_path_hint", confidence: "tentative" };
  }
  return { value: null, source: null, confidence: "unknown" };
}

function inferTemplateFamilyFromPaths(files, rootPath) {
  const tokenSets = files
    .map((file) => relPath(rootPath, file).toLowerCase())
    .filter((rel) => !rel.includes("/assets/"))
    .map((rel) => rel.split("/").flatMap(componentTokens));
  if (tokenSets.some((tokens) => hasTokenSequence(tokens, ["olympus", "mv"]) || hasTokenSequence(tokens, ["upsell", "mv"]))) return "olympus-mv-single-step";
  if (tokenSets.some((tokens) => hasTokenSequence(tokens, ["shop", "three", "step"]))) return "shop-three-step";
  if (tokenSets.some((tokens) => hasTokenSequence(tokens, ["shop", "single", "step"]))) return "shop-single-step";
  if (tokenSets.some((tokens) => tokens.includes("olympus"))) return "olympus";
  if (tokenSets.some((tokens) => tokens.includes("apollo"))) return "apollo";
  return null;
}

function summarizeDoctorResult(result) {
  if (!result) return { status: "not_run", reason: "doctor did not return a result" };
  return {
    status: result.status || (result.ok ? "ready" : "blocked"),
    ok: Boolean(result.ok),
    mode: result.mode || null,
    error_count: result.errors?.length || 0,
    warning_count: result.warnings?.length || 0,
    ready_count: result.ready?.length || 0,
    errors: (result.errors || []).map(summarizeIssue),
    warnings: (result.warnings || []).map(summarizeIssue),
    ready: (result.ready || []).slice(0, 12),
  };
}

function summarizeIssue(issue) {
  if (typeof issue === "string") return { message: issue };
  return {
    code: issue?.code || null,
    message: issue?.message || String(issue),
  };
}

function collectDataNextAttributes(counts, content) {
  for (const match of content.matchAll(/\bdata-next-[a-zA-Z0-9_-]+/g)) {
    const attr = match[0];
    counts.set(attr, (counts.get(attr) || 0) + 1);
  }
}

function summarizeDataNext(counts) {
  const attrs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total_occurrences: sumMap(counts),
    unique_attributes: attrs.map(([name]) => name),
    top_attributes: attrs.slice(0, 12).map(([name, count]) => ({ name, count })),
  };
}

function formatBuiltSiteState(root) {
  if (!root.identity.has_built_site) return "no";
  return root.built_output?.scope_resolved === false ? "unresolved" : "yes";
}

function isPaymentMethodsInclude(file, content) {
  if (basename(file) === "payment-methods.html") return true;
  return /{%\s*(?:campaign_)?include\s+["'][^"']*payment-methods(?:\.html)?["']/i.test(content);
}

function documentWrapperMatchIndex(content) {
  const masked = maskHtmlAndLiquidComments(content);
  const head = masked.slice(0, 4096);
  const htmlMatch = head.search(/<\s*html\b/i);
  if (htmlMatch >= 0) return htmlMatch;
  const bodyMatch = head.search(/<\s*body\b/i);
  if (bodyMatch >= 0 && /<\/\s*(?:body|html)\s*>/i.test(masked)) return bodyMatch;
  return -1;
}

function maskHtmlAndLiquidComments(content) {
  return String(content || "")
    .replace(/<!--[\s\S]*?-->/g, maskIgnoredRegion)
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/gi, maskIgnoredRegion);
}

function maskScriptsAndComments(content) {
  return maskHtmlAndLiquidComments(content)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (_match, open, body, close) =>
      `${open}${maskIgnoredRegion(body)}${close}`
    );
}

function maskIgnoredRegion(value) {
  return String(value).replace(/[^\r\n]/g, " ");
}

function componentTokens(component) {
  return component
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function hasTokenSequence(tokens, sequence) {
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}

function collectHardcodedAssetSamples(out, rootPath, file, content, slugs) {
  const searchable = maskScriptsAndComments(content);
  collectPatternSamples(out, rootPath, file, content, HARDCODED_ROOT_ASSET_ATTR_PATTERN, searchable);
  collectPatternSamples(out, rootPath, file, content, HARDCODED_ROOT_ASSET_URL_PATTERN, searchable);
  for (const entry of slugs || []) {
    const slug = escapeRegExp(entry.slug);
    if (!slug) continue;
    collectPatternSamples(out, rootPath, file, content, new RegExp(`\\b(?:src|href)\\s*=\\s*(["'])/${slug}/assets/[^"']*\\1`, "g"), searchable);
    collectPatternSamples(out, rootPath, file, content, new RegExp(`\\burl\\(\\s*(["']?)/${slug}/assets/[^)"']*\\1\\s*\\)`, "g"), searchable);
  }
}

function collectPatternSamples(out, rootPath, file, content, pattern, searchableContent = content) {
  const globalPattern = withGlobalFlag(pattern);
  globalPattern.lastIndex = 0;
  for (const match of String(searchableContent).matchAll(globalPattern)) {
    const index = match.index || 0;
    out.push(sample(rootPath, file, content, index, String(content).slice(index, index + match[0].length)));
  }
}

function sample(rootPath, file, content, index, match) {
  const before = content.slice(0, Math.max(0, index));
  return {
    path: relPath(rootPath, file),
    line: before.split(/\r?\n/).length,
    match,
  };
}

function listFiles(root, options = {}) {
  const includeRuntime = options.includeRuntime === true;
  const files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return files;
  function walk(dir) {
    for (const entry of safeReadDir(dir)) {
      if (entry.isDirectory()) {
        if (!includeRuntime && shouldSkipDir(entry.name)) continue;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  }
  walk(root);
  return files.sort();
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".campaigns-os");
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadText(path) {
  try {
    return { ok: true, value: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function builtDoctorFindingCode(issue, fallback, index) {
  const code = normalizeString(issue?.code);
  return `built_doctor.${code || `${fallback}.${index + 1}`}`;
}

function withGlobalFlag(pattern) {
  if (!(pattern instanceof RegExp)) return new RegExp(String(pattern), "g");
  if (pattern.flags.includes("g")) return pattern;
  return new RegExp(pattern.source, `${pattern.flags}g`);
}

function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function countLiteral(content, needle) {
  return content.split(needle).length - 1;
}

function finding({ severity, category, code, message, evidence = null, next_action = null }) {
  return {
    severity,
    category,
    code,
    message,
    evidence,
    next_action,
  };
}

function dedupeFindings(root) {
  const seen = new Set();
  root.findings = root.findings.filter((item) => {
    const key = `${item.severity}:${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareVersions(a, b) {
  const left = extractVersion(a);
  const right = extractVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function extractVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function firstStringAt(object, paths) {
  for (const path of paths) {
    let cursor = object;
    for (const part of path) cursor = cursor?.[part];
    const value = normalizeString(cursor);
    if (value) return value;
  }
  return null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function relPath(from, to) {
  const rel = relative(resolve(from), resolve(to)).split(sep).join("/");
  return rel || ".";
}

function rootId(targetRepo, rootPath) {
  return relPath(targetRepo, rootPath).replace(/[^A-Za-z0-9_.-]+/g, "-") || ".";
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function sumMap(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appendList(lines, label, items) {
  lines.push(`${label}:`);
  if (!items?.length) {
    lines.push("- none");
    return;
  }
  for (const item of items) lines.push(`- ${item}`);
}

function shellQuote(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
