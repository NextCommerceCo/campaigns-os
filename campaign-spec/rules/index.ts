/**
 * Rule registry — preset RuleSet constants.
 *
 * Callers either pick a preset (allRules / fastRules / specOnlyRules) or
 * filter inline:
 *
 *   const myRules = allRules.filter(r => r.tags.includes('fast'))
 *
 * Tags are a closed taxonomy (see ../types.ts). To add a rule:
 *   1. Create rules/<your-rule>.ts exporting a `Rule`.
 *   2. Add it to `allRules` below.
 *   3. fastRules / specOnlyRules pick up via tag filter automatically.
 *
 * Rules are listed in a stable order — the order callers see violations in
 * for a multi-rule run. Keep cheap/metadata checks first so they surface
 * before downstream complaints.
 */

import type { Rule, RuleSet } from '../types.ts'

import { SchemaVersion } from './schema-version.ts'
import { SdkVersion } from './sdk-version.ts'
import { FunnelCount } from './funnel-count.ts'
import { FunnelIdentity } from './funnel-identity.ts'
import { FunnelHypothesisLength } from './funnel-hypothesis-length.ts'
import { FunnelWeightSum } from './funnel-weight-sum.ts'
import { PageCount } from './page-count.ts'
import { ThankYouRequirement } from './thank-you-requirement.ts'
import { PageIdUniqueness } from './page-id-uniqueness.ts'
import { UpsellHasPackages } from './upsell-has-packages.ts'
import { UpsellRoutingComplete } from './upsell-routing-complete.ts'
import { CheckoutHasSuccessUrl } from './checkout-has-success-url.ts'
import { UpsellWithoutCheckout } from './upsell-without-checkout.ts'
import { DownsellWithoutUpsell } from './downsell-without-upsell.ts'
import { CampaignMetadata } from './campaign-metadata.ts'
import { ShippingMethodsPresent } from './shipping-methods-present.ts'
import { ShippingCountriesShape } from './shipping-countries-shape.ts'
import { PackagePricingSanity } from './package-pricing-sanity.ts'
import { OfferRefIntegrity } from './offer-ref-integrity.ts'
import { ExitIntentValidation } from './exit-intent-validation.ts'
import { PromoCodeInputValidation } from './promo-code-input-validation.ts'
import { DesignSourceShape } from './design-source-shape.ts'
import { AssemblyHintsShape } from './assembly-hints-shape.ts'
import { PromoCodesShape } from './promo-codes-shape.ts'
import { VariantLabelsShape } from './variant-labels-shape.ts'
import { StoreProfileShape } from './store-profile-shape.ts'
import { CycleDetection } from './cycle-detection.ts'

export { SchemaVersion } from './schema-version.ts'
export { SdkVersion } from './sdk-version.ts'
export { CampaignMetadata } from './campaign-metadata.ts'
export { FunnelCount } from './funnel-count.ts'
export { FunnelIdentity } from './funnel-identity.ts'
export { FunnelHypothesisLength } from './funnel-hypothesis-length.ts'
export { FunnelWeightSum } from './funnel-weight-sum.ts'
export { PageCount } from './page-count.ts'
export { ThankYouRequirement } from './thank-you-requirement.ts'
export { PageIdUniqueness } from './page-id-uniqueness.ts'
export { UpsellHasPackages } from './upsell-has-packages.ts'
export { UpsellRoutingComplete } from './upsell-routing-complete.ts'
export { CheckoutHasSuccessUrl } from './checkout-has-success-url.ts'
export { UpsellWithoutCheckout } from './upsell-without-checkout.ts'
export { DownsellWithoutUpsell } from './downsell-without-upsell.ts'
export { PackagePricingSanity } from './package-pricing-sanity.ts'
export { ShippingMethodsPresent } from './shipping-methods-present.ts'
export { ShippingCountriesShape } from './shipping-countries-shape.ts'
export { OfferRefIntegrity } from './offer-ref-integrity.ts'
export { ExitIntentValidation } from './exit-intent-validation.ts'
export { PromoCodeInputValidation } from './promo-code-input-validation.ts'
export { DesignSourceShape } from './design-source-shape.ts'
export { AssemblyHintsShape } from './assembly-hints-shape.ts'
export { PromoCodesShape } from './promo-codes-shape.ts'
export { VariantLabelsShape } from './variant-labels-shape.ts'
export { StoreProfileShape } from './store-profile-shape.ts'
export { CycleDetection } from './cycle-detection.ts'

/**
 * Every rule in the registry. Callers should generally compose subsets from
 * this rather than importing individual rules — it's the stable surface.
 *
 * Order: metadata/identity checks first (cheap, frame the spec), then
 * structural checks (count, weights), then topology (cycles). Violations
 * surface in this order so operators see "your schema_version is missing"
 * before "your routing has a cycle."
 */
export const allRules: RuleSet = [
  SchemaVersion,
  SdkVersion,
  CampaignMetadata,
  FunnelCount,
  FunnelIdentity,
  FunnelHypothesisLength,
  FunnelWeightSum,
  PageCount,
  ThankYouRequirement,
  PageIdUniqueness,
  UpsellHasPackages,
  UpsellRoutingComplete,
  CheckoutHasSuccessUrl,
  UpsellWithoutCheckout,
  DownsellWithoutUpsell,
  PackagePricingSanity,
  ShippingMethodsPresent,
  ShippingCountriesShape,
  OfferRefIntegrity,
  ExitIntentValidation,
  PromoCodeInputValidation,
  DesignSourceShape,
  AssemblyHintsShape,
  PromoCodesShape,
  VariantLabelsShape,
  StoreProfileShape,
  CycleDetection,
]

/**
 * Cheap rules safe for per-keystroke Map Builder contexts. Selected by the
 * `fast` tag. Graph traversal rules (CycleDetection) intentionally absent.
 */
export const fastRules: RuleSet = allRules.filter((r: Rule) =>
  r.tags.includes('fast'),
)

/**
 * Rules that run against the spec alone, no live deployment needed. Used by
 * QA spec-only mode and any CI context without a deployed URL. Selected by
 * the `spec-only` tag.
 */
export const specOnlyRules: RuleSet = allRules.filter((r: Rule) =>
  r.tags.includes('spec-only'),
)
