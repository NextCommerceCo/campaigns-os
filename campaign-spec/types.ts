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

export interface PageOffer {
  ref_id: string | number
  code?: string
  [key: string]: unknown
}

export interface PagePackage {
  ref_id?: string | number
  name?: string
  price?: number | string
  price_retail?: number | string
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

export interface Page {
  id: string
  type: PageType
  label?: string
  // Routing fields. Which are valid depends on `type`; rules enforce.
  next_page?: string
  success_url?: string
  on_accept?: string
  on_decline?: string
  // Optional content
  packages?: PagePackage[]
  offers?: PageOffer[]
  exit_intent?: ExitIntent
  promo_code_input?: PromoCodeInput
  sdk_hints?: { meta_tags?: Record<string, string> }
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

export interface Offer {
  ref_id: string | number
  code?: string
  name?: string
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

export interface Campaign {
  ref_id?: number | string
  slug?: string
  payment_env_key?: string
  available_shipping_countries?: 'all' | string[]
  tracking?: Record<string, unknown>
  preferred_template_family?: TemplateFamilyHint
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

export interface CampaignSpec {
  schema_version?: string
  spec_identity?: { map_id?: string; [key: string]: unknown }
  campaign?: Campaign
  funnels: Funnel[]                    // required after normalize()
  offers?: Offer[]
  shipping_methods?: unknown[]
  global_config?: { sdk_version?: string; [key: string]: unknown }
  runtime?: { sdk_version?: string; [key: string]: unknown }
  build_scope?: { mode?: 'partial' | 'full'; [key: string]: unknown }
  [key: string]: unknown
}

// ── Fixture (corpus shape) ────────────────────────────────────────────────

export interface Fixture {
  spec: CampaignSpec
  expected: {
    violations: Violation[]
  }
}
