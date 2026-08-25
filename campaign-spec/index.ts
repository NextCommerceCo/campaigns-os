/**
 * campaign-spec — the CampaignSpec contract layer.
 *
 * Public interface for the spec validation module — the single source
 * of truth for CampaignSpec validation. The Campaigns OS CLI doctor and
 * any campaign authoring UI (e.g. a Map Builder browser bundle built
 * from this module) import from here, so internal teams and third-party
 * agencies validate against the same rules.
 *
 * Read ../CONTEXT.md for vocabulary (CampaignSpec, Rule, Violation, Tag,
 * Corpus, normalize) and ./README.md for usage patterns.
 */

import type { CampaignSpec, Rule, RuleSet, Violation } from './types.ts'
import { normalize, NormalizeError } from './normalize.ts'
import { allRules, fastRules, specOnlyRules } from './rules/index.ts'

// ── Types (re-exported for callers) ────────────────────────────────────────

export type {
  CampaignSpec,
  Rule,
  RuleSet,
  Violation,
  Tag,
  Severity,
  Fixture,
  Page,
  PageType,
  Funnel,
  Offer,
  Campaign,
  DesignSource,
  DesignSourceBreakpoints,
  TemplateFamilyHint,
  UpsellTemplatePattern,
  UpsellMvTiers,
  VariantLabels,
  PromoCode,
  AnalyticsContract,
  AnalyticsMode,
  AnalyticsProvider,
  OutOfBandPixel,
  ManualEvent,
  ContentParam,
  TrackingParams,
  AnalyticsParams,
  UtmTransfer,
} from './types.ts'

export { normalize, NormalizeError } from './normalize.ts'

// Outgoing-edge resolution — the single source of truth for "where does this
// page go". Source intake, cycle detection and the QA topology extractor all
// consume these rather than keeping their own page-type tables.
export {
  FORWARD_ROUTE_FIELDS,
  ACCEPT_ROUTE_FIELD,
  DECLINE_ROUTE_FIELD,
  ROUTE_FIELDS,
  PAYMENT_BEARING_PAGE_TYPES,
  OFFER_BEARING_PAGE_TYPES,
  forwardRouteTarget,
  acceptRouteTarget,
  declineRouteTarget,
  hasForwardRoute,
  inapplicableForwardFields,
  describeForwardField,
  outgoingEdgeIds,
} from './routing.ts'
export type { ForwardFieldApplicability } from './routing.ts'
export { allRules, fastRules, specOnlyRules } from './rules/index.ts'

// Supported schema_version matrix — single source for the SchemaVersion rule
// and any consumer that needs to present or gate on the supported lineages.
// A sync test pins it to the schemas/campaign-spec.v4.schema.json enum.
export { SUPPORTED_SCHEMA_VERSIONS } from './rules/schema-version.ts'

// Strict released-SDK-version parser — shared with the downstream Page Kit
// SDK-version checkpoint (src/page-kit-sdk-version.mjs) so authoring-time
// validation and build-time gating reject exactly the same values.
export {
  RELEASED_SDK_VERSION_PATTERN,
  parseSdkVersion,
  isReleasedSdkVersion,
  describeSdkVersionRejection,
} from './sdk-version-parse.ts'
export type {
  SdkVersionParseResult,
  SdkVersionRejectionReason,
} from './sdk-version-parse.ts'

// Canonical dl_* analytics event vocabulary — synced from the Campaign Cart SDK.
// The AnalyticsContractShape rule validates blockedEvents against it; the Map
// Builder picker (via the campaign-spec.js shim) autocompletes from it.
export {
  CAMPAIGN_CART_ANALYTICS_IDENTITY_MIN_SDK_VERSION,
  CAMPAIGN_CART_ANALYTICS_VOCABULARY_SDK_VERSION,
  DL_EVENTS,
  DL_EVENT_NAMES,
  DL_EVENT_NAME_SET,
  isKnownDlEvent,
} from './analytics-vocabulary.ts'
export type {
  DlEventCategory,
  DlEventDefinition,
} from './analytics-vocabulary.ts'

// ── Phases ─────────────────────────────────────────────────────────────────

/**
 * Run a RuleSet against a normalized spec. Returns the flat list of
 * violations across all rules; callers choose their failure policy (throw on
 * any error, collect for UI, etc.).
 *
 *   const violations = runRules(normalize(spec), allRules)
 *   if (violations.some(v => v.severity === 'error')) { ... }
 */
export function runRules(spec: CampaignSpec, rules: RuleSet): Violation[] {
  const out: Violation[] = []
  for (const rule of rules) {
    for (const violation of rule.check(spec)) {
      out.push(violation)
    }
  }
  return out
}

/**
 * Backwards-compatible entry point: normalize → run all rules.
 *
 * Equivalent to `runRules(normalize(input), allRules)`. Catches NormalizeError
 * and surfaces it as a single error-severity Violation so legacy callers that
 * expect a flat array don't need to handle exceptions.
 */
export function validateSpec(input: unknown): Violation[] {
  let spec: CampaignSpec
  try {
    spec = normalize(input)
  } catch (err) {
    if (err instanceof NormalizeError) {
      return [
        {
          ruleId: 'Normalize',
          severity: 'error',
          message: err.message,
          path: '',
        },
      ]
    }
    throw err
  }
  return runRules(spec, allRules)
}
