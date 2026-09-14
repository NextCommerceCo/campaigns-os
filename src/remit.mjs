// Shared remit rails for Campaigns OS. One helper POSTs a JSON payload to a
// path under the proxy base — the QA-verdict publish pattern, extracted so the
// QA verdict publish and Run Telemetry remit share exactly one fetch/try-catch.
// See docs/workflow-findings-sidecar.md (Remit Channel).
//
// `remit()` is the low-level transport: it throws on transport/HTTP errors,
// just as the original postVerdict did — the caller decides fatality.
// `remitRunRecord()` is the run-level wrapper: consent-gated, NON-FATAL (a
// failed or unreachable send never blocks or fails the run), and keyed on
// run_id. The keying is enforced by REFUSAL, not by replacement: this client
// only ever POSTs, and the receiver answers a second POST for a run_id it
// already holds with 409 run_record_conflict. So a run_id gets exactly one
// successful send — a send that never landed may be retried, one that landed
// cannot be revised. Callers that will close a run under an id must not spend
// that id on an interim record first. There is no background retry daemon — a
// dropped send is recorded locally, not queued.

import { runWithDeadline } from "./deadline.mjs";

export const DEFAULT_RUNS_ENDPOINT = "/api/runs";
export const DEFAULT_REMIT_TIMEOUT_MS = 10_000;
export const DEFAULT_REMIT_MAX_BODY_BYTES = 4_096;

// Hosts for which plain http is a local-development fact, not a network hop.
// Kept as the literal authority forms `new URL().hostname` produces (an IPv6
// literal keeps its brackets), so the check is an exact match, not a parse.
export const LOOPBACK_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.includes(String(hostname));
}

function writeWarning(line) {
  process.stderr.write(`[campaigns-os] ${line}\n`);
}

/**
 * The transport gate every credential-bearing request goes through before a
 * socket is opened. A proxy base is only ever a trusted destination when TLS
 * carries it: `X-Campaign-Key` on the remit rail and the ops admin key on the
 * `telemetry list` rail are both request credentials, and a plain-http hop
 * hands them to anything on the path.
 *
 * - `https:` — allowed, silently.
 * - plain http to a loopback host — allowed for local receivers, with one loud
 *   stderr warning per request that the credential travels in clear.
 * - anything else (plain http to a real host, a non-URL, an empty base) —
 *   THROWS, before any request is made. Nothing is sent.
 *
 * `credential` names what would travel, for both messages; it must name the
 * credential's KIND, never its value. Pass `null` when the request attaches
 * none (a QA verdict publish, say) — the wording then claims no credential
 * rather than inventing one.
 *
 * Returns `{ url, base, loopback }`; `base` is the trailing-slash-trimmed
 * string callers append their path to.
 */
export function assertSecureProxyBase(proxyBase, { label = "Remit", credential = "request credential", warn = writeWarning } = {}) {
  const base = String(proxyBase ?? "").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${label}: --proxy-base is not a URL: ${base || "(empty)"}`);
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "https:") return { url, base, loopback };
  const subject = credential || "this request and its payload";
  if (loopback) {
    warn(`${label}: ${url.origin} is plain http — ${subject} ${credential ? "travels" : "travel"} in clear to a local proxy${credential ? "" : " (no credential is attached)"}. Use https for anything that is not a loopback receiver.`);
    return { url, base, loopback };
  }
  throw new Error(`${label}: --proxy-base must be https (or a loopback host for local testing); declining to send ${subject} over ${url.protocol}//${url.host}.`);
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return runWithDeadline(() => promise, {
    timeoutMs,
    onTimeout,
    timeoutError: () => new Error(`${label} timed out after ${timeoutMs}ms`),
  });
}

export async function boundedResponseText(response, { maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES, timeoutMs = DEFAULT_REMIT_TIMEOUT_MS } = {}) {
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

/**
 * POST `payload` as JSON to `proxyBase` + `path`. Returns the parsed response
 * body (or `{ ok: true }` for an empty 2xx). Throws on a non-2xx response or a
 * transport error — mirrors qa-node.mjs postVerdict exactly — and also throws
 * BEFORE any request when the proxy base fails `assertSecureProxyBase`.
 * `label` and `credential` are passed straight to that gate: name the
 * credential this request attaches, or `null` when it attaches none.
 */
// The request headers that carry a secret on these rails. The in-clear
// warning is inferred from these alone when a caller does not name its
// credential.
const CREDENTIAL_HEADER_NAMES = new Set(["x-campaign-key", "authorization", "x-api-key"]);

export async function remit(path, payload, proxyBase, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REMIT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES,
  headers = {},
  label = "Remit",
  credential = undefined,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Upgrade to Node 18+ or pass fetchImpl.");
  }
  // What the gate says must match what this request actually carries. A caller
  // that names its credential wins; otherwise infer it from the headers this
  // module knows carry one (never from a bare Accept or Content-Type), so a
  // credential-free POST (the QA verdict publish) is never described as
  // leaking one.
  const resolvedCredential = credential === undefined
    ? (Object.keys(headers).some((name) => CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) ? "the request credential" : null)
    : credential;
  const { base } = assertSecureProxyBase(proxyBase, { label, credential: resolvedCredential });
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let response;
  response = await withTimeout(
    fetchImpl(`${base}${suffix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
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
 * - The payload carries `run_id`. The receiver keeps one record per run_id and
 *   rejects a repeat POST for a stored id (409), so retrying a send that failed
 *   is safe while re-sending a send that succeeded is not.
 */
export async function remitRunRecord(record, {
  proxyBase,
  consent,
  campaignKey = null,
  endpoint = DEFAULT_RUNS_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REMIT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_REMIT_MAX_BODY_BYTES,
} = {}) {
  if (!consent || consent.state !== "on") {
    return { attempted: false, ok: null, error: null, endpoint: null };
  }
  // Tenant identity travels as a header, never in the body: the receiver
  // stamps campaign_key_hash server-side from X-Campaign-Key and its
  // tenant-scoped listing joins on that hash. A record remitted without the
  // header is stored but invisible to every tenant scope (reachable only via
  // the admin listing or by known run_id) — which is exactly how every record
  // this CLI remitted before 2026-09-10 went dark once the receiver
  // tenant-scoped its listing. Campaign keys are public-by-design.
  const headers = typeof campaignKey === "string" && campaignKey.trim() ? { "X-Campaign-Key": campaignKey.trim() } : {};
  try {
    await remit(endpoint, record, proxyBase, {
      fetchImpl,
      timeoutMs,
      maxBodyBytes,
      headers,
      label: "Run Telemetry remit",
      credential: headers["X-Campaign-Key"] ? "the campaign key" : null,
    });
    return { attempted: true, ok: true, error: null, endpoint };
  } catch (error) {
    return { attempted: true, ok: false, error: error instanceof Error ? error.message : String(error), endpoint };
  }
}
