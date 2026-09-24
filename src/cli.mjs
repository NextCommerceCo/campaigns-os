import { campaignSpecIdentity, resolveCampaignIdentity, campaignIdentitiesMatch, localSpecIdentityFields } from "./spec-source-identity.mjs";
import { withHtmlScanSnapshot, readHtmlScanText, htmlScanDigest } from "./html-scan.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createDemo, demoArguments } from "./demo.mjs";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { shellToken } from "./shell-token.mjs";
import { diagnosticExport, diagnosticTextLines } from "./diagnostic.mjs";
import { observeProgress, PROGRESS_OBSERVATION } from "./progress-node.mjs";
import { describeSdkIgnoredMetaTags, isSdkIgnoredMetaTag } from "./sdk-meta-tags.mjs";
import { HIDDEN_EAGER_MEDIA_ACTIONS, requiredActionText, substitutePacket } from "./gate-actions.mjs";
import { ORDER_PATH_DEPTH_DRIFT_CODE, orderPathDepthDriftText, orderPathDepthReconcileAction, orderPathDepthsDisagree, parseOrderPathDepthFlag } from "./proof-policy.mjs";
import { specMaterialHash, specHashesMatch } from "./spec-identity.mjs";
// The same predicate stage-ledger.mjs judges a mutator's result with, imported
// rather than re-stated so the waive preview and the commit agree by identity.
import { isPlainObject } from "./repo-scan.mjs";
import { anyAssemblyReportStageBlocked, applyDerivedAssemblyReportSummary, commitAssemblyReport, QA_GATE_PLACEHOLDER_TEXT_RESIDUE, qaGatePassedForCurrentBuild, recordProducerStageOutcome } from "./stage-ledger.mjs";
import { SESSION_ENDING_DISPOSITIONS, summarizePlaceholderTextGate, summarizePurchaseProof } from "./qa-verdict.mjs";
import { assessRunRecordCloseout, identityMatches, latestMatchingRunRecord, reasonIsRemitRecovery } from "./run-record-closeout.mjs";
import {
  appendFinding,
  buildFinding,
  exportJson as exportFindingsJson,
  exportSummaryMarkdown,
  FINDING_KINDS,
  FINDING_STAGES,
  readJournal,
  resolveJournalPath,
  WORKFLOW_FINDING_SCHEMA,
} from "./findings.mjs";
import {
  assembleRunRecord,
  RUN_RECORD_COMMIT_PATTERN,
  RUN_RECORD_SURFACE_VERSION_PATTERN,
  RUN_RECORDS_DIR_REL_PATH,
  mintRunId,
  orderRunRecordFileNames,
  readRunRecordsForTarget,
  resolveRunRecordPath,
  RUN_RECORD_SURFACES,
  validateRunRecord,
  validateRunRecordLifecycle,
  writeRunRecord,
  validateQaVerdictPublish,
} from "./run-record.mjs";
import { annotateDoctorIssueCauses, formatCauseReportLines, formatCauseTag } from "./finding-cause.mjs";
import {
  announceDefaultOnTelemetry,
  CANONICAL_REMIT_SCOPE,
  normalizeConsentScope,
  promptAndPersistConsent,
  readConfig,
  resolveConfigPath,
  resolveConsent,
  scopedConsentCommand,
  TELEMETRY_ENV_VAR,
  writeConsentConfig,
} from "./consent.mjs";
import {
  ADAPTER_WRAPPER_POLICIES,
  createAdapterDecisions,
  DEFAULT_WRAPPER_POLICY,
  isWrapperPolicy,
  validateAdapterDecisionGates,
  validateAdapterDecisionShape,
  validateAdapterSourceFiles,
} from "./adapter-decision-contract.mjs";
import {
  createDoctorCheckRegistry,
  runDoctorCheckRegistry,
} from "./doctor-check-registry.mjs";
import {
  evaluateSourcePreparation,
  SOURCE_PREP_DOCUMENT_WRAPPER,
  SOURCE_PREP_FRONTMATTER_RESIDUE,
  SOURCE_PREP_INTERNAL_LINK_UNROOTED,
} from "./source-prep.mjs";
import { DOCTOR_SIDECAR_SCHEMA, markDoctorSidecarStale, stampDoctorProducer, writeDoctorSidecar, writeJsonAtomic } from "./doctor-sidecar.mjs";
import { campaignSidecarPaths, resolveCampaignWorkspace, targetRepoFor } from "./campaign-workspace.mjs";
import { canonicalPath, sameFile } from "./fs-identity.mjs";
import { DEFAULT_PROXY_BASE, fetchSpecByMapId } from "./spec-fetch.mjs";
import { writeMapSdkPin } from "./map-pin-writeback.mjs";
import { qaVerdictIdentityMatch, discoverQaVerdicts, iterateQaVerdicts, qaVerdictCandidateScore, qaVerdictCandidateTime, qaVerdictPathHints } from "./qa-verdict-discovery.mjs";
import { assertFetchAvailable, assertSecureProxyBase, boundedResponseText, DEFAULT_RUNS_ENDPOINT, describeRemitBaseKind, isLoopbackHostname, REMIT_RESULTS, remitRunRecord } from "./remit.mjs";
import {
  aggregateLifecycleForRun,
  appendLifecycleEntry,
  LIFECYCLE_JOURNAL_REL_PATH,
  NOOP_RECORDER,
  readLifecycleJournal,
  REFUSED_INVOCATION,
  refusalSeen,
  refused,
  refusing,
  runWithRefusalScope,
  withCommandLifecycle,
} from "./lifecycle.mjs";
import {
  clearRunSession,
  findRunSession,
  findStaleRunSession,
  isRunSessionStale,
  isRunSessionTerminal,
  openRunSession,
  sessionBoundTo,
  writeRunSession,
} from "./run-session.mjs";
import { ensureRuntimeStateIgnored } from "./runtime-state-ignore.mjs";
import {
  createSourceHtmlIntake,
  publicRouteForPage,
} from "./source-html-intake.mjs";
import {
  readSourceHtmlManifestFile,
  SOURCE_HASH_PATTERN,
  SOURCE_HTML_MANIFEST_REL_PATH,
  SOURCE_HTML_MANIFEST_SCHEMA,
} from "./source-html-manifest.mjs";
import { crawlSourceAssetPaths } from "./source-asset-crawl.mjs";
import {
  inspectBrandTheme,
  validateAssemblyReportThemeBlock,
  validateThemeContextBlock,
  writeThemeArtifacts,
} from "./brand-theme.mjs";
import {
  attachBuiltOutputDoctor,
  createStandardizationReport,
  formatStandardizationReportMarkdown,
} from "./standardization-report.mjs";
import { singleLineDetail, singleLineField } from "./text-safety.mjs";
import { derivePackagePin, invocationPrefixFor, LOCAL_INVOCATION_PREFIX, localInstallStatus, resolveInvocation } from "./install-mode.mjs";
import {
  campaignRouteRoot,
  isAbsoluteHttpUrl,
  normalizePageKitRoute,
  normalizePublicRouteSlug,
  packetRouteRoot,
  runtimeRelativeRouteForSpecValue,
  stripPublicRoutePrefix,
} from "./route-identity.mjs";
import { evaluateThemeGate } from "./theme-gate.mjs";
import {
  evaluatePageKitBuildSummary,
  PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND,
  readPageKitBuildSummary,
} from "./page-kit-build-summary.mjs";
import {
  isLocalServePacket,
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
  runProductionParityCheck,
} from "./local-proof.mjs";
import {
  contractHasPaletteResidueChecks,
  demoAssetConfig,
  findForbiddenPriceHides,
  paymentMethodMarkupMatches,
  paymentMethodStaticScanGaps,
  placeholderTextResidueConfig,
  placeholderTextResidueMatches,
  templateBrandContractPath,
} from "./template-brand-contract.mjs";
import {
  scanBuiltOutputContentResidue,
  loadBriefPayload,
  briefUrgencyVerified,
  collectRenderedHtmlFiles,
  evaluateProofAssets,
  attestationBlockers,
  visibleText,
  BRIEF_PAYLOAD_REL_PATH,
} from "./content-residue.mjs";
import { defaultCommerceCatalogPath, resolveCommerceCatalog, resolvePacketCommerceCatalogPath, resolveTemplateBrandContract } from "./private-template-source.mjs";
import {
  assessTemplateFreshness,
  defaultSdkSupportPolicy,
  renderTemplateFreshness,
} from "./template-freshness.mjs";
import { isUnresolvedTemplateFamily, resolveTemplateFamilyDesignSource, resolveTemplateFamilySelection } from "./template-reference.mjs";
import {
  computeBuildFingerprint,
  resolveBuiltSiteScope,
  synthesizeMinimalBuildPacket,
} from "./built-site-scope.mjs";
import {
  UPSELL_SELECTOR_SCOPE,
  evaluateUpsellSelectorScope,
  isPostPurchasePageType,
} from "./upsell-selector-scope.mjs";
import { CAMPAIGN_IDENTITY, evaluateCampaignIdentity, externalScriptSources } from "./campaign-identity.mjs";
import { SDK_MARKUP, evaluateSdkMarkup } from "./sdk-markup.mjs";
import {
  BUILD_BRIEF_NORMALIZED_REL_PATH,
  BUILD_BRIEF_SCHEMA,
  createCampaignBuildBriefArtifact,
  inferBuildBriefPath,
  validateCampaignBuildBriefArtifact,
} from "./build-brief.mjs";
import {
  DESIGN_SOURCE_PACKAGE_REL_PATH,
  createDesignSourcePackageArtifactReference,
  serializeDesignSourcePackage,
  synthesizeHtmlFunnelDesignSourcePackage,
  validateDesignSourcePackage,
} from "./design-source-package.mjs";
import {
  appendDeviation,
  buildRecommendation,
  detectDeviation,
  DEVIATION_JOURNAL_REL_PATH,
  expectedCommandsForStage,
  readDeviations,
} from "./deviation.mjs";
import {
  ASSEMBLY_REPORT_STAGE_KEYS,
  NEXT_STAGE_ORDER,
  NEXT_STAGE_OWNERS,
  STAGE_TERMINAL_STATUS_PREFIXES,
  reportKeyForCliStage,
  stageIsBlocked,
  stageIsTerminal,
} from "./orchestration-stage-contract.mjs";
import {
  assemblySourcePackageFingerprintMissing,
  assessAssemblySourcePackageFreshnessWaivers,
  currentBuildFingerprint,
  evaluatePolishGate,
} from "./polish-gate.mjs";
import {
  assertPolishCaptureBindingUnchanged,
  capturePolishPageLoad,
  createPolishCaptureBinding,
  evaluateRecordedHiddenEagerMediaCheckpoint,
  mergePolishPageLoadEvidence,
  planPolishCapture,
} from "./polish-node.mjs";
import { HIDDEN_EAGER_MEDIA_SCOPE, POLISH_CAPTURE_PROBLEM_CODES } from "./polish-page-load.mjs";
import { POLISH_BEACON_RESOURCE_TYPES, captureOrigin, redactCaptureUrl } from "./polish-capture.mjs";
import {
  appendCheckpointWaiver,
  createCheckpointRegistry,
  createCheckpointWaiver,
  evaluateCheckpointRegistry,
  validateWaiverAttribution,
} from "./checkpoint-waiver.mjs";
import {
  loadPageKitCampaignEntry,
  PAGE_KIT_CAMPAIGNS_REL_PATH,
  projectPageKitCampaignLoad,
} from "./page-kit-campaign-config.mjs";
import {
  evaluatePageKitStoreProfile,
  PAGE_KIT_STORE_PROFILE_SCOPE,
  storeProfileDemoResidueFields,
} from "./page-kit-store-profile.mjs";
import {
  evaluatePageKitSdkVersion,
  PAGE_KIT_SDK_VERSION_SCOPE,
} from "./page-kit-sdk-version.mjs";
import {
  applyPageKitSync,
  formatSyncValue,
  planPageKitSync,
} from "./page-kit-sync.mjs";
import {
  applySpecDerive,
  formatDeriveValue,
  isPageTreeIgnoredDir,
  frontmatterPermalink,
  pageRouteForFile,
  permalinkRoute,
  planSpecDerive,
} from "./spec-derive.mjs";
import {
  adminApiBaseForStore,
  normalizeStoreSubdomain,
  parseStoreTokenSource,
  planStoreProfileDerive,
  readStoreProfile,
} from "./spec-derive-store.mjs";
// ADR-003: the public, canonical CampaignSpec rule registry. The doctor and any
// campaign authoring UI (e.g. a Map Builder bundle) import the same rules, so a
// spec check is authored once and reaches internal teams and agencies alike.
// Authored as pure TypeScript with no heavy deps; compiled to plain ESM by
// `npm run build:spec` (tsc -> campaign-spec/dist) so the package runs on the
// node engine in package.json without type-stripping. build runs on `prepare`,
// so a fresh install (including the git-ref consumer) always has dist.
import {
  normalize as normalizeCampaignSpec,
  runRules,
  specOnlyRules,
} from "../campaign-spec/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { derivePackagePin, localInstallStatus };

// Every command this CLI PRODUCES for an operator or agent to copy is spelled
// once, here, for the install it runs from (see install-mode.mjs): bare
// `campaigns-os` from a checkout, `npx --no-install campaigns-os` from a
// campaign folder that pins the toolkit, `npx --yes <spec>` from an npx cache.
// Result payloads are never rewritten after the fact — a path, a quoted
// argument or a data value that happens to contain the words is left exactly
// as it is.
function cmd(verb, rest = "") {
  const prefix = invocationPrefixFor(ROOT);
  return `${prefix} ${verb}${rest ? ` ${rest}` : ""}`;
}

// A registry command (gate actions, checkpoint remediations) is stored in its
// canonical bare form so internal bookkeeping can match on it; this spells
// it for the current install at the moment it is emitted.
function asInvocation(command) {
  if (typeof command !== "string" || !command.startsWith("campaigns-os ")) return command;
  return `${invocationPrefixFor(ROOT)} ${command.slice("campaigns-os ".length)}`;
}
const PACKET_SCHEMA = "campaign-runtime-build-packet/v0";
const CONTEXT_SCHEMA = "campaign-runtime-build-context/v0";
const REPORT_SCHEMA = "campaign-runtime-assembly-report/v0";
// Assembly-report warning code for the template-family precedence notice, so
// the stderr line and the report entry can never drift apart.
const TEMPLATE_FAMILY_HINT_OVERRIDDEN = "TEMPLATE_FAMILY_HINT_OVERRIDDEN";
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

const HELP = `Campaigns OS toolkit

Usage:
  campaigns-os help
  campaigns-os demo --target <new-directory>   # offline inert sample; open landing/index.html; no campaign evidence
  campaigns-os start (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                     [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                     [--wrapper-policy <strip_document_wrappers|preserve_document_wrappers|not_required|unknown>] [--design-manifest <path>]
                     [--allow-uncertified-template "<reason>"] [--order-path-depth <off|common|full>] [--no-run-session] [--force]   # --force overwrites an assembly report that carries stage evidence (destructive; prints the cleared stage keys)
  campaigns-os prepare-build (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                             [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                             [--wrapper-policy <strip_document_wrappers|preserve_document_wrappers|not_required|unknown>] [--design-manifest <path>]
                             [--allow-uncertified-template "<reason>"] [--order-path-depth <off|common|full>] [--no-run-session] [--force]
  campaigns-os build (--spec <json> | --map-id <id>) --source <html-dir> --target <page-kit-dir> --template-family <family>
                     [--brief <yaml|json>] [--proxy-base <url>] [--cached-spec] [--theme-policy <inspect_only|auto|off>]
                     [--wrapper-policy <strip_document_wrappers|preserve_document_wrappers|not_required|unknown>] [--design-manifest <path>]
                     [--allow-uncertified-template "<reason>"] [--order-path-depth <off|common|full>] [--no-run-session] [--force]   # intake alias for prepare-build + doctor
  campaigns-os doctor --packet <campaign-runtime.build.json> [--context <json>] [--report <json>] [--strip-paths] [--write] [--no-write] [--doctor-out <path>] [--json]   # inspection by default; --doctor-out requires --write; --no-write wins
  campaigns-os doctor --built <page-kit-target-repo> --family <family> [--slug <slug>] [--base-url <url>] [--emit-packet [path]] [--json]   # L7: doctor a built _site/ with no Build Packet
  campaigns-os bundle check --packet <campaign-runtime.build.json> [--require-qa] [--json]   # validate the canonical migration/readback JSON bundle; never substitutes markdown
  campaigns-os sdk storage-check --target <git-root> --target-sdk <x.y.z> --manifest <SDK-manifest.json> --scope <dir,file> [--exclude <dir,file>] [--json]
  campaigns-os standardize --target <campaign-repo> [--family <family>] [--slug <slug>] [--sdk-support-policy <path.json>] [--field-contract <path.json>] [--no-doctor] [--json]
  campaigns-os theme inspect --packet <campaign-runtime.build.json> [--context <json>] [--theme-policy <inspect_only|auto|off>] [--json]
  campaigns-os theme generate --packet <campaign-runtime.build.json> [--context <json>] [--out-dir <dir>] [--force] [--json]
  campaigns-os theme waive --packet <campaign-runtime.build.json> --reason "<why>" --waived-by "<named human>" [--expires-at <ISO>] [--report <json>] [--dry-run] [--json]   # record an explicit theme-gate waiver on the assembly report; placeholders such as "operator" are refused. --dry-run validates the same way and prints the waiver it would write, without touching the report
  campaigns-os checkpoint waive --packet <campaign-runtime.build.json> --gate <checkpoint-id> --reason "<why>" --waived-by "<named human>" [--expires-at <ISO>] [--review-condition "<trigger>"] [--report <json>] [--dry-run] [--json]   # one bound is required; registered gates: page_kit.store_profile, page_kit.sdk_version, polish.hidden_eager_media, built_output.upsell_selector_scope. --dry-run runs every check (named human, bounds, registered and waivable gate) and prints the waiver it would write, without touching the report
  campaigns-os page-kit sync --packet <campaign-runtime.build.json> [--dry-run] [--json]   # write the CampaignSpec's Store Profile fields (campaign.store_*) and SDK pin (global_config.sdk_version, runtime.sdk_version alias) into the target's _data/campaigns.json entry for the packet's route, printing a field-by-field diff; the recovery for a doctor blocked on page_kit.store_profile / page_kit.sdk_version after a fresh scaffold. Writes only those ten fields, only from usable spec values (a bad pin, a non-http URL, a non-tel: phone URI or the demo value itself is reported as not synced, status PARTIAL); exit 2 when the entry or the spec is missing, or the spec identifies another campaign.
  campaigns-os spec derive --packet <campaign-runtime.build.json> [--dry-run] [--json] [--report <json>] [--from-store <subdomain> [--store-token-source env:<VAR>]] [--write-map] [--proxy-base <url>]   # write the fields the target repo already states into the packet's local CampaignSpec (spec.local_path): the SDK pin from _data/campaigns.json[<route>].sdk_version (global_config.sdk_version, and the runtime.sdk_version alias when declared), each page's page_url from the page tree under src/<route>/ (filename or permalink), and the analytics ids the entry carries (gtm_id -> analytics.providers.gtm.containerId, fb_pixel_id -> analytics.providers.facebook.pixelId); prints a field-by-field before -> after diff and writes nothing else. Repo-derived fields only and no network by default; --from-store <subdomain> (the <store> of <store>.29next.store) also reads through campaigns-os login gateway credentials (--store-token-source env:<VAR> explicitly selects the warned break-glass Admin path; a token never goes on the command line) and writes the nine campaign.store_* Store Profile fields: store_name and store_url (primary domain) and store_phone/store_phone_tel from GET /store/, and store_terms/privacy/contact/returns/shipping as https://<primary domain>/<slug>/ from the one storefront page (GET /pages/) whose slug or title names each policy; an empty store field, no page or several never empties the spec's value. A field the repo or store cannot state (a scaffold's seeded pin, an unbound page, an empty or malformed id, an active page_kit.sdk_version waiver, an empty store field, an unbound policy page) is reported as not derived, status PARTIAL; exit 2 when the packet, the spec or the target entry is missing, the spec identifies another campaign, or the store cannot be read (credential missing, 401/403, no such store, unreachable). --write-map also records the derived pin into the saved Map's Build hints (Campaign Cart SDK version) through the proxy Worker (PUT /api/maps/<spec.map_id> under X-Campaign-Key, the packet's Campaigns API key, with the Map's spec_hash as the X-Spec-Hash precondition): written when the Map declares no pin or one behind the repo, unchanged when equal, refused (warning, exit 0) when the Map pin is ahead or cannot be ordered, failed (error, exit 2) when the key is missing or mismatched, the Map is gone, was saved in between, or the proxy refuses the body; the write is recorded on the Assembly Report evidence[] and in the result's map object. --proxy-base overrides the canonical proxy (https, or a loopback host over http); --dry-run reads the Map and reports would_write without a PUT.
  campaigns-os page-kit parity --packet <campaign-runtime.build.json> [--report <json>] [--json]   # local proof mode (deploy.target local-serve): render the current source in development and production through the target's page-kit into temp dirs, assert the served _site/ is the current development render and that production differs from it only in environment-gated output (same page set, same route slugs, same Campaign Cart pin and next-api-key); records stages.assembly.evidence.local_proof.production_parity, which doctor reads as local_proof.production_parity. Exit 2 on a non-gated difference.
  campaigns-os polish capture --packet <campaign-runtime.build.json> --base-url <url> [--report <json>] [--headed] [--auth-cookie <cookie>] [--json]
  campaigns-os readback <target-repo-root> [--json] [--packet <path>] [--doctor <path>] [--context <path>] [--report <path>] [--qa-verdict <path>] [--findings <path>]   # read-only projection of one run's emitted artifacts (packet, doctor output, build context, assembly report, QA verdict, findings export): artifact states, per-artifact freshness against the checkout's HEAD reflog, doctor warning grouping, skip cascades and cross-artifact divergences. Writes nothing, starts no process, touches no network, and records no lifecycle entry; --json emits one campaigns-os-readback/v2 object (docs/readback.md). Exit 2 for a missing target root or a Build Packet set freshness cannot single out.
  campaigns-os readback --example [--json]                                # project the bundled synthetic sample; freshness is not computable for it by design
  campaigns-os validate-assembly-report --report <json> [--json]
  campaigns-os install-skills [--platform <claude|codex|agents|all>] [--target <skills-dir>] [--dry-run] [--json]
  campaigns-os tooling setup --target <campaign-directory> [--platform claude] [--dry-run] [--json]   # after installing the pinned project dependencies, install skills, connect Claude's context and install the QA browser; preserve existing pages and instructions, then restart the agent
  campaigns-os login [--store <subdomain>]
  campaigns-os logout [--store <subdomain>]
  campaigns-os tooling status [--platform <claude|codex|agents|all>] [--target <skills-dir>] [--skills-revision <bundle-revision|skill-id@version>] [--packet <campaign-runtime.build.json>] [--force] [--json]   # install-mode, git, skill freshness, and local gateway login/store/expiry/reported version. --skills-revision checks the bundle revision the skill you loaded states on its first body line (or that one skill's <skill-id>@<version>) against the bundle THIS CLI ships: revision_check is match, mismatch or unchecked, and a mismatch prints the full status and exits 2 because skill text already in context cannot be refreshed by re-running — start a fresh session. The pin check reports one executable per project: the project pin first — the first exact spec for this package (x.y.z, =x.y.z or vx.y.z) on the walk up from the nearest package.json, devDependencies then dependencies in each, entering a workspace root and stopping there, never peerDependencies or optionalDependencies — then the Build Packet's campaigns_os_version (the project's campaign-runtime.build.json, or --packet <path>); the Pin: line names the key and manifest (or packet) each version came from; pin.status is match, stale_pin (the pin is not the running version), conflicting_pin (the two sources disagree) or unpinned (neither, or only a range; exit 0). stale_pin and conflicting_pin exit 2 with the file to change; --force (bare) overrides them, is reported as pin.forced and lands on the lifecycle journal entry. See docs/skills-revision.md
  campaigns-os tooling diagnose [--packet <packet>] [--platform <claude|codex|agents|all>] [--json]   # read-only redacted support summary
  campaigns-os install-agent-context --target <page-kit-dir> [--dry-run]
  campaigns-os next [${NEXT_STAGE_ORDER.join("|")}] --packet <json> [--no-write] [--no-remit] [--proxy-base <url>] [--json]   # no stage self-decides; returns gates[] + next_actions[] alongside the prompt
  campaigns-os next setup --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next build --packet <json> [--context <json>] [--report <json>] [--json]
  campaigns-os next polish --packet <json> --report <json> [--json]
  campaigns-os next deploy --packet <json> --report <json> [--json]
  campaigns-os next qa --packet <json> --report <json> [--json]
  campaigns-os qa resolve --packet <json> [--base-url <url>] [--no-probe] [--probe-timeout-ms <ms>] [--json]   # probes the derived entry URLs; a dead route set reports routes_unresolved, an unprobed one ready_unprobed
  campaigns-os qa run --packet <json> [--base-url <url>] [--browser] [--test-order <mode>] [--select-package <ref[:qty],...>] [--apply-coupon <code>] [--no-post-verdict] [--no-remit] [--output-dir <dir>] [--json]
  campaigns-os qa promote --packet <json> --verdict <full-verdict.json> [--json]   # project one explicit qa-output verdict to the committed .campaign-runtime/qa-verdict.json sidecar
  campaigns-os qa publish --packet <json> [--verdict <full-verdict.json>] [--republish] [--proxy-base <url>] [--dry-run] [--json]   # post an already-stored verdict (the sidecar's run, or --verdict) to the QA portal without a re-run or an order; refuses a stale spec_hash or an already-published verdict. --dry-run runs every one of those refusal checks and prints what would be posted (endpoint, verdict run id, payload bytes) without the POST
  campaigns-os qa policy set --packet <json> [--allowed-domains-confirmed true|false] [--deploy-target <target>] [--preview-url <url>] [--production-url <url>] [--order-path-depth <off|common|full>] [--json]   # --order-path-depth writes qa.proof_policy.order_path_depth and refreshes the assembly report's proof_policy mirror
  campaigns-os findings add --stage <stage> --kind <kind> --summary <text> [--details <text>] [--packet <json>] [--journal <path>] [--run-id <id>] [...context flags]
  campaigns-os findings harvest --packet <json> [--context <json>] [--report <json>] [--journal <path>] [--run-id <id>] [--write] [--json]
  campaigns-os findings list [--packet <json>] [--journal <path>] [--json]
  campaigns-os findings export [--summary | --json] [--packet <json>] [--journal <path>]
  campaigns-os run-record --packet <json> [--context <json>] [--report <json>] [--qa-verdict <path>] [--run-id <id>] [--new-run] [--journal <path>] [--lifecycle-journal <path>] [--surfaces <a,b>] [--primary-surface <s>] [--surface-confidence <text>] [--agent-total-tokens <n>] [--agent-elapsed-ms <n>] [--proxy-base <url>] [--no-remit] [--no-write] [--dry-run] [--list] [--json]
    run_id: --run-id > the active run session > the most recent Run Record for this packet's campaign (re-emitted in place; a remitted one is left as written) > freshly minted. --new-run always mints; --list prints the run ids on disk for this packet (id, created_at, remit state, path) and, like --no-write, writes and sends nothing.
    --dry-run assembles the record and prints it (with --json: dry_run, would_write, would_remit), then writes no file and sends nothing — where --no-write skips the assembly's reads too. Combining them is allowed and still writes nothing. \`run end --dry-run\` hands the flag on to run-record and leaves the run session open, so the close can still be made for real afterwards.

  Commands other than login, logout, demo, and tooling diagnose accept [--lifecycle-journal <path>] (or env CAMPAIGNS_OS_LIFECYCLE_LOG) to append a command-lifecycle entry (command, argv shape, exit status, timing) for the run; pair with --run-id so run-record can embed it.
    --no-write suppresses that append for every command, however the journal was selected (flag, env, or the active run session); a refused invocation (unknown command, an unknown subcommand refused before its handler runs, or a flag the command refuses up front) and \`run status\` never append one at all.
    A refused invocation writes no file of its own. One effect still precedes argument refusal: \`start\`, \`prepare-build\`, \`build\`, \`run start\` and \`run end\` close out a STALE run session at the root they are about to act on (Run Record assembled and remitted under the usual consent, session file cleared) before argv is refused — a declared effect of those commands. --no-write suppresses that closeout too, so a --no-write invocation leaves the target byte-identical.
  campaigns-os telemetry status|on [--proxy-base <url>] [--json]   # machine-level Run Telemetry consent (gates remit only; capture is always local). \`on\` records consent for ONE endpoint: the canonical NEXT endpoint by default, or the --proxy-base you name (a loopback or staging receiver); \`status\` reports the stored scope and checks it against the canonical endpoint or the --proxy-base you name
  campaigns-os telemetry off [--json]                                  # turn remit off for every endpoint (takes no --proxy-base)
  campaigns-os telemetry list [--packet <json> | --admin-key-env <VAR>] [--since <ISO>] [--package <v>] [--surface <s>] [--trusted] [--limit <n>] [--proxy-base <url>] [--trust-proxy-base] [--json]   # read stored Run Records: tenant scope via the packet's campaign key, or cross-tenant via the ops admin key (default env CAMPAIGN_OPS_ADMIN_KEY). --proxy-base must be https unless it is a loopback host (allowed over http, with a warning that the credential is in clear).
  campaigns-os run start [--packet <json>] [--run-id <id>] [--lifecycle-journal <path>] [--force] [--json]   # begin an ambient run session: one run_id + journal auto-shared by every command, no per-command flags; with --packet the session lives in the packet's target repo, whatever the cwd
  campaigns-os run status [--json]                                 # active session + incomplete stages + deviation count + exact next command; read-only — it never sweeps and never journals
  campaigns-os run end [--packet <json>] [--no-remit] [--no-write] [--proxy-base <url>] [--json]   # assemble the aggregated Run Record for the session, then clear it (also closes out a stale session at cwd); --proxy-base is handed to run-record, so the session record remits to that receiver under the consent scoped to it

  Gates: when theme inspect finds a generatable brand theme and the campaign ships commerce pages, \`next polish|deploy|qa\` and \`qa run\` BLOCK until the brand layer is applied after next-core.css or explicitly waived (\`theme waive\` / \`qa run --theme-waive "<reason>"\`).
  Commercial parity: \`qa run\` automatically compares contract-governed authored price/cadence/voucher claims with fresh \`/api/price-preview\` evidence; no extra catalog flag is required.
  Local proof mode: under deploy.target local-serve the build stage renders the DEVELOPMENT environment (\`CPK_ENV=development npx campaign-build --json > .campaign-runtime/page-kit-build-summary.json\`, recorded as stages.assembly.evidence.build_environment) into _site/, and polish capture, browser QA and typed-card orders run against that served output; starter templates gate every vendor loader on the environment, and a production build's protocol-relative loaders (//host/...) fail over a plain-HTTP local serve. \`page-kit parity\` then proves the pin on the production render before commit; the PR preview is the second check. The toolkit never proposes editing a generated include to make a local capture pass.
  Wrapper policy: \`start\`/\`prepare-build\`/\`build\` seed source_html.adapter_contract.wrapper_policy from --wrapper-policy, else the source-html manifest's wrapper_policy key, else strip_document_wrappers. Selecting preserve_document_wrappers reports source_html.prep.document_wrapper as a warning instead of blocking, so raw-HTML source can be handed over without a wrapper-stripping pass (docs/source-adapters.md).
  Design manifest: \`start\`/\`prepare-build\`/\`build\` read the source-html manifest from <source>/.campaigns-os/source-html-manifest.json; --design-manifest <path> reads it from anywhere else instead (a read-only source root keeps its proof and skip declarations in a file the operator owns). pages[].path stays relative to --source. Doctor re-reads the manifest the Design Source Package recorded.
  Template-stock pages: a page declared out of source scope (manifest skip_reason, or CampaignSpec build_scope.mode "partial") is template stock — its assembly decision carries template_stock: true and the locked family, intake demands no design source for it, and the build stage materialises it from that family's stock page (docs/design-source-package.md "Template-stock pages").
  Certified templates: \`start\`/\`prepare-build\` only accept template families with a commerce-catalog entry AND a brand contract; anything else needs --allow-uncertified-template "<reason>" (recorded on the packet; deterministic assembly, residue QA, and pricing contracts will not cover the build).
  Ambient telemetry: \`start\`/\`prepare-build\` auto-open the run session in the target repo (opt out per-run with --no-run-session). A blocked \`qa run\` records its attempt and keeps the session open for repair; a ready verdict auto-assembles the Run Record with every attempt and clears the session. A session idle for 12h is stale: the next \`start\`/\`prepare-build\`/\`build\` at that target (or \`run start\`/\`run end\` with its --packet, or at cwd) closes it out — Run Record assembled and remitted under consent — before opening a new one. Remit sends the packet's Campaigns API key as X-Campaign-Key so the record lands in your tenant scope; read it back with \`campaigns-os telemetry list --packet <json>\`. Run Telemetry remit to the canonical NEXT endpoint is ON by default — disable with \`campaigns-os telemetry off\`, CAMPAIGNS_OS_TELEMETRY=off, or per-run --no-remit. Capture is always local.
  Deviations: with an active run session, pipeline-advancing commands that don't match the last \`next\` recommendation are recorded to .campaign-runtime/agent-deviations.jsonl; declare intent with --deviation-reason "<why>".

Examples:
  npm run campaigns-os -- start \\
    --spec examples/campaignspec.v42.basic.json \\
    --source examples/source-html \\
    --target examples/target-page-kit \\
    --template-family olympus

  # Fetch the spec straight from the Map Builder by Map ID (KV is source of truth):
  npm run campaigns-os -- start \\
    --map-id veyra-v1-knp4 \\
    --source examples/source-html \\
    --target examples/target-page-kit \\
    --template-family olympus

  npm run campaigns-os -- doctor --packet examples/build-packet.basic.json --json

  npm run campaigns-os -- theme inspect --packet examples/build-packet.basic.json --json

  npm run campaigns-os -- standardize --target examples/target-page-kit --json
`;

// `refused()`, its `REFUSED_INVOCATION` tag, and the `refusalSeen()` /
// `runWithRefusalScope()` accessors live in lifecycle.mjs — see the contract
// there.
// Command modules raise refusals too (`qa`'s unknown subcommand) and cli.mjs
// imports them, so the factory has to sit below both.

// Top-level commands the CLI dispatches, used to offer a did-you-mean
// suggestion on a typo instead of a bare "Unknown command". Derived from the
// `command === "…"` literals in main() and dispatch() (memoized on first use) so
// the list cannot drift as dispatch branches are added or removed. The regex
// tolerates whitespace and either quote style so common reformats don't
// silently empty the list; a known-commands test guards against a refactor
// (switch table, extracted constant) that the regex can't follow.
let knownCommandsCache = null;
export function knownCommands() {
  if (knownCommandsCache) return knownCommandsCache;
  const found = new Set(["help"]);
  for (const match of (main.toString() + dispatch.toString()).matchAll(/command\s*===\s*["']([^"']+)["']/g)) {
    found.add(match[1]);
  }
  knownCommandsCache = [...found];
  return knownCommandsCache;
}

// Levenshtein distance, capped use: only for a single short token at error
// time, so the naive O(n*m) implementation is fine.
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dist[i][0] = i;
  for (let j = 0; j < cols; j += 1) dist[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[rows - 1][cols - 1];
}

// Nearest known command within a small edit budget, or null when nothing is
// close enough to be a confident suggestion.
function closestCommand(input) {
  // Case-insensitive: commands are all lowercase, so `Doctor` should still
  // match `doctor` by intent, not by accident.
  const needle = input.toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of knownCommands()) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Tighter budget for shorter inputs: a 2-char budget on a 2-char typo would
  // confidently mis-suggest (e.g. `dr` -> `qa`, distance 2). Scale the allowed
  // edits with length so suggestions stay high-confidence.
  const len = needle.length;
  const budget = len <= 3 ? 1 : len <= 6 ? 2 : 3;
  return bestDistance <= budget ? best : null;
}

export async function main(argv, { authentication } = {}) {
  const args = parseArgs(argv);
  // `npx --yes -p <spec> campaigns-os <command>` and `npx --yes <spec>
  // campaigns-os <command>` both hand the bin its own name as the first
  // positional. Treat that leading token as the program name, not a command,
  // so the package-install invocation the docs give cannot fail with
  // "Unknown command: campaigns-os".
  if (args._[0] === "campaigns-os") args._.shift();
  const command = args._[0] || "help";

  // Everything below — dispatch and the onFinish that reads the verdict — runs
  // inside ONE refusal scope, so a refusal raised by this invocation is visible
  // only to this invocation's persistence step. Two main() calls interleaved
  // in-process (a test, an embedding host) no longer share the verdict.
  return runWithRefusalScope(async () => {
    // Authentication never recovers/remits run sessions or records argv in a
    // lifecycle journal. Credentials belong only in the user credential store.
    if (command === "login" || command === "logout") {
      const { runAuthentication } = await import("./login.mjs");
      return runAuthentication(argv[0] === "campaigns-os" ? argv.slice(1) : argv, authentication);
    }

    // An offline sample must not recover sessions or emit lifecycle evidence.
    if (command === "demo") {
      // Validate raw tokens here: parsing loses duplicate flags. The private
      // dispatcher then rechecks the parsed shape and extracts the target.
      demoArguments(args, argv);
      await dispatch(command, args);
      return;
    }

    // Diagnostic export is an inspection, including when a run is active or
    // stale. Bypass session sweeping, ambient resolution, and lifecycle capture
    // so no closeout/remit or journal write can occur before the projection.
    if (command === "tooling" && args._[1] === "diagnose") {
      const result = toolingDiagnose(args);
      console.log(args.json ? JSON.stringify(result, null, 2) : diagnosticTextLines(result).join("\n"));
      return;
    }

    // Project setup must not recover campaign sessions, read gateway bindings,
    // or emit lifecycle/telemetry evidence before a campaign is selected.
    if (command === "tooling" && args._[1] === "setup") {
      const { setupArguments, setupTooling, setupTextLines } = await import("./tooling-setup.mjs");
      setupArguments(args, argv);
      const { installQaBrowser } = await import("./qa-node.mjs");
      const result = setupTooling(args, { packageRoot: ROOT, installSkills, installAgentContext, installBrowser: installQaBrowser });
      console.log(args.json ? JSON.stringify(result, null, 2) : setupTextLines(result).join("\n"));
      if (!result.ok) process.exitCode = 2;
      return;
    }

    // Ambient run session (Tier 3): when `run start` is active, every command
    // shares its run_id WITHOUT --run-id. Explicit --run-id still wins. Resolved
    // ONCE here and threaded through dispatch + persistence so the run_id a
    // command is tagged with and the journal it writes to come from a single
    // read (no TOCTOU skew if the session changes mid-run).
    //
    // Before that read, close out any STALE session at the root this command is
    // about to open a new one in. findRunSession ignores stale sessions so a new
    // run never inherits an old run_id — but an ignored session was also an
    // abandoned one: nine of them were found lingering with no Run Record and
    // nothing remitted. Closing out is best-effort and never blocks the command.
    const storageInspection = command === "sdk" && args._[1] === "storage-check";
    // `readback` bypasses session resolution entirely, sweep included. Its
    // `--packet` is a readback OVERRIDE naming the Build Packet to project, not a
    // Build Packet to act on, and ambientRunSession treats that flag as a session
    // locator: it read the named file whole through readJson, so a 40 MB packet
    // was loaded into memory past readback's own 32 MiB bound before readback
    // ever saw it, and a valid override exited 1 whenever some active session was
    // bound to a different packet. Neither belongs to a command declared
    // read-only. The lifecycle wrapper below still runs; the read-only exemption
    // lives in persistLifecycleIfRequested, which writes no entry for readback.
    const readOnlyProjection = command === "readback";
    const sweptStale = storageInspection || readOnlyProjection ? [] : await closeOutStaleRunSessions(command, args);
    const ambient = readOnlyProjection ? null : ambientRunSession(args);

    // Wrap every command in the lifecycle instrumentation (T6): it captures the
    // command, its argv shape, exit status, and timing. Re-throws unchanged so
    // the CLI exit code is unaffected. Persistence runs via onFinish so it fires
    // on BOTH the success and error paths — a command that THROWS (the most
    // valuable failure telemetry) is recorded too, not just clean exits.
    // Persistence is OPT-IN — an explicit --lifecycle-journal /
    // CAMPAIGNS_OS_LIFECYCLE_LOG, or an active run session. With none, behavior
    // is identical to before.
    //
    // `sessionHolder` is per-invocation, NOT module state: when start/
    // prepare-build auto-open a run session mid-command, they publish it here
    // so onFinish persists this command's own lifecycle entry into the new
    // session — without two interleaved invocations ever sharing a session.
    const sessionHolder = { current: ambient, autoStarted: false, adopted: false, qaResult: null, sweptStale };
    await withCommandLifecycle(
      {
        command,
        argvShape: argvShape(args),
        runId: optionalString(args["run-id"]) || ambient?.session?.run_id || null,
        onFinish: async (lifecycle, thrown) => {
          persistLifecycleIfRequested(args, command, lifecycle, sessionHolder, thrown);
          await autoEndRunSessionAfterTerminalQa(args, command, sessionHolder, thrown);
        },
      },
      (recorder) => dispatch(command, args, recorder, ambient, sessionHolder),
    );
  });
}

function ambientRunSession(args = {}) {
  try {
    const cwdSession = findRunSession(process.cwd());
    const packetArg = optionalString(args.packet);
    if (!packetArg) return cwdSession;

    const packetPath = canonicalPath(packetArg);
    const candidateRoots = new Set([dirname(packetPath)]);
    try {
      const packet = readJson(packetPath);
      const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
      if (targetRepo) candidateRoots.add(targetRepo);
    } catch {
      // The command itself owns malformed/missing packet diagnostics. Session
      // selection can still use the packet's containing project when present.
    }

    const targetSessions = [];
    for (const root of candidateRoots) {
      const found = findRunSession(root);
      if (found && !targetSessions.some((entry) => sameFile(entry.path, found.path))) targetSessions.push(found);
    }
    if (targetSessions.length > 1) {
      throw new Error(`Conflicting active run sessions resolve from packet ${packetPath}: ${targetSessions.map((entry) => entry.session.run_id).join(", ")}. End the stale or wrong session before continuing.`);
    }
    const targetSession = targetSessions[0] || null;
    const binding = targetSession ? sessionBoundTo(targetSession.session, packetPath) : null;
    if (binding && !binding.same) {
      throw new Error(`Conflicting active run session ${targetSession.session.run_id} is bound to ${binding.boundPacket}, not packet ${packetPath}. End it before continuing.`);
    }
    if (cwdSession && targetSession && !sameFile(cwdSession.path, targetSession.path)) {
      throw new Error(`Conflicting active run sessions: cwd selects ${cwdSession.session.run_id}, while packet ${packetPath} selects ${targetSession.session.run_id}. End the wrong session before continuing.`);
    }
    if (cwdSession && !targetSession) {
      throw new Error(`Conflicting active run session: cwd selects ${cwdSession.session.run_id}, but packet ${packetPath} has no matching active target session. Run the command from the packet target, start its session, or end the cwd session.`);
    }
    return targetSession;
  } catch (error) {
    if (/Conflicting active run session/i.test(String(error?.message || ""))) throw error;
    return null;
  }
}


// Telemetry is ambient by default: `start`/`prepare-build` open the run
// session themselves (in the TARGET repo, where the build happens), arm the
// initial recommendation for deviation telemetry, and tell the operator how
// to finish. The dogfood evidence demanded this: agents reliably run the
// entry point and skip the bookkeeping, so the bookkeeping cannot depend on
// them. `--no-run-session` opts a run out (CI fixtures, throwaway runs);
// an already-active session is never replaced. The session lands on the
// caller-supplied --target (the directory the operator named), never a path
// derived from packet location, so an overridden packet path cannot split
// the session from the build.
function autoStartRunSession(prepareResult, args, ambient, sessionHolder) {
  if (args["no-run-session"] === true || ambient) return null;
  try {
    const packetPath = prepareResult?.packetPath;
    const targetRepo = optionalString(args.target) ? resolve(args.target) : null;
    if (!packetPath || !targetRepo) return null;
    // A repeated start against a target whose session is already open joins
    // that session rather than opening a second one. `start` has no --packet,
    // so main() could only find a session by cwd; a re-run from anywhere else
    // used to resolve no session and its lifecycle entry was never written,
    // which left the journal with the first blocked start and none of the
    // retries, including the one that produced the packet every later stage
    // used. Join only when the session is bound to this packet (or to none);
    // a session bound elsewhere is a conflict for the operator to end, not
    // something to write into silently.
    const opened = openRunSession(targetRepo, {
      packet: resolve(packetPath),
      lastRecommendation: buildRecommendation({
        stage: "doctor",
        status: "ready",
        expectedCommands: ["start", "prepare-build", "theme"],
      }),
      join: true,
    });
    if (!opened.found) {
      const runId = singleLineField(opened.existing.session?.run_id, "(unnamed)");
      process.stderr.write(`[campaigns-os] run session ${runId} is bound to ${singleLineField(opened.binding.boundPacket)}, not this packet; not joined (this command's lifecycle entry is not recorded). End it with \`campaigns-os run end\` or run from its packet.\n`);
      return null;
    }
    const runId = singleLineField(opened.found.session?.run_id, "(unnamed)");
    if (sessionHolder) {
      sessionHolder.current = opened.found;
      sessionHolder[opened.joined ? "adopted" : "autoStarted"] = true;
    }
    process.stderr.write(opened.joined
      ? `[campaigns-os] Run session ${runId} joined (already open for ${singleLineField(targetRepo)}; run telemetry is ambient).\n`
      : `[campaigns-os] Run session ${runId} started automatically (run telemetry is ambient; finish with \`campaigns-os run end\`, opt out per-run with --no-run-session).\n`);
    return sessionHolder?.current || null;
  } catch (error) {
    // Telemetry never blocks a build, but a failed session write must be
    // distinguishable from a clean skip.
    process.stderr.write(`[campaigns-os] run session auto-start skipped: ${error.message}\n`);
    return null;
  }
}

// The lifecycle journal a command writes to: explicit flag > env > active run
// session's journal > fallback. Read and write resolve identically, so the
// journal a command WRITES is the journal run-record READS. `ambient` is the
// session resolved once in main(); `fallbackDir` is used only by run-record's
// read path (its baseDir default); persistence passes none, so with no
// flag/env/session nothing is written (default behavior).
function resolveLifecycleJournal(args, { ambient = null, fallbackDir = null } = {}) {
  if (isNonEmptyString(args["lifecycle-journal"])) return resolve(args["lifecycle-journal"]);
  if (isNonEmptyString(process.env.CAMPAIGNS_OS_LIFECYCLE_LOG)) return resolve(process.env.CAMPAIGNS_OS_LIFECYCLE_LOG);
  if (ambient && isNonEmptyString(ambient.session.lifecycle_journal)) return resolve(ambient.session.lifecycle_journal);
  return fallbackDir ? join(resolve(fallbackDir), LIFECYCLE_JOURNAL_REL_PATH) : null;
}

// The commands and subcommands that actually IMPLEMENT `--dry-run`. The flag
// reaches every handler through a permissive parseArgs, so it is silently
// accepted everywhere — and the lifecycle exemption below, scoped to the flag
// alone, therefore fired on commands that ignore it: `qa run --dry-run` placed
// orders while writing no journal entry, and (see runSessionEndArgs) carried
// the flag into its own auto-end, which assembled no Run Record and left the
// session open. Keyed by `command`, or `command <args._[1]>` where the flag
// belongs to one subcommand. A command outside this set given `--dry-run`
// behaves exactly as it did before: it journals if it otherwise would, and it
// is not refused — refusing unknown flags is separate work.
const DRY_RUN_COMMANDS = new Set([
  "page-kit sync",
  "spec derive",
  "install-skills",
  "install-agent-context",
  "run-record",
  "run end",
  "qa publish",
  "checkpoint waive",
  "theme waive",
]);

function commandImplementsDryRun(command, args = {}) {
  return DRY_RUN_COMMANDS.has(command) || DRY_RUN_COMMANDS.has(`${command} ${args._?.[1]}`);
}

// Append the command's lifecycle entry only when capture is active: an explicit
// flag/env, or an ambient run session. Never throws — a lifecycle write must
// not break a command (telemetry never blocks a build). `help` is a no-op
// command and is not worth recording.
function persistLifecycleIfRequested(args, command, lifecycle, sessionHolder, thrown) {
  if (command === "help" || (command === "sdk" && args._[1] === "storage-check")) return;
  // Three rules about what NEVER reaches the journal, whichever way the journal
  // was selected (--lifecycle-journal, CAMPAIGNS_OS_LIFECYCLE_LOG, or an
  // ambient run session). The in-process lifecycle object is still built; only
  // the persistence below — the journal append and the deviation entry that
  // follows it — is skipped, so a suppressed command still exits as before.
  //   1. --no-write writes nothing, the journal included (issue #459: `run
  //      status --no-write` under an ambient session still created
  //      .campaign-runtime/command-lifecycle.jsonl).
  //   2. A refused INVOCATION records nothing — an unknown top-level command,
  //      an unknown subcommand (`tooling statuss`), or a flag the command
  //      refuses up front (`standardize --dryrun`). None of them reached a
  //      handler, so a typo must not materialize a journal under the target.
  //      The tag the refusal carries IS the mechanism, read two ways: on the
  //      thrown error, or via refusalSeen() when the refusal was caught and
  //      rendered instead of thrown. There is deliberately no command-list
  //      backstop here — knownCommands() is regex-harvested and documented as
  //      fragile, so a second reading of it would be a second command list that
  //      could disagree with dispatch.
  //   3. `run status` is read-only: it never sweeps and never journals.
  if (args["no-write"] === true) return;
  if (refusalSeen() || thrown?.code === REFUSED_INVOCATION) return;
  if (command === "run" && args._[1] === "status") return;
  // An inspection must not append to a delivered campaign's active run either.
  // (--no-write is handled above, so only the read-only `doctor` form is left.)
  if (command === "doctor" && args.packet && args.write !== true) return;
  // The same rule, per-flag, for every command that takes `--dry-run`: the
  // flag's whole promise is that the invocation writes nothing under the
  // target, and the journal lives under the target. Only for the commands that
  // make that promise, though — DRY_RUN_COMMANDS above.
  if (args["dry-run"] === true && commandImplementsDryRun(command, args)) return;
  // `readback` is declared read-only for the whole command, not per-flag: it
  // writes nothing under the target, so a journal entry would be the one write
  // its own contract forbids. Skipped the way doctor inspection is skipped.
  if (command === "readback") return;
  const ambient = sessionHolder?.current || null;
  // A session auto-started DURING this command (start/prepare-build) is
  // published into sessionHolder by autoStartRunSession; this command's own
  // entry is the run's first record. Its run_id was unknown when the
  // lifecycle wrapper started (the session did not exist yet), so stamp a
  // local copy now — otherwise run-record aggregation by run_id would
  // silently exclude the run's entry-point command. This stamp pairs with
  // autoStartRunSession: if that call ever moves out of dispatch, the
  // holder stays the single handoff point.
  let entry = lifecycle;
  if ((sessionHolder?.autoStarted || sessionHolder?.adopted) && !entry.run_id && ambient?.session?.run_id) {
    entry = { ...entry, run_id: ambient.session.run_id };
  }
  const journalPath = resolveLifecycleJournal(args, { ambient });
  if (!journalPath) return;
  try {
    appendLifecycleEntry(journalPath, entry);
  } catch (error) {
    // Non-fatal, but leave a one-line breadcrumb on stderr so a capture failure
    // is observable rather than fully silent. stderr never pollutes --json stdout.
    process.stderr.write(`[campaigns-os] lifecycle capture skipped: ${error.message}\n`);
  }
  persistDeviationIfDetected(args, command, entry, ambient);
}

// Deviation telemetry: compare every pipeline-advancing command against the
// active session's last `next` recommendation. A mismatch appends one entry to
// .campaign-runtime/agent-deviations.jsonl — measurement, not a block. An
// intentional detour can carry --deviation-reason "<why>". Never throws.
function persistDeviationIfDetected(args, command, lifecycle, ambient) {
  if (!ambient?.session?.last_recommendation) return;
  if (isRunSessionTerminal(ambient.session) || hasDoneRecommendation(ambient.session) || isRunSessionStale(ambient.session)) return;
  try {
    const entry = detectDeviation({
      lastRecommendation: ambient.session.last_recommendation,
      command,
      argvShape: lifecycle?.argv_shape || [],
      runId: ambient.session.run_id || null,
      deviationReason: optionalString(args["deviation-reason"]) || null,
    });
    if (!entry) return;
    const journalPath = join(ambient.dir, DEVIATION_JOURNAL_REL_PATH);
    appendDeviation(journalPath, entry);
    process.stderr.write(
      `[campaigns-os] deviation recorded: \`${command}\` ran while next recommended stage "${entry.recommended_stage}" (expected: ${entry.recommended_commands.join(", ") || "none"}). Declare intent with --deviation-reason, or follow \`campaigns-os next\`.\n`,
    );
  } catch {
    // telemetry never blocks a command
  }
}

function hasDoneRecommendation(session) {
  return session?.last_recommendation?.stage === "done";
}

export function recordQaStageOutcome(args, result) {
  try {
    const packetArg = optionalString(args.packet);
    if (!packetArg) return false;
    const packetPath = resolve(packetArg);
    // Follows the Build Context's report_path: the QA outcome belongs in the
    // report `next` reads, which for a `prepare-build --report-out` run is not
    // the default sidecar.
    const workspace = resolveCampaignWorkspace(packetPath, {
      contextPath: args.context ? resolve(args.context) : undefined,
      reportPath: args.report ? resolve(args.report) : undefined,
      followContextPointer: true,
    });
    const { packet, reportPath } = workspace;
    if (!existsSync(reportPath)) return false;

    const verdict = result.verdict;
    const hasLocalIdentity = packet.spec?.local_spec_id != null || verdict?.local_spec_id != null;
    if (hasLocalIdentity && !qaVerdictIdentityMatch(verdict, packet)) return false;
    const failed = (Array.isArray(verdict.assertions) ? verdict.assertions : [])
      .filter((assertion) => assertion?.status === "fail")
      .map((assertion) => `${assertion.id}: ${assertion.actual || "assertion failed"}`);
    const committed = commitAssemblyReport(workspace, (report) => {
      if (hasLocalIdentity && !specHashesMatch(verdict.spec_hash, report.identity?.spec_material_hash)) {
        throw new Error("Local-spec QA verdict belongs to a different material revision; report evidence was not changed.");
      }
      return recordProducerStageOutcome(report, {
        stage: "qa",
        disposition: verdict.disposition,
        timestamp: verdict.completed_at,
        command: `campaigns-os ${QA_RUN_PRODUCER}`,
        outputs: [result.local_path, result.qa_sidecar?.path].filter(isNonEmptyString),
        blockers: verdict.disposition === "blocked" ? failed : [],
        warnings: verdict.disposition === "ready_with_exceptions"
          ? ["QA completed with explicitly attributed exceptions; inspect the verdict artifact."]
          : [],
        // The producer knows its own run id and must restate it, or the stage
        // keeps a previous run's identity beside this run's status and outputs.
        identity: { verdict_run_id: optionalString(verdict.run_id) },
        // Which build this verdict judged, and the gates whose browser outcome
        // the doctor's static scan defers to (qaGatePassedForCurrentBuild). A
        // gate that never ran is left out, so silence never reads as a pass.
        evidence: qaStageGateEvidence(verdict, report),
        // Counts-only: never order ids, refs, emails or URLs (see
        // summarizePurchaseProof). This is what lets `next` tell a real purchase
        // path from a `--test-order off` diagnostic.
        proof: summarizePurchaseProof({ verdict, proofPolicy: packet.qa?.proof_policy }),
      });
    }, {
      stage: "qa",
      // The sidecar names this refresh as its producer (generated_by, #312).
      // This function is the `qa run` stage record, whichever token dispatch
      // matched to reach it.
      command: QA_RUN_PRODUCER,
      // Updating the QA stage changes the report after the preflight doctor
      // snapshot. Refresh the doctor artifact from the updated ledger in the
      // same producer transaction so closeout never leaves a known-stale green
      // sidecar. The outcome is on disk both when this run wrote it and when
      // the report already said it (a re-record); only another campaign's
      // report, which is not written, leaves the sidecar alone.
      refreshDoctor: ({ written, skipped }) => (written || skipped === "unchanged"
        ? doctorPacket(packetPath, {
          contextPath: existsSync(workspace.contextPath) ? workspace.contextPath : null,
          reportPath,
        })
        : null),
    });
    // True when the report now carries this run's outcome — written by this
    // call or already there — as before; false when it belongs elsewhere.
    return committed.written || committed.skipped === "unchanged";
  } catch (error) {
    // Assembly Report ownership is best-effort telemetry. A malformed or
    // partial sidecar must never replace QA's result or prevent run closeout.
    process.stderr.write(`[campaigns-os] QA stage ledger update skipped: ${error.message}\n`);
    return false;
  }
}

function qaStageGateEvidence(verdict, report) {
  const gates = {};
  const placeholderText = summarizePlaceholderTextGate(verdict);
  if (placeholderText) gates[QA_GATE_PLACEHOLDER_TEXT_RESIDUE] = placeholderText;
  if (!Object.keys(gates).length) return null;
  return { source_build_fingerprint: currentBuildFingerprint(report), gates };
}

// What the auto-end says when the attempt does NOT end the session. Every
// interpolated value is flattened first, for the same reason the closeout
// notice flattens its own: none of the three is toolkit-authored. The run ids
// come off the verdict and the session file, and the disposition is whatever
// the verdict carried — including, on this branch of the check, a value this
// toolkit does not recognise, which is exactly the case where it is least
// likely to be a tame identifier.
export function sessionKeptOpenNotice({ attemptRunId = null, disposition = null, sessionRunId = null }) {
  const safeDisposition = singleLineField(disposition);
  const why = safeDisposition === "blocked"
    ? "is blocked"
    : `carries no session-ending disposition (${safeDisposition || "none recorded"})`;
  const attempt = singleLineField(attemptRunId, "recorded");
  const session = singleLineField(sessionRunId, "(unnamed run)");
  return `[campaigns-os] QA attempt ${attempt} ${why}; run session ${session} remains active for repair and re-test.\n`;
}

// What the auto-end says once it has assembled the record and cleared the
// session. The clearing is why the remit outcome has to be reported HERE: from
// the next command onwards there is no session, so nothing knows this run_id.
// `skipped` is a deliberate non-remit (consent off, --no-remit, local-only),
// not a failure.
//
// It deliberately does NOT print `run-record --run-id <id>` as a recovery.
// That command REASSEMBLES the record from what is on disk at the time it runs;
// it does not reload the one already written. The session's QA attempt
// references come only from ambient.session.qa_attempts (see runRecordCommand),
// and the session is gone by then — so on a session with more than one attempt
// the "recovery" would replace a complete record with a thinner one and send
// that instead. Resending the persisted file is the right fix and is follow-up
// work; until it exists the honest advice is to keep the file.
export function autoEndCloseoutNotice({ runId, recordPath = null, remitState = null, remitError = null }) {
  const safeRunId = singleLineField(runId, "(unnamed run)");
  const safeRecordPath = singleLineField(recordPath);
  const assembled = `[campaigns-os] Run session ${safeRunId} auto-ended after qa run; Run Record ${safeRecordPath || "assembled"}.\n`;
  if (remitState === "ok" || remitState === "skipped") return assembled;
  const why = remitError ? ` (${singleLineField(remitError)})` : "";
  const kept = safeRecordPath
    ? `The complete record is on disk at ${safeRecordPath} — it holds every QA attempt this session collected. Keep it.`
    : "No local record path was reported for this run, so there is nothing on disk to keep.";
  return `${assembled}[campaigns-os] That record's remit did not complete${why}. ${kept} There is no retry-from-file path yet: re-running run-record against this run id reassembles the record from current disk state, without the session's attempt references, so it would overwrite this one with less than it has.\n`;
}

async function autoEndRunSessionAfterTerminalQa(args, command, sessionHolder, thrown) {
  if (command !== "qa" || args._[1] !== "run" || thrown) return;
  const found = sessionHolder?.current;
  const result = sessionHolder?.qaResult;
  if (!found?.session || !result?.verdict) return;
  if (isRunSessionTerminal(found.session) || isRunSessionStale(found.session)) return;

  const attempt = {
    path: resolve(result.local_path),
    disposition: optionalString(result.verdict.disposition) || optionalString(result.status),
    run_id: optionalString(result.verdict.run_id) || optionalString(result.run_id),
    completed_at: optionalString(result.verdict.completed_at),
    // What the QA portal answered for this attempt's verdict, in the Run
    // Record's block shape, so the record this session closes under says
    // whether the verdict is published and `qa publish` can refuse a repeat.
    publish: isObject(result.qa_verdict_publish) ? result.qa_verdict_publish : null,
  };
  const updatedFound = {
    ...found,
    session: {
      ...found.session,
      qa_attempts: [...(Array.isArray(found.session.qa_attempts) ? found.session.qa_attempts : []), attempt],
      updated_at: new Date().toISOString(),
    },
  };
  writeRunSession(found.dir, updatedFound.session);
  sessionHolder.current = updatedFound;

  // Enumerated, not excluded: a disposition this version does not recognise
  // keeps the session open rather than silently closing and remitting it. The
  // closeout command printed moments ago read the same set, so the two can
  // never disagree about whether the session still holds this run_id.
  if (!SESSION_ENDING_DISPOSITIONS.has(attempt.disposition)) {
    process.stderr.write(sessionKeptOpenNotice({
      attemptRunId: attempt.run_id,
      disposition: attempt.disposition,
      sessionRunId: found.session.run_id,
    }));
    return;
  }

  const packet = optionalString(args.packet) || optionalString(found.session.packet);
  if (!packet) {
    process.stderr.write("[campaigns-os] run session auto-end skipped after QA: no build packet recorded on the session.\n");
    return;
  }

  // `dry-run` is inheritable because `run end --dry-run` hands it to
  // run-record on purpose. The invoking command here is `qa run`, which does
  // not implement the flag, so inheriting it would turn its own auto-end into
  // a dry run: no Run Record written, and the session left open after a
  // terminal QA. Every other inheritable flag `qa run` may carry is one
  // run-record reads the same way whoever passed it.
  const extraArgs = { ...args, "qa-verdict": result.local_path };
  if (!commandImplementsDryRun(command, args)) delete extraArgs["dry-run"];

  const summary = await closeRunSession(updatedFound, {
    packet,
    extraArgs,
    silent: true,
    promptForConsent: false,
    onError: (error) => process.stderr.write(`[campaigns-os] run session auto-end skipped after QA: ${error.message}\n`),
  });
  if (!summary) return;
  sessionHolder.current = null;
  process.stderr.write(autoEndCloseoutNotice({
    runId: updatedFound.session.run_id,
    recordPath: summary.record_path || null,
    remitState: optionalString(summary.record?.remit_state),
    remitError: optionalString(summary.record?.remit_error),
  }));
}

const PREPARE_MODES = Object.freeze({
  start: { runDoctor: true, installContext: true },
  build: { runDoctor: true, installContext: false },
  "prepare-build": { runDoctor: false, installContext: false },
});

async function dispatch(command, args, recorder = NOOP_RECORDER, ambient = null, sessionHolder = null) {
  if (command === "demo") {
    // main() already validated raw argv before entering this private function.
    const target = demoArguments(args);
    if (target === null) {
      console.log("campaigns-os demo --target <new-directory>\nOffline Apollo sample only. Open the printed landing/index.html file. Start a real campaign in a separate new Page Kit folder; preserve your sample edits.");
      return;
    }
    const result = createDemo(target);
    console.log(`Offline sample only; no campaign evidence.\nOpen: ${result.index}\nStart a real campaign in a separate new Page Kit folder. Preserve sample edits; demo is never converted automatically.`);
    return;
  }
  if (command === "help" || (args.help && command !== "qa")) {
    console.log(HELP);
    return;
  }

  if (command === "start" || command === "prepare-build" || command === "build") {
    // One intake body, three modes: `start` = prepare + doctor + agent context,
    // `build` = prepare + doctor, `prepare-build` = prepare only. The three
    // literal string comparisons above stay so knownCommands() keeps deriving
    // them from this function's source.
    const mode = PREPARE_MODES[command];
    if (!mode) throw new Error(`No intake mode registered for "${command}"; add it to PREPARE_MODES.`);
    // Validate argv before --spec is inspected or --map-id fetches and caches.
    // Preserve resolveSpecPath's missing-input and map-id/target diagnostics.
    if (args.spec || (args["map-id"] && args.target)) requireArg(args, "source");
    if (args.spec) requireArg(args, "target");
    const sourceKind = optionalString(args["source-kind"], "html_funnel");
    if (sourceKind !== "html_funnel") {
      throw refused(`Unsupported source adapter "${sourceKind}". Use html_funnel for the current prepared-HTML flow.`);
    }
    const wrapperPolicyFlag = refusing(() => parseWrapperPolicyFlag(args));
    refusing(() => requireDesignManifestValue(args));
    const orderPathDepthFlag = refusing(() => parseOrderPathDepthFlag(args, { command: "prepare-build" }));
    // Tier 2: mark sub-phases so the lifecycle journal entry carries per-phase
    // timings (spec resolve vs the prepare+doctor+install build), which Tier 1
    // aggregates into `start:resolve-spec` / `start:prepare-build` stages.
    const resolved = await recorder.time("resolve-spec", () => resolveSpecPath(args));
    // The spec as the operator named it, before resolution, so the build
    // context can record which input to replay (a local file, or a map id
    // fetched from a given store).
    const specInput = { flag: optionalString(args.spec) || null, ...resolved };
    args.spec = resolved.specPath;
    // `command` rides along for the doctor sidecar's generated_by stamp when
    // the mode runs doctor (#312): threaded from here, not re-read from argv.
    const result = await recorder.time("prepare-build", () => prepareBuild(args, { ...mode, command, specInput, sourceKind, wrapperPolicyFlag, orderPathDepthFlag }));
    result.spec_source = resolved;
    autoStartRunSession(result, args, ambient, sessionHolder);
    printPrepareResult(result, args);
    return;
  }

  if (command === "doctor") {
    const result = doctorCommand(args);
    writeResult(result, args, result.ok ? 0 : 2);
    printDoctorTinyPrompt(result, args);
    return;
  }

  if (command === "bundle") {
    const subcommand = args._[1] || "check";
    if (subcommand !== "check") throw refused('Unknown bundle subcommand. Use: campaigns-os bundle check --packet <campaign-runtime.build.json> [--require-qa] [--json].');
    const { inspectSidecarBundle, sidecarBundleReadinessLine } = await import("./sidecar-bundle.mjs");
    const result = inspectSidecarBundle({
      packetPath: requireArg(args, "packet"),
      requireQa: args["require-qa"] === true,
    });
    // The text report gets a readiness line under Status; the JSON shape is
    // the published conformance schema, where stage_blocked carries the same
    // answer.
    writeResult(result, args, result.ok ? 0 : 2, { headerLines: [sidecarBundleReadinessLine(result)] });
    return;
  }

  if (command === "sdk") {
    if (args._[1] !== "storage-check" || args._.length !== 2) throw refused("Use: campaigns-os sdk storage-check --target <git-root> --target-sdk <x.y.z> --manifest <SDK-manifest.json> --scope <dir,file> [--exclude <dir,file>] [--json].");
    const known = new Set(["_", "target", "target-sdk", "manifest", "scope", "exclude", "json"]);
    if (args.json !== undefined && args.json !== true) throw refused("--json is a boolean flag and takes no value.");
    for (const key of Object.keys(args)) if (!known.has(key)) throw refused(`Unknown SDK storage-check flag: --${key}`);
    const { scanSdkStorageCompatibility, formatStorageCompatibilityReport } = await import("./sdk-storage-compatibility.mjs");
    const result = scanSdkStorageCompatibility({
      cwd: requireArg(args, "target"),
      targetSdkVersion: requireArg(args, "target-sdk"),
      manifestPath: requireArg(args, "manifest"),
      scope: requireArg(args, "scope").split(","),
      exclude: args.exclude === undefined ? [] : requireArg(args, "exclude").split(","),
    });
    console.log(args.json ? JSON.stringify(result, null, 2) : formatStorageCompatibilityReport(result));
    process.exitCode = result.status === "source-compatible" ? 0 : 2;
    return;
  }

  if (command === "standardize") {
    const result = standardizationReportCommand(args);
    writeStandardizationReportResult(result, args);
    return;
  }

  if (command === "theme") {
    const result = args._[1] === "waive"
      ? waiveOrRefuse(args, () => themeCommand(args), { gate: "theme_gate", registeredGates: ["theme_gate"] })
      : themeCommand(args);
    if (!result) return;
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "checkpoint") {
    const result = waiveOrRefuse(args, () => checkpointCommand(args), {
      gate: optionalString(args.gate) || null,
      registeredGates: Object.keys(CHECKPOINT_EVALUATORS),
    });
    if (!result) return;
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "polish") {
    const result = await polishCaptureCommand(args);
    writePolishCaptureResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "readback") {
    // Read-only projection over a target's already-emitted artifacts. It owns
    // its own exit codes (0 for any projection it could form, 2 for a request
    // that cannot form one) rather than throwing, so a usage error reads as a
    // one-line refusal instead of a stack-shaped CLI error.
    const { runReadbackCommand } = await import("./readback.mjs");
    const { exitCode, text } = runReadbackCommand(args);
    if (exitCode === 0) process.stdout.write(text);
    else {
      process.stderr.write(text);
      process.exitCode = 2;
    }
    return;
  }

  if (command === "validate-assembly-report") {
    const reportPath = requireArg(args, "report");
    const result = validateAssemblyReport(readJson(resolve(reportPath)));
    writeResult(result, args, result.ok ? 0 : 2);
    return;
  }

  if (command === "install-agent-context") {
    const target = requireArg(args, "target");
    const result = installAgentContext(resolve(target), Boolean(args["dry-run"]));
    writeResult(result, args, 0);
    return;
  }

  if (command === "install-skills") {
    if (args.target === true) throw refused("Missing value for --target");
    if (args.platform === true) throw refused("Missing value for --platform");
    const result = installSkills(args.target, Boolean(args["dry-run"]), args.platform);
    writeResult(result, args, 0);
    return;
  }

  if (command === "page-kit") {
    const subcommand = args._[1] || null;
    // Spelled as inequalities: knownCommands() harvests the top-level
    // command literals from this function by an equality pattern that a
    // subcommand equality would also match.
    if (subcommand !== "sync" && subcommand !== "parity") throw refused("Unknown page-kit subcommand. Use: campaigns-os page-kit sync --packet <campaign-runtime.build.json> [--dry-run] [--json], or campaigns-os page-kit parity --packet <campaign-runtime.build.json> [--report <json>] [--json].");
    const parity = subcommand !== "sync";
    const result = parity ? pageKitParityCommand(args) : pageKitSyncCommand(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else for (const line of parity ? pageKitParityTextLines(result) : pageKitSyncTextLines(result)) console.log(line);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "spec") {
    const subcommand = args._[1] || null;
    // Inequality on purpose: knownCommands() harvests top-level command
    // literals by an equality pattern a subcommand equality would also match.
    if (subcommand !== "derive") throw refused("Unknown spec subcommand. Use: campaigns-os spec derive --packet <campaign-runtime.build.json> [--dry-run] [--json].");
    const result = await specDeriveWithMapWriteback(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else for (const line of specDeriveWriteMapTextLines(result)) console.log(line);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "tooling") {
    const result = await toolingStatusCommand(args);
    // The revision line is a header, so a mismatch is stated before the status
    // an operator would otherwise read as fine — and the full status still
    // prints, because the exit code is set after the render, not instead of it.
    writeResult(result, args, result.ok ? 0 : 2, { headerLines: [...skillsRevisionTextLines(result), ...pinTextLines(result)] });
    return;
  }

  if (command === "next") {
    // Slice 3 Phase 2: `campaigns-os next` (no stage) self-decides the next
    // stage from the current report + doctor state. Existing form with an
    // explicit stage (`next build`, `next polish`, etc.) is unchanged.
    const stage = args._[1] || null;
    const result = nextStage(stage, args, ambient);
    await observeProgress(args, result, { packageVersion: packageVersion(), resolveKey: resolveCampaignsApiKeySource });
    writeResult(result, args, result.ok ? 0 : 2);
    printNextTinyPrompt(result, args);
    return;
  }

  if (command === "qa") {
    const { runQaCli } = await import("./qa-node.mjs");
    // The ambient session is handed over, not re-discovered: the closeout
    // command a QA run prints has to agree with the run_id this session will
    // later close and remit under.
    const result = await runQaCli(args, { ambient });
    // nextStage requires a packet. Guard its optional, swallowed progress
    // probe explicitly so it cannot construct a refusal in that try block.
    if (args._[1] === "run" && result?.verdict && isNonEmptyString(args.packet) && recordQaStageOutcome(args, result)) {
      // Observe committed QA before the existing closeout; this cannot close
      // a run or change the QA disposition. Reuse the canonical picker.
      try {
        const continuation = nextStage(null, { ...args, "no-write": true }, null);
        await observeProgress(args, continuation, { qaResult: result, packageVersion: packageVersion(), resolveKey: resolveCampaignsApiKeySource });
      } catch { /* optional progress never changes lifecycle closeout */ }
    }
    if (sessionHolder) sessionHolder.qaResult = result;
    return;
  }

  if (command === "findings") {
    await findingsCommand(args, ambient);
    return;
  }

  if (command === "run-record") {
    await runRecordCommand(args, ambient);
    return;
  }

  if (command === "telemetry") {
    await telemetryCommand(args);
    return;
  }

  if (command === "run") {
    const { result, exitCode } = await runSessionCommand(args, ambient, sessionHolder);
    writeRunSessionResult(result, args, exitCode);
    return;
  }

  const suggestion = closestCommand(command);
  const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw refused(
    `Unknown command: ${command}.${didYouMean} Run \`campaigns-os --help\` to see available commands.`,
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

// The shared "missing required flag" refusal. Every call site resolves flags
// at the top of its handler, before the command reads or writes anything, so
// this is always an up-front refusal and carries the tag.
function requireArg(args, key) {
  const value = args[key];
  if (!isNonEmptyString(value)) throw refused(`Missing required --${key}`);
  return value;
}

// `--dry-run` is a bare flag on every command that takes one. The shared
// parser would read a following token as its value, so `--dry-run true` must
// fail rather than quietly become a real write or a real send.
function isDryRun(args) {
  if (Object.hasOwn(args, "dry-run") && args["dry-run"] !== true) {
    throw refused(`--dry-run takes no value (got ${JSON.stringify(args["dry-run"])}); write \`--dry-run\` on its own, after the other flags.`);
  }
  return args["dry-run"] === true;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value, fallback = null) {
  return isNonEmptyString(value) ? value.trim() : fallback;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  return path && existsSync(path) ? readJson(path) : null;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}


/**
 * Sanitize a Map ID for use as a cache filename. Map IDs are normally
 * already filesystem-safe slugs (e.g. "veyra-v1-knp4"), but defend
 * against unexpected characters so a malformed ID can't escape the
 * cache directory.
 */
function sanitizeMapIdForFilename(mapId) {
  return String(mapId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "unnamed";
}

/**
 * Resolve `--spec` / `--map-id` into a local file path that downstream
 * sync code (prepareBuild, doctor, etc.) can read like any other spec.
 *
 * Resolution order:
 *   --spec <path>        -> use that local file directly
 *   --map-id <id>        -> fetch from proxy, cache to disk, return cache path
 *   (neither set)        -> error
 *
 * When fetched, the spec is cached at
 *   <targetRepo>/.campaign-runtime/fetched-specs/<sanitized-id>.json
 * so subsequent stages have a stable on-disk path AND so the fetch is
 * inspectable for debugging. KV is the source of truth, so re-runs
 * always re-fetch by default; pass `--cached-spec` to reuse the cache
 * without hitting the network (useful for offline iteration).
 *
 * Returns `{ specPath, source, mapId?, proxyBase? }`. `source` is one
 * of "local" | "remote" | "cache".
 */
async function resolveSpecPath(args, opts = {}) {
  if (args.spec) {
    const specPath = resolve(args.spec);
    if (!existsSync(specPath)) throw new Error(`CampaignSpec does not exist: ${specPath}`);
    return { specPath, source: "local" };
  }
  if (args["map-id"]) {
    const mapId = String(args["map-id"]).trim();
    const targetRepo = opts.targetRepo || (args.target ? resolve(args.target) : null);
    if (!targetRepo) {
      throw refused("--map-id requires --target (so the fetched spec can be cached under <target>/.campaign-runtime/).");
    }
    const proxyBase = optionalString(args["proxy-base"], DEFAULT_PROXY_BASE);
    const cacheDir = join(targetRepo, ".campaign-runtime", "fetched-specs");
    const cachePath = join(cacheDir, `${sanitizeMapIdForFilename(mapId)}.json`);
    if (args["cached-spec"]) {
      if (!existsSync(cachePath)) {
        throw new Error(`--cached-spec set but no cached spec found at ${cachePath}. Run without --cached-spec to fetch.`);
      }
      return { specPath: cachePath, source: "cache", mapId, proxyBase };
    }
    const spec = await fetchSpecByMapId(mapId, { proxyBase, fetchImpl: opts.fetchImpl });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(spec, null, 2)}\n`);
    return { specPath: cachePath, source: "remote", mapId, proxyBase,
      savedMapRevision: { map_id: mapId, hash: spec.spec_identity?.spec_hash || spec.spec_hash || null,
        algorithm: "map-store-v1", local_spec_material_hash: specMaterialHash(spec) },
    };
  }
  throw refused(
    "Either --spec <path> or --map-id <id> is required. " +
      "Pass a local CampaignSpec (--spec <path-to-campaignspec.json>) " +
      "or fetch one from Map Builder (--map-id <id> --target <page-kit-dir>).",
  );
}

function sha256File(path) {
  return htmlScanDigest(path);
}

function relFromFile(filePath, targetPath) {
  const fromDir = dirname(resolve(filePath));
  const rel = relative(fromDir, resolve(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Portable output rebases every path onto the output base as the filesystem
// knows both (real paths when they exist), so a target reached through a
// symlinked checkout and a sidecar recorded by its real path relativize to
// `./…`, not to a chain of `../` that names the original machine.
function relFromDir(dirPath, targetPath) {
  const rel = relative(canonicalPath(dirPath), canonicalPath(targetPath));
  if (!rel) return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isLocalAbsolutePath(value) {
  return isNonEmptyString(value) && !isAbsoluteHttpUrl(value) && isAbsolute(value);
}

function relativizeDoctorOutput(result, baseDir) {
  const replacements = new Map();
  for (const value of Object.values(result.derived || {})) {
    if (isLocalAbsolutePath(value)) {
      replacements.set(value, relFromDir(baseDir, value));
    }
  }
  const sortedReplacements = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);

  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, visit(entryValue)]));
    }
    if (typeof value !== "string") return value;
    if (isLocalAbsolutePath(value)) return relFromDir(baseDir, value);
    let nextValue = value;
    for (const [absolutePath, relativePath] of sortedReplacements) {
      nextValue = nextValue.split(absolutePath).join(relativePath);
    }
    return nextValue;
  }

  return visit(result);
}

function resolveFromFile(filePath, targetPath) {
  if (!isNonEmptyString(targetPath)) return null;
  if (isAbsoluteHttpUrl(targetPath)) return targetPath;
  return resolve(dirname(resolve(filePath)), targetPath);
}

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

function campaignIdentity(spec, args) {
  const mapId = optionalString(args["map-id"])
    || optionalString(spec.spec_identity?.map_id)
    || optionalString(spec.map_id);
  const publicRouteSlug = optionalString(args["public-route-slug"])
    || optionalString(spec.spec_identity?.public_route_slug)
    || optionalString(spec.campaign?.slug)
    || optionalString(spec.campaign?.id);
  return { mapId, publicRouteSlug, localSpecId: spec.spec_identity?.local_spec_id ?? null };
}

function preferredTemplateFamily(spec) {
  return optionalString(spec?.spec_identity?.preferred_template_family)
    || optionalString(spec?.campaign?.preferred_template_family)
    || optionalString(spec?.preferred_template_family)
    || null;
}

function createStage(stage, status, extras = {}) {
  return {
    stage,
    status,
    inputs: [],
    outputs: [],
    commands: [],
    blockers: [],
    warnings: [],
    ...extras,
  };
}

/**
 * Create the assembly-report stage ledger emitted by prepare-build.
 *
 * Every declared stage starts pending. `prepare_build` is immediately marked
 * completed or blocked from the source/spec readiness result, while `setup` is
 * pending only when starter scaffold adoption is required and skipped otherwise.
 */
function createInitialAssemblyReportStages({ scaffoldRequired, blockers, outputs, declaredScopeSkips = [] }) {
  const stages = Object.fromEntries(
    ASSEMBLY_REPORT_STAGE_KEYS.map((stage) => [stage, createStage(stage, "pending")])
  );
  // "completed_partial" is terminal under the prefix-matching stage contract
  // (STAGE_TERMINAL_STATUS_PREFIXES): declared out-of-scope pages do not hold
  // the ladder, they are recorded on the stage so downstream consumers can see
  // exactly which pages assemble from the template family instead of source HTML.
  const terminalStatus = declaredScopeSkips.length ? "completed_partial" : "completed";
  stages.prepare_build = createStage("prepare_build", blockers.length ? "blocked" : terminalStatus, {
    outputs,
    blockers,
    ...(declaredScopeSkips.length ? { declared_out_of_scope: declaredScopeSkips } : {}),
  });
  stages.setup = createStage("setup", scaffoldRequired ? "pending" : "skipped");
  return stages;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// `orderPathDepth` is the operator's `--order-path-depth` (validated by
// parseOrderPathDepthFlag against ORDER_PATH_DEPTHS); the seed is `common`.
function createProofPolicy({ orderPathDepth = null } = {}) {
  return {
    browser_qa_required: true,
    typed_card_depth: "common",
    localhost_development_domain_allowed: true,
    non_localhost_origin_allowlist_required: true,
    order_path_depth: orderPathDepth || "common",
    operator_approval_state: "not_required_global_test_cards",
    qa_portal_publish_default: true,
  };
}

// Stage keys whose seed states prepare-build itself rewrites on every run
// (createInitialAssemblyReportStages): prepare_build is re-derived from this
// run's readiness result, and setup from scaffold detection — so their seed
// states never count as accumulated agent evidence. setup's seed state may
// legitimately be "skipped" (scaffold already present); every other stage is
// seeded "pending" with empty ledger arrays.
function assemblyReportStagesWithEvidence(existingReport) {
  const stages = existingReport?.stages;
  if (!isObject(stages)) return [];
  const withEvidence = [];
  for (const key of ASSEMBLY_REPORT_STAGE_KEYS) {
    if (key === "prepare_build") continue;
    const stage = stages[key];
    if (!isObject(stage)) continue;
    const seedStatuses = key === "setup" ? ["pending", "skipped"] : ["pending"];
    const nonSeedStatus = !seedStatuses.includes(optionalString(stage.status, "pending"));
    const recordedContent =
      ["inputs", "outputs", "commands", "blockers", "warnings", "evidence"].some(
        (field) => Array.isArray(stage[field]) && stage[field].length > 0,
      )
      || (isObject(stage.evidence) && Object.keys(stage.evidence).length > 0);
    if (nonSeedStatus || recordedContent) withEvidence.push(key);
  }
  return withEvidence;
}

// INV-4 guard (packet 02): prepare-build/start regenerate the assembly report
// from scratch (createAssemblyReport resets every stage), so an unconditional
// write silently destroys agent-recorded stage evidence. Mirror the
// runSessionStart pattern: refuse unless --force, and with --force announce
// exactly which stage keys are cleared. The guard keys on evidence, not file
// existence — a report whose stages are all still at their seed states (a real
// re-prepare before any work) regenerates freely with no flag.
function guardAssemblyReportOverwrite(reportPath, args) {
  if (!existsSync(reportPath)) return;
  let existingReport = null;
  try {
    existingReport = readJson(reportPath);
  } catch {
    return; // An unreadable report carries no provable evidence; keep today's regeneration path.
  }
  const stageKeys = assemblyReportStagesWithEvidence(existingReport);
  if (stageKeys.length === 0) return;
  if (args.force !== true) {
    throw new Error(
      `Assembly report at ${reportPath} already carries stage evidence (${stageKeys.join(", ")}). `
      + `Rerunning prepare-build/start/build would reset ${stageKeys.length === 1 ? "this stage" : "these stages"} to pending and destroy that evidence. `
      + `Pass --force to overwrite (destructive).`,
    );
  }
  console.warn(
    `[campaigns-os prepare-build] --force: overwriting assembly report at ${reportPath}; clearing stage evidence for: ${stageKeys.join(", ")}.`,
  );
}

function artifactRelativePath(artifactPath, targetPath) {
  const rel = relative(dirname(resolve(artifactPath)), resolve(targetPath)).replaceAll("\\", "/");
  return rel || ".";
}

function canonicalPrepareBuildOutputPath(path, label) {
  const absolute = resolve(path);
  const missingSegments = [];
  let cursor = absolute;
  while (true) {
    let stats;
    try {
      stats = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    // Even a dangling leaf symlink becomes writable after an earlier output
    // creates its target. Reject the alias itself instead of relying on stat,
    // which follows symlinks and cannot see a dangling one.
    if (missingSegments.length === 0 && stats.isSymbolicLink()) {
      throw new Error(`Prepare-build output path collision: ${label} at ${absolute} is a symbolic-link alias. Choose a regular, distinct output path; the Design Source Package path is fixed.`);
    }

    try {
      return resolve(realpathSync(cursor), ...missingSegments);
    } catch {
      throw new Error(`Prepare-build output path collision: ${label} at ${absolute} traverses an unresolved filesystem alias. Choose a regular, distinct output path; the Design Source Package path is fixed.`);
    }
  }
}

function prepareBuildPathIdentity(path) {
  return resolve(path).normalize("NFC").toLowerCase();
}

function assertDistinctPrepareBuildOutputPaths(outputs) {
  const seenPaths = new Map();
  const seenCanonicalPaths = new Map();
  const seenFiles = new Map();
  for (const [label, path] of outputs) {
    const absolute = resolve(path);
    const pathIdentity = prepareBuildPathIdentity(absolute);
    const priorPath = seenPaths.get(pathIdentity);
    if (priorPath) {
      throw new Error(`Prepare-build output path collision: ${priorPath.label} at ${priorPath.path} and ${label} at ${absolute} are identical after conservative case folding. Choose distinct output paths; the Design Source Package path is fixed.`);
    }
    seenPaths.set(pathIdentity, { label, path: absolute });

    const canonical = canonicalPrepareBuildOutputPath(absolute, label);
    const canonicalIdentity = prepareBuildPathIdentity(canonical);
    const priorCanonical = seenCanonicalPaths.get(canonicalIdentity);
    if (priorCanonical) {
      throw new Error(`Prepare-build output path collision: ${priorCanonical.label} at ${priorCanonical.path} and ${label} at ${absolute} resolve through filesystem aliases to ${canonical}. Choose distinct output paths; the Design Source Package path is fixed.`);
    }
    seenCanonicalPaths.set(canonicalIdentity, { label, path: absolute });

    // A lexical comparison is insufficient once an output already exists:
    // hard links can name the fixed DSP (or another sidecar) through a
    // different path, and writeFileSync would follow that alias. Symlink
    // aliases are already caught by the canonical-path check above, so
    // device + inode only need to identify hard links — files with
    // nlink > 1. Recording an identity for nlink === 1 files is unsound
    // here: the stat calls are not atomic across outputs, and a concurrent
    // prepare-build against the same target can unlink one output and let
    // the kernel recycle its inode for another, making two distinct files
    // momentarily share dev:ino.
    let identity = null;
    try {
      const stats = statSync(absolute);
      if (stats.nlink > 1) identity = `${stats.dev}:${stats.ino}`;
    } catch {
      // Missing output paths have no filesystem identity yet; the normalized
      // absolute-path check above is authoritative until they are created.
    }
    if (identity) {
      const priorFile = seenFiles.get(identity);
      if (priorFile) {
        throw new Error(`Prepare-build output path collision: ${priorFile.label} at ${priorFile.path} and ${label} at ${absolute} are aliases for the same filesystem object. Choose distinct output paths; the Design Source Package path is fixed.`);
      }
      seenFiles.set(identity, { label, path: absolute });
    }
  }
}

function preflightPrepareBuildOutputTargets(outputs, collisionOutputs) {
  assertDistinctPrepareBuildOutputPaths(collisionOutputs);
  for (const [label, path] of outputs) {
    const absolute = resolve(path);
    let stats = null;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Prepare-build could not inspect ${label} output target at ${absolute}: ${error.message}`, { cause: error });
      }
    }
    if (stats && !stats.isFile()) {
      const kind = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symbolic link" : "non-regular filesystem entry";
      throw new Error(`Prepare-build output target is invalid: ${label} at ${absolute} must be absent or a regular file, but found a ${kind}.`);
    }

    // Atomic rename needs write + search permission on the destination's
    // directory, while mkdirSync for a missing directory needs those rights
    // on its nearest existing ancestor. Validate that capability before the
    // fixed DSP or theme artifacts can be published.
    let ancestor = dirname(absolute);
    while (true) {
      try {
        const ancestorStats = statSync(ancestor);
        if (!ancestorStats.isDirectory()) {
          throw new Error(`nearest existing ancestor ${ancestor} is not a directory`);
        }
        try {
          accessSync(ancestor, fsConstants.W_OK | fsConstants.X_OK);
        } catch (error) {
          const code = error?.code ? ` (${error.code})` : "";
          throw new Error(`Prepare-build output target is not writable: ${label} at ${absolute} has non-writable ancestor ${ancestor}${code}: ${error.message}`, { cause: error });
        }
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

function publishPrepareBuildJsonOutputs(outputs, collisionOutputs) {
  preflightPrepareBuildOutputTargets(
    outputs.map(({ label, path }) => [label, path]),
    collisionOutputs,
  );
  const staged = [];
  try {
    for (const output of outputs) {
      const path = resolve(output.path);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(output.value, null, 2)}\n`, { flag: "wx" });
      staged.push({ ...output, path, tmp });
    }

    // Revalidate after all staging writes. A swap before this point is
    // rejected; a symlink or hard-link swap after it is safely replaced as a
    // directory entry by renameSync rather than followed and truncated.
    preflightPrepareBuildOutputTargets(
      outputs.map(({ label, path }) => [label, path]),
      collisionOutputs,
    );
    for (const output of staged) renameSync(output.tmp, output.path);
  } finally {
    for (const output of staged) rmSync(output.tmp, { force: true });
  }
}

function assertValidPreparedDesignSourcePackage(value, path, currentPageScope, currentHtmlFunnelScope) {
  const validation = validateDesignSourcePackage(value, {
    currentPageScope,
    currentHtmlFunnelScope,
  });
  if (validation.ok) return;
  const detail = validation.errors
    .map((error) => `[${error.code}] ${error.path}: ${error.message}`)
    .join("; ");
  throw new Error(`Design Source Package at ${path} is invalid, stale, or contradictory: ${detail}`);
}

function sourceMaterialFile(sourceRoot, path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const root = resolve(sourceRoot);
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const stats = statSync(fullPath);
    if (!stats.isFile()) return null;
    return { bytes: stats.size, sha256: sha256File(fullPath) };
  } catch {
    return null;
  }
}

function manifestPagesForResolvedMappings(pages, mappings) {
  if (!Array.isArray(pages)) return pages;
  const groups = new Map();
  for (const page of pages) {
    if (!isObject(page) || !isNonEmptyString(page.page_id)) continue;
    const group = groups.get(page.page_id) || [];
    group.push(page);
    groups.set(page.page_id, group);
  }
  const resolvedPathByPageId = new Map(
    mappings
      .filter((mapping) => isObject(mapping) && isNonEmptyString(mapping.page_id) && isNonEmptyString(mapping.path))
      .map((mapping) => [mapping.page_id, mapping.path]),
  );
  const resolvedDuplicate = new Map();
  for (const [pageId, group] of groups) {
    if (group.length < 2) continue;
    const resolvedPath = resolvedPathByPageId.get(pageId);
    const matches = resolvedPath
      ? group.filter((page) => page.path === resolvedPath)
      : [];
    resolvedDuplicate.set(pageId, matches.length === 1 ? matches[0] : null);
  }

  return pages.filter((page) => {
    if (!isObject(page) || !isNonEmptyString(page.page_id)) return true;
    if (!resolvedDuplicate.has(page.page_id)) return true;
    return resolvedDuplicate.get(page.page_id) === page;
  });
}

function createCurrentHtmlFunnelScope({
  packagePath,
  activePages,
  mappings,
  manifestResult,
  sourceAssetCrawl,
  templateFamily,
  templateStockPageIds = [],
  commerceCatalog,
  sourceRoot,
  mapId,
  publicRouteSlug,
}) {
  const manifest = manifestResult.manifest ? cloneJson(manifestResult.manifest) : null;
  if (manifest) {
    // Source intake owns duplicate-page resolution and records its blocker.
    // Feed the strict DSP synthesizer only the unique record that agrees with
    // that resolved mapping; an unmatched duplicate group remains ambiguous
    // and contributes no page record. Raw manifest bytes/provenance are still
    // retained through manifest.sha256 below.
    manifest.pages = manifestPagesForResolvedMappings(manifest.pages, mappings);
  }
  const crawl = isObject(sourceAssetCrawl) ? cloneJson(sourceAssetCrawl) : null;
  const materialPaths = new Set([
    ...mappings.map((mapping) => mapping?.path),
    ...(manifest?.files || []).map((file) => file?.path),
    ...(manifest?.pages || []).map((page) => page?.path),
    ...(crawl?.scanned_files || []).map((file) => file?.path),
    ...(crawl?.references || []).map((ref) => ref?.source_path),
  ].filter((path) => typeof path === "string" && path.trim()));
  const materialFiles = new Map(
    [...materialPaths].map((path) => [path, sourceMaterialFile(sourceRoot, path)]),
  );
  const currentMappings = mappings.map((mapping) => ({
    ...mapping,
    ...(mapping?.path ? { source_hash: materialFiles.get(mapping.path)?.sha256 || null } : {}),
  }));

  if (manifest) {
    manifest.sha256 = manifestResult.path ? sha256File(manifestResult.path) : null;
    manifest.files = (manifest.files || []).map((file) => ({
      ...file,
      sha256: materialFiles.get(file.path)?.sha256 || null,
    }));
    manifest.pages = (manifest.pages || []).map((page) => ({
      ...page,
      ...(page.path ? { source_hash: materialFiles.get(page.path)?.sha256 || null } : {}),
    }));
  }

  if (crawl) {
    const scannedByPath = new Map((crawl.scanned_files || []).map((file) => [file.path, file]));
    for (const [path, material] of materialFiles) {
      if (!material) continue;
      const existing = scannedByPath.get(path);
      scannedByPath.set(path, {
        ...(existing || { path, kind: "asset" }),
        bytes: material.bytes,
        sha256: material.sha256,
      });
    }
    crawl.scanned_files = [...scannedByPath.values()].sort((left, right) =>
      String(left.path).localeCompare(String(right.path)));
  }

  return {
    activePages,
    mappings: currentMappings,
    manifest,
    manifestPath: manifest && manifestResult.path
      ? artifactRelativePath(packagePath, manifestResult.path)
      : null,
    sourceAssetCrawl: crawl,
    templateFamily: resolveTemplateFamilyDesignSource(commerceCatalog, templateFamily),
    templateStockPageIds: [...templateStockPageIds],
    packageId: `${mapId}:design-source`,
    campaignMapId: mapId,
    campaignSlug: publicRouteSlug,
    sourceRoot: artifactRelativePath(packagePath, sourceRoot),
  };
}

function prepareDesignSourcePackage({
  path,
  activePages,
  mappings,
  manifestResult,
  sourceAssetCrawl,
  templateFamily,
  templateStockPageIds = [],
  commerceCatalog,
  sourceRoot,
  mapId,
  publicRouteSlug,
}) {
  const currentPageScope = {
    activePages,
    mappings,
    campaignMapId: mapId,
    campaignSlug: publicRouteSlug,
  };
  const currentHtmlFunnelScope = createCurrentHtmlFunnelScope({
    packagePath: path,
    activePages,
    mappings,
    manifestResult,
    sourceAssetCrawl,
    templateFamily,
    templateStockPageIds,
    commerceCatalog,
    sourceRoot,
    mapId,
    publicRouteSlug,
  });
  let value;
  let rawBytes;
  let mode;

  const readExisting = () => {
    let existingBytes;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile()) {
        const kind = stats.isDirectory()
          ? "directory"
          : stats.isSymbolicLink()
            ? "symbolic link"
            : "non-regular filesystem entry";
        throw new Error(`expected a regular file, but found a ${kind}`);
      }
      existingBytes = readFileSync(path);
    } catch (error) {
      const code = error?.code ? ` (${error.code})` : "";
      throw new Error(`Could not read Design Source Package artifact at ${path}${code}: ${error.message}`, { cause: error });
    }

    let existingValue;
    try {
      existingValue = JSON.parse(existingBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Design Source Package at ${path} is not valid JSON: ${error.message}`, { cause: error });
    }
    assertValidPreparedDesignSourcePackage(existingValue, path, currentPageScope, currentHtmlFunnelScope);
    if (existingValue.source_kind !== "html_funnel") {
      throw new Error(`Design Source Package at ${path} declares source_kind ${JSON.stringify(existingValue.source_kind)}; html_funnel prepare-build requires "html_funnel".`);
    }
    return { value: existingValue, rawBytes: existingBytes };
  };

  if (existsSync(path)) {
    ({ value, rawBytes } = readExisting());
    mode = "reused";
  } else {
    value = synthesizeHtmlFunnelDesignSourcePackage(currentHtmlFunnelScope);
    assertValidPreparedDesignSourcePackage(value, path, currentPageScope, currentHtmlFunnelScope);
    rawBytes = Buffer.from(serializeDesignSourcePackage(value), "utf8");
    mkdirSync(dirname(path), { recursive: true });
    const stagedPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(stagedPath, rawBytes, { flag: "wx" });
      try {
        // Linking a fully written same-directory staging file is the Node
        // primitive that combines atomic visibility with no-replace
        // publication. A plain rename fallback is intentionally unsafe here:
        // it could replace a concurrent winner after the absence check.
        linkSync(stagedPath, path);
        mode = "emitted";
      } catch (error) {
        // EEXIST is the ordinary loser path. For any other link failure, a
        // package may still have appeared concurrently at the publication
        // seam; prefer validating that winner before failing closed.
        if (error?.code !== "EEXIST" && !existsSync(path)) {
          throw new Error(
            `Could not atomically publish Design Source Package artifact at ${path}${error?.code ? ` (${error.code})` : ""}: `
            + `exclusive hard-link publication failed; refusing an unsafe rename fallback that could overwrite a concurrent winner: ${error.message}`,
            { cause: error },
          );
        }
        // Another publisher won (or completed while this link failed). Its
        // exact bytes are authoritative; validate and reuse them rather than
        // overwriting.
        ({ value, rawBytes } = readExisting());
        mode = "reused";
      }
    } finally {
      rmSync(stagedPath, { force: true });
    }
  }

  const referenceIdentity = createDesignSourcePackageArtifactReference(value, {
    path: ".",
    serialized: rawBytes,
  });

  return {
    path,
    value,
    rawBytes,
    mode,
    referenceFor(artifactPath) {
      return {
        ...referenceIdentity,
        path: artifactRelativePath(artifactPath, path),
      };
    },
  };
}

// The readiness rule states what is missing; the operator also needs the input
// channel that supplies it. Source screenshot proof is seeded only by the
// source-html manifest's pages[].screenshots[], which is documented nowhere in
// the blocking reason itself.
const DESIGN_SOURCE_PACKAGE_REMEDY = [
  `Supply the missing source proof through pages[].screenshots[] in ${SOURCE_HTML_MANIFEST_REL_PATH}`,
  "under the source root, or in a manifest anywhere else named by --design-manifest <path>",
  "(one available desktop record and one available mobile record per renderable page);",
  `then, if no downstream stage has consumed it, remove the Design Source Package this blocked run emitted at ${DESIGN_SOURCE_PACKAGE_REL_PATH}`,
  "and rerun prepare-build/start.",
  'See "Clearing DESIGN_SOURCE_PACKAGE_NOT_READY" in docs/design-source-package.md.',
].join(" ");
// Only the two reason shapes that screenshot proof resolves get the remedy:
// the missing-proof claim and its blocked source capture TODOs
// (capture-<surface>-<viewport>). The template-reference capture TODO
// (capture-<surface>-template-<viewport>), coverage, gap, divergence, and
// exception reasons keep their own wording.
const DESIGN_SOURCE_PACKAGE_REMEDY_REASON = /source_screenshot proof\.$|^Source TODO "capture-(?![^"]*-template-)[^"]*" is /;

function designSourcePackageBlockers(prepared) {
  if (!["blocked", "pending"].includes(prepared.value?.readiness?.status)) return [];
  return (prepared.value.readiness.blocking_reasons || []).map((message, index) => ({
    code: "DESIGN_SOURCE_PACKAGE_NOT_READY",
    stage: "prepare_build",
    message: DESIGN_SOURCE_PACKAGE_REMEDY_REASON.test(message) ? `${message} ${DESIGN_SOURCE_PACKAGE_REMEDY}` : message,
    detail: {
      blocker_index: index,
      readiness_status: prepared.value.readiness.status,
      material_fingerprint: prepared.value.material_fingerprint,
    },
  }));
}

// Document-wrapper policy, selected by an operator through two channels.
// Split in two so the argv half is validated with the other up-front flag
// checks — before prepare-build has written anything — and only the
// precedence resolution waits on the manifest the intake read.
function parseWrapperPolicyFlag(args) {
  const raw = args["wrapper-policy"];
  // A bare `--wrapper-policy` with no value parses as `true`. Falling through
  // to the manifest or the default there would silently ignore an operator's
  // explicit intent, so treat it as the malformed flag it is.
  if (raw === true) {
    throw new Error(
      `--wrapper-policy needs a value. Accepted values: ${ADAPTER_WRAPPER_POLICIES.join(", ")}.`,
    );
  }
  const flag = optionalString(raw);
  if (flag && !isWrapperPolicy(flag)) {
    throw new Error(
      `Unsupported --wrapper-policy ${JSON.stringify(flag)}. Accepted values: ${ADAPTER_WRAPPER_POLICIES.join(", ")}. ` +
      `See docs/source-adapters.md "Source preparation check".`,
    );
  }
  return flag;
}

// --design-manifest <path>: read the source-html manifest from outside the
// source root. Validated with the other argv checks so a bad path fails before
// prepare-build has written anything. A bare flag, a missing file, or a
// directory are errors: the operator named the file, so silently falling back
// to filesystem matching would discard the declaration they made.
function parseDesignManifestFlag(args) {
  const raw = requireDesignManifestValue(args);
  if (raw == null) return null;
  const path = resolve(raw);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Design manifest does not exist or is not a file: ${path}`);
  }
  return path;
}

function requireDesignManifestValue(args) {
  const raw = args["design-manifest"];
  if (raw != null && (raw === true || !isNonEmptyString(raw))) {
    throw new Error("--design-manifest needs a value: the path of a source-html-manifest/v0 JSON file.");
  }
  return raw;
}

// Same precedence the template family uses (docs/build-packet.md
// "Authoring-Time Hints"): an explicit CLI flag beats a declared file hint,
// and with neither the default stands. The vocabulary is the adapter
// contract's own — there is no second policy list.
function resolveWrapperPolicy({ flag, manifest }) {
  if (flag) return { value: flag, source: "--wrapper-policy" };
  const declared = optionalString(manifest?.wrapper_policy);
  // An out-of-vocabulary manifest value never reaches here: the manifest
  // validator rejects it at read time and the manifest is dropped with a
  // warning, which also happens before anything is written.
  if (declared && isWrapperPolicy(declared)) {
    return { value: declared, source: "source-html manifest wrapper_policy" };
  }
  return { value: DEFAULT_WRAPPER_POLICY, source: "default" };
}

function prepareBuild(args, options = {}) {
  const specPath = resolve(requireArg(args, "spec"));
  const sourceRoot = resolve(requireArg(args, "source"));
  const targetRepo = resolve(requireArg(args, "target"));
  if (!existsSync(specPath)) throw new Error(`CampaignSpec does not exist: ${specPath}`);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) throw new Error(`Source root is not a directory: ${sourceRoot}`);
  if (!existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) throw new Error(`Target repo is not a directory: ${targetRepo}`);

  const sidecars = campaignSidecarPaths(targetRepo);
  const packetPath = resolve(args.out || join(targetRepo, "campaign-runtime.build.json"));
  const contextPath = resolve(args["context-out"] || sidecars.contextPath);
  const reportPath = resolve(args["report-out"] || sidecars.reportPath);
  const doctorOutPath = resolve(args["doctor-out"] || sidecars.doctorOutPath);
  const briefPath = resolve(args["brief-out"] || join(targetRepo, BUILD_BRIEF_NORMALIZED_REL_PATH));
  const designSourcePackagePath = resolve(targetRepo, DESIGN_SOURCE_PACKAGE_REL_PATH);
  const prepareBuildOutputPaths = [
    ["Build Packet", packetPath],
    ["Build Context", contextPath],
    ["Assembly Report", reportPath],
    ["Doctor Output", doctorOutPath],
    ["Campaign Build Brief", briefPath],
  ];
  const prepareBuildThemeOutputPaths = [
    ["Theme Report", resolve(targetRepo, ".campaign-runtime/theme/theme-report.json")],
    ["Brand Theme CSS", resolve(targetRepo, ".campaign-runtime/theme/brand-theme.css")],
  ];
  const prepareBuildCollisionPaths = [
    ...prepareBuildOutputPaths,
    ...prepareBuildThemeOutputPaths,
    ["Design Source Package", designSourcePackagePath],
  ];
  assertDistinctPrepareBuildOutputPaths(prepareBuildCollisionPaths);
  guardAssemblyReportOverwrite(reportPath, args);
  const spec = readJson(specPath);
  const { mapId, publicRouteSlug, localSpecId } = campaignIdentity(spec, args);
  if (!resolveCampaignIdentity({ map_id: mapId, local_spec_id: localSpecId })) {
    throw new Error("CampaignSpec requires exactly one identity: a saved spec_identity.map_id, or an agent-authored spec_identity.local_spec_id (1–64 letters, digits, underscores or hyphens). Keep the local ID stable across revisions; do not invent a Map ID.");
  }
  if (!publicRouteSlug) throw new Error("CampaignSpec has no public route slug. Set spec_identity.public_route_slug or campaign.slug.");

  // Dispatch validated the argv-only flags before spec resolution. Only the
  // manifest's filesystem check remains here, before preparation writes.
  const sourceKind = options.sourceKind;
  const wrapperPolicyFlag = options.wrapperPolicyFlag;
  const designManifestPath = parseDesignManifestFlag(args);
  const orderPathDepthFlag = options.orderPathDepthFlag;

  const activePages = activeSpecPages(spec);
  const htmlFiles = collectHtmlFiles(sourceRoot);
  const explicitTemplateFamily = optionalString(args["template-family"]);
  const hintedTemplateFamily = preferredTemplateFamily(spec);
  const templateSelection = resolveTemplateFamilySelection({
    flag: explicitTemplateFamily,
    hint: hintedTemplateFamily,
  });
  const templateFamily = templateSelection.value;
  // The Design Source Package builds on the same family the packet locks. It
  // used to take the CampaignSpec hint first, so a --template-family override
  // produced a package whose template-stock TODOs named a family the build
  // would never use ("Link demeter ... " on an olympus-mv-two-step packet).
  const designSourceTemplateFamily = templateFamily;
  const commerceCatalogPath = optionalString(args["commerce-catalog"], defaultCommerceCatalogPath());
  // The toolkit's own catalog is not recorded on the packet (path: null): it
  // ships with every install, so a packet-relative path to this checkout's
  // copy would only be right on the machine that ran prepare-build. An
  // operator-supplied --commerce-catalog inside the campaign repo is recorded
  // relative to the packet, as before.
  const commerceCatalogIsToolkitDefault = resolve(commerceCatalogPath) === resolve(defaultCommerceCatalogPath());
  const commerceCatalog = resolveCommerceCatalog(commerceCatalogPath);
  const templateLocked = Boolean(explicitTemplateFamily) && !isUnresolvedTemplateFamily(templateFamily);
  // Certified-template gate, enforced at the entry point: a decided family
  // must be certified (commerce catalog + brand contract) or the operator
  // must record the uncertified decision explicitly. Failing HERE — before
  // any packet exists — keeps "build on an uncertified template" from ever
  // being a default road.
  const uncertifiedReason = optionalString(args["allow-uncertified-template"]);
  const familyDecided = !isUnresolvedTemplateFamily(templateFamily);
  const familyCertified = familyDecided && isCertifiedTemplateFamily(templateFamily, commerceCatalog);
  if (familyDecided && !familyCertified && !uncertifiedReason) {
    throw new Error(
      `Template family "${templateFamily}" is not certified. Certified families: ${[...certifiedTemplateFamilies(commerceCatalog)].sort().join(", ")}. ` +
      `Pick a certified family, or pass --allow-uncertified-template "<reason>" to record an explicit waiver (deterministic assembly, residue QA, and pricing contracts will not cover the build).`,
    );
  }
  const templateCertification = familyDecided
    ? familyCertified
      ? { certified: true }
      : { certified: false, waiver: { reason: uncertifiedReason, waived_by: optionalString(args["waived-by"], "operator"), waived_at: new Date().toISOString() } }
    : null;
  // Certification freshness (#263), from the vendored catalog snapshot only:
  // say which SDK the family was last verified against and which SDK is
  // current, right where the gate decides. stderr keeps --json stdout clean.
  // The line prints for ANY decided family present on the vendored catalog —
  // including one whose certification was waived via
  // --allow-uncertified-template: freshness is exposure, and a waiver is an
  // explicit certification decision, not a reason to hide what the catalog
  // still records. The waived path is labeled so it can never be mistaken
  // for the certified-gate line.
  if (familyDecided && Object.prototype.hasOwnProperty.call(commerceCatalog?.families || {}, templateFamily)) {
    const freshnessLine = renderTemplateFreshness(assessTemplateFreshness({
      family: templateFamily,
      catalog: commerceCatalog,
      sdkSupportPolicy: defaultSdkSupportPolicy(),
    }));
    const waivedLabel = familyCertified ? "" : "certification waived — ";
    console.warn(`[campaigns-os prepare-build] ${waivedLabel}${freshnessLine}`);
  }
  const templateCandidates = hintedTemplateFamily
    ? [{ family: hintedTemplateFamily, source: "CampaignSpec preferred_template_family", confidence: "hint" }]
    : [];
  const outputDir = optionalString(args["output-dir"], `src/${publicRouteSlug}`);
  const sourceIntake = createSourceHtmlIntake({
    sourceRoot,
    specPages: activePages,
    htmlFiles,
    publicRouteSlug,
    outputDir,
    buildScope: isObject(spec.build_scope) ? spec.build_scope : null,
    manifestPath: designManifestPath,
    templateFamily: familyDecided ? templateFamily : null,
  });
  // An explicit --design-manifest that does not read as a manifest is an
  // error, not the warning-plus-filesystem-fallback the default path gets:
  // nothing has been written yet, and the operator named the file.
  if (designManifestPath && sourceIntake.manifestResult.warning) {
    throw new Error(sourceIntake.manifestResult.warning.replace(/ Falling back to filesystem matching\.$/, ""));
  }
  const declaredScopeSkips = sourceIntake.declaredSkips || [];
  const templateStockPageIds = declaredScopeSkips.map((skip) => skip.page_id).filter(isNonEmptyString);
  const buildScopeReasonsInvalid = isObject(spec.build_scope)
    && spec.build_scope.reasons != null
    && !Array.isArray(spec.build_scope.reasons);
  const manifestResult = sourceIntake.manifestResult;
  const manifestWarnings = sourceIntake.manifestWarnings;
  // Template-family precedence, said out loud. The flag has always beaten the
  // CampaignSpec hint; printing the losing value is what keeps an operator
  // from reading a packet built on the flag as agreement with the spec.
  // stderr keeps --json stdout clean, as with the freshness line above.
  if (templateSelection.overridden) {
    console.warn(
      `[campaigns-os prepare-build] template family "${templateSelection.flag}" selected by ${templateSelection.source}; ` +
      `CampaignSpec preferred_template_family "${templateSelection.hint}" is a hint and was overridden. ` +
      `Recorded on the assembly report as warning ${TEMPLATE_FAMILY_HINT_OVERRIDDEN}.`,
    );
  }
  const wrapperPolicy = resolveWrapperPolicy({ flag: wrapperPolicyFlag, manifest: manifestResult.manifest });
  if (wrapperPolicy.value !== DEFAULT_WRAPPER_POLICY) {
    console.warn(
      `[campaigns-os prepare-build] wrapper_policy "${wrapperPolicy.value}" selected by ${wrapperPolicy.source}; ` +
      `recorded on the packet at source_html.adapter_contract.wrapper_policy.`,
    );
  }
  const matched = {
    mappings: sourceIntake.mappings,
    prompts: sourceIntake.prompts,
    decisions: sourceIntake.decisions,
  };
  for (const warning of manifestWarnings) {
    console.warn(`[campaigns-os prepare-build] ${warning}`);
  }
  // Root-served campaigns: the spec may declare campaign.route_root "/"
  // (whole funnel served from the site root, no slug prefix). Canonicalize at
  // intake and carry only the canonical form onto the packet — the packet
  // schema and validateRouteRootDeclaration accept exactly "/" or
  // "/<public_route_slug>/", so a lenient spec shape ("/<slug>", trailing
  // noise) is normalized here and a foreign prefix fails fast instead of
  // producing a packet doctor will reject later.
  const rawSpecRouteRoot = optionalString(spec.spec_identity?.route_root)
    || optionalString(spec.campaign?.route_root);
  let specRouteRoot = null;
  if (rawSpecRouteRoot) {
    const clean = rawSpecRouteRoot.trim();
    if (clean === "/") specRouteRoot = "/";
    else if (normalizePublicRouteSlug(clean) === publicRouteSlug) specRouteRoot = `/${publicRouteSlug}/`;
    else {
      throw new Error(`CampaignSpec declares route_root ${JSON.stringify(rawSpecRouteRoot)}, which is neither "/" (root-served) nor "/${publicRouteSlug}/" (the public route slug). Fix the spec's route_root or public route slug before assembly.`);
    }
  }
  const liveUrlPath = optionalString(args["live-url-path"], specRouteRoot === "/" ? "/" : `/${publicRouteSlug}/`);
  const themePolicy = optionalString(args["theme-policy"], "inspect_only");
  const portable = (path) => relFromDir(targetRepo, path);
  const commerceZoneFindings = inspectCommerceZones(sourceRoot, htmlFiles);
  const sourceAssetCrawl = crawlSourceAssetPaths({
    sourceRoot,
    htmlFiles,
    pageMappings: matched.mappings,
  });
  const briefDiscovery = inferBuildBriefPath({
    explicitPath: optionalString(args.brief),
    sourceRoot,
    targetRepo,
  });
  const buildBrief = createCampaignBuildBriefArtifact({
    inputPath: briefDiscovery?.path || null,
    inputSource: briefDiscovery?.source || null,
    spec,
    activePages,
    pageMappings: matched.mappings,
    templateFamily,
    sourceAssetCrawl,
    commerceZoneFindings,
  });
  if (buildBrief.inputPath && buildBrief.artifact?._meta) {
    buildBrief.artifact._meta.input_path = relFromFile(briefPath, buildBrief.inputPath);
  }
  const buildBriefPrompts = buildBrief.mode === "prepared" ? [] : buildBrief.questions.map((question) => ({
    code: `BUILD_BRIEF_${toConstantCase(question.id)}`,
    stage: "prepare_build",
    message: question.question,
    detail: {
      field: question.field,
      reason: question.reason,
      options: question.options,
      blocking: question.blocking,
    },
  }));
  const sourceBlockers = matched.prompts.map((prompt) => ({
    code: prompt.code,
    stage: prompt.stage,
    message: prompt.message,
    ...(prompt.page_id ? { page_id: prompt.page_id } : {}),
    ...(prompt.detail ? { detail: prompt.detail } : {}),
  }));
  const briefBlockers = buildBrief.blockers.map((gate) => ({
    code: gate.code,
    stage: "prepare_build",
    message: gate.message,
    field: gate.field || null,
  }));
  const briefQuestionBlockers = buildBrief.mode === "prepared"
    ? buildBrief.questions.map((question) => ({
        code: `BUILD_BRIEF_${toConstantCase(question.id)}`,
        stage: "prepare_build",
        message: question.question,
        field: question.field,
      }))
    : [];
  // Reject deterministic destination failures before publishing the fixed
  // DSP. The DSP intentionally precedes the theme and JSON artifacts that
  // reference it; a later I/O race may therefore leave a valid DSP for a
  // subsequent run to validate and reuse. Never roll it back here because a
  // concurrent prepare may already have consumed its exact bytes.
  preflightPrepareBuildOutputTargets(
    [...prepareBuildOutputPaths, ...prepareBuildThemeOutputPaths],
    prepareBuildCollisionPaths,
  );
  const designSourcePackage = prepareDesignSourcePackage({
    path: designSourcePackagePath,
    activePages,
    mappings: matched.mappings,
    manifestResult,
    sourceAssetCrawl,
    templateFamily: designSourceTemplateFamily,
    templateStockPageIds,
    commerceCatalog,
    sourceRoot,
    mapId,
    publicRouteSlug,
  });
  const designSourceBlockers = designSourcePackageBlockers(designSourcePackage);
  const blockers = [...sourceBlockers, ...briefBlockers, ...briefQuestionBlockers, ...designSourceBlockers];
  const adapterDecisions = createAdapterDecisions({ commerceZoneFindings, wrapperPolicy: wrapperPolicy.value });
  const proofPolicy = createProofPolicy({ orderPathDepth: orderPathDepthFlag });

  const packet = {
    schema_version: PACKET_SCHEMA,
    generated_at: new Date().toISOString(),
    // The kernel version that prepared this packet: the second pin source
    // `tooling status` reads when the project declares no exact devDependency.
    campaigns_os_version: packageVersion(),
    campaign: {
      public_route_slug: publicRouteSlug,
      ...(specRouteRoot ? { route_root: specRouteRoot } : {}),
      campaign_directory: optionalString(args["campaign-directory"], basename(outputDir)),
      live_url_path: liveUrlPath,
      campaigns_app_url: optionalString(args["campaigns-app-url"]),
      api_key_source: optionalString(args["api-key-source"], "env:CAMPAIGNS_API_KEY"),
      allowed_domains_confirmed: args["allowed-domains-confirmed"] === true,
    },
    spec: {
      map_id: mapId,
      ...(localSpecId ? { local_spec_id: localSpecId } : {}),
      spec_url: localSpecId ? null : spec.spec_identity?.spec_url || null,
      local_path: relFromFile(packetPath, specPath),
    },
    design_source_package: designSourcePackage.referenceFor(packetPath),
    source_html: {
      root: relFromFile(packetPath, sourceRoot),
      pages: matched.mappings,
      adapter_contract: cloneJson(adapterDecisions),
    },
    build_brief: {
      schema_version: BUILD_BRIEF_SCHEMA,
      mode: buildBrief.mode,
      status: buildBrief.artifact.status,
      input_path: buildBrief.inputPath ? relFromFile(packetPath, buildBrief.inputPath) : null,
      normalized_path: relFromFile(packetPath, briefPath),
      question_count: buildBrief.questions.length,
      gate_count: buildBrief.gates.length,
    },
    assembly: {
      implementation: "next-campaigns-build",
      target_repo: relFromFile(packetPath, targetRepo),
      output_dir: outputDir,
      template_family: isUnresolvedTemplateFamily(templateFamily) ? "undecided" : templateFamily,
      template_decision_notes: templateLocked
        ? `Template family locked by prepare-build --template-family ${templateFamily}.`
        : hintedTemplateFamily
          ? `CampaignSpec hints ${hintedTemplateFamily}; operator must still lock the template family before commerce wiring.`
          : "Template family must be locked before commerce wiring.",
      template_lock: {
        locked: templateLocked,
        locked_by: templateLocked ? "operator_flag" : null,
        confidence: templateLocked ? "high" : "none",
        evidence: templateLocked ? ["prepare-build --template-family"] : [],
      },
      template_certification: templateCertification,
      commerce_catalog: {
        required: true,
        family: templateLocked ? templateFamily : null,
        version: null,
        path: commerceCatalogIsToolkitDefault ? null : relFromFile(packetPath, commerceCatalogPath),
      },
      compatible_outputs: ["static-html", "campaign-cart-sdk"],
    },
    deploy: {
      target: optionalString(args["deploy-target"], "unknown"),
      preview_url: optionalString(args["preview-url"]),
      production_url: optionalString(args["production-url"]),
      live_url_path: liveUrlPath,
    },
    qa: {
      proof_policy: proofPolicy,
      test_order_policy_notes: "Test Orders use global test cards that bypass the gateway and create no transactions. Run them any time with `qa run --test-order common` for checkout, first-offer accept/decline, and a deduplicated shortest real receipt path when needed (at most four orders). Use `--test-order full` for every actual terminal path in the selected checkout topology; cycles, missing routes, and reachable nonterminals block exhaustive proof before browser launch. Use `--test-order tiers` (or `tiers:common` / `tiers:full`) to drive one strict-selection order per selector tier the CampaignSpec declares on the checkout page, crossed with those path shapes; order-bump rows marked `is_upsell` are add-ons, not tiers, so a three-tier checkout with one bump plans 3 tiers, and `--select-package <ref[:qty],...>` narrows a tiers run to the listed tiers. The default accidental-flood cap is 6, and an overflow names the exact explicit `--max-test-orders` raise and lists the planned paths (up to 40 ids, the remainder counted). That cap bounds planned paths; `--max-order-creations` bounds actual order creations, defaults to the planned path count, and is reserved before each submit. Localhost on any port is a globally allowed Development domain; non-localhost preview/production origins still need SDK origin allowlist confirmation. There is no permission flag: depth is the only control.",
    },
    notes: "Generated by campaigns-os prepare-build. Replace demo refs from CampaignSpec/API before launch.",
  };

  // Everything a rerun of this command needs, as the operator passed it
  // (provenance, not derived state): `next` replays it verbatim when the
  // prepare-build stage blocks. Paths are portable (target-relative) like
  // the rest of the context; a consumer resolves them against the target.
  const specInput = options.specInput || null;
  const intake = {
    spec_source: specInput?.source || "local",
    spec_path: specInput?.source === "local" || !specInput
      ? portable(specPath)
      : null,
    map_id: specInput?.mapId || null,
    proxy_base: specInput?.proxyBase || null,
    saved_map_revision: specInput?.savedMapRevision || null,
    source_root: portable(sourceRoot),
    target_repo: portable(targetRepo),
    template_family: explicitTemplateFamily || null,
    brief_path: optionalString(args.brief) ? portable(resolve(args.brief)) : null,
    design_manifest_path: designManifestPath ? portable(designManifestPath) : null,
    allow_uncertified_template: uncertifiedReason || null,
    wrapper_policy: wrapperPolicyFlag || null,
    packet_path: portable(packetPath),
  };
  const context = {
    schema_version: CONTEXT_SCHEMA,
    generated_at: new Date().toISOString(),
    source_adapter: sourceKind,
    intake,
    status: blockers.length ? "blocked" : "prepared",
    packet_path: portable(packetPath),
    report_path: portable(reportPath),
    design_source_package: designSourcePackage.referenceFor(contextPath),
    spec: {
      path: portable(specPath),
      hash: sha256File(specPath),
      material_hash: specMaterialHash(spec),
      active_pages: activePages.map((page) => ({
        id: page.id,
        type: page.type || null,
        label: page.label || null,
        page_url: publicRouteForPage(page),
      })),
    },
    source: {
      root: portable(sourceRoot),
      html_files: htmlFiles,
      manifest: manifestResult.manifest
        ? {
            path: portable(manifestResult.path),
            schema_version: manifestResult.manifest.schema_version,
            generator: manifestResult.manifest.generator || null,
            generated_at: manifestResult.manifest.generated_at || null,
            campaign_slug: manifestResult.manifest.campaign_slug || null,
            page_count: Array.isArray(manifestResult.manifest.pages) ? manifestResult.manifest.pages.length : 0,
            file_count: Array.isArray(manifestResult.manifest.files) ? manifestResult.manifest.files.length : 0,
            producer_provenance: manifestResult.manifest.producer_provenance || null,
          }
        : null,
      manifest_warnings: manifestWarnings,
      ambiguous_candidates: sourceIntake.ambiguousCandidates,
      manifest_draft: sourceIntake.manifestDraft,
      asset_crawl: sourceAssetCrawl,
    },
    build_brief: {
      schema_version: BUILD_BRIEF_SCHEMA,
      mode: buildBrief.mode,
      status: buildBrief.artifact.status,
      input_path: buildBrief.inputPath ? portable(buildBrief.inputPath) : null,
      normalized_path: portable(briefPath),
      question_count: buildBrief.questions.length,
      gate_count: buildBrief.gates.length,
      questions: buildBrief.questions,
      gates: buildBrief.gates,
    },
    page_map: matched.mappings.map((mapping) => ({
      page_id: mapping.page_id,
      source_path: mapping.path || null,
      skip_reason: mapping.skip_reason || null,
      output_path: mapping.page_kit?.output_path ? portable(resolve(targetRepo, mapping.page_kit.output_path)) : null,
      page_kit: mapping.page_kit || null,
    })),
    scaffold: {
      mode: existsSync(resolve(targetRepo, outputDir)) ? "existing" : "fresh",
      required: !existsSync(resolve(targetRepo, outputDir)),
      target_repo: ".",
      output_dir: portable(resolve(targetRepo, outputDir)),
      handoff_skill: existsSync(resolve(targetRepo, outputDir)) ? "next-campaigns-build" : "next-campaigns-os-setup",
      handoff_artifact: ".campaign-runtime/setup-handoff.json",
      reason: existsSync(resolve(targetRepo, outputDir))
        ? "Target campaign output directory already exists."
        : "Target campaign output directory is missing; scaffold before build.",
    },
    template: {
      family: packet.assembly.template_family,
      locked: templateLocked,
      lock: packet.assembly.template_lock,
      candidates: templateCandidates,
    },
    adapter_decisions: cloneJson(adapterDecisions),
    commerce_zone_findings: commerceZoneFindings,
    prompts_required: [...matched.prompts, ...buildBriefPrompts],
    decisions: matched.decisions,
  };

  const themeInspection = inspectBrandTheme({
    packet,
    packetPath,
    context,
    policy: themePolicy,
    force: args.force === true,
  });
  const shouldWriteThemeCss = themeInspection.context_theme?.generated?.can_auto_generate === true;
  // Inspection can take time, so reject aliases or invalid target types again
  // before publication. The shared theme writer then stages each artifact in
  // its destination directory and atomically replaces the final entry, making
  // a post-preflight symlink or hard-link swap safe without rolling back DSP.
  preflightPrepareBuildOutputTargets(
    prepareBuildThemeOutputPaths,
    prepareBuildCollisionPaths,
  );
  const writtenTheme = writeThemeArtifacts(themeInspection, {
    writeReport: true,
    writeCss: shouldWriteThemeCss,
    force: args.force === true,
    packetPath,
  });
  context.theme = {
    ...themeInspection.context_theme,
    wrote: writtenTheme.wrote,
  };
  if (!writtenTheme.ok && Array.isArray(writtenTheme.errors) && writtenTheme.errors.length > 0) {
    context.theme.warnings = [
      ...(context.theme.warnings || []),
      ...writtenTheme.errors.map((error) => ({ code: error.code, message: error.message, detail: error.detail || null })),
    ];
  }

  // The top-level status/next/blockers are derived from the stages by the same
  // function every later commit of the report runs (stage-ledger.mjs), so
  // prepare-build's first write and a producer's last write spell them alike.
  const report = applyDerivedAssemblyReportSummary(createAssemblyReport({
    packetPath,
    contextPath,
    reportPath,
    specPath,
    sourceRoot,
    sourceKind,
    targetRepo,
    packet,
    context,
    blockers,
    designSourcePackage,
    declaredScopeSkips,
    buildScopeReasonsInvalid,
    templateSelection,
  }));

  publishPrepareBuildJsonOutputs([
    { label: "Build Packet", path: packetPath, value: packet },
    { label: "Campaign Build Brief", path: briefPath, value: buildBrief.artifact },
    { label: "Build Context", path: contextPath, value: context },
    { label: "Assembly Report", path: reportPath, value: report },
  ], prepareBuildCollisionPaths);

  let doctor = null;
  // Housekeeping for the target's git history: the machine-local half of
  // .campaign-runtime/ (sessions, journals, Run Records, caches, evidence)
  // gets an ignore rule the first time a build touches this repo. The
  // readback bundle and handoff inputs stay committable. Best-effort.
  ensureRuntimeStateIgnored(targetRepo);
  if (options.installContext) installAgentContext(targetRepo, false);
  if (options.runDoctor) {
    doctor = doctorPacket(packetPath, { contextPath, reportPath, outputBaseDir: targetRepo });
    // Through the intake's own collision-checked writer, so the sidecar is
    // stamped with the intake command that ran doctor (`start` or `build`,
    // #312) without a second write path for it.
    publishPrepareBuildJsonOutputs([
      { label: "Doctor Output", path: doctorOutPath, value: stampDoctorProducer(doctor, options.command) },
    ], prepareBuildCollisionPaths);
  }

  return {
    packetPath,
    contextPath,
    reportPath,
    doctorOutPath,
    briefPath,
    designSourcePackagePath,
    designSourcePackageMode: designSourcePackage.mode,
    packet,
    context,
    report,
    doctor,
  };
}

export function inspectCommerceZones(sourceRoot, htmlFiles) {
  const findings = [];
  const attrPattern = /\b(data-next-[a-zA-Z0-9-]+)/g;
  const commerceZoneAttrPattern = /\bdata-commerce-zone\s*=\s*["']([^"']+)["']/gi;
  const commerceSlotAttrPattern = /\bdata-commerce-slot\s*=\s*["']([^"']+)["']/gi;
  const sdkOwnedPattern = /sdk-owned|provided\s+by\s+the\s+(?:[a-z0-9-]+\s+)?starter-template\s+sdk\s+contract|provided\s+by\s+the\s+(?:[a-z0-9-]+\s+)?checkout\s+commerce\s+surface/i;
  for (const file of htmlFiles) {
    const content = readFileSync(join(resolve(sourceRoot), file.path), "utf8");
    const lower = content.toLowerCase();
    attrPattern.lastIndex = 0;
    commerceZoneAttrPattern.lastIndex = 0;
    commerceSlotAttrPattern.lastIndex = 0;
    const attrs = [...new Set([...content.matchAll(attrPattern)].map((match) => match[1]))];
    const commerceZones = [
      ...content.matchAll(commerceZoneAttrPattern),
      ...content.matchAll(commerceSlotAttrPattern),
    ].map((match) => match[1]).filter(Boolean);
    const sdkOwnedMarker = sdkOwnedPattern.test(content);
    const sdkOwnedDeclared = sdkOwnedMarker || commerceZones.length > 0;
    const commerceZoneText = commerceZones.join(" ");
    const checkoutCommerceZone = /(checkout|payment|order-summary|summary|cart|submit|shipping)/i.test(commerceZoneText);
    const upsellCommerceZone = /(upsell|downsell)/i.test(commerceZoneText);
    const receiptCommerceZone = /(receipt|thankyou|thank-you)/i.test(commerceZoneText);
    const pathLower = String(file.path || "").toLowerCase();
    const checkoutRuntimeHint = /(^|[/_-])checkout([./_-]|$)/i.test(pathLower)
      || /\bdata-next-checkout(?:=|-)/i.test(content)
      || /\bos-checkout-payment\b/i.test(content)
      || checkoutCommerceZone
      || (sdkOwnedMarker && /(checkout|payment|order-summary|summary|cart|submit|shipping)/i.test(content));
    const upsellRuntimeHint = /(^|[/_-])(up|down)?sell([./_-]|$)/i.test(pathLower)
      || /\bdata-next-(?:up|down)?sell(?:=|-)/i.test(content)
      || upsellCommerceZone
      || (sdkOwnedMarker && /(upsell|downsell)/i.test(content));
    const receiptRuntimeHint = /(^|[/_-])(receipt|thankyou|thank-you)([./_-]|$)/i.test(pathLower)
      || receiptCommerceZone
      || (sdkOwnedMarker && /(receipt|thankyou|thank-you)/i.test(content));
    const requiresTemplateShell = sdkOwnedDeclared && (checkoutRuntimeHint || upsellRuntimeHint || receiptRuntimeHint);
    const zones = [];
    if (checkoutRuntimeHint) zones.push("checkout");
    if (checkoutRuntimeHint && (lower.includes("payment") || lower.includes("card number"))) zones.push("payment");
    if (upsellRuntimeHint) zones.push("upsell");
    if (receiptRuntimeHint) zones.push("receipt");
    if (attrs.length > 0) zones.push("sdk_attributes");
    if (commerceZones.length > 0) zones.push("commerce_zones");
    if (sdkOwnedDeclared) zones.push("sdk_owned_declared");
    if (zones.length > 0) {
      findings.push({
        path: file.path,
        zones: [...new Set(zones)],
        commerce_zones: [...new Set(commerceZones)],
        sdk_owned_declared: sdkOwnedDeclared,
        requires_template_shell: requiresTemplateShell,
        sdk_attributes: attrs,
        action: requiresTemplateShell
          ? "adopt_selected_template_family_shell_before_assembly"
          : "review_and_preserve_catalog_surfaces",
      });
    }
  }
  return findings;
}

function assemblyThemeFromContext(theme) {
  if (!isObject(theme)) return null;
  const warnings = Array.isArray(theme.warnings) ? theme.warnings : [];
  const canApply = theme.generated?.can_generate === true && theme.generated?.stale?.stale !== true;
  const wroteCss = theme.wrote?.css === true;
  return {
    status: theme.status === "blocked"
      ? "blocked"
      : canApply || wroteCss
        ? "needs_review"
        : "skipped",
    css_path: wroteCss || canApply ? theme.generated?.css_path || null : null,
    load_order: "unknown",
    commerce_pages: [],
    evidence: wroteCss
      ? ["prepare-build auto-generated .campaign-runtime/theme/brand-theme.css; build should copy that existing artifact into campaign assets and load it after next-core.css on commerce pages."]
      : theme.generated?.can_generate
        ? ["theme inspect found a generatable brand theme; run theme generate or explicit auto policy before applying."]
        : ["theme inspect completed; no generated brand theme was applied during prepare-build."],
    warnings,
    repair_loop_defect: null,
  };
}

function createAssemblyReport({
  packetPath,
  contextPath,
  reportPath,
  specPath,
  sourceRoot,
  sourceKind,
  targetRepo,
  packet,
  context,
  blockers,
  designSourcePackage,
  declaredScopeSkips = [],
  buildScopeReasonsInvalid = false,
  templateSelection = null,
}) {
  const scaffoldRequired = context.scaffold.required;
  const portable = (path) => relFromDir(targetRepo, path);
  return {
    schema_version: REPORT_SCHEMA,
    run_id: `asm_${Date.now()}`,
    generated_at: new Date().toISOString(),
    // status, blockers and next are restated from the stages by
    // applyDerivedAssemblyReportSummary before the report is written; the
    // seeds here only keep the schema's required keys in their usual order.
    status: "prepared",
    identity: {
      map_id: packet.spec.map_id,
      ...localSpecIdentityFields(packet.spec),
      public_route_slug: packet.campaign.public_route_slug,
      campaign_directory: packet.campaign.campaign_directory,
      live_url_path: packet.campaign.live_url_path,
      spec_hash: sha256File(specPath),
      spec_material_hash: context.spec.material_hash,
    },
    inputs: {
      packet_path: portable(packetPath),
      context_path: portable(contextPath),
      build_brief_path: context.build_brief?.normalized_path || null,
      spec_path: portable(specPath),
      source: { kind: sourceKind, root: portable(sourceRoot) },
      target_repo: ".",
    },
    template_family: {
      value: packet.assembly.template_family,
      locked: packet.assembly.template_lock.locked,
      locked_by: packet.assembly.template_lock.locked_by,
      commerce_catalog_version: null,
      candidates: context.template.candidates,
    },
    stages: createInitialAssemblyReportStages({
      scaffoldRequired,
      blockers,
      declaredScopeSkips,
      outputs: [
        portable(packetPath),
        portable(contextPath),
        context.build_brief?.normalized_path,
        portable(designSourcePackage.path),
        portable(reportPath),
      ].filter(Boolean),
    }),
    decisions: context.decisions,
    build_brief: cloneJson(context.build_brief || {}),
    design_source_package: designSourcePackage.referenceFor(reportPath),
    adapter_decisions: cloneJson(context.adapter_decisions || createAdapterDecisions()),
    proof_policy: cloneJson(packet.qa?.proof_policy || createProofPolicy()),
    theme: assemblyThemeFromContext(context.theme),
    evidence: [],
    blockers,
    warnings: [
      ...(templateSelection?.overridden
        ? [{
            code: TEMPLATE_FAMILY_HINT_OVERRIDDEN,
            stage: "prepare_build",
            message: `Template family "${templateSelection.flag}" came from ${templateSelection.source} and overrode the CampaignSpec preferred_template_family hint "${templateSelection.hint}". The flag wins by design; re-run without --template-family to build on the spec hint, or update the spec so the two agree.`,
          }]
        : []),
      ...(buildScopeReasonsInvalid
        ? [{
            code: "SOURCE_SCOPE_REASONS_IGNORED",
            stage: "prepare_build",
            message: "CampaignSpec build_scope.reasons is not an array and was ignored; declared out-of-scope pages carry the generic partial-scope reason. Make build_scope.reasons a string array to record the real reasons.",
          }]
        : []),
      ...(declaredScopeSkips.length
        ? [{
            code: "SOURCE_SCOPE_PARTIAL",
            stage: "prepare_build",
            message: `Partial source scope: ${declaredScopeSkips.length} active CampaignSpec page(s) are declared out of source scope and assemble from the template family: ${declaredScopeSkips.map((skip) => skip.page_id).join(", ")}.`,
          }]
        : []),
      ...(context.source?.ambiguous_candidates?.length
        ? [{
            code: "AMBIGUOUS_SOURCE_HTML_CANDIDATES",
            stage: "prepare_build",
            message: `Source HTML filename fallback found ambiguous candidates: ${context.source.ambiguous_candidates.map((entry) => `${entry.page_id}: ${(entry.candidates || []).map((candidate) => candidate.path).join(", ")}`).join("; ")}. Write .campaigns-os/source-html-manifest.json from context.source.manifest_draft, choosing the intended candidate paths before build.`,
            sample: context.source.ambiguous_candidates.map((entry) => `${entry.page_id}: ${(entry.candidates || []).map((candidate) => candidate.path).join(", ")}`),
          }]
        : []),
      ...(context.commerce_zone_findings.length
        ? [{ code: "SOURCE_COMMERCE_REVIEW", stage: "assembly", message: "Source HTML contains possible commerce zones. Preserve catalog-owned runtime surfaces." }]
        : []),
      ...(context.build_brief?.mode === "guided_draft" && context.build_brief?.question_count > 0
        ? [{ code: "BUILD_BRIEF_GUIDED_QUESTIONS", stage: "prepare_build", message: `Generated Campaign Build Brief draft has ${context.build_brief.question_count} high-impact question(s) to confirm before first-shot assembly.` }]
        : []),
      ...sourceAssetWarningsForReport(context.source?.asset_crawl),
    ],
    next: null,
  };
}

function sourceAssetWarningsForReport(assetCrawl) {
  const warnings = Array.isArray(assetCrawl?.warnings) ? assetCrawl.warnings : [];
  return warnings.map((warning) => ({
    code: sourceAssetReportWarningCode(warning.code),
    stage: "assembly",
    message: warning.message,
    sample: warning.sample || [],
  }));
}

function sourceAssetReportWarningCode(code) {
  if (code === "source_asset.root_assets_path") return "SOURCE_ASSET_REWRITE";
  if (code === "source_asset.outside_source_root") return "SOURCE_ASSET_ESCAPE";
  if (code === "source_asset.missing_file") return "SOURCE_ASSET_MISSING";
  if (typeof code === "string" && code.startsWith("source_asset.")) {
    return `SOURCE_ASSET_${toConstantCase(code.slice("source_asset.".length))}`;
  }
  return "SOURCE_ASSET_WARNING";
}

function toConstantCase(value) {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || "WARNING";
}

// The producer names the four sidecar writers stamp (#312). A producer
// function that is one command states its own; the intake body, which
// serves three, receives the dispatched command (`start` | `build`).
const DOCTOR_PRODUCER = "doctor";
const NEXT_PRODUCER = "next";
const QA_RUN_PRODUCER = "qa run";

export function doctorCommand(args, { runDoctor = doctorPacket } = {}) {
  // Non-packet mode (learnings L7): doctor a `campaign-build`'d page-kit
  // campaign that has only a built _site/ and no full Build Packet. Resolves
  // scope from the built output and runs the built-output residue/text/
  // demo-asset/pricing gates against the chosen family's brand contract.
  const builtArg = args.built || args.site;
  if (builtArg && !args.packet) {
    return doctorBuiltOutput(args);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const explicitSidecarArgs = Boolean(args.context || args.report);
  const doctorOptions = {
    contextPath: args.context ? resolve(args.context) : explicitSidecarArgs ? null : undefined,
    reportPath: args.report ? resolve(args.report) : explicitSidecarArgs ? null : undefined,
    outputBaseDir: args["strip-paths"] === true ? dirname(packetPath) : null,
  };
  const result = runDoctor(packetPath, doctorOptions);
  // Inspection and recording are separate operations. A laptop's untracked
  // built output can be stale while the delivered build's evidence is valid.
  // Only an explicit producer action may replace the retained proof artifacts;
  // --no-write wins if both flags are supplied.
  if (args.write === true && args["no-write"] !== true) {
    // The stage write-back restates the outcome into the report the
    // inspection read: the one --report named, else the one the Build Context
    // binds (`derived.assembly_report_path`, a `prepare-build --report-out`
    // campaign's report), else the default location. Following the binding is
    // what keeps the doctor stage on a bound report current; a report of
    // another campaign is still refused by commitAssemblyReport's identity
    // check, so the outcome never lands in another run's evidence. The
    // sidecar itself goes under the target repo, where prepare-build, next
    // and the QA stage refresh write it — not beside the packet.
    const inspectedReportPath = optionalString(result.derived?.assembly_report_path);
    const workspace = resolveCampaignWorkspace(packetPath, {
      reportPath: args.report
        ? resolve(args.report)
        : inspectedReportPath
          ? resolve(dirname(packetPath), inspectedReportPath)
          : undefined,
      doctorOutPath: args["doctor-out"] ? resolve(args["doctor-out"]) : undefined,
      followContextPointer: false,
    });
    // The sidecar is this inspection's result, written whether or not the
    // report gained a new chapter (a re-run restating the outcome already on
    // disk leaves the report's bytes, and every digest of them, alone). A
    // report this inspection did not read is not opened at all: its state,
    // malformed included, is not this run's concern.
    // This function is the `doctor` command; it states its own name for the
    // stage record and the sidecar's generated_by rather than re-reading
    // argv, which a programmatic caller may not have shifted (#312).
    commitAssemblyReport(workspace, (report) => recordDoctorStageOutcome(report, result, {
      command: `campaigns-os ${DOCTOR_PRODUCER}`,
      doctorOutPath: workspace.doctorOutPath,
    }), { stage: "doctor", command: DOCTOR_PRODUCER, refreshDoctor: () => result });
  }
  return result;
}

function recordDoctorStageOutcome(report, result, { command, doctorOutPath }) {
  return recordProducerStageOutcome(report, {
    stage: "doctor",
    disposition: result.ok ? (result.warnings?.length ? "ready_with_warnings" : "ready") : "blocked",
    timestamp: result.generated_at,
    command,
    outputs: [doctorOutPath],
    blockers: (result.errors || []).map((issue) => issue?.message).filter(isNonEmptyString),
    warnings: (result.warnings || []).map((issue) => issue?.message).filter(isNonEmptyString),
  });
}


// L7 non-packet doctor: resolve scope from a built _site/, run the built-output
// gates the family brand contract drives, and auto-emit a minimal Build Packet
// (optionally written with --emit-packet) so QA can run against the same
// campaign without a hand-authored packet.
export function doctorBuiltOutput(args) {
  const targetRepo = resolve(String(args.built || args.site));
  const errors = [];
  const warnings = [];
  const ready = [];
  if (!existsSync(targetRepo) || !statSync(targetRepo).isDirectory()) {
    addIssue(errors, "built_site.target", `Built campaign directory does not exist: ${targetRepo}`);
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site" }, next: null };
  }

  const scope = resolveBuiltSiteScope(targetRepo, { slug: optionalString(args.slug) });
  if (!scope.ok) {
    addIssue(errors, "built_site.scope", scope.error || "Could not resolve scope from the built _site/.");
    return { ok: false, status: "blocked", mode: "built_site", errors, warnings, ready, derived: { mode: "built_site", scope }, next: null };
  }

  const family = optionalString(args.family) || null;
  const baseUrl = optionalString(args["base-url"]);
  const mapId = optionalString(args["map-id"]);
  const deployTarget = optionalString(args["deploy-target"], "unknown");

  const derived = {
    mode: "built_site",
    map_id: mapId || scope.slug || null,
    public_route_slug: scope.slug || null,
    template_family: family,
    target_repo: targetRepo,
    target_output_dir: scope.campaign_dir,
    site_root: scope.site_root,
    built_pages: scope.pages.map((page) => ({ page_id: page.page_id, type: page.page_type, route: page.route })),
    doctor_checks: [],
    checkpoint_gates: [],
  };
  ready.push(`Resolved ${scope.html_count} built page(s) from ${relFromDir(targetRepo, scope.campaign_dir)} (slug "${scope.slug || "(site root)"}")`);

  const resolution = resolveBrandContractOnce(derived, family);
  let brandContract = null;
  if (!family) {
    addIssue(warnings, "assembly.template_family", "No --family given; the residue/placeholder-text/demo-asset gates need a family brand contract to run. Pass --family <family> (the family the campaign was built from).");
  } else {
    reportBrandContractDefectOnce(resolution, warnings, family);
    brandContract = resolution.contract;
    if (!brandContract) {
      addIssue(warnings, "template_contract.brand_contract", `No brand/residue/pricing contract found for family "${family}". Built-output residue gates cannot run; confirm the family slug.`);
    } else {
      ready.push(`Template brand/residue/pricing contract loaded for ${family}`);
      validateBuiltPlaceholderTextResidue(brandContract, warnings, ready, derived);
      validateBuiltDemoAssetFidelity(brandContract, warnings, ready, derived);
      // Pricing CSS-hide scan (report omitted -> a missing assets/css dir reads
      // as a skipped ready-line, not a false "scan did not run" warning, since
      // built page-kit output may lay CSS out differently).
      runPricingCssHideCheck({ packet: { assembly: { template_family: family } }, derived, warnings, ready, report: null });
    }
  }

  // Family-agnostic generic placeholder residue (XXCODE / Product Title /
  // next-logo.png ...) always runs against the built output.
  const genericHits = collectGenericTemplateResidueMatches(scope.campaign_dir);
  if (genericHits.length) {
    addIssue(
      warnings,
      "template_contract.literal_residue",
      `Built output contains generic starter/template placeholders: ${summarizeCopyMatches(genericHits)}. Replace these from CampaignSpec/API or remove dead template references.`,
    );
  } else {
    ready.push("Built output has no generic starter placeholder or promo-code residue");
  }

  // Upsell selector scope (#270). Deliberately outside the family/brand-contract
  // branch above: the defect is family-independent, and this mode is reached
  // without --family more often than with it. Page roles come from the built
  // route (resolveBuiltSiteScope infers them) and from each page's own
  // next-page-type meta, so no packet or spec is needed. No assembly report
  // exists on this path, so there are no waivers to assess — a blocker here is
  // repaired in the source, or waived through the packet path.
  recordUpsellSelectorScopeGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: scope.pages.map((page) => ({
      page_id: page.page_id,
      page_type: page.page_type,
      file: relFromDir(targetRepo, page.built_path),
      content: readFileSync(page.built_path, "utf8"),
    })),
    waivers: null,
    errors,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(UPSELL_SELECTOR_SCOPE);

  // Cross-page campaign identity (#301). Same placement and the same reasons:
  // family-independent, needs no packet, and the borrowed-page defect it gates
  // is most often introduced on exactly the page-kit campaigns this path
  // inspects.
  recordCampaignIdentityGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: collectBuiltPageIdentityInputs(scope, targetRepo),
    errors,
    ready,
    derived,
  });
  derived.doctor_checks.push(CAMPAIGN_IDENTITY);

  // Static SDK markup checks (#303). Same placement, same reasons.
  recordSdkMarkupGate({
    subject: {
      public_route_slug: scope.slug || null,
      site_root: relFromDir(targetRepo, scope.campaign_dir),
    },
    pages: collectBuiltPageIdentityInputs(scope, targetRepo),
    errors,
    warnings,
    ready,
    derived,
  });
  derived.doctor_checks.push(SDK_MARKUP);

  const synthesized = synthesizeMinimalBuildPacket({
    schemaVersion: PACKET_SCHEMA,
    targetRepo,
    scope,
    family,
    mapId,
    baseUrl,
    deployTarget,
  });
  derived.synthesized_packet = synthesized;

  let emittedPacketPath = null;
  if (args["emit-packet"]) {
    emittedPacketPath = args["emit-packet"] === true
      ? join(targetRepo, ".campaign-runtime", "minimal-build-packet.json")
      : resolve(String(args["emit-packet"]));
    mkdirSync(dirname(emittedPacketPath), { recursive: true });
    writeJson(emittedPacketPath, synthesized);
    ready.push(`Emitted minimal Build Packet to ${relFromDir(targetRepo, emittedPacketPath)}`);
  }

  const next = buildNextStep(errors, warnings, derived, null);
  const status = errors.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
  return {
    ok: errors.length === 0,
    status,
    mode: "built_site",
    errors,
    warnings,
    ready,
    derived,
    scope: { slug: scope.slug, html_count: scope.html_count, pages: derived.built_pages, campaign_dir: scope.campaign_dir },
    synthesized_packet: synthesized,
    emitted_packet_path: emittedPacketPath,
    next,
  };
}

// Read + parse an injectable contract passed as a --flag <path> to JSON.
// Returns null when the flag is absent; throws a clear error when the file is
// missing or unparseable so an operator sees exactly which flag failed.
function readContractFlag(args, flag) {
  const path = optionalString(args[flag]);
  if (!path) return null;
  const resolved = resolve(path);
  let raw;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Could not read --${flag} file ${resolved}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse --${flag} JSON at ${resolved}: ${error.message}`);
  }
}

// Every flag `standardize` reads, plus the two flags any command accepts
// (run session + lifecycle journal). Anything else is refused up front: the
// parser stores an unknown token as a key and the run would otherwise proceed
// as if the flag had never been typed.
const STANDARDIZE_FLAGS = [
  "target",
  "family",
  "template-family",
  "slug",
  "sdk-support-policy",
  "field-contract",
  "no-doctor",
  "json",
  "run-id",
  "lifecycle-journal",
];

function rejectUnknownStandardizeFlags(args) {
  const known = new Set(STANDARDIZE_FLAGS);
  const unknown = Object.keys(args).filter((key) => key !== "_" && !known.has(key));
  if (!unknown.length) return;
  const valueHint = unknown.some((key) => key.includes("="))
    ? " A flag takes its value as the next argument (--flag value), not --flag=value."
    : "";
  throw refused(
    `Unknown flag${unknown.length > 1 ? "s" : ""} for standardize: ${unknown.map((key) => `--${key}`).join(", ")}.${valueHint} Known flags: ${STANDARDIZE_FLAGS.map((key) => `--${key}`).join(", ")}.`,
  );
}

function standardizationReportCommand(args) {
  rejectUnknownStandardizeFlags(args);
  const target = optionalString(args.target);
  if (!target) {
    throw refused("standardize requires --target <campaign-repo> (a Page Kit root, a parent repo, or a Campaign Cart application checkout).");
  }
  const family = optionalString(args.family) || optionalString(args["template-family"]);
  const slug = optionalString(args.slug);
  const sdkSupportPolicy = readContractFlag(args, "sdk-support-policy");
  const fieldContract = readContractFlag(args, "field-contract");
  const report = createStandardizationReport({
    targetRepo: resolve(target),
    slug,
    templateFamily: family,
    sdkSupportPolicy,
    fieldContract,
  });
  if (args["no-doctor"] === true) {
    for (const root of report.roots || []) {
      if (root.built_output?.present) {
        root.built_output.doctor = { status: "skipped", reason: "--no-doctor was provided" };
      }
    }
    return report;
  }
  for (const root of report.roots || []) {
    if (!root.built_output?.present || !root.built_output?.html_count) continue;
    const inferredFamily = optionalString(root.identity?.template_family?.value);
    if (!inferredFamily) {
      root.built_output.doctor = { status: "skipped", reason: "template family unknown" };
      continue;
    }
    if (root.identity?.template_family?.confidence === "tentative") {
      root.built_output.doctor = { status: "skipped", reason: "template family tentative" };
      continue;
    }
    try {
      const doctor = doctorBuiltOutput({
        built: root.identity.page_kit_root,
        family: inferredFamily,
        slug: slug || root.built_output.slug || undefined,
      });
      attachBuiltOutputDoctor(report, root.id, doctor);
    } catch (error) {
      attachBuiltOutputDoctor(report, root.id, {
        ok: false,
        status: "blocked",
        mode: "built_site",
        errors: [{ code: "built_site.doctor_exception", message: error.message }],
        warnings: [],
        ready: [],
      });
    }
  }
  return report;
}

function themeCommand(args) {
  const subcommand = args._[1] || "inspect";
  if (!["inspect", "generate", "waive"].includes(subcommand)) {
    throw refused(`Unknown theme subcommand "${subcommand}". Use: inspect | generate | waive.`);
  }
  if (subcommand === "waive") return themeWaive(args);
  const packetPath = resolve(requireArg(args, "packet"));
  const packet = readJson(packetPath);
  const context = readJsonIfExists(args.context ? resolve(args.context) : null);
  const policy = optionalString(args["theme-policy"], subcommand === "generate" ? "auto" : "inspect_only");
  const inspection = inspectBrandTheme({
    packet,
    packetPath,
    context,
    policy,
    outDir: args["out-dir"] === true ? null : args["out-dir"],
    force: args.force === true,
  });
  if (subcommand === "inspect") return { ...inspection, css: undefined };
  const written = writeThemeArtifacts(inspection, {
    writeReport: true,
    writeCss: true,
    force: args.force === true,
    packetPath,
  });
  // #171: generated theme artifacts change what doctor's theme gate would
  // conclude; the retained doctor sidecar (if any) now predates them. Only
  // when something was actually written — a failed or no-op generation
  // (blocked, already-current CSS) leaves doctor's inputs untouched (Kilo
  // review, PR #176).
  if (written.wrote?.report || written.wrote?.css) {
    markDoctorSidecarStale(resolveFromFile(packetPath, packet?.assembly?.target_repo) || dirname(packetPath), {
      command: "theme generate",
      reason: `Theme artifacts were generated after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
    });
  }
  return { ...written, css: undefined };
}

// `theme waive`: the ONLY sanctioned way to ship commerce pages without a
// generatable brand layer. Records who/why/when on the assembly report so the
// theme gate (next/doctor/qa) reads one explicit decision instead of an agent
// improvising past advisory prose.
export function themeWaive(args) {
  const packetPath = resolve(requireArg(args, "packet"));
  const dryRun = isDryRun(args);
  const packet = readJson(packetPath);
  const reason = optionalString(args.reason);
  // A missing flag, raised after reading nothing but argv and the packet: a
  // refusal, so the journal records nothing for it (docs/effects.md `*refused*`).
  if (!reason) throw refused("theme waive requires --reason \"<why the starter palette is acceptable for this campaign>\".");
  // The same attribution rule as `checkpoint waive`: a named human, no
  // placeholder, an expiry (when given) that lies in the future and is
  // recorded. A bound is not demanded here: the theme gate's waiver has always
  // been open-ended, and QA re-surfaces the starter palette on every run.
  // A shared validator of argv alone, still ahead of the report read: its
  // throws are refusals at this call site (the position decides, not the file).
  const waiver = refusing(() => validateWaiverAttribution({
    reason,
    waivedBy: args["waived-by"] == null ? null : String(args["waived-by"]),
    expiresAt: args["expires-at"] == null ? null : String(args["expires-at"]),
    requireBound: false,
    label: "theme waive",
  }));
  const workspace = resolveCampaignWorkspace(packetPath, {
    packet,
    reportPath: args.report ? resolve(args.report) : undefined,
    followContextPointer: false,
  });
  const { reportPath } = workspace;
  if (!existsSync(reportPath)) throw new Error(`theme waive needs an assembly report at ${reportPath}; run prepare-build/start first.`);
  const recordWaiver = (report) => {
    report.theme = report.theme && isObject(report.theme)
      ? { ...report.theme, waiver }
      : { status: "skipped", css_path: null, load_order: "not-applied", commerce_pages: [], evidence: [], warnings: [], repair_loop_defect: null, waiver };
    report.theme.evidence = [
      ...(Array.isArray(report.theme.evidence) ? report.theme.evidence : []),
      `Theme gate waived by ${waiver.waived_by} at ${waiver.waived_at}: ${reason}`,
    ];
    return report;
  };
  // Every check above is the real command's; only the commit is skipped. The
  // readiness block is not reported for a dry run because doctor reads it off
  // the report on disk, which by construction still has no waiver on it.
  //
  // Both modes go through the committing path itself (see
  // commitWaiverToAssemblyReport): the dry run used to return on the existsSync
  // check alone, so a torn report was reported as a successful `would_write`
  // with exit 0 while the real invocation refused with "Assembly Report ... is
  // not valid JSON" and exit 1, and a report that is not an object was previewed
  // as writable while the commit refused it. Validation must never be weaker
  // under --dry-run than without it.
  commitWaiverToAssemblyReport(workspace, recordWaiver, {
    // #171: the waiver changes what doctor would conclude; the retained doctor
    // sidecar (if any) now predates it.
    command: "theme waive",
    staleReason: `A theme-gate waiver was recorded after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
  }, { dryRun });
  if (dryRun) {
    return {
      ok: true,
      status: "dry_run",
      dry_run: true,
      action: "theme-waive",
      gate: "theme_gate",
      waiver,
      report_path: reportPath,
      would_write: reportPath,
      note: "Dry run: nothing was written and the doctor sidecar was not marked stale. Re-run without --dry-run to record this waiver.",
    };
  }
  return {
    ok: true,
    ...waiveReadiness(packetPath, reportPath),
    action: "theme-waive",
    gate: "theme_gate",
    waiver,
    report_path: reportPath,
    note: "The theme gate now reports waived for this campaign. Browser QA still runs template-residue checks at warn severity so the shipped palette stays visible in the verdict.",
  };
}

// The readiness a waive command reports: doctor's verdict on the report the
// waiver was just written to, so the text line reads `Status: READY_WITH_
// WAIVERS` (or BLOCKED, when other gates still hold) instead of the printer's
// "unknown" fallback. Doctor is re-run rather than patched from the pre-waive
// result because a waiver changes what every other gate concludes about the
// stage. Nothing is persisted here; the sidecar was already marked stale.
/**
 * The one route both waive commands take to the Assembly Report, real or
 * previewed. `commitAssemblyReport` is called identically in both modes — same
 * workspace, same mutator, same options — so every check the committing path
 * makes runs on both: the report must exist, it must parse (a torn one fails by
 * name), the mutator's own refusals fire, its result must be an Assembly Report
 * object, and the derived summary is restated over that result. A dry run
 * differs in one statement: this wrapper — not the mutator — returns `null` to
 * commitAssemblyReport, which is its "nothing to write" answer, so the report
 * is not rewritten and the doctor sidecar is not stamped stale. Nothing is
 * re-implemented and nothing is skipped but the write itself. A mutator that
 * returns nothing does not get to borrow that sentinel: it is a bug, and it
 * throws here on both paths.
 *
 * The result-shape check and the summary restatement sit here rather than being
 * left to commitAssemblyReport alone because they must run in BOTH modes and
 * commitAssemblyReport reaches its own copies only on the way to the write.
 * Running them here means one message and one order, not two: the real path
 * now fails on this line and never on the copy in stage-ledger.mjs, so the two
 * cannot drift into different text.
 */
export function commitWaiverToAssemblyReport(workspace, mutate, options, { dryRun = false } = {}) {
  const previewOrCommit = (report) => {
    const mutated = mutate(report);
    // null and undefined are refused here rather than forwarded. Both waive
    // mutators always return the report they built, and commitAssemblyReport
    // reads a null result as "nothing to write" — so a mutator that forgot to
    // return would skip the write silently while the command still reported the
    // waiver recorded. That is a bug in the mutator and fails loudly. The dry
    // run's own "do not write" is this wrapper's null below, not the mutator's.
    if (!isPlainObject(mutated)) throw new TypeError("commitAssemblyReport mutate(report) must return an Assembly Report object.");
    if (!dryRun) return mutated;
    applyDerivedAssemblyReportSummary(mutated);
    return null;
  };
  return commitAssemblyReport(workspace, previewOrCommit, options);
}

function waiveReadiness(packetPath, reportPath) {
  const doctor = doctorPacket(packetPath, { reportPath });
  return { status: doctor.status, next_stage: doctor.next?.stage || null, next_stage_reason: doctor.next?.reason || null };
}

function requireValidPolishCaptureReport(report, reportPath) {
  // Shape only. `polish capture` produces page-load evidence on a report the
  // polish gate evaluates on the way out, so the source-freshness findings
  // belong to that gate and must not turn capture into a second, earlier
  // refusal of a report the gate would already stop.
  const validation = validateAssemblyReport(report, { checkSourcePackageFreshness: false });
  if (validation.ok) return report;
  const codes = validation.errors.map((issue) => issue?.code).filter(Boolean).slice(0, 8);
  throw new Error(
    `polish capture requires a valid existing Assembly Report at ${reportPath}`
    + `${codes.length ? ` (${codes.join(", ")})` : ""}.`,
  );
}

export async function polishCaptureCommand(args, options = {}) {
  const subcommand = args?._?.[1] || "help";
  if (subcommand !== "capture") {
    throw refused(
      `Unknown polish subcommand. Use: ${cmd("polish")} capture --packet <campaign-runtime.build.json> --base-url <url> [--report <json>] [--headed] [--auth-cookie <cookie>] [--json].`,
    );
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const baseUrl = requireArg(args, "base-url");
  if (args.report === true) throw refused("Missing value for --report");
  if (args["auth-cookie"] === true) throw refused("Missing value for --auth-cookie");

  const packet = readJson(packetPath);
  const workspace = resolveCampaignWorkspace(packetPath, {
    packet,
    reportPath: args.report ? resolve(args.report) : undefined,
    followContextPointer: false,
  });
  const { targetRepo, reportPath } = workspace;
  if (!isLocalAbsolutePath(targetRepo)) {
    throw new Error("polish capture requires packet.assembly.target_repo to resolve to a local target repo.");
  }
  const report = readJsonIfExists(reportPath);
  if (!report) {
    throw new Error(`polish capture needs an existing Assembly Report at ${reportPath}; run prepare-build/start first.`);
  }
  requireValidPolishCaptureReport(report, reportPath);
  const plan = planPolishCapture({ packet, baseUrl });
  const initialBinding = createPolishCaptureBinding({
    packet,
    report,
    plan,
    packetPath,
    targetRepo,
  });

  let createBrowserAdapter = options.createBrowserAdapter;
  if (typeof createBrowserAdapter !== "function") {
    ({ createPolishBrowserAdapter: createBrowserAdapter } = await import("./polish-browser.mjs"));
  }
  const capture = await capturePolishPageLoad({
    packet,
    report,
    baseUrl,
    headed: args.headed === true,
    authCookie: optionalString(args["auth-cookie"]),
    createBrowserAdapter,
    adapterStartupDeadlineMs: options.adapterStartupDeadlineMs,
    captureCellDeadlineMs: options.captureCellDeadlineMs,
    adapterCloseDeadlineMs: options.adapterCloseDeadlineMs,
  });

  if (typeof options.afterCapture === "function") {
    await options.afterCapture({ packetPath, reportPath, targetRepo, capture });
  }

  // The browser pass is deliberately long-running. Re-read both governing
  // artifacts once it finishes, then merge only onto the current report when
  // the bound state and prior page_load token still match.
  const currentPacket = readJson(packetPath);
  let checkpoint = null;
  commitAssemblyReport(workspace, (currentReport) => {
    requireValidPolishCaptureReport(currentReport, reportPath);
    const currentPlan = planPolishCapture({ packet: currentPacket, baseUrl });
    const currentBinding = createPolishCaptureBinding({
      packet: currentPacket,
      report: currentReport,
      plan: currentPlan,
      packetPath,
      targetRepo,
    });
    assertPolishCaptureBindingUnchanged(initialBinding, currentBinding);

    const merged = mergePolishPageLoadEvidence(currentReport, capture.page_load);
    checkpoint = evaluateRecordedHiddenEagerMediaCheckpoint({
      packet: currentPacket,
      report: merged,
    });
    return merged;
  }, {
    command: "polish capture",
    staleReason: `Package-owned polish page-load evidence changed after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
  });

  const ok = checkpoint.status === "pass" || checkpoint.status === "waived";
  return {
    ok,
    status: ok ? (checkpoint.status === "waived" ? "ready_with_waivers" : "ready") : "blocked",
    action: "polish-capture",
    report_path: reportPath,
    measurement: capture.page_load.measurement,
    checkpoint,
    observed_findings: capture.page_load.findings,
    capture: {
      route_scope: capture.plan.route_scope,
      routes: capture.plan.routes.map((route) => route.requested_route),
      viewports: capture.plan.viewports.map((viewport) => viewport.key),
    },
  };
}

const CHECKPOINT_EVALUATORS = createCheckpointRegistry([
  {
    id: PAGE_KIT_SDK_VERSION_SCOPE,
    evaluate: ({ doctor }) => (Array.isArray(doctor?.derived?.checkpoint_gates)
      ? doctor.derived.checkpoint_gates.find((gate) => gate?.id === PAGE_KIT_SDK_VERSION_SCOPE) || null
      : null),
  },
  {
    id: PAGE_KIT_STORE_PROFILE_SCOPE,
    evaluate: ({ doctor }) => (Array.isArray(doctor?.derived?.checkpoint_gates)
      ? doctor.derived.checkpoint_gates.find((gate) => gate?.id === PAGE_KIT_STORE_PROFILE_SCOPE) || null
      : null),
  },
  {
    id: UPSELL_SELECTOR_SCOPE,
    evaluate: ({ doctor }) => (Array.isArray(doctor?.derived?.checkpoint_gates)
      ? doctor.derived.checkpoint_gates.find((gate) => gate?.id === UPSELL_SELECTOR_SCOPE) || null
      : null),
  },
  {
    id: HIDDEN_EAGER_MEDIA_SCOPE,
    evaluate: ({ packet, report }) => evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report }),
  },
]);

// A waive refusal under --json is a JSON envelope on stdout, exit 1 — the same
// channel the success shape uses — so a caller parsing the output learns why
// (and, for a checkpoint, which gates exist) without reading free text on
// stderr. The stderr line is kept for the human watching the same terminal.
// Without --json the refusal propagates as before. Returns null once the
// envelope has been written.
function waiveOrRefuse(args, run, { gate = null, registeredGates = [] } = {}) {
  try {
    return run();
  } catch (error) {
    if (args.json !== true) throw error;
    const message = String(error?.message ?? error);
    // `gate` is the id the caller named; when no --gate was given at all the
    // key is omitted rather than reported as null.
    console.log(JSON.stringify({ ok: false, error: message, ...(gate == null ? {} : { gate }), registered_gates: registeredGates }, null, 2));
    console.error(`campaigns-os: ${message}`);
    process.exitCode = 1;
    return null;
  }
}

function checkpointCommand(args) {
  const subcommand = args._[1] || "help";
  if (subcommand !== "waive") {
    throw refused(`Unknown checkpoint subcommand. Use: ${cmd("checkpoint")} waive --packet <campaign-runtime.build.json> --gate <checkpoint-id> --reason "<why>" --waived-by "<named human>" [--expires-at <ISO>] [--review-condition "<trigger>"]. Registered gates: ${Object.keys(CHECKPOINT_EVALUATORS).join(", ")}.`);
  }
  return checkpointWaive(args);
}

export function checkpointWaive(args) {
  const packetPath = resolve(requireArg(args, "packet"));
  const dryRun = isDryRun(args);
  const gateId = requireArg(args, "gate").trim();
  const reason = requireArg(args, "reason");
  const waivedBy = requireArg(args, "waived-by");
  const expiresAt = args["expires-at"] == null ? null : String(args["expires-at"]);
  const reviewCondition = args["review-condition"] == null ? null : String(args["review-condition"]);
  const packet = readJson(packetPath);
  const workspace = resolveCampaignWorkspace(packetPath, {
    packet,
    reportPath: args.report ? resolve(String(args.report)) : undefined,
    followContextPointer: false,
  });
  const { reportPath } = workspace;
  if (!existsSync(reportPath)) throw new Error(`checkpoint waive needs an assembly report at ${reportPath}; run prepare-build/start first.`);

  const doctor = doctorPacket(packetPath, { reportPath });
  let waiver = null;
  const recordWaiver = (report) => {
    const gate = evaluateCheckpointRegistry(CHECKPOINT_EVALUATORS, gateId, { doctor, packet, report });
    if (!gate) throw new Error(`Checkpoint gate "${gateId}" has no current evidence; repair the packet/spec/target and re-run doctor.`);
    if (gate.status !== "blocked") {
      throw new Error(`Checkpoint gate "${gateId}" is not blocked (status=${gate.status}); no waiver was recorded.`);
    }
    if (gate.waivable !== true) {
      const residueFields = gateId === PAGE_KIT_STORE_PROFILE_SCOPE ? storeProfileDemoResidueFields(gate) : [];
      if (residueFields.length) {
        throw new Error(`Checkpoint gate "${gateId}" cannot be waived: ${residueFields.join(", ")} still carr${residueFields.length === 1 ? "ies" : "y"} starter demo residue (a demo storefront URL or phone). Replace the demo value(s) in ${gate.subject?.target_path || "_data/campaigns.json"}[${gate.subject?.public_route_slug || "<public-route-slug>"}]; only spec mismatches and missing values are waivable.`);
      }
      throw new Error(`Checkpoint gate "${gateId}" is not waivable in its current state (${gate.code}); missing, malformed, and invalid-type evidence must be repaired.`);
    }

    waiver = createCheckpointWaiver(gate, { reason, waivedBy, expiresAt, reviewCondition });
    const updated = appendCheckpointWaiver(report, waiver);
    updated.evidence = [
      ...(Array.isArray(report.evidence) ? report.evidence : []),
      `Checkpoint waiver: ${gateId} waived by ${waiver.waived_by} at ${waiver.waived_at}: ${waiver.reason}`,
    ];
    return updated;
  };
  // The gate registry decides waivability from the report, so both modes go
  // through the committing path itself (see commitWaiverToAssemblyReport): the
  // report is read and parsed the same way and the very same mutator runs over
  // it, so every refusal above fires exactly as it would for real. Only the
  // write and the doctor-sidecar stale stamp are skipped, and with them the
  // readiness block, which doctor can only read off a report on disk.
  commitWaiverToAssemblyReport(workspace, recordWaiver, {
    command: "checkpoint waive",
    staleReason: `A checkpoint waiver was recorded after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
  }, { dryRun });
  if (dryRun) {
    return {
      ok: true,
      status: "dry_run",
      dry_run: true,
      action: "checkpoint-waive",
      gate: gateId,
      waiver,
      report_path: reportPath,
      would_write: reportPath,
      note: "Dry run: nothing was written and the doctor sidecar was not marked stale. Re-run without --dry-run to record this waiver.",
    };
  }
  return {
    ok: true,
    ...waiveReadiness(packetPath, reportPath),
    action: "checkpoint-waive",
    gate: gateId,
    waiver,
    report_path: reportPath,
    note: "The exact checkpoint state is accepted under a bounded named-human exception and will report ready_with_waivers, never clean. Any state change makes this waiver stale and inert.",
  };
}

export function doctorPacket(packetPath, options = {}) {
  const result = withHtmlScanSnapshot(() => inspectDoctorPacket(packetPath, options));
  // Per-finding cause classification lives HERE, at the single production
  // boundary, and not in the doctor command. Four producers persist
  // .campaign-runtime/doctor-output.json from a doctorPacket result — `doctor
  // --write`, `next`, `start`/`build` (prepare-build runs no doctor), and the
  // QA stage refresh — and annotating only one of them means running QA after
  // doctor silently strips the labels back out of the retained artifact. Every
  // consumer of a doctor result gets the same shape, whether or not it writes
  // one. Each producer stamps the artifact with its own name on the way out
  // (`generated_by`, #312; writeDoctorSidecar / stampDoctorProducer), so a
  // retained sidecar always says which of the four wrote it. `standardize` is
  // not one of them: it reads the target and writes nothing.
  //
  // The comparison set is the previous Run Record's own doctor observations
  // (error_codes / warning_codes), which every Run Record ever written already
  // carries — so this works against existing history rather than needing a run
  // to go by first. Code granularity, because that is the granularity the
  // record stores. baseDir is the packet directory, the same root the Run
  // Record writes under.
  // An invalid identity cannot select history. In particular, withholding a
  // malformed local ID from derived must not turn it into an unfiltered or
  // Map-only lookup of another campaign's findings.
  const comparableIdentity = resolveCampaignIdentity(result.derived)
    && !result.errors.some(issue => issue.code === "spec.local_identity" || issue.code === "spec.map_id");
  result.cause_summary = annotateDoctorIssueCauses({
    errors: result.errors,
    warnings: result.warnings,
    baseDir: comparableIdentity ? dirname(resolve(packetPath)) : null,
    mapId: result.derived?.map_id || null,
    localSpecId: result.derived?.local_spec_id || null,
  });
  return result;
}

function inspectDoctorPacket(packetPath, { contextPath = undefined, reportPath = undefined, outputBaseDir = null } = {}) {
  // The Build Context records where prepare-build wrote the report
  // (--report-out). `next` follows that pointer when no --report is given;
  // doctor reads the same report so its gates and its next block cannot
  // disagree with the ladder over which report is the campaign's.
  const { packet, targetRepo: gateTargetRepo, contextPath: resolvedContextPath, reportPath: resolvedReportPath } = resolveCampaignWorkspace(packetPath, {
    contextPath,
    reportPath,
    followContextPointer: true,
  });
  const context = readJsonIfExists(resolvedContextPath);
  const report = readJsonIfExists(resolvedReportPath);
  const errors = [];
  const warnings = [];
  const ready = [];
  const packetIdentity = resolveCampaignIdentity(packet?.spec);
  const derived = {
    packet_path: packetPath,
    // The report this inspection read (null when the caller switched the
    // report off), so a writer can refuse to restate the outcome into a
    // different file.
    assembly_report_path: typeof resolvedReportPath === "string" ? resolvedReportPath : null,
    map_id: packet?.spec?.map_id || null,
    ...(packetIdentity?.kind === "local_spec" ? { local_spec_id: packetIdentity.id } : {}),
    public_route_slug: packet?.campaign?.public_route_slug || null,
    template_family: packet?.assembly?.template_family || null,
    source_root: null,
    target_repo: null,
    target_output_dir: null,
    spec_path: null,
    doctor_checks: [],
    checkpoint_gates: [],
    polish_checkpoint_gate: null,
    // The prepare-build gate `next` acts on, stored like every other gate so
    // the ladder consumes doctor's evaluation instead of computing its own.
    prepare_build_gate: null,
    // The family brand contract, resolved once per run: { state, family } plus
    // { code, detail } for a defect. The `next` advisories read it.
    brand_contract: null,
    page_kit_campaign_config: null,
    scaffold_required: false,
    scaffold_reason: null,
    scope: {
      mode: "unknown",
      built_pages: [],
      out_of_scope_pages: [],
      previewable_routes: [],
      blocked_runtime_pages: [],
    },
  };

  validatePacket(packet, packetPath, errors, warnings, ready, derived, { context, report });
  runDoctorChecks(ARTIFACT_DOCTOR_CHECKS, { context, report, errors, warnings, ready, derived });

  // Doctor and the stage ladder must agree over one packet (#238): when the
  // recorded assembly report holds prepare_build at "blocked" (or claims a
  // terminal status while retaining blocking evidence), every `next <stage>`
  // command refuses to run — so doctor surfaces the same blockers as errors
  // instead of exiting 0 and naming a stage the ladder then rejects. Doctor
  // exit 0 means the command it names will actually run.
  const prepareBuildLadderGate = prepareBuildGateIssue(report);
  if (prepareBuildLadderGate?.blocked) {
    addPrepareBuildGateErrors(errors, report, prepareBuildLadderGate);
  }

  // Theme gate: evaluated once here so `next`, QA, and run telemetry all read
  // the same decision from derived.theme_gate. The doctor reports a blocked
  // gate as a WARNING (not an error) because the fix happens during the build
  // stage — but `next polish|deploy|qa` and `qa run` treat the same gate
  // result as a hard blocker.
  const themeGate = evaluateThemeGate({
    reportTheme: report?.theme || null,
    contextTheme: context?.theme || null,
    scope: derived.scope,
    packetPath,
  });
  derived.theme_gate = themeGate;
  if (themeGate.status === "blocked") {
    pushGateIssue({ errors, warnings }, gateIssue("theme_gate", themeGate));
  } else if (themeGate.status === "waived") {
    ready.push(`Theme gate waived: ${themeGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (themeGate.status === "pass") {
    // The gate passes on two different facts (a brand layer applied, or no
    // generatable brand theme at all); print the one it found, never the
    // other. An operator reading ready[] on a token-less campaign must not
    // believe brand styling shipped.
    ready.push(`Theme gate passed: ${themeGate.reason}`);
  }
  runPricingCssHideCheck({ packet, derived, warnings, ready, report });

  const polishCheckpointGate = evaluateRecordedHiddenEagerMediaCheckpoint({ packet, report });
  derived.polish_checkpoint_gate = polishCheckpointGate;
  const polishGate = evaluatePolishGate({
    report,
    hiddenEagerMediaGate: polishCheckpointGate,
    currentOutputFingerprint: derived.build_output_fingerprint?.value || null,
  });
  derived.polish_gate = polishGate;
  if (polishGate.status === "blocked" && !polishGate.owned_checkpoint_only) {
    pushGateIssue({ errors, warnings }, gateIssue("polish_gate", polishGate));
  } else if (polishGate.status === "waived" && !polishGate.owned_checkpoint_only) {
    ready.push(`Polish gate passed under waiver: ${polishGate.waiver?.reason || "(no reason recorded)"}`);
  } else if (polishGate.status === "pass") {
    ready.push("Polish gate passed: structured evidence is current for this build.");
  }

  if (polishCheckpointGate.status === "blocked") {
    pushGateIssue({ errors, warnings }, gateIssue("polish_checkpoint_gate", polishCheckpointGate));
  } else if (polishCheckpointGate.status === "waived") {
    addIssue(
      warnings,
      polishCheckpointGate.code,
      `${polishCheckpointGate.reason} Waived by ${polishCheckpointGate.waiver.waived_by}: ${polishCheckpointGate.waiver.reason}`,
      { polish_checkpoint_gate: polishCheckpointGate },
    );
    ready.push(`Hidden eager-media checkpoint accepted under named-human exception (${polishCheckpointGate.waiver.waived_by}).`);
  } else if (polishCheckpointGate.status === "pass") {
    ready.push("Hidden eager-media checkpoint passed: package-owned page-load evidence is complete and current.");
  } else {
    ready.push("Hidden eager-media checkpoint not applicable before completed assembly.");
  }

  // The same fully resolved prepare-build gate the `next` command evaluates:
  // DSP-required packets, the recorded report path and the context/report
  // binding checks. A weaker gate here would let doctor name setup or build
  // while `next` still answers prepare-build.
  // With no context on hand (doctor --report alone) the binding checks have
  // nothing to compare and are skipped; the report itself was resolved
  // above the way `next` resolves it.
  // The stage decision runs over exactly the artifacts the checks ran over.
  // A caller that named one sidecar and not the other (doctor --context C)
  // is inspecting, and its report checks are deliberately off; its next
  // block decides without the report too, and says so in `reason`. The
  // binding is evaluated whether or not a Build Context was found: an absent
  // context is itself a binding failure for a packet that declares a Design
  // Source Package, and `next` consumes this gate rather than computing its
  // own, so the two cannot answer differently on the same repo.
  const prepareBuildGate = prepareBuildGateIssue(report, {
    required: isObject(packet?.design_source_package),
    reportPath: resolvedReportPath,
    bindingIssues: isObject(packet)
      ? nextPrepareBuildBindingIssues({
          packet,
          packetPath,
          context,
          contextPath: resolvedContextPath,
          report,
          reportPath: resolvedReportPath,
          targetRepo: gateTargetRepo,
          explicitReport: typeof reportPath === "string",
        })
      : [],
  });
  derived.prepare_build_gate = prepareBuildGate;
  // Portable output (outputBaseDir set: start's generated doctor output,
  // doctor --strip-paths) rebases them onto that base like every other path
  // in the output, so a relocated handoff does not name the original machine.
  const sidecarArg = (path) => shellToken(outputBaseDir ? relFromDir(outputBaseDir, path) : path);
  const sidecarArgs = [
    ...(typeof contextPath === "string" ? [` --context ${sidecarArg(contextPath)}`] : []),
    ...(typeof reportPath === "string" ? [` --report ${sidecarArg(reportPath)}`] : []),
  ].join("");
  const next = buildNextStep(errors, warnings, derived, report, packet, prepareBuildGate, { sidecarArgs });
  // Portable output: a sidecar path the picker's reason names is rebased
  // like every other path in the output.
  if (outputBaseDir && typeof next?.reason === "string") {
    for (const path of [resolvedContextPath, resolvedReportPath]) {
      if (typeof path === "string" && next.reason.includes(path)) {
        next.reason = next.reason.split(path).join(relFromDir(outputBaseDir, path));
      }
    }
  }
  const status = errors.length
    ? "blocked"
    : checkpointExceptionPresent(derived)
      ? "ready_with_waivers"
      : warnings.length
        ? "ready_with_warnings"
        : "ready";
  const result = {
    schema_version: DOCTOR_SIDECAR_SCHEMA,
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    status,
    errors,
    warnings,
    ready,
    derived,
    next,
  };
  return outputBaseDir ? relativizeDoctorOutput(result, outputBaseDir) : result;
}

// Pricing surfaces are rendered by mode-driven partials, never hidden with
// campaign CSS — a display:none on a price wrapper is how the recovery-relief
// dogfood run shipped a full-price upsell with NO visible price. Deterministic
// static scan: campaign-owned CSS files (not the family core stylesheet, not
// the generated brand layer) must not display:none any selector the family
// brand contract lists under pricing_surfaces.forbidden_css_hides. Doctor
// reports a warning with the exact rule; browser QA enforces the outcome
// (zero visible price rows) as a blocker.
export function runPricingCssHideCheck({ packet, derived, warnings, ready, report = null }) {
  const family = packet?.assembly?.template_family;
  const resolution = resolveBrandContractOnce(derived, family);
  if (resolution.error) {
    reportBrandContractDefectOnce(resolution, warnings, family);
    return;
  }
  const contract = resolution.contract;
  if (!contract?.pricing_surfaces?.forbidden_css_hides?.length) {
    ready.push(`Pricing CSS scan not applicable for template family "${family || "(none)"}" (no brand contract with forbidden_css_hides)`);
    return;
  }
  // Missing campaign output is normal before setup/build (audit ready-line),
  // but anomalous once the assembly stage is recorded terminal — at that
  // point a missing dir means the scan that should have covered built CSS
  // never ran, which the operator must see as a warning, not a footnote.
  const assemblyDone = stageIsTerminal(report?.stages?.assembly?.status);
  const skipScan = (reason) => {
    if (assemblyDone) {
      addIssue(warnings, "template_contract.price_css_scan_skipped", `Pricing CSS scan did NOT run although assembly is recorded terminal: ${reason}. Check assembly.target_repo / output_dir configuration.`);
    } else {
      ready.push(`Pricing CSS scan skipped: ${reason} (runs after setup/build)`);
    }
  };
  const outputDir = derived.target_output_dir;
  if (!outputDir || !existsSync(outputDir)) {
    skipScan("target output directory does not exist");
    return;
  }
  const cssDir = join(outputDir, "assets/css");
  if (!existsSync(cssDir)) {
    skipScan("campaign assets/css directory does not exist");
    return;
  }
  const coreStylesheet = contract.css_load_order?.core_stylesheet || "next-core.css";
  const campaignCssFiles = readdirSync(cssDir)
    .filter((name) => name.endsWith(".css") && name !== coreStylesheet && name !== "brand-theme.css");
  let hideCount = 0;
  for (const name of campaignCssFiles) {
    const cssPath = join(cssDir, name);
    let cssText = "";
    try {
      cssText = readFileSync(cssPath, "utf8");
    } catch {
      continue;
    }
    for (const hit of findForbiddenPriceHides(contract, cssText)) {
      hideCount += 1;
      addIssue(
        warnings,
        "template_contract.price_css_hide",
        `Campaign CSS ${name} hides a pricing surface: "${hit.selector}" sets display:none on ${hit.target}. Use the template's declared pricing modes instead of hiding price rows; browser QA blocks upsells with zero visible price rows.`,
      );
    }
  }
  if (hideCount === 0 && campaignCssFiles.length) {
    ready.push(`Campaign CSS has no display:none rules on ${family} pricing surfaces`);
  }
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
      if (markers.length) shipped.push({ page_id: built.page_id, file: built.file, method, markers });
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
  const evidence = shipped.map((hit) => `${hit.file}: ${hit.method} (${hit.markers.join(", ")})`).join("; ");
  addIssue(
    warnings,
    "spec.store_profile.payment_methods_default_on",
    `Built checkout still renders ${shippedMethods.join(", ")}, which the CampaignSpec does not list in available_payment_methods/available_express_payment_methods: ${evidence}. `
      + `Pass ${shippedMethods.map((method) => `show_${method}=false`).join(" ")} on the checkout page's payment-methods.html include call and rebuild (or add the method to the spec); browser QA's template-residue gate fails on this markup.`,
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

// `page-kit sync`: write the CampaignSpec's Store Profile fields and SDK pin
// into the target's _data/campaigns.json entry for the packet's route. This is
// the recovery the two page-kit gates name: a fresh scaffold seeds the entry
// with the starter family's demo profile and pin, doctor blocks on
// page_kit.store_profile (demo residue, unwaivable) and page_kit.sdk_version,
// and the fix is deterministic — the spec already holds every value. Exactly
// the ten governed fields are written, only those the spec carries; other
// fields, other entries and other files are untouched. --dry-run prints the
// same diff and writes nothing. Exit 2 when the entry or the spec is missing.
const PAGE_KIT_SYNC_FLAGS = Object.freeze(["packet", "dry-run", "json", "report"]);

export function pageKitSyncCommand(args) {
  // The one new command that rewrites a tracked data file rejects flags it
  // does not know (mirroring standardize): a mistyped --dryrun must not fall
  // through to a real write. --report is accepted because doctor appends it to
  // the printed command when it inspected a non-default report; it names the
  // Assembly Report whose waivers are honoured below.
  const unknown = Object.keys(args).filter((key) => key !== "_" && !PAGE_KIT_SYNC_FLAGS.includes(key));
  if (unknown.length) {
    const valueHint = unknown.some((key) => key.includes("=")) ? " A flag takes its value as the next argument (--flag value), not --flag=value." : "";
    throw refused(`Unknown flag${unknown.length > 1 ? "s" : ""} for page-kit sync: ${unknown.map((key) => `--${key}`).join(", ")}.${valueHint} Known flags: ${PAGE_KIT_SYNC_FLAGS.map((key) => `--${key}`).join(", ")}.`);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  const dryRun = isDryRun(args);
  const result = {
    ok: false,
    action: "page-kit sync",
    status: "blocked",
    packet_path: packetPath,
    public_route_slug: null,
    target_repo: null,
    target_path: PAGE_KIT_CAMPAIGNS_REL_PATH,
    campaigns_path: null,
    spec_path: null,
    report_path: null,
    dry_run: dryRun,
    written: false,
    changes: [],
    unchanged: [],
    not_in_spec: [],
    not_synced: [],
    errors: [],
    warnings: [],
    next: `${cmd("doctor")} --packet ${shellToken(packetPath)}`,
  };

  // Every precondition failure is a structured page_kit.sync.* error with exit
  // 2, so a --json consumer always gets the result document: an unreadable
  // packet included.
  let packet;
  try {
    packet = readJson(packetPath);
  } catch (error) {
    addIssue(result.errors, "page_kit.sync.packet_invalid", `Build Packet ${packetPath} could not be read as JSON: ${singleLineDetail(error.message)}`);
    return result;
  }
  if (!isObject(packet)) {
    addIssue(result.errors, "page_kit.sync.packet_invalid", `Build Packet ${packetPath} must be a JSON object.`);
    return result;
  }
  const publicRouteSlug = normalizePublicRouteSlug(packet.campaign?.public_route_slug);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  const localSpecPath = packet.spec?.local_path;
  const specPath = isNonEmptyString(localSpecPath) ? resolveFromFile(packetPath, localSpecPath) : null;
  result.public_route_slug = publicRouteSlug || null;
  result.target_repo = targetRepo;
  result.campaigns_path = targetRepo ? join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH) : null;
  result.spec_path = specPath;

  if (!publicRouteSlug) {
    addIssue(result.errors, "page_kit.sync.route_slug_missing", "The packet has no campaign.public_route_slug; the campaigns.json entry to reconcile cannot be named.");
  }

  let spec = null;
  if (!specPath) {
    addIssue(result.errors, "page_kit.sync.spec_missing", "The packet has no local CampaignSpec path (spec.local_path). The spec is the authority for the Store Profile and SDK pin; rerun start/prepare-build with a local exported CampaignSpec.");
  } else if (!existsSync(specPath)) {
    addIssue(result.errors, "page_kit.sync.spec_missing", `CampaignSpec local_path does not exist: ${specPath}. Restore or re-export it there, then sync again.`);
  } else {
    let parsed;
    try {
      parsed = readJson(specPath);
    } catch (error) {
      // The parser quotes the file's own bytes in its message; flatten it.
      addIssue(result.errors, "page_kit.sync.spec_invalid", `CampaignSpec at ${specPath} is not valid JSON (${singleLineDetail(error.message)}). Repair the spec, then sync again.`);
    }
    if (parsed !== undefined) {
      if (isObject(parsed)) spec = parsed;
      else addIssue(result.errors, "page_kit.sync.spec_invalid", `CampaignSpec at ${specPath} must be a JSON object (an exported CampaignSpec), not ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`}.`);
    }
  }
  // The spec must be THIS campaign's. Doctor cross-checks the same identity
  // (campaign.route_slug_identity); without it a stale or copy-pasted
  // spec.local_path would write another campaign's store profile into this
  // route with a plausible-looking diff.
  if (spec && publicRouteSlug) {
    const specSlug = normalizePublicRouteSlug(
      optionalString(spec.spec_identity?.public_route_slug)
      || optionalString(spec.campaign?.slug)
      || optionalString(spec.campaign?.id),
    );
    const specMapId = optionalString(spec.spec_identity?.map_id) || optionalString(spec.map_id);
    const packetMapId = optionalString(packet.spec?.map_id);
    if (specSlug && specSlug !== publicRouteSlug) {
      addIssue(result.errors, "page_kit.sync.spec_identity_mismatch", `CampaignSpec identifies route "${singleLineField(specSlug)}" but the packet's campaign.public_route_slug is "${publicRouteSlug}". Point spec.local_path at this campaign's export (or re-run prepare-build from it); nothing was written.`);
    } else if (specMapId && packetMapId && specMapId !== packetMapId) {
      addIssue(result.errors, "page_kit.sync.spec_identity_mismatch", `CampaignSpec spec_identity.map_id "${singleLineField(specMapId)}" does not match the packet's spec.map_id "${singleLineField(packetMapId)}". Point spec.local_path at this campaign's export (or re-run prepare-build from it); nothing was written.`);
    } else if ((spec.spec_identity?.local_spec_id != null || packet.spec?.local_spec_id != null)
      && !campaignIdentitiesMatch(campaignSpecIdentity(spec), packet.spec)) {
      addIssue(result.errors, "page_kit.sync.spec_identity_mismatch", "CampaignSpec identity (spec_identity.map_id/local_spec_id) does not match the packet identity. Point spec.local_path at this campaign's spec (or re-run prepare-build from it); nothing was written.");
    }
  }

  const load = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug });
  if (load.status !== "ok") {
    const where = result.campaigns_path || PAGE_KIT_CAMPAIGNS_REL_PATH;
    const messages = {
      target_repo_missing: `Target repo does not exist: ${packet.assembly?.target_repo || "(assembly.target_repo not set)"}.`,
      file_missing: `${where} does not exist. Scaffold the campaign first (setup: campaign-init writes the file), then sync.`,
      entry_missing: `${where} has no entry for "${publicRouteSlug || "<public-route-slug>"}". Scaffold the route first (setup: campaign-init registers it), then sync.`,
      invalid_json: `${where} is not valid JSON; repair the file, then sync.`,
      root_not_object: `${where} root must be an object keyed by public route slug; repair the file, then sync.`,
      entry_not_object: `${where}["${publicRouteSlug}"] must be an object; repair the entry, then sync.`,
    };
    addIssue(result.errors, "page_kit.sync.entry_missing", messages[load.status] || `${where} entry is unavailable (${load.status}).`, { target_status: load.status });
  }
  if (result.errors.length) return result;

  // The write lands on the file the path RESOLVES to, and that file must live
  // inside the target repo: a `_data` or `campaigns.json` symlink pointing
  // elsewhere would otherwise let a checked-in link redirect the write into
  // another repository while the output names the legitimate path.
  const realCampaignsPath = realpathSync(result.campaigns_path);
  const realTargetRepo = realpathSync(targetRepo);
  if (realCampaignsPath !== realTargetRepo && !realCampaignsPath.startsWith(`${realTargetRepo}${sep}`)) {
    addIssue(result.errors, "page_kit.sync.target_escapes_repo", `${result.campaigns_path} resolves to ${realCampaignsPath}, outside the target repo ${realTargetRepo}. page-kit sync writes only inside the packet's target repo; nothing was written.`);
    return result;
  }
  result.campaigns_path = realCampaignsPath;

  // One read serves both the plan and the write, so the diff printed is the
  // diff applied even if the file changes underneath a slow operator.
  const text = readFileSync(result.campaigns_path, "utf8");
  const campaigns = JSON.parse(text);
  const entry = campaigns[publicRouteSlug];

  // The Assembly Report doctor would read (the one the Build Context binds,
  // or --report): its waivers[] and stage ledger decide two things. A gate
  // under an active named-human waiver is a human decision sync must not
  // reverse, so its fields are left as the waiver accepted them. And a
  // terminal build means _site/ was rendered from the entry being rewritten,
  // so the operator is told a rebuild is owed: doctor's two page-kit gates
  // read _data/campaigns.json, not the built output.
  let report = null;
  try {
    // An explicit --report must name a file: a path mangled in transit
    // (quoting stripped by a shell) would otherwise resolve to nothing and
    // silently drop the waivers it was meant to carry.
    const explicitReport = isNonEmptyString(args.report) ? resolve(args.report) : null;
    if (explicitReport && !(existsSync(explicitReport) && statSync(explicitReport).isFile())) {
      addIssue(result.warnings, "page_kit.sync.report_unreadable", `--report ${singleLineField(explicitReport)} is not a file; waivers recorded on the Assembly Report were not consulted.`);
    }
    const workspace = resolveCampaignWorkspace(packetPath, {
      packet,
      followContextPointer: true,
      reportPath: explicitReport ?? undefined,
    });
    report = readJsonIfExists(workspace.reportPath);
    result.report_path = workspace.reportPath;
  } catch (error) {
    addIssue(result.warnings, "page_kit.sync.report_unreadable", `The Assembly Report could not be read (${singleLineDetail(error.message)}); waivers recorded there were not consulted.`);
  }
  const targetLoad = { status: "ok", public_route_slug: publicRouteSlug, target_path: PAGE_KIT_CAMPAIGNS_REL_PATH, entry };
  const waivers = Array.isArray(report?.waivers) ? report.waivers : [];
  const waivedGates = [
    evaluatePageKitStoreProfile({ specCampaign: spec.campaign || {}, targetLoad, waivers }),
    evaluatePageKitSdkVersion({ spec, targetLoad, waivers }),
  ].filter((gate) => gate.status === "waived").map((gate) => ({ scope: gate.scope, waived_by: gate.waiver?.waived_by || null }));
  const plan = planPageKitSync({ spec, entry, waivedGates });
  result.changes = plan.changes;
  result.unchanged = plan.unchanged;
  result.not_in_spec = plan.not_in_spec;
  result.not_synced = plan.not_synced;
  for (const row of plan.not_synced) {
    addIssue(result.warnings, `page_kit.sync.${row.field}_not_synced`, `${row.field} was not written: ${row.detail}`, { reason: row.reason });
  }

  if (plan.changes.length && !dryRun) {
    // The entry is edited in place and the document re-serialized with the
    // file's own top-level indentation, line ending and trailing newline. When
    // that round trip would not have reproduced the file byte for byte (a
    // minified file, mixed indentation, keys JSON.parse reorders), the
    // operator is told the file was normalized, because the printed diff
    // covers only the governed fields.
    // The loader has already rejected a file JSON.parse refuses (a UTF-8 BOM
    // included), so the text starts at the opening brace.
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const indent = text.match(/^\s*\{\r?\n([ \t]+)"/)?.[1] ?? "  ";
    const trailing = /\r?\n$/.test(text) ? eol : "";
    const serialize = (document) => `${JSON.stringify(document, null, indent).replace(/\n/g, eol)}${trailing}`;
    if (serialize(campaigns) !== text) {
      addIssue(result.warnings, "page_kit.sync.file_reformatted", `${result.campaigns_path} was re-serialized with ${indent === "\t" ? "tab" : `${indent.length}-space`} indentation; formatting outside the governed fields (key order, whitespace, number spelling) may differ from the original. Review the file diff before committing.`);
    }
    applyPageKitSync(campaigns, publicRouteSlug, plan);
    // Staged through a temp file and rename, as the sidecar writers are, so an
    // interrupted write can never leave the page-kit data file half-written.
    const tmpPath = join(dirname(result.campaigns_path), `.${basename(result.campaigns_path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, serialize(campaigns), { flag: "wx" });
      // The replacement keeps the original's permission bits.
      chmodSync(tmpPath, statSync(result.campaigns_path).mode & 0o7777);
      renameSync(tmpPath, result.campaigns_path);
    } finally {
      rmSync(tmpPath, { force: true });
    }
    result.written = true;
    if (stageIsTerminal(report?.stages?.assembly?.status)) {
      addIssue(result.warnings, "page_kit.sync.build_stale", `The Assembly Report records a terminal build (stages.assembly.status ${report.stages.assembly.status}), and the built output was rendered from the entry just rewritten: its store profile links, phone and Campaign Cart loader pin are now stale. Re-run the build stage before polish, deploy or QA; doctor's page-kit gates read ${PAGE_KIT_CAMPAIGNS_REL_PATH}, not _site/.`);
      result.next = `${cmd("doctor")} --packet ${shellToken(packetPath)}, then rebuild: set stages.assembly.status back to "pending" on the Assembly Report and run ${cmd("next")} --packet ${shellToken(packetPath)}`;
    }
    // The retained doctor snapshot (if any) now predates the entry it judged.
    // The data file is already written, so a failure here is a warning on the
    // result, never a thrown error that hides the write.
    try {
      markDoctorSidecarStale(targetRepo, {
        command: "page-kit sync",
        reason: `page-kit sync rewrote ${PAGE_KIT_CAMPAIGNS_REL_PATH}[${publicRouteSlug}] after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
      });
    } catch (error) {
      addIssue(result.warnings, "page_kit.sync.doctor_sidecar_not_marked", `${PAGE_KIT_CAMPAIGNS_REL_PATH} was written, but the retained doctor snapshot could not be marked stale (${singleLineDetail(error.message)}); re-run doctor before trusting it.`);
    }
  }
  // `partial`: the governed fields the spec carries were written (or would
  // be), but something the target cannot be made authoritative for remains,
  // so doctor will still block. Exit stays 0 — the write itself succeeded —
  // and the warnings say what to repair in the spec.
  result.status = plan.not_synced.length
    ? "partial"
    : plan.changes.length ? (dryRun ? "dry_run" : "synced") : "unchanged";
  result.ok = true;
  return result;
}

// `spec derive`: write the fields the target repo already states into the
// packet's local CampaignSpec (#432, slice 1). The SDK pin, each page's public
// route and the analytics ids are classed derived — the repo is their
// authority — so they are generated here instead of typed into the Map and
// refereed by doctor. Exactly the derived fields are written; the rest of the
// spec and every other file are untouched. The store-derived fields (the nine
// campaign.store_* Store Profile fields, slice 2) join the write only behind
// --from-store <subdomain>, which reads the store's Admin API
// through gateway login, or the explicit --store-token-source env:<VAR> break-glass path;
// the default run stays offline. --dry-run prints the same diff and writes
// nothing. Exit 2 when the packet, the spec or the target entry is missing,
// or the store cannot be read.
const SPEC_DERIVE_FLAGS = Object.freeze(["packet", "dry-run", "json", "report", "from-store", "store-token-source"]);

// The store flags, parsed once for both the async reader and the sync
// command: `{ subdomain, token_env }` when --from-store is given, null when
// it is not, and a thrown Error for a malformed flag (the same class of
// mistake as an unknown flag: refused before anything is read).
function parseSpecDeriveStoreFlags(args) {
  if (!Object.hasOwn(args, "from-store")) {
    if (Object.hasOwn(args, "store-token-source")) throw refused("--store-token-source only applies with --from-store <subdomain>.");
    return null;
  }
  const subdomain = normalizeStoreSubdomain(args["from-store"] === true ? "" : String(args["from-store"] ?? ""));
  if (!subdomain) {
    throw refused(`--from-store takes the store's subdomain (the <store> of <store>.29next.store), got ${JSON.stringify(args["from-store"] === true ? "" : args["from-store"])}.`);
  }
  let tokenEnv = null;
  if (Object.hasOwn(args, "store-token-source")) {
    const parsed = parseStoreTokenSource(args["store-token-source"] === true ? "" : String(args["store-token-source"] ?? ""));
    if (parsed.problem) throw refused(`--store-token-source ${parsed.problem}`);
    tokenEnv = parsed.env;
  }
  return { subdomain, token_env: tokenEnv };
}

// `spec derive --from-store`: resolve the credential, read the store, then
// run the same command with the store read in hand. The only network the
// command ever does happens here, and the token never leaves this function:
// the result names the credential source, never its value.
export async function specDeriveFromStoreCommand(args, { fetchImpl = globalThis.fetch, env = process.env, credentials, warn = console.warn } = {}) {
  const store = parseSpecDeriveStoreFlags(args);
  if (!store) return specDeriveCommand(args);
  const preflight = specDeriveCommand(args, { store: { ...store, status: "preflight" } });
  if (preflight.errors.length) return preflight;
  let read;
  if (store.token_env) {
    warn("Warning: explicit Admin environment credentials are a break-glass path. Use campaigns-os login --store <subdomain> and omit --store-token-source for supported gateway reads.");
    const token = typeof env[store.token_env] === "string" ? env[store.token_env].trim() : "";
    read = token ? await readStoreProfile({ subdomain: store.subdomain, token, fetchImpl }) : { status: "credential_missing", detail: `${store.token_env} is not set (or empty); use campaigns-os login --store ${store.subdomain}, or explicitly supply the break-glass environment credential.` };
  } else {
    const { readGatewayStoreProfile } = await import("./admin-transport.mjs");
    read = await readGatewayStoreProfile({ subdomain: store.subdomain, credentials, fetchImpl });
  }
  // Recheck the original packet/spec identity after the network operation.
  return specDeriveCommand(args, { store: { ...store, ...read, expected: { spec_path: preflight.spec_path, public_route_slug: preflight.public_route_slug } } });
}

// The page files page-kit renders under the campaign's source directory, with
// the route each one builds to (filename-derived, or the file's permalink;
// a permalink derive cannot read as a campaign route carries `problem` and a
// null route). Discovery follows page-kit's own: every .html outside
// `_layouts/` and `_includes/`, symlinked entries included. Returns null when
// the directory does not exist, so the plan can say "no page tree" rather
// than "no pages".
function listPageKitPageFiles(outputDir, publicRouteSlug) {
  if (!outputDir || !existsSync(outputDir) || !statSync(outputDir).isDirectory()) return null;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const stats = entry.isSymbolicLink() ? statSync(fullPath, { throwIfNoEntry: false }) : entry;
      if (!stats) continue;
      if (stats.isDirectory()) {
        if (!isPageTreeIgnoredDir(entry.name)) walk(fullPath);
        continue;
      }
      if (!stats.isFile() || extname(entry.name).toLowerCase() !== ".html") continue;
      const path = relative(outputDir, fullPath).split(sep).join("/");
      const segments = path.split("/");
      if (segments.slice(0, -1).some(isPageTreeIgnoredDir)) continue;
      // page-kit honours a permalink before its filename rule, so the
      // frontmatter is read first (quoting, comments, BOM and CRLF as
      // page-kit's reader takes them); only a file with no usable permalink
      // falls back to the filename route.
      const permalink = frontmatterPermalink(readFileSync(fullPath, "utf8"));
      if (permalink === null) {
        const filenameRoute = pageRouteForFile(path);
        if (filenameRoute === null) continue;
        files.push({ path, basename: basename(entry.name, ".html"), route: filenameRoute, permalink: null, problem: null });
        continue;
      }
      const resolved = permalinkRoute(permalink, publicRouteSlug);
      files.push({ path, basename: basename(entry.name, ".html"), route: resolved.route ?? null, permalink, problem: resolved.problem ?? null });
    }
  };
  walk(outputDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function specDeriveCommand(args, { store: storeRead = null } = {}) {
  // A command that rewrites the spec rejects flags it does not know: a
  // mistyped --dryrun must not fall through to a real write. --report names
  // the Assembly Report whose waivers are honoured below.
  const unknown = Object.keys(args).filter((key) => key !== "_" && !SPEC_DERIVE_FLAGS.includes(key));
  if (unknown.length) {
    const valueHint = unknown.some((key) => key.includes("=")) ? " A flag takes its value as the next argument (--flag value), not --flag=value." : "";
    throw refused(`Unknown flag${unknown.length > 1 ? "s" : ""} for spec derive: ${unknown.map((key) => `--${key}`).join(", ")}.${valueHint} Known flags: ${SPEC_DERIVE_FLAGS.map((key) => `--${key}`).join(", ")}.`);
  }
  // The store read is supplied by specDeriveFromStoreCommand; this function
  // never touches the network itself, so a --from-store call that reaches it
  // without a read is a defect in this toolkit, not a silent offline run.
  const storeFlags = parseSpecDeriveStoreFlags(args);
  if (storeFlags && !storeRead) throw new Error("spec derive --from-store must be dispatched through specDeriveFromStoreCommand (no store read was supplied).");
  const packetPath = resolve(requireArg(args, "packet"));
  const dryRun = isDryRun(args);
  if (args.report === true) throw refused("Missing value for --report");
  const result = {
    ok: false,
    action: "spec derive",
    status: "blocked",
    packet_path: packetPath,
    public_route_slug: null,
    target_repo: null,
    campaigns_path: null,
    page_tree: null,
    spec_path: null,
    report_path: null,
    dry_run: dryRun,
    written: false,
    changes: [],
    unchanged: [],
    not_derived: [],
    not_in_target: [],
    stale_hints: [],
    store: storeFlags
      ? { subdomain: storeFlags.subdomain, admin_api: adminApiBaseForStore(storeFlags.subdomain), ...(storeFlags.token_env ? {} : { transport: "gateway", endpoint: "https://mcp.nextcommerce.com/admin/" }), token_source: storeFlags.token_env ? `env:${storeFlags.token_env}` : "gateway:login", store_read: null, pages_read: null, primary_domain: null }
      : null,
    rebound: { build_context: null, assembly_report: null },
    errors: [],
    warnings: [],
    next: `${cmd("doctor")} --packet ${shellToken(packetPath)}`,
  };

  // Every precondition failure is a structured spec.derive.* error with exit
  // 2, so a --json consumer always gets the result document.
  let packet;
  try {
    packet = readJson(packetPath);
  } catch (error) {
    addIssue(result.errors, "spec.derive.packet_invalid", `Build Packet ${packetPath} could not be read as JSON: ${singleLineDetail(error.message)}`);
    return result;
  }
  if (!isObject(packet)) {
    addIssue(result.errors, "spec.derive.packet_invalid", `Build Packet ${packetPath} must be a JSON object.`);
    return result;
  }
  const publicRouteSlug = normalizePublicRouteSlug(packet.campaign?.public_route_slug);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  const localSpecPath = packet.spec?.local_path;
  const specPath = isNonEmptyString(localSpecPath) ? resolveFromFile(packetPath, localSpecPath) : null;
  result.public_route_slug = publicRouteSlug || null;
  result.target_repo = targetRepo;
  result.campaigns_path = targetRepo ? join(targetRepo, PAGE_KIT_CAMPAIGNS_REL_PATH) : null;
  result.spec_path = specPath;

  if (!publicRouteSlug) {
    addIssue(result.errors, "spec.derive.route_slug_missing", "The packet has no campaign.public_route_slug; the campaigns.json entry and page tree to derive from cannot be named.");
  }

  let spec = null;
  let text = null;
  if (!specPath) {
    addIssue(result.errors, "spec.derive.spec_missing", "The packet has no local CampaignSpec path (spec.local_path). spec derive writes into that file; rerun start/prepare-build with a local exported CampaignSpec.");
  } else if (!existsSync(specPath) || !statSync(specPath).isFile()) {
    addIssue(result.errors, "spec.derive.spec_missing", `CampaignSpec local_path is not a file: ${specPath}. Restore or re-export it there, then derive again.`);
  } else {
    // One read serves the plan and the write, so the diff printed is the diff
    // applied even if the file changes underneath a slow operator.
    try {
      text = readFileSync(specPath, "utf8");
    } catch (error) {
      addIssue(result.errors, "spec.derive.spec_missing", `CampaignSpec local_path could not be read: ${specPath} (${singleLineDetail(error.message)}). Restore it, then derive again.`);
    }
    let parsed;
    try {
      if (text !== null) parsed = JSON.parse(text);
    } catch (error) {
      addIssue(result.errors, "spec.derive.spec_invalid", `CampaignSpec at ${specPath} is not valid JSON (${singleLineDetail(error.message)}). Repair the spec, then derive again.`);
    }
    if (parsed !== undefined) {
      if (isObject(parsed)) spec = parsed;
      else addIssue(result.errors, "spec.derive.spec_invalid", `CampaignSpec at ${specPath} must be a JSON object (an exported CampaignSpec), not ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`}.`);
    }
  }
  // The spec must be THIS campaign's. Doctor cross-checks the same identity
  // (campaign.route_slug_identity); without it a stale or copy-pasted
  // spec.local_path would receive another campaign's routes and pin.
  if (spec && publicRouteSlug) {
    const specSlug = normalizePublicRouteSlug(
      optionalString(spec.spec_identity?.public_route_slug)
      || optionalString(spec.campaign?.slug)
      || optionalString(spec.campaign?.id),
    );
    const specMapId = optionalString(spec.spec_identity?.map_id) || optionalString(spec.map_id);
    const packetMapId = optionalString(packet.spec?.map_id);
    if (specSlug && specSlug !== publicRouteSlug) {
      addIssue(result.errors, "spec.derive.spec_identity_mismatch", `CampaignSpec identifies route "${singleLineField(specSlug)}" but the packet's campaign.public_route_slug is "${publicRouteSlug}". Point spec.local_path at this campaign's export (or re-run prepare-build from it); nothing was written.`);
    } else if (specMapId && packetMapId && specMapId !== packetMapId) {
      addIssue(result.errors, "spec.derive.spec_identity_mismatch", `CampaignSpec spec_identity.map_id "${singleLineField(specMapId)}" does not match the packet's spec.map_id "${singleLineField(packetMapId)}". Point spec.local_path at this campaign's export (or re-run prepare-build from it); nothing was written.`);
    } else if ((spec.spec_identity?.local_spec_id != null || packet.spec?.local_spec_id != null)
      && !campaignIdentitiesMatch(campaignSpecIdentity(spec), packet.spec)) {
      addIssue(result.errors, "spec.derive.spec_identity_mismatch", "CampaignSpec identity (spec_identity.map_id/local_spec_id) does not match the packet identity. Point spec.local_path at this campaign's spec (or re-run prepare-build from it); nothing was written.");
    }
  }

  const load = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug });
  if (load.status !== "ok") {
    const where = result.campaigns_path || PAGE_KIT_CAMPAIGNS_REL_PATH;
    const messages = {
      target_repo_missing: `Target repo does not exist: ${packet.assembly?.target_repo || "(assembly.target_repo not set)"}.`,
      file_missing: `${where} does not exist. Scaffold the campaign first (setup: campaign-init writes the file), then derive.`,
      entry_missing: `${where} has no entry for "${publicRouteSlug || "<public-route-slug>"}". Scaffold the route first (setup: campaign-init registers it), then derive.`,
      invalid_json: `${where} is not valid JSON; repair the file, then derive.`,
      root_not_object: `${where} root must be an object keyed by public route slug; repair the file, then derive.`,
      entry_not_object: `${where}["${publicRouteSlug}"] must be an object; repair the entry, then derive.`,
    };
    addIssue(result.errors, "spec.derive.entry_missing", messages[load.status] || `${where} entry is unavailable (${load.status}).`, { target_status: load.status });
  }
  if (result.errors.length) return result;

  // The write lands on the file the spec path RESOLVES to, and that file must
  // live inside the campaign's own boundary: the directory spec.local_path
  // names (a spec exported beside the campaign folder, as start/prepare-build
  // record it) or the target repo (the in-repo canonical file #432 proposes).
  // A symlinked spec.local_path pointing anywhere else would otherwise let a
  // checked-in link redirect the write into another file while the output
  // names the legitimate path.
  const realSpecPath = realpathSync(specPath);
  const realTargetRepo = realpathSync(targetRepo);
  const realSpecDir = realpathSync(dirname(specPath));
  const inside = (root) => realSpecPath === root || realSpecPath.startsWith(`${root}${sep}`);
  if (!inside(realTargetRepo) && !inside(realSpecDir)) {
    addIssue(result.errors, "spec.derive.spec_escapes_boundary", `${specPath} resolves to ${realSpecPath}, outside both its own directory ${realSpecDir} and the target repo ${realTargetRepo}. spec derive writes only inside the campaign's own boundary; nothing was written.`);
    return result;
  }
  result.spec_path = realSpecPath;

  // The Assembly Report doctor would read: its waivers[] decide whether the
  // SDK pin is under a named-human decision derive must not reverse, and its
  // stage ledger whether a terminal build now predates the spec.
  let report = null;
  let workspace = null;
  let waiversUnknown = false;
  try {
    const explicitReport = isNonEmptyString(args.report) ? resolve(args.report) : null;
    if (explicitReport && !(existsSync(explicitReport) && statSync(explicitReport).isFile())) {
      // The cause; the consequence (the pin waits, reason waivers_unknown)
      // is reported by the plan against the field it affects.
      addIssue(result.warnings, "spec.derive.report_unreadable", `--report ${singleLineField(explicitReport)} is not a file; waivers recorded on the Assembly Report were not consulted, so the SDK pin is not derived this run.`);
    }
    workspace = resolveCampaignWorkspace(packetPath, {
      packet,
      followContextPointer: true,
      reportPath: explicitReport ?? undefined,
    });
    report = readJsonIfExists(workspace.reportPath);
    result.report_path = workspace.reportPath;
  } catch (error) {
    waiversUnknown = true;
    addIssue(result.warnings, "spec.derive.report_unreadable", `The Assembly Report could not be read (${singleLineDetail(error.message)}); waivers recorded there were not consulted, so the SDK pin is not derived this run.`);
  }
  if (isNonEmptyString(args.report) && !(existsSync(resolve(args.report)) && statSync(resolve(args.report)).isFile())) waiversUnknown = true;
  const entry = load.entry;
  const targetLoad = { status: "ok", public_route_slug: publicRouteSlug, target_path: PAGE_KIT_CAMPAIGNS_REL_PATH, entry };
  const waivers = Array.isArray(report?.waivers) ? report.waivers : [];
  const waivedGates = [evaluatePageKitSdkVersion({ spec, targetLoad, waivers })]
    .filter((gate) => gate.status === "waived")
    .map((gate) => ({ scope: gate.scope, waived_by: gate.waiver?.waived_by || null }));

  // The page tree: assembly.output_dir when the packet declares it, else
  // page-kit's src/<route>/. Its files must also resolve inside the target
  // repo; a linked-out directory reads as no page tree.
  const declaredOutputDir = optionalString(packet.assembly?.output_dir);
  const outputDir = declaredOutputDir ? resolve(targetRepo, declaredOutputDir) : join(targetRepo, "src", publicRouteSlug);
  result.page_tree = relative(targetRepo, outputDir).split(sep).join("/") || ".";
  let pageFiles = null;
  try {
    if (existsSync(outputDir)) {
      const realOutputDir = realpathSync(outputDir);
      if (realOutputDir === realTargetRepo || realOutputDir.startsWith(`${realTargetRepo}${sep}`)) pageFiles = listPageKitPageFiles(realOutputDir, publicRouteSlug);
      else addIssue(result.warnings, "spec.derive.page_tree_escapes_repo", `${outputDir} resolves to ${realOutputDir}, outside the target repo; routes were not read from it.`);
    }
  } catch (error) {
    addIssue(result.errors, "spec.derive.page_tree_unreadable", `The page tree under ${result.page_tree}/ could not be read (${singleLineDetail(error.message)}); nothing was written.`);
    return result;
  }
  const packetBindings = new Map();
  for (const page of Array.isArray(packet.source_html?.pages) ? packet.source_html.pages : []) {
    const pageId = optionalString(page?.page_id);
    const targetPath = optionalString(page?.page_kit?.target_path);
    if (pageId && targetPath && !packetBindings.has(pageId)) packetBindings.set(pageId, targetPath);
  }

  // Every local refusal above (packet, spec, entry, boundary, page tree)
  // precedes the store read: the preflight run stops here, before the token
  // is sent anywhere. And the read, when asked for, must have succeeded
  // before anything is written: a run that wrote the repo half and quietly
  // skipped the store half would read as "derived" to an operator who asked
  // for both.
  if (storeRead?.status === "preflight") {
    result.status = "preflight";
    return result;
  }
  // Every local precondition has returned by here, so a spec that vanished
  // during the read reports as spec_missing above, never as this; the guard
  // on errors keeps that true if a check ever moves below this line.
  if (storeRead?.expected && !result.errors.length && (storeRead.expected.spec_path !== result.spec_path || storeRead.expected.public_route_slug !== result.public_route_slug)) {
    addIssue(result.errors, "spec.derive.packet_changed_underneath", `The packet changed while the store was being read (it now names ${result.spec_path} for route "${result.public_route_slug}", not the spec and route checked before the read); nothing was written. Derive again.`);
    return result;
  }
  if (storeRead && storeRead.status !== "ok") {
    const codes = { credential_unavailable: "store_credential_unavailable", credential_missing: "store_credential_missing", credential_invalid: "store_credential_invalid", unauthorized: "store_unauthorized", not_found: "store_not_found", unreachable: "store_unreachable", invalid: "store_response_invalid" };
    addIssue(result.errors, `spec.derive.${codes[storeRead.status] || "store_unreachable"}`, `${storeRead.detail} Nothing was written.`, { subdomain: storeRead.subdomain, token_source: storeRead.token_env ? `env:${storeRead.token_env}` : "gateway:login" });
    return result;
  }
  const plan = planSpecDerive({ spec, entry, pageFiles, packetBindings, waivedGates, waiversUnknown, publicRouteSlug });
  let storeChanged = false;
  if (storeRead) {
    const storePlan = planStoreProfileDerive({ spec, store: storeRead.store, pages: storeRead.pages, pagesStatus: storeRead.pages_status, pagesDetail: storeRead.pages_detail, subdomain: storeRead.subdomain });
    plan.changes.push(...storePlan.changes);
    plan.unchanged.push(...storePlan.unchanged);
    plan.not_derived.push(...storePlan.not_derived);
    storeChanged = storePlan.changes.length > 0;
    result.store.store_read = "ok";
    result.store.pages_read = storeRead.pages_status;
    result.store.primary_domain = typeof storeRead.store?.primary_domain === "string" && storeRead.store.primary_domain.trim() ? storeRead.store.primary_domain.trim() : null;
    if (storePlan.domain_changed) {
      addIssue(result.warnings, "spec.derive.store_domain_changed", `The store at ${result.store.admin_api} has primary domain ${storePlan.domain_changed.after}, but the spec's campaign.store_url named ${storePlan.domain_changed.before}. If --from-store ${storeRead.subdomain} is this campaign's store, the spec was stale and the diff above is the correction; if it is not, the diff is another merchant's profile: restore the spec and derive again with the right subdomain.`, storePlan.domain_changed);
    }
  }
  result.changes = plan.changes;
  result.unchanged = plan.unchanged;
  result.not_derived = plan.not_derived;
  result.not_in_target = plan.not_in_target;
  result.stale_hints = plan.stale_hints;
  for (const row of plan.not_derived) {
    addIssue(result.warnings, `spec.derive.${row.reason}`, `${row.field} was not derived: ${row.detail}`, { field: row.field, reason: row.reason, ...(row.page_id ? { page_id: row.page_id } : {}) });
  }
  for (const hint of plan.stale_hints) {
    addIssue(result.warnings, "spec.derive.routing_hint_stale", `page "${hint.page_id}" carries sdk_hints.meta_tags.${hint.tag} ${JSON.stringify(hint.value)}, but page "${hint.target_page_id}" now derives to ${JSON.stringify(hint.derived_route)}. Routing hints are a Map projection derive does not rewrite; re-save the Map (or edit the hint) so the built meta tag and doctor's expectation agree.`, hint);
  }
  for (const block of plan.created_blocks || []) {
    addIssue(result.warnings, "spec.derive.analytics_block_created", `${block} ${dryRun ? "would be" : "is"} created from the repo's id: the spec ${dryRun ? "would then declare" : "now declares"} an analytics contract, so QA expects that tag to fire instead of treating analytics as advisory.`);
  }

  // What a write entails is said in both modes, so a dry run previews the
  // warnings a real run would carry: a lossy round trip, a build now stale,
  // a projection now stale.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/^\s*\{\r?\n([ \t]+)"/)?.[1] ?? "  ";
  const trailing = /\r?\n$/.test(text) ? eol : "";
  const serialize = (document) => `${JSON.stringify(document, null, indent).replace(/\n/g, eol)}${trailing}`;
  const would = dryRun ? "would be" : "was";
  if (plan.changes.length) {
    if (serialize(spec) !== text) {
      addIssue(result.warnings, "spec.derive.file_reformatted", `${result.spec_path} ${would} re-serialized with ${indent === "\t" ? "tab" : `${indent.length}-space`} indentation; formatting outside the derived fields (key order, whitespace, number spelling) may differ from the original. Review the file diff before committing.`);
    }
    if (plan.changes.some((row) => row.page_id)) {
      addIssue(result.warnings, "spec.derive.projection_stale", `A page route ${dryRun ? "would move" : "moved"}, and the packet's page-kit projection (source_html.pages[].page_kit) and the Build Context were prepared from the old routes. Re-run ${cmd("prepare-build")} (or start) before the next build so they describe the routes the spec carries.`);
    }
    if (stageIsTerminal(report?.stages?.assembly?.status)) {
      addIssue(result.warnings, "spec.derive.build_stale", `The Assembly Report records a terminal build (stages.assembly.status ${report.stages.assembly.status}) rendered from the spec ${dryRun ? "this would rewrite" : "just rewritten"}. Re-run the build stage before polish, deploy or QA if a route or the pin moved; QA correlates its verdict against the spec identity the sidecars carry.`);
      result.next = `${cmd("doctor")} --packet ${shellToken(packetPath)}, then rebuild: set stages.assembly.status back to "pending" on the Assembly Report and run ${cmd("next")} --packet ${shellToken(packetPath)}`;
    }
  }

  if (plan.changes.length && !dryRun) {
    // The identity the sidecars bound to the spec BEFORE this write, so the
    // re-bind below can tell "bound to the spec being replaced" from "already
    // drifted" and only ever moves the former.
    const beforeRawHash = createHash("sha256").update(text).digest("hex");
    const beforeMaterialHash = specMaterialHash(spec);
    // The plan already refused every path its containers cannot take, so a
    // throw here is a defect in this toolkit rather than in the spec; it is
    // still a structured error, never a crash past the --json contract.
    try {
      applySpecDerive(spec, plan);
    } catch (error) {
      addIssue(result.errors, "spec.derive.spec_invalid", `The CampaignSpec could not take the derived values (${singleLineDetail(error.message)}); nothing was written.`);
      return result;
    }
    const serialized = serialize(spec);
    // Staged through a temp file created with the original's mode bits and
    // renamed over the spec, so an interrupted write can never leave it
    // half-written and a private spec is never staged world-readable. The
    // spec is re-read just before the rename: an edit made underneath this
    // run (an authored change in another tool) is refused rather than
    // overwritten with a document derived from the earlier read.
    const tmpPath = join(dirname(result.spec_path), `.${basename(result.spec_path)}.${randomUUID()}.tmp`);
    try {
      const specMode = statSync(result.spec_path).mode & 0o7777;
      // `mode` on create is masked by the umask (a 0664 spec would be
      // staged 0644); the chmod makes the bits exact. The spec is re-read
      // AFTER the temp file is staged so the window between the check and
      // the rename is the smallest this process can make it without a lock.
      writeFileSync(tmpPath, serialized, { flag: "wx", mode: specMode });
      chmodSync(tmpPath, specMode);
      if (readFileSync(result.spec_path, "utf8") !== text) {
        addIssue(result.errors, "spec.derive.spec_changed_underneath", `${result.spec_path} changed while spec derive was running; nothing was written. Derive again to plan against the current file.`);
        return result;
      }
      renameSync(tmpPath, result.spec_path);
    } catch (error) {
      addIssue(result.errors, "spec.derive.write_failed", `${result.spec_path} could not be written (${singleLineDetail(error.message)}); nothing was written.`);
      return result;
    } finally {
      rmSync(tmpPath, { force: true });
    }
    result.written = true;
    // The Build Context and the Assembly Report carry the spec's identity
    // (raw and material hashes) from prepare-build, and QA's verdict is
    // correlated against the material hash by the bundle check. Each sidecar
    // that was bound to the spec just replaced is re-bound to the new one;
    // one that already carried another identity is left as it is and named.
    const afterRawHash = createHash("sha256").update(serialized).digest("hex");
    const afterMaterialHash = specMaterialHash(spec);
    const boundToOld = (raw, material) => raw === beforeRawHash || material === beforeMaterialHash;
    // A sidecar is re-bound only when it names the spec being written: two
    // packets sharing a target repo can carry byte-identical spec exports,
    // and a matching hash alone would let one packet's derive re-bind the
    // other's sidecar to a spec it never used.
    const namesThisSpec = (recorded) => {
      if (!isNonEmptyString(recorded)) return false;
      try {
        return realpathSync(resolve(targetRepo, recorded)) === realSpecPath;
      } catch {
        return false;
      }
    };
    const contextPath = workspace?.contextPath || null;
    let context = null;
    try {
      context = contextPath ? readJsonIfExists(contextPath) : null;
    } catch (error) {
      result.rebound.build_context = false;
      addIssue(result.warnings, "spec.derive.identity_not_rebound", `The Build Context could not be read (${singleLineDetail(error.message)}); its spec identity was not updated. Re-run prepare-build before QA so the bundle correlates.`);
    }
    if (isObject(context?.spec)) {
      if (!namesThisSpec(context.spec.path)) {
        result.rebound.build_context = false;
        addIssue(result.warnings, "spec.derive.identity_not_rebound", "The Build Context names a different spec file than the one derive wrote (another packet's, or a moved export); it was left as it is. Re-run prepare-build before QA so the bundle correlates.");
      } else if (boundToOld(context.spec.hash, context.spec.material_hash)) {
        try {
          writeJsonAtomic(contextPath, { ...context, spec: { ...context.spec, hash: afterRawHash, material_hash: afterMaterialHash } });
          result.rebound.build_context = true;
        } catch (error) {
          result.rebound.build_context = false;
          addIssue(result.warnings, "spec.derive.identity_not_rebound", `The Build Context's spec identity could not be updated (${singleLineDetail(error.message)}); re-run prepare-build before QA so the bundle correlates.`);
        }
      } else {
        result.rebound.build_context = false;
        addIssue(result.warnings, "spec.derive.identity_not_rebound", `The Build Context's spec identity was already bound to a different spec than the one derive replaced; it was left as it is. Re-run prepare-build before QA so the bundle correlates.`);
      }
    }
    if (report && isObject(report.identity) && workspace) {
      if (!namesThisSpec(report.inputs?.spec_path)) {
        result.rebound.assembly_report = false;
        addIssue(result.warnings, "spec.derive.identity_not_rebound", "The Assembly Report names a different spec file than the one derive wrote (another packet's, or a moved export); it was left as it is. Re-run prepare-build before QA so the bundle correlates.");
      } else if (boundToOld(report.identity.spec_hash, report.identity.spec_material_hash)) {
        try {
          // The identity is re-checked on the report as it is re-read for
          // the commit, so a prepare-build that re-bound it in the meantime
          // is left alone.
          const committed = commitAssemblyReport(workspace, (current) => (
            isObject(current.identity) && boundToOld(current.identity.spec_hash, current.identity.spec_material_hash)
              ? { ...current, identity: { ...current.identity, spec_hash: afterRawHash, spec_material_hash: afterMaterialHash } }
              : null
          ), {
            command: "spec derive",
            staleReason: `spec derive rewrote the CampaignSpec after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
          });
          result.rebound.assembly_report = committed.written;
          if (!committed.written) addIssue(result.warnings, "spec.derive.identity_not_rebound", "The Assembly Report's spec identity moved while spec derive was running; it was left as it is. Re-run prepare-build before QA so the bundle correlates.");
        } catch (error) {
          result.rebound.assembly_report = false;
          addIssue(result.warnings, "spec.derive.identity_not_rebound", `The Assembly Report's spec identity could not be updated (${singleLineDetail(error.message)}); re-run prepare-build before QA so the bundle correlates.`);
        }
      } else {
        result.rebound.assembly_report = false;
        addIssue(result.warnings, "spec.derive.identity_not_rebound", `The Assembly Report's spec identity was already bound to a different spec than the one derive replaced; it was left as it is. Re-run prepare-build before QA so the bundle correlates.`);
      }
    }
    // The retained doctor snapshot (if any) now predates the spec it judged.
    // commitAssemblyReport stamps it when the report was re-bound; every
    // other path stamps it here.
    try {
      markDoctorSidecarStale(targetRepo, {
        command: "spec derive",
        reason: `spec derive rewrote the CampaignSpec after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
      });
    } catch (error) {
      addIssue(result.warnings, "spec.derive.doctor_sidecar_not_marked", `The CampaignSpec was written, but the retained doctor snapshot could not be marked stale (${singleLineDetail(error.message)}); re-run doctor before trusting it.`);
    }
  }
  // A store-derived value now sits in the spec and not yet in the repo:
  // doctor's page_kit.store_profile gate names page-kit sync as the repair,
  // so the next step says it first.
  if (storeChanged && !dryRun) {
    result.next = `${cmd("page-kit")} sync --packet ${shellToken(packetPath)}, then ${result.next}`;
  }
  // `partial`: what the repo states was written (or would be), but a derived
  // field the repo cannot state remains. Exit stays 0 — the write itself
  // succeeded — and the warnings say what to repair.
  result.status = plan.not_derived.length
    ? "partial"
    : plan.changes.length ? (dryRun ? "dry_run" : "derived") : "unchanged";
  result.ok = true;
  return result;
}

export function specDeriveTextLines(result) {
  const lines = [`Status: ${result.status === "dry_run" ? "DRY RUN" : String(result.status || "unknown").toUpperCase()}`];
  if (result.spec_path) lines.push(`Spec: ${singleLineField(result.spec_path)}`);
  if (result.campaigns_path) lines.push(`Target: ${singleLineField(result.campaigns_path)}[${result.public_route_slug || "<public-route-slug>"}]${result.page_tree ? `, page tree ${singleLineField(result.page_tree)}/` : ""}`);
  if (result.store) {
    lines.push(`Store: ${singleLineField(result.store.endpoint || result.store.admin_api)} (token ${singleLineField(result.store.token_source)}${result.store.primary_domain ? `, primary domain ${singleLineField(result.store.primary_domain)}` : ""}${result.store.pages_read && result.store.pages_read !== "ok" ? `, pages ${result.store.pages_read}` : ""})`);
  }
  if (result.errors?.length) {
    lines.push("Errors:");
    for (const issue of result.errors) lines.push(`- ${formatIssueSummary(issue)}`);
    return lines;
  }
  if (result.status === "partial") {
    lines.push(`Partial: ${result.not_derived.map((row) => row.field).join(", ")} could not be derived from the ${result.store ? "repo or the store" : "repo"} (see Warnings).`);
  }
  if (result.changes?.length) {
    lines.push(result.dry_run
      ? `Changes (dry run, nothing written): ${result.changes.length}`
      : `Changes written: ${result.changes.length}`);
    for (const row of result.changes) {
      lines.push(`- ${row.field}: ${formatDeriveValue(row.before)} -> ${formatDeriveValue(row.after)}  (from ${singleLineField(row.source)})`);
    }
  } else {
    lines.push(`Changes: none (every derived field the repo${result.store ? " and the store" : ""} states already matches)`);
  }
  if (result.unchanged?.length) lines.push(`Unchanged: ${result.unchanged.map((row) => row.field).join(", ")}`);
  if (result.not_in_target?.length) lines.push(`Not in target (left as they are): ${result.not_in_target.join(", ")}`);
  if (result.warnings?.length) {
    lines.push("Warnings:");
    for (const issue of result.warnings) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  if (result.next) lines.push(`Next: ${result.next}`);
  return lines;
}

const PAGE_KIT_PARITY_FLAGS = Object.freeze(["packet", "json", "report"]);

// Local proof mode, second half: the served development output was proven;
// this proves that the production render of the same source differs from it
// only in what the environment gate contributes, and that the Campaign Cart
// pin is the same in both. Both renders go to temp directories through the
// target's own page-kit; nothing under the target is written except the
// result on the Assembly Report.
export function pageKitParityCommand(args, options = {}) {
  const unknown = Object.keys(args).filter((key) => key !== "_" && !PAGE_KIT_PARITY_FLAGS.includes(key));
  if (unknown.length) {
    throw refused(`Unknown flag${unknown.length > 1 ? "s" : ""} for page-kit parity: ${unknown.map((key) => `--${key}`).join(", ")}. Known flags: ${PAGE_KIT_PARITY_FLAGS.map((key) => `--${key}`).join(", ")}.`);
  }
  if (args.report === true) throw refused("Missing value for --report");
  const packetPath = resolve(requireArg(args, "packet"));
  const result = {
    ok: false,
    action: "page-kit parity",
    status: "blocked",
    packet_path: packetPath,
    public_route_slug: null,
    target_repo: null,
    proven_root: "_site/",
    report_path: null,
    written: false,
    parity: null,
    errors: [],
    warnings: [],
    next: `${cmd("doctor")} --packet ${shellToken(packetPath)}`,
  };
  let packet;
  try {
    packet = readJson(packetPath);
  } catch (error) {
    addIssue(result.errors, "local_proof.parity.packet_invalid", `Build Packet ${packetPath} could not be read as JSON: ${singleLineDetail(error.message)}`);
    return result;
  }
  if (!isObject(packet)) {
    addIssue(result.errors, "local_proof.parity.packet_invalid", `Build Packet ${packetPath} must be a JSON object.`);
    return result;
  }
  const publicRouteSlug = normalizePublicRouteSlug(packet.campaign?.public_route_slug);
  const targetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  result.public_route_slug = publicRouteSlug || null;
  result.target_repo = targetRepo;
  if (!publicRouteSlug) {
    addIssue(result.errors, "local_proof.parity.route_slug_missing", "The packet has no campaign.public_route_slug; the rendered output to compare lives at _site/<public_route_slug>/ and cannot be named.");
    return result;
  }
  if (!isLocalServePacket(packet)) {
    addIssue(result.errors, "local_proof.parity.not_local_serve", `deploy.target is ${JSON.stringify(packet.deploy?.target ?? null)}, not local-serve. Production parity compares the served DEVELOPMENT build in _site/ with a production render of the same source; under any other target _site/ is the production build itself and there is nothing to prove. Set it with ${cmd("qa")} policy set --packet ${shellToken(packetPath)} --deploy-target local-serve if this campaign is proven locally.`);
    return result;
  }
  if (!targetRepo || !existsSync(targetRepo)) {
    addIssue(result.errors, "local_proof.parity.target_missing", `Target repo does not exist: ${packet.assembly?.target_repo || "(assembly.target_repo not set)"}.`);
    return result;
  }
  const workspace = resolveCampaignWorkspace(packetPath, {
    packet,
    reportPath: isNonEmptyString(args.report) ? resolve(args.report) : undefined,
    followContextPointer: false,
  });
  result.report_path = workspace.reportPath;
  const report = readJsonIfExists(workspace.reportPath);
  if (!report) {
    addIssue(result.errors, "local_proof.parity.report_missing", `No Assembly Report at ${workspace.reportPath}; run prepare-build/start first, then the build stage in development.`);
    return result;
  }
  if (!stageIsTerminal(report?.stages?.assembly?.status)) {
    addIssue(result.errors, "local_proof.parity.build_pending", `stages.assembly.status is ${JSON.stringify(report?.stages?.assembly?.status ?? null)}; run the build stage first (${LOCAL_PROOF_BUILD_COMMAND}) and record it on the Assembly Report.`);
    return result;
  }
  const environment = recordedBuildEnvironment(report);
  if (environment !== LOCAL_PROOF_BUILD_ENVIRONMENT) {
    addIssue(result.warnings, LOCAL_PROOF_BUILD_ENVIRONMENT_SCOPE, environment
      ? `${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} is "${singleLineField(environment)}", not "${LOCAL_PROOF_BUILD_ENVIRONMENT}". If _site/ is a production build, the comparison below fails as proven_output_stale on the first environment-gated line; rebuild with ${LOCAL_PROOF_BUILD_COMMAND} and record the environment.`
      : `${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} is not recorded. The build stage under local-serve renders the development environment (${LOCAL_PROOF_BUILD_COMMAND}) and records it there; the comparison below assumes _site/ is that render.`);
  }
  const load = loadPageKitCampaignEntry({ targetRepo, publicRouteSlug });
  const expectedSdkVersion = load.status === "ok" && typeof load.entry?.sdk_version === "string" ? load.entry.sdk_version : null;
  if (!expectedSdkVersion) {
    addIssue(result.warnings, "local_proof.parity.sdk_version_unread", `${PAGE_KIT_CAMPAIGNS_REL_PATH}[${publicRouteSlug}].sdk_version could not be read (${load.status}); the rendered pin is checked for consistency across environments but not against the data file.`);
  }
  // Tests inject the render+compare step: the hermetic fixture has no
  // page-kit installed, and the recording path must still be exercised.
  const runCheck = typeof options.runProductionParityCheck === "function" ? options.runProductionParityCheck : runProductionParityCheck;
  const parity = runCheck({
    targetRepo,
    slug: publicRouteSlug,
    provenRoot: join(targetRepo, "_site"),
    expectedSdkVersion,
  });
  parity.build_fingerprint = optionalString(report?.stages?.assembly?.build_fingerprint) || null;
  parity.proven_root = "_site/";
  result.parity = parity;
  if (parity.status === "unavailable") {
    addIssue(result.errors, "local_proof.parity.unavailable", `Production parity could not be checked: ${parity.summary}`);
    return result;
  }
  // Recorded on the assembly stage's free-form evidence, pass or fail, so
  // doctor reports the same row on every run until the next check replaces
  // it. The doctor sidecar is stamped stale: its local_proof rows predate this.
  try {
    commitAssemblyReport(workspace, (current) => {
      const assembly = isObject(current?.stages?.assembly) ? current.stages.assembly : null;
      if (!assembly) throw new Error("the Assembly Report has no stages.assembly to record parity on.");
      const evidence = isObject(assembly.evidence) ? assembly.evidence : {};
      const localProof = isObject(evidence.local_proof) ? evidence.local_proof : {};
      return {
        ...current,
        stages: {
          ...current.stages,
          assembly: { ...assembly, evidence: { ...evidence, local_proof: { ...localProof, production_parity: parity } } },
        },
      };
    }, {
      command: "page-kit parity",
      staleReason: `Local proof production parity was recorded after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
    });
    result.written = true;
  } catch (error) {
    // A pass that did not land on the report is not a pass the pipeline can
    // read: doctor would still say unrecorded, so the command must not say
    // otherwise. Exit 2 either way; the comparison itself is still reported.
    addIssue(result.errors, "local_proof.parity.report_not_written", `Parity was checked (${parity.status}) but could not be recorded on ${workspace.reportPath}: ${singleLineDetail(error.message)}. Doctor keeps reporting ${LOCAL_PROOF_PARITY_SCOPE} as unrecorded until a run records it.`);
  }
  if (parity.status === "fail") {
    addIssue(result.errors, LOCAL_PROOF_PARITY_SCOPE, `Production parity FAILED: ${parity.summary} ${LOCAL_PROOF_NEVER_EDIT_RULE}`);
    return result;
  }
  if (!result.written) {
    result.status = "record_failed";
    return result;
  }
  result.status = "pass";
  result.ok = true;
  result.next = `commit the source, then open the PR: the preview deploy is the second check. ${cmd("doctor")} --packet ${shellToken(packetPath)} reports ${LOCAL_PROOF_PARITY_SCOPE} from the recorded result.`;
  return result;
}

export function pageKitParityTextLines(result) {
  const lines = [`Status: ${String(result.status || "unknown").toUpperCase()}`];
  if (result.target_repo) lines.push(`Target: ${singleLineField(result.target_repo)} (${result.proven_root}${result.public_route_slug || "<public-route-slug>"}/ proven in development)`);
  if (result.report_path) lines.push(`Report: ${singleLineField(result.report_path)}${result.written ? ` (${LOCAL_PROOF_PARITY_FIELD} recorded)` : ""}`);
  const parity = result.parity;
  if (parity && (parity.status === "pass" || parity.status === "fail")) {
    lines.push(`Parity: ${parity.summary}`);
    for (const page of Array.isArray(parity.pages) ? parity.pages : []) {
      const gated = page.gated_inserted_lines + page.gated_removed_lines;
      lines.push(`- ${page.route}: pin ${page.sdk_version ?? "not rendered"}; environment-gated lines ${gated}${page.gated_hosts?.length ? ` (${page.gated_hosts.join(", ")})` : ""}`);
    }
    if (parity.first_difference) {
      const diff = parity.first_difference;
      lines.push(`First non-gated difference: ${diff.kind} at ${diff.route}${diff.path ? ` (${diff.path}${diff.line ? ` line ${diff.line}` : ""})` : ""}: ${diff.detail}`);
    }
  }
  if (result.errors?.length) {
    lines.push("Errors:");
    for (const issue of result.errors) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  if (result.warnings?.length) {
    lines.push("Warnings:");
    for (const issue of result.warnings) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  if (result.next) lines.push(`Next: ${result.next}`);
  return lines;
}

export function pageKitSyncTextLines(result) {
  const lines = [`Status: ${result.status === "dry_run" ? "DRY RUN" : String(result.status || "unknown").toUpperCase()}`];
  if (result.campaigns_path) lines.push(`Target: ${singleLineField(result.campaigns_path)}[${result.public_route_slug || "<public-route-slug>"}]`);
  if (result.spec_path) lines.push(`Spec: ${result.spec_path}`);
  if (result.errors?.length) {
    lines.push("Errors:");
    for (const issue of result.errors) lines.push(`- ${formatIssueSummary(issue)}`);
    return lines;
  }
  if (result.status === "partial") {
    lines.push(`Partial: ${result.not_synced.map((row) => row.field).join(", ")} could not be made spec-authoritative (see Warnings); doctor will still block on ${result.not_synced.length === 1 ? "it" : "them"}.`);
  }
  if (result.changes?.length) {
    lines.push(result.dry_run
      ? `Changes (dry run, nothing written): ${result.changes.length}`
      : `Changes written: ${result.changes.length}`);
    for (const row of result.changes) {
      lines.push(`- ${row.field}: ${formatSyncValue(row.before)} -> ${formatSyncValue(row.after)}  (from ${row.source})`);
    }
  } else {
    lines.push("Changes: none (every governed field the spec carries already matches)");
  }
  if (result.unchanged?.length) lines.push(`Unchanged: ${result.unchanged.map((row) => row.field).join(", ")}`);
  if (result.not_in_spec?.length) lines.push(`Not in spec (left as they are): ${result.not_in_spec.join(", ")}`);
  if (result.warnings?.length) {
    lines.push("Warnings:");
    for (const issue of result.warnings) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  if (result.next) lines.push(`Next: ${result.next}`);
  return lines;
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

function specPackageRecords(spec) {
  const records = [];
  const add = (pkg, source) => {
    if (!isObject(pkg)) return;
    const ref = firstNonEmptyString(pkg.ref_id, pkg.package_id != null ? String(pkg.package_id) : null, pkg.id != null ? String(pkg.id) : null);
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

function specPackageRefs(spec) {
  return new Set(specPackageRecords(spec).map((record) => String(record.ref)));
}

function specShippingRefs(spec) {
  const refs = new Set();
  const add = (method) => {
    const ref = firstNonEmptyString(method?.ref_id, method?.id != null ? String(method.id) : null, method?.shipping_method_id != null ? String(method.shipping_method_id) : null);
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
    const ref = firstNonEmptyString(offer?.ref_id, offer?.id != null ? String(offer.id) : null);
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

function extractRenderedPackageRefs(content) {
  const refs = new Set();
  for (const match of content.matchAll(/\bdata-next-package-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/\bdata-package-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/["']?packageId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi)) {
    addRenderedRef(refs, match[1] || match[2] || match[3]);
  }
  return refs;
}

function extractRenderedShippingRefs(content) {
  const refs = new Set();
  for (const match of content.matchAll(/\bdata-next-shipping-id=["']([^"']+)["']/gi)) addRenderedRef(refs, match[1]);
  for (const match of content.matchAll(/["']?shippingId["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi)) {
    addRenderedRef(refs, match[1] || match[2] || match[3]);
  }
  return refs;
}

function addRenderedRef(refs, value) {
  const ref = String(value || "").trim();
  if (/^[A-Za-z0-9_-]+$/.test(ref)) refs.add(ref);
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
  // The packet rule is exact (canonical form only, mirroring the schema
  // pattern) and it is the same rule every other stage reads the packet by,
  // so a near miss ("/ruggie", "//ruggie//") is blocked here and honoured
  // nowhere — the silent-disarm split this check exists to close.
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
          ? `CampaignSpec page "${page.page_id}" is template stock and not built yet: ${page.skip_reason} The build stage materialises it from the ${optionalString(stockDecision.template_family) || "selected"} family's own page; it joins the previewable routes once its built HTML exists.`
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

// The orchestration stage contract lives in orchestration-stage-contract.mjs so
// report producers, validators, the `next` picker and the Assembly Report's
// derived summary share one deterministic source for stage order, terminal
// status prefixes, stage owners and CLI-stage/report-key translation.
const POLISH_GATE_BUILD_RERUN_CODES = Object.freeze(new Set([
  "polish.assembly_source_package_fingerprint_missing",
  "polish.assembly_source_package_stale",
]));


function polishGateRequiresBuild(polishGate) {
  return polishGate?.status === "blocked" && POLISH_GATE_BUILD_RERUN_CODES.has(polishGate.code);
}

// Gate → issue, the one way. Doctor reports a blocked gate under the gate's
// own code — the theme gate as a warning, because its fix happens in build —
// and `next` reports the same gate under `next.<stage>.<code>` as an error
// for the stage it blocks. The polish gates ride on the issue's `detail`, so
// "doctor's only errors are the polish gates" is read back from the issues
// themselves rather than decoded from a code prefix.
export function gateIssue(kind, gate, { stage = null } = {}) {
  const commands = (gate?.required_actions || []).map((action) => action?.command).filter(Boolean);
  const run = commands.length ? ` Run: ${commands.join(" | ")}` : "";
  const requiredAction = commands.length ? ` Required action: ${commands.join(" | ")}.` : "";
  switch (kind) {
    case "theme_gate":
      return stage
        ? { severity: "error", code: `next.${stage}.theme_gate`, message: `${gate.reason}${run}`, detail: { theme_gate: gate } }
        : { severity: "warning", code: gate.code, message: `${gate.reason} Polish/deploy/QA are gated until resolved.${run}`, detail: null };
    case "polish_gate":
      return {
        severity: "error",
        code: stage ? `next.${stage}.${gate.code}` : gate.code,
        message: `${gate.reason}${requiredAction || " Run next-campaigns-polish before QA."}`,
        detail: { polish_gate: gate },
      };
    case "polish_checkpoint_gate":
      return {
        severity: "error",
        code: stage ? `next.${stage}.${gate.code}` : gate.code,
        message: stage ? gate.reason : `${gate.reason}${requiredAction}`,
        detail: { polish_checkpoint_gate: gate },
      };
    default:
      throw new Error(`Unknown gate kind: ${kind}`);
  }
}

function pushGateIssue({ errors, warnings }, issue) {
  addIssue(issue.severity === "error" ? errors : warnings, issue.code, issue.message, issue.detail);
}

function addPolishGateErrors(errors, polishGate, stage) {
  if (!polishGate || polishGate.status !== "blocked") return;
  pushGateIssue({ errors }, gateIssue("polish_gate", polishGate, { stage }));
}

function addPolishCheckpointGateErrors(errors, gate, stage) {
  if (!gate || gate.status !== "blocked") return;
  pushGateIssue({ errors }, gateIssue("polish_checkpoint_gate", gate, { stage }));
}

// Doctor's errors are only the polish gates' projections: the issues carry
// the gate they came from, so this reads data, not a code prefix.
export function doctorErrorsAreOnlyPolishGate(errors = []) {
  return errors.length > 0 && errors.every((issue) => Boolean(issue?.detail?.polish_gate || issue?.detail?.polish_checkpoint_gate));
}

function reportStageBlockerIssues(reportStage, fallbackCode, fallbackMessage) {
  const blockers = Array.isArray(reportStage?.blockers) ? reportStage.blockers : [];
  if (!blockers.length) return [{ code: fallbackCode, message: fallbackMessage }];
  return blockers.map((blocker) => ({
    code: blocker.code || fallbackCode,
    message: blocker.message || fallbackMessage,
    detail: blocker,
  }));
}

function filesystemPathsMatch(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  if (isAbsoluteHttpUrl(left) || isAbsoluteHttpUrl(right)) return left === right;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    const leftStats = statSync(resolvedLeft);
    const rightStats = statSync(resolvedRight);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

function designSourceReferenceMismatches(expected, expectedArtifactPath, actual, actualArtifactPath) {
  if (!isObject(expected) || !isObject(actual)) return ["reference"];
  const mismatches = [];
  for (const field of ["schema_version", "sha256", "material_fingerprint"]) {
    if (expected[field] !== actual[field]) mismatches.push(field);
  }
  const expectedPath = resolveFromFile(expectedArtifactPath, expected.path);
  const actualPath = resolveFromFile(actualArtifactPath, actual.path);
  if (!filesystemPathsMatch(expectedPath, actualPath)) mismatches.push("path");
  return mismatches;
}

function nextPrepareBuildBindingIssues({
  packet,
  packetPath,
  context,
  contextPath,
  report,
  reportPath,
  targetRepo,
  explicitReport,
}) {
  if (!isObject(packet?.design_source_package)) return [];
  const issues = [];
  const push = (code, message, detail = null) => issues.push({ code, message, detail });

  if (!isObject(context)) {
    push(
      "next.prepare_build.context_missing",
      `Build Context is unavailable at ${contextPath}; the Design Source Package lifecycle report cannot be bound to the current packet.`,
    );
  } else {
    const contextPacketPointer = optionalString(context.packet_path);
    const contextPacketPath = contextPacketPointer ? resolve(targetRepo, contextPacketPointer) : null;
    if (!contextPacketPath || !filesystemPathsMatch(contextPacketPath, packetPath)) {
      push(
        "next.prepare_build.context_packet_mismatch",
        "Build Context packet_path does not identify the current Build Packet; refusing to select a lifecycle report from that context.",
        { expected_packet_path: packetPath, recorded_packet_path: contextPacketPath },
      );
    }

    const contextDspMismatches = designSourceReferenceMismatches(
      packet.design_source_package,
      packetPath,
      context.design_source_package,
      contextPath,
    );
    if (contextDspMismatches.length) {
      push(
        "next.prepare_build.context_dsp_mismatch",
        `Build Context Design Source Package reference does not match the current packet (${contextDspMismatches.join(", ")}).`,
        { mismatched_fields: contextDspMismatches },
      );
    }

    if (!explicitReport && !optionalString(context.report_path)) {
      push(
        "next.prepare_build.context_report_missing",
        "Build Context does not record report_path; packet-only next cannot prove which lifecycle report belongs to this packet.",
      );
    }
  }

  if (!isObject(report)) return issues;

  const reportPacketPointer = optionalString(report.inputs?.packet_path);
  const reportPacketPath = reportPacketPointer ? resolve(targetRepo, reportPacketPointer) : null;
  if (!reportPacketPath || !filesystemPathsMatch(reportPacketPath, packetPath)) {
    push(
      "next.prepare_build.report_packet_mismatch",
      "Assembly Report inputs.packet_path does not identify the current Build Packet.",
      { expected_packet_path: packetPath, recorded_packet_path: reportPacketPath },
    );
  }

  const reportContextPointer = optionalString(report.inputs?.context_path);
  const reportContextPath = reportContextPointer ? resolve(targetRepo, reportContextPointer) : null;
  if (!reportContextPath || !filesystemPathsMatch(reportContextPath, contextPath)) {
    push(
      "next.prepare_build.report_context_mismatch",
      "Assembly Report inputs.context_path does not identify the selected Build Context.",
      { expected_context_path: contextPath, recorded_context_path: reportContextPath },
    );
  }

  const expectedMapId = optionalString(packet.spec?.map_id);
  const expectedSlug = optionalString(packet.campaign?.public_route_slug);
  const recordedMapId = optionalString(report.identity?.map_id);
  const recordedSlug = optionalString(report.identity?.public_route_slug);
  if (!campaignIdentitiesMatch(packet.spec, report.identity) || recordedSlug !== expectedSlug) {
    push(
      "next.prepare_build.report_campaign_mismatch",
      "Assembly Report campaign identity does not match the current Build Packet.",
      {
        // Failed identity fields are diagnostic data, never adopted evidence.
        expected: { map_id: expectedMapId, local_spec_id: packet.spec?.local_spec_id ?? null, public_route_slug: expectedSlug },
        recorded: { map_id: recordedMapId, local_spec_id: report.identity?.local_spec_id ?? null, public_route_slug: recordedSlug },
      },
    );
  }

  const reportDspMismatches = designSourceReferenceMismatches(
    packet.design_source_package,
    packetPath,
    report.design_source_package,
    reportPath,
  );
  const contextDspMismatches = isObject(context)
    ? designSourceReferenceMismatches(
        context.design_source_package,
        contextPath,
        report.design_source_package,
        reportPath,
      )
    : [];
  const dspMismatches = [...new Set([...reportDspMismatches, ...contextDspMismatches])];
  if (dspMismatches.length) {
    push(
      "next.prepare_build.report_dsp_mismatch",
      `Assembly Report Design Source Package reference does not match the current packet/context (${dspMismatches.join(", ")}).`,
      { mismatched_fields: dspMismatches },
    );
  }

  return issues;
}

function uniquePrepareBuildBlockers(blockers) {
  const unique = new Map();
  for (const blocker of blockers) {
    if (!isObject(blocker)) continue;
    // Stage and top-level report lists intentionally mirror blockers. Collapse
    // only complete semantic duplicates: field/detail/index evidence must not
    // disappear merely because the user-facing header is the same.
    const canonicalizeBlocker = (value) => {
      if (Array.isArray(value)) return value.map(canonicalizeBlocker);
      if (!isObject(value)) return value;
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => [key, canonicalizeBlocker(value[key])]),
      );
    };
    const key = JSON.stringify(canonicalizeBlocker(blocker));
    if (!unique.has(key)) unique.set(key, blocker);
  }
  return [...unique.values()];
}

function prepareBuildGateIssue(report, { required = false, reportPath = null, bindingIssues = [] } = {}) {
  const stage = report?.stages?.prepare_build;
  if (bindingIssues.length) {
    return {
      stage,
      status: "mismatched",
      blocked: true,
      binding_failure: true,
      issues: bindingIssues,
      reason: `The selected Build Context or Assembly Report is not bound to the current Build Packet (${bindingIssues.map((issue) => issue.code).join(", ")}); refusing to bypass prepare-build.`,
    };
  }
  if (!stage) {
    if (!required) return null;
    const location = reportPath ? ` at ${reportPath}` : "";
    return {
      stage: null,
      status: "missing",
      blocked: true,
      reason: report
        ? `The lifecycle assembly report${location} does not record stages.prepare_build; continuing would bypass the prepare-build gate.`
        : `The lifecycle assembly report${location} is unavailable; continuing would bypass the prepare-build gate. Restore the recorded report or rerun prepare-build/start before continuing.`,
    };
  }
  const status = String(stage.status || "");
  const stageBlockers = Array.isArray(stage.blockers) ? stage.blockers : [];
  const topLevelDspBlockers = (Array.isArray(report?.blockers) ? report.blockers : [])
    .filter((blocker) => blocker?.code === "DESIGN_SOURCE_PACKAGE_NOT_READY");
  const contradictoryBlockers = uniquePrepareBuildBlockers([...stageBlockers, ...topLevelDspBlockers]);
  // report.status is derived from the stages on every write, so a report that
  // has been through commitAssemblyReport reads "blocked" if and only if some
  // stage is blocked, and a blocked QA or doctor stage beside a terminal
  // prepare_build is not a contradiction. The case below can only be a report
  // written before the summary was derived (or hand-edited since): a
  // top-level "blocked" that no recorded stage explains. It is still a
  // contradiction to refuse on, and the next commit of the report heals it.
  const blockedStatusFromPreDerivationReport = report?.status === "blocked" && !anyAssemblyReportStageBlocked(report);
  if (stageIsTerminal(status) && (
    blockedStatusFromPreDerivationReport
    || stageBlockers.length > 0
    || topLevelDspBlockers.length > 0
  )) {
    const contradictions = [
      ...(blockedStatusFromPreDerivationReport ? ["report.status=blocked"] : []),
      ...(stageBlockers.length ? [`stages.prepare_build.blockers=${stageBlockers.length}`] : []),
      ...(topLevelDspBlockers.length ? [`top-level DSP blockers=${topLevelDspBlockers.length}`] : []),
    ];
    return {
      stage,
      status,
      blocked: true,
      blockers: contradictoryBlockers,
      reason: `Stage "prepare_build" claims terminal status "${status}" but retained blocking evidence contradicts it (${contradictions.join(", ")}); resolve the report before continuing.`,
    };
  }
  if (stageIsTerminal(status)) return null;
  return {
    stage,
    status,
    blocked: stageIsBlocked(status),
    reason: stageIsBlocked(status)
      ? `Stage "prepare_build" is blocked (status="${status}"); resolve prepare-build blockers before continuing.`
      : `Stage "prepare_build" has status "${status || "(unset)"}"; rerun prepare-build before continuing.`,
  };
}

function addPrepareBuildGateErrors(errors, report, gate = prepareBuildGateIssue(report)) {
  if (!gate) return false;
  // Doctor's own checks run BEFORE this gate merges in the recorded
  // prepare-build blockers: doctorPacket calls validatePacket/runDoctorChecks
  // first and then surfaces the gate, and nextStage seeds its error list from
  // doctor.errors before calling this (doctor and the ladder agree, #238).
  // Two dedup keys keep the merged list from reporting one problem twice:
  // an exact [code, message, detail] match drops a blocker doctor already
  // surfaced verbatim, and a page-level match drops a MISSING_SOURCE_PAGE
  // blocker when the source-coverage check already named the same missing
  // page under its own code (source_html.pages.coverage).
  const seen = new Set(errors.map((issue) => JSON.stringify([issue.code, issue.message, issue.detail ?? null])));
  const coveredPageIds = new Set(
    errors
      .filter((issue) => issue.code === "source_html.pages.coverage")
      .map((issue) => issue.detail?.page_id)
      .filter(isNonEmptyString),
  );
  const addUnique = (code, message, detail) => {
    const key = JSON.stringify([code, message, detail ?? null]);
    if (seen.has(key)) return;
    if (code === "MISSING_SOURCE_PAGE" && isNonEmptyString(detail?.page_id) && coveredPageIds.has(detail.page_id)) return;
    seen.add(key);
    addIssue(errors, code, message, detail);
  };
  if (Array.isArray(gate.issues) && gate.issues.length) {
    for (const issue of gate.issues) addUnique(issue.code, issue.message, issue.detail || null);
    return true;
  }
  const blockerSource = Array.isArray(gate.blockers) && gate.blockers.length
    ? { blockers: gate.blockers }
    : gate.stage;
  for (const issue of reportStageBlockerIssues(
    blockerSource,
    gate.stage ? "next.prepare_build" : "next.prepare_build.report_unavailable",
    gate.reason,
  )) {
    addUnique(issue.code, issue.message, issue.detail || null);
  }
  return true;
}

/**
 * Self-decide which stage should run next given the current report + doctor
 * state. Pure function — reads no filesystem, no network.
 *
 * @param {object|null} report  Assembly report (may be null when doctor
 *                              failed before the report was written).
 * @param {object|null} doctor  Doctor result. When `doctor.ok === false`,
 *                              short-circuits with "doctor-blocked" after
 *                              the earlier prepare-build prerequisite is
 *                              satisfied, so the caller surfaces doctor
 *                              errors instead of advancing. Any future
 *                              stage-specific doctor signal logic should
 *                              live AFTER this gate, not before.
 *
 * @returns {{ stage: string, reason: string, blocked?: boolean }}
 *   An object with four possible shapes:
 *
 *   1. `{ stage: "doctor-blocked", reason }` — doctor reported errors.
 *      No `blocked` field. Caller should surface the doctor errors.
 *   2. `{ stage: "prepare-build", reason, blocked: true }` —
 *      prepare-build has not reached a terminal status. Caller should
 *      surface the report blockers and ask the operator to rerun
 *      prepare-build/start before continuing.
 *   3. `{ stage: "<setup|build|polish|deploy|qa>", reason, blocked? }`
 *      — next stage to run. `blocked: true` is present and `true` when
   *      the returned stage's recorded status in the report is "blocked".
   *      The picker still returns the stage
 *      (rather than treating it as done) so the orchestrator surfaces
 *      the blocker rather than silently skipping past it. When
 *      `blocked` is absent or `false`, the stage is in its normal
 *      ready-to-run state.
 *   4. `{ stage: "done", reason }` — every stage in terminal status.
 *      No `blocked` field.
 *
 *   `reason` is a human-readable string describing why this stage was
 *   chosen, intended for direct display in CLI / JSON output so the
 *   operator can audit picker decisions.
 *
 *   CONSUMERS: always check `result.stage` first (special values
 *   "doctor-blocked" and "done" need their own handling), then read
 *   `result.blocked === true` to detect the surfaced-blocker case.
 */
const RUN_RECORD_QA_DIGEST_LIMIT = 8;

// Hash whatever QA verdict the report's qa stage currently points at, so a Run
// Record can be checked against the evidence the report carries NOW rather than
// against whatever it carried when the record was written.
// Digests of the verdicts the report records, best-effort: an unreadable
// hint contributes no digest, which fails open to "outdated" rather than to
// a false match.
function currentQaVerdictDigestsForReport(report, reportPath) {
  const digests = new Set();
  // Lazy on purpose, and the check follows the add: once the limit is
  // reached the next candidate is never pulled, read or hashed.
  for (const candidate of iterateQaVerdicts({ report, reportPath, withDigest: true })) {
    if (candidate.source === "assembly_report" && candidate.sha256) digests.add(candidate.sha256);
    if (digests.size >= RUN_RECORD_QA_DIGEST_LIMIT) break;
  }
  return [...digests];
}

// Declared order-path depths that ask for no purchase at all. A packet may
// legitimately declare one: `--test-order off` diagnostics stay intentional.
const ORDER_PATH_DEPTHS_WITHOUT_PURCHASE = new Set(["off", "none", "skip", "not_required", "unspecified"]);

/**
 * Compare the purchase depth a packet DECLARES against the depth QA actually
 * exercised. Four states, and the difference between the last two is the whole
 * safety argument:
 *
 * - `not_required` the declared depth asks for no order path.
 * - `satisfied`    QA executed at least one order path.
 * - `unmet`        QA recorded a purchase-proof summary showing zero order
 *                   paths while the packet declares a depth that needs one.
 *                   This is the `--test-order off` run being presented as
 *                   common-depth proof.
 * - `unknown`      the qa stage carries no purchase-proof summary at all —
 *                   every report written before this change. Unknown is
 *                   ADVISORY ONLY. Treating it as unmet would retroactively
 *                   un-finish every existing campaign on upgrade.
 */
// The declared depth an operator is told to re-prove. When the packet and the
// report disagree there is no single value, so both are named from the
// structured field rather than left for the reader to dig out of prose.
function describeDeclaredDepth(purchaseProof) {
  const depths = purchaseProof?.declared_depths;
  if (depths && depths.packet && depths.report && depths.packet.toLowerCase() !== depths.report.toLowerCase()) {
    return `The build packet declares an order path depth of "${depths.packet}" and the assembly report mirrors "${depths.report}"`;
  }
  return `The declared order path depth is "${purchaseProof?.declared_depth || "unspecified"}"`;
}

export function assessPurchaseProofCoverage({ packet = null, report = null } = {}) {
  const packetDepth = optionalString(packet?.qa?.proof_policy?.order_path_depth);
  const reportDepth = optionalString(report?.proof_policy?.order_path_depth);
  // The packet is author intent and the report is the assembly-time echo of it,
  // so the packet wins — but only when the two actually agree. A hand-edit or a
  // stale report mirror can leave them disagreeing, and silently preferring the
  // packet then lets a corrupted pair decide the gate. Neither value is
  // trustworthy in that state, so the coverage is genuinely unknown: advisory,
  // never a silent unblock, and named loudly enough that an operator can see
  // which two artifacts to reconcile.
  const drift = orderPathDepthDrift(packet, report);
  if (drift) {
    return {
      state: "unknown",
      // Neither side is trustworthy, so there is no single declared depth to
      // report; both values are exposed structurally so a consumer never has
      // to parse the reason to learn that the two artifacts disagree.
      declared_depth: null,
      declared_depths: { packet: drift.packet, report: drift.report },
      // The reason names the one command that reconciles them (the same text
      // doctor's warning carries); the packet path is substituted by `next`.
      reason: orderPathDepthDriftText({ packetDepth: drift.packet, reportDepth: drift.report }),
    };
  }
  const declared = packetDepth || reportDepth;
  const declaredDepths = { packet: packetDepth || null, report: reportDepth || null };
  if (!declared || ORDER_PATH_DEPTHS_WITHOUT_PURCHASE.has(declared.toLowerCase())) {
    return {
      state: "not_required",
      declared_depth: declared || null,
      declared_depths: declaredDepths,
      reason: "No order-path depth is declared, so no purchase proof is owed.",
    };
  }
  const summary = report?.stages?.qa?.purchase_proof;
  if (!isObject(summary) || !Number.isInteger(summary.order_paths_executed)) {
    return {
      state: "unknown",
      declared_depth: declared,
      declared_depths: declaredDepths,
      reason: "The assembly report's qa stage records no purchase-proof summary, so the depth QA exercised cannot be read from it.",
    };
  }
  if (summary.order_paths_executed > 0) {
    return {
      state: "satisfied",
      declared_depth: declared,
      declared_depths: declaredDepths,
      reason: `QA executed ${summary.order_paths_executed} order path(s) against a declared "${declared}" depth.`,
    };
  }
  return {
    state: "unmet",
    declared_depth: declared,
    declared_depths: declaredDepths,
    reason: `QA recorded zero executed order paths, so a declared "${declared}" order-path depth is not proved. A \`--test-order off\` run is a diagnostic, not purchase proof; re-run QA at the declared depth or change the declared depth deliberately.`,
  };
}

function pickNextStage(report, { errors = [], derived = null }, prepareBuildGate, purchaseProof = null) {
  const polishGate = derived?.polish_gate || evaluatePolishGate({ report });
  const polishCheckpointGate = derived?.polish_checkpoint_gate || null;
  // prepare-build is the earliest lifecycle prerequisite. Surface its
  // authoritative blockers before later doctor findings so a blocked Design
  // Source Package can never be mistaken for permission to enter setup/build.
  if (prepareBuildGate) {
    return {
      stage: "prepare-build",
      reason: prepareBuildGate.reason,
      blocked: true,
    };
  }

  if (errors.length && !doctorErrorsAreOnlyPolishGate(errors)) {
    return {
      stage: "doctor-blocked",
      reason: `Doctor reported ${errors.length} blocker(s); resolve them before any stage runs.`,
    };
  }

  if (!report || !report.stages) {
    return {
      stage: "setup",
      reason: "No assembly report on disk yet. Start with setup (assembly report should appear after prepare-build).",
    };
  }

  if (polishGate.status === "blocked") {
    if (polishGateRequiresBuild(polishGate)) {
      return {
        stage: "build",
        reason: polishGate.reason,
      };
    }
    return {
      stage: "polish",
      reason: polishGate.reason,
      blocked: true,
    };
  }

  if (polishCheckpointGate?.status === "blocked") {
    return {
      stage: "polish",
      reason: polishCheckpointGate.reason,
      blocked: true,
    };
  }

  for (const cliStage of NEXT_STAGE_ORDER) {
    const reportKey = reportKeyForCliStage(cliStage);
    const stage = report.stages[reportKey];
    if (!stage) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is not recorded in the assembly report; run "${cliStage}" next.`,
      };
    }
    const status = String(stage.status || "");
    if (stageIsBlocked(status)) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" is blocked (status="${status}"); unblock before continuing.`,
        blocked: true,
      };
    }
    // Match by prefix so "completed_with_warnings" and future suffixes
    // (e.g. "completed_partial") count as terminal.
    const isTerminal = STAGE_TERMINAL_STATUS_PREFIXES.some((t) => status.startsWith(t));
    if (!isTerminal) {
      return {
        stage: cliStage,
        reason: `Stage "${reportKey}" has status "${status || "(unset)"}"; run "${cliStage}" next.`,
      };
    }
    // A terminal QA status is not the same claim as purchase proof. QA finalizes
    // a verdict and records a terminal status even when no order path ran, so a
    // `--test-order off` diagnostic used to carry the pipeline to "done" against
    // a packet declaring common depth. Only an EXPLICIT zero blocks: an absent
    // summary is unknown and stays advisory.
    if (cliStage === "qa" && purchaseProof?.state === "unmet") {
      return {
        stage: "qa",
        reason: purchaseProof.reason,
      };
    }
  }

  return {
    stage: "done",
    reason: "All stages are in a terminal status (completed / completed_with_warnings / skipped). Pipeline is complete.",
  };
}

export function nextStage(stage, args, ambient = null) {
  if (stage !== null && !NEXT_STAGE_ORDER.includes(stage)) {
    throw refused(`Unknown next stage: ${stage}. Accepted stages: ${NEXT_STAGE_ORDER.join(", ")}.`);
  }
  const packetPath = resolve(requireArg(args, "packet"));
  // A custom prepare-build report is recorded on the Build Context relative
  // to the target repo. Packet-only `next` must follow that durable pointer;
  // silently falling back to the absent default report erases the earliest
  // lifecycle gate from the orchestration decision.
  const { packet, targetRepo, contextPath, reportPath, doctorOutPath } = resolveCampaignWorkspace(packetPath, {
    contextPath: args.context ? resolve(args.context) : undefined,
    reportPath: args.report ? resolve(args.report) : undefined,
    followContextPointer: true,
  });
  const report = readJsonIfExists(reportPath);
  // Doctor reads the same sidecars through the same resolver (an operator's
  // explicit --context / --report passed through, the defaults derived), so
  // its prepare-build gate and its stage pick are this command's: `next`
  // consumes them from the result instead of evaluating a second time.
  const doctor = doctorPacket(packetPath, {
    contextPath: args.context ? resolve(args.context) : undefined,
    reportPath: args.report ? resolve(args.report) : undefined,
  });
  const prepareBuildGate = doctor.derived?.prepare_build_gate || null;
  // #171: `next` recomputes doctor state on every call; persist that fresh
  // snapshot so the retained sidecar can never stay a green lie from an
  // earlier stage while the campaign degrades (the dogfood target sat
  // QA-BLOCKED while its committed sidecar still showed 0 errors). A full
  // rewrite also clears any stale stamp. Opt out with --no-write.
  if (args["no-write"] !== true) {
    try {
      // Atomic like the assembly report: a torn sidecar would be a corrupted
      // freshness artifact — the exact green-lie shape this refresh exists to
      // prevent (Kilo review, PR #176). Stamped generated_by: "next" (#312).
      writeDoctorSidecar(doctorOutPath, doctor, { command: NEXT_PRODUCER });
    } catch {
      // sidecar refresh is best-effort; orchestration must not fail on it
    }
  }
  const themeGate = doctor.derived?.theme_gate || null;
  const polishGate = doctor.derived?.polish_gate || evaluatePolishGate({ report });
  const polishCheckpointGate = doctor.derived?.polish_checkpoint_gate || null;
  // Packet 03 (INV-5 first slice): compare the ledger's self-report against
  // the repo's artifacts before any recommendation goes out. Additive:
  // `divergences[]` appears on the result only when at least one divergence
  // exists, so clean-repo output is byte-identical to the pre-change shape.
  // A foreign/unbound report is not evidence about this packet, so it cannot
  // participate in divergence detection or override prepare-only recovery.
  const divergences = prepareBuildGate?.binding_failure
    ? []
    : detectLedgerDivergence(report, packet, targetRepo);
  // Every return path runs through this finalizer so the machine-readable
  // contract is uniform: `gates` (pass/blocked/waived/not_applicable per
  // gate) and `next_actions` (exact commands — not prose) are always present,
  // and the recommendation is recorded on the active run session for
  // deviation telemetry.
  const prepareBuildRecoveryPrompt = divergences.length
    ? `The assembly report's ledger and the repository's artifacts disagree (see divergences[]). Inspect both sides and decide which is right before acting. Do not rerun \`${cmd("prepare-build")}\` or \`${cmd("start")}\` on the strength of the ledger alone.`
    : prepareBuildGate?.binding_failure
      ? prepareBuildGate.reason
      : prepareBuildGate?.stage
        ? `Resolve the prepare-build blockers recorded in the assembly report, then rerun \`${cmd("prepare-build")}\` or \`${cmd("start")}\` with the same \`--spec\`/\`--map-id\`, \`--source\`, \`--target\` and \`--template-family\` as the original run before continuing.`
        : prepareBuildGate?.reason || "Restore the lifecycle assembly report before continuing.";
  // Closeout recognition and purchase-proof coverage are both derived from
  // artifacts already on disk. Both are best-effort reads: orchestration must
  // keep working when the records directory is absent (the normal case — it is
  // machine-local and git-ignored) or unreadable.
  const purchaseProof = assessPurchaseProofCoverage({ packet, report });
  let runRecordCloseout = null;
  try {
    runRecordCloseout = assessRunRecordCloseout({
      records: readRunRecordsForTarget(dirname(packetPath)),
      packet,
      report,
      currentQaVerdictDigests: currentQaVerdictDigestsForReport(report, report ? reportPath : null),
      qaVerdictRecorded: qaVerdictPathHints(report).length > 0,
    });
  } catch {
    // Any failure here leaves the closeout unassessed, which keeps the original
    // unconditional required action. Fail toward demanding the record.
    runRecordCloseout = null;
  }
  const finalize = (result) => {
    Object.defineProperty(result, PROGRESS_OBSERVATION, { value: {
      workspace: { packet, packetPath, targetRepo, contextPath, reportPath },
      context: readJsonIfExists(contextPath), report, doctor,
    } });
    if (divergences.length) result.divergences = divergences;
    result.gates = buildNextGates({ doctor, report, themeGate, polishGate, prepareBuildGate, packetPath });
    result.next_actions = buildNextActions({ result, packetPath, packet, themeGate, polishGate, polishCheckpointGate, prepareBuildGate, ambient, runRecordCloseout, purchaseProof, brandContract: doctor.derived?.brand_contract || null, context: readJsonIfExists(contextPath), targetRepo });
    recordNextRecommendation(ambient, result);
    return result;
  };
  const doctorHasOnlyPolishGateErrors = doctorErrorsAreOnlyPolishGate(doctor.errors);
  const errors = [];
  const warnings = doctor.warnings.map((issue) => withPacketSubstitutedIssue(issue, packetPath));
  const ready = [...doctor.ready];
  if (!doctor.ok && !doctorHasOnlyPolishGateErrors) errors.push(...doctor.errors.map((issue) => withPacketSubstitutedIssue(issue, packetPath)));

  // Explicit stage requests are still downstream of prepare-build. Do not
  // construct the requested stage's prompt or executable actions when the
  // authoritative prepare gate is blocked or unavailable; return the same
  // recovery-only shape as automatic stage selection.
  if (NEXT_STAGE_ORDER.includes(stage) && prepareBuildGate) {
    addPrepareBuildGateErrors(errors, report, prepareBuildGate);
    return finalize({
      ok: false,
      status: "blocked",
      stage: "prepare-build",
      requested_stage: stage,
      reason: prepareBuildGate.reason,
      errors,
      warnings,
      ready,
      prompt: prepareBuildRecoveryPrompt,
      stage_blocked: true,
    });
  }

  // Slice 3 Phase 2: when no stage was passed, self-decide. The orchestration
  // loop is: agent calls `next`, gets a stage + prompt, does the work,
  // updates the assembly report's stages.<name>.status, then calls `next`
  // again. Each call re-reads state from disk so the loop is idempotent
  // and recoverable across sessions / machines.
  let picked = null;
  if (!stage) {
    picked = doctor.next;
    if (picked.stage === "doctor-blocked") {
      return finalize({
        ok: false,
        status: "blocked",
        stage: "doctor-blocked",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: `Resolve the doctor errors above before continuing. Re-run \`${cmd("doctor")} --packet <path> --write\` to record the recovery, then \`${cmd("next")} --packet <path>\` to advance.`,
      });
    }
    if (picked.stage === "prepare-build") {
      addPrepareBuildGateErrors(errors, report, prepareBuildGate);
      return finalize({
        ok: false,
        status: "blocked",
        stage: "prepare-build",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        // Packet 03: when the artifacts contradict the ledger, do NOT tell
        // the operator to start over — rerunning prepare-build/start is the
        // most destructive documented recovery, and the ledger alone is not
        // trustworthy evidence that it is needed.
        prompt: prepareBuildRecoveryPrompt,
        stage_blocked: true,
      });
    }
    if (picked.stage === "done") {
      return finalize({
        ok: true,
        status: checkpointExceptionPresent(doctor.derived) ? "ready_with_waivers" : (warnings.length ? "ready_with_warnings" : "ready"),
        stage: "done",
        reason: picked.reason,
        errors,
        warnings,
        ready,
        prompt: `Pipeline complete. All stages in the assembly report are in a terminal status. If you need to re-run a stage, set its status back to "pending" in the report and call \`next\` again. If a run session is active, finish it with \`${cmd("run")} end\` so the Run Record is assembled and the session closes.`,
      });
    }
    stage = picked.stage;
  }

  let prompt = "";
  if (stage === "setup") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok && !doctorHasOnlyPolishGateErrors) addIssue(errors, "next.setup.doctor", "Doctor is blocked; resolve packet errors before setup.");
    prompt = setupPrompt(packetPath, contextPath, reportPath, packet);
  } else if (stage === "build") {
    addPrepareBuildGateErrors(errors, report);
    if (!doctor.ok && !doctorHasOnlyPolishGateErrors) addIssue(errors, "next.build.doctor", "Doctor is blocked; resolve packet errors before build.");
    if (doctor.derived?.scaffold_required) addIssue(errors, "next.build.setup", doctor.derived.scaffold_reason || "Setup is required before build.");
    prompt = buildPrompt(packetPath, contextPath, reportPath, packet, doctor.derived);
  } else if (stage === "polish") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.polish.report", "Assembly report is required before polish.");
    const assemblyStatus = report?.stages?.assembly?.status || "";
    if (!assemblyStatus.startsWith("completed")) addIssue(errors, "next.polish.assembly", `Assembly status is "${assemblyStatus || "missing"}"; polish expects completed assembly or an explicit blocked/skipped handoff.`);
    if (polishGateRequiresBuild(polishGate)) addPolishGateErrors(errors, polishGate, "polish");
    addThemeGateErrors(errors, themeGate, "polish");
    prompt = polishPrompt(packetPath, reportPath, packet);
  } else if (stage === "deploy") {
    addPrepareBuildGateErrors(errors, report);
    // Slice 3 Phase 2: deploy is an out-of-band step (Netlify / CF Pages /
    // etc.) but it's still a stage in the orchestration loop because the
    // agent needs to know when to fire it and what to record afterwards.
    if (!report) addIssue(errors, "next.deploy.report", "Assembly report is required before deploy.");
    addPolishGateErrors(errors, polishGate, "deploy");
    addPolishCheckpointGateErrors(errors, polishCheckpointGate, "deploy");
    addThemeGateErrors(errors, themeGate, "deploy");
    prompt = deployPrompt(packetPath, reportPath, packet);
  } else if (stage === "qa") {
    addPrepareBuildGateErrors(errors, report);
    if (!report) addIssue(errors, "next.qa.report", "Assembly report is required before QA.");
    const deployUrl = packet.deploy?.preview_url || packet.deploy?.production_url;
    if (!deployUrl) addIssue(errors, "next.qa.deploy_url", "QA requires deploy.preview_url or deploy.production_url.");
    addPolishGateErrors(errors, polishGate, "qa");
    addPolishCheckpointGateErrors(errors, polishCheckpointGate, "qa");
    addThemeGateErrors(errors, themeGate, "qa");
    prompt = qaPrompt(packetPath, reportPath, packet);
  }
  const status = errors.length
    ? "blocked"
    : checkpointExceptionPresent(doctor.derived)
      ? "ready_with_waivers"
      : warnings.length
        ? "ready_with_warnings"
        : "ready";
  const result = {
    ok: errors.length === 0,
    status,
    stage,
    errors,
    warnings,
    ready,
    prompt,
  };
  // When the caller invoked `next` with no stage, surface the picker's
  // reasoning so the agent / operator can see WHY this stage was chosen
  // (vs them having to re-derive it from report state themselves).
  if (picked) {
    result.picked_reason = picked.reason;
    if (picked.stage_blocked) result.stage_blocked = true;
  }
  return finalize(result);
}

// Theme gate enforcement for stages past build. A blocked theme gate is an
// ERROR (status "blocked") at polish/deploy/qa: the brand layer is applied
// during build, so once a generatable theme exists the pipeline must not
// advance past build until it is applied or explicitly waived. Mirrors the
// dogfood failure where "needs_review" stayed advisory and starter-blue
// commerce pages shipped through polish, deploy, and a green QA verdict.
function addThemeGateErrors(errors, themeGate, stage) {
  if (!themeGate || themeGate.status !== "blocked") return;
  pushGateIssue({ errors }, gateIssue("theme_gate", themeGate, { stage }));
}

// Gate summary every `next` response carries: one entry per gate with a
// deterministic status, so an agent reads gate state from data instead of
// parsing error prose.
// Doctor's gate objects declare their commands with the `--packet <packet>`
// placeholder; `next` copies them into gates[] and errors[].detail, and its
// own next_actions[] already carry the real packet. One rule for every copy:
// the placeholder is substituted on the way in, on a copy, so the doctor
// result (and the sidecar written from it) keeps the template.
function withPacketSubstituted(gate, packetPath) {
  if (!gate || typeof gate !== "object" || !Array.isArray(gate.required_actions)) return gate;
  return {
    ...gate,
    required_actions: gate.required_actions.map((action) => (
      action && typeof action.command === "string"
        ? { ...action, command: substitutePacket(action.command, packetPath) }
        : action
    )),
  };
}

function withPacketSubstitutedIssue(issue, packetPath) {
  const gate = issue?.detail?.checkpoint_gate;
  if (!gate || typeof gate !== "object") return issue;
  return { ...issue, detail: { ...issue.detail, checkpoint_gate: withPacketSubstituted(gate, packetPath) } };
}

function buildNextGates({ doctor, report, themeGate, polishGate, prepareBuildGate = prepareBuildGateIssue(report), packetPath = null }) {
  return [
    {
      id: "doctor",
      status: doctor.ok ? "pass" : "blocked",
      reason: doctor.ok ? "Doctor has no blocking errors." : `Doctor reported ${doctor.errors.length} blocker(s).`,
    },
    {
      id: "prepare_build",
      status: prepareBuildGate ? "blocked" : "pass",
      reason: prepareBuildGate ? prepareBuildGate.reason : "prepare_build stage is terminal.",
    },
    ...(Array.isArray(doctor?.derived?.checkpoint_gates)
      ? doctor.derived.checkpoint_gates.map((gate) => withPacketSubstituted(gate, packetPath))
      : []),
    ...(doctor?.derived?.polish_checkpoint_gate
      ? [withPacketSubstituted(doctor.derived.polish_checkpoint_gate, packetPath)]
      : []),
    {
      id: "theme_gate",
      status: themeGate?.status || "not_applicable",
      reason: themeGate?.reason || "No theme gate evaluation available.",
      code: themeGate?.code || null,
      waiver: themeGate?.waiver || null,
      required_actions: themeGate?.required_actions || [],
    },
    ...(polishGate?.owned_checkpoint_only
      ? []
      : [{
          id: "polish_gate",
          status: polishGate?.status || "not_applicable",
          reason: polishGate?.reason || "No polish gate evaluation available.",
          code: polishGate?.code || null,
          waiver: polishGate?.waiver || null,
          required_actions: polishGate?.required_actions || [],
        }]),
  ];
}

// A token-less campaign passes the theme gate and then blocks browser QA.
//
// `evaluateThemeGate` returns pass/`theme_gate.nothing_generatable` when no
// brand theme can be generated: there is nothing to apply, so there is nothing
// to gate on. But `residueSeverityForThemeGate` reads that same pass as
// "a brand layer is in place", and runs the template-residue checks at BLOCKER
// severity — so the starter family's own palette on the commerce calls to
// action lands as `template-residue:<page>:style:*` blockers at `qa run`. Only
// a waiver downgrades those rows to warn.
//
// Both halves are deliberate and both stay as they are. What was missing is
// that nothing between the passing gate and the blocked verdict said this
// would happen, so the decision got made after a failed QA run rather than
// before it — twice, two different ways. This advisory moves the decision
// forward. It is informational by construction: no `required` flag, no
// command to run, and it waives nothing on the operator's behalf.
// The warning is only true for a family QA actually inspects. A campaign on
// `custom`, `undecided`, or any family the catalog carries no brand contract
// for resolves to no contract, so `templateResidueAssertions` returns before it
// emits a single `template-residue:*:style:*` row and there is no starter
// palette to block on. Telling that operator to waive a gate or hand-author a
// brand layer to clear a block that will never happen is a worse failure than
// the silence this replaces, so the advisory asks the same predicate the
// browser runner asks — `contractHasPaletteResidueChecks` in
// template-brand-contract.mjs — rather than re-deriving it here.
const THEME_STARTER_PALETTE_ACTION_ID = "theme_gate.starter_palette_blocks_qa";
const BRAND_CONTRACT_DEFECT_ACTION_ID = "theme_gate.brand_contract_unreadable";
const THEME_STARTER_PALETTE_STAGES = new Set(["build", "polish", "deploy", "qa"]);

/**
 * What the packet's template family means for palette residue, as three
 * distinct answers rather than one boolean.
 *
 * The distinction that matters is between a family that HAS no contract and a
 * family whose contract is BROKEN. `resolveTemplateBrandContract` separates
 * them for us: it returns null when nothing resolved, and throws with a `code`
 * (`parse_error`, `schema_mismatch`, `extends_cycle`, `extends_missing_parent`,
 * `family_mismatch`) when a contract exists but is defective. Collapsing the
 * throw into "no contract" hid a real defect behind silence — QA rejects such a
 * contract outright with a `template-brand-contract:<family>` blocker, and the
 * operator would have met that for the first time at `qa run`, which is the
 * whole failure this lane exists to stop.
 *
 * Null is not a defect: it is "resolved to no contract", and it covers the
 * unknown/uncertified family AND a privately allowlisted family whose fragment
 * carries no `brandContract` at all. Both mean QA emits no residue rows.
 *
 * `next` never throws over this. A defect becomes its own advisory, in the same
 * shape, naming the family and the error code.
 */
// Everything below is interpolated into a description that prints to a
// terminal and ships in next_actions[] JSON, and all three values ultimately
// come from a packet and a file on disk. None of them is trusted prose.
//
// The family is a filename component (template-brand-contract.<family>.v0.json)
// and every real family — the packet schema's enum and the commerce catalog
// alike — is a lowercase slug, so anything else is not a family we can name.
// The code is reduced to the loader's own enum. The detail is loader-authored
// but quotes file content, so it is folded to one line, stripped of control
// characters, escaped for Markdown, and bounded.
const TEMPLATE_FAMILY_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const BRAND_CONTRACT_ERROR_CODES = new Set([
  "parse_error",
  "schema_mismatch",
  "extends_cycle",
  "extends_missing_parent",
  "family_mismatch",
]);

export function safeFamilyLabel(family) {
  const value = optionalString(family);
  return value && TEMPLATE_FAMILY_SLUG.test(value) ? value : "unknown-family";
}

export function safeBrandContractCode(code) {
  const value = optionalString(code);
  return value && BRAND_CONTRACT_ERROR_CODES.has(value) ? value : "unknown";
}

// A defective contract is not a palette problem and does not wait on the theme
// gate: QA rejects the contract itself, for a family with brand tokens as
// readily as one without. So this advisory is emitted on the contract state
// alone — gating it on `nothing_generatable` would hide it from precisely the
// campaigns that did generate a brand layer.
function brandContractDefectAdvisory(residueState) {
  if (residueState.state !== "defect") return null;
  const family = safeFamilyLabel(residueState.family);
  // A private-only family has no file at contracts/template-brand-contract.
  // <family>.v0.json, so naming that path would send the operator to repair
  // something that was never there. Name it only when it is actually on disk;
  // otherwise point at the fragment that supplied the contract.
  const publicPath = templateBrandContractPath(family);
  const source = publicPath && existsSync(publicPath)
    ? `contracts/template-brand-contract.${family}.v0.json`
    : "the private fragment supplying it";
  return {
    id: BRAND_CONTRACT_DEFECT_ACTION_ID,
    kind: "manual",
    command: null,
    description: `The contract source for family "${family}" exists but could not be read `
      + `(${residueState.code}): ${residueState.detail} Browser QA rejects an unreadable contract outright — it records `
      + `template-brand-contract:${family} as a blocker — so this will stop \`qa run\` regardless of the theme `
      + `gate, and no waiver clears it. Repair ${source} before QA. Until it is readable, whether this `
      + "campaign also ships the starter palette on its commerce pages cannot be determined.",
  };
}

function themeStarterPaletteAdvisory(themeGate, packetPath, residueState) {
  if (themeGate?.code !== "theme_gate.nothing_generatable") return null;
  if (residueState.state !== "inspected") return null;
  const packetArg = shellToken(packetPath || "<packet>");
  return {
    id: THEME_STARTER_PALETTE_ACTION_ID,
    kind: "manual",
    command: null,
    description: "This campaign has no generatable brand tokens, so the theme gate passes "
      + "(theme_gate.nothing_generatable) with no brand layer and the commerce pages keep the starter "
      + "family's own palette. Browser QA does not read that as acceptable: with the gate unwaived it "
      + "runs the template-residue checks at blocker severity, so `qa run` will block on "
      + "template-residue:<page>:style:* rows for the starter call-to-action colour. Decide before QA, "
      + "not after a blocked verdict. Either record an explicit operator waiver — "
      + `\`${cmd("theme")} waive --packet ${packetArg} --reason "<why the starter palette is acceptable>"\` `
      + "— which downgrades those rows to warn severity and keeps the shipped palette visible in the "
      + "verdict; or hand-author the brand layer (write brand-theme.css, list it after next-core.css in "
      + "commerce-page frontmatter styles, rebuild, then record report.theme.status=applied with "
      + "load_order=after-next-core), per docs/brand-theme-bridge.md. This notice waives nothing on its own.",
  };
}

// Packet 03 (INV-5 first slice): the replacement recommendation when the
// ledger and the artifacts disagree. Tells the operator to inspect and
// decide — it resolves nothing, writes nothing, and never claims a stage is
// complete. The forward hint points at the least-destructive plausible path
// implied by the artifact evidence instead of re-setup.
//
// This action is emitted ALONE (see buildNextActions): a divergent packet is
// a stop-and-reconcile state, not a stage with a recommended command.
function divergenceInspectAction(divergences, packetPath) {
  const divergedStages = divergences.map((divergence) => divergence.stage);
  const forwardHint = divergedStages.includes("qa")
    ? "The artifacts include a QA verdict for this campaign, so the campaign may already be built, deployed, and QA'd — verify the artifacts before redoing any stage."
    : divergedStages.includes("deploy")
      ? `If the recorded deploy URL is real and current, the forward path is QA (${cmd("next")} qa --packet ${packetPath}), not re-running earlier stages.`
      : "If the built output is real and current, the forward path is polish/deploy/QA, not re-running setup or build.";
  return {
    id: "divergence_inspect",
    kind: "manual",
    command: null,
    description: `Ledger and artifacts disagree — ${divergences.length} divergence(s) recorded in divergences[]. This is the ONLY next action: stage actions are suppressed while the disagreement stands, because every one of them would be derived from the same contradictory evidence. Inspect both sides (each entry quotes the ledger claim and the artifact evidence) and decide which is right; update the assembly report only after inspection. Do not rerun start/prepare-build or redo completed-looking work on the strength of the ledger alone, and do not treat artifact presence as proof a stage is complete. ${forwardHint} Re-run \`${cmd("next")} --packet ${packetPath} --json\` once the report matches the artifacts to get the normal action list.`,
    required: true,
  };
}

// Executable next actions: exact commands (or explicitly-manual steps), never
// prose-only guidance. Ordering is the execution order an agent should follow.
export function buildNextActions({ result, packetPath, packet, themeGate, polishGate, polishCheckpointGate, prepareBuildGate, ambient, runRecordCloseout = null, purchaseProof = null, brandContract = null, context = null, targetRepo = null }) {
  const actions = [];
  const push = (id, kind, command, description, extras = {}) => actions.push({ id, kind, command, description, stage: result.stage, ...extras });
  const pushPolishCheckpointActions = () => {
    const baseUrl = packet.deploy?.preview_url || packet.deploy?.production_url || "<base-url>";
    for (const action of polishCheckpointGate?.required_actions || []) {
      let command = substitutePacket(action.command, packetPath);
      if (typeof command === "string") {
        command = command.replace("--base-url <url>", `--base-url ${shellToken(baseUrl)}`);
      }
      push(`checkpoint.${action.id}`, action.kind, asInvocation(command), action.description, { required: action.id !== "polish.hidden_eager_media.waive" });
    }
  };
  const divergences = Array.isArray(result.divergences) ? result.divergences : [];
  if (divergences.length) {
    // Packet 03 / Kilo review: when the ledger and the artifacts disagree,
    // reconciliation is the ONLY next action. Every stage-specific action
    // below is derived from the same contradictory evidence, so emitting any
    // of them alongside the inspection hands an agent a command it can follow
    // INSTEAD of inspecting — redeploying, rerunning QA, or (at
    // doctor-blocked) chasing doctor errors that may themselves be artifacts
    // of the stale ledger. Suppressing branch-by-branch would leave the next
    // branch someone adds unguarded; returning here cannot rot that way.
    // The operator reconciles, then re-runs `next` for the normal list.
    const inspect = divergenceInspectAction(divergences, packetPath);
    push(inspect.id, inspect.kind, asInvocation(inspect.command), inspect.description, { required: inspect.required });
    return actions;
  }
  if (result.stage === "doctor-blocked") {
    const checkpointGates = (result.gates || []).filter(
      (gate) => gate?.status === "blocked" && Object.hasOwn(CHECKPOINT_EVALUATORS, gate?.id || ""),
    );
    for (const gate of checkpointGates) {
      for (const action of gate.required_actions || []) {
        const suffix = action.id === "waive_checkpoint" ? "waive" : action.id;
        const command = typeof action.command === "string" ? substitutePacket(action.command, packetPath) : null;
        push(
          `checkpoint.${gate.id}.${suffix}`,
          action.kind,
          asInvocation(command),
          action.description,
          action.id === "waive_checkpoint" ? {} : { required: true },
        );
      }
    }
    push("doctor_recheck", "command", `${cmd("doctor")} --packet ${packetPath} --write --json`, "Record a fresh doctor result after resolving the listed errors.");
    return actions;
  }
  if (result.stage === "prepare-build") {
    if (prepareBuildGate?.binding_failure) {
      push(
        "restore_prepare_build_binding",
        "manual",
        null,
        "Restore or rebind the Build Context and Assembly Report so their packet path, campaign identity, and Design Source Package reference identify this Build Packet. Do not regenerate lifecycle artifacts until their ownership is established.",
        { required: true },
      );
      push(
        "recheck",
        "command",
        `${cmd("next")} --packet ${shellToken(packetPath)} --json`,
        "Re-run next after restoring the recorded artifact bindings.",
      );
      return actions;
    }
    // Packet 03: the "start over" recommendation is the most destructive
    // recovery available and the ledger alone cannot justify it. Divergence
    // already returned above, so reaching here means the ledger and the
    // artifacts agree and the rerun is safe to recommend.
    const rerun = prepareBuildRerunCommand({ packet, packetPath, context, targetRepo });
    push("rerun_prepare_build", "command", rerun.command, ["Rerun prepare-build/start with the original spec, source, and target inputs to clear the recorded blockers.", ...rerun.notes].join(" "));
    return actions;
  }
  // A blocked theme gate owns the action list for any post-build stage: the
  // gate's required actions ARE the next actions.
  if (themeGate?.status === "blocked" && ["polish", "deploy", "qa"].includes(result.stage)) {
    for (const action of themeGate.required_actions) {
      push(`theme_gate.${action.id}`, action.kind, asInvocation(action.command), action.description);
    }
    push("recheck", "command", `${cmd("next")} --packet ${packetPath} --json`, "Re-run next after resolving the theme gate to advance.");
    return actions;
  }
  if (polishGateRequiresBuild(polishGate) && ["build", "polish", "deploy", "qa"].includes(result.stage)) {
    for (const action of polishGate?.required_actions || []) {
      push(`polish_gate.${action.id}`, action.kind, asInvocation(action.command), action.description);
    }
    push("recheck", "command", `${cmd("next")} --packet ${packetPath} --json`, "Re-run next after rebuilding against the current Design Source Package.");
    return actions;
  }
  if ((polishGate?.status === "blocked" || polishCheckpointGate?.status === "blocked")
    && ["deploy", "qa"].includes(result.stage)) {
    const checkpointActionIds = new Set(
      (polishCheckpointGate?.required_actions || [])
        .map((action) => action?.id)
        .filter(Boolean),
    );
    for (const action of polishGate?.required_actions || []) {
      if (checkpointActionIds.has(action?.id)) continue;
      push(`polish_gate.${action.id}`, action.kind, asInvocation(action.command), action.description);
    }
    pushPolishCheckpointActions();
    push("recheck", "command", `${cmd("next")} --packet ${packetPath} --json`, "Re-run next after recording valid Polish evidence.");
    return actions;
  }
  // Ahead of every stage that still has QA in front of it, say what QA will do
  // about the brand layer: that a token-less build blocks on the starter
  // palette (and the two lanes that clear it), or that the family's brand
  // contract cannot be read at all. Both are emitted before the stage actions,
  // so the advisory precedes whatever stage-specific command the branch emits.
  // The blocked-gate branches above return early and keep owning their own
  // action lists: a blocked gate is a different code, and a blocked polish gate
  // is a stop-and-fix state whose own actions come first — these reappear on
  // the next `next` once that gate clears.
  // Doctor resolved the family brand contract once and `next` hands its
  // summary in; a caller without a doctor result resolves the same way.
  const residueState = brandContract || resolveBrandContract(packet?.assembly?.template_family).summary;
  for (const advisory of [brandContractDefectAdvisory(residueState), themeStarterPaletteAdvisory(themeGate, packetPath, residueState)]) {
    if (advisory && THEME_STARTER_PALETTE_STAGES.has(result.stage)) {
      push(advisory.id, advisory.kind, asInvocation(advisory.command), advisory.description);
    }
  }
  if (result.stage === "setup") {
    push("setup_skill", "skill", "next-campaigns-os-setup", "Prepare the target page-kit structure and agent context, then record stages.setup in the assembly report.");
  } else if (result.stage === "build") {
    push("build_skill", "skill", "next-campaigns-build", "Assemble the campaign per the build prompt, then record stages.assembly in the assembly report.");
    if (isLocalServePacket(packet)) {
      push("build_local_proof", "command", LOCAL_PROOF_BUILD_COMMAND, `Local proof mode (deploy.target is local-serve): build page-kit in the ${LOCAL_PROOF_BUILD_ENVIRONMENT} environment into _site/ and record ${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} as "${LOCAL_PROOF_BUILD_ENVIRONMENT}". Vendor loaders are environment-gated out of this render (their protocol-relative //host/... URLs fail over a plain-HTTP local serve); SDK dl_* events still fire. ${LOCAL_PROOF_NEVER_EDIT_RULE}`);
      push("build_production_parity", "command", asInvocation(substitutePacket(LOCAL_PROOF_PARITY_COMMAND, packetPath)), "After the development build is proven, assert the production render differs from it only in environment-gated output (same pages, route slugs, Campaign Cart pin and next-api-key) before committing; the PR preview is the second check.");
    }
    if (themeGate?.status === "blocked") {
      for (const action of themeGate.required_actions) {
        push(`theme_gate.${action.id}`, action.kind, asInvocation(action.command), `${action.description} (Required before polish/deploy/QA.)`);
      }
    }
  } else if (result.stage === "polish") {
    push("polish_skill", "skill", "next-campaigns-polish", "Run the visual polish pass, capture desktop/mobile evidence, then record stages.polish in the assembly report.");
    if (polishCheckpointGate?.status === "blocked") pushPolishCheckpointActions();
  } else if (result.stage === "deploy") {
    if (packet.deploy?.target === LOCAL_SERVE_DEPLOY_TARGET) {
      const plan = localServePlan(packet);
      push("deploy", "manual", null, `Serve the built ${plan.dir} output locally as the origin root (deploy.target is local-serve)${plan.rewrite ? ` — ${plan.rewrite}` : ""}, then record the localhost URL on deploy.preview_url and stages.deploy in the assembly report. Localhost on any port is a Development domain: SDK allowed, analytics suppressed.`);
    } else {
      push("deploy", "manual", null, `Deploy _site/ output to ${packet.deploy?.target || "the deploy target"}, then record deploy.preview_url (or production_url) on the packet and stages.deploy in the assembly report.`);
    }
    push("advance", "command", `${cmd("next")} --packet ${packetPath} --json`, "Advance to QA once the deploy URL is recorded.");
  } else if (result.stage === "qa") {
    const url = packet.deploy?.preview_url || packet.deploy?.production_url || "<preview-url>";
    push("install_browser", "command", `${cmd("qa")} install-browser`, "Install the Playwright browser once after install/update (npm run qa:install-browser from a checkout).");
    push("qa_run", "command", `${cmd("qa")} run --packet ${packetPath} --base-url ${url} --browser --test-order common`, "Run browser + typed-card QA and publish the verdict.");
  } else if (result.stage === "done") {
    // #171: run-record closeout is a REQUIRED terminal action, not an
    // optional nicety — the dogfood run ended at a terminal stage with the
    // session open and no durable Run Record, and nothing prompted otherwise.
    if (ambient) {
      push("run_end", "command", `${cmd("run")} end${ambient.session?.packet ? "" : ` --packet ${shellToken(packetPath)}`}`, "Close the active run session: assemble the aggregated Run Record and clear run-session.json. Required — the run's durable record depends on it.", { required: true });
    } else if (runRecordCloseout?.satisfied === true) {
      // The record for THIS packet, covering the evidence the report currently
      // carries, is already closed. Demanding another one told the operator to
      // duplicate work that was done — but staying silent would hide where the
      // durable record is, so the action becomes informational, not required.
      push(
        "run_record_present",
        "manual",
        null,
        `Durable Run Record already closed for this run: ${runRecordCloseout.record_id || "(unnamed)"} at ${runRecordCloseout.record_path || "the target's .campaign-runtime/run-records/"}. ${runRecordCloseout.detail || ""}`.trim(),
      );
    } else if (runRecordCloseout && reasonIsRemitRecovery(runRecordCloseout.reason_code) && runRecordCloseout.record_id) {
      // A record exists; only its remit is unfinished. Minting a second record
      // would fork the run's identity. run-record is idempotent on run_id, so
      // recovery re-runs against the record already on disk.
      push(
        "run_record_remit_recovery",
        "command",
        `${cmd("run-record")} --packet ${shellToken(packetPath)} --run-id ${shellToken(runRecordCloseout.record_id)} --json`,
        `Recover the existing Run Record's remit (${runRecordCloseout.reason_code}): ${runRecordCloseout.detail || "the local record is written but its remit did not complete."} Re-running against the same run id is idempotent — a send the receiver already holds resolves to ok — and a record already remitted is left as written; do not mint a second record.`,
        { required: true },
      );
    } else {
      const why = runRecordCloseout
        ? ` No usable record was found for this packet (${runRecordCloseout.reason_code}): ${runRecordCloseout.detail || ""}`.trimEnd()
        : "";
      // With no session, run-record re-emits the newest record for this
      // campaign in place. When that record is the one just judged stale or
      // outdated, re-emitting it changes nothing (a remitted record is final),
      // so the closeout must mint: --new-run. With no matching record at all
      // the plain command mints on its own.
      const supersededReason = runRecordCloseout?.reason_code === "stale_predates_evidence" || runRecordCloseout?.reason_code === "outdated_artifacts";
      const supersedes = supersededReason ? " --new-run" : "";
      const superseded = supersededReason
        ? ` The existing record ${runRecordCloseout.record_id || "(unnamed)"} stays as written; --new-run opens a new run id for the current evidence instead of re-emitting it.`
        : "";
      push("run_record_closeout", "command", `${cmd("run-record")} --packet ${shellToken(packetPath)}${supersedes} --json`, `Assemble the durable Run Record closeout for this run. Required even without an active run session — stage artifacts and the QA verdict alone are not the run's durable record.${why}${superseded}`, { required: true });
    }
    // `--test-order off` is a diagnostic, not purchase proof. When the report
    // is too old to say either way, say so — an unknown must never turn into a
    // new block on a campaign that was already finished.
    if (purchaseProof?.state === "unknown") {
      const depths = purchaseProof.declared_depths;
      const drift = orderPathDepthsDisagree(depths?.packet, depths?.report)
        ? { packetDepth: depths.packet, reportDepth: depths.report }
        : null;
      if (drift) {
        // The packet and its report mirror disagree: the action IS the
        // reconciling command (doctor's warning names the same one), not a
        // manual step that leaves the operator to find it. Rendered once and
        // handed to both the action and its prose.
        const command = requiredActionText(orderPathDepthReconcileAction(drift), { packetPath });
        push(
          "purchase_proof_unknown",
          "command",
          command,
          `Purchase-proof coverage is unknown for this run: ${orderPathDepthDriftText({ ...drift, command })} ${describeDeclaredDepth(purchaseProof)}; once they agree, re-run \`${cmd("qa")} run --test-order <depth>\` if that depth still has to be proved.`,
        );
      } else {
        push(
          "purchase_proof_unknown",
          "manual",
          null,
          `Purchase-proof coverage is unknown for this run: ${purchaseProof.reason || "the QA stage records no purchase-proof summary."} ${describeDeclaredDepth(purchaseProof)}; re-run \`${cmd("qa")} run --test-order <depth>\` if that depth still has to be proved.`,
        );
      }
    }
  }
  return actions;
}

// Record the recommendation on the active run session so deviation telemetry
// can compare "what next said" against "what the agent actually ran".
// Best-effort: telemetry never blocks orchestration.
function recordNextRecommendation(ambient, result) {
  if (!ambient) return;
  try {
    const expected = expectedCommandsForStage(result.stage, result.next_actions || []);
    const now = new Date();
    const session = {
      ...ambient.session,
      updated_at: now.toISOString(),
      last_recommendation: buildRecommendation({
        stage: result.stage,
        status: result.status,
        expectedCommands: expected,
        now,
      }),
    };
    writeRunSession(ambient.dir, session);
    ambient.session = session;
  } catch {
    // non-fatal
  }
}

// Pages the packet carries with a skip_reason and no source path are template
// stock: intake declared them out of source scope and demanded no design
// source. The build stage materialises each from the locked family's own page
// of that role rather than looking for prepared HTML that does not exist.
//
// Order: the pre-checkout `select` step first, where the funnel has one. It
// seeds the cart every downstream runtime page reads, so it is the page the
// build wires before checkout; doctor's derived scope carries each page's
// CampaignSpec type, and the packet's own mapping order stands otherwise.
//
// Only pages doctor reports out of scope WITH the template_stock marker are
// listed: a skip entry recorded before the marker existed, or authored by
// hand, is a do-not-build declaration and stays off the list. A page already
// materialised has left out_of_scope_pages and needs no instruction.
function templateStockPromptLine(packet, derived = {}) {
  const stockPages = (Array.isArray(derived?.scope?.out_of_scope_pages) ? derived.scope.out_of_scope_pages : [])
    .filter((page) => page?.template_stock === true && isNonEmptyString(page?.page_id));
  if (!stockPages.length) return "";
  const pages = [
    ...stockPages.filter((page) => page.type === "select"),
    ...stockPages.filter((page) => page.type !== "select"),
  ].map((page) => page.page_id);
  return `\n- Template-stock pages (declared out of source scope; no design source exists for them): ${pages.join(", ")}. Materialise each from the ${packet.assembly.template_family} family's own page for that role (copied with its dependent _includes, _layouts, and assets), in that order — a pre-checkout select step first, because it seeds the cart the runtime pages read — wire it from CampaignSpec, and do not look for prepared source HTML for it. Once its built HTML exists, doctor lists it among the previewable routes.`;
}

function buildPrompt(packetPath, contextPath, reportPath, packet, derived = {}) {
  const briefPath = packet.build_brief?.normalized_path || "(missing; generate or confirm Campaign Build Brief before business-sensitive assembly)";
  return `Use next-campaigns-build for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath || "(use packet-adjacent .campaign-runtime/build-context.json if present)"}
- Assembly Report: ${reportPath || "(use packet-adjacent .campaign-runtime/assembly-report.json if present)"}
- Campaign Build Brief: ${briefPath}
- Design Source Package: .campaign-runtime/input/design-source-package.json when present; use report.design_source_package.material_fingerprint as the source context fingerprint.
- Template family: ${packet.assembly.template_family}${templateStockPromptLine(packet, derived)}

Rules:
- Treat CampaignSpec/API as the source for package, shipping, voucher, payment, tracking, footer, and SEO values.
- Treat the Campaign Build Brief as the merchandising/design presentation truth: page authority, palette/CTA style, variant media rules, pricing display strategy, promo/urgency language, payment/trust surfaces, display-name policy, residue policy, and QA expectations. Agents may resolve implementation uncertainty; unresolved brief questions are business uncertainty and should be asked or recorded, not guessed.
- Read the selected template family's agentContract and sharedFrontmatterVocabulary before commerce wiring.
- Prepared AI/exported HTML must be converted into page-kit-ready source first: keep page-owned body markup, strip document wrappers, add YAML frontmatter, move shared CSS/assets into the campaign structure, and use Liquid helpers only for page-kit links/assets/includes. Page Kit publishes src/<slug>/assets/config.js as /<slug>/config.js and src/<slug>/assets/products/foo.png as /<slug>/products/foo.png; do not leave raw /assets/... or /<slug>/assets/... references in rendered pages.
- Preserve prepared source HTML for landing/presell pages when it is a real standalone design.
- For checkout/upsell/downsell/receipt, use the starter template as the SDK contract reference only: preserve required data-next controls and runtime wiring, but let the campaign/source own visual chrome, copy hierarchy, imagery, and brand layer.
- Read context.theme and .campaign-runtime/theme/theme-report.json when present. If a fresh brand-theme.css exists, copy it into the campaign assets/css folder and list it after next-core.css in checkout/upsell/downsell/receipt frontmatter styles; if policy is inspect_only, generate or skip explicitly before applying a new brand layer.
- Generated brand-theme.css v0 is root-variable-only. Do not edit SDK-owned selectors, package controls, payment fields, totals, submit controls, receipt templates, route meta tags, or SDK JavaScript as part of theme application.
- If you copy starter-template files, copy the selected family atomically with dependent pages, _includes, _layouts, assets/css, and assets/js; do not copy only checkout.html and receipt.html.
- Resolve SDK routing meta tags to campaign-root paths such as ${campaignRouteRoot(packet) || `/${packet.campaign.public_route_slug}/`}upsell/, not source filenames or unrooted spec literals.
- For one-time prepurchase/order-bump packages outside the main bundles, default package_sync=false and show_line_total_price=false unless the spec explicitly requires quantity sync.
- Record spec-driven removals, especially unsupported payment methods, so polish does not reintroduce them.
- Replace demo refs; do not copy Olympus-style shipping_methods into shop-three-step.
- For two-step package-selection flows, treat the selector page as the pre-checkout step and pass the selected cart to checkout with forcePackageId; preserve normal tracking params and strip forcePackageId from visible checkout URLs after SDK initialization.
- After page-kit build, inspect rendered _site output before handoff: each active page should have a body, Campaign Cart runtime markers, SDK meta tags from CampaignSpec sdk_hints.meta_tags, and no stale copied funnel attribution.
- Run page-kit build and SDK/template lint, then update stages.assembly.status plus stages.assembly.build_fingerprint before polish. The fingerprint is computed from the built output, never typed: after page-kit build, run doctor --json and copy derived.build_output_fingerprint.value (sha256 over the sorted path+sha256 manifest of _site/<slug>/; doctor reports built_output.fingerprint_stale whenever the output on disk stops matching the recorded value). If report.design_source_package.material_fingerprint exists, also record the same value on stages.assembly.source_package_material_fingerprint so Polish can prove the build used the current source context. Build must set stages.polish.status to "required" or "pending" with required_by="build" and required_for=["qa"]; Build must not mark stages.polish as completed/completed_with_warnings/skipped. If you applied a brand theme, record report.theme.status, css_path, commerce_pages, load_order=after-next-core, evidence, and any repair-loop defect.
- Capture the machine-readable build summary as an artifact: \`${PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND}\` (requires next-campaign-page-kit >= 0.1.4). Doctor verifies it for per-page build errors and Page Kit shape warnings (NESTED_NO_PERMALINK, DUPLICATE_OUTPUT, MISSING_FRONTMATTER, LAYOUT_NOT_FOUND). If the installed page-kit predates --json, record that in the assembly report instead of skipping silently.${localProofPromptLines(packet)}`;
}

// Local proof mode lines for the build prompt: under local-serve the build is
// the development render, recorded as such, and the production render is
// proven by parity before commit.
function localProofPromptLines(packet) {
  if (!isLocalServePacket(packet)) return "";
  return `
- Local proof mode (deploy.target is local-serve): run the page-kit build in the ${LOCAL_PROOF_BUILD_ENVIRONMENT} environment — \`${LOCAL_PROOF_BUILD_COMMAND}\` — so _site/ is the development render, and record ${LOCAL_PROOF_BUILD_ENVIRONMENT_FIELD} as "${LOCAL_PROOF_BUILD_ENVIRONMENT}" on the assembly report. The starter templates gate every vendor loader on the environment and several loaders are protocol-relative (//host/...), which fail over a plain-HTTP local serve; the SDK's dl_* events still fire in development. Polish capture, browser QA and typed-card orders run against this served output. Before committing, run \`${asInvocation(LOCAL_PROOF_PARITY_COMMAND)}\` to prove the production render differs only in environment-gated output and pins the same Campaign Cart version; the PR preview is the second check. ${LOCAL_PROOF_NEVER_EDIT_RULE}`;
}

function setupPrompt(packetPath, contextPath, reportPath, packet) {
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-os-setup for this Campaigns OS handoff.

Read first:
- Build Packet: ${packetPath}
- Build Context: ${contextPath}
- Assembly Report: ${reportPath}
- Campaign Build Brief: ${briefPath}
- Target repo: ${packet.assembly.target_repo}
- Output dir: ${packet.assembly.output_dir}

Prepare the target page-kit structure and agent context, then update setup status in both:
- .campaign-runtime/build-context.json scaffold.required/scaffold.mode/handoff fields
- .campaign-runtime/assembly-report.json stages.setup

When copying a starter template family, copy the family as an atomic page-kit slice: pages plus required _includes, _layouts, assets/css, and assets/js. Do not copy only checkout.html and receipt.html.

Do not wire checkout, upsell, receipt, payment, package, voucher, or shipping behavior during setup.`;
}

function polishPrompt(packetPath, reportPath, packet) {
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-polish for this built campaign.

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Campaign Build Brief: ${briefPath}
- Template family: ${packet.assembly.template_family}

Compare source and Campaign Build Brief decisions against built page-kit output, patch only SDK-safe visual surfaces, scan source assets for logo/brand marks before leaving starter-template logos, respect spec-driven removals recorded during build, and capture desktop/mobile screenshots.

Before marking Polish complete, install the package-owned browser once and run the page-load producer against the served build:
- ${cmd("qa")} install-browser
- ${cmd("polish")} capture --packet ${packetPath} --base-url <served-build-url>

The producer covers every mapped route at fixed desktop/mobile viewports and attaches stages.polish.evidence.visual_review.page_load to the current Assembly Report. Never hand-author or copy page_load. A missing, stale, malformed, incomplete, cache/service-worker-observed, or over-threshold result keeps Polish/deploy/QA blocked; repair and recapture, or use the exact named-human checkpoint waiver only for a complete hidden eager-media finding.

Record Polish on stages.polish before QA:
- status: completed or completed_with_warnings (or blocked with blockers)
- performed_by: next-campaigns-polish
- source_build_fingerprint: the current stages.assembly.build_fingerprint
- source_package_material_fingerprint: the current report.design_source_package.material_fingerprint when present
- completed_at: ISO timestamp
- evidence.visual_review: representative screenshot paths/URLs plus package-generated page_load
- evidence.brand_review: logo/favicon/brand color checks, including non-template favicon confirmation
- evidence.checkout_review: labels/placeholders, phone alignment, payment display, bump compare-price rule
- evidence.template_residue_review: NEXT Blue/template placeholder/starter favicon/lorem/product residue checks
- evidence.commerce_flow_review: shop single-step direct-entry force-package/product-selector limitation notes
- evidence.issues: open defects with severity and QA-blocking status
- evidence.commands: commands/tool invocations used

If report.theme/context.theme exists, verify source token parity for primary color, CTA, surface, text, font/radius when present, and verify brand-theme.css loads after next-core.css on commerce pages. If the brand layer is missing, stale, low-confidence, or unsafe to apply, record the first repair-loop defect or an explicit skipped reason.`;
}

// How a local-serve deploy serves the built output. Built output always
// lives at _site/<slug>/ and its asset references keep the /<slug>/ prefix;
// route_root only says where the PAGES are served from. So the default is
// _site/ as the document root, and a root-served funnel (route_root "/") is
// the same document root plus the rewrite the production host applies —
// root-level page routes onto /<slug>/<route> — because no single directory
// serves both root-level pages and slug-prefixed assets.
// A packet without campaign.public_route_slug (doctor blocks it, but next's
// action list is built from whatever packet it is handed) gets no invented
// slug in the text: the served-under note and the rewrite need the real
// value, so they ask for it instead.
function localServePlan(packet) {
  const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug) || null;
  const rootServed = campaignRouteRoot(packet) === "/";
  const missingSlug = "campaign.public_route_slug is not recorded; record it before serving, since the built output lives at _site/<that slug>/";
  return {
    dir: "_site/",
    slug,
    rootServed,
    servedUnder: slug ? `the funnel is served under /${slug}/` : missingSlug,
    rewrite: !rootServed
      ? null
      : slug
        ? `route_root is "/": pages are served at site-root paths while assets keep the /${slug}/ prefix, so serve _site/ with a rewrite of root-level page routes onto /${slug}/<route> (the same rewrite the production host applies); a plain directory serve of _site/${slug}/ would 404 every /${slug}/... asset`
        : `route_root is "/": pages are served at site-root paths while assets keep the slug prefix, so _site/ needs a rewrite of root-level page routes onto /<slug>/<route> — ${missingSlug}`,
  };
}

function deployPrompt(packetPath, reportPath, packet) {
  const target = packet.deploy?.target || "unknown";
  const liveUrlPath = packet.deploy?.live_url_path || packet.campaign?.live_url_path || campaignRouteRoot(packet) || "/<slug>/";
  if (target === LOCAL_SERVE_DEPLOY_TARGET) {
    const { dir: serveDir, rootServed, rewrite, servedUnder } = localServePlan(packet);
    return `Deploy the built campaign by serving it locally (deploy.target is local-serve).

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Expected live URL path: ${liveUrlPath}
- Deploy target: ${target}
- Directory to serve as the origin root: ${serveDir}${rootServed ? ` — ${rewrite}` : ` (${servedUnder})`}

Nothing ships anywhere: the page-kit build produces _site/ output and you serve ${serveDir} on localhost (any static server, any port) for QA. Localhost on any port is a Campaigns App Development domain, so the SDK initialises there without an origin allowlist entry and Campaigns analytics events are suppressed.

Once the server is up:
1. Record the localhost URL (origin plus ${liveUrlPath}) on the packet at deploy.preview_url.
2. Update the assembly report's stages.deploy.status to "completed" with that URL and the serve command in outputs.
3. Run \`${cmd("next")} --packet ${packetPath}\` to advance to QA.

If the served build cannot be reached, set stages.deploy.status to "blocked" with a clear reason in outputs so the orchestration loop surfaces it rather than skipping past.`;
  }
  return `Deploy the built campaign to ${target}.

Read first:
- Build Packet: ${packetPath}
- Assembly Report: ${reportPath}
- Expected live URL path: ${liveUrlPath}
- Deploy target: ${target}

Deploy is currently an out-of-band step: the page-kit build produces _site/ output; you (or your CI) ship it to ${target}. Use the deploy target's normal tooling (netlify deploy, wrangler pages deploy, vercel deploy, etc.).

After deploy succeeds:
1. Record the resulting URL on the packet at deploy.preview_url (preview deploys) or deploy.production_url (production).
2. Update the assembly report's stages.deploy.status to "completed" with the URL and any relevant notes in outputs.
3. Verify the SDK initialises on the tested origin. Localhost on any port is globally available as a Campaigns App Development domain (analytics suppressed). Non-localhost preview/production hosts must be in the Campaigns App SDK origin allowlist before QA.
4. Run \`${cmd("next")} --packet ${packetPath}\` to advance to QA.

If the deploy is blocked (non-localhost allowed-domain not yet added, CI permission missing, host-side outage), set stages.deploy.status to "blocked" with a clear reason in outputs so the orchestration loop surfaces it rather than skipping past.`;
}

function qaPrompt(packetPath, reportPath, packet) {
  const url = packet.deploy?.preview_url || packet.deploy?.production_url || "<preview-url>";
  const briefPath = packet.build_brief?.normalized_path || "(missing)";
  return `Use next-campaigns-qa for this deployed campaign.

${packet.spec.local_spec_id ? "Local spec ID" : "Map ID"}: ${packet.spec.local_spec_id || packet.spec.map_id}
Base URL: ${url}
Build Packet: ${packetPath}
Assembly Report: ${reportPath}
Campaign Build Brief: ${briefPath}
Browser install command:
${cmd("qa")} install-browser

Node QA command:
${cmd("qa")} run --packet ${packetPath} --base-url ${url} --browser --test-order common

Run the browser install once after install/update before --browser or --test-order. Test-order proof must exercise the campaign through the Campaign Cart SDK with the browser typed-card flow. Do not create hand-built backend API orders as launch proof. Compare visible placeholders, payment methods, variant media, promo/urgency copy, pricing presentation, and trust/guarantee claims against the Campaign Build Brief. Test Orders use global test cards that bypass the payment gateway and create no transactions, so they are safe to run any time and need no permission flags, packet policy, or merchant setup. Localhost on any port is a globally allowed Development domain for SDK initialization and suppresses Campaigns analytics events; non-localhost preview/production origins still need the SDK origin allowlist. Use --test-order common for checkout, first-offer accept/decline, and a deduplicated shortest real receipt path when that adds coverage (at most four orders); use an explicit path such as accept-decline-accept for a targeted matrix; or use --test-order full for every actual terminal path in the selected checkout topology. Cycles, missing routes, and reachable nonterminals block exhaustive proof before browser launch. The default accidental-flood cap is 6, and an overflow names the exact explicit --max-test-orders raise. That cap bounds planned paths; --max-order-creations bounds actual order creations and is reserved before each submit click, defaulting to the planned path count. A path whose failure is classified as created (the order is already placed) is inspected read-only and never resubmitted. A not_created failure may be re-run once, if the creation budget has a slot no still-unrun planned path needs; an ambiguous failure stops that path with an explicit operator check instead of buying again. Read evidence.recovery to tell a recovered pass from a first-attempt pass. Click rendered SDK upsell accept/decline controls for upsell proof. For multi-tier package selectors, drive a specific card with --select-package <ref[:qty],...> (strict: the path fails if the requested card cannot be found or selected, unlike best-effort --cart), or use --test-order tiers / tiers:common / tiers:full to drive every selector tier the CampaignSpec declares on the checkout page in one run (order-bump rows marked is_upsell are add-ons, not tiers; --select-package narrows a tiers run to the listed tiers); prove coupon-bearing orders with --apply-coupon <code> (typed into the rendered promo input, verified against the persisted-order voucher read-back). Reuse one test customer email via --test-email or CAMPAIGNS_OS_QA_TEST_EMAIL (a real monitored inbox in internal runs) so repeated QA does not litter the customer list.

Launch readiness note: Campaigns OS can prove the campaign build, SDK wiring, browser behavior, and typed-card order paths. It does not prove the merchant is ready for real shoppers. Before launch, confirm the production storefront URL, live payment methods, shipping markets, legal/support URLs, analytics expectations, and any merchant-side configuration. Treat those as real-shopper readiness items, not Campaigns OS build blockers.

For multi-market campaigns, verify at least one non-default currency/country path: currency display, shipping method names/prices, payment methods, and market-specific copy. Summarize blockers, warnings, and remaining launch risks.`;
}

// Packet 03 (INV-5 first slice): the deploy-output URL scan that
// buildNextStep's deploySatisfied has always used, extracted so
// detectLedgerDivergence reads the exact same artifact signal instead of
// growing a second, slightly different scan.
function deployUrlFromReportOutputs(report) {
  for (const output of report?.stages?.deploy?.outputs || []) {
    if (/^https?:\/\//.test(String(output))) return String(output);
  }
  return null;
}

// Packet 03 (INV-5 first slice): QA verdict artifacts discoverable for THIS
// campaign from packet + target repo alone, via the qa-output convention
// (`<target-repo>/qa-output/<map_id|public_route_slug>/*.json`, the same
// roots inferQaVerdictPath scans). Deterministic projection of repo
// contents: entries are name-sorted, no mtimes, no clock, no cwd. A JSON
// file only counts when its campaign_slug matches this campaign's identity,
// so a neighbouring campaign's verdict never reads as ours.
// This campaign's verdicts under the target repo, repo-relative (divergence
// evidence must read the same wherever the repo sits on disk).
function qaVerdictArtifactsForCampaign(packet, targetRepo) {
  if (!isNonEmptyString(targetRepo)) return [];
  return discoverQaVerdicts({ packet, roots: [targetRepo] })
    .filter((candidate) => candidate.source === "qa_output" && candidate.identityMatch)
    .map((candidate) => ({
      path: candidate.repoRelPath,
      campaign_slug: optionalString(candidate.verdict.campaign_slug),
      verdict: optionalString(candidate.verdict.verdict),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Packet 03 (INV-5 first slice, EN-1): where the artifacts in the campaign
// repository contradict the Assembly Report's self-reported stage ladder,
// report the disagreement — never resolve it, never treat artifact presence
// as completion, and never let the ledger alone justify a destructive
// re-setup recommendation.
//
// Pure function of (report, packet, target repo contents): no network, no
// cwd dependence, no clock, no mtimes. Exactly three signals, per the
// ratified packet scope:
//   1. built output present while stages.assembly.status is "pending";
//   2. a deploy URL present (report.stages.deploy.outputs — the same scan
//      deploySatisfied uses — or packet.deploy.preview_url/production_url)
//      while stages.deploy.status is "pending";
//   3. a QA verdict artifact for this campaign present while
//      stages.qa.status is "pending".
//
// Each divergence quotes both sides (ledger claim + artifact evidence).
// Presence-based only: a stale built output still diverges from a pending
// ledger, and the entry says the two disagree — it never asserts the stage
// is complete or the artifact current. This function writes nothing.
export function detectLedgerDivergence(report, packet, targetRepo) {
  const divergences = [];
  const stages = report?.stages;
  if (!isObject(stages) || !isNonEmptyString(targetRepo)) return divergences;
  const stagePending = (key) => String(stages?.[key]?.status || "") === "pending";

  if (stagePending("assembly")) {
    const slug = normalizePublicRouteSlug(packet?.campaign?.public_route_slug);
    if (slug) {
      let builtOutputPresent = false;
      try {
        const siteRoot = join(targetRepo, "_site", slug);
        builtOutputPresent = existsSync(siteRoot) && statSync(siteRoot).isDirectory();
      } catch {
        builtOutputPresent = false;
      }
      if (builtOutputPresent) {
        divergences.push({
          code: "divergence.assembly.built_output_present",
          stage: "assembly",
          ledger_claim: 'stages.assembly.status = "pending"',
          artifact_evidence: `Built output directory _site/${slug}/ exists in the target repo.`,
          message: `The ledger claims assembly has not run, but built output exists at _site/${slug}/. The ledger and artifacts disagree; inspect both before acting. Presence is not proof the stage is complete or that the output is current for this packet.`,
        });
      }
    }
  }

  if (stagePending("deploy")) {
    const reportUrl = deployUrlFromReportOutputs(report);
    const packetPreviewUrl = optionalString(packet?.deploy?.preview_url);
    const packetProductionUrl = optionalString(packet?.deploy?.production_url);
    const url = reportUrl || packetPreviewUrl || packetProductionUrl;
    if (url) {
      const source = reportUrl
        ? "report.stages.deploy.outputs"
        : packetPreviewUrl
          ? "packet.deploy.preview_url"
          : "packet.deploy.production_url";
      divergences.push({
        code: "divergence.deploy.url_present",
        stage: "deploy",
        ledger_claim: 'stages.deploy.status = "pending"',
        artifact_evidence: `Deploy URL "${url}" is recorded in ${source}.`,
        message: `The ledger claims deploy has not run, but a deploy URL ("${url}") is recorded in ${source}. The ledger and artifacts disagree; inspect both before acting. A recorded URL is not proof the stage is complete or that the deployed output is current.`,
      });
    }
  }

  if (stagePending("qa")) {
    const verdicts = qaVerdictArtifactsForCampaign(packet, targetRepo);
    if (verdicts.length) {
      const quoted = verdicts
        .map((entry) => `${entry.path} (campaign_slug "${entry.campaign_slug}"${entry.verdict ? `, verdict "${entry.verdict}"` : ""})`)
        .join("; ");
      divergences.push({
        code: "divergence.qa.verdict_present",
        stage: "qa",
        ledger_claim: 'stages.qa.status = "pending"',
        artifact_evidence: `QA verdict artifact(s) for this campaign: ${quoted}.`,
        message: `The ledger claims QA has not run, but verdict artifact(s) for this campaign exist (${quoted}). The ledger and artifacts disagree; inspect both before acting. A recorded verdict is not proof the stage is complete for the current build.`,
      });
    }
  }

  return divergences;
}

function checkpointExceptionPresent(derived) {
  return (Array.isArray(derived?.checkpoint_gates)
      && derived.checkpoint_gates.some((gate) => gate?.status === "waived"))
    || derived?.polish_checkpoint_gate?.status === "waived";
}

function readinessStatus(warnings, derived) {
  if (checkpointExceptionPresent(derived)) return "ready_with_waivers";
  return warnings.length ? "ready_with_warnings" : "ready";
}

// The source-preparation action names only the repairs the findings ask for.
// A document-wrapper finding reported as a warning is the accepted
// preserve_document_wrappers adapter decision (src/source-prep.mjs decides
// the severity from the packet's wrapper_policy); ordering a wrapper strip
// there would undo the decision that cleared the gate, so the strip step is
// offered only when the finding is an error.
function sourcePreparationAction(errors, warnings) {
  const errorCodes = new Set(errors.map((issue) => issue.code));
  const warningCodes = new Set(warnings.map((issue) => issue.code));
  const present = (code) => errorCodes.has(code) || warningCodes.has(code);
  const steps = [];
  if (errorCodes.has(SOURCE_PREP_DOCUMENT_WRAPPER)) steps.push("strip document wrappers");
  if (present(SOURCE_PREP_FRONTMATTER_RESIDUE)) steps.push("repair leftover frontmatter");
  if (present(SOURCE_PREP_INTERNAL_LINK_UNROOTED)) steps.push("route internal links through campaign_link/CampaignSpec routes");
  if (!steps.length) return null;
  const listed = steps.length === 1 ? steps[0] : `${steps.slice(0, -1).join(", ")}, and ${steps[steps.length - 1]}`;
  return `Prepare the mapped source HTML for page-kit ingestion — ${listed} (docs/quickstart.md "Prepare Raw HTML Source") — then rerun ${cmd("doctor")}.`;
}

// Owner and skill for each stage the picker can name. The doctor's `next`
// block is a projection of the same picker the `next` command runs
// (pickNextStage), so the two can no longer disagree about which stage comes
// next: doctor used to carry its own decider with its own vocabulary
// (collect-inputs / assembly / complete) and its own gating, which knew
// neither purchase proof nor the prepare-build gate, and listed the stage it
// recommended inside blocked_stages. The table itself lives on the stage
// contract so the Assembly Report's derived `next` spells owners the same way.
export const DOCTOR_NEXT_STAGE_OWNERS = NEXT_STAGE_OWNERS;

// The code -> action strings doctor prints under `Next:`. They describe the
// repairs the findings ask for and are independent of which stage the picker
// names, so they survive the picker consolidation unchanged.
function doctorNextActions(errors, warnings, derived, { polishBlocked, polishGate, polishCheckpointGate, packetRef = derived.packet_path || "<packet>" }) {
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const onlyPolishErrors = doctorErrorsAreOnlyPolishGate(errors);
  const actions = [];
  if (errors.length && !onlyPolishErrors) {
    actions.push("Resolve packet blockers before assembly.");
  }
  if (codes.has("assembly.template_lock")) actions.push("Lock a template family before commerce wiring.");
  if (codes.has("spec.page_url_html_extension")) {
    actions.push("Update CampaignSpec page_url values to Page Kit public routes such as landing/ or checkout/, not source filenames like landing.html.");
  }
  if (codes.has("spec.route_collision")) {
    actions.push("Fix Campaign Map page_url values so every active page resolves to a unique Page Kit route.");
  }
  if (codes.has("frontmatter.demoOnlyValues") || codes.has("frontmatter.replaceFromSpecOrApi")) {
    actions.push("Use the template agentContract to replace demo values from CampaignSpec/API.");
  }
  if (codes.has("template_contract.brand_contract") || codes.has("template_contract.family_inventory")) {
    actions.push(`Add or repair the selected family's contracts/template-brand-contract.<family>.v0.json, then rerun ${cmd("doctor")} --packet <packet>.`);
  }
  if (codes.has("template_contract.exit_pop") || codes.has("template_contract.exit_pop_residue") || codes.has("template_contract.exit_pop_blank_widget")) {
    actions.push("Strip the default exit-pop widget or wire CampaignSpec checkout exit_intent/promo_code_input to the SDK coupon path before QA.");
  }
  if (codes.has("template_contract.discount_claim_unverified")) {
    actions.push("Confirm any rendered promo discount percentage claims against the build request, merchant notes, or CampaignSpec before launch.");
  }
  if (codes.has("template_contract.placeholder_text_residue")) {
    actions.push("Replace literal template placeholder text (Lorem/Placeholder/TODO/Product Name) with CampaignSpec/design copy before QA; the browser residue gate blocks on these terms.");
  }
  if (codes.has("template_contract.demo_asset_residue")) {
    actions.push("Re-skin template demo placeholder assets (spacer SVGs, repeated benefit icons, starter imagery) to the campaign's real assets before launch.");
  }
  if (codes.has("content_residue.needs_merchant_input")) {
    actions.push("Collect the flagged merchant inputs (byline identity, proof data) via the attestation lane, re-inject the slots, and rebuild — the needs-input marker must never ship.");
  }
  if (codes.has("content_residue.unverified_urgency")) {
    actions.push("Blank the urgency slots (countdown/sell-out) or record verified offer urgency in the brief payload's offer.urgency, then rebuild.");
  }
  if (codes.has("proof_attestation.pending_shipped") || codes.has("proof_attestation.non_attestable_shipped")) {
    actions.push("Resolve shipped proof against the brief payload's proof_assets: collect the merchant's click-wrap attestation for attestable items; remove non-attestable proof outright.");
  }
  if (codes.has("scope.partial_build")) {
    actions.push("Build and deploy only the mapped partial-scope pages; label the preview as route/visual-testable, not full-funnel launch-ready.");
  }
  const sourcePrepAction = sourcePreparationAction(errors, warnings);
  if (sourcePrepAction) actions.push(sourcePrepAction);
  if (codes.has("scope.runtime_qa_blocked")) {
    actions.push("Keep checkout/order-proof QA blocked until the out-of-scope runtime pages are built or explicitly delegated to an existing downstream URL.");
  }
  // A recorded setup is not a live scaffold. The picker still names build
  // (and `next build` refuses with next.build.setup), so the recovery is
  // spelled out here rather than by disagreeing with the picker.
  if (codes.has("page_kit.scaffold_required")) {
    actions.push(`Target campaign output directory is missing; run ${cmd("next")} setup --packet ${packetRef} before build.`);
  }
  if (polishBlocked) {
    if (polishGate.status === "blocked") {
      actions.push(`${polishGate.reason} Run next-campaigns-polish and record structured evidence before deploy/QA handoff.`);
    }
    if (polishCheckpointGate?.status === "blocked") {
      actions.push(`${polishCheckpointGate.reason} Run ${cmd("polish")} capture before marking Polish complete.`);
    }
  }
  return actions;
}

// Doctor's `next` block: the `next` command's picker, projected. `stage` and
// `reason` come from pickNextStage over the same report, doctor result and
// purchase-proof summary the `next` command reads; `blocked_stages` lists the
// stages AFTER the picked one that cannot run until it clears, never the
// picked stage itself; `command` is always present.
function buildNextStep(errors, warnings, derived, report = null, packet = null, prepareBuildGate = prepareBuildGateIssue(report), { sidecarArgs = "" } = {}) {
  const polishGate = derived.polish_gate || evaluatePolishGate({ report });
  const polishCheckpointGate = derived.polish_checkpoint_gate || null;
  const assemblyComplete = String(report?.stages?.assembly?.status || "").startsWith("completed");
  const polishBlocked = assemblyComplete
    && (polishGate.status === "blocked" || polishCheckpointGate?.status === "blocked");
  const codes = new Set([...errors, ...warnings].map((issue) => issue.code));
  const purchaseProof = report ? assessPurchaseProofCoverage({ packet, report }) : null;
  const picked = pickNextStage(report, { errors, derived }, prepareBuildGate, purchaseProof);
  // The picker's vocabulary and this table must not drift apart: a stage the
  // table does not know would otherwise be relabelled as an operator step and
  // sliced into the whole ladder. Fail loudly instead.
  if (!Object.hasOwn(DOCTOR_NEXT_STAGE_OWNERS, picked.stage)) {
    throw new Error(`Doctor has no owner for next stage "${picked.stage}"; add it to DOCTOR_NEXT_STAGE_OWNERS.`);
  }
  // An explicit --context / --report is carried into every recommended
  // command, so a recovery reads the same artifacts the recommendation did.
  const packetRef = `${derived.packet_path || "<packet>"}${sidecarArgs}`;
  const actions = doctorNextActions(errors, warnings, derived, { polishBlocked, polishGate, polishCheckpointGate, packetRef });
  const deployStatus = String(report?.stages?.deploy?.status || "");
  const deploySatisfied = ["completed", "completed_with_warnings", "ready_with_exceptions"].some((prefix) => deployStatus.startsWith(prefix))
    || Boolean(deployUrlFromReportOutputs(report));
  // qa is not runnable without a URL to test (`next qa` refuses with
  // next.qa.deploy_url), so a picked qa with no deploy URL is blocked too.
  const qaNeedsUrl = codes.has("deploy.preview_url") && !deploySatisfied;
  // build is not runnable over a missing scaffold either (`next build`
  // refuses with next.build.setup); the action list names the setup step.
  // done is not ready while the runtime scope is partial: checkout launch
  // and test orders are still owed, whatever the ladder's stages say.
  const blocked = picked.stage === "doctor-blocked" || picked.stage === "prepare-build" || picked.blocked === true
    || (picked.stage === "qa" && qaNeedsUrl)
    || (picked.stage === "build" && derived.scaffold_required === true)
    || (picked.stage === "done" && codes.has("scope.runtime_qa_blocked"));
  // Stages behind the picked one. done has none; the two pre-ladder states
  // block the whole ladder; a ladder stage blocks what follows it.
  const later = picked.stage === "done"
    ? []
    : picked.stage === "doctor-blocked" || picked.stage === "prepare-build"
      ? [...NEXT_STAGE_ORDER]
      : NEXT_STAGE_ORDER.includes(picked.stage)
        ? NEXT_STAGE_ORDER.slice(NEXT_STAGE_ORDER.indexOf(picked.stage) + 1)
        : [];
  // Scope markers that are not ladder stages but that readers key on: a
  // partial runtime scope blocks checkout launch readiness and test orders
  // whatever stage comes next, and unconfirmed allowed domains block the
  // runtime SDK verification.
  const scopeMarkers = [
    ...(codes.has("scope.runtime_qa_blocked") ? ["checkout-launch-ready", "test-orders"] : []),
    ...(codes.has("campaign.allowed_domains_confirmed") ? ["runtime-sdk-verification"] : []),
  ];
  const gateBlocked = [
    ...(polishBlocked ? NEXT_STAGE_ORDER.slice(NEXT_STAGE_ORDER.indexOf("polish")) : []),
    // QA cannot run against no URL: `next qa` refuses with next.qa.deploy_url.
    ...(qaNeedsUrl ? ["qa"] : []),
  ];
  const owners = DOCTOR_NEXT_STAGE_OWNERS[picked.stage];
  // prepare-build is not a `next <stage>` argument: the stage-less `next`
  // is what prints the recovery actions for it, and it is also the right
  // call after a doctor-blocked repair or at done.
  const command = picked.stage === "doctor-blocked"
    ? `${cmd("doctor")} --packet ${packetRef}`
    : picked.stage === "prepare-build" || picked.stage === "done"
      ? `${cmd("next")} --packet ${packetRef}`
      : `${cmd("next")} ${picked.stage} --packet ${packetRef}`;
  const fallbackAction = picked.stage === "done"
    ? `All stages are recorded as terminal; run ${cmd("next")} to confirm the closeout actions.`
    : `Run ${command}.`;
  return {
    stage: picked.stage,
    status: blocked ? "blocked" : readinessStatus(warnings, derived),
    // The picker's own verdict on the picked stage (a blocked polish gate, a
    // blocked ladder stage, prepare-build), as distinct from `status`, which
    // also folds in what makes the stage unrunnable (no deploy URL, no
    // scaffold). `next` reports it as its own stage_blocked.
    stage_blocked: picked.blocked === true,
    owner: owners.owner,
    default_skill: owners.default_skill,
    command,
    reason: picked.reason,
    actions: actions.length ? actions : [fallbackAction],
    // Gate-blocked stages stay listed even when the recommended stage is
    // runnable (a Design Source Package change after assembly names build,
    // which is allowed, while polish, deploy and qa stay refused).
    blocked_stages: [...new Set([...(blocked ? later : []), ...gateBlocked, ...scopeMarkers])]
      .filter((stage) => stage !== picked.stage),
  };
}

function installAgentContext(targetRepo, dryRun = false) {
  const outDir = resolve(targetRepo, ".campaign-runtime/agent-context");
  const files = [
    ["CLAUDE.md", join(ROOT, "agents/claude/CLAUDE.md")],
    ["AGENTS.md", join(ROOT, "agents/codex/AGENTS.md")],
    ["campaigns-os.mdc", join(ROOT, "agents/cursor/campaigns-os.mdc")],
    ["copilot-instructions.md", join(ROOT, "agents/copilot/copilot-instructions.md")],
  ];
  const written = [];
  if (!dryRun) mkdirSync(outDir, { recursive: true });
  for (const [name, source] of files) {
    const dest = join(outDir, name);
    if (!dryRun) writeFileSync(dest, readFileSync(source, "utf8"));
    written.push(dest);
  }
  const gitignore = ensureRuntimeStateIgnored(targetRepo, { dryRun });
  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    target_repo: targetRepo,
    directory: outDir,
    files: written,
    gitignore,
    note: "Context files are staged under .campaign-runtime/agent-context and do not overwrite root agent files.",
  };
}

const SKILL_PLATFORMS = [
  {
    id: "claude",
    label: "Claude Code",
    target: () => join(homedir(), ".claude", "skills"),
  },
  {
    id: "codex",
    label: "Codex",
    target: () => join(homedir(), ".codex", "skills"),
  },
  {
    id: "agents",
    label: "Shared agent skills",
    target: () => join(homedir(), ".agents", "skills"),
  },
];

function skillPlatformHelp() {
  return SKILL_PLATFORMS.map((platform) => platform.id).concat("all").join(", ");
}

function resolveSkillInstallTargets(targetArg = null, platformArg = null) {
  if (isNonEmptyString(targetArg)) {
    return [{
      platform: "custom",
      platform_label: "Custom target",
      target_directory: resolve(targetArg),
    }];
  }

  const requested = String(platformArg || "claude").trim().toLowerCase();
  const selected = requested === "all"
    ? SKILL_PLATFORMS
    : SKILL_PLATFORMS.filter((platform) => platform.id === requested);

  if (!selected.length) {
    throw refused(`Unknown --platform ${requested}. Use one of: ${skillPlatformHelp()}.`);
  }

  return selected.map((platform) => ({
    platform: platform.id,
    platform_label: platform.label,
    target_directory: platform.target(),
  }));
}

// Retired-skill records from skills.json. Installs are additive (the copy loop
// never deletes), so without this a renamed skill leaves its OLD copy behind in
// every shared skill directory forever — the name is never actually released.
function loadRetiredSkills() {
  const manifestPath = join(ROOT, "skills.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return Array.isArray(manifest.retired_skills) ? manifest.retired_skills : [];
  } catch {
    return [];
  }
}

function installSkills(targetArg = null, dryRun = false, platformArg = null) {
  const sourceDir = join(ROOT, "skills");
  const retired = loadRetiredSkills();
  const targets = resolveSkillInstallTargets(targetArg, platformArg);
  const targetResults = targets.map((target) => installSkillsToTarget({
    sourceDir,
    target,
    dryRun,
    retired,
  }));

  if (targetResults.length === 1) {
    return {
      ...targetResults[0],
      available_platforms: SKILL_PLATFORMS.map((platform) => ({
        platform: platform.id,
        label: platform.label,
        target_directory: platform.target(),
      })),
    };
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    source_directory: sourceDir,
    targets: targetResults,
    skills: targetResults.flatMap((target) => target.skills),
    available_platforms: SKILL_PLATFORMS.map((platform) => ({
      platform: platform.id,
      label: platform.label,
      target_directory: platform.target(),
    })),
    note: dryRun
      ? "Dry run only; no skill files were written."
      : "Restart local agent sessions to pick up new or updated skills.",
  };
}

// A platform directory counts as installed when a skill already sits under one
// of the bundled names (current or not), or our own copy under a retired name. A
// slot install-skills would only create says nothing about that platform, and
// neither does a retired slot another skill occupies. A foreign skill under a
// CURRENT bundled name reads as `updated` — install-skills would replace it —
// so it does count; the refresh action is then what install-skills would do.
const SKILL_ACTIONS_THAT_MARK_A_PLATFORM_INSTALLED = new Set(["unchanged", "updated", "retired"]);

export function scopeSkillStatusToInstalledPlatforms(status) {
  if (!Array.isArray(status?.targets)) return { status, scope: "requested", notInstalled: [] };
  const installedOn = (target) => (target.skills || []).some((skill) => SKILL_ACTIONS_THAT_MARK_A_PLATFORM_INSTALLED.has(skill?.action));
  const installed = status.targets.filter(installedOn);
  const describe = (target) => ({
    platform: target.platform,
    platform_label: target.platform_label,
    target_directory: target.target_directory,
  });
  if (!installed.length) return { status, scope: "no_platform_installed", notInstalled: status.targets.map(describe) };
  return {
    status: { ...status, targets: installed, skills: installed.flatMap((target) => target.skills) },
    scope: "installed_platforms",
    notInstalled: status.targets.filter((target) => !installedOn(target)).map(describe),
  };
}

const TOOLING_ACTIONABLE_SKILL_ACTIONS = new Set(["created", "updated", "retired"]);
const TOOLING_CLEAN_SKILL_ACTIONS = new Set(["unchanged"]);

export function classifyToolingSkillActions(skills = []) {
  const actionable = [];
  const warnings = [];
  for (const skill of skills) {
    if (TOOLING_ACTIONABLE_SKILL_ACTIONS.has(skill?.action)) {
      actionable.push(skill);
    } else if (!TOOLING_CLEAN_SKILL_ACTIONS.has(skill?.action)) {
      // occupied_by_other is a known terminal state. Unknown future states are
      // also warning-only until their remediation semantics are explicit, so a
      // new action cannot create another permanently unclearable preflight.
      warnings.push(skill);
    }
  }
  return { actionable, warnings };
}

function toolingSkillIdentity(skill) {
  const prefix = skill?.platform && skill.platform !== "custom" ? `${skill.platform}/` : "";
  return `${prefix}${skill?.name || "unknown skill"}`;
}

/**
 * `--skills-revision <value>`: the skills bundle identity an agent read, checked
 * against the bundle THIS CLI ships.
 *
 * The asymmetry is the whole point, and it is why the reported revision is named
 * `on_disk`. A skill's text is pulled into an agent's context once, at the start
 * of the task, and is never re-read; the CLI on disk, meanwhile, can be updated
 * underneath that session by an `npm install`, an `npx` cache refresh, or a
 * `git pull` in the checkout. So the only honest comparison is "what you are
 * still reading" against "what is installed right now", and the only honest
 * remedy for a mismatch is a fresh session — re-running the command cannot pull
 * the newer skill text into a context that already has the older one.
 *
 * The bundle spelling (`<package version>+skills.<n>`) is what every SKILL.md
 * states on its first body line. The `<skill-id>@<version>` spelling is a
 * fallback for an agent that carries only the frontmatter of the one skill it
 * loaded; it is checked against that skill's manifest entry. An id this bundle
 * does not ship is a mismatch, not a refusal: an agent quoting a skill that is
 * not here is reading text from some other bundle, which is exactly the
 * condition this flag exists to catch.
 */
export function parseSkillsRevisionArg(value) {
  const text = String(value).trim();
  const at = text.lastIndexOf("@");
  if (at > 0 && at < text.length - 1) {
    return { spelling: "skill", id: text.slice(0, at), version: text.slice(at + 1), requested: text };
  }
  return { spelling: "bundle", requested: text };
}

export function evaluateSkillsRevision(value, manifest) {
  const onDisk = typeof manifest?.bundle_revision === "string" ? manifest.bundle_revision : null;
  if (value === undefined) {
    return {
      status: "unchecked",
      requested: null,
      spelling: null,
      on_disk: onDisk,
      on_disk_skill: null,
      message: `unchecked (on disk ${onDisk || "unknown"})`,
    };
  }
  const parsed = parseSkillsRevisionArg(value);
  if (parsed.spelling === "skill") {
    const entry = (manifest?.skills || []).find((skill) => skill?.id === parsed.id) || null;
    const onDiskSkill = entry ? { id: entry.id, version: entry.version ?? null } : null;
    const match = Boolean(entry) && entry.version === parsed.version;
    return {
      status: match ? "match" : "mismatch",
      requested: parsed.requested,
      spelling: "skill",
      on_disk: onDisk,
      on_disk_skill: onDiskSkill,
      message: match
        ? `match (${parsed.requested}; bundle ${onDisk || "unknown"})`
        : `mismatch: loaded ${parsed.requested}, on disk ${
            onDiskSkill ? `${onDiskSkill.id}@${onDiskSkill.version}` : `no skill named ${parsed.id}`
          } (bundle ${onDisk || "unknown"}) — start a fresh session`,
    };
  }
  const match = Boolean(onDisk) && onDisk === parsed.requested;
  return {
    status: match ? "match" : "mismatch",
    requested: parsed.requested,
    spelling: "bundle",
    on_disk: onDisk,
    on_disk_skill: null,
    message: match
      ? `match (${onDisk})`
      : `mismatch: loaded ${parsed.requested}, on disk ${onDisk || "unknown"} — start a fresh session`,
  };
}

export function skillsRevisionTextLines(result) {
  const revision = result?.skills_revision;
  return revision ? [`Skills revision: ${revision.message}`] : [];
}

// The pin checks (ADR 0002, campaigns-os#466): one executable per project. The
// project pin (an exact devDependency or dependency on this package) comes
// first, the kernel version the Build Packet records second. Only an exact
// version is a pin — a range or tag names no one executable, so it is reported
// as `range` and the project counts as unpinned.
const PIN_PACKAGE_NAME = "@nextcommerce/campaigns-os";
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// npm reads `=1.2.3` and `v1.2.3` as the exact version 1.2.3.
const EXACT_PIN_SPEC_RE = /^=?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
// peerDependencies and optionalDependencies install nothing this project runs.
const PIN_KEYS = ["devDependencies", "dependencies"];
const PIN_BLOCKING_STATUSES = new Set(["conflicting_pin", "stale_pin"]);

function exactPinVersion(spec) {
  return typeof spec === "string" ? EXACT_PIN_SPEC_RE.exec(spec)?.[1] ?? null : null;
}

// An installed package's own manifest (node_modules/<name>/package.json or
// node_modules/@<scope>/<name>/package.json) is never the project: run from
// inside an install, the walk resolves the enclosing project as if the working
// directory were that project. Any other manifest is a candidate, even one with
// a node_modules segment higher up its path.
function isInstalledPackageDir(dir) {
  const parent = dirname(dir);
  if (basename(parent) === "node_modules") return true;
  return basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules";
}

function nearestPackageJson(startDir) {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (!isInstalledPackageDir(dir) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

// npm's array form, or the `{ packages: [...] }` object form yarn also reads.
function declaresWorkspaces(manifest) {
  const workspaces = manifest.workspaces;
  return Array.isArray(workspaces) || (isObject(workspaces) && Array.isArray(workspaces.packages));
}

// An empty or whitespace-only spec pins nothing, so it counts as absent rather
// than as a range.
function pinSpecsIn(manifest) {
  return PIN_KEYS.flatMap((key) => {
    const spec = manifest?.[key]?.[PIN_PACKAGE_NAME];
    return typeof spec === "string" && spec.trim() ? [{ key, spec: spec.trim() }] : [];
  });
}

// The project pin is the first exact spec on the walk up from the nearest
// manifest, devDependencies before dependencies in each; a range is kept only
// if nothing exact turns up. A manifest that names nothing is
// neutral and walked through: it cannot supply a pin, so stopping there would
// only hide one higher up. The walk ends after a workspace root, at the
// filesystem root, and at a manifest it cannot read, with a warning, since
// that one might have held the pin.
function resolveProjectPin(packageJsonPath, warnings) {
  let range = null;
  for (let path = packageJsonPath; path; path = nearestPackageJson(dirname(dirname(path)))) {
    const problem = {};
    const manifest = readPinJson(path, problem);
    if (!manifest) {
      warnings.push(path === packageJsonPath
        ? `Project pin unavailable: ${path} ${problem.reason}.`
        : `Project pin walk stopped at ${path}: it ${problem.reason}.`);
      break;
    }
    const specs = pinSpecsIn(manifest);
    const exact = specs.find(({ spec }) => exactPinVersion(spec));
    if (exact) return { projectSpec: exact.spec, projectManifest: path, projectKey: exact.key };
    if (!range && specs.length) range = { projectSpec: specs[0].spec, projectManifest: path, projectKey: specs[0].key };
    if (declaresWorkspaces(manifest) || dirname(dirname(path)) === dirname(path)) break;
  }
  return range || { projectSpec: null, projectManifest: packageJsonPath, projectKey: null };
}

// A malformed file is a missing source plus a warning, never a crash: the pin
// line is one report among several and must not take the status down with it.
// A leading BOM is valid to npm, so it is valid here.
function readPinJson(path, problem = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    problem.reason = `could not be read (${error.code || error.message})`;
    return null;
  }
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    problem.reason = "is not valid JSON";
    return null;
  }
  if (isObject(value)) return value;
  problem.reason = "is not a JSON object";
  return null;
}

/** The project and packet sources `tooling status` compares, read from disk. */
export function resolvePinSources(args, { cwd = process.cwd() } = {}) {
  const warnings = [];
  const explicitPacket = optionalString(args.packet);
  let packetPath = explicitPacket ? resolve(cwd, explicitPacket) : null;
  let packet = null;
  const packetProblem = {};
  if (packetPath) {
    if (!existsSync(packetPath)) throw refused(`Build Packet not found: ${packetPath}`);
    packet = readPinJson(packetPath, packetProblem);
  }
  // An explicit packet names its project: its target repo, whatever the cwd.
  const projectStart = packet ? targetRepoFor(packetPath, packet) : cwd;
  const packageJsonPath = nearestPackageJson(projectStart);
  if (!packetPath) {
    // The contracted home of the packet is the project root beside package.json
    // (prepare-build's default --out), the same place readback discovers it.
    packetPath = join(packageJsonPath ? dirname(packageJsonPath) : resolve(cwd), "campaign-runtime.build.json");
    if (existsSync(packetPath)) packet = readPinJson(packetPath, packetProblem);
  }

  const { projectSpec, projectManifest, projectKey } = resolveProjectPin(packageJsonPath, warnings);

  let packetVersion = null;
  let packetVersionIgnored = null;
  if (packet && Object.hasOwn(packet, "campaigns_os_version")) {
    const recorded = packet.campaigns_os_version;
    if (typeof recorded === "string" && EXACT_VERSION_RE.test(recorded)) {
      packetVersion = recorded;
    } else {
      // Kept verbatim (a non-string as its JSON text) so the Pin: line can say
      // the field was there and ignored, not that it was absent.
      packetVersionIgnored = typeof recorded === "string" ? recorded : JSON.stringify(recorded);
      warnings.push(`Packet campaigns_os_version ignored: ${JSON.stringify(recorded)} in ${packetPath} is not an exact version.`);
    }
  } else if (existsSync(packetPath) && !packet) {
    warnings.push(`Packet pin unavailable: ${packetPath} ${packetProblem.reason}.`);
  }
  return {
    packageJsonPath,
    projectSpec,
    projectManifest,
    projectKey,
    packetPath: packet ? packetPath : null,
    packetVersion,
    packetVersionIgnored,
    warnings,
  };
}

/**
 * Pure: the pin status from the two sources and the running version. The
 * message names where each version it quotes was read: the key and manifest of
 * the project pin, the packet file of the recorded version.
 */
export function evaluatePin({ projectSpec = null, projectManifest = null, projectKey = null, packetVersion = null, packetVersionIgnored = null, packetPath = null, running, force = false }) {
  const projectVersion = exactPinVersion(projectSpec);
  const range = projectSpec != null && !projectVersion ? projectSpec : null;
  const source = projectVersion ? "project" : packetVersion ? "packet" : null;
  const version = projectVersion || packetVersion || null;
  const manifest = projectManifest || "package.json";
  const projectFrom = `${projectKey || "devDependencies"} in ${manifest}`;
  const packetFrom = `campaigns_os_version in ${packetPath || "the Build Packet"}`;
  const noPacket = packetVersionIgnored != null
    ? `campaigns_os_version ${JSON.stringify(packetVersionIgnored)} in ${packetPath || "the Build Packet"} is not a bare x.y.z version and was ignored`
    : packetPath ? `no campaigns_os_version in ${packetPath}` : "no packet version";
  let status;
  let message;
  if (projectVersion && packetVersion && projectVersion !== packetVersion) {
    status = "conflicting_pin";
    message = `conflicting_pin — project pins ${projectVersion} (${projectFrom}), packet records ${packetVersion} (${packetFrom})`;
  } else if (!version) {
    status = "unpinned";
    const project = range != null
      ? `project range ${range || '""'} (${projectFrom}) is not an exact version`
      : projectManifest ? `no project pin in ${projectManifest}` : "no package.json found";
    message = `unpinned (${project}; ${noPacket})`;
  } else if (version !== running) {
    status = "stale_pin";
    message = `stale_pin — ${source === "project" ? `project pins ${version} (${projectFrom})` : `packet records ${version} (${packetFrom})`}, running ${running}`;
  } else {
    status = "match";
    message = `match (${version} — ${source === "project" ? projectFrom : packetFrom})`;
  }
  const forced = force && PIN_BLOCKING_STATUSES.has(status);
  return {
    source,
    version,
    running,
    status,
    range,
    packet_version: packetVersion,
    packet_version_ignored: packetVersionIgnored,
    project_version: projectVersion,
    project_manifest: projectManifest,
    project_key: projectKey,
    forced,
    message: forced ? `${message} (overridden by --force)` : message,
  };
}

// Each line names the manifest and key the pin (or range) was read from; with
// neither, the nearest manifest and devDependencies, where the ADR puts a pin.
function pinAction(pin, sources) {
  const manifest = pin.project_manifest || "the project's package.json";
  const key = pin.project_key || "devDependencies";
  const packet = sources.packetPath || "the Build Packet";
  if (pin.status === "conflicting_pin") {
    return `Align the project pin: set ${key}["${PIN_PACKAGE_NAME}"] in ${manifest} to ${pin.packet_version}, or re-run prepare-build with ${pin.project_version} so ${packet} records it. Pass --force to proceed anyway (recorded).`;
  }
  if (pin.source === "project") {
    return `Run the pinned executable (${LOCAL_INVOCATION_PREFIX} from the project), or move the pin: set ${key}["${PIN_PACKAGE_NAME}"] in ${manifest} to ${pin.running} and reinstall. Pass --force to proceed anyway (recorded).`;
  }
  const pinStep = pin.project_key
    ? `set ${key}["${PIN_PACKAGE_NAME}"] in ${manifest} to ${pin.running} (it holds the range ${JSON.stringify(pin.range)})`
    : `add "${PIN_PACKAGE_NAME}": "${pin.running}" to ${key} in ${manifest}`;
  return `Run the version ${packet} records (${pin.packet_version}), or pin the project: ${pinStep}; the next prepare-build re-stamps ${packet}. Pass --force to proceed anyway (recorded).`;
}

export function pinTextLines(result) {
  return result?.pin ? [`Pin: ${result.pin.message}`] : [];
}

function toolingCommand(args) {
  const action = args._[1] || "status";
  if (action !== "status") throw refused(`Unknown tooling command: ${action}`);
  if (args.target === true) throw refused("Missing value for --target");
  if (args.platform === true) throw refused("Missing value for --platform");
  if (args["skills-revision"] === true) {
    // The example is the bundle this CLI ships, read from skills.json, so the
    // refusal never teaches a revision that has since moved.
    const shipped = readJson(join(ROOT, "skills.json")).bundle_revision;
    throw refused(`Missing value for --skills-revision. Pass the bundle revision the skill you loaded states on its first body line (for example --skills-revision ${shipped}), or that skill's <skill-id>@<version>.`);
  }
  // Bare, like --dry-run: the shared parser would read `--force true` as a
  // value, and an override must never hinge on how a token happened to parse.
  if (Object.hasOwn(args, "force") && args.force !== true) {
    throw refused(`--force takes no value (got ${JSON.stringify(args.force)}); write \`--force\` on its own.`);
  }
  // The parser keeps `--no-force` as its own key, so without this it would
  // run as if unsaid and the operator would never learn it did nothing.
  if (Object.hasOwn(args, "no-force")) {
    throw refused("--no-force is not a flag of tooling status; --force is bare and off by default");
  }
  if (args.packet === true) throw refused("Missing value for --packet");
  const pinSources = resolvePinSources(args);

  const pkg = readJson(join(ROOT, "package.json"));
  // An explicit --target or --platform (`all` included) is checked as asked.
  // Without either, only the platform directories that already hold a
  // Campaigns OS skill are held to this bundle: the documented install is one
  // platform, and reading the other two as stale told that operator to install
  // everywhere and exit 2 on a correct setup.
  const explicitSkillScope = isNonEmptyString(args.target) || isNonEmptyString(args.platform);
  const allSkillStatus = installSkills(args.target, true, args.platform || "all");
  const skillScope = explicitSkillScope
    ? { status: allSkillStatus, scope: "requested", notInstalled: [] }
    : scopeSkillStatusToInstalledPlatforms(allSkillStatus);
  const skillStatus = skillScope.status;
  const skillActions = classifyToolingSkillActions(skillStatus.skills || []);
  const staleSkills = skillActions.actionable;
  const install = localInstallStatus(ROOT, pkg);
  // The git axis is a checkout-only question. A package install (npx cache,
  // a consumer's node_modules, a global install) has no upstream of its own,
  // and any git repository enclosing it belongs to someone else — reporting
  // that repository's branch as this package's freshness would be a lie.
  const git = install.mode === "checkout"
    ? localGitStatus(ROOT)
    : {
        status: "not_applicable",
        reason: `${install.mode_label}; freshness is the pinned commit, not a git upstream`,
        root: null,
        branch: null,
        head: install.pinned?.commit || null,
        upstream: null,
        ahead: null,
        behind: null,
        dirty: false,
        note: install.pinned?.commit
          ? "This package is pinned at the resolved commit; re-run with a newer pin to update."
          : "No pinned commit could be derived for this package location; compare the package version manually.",
      };
  const cli = localCliStatus(pkg, install);
  const packageStatus = {
    name: pkg.name || null,
    version: pkg.version || null,
    private: Boolean(pkg.private),
    registry: install.mode !== "checkout"
      ? {
          checked: false,
          status: "not_applicable_package_install",
          note: "Installed as a package pinned at a commit; there is no npm dist-tag to compare against. Re-run with a newer pin to update.",
        }
      : pkg.private
        ? {
            checked: false,
            status: "not_applicable_private_package",
            note: "This checkout is private; npm does not automatically provide latest tooling.",
          }
        : {
            checked: false,
            status: "not_checked",
            note: "Registry freshness is not checked by tooling status; compare package manager lockfiles in the consuming repo.",
          },
  };
  const ready = [install.summary];
  const actions = [];
  const warnings = [];

  for (const skill of skillActions.warnings) {
    const identity = toolingSkillIdentity(skill);
    if (skill?.action === "occupied_by_other") {
      warnings.push(`Skill slot ${identity} is occupied by another skill and was left in place. No Campaigns OS refresh is required for this slot.`);
    } else {
      warnings.push(`Skill ${identity} reported unrecognized sync action ${JSON.stringify(skill?.action ?? null)}. It does not block readiness; review the action before assigning remediation.`);
    }
  }

  if (install.mode === "checkout") {
    if (git.status === "ok" && git.behind > 0) {
      actions.push("Update this checkout before running a dogfood build: git pull --ff-only (or wt sync in a worktree).");
    } else if (git.status !== "ok") {
      warnings.push(`Git freshness unavailable: ${git.reason}.`);
    } else if (!git.upstream) {
      warnings.push("No git upstream is configured for this checkout; remote freshness is advisory only.");
    }
  } else if (!install.pinned?.commit) {
    warnings.push(`No pinned commit could be derived for this ${install.mode_label}; the package version is ${pkg.version || "unknown"}. Compare it against the commit you oriented on before relying on it.`);
  }

  if (skillScope.scope === "installed_platforms" && skillScope.notInstalled.length) {
    const checked = skillStatus.targets.map((target) => target.platform_label).join(", ");
    const skipped = skillScope.notInstalled.map((target) => target.platform_label);
    ready.push(`Skills checked for ${checked}; ${skipped.join(", ")} ${skipped.length === 1 ? "has" : "have"} no Campaigns OS skills installed and ${skipped.length === 1 ? "was" : "were"} not checked (pass --platform to check one).`);
  }

  if (skillScope.scope === "no_platform_installed") {
    // Nothing to refresh: the documented install is one platform, the
    // harness in use, so name the choice rather than installing everywhere.
    // The command ends its own sentence and is runnable as printed (Claude
    // Code, the documented install). The other platforms follow in a separate
    // sentence of prose: no `<a|b>` template or parenthesis a shell would read
    // as a redirect or a subshell if the command were copied with it.
    actions.push(`Install bundled skills for the harness you use: ${cli.invocation_prefix} install-skills --platform claude. Use --platform codex for Codex, or --platform agents for shared agent skills such as Cursor's. Restart local agent sessions afterwards.`);
  } else if (staleSkills.length) {
    const stalePlatforms = SKILL_PLATFORMS.map((platform) => platform.id)
      .filter((id) => staleSkills.some((skill) => skill.platform === id));
    const invocations = args.target
      ? [["--target", args.target]]
      : skillScope.scope === "installed_platforms" && stalePlatforms.length < SKILL_PLATFORMS.length
        ? stalePlatforms.map((platform) => ["--platform", platform])
        : [["--platform", args.platform || "all"]];
    const commands = invocations.map((skillArgs) => `${cli.invocation_prefix} install-skills ${skillArgs.join(" ")}`);
    actions.push(`Refresh installed skills: ${commands.join(" and ")}. Restart local agent sessions afterwards.`);
  }

  if (install.mode === "checkout" && cli.global_binary.status === "not_found") {
    warnings.push("No global campaigns-os binary was found; use `npm run campaigns-os -- ...` from this checkout or `node ./bin/campaigns-os.mjs ...`.");
  } else if (install.mode === "node_modules" && cli.global_binary.status !== "found") {
    // A consumer install runs through npm's bin resolution; no PATH ritual.
    warnings.push(cli.global_binary.status === "found_other_install"
      ? `The campaigns-os on PATH (${cli.global_binary.path}) is a different install from the one inspected here (${install.location}); run commands as \`${LOCAL_INVOCATION_PREFIX} <command>\` from the folder that pins this toolkit so this copy runs.`
      : `campaigns-os is not on PATH; run commands as \`${LOCAL_INVOCATION_PREFIX} <command>\` from the folder that pins this toolkit (npm resolves node_modules/.bin), or call node ${cli.local_bin} directly.`);
  } else if (install.mode !== "checkout" && install.mode !== "npx_cache" && cli.global_binary.status === "not_found") {
    warnings.push(`campaigns-os is not on PATH; call node ${cli.local_bin} directly.`);
  } else if (install.mode !== "checkout" && cli.global_binary.status === "found_other_install") {
    // An npx cache is ephemeral: never tell the operator to put its .bin on
    // PATH. The pinned npx form is what makes the inspected copy run.
    warnings.push(install.mode === "global"
      ? `The campaigns-os on PATH is a different install; use \`${cli.invocation_prefix} <command>\` to run the global copy inspected here.`
      : install.mode === "npx_cache"
      ? `The campaigns-os on PATH (${cli.global_binary.path}) is a different install from the one inspected here (${install.location}); bare commands would run that other copy. Use \`${cli.invocation_prefix} <command>\` so the pinned copy runs.`
      : cli.bin_dir
        ? `The campaigns-os on PATH (${cli.global_binary.path}) is a different install from the one inspected here (${cli.local_bin}); bare commands would run that other copy. Run export PATH="${cli.bin_dir}:$PATH" to put this install first.`
        : `The campaigns-os on PATH (${cli.global_binary.path}) is a different install from the one inspected here (${cli.local_bin}); call node ${cli.local_bin} directly.`);
  }

  if (git.status === "ok" && git.dirty) {
    warnings.push("This checkout has uncommitted changes; verify they are intentional before publishing or comparing freshness.");
  }

  // The manifest THIS CLI ships, read from its own package root — never from the
  // working directory, which may be a campaign repo with no skills.json at all.
  const skillsRevision = evaluateSkillsRevision(args["skills-revision"], readJsonIfExists(join(ROOT, "skills.json")) || {});
  if (skillsRevision.status === "mismatch") {
    actions.push(`Start a fresh session: the skills text you are reading is ${skillsRevision.requested}, and this CLI ships ${skillsRevision.on_disk || "an unknown bundle revision"}. Re-running this command cannot refresh skill text already in context.`);
  }

  // The CLI's own package.json is the running version: the executable this
  // command is, not whichever one the project would have resolved.
  const pin = evaluatePin({
    projectSpec: pinSources.projectSpec,
    projectManifest: pinSources.projectManifest,
    projectKey: pinSources.projectKey,
    packetVersion: pinSources.packetVersion,
    packetVersionIgnored: pinSources.packetVersionIgnored,
    packetPath: pinSources.packetPath,
    running: pkg.version,
    force: args.force === true,
  });
  warnings.push(...pinSources.warnings);
  const pinBlocks = PIN_BLOCKING_STATUSES.has(pin.status) && !pin.forced;
  if (PIN_BLOCKING_STATUSES.has(pin.status)) {
    (pin.forced ? warnings : actions).push(pin.forced
      ? `Pin ${pin.status} overridden by --force; this run proceeds on ${pin.running}.`
      : pinAction(pin, pinSources));
  }

  const gitBlocks = git.status === "ok" && Number.isFinite(git.behind) && git.behind > 0;
  const ok = !gitBlocks && staleSkills.length === 0 && skillsRevision.status !== "mismatch" && !pinBlocks;
  return {
    ok,
    status: ok ? "ready" : "attention_required",
    // A bare status string, so a consumer can branch on it without reaching into
    // an object; the detail sits beside it under skills_revision.
    revision_check: skillsRevision.status,
    skills_revision: skillsRevision,
    pin,
    install,
    package: packageStatus,
    git,
    cli,
    skills: {
      ok: staleSkills.length === 0,
      stale_count: staleSkills.length,
      // requested: --target/--platform named the scope. installed_platforms:
      // only platforms with Campaigns OS skills installed were checked, and
      // not_installed_platforms lists the rest. no_platform_installed: none
      // had any, so every platform is listed there and was checked.
      scope: skillScope.scope,
      not_installed_platforms: skillScope.notInstalled,
      status: skillStatus,
    },
    ready,
    actions,
    warnings,
  };
}

export async function toolingStatusCommand(args, options = {}) {
  const result = toolingCommand(args);
  const { gatewayLoginStatus } = await import("./admin-transport.mjs");
  result.gateway_login = await gatewayLoginStatus(options);
  const auth = result.gateway_login;
  if (!auth.accounts.length) result.warnings.push(auth.state === "unavailable"
    ? "Gateway credential storage is unavailable or busy. Check user credential directory permissions and keychain access; wait for another campaigns-os process to finish. See docs/gateway-login.md for interrupted-process recovery."
    : `Gateway login: ${auth.state}. Use ${result.cli.invocation_prefix} login --store <subdomain>.`);
  for (const account of auth.accounts) (account.state === "logged_in" ? result.ready : result.warnings).push(`Gateway login: ${account.state}; store ${account.store}; access remaining ${account.remaining_seconds}s; gateway ${auth.gateway}; reported version ${account.gateway_version || "unavailable"} (local credential metadata only).`);
  return result;
}

export function toolingDiagnose(args, { runTooling = toolingCommand, runDoctor = doctorCommand } = {}) {
  let tooling = null;
  let doctor = null;
  let inspectionFailed = false;
  // Inputs are used only by local producers, never echoed, and mutation flags
  // are not forwarded. Even an exception's message may contain a secret path.
  // An unnamed platform is not forwarded, so status checks only the platforms
  // that hold Campaigns OS skills, as it does when run directly.
  try {
    tooling = runTooling({ _: ["tooling", "status"], ...(args.platform ? { platform: args.platform } : {}), ...(typeof args.target === "string" ? { target: args.target } : {}) });
  } catch { /* unavailable, no raw producer exception in a support export */ }
  if (args.packet !== undefined) {
    try {
      doctor = runDoctor({ packet: args.packet, "no-write": true, ...(typeof args.context === "string" ? { context: args.context } : {}), ...(typeof args.report === "string" ? { report: args.report } : {}) });
    } catch { inspectionFailed = true; }
  }
  // `installed` only when status actually narrowed to installed platforms; an
  // unnamed platform that checked every one (nothing installed) stays `all`.
  const platform = args.platform || (tooling?.skills?.scope === "installed_platforms" ? "installed" : "all");
  return diagnosticExport({ tooling, doctor, platform, inspectionFailed });
}

function localCliStatus(pkg, install = { mode: "checkout", pinned: null }) {
  const resolved = resolveInvocation(ROOT, pkg, install);
  return {
    local_bin: resolved.local_bin,
    local_bin_exists: resolved.local_bin_exists,
    invocation: `${resolved.prefix} <command>`,
    invocation_prefix: resolved.prefix,
    bin_dir: resolved.bin_dir,
    global_binary: resolved.global_binary,
  };
}

function localGitStatus(root) {
  const inside = runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { status: "unavailable", reason: "git rev-parse failed", error: inside.error };
  if (inside.stdout !== "true") return { status: "unavailable", reason: "not a git worktree" };

  const head = runCommand("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  if (!head.ok) return { status: "unavailable", reason: "git HEAD could not be resolved", error: head.error };

  const branch = runCommand("git", ["-C", root, "branch", "--show-current"]);
  const upstream = runCommand("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const dirty = runCommand("git", ["-C", root, "status", "--porcelain"]);
  if (!dirty.ok) return { status: "unavailable", reason: "git status failed", error: dirty.error };
  let ahead = null;
  let behind = null;
  const upstreamName = upstream.ok ? upstream.stdout : "";
  if (upstreamName) {
    const counts = runCommand("git", ["-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstreamName}`]);
    if (!counts.ok) return { status: "unavailable", reason: "git ahead/behind comparison failed", error: counts.error };
    const [left, right] = counts.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
    ahead = Number.isFinite(left) ? left : null;
    behind = Number.isFinite(right) ? right : null;
  }

  return {
    status: "ok",
    root,
    branch: branch.ok && branch.stdout ? branch.stdout : null,
    head: head.stdout || null,
    upstream: upstreamName || null,
    ahead,
    behind,
    dirty: dirty.stdout.length > 0,
    note: upstreamName
      ? "Freshness is compared to the locally fetched upstream ref; run git fetch first for a network-current answer."
      : "No upstream configured; compare this checkout manually before relying on it.",
  };
}

function runCommand(command, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      error: error.message || String(error),
    };
  }
}



// A retired record only ever removes OUR stale copy: the destination SKILL.md
// must carry the retired id as its frontmatter name AND a description starting
// with the recorded prefix. Anything else wearing the name (e.g. the published
// skill that the name was released to) is left untouched and reported.
function matchesRetiredSkill(skillText, record) {
  const lines = String(skillText).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  let name = null;
  let description = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const nameMatch = /^name:\s*['"]?([^'"\s]+)/.exec(line);
    if (nameMatch) name = nameMatch[1];
    const descMatch = /^description:\s*['"]?(.*)$/.exec(line);
    if (descMatch) description = descMatch[1];
  }
  if (name !== record.id) return false;
  const prefix = record.detect_description_prefix;
  return typeof prefix === "string" && prefix.length > 0 && (description || "").startsWith(prefix);
}

function sweepRetiredSkills({ retired, target, targetDir, dryRun }) {
  const swept = [];
  for (const record of retired) {
    if (!record || typeof record.id !== "string" || !record.id) continue;
    const destinationDir = join(targetDir, record.id);
    const destination = join(destinationDir, "SKILL.md");
    if (!existsSync(destination)) continue;
    const ours = matchesRetiredSkill(readFileSync(destination, "utf8"), record);
    if (ours) {
      if (!dryRun) rmSync(destinationDir, { recursive: true, force: true });
      swept.push({
        name: record.id,
        action: "retired",
        platform: target.platform,
        platform_label: target.platform_label,
        destination,
        replaced_by: record.replaced_by || null,
        note: dryRun
          ? `Stale retired skill would be removed (renamed to ${record.replaced_by || "a new id"}).`
          : `Stale retired skill removed (renamed to ${record.replaced_by || "a new id"}).`,
      });
    } else {
      swept.push({
        name: record.id,
        action: "occupied_by_other",
        platform: target.platform,
        platform_label: target.platform_label,
        destination,
        replaced_by: record.replaced_by || null,
        note: "Slot holds a different skill (not this repo's retired copy) — left in place.",
      });
    }
  }
  return swept;
}

function installSkillsToTarget({ sourceDir, target, dryRun, retired = [] }) {
  const targetDir = target.target_directory;
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = [];

  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  skills.push(...sweepRetiredSkills({ retired, target, targetDir, dryRun }));

  for (const entry of entries) {
    const name = entry.name;
    const sourceSkillDir = join(sourceDir, name);
    const source = join(sourceSkillDir, "SKILL.md");
    if (!existsSync(source)) continue;

    const destinationDir = join(targetDir, name);
    const destination = join(destinationDir, "SKILL.md");
    const sourceDescriptor = describeSkillDirectory(sourceSkillDir);
    const hasDestination = existsSync(destination);
    const destinationDescriptor = hasDestination ? describeSkillDirectory(destinationDir) : null;
    const action = !hasDestination
      ? "created"
      : destinationDescriptor?.hash === sourceDescriptor.hash
        ? "unchanged"
        : "updated";

    if (!dryRun && action !== "unchanged") {
      rmSync(destinationDir, { recursive: true, force: true });
      cpSync(sourceSkillDir, destinationDir, { recursive: true, force: true });
    }

    skills.push({
      name,
      action,
      platform: target.platform,
      platform_label: target.platform_label,
      source,
      destination,
      from: destinationDescriptor,
      to: sourceDescriptor,
    });
  }

  return {
    ok: true,
    status: dryRun ? "dry_run" : "installed",
    platform: target.platform,
    platform_label: target.platform_label,
    source_directory: sourceDir,
    target_directory: targetDir,
    skills,
    note: dryRun
      ? "Dry run only; no skill files were written."
      : `Restart ${target.platform_label} session to pick up new or updated skills.`,
  };
}

function listFilesRecursive(dir) {
  const files = [];
  const root = resolve(dir);
  if (!existsSync(root)) return files;

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  }

  walk(root);
  return files;
}

function describeSkillDirectory(dir) {
  const skillPath = join(dir, "SKILL.md");
  const skillContent = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
  const version = extractFrontmatterValue(skillContent, "version");
  const hash = createHash("sha256");
  const relativeFiles = listFilesRecursive(dir);
  for (const file of relativeFiles) {
    const fullPath = join(dir, file);
    hash.update(file);
    hash.update("\0");
    hash.update(existsSync(fullPath) ? readFileSync(fullPath) : "__MISSING__");
    hash.update("\0");
  }
  const digest = hash.digest("hex").slice(0, 12);
  return {
    version,
    hash: digest,
    label: version ? `v${version}` : `sha256:${digest}`,
  };
}

function extractFrontmatterValue(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split("\n")) {
    const parts = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (parts?.[1] === key) return parts[2].replace(/^["']|["']$/g, "");
  }
  return null;
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

function addIssue(collection, code, message, detail = null) {
  collection.push(detail ? { code, message, detail } : { code, message });
}

function writeResult(result, args, failureCode, { headerLines = [] } = {}) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result, { headerLines });
  }
  if (failureCode) process.exitCode = failureCode;
}

const POLISH_CAPTURE_TEXT_FINDING_LIMIT = 100;
const POLISH_CAPTURE_TEXT_SOURCE_LIMIT = 16;
const POLISH_CAPTURE_TEXT_INCOMPLETE_LIMIT = 64;
const POLISH_CAPTURE_TEXT_PROBLEM_LIMIT = 16;
const POLISH_CAPTURE_TEXT_RAW_PROBLEM_LIMIT = 64;
const POLISH_CAPTURE_TEXT_RESOURCE_TYPE_LIMIT = 32;
const POLISH_CAPTURE_TEXT_ACTION_LIMIT = 8;
const SAFE_POLISH_CAPTURE_PROBLEM_CODES = new Set(POLISH_CAPTURE_PROBLEM_CODES);
// The field is documented as drawn from the beacon allowlist, so the renderer prints nothing outside it.
const SAFE_POLISH_RESOURCE_TYPES = new Set(POLISH_BEACON_RESOURCE_TYPES);
const SAFE_POLISH_CHECKPOINT_REASONS = new Map([
  ["polish.hidden_eager_media.capture_malformed", "Package-owned page-load evidence or its governing authority is missing, malformed, or inconsistent."],
  ["polish.hidden_eager_media.capture_stale", "Package-owned page-load evidence is stale for the current build, campaign, routes, or viewports."],
  ["polish.hidden_eager_media.capture_incomplete", "Package-owned page-load capture is incomplete; repair the listed capture problems and recapture."],
  ["polish.hidden_eager_media", "Hidden eager media exceeds 1,048,576 bytes; repair and recapture, or record an exact waiver."],
  ["polish.hidden_eager_media.waived", "Hidden eager-media findings are covered by an exact named-human waiver."],
  ["polish.hidden_eager_media.pass", "Package-owned page-load evidence has no blocking hidden eager media."],
  ["polish.hidden_eager_media.not_applicable", "Package-owned page-load evidence is not applicable before completed assembly."],
]);
const SAFE_POLISH_CHECKPOINT_ACTIONS = new Map([
  ["polish.hidden_eager_media.capture", "campaigns-os polish capture --packet <packet> --base-url <url>"],
  ["polish.hidden_eager_media.install_browser", "campaigns-os qa install-browser"],
  ["polish.hidden_eager_media.waive", "campaigns-os checkpoint waive --packet <packet> --gate polish.hidden_eager_media --reason \"<why>\" --waived-by \"<named human>\" --review-condition \"<trigger>\""],
  ["polish.hidden_eager_media.repair", "Repair the reported media, then recapture."],
  ["polish.hidden_eager_media.repair_authority", "Repair packet/report authority and the mapped route plan, then recapture."],
  ["polish.hidden_eager_media.local_proof_rebuild", HIDDEN_EAGER_MEDIA_ACTIONS.local_proof_rebuild.description],
]);

function safePolishFindingRoute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "[route unavailable]";
  }
  try {
    const route = new URL(value, "https://polish-capture.invalid").pathname;
    return route.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(route)
      ? route
      : "[route unavailable]";
  } catch {
    return "[route unavailable]";
  }
}

function safePolishFindingSource(value) {
  if (typeof value !== "string") return "[source unavailable]";
  const redacted = redactCaptureUrl(value);
  return typeof redacted === "string" && redacted.length <= 4_096
    ? redacted
    : "[source unavailable]";
}

// Origin parsing lives in captureOrigin; the length bound is this renderer's
// own line policy, like the route and source bounds above.
function safePolishFailedOrigin(value) {
  return typeof value === "string" && value.length <= 2_048 && captureOrigin(value) === value ? value : null;
}

function safePolishByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "unavailable";
}

export function formatPolishCaptureText(result) {
  const status = ["ready", "ready_with_waivers", "blocked"].includes(result?.status)
    ? result.status
    : "unknown";
  const measurementStatus = ["complete", "incomplete"].includes(result?.measurement?.status)
    ? result.measurement.status
    : "unknown";
  const checkpointFindings = Array.isArray(result?.checkpoint?.findings) ? result.checkpoint.findings : [];
  const observedFindings = Array.isArray(result?.observed_findings) ? result.observed_findings : [];
  const findingSource = checkpointFindings.length ? checkpointFindings : observedFindings;
  const findings = findingSource.slice(0, POLISH_CAPTURE_TEXT_FINDING_LIMIT);
  const lines = [
    `Status: ${status.toUpperCase()}`,
    `Measurement: ${measurementStatus.toUpperCase()}`,
  ];
  const incomplete = Array.isArray(result?.measurement?.incomplete)
    ? result.measurement.incomplete
    : [];
  const incompleteCells = incomplete.slice(0, POLISH_CAPTURE_TEXT_INCOMPLETE_LIMIT);
  if (incompleteCells.length) {
    lines.push("Capture problems:");
    for (const cell of incompleteCells) {
      const viewport = cell?.viewport === "desktop" || cell?.viewport === "mobile"
        ? cell.viewport
        : "unknown";
      const problemCodes = [...new Set((Array.isArray(cell?.problem_codes)
        ? cell.problem_codes.slice(0, POLISH_CAPTURE_TEXT_RAW_PROBLEM_LIMIT)
        : []).filter((code) => SAFE_POLISH_CAPTURE_PROBLEM_CODES.has(code)))]
        .sort()
        .slice(0, POLISH_CAPTURE_TEXT_PROBLEM_LIMIT);
      lines.push(`- Route: ${safePolishFindingRoute(cell?.route)}`);
      lines.push(`  Viewport: ${viewport}`);
      lines.push(`  Problem codes: ${problemCodes.length ? problemCodes.join(", ") : "unavailable"}`);
    }
    if (incomplete.length > incompleteCells.length) {
      lines.push(`Additional incomplete capture cells omitted: ${incomplete.length - incompleteCells.length}`);
    }
  }
  // Warning-class capture problems: recorded evidence that did not make the
  // cell incomplete (a failed cross-origin beacon, typically merchant tag
  // configuration). Shown so the operator can see it without opening the
  // assembly report; it is not a required action.
  const warnings = Array.isArray(result?.measurement?.warnings)
    ? result.measurement.warnings
    : [];
  const warningCells = warnings.slice(0, POLISH_CAPTURE_TEXT_INCOMPLETE_LIMIT);
  if (warningCells.length) {
    lines.push("Capture warnings (not blocking):");
    for (const cell of warningCells) {
      const viewport = cell?.viewport === "desktop" || cell?.viewport === "mobile"
        ? cell.viewport
        : "unknown";
      const problemCodes = [...new Set((Array.isArray(cell?.problem_codes)
        ? cell.problem_codes.slice(0, POLISH_CAPTURE_TEXT_RAW_PROBLEM_LIMIT)
        : []).filter((code) => SAFE_POLISH_CAPTURE_PROBLEM_CODES.has(code)))]
        .sort()
        .slice(0, POLISH_CAPTURE_TEXT_PROBLEM_LIMIT);
      const origins = [...new Set((Array.isArray(cell?.failed_origins)
        ? cell.failed_origins.slice(0, POLISH_CAPTURE_TEXT_SOURCE_LIMIT)
        : []).map(safePolishFailedOrigin).filter(Boolean))];
      // Which resource roles the warning class forgave. Printed beside the
      // codes so the demotion is readable here, not only in the JSON.
      const resourceTypes = [...new Set((Array.isArray(cell?.resource_types)
        ? cell.resource_types.slice(0, POLISH_CAPTURE_TEXT_RESOURCE_TYPE_LIMIT)
        : []).filter((value) => SAFE_POLISH_RESOURCE_TYPES.has(value)))].sort();
      lines.push(`- Route: ${safePolishFindingRoute(cell?.route)}`);
      lines.push(`  Viewport: ${viewport}`);
      lines.push(`  Problem codes: ${problemCodes.length ? problemCodes.join(", ") : "unavailable"}`);
      lines.push(`  Resource types: ${resourceTypes.length ? resourceTypes.join(", ") : "unavailable"}`);
      const originTotal = Number.isSafeInteger(cell?.failed_origin_count) && cell.failed_origin_count >= 0
        ? cell.failed_origin_count
        : null;
      const originCount = originTotal !== null && originTotal !== origins.length
        ? ` (${origins.length} shown of ${originTotal})`
        : "";
      lines.push(`  Failed origins: ${origins.length ? origins.join(", ") : "unavailable"}${originCount}`);
    }
    if (warnings.length > warningCells.length) {
      lines.push(`Additional capture warning cells omitted: ${warnings.length - warningCells.length}`);
    }
  }
  const safeCheckpointReason = SAFE_POLISH_CHECKPOINT_REASONS.get(result?.checkpoint?.code);
  if (safeCheckpointReason) lines.push(`Checkpoint: ${safeCheckpointReason}`);
  const safeActions = [...new Set((Array.isArray(result?.checkpoint?.required_actions)
    ? result.checkpoint.required_actions.slice(0, POLISH_CAPTURE_TEXT_ACTION_LIMIT)
    : []).map((action) => asInvocation(SAFE_POLISH_CHECKPOINT_ACTIONS.get(action?.id))).filter(Boolean))];
  for (const action of safeActions) {
    lines.push(`Required action: ${action}`);
  }
  if (!findings.length) return lines.join("\n");

  lines.push(checkpointFindings.length
    ? "Hidden eager-media findings:"
    : "Observed hidden eager-media findings (measurement incomplete):");
  for (const finding of findings) {
    const viewport = finding?.viewport === "desktop" || finding?.viewport === "mobile"
      ? finding.viewport
      : "unknown";
    const tag = finding?.tag_name === "video" || finding?.tag_name === "audio"
      ? finding.tag_name
      : "media";
    const elementIndex = Number.isSafeInteger(finding?.element_index) && finding.element_index >= 0
      ? String(finding.element_index)
      : "unknown";
    const sources = Array.isArray(finding?.sources)
      ? finding.sources.slice(0, POLISH_CAPTURE_TEXT_SOURCE_LIMIT).map(safePolishFindingSource)
      : [];
    lines.push(`- Route: ${safePolishFindingRoute(finding?.route)}`);
    lines.push(`  Viewport: ${viewport}`);
    lines.push(`  Media: ${tag} element ${elementIndex}`);
    lines.push(`  Source: ${sources.length ? sources.join(", ") : "[source unavailable]"}`);
    if (Array.isArray(finding?.sources) && finding.sources.length > sources.length) {
      lines.push(`  Additional sources omitted: ${finding.sources.length - sources.length}`);
    }
    lines.push(`  Transferred bytes: ${safePolishByteCount(finding?.transferred_bytes)}`);
    lines.push(`  Threshold bytes: ${safePolishByteCount(finding?.threshold_bytes)}`);
  }
  if (findingSource.length > findings.length) {
    lines.push(`Additional findings omitted: ${findingSource.length - findings.length}`);
  }
  return lines.join("\n");
}

function writePolishCaptureResult(result, args, failureCode) {
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatPolishCaptureText(result));
  if (failureCode) process.exitCode = failureCode;
}

function writeStandardizationReportResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatStandardizationReportMarkdown(result));
  }
  if (!result.ok) process.exitCode = 2;
}

// --- Workflow Findings Sidecar -------------------------------------------
//
// Local Finding Capture for the Learning Trail. Capture is local-first and
// public-package owned; it never requires Linear access or NEXT internal
// context, and it never phones home. See docs/workflow-findings-sidecar.md.

async function findingsCommand(args, ambient = null) {
  const sub = args._[1] || "";
  if (sub === "add") return findingsAdd(args, ambient);
  if (sub === "harvest") return findingsHarvest(args, ambient);
  if (sub === "list") return findingsList(args, ambient);
  if (sub === "export") return findingsExport(args, ambient);
  throw refused(`Unknown findings subcommand "${sub}". Use: add | harvest | list | export.`);
}

function resolveFindingsJournalPath(args, ambient = null) {
  return resolveJournalPath(args, ambient?.dir || process.cwd());
}

async function promptForFinding(current) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const stage = current.stage || (await rl.question(`Stage (${FINDING_STAGES.join("/")}): `)).trim();
    const kind = current.kind || (await rl.question(`Kind (${FINDING_KINDS.join("/")}): `)).trim();
    const summary = current.summary || (await rl.question("Summary: ")).trim();
    const details = current.details || (await rl.question("Details (optional): ")).trim() || null;
    return { stage, kind, summary, details };
  } finally {
    rl.close();
  }
}

async function findingsAdd(args, ambient = null) {
  // Flags-first so agents and scripts can record findings without prompts.
  // When required flags are missing AND stdin is a TTY, fall back to a tiny
  // interactive prompt for only stage/kind/summary/details. When required
  // flags are missing and the command is non-interactive, fail clearly.
  let stage = optionalString(args.stage);
  let kind = optionalString(args.kind);
  let summary = optionalString(args.summary === true ? null : args.summary);
  let details = optionalString(args.details === true ? null : args.details);

  const missing = [];
  if (!stage) missing.push("--stage");
  if (!kind) missing.push("--kind");
  if (!summary) missing.push("--summary");

  if (missing.length) {
    if (process.stdin.isTTY) {
      const answers = await promptForFinding({ stage, kind, summary, details });
      stage = answers.stage;
      kind = answers.kind;
      summary = answers.summary;
      details = answers.details;
    } else {
      throw refused(
        `findings add is missing required flags: ${missing.join(", ")}. `
          + `Provide them as flags (flags-first for agents/CI), e.g. `
          + `--stage ${FINDING_STAGES[0]} --kind ${FINDING_KINDS[0]} --summary "..."`,
      );
    }
  }

  const commandExitStatus = optionalString(args["command-exit-status"]);
  const finding = buildFinding({
    stage,
    kind,
    summary,
    details,
    expected: optionalString(args.expected),
    actual: optionalString(args.actual),
    severity: optionalString(args.severity),
    command: optionalString(args.command),
    command_exit_status: commandExitStatus != null ? Number.parseInt(commandExitStatus, 10) : undefined,
    source_type: optionalString(args["source-type"]),
    template_family: optionalString(args["template-family"]),
    map_id: optionalString(args["map-id"]),
    campaign_slug: optionalString(args["campaign-slug"]),
    target_repo: optionalString(args["target-repo"]),
    packet_path: optionalString(args.packet),
    assembly_report_path: optionalString(args["report"]),
    qa_run_id: optionalString(args["qa-run-id"]),
    run_id: optionalString(args["run-id"]) || optionalString(ambient?.session?.run_id),
    author_type: optionalString(args["author-type"]),
    evidence_quality: optionalString(args["evidence-quality"]),
    suggested_owner: optionalString(args["suggested-owner"]),
    safe_to_share: args["safe-to-share"],
    artifact_paths: optionalString(args["artifact-paths"]),
  });

  const journalPath = resolveFindingsJournalPath(args, ambient);
  appendFinding(journalPath, finding);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, journal: journalPath, finding }, null, 2));
    return;
  }
  console.log("Workflow finding recorded.");
  console.log(`Journal: ${journalPath}`);
  console.log(`Finding: [${finding.stage}/${finding.kind}] ${finding.summary}`);
  console.log(`ID: ${finding.id}`);
}

function findingsList(args, ambient = null) {
  const journalPath = resolveFindingsJournalPath(args, ambient);
  const { findings, malformed } = readJournal(journalPath);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, journal: journalPath, count: findings.length, findings, malformed }, null, 2));
    return;
  }
  console.log(`Workflow findings: ${findings.length}`);
  console.log(`Journal: ${journalPath}`);
  for (const finding of findings) {
    console.log(`- [${finding.stage || "?"}/${finding.kind || "?"}] ${finding.summary || "(no summary)"} (${finding.id || "no-id"})`);
  }
  if (malformed.length) {
    console.log(`Skipped ${malformed.length} malformed line(s): ${malformed.map((entry) => entry.line).join(", ")}`);
  }
}

function findingsHarvest(args, ambient = null) {
  const packetPath = resolve(requireArg(args, "packet"));
  const { packet, targetRepo, contextPath, reportPath } = resolveCampaignWorkspace(packetPath, {
    contextPath: args.context ? resolve(args.context) : undefined,
    reportPath: args.report ? resolve(args.report) : undefined,
    followContextPointer: false,
  });
  const contextExists = existsSync(contextPath);
  const reportExists = existsSync(reportPath);
  const report = reportExists ? readJson(reportPath) : null;
  const doctor = doctorPacket(packetPath, {
    contextPath: contextExists ? contextPath : null,
    reportPath: reportExists ? reportPath : null,
  });
  const artifactPaths = [
    relFromDir(dirname(packetPath), packetPath),
    contextExists ? relFromDir(dirname(packetPath), contextPath) : null,
    reportExists ? relFromDir(dirname(packetPath), reportPath) : null,
  ].filter(Boolean);

  const proposals = proposeWorkflowFindingsFromArtifacts({
    doctor,
    report,
    packet,
    packetPath,
    reportPath: reportExists ? reportPath : null,
    artifactPaths,
    runId: optionalString(args["run-id"]) || optionalString(ambient?.session?.run_id),
  });

  let written = [];
  const journalPath = resolveFindingsJournalPath(args, ambient);
  if (args.write === true) {
    written = proposals.map((finding) => appendFinding(journalPath, finding));
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "findings-harvest", journal: journalPath, write: args.write === true, count: proposals.length, proposals, written }, null, 2));
    return;
  }

  console.log(`Workflow findings proposed: ${proposals.length}`);
  console.log(`Journal: ${journalPath}`);
  for (const finding of proposals) {
    console.log(`- [${finding.stage}/${finding.kind}] ${finding.summary}`);
  }
  if (args.write === true) console.log(`Recorded ${written.length} finding(s).`);
  else console.log("Dry run only. Pass --write to append these proposals to the local journal.");
}

function proposeWorkflowFindingsFromArtifacts({ doctor, report, packet, packetPath, reportPath, artifactPaths, runId = null }) {
  const findings = [];
  const base = {
    artifact_paths: artifactPaths.join(","),
    packet_path: relFromDir(dirname(packetPath), packetPath),
    assembly_report_path: reportPath ? relFromDir(dirname(packetPath), reportPath) : null,
    map_id: packet.spec?.map_id,
    campaign_slug: packet.campaign?.public_route_slug,
    target_repo: packet.assembly?.target_repo,
    template_family: packet.assembly?.template_family,
    // Stamp the canonical run_id so the Run Record's findings snapshot is exact
    // (selected by ID) rather than inferred from timestamps. Optional —
    // harvesting without a run_id stays backward-compatible.
    run_id: optionalString(runId),
    author_type: "system",
    evidence_quality: "system_observed",
    safe_to_share: false,
  };

  for (const issue of doctor.errors || []) {
    findings.push(buildFinding({
      ...base,
      stage: stageFromIssueCode(issue.code),
      kind: "blocker",
      summary: `[${issue.code}] ${issue.message}`,
      details: "Proposed by campaigns-os findings harvest from doctor errors.",
      severity: "high",
    }));
  }

  for (const issue of doctor.warnings || []) {
    if (!harvestableWarning(issue.code)) continue;
    findings.push(buildFinding({
      ...base,
      stage: stageFromIssueCode(issue.code),
      kind: kindFromIssueCode(issue.code),
      summary: `[${issue.code}] ${issue.message}`,
      details: "Proposed by campaigns-os findings harvest from doctor warnings.",
      severity: "medium",
    }));
  }

  for (const [stage, record] of Object.entries(report?.stages || {})) {
    for (const blocker of Array.isArray(record.blockers) ? record.blockers : []) {
      findings.push(buildFinding({
        ...base,
        stage: normalizeFindingStage(stage),
        kind: "blocker",
        summary: `[${blocker.code || `stage.${stage}.blocker`}] ${blocker.message || `${stage} is blocked`}`,
        details: "Proposed by campaigns-os findings harvest from assembly report blockers.",
        severity: "high",
      }));
    }
  }

  return dedupeFindings(findings);
}

function harvestableWarning(code) {
  return /^(adapter\.|source_html\.|context\.prompts_required|deploy\.preview_url|campaign\.allowed_domains_confirmed|scope\.|template_contract\.|frontmatter\.|qa\.proof_policy)/.test(String(code || ""));
}

function stageFromIssueCode(code) {
  const normalized = String(code || "");
  if (normalized.startsWith("adapter.") || normalized.startsWith("source_html.") || normalized.startsWith("template_contract.") || normalized.startsWith("frontmatter.")) return "build";
  if (normalized.startsWith("deploy.")) return "deploy";
  if (normalized.startsWith("qa.")) return "qa";
  if (normalized.startsWith("scope.")) return "doctor";
  return "doctor";
}

function kindFromIssueCode(code) {
  const normalized = String(code || "");
  if (normalized.includes("missing") || normalized.includes("prompts_required")) return "missing_prompt";
  if (normalized.startsWith("adapter.") || normalized.startsWith("source_html.") || normalized.startsWith("template_contract.")) return "friction";
  return "automation_gap";
}

function normalizeFindingStage(stage) {
  if (stage === "prepare_build") return "start";
  if (stage === "assembly") return "build";
  if (FINDING_STAGES.includes(stage)) return stage;
  return "overall";
}

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const finding of findings) {
    const key = `${finding.stage}:${finding.kind}:${finding.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function findingsExport(args, ambient = null) {
  const journalPath = resolveFindingsJournalPath(args, ambient);
  const { findings } = readJournal(journalPath);
  // Structured JSON is explicit; Markdown summary is the default so a run
  // summary pastes straight into an issue tracker, PR, or chat.
  if (args.json) {
    console.log(JSON.stringify(exportFindingsJson(findings), null, 2));
    return;
  }
  process.stdout.write(exportSummaryMarkdown(findings));
}

// Ambient run session (Tier 3): `run start | end | status`. A session shares
// one run_id + one lifecycle journal across every command in the project
// without per-command flags — the experience for "talk to your agent and
// build". See src/run-session.mjs. Each subcommand returns { result, exitCode }
// and dispatch prints, so the result is the test surface rather than stdout.
export async function runSessionCommand(args, ambient = null, sessionHolder = null) {
  const sub = args._[1] || "status";
  if (sub === "start") return runSessionStart(args);
  if (sub === "status") return runSessionStatus(args, ambient);
  if (sub === "end") return runSessionEnd(args, ambient, sessionHolder);
  throw refused(`Unknown run subcommand "${sub}". Use: start | end | status.`);
}

function writeRunSessionResult(result, args, exitCode) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of runSessionTextLines(result)) console.log(line);
  }
  if (exitCode) process.exitCode = exitCode;
}

// The human rendering of each run subcommand's result. `run end` prints
// run-record's own summary from inside run-record (it is not silenced in text
// mode) and adds one closing line here.
function runSessionTextLines(result) {
  if (result.action === "run-start") {
    const { session } = result;
    // With a packet the session may live away from cwd (its target repo), so
    // the advertised close names the packet: it works from anywhere, including
    // the directory the operator started from. The project named is the
    // session's root: session_path is <root>/.campaign-runtime/run-session.json
    // (RUN_SESSION_REL_PATH), two levels up, not the storage directory.
    const projectDir = dirname(dirname(result.session_path));
    return [
      "Run session started.",
      `Run ID: ${session.run_id}`,
      `Lifecycle journal: ${session.lifecycle_journal}`,
      session.packet
        ? `Every campaigns-os command in ${projectDir} — or run from anywhere with --packet ${session.packet} — now auto-logs to this run; no per-command flags.`
        : "Every campaigns-os command in this project now auto-logs to this run — no per-command flags.",
      `Finish with: ${cmd("run")} end --packet ${session.packet || "<campaign-runtime.build.json>"}`,
    ];
  }
  if (result.action === "run-status") {
    if (!result.active) {
      const lines = [`No active run session. Start one with: ${cmd("run")} start`];
      const stale = result.stale_session;
      if (stale) {
        lines.push(`A stale run session file is present (${stale.run_id}, idle since ${stale.idle_since}). It will be closed out — Run Record assembled and remitted under consent — by the next \`run start\`, \`run end\`, \`start\`, or \`prepare-build\` here.`);
      }
      return lines;
    }
    const { session, progress } = result;
    const lines = [
      `Active run session: ${session.run_id}`,
      `Lifecycle journal: ${session.lifecycle_journal}`,
      `Started: ${session.started_at}`,
    ];
    if (session.packet) lines.push(`Packet: ${session.packet}`);
    lines.push(`QA attempts: ${Array.isArray(session.qa_attempts) ? session.qa_attempts.length : 0}`);
    if (progress) {
      if (progress.incomplete_stages.length) {
        lines.push(`Incomplete stages: ${progress.incomplete_stages.map((stage) => `${stage.stage} (${stage.status || "pending"})`).join(", ")}`);
      } else {
        lines.push("All assembly-report stages are terminal.");
      }
      if (progress.deviations > 0) lines.push(`Agent deviations recorded: ${progress.deviations} (see ${DEVIATION_JOURNAL_REL_PATH})`);
      lines.push(`Next command: ${progress.next_command}`);
    } else {
      lines.push(`Next command: ${cmd("next")} --packet <campaign-runtime.build.json> --json (no packet recorded on this session)`);
    }
    return lines;
  }
  if (result.action === "run-end") {
    return result.stale_closeout.map((entry) => `Stale run session ${entry.run_id} closed out${entry.record_path ? ` (Run Record ${entry.record_path}, remit ${entry.remit_state || "skipped"})` : ` without a Run Record (${entry.error})`}.`);
  }
  // run end over an active session returns run-record's summary, whose text
  // run-record already printed; only the closing line is added.
  if (result.action === "run-record") return [`Run session ${result.record.run_id} ended; session cleared.`];
  throw new Error(`Unknown run result action "${result.action}".`);
}

// The build packet a `run start` / `run end` names, canonicalised the way
// ambientRunSession canonicalises it (realpath when it exists), so a packet
// reached through a symlink is the same packet discovery and the Run Record
// see. Null without --packet.
function runSessionPacketPath(args) {
  const packetArg = optionalString(args.packet);
  return packetArg ? canonicalPath(packetArg) : null;
}

// The project a `run start` / `run end` acts on. With --packet it is the
// packet's target repo (targetRepoFor: `assembly.target_repo` resolved from the
// packet's directory, else that directory) — where the build happens and where
// the auto-opener behind start/prepare-build roots its session — so a session
// opened from the toolkit or any other directory lands with the build and is
// found again by packet from anywhere. A packet that is not written yet roots
// on its own directory (the command prints the `does not exist yet` warning);
// a packet that exists but cannot be parsed is refused with the parse error,
// never rooted on a guess — a session opened on the packet's directory when
// the packet declares a different target would be invisible to every later
// command run by packet. Without --packet it is cwd, as before.
function runSessionRootFor(args) {
  const packetPath = runSessionPacketPath(args);
  if (!packetPath) return resolve(process.cwd());
  let packet = null;
  try {
    packet = readJson(packetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // Name what failed: a parse error is a packet problem, anything else
      // (EACCES, EISDIR, …) is the file itself, said with the OS error.
      const what = error instanceof SyntaxError ? "could not be read as a build packet" : "could not be read";
      throw new Error(
        `--packet ${packetPath} ${what} (${error?.message || error}); the run session roots on its assembly.target_repo. Fix or re-point the packet, then retry.`,
      );
    }
  }
  return targetRepoFor(packetPath, packet);
}

function runSessionStart(args) {
  const rootDir = runSessionRootFor(args);
  const packet = runSessionPacketPath(args);
  const opened = openRunSession(rootDir, {
    runId: optionalString(args["run-id"]) || null,
    lifecycleJournal: isNonEmptyString(args["lifecycle-journal"]) ? resolve(args["lifecycle-journal"]) : null,
    packet,
    force: args.force === true,
  });
  if (!opened.found) {
    throw new Error(
      `A run session is already active (${opened.existing.session.run_id}). End it with \`${cmd("run")} end\`, or pass --force to replace it.`,
    );
  }
  // The packet is remembered for the whole session, so a typo would only surface
  // at `run end` after a full build. Warn now (non-fatal) if it isn't there yet.
  if (packet && !existsSync(packet) && !args.json) {
    console.warn(`Warning: --packet ${packet} does not exist yet; run end will need it (or pass --packet then).`);
  }
  ensureRuntimeStateIgnored(rootDir);
  return { result: { ok: true, action: "run-start", session: opened.found.session, session_path: opened.found.path }, exitCode: 0 };
}

function runSessionStatus(args, ambient = null) {
  const found = ambient || findRunSession(process.cwd());
  const progress = found ? runSessionProgress(found) : null;
  const stale = found ? null : findStaleRunSession(process.cwd());
  return {
    result: {
      ok: true,
      action: "run-status",
      active: Boolean(found),
      session: found?.session ?? null,
      session_path: found?.path ?? null,
      progress,
      stale_session: stale ? { run_id: stale.session.run_id, session_path: stale.path, idle_since: stale.session.updated_at || stale.session.started_at || null } : null,
    },
    exitCode: 0,
  };
}

// Session progress: incomplete assembly-report stages, the deviation count,
// and the exact next command. Read-only and best-effort; the status command
// must never fail because an artifact is missing or torn.
function runSessionProgress(found) {
  const packetPath = found.session.packet;
  if (!isNonEmptyString(packetPath) || !existsSync(packetPath)) return null;
  try {
    const packet = readJson(packetPath);
    const report = readJsonIfExists(resolveCampaignWorkspace(packetPath, { packet, followContextPointer: false }).reportPath);
    const incomplete = [];
    for (const key of ASSEMBLY_REPORT_STAGE_KEYS) {
      const status = String(report?.stages?.[key]?.status || "");
      if (!STAGE_TERMINAL_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix))) {
        incomplete.push({ stage: key, status: status || null });
      }
    }
    const deviations = readDeviations(join(found.dir, DEVIATION_JOURNAL_REL_PATH)).length;
    return {
      incomplete_stages: incomplete,
      deviations,
      qa_attempt_count: Array.isArray(found.session.qa_attempts) ? found.session.qa_attempts.length : 0,
      next_command: incomplete.length
        ? `${cmd("next")} --packet ${packetPath} --json`
        : `${cmd("run")} end --packet ${packetPath}`,
    };
  } catch {
    return null;
  }
}

async function runSessionEnd(args, ambient = null, sessionHolder = null) {
  // Use the session resolved once in main() (single source of truth).
  const found = ambient;
  if (!found) {
    // A stale session at the root this command acts on was already closed out
    // by main()'s sweep; that IS the end the operator asked for, so report it
    // rather than fail. Resolving the root first also surfaces an unreadable
    // --packet as its own diagnostic instead of "no active run session".
    const rootDir = runSessionRootFor(args);
    const swept = (sessionHolder?.sweptStale || []).filter((entry) => entry.dir === rootDir);
    if (swept.length) {
      return { result: { ok: swept.every((entry) => Boolean(entry.record_path)), action: "run-end", stale_closeout: swept }, exitCode: 0 };
    }
    throw new Error(`No active run session to end. Start one with: ${cmd("run")} start.`);
  }
  const packet = optionalString(args.packet) || found.session.packet;
  if (!packet) {
    throw new Error("run end needs a build packet. Pass --packet <campaign-runtime.build.json>, or set it at `run start --packet <path>`.");
  }
  // `run end` is "assemble the Run Record for this session and stop logging to
  // it". A throw leaves the session active so the operator can fix the packet
  // and re-run `run end`. In text mode run-record prints its own summary.
  const summary = await closeRunSession(found, { packet, extraArgs: args, silent: args.json === true });
  return { result: summary, exitCode: 0 };
}

// The flags a closing command may hand on to run-record: the ones run-record
// reads. The rest of the invoking command's argv is that command's own —
// `qa run`'s --base-url, --browser or --test-order say nothing about the
// record — and run-record stamps the flag NAMES it was given into the Run
// Record's argv_shape, so carrying them over would file them as run-record's.
// `dry-run` is on the list for `run end --dry-run`, the one closer whose
// invoking command implements the flag; a closer invoked by a command that
// does not (the QA auto-end) drops it from extraArgs before calling — see
// DRY_RUN_COMMANDS and autoEndRunSessionAfterTerminalQa.
const RUN_RECORD_INHERITABLE_FLAGS = Object.freeze([
  "context", "report", "qa-verdict", "journal", "surfaces", "primary-surface", "surface-confidence",
  "agent-input-tokens", "agent-output-tokens", "agent-tool-output-tokens", "agent-total-tokens", "agent-elapsed-ms", "agent-model", "agent-usage-source",
  "no-remit", "no-write", "proxy-base", "dry-run", "json",
]);

// The run-record argv that closes `session`: its run_id and journal, the
// packet the closer resolved, and only the inheritable flags of `extraArgs`.
export function runSessionEndArgs(session, packet, extraArgs = {}) {
  const endArgs = { _: ["run-record"] };
  for (const flag of RUN_RECORD_INHERITABLE_FLAGS) {
    if (extraArgs[flag] !== undefined) endArgs[flag] = extraArgs[flag];
  }
  endArgs.packet = packet;
  endArgs["run-id"] = session.run_id;
  endArgs["lifecycle-journal"] = session.lifecycle_journal;
  return endArgs;
}

// The one path from an open run session to its Run Record: assemble it under
// the session's run_id and journal (aggregate lifecycle, consent-gated remit),
// then clear the session file. `run end`, the auto-end after a session-ending
// `qa run` and the stale-session sweep all close this way; they differ only in
// the flags they carry over, whether run-record prints, whether consent may
// prompt, and what a failure means — which is what the options say. The
// session is cleared only AFTER run-record succeeds: on a throw it stays on
// disk, and the error is rethrown unless `onError` takes it, in which case
// the closer returns null.
async function closeRunSession(found, { packet, extraArgs = {}, silent = false, promptForConsent = true, onError = null } = {}) {
  const endArgs = runSessionEndArgs(found.session, packet, extraArgs);
  try {
    // Internal closeout may swallow run-record errors. Its refusals belong to
    // that nested attempt, never to the invoking command's journal verdict.
    const summary = await runWithRefusalScope(() => runRecordCommand(endArgs, found, { silent, promptForConsent }));
    // Clearing the session is a write like any other, so a closer carrying
    // --dry-run leaves it open: the operator sees the record the close would
    // assemble and can still close for real afterwards.
    if (endArgs["dry-run"] !== true) clearRunSession(found.path);
    return summary;
  } catch (error) {
    // A nested run-record refusal is a failure of the invoking closer, which
    // has already read session state. Do not pass its tag to outer persistence.
    const failure = error?.code === REFUSED_INVOCATION ? new Error(error.message, { cause: error }) : error;
    if (!onError) throw failure;
    onError(failure);
    return null;
  }
}

// Stale-session closeout. A run session that idled past RUN_SESSION_TTL_MS is
// invisible to findRunSession (correct: a new work session must not inherit
// it) but was previously just abandoned: the file lingered, its lifecycle
// journal was never assembled, nothing was remitted. Sessions only ever
// auto-closed on a ready `qa run`, and most real runs stop earlier — so the
// runs most worth learning from (blocked, abandoned, agent-driven) left no
// record. Now, right before a command opens a NEW session at a root, the stale
// one there is assembled into its Run Record (remit under the usual consent)
// and removed. Roots: --target for start/prepare-build/build; the packet's
// target repo for `run start --packet` / `run end --packet`, cwd for the bare
// forms. `run status` never sweeps — it is read-only.
// Best-effort throughout: a closeout failure clears the file and says so on
// stderr; it never blocks the command that triggered it.
//
// The sweep is an effect of the command that triggers it, and it runs BEFORE
// dispatch — so it happens even when the argv that follows is refused. That is
// deliberate (the stale session at the target is closed out either way), but it
// makes the sweep the one place where `--no-write` could still write: it
// assembles a Run Record and removes the session file. `--no-write` writes
// nothing, the closeout included; see the guard below.
const STALE_SWEEP_TARGET_COMMANDS = new Set(["start", "prepare-build", "build"]);

async function closeOutStaleRunSessions(command, args) {
  // A command that opted out of sessions altogether must not sweep either.
  if (args["no-run-session"] === true) return [];
  // --no-write leaves the tree byte-identical. Inheriting the flag into the
  // closeout was not enough: it suppressed the Run Record but clearRunSession
  // still deleted the session file, so `--no-write` moved bytes. Skip the
  // sweep entirely instead — the stale session stays for the next run that
  // does write.
  if (args["no-write"] === true) return [];
  // Nor may a dry run sweep. The closeout writes a Run Record, deletes the
  // session file and (under consent) sends a remit — every effect --dry-run
  // promises not to have. The sweep runs BEFORE dispatch, so it was doing all
  // three for commands that implement the flag: `run end --dry-run --json`
  // over an aged session exited 0, wrote a record, POSTed once and removed the
  // session. --dry-run means "show me, do nothing"; the stale session simply
  // stays stale until a real invocation closes it. Gated on the same predicate
  // persistLifecycleIfRequested uses, so a stray --dry-run on a command that
  // does not implement it changes nothing here either.
  if (args["dry-run"] === true && commandImplementsDryRun(command, args)) return [];
  const roots = [];
  if (STALE_SWEEP_TARGET_COMMANDS.has(command) && optionalString(args.target)) roots.push(resolve(args.target));
  if (command === "run" && (args._[1] === "start" || args._[1] === "end")) {
    // cwd is deliberately not a second root when --packet is given: the sweep
    // closes out (assembles and, under consent, remits) the stale session at
    // the root the command is about to act on, and a stale session at an
    // unrelated cwd belongs to whatever next acts there (`run status` there
    // reports it). An unreadable packet roots nothing here; the command itself
    // raises that diagnostic right after, so it is not printed twice.
    try {
      roots.push(runSessionRootFor(args));
    } catch {
      // Reported by the command.
    }
  }
  // The closeout inherits the invoking command's remit controls: an explicit
  // --no-remit stays an opt-out, and a run pointed at a custom --proxy-base
  // never remits the stale record to the canonical endpoint. --no-write is
  // carried too, though the guard above means it never arrives true: if the
  // sweep ever becomes conditional rather than skipped, the closeout must
  // still see it.
  const inherited = {};
  for (const flag of ["no-remit", "no-write", "proxy-base"]) {
    if (args[flag] !== undefined) inherited[flag] = args[flag];
  }
  const results = [];
  for (const root of roots) {
    const result = await closeOutStaleRunSession(root, inherited);
    if (result) results.push(result);
  }
  return results;
}

async function closeOutStaleRunSession(rootDir, inherited = {}) {
  const stale = findStaleRunSession(rootDir);
  if (!stale) return null;
  const { session, path: sessionPath, dir } = stale;
  const packet = optionalString(session.packet);
  const idleSince = session.updated_at || session.started_at || null;
  const result = { run_id: session.run_id, dir, idle_since: idleSince, record_path: null, remit_state: null, error: null };
  if (packet && existsSync(packet)) {
    const summary = await closeRunSession(stale, {
      packet,
      extraArgs: { ...inherited, json: true },
      silent: true,
      promptForConsent: false,
      onError: (error) => {
        result.error = error instanceof Error ? error.message : String(error);
      },
    });
    result.record_path = summary?.record_path || null;
    result.remit_state = summary?.record?.remit_state || null;
  } else {
    result.error = packet ? `packet missing: ${packet}` : "no packet recorded on the session";
  }
  // A stale session is cleared whether or not its record could be assembled;
  // the closer only clears on success.
  clearRunSession(sessionPath);
  process.stderr.write(
    result.record_path
      ? `[campaigns-os] Stale run session ${session.run_id} (idle since ${idleSince}) closed out: Run Record ${result.record_path} (remit ${result.remit_state || "skipped"}).\n`
      : `[campaigns-os] Stale run session ${session.run_id} (idle since ${idleSince}) cleared without a Run Record: ${result.error}.\n`,
  );
  return result;
}

// The Campaigns API key VALUE for this packet, for the remit's X-Campaign-Key
// header (the receiver's tenant join). Same precedence as the doctor's
// presence check (resolveCampaignsApiKey): packet, then the packet-local
// CampaignSpec, then the declared env source. Campaign keys are
// public-by-design; the value is sent as a header, never written into the
// record. Best-effort: any read problem resolves to null (unscoped remit).
// A campaign key is an opaque token; the receiver hashes it. The shape gate
// below is about what is NOT a campaign key: whitespace, JSON, a URL, a
// multi-kilobyte blob. The env source is additionally restricted to variable
// names that name a campaign key, so a packet cannot point `api_key_source`
// at an arbitrary secret (`env:AWS_SECRET_ACCESS_KEY`) and have its value
// travel as a header.
const CAMPAIGN_KEY_SHAPE = /^[A-Za-z0-9._-]{8,256}$/;
// A variable name that names a campaign key: upper-case, starts with a letter,
// and contains CAMPAIGN anywhere — including at the start, so the documented
// default `CAMPAIGNS_API_KEY` qualifies (a leading `[A-Z]` that consumed the C
// used to refuse exactly that name and `CAMPAIGN_KEY`).
const CAMPAIGN_KEY_ENV_NAME = /^(?=[A-Z])[A-Z0-9_]*CAMPAIGN[A-Z0-9_]*$/;

function campaignKeyOrNull(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return CAMPAIGN_KEY_SHAPE.test(trimmed) ? trimmed : null;
}

// Resolve the key AND why a present value was refused. A value that is there
// but the wrong shape is a different operator problem from no value at all —
// a typo, a quoted key, a whole JSON blob pasted into the env var, the wrong
// secret exported under a campaign-key name — and the caller must be able to
// say which, naming the SOURCE (the env var, or the packet field) and never
// the value. `rejected` is null when nothing was refused.
export function resolveCampaignsApiKeySource(packet, packetPath, env = process.env, { spec: loadedSpec = undefined } = {}) {
  const packetRaw = firstNonEmptyString(packet?.campaign?.campaigns_api_key, packet?.campaign?.api_key);
  if (isNonEmptyString(packetRaw)) {
    const packetKey = campaignKeyOrNull(packetRaw);
    if (packetKey) return { key: packetKey, origin: packet?.campaign?.campaigns_api_key ? "packet.campaign.campaigns_api_key" : "packet.campaign.api_key", rejected: null };
    return { key: null, origin: null, rejected: { kind: "malformed", source: packet?.campaign?.campaigns_api_key ? "packet.campaign.campaigns_api_key" : "packet.campaign.api_key" } };
  }
  try {
    // A caller that already holds the packet-local CampaignSpec (doctor) hands
    // it in; otherwise it is read from the packet's local_path.
    const localSpecPath = packet?.spec?.local_path;
    if (loadedSpec !== undefined || (isNonEmptyString(localSpecPath) && isNonEmptyString(packetPath))) {
      const spec = loadedSpec !== undefined ? loadedSpec : readJsonIfExists(resolveFromFile(packetPath, localSpecPath));
      // Name the field the value actually came from: a refused source the
      // operator cannot find in their CampaignSpec is worse than no name.
      const specField = [
        ["campaign.campaigns_api_key", spec?.campaign?.campaigns_api_key],
        ["campaigns_api_key", spec?.campaigns_api_key],
        ["campaign.api_key", spec?.campaign?.api_key],
      ].find(([, value]) => isNonEmptyString(value));
      if (specField) {
        const specKey = campaignKeyOrNull(specField[1]);
        if (specKey) return { key: specKey, origin: `the packet-local CampaignSpec ${specField[0]}`, rejected: null };
        return { key: null, origin: null, rejected: { kind: "malformed", source: `the packet-local CampaignSpec ${specField[0]}` } };
      }
    }
  } catch {
    // unreadable spec — fall through to env
  }
  const source = optionalString(packet?.campaign?.api_key_source);
  if (source && source.startsWith("env:")) {
    const envName = source.slice("env:".length).trim();
    if (!CAMPAIGN_KEY_ENV_NAME.test(envName)) {
      return { key: null, origin: null, rejected: { kind: "unsupported_env_name", source: `api_key_source "env:${envName}"` } };
    }
    const raw = env?.[envName];
    if (isNonEmptyString(raw)) {
      const envKey = campaignKeyOrNull(raw);
      if (envKey) return { key: envKey, origin: `env:${envName}`, rejected: null };
      return { key: null, origin: null, rejected: { kind: "malformed", source: `env:${envName}` } };
    }
  }
  return { key: null, origin: null, rejected: null };
}

// Back-compat shape: the key value or null, for callers that only need the
// header value.
export function resolveCampaignsApiKeyValue(packet, packetPath, env = process.env) {
  return resolveCampaignsApiKeySource(packet, packetPath, env).key;
}

// One sentence an operator can act on, naming the refused source and never
// its value. `null` when nothing was refused.
export function describeCampaignKeyRejection(rejected) {
  if (!rejected) return null;
  if (rejected.kind === "unsupported_env_name") {
    return `${rejected.source} does not name a campaign key, so its value was not read (an api_key_source env var must match ${CAMPAIGN_KEY_ENV_NAME.source}). No credential was taken from it.`;
  }
  return `the Campaigns API key from ${rejected.source} is not a campaign-key shape (expected ${CAMPAIGN_KEY_SHAPE.source} — 8-256 chars of letters, digits, dot, dash, underscore, one line, no whitespace) and was refused before any request. Fix the value at that source; it is not printed here.`;
}

// Run Telemetry capture + remit. Thin dispatch: read this run's artifacts with
// the same readers `findings harvest` uses, hand the parsed structures to
// run-record.mjs to assemble the manifest, then (consent-gated, non-fatal)
// remit it. Capture is ALWAYS local; consent gates only the remit. See
// docs/workflow-findings-sidecar.md.
async function runRecordCommand(args, ambient = null, { silent = false, promptForConsent = true } = {}) {
  const packetPath = resolve(requireArg(args, "packet"));
  if (args["new-run"] === true && optionalString(args["run-id"])) {
    throw refused("run-record: --new-run and --run-id are exclusive; --run-id names the run to re-emit, --new-run mints a fresh one.");
  }
  const agentUsage = refusing(() => parseAgentUsageArgs(args));
  // --dry-run assembles the record and shows it, then writes and sends
  // nothing. It differs from --no-write, which skips the assembly's reads
  // as well; combining the two is allowed and still writes nothing.
  const dryRun = isDryRun(args);
  const parsedSurfaces = parseRunRecordSurfaces(args.surfaces);
  const packet = readJson(packetPath);
  const explicitTargetRepo = resolveFromFile(packetPath, packet.assembly?.target_repo);
  const { baseDir, targetRepo, contextPath, reportPath } = resolveCampaignWorkspace(packetPath, {
    packet,
    contextPath: args.context ? resolve(args.context) : undefined,
    reportPath: args.report ? resolve(args.report) : undefined,
    followContextPointer: false,
  });
  const contextExists = existsSync(contextPath);
  const reportExists = existsSync(reportPath);
  const context = contextExists ? readJson(contextPath) : null;
  const report = reportExists ? readJson(reportPath) : null;
  const doctor = doctorPacket(packetPath, {
    contextPath: contextExists ? contextPath : null,
    reportPath: reportExists ? reportPath : null,
  });

  const qaVerdictPath = args["qa-verdict"]
    ? resolve(args["qa-verdict"])
    : inferQaVerdictPath({ packet, report, reportPath: reportExists ? reportPath : null, targetRepo, baseDir });
  const qaVerdictExists = qaVerdictPath != null && existsSync(qaVerdictPath);
  const qaVerdict = qaVerdictExists ? readJson(qaVerdictPath) : null;
  if (qaVerdict && (packet.spec?.local_spec_id != null || qaVerdict.local_spec_id != null) && !qaVerdictIdentityMatch(qaVerdict, packet)) {
    throw new Error("run-record: QA verdict does not match this packet's local_spec_id; foreign evidence cannot be recorded as this local campaign.");
  }

  const journalPath = resolveJournalPath(args);
  const journal = readJournal(journalPath);

  // run_id: explicit flag > --new-run (mint) > active run session > the most
  // recent Run Record on disk for this packet's campaign > freshly minted.
  // Once `run end` has cleared the session nothing ambient names the run any
  // more, and minting here would file a SECOND record for a run that already
  // has one — every re-run after close (the closeout action `next` prints, a
  // re-emit after a sidecar fix) forked the run's identity that way. A record
  // the receiver already holds is final (left as written, below), so
  // re-resolving to its id is safe; minting is what happens only when no
  // record for this campaign exists, or when --new-run asks for it. The
  // source travels on the stdout envelope only: the record's schema is
  // hashed surface and does not carry it.
  const listOnly = args.list === true;
  // The directory is scanned only when something reads it: --list, or an id
  // that nothing else names. An explicit --run-id, --new-run or an open
  // session decides without it, and a target with a long history pays no I/O
  // for a decision already made.
  const needsDiskScan = listOnly || (!optionalString(args["run-id"]) && args["new-run"] !== true && !isNonEmptyString(ambient?.session?.run_id));
  const targetRecords = needsDiskScan ? readRunRecordsForTarget(baseDir) : [];
  const latestRecordEntry = needsDiskScan ? latestMatchingRunRecord(targetRecords, packet) : null;
  let runId;
  let runIdSource;
  if (optionalString(args["run-id"])) {
    runId = optionalString(args["run-id"]);
    // `run end` and the QA auto-end name the session's id explicitly while the
    // session is still ambient; that is the session's id, not an operator's.
    runIdSource = runId === ambient?.session?.run_id ? "session" : "explicit";
  } else if (args["new-run"] === true) {
    runId = mintRunId();
    runIdSource = "minted";
  } else if (isNonEmptyString(ambient?.session?.run_id)) {
    runId = ambient.session.run_id;
    runIdSource = "session";
  } else if (isNonEmptyString(latestRecordEntry?.record?.run_id)) {
    runId = latestRecordEntry.record.run_id;
    runIdSource = "latest_record";
  } else {
    runId = mintRunId();
    runIdSource = "minted";
  }
  const latestRecordNotice = runIdSource === "latest_record"
    ? `Run ID ${runId} is the most recent Run Record for this campaign; re-emitting it in place. Pass --new-run to start a new run under a fresh id, or --list to see every record for this packet.`
    : null;

  // --list is inspection only: the run ids this packet's campaign has on disk,
  // newest first, with when each was created and where its remit stands. It
  // is --no-write with the assembly skipped — nothing is read into a record,
  // nothing is written, nothing is sent. The same identity match as the
  // resolution above; a matching record without a run_id is listed as
  // `(unnamed)` so the operator sees why it was not the one re-emitted.
  if (listOnly) {
    const records = targetRecords
      .filter((entry) => isObject(entry?.record) && identityMatches(entry.record, packet))
      .map((entry) => ({
        run_id: optionalString(entry.record.run_id),
        created_at: optionalString(entry.record.created_at),
        remit_state: optionalString(entry.record.remit_state),
        remit_result: optionalString(entry.record.remit_result),
        remit_endpoint: optionalString(entry.record.remit_endpoint),
        record_path: entry.path,
      }));
    const summary = {
      ok: true,
      action: "run-record",
      list: true,
      written: false,
      run_id: runId,
      run_id_source: runIdSource,
      records,
      remit: { result: null, http_status: null, base_kind: null, sent: false, preserved: false },
      ...(dryRun ? { dry_run: true, would_write: null, would_remit: null } : {}),
    };
    if (silent) return summary;
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    console.log(`Run Records for this packet's campaign: ${records.length}`);
    for (const entry of records) {
      console.log(`  ${entry.run_id || "(unnamed)"}  created ${entry.created_at || "(unknown)"}  remit ${entry.remit_state || "(absent)"}${entry.remit_result ? ` (${entry.remit_result})` : ""}  ${entry.record_path}`);
    }
    console.log(`Next run-record without --run-id would use: ${runId} (${runIdSource}).`);
    console.log("List only (--list). No record written, no remit.");
    return summary;
  }
  const proxyBase = optionalString(args["proxy-base"]) || DEFAULT_PROXY_BASE;

  // Embed the aggregated command-lifecycle signal for this run from the
  // lifecycle journal (Tier 1). Strictly BEST-EFFORT: an unreadable/directory/
  // corrupt journal, or a malformed aggregate, must never break Run Record
  // generation — on any problem we embed nothing. Exclude the session/telemetry
  // commands' OWN entries (run-record, run) so they never appear as build
  // stages, and validate the candidate so it can't produce a schema-invalid
  // record at write time. Journal resolves flag > env > session > baseDir.
  let lifecycle = null;
  try {
    const lifecycleJournalPath = resolveLifecycleJournal(args, { ambient, fallbackDir: baseDir });
    const candidate = aggregateLifecycleForRun(readLifecycleJournal(lifecycleJournalPath), runId, { excludeCommands: ["run-record", "run"] });
    if (candidate && validateRunRecordLifecycle(candidate).length === 0) lifecycle = candidate;
  } catch {
    lifecycle = null;
  }

  const artifacts = [runRecordArtifactRef("build_packet", packetPath, PACKET_SCHEMA, baseDir)];
  const buildBriefPath = resolveFromFile(packetPath, packet.build_brief?.normalized_path);
  const pageKitBuildSummary = explicitTargetRepo ? readPageKitBuildSummary(explicitTargetRepo) : null;
  if (buildBriefPath && existsSync(buildBriefPath)) artifacts.push(runRecordArtifactRef("build_brief", buildBriefPath, BUILD_BRIEF_SCHEMA, baseDir));
  if (contextExists) artifacts.push(runRecordArtifactRef("build_context", contextPath, CONTEXT_SCHEMA, baseDir));
  if (reportExists) artifacts.push(runRecordArtifactRef("assembly_report", reportPath, REPORT_SCHEMA, baseDir));
  if (pageKitBuildSummary?.summary || pageKitBuildSummary?.error) {
    artifacts.push(runRecordArtifactRef(
      "page_kit_build_summary",
      pageKitBuildSummary.path,
      optionalString(pageKitBuildSummary.summary?.schema_version) || "next-campaign-page-kit-build-summary/v0",
      baseDir,
    ));
  }
  const qaAttemptPaths = (Array.isArray(ambient?.session?.qa_attempts) ? ambient.session.qa_attempts : [])
    .map((attempt) => typeof attempt === "string" ? attempt : attempt?.path)
    .filter(isNonEmptyString)
    .map((path) => resolve(path));
  if (qaVerdictExists) qaAttemptPaths.push(qaVerdictPath);
  const seenQaAttempts = new Set();
  for (const attemptPath of qaAttemptPaths) {
    const attempt = canonicalPath(attemptPath);
    if (seenQaAttempts.has(attempt) || !existsSync(attempt)) continue;
    seenQaAttempts.add(attempt);
    let schemaVersion = null;
    try {
      schemaVersion = optionalString(readJson(attempt)?.schema_version);
    } catch {
      // Artifact capture is best-effort; a malformed attempt remains hashable.
    }
    artifacts.push(runRecordArtifactRef("qa_verdict", attempt, schemaVersion, baseDir));
  }
  if (existsSync(journalPath)) artifacts.push(runRecordArtifactRef("findings_journal", journalPath, WORKFLOW_FINDING_SCHEMA, baseDir));

  // What a real run of this command line would write, and what this one does:
  // a dry run assembles and validates the record a real run would write
  // (assertRunRecordValid), and stops at the write itself (writeRunRecord).
  const wouldWrite = args["no-write"] !== true;
  const write = wouldWrite && !dryRun;
  // The verdict publish outcome this record carries: the session's attempt
  // for the verdict being recorded (the auto-end and `run end` both close
  // through here with the session still ambient), else the newest attempt
  // that has one. Resolved before the prior record is read so an ok already
  // on disk can win below.
  const sessionPublish = qaVerdictPublishFromSession(ambient?.session, qaVerdictPath);
  // The record already on disk under this run_id, when a writing run would
  // replace it. run-record is keyed on run_id, and a re-run — an explicit
  // --run-id, a `run end` on a session re-opened under an id that already
  // closed, the recovery action `next` prints — must never turn a remit that
  // landed into one that did not. The receiver holds one record per id and
  // refuses a second send, so a record it already has is final: it is neither
  // re-sent nor rewritten here. A prior send that did not land (failed,
  // pending) is retried when this run may send, and kept as it stands when it
  // may not. A pure --no-write run reads nothing: it writes and sends nothing.
  // A --dry-run does read it, because what a real run would do here is the
  // very thing the dry run is being asked to report.
  const prior = write || dryRun ? readPriorRunRecord(runId, baseDir) : null;
  const priorRemit = priorRemitOutcome(prior?.record);
  const storedRemotely = priorRemit?.state === "ok";
  // A pure local-inspection run (--no-write), an explicit --no-remit, or a
  // record the receiver already holds never phones home, regardless of consent.
  const remitDisabled = args["no-remit"] === true || !write || storedRemotely;

  // Resolve consent through the shared resolver every remitting command calls.
  // When interactive, not in --json/agent mode, remit isn't disabled, and no
  // explicit choice exists yet, ask once up front and persist it.
  let consent = resolveConsent({ proxyBase });
  if (promptForConsent && !consent.resolved && !remitDisabled && !args.json && process.stdin.isTTY) {
    consent = await promptAndPersistConsent({ proxyBase });
  }
  // Default-on consent is announced, never silent: the operator learns the
  // remit is happening, the exact endpoint receiving it, and how to turn it
  // off. Once per process so agent loops don't train operators to ignore it.
  if (consent.default_on === true && !remitDisabled) {
    announceDefaultOnTelemetry(consent.scope || proxyBase);
  }

  // Under --dry-run the remit is disabled by construction (write is false), so
  // `remitDisabled` cannot say whether a real run would have sent. This does:
  // the same three stoppers minus the dry run itself, against the consent this
  // machine actually resolved.
  const wouldRemit = dryRun
    && args["no-remit"] !== true
    && args["no-write"] !== true
    && !storedRemotely
    && consent.state === "on";

  // A publish the record already says landed is never downgraded by a
  // reassembly: the prior ok block wins over a session attempt that did not
  // land, mirroring the remit carry-forward below.
  const priorPublish = isObject(prior?.record?.qa_verdict_publish) ? prior.record.qa_verdict_publish : null;
  const qaVerdictPublish = priorPublish?.state === "ok" && sessionPublish?.state !== "ok"
    ? priorPublish
    : (sessionPublish || priorPublish);

  const record = assembleRunRecord({
    runId,
    packageVersion: packageVersion(),
    ...toolkitProvenance({ silent }),
    qaVerdictPublish,
    command: "run-record",
    argvShape: argvShape(args),
    consent: { state: consent.state, source: consent.source },
    identity: {
      map_id: optionalString(packet.spec?.map_id),
      ...localSpecIdentityFields(packet.spec),
      campaign_slug: optionalString(packet.campaign?.public_route_slug),
      template_family: optionalString(packet.assembly?.template_family),
      entry_point_shape: "packet",
    },
    artifacts,
    packet,
    doctor,
    report,
    context,
    qaVerdict,
    journal,
    surfaces: parsedSurfaces,
    primarySurface: optionalString(args["primary-surface"]),
    surfaceConfidence: optionalString(args["surface-confidence"]),
    lifecycle,
    agentUsage,
  });

  const shouldAttemptRemit = !remitDisabled && consent.state === "on";
  const remitBaseKind = describeRemitBaseKind(proxyBase);

  // The receiver already holds this run_id: the local record is the durable
  // one and stays exactly as written. Nothing is sent (the receiver would
  // refuse it) and nothing is rewritten (a reassembly could only be thinner
  // than what the session wrote, and would then disagree with the stored copy).
  // `not_contacted` says exactly that — the receiver was not asked — where
  // `already_stored` is reserved for a 409 it actually answered.
  if (storedRemotely) {
    const summary = {
      ok: true,
      action: "run-record",
      written: false,
      record_path: prior.path,
      record: prior.record,
      run_id_source: runIdSource,
      remit: { result: REMIT_RESULTS.not_contacted, http_status: null, base_kind: null, sent: false, preserved: true },
      // A record the receiver already holds is final: a real run of this same
      // command line would write nothing and send nothing either.
      ...(dryRun ? { dry_run: true, would_write: null, would_remit: null } : {}),
    };
    if (silent) return summary;
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    if (latestRecordNotice) console.log(latestRecordNotice);
    console.log(`Run Record already closed and remitted for run ${prior.record.run_id}; left as written.`);
    console.log(`Run ID: ${prior.record.run_id} (${runIdSource})`);
    console.log(`Remit: ok (already stored at the receiver for this run id; not re-sent) -> ${prior.record.remit_endpoint || DEFAULT_RUNS_ENDPOINT}`);
    console.log(`Kept: ${prior.path}`);
    return summary;
  }

  // A prior send that did not land, on a run that will not send now: the
  // outcome on disk is the truth about that send and is carried forward, so
  // `--no-remit` (or consent off) over a failed remit does not file it as
  // skipped and hide it from closeout.
  const carriedForward = !shouldAttemptRemit && priorRemit && priorRemit.state !== "skipped" ? priorRemit : null;
  if (shouldAttemptRemit) {
    record.remit_state = "pending";
    record.remit_attempted = false;
    record.remit_ok = null;
    record.remit_error = null;
    record.remit_endpoint = null;
    record.remit_result = null;
    record.remit_base_kind = null;
  } else if (carriedForward) {
    record.remit_state = carriedForward.state;
    record.remit_attempted = carriedForward.attempted;
    record.remit_ok = carriedForward.ok;
    record.remit_error = carriedForward.error;
    record.remit_endpoint = carriedForward.endpoint;
    record.remit_result = carriedForward.result;
    record.remit_base_kind = carriedForward.base_kind;
  }

  // The record is validated whenever a real run of this command line would
  // write one — under --dry-run too — and always BEFORE the remit below, so an
  // invalid record refuses ahead of any send on both paths. The write itself is
  // separate and happens after the remit; validating here does not write.
  if (wouldWrite) assertRunRecordValid(record);

  // Remit is consent-gated, non-fatal, bounded, and keyed on run_id — the
  // receiver holds one record per id and refuses a second POST for one it
  // already has, so an id must not be spent on an interim record before the
  // record that closes the run. Its outcome is stamped into the local record so
  // a dropped send is visible, not silent.
  // The key is only resolved when a send will actually be attempted: under
  // consent-off or --no-remit nothing goes out, so nothing is read and nothing
  // is said about a credential.
  // A dry run resolves it too, and only when a real run would have: the
  // destination gate below names the credential that would travel, and the
  // preview must name the one the real send would.
  const keySource = shouldAttemptRemit || wouldRemit ? resolveCampaignsApiKeySource(packet, packetPath, process.env) : { key: null, rejected: null };
  const campaignKey = keySource.key;
  // A refused key is not a missing key. Say so on stderr, naming the source
  // and not the value, so the operator fixes the credential instead of reading
  // the unscoped remit below as "no key was configured". The remit rail stays
  // non-fatal by contract, so this warns and attempts the send without a
  // tenant scope rather than failing the run. It claims nothing about the
  // send's outcome, which is only known below; the credential itself never
  // leaves the machine.
  const keyRejection = describeCampaignKeyRejection(keySource.rejected);
  if (keyRejection) process.stderr.write(`[campaigns-os] run-record: ${keyRejection} ${dryRun ? "A real run's remit would be attempted without a tenant scope." : "This run's remit is attempted without a tenant scope."}\n`);

  // The transport's own preconditions, run for a dry run as well: `remit`
  // demands a fetch to send with, and refuses a base that is not https (nor a
  // loopback host), BEFORE it opens a socket — so a send the real run could
  // never have made must not be previewed as one it would post. Same
  // functions, in the transport's order, with the same label and the same
  // credential wording the remit below hands them. The remit rail is non-fatal
  // by contract — the real run classifies either refusal as a failed remit and
  // still exits 0 — so the dry run reports it on the envelope and exits 0 too.
  let wouldRemitEndpoint = null;
  let wouldRemitRefusal = null;
  if (wouldRemit) {
    try {
      assertFetchAvailable(globalThis.fetch);
      const { base } = assertSecureProxyBase(proxyBase, {
        label: "Run Telemetry remit",
        credential: typeof campaignKey === "string" && campaignKey.trim() ? "the campaign key" : null,
      });
      wouldRemitEndpoint = `${base}${DEFAULT_RUNS_ENDPOINT}`;
    } catch (error) {
      wouldRemitRefusal = String(error?.message ?? error);
    }
  }
  const remitStatus = shouldAttemptRemit
    ? await remitRunRecord(record, { proxyBase, consent, campaignKey })
    : { attempted: false, ok: null, error: null, endpoint: null, result: null, http_status: null };
  if (!carriedForward) {
    record.remit_attempted = remitStatus.attempted;
    record.remit_ok = remitStatus.ok;
    record.remit_error = remitStatus.error;
    record.remit_endpoint = remitStatus.endpoint;
    // Classified by what the receiver answered, not by whether the transport
    // threw: `already_stored` (409) and `ok_unparsed_ack` (a 2xx whose body was
    // not JSON) are ok states; only a refusal or a transport failure is failed.
    record.remit_state = remitStatus.attempted ? (remitStatus.ok ? "ok" : "failed") : "skipped";
    // The classification and the resolved base ride on the record itself, so
    // a stored or re-read record says what its receiver answered and where.
    record.remit_result = remitStatus.attempted ? remitStatus.result : null;
    record.remit_base_kind = remitStatus.attempted ? remitBaseKind : null;
  }

  // The record's one and only write, after the remit so the file that lands
  // carries this run's remit_* outcome rather than the placeholders it was
  // assembled with. Validated above, ahead of the send; nothing is written
  // under --dry-run or --no-write.
  const recordPath = write ? writeRunRecord(record, { baseDir }) : null;

  const summary = {
    ok: true,
    action: "run-record",
    written: write,
    record_path: recordPath,
    record,
    // How run_id was chosen: explicit (--run-id), session (the active run
    // session), latest_record (the newest Run Record on disk for this
    // campaign, re-emitted in place) or minted (a fresh id: --new-run, or no
    // record exists yet). Envelope only — never on the record.
    run_id_source: runIdSource,
    // The send's classification and where it went, which the record's schema
    // does not carry: `result` is one of stored, already_stored,
    // ok_unparsed_ack, refused, transport_error (this run's send),
    // not_contacted (a prior ok on disk; the early return above), or null
    // when nothing was sent and nothing is known; `base_kind` names the
    // resolved remit base as canonical, loopback or proxy — never the host.
    remit: {
      result: remitStatus.result,
      http_status: remitStatus.http_status,
      base_kind: shouldAttemptRemit ? remitBaseKind : null,
      sent: remitStatus.attempted,
      preserved: Boolean(carriedForward),
    },
    // What a real run of this same command line — the one without --dry-run —
    // would have done: the record file it would write, and the endpoint it
    // would POST to (null when --no-remit, --no-write or consent would have
    // stopped the send anyway, and null with `would_remit_refused` set when the
    // transport's destination gate refuses the base before any socket opens).
    // Envelope only; never on the record.
    ...(dryRun ? { dry_run: true, would_write: resolveRunRecordPath(runId, baseDir), would_remit: wouldRemitEndpoint, would_remit_refused: wouldRemitRefusal } : {}),
  };
  if (silent) return summary;
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  if (latestRecordNotice) console.log(latestRecordNotice);
  console.log(`Run Record assembled.`);
  console.log(`Run ID: ${record.run_id} (${runIdSource})`);
  console.log(`Consent: ${record.consent_state} (${record.consent_source})${consent.scope_mismatch ? ` — file consent is scoped to ${consent.consent_scope || "(unscoped)"}, not ${consent.requested_scope}; consent to this endpoint with: ${scopedConsentCommand(consent.requested_scope)}` : ""}${consent.scope_bypassed ? ` — ${TELEMETRY_ENV_VAR} bypasses scope checking for ${consent.scope}` : ""}`);
  console.log(`Artifacts referenced: ${record.artifacts.length}`);
  console.log(`Findings in snapshot: ${record.observations.finding_ids.length}`);
  if (carriedForward) {
    console.log(`Remit: not attempted this run; the prior outcome for this run id is kept (${carriedForward.state}${carriedForward.error ? `: ${carriedForward.error}` : ""}).`);
  } else if (record.remit_attempted) {
    console.log(`Remit: ${remitResultText(record, remitStatus)} -> ${record.remit_endpoint}${campaignKey ? " (tenant-scoped: X-Campaign-Key sent)" : ` (unscoped: ${keyRejection ? "the declared Campaigns API key was refused on shape — see the warning above" : "no Campaigns API key found in the packet, its local CampaignSpec, or the declared env source"} — the receiver lists this record only via the admin listing or by run_id)`} [base: ${remitBaseKind}]`);
  } else {
    console.log(`Remit: skipped (consent ${record.consent_state}${remitDisabled ? ", disabled for this run" : ""}).`);
  }
  if (write) console.log(`Wrote: ${recordPath}`);
  else if (dryRun) {
    console.log("Dry run (--dry-run). Nothing written, nothing sent.");
    console.log(`Would write: ${summary.would_write}`);
    console.log(`Would remit: ${summary.would_remit || (summary.would_remit_refused ? `nothing — the destination is refused before any request: ${summary.would_remit_refused}` : "nothing (remit is off for this run)")}`);
  } else console.log("Dry run only (--no-write). No record written, no remit.");
  return summary;
}

/**
 * The Run Record's refusal, lifted out of the write. `writeRunRecord` validates
 * the record before it writes and refuses an invalid one; that refusal belongs
 * to the command rather than to the write, because it has to fire on the dry
 * path (which never writes) and ahead of the remit on the real one (which
 * writes only afterwards). Both modes therefore refuse the same record with the
 * same message and the same exit code, before any send: the check fires here,
 * never on the identical one inside run-record.mjs (which stays as the writer's
 * own last guard). The validator is that writer's — imported, not re-stated —
 * so the two cannot disagree about what a valid record is. Writes nothing.
 */
function assertRunRecordValid(record) {
  const validation = validateRunRecord(record);
  if (!validation.ok) {
    const detail = validation.errors.map((error) => `[${error.code}] ${error.message}`).join("; ");
    throw new Error(`Run Record failed validation; refusing to write: ${detail}`);
  }
}

// The record already written under `runId` for this target, or null when there
// is none, it cannot be parsed, or it is not a valid Run Record. Only a record
// `writeRunRecord` could have written is trusted as a prior — the same
// validator gates both — so a file that merely says `remit_state: "ok"` is
// replaced like a corrupt one, never preserved or handed back as the record.
function readPriorRunRecord(runId, baseDir) {
  let path;
  try {
    path = resolveRunRecordPath(runId, baseDir);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const record = readJson(path);
    return validateRunRecord(record).ok ? { path, record } : null;
  } catch {
    return null;
  }
}

// The publish block the session's QA attempts carry for the verdict this
// record names (canonical path match), else the newest attempt carrying one.
// Only a block that validates is returned: the session file is internal and
// a malformed block must not make the Run Record unwritable.
function qaVerdictPublishFromSession(session, qaVerdictPath = null) {
  const attempts = Array.isArray(session?.qa_attempts) ? session.qa_attempts : [];
  const target = isNonEmptyString(qaVerdictPath) ? canonicalPath(resolve(qaVerdictPath)) : null;
  const candidates = attempts.filter((attempt) => isObject(attempt?.publish));
  const matching = target
    ? candidates.find((attempt) => isNonEmptyString(attempt.path) && canonicalPath(resolve(attempt.path)) === target)
    : null;
  const chosen = matching || candidates[candidates.length - 1] || null;
  if (!chosen) return null;
  return validateQaVerdictPublish(chosen.publish).length === 0 ? chosen.publish : null;
}

// The remit outcome a prior record carries, in the shape the stamping code
// uses; null when the record has no recognisable remit state.
function priorRemitOutcome(record) {
  const state = optionalString(record?.remit_state);
  if (!state || !["skipped", "pending", "ok", "failed"].includes(state)) return null;
  return {
    state,
    attempted: record.remit_attempted === true,
    ok: typeof record.remit_ok === "boolean" ? record.remit_ok : null,
    error: optionalString(record.remit_error) || null,
    endpoint: optionalString(record.remit_endpoint) || null,
    result: optionalString(record.remit_result) || null,
    base_kind: optionalString(record.remit_base_kind) || null,
  };
}

// The one-line reading of an attempted remit for the text output: ok states
// that were not a plain stored 2xx say what they were.
function remitResultText(record, remitStatus) {
  if (!record.remit_ok) return `failed (${record.remit_error})`;
  if (remitStatus.result === REMIT_RESULTS.already_stored) return `ok (already stored at the receiver for this run id; HTTP ${remitStatus.http_status})`;
  if (remitStatus.result === REMIT_RESULTS.ok_unparsed_ack) return `ok (${record.remit_error})`;
  return "ok";
}

// Build one artifact reference {kind, path, schema_version, sha256}. The path
// is relativized to the run root so no contributor filesystem layout leaks;
// sha256 is best-effort (null when the file can't be hashed).
function runRecordArtifactRef(kind, filePath, schemaVersion, baseDir) {
  let sha256 = null;
  try {
    sha256 = sha256File(filePath);
  } catch {
    sha256 = null;
  }
  return {
    kind,
    path: artifactRefPath(kind, filePath, baseDir),
    schema_version: schemaVersion || null,
    sha256,
  };
}

function artifactRefPath(kind, filePath, baseDir) {
  const base = canonicalPath(baseDir);
  const fullPath = canonicalPath(filePath);

  const rel = relative(base, fullPath);
  if (!rel) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return `external:${kind}`;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// The verdict a Run Record should carry when none was named: every candidate
// the report records or the qa-output directories hold, minus any the QA
// verdict receiver stamped `trusted: false` (an anonymous submission is
// shape-valid but unattributed, and automatic inference must never pick one
// up as this run's evidence; locally written verdicts never carry the field,
// and an explicit --qa-verdict path bypasses inference and is honored as
// given — see docs/qa-and-test-orders.md), ranked by identity score and
// time. Best-effort: malformed side artifacts never make run-record fail.
function inferQaVerdictPath({ packet, report, reportPath = null, targetRepo = null, baseDir = null } = {}) {
  const eligible = discoverQaVerdicts({
    packet,
    report,
    reportPath: reportPath || (targetRepo ? campaignSidecarPaths(targetRepo).reportPath : null),
    roots: [targetRepo, baseDir],
  }).filter((candidate) => candidate.verdict && candidate.trusted
    && ((packet?.spec?.local_spec_id == null && candidate.verdict.local_spec_id == null) || candidate.identityMatch));
  eligible.sort((a, b) => {
    const scoreDelta = qaVerdictCandidateScore(b, packet) - qaVerdictCandidateScore(a, packet);
    if (scoreDelta !== 0) return scoreDelta;
    return qaVerdictCandidateTime(b) - qaVerdictCandidateTime(a);
  });
  return eligible[0]?.path || null;
}

const ARGV_SHAPE_PRIVATE_FLAGS = new Set(["auth-cookie", "no-remit", "no-write", "proxy-base"]);

// argv SHAPE = selected flag NAMES present, never their values (minimization).
// Sorted + de-duplicated for deterministic records; opt-out and endpoint flags
// stay private. A `--flag=value` token parses as a single key, so split on "="
// and keep only the name — otherwise a value (e.g. --auth-cookie=SECRET) would
// leak into a persisted, potentially-remitted shape, breaking the guarantee.
function argvShape(args) {
  const names = new Set();
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    const name = key.split("=")[0];
    if (ARGV_SHAPE_PRIVATE_FLAGS.has(name)) continue;
    names.add(`--${name}`);
  }
  return [...names].sort();
}

function parseCommaList(value) {
  if (!isNonEmptyString(value)) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseRunRecordSurfaces(value) {
  const surfaces = parseCommaList(value);
  const unknown = surfaces.filter((surface) => !RUN_RECORD_SURFACES.includes(surface));
  if (unknown.length) {
    throw refused(`Unknown --surfaces value(s): ${unknown.join(", ")}. Use one of: ${RUN_RECORD_SURFACES.join(", ")}.`);
  }
  return surfaces;
}

function parseAgentUsageArgs(args) {
  const fields = {
    "agent-input-tokens": "input_tokens",
    "agent-output-tokens": "output_tokens",
    "agent-tool-output-tokens": "tool_output_tokens",
    "agent-total-tokens": "total_tokens",
    "agent-elapsed-ms": "elapsed_ms",
  };
  const usage = {};
  for (const [flag, field] of Object.entries(fields)) {
    if (!(flag in args)) continue;
    usage[field] = parseNonNegativeIntegerFlag(args[flag], flag);
  }
  if (isNonEmptyString(args["agent-model"])) usage.model = args["agent-model"].trim();
  if (isNonEmptyString(args["agent-usage-source"])) usage.source = args["agent-usage-source"].trim();
  return Object.keys(usage).length ? usage : null;
}

function parseNonNegativeIntegerFlag(value, flag) {
  if (value === true || value === false || value == null || String(value).trim() === "") {
    throw new Error(`--${flag} requires a non-negative integer value.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function packageVersion() {
  return readJson(join(ROOT, "package.json")).version;
}

// Toolkit provenance for the Run Record. package_version has been
// 0.1.0-alpha.0 since the scaffold and the package is a git dependency, so the
// version a consumer can actually segment on is the supported-surface version,
// plus the commit the toolkit was installed from: package.json `gitHead` (npm
// stamps it on git-dependency installs), else the checkout's HEAD when this is
// a working clone. Best-effort and nullable — provenance never blocks capture.
function toolkitProvenance({ silent = false } = {}) {
  let surfaceVersion = null;
  let toolkitCommit = null;
  try {
    const version = readJson(join(ROOT, "contracts", "supported-surface.json")).surface_version;
    if (typeof version === "string" && RUN_RECORD_SURFACE_VERSION_PATTERN.test(version)) surfaceVersion = version;
  } catch (error) {
    // The manifest ships in every install; failing to read it is a broken
    // install, not a "no git" situation — say so once rather than emit
    // surface_version: null forever with no explanation.
    // Threaded from runRecordCommand's `silent`: an internal caller (run end,
    // the stale-session sweep) that asked for silence stays silent.
    if (!silent) process.stderr.write(`[campaigns-os] toolkit provenance: contracts/supported-surface.json unreadable (${error?.message || error}); surface_version will be null.\n`);
  }
  try {
    const gitHead = readJson(join(ROOT, "package.json")).gitHead;
    if (typeof gitHead === "string" && RUN_RECORD_COMMIT_PATTERN.test(gitHead)) toolkitCommit = gitHead;
  } catch {
    // package.json unreadable — the manifest read above already warned
  }
  if (!toolkitCommit) {
    // No pre-check on a .git entry: in a worktree or submodule .git is a
    // file, not a directory. Ask git and accept "not a repository" quietly —
    // a tarball install legitimately has no commit.
    try {
      const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (RUN_RECORD_COMMIT_PATTERN.test(head)) toolkitCommit = head;
    } catch {
      // not a git checkout — leave null
    }
  }
  return { surfaceVersion, toolkitCommit };
}

// Machine-level Run Telemetry consent. `status` reports the resolved state and
// its source; `on`/`off` persist an explicit choice to the user-level config.
// Consent gates REMIT only — local capture is unaffected.
//
// A file grant is scoped to ONE endpoint. `telemetry on` grants the canonical
// NEXT endpoint; `telemetry on --proxy-base <url>` grants that receiver
// instead (loopback or staging), which is the non-interactive way to consent
// to a non-canonical base — the alternative, CAMPAIGNS_OS_TELEMETRY=on, skips
// scope checking altogether. `status` checks the stored grant against the
// canonical endpoint, or against --proxy-base when given, so it reports what
// a remit to that endpoint would do. `off` takes no --proxy-base: an OFF
// choice is machine-wide and the record it writes carries no scope.
// `assertSecureProxyBase` is SHARED with the remit rail, where it runs in the
// middle of a handler: `remit()` reaches it after the Run Record has been built
// and written, and `spec derive --write-map` after the derive produced one. A
// throw from those positions is a handler failure — the most valuable lifecycle
// entry there is — so the refusal tag cannot live inside the validator.
//
// The call sites below are the up-front ones: the base comes straight off argv
// and is checked before any configuration read or write, before a credential is
// attached, and before a request. The tag therefore goes HERE, where the
// position is known — `refusing()` is the shared form of that contract. The
// message and the exit code stay the validator's own; only the verdict the
// lifecycle journal reads is added.
const refuseInsecureProxyBase = (proxyBase, options) =>
  refusing(() => assertSecureProxyBase(proxyBase, options));

async function telemetryCommand(args) {
  const sub = args._[1] || "status";
  const configPath = resolveConfigPath();
  const requestedBase = optionalString(args["proxy-base"]);
  // A flag that was written but carries no URL (`--proxy-base --json`, or an
  // empty variable) is not "no flag": treating it as absent would grant or
  // check the canonical endpoint under a request that named something else.
  if (Object.hasOwn(args, "proxy-base") && !requestedBase) {
    throw refused(`telemetry ${sub}: --proxy-base needs a URL (https, or a loopback host); nothing was written.`);
  }
  // Same transport rule as the remit rail: https, or a loopback host. A grant
  // for a base a remit would refuse to send to is not a grant, and a status
  // check against one would report on a remit that can never happen. Nothing
  // is sent here, so the in-clear warning is left to the remit.
  const secureBase = () => refuseInsecureProxyBase(requestedBase, { label: `telemetry ${sub}`, warn: () => {} }).base;

  if (sub === "on" || sub === "off") {
    if (sub === "off" && requestedBase) {
      throw refused(`telemetry off: --proxy-base is not accepted; turning telemetry off applies to every endpoint. To grant one endpoint instead, run: ${scopedConsentCommand(requestedBase)}`);
    }
    const proxyBase = requestedBase ? secureBase() : DEFAULT_PROXY_BASE;
    const { configPath: written, config } = writeConsentConfig(sub, { configPath, proxyBase, source: "telemetry-command" });
    const scope = config.telemetry.scope;
    const canonical = scope === CANONICAL_REMIT_SCOPE;
    const resolved = resolveConsent({ configPath, proxyBase: scope || CANONICAL_REMIT_SCOPE });
    if (args.json) {
      console.log(JSON.stringify({
        ok: true,
        action: `telemetry-${sub}`,
        config_path: written,
        scope,
        scope_canonical: canonical,
        state: resolved.state,
        source: resolved.source,
      }, null, 2));
      return;
    }
    console.log(`Telemetry ${sub.toUpperCase()}.`);
    console.log(`Config: ${written}`);
    if (scope) console.log(`Scope: ${scope}${canonical ? " (canonical NEXT endpoint)" : ""}`);
    else console.log("Scope: every endpoint (an OFF choice is not scoped)");
    console.log(`Resolved: ${resolved.state} (source: ${resolved.source})`);
    if (sub === "on" && !canonical) {
      console.log(`This grant covers remits that pass --proxy-base ${scope} only; a remit to the canonical NEXT endpoint (${CANONICAL_REMIT_SCOPE}) is OFF until you run: ${cmd("telemetry")} on`);
    }
    if (resolved.source === "env") {
      console.log(`Note: ${TELEMETRY_ENV_VAR} is set and overrides this file until unset.`);
    }
    return;
  }

  if (sub === "status") {
    const checkedEndpoint = requestedBase ? (normalizeConsentScope(secureBase()) || requestedBase) : CANONICAL_REMIT_SCOPE;
    const resolved = resolveConsent({ configPath, proxyBase: checkedEndpoint });
    const { ok: configPresent, config } = readConfig(configPath);
    const storedScope = configPresent ? normalizeConsentScope(config?.telemetry?.scope) : null;
    const mismatch = resolved.scope_mismatch === true;
    if (args.json) {
      console.log(JSON.stringify({
        ok: true,
        action: "telemetry-status",
        config_path: configPath,
        config_present: configPresent,
        scope: storedScope,
        checked_endpoint: checkedEndpoint,
        scope_mismatch: mismatch,
        state: resolved.state,
        source: resolved.source,
        resolved: resolved.resolved,
        env_override: process.env[TELEMETRY_ENV_VAR] ?? null,
      }, null, 2));
      return;
    }
    console.log(`Telemetry: ${resolved.state} (source: ${resolved.source})${resolved.scope_bypassed ? ` — ${TELEMETRY_ENV_VAR} bypasses scope checking for ${checkedEndpoint}` : ""}`);
    console.log(`Config: ${configPath}${configPresent ? "" : " (not set)"}`);
    if (storedScope) {
      console.log(`Scope: ${storedScope}${storedScope === CANONICAL_REMIT_SCOPE ? " (canonical NEXT endpoint)" : ""}`);
    }
    console.log(`Checked endpoint: ${checkedEndpoint}`);
    if (resolved.default_on === true) {
      console.log(`No explicit choice recorded — remit to the canonical NEXT endpoint (${resolved.scope}) is ON by default. Opt out with: ${cmd("telemetry")} off`);
    } else if (mismatch) {
      console.log(`Scope mismatch — the stored grant is for ${storedScope || "(unscoped)"}, so remit to ${checkedEndpoint} is OFF. Consent to it with: ${scopedConsentCommand(checkedEndpoint)}`);
    } else if (!resolved.resolved) {
      // Only reachable for a malformed config file or a non-canonical
      // endpoint with no grant — the resolver fails CLOSED there, so the
      // state really is off until the operator records a choice.
      console.log(`Consent could not be resolved (malformed config, or no grant for ${checkedEndpoint}) — remit is OFF until you set it: ${scopedConsentCommand(checkedEndpoint)} | ${cmd("telemetry")} off`);
    }
    return;
  }

  if (sub === "list") return telemetryList(args);

  throw refused(`Unknown telemetry subcommand "${sub}". Use: status | on | off | list.`);
}

// `telemetry list` — the reader that never existed. Since the receiver
// tenant-scoped GET /api/runs (2026-08-31), listing needs either the campaign
// key (tenant scope: only records remitted WITH X-Campaign-Key) or the ops
// admin key (cross-tenant, includes every unscoped record). With --packet the
// campaign key is resolved exactly as the remit resolves it; otherwise the
// admin key is read from the env var named by --admin-key-env (default
// CAMPAIGN_OPS_ADMIN_KEY). Read-only; never persists anything.
const DEFAULT_ADMIN_KEY_ENV = "CAMPAIGN_OPS_ADMIN_KEY";
const TELEMETRY_LIST_TIMEOUT_MS = 15_000;

const TELEMETRY_LIST_MAX_BODY_BYTES = 4_000_000; // the receiver caps a listing at 500 summaries

export async function telemetryList(args, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw refused("Global fetch is not available. Upgrade to Node 18+.");
  // Same transport gate the remit rail uses: https, or a loopback host with a
  // loud warning that the credential is in clear. Anything else is refused
  // here, before a credential is attached to a request and before the packet
  // below is read — the same up-front position the gate holds under
  // `telemetry status|on`, so it is tagged the same way. The gate's own
  // normalized base is what the consent scope and the request URL below are
  // built from, so one string decides both.
  const { url: proxyUrl, base: proxyBase, loopback } = refuseInsecureProxyBase(
    optionalString(args["proxy-base"]) || DEFAULT_PROXY_BASE,
    { label: "telemetry list", credential: "the listing credential (the ops admin key, or the packet's campaign key)" },
  );
  const headers = { Accept: "application/json" };
  let scope;
  if (optionalString(args.packet)) {
    const packetPath = resolve(args.packet);
    const packet = readJson(packetPath);
    const { key, rejected } = resolveCampaignsApiKeySource(packet, packetPath, process.env);
    const rejection = describeCampaignKeyRejection(rejected);
    // Fail fast, before a request: a refused credential names its source so
    // the operator can fix it, and nothing is sent in the meantime. Every
    // refusal ahead of the request is tagged, so the lifecycle journal records
    // nothing for it — the same rule as a flag refused up front.
    if (rejection) throw refused(`telemetry list --packet: ${rejection}`);
    if (!key) throw refused(`telemetry list --packet: no Campaigns API key found in ${packetPath}, its local CampaignSpec, or the declared env source; pass a packet that carries one, or list cross-tenant with the admin key instead.`);
    headers["X-Campaign-Key"] = key;
    scope = "tenant";
  } else {
    // The admin key is a secret, unlike a campaign key. It goes only to the
    // canonical endpoint, a loopback test server, or a base the operator
    // explicitly vouched for with --trust-proxy-base — the same fail-closed
    // posture remit takes with default-on consent.
    const canonical = normalizeConsentScope(proxyBase) === CANONICAL_REMIT_SCOPE;
    if (!canonical && !loopback && args["trust-proxy-base"] !== true) {
      throw refused(`telemetry list: refusing to send the ops admin key to non-canonical ${proxyUrl.origin}. Pass --trust-proxy-base if that endpoint is yours, or use --packet for a tenant-scoped listing.`);
    }
    const envName = optionalString(args["admin-key-env"]) || DEFAULT_ADMIN_KEY_ENV;
    const adminKey = process.env[envName];
    if (!isNonEmptyString(adminKey)) throw refused(`telemetry list: set ${envName} (the ops admin key) for the cross-tenant listing, or pass --packet <campaign-runtime.build.json> for a tenant-scoped one.`);
    console.warn("Warning: CAMPAIGN_OPS_ADMIN_KEY (or the selected admin-key env) is a break-glass /api/runs listing credential. Use campaigns-os login for supported store-profile reads; login does not grant cross-tenant run listing.");
    headers["X-Campaigns-Ops-Admin-Key"] = adminKey.trim();
    scope = "admin";
  }
  const query = new URLSearchParams();
  if (optionalString(args.since)) query.set("since", args.since);
  if (optionalString(args.package)) query.set("package", args.package);
  if (optionalString(args.surface)) query.set("surface", args.surface);
  if (args.trusted === true || args.trusted === "true") query.set("trusted", "true");
  const url = `${proxyBase}${DEFAULT_RUNS_ENDPOINT}${query.size ? `?${query}` : ""}`;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TELEMETRY_LIST_TIMEOUT_MS) });
  const text = await boundedResponseText(response, { maxBodyBytes: TELEMETRY_LIST_MAX_BODY_BYTES, timeoutMs: TELEMETRY_LIST_TIMEOUT_MS });
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
  if (!response.ok) throw new Error(`telemetry list: ${response.status} ${response.statusText} from ${url}: ${JSON.stringify(body).slice(0, 400)}`);
  // A 2xx is not a listing until it carries runs[]. A maintenance page or an
  // intermediary's HTML comes back 200 with no JSON at all, and reporting that
  // as "0 of 0 returned" would tell the operator the receiver holds nothing.
  if (!Array.isArray(body.runs)) {
    throw new Error(`telemetry list: ${response.status} ${response.statusText} from ${url} is not a Run Record listing (no runs[] in the body): ${JSON.stringify(body).slice(0, 400)}`);
  }
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 50;
  // --limit trims client-side (the receiver has no page size); `count` is
  // what is shown, `returned` what the receiver sent, `total` what it holds.
  const returned = body.runs.length;
  const runs = body.runs.slice(0, limit);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, action: "telemetry-list", scope, endpoint: url, count: runs.length, returned, total: body.total ?? null, truncated: body.truncated === true, runs }, null, 2));
    return;
  }
  console.log(`Run Records at ${proxyBase} (${scope} scope): showing ${runs.length} of ${returned} returned${body.total != null ? `, ${body.total} stored` : ""}${body.truncated ? " (receiver scan truncated)" : ""}`);
  if (!runs.length) {
    console.log(scope === "tenant"
      ? "None in this tenant scope. Records remitted before the CLI sent X-Campaign-Key are unscoped — list them with the admin key."
      : "None stored.");
    return;
  }
  for (const run of runs) {
    console.log(`  ${String(run.received_at || "").slice(0, 19).padEnd(19)}  ${String(run.run_id || "").padEnd(30)}  ${String(run.package_version || "-").padEnd(14)}  ${String(run.primary_surface || "-").padEnd(12)}  ${run.trusted === true ? "trusted" : "anon"}  ${run.campaign_key_hash ? "scoped" : "unscoped"}`);
  }
}

// Tiny Prompts: skippable one-line guidance at stage boundaries. They surface
// the next Expected Proof Step and optionally point at `findings add`. They
// are TEXT-ONLY by design — JSON output stays machine-readable, so these are
// never written into the serialized result object.

// The tiny prompt under a text-mode doctor report. Returns the lines to
// print, in order, so the text is assertable without a subprocess.
export function doctorTinyPromptLines(result) {
  if (result.status === "blocked") {
    return [
      "",
      "Next expected proof: resolve the blockers above, then re-run doctor.",
      `If a blocker is confusing or the prompt is missing, record it: ${cmd("findings")} add --stage doctor --kind blocker --summary "..."`,
    ];
  }
  return [
    "",
    `Next expected proof: ${cmd("next")} to pick the next stage (setup/build), then polish, deploy, and QA.`,
    `Found workflow friction here? ${cmd("findings")} add --stage doctor --kind friction --summary "..."`,
  ];
}

function printDoctorTinyPrompt(result, args) {
  if (args.json) return;
  for (const line of doctorTinyPromptLines(result)) console.log(line);
}

// Which gate a next_actions[] entry belongs to, by the id prefix
// buildNextActions assigns: `theme_gate.<id>`, `polish_gate.<id>`,
// `checkpoint.<gate id>.<suffix>` (the gate id itself carries dots, so the
// registered ids are matched longest-first), and the prepare-build recoveries.
// Rechecks and anything unrecognised belong to no gate.
const NEXT_ACTION_GATE_PREFIXES = [["theme_gate.", "theme_gate"], ["polish_gate.", "polish_gate"]];
// The complete, pasteable rerun of prepare-build/start. The build context's
// `intake` block (recorded at prepare time) is the authority: the spec as it
// was passed (a local file is replayed as --spec; a map id fetched from a
// store as --map-id, with --proxy-base when that store was not the default),
// the source root, target, locked family, and the optional flags the run
// carried (--brief, --design-manifest, --allow-uncertified-template,
// --wrapper-policy). Paths are emitted absolute and quoted, resolved against
// the target the context is relative to, so the line runs from any working
// directory. A packet from before `intake` existed falls back to the packet's
// own fields, which cannot say whether --spec or --map-id was used: the map id
// wins there, and --proxy-base is inferred from the spec's recorded URL. An
// input nobody recorded is printed as an explicit placeholder, never dropped.
export function prepareBuildRerunCommand({ packet, packetPath = null, context = null, targetRepo = null } = {}) {
  const packetDir = packetPath ? dirname(resolve(packetPath)) : null;
  const intake = context?.intake && typeof context.intake === "object" ? context.intake : null;
  const notes = [];
  // Context paths are target-relative; packet paths are packet-relative.
  const contextBase = intake
    ? (targetRepo ? resolve(targetRepo) : packetDir && optionalString(packet?.assembly?.target_repo) ? resolve(packetDir, packet.assembly.target_repo) : null)
    : null;
  const abs = (base, value) => (base && optionalString(value) ? shellToken(resolve(base, value)) : optionalString(value) ? shellToken(value) : null);
  const parts = ["campaigns-os start"];
  if (intake) {
    if (intake.spec_source === "local" || !intake.map_id) {
      const specPath = optionalString(intake.spec_path);
      if (specPath) {
        const absolute = contextBase ? resolve(contextBase, specPath) : specPath;
        parts.push(`--spec ${shellToken(absolute)}`);
        if (contextBase && !existsSync(absolute)) notes.push(`The recorded local spec ${absolute} no longer exists; restore it (or re-export it there) before rerunning.`);
      } else {
        parts.push("--spec <campaignspec.json>");
      }
    } else {
      parts.push(`--map-id ${shellToken(intake.map_id)}`);
    }
    parts.push(
      `--source ${abs(contextBase, intake.source_root) || "<source-dir>"}`,
      `--target ${abs(contextBase, intake.target_repo) || "<target-dir>"}`,
      `--template-family ${optionalString(intake.template_family) ? shellToken(intake.template_family) : optionalString(packet?.assembly?.template_family) ? shellToken(packet.assembly.template_family) : "<family>"}`,
    );
    if (intake.map_id && optionalString(intake.proxy_base) && intake.proxy_base !== DEFAULT_PROXY_BASE) parts.push(`--proxy-base ${shellToken(intake.proxy_base)}`);
    if (optionalString(intake.brief_path)) parts.push(`--brief ${abs(contextBase, intake.brief_path)}`);
    if (optionalString(intake.design_manifest_path)) parts.push(`--design-manifest ${abs(contextBase, intake.design_manifest_path)}`);
    if (optionalString(intake.allow_uncertified_template)) parts.push(`--allow-uncertified-template ${shellToken(intake.allow_uncertified_template)}`);
    if (optionalString(intake.wrapper_policy)) parts.push(`--wrapper-policy ${shellToken(intake.wrapper_policy)}`);
    return { command: asInvocation(parts.join(" ")), notes };
  }
  const mapId = optionalString(packet?.spec?.map_id);
  const localSpec = optionalString(packet?.spec?.local_path);
  const arg = (value, placeholder) => abs(packetDir, value) || placeholder;
  if (mapId) parts.push(`--map-id ${shellToken(mapId)}`);
  else if (localSpec) parts.push(`--spec ${arg(localSpec, "<campaignspec.json>")}`);
  else parts.push("--spec <campaignspec.json>");
  parts.push(
    `--source ${arg(packet?.source_html?.root, "<source-dir>")}`,
    `--target ${arg(packet?.assembly?.target_repo, "<target-dir>")}`,
    `--template-family ${optionalString(packet?.assembly?.template_family) ? shellToken(packet.assembly.template_family) : "<family>"}`,
  );
  const specUrl = optionalString(packet?.spec?.spec_url);
  if (mapId && specUrl) {
    try {
      const origin = new URL(specUrl).origin;
      if (origin !== DEFAULT_PROXY_BASE) parts.push(`--proxy-base ${shellToken(origin)}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  notes.push("This packet predates recorded intake provenance: the map id is replayed (the run may have used --spec), and --brief / --design-manifest / --allow-uncertified-template / --wrapper-policy cannot be replayed from it.");
  return { command: asInvocation(parts.join(" ")), notes };
}

const PREPARE_BUILD_ACTION_IDS = new Set(["rerun_prepare_build", "restore_prepare_build_binding"]);
function nextActionGate(action, gateIds) {
  const id = typeof action?.id === "string" ? action.id : "";
  for (const [prefix, gate] of NEXT_ACTION_GATE_PREFIXES) if (id.startsWith(prefix)) return gate;
  if (id.startsWith("checkpoint.")) {
    const rest = id.slice("checkpoint.".length);
    return [...gateIds].sort((a, b) => b.length - a.length).find((gate) => rest === gate || rest.startsWith(`${gate}.`)) || null;
  }
  if (PREPARE_BUILD_ACTION_IDS.has(id)) return "prepare_build";
  return null;
}

// Every gate buildNextGates emits has a heading of its own: the fixed gates
// by name, and anything else is a registered checkpoint gate. The doctor gate
// is named explicitly so a future action that resolves to it is never filed
// as a checkpoint.
function nextGateHeading(gate) {
  if (gate.id === "doctor") return "Doctor is BLOCKING this stage. Resolve it with:";
  if (gate.id === "theme_gate") return "Theme gate is BLOCKING this stage. Resolve it with:";
  if (gate.id === "polish_gate") return "Polish gate is BLOCKING this stage. Resolve it with:";
  if (gate.id === "prepare_build") return "prepare-build is BLOCKING this stage. Resolve it with:";
  return `Checkpoint gate ${gate.id} is BLOCKING this stage. Resolve it with:`;
}

// The human half of `next`. Split out from the printer so the text an operator
// actually reads is assertable without a subprocess: JSON output is covered by
// next_actions[], and the prompt is the only place a non-JSON caller sees any
// of it. Returns the lines to print, in order; an empty array prints nothing.
export function nextTinyPromptLines(result) {
  const lines = [];
  const actions = Array.isArray(result.next_actions) ? result.next_actions : [];
  const gates = Array.isArray(result.gates) ? result.gates : [];
  const blockedGates = gates.filter((gate) => gate?.status === "blocked");
  // Every blocked gate owns its own heading and lists only the actions it
  // produced, so a checkpoint repair is never filed under the theme gate and
  // the checkpoint commands are printed whether or not the theme gate is also
  // blocked. What no gate claims (the rechecks) follows under its own line.
  if (blockedGates.length) {
    const gateIds = gates.map((gate) => gate?.id).filter(Boolean);
    const claimed = new Set();
    for (const gate of blockedGates) {
      const owned = actions.filter((action) => nextActionGate(action, gateIds) === gate.id);
      if (!owned.length) continue;
      lines.push("", nextGateHeading(gate));
      for (const action of owned) {
        lines.push(`  - ${action.command || action.description}`);
        claimed.add(action);
      }
    }
    const rest = actions.filter((action) => !claimed.has(action));
    if (rest.length) {
      lines.push("", claimed.size ? "Then:" : "This stage is BLOCKED. Resolve it with:");
      for (const action of rest) lines.push(`  - ${action.command || action.description}`);
    }
    if (blockedGates.some((gate) => gate.id === "theme_gate")) return lines;
  }
  // A passing-but-token-less theme gate is the case that used to say nothing
  // at all until QA blocked. It is not a blocker here, so it does not take the
  // prompt over — it is printed alongside whatever else this stage says.
  const contractDefect = (result.next_actions || []).find((action) => action?.id === BRAND_CONTRACT_DEFECT_ACTION_ID);
  if (contractDefect) {
    lines.push("", "This family's template brand contract cannot be read, and browser QA will REJECT it:");
    lines.push(`  - ${contractDefect.description}`);
  }
  const starterPalette = (result.next_actions || []).find((action) => action?.id === THEME_STARTER_PALETTE_ACTION_ID);
  if (starterPalette) {
    lines.push("", "Theme gate passes with no brand layer, and browser QA will BLOCK on the starter palette:");
    lines.push(`  - ${starterPalette.description}`);
  }
  if (result.stage !== "qa") return lines;
  lines.push("");
  lines.push(`Next expected proof: browser QA + typed-card proof. Run: ${cmd("qa")} run --packet <packet> --base-url <url> --browser --test-order common`);
  lines.push("Localhost on any port is a Development domain (SDK allowed, analytics suppressed). Non-localhost origins still need SDK allowlist confirmation.");
  lines.push(`Build/polish done but no QA verdict yet is a Completeness Signal, not a build failure: ${cmd("findings")} add --stage qa --kind missing_prompt --summary "..."`);
  return lines;
}

// The remediation half of the human doctor report. `doctor --json` has always
// carried each checkpoint gate's `required_actions[]` — the exact command or
// manual step that clears the gate — and docs/build-packet.md documents them,
// but the text report printed only the error line. A cold operator reading
// stdout saw "does not match the CampaignSpec pin" and no way forward, which
// is the state this renders out of existence. Exported (like
// nextTinyPromptLines) so the text an operator reads is assertable without a
// subprocess. Returns the lines to print, in order; an empty array prints
// nothing. `--packet <packet>` is substituted with the packet this run read,
// exactly as the QA resolve printer does, so the command is copy-pasteable;
// under --strip-paths derived.packet_path is already relativized, so the
// substitution stays portable.
export function doctorRequiredActionLines(result) {
  const derived = result?.derived;
  // Same gate set `next` aggregates: the per-check checkpoint gates plus the
  // polish checkpoint gate, so the two commands cannot disagree about which
  // gates owe the operator an action.
  const gates = [
    ...(Array.isArray(derived?.checkpoint_gates) ? derived.checkpoint_gates : []),
    ...(derived?.polish_checkpoint_gate ? [derived.polish_checkpoint_gate] : []),
  ];
  const packetPath = typeof derived?.packet_path === "string" ? derived.packet_path : null;
  // Carry the inspected report into the printed command, for the same reason
  // the `Next:` block carries an explicit --context/--report: a remediation
  // must act on the artifacts the inspection read. `checkpoint waive` and
  // `polish capture` both default to the packet-inferred
  // <target repo>/.campaign-runtime/assembly-report.json, so a run whose
  // report came from somewhere else (--report, or a context report_path
  // binding) would otherwise send the operator at a different report — or at
  // a file that does not exist — and leave the inspected gate blocked. Quiet
  // in the common case: the arg is appended only when the inspected report is
  // not that default, or when the target repo is unknown so the default
  // cannot be ruled out.
  const inspectedReportPath = typeof derived?.assembly_report_path === "string" ? derived.assembly_report_path : null;
  const inferredReportPath = typeof derived?.target_repo === "string"
    ? campaignSidecarPaths(derived.target_repo).reportPath
    : null;
  const reportPath = inspectedReportPath && inspectedReportPath !== inferredReportPath ? inspectedReportPath : null;
  const lines = [];
  for (const gate of gates) {
    for (const action of gate?.required_actions || []) {
      const text = requiredActionText(action, { packetPath, reportPath });
      if (text) lines.push(`- [${gate.id}] ${text}`);
    }
  }
  if (!lines.length) return [];
  return ["Required actions:", ...lines];
}

function printNextTinyPrompt(result, args) {
  if (args.json) return;
  for (const line of nextTinyPromptLines(result)) console.log(line);
}

function printPrepareResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.doctor && !result.doctor.ok) process.exitCode = 2;
    return;
  }
  console.log("Campaigns OS prepare-build");
  if (result.spec_source) {
    const src = result.spec_source;
    if (src.source === "remote") {
      console.log(`Spec: ${src.specPath} (fetched from ${src.proxyBase}/api/spec/${src.mapId})`);
    } else if (src.source === "cache") {
      console.log(`Spec: ${src.specPath} (cached from ${src.proxyBase}/api/spec/${src.mapId}; --cached-spec)`);
    } else {
      console.log(`Spec: ${src.specPath}`);
    }
  }
  console.log(`Packet: ${result.packetPath}`);
  if (result.briefPath) {
    const brief = result.context?.build_brief;
    console.log(`Brief: ${result.briefPath}${brief ? ` (${brief.mode}, ${brief.status}, questions=${brief.question_count})` : ""}`);
  }
  console.log(`Context: ${result.contextPath}`);
  console.log(`Report: ${result.reportPath}`);
  if (result.doctor) {
    console.log(`Doctor: ${result.doctorOutPath}`);
    printResult(result.doctor);
  } else {
    console.log(`Next: run ${cmd("doctor")}, then ${cmd("next")} build.`);
  }
  if (result.doctor && !result.doctor.ok) process.exitCode = 2;
}

// The human text report of a command result — doctor's, and every other
// command that prints through writeResult. One walker, returning the lines in
// order (status, targets, skills, ready, actions, cause summary, errors,
// warnings, required actions, next, prompt, note) so the text an operator
// reads is assertable without a subprocess; printResult prints the join.
const WAIVE_ACTIONS = new Set(["theme-waive", "checkpoint-waive"]);

// headerLines: caller-supplied lines printed directly under Status (a bundle
// check's readiness line); they are text-only and never enter the JSON result.
export function resultTextLines(result, { headerLines = [] } = {}) {
  const lines = [`Status: ${String(result.status || "unknown").toUpperCase()}`, ...headerLines];
  // A waive command's second line names what it recorded; the third is the
  // stage doctor now picks for the report the waiver was written to.
  if (WAIVE_ACTIONS.has(result.action) && result.gate) {
    lines.push(`${result.dry_run ? "Would waive" : "Waived"}: ${result.gate} by ${result.waiver?.waived_by || "(unattributed)"}${result.waiver?.expires_at ? ` until ${result.waiver.expires_at}` : ""}`);
    if (result.dry_run) lines.push(`Would write: ${result.would_write} (nothing was written)`);
    if (result.next_stage) lines.push(`Next stage: ${result.next_stage}${result.next_stage_reason ? ` (${result.next_stage_reason})` : ""}`);
  }
  if (result.targets?.length) {
    lines.push("Targets:");
    for (const target of result.targets) {
      lines.push(`- ${target.platform_label || target.platform}: ${target.target_directory}`);
    }
  } else if (result.platform_label && result.target_directory) {
    lines.push(`Target: ${result.platform_label} (${result.target_directory})`);
  }
  if (result.skills?.length) {
    lines.push("Skills:");
    for (const skill of result.skills) lines.push(`- ${formatSkillInstallSummary(skill)}`);
  }
  if (result.ready?.length) {
    lines.push("Ready:");
    for (const item of result.ready) lines.push(`- ${item}`);
  }
  if (result.actions?.length) {
    lines.push("Actions:");
    for (const action of result.actions) lines.push(`- ${action}`);
  }
  lines.push(...formatCauseReportLines(result.cause_summary));
  if (result.errors?.length) {
    lines.push("Errors:");
    for (const issue of result.errors) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  if (result.warnings?.length) {
    lines.push("Warnings:");
    for (const issue of result.warnings) lines.push(`- ${formatIssueSummary(issue)}`);
  }
  // Directly under the findings they remediate, above the stage picker's
  // `Next:` block: the operator reads what is wrong, then what clears it.
  lines.push(...doctorRequiredActionLines(result));
  if (result.next) {
    lines.push("Next:");
    lines.push(`- ${result.next.stage || "unknown"} (${result.next.owner || result.next.default_skill || "owner unknown"})`);
    for (const action of result.next.actions || []) lines.push(`- ${action}`);
  }
  if (result.prompt) lines.push("", result.prompt);
  if (result.note) lines.push(result.note);
  return lines;
}

function printResult(result, { headerLines = [] } = {}) {
  for (const line of resultTextLines(result, { headerLines })) console.log(line);
}

function formatIssueSummary(issue) {
  if (typeof issue === "string") return issue;
  // The cause tag trails the message so the existing "[code] message" shape an
  // operator (and every script grepping this output) already reads is unchanged.
  const cause = formatCauseTag(issue);
  const suffix = cause ? ` ${cause}` : "";
  if (issue?.code && issue?.message) return `[${issue.code}] ${issue.message}${suffix}`;
  if (issue?.message) return `${issue.message}${suffix}`;
  return String(issue);
}

function formatSkillInstallSummary(skill) {
  const prefix = skill.platform && skill.platform !== "custom" ? `${skill.platform}/` : "";
  if (skill.action === "created") return `${prefix}${skill.name}: created (${skill.to.label})`;
  if (skill.action === "updated") {
    const from = skill.from?.label || "missing";
    return `${prefix}${skill.name}: updated (${from} -> ${skill.to.label})`;
  }
  if (skill.action === "retired") return `${prefix}${skill.name}: ${skill.note}`;
  if (skill.action === "occupied_by_other") return `${prefix}${skill.name}: ${skill.note}`;
  return `${prefix}${skill.name}: unchanged (${skill.to.label})`;
}

// `spec derive --write-map`: the Map half of #415, kept apart from
// specDeriveCommand on purpose (that function and spec-derive.mjs are the
// local derive; this is the one call site that reaches the Map). The local
// derive decides the pin (the repo pin, when the plan says the repo states
// it); this records the same pin into the saved Map's Build hints field
// through the proxy Worker so the Map and every export of it stop reading
// stale. The Map is read back first and re-stated with only the pin moved,
// under the Map's own spec_hash as a precondition, and the write goes forward
// or not at all (map-pin-writeback.mjs). A refusal is a warning and exit 0
// (the local derive stood); a write the operator asked for that could not
// happen — no key, wrong key, Map gone or saved in between, proxy refused —
// is an error and exit 2. A write is recorded on the Assembly Report's
// evidence[] (the Run Record references the report by hash) beside the
// result's `map`. The two flags are validated and stripped here, so the local
// command sees exactly the argv it always has.
const SPEC_DERIVE_MAP_FLAGS = Object.freeze(["write-map", "proxy-base"]);
const SPEC_DERIVE_MAP_ISSUE_PREFIX = "spec.derive.map_";

export async function specDeriveWithMapWriteback(args, { fetchImpl = undefined, env = process.env, warn = undefined } = {}) {
  // `--write-map` is a bare flag: a network write must never be switched on
  // by a stray value. `--proxy-base` names a URL or is refused here, before
  // anything is read, as `telemetry` refuses a bare one.
  if (Object.hasOwn(args, "write-map") && args["write-map"] !== true) {
    throw refused(`--write-map takes no value (got ${JSON.stringify(args["write-map"])}); write \`--write-map\` on its own, after the other flags.`);
  }
  if (Object.hasOwn(args, "proxy-base") && !optionalString(args["proxy-base"])) {
    throw refused("spec derive: --proxy-base needs a URL (https, or a loopback host); nothing was written.");
  }
  if (optionalString(args["proxy-base"]) && args["write-map"] !== true) {
    throw refused("spec derive: --proxy-base only applies with --write-map; nothing was written.");
  }
  const writeMap = args["write-map"] === true;
  const localArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !SPEC_DERIVE_MAP_FLAGS.includes(key)));
  // A copy, so nothing here depends on the local command handing out a
  // mutable object; the Map outcome is added beside its fields, not into them.
  // The store source (--from-store) is the other network read; it runs
  // before the Map write-back so the pin it reports is the one written.
  const local = Object.hasOwn(localArgs, "from-store") ? await specDeriveFromStoreCommand(localArgs) : specDeriveCommand(localArgs);
  const result = { ...local, write_map: writeMap, map: null };
  if (!writeMap) return result;
  const skipped = (reason, detail) => {
    result.map = { status: "skipped", reason, detail, map_id: null, proxy_base: null, field: "global_config.sdk_version", before: null, after: null, spec_identity: { before: null, after: null }, warnings: [], recorded: null };
    return result;
  };
  if (!result.ok) return skipped("derive_blocked", "the local derive was blocked, so no pin was decided; nothing was sent to the Map.");
  const pinRow = [...result.changes, ...result.unchanged].find((row) => row.field === "global_config.sdk_version");
  if (!pinRow) {
    const held = result.not_derived.find((row) => row.field === "global_config.sdk_version");
    const reason = held ? `pin_${held.reason}` : "pin_not_derived";
    skipped(reason, held ? `the pin was not derived (${held.reason}), so it was not written to the Map either: ${held.detail}` : "the pin was not derived, so it was not written to the Map either.");
    addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}skipped`, `Map not written: ${result.map.detail}`, { reason });
    return result;
  }
  let packet = null;
  try {
    packet = readJson(result.packet_path);
  } catch {
    packet = null;
  }
  const mapId = optionalString(packet?.spec?.map_id) || null;
  const keySource = resolveCampaignsApiKeySource(packet, result.packet_path, env);
  const proxyBase = optionalString(args["proxy-base"]) || DEFAULT_PROXY_BASE;
  const outcome = await writeMapSdkPin({
    mapId,
    repoPin: pinRow.after,
    campaignKey: keySource.key,
    proxyBase,
    dryRun: result.dry_run,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(warn ? { warn } : {}),
  });
  if (outcome.status === "failed" && outcome.reason === "key_missing" && keySource.rejected) {
    outcome.detail = `${describeCampaignKeyRejection(keySource.rejected) || outcome.detail} The Map write needs the key as X-Campaign-Key.`;
  }
  result.map = outcome;
  for (const text of outcome.warnings) addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}validation_warning`, `The proxy accepted the Map with a warning: ${singleLineDetail(text)}`);
  if (outcome.status === "refused") {
    addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}${outcome.reason}`, `Map ${outcome.map_id} not written: ${outcome.detail}`, { reason: outcome.reason, map_pin: outcome.before, repo_pin: outcome.after });
    return result;
  }
  if (outcome.status === "failed") {
    addIssue(result.errors, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}${outcome.reason}`, `Map ${outcome.map_id || "(no Map ID)"} not written: ${outcome.detail}`, { reason: outcome.reason });
    result.ok = false;
    return result;
  }
  if (outcome.status !== "written") return result;
  // The write is traceable from the campaign's own record: an evidence line
  // on the Assembly Report, which the Run Record references by hash and
  // doctor re-reads. The report may legitimately not exist yet (a derive
  // before prepare-build); the result document still carries the write.
  const at = new Date().toISOString();
  const identityNote = outcome.spec_identity.after?.spec_hash
    ? ` (Map spec_hash ${outcome.spec_identity.before?.spec_hash || "none"} -> ${outcome.spec_identity.after.spec_hash})`
    : "";
  const line = `Map write-back: global_config.sdk_version ${outcome.before == null ? "(absent)" : outcome.before} -> ${outcome.after} on Map ${outcome.map_id} at ${at} via spec derive --write-map${identityNote}`;
  try {
    const workspace = resolveCampaignWorkspace(result.packet_path, {
      packet,
      followContextPointer: true,
      reportPath: isNonEmptyString(args.report) ? resolve(args.report) : undefined,
    });
    if (!existsSync(workspace.reportPath)) throw new Error(`no Assembly Report at ${workspace.reportPath}`);
    commitAssemblyReport(workspace, (report) => ({
      ...report,
      evidence: [...(Array.isArray(report.evidence) ? report.evidence : []), line],
    }), {
      command: "spec derive --write-map",
      staleReason: `spec derive wrote the repo SDK pin to the Map after this doctor snapshot. Re-run ${cmd("doctor")} (or next) for current state.`,
    });
    result.map.recorded = "assembly_report";
  } catch (error) {
    // The report is written before the doctor sidecar is stamped, so a throw
    // can leave the line on disk. Read back what is there rather than claim
    // either way: a line that landed is recorded (only the stamp failed); one
    // that did not is carried on this result.
    // A read-back that itself fails is a third answer, "unknown", never
    // folded into "absent": `recorded` is the one signal an out-of-repo
    // consumer has, and a torn re-read must not report a landed line as lost.
    const landed = (() => {
      try {
        const written = readJsonIfExists(resolveCampaignWorkspace(result.packet_path, { packet, followContextPointer: true, reportPath: isNonEmptyString(args.report) ? resolve(args.report) : undefined }).reportPath);
        return Array.isArray(written?.evidence) && written.evidence.includes(line) ? "landed" : "absent";
      } catch {
        return "unknown";
      }
    })();
    result.map.recorded = landed === "landed" ? "assembly_report" : landed === "unknown" ? "unknown" : null;
    if (landed === "landed") addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}doctor_sidecar_not_marked`, `The Map write is recorded on the Assembly Report, but the retained doctor snapshot could not be marked stale (${singleLineDetail(error.message)}); re-run doctor before trusting it.`);
    else if (landed === "unknown") addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}recorded_status_unknown`, `The Map was written, but the Assembly Report could not be read back after the record attempt failed (${singleLineDetail(error.message)}); whether the line landed is unknown. Check the report's evidence[] for, or add, this line: ${line}`);
    else addIssue(result.warnings, `${SPEC_DERIVE_MAP_ISSUE_PREFIX}not_recorded`, `The Map was written, but the write was not recorded on the Assembly Report (${singleLineDetail(error.message)}). Keep this result: ${line}`);
  }
  return result;
}

// The text form of a derive-with-Map result: the local printer's lines, with
// the Map line and any Map errors inserted ahead of the warnings. Map errors
// are lifted out before the local printer runs so a failed Map write after a
// successful local write still prints the diff the write made; a blocked
// local derive prints as it always has (the Map was never reached).
export function specDeriveWriteMapTextLines(result) {
  const isMapIssue = (issue) => typeof issue?.code === "string" && issue.code.startsWith(SPEC_DERIVE_MAP_ISSUE_PREFIX);
  const mapErrors = (result.errors || []).filter(isMapIssue);
  const lines = specDeriveTextLines({ ...result, errors: (result.errors || []).filter((issue) => !isMapIssue(issue)) });
  if (!result.map || result.status === "blocked") return lines;
  const insert = [specDeriveMapLine(result.map)];
  if (mapErrors.length) {
    insert.push("Errors:");
    for (const issue of mapErrors) insert.push(`- ${formatIssueSummary(issue)}`);
  }
  const at = lines.findIndex((line) => line === "Warnings:" || line.startsWith("Next: "));
  if (at === -1) lines.push(...insert);
  else lines.splice(at, 0, ...insert);
  return lines;
}

function specDeriveMapLine(map) {
  const where = map.map_id ? `Map ${singleLineField(map.map_id)}` : "Map";
  const pin = `${map.field}: ${map.before == null ? "(absent)" : formatDeriveValue(map.before)} -> ${formatDeriveValue(map.after)}`;
  switch (map.status) {
    case "written": return `${where} written: ${pin}${map.spec_identity?.after?.saved_at ? ` (saved ${map.spec_identity.after.saved_at})` : ""}${map.recorded === "assembly_report" ? "" : map.recorded === "unknown" ? " — Assembly Report record unverified (see Warnings)" : " — not recorded on the Assembly Report (see Warnings)"}`;
    case "would_write": return `${where} (dry run, nothing sent): would write ${pin}`;
    case "unchanged": return `${where} unchanged: already ${formatDeriveValue(map.after)}`;
    case "refused": return `${where} not written (${map.reason}): see Warnings`;
    case "skipped": return `${where} not written (${map.reason}): see Warnings`;
    default: return `${where} not written (${map.reason || "failed"}): see Errors`;
  }
}
