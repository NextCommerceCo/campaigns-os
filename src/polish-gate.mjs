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
    const attributed = Boolean(normalizeString(waiver.waived_by) || normalizeString(waiver.owner));
    const timestamped = Boolean(normalizeString(waiver.waived_at) || normalizeString(waiver.created_at));
    const bounded = Boolean(normalizeString(waiver.expires_at) || normalizeString(waiver.review_condition));
    if ((scopeMatches || appliesToMatches) && attributed && timestamped && bounded) return waiver;
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

function textFragments(value) {
  if (Array.isArray(value)) return value.flatMap(textFragments);
  if (isObject(value)) return Object.values(value).flatMap(textFragments);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

function reviewText(value) {
  return textFragments(value).join(" ");
}

function hasNegativeEvidence(value, pattern) {
  const text = reviewText(value);
  if (/\bnot\s+found\b|\bnone\s+found\b|\bnot\s+present\b|\bno\s+(?:starter|template)\b/i.test(text)) return false;
  return pattern.test(text);
}

function buildBriefBlocksTemplateFavicon(report) {
  // Canonical Build Brief location after prepare-build normalization.
  const policy = report?.build_brief?.artifact?.template_residue_policy || null;
  return policy?.block_template_favicon === true;
}

function faviconTextConfirmsSourceMatch(text) {
  return /(?:byte[-_\s]?match|matched|matches|matching).{0,40}(?:source|brand|candidate)|(?:source|brand|candidate).{0,40}(?:matched|matches|matching|byte[-_\s]?match)|promoted.{0,40}source|confirmed.{0,40}(?:non[-_\s]?template|not[-_\s]?template)|\b(?:no|none)\s+source\s+candidate\b/i.test(text);
}

function hasNegativeBumpCompareEvidence(value) {
  const text = reviewText(value);
  if (/\b(?:no|none)\s+(?:equal|same|duplicate|doubled|no[-_\s]?discount).{0,24}(?:compare|strike|original|price)\s*(?:found|present|rendered|shown|visible)?\b/i.test(text)) return false;
  return hasNegativeEvidence(value, /\b(?:equal|same)\s+(?:compare|strike|original)\s+price\s+(?:found|present|rendered|shown|visible)\b|\b(?:equal|same)\s+price\s+(?:compare|strike|original)\s+(?:found|present|rendered|shown|visible)\b|\b(?:compare|strike|original)\s+price\s+(?:equals|===|same\s+as)\s+(?:list|full|retail|original)\b|\b(?:doubled|duplicate)\s+(?:compare|strike|original|price)(?:\s+(?:row|price))?\s+(?:found|present|rendered|shown|visible)\b|\bno[-_\s]?discount\s+(?:compare|strike|original)\s+(?:rendered|shown|visible|present|found)\b/i);
}

function semanticEvidenceProblems(evidence, report) {
  const problems = [];
  const brandReview = evidence?.brand_review;
  const checkoutReview = evidence?.checkout_review;
  const residueReview = evidence?.template_residue_review;

  const favicon = isObject(brandReview) ? brandReview.favicon : null;
  if (buildBriefBlocksTemplateFavicon(report)) {
    const faviconText = reviewText(favicon);
    const faviconObjectOk = isObject(favicon) && (
      favicon.byte_match === true
      || ["matched_source", "promoted_source", "confirmed_non_template", "no_source_candidate"].includes(String(favicon.status || favicon.result || ""))
    );
    const faviconTextOk = faviconTextConfirmsSourceMatch(faviconText);
    if (!faviconObjectOk && !faviconTextOk) {
      problems.push("stages.polish.evidence.brand_review.favicon must confirm source/brand favicon matching or a documented no-source-candidate outcome when block_template_favicon is true.");
    }
    if (isObject(favicon) && favicon.byte_match === false) {
      problems.push("stages.polish.evidence.brand_review.favicon records byte_match=false while block_template_favicon is true.");
    }
  }
  if (hasNegativeEvidence(favicon, /\b(?:starter|template)\s+favicon\s+(?:found|present|matched|leaked|retained|kept|remaining)|images\/favicon\.png\b/i)) {
    problems.push("stages.polish.evidence.brand_review.favicon still indicates starter-template favicon leakage.");
  }
  if (hasNegativeEvidence(residueReview?.starter_favicon, /\b(?:found|present|matched|leaked|retained|kept|remaining)|images\/favicon\.png\b/i)) {
    problems.push("stages.polish.evidence.template_residue_review.starter_favicon still indicates starter-template favicon leakage.");
  }

  const fieldEvidence = checkoutReview?.field_labels ?? checkoutReview?.initial_field_hints ?? checkoutReview?.visible_labels;
  if (!fieldEvidence) {
    problems.push("stages.polish.evidence.checkout_review must confirm initial checkout field labels/placeholders/hints.");
  } else if (hasNegativeEvidence(fieldEvidence, /\b(?:missing|absent|blank|unlabeled|unlabelled|placeholder[-_\s]?stripped|not\s+legible)\b/i)) {
    problems.push("stages.polish.evidence.checkout_review.field_labels must confirm a legible initial field hint/label state.");
  }

  const bumpEvidence = checkoutReview?.bump_compare_price_rule ?? checkoutReview?.bump_compare_price;
  if (!bumpEvidence) {
    problems.push("stages.polish.evidence.checkout_review must confirm the order-bump compare-price rule.");
  } else if ((isObject(bumpEvidence) && (bumpEvidence.equal_compare_price_found === true || bumpEvidence.same_price_compare_rendered === true)) || hasNegativeBumpCompareEvidence(bumpEvidence)) {
    problems.push("stages.polish.evidence.checkout_review.bump_compare_price_rule must confirm no equal/no-discount compare price renders.");
  }

  // Brand bleed: when a campaign is cloned from a proven sibling, the sibling's
  // brand defaults ride along — a default promo/sale banner with a fake code,
  // hardcoded non-token colors (e.g. next-core's #C670FE pill), scaffold fonts
  // (Plus Jakarta), and the prior favicon. Polish must affirmatively certify
  // the de-brand pass cleared them. See the Shield build learnings (A3).
  const bleedEvidence = brandReview?.brand_bleed ?? brandReview?.brand_bleed_review ?? brandReview?.debrand;
  if (!bleedEvidence) {
    problems.push("stages.polish.evidence.brand_review.brand_bleed must confirm the cloned-source de-brand pass: no residual promo/sale code or copy, no prior-campaign favicon, no scaffold/non-design fonts, no hardcoded non-token colors.");
  } else if (brandBleedNegative(bleedEvidence)) {
    problems.push("stages.polish.evidence.brand_review.brand_bleed still indicates cloned-source brand bleed (residual promo code/sale copy, prior-campaign favicon, scaffold/non-design fonts, or a hardcoded non-token color).");
  }

  return problems;
}

function brandBleedNegative(value) {
  if (isObject(value) && (value.cleared === false || value.bleed_found === true || value.residual_found === true)) return true;
  return hasNegativeEvidence(value, /\b(?:promo|sale)\s+(?:code|copy|banner|sale)\b.{0,40}\b(?:found|present|remain(?:s|ing)?|leaked|retained|kept)\b|\bfake\s+(?:code|sale)\b|\bprior[-_\s]?campaign\b|\bsibling[-_\s]?(?:brand|campaign|source)\b|\bscaffold\s+font|\bplus\s+jakarta\b|#c670fe\b|\bhardcoded\s+(?:non[-_\s]?token\s+)?(?:color|hex|purple)\b|\bnon[-_\s]?token\s+colou?r\s+(?:found|present|remain(?:s|ing)?)\b/i);
}

function evidenceProblems(evidence, report) {
  if (!isObject(evidence)) {
    return ["stages.polish.evidence must be an object with the required polish evidence categories."];
  }
  const problems = [];
  for (const field of POLISH_GATE_REQUIRED_EVIDENCE) {
    if (!fieldHasEvidence(evidence[field], field)) {
      problems.push(`stages.polish.evidence.${field} is missing or incomplete.`);
    }
  }
  problems.push(...semanticEvidenceProblems(evidence, report));
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

  const problems = evidenceProblems(evidence, report);
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
