import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const BUILD_BRIEF_SCHEMA = "campaigns-os-build-brief/v1";
export const BUILD_BRIEF_NORMALIZED_REL_PATH = ".campaign-runtime/input/campaign-build-brief.normalized.json";
export const BUILD_BRIEF_CANDIDATE_FILENAMES = Object.freeze([
  "campaign-build-brief.yaml",
  "campaign-build-brief.yml",
  "campaign-build-brief.json",
]);

const REQUIRED_HIGH_IMPACT_FIELDS = Object.freeze([
  {
    id: "page_design_authority",
    priority: 1,
    field: "design_authority",
    question: "Which source controls each campaign page: the provided design export, the selected template, or a template adapted to another page?",
    reason: "Page-by-page authority prevents checkout, OTO, and receipt pages from drifting into unrelated starter-template composition.",
  },
  {
    id: "brand_palette_cta",
    priority: 2,
    field: "brand",
    question: "Which palette and CTA style should commerce pages use?",
    reason: "Commerce pages need a business-approved brand layer instead of silent template defaults.",
  },
  {
    id: "variant_media_rules",
    priority: 3,
    field: "media",
    question: "Which product variants or colors are actually sold, and may media show other variants?",
    reason: "Variant ambiguity often creates wrong-color carousels and unavailable-product claims.",
  },
  {
    id: "bundle_pricing_presentation",
    priority: 4,
    field: "offer_presentation.bundle_cards",
    question: "How should bundle cards present pricing: simple unit price, savings-led, or full accounting?",
    reason: "CampaignSpec owns prices; the brief owns which shopper-facing price story is appropriate.",
  },
  {
    id: "promo_urgency_copy",
    priority: 5,
    field: "promo_urgency",
    question: "Which promo, savings, and urgency language is approved for timers, banners, and exit-pop surfaces?",
    reason: "Promo placeholders and unsupported scarcity claims are business decisions, not implementation details.",
  },
  {
    id: "payment_methods_trust",
    priority: 6,
    field: "commerce_surfaces.payment_methods_allowed",
    question: "Which payment methods and trust badges may appear?",
    reason: "Templates often carry demo wallets or badges that must not survive without approval.",
  },
  {
    id: "canonical_display_names",
    priority: 7,
    field: "canonical_display.product_name_source",
    question: "Should CampaignSpec display names win, or may runtime/catalog names override them?",
    reason: "Name drift across source, spec, and runtime data is hard to spot after assembly.",
  },
  {
    id: "regulated_claims",
    priority: 8,
    field: "campaign_intent.compliance",
    question: "Are there regulated claims, forbidden phrases, or approved benefit statements the build must follow?",
    reason: "Health, financial, and other regulated offers need explicit copy boundaries.",
    conditional: "regulated",
  },
]);

const PAYMENT_METHOD_ALIASES = new Map([
  ["credit_card", "card"],
  ["credit card", "card"],
  ["card", "card"],
  ["cards", "card"],
  ["paypal", "paypal"],
  ["pay_pal", "paypal"],
  ["applepay", "apple_pay"],
  ["apple_pay", "apple_pay"],
  ["apple pay", "apple_pay"],
  ["googlepay", "google_pay"],
  ["google_pay", "google_pay"],
  ["google pay", "google_pay"],
  ["klarna", "klarna"],
  ["afterpay", "afterpay"],
  ["shop_pay", "shop_pay"],
  ["shop pay", "shop_pay"],
]);

const COLOR_WORDS = Object.freeze([
  "black",
  "white",
  "gray",
  "grey",
  "navy",
  "blue",
  "red",
  "green",
  "yellow",
  "pink",
  "purple",
  "orange",
  "brown",
  "cream",
  "beige",
  "silver",
  "gold",
  "matte",
  "rose",
]);

export function inferBuildBriefPath({ explicitPath = null, sourceRoot = null, targetRepo = null } = {}) {
  if (isNonEmptyString(explicitPath)) return { path: resolve(explicitPath), source: "operator_flag" };
  const roots = [...new Set([sourceRoot, targetRepo].filter(isNonEmptyString).map((path) => resolve(path)))];
  for (const root of roots) {
    for (const filename of BUILD_BRIEF_CANDIDATE_FILENAMES) {
      const candidate = join(root, filename);
      if (safeIsFile(candidate)) return { path: candidate, source: root === resolve(sourceRoot || "") ? "source_root" : "target_repo" };
    }
  }
  return null;
}

export function loadCampaignBuildBriefFile(path) {
  const resolvedPath = resolve(path);
  const text = readFileSync(resolvedPath, "utf8");
  const format = buildBriefFormatForPath(resolvedPath);
  let parsed;
  try {
    parsed = format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new Error(`Campaign Build Brief ${basename(resolvedPath)} could not be parsed as ${format.toUpperCase()}: ${error.message}`);
  }
  return { path: resolvedPath, format, value: parsed };
}

export function createCampaignBuildBriefArtifact({
  inputPath = null,
  inputSource = null,
  spec = null,
  activePages = [],
  pageMappings = [],
  templateFamily = null,
  sourceAssetCrawl = null,
  commerceZoneFindings = [],
} = {}) {
  const loaded = inputPath ? loadCampaignBuildBriefFile(inputPath) : null;
  const mode = loaded ? "prepared" : "guided_draft";
  const baseBrief = loaded
    ? cloneJson(loaded.value)
    : draftCampaignBuildBrief({ spec, activePages, pageMappings, templateFamily, sourceAssetCrawl });

  const errors = [];
  const normalized = normalizeCampaignBuildBrief(baseBrief, {
    mode,
    inputPath: loaded?.path || null,
    inputFormat: loaded?.format || "generated",
    inputSource,
    spec,
    activePages,
    pageMappings,
    sourceAssetCrawl,
  }, errors);
  const evaluation = evaluateCampaignBuildBrief(normalized, {
    spec,
    activePages,
    pageMappings,
    sourceAssetCrawl,
    commerceZoneFindings,
  });

  normalized.status = errors.length
    ? "invalid"
    : evaluation.questions.length
      ? "needs_answers"
      : "complete";
  normalized.questions = evaluation.questions;
  normalized.gates = [
    ...errors.map((error) => ({
      code: error.code,
      severity: "blocker",
      field: error.field || null,
      message: error.message,
    })),
    ...evaluation.gates,
  ];

  const blocking = mode === "prepared"
    ? normalized.gates.filter((gate) => gate.severity === "blocker")
    : normalized.gates.filter((gate) => gate.severity === "blocker" && gate.block_guided === true);

  return {
    mode,
    inputPath: loaded?.path || null,
    inputFormat: loaded?.format || "generated",
    artifact: normalized,
    errors,
    questions: evaluation.questions,
    gates: normalized.gates,
    blockers: blocking,
    warnings: normalized.gates.filter((gate) => gate.severity !== "blocker"),
  };
}

export function validateCampaignBuildBriefArtifact(brief, { spec = null } = {}) {
  const errors = [];
  const warnings = [];
  const ready = [];

  if (!isObject(brief)) {
    errors.push({ code: "build_brief.type", message: "Campaign Build Brief artifact must be an object." });
    return { errors, warnings, ready };
  }

  if (brief.schema_version !== BUILD_BRIEF_SCHEMA) {
    errors.push({ code: "build_brief.schema_version", message: `Campaign Build Brief schema_version must be ${BUILD_BRIEF_SCHEMA}.` });
  }

  const mode = brief._meta?.mode || "unknown";
  const questions = Array.isArray(brief.questions) ? brief.questions : [];
  const gates = Array.isArray(brief.gates) ? brief.gates : [];
  const blockerGates = gates.filter((gate) => gate?.severity === "blocker");

  if (brief.status === "complete" && questions.length === 0 && blockerGates.length === 0) {
    ready.push("Campaign Build Brief is complete: merchandising/design presentation truth is available.");
  } else if (mode === "prepared") {
    for (const gate of blockerGates) {
      errors.push({ code: gate.code || "build_brief.blocker", message: gate.message || "Prepared Campaign Build Brief has an unresolved blocker." });
    }
    if (questions.length) {
      errors.push({
        code: "build_brief.questions_unanswered",
        message: `Prepared Campaign Build Brief has ${questions.length} unresolved business question(s): ${questions.map((question) => question.id).join(", ")}.`,
      });
    }
  } else {
    if (questions.length) {
      warnings.push({
        code: "build_brief.guided_questions",
        message: `Generated Campaign Build Brief draft has ${questions.length} high-impact business question(s) to confirm: ${questions.map((question) => question.id).join(", ")}.`,
      });
    }
    for (const gate of blockerGates) {
      warnings.push({ code: gate.code || "build_brief.blocker", message: gate.message || "Generated Campaign Build Brief draft has an unresolved blocker." });
    }
  }

  const allowedPayments = normalizePaymentList(brief.commerce_surfaces?.payment_methods_allowed);
  const hiddenPayments = normalizePaymentList(brief.commerce_surfaces?.hidden_payment_methods);
  const overlap = allowedPayments.filter((method) => hiddenPayments.includes(method));
  if (overlap.length) {
    errors.push({
      code: "build_brief.payment_methods_conflict",
      message: `Campaign Build Brief lists payment method(s) as both allowed and hidden: ${overlap.join(", ")}.`,
    });
  }

  const specPayments = collectSpecPaymentMethods(spec);
  const unsupportedAllowed = specPayments.length ? allowedPayments.filter((method) => !specPayments.includes(method)) : [];
  if (unsupportedAllowed.length) {
    warnings.push({
      code: "build_brief.payment_methods_spec_drift",
      message: `Campaign Build Brief allows payment method(s) not found in CampaignSpec data: ${unsupportedAllowed.join(", ")}. Confirm runtime/catalog support before rendering them.`,
    });
  }

  if (brief.promo_urgency?.forbid_placeholders !== true) {
    warnings.push({
      code: "build_brief.promo_placeholders",
      message: "Campaign Build Brief should set promo_urgency.forbid_placeholders: true so XXCODE/SPEC_* promo residue is treated as a gate.",
    });
  }
  if (brief.template_residue_policy?.block_placeholders !== true) {
    warnings.push({
      code: "build_brief.template_residue_policy",
      message: "Campaign Build Brief should set template_residue_policy.block_placeholders: true so starter placeholders cannot survive silently.",
    });
  }

  return { errors, warnings, ready };
}

function normalizeCampaignBuildBrief(value, meta, errors) {
  const brief = isObject(value) ? cloneJson(value) : {};
  if (!isObject(value)) {
    errors.push({ code: "build_brief.type", field: null, message: "Campaign Build Brief must be a YAML/JSON object." });
  }
  if (brief.schema_version == null) brief.schema_version = BUILD_BRIEF_SCHEMA;
  if (brief.schema_version !== BUILD_BRIEF_SCHEMA) {
    errors.push({
      code: "build_brief.schema_version",
      field: "schema_version",
      message: `Campaign Build Brief schema_version must be ${BUILD_BRIEF_SCHEMA}.`,
    });
  }

  brief._meta = {
    generated_at: new Date().toISOString(),
    mode: meta.mode,
    input_path: meta.inputPath || null,
    input_format: meta.inputFormat || null,
    input_source: meta.inputSource || null,
    normalized_by: "campaigns-os prepare-build",
  };

  brief.campaign_intent = objectOrEmpty(brief.campaign_intent);
  brief.design_authority = objectOrEmpty(brief.design_authority);
  brief.brand = objectOrEmpty(brief.brand);
  brief.media = normalizeMedia(brief.media);
  brief.offer_presentation = normalizeOfferPresentation(brief.offer_presentation);
  brief.promo_urgency = normalizePromoUrgency(brief.promo_urgency);
  brief.commerce_surfaces = normalizeCommerceSurfaces(brief.commerce_surfaces);
  brief.canonical_display = objectOrEmpty(brief.canonical_display);
  brief.template_residue_policy = normalizeResiduePolicy(brief.template_residue_policy);
  brief.qa_policy = normalizeQaPolicy(brief.qa_policy);
  brief.confidence = objectOrEmpty(brief.confidence);

  return brief;
}

function draftCampaignBuildBrief({ spec, activePages, pageMappings, templateFamily, sourceAssetCrawl }) {
  const pageMap = new Map((pageMappings || []).map((page) => [page.page_id, page]));
  const designAuthority = {};
  for (const page of activePages || []) {
    const mapped = pageMap.get(page.id);
    designAuthority[page.id] = {
      source: mapped?.path ? "provided_design_export" : "template",
      reference: mapped?.path || mapped?.skip_reason || `${page.type || "page"} from selected template`,
    };
  }

  const variantSignals = collectVariantSignals(spec, sourceAssetCrawl);
  const paymentMethods = collectSpecPaymentMethods(spec);
  const hasExitPop = activePages?.some((page) => page?.type === "checkout" && page?.exit_intent?.enabled === true) === true;
  const hasOrderBump = JSON.stringify(spec || {}).toLowerCase().includes("order_bump")
    || JSON.stringify(spec || {}).toLowerCase().includes("prepurchase");

  return {
    schema_version: BUILD_BRIEF_SCHEMA,
    campaign_intent: {
      audience: null,
      conversion_goal: inferConversionGoal(activePages),
      tone: "clear, practical, benefit-led",
    },
    design_authority: designAuthority,
    brand: {
      commerce_palette_source: designAuthority.landing ? "landing" : "provided_design_export",
      primary_accent: null,
      cta_style: null,
      avoid: ["template-default brand colors"],
    },
    media: {
      sold_variants: variantSignals.length === 1 ? variantSignals : [],
      allow_other_variant_colors: variantSignals.length === 1 ? false : null,
      prefer: ["clean product renders", "lifestyle images without embedded text"],
      avoid: ["wrong product variant", "blurry stock-like crops"],
    },
    offer_presentation: {
      bundle_cards: {
        primary_price: null,
        show_total: "multi_pack_only",
        show_compare_price: false,
        savings_badge: "rounded_percentage",
        hide_duplicate_discount_copy: true,
      },
      post_purchase: {
        show_voucher_code: "when_customer_needs_to_see_it",
        show_retail_price: true,
        show_shipping: "if_charged",
      },
    },
    promo_urgency: {
      header_claim_source: hasPromoSignals(spec) ? "campaign_offers" : "none",
      timer_label: hasPromoSignals(spec) ? null : "Limited-time offer",
      show_promo_code_in_timer: false,
      exit_pop: {
        enabled: hasExitPop,
        code_source: hasExitPop ? "campaign_spec" : null,
      },
      forbid_placeholders: true,
    },
    commerce_surfaces: {
      payment_methods_allowed: paymentMethods.length ? paymentMethods : ["card"],
      hidden_payment_methods: [],
      order_bump: {
        enabled: hasOrderBump,
        display_style: hasOrderBump ? "compact_switch" : null,
      },
      guarantees: {
        use_campaign_or_merchant_policy_copy: true,
      },
    },
    canonical_display: {
      product_name_source: "campaign_spec",
      allow_runtime_name_override: false,
      manual_overrides: {},
    },
    template_residue_policy: normalizeResiduePolicy(),
    qa_policy: normalizeQaPolicy(),
    confidence: {
      campaign_intent: "low",
      design_authority: Object.keys(designAuthority).length ? "medium" : "low",
      brand: "low",
      media: variantSignals.length === 1 ? "medium" : "low",
      offer_presentation: "low",
      promo_urgency: hasPromoSignals(spec) ? "low" : "medium",
      commerce_surfaces: paymentMethods.length ? "medium" : "low",
      template_family: templateFamily || null,
    },
  };
}

function evaluateCampaignBuildBrief(brief, { spec, activePages, pageMappings, sourceAssetCrawl }) {
  const questions = [];
  const gates = [];
  const variantSignals = collectVariantSignals(spec, sourceAssetCrawl);
  const regulated = hasRegulatedSignals(spec);
  const pageIds = [...new Set((activePages || []).map((page) => page.id).filter(Boolean))];

  const missingDesignAuthority = pageIds.filter((pageId) => !isObject(brief.design_authority?.[pageId]) || !isNonEmptyString(brief.design_authority?.[pageId]?.source));
  if (missingDesignAuthority.length) {
    addQuestion(questions, "page_design_authority", {
      detail: `Missing page authority for: ${missingDesignAuthority.join(", ")}.`,
      options: ["provided design export", "selected template", "template adapted to another page"],
    });
  }
  if (!isNonEmptyString(brief.brand?.commerce_palette_source) || !isNonEmptyString(brief.brand?.cta_style)) {
    addQuestion(questions, "brand_palette_cta", {
      detail: "Missing brand.commerce_palette_source or brand.cta_style.",
      options: ["landing palette + matched CTA", "shared token file", "template palette"],
    });
  }
  if (variantSignals.length > 1 && (!Array.isArray(brief.media?.sold_variants) || brief.media.sold_variants.length === 0 || typeof brief.media.allow_other_variant_colors !== "boolean")) {
    addQuestion(questions, "variant_media_rules", {
      detail: `Detected multiple variant/media signals: ${variantSignals.slice(0, 8).join(", ")}.`,
      options: ["sold variant only", "all available variants", "ask merchant per carousel"],
    });
  }
  if (!isNonEmptyString(brief.offer_presentation?.bundle_cards?.primary_price)) {
    addQuestion(questions, "bundle_pricing_presentation", {
      detail: "Missing offer_presentation.bundle_cards.primary_price.",
      options: ["discounted unit price", "savings-led", "full accounting"],
    });
  }
  if (hasPromoSignals(spec) && (!isNonEmptyString(brief.promo_urgency?.header_claim_source) || !isNonEmptyString(brief.promo_urgency?.timer_label))) {
    addQuestion(questions, "promo_urgency_copy", {
      detail: "CampaignSpec appears to include promo/offer signals, but promo copy authority is incomplete.",
      options: ["actual voucher code", "bundle savings claim", "no promo banner"],
    });
  }
  if (!normalizePaymentList(brief.commerce_surfaces?.payment_methods_allowed).length) {
    addQuestion(questions, "payment_methods_trust", {
      detail: "Missing commerce_surfaces.payment_methods_allowed.",
      options: ["card only", "card + declared wallets", "merchant-approved list"],
    });
  }
  if (!isNonEmptyString(brief.canonical_display?.product_name_source)) {
    addQuestion(questions, "canonical_display_names", {
      detail: "Missing canonical_display.product_name_source.",
      options: ["CampaignSpec names", "runtime/catalog names", "manual overrides"],
    });
  }
  if (regulated && !hasComplianceBoundary(brief)) {
    addQuestion(questions, "regulated_claims", {
      detail: "Detected health, wellness, financial, or regulated-offer language without explicit claim boundaries.",
      options: ["approved benefit language only", "conservative generic claims", "operator-provided compliance copy"],
    });
  }

  if (brief.media?.allow_other_variant_colors === false && (!Array.isArray(brief.media.sold_variants) || brief.media.sold_variants.length === 0)) {
    gates.push({
      code: "build_brief.variant_rule_incomplete",
      severity: "blocker",
      field: "media.sold_variants",
      message: "Brief forbids other variant colors but does not name the sold variants.",
    });
  }
  if (brief.template_residue_policy?.block_demo_payment_methods !== true) {
    gates.push({
      code: "build_brief.demo_payment_methods_allowed",
      severity: "warning",
      field: "template_residue_policy.block_demo_payment_methods",
      message: "Brief does not explicitly block demo payment methods; polish/QA should verify template wallets are spec-backed.",
    });
  }
  if ((pageMappings || []).some((page) => page?.skip_reason) && brief.qa_policy?.require_checkout_flow === true) {
    gates.push({
      code: "build_brief.partial_scope_qa_policy",
      severity: "warning",
      field: "qa_policy.require_checkout_flow",
      message: "Brief requires checkout flow QA while some mapped pages are skipped; partial builds need explicit launch-readiness language.",
    });
  }

  return { questions: questions.sort((a, b) => a.priority - b.priority), gates };
}

function addQuestion(questions, id, { detail = null, options = [] } = {}) {
  const template = REQUIRED_HIGH_IMPACT_FIELDS.find((field) => field.id === id);
  if (!template) return;
  questions.push({
    id,
    priority: template.priority,
    field: template.field,
    question: template.question,
    reason: detail ? `${template.reason} ${detail}` : template.reason,
    options,
    blocking: true,
  });
}

function inferConversionGoal(activePages = []) {
  const hasCheckout = activePages.some((page) => page?.type === "checkout");
  const hasUpsell = activePages.some((page) => /upsell|downsell/i.test(String(page?.type || "")));
  if (hasCheckout && hasUpsell) return "direct response funnel with post-purchase offers";
  if (hasCheckout) return "single-product direct response funnel";
  return "campaign landing experience";
}

function normalizeMedia(media = {}) {
  const value = objectOrEmpty(media);
  return {
    ...value,
    sold_variants: normalizeStringArray(value.sold_variants),
    prefer: normalizeStringArray(value.prefer),
    avoid: normalizeStringArray(value.avoid),
  };
}

function normalizeOfferPresentation(offer = {}) {
  const value = objectOrEmpty(offer);
  return {
    ...value,
    bundle_cards: objectOrEmpty(value.bundle_cards),
    post_purchase: objectOrEmpty(value.post_purchase),
  };
}

function normalizePromoUrgency(promo = {}) {
  const value = objectOrEmpty(promo);
  return {
    ...value,
    exit_pop: objectOrEmpty(value.exit_pop),
    forbid_placeholders: value.forbid_placeholders === true,
  };
}

function normalizeCommerceSurfaces(commerce = {}) {
  const value = objectOrEmpty(commerce);
  return {
    ...value,
    payment_methods_allowed: normalizePaymentList(value.payment_methods_allowed),
    hidden_payment_methods: normalizePaymentList(value.hidden_payment_methods),
    order_bump: objectOrEmpty(value.order_bump),
    guarantees: objectOrEmpty(value.guarantees),
  };
}

function normalizeResiduePolicy(policy = {}) {
  const value = objectOrEmpty(policy);
  return {
    block_placeholders: value.block_placeholders !== false,
    block_template_favicon: value.block_template_favicon !== false,
    block_demo_payment_methods: value.block_demo_payment_methods !== false,
    block_lorem_ipsum: value.block_lorem_ipsum !== false,
    block_unapproved_tracking_claims: value.block_unapproved_tracking_claims !== false,
    ...value,
  };
}

function normalizeQaPolicy(policy = {}) {
  const value = objectOrEmpty(policy);
  return {
    require_desktop_mobile_screenshots: value.require_desktop_mobile_screenshots !== false,
    require_checkout_flow: value.require_checkout_flow !== false,
    require_post_purchase_flow: value.require_post_purchase_flow !== false,
    fail_on_visible_placeholders: value.fail_on_visible_placeholders !== false,
    compare_live_runtime_data_to_spec: value.compare_live_runtime_data_to_spec !== false,
    ...value,
  };
}

function collectVariantSignals(spec, sourceAssetCrawl) {
  const signals = new Set();
  visitValues(spec, (value, keyPath) => {
    const key = keyPath[keyPath.length - 1] || "";
    if (!/(variant|color|colour|size|option|shade)/i.test(key)) return;
    if (typeof value === "string" && value.trim().length <= 80) signals.add(value.trim().toLowerCase());
  });
  for (const ref of sourceAssetCrawl?.references || []) {
    if (ref.asset_kind !== "image") continue;
    const text = `${ref.source_path || ""} ${ref.normalized || ""}`.toLowerCase();
    const matches = COLOR_WORDS.filter((color) => new RegExp(`(^|[^a-z])${escapeRegExp(color)}([^a-z]|$)`, "i").test(text));
    if (matches.length) signals.add(matches.join(" "));
  }
  return [...signals].filter(Boolean).sort();
}

export function collectSpecPaymentMethods(spec) {
  const methods = new Set();
  visitValues(spec, (value, keyPath) => {
    const path = keyPath.join(".").toLowerCase();
    const inPaymentContext = /payment|wallet|express/.test(path);
    if (!inPaymentContext) return;
    if (typeof value === "string") {
      const method = normalizePaymentMethod(value);
      if (method) methods.add(method);
    } else if (typeof value === "boolean" && value === true) {
      const method = normalizePaymentMethod(keyPath[keyPath.length - 1]);
      if (method) methods.add(method);
    }
  });
  return [...methods].sort();
}

function hasPromoSignals(spec) {
  let found = false;
  visitValues(spec, (value, keyPath) => {
    if (found) return;
    const path = keyPath.join(".").toLowerCase();
    if (/(promo|voucher|coupon|discount|offer|timer|urgency|exit_intent)/.test(path) && value != null && value !== false) {
      found = true;
    }
  });
  return found;
}

function hasRegulatedSignals(spec) {
  const text = JSON.stringify(spec || {}).toLowerCase();
  return /\b(health|wellness|supplement|medical|doctor|clinical|cure|pain|anxiety|weight loss|finance|financial|loan|credit|insurance|investment)\b/.test(text);
}

function hasComplianceBoundary(brief) {
  const compliance = brief.campaign_intent?.compliance || brief.compliance || {};
  if (!isObject(compliance)) return false;
  return ["forbidden_claims", "approved_benefit_language", "approved_claims", "copy_rules"].some((key) => {
    const value = compliance[key];
    return Array.isArray(value) ? value.length > 0 : isNonEmptyString(value);
  });
}

function visitValues(value, visitor, keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitValues(item, visitor, [...keyPath, String(index)]));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) visitValues(item, visitor, [...keyPath, key]);
    return;
  }
  visitor(value, keyPath);
}

function normalizePaymentList(value) {
  const raw = Array.isArray(value) ? value : isNonEmptyString(value) ? [value] : [];
  return [...new Set(raw.map(normalizePaymentMethod).filter(Boolean))].sort();
}

function normalizePaymentMethod(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return PAYMENT_METHOD_ALIASES.get(normalized) || null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function buildBriefFormatForPath(path) {
  const ext = extname(path).toLowerCase();
  return ext === ".json" ? "json" : "yaml";
}

function safeIsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function objectOrEmpty(value) {
  return isObject(value) ? value : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
