// A projection, never a scrubber: source objects and free text never enter
// the export. Unknown producer values have fixed, non-actionable markers.
const MODES = new Set(["checkout", "node_modules", "global", "npx_cache", "package_directory"]);
const PLATFORMS = new Set(["claude", "codex", "agents", "all", "installed"]);
const STAGES = new Set(["prepare-build", "doctor-blocked", "setup", "build", "polish", "deploy", "qa", "done"]);
const STATUSES = new Set(["ready", "attention_required", "ready_with_warnings", "ready_with_waivers", "blocked"]);
const REASONS = new Set([
  "assembly.template_lock", "campaign.allowed_domains_confirmed", "deploy.preview_url",
  "page_kit.scaffold_required", "spec.page_url_html_extension", "spec.route_collision",
  "scope.runtime_qa_blocked", "scope.partial_build", "content_residue.needs_merchant_input",
  "page_kit.store_profile.mismatch", "page_kit.store_profile.demo_residue",
  "page_kit.sdk_version.expected_observed_mismatch", "page_kit.sdk_version.repo_newer",
  "page_kit.sdk_version.conflicting_declarations", "polish.evidence_missing",
  "polish.assembly_source_package_stale", "polish.source_package_stale", "polish.stale",
  "polish.hidden_eager_media.capture_missing", "polish.hidden_eager_media.capture_malformed",
  "theme_gate.starter_palette_only", "built_output.campaign_identity",
  "built_output.upsell_selector_scope", "built_output.sdk_markup.swap_with_add_to_cart",
  "built_output.sdk_markup.checkout_not_form", "built_output.sdk_markup.wrong_field_name",
  "built_output.sdk_markup.missing_selector_id_match",
]);
const ACTIONS = new Set([
  "repair_target", "align_store_profile", "align_sdk_version", "repair_waiver", "waive_checkpoint",
  "rerun_build", "run_polish", "theme_generate", "apply_brand_layer", "waive_theme",
  "polish.hidden_eager_media.capture", "polish.hidden_eager_media.install_browser",
  "polish.hidden_eager_media.repair", "polish.hidden_eager_media.repair_authority",
  "polish.hidden_eager_media.local_proof_rebuild", "polish.hidden_eager_media.waive",
]);

const RECOVERY = Object.freeze({
  skills: { owner: "operator", action_id: "install-skills", input_needed: "Selected agent profile", instruction: "Refresh the bundled skills for that profile and restart the agent." },
  pin: { owner: "operator", action_id: "tooling.status", input_needed: "Reviewed toolkit version and lockfile", instruction: "Compare the installed package with the reviewed version; registry currency is not checked." },
  update: { owner: "operator", action_id: "tooling.status", input_needed: "Reviewed upstream revision", instruction: "Review and update the toolkit checkout using the existing worktree workflow." },
  doctor: { owner: "workflow_owner", action_id: "doctor", input_needed: "Local packet inputs and detailed doctor findings", instruction: "Inspect doctor locally and follow its existing owner, required inputs, and recovery actions." },
  unsupported: { owner: "toolkit_maintainer", action_id: "tooling.diagnose", input_needed: "Producer vocabulary supported by this diagnostic version", instruction: "Review unsupported producer values locally; this export gives them no authority." },
});

export function diagnosticExport({ tooling = null, doctor = null, platform = "all", inspectionFailed = false } = {}) {
  const reasonIds = new Set();
  const actionIds = new Set();
  const recovery = [];
  const enumValue = (value, allowed) => {
    if (allowed.has(value)) return value;
    reasonIds.add("diagnostic.unsupported_value");
    return "unknown";
  };
  const safePlatform = enumValue(platform, PLATFORMS);
  const mode = tooling ? enumValue(tooling.install?.mode, MODES) : "unknown";
  const version = typeof tooling?.package?.version === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tooling.package.version)
    ? tooling.package.version : null;
  const toolingStatus = tooling ? enumValue(tooling.status, STATUSES) : "unavailable";
  if (!tooling) reasonIds.add("diagnostic.tooling_unavailable");
  const doctorStatus = doctor ? enumValue(doctor.status, STATUSES) : inspectionFailed ? "unavailable" : "not_requested";
  const stage = doctor ? enumValue(doctor.next?.stage, STAGES) : "unknown";
  let freshness = "unknown";
  if (tooling?.install?.pinned?.commit && /^[0-9a-f]{7,40}$/.test(tooling.install.pinned.commit)) freshness = "pinned";
  else if (mode === "checkout" && tooling?.git?.status === "ok" && Number.isInteger(tooling.git.behind) && tooling.git.behind >= 0) {
    freshness = tooling.git.behind > 0 ? "local_ref_behind" : "local_ref_current";
  }
  if (tooling) {
    if (typeof tooling.skills?.ok !== "boolean") {
      reasonIds.add("diagnostic.unsupported_value");
    } else if (tooling.skills.ok === false) {
      reasonIds.add("tooling.skills_stale"); actionIds.add("install-skills"); recovery.push(RECOVERY.skills);
    }
  }
  if (freshness === "unknown") { reasonIds.add("tooling.freshness_unknown"); recovery.push(RECOVERY.pin); }
  if (freshness === "local_ref_behind") { reasonIds.add("tooling.checkout_behind"); recovery.push(RECOVERY.update); }
  for (const issue of [...(Array.isArray(doctor?.errors) ? doctor.errors : []), ...(Array.isArray(doctor?.warnings) ? doctor.warnings : [])]) {
    reasonIds.add(REASONS.has(issue?.code) ? issue.code : "diagnostic.unsupported_reason");
  }
  for (const gate of Array.isArray(doctor?.derived?.checkpoint_gates) ? doctor.derived.checkpoint_gates : []) {
    for (const action of Array.isArray(gate?.required_actions) ? gate.required_actions : []) {
      actionIds.add(ACTIONS.has(action?.id) ? action.id : "diagnostic.unsupported_action");
    }
  }
  if ((doctor && doctorStatus !== "ready") || inspectionFailed) {
    if (inspectionFailed) reasonIds.add("diagnostic.inspection_unavailable");
    actionIds.add("doctor"); recovery.push(RECOVERY.doctor);
  }
  if ([...reasonIds, ...actionIds].some((id) => id.startsWith("diagnostic.unsupported_"))) recovery.push(RECOVERY.unsupported);
  return {
    schema_version: "campaigns-os-diagnostic/v0",
    version, install_mode: mode, platform: safePlatform,
    tooling_status: toolingStatus, doctor_status: doctorStatus, stage,
    freshness: { toolkit: freshness, inspection: doctor ? "observed" : inspectionFailed ? "unavailable" : "not_requested" },
    reason_ids: [...reasonIds].sort(), action_ids: [...actionIds].sort(), recovery,
  };
}

export function diagnosticTextLines(result) {
  return [
    "Campaigns OS diagnostic (redacted)",
    `Version: ${result.version || "unknown"}; install: ${result.install_mode}; platform: ${result.platform}`,
    `Tooling: ${result.tooling_status}; doctor: ${result.doctor_status}; next stage: ${result.stage}`,
    `Freshness: ${result.freshness.toolkit}; local inspection: ${result.freshness.inspection}`,
    `Reasons: ${result.reason_ids.join(", ") || "none"}`,
    `Actions: ${result.action_ids.join(", ") || "none"}`,
    ...result.recovery.map((item) => `Recovery (${item.owner}, ${item.action_id}): ${item.instruction} Input needed: ${item.input_needed}.`),
    "This summary contains no campaign content or paths. Inspect detailed recovery locally. QA publication recovery uses the retained verdict with qa publish; never repeat an order to publish evidence.",
  ];
}
