// Route identity: the served-route vocabulary every stage reads a campaign by.
//
// A campaign has one route identity — `public_route_slug` (always required, the
// `_site/<slug>/` build directory) and `route_root` (where the funnel is SERVED:
// "/" for a root-served campaign, otherwise "/<slug>/") — and every stage that
// composes, strips or compares a route must read it the same way. Until this
// module existed, `cli.mjs`, `qa-node.mjs`, `source-html-intake.mjs` and
// `page-kit-campaign-config.mjs` each carried their own copy of the helpers
// below (qa-node cannot import cli.mjs, which lazy-imports qa-node), and two of
// them had drifted into two acceptance rules for a declared `route_root`.
//
// A leaf on purpose: pure string work, no imports, so any module can import it.

export function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// The slug as identity: trimmed, no leading or trailing slashes, "" when absent.
export function normalizePublicRouteSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

// A page-kit route: `<segments>/` with no leading slash, no query, no fragment,
// no `.html`/`index.html`; "" when there is no route; an absolute http(s) URL
// is passed through untouched.
export function normalizePageKitRoute(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isAbsoluteHttpUrl(raw)) return raw;

  const clean = raw
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/?index\.html$/i, "")
    .replace(/\.html$/i, "")
    .replace(/^\/+|\/+$/g, "");

  return clean ? `${clean}/` : "";
}

// The route with the slug prefix removed, when it carries one: "slug/checkout/"
// → "checkout/", "slug/" → "", "checkout/" → "checkout/".
export function stripPublicRoutePrefix(route, publicRouteSlug) {
  const normalized = normalizePageKitRoute(route);
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  if (!normalized || !slug) return normalized;
  const clean = normalized.replace(/^\/+|\/+$/g, "");
  if (clean === slug) return "";
  if (clean.startsWith(`${slug}/`)) return `${clean.slice(slug.length + 1).replace(/\/?$/, "/")}`;
  return normalized;
}

// A CampaignSpec route value reduced to the runtime-relative route the SDK
// composes onto the served root: the slug prefix stripped, and a nested value
// reduced to its terminal segment ("a/b/checkout/" → "checkout/").
export function runtimeRelativeRouteForSpecValue(value, publicRouteSlug) {
  const normalized = normalizePageKitRoute(value);
  if (!normalized) return "";
  const stripped = stripPublicRoutePrefix(normalized, publicRouteSlug);
  const segments = stripped.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length > 1) return `${segments[segments.length - 1]}/`;
  return stripped;
}

// The two ways a declared route_root can be read, named by the artifact that
// carries it. Both return "/", "/<slug>/", or null for a value that is not
// honoured; neither ever roots a check on a foreign or malformed prefix.
//
// A packet carries the canonical form and nothing else — the same shape the
// packet schema accepts — so only exactly "/" or exactly "/<slug>/" is
// honoured. A near miss ("/slug", "//slug//", "/Slug/") is a hand edit doctor
// blocks by name; reading it more generously anywhere else would recreate the
// silent split where one stage blocks and another passes the same packet.
export function packetRouteRoot(declared, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const clean = typeof declared === "string" ? declared.trim() : "";
  if (clean === "/") return "/";
  if (slug && clean === `/${slug}/`) return clean;
  return null;
}

// A spec is intake: prepare-build canonicalises what it declares, so any
// spelling that names the slug ("/slug", "slug/", "/slug/") reads as
// "/<slug>/"; only a foreign prefix is refused.
export function intakeRouteRoot(declared, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const clean = typeof declared === "string" ? declared.trim() : "";
  if (!clean) return null;
  if (clean === "/") return "/";
  if (slug && normalizePublicRouteSlug(clean) === slug) return `/${slug}/`;
  return null;
}

// The one resolver. Reads the first declared route_root — the packet, then
// the canonical spec, then the raw spec — under the rule for the artifact it
// came from, and falls back to the slug-prefixed default "/<slug>/" (null when
// no slug is known). The result says what was read and whether it was
// honoured, so a caller that records discards (QA) and a caller that only
// wants the root (doctor) share one answer:
//   { route_root, declared, source: "packet" | "spec" | "raw_spec" | null,
//     accepted: true | false | null }
// `accepted` is null when nothing was declared; false means `declared` was
// read from `source` and NOT honoured, and `route_root` is the default.
export function resolveRouteRoot({ packet = null, spec = null, rawSpec = null, publicRouteSlug } = {}) {
  const slug = normalizePublicRouteSlug(publicRouteSlug !== undefined ? publicRouteSlug : packet?.campaign?.public_route_slug);
  const fallback = slug ? `/${slug}/` : null;
  const declarations = [
    ["packet", packet?.campaign?.route_root, packetRouteRoot],
    ["spec", spec?.spec_identity?.route_root, intakeRouteRoot],
    ["spec", spec?.campaign?.route_root, intakeRouteRoot],
    ["raw_spec", rawSpec?.spec_identity?.route_root, intakeRouteRoot],
    ["raw_spec", rawSpec?.campaign?.route_root, intakeRouteRoot],
  ];
  for (const [source, value, rule] of declarations) {
    const declared = typeof value === "string" ? value.trim() : "";
    if (!declared) continue;
    const honoured = rule(declared, slug);
    return { route_root: honoured ?? fallback, declared, source, accepted: honoured !== null };
  }
  return { route_root: fallback, declared: null, source: null, accepted: null };
}

// Root-served campaigns: a campaign whose whole funnel is served from the SITE
// ROOT (/checkout-v2, /oto, /receipt — no slug prefix) declares
// campaign.route_root "/". Absent route_root defaults to "/<public_route_slug>/",
// so existing packets are unchanged. public_route_slug stays required identity
// and stays the _site/<public_route_slug>/ built-output directory; route_root
// only changes how SERVED routes (routing metas, public routes, live URLs) are
// composed and validated. Returns "/", "/<slug>/", or null when neither is
// derivable. A malformed or foreign declaration never roots a check: it falls
// through to the slug default, and doctor's validateRouteRootDeclaration
// raises the named blocker.
export function campaignRouteRoot(packet) {
  return resolveRouteRoot({ packet }).route_root;
}
