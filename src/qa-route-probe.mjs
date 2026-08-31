// Route probe: the reachability half of `qa resolve`.
//
// Doctrine: `qa resolve` derives every route URL from the packet — the packet
// is the authority on where a campaign is served — and until #273 it reported
// `ready` on that derivation alone, never asking the deployment whether the
// URLs it just printed exist. Pointed at a host serving the same campaign under
// a different route root it printed nine entry URLs and `ready`; all nine were
// 404, and the three checkpoints below them also said `pass` because they read
// the packet rather than the deployment. The existing operator guidance —
// "empty Entry URLs mean a dead preview or a wrong --base-url" — does not cover
// that case, because the URLs are non-empty and all wrong.
//
// So resolve probes what it derived. Two rules shape the module:
//
//   1. A derivation is not a verification. `ready` now means the routes were
//      probed AND resolved; a route set that does not resolve gets its own
//      terminal status naming the first URL that failed.
//   2. Probing must never make resolve unusable. An HTTP response saying 404 is
//      evidence about the deployment; a transport error is evidence about this
//      machine's network, which is not the deployment's fault. The first fails
//      the probe, the second degrades to a named `not_probed` state that stays
//      usable offline and in CI.

export const ROUTE_PROBE_STATUSES = Object.freeze(["pass", "failed", "not_probed"]);
export const ROUTE_PROBE_OUTCOMES = Object.freeze(["resolved", "unresolved", "unreachable", "skipped"]);

export const ROUTE_PROBE_DEFAULT_TIMEOUT_MS = 5000;
// Entry URLs are one per funnel, so a real campaign is well inside this. The
// cap exists so a pathological topology cannot turn a diagnostic command into
// an unbounded network sweep; anything past it is reported as skipped rather
// than silently dropped.
export const ROUTE_PROBE_MAX_URLS = 25;
const ROUTE_PROBE_CONCURRENCY = 6;
// A static host that refuses HEAD is answering about the method, not the route.
const METHOD_NOT_SUPPORTED = new Set([405, 501]);

/**
 * Probe one URL. A response — any response — is evidence about the deployment;
 * a throw is evidence about the transport between here and it.
 */
export async function probeOneUrl(url, { timeoutMs = ROUTE_PROBE_DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const attempt = async (method) => fetchImpl(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    let method = "HEAD";
    let response = await attempt(method);
    if (METHOD_NOT_SUPPORTED.has(Number(response?.status))) {
      method = "GET";
      response = await attempt(method);
    }
    const httpStatus = Number(response?.status);
    return {
      url,
      outcome: httpStatus >= 400 ? "unresolved" : "resolved",
      method,
      http_status: Number.isFinite(httpStatus) ? httpStatus : null,
      error: null,
    };
  } catch (error) {
    return {
      url,
      outcome: "unreachable",
      method: "HEAD",
      http_status: null,
      error: transportErrorText(error, timeoutMs),
    };
  }
}

function transportErrorText(error, timeoutMs) {
  if (error?.name === "TimeoutError") return `no response within ${timeoutMs}ms`;
  const cause = error?.cause?.code || error?.code || null;
  const message = String(error?.message || error || "transport error");
  return cause ? `${message} (${cause})` : message;
}

async function probeAll(urls, options) {
  const results = new Array(urls.length);
  let cursor = 0;
  const worker = async () => {
    for (let index = cursor++; index < urls.length; index = cursor++) {
      results[index] = await probeOneUrl(urls[index], options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ROUTE_PROBE_CONCURRENCY, urls.length) }, worker),
  );
  return results;
}

/**
 * The route root this resolve derived, with the packet's public_route_slug
 * stripped back off.
 *
 * `resolve` appends `public_route_slug` unconditionally, so no documented input
 * points the harness at a deployment served under a different route root — the
 * packet is the authority, and that is intended. The failure mode is what was
 * not intended: the operator saw `ready` rather than a message saying so. When
 * every derived route is dead, one extra probe of the host without the slug
 * separates "this deployment is down" from "this deployment does not serve the
 * slug this packet declares", which is the actionable half.
 */
export function baseUrlWithoutSlug(baseUrl, publicRouteSlug) {
  const slug = String(publicRouteSlug || "").trim().replace(/^\/+|\/+$/g, "");
  if (!slug || !baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1) !== slug) return null;
    url.pathname = `/${segments.slice(0, -1).join("/")}${segments.length > 1 ? "/" : ""}`;
    return url.toString();
  } catch {
    return null;
  }
}

function summarize(results) {
  const counts = { resolved: 0, unresolved: 0, unreachable: 0, skipped: 0 };
  for (const result of results) counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  return counts;
}

function describeFailure(result) {
  if (!result) return "";
  return result.outcome === "unresolved"
    ? `${result.url} (HTTP ${result.http_status})`
    : `${result.url} (${result.error})`;
}

/**
 * Probe the entry URLs resolve just derived.
 *
 * @returns {{
 *   status: "pass"|"failed"|"not_probed",
 *   code: string,
 *   reason: string,
 *   counts: { resolved: number, unresolved: number, unreachable: number, skipped: number },
 *   first_failure: object|null,
 *   results: object[],
 *   route_root_hint: object|null,
 * }}
 */
export async function probeRouteUrls({
  entryUrls = [],
  baseUrl = null,
  publicRouteSlug = null,
  enabled = true,
  timeoutMs = ROUTE_PROBE_DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  skippedReason = null,
} = {}) {
  const urls = [];
  const seen = new Set();
  for (const entry of Array.isArray(entryUrls) ? entryUrls : []) {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string" || !url.trim() || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  const notProbed = (code, reason, results = []) => ({
    status: "not_probed",
    code,
    reason,
    counts: summarize(results),
    first_failure: null,
    results,
    route_root_hint: null,
  });

  if (!urls.length) {
    return notProbed(
      "route_probe.no_routes",
      "No entry URLs were derived, so there was nothing to probe. An empty Entry URL list means a dead preview or a missing --base-url.",
    );
  }
  if (!enabled) {
    return notProbed(
      "route_probe.disabled",
      `Route probing is off${skippedReason ? ` (${skippedReason})` : ""}; the ${urls.length} derived entry URL(s) were not checked against the deployment.`,
      urls.map((url) => ({ url, outcome: "skipped", method: null, http_status: null, error: null })),
    );
  }

  const probeUrls = urls.slice(0, ROUTE_PROBE_MAX_URLS);
  const skipped = urls.slice(ROUTE_PROBE_MAX_URLS)
    .map((url) => ({ url, outcome: "skipped", method: null, http_status: null, error: null }));
  const results = [...await probeAll(probeUrls, { timeoutMs, fetchImpl }), ...skipped];
  const counts = summarize(results);

  if (counts.unresolved > 0) {
    const firstFailure = results.find((result) => result.outcome === "unresolved");
    const hint = await routeRootHint({ results, baseUrl, publicRouteSlug, timeoutMs, fetchImpl });
    const scope = counts.resolved === 0
      ? `All ${counts.unresolved} derived entry URL(s) are dead on this host`
      : `${counts.unresolved} of ${counts.unresolved + counts.resolved} derived entry URL(s) are dead on this host`;
    return {
      status: "failed",
      code: "route_probe.routes_unresolved",
      // The route-root diagnosis is long and belongs in exactly one place, so
      // it stays on route_root_hint.reason rather than being inlined here too.
      reason: `${scope}. First failure: ${describeFailure(firstFailure)}.`,
      counts,
      first_failure: firstFailure,
      results,
      route_root_hint: hint,
    };
  }

  if (counts.resolved === 0) {
    const firstFailure = results.find((result) => result.outcome === "unreachable");
    return {
      ...notProbed(
        "route_probe.unreachable",
        `No entry URL could be reached, so the route set is unverified rather than proven dead — a transport failure is evidence about this machine's network, not about the deployment. First failure: ${describeFailure(firstFailure)}.`,
        results,
      ),
      first_failure: firstFailure,
    };
  }

  return {
    status: "pass",
    code: "route_probe.all_resolved",
    reason: counts.unreachable
      ? `${counts.resolved} entry URL(s) resolved; ${counts.unreachable} could not be reached from this machine.`
      : `All ${counts.resolved} derived entry URL(s) resolved on this host.`,
    counts,
    first_failure: null,
    results,
    route_root_hint: null,
  };
}

async function routeRootHint({ results, baseUrl, publicRouteSlug, timeoutMs, fetchImpl }) {
  // Only worth asking when the slug-rooted derivation is dead across the board.
  if (results.some((result) => result.outcome === "resolved")) return null;
  const withoutSlug = baseUrlWithoutSlug(baseUrl, publicRouteSlug);
  if (!withoutSlug) return null;
  const probe = await probeOneUrl(withoutSlug, { timeoutMs, fetchImpl });
  const slug = String(publicRouteSlug || "").trim().replace(/^\/+|\/+$/g, "");
  if (probe.outcome !== "resolved") {
    return {
      code: "route_probe.host_also_dead",
      probed_url: withoutSlug,
      result: probe,
      reason: `${withoutSlug} does not resolve either, so the preview itself is likely dead rather than served under a different route root.`,
    };
  }
  return {
    code: "route_probe.route_root_mismatch",
    probed_url: withoutSlug,
    result: probe,
    reason: `${withoutSlug} resolves but ${baseUrl} does not, so this host does not serve the campaign under the packet's public_route_slug "${slug}". resolve appends that slug from the packet on purpose — the packet is the authority on where the campaign is served — so the fix is to correct campaign.public_route_slug (or declare campaign.route_root) in the packet, not to pass a different --base-url.`,
  };
}
