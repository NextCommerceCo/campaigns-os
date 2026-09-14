// Route identity: the served-route vocabulary every stage reads a campaign by.
// A campaign has one — `public_route_slug` (always required; the `_site/<slug>/`
// build directory) and `route_root` (where the funnel is SERVED: "/" for a
// root-served campaign, otherwise "/<slug>/") — and every stage that composes,
// strips or compares a route reads it from here, so no two stages can drift
// into two rules. A leaf on purpose: pure string work, no imports.

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

// The two ways a declared route_root is read, named by the artifact carrying
// it. Both return "/", "/<slug>/", or null for a value that is not honoured;
// neither ever roots a check on a foreign or malformed prefix.
//
// A packet carries the canonical form and nothing else (the shape its schema
// accepts), so only exactly "/" or "/<slug>/" is honoured. A near miss
// ("/slug", "//slug//", "/Slug/") is a hand edit doctor blocks by name; reading
// it more generously anywhere else would let one stage block and another pass
// the same packet.
export function packetRouteRoot(declared, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const clean = typeof declared === "string" ? declared.trim() : "";
  if (clean === "/") return "/";
  if (slug && clean === `/${slug}/`) return clean;
  return null;
}

// A spec is intake: prepare-build canonicalises what it declares, so any
// spelling of the slug ("/slug", "slug/") reads as "/<slug>/"; only a foreign
// prefix is refused.
export function intakeRouteRoot(declared, publicRouteSlug) {
  const slug = normalizePublicRouteSlug(publicRouteSlug);
  const clean = typeof declared === "string" ? declared.trim() : "";
  if (!clean) return null;
  if (clean === "/") return "/";
  if (slug && normalizePublicRouteSlug(clean) === slug) return `/${slug}/`;
  return null;
}

// The one resolver: the first declared route_root (packet, then spec, then raw
// spec) read under its own artifact's rule, else the slug-prefixed default
// "/<slug>/" (null with no slug). It says what it read and whether it was
// honoured, so a caller that records discards (QA) and one that only wants the
// root (doctor) share one answer:
//   { route_root, declared, source: "packet" | "spec" | "raw_spec" | null,
//     accepted: true | false | null }   // null: nothing declared
// `publicRouteSlug` omitted (undefined) means "the packet's own slug"; passed
// explicitly — even null or "" — it is used as given, so a caller that resolved
// the slug from wider evidence (deploy path, spec) is never second-guessed by
// the packet, and an explicit "no slug" yields route_root null.
export function resolveRouteRoot({ packet = null, spec = null, rawSpec = null, publicRouteSlug } = {}) {
  const slug = normalizePublicRouteSlug(publicRouteSlug === undefined ? packet?.campaign?.public_route_slug : publicRouteSlug);
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

// The packet's served root: "/" for a root-served campaign (whole funnel at
// site-root paths, no slug prefix), "/<slug>/" otherwise, null when neither is
// derivable. route_root only changes how SERVED routes are composed and
// validated; built output stays at _site/<public_route_slug>/. A declaration
// the packet rule does not honour falls through to the slug default, and
// doctor's validateRouteRootDeclaration raises the named blocker.
export function campaignRouteRoot(packet) {
  return resolveRouteRoot({ packet }).route_root;
}
