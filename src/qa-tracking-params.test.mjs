// Unit 1.1 frozen fixture rows, leg QN: stored observations re-evaluated in
// node (contract §1.1 Accepts "State" and "Lapse"), and the run-scope row of a
// QA run with no browser test order (contract §1.1 "Without a test order").
//
// Each lapse row builds a stored tracking observation, produces its row the
// way the producer does (the real module's rederiveQcResult, then the 1.0
// buildQcResult and toQaAssertion), records a real accept on it
// (createQcAccept), then changes exactly one stored field, rebuilds the row
// from the changed observation, reads both through the 1.0 QA reader with the
// real module loaded from the registry (no stand-in), and assesses the accept.
//
// API assumption (B8-B14, I15): rederiveQcResult(observation) returns the 1.0
// Derived shape {check, subject, result, reason_code, members,
// accept_eligible, coverage, state} for a stored attempt observation shaped as
// below (one shape for all three rows of an attempt; `check` and, for a tag
// row, `tag` pick the row):
//   { check, plan, tag?, run_id, attempt_id,
//     seeds: { "<url param>": "<synthetic seed value>" },   // the seed table
//     preserve: [names],
//     hops: [{ seq, path: "<origin+path>", initiator: "runner"|"page",
//              kind: "document"|"history", observer_attached,
//              params: { "<url param>": "equal"|"differs"|"absent" } }],
//     measured_seed_seq,            // the last pre-page-hop runner load
//     post_order_seq,               // the post-order navigation, or null
//     create: "accepted"|"rejected"|"failed"|"none",
//     attribution_object, page_script_involved,
//     fields: [{ field, source: "request"|"create_response"|"readback", outcome }],
//     names: [{ tag_or_name, source, outcome, literal_sha256? }] }  // a name with literal_sha256 is a rendered tag
// and the subject is {check, page: plan, key: "url" | "order" | "tag:<tag>"}.
//
// API assumption (members): URL members are keyed by URL parameter name, order
// members by credited field, with the five credited fields the default policy
// never seeds as explicit excluded / not_seeded_by_policy members; a tag row
// does not aggregate, so its members are [].
//
// API assumption (I16): __qaNodeTestHooks.maybeRunTestOrders resolves to an
// object whose qc_results lists the run-scope 1.1 rows, one per 1.1 check, and
// pushes their browser-test-order qc.* assertions into `assertions`. A
// run-scope row has no plan, so its subject is run-scoped: page "run", with
// key "url", "order" or "tag" (no tag was rendered), and no members (nothing
// was seeded or rendered). Its ids are therefore the literals below.
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

// The factory (no-network guard) is imported before any module under test.
import { BUILD_FP, OPERATOR, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict, sha256 } from "./qc-test-factories.mjs";
import { assertLoopbackOnly, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

// The factory guard covers fetch and http(s); the fixture guard adds every
// raw TCP or TLS socket connect (net.Socket.connect, net.connect,
// tls.connect) and WebSocket beneath it, so a swallowed non-loopback attempt
// through any of them still fails the test.
installNodeGuard({ transports: false });
afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const PLAN = "checkout";
const ORIGIN = "http://127.0.0.1:4100";
const RUN_ID = "qa-tracking-synthetic-run-0001";
const ATTEMPT_ID = "checkout:1";
const URL_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affid", "sub1", "subaffiliate2"];
const FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affiliate", "subaffiliate1", "subaffiliate2"];
const SOURCES = ["request", "create_response", "readback"];
const SEEDS = Object.freeze(Object.fromEntries(URL_KEYS.map((key) => [key, `cosqa_${key}_0a1b2c3d`])));
const URL_ID = `tracking.url:${PLAN}:url`;
const ORDER_ID = `tracking.order:${PLAN}:order`;
const TAG_ID = `tracking.tag:${PLAN}:tag:syn_tag`;
const SUBJECTS = Object.freeze({
  "tracking.url:checkout:url": { check: "tracking.url", page: "checkout", key: "url" },
  "tracking.order:checkout:order": { check: "tracking.order", page: "checkout", key: "order" },
  "tracking.tag:checkout:tag:syn_tag": { check: "tracking.tag", page: "checkout", key: "tag:syn_tag" },
});
const RUN_SCOPE_SUBJECTS = Object.freeze({
  "tracking.url:run:url": { check: "tracking.url", page: "run", key: "url" },
  "tracking.order:run:order": { check: "tracking.order", page: "run", key: "order" },
  "tracking.tag:run:tag": { check: "tracking.tag", page: "run", key: "tag" },
});
const NOT_SEEDED = ["funnel", "gclid", "subaffiliate3", "subaffiliate4", "subaffiliate5"];
const members = (keys, result, reasonCode) => Object.fromEntries(keys.map((key) => [key, [result, reasonCode]]));
// url_param_dropped on utm_medium; every other seeded key passes.
const URL_DROPPED_MEMBERS = Object.freeze({ ...members(URL_KEYS, "pass", null), utm_medium: ["warning", "url_param_dropped"] });
// order_attribution_differs on utm_source; the other seeded fields pass and
// the five unseeded fields are excluded by policy.
const ORDER_DIFFERS_MEMBERS = Object.freeze({ ...members(FIELDS, "pass", null), ...members(NOT_SEEDED, "excluded", "not_seeded_by_policy"), utm_source: ["warning", "order_attribution_differs"] });

function assertExactMembers(row, expected) {
  assert.ok(Array.isArray(row.members), `${row.id} lists its members`);
  const actual = {};
  for (const member of row.members) {
    assert.equal(Object.hasOwn(actual, member.key), false, `${row.id} lists member ${member.key} once`);
    actual[member.key] = [member.result, member.reason_code ?? null];
  }
  assert.deepEqual(actual, expected, `${row.id} lists exactly the setup's members, results and reason codes`);
}
const E = "evidence_not_reproducible";

function hop(seq, path, initiator, outcomes = {}) {
  return {
    seq,
    path: `${ORIGIN}${path}`,
    initiator,
    kind: "document",
    observer_attached: true,
    params: Object.fromEntries(URL_KEYS.map((key) => [key, outcomes[key] ?? "equal"])),
  };
}

// A complete attempt: checkout probe and entry load (runner, both seeded; the
// entry load is the measured seed hop), then three page document hops, the
// last after the accepted create. `dropAt` puts utm_medium absent from that
// seq on (url_param_dropped between dropAt - 1 and dropAt).
function observation({ check = "tracking.url", tag = null, dropAt = null, fieldOutcomes = {}, names = [], ...patch } = {}) {
  const absentFrom = (seq) => (dropAt != null && seq >= dropAt ? { utm_medium: "absent" } : {});
  return {
    check,
    plan: PLAN,
    ...(tag ? { tag } : {}),
    run_id: RUN_ID,
    attempt_id: ATTEMPT_ID,
    seeds: { ...SEEDS },
    preserve: [],
    hops: [
      hop(0, "/x/checkout/", "runner"),
      hop(1, "/x/landing/", "runner"),
      hop(2, "/x/bridge/", "page", absentFrom(2)),
      hop(3, "/x/checkout/", "page", absentFrom(3)),
      hop(4, "/x/receipt/", "page", absentFrom(4)),
    ],
    measured_seed_seq: 1,
    post_order_seq: 4,
    create: "accepted",
    attribution_object: true,
    page_script_involved: false,
    fields: FIELDS.flatMap((field) => SOURCES.map((source) => ({ field, source, outcome: fieldOutcomes[field]?.[source] ?? "equal" }))),
    names,
    ...patch,
  };
}

// url_param_dropped: utm_medium equal at page hop 1 (seq 2), absent at
// document page hop 2 (seq 3) and after.
const droppedAtHop2 = (patch = {}) => observation({ dropAt: 3, ...patch });

// order_attribution_differs: utm_source differs in the request and the create
// echo; the readback echo is absent.
const orderDiffers = (readback = "absent") => observation({
  check: "tracking.order",
  fieldOutcomes: { utm_source: { request: "differs", create_response: "differs", readback } },
});

// tag_value_differs: syn_tag rendered with literal syn_v; the request carries
// another value; no page script.
const tagDiffers = (literal = "syn_v") => observation({
  check: "tracking.tag",
  tag: "syn_tag",
  names: [{ tag_or_name: "syn_tag", source: "request", outcome: "differs", literal_sha256: sha256(literal) }],
});

const measuredAt = new Date(Date.now() - 60_000).toISOString();

// The producer's row for an observation.
async function rowFor(observationValue) {
  const { rederiveQcResult } = await import("./qa-tracking-params.mjs");
  const { buildQcResult } = await import("./qc-results.mjs");
  const derived = rederiveQcResult(observationValue);
  assert.ok(derived && typeof derived === "object", "the observation re-derives");
  return buildQcResult({
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
}

// The 1.0 QA reader over rows and their verdict assertions, with the real
// module from the registry.
async function readRows(rows) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults, toQaAssertion } = await import("./qc-results.mjs");
  const assertions = rows.map((row) => toQaAssertion(row, { family: "browser-test-order" }));
  const results = readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions, measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  assert.deepEqual(results.map((row) => row.id), rows.map((row) => row.id), "the reader lists exactly the stored ids");
  return results;
}

async function acceptOn(row) {
  const { createQcAccept, qcAcceptAttribution } = await import("./qc-accept.mjs");
  const attribution = qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now: new Date().toISOString() });
  return createQcAccept(row, { measuredAt, attribution });
}

// The lapse rows: accept the warning read from `before`, then read `after`
// (one stored field changed) and assess the same accept. `members` are the
// measured row's exact members; `afterMembers` the changed row's.
async function assertLapses({ before, after, id, reasonCode, members: expected, afterMembers = expected }) {
  const { assessQcAccepts } = await import("./qc-accept.mjs");
  const [measured] = await readRows([await rowFor(before)]);
  assert.equal(measured.id, id, `setup: the row is ${id}`);
  assert.deepEqual(measured.subject, SUBJECTS[id], `setup: ${id} subject`);
  assertExactMembers(measured, expected);
  assert.equal(measured.result, "warning", `setup: ${id} reads warning`);
  assert.equal(measured.reason_code, reasonCode, `setup: ${id} reads ${reasonCode}`);
  assert.equal(measured.accept_eligible, true, "setup: the warning is accept-eligible");
  const record = await acceptOn(measured);
  assert.deepEqual(assessQcAccepts([record], [measured]).map(({ status, why }) => [status, why]), [["active", null]], "setup: the accept is active on the measured state");

  const [current] = await readRows([await rowFor(after)]);
  assert.equal(current.id, id, "the changed observation names the same result");
  assert.deepEqual(current.subject, SUBJECTS[id], "the changed observation keeps the subject");
  assertExactMembers(current, afterMembers);
  assert.notEqual(current.reason_code, E, "the changed observation still re-derives");
  assert.notEqual(current.state_fingerprint, measured.state_fingerprint, "the state fingerprint moved");
  assert.deepEqual(assessQcAccepts([record], [current]).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]], "the accept lapses");
}

// ---------------------------------------------------------------------------
// Broken (accept lapse)

test("F1.1-B8 accepted url_param_dropped; stored observation re-evaluated with a different attempt_id only: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: droppedAtHop2(), after: droppedAtHop2({ attempt_id: "checkout:2" }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS });
});

test("F1.1-B9 accepted url_param_dropped; stored hop matrix re-evaluated with the drop at hop 3 instead of hop 2: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: droppedAtHop2(), after: observation({ dropAt: 4 }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS });
});

test("F1.1-B10 accepted order_attribution_differs; stored readback outcome changes from absent to differs: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: orderDiffers("absent"), after: orderDiffers("differs"), id: ORDER_ID, reasonCode: "order_attribution_differs", members: ORDER_DIFFERS_MEMBERS });
});

test("F1.1-B11 accepted url_param_dropped; stored observation re-evaluated with a different run_id only: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: droppedAtHop2(), after: droppedAtHop2({ run_id: "qa-tracking-synthetic-run-0002" }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS });
});

test("F1.1-B12 accepted url_param_dropped; stored observation re-evaluated with one expected seed value changed only: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: droppedAtHop2(), after: droppedAtHop2({ seeds: { ...SEEDS, utm_source: "cosqa_utm_source_ffffffff" } }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS });
});

test("F1.1-B13 accepted url_param_dropped; stored observation re-evaluated with create changed from accepted to rejected only: accept lapsed (state_changed)", async () => {
  // With the create rejected there is no post-order navigation (contract §1.1:
  // the first page document hop after an ACCEPTED create). utm_medium's drop
  // between two observed page hops is still a warning; every other seeded key
  // was equal throughout but never reached the post-order navigation with no
  // warning condition of its own: unexercised / attempt_incomplete.
  const afterMembers = { ...members(URL_KEYS, "unexercised", "attempt_incomplete"), utm_medium: ["warning", "url_param_dropped"] };
  await assertLapses({ before: droppedAtHop2(), after: droppedAtHop2({ create: "rejected" }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS, afterMembers });
});

test("F1.1-B14 accepted url_param_dropped; stored observation re-evaluated with page_script_involved changed from false to true only: accept lapsed (state_changed)", async () => {
  await assertLapses({ before: droppedAtHop2(), after: droppedAtHop2({ page_script_involved: true }), id: URL_ID, reasonCode: "url_param_dropped", members: URL_DROPPED_MEMBERS });
});

test("F1.1-I15 accepted tag_value_differs; stored observation re-evaluated with only literal_sha256 changed (run identity held): accept lapsed (state_changed)", async () => {
  const before = tagDiffers("syn_v");
  const after = tagDiffers("syn_v2");
  assert.deepEqual([after.run_id, after.attempt_id], [before.run_id, before.attempt_id], "setup: run identity held");
  await assertLapses({ before, after, id: TAG_ID, reasonCode: "tag_value_differs", members: {} });
});

// ---------------------------------------------------------------------------
// Incomplete (run scope)

test("F1.1-I16 QA run with no test order requested: excluded (test_order_not_requested)", async () => {
  const { __qaNodeTestHooks } = await import("./qa-node.mjs");
  const assertions = [];
  const outcome = await __qaNodeTestHooks.maybeRunTestOrders({ args: {}, resolved: { topologies: [] }, runId: "qa-tracking-no-order", assertions });
  assert.deepEqual(outcome.orders, [], "setup: no test order ran");
  const ids = Object.keys(RUN_SCOPE_SUBJECTS);
  const rows = (Array.isArray(outcome.qc_results) ? outcome.qc_results : []).filter((row) => String(row?.check || "").startsWith("tracking."));
  assert.deepEqual(rows.map((row) => row.id).sort(), [...ids].sort(), "exactly the run-scope 1.1 result ids");
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    assert.deepEqual(row.subject, RUN_SCOPE_SUBJECTS[id], `${id} has its run-scoped subject`);
    assert.equal(row.check, RUN_SCOPE_SUBJECTS[id].check, `${id} check`);
    assert.equal(row.result, "excluded", `${id} reads excluded`);
    assert.equal(row.reason_code, "test_order_not_requested", `${id} reads test_order_not_requested`);
    assert.equal(row.accept_eligible, false, `${id} is not accept-eligible`);
    assertExactMembers(row, {});
  }
  const qcAssertions = assertions.filter((entry) => String(entry?.id || "").startsWith("qc.tracking."));
  assert.deepEqual(qcAssertions.map((entry) => entry.id).sort(), ["qc.tracking.order:run:order", "qc.tracking.tag:run:tag", "qc.tracking.url:run:url"], "one verdict assertion per run-scope row");
  for (const id of ids) {
    const entry = qcAssertions.find((candidate) => candidate.id === `qc.${id}`);
    assert.equal(entry.family, "browser-test-order", `qc.${id} family`);
    assert.equal(entry.page, "run", `qc.${id} page`);
    assert.equal(entry.status, "skipped", `qc.${id} status`);
    assert.equal(entry.severity, "info", `qc.${id} severity`);
    assert.equal(entry.evidence?.qc?.result_id, id, `qc.${id} pairs with ${id}`);
    assert.equal(entry.evidence?.qc?.reason_code, "test_order_not_requested", `qc.${id} reason`);
  }
  const read = await readRows(ids.map((id) => rows.find((row) => row.id === id)));
  assert.deepEqual(
    read.map((row) => [row.id, row.subject, row.result, row.reason_code]),
    ids.map((id) => [id, RUN_SCOPE_SUBJECTS[id], "excluded", "test_order_not_requested"]),
    "the rows re-derive through the 1.0 QA reader",
  );
});
