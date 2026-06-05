/**
 * Corpus loader — discovers fixtures in this directory and pairs each spec
 * with its expected violations.
 *
 * Adding a fixture:
 *   1. Drop a <name>.json with a CampaignSpec.
 *   2. Drop a expected/<name>.expected.json with { violations: [...] }.
 *   3. Add the name + imports to the block below.
 *
 * Stays explicit rather than glob-scanning so a missing expected/ counterpart
 * surfaces as a clear import error, not a silently-empty test.
 */

import type { CampaignSpec, Fixture, Violation } from '../types.ts'

import singleFunnelBasic from './single-funnel-basic.json' with { type: 'json' }
import singleFunnelBasicExpected from './expected/single-funnel-basic.expected.json' with { type: 'json' }

import twoFunnelWithCycle from './two-funnel-with-cycle.json' with { type: 'json' }
import twoFunnelWithCycleExpected from './expected/two-funnel-with-cycle.expected.json' with { type: 'json' }

import weightSumImbalanced from './weight-sum-imbalanced.json' with { type: 'json' }
import weightSumImbalancedExpected from './expected/weight-sum-imbalanced.expected.json' with { type: 'json' }

import weightOutOfRange from './weight-out-of-range.json' with { type: 'json' }
import weightOutOfRangeExpected from './expected/weight-out-of-range.expected.json' with { type: 'json' }

import missingSchemaVersion from './missing-schema-version.json' with { type: 'json' }
import missingSchemaVersionExpected from './expected/missing-schema-version.expected.json' with { type: 'json' }

import emptyFunnels from './empty-funnels.json' with { type: 'json' }
import emptyFunnelsExpected from './expected/empty-funnels.expected.json' with { type: 'json' }

import duplicateFunnelIds from './duplicate-funnel-ids.json' with { type: 'json' }
import duplicateFunnelIdsExpected from './expected/duplicate-funnel-ids.expected.json' with { type: 'json' }

import hypothesisTooShort from './hypothesis-too-short.json' with { type: 'json' }
import hypothesisTooShortExpected from './expected/hypothesis-too-short.expected.json' with { type: 'json' }

import duplicatePageIds from './duplicate-page-ids.json' with { type: 'json' }
import duplicatePageIdsExpected from './expected/duplicate-page-ids.expected.json' with { type: 'json' }

import missingThankYouFullScope from './missing-thank-you-full-scope.json' with { type: 'json' }
import missingThankYouFullScopeExpected from './expected/missing-thank-you-full-scope.expected.json' with { type: 'json' }

import missingThankYouPartialScope from './missing-thank-you-partial-scope.json' with { type: 'json' }
import missingThankYouPartialScopeExpected from './expected/missing-thank-you-partial-scope.expected.json' with { type: 'json' }

import upsellMissingPackages from './upsell-missing-packages.json' with { type: 'json' }
import upsellMissingPackagesExpected from './expected/upsell-missing-packages.expected.json' with { type: 'json' }

import upsellMissingRouting from './upsell-missing-routing.json' with { type: 'json' }
import upsellMissingRoutingExpected from './expected/upsell-missing-routing.expected.json' with { type: 'json' }

import checkoutMissingSuccessUrl from './checkout-missing-success-url.json' with { type: 'json' }
import checkoutMissingSuccessUrlExpected from './expected/checkout-missing-success-url.expected.json' with { type: 'json' }

import upsellWithoutCheckout from './upsell-without-checkout.json' with { type: 'json' }
import upsellWithoutCheckoutExpected from './expected/upsell-without-checkout.expected.json' with { type: 'json' }

import downsellWithoutUpsell from './downsell-without-upsell.json' with { type: 'json' }
import downsellWithoutUpsellExpected from './expected/downsell-without-upsell.expected.json' with { type: 'json' }

import missingShippingMethods from './missing-shipping-methods.json' with { type: 'json' }
import missingShippingMethodsExpected from './expected/missing-shipping-methods.expected.json' with { type: 'json' }

import badShippingCountries from './bad-shipping-countries.json' with { type: 'json' }
import badShippingCountriesExpected from './expected/bad-shipping-countries.expected.json' with { type: 'json' }

import missingCampaignMetadata from './missing-campaign-metadata.json' with { type: 'json' }
import missingCampaignMetadataExpected from './expected/missing-campaign-metadata.expected.json' with { type: 'json' }

import badPackagePricing from './bad-package-pricing.json' with { type: 'json' }
import badPackagePricingExpected from './expected/bad-package-pricing.expected.json' with { type: 'json' }

import orphanOfferRef from './orphan-offer-ref.json' with { type: 'json' }
import orphanOfferRefExpected from './expected/orphan-offer-ref.expected.json' with { type: 'json' }

import exitIntentNonCheckout from './exit-intent-non-checkout.json' with { type: 'json' }
import exitIntentNonCheckoutExpected from './expected/exit-intent-non-checkout.expected.json' with { type: 'json' }

import exitIntentCodeMismatch from './exit-intent-code-mismatch.json' with { type: 'json' }
import exitIntentCodeMismatchExpected from './expected/exit-intent-code-mismatch.expected.json' with { type: 'json' }

import designSourceMalformed from './design-source-malformed.json' with { type: 'json' }
import designSourceMalformedExpected from './expected/design-source-malformed.expected.json' with { type: 'json' }

import assemblyHintsMalformed from './assembly-hints-malformed.json' with { type: 'json' }
import assemblyHintsMalformedExpected from './expected/assembly-hints-malformed.expected.json' with { type: 'json' }

import promoCodesMalformed from './promo-codes-malformed.json' with { type: 'json' }
import promoCodesMalformedExpected from './expected/promo-codes-malformed.expected.json' with { type: 'json' }

import variantLabelsMalformed from './variant-labels-malformed.json' with { type: 'json' }
import variantLabelsMalformedExpected from './expected/variant-labels-malformed.expected.json' with { type: 'json' }

import storeProfileMalformed from './store-profile-malformed.json' with { type: 'json' }
import storeProfileMalformedExpected from './expected/store-profile-malformed.expected.json' with { type: 'json' }

export interface NamedFixture extends Fixture {
  name: string
}

function build(
  name: string,
  spec: unknown,
  expected: unknown,
): NamedFixture {
  return {
    name,
    spec: spec as CampaignSpec,
    expected: expected as { violations: Violation[] },
  }
}

export const corpus: NamedFixture[] = [
  build('single-funnel-basic', singleFunnelBasic, singleFunnelBasicExpected),
  build('two-funnel-with-cycle', twoFunnelWithCycle, twoFunnelWithCycleExpected),
  build('weight-sum-imbalanced', weightSumImbalanced, weightSumImbalancedExpected),
  build('weight-out-of-range', weightOutOfRange, weightOutOfRangeExpected),
  build('missing-schema-version', missingSchemaVersion, missingSchemaVersionExpected),
  build('empty-funnels', emptyFunnels, emptyFunnelsExpected),
  build('duplicate-funnel-ids', duplicateFunnelIds, duplicateFunnelIdsExpected),
  build('hypothesis-too-short', hypothesisTooShort, hypothesisTooShortExpected),
  build('duplicate-page-ids', duplicatePageIds, duplicatePageIdsExpected),
  build('missing-thank-you-full-scope', missingThankYouFullScope, missingThankYouFullScopeExpected),
  build('missing-thank-you-partial-scope', missingThankYouPartialScope, missingThankYouPartialScopeExpected),
  build('upsell-missing-packages', upsellMissingPackages, upsellMissingPackagesExpected),
  build('upsell-missing-routing', upsellMissingRouting, upsellMissingRoutingExpected),
  build('checkout-missing-success-url', checkoutMissingSuccessUrl, checkoutMissingSuccessUrlExpected),
  build('upsell-without-checkout', upsellWithoutCheckout, upsellWithoutCheckoutExpected),
  build('downsell-without-upsell', downsellWithoutUpsell, downsellWithoutUpsellExpected),
  build('missing-shipping-methods', missingShippingMethods, missingShippingMethodsExpected),
  build('bad-shipping-countries', badShippingCountries, badShippingCountriesExpected),
  build('missing-campaign-metadata', missingCampaignMetadata, missingCampaignMetadataExpected),
  build('bad-package-pricing', badPackagePricing, badPackagePricingExpected),
  build('orphan-offer-ref', orphanOfferRef, orphanOfferRefExpected),
  build('exit-intent-non-checkout', exitIntentNonCheckout, exitIntentNonCheckoutExpected),
  build('exit-intent-code-mismatch', exitIntentCodeMismatch, exitIntentCodeMismatchExpected),
  build('design-source-malformed', designSourceMalformed, designSourceMalformedExpected),
  build('assembly-hints-malformed', assemblyHintsMalformed, assemblyHintsMalformedExpected),
  build('promo-codes-malformed', promoCodesMalformed, promoCodesMalformedExpected),
  build('variant-labels-malformed', variantLabelsMalformed, variantLabelsMalformedExpected),
  build('store-profile-malformed', storeProfileMalformed, storeProfileMalformedExpected),
]

export function fixtureByName(name: string): NamedFixture {
  const found = corpus.find((f) => f.name === name)
  if (!found) {
    throw new Error(`Fixture "${name}" not found in corpus. Known: ${corpus.map((f) => f.name).join(', ')}`)
  }
  return found
}
