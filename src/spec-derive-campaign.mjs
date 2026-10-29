// `campaigns-os spec derive`, live campaign half (#721): refresh the offer and
// package fields the CampaignSpec mirrors from the Campaigns App.
//
// Field classes (#432): a page package's ref, name, price, product, variant
// and availability are mirrored from the Campaigns App's packages; the offer
// records (`offers[]`, and the copy a page carries in `pages[].offers[]`) are
// mirrored from its offers. Which packages and offers a page carries, and a
// package's qty and role flags (is_upsell, is_order_bump, default_selected,
// configurable), are authored and never written here. A price is owned by the
// Campaigns App: it reaches the spec only from the live campaign, never from
// the repo.
//
// The live campaign is the body of the one read-only GET of
// `{proxy-base}/api/campaign` that doctor and `qa run` already make under the
// public campaign key (live-campaign-refs.mjs). This module is pure: it
// plans rows in spec-derive.mjs's shape from the spec and that body, and
// spec-derive.mjs applies them under its write guard.

// The page package fields the live campaign is the authority for.
export const MIRRORED_PACKAGE_FIELDS = Object.freeze([
  "name",
  "price",
  "price_retail",
  "product_name",
  "product_sku",
  "product_variant_name",
  "product_purchase_availability",
  "product_inventory_availability",
  "image",
]);

// The offer record fields (root `offers[]`), and the subset a page's copy
// (`pages[].offers[]`) carries.
export const MIRRORED_OFFER_FIELDS = Object.freeze(["name", "type", "code", "condition", "benefit", "packages"]);
export const MIRRORED_PAGE_OFFER_FIELDS = Object.freeze(["name", "type", "code", "condition", "benefit"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A ref as the campaign states it, compared as its string form (5 and "5"
// are one ref), or null when the entry carries none.
function refOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function canonicalJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function pathLabel(path) {
  return path.map((segment, index) => (typeof segment === "number" ? `[${segment}]` : `${index ? "." : ""}${segment}`)).join("");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Every active page with the JSON path it lives at, as spec-derive.mjs reads
// them (funnels[] first; the legacy funnel_pages[] only without it).
function activePagesWithPaths(spec) {
  const pages = [];
  const visit = (page, path) => {
    if (isPlainObject(page) && page.enabled !== false && typeof page.id === "string" && page.id.trim()) pages.push({ page, path });
  };
  if (Array.isArray(spec?.funnels)) {
    spec.funnels.forEach((funnel, funnelIndex) => {
      (Array.isArray(funnel?.pages) ? funnel.pages : []).forEach((page, pageIndex) => visit(page, ["funnels", funnelIndex, "pages", pageIndex]));
    });
  } else if (Array.isArray(spec?.funnel_pages)) {
    spec.funnel_pages.forEach((page, index) => visit(page, ["funnel_pages", index]));
  }
  return pages;
}

function indexByRef(list) {
  const map = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    const ref = isPlainObject(entry) ? refOf(entry.ref_id) : null;
    if (ref && !map.has(ref)) map.set(ref, entry);
  }
  return map;
}

// The rows that bring one mirrored record in line with the live one: a field
// the live record states is written when the spec's value differs, and only
// where the spec already carries the key or the live value is not null, so a
// refresh does not pad the spec with empty keys.
function mirrorRows({ record, live, fields, path, source, pageId = null }) {
  const changes = [];
  const unchanged = [];
  for (const field of fields) {
    if (!Object.hasOwn(live, field) || live[field] === undefined) continue;
    const before = Object.hasOwn(record, field) ? record[field] : undefined;
    if (before === undefined && live[field] === null) continue;
    const row = { field: pathLabel([...path, field]), path: [...path, field], before: clone(before), after: clone(live[field]), source, ...(pageId ? { page_id: pageId } : {}) };
    if (canonicalJson(before) === canonicalJson(live[field])) unchanged.push(row);
    else changes.push(row);
  }
  return { changes, unchanged };
}

/**
 * The plan for the mirrored offer and package fields: `changes` and
 * `unchanged` rows in spec-derive.mjs's shape, `not_derived` for a record the
 * spec lists that the live campaign does not serve (reported, never removed:
 * which records a page carries is authored), and `summary` counts. `campaign`
 * is the live campaign body; `campaignRef` names it in each row's source.
 */
export function planCampaignMirrorDerive({ spec, campaign, campaignRef = null } = {}) {
  const changes = [];
  const unchanged = [];
  const notDerived = [];
  const ref = campaignRef || refOf(campaign?.ref_id ?? campaign?.id);
  const source = `the Campaigns App campaign${ref ? ` ${ref}` : ""} (GET /api/campaign)`;
  const livePackages = indexByRef(campaign?.packages);
  const liveOffers = Array.isArray(campaign?.offers) ? indexByRef(campaign.offers) : null;
  const summary = { packages_checked: 0, offers_checked: 0, offers_added: 0 };

  for (const { page, path } of activePagesWithPaths(spec)) {
    (Array.isArray(page.packages) ? page.packages : []).forEach((pkg, index) => {
      if (!isPlainObject(pkg)) return;
      const pkgRef = refOf(pkg.ref_id);
      const pkgPath = [...path, "packages", index];
      if (!pkgRef) return;
      const live = livePackages.get(pkgRef);
      if (!live) {
        notDerived.push({ field: pathLabel(pkgPath), page_id: page.id, reason: "package_not_live", detail: `page "${page.id}" carries package ${pkgRef}, which the live campaign does not serve; nothing was changed. Point the page at a package the campaign serves, or restore it in the Campaigns App.` });
        return;
      }
      summary.packages_checked += 1;
      const rows = mirrorRows({ record: pkg, live, fields: MIRRORED_PACKAGE_FIELDS, path: pkgPath, source, pageId: page.id });
      changes.push(...rows.changes);
      unchanged.push(...rows.unchanged);
    });
    (Array.isArray(page.offers) ? page.offers : []).forEach((offer, index) => {
      if (!isPlainObject(offer) || !liveOffers) return;
      const offerRef = refOf(offer.ref_id);
      const offerPath = [...path, "offers", index];
      if (!offerRef) return;
      const live = liveOffers.get(offerRef);
      if (!live) {
        notDerived.push({ field: pathLabel(offerPath), page_id: page.id, reason: "offer_not_live", detail: `page "${page.id}" carries offer ${offerRef}, which the live campaign does not serve; nothing was changed. Remove it from the page, or restore it in the Campaigns App.` });
        return;
      }
      const rows = mirrorRows({ record: offer, live, fields: MIRRORED_PAGE_OFFER_FIELDS, path: offerPath, source, pageId: page.id });
      changes.push(...rows.changes);
      unchanged.push(...rows.unchanged);
    });
  }

  if (!liveOffers) {
    if (Array.isArray(spec?.offers) && spec.offers.length) {
      notDerived.push({ field: "offers", reason: "offers_not_in_live_campaign", detail: "the live campaign read carried no offers list, so the spec's offer records were not refreshed." });
    }
  } else if (!Array.isArray(spec?.offers)) {
    const records = [...liveOffers.values()].map((live) => recordFromLive(live));
    if (records.length) {
      changes.push({ field: "offers", path: ["offers"], before: spec?.offers === undefined ? undefined : clone(spec.offers), after: records, source });
      summary.offers_added = records.length;
    }
  } else {
    const seen = new Set();
    spec.offers.forEach((offer, index) => {
      if (!isPlainObject(offer)) return;
      const offerRef = refOf(offer.ref_id);
      if (!offerRef) return;
      seen.add(offerRef);
      const live = liveOffers.get(offerRef);
      if (!live) {
        notDerived.push({ field: `offers[${index}]`, reason: "offer_not_live", detail: `offer ${offerRef} is in the spec's offers but not in the live campaign; it was kept, since pages may still name it. Remove it, or restore it in the Campaigns App.` });
        return;
      }
      summary.offers_checked += 1;
      const rows = mirrorRows({ record: offer, live, fields: MIRRORED_OFFER_FIELDS, path: ["offers", index], source });
      changes.push(...rows.changes);
      unchanged.push(...rows.unchanged);
    });
    let next = spec.offers.length;
    for (const [offerRef, live] of liveOffers) {
      if (seen.has(offerRef)) continue;
      changes.push({ field: `offers[${next}]`, path: ["offers", next], op: "insert", before: undefined, after: recordFromLive(live), source });
      next += 1;
      summary.offers_added += 1;
    }
  }
  return { changes, unchanged, not_derived: notDerived, summary };
}

// An offer record as the spec stores one: its ref and the mirrored fields the
// live offer states.
function recordFromLive(live) {
  const record = { ref_id: live.ref_id };
  for (const field of MIRRORED_OFFER_FIELDS) if (Object.hasOwn(live, field) && live[field] !== undefined) record[field] = clone(live[field]);
  return record;
}
