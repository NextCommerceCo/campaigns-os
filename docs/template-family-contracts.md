# Template Family Contracts

Campaigns OS treats starter-template family contracts as deterministic build,
doctor, polish, and QA inputs. The commerce structure contract lives in
`contracts/commerce-surface-catalog.json`; the brand/residue/pricing/exit-pop
contract for each promoted family lives in
`contracts/template-brand-contract.<family>.v0.json`.

Every promoted catalog family must declare:

- supported pages and required SDK anchors
- brand-theme insertion point after `next-core.css`
- starter color/logo/payment residue to detect
- pricing presentation modes and forbidden CSS price hiding
- bundle picker, order-bump, upsell/downsell, and exit-pop behavior
- QA selectors and invariants used by browser QA

## Inventory Matrix

| Family | Pages | Bundle Picker | Order Bump | Upsell/Downsell | Exit Pop | Key QA Invariants |
| --- | --- | --- | --- | --- | --- | --- |
| `olympus` | landing, presell, checkout, upsell, receipt | Tiered cards with `data-next-bundle-selector` / `data-next-bundle-card` | `bump-check01.html` / `bump-switch01.html`; valid only with prepurchase packages | Bundle stepper, tier pills, and tier cards; visible price above accept CTA | Include exists but is not default; strip unless CampaignSpec maps `exit_intent` / `promo_code_input` | `.checkout-wrapper`, `.submit-button`, `.os-card.next-selected`, visible `.price-wrapper`, branded `.brand-logo` |
| `limos` | landing, presell, checkout, upsell, receipt | Quantity-stepper single offer with `data-next-bundle-qty-for` | Optional bump variants; remove without prepurchase packages | Offer and bundle-tier includes; visible price above accept CTA | Default checkout include; strip or wire SDK coupon path when CampaignSpec has no offer surface | Limos checkout shell, `.submit-button`, visible `.price-wrapper`, branded `.brand-logo`, no ungoverned `.exit-intent-popup` |
| `demeter` | landing, presell, checkout, upsell, receipt | Editorial tier cards with `data-next-bundle-card` | Side-summary bump variants; remove without prepurchase packages | Offer and bundle-tier includes; visible price above accept CTA | Include exists but is not default; strip unless CampaignSpec maps an offer/code | Demeter checkout shell, `.submit-button`, selected card color, visible prices, branded logo |
| `shop-single-step` | landing, presell, checkout, upsell, receipt | No default tier picker; cart summary/payment shell is protected | `bump-check02.html`; remove without a bump package | Shop upsell includes; visible price above accept CTA | Include exists but is not default; strip unless CampaignSpec maps an offer/code | Shop checkout shell, payment geometry, `.cart-price`, visible upsell price, branded logo |
| `olympus-mv-single-step` | landing, presell, checkout, upsell, receipt | Single-page configurable MV selector with `variant_slots` | Optional bump variants; no line-total sync unless specified | MV and bundle upsells; visible price rows | Include exists but is not default; strip unless CampaignSpec maps an offer/code | MV checkout shell, slot anchors, selected card state, visible prices, branded logo |
| `olympus-mv-two-step` | landing, presell, select, checkout, upsell, receipt | Select page chooses cart/package; checkout resolves MV slots | Optional bump variants; no line-total sync unless specified | MV and bundle upsells; visible price rows | Include exists but is not default; strip unless CampaignSpec maps an offer/code | Select + checkout structure, slot anchors, selected state, visible prices, branded logo |
| `shop-three-step` | landing, presell, information, shipping, billing, upsell, receipt | No checkout bundle picker; multi-step shop flow | No promoted order-bump contract yet | Inline refs plus mapping hints until fully promoted; replace both | No promoted include; copied exit widgets are residue unless CampaignSpec maps an offer/code | Dynamic shipping via `window.next.getShippingMethods()`, billing payment shell, visible upsell price, branded logo |

## Pricing Rules

Declared pricing modes are `full_price`, `compare_at_current`,
`unit_price_plus_total`, `savings_badge_amount`, and
`code_discounted_post_checkout`. Legacy aliases in older templates map to these
contract modes.

If no offer, voucher, compare-at value, or code-discounted post-checkout state
governs an order bump, upsell, or downsell, render `full_price` only. Do not
show identical struck-through/current prices, and do not hide unwanted price
rows with campaign CSS.

## Exit-Pop Rules

Exit-pop and promo-code widgets apply offers; they do not own pricing truth. If
CampaignSpec checkout pages do not declare `exit_intent.enabled` or
`promo_code_input.enabled`, default or copied exit-pop widgets must be stripped
or reported as residue. If CampaignSpec does declare the surface, the widget
must apply the mapped code through the SDK/API coupon path and render applied
state through SDK conditionals such as `cart.hasCoupon("CODE")`.
