/**
 * Type surface for the CampaignSpec contract layer.
 *
 * The CampaignSpec is the central authoring contract of this repo (see
 * ../CONTEXT.md). v4.3 is the authoring shape; v4.2 funnels[] is the canonical
 * internal shape that rules operate on (after normalize()).
 *
 * Types here are intentionally permissive on optional fields — the rule
 * registry catches missing/malformed fields, rather than the type system
 * refusing to compile against in-progress Map Builder drafts.
 */

// ── Severity ──────────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning'

// ── Tag (closed taxonomy) ─────────────────────────────────────────────────
//
// Add new tags here AND in ../CONTEXT.md so the documented vocabulary stays
// in sync. Closed set is intentional: typos caught at compile time, callers
// can rely on the tag set, no open-string drift.

export type Tag =
  | 'fast'                       // cheap; safe for per-keystroke contexts
  | 'structure'                  // funnel topology, routing, cycle detection
  | 'references'                 // offer catalog refs, cross-funnel page refs
  | 'meta-tags'                  // sdk_hints.meta_tags completeness
  | 'tracking'                   // campaign.tracking field checks
  | 'spec-only'                  // no live deployment needed
  | 'requires-complete-spec'     // skip when Map Builder draft is mid-edit

// ── Rule and Violation ────────────────────────────────────────────────────

/**
 * A rule's structured output. One shape across every consumer (Map Builder
 * field-level UI, QA verdict, CLI output, compiler exceptions).
 *
 * `path` is a JSON Pointer locator into the normalized spec, e.g.
 * "/funnels/0/pages/2/route". Enables field-level UI without rule-specific
 * wiring.
 *
 * `data` carries rule-specific structured detail (e.g. CycleDetection
 * includes the offending cycle's page IDs).
 */
export interface Violation {
  ruleId: string
  severity: Severity
  message: string
  path: string
  data?: Record<string, unknown>
}

/**
 * The unit of composition for spec validation.
 *
 * Pure: takes only a normalized CampaignSpec, returns Violations. No context
 * bag, no live data dependency. Mode flags become tag filters at the call
 * site; rule parameters bind at registration time.
 *
 * `severity` is the rule's default. Individual violations can override
 * (e.g. CycleDetection emits warnings for self-loops, errors for multi-page
 * cycles).
 */
export interface Rule {
  id: string
  severity: Severity
  tags: Tag[]
  check(spec: CampaignSpec): Violation[]
}

/** A `Rule[]`. Compose with plain array operations. */
export type RuleSet = Rule[]

// ── CampaignSpec (canonical v4.2 funnels[] shape) ─────────────────────────
//
// Permissive types: rules catch malformed fields, the type system doesn't.
// Anything optional here is a candidate for a rule check.

export type PageType =
  | 'presell'
  | 'landing'
  | 'checkout'
  | 'upsell'
  | 'downsell'
  | 'thankyou'

/**
 * Offer condition/benefit blocks, as exported by the Map Builder. Both share
 * the { type, value, description } shape (e.g. condition
 * `{ type: 'count', value: 2 }`, benefit
 * `{ type: 'package_percentage', value: '20.00' }`).
 */
export interface OfferCondition {
  type?: string
  value?: number | string | null
  description?: string | null
  [key: string]: unknown
}

export interface OfferBenefit {
  type?: string
  value?: number | string | null
  description?: string | null
  [key: string]: unknown
}

export interface PageOffer {
  ref_id: string | number
  code?: string | null
  name?: string | null
  type?: string
  condition?: OfferCondition
  benefit?: OfferBenefit
  [key: string]: unknown
}

export interface PagePackage {
  ref_id?: string | number
  /**
   * Package quantity. The real export key is `qty` (206/211 real package
   * entries) — NOT `quantity`, which never appears in exports.
   */
  qty?: number
  name?: string | null
  price?: number | string | null
  price_retail?: number | string | null
  product_name?: string | null
  product_sku?: string | null
  product_variant_name?: string | null
  product_purchase_availability?: string | null
  product_inventory_availability?: string | null
  image?: string | null
  /**
   * Boolean role trio. There is no `role` field in real exports — a
   * package's role is expressed by is_upsell / is_order_bump /
   * default_selected flags (absent means a main package).
   */
  is_upsell?: boolean
  is_order_bump?: boolean
  default_selected?: boolean
  variant_attributes?: Array<{
    code?: string
    name?: string
    value?: string
    [key: string]: unknown
  }>
  is_recurring?: boolean
  price_recurring?: number | string | null
  interval?: string | null
  interval_count?: number | null
  [key: string]: unknown
}

export interface ExitIntent {
  enabled?: boolean
  offer_ref_id?: string | number
  offer_code?: string
  [key: string]: unknown
}

export interface PromoCodeInput {
  enabled?: boolean
  mode?: 'mapped_offer' | string
  offer_ref_id?: string | number
  offer_code?: string
  [key: string]: unknown
}

/**
 * Pointer to the design artifact that supplies the prepared HTML for this
 * page. Read by figma-sections-export (and future design-tool exporters) to
 * locate the source frames; read by campaigns-os doctor to decide whether a
 * missing source-html manifest is "designer hasn't exported yet" (blocker
 * with run-export-first guidance) vs. plain `collect-inputs`.
 *
 * Today `figma` is the only supported `type`; the field is structured this
 * way so future tools (Penpot, Sketch, hand-authored HTML, AI-generated)
 * slot in without a schema break.
 *
 * `file_url` is the design-tool file URL (canonical identity of the file).
 * `breakpoints` carry per-viewport pointers — for Figma, these are selection
 * URLs that already encode node IDs, which is what designers copy via
 * "Copy link to selection". Empty/missing breakpoints are valid during
 * draft authoring; rules surface incompleteness as warnings, not errors.
 */
export interface DesignSourceBreakpoints {
  desktop?: string
  tablet?: string
  mobile?: string
  [key: string]: unknown
}

export interface DesignSource {
  type: 'figma' | string
  file_url: string
  breakpoints?: DesignSourceBreakpoints
  notes?: string
  [key: string]: unknown
}

/**
 * Per-page hint declaring which UI variant the build should render this
 * page as. Today only upsell pages have meaningful variants: the
 * olympus-mv-single-step family ships with `mv` (multi-quantity tier
 * pills), `bundle_tier_pills`, `bundle_tier_cards`, and a `single`
 * fallback, but the spec previously carried no way to declare which one
 * each OTO should use, forcing per-page decisions at build time.
 *
 * Like preferred_template_family, this is a HINT — the build agent
 * uses it as the default when no per-page override is given. CLI args
 * and operator overrides win.
 *
 * Open-string at the type level so future template patterns slot in
 * without a schema break; validation rule narrows to the known set.
 */
export type UpsellTemplatePattern =
  | 'mv'
  | 'bundle_tier_pills'
  | 'bundle_tier_cards'
  | 'single'
  | (string & {})

/**
 * Per-page MV upsell tier range. Pairs with `upsell_template_pattern: 'mv'`
 * (or any tier-based variant) to declare the inclusive `{min, max}`
 * quantity-tier range the page should render.
 *
 * Slice 4b context: the olympus-mv-single-step family ships with a fixed
 * pill ladder but the spec previously carried no way to declare which
 * subset each OTO should render.
 * Author-time: "Upsell 1 ranges 1-5, Upsell 2 ranges 2-4". Build agent
 * reads the range to scope the pill set; the source HTML's static
 * markup is overridden when the hint disagrees.
 *
 * HINT semantics match the other authoring-time fields: validation
 * warns when shape is malformed or `min > max`, but never blocks a
 * build. Hand-authored or operator-supplied tier counts at build time
 * still win.
 */
export interface UpsellMvTiers {
  min: number
  max: number
  [key: string]: unknown
}

/**
 * Per-page MV upsell variant column labels. Used by template families
 * that render multi-attribute variant tables (olympus-mv-single-step
 * tier-cards) where columns map to product attributes like size,
 * color, or flavor. The starter HTML often assumes two columns —
 * single-attribute products (size-only, color-only) end up with an
 * empty second column.
 *
 * Slice 4e context: declare `{primary: "Size"}` and the build drops
 * the second column; declare `{primary: "Size", secondary: "Color"}`
 * and both columns render with the spec-declared labels. HINT
 * semantics: warning-severity validation, never blocks a build,
 * CLI/operator overrides at build time win.
 */
export interface VariantLabels {
  primary: string
  secondary?: string
  [key: string]: unknown
}

/**
 * Per-funnel promo-code roster. Replaces the hardcoded `sales` array
 * in the starter templates' promo-banner.js / promo-timer.js so each
 * merchant carries their own seasonal calendar in the spec rather
 * than inheriting demo defaults.
 *
 * Slice 4c context: every campaign ships with the demo SUMMER26 /
 * BF26 / etc. codes burned into promo-banner.js source. The
 * build-side replacement step (next-campaigns-build skill addendum)
 * reads `funnels[].promo_codes` and regenerates the sales array in
 * the assembled JS.
 *
 * Per-funnel scope: A/B funnels can run different rosters. `id` and
 * `code` are required identity; visual presentation fields are
 * optional and mirror the existing template shape so the build can
 * do a clean array replace. `starts_at` / `ends_at` are ISO date
 * strings — missing means "active whenever selected." Array order
 * decides priority (first matching date range wins).
 */
export interface PromoCode {
  id: string
  code: string
  starts_at?: string
  ends_at?: string
  title?: string
  emoji?: string
  offer1?: string
  offer2?: string
  top_bar_bg?: string
  highlight_color?: string
  banner_text?: string
  banner_text_sec?: string
  limited_time?: string
  [key: string]: unknown
}

/**
 * SDK-layer page type projection. `thankyou` is the canonical terminal
 * page.type; `receipt` is its SDK projection and lives HERE (and in
 * meta_tags["next-page-type"]), never in page.type. Observed values across
 * the real corpus: product, checkout, upsell, receipt.
 */
export type SdkPageType = 'product' | 'checkout' | 'upsell' | 'receipt'

/**
 * Per-page SDK hints. Real export subkeys are `sdk_page_type` + `meta_tags`
 * ONLY. `frontmatter` and `template_family` are template-handoff extensions
 * carried by the contracts/fixtures/campaign-specs agent-contract fixtures
 * (and blessed as optional extensions by schemas/campaign-spec.v4.schema.json);
 * they are not Map Builder export fields.
 */
export interface SdkHints {
  sdk_page_type?: SdkPageType
  meta_tags?: Record<string, string>
  frontmatter?: Record<string, unknown>
  template_family?: string
  [key: string]: unknown
}

/**
 * DERIVED routing projection (present on 135/195 real pages). The declared
 * routing fields (next_page / on_accept / on_decline / success_url) hold
 * PAGE IDS in every real occurrence; this object is where the corresponding
 * route paths (`*_route`, trailing-slash) and filenames (`*_filename`,
 * route path or legacy .html) live.
 */
export interface ResolvedRouting {
  accept?: string
  decline?: string
  success?: string
  next_page?: string
  accept_route?: string
  decline_route?: string
  success_route?: string
  next_page_route?: string
  accept_filename?: string
  decline_filename?: string
  success_filename?: string
  next_page_filename?: string
  [key: string]: unknown
}

/** Per-page design pointers (93/195 real pages). */
export interface DesignHooks {
  figma_frame_url?: string | null
  component_slots?: unknown
  [key: string]: unknown
}

export interface Page {
  id: string
  type: PageType
  label?: string
  order?: number
  /** True on funnel entry pages (178/195 real pages carry the flag). */
  is_entry?: boolean
  /**
   * Authored route field: usually a trailing-slash route path
   * ("checkout/"), occasionally empty, a bare token, or a legacy .html
   * filename. This — not the declared routing fields — is where authored
   * route paths live.
   */
  page_url?: string
  // Routing fields. Which are valid depends on `type`; rules enforce.
  // All four hold PAGE IDS in real exports — success_url never holds a URL
  // despite its name. Route paths live in `resolved_routing` / `page_url`.
  next_page?: string
  success_url?: string
  on_accept?: string
  on_decline?: string
  resolved_routing?: ResolvedRouting
  // Optional content
  packages?: PagePackage[]
  offers?: PageOffer[]
  exit_intent?: ExitIntent
  promo_code_input?: PromoCodeInput
  sdk_hints?: SdkHints
  design_hooks?: DesignHooks
  design_source?: DesignSource
  /**
   * Per-page UI variant hint. Meaningful only on upsell-type pages
   * today; on non-upsell pages the validation rule warns.
   */
  upsell_template_pattern?: UpsellTemplatePattern
  /**
   * Per-page MV upsell tier range. Pairs with the `mv` UI pattern (or any
   * tier-based variant) to declare the inclusive `{min, max}` quantity-tier
   * range the build should render. Meaningful on upsell pages; validation
   * warns when set elsewhere or when shape is malformed.
   */
  upsell_mv_tiers?: UpsellMvTiers
  /**
   * Per-page MV upsell variant column labels (Slice 4e). Meaningful
   * only on upsell pages today; validation warns when set elsewhere
   * or when primary is missing/empty.
   */
  variant_labels?: VariantLabels
  [key: string]: unknown
}

export interface Funnel {
  id: string
  name?: string
  hypothesis?: string
  weight?: number
  pages?: Page[]
  /**
   * Per-funnel promo-code roster (Slice 4c). The build-side
   * replacement step regenerates promo-banner.js / promo-timer.js
   * sales arrays from this list when present.
   */
  promo_codes?: PromoCode[]
  [key: string]: unknown
}

/** A package nested under a root offer (package_id identity). */
export interface OfferPackage {
  package_id?: number | string
  package_name?: string | null
  package_image?: string | null
  product_name?: string | null
  product_variant_name?: string | null
  unit_price?: number | string | null
  unit_price_before_discount?: number | string | null
  package_price?: number | string | null
  package_price_before_discount?: number | string | null
  package_unit_qty?: number | null
  [key: string]: unknown
}

/**
 * Root offer catalog entry. `ref_id` is the SOLE offer identity — all 236
 * real offer occurrences use ref_id (+ code, often null, + name). A
 * `package_ref_id` key never appears in real exports and is not part of
 * the contract; offer→package links are the nested `packages[]` with
 * package_id identity.
 */
export interface Offer {
  ref_id: string | number
  code?: string | null
  name?: string | null
  type?: string
  condition?: OfferCondition
  benefit?: OfferBenefit
  packages?: OfferPackage[]
  /** Offer-scoped shipping method pricing. */
  shipping_methods?: unknown[]
  [key: string]: unknown
}

/**
 * Optional hint declaring which starter template family the campaign was
 * authored against. Doctrine: template family is a build-time decision,
 * not a spec-time decision; this field is a HINT that the build agent
 * uses as the default when no `--template-family` CLI override is given.
 *
 * Pre-Slice 4a, this field already existed as an undocumented convention
 * read by campaigns-os/src/cli.mjs preferredTemplateFamily(); Slice 4a
 * blesses it in the schema, adds Map Builder UI to author it, and adds
 * a validation rule that warns if the value isn't a recognized family.
 *
 * Operators / agents always retain veto power via `--template-family`;
 * the hint never silently locks the build.
 *
 * Known families track the Campaigns OS starter-template catalog —
 * keep these in sync if the catalog grows.
 */
export type TemplateFamilyHint =
  | 'olympus'
  | 'limos'
  | 'demeter'
  | 'arjuna'
  | 'olympus-mv-single-step'
  | 'olympus-mv-two-step'
  | 'shop-single-step'
  | 'shop-three-step'
  | (string & {}) // accept future families without TS errors

/**
 * One entry of the object-shaped available_shipping_countries variant
 * (`{ code, label }` pairs — 5/33 real specs).
 */
export interface ShippingCountry {
  code?: string
  label?: string
  [key: string]: unknown
}

export interface Campaign {
  ref_id?: number | string
  /** Campaign slug-style identifier (28/33 real specs), distinct from ref_id. */
  id?: string
  name?: string
  slug?: string
  currency?: string
  language?: string
  /** Public-by-design, domain-allowlisted Campaigns API key. */
  campaigns_api_key?: string | null
  available_payment_methods?: unknown[]
  available_express_payment_methods?: unknown[]
  available_currencies?: string[]
  /**
   * Public route root the campaign is served under. `'/'` declares a
   * ROOT-SERVED campaign: the whole funnel lives at site-root paths
   * (`/checkout-v2`, `/receipt`) with no slug prefix — e.g. a single-campaign
   * site whose deploy publishes the funnel at the domain root. When absent,
   * consumers default to `'/<slug>/'`. `slug` stays required identity either
   * way; route_root only changes how public routes and SDK routing metas are
   * composed and validated (campaigns-os doctor honors it).
   */
  route_root?: string
  payment_env_key?: string
  /**
   * Arrives in THREE incompatible shapes in real exports: bare string
   * "all", an array of country-code strings (incl. []), and an array of
   * { code, label } objects. All three are accepted; normalization to one
   * canonical shape is deliberately deferred.
   */
  available_shipping_countries?: 'all' | string[] | ShippingCountry[]
  tracking?: Record<string, unknown>
  preferred_template_family?: TemplateFamilyHint
  // Store profile block (15–22 of 33 real specs; null-valued when unset).
  // store_phone is the display string; store_phone_tel (below) is the
  // tel:-prefixed URI.
  store_url?: string | null
  store_name?: string | null
  store_contact?: string | null
  store_terms?: string | null
  store_shipping?: string | null
  store_privacy?: string | null
  store_returns?: string | null
  store_phone?: string | null
  /**
   * Domain allowlist for the SDK / Campaigns API key (Slice 4f). The
   * Campaigns API treats domain allowlisting as the access boundary for
   * public-by-design keys; carrying the allowlist in the spec lets the
   * build packet bind config.js to the same surface. Empty/missing
   * value is a warning, not an error — pre-launch specs frequently
   * lack a final domain.
   */
  allowed_domains?: string[]
  /**
   * `tel:`-prefixed phone URI for "Call us" CTAs (Slice 4f). Distinct
   * from store_phone (the human-readable display string); store_phone_tel
   * goes into <a href="tel:..."> attributes. Validation warns when the
   * value is present but doesn't start with `tel:`.
   */
  store_phone_tel?: string
  [key: string]: unknown
}

/**
 * Analytics & attribution contract (Slice 4g) — what a campaign's analytics,
 * tag-management, and querystring-param tracking are SUPPOSED to be, so doctor
 * + QA can validate them instead of discovering gaps in QA (cf. the Chamelo
 * Shield `?reviews=n`-has-no-handler finding and the Walla Sound Redtrack/
 * campaign.js sub1-6 param conflict).
 *
 * Modeled on real production-funnel usage, NOT the idealized "SDK fires the
 * canonical dl_* set" view. The field reality the block must express:
 *   - Events fire from three sources: SDK auto, SDK-blocked-then-manual
 *     (`blockedEvents` suppresses the SDK event, a side script re-fires it via
 *     raw fbq/gtag to control timing), and fully out-of-band pixels loaded via
 *     GTM (Everflow / TriplePixel / Northbeam / RudderStack) that never touch
 *     the dataLayer. So outbound pixel fires — not dataLayer events — are the
 *     QA source of truth.
 *   - A custom provider may carry an endpoint + transform (cookie injection).
 *   - Querystring params split into two classes: CONTENT (param.* → visibility
 *     via data-next-hide) and TRACKING (utm params, gclid, fbclid, subN, click-ids that
 *     must be preserved across funnel steps and not collide with ad trackers).
 *
 * The whole block is OPTIONAL — absent analytics means "use SDK defaults",
 * exactly as today. When present it becomes the source of truth for the
 * AnalyticsContractShape rule + downstream doctor/QA.
 */
export type AnalyticsMode = 'auto' | 'manual' | 'disabled'

export interface AnalyticsProvider {
  enabled?: boolean
  /** GTM container id (kind: gtm). */
  containerId?: string
  /** Meta/Facebook pixel id (kind: facebook). */
  pixelId?: string
  /** Custom-provider HTTP endpoint (kind: custom). */
  endpoint?: string
  /** Custom-provider transform hint, e.g. a cookie name to inject (`cf_click_id`). */
  transform?: string
  /** Events the SDK must NOT fire for this provider (a side script fires them). */
  blockedEvents?: string[]
  [key: string]: unknown
}

/** A pixel/tag fired OUTSIDE the SDK (via GTM or a raw snippet) — QA must still
 * expect it on a live run even though it never appears in the dataLayer. */
export interface OutOfBandPixel {
  vendor: string                       // everflow | triplepixel | northbeam | axon | rudderstack | …
  loaded_via?: 'gtm' | 'script' | (string & {})
  id?: string
}

/** An event the SDK is configured NOT to fire (`blockedEvents`), declared with
 * where + when a side script fires it instead. A `purchase`/`Purchase` manual
 * event SHOULD name the page it lives on — the first-upsell placement footgun
 * (async purchase beacons get lost in the checkout→upsell redirect). */
export interface ManualEvent {
  event: string
  page?: string                        // page id the manual fire lives on
  trigger?: string                     // page-load | field-focus | express-checkout-click | …
}

/** A content param that drives visibility via `data-next-hide="param.X=='n'"`. */
export interface ContentParam {
  name: string                         // e.g. seen, reviews, media, banner, timer
  hides?: string                       // section id/selector it toggles
  pages?: string[]                     // page ids where the handler exists
}

export interface TrackingParams {
  /** Params captured + preserved across funnel steps (utm_*, gclid, fbclid, sub1..5). */
  preserve?: string[]
  /** Funnel step page-types/ids the params must survive across. */
  across?: string[]
  /** The affiliate click id: inbound querystring param → SDK attribution field. */
  click_id?: { inbound?: string; maps_to?: string }
  /** External ad trackers sharing the URL (Redtrack/Clickflare) — collision watch. */
  external_trackers?: string[]
}

export interface AnalyticsParams {
  content?: ContentParam[]
  tracking?: TrackingParams
}

export interface UtmTransfer {
  enabled?: boolean
  applyToExternalLinks?: boolean
  paramsToCopy?: string[]
  excludedDomains?: string[]
}

export interface AnalyticsContract {
  mode?: AnalyticsMode
  /** Keyed by provider kind: gtm | facebook | rudderstack | custom | … */
  providers?: Record<string, AnalyticsProvider>
  out_of_band_pixels?: OutOfBandPixel[]
  manual_events?: ManualEvent[]
  utmTransfer?: UtmTransfer
  params?: AnalyticsParams
  [key: string]: unknown
}

/**
 * Saved Map Builder identity block (26/33 real specs). `source` values
 * observed: campaign-map-builder, hand-authored-simulation,
 * local-experimental.
 */
export interface SpecIdentity {
  map_id?: string
  source?: string
  id?: string
  map_url?: string
  edit_url?: string
  spec_url?: string
  spec_hash?: string
  saved_at?: string
  public_route_slug?: string
  variant_slug?: string
  template_family?: string
  derived_from?: string
  authority?: string
  [key: string]: unknown
}

/**
 * funnel_pages[] mirror entry: a Page plus the _funnel_id/_funnel_name
 * annotations linking it back to its funnel. The mirror is a flattened
 * LEGACY projection of funnels[].pages[] (declared "legacy" by
 * _provenance); funnels[] is authoritative.
 */
export interface FunnelPageMirrorEntry extends Page {
  _funnel_id?: string
  _funnel_name?: string
}

/**
 * Field-ownership declaration (27/33 real specs): which JSON paths are
 * ops-authored vs api-owned vs derived vs legacy mirrors.
 */
export interface SpecProvenance {
  ops?: string[]
  api?: string[]
  derived?: string[]
  legacy?: string[]
  [key: string]: unknown
}

export interface CampaignSpec {
  schema_version?: string
  builder_version?: string
  generated_at?: string
  spec_identity?: SpecIdentity
  campaign?: Campaign
  funnels: Funnel[]                    // required after normalize()
  /** Flattened legacy mirror of funnels[].pages[]; funnels[] is authoritative. */
  funnel_pages?: FunnelPageMirrorEntry[]
  offers?: Offer[]
  shipping_methods?: unknown[]
  /**
   * CANONICAL home of the SDK pin for the 4.x lineage (33/33 real specs
   * declare global_config.sdk_version).
   */
  global_config?: { sdk_version?: string; [key: string]: unknown }
  /** Accepted ALIAS location for sdk_version (local drafts only). */
  runtime?: { sdk_version?: string; [key: string]: unknown }
  build_scope?: { mode?: 'partial' | 'full'; [key: string]: unknown }
  /** Analytics & attribution contract (optional). See AnalyticsContract. */
  analytics?: AnalyticsContract
  _provenance?: SpecProvenance
  /** Flat mirrors of the saved-map identity (7/33 real specs). */
  slug?: string
  map_id?: string
  saved_at?: string
  [key: string]: unknown
}

// ── Fixture (corpus shape) ────────────────────────────────────────────────

export interface Fixture {
  spec: CampaignSpec
  expected: {
    violations: Violation[]
  }
}
