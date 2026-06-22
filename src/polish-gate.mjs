export const POLISH_GATE_REQUIRED_EVIDENCE = Object.freeze([
  "visual_review",
  "brand_review",
  "checkout_review",
  "template_residue_review",
  "commerce_flow_review",
  "issues",
  "commands",
]);

export const POLISH_PRODUCER = "next-campaigns-polish";

const SUCCESS_STATUS_PREFIXES = Object.freeze(["completed"]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeString(value) {
  return nonEmptyString(value) ? value.trim() : null;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => normalizeString(entry)).filter(Boolean) : [];
}

function stageStatus(stage) {
  return String(stage?.status || "");
}

function stageSucceeded(stage) {
  const status = stageStatus(stage);
  return SUCCESS_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix));
}

function terminalAssembly(report) {
  return String(report?.stages?.assembly?.status || "").startsWith("completed");
}

export function currentBuildFingerprint(report) {
  return normalizeString(report?.stages?.assembly?.build_fingerprint)
    || normalizeString(report?.stages?.assembly?.artifact_fingerprint)
    || normalizeString(report?.build_fingerprint)
    || normalizeString(report?.artifact_fingerprint)
    || null;
}

export function currentSourcePackageMaterialFingerprint(report) {
  return normalizeString(report?.design_source_package?.material_fingerprint)
    || normalizeString(report?.inputs?.design_source_package?.material_fingerprint)
    || normalizeString(report?.source_package?.material_fingerprint)
    || normalizeString(report?.source_package_material_fingerprint)
    || null;
}

export function assemblySourcePackageMaterialFingerprint(report) {
  const assembly = report?.stages?.assembly;
  return normalizeString(assembly?.source_package_material_fingerprint)
    || normalizeString(assembly?.evidence?.source_package_material_fingerprint)
    || normalizeString(report?.assembly?.source_package_material_fingerprint)
    || null;
}

export function assemblySourcePackageFreshnessWaiver(report) {
  const candidates = [
    ...(Array.isArray(report?.waivers) ? report.waivers : []),
    report?.assembly_source_package_freshness_waiver,
    report?.source_package_freshness_waiver,
  ].filter(Boolean);
  for (const waiver of candidates) {
    if (!isObject(waiver) || !normalizeString(waiver.reason)) continue;
    const scope = normalizeString(waiver.scope);
    const appliesTo = normalizeStringArray(waiver.applies_to);
    const scopeMatches = [
      "assembly_source_package_freshness",
      "source_package_after_build",
      "source_package_stale_after_build",
    ].includes(scope);
    const appliesToMatches = appliesTo.some((entry) => [
      "stages.assembly.source_package_material_fingerprint",
      "design_source_package.material_fingerprint",
      "polish.assembly_source_package_fingerprint_missing",
      "polish.assembly_source_package_stale",
    ].includes(entry));
    if (scopeMatches || appliesToMatches) return waiver;
  }
  return null;
}

function polishEvidence(stage, report) {
  if (isObject(stage?.evidence)) return stage.evidence;
  if (isObject(report?.polish?.evidence)) return report.polish.evidence;
  return null;
}

function fieldHasEvidence(value, field) {
  if (field === "issues") return Array.isArray(value);
  if (field === "commands") {
    if (!Array.isArray(value) || value.length === 0) return false;
    return value.some((entry) => nonEmptyString(entry) || isObject(entry));
  }
  if (field === "visual_review") {
    if (!isObject(value)) return false;
    const screenshots = value.screenshots || value.screenshot_paths || value.paths || value.urls;
    return Array.isArray(screenshots) && screenshots.some(nonEmptyString);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return nonEmptyString(value);
}

function evidenceProblems(evidence) {
  if (!isObject(evidence)) {
    return ["stages.polish.evidence must be an object with the required polish evidence categories."];
  }
  const problems = [];
  for (const field of POLISH_GATE_REQUIRED_EVIDENCE) {
    if (!fieldHasEvidence(evidence[field], field)) {
      problems.push(`stages.polish.evidence.${field} is missing or incomplete.`);
    }
  }
  return problems;
}

function performedBy(stage, evidence) {
  return normalizeString(stage?.performed_by)
    || normalizeString(stage?.command_identity)
    || normalizeString(evidence?.performed_by)
    || null;
}

function sourceBuildFingerprint(stage, evidence) {
  return normalizeString(stage?.source_build_fingerprint)
    || normalizeString(evidence?.source_build_fingerprint)
    || null;
}

function sourcePackageMaterialFingerprint(stage, evidence) {
  return normalizeString(stage?.source_package_material_fingerprint)
    || normalizeString(evidence?.source_package_material_fingerprint)
    || null;
}

function completedAt(stage, evidence) {
  return normalizeString(stage?.completed_at)
    || normalizeString(evidence?.completed_at)
    || null;
}

function commandMentionsBuild(stage, evidence) {
  const commands = [
    ...(Array.isArray(stage?.commands) ? stage.commands : []),
    ...(Array.isArray(evidence?.commands) ? evidence.commands : []),
  ];
  return commands.some((entry) => /next-campaigns-build|campaigns-os\s+next\s+build/i.test(String(isObject(entry) ? entry.command || entry.name || "" : entry)));
}

export function evaluatePolishGate({ report, required = false } = {}) {
  if (!isObject(report)) {
    return required
      ? {
          status: "blocked",
          code: "polish.report_missing",
          reason: "Polish evidence missing for current build. Run next-campaigns-polish before QA.",
          required_actions: [{ id: "run_polish", kind: "skill", command: "next-campaigns-polish", description: "Run the distinct Polish stage and record structured evidence on stages.polish." }],
        }
      : { status: "not_applicable", code: "polish.not_applicable", reason: "No assembly report is available to evaluate polish evidence." };
  }

  if (!terminalAssembly(report)) {
    return {
      status: "not_applicable",
      code: "polish.not_applicable",
      reason: "Assembly is not completed yet; polish evidence is required after build completion.",
    };
  }

  const buildFingerprint = currentBuildFingerprint(report);
  const currentSourcePackageFingerprint = currentSourcePackageMaterialFingerprint(report);
  const assemblySourcePackageFingerprint = assemblySourcePackageMaterialFingerprint(report);
  const sourcePackageFreshnessWaiver = assemblySourcePackageFreshnessWaiver(report);
  const stage = report.stages?.polish;
  const evidence = polishEvidence(stage, report);
  const buildRequiredActions = [
    {
      id: "rerun_build",
      kind: "skill",
      command: "next-campaigns-build",
      description: "Re-run Build/Assembly against the current Design Source Package and record stages.assembly.source_package_material_fingerprint before Polish.",
    },
  ];
  const requiredActions = [
    {
      id: "run_polish",
      kind: "skill",
      command: "next-campaigns-polish",
      description: "Run the distinct Polish stage and record stages.polish.performed_by, source_build_fingerprint, source_package_material_fingerprint when available, completed_at, and structured evidence.",
    },
  ];

  if (!buildFingerprint) {
    return {
      status: "blocked",
      code: "polish.build_fingerprint_missing",
      reason: "Current build artifact fingerprint is missing. Build must record stages.assembly.build_fingerprint before Polish/QA handoff.",
      required_actions: requiredActions,
    };
  }

  if (currentSourcePackageFingerprint && !assemblySourcePackageFingerprint && !sourcePackageFreshnessWaiver) {
    return {
      status: "blocked",
      code: "polish.assembly_source_package_fingerprint_missing",
      reason: "Assembly is not tied to the current Design Source Package material fingerprint. Re-run Build before Polish.",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      required_actions: buildRequiredActions,
    };
  }
  if (currentSourcePackageFingerprint && assemblySourcePackageFingerprint !== currentSourcePackageFingerprint && !sourcePackageFreshnessWaiver) {
    return {
      status: "blocked",
      code: "polish.assembly_source_package_stale",
      reason: "The Design Source Package changed after Build. Re-run Build against the current source package before Polish.",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      required_actions: buildRequiredActions,
    };
  }

  if (!isObject(stage)) {
    return {
      status: "blocked",
      code: "polish.evidence_missing",
      reason: "Polish evidence missing for current build. Run next-campaigns-polish before QA.",
      build_fingerprint: buildFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  const status = stageStatus(stage);
  if (status === "blocked") {
    return {
      status: "blocked",
      code: "polish.blocked",
      reason: "Polish is recorded as blocked. Resolve the Polish blockers before QA.",
      build_fingerprint: buildFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }
  if (!stageSucceeded(stage)) {
    return {
      status: "blocked",
      code: "polish.evidence_missing",
      reason: "Polish evidence missing for current build. Run next-campaigns-polish before QA.",
      build_fingerprint: buildFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  const producer = performedBy(stage, evidence);
  if (producer !== POLISH_PRODUCER || commandMentionsBuild(stage, evidence)) {
    return {
      status: "blocked",
      code: "polish.self_certified",
      reason: `Polish success must be produced by ${POLISH_PRODUCER}, not ${producer || "an unspecified or build-owned producer"}. Run a distinct Polish stage before QA.`,
      build_fingerprint: buildFingerprint,
      performed_by: producer,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  const sourceFingerprint = sourceBuildFingerprint(stage, evidence);
  if (!sourceFingerprint) {
    return {
      status: "blocked",
      code: "polish.source_build_fingerprint_missing",
      reason: "Polish evidence is not tied to the current build artifact fingerprint. Re-run next-campaigns-polish against the current build before QA.",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }
  if (sourceFingerprint !== buildFingerprint) {
    return {
      status: "blocked",
      code: "polish.stale",
      reason: "Polish evidence is stale for the current build artifact fingerprint. Re-run next-campaigns-polish before QA.",
      build_fingerprint: buildFingerprint,
      source_build_fingerprint: sourceFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  const polishSourcePackageFingerprint = sourcePackageMaterialFingerprint(stage, evidence);
  if (currentSourcePackageFingerprint && !polishSourcePackageFingerprint) {
    return {
      status: "blocked",
      code: "polish.source_package_material_fingerprint_missing",
      reason: "Polish evidence is not tied to the current Design Source Package material fingerprint. Re-run next-campaigns-polish against the current source package before QA.",
      build_fingerprint: buildFingerprint,
      source_build_fingerprint: sourceFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }
  if (currentSourcePackageFingerprint && polishSourcePackageFingerprint !== currentSourcePackageFingerprint) {
    return {
      status: "blocked",
      code: "polish.source_package_stale",
      reason: "Polish evidence is stale for the current Design Source Package material fingerprint. Re-run next-campaigns-polish before QA.",
      build_fingerprint: buildFingerprint,
      source_build_fingerprint: sourceFingerprint,
      source_package_material_fingerprint: polishSourcePackageFingerprint,
      current_source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  if (!completedAt(stage, evidence)) {
    return {
      status: "blocked",
      code: "polish.completed_at_missing",
      reason: "Polish evidence is missing completed_at. Re-run or repair the Polish stage record before QA.",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      required_actions: requiredActions,
    };
  }

  const problems = evidenceProblems(evidence);
  if (problems.length) {
    return {
      status: "blocked",
      code: "polish.evidence_incomplete",
      reason: "Polish evidence is incomplete for the current build. Run next-campaigns-polish before QA.",
      build_fingerprint: buildFingerprint,
      source_package_material_fingerprint: currentSourcePackageFingerprint,
      assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
      waiver: sourcePackageFreshnessWaiver,
      problems,
      required_actions: requiredActions,
    };
  }

  const warnings = [];
  if (!currentSourcePackageFingerprint) {
    warnings.push({
      code: "polish.source_package_material_fingerprint_unavailable",
      message: "No current Design Source Package material fingerprint is available; Polish freshness is using legacy build-fingerprint-only behavior.",
    });
  }

  const waivedAssemblyFreshness = Boolean(sourcePackageFreshnessWaiver);
  return {
    status: waivedAssemblyFreshness ? "waived" : "pass",
    code: waivedAssemblyFreshness ? "polish.assembly_source_package_waived" : "polish.evidence_current",
    reason: waivedAssemblyFreshness
      ? `Polish evidence is current, structured, and produced by next-campaigns-polish under source freshness waiver: ${sourcePackageFreshnessWaiver.reason}`
      : "Polish evidence is current, structured, and produced by next-campaigns-polish.",
    build_fingerprint: buildFingerprint,
    source_build_fingerprint: sourceFingerprint,
    source_package_material_fingerprint: polishSourcePackageFingerprint || null,
    current_source_package_material_fingerprint: currentSourcePackageFingerprint,
    assembly_source_package_material_fingerprint: assemblySourcePackageFingerprint,
    performed_by: producer,
    waiver: sourcePackageFreshnessWaiver,
    warnings,
  };
}
