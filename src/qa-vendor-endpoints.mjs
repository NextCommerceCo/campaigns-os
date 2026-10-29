// The analytics vendor endpoints a `qa run --test-order` run holds back
// (campaigns-os#689, #683 item 5): one list, read by the browser router that
// answers the beacons locally and by classifyTagFire, so the tag inventory,
// parity and the verdict's vendor evidence all read the same requests.
//
// Vendor keys are the `analytics.vendors` keys Map Builder emits for the
// starter-template vendor adapters (its Route C vendor registry), plus `gtm`
// and `meta` for the SDK providers.
//
// Each entry:
//   - loaders: requests that load the vendor's script. They always pass
//     through: a blocked loader means the vendor function never exists, the
//     adapter stays inactive and the run proves nothing.
//   - beacons: requests that send data to the vendor, matched by host (or a
//     subdomain of it) plus a path prefix, because some hosts serve both
//     (analytics.tiktok.com). A loader match always wins over a beacon match.
//   - id / event: the parameter carrying the vendor id and the event name,
//     read from the query string first and then from the request body (a JSON
//     object or array, dotted paths allowed, or URL-encoded lines). `idPath`
//     reads the id from the URL path instead. null when the request does not
//     name it in a field we could confirm.
//   - purchaseEvents: the event names that mean a purchase for that vendor,
//     as the starter-template adapters send them.
//   - source: where the beacon endpoints were confirmed. Only an endpoint read
//     from the vendor's public loader source or public documentation is wired
//     in; a vendor with none is reported as not intercepted, by name, with
//     `reason`.
//
// Loader sources were fetched read-only with curl on 2026-10-29 and read, never
// executed.

export const VENDOR_KEYS = Object.freeze([
  "gtm",
  "meta",
  "ga4",
  "axon",
  "taboola",
  "triplewhale",
  "tiktok",
  "northbeam",
  "snap",
  "pinterest",
]);

export const VENDOR_ENDPOINTS = Object.freeze([
  {
    vendor: "gtm",
    loaders: [{ host: "www.googletagmanager.com", path: "/gtm.js" }],
    beacons: [],
    id: null,
    event: null,
    purchaseEvents: [],
    reason: "GTM sends no beacon of its own; each tag it loads sends to that tag's vendor, held back here only when the vendor is listed",
  },
  {
    vendor: "meta",
    loaders: [{ host: "connect.facebook.net", path: "/" }],
    beacons: [
      { host: "www.facebook.com", path: "/tr" },
      { host: "www.facebook.com", path: "/privacy_sandbox/" },
    ],
    id: "id",
    event: "ev",
    purchaseEvents: ["Purchase"],
    source: "fbevents.js (connect.facebook.net/en_US/fbevents.js) sends to https://www.facebook.com/tr and https://www.facebook.com/privacy_sandbox/…; id is the pixel id, ev the event name",
  },
  {
    vendor: "ga4",
    loaders: [{ host: "www.googletagmanager.com", path: "/gtag/js" }],
    beacons: [
      { host: "google-analytics.com", path: "/g/" },
      { host: "analytics.google.com", path: "/g/" },
      { host: "stats.g.doubleclick.net", path: "/g/" },
    ],
    id: "tid",
    event: "en",
    purchaseEvents: ["purchase", "upsell_purchase"],
    source: "gtag.js (www.googletagmanager.com/gtag/js) builds https://<region>.google-analytics.com/g/collect, https://analytics.google.com/g/collect and https://stats.g.doubleclick.net/g/collect; tid is the measurement id, en the event name (batched events carry one en per body line)",
  },
  {
    vendor: "axon",
    loaders: [
      { host: "s.axon.ai", path: "/" },
      { host: "c.albss.com", path: "/" },
      { host: "res4.applovin.com", path: "/" },
    ],
    beacons: [{ host: "b.applovin.com", path: "/v1/pixel" }],
    id: "event_key",
    // The payload is built through an obfuscated string table, so the field
    // carrying the event name could not be confirmed.
    event: null,
    purchaseEvents: ["purchase"],
    source: "pixel.js (s.axon.ai/pixel.js) sends to https://b.applovin.com/v1/pixel?event_key=<key>; loader.iife.js (c.albss.com) only loads scripts from res4.applovin.com",
  },
  {
    vendor: "taboola",
    loaders: [{ host: "cdn.taboola.com", path: "/" }],
    beacons: [{ host: "trc.taboola.com", path: "/" }],
    id: null,
    idPath: /^\/(\d+)\//,
    event: "en",
    purchaseEvents: ["make_purchase", "upsell_purchase"],
    source: "tfa.js (cdn.taboola.com/libtrc/unip/<account>/tfa.js) sends to https://trc.taboola.com/<account>/log/3/<type> and trc.taboola.com/sg/; the event name rides as en",
  },
  {
    vendor: "triplewhale",
    // /first returns the pixel source the base snippet evals; conf. serves its
    // config model.
    loaders: [
      { host: "api.config-security.com", path: "/first" },
      { host: "conf.config-security.com", path: "/" },
    ],
    // The purchase request's path is not readable in the obfuscated pixel, so
    // every non-loader path on the API host is held back.
    beacons: [
      { host: "api.config-security.com", path: "/" },
      { host: "api.whaledb.io", path: "/keep-alive" },
    ],
    id: "host",
    event: "action",
    purchaseEvents: ["Purchase", "UpsellPurchase"],
    source: "the Triple Pixel headless base snippet (starter-template analytics-head.html) POSTs JSON {action, host, …} to https://api.config-security.com/event and loads the pixel from /first; the pixel's decoded string table names https://api.config-security.com and https://api.whaledb.io/keep-alive",
  },
  {
    vendor: "tiktok",
    loaders: [{ host: "analytics.tiktok.com", path: "/i18n/pixel/" }],
    beacons: [
      { host: "analytics.tiktok.com", path: "/api/v2/" },
      { host: "analytics-ipv6.tiktokw.us", path: "/" },
    ],
    id: "context.pixel.code",
    event: "event",
    purchaseEvents: ["Purchase", "CompletePayment"],
    source: "the TikTok pixel main script (analytics.tiktok.com/i18n/pixel/static/main.<id>.js) sends to https://analytics.tiktok.com/api/v2/pixel (and /api/v2/performance, /interaction, /monitor, /pixel/act) and https://analytics-ipv6.tiktokw.us/ipv6/enrich_ipv6; the JSON body carries event and context.pixel.code",
  },
  {
    vendor: "northbeam",
    loaders: [{ host: "j.northbeam.io", path: "/" }],
    beacons: [],
    id: null,
    event: null,
    purchaseEvents: [],
    reason: "beacon endpoint unconfirmed: the loader (j.northbeam.io/ota-sp/<client id>.js) is per client and the public Northbeam docs name no beacon host",
  },
  {
    vendor: "snap",
    loaders: [{ host: "sc-static.net", path: "/" }],
    beacons: [
      { host: "tr.snapchat.com", path: "/" },
      { host: "tr6.snapchat.com", path: "/" },
      { host: "tr-shadow.snapchat.com", path: "/" },
    ],
    id: "pid",
    event: "ev",
    purchaseEvents: ["PURCHASE"],
    source: "scevent.min.js (sc-static.net/scevent.min.js) sends to https://tr.snapchat.com (tr6. and tr-shadow. variants) at /p and /cm/*; the JSON body carries pid and ev",
  },
  {
    vendor: "pinterest",
    loaders: [
      { host: "s.pinimg.com", path: "/" },
      { host: "ct.pinterest.com", path: "/static/" },
      { host: "ct.pinterest.com", path: "/ct.html" },
    ],
    beacons: [
      { host: "ct.pinterest.com", path: "/v3/" },
      { host: "ct.pinterest.com", path: "/user/" },
      { host: "ct.pinterest.com", path: "/stats/" },
    ],
    id: "tid",
    event: "event",
    purchaseEvents: ["checkout"],
    source: "core.js (s.pinimg.com/ct/core.js) loads s.pinimg.com/ct/lib/main.<hash>.js, which sends to https://ct.pinterest.com/v3/, /user/ and /stats/; Pinterest's base-code docs give the fallback https://ct.pinterest.com/v3/?event=init&tid=<tag id>",
  },
]);

const BY_VENDOR = new Map(VENDOR_ENDPOINTS.map((entry) => [entry.vendor, entry]));

// The vendors whose beacons are held back, and the ones that are not, with why.
export const INTERCEPTED_VENDORS = Object.freeze(VENDOR_ENDPOINTS.filter((entry) => entry.beacons.length > 0).map((entry) => entry.vendor));
export const NOT_INTERCEPTED_VENDORS = Object.freeze(
  VENDOR_ENDPOINTS.filter((entry) => entry.beacons.length === 0).map((entry) => ({ vendor: entry.vendor, reason: entry.reason })),
);

// Bounds on what one request can contribute: the body read and the ids and
// event names kept from it.
const MAX_BODY_CHARS = 64 * 1024;
const MAX_FIELD_CHARS = 128;

export function vendorEndpoint(vendor) {
  return BY_VENDOR.get(vendor) || null;
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

// A path prefix matches whole segments: "/tr" is /tr and /tr/…, never /trust.
function matches(matcher, host, path) {
  if (!hostMatches(host, matcher.host)) return false;
  const prefix = matcher.path;
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function parseUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// The listed vendor whose BEACON this URL is, or null. A loader is never a
// beacon, even on a host that also serves beacons.
export function vendorBeaconFor(urlValue) {
  const url = parseUrl(urlValue);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (VENDOR_ENDPOINTS.some((entry) => entry.loaders.some((loader) => matches(loader, host, path)))) return null;
  return VENDOR_ENDPOINTS.find((entry) => entry.beacons.some((beacon) => matches(beacon, host, path))) || null;
}

function boundedText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, MAX_FIELD_CHARS) : null;
}

// A request body as records: each JSON object (a top-level array is a batch)
// or each URL-encoded line (GA4 batches one event per line).
function bodyRecords(body) {
  if (typeof body !== "string" || !body) return [];
  const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => ({ json: item }));
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => ({ params: new URLSearchParams(line) }));
  }
}

function recordField(record, name) {
  if (record.params) return record.params.get(name);
  let value = record.json;
  for (const key of name.split(".")) {
    if (!value || typeof value !== "object") return null;
    value = value[key];
  }
  return value;
}

// One request to a listed beacon endpoint, read for evidence: the vendor, the
// ids and event names it carries, and whether one of those events is a
// purchase (null when the entry reads no event name). Nothing else from the
// URL or body is kept; `endpoint` is origin + path only.
export function readVendorBeacon(urlValue, body = null) {
  const entry = vendorBeaconFor(urlValue);
  if (!entry) return null;
  const url = parseUrl(urlValue);
  const records = bodyRecords(body);
  const read = (name) => {
    if (!name) return [];
    const values = [url.searchParams.get(name), ...records.map((record) => recordField(record, name))];
    return [...new Set(values.map(boundedText).filter(Boolean))];
  };
  const ids = entry.idPath ? [boundedText(url.pathname.match(entry.idPath)?.[1])].filter(Boolean) : read(entry.id);
  const events = read(entry.event);
  return {
    vendor: entry.vendor,
    endpoint: `${url.origin}${url.pathname}`,
    ids,
    events,
    purchase: entry.event ? events.some((event) => entry.purchaseEvents.includes(event)) : null,
  };
}

// The vendors a CampaignSpec analytics block configures, as vendor keys:
// analytics.vendors (the Map Builder shape), providers
// keyed by vendor (facebook is meta) and out-of-band pixels. Disabled entries
// and an analytics block switched off configure nothing.
const VENDOR_ALIASES = Object.freeze({ facebook: "meta", triplepixel: "triplewhale", snapchat: "snap" });

export function configuredVendors(analytics) {
  if (!analytics || typeof analytics !== "object" || Array.isArray(analytics)) return [];
  if (analytics.enabled === false || analytics.mode === "disabled") return [];
  const found = new Set();
  const add = (name) => {
    const key = VENDOR_ALIASES[String(name).toLowerCase()] || String(name).toLowerCase();
    if (BY_VENDOR.has(key)) found.add(key);
  };
  for (const block of [analytics.vendors, analytics.providers]) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [name, value] of Object.entries(block)) {
      if (value && typeof value === "object" && value.enabled !== false) add(name);
    }
  }
  for (const pixel of Array.isArray(analytics.out_of_band_pixels) ? analytics.out_of_band_pixels : []) {
    if (pixel?.vendor) add(pixel.vendor);
  }
  return VENDOR_KEYS.filter((key) => found.has(key));
}
