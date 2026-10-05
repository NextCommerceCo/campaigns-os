// Unit 1.4 fixture rows, leg QN: policy link availability probed against
// loopback servers through an injected fetchImpl, and stored policy link
// observations re-evaluated in node (contract §1.4 Observations, Result rules
// and Accepts).
//
// Each availability row probes one configured URL on a fresh loopback server
// with probePolicyUrl, compares the exact request log (the injected fetch's
// calls and the server's own log) and the exact availability block, then
// re-derives the field's row with the real module's rederiveQcResult, builds
// it with the 1.0 buildQcResult and reads it back through the 1.0 QA reader
// with the real module loaded from the registry (no stand-in). The accept rows
// probe twice (before and after one change on the server), accept the first
// warning with createQcAccept and assess that accept against the second read.
//
// API assumption (probe): probePolicyUrl(url, { fetchImpl }) defaults to
// maxRedirects 5, timeoutMs 5000 and deadlineMs 15000, calls only fetchImpl,
// each time as a GET with redirect "manual", and resolves to the availability
// block of the contract's observation:
//   { chain: [{ url, query_sha256, status }], final, final_query_sha256,
//     status, content_type, outcome }
// where chain lists every answered request in request order (the final
// response included), url and final are origin+path, a query is kept only as
// query_sha256 = "sha256:" + the hex sha256 of its sorted "key=value" pairs
// joined with "&" (null when there is no query), content_type is the
// lowercase "type/subtype" without parameters, and outcome is the
// availability reason code, or "pass". For a configured value that is not an
// absolute http(s) URL it makes no call and resolves with chain [] and outcome
// "non_http_destination" (mailto: or another scheme) or
// "configured_url_invalid" (relative or unparseable).
//
// API assumption (rows): rederiveQcResult(observation) returns the 1.0
// Derived shape {check, subject, result, reason_code, members,
// accept_eligible, coverage, state} for a field observation
//   { check, field, configured, configured_query_sha256, scheme, presence }
//   { check, field, configured, configured_query_sha256, scheme, availability }
// (one per row; check is "policy.presence" or "policy.availability",
// configured is origin+path for http(s), "mailto:<lowercase address>" for
// mailto and null for an invalid value). The subject is {check, page:
// "campaign", key: <field>}, so the row id is <check>:campaign:<field>, and
// the verdict assertion id is the contract's qc.<check>:<field>, paired to
// the row by evidence.qc.result_id. Rows do not aggregate: members is []. The
// state is the contract's exact accept state for the check.
//
// API assumption (coverage): every row carries the 1.0 coverage
// {observed, expected, limits}, counted as the tracking rows count theirs
// (expected: the units in scope; observed: those judged). A presence row
// counts pages: expected is pages_expected, observed is pages_read, and limits
// is ["pages_not_read"] when presence is unexercised, [] otherwise. An
// availability row counts its one configured URL: {1, 1, []} when a response
// decided it, {0, 1, ["network_unavailable"]} when the network did not
// answer. A row decided without reading anything (configured_url_invalid,
// non_http_destination, browser_checks_not_requested) is {observed: 0,
// expected: null, limits: []}, as the tracking run-scope rows are. Each test
// writes its expected coverage from these rules and its fixture.
//
// Header-only GET (contract §1.4 Inputs: headers are read, then the body is
// canceled): every answered request gets its headers at once and then a slow
// body (64 chunks of 16 KiB, one every 40 ms, about 2.6 s). The injected fetch
// hands the probe a response whose body counts the bytes the probe pulls, and
// the server records when each connection closed. Every request must read at
// most 16 KiB of body, and its connection must close within 1 s of its
// headers, before the body ends.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test. The fixture
// module imports only node builtins; its guard covers every raw TCP or TLS
// socket connect and WebSocket. The probes get their own fetch (below), a
// wrapper over node's fetch that refuses anything but loopback; it is taken
// before the factory replaces the global fetch and node:http(s) with stubs
// that refuse every request, so a module that ignores the injected fetchImpl
// fails its test.
import { assertLoopbackOnly, installNodeGuard, isLoopbackUrl, sha256 } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const nodeFetch = globalThis.fetch;
const { BUILD_FP, OPERATOR, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict } = await import("./qc-test-factories.mjs");

const refusedProbeCalls = [];
afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
  assert.deepEqual(refusedProbeCalls.splice(0), [], "the injected fetch was never asked for a non-loopback URL");
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const PAGE = "campaign";
const FIELD = "store_terms";
const measuredAt = new Date(Date.now() - 60_000).toISOString();

// ---------------------------------------------------------------------------
// Loopback servers and the injected fetch

const BODY_CHUNK = Buffer.alloc(16 * 1024, " ");
const BODY_CHUNKS = 64;
const BODY_EVERY_MS = 40;
// What a header-only GET may cost: no body bytes read (the meter counts only
// bytes the probe itself pulls, so cancelling the body reads none), and the time
// from a response's headers to its connection closing.
const BODY_READ_BOUND = 0;
const CLOSE_WITHIN_MS = 1_000;

// How a connection ended, or { finished: null, afterMs: Infinity } while it is
// still open 2 s on (a probe that neither reads nor cancels a body never lets
// the server finish sending it).
async function endOf(closed) {
  let timer;
  const open = new Promise((resolve) => { timer = setTimeout(() => resolve({ finished: null, afterMs: Infinity }), 2_000); });
  try {
    return await Promise.race([closed, open]);
  } finally {
    clearTimeout(timer);
  }
}

// routes: (pathAndQuery, nth) => { status, type?, location?, delayMs?, hold? }
// or undefined (404 text/plain). Every request is logged as "<METHOD> <path>";
// every response that sent its headers is listed in `answered` with a promise
// of how its connection ended ({ finished, afterMs }: whether the whole body
// was sent, and how long after the headers it closed).
async function startServer(routes) {
  const log = [];
  const answered = [];
  const counts = new Map();
  const held = new Set();
  const timers = new Set();
  const server = createServer((request, response) => {
    const target = request.url;
    log.push(`${request.method} ${target}`);
    counts.set(target, (counts.get(target) || 0) + 1);
    const answer = routes(target, counts.get(target)) || { status: 404, type: "text/plain" };
    if (answer.hold) {
      held.add(response);
      return;
    }
    const send = () => {
      timers.delete(timer);
      if (response.destroyed || !response.socket || response.socket.destroyed) return;
      const headers = { "content-type": answer.type ?? "text/html; charset=utf-8" };
      if (answer.location) headers.location = answer.location;
      response.writeHead(answer.status, headers);
      response.flushHeaders();
      const headersAt = performance.now();
      let sent = 0;
      const drip = setInterval(() => {
        if (sent === BODY_CHUNKS) {
          clearInterval(drip);
          response.end();
          return;
        }
        response.write(BODY_CHUNK);
        sent += 1;
      }, BODY_EVERY_MS);
      timers.add(drip);
      const closed = new Promise((resolve) => response.once("close", () => {
        clearInterval(drip);
        timers.delete(drip);
        resolve({ finished: response.writableFinished, afterMs: performance.now() - headersAt });
      }));
      answered.push({ target, closed });
    };
    const timer = answer.delayMs ? setTimeout(send, answer.delayMs) : null;
    if (timer) timers.add(timer);
    else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    log,
    answered,
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// A loopback URL nothing listens on.
async function closedLoopbackBase() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// The response handed to the probe: the same status, headers and URL, with a
// body that counts the bytes pulled from it into `metered.bytes`. It pulls
// nothing until the probe reads, and canceling it cancels the real body.
function meteredResponse(response, metered) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      metered.bytes += value.byteLength;
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
  const handed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"]) Object.defineProperty(handed, key, { value: response[key] });
  return handed;
}

// The injected fetch: records every call (method, redirect mode, URL, and the
// body bytes read from its response) and lets only loopback through.
function recordingFetch(calls) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const call = {
      method: String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      redirect: init.redirect ?? (input instanceof Request ? input.redirect : "follow"),
      url,
    };
    calls.push(call);
    if (!isLoopbackUrl(url)) {
      refusedProbeCalls.push(url);
      throw new TypeError(`policy link tests: non-loopback probe refused (${url})`);
    }
    const response = await nodeFetch(input, init);
    call.body = { bytes: 0 };
    return meteredResponse(response, call.body);
  };
}

// Probes `path` on a fresh server serving `routes`. The module is imported
// first, so a missing module fails the row before any server starts.
async function probeAt(t, routes, path, { base = null } = {}) {
  const { probePolicyUrl } = await import("./qa-policy-links.mjs");
  const server = base ? null : await startServer(routes);
  if (server) t.after(server.close);
  const origin = base ?? server.base;
  const calls = [];
  const started = performance.now();
  const block = await probePolicyUrl(`${origin}${path}`, { fetchImpl: recordingFetch(calls) });
  const elapsed = performance.now() - started;
  return { origin, block, calls, log: server?.log ?? [], answered: server?.answered ?? [], elapsed };
}

// Exactly these requests, in this order: every call a GET with redirect
// "manual", and the server saw the same requests. Each is header-only: the
// probe read no body bytes of any response (BODY_READ_BOUND), and every
// response that sent headers (`answered`, by default every request) had its
// connection closed within CLOSE_WITHIN_MS of its headers, before its body
// ended.
async function assertRequests(probe, paths, { serverLog = true, answered = paths } = {}) {
  assert.deepEqual(
    probe.calls.map(({ method, redirect, url }) => [method, redirect, url]),
    paths.map((path) => ["GET", "manual", `${probe.origin}${path}`]),
    "the probe's requests, in order: header-only GETs with redirect manual",
  );
  if (serverLog) assert.deepEqual(probe.log, paths.map((path) => `GET ${path}`), "the server saw exactly these requests");
  for (const call of probe.calls) {
    if (call.body) assert.ok(call.body.bytes <= BODY_READ_BOUND, `${call.url}: the probe read ${call.body.bytes} body bytes, at most ${BODY_READ_BOUND}`);
  }
  const ends = await Promise.all(probe.answered.map(async ({ target, closed }) => ({ target, ...(await endOf(closed)) })));
  assert.deepEqual(
    ends.map(({ target, finished, afterMs }) => [target, finished, afterMs <= CLOSE_WITHIN_MS]),
    answered.map((path) => [path, false, true]),
    `every answered request's connection closed within ${CLOSE_WITHIN_MS} ms of its headers, before its body ended (${ends.map(({ afterMs }) => Math.round(afterMs)).join(", ")} ms)`,
  );
}

// ---------------------------------------------------------------------------
// Expected observations, states and rows (from the contract, never from the
// module under test)

const hop = (origin, path, query, status) => ({ url: `${origin}${path}`, query_sha256: query == null ? null : sha256(query), status });

// The full availability block of a request chain that ended in a response.
function block(origin, chain, { contentType, outcome }) {
  const last = chain.at(-1);
  return {
    chain,
    final: last.url,
    final_query_sha256: last.query_sha256,
    status: last.status,
    content_type: contentType,
    outcome,
  };
}

function assertBlock(actual, expected, keys = Object.keys(expected)) {
  assert.ok(actual && typeof actual === "object", "the probe resolves to an availability block");
  assert.deepEqual(Object.fromEntries(keys.map((key) => [key, actual[key]])), Object.fromEntries(keys.map((key) => [key, expected[key]])), `availability block (${keys.join(", ")})`);
}

const identityOf = (url) => {
  if (url == null || !/^https?:/.test(url)) return null;
  const { protocol, host, pathname } = new URL(url);
  return { url_sha256: sha256(`${protocol}//${host}${pathname}`), path_sha256: sha256(pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname), host_sha256: sha256(host.replace(/^www\./, "")) };
};
// The path and host hashes of an identity, as a row's accept state carries them.
const stateIdentityOf = (ids) => ids && { path_sha256: ids.path_sha256, host_sha256: ids.host_sha256 };

const availabilityObservation = ({ origin, path, query = null, availability, field = FIELD, scheme = "http", configured = `${origin}${path}` }) => ({
  check: "policy.availability",
  field,
  configured,
  configured_query_sha256: query == null ? null : sha256(query),
  configured_identity: identityOf(configured),
  scheme,
  availability,
});

const presenceObservation = ({ configured, query = null, scheme = "https", presence, field = FIELD }) => ({
  check: "policy.presence",
  field,
  configured,
  configured_query_sha256: query == null ? null : sha256(query),
  configured_identity: identityOf(configured),
  scheme,
  presence,
});

// The contract's availability accept state for an expected block.
const availabilityState = (reasonCode, observation, expected) => ({
  reason_code: reasonCode,
  configured: observation.configured,
  configured_query_sha256: observation.configured_query_sha256,
  configured_identity: stateIdentityOf(observation.configured_identity),
  chain: expected.chain.map(({ url, query_sha256, status }) => ({ url, query_sha256, status })),
  chain_identity: expected.chain.map(({ url }) => stateIdentityOf(identityOf(url))),
  next_hop_identity: null,
  final: expected.final,
  final_query_sha256: expected.final_query_sha256,
  status: expected.status,
  content_type: expected.content_type,
});

// The contract's presence accept state.
const presenceState = (reasonCode, observation) => ({
  reason_code: reasonCode,
  configured: observation.configured,
  configured_query_sha256: observation.configured_query_sha256,
  configured_identity: stateIdentityOf(observation.configured_identity),
  pages_expected: observation.presence.pages_expected,
  pages_read: observation.presence.pages_read,
  pages_with_match: observation.presence.pages_with_match,
  path_match_query_differs: observation.presence.path_match_query_differs,
  label_anchor_mismatch_pages: observation.presence.label_anchor_mismatch_pages,
  hint_anchor_elsewhere: observation.presence.hint_anchor_elsewhere,
});

// Expected coverage (API assumption above).
const ANSWERED = () => ({ observed: 1, expected: 1, limits: [] });
const NETWORK_FAILED = () => ({ observed: 0, expected: 1, limits: ["network_unavailable"] });
const NOTHING_READ = () => ({ observed: 0, expected: null, limits: [] });
const pagesCoverage = (pagesRead, pagesExpected, limits = []) => ({ observed: pagesRead, expected: pagesExpected, limits });

const subjectOf = (check, field = FIELD) => ({ check, page: PAGE, key: field });
const idOf = (check, field = FIELD) => `${check}:${PAGE}:${field}`;
const assertionIdOf = (check, field = FIELD) => `qc.${check}:${field}`;

// The real module's Derived result for an observation, compared whole on
// check, subject, result, reason code, members, accept eligibility and
// coverage, and (when given) the exact state.
async function derive(observationValue, { result, reasonCode, acceptEligible, coverage, state }) {
  const { rederiveQcResult } = await import("./qa-policy-links.mjs");
  const derived = rederiveQcResult(observationValue);
  assert.ok(derived && typeof derived === "object", "the observation re-derives");
  const check = observationValue.check;
  assert.deepEqual(
    [derived.check, derived.subject, derived.result, derived.reason_code ?? null, derived.members ?? null, derived.accept_eligible, derived.coverage],
    [check, subjectOf(check, observationValue.field), result, reasonCode, [], acceptEligible, coverage],
    `${check} reads ${result} / ${reasonCode}, accept_eligible ${acceptEligible}, no members, coverage ${JSON.stringify(coverage)}`,
  );
  if (state !== undefined) assert.deepEqual(derived.state, state, `${check} state is the contract's exact accept state`);
  return derived;
}

// The producer's row for a derived result, read back through the 1.0 QA
// reader (with the real module from the registry) beside its verdict
// assertion; the reader lists exactly this row with the expected result,
// reason code, members, accept eligibility and coverage, and re-derives it
// unchanged.
async function readBack(observationValue, derived, { result, reasonCode, acceptEligible, coverage }) {
  const { buildQcResult, readQaResults, toQaAssertion } = await import("./qc-results.mjs");
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const row = buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: derived.state,
    observation: observationValue,
    members: derived.members ?? [],
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
  const check = observationValue.check;
  const read = readQaResults({
    stageEvidence: { qc_results: [row], qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: [{ ...toQaAssertion(row, { family: "browser-runtime" }), id: assertionIdOf(check, observationValue.field) }], measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  const field = observationValue.field;
  const independent = (entry) => [entry.id, entry.check, entry.leg, entry.subject, entry.result, entry.reason_code, entry.members, entry.accept_eligible, entry.coverage];
  assert.deepEqual(
    read.map(independent),
    [[idOf(check, field), check, "qa", subjectOf(check, field), result, reasonCode, [], acceptEligible, coverage]],
    `the reader lists exactly ${idOf(check, field)}: ${result} / ${reasonCode}, no members, coverage ${JSON.stringify(coverage)}`,
  );
  const project = (entry) => [...independent(entry), entry.state_fingerprint];
  assert.deepEqual(read.map(project), [project(row)], `the reader re-derives ${row.id} unchanged with the real module`);
  return read[0];
}

async function rowFor(observationValue, expected) {
  return readBack(observationValue, await derive(observationValue, expected), expected);
}

// ---------------------------------------------------------------------------
// Availability rows

test("F1.4-W2 store_terms GET 200 text/html: availability pass", async (t) => {
  const probe = await probeAt(t, (path) => (path === "/w2/terms" ? { status: 200 } : undefined), "/w2/terms");
  await assertRequests(probe, ["/w2/terms"]);
  const expected = block(probe.origin, [hop(probe.origin, "/w2/terms", null, 200)], { contentType: "text/html", outcome: "pass" });
  assertBlock(probe.block, expected);
  const observation = availabilityObservation({ origin: probe.origin, path: "/w2/terms", availability: probe.block });
  await rowFor(observation, { result: "pass", reasonCode: null, acceptEligible: false, coverage: ANSWERED(), state: availabilityState(null, observation, expected) });
});

test("F1.4-W4 configured /terms: 301 to /terms/, then 200 HTML: availability pass", async (t) => {
  const routes = (path) => ({
    "/w4/terms": { status: 301, location: "/w4/terms/" },
    "/w4/terms/": { status: 200 },
  })[path];
  const probe = await probeAt(t, routes, "/w4/terms");
  await assertRequests(probe, ["/w4/terms", "/w4/terms/"]);
  const expected = block(probe.origin, [hop(probe.origin, "/w4/terms", null, 301), hop(probe.origin, "/w4/terms/", null, 200)], { contentType: "text/html", outcome: "pass" });
  assertBlock(probe.block, expected);
  const observation = availabilityObservation({ origin: probe.origin, path: "/w4/terms", availability: probe.block });
  await rowFor(observation, { result: "pass", reasonCode: null, acceptEligible: false, coverage: ANSWERED(), state: availabilityState(null, observation, expected) });
});

// A configured URL answering `status` with `type` directly.
async function directStatusRow(t, { path, status, type = "text/html; charset=utf-8", contentType = "text/html", result, reasonCode, acceptEligible }) {
  const probe = await probeAt(t, (target) => (target === path ? { status, type } : undefined), path);
  await assertRequests(probe, [path]);
  const expected = block(probe.origin, [hop(probe.origin, path, null, status)], { contentType, outcome: reasonCode });
  assertBlock(probe.block, expected);
  const observation = availabilityObservation({ origin: probe.origin, path, availability: probe.block });
  return rowFor(observation, { result, reasonCode, acceptEligible, coverage: ANSWERED(), state: availabilityState(reasonCode, observation, expected) });
}

test("F1.4-B3 configured URL returns 404: availability warning (not_found)", async (t) => {
  await directStatusRow(t, { path: "/b3/terms", status: 404, result: "warning", reasonCode: "not_found", acceptEligible: true });
});

test("F1.4-B4 302 to /: availability warning (redirected_to_root)", async (t) => {
  const routes = (path) => ({
    "/b4/terms": { status: 302, location: "/" },
    "/": { status: 200 },
  })[path];
  const probe = await probeAt(t, routes, "/b4/terms");
  await assertRequests(probe, ["/b4/terms", "/"]);
  const expected = block(probe.origin, [hop(probe.origin, "/b4/terms", null, 302), hop(probe.origin, "/", null, 200)], { contentType: "text/html", outcome: "redirected_to_root" });
  assertBlock(probe.block, expected);
  const observation = availabilityObservation({ origin: probe.origin, path: "/b4/terms", availability: probe.block });
  await rowFor(observation, { result: "warning", reasonCode: "redirected_to_root", acceptEligible: true, coverage: ANSWERED(), state: availabilityState("redirected_to_root", observation, expected) });
});

test("F1.4-B12 configured URL returns 503: availability warning (server_error)", async (t) => {
  await directStatusRow(t, { path: "/b12/terms", status: 503, result: "warning", reasonCode: "server_error", acceptEligible: true });
});

test("F1.4-I1 A->B->A redirect: availability review (redirect_loop)", async (t) => {
  const routes = (path) => ({
    "/i1/a": { status: 302, location: "/i1/b" },
    "/i1/b": { status: 302, location: "/i1/a" },
  })[path];
  const probe = await probeAt(t, routes, "/i1/a");
  // The repeat is found in memory: A is not requested a second time.
  await assertRequests(probe, ["/i1/a", "/i1/b"]);
  assertBlock(probe.block, { chain: [hop(probe.origin, "/i1/a", null, 302), hop(probe.origin, "/i1/b", null, 302)], outcome: "redirect_loop" });
  const observation = availabilityObservation({ origin: probe.origin, path: "/i1/a", availability: probe.block });
  await rowFor(observation, { result: "review", reasonCode: "redirect_loop", acceptEligible: false, coverage: ANSWERED() });
});

test("F1.4-I2 connection refused: availability unexercised (network_unavailable)", async (t) => {
  const base = await closedLoopbackBase();
  const probe = await probeAt(t, null, "/i2/terms", { base });
  await assertRequests(probe, ["/i2/terms"], { serverLog: false, answered: [] });
  assertBlock(probe.block, { chain: [], outcome: "network_unavailable" });
  const observation = availabilityObservation({ origin: base, path: "/i2/terms", availability: probe.block });
  await rowFor(observation, { result: "unexercised", reasonCode: "network_unavailable", acceptEligible: false, coverage: NETWORK_FAILED() });
});

test("F1.4-I3 401: availability review (auth_required)", async (t) => {
  await directStatusRow(t, { path: "/i3/terms", status: 401, result: "review", reasonCode: "auth_required", acceptEligible: false });
});

test("F1.4-I4 429: availability review (rate_limited)", async (t) => {
  await directStatusRow(t, { path: "/i4/terms", status: 429, result: "review", reasonCode: "rate_limited", acceptEligible: false });
});

test("F1.4-I5 200 application/pdf: availability review (non_html_response)", async (t) => {
  await directStatusRow(t, { path: "/i5/terms", status: 200, type: "application/pdf", contentType: "application/pdf", result: "review", reasonCode: "non_html_response", acceptEligible: false });
});

test("F1.4-I7 store_contact: \"mailto:x@example.invalid\": availability excluded, no request (non_http_destination)", async () => {
  const { probePolicyUrl } = await import("./qa-policy-links.mjs");
  const calls = [];
  const configured = "mailto:x@example.invalid";
  const probed = await probePolicyUrl(configured, { fetchImpl: recordingFetch(calls) });
  assert.deepEqual(calls, [], "no request was made for the mailto: value");
  assertBlock(probed, { chain: [], outcome: "non_http_destination" });
  const observation = availabilityObservation({ field: "store_contact", configured, scheme: "mailto", availability: probed });
  await rowFor(observation, { result: "excluded", reasonCode: "non_http_destination", acceptEligible: false, coverage: NOTHING_READ() });
});

test("F1.4-I8 six redirects: availability review (redirect_limit)", async (t) => {
  const routes = (path) => {
    const match = /^\/i8\/(\d)$/.exec(path);
    return match ? { status: 302, location: `/i8/${Number(match[1]) + 1}` } : undefined;
  };
  const probe = await probeAt(t, routes, "/i8/0");
  // 1 + 5 redirects: six requests, and the sixth redirect is not followed.
  const paths = ["/i8/0", "/i8/1", "/i8/2", "/i8/3", "/i8/4", "/i8/5"];
  await assertRequests(probe, paths);
  assertBlock(probe.block, { chain: paths.map((path) => hop(probe.origin, path, null, 302)), outcome: "redirect_limit" });
  const observation = availabilityObservation({ origin: probe.origin, path: "/i8/0", availability: probe.block });
  await rowFor(observation, { result: "review", reasonCode: "redirect_limit", acceptEligible: false, coverage: ANSWERED() });
});

test("F1.4-I9 /terms -> 301 /policies/terms -> 200 HTML: availability review (redirected_elsewhere)", async (t) => {
  const routes = (path) => ({
    "/i9/terms": { status: 301, location: "/i9/policies/terms" },
    "/i9/policies/terms": { status: 200 },
  })[path];
  const probe = await probeAt(t, routes, "/i9/terms");
  await assertRequests(probe, ["/i9/terms", "/i9/policies/terms"]);
  const expected = block(probe.origin, [hop(probe.origin, "/i9/terms", null, 301), hop(probe.origin, "/i9/policies/terms", null, 200)], { contentType: "text/html", outcome: "redirected_elsewhere" });
  assertBlock(probe.block, expected);
  const observation = availabilityObservation({ origin: probe.origin, path: "/i9/terms", availability: probe.block });
  await rowFor(observation, { result: "review", reasonCode: "redirected_elsewhere", acceptEligible: false, coverage: ANSWERED(), state: availabilityState("redirected_elsewhere", observation, expected) });
});

// Wall clock: four requests that each answer after 4 s, cut at the 15 s
// per-URL deadline; 30 s leaves room for the run around it.
test("F1.4-I11 configured URL redirects 5 times, each hop answering after 4 s: availability unexercised at the 15 s deadline (network_unavailable)", { timeout: 30_000 }, async (t) => {
  const routes = (path) => {
    const match = /^\/i11\/(\d)$/.exec(path);
    if (!match) return undefined;
    const index = Number(match[1]);
    return index < 5 ? { status: 302, location: `/i11/${index + 1}`, delayMs: 4_000 } : { status: 200, delayMs: 4_000 };
  };
  const probe = await probeAt(t, routes, "/i11/0");
  // Requests start at about 0, 4, 8 and 12 s; the fourth is still unanswered
  // at 15 s, and nothing is requested after the deadline.
  assert.ok(probe.elapsed >= 14_900 && probe.elapsed < 15_900, `the probe ends at its 15 s deadline (took ${Math.round(probe.elapsed)} ms)`);
  await assertRequests(probe, ["/i11/0", "/i11/1", "/i11/2", "/i11/3"], { answered: ["/i11/0", "/i11/1", "/i11/2"] });
  assertBlock(probe.block, { chain: ["/i11/0", "/i11/1", "/i11/2"].map((path) => hop(probe.origin, path, null, 302)), outcome: "network_unavailable" });
  const observation = availabilityObservation({ origin: probe.origin, path: "/i11/0", availability: probe.block });
  await rowFor(observation, { result: "unexercised", reasonCode: "network_unavailable", acceptEligible: false, coverage: NETWORK_FAILED() });
});

test("F1.4-I12 configured URL returns 400: availability review (unexpected_status)", async (t) => {
  await directStatusRow(t, { path: "/i12/terms", status: 400, result: "review", reasonCode: "unexpected_status", acceptEligible: false });
});

test("F1.4-I13 403: availability review (auth_required)", async (t) => {
  await directStatusRow(t, { path: "/i13/terms", status: 403, result: "review", reasonCode: "auth_required", acceptEligible: false });
});

test("F1.4-I14 configured /terms?v=1 redirects to /terms?v=9, 200 HTML: availability review (redirected_elsewhere)", async (t) => {
  const routes = (path) => ({
    "/i14/terms?v=1": { status: 302, location: "/i14/terms?v=9" },
    "/i14/terms?v=9": { status: 200 },
  })[path];
  const probe = await probeAt(t, routes, "/i14/terms?v=1");
  await assertRequests(probe, ["/i14/terms?v=1", "/i14/terms?v=9"]);
  const expected = block(probe.origin, [hop(probe.origin, "/i14/terms", "v=1", 302), hop(probe.origin, "/i14/terms", "v=9", 200)], { contentType: "text/html", outcome: "redirected_elsewhere" });
  assertBlock(probe.block, expected);
  assert.equal(JSON.stringify(probe.block).includes("v="), false, "no query is stored, only its hash");
  const observation = availabilityObservation({ origin: probe.origin, path: "/i14/terms", query: "v=1", availability: probe.block });
  await rowFor(observation, { result: "review", reasonCode: "redirected_elsewhere", acceptEligible: false, coverage: ANSWERED(), state: availabilityState("redirected_elsewhere", observation, expected) });
});

test("F1.4-I15 store_terms: \"/terms\" (relative): presence and availability review, no request (configured_url_invalid)", async () => {
  const { probePolicyUrl } = await import("./qa-policy-links.mjs");
  const calls = [];
  const probed = await probePolicyUrl("/terms", { fetchImpl: recordingFetch(calls) });
  assert.deepEqual(calls, [], "no request was made for the relative value");
  assertBlock(probed, { chain: [], outcome: "configured_url_invalid" });
  const availability = availabilityObservation({ configured: null, scheme: "invalid", availability: probed });
  await rowFor(availability, { result: "review", reasonCode: "configured_url_invalid", acceptEligible: false, coverage: NOTHING_READ() });
  // No anchor is compared with an invalid value, so presence reads nothing.
  const presence = presenceObservation({
    configured: null,
    scheme: "invalid",
    presence: { pages_expected: 1, pages_read: 1, pages_with_match: 0, path_match_query_differs: 0, label_declared: false, label_anchor_mismatch_pages: 0, hint_anchor_elsewhere: 0 },
  });
  await rowFor(presence, { result: "review", reasonCode: "configured_url_invalid", acceptEligible: false, coverage: NOTHING_READ() });
});

// Wall clock: one request held open until the 5 s request timeout; 20 s
// leaves room for the run around it.
test("F1.4-I16 server accepts the connection and never responds (5 s timeout): availability unexercised (network_unavailable)", { timeout: 20_000 }, async (t) => {
  const probe = await probeAt(t, (path) => (path === "/i16/terms" ? { hold: true } : undefined), "/i16/terms");
  assert.ok(probe.elapsed >= 4_900 && probe.elapsed < 6_500, `the probe ends at its 5 s request timeout, not the 15 s deadline (took ${Math.round(probe.elapsed)} ms)`);
  await assertRequests(probe, ["/i16/terms"], { answered: [] });
  assertBlock(probe.block, { chain: [], outcome: "network_unavailable" });
  const observation = availabilityObservation({ origin: probe.origin, path: "/i16/terms", availability: probe.block });
  await rowFor(observation, { result: "unexercised", reasonCode: "network_unavailable", acceptEligible: false, coverage: NETWORK_FAILED() });
});

// ---------------------------------------------------------------------------
// Presence, stored observation

test("F1.4-I18 store_terms set; the QA topology has no enabled page (pages_expected: 0): presence unexercised (pages_not_read)", async () => {
  const observation = presenceObservation({
    configured: "https://store.example.invalid/terms",
    presence: { pages_expected: 0, pages_read: 0, pages_with_match: 0, path_match_query_differs: 0, label_declared: false, label_anchor_mismatch_pages: 0, hint_anchor_elsewhere: 0 },
  });
  await rowFor(observation, { result: "unexercised", reasonCode: "pages_not_read", acceptEligible: false, coverage: pagesCoverage(0, 0, ["pages_not_read"]), state: presenceState("pages_not_read", observation) });
});

// ---------------------------------------------------------------------------
// Accept lapse: two real probes, one change between them

async function acceptOn(row) {
  const { createQcAccept, qcAcceptAttribution } = await import("./qc-accept.mjs");
  const attribution = qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now: new Date().toISOString() });
  return createQcAccept(row, { measuredAt, attribution });
}

// Probes `configuredPath` on the server, accepts the not_found warning, flips
// the server with `change`, probes `afterPath` (the same configured URL unless
// the configured URL itself changed) and assesses the accept on the second
// read. Each probe's requests and block are compared exactly.
async function assertLapse(t, { routes, change, beforePath, afterPath = beforePath, before, after: afterExpected, configuredQuery = [null, null], configuredPath = [beforePath, afterPath] }) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const { probePolicyUrl } = await import("./qa-policy-links.mjs");
  const server = await startServer(routes);
  t.after(server.close);
  const origin = server.base;

  const readOnce = async (path, expected, query, configured) => {
    const calls = [];
    const start = server.log.length;
    const startAnswered = server.answered.length;
    const probed = await probePolicyUrl(`${origin}${path}`, { fetchImpl: recordingFetch(calls) });
    await assertRequests({ origin, calls, log: server.log.slice(start), answered: server.answered.slice(startAnswered) }, expected.requests);
    const expectedBlock = block(origin, expected.chain(origin), { contentType: expected.contentType, outcome: "not_found" });
    assertBlock(probed, expectedBlock);
    const observation = availabilityObservation({ origin, path: configured, query, availability: probed });
    const read = await rowFor(observation, { result: "warning", reasonCode: "not_found", acceptEligible: true, coverage: ANSWERED(), state: availabilityState("not_found", observation, expectedBlock) });
    assert.deepEqual([read.result, read.reason_code, read.accept_eligible, read.members], ["warning", "not_found", true, []], "the read row is an accept-eligible not_found warning");
    return read;
  };

  const measured = await readOnce(beforePath, before, configuredQuery[0], configuredPath[0]);
  const record = await acceptOn(measured);
  assert.deepEqual(assessQcAccepts([record], [measured]).map(({ status, why }) => [status, why]), [["active", null]], "setup: the accept is active on the measured state");

  change();
  const current = await readOnce(afterPath, afterExpected, configuredQuery[1], configuredPath[1]);
  assert.equal(current.id, measured.id, "the same result id");
  assert.notEqual(current.state_fingerprint, measured.state_fingerprint, "the state fingerprint moved");
  assert.deepEqual(assessQcAccepts([record], [current]).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]], "the accept lapses");
}

test("F1.4-B7 accepted availability not_found; configured URL changes ?v=1 -> ?v=2, still 404: accept lapsed (state_changed)", async (t) => {
  const routes = (path) => (["/b7/terms?v=1", "/b7/terms?v=2"].includes(path) ? { status: 404 } : undefined);
  const result = (query) => ({ requests: [`/b7/terms?${query}`], chain: (origin) => [hop(origin, "/b7/terms", query, 404)], contentType: "text/html" });
  await assertLapse(t, {
    routes,
    change: () => {},
    beforePath: "/b7/terms?v=1",
    afterPath: "/b7/terms?v=2",
    configuredPath: ["/b7/terms", "/b7/terms"],
    configuredQuery: ["v=1", "v=2"],
    before: result("v=1"),
    after: result("v=2"),
  });
});

test("F1.4-B8 accepted availability not_found reached via /hop?v=1; the intermediate hop becomes /hop?v=2, same final 404: accept lapsed (state_changed)", async (t) => {
  let hopQuery = "v=1";
  const routes = (path) => {
    if (path === "/b8/start") return { status: 302, location: `/b8/hop?${hopQuery}` };
    if (path === `/b8/hop?${hopQuery}`) return { status: 302, location: "/b8/end" };
    if (path === "/b8/end") return { status: 404 };
    return undefined;
  };
  const result = (query) => ({
    requests: ["/b8/start", `/b8/hop?${query}`, "/b8/end"],
    chain: (origin) => [hop(origin, "/b8/start", null, 302), hop(origin, "/b8/hop", query, 302), hop(origin, "/b8/end", null, 404)],
    contentType: "text/html",
  });
  await assertLapse(t, { routes, change: () => { hopQuery = "v=2"; }, beforePath: "/b8/start", before: result("v=1"), after: result("v=2") });
});

test("F1.4-B9 accepted availability not_found; the final 404 URL's query changes ?a=1 -> ?a=2: accept lapsed (state_changed)", async (t) => {
  let finalQuery = "a=1";
  const routes = (path) => {
    if (path === "/b9/start") return { status: 302, location: `/b9/gone?${finalQuery}` };
    if (path === `/b9/gone?${finalQuery}`) return { status: 404 };
    return undefined;
  };
  const result = (query) => ({
    requests: ["/b9/start", `/b9/gone?${query}`],
    chain: (origin) => [hop(origin, "/b9/start", null, 302), hop(origin, "/b9/gone", query, 404)],
    contentType: "text/html",
  });
  await assertLapse(t, { routes, change: () => { finalQuery = "a=2"; }, beforePath: "/b9/start", before: result("a=1"), after: result("a=2") });
});

test("F1.4-B11 accepted F1.4-B3; status changes from 404 to 410: accept lapsed (state_changed)", async (t) => {
  let status = 404;
  const routes = (path) => (path === "/b11/terms" ? { status } : undefined);
  const result = (answered) => ({ requests: ["/b11/terms"], chain: (origin) => [hop(origin, "/b11/terms", null, answered)], contentType: "text/html" });
  await assertLapse(t, { routes, change: () => { status = 410; }, beforePath: "/b11/terms", before: result(404), after: result(410) });
});

test("F1.4-B13 accepted F1.4-B3; the 404 response's content type changes from text/html to text/plain: accept lapsed (state_changed)", async (t) => {
  let type = "text/html; charset=utf-8";
  const routes = (path) => (path === "/b13/terms" ? { status: 404, type } : undefined);
  const result = (contentType) => ({ requests: ["/b13/terms"], chain: (origin) => [hop(origin, "/b13/terms", null, 404)], contentType });
  await assertLapse(t, { routes, change: () => { type = "text/plain; charset=utf-8"; }, beforePath: "/b13/terms", before: result("text/html"), after: result("text/plain") });
});
