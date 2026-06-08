import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const ADAPTER_DECISION_REQUIRED_FIELDS = Object.freeze([
  "raw_html_conversion_status",
  "source_asset_strategy",
  "commerce_shell_adoption",
  "route_rewrite_policy",
  "template_files_copied",
  "config_script_strategy",
  "wrapper_policy",
  "frontmatter_policy",
  "script_style_reference_policy",
  "cta_rewrite_policy",
  "layout_choice",
]);

export const ADAPTER_DECISION_STRATEGY_FIELDS = Object.freeze([
  "raw_html_conversion_status",
  "source_asset_strategy",
  "route_rewrite_policy",
  "config_script_strategy",
  "commerce_shell_adoption",
  "wrapper_policy",
  "frontmatter_policy",
  "script_style_reference_policy",
  "cta_rewrite_policy",
  "layout_choice",
]);

export const TEMPLATE_SLICE_REQUIRED_GROUPS = Object.freeze([
  "pages",
  "_includes",
  "_layouts",
  "assets/css",
  "assets/js",
  "frontmatter_vocabulary",
]);

const TEMPLATE_FILES_COPIED_REQUIRED_FIELDS = Object.freeze(["status", "required_groups", "groups", "paths"]);
const RUNTIME_PAGE_TYPES = new Set(["checkout", "select", "upsell", "downsell", "thankyou", "receipt"]);
const RAW_HTML_CONVERSION_STATUSES = new Set(["pending", "in_progress", "completed", "not_required", "blocked"]);
const SOURCE_ASSET_STRATEGIES = new Set(["pagekit_campaign_asset_root", "external_cdn", "raw_passthrough", "not_applicable", "unknown"]);
const ROUTE_REWRITE_POLICIES = new Set(["campaignspec_routes_via_campaign_link", "pagekit_public_routes", "raw_passthrough", "not_applicable", "unknown"]);
const CONFIG_SCRIPT_STRATEGIES = new Set(["campaign_asset", "frontmatter_script", "inline", "not_required", "unknown"]);
const COMMERCE_SHELL_ADOPTIONS = new Set(["not_required", "template_clone_first_required", "template_clone_first_verified", "sdk_surfaces_preserved", "custom_html_experimental"]);
const TEMPLATE_FILES_COPIED_STATUSES = new Set(["pending", "complete", "verified_existing_slice", "partial", "not_applicable"]);
const WRAPPER_POLICIES = new Set(["strip_document_wrappers", "preserve_document_wrappers", "not_required", "unknown"]);
const FRONTMATTER_POLICIES = new Set(["pagekit_yaml_frontmatter", "raw_passthrough", "not_required", "unknown"]);
const SCRIPT_STYLE_REFERENCE_POLICIES = new Set(["frontmatter_or_campaign_asset", "frontmatter", "campaign_asset", "inline", "raw_passthrough", "not_required", "unknown"]);
const CTA_REWRITE_POLICIES = ROUTE_REWRITE_POLICIES;
const LAYOUT_CHOICES = new Set(["campaign_layout", "page_layout", "raw_passthrough", "not_applicable", "unknown"]);

export function createAdapterDecisions({ commerceZoneFindings = [] } = {}) {
  const shellRequired = commerceZoneFindings.some((finding) => finding?.requires_template_shell === true);
  return {
    raw_html_conversion_status: "pending",
    source_asset_strategy: "pagekit_campaign_asset_root",
    route_rewrite_policy: "campaignspec_routes_via_campaign_link",
    config_script_strategy: "campaign_asset",
    commerce_shell_adoption: shellRequired ? "template_clone_first_required" : "not_required",
    wrapper_policy: "strip_document_wrappers",
    frontmatter_policy: "pagekit_yaml_frontmatter",
    script_style_reference_policy: "frontmatter_or_campaign_asset",
    cta_rewrite_policy: "campaignspec_routes_via_campaign_link",
    layout_choice: "campaign_layout",
    template_files_copied: {
      status: "pending",
      required_groups: [...TEMPLATE_SLICE_REQUIRED_GROUPS],
      groups: [],
      paths: [],
    },
  };
}

export function validateAdapterDecisionShape(decisions, location, warnings, ready, { addIssue }) {
  if (!decisions) {
    addIssue(warnings, location, `${location} is missing; adapter choices are not doctor-able. New prepare-build runs write source_asset_strategy, commerce_shell_adoption, route_rewrite_policy, template_files_copied, config_script_strategy, raw_html_conversion_status, wrapper_policy, frontmatter_policy, script_style_reference_policy, cta_rewrite_policy, and layout_choice.`);
    return;
  }
  if (!isObject(decisions)) {
    addIssue(warnings, location, `${location} must be an object when present.`);
    return;
  }
  for (const field of ADAPTER_DECISION_REQUIRED_FIELDS) {
    if (!(field in decisions)) {
      addIssue(warnings, `${location}.${field}`, `${location}.${field} is missing; adapter decisions must carry every required public contract field.`);
    }
  }
  checkEnum(decisions.raw_html_conversion_status, RAW_HTML_CONVERSION_STATUSES, `${location}.raw_html_conversion_status`, warnings, addIssue);
  checkEnum(decisions.source_asset_strategy, SOURCE_ASSET_STRATEGIES, `${location}.source_asset_strategy`, warnings, addIssue);
  checkEnum(decisions.route_rewrite_policy, ROUTE_REWRITE_POLICIES, `${location}.route_rewrite_policy`, warnings, addIssue);
  checkEnum(decisions.config_script_strategy, CONFIG_SCRIPT_STRATEGIES, `${location}.config_script_strategy`, warnings, addIssue);
  checkEnum(decisions.commerce_shell_adoption, COMMERCE_SHELL_ADOPTIONS, `${location}.commerce_shell_adoption`, warnings, addIssue);
  checkEnum(decisions.wrapper_policy, WRAPPER_POLICIES, `${location}.wrapper_policy`, warnings, addIssue);
  checkEnum(decisions.frontmatter_policy, FRONTMATTER_POLICIES, `${location}.frontmatter_policy`, warnings, addIssue);
  checkEnum(decisions.script_style_reference_policy, SCRIPT_STYLE_REFERENCE_POLICIES, `${location}.script_style_reference_policy`, warnings, addIssue);
  checkEnum(decisions.cta_rewrite_policy, CTA_REWRITE_POLICIES, `${location}.cta_rewrite_policy`, warnings, addIssue);
  checkEnum(decisions.layout_choice, LAYOUT_CHOICES, `${location}.layout_choice`, warnings, addIssue);

  const copied = decisions.template_files_copied;
  if (copied != null) {
    if (!isObject(copied)) {
      addIssue(warnings, `${location}.template_files_copied`, `${location}.template_files_copied must be an object when present.`);
    } else {
      for (const field of TEMPLATE_FILES_COPIED_REQUIRED_FIELDS) {
        if (!(field in copied)) {
          addIssue(warnings, `${location}.template_files_copied.${field}`, `${location}.template_files_copied.${field} is missing; template slice proof must record status, required_groups, groups, and paths.`);
        }
      }
      checkEnum(copied.status, TEMPLATE_FILES_COPIED_STATUSES, `${location}.template_files_copied.status`, warnings, addIssue);
      if (copied.required_groups != null && !Array.isArray(copied.required_groups)) {
        addIssue(warnings, `${location}.template_files_copied.required_groups`, `${location}.template_files_copied.required_groups must be an array.`);
      }
      if (copied.groups != null && !Array.isArray(copied.groups)) {
        addIssue(warnings, `${location}.template_files_copied.groups`, `${location}.template_files_copied.groups must be an array.`);
      }
      if (copied.paths != null && !Array.isArray(copied.paths)) {
        addIssue(warnings, `${location}.template_files_copied.paths`, `${location}.template_files_copied.paths must be an array.`);
      }
    }
  }
  ready.push(`${location} adapter decision fields loaded`);
}

export function validateAdapterSourceFiles({ decisions, sourceRoot, pages = [], warnings, ready, addIssue }) {
  if (!isObject(decisions)) return;
  const status = decisions.raw_html_conversion_status;
  if (!["completed", "not_required"].includes(status)) return;

  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) return;
  const hits = [];
  for (const page of pages || []) {
    if (!page.path) continue;
    const fullPath = resolve(sourceRoot, page.path);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
    const content = readFileSync(fullPath, "utf8");
    const wrappers = collectDocumentWrapperNames(content);
    if (wrappers.length) hits.push({ path: page.path, wrappers });
  }
  if (!hits.length) {
    ready.push("Source adapter wrapper check found no document wrappers in completed source pages");
    return;
  }
  const sample = hits.slice(0, 4).map((hit) => `${hit.path} (${hit.wrappers.join(", ")})`).join("; ");
  const more = hits.length > 4 ? `; plus ${hits.length - 4} more` : "";
  addIssue(
    warnings,
    "source_html.raw_html_wrappers",
    `source_html.adapter_contract.raw_html_conversion_status is "${status}", but mapped source HTML still contains document wrapper tags: ${sample}${more}. Strip <!doctype>, <html>, <head>, and <body> before treating the page as page-kit-ready source.`
  );
}

export function validateAdapterDecisionGates({ decisions, location, specPages = [], family, assemblyComplete, targetRepo = null, errors, warnings, ready, addIssue }) {
  if (!isObject(decisions)) return;
  const runtimePages = specPages.filter((page) => RUNTIME_PAGE_TYPES.has(String(page.type || "").toLowerCase()));
  const familyAutomatable = isNonEmptyString(family) && family !== "undecided" && family !== "custom";

  if (assemblyComplete) {
    if (["pending", "in_progress", "blocked"].includes(decisions.raw_html_conversion_status)) {
      addIssue(
        warnings,
        "adapter.raw_html_conversion_status",
        `Assembly is recorded complete, but ${location}.raw_html_conversion_status is "${decisions.raw_html_conversion_status}". Record completed/not_required after wrapper stripping, frontmatter, asset moves, script/style refs, CTA rewrites, route policy, and layout choice are settled.`
      );
    }
    if (["raw_passthrough", "unknown"].includes(decisions.source_asset_strategy)) {
      addIssue(warnings, "adapter.source_asset_strategy", `Assembly is recorded complete with ${location}.source_asset_strategy="${decisions.source_asset_strategy}". Page-kit builds should normally use pagekit_campaign_asset_root so src/<slug>/assets/* publishes at /<slug>/*.`);
    }
    if (["raw_passthrough", "unknown"].includes(decisions.route_rewrite_policy)) {
      addIssue(warnings, "adapter.route_rewrite_policy", `Assembly is recorded complete with ${location}.route_rewrite_policy="${decisions.route_rewrite_policy}". Record how CampaignSpec routes and CTA destinations were rewritten before QA.`);
    }
    if (decisions.config_script_strategy === "unknown") {
      addIssue(warnings, "adapter.config_script_strategy", `Assembly is recorded complete but ${location}.config_script_strategy is unknown. Record whether config scripts load via campaign assets, frontmatter scripts, inline config, or not_required.`);
    }
    if (["preserve_document_wrappers", "unknown"].includes(decisions.wrapper_policy)) {
      addIssue(warnings, "adapter.wrapper_policy", `Assembly is recorded complete with ${location}.wrapper_policy="${decisions.wrapper_policy}". Page-kit source should normally strip document wrappers unless preserving them is explicitly not_required.`);
    }
    if (["raw_passthrough", "unknown"].includes(decisions.frontmatter_policy)) {
      addIssue(warnings, "adapter.frontmatter_policy", `Assembly is recorded complete with ${location}.frontmatter_policy="${decisions.frontmatter_policy}". Record how Page Kit YAML frontmatter was created or why it is not_required.`);
    }
    if (["raw_passthrough", "unknown"].includes(decisions.script_style_reference_policy)) {
      addIssue(warnings, "adapter.script_style_reference_policy", `Assembly is recorded complete with ${location}.script_style_reference_policy="${decisions.script_style_reference_policy}". Record how scripts/styles load via frontmatter, campaign assets, inline blocks, or not_required.`);
    }
    if (["raw_passthrough", "unknown"].includes(decisions.cta_rewrite_policy)) {
      addIssue(warnings, "adapter.cta_rewrite_policy", `Assembly is recorded complete with ${location}.cta_rewrite_policy="${decisions.cta_rewrite_policy}". Record how CTA destinations were rewritten from CampaignSpec routes before QA.`);
    }
    if (["raw_passthrough", "unknown"].includes(decisions.layout_choice)) {
      addIssue(warnings, "adapter.layout_choice", `Assembly is recorded complete with ${location}.layout_choice="${decisions.layout_choice}". Record the Page Kit layout strategy before handoff.`);
    }
  }

  if (runtimePages.length > 0 && familyAutomatable) {
    const adoption = decisions.commerce_shell_adoption;
    if (adoption === "custom_html_experimental") {
      addIssue(
        errors,
        "adapter.commerce_shell_adoption",
        `Runtime commerce pages (${runtimePages.map((page) => page.id).join(", ")}) are marked custom_html_experimental for template family "${family}". Use template_clone_first_verified or sdk_surfaces_preserved before treating checkout/upsell/downsell/receipt as build-ready.`
      );
    } else if (assemblyComplete && !["template_clone_first_verified", "sdk_surfaces_preserved"].includes(adoption)) {
      addIssue(
        warnings,
        "adapter.commerce_shell_adoption",
        `Assembly is recorded complete, but ${location}.commerce_shell_adoption is "${adoption || "missing"}" for runtime commerce pages (${runtimePages.map((page) => page.id).join(", ")}). Commerce pages should be template-clone-first, then styled, with SDK-owned surfaces preserved.`
      );
    }
  }

  if (assemblyComplete && familyAutomatable) {
    validateTemplateFilesCopied(decisions.template_files_copied, location, warnings, ready, addIssue, { targetRepo });
  }
}

export function collectDocumentWrapperNames(content) {
  const wrappers = [];
  const text = String(content || "");
  if (/<!doctype\b/i.test(text)) wrappers.push("doctype");
  if (/<html(?:\s|>)/i.test(text)) wrappers.push("html");
  if (/<head(?:\s|>)/i.test(text)) wrappers.push("head");
  if (/<body(?:\s|>)/i.test(text)) wrappers.push("body");
  return wrappers;
}

function validateTemplateFilesCopied(copied, location, warnings, ready, addIssue, { targetRepo = null } = {}) {
  if (!isObject(copied)) {
    addIssue(warnings, "adapter.template_files_copied", `Assembly is recorded complete, but ${location}.template_files_copied is missing. Record the selected template family as an atomic slice: pages, _includes, _layouts, CSS, JS, and frontmatter vocabulary.`);
    return;
  }
  const status = copied.status || "missing";
  if (!["complete", "verified_existing_slice", "not_applicable"].includes(status)) {
    addIssue(warnings, "adapter.template_files_copied", `Assembly is recorded complete, but ${location}.template_files_copied.status is "${status}". Copy or verify the selected template family as one atomic slice, not individual commerce pages.`);
    return;
  }
  if (status === "not_applicable") {
    ready.push("Template slice copying marked not_applicable");
    return;
  }
  const groups = new Set(Array.isArray(copied.groups) ? copied.groups.map(String) : []);
  const missing = TEMPLATE_SLICE_REQUIRED_GROUPS.filter((group) => !groups.has(group));
  if (missing.length) {
    addIssue(
      warnings,
      "adapter.template_files_copied.groups",
      `${location}.template_files_copied.status is "${status}", but required group(s) are missing: ${missing.join(", ")}. Atomic template slices include pages, _includes, _layouts, assets/css, assets/js, and frontmatter_vocabulary.`
    );
    return;
  }
  if (!validateTemplateSlicePaths(copied, location, targetRepo, warnings, ready, addIssue)) return;
  ready.push("Template family slice copy/verification covers required page-kit dependency groups");
}

function validateTemplateSlicePaths(copied, location, targetRepo, warnings, ready, addIssue) {
  const paths = Array.isArray(copied.paths) ? copied.paths.filter(isNonEmptyString) : [];
  if (paths.length === 0) {
    addIssue(warnings, "adapter.template_files_copied.paths", `Assembly is recorded complete, but ${location}.template_files_copied.paths is empty. Record the target repo paths that prove the template family slice exists.`);
    return false;
  }
  if (!isNonEmptyString(targetRepo) || !existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) return true;

  const missing = [];
  const absolute = [];
  for (const path of paths) {
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) {
      absolute.push(path);
      continue;
    }
    const fullPath = resolve(targetRepo, path);
    if (!existsSync(fullPath)) missing.push(path);
  }
  if (absolute.length) {
    addIssue(warnings, "adapter.template_files_copied.paths", `${location}.template_files_copied.paths should be target-repo-relative, not absolute: ${absolute.slice(0, 5).join(", ")}.`);
  }
  if (missing.length) {
    addIssue(warnings, "adapter.template_files_copied.paths", `${location}.template_files_copied.paths references missing target repo path(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? `; plus ${missing.length - 8} more` : ""}.`);
    return false;
  }
  ready.push("Template family slice paths exist in target repo");
  return absolute.length === 0;
}

function checkEnum(value, allowed, code, warnings, addIssue) {
  if (value == null) return;
  if (!allowed.has(value)) addIssue(warnings, code, `${code} has unknown value "${value}".`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
