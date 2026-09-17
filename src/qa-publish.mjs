// `qa publish`: post an already-stored QA verdict to the QA portal without
// re-running QA — and so without placing a single typed-card order.
//
// "Local first, publish when clean" used to mean two full runs (#328): a
// verdict written under --no-post-verdict could only reach the portal by
// re-running `qa run`, which placed the whole order set again. This command
// is the missing half: it reads the verdict the run wrote, proves it still
// describes the current spec, refuses one the portal already holds, posts it
// through the same rail `qa run` uses, and records the outcome on the run's
// Run Record the way remit outcomes are recorded.
//
// It never touches the order-creation budget: nothing here launches a
// browser, plans a path, or reads --max-order-creations. Order flags on the
// command line are a refusal, not a silent no-op, so an operator who typed
// `qa publish --test-order common` learns that no order was placed rather
// than assuming one was.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { campaignSidecarPaths, targetRepoFor } from "./campaign-workspace.mjs";
import { SIDECAR_RELATIVE_PATH } from "./qa-sidecar.mjs";
import { qaVerdictIdentityMatch } from "./qa-verdict-discovery.mjs";
import { publishQaVerdict, qaPortalUrl, qaVerdictPublishBlock, QA_VERDICT_PUBLISHERS } from "./qa-verdict-publish.mjs";
import { validateVerdict } from "./qa-verdict.mjs";
import { readRunRecordsForTarget, writeRunRecord } from "./run-record.mjs";
import { identityMatches } from "./run-record-closeout.mjs";
import { DEFAULT_PROXY_BASE } from "./spec-fetch.mjs";
import { specHashesMatch, specMaterialHash } from "./spec-identity.mjs";
import { singleLineFragment } from "./text-safety.mjs";

export const QA_PUBLISH_STATUSES = Object.freeze({
  published: "published",
  refused: "refused",
  publish_failed: "publish_failed",
});

// Every named refusal, with the exit code they share (2: the command did not
// do what was asked, and nothing was sent). A refusal is a result, not a
// thrown error, so --json readers get a code to branch on.
export const QA_PUBLISH_REFUSALS = Object.freeze({
  packet_required: "packet_required",
  order_flags_refused: "order_flags_refused",
  verdict_missing: "verdict_missing",
  verdict_unreadable: "verdict_unreadable",
  verdict_invalid: "verdict_invalid",
  verdict_untrusted: "verdict_untrusted",
  campaign_mismatch: "campaign_mismatch",
  spec_unreadable: "spec_unreadable",
  spec_hash_absent: "spec_hash_absent",
  spec_hash_mismatch: "spec_hash_mismatch",
  already_published: "already_published",
});

export const QA_PUBLISH_EXIT_CODES = Object.freeze({
  [QA_PUBLISH_STATUSES.published]: 0,
  [QA_PUBLISH_STATUSES.refused]: 2,
  [QA_PUBLISH_STATUSES.publish_failed]: 1,
});

// Flags that only mean something to a run that places orders. Their presence
// on `qa publish` is refused by name (see the module comment).
export const QA_PUBLISH_ORDER_FLAGS = Object.freeze([
  "test-order", "max-test-orders", "max-order-creations", "legacy-api-test-order", "browser", "select-package", "apply-coupon",
]);

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveFromFile(filePath, targetPath) {
  if (!targetPath) return null;
  return targetPath.startsWith("/") ? targetPath : resolve(dirname(resolve(filePath)), targetPath);
}

function refusal(code, detail, extra = {}) {
  return { ok: false, action: "qa-publish", status: QA_PUBLISH_STATUSES.refused, refusal: { code, detail }, ...extra };
}

/**
 * Where the verdict to publish comes from. `--verdict` names a file and is
 * honoured as given. Otherwise the committed sidecar beside the packet names
 * the run, and the full verdict the run wrote under <output-dir>/
 * <campaign_slug>/<run_id>.json (--output-dir as qa run resolves it, else
 * <target repo>/qa-output/) is preferred over the sidecar's projection —
 * the projection is what the readback consumes, but the portal wants the
 * evidence the run kept. When only the projection is on disk, it is what
 * gets published, and the result says so (`source_kind`).
 */
export function resolveStoredVerdictSource({ args, packetPath, packet, readJsonFile = readJson, exists = existsSync }) {
  const explicit = stringArg(args.verdict);
  if (explicit) {
    const path = resolve(explicit);
    if (!exists(path)) return { error: refusal(QA_PUBLISH_REFUSALS.verdict_missing, `No verdict file at ${path}.`) };
    return { path, source_kind: path === sidecarPath(packetPath) ? "sidecar_projection" : "explicit" };
  }
  const sidecar = sidecarPath(packetPath);
  if (!exists(sidecar)) {
    return {
      error: refusal(
        QA_PUBLISH_REFUSALS.verdict_missing,
        `No stored verdict: ${sidecar} does not exist and --verdict was not given. Run qa run first (with --no-post-verdict to keep it local), or name the full verdict file with --verdict; a run that wrote under --output-dir <dir> is found by passing the same --output-dir here.`,
      ),
    };
  }
  let projection;
  try {
    projection = readJsonFile(sidecar);
  } catch (error) {
    return { error: refusal(QA_PUBLISH_REFUSALS.verdict_unreadable, `The committed sidecar ${sidecar} is not readable JSON (${error.message}).`) };
  }
  const runId = stringArg(projection?.run_id);
  const slug = stringArg(projection?.campaign_slug);
  if (runId && slug) {
    // The same directory rule as qa run's writer: --output-dir when given,
    // else qa-output under the packet's target repo.
    const outputDir = stringArg(args["output-dir"])
      ? resolve(args["output-dir"])
      : campaignSidecarPaths(targetRepoFor(packetPath, packet)).qaOutputDir;
    const full = join(outputDir, slug, `${runId}.json`);
    if (exists(full)) return { path: full, source_kind: "full_verdict", sidecar_path: sidecar };
  }
  return { path: sidecar, source_kind: "sidecar_projection", sidecar_path: sidecar };
}

function sidecarPath(packetPath) {
  return join(dirname(resolve(packetPath)), SIDECAR_RELATIVE_PATH);
}

/**
 * The Run Record that carries this verdict, or null. A record is the
 * verdict's when it belongs to the packet's campaign (the closeout identity
 * match) and either references the verdict file as a qa_verdict artifact —
 * by digest, or by the `<run_id>.json` name `qa run` files it under — or
 * already carries a publish block for the verdict's run_id. Newest first, so
 * the record a session closed most recently is the one stamped.
 */
export function findRunRecordForVerdict({ records, packet, verdictRunId, verdictDigest = null }) {
  for (const entry of Array.isArray(records) ? records : []) {
    const record = entry?.record;
    if (!record || typeof record !== "object" || !identityMatches(record, packet)) continue;
    if (record.qa_verdict_publish?.verdict_run_id === verdictRunId) return entry;
    const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
    const references = artifacts.some((artifact) => artifact?.kind === "qa_verdict" && (
      (verdictDigest && artifact.sha256 === verdictDigest)
      || (typeof artifact.path === "string" && basename(artifact.path) === `${verdictRunId}.json`)
    ));
    if (references) return entry;
  }
  return null;
}

/**
 * Publish one stored verdict. `operations` is the test seam: the post, the
 * clock and the record reader/writer are injected so the refusal ladder and
 * the record stamping are assertable without a receiver or a filesystem.
 */
export async function publishStoredVerdict(args, operations = {}) {
  const ops = {
    readJsonFile: readJson,
    exists: existsSync,
    digest: sha256File,
    post: publishQaVerdict,
    readRecords: readRunRecordsForTarget,
    writeRecord: writeRunRecord,
    now: () => new Date().toISOString(),
    ...operations,
  };

  const orderFlags = QA_PUBLISH_ORDER_FLAGS.filter((flag) => flag in args);
  if (orderFlags.length) {
    return refusal(
      QA_PUBLISH_REFUSALS.order_flags_refused,
      `qa publish posts a stored verdict and places no orders; ${orderFlags.map((flag) => `--${flag}`).join(", ")} ${orderFlags.length === 1 ? "has" : "have"} no meaning here. Drop the flag, or run qa run if a new order set is what you want.`,
    );
  }
  const packetArg = stringArg(args.packet);
  if (!packetArg) return refusal(QA_PUBLISH_REFUSALS.packet_required, "qa publish requires --packet <campaign-runtime.build.json>: the packet names the current spec the verdict is checked against and the target whose Run Record takes the outcome.");
  const packetPath = resolve(packetArg);
  let packet;
  try {
    packet = ops.readJsonFile(packetPath);
  } catch (error) {
    return refusal(QA_PUBLISH_REFUSALS.packet_required, `Build Packet ${packetPath} is not readable (${error.code || error.message}).`);
  }

  const source = resolveStoredVerdictSource({ args, packetPath, packet, readJsonFile: ops.readJsonFile, exists: ops.exists });
  if (source.error) return source.error;
  let verdict;
  try {
    verdict = ops.readJsonFile(source.path);
  } catch (error) {
    return refusal(QA_PUBLISH_REFUSALS.verdict_unreadable, `The stored verdict ${source.path} is not readable JSON (${error.message}).`, { verdict_path: source.path });
  }
  const base = { verdict_path: source.path, source_kind: source.source_kind };
  const validationErrors = validateVerdict(verdict);
  if (validationErrors.length) {
    return refusal(QA_PUBLISH_REFUSALS.verdict_invalid, `The stored verdict fails local validation: ${validationErrors.join("; ")}`, base);
  }
  // The same trust chokepoint qa promote holds: a receiver-stamped anonymous
  // record must never be laundered back through this runner as its own.
  if (verdict.trusted === false) {
    return refusal(QA_PUBLISH_REFUSALS.verdict_untrusted, "The stored verdict is stamped trusted: false (an anonymous submission classified by the QA verdict receiver); refusing to re-publish it as this runner's. Publish a verdict this runner produced, or re-run QA.", base);
  }
  if (!qaVerdictIdentityMatch(verdict, packet)) {
    return refusal(
      QA_PUBLISH_REFUSALS.campaign_mismatch,
      `The stored verdict is for campaign ${JSON.stringify(verdict.campaign_slug ?? null)}, not this packet's (map id ${JSON.stringify(packet?.spec?.map_id ?? null)}, route ${JSON.stringify(packet?.campaign?.public_route_slug ?? null)}).`,
      base,
    );
  }

  // Spec identity: the verdict judged one spec; it may only be published while
  // that is still the packet's spec. One comparator (#416), so this refusal
  // agrees with doctor and the readback about what "the same spec" means.
  const specPath = resolveFromFile(packetPath, stringArg(packet?.spec?.local_path));
  if (!specPath) return refusal(QA_PUBLISH_REFUSALS.spec_unreadable, "The packet names no spec.local_path, so the verdict's spec identity cannot be checked against a current spec.", base);
  let currentSpecHash;
  try {
    currentSpecHash = specMaterialHash(ops.readJsonFile(specPath));
  } catch (error) {
    return refusal(QA_PUBLISH_REFUSALS.spec_unreadable, `The packet's spec ${specPath} is not readable (${error.code || error.message}); the verdict's spec identity cannot be checked.`, base);
  }
  const storedHash = stringArg(verdict.spec_hash);
  if (!storedHash) {
    return refusal(QA_PUBLISH_REFUSALS.spec_hash_absent, "The stored verdict carries no spec_hash, so it cannot be shown to describe the current spec. Re-run qa run.", { ...base, current_spec_hash: currentSpecHash });
  }
  if (!specHashesMatch(storedHash, currentSpecHash)) {
    return refusal(
      QA_PUBLISH_REFUSALS.spec_hash_mismatch,
      `The stored verdict judged spec ${storedHash}; the packet's spec is now ${currentSpecHash}. A verdict for a spec that has since changed is not evidence about the current one — re-run qa run against the current spec (that run publishes by default).`,
      { ...base, verdict_spec_hash: storedHash, current_spec_hash: currentSpecHash },
    );
  }

  // Idempotency by verdict run_id, read from the run's Run Record. A record
  // whose publish block already says ok for this verdict is the portal
  // holding it; a second post is refused unless --republish says otherwise.
  const verdictRunId = String(verdict.run_id);
  const baseDir = dirname(packetPath);
  let verdictDigest = null;
  try {
    verdictDigest = ops.digest(source.path);
  } catch {
    verdictDigest = null;
  }
  const records = ops.readRecords(baseDir);
  const recordEntry = findRunRecordForVerdict({ records, packet, verdictRunId, verdictDigest });
  const priorBlock = recordEntry?.record?.qa_verdict_publish?.verdict_run_id === verdictRunId ? recordEntry.record.qa_verdict_publish : null;
  const republish = args.republish === true;
  const proxyBase = stringArg(args["proxy-base"]) || DEFAULT_PROXY_BASE;
  const mapId = stringArg(packet?.spec?.map_id) || String(verdict.campaign_slug);
  const identity = { ...base, run_id: verdictRunId, map_id: mapId, spec_hash: storedHash, disposition: verdict.disposition, proxy_base: proxyBase };
  if (priorBlock?.state === "ok" && !republish) {
    return refusal(
      QA_PUBLISH_REFUSALS.already_published,
      `Verdict ${verdictRunId} is already published (${priorBlock.publisher}, ${priorBlock.result}${priorBlock.published_at ? ` at ${priorBlock.published_at}` : ""}) per Run Record ${recordEntry.record.run_id}. Pass --republish to post it again.`,
      { ...identity, run_record: recordSummary(recordEntry, priorBlock), dashboard_url: qaPortalUrl(proxyBase, mapId, verdictRunId) },
    );
  }

  const outcome = await ops.post(verdict, proxyBase);
  const publishedAt = ops.now();
  const block = qaVerdictPublishBlock(outcome, { verdictRunId, publisher: QA_VERDICT_PUBLISHERS.publish, publishedAt });

  // Stamp the record. A stored outcome is never downgraded: a --republish
  // whose send failed leaves the prior ok block as written and reports the
  // failure on the envelope only.
  let runRecord = null;
  if (recordEntry) {
    const keepPrior = priorBlock?.state === "ok" && block.state !== "ok";
    const stamped = keepPrior ? priorBlock : block;
    if (keepPrior) {
      runRecord = { ...recordSummary(recordEntry, priorBlock), written: false, preserved: true };
    } else {
      try {
        const record = { ...recordEntry.record, qa_verdict_publish: stamped };
        const path = ops.writeRecord(record, { baseDir });
        runRecord = { ...recordSummary({ path, record }, stamped), written: true, preserved: false };
      } catch (error) {
        runRecord = { ...recordSummary(recordEntry, priorBlock), written: false, preserved: false, error: singleLineFragment(error.message) };
      }
    }
  }

  const status = outcome.ok ? QA_PUBLISH_STATUSES.published : QA_PUBLISH_STATUSES.publish_failed;
  return {
    ok: outcome.ok === true,
    action: "qa-publish",
    status,
    ...identity,
    republished: republish && priorBlock?.state === "ok",
    publish: {
      attempted: outcome.attempted,
      ok: outcome.ok,
      error: outcome.error,
      endpoint: outcome.endpoint,
      result: outcome.result,
      http_status: outcome.http_status,
      base_kind: outcome.base_kind,
      published_at: block.published_at,
    },
    dashboard_url: outcome.ok ? qaPortalUrl(proxyBase, mapId, verdictRunId) : null,
    run_record: runRecord,
    orders_placed: 0,
  };
}

function recordSummary(entry, block) {
  return {
    run_id: entry?.record?.run_id ?? null,
    path: entry?.path ?? null,
    qa_verdict_publish: block ?? null,
  };
}

/** The text report for one `qa publish` result. Returns lines; the printer joins them. */
export function qaPublishTextLines(result, { cmd = (verb) => `campaigns-os ${verb}` } = {}) {
  const lines = [];
  if (result.status === QA_PUBLISH_STATUSES.refused) {
    lines.push(`QA publish refused (${result.refusal.code}).`);
    lines.push(result.refusal.detail);
    if (result.verdict_path) lines.push(`Verdict: ${result.verdict_path}${result.source_kind ? ` (${result.source_kind})` : ""}`);
    if (result.dashboard_url) lines.push(`QA portal: ${result.dashboard_url}`);
    lines.push("No order was placed and nothing was sent.");
    return lines;
  }
  lines.push(result.status === QA_PUBLISH_STATUSES.published
    ? `QA verdict published${result.republished ? " again" : ""}.`
    : "QA verdict publish failed.");
  lines.push(`Map ID: ${result.map_id}`);
  lines.push(`Run ID: ${result.run_id}`);
  lines.push(`Disposition: ${result.disposition}`);
  lines.push(`Verdict: ${result.verdict_path} (${result.source_kind})`);
  if (result.source_kind === "sidecar_projection") {
    lines.push("  The full verdict the run wrote is not on disk; the committed projection (no URLs, no order evidence) is what was published.");
  }
  const publish = result.publish || {};
  lines.push(`Publish: ${publish.result || "unknown"}${publish.http_status ? ` (HTTP ${publish.http_status})` : ""} -> ${publish.endpoint || "(no endpoint)"}${publish.error ? ` — ${publish.error}` : ""}`);
  if (result.dashboard_url) lines.push(`QA portal: ${result.dashboard_url}`);
  if (result.run_record) {
    const record = result.run_record;
    const state = record.qa_verdict_publish?.state || "(absent)";
    lines.push(`Run Record: ${record.run_id} ${record.written ? "updated" : record.preserved ? "kept as written (a stored publish is never downgraded)" : "not updated"}${record.error ? ` — ${record.error}` : ""} (qa_verdict_publish: ${state}) at ${record.path}`);
  } else {
    lines.push(`Run Record: none references this verdict under the packet's campaign, so the publish outcome is not on a record. Close the run first (${cmd("run")} end, or ${cmd("run-record")} --packet <packet> --qa-verdict <verdict>) and re-run qa publish --republish to record it.`);
  }
  lines.push("Orders placed: 0 (qa publish never places orders).");
  if (result.status === QA_PUBLISH_STATUSES.publish_failed) {
    lines.push(`Re-run ${cmd("qa")} publish with network access; the local verdict is untouched.`);
  }
  return lines;
}
