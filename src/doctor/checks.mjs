// Doctor checks: the check registries, validatePacket and the validators they run.
import { campaignSpecIdentity, resolveCampaignIdentity, campaignIdentitiesMatch } from "../spec-source-identity.mjs";
import { withHtmlScanSnapshot, readHtmlScanText } from "../html-scan.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { describeSdkIgnoredMetaTags, isSdkIgnoredMetaTag } from "../sdk-meta-tags.mjs";
import { ORDER_PATH_DEPTH_DRIFT_CODE, orderPathDepthDriftText, orderPathDepthsDisagree } from "../proof-policy.mjs";
import { QA_GATE_PLACEHOLDER_TEXT_RESIDUE, qaGatePassedForCurrentBuild } from "../stage-ledger.mjs";
import {
  validateAdapterDecisionGates,
  validateAdapterDecisionShape,
  validateAdapterSourceFiles,
} from "../adapter-decision-contract.mjs";
import { createDoctorCheckRegistry, runDoctorCheckRegistry } from "../doctor-check-registry.mjs";
import { evaluateSourcePreparation } from "../source-prep.mjs";
import { isLoopbackHostname } from "../remit.mjs";
import { publicRouteForPage } from "../source-html-intake.mjs";
import {
  readSourceHtmlManifestFile,
  SOURCE_HASH_PATTERN,
  SOURCE_HTML_MANIFEST_SCHEMA,
} from "../source-html-manifest.mjs";
import { validateAssemblyReportThemeBlock, validateThemeContextBlock } from "../brand-theme.mjs";
import { singleLineDetail, singleLineField } from "../text-safety.mjs";
import {
  campaignRouteRoot,
  isAbsoluteHttpUrl,
  normalizePageKitRoute,
  normalizePublicRouteSlug,
  packetRouteRoot,
  runtimeRelativeRouteForSpecValue,
  stripPublicRoutePrefix,
} from "../route-identity.mjs";
import { evaluatePageKitBuildSummary } from "../page-kit-build-summary.mjs";
import {
  LOCAL_PROOF_BUILD_COMMAND,
  LOCAL_PROOF_BUILD_ENVIRONMENT,
  LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD,
  LOCAL_PROOF_BUILD_ENVIRONMENT_SCOPE,
  LOCAL_PROOF_NEVER_EDIT_RULE,
  LOCAL_PROOF_PARITY_COMMAND,
  LOCAL_PROOF_PARITY_FIELD,
  LOCAL_PROOF_PARITY_SCOPE,
  recordedBuildEnvironment,
  recordedProductionParity,
} from "../local-proof.mjs";
import {
  contractHasPaletteResidueChecks,
  demoAssetConfig,
  paymentMethodMarkupMatches,
  paymentMethodStaticScanGaps,
  withoutHiddenPaymentLogos,
  placeholderTextResidueConfig,
  placeholderTextResidueMatches,
} from "../template-brand-contract.mjs";
import {
  scanBuiltOutputContentResidue,
  loadBriefPayload,
  briefUrgencyVerified,
  collectRenderedHtmlFiles,
  evaluateProofAssets,
  attestationBlockers,
  visibleText,
  BRIEF_PAYLOAD_REL_PATH,
} from "../content-residue.mjs";
import {
  resolveCommerceCatalog,
  resolvePacketCommerceCatalogPath,
  resolveTemplateBrandContract,
} from "../private-template-source.mjs";
import { assessTemplateFreshness, defaultSdkSupportPolicy, renderTemplateFreshness } from "../template-freshness.mjs";
import { computeBuildFingerprint, resolveBuiltSiteScope } from "../built-site-scope.mjs";
import {
  UPSELL_SELECTOR_SCOPE,
  evaluateUpsellSelectorScope,
  isPostPurchasePageType,
} from "../upsell-selector-scope.mjs";
import { CAMPAIGN_IDENTITY, evaluateCampaignIdentity, externalScriptSources } from "../campaign-identity.mjs";
import { SDK_MARKUP, evaluateSdkMarkup } from "../sdk-markup.mjs";
import { SCRIPT_SYNTAX, collectBuiltScriptSyntaxInputs, evaluateBuiltScriptSyntax } from "../built-script-syntax.mjs";
import { validateCampaignBuildBriefArtifact } from "../build-brief.mjs";
import { ASSEMBLY_REPORT_STAGE_KEYS, stageIsTerminal } from "../orchestration-stage-contract.mjs";
import {
  assemblySourcePackageFingerprintMissing,
  assessAssemblySourcePackageFreshnessWaivers,
  currentBuildFingerprint,
} from "../polish-gate.mjs";
import { loadPageKitCampaignEntry, projectPageKitCampaignLoad } from "../page-kit-campaign-config.mjs";
import { evaluatePageKitStoreProfile, PAGE_KIT_STORE_PROFILE_SCOPE } from "../page-kit-store-profile.mjs";
import { evaluatePageKitSdkVersion, PAGE_KIT_SDK_VERSION_SCOPE } from "../page-kit-sdk-version.mjs";
// ADR-003: the public, canonical CampaignSpec rule registry. The doctor and any
// campaign authoring UI (e.g. a Map Builder bundle) import the same rules, so a
// spec check is authored once and reaches internal teams and agencies alike.
// Authored as pure TypeScript with no heavy deps; compiled to plain ESM by
// `npm run build:spec` (tsc -> campaign-spec/dist) so the package runs on the
// node engine in package.json without type-stripping. build runs on `prepare`,
// so a fresh install (including the git-ref consumer) always has dist.
import { normalize as normalizeCampaignSpec, runRules, specOnlyRules } from "../../campaign-spec/dist/index.js";
import { cmd, asInvocation } from "../install-invocation.mjs";
import {
  isObject,
  isNonEmptyString,
  optionalString,
  firstNonEmptyString,
  readJson,
  sha256File,
  relFromDir,
  resolveFromFile,
  extractFrontmatterValue,
  addIssue,
} from "../cli-helpers.mjs";
import { resolveCampaignsApiKeySource, describeCampaignKeyRejection } from "../campaigns-api-key.mjs";
import {
  LIVE_REF_CODES,
  campaignDriftMessage,
  evaluateLiveCampaignRefs,
  extractRenderedPackageRefs,
  extractRenderedRefs,
  extractRenderedShippingRefs,
  liveRefFindingMessage,
  liveRefsNotRunMessage,
} from "../live-campaign-refs.mjs";

const PACKET_SCHEMA = "campaign-runtime-build-packet/v0";
const CONTEXT_SCHEMA = "campaign-runtime-build-context/v0";
const REPORT_SCHEMA = "campaign-runtime-assembly-report/v0";
const PROOF_POLICY_REQUIRED_FIELDS = Object.freeze([
  "browser_qa_required",
  "typed_card_depth",
  "localhost_development_domain_allowed",
  "non_localhost_origin_allowlist_required",
  "order_path_depth",
  "operator_approval_state",
]);

// `--proxy-base` overrides DEFAULT_PROXY_BASE (src/spec-fetch.mjs) for
// staging environments or a local backend. The same flag aims the
// credential-bearing rails (remit, verdict publish, `telemetry list`), and
// those require https unless the host is loopback — see assertSecureProxyBase
// in src/remit.mjs.


const KNOWN_TEMPLATE_FAMILIES = new Set([
  "undecided",
  "apollo",
  "apollo-mv-single-step",
  "olympus",
  "demeter",
  "olympus-mv-single-step",
  "olympus-mv-two-step",
  "shop-single-step",
  "shop-three-step",
  "custom",
]);

// Certified template families: present in the commerce surface catalog AND
// carrying a template brand contract. The OS automates certified families
// only — "NEXT provides the rails": deterministic assembly, residue QA, and
// pricing contracts all assume a certified family. "custom" (or any family
// outside the catalog) is an explicit operator decision recorded as a
// waiver, never a default road the agent can wander onto.
// Recomputed per call (a handful of small JSON reads) so long-lived
// processes never serve a stale certified set after contract edits.
function certifiedTemplateFamilies(catalog = resolveCommerceCatalog()) {
  const certified = Object.keys(catalog.families || {}).filter((family) => {
    try {
      return resolveTemplateBrandContract(family) !== null;
    } catch {
      return false;
    }
  });
  return new Set(certified);
}

function isCertifiedTemplateFamily(family, catalog) {
  return certifiedTemplateFamilies(catalog).has(String(family || ""));
}

function isKnownTemplateFamily(family) {
  const value = String(family || "");
  return KNOWN_TEMPLATE_FAMILIES.has(value) || certifiedTemplateFamilies().has(value);
}

function isSynthesizedBuiltSitePacket(packet) {
  return packet?._synthesized?.from === "built_site";
}

const KNOWN_DEPLOY_TARGETS = new Set([
  "netlify",
  "cloudflare-pages",
  "vercel",
  "shopify-proxy",
  "agency-ci",
  "local-serve",
  "unknown",
]);
// The localhost QA path: the built _site/ is served locally instead of
// deployed. Localhost on any port is a Development domain, so doctor and
// `next` read a localhost deploy URL under this target as the intended state,
// not as a deploy that has not happened.
const LOCAL_SERVE_DEPLOY_TARGET = "local-serve";

const REQUIRED_STORE_PROFILE_FIELDS = [
  "store_url",
];

// Packet fields removed in supported surface 1.28.0. They were booleans no
// command read since the permission gate on test orders was retired; doctor
// warns when a packet still carries one.
const REMOVED_QA_POLICY_FIELDS = ["test_orders_allowed", "sandbox_test_card_confirmed"];

const US_MARKET_COPY_PATTERNS = [
  { label: "USPS", regex: /\bUSPS\b/i },
  { label: "ships from the USA", regex: /\bships?\s+from\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
  { label: "US warehouse", regex: /\b(?:US|U\.S\.|USA|United States)\s+warehouse\b/i },
  { label: "contiguous US", regex: /\bcontiguous\s+(?:US|U\.S\.|USA|United States)\b/i },
  { label: "US-only shipping", regex: /\b(?:US|U\.S\.|USA|United States)(?:-|\s+)?only\b/i },
  { label: "All US orders ship free", regex: /\bAll\s+(?:US|U\.S\.|USA|United States)\s+orders\s+ship\s+free\b/i },
  { label: "Made in USA", regex: /\bMade\s+in\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
  { label: "manufactured in the USA", regex: /\bmanufactur(?:ed|ing)\s+in\s+(?:the\s+)?(?:USA|U\.S\.A\.|US|U\.S\.|United States)\b/i },
];

const HARDCODED_CURRENCY_REGEX = /\$\s?\d[\d,]*(?:\.\d+)?(?:\/[A-Za-z]+)?/g;
const HARDCODED_PHONE_REGEX = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

const SDK_ROUTING_META_TAGS = [
  "next-success-url",
  "next-upsell-accept-url",
  "next-upsell-decline-url",
];

function normalizeFunnels(spec) {
  if (Array.isArray(spec?.funnels)) return spec.funnels;
  if (Array.isArray(spec?.funnel_pages)) {
    return [{ id: "default", weight: 100, pages: spec.funnel_pages }];
  }
  return [];
}

function activeSpecPages(spec) {
  const pages = [];
  for (const funnel of normalizeFunnels(spec)) {
    for (const page of Array.isArray(funnel.pages) ? funnel.pages : []) {
      if (page && page.enabled !== false && isNonEmptyString(page.id)) {
        pages.push({ ...page, funnel_id: funnel.id || "default" });
      }
    }
  }
  return pages;
}

function hasHtmlExtensionRoute(value) {
  if (!isNonEmptyString(value)) return false;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return /\.html$/i.test(url.pathname);
  } catch {
    return /\.html$/i.test(raw.replace(/[?#].*$/, ""));
  }
}

function collectHtmlFiles(root) {
  const files = [];
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) return files;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
        files.push({
          path: relative(resolvedRoot, fullPath),
          name: entry.name,
          basename: basename(entry.name, ".html"),
          bytes: statSync(fullPath).size,
          sha256: sha256File(fullPath),
        });
      }
    }
  }

  walk(resolvedRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const BUILT_TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".json"]);
const BUILT_TEXT_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", "_includes", "_layouts"]);
const DISCOUNT_CLAIM_TOLERANCE = 0.01;

function collectBuiltTextFiles(root) {
  const files = [];
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) return files;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (BUILT_TEXT_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && BUILT_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push({
          path: relative(resolvedRoot, fullPath),
          name: entry.name,
          bytes: statSync(fullPath).size,
        });
      }
    }
  }

  walk(resolvedRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Doctor Check Registry: keep packet/spec/build/artifact check order as data so
// agents add new checks in one deterministic slot instead of editing a long call chain.
function runDoctorChecks(checks, registryContext, options = {}) {
  if (!isObject(registryContext?.derived) || !Array.isArray(registryContext.derived.doctor_checks)) {
    throw new Error("Doctor check registry execution needs derived.doctor_checks for deterministic trace output.");
  }
  const executed = runDoctorCheckRegistry(checks, registryContext, options);
  registryContext.derived.doctor_checks.push(...executed);
  return executed;
}

const SPEC_DOCTOR_CHECKS = createDoctorCheckRegistry([
  {
    id: "campaign-spec.rule-registry",
    phase: "spec",
    run: ({ spec, errors, warnings }) => validateCampaignSpecRuleRegistry(spec, errors, warnings),
  },
  {
    id: "spec.identity_export",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecIdentityExport(spec, warnings, ready),
  },
  {
    id: "campaign.route_slug_identity",
    phase: "spec",
    run: ({ spec, packet, errors, ready }) => validateRouteSlugIdentity(spec, packet, errors, ready),
  },
  {
    id: "campaign.route_root",
    phase: "spec",
    run: ({ packet, errors, ready }) => validateRouteRootDeclaration(packet, errors, ready),
  },
  {
    id: "spec.public_routes",
    phase: "spec",
    run: ({ spec, errors, ready }) => validateSpecPublicRoutes(spec, errors, ready),
  },
  {
    id: "spec.store_profile",
    phase: "spec",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) =>
      validateSpecStoreProfile(spec, errors, warnings, ready, { packet, derived, buildState }),
  },
  {
    id: PAGE_KIT_SDK_VERSION_SCOPE,
    phase: "target",
    run: ({ spec, errors, warnings, ready, derived, buildState }) => validateTargetSdkVersion(spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: PAGE_KIT_STORE_PROFILE_SCOPE,
    phase: "target",
    run: ({ spec, errors, warnings, ready, derived, buildState }) => validateTargetStoreProfile(spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "spec.shipping_countries",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecShippingCountries(spec, warnings, ready),
  },
  {
    id: "spec.routing_meta_tags",
    phase: "spec",
    run: ({ spec, packet, warnings, ready, derived, buildState }) => validateSpecRoutingMetaTags(spec, packet, warnings, ready, derived, buildState),
  },
  {
    id: "source_html.coverage",
    phase: "source",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived, buildState }) => validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "source_html.preparation",
    phase: "source",
    run: ({ packet, packetPath, errors, warnings, ready, derived }) => validateSourcePreparation(packet, packetPath, errors, warnings, ready, derived),
  },
  {
    id: "spec.package_availability",
    phase: "spec",
    run: ({ spec, warnings, ready }) => validateSpecPackageAvailability(spec, warnings, ready),
  },
  {
    id: "built_output.target_root",
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived, buildState }) => validateBuiltOutputTargetRoot(packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.fingerprint",
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived, buildState }) => validateBuildOutputFingerprint(packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.pages",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltOutputPages(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.live_campaign_refs",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltLiveCampaignRefs(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: UPSELL_SELECTOR_SCOPE,
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateUpsellSelectorScope(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: CAMPAIGN_IDENTITY,
    phase: "built-output",
    run: ({ packet, errors, ready, derived }) => validateCampaignIdentity(packet, errors, ready, derived),
  },
  {
    id: SDK_MARKUP,
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived }) => validateSdkMarkup(packet, errors, warnings, ready, derived),
  },
  {
    id: SCRIPT_SYNTAX,
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived }) => validateBuiltScriptSyntax(packet, errors, warnings, ready, derived),
  },
  {
    id: "built_output.sdk_meta_tags",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltSdkMetaTags(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.build_summary",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuildSummary(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.route_drift",
    phase: "built-output",
    run: ({ spec, packet, errors, warnings, ready, derived, buildState }) => validateBuiltRouteDrift(spec, packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.content_residue",
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived, buildState }) => validateBuiltContentResidue(packet, errors, warnings, ready, derived, buildState),
  },
  {
    id: "built_output.proof_attestation",
    phase: "built-output",
    run: ({ packet, errors, warnings, ready, derived, buildState }) => validateProofAttestation(packet, errors, warnings, ready, derived, buildState),
  },
], { registryId: "packet.spec" });

const PACKET_DOCTOR_CHECKS = createDoctorCheckRegistry([
  {
    id: "campaign.api_key",
    phase: "packet",
    run: ({ packet, spec, warnings, ready }) => validateCampaignsApiKey(packet, spec, warnings, ready),
  },
  {
    id: "assembly.commerce_catalog",
    phase: "template-contract",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived, buildState }) => validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "market_copy",
    phase: "copy",
    run: ({ spec, warnings, ready, derived }) => validateMarketSensitiveCopy(spec, warnings, ready, derived),
  },
  {
    id: "source_html.adapter_contract",
    phase: "source",
    run: ({ packet, packetPath, spec, errors, warnings, ready, derived, buildState }) => validateAdapterContracts(packet, packetPath, spec, errors, warnings, ready, derived, buildState),
  },
  {
    id: "qa.proof_policy",
    phase: "qa",
    run: ({ packet, packetPath, report, warnings, ready }) => validateProofPolicy(packet, warnings, ready, { report, packetPath }),
  },
  {
    id: "build_brief.artifact",
    phase: "brief",
    run: ({ packet, packetPath, spec, context, errors, warnings, ready }) => validateBuildBrief(packet, packetPath, spec, context, errors, warnings, ready),
  },
], { registryId: "packet.always" });

const ARTIFACT_DOCTOR_CHECKS = createDoctorCheckRegistry([
  // Artifact phases are deterministic labels for inspection/filtering; artifact
  // presence is gated by `when` because context and report sidecars are optional.
  {
    id: "context.shape",
    phase: "context",
    when: ({ context }) => Boolean(context),
    run: ({ context, errors, warnings, ready, derived }) => validateContext(context, errors, warnings, ready, derived),
  },
  {
    id: "assembly_report.shape",
    phase: "report",
    when: ({ report }) => Boolean(report),
    run: ({ report, errors, warnings, ready }) => validateAssemblyReportShape(report, errors, warnings, ready),
  },
], { registryId: "artifact.optional" });

function validatePacket(packet, packetPath, errors, warnings, ready, derived, buildState = {}) {
  if (!isObject(packet)) {
    addIssue(errors, "packet.type", "Build Packet must be a JSON object.");
    return;
  }
  const synthesizedBuiltSite = isSynthesizedBuiltSitePacket(packet);
  if (packet.schema_version !== PACKET_SCHEMA) addIssue(errors, "schema_version", `Expected ${PACKET_SCHEMA}.`);
  else ready.push(`Build Packet schema ${PACKET_SCHEMA}`);

  requireString(packet, errors, "campaign.public_route_slug");
  requireBoolean(packet, errors, "campaign.allowed_domains_confirmed");
  if (!resolveCampaignIdentity(packet.spec)) addIssue(errors, packet.spec?.local_spec_id != null ? "spec.local_identity" : "spec.map_id", "Packet spec requires exactly one valid map_id or local_spec_id.", { kind: packet.spec?.local_spec_id != null ? "local_spec" : "saved_map" });
  if (packet.spec?.local_spec_id != null && (packet.spec.spec_url != null || !isNonEmptyString(packet.spec.local_path))) {
    addIssue(errors, "spec.local_identity", "Local-spec packets require a local_path and no saved-Map spec_url.");
  }
  if (!synthesizedBuiltSite) {
    requireString(packet, errors, "source_html.root");
    requireArray(packet, errors, "source_html.pages");
  } else {
    ready.push("Synthesized built-site packet: source_html provenance is absent by design");
  }
  requireString(packet, errors, "assembly.target_repo");
  requireString(packet, errors, "assembly.output_dir");
  requireString(packet, errors, "assembly.template_family");
  // Test Orders have no permission flag: the two booleans that once gated
  // them left the packet in surface 1.28.0. A packet still carrying them is
  // valid (nothing reads them); doctor says so once so the residue is removed.
  // The schema requires qa as an object (proof_policy and the notes live
  // there); with the boolean checks gone this is the check that keeps doctor
  // and bundle check agreeing on a packet whose qa is missing or malformed.
  if (!isObject(packet.qa)) addIssue(errors, "qa", "qa must be an object.");
  const removedQaPolicyFields = REMOVED_QA_POLICY_FIELDS.filter((field) => isObject(packet.qa) && field in packet.qa);
  if (removedQaPolicyFields.length) {
    addIssue(warnings, "qa.removed_policy_fields", `qa.${removedQaPolicyFields.join(" and qa.")} ${removedQaPolicyFields.length > 1 ? "are" : "is"} no longer part of the Build Packet (removed in supported surface 1.28.0; nothing reads ${removedQaPolicyFields.length > 1 ? "them" : "it"}). Delete the field${removedQaPolicyFields.length > 1 ? "s" : ""} from qa; test orders run from --test-order <mode> alone.`);
  }

  if (!isKnownTemplateFamily(packet.assembly?.template_family)) {
    addIssue(errors, "assembly.template_family", `Unknown template family "${packet.assembly?.template_family}".`);
  }
  if (!KNOWN_DEPLOY_TARGETS.has(packet.deploy?.target)) {
    addIssue(errors, "deploy.target", `Unknown deploy target "${packet.deploy?.target}".`);
  }

  if (!synthesizedBuiltSite && (packet.assembly?.template_family === "undecided" || packet.assembly?.template_lock?.locked !== true)) {
    addIssue(errors, "assembly.template_lock", "Template family must be explicitly locked before commerce wiring.");
  }

  // Certified-template gate: a decided family must be certified (catalog +
  // brand contract) or carry an explicit uncertified waiver. Uncertified
  // families have no deterministic assembly path, no residue QA, and no
  // pricing contract — the OS cannot stand behind the output, so the
  // decision to leave the rails is recorded, never improvised.
  const decidedFamily = packet.assembly?.template_family;
  if (isNonEmptyString(decidedFamily) && decidedFamily !== "undecided") {
    if (isCertifiedTemplateFamily(decidedFamily)) {
      ready.push(`Template family "${decidedFamily}" is certified (commerce catalog + brand contract)`);
      // Certification freshness (#263): certified is not the whole story — an
      // operator must also see which SDK the certification evidence covers.
      // Current freshness stays informational (ready); a stale or unrecorded
      // verification surfaces as a warning, because an older evidence record
      // is not current certification.
      const freshness = assessTemplateFreshness({
        family: decidedFamily,
        catalog: resolveCommerceCatalog(),
        sdkSupportPolicy: defaultSdkSupportPolicy(),
      });
      const freshnessLine = renderTemplateFreshness(freshness);
      if (freshness.state === "current") {
        ready.push(freshnessLine);
      } else {
        addIssue(warnings, "assembly.template_certification.freshness", freshnessLine);
      }
    } else {
      const waiver = packet.assembly?.template_certification?.waiver;
      if (waiver && isNonEmptyString(waiver.reason)) {
        addIssue(warnings, "assembly.template_certification", `Template family "${decidedFamily}" is NOT certified; proceeding under recorded waiver: ${waiver.reason}. Deterministic assembly, residue QA, and pricing contracts do not cover this family.`);
      } else {
        addIssue(errors, "assembly.template_certification", `Template family "${decidedFamily}" is not certified. Certified families: ${[...certifiedTemplateFamilies()].sort().join(", ")}. Pick a certified family, or rerun prepare-build with --allow-uncertified-template "<reason>" to record an explicit waiver.`);
      }
    }
  }

  const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
  if (packet.deploy?.target === LOCAL_SERVE_DEPLOY_TARGET) {
    if (!deployUrl) {
      ready.push("Deploy target is local-serve: serve the built _site/ locally and record the localhost URL on deploy.preview_url; localhost on any port is a Development domain, so no SDK origin allowlist entry is needed for QA.");
    } else if (isLocalhostDevelopmentOrigin(deployUrl)) {
      ready.push(`Deploy target is local-serve and the deploy URL ${deployUrl} is localhost: Campaigns App treats localhost on any port as a Development domain, so SDK initialization is allowed and analytics are suppressed for local QA.`);
    } else if (isLoopbackDeployUrl(deployUrl)) {
      // A static server bound to 127.0.0.1 or [::1] is the same local serve;
      // the Development-domain rule is stated for the hostname localhost, so
      // say which spelling to fall back to if the SDK refuses the numeric one.
      ready.push(`Deploy target is local-serve and the deploy URL ${deployUrl} is a loopback origin: it is served locally for QA. Campaigns App states its Development-domain rule for the hostname localhost on any port; if SDK initialization is refused on this host, open the same server as http://localhost:<port>/ and record that URL instead.`);
    } else {
      addIssue(warnings, "deploy.local_serve_url", `deploy.target is local-serve but the recorded deploy URL ${deployUrl} is not a localhost or loopback origin. Record the served localhost URL, or set deploy.target to where that origin is actually hosted.`);
    }
    validateLocalProof(packet, buildState?.report || null, errors, warnings, ready);
  } else if (packet.campaign?.allowed_domains_confirmed !== true) {
    if (isLocalhostDevelopmentOrigin(deployUrl)) {
      ready.push("Deploy URL is localhost; Campaigns App treats localhost on any port as a Development domain, so SDK initialization is allowed and analytics are suppressed for local QA.");
    } else {
      addIssue(warnings, "campaign.allowed_domains_confirmed", "Non-localhost preview/production origins are not confirmed in the Campaigns App SDK origin allowlist. SDK runtime checks may be blocked after deploy.");
    }
  }

  if (synthesizedBuiltSite) {
    const builtPages = (Array.isArray(packet.pages) ? packet.pages : []).map((page) => ({
      page_id: String(page?.page_id || page?.id || page?.route || "page"),
      type: String(page?.type || page?.page_type || "page"),
      role: pageRole(String(page?.type || page?.page_type || "page")),
      route: typeof page?.route === "string" ? page.route : null,
    }));
    derived.scope = {
      mode: "built_site",
      built_pages: builtPages,
      out_of_scope_pages: [],
      previewable_routes: builtPages.map((page) => ({ page_id: page.page_id, type: page.type, route: page.route })),
      blocked_runtime_pages: [],
    };
    derived.source_root = null;
  } else {
    const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
    derived.source_root = sourceRoot;
    if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      addIssue(errors, "source_html.root", `Source root does not exist: ${packet.source_html?.root}`);
    }
  }

  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  derived.target_repo = targetRepo;
  const pageKitCampaignConfig = loadPageKitCampaignEntry({
    targetRepo,
    publicRouteSlug: packet?.campaign?.public_route_slug,
  });
  buildState.pageKitCampaignConfig = pageKitCampaignConfig;
  derived.page_kit_campaign_config = projectPageKitCampaignLoad(pageKitCampaignConfig);
  if (!targetRepo || !existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    addIssue(errors, "assembly.target_repo", `Target repo does not exist: ${packet.assembly?.target_repo}`);
  } else {
    const outputDir = resolve(targetRepo, packet.assembly?.output_dir || "");
    derived.target_output_dir = outputDir;
    derived.scaffold_required = !existsSync(outputDir);
    derived.scaffold_reason = derived.scaffold_required
      ? `Target output directory does not exist: ${packet.assembly?.output_dir}`
      : null;
    if (derived.scaffold_required) {
      addIssue(warnings, "page_kit.scaffold_required", "Target campaign output directory is missing; setup should run before build.");
    } else {
      ready.push("Target campaign output directory exists");
    }
    const pkgPath = join(targetRepo, "package.json");
    if (!existsSync(pkgPath)) {
      addIssue(warnings, "page_kit.package_json", "Target repo has no package.json. Page-kit command detection is unavailable.");
    } else {
      const pkg = readJson(pkgPath);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (!deps["next-campaign-page-kit"]) {
        addIssue(warnings, "page_kit.dependency", "Target package.json does not declare next-campaign-page-kit; page-kit may still be installed through another local path.");
      } else {
        ready.push(`Target page-kit dependency ${deps["next-campaign-page-kit"]}`);
      }
    }
  }

  let spec = null;
  if (synthesizedBuiltSite) {
    derived.spec_path = null;
    ready.push("Synthesized built-site packet skips CampaignSpec/source checks; built-output gates should run through doctor --built or qa --site.");
  } else {
    const localSpecPath = packet.spec?.local_path;
    const specPath = isNonEmptyString(localSpecPath) ? resolveFromFile(packetPath, localSpecPath) : null;
    derived.spec_path = specPath;
    let specStatus = "missing";
    if (localSpecPath != null && !isNonEmptyString(localSpecPath)) {
      // A present-but-unusable local_path is a malformed packet, not an
      // unconfigured one. Both block, but they are repaired in different
      // places, so the operator is told which one they have.
      addIssue(errors, "spec.local_path", `CampaignSpec local_path must be a non-empty string; the packet declares ${typeof localSpecPath}. Repair the packet's spec.local_path before build or QA.`);
    } else if (!isNonEmptyString(localSpecPath)) {
      addIssue(errors, "spec.local_path", "No local CampaignSpec path is present. Assembly must use a local exported CampaignSpec JSON so page coverage, routing, meta tags, and commerce refs are not guessed.");
    } else if (!existsSync(specPath)) {
      addIssue(errors, "spec.local_path", `CampaignSpec local_path does not exist: ${localSpecPath}`);
    } else {
      try {
        const loaded = readJson(specPath);
        if (isObject(loaded)) {
          spec = loaded;
          specStatus = "ok";
        } else {
          specStatus = "root_not_object";
          addIssue(errors, "spec.local_path", "CampaignSpec local_path must contain a JSON object. Restore a valid packet-local CampaignSpec export before build or QA.");
        }
      } catch {
        specStatus = "invalid_json";
        addIssue(errors, "spec.local_path", "CampaignSpec local_path is not valid JSON. Restore a valid packet-local CampaignSpec export before build or QA.");
      }
    }
    buildState.specStatus = specStatus;
    if (specStatus === "ok") {
      const specMapId = spec.spec_identity?.map_id || spec.map_id;
      if ((specMapId && specMapId !== packet.spec.map_id)
        || ((spec.spec_identity?.local_spec_id != null || packet.spec?.local_spec_id != null)
          && !campaignIdentitiesMatch(campaignSpecIdentity(spec), packet.spec))) {
        const localIdentity = spec.spec_identity?.local_spec_id != null || packet.spec?.local_spec_id != null;
        addIssue(errors, localIdentity ? "spec.local_identity" : "spec.map_id", "Packet identity does not match the CampaignSpec map_id/local_spec_id.", { kind: localIdentity ? "local_spec" : "saved_map" });
      }
      ready.push("Local CampaignSpec parsed");
      runDoctorChecks(SPEC_DOCTOR_CHECKS, { packet, packetPath, spec, targetRepo, errors, warnings, ready, derived, buildState });
    } else {
      runDoctorChecks(
        SPEC_DOCTOR_CHECKS,
        { packet, packetPath, spec: null, targetRepo, errors, warnings, ready, derived, buildState },
        { phase: "target" },
      );
    }
  }

  if (synthesizedBuiltSite) {
    ready.push("Packet source/proof checks skipped for synthesized built-site packet");
  } else {
    runDoctorChecks(PACKET_DOCTOR_CHECKS, { packet, packetPath, spec, context: buildState.context, report: buildState.report, errors, warnings, ready, derived, buildState });
  }

  if (!packet.deploy?.preview_url && !packet.deploy?.production_url) {
    const partialScope = derived.scope?.mode === "partial";
    addIssue(
      warnings,
      "deploy.preview_url",
      partialScope
        ? "No preview or production URL yet. After deploy, mapped pages are route/visual-testable; checkout/runtime launch QA remains blocked for out-of-scope pages."
        : "No preview or production URL yet. QA remains blocked after build/polish."
    );
  }
  // Test Orders use global test cards that bypass the gateway and create no
  // transactions, so they need no per-packet permission. The packet qa.* booleans
  // are retained as informational metadata but no longer gate test orders or QA
  // stage progression.
}

function validateCampaignSpecRuleRegistry(spec, errors, warnings) {
  // ADR-003: run the shared campaign-spec rule registry — the single public
  // source of CampaignSpec validation. specOnlyRules is the right preset here:
  // the doctor runs without a deployed URL, so any rule requiring one is
  // skipped. These pure spec-shape rules are complementary to the
  // packet/build-aware spec checks; both run so internal teams and agencies get
  // identical spec-shape validation. Emitted under the single spec.validation
  // code, with rule identity preserved in detail for JSON consumers.
  try {
    for (const violation of runRules(normalizeCampaignSpec(spec), specOnlyRules)) {
      addIssue(
        violation.severity === "error" ? errors : warnings,
        "spec.validation",
        violation.message,
        { ruleId: violation.ruleId, path: violation.path, data: violation.data }
      );
    }
  } catch (error) {
    addIssue(errors, "spec.validation", `CampaignSpec validation failed: ${error.message}`);
  }
}

function validateAdapterContracts(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const packetContract = packet.source_html?.adapter_contract;
  validateAdapterDecisionShape(packetContract, "source_html.adapter_contract", warnings, ready, { addIssue });
  validateAdapterSourceFiles({
    decisions: packetContract,
    sourceRoot: resolveFromFile(packetPath, packet.source_html?.root),
    pages: packet.source_html?.pages || [],
    warnings,
    ready,
    addIssue,
  });

  const contextDecisions = buildState.context?.adapter_decisions;
  const reportDecisions = buildState.report?.adapter_decisions;

  const decisions = reportDecisions || contextDecisions || packetContract;
  validateAdapterDecisionGates({
    decisions,
    location: reportDecisions ? "report.adapter_decisions" : contextDecisions ? "context.adapter_decisions" : "source_html.adapter_contract",
    specPages: activeSpecPages(spec),
    family: packet.assembly?.template_family,
    assemblyComplete: isStageComplete(buildState.report, "assembly"),
    targetRepo: derived.target_repo,
    errors,
    warnings,
    ready,
    addIssue,
  });
}

function validateProofPolicy(packet, warnings, ready, { report = null, packetPath = null } = {}) {
  const policy = packet.qa?.proof_policy;
  if (!policy) {
    addIssue(warnings, "qa.proof_policy", "qa.proof_policy is missing. New packets make browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state explicit.");
    return;
  }
  validateProofPolicyObject(policy, "qa.proof_policy", warnings, ready, { requireBrowserQa: true });
  // The report's proof_policy is a mirror written at prepare-build. A packet
  // edited afterwards (by hand, or by an older `qa policy set` that never
  // refreshed the mirror) leaves the two disagreeing, and
  // assessPurchaseProofCoverage then reads the depth as unknown — so `next`
  // could not reach done and nothing named the fix. Advisory, never a
  // blocker: the warning carries the one command that reconciles them.
  const drift = orderPathDepthDrift(packet, report);
  if (drift) {
    addIssue(warnings, ORDER_PATH_DEPTH_DRIFT_CODE, orderPathDepthDriftText({ packetDepth: drift.packet, reportDepth: drift.report, packetPath }));
  }
}

// The packet's declared order-path depth beside the report's mirror when the
// two disagree, else null. The comparison itself is the leaf's
// orderPathDepthsDisagree, which `next` also asks of a coverage result.
function orderPathDepthDrift(packet, report) {
  const packetDepth = optionalString(packet?.qa?.proof_policy?.order_path_depth);
  const reportDepth = optionalString(report?.proof_policy?.order_path_depth);
  return orderPathDepthsDisagree(packetDepth, reportDepth) ? { packet: packetDepth, report: reportDepth } : null;
}

function validateBuildBrief(packet, packetPath, spec, context, errors, warnings, ready) {
  const briefRef = packet.build_brief || context?.build_brief || null;
  const normalizedPath = optionalString(packet.build_brief?.normalized_path)
    || optionalString(context?.build_brief?.normalized_path);
  if (!briefRef || !normalizedPath) {
    addIssue(warnings, "build_brief.missing", "No Campaign Build Brief artifact is referenced. Existing builds may continue, but new build intake should provide or generate .campaign-runtime/input/campaign-build-brief.normalized.json so business/design decisions are durable.");
    return;
  }

  const resolvedPath = resolveFromFile(packetPath, normalizedPath);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    addIssue(errors, "build_brief.normalized_path", `Campaign Build Brief normalized artifact is missing: ${normalizedPath}`);
    return;
  }

  const brief = readJson(resolvedPath);
  const result = validateCampaignBuildBriefArtifact(brief, { spec });
  for (const issue of result.errors) errors.push(issue);
  for (const issue of result.warnings) warnings.push(issue);
  ready.push(...result.ready);

  if (context?.build_brief?.status && brief.status && context.build_brief.status !== brief.status) {
    addIssue(warnings, "build_brief.context_status", `Build context says brief status is "${context.build_brief.status}" but normalized artifact says "${brief.status}". Rerun prepare-build to refresh the handoff.`);
  }
}

function validateProofPolicyObject(policy, location, warnings, ready, { requireBrowserQa = false } = {}) {
  if (!isObject(policy)) {
    addIssue(warnings, location, `${location} must be an object when present.`);
    return;
  }
  for (const field of PROOF_POLICY_REQUIRED_FIELDS) {
    if (!(field in policy)) {
      addIssue(warnings, `${location}.${field}`, `${location}.${field} is missing; proof policy must make browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state explicit.`);
    }
  }
  if (policy.browser_qa_required != null && typeof policy.browser_qa_required !== "boolean") {
    addIssue(warnings, `${location}.browser_qa_required`, `${location}.browser_qa_required must be a boolean.`);
  } else if ("browser_qa_required" in policy && requireBrowserQa && policy.browser_qa_required !== true) {
    addIssue(warnings, `${location}.browser_qa_required`, "Browser QA should stay explicit in the packet/report before launch proof.");
  }
  if (!isNonEmptyString(policy.typed_card_depth)) {
    addIssue(warnings, `${location}.typed_card_depth`, `${location}.typed_card_depth should name the intended typed-card depth, usually common.`);
  }
  if ("localhost_development_domain_allowed" in policy && policy.localhost_development_domain_allowed !== true) {
    addIssue(warnings, `${location}.localhost_development_domain_allowed`, `${location}.localhost_development_domain_allowed should be true; localhost on any port is the public Development-domain QA origin.`);
  }
  if ("non_localhost_origin_allowlist_required" in policy && policy.non_localhost_origin_allowlist_required !== true) {
    addIssue(warnings, `${location}.non_localhost_origin_allowlist_required`, `${location}.non_localhost_origin_allowlist_required should be true; preview/production origins require SDK origin allowlist confirmation.`);
  }
  if (!isNonEmptyString(policy.order_path_depth)) {
    addIssue(warnings, `${location}.order_path_depth`, `${location}.order_path_depth should name checkout/upsell order-path depth.`);
  }
  if (!isNonEmptyString(policy.operator_approval_state)) {
    addIssue(warnings, `${location}.operator_approval_state`, `${location}.operator_approval_state should be explicit, e.g. not_required_global_test_cards.`);
  }
  if (policy.qa_portal_publish_default != null && typeof policy.qa_portal_publish_default !== "boolean") {
    addIssue(warnings, `${location}.qa_portal_publish_default`, `${location}.qa_portal_publish_default must be a boolean when present.`);
  }
  ready.push(`${location} loaded: browser=${policy.browser_qa_required === true}, typed_card_depth=${policy.typed_card_depth || "unspecified"}, order_path_depth=${policy.order_path_depth || "unspecified"}`);
}

export function validateSpecStoreProfile(spec, errors, warnings, ready, { packet = null, derived = {}, buildState = {} } = {}) {
  const campaign = spec?.campaign || {};
  const missing = REQUIRED_STORE_PROFILE_FIELDS.filter((field) => !isNonEmptyString(campaign[field]));
  if (missing.length > 0) {
    addIssue(
      errors,
      "spec.store_profile",
      `CampaignSpec campaign is missing required Store Profile field for page-kit campaigns.json: ${missing.join(", ")}. Add ${missing.map((field) => `campaign.${field}`).join(", ")} to the CampaignSpec Store Profile, then rerun start/prepare-build. Campaigns OS does not infer or silently mutate these storefront/legal values.`,
      {
        missing_fields: missing.map((field) => `campaign.${field}`),
        repair: {
          owner: "operator",
          action: `Update the CampaignSpec Store Profile export with merchant storefront metadata, then rerun ${cmd("start")} or ${cmd("prepare-build")}.`,
          example_patch: Object.fromEntries(missing.map((field) => [field, field === "store_url" ? "https://<merchant-store-domain>" : "<merchant value>"])),
        },
      }
    );
    return;
  }
  ready.push("CampaignSpec required Store Profile fields are present for page-kit campaigns.json");

  // R2-B5: a store profile can pass the required-field check yet
  // still be unable to serve a real shopper — the gap neither doctor nor
  // browser QA surfaced in the Round 2 run. These are real-shopper readiness
  // *warnings* (not blockers): a routing/visual-only run is fine, and they are
  // independent of test orders (test cards bypass the gateway). The concern is
  // that a real customer cannot complete checkout against a placeholder store
  // URL or a store with no payment methods configured.
  const storeUrl = campaign.store_url;
  if (isNonEmptyString(storeUrl) && looksLikePlaceholderStoreUrl(storeUrl)) {
    addIssue(
      warnings,
      "spec.store_profile.placeholder_store_url",
      `CampaignSpec campaign.store_url "${storeUrl}" looks like a local/placeholder store, not a live storefront. Localhost is valid as a Development-domain QA origin, but a real shopper cannot transact against it. Set the merchant's production store_url before launch.`
    );
  } else if (isNonEmptyString(storeUrl)) {
    ready.push("CampaignSpec store_url points at a non-placeholder storefront");
  }

  const paymentMethods = campaign.available_payment_methods;
  if (Array.isArray(paymentMethods) && paymentMethods.length === 0) {
    addIssue(
      warnings,
      "spec.store_profile.no_payment_methods",
      "CampaignSpec campaign.available_payment_methods is empty. A real shopper would have no payment method to complete checkout. Confirm the store's payment methods before launch."
    );
  }

  // Every starter-template family's checkout page calls
  // {% campaign_include 'payment-methods.html' %} with no arguments, and the
  // include defaults show_paypal/show_klarna/show_apple_pay/show_google_pay to
  // true. So a method the spec does not support still renders unless the build
  // passes show_<method>=false on that include call. When the spec declares its
  // supported methods and one of those four is absent from both
  // available_payment_methods and available_express_payment_methods, warn so the
  // build disables it (or the spec adds it). Methods may be plain strings or
  // { code, label } objects.
  //
  // Once the checkout is built, the rendered page is the authority: doctor
  // reads _site/<slug>/<checkout route>/index.html for the method's markup and
  // stays silent when none shipped — the same markers browser QA's
  // template-residue gate keys on — instead of repeating a pre-build advisory
  // the build already satisfied.
  const normalizeMethod = (method) =>
    String(method && typeof method === "object" ? method.code : method).toLowerCase().replace(/[\s-]+/g, "_");
  const supportedMethods = new Set([
    ...(Array.isArray(paymentMethods) ? paymentMethods : []).map(normalizeMethod),
    ...(Array.isArray(campaign.available_express_payment_methods) ? campaign.available_express_payment_methods : []).map(normalizeMethod),
  ]);
  if (supportedMethods.size === 0) return;
  const unsupportedDefaults = STARTER_TEMPLATE_DEFAULT_ON_PAYMENT_METHODS.filter((method) => !supportedMethods.has(method));
  if (unsupportedDefaults.length === 0) return;

  const family = packet?.assembly?.template_family;
  const builtCheckouts = builtCheckoutPagesForSpec(spec, packet, derived);
  if (builtCheckouts.length === 0) {
    const includeCall = `{% campaign_include 'payment-methods.html' ${unsupportedDefaults.map((method) => `show_${method}=false`).join(" ")} %}`;
    addIssue(
      warnings,
      "spec.store_profile.payment_methods_default_on",
      `Starter-template checkout pages render ${unsupportedDefaults.join(", ")} by default: the checkout page includes payment-methods.html with no arguments and the include defaults show_${unsupportedDefaults.length > 1 ? "<method>" : unsupportedDefaults[0]} to true, but the CampaignSpec does not list ${unsupportedDefaults.length > 1 ? "them" : "it"} in available_payment_methods/available_express_payment_methods. `
        + `Pass ${unsupportedDefaults.map((method) => `show_${method}=false`).join(" ")} on that include call in the ${isNonEmptyString(family) ? `${family} ` : ""}checkout page (${includeCall}) or add the method to the spec, so unsupported methods do not ship. Doctor re-reads the built checkout once it exists.`,
      {
        methods: unsupportedDefaults,
        template_family: isNonEmptyString(family) ? family : null,
        basis: "spec_only",
        repair: {
          owner: "operator",
          action: `Pass ${unsupportedDefaults.map((method) => `show_${method}=false`).join(" ")} on the checkout page's payment-methods.html include call, or add the method(s) to the CampaignSpec, then rebuild.`,
          include_call: includeCall,
        },
      }
    );
    return;
  }

  const chrome = isNonEmptyString(family) ? resolveBrandContractOnce(derived, family).contract?.default_residue?.payment_chrome || null : null;
  const shipped = [];
  for (const built of builtCheckouts) {
    const html = readFileSync(built.path, "utf8");
    for (const method of unsupportedDefaults) {
      const markers = paymentMethodMarkupMatches(html, method, chrome);
      if (markers.length) shipped.push({ page_id: built.page_id, file: built.file, method, markers, forced_logo: paymentLogoForcedOn(html, method) });
    }
  }
  const builtFiles = [...new Set(builtCheckouts.map((built) => built.file))].join(", ");
  // What the static scan could not attribute (compound selectors, shared
  // chrome assets) stays with browser QA; name it so "no markup" is never
  // read as "nothing left to check".
  const gaps = { compound_selectors: [], shared_assets: [] };
  for (const method of unsupportedDefaults) {
    const methodGaps = paymentMethodStaticScanGaps(chrome, method);
    gaps.compound_selectors.push(...methodGaps.compound_selectors);
    gaps.shared_assets.push(...methodGaps.shared_assets);
  }
  gaps.compound_selectors = [...new Set(gaps.compound_selectors)];
  gaps.shared_assets = [...new Set(gaps.shared_assets)];
  const gapClauses = [];
  if (gaps.shared_assets.length) gapClauses.push(`shared chrome asset${gaps.shared_assets.length > 1 ? "s" : ""} ${gaps.shared_assets.join(", ")}`);
  if (gaps.compound_selectors.length) gapClauses.push(`compound selector${gaps.compound_selectors.length > 1 ? "s" : ""} ${gaps.compound_selectors.join(", ")}`);
  const gapNote = gapClauses.length ? `; left to browser QA: ${gapClauses.join(" and ")}` : "";
  if (shipped.length === 0) {
    ready.push(`Built checkout carries no ${unsupportedDefaults.join(", ")} payment-method markup (${builtFiles})${gapNote}`);
    return;
  }
  const shippedMethods = [...new Set(shipped.map((hit) => hit.method))];
  const forcedLogoMethods = [...new Set(shipped.filter((hit) => hit.forced_logo).map((hit) => hit.method))];
  const evidence = shipped.map((hit) => `${hit.file}: ${hit.method} (${hit.markers.join(", ")})`).join("; ");
  addIssue(
    warnings,
    "spec.store_profile.payment_methods_default_on",
    `Built checkout still renders ${shippedMethods.join(", ")}, which the CampaignSpec does not list in available_payment_methods/available_express_payment_methods: ${evidence}. `
      + `Pass ${shippedMethods.map((method) => `show_${method}=false`).join(" ")} on the checkout page's payment-methods.html include call and rebuild (or add the method to the spec); browser QA's template-residue gate fails on this markup.`
      + (forcedLogoMethods.length ? ` The payment-logos.html row forces ${forcedLogoMethods.join(", ")} on: remove payment_flags.${forcedLogoMethods.map((method) => `show_${method}`).join("/")}: true from the page frontmatter (the row otherwise shows only what the campaign offers).` : ""),
    {
      methods: shippedMethods,
      template_family: isNonEmptyString(family) ? family : null,
      basis: "built_output",
      pages: shipped,
      static_scan_gaps: gaps,
      repair: {
        owner: "operator",
        action: `Pass ${shippedMethods.map((method) => `show_${method}=false`).join(" ")} on the checkout page's payment-methods.html include call, or add the method(s) to the CampaignSpec, then rebuild.`,
        include_call: `{% campaign_include 'payment-methods.html' ${shippedMethods.map((method) => `show_${method}=false`).join(" ")} %}`,
      },
    }
  );
}

// A visible payment-logos.html <img> for this method: the template only leaves
// one visible when the page forces it with payment_flags.show_<method>: true.
function paymentLogoForcedOn(html, method) {
  const code = String(method || "").toLowerCase().replace(/[\s-]+/g, "_");
  return new RegExp(`<img\\b[^>]*\\sdata-payment-logo\\s*=\\s*["']${code}["']`, "i").test(withoutHiddenPaymentLogos(html));
}

// The four methods every starter-template payment-methods include renders
// unless the checkout page passes show_<method>=false.
export const STARTER_TEMPLATE_DEFAULT_ON_PAYMENT_METHODS = Object.freeze(["paypal", "klarna", "apple_pay", "google_pay"]);

// Built checkout pages on disk for the spec's active checkout pages: the
// rendered _site/<slug>/<route>/index.html files that exist. Empty before a
// build (or when the spec declares no checkout page), which is the pre-build
// state the spec-only advisory covers.
function builtCheckoutPagesForSpec(spec, packet, derived = {}) {
  const targetRepo = derived?.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!targetRepo || !publicRouteSlug) return [];
  const built = [];
  for (const page of activeSpecPages(spec)) {
    if (String(page?.type || page?.page_type || "").toLowerCase().trim() !== "checkout") continue;
    const path = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!path || !existsSync(path) || !statSync(path).isFile()) continue;
    built.push({ page_id: page.id, path, file: relative(targetRepo, path).split(sep).join("/") });
  }
  return built;
}

// R2-B5: a best-effort check for store URLs that clearly cannot be
// a live storefront (local dev hosts, reserved test/example TLDs). Intentionally
// conservative — only obvious non-production hosts trip it, so a real merchant
// domain never false-positives. A non-URL string is left to other validators.
function looksLikePlaceholderStoreUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return true;
  if (/\.(local|test|example|invalid|localhost)$/.test(host)) return true;
  if (host === "example.com" || host.endsWith(".example.com")) return true;
  return false;
}

// A URL whose host is a loopback address (localhost, 127.0.0.1, [::1]) —
// the remit rail's rule, reused so local-serve and the loopback receiver
// agree on what "local" means. Distinct from isLocalhostDevelopmentOrigin,
// which states the Campaigns App Development-domain rule (hostname localhost).
function isLoopbackDeployUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return isLoopbackHostname(new URL(String(value).trim()).hostname);
  } catch {
    return false;
  }
}

export function isLocalhostDevelopmentOrigin(value) {
  if (!isNonEmptyString(value)) return false;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return false;
  }
  return url.hostname.toLowerCase() === "localhost";
}

// Local proof mode rows (deploy.target local-serve). Once the build stage is
// terminal, the served _site/ must be the DEVELOPMENT render — a production
// build's protocol-relative vendor loaders fail over a plain-HTTP local serve
// and void polish capture — and the production render must have been proven
// to differ from it only in environment-gated output (`page-kit parity`).
// Both facts are read from the assembly stage's free-form evidence.
function validateLocalProof(packet, report, errors, warnings, ready) {
  if (!stageIsTerminal(report?.stages?.assembly?.status)) {
    ready.push(`Local proof mode: the build stage renders the development environment (${LOCAL_PROOF_BUILD_COMMAND}) and records ${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD}; polish capture and QA run against that served output, and ${asInvocation(LOCAL_PROOF_PARITY_COMMAND)} proves the production render before commit.`);
    return;
  }
  const environment = recordedBuildEnvironment(report);
  if (environment === LOCAL_PROOF_BUILD_ENVIRONMENT) {
    ready.push(`Local proof mode: the built _site/ is recorded as a ${LOCAL_PROOF_BUILD_ENVIRONMENT} render (${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD}); vendor loaders are environment-gated out, SDK dl_* events still fire.`);
  } else {
    addIssue(warnings, LOCAL_PROOF_BUILD_ENVIRONMENT_SCOPE, environment
      ? `${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} is "${singleLineField(environment)}" under deploy.target local-serve. A production build served over plain HTTP fails polish capture unwaivably on its protocol-relative vendor loaders (//host/...). Rebuild with ${LOCAL_PROOF_BUILD_COMMAND}, record the environment as "${LOCAL_PROOF_BUILD_ENVIRONMENT}", and recapture. ${LOCAL_PROOF_NEVER_EDIT_RULE}`
      : `${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} is not recorded under deploy.target local-serve. The build stage renders the development environment for local proof (${LOCAL_PROOF_BUILD_COMMAND}) and records it there; without the record doctor cannot tell a development render from a production build that will fail polish capture over plain HTTP. ${LOCAL_PROOF_NEVER_EDIT_RULE}`);
  }
  const parity = recordedProductionParity(report);
  const parityCommand = asInvocation(LOCAL_PROOF_PARITY_COMMAND);
  if (!parity) {
    addIssue(warnings, LOCAL_PROOF_PARITY_SCOPE, `Production parity is not recorded (${LOCAL_PROOF_PARITY_FIELD}). After proving the development build, run ${parityCommand} before committing: it renders the current source in development and production into temp dirs and asserts the served _site/ is the current development render and that production differs only in environment-gated output (same pages, route slugs, Campaign Cart pin and next-api-key). The PR preview is the second check, not the first.`);
    return;
  }
  const currentFingerprint = optionalString(report?.stages?.assembly?.build_fingerprint) || null;
  if (parity.build_fingerprint && currentFingerprint && parity.build_fingerprint !== currentFingerprint) {
    addIssue(warnings, LOCAL_PROOF_PARITY_SCOPE, `Production parity was recorded for build ${parity.build_fingerprint}, but stages.assembly.build_fingerprint is now ${currentFingerprint}. Re-run ${parityCommand} on the current build.`);
    return;
  }
  if (parity.status === "pass") {
    ready.push(`Local proof production parity: PASS — ${singleLineField(String(parity.summary || ""))}`);
    return;
  }
  const difference = isObject(parity.first_difference) ? parity.first_difference : null;
  addIssue(errors, LOCAL_PROOF_PARITY_SCOPE, `Production parity FAILED${difference ? ` — first non-gated difference: ${singleLineField(String(difference.kind))} at ${singleLineField(String(difference.route))}${difference.line ? ` line ${difference.line}` : ""}: ${singleLineField(String(difference.detail || ""))}` : `: ${singleLineField(String(parity.summary || ""))}`}. Rebuild in development, re-prove, and run ${parityCommand} again. ${LOCAL_PROOF_NEVER_EDIT_RULE}`, difference ? { first_difference: difference } : undefined);
}

function validateTargetSdkVersion(spec, errors, warnings, ready, derived, buildState) {
  const report = buildState?.report || null;
  const required = stageIsTerminal(report?.stages?.setup?.status)
    || stageIsTerminal(report?.stages?.assembly?.status)
    || derived.scaffold_required !== true;
  const gate = evaluatePageKitSdkVersion({
    spec,
    specStatus: buildState?.specStatus || "ok",
    targetLoad: buildState?.pageKitCampaignConfig,
    waivers: report?.waivers,
    required,
  });
  derived.checkpoint_gates.push(gate);

  const inertCounts = Object.fromEntries(
    ["stale", "foreign", "malformed", "expired"].map((kind) => [kind, gate.waiver_assessment?.inert_counts?.[kind] || 0]),
  );
  const inertTotal = Object.values(inertCounts).reduce((sum, count) => sum + count, 0);
  if (inertTotal > 0) {
    addIssue(
      warnings,
      "page_kit.sdk_version.waiver_inert",
      `SDK-pin waiver history contains ${inertTotal} inert record(s); stale, foreign, malformed, and expired decisions never satisfy the current checkpoint.`,
      { counts: inertCounts },
    );
  }

  if (gate.status === "blocked") {
    addIssue(errors, gate.code, gate.reason, { checkpoint_gate: gate });
    return;
  }
  if (gate.status === "waived") {
    addIssue(warnings, gate.code, `${gate.reason} Waived by ${gate.waiver.waived_by}: ${gate.waiver.reason}`, { checkpoint_gate: gate });
    ready.push(`SDK-pin checkpoint accepted under named-human exception (${gate.waiver.waived_by}).`);
    return;
  }
  if (gate.status === "not_applicable") {
    ready.push("SDK-pin checkpoint not applicable before Page Kit scaffold; it becomes mandatory once the target entry exists or setup completes.");
    return;
  }
  if (gate.code === "page_kit.sdk_version.repo_newer") {
    // The repo pin is the authority (#413): a completed bump the Map has not
    // been re-saved for is advisory, and the ready line names what ships.
    addIssue(warnings, gate.code, gate.reason, { checkpoint_gate: gate });
    ready.push(`Target campaigns.json SDK version ${gate.observed_sdk_version} is what ships; the CampaignSpec pin ${gate.expected_sdk_version} is a stale build hint.`);
    return;
  }
  ready.push(`Target campaigns.json SDK version matches CampaignSpec (${gate.expected_sdk_version}).`);
}

function validateTargetStoreProfile(spec, errors, warnings, ready, derived, buildState) {
  const report = buildState?.report || null;
  const required = stageIsTerminal(report?.stages?.setup?.status)
    || stageIsTerminal(report?.stages?.assembly?.status)
    || derived.scaffold_required !== true;
  const gate = evaluatePageKitStoreProfile({
    specCampaign: spec?.campaign || {},
    specStatus: buildState?.specStatus || "ok",
    targetLoad: buildState?.pageKitCampaignConfig,
    waivers: report?.waivers,
    required,
  });
  derived.checkpoint_gates.push(gate);

  const inertCounts = Object.fromEntries(
    ["stale", "foreign", "malformed", "expired"].map((kind) => [kind, gate.waiver_assessment?.inert_counts?.[kind] || 0]),
  );
  const inertTotal = Object.values(inertCounts).reduce((sum, count) => sum + count, 0);
  if (inertTotal > 0) {
    addIssue(
      warnings,
      "page_kit.store_profile.waiver_inert",
      `Store Profile waiver history contains ${inertTotal} inert record(s); stale, foreign, malformed, and expired decisions never satisfy the current checkpoint.`,
      { counts: inertCounts },
    );
  }

  if (gate.status === "blocked") {
    addIssue(errors, gate.code, gate.reason, { checkpoint_gate: gate });
    return;
  }
  if (gate.status === "waived") {
    addIssue(warnings, gate.code, `${gate.reason} Waived by ${gate.waiver.waived_by}: ${gate.waiver.reason}`, { checkpoint_gate: gate });
    ready.push(`Store Profile checkpoint accepted under named-human exception (${gate.waiver.waived_by}).`);
    return;
  }
  if (gate.status === "not_applicable") {
    ready.push("Store Profile checkpoint not applicable before Page Kit scaffold; it becomes mandatory once the target entry exists or setup completes.");
    return;
  }
  if (gate.warning_fields.length) {
    addIssue(warnings, gate.code, gate.reason, { checkpoint_gate: gate });
    return;
  }
  ready.push("Target campaigns.json Store Profile matches the CampaignSpec across all nine governed fields.");
}

function validateSpecShippingCountries(spec, warnings, ready) {
  const countries = spec?.campaign?.available_shipping_countries;
  if (countries === "all" || (Array.isArray(countries) && countries.length === 0)) {
    ready.push("CampaignSpec shipping countries: all countries");
    return;
  }
  if (Array.isArray(countries)) {
    ready.push(`CampaignSpec shipping countries: ${countries.join(", ")}`);
    return;
  }
  if (countries == null) {
    ready.push("CampaignSpec shipping countries: all countries");
    return;
  }
  addIssue(warnings, "spec.available_shipping_countries", 'CampaignSpec campaign.available_shipping_countries should be "all" or an array of country codes.');
}

// Commerce refs may be numeric in Map exports; general text fields may not.
function firstCommerceRef(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function specPackageRecords(spec) {
  const records = [];
  const add = (pkg, source) => {
    if (!isObject(pkg)) return;
    const ref = firstCommerceRef(pkg.ref_id, pkg.package_id, pkg.id);
    if (!ref) return;
    records.push({ ref, source, package: pkg });
  };

  for (const page of activeSpecPages(spec)) {
    for (const pkg of Array.isArray(page.packages) ? page.packages : []) {
      add(pkg, `page:${page.id}`);
    }
  }
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    for (const pkg of Array.isArray(offer.packages) ? offer.packages : []) {
      add(pkg, `offer:${offer.ref_id || offer.code || offer.name || "unknown"}`);
    }
  }
  for (const pkg of Array.isArray(spec?.packages) ? spec.packages : []) {
    add(pkg, "packages");
  }

  return records;
}

export function specPackageRefs(spec) {
  return new Set(specPackageRecords(spec).map((record) => String(record.ref)));
}

export function specShippingRefs(spec) {
  const refs = new Set();
  const add = (method) => {
    const ref = firstCommerceRef(method?.ref_id, method?.id, method?.shipping_method_id);
    if (ref) refs.add(String(ref));
  };

  for (const method of Array.isArray(spec?.shipping_methods) ? spec.shipping_methods : []) add(method);
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    for (const method of Array.isArray(offer.shipping_methods) ? offer.shipping_methods : []) add(method);
  }

  return refs;
}

// R2-B1: the set of refs the CampaignSpec itself declares as real
// commerce entities — packages (page/offer/top-level), shipping methods, and
// offer ref_ids. A reference whose value matches one of these points at a
// genuinely-declared entity, so the demo-ref check below should not treat it
// as a starter placeholder even when the Map export omitted ref-level
// `_provenance.api` stamping (the provenance gap that produced the noise).
function specDeclaredCommerceRefs(spec) {
  const refs = new Set([...specPackageRefs(spec), ...specShippingRefs(spec)]);
  for (const offer of Array.isArray(spec?.offers) ? spec.offers : []) {
    const ref = firstCommerceRef(offer?.ref_id, offer?.id);
    if (ref) refs.add(String(ref));
  }
  return refs;
}

function validateSpecPackageAvailability(spec, warnings, ready) {
  const unavailable = specPackageRecords(spec).filter((record) => {
    const availability = firstNonEmptyString(
      record.package.product_purchase_availability,
      record.package.purchase_availability,
      record.package.availability
    );
    return availability && availability.toLowerCase() === "unavailable";
  });

  if (!unavailable.length) {
    ready.push("CampaignSpec package purchase availability has no unavailable package refs in active build data");
    return;
  }

  const sample = unavailable
    .slice(0, 6)
    .map((record) => `${record.ref} (${record.source})`)
    .join(", ");
  const more = unavailable.length > 6 ? `; plus ${unavailable.length - 6} more` : "";
  addIssue(
    warnings,
    "spec.package_unavailable",
    `CampaignSpec contains package refs marked product_purchase_availability=unavailable: ${sample}${more}. Checkout or upsell API calls may 403 until the store variant is available.`
  );
}

function validateSpecIdentityExport(spec, warnings, ready) {
  const identity = spec?.spec_identity;
  if (isObject(identity) && resolveCampaignIdentity(identity) && isNonEmptyString(identity.public_route_slug)) {
    ready.push(`CampaignSpec spec_identity includes ${identity.local_spec_id ? "local_spec_id" : "map_id"} and public_route_slug`);
    return;
  }

  addIssue(
    warnings,
    "spec_identity.export",
    "CampaignSpec is missing complete spec_identity: declare map_id for a saved Map or local_spec_id for a local spec, plus public_route_slug. CLI identity overrides should stay diagnostic-only."
  );
}

// Identity cross-check for the root key of every built-output gate. The c1
// negative control (2026-08-02) showed that corrupting campaign.public_route_slug
// (classically: to the Map ID) raises no blocker — every built_output.* check
// roots at _site/<public_route_slug>/, finds nothing to check, and silently
// stops running, so doctor output is indistinguishable from a healthy run
// while all built-output guarantees are off. The packet slug must match the
// spec's declared public route slug and must not be the Map ID.
export function validateRouteSlugIdentity(spec, packet, errors, ready) {
  const packetSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!packetSlug) return;

  const mapId = optionalString(spec?.spec_identity?.map_id)
    || optionalString(spec?.map_id)
    || optionalString(packet?.spec?.map_id);
  const specSlug = normalizePublicRouteSlug(
    optionalString(spec?.spec_identity?.public_route_slug)
    || optionalString(spec?.campaign?.slug)
    || optionalString(spec?.campaign?.id)
  );
  const specDeclaresMapIdSlug = Boolean(specSlug) && Boolean(mapId) && specSlug === mapId;

  if (mapId && packetSlug === mapId && !specDeclaresMapIdSlug) {
    addIssue(
      errors,
      "campaign.route_slug_identity",
      `Packet campaign.public_route_slug "${packetSlug}" equals the Map ID. The Map ID is spec identity (spec_identity.map_id), not a route; built output lives at _site/<public_route_slug>/, so this slug disarms every built-output check. Set the packet slug to the campaign's public route slug${specSlug ? ` ("${specSlug}")` : ""} or re-run prepare-build from the spec.`
    );
    return;
  }

  if (specSlug && packetSlug !== specSlug) {
    addIssue(
      errors,
      "campaign.route_slug_identity",
      `Packet campaign.public_route_slug "${packetSlug}" does not match the CampaignSpec declared public route slug "${specSlug}". Built-output checks root at _site/<public_route_slug>/, so a wrong slug silently disarms them. Correct the packet slug or re-run prepare-build from the spec.`
    );
    return;
  }

  if (specSlug) {
    // Kilo review (PR #174): only claim "not the Map ID" when that is true —
    // a spec may (confusingly, but authoritatively) declare its route slug
    // equal to its Map ID, and the packet matching it is not an error here.
    ready.push(
      specDeclaresMapIdSlug
        ? `Packet public_route_slug "${packetSlug}" matches CampaignSpec identity (note: the spec declares its public route slug equal to its Map ID)`
        : `Packet public_route_slug "${packetSlug}" matches CampaignSpec identity and is not the Map ID`
    );
  }
}

// Loud failure for the state the c1 control exposed: _site/ was built but
// _site/<public_route_slug>/ is absent, so the whole built_output.* family is
// about to silently skip — the exact shape a slug corrupted to the Map ID
// produces. When _site/ does not exist at all (pre-build, or gate tests that
// never run page-kit) this stays quiet regardless of assembly status —
// sdk_hints.meta_tags already reports that deferral, and "assembly recorded
// complete without any built output" is a pre-existing contract other
// lifecycle checks exercise.
export function validateBuiltOutputTargetRoot(packet, errors, warnings, ready, derived = {}, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!targetRepo || !publicRouteSlug) return;

  // isDirectory, not bare existence: a stray regular file at _site/<slug>
  // must not read as a found root — downstream built_output.* checks would
  // still skip on it (Kilo review, PR #174).
  const siteRoot = join(targetRepo, "_site", publicRouteSlug);
  if (existsSync(siteRoot) && statSync(siteRoot).isDirectory()) {
    ready.push(`Built output root found at _site/${publicRouteSlug}/`);
    return;
  }

  const siteDir = join(targetRepo, "_site");
  if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) return;

  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  const builtRoots = readdirSync(siteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  addIssue(
    assemblyComplete ? errors : warnings,
    "built_output.target_root",
    `Target route not found in _site: expected built output at _site/${publicRouteSlug}/ but the slug root does not exist (built root(s): ${builtRoots.length ? builtRoots.join(", ") : "none"}). `
      + `Every built_output.* check roots at _site/<public_route_slug>/ and skips when it is missing, so built-output verification cannot run until the route exists or campaign.public_route_slug is corrected.`,
    { expected_root: `_site/${publicRouteSlug}/`, built_roots: builtRoots, assembly_complete: assemblyComplete }
  );
}

export function validateSpecRoutingMetaTags(spec, packet, warnings, ready, derived = {}, buildState = {}) {
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!publicRouteSlug) return;
  const routeRoot = campaignRouteRoot(packet);

  // R2-B2: the spec only carries unrooted routing-meta *hints*; the
  // page-kit build roots them when it renders _site/<slug>/. Once that built
  // output exists and assembly is complete, validateBuiltSdkMetaTags checks the
  // actual rendered values authoritatively. Re-warning on the spec literal here
  // would just repeat a "fix before QA" message the build already satisfied
  // (browser QA later proved the deployed output correct), so defer to the
  // built-output check instead of double-flagging.
  const targetRepo = derived.target_repo;
  const siteRoot = targetRepo ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (isStageComplete(buildState.report, "assembly") && siteRoot && existsSync(siteRoot)) {
    ready.push(`CampaignSpec routing meta deferred to built-output verification (_site/${publicRouteSlug}/).`);
    return;
  }

  const hits = [];
  for (const page of activeSpecPages(spec)) {
    const metaTags = page.sdk_hints?.meta_tags;
    if (!isObject(metaTags)) continue;

    for (const tag of SDK_ROUTING_META_TAGS) {
      const value = metaTags[tag];
      if (!isNonEmptyString(value)) continue;
      const route = value.trim();
      if (isRuntimeRootedRoutingMeta(route, publicRouteSlug, routeRoot)) continue;
      hits.push(`${page.id}:${tag}=${route}`);
    }
  }

  if (!hits.length) {
    ready.push(`CampaignSpec SDK routing meta tags are runtime-rooted for ${routeRoot}`);
    return;
  }

  const sample = hits.slice(0, 5).join("; ");
  const more = hits.length > 5 ? `; plus ${hits.length - 5} more` : "";
  addIssue(
    warnings,
    "routing_meta.runtime_root",
    `CampaignSpec sdk_hints.meta_tags routing values must render as campaign-rooted paths before QA. Expected values like "${routeRoot}upsell/" for ${SDK_ROUTING_META_TAGS.join(", ")}; found ${sample}${more}.`
  );
}

// Pages declared out of source scope (#238/#239: a manifest skip_reason entry
// or CampaignSpec build_scope "partial") assemble from the template family and
// are not built by a partial-scope build, so their absence from _site/ is the
// declared state — not a missing-page failure. In-scope pages keep the full
// post-assembly escalation.
//
// The authority is stages.prepare_build.declared_out_of_scope on the recorded
// assembly report — NOT derived.scope.out_of_scope_pages, which also contains
// blocked pages carrying the auto-generated skip_reason remedy text (a packet
// blocked on MISSING_SOURCE_PAGE has skip mappings too, and those pages must
// keep failing loud). With no report recorded the set is empty, so every page
// stays in scope — the safe default.
function declaredOutOfScopePageIds(buildState) {
  const declared = buildState?.report?.stages?.prepare_build?.declared_out_of_scope;
  if (!Array.isArray(declared)) return new Set();
  return new Set(declared.map((skip) => skip?.page_id).filter(isNonEmptyString));
}

export function validateBuiltSdkMetaTags(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const expectedPages = activeSpecPages(spec)
    .map((page) => ({
      page,
      metaTags: page.sdk_hints?.meta_tags,
    }))
    .filter(({ metaTags }) => isObject(metaTags) && Object.keys(metaTags).length > 0);
  if (expectedPages.length === 0) return;

  // A spec key the SDK does not read (sdk-meta-tags.mjs, the list QA reads
  // too) is a stale Map page hint, not a tag the build owes: it is never
  // required and never `missing`, whether or not it rendered. One advisory
  // per page names the keys and the reason, so the fix is an edit to the
  // Map, not the build; it does not wait for built output.
  for (const { page, metaTags } of expectedPages) {
    const ignoredTags = Object.keys(metaTags).filter((name) => isSdkIgnoredMetaTag(name));
    if (ignoredTags.length === 0) continue;
    addIssue(
      warnings,
      "sdk_hints.meta_tags.ignored_by_sdk",
      `CampaignSpec page "${page.id}" lists SDK meta tag(s) the Campaign Cart SDK does not read; remove from the Map's page hints: ${describeSdkIgnoredMetaTags(ignoredTags)}.`,
      { page_id: page.id, tags: ignoredTags }
    );
  }

  const allExpectedTags = [...new Set(expectedPages.flatMap(({ metaTags }) => Object.keys(metaTags)))]
    .filter((name) => !isSdkIgnoredMetaTag(name))
    .sort();
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const assemblyComplete = isStageComplete(buildState.report, "assembly");

  if (!siteRoot || !existsSync(siteRoot)) {
    if (allExpectedTags.length === 0) return;
    addIssue(
      warnings,
      "sdk_hints.meta_tags",
      `CampaignSpec expects SDK meta tags (${allExpectedTags.join(", ")}). Doctor cannot verify rendered output until page-kit build writes _site/${publicRouteSlug || "<slug>"}/.`
    );
    return;
  }

  const outOfScopePageIds = declaredOutOfScopePageIds(buildState);
  const skippedOutOfScope = [];
  let checked = 0;
  for (const { page, metaTags } of expectedPages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!builtPath || !existsSync(builtPath)) {
      // A declared out-of-scope page has no built HTML by declaration; a page
      // that IS built despite the declaration still gets its meta verified
      // below, so the skip covers exactly the declared absence.
      if (outOfScopePageIds.has(page.id)) {
        skippedOutOfScope.push(page.id);
        continue;
      }
      const issue = {
        code: "built_output.page_missing",
        message: `Built HTML is missing for CampaignSpec page "${page.id}" at ${builtPath ? relFromDir(targetRepo, builtPath) : "_site/<slug>/..."}.`,
        detail: { page_id: page.id },
      };
      (assemblyComplete ? errors : warnings).push(issue);
      continue;
    }

    checked += 1;
    const content = readFileSync(builtPath, "utf8");

    for (const [name, expectedValue] of Object.entries(metaTags)) {
      if (isSdkIgnoredMetaTag(name)) continue;
      const actualValue = extractMetaContent(content, name);
      if (!isNonEmptyString(actualValue)) {
        addIssue(
          assemblyComplete ? errors : warnings,
          "sdk_hints.meta_tags.missing",
          `Built page "${page.id}" is missing SDK meta tag "${name}" expected from CampaignSpec.`,
          { page_id: page.id, file: relFromDir(targetRepo, builtPath) }
        );
        continue;
      }
      if (SDK_ROUTING_META_TAGS.includes(name) && isNonEmptyString(expectedValue)) {
        const expectedRoute = runtimeRouteForMetaValue(expectedValue, publicRouteSlug, campaignRouteRoot(packet));
        if (expectedRoute && actualValue.trim() !== expectedRoute) {
          addIssue(
            assemblyComplete ? errors : warnings,
            "sdk_hints.meta_tags.route_mismatch",
            `Built page "${page.id}" emits ${name}="${actualValue}", expected "${expectedRoute}".`,
            { page_id: page.id, file: relFromDir(targetRepo, builtPath) }
          );
        }
      }
    }
  }

  if (checked > 0) ready.push(`Built SDK meta tags checked in _site/${publicRouteSlug}/ for ${checked} page(s)`);
  if (skippedOutOfScope.length > 0) {
    ready.push(`Built SDK meta verification skipped for ${skippedOutOfScope.length} declared out-of-scope page(s): ${skippedOutOfScope.join(", ")}`);
  }
}

// Build output fingerprint. Every stage after build binds its evidence to
// stages.assembly.build_fingerprint by string equality, so the value has to
// be one anyone can recompute from the output that is actually on disk.
// Doctor recomputes it from _site/<slug>/ on every run and publishes the
// current value at derived.build_output_fingerprint (the value build records,
// and the value an operator checks by hand), then compares it with what the
// report recorded: equal = pass, different = the output changed since build
// recorded it (a rebuild, a toolkit upgrade, a hand edit), absent = build has
// not recorded it yet. Stale is blocking once assembly is complete because
// every polish/QA artifact bound to the old value is then evidence about a
// build that no longer exists.
export function validateBuildOutputFingerprint(packet, errors, warnings, ready, derived = {}, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  if (!targetRepo || !publicRouteSlug) return;
  const siteRoot = join(targetRepo, "_site", publicRouteSlug);
  if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) return;

  const current = computeBuildFingerprint(siteRoot);
  // The root was a directory a moment ago; if it is not one now (removed
  // between the check and the walk) there is no output to fingerprint and no
  // verdict to give, the same skip as a missing root.
  if (!current.ok) return;
  const recorded = currentBuildFingerprint(buildState.report);
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  const status = !recorded ? "missing" : recorded === current.fingerprint ? "pass" : "stale";
  derived.build_output_fingerprint = {
    root: `_site/${publicRouteSlug}/`,
    algorithm: current.algorithm,
    value: current.fingerprint,
    file_count: current.file_count,
    excluded: current.excluded,
    recorded: recorded || null,
    status,
  };
  if (status === "pass") {
    ready.push(`Build output fingerprint matches stages.assembly.build_fingerprint (${current.file_count} file(s) under _site/${publicRouteSlug}/)`);
    return;
  }
  if (status === "missing") {
    addIssue(
      warnings,
      "built_output.fingerprint_missing",
      `Build has not recorded stages.assembly.build_fingerprint. The current output fingerprint of _site/${publicRouteSlug}/ is ${current.fingerprint} (${current.file_count} file(s); doctor --json derived.build_output_fingerprint.value); record it on stages.assembly.build_fingerprint after page-kit build.`,
      { root: `_site/${publicRouteSlug}/`, current: current.fingerprint, file_count: current.file_count, assembly_complete: assemblyComplete }
    );
    return;
  }
  addIssue(
    assemblyComplete ? errors : warnings,
    "built_output.fingerprint_stale",
    `Built output under _site/${publicRouteSlug}/ no longer matches stages.assembly.build_fingerprint (recorded ${recorded}, current ${current.fingerprint}, ${current.file_count} file(s)). `
      + "The output changed after build recorded it; re-run build (page-kit build, then record the current fingerprint) before polish or QA evidence can bind to it.",
    { root: `_site/${publicRouteSlug}/`, recorded, current: current.fingerprint, file_count: current.file_count, assembly_complete: assemblyComplete }
  );
}

function validateBuiltOutputPages(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const pages = activeSpecPages(spec);
  if (pages.length === 0) return;

  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (!siteRoot || !existsSync(siteRoot)) return;

  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  let checked = 0;
  for (const page of pages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (!builtPath || !existsSync(builtPath)) continue;

    checked += 1;
    validateBuiltHtmlStructure(
      readFileSync(builtPath, "utf8"),
      builtPath,
      targetRepo,
      page,
      spec,
      publicRouteSlug,
      errors,
      warnings,
      assemblyComplete
    );
  }

  if (checked > 0) ready.push(`Built HTML structure and commerce refs checked in _site/${publicRouteSlug}/ for ${checked} page(s)`);
}

// Built page refs against the live campaign (#533). The CampaignSpec check
// above cannot see a campaign that changed after the Map was saved, and skips
// entirely when the spec lists no shipping methods; this one compares every
// built page's rendered refs with what the live campaign serves, whatever the
// spec lists. The read itself happens before doctor runs (it is async and
// leaves the machine) and arrives as buildState.liveCampaign; without it the
// check is recorded not_run with its reason, never passed. Page-level misses
// block at any stage — a page pointing at a method the campaign no longer
// serves charges the wrong price whether or not assembly is recorded.
function validateBuiltLiveCampaignRefs(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const pages = [];
  if (siteRoot && existsSync(siteRoot)) {
    for (const page of activeSpecPages(spec)) {
      const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
      if (!builtPath || !existsSync(builtPath)) continue;
      const content = readFileSync(builtPath, "utf8");
      pages.push({
        page_id: page.id,
        file: relFromDir(targetRepo, builtPath),
        ...extractRenderedRefs(content),
      });
    }
  }
  if (pages.length === 0) {
    derived.live_campaign_refs = { status: "not_run", reason_code: "no_built_pages", reason: "No built page to compare against the live campaign.", checked_pages: 0 };
    return;
  }
  const result = evaluateLiveCampaignRefs({
    pages,
    map: { package_refs: specPackageRefs(spec), shipping_refs: specShippingRefs(spec) },
    live: buildState.liveCampaign,
  });
  derived.live_campaign_refs = {
    status: result.status,
    ...(result.reason_code ? { reason_code: result.reason_code, reason: result.reason } : {}),
    ...(buildState.liveCampaign?.key_source ? { key_source: buildState.liveCampaign.key_source } : {}),
    checked_pages: result.checked_pages,
    page_findings: result.page_findings,
    drift: result.drift,
  };
  if (result.status === "not_run") {
    if (result.attempted) addIssue(warnings, LIVE_REF_CODES.notRun, liveRefsNotRunMessage(result), { reason_code: result.reason_code, ...(result.http_status !== undefined ? { http_status: result.http_status } : {}) });
    return;
  }
  for (const finding of result.page_findings) {
    addIssue(errors, finding.code, liveRefFindingMessage(finding), { page_id: finding.page_id, file: finding.file, refs: finding.refs });
  }
  if (result.drift) addIssue(warnings, LIVE_REF_CODES.drift, campaignDriftMessage(result.drift), { drift: result.drift });
  if (result.status === "pass") ready.push(`Built page shipping and package refs are served by the live campaign (${result.checked_pages} page(s))`);
}

// Upsell selector scope (#270). Every doctor invocation, deliberately — not
// only the one that follows assembly. The real-world instance was introduced by
// a LATER human review round that layered a correctly-scoped selector on top of
// an existing unscoped one and left both in place, so a gate that fired only at
// first assembly would have watched the defect arrive and said nothing. It also
// stays blocking regardless of stage status, unlike the per-page structure
// checks that soften to warnings before assembly completes: built markup that
// charges a shopper is not a work-in-progress state that becomes true later.
function validateUpsellSelectorScope(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const pages = [];
  if (siteRoot && existsSync(siteRoot)) {
    // Enumerate from the FILESYSTEM, not from the CampaignSpec, so both doctor
    // paths scan the same set. Walking active spec pages would miss any built
    // page the spec does not declare — the ordinary state for a page-kit
    // `campaign-build` campaign, and the state route drift produces — which
    // would leave the packet path blind to exactly the pages `doctor --built`
    // catches. A gate whose coverage depends on which flag you passed is not
    // the gate this was written to be.
    const declaredByPath = new Map();
    for (const page of activeSpecPages(spec)) {
      const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
      if (builtPath) declaredByPath.set(resolve(builtPath), page);
    }
    const scope = resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug });
    for (const builtPage of (scope.ok ? scope.pages : [])) {
      const declared = declaredByPath.get(resolve(builtPage.built_path)) || null;
      // Declared type wins only when it is the post-purchase answer; otherwise
      // the route-inferred type stands. Same fail-closed rule the evaluator
      // applies between a declared type and the page's own next-page-type meta:
      // any signal saying "post-purchase" is enough.
      const declaredType = declared?.type || null;
      pages.push({
        page_id: declared?.id || builtPage.page_id,
        page_type: isPostPurchasePageType(declaredType) ? declaredType : builtPage.page_type,
        file: relFromDir(targetRepo, builtPage.built_path),
        content: readFileSync(builtPage.built_path, "utf8"),
      });
    }
  }
  recordUpsellSelectorScopeGate({
    subject: {
      public_route_slug: publicRouteSlug || null,
      site_root: siteRoot && targetRepo ? relFromDir(targetRepo, siteRoot) : null,
    },
    pages,
    waivers: buildState?.report?.waivers,
    errors,
    warnings,
    ready,
    derived,
  });
}

// Shared by both doctor entry points: the packet path above and the
// built-site-only path (`doctor --built`), which is how a page-kit
// `campaign-build` campaign with no hand-authored packet gets inspected — and
// therefore the invocation that most needs this gate.
function recordUpsellSelectorScopeGate({ subject, pages, waivers, errors, warnings, ready, derived }) {
  const gate = evaluateUpsellSelectorScope({ subject, pages, waivers });
  if (Array.isArray(derived?.checkpoint_gates)) derived.checkpoint_gates.push(gate);

  const inertCounts = Object.fromEntries(
    ["stale", "foreign", "malformed", "expired"].map((kind) => [kind, gate.waiver_assessment?.inert_counts?.[kind] || 0]),
  );
  const inertTotal = Object.values(inertCounts).reduce((sum, count) => sum + count, 0);
  if (inertTotal > 0) {
    addIssue(
      warnings,
      "built_output.upsell_selector_scope.waiver_inert",
      `Upsell selector-scope waiver history contains ${inertTotal} inert record(s); stale, foreign, malformed, and expired decisions never satisfy the current checkpoint.`,
      { counts: inertCounts },
    );
  }

  if (gate.status === "blocked") {
    addIssue(errors, gate.code, gate.reason, { checkpoint_gate: gate });
    return gate;
  }
  if (gate.status === "waived") {
    addIssue(warnings, gate.code, `${gate.reason} Waived by ${gate.waiver.waived_by}: ${gate.waiver.reason}`, { checkpoint_gate: gate });
    ready.push(`Upsell selector-scope checkpoint accepted under named-human exception (${gate.waiver.waived_by}).`);
    return gate;
  }
  if (gate.status === "not_applicable") {
    ready.push("Upsell selector-scope checkpoint not applicable: no built upsell/downsell page to scan yet.");
    return gate;
  }
  if (gate.warned.length) {
    addIssue(warnings, gate.code, gate.reason, { checkpoint_gate: gate });
    // A ready line beside the warning, so "the gate ran and found no cart-writing
    // selector" and "the gate did not run" are never the same JSON shape.
    ready.push(`Upsell selector-scope scan found 0 cart-writing selector(s) on ${gate.pages_scanned} built post-purchase page(s), with ${gate.warned.length} select-mode note(s)`);
    return gate;
  }
  ready.push(`Every bundle selector on ${gate.pages_scanned} built post-purchase page(s) is scoped away from the live cart (${gate.selectors_scanned} selector(s) scanned)`);
  return gate;
}

// Cross-page campaign identity (#301). Every doctor invocation, like the
// selector-scope gate above and for the same reason: the borrowed page that
// carries another funnel's key or tag arrives in a later edit round as often
// as at first assembly. Enumerates from the filesystem so both doctor paths
// scan the same pages, and stays blocking regardless of stage status.
function validateCampaignIdentity(packet, errors, ready, derived) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const scope = siteRoot && existsSync(siteRoot) ? resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug }) : null;
  recordCampaignIdentityGate({
    subject: {
      public_route_slug: publicRouteSlug || null,
      site_root: siteRoot && targetRepo ? relFromDir(targetRepo, siteRoot) : null,
    },
    pages: scope?.ok ? collectBuiltPageIdentityInputs(scope, targetRepo) : [],
    errors,
    ready,
    derived,
  });
}

// The identity evaluator is pure, so the filesystem work happens here: each
// built page's HTML plus the LOCAL scripts it loads. The API key of every
// certified family lives in a shared config.js the pages reference by
// `<script src>`, not in the page itself, so a page-only scan would see no
// key at all and pass a borrowed page whose config.js names another store.
// Absolute srcs resolve against the site root first (page-kit emits
// `/<slug>/config.js`), then the campaign directory (a root-served campaign
// emits `/config.js`); relative srcs resolve against the page. Remote and
// missing scripts contribute nothing.
function collectBuiltPageIdentityInputs(scope, targetRepo) {
  const scriptCache = new Map();
  const readScript = (path) => {
    if (!scriptCache.has(path)) {
      let content = null;
      try {
        if (existsSync(path) && statSync(path).isFile()) content = readFileSync(path, "utf8");
      } catch {
        content = null;
      }
      scriptCache.set(path, content);
    }
    return scriptCache.get(path);
  };
  const resolveLocalScript = (src, builtPath) => {
    const raw = String(src || "").trim();
    if (!raw || raw.startsWith("//") || isAbsoluteHttpUrl(raw) || raw.startsWith("data:")) return null;
    const clean = raw.replace(/[?#].*$/, "");
    if (!clean) return null;
    if (clean.startsWith("/")) {
      const rel = clean.replace(/^\/+/, "");
      const candidates = [join(scope.site_root, rel), join(scope.campaign_dir, rel)];
      return candidates.find((candidate) => existsSync(candidate)) || null;
    }
    return resolve(dirname(builtPath), clean);
  };
  return scope.pages.map((page) => {
    const content = readFileSync(page.built_path, "utf8");
    const scripts = [];
    for (const src of externalScriptSources(content)) {
      const path = resolveLocalScript(src, page.built_path);
      const scriptContent = path ? readScript(path) : null;
      if (scriptContent == null) continue;
      scripts.push({ src, file: relFromDir(targetRepo, path), content: scriptContent });
    }
    return {
      page_id: page.page_id,
      route: page.route,
      file: relFromDir(targetRepo, page.built_path),
      content,
      scripts,
    };
  });
}

function recordCampaignIdentityGate({ subject, pages, errors, ready, derived }) {
  const gate = evaluateCampaignIdentity({ subject, pages });
  if (Array.isArray(derived?.checkpoint_gates)) derived.checkpoint_gates.push(gate);

  if (gate.status === "blocked") {
    // One error per finding, each under its own code, so a report reader can
    // tell key drift from tag drift without parsing prose; every error carries
    // the whole gate so the JSON shape matches the other checkpoint gates.
    for (const finding of gate.findings) {
      addIssue(errors, finding.code, finding.message, { finding, checkpoint_gate: gate });
    }
    return gate;
  }
  if (gate.status === "not_applicable") {
    ready.push("Campaign identity checkpoint not applicable: no built page to scan yet.");
    return gate;
  }
  const skipped = gate.pages_skipped.length ? `; skipped ${gate.pages_skipped.length} parked page(s): ${gate.pages_skipped.join(", ")}` : "";
  ready.push(`All ${gate.pages_scanned} built page(s) agree on campaign identity (next-funnel ${gate.identity.funnel ? `"${gate.identity.funnel}"` : "not declared"}, API key ${gate.identity.api_key ? "consistent" : "not declared"})${skipped}`);
  return gate;
}

// Static SDK markup checks (#303). Every doctor invocation, both entry points,
// filesystem enumeration, blocking regardless of stage status — the same
// contract as the two gates above, for the same reasons.
function validateSdkMarkup(packet, errors, warnings, ready, derived) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const scope = siteRoot && existsSync(siteRoot) ? resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug }) : null;
  recordSdkMarkupGate({
    subject: {
      public_route_slug: publicRouteSlug || null,
      site_root: siteRoot && targetRepo ? relFromDir(targetRepo, siteRoot) : null,
    },
    pages: scope?.ok ? collectBuiltPageIdentityInputs(scope, targetRepo) : [],
    errors,
    warnings,
    ready,
    derived,
  });
}

// Campaign-owned script syntax (#480). Every doctor invocation, both entry
// points, filesystem enumeration, blocking regardless of stage status — the
// same contract as the gates above: a script that throws a SyntaxError on
// load is not a work-in-progress state that becomes true later.
function validateBuiltScriptSyntax(packet, errors, warnings, ready, derived) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  const scope = siteRoot && existsSync(siteRoot) ? resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug }) : null;
  recordScriptSyntaxGate({
    subject: {
      public_route_slug: publicRouteSlug || null,
      site_root: siteRoot && targetRepo ? relFromDir(targetRepo, siteRoot) : null,
    },
    inputs: scope?.ok ? collectBuiltScriptSyntaxInputs(scope, targetRepo) : {},
    errors,
    warnings,
    ready,
    derived,
  });
}

function recordScriptSyntaxGate({ subject, inputs, errors, warnings, ready, derived }) {
  const gate = evaluateBuiltScriptSyntax({ subject, ...inputs });
  if (Array.isArray(derived?.checkpoint_gates)) derived.checkpoint_gates.push(gate);
  // A referenced local script missing from the built output is a warning
  // (#502). One terminal disposition per gate, as with SDK markup: while a
  // parse failure blocks, the missing scripts stay on gate.warned[].
  if (gate.status !== "blocked" && Array.isArray(warnings)) {
    for (const item of gate.warned) addIssue(warnings, item.code, item.message, { finding: item, checkpoint_gate: gate });
  }
  if (gate.status === "blocked") {
    // One error per file, each naming the file, line and column.
    for (const finding of gate.findings) {
      addIssue(errors, finding.code, finding.message, { finding, checkpoint_gate: gate });
    }
    return gate;
  }
  if (gate.status === "not_applicable") {
    ready.push(`Script syntax checkpoint not applicable: ${gate.reason}`);
    return gate;
  }
  ready.push(`All ${gate.scripts_scanned} campaign-owned script(s) loaded by built pages parse`);
  return gate;
}

function recordSdkMarkupGate({ subject, pages, errors, warnings, ready, derived }) {
  const gate = evaluateSdkMarkup({ subject, pages });
  if (Array.isArray(derived?.checkpoint_gates)) derived.checkpoint_gates.push(gate);

  if (gate.status === "not_applicable") {
    ready.push("SDK markup checkpoint not applicable: no built page to scan yet.");
    return gate;
  }
  // Blockers and advisories each carry their own code (the kit's lint code,
  // lower-cased, under the gate id) and the finding, so a reader can filter
  // by shape without parsing prose.
  for (const item of gate.findings) addIssue(errors, item.code, item.message, { finding: item, checkpoint_gate: gate });
  // One terminal disposition per gate: while blockers stand, the advisories
  // stay on gate.warned[] (visible in --json) and are surfaced as warnings
  // only once the gate passes, so a blocked gate does not also read as a
  // warned one.
  if (gate.status !== "blocked") {
    for (const item of gate.warned) addIssue(warnings, item.code, item.message, { finding: item, checkpoint_gate: gate });
  }
  // Unknown data-next-* names are information, not a warning: the certified
  // templates carry a handful of their own data-next-* hooks the SDK never
  // reads, and a warning that fires on every canonical build is noise that
  // trains readers to skip the channel. The list stays on the gate and in
  // one ready line, where an invented attribute is still one grep away.
  if (gate.unknown_attributes.length) {
    ready.push(`SDK markup: ${gate.unknown_attributes.length} data-next-* name(s) not in the Campaign Cart ${gate.sdk_attribute_index_version} attribute index (advisory; the SDK does not read them): ${gate.unknown_attributes.map((item) => item.name).join(", ")}`);
  }
  if (gate.status === "blocked") return gate;
  ready.push(`SDK markup checks passed on ${gate.pages_scanned} built page(s)${gate.warned.length ? ` with ${gate.warned.length} advisory finding(s)` : ""}`);
  return gate;
}

// Route drift: a CampaignSpec page whose declared route has no built page at
// that path. page-kit derives the public route from the source FILENAME, so a
// file named presell-running.html builds at /presell-running/ even if the spec
// page_url says "presell/". QA resolves page URLs from the spec page_url, so
// this drift makes QA fetch phantom URLs (404s) and misreport pages as down —
// exactly what happened on the Shield QA (presell/landing). validateBuiltOutputPages
// silently skips missing pages, so this surfaces the drift and the actual
// built routes for reconciliation. See the Shield build QA (#1).
export function validateBuiltRouteDrift(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const pages = activeSpecPages(spec);
  if (pages.length === 0) return;
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = targetRepo && publicRouteSlug ? join(targetRepo, "_site", publicRouteSlug) : null;
  if (!siteRoot || !existsSync(siteRoot)) return;

  const claimed = new Set();
  const drifted = [];
  const unverifiable = [];
  const skippedOutOfScope = [];
  const outOfScopePageIds = declaredOutOfScopePageIds(buildState);
  // Served-route display honors route_root: a root-served campaign's pages
  // are reached at /<route>/, not /<slug>/<route>/, even though the built
  // files still live under _site/<slug>/.
  const routeRoot = campaignRouteRoot(packet);
  const rootSegments = routeRoot === "/" ? [] : [publicRouteSlug];
  for (const page of pages) {
    const builtPath = builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived);
    if (builtPath && existsSync(builtPath)) {
      claimed.add(resolve(builtPath));
      continue;
    }
    // Declared out-of-scope pages (#238) are not built by a partial-scope
    // build; their absence is the declared state, not route drift. A built
    // page is still claimed above regardless of declaration.
    if (outOfScopePageIds.has(page.id)) {
      skippedOutOfScope.push(page.id);
      continue;
    }
    if (!builtPath) {
      // No page_url / source permalink to resolve a route from: doctor cannot
      // determine the expected route, so this is "unverifiable", not drift.
      unverifiable.push({ page_id: page.id, type: page.type || "page", reason: "no page_url / source permalink to resolve an expected route" });
      continue;
    }
    const segments = [...rootSegments, ...relFromDir(siteRoot, dirname(builtPath)).split("/")].filter((segment) => segment && segment !== ".");
    drifted.push({
      page_id: page.id,
      type: page.type || "page",
      expected_route: `/${segments.join("/")}/`,
    });
  }

  // Denominator is the in-scope page count when a declaration is present:
  // "2/9 verified, 7 declared out of scope" reads as seven attempted-but-
  // unverified pages, while "2/2 in-scope verified" states what was actually
  // checked. Full-scope campaigns keep the original phrasing untouched.
  const inScopeCount = pages.length - skippedOutOfScope.length;
  const verifiedNote = (skippedOutOfScope.length
    ? `${claimed.size}/${inScopeCount} in-scope verified, ${skippedOutOfScope.length} declared out of scope`
    : `${claimed.size}/${pages.length} verified`)
    + `${unverifiable.length ? `, ${unverifiable.length} unverifiable` : ""}`;
  if (drifted.length === 0) {
    ready.push(`Built routes match CampaignSpec page routes (${verifiedNote})`);
    if (unverifiable.length) {
      addIssue(
        warnings,
        "built_output.route_unverifiable",
        `Doctor could not determine the expected route for ${unverifiable.length} CampaignSpec page(s) (no page_url / source permalink): ${unverifiable.map((u) => `"${u.page_id}" (${u.type})`).join(", ")}.`,
        { unverifiable },
      );
    }
    return;
  }

  const scope = resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug });
  const servedPrefix = routeRoot === "/" ? "/" : `/${publicRouteSlug}/`;
  const unmatched = (scope.ok ? scope.pages : [])
    .filter((builtPage) => !claimed.has(resolve(builtPage.built_path)))
    .map((builtPage) => `${servedPrefix}${builtPage.route ? `${builtPage.route}/` : ""}`.replace(/\/{2,}/g, "/"));
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  addIssue(
    assemblyComplete ? errors : warnings,
    "built_output.route_drift",
    `CampaignSpec page(s) have no built page at their declared route: ${drifted.map((d) => `"${d.page_id}" (${d.type}) → ${d.expected_route}`).join("; ")}. `
      + (unmatched.length ? `Built output has unmatched route(s): ${unmatched.join(", ")}. ` : "")
      + (unverifiable.length ? `Unverifiable (no page_url): ${unverifiable.map((u) => `"${u.page_id}"`).join(", ")}. ` : "")
      + `page-kit routes by source filename, so reconcile the spec page_url with the built route — otherwise QA (which resolves URLs from page_url) targets phantom URLs and reports live pages as 404.`,
    // Detail granularity contract: per-page issues (built_output.page_missing)
    // carry only that page's identity — a declared page never produces one, so
    // the declared list would be dead weight there. This aggregate is the
    // campaign-level route reconciliation, and its detail is the full
    // inventory; declared_out_of_scope belongs here because the ready summary
    // that otherwise reports the skips is suppressed when drift fires.
    { drifted, unmatched_built_routes: unmatched, unverifiable, verified_count: claimed.size, declared_out_of_scope: skippedOutOfScope },
  );
}

function validateBuildSummary(spec, packet, errors, warnings, ready, derived, buildState = {}) {
  const targetRepo = derived.target_repo;
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const result = evaluatePageKitBuildSummary({
    targetRepo,
    publicRouteSlug,
    activePages: activeSpecPages(spec),
    assemblyComplete: isStageComplete(buildState.report, "assembly"),
    builtPathForPage: (page) => builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived),
  });
  for (const issue of result.errors) addIssue(errors, issue.code, issue.message, issue.detail ?? null);
  for (const issue of result.warnings) addIssue(warnings, issue.code, issue.message, issue.detail ?? null);
  ready.push(...result.ready);
}

function validateBuiltHtmlStructure(content, builtPath, targetRepo, page, spec, publicRouteSlug, errors, warnings, assemblyComplete) {
  const issueTarget = assemblyComplete ? errors : warnings;
  const relPath = relFromDir(targetRepo, builtPath);
  if (!/<body(?:\s|>)/i.test(content) || !/<\/body>/i.test(content)) {
    addIssue(issueTarget, "built_output.body_missing", `Built page "${page.id}" does not contain a complete <body> element.`, { page_id: page.id, file: relPath });
  }
  if (!/(data-next-|window\.next|next-page-type|campaign-cart-sdk|campaign-cart)/i.test(content)) {
    addIssue(issueTarget, "built_output.runtime_missing", `Built page "${page.id}" has no obvious Campaign Cart runtime markers.`, { page_id: page.id, file: relPath });
  }
  validateBuiltPreCheckoutBootstrap(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltBumpPricing(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltStarterLogoResidue(content, builtPath, targetRepo, page, issueTarget);
  validateBuiltPageKitAssetPaths(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltScriptAssets(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget);
  validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget);
  validateBuiltAnalyticsContract(content, builtPath, targetRepo, page, spec, issueTarget);
}

// Build-time enforcement of the declared analytics contract (CampaignSpec
// `analytics` block). This is the static twin of the runtime QA correctness
// leg: where QA confirms a content param FIRES on a live page, this confirms the
// built page even HAS a handler for it — catching the gap before QA runs.
//
// Specifically the "?reviews=n with no handler" case from the Chamelo Shield
// build: the spec (or a synthesized one) declares a content param, but the
// built page never wired `data-next-hide="param.<name>=='n'"`, so the param
// silently no-ops. Only fires when the spec declares `analytics.params.content`;
// silent otherwise (the common case until specs carry an analytics block).
export function validateBuiltAnalyticsContract(content, builtPath, targetRepo, page, spec, issueTarget) {
  const contentParams = spec?.analytics?.params?.content;
  if (!Array.isArray(contentParams) || contentParams.length === 0) return;
  const relPath = relFromDir(targetRepo, builtPath);
  for (const cp of contentParams) {
    const name = typeof cp?.name === "string" ? cp.name.trim() : "";
    if (!name) continue;
    // A content param applies to this page when `pages` is unspecified (all
    // pages) or explicitly lists this page id. An explicit empty `pages: []`
    // (applies to no page) is a spec-shape misconfiguration flagged once at
    // spec-validation time by AnalyticsContractShape, not per built page here.
    const pages = Array.isArray(cp.pages) ? cp.pages : null;
    if (pages && !pages.includes(page.id)) continue;
    // The SDK drives content-param visibility via data-next-hide/show using
    // `param.<name>` (persisted to sessionStorage). Require the reference to sit
    // inside an actual data-next-hide/show attribute — a bare `param.<name>` in
    // a script/comment/pixel is not a handler (avoids false negatives).
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handlerPattern = new RegExp(
      `data-next-(?:hide|show)\\s*=\\s*["'][^"']*\\bparam\\.${escaped}\\b[^"']*["']`,
      "i",
    );
    if (!handlerPattern.test(content)) {
      addIssue(
        issueTarget,
        "analytics_contract.content_param_no_handler",
        `Built page "${page.id}" declares analytics content param "?${name}" but has no data-next-hide/show="param.${name}…" handler. The param will silently no-op — the Chamelo Shield "?reviews=n with no handler" gap.`,
        { page_id: page.id, file: relPath, param: name },
      );
    }
  }
}

// Per-page starter-logo residue, scanned against the BUILT `_site/<slug>`
// output. The starter brand logo (next-logo.png on img.brand-logo) must be
// swapped for the campaign's real logo on every page.
//
// Division of responsibility vs the existing generic residue scan: the packet
// path already emits `template_contract.literal_residue` (via
// collectGenericTemplateResidueMatches, which includes the next-logo pattern),
// but that scan runs against `derived.target_output_dir` — the page-kit SOURCE
// dir (src/<slug>) — and is gated on assembly-complete. This check is the
// BUILT-output signal: per page, unconditional, over `_site/<slug>`. A logo
// that survives the page-kit build into _site (the receipt case) is caught here
// even when the source scan didn't run or was a non-blocking source-side note.
// The two can both fire for one logo (it lives in source AND built); fixing the
// source and rebuilding clears both. See the Shield build QA (#5).
export function validateBuiltStarterLogoResidue(content, builtPath, targetRepo, page, issueTarget) {
  const occurrences = (content.match(/\bnext-logo\.(?:png|svg|webp)\b/gi) || []).length;
  if (occurrences === 0) return;
  addIssue(
    issueTarget,
    "built_output.starter_logo_residue",
    `Built page "${page.id}" still references the starter logo next-logo.png (${occurrences} occurrence(s)). Replace the .brand-logo asset with the campaign's real logo before deploy.`,
    { page_id: page.id, file: relFromDir(targetRepo, builtPath), occurrences },
  );
}

// Pre-checkout pages (presell/landing — SDK page_type "product") must ship the
// Campaign Cart bootstrap, not just inert data-next attributes. Without the
// loader + next-page-type meta, every SDK feature silently no-ops: conditional
// visibility (param.banner/param.seen), utmTransfer (UTM/query carry-through to
// checkout — top-of-funnel ad attribution), and SDK analytics. The generic
// runtime-marker check above passes on a lone data-next-* attribute, so this
// dedicated check guards the pre-checkout boundary. See the Shield build
// learnings (A1): base-presell.html / base-landing.html shipped without it.
const PRE_CHECKOUT_PAGE_TYPES = new Set([
  "presell", "advertorial", "listicle", "review",
  "landing", "lander", "lp", "product",
]);

function sdkLoaderScriptPresent(content) {
  // Only the campaign-cart loader counts. A loose `loader.js` match would let an
  // unrelated bundle (analytics/lazy-image loader) falsely satisfy the check and
  // re-introduce the missing-SDK bug, so the src must identify the campaign-cart
  // loader specifically. We do not scan for inline ESM imports: that is not a
  // real bootstrap path for this SDK and is trivially spoofed by a comment or a
  // JSON <script> blob.
  for (const tag of content.matchAll(/<script\b[^>]*>/gi)) {
    const srcMatch = tag[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    if (/campaign-cart(?:@[^"']*)?\/dist\/loader\.js/i.test(srcMatch[1])) return true;
  }
  return false;
}

// Order-bump templates (bump-check01/bump-switch01) ship BOTH a per-unit price
// row (Option A) and a line-total price row (Option B) behind Liquid guards,
// with a "pick ONE" comment. If a build leaves both rendered, the bump shows
// doubled prices. The template now defaults to per-unit only, so this guards
// the built output against a regression where both rows survive. See the
// Shield build learnings (B2). Spurious strikethrough (compare == price) is
// covered separately as a polish-gate evidence requirement.
const BUMP_BLOCK_PATTERN = /data-component\s*=\s*["']prepurchase-upsell["']/gi;
const BUMP_PER_UNIT_DISPLAYS = ["unitPrice", "originalUnitPrice"];
const BUMP_LINE_TOTAL_DISPLAYS = ["price", "originalPrice"];

function bumpDisplaysPresent(block, displays) {
  return displays.some((name) => new RegExp(`data-next-toggle-display\\s*=\\s*["']${name}["']`, "i").test(block));
}

const CHECKOUT_BUMP_PAGE_TYPES = new Set(["checkout", "select"]);

export function validateBuiltBumpPricing(content, builtPath, targetRepo, page, issueTarget) {
  const type = String(page?.type || page?.page_type || "").toLowerCase().trim();
  if (!CHECKOUT_BUMP_PAGE_TYPES.has(type)) return;

  // Slice the document into per-bump blocks at each prepurchase-upsell anchor.
  const anchorOffsets = [...content.matchAll(BUMP_BLOCK_PATTERN)].map((match) => match.index);
  if (anchorOffsets.length === 0) return;
  const relPath = relFromDir(targetRepo, builtPath);
  let doubled = 0;
  for (let i = 0; i < anchorOffsets.length; i += 1) {
    const block = content.slice(anchorOffsets[i], anchorOffsets[i + 1] ?? content.length);
    if (bumpDisplaysPresent(block, BUMP_PER_UNIT_DISPLAYS) && bumpDisplaysPresent(block, BUMP_LINE_TOTAL_DISPLAYS)) {
      doubled += 1;
    }
  }
  if (doubled > 0) {
    addIssue(
      issueTarget,
      "built_output.bump_double_price",
      `Built page "${page.id}" renders ${doubled} order bump(s) with BOTH a per-unit price row (Option A) and a line-total price row (Option B). Pick one: pass show_per_unit_price / show_line_total_price to the bump include so a single price row renders (rendering both doubles the displayed price).`,
      { page_id: page.id, file: relPath, doubled_bumps: doubled },
    );
  }
}

export function validateBuiltPreCheckoutBootstrap(content, builtPath, targetRepo, page, issueTarget) {
  const type = String(page?.type || page?.page_type || "").toLowerCase().trim();
  if (!PRE_CHECKOUT_PAGE_TYPES.has(type)) return;

  const relPath = relFromDir(targetRepo, builtPath);
  const hasLoader = sdkLoaderScriptPresent(content);
  const hasPageTypeMeta = isNonEmptyString(extractMetaContent(content, "next-page-type"));
  if (hasLoader && hasPageTypeMeta) return;

  const missing = [
    !hasLoader ? "the Campaign Cart loader script (campaign-cart@v{sdk_version}/dist/loader.js)" : null,
    !hasPageTypeMeta ? 'the <meta name="next-page-type"> tag' : null,
  ].filter(Boolean);
  addIssue(
    issueTarget,
    "built_output.pre_checkout_sdk_bootstrap",
    `SDK not bootstrapped on pre-checkout page "${page.id}" (type "${type}"): missing ${missing.join(" and ")}. Without it, conditional visibility (param.banner/param.seen), utmTransfer (UTM carry-through to checkout — ad attribution), and SDK analytics silently no-op. Emit the same config.js → loader.js → next-funnel/next-page-type bootstrap that the checkout layout uses.`,
    { page_id: page.id, file: relPath, missing: { loader: !hasLoader, page_type_meta: !hasPageTypeMeta } },
  );
}

function validateBuiltScriptAssets(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget) {
  for (const tag of content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const src = tag[1];
    const resolved = resolveBuiltAssetPath(src, builtPath, targetRepo);
    if (!resolved || existsSync(resolved)) continue;
    if (pageKitAssetPathViolation(src, publicRouteSlug)) continue;
    addIssue(
      issueTarget,
      "built_output.script_missing",
      `Built page "${page.id}" references script "${src}", but the file does not exist in built output.`,
      { page_id: page.id, file: relFromDir(targetRepo, builtPath), script: src }
    );
  }
}

export function validateBuiltPageKitAssetPaths(content, builtPath, targetRepo, page, publicRouteSlug, issueTarget) {
  const hits = collectPageKitAssetPathViolations(content, publicRouteSlug)
    .filter((hit) => {
      const resolved = resolveBuiltAssetPath(hit.reference, builtPath, targetRepo);
      return resolved && !existsSync(resolved);
    });

  if (!hits.length) return;

  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const sample = hits
    .slice(0, 5)
    .map((hit) => `${hit.reference} (${hit.kind}, line ${hit.line})`)
    .join("; ");
  const more = hits.length > 5 ? `; plus ${hits.length - 5} more` : "";
  const renderedExample = slug ? `/${slug}/config.js` : "/<slug>/config.js";
  const sourceExample = slug ? `src/${slug}/assets/config.js` : "src/<slug>/assets/config.js";

  addIssue(
    issueTarget,
    "built_output.pagekit_asset_path",
    `Built page "${page.id}" references page-kit asset path(s) that do not exist in built output: ${sample}${more}. next-campaign-page-kit copies ${sourceExample} to "${renderedExample}" (not "/assets/config.js" or "/${slug || "<slug>"}/assets/config.js"). Use "{{ 'config.js' | campaign_asset }}" in page-kit source, or rewrite raw passthrough HTML to the campaign-rooted built URL.`,
    {
      page_id: page.id,
      file: relFromDir(targetRepo, builtPath),
      references: hits.map((hit) => ({
        reference: hit.reference,
        expected: hit.expected,
        line: hit.line,
        kind: hit.kind,
      })),
    }
  );
}

export function collectPageKitAssetPathViolations(content, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const hits = [];
  const seen = new Set();

  const record = (kind, reference, index) => {
    const hit = pageKitAssetPathViolation(reference, slug);
    if (!hit) return;
    const key = `${kind}:${hit.reference}:${lineNumberAt(content, index || 0)}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      ...hit,
      kind,
      line: lineNumberAt(content, index || 0),
    });
  };

  for (const match of content.matchAll(/\b(src|href)=["']([^"']+)["']/gi)) {
    record(match[1].toLowerCase(), match[2], match.index);
  }
  for (const match of content.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    record("css-url", match[2], match.index);
  }

  return hits;
}

function pageKitAssetPathViolation(reference, publicRouteSlug) {
  const raw = String(reference || "").trim();
  if (!raw || raw.startsWith("//") || isAbsoluteHttpUrl(raw) || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return null;

  const clean = raw.replace(/[?#].*$/, "");
  const slugAssetsPrefix = publicRouteSlug ? `/${publicRouteSlug}/assets/` : null;
  let assetPath = null;

  if (clean.startsWith("/assets/")) {
    assetPath = clean.slice("/assets/".length);
  } else if (slugAssetsPrefix && clean.startsWith(slugAssetsPrefix)) {
    assetPath = clean.slice(slugAssetsPrefix.length);
  }

  if (!assetPath || assetPath.startsWith("../") || assetPath.includes("/../")) return null;
  return {
    reference: raw,
    asset_path: assetPath,
    expected: publicRouteSlug ? `/${publicRouteSlug}/${assetPath}` : `/<slug>/${assetPath}`,
  };
}

function resolveBuiltAssetPath(src, builtPath, targetRepo) {
  if (!isNonEmptyString(src)) return null;
  const raw = src.trim();
  if (raw.startsWith("//") || isAbsoluteHttpUrl(raw) || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return null;
  const clean = raw.replace(/[?#].*$/, "");
  if (!clean || clean.startsWith("#")) return null;
  if (clean.startsWith("/")) return join(targetRepo, "_site", clean.replace(/^\/+/, ""));
  return resolve(dirname(builtPath), clean);
}

function validateBuiltCommerceRefs(content, builtPath, targetRepo, page, spec, issueTarget) {
  const packageRefs = specPackageRefs(spec);
  const shippingRefs = specShippingRefs(spec);
  const relPath = relFromDir(targetRepo, builtPath);
  const badPackages = [...extractRenderedPackageRefs(content)].filter((ref) => packageRefs.size > 0 && !packageRefs.has(ref));
  const badShipping = [...extractRenderedShippingRefs(content)].filter((ref) => shippingRefs.size > 0 && !shippingRefs.has(ref));

  if (badPackages.length > 0) {
    addIssue(
      issueTarget,
      "built_output.package_ref",
      `Built page "${page.id}" references package ID(s) not present in CampaignSpec: ${[...new Set(badPackages)].join(", ")}.`,
      { page_id: page.id, file: relPath }
    );
  }
  if (badShipping.length > 0) {
    addIssue(
      issueTarget,
      "built_output.shipping_ref",
      `Built page "${page.id}" references shipping ID(s) not present in CampaignSpec: ${[...new Set(badShipping)].join(", ")}.`,
      { page_id: page.id, file: relPath }
    );
  }
}

function builtHtmlPathForPage(targetRepo, publicRouteSlug, page, derived = {}) {
  if (!targetRepo || !publicRouteSlug) return null;
  const sourcePermalink = sourcePermalinkForPage(derived?.target_output_dir, publicRouteSlug, page);
  const route = sourcePermalink || runtimeRelativeRouteForSpecValue(publicRouteForPage(page), publicRouteSlug);
  if (!route) return join(targetRepo, "_site", publicRouteSlug, "index.html");
  const clean = route.replace(/^\/+|\/+$/g, "");
  return clean ? join(targetRepo, "_site", publicRouteSlug, clean, "index.html") : join(targetRepo, "_site", publicRouteSlug, "index.html");
}

function sourcePermalinkForPage(targetOutputDir, publicRouteSlug, page) {
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return null;

  const expectedTerminal = terminalRouteSegment(publicRouteForPage(page));
  const candidates = [];
  for (const file of collectHtmlFiles(targetOutputDir)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const fullPath = join(targetOutputDir, file.path);
    const content = readFileSync(fullPath, "utf8");
    const permalink = extractFrontmatterValue(content, "permalink");
    if (!isNonEmptyString(permalink)) continue;
    const relative = stripPublicRoutePrefix(normalizePageKitRoute(permalink), publicRouteSlug);
    if (terminalRouteSegment(relative) === expectedTerminal) candidates.push(relative);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function extractMetaContent(content, name) {
  const escaped = escapeRegExp(name);
  const metaTag = new RegExp(`<meta\\b(?=[^>]*\\bname=["']${escaped}["'])([^>]*)>`, "i").exec(content);
  if (!metaTag) return null;
  const contentAttr = /\bcontent=["']([^"']*)["']/i.exec(metaTag[1]);
  return contentAttr ? contentAttr[1] : "";
}

function runtimeRouteForMetaValue(value, publicRouteSlug, routeRoot = null) {
  if (!isNonEmptyString(value)) return null;
  const route = value.trim();
  if (isAbsoluteHttpUrl(route)) return route;
  if (isRuntimeRootedRoutingMeta(route, publicRouteSlug, routeRoot)) return route;
  const root = routeRoot || `/${publicRouteSlug}/`;
  const normalized = runtimeRelativeRouteForSpecValue(route, publicRouteSlug);
  return normalized ? `${root}${normalized}` : root;
}

function terminalRouteSegment(route) {
  const normalized = normalizePageKitRoute(route);
  const parts = normalized.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Declared route_root must be "/" or agree with public_route_slug — any other
// prefix would make the packet describe a route surface that contradicts the
// slug identity every other check roots on, which is the silent-disarm shape
// the c1 negative control exposed for the slug itself.
export function validateRouteRootDeclaration(packet, errors, ready) {
  const declared = packet?.campaign?.route_root;
  if (declared == null) return;
  const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  // The packet rule is exact: "/" or the canonical "/<public_route_slug>/"
  // only, mirroring the schema pattern, and it is the same rule every other
  // stage reads the packet by. So a near miss ("/example", "//example//") is
  // blocked here and honoured nowhere — the silent-disarm split this check
  // exists to close.
  const honoured = packetRouteRoot(declared, slug);
  if (honoured === "/") {
    ready.push(`Campaign is declared root-served (route_root "/"): routing metas and public routes validate against site-root paths; public_route_slug "${slug}" remains identity, not a path prefix`);
    return;
  }
  if (honoured) {
    ready.push(`Campaign route_root "/${slug}/" matches public_route_slug`);
    return;
  }
  addIssue(
    errors,
    "campaign.route_root",
    `Packet campaign.route_root ${JSON.stringify(declared)} is invalid. Declare exactly "/" for a root-served campaign or exactly "/${slug || "<public_route_slug>"}/" (leading and trailing slash) for the default slug-prefixed root. Any other value would contradict public_route_slug, which stays the campaign identity and the _site/<public_route_slug>/ built-output directory name.`
  );
}

function isRuntimeRootedRoutingMeta(value, publicRouteSlug, routeRoot = null) {
  if (isAbsoluteHttpUrl(value)) return true;
  const route = value.trim();
  if (!route.startsWith("/")) return false;
  const root = routeRoot || (publicRouteSlug ? `/${publicRouteSlug}/` : null);
  // Root-served: every absolute path is rooted at the served surface.
  if (root === "/") return true;
  if (!root) return false;
  const prefix = root.replace(/\/+$/, "");
  return route === prefix || route.startsWith(`${prefix}/`);
}

export function validateMarketSensitiveCopy(spec, warnings, ready, derived) {
  return withHtmlScanSnapshot(() => scanMarketSensitiveCopy(spec, warnings, ready, derived), { reuse: true });
}

function scanMarketSensitiveCopy(spec, warnings, ready, derived) {
  const scope = deriveMarketScope(spec);
  const currencyScope = deriveCurrencyCopyScope(spec);
  const storePhone = firstNonEmptyString(spec?.campaign?.store_phone, spec?.campaign?.phone);
  if (!scope.needsCopyReview && !currencyScope.needsCopyReview && !storePhone) return;

  const scanRoots = [];
  if (derived.source_root && existsSync(derived.source_root) && statSync(derived.source_root).isDirectory()) {
    scanRoots.push({ label: "source", root: derived.source_root });
  }
  if (derived.target_output_dir && existsSync(derived.target_output_dir) && statSync(derived.target_output_dir).isDirectory()) {
    scanRoots.push({ label: "target", root: derived.target_output_dir });
  }

  const matches = scope.needsCopyReview ? collectMarketCopyMatches(scanRoots) : [];
  if (scope.needsCopyReview && !matches.length) {
    ready.push(`Market-sensitive copy scan found no obvious US-only patterns (${scope.reasons.join(", ")}).`);
  } else if (matches.length) {
    const matchSummary = summarizeCopyMatches(matches);
    addIssue(
      warnings,
      "market_copy.us_specific_claims",
      `Campaign market scope needs copy review (${scope.reasons.join(", ")}), and source/template files contain US-specific starter copy: ${matchSummary}. Confirm or replace this copy; do not remove it automatically.`
    );
  }

  if (currencyScope.needsCopyReview) {
    const currencyMatches = collectHardcodedCurrencyMatches(scanRoots);
    // R2-B2: the assembled/built campaign output is the QA artifact.
    // Once the build has actually produced output and that output is
    // currency-clean, residual $ in the *source* HTML is the raw input the build
    // tokenized — not a live-page defect. Warn on the built output; downgrade
    // source-only residue to an info note so a correct build stops re-tripping
    // this warning. Guard on the target containing built HTML, not merely an
    // (empty) output directory existing — an empty target means the build has
    // not run yet, so source warnings must still stand.
    const targetScanRoot = scanRoots.find((scanRoot) => scanRoot.label === "target");
    const hasBuiltTarget = Boolean(targetScanRoot) && collectHtmlFiles(targetScanRoot.root).length > 0;
    const targetMatches = currencyMatches.filter((match) => match.surface === "target");
    const reportableMatches = hasBuiltTarget ? targetMatches : currencyMatches;
    if (!currencyMatches.length) {
      ready.push(`Hardcoded currency scan found no obvious static $ amounts (${currencyScope.reasons.join(", ")}).`);
    } else if (!reportableMatches.length) {
      ready.push(`Hardcoded currency scan: built output is currency-clean; ${currencyMatches.length} static $ amount(s) remain only in source HTML (raw input tokenized by build).`);
    } else {
      addIssue(
        warnings,
        "copy.hardcoded_currency_symbol",
        `Campaign currency scope needs copy review (${currencyScope.reasons.join(", ")}), and ${hasBuiltTarget ? "built campaign output" : "prepared HTML"} contains hardcoded $ amounts outside SDK-bound or skipped regions: ${summarizeCopyMatches(reportableMatches)}. Use SDK display tokens or remove static currency strings.`
      );
    }
  }

  if (storePhone) {
    const phoneMatches = collectHardcodedPhoneMatches(scanRoots, storePhone);
    if (!phoneMatches.length) {
      ready.push("Hardcoded phone scan found no mismatched static phone numbers.");
    } else {
      addIssue(
        warnings,
        "copy.hardcoded_phone",
        `Campaign Store Profile phone is "${storePhone}", but prepared HTML contains different hardcoded phone numbers outside skipped regions: ${summarizeCopyMatches(phoneMatches)}. Use the campaign.store_phone binding or remove static phone strings.`
      );
    }
  }
}

function deriveMarketScope(spec) {
  const campaign = spec?.campaign || {};
  const defaultCurrency = normalizeCurrency(campaign.currency);
  const currencies = [...new Set([
    ...normalizeCurrencyList(campaign.available_currencies),
    ...normalizeCurrencyList(campaign.additional_currencies),
    ...normalizeCurrencyList(campaign.additionalCurrencies),
  ])];
  const additionalCurrencies = currencies.filter((currency) => currency && currency !== defaultCurrency);
  const countries = campaign.available_shipping_countries;
  const countryList = Array.isArray(countries) ? countries.map((country) => String(country).trim()).filter(Boolean) : [];
  const nonUsCountries = countryList.filter((country) => !isUsCountryCode(country));
  const marketMode = String(campaign.market_mode || campaign.marketMode || campaign.market_scope || spec?.market_mode || "").trim();
  const reasons = [];

  if (additionalCurrencies.length) reasons.push(`additional currencies: ${additionalCurrencies.join(", ")}`);
  if (countries === "all") reasons.push("available_shipping_countries=all");
  if (nonUsCountries.length) reasons.push(`non-US shipping countries: ${nonUsCountries.join(", ")}`);
  if (/country|multi/i.test(marketMode)) reasons.push(`market mode: ${marketMode}`);

  return { needsCopyReview: reasons.length > 0, reasons };
}

function deriveCurrencyCopyScope(spec) {
  const campaign = spec?.campaign || {};
  const defaultCurrency = normalizeCurrency(campaign.currency);
  const currencies = [...new Set([
    ...normalizeCurrencyList(campaign.available_currencies),
    ...normalizeCurrencyList(campaign.additional_currencies),
    ...normalizeCurrencyList(campaign.additionalCurrencies),
  ])];
  const reasons = [];

  if (currencies.length > 1) reasons.push(`available currencies: ${currencies.join(", ")}`);
  if (defaultCurrency && defaultCurrency !== "USD") reasons.push(`default currency: ${defaultCurrency}`);

  return { needsCopyReview: reasons.length > 0, reasons };
}

function normalizeCurrency(value) {
  return isNonEmptyString(value) ? value.trim().toUpperCase() : "";
}

function normalizeCurrencyList(value) {
  if (Array.isArray(value)) return value.map(normalizeCurrency).filter(Boolean);
  if (isNonEmptyString(value)) return value.split(",").map(normalizeCurrency).filter(Boolean);
  return [];
}

function isUsCountryCode(value) {
  const country = String(value).trim().toUpperCase();
  return ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(country);
}

function collectMarketCopyMatches(scanRoots) {
  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readHtmlScanText(join(root, file.path)));
      for (const pattern of US_MARKET_COPY_PATTERNS) {
        const match = content.match(pattern.regex);
        if (match) {
          matches.push({
            surface,
            path: file.path,
            line: lineNumberAt(content, match.index || 0),
            label: pattern.label,
            text: match[0],
          });
        }
      }
    }
  }
  return matches;
}

function collectHardcodedCurrencyMatches(scanRoots) {
  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readHtmlScanText(join(root, file.path)));
      for (const match of content.matchAll(HARDCODED_CURRENCY_REGEX)) {
        matches.push({
          surface,
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: match[0].replace(/\s+/g, " ").trim(),
          text: match[0],
        });
      }
    }
  }
  return matches;
}

function collectHardcodedPhoneMatches(scanRoots, storePhone) {
  const expected = normalizePhoneNumber(storePhone);
  if (!expected) return [];

  const matches = [];
  for (const { label: surface, root } of scanRoots) {
    for (const file of collectHtmlFiles(root)) {
      const content = maskMarketLintIgnoredRegions(readHtmlScanText(join(root, file.path)));
      for (const match of content.matchAll(HARDCODED_PHONE_REGEX)) {
        const found = normalizePhoneNumber(match[0]);
        if (!found || found === expected) continue;
        matches.push({
          surface,
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: match[0].replace(/\s+/g, " ").trim(),
          text: match[0],
        });
      }
    }
  }
  return matches;
}

function maskMarketLintIgnoredRegions(content) {
  const ignoredElement =
    /<([A-Za-z][A-Za-z0-9:-]*)(?=[^>]*(?:data-next-display|data-next-bundle-display|data-skip-market-lint\s*=\s*["']true["']))[^>]*>[\s\S]*?<\/\1>/gi;
  const ignoredTag =
    /<[^>]*(?:data-next-display|data-next-bundle-display|data-skip-market-lint\s*=\s*["']true["'])[^>]*>/gi;

  return content
    .replace(ignoredElement, preserveNewlinesMask)
    .replace(ignoredTag, preserveNewlinesMask);
}

function preserveNewlinesMask(value) {
  return value.replace(/[^\n]/g, " ");
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function normalizePhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function summarizeCopyMatches(matches) {
  const summary = matches
    .slice(0, 8)
    .map((match) => `${match.surface}:${match.path}:${match.line} "${match.label}"`)
    .join("; ");
  const more = matches.length > 8 ? `; plus ${matches.length - 8} more` : "";
  return `${summary}${more}`;
}

function validateCampaignsApiKey(packet, spec, warnings, ready) {
  const apiKey = resolveCampaignsApiKey(packet, spec, process.env);
  if (apiKey.present) {
    ready.push(`Campaigns API key available via ${apiKey.source}`);
    if (apiKey.warning) addIssue(warnings, "campaign.api_key_source", apiKey.warning);
    return;
  }
  if (apiKey.rejected) {
    // Present but refused is its own finding: the operator fixes a value, not
    // a missing declaration. Names the source; the value is never printed.
    addIssue(warnings, "campaign.api_key_rejected", apiKey.warning, { source: apiKey.rejected.source, kind: apiKey.rejected.kind });
    return;
  }

  addIssue(
    warnings,
    "campaign.api_key_source",
    apiKey.warning || "Campaigns API key was not found in the local CampaignSpec, packet, or declared env var. API-side package/shipping/offer confirmation is deferred."
  );
}

// The malformed-key description starts mid-sentence ("the Campaigns API key
// from …"), which reads wrong at the head of a warning line; the env-name one
// starts with an identifier (`api_key_source "env:…"`) that must not be
// touched. Only the former is capitalised.
function sentenceCase(text) {
  return typeof text === "string" ? text.replace(/^the /, "The ") : text;
}

// Doctor's view of the key is a projection of the one resolver the remit
// rails use (resolveCampaignsApiKeySource): the same sources in the same
// order, the same shape gate, the same refusal vocabulary. A value that is
// there but refused on shape is reported as refused — naming the source,
// never the value — where doctor used to call any non-empty value present.
// What doctor adds is the "nothing usable" explanation, read from the
// packet's declared source, since the resolver reports absence without a why.
function resolveCampaignsApiKey(packet, spec, env) {
  const resolved = resolveCampaignsApiKeySource(packet, null, env, { spec });
  if (resolved.key) {
    return {
      present: true,
      source: resolved.origin,
      warning: resolved.origin.startsWith("packet.")
        ? "Campaigns API key is stored directly in the Build Packet. This is allowed for local/public-client builds, but shared fixtures may prefer CampaignSpec or env sourcing."
        : null,
    };
  }
  if (resolved.rejected) {
    return {
      present: false,
      source: resolved.rejected.source,
      rejected: resolved.rejected,
      warning: `${sentenceCase(describeCampaignKeyRejection(resolved.rejected))} API-side package/shipping/offer confirmation is deferred.`,
    };
  }

  const source = packet?.campaign?.api_key_source;
  if (!isNonEmptyString(source)) {
    return {
      present: false,
      source: null,
      warning: "No Campaigns API key source is declared, and the local CampaignSpec does not include campaign.campaigns_api_key. API-side package/shipping/offer confirmation is deferred.",
    };
  }

  if (source.startsWith("env:")) {
    // A set variable was either accepted (key) or refused (rejected) above,
    // so reaching here means it is unset.
    const envName = source.slice("env:".length).trim();
    return {
      present: false,
      source,
      warning: `Environment variable ${envName} is not set, and the local CampaignSpec does not include campaign.campaigns_api_key. API-side package/shipping/offer confirmation is deferred.`,
    };
  }

  if (source === "provided-out-of-band") {
    return {
      present: false,
      source,
      warning: "API key source is declared out-of-band; doctor cannot confirm Campaigns API refs before build.",
    };
  }

  return {
    present: false,
    source,
    warning: `Unsupported API key source "${source}". Use CampaignSpec campaign.campaigns_api_key, packet campaign.campaigns_api_key, or env:<VAR>.`,
  };
}

function routeLabel(route) {
  return route === "" ? "entry route (empty page_url)" : route;
}

function validateSpecPublicRoutes(spec, errors, ready) {
  const pages = activeSpecPages(spec);
  const routeMap = new Map();
  let routeErrors = 0;

  for (const page of pages) {
    if (hasHtmlExtensionRoute(page.page_url)) {
      routeErrors += 1;
      addIssue(
        errors,
        "spec.page_url_html_extension",
        `Page "${page.label || page.id}" declares page_url "${page.page_url}". CampaignSpec page_url is a Page Kit public route, not a source filename; use "${normalizePageKitRoute(page.page_url) || "(entry route)"}" instead.`
      );
    }

    const route = publicRouteForPage(page);
    const prior = routeMap.get(route);
    if (prior) {
      routeErrors += 1;
      addIssue(
        errors,
        "spec.route_collision",
        `Pages "${prior.label || prior.id}" and "${page.label || page.id}" both resolve to ${routeLabel(route)}. Set distinct page_url values before assembly.`
      );
    } else {
      routeMap.set(route, page);
    }
  }

  if (pages.length > 0 && routeErrors === 0) ready.push("CampaignSpec public page routes are Page Kit-compatible");
}

function pageRole(type) {
  if (["checkout", "upsell", "downsell", "thankyou", "receipt", "select"].includes(type)) return "runtime";
  return "visual";
}

function summarizeScopePages(pages) {
  return pages.map((page) => `${page.type || "page"}:${page.page_id}`).join(", ");
}

/**
 * Build a context-aware error message for a CampaignSpec page that has no source mapping.
 * When `design_source` is set, point the operator at the producing pipeline so the missing
 * source HTML can be regenerated instead of leaving the operator guessing.
 *
 * Per docs/entry-points.md, today's recognized producers:
 *   - figma:        run figma-sections-export
 *   - ai-generated: re-run the producing agent (Claude/Codex/etc.)
 *   - hand-authored / template-stock: no design_source set; falls through to generic
 *
 * Future producers (Penpot, Sketch, plain Markdown converters, etc.) slot in by adding a
 * `design_source.type` value here. The fallback path emits a generic "produce the source
 * HTML for this page" message so unknown types don't crash the operator's UX.
 *
 * @param {object} page Active spec page (may carry `design_source`).
 * @returns {string}
 */
function coverageErrorMessage(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  if (designSource) {
    const fileUrl = optionalString(designSource.file_url);
    if (designSource.type === "figma" && fileUrl) {
      return `Active CampaignSpec page "${page.id}" has no source mapping. Design is in Figma at ${fileUrl}; supply the source-html manifest for the page (see docs/design-source-package.md) — the exporter that produced the design emits it — then rerun prepare-build.`;
    }
    if (designSource.type === "ai-generated") {
      const fileUrlHint = fileUrl ? ` (design reference: ${fileUrl})` : "";
      return `Active CampaignSpec page "${page.id}" has no source mapping. design_source.type="ai-generated"${fileUrlHint} — re-run the producing agent so the source HTML and source-html manifest land in the source root, then rerun prepare-build. See docs/entry-points.md for the AI-generated entry point contract.`;
    }
    if (!fileUrl) {
      return `Active CampaignSpec page "${page.id}" has no source mapping. design_source is set but file_url is missing — add file_url to the spec before requesting a build.`;
    }
    return `Active CampaignSpec page "${page.id}" has no source mapping. design_source.type="${designSource.type}" at ${fileUrl}; produce the source HTML for this page (or update design_source.type to a recognized producer — see docs/entry-points.md) before rerunning prepare-build.`;
  }
  return `Active CampaignSpec page "${page.id}" has no source mapping.`;
}

/**
 * Build the optional `detail` payload for a source-coverage error. Captures the design_source
 * pointer when present so downstream agents/UIs can render a clickable link without re-parsing
 * the message string.
 *
 * @param {object} page Active spec page.
 * @returns {object | null}
 */
function coverageErrorDetail(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  // Always carry page_id so downstream consumers (including the prepare-build
  // gate dedup in addPrepareBuildGateErrors) can match this issue to the page
  // without re-parsing the message string.
  return {
    page_id: page?.id ?? null,
    ...(designSource
      ? {
          design_source: {
            type: designSource.type || null,
            file_url: optionalString(designSource.file_url) || null,
          },
        }
      : {}),
  };
}

// A declared out-of-scope page whose scope decision carries `template_stock`
// (recorded by prepare-build on dec_page_scope_<page>) is the locked family's
// own page: the build stage materialises it, and once its built HTML exists at
// the page's route it is a built page like any mapped one — previewable, and
// no longer a reason to block runtime QA. Until the build has written it, it
// stays out of scope exactly as before, so an unbuilt declaration is unchanged.
function templateStockDecision(buildState, pageId) {
  const decisions = buildState?.report?.decisions;
  if (!Array.isArray(decisions)) return null;
  const decision = decisions.find((entry) => entry?.id === `dec_page_scope_${pageId}` && entry?.template_stock === true);
  return decision || null;
}

function validateSourceCoverage(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const pages = packet.source_html?.pages || [];
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const materialisedTemplateStock = [];
  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
  validateSourceHtmlManifestAtRoot(sourceRoot, {
    spec,
    errors,
    warnings,
    ready,
    manifestPath: recordedDesignManifestPath(packet, packetPath),
  });
  const active = activeSpecPages(spec);
  const specPartialScope = spec?.build_scope?.mode === "partial";
  const specPartialReasons = Array.isArray(spec?.build_scope?.reasons) ? spec.build_scope.reasons.filter(isNonEmptyString) : [];
  const activeIds = new Set(active.map((page) => page.id));
  const mappedIds = new Set();
  const activeById = new Map(active.map((page) => [page.id, page]));
  const builtPages = [];
  const outOfScopePages = [];

  for (const page of pages) {
    if (!isNonEmptyString(page.page_id)) {
      addIssue(errors, "source_html.pages.page_id", "Every source page mapping needs page_id.");
      continue;
    }
    mappedIds.add(page.page_id);
    const specPage = activeById.get(page.page_id);
    if (!activeIds.has(page.page_id)) {
      addIssue(warnings, "source_html.pages.extra", `Source mapping "${page.page_id}" is not an active CampaignSpec page.`);
    }
    if (page.path) {
      const fullPath = resolve(sourceRoot, page.path);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        addIssue(errors, "source_html.pages.path", `Source page file does not exist: ${page.path}`);
      } else {
        // Slice 6: drift detection. When the packet carries a manifest-derived
        // source_hash for this page, compute the on-disk file's actual hash
        // and warn when they diverge. A mismatch means the file was edited
        // after the manifest was written, which is the signal that "design
        // handoff is stale" — operator should re-run the producer or accept
        // the local edits and regenerate the manifest.
        //
        // Silent when source_hash is absent (template-stock, hand-authored,
        // and producers that haven't adopted Slice 6 yet). Never an error —
        // drift is a warning so a build can still ship.
        const expectedHash = optionalString(page.source_hash);
        if (expectedHash) {
          const actualHash = sha256File(fullPath);
          if (actualHash !== expectedHash) {
            addIssue(
              warnings,
              "source_html.pages.source_hash",
              `Source page "${page.page_id}" hash mismatch — file at ${page.path} has changed since the manifest was written (manifest sha256=${expectedHash.slice(0, 12)}…, on-disk sha256=${actualHash.slice(0, 12)}…). Re-run the producer to refresh the manifest, or accept the local edits.`,
            );
          }
        }
        if (specPage) {
          builtPages.push({
            page_id: specPage.id,
            type: specPage.type || "page",
            role: pageRole(specPage.type),
            route: publicRouteForPage(specPage),
            source_path: page.path,
          });
        }
      }
    } else if (!page.skip_reason) {
      addIssue(errors, "source_html.pages.skip_reason", `Source mapping "${page.page_id}" needs path or skip_reason.`);
    } else {
      const stockDecision = specPage ? templateStockDecision(buildState, specPage.id) : null;
      const builtPath = stockDecision ? builtHtmlPathForPage(derived.target_repo, publicRouteSlug, specPage, derived) : null;
      if (stockDecision && builtPath && existsSync(builtPath)) {
        const family = optionalString(stockDecision.template_family) || "selected";
        builtPages.push({
          page_id: specPage.id,
          type: specPage.type || "page",
          role: pageRole(specPage.type),
          route: publicRouteForPage(specPage),
          source_path: null,
          template_stock: true,
          template_family: family,
        });
        materialisedTemplateStock.push({ page_id: specPage.id, family });
        continue;
      }
      const skipped = specPage
        ? {
            page_id: specPage.id,
            type: specPage.type || "page",
            role: pageRole(specPage.type),
            route: publicRouteForPage(specPage),
            skip_reason: page.skip_reason,
            ...(stockDecision ? { template_stock: true, template_family: optionalString(stockDecision.template_family) } : {}),
          }
        : { page_id: page.page_id, type: "unknown", role: "unknown", route: null, skip_reason: page.skip_reason };
      outOfScopePages.push(skipped);
      addIssue(
        warnings,
        "source_html.pages.skip_reason",
        stockDecision
          ? `CampaignSpec page "${page.page_id}" is template stock and not built yet: ${page.skip_reason} Keep it unbuilt unless explicitly opted in. For an opted-in page, the build stage materialises it from the ${optionalString(stockDecision.template_family) || "selected"} family's own page; it joins the previewable routes once its built HTML exists.`
          : `CampaignSpec page "${page.page_id}" is out of scope for this partial build: ${page.skip_reason}`,
      );
    }
  }

  if (materialisedTemplateStock.length > 0) {
    ready.push(`Template-stock page(s) materialised by the build stage: ${materialisedTemplateStock.map((entry) => `${entry.page_id} (${entry.family})`).join(", ")}`);
  }

  for (const page of active) {
    if (!mappedIds.has(page.id)) {
      addIssue(errors, "source_html.pages.coverage", coverageErrorMessage(page), coverageErrorDetail(page));
    }
  }

  const runtimeBlocked = outOfScopePages.filter((page) => page.role === "runtime");
  // A CampaignSpec build_scope "partial" declaration is discharged once every
  // page it took out of scope has been materialised: the declaration named
  // template-stock pages, and they now exist. With nothing materialised the
  // declaration stands on its own, as before.
  const partialScopeOpen = outOfScopePages.length > 0
    || (specPartialScope && materialisedTemplateStock.length === 0);
  derived.scope = {
    mode: partialScopeOpen ? "partial" : active.length ? "full" : "unknown",
    built_pages: builtPages,
    out_of_scope_pages: outOfScopePages,
    out_of_scope_reasons: specPartialReasons,
    previewable_routes: builtPages.map((page) => ({ page_id: page.page_id, type: page.type, route: page.route })),
    blocked_runtime_pages: runtimeBlocked,
  };

  if (partialScopeOpen) {
    const reasonSummary = specPartialReasons.length ? ` Reasons: ${specPartialReasons.join("; ")}.` : "";
    addIssue(
      warnings,
      "scope.partial_build",
      `Partial build scope detected. Built/previewable pages: ${summarizeScopePages(builtPages) || "none"}; out-of-scope pages: ${summarizeScopePages(outOfScopePages) || "declared in CampaignSpec build_scope"}.${reasonSummary}`
    );
    const buildScopeRuntimeBlocked = specPartialReasons.some((reason) => /\b(checkout|upsell|downsell|receipt|thankyou|runtime)\b/i.test(reason));
    if (runtimeBlocked.length > 0 || buildScopeRuntimeBlocked) {
      addIssue(
        warnings,
        "scope.runtime_qa_blocked",
        `Checkout/runtime launch QA is blocked for out-of-scope pages: ${summarizeScopePages(runtimeBlocked) || "declared in CampaignSpec build_scope"}. Preview QA should cover only the built routes.`
      );
    }
  }

  if (active.length > 0 && active.every((page) => mappedIds.has(page.id))) {
    ready.push(partialScopeOpen
      ? "Source mappings cover active CampaignSpec pages with explicit partial-scope skip reasons"
      : "Source mappings cover active CampaignSpec pages");
  }
  if (builtPages.length > 0) {
    ready.push(partialScopeOpen
      ? `Partial build previewable routes: ${builtPages.map((page) => routeLabel(page.route)).join(", ")}`
      : "All mapped CampaignSpec pages are build candidates");
  }
}

// Source preparation check (#262). Runs at every doctor evaluation — start and
// build embed doctor, so this is the start preflight the issue asks for while
// staying re-checkable after source edits. Blocking findings surface as doctor
// errors, which drive status "blocked" and a doctor-blocked / prepare-build next stage exactly
// like other unprepared-input states. Detection and severity policy live in
// src/source-prep.mjs; the codes and fixes are documented in
// docs/source-adapters.md "Source preparation check".
function validateSourcePreparation(packet, packetPath, errors, warnings, ready, derived = {}) {
  const sourceRoot = resolveFromFile(packetPath, packet.source_html?.root);
  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) return;
  const pages = Array.isArray(packet.source_html?.pages) ? packet.source_html.pages : [];
  const result = evaluateSourcePreparation({
    sourceRoot,
    pages,
    wrapperPolicy: packet.source_html?.adapter_contract?.wrapper_policy,
  });
  derived.source_preparation = {
    checked_page_count: result.checked_page_count,
    finding_codes: result.findings.map((finding) => finding.code),
  };
  for (const finding of result.findings) {
    addIssue(
      finding.severity === "error" ? errors : warnings,
      finding.code,
      finding.message,
      { pages: finding.pages, docs: finding.docs }
    );
  }
  if (result.checked_page_count > 0 && result.findings.length === 0) {
    ready.push("Mapped source pages pass the page-kit preparation check (document wrappers stripped, no leftover frontmatter, no source-file internal links)");
  }
}

// The manifest prepare-build read is recorded on the Design Source Package
// (html-funnel contribution, provenance.manifest_path, relative to the package
// file). Doctor reads the same file back, so a manifest supplied through
// --design-manifest from outside the source root is still the one doctor
// validates; with nothing recorded, the default path under the source root
// stands.
function recordedDesignManifestPath(packet, packetPath) {
  const packagePath = resolveFromFile(packetPath, packet?.design_source_package?.path);
  if (!packagePath || !existsSync(packagePath) || !statSync(packagePath).isFile()) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    return null;
  }
  const htmlFunnel = (Array.isArray(value?.contributions) ? value.contributions : [])
    .find((contribution) => contribution?.kind === "html_funnel");
  const recorded = optionalString(htmlFunnel?.provenance?.manifest_path);
  return recorded ? resolve(dirname(packagePath), recorded) : null;
}

function validateSourceHtmlManifestAtRoot(sourceRoot, { spec, errors, warnings, ready, manifestPath = null } = {}) {
  if (!isNonEmptyString(sourceRoot) || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) return;
  const result = readSourceHtmlManifestFile(sourceRoot, { manifestPath });
  if (!result.path) return;
  if (result.validation && !result.validation.ok) {
    const detail = result.validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    addIssue(warnings, "source_html.manifest", `Source-html manifest failed ${SOURCE_HTML_MANIFEST_SCHEMA} validation: ${detail}. Re-run or fix the producer before relying on manifest-derived page mappings.`);
    return;
  }
  if (result.warning) {
    addIssue(warnings, "source_html.manifest", result.warning);
    return;
  }
  for (const warning of result.warnings || []) {
    addIssue(warnings, "source_html.manifest", warning);
  }
  validateSourceProducerProvenance(result.manifest, { spec, errors, warnings, ready });
  ready.push(`Source-html manifest ${SOURCE_HTML_MANIFEST_SCHEMA} validated`);
}

function validateSourceProducerProvenance(manifest, { spec, errors, warnings, ready }) {
  const generator = optionalString(manifest?.generator) || "";
  const rawProvenance = manifest?.producer_provenance;
  const provenance = isObject(rawProvenance) ? rawProvenance : {};
  const expectsFigma = generator.startsWith("figma-sections-export@") || activeSpecPages(spec).some(hasFigmaDesignSource);
  if (!expectsFigma) return;

  if (!rawProvenance) {
    addIssue(
      errors,
      "source_html.producer_provenance",
      "Figma source manifest is missing producer_provenance. Re-run figma-sections-export handoff so Campaigns OS can gate semantic exporter provenance before assembly."
    );
  }

  if (provenance.source_type !== "semantic_figma_export") {
    addIssue(
      errors,
      "source_html.producer_provenance.source_type",
      `Figma source manifest source_type is "${provenance.source_type || "missing"}"; expected "semantic_figma_export". Screenshot or hand-authored fallback output cannot satisfy the Figma provenance gate.`
    );
  }
  if (provenance.screenshot_fallback_used !== false) {
    addIssue(
      errors,
      "source_html.producer_provenance.screenshot_fallback_used",
      "Figma source manifest reports screenshot_fallback_used=true. Re-run semantic figma-sections-export before assembly."
    );
  }
  if (!Number.isInteger(provenance.semantic_section_count) || provenance.semantic_section_count <= 0) {
    addIssue(
      errors,
      "source_html.producer_provenance.semantic_section_count",
      "Figma source manifest must report semantic_section_count > 0."
    );
  }
  if (!SOURCE_HASH_PATTERN.test(String(provenance.material_fingerprint || ""))) {
    addIssue(
      errors,
      "source_html.producer_provenance.material_fingerprint",
      "Figma source manifest must include a 64-character material_fingerprint over the handed-off source package."
    );
  }

  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!files.some((entry) => entry.role === "partial")) {
    addIssue(errors, "source_html.files.partial", "Figma source manifest files[] must include section partials.");
  }
  if (!files.some((entry) => entry.role === "asset")) {
    addIssue(errors, "source_html.files.asset", "Figma source manifest files[] must include exported assets.");
  }

  const sectionExports = Array.isArray(provenance.section_exports) ? provenance.section_exports : [];
  if (!sectionExports.length) {
    addIssue(errors, "source_html.producer_provenance.section_exports", "Figma source manifest must include section_exports with Figma node IDs and extraction commands.");
  } else {
    const withoutNodeIds = sectionExports
      .filter((entry) => {
        const nodeIds = isObject(entry?.node_ids) ? entry.node_ids : null;
        return !nodeIds || !Object.keys(nodeIds).length;
      })
      .map((entry) => entry?.section || "unknown");
    if (withoutNodeIds.length) {
      addIssue(
        warnings,
        "source_html.producer_provenance.section_exports.node_ids",
        `Some Figma section exports do not list node_ids: ${withoutNodeIds.slice(0, 6).join(", ")}${withoutNodeIds.length > 6 ? ", ..." : ""}.`
      );
    }
  }

  if (errors.every((issue) => !String(issue.code || "").startsWith("source_html.producer_provenance") && !["source_html.files.partial", "source_html.files.asset"].includes(issue.code))) {
    ready.push("Figma producer provenance gate passed: semantic_figma_export with package fingerprint");
  }
}

function hasFigmaDesignSource(page) {
  const designSource = page && isObject(page.design_source) ? page.design_source : null;
  return Boolean(designSource && (String(designSource.type || "").toLowerCase() === "figma" || /figma\.com\//i.test(optionalString(designSource.file_url))));
}

// Helpers ported from the private build-packet doctor (ADR-003 step 2) so the
// shared-concern template-contract checks live here in the public doctor too.
function frontmatterList(contract, key) {
  const value = contract?.frontmatter?.[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
function contractMentions(contract, pattern, keys = ["requiredWhenCloning", "replaceFromSpecOrApi"]) {
  return keys.flatMap((key) => frontmatterList(contract, key)).some((value) => pattern.test(value));
}
function packageRefsFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => entry?.ref_id ?? entry?.package_ref_id ?? entry?.package_id ?? entry?.id)
    .filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map((value) => String(value));
}
function offerRefsFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => [entry?.package_ref_id, entry?.package_id, entry?.ref_id, entry?.code])
    .filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map((value) => String(value));
}

function isAutomatableTemplateFamily(family) {
  return isNonEmptyString(family) && family !== "undecided" && family !== "custom";
}

// One resolution of the family brand contract per doctor run, keyed by the
// run's `derived` — the in-process bag every check reads. The JSON-visible
// summary lands on derived.brand_contract: `state` (no_family, no_contract,
// no_palette_checks, inspected, defect), `family`, and for a defect the
// loader's code and a one-line detail — the shape the `next` advisories read.
// The contract object itself stays in process. A defect is reported once, by
// the first check that reports it, at that check's severity: before this, a
// standard packet with an unreadable contract carried the same finding twice
// (an error from the catalog check and a warning from the pricing scan).
const BRAND_CONTRACT_RESOLUTIONS = new WeakMap();

// The one resolution: the contract object (or the loader's error) and the
// summary every consumer reads. null is "resolved to no contract", never
// "something went wrong": no public contract file AND no private fragment
// carrying a brandContract, for which QA emits no residue rows. A defect
// throws instead; the two must not be collapsed.
function resolveBrandContract(family) {
  const label = optionalString(family);
  if (!label) return { contract: null, error: null, summary: { state: "no_family", family: null } };
  try {
    const contract = resolveTemplateBrandContract(label);
    const state = contract ? (contractHasPaletteResidueChecks(contract) ? "inspected" : "no_palette_checks") : "no_contract";
    return { contract, error: null, summary: { state, family: label } };
  } catch (error) {
    return {
      contract: null,
      error,
      summary: {
        state: "defect",
        family: label,
        code: safeBrandContractCode(error?.code),
        detail: singleLineDetail(error instanceof Error ? error.message : error),
      },
    };
  }
}

function resolveBrandContractOnce(derived, family) {
  if (BRAND_CONTRACT_RESOLUTIONS.has(derived)) return BRAND_CONTRACT_RESOLUTIONS.get(derived);
  const { contract, error, summary } = resolveBrandContract(family);
  derived.brand_contract = summary;
  const resolution = { contract, error, reported: false };
  BRAND_CONTRACT_RESOLUTIONS.set(derived, resolution);
  return resolution;
}

function reportBrandContractDefectOnce(resolution, collection, family) {
  if (!resolution.error || resolution.reported) return;
  resolution.reported = true;
  addIssue(
    collection,
    "template_contract.brand_contract",
    `Template brand contract for "${family}" failed to load: ${resolution.error.message}`,
    templateBrandContractErrorDetail(resolution.error, family),
  );
}

function loadTemplateFamilyBrandContract(family, errors, warnings, derived, { required = false } = {}) {
  const resolution = resolveBrandContractOnce(derived, family);
  if (resolution.error) {
    reportBrandContractDefectOnce(resolution, required ? errors : warnings, family);
    return null;
  }
  if (!resolution.contract && required) {
    addIssue(
      errors,
      "template_contract.brand_contract",
      `Template family "${family}" has no brand/residue/pricing contract at contracts/template-brand-contract.${family}.v0.json. Add the contract before treating this family as promoted/agent-ready.`,
      {
        template_family: family,
        reason: "missing_file",
        contract_path: `contracts/template-brand-contract.${family}.v0.json`,
      },
    );
  }
  return resolution.contract;
}

function templateBrandContractErrorDetail(error, family) {
  return {
    template_family: family || null,
    reason: typeof error?.code === "string" ? error.code : "load_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function validateCommerceCatalog(packet, packetPath, spec, errors, warnings, ready, derived = {}, buildState = {}) {
  const family = packet.assembly?.template_family;
  // Match the private doctor (build-packet.js): the ported template_contract.*
  // checks below do not apply to non-automatable families. The pre-existing
  // agentContract / demo_ref / shipping checks keep running for all families.
  const familyAutomatable = isAutomatableTemplateFamily(family);
  const catalogInfo = packet.assembly?.commerce_catalog || {};
  if (catalogInfo.required !== true) return;
  const catalogResolution = resolvePacketCommerceCatalogPath(packetPath, catalogInfo);
  const catalogPath = catalogResolution.path;
  if (!catalogPath || !existsSync(catalogPath)) {
    addIssue(errors, "assembly.commerce_catalog.path", "Commerce catalog is required but not found.");
    return;
  }
  if (catalogResolution.source === "stale_packet_path") {
    // Not a warning: the catalog resolved and nothing about the build changes.
    // The line tells the operator the packet still names one machine's
    // checkout, and that a re-prepare records the toolkit default (null).
    ready.push(
      `Commerce catalog resolved to the running toolkit's copy; the packet's recorded path ${catalogResolution.recorded} ` +
      "does not exist here (it names the checkout that ran prepare-build). Re-run prepare-build to clear the machine-local path.",
    );
  }
  const catalog = resolveCommerceCatalog(catalogPath);
  if (familyAutomatable && catalog.agentContractVersion !== 1) {
    addIssue(warnings, "template_contract.catalog_version", "Commerce surface catalog agentContractVersion is not 1; verify contract semantics before build.");
  }
  if (!isObject(catalog.sharedFrontmatterVocabulary)) {
    addIssue(errors, "catalog.sharedFrontmatterVocabulary", "Commerce catalog is missing sharedFrontmatterVocabulary.");
  } else {
    ready.push("Commerce catalog sharedFrontmatterVocabulary loaded");
  }
  const contract = catalog.families?.[family]?.agentContract;
  if (!contract) {
    addIssue(errors, "template_contract.agentContract", `Template family "${family}" has no agentContract.`);
    return;
  }
  ready.push(`Template agentContract loaded for ${family}`);
  const brandContract = loadTemplateFamilyBrandContract(family, errors, warnings, derived, { required: familyAutomatable });
  if (brandContract) {
    ready.push(`Template brand/residue/pricing contract loaded for ${family}`);
    validateTemplateFamilyInventory(brandContract, errors, ready);
  }
  if (familyAutomatable && contract.status && contract.status !== "agent-ready") {
    addIssue(warnings, "template_contract.status", `Template family "${family}" contract status is "${contract.status}"; treat this as guided assembly, not full automation.`);
  }
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  if (assemblyComplete) {
    validateBuiltContractResidue(contract, warnings, ready, derived, spec);
    // H3.1/H3.2: pre-QA warnings off the family brand contract. Doctor warns
    // (the fix happens during build/polish); browser QA enforces the same
    // placeholder-text terms as a blocker in the verdict.
    validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived, { report: buildState.report });
    validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived);
  } else {
    for (const value of contract.frontmatter?.demoOnlyValues || []) {
      addIssue(warnings, "frontmatter.demoOnlyValues", `Replace demo-only starter value before launch: ${value}`);
    }
    for (const value of contract.frontmatter?.replaceFromSpecOrApi || []) {
      addIssue(warnings, "frontmatter.replaceFromSpecOrApi", `Must be replaced from CampaignSpec/API: ${value}`);
    }
    for (const value of contract.frontmatter?.removeWhenUnsupported || []) {
      addIssue(warnings, "frontmatter.removeWhenUnsupported", `Remove when unsupported by target campaign: ${value}`);
    }
  }
  const consumesExplicitShipping = contractMentionsShipping(contract);
  if (family === "shop-three-step") {
    ready.push("shop-three-step uses dynamic shipping via window.next.getShippingMethods(); do not copy Olympus-style shipping_methods frontmatter into it.");
  }
  if (!consumesExplicitShipping) {
    validateUnsupportedShippingFrontmatter(packet, packetPath, family, warnings, ready, derived);
  } else if (spec && !Array.isArray(spec.shipping_methods)) {
    addIssue(errors, "template_contract.shipping_methods", `${family} contract references shipping_methods but CampaignSpec has no shipping_methods array.`);
  }
  if (spec) {
    const demoRefHits = collectDemoRefHits(spec, catalog.sharedFrontmatterVocabulary);
    for (const hit of demoRefHits) {
      addIssue(
        warnings,
        "template_contract.demo_ref",
        `CampaignSpec contains a starter-looking demo ref "${hit.value}" at ${hit.path}. Confirm it came from the actual Campaigns API or attach _provenance.api/source metadata.`
      );
    }

    // ADR-003 step 2: template-contract checks ported from the private doctor.
    const specPages = activeSpecPages(spec);

    const mismatchedFamilies = specPages.filter(
      (page) => isNonEmptyString(page.sdk_hints?.template_family) && page.sdk_hints.template_family !== family
    );
    if (familyAutomatable && mismatchedFamilies.length > 0) {
      addIssue(
        errors,
        "template_contract.spec_family",
        `CampaignSpec sdk_hints.template_family disagrees with packet template family on pages: ${mismatchedFamilies.map((page) => `${page.id}=${page.sdk_hints.template_family}`).join(", ")}.`
      );
    }

    const checkoutPackageRefs = specPages
      .filter((page) => page.type === "checkout" || page.type === "select")
      .flatMap((page) => packageRefsFromEntries(page.packages));
    if (familyAutomatable && contractMentions(contract, /\b(packages\.main_package|single_offer\.package_id|variant_slots)\b/) && checkoutPackageRefs.length === 0) {
      addIssue(
        errors,
        "template_contract.packages",
        `Template family "${family}" requires checkout package frontmatter, but the active CampaignSpec checkout/select pages have no package refs.`
      );
    }

    const upsellPages = specPages.filter((page) => page.type === "upsell" || page.type === "downsell");
    const upsellPackageRefs = upsellPages.flatMap((page) => [
      ...packageRefsFromEntries(page.packages),
      ...offerRefsFromEntries(page.offers),
    ]);
    if (
      familyAutomatable &&
      contractMentions(contract, /\b(upsell_offer|upsell_bundle_tiers|inline upsell)\b/, ["optionalWhenSupported", "replaceFromSpecOrApi", "demoOnlyValues"]) &&
      upsellPages.length > 0 &&
      upsellPackageRefs.length === 0
    ) {
      addIssue(
        errors,
        "template_contract.upsell_refs",
        `Template family "${family}" exposes upsell frontmatter, but active upsell/downsell pages have no package or offer refs to replace demo values.`
      );
    }
    validateCodeLessUpsellOfferBinding({ familyAutomatable, contract, family, upsellPages, errors, ready });
    validateExitPopContract(brandContract, spec, family, warnings, ready, derived, buildState);
  }
}

function validateCodeLessUpsellOfferBinding({ familyAutomatable, contract, family, upsellPages, errors, ready }) {
  if (!familyAutomatable || !Array.isArray(upsellPages) || upsellPages.length === 0) return;
  const usesVoucherJson = contractMentions(contract, /\bvouchers_json\b/, ["replaceFromSpecOrApi", "demoOnlyValues", "optionalWhenSupported"]);
  const supportsOfferRef = contractMentions(contract, /\boffer_ref(?:_id)?\b/, ["replaceFromSpecOrApi", "demoOnlyValues", "optionalWhenSupported", "requiredWhenCloning"]);
  if (!usesVoucherJson || supportsOfferRef) return;

  const codeLessDiscountOffers = [];
  for (const page of upsellPages) {
    for (const offer of Array.isArray(page.offers) ? page.offers : []) {
      if (!isCodeLessDiscountOffer(offer)) continue;
      codeLessDiscountOffers.push({
        page_id: page.id,
        label: page.label || null,
        offer_ref_id: offer.ref_id || offer.id || null,
        benefit_type: offer.benefit?.type || null,
        benefit_value: offer.benefit?.value || null,
      });
    }
  }

  if (!codeLessDiscountOffers.length) {
    ready.push(`${family} upsell offers have code-backed discounts or no code-less discount offer binding requirement`);
    return;
  }

  addIssue(
    errors,
    "template_contract.upsell_offer_binding",
    `Template family "${family}" exposes post-purchase upsell vouchers_json but CampaignSpec has code-less discount offer refs: ${codeLessDiscountOffers.map((offer) => `${offer.page_id}:${offer.offer_ref_id || "unknown"}`).join(", ")}. Add a supported offer-ref binding to the template/SDK adapter, use a code-backed offer, or block assembly; otherwise accepted upsells can commit at full price.`,
    { offers: codeLessDiscountOffers, template_family: family }
  );
}

function isCodeLessDiscountOffer(offer) {
  if (!isObject(offer)) return false;
  if (isNonEmptyString(offer.code)) return false;
  if (offer.ref_id === undefined && offer.id === undefined) return false;
  const benefit = isObject(offer.benefit) ? offer.benefit : null;
  const benefitType = String(benefit?.type || "").toLowerCase();
  const value = benefit?.value;
  if (!benefit || !/(percentage|percent|discount|fixed|amount)/.test(benefitType)) return false;
  if (value === undefined || value === null) return false;
  return String(value).trim().length > 0 && Number.isFinite(Number(value));
}

export function validateTemplateFamilyInventory(contract, errors, ready) {
  const inventory = contract.family_inventory;
  if (!isObject(inventory)) {
    addIssue(errors, "template_contract.family_inventory", `Template brand contract for "${contract.family}" is missing family_inventory.`);
    return;
  }
  const required = [
    "supported_pages",
    "required_sdk_anchors",
    "theme_insertion_point",
    "default_color_residue",
    "pricing_presentation",
    "bundle_picker",
    "order_bump",
    "upsell_downsell",
    "exit_pop",
    "qa_selectors",
  ];
  const missing = required.filter((key) => !hasPopulatedInventoryValue(inventory[key]));
  if (missing.length) {
    addIssue(errors, "template_contract.family_inventory", `Template brand contract for "${contract.family}" family_inventory is missing or empty: ${missing.join(", ")}.`);
    return;
  }
  ready.push(`Template family inventory matrix loaded for ${contract.family}`);
}

function hasPopulatedInventoryValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.values(value).some((entry) => hasPopulatedInventoryValue(entry));
  return true;
}

export function validateExitPopContract(contract, spec, family, warnings, ready, derived, buildState = {}) {
  const exitPop = contract?.exit_pop;
  if (!exitPop || !spec) return;
  const hasGovernedOfferSurface = activeSpecPages(spec).some((page) => (
    page?.type === "checkout" && (page?.exit_intent?.enabled === true || page?.promo_code_input?.enabled === true)
  ));
  if (hasGovernedOfferSurface) {
    ready.push(`${family} exit-pop/promo-code behavior is governed by CampaignSpec offer-surface fields`);
    return;
  }

  const inventoryExitPop = contract.family_inventory?.exit_pop;
  if (!isStageComplete(buildState.report, "assembly")) {
    if (inventoryExitPop?.default_included === true) {
      addIssue(
        warnings,
        "template_contract.exit_pop",
        `Template family "${family}" includes an exit-pop by default, but active CampaignSpec checkout pages do not define exit_intent or promo_code_input. Strip the widget or wire a mapped offer/code through the SDK coupon path during build.`
      );
    }
    return;
  }

  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const residueHits = collectLiteralMatches(targetOutputDir, exitPop.residue_literals || []);
  if (residueHits.length) {
    addIssue(
      warnings,
      "template_contract.exit_pop_residue",
      `Assembly is recorded complete, but target output contains exit-pop/template offer residue while CampaignSpec has no checkout exit_intent or promo_code_input: ${summarizeCopyMatches(residueHits)}. Strip it or add a mapped offer surface.`
    );
  } else {
    ready.push(`Built target output has no ungoverned ${family} exit-pop residue`);
  }
  const blankHits = collectLiteralMatches(targetOutputDir, exitPop.blank_widget_literals || []);
  if (blankHits.length) {
    addIssue(
      warnings,
      "template_contract.exit_pop_blank_widget",
      `Assembly is recorded complete, but target output still contains default/blank exit-pop widget copy or coupon placeholders: ${summarizeCopyMatches(blankHits)}.`
    );
  }
}

function validateBuiltContractResidue(contract, warnings, ready, derived, spec = null) {
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) {
    addIssue(warnings, "frontmatter.build_state", "Assembly is recorded complete, but doctor cannot scan the target output directory for remaining starter contract residue.");
    return;
  }

  const literalValues = [
    ...(contract.frontmatter?.demoOnlyValues || []),
    ...(contract.frontmatter?.removeWhenUnsupported || []),
  ].filter((value) => isNonEmptyString(String(value)) && !String(value).includes("."));
  const hits = collectLiteralMatches(targetOutputDir, literalValues);
  if (!hits.length) {
    ready.push("Built target output has no obvious demo-only or unsupported starter contract residue");
  } else {
    addIssue(
      warnings,
      "frontmatter.build_residue",
      `Assembly is recorded complete, but target output still contains starter contract residue: ${summarizeCopyMatches(hits)}.`
    );
  }

  const genericHits = collectGenericTemplateResidueMatches(targetOutputDir);
  if (genericHits.length) {
    addIssue(
      warnings,
      "template_contract.literal_residue",
      `Assembly is recorded complete, but built output still contains generic starter/template placeholders: ${summarizeCopyMatches(genericHits)}. Replace these from CampaignSpec/API or remove dead template references before QA.`
    );
  } else {
    ready.push("Built target output has no generic starter placeholder or promo-code residue");
  }

  const maxDiscount = maxSpecDiscountPercent(spec);
  if (maxDiscount !== null) {
    const discountHits = collectOverstatedDiscountClaimMatches(targetOutputDir, maxDiscount);
    if (discountHits.length) {
      addIssue(
        warnings,
        "template_contract.discount_claim_residue",
        `Assembly is recorded complete, but built output claims discount percentages above the CampaignSpec maximum (${formatPercent(maxDiscount)}): ${summarizeCopyMatches(discountHits)}. Generate promo/banner/timer copy from actual offers and vouchers.`
      );
    } else {
      ready.push(`Built target output has no promo discount claims above CampaignSpec max (${formatPercent(maxDiscount)})`);
    }
  } else {
    const discountClaims = collectDiscountClaimMatches(targetOutputDir);
    if (discountClaims.length) {
      addIssue(
        warnings,
        "template_contract.discount_claim_unverified",
        `Assembly is recorded complete, but built output contains promo discount percentage claims without explicit CampaignSpec percentage discount values: ${summarizeCopyMatches(discountClaims)}. Confirm the intended business logic with the build request/merchant notes or remove the claims before launch.`
      );
    } else {
      ready.push("Built target output has no promo discount percentage claims requiring CampaignSpec verification");
    }
  }
}

// H3.1 (doctor surface): literal placeholder TEXT in built HTML. Word-boundary
// matched off the family brand contract's placeholder_text_residue.terms, so
// the doctor warning and the browser QA blocker key off one declared term set.
// Scans the VISIBLE text of each page (not the includes/layouts the family
// ships), the same surface the browser gate reads: an `<input
// placeholder="Placeholder">` hint, a data-* hook, a comment or a script
// string is not rendered copy and must not warn where QA would pass.
//
// `report`: once QA has recorded this gate as passed on the current build
// (qaGatePassedForCurrentBuild), the browser's verdict outranks this static
// approximation — any remaining static hit demotes to a ready line instead of
// a warning, so `next` stops asking for a fix QA already cleared. A rebuild
// changes the fingerprint and the warning returns until QA runs again.
export function validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived, { report = null } = {}) {
  const config = placeholderTextResidueConfig(brandContract);
  if (!config) return;
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const hits = collectPlaceholderTextResidueMatches(targetOutputDir, config.terms);
  if (!hits.length) {
    ready.push("Built target output has no literal template placeholder text");
    return;
  }
  const terms = [...new Set(hits.map((hit) => hit.label))].join(", ");
  if (report && qaGatePassedForCurrentBuild(report, QA_GATE_PLACEHOLDER_TEXT_RESIDUE, { buildFingerprint: currentBuildFingerprint(report) })) {
    ready.push(`Static scan still sees placeholder-term text (${terms}: ${summarizeCopyMatches(hits)}), but the browser residue gate passed on this build; QA's rendered-text verdict stands.`);
    return;
  }
  addIssue(
    warnings,
    "template_contract.placeholder_text_residue",
    `Assembly is recorded complete, but built output still contains literal template placeholder text (${terms}): ${summarizeCopyMatches(hits)}. Replace with CampaignSpec/design copy; browser QA blocks on these terms.`,
  );
}

function collectPlaceholderTextResidueMatches(root, terms) {
  const matches = [];
  for (const file of collectHtmlFiles(root)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const content = visibleText(readHtmlScanText(join(root, file.path)), { keepLines: true });
    for (const match of placeholderTextResidueMatches(content, terms)) {
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: match.term,
        text: match.match,
      });
    }
  }
  return matches;
}

// Rendered-output content-residue scan (assembly-surfaces prototype): scans
// BUILT pages for the needs-merchant-input marker and urgency chrome rendered
// without verified offer urgency (blockers), plus demo/placeholder residue and
// generic content anti-pattern hits (warnings feeding the review/attestation
// queue). Scans _site output, not frontmatter — layout/script-rendered chrome
// only exists after the build.
export function validateBuiltContentResidue(packet, errors, warnings, ready, derived, buildState = {}) {
  if (!isStageComplete(buildState.report, "assembly")) return;
  // Scan the RENDERED _site output, not the campaign source dir: the Liquid
  // guards ({% if countdown_label %}) only resolve at build time, and layout/
  // script-rendered chrome only exists in the built pages.
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = derived.target_repo && publicRouteSlug ? join(derived.target_repo, "_site", publicRouteSlug) : null;
  if (!siteRoot || !existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) return;
  const brief = loadBriefPayload(derived.target_repo);
  const urgencyVerified = briefUrgencyVerified(brief?.payload);
  const findings = scanBuiltOutputContentResidue(siteRoot, { urgencyVerified });
  if (!findings.length) {
    ready.push("Built output carries no needs-input markers, unverified urgency chrome, or content-residue hits");
    return;
  }
  // One issue per finding id, carrying the FULL file inventory: the id keeps
  // the issue list readable (a demo term on every page is one problem, not
  // five), while the file list tells the operator everything to fix.
  const byId = new Map();
  for (const finding of findings) {
    const group = byId.get(finding.id) || { first: finding, files: new Set() };
    group.files.add(finding.file);
    byId.set(finding.id, group);
  }
  const describeFiles = (files) => {
    const list = [...files].sort();
    const shown = list.slice(0, 5).join(", ");
    return list.length > 5 ? `${list.length} pages: ${shown}, …` : shown;
  };
  // The AI-assembled path is "a READABLE brief payload exists" — an unreadable
  // one already blocks via proof_attestation.unreadable, and pointing the
  // operator at offer.urgency.verified inside a file that cannot be parsed
  // would be wrong remediation copy.
  const briefReadable = Boolean(brief && !brief.error && brief.payload);
  for (const [id, group] of byId) {
    const finding = group.first;
    const where = describeFiles(group.files);
    if (id === "needs_merchant_input_marker") {
      addIssue(
        errors,
        "content_residue.needs_merchant_input",
        `Built output still renders needs-merchant-input marker(s) (${where}; e.g. "${finding.excerpt}"). Collect the missing merchant input (attestation lane) before publish.`,
      );
    } else if (id === "unverified_urgency_countdown") {
      // The scanner emits this only when the brief does not verify urgency
      // (urgencyVerified=false). Severity keys on the path: with a readable
      // brief payload (AI-assembled) it blocks; a designed-source campaign
      // with no brief payload may carry an intentional countdown — warning.
      if (briefReadable) {
        addIssue(
          errors,
          "content_residue.unverified_urgency",
          `Built output renders countdown chrome without verified offer urgency (${where}). Set offer.urgency.verified in ${BRIEF_PAYLOAD_REL_PATH} from a real promotion window, or blank the urgency slots.`,
        );
      } else if (brief?.error) {
        // Unreadable brief payload: the run is already blocked by
        // proof_attestation.unreadable with the right remediation (repair the
        // brief). Urgency is re-evaluated on the next doctor run once the
        // brief parses — "confirm the urgency is real" copy here would point
        // the operator at the wrong fix.
      } else {
        addIssue(
          warnings,
          "content_residue.urgency_unattested",
          `Built output renders countdown chrome and no brief payload attests the promotion window (${where}). Confirm the urgency is real (a genuine offer window or live inventory) before launch.`,
        );
      }
    } else if (id === "demo_residue_term" || id === "bracket_placeholder_stub") {
      addIssue(
        warnings,
        "content_residue.demo_residue",
        `Built output carries template demo/placeholder residue (${where}; e.g. "${finding.excerpt}"). Fill or blank the slot — demo values must never ship.`,
      );
    } else {
      addIssue(
        warnings,
        "content_residue.anti_pattern",
        `Built output matches content anti-pattern "${id}" (${where}; e.g. "${finding.excerpt}"). ${finding.rule || "Remove it or route it through brief-sourced proof."} This is a review warning and nothing downstream blocks on it: the claim is the operator's and the client's responsibility — remove or evidence it, never make it more plausible.`,
      );
    }
  }
}

// Proof-attestation gate over the brief payload's proof_assets (click-wrap
// lane). Usable = verified:true OR attestation_status:"accepted". Enforcement
// keys on whether a non-usable asset's content actually SHIPPED in built
// output: shipped pending/non-attestable content blocks (collect-inputs);
// non-shipped, non-usable assets stay warnings (the attestation queue), so a
// producer that correctly excluded them is not blocked.
export function validateProofAttestation(packet, errors, warnings, ready, derived, buildState = {}) {
  const brief = loadBriefPayload(derived.target_repo);
  if (!brief) return; // not an AI-assembled run — no brief payload, no gate
  if (brief.error) {
    // Fail closed: the brief payload is the source of attestation state. If
    // it exists but cannot be read, unapproved proof could ship unevaluated.
    addIssue(errors, "proof_attestation.unreadable", `Brief payload at ${BRIEF_PAYLOAD_REL_PATH} failed to parse: ${brief.error}. Repair or regenerate it — the attestation gate cannot evaluate proof states.`);
    return;
  }
  const proofAssets = brief.payload?.proof_assets;
  if (!Array.isArray(proofAssets) || proofAssets.length === 0) {
    ready.push("Brief payload declares no proof assets (scenario-framing fallback applies)");
    return;
  }
  const assemblyComplete = isStageComplete(buildState.report, "assembly");
  const publicRouteSlug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
  const siteRoot = derived.target_repo && publicRouteSlug ? join(derived.target_repo, "_site", publicRouteSlug) : null;
  let renderedText = "";
  if (assemblyComplete && siteRoot && existsSync(siteRoot)) {
    renderedText = collectRenderedHtmlFiles(siteRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
  }
  const findings = evaluateProofAssets(proofAssets, renderedText);
  const usable = findings.filter((f) => f.state === "verified" || f.state === "accepted").length;
  const pending = findings.filter((f) => f.state === "pending");
  const nonAttestable = findings.filter((f) => f.state === "non_attestable");
  if (!assemblyComplete) {
    // Shipped-content evaluation needs built output; before assembly there is
    // nothing to judge and a "none shipped" warning would be both misleading
    // and noisy on every pre-build doctor run.
    ready.push(
      `Brief payload declares ${proofAssets.length} proof asset(s) (${usable} usable, ${pending.length} pending attestation, ${nonAttestable.length} non-attestable); shipped-content evaluation runs after assembly.`,
    );
    return;
  }
  const { shippedNonAttestable, shippedPending } = attestationBlockers(findings);
  for (const finding of shippedNonAttestable) {
    addIssue(
      errors,
      "proof_attestation.non_attestable_shipped",
      `Built output ships non-attestable proof asset ${finding.assetId ?? "(unidentified)"} (${finding.modality ?? "unknown modality"}). This proof class is never attestable — remove it from the content.`,
    );
  }
  for (const finding of shippedPending) {
    addIssue(
      errors,
      "proof_attestation.pending_shipped",
      `Built output ships proof asset ${finding.assetId ?? "(unidentified)"} (${finding.modality ?? "unknown modality"}) whose attestation is not accepted. Collect the merchant's click-wrap attestation or remove the claim.`,
    );
  }
  if (!shippedNonAttestable.length && !shippedPending.length && (pending.length || nonAttestable.length)) {
    addIssue(
      warnings,
      "proof_attestation.queue",
      `Brief payload carries ${pending.length} attestation-pending and ${nonAttestable.length} non-attestable proof asset(s); none shipped in built output. Pending items are the merchant attestation checklist.`,
    );
  }
  if (usable) ready.push(`${usable} proof asset(s) usable (verified or attestation accepted)`);
}

// H3.2 (doctor surface): the family's own demo placeholder assets surviving
// into built output. Reuses the literal-match infra over the demo-asset
// basenames declared in the brand contract. Warning only — the agent re-skins.
export function validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived) {
  const config = demoAssetConfig(brandContract);
  if (!config || !config.assetBasenames.length) return;
  const targetOutputDir = derived.target_output_dir;
  if (!targetOutputDir || !existsSync(targetOutputDir) || !statSync(targetOutputDir).isDirectory()) return;
  const hits = collectLiteralMatches(targetOutputDir, config.assetBasenames);
  if (hits.length) {
    const assets = [...new Set(hits.map((hit) => hit.label))].join(", ");
    addIssue(
      warnings,
      "template_contract.demo_asset_residue",
      `Assembly is recorded complete, but built output still references template demo assets (${assets}): ${summarizeCopyMatches(hits)}. Re-skin to the campaign's real assets rather than shipping template placeholders.`,
    );
  } else {
    ready.push("Built target output references no template demo placeholder assets");
  }
}

function collectLiteralMatches(root, values) {
  if (!values.length) return [];
  const escaped = values.map((value) => escapeRegExp(String(value))).join("|");
  const regex = new RegExp(escaped, "g");
  const matches = [];
  for (const file of collectHtmlFiles(root)) {
    if (file.path.includes("_includes/") || file.path.includes("_layouts/")) continue;
    const content = readHtmlScanText(join(root, file.path));
    for (const match of content.matchAll(regex)) {
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: match[0],
        text: match[0],
      });
    }
  }
  return matches;
}

const GENERIC_TEMPLATE_RESIDUE_PATTERNS = [
  { id: "promo_code_placeholder", label: "XXCODE", pattern: /\bXXCODE\b/gi },
  { id: "package_title_placeholder", label: "Package Title", pattern: /\bPackage Title\b/g },
  { id: "product_title_placeholder", label: "Product Title", pattern: /\bProduct Title\b/g },
  { id: "spec_ref_placeholder", label: "SPEC_*_REF", pattern: /\bSPEC_[A-Z0-9_]*_REF\b/g },
  { id: "starter_logo_asset", label: "next-logo.png", pattern: /\bnext-logo\.(?:png|svg|webp)\b/g },
];

function collectGenericTemplateResidueMatches(root) {
  return collectPatternMatches(root, GENERIC_TEMPLATE_RESIDUE_PATTERNS);
}

function collectPatternMatches(root, patterns) {
  if (!patterns.length) return [];
  const matches = [];
  const compiledPatterns = patterns.map((entry) => {
    const flags = entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`;
    return { ...entry, regex: new RegExp(entry.pattern.source, flags) };
  });
  for (const file of collectBuiltTextFiles(root)) {
    const content = readHtmlScanText(join(root, file.path));
    for (const entry of compiledPatterns) {
      entry.regex.lastIndex = 0;
      for (const match of content.matchAll(entry.regex)) {
        matches.push({
          surface: "target",
          path: file.path,
          line: lineNumberAt(content, match.index || 0),
          label: entry.label,
          text: match[0],
          kind: entry.id,
        });
      }
    }
  }
  return matches;
}

function maxSpecDiscountPercent(spec) {
  if (!spec || typeof spec !== "object") return null;
  const values = [];

  function visit(value, key = "") {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;

    if (isPercentDiscountBenefit(value, key)) {
      addPercentValue(values, value.value);
    }

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isDiscountPercentKey(entryKey)) addPercentValue(values, entryValue);
      visit(entryValue, entryKey);
    }
  }

  visit(spec);
  return values.length ? Math.max(...values) : null;
}

function isPercentDiscountBenefit(value, key) {
  if (!isObject(value) || !Object.hasOwn(value, "value")) return false;
  const type = normalizeSpecKey(value.type || "");
  if (!/(?:^|_)(?:percent|percentage)(?:_|$)/.test(type)) return false;
  const context = normalizeSpecKey(key);
  if (context === "benefit") return true;
  return /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher|package)(?:_|$)/.test(type);
}

function isDiscountPercentKey(key) {
  const normalized = normalizeSpecKey(key);
  const mentionsPercent = /(?:^|_)(?:percent|percentage)(?:_|$)/.test(normalized);
  const mentionsOffer = /(?:^|_)(?:discount|saving|savings|save|off|offer|promo|coupon|voucher)(?:_|$)/.test(normalized);
  return mentionsPercent && mentionsOffer;
}

function normalizeSpecKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function addPercentValue(values, value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", "").trim());
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) values.push(parsed);
}

function collectDiscountClaimMatches(root) {
  const claimPattern = /\b(?:save(?:\s+up\s+to)?\s+(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)|(\d{1,3}(?:\.\d+)?)\s*(?:%|\bpercent\b)\s*(?:off|discount)\b)/gi;
  const matches = [];
  for (const file of collectBuiltTextFiles(root)) {
    const content = readHtmlScanText(join(root, file.path));
    for (const match of content.matchAll(claimPattern)) {
      const claimed = Number.parseFloat(match[1] || match[2]);
      if (!Number.isFinite(claimed)) continue;
      matches.push({
        surface: "target",
        path: file.path,
        line: lineNumberAt(content, match.index || 0),
        label: `${formatPercent(claimed)} claim`,
        text: match[0],
        claimed_percent: claimed,
      });
    }
  }
  return matches;
}

function collectOverstatedDiscountClaimMatches(root, maxDiscount) {
  return collectDiscountClaimMatches(root)
    .filter((match) => match.claimed_percent > maxDiscount + DISCOUNT_CLAIM_TOLERANCE)
    .map((match) => ({ ...match, max_spec_percent: maxDiscount }));
}

function formatPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)}%`;
}

function contractMentionsShipping(contract) {
  return Object.values(contract.frontmatter || {})
    .flatMap((value) => Array.isArray(value) ? value : [])
    .some((value) => String(value).includes("shipping_methods") || String(value).includes("shipping_method"));
}

function validateUnsupportedShippingFrontmatter(packet, packetPath, family, warnings, ready, derived) {
  const hits = collectShippingFrontmatterHits(packet, packetPath, derived);
  if (hits.length === 0) {
    ready.push(`${family} contract has no explicit shipping frontmatter residue in currently available mapped source/target pages`);
    return;
  }
  addIssue(
    warnings,
    "template_contract.shipping_unused",
    `${family} does not consume explicit shipping frontmatter, but mapped page frontmatter still declares ${summarizeShippingFrontmatterHits(hits)}. Remove copied shipping_methods/shipping_method values and let the family resolve shipping through its own SDK/runtime surface.`
  );
}

function collectShippingFrontmatterHits(packet, packetPath, derived = {}) {
  const hits = [];
  const seen = new Set();
  const addFile = (surface, root, relPath) => {
    if (!root || !relPath) return;
    const filePath = resolve(root, relPath);
    const key = `${surface}:${filePath}`;
    if (seen.has(key) || !existsSync(filePath) || !statSync(filePath).isFile()) return;
    seen.add(key);
    const frontmatter = extractYamlFrontmatter(readFileSync(filePath, "utf8"));
    if (!frontmatter) return;
    for (const hit of shippingFrontmatterKeys(frontmatter)) {
      hits.push({ surface, path: relFromDir(root, filePath), key: hit.key, line: hit.line });
    }
  };

  const sourceRoot = derived.source_root || resolveFromFile(packetPath, packet.source_html?.root);
  for (const page of packet.source_html?.pages || []) addFile("source", sourceRoot, page.path);

  const targetOutputDir = derived.target_output_dir;
  if (targetOutputDir && existsSync(targetOutputDir) && statSync(targetOutputDir).isDirectory()) {
    for (const file of collectHtmlFiles(targetOutputDir)) addFile("target", targetOutputDir, file.path);
  }

  return hits;
}

function extractYamlFrontmatter(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

function shippingFrontmatterKeys(frontmatter) {
  const hits = [];
  const lines = String(frontmatter || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(shipping_methods|shipping_method)\s*:/);
    if (match) hits.push({ key: match[1], line: index + 2 });
  });
  return hits;
}

function summarizeShippingFrontmatterHits(hits) {
  const limit = 4;
  const summary = hits.slice(0, limit).map((hit) => `${hit.surface}:${hit.path}:${hit.line} (${hit.key})`);
  const more = hits.length > limit ? ` and ${hits.length - limit} more` : "";
  return `${summary.join(", ")}${more}`;
}

export function collectDemoRefHits(spec, vocab) {
  const demoValues = new Set(
    Object.values(vocab || {})
      .flatMap((entry) => Array.isArray(entry.demoOnlyValues) ? entry.demoOnlyValues : [])
      .map((value) => String(value))
  );
  if (demoValues.size === 0) return [];
  // R2-B1: a ref whose value matches a real commerce entity the
  // spec declares (package/offer/shipping_method) is legitimate, not a
  // starter placeholder. The Map exporter does not stamp `_provenance.api`
  // down to the ref level, so provenance alone was missing it and flagging
  // valid low-integer API refs (e.g. "1"/"2"). Suppressing declared refs
  // kills that noise while still flagging refs that point at nothing the
  // spec defines.
  const declaredRefs = specDeclaredCommerceRefs(spec);
  const hits = new Set();
  const results = [];
  const visit = (value, key = "", path = [], provenanceStack = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, key, [...path, String(index)], provenanceStack));
    } else if (isObject(value)) {
      const nextStack = [...provenanceStack, value._provenance].filter(Boolean);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey === "_provenance") continue;
        visit(childValue, childKey, [...path, childKey], nextStack);
      }
    } else if (["ref_id", "package_id", "package_ref_id", "shipping_method"].includes(key) && demoValues.has(String(value))) {
      const hitKey = `${path.join(".")}:${String(value)}`;
      if (!hits.has(hitKey) && !isApiSourcedProvenance(provenanceStack) && !declaredRefs.has(String(value))) {
        hits.add(hitKey);
        results.push({ value: String(value), path: path.join(".") || key });
      }
    }
  };
  visit(spec);
  return results;
}

function isApiSourcedProvenance(provenanceStack) {
  return provenanceStack.some((provenance) => {
    if (!isObject(provenance)) return false;
    if (provenance.api === true || provenance.api_sourced === true) return true;
    const source = String(provenance.source || provenance.origin || "").toLowerCase();
    return source.includes("api") || source.includes("campaigns");
  });
}

function isStageComplete(report, stage) {
  const status = report?.stages?.[stage]?.status;
  return isNonEmptyString(status) && status.startsWith("completed");
}

function validateContext(context, errors, warnings, ready, derived) {
  if (context.schema_version !== CONTEXT_SCHEMA) addIssue(warnings, "context.schema_version", `Context schema should be ${CONTEXT_SCHEMA}.`);
  else ready.push(`Build context schema ${CONTEXT_SCHEMA}`);
  if (context.source_adapter !== "html_funnel") {
    addIssue(warnings, "context.source_adapter", "Only html_funnel is supported in the current release.");
  }
  if (Array.isArray(context.prompts_required) && context.prompts_required.length > 0) {
    for (const prompt of context.prompts_required) {
      addIssue(warnings, `context.prompts_required.${prompt.code || "prompt"}`, prompt.message || "Context has unresolved prompts.");
    }
  }
  validateCommerceZoneFindings(context.commerce_zone_findings, warnings, ready);
  validateAdapterDecisionShape(context.adapter_decisions, "context.adapter_decisions", warnings, ready, { addIssue });
  if (context.scaffold?.required === true) {
    derived.scaffold_required = true;
    derived.scaffold_reason = context.scaffold.reason || "Build context says setup is required.";
  }
  const themeResult = validateThemeContextBlock(context.theme);
  for (const error of themeResult.errors) errors.push(error);
  for (const warning of themeResult.warnings) warnings.push(warning);
  ready.push(...themeResult.ready);
}

export function validateCommerceZoneFindings(findings, warnings, ready) {
  if (!Array.isArray(findings) || findings.length === 0) return;
  const shellRequired = findings.filter((finding) => finding?.requires_template_shell === true);
  if (shellRequired.length === 0) {
    ready.push("Source commerce zones inspected; no SDK-owned commerce shell placeholders declared");
    return;
  }
  for (const finding of shellRequired) {
    const zones = Array.isArray(finding.commerce_zones) && finding.commerce_zones.length
      ? finding.commerce_zones.join(", ")
      : finding.zones?.filter((zone) => zone !== "sdk_owned_declared").join(", ") || "commerce zone";
    addIssue(
      warnings,
      "source_html.commerce_shell_required",
      `Source page "${finding.path}" declares SDK-owned commerce zone(s): ${zones}. During build, adopt the selected starter-template family shell for these zones; do not wrap borrowed partials in a custom checkout/upsell structure. Browser QA will verify rendered commerce structure when the family contract declares it.`
    );
  }
}

function validateAssemblyReportShape(report, errors, warnings, ready) {
  // Doctor already reports the source-package freshness finding from
  // derived.polish_gate, so the shape check leaves it out here and the same
  // finding is not listed twice in one doctor run. The standalone
  // `validate-assembly-report` has no gate behind it, so it keeps the check.
  const result = validateAssemblyReport(report, { checkSourcePackageFreshness: false });
  for (const error of result.errors) errors.push(error);
  for (const warning of result.warnings) warnings.push(warning);
  ready.push(...result.ready);
}

function validateAssemblyReport(report, { checkSourcePackageFreshness = true } = {}) {
  const errors = [];
  const warnings = [];
  const ready = [];
  if (!isObject(report)) {
    addIssue(errors, "report.type", "Assembly report must be a JSON object.");
    return { ok: false, status: "blocked", errors, warnings, ready };
  }
  if (report.schema_version !== REPORT_SCHEMA) addIssue(errors, "schema_version", `Expected ${REPORT_SCHEMA}.`);
  else ready.push(`Assembly report schema ${REPORT_SCHEMA}`);
  for (const path of ["run_id", "generated_at", "status", "identity.map_id", "identity.public_route_slug", "inputs.packet_path", "template_family.value"]) {
    if (path === "identity.map_id") {
      if (!resolveCampaignIdentity(report.identity)) addIssue(errors, "identity.map_id", "Assembly Report requires exactly one valid map_id or local_spec_id.");
    } else requireString(report, errors, path);
  }
  if (report.identity?.local_spec_id != null && !/^sha256:[0-9a-f]{64}$/.test(report.identity.spec_material_hash || "")) {
    addIssue(errors, "identity.spec_material_hash", "Local-spec reports require a current SHA-256 material spec hash.");
  }
  const stages = report.stages;
  if (!isObject(stages)) {
    addIssue(errors, "stages", "stages object is required.");
  } else {
    for (const stage of ASSEMBLY_REPORT_STAGE_KEYS) {
      if (!isObject(stages[stage])) {
        addIssue(errors, `stages.${stage}`, `${stage} stage is required.`);
        continue;
      }
      requireString(report, errors, `stages.${stage}.status`);
      for (const field of ["inputs", "outputs", "commands", "blockers", "warnings"]) {
        if (stages[stage][field] !== undefined && !Array.isArray(stages[stage][field])) {
          addIssue(errors, `stages.${stage}.${field}`, `stages.${stage}.${field} must be an array.`);
        }
      }
    }
  }
  for (const field of ["decisions", "evidence", "blockers", "warnings"]) {
    if (!Array.isArray(report[field])) addIssue(errors, field, `${field} must be an array.`);
  }
  const themeResult = validateAssemblyReportThemeBlock(report.theme);
  for (const error of themeResult.errors) errors.push(error);
  for (const warning of themeResult.warnings) warnings.push(warning);
  ready.push(...themeResult.ready);
  validateAdapterDecisionShape(report.adapter_decisions, "report.adapter_decisions", warnings, ready, { addIssue });
  validateAssemblyProofPolicy(report.proof_policy, warnings, ready);
  if (checkSourcePackageFreshness) validateAssemblySourcePackageFreshness(report, errors);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return { ok: errors.length === 0, status, errors, warnings, ready };
}

// The two source-freshness conditions the polish gate blocks on that a
// standalone report validation can answer from the report alone. Both read the
// gate's own helpers, and the waiver records are scanned once for both. The
// order mirrors the gate: a malformed waiver record is reported on its own and
// the freshness question is not asked until it is fixed, so the validator and
// the gate name the same single finding for that report.
function validateAssemblySourcePackageFreshness(report, errors) {
  const waiverAssessment = assessAssemblySourcePackageFreshnessWaivers(report);
  if (waiverAssessment.invalid.length) {
    const invalid = waiverAssessment.invalid[0];
    addIssue(
      errors,
      "stages.assembly.waiver_expires_at_invalid",
      `Source freshness waiver has an unparseable expires_at (${JSON.stringify(invalid.expires_at)}). Record a valid ISO 8601 timestamp, or remove the malformed waiver record: the polish gate refuses to honor it either way.`,
    );
    return;
  }
  if (assemblySourcePackageFingerprintMissing(report, Date.now(), waiverAssessment)) {
    addIssue(
      errors,
      "stages.assembly.source_package_material_fingerprint",
      "Report declares a Design Source Package material fingerprint, so stages.assembly.source_package_material_fingerprint is required: without it nothing proves the build consumed the current source context. Re-run Build against the current Design Source Package, or record a source freshness waiver.",
    );
  }
}

function validateAssemblyProofPolicy(policy, warnings, ready) {
  if (policy == null) {
    addIssue(warnings, "report.proof_policy", "report.proof_policy is missing. Assembly Reports should mirror qa.proof_policy so browser QA, typed-card depth, SDK origin allowlist state, order path depth, and approval state are inspectable.");
    return;
  }
  validateProofPolicyObject(policy, "report.proof_policy", warnings, ready);
}
const BRAND_CONTRACT_ERROR_CODES = new Set([
  "parse_error",
  "schema_mismatch",
  "extends_cycle",
  "extends_missing_parent",
  "family_mismatch",
]);

export function safeBrandContractCode(code) {
  const value = optionalString(code);
  return value && BRAND_CONTRACT_ERROR_CODES.has(value) ? value : "unknown";
}

function requireString(object, errors, path) {
  if (!isNonEmptyString(getPath(object, path))) addIssue(errors, path, `${path} is required.`);
}

function requireBoolean(object, errors, path) {
  if (typeof getPath(object, path) !== "boolean") addIssue(errors, path, `${path} must be boolean.`);
}

function requireArray(object, errors, path) {
  if (!Array.isArray(getPath(object, path))) addIssue(errors, path, `${path} must be an array.`);
}

function getPath(object, path) {
  return path.split(".").reduce((cursor, part) => {
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    return cursor[part];
  }, object);
}

export {
  PACKET_SCHEMA,
  CONTEXT_SCHEMA,
  REPORT_SCHEMA,
  certifiedTemplateFamilies,
  isCertifiedTemplateFamily,
  LOCAL_SERVE_DEPLOY_TARGET,
  activeSpecPages,
  collectHtmlFiles,
  runDoctorChecks,
  ARTIFACT_DOCTOR_CHECKS,
  validatePacket,
  orderPathDepthDrift,
  recordUpsellSelectorScopeGate,
  collectBuiltPageIdentityInputs,
  recordCampaignIdentityGate,
  recordScriptSyntaxGate,
  recordSdkMarkupGate,
  summarizeCopyMatches,
  resolveBrandContract,
  resolveBrandContractOnce,
  reportBrandContractDefectOnce,
  collectGenericTemplateResidueMatches,
  validateAssemblyReport,
};
