// The one QA-verdict publish rail. `qa run` and `qa publish` both post a
// verdict to the QA portal through `publishQaVerdict`, and both stamp what
// came back onto the Run Record through `qaVerdictPublishBlock`, so a verdict
// published at the end of a run and one published later from disk are
// classified by the same rule and recorded in the same shape.
//
// The outcome is classified the way the Run Record remit is (#397): by what
// the receiver answered, not by whether the transport threw. A 409 is
// `already_stored` — the portal already holds this run_id, which is the
// outcome the send was for — and a 2xx with a non-JSON body is an
// acknowledgement whose payload could not be read, not a refusal. Only
// another non-2xx, or a transport failure, is a failed publish.

import { classifyRemitOutcome, describeRemitBaseKind, remit } from "./remit.mjs";

export const QA_VERDICT_PUBLISH_ENDPOINT = "/api/qa/verdicts";

// Who published: the run that produced the verdict, or a later `qa publish`
// of the stored copy. Carried on the Run Record block so a reader can tell a
// verdict that went out with its run from one published from disk.
export const QA_VERDICT_PUBLISHERS = Object.freeze({
  run: "qa run",
  publish: "qa publish",
});

// The durable states the Run Record block carries. `skipped` is a run whose
// publish was off (`--no-post-verdict`, consent off); `ok` and `failed` are a
// send the receiver answered or did not, classified in `result`.
export const QA_VERDICT_PUBLISH_STATES = Object.freeze(["skipped", "ok", "failed"]);

/**
 * POST `verdict` to `<proxyBase>/api/qa/verdicts` and classify the answer.
 * Never throws for a receiver or transport failure — the caller decides what
 * a failed publish means (a `qa run` keeps its local verdict and reports; a
 * `qa publish` exits non-zero). Returns:
 *
 *   { attempted: true, ok, error, endpoint, result, http_status, base_kind, response }
 *
 * `response` is the parsed receiver body on a parsed 2xx, else null. The
 * publish attaches no credential, and says so to the transport gate: plain
 * http is still refused for anything but a loopback receiver, but the warning
 * must not claim a credential is travelling in clear.
 */
export async function publishQaVerdict(verdict, proxyBase, { fetchImpl = globalThis.fetch, remitImpl = remit } = {}) {
  if (verdict?.local_spec_id != null) return { ...skippedQaVerdictPublish(), reason: "local_spec" };
  let httpStatus = null;
  let response = null;
  let failure = null;
  try {
    response = await remitImpl(QA_VERDICT_PUBLISH_ENDPOINT, verdict, proxyBase, {
      fetchImpl,
      label: "QA verdict publish",
      credential: null,
      onResponse: (answer) => {
        httpStatus = Number(answer?.status) || null;
      },
    });
  } catch (error) {
    failure = error;
  }
  const outcome = classifyRemitOutcome(failure);
  return {
    attempted: true,
    ok: outcome.ok,
    error: outcome.error,
    endpoint: QA_VERDICT_PUBLISH_ENDPOINT,
    result: outcome.result,
    http_status: outcome.http_status ?? httpStatus,
    base_kind: describeRemitBaseKind(proxyBase),
    response: outcome.ok && !failure ? response : null,
  };
}

/** The outcome block for a run whose publish was turned off: nothing sent, nothing known. */
export function skippedQaVerdictPublish() {
  return { attempted: false, ok: null, error: null, endpoint: null, result: null, http_status: null, base_kind: null, response: null };
}

/**
 * The Run Record's `qa_verdict_publish` block for one publish outcome. The
 * verdict's run_id is the idempotency key a later `qa publish` reads; the
 * state is derived from the outcome the same way `remit_state` is from a
 * remit (`ok` when the receiver's answer counts as stored, `failed` when it
 * refused or never answered, `skipped` when nothing was sent).
 */
export function qaVerdictPublishBlock(outcome, { verdictRunId, publisher, publishedAt = null }) {
  const attempted = Boolean(outcome?.attempted);
  const ok = attempted ? outcome.ok === true : null;
  return {
    verdict_run_id: String(verdictRunId),
    publisher,
    attempted,
    ok,
    error: attempted && typeof outcome.error === "string" ? outcome.error : null,
    endpoint: attempted ? outcome.endpoint ?? QA_VERDICT_PUBLISH_ENDPOINT : null,
    state: attempted ? (ok ? "ok" : "failed") : "skipped",
    result: attempted ? outcome.result ?? null : null,
    base_kind: attempted ? outcome.base_kind ?? null : null,
    published_at: attempted && ok ? publishedAt : null,
  };
}

/** The QA portal link for a published verdict. */
export function qaPortalUrl(proxyBase, mapId, runId) {
  return `${String(proxyBase).replace(/\/+$/, "")}/qa?slug=${encodeURIComponent(mapId)}&run=${encodeURIComponent(runId)}`;
}
