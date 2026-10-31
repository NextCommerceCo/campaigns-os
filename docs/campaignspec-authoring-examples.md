# CampaignSpec Authoring Examples

Use these examples when authoring or generating common Campaign Map shapes. They
are public-package guidance: the goal is clearer exported CampaignSpec fields,
not a private merchant workflow.

## Hero Product + Order Bump + Upsell + Receipt

Reference fixture: [single-step checkout, upsell and receipt](https://github.com/NextCommerceCo/campaigns-os/blob/main/contracts/fixtures/campaign-specs/shop-single-step-upsell-receipt.json).
Fixtures are repository test data and are not included in the installed package.

For CampaignSpec 5.0 multi-step shapes, compare the [three-step checkout](https://github.com/NextCommerceCo/campaigns-os/blob/main/contracts/fixtures/campaign-specs/shop-three-step-dynamic-shipping.json)
and [select-to-checkout](https://github.com/NextCommerceCo/campaigns-os/blob/main/contracts/fixtures/campaign-specs/olympus-mv-two-step-configurable.json) examples.
Author new specs against the shipped [v5 schema](../schemas/campaign-spec.v5.schema.json).

Canonical page shape:

```text
checkout -> upsell -> receipt
```

Authoring guidance:

- Checkout page:
  - `type: "checkout"` with `sdk_hints.sdk_page_type: "checkout"`
  - `page_url: "/checkout/"` — `page_url` is the route field.
  - `packages[]` entries use `ref_id` + `qty` (the real export key is `qty`,
    not `quantity`). A plain entry is the main package; add-ons carry the
    boolean role flags `is_order_bump: true` / `is_upsell: true` — there is
    no `role` field in exports. The flags mean "add-on" on `checkout`,
    `checkout_step` and `select` pages only. On an upsell or downsell page
    they mark nothing (see the upsell page below).
  - `sdk_hints.template_family` names the intended starter family only as a
    hint; the Build Packet still locks the family.
  - `sdk_hints.meta_tags.next-success-url` points to the next runtime route.
  - `success_url` holds the next PAGE ID (never a URL, despite the name).
  - A checkout may equally declare its forward step as `next_page`; twelve
    pages across ten certified fixtures do. Forward links resolve from
    whichever routing field a page declares — `on_accept`, then `success_url`,
    then `next_page` — so an unconventional journey is wired rather than
    dropped.
  - `next_page` is the generic "wherever this page goes next" and is honoured on
    every page type. The other two forward fields carry a page-shaped meaning
    and are honoured only where that meaning exists:
    - `success_url` means "after payment succeeds" — only on `type: "checkout"`.
    - `on_accept` means "after accepting the offer on this page" — only on
      `type: "upsell"` or `"downsell"`.

    Declared anywhere else they are inert, `next_page` wins, and the
    `RouteFieldIgnoredForPageType` warning says which field was skipped and
    where the shopper actually goes. A `select` page is the first step of a
    two-step checkout and a `checkout_step` is a non-final page of a split
    checkout: neither takes payment nor presents an accept/decline offer, so a
    copy-pasted `success_url` or `on_accept` there does not route.
  - Multi-step checkout (CampaignSpec 5.0): `checkout` is the page that takes
    payment, and it forwards to an upsell, downsell or thank-you page. A page
    with a checkout form that collects details and moves on without placing an
    order is `type: "checkout_step"` and routes with `next_page`; a bundle
    picker before checkout is `type: "select"`. Every path from an entry page
    to an upsell passes exactly one `checkout`; a campaign may hold several, one
    per split-test path. A 4.2/4.3 spec that chained `checkout → checkout` is
    read as `checkout_step` pages ahead of the last one.
    See the [v5 schema](../schemas/campaign-spec.v5.schema.json) for the
    authoring fields; runtime routing is projected by Campaigns OS.

- Upsell page:
  - `type: "upsell"` or `type: "downsell"`, with
    `sdk_hints.sdk_page_type: "upsell"`
  - `page_url` is a Page Kit route, not a source filename.
  - `packages[]` or `offers[]` names the post-purchase offer refs. Write each
    package as a plain `{ ref_id, qty }` entry. On an upsell or downsell page
    every package row is the page's offer and never an order bump, so
    `is_upsell: true` on that row is accepted and changes nothing about
    its role. Offers are identified by `ref_id` into the root `offers[]` catalog
    (`package_ref_id` is not part of the contract).
  - `on_accept` and `on_decline` hold the next PAGE IDs; route paths live
    in `page_url` / derived `resolved_routing`.

- Receipt page:
  - `type: "thankyou"` — the canonical terminal page type. The SDK-layer
    `receipt` projection is expressed as `sdk_hints.sdk_page_type: "receipt"`
    (and `meta_tags["next-page-type"]`), never as `page.type`.
  - `page_url: "/receipt/"`
  - Receipt summary/frontmatter hints preserve SDK-owned order item templates.

Generator checklist:

- Always emit stable `page.id` values; page IDs are the join key for
  `source_html.pages[]`.
- Prefer Page Kit public routes (`checkout/`, `upsell/`, `receipt/`) over
  filenames (`checkout.html`).
- Keep package, shipping, voucher, and offer refs in CampaignSpec/API fields,
  not in source HTML.
- Put template-family preference in `campaign.preferred_template_family` when
  useful, but require the Build Packet/template lock before commerce wiring.
- Keep checkout/upsell/downsell/receipt runtime surfaces template-clone-first;
  source HTML can own visual composition and copy, not payment/order mutation.

## Campaign Currencies

- `campaign.currency` is the default currency: a three-letter upper-case
  ISO 4217 code such as `"USD"`. A lower-case code (`"usd"`) or a symbol
  (`"US$"`) is an error, because Campaign Cart can fall back to a cached USD
  campaign and price the page in the wrong currency.
- `campaign.available_currencies` lists every currency the campaign sells in,
  the default included, as code strings: `["USD", "EUR", "GBP"]`. The
  Campaigns API returns this list as `{ code, label }` objects; Map Builder
  writes the codes, and a hand-written spec should too.
- The Campaigns App API also has `additional_currencies`, which is the same
  list without the default. It is not a CampaignSpec field: put every
  currency in `available_currencies`.
- When `available_currencies` is non-empty and does not contain
  `campaign.currency`, the validator warns. An empty list states nothing and
  is not checked.

These checks are the `CampaignCurrencies` validator rule, which
`campaigns-os doctor` runs with the rest of the spec rules.

A page package row can also carry its price in each currency, as `prices[]`:

```json
{
  "ref_id": 101, "qty": 1, "price": "49.99", "price_retail": "79.99",
  "prices": [
    { "currency": "USD", "price": "49.99", "price_retail": "79.99" },
    { "currency": "EUR", "price": "46.99", "price_retail": "74.99" }
  ]
}
```

- `price` and `price_retail` stay the default currency's. Each `prices[]`
  entry has a `currency` code and a `price`, plus `price_retail` and, for a
  subscription package, `price_recurring` when the Campaigns App has them.
- The values come from the Campaigns API read in each currency
  (`GET /campaigns/?currency=EUR`). That read returns only the packages the
  Campaigns App has a price for in that currency, so a package with no EUR
  price is missing from the campaign for a shopper paying in EUR. Map Builder
  fills `prices[]` when it refreshes from the API; set prices in the
  Campaigns App, not in the spec. `campaigns-os spec derive` refreshes `price`
  and `price_retail` from one default-currency read and leaves `prices[]` as
  it was, so after changing a non-default price, refresh the Map in Map
  Builder.
- `prices[]` is optional. A row without it says nothing about other
  currencies and is not checked. A row with it should list every currency in
  `available_currencies` and `campaign.currency`; the `PackageCurrencyPrices`
  rule warns on a missing currency, a malformed entry and a currency listed
  twice.

## Order Bump Notes

An order bump is still a checkout package/offer surface. It should be encoded as
a checkout page package with `is_order_bump: true`, a `qty`, and its source
`ref_id`.
When the selected starter family does not support a bump, the build should
remove the bump surface and record the decision in the Assembly Report instead
of leaving demo bump refs in copied frontmatter.

## Multi-Upsell Depth

For more than one post-purchase page, keep each upsell/downsell page explicit in
`funnels[].pages[]` and wire `on_accept` / `on_decline` to the next page. QA
then derives typed-card proof coverage from topology. `common` runs every
actual terminal path when they fit under the flood cap; above it, it runs
checkout, first-offer accept and decline, and a deduplicated shortest real
receipt path, then adds the shortest path that clicks the decline on each offer
or downsell page not yet declined, up to the cap. Explicit paths support targeted
repair, while `full` walks every actual terminal path in the selected checkout
topology. Cycles, missing routes, and reachable nonterminals block exhaustive
proof before browser launch. The accidental-flood cap remains `6`; when the
planned count exceeds it, the command names the exact explicit
`--max-test-orders` raise.
