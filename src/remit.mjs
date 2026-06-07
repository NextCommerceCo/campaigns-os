// Shared remit rails for Campaigns OS. One helper POSTs a JSON payload to a
// path under the proxy base — the QA-verdict publish pattern, extracted so the
// QA verdict publish and Run Telemetry remit share exactly one fetch/try-catch.
// See docs/workflow-findings-sidecar.md (Remit Channel).
//
// `remit()` is the low-level transport: it throws on transport/HTTP errors,
// just as the original postVerdict did — the caller decides fatality.
// `remitRunRecord()` is the run-level wrapper: consent-gated, NON-FATAL (a
// failed or unreachable send never blocks or fails the run), and IDEMPOTENT on
// run_id (the endpoint upserts, so retries/reruns never double-count). There is
// no background retry daemon — a dropped send is recorded locally, not queued.

export const DEFAULT_RUNS_ENDPOINT = "/api/runs";

/**
 * POST `payload` as JSON to `proxyBase` + `path`. Returns the parsed response
 * body (or `{ ok: true }` for an empty 2xx). Throws on a non-2xx response or a
 * transport error — mirrors qa-node.mjs postVerdict exactly.
 */
export async function remit(path, payload, proxyBase, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  }
  const base = String(proxyBase || "").replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  const response = await fetchImpl(`${base}${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Remit POST failed: ${response.status} ${response.statusText} ${body}`);
  return body ? JSON.parse(body) : { ok: true };
}

/**
 * Consent-gated, non-fatal remit of a Run Record. Returns a status object
 * `{ attempted, ok, error, endpoint }` for the caller to stamp into the local
 * record — a dropped send is visible, not silent.
 *
 * - Consent OFF (or unresolved) → no network call at all.
 * - Network/HTTP error → swallowed; the run continues. `ok: false` + `error`.
 * - The payload carries `run_id`, so the upsert endpoint is idempotent.
 */
export async function remitRunRecord(record, {
  proxyBase,
  consent,
  endpoint = DEFAULT_RUNS_ENDPOINT,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!consent || consent.state !== "on") {
    return { attempted: false, ok: null, error: null, endpoint: null };
  }
  try {
    await remit(endpoint, record, proxyBase, { fetchImpl });
    return { attempted: true, ok: true, error: null, endpoint };
  } catch (error) {
    return { attempted: true, ok: false, error: error.message, endpoint };
  }
}
