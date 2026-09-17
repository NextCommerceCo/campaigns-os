// The one fetch of a CampaignSpec by Map ID. `start`/`prepare-build --map-id`
// and packet-less `qa run --map-id` both read the same endpoint and must apply
// the same response rules; a second, more lenient reading once lived in the
// QA runner (which cannot import the CLI) and returned an `{ ok: false }`
// error body as the spec. A leaf: no imports.

export const DEFAULT_PROXY_BASE = "https://campaign-map.nextcommerce.com";

/**
 * Fetch a CampaignSpec by Map ID from the proxy Worker.
 *
 * The Map Builder portal at campaign-map.nextcommerce.com is fronted by
 * a backend service that persists saved specs and exposes them via
 * GET /api/spec/<map-id>. Response shape is
 * { ok: true, data: <spec> } or { ok: false, error: <message> } on a
 * 200 with a logical failure.
 *
 * `fetchImpl` is parameterized for tests so a local mock server can
 * stand in for the deployed Worker.
 *
 * @param {string} mapId — saved Map Builder identity (e.g. "veyra-v1-knp4")
 * @param {object} [opts]
 * @param {string} [opts.proxyBase] — proxy origin without trailing slash
 * @param {Function} [opts.fetchImpl] — fetch shim for testing
 * @returns {Promise<object>} parsed CampaignSpec
 */
export async function fetchSpecByMapId(mapId, opts = {}) {
  const trimmed = String(mapId || "").trim();
  if (!trimmed) throw new Error("fetchSpecByMapId: mapId is required.");
  const base = (opts.proxyBase || DEFAULT_PROXY_BASE).replace(/\/+$/, "");
  const url = `${base}/api/spec/${encodeURIComponent(trimmed)}`;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  }
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw specFetchError(`Spec fetch network error: ${error.message} (${url})`, { kind: "network" });
  }
  if (!res.ok) {
    throw specFetchError(`Spec fetch failed: ${res.status} ${res.statusText} (${url})`, { kind: "http", status: res.status });
  }
  let body;
  try {
    body = await res.json();
  } catch (error) {
    throw specFetchError(`Spec fetch returned invalid JSON: ${error.message} (${url})`, { kind: "invalid_json", status: res.status });
  }
  if (!body || body.ok === false || body.data == null) {
    throw specFetchError(`Spec fetch returned ok=false: ${body?.error || "unknown error"} (${url})`, { kind: "not_ok", status: res.status });
  }
  return body.data;
}

// Every refusal carries what happened as data beside the prose: `kind`
// (network | http | invalid_json | not_ok) and, once a response arrived, its
// HTTP `status`. A caller that must route on a 404 reads the field, never the
// message.
function specFetchError(message, { kind, status = null }) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status;
  return error;
}
