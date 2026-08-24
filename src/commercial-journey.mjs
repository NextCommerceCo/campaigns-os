/**
 * Pure Commercial Journey scenario planning and response normalization.
 *
 * This module intentionally owns no transport. Callers execute the returned
 * plan and pass the captured results to normalizeJourney.
 *
 * Deviation from design §5 (ratified 2026-08-21): voucher-type offers attached
 * to upsell/downsell pages are treated as page-carried (per-OTO wiring) and
 * priced with-and-without; surface-bound codes remain the only voucher path on
 * checkout pages.
 */

export const CALC_LABEL = "Campaigns-calculated · before tax";
export const CALCULATED_PAIR_EVIDENCE = "calculated_pair";

export const PricingState = Object.freeze({
  Exact: "Exact",
  Stale: "Stale",
  Unresolved: "Unresolved",
  Estimated: "Estimated",
});

export class CommercialJourneyLimitError extends Error {
  constructor(kind, limit) {
    super(`Commercial journey ${kind} limit exceeded (${limit}).`);
    this.name = "CommercialJourneyLimitError";
    this.code = `commercial_journey_${kind}_limit`;
    this.kind = kind;
    this.limit = limit;
  }
}

const UNRESOLVED_PACKAGE = "Unresolved: package not on campaign";
const UNRESOLVED_STORE_COUPON = "Unresolved: store coupon — not previewable";
const UNRESOLVED_INVALID_PACKAGE = "Unresolved: invalid package row";
const UNRESOLVED_INVALID_SHIPPING = "Unresolved: invalid shipping method";
const UNRESOLVED_INVALID_RECURRENCE = "Unresolved: invalid recurring package facts";

function array(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function positiveInteger(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pageKey(page) {
  return encodeURIComponent(String(page?.id || "page"));
}

function mapOffers(mapDoc) {
  return [
    ...array(mapDoc?.offers),
    ...array(mapDoc?.campaign?.offers),
    ...array(mapDoc?.catalog?.offers),
  ];
}

function offerIdentity(offer) {
  return String(offer?.ref_id ?? offer?.id ?? "");
}

function resolveOffer(entry, offers) {
  const ref = offerIdentity(entry);
  const resolved = offers.find((offer) => offerIdentity(offer) === ref);
  return { ...(resolved || {}), ...(entry || {}) };
}

function selectedShipping(page) {
  if (present(page?.shipping_method)) {
    const selected = positiveInteger(page.shipping_method);
    return selected === null
      ? { reason: UNRESOLVED_INVALID_SHIPPING }
      : { value: selected };
  }

  const candidates = array(page?.shipping_methods);
  if (!candidates.length) return {};

  const ranked = candidates.map((method, index) => {
    const raw = method && typeof method === "object" ? method : { ref_id: method };
    const ref = raw.ref_id ?? raw.id ?? raw.shipping_method_id ?? raw.code;
    const cents = moneyToCents(raw.price);
    return { ref: positiveInteger(ref), cents, index };
  }).filter((entry) => present(entry.ref));
  if (!ranked.length) return { reason: UNRESOLVED_INVALID_SHIPPING };

  ranked.sort((a, b) => {
    if (a.cents === null && b.cents === null) return a.index - b.index;
    if (a.cents === null) return 1;
    if (b.cents === null) return -1;
    return a.cents - b.cents || a.index - b.index;
  });
  return { value: ranked[0].ref };
}

function lineForRow(row) {
  const packageId = positiveInteger(row?.ref_id);
  const quantity = present(row?.qty) ? positiveInteger(row.qty) : 1;
  if (packageId === null || quantity === null) return null;
  const line = { package_id: packageId, quantity };
  if (row?.is_upsell) line.is_upsell = true;
  return line;
}

function authoredLine(row) {
  return {
    package_id: row?.ref_id ?? null,
    quantity: present(row?.qty) ? row.qty : 1,
    ...(row?.is_upsell ? { is_upsell: true } : {}),
  };
}

function findFunnel(mapDoc, page) {
  return array(mapDoc?.funnels).find((funnel) =>
    array(funnel?.pages).some((candidate) => String(candidate?.id) === String(page?.id)),
  ) || null;
}

function declineCondition(mapDoc, page) {
  for (const funnel of array(mapDoc?.funnels)) {
    const parent = array(funnel?.pages).find((candidate) =>
      String(candidate?.on_decline ?? "") === String(page?.id ?? ""),
    );
    if (parent) return `if ${parent.label || parent.id} declined`;
  }
  return page?.type === "downsell" ? "if prior upsell declined" : null;
}

function catalogImportedAt(mapDoc) {
  return mapDoc?.catalog_imported_at
    ?? mapDoc?._provenance?.api?.imported_at
    ?? mapDoc?._provenance?.api?.fetched_at
    ?? mapDoc?.campaign?._provenance?.api?.imported_at
    ?? null;
}

function specHash(mapDoc) {
  return mapDoc?.spec_hash ?? mapDoc?.spec_identity?.spec_hash ?? null;
}

function descriptor(page, mapDoc, role, lines, options = {}) {
  const funnel = findFunnel(mapDoc, page);
  const suffix = options.id_suffix ? `:${options.id_suffix}` : "";
  const result = {
    id: `commercial:${pageKey(page)}:${role}${suffix}`,
    upsell: page?.type === "upsell" || page?.type === "downsell",
    context: {
      page_id: page?.id ?? null,
      page_type: page?.type ?? null,
      page_label: page?.label ?? page?.name ?? page?.id ?? null,
      page_order: Number(page?.order) || 0,
      funnel_id: funnel?.id ?? null,
      role,
      row_index: options.row_index,
      bump_index: options.bump_index,
      surface: options.surface,
      offer_code: options.offer_code,
      offer_ref_id: options.offer_ref_id,
      attached_offers: options.attached_offers || [],
      known_offer_codes: options.known_offer_codes || [],
      page_rows: options.page_rows || [],
      decline_condition: declineCondition(mapDoc, page),
      spec_hash: specHash(mapDoc),
      catalog_imported_at: catalogImportedAt(mapDoc),
      planned_rows: options.planned_rows || [],
    },
  };
  if (options.unresolved) {
    return { ...result, unresolved: true, reason: options.reason };
  }

  const body = { lines: lines.map((line) => ({ ...line })) };
  if (array(options.vouchers).length) body.vouchers = [...options.vouchers];

  const currency = mapDoc?.campaign?.currency ?? mapDoc?.currency;
  if (present(currency)) body.currency = String(currency);
  if (present(options.shipping_method)) body.shipping_method = options.shipping_method;
  return { ...result, body };
}

/**
 * Convert one authored page into deterministic calculate request descriptors.
 */
export function planScenarios(page, mapDoc = {}, options = {}) {
  const rows = array(page?.packages);
  if (!rows.length) return [];
  const requestedLimit = Number(options.maxScenarios);
  const maxScenarios = Number.isInteger(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : Number.POSITIVE_INFINITY;
  if (rows.length > maxScenarios) throw new CommercialJourneyLimitError("scenarios", maxScenarios);

  // Descriptor ids are namespaced by page id; two id-less pages would collide
  // and silently consume each other's responses in a shared plan. Refuse to
  // price such a page instead of guessing.
  if (!present(page?.id)) {
    if (maxScenarios < 1) throw new CommercialJourneyLimitError("scenarios", maxScenarios);
    return [descriptor(page, mapDoc, "representative", [], {
      unresolved: true,
      reason: "Unresolved: page has no id",
      planned_rows: rows.map(authoredLine),
    })];
  }

  const offers = mapOffers(mapDoc);
  const attached = array(page?.offers).map((entry) => resolveOffer(entry, offers));
  const pageIsUpsell = page?.type === "upsell" || page?.type === "downsell";
  const knownOfferCodes = [...new Set([
    ...offers,
    ...attached,
  ].map((offer) => offer?.code).filter(present).map(String))];

  const surfaces = ["promo_code_input", "exit_intent"]
    .map((name) => ({ name, value: page?.[name] }))
    .filter(({ value }) => value?.enabled !== false && present(value?.offer_code));
  const carriedVouchers = attached
    .filter((offer) => pageIsUpsell && offer?.type === "voucher" && present(offer?.code))
    .map((offer) => String(offer.code));
  const plannedSurfaces = surfaces.filter(({ value }) =>
    !pageIsUpsell || !carriedVouchers.includes(String(value.offer_code)),
  );

  const shared = { attached_offers: attached, known_offer_codes: knownOfferCodes, page_rows: rows };
  const plan = [];
  const add = (value) => {
    if (plan.length >= maxScenarios) throw new CommercialJourneyLimitError("scenarios", maxScenarios);
    plan.push(value);
  };
  const parsedRows = rows.map((row, rowIndex) => ({
    row,
    rowIndex,
    line: lineForRow(row),
    authored: authoredLine(row),
  }));
  const mainRows = pageIsUpsell ? parsedRows : parsedRows.filter(({ row }) => !row?.is_upsell);
  const bumpRows = pageIsUpsell ? [] : parsedRows.filter(({ row }) => row?.is_upsell);
  const representativeLines = mainRows.map(({ line }) => line).filter(Boolean);
  const shipping = selectedShipping(page);
  const representativeReason = shipping.reason
    || (mainRows.length === 0 || mainRows.some(({ line }) => !line) ? UNRESOLVED_INVALID_PACKAGE : null);
  const describe = (role, lines, options = {}) => {
    const reason = options.reason || shipping.reason;
    return descriptor(page, mapDoc, role, lines, {
      ...options,
      ...shared,
      shipping_method: shipping.value,
      ...(reason ? { unresolved: true, reason } : {}),
    });
  };

  if (representativeReason) {
    add(describe("representative", [], {
      reason: representativeReason,
      planned_rows: mainRows.map(({ authored }) => authored),
    }));
  } else if (representativeLines.length) {
    if (pageIsUpsell && carriedVouchers.length) {
      add(describe("representative-without", representativeLines));
      add(describe("representative-with", representativeLines, {
        vouchers: carriedVouchers,
      }));
    } else {
      add(describe("representative", representativeLines));
    }
  }

  bumpRows.forEach(({ line, authored }, bumpIndex) => {
    const reason = representativeReason || (!line ? UNRESOLVED_INVALID_PACKAGE : null);
    add(describe("bump-without", representativeLines, {
      bump_index: bumpIndex,
      id_suffix: bumpIndex,
      reason,
    }));
    add(describe("bump-with", line ? [...representativeLines, line] : [], {
      bump_index: bumpIndex,
      id_suffix: bumpIndex,
      reason,
      planned_rows: !line ? [authored] : [],
    }));
  });

  parsedRows.forEach(({ line, authored, rowIndex }) => {
    const reason = shipping.reason || (!line ? UNRESOLVED_INVALID_PACKAGE : null);
    add(describe("row", line ? [line] : [], {
      row_index: rowIndex,
      id_suffix: rowIndex,
      vouchers: pageIsUpsell ? carriedVouchers : [],
      reason,
      planned_rows: reason ? [authored] : [],
    }));
  });

  plannedSurfaces.forEach(({ name, value }, surfaceIndex) => {
    const baselineVouchers = pageIsUpsell ? carriedVouchers : [];
    const surfaceOptions = {
      ...shared,
      surface: name,
      offer_code: String(value.offer_code),
      offer_ref_id: value.offer_ref_id ?? null,
      id_suffix: `${surfaceIndex}:${encodeURIComponent(String(value.offer_code))}`,
    };
    add(describe("surface-without", representativeLines, {
      ...surfaceOptions,
      vouchers: baselineVouchers,
      reason: representativeReason,
    }));
    add(describe("surface-with", representativeLines, {
      ...surfaceOptions,
      vouchers: [...baselineVouchers, String(value.offer_code)],
      reason: representativeReason,
    }));
  });

  return plan;
}

function metadata(value) {
  return value?.meta || value?.context || value || {};
}

function unresolvedResult(result) {
  return result?.state === PricingState.Unresolved || result?.unresolved === true || result?.ok === false;
}

/**
 * Derive the freshness state of a calculation result against current metadata.
 */
export function deriveState(result, meta = {}) {
  if (unresolvedResult(result)) return PricingState.Unresolved;
  if (result?.state === PricingState.Stale) return PricingState.Stale;

  const calculated = metadata(result);
  const resultSpecHash = calculated.spec_hash ?? result?.spec_hash;
  const resultCatalog = calculated.catalog_imported_at ?? result?.catalog_imported_at;
  const resultCalculatedAt = calculated.calculated_at ?? result?.calculated_at ?? meta?.calculated_at;

  if (present(resultSpecHash) && present(meta?.spec_hash) && String(resultSpecHash) !== String(meta.spec_hash)) {
    return PricingState.Stale;
  }
  if (present(resultCatalog) && present(meta?.catalog_imported_at) && String(resultCatalog) !== String(meta.catalog_imported_at)) {
    return PricingState.Stale;
  }

  const catalogTime = Date.parse(meta?.catalog_imported_at);
  const calculatedTime = Date.parse(resultCalculatedAt);
  if (Number.isFinite(catalogTime) && Number.isFinite(calculatedTime) && catalogTime > calculatedTime) {
    return PricingState.Stale;
  }

  return PricingState.Exact;
}

export function moneyToCents(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (!present(value)) return null;
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const fraction = (match[3] || "").padEnd(2, "0");
  const cents = Number(match[2]) * 100 + Number(fraction || 0);
  return match[1] === "-" ? -cents : cents;
}

export function centsToUsd(cents) {
  if (!Number.isInteger(cents)) return null;
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function signedCents(cents) {
  if (!Number.isInteger(cents)) return null;
  if (cents > 0) return `+${centsToUsd(cents)}`;
  return centsToUsd(cents);
}

function moneyFact(value, state) {
  return { state, value: String(value), label: CALC_LABEL };
}

function unresolvedFact(reason) {
  return { state: PricingState.Unresolved, reason };
}

function statusOf(envelope) {
  return Number(envelope?.status ?? envelope?.statusCode ?? 200);
}

function payloadOf(envelope) {
  if (envelope && Object.prototype.hasOwnProperty.call(envelope, "response")) return envelope.response;
  if (envelope && Object.prototype.hasOwnProperty.call(envelope, "body")) return envelope.body;
  return envelope;
}

function retryAfter(envelope) {
  const headers = envelope?.headers || {};
  if (typeof headers.get === "function") return headers.get("Retry-After") || headers.get("retry-after") || "unknown";
  return headers["Retry-After"] ?? headers["retry-after"] ?? envelope?.retry_after ?? "unknown";
}

function sameRequest(descriptorValue, envelope) {
  if (!envelope?.request) return false;
  const expectedUpsell = descriptorValue.upsell;
  const actualUpsell = /[?&]upsell=true(?:&|$)/.test(String(envelope.request.url || ""));
  if (expectedUpsell !== actualUpsell) return false;
  return JSON.stringify(descriptorValue.body) === JSON.stringify(envelope.request.body);
}

function responseLookup(plan, responses) {
  if (!Array.isArray(responses) && responses && typeof responses === "object") {
    return (descriptorValue) => responses[descriptorValue.id];
  }

  const list = array(responses);
  const used = new Set();
  return (descriptorValue, index) => {
    const byId = list.findIndex((entry, candidateIndex) =>
      !used.has(candidateIndex) && String(entry?.id ?? "") === descriptorValue.id,
    );
    if (byId >= 0) {
      used.add(byId);
      return list[byId];
    }
    const byRequest = list.findIndex((entry, candidateIndex) =>
      !used.has(candidateIndex) && sameRequest(descriptorValue, entry),
    );
    if (byRequest >= 0) {
      used.add(byRequest);
      return list[byRequest];
    }
    if (list[index] !== undefined && !used.has(index)) {
      used.add(index);
      return list[index];
    }
    return undefined;
  };
}

function responseError(envelope) {
  if (!envelope) return "Unresolved: response missing";
  const status = statusOf(envelope);
  if (status === 429) return `Unresolved: rate limited — retry after ${retryAfter(envelope)}`;
  if (status >= 400) {
    const response = payloadOf(envelope);
    const detail = array(response?.lines).join(" ");
    if (/package not found/i.test(detail)) return UNRESOLVED_PACKAGE;
    return `Unresolved: calculate request failed (${status})`;
  }
  return null;
}

function consumeEchoes(requestedLines, responseLines) {
  const used = new Set();
  return requestedLines.map((requested) => {
    const index = responseLines.findIndex((line, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      return String(line?.package_id) === String(requested?.package_id)
        && Number(line?.quantity ?? 1) === Number(requested?.quantity ?? 1);
    });
    if (index < 0) return { requested, response: null };
    used.add(index);
    return { requested, response: responseLines[index] };
  });
}

function recurringAnnotation(recurrence) {
  if ((recurrence?.state !== PricingState.Exact && recurrence?.state !== PricingState.Stale)
    || recurrence?.amount?.state !== recurrence.state
    || !present(recurrence?.amount?.value)
    || !present(recurrence?.interval_count)
    || !present(recurrence?.interval)) return null;
  const count = Number(recurrence.interval_count);
  const unit = `${recurrence.interval}${count === 1 ? "" : "s"}`;
  return `then $${recurrence.amount.value} / ${recurrence.interval_count} ${unit}`;
}

function recurrenceFact(pkg, state, quantityValue) {
  if (!pkg?.is_recurring) return null;
  if (!present(pkg?.price_recurring) || !present(pkg?.interval_count) || !present(pkg?.interval)) {
    return unresolvedFact(UNRESOLVED_INVALID_RECURRENCE);
  }
  const quantity = positiveInteger(quantityValue);
  const intervalCount = positiveInteger(pkg.interval_count);
  const unitCents = moneyToCents(String(pkg.price_recurring));
  const totalCents = unitCents === null || quantity === null ? null : unitCents * quantity;
  const interval = String(pkg.interval).trim();
  if ((state !== PricingState.Exact && state !== PricingState.Stale)
    || intervalCount === null
    || unitCents === null
    || unitCents < 0
    || !Number.isSafeInteger(totalCents)
    || !interval) {
    return unresolvedFact(UNRESOLVED_INVALID_RECURRENCE);
  }
  return {
    state,
    amount: moneyFact(centsToUsd(totalCents), state),
    interval_count: intervalCount,
    interval,
  };
}

function normalizeLine(echo, state, packages) {
  const pkg = packages.find((candidate) => String(candidate?.ref_id) === String(echo.requested?.package_id));
  const recurrence = recurrenceFact(pkg, state, echo.requested?.quantity);
  const recurrenceUnresolved = recurrence?.state === PricingState.Unresolved;
  const rowState = recurrenceUnresolved ? PricingState.Unresolved : state;
  const rowReason = recurrenceUnresolved ? recurrence.reason || UNRESOLVED_INVALID_RECURRENCE : null;
  const common = {
    package_id: echo.requested?.package_id,
    quantity: echo.requested?.quantity,
    ...(echo.requested?.is_upsell ? { is_upsell: true } : {}),
    name: pkg?.name ?? null,
  };
  if (!echo.response) return { ...common, state: PricingState.Unresolved, reason: UNRESOLVED_PACKAGE };

  const line = echo.response;
  return {
    ...common,
    state: rowState,
    ...(rowReason ? { reason: rowReason } : {}),
    recurring_annotation: recurringAnnotation(recurrence),
    ...(recurrence ? { recurrence } : {}),
    base: moneyFact(line.subtotal ?? line.original_package_price, state),
    applied_offers: array(line.discounts).map((discount) => ({
      offer_id: discount.offer_id ?? null,
      name: discount.name ?? null,
      description: discount.description ?? null,
      amount: moneyFact(discount.amount, state),
    })),
    final: moneyFact(line.total, state),
    savings: moneyFact(line.total_discount, state),
  };
}

function normalizePlannedRow(line, reason, packages) {
  const pkg = packages.find((candidate) => String(candidate?.ref_id) === String(line?.package_id));
  return {
    package_id: line?.package_id ?? null,
    quantity: line?.quantity ?? null,
    ...(line?.is_upsell ? { is_upsell: true } : {}),
    name: pkg?.name ?? null,
    state: PricingState.Unresolved,
    reason,
  };
}

function normalizeShipping(response, state) {
  const shipping = response?.shipping_method;
  if (!shipping) {
    return {
      present: false,
      state,
      original_price: moneyFact("0.00", state),
      price: moneyFact("0.00", state),
      discounts: [],
    };
  }
  return {
    present: true,
    state,
    id: shipping.id ?? null,
    name: shipping.name ?? null,
    code: shipping.code ?? null,
    original_price: moneyFact(shipping.original_price ?? "0.00", state),
    price: moneyFact(shipping.price ?? "0.00", state),
    discounts: array(shipping.discounts).map((discount) => ({
      offer_id: discount.offer_id ?? null,
      name: discount.name ?? null,
      amount: moneyFact(discount.amount, state),
    })),
  };
}

function mergePackageSources(catalogPackages, pageRows) {
  const merged = new Map();
  array(catalogPackages).forEach((pkg) => {
    if (pkg?.ref_id === undefined || pkg?.ref_id === null) return;
    merged.set(String(pkg.ref_id), { ...pkg });
  });
  array(pageRows).forEach((row) => {
    if (row?.ref_id === undefined || row?.ref_id === null) return;
    const key = String(row.ref_id);
    const base = merged.get(key) || {};
    const overrides = {};
    Object.entries(row).forEach(([field, value]) => {
      if (value !== undefined && value !== null && value !== "") overrides[field] = value;
    });
    merged.set(key, { ...base, ...overrides });
  });
  return [...merged.values()];
}

function normalizeScenario(descriptorValue, envelope, catalogPackages, meta) {
  // Authored page rows carry recurring cadence fields (is_recurring,
  // price_recurring, interval, interval_count) even when no campaign
  // catalog is available (the viewer only has the map document). Merge
  // per ref_id: catalog is the base, row fields override only where the
  // row actually carries a value.
  const packages = mergePackageSources(catalogPackages, descriptorValue?.context?.page_rows);
  if (descriptorValue?.unresolved) {
    const reason = descriptorValue.reason || "Unresolved: invalid calculate scenario";
    return {
      state: PricingState.Unresolved,
      reason,
      rows: array(descriptorValue?.context?.planned_rows)
        .map((line) => normalizePlannedRow(line, reason, packages)),
      descriptor: descriptorValue,
      subtotal: unresolvedFact(reason),
      total_discount: unresolvedFact(reason),
      total: unresolvedFact(reason),
      shipping: { present: false, state: PricingState.Unresolved, reason },
    };
  }
  const error = responseError(envelope);
  if (error) return { state: PricingState.Unresolved, reason: error, rows: [], descriptor: descriptorValue };

  const response = payloadOf(envelope) || {};
  const resultMeta = {
    ...descriptorValue.context,
    ...(envelope?.meta || {}),
    spec_hash: envelope?.spec_hash ?? envelope?.meta?.spec_hash ?? descriptorValue.context?.spec_hash,
    catalog_imported_at: envelope?.catalog_imported_at
      ?? envelope?.meta?.catalog_imported_at
      ?? descriptorValue.context?.catalog_imported_at,
    calculated_at: envelope?.calculated_at ?? envelope?.meta?.calculated_at ?? meta?.calculated_at,
  };
  const state = deriveState(resultMeta, meta);
  const echoes = consumeEchoes(array(descriptorValue?.body?.lines), array(response?.lines));
  const rows = echoes.map((echo) => normalizeLine(echo, state, packages));
  const unresolvedRow = rows.find((row) => row.state === PricingState.Unresolved);
  const missing = Boolean(unresolvedRow);
  const unresolvedReason = unresolvedRow?.reason || UNRESOLVED_PACKAGE;
  const scenarioState = missing ? PricingState.Unresolved : state;

  return {
    state: scenarioState,
    ...(missing ? { reason: unresolvedReason } : {}),
    descriptor: descriptorValue,
    response,
    rows,
    subtotal: missing ? unresolvedFact(unresolvedReason) : moneyFact(response.subtotal, state),
    total_discount: missing ? unresolvedFact(unresolvedReason) : moneyFact(response.total_discount, state),
    total: missing ? unresolvedFact(unresolvedReason) : moneyFact(response.total, state),
    currency: response.currency ?? null,
    shipping: missing
      ? { present: false, state: PricingState.Unresolved, reason: unresolvedReason }
      : present(descriptorValue?.body?.shipping_method)
        ? normalizeShipping(response, state)
        : { present: false, state },
  };
}

function worstState(states) {
  if (states.includes(PricingState.Unresolved)) return PricingState.Unresolved;
  if (states.includes(PricingState.Stale)) return PricingState.Stale;
  return PricingState.Exact;
}

function attributableDiscount(response, code) {
  const upperCode = String(code || "").toUpperCase();
  return array(response?.voucher_discounts).some((discount) => {
    const identifiers = [
      discount?.code,
      discount?.voucher_code,
      discount?.coupon_code,
      discount?.offer_code,
      discount?.name,
    ].filter(present).map((value) => String(value).toUpperCase());
    if (identifiers.includes(upperCode)) return true;

    // Code-aware boundary match: the code must appear in the description as a
    // whole unit bounded by start/end or non-alphanumerics. Handles punctuated
    // codes (SAVE-10, alone or inside "SAVE-10 PROMO") without letting SAVE
    // match SAVE10.
    if (!upperCode) return false;
    const description = String(discount?.description || "").toUpperCase();
    const escaped = upperCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(description);
  });
}

function totalCents(scenario) {
  return scenario?.total?.state === PricingState.Unresolved ? null : moneyToCents(scenario?.total?.value);
}

function deltaFact(before, after, direction = "impact") {
  if (!before || !after || before.state === PricingState.Unresolved || after.state === PricingState.Unresolved) {
    return unresolvedFact(before?.reason || after?.reason || "Unresolved: comparison unavailable");
  }
  const beforeCents = totalCents(before);
  const afterCents = totalCents(after);
  if (beforeCents === null || afterCents === null) return unresolvedFact("Unresolved: invalid server money value");
  const cents = direction === "savings" ? beforeCents - afterCents : afterCents - beforeCents;
  return moneyFact(signedCents(cents), worstState([before.state, after.state]));
}

function knownCode(code, context, catalog) {
  const upper = String(code || "").toUpperCase();
  return array(context?.known_offer_codes).some((candidate) => String(candidate).toUpperCase() === upper)
    || array(catalog?.offers).some((offer) => String(offer?.code || "").toUpperCase() === upper);
}

function pageContext(scenarios) {
  return scenarios[0]?.descriptor?.context || {};
}

function roleScenarios(scenarios, role) {
  return scenarios.filter((scenario) => scenario?.descriptor?.context?.role === role);
}

function scenarioByIndexedRole(scenarios, role, field, index) {
  return scenarios.find((scenario) => scenario?.descriptor?.context?.role === role
    && Number(scenario?.descriptor?.context?.[field]) === Number(index));
}

function representativeForPage(scenarios, catalog) {
  const plain = roleScenarios(scenarios, "representative")[0];
  if (plain) return { scenario: plain, offers: [] };

  const without = roleScenarios(scenarios, "representative-without")[0];
  const withVoucher = roleScenarios(scenarios, "representative-with")[0];
  if (!without || !withVoucher) {
    const missing = withVoucher || without || { state: PricingState.Unresolved, reason: "Unresolved: response missing" };
    return { scenario: missing, offers: [] };
  }

  const codes = array(withVoucher?.descriptor?.body?.vouchers);
  const unresolvedPairHalf = [without, withVoucher]
    .find((scenario) => scenario.state === PricingState.Unresolved);
  if (unresolvedPairHalf) {
    const reason = unresolvedPairHalf.reason
      || unresolvedPairHalf.total?.reason
      || "Unresolved: comparison unavailable";
    return {
      scenario: unresolvedPairHalf,
      offers: codes.map((code) => ({
        code,
        calculation_evidence: CALCULATED_PAIR_EVIDENCE,
        state: PricingState.Unresolved,
        status: "Unresolved",
        activation: `Voucher ${code} · carried by page · server application unresolved in this scenario`,
        reason,
      })),
    };
  }
  const totalsDiffer = totalCents(without) !== null
    && totalCents(withVoucher) !== null
    && totalCents(without) !== totalCents(withVoucher);
  const activations = codes.map((code) => {
    if (!knownCode(code, withVoucher.descriptor.context, catalog)) {
      return {
        code,
        calculation_evidence: CALCULATED_PAIR_EVIDENCE,
        state: PricingState.Unresolved,
        status: "Unresolved",
        activation: `Voucher ${code} · carried by page · server application unresolved in this scenario`,
        reason: UNRESOLVED_STORE_COUPON,
      };
    }
    const applied = totalsDiffer && attributableDiscount(withVoucher.response, code);
    const state = worstState([without.state, withVoucher.state]);
    return {
      code,
      calculation_evidence: CALCULATED_PAIR_EVIDENCE,
      state,
      status: applied ? "Applied" : "Not applied",
      activation: applied
        ? `Voucher ${code} · carried by page · applied by server in this scenario`
        : `Voucher ${code} · carried by page · not applied by server in this scenario`,
      ...(applied ? { delta: deltaFact(without, withVoucher, "impact") } : {}),
    };
  });
  const applied = activations.some((activation) => activation.status === "Applied");
  return { scenario: applied ? withVoucher : without, offers: activations };
}

function automaticOfferActivations(context, representative, catalog) {
  const response = representative?.response || {};
  const allDiscounts = [
    ...array(response.offer_discounts),
    ...array(response.lines).flatMap((line) => array(line?.discounts)),
    ...array(response.shipping_method?.discounts),
  ];

  return array(context?.attached_offers).filter((offer) => !present(offer?.code)).map((offer) => {
    if (context.page_type === "upsell" || context.page_type === "downsell") {
      return {
        offer_ref_id: offerIdentity(offer) || null,
        name: offer?.name ?? null,
        state: representative?.state || PricingState.Exact,
        status: "Not applied",
        activation: "Attached, not applied in this scenario",
      };
    }
    const applied = allDiscounts.some((discount) =>
      (present(offer?.name) && String(discount?.name) === String(offer.name))
      || (present(offer?.code) && String(discount?.description) === String(offer.code)),
    );
    return {
      offer_ref_id: offerIdentity(offer) || null,
      name: offer?.name ?? null,
      state: representative?.state || PricingState.Exact,
      status: applied ? "Applied" : "Not applied",
      activation: applied ? "Automatic site offer · applied by server" : "Attached, not applied in this scenario",
    };
  });
}

function unattachedVoucherActivations(context, representedCodes) {
  const represented = new Set(representedCodes.map(String));
  return array(context?.attached_offers)
    .filter((offer) => present(offer?.code) && !represented.has(String(offer.code)))
    .map((offer) => ({
      offer_ref_id: offerIdentity(offer) || null,
      name: offer?.name ?? null,
      code: String(offer.code),
      state: PricingState.Exact,
      status: "Not applied",
      activation: "Attached, not applied in this scenario",
    }));
}

function surfaceActivations(scenarios, catalog) {
  const withScenarios = roleScenarios(scenarios, "surface-with");
  return withScenarios.map((withScenario) => {
    const context = withScenario.descriptor.context;
    const without = scenarios.find((candidate) =>
      candidate.descriptor.context.role === "surface-without"
      && candidate.descriptor.context.surface === context.surface
      && String(candidate.descriptor.context.offer_code) === String(context.offer_code),
    );
    const code = context.offer_code;
    const source = context.surface === "exit_intent" ? "Exit intent" : "Promo code";
    if (!knownCode(code, context, catalog)) {
      return {
        code,
        source: context.surface,
        state: PricingState.Unresolved,
        status: "Unresolved",
        activation: `${source} ${code} · if code entered`,
        reason: UNRESOLVED_STORE_COUPON,
      };
    }
    if (!without || withScenario.state === PricingState.Unresolved || without.state === PricingState.Unresolved) {
      return {
        code,
        source: context.surface,
        state: PricingState.Unresolved,
        status: "Unresolved",
        activation: `${source} ${code} · if code entered`,
        reason: without?.reason || withScenario.reason || "Unresolved: comparison unavailable",
      };
    }
    const totalsDiffer = totalCents(without) !== null
      && totalCents(withScenario) !== null
      && totalCents(without) !== totalCents(withScenario);
    const applied = totalsDiffer && attributableDiscount(withScenario.response, code);
    const state = worstState([without.state, withScenario.state]);
    return {
      code,
      source: context.surface,
      state,
      status: applied ? "Applied" : "Not applied",
      activation: `${source} ${code} · if code entered`,
      ...(applied ? { delta: deltaFact(without, withScenario, "impact") } : {}),
    };
  });
}

function bumpDeltas(scenarios, rows) {
  const bumpIndexes = [...new Set(roleScenarios(scenarios, "bump-with").map((scenario) => scenario.descriptor.context.bump_index))];
  const bumpRows = rows.filter((row) => row.is_upsell);
  return bumpIndexes.map((index) => {
    const without = scenarioByIndexedRole(scenarios, "bump-without", "bump_index", index);
    const withBump = scenarioByIndexedRole(scenarios, "bump-with", "bump_index", index);
    const row = bumpRows[Number(index)];
    const delta = deltaFact(without, withBump, "impact");
    const signedDelta = delta.value === "0.00" ? { ...delta, value: "+0.00" } : delta;
    return {
      row_index: row?.row_index ?? null,
      package_id: row?.package_id ?? withBump?.descriptor?.body?.lines?.at(-1)?.package_id ?? null,
      name: row?.name ?? null,
      condition: "if taken",
      ...signedDelta,
    };
  });
}

function pageRows(scenarios) {
  const details = roleScenarios(scenarios, "row").sort((a, b) =>
    Number(a.descriptor.context.row_index) - Number(b.descriptor.context.row_index),
  );
  const source = details.length ? details : [representativeForPage(scenarios, {}).scenario];
  return source.flatMap((scenario) => array(scenario?.rows).map((row, offset) => ({
    ...row,
    row_index: scenario?.descriptor?.context?.row_index ?? offset,
  })));
}

function makePage(scenarios, catalog) {
  const context = pageContext(scenarios);
  const representative = representativeForPage(scenarios, catalog);
  const rows = pageRows(scenarios);
  const carriedCodes = representative.offers.map((offer) => offer.code);
  const surfaceCodes = roleScenarios(scenarios, "surface-with").map((scenario) => scenario.descriptor.context.offer_code);
  const offers = [
    ...representative.offers,
    ...automaticOfferActivations(context, representative.scenario, catalog),
    ...unattachedVoucherActivations(context, [...carriedCodes, ...surfaceCodes]),
    ...surfaceActivations(scenarios, catalog),
  ];
  const calculatedBumps = bumpDeltas(scenarios, rows);
  const pageReason = representative.scenario?.state === PricingState.Unresolved
    ? representative.scenario.reason || representative.scenario?.total?.reason
    : offers.find((offer) => offer.reason === UNRESOLVED_STORE_COUPON)?.reason;
  const visibleRows = pageReason === UNRESOLVED_STORE_COUPON
    ? rows.map((row) => ({
      row_index: row.row_index,
      package_id: row.package_id,
      quantity: row.quantity,
      ...(row.is_upsell ? { is_upsell: true } : {}),
      name: row.name,
      state: PricingState.Unresolved,
      reason: pageReason,
    }))
    : rows;
  const representativeTotal = pageReason
    ? unresolvedFact(pageReason)
    : representative.scenario?.total
      || unresolvedFact("Unresolved: representative scenario unavailable");
  const bumps = pageReason
    ? calculatedBumps.map((bump) => ({
      row_index: bump.row_index,
      package_id: bump.package_id,
      name: bump.name,
      condition: bump.condition,
      ...unresolvedFact(pageReason),
    }))
    : calculatedBumps;
  const states = [representativeTotal.state, ...visibleRows.map((row) => row.state), ...offers.map((offer) => offer.state), ...bumps.map((bump) => bump.state)].filter(Boolean);

  return {
    page_id: context.page_id,
    page_type: context.page_type,
    page_label: context.page_label,
    page_order: context.page_order,
    funnel_id: context.funnel_id,
    decline_condition: context.decline_condition,
    state: worstState(states),
    ...(pageReason ? { reason: pageReason } : {}),
    rows: visibleRows,
    offers,
    representative_total: representativeTotal,
    shipping: pageReason
      ? { present: false, state: PricingState.Unresolved, reason: pageReason }
      : representative.scenario?.shipping || {
        present: false,
        state: PricingState.Unresolved,
        reason: "Unresolved: representative scenario unavailable",
      },
    bumps,
  };
}

function acceptDelta(page) {
  const total = page.representative_total;
  if (total?.state === PricingState.Unresolved) return unresolvedFact(total.reason);
  const cents = moneyToCents(total.value);
  if (cents === null) return unresolvedFact("Unresolved: invalid server money value");
  return moneyFact(signedCents(cents), total.state);
}

function journeySummary(pages) {
  const checkout = pages.find((page) => page.page_type === "checkout");
  const checkoutTotal = checkout?.representative_total
    || unresolvedFact("Unresolved: checkout scenario unavailable");
  const bumps = pages.flatMap((page) => page.bumps.map((bump) => ({ ...bump, page_id: page.page_id })));
  const accepts = pages.filter((page) => page.page_type === "upsell" || page.page_type === "downsell").map((page) => ({
    page_id: page.page_id,
    page_type: page.page_type,
    page_label: page.page_label,
    condition: page.page_type === "downsell" ? page.decline_condition : "if accepted",
    ...acceptDelta(page),
  }));

  const rangeParts = [checkoutTotal, ...bumps, ...accepts.filter((entry) => entry.page_type === "upsell")];
  let range;
  const unresolvedPage = pages.find((page) => page.representative_total?.state === PricingState.Unresolved);
  if (unresolvedPage) {
    range = unresolvedFact(
      unresolvedPage.representative_total.reason || "Unresolved: order range has unresolved page totals",
    );
  } else if (rangeParts.some((part) => part.state === PricingState.Unresolved)) {
    range = unresolvedFact("Unresolved: order range has unresolved components");
  } else {
    const minimum = moneyToCents(checkoutTotal.value);
    const extras = [...bumps, ...accepts.filter((entry) => entry.page_type === "upsell")]
      .map((entry) => moneyToCents(entry.value));
    if (minimum === null || extras.some((entry) => entry === null)) {
      range = unresolvedFact("Unresolved: invalid server money value");
    } else {
      const maximum = minimum + extras.reduce((sum, cents) => sum + cents, 0);
      range = {
        state: worstState(rangeParts.map((part) => part.state)),
        min: centsToUsd(minimum),
        max: centsToUsd(maximum),
        label: CALC_LABEL,
      };
    }
  }

  return {
    representative_checkout_total: checkoutTotal,
    bumps,
    accepts,
    min_max_order_range: range,
  };
}

const unresolvedMoneyKey = /(?:price|amount|delta|range|total|subtotal|savings|recurring_annotation|^min$|^max$|^value$)/i;
const numericMoneyString = /^[+-]?\d+(?:\.\d{1,2})?$/;
const annotatedMoneyString = /\$[+-]?\d+(?:\.\d{1,2})?/;

/**
 * Assert that every Unresolved fact is number-free while allowing exact child
 * facts (for example, surviving single-line rows on an unresolved page).
 */
export function assertUnresolvedFactsHaveNoNumbers(value, path = "journey") {
  if (!value || typeof value !== "object") return value;
  if (value.state === PricingState.Unresolved) {
    Object.entries(value).forEach(([key, child]) => {
      const numeric = typeof child === "number"
        || (typeof child === "string" && (numericMoneyString.test(child)
          || (key === "recurring_annotation" && annotatedMoneyString.test(child))));
      if (unresolvedMoneyKey.test(key) && numeric) {
        throw new TypeError(`Unresolved fact carries numeric field ${path}.${key}`);
      }
    });
  }
  Object.entries(value).forEach(([key, child]) => {
    if (Array.isArray(child)) {
      child.forEach((entry, index) => assertUnresolvedFactsHaveNoNumbers(entry, `${path}.${key}[${index}]`));
    } else {
      assertUnresolvedFactsHaveNoNumbers(child, `${path}.${key}`);
    }
  });
  return value;
}

/**
 * Normalize executed plan results into the transport-independent view model.
 * Responses may be keyed by descriptor id or supplied as an aligned/captured
 * envelope array: { id?, request?, status, response, headers?, meta? }.
 */
export function normalizeJourney(plan, responses, catalog = {}, meta = {}) {
  const descriptors = array(plan);
  const packages = array(catalog?.packages);
  const lookup = responseLookup(descriptors, responses);
  const scenarios = descriptors.map((descriptorValue, index) => normalizeScenario(
    descriptorValue,
    descriptorValue?.unresolved ? undefined : lookup(descriptorValue, index),
    packages,
    meta,
  ));

  const grouped = new Map();
  scenarios.forEach((scenario) => {
    const id = String(scenario.descriptor?.context?.page_id ?? "page");
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(scenario);
  });
  const pages = [...grouped.values()].map((entries) => makePage(entries, catalog)).sort((a, b) => a.page_order - b.page_order);

  const warnings = [];
  scenarios.forEach((scenario) => {
    const requested = scenario.descriptor?.body?.currency;
    const echoed = scenario.currency;
    if (present(requested) && present(echoed) && String(requested) !== String(echoed)) {
      const key = `${requested}:${echoed}`;
      if (!warnings.some((warning) => warning.key === key)) {
        warnings.push({
          key,
          type: "currency_mismatch",
          requested: String(requested),
          actual: String(echoed),
          message: `Requested currency ${requested}; server calculated ${echoed}.`,
        });
      }
    }
  });

  const journeyState = worstState(pages.map((page) => page.state));
  const journeyReason = journeyState === PricingState.Unresolved
    ? pages.find((page) => page.state === PricingState.Unresolved)?.reason
    : null;
  return assertUnresolvedFactsHaveNoNumbers({
    state: journeyState,
    ...(journeyReason ? { reason: journeyReason } : {}),
    label: CALC_LABEL,
    pages,
    summary: pages.length ? journeySummary(pages) : null,
    warnings,
    meta: { ...meta },
  });
}
