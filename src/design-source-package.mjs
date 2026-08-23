import { createHash } from "node:crypto";

export const DESIGN_SOURCE_PACKAGE_SCHEMA = "campaign-design-source-package/v0";
export const DESIGN_SOURCE_PACKAGE_SCHEMA_VERSION = DESIGN_SOURCE_PACKAGE_SCHEMA;
export const DESIGN_SOURCE_PACKAGE_REL_PATH = ".campaign-runtime/input/design-source-package.json";
export const DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const COVERAGE_ROLES = Object.freeze([
  "primary_design",
  "partial_design",
  "brand_tokens",
  "asset_source",
  "copy_source",
  "template_baseline",
  "reference_only",
  "fallback_legacy",
]);

export const MAPPING_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low", "unknown"]);
export const CHECKPOINT_STATUSES = Object.freeze([
  "pending",
  "blocked",
  "ready",
  "ready_with_gaps",
  "ready_with_waivers",
  "completed",
  "completed_with_warnings",
  "skipped",
]);
export const SOURCE_READINESS_STATUSES = Object.freeze([
  "pending",
  "blocked",
  "ready",
  "ready_with_gaps",
  "ready_with_waivers",
]);

const CONTRIBUTION_KINDS = new Set([
  "html_funnel",
  "figma_frames",
  "figma_sections",
  "page_kit",
  "static_source",
  "template_stock",
  "agency_source",
  "other",
]);
const CONTRIBUTION_TRUST = new Set(["native", "structured", "rendered", "opaque"]);
const SURFACE_KINDS = new Set(["campaign", "page", "section", "runtime_surface"]);
const VISUAL_KINDS = new Set([
  "source_screenshot",
  "template_reference_screenshot",
  "render_reference",
  "export_reference",
  "unavailable_render",
]);
const VIEWPORTS = new Set(["mobile", "desktop", "tablet"]);
const SOURCE_REF_KINDS = new Set(["html_file", "manifest", "asset", "url", "export", "document", "other"]);
const REQUIRED_SOURCE_VIEWPORTS = Object.freeze(["desktop", "mobile"]);
const MATERIAL_FINGERPRINT_PREFIX = "sha256:";
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const SAFE_SURFACE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PRIMARY_COVERAGE_SCOPES = new Set([
  "primary_design",
  "primary_design_coverage",
  "source_coverage",
  "page_design",
  "design_source",
]);
const SOURCE_SCREENSHOT_SCOPES = new Set([
  "source_screenshot",
  "source_screenshots",
  "source_render",
  "visual_reference",
  "source_reference",
]);
const TEMPLATE_REFERENCE_SCOPES = new Set(["template_reference", "template_baseline"]);
const EXTERNAL_WAIVER_TARGETS = new Set([
  "stages.assembly.source_package_material_fingerprint",
  "design_source_package.material_fingerprint",
  "polish.assembly_source_package_fingerprint_missing",
  "polish.assembly_source_package_stale",
]);
const SOURCE_SCREENSHOT_KINDS = new Set(["source_screenshot", "unavailable_render"]);
const COMPARISON_REFERENCE_KINDS = new Set([
  "render_reference",
  "export_reference",
  "template_reference_screenshot",
  "unavailable_render",
]);
const TEMPLATE_SCREENSHOT_KINDS = new Set(["template_reference_screenshot", "unavailable_render"]);

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "package_id",
  "source_kind",
  "generated_at",
  "material_fingerprint",
  "surface_identity",
  "contributions",
  "source_gaps",
  "source_todos",
  "waivers",
  "divergences",
  "proposed_exceptions",
  "notes",
  "readiness",
  "readback",
]);
const SURFACE_FIELDS = new Set(["id", "kind", "label", "aliases", "mappings"]);
const SURFACE_MAPPING_FIELDS = new Set([
  "campaign_map_id",
  "campaign_slug",
  "campaign_spec_page_id",
  "map_builder_label",
  "map_builder_custom_name",
  "public_route",
  "producer_page_type",
  "source_page_id",
  "source_path",
  "page_kit",
  "parent_surface_id",
  "dom_selector",
  "runtime_surface",
]);
const PAGE_KIT_FIELDS = new Set([
  "target_path",
  "output_path",
  "public_route",
  "spec_route",
  "page_type",
  "permalink_required",
]);
const CONTRIBUTION_FIELDS = new Set([
  "id",
  "kind",
  "trust",
  "renderable",
  "provenance",
  "presentation_intent",
  "source_refs",
  "screenshot_refs",
  "reference_refs",
  "template_reference",
  "mappings",
  "notes",
]);
const PROVENANCE_FIELDS = new Set([
  "source_type",
  "adapter",
  "producer",
  "generator",
  "generator_version",
  "source_root",
  "manifest_schema_version",
  "manifest_path",
  "manifest_sha256",
  "producer_material_fingerprint",
  "asset_crawl_schema_version",
]);
const PRESENTATION_INTENT_FIELDS = new Set([
  "summary",
  "composition",
  "content_hierarchy",
  "imagery",
  "copy",
  "brand",
  "responsive_behavior",
]);
const SOURCE_REF_FIELDS = new Set(["id", "kind", "path", "url", "sha256", "role", "media_type", "notes"]);
const VISUAL_REF_FIELDS = new Set([
  "id",
  "kind",
  "viewport",
  "availability",
  "url",
  "path",
  "sha256",
  "width",
  "height",
  "device_profile",
  "scale_factor",
  "browser",
  "captured_at",
  "source_ref_id",
  "unavailable_reason",
  "notes",
]);
const TEMPLATE_REFERENCE_FIELDS = new Set([
  "id",
  "family",
  "version",
  "contract_path",
  "artifact_path",
  "sha256",
  "standard_viewport_refs",
]);
const COVERAGE_MAPPING_FIELDS = new Set([
  "id",
  "surface_id",
  "coverage_role",
  "confidence",
  "source_refs",
  "screenshot_refs",
  "reference_refs",
  "template_reference_id",
  "notes",
]);
const GAP_FIELDS = new Set([
  "id",
  "kind",
  "scope",
  "applies_to",
  "reason",
  "status",
  "attributed_by",
  "attributed_at",
  "evidence_refs",
]);
const TODO_FIELDS = new Set([
  "id",
  "kind",
  "scope",
  "applies_to",
  "description",
  "status",
  "owner",
  "required_viewports",
  "source_ref_ids",
]);
const WAIVER_FIELDS = new Set([
  "id",
  "scope",
  "applies_to",
  "reason",
  "status",
  "waived_by",
  "waived_at",
  "expires_at",
  "review_condition",
  "evidence_refs",
]);
const DIVERGENCE_FIELDS = new Set([
  "id",
  "scope",
  "applies_to",
  "summary",
  "status",
  "recorded_stage",
  "readiness_affecting",
  "attributed_by",
  "evidence_refs",
]);
const EXCEPTION_FIELDS = new Set([
  "id",
  "scope",
  "applies_to",
  "reason",
  "status",
  "readiness_affecting",
  "proposed_by",
  "evidence_refs",
]);
const READINESS_FIELDS = new Set([
  "status",
  "blocking_reasons",
  "gap_count",
  "todo_count",
  "waiver_count",
  "generated_at",
]);
const READBACK_FIELDS = new Set([
  "summary",
  "included_sources",
  "handled",
  "blockers",
  "gaps",
  "todos",
  "waivers",
  "next_actions",
]);

/**
 * Synthesize the normalized v0 package for the source-html adapter. This is a
 * pure adapter: every input is supplied by the caller and it performs no file
 * reads, captures, or network access. In particular, asset-crawl images and
 * section exports are never promoted to screenshot proof unless the input
 * record explicitly declares a shared viewport key.
 */
export function synthesizeHtmlFunnelDesignSourcePackage({
  activePages = [],
  mappings = [],
  pageMappings = null,
  manifest = null,
  manifestPath = null,
  assetCrawl = null,
  sourceAssetCrawl = null,
  templateFamily = null,
  sourceScreenshots = [],
  packageId = "design-source-package",
  campaignMapId = null,
  campaignSlug = null,
  sourceRoot = null,
  generatedAt = new Date().toISOString(),
  sourceGaps = [],
  sourceTodos = [],
  waivers = [],
  divergences = [],
  proposedExceptions = [],
  notes = [],
  presentationIntent = null,
} = {}) {
  const resolvedMappings = pageMappings == null ? mappings : pageMappings;
  assertInputArray(activePages, "activePages");
  assertInputArray(resolvedMappings, "mappings");
  assertInputArray(sourceScreenshots, "sourceScreenshots");
  for (const [name, value] of [
    ["sourceGaps", sourceGaps],
    ["sourceTodos", sourceTodos],
    ["waivers", waivers],
    ["divergences", divergences],
    ["proposedExceptions", proposedExceptions],
    ["notes", notes],
  ]) assertInputArray(value, name);

  activePages.forEach((page, index) => {
    if (!isObject(page) || !isNonEmptyString(page.id)) {
      throw new TypeError(`activePages[${index}] must be an object with a non-empty id.`);
    }
  });
  resolvedMappings.forEach((mapping, index) => {
    if (!isObject(mapping) || !isNonEmptyString(mapping.page_id)) {
      throw new TypeError(`mappings[${index}] must be an object with a non-empty page_id.`);
    }
  });

  const manifestInput = normalizeManifestInput(manifest, manifestPath);
  const crawl = isObject(sourceAssetCrawl) ? sourceAssetCrawl : isObject(assetCrawl) ? assetCrawl : null;
  const pages = collectPageInputs(activePages, resolvedMappings);
  const { surfaces, surfaceByPageId } = createSurfaceCatalog(pages, {
    campaignMapId,
    campaignSlug,
  });
  const manifestPagesById = new Map(
    arrayOrEmpty(manifestInput.value?.pages)
      .filter((entry) => isObject(entry) && isNonEmptyString(entry.page_id))
      .map((entry) => [entry.page_id, entry]),
  );

  const sourceRefRegistry = createSourceReferenceRegistry();
  if (manifestInput.path) {
    sourceRefRegistry.add({
      id: "source-html-manifest",
      kind: "manifest",
      path: manifestInput.path,
      sha256: validSha(manifestInput.value?.sha256),
      role: "producer_manifest",
    });
  }

  for (const file of arrayOrEmpty(manifestInput.value?.files)) {
    if (!isObject(file) || !isNonEmptyString(file.path)) continue;
    sourceRefRegistry.add({
      id: `manifest-${slugify(file.path) || "file"}`,
      kind: sourceReferenceKindForManifestFile(file),
      path: file.path,
      sha256: validSha(file.sha256),
      role: optionalString(file.role),
    });
  }

  const crawlHashes = new Map(
    arrayOrEmpty(crawl?.scanned_files)
      .filter((file) => isObject(file) && isNonEmptyString(file.path))
      .map((file) => [file.path, validSha(file.sha256)]),
  );
  for (const ref of arrayOrEmpty(crawl?.references)) {
    if (!isObject(ref)) continue;
    const url = /^https?:\/\//i.test(String(ref.raw || "")) ? ref.raw : null;
    const path = optionalString(ref.source_path) || (!url ? optionalString(ref.normalized) : null);
    if (!path && !url) continue;
    sourceRefRegistry.add({
      id: `asset-${slugify(path || url) || "reference"}`,
      kind: "asset",
      ...(path ? { path } : {}),
      ...(url ? { url } : {}),
      ...(crawlHashes.get(path) ? { sha256: crawlHashes.get(path) } : {}),
      role: optionalString(ref.asset_kind) || "asset",
    });
  }

  const globalVisualRegistry = createVisualReferenceRegistry("source_screenshot");
  const explicitSourceScreenshotsById = new Map(
    sourceScreenshots
      .filter((ref) => isObject(ref) && isNonEmptyString(ref.id))
      .map((ref) => [ref.id, ref]),
  );

  const htmlCoverage = [];
  for (const page of pages) {
    const mapping = page.mapping;
    const surfaceId = surfaceByPageId.get(page.pageId);
    const explicitRole = COVERAGE_ROLES.includes(mapping?.coverage_role) ? mapping.coverage_role : null;
    const hasSourcePath = isNonEmptyString(mapping?.path);
    if (!hasSourcePath && !explicitRole) continue;
    if (explicitRole === "template_baseline") continue;

    const manifestPage = manifestPagesById.get(page.pageId);
    const sourceRefIds = [];
    if (hasSourcePath) {
      const sourceHash = validSha(mapping.source_hash)
        || validSha(manifestPage?.source_hash)
        || crawlHashes.get(mapping.path)
        || null;
      const sourceRef = sourceRefRegistry.add({
        id: `source-${surfaceId}-html`,
        kind: "html_file",
        path: mapping.path,
        ...(sourceHash ? { sha256: sourceHash } : {}),
        role: "page",
      });
      sourceRefIds.push(sourceRef.id);
    }
    for (const assetRef of arrayOrEmpty(crawl?.references)) {
      if (!assetReferenceAppliesToPage(assetRef, page.pageId)) continue;
      const registered = sourceRefRegistry.findByLocation(assetRef.source_path || assetRef.normalized, assetRef.raw);
      if (registered) sourceRefIds.push(registered.id);
    }

    const screenshotIds = [];
    const visualCandidates = [
      ...visualCandidatesFrom(mapping, ["screenshot_refs", "source_screenshot_refs", "screenshots"]),
      ...visualCandidatesFrom(manifestPage, ["screenshot_refs", "source_screenshot_refs", "screenshots"]),
      ...sectionVisualCandidates(manifestInput.value, page.pageId),
      ...sourceScreenshots.filter((ref) => visualCandidateAppliesToPage(ref, page.pageId, surfaceId)),
    ];
    for (const raw of visualCandidates) {
      if (typeof raw === "string") {
        const declared = explicitSourceScreenshotsById.get(raw);
        const registered = declared
          ? globalVisualRegistry.add(declared, `source-${surfaceId}`, sourceRefIds[0] || null)
          : globalVisualRegistry.byId(raw);
        if (registered) screenshotIds.push(registered.id);
        continue;
      }
      const registered = globalVisualRegistry.add(raw, `source-${surfaceId}`, sourceRefIds[0] || null);
      if (registered) screenshotIds.push(registered.id);
    }

    const referenceRegistry = createVisualReferenceRegistry("render_reference");
    const referenceIds = [];
    for (const raw of visualCandidatesFrom(mapping, ["reference_refs", "render_references"])) {
      const registered = referenceRegistry.add(raw, `reference-${surfaceId}`, sourceRefIds[0] || null);
      if (registered) referenceIds.push(registered.id);
    }

    htmlCoverage.push({
      id: `html-${surfaceId}-coverage`,
      surface_id: surfaceId,
      coverage_role: explicitRole || "primary_design",
      confidence: normalizeConfidence(mapping?.confidence)
        || confidenceForHtmlMapping(mapping, manifestPage),
      source_refs: sortStrings(uniqueStrings(sourceRefIds)),
      screenshot_refs: sortStrings(uniqueStrings(screenshotIds)),
      reference_refs: sortStrings(uniqueStrings(referenceIds)),
      ...(isNonEmptyString(mapping?.notes) ? { notes: mapping.notes } : {}),
      _reference_records: referenceRegistry.values(),
    });
  }

  const htmlReferenceRefs = [];
  for (const mapping of htmlCoverage) {
    htmlReferenceRefs.push(...mapping._reference_records);
    delete mapping._reference_records;
  }
  const htmlContribution = {
    id: "html-funnel",
    kind: "html_funnel",
    trust: manifestInput.value ? "structured" : "rendered",
    renderable: true,
    provenance: compactDefined({
      source_type: "html_funnel",
      adapter: "source-html-intake",
      producer: optionalString(manifestInput.value?.producer_provenance?.source_type),
      generator: optionalString(manifestInput.value?.generator),
      generator_version: optionalString(manifestInput.value?.producer_provenance?.generator_version),
      source_root: optionalString(sourceRoot),
      manifest_schema_version: optionalString(manifestInput.value?.schema_version),
      manifest_path: optionalString(manifestInput.path),
      manifest_sha256: validSha(manifestInput.value?.sha256),
      producer_material_fingerprint: optionalString(manifestInput.value?.producer_provenance?.material_fingerprint),
      asset_crawl_schema_version: optionalString(crawl?.schema_version),
    }, { preserveNull: true }),
    presentation_intent: normalizePresentationIntent(
      presentationIntent,
      "Preserve the provided source HTML composition and presentation intent while CampaignSpec and Page Kit retain commerce/runtime authority.",
    ),
    source_refs: sourceRefRegistry.values(),
    screenshot_refs: globalVisualRegistry.values(),
    reference_refs: dedupeRecordsById(htmlReferenceRefs),
    mappings: htmlCoverage,
  };

  const contributions = [htmlContribution];
  const template = normalizeTemplateFamily(templateFamily);
  const qualifyingHtmlSurfaces = new Set(
    htmlCoverage
      .filter((mapping) => mapping.coverage_role === "primary_design" && ["high", "medium"].includes(mapping.confidence))
      .map((mapping) => mapping.surface_id),
  );
  const explicitTemplateSurfaces = new Set(
    pages
      .filter((page) => page.mapping?.coverage_role === "template_baseline")
      .map((page) => surfaceByPageId.get(page.pageId)),
  );
  const templateCandidateSurfaces = surfaces
    .filter((surface) => surface.kind === "page")
    .map((surface) => surface.id)
    .filter((surfaceId) => explicitTemplateSurfaces.has(surfaceId) || !qualifyingHtmlSurfaces.has(surfaceId));
  const templateProof = normalizeTemplateReference(template);
  const templateProofAssessment = assessTemplateReference(templateProof);

  if (template.family) {
    const referenceRefs = templateProof?.standard_viewport_refs || [];
    const templateContribution = {
      id: "template-baseline",
      kind: "template_stock",
      trust: "native",
      renderable: true,
      provenance: {
        source_type: "template_stock",
        adapter: "template-reference",
        producer: "Campaign Page Kit",
        generator: null,
        generator_version: template.version || null,
        source_root: null,
        manifest_schema_version: null,
        manifest_path: null,
        manifest_sha256: null,
        producer_material_fingerprint: null,
        asset_crawl_schema_version: null,
      },
      presentation_intent: normalizePresentationIntent(
        template.presentation_intent,
        `Use the ${template.family} Template Reference only as the safe runtime baseline for explicitly template-backed pages.`,
      ),
      source_refs: templateSourceRefs(templateProof),
      screenshot_refs: [],
      reference_refs: referenceRefs,
      ...(templateProof ? { template_reference: templateProof } : {}),
      mappings: templateProofAssessment.complete
        ? templateCandidateSurfaces.map((surfaceId) => ({
          id: `template-${surfaceId}-coverage`,
          surface_id: surfaceId,
          coverage_role: "template_baseline",
          confidence: "high",
          source_refs: templateSourceRefs(templateProof).map((ref) => ref.id),
          screenshot_refs: [],
          reference_refs: referenceRefs.map((ref) => ref.id),
          template_reference_id: templateProof.id,
        }))
        : [],
    };
    contributions.push(templateContribution);
  }

  const clonedGaps = cloneJsonArray(sourceGaps);
  const clonedWaivers = cloneJsonArray(waivers);
  const generatedTodos = cloneJsonArray(sourceTodos);
  const now = Date.parse(generatedAt);
  const readinessNow = Number.isNaN(now) ? Date.now() : now;
  const existingTodoIds = new Set(generatedTodos.map((todo) => todo?.id).filter(isNonEmptyString));
  const addTodo = (todo) => {
    todo.id = uniqueRecordId(todo.id, existingTodoIds);
    generatedTodos.push(todo);
  };

  for (const surface of surfaces.filter((entry) => entry.kind === "page")) {
    const primaryClaims = coverageClaimsForSurface(contributions, surface.id)
      .filter(({ mapping }) => mapping.coverage_role === "primary_design");
    const qualifyingPrimaryClaims = sortCoverageClaims(primaryClaims
      .filter(({ mapping }) => ["high", "medium"].includes(mapping.confidence)));
    const coverageExcepted = hasCoverageException(
      clonedGaps,
      clonedWaivers,
      surface.id,
      readinessNow,
      "primary_coverage",
    );
    if (qualifyingPrimaryClaims.length) {
      if (qualifyingPrimaryClaims.some(primaryClaimHasRequiredProof)) continue;
      if (hasCoverageException(clonedGaps, clonedWaivers, surface.id, readinessNow, "source_screenshot")) continue;
      const primary = bestPrimaryClaimForTodo(qualifyingPrimaryClaims);
      const missingViewports = missingRequiredViewportsForPrimaryClaim(primary);
      for (const viewport of missingViewports) {
        addTodo({
          id: `capture-${surface.id}-${viewport}`,
          kind: "missing_source_screenshot",
          scope: "source_screenshot",
          applies_to: [surface.id],
          description: `Capture an explicit ${viewport} source screenshot for renderable primary design surface "${surface.id}".`,
          status: "blocked",
          owner: "source_preparation",
          required_viewports: [viewport],
          source_ref_ids: primary.mapping.source_refs,
        });
      }
      continue;
    }
    if (coverageExcepted) continue;

    if (primaryClaims.some(({ mapping }) => ["low", "unknown"].includes(mapping.confidence))) {
      addTodo({
        id: `confirm-${surface.id}-primary-design`,
        kind: "low_confidence_primary_design",
        scope: "primary_design_coverage",
        applies_to: [surface.id],
        description: `Confirm the primary design mapping for page surface "${surface.id}" at medium or high confidence.`,
        status: "blocked",
        owner: "source_preparation",
      });
      continue;
    }

    if (template.family && templateCandidateSurfaces.includes(surface.id) && !templateProofAssessment.complete) {
      if (!templateProofAssessment.linked) {
        addTodo({
          id: `link-${surface.id}-template-reference`,
          kind: "missing_template_reference",
          scope: "template_reference",
          applies_to: [surface.id],
          description: `Link ${template.family} family/version to a Template Reference artifact or contract before claiming template_baseline coverage.`,
          status: "blocked",
          owner: "source_preparation",
        });
      } else {
        for (const viewport of templateProofAssessment.missing_viewports) {
          addTodo({
            id: `capture-${surface.id}-template-${viewport}`,
            kind: "missing_template_viewport",
            scope: "template_reference",
            applies_to: [surface.id],
            description: `Provide the ${viewport} standard viewport reference for ${template.family} before claiming template_baseline coverage for "${surface.id}".`,
            status: "blocked",
            owner: "source_preparation",
            required_viewports: [viewport],
          });
        }
      }
      continue;
    }

    if (!coverageClaimsForSurface(contributions, surface.id).some(({ mapping }) => mapping.coverage_role === "template_baseline")) {
      addTodo({
        id: `provide-${surface.id}-primary-design`,
        kind: "missing_primary_design",
        scope: "primary_design_coverage",
        applies_to: [surface.id],
        description: `Provide primary design coverage, a proven Template Reference baseline, an attributed Source Gap, or an approved waiver for page surface "${surface.id}".`,
        status: "blocked",
        owner: "source_preparation",
      });
    }
  }

  const artifact = {
    schema_version: DESIGN_SOURCE_PACKAGE_SCHEMA,
    package_id: String(packageId || "design-source-package"),
    source_kind: "html_funnel",
    generated_at: String(generatedAt),
    material_fingerprint: `${MATERIAL_FINGERPRINT_PREFIX}${"0".repeat(64)}`,
    surface_identity: surfaces,
    contributions,
    source_gaps: clonedGaps,
    source_todos: generatedTodos,
    waivers: clonedWaivers,
    divergences: cloneJsonArray(divergences),
    proposed_exceptions: cloneJsonArray(proposedExceptions),
    notes: notes.map((note) => String(note)),
    readiness: null,
    readback: null,
  };
  artifact.readiness = evaluateDesignSourcePackageReadiness(artifact, {
    generatedAt: String(generatedAt),
    now: readinessNow,
  });
  artifact.readback = generateDesignSourcePackageReadback(artifact);
  artifact.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(artifact);
  return artifact;
}

export const createHtmlFunnelDesignSourcePackage = synthesizeHtmlFunnelDesignSourcePackage;
export const createDesignSourcePackage = synthesizeHtmlFunnelDesignSourcePackage;
export const createDesignSourcePackageArtifact = synthesizeHtmlFunnelDesignSourcePackage;

export function evaluateDesignSourcePackageReadiness(value, {
  generatedAt = value?.generated_at || new Date().toISOString(),
  now = Date.now(),
} = {}) {
  const surfaces = arrayOrEmpty(value?.surface_identity);
  const pageSurfaces = surfaces.filter((surface) => surface?.kind === "page");
  const contributions = arrayOrEmpty(value?.contributions);
  const gaps = arrayOrEmpty(value?.source_gaps);
  const todos = arrayOrEmpty(value?.source_todos);
  const waivers = arrayOrEmpty(value?.waivers);
  const blockingReasons = [];

  if (pageSurfaces.length === 0) {
    blockingReasons.push("No page-level Surface Identity is available for source-readiness evaluation.");
  }

  for (const surface of pageSurfaces) {
    const claims = coverageClaimsForSurface(contributions, surface.id);
    const primaryClaims = sortCoverageClaims(claims.filter(({ mapping }) =>
      mapping.coverage_role === "primary_design" && ["high", "medium"].includes(mapping.confidence)));
    const validPrimary = primaryClaims.some(primaryClaimHasRequiredProof);
    const validBaseline = claims.some(({ contribution, mapping }) =>
      mapping.coverage_role === "template_baseline"
      && templateMappingHasProof(contribution, mapping));
    const coverageExcepted = hasCoverageException(gaps, waivers, surface.id, now, "primary_coverage");

    if (!primaryClaims.length && !validBaseline && !coverageExcepted) {
      const lowClaim = claims.find(({ mapping }) =>
        mapping.coverage_role === "primary_design" && ["low", "unknown"].includes(mapping.confidence));
      blockingReasons.push(lowClaim
        ? `Page surface "${surface.id}" has only low or unknown confidence primary_design coverage.`
        : `Page surface "${surface.id}" lacks non-low primary_design, proven template_baseline, an accepted Source Gap, or an approved waiver.`);
    }

    if (primaryClaims.length && !validPrimary
      && !hasCoverageException(gaps, waivers, surface.id, now, "source_screenshot")) {
      blockingReasons.push(`Renderable primary_design surface "${surface.id}" has no qualifying claim with linked desktop and mobile source_screenshot proof.`);
    }
  }

  for (const todo of todos) {
    if (todo?.status === "completed") continue;
    if (hasActiveWaiverForRecord(waivers, todo, now)) continue;
    blockingReasons.push(`Source TODO "${todo?.id || "unknown"}" is ${todo?.status}.`);
  }
  for (const gap of gaps) {
    if (gap?.status === "proposed") {
      blockingReasons.push(`Source Gap "${gap.id || "unknown"}" remains proposed and unattributed as accepted coverage.`);
    }
  }
  for (const divergence of arrayOrEmpty(value?.divergences)) {
    if (divergence?.readiness_affecting === true && divergence?.status === "proposed") {
      blockingReasons.push(`Readiness-affecting Source Divergence "${divergence.id || "unknown"}" remains proposed.`);
    }
  }
  for (const exception of arrayOrEmpty(value?.proposed_exceptions)) {
    if (exception?.readiness_affecting === true && exception?.status === "proposed") {
      blockingReasons.push(`Readiness-affecting proposed exception "${exception.id || "unknown"}" is not accepted.`);
    }
  }

  const uniqueBlockingReasons = uniqueStrings(blockingReasons);
  const activeWaivers = waivers.filter((waiver) => isActiveApprovedWaiver(waiver, now));
  const acceptedGaps = gaps.filter((gap) => gap?.status === "accepted");
  const status = pageSurfaces.length === 0
    ? "pending"
    : uniqueBlockingReasons.length
      ? "blocked"
      : activeWaivers.length
        ? "ready_with_waivers"
        : acceptedGaps.length
          ? "ready_with_gaps"
          : "ready";

  return {
    status,
    blocking_reasons: uniqueBlockingReasons,
    gap_count: gaps.length,
    todo_count: todos.length,
    waiver_count: waivers.length,
    generated_at: String(generatedAt),
  };
}

export function generateDesignSourcePackageReadback(value) {
  const readiness = value?.readiness || evaluateDesignSourcePackageReadiness(value);
  const contributions = arrayOrEmpty(value?.contributions);
  const gaps = arrayOrEmpty(value?.source_gaps);
  const todos = arrayOrEmpty(value?.source_todos);
  const waivers = arrayOrEmpty(value?.waivers);
  const handled = [];
  for (const contribution of contributions) {
    for (const mapping of arrayOrEmpty(contribution?.mappings)) {
      handled.push(`${mapping.surface_id}: ${mapping.coverage_role} (${mapping.confidence}) via ${contribution.id}`);
    }
  }
  const nextActions = arrayOrEmpty(readiness.blocking_reasons).length
    ? arrayOrEmpty(readiness.blocking_reasons).map((reason) => `Resolve: ${reason}`)
    : ["Proceed to Build with this Design Source Package material fingerprint."];
  return {
    summary: `Design Source Package is ${readiness.status}; ${contributions.length} contribution(s), ${handled.length} coverage mapping(s), ${gaps.length} gap(s), ${todos.length} TODO(s), and ${waivers.length} waiver(s).`,
    included_sources: sortStrings(contributions.map((contribution) => `${contribution.id} (${contribution.kind})`)),
    handled: sortStrings(handled),
    blockers: sortStrings(arrayOrEmpty(readiness.blocking_reasons)),
    gaps: sortStrings(gaps.map((gap) => `${gap.id}: ${gap.reason}`)),
    todos: sortStrings(todos.map((todo) => `${todo.id}: ${todo.description}`)),
    waivers: sortStrings(waivers.map((waiver) => `${waiver.id}: ${waiver.reason}`)),
    next_actions: sortStrings(nextActions),
  };
}

/**
 * Explicit v0 material projection. It intentionally does not spread whole
 * records: generated_at, readiness/readback prose, notes, key order, and visual
 * captured_at are administrative. Every ADR-0001 material class is listed
 * below. A fingerprint is always `sha256:` followed by 64 lowercase hex chars.
 */
export function designSourcePackageMaterialProjection(value) {
  if (!isObject(value)) throw new TypeError("Design Source Package must be an object.");
  return {
    schema_version: value.schema_version,
    source_kind: value.source_kind,
    surface_identity: arrayOrEmpty(value.surface_identity)
      .map(projectSurfaceIdentity)
      .sort(compareById),
    contributions: arrayOrEmpty(value.contributions)
      .map(projectContribution)
      .sort(compareById),
    source_gaps: arrayOrEmpty(value.source_gaps)
      .map(projectGap)
      .sort(compareById),
    source_todos: arrayOrEmpty(value.source_todos)
      .map(projectTodo)
      .sort(compareById),
    accepted_waivers: arrayOrEmpty(value.waivers)
      .filter((waiver) => waiver?.status === "approved")
      .map(projectWaiver)
      .sort(compareById),
    readiness_affecting_divergences: arrayOrEmpty(value.divergences)
      .filter((divergence) => divergence?.readiness_affecting === true)
      .map(projectDivergence)
      .sort(compareById),
    readiness_affecting_exceptions: arrayOrEmpty(value.proposed_exceptions)
      .filter((exception) => exception?.readiness_affecting === true)
      .map(projectException)
      .sort(compareById),
  };
}

export const createDesignSourcePackageMaterialProjection = designSourcePackageMaterialProjection;

export function computeDesignSourcePackageMaterialFingerprint(value) {
  const canonical = canonicalJson(designSourcePackageMaterialProjection(value));
  return `${MATERIAL_FINGERPRINT_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

export const designSourcePackageMaterialFingerprint = computeDesignSourcePackageMaterialFingerprint;

export function serializeDesignSourcePackage(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function hashDesignSourcePackage(value) {
  return hashSerializedDesignSourcePackage(serializeDesignSourcePackage(value));
}

export function hashSerializedDesignSourcePackage(serialized) {
  if (!(typeof serialized === "string" || serialized instanceof Uint8Array || serialized instanceof ArrayBuffer)) {
    throw new TypeError("Serialized Design Source Package must be a string, Uint8Array, or ArrayBuffer of exact artifact bytes.");
  }
  const bytes = serialized instanceof ArrayBuffer ? new Uint8Array(serialized) : serialized;
  return `${MATERIAL_FINGERPRINT_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

export function serializeAndHashDesignSourcePackage(value) {
  const serialized = serializeDesignSourcePackage(value);
  return {
    serialized,
    sha256: hashSerializedDesignSourcePackage(serialized),
    material_fingerprint: computeDesignSourcePackageMaterialFingerprint(value),
  };
}

export function createDesignSourcePackageArtifactReference(value, {
  path = DESIGN_SOURCE_PACKAGE_REL_PATH,
  serialized = null,
} = {}) {
  return {
    path,
    schema_version: DESIGN_SOURCE_PACKAGE_SCHEMA,
    sha256: serialized == null ? hashDesignSourcePackage(value) : hashSerializedDesignSourcePackage(serialized),
    material_fingerprint: computeDesignSourcePackageMaterialFingerprint(value),
  };
}

export function validateDesignSourcePackage(value, {
  now = Date.now(),
  verifyFingerprint = true,
  currentPageScope = null,
  currentHtmlFunnelScope = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!checkStrictObject(value, "$", TOP_LEVEL_FIELDS, [
    "schema_version",
    "package_id",
    "source_kind",
    "generated_at",
    "material_fingerprint",
    "surface_identity",
    "contributions",
    "source_gaps",
    "source_todos",
    "waivers",
    "divergences",
    "proposed_exceptions",
    "notes",
    "readiness",
    "readback",
  ], add)) return { ok: false, errors, warnings };

  if (value.schema_version !== DESIGN_SOURCE_PACKAGE_SCHEMA) {
    add("design_source_package.schema_version", "$.schema_version", `schema_version must be ${DESIGN_SOURCE_PACKAGE_SCHEMA}.`);
  }
  checkNonEmptyString(value.package_id, "$.package_id", add);
  checkNonEmptyString(value.source_kind, "$.source_kind", add);
  checkNonEmptyString(value.generated_at, "$.generated_at", add);
  if (!DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN.test(value.material_fingerprint || "")) {
    add("design_source_package.material_fingerprint", "$.material_fingerprint", "material_fingerprint must use sha256:<64 lowercase hex>." );
  }

  validateStringArray(value.notes, "$.notes", add);
  const surfaces = validateArray(value.surface_identity, "$.surface_identity", add);
  const surfaceIds = new Set();
  let campaignCount = 0;
  surfaces.forEach((surface, index) => {
    const path = `$.surface_identity[${index}]`;
    if (!validateSurface(surface, path, add)) return;
    if (surfaceIds.has(surface.id)) add("design_source_package.surface_id_duplicate", `${path}.id`, `Duplicate Surface Identity id "${surface.id}".`);
    surfaceIds.add(surface.id);
    if (surface.id === "campaign" && surface.kind === "campaign") campaignCount += 1;
    if (surface.id === "campaign" && surface.kind !== "campaign") {
      add("design_source_package.campaign_surface_kind", `${path}.kind`, "Reserved Surface Identity campaign must use kind campaign.");
    }
    if (surface.kind === "campaign" && surface.id !== "campaign") {
      add("design_source_package.campaign_surface_id", `${path}.id`, "kind campaign is reserved for Surface Identity id campaign.");
    }
  });
  if (campaignCount !== 1) {
    add("design_source_package.campaign_surface", "$.surface_identity", "Exactly one reserved {id: campaign, kind: campaign} Surface Identity is required.");
  }
  if (currentPageScope != null) {
    validateCurrentPageScope(value, currentPageScope, add);
  }
  if (currentHtmlFunnelScope != null) {
    validateCurrentHtmlFunnelScope(value, currentHtmlFunnelScope, add);
  }

  const contributions = validateArray(value.contributions, "$.contributions", add);
  const contributionIds = new Set();
  contributions.forEach((contribution, index) => {
    const path = `$.contributions[${index}]`;
    if (!validateContribution(contribution, path, surfaceIds, add)) return;
    if (contributionIds.has(contribution.id)) add("design_source_package.contribution_id_duplicate", `${path}.id`, `Duplicate contribution id "${contribution.id}".`);
    contributionIds.add(contribution.id);
  });

  validateRecordArray(value.source_gaps, "$.source_gaps", GAP_FIELDS,
    ["id", "kind", "scope", "applies_to", "reason", "status", "attributed_by"], add,
    (record, path) => validateGap(record, path, surfaceIds, add));
  validateRecordArray(value.source_todos, "$.source_todos", TODO_FIELDS,
    ["id", "kind", "scope", "applies_to", "description", "status", "owner"], add,
    (record, path) => validateTodo(record, path, surfaceIds, add));
  validateRecordArray(value.waivers, "$.waivers", WAIVER_FIELDS,
    ["id", "scope", "applies_to", "reason", "status", "waived_by", "waived_at"], add,
    (record, path) => validateWaiver(record, path, add));
  validateRecordArray(value.divergences, "$.divergences", DIVERGENCE_FIELDS,
    ["id", "scope", "applies_to", "summary", "status", "recorded_stage", "readiness_affecting", "attributed_by"], add,
    (record, path) => validateDivergence(record, path, surfaceIds, add));
  validateRecordArray(value.proposed_exceptions, "$.proposed_exceptions", EXCEPTION_FIELDS,
    ["id", "scope", "applies_to", "reason", "status", "readiness_affecting", "proposed_by"], add,
    (record, path) => validateException(record, path, surfaceIds, add));
  validateUniqueRecordIds(value.source_gaps, "$.source_gaps", add);
  validateUniqueRecordIds(value.source_todos, "$.source_todos", add);
  validateUniqueRecordIds(value.waivers, "$.waivers", add);
  validateUniqueRecordIds(value.divergences, "$.divergences", add);
  validateUniqueRecordIds(value.proposed_exceptions, "$.proposed_exceptions", add);
  const knownWaiverTargets = collectPackageReferenceIds(value);
  arrayOrEmpty(value.waivers).forEach((waiver, waiverIndex) => {
    arrayOrEmpty(waiver?.applies_to).forEach((target, targetIndex) => {
      if (!knownWaiverTargets.has(target) && !EXTERNAL_WAIVER_TARGETS.has(target)) {
        add(
          "design_source_package.waiver_target_missing",
          `$.waivers[${waiverIndex}].applies_to[${targetIndex}]`,
          `Waiver target "${target}" does not reference a package record, Surface Identity, or supported source-freshness target.`,
        );
      }
    });
  });
  arrayOrEmpty(value.source_todos).forEach((todo, todoIndex) => {
    if (todo?.status === "skipped" && !hasActiveWaiverForRecord(value.waivers, todo, now)) {
      add(
        "design_source_package.todo_skipped_without_waiver",
        `$.source_todos[${todoIndex}].status`,
        "A skipped Source TODO remains blocking unless an approved, scoped waiver targets it or its affected surface.",
      );
    }
  });
  validateReadiness(value.readiness, "$.readiness", add);
  validateReadback(value.readback, "$.readback", add);

  let authoritativeReadiness = null;
  if (isObject(value.readiness)) {
    authoritativeReadiness = evaluateDesignSourcePackageReadiness(value, {
      generatedAt: value.readiness.generated_at,
      now,
    });
    for (const field of ["status", "gap_count", "todo_count", "waiver_count"]) {
      if (value.readiness[field] !== authoritativeReadiness[field]) {
        add("design_source_package.readiness_contradiction", `$.readiness.${field}`, `Generated readiness ${field} must be ${JSON.stringify(authoritativeReadiness[field])}, not ${JSON.stringify(value.readiness[field])}.`);
      }
    }
    if (!sameStringSet(value.readiness.blocking_reasons, authoritativeReadiness.blocking_reasons)) {
      add("design_source_package.readiness_blockers", "$.readiness.blocking_reasons", "blocking_reasons do not match the authoritative package records and coverage semantics.");
    }
  }
  if (isObject(value.readback) && authoritativeReadiness) {
    const expectedReadback = generateDesignSourcePackageReadback({
      ...value,
      readiness: authoritativeReadiness,
    });
    if (canonicalJson(value.readback) !== canonicalJson(expectedReadback)) {
      add("design_source_package.readback_contradiction", "$.readback", "Readback must be generated from the current authoritative package records and readiness summary.");
    }
  }

  if (verifyFingerprint && DESIGN_SOURCE_PACKAGE_FINGERPRINT_PATTERN.test(value.material_fingerprint || "")) {
    const expectedFingerprint = computeDesignSourcePackageMaterialFingerprint(value);
    if (value.material_fingerprint !== expectedFingerprint) {
      add("design_source_package.material_fingerprint_stale", "$.material_fingerprint", `material_fingerprint must be ${expectedFingerprint} for the current material projection.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export const validateDesignSourcePackageArtifact = validateDesignSourcePackage;

function validateCurrentPageScope(value, scope, add) {
  if (!isObject(scope)) {
    add("design_source_package.current_page_scope", "$", "currentPageScope must be an object when supplied.");
    return;
  }
  const activePages = scope.activePages;
  const mappings = scope.mappings;
  if (!Array.isArray(activePages) || !Array.isArray(mappings)) {
    add(
      "design_source_package.current_page_scope",
      "$",
      "currentPageScope requires activePages and mappings arrays.",
    );
    return;
  }

  const validActivePages = activePages.filter((page) => isObject(page) && isNonEmptyString(page.id));
  const validMappings = mappings.filter((mapping) => isObject(mapping) && isNonEmptyString(mapping.page_id));
  const expected = createSurfaceCatalog(collectPageInputs(validActivePages, validMappings), {
    campaignMapId: scope.campaignMapId,
    campaignSlug: scope.campaignSlug,
  }).surfaces;
  const expectedPages = expected.filter((surface) => surface.kind === "page");
  const actualPages = arrayOrEmpty(value?.surface_identity).filter((surface) => surface?.kind === "page");
  const expectedSpecIds = new Set(validActivePages.map((page) => page.id));
  const expectedSourceIds = new Set(validMappings.map((mapping) => mapping.page_id));

  const campaignSurface = arrayOrEmpty(value?.surface_identity)
    .find((surface) => surface?.id === "campaign" && surface?.kind === "campaign");
  for (const [field, expectedValue] of [
    ["campaign_map_id", optionalString(scope.campaignMapId)],
    ["campaign_slug", optionalString(scope.campaignSlug)],
  ]) {
    if (expectedValue && campaignSurface?.mappings?.[field] !== expectedValue) {
      add(
        "design_source_package.current_campaign_identity",
        `$.surface_identity[campaign].mappings.${field}`,
        `Current campaign identity requires ${field} ${JSON.stringify(expectedValue)}.`,
      );
    }
  }

  for (const expectedSurface of expectedPages) {
    const specId = expectedSurface.mappings.campaign_spec_page_id;
    const sourceId = expectedSurface.mappings.source_page_id;
    const matches = actualPages.filter((surface) =>
      (specId && surface?.mappings?.campaign_spec_page_id === specId)
      || (sourceId && surface?.mappings?.source_page_id === sourceId));
    if (matches.length === 0) {
      add(
        "design_source_package.current_page_missing",
        "$.surface_identity",
        `Current active/mapped page ${JSON.stringify(specId || sourceId)} has no page-level Surface Identity.`,
      );
      continue;
    }
    if (matches.length > 1) {
      add(
        "design_source_package.current_page_duplicate",
        "$.surface_identity",
        `Current active/mapped page ${JSON.stringify(specId || sourceId)} resolves to more than one page-level Surface Identity.`,
      );
      continue;
    }
    const actual = matches[0];
    for (const field of [
      "campaign_spec_page_id",
      "map_builder_label",
      "map_builder_custom_name",
      "public_route",
      "producer_page_type",
      "source_page_id",
      "source_path",
      "page_kit",
    ]) {
      if (canonicalJson(actual?.mappings?.[field] ?? null) !== canonicalJson(expectedSurface.mappings[field] ?? null)) {
        add(
          "design_source_package.current_page_mapping_stale",
          `$.surface_identity[${actual?.id || "unknown"}].mappings.${field}`,
          `Current page ${JSON.stringify(specId || sourceId)} requires ${field} ${canonicalJson(expectedSurface.mappings[field] ?? null)}.`,
        );
      }
    }
  }

  for (const surface of actualPages) {
    const specId = optionalString(surface?.mappings?.campaign_spec_page_id);
    const sourceId = optionalString(surface?.mappings?.source_page_id);
    if (specId && !expectedSpecIds.has(specId)) {
      add(
        "design_source_package.current_active_page_stale",
        `$.surface_identity[${surface.id}].mappings.campaign_spec_page_id`,
        `Page Surface Identity references CampaignSpec page ${JSON.stringify(specId)}, which is not active in the current build scope.`,
      );
    }
    if (sourceId && !expectedSourceIds.has(sourceId)) {
      add(
        "design_source_package.current_mapped_page_stale",
        `$.surface_identity[${surface.id}].mappings.source_page_id`,
        `Page Surface Identity references source page ${JSON.stringify(sourceId)}, which is not mapped by the current source intake.`,
      );
    }
  }
}

function validateCurrentHtmlFunnelScope(value, scope, add) {
  if (!isObject(scope)) {
    add(
      "design_source_package.current_html_funnel_scope",
      "$",
      "currentHtmlFunnelScope must be an object when supplied.",
    );
    return;
  }

  let expected;
  try {
    expected = synthesizeHtmlFunnelDesignSourcePackage({
      ...scope,
      generatedAt: value?.generated_at || new Date(0).toISOString(),
    });
  } catch (error) {
    add(
      "design_source_package.current_html_funnel_scope",
      "$",
      `Could not derive the current html_funnel material scope: ${error.message}`,
    );
    return;
  }

  const expectedHtml = expected.contributions.find((contribution) => contribution.kind === "html_funnel");
  const actualHtmlCandidates = arrayOrEmpty(value?.contributions)
    .filter((contribution) => contribution?.kind === "html_funnel");
  if (actualHtmlCandidates.length !== 1) {
    add(
      "design_source_package.current_html_funnel_material_stale",
      "$.contributions",
      `Current html_funnel intake requires exactly one html_funnel contribution; found ${actualHtmlCandidates.length}.`,
    );
    return;
  }
  const actualHtml = actualHtmlCandidates[0];

  if (canonicalJson(projectProvenance(actualHtml.provenance)) !== canonicalJson(projectProvenance(expectedHtml.provenance))) {
    add(
      "design_source_package.current_html_funnel_material_stale",
      `$.contributions[${actualHtml.id}].provenance`,
      "HTML source root, manifest/provenance, or asset-crawl provenance does not match the current prepare-build inputs.",
    );
  }

  const actualRefs = arrayOrEmpty(actualHtml.source_refs);
  for (const expectedRef of arrayOrEmpty(expectedHtml.source_refs)) {
    const matches = actualRefs.filter((actualRef) =>
      optionalString(actualRef?.path) === optionalString(expectedRef?.path)
      && optionalString(actualRef?.url) === optionalString(expectedRef?.url));
    if (!matches.some((actualRef) =>
      canonicalJson(projectCurrentSourceRef(actualRef)) === canonicalJson(projectCurrentSourceRef(expectedRef)))) {
      add(
        "design_source_package.current_source_material_stale",
        `$.contributions[${actualHtml.id}].source_refs`,
        `Current source material ${JSON.stringify(expectedRef.path || expectedRef.url)} is missing or has stale kind, role, or byte hash.`,
      );
    }
  }

  const expectedRefsById = new Map(arrayOrEmpty(expectedHtml.source_refs).map((ref) => [ref.id, ref]));
  const actualRefsById = new Map(actualRefs.map((ref) => [ref?.id, ref]));
  for (const expectedMapping of arrayOrEmpty(expectedHtml.mappings)) {
    const expectedLinkedRefs = arrayOrEmpty(expectedMapping.source_refs)
      .map((id) => expectedRefsById.get(id))
      .filter(Boolean)
      .map(projectCurrentSourceRef);
    const candidates = arrayOrEmpty(actualHtml.mappings).filter((mapping) =>
      mapping?.surface_id === expectedMapping.surface_id
      && mapping?.coverage_role === expectedMapping.coverage_role
      && mapping?.confidence === expectedMapping.confidence);
    const currentMappingExists = candidates.some((mapping) => {
      const actualLinkedRefs = arrayOrEmpty(mapping?.source_refs)
        .map((id) => actualRefsById.get(id))
        .filter(Boolean)
        .map(projectCurrentSourceRef);
      return expectedLinkedRefs.every((expectedRef) =>
        actualLinkedRefs.some((actualRef) => canonicalJson(actualRef) === canonicalJson(expectedRef)));
    });
    if (!currentMappingExists) {
      add(
        "design_source_package.current_html_funnel_material_stale",
        `$.contributions[${actualHtml.id}].mappings`,
        `HTML coverage for current page surface ${JSON.stringify(expectedMapping.surface_id)} is missing or stale.`,
      );
    }
  }

  validateCurrentTemplateMaterial(value, expected, scope.templateFamily, add);
}

function projectCurrentSourceRef(ref) {
  return compactDefined({
    ...pickFields(ref, ["kind", "path", "url", "role", "media_type"]),
    sha256: canonicalHashSpelling(ref?.sha256),
  });
}

function validateCurrentTemplateMaterial(value, expected, templateFamily, add) {
  const expectedTemplate = expected.contributions.find((contribution) => contribution.kind === "template_stock");
  const actualTemplates = arrayOrEmpty(value?.contributions)
    .filter((contribution) => contribution?.kind === "template_stock");
  if (!expectedTemplate) {
    if (actualTemplates.length) {
      add(
        "design_source_package.current_template_material_stale",
        "$.contributions",
        "The Design Source Package selects template-stock material, but current prepare-build inputs do not select a template family.",
      );
    }
    return;
  }

  const normalized = normalizeTemplateFamily(templateFamily);
  const actualTemplate = actualTemplates.find((contribution) => contribution?.id === expectedTemplate.id)
    || (actualTemplates.length === 1 ? actualTemplates[0] : null);
  const declaredFamily = optionalString(actualTemplate?.template_reference?.family);
  const familyMatches = declaredFamily
    ? declaredFamily === normalized.family
    : canonicalJson(actualTemplate?.presentation_intent?.summary)
      === canonicalJson(expectedTemplate.presentation_intent?.summary);
  if (!actualTemplate || !familyMatches) {
    add(
      "design_source_package.current_template_material_stale",
      "$.contributions",
      `Template material does not match current family ${JSON.stringify(normalized.family)}.`,
    );
    return;
  }

  if (expectedTemplate.template_reference) {
    const expectedReference = canonicalJson(projectTemplateReference(expectedTemplate.template_reference));
    if (canonicalJson(projectTemplateReference(actualTemplate.template_reference)) !== expectedReference) {
      add(
        "design_source_package.current_template_material_stale",
        "$.contributions",
        "Template Reference material does not match the current family/version/reference inputs.",
      );
    }
  }
}

function projectSurfaceIdentity(surface) {
  return compactDefined({
    id: surface?.id,
    kind: surface?.kind,
    label: surface?.label,
    aliases: sortStrings(uniqueStrings(arrayOrEmpty(surface?.aliases))),
    mappings: pickFields(surface?.mappings, [...SURFACE_MAPPING_FIELDS]),
  });
}

function projectContribution(contribution) {
  return compactDefined({
    id: contribution?.id,
    kind: contribution?.kind,
    trust: contribution?.trust,
    renderable: contribution?.renderable,
    provenance: projectProvenance(contribution?.provenance),
    presentation_intent: pickFields(contribution?.presentation_intent, [...PRESENTATION_INTENT_FIELDS]),
    source_refs: arrayOrEmpty(contribution?.source_refs).map(projectSourceRef).sort(compareById),
    screenshot_refs: arrayOrEmpty(contribution?.screenshot_refs).map(projectVisualRef).sort(compareById),
    reference_refs: arrayOrEmpty(contribution?.reference_refs).map(projectVisualRef).sort(compareById),
    template_reference: contribution?.template_reference ? projectTemplateReference(contribution.template_reference) : undefined,
    mappings: arrayOrEmpty(contribution?.mappings).map(projectCoverageMapping).sort(compareById),
  });
}

function projectSourceRef(ref) {
  return compactDefined({
    ...pickFields(ref, ["id", "kind", "path", "url", "role", "media_type"]),
    sha256: canonicalHashSpelling(ref?.sha256),
  });
}

function projectVisualRef(ref) {
  return compactDefined({
    ...pickFields(ref, [
    "id",
    "kind",
    "viewport",
    "availability",
    "url",
    "path",
    "width",
    "height",
    "device_profile",
    "scale_factor",
    "browser",
    "source_ref_id",
    "unavailable_reason",
    ]),
    sha256: canonicalHashSpelling(ref?.sha256),
  });
}

function projectTemplateReference(reference) {
  return compactDefined({
    ...pickFields(reference, ["id", "family", "version", "contract_path", "artifact_path"]),
    sha256: canonicalHashSpelling(reference?.sha256),
    standard_viewport_refs: arrayOrEmpty(reference?.standard_viewport_refs)
      .map(projectVisualRef)
      .sort(compareById),
  });
}

function projectProvenance(provenance) {
  return compactDefined({
    ...pickFields(provenance, [
      "source_type",
      "adapter",
      "producer",
      "generator",
      "generator_version",
      "source_root",
      "manifest_schema_version",
      "manifest_path",
      "asset_crawl_schema_version",
    ]),
    manifest_sha256: canonicalHashSpelling(provenance?.manifest_sha256),
    producer_material_fingerprint: canonicalProducerMaterialFingerprint(
      provenance?.producer_material_fingerprint,
    ),
  });
}

function projectCoverageMapping(mapping) {
  return compactDefined({
    id: mapping?.id,
    surface_id: mapping?.surface_id,
    coverage_role: mapping?.coverage_role,
    confidence: mapping?.confidence,
    source_refs: sortStrings(uniqueStrings(arrayOrEmpty(mapping?.source_refs))),
    screenshot_refs: sortStrings(uniqueStrings(arrayOrEmpty(mapping?.screenshot_refs))),
    reference_refs: sortStrings(uniqueStrings(arrayOrEmpty(mapping?.reference_refs))),
    template_reference_id: mapping?.template_reference_id,
  });
}

function projectGap(gap) {
  return compactDefined({
    ...pickFields(gap, ["id", "kind", "scope", "reason", "status", "attributed_by", "attributed_at"]),
    applies_to: sortStrings(uniqueStrings(arrayOrEmpty(gap?.applies_to))),
    evidence_refs: sortStrings(uniqueStrings(arrayOrEmpty(gap?.evidence_refs))),
  });
}

function projectTodo(todo) {
  return compactDefined({
    ...pickFields(todo, ["id", "kind", "scope", "description", "status", "owner"]),
    applies_to: sortStrings(uniqueStrings(arrayOrEmpty(todo?.applies_to))),
    required_viewports: sortStrings(uniqueStrings(arrayOrEmpty(todo?.required_viewports))),
    source_ref_ids: sortStrings(uniqueStrings(arrayOrEmpty(todo?.source_ref_ids))),
  });
}

function projectWaiver(waiver) {
  return compactDefined({
    ...pickFields(waiver, ["id", "scope", "reason", "status", "waived_by", "waived_at", "expires_at", "review_condition"]),
    applies_to: sortStrings(uniqueStrings(arrayOrEmpty(waiver?.applies_to))),
    evidence_refs: sortStrings(uniqueStrings(arrayOrEmpty(waiver?.evidence_refs))),
  });
}

function projectDivergence(divergence) {
  return compactDefined({
    ...pickFields(divergence, ["id", "scope", "summary", "status", "recorded_stage", "readiness_affecting", "attributed_by"]),
    applies_to: sortStrings(uniqueStrings(arrayOrEmpty(divergence?.applies_to))),
    evidence_refs: sortStrings(uniqueStrings(arrayOrEmpty(divergence?.evidence_refs))),
  });
}

function projectException(exception) {
  return compactDefined({
    ...pickFields(exception, ["id", "scope", "reason", "status", "readiness_affecting", "proposed_by"]),
    applies_to: sortStrings(uniqueStrings(arrayOrEmpty(exception?.applies_to))),
    evidence_refs: sortStrings(uniqueStrings(arrayOrEmpty(exception?.evidence_refs))),
  });
}

function collectPageInputs(activePages, mappings) {
  const byId = new Map();
  for (const page of activePages) byId.set(page.id, { pageId: page.id, page, mapping: null });
  for (const mapping of mappings) {
    const current = byId.get(mapping.page_id) || { pageId: mapping.page_id, page: null, mapping: null };
    if (!current.mapping) current.mapping = mapping;
    byId.set(mapping.page_id, current);
  }
  return [...byId.values()];
}

function createSurfaceCatalog(pages, { campaignMapId, campaignSlug }) {
  const surfaces = [{
    id: "campaign",
    kind: "campaign",
    label: "Campaign",
    aliases: uniqueStrings([campaignMapId, campaignSlug].filter(Boolean)),
    mappings: compactDefined({
      campaign_map_id: optionalString(campaignMapId),
      campaign_slug: optionalString(campaignSlug),
    }),
  }];
  const used = new Set(["campaign"]);
  const roleCounts = new Map();
  const surfaceByPageId = new Map();
  pages.forEach(({ pageId, page, mapping }, index) => {
    const role = normalizedPageRole(page?.type || mapping?.page_type);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    let id = SAFE_SURFACE_ID.test(pageId) && pageId !== "campaign"
      ? pageId
      : roleSurfaceId(role, roleCounts.get(role), index + 1);
    id = uniqueSurfaceId(id, used);
    surfaceByPageId.set(pageId, id);
    const pageKit = normalizePageKitProjection(mapping?.page_kit);
    const route = optionalString(pageKit?.public_route)
      || optionalString(page?.page_url)
      || optionalString(page?.url);
    const label = optionalString(page?.label)
      || optionalString(page?.custom_name)
      || optionalString(page?.name)
      || pageId;
    const aliases = uniqueStrings([
      pageId,
      page?.label,
      page?.custom_name,
      page?.name,
      page?.type,
      mapping?.page_type,
      mapping?.path,
      route,
      pageKit?.page_type,
      pageKit?.target_path,
      pageKit?.output_path,
    ].filter(isNonEmptyString));
    surfaces.push({
      id,
      kind: "page",
      label,
      aliases,
      mappings: {
        campaign_spec_page_id: page ? pageId : null,
        map_builder_label: optionalString(page?.label),
        map_builder_custom_name: optionalString(page?.custom_name) || optionalString(page?.name),
        public_route: route,
        producer_page_type: optionalString(mapping?.page_type),
        source_page_id: mapping ? pageId : null,
        source_path: optionalString(mapping?.path),
        page_kit: pageKit,
      },
    });
  });
  return { surfaces, surfaceByPageId };
}

function normalizePageKitProjection(value) {
  if (!isObject(value)) return null;
  if (![value.target_path, value.output_path, value.public_route, value.page_type].every(isNonEmptyString)) return null;
  return compactDefined({
    target_path: value.target_path,
    output_path: value.output_path,
    public_route: value.public_route,
    spec_route: value.spec_route == null ? null : String(value.spec_route),
    page_type: value.page_type,
    permalink_required: typeof value.permalink_required === "boolean" ? value.permalink_required : null,
  }, { preserveNull: true });
}

function normalizeManifestInput(input, explicitPath) {
  if (isObject(input?.manifest)) {
    return { value: input.manifest, path: optionalString(explicitPath) || optionalString(input.path) };
  }
  return { value: isObject(input) ? input : null, path: optionalString(explicitPath) };
}

function normalizePresentationIntent(value, fallbackSummary) {
  const input = isObject(value) ? value : {};
  const out = { summary: optionalString(input.summary) || fallbackSummary };
  for (const field of ["composition", "content_hierarchy", "imagery", "copy", "brand", "responsive_behavior"]) {
    if (Array.isArray(input[field])) out[field] = input[field].filter(isNonEmptyString).map((entry) => entry.trim());
  }
  return out;
}

function normalizeTemplateFamily(value) {
  if (isNonEmptyString(value)) return { family: value.trim(), version: null, reference: null, presentation_intent: null };
  if (!isObject(value)) return { family: null, version: null, reference: null, presentation_intent: null };
  const reference = isObject(value.template_reference)
    ? value.template_reference
    : isObject(value.templateReference)
      ? value.templateReference
      : isObject(value.reference)
        ? value.reference
        : value;
  return {
    family: optionalString(value.family) || optionalString(value.value) || optionalString(value.name) || optionalString(reference.family),
    version: optionalString(value.version) || optionalString(value.commerce_catalog_version) || optionalString(reference.version),
    reference,
    presentation_intent: isObject(value.presentation_intent) ? value.presentation_intent : null,
  };
}

function normalizeTemplateReference(template) {
  if (!template.family || !isObject(template.reference)) return null;
  const raw = template.reference;
  const family = optionalString(raw.family) || template.family;
  const version = optionalString(raw.version) || template.version;
  const contractPath = optionalString(raw.contract_path) || optionalString(raw.contractPath);
  const artifactPath = optionalString(raw.artifact_path) || optionalString(raw.artifactPath);
  if (!version || (!contractPath && !artifactPath)) return null;
  const referenceId = optionalString(raw.id) || `template-reference-${slugify(family)}`;
  const sourceRefId = artifactPath ? `${referenceId}-artifact` : `${referenceId}-contract`;
  const registry = createVisualReferenceRegistry("template_reference_screenshot");
  for (const ref of arrayOrEmpty(raw.standard_viewport_refs || raw.standardViewportRefs)) {
    registry.add(ref, `template-${slugify(family) || "reference"}`, sourceRefId);
  }
  return compactDefined({
    id: referenceId,
    family,
    version,
    contract_path: contractPath,
    artifact_path: artifactPath,
    sha256: validSha(raw.sha256 || raw.hash),
    standard_viewport_refs: registry.values(),
  });
}

function assessTemplateReference(reference, sourceRefs = templateSourceRefs(reference)) {
  if (!reference) {
    return { linked: false, complete: false, missing_viewports: [...REQUIRED_SOURCE_VIEWPORTS] };
  }
  const sourceRefIds = new Set(arrayOrEmpty(sourceRefs).map((ref) => typeof ref === "string" ? ref : ref?.id));
  const available = new Set(arrayOrEmpty(reference.standard_viewport_refs)
    .filter((ref) => ref.kind === "template_reference_screenshot"
      && ref.availability === "available"
      && sourceRefIds.has(ref.source_ref_id))
    .map((ref) => ref.viewport));
  const missing = REQUIRED_SOURCE_VIEWPORTS.filter((viewport) => !available.has(viewport));
  return { linked: true, complete: missing.length === 0, missing_viewports: missing };
}

function templateMappingHasProof(contribution, mapping) {
  const reference = contribution?.template_reference;
  if (!reference || mapping?.template_reference_id !== reference.id) return false;
  return assessTemplateReference(reference, contribution?.source_refs).complete;
}

function templateSourceRefs(reference) {
  if (!reference) return [];
  const refs = [];
  if (reference.contract_path) refs.push({
    id: `${reference.id}-contract`,
    kind: "document",
    path: reference.contract_path,
    ...(reference.sha256 ? { sha256: reference.sha256 } : {}),
    role: "template_reference_contract",
  });
  if (reference.artifact_path) refs.push({
    id: `${reference.id}-artifact`,
    kind: "export",
    path: reference.artifact_path,
    ...(reference.sha256 ? { sha256: reference.sha256 } : {}),
    role: "template_reference_artifact",
  });
  return refs;
}

function coverageClaimsForSurface(contributions, surfaceId) {
  const claims = [];
  for (const contribution of arrayOrEmpty(contributions)) {
    for (const mapping of arrayOrEmpty(contribution?.mappings)) {
      if (mapping?.surface_id === surfaceId) claims.push({ contribution, mapping });
    }
  }
  return claims;
}

function availableViewportsForMapping(contribution, mapping) {
  const ids = new Set(arrayOrEmpty(mapping?.screenshot_refs));
  const sourceIds = new Set(arrayOrEmpty(mapping?.source_refs));
  const contributionSourceIds = new Set(arrayOrEmpty(contribution?.source_refs).map((ref) => ref?.id));
  return new Set(arrayOrEmpty(contribution?.screenshot_refs)
    .filter((ref) => ids.has(ref?.id)
      && ref?.kind === "source_screenshot"
      && ref?.availability === "available"
      && sourceIds.has(ref?.source_ref_id)
      && contributionSourceIds.has(ref?.source_ref_id))
    .map((ref) => ref.viewport)
    .filter((viewport) => VIEWPORTS.has(viewport)));
}

function primaryClaimHasRequiredProof(claim) {
  if (claim?.contribution?.renderable !== true) return true;
  const viewports = availableViewportsForMapping(claim.contribution, claim.mapping);
  return REQUIRED_SOURCE_VIEWPORTS.every((viewport) => viewports.has(viewport));
}

function missingRequiredViewportsForPrimaryClaim(claim) {
  if (claim?.contribution?.renderable !== true) return [];
  const viewports = availableViewportsForMapping(claim.contribution, claim.mapping);
  return REQUIRED_SOURCE_VIEWPORTS.filter((viewport) => !viewports.has(viewport));
}

function sortCoverageClaims(claims) {
  return [...claims].sort((left, right) => compareStrings(
    `${left?.contribution?.id || ""}\u0000${left?.mapping?.id || ""}`,
    `${right?.contribution?.id || ""}\u0000${right?.mapping?.id || ""}`,
  ));
}

function bestPrimaryClaimForTodo(claims) {
  return [...claims].sort((left, right) => {
    const missingDelta = missingRequiredViewportsForPrimaryClaim(left).length
      - missingRequiredViewportsForPrimaryClaim(right).length;
    if (missingDelta !== 0) return missingDelta;
    return compareStrings(
      `${left?.contribution?.id || ""}\u0000${left?.mapping?.id || ""}`,
      `${right?.contribution?.id || ""}\u0000${right?.mapping?.id || ""}`,
    );
  })[0];
}

function hasCoverageException(gaps, waivers, surfaceId, now, purpose) {
  return gaps.some((gap) => gap?.status === "accepted"
      && gapMatchesPurpose(gap, purpose)
      && recordAppliesToSurface(gap, surfaceId))
    || waivers.some((waiver) => isActiveApprovedWaiver(waiver, now)
      && waiverMatchesPurpose(waiver, purpose)
      && recordAppliesToSurface(waiver, surfaceId));
}

function recordAppliesToSurface(record, surfaceId) {
  const appliesTo = arrayOrEmpty(record?.applies_to);
  return appliesTo.includes(surfaceId) || appliesTo.includes("campaign");
}

function hasActiveWaiverForRecord(waivers, record, now) {
  const purpose = purposeForTodo(record);
  return waivers.some((waiver) => isActiveApprovedWaiver(waiver, now)
    && waiverMatchesPurpose(waiver, purpose, record?.scope)
    && (arrayOrEmpty(waiver.applies_to).includes(record?.id)
      || arrayOrEmpty(record?.applies_to).some((surface) => recordAppliesToSurface(waiver, surface))));
}

function gapMatchesPurpose(gap, purpose) {
  if (purpose === "primary_coverage") {
    return ["coverage_absence", "source_limitation"].includes(gap?.kind)
      && PRIMARY_COVERAGE_SCOPES.has(gap?.scope);
  }
  if (purpose === "source_screenshot") {
    return ["screenshot_absence", "source_limitation"].includes(gap?.kind)
      && SOURCE_SCREENSHOT_SCOPES.has(gap?.scope);
  }
  if (purpose === "template_reference") {
    return ["reference_absence", "source_limitation"].includes(gap?.kind)
      && TEMPLATE_REFERENCE_SCOPES.has(gap?.scope);
  }
  return false;
}

function waiverMatchesPurpose(waiver, purpose, recordScope = null) {
  if (purpose === "primary_coverage") return PRIMARY_COVERAGE_SCOPES.has(waiver?.scope);
  if (purpose === "source_screenshot") return SOURCE_SCREENSHOT_SCOPES.has(waiver?.scope);
  if (purpose === "template_reference") return TEMPLATE_REFERENCE_SCOPES.has(waiver?.scope);
  return isNonEmptyString(recordScope) && waiver?.scope === recordScope;
}

function purposeForTodo(todo) {
  if (todo?.kind === "missing_source_screenshot") return "source_screenshot";
  if (["missing_template_reference", "missing_template_viewport"].includes(todo?.kind)) return "template_reference";
  if (["missing_primary_design", "low_confidence_primary_design"].includes(todo?.kind)) return "primary_coverage";
  return "record_scope";
}

function isActiveApprovedWaiver(waiver, now) {
  if (!isObject(waiver) || waiver.status !== "approved") return false;
  if (!isNonEmptyString(waiver.waived_by) || !isNonEmptyString(waiver.waived_at)) return false;
  if (isNonEmptyString(waiver.expires_at)) {
    const expires = Date.parse(waiver.expires_at);
    return !Number.isNaN(expires) && expires > now;
  }
  return isNonEmptyString(waiver.review_condition);
}

function createSourceReferenceRegistry() {
  const records = [];
  const byKey = new Map();
  const usedIds = new Set();
  return {
    add(raw) {
      if (!isObject(raw)) return null;
      const path = optionalString(raw.path);
      const url = optionalString(raw.url);
      if (!path && !url) return null;
      const key = `${path || ""}\u0000${url || ""}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sha256 && validSha(raw.sha256)) existing.sha256 = validSha(raw.sha256);
        if (!existing.role && isNonEmptyString(raw.role)) existing.role = raw.role;
        return existing;
      }
      const id = uniqueRecordId(optionalString(raw.id) || "source-reference", usedIds);
      const record = compactDefined({
        id,
        kind: SOURCE_REF_KINDS.has(raw.kind) ? raw.kind : "other",
        path,
        url,
        sha256: validSha(raw.sha256),
        role: optionalString(raw.role),
        media_type: optionalString(raw.media_type),
        notes: optionalString(raw.notes),
      });
      records.push(record);
      byKey.set(key, record);
      return record;
    },
    findByLocation(path, url) {
      const direct = byKey.get(`${optionalString(path) || ""}\u0000${optionalString(url) || ""}`);
      if (direct) return direct;
      const normalized = optionalString(path) || optionalString(url);
      return records.find((record) => record.path === normalized || record.url === normalized) || null;
    },
    values() {
      return records.sort(compareById);
    },
  };
}

function createVisualReferenceRegistry(defaultKind) {
  const records = [];
  const byId = new Map();
  const byIdentity = new Map();
  const usedIds = new Set();
  return {
    add(raw, idPrefix, defaultSourceRefId = null) {
      const contextualKinds = defaultKind === "source_screenshot"
        ? SOURCE_SCREENSHOT_KINDS
        : defaultKind === "template_reference_screenshot"
          ? TEMPLATE_SCREENSHOT_KINDS
          : COMPARISON_REFERENCE_KINDS;
      if (isNonEmptyString(raw?.kind) && !contextualKinds.has(raw.kind)) return null;
      const normalized = normalizeVisualReference(raw, defaultKind, idPrefix, defaultSourceRefId);
      if (!normalized) return null;
      const explicitId = optionalString(raw?.id);
      const materialIdentity = canonicalJson(projectVisualRef({ ...normalized, id: undefined }));
      const identity = `${explicitId || ""}\u0000${materialIdentity}`;
      if (byIdentity.has(identity)) return byIdentity.get(identity);
      if (explicitId && byId.has(explicitId)) {
        throw new TypeError(`Visual reference id "${explicitId}" is reused for different evidence.`);
      }
      if (!explicitId) {
        const digest = createHash("sha256").update(materialIdentity).digest("hex").slice(0, 16);
        normalized.id = `${idPrefix || "visual"}-${normalized.viewport}-${digest}`;
      }
      normalized.id = uniqueRecordId(normalized.id, usedIds);
      records.push(normalized);
      byId.set(normalized.id, normalized);
      byIdentity.set(identity, normalized);
      return normalized;
    },
    byId(id) {
      return byId.get(id) || null;
    },
    values() {
      return records.sort(compareById);
    },
  };
}

function normalizeVisualReference(raw, defaultKind, idPrefix, defaultSourceRefId = null) {
  if (!isObject(raw)) return null;
  const viewport = optionalString(raw.viewport || raw.viewport_key)?.toLowerCase();
  if (!VIEWPORTS.has(viewport)) return null;
  const path = optionalString(raw.path) || optionalString(raw.artifact_path) || optionalString(raw.file_path);
  const url = optionalString(raw.url) || optionalString(raw.canonical_url);
  const unavailableReason = optionalString(raw.unavailable_reason) || optionalString(raw.reason);
  const availability = raw.availability === "unavailable" || (!path && !url && unavailableReason)
    ? "unavailable"
    : path || url
      ? "available"
      : null;
  if (!availability || (availability === "unavailable" && !unavailableReason)) return null;
  const dimensions = isObject(raw.dimensions) ? raw.dimensions : {};
  const kind = VISUAL_KINDS.has(raw.kind) ? raw.kind : defaultKind;
  const id = optionalString(raw.id)
    || `${idPrefix || "visual"}-${viewport}${availability === "unavailable" ? "-unavailable" : ""}`;
  return compactDefined({
    id,
    kind: availability === "unavailable" && !VISUAL_KINDS.has(raw.kind) ? "unavailable_render" : kind,
    viewport,
    availability,
    url,
    path,
    sha256: validSha(raw.sha256 || raw.artifact_hash || raw.hash),
    width: positiveInteger(raw.width ?? dimensions.width),
    height: positiveInteger(raw.height ?? dimensions.height),
    device_profile: optionalString(raw.device_profile),
    scale_factor: positiveNumber(raw.scale_factor),
    browser: optionalString(raw.browser),
    captured_at: optionalString(raw.captured_at || raw.capture_timestamp),
    source_ref_id: optionalString(raw.source_ref_id) || optionalString(defaultSourceRefId),
    unavailable_reason: unavailableReason,
    notes: optionalString(raw.notes),
  });
}

function visualCandidatesFrom(value, keys) {
  if (!isObject(value)) return [];
  return keys.flatMap((key) => arrayOrEmpty(value[key]));
}

function sectionVisualCandidates(manifest, pageId) {
  const output = [];
  for (const section of arrayOrEmpty(manifest?.producer_provenance?.section_exports)) {
    if (!isObject(section)) continue;
    const sectionPageId = optionalString(section.page_id) || optionalString(section.campaign_spec_page_id);
    if (sectionPageId !== pageId) continue;
    for (const image of arrayOrEmpty(section.images)) {
      // A string export or an object without `viewport`/`viewport_key` is an
      // asset, not source screenshot proof.
      if (isObject(image) && isNonEmptyString(image.viewport || image.viewport_key)) output.push(image);
    }
  }
  return output;
}

function visualCandidateAppliesToPage(ref, pageId, surfaceId) {
  return isObject(ref)
    && (ref.page_id === pageId
      || ref.campaign_spec_page_id === pageId
      || ref.surface_id === surfaceId);
}

function assetReferenceAppliesToPage(ref, pageId) {
  return arrayOrEmpty(ref?.referenced_by).some((source) => arrayOrEmpty(source?.page_ids).includes(pageId));
}

function confidenceForHtmlMapping(mapping, manifestPage) {
  if (manifestPage && manifestPage.path === mapping?.path) return "high";
  return "medium";
}

function sourceReferenceKindForManifestFile(file) {
  if (file.role === "page" || /\.html?$/i.test(file.path || "")) return "html_file";
  if (file.role === "asset") return "asset";
  if (file.role === "export_log") return "export";
  return "other";
}

function normalizedPageRole(type) {
  const normalized = slugify(type || "page");
  if (["landing", "product", "presell", "advertorial"].includes(normalized)) return "landing";
  if (["checkout", "select", "cart"].includes(normalized)) return "checkout";
  if (["upsell", "oto", "one-time-offer"].includes(normalized)) return "upsell";
  if (["downsell", "downsell-offer"].includes(normalized)) return "downsell";
  if (["receipt", "thank-you", "thankyou", "confirmation"].includes(normalized)) return "receipt";
  return normalized || "page";
}

function roleSurfaceId(role, ordinal, fallbackOrdinal) {
  if (["landing", "checkout", "receipt"].includes(role) && ordinal === 1) return role;
  return `${role || "page"}-${ordinal || fallbackOrdinal}`;
}

function uniqueSurfaceId(value, used) {
  const base = SAFE_SURFACE_ID.test(value || "") && value !== "campaign" ? value : "page";
  let candidate = base;
  let ordinal = 2;
  while (used.has(candidate)) candidate = `${base}-${ordinal++}`;
  used.add(candidate);
  return candidate;
}

function uniqueRecordId(value, used) {
  const base = optionalString(value) || "record";
  let candidate = base;
  let ordinal = 2;
  while (used.has(candidate)) candidate = `${base}-${ordinal++}`;
  used.add(candidate);
  return candidate;
}

function normalizeConfidence(value) {
  return MAPPING_CONFIDENCE_LEVELS.includes(value) ? value : null;
}

function validateSurface(surface, path, add) {
  if (!checkStrictObject(surface, path, SURFACE_FIELDS, ["id", "kind", "label", "aliases", "mappings"], add)) return false;
  checkNonEmptyString(surface.id, `${path}.id`, add);
  if (isNonEmptyString(surface.id) && !SAFE_SURFACE_ID.test(surface.id)) add("design_source_package.surface_id", `${path}.id`, "Surface Identity id must be a stable lowercase human-semantic id.");
  checkEnum(surface.kind, SURFACE_KINDS, `${path}.kind`, add);
  checkNonEmptyString(surface.label, `${path}.label`, add);
  validateStringArray(surface.aliases, `${path}.aliases`, add, { unique: true, nonEmpty: true });
  if (checkStrictObject(surface.mappings, `${path}.mappings`, SURFACE_MAPPING_FIELDS, [], add)) {
    for (const field of SURFACE_MAPPING_FIELDS) {
      if (field === "page_kit") continue;
      if (surface.mappings[field] != null && !isNonEmptyString(surface.mappings[field])) {
        add("design_source_package.surface_mapping", `${path}.mappings.${field}`, `${field} must be a non-empty string or null when present.`);
      }
    }
    if (surface.kind === "page") {
      for (const field of [
        "campaign_spec_page_id",
        "map_builder_label",
        "map_builder_custom_name",
        "public_route",
        "producer_page_type",
        "source_page_id",
        "source_path",
        "page_kit",
      ]) {
        if (!Object.hasOwn(surface.mappings, field)) add("design_source_package.page_surface_mapping", `${path}.mappings.${field}`, `Page Surface Identity mappings must preserve the distinct ${field} slot (use null when unavailable).`);
      }
    }
    if (surface.mappings.page_kit != null) validatePageKit(surface.mappings.page_kit, `${path}.mappings.page_kit`, add);
  }
  return true;
}

function validatePageKit(value, path, add) {
  if (!checkStrictObject(value, path, PAGE_KIT_FIELDS, ["target_path", "output_path", "public_route", "page_type"], add)) return;
  for (const field of ["target_path", "output_path", "public_route", "page_type"]) checkNonEmptyString(value[field], `${path}.${field}`, add);
  if (value.spec_route != null && typeof value.spec_route !== "string") add("design_source_package.page_kit", `${path}.spec_route`, "spec_route must be a string or null.");
  if (value.permalink_required != null && typeof value.permalink_required !== "boolean") add("design_source_package.page_kit", `${path}.permalink_required`, "permalink_required must be a boolean or null.");
}

function validateContribution(contribution, path, surfaceIds, add) {
  if (!checkStrictObject(contribution, path, CONTRIBUTION_FIELDS, [
    "id", "kind", "trust", "renderable", "provenance", "presentation_intent",
    "source_refs", "screenshot_refs", "reference_refs", "mappings",
  ], add)) return false;
  checkNonEmptyString(contribution.id, `${path}.id`, add);
  checkEnum(contribution.kind, CONTRIBUTION_KINDS, `${path}.kind`, add);
  checkEnum(contribution.trust, CONTRIBUTION_TRUST, `${path}.trust`, add);
  if (typeof contribution.renderable !== "boolean") add("design_source_package.contribution_renderable", `${path}.renderable`, "renderable must be a boolean.");
  validateProvenance(contribution.provenance, `${path}.provenance`, add);
  validatePresentationIntent(contribution.presentation_intent, `${path}.presentation_intent`, add);
  const sourceRefs = validateArray(contribution.source_refs, `${path}.source_refs`, add);
  const screenshotRefs = validateArray(contribution.screenshot_refs, `${path}.screenshot_refs`, add);
  const referenceRefs = validateArray(contribution.reference_refs, `${path}.reference_refs`, add);
  const sourceIds = validateReferenceArray(sourceRefs, `${path}.source_refs`, "source", add);
  const screenshotIds = validateReferenceArray(screenshotRefs, `${path}.screenshot_refs`, "source_visual", add, sourceIds);
  const referenceIds = validateReferenceArray(referenceRefs, `${path}.reference_refs`, "comparison_visual", add, sourceIds);
  if (contribution.template_reference != null) validateTemplateReference(contribution.template_reference, `${path}.template_reference`, add, sourceIds);
  if (contribution.notes != null && typeof contribution.notes !== "string") add("design_source_package.notes", `${path}.notes`, "notes must be a string or null.");
  const mappings = validateArray(contribution.mappings, `${path}.mappings`, add);
  const mappingIds = new Set();
  mappings.forEach((mapping, index) => {
    const mappingPath = `${path}.mappings[${index}]`;
    if (!validateCoverageMapping(mapping, mappingPath, add)) return;
    if (mappingIds.has(mapping.id)) add("design_source_package.mapping_id_duplicate", `${mappingPath}.id`, `Duplicate mapping id "${mapping.id}" within contribution.`);
    mappingIds.add(mapping.id);
    if (!surfaceIds.has(mapping.surface_id)) add("design_source_package.mapping_surface_ref", `${mappingPath}.surface_id`, `Unknown Surface Identity "${mapping.surface_id}".`);
    validateIdReferences(mapping.source_refs, sourceIds, `${mappingPath}.source_refs`, "source reference", add);
    validateIdReferences(mapping.screenshot_refs, screenshotIds, `${mappingPath}.screenshot_refs`, "screenshot reference", add);
    validateIdReferences(mapping.reference_refs, referenceIds, `${mappingPath}.reference_refs`, "reference", add);
    if (mapping.coverage_role === "template_baseline") {
      if (!contribution.template_reference) {
        add("design_source_package.template_baseline_reference", mappingPath, "template_baseline coverage requires contribution.template_reference proof.");
      } else if (mapping.template_reference_id !== contribution.template_reference.id) {
        add("design_source_package.template_baseline_link", `${mappingPath}.template_reference_id`, "template_reference_id must match the contribution Template Reference id.");
      } else if (!assessTemplateReference(contribution.template_reference, contribution.source_refs).complete) {
        add("design_source_package.template_baseline_viewports", mappingPath, "template_baseline proof requires available desktop and mobile standard viewport refs.");
      }
    }
  });
  return true;
}

function validateProvenance(value, path, add) {
  if (!checkStrictObject(value, path, PROVENANCE_FIELDS, ["source_type", "adapter"], add)) return;
  checkNonEmptyString(value.source_type, `${path}.source_type`, add);
  checkNonEmptyString(value.adapter, `${path}.adapter`, add);
  for (const field of PROVENANCE_FIELDS) {
    if (["source_type", "adapter", "manifest_sha256"].includes(field)) continue;
    if (value[field] != null && !isNonEmptyString(value[field])) add("design_source_package.provenance", `${path}.${field}`, `${field} must be a non-empty string or null.`);
  }
  if (value.manifest_sha256 != null && !SHA256_PATTERN.test(value.manifest_sha256)) add("design_source_package.sha256", `${path}.manifest_sha256`, "manifest_sha256 must be a sha256 digest or null.");
}

function validatePresentationIntent(value, path, add) {
  if (!checkStrictObject(value, path, PRESENTATION_INTENT_FIELDS, ["summary"], add)) return;
  checkNonEmptyString(value.summary, `${path}.summary`, add);
  for (const field of PRESENTATION_INTENT_FIELDS) {
    if (field !== "summary" && value[field] != null) validateStringArray(value[field], `${path}.${field}`, add, { nonEmpty: true });
  }
}

function validateReferenceArray(records, path, kind, add, sourceIds = new Set()) {
  const ids = new Set();
  records.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (kind === "source") validateSourceReference(record, recordPath, add);
    else {
      validateVisualReference(record, recordPath, add);
      const allowedKinds = kind === "source_visual"
        ? SOURCE_SCREENSHOT_KINDS
        : kind === "template_visual"
          ? TEMPLATE_SCREENSHOT_KINDS
          : COMPARISON_REFERENCE_KINDS;
      if (isObject(record) && !allowedKinds.has(record.kind)) {
        add("design_source_package.visual_kind_context", `${recordPath}.kind`, `${record.kind} is not valid in ${kind} evidence.`);
      }
      if (isNonEmptyString(record?.source_ref_id) && !sourceIds.has(record.source_ref_id)) {
        add("design_source_package.visual_source_ref", `${recordPath}.source_ref_id`, `Unknown source reference id "${record.source_ref_id}".`);
      }
    }
    if (isNonEmptyString(record?.id)) {
      if (ids.has(record.id)) add("design_source_package.reference_id_duplicate", `${recordPath}.id`, `Duplicate reference id "${record.id}".`);
      ids.add(record.id);
    }
  });
  return ids;
}

function validateSourceReference(value, path, add) {
  if (!checkStrictObject(value, path, SOURCE_REF_FIELDS, ["id", "kind"], add)) return;
  checkNonEmptyString(value.id, `${path}.id`, add);
  checkEnum(value.kind, SOURCE_REF_KINDS, `${path}.kind`, add);
  if (!isNonEmptyString(value.path) && !isNonEmptyString(value.url)) add("design_source_package.source_ref_location", path, "Source reference requires path or url.");
  for (const field of ["path", "url", "role", "media_type"]) if (value[field] != null) checkNonEmptyString(value[field], `${path}.${field}`, add);
  if (value.sha256 != null && !SHA256_PATTERN.test(value.sha256)) add("design_source_package.sha256", `${path}.sha256`, "sha256 must be 64 lowercase hex, with optional sha256: prefix.");
  if (value.notes != null && typeof value.notes !== "string") add("design_source_package.notes", `${path}.notes`, "notes must be a string or null.");
}

function validateVisualReference(value, path, add) {
  if (!checkStrictObject(value, path, VISUAL_REF_FIELDS, ["id", "kind", "viewport", "availability"], add)) return;
  checkNonEmptyString(value.id, `${path}.id`, add);
  checkEnum(value.kind, VISUAL_KINDS, `${path}.kind`, add);
  checkEnum(value.viewport, VIEWPORTS, `${path}.viewport`, add);
  checkEnum(value.availability, new Set(["available", "unavailable"]), `${path}.availability`, add);
  if (value.availability === "available" && !isNonEmptyString(value.path) && !isNonEmptyString(value.url)) add("design_source_package.visual_location", path, "Available visual reference requires path or url.");
  if (value.availability === "unavailable" && !isNonEmptyString(value.unavailable_reason)) add("design_source_package.visual_unavailable", `${path}.unavailable_reason`, "Unavailable visual reference requires unavailable_reason.");
  for (const field of ["path", "url", "device_profile", "browser", "captured_at", "source_ref_id", "unavailable_reason"]) if (value[field] != null) checkNonEmptyString(value[field], `${path}.${field}`, add);
  for (const field of ["width", "height"]) if (value[field] != null && (!Number.isInteger(value[field]) || value[field] < 1)) add("design_source_package.visual_dimensions", `${path}.${field}`, `${field} must be a positive integer.`);
  if (value.scale_factor != null && (typeof value.scale_factor !== "number" || !(value.scale_factor > 0))) add("design_source_package.visual_scale", `${path}.scale_factor`, "scale_factor must be positive.");
  if (value.sha256 != null && !SHA256_PATTERN.test(value.sha256)) add("design_source_package.sha256", `${path}.sha256`, "sha256 must be 64 lowercase hex, with optional sha256: prefix.");
  if (["source_screenshot", "template_reference_screenshot"].includes(value.kind)
    && value.availability === "available"
    && !isNonEmptyString(value.source_ref_id)) {
    add("design_source_package.visual_source_ref", `${path}.source_ref_id`, "Available source/template screenshot proof requires source_ref_id linkage.");
  }
  if (value.notes != null && typeof value.notes !== "string") add("design_source_package.notes", `${path}.notes`, "notes must be a string or null.");
}

function validateTemplateReference(value, path, add, sourceIds) {
  if (!checkStrictObject(value, path, TEMPLATE_REFERENCE_FIELDS, ["id", "family", "version", "standard_viewport_refs"], add)) return;
  for (const field of ["id", "family", "version"]) checkNonEmptyString(value[field], `${path}.${field}`, add);
  if (!isNonEmptyString(value.contract_path) && !isNonEmptyString(value.artifact_path)) add("design_source_package.template_reference_location", path, "Template Reference requires contract_path or artifact_path.");
  for (const field of ["contract_path", "artifact_path"]) if (value[field] != null) checkNonEmptyString(value[field], `${path}.${field}`, add);
  if (value.sha256 != null && !SHA256_PATTERN.test(value.sha256)) add("design_source_package.sha256", `${path}.sha256`, "sha256 must be 64 lowercase hex, with optional sha256: prefix.");
  const refs = validateArray(value.standard_viewport_refs, `${path}.standard_viewport_refs`, add);
  validateReferenceArray(refs, `${path}.standard_viewport_refs`, "template_visual", add, sourceIds);
}

function validateCoverageMapping(value, path, add) {
  if (!checkStrictObject(value, path, COVERAGE_MAPPING_FIELDS, [
    "id", "surface_id", "coverage_role", "confidence", "source_refs", "screenshot_refs", "reference_refs",
  ], add)) return false;
  checkNonEmptyString(value.id, `${path}.id`, add);
  checkNonEmptyString(value.surface_id, `${path}.surface_id`, add);
  checkEnum(value.coverage_role, new Set(COVERAGE_ROLES), `${path}.coverage_role`, add);
  checkEnum(value.confidence, new Set(MAPPING_CONFIDENCE_LEVELS), `${path}.confidence`, add);
  validateStringArray(value.source_refs, `${path}.source_refs`, add, { nonEmpty: true });
  validateStringArray(value.screenshot_refs, `${path}.screenshot_refs`, add, { nonEmpty: true });
  validateStringArray(value.reference_refs, `${path}.reference_refs`, add, { nonEmpty: true });
  if (value.coverage_role === "template_baseline" && !isNonEmptyString(value.template_reference_id)) add("design_source_package.template_baseline_link", `${path}.template_reference_id`, "template_baseline requires template_reference_id.");
  if (value.notes != null && typeof value.notes !== "string") add("design_source_package.notes", `${path}.notes`, "notes must be a string or null.");
  return true;
}

function validateGap(value, path, surfaceIds, add) {
  checkEnum(value.kind, new Set(["coverage_absence", "screenshot_absence", "reference_absence", "source_limitation", "other"]), `${path}.kind`, add);
  validateScopedRecord(value, path, ["reason", "attributed_by"], surfaceIds, add);
  checkEnum(value.status, new Set(["proposed", "accepted", "resolved"]), `${path}.status`, add);
  if (value.attributed_at != null && typeof value.attributed_at !== "string") add("design_source_package.gap_attribution", `${path}.attributed_at`, "attributed_at must be a string or null.");
  if (value.evidence_refs != null) validateStringArray(value.evidence_refs, `${path}.evidence_refs`, add, { nonEmpty: true });
}

function validateTodo(value, path, surfaceIds, add) {
  checkEnum(value.kind, new Set([
    "missing_source_screenshot", "missing_template_reference", "missing_template_viewport",
    "missing_primary_design", "low_confidence_primary_design", "unreadable_reference", "other",
  ]), `${path}.kind`, add);
  validateScopedRecord(value, path, ["description", "owner"], surfaceIds, add);
  checkEnum(value.status, new Set(["pending", "blocked", "completed", "skipped"]), `${path}.status`, add);
  if (value.required_viewports != null) {
    const viewports = validateStringArray(value.required_viewports, `${path}.required_viewports`, add, { unique: true, nonEmpty: true });
    viewports.forEach((viewport, index) => checkEnum(viewport, VIEWPORTS, `${path}.required_viewports[${index}]`, add));
  }
  if (value.source_ref_ids != null) validateStringArray(value.source_ref_ids, `${path}.source_ref_ids`, add, { nonEmpty: true });
}

function validateWaiver(value, path, add) {
  validateScopedRecord(value, path, ["reason", "waived_by", "waived_at"], null, add);
  checkEnum(value.status, new Set(["proposed", "approved", "revoked", "expired"]), `${path}.status`, add);
  if (!isNonEmptyString(value.expires_at) && !isNonEmptyString(value.review_condition)) add("design_source_package.waiver_time_bound", path, "Waiver requires expires_at or review_condition.");
  for (const field of ["expires_at", "review_condition"]) if (value[field] != null) checkNonEmptyString(value[field], `${path}.${field}`, add);
  if (value.evidence_refs != null) validateStringArray(value.evidence_refs, `${path}.evidence_refs`, add, { nonEmpty: true });
}

function validateDivergence(value, path, surfaceIds, add) {
  validateScopedRecord(value, path, ["summary", "attributed_by"], surfaceIds, add);
  checkEnum(value.status, new Set(["proposed", "accepted", "rejected", "resolved"]), `${path}.status`, add);
  checkEnum(value.recorded_stage, new Set(["prepare_build", "build", "polish", "qa", "operator"]), `${path}.recorded_stage`, add);
  if (typeof value.readiness_affecting !== "boolean") add("design_source_package.readiness_affecting", `${path}.readiness_affecting`, "readiness_affecting must be a boolean.");
  if (value.evidence_refs != null) validateStringArray(value.evidence_refs, `${path}.evidence_refs`, add, { nonEmpty: true });
}

function validateException(value, path, surfaceIds, add) {
  validateScopedRecord(value, path, ["reason", "proposed_by"], surfaceIds, add);
  checkEnum(value.status, new Set(["proposed", "accepted", "rejected"]), `${path}.status`, add);
  if (typeof value.readiness_affecting !== "boolean") add("design_source_package.readiness_affecting", `${path}.readiness_affecting`, "readiness_affecting must be a boolean.");
  if (value.evidence_refs != null) validateStringArray(value.evidence_refs, `${path}.evidence_refs`, add, { nonEmpty: true });
}

function validateScopedRecord(value, path, requiredStrings, surfaceIds, add) {
  checkNonEmptyString(value.id, `${path}.id`, add);
  checkNonEmptyString(value.scope, `${path}.scope`, add);
  for (const field of requiredStrings) checkNonEmptyString(value[field], `${path}.${field}`, add);
  const appliesTo = validateStringArray(value.applies_to, `${path}.applies_to`, add, { unique: true, nonEmpty: true, minItems: 1 });
  if (surfaceIds) appliesTo.forEach((id, index) => {
    if (!surfaceIds.has(id)) add("design_source_package.applies_to_surface", `${path}.applies_to[${index}]`, `Unknown Surface Identity "${id}".`);
  });
}

function validateReadiness(value, path, add) {
  if (!checkStrictObject(value, path, READINESS_FIELDS, ["status", "blocking_reasons", "gap_count", "todo_count", "waiver_count", "generated_at"], add)) return;
  checkEnum(value.status, new Set(SOURCE_READINESS_STATUSES), `${path}.status`, add);
  validateStringArray(value.blocking_reasons, `${path}.blocking_reasons`, add, { nonEmpty: true });
  for (const field of ["gap_count", "todo_count", "waiver_count"]) if (!Number.isInteger(value[field]) || value[field] < 0) add("design_source_package.readiness_count", `${path}.${field}`, `${field} must be a non-negative integer.`);
  checkNonEmptyString(value.generated_at, `${path}.generated_at`, add);
}

function validateReadback(value, path, add) {
  if (!checkStrictObject(value, path, READBACK_FIELDS, [...READBACK_FIELDS], add)) return;
  checkNonEmptyString(value.summary, `${path}.summary`, add);
  for (const field of READBACK_FIELDS) if (field !== "summary") validateStringArray(value[field], `${path}.${field}`, add, { nonEmpty: true });
}

function validateRecordArray(value, path, allowed, required, add, validateRecord) {
  const records = validateArray(value, path, add);
  records.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (checkStrictObject(record, recordPath, allowed, required, add)) validateRecord(record, recordPath);
  });
}

function validateUniqueRecordIds(value, path, add) {
  const ids = new Set();
  arrayOrEmpty(value).forEach((record, index) => {
    if (!isNonEmptyString(record?.id)) return;
    if (ids.has(record.id)) add("design_source_package.record_id_duplicate", `${path}[${index}].id`, `Duplicate record id "${record.id}".`);
    ids.add(record.id);
  });
}

function validateIdReferences(values, known, path, label, add) {
  arrayOrEmpty(values).forEach((id, index) => {
    if (!known.has(id)) add("design_source_package.reference_missing", `${path}[${index}]`, `Unknown ${label} id "${id}".`);
  });
}

function collectPackageReferenceIds(value) {
  const ids = new Set(arrayOrEmpty(value?.surface_identity).map((record) => record?.id).filter(isNonEmptyString));
  const addRecords = (records) => {
    for (const record of arrayOrEmpty(records)) if (isNonEmptyString(record?.id)) ids.add(record.id);
  };
  addRecords(value?.source_gaps);
  addRecords(value?.source_todos);
  addRecords(value?.divergences);
  addRecords(value?.proposed_exceptions);
  for (const contribution of arrayOrEmpty(value?.contributions)) {
    if (isNonEmptyString(contribution?.id)) ids.add(contribution.id);
    addRecords(contribution?.source_refs);
    addRecords(contribution?.screenshot_refs);
    addRecords(contribution?.reference_refs);
    addRecords(contribution?.mappings);
    if (isNonEmptyString(contribution?.template_reference?.id)) ids.add(contribution.template_reference.id);
    addRecords(contribution?.template_reference?.standard_viewport_refs);
  }
  return ids;
}

function checkStrictObject(value, path, allowed, required, add) {
  if (!isObject(value)) {
    add("design_source_package.type", path, `${path} must be an object.`);
    return false;
  }
  for (const field of required) if (!Object.hasOwn(value, field)) add("design_source_package.required", `${path}.${field}`, `${field} is required.`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) add("design_source_package.additional_property", `${path}.${field}`, `Unknown property "${field}" is not allowed.`);
  return true;
}

function checkNonEmptyString(value, path, add) {
  if (!isNonEmptyString(value)) add("design_source_package.string", path, `${path} must be a non-empty string.`);
}

function checkEnum(value, allowed, path, add) {
  if (!allowed.has(value)) add("design_source_package.enum", path, `${path} must be one of ${[...allowed].join(", ")}.`);
}

function validateArray(value, path, add) {
  if (!Array.isArray(value)) {
    add("design_source_package.array", path, `${path} must be an array.`);
    return [];
  }
  return value;
}

function validateStringArray(value, path, add, { unique = false, nonEmpty = false, minItems = 0 } = {}) {
  const array = validateArray(value, path, add);
  if (array.length < minItems) add("design_source_package.array_min_items", path, `${path} must contain at least ${minItems} item(s).`);
  const seen = new Set();
  array.forEach((entry, index) => {
    if (typeof entry !== "string" || (nonEmpty && !isNonEmptyString(entry))) add("design_source_package.string_array", `${path}[${index}]`, `${path}[${index}] must be ${nonEmpty ? "a non-empty " : "a "}string.`);
    if (unique && seen.has(entry)) add("design_source_package.array_unique", `${path}[${index}]`, `${path} must not contain duplicate values.`);
    seen.add(entry);
  });
  return array;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (value[key] !== undefined) output[key] = canonicalize(value[key]);
  }
  return output;
}

function pickFields(value, fields) {
  if (!isObject(value)) return {};
  const output = {};
  for (const field of fields) if (value[field] !== undefined) output[field] = cloneJsonValue(value[field]);
  return output;
}

function compactDefined(value, { preserveNull = false } = {}) {
  const output = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === undefined || (!preserveNull && entry === null)) continue;
    output[key] = entry;
  }
  return output;
}

function cloneJsonArray(value) {
  return arrayOrEmpty(value).map(cloneJsonValue);
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function dedupeRecordsById(records) {
  const byId = new Map();
  for (const record of records) if (isObject(record) && isNonEmptyString(record.id) && !byId.has(record.id)) byId.set(record.id, record);
  return [...byId.values()].sort(compareById);
}

function compareById(a, b) {
  return compareStrings(String(a?.id || ""), String(b?.id || ""));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortStrings(values) {
  return [...values].sort(compareStrings);
}

function sameStringSet(a, b) {
  return JSON.stringify(sortStrings(uniqueStrings(arrayOrEmpty(a)))) === JSON.stringify(sortStrings(uniqueStrings(arrayOrEmpty(b))));
}

function uniqueStrings(values) {
  return [...new Set(values.filter(isNonEmptyString).map((value) => value.trim()))];
}

function validSha(value) {
  return canonicalHashSpelling(value);
}

function canonicalHashSpelling(value) {
  if (!isNonEmptyString(value) || !SHA256_PATTERN.test(value)) return null;
  return `${MATERIAL_FINGERPRINT_PREFIX}${value.replace(/^sha256:/, "")}`;
}

function canonicalProducerMaterialFingerprint(value) {
  return canonicalHashSpelling(value) ?? optionalString(value);
}

function optionalString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value) {
  return typeof value === "number" && value > 0 ? value : null;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function assertInputArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
