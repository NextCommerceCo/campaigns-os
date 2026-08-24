import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { deriveExceptions, validateVerdict } from "./qa-verdict.mjs";

// The committed QA verdict sidecar: `.campaign-runtime/qa-verdict.json` beside
// the Build Packet, the artifact campaigns-agent's readback projects. Full
// verdicts under qa-output/ are gitignored because they carry live storefront
// URLs, request evidence, and order references; the sidecar is committed to
// merchant repos, so it is an allowlist PROJECTION of one verdict, never a
// copy. Same schema ("1.0") — a second schema would fork the read end.

export const SIDECAR_RELATIVE_PATH = ".campaign-runtime/qa-verdict.json";

// Assertion fields that survive projection. Everything else — url, expected,
// actual, evidence, request/response captures — stays in the full verdict.
const ASSERTION_FIELDS = ["id", "family", "page", "status", "severity", "blocked_by"];
const EXCEPTION_FIELDS = ["id", "family", "page", "status", "severity"];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/**
 * Project one full QA verdict into its committable sidecar form. Pure:
 * `generatedAt` is the promotion instant the caller stamps (writers pass the
 * wall clock; tests pass a fixture). The projection must itself pass
 * validateVerdict — the readback recognizes the sidecar by the same minimal
 * schema as the full verdict.
 */
export function projectVerdictForSidecar(verdict, { generatedAt }) {
  const errors = validateVerdict(verdict);
  if (errors.length) {
    throw new Error(`QA verdict failed validation before sidecar projection:\n- ${errors.join("\n- ")}`);
  }
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Sidecar projection requires a parseable generatedAt instant.");
  }
  const assertions = (verdict.assertions || [])
    .filter((assertion) => assertion && typeof assertion === "object")
    .map((assertion) => pick(assertion, ASSERTION_FIELDS));
  // Exceptions are re-derived from the PROJECTED assertions, then trimmed to
  // the allowlist: deriveExceptions carries url/expected/actual, which must
  // not reach a committed file.
  const exceptions = deriveExceptions(assertions).map((exception) => pick(exception, EXCEPTION_FIELDS));
  return {
    schema_version: verdict.schema_version,
    run_id: verdict.run_id,
    campaign_slug: verdict.campaign_slug,
    ...(verdict.public_route_slug !== undefined ? { public_route_slug: verdict.public_route_slug } : {}),
    ...(verdict.campaign_ref_id !== undefined ? { campaign_ref_id: verdict.campaign_ref_id } : {}),
    spec_version: verdict.spec_version,
    spec_hash: verdict.spec_hash,
    started_at: verdict.started_at,
    completed_at: verdict.completed_at,
    generated_at: generatedAt,
    runtime: verdict.runtime,
    disposition: verdict.disposition,
    entry_urls: [],
    page_urls: [],
    tested_urls: [],
    assertions,
    test_orders: [],
    exceptions,
  };
}

export function sidecarPathForPacket(packetPath) {
  return join(dirname(resolve(packetPath)), SIDECAR_RELATIVE_PATH);
}

function writeJsonAtomicAt(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Write the sidecar for a just-finalized verdict object. Called by `qa run`
 * after local validation, before the exit-code decision, so blocked runs get
 * a sidecar too (disposition is a recorded fact, not a write gate) and a run
 * that dies before finalization never touches an existing sidecar.
 */
export function writeQaSidecar({ verdict, packetPath, now = () => new Date().toISOString() }) {
  const projected = projectVerdictForSidecar(verdict, { generatedAt: now() });
  const destination = sidecarPathForPacket(packetPath);
  writeJsonAtomicAt(destination, projected);
  return { path: destination, run_id: projected.run_id, disposition: projected.disposition, generated_at: projected.generated_at };
}

/**
 * Explicit backfill: promote one named full verdict file to the sidecar.
 * Both paths are required; nothing is selected by mtime or filename order —
 * "latest" scans are how a wrong run gets promoted. The destination sidecar
 * is refused as a source so CI cannot launder an old projection into a fresh
 * timestamp. Validation happens before any write; on failure the prior
 * sidecar bytes are untouched.
 */
export function promoteQaVerdict({ verdictPath, packetPath, now = () => new Date().toISOString() }) {
  if (!verdictPath || !packetPath) {
    throw new Error("qa promote requires both --verdict <full-verdict.json> and --packet <campaign-runtime.build.json>.");
  }
  const source = resolve(verdictPath);
  const destination = sidecarPathForPacket(packetPath);
  if (source === destination) {
    throw new Error("qa promote refuses the destination sidecar as its own source: promote from the full verdict under qa-output/, not from a prior projection.");
  }
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`qa promote could not read the source verdict at ${source}: ${error.message}`);
  }
  const projected = projectVerdictForSidecar(verdict, { generatedAt: now() });
  writeJsonAtomicAt(destination, projected);
  return {
    ok: true,
    source: source,
    destination,
    run_id: projected.run_id,
    disposition: projected.disposition,
    generated_at: projected.generated_at,
  };
}
