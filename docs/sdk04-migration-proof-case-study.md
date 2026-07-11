# SDK 0.4 Migration Proof Case Study

This case study records a complete SDK 0.4 migration proof run against a
low-traffic legacy campaign. Renewed interest made the campaign worth upgrading,
but the existing production funnel still had to remain unchanged while the work was
tested.

The migration was completed on an isolated draft branch and deploy preview.
Production cutover and post-cutover watch remained separate gates.

## Why this case matters

The exercise covered more than replacing a script version. Four layers had to agree
before the migration could be considered proved:

1. Campaign configuration: packages, Offers, shipping, payment methods, allowed
   domains, and checkout API access.
2. Campaign source: checkout, post-purchase pages, receipt pages, routing, SDK
   attributes, custom controllers, and analytics scripts.
3. Campaigns OS evidence: synthesized CampaignSpec and Build Packet, current polish
   evidence, rendered browser QA, typed-card order paths, and analytics capture.
4. Independent store truth: readback of the resulting test orders and applied Offer
   metadata.

Passing only one layer would not have proved the migration.

## Migration shape

New shadow configuration records were created so the live records and production
funnel could stay unchanged. The package model moved from package-per-quantity
pricing to one base package per product variant. Automatic quantity discounts and
coupon-based checkout or post-purchase pricing moved into Offers.

The existing pages were linked to the shadow checkout API credentials and migrated
to SDK `0.4.30`. The work covered bundle-price synchronization, variant coverage,
receipt and routing metadata, active post-purchase price surfaces, disabled-payment
residue, billing-field interaction, and custom analytics carryover.

## Harness run

The execution followed this sequence:

`SCAN → SYNTHESIZE → DECIDE → REFACTOR → BUILD → POLISH → PARITY QA → RECORD`

- **SCAN:** read the legacy repository, current live routes, production
  presentation, and checkout API data.
- **SYNTHESIZE:** created local CampaignSpecs and Build Packets because no saved
  Campaign Map existed.
- **DECIDE:** selected shadow rebuilds rather than in-place configuration edits so a
  mistake could not change the live funnel dynamically.
- **REFACTOR:** created base packages per product variant and moved pricing behavior
  into automatic and voucher Offers.
- **BUILD:** migrated the existing pages to SDK `0.4.30` while preserving their URLs,
  presentation, custom code, and analytics setup.
- **POLISH:** captured and reviewed desktop and mobile checkout and post-purchase
  evidence against the exact preview commit.
- **PARITY QA:** ran package-owned Playwright tests, Campaigns OS rendered QA,
  explicit typed-card checkout and post-purchase paths, receipt analytics capture,
  and independent order readback.
- **RECORD:** retained migration notes, local verdicts, test-order evidence, and
  review notes. Production cutover and watch remained future gates.

## Proof results

- The campaign-specific Playwright suite passed locally and against the deploy
  preview.
- Both final Campaigns OS runs finished `ready_with_exceptions` with zero failures.
- Explicit accept and decline paths traversed every post-purchase step and reached
  the receipt.
- Persisted order readback confirmed that checkout lines and accepted
  post-purchase lines carried the expected prices and Offer metadata.
- Receipt analytics capture observed the declared tag manager, purchase dataLayer,
  and analytics Purchase signals.

Custom third-party pixels that could not run or be classified reliably on the
preview origin remained manual review items. The verdict did not convert those gaps
into silent passes.

## Failures the proof loop found

### The displayed coupon price did not initially match the order

The post-purchase UI displayed the expected coupon price, and a controller test
confirmed that the voucher code was supplied. The first real test order still
charged the base price.

The public SDK upsell helper normalized the selected items but did not forward the
voucher field used by this custom controller. The migration was repaired to send the
typed order-store payload while preserving the standard SDK event. A second
typed-card order charged the expected price and carried the Offer metadata.

Correct UI math and a mocked payload did not prove the charged order.

### Collapsed billing fields still looked visible to automation

The billing wrapper used height and overflow to appear collapsed, but its child
inputs retained non-zero rectangles. Playwright treated them as visible and the
typed-card runner stalled while filling a field that the shopper could not see.
Using `display: none` for the collapsed state aligned browser automation,
accessibility interaction, and shopper presentation.

### Receipt analytics needed real order context

An analytics capture against the campaign root could not fire Purchase. Capturing
the receipt URL with a real test-order reference and an adequate settle window
allowed the SDK order store to hydrate and produced the expected Purchase signals.
Migration analytics proof must use the event's actual runtime context.

### Legacy residue and contract gaps were visible

The run also found disabled payment markup, an incomplete declarative upsell marker,
and a controller-rendered price that lacked the standard QA selector. The final
verdict retained honest manual or warning exceptions for legacy template-family
catalog coverage, runtime-derived route links, and third-party beacon behavior.

## Campaigns OS workflow learnings

This case suggests four concrete harness improvements:

1. When a funnel has three or more post-purchase steps, supplement
   `--test-order common` with an explicit path that reaches receipt. A sampled partial
   path proves its actions but not the complete chain.
2. Feed the created test-order receipt URL into analytics correctness automatically,
   instead of defaulting Purchase checks to a campaign root without order context.
3. Add a migration assertion that compares displayed coupon pricing with the
   persisted post-purchase line price. Payload-shape tests alone are insufficient.
4. Keep synthetic CampaignSpec and local-verdict workflows schema-compatible with
   the QA portal so a migration cell retains a shared evidence surface when no Map ID
   existed before the run.

## Reusable proof chain

The case demonstrates the evidence sequence expected from an SDK migration:

`CampaignSpec intent → campaign configuration → page implementation → real test order → analytics and order readback`

Campaigns OS owns the implementation and proof stages. Production cutover remains a
separate human-controlled decision.
