# SDK 0.4 Migration Proof: HeyShape Snatched Bodysuit

This case is the first complete proof run of the legacy CampaignsJS-to-SDK-0.4
migration workflow against a real merchant campaign with renewed interest.
The campaign had seen little recent use, so it was a suitable low-traffic migration
cell, but the existing production funnel still had to remain untouched while the
work was proved.

The migration is complete on an isolated draft PR and deploy preview. Production
cutover remains pending renewed traffic, merchant timing, and final review.

## Why this case matters

The exercise covered more than replacing a script version. It joined four systems
that have to agree before a campaign can be operated safely by agents:

1. Campaigns App configuration: campaigns, packages, Offers, shipping, payment
   methods, allowed domains, and Campaigns API Keys.
2. Campaign source: checkout, post-purchase pages, receipt pages, routing, SDK
   attributes, custom controllers, and analytics scripts.
3. Campaigns OS proof: synthesized CampaignSpec and Build Packet, current polish
   evidence, rendered browser QA, typed-card order paths, and analytics capture.
4. Independent store truth: Admin API readback of the resulting test orders and
   Offer metadata.

Passing only one of these layers would not have proved the migration.

## Migration shape

Two shadow campaigns, one for the root BOGO flow and one for the V1 quantity flow,
were created so the live Campaigns App records and production funnel could stay
unchanged.

The Campaigns App package model was changed from package-per-quantity pricing to one
base package per product variant. Automatic quantity discounts and coupon-based
checkout/post-purchase pricing moved into Offers. The existing repository was then
linked to the shadow Campaigns API Keys on an isolated branch and migrated to
Campaign Cart SDK `0.4.30`.

The page work included bundle-price synchronization, all Campaign colors, receipt
and routing metadata, seven active post-purchase price surfaces, disabled-payment
residue, billing-field interaction, and custom analytics carryover.

## Harness run

The execution followed the corpus-migration sequence:

`SCAN → SYNTHESIZE → DECIDE → REFACTOR → BUILD → POLISH → PARITY QA → RECORD`

- **SCAN:** read the legacy repository, current live routes, production presentation,
  and Campaigns API data.
- **SYNTHESIZE:** created local CampaignSpecs and Build Packets for both funnel
  families because no saved Campaign Map existed.
- **DECIDE:** selected shadow rebuilds rather than in-place Campaigns App edits so a
  configuration mistake could not change the live funnel dynamically.
- **REFACTOR:** created base packages per product variant and moved pricing behavior
  into automatic and voucher Offers.
- **BUILD:** migrated the existing pages to SDK `0.4.30` while preserving their URLs,
  presentation, custom code, and analytics setup.
- **POLISH:** captured and reviewed desktop/mobile checkout and OTO evidence against
  the exact preview commit.
- **PARITY QA:** ran package-owned Playwright tests, Campaigns OS rendered QA,
  explicit typed-card checkout/OTO paths, receipt analytics capture, and Admin API
  order readback.
- **RECORD:** retained migration notes, local verdicts, test orders, PR review notes,
  and this case record. Production cutover and watch remain future gates.

## Proof results

- `19/19` campaign-specific Playwright tests passed locally and against the deploy
  preview.
- Both final Campaigns OS runs finished `ready_with_exceptions` with zero failures.
- The root proof order traversed accept → decline → accept → receipt. Its total
  was `$141.00`: `$82.00` checkout + `$45.00` coupon-priced Thong OTO + `$14.00`
  Nipple Covers.
- The V1 proof order traversed accept → decline → accept → decline → receipt.
  Its total was `$93.97`: `$29.99` checkout + `$23.99` coupon-priced Bodysuit OTO +
  `$39.99` Sculpting OTO.
- Admin API readback confirmed both records were test orders, belonged to the two
  shadow campaigns, and carried the expected Offer discount metadata.
- Receipt analytics capture observed GTM, TikTok, `dl_purchase`, and GA4 Purchase
  signals on both paths.

Meta remains a manual review item because the deploy-preview origin is outside its
traffic permissions and the pages report duplicate-pixel warnings. TriplePixel is
also manual because the current analytics classifier cannot associate its custom
hosts automatically. Those are review exceptions, not silent passes.

## Failures the proof loop found

### Public `addUpsell()` dropped the coupon

The OTO UI correctly displayed `$90.00 → $45.00`, and unit tests confirmed that the
controller supplied the voucher code. The first real test order still charged
`$90.00`.

SDK `0.4.30`'s public `next.addUpsell()` normalized the `items` field but discarded a
supplied `vouchers` field before the order request. Coupon OTOs were changed to the
SDK's exported typed order-store/API path (`lines`, `currency`, and `vouchers`) while
preserving the standard `upsell:added` event. The next typed-card order charged the
correct `$45.00` and Admin API readback showed the 50% Offer metadata.

This is the strongest lesson from the run: correct UI math and a mocked payload did
not prove the charged order.

### Collapsed billing fields still looked visible to automation

The billing wrapper used height and overflow to appear collapsed, but its child
inputs retained non-zero rectangles. Playwright treated them as visible and the
typed-card runner stalled while filling a field that the shopper could not see.
Using `display: none` for the collapsed state aligned browser automation,
accessibility interaction, and shopper presentation.

### Receipt analytics needed real order context

An analytics capture against the campaign root could not fire Purchase. Capturing
the receipt URL with a real test-order `ref_id` and an adequate settle window allowed
the SDK order store to hydrate and produced `dl_purchase` plus the GA4 Purchase
signal. Migration analytics proof must use the event's actual runtime context.

### Legacy residue and contract gaps were visible

The run also found disabled PayPal markup, an incomplete declarative upsell marker,
and a controller-rendered price that lacked the standard QA selector. The final
verdict still carries honest manual/warning exceptions for legacy template-family
catalog coverage, runtime-derived route links, third-party beacon aborts, Meta, and
TriplePixel.

## Campaigns OS workflow learnings

This case suggests four concrete harness improvements:

1. When a funnel has three or more OTOs, supplement `--test-order common` with an
   explicit path that reaches receipt. A sampled partial path proves its actions but
   not the complete chain.
2. Feed the created test-order receipt URL into analytics correctness automatically,
   instead of defaulting Purchase checks to a campaign root without order context.
3. Add a migration assertion that compares displayed coupon OTO pricing with the
   persisted upsell line price. Payload-shape tests alone are insufficient.
4. Keep synthetic CampaignSpec/local-verdict workflows schema-compatible with the QA
   portal so a migration cell does not lose its shared evidence surface when no Map
   ID existed before the run.

## Why the Campaigns Management API matters

The shadow Campaigns App setup was performed manually. Creating two campaigns,
building one base package for every selected product variant, configuring automatic
and voucher Offers, checking scope and stacking, and copying the resulting Campaigns
API Keys was the slowest and least machine-verifiable part of the run.

A Campaigns Management API would let the harness create or clone the shadow
campaign, bulk-create variant packages, configure Offers, read the configuration
back, and retain idempotent audit evidence before touching page code. Human judgment
would still choose the migration mode and approve cutover. The API would make the
chosen configuration reproducible and reviewable.

The agentic-campaign proof chain is therefore:

`CampaignSpec intent → managed Campaigns configuration → page implementation → real order → analytics and Admin API proof`

The current harness can operate the last three links. HeyShape provides direct
evidence for why Campaigns Management API work is required to close the first two.
