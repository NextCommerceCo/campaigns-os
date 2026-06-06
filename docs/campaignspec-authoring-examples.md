# CampaignSpec Authoring Examples

Use these examples when authoring or generating common Campaign Map shapes. They
are public-package guidance: the goal is clearer exported CampaignSpec fields,
not a private merchant workflow.

## Hero Product + Order Bump + Upsell + Receipt

Reference fixture:

```text
contracts/fixtures/campaign-specs/shop-single-step-upsell-receipt.json
```

Canonical page shape:

```text
checkout -> upsell -> receipt
```

Authoring guidance:

- Checkout page:
  - `type: "checkout"`
  - `page_url: "/checkout/"`
  - `packages[]` includes one `role: "main"` package and optional
    `role: "order_bump"` package.
  - `sdk_hints.template_family` names the intended starter family only as a
    hint; the Build Packet still locks the family.
  - `sdk_hints.meta_tags.next-success-url` points to the next runtime route.

- Upsell page:
  - `type: "upsell"` or `type: "downsell"`
  - `page_url` is a Page Kit route, not a source filename.
  - `packages[]` or `offers[]` names the post-purchase offer refs.
  - `on_accept` and `on_decline` point to the next CampaignSpec route.

- Receipt page:
  - `type: "thankyou"` or `type: "receipt"`
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

## Order Bump Notes

An order bump is still a checkout package/offer surface. It should be encoded as
a checkout page package/offer with an explicit role, quantity, and source ref.
When the selected starter family does not support a bump, the build should
remove the bump surface and record the decision in the Assembly Report instead
of leaving demo bump refs in copied frontmatter.

## Multi-Upsell Depth

For more than one post-purchase page, keep each upsell/downsell page explicit in
`funnels[].pages[]` and wire `on_accept` / `on_decline` to the next page. QA
then derives typed-card proof depth from topology: `common` for everyday
checkout plus first accept/decline coverage, explicit paths for targeted repair,
and `full` for every accept/decline permutation.
