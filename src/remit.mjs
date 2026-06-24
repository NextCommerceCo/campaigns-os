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
export const DEFAULT_REMIT_TIMEOUT_MS = 10_000;
export const DEFAULT_REMIT_MAX_BODY_BYTES = 4_096;
export const INGEST_TOKEN_ENV_VAR = "CAMPAIGNS_OS_INGEST_TOKEN";

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

async function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          if (typeof onTimeout === "function") onTimeout();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedResponseText(response, { maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES, timeoutMs = DEFAULT_REMIT_TIMEOUT_MS } = {}) {
  const max = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_REMIT_MAX_BODY_BYTES;

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await withTimeout(reader.read(), timeoutMs, "Remit response read");
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : Buffer.from(String(value));
        const remaining = max - bytes;
        if (remaining > 0) {
          const slice = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
          text += decoder.decode(slice, { stream: true });
        }
        bytes += chunk.byteLength;
        if (bytes > max) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
      text += decoder.decode();
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // Cleanup must not mask the transport or truncation error being reported.
      }
    }
    return truncated ? `${text}...[truncated to ${max} bytes]` : text;
  }

  const text = await withTimeout(response.text(), timeoutMs, "Remit response read");
  if (byteLength(text) <= max) return text;
  return `${String(text).slice(0, max)}...[truncated to ${max} bytes]`;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonHeaders({ ingestToken } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = nonEmptyString(ingestToken);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * POST `payload` as JSON to `proxyBase` + `path`. Returns the parsed response
 * body (or `{ ok: true }` for an empty 2xx). Throws on a non-2xx response or a
 * transport error — mirrors qa-node.mjs postVerdict exactly.
 */
export async function remit(path, payload, proxyBase, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REMIT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES,
  ingestToken = process.env[INGEST_TOKEN_ENV_VAR],
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  }
  const base = String(proxyBase || "").replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let response;
  response = await withTimeout(
    fetchImpl(`${base}${suffix}`, {
      method: "POST",
      headers: jsonHeaders({ ingestToken }),
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    }),
    timeoutMs,
    "Remit POST",
    () => controller?.abort(),
  );
  const body = await boundedResponseText(response, { maxBodyBytes, timeoutMs });
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
  timeoutMs = DEFAULT_REMIT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES,
  ingestToken = process.env[INGEST_TOKEN_ENV_VAR],
} = {}) {
  if (!consent || consent.state !== "on") {
    return { attempted: false, ok: null, error: null, endpoint: null };
  }
  try {
    await remit(endpoint, record, proxyBase, { fetchImpl, timeoutMs, maxBodyBytes, ingestToken });
    return { attempted: true, ok: true, error: null, endpoint };
  } catch (error) {
    return { attempted: true, ok: false, error: error instanceof Error ? error.message : String(error), endpoint };
  }
}
