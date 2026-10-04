// Tracking parameters (1.1): regression rows for the observer and its rules,
// beside the fixture rows in qa-tracking-params.test.mjs. Each group
// pins one class of input that must never read pass, or one persisted exit
// that must never hold a URL query or raw body:
//   - persisted exits (response summaries, arrays, free text, upsell bodies,
//     runner assertions) hold no query value and no raw body;
//   - the create-response hold and every read the runner waits for stay
//     within the attempt's one-second tracking budget, and an overrun is a
//     failed extractor while the order proceeds;
//   - a DOM read, script read, oversized script or timeout is a failed
//     extractor, never a pass;
//   - a read in flight when the observer freezes is awaited and recorded, or
//     is a failed extractor; it is never silently discarded;
//   - every status or completeness marker of a stored observation reads
//     unexercised with the contract's reason unless it holds the complete
//     value;
//   - an observation gap at or before the measured seed hop is never a pass;
//   - every observation of a source is kept, and one that differs is never
//     overwritten by a later equal one;
//   - a tag or order pass needs request-metadata equality, never an echo
//     alone;
//   - every row carries coverage {observed, expected, limits} and the
//     campaign's SDK loader pin.
// Every value is synthetic and nothing leaves the process.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test, { after, afterEach } from "node:test";

import { BUILD_FP, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict } from "./qc-test-factories.mjs";
import { assertLoopbackOnly, assertNothingPrivatePersisted, installNodeGuard, sha256 } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const ORIGIN = "http://127.0.0.1:4100";
const PLAN = "checkout";
const URL_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affid", "sub1", "subaffiliate2"];
const FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "affiliate", "subaffiliate1", "subaffiliate2"];
const FIELD_PARAM = { affiliate: "affid", subaffiliate1: "sub1" };
const ACCEPTED = Object.freeze({ create_requests: 1, accepted_create_responses: 1 });
const PRIVATE = "syn_private_marker_5f1e";
const measuredAt = new Date(Date.now() - 60_000).toISOString();

const tracking = () => import("./qa-tracking-params.mjs");
const browserHooks = async () => (await import("./qa-browser.mjs")).__qaBrowserTestHooks;

const addParam = (url, key, value) => {
  const next = new URL(url);
  next.searchParams.set(key, value);
  return next.toString();
};

// A document read that answers with `value` (or rejects, or never answers).
const pageAnswering = (value) => ({ evaluate: async () => value });
const pageRejecting = () => ({ evaluate: async () => { throw new Error("synthetic read failure"); } });
const pageHanging = () => ({ evaluate: () => new Promise(() => {}) });
const TAG_READ = Object.freeze({ tags: [{ name: "syn_tag", value: "syn_v" }], inline: false, pins: [] });

// A script response the page already received.
function scriptResponse({ url = `${ORIGIN}/syn.js`, headers = {}, body = () => Promise.resolve(Buffer.from("void 0;")) } = {}) {
  return { url: () => url, headers: () => headers, body };
}

// One attempt driven through the live observer the way captureCheckoutEvents
// and gotoAndSettle drive it: the checkout probe and entry load (runner,
// seeded), a page document hop to checkout, the create request, an accepted
// create, its body as the response listener reads it, and the post-order
// receipt hop. `during(observer)` runs before the create request;
// `afterCreate(observer)` after the accepted create. `page: null` drives the
// attempt with no document read at all.
// The response listener never delivered the create body.
const NO_LISTENER_READ = Symbol("no listener read");
async function liveAttempt({ page = pageAnswering(TAG_READ), during = null, afterCreate = null, request = null, createBody = { ref_id: "synref1" }, hooks = null, spec = null } = {}) {
  const { createTrackingRun } = await tracking();
  const run = createTrackingRun({ runId: "qa-tracking-hardening-run", spec, hooks, random: () => Buffer.from([1, 2, 3, 4]) });
  const observer = run.observe(PLAN);
  // A document hop: the browser's commit signal for its URL, then the hop.
  const navigate = (url) => observer.onFrameNavigated(url, { url, newDocument: true });
  navigate(observer.runnerUrl(`${ORIGIN}/x/checkout/`, addParam));
  const entry = observer.runnerUrl(`${ORIGIN}/x/landing/`, addParam);
  navigate(entry);
  if (page) await observer.readDocument(page);
  const query = new URL(entry).search;
  navigate(`${ORIGIN}/x/checkout/${query}`);
  if (during) await during(observer, run.seeds);
  const attribution = Object.fromEntries(FIELDS.map((field) => [field, run.seeds[FIELD_PARAM[field] || field]]));
  observer.onCreateRequest(request ?? JSON.stringify({ lines: [], attribution: { ...attribution, metadata: { syn_tag: "syn_v" } } }));
  observer.onCreateResponseStatus(201);
  // The response listener's read of the accepted create's body (no echo).
  if (createBody !== NO_LISTENER_READ) await observer.orderResponseBody("create_response", () => createBody);
  if (afterCreate) await afterCreate(observer, run.seeds);
  navigate(`${ORIGIN}/x/receipt/${query}&ref_id=synref1`);
  const observation = await observer.finalize({ createActivity: ACCEPTED });
  return { run, observer, observation, seeds: run.seeds };
}

async function rowsOf(observation) {
  const { trackingQcRows } = await tracking();
  return new Map(trackingQcRows(observation, { measuredAt }).map((row) => [row.id, row]));
}

// The 1.0 QA reader over rows, with the real module loaded from the registry.
async function readRows(rows) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults, toQaAssertion } = await import("./qc-results.mjs");
  return readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: rows.map((row) => toQaAssertion(row, { family: "browser-test-order" })), measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
}

// The producer's row for a stored observation (rederive, then the 1.0 row).
async function storedRow(observation) {
  const { rederiveQcResult } = await tracking();
  const { buildQcResult } = await import("./qc-results.mjs");
  const derived = rederiveQcResult(observation);
  if (!derived) return { derived: null, row: null };
  const row = buildQcResult({ ...derived, leg: "qa", observation, measured_at: measuredAt });
  return { derived, row };
}

const SEEDS = Object.freeze(Object.fromEntries(URL_KEYS.map((key) => [key, `cosqa_${key}_0a1b2c3d`])));
function hop(seq, path, initiator, patch = {}) {
  return { seq, path: `${ORIGIN}${path}`, initiator, kind: "document", observer_attached: true, params: Object.fromEntries(URL_KEYS.map((key) => [key, "equal"])), ...patch };
}
// A complete stored attempt that reads pass on every row.
function stored(patch = {}) {
  return {
    check: "tracking.url",
    plan: PLAN,
    run_id: "qa-tracking-hardening-stored",
    attempt_id: "checkout:1",
    seeds: { ...SEEDS },
    preserve: [],
    hops: [hop(0, "/x/checkout/", "runner"), hop(1, "/x/landing/", "runner"), hop(2, "/x/checkout/", "page"), hop(3, "/x/receipt/", "page")],
    measured_seed_seq: 1,
    post_order_seq: 3,
    create: "accepted",
    attribution_object: true,
    page_script_involved: false,
    fields: FIELDS.map((field) => ({ field, source: "request", outcome: "equal" })),
    names: [{ tag_or_name: "syn_tag", source: "request", outcome: "equal", literal_sha256: sha256("syn_v") }],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Control: the live attempt above reads pass on every row.

test("control: a fully observed live attempt reads pass on the URL, order and tag rows", async () => {
  const { observation } = await liveAttempt();
  assert.deepEqual(observation.extractor_failed, []);
  const rows = await rowsOf(observation);
  assert.deepEqual([...rows.values()].map((row) => [row.id, row.result]), [
    ["tracking.url:checkout:url", "pass"],
    ["tracking.order:checkout:order", "pass"],
    ["tracking.tag:checkout:tag:syn_tag", "pass"],
  ]);
  const read = await readRows([...rows.values()]);
  assert.deepEqual(read.map((row) => row.result), ["pass", "pass", "pass"], "the rows re-derive through the 1.0 QA reader");
});

// ---------------------------------------------------------------------------
// Persisted exits

test("persisted events: response summaries keep checkout_url as origin+path, raw arrays, scalars and strings become the marker, and free text keeps no query", async () => {
  const { sanitizedEvents } = await browserHooks();
  const events = {
    requests: [{ method: "POST", url: `${ORIGIN}/api/v1/orders/?syn_private=${PRIVATE}`, postData: "[redacted-request-body]" }],
    responses: [
      { status: 201, url: `${ORIGIN}/api/v1/orders/?syn_private=${PRIVATE}`, body: { ref_id: "synref1", checkout_url: `${ORIGIN}/x/checkout/?syn_private=${PRIVATE}`, detail: `see ${ORIGIN}/x/?syn_private=${PRIVATE}` } },
      { status: 200, url: `${ORIGIN}/api/v1/carts/`, body: [PRIVATE, { syn: PRIVATE }] },
      { status: 200, url: `${ORIGIN}/api/v1/carts/`, body: `raw ${PRIVATE}` },
      { status: 200, url: `${ORIGIN}/api/v1/carts/`, body: 42 },
      { status: 400, url: `${ORIGIN}/api/v1/orders/`, body: { payment_details: `declined at ${ORIGIN}/pay/?syn_private=${PRIVATE}` } },
    ],
    failed: [{ url: `${ORIGIN}/x/?syn_private=${PRIVATE}`, failure: `net::ERR_FAILED ${ORIGIN}/x/?syn_private=${PRIVATE}` }],
    console: [{ type: "error", text: `Failed to load ${ORIGIN}/x/landing/?syn_private=${PRIVATE}` }],
    pageErrors: [`TypeError at ${ORIGIN}/x/landing/?syn_private=${PRIVATE}#frag`],
    navigations: [{ url: `${ORIGIN}/x/landing/` }],
  };
  const persisted = sanitizedEvents(events);
  assert.equal(JSON.stringify(persisted).includes(PRIVATE), false, "no private value anywhere");
  assertNothingPrivatePersisted(withoutBodyMarkers(persisted), { markers: { private: PRIVATE } });
  assert.equal(persisted.responses[0].body.checkout_url, `${ORIGIN}/x/checkout/`);
  assert.equal(persisted.responses[0].body.ref_id, "synref1", "the order proof keeps its own field");
  assert.deepEqual(persisted.responses.slice(1, 4).map((response) => response.body), [RESPONSE_BODY_MARKER, RESPONSE_BODY_MARKER, RESPONSE_BODY_MARKER]);
});

test("persisted orders and runner assertions: error text, step notes and an upsell's raw response body keep no query and no body", async () => {
  const { persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  const raw = `${ORIGIN}/x/upsell/?syn_private=${PRIVATE}`;
  const order = {
    path: "accept",
    checkout_url: `${ORIGIN}/x/checkout/?syn_private=${PRIVATE}`,
    final_url: `${ORIGIN}/x/receipt/?syn_private=${PRIVATE}`,
    error: `page.goto: Timeout navigating to "${raw}"`,
    verification: { verified: false, error: `navigating to ${raw}` },
    evidence: { steps: [{ step: "opened_checkout", status: "failed", detail: `goto ${raw}` }] },
    upsell: { offer_url: raw, final_url: raw, api_response_url: raw, api_response_order_body: { ref_id: "synref1", syn_note: PRIVATE, checkout_url: raw } },
    upsell_steps: [{ offer_url: raw, final_url: raw, api_response_order_body: `raw ${PRIVATE}` }],
  };
  const persisted = persistedTestOrder(order);
  assert.equal(JSON.stringify(persisted).includes(PRIVATE), false, "no private value anywhere");
  assert.equal(persisted.upsell_steps[0].api_response_order_body, RESPONSE_BODY_MARKER);
  assertNothingPrivatePersisted(withoutBodyMarkers(persisted), { markers: { private: PRIVATE } });
  assert.equal(order.final_url.includes(PRIVATE), true, "the in-memory order stays raw for recovery");
  const assertion = { id: "browser-test-order:checkout", family: "browser-test-order", actual: `page.goto: Timeout navigating to "${raw}"`, evidence: { steps: order.evidence.steps } };
  assertNothingPrivatePersisted(redactPersisted(assertion), { markers: { private: PRIVATE } });
  const qc = { id: "qc.tracking.url:checkout:url", evidence: { qc: { observation: { hops: [] } } } };
  assert.deepEqual(redactPersisted(qc), qc, "a qc.* assertion is persisted as built");
});

// ---------------------------------------------------------------------------
// Money path: the create-response hold and the tracking budget

function fakeCdpPage(responses = {}) {
  const session = new EventEmitter();
  const sent = [];
  session.send = (method, params) => {
    sent.push({ method, params, at: Date.now() });
    if (responses[method]) return responses[method](params);
    return Promise.resolve({});
  };
  return { sent, session, page: { context: () => ({ newCDPSession: async () => session }) } };
}
// The response-body marker stands for raw body text (string, array or bare
// scalar) that was dropped. The fixture walker knows only null and the
// summary objects for body fields, so the marker is checked by value and set
// to null before the walk, which then searches everything else.
const RESPONSE_BODY_MARKER = "[redacted-response-body]";
function withoutBodyMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutBodyMarkers);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === RESPONSE_BODY_MARKER ? null : withoutBodyMarkers(item)]));
  return value;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an accepted create held for its body is continued within the one-second bound when the body read never settles, and the read is a failed extractor", async () => {
  const { attachCreateResponseTap } = await browserHooks();
  const { createTrackingRun, TRACKING_ADDED_BOUND_MS } = await tracking();
  const observer = createTrackingRun({ runId: "qa-tracking-hardening-tap" }).observe(PLAN);
  const { sent, session, page } = fakeCdpPage({ "Fetch.getResponseBody": () => new Promise(() => {}) });
  await attachCreateResponseTap(page, observer);
  const started = Date.now();
  session.emit("Fetch.requestPaused", { requestId: "create-1", responseStatusCode: 201, request: { method: "POST", url: `${ORIGIN}/api/v1/orders/` } });
  session.emit("Fetch.requestPaused", { requestId: "read-1", responseStatusCode: 200, request: { method: "GET", url: `${ORIGIN}/api/v1/orders/synref1/` } });
  await settle();
  assert.ok(sent.some((entry) => entry.method === "Fetch.continueRequest" && entry.params.requestId === "read-1"), "a response that is not an accepted create is continued at once");
  const deadline = started + TRACKING_ADDED_BOUND_MS + 300;
  while (!sent.some((entry) => entry.method === "Fetch.continueRequest" && entry.params.requestId === "create-1") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const continued = sent.find((entry) => entry.method === "Fetch.continueRequest" && entry.params.requestId === "create-1");
  assert.ok(continued, "the accepted create was continued");
  assert.ok(continued.at - started <= TRACKING_ADDED_BOUND_MS + 150, `the create was held ${continued.at - started} ms`);
  const observation = await observer.finalize({ createActivity: ACCEPTED });
  assert.ok(observation.extractor_failed.includes("response_equality"), "the overrun is recorded as a failed extractor");
});

test("every wait tracking adds to an attempt shares one budget: two hanging document reads and a hanging script read add at most one second in total", async () => {
  const { TRACKING_ADDED_BOUND_MS } = await tracking();
  const started = Date.now();
  const { observation } = await liveAttempt({
    page: pageHanging(),
    during: async (observer) => {
      observer.onScriptResponse(scriptResponse({ body: () => new Promise(() => {}) }));
      await observer.readDocument(pageHanging());
    },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= TRACKING_ADDED_BOUND_MS + 250, `tracking added ${elapsed} ms to the attempt`);
  assert.deepEqual(observation.extractor_failed, ["tag_dom_read", "page_script_scan"], "the reads that ran out of budget are failed extractors");
  const rows = await rowsOf(observation);
  assert.deepEqual([...rows.values()].filter((row) => row.check !== "tracking.url").map((row) => [row.id, row.result, row.reason_code]), [
    ["tracking.order:checkout:order", "unexercised", "extractor_failed"],
    ["tracking.tag:checkout:tag", "unexercised", "extractor_failed"],
  ]);
});

// ---------------------------------------------------------------------------
// Failed reads

const failedReadCases = [
  ["a rejected DOM read", { page: pageRejecting() }],
  ["a rejected script body read", { during: (observer) => observer.onScriptResponse(scriptResponse({ body: () => Promise.reject(new Error("synthetic")) })) }],
  ["a script declared over 1 MiB", { during: (observer) => observer.onScriptResponse(scriptResponse({ headers: { "content-length": String(1024 * 1024 + 1) } })) }],
  ["a script body over 1 MiB with no declared length", { during: (observer) => observer.onScriptResponse(scriptResponse({ body: () => Promise.resolve(Buffer.alloc(1024 * 1024 + 1, 0x20)) })) }],
  ["a DOM read that returns no object", { page: pageAnswering(null) }],
  ["a request body read that throws", { request: () => { throw new Error("synthetic postData failure"); } }],
];
for (const [label, setup] of failedReadCases) {
  test(`${label} is a failed extractor and the order row never reads pass`, async () => {
    const { observation } = await liveAttempt(setup);
    assert.ok(observation.extractor_failed.length > 0, "a failed extractor is recorded");
    const rows = await rowsOf(observation);
    const order = rows.get("tracking.order:checkout:order");
    assert.deepEqual([order.result, order.reason_code], ["unexercised", "extractor_failed"]);
    for (const row of rows.values()) if (row.check === "tracking.tag") assert.notEqual(row.result, "pass", `${row.id} is not a pass`);
    const read = await readRows([...rows.values()]);
    assert.equal(read.find((row) => row.id === order.id).result, "unexercised", "the reader re-derives the same refusal");
  });
}

// ---------------------------------------------------------------------------
// In-flight reads: a read in flight when the observer freezes (the create
// request, finalize) is awaited within its bound and recorded, or recorded as
// a failed extractor; it is never silently discarded.

const ORDER = "tracking.order:checkout:order";
const TAG = "tracking.tag:checkout:tag:syn_tag";
const resultOf = (row) => [row.result, row.reason_code];

test("in flight at the create request: a DOM read begun before it and landing after it is recorded (tag literal and inline page script)", async () => {
  let land = null;
  let reading = null;
  const slowPage = { evaluate: () => new Promise((resolve) => { land = resolve; }) };
  const { observation } = await liveAttempt({
    during: (observer) => { reading = observer.readDocument(slowPage, { awaited: false }); },
    afterCreate: async () => {
      land({ tags: [{ name: "syn_tag", value: "syn_late" }], inline: true, pins: [] });
      await reading;
    },
  });
  assert.equal(observation.page_script_involved, true, "the inline page-script call is recorded");
  assert.deepEqual(observation.extractor_failed, []);
  const rows = await rowsOf(observation);
  assert.deepEqual(resultOf(rows.get(TAG)), ["review", "page_script_mapping"], "the later literal is compared, not dropped");
  const read = await readRows([...rows.values()]);
  assert.deepEqual(resultOf(read.find((row) => row.id === TAG)), ["review", "page_script_mapping"]);
});

test("in flight at finalize: the held create-body read is awaited within the budget and its echo recorded", async () => {
  const { observation } = await liveAttempt({
    afterCreate: (observer) => {
      observer.tapCreateResponse(() => new Promise((resolve) => setTimeout(() => resolve({ attribution: { utm_source: "syn_other" } }), 50)));
    },
  });
  const rows = await rowsOf(observation);
  assert.deepEqual(resultOf(rows.get(ORDER)), ["warning", "order_attribution_differs"]);
});

test("in flight across the navigation: a read-back body the listener could not read is a failed extractor, never a pass", async () => {
  const { observation } = await liveAttempt({ afterCreate: (observer) => observer.orderResponseBody("readback", () => null) });
  assert.ok(observation.extractor_failed.includes("response_equality"));
  const rows = await rowsOf(observation);
  assert.deepEqual(resultOf(rows.get(ORDER)), ["unexercised", "extractor_failed"]);
});

test("an accepted create whose body no reader read is a failed extractor; one the held tap read is not", async () => {
  const unread = await liveAttempt({ createBody: NO_LISTENER_READ });
  assert.deepEqual(resultOf((await rowsOf(unread.observation)).get(ORDER)), ["unexercised", "extractor_failed"]);
  const listenerFailed = await liveAttempt({ createBody: NO_LISTENER_READ, afterCreate: (observer) => observer.orderResponseBody("create_response", () => null) });
  assert.deepEqual(resultOf((await rowsOf(listenerFailed.observation)).get(ORDER)), ["unexercised", "extractor_failed"]);
  const tapped = await liveAttempt({ createBody: null, afterCreate: (observer) => observer.tapCreateResponse(async () => ({ ref_id: "synref1" })) });
  assert.deepEqual(resultOf((await rowsOf(tapped.observation)).get(ORDER)), ["pass", null]);
});

test("a read pending when the observation is taken is failed in it; settling afterwards changes neither the observation nor a row built from it", async () => {
  const { TRACKING_OBSERVATION } = await tracking();
  let land = null;
  const { run, observation } = await liveAttempt({
    afterCreate: (observer) => { observer.orderResponseBody("readback", () => new Promise((resolve) => { land = resolve; })); },
  });
  assert.ok(observation.extractor_failed.includes("response_equality"), "the pending read-back is a failed extractor");
  const taken = structuredClone(observation);
  const before = run.rowsFor({ attempts: [{ [TRACKING_OBSERVATION]: observation }], measuredAt });
  assert.deepEqual(resultOf(before.find((row) => row.id === ORDER)), ["unexercised", "extractor_failed"]);
  land({ attribution: { utm_source: "syn_other" } });
  await settle();
  assert.deepEqual(observation, taken, "the observation is never written after it is taken");
  const afterRows = run.rowsFor({ attempts: [{ [TRACKING_OBSERVATION]: observation }], measuredAt });
  assert.deepEqual(afterRows, before, "a row built before the read settled equals one built after");
});

// A page captureCheckoutEvents can listen on, with every event a 1.1 listener
// reads: requests (create and navigation), responses, main-frame navigations
// and domcontentloaded.
function fakeEventPage(evaluate = async () => TAG_READ) {
  const page = new EventEmitter();
  const frame = { url: () => `${ORIGIN}/x/receipt/` };
  const { session } = fakeCdpPage();
  page.mainFrame = () => frame;
  page.context = () => ({ newCDPSession: async () => session });
  page.evaluate = evaluate;
  return { page, frame };
}
function fakeRequest({ url, method = "GET", postData = null, navigation = false, frame = null }) {
  return { url: () => url, method: () => method, postData: () => postData, isNavigationRequest: () => navigation, frame: () => frame, resourceType: () => (navigation ? "document" : "fetch") };
}

test("after finalize: every event that arrives (through the actual listeners and the observer's own entry points) leaves the taken observation and its rows unchanged", async () => {
  const { captureCheckoutEvents } = await browserHooks();
  const { TRACKING_OBSERVATION } = await tracking();
  let listened = null;
  const { run, observer, observation } = await liveAttempt({
    afterCreate: (live) => {
      listened = fakeEventPage(async () => ({ tags: [{ name: "syn_tag", value: "syn_late" }], inline: true, pins: [] }));
      captureCheckoutEvents(listened.page, live);
    },
  });
  const attempts = [{ [TRACKING_OBSERVATION]: observation }];
  const before = run.rowsFor({ attempts, measuredAt });
  assert.deepEqual(before.map(resultOf), [["pass", null], ["pass", null], ["pass", null]], "setup: the taken observation reads pass on every row");
  const taken = structuredClone(observation);
  const late = JSON.stringify({ ref_id: "synref1", attribution: { utm_source: "syn_other", metadata: { syn_tag: "syn_other" } } });
  const { page, frame } = listened;
  // Through the actual listeners.
  page.emit("request", fakeRequest({ url: `${ORIGIN}/api/v1/orders/`, method: "POST", postData: late }));
  page.emit("response", fakeResponse({ url: `${ORIGIN}/api/v1/orders/`, method: "POST", status: 201, text: async () => late }));
  page.emit("response", fakeResponse({ url: `${ORIGIN}/api/v1/orders/synref1/`, text: async () => late }));
  page.emit("request", fakeRequest({ url: `${ORIGIN}/x/upsell/`, navigation: true, frame }));
  page.emit("framenavigated", frame);
  page.emit("domcontentloaded");
  // Through the observer's own entry points.
  observer.onCreateRequest(late);
  observer.onCreateResponseStatus(201);
  observer.onFrameNavigated(`${ORIGIN}/x/upsell/`);
  observer.onFrameNavigated(`${ORIGIN}/x/upsell/`, { url: `${ORIGIN}/x/upsell/`, newDocument: true });
  observer.onListenerError("hop");
  observer.onListenerError("response");
  await observer.orderResponseBody("readback", () => JSON.parse(late));
  await observer.tapCreateResponse(async () => JSON.parse(late));
  await observer.readDocument(pageAnswering({ tags: [{ name: "syn_tag", value: "syn_late" }], inline: true, pins: [] }));
  await observer.onScriptResponse(scriptResponse({ body: () => Promise.resolve(Buffer.from("next.setAttribution({});")) }));
  await settle();
  await settle();
  assert.deepEqual(observation, taken, "the taken observation is never written by a later event");
  assert.equal(await observer.finalize({ createActivity: ACCEPTED }), observation, "finalizing again returns the taken observation");
  const afterRows = run.rowsFor({ attempts, measuredAt });
  assert.deepEqual(afterRows, before, "rows built after the late events equal the rows built before them");
  assert.deepEqual((await readRows(afterRows)).map(resultOf), before.map(resultOf), "the shared reader re-derives the same rows");
});

// ---------------------------------------------------------------------------
// The runner's recovery flag: rowsFor only ever sets recovered true (the
// runner recovered the chosen attempt on a new page). Any other recovered
// value stays as captured and reads as not complete.

const URL_ID = "tracking.url:checkout:url";
const DELETE_KEY = Symbol("deleted key");
const RECOVERED_MUTATIONS = [["deleted", DELETE_KEY], ["null", null], ["\"unknown\"", "unknown"], ["{}", {}], ["true", true]];
function setRecovered(observation, value) {
  if (value === DELETE_KEY) delete observation.recovered;
  else observation.recovered = structuredClone(value);
}

test("rowsFor: a deleted, null, unknown, ill-typed or true recovered marker is never replaced with a success value (capture and stored paths, no recoveredAttempt)", async () => {
  const { TRACKING_OBSERVATION } = await tracking();
  const control = await liveAttempt();
  assert.deepEqual(control.run.rowsFor({ attempts: [{ [TRACKING_OBSERVATION]: control.observation }], measuredAt }).map(resultOf).slice(0, 2), [["pass", null], ["pass", null]], "control: recovered false reads pass");
  for (const [label, value] of RECOVERED_MUTATIONS) {
    const captured = await liveAttempt({ hooks: { rawObservation: (raw) => setRecovered(raw, value) } });
    const storedObservation = structuredClone((await liveAttempt()).observation);
    setRecovered(storedObservation, value);
    for (const [path, run, observation] of [["capture", captured.run, captured.observation], ["stored", control.run, storedObservation]]) {
      const rows = run.rowsFor({ attempts: [{ [TRACKING_OBSERVATION]: observation }], measuredAt });
      for (const id of [URL_ID, ORDER]) {
        const row = rows.find((candidate) => candidate.id === id);
        assert.deepEqual(resultOf(row), ["unexercised", "attempt_recovered_on_new_page"], `${path} ${label}: ${id}`);
      }
      for (const row of await readRows(rows.filter((candidate) => [URL_ID, ORDER].includes(candidate.id)))) {
        assert.deepEqual(resultOf(row), ["unexercised", "attempt_recovered_on_new_page"], `${path} ${label}: ${row.id} through the shared reader`);
      }
    }
  }
});

test("rowsFor: the attempt the runner recovered reads attempt_recovered_on_new_page; the taken observation itself is not written", async () => {
  const { TRACKING_OBSERVATION } = await tracking();
  const { run, observation } = await liveAttempt();
  const attempt = { [TRACKING_OBSERVATION]: observation };
  const rows = run.rowsFor({ attempts: [attempt], recoveredAttempt: attempt, measuredAt });
  assert.deepEqual(rows.filter((row) => row.check !== "tracking.tag").map(resultOf), [["unexercised", "attempt_recovered_on_new_page"], ["unexercised", "attempt_recovered_on_new_page"]]);
  assert.equal(observation.recovered, false);
});

// ---------------------------------------------------------------------------
// A marker fed by a read starts not complete and becomes complete only when
// that read completes. Initial values (the observer before any event):
//   tag_read              "not_run"  -> "read" when a document's tag list is read
//   page_script_involved  null       -> a boolean when a document's inline
//                                       scripts are scanned (true also when
//                                       any scan finds a page-script call)
//   sdk_test_attribution  null       -> a boolean when a create body is parsed
//   request_read          "none"     -> "parsed" when every create body parses
//   attribution_object    false      -> true when every parsed body carries one
//   create                "none"     -> the create activity's outcome
//   measured_seed_seq     null       -> the seq of the last seeded runner hop
//   post_order_seq        null       -> the first page document hop after an
//                                       accepted create
// extractor_failed ([]) and recovered (false) record failures and the
// runner's recovery, not a read; each extractor's own run is carried by the
// markers above (and hop_equality by the hops themselves).

test("initial values: an observer finalized before any event holds no complete value for any marker a read feeds", async () => {
  const { createTrackingRun, OBSERVATION_MARKERS } = await tracking();
  const observation = await createTrackingRun({ runId: "qa-tracking-hardening-empty" }).observe(PLAN).finalize();
  const READ_INDEPENDENT = ["extractor_failed", "recovered"];
  const levels = Object.entries(OBSERVATION_MARKERS).filter(([, marker]) => marker.at === "observation");
  for (const [id, marker] of levels) {
    if (READ_INDEPENDENT.includes(id)) continue;
    assert.equal(marker.valid(observation[marker.key], { seqs: new Set(), declared: new Set(), contractShape: false }, observation, true), true, `${id} initial value is in the schema`);
    assert.equal(marker.complete(observation[marker.key]), false, `${id} initial value ${JSON.stringify(observation[marker.key])} is not complete`);
  }
  assert.deepEqual(
    Object.fromEntries(["tag_read", "page_script_involved", "sdk_test_attribution", "request_read", "attribution_object", "create", "measured_seed_seq", "post_order_seq"].map((key) => [key, observation[key]])),
    { tag_read: "not_run", page_script_involved: null, sdk_test_attribution: null, request_read: "none", attribution_object: false, create: "none", measured_seed_seq: null, post_order_seq: null },
  );
  assert.deepEqual(observation.extractor_failed, ["tag_dom_read", "page_script_scan"], "the reads that never ran are failed extractors");
});

test("not run: an accepted attempt whose document read never ran reads no pass on the order or tag row (tag_read not_run, page_script_involved null)", async () => {
  const { observation } = await liveAttempt({ page: null });
  assert.equal(observation.tag_read, "not_run");
  assert.equal(observation.page_script_involved, null);
  assert.deepEqual(observation.extractor_failed, ["tag_dom_read", "page_script_scan"]);
  const rows = await rowsOf(observation);
  assert.deepEqual([...rows.values()].map((row) => [row.id, ...resultOf(row)]), [
    [URL_ID, "pass", null],
    [ORDER, "unexercised", "extractor_failed"],
    ["tracking.tag:checkout:tag", "unexercised", "extractor_failed"],
  ]);
  assert.deepEqual((await readRows([...rows.values()])).map(resultOf), [...rows.values()].map(resultOf), "the shared reader re-derives the same rows");
});

test("not run: a script scan that found no call does not complete the page-script scan without a document read", async () => {
  const { observation } = await liveAttempt({ page: null, during: (observer) => observer.onScriptResponse(scriptResponse()) });
  assert.equal(observation.page_script_involved, null);
  const rows = await rowsOf(observation);
  assert.deepEqual(resultOf(rows.get(ORDER)), ["unexercised", "extractor_failed"]);
  for (const row of rows.values()) if (row.check === "tracking.tag") assert.notEqual(row.result, "pass");
});

test("not run: a document read that has not completed when the create request freezes the observer is not a completed read", async () => {
  const { observation } = await liveAttempt({ page: null, during: (observer) => { observer.readDocument(pageHanging(), { awaited: false }); } });
  assert.notEqual(observation.tag_read, "read");
  assert.equal(observation.page_script_involved, null);
  assert.deepEqual(resultOf((await rowsOf(observation)).get(ORDER)), ["unexercised", "extractor_failed"]);
});

// ---------------------------------------------------------------------------
// A declared name that is also a rendered tag: the hash-less exemption
// belongs to the declared name's own entry only. A rendered tag whose hash is
// missing reads non-pass, and its row never disappears.

const SAME_NAME_SPEC = Object.freeze({ analytics: { params: { tracking: { preserve: ["syn_tag", "syn_name"] } } } });
const dropTagHashes = (observation) => {
  for (const entry of observation.names) if (Object.hasOwn(entry, "literal_sha256")) delete entry.literal_sha256;
};

test("declared and rendered: the complete observation keeps both kinds of entry and the tag row passes (control)", async () => {
  const { observation } = await liveAttempt({ spec: SAME_NAME_SPEC });
  assert.deepEqual(observation.extractor_failed, []);
  assert.deepEqual(observation.names.map((entry) => [entry.tag_or_name, entry.rendered, Object.hasOwn(entry, "literal_sha256")]), [
    ["syn_tag", false, false],
    ["syn_name", false, false],
    ["syn_tag", true, true],
  ]);
  const rows = await rowsOf(observation);
  assert.deepEqual(resultOf(rows.get(TAG)), ["pass", null]);
  assert.equal(rows.has("tracking.tag:checkout:tag:syn_name"), false, "a declared name that was never rendered has no tag row");
  assert.deepEqual(rows.get(ORDER).members.find((entry) => entry.key === "syn_name"), { key: "syn_name", result: "excluded", reason_code: "no_credited_field" });
});

test("declared and rendered: a rendered tag whose literal_sha256 is missing reads non-pass and keeps its row, on the capture and stored paths", async () => {
  const { trackingQcRows } = await tracking();
  const captured = (await liveAttempt({ spec: SAME_NAME_SPEC, hooks: { rawObservation: dropTagHashes } })).observation;
  const storedObservation = structuredClone((await liveAttempt({ spec: SAME_NAME_SPEC })).observation);
  dropTagHashes(storedObservation);
  for (const [path, observation] of [["capture", captured], ["stored", storedObservation]]) {
    const rows = trackingQcRows(observation, { measuredAt });
    const tag = rows.find((row) => row.id === TAG);
    assert.ok(tag, `${path}: the rendered tag's row is still produced`);
    assert.deepEqual(resultOf(tag), ["unexercised", "extractor_failed"], `${path}: ${TAG}`);
    const [read] = await readRows([tag]);
    assert.deepEqual(resultOf(read), ["unexercised", "extractor_failed"], `${path}: ${TAG} through the shared reader`);
    const { row } = await storedRow({ ...observation, check: "tracking.tag", tag: "syn_tag" });
    assert.deepEqual(resultOf(row), ["unexercised", "extractor_failed"], `${path}: re-derived for the named tag`);
  }
  // The pass the complete observation produced, read over the changed one.
  const passRow = (await rowsOf((await liveAttempt({ spec: SAME_NAME_SPEC })).observation)).get(TAG);
  const [forged] = await readRows([{ ...passRow, observation: { ...storedObservation, check: "tracking.tag", tag: "syn_tag" } }]);
  assert.notEqual(forged.result, "pass", "a stored pass over the hash-less observation is refused");
});

// ---------------------------------------------------------------------------
// Markers: every status or completeness marker of a stored observation is
// validated on re-derive. Only the complete value can contribute to a pass;
// failed, unknown, missing or ill-typed values read unexercised with the
// contract's reason, through the producer and the 1.0 reader alike.

const PRODUCER_MARKERS = Object.freeze({ tag_read: "read", request_read: "parsed", extractor_failed: [], sdk_test_attribution: false, recovered: false });
// The producer also marks each name entry as a rendered tag's or a declared
// name's.
const producerStored = (patch = {}) => stored({ ...PRODUCER_MARKERS, names: stored().names.map((entry) => ({ ...entry, rendered: true })), ...patch });
const without = (name) => {
  const observation = producerStored();
  delete observation[name];
  return observation;
};
const withHop = (seq, patch) => producerStored({ hops: producerStored().hops.map((entry) => (entry.seq === seq ? { ...entry, ...patch } : entry)) });
const withTagEntry = (patch) => producerStored({ names: [{ ...producerStored().names[0], ...patch }] });
const URL_ROW = "tracking.url:checkout:url";
const markerCases = [
  ["tag_read failed", producerStored({ tag_read: "failed" }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["tag_read unknown", producerStored({ tag_read: "unknown" }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["tag_read ill-typed", producerStored({ tag_read: true }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["tag_read missing", without("tag_read"), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["tag_read not_run", producerStored({ tag_read: "not_run" }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["page_script_involved not run (null)", producerStored({ page_script_involved: null }), { [ORDER]: ["unexercised", "extractor_failed"], [TAG]: ["unexercised", "extractor_failed"] }],
  ["sdk_test_attribution not read (null)", producerStored({ sdk_test_attribution: null }), { [ORDER]: ["unexercised", "sdk_test_attribution"] }],
  ["name rendered missing", producerStored({ names: stored().names }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["a rendered tag entry marked as a declared name", withTagEntry({ rendered: false }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["request_read unknown", producerStored({ request_read: "unknown" }), { [ORDER]: ["unexercised", "request_body_unreadable"], [TAG]: ["unexercised", "request_body_unreadable"] }],
  ["request_read ill-typed", producerStored({ request_read: 1 }), { [ORDER]: ["unexercised", "request_body_unreadable"], [TAG]: ["unexercised", "request_body_unreadable"] }],
  ["request_read missing", without("request_read"), { [ORDER]: ["unexercised", "request_body_unreadable"], [TAG]: ["unexercised", "request_body_unreadable"] }],
  ["extractor_failed unknown", producerStored({ extractor_failed: ["syn_unknown"] }), { [URL_ROW]: ["unexercised", "extractor_failed"], [ORDER]: ["unexercised", "extractor_failed"], [TAG]: ["unexercised", "extractor_failed"] }],
  ["extractor_failed ill-typed", producerStored({ extractor_failed: "none" }), { [URL_ROW]: ["unexercised", "extractor_failed"], [ORDER]: ["unexercised", "extractor_failed"], [TAG]: ["unexercised", "extractor_failed"] }],
  ["extractor_failed missing", without("extractor_failed"), { [URL_ROW]: ["unexercised", "extractor_failed"], [ORDER]: ["unexercised", "extractor_failed"], [TAG]: ["unexercised", "extractor_failed"] }],
  ["sdk_test_attribution ill-typed", producerStored({ sdk_test_attribution: "false" }), { [ORDER]: ["unexercised", "sdk_test_attribution"] }],
  ["sdk_test_attribution missing", without("sdk_test_attribution"), { [ORDER]: ["unexercised", "sdk_test_attribution"] }],
  ["recovered ill-typed", producerStored({ recovered: "false" }), { [URL_ROW]: ["unexercised", "attempt_recovered_on_new_page"], [ORDER]: ["unexercised", "attempt_recovered_on_new_page"] }],
  ["recovered missing", without("recovered"), { [URL_ROW]: ["unexercised", "attempt_recovered_on_new_page"], [ORDER]: ["unexercised", "attempt_recovered_on_new_page"] }],
  ["create unknown", producerStored({ create: "syn_unknown" }), { [URL_ROW]: ["unexercised", "attempt_incomplete"], [ORDER]: ["unexercised", "no_accepted_order"], [TAG]: ["unexercised", "no_accepted_order"] }],
  ["attribution_object ill-typed", producerStored({ attribution_object: "true" }), { [ORDER]: ["unexercised", "attribution_not_sent"] }],
  ["page_script_involved ill-typed", producerStored({ page_script_involved: "false" }), { [ORDER]: ["unexercised", "extractor_failed"], [TAG]: ["unexercised", "extractor_failed"] }],
  ["observer_attached ill-typed", withHop(2, { observer_attached: "true" }), { [URL_ROW]: ["unexercised", "extractor_failed"] }],
  ["measured_seed_seq ill-typed", producerStored({ measured_seed_seq: "1" }), { [URL_ROW]: ["unexercised", "seed_hop_not_observed"] }],
  ["post_order_seq ill-typed", producerStored({ post_order_seq: "3" }), { [URL_ROW]: ["unexercised", "attempt_incomplete"] }],
  ["literal_sha256 null", withTagEntry({ literal_sha256: null }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["literal_sha256 ill-typed", withTagEntry({ literal_sha256: 42 }), { [TAG]: ["unexercised", "extractor_failed"] }],
  ["tag outcome unknown", withTagEntry({ outcome: "syn_unknown" }), { [TAG]: ["unexercised", "extractor_failed"] }],
];
const rowCheck = (id) => (id === URL_ROW ? { check: "tracking.url" } : id === ORDER ? { check: "tracking.order" } : { check: "tracking.tag", tag: "syn_tag" });

test("markers: the complete producer observation reads pass on every row (control)", async () => {
  for (const id of [URL_ROW, ORDER, TAG]) {
    const { row } = await storedRow({ ...producerStored(), ...rowCheck(id) });
    assert.deepEqual(resultOf(row), ["pass", null], id);
  }
});

for (const [label, observation, expected] of markerCases) {
  test(`markers: ${label} never reads pass; each row it feeds reads its contract reason, through the 1.0 reader`, async () => {
    for (const [id, want] of Object.entries(expected)) {
      const { row } = await storedRow({ ...observation, ...rowCheck(id) });
      assert.ok(row, `${id} re-derives`);
      assert.deepEqual(resultOf(row), want, `${id} producer row`);
      const [read] = await readRows([row]);
      assert.deepEqual(resultOf(read), want, `${id} re-derived on read`);
      // The pass a stale producer would have stored is refused on read.
      const { row: passRow } = await storedRow({ ...producerStored(), ...rowCheck(id) });
      const [forged] = await readRows([{ ...passRow, observation: { ...observation, ...rowCheck(id) } }]);
      assert.notEqual(forged.result, "pass", `${id} forged pass refused`);
    }
  });
}

// ---------------------------------------------------------------------------
// Observation gaps

test("a measured seed hop recorded with observer_attached false reads observation_gap, through the 1.0 reader", async () => {
  const observation = stored({ hops: [hop(0, "/x/checkout/", "runner"), hop(1, "/x/landing/", "runner", { observer_attached: false }), hop(2, "/x/checkout/", "page"), hop(3, "/x/receipt/", "page")] });
  const { row } = await storedRow(observation);
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "observation_gap"]);
  const [read] = await readRows([row]);
  assert.deepEqual([read.result, read.reason_code], ["unexercised", "observation_gap"]);
});

test("a gap below the measured seed hop (an earlier hop detached, or its seq missing) reads observation_gap", async () => {
  for (const hops of [
    [hop(0, "/x/checkout/", "runner", { observer_attached: false }), hop(1, "/x/landing/", "runner"), hop(2, "/x/checkout/", "page"), hop(3, "/x/receipt/", "page")],
    [hop(1, "/x/landing/", "runner"), hop(2, "/x/checkout/", "page"), hop(3, "/x/receipt/", "page")],
  ]) {
    const { row } = await storedRow(stored({ hops }));
    assert.deepEqual([row.result, row.reason_code], ["unexercised", "observation_gap"]);
  }
});

test("live: a main-frame document QA cannot compare in the middle of the sequence is an observation gap", async () => {
  const { observation } = await liveAttempt({ during: (observer) => observer.onFrameNavigated("chrome-error://chromewebdata/") });
  const rows = await rowsOf(observation);
  const url = rows.get("tracking.url:checkout:url");
  assert.deepEqual([url.result, url.reason_code], ["unexercised", "observation_gap"]);
});

test("live: a hop listener that could not read its event is an observation gap", async () => {
  const { observation } = await liveAttempt({ during: (observer) => observer.onListenerError("hop") });
  const rows = await rowsOf(observation);
  assert.equal(rows.get("tracking.url:checkout:url").reason_code, "observation_gap");
});

// ---------------------------------------------------------------------------
// Multiple observations of one source

test("stored: a request that differs is never overwritten by a later equal one, for the request and for an echo source", async () => {
  for (const source of ["request", "readback", "create_response"]) {
    const fields = [...FIELDS.map((field) => ({ field, source: "request", outcome: "equal" }))];
    fields.unshift({ field: "utm_source", source, outcome: "differs" });
    if (source !== "request") fields.push({ field: "utm_source", source, outcome: "equal" });
    const { row } = await storedRow(stored({ check: "tracking.order", fields }));
    assert.deepEqual([row.result, row.reason_code], ["warning", "order_attribution_differs"], `a ${source} that differs`);
    const [read] = await readRows([row]);
    assert.equal(read.result, "warning");
  }
});

test("live: every echo is kept; a differing read-back followed by an equal one reads order_attribution_differs", async () => {
  const { observation } = await liveAttempt({
    afterCreate: async (observer, seeds) => {
      await observer.orderResponseBody("readback", () => ({ attribution: { utm_source: "syn_other" } }));
      await observer.orderResponseBody("readback", () => ({ attribution: { utm_source: seeds.utm_source } }));
    },
  });
  assert.deepEqual(observation.fields.filter((entry) => entry.field === "utm_source").map((entry) => [entry.source, entry.outcome]), [
    ["request", "equal"],
    ["readback", "differs"],
    ["readback", "equal"],
  ]);
  const rows = await rowsOf(observation);
  assert.equal(rows.get("tracking.order:checkout:order").reason_code, "order_attribution_differs");
});

test("live: every create request is kept; an earlier request that differs is not overwritten by a later equal one", async () => {
  const { observation } = await liveAttempt({
    during: (observer) => observer.onCreateRequest(JSON.stringify({ attribution: { utm_source: "syn_other", metadata: { syn_tag: "syn_v" } } })),
  });
  const rows = await rowsOf(observation);
  assert.notEqual(rows.get("tracking.order:checkout:order").result, "pass");
});

test("live: a tag rendered with two literals keeps both; the request equal to only the later one is not a pass", async () => {
  const { observation } = await liveAttempt({
    page: pageAnswering({ tags: [{ name: "syn_tag", value: "syn_w" }], inline: false, pins: [] }),
    during: (observer) => observer.readDocument(pageAnswering(TAG_READ)),
  });
  assert.deepEqual(observation.names.map((entry) => [entry.outcome, entry.literal_sha256]), [["differs", sha256("syn_w")], ["equal", sha256("syn_v")]]);
  const tag = (await rowsOf(observation)).get("tracking.tag:checkout:tag:syn_tag");
  assert.deepEqual([tag.result, tag.reason_code], ["warning", "tag_value_differs"]);
  const [read] = await readRows([tag]);
  assert.equal(read.result, "warning");
});

// ---------------------------------------------------------------------------
// Source-aware re-derivation

test("a tag with only a read-back observation never reads pass; the reader refuses it", async () => {
  const observation = stored({ check: "tracking.tag", tag: "syn_tag", names: [{ tag_or_name: "syn_tag", source: "readback", outcome: "equal", literal_sha256: sha256("syn_v") }] });
  const { derived } = await storedRow(observation);
  assert.equal(derived, null, "no request-metadata equality: not re-derivable");
  // The row a stale producer would have stored is refused on read.
  const forged = (await storedRow(stored({ check: "tracking.tag", tag: "syn_tag" }))).row;
  const read = await readRows([{ ...forged, observation }]);
  assert.notEqual(read[0].result, "pass");
});

test("a tag whose request equals the literal but whose echo differs is a warning, not a pass", async () => {
  const names = [
    { tag_or_name: "syn_tag", source: "request", outcome: "equal", literal_sha256: sha256("syn_v") },
    { tag_or_name: "syn_tag", source: "readback", outcome: "differs", literal_sha256: sha256("syn_v") },
  ];
  const { row } = await storedRow(stored({ check: "tracking.tag", tag: "syn_tag", names }));
  assert.deepEqual([row.result, row.reason_code], ["warning", "tag_value_differs"]);
});

test("an order field with only an echo observation (no request) never reads pass", async () => {
  const fields = FIELDS.map((field) => ({ field, source: field === "utm_source" ? "readback" : "request", outcome: "equal" }));
  const { derived } = await storedRow(stored({ check: "tracking.order", fields }));
  assert.equal(derived, null);
});

test("a declared name carried only by an echo does not count as request metadata", async () => {
  const observation = stored({
    check: "tracking.order",
    preserve: ["syn_name"],
    seeds: { ...SEEDS, syn_name: "cosqa_syn_name_0a1b2c3d" },
    hops: stored().hops.map((entry) => ({ ...entry, params: { ...entry.params, syn_name: "equal" } })),
    names: [{ tag_or_name: "syn_name", source: "readback", outcome: "equal" }],
  });
  const { row } = await storedRow(observation);
  assert.deepEqual(row.members.find((entry) => entry.key === "syn_name"), { key: "syn_name", result: "excluded", reason_code: "no_credited_field" });
});

// ---------------------------------------------------------------------------
// Coverage

test("every row carries coverage {observed, expected, limits} and the SDK loader pin, which re-derives on read", async () => {
  const pinned = { tags: TAG_READ.tags, inline: false, pins: ["campaign-cart@v0.4.38"] };
  const { observation } = await liveAttempt({
    page: pageAnswering(pinned),
    during: (observer) => observer.onScriptResponse(scriptResponse({ url: `https://cdn.example.invalid/npm/campaign-cart@v0.4.38/dist/loader.js?syn_private=${PRIVATE}` })),
  });
  assert.deepEqual(observation.loader_pins, ["campaign-cart@v0.4.38"]);
  const rows = [...(await rowsOf(observation)).values()];
  const { trackingRunScopeRows } = await tracking();
  rows.push(...trackingRunScopeRows({ runId: "qa-tracking-hardening-run", measuredAt }));
  for (const row of rows) {
    assert.equal(Number.isInteger(row.coverage.observed), true, `${row.id} coverage.observed`);
    assert.equal(row.coverage.expected === null || Number.isInteger(row.coverage.expected), true, `${row.id} coverage.expected`);
    assert.equal(Array.isArray(row.coverage.limits), true, `${row.id} coverage.limits`);
    assert.equal(Object.hasOwn(row.coverage, "loader_pins"), true, `${row.id} coverage.loader_pins`);
  }
  const planRows = rows.filter((row) => row.subject.page === PLAN);
  for (const row of planRows) assert.deepEqual(row.coverage.loader_pins, ["campaign-cart@v0.4.38"], `${row.id} records the loader pin`);
  assert.deepEqual(planRows.map((row) => [row.coverage.observed, row.coverage.expected]), [[8, 8], [8, 8], [1, 1]]);
  const read = await readRows(planRows);
  assert.deepEqual(read.map((row) => row.coverage), planRows.map((row) => row.coverage), "coverage re-derives through the 1.0 reader");
  assertNothingPrivatePersisted({ observation, rows }, { markers: { private: PRIVATE } });
});

test("a stored loader pin that is not a package and version is not re-derivable", async () => {
  const { derived } = await storedRow(stored({ loader_pins: [`campaign-cart@v0.4.38?k=${PRIVATE}`] }));
  assert.equal(derived, null);
});

// ---------------------------------------------------------------------------
// Class P: every asynchronous read feeding a 1.1 row is registered with the
// observer before anything awaits it (observeRead), and a read still pending
// when the observation is taken fails the rows it feeds there.

// A page captureCheckoutEvents can listen on, with a CDP session for the tap.
function fakeListenerPage() {
  const page = new EventEmitter();
  const frame = {};
  const { session } = fakeCdpPage();
  page.mainFrame = () => frame;
  page.context = () => ({ newCDPSession: async () => session });
  return page;
}
function fakeResponse({ url, method = "GET", status = 200, text }) {
  const request = { method: () => method, resourceType: () => "fetch", url: () => url, redirectedFrom: () => null, timing: () => ({ startTime: Date.now() }) };
  return { url: () => url, status: () => status, request: () => request, headers: () => ({}), text };
}

test("P: a read-back body still in flight when the observation is taken fails the order row; resolving it afterwards with differing attribution changes neither the observation nor the built rows", async () => {
  const { captureCheckoutEvents } = await browserHooks();
  const { TRACKING_OBSERVATION } = await tracking();
  let land = null;
  const { run, observation } = await liveAttempt({
    afterCreate: (observer) => {
      const page = fakeListenerPage();
      captureCheckoutEvents(page, observer);
      page.emit("response", fakeResponse({ url: `${ORIGIN}/api/v1/orders/synref1/`, text: () => new Promise((resolve) => { land = resolve; }) }));
    },
  });
  assert.ok(observation.extractor_failed.includes("response_equality"), "the in-flight read-back is a failed extractor");
  const taken = structuredClone(observation);
  const attempts = [{ [TRACKING_OBSERVATION]: observation }];
  const before = run.rowsFor({ attempts, measuredAt });
  assert.deepEqual(resultOf(before.find((row) => row.id === ORDER)), ["unexercised", "extractor_failed"]);
  assert.deepEqual(resultOf((await readRows(before)).find((row) => row.id === ORDER)), ["unexercised", "extractor_failed"], "the shared reader re-derives the refusal");
  land(JSON.stringify({ ref_id: "synref1", attribution: { utm_source: "syn_other" } }));
  await settle();
  await settle();
  assert.deepEqual(observation, taken, "the late body never writes the taken observation");
  const afterRows = run.rowsFor({ attempts, measuredAt });
  assert.deepEqual(afterRows, before, "rows built before and after the late body agree");
  assert.deepEqual((await readRows(before)).map(resultOf), (await readRows(afterRows)).map(resultOf));
});

// The structural invariant, checked over source text so the same checks also
// run against the mutated copies below.
//
// qa-tracking-params.mjs: no asynchronous step (await, then/catch/finally, a
// new Promise, a timer, process.nextTick, queueMicrotask, setImmediate, an
// event-listener registration, an async function) exists outside
// observeRead, the bounded wait it uses (within) and finalize, which awaits
// the registered reads themselves.
//
// qa-browser.mjs, the whole file: every use of the observer, by `tracking` or
// by any alias of it (a variable bound from it, a method destructured or read
// off it, a parameter it is passed to), is a synchronous call that
//   - sits in no promise or timer callback, and in no event callback
//     registered on anything but the attempt's page or its CDP session (the
//     listeners whose event payload is itself the 1.1 observation);
//   - follows no await of any enclosing function (and shares no loop with
//     one), unless it is one of the observer's own reads (readDocument,
//     finalize), which the observer starts through observeRead;
//   - passes no awaited value: no await in its arguments, and no name bound
//     from an await or a promise callback in an enclosing function, also
//     inside a function it passes. A function it passes is a read the
//     observer starts itself, through observeRead.
// Of the observer's calls, only readDocument and finalize are awaited.
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const PROMISE_CALLBACKS = new Set(["then", "catch", "finally"]);
const TIMER_CALLS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "nextTick"]);
const EVENT_REGISTRATIONS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const LISTENER_SOURCES = new Set(["page", "session"]);
const SELF_READS = new Set(["readDocument", "finalize"]);

async function parseText(text) {
  const { parse } = await import("acorn");
  return parse(text, { ecmaVersion: "latest", sourceType: "module" });
}
async function readSource(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(file, import.meta.url), "utf8");
}
function walkAst(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) walkAst(item, visit, ancestors);
    else if (child && typeof child.type === "string") walkAst(child, visit, ancestors);
  }
  ancestors.pop();
}
const unchain = (node) => (node?.type === "ChainExpression" ? node.expression : node);
const memberName = (node) => {
  const target = unchain(node);
  return target?.type === "MemberExpression" && !target.computed ? target.property.name : null;
};
const calleeName = (call) => {
  const callee = unchain(call.callee);
  return callee?.type === "Identifier" ? callee.name : memberName(callee);
};
const keyName = (property) => property.key?.name ?? property.key?.value ?? null;
// Visits the nodes of `fn` itself, not those of a function nested in it.
function walkOwn(node, visit) {
  walkAst(node, (child, ancestors) => {
    if (!ancestors.some((ancestor) => FUNCTION_TYPES.has(ancestor.type))) visit(child, ancestors);
  });
}
function directAwaits(fn) {
  const found = [];
  walkOwn(fn.body, (node) => {
    if (node.type === "AwaitExpression") found.push(node);
  });
  return found;
}
function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((property) => bindingNames(property.type === "RestElement" ? property : property.value));
  return [];
}

async function trackingParamsAsyncSites(source) {
  const ast = await parseText(source);
  const allowed = [];
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator" && ["observeRead", "within"].includes(node.id?.name)) allowed.push([node.id.name, node.init]);
    if (node.type === "Property" && node.key?.name === "finalize" && FUNCTION_TYPES.has(node.value?.type)) allowed.push(["finalize", node.value]);
  });
  const inside = (node) => allowed.some(([, scope]) => node.start >= scope.start && node.end <= scope.end);
  const sites = [];
  walkAst(ast, (node) => {
    const callee = node.type === "CallExpression" ? unchain(node.callee) : null;
    const name = callee ? calleeName(node) : null;
    const asyncStep = node.type === "AwaitExpression"
      || (FUNCTION_TYPES.has(node.type) && node.async)
      || (node.type === "NewExpression" && node.callee.name === "Promise")
      || (node.type === "ForOfStatement" && node.await)
      || (callee !== null && (PROMISE_CALLBACKS.has(name) || TIMER_CALLS.has(name) || EVENT_REGISTRATIONS.has(name)
        || (callee.type === "MemberExpression" && callee.object.name === "Promise" && !(name === "resolve" && node.arguments.length === 0))));
    if (asyncStep && !inside(node)) sites.push(`${name ?? node.type} at offset ${node.start}`);
  });
  return { helpers: allowed.map(([name]) => name).sort(), sites };
}

async function observerViolations(source) {
  const ast = await parseText(source);
  const parents = new Map();
  const functions = new Map();
  const identifiers = [];
  const calls = [];
  walkAst(ast, (node, ancestors) => {
    parents.set(node, ancestors.at(-1) ?? null);
    if (node.type === "FunctionDeclaration" && node.id) functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && FUNCTION_TYPES.has(node.init?.type)) functions.set(node.id.name, node.init);
    if (node.type === "Identifier") identifiers.push([node, [...ancestors]]);
    if (node.type === "CallExpression") calls.push(node);
  });
  // Whether an identifier reads a binding (rather than naming one, or naming
  // a property).
  const isReference = (node) => {
    const parent = parents.get(node);
    if (!parent) return true;
    if (parent.type === "MemberExpression") return parent.object === node || parent.computed;
    if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") {
      if (parent.key === node && !parent.computed) return false;
      if (parent.value === node && parents.get(parent)?.type === "ObjectPattern") return false;
      return true;
    }
    if (parent.type === "VariableDeclarator") return parent.init === node;
    if (FUNCTION_TYPES.has(parent.type)) return parent.body === node;
    if (parent.type === "AssignmentPattern") return parent.right === node;
    if (parent.type === "AssignmentExpression") return parent.right === node;
    if (["ArrayPattern", "RestElement", "LabeledStatement", "BreakStatement", "ContinueStatement", "ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier", "CatchClause"].includes(parent.type)) return false;
    return true;
  };
  // Where a value flows: past optional chains, ?: branches and ||/??/&&.
  const flowParent = (node) => {
    let current = node;
    let parent = parents.get(current);
    while (parent && (parent.type === "ChainExpression" || parent.type === "LogicalExpression" || (parent.type === "ConditionalExpression" && parent.test !== current))) {
      current = parent;
      parent = parents.get(current);
    }
    return [current, parent];
  };

  // Aliases: names bound to the observer, and names bound to one of its
  // methods, to a fixed point.
  const aliases = new Set(["tracking"]);
  const methods = new Map();
  const bindObserver = (target) => {
    const pattern = target?.type === "AssignmentPattern" ? target.left : target;
    if (pattern?.type === "Identifier") aliases.add(pattern.name);
    if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        for (const name of bindingNames(property.value)) methods.set(name, keyName(property));
      }
    }
  };
  const paramOf = (call, argument) => {
    const callee = unchain(call.callee);
    return callee?.type === "Identifier" ? functions.get(callee.name)?.params[call.arguments.indexOf(argument)] ?? null : null;
  };
  let size = -1;
  while (aliases.size + methods.size !== size) {
    size = aliases.size + methods.size;
    for (const [node] of identifiers) {
      if (!aliases.has(node.name) || !isReference(node)) continue;
      const [value, parent] = flowParent(node);
      if (parent?.type === "VariableDeclarator" && parent.init === value) bindObserver(parent.id);
      else if (parent?.type === "AssignmentExpression" && parent.right === value) bindObserver(parent.left);
      else if (parent?.type === "CallExpression" && parent.arguments.includes(value)) bindObserver(paramOf(parent, value));
      else if (parent?.type === "MemberExpression" && parent.object === value && !parent.computed) {
        const [read, holder] = flowParent(parent);
        if (holder?.type === "VariableDeclarator" && holder.init === read && holder.id.type === "Identifier") methods.set(holder.id.name, parent.property.name);
        if (holder?.type === "AssignmentExpression" && holder.right === read && holder.left.type === "Identifier") methods.set(holder.left.name, parent.property.name);
      } else if (parent?.type === "Property" && parent.value === value) {
        const object = parents.get(parent);
        const call = parents.get(object);
        if (object?.type === "ObjectExpression" && call?.type === "CallExpression" && call.arguments.includes(object)) {
          const param = paramOf(call, object);
          const pattern = param?.type === "AssignmentPattern" ? param.left : param;
          const match = pattern?.type === "ObjectPattern" ? pattern.properties.find((property) => property.type === "Property" && keyName(property) === keyName(parent)) : null;
          if (match) bindObserver(match.value);
        }
      }
    }
  }

  // The kind of callback a function is, if it is passed (inline or by name)
  // to a promise, timer or event registration.
  const callbackKind = (fn) => {
    const parent = parents.get(fn);
    let passing = [];
    if (parent?.type === "CallExpression" && parent.arguments.includes(fn)) passing = [parent];
    else {
      const name = fn.type === "FunctionDeclaration" ? fn.id?.name : parent?.type === "VariableDeclarator" && parent.init === fn && parent.id.type === "Identifier" ? parent.id.name : null;
      if (name) passing = calls.filter((call) => call.arguments.some((argument) => argument.type === "Identifier" && argument.name === name));
    }
    for (const call of passing) {
      const name = calleeName(call);
      if (PROMISE_CALLBACKS.has(name)) return "a promise";
      if (TIMER_CALLS.has(name)) return "a timer";
      if (EVENT_REGISTRATIONS.has(name)) {
        const receiver = unchain(call.callee).object;
        if (!(receiver?.type === "Identifier" && LISTENER_SOURCES.has(receiver.name))) return `an event (${receiver?.name ?? "?"}.${name})`;
      }
    }
    return null;
  };
  // Names bound from an await or a promise callback in the enclosing
  // functions (outermost first; an inner binding of the same name shadows).
  const awaitsIn = (node) => {
    let found = false;
    walkOwn(node, (child) => {
      if (child.type === "AwaitExpression" || (child.type === "CallExpression" && PROMISE_CALLBACKS.has(calleeName(child)))) found = true;
    });
    return found;
  };
  const taintedNames = (enclosing) => {
    const tainted = new Set();
    for (const fn of [...enclosing].reverse()) {
      for (const name of fn.params.flatMap(bindingNames)) tainted.delete(name);
      walkOwn(fn.body, (node) => {
        if (node.type === "VariableDeclarator") for (const name of bindingNames(node.id)) tainted.delete(name);
      });
      walkOwn(fn.body, (node) => {
        if (node.type === "VariableDeclarator" && node.init && awaitsIn(node.init)) for (const name of bindingNames(node.id)) tainted.add(name);
        if (node.type === "AssignmentExpression" && awaitsIn(node.right)) for (const name of bindingNames(node.left)) tainted.add(name);
      });
    }
    return tainted;
  };
  const carriesAwaitedValue = (argument, tainted) => {
    let carried = false;
    walkAst(argument, (node, ancestors) => {
      if (node.type === "AwaitExpression" && !ancestors.some((ancestor) => FUNCTION_TYPES.has(ancestor.type))) carried = true;
      if (node.type === "Identifier" && tainted.has(node.name) && isReference(node)) carried = true;
    });
    const local = argument.type === "Identifier" ? functions.get(argument.name) : null;
    if (local) {
      walkAst(local.body, (node) => {
        if (node.type === "Identifier" && tainted.has(node.name) && isReference(node)) carried = true;
      });
    }
    return carried;
  };

  const violations = [];
  let uses = 0;
  for (const [node, ancestors] of identifiers) {
    if (!isReference(node)) continue;
    const parent = parents.get(node);
    let method = null;
    let callee = null;
    if (aliases.has(node.name) && parent?.type === "MemberExpression" && parent.object === node) {
      method = parent.computed ? "[computed]" : parent.property.name;
      callee = parent;
    } else if (methods.has(node.name)) {
      method = methods.get(node.name);
      callee = node;
    } else continue;
    uses += 1;
    const at = `${method} (${node.name}) at offset ${node.start}`;
    const holder = parents.get(callee);
    const call = holder?.type === "CallExpression" && holder.callee === callee ? holder : null;
    if (!call) {
      const [read, binding] = flowParent(callee);
      const bound = (binding?.type === "VariableDeclarator" && binding.init === read) || (binding?.type === "AssignmentExpression" && binding.right === read);
      if (!(bound && callee !== node)) violations.push(`${at}: an observer method used without being called`);
      continue;
    }
    const enclosing = ancestors.filter((ancestor) => FUNCTION_TYPES.has(ancestor.type)).reverse();
    for (const fn of enclosing) {
      const kind = callbackKind(fn);
      if (kind) violations.push(`${at}: inside ${kind} callback`);
    }
    for (const fn of enclosing) {
      if (!fn.async) continue;
      const loops = ancestors.filter((ancestor) => LOOP_TYPES.has(ancestor.type) && ancestor.start >= fn.start && ancestor.end <= fn.end);
      const before = directAwaits(fn).some((awaited) => !(awaited.start <= node.start && awaited.end >= node.end)
        && (awaited.start < node.start || loops.some((loop) => awaited.start >= loop.start && awaited.end <= loop.end)));
      if (before && !SELF_READS.has(method)) violations.push(`${at}: after an await`);
    }
    if (flowParent(call)[1]?.type === "AwaitExpression" && !SELF_READS.has(method)) violations.push(`${at}: awaited`);
    const tainted = taintedNames(enclosing);
    for (const argument of call.arguments) if (carriesAwaitedValue(argument, tainted)) violations.push(`${at}: passed an awaited value`);
  }
  return { violations, uses, aliases: [...aliases].sort(), methods: [...methods.keys()].sort() };
}

test("P structural: in qa-tracking-params.mjs every asynchronous step is inside observeRead, its bounded wait or finalize", async () => {
  const { helpers, sites } = await trackingParamsAsyncSites(await readSource("./qa-tracking-params.mjs"));
  assert.deepEqual(helpers, ["finalize", "observeRead", "within"], "the helper, its wait and finalize exist once each");
  assert.deepEqual(sites, [], "no asynchronous step outside the helper");
});

test("P structural: in the whole of qa-browser.mjs every use of the observer, or of an alias of it, is synchronous and passes no awaited value", async () => {
  const { violations, uses, aliases } = await observerViolations(await readSource("./qa-browser.mjs"));
  assert.ok(uses >= 14, `the observer's uses are visited (${uses})`);
  assert.deepEqual(aliases, ["tracking"]);
  assert.deepEqual(violations, []);
});

// Each mutation a verifier showed the earlier checks missed (and the control
// they caught), applied to a copy of the source in memory: the checks above
// must reject every one.
const BROWSER_MUTATIONS = [
  ["Opus M1: a new function awaits response.json() and then hands the body to the observer", null,
    "\nasync function synLateReadback(response, tracking) {\n  const body = await response.json();\n  tracking.orderResponseBody(\"readback\", () => body);\n}\n"],
  ["Opus M2: an alias of the observer in captureCheckoutEvents, used after the response listener's await", [
    ["function captureCheckoutEvents(page, tracking = null) {\n", "after", "  const observer = tracking;\n"],
    ["    if (request) entry[REQUEST_IDENTITY] = request;\n", "before", "    if (orderSource) observer.orderResponseBody(orderSource, () => entry.body);\n"],
  ]],
  ["Opus M3: page.evaluate().then(v => tracking.onCreateRequest(v)) in another function", null,
    "\nfunction synEvaluateThen(page, tracking) {\n  page.evaluate(() => document.title).then((value) => tracking.onCreateRequest(value));\n}\n"],
  ["Opus M6 (control): a bare await before the registration inside captureCheckoutEvents", [
    ["    const requestStartedAt = responseRequestStartedAt(response);\n", "after", "    await Promise.resolve();\n"],
  ]],
  ["Codex 1: in executeTestOrderPath, a bare await page.evaluate(...) followed by an observer call", [
    ["      await tracking?.readDocument(page);\n      if (cartBeforeSubmit.empty) {\n", "before", "      const synTitle = await page.evaluate(() => document.title);\n      tracking?.onCreateRequest(synTitle);\n"],
  ]],
  ["Codex 2: in executeTestOrderPath, a response callback that awaits response.json() before calling the observer", [
    ["      await tracking?.readDocument(page);\n      if (cartBeforeSubmit.empty) {\n", "before", "      page.on(\"response\", async (response) => {\n        const synBody = await response.json();\n        tracking?.orderResponseBody(\"readback\", () => synBody);\n      });\n"],
  ]],
  ["alias: a method destructured from the observer, called with an awaited value", [
    ["      await tracking?.readDocument(page);\n      if (cartBeforeSubmit.empty) {\n", "before", "      const { onCreateResponseStatus } = tracking;\n      onCreateResponseStatus(await page.evaluate(() => 201));\n"],
  ]],
  ["alias: the observer passed as a parameter and used in a timer callback", null,
    "\nfunction synTimer(observer) {\n  setTimeout(() => observer.onFrameNavigated(\"http://127.0.0.1/x/\"), 0);\n}\nfunction synCaller(tracking) {\n  synTimer(tracking);\n}\n"],
  ["alias: the observer inside an object argument, used after an await", null,
    "\nasync function synObjectParam({ watcher }) {\n  await Promise.resolve();\n  watcher.onCreateResponseStatus(201);\n}\nfunction synObjectCaller(tracking) {\n  synObjectParam({ watcher: tracking });\n}\n"],
  ["an event callback on an emitter other than the page or its CDP session", null,
    "\nfunction synEmitter(emitter, tracking) {\n  emitter.on(\"body\", (body) => tracking.orderResponseBody(\"readback\", () => body));\n}\n"],
  ["an observer method handed over as a promise callback", null,
    "\nfunction synMethodCallback(page, tracking) {\n  page.evaluate(() => 1).then(tracking.onCreateRequest);\n}\n"],
  ["a name bound from an await passed inside a thunk, before any await of its own function", null,
    "\nfunction synThunk(page, tracking) {\n  page.on(\"load\", async () => {\n    tracking.orderResponseBody(\"readback\", () => late);\n    const late = await page.evaluate(() => 1);\n  });\n}\n"],
];
const TRACKING_PARAMS_MUTATIONS = [
  ["Opus M4: an emitter.on listener calling recordEcho outside observeRead", "  hooks?.emitter?.on(\"body\", (body) => recordEcho(\"readback\", body));\n"],
  ["Opus M5: process.nextTick outside observeRead", "  process.nextTick(() => fail(\"hop_equality\"));\n"],
  ["a once listener outside observeRead", "  hooks?.emitter?.once(\"body\", (body) => recordEcho(\"readback\", body));\n"],
  ["addEventListener outside observeRead", "  globalThis.addEventListener?.(\"message\", (event) => recordEcho(\"readback\", event.data));\n"],
  ["queueMicrotask outside observeRead", "  queueMicrotask(() => fail(\"hop_equality\"));\n"],
  ["setImmediate outside observeRead", "  setImmediate(() => fail(\"hop_equality\"));\n"],
];
const TRACKING_PARAMS_ANCHOR = "  // The response listener's in-memory body (null when its read failed). An\n";
function applyMutation(source, edits, appended) {
  if (appended) return source + appended;
  let mutated = source;
  for (const [anchor, where, text] of edits) {
    assert.equal(mutated.split(anchor).length, 2, `the mutation's anchor occurs once: ${JSON.stringify(anchor)}`);
    mutated = mutated.replace(anchor, where === "before" ? `${text}${anchor}` : `${anchor}${text}`);
  }
  return mutated;
}

for (const [label, edits, appended] of BROWSER_MUTATIONS) {
  test(`P structural, mutation caught: ${label}`, async () => {
    const mutated = applyMutation(await readSource("./qa-browser.mjs"), edits, appended);
    const { violations } = await observerViolations(mutated);
    assert.ok(violations.length > 0, "the mutated copy is rejected");
  });
}
for (const [label, text] of TRACKING_PARAMS_MUTATIONS) {
  test(`P structural, mutation caught: ${label}`, async () => {
    const mutated = applyMutation(await readSource("./qa-tracking-params.mjs"), [[TRACKING_PARAMS_ANCHOR, "before", text]]);
    const { sites } = await trackingParamsAsyncSites(mutated);
    assert.ok(sites.length > 0, "the mutated copy is rejected");
  });
}

// ---------------------------------------------------------------------------
// Class M: the one closed marker schema. Every marker, deleted, null,
// "unknown", ill-typed or at its failure value, never lets a row it feeds read
// pass, on the capture path (finalize) and on the re-derive path (the
// producer's rows and the 1.0 reader), and reads the schema's reason.

const OBSERVATION_DATA = Object.freeze({
  observation: ["plan", "run_id", "attempt_id", "seeds", "preserve", "hops", "fields", "names", "loader_pins"],
  hop: ["path", "params"],
  field: ["field"],
  name: ["tag_or_name"],
});
// Every marker field present in an observation (the data fields aside).
function markerFieldsOf(observation) {
  const ids = new Set();
  const add = (prefix, entry, data) => { for (const key of Object.keys(entry)) if (!data.includes(key)) ids.add(`${prefix}${key}`); };
  add("", observation, OBSERVATION_DATA.observation);
  for (const entry of observation.hops) {
    add("hop.", entry, OBSERVATION_DATA.hop);
    if (Object.keys(entry.params).length) ids.add("hop.params.*");
  }
  for (const entry of observation.fields) add("field.", entry, OBSERVATION_DATA.field);
  for (const entry of observation.names) add("name.", entry, OBSERVATION_DATA.name);
  return [...ids].sort();
}

test("M schema: its keys are exactly the marker fields of a real complete observation, and no failure value is complete", async () => {
  const { OBSERVATION_MARKERS } = await tracking();
  assert.ok(OBSERVATION_MARKERS && typeof OBSERVATION_MARKERS === "object", "the schema is exported");
  const { observation } = await liveAttempt({ hooks: null });
  assert.deepEqual((await rowsOf(observation)).size, 3, "setup: the observation is complete (url, order and tag rows)");
  assert.deepEqual(markerFieldsOf(observation), Object.keys(OBSERVATION_MARKERS).sort(), "every marker field has one schema entry and every entry is written");
  for (const [id, marker] of Object.entries(OBSERVATION_MARKERS)) {
    assert.ok(marker.failure || marker.extractor, `${id} records an invalid value somehow`);
    if (marker.failure) assert.equal(marker.complete(marker.failure()), false, `${id} failure value is not complete`);
    assert.ok(marker.feeds.length && marker.feeds.every((check) => ["tracking.url", "tracking.order", "tracking.tag"].includes(check)), `${id} feeds rows`);
  }
});

const ILL_TYPED = (value) => (typeof value === "string" ? 7 : typeof value === "boolean" ? String(value) : typeof value === "number" ? String(value) : Array.isArray(value) ? {} : []);
const DELETE = Symbol("deleted");
// The holders of a marker in an observation, and the key on each.
function markerLocations(observation, id, marker) {
  if (marker.at === "observation") return [[observation, marker.key]];
  if (marker.at === "hop") return observation.hops.map((entry) => [entry, marker.key]);
  if (marker.at === "hop.params") return observation.hops.map((entry) => [entry.params, "utm_source"]);
  if (marker.at === "field") return observation.fields.map((entry) => [entry, marker.key]);
  return observation.names.map((entry) => [entry, marker.key]);
}
function mutationsOf(observation, id, marker) {
  const [[holder, key]] = markerLocations(observation, id, marker);
  const cases = [["deleted", DELETE], ["null", null], ["\"unknown\"", "unknown"], ["ill-typed", ILL_TYPED(holder[key])]];
  if (marker.failure) cases.push(["failure value", marker.failure()]);
  return cases.filter(([, value]) => !(value === null && marker.valid(null, { seqs: new Set(), declared: new Set() }, holder, true) && marker.complete(null)));
}
function mutate(observation, id, marker, value) {
  for (const [holder, key] of markerLocations(observation, id, marker)) {
    if (value === DELETE) delete holder[key];
    else holder[key] = structuredClone(value);
  }
}
const reasonOf = (marker, check) => (typeof marker.reason === "function" ? marker.reason(marker.failure ? marker.failure() : null) : typeof marker.reason === "string" ? marker.reason : marker.reason[check]);
const rowsForCheck = (rows, check) => rows.filter((row) => row.check === check);

async function assertNoPass(rows, marker, label) {
  for (const check of marker.feeds) {
    const fed = rowsForCheck(rows, check);
    assert.ok(fed.length > 0, `${label}: a ${check} row is produced`);
    for (const row of fed) assert.deepEqual(resultOf(row), ["unexercised", reasonOf(marker, check)], `${label}: ${row.id}`);
    for (const row of await readRows(fed)) assert.deepEqual(resultOf(row), ["unexercised", reasonOf(marker, check)], `${label}: ${row.id} through the 1.0 reader`);
  }
}

const { OBSERVATION_MARKERS: SCHEMA = {} } = await tracking().catch(() => ({}));
const { observation: COMPLETE } = await liveAttempt();
const PASS_ROWS = [...(await rowsOf(COMPLETE)).values()];

test("M control: the complete observation used below reads pass on every row", () => {
  assert.deepEqual(PASS_ROWS.map(resultOf), [["pass", null], ["pass", null], ["pass", null]]);
});

// The verifier's enumeration; the tests below run for it and for every schema
// entry, so a marker missing from the schema fails its own test.
const ENUMERATED = ["tag_read", "request_read", "extractor_failed", "sdk_test_attribution", "recovered", "create", "attribution_object", "page_script_involved", "hop.observer_attached", "hop.seq", "measured_seed_seq", "post_order_seq", "hop.initiator", "hop.kind", "hop.params.*", "field.source", "field.outcome", "name.source", "name.outcome", "name.literal_sha256"];
const MARKER_IDS = [...new Set([...ENUMERATED, ...Object.keys(SCHEMA)])];

for (const id of MARKER_IDS) {
  test(`M re-derive: ${id} deleted, null, "unknown", ill-typed or failed never lets a row it feeds pass`, async () => {
    const { trackingQcRows } = await tracking();
    const marker = SCHEMA[id];
    assert.ok(marker, `${id} has a schema entry`);
    for (const [label, value] of mutationsOf(COMPLETE, id, marker)) {
      const observation = structuredClone(COMPLETE);
      mutate(observation, id, marker, value);
      await assertNoPass(trackingQcRows(observation, { measuredAt }), marker, `${id} ${label}`);
      // The pass the complete observation produced, read over the changed one.
      for (const row of PASS_ROWS.filter((candidate) => marker.feeds.includes(candidate.check))) {
        const [forged] = await readRows([{ ...row, observation: { ...observation, check: row.check, ...(row.check === "tracking.tag" ? { tag: "syn_tag" } : {}) } }]);
        assert.notEqual(forged.result, "pass", `${id} ${label}: a stored pass over the changed observation is refused`);
      }
    }
  });

  test(`M capture: ${id} deleted, null, "unknown", ill-typed or failed as captured never lets a row it feeds pass`, async () => {
    const { trackingQcRows } = await tracking();
    const marker = SCHEMA[id];
    assert.ok(marker, `${id} has a schema entry`);
    for (const [label, value] of mutationsOf(COMPLETE, id, marker)) {
      const { observation } = await liveAttempt({ hooks: { rawObservation: (raw) => mutate(raw, id, marker, value) } });
      if (marker.at === "observation") {
        const stored = marker.valid(observation[marker.key], { seqs: new Set(), declared: new Set() }, observation, true);
        assert.ok(stored || observation.extractor_failed.includes(marker.extractor), `${id} ${label}: capture stores a value inside the schema, or records its extractor failed`);
      }
      await assertNoPass(trackingQcRows(observation, { measuredAt }), marker, `${id} ${label} (capture)`);
    }
  });
}

// Failure values inside a marker's vocabulary, judged by the row rules.
const explicitFailures = [
  ["hop.observer_attached", false, { "tracking.url": "observation_gap" }],
  ["create", "rejected", { "tracking.url": "attempt_incomplete", "tracking.order": "no_accepted_order", "tracking.tag": "no_accepted_order" }],
  ["create", "failed", { "tracking.url": "attempt_incomplete", "tracking.order": "no_accepted_order", "tracking.tag": "no_accepted_order" }],
  ["request_read", "none", { "tracking.order": "no_accepted_order", "tracking.tag": "no_accepted_order" }],
];
for (const [id, value, expected] of explicitFailures) {
  test(`M: ${id} ${JSON.stringify(value)} never lets a row it feeds pass, re-derived or captured`, async () => {
    const { trackingQcRows } = await tracking();
    const marker = SCHEMA[id];
    assert.ok(marker, `${id} has a schema entry`);
    const rederived = structuredClone(COMPLETE);
    mutate(rederived, id, marker, value);
    const { observation: captured } = await liveAttempt({ hooks: { rawObservation: (raw) => mutate(raw, id, marker, value) } });
    for (const [path, observation] of [["re-derived", rederived], ["captured", captured]]) {
      const rows = trackingQcRows(observation, { measuredAt });
      for (const [check, reason] of Object.entries(expected)) {
        const fed = rowsForCheck(rows, check);
        assert.ok(fed.length > 0, `${path}: a ${check} row is produced`);
        for (const row of fed) assert.deepEqual(resultOf(row), ["unexercised", reason], `${path}: ${row.id}`);
        for (const row of await readRows(fed)) assert.deepEqual(resultOf(row), ["unexercised", reason], `${path}: ${row.id} through the 1.0 reader`);
      }
    }
  });
}

test("M: an observation with all five producer markers removed reads no pass on any row, re-derived or captured", async () => {
  const { trackingQcRows } = await tracking();
  const producer = ["tag_read", "request_read", "extractor_failed", "sdk_test_attribution", "recovered"];
  const stripped = structuredClone(COMPLETE);
  for (const name of producer) delete stripped[name];
  const rows = trackingQcRows(stripped, { measuredAt });
  assert.deepEqual(rows.map((row) => [row.check, ...resultOf(row)]), [["tracking.url", "unexercised", "extractor_failed"], ["tracking.order", "unexercised", "extractor_failed"], ["tracking.tag", "unexercised", "extractor_failed"]]);
  assert.deepEqual((await readRows(rows)).map(resultOf), rows.map(resultOf));
  for (const row of PASS_ROWS) {
    const [forged] = await readRows([{ ...row, observation: { ...stripped, check: row.check, ...(row.check === "tracking.tag" ? { tag: "syn_tag" } : {}) } }]);
    assert.notEqual(forged.result, "pass", `${row.id}: a stored pass over the stripped observation is refused`);
  }
  const { observation } = await liveAttempt({ hooks: { rawObservation: (raw) => { for (const name of producer) delete raw[name]; } } });
  assert.deepEqual(trackingQcRows(observation, { measuredAt }).map((row) => resultOf(row)[0]), ["unexercised", "unexercised", "unexercised"]);
});

// Raw capture input: the DOM scan's own answer.
const rawDocumentCases = [
  ["inline \"unknown\"", { inline: "unknown" }, ["page_script_scan"]],
  ["inline null", { inline: null }, ["page_script_scan"]],
  ["inline undefined", { inline: undefined }, ["page_script_scan"]],
  ["inline missing", {}, ["page_script_scan"]],
  ["inline ill-typed", { inline: "true" }, ["page_script_scan"]],
  ["tags missing", { tags: undefined, inline: false }, ["tag_dom_read"]],
  ["tags ill-typed", { tags: "syn_tag", inline: false }, ["tag_dom_read"]],
  ["a tag entry ill-typed", { tags: [{ name: "syn_tag", value: 1 }], inline: false }, ["tag_dom_read"]],
];
for (const [label, patch, failed] of rawDocumentCases) {
  test(`M capture: a DOM read answering ${label} records the scan failed, never a complete value; no order or tag row reads pass`, async () => {
    const answer = { tags: TAG_READ.tags, pins: [], ...patch };
    if (!Object.hasOwn(patch, "inline") && !Object.hasOwn(patch, "tags")) delete answer.inline;
    const { observation } = await liveAttempt({ page: pageAnswering(answer) });
    for (const name of failed) assert.ok(observation.extractor_failed.includes(name), `${name} is recorded failed`);
    const rows = [...(await rowsOf(observation)).values()];
    const fed = rows.filter((row) => row.check === "tracking.tag" || (failed.includes("page_script_scan") && row.check === "tracking.order"));
    assert.ok(fed.some((row) => row.check === "tracking.tag"), "a tag row is produced");
    for (const row of fed) assert.deepEqual(resultOf(row), ["unexercised", "extractor_failed"], row.id);
    for (const row of await readRows(fed)) assert.deepEqual(resultOf(row), ["unexercised", "extractor_failed"], `${row.id} through the 1.0 reader`);
  });
}

// ---------------------------------------------------------------------------
// A navigation request that never committed

// A fake page the actual captureCheckoutEvents listeners attach to: one main
// frame, a document read answering `read`, and a CDP session that answers
// every command with {}.
function listenerPage({ read = { tags: [], inline: false, pins: [] }, url = `${ORIGIN}/x/landing/` } = {}) {
  const page = new EventEmitter();
  let current = url;
  const main = { url: () => current };
  page.mainFrame = () => main;
  page.evaluate = async () => read;
  const session = new EventEmitter();
  session.send = async () => ({});
  page.context = () => ({ newCDPSession: async () => session });
  const request = (target, { method = "GET", body = null, navigation = false } = {}) => ({
    url: () => target,
    method: () => method,
    postData: () => body,
    isNavigationRequest: () => navigation,
    frame: () => main,
    resourceType: () => (navigation ? "document" : "fetch"),
    redirectedFrom: () => null,
    timing: () => ({ startTime: Date.now() }),
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  });
  const documentHop = (target) => {
    page.emit("request", request(target, { navigation: true }));
    current = target;
    page.emit("framenavigated", main);
  };
  const historyHop = (target) => {
    current = target;
    page.emit("framenavigated", main);
  };
  return { page, request, documentHop, historyHop, current: () => current };
}

test("live listeners: a cancelled main-frame navigation request, a history hop, the accepted create, then a history hop to the cancelled URL is not the post-order navigation (attempt_incomplete, through the 1.0 reader)", async () => {
  const { captureCheckoutEvents } = await browserHooks();
  const { createTrackingRun } = await tracking();
  const run = createTrackingRun({ runId: "qa-tracking-hardening-cancelled", random: () => Buffer.from([1, 2, 3, 4]) });
  const observer = run.observe(PLAN);
  const fake = listenerPage();
  captureCheckoutEvents(fake.page, observer);
  const entry = observer.runnerUrl(`${ORIGIN}/x/landing/`, addParam);
  fake.documentHop(entry);
  await observer.readDocument(fake.page);
  const query = new URL(entry).search;
  fake.documentHop(`${ORIGIN}/x/checkout/${query}`);
  const pending = `${ORIGIN}/x/pending-document/${query}`;
  const cancelled = fake.request(pending, { navigation: true });
  fake.page.emit("request", cancelled);
  fake.page.emit("requestfailed", cancelled);
  fake.historyHop(`${ORIGIN}/x/intervening-history/${query}`);
  const attribution = Object.fromEntries(FIELDS.map((field) => [field, run.seeds[FIELD_PARAM[field] || field]]));
  const create = fake.request(`${ORIGIN}/api/v1/orders/`, { method: "POST", body: JSON.stringify({ attribution }) });
  fake.page.emit("request", create);
  fake.page.emit("response", { url: () => create.url(), status: () => 201, request: () => create, text: async () => JSON.stringify({ ref_id: "synref1" }) });
  await settle();
  fake.historyHop(pending);
  const observation = await observer.finalize({ createActivity: ACCEPTED });
  assert.deepEqual(observation.hops.slice(-2).map((entry) => [entry.path, entry.kind]), [[`${ORIGIN}/x/intervening-history/`, "history"], [`${ORIGIN}/x/pending-document/`, "history"]]);
  assert.equal(observation.post_order_seq, null);
  const url = (await rowsOf(observation)).get("tracking.url:checkout:url");
  assert.deepEqual(resultOf(url), ["unexercised", "attempt_incomplete"]);
  assert.equal(url.coverage.last_observed, `${ORIGIN}/x/pending-document/`);
  const [read] = await readRows([url]);
  assert.deepEqual(resultOf(read), ["unexercised", "attempt_incomplete"], "through the 1.0 reader");
});

test("live: a commit signal for another URL never makes a hop a document hop, nor a later hop to its URL; a hop with its own document commit is one", async () => {
  const { observation } = await liveAttempt({
    during: (observer, seeds) => {
      const query = `?${new URLSearchParams(seeds)}`;
      observer.onFrameNavigated(`${ORIGIN}/x/between/${query}`, { url: `${ORIGIN}/x/stale/${query}`, newDocument: true });
      observer.onFrameNavigated(`${ORIGIN}/x/stale/${query}`);
      observer.onFrameNavigated(`${ORIGIN}/x/fresh/${query}`, { url: `${ORIGIN}/x/fresh/${query}`, newDocument: true });
    },
  });
  assert.deepEqual(observation.hops.slice(3, 6).map((entry) => [entry.path, entry.kind]), [
    [`${ORIGIN}/x/between/`, "history"],
    [`${ORIGIN}/x/stale/`, "history"],
    [`${ORIGIN}/x/fresh/`, "document"],
  ]);
});

// ---------------------------------------------------------------------------
// Persisted text: no query value in any form

// Every way free text can quote a query: a relative URL whose query opens
// with a bare flag, with "&" or with name=value, a bare "?flag&..." run, a
// value-only query and a query after a fragment.
const QUERY_FORMS = Object.freeze([
  `load /x/?flag&syn_private=${PRIVATE}`,
  `request ?flag&syn_private=${PRIVATE}`,
  `load /x/?&syn_private=${PRIVATE}`,
  `load /x/?syn_private=${PRIVATE}`,
  `load /x/?${PRIVATE}`,
  `load "/x/?a&syn_private=${PRIVATE}"`,
  `load /x/#step?syn_private=${PRIVATE}`,
]);

test("persisted text: the reported error \"/x/?flag&syn_private=...\" from console and page errors leaves no query value in events, the runner assertion, the test order or the full verdict", async () => {
  const { captureCheckoutEvents, sanitizedEvents, persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  const fake = listenerPage();
  const events = captureCheckoutEvents(fake.page, null);
  const error = `load /x/?flag&syn_private=${PRIVATE}`;
  fake.page.emit("console", { type: () => "error", text: () => error });
  fake.page.emit("pageerror", new Error(error));
  const persistedEvents = sanitizedEvents(events);
  const assertion = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", actual: error, evidence: { events: persistedEvents } });
  const order = persistedTestOrder({ checkout_url: `${ORIGIN}/x/checkout/`, final_url: `${ORIGIN}/x/checkout/`, verification: { verified: false, error }, evidence: { events: persistedEvents } });
  const verdict = fullVerdict({ assertions: [assertion], measuredAt });
  verdict.test_orders = [order];
  assert.equal(JSON.stringify(verdict).includes(PRIVATE), false, "no private value anywhere");
  assertNothingPrivatePersisted(verdict, { markers: { private: PRIVATE } });
  assert.equal(persistedEvents.console[0].text, "load /x/<query-redacted>");
  assert.deepEqual(persistedEvents.pageErrors, ["load /x/<query-redacted>"]);
  assert.equal(assertion.actual, "load /x/<query-redacted>");
  assert.equal(order.verification.error, "load /x/<query-redacted>");
});

test("persisted text, event log: every string field keeps no query value in any form", async () => {
  const { sanitizedEvents } = await browserHooks();
  for (const text of QUERY_FORMS) {
    const events = {
      requests: [{ method: "POST", url: `/api/v1/orders/?flag&syn_private=${PRIVATE}`, postData: null }],
      responses: [
        { status: 201, url: `/api/v1/orders/?flag&syn_private=${PRIVATE}`, body: { ref_id: "synref1", checkout_url: `/x/checkout/?flag&syn_private=${PRIVATE}`, detail: text } },
        { status: 400, url: `${ORIGIN}/api/v1/orders/`, body: { payment_details: text } },
      ],
      failed: [{ url: `/x/?flag&syn_private=${PRIVATE}`, failure: text }],
      console: [{ type: "error", text }],
      pageErrors: [text],
      navigations: [{ url: `/x/?flag&syn_private=${PRIVATE}` }],
    };
    const persisted = sanitizedEvents(events);
    assert.equal(JSON.stringify(persisted).includes(PRIVATE), false, `${text}: no private value in the event log`);
  }
});

test("persisted text, test order and runner assertion: error, verification, step notes, labels and every nested string keep no query value in any form", async () => {
  const { persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  for (const text of QUERY_FORMS) {
    const order = {
      path: "accept",
      checkout_url: `${ORIGIN}/x/checkout/`,
      final_url: `${ORIGIN}/x/receipt/`,
      error: text,
      verification: { verified: false, error: text, notes: [text] },
      evidence: { steps: [{ step: "opened_checkout", status: "failed", detail: text, label: text }] },
      upsell: { offer_url: `/x/upsell/?flag&syn_private=${PRIVATE}`, note: text },
    };
    assert.equal(JSON.stringify(persistedTestOrder(order)).includes(PRIVATE), false, `${text}: no private value in the test order`);
    const assertion = { id: "browser-test-order:checkout", family: "browser-test-order", expected: text, actual: text, evidence: { label: text, steps: order.evidence.steps } };
    assert.equal(JSON.stringify(redactPersisted(assertion)).includes(PRIVATE), false, `${text}: no private value in the runner assertion`);
  }
});

test("persisted text, tracking rows: a rendered tag name carrying a query keeps its row, compared on the name as rendered, and no row, assertion or observation holds the query value", async () => {
  const name = `syn_tag?flag&syn_private=${PRIVATE}`;
  const { observation } = await liveAttempt({
    page: pageAnswering({ tags: [{ name, value: "syn_v" }, { name: `?syn_private=${PRIVATE}`, value: "syn_v" }], inline: false, pins: [] }),
    request: JSON.stringify({ attribution: { ...Object.fromEntries(FIELDS.map((field) => [field, `cosqa_${FIELD_PARAM[field] || field}_01020304`])), metadata: { [name]: "syn_v" } } }),
  });
  const rows = await rowsOf(observation);
  assert.deepEqual([...rows.keys()].filter((id) => id.startsWith("tracking.tag")), ["tracking.tag:checkout:tag:syn_tag<query-redacted>", "tracking.tag:checkout:tag:<query-redacted>"]);
  assert.deepEqual(resultOf(rows.get("tracking.tag:checkout:tag:syn_tag<query-redacted>")), ["pass", null], "the request metadata is compared under the name as rendered");
  assert.deepEqual(resultOf(rows.get("tracking.tag:checkout:tag:<query-redacted>")), ["warning", "tag_missing"]);
  const { trackingQaAssertion } = await tracking();
  const persisted = { rows: [...rows.values()], assertions: [...rows.values()].map(trackingQaAssertion) };
  assert.equal(JSON.stringify(persisted).includes(PRIVATE), false, "no private value in any row or assertion");
  assertNothingPrivatePersisted(persisted, { markers: { private: PRIVATE } });
  const read = await readRows([...rows.values()]);
  assert.deepEqual(read.map(resultOf), [...rows.values()].map(resultOf), "the rows re-derive through the 1.0 reader");
});

// ---------------------------------------------------------------------------
// Tag literals are kept exactly as rendered

test("a rendered tag whose literal is only whitespace keeps its row: tag_value_differs when the request metadata differs, pass when it holds the same whitespace", async () => {
  const blank = pageAnswering({ tags: [{ name: "syn_tag", value: "   " }], inline: false, pins: [] });
  const differs = await liveAttempt({ page: blank });
  assert.deepEqual(differs.observation.names.map((entry) => [entry.tag_or_name, entry.outcome, entry.literal_sha256]), [["syn_tag", "differs", sha256("   ")]]);
  const row = (await rowsOf(differs.observation)).get("tracking.tag:checkout:tag:syn_tag");
  assert.deepEqual(resultOf(row), ["warning", "tag_value_differs"]);
  const { rederiveQcResult } = await tracking();
  assert.equal(rederiveQcResult({ ...differs.observation, check: "tracking.tag", tag: "syn_tag" }).state.literal_sha256, sha256("   "));
  assert.deepEqual(resultOf((await readRows([row]))[0]), ["warning", "tag_value_differs"], "through the 1.0 reader");
  const equal = await liveAttempt({
    page: blank,
    request: JSON.stringify({ attribution: { ...Object.fromEntries(FIELDS.map((field) => [field, `cosqa_${FIELD_PARAM[field] || field}_01020304`])), metadata: { syn_tag: "   " } } }),
  });
  assert.deepEqual(resultOf((await rowsOf(equal.observation)).get("tracking.tag:checkout:tag:syn_tag")), ["pass", null]);
});

test("a tag literal with leading and trailing whitespace is hashed as rendered, never trimmed", async () => {
  const literal = " syn_v ";
  const { observation } = await liveAttempt({
    page: pageAnswering({ tags: [{ name: "syn_tag", value: literal }], inline: false, pins: [] }),
    request: JSON.stringify({ attribution: { ...Object.fromEntries(FIELDS.map((field) => [field, `cosqa_${FIELD_PARAM[field] || field}_01020304`])), metadata: { syn_tag: literal } } }),
  });
  assert.notEqual(sha256(literal), sha256("syn_v"));
  assert.deepEqual(observation.names.map((entry) => [entry.outcome, entry.literal_sha256]), [["equal", sha256(literal)]]);
  const row = (await rowsOf(observation)).get("tracking.tag:checkout:tag:syn_tag");
  assert.deepEqual(resultOf(row), ["pass", null]);
  const { rederiveQcResult } = await tracking();
  assert.equal(rederiveQcResult({ ...observation, check: "tracking.tag", tag: "syn_tag" }).state.literal_sha256, sha256(literal), "the accept state binds the literal as rendered");
});

// ---------------------------------------------------------------------------
// Equality compares the values as read, never decoded on one side

test("a value equal to its seed only after one more percent-decoding differs: URL url_param_changed, order order_attribution_differs, tag tag_value_differs", async () => {
  const encoded = (value) => value.replace(/_/g, "%5F");
  const { observation, seeds } = await liveAttempt({
    during: (observer, runSeeds) => {
      const query = new URLSearchParams(runSeeds);
      query.set("utm_source", encoded(runSeeds.utm_source));
      observer.onFrameNavigated(`${ORIGIN}/x/bridge/?${query}`, { url: `${ORIGIN}/x/bridge/?${query}`, newDocument: true });
    },
    request: JSON.stringify({ attribution: { ...Object.fromEntries(FIELDS.map((field) => [field, `cosqa_${FIELD_PARAM[field] || field}_01020304`])), utm_medium: encoded("cosqa_utm_medium_01020304"), metadata: { syn_tag: "syn%5Fv" } } }),
  });
  assert.equal(seeds.utm_medium, "cosqa_utm_medium_01020304", "setup: the seed the request value encodes");
  assert.equal(decodeURIComponent(encoded(seeds.utm_source)), seeds.utm_source, "setup: one more decoding gives the seed");
  const rows = await rowsOf(observation);
  const url = rows.get("tracking.url:checkout:url");
  assert.deepEqual(resultOf(url), ["warning", "url_param_changed"]);
  assert.deepEqual(url.members.find((entry) => entry.key === "utm_source"), { key: "utm_source", result: "warning", reason_code: "url_param_changed" });
  const order = rows.get("tracking.order:checkout:order");
  assert.deepEqual(resultOf(order), ["warning", "order_attribution_differs"]);
  assert.deepEqual(order.members.find((entry) => entry.key === "utm_medium"), { key: "utm_medium", result: "warning", reason_code: "order_attribution_differs" });
  assert.deepEqual(resultOf(rows.get("tracking.tag:checkout:tag:syn_tag")), ["warning", "tag_value_differs"]);
});

// ---------------------------------------------------------------------------
// Every create request is judged, the accepted one included

test("live: a rejected create equal to the seeds, then an accepted create that differs, reads order_attribution_differs and tag_value_differs", async () => {
  const equal = JSON.stringify({ attribution: { ...Object.fromEntries(FIELDS.map((field) => [field, `cosqa_${FIELD_PARAM[field] || field}_01020304`])), metadata: { syn_tag: "syn_v" } } });
  const { observation } = await liveAttempt({
    during: (observer) => {
      observer.onCreateRequest(equal);
      observer.onCreateResponseStatus(422);
    },
    request: JSON.stringify({ attribution: { ...JSON.parse(equal).attribution, utm_source: "syn_other", metadata: { syn_tag: "syn_w" } } }),
  });
  const rows = await rowsOf(observation);
  const order = rows.get("tracking.order:checkout:order");
  assert.deepEqual(resultOf(order), ["warning", "order_attribution_differs"]);
  assert.deepEqual(order.members.find((entry) => entry.key === "utm_source"), { key: "utm_source", result: "warning", reason_code: "order_attribution_differs" });
  assert.deepEqual(resultOf(rows.get("tracking.tag:checkout:tag:syn_tag")), ["warning", "tag_value_differs"]);
});

// ---------------------------------------------------------------------------
// An echo alone never renders a tag

test("a tag with only a create-response observation never reads pass; the reader refuses it", async () => {
  const observation = stored({ check: "tracking.tag", tag: "syn_tag", names: [{ tag_or_name: "syn_tag", source: "create_response", outcome: "equal", literal_sha256: sha256("syn_v") }] });
  const { derived } = await storedRow(observation);
  assert.equal(derived, null, "no request-metadata equality: not re-derivable");
  const forged = (await storedRow(stored({ check: "tracking.tag", tag: "syn_tag" }))).row;
  const [read] = await readRows([{ ...forged, observation }]);
  assert.notEqual(read.result, "pass");
  // The complete producer observation with its tag entry replaced by an echo.
  const { trackingQcRows } = await tracking();
  const echoOnly = { ...structuredClone(COMPLETE), names: [{ tag_or_name: "syn_tag", source: "create_response", outcome: "equal", literal_sha256: sha256("syn_v"), rendered: true }] };
  const rows = trackingQcRows(echoOnly, { measuredAt });
  assert.deepEqual(rows.filter((row) => row.check === "tracking.tag").map(resultOf), [], "no tag row is built from an echo alone");
  const [refused] = await readRows([{ ...PASS_ROWS.find((row) => row.check === "tracking.tag"), observation: { ...echoOnly, check: "tracking.tag", tag: "syn_tag" } }]);
  assert.notEqual(refused.result, "pass", "a stored pass over it is refused");
});

// ---------------------------------------------------------------------------
// The create hold's own bound

test("the create hold continues an accepted create at the one-second bound even when the observer's read never settles, and the overrun is a failed extractor (injected clock)", async (t) => {
  const { attachCreateResponseTap } = await browserHooks();
  const { createTrackingRun, TRACKING_ADDED_BOUND_MS } = await tracking();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const observer = createTrackingRun({ runId: "qa-tracking-hardening-hold" }).observe(PLAN);
  // The observer records its read as usual; what it hands the hold never
  // settles, so only the hold's own timer can continue the create.
  const tap = { ...observer, tapCreateResponse: (readBody) => { observer.tapCreateResponse(readBody); return new Promise(() => {}); } };
  const { sent, session, page } = fakeCdpPage({ "Fetch.getResponseBody": () => new Promise(() => {}) });
  await attachCreateResponseTap(page, tap);
  session.emit("Fetch.requestPaused", { requestId: "create-1", responseStatusCode: 201, request: { method: "POST", url: `${ORIGIN}/api/v1/orders/` } });
  await settle();
  const continued = () => sent.filter((entry) => entry.method === "Fetch.continueRequest" && entry.params.requestId === "create-1");
  t.mock.timers.tick(TRACKING_ADDED_BOUND_MS - 1);
  await settle();
  assert.equal(continued().length, 0, "held until the bound");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(continued().length, 1, "continued at the bound, exactly once");
  assert.equal(continued()[0].at, TRACKING_ADDED_BOUND_MS);
  const observation = await observer.finalize({ createActivity: ACCEPTED });
  assert.ok(observation.extractor_failed.includes("response_equality"), "the overrun is recorded as a failed extractor");
  const order = (await rowsOf(observation)).get("tracking.order:checkout:order");
  assert.notEqual(order.result, "pass");
});

// ---------------------------------------------------------------------------
// An unknown extractor name

for (const [label, value] of [["an unknown name", ["syn_unknown_extractor"]], ["a known and an unknown name", ["hop_equality", "syn_unknown_extractor"]]]) {
  test(`M: extractor_failed holding ${label} never lets any row pass, re-derived or captured`, async () => {
    const { trackingQcRows } = await tracking();
    const rederived = structuredClone(COMPLETE);
    rederived.extractor_failed = structuredClone(value);
    const { observation: captured } = await liveAttempt({ hooks: { rawObservation: (raw) => { raw.extractor_failed = structuredClone(value); } } });
    assert.deepEqual(captured.extractor_failed, ["hop_equality", "request_equality", "response_equality", "tag_dom_read", "page_script_scan"], "capture records every extractor failed");
    for (const [path, observation] of [["re-derived", rederived], ["captured", captured]]) {
      const rows = trackingQcRows(observation, { measuredAt });
      assert.deepEqual(rows.map((row) => [row.check, ...resultOf(row)]), [["tracking.url", "unexercised", "extractor_failed"], ["tracking.order", "unexercised", "extractor_failed"], ["tracking.tag", "unexercised", "extractor_failed"]], path);
      assert.deepEqual((await readRows(rows)).map(resultOf), rows.map(resultOf), `${path}: through the 1.0 reader`);
    }
    for (const row of PASS_ROWS) {
      const [forged] = await readRows([{ ...row, observation: { ...rederived, check: row.check, ...(row.check === "tracking.tag" ? { tag: "syn_tag" } : {}) } }]);
      assert.notEqual(forged.result, "pass", `${row.id}: a stored pass over the observation is refused`);
    }
  });
}

// ---------------------------------------------------------------------------
// Document or history hop: only the browser's commit signal for the hop's own
// URL makes it a document hop; network events never do

// A fake page the actual captureCheckoutEvents listeners attach to, driven one
// browser event at a time: navigation requests with their responses or
// failures, and main-frame hops. With `commitSignal`, the main frame also has
// Playwright's own emitter, which emits "navigated" (with `newDocument` for a
// document commit) just before each hop that passes one.
function navigationEventsPage({ commitSignal = false } = {}) {
  const page = new EventEmitter();
  let current = `${ORIGIN}/x/landing/`;
  const main = { url: () => current };
  if (commitSignal) main._eventEmitter = new EventEmitter();
  page.mainFrame = () => main;
  page.evaluate = async () => TAG_READ;
  const session = new EventEmitter();
  session.send = async () => ({});
  page.context = () => ({ newCDPSession: async () => session });
  const request = (target, { method = "GET", body = null, navigation = true, from = null } = {}) => ({
    url: () => target,
    method: () => method,
    postData: () => body,
    isNavigationRequest: () => navigation,
    frame: () => main,
    resourceType: () => (navigation ? "document" : "fetch"),
    redirectedFrom: () => from,
    timing: () => ({ startTime: Date.now() }),
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  });
  const send = (target, options) => {
    const sent = request(target, options);
    page.emit("request", sent);
    return sent;
  };
  const respond = (sent, status = 200, text = "", headers = {}) => page.emit("response", { url: () => sent.url(), status: () => status, request: () => sent, headers: () => headers, text: async () => text });
  const fail = (sent) => page.emit("requestfailed", sent);
  // newDocument: true or false is the commit signal for the hop; null gives
  // none. `signalUrl` is the URL the signal names (the hop's own by default).
  const hop = (target, newDocument = null, signalUrl = target) => {
    current = target;
    if (main._eventEmitter && newDocument !== null) main._eventEmitter.emit("navigated", { url: signalUrl, name: "", ...(newDocument ? { newDocument: {} } : {}) });
    page.emit("framenavigated", main);
  };
  // A commit signal on its own (a navigation that failed to commit).
  const signal = (event) => main._eventEmitter?.emit("navigated", event);
  // A document navigation as the browser reports it: request, response, commit.
  const navigate = (target) => {
    respond(send(target), 200);
    hop(target, true);
  };
  return { page, send, respond, fail, hop, navigate, signal };
}

// One attempt through the actual listeners: the seeded entry load and a page
// document hop to checkout, then the accepted create, then `after(fake,
// query)`.
async function listenerAttempt({ commitSignal = false, after = null } = {}) {
  const { captureCheckoutEvents } = await browserHooks();
  const { createTrackingRun } = await tracking();
  const run = createTrackingRun({ runId: "qa-tracking-hardening-listeners", random: () => Buffer.from([1, 2, 3, 4]) });
  const observer = run.observe(PLAN);
  const fake = navigationEventsPage({ commitSignal });
  captureCheckoutEvents(fake.page, observer);
  const entry = observer.runnerUrl(`${ORIGIN}/x/landing/`, addParam);
  fake.navigate(entry);
  await observer.readDocument(fake.page);
  const query = new URL(entry).search;
  fake.navigate(`${ORIGIN}/x/checkout/${query}`);
  const attribution = Object.fromEntries(FIELDS.map((field) => [field, run.seeds[FIELD_PARAM[field] || field]]));
  const create = fake.send(`${ORIGIN}/api/v1/orders/`, { method: "POST", navigation: false, body: JSON.stringify({ attribution: { ...attribution, metadata: { syn_tag: "syn_v" } } }) });
  fake.respond(create, 201, JSON.stringify({ ref_id: "synref1" }));
  await settle();
  if (after) await after(fake, query);
  const observation = await observer.finalize({ createActivity: ACCEPTED });
  return { observation, query };
}

const SIGNAL_MODES = [["no commit signal: every hop reads history", false], ["with the browser's commit signal", true]];
const kindsAfterCheckout = (observation) => observation.hops.slice(2).map((entry) => [entry.path.slice(ORIGIN.length), entry.kind]);

for (const [mode, commitSignal] of SIGNAL_MODES) {
  test(`live listeners (${mode}): accepted create, a seeded document request pending, requestfailed net::ERR_ABORTED, then pushState directly to its URL is a history hop and never the post-order navigation (attempt_incomplete, through the 1.0 reader)`, async () => {
    const { observation } = await listenerAttempt({
      commitSignal,
      after: (fake, query) => {
        const pending = `${ORIGIN}/x/pending-document/${query}`;
        fake.fail(fake.send(pending));
        fake.hop(pending, false);
      },
    });
    assert.deepEqual(kindsAfterCheckout(observation), [["/x/pending-document/", "history"]]);
    assert.equal(observation.post_order_seq, null);
    const url = (await rowsOf(observation)).get("tracking.url:checkout:url");
    assert.deepEqual(resultOf(url), ["unexercised", "attempt_incomplete"]);
    assert.equal(url.coverage.last_observed, `${ORIGIN}/x/pending-document/`);
    const [read] = await readRows([url]);
    assert.deepEqual(resultOf(read), ["unexercised", "attempt_incomplete"], "through the 1.0 reader");
  });
}

// Each sequence after the accepted create, with the kind of every later hop
// and the URL row. Where a sequence is one that already read correctly, it
// ends with an aborted request for its last URL and a pushState to it.
const HOP_SEQUENCES = [
  ["a document navigation answered 200 and committed reads document and is the post-order navigation; an aborted request for the same URL, then a pushState to it, reads history", (fake, query) => {
    fake.navigate(`${ORIGIN}/x/receipt/${query}`);
    fake.fail(fake.send(`${ORIGIN}/x/receipt/${query}`));
    fake.hop(`${ORIGIN}/x/receipt/${query}`, false);
  }, [["/x/receipt/", "document"], ["/x/receipt/", "history"]], ["pass", null]],
  ["a redirect chain (302, then 200 at the final URL) reads document at the final URL; an aborted request for it, then a pushState to it, reads history", (fake, query) => {
    const first = fake.send(`${ORIGIN}/x/redirect/${query}`);
    fake.respond(first, 302);
    fake.respond(fake.send(`${ORIGIN}/x/receipt/${query}`, { from: first }), 200);
    fake.hop(`${ORIGIN}/x/receipt/${query}`, true);
    fake.fail(fake.send(`${ORIGIN}/x/receipt/${query}`));
    fake.hop(`${ORIGIN}/x/receipt/${query}`, false);
  }, [["/x/receipt/", "document"], ["/x/receipt/", "history"]], ["pass", null]],
  ["a navigation request never answered, then a pushState to its URL, reads history", (fake, query) => {
    fake.send(`${ORIGIN}/x/pending-document/${query}`);
    fake.hop(`${ORIGIN}/x/pending-document/${query}`, false);
  }, [["/x/pending-document/", "history"]], ["unexercised", "attempt_incomplete"]],
  ["a navigation request answered 200 and then aborted (window.stop() before commit), then a pushState to its URL, reads history", (fake, query) => {
    const sent = fake.send(`${ORIGIN}/x/pending-document/${query}`);
    fake.respond(sent, 200);
    fake.fail(sent);
    fake.hop(`${ORIGIN}/x/pending-document/${query}`, false);
  }, [["/x/pending-document/", "history"]], ["unexercised", "attempt_incomplete"]],
  ["a navigation request answered 204 (no document), then a pushState to its URL, reads history", (fake, query) => {
    fake.respond(fake.send(`${ORIGIN}/x/pending-document/${query}`), 204);
    fake.hop(`${ORIGIN}/x/pending-document/${query}`, false);
  }, [["/x/pending-document/", "history"]], ["unexercised", "attempt_incomplete"]],
  ["a cancelled request, an intervening pushState, a pushState to the cancelled URL, then the same URL requested and aborted again and pushed again: every hop reads history", (fake, query) => {
    const pending = `${ORIGIN}/x/pending-document/${query}`;
    fake.fail(fake.send(pending));
    fake.hop(`${ORIGIN}/x/intervening-history/${query}`, false);
    fake.hop(pending, false);
    fake.fail(fake.send(pending));
    fake.hop(pending, false);
  }, [["/x/intervening-history/", "history"], ["/x/pending-document/", "history"], ["/x/pending-document/", "history"]], ["unexercised", "attempt_incomplete"]],
];

for (const [mode, commitSignal] of SIGNAL_MODES) {
  for (const [label, after, kinds, urlResult] of HOP_SEQUENCES) {
    test(`live listeners (${mode}): ${label}`, async () => {
      const { observation } = await listenerAttempt({ commitSignal, after });
      // With no commit signal, no hop is a document hop and the attempt never
      // reaches its post-order navigation.
      assert.deepEqual(kindsAfterCheckout(observation), commitSignal ? kinds : kinds.map(([path]) => [path, "history"]));
      assert.deepEqual(resultOf((await rowsOf(observation)).get("tracking.url:checkout:url")), commitSignal ? urlResult : ["unexercised", "attempt_incomplete"]);
    });
  }
}

// Every post-create sequence a page can produce for one hop to the receipt,
// and whether the browser's commit signal for that hop says a new document
// committed at its URL. Network events (requests, answers of any status,
// failures, late answers) and a signal naming another URL never decide.
const COMMIT_TABLE = [
  ["an aborted request, then a pushState directly to its URL", (fake, receipt) => {
    fake.fail(fake.send(receipt));
    fake.hop(receipt, false);
  }, false],
  ["an aborted request, then a retry answered 200 that commits", (fake, receipt) => {
    fake.fail(fake.send(receipt));
    fake.respond(fake.send(receipt), 200);
    fake.hop(receipt, true);
  }, true],
  ["two requests: the first aborted, the second answered, then the commit", (fake, receipt) => {
    const [first, second] = [fake.send(receipt), fake.send(receipt)];
    fake.fail(first);
    fake.respond(second, 200);
    fake.hop(receipt, true);
  }, true],
  ["two requests: the second answered, the first aborted, then the commit", (fake, receipt) => {
    const [first, second] = [fake.send(receipt), fake.send(receipt)];
    fake.respond(second, 200);
    fake.fail(first);
    fake.hop(receipt, true);
  }, true],
  ["a request answered only by a 302, then a pushState to its URL", (fake, receipt) => {
    fake.respond(fake.send(receipt), 302);
    fake.hop(receipt, false);
  }, false],
  ["a request answered 304, then a document commit", (fake, receipt) => {
    fake.respond(fake.send(receipt), 304);
    fake.hop(receipt, true);
  }, true],
  ["a download answered 200 (Content-Disposition: attachment), then a pushState to its URL", (fake, receipt) => {
    fake.respond(fake.send(receipt), 200, "", { "content-disposition": "attachment" });
    fake.hop(receipt, false);
  }, false],
  ["a page restored from the back/forward cache, no request observed", (fake, receipt) => {
    fake.hop(receipt, true);
  }, true],
  ["a document navigation: request, 200, commit", (fake, receipt) => {
    fake.navigate(receipt);
  }, true],
  ["a redirect chain (302, then 200 at the final URL), then the commit at the final URL", (fake, receipt, query) => {
    const first = fake.send(`${ORIGIN}/x/redirect/${query}`);
    fake.respond(first, 302);
    fake.respond(fake.send(receipt, { from: first }), 200);
    fake.hop(receipt, true);
  }, true],
  ["a failed request that receives a late 200, then a pushState to its URL", (fake, receipt) => {
    const sent = fake.send(receipt);
    fake.fail(sent);
    fake.respond(sent, 200);
    fake.hop(receipt, false);
  }, false],
  ["a request answered 200, then a same-document hop to its URL", (fake, receipt) => {
    fake.respond(fake.send(receipt), 200);
    fake.hop(receipt, false);
  }, false],
  ["a download answered 200, then a hop whose commit signal names another URL", (fake, receipt, query) => {
    fake.respond(fake.send(receipt), 200, "", { "content-disposition": "attachment" });
    fake.hop(receipt, true, `${ORIGIN}/x/elsewhere/${query}`);
  }, false],
  ["a request answered 200, then a hop whose commit signal names the URL without its query", (fake, receipt) => {
    fake.respond(fake.send(receipt), 200);
    fake.hop(receipt, true, receipt.split("?")[0]);
  }, false],
  ["a request answered 200, a commit signal reporting an error, then the hop with no signal of its own", (fake, receipt) => {
    fake.respond(fake.send(receipt), 200);
    fake.signal({ url: receipt, name: "", newDocument: {}, error: "net::ERR_ABORTED" });
    fake.hop(receipt, null);
  }, false],
];

for (const [mode, commitSignal] of SIGNAL_MODES) {
  test(`live listeners (${mode}): each post-create sequence reads document only where the commit signal for the hop's own URL says a new document committed; every other hop reads history and the URL row attempt_incomplete, through the 1.0 reader`, async () => {
    for (const [label, after, committed] of COMMIT_TABLE) {
      const { observation } = await listenerAttempt({ commitSignal, after: (fake, query) => after(fake, `${ORIGIN}/x/receipt/${query}`, query) });
      const document = commitSignal && committed;
      assert.deepEqual(kindsAfterCheckout(observation), [["/x/receipt/", document ? "document" : "history"]], label);
      assert.equal(observation.post_order_seq, document ? observation.hops.at(-1).seq : null, label);
      const url = (await rowsOf(observation)).get("tracking.url:checkout:url");
      assert.deepEqual(resultOf(url), document ? ["pass", null] : ["unexercised", "attempt_incomplete"], label);
      const [read] = await readRows([url]);
      assert.deepEqual(resultOf(read), resultOf(url), `${label}: through the 1.0 reader`);
    }
  });
}

// The installed Playwright's own client Frame class, built from its
// in-process connection with no browser, as the main frame of a page the
// actual listeners attach to: the object the hop listener reads the commit
// signal from. `navigated(event)` delivers one protocol "navigated" event to
// the Frame, as the browser's commit would; the Frame itself then emits
// "framenavigated" on the page.
function installedPlaywrightPage(url) {
  const require = createRequire(import.meta.url);
  const core = require(createRequire(require.resolve("playwright")).resolve("playwright-core/lib/coreBundle"));
  const connection = core.inprocess.createInProcessPlaywright()._connection;
  const guid = "frame@syn-commit-signal";
  connection.dispatch({ guid: "", method: "__create__", params: { type: "Frame", guid, initializer: { url, name: "", loadStates: [] } } });
  const frame = connection._objects.get(guid);
  const page = new EventEmitter();
  page._eraseEvaluateCallbacks = () => {};
  page.context = () => ({ emit: () => true, newCDPSession: async () => Object.assign(new EventEmitter(), { send: async () => ({}) }) });
  page.mainFrame = () => frame;
  page.evaluate = async () => TAG_READ;
  frame._page = page;
  return { frame, page, navigated: (event) => connection.dispatch({ guid, method: "navigated", params: { name: "", ...event } }) };
}

test("installed Playwright: its Frame emits the commit signal (\"navigated\", with newDocument for a document commit and without it for a same-document one) just before \"framenavigated\"; through the actual listeners only that signal makes a document hop, and a Frame whose signal cannot be subscribed reads history even with the request answered 200", async () => {
  const { captureCheckoutEvents } = await browserHooks();
  const { createTrackingRun } = await tracking();
  const landing = `${ORIGIN}/x/landing/`;
  const probe = installedPlaywrightPage(landing);
  assert.equal(typeof probe.frame?._eventEmitter?.on, "function", "the installed Frame has the emitter the hop listener reads");
  const order = [];
  probe.frame._eventEmitter.on("navigated", (event) => order.push(["navigated", event.url, Boolean(event.newDocument)]));
  probe.page.on("framenavigated", (navigatedFrame) => order.push(["framenavigated", navigatedFrame.url()]));
  probe.navigated({ url: `${ORIGIN}/x/a/`, newDocument: {} });
  probe.navigated({ url: `${ORIGIN}/x/a/#same` });
  assert.deepEqual(order, [["navigated", `${ORIGIN}/x/a/`, true], ["framenavigated", `${ORIGIN}/x/a/`], ["navigated", `${ORIGIN}/x/a/#same`, false], ["framenavigated", `${ORIGIN}/x/a/#same`]]);

  // Through the actual listeners on the installed Frame: two document
  // commits, a same-document hop, then a navigation request answered 200 and
  // a same-document hop to its URL.
  const observeWith = (subscribable) => {
    const { frame, page, navigated } = installedPlaywrightPage(landing);
    if (!subscribable) frame._eventEmitter = { emit: () => true };
    const observer = createTrackingRun({ runId: "qa-tracking-hardening-installed", random: () => Buffer.from([1, 2, 3, 4]) }).observe(PLAN);
    captureCheckoutEvents(page, observer);
    const entry = observer.runnerUrl(landing, addParam);
    navigated({ url: entry, newDocument: {} });
    const query = new URL(entry).search;
    navigated({ url: `${ORIGIN}/x/checkout/${query}`, newDocument: {} });
    navigated({ url: `${ORIGIN}/x/cart/${query}` });
    const answered = { url: () => `${ORIGIN}/x/receipt/${query}`, method: () => "GET", postData: () => null, isNavigationRequest: () => true, frame: () => frame, resourceType: () => "document", redirectedFrom: () => null, timing: () => ({ startTime: Date.now() }) };
    page.emit("request", answered);
    page.emit("response", { url: () => answered.url(), status: () => 200, request: () => answered, headers: () => ({}), text: async () => "" });
    navigated({ url: `${ORIGIN}/x/receipt/${query}` });
    return observer.finalize({ createActivity: ACCEPTED });
  };
  const kinds = (observation) => observation.hops.map((entry) => [entry.path.slice(ORIGIN.length), entry.kind]);
  assert.deepEqual(kinds(await observeWith(true)), [["/x/landing/", "document"], ["/x/checkout/", "document"], ["/x/cart/", "history"], ["/x/receipt/", "history"]]);
  assert.deepEqual(kinds(await observeWith(false)), [["/x/landing/", "history"], ["/x/checkout/", "history"], ["/x/cart/", "history"], ["/x/receipt/", "history"]], "no signal: every hop reads history");
});

test("live listeners, the browser's commit signal decides: a same-document commit to a URL whose request was answered 200 reads history; a document commit with no request observed (a page restored from the back/forward cache) reads document", async () => {
  const sameDocument = await listenerAttempt({
    commitSignal: true,
    after: (fake, query) => {
      fake.respond(fake.send(`${ORIGIN}/x/receipt/${query}`), 200);
      fake.hop(`${ORIGIN}/x/receipt/${query}`, false);
    },
  });
  assert.deepEqual(kindsAfterCheckout(sameDocument.observation), [["/x/receipt/", "history"]]);
  assert.equal(sameDocument.observation.post_order_seq, null);
  const restored = await listenerAttempt({ commitSignal: true, after: (fake, query) => fake.hop(`${ORIGIN}/x/receipt/${query}`, true) });
  assert.deepEqual(kindsAfterCheckout(restored.observation), [["/x/receipt/", "document"]]);
  assert.deepEqual(resultOf((await rowsOf(restored.observation)).get("tracking.url:checkout:url")), ["pass", null]);
});

// ---------------------------------------------------------------------------
// Persisted values: one projection over every key and string, decoded

// Whether `value`, serialized and percent-decoded until stable, holds the
// private value anywhere.
function holdsPrivate(value) {
  let text = JSON.stringify(value);
  for (let round = 0; round < 8; round += 1) {
    if (text.includes(PRIVATE)) return true;
    const next = text.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === text) return false;
    text = next;
  }
  return true;
}

// The encoded forms of "/x/?k=<private>": "%3F" with an encoded path, mixed
// case "%3f", double-encoded "%253F", each with what the projection keeps:
// the text before the query, in its own encoding, and the marker.
const ENCODED_QUERY_FORMS = Object.freeze([
  [`load %2Fx%2F%3Fk%3D${PRIVATE}`, "load %2Fx%2F<query-redacted>"],
  [`load /x/%3fk%3d${PRIVATE}`, "load /x/<query-redacted>"],
  [`load /x/%253Fk%253D${PRIVATE}`, "load /x/<query-redacted>"],
  [`load %252Fx%252F%253Fk%253D${PRIVATE} then`, "load %252Fx%252F<query-redacted>"],
]);

test("persisted keys: a query inside a response-detail object key leaves no query value in the event log or the test order; colliding keys keep every value under deterministic names", async () => {
  const { sanitizedEvents, persistedTestOrder } = await browserHooks();
  const detail = { [`load /x/?k=${PRIVATE}`]: "invalid", [`load %2Fx%2F%3Fk%3D${PRIVATE}`]: "encoded", "load /x/": "plain", [`load /x/?k=other_${PRIVATE}`]: "second" };
  const events = { requests: [], responses: [{ status: 400, url: `${ORIGIN}/api/v1/orders/`, body: { detail } }], failed: [], console: [], pageErrors: [], navigations: [] };
  const persistedEvents = sanitizedEvents(events);
  assert.deepEqual(persistedEvents.responses[0].body.detail, { "load /x/<query-redacted>": "invalid", "load %2Fx%2F<query-redacted>": "encoded", "load /x/": "plain", "load /x/<query-redacted> [2]": "second" });
  const order = persistedTestOrder({ path: "accept", checkout_url: `${ORIGIN}/x/checkout/`, final_url: `${ORIGIN}/x/receipt/`, verification: { verified: false, [`at /x/?k=${PRIVATE}`]: { [`%3Fk%3D${PRIVATE}`]: "nested" } }, evidence: { events: persistedEvents } });
  assert.deepEqual(order.verification, { verified: false, "at /x/<query-redacted>": { "<query-redacted>": "nested" } });
  assert.equal(holdsPrivate(persistedEvents), false, "event log");
  assert.equal(holdsPrivate(order), false, "test order");
  assertNothingPrivatePersisted(order, { markers: { private: PRIVATE } });
});

test("persisted text: encoded query text (%3F, %3f, %253F) in an error leaves no query value in the event log, the test order or the runner assertion, and the text outside the query keeps its encoding", async () => {
  const { captureCheckoutEvents, sanitizedEvents, persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  for (const [text, kept] of ENCODED_QUERY_FORMS) {
    const fake = navigationEventsPage();
    const events = captureCheckoutEvents(fake.page, null);
    fake.page.emit("console", { type: () => "error", text: () => text });
    fake.page.emit("pageerror", new Error(text));
    const failed = fake.send(`${ORIGIN}/api/v1/orders/`, { method: "POST", navigation: false });
    failed.failure = () => ({ errorText: text });
    fake.fail(failed);
    const persistedEvents = sanitizedEvents(events);
    assert.equal(persistedEvents.console[0].text, kept, `${text}: console`);
    assert.deepEqual(persistedEvents.pageErrors, [kept], `${text}: page error`);
    assert.equal(persistedEvents.failed[0].failure, kept, `${text}: request failure`);
    const order = persistedTestOrder({ path: "accept", error: text, verification: { verified: false, error: text }, evidence: { steps: [{ step: "opened_checkout", detail: text, label: text }], events: persistedEvents } });
    assert.equal(order.error, kept, `${text}: order error`);
    const assertion = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", expected: text, actual: text, evidence: { label: text, events: persistedEvents } });
    assert.equal(assertion.actual, kept, `${text}: assertion actual`);
    assert.equal(assertion.evidence.label, kept, `${text}: assertion label`);
    for (const [root, value] of [["event log", persistedEvents], ["test order", order], ["runner assertion", assertion]]) assert.equal(holdsPrivate(value), false, `${text}: ${root}`);
  }
});

test("persisted tracking rows: a rendered tag name holding encoded query text (%3F, %3f, %253F) leaves no query value in the observation, row ids, assertion ids or the persisted rows, and the rows re-derive", async () => {
  const { trackingQaAssertion } = await tracking();
  const { redactPersisted } = await privacy();
  for (const [text, kept] of ENCODED_QUERY_FORMS) {
    const { observation } = await liveAttempt({ page: pageAnswering({ tags: [{ name: text, value: "syn_v" }], inline: false, pins: [] }) });
    assert.equal(holdsPrivate(observation), false, `${text}: observation`);
    const rows = [...(await rowsOf(observation)).values()];
    assert.ok(rows.some((row) => row.id === `tracking.tag:checkout:tag:${kept}`), `${text}: the tag keeps its row under the name without its query`);
    const assertions = rows.map(trackingQaAssertion);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(redactPersisted(row), row, `${row.id}: already projected, persisted as built`);
      assert.deepEqual(redactPersisted(assertions[index]), assertions[index], `${assertions[index].id}: already projected, persisted as built`);
    }
    assert.equal(holdsPrivate({ rows, assertions }), false, `${text}: rows and assertions`);
    assert.deepEqual((await readRows(rows)).map(resultOf), rows.map(resultOf), `${text}: through the 1.0 reader`);
  }
});

test("persisted verdict, one probe per root: event log, test order, runner assertion, QC rows (hop paths, failing hop, coverage, tag names, ids) and their qc.* assertions hold no non-seed query value in any encoding", async () => {
  const { captureCheckoutEvents, sanitizedEvents, persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  const { trackingQaAssertion } = await tracking();
  const encoded = `%3Fk%3D${PRIVATE}`;
  // Event log, through the actual listeners.
  const fake = navigationEventsPage();
  const events = captureCheckoutEvents(fake.page, null);
  fake.page.emit("console", { type: () => "error", text: () => `load /x/${encoded}` });
  fake.page.emit("pageerror", new Error(`load /x/%253Fk%253D${PRIVATE}`));
  const create = fake.send(`${ORIGIN}/api/v1/orders/${encoded}`, { method: "POST", navigation: false, body: JSON.stringify({ [`/x/?k=${PRIVATE}`]: 1 }) });
  fake.respond(create, 400, JSON.stringify({ detail: { [`load /x/${encoded}`]: "invalid" }, payment_details: `declined at /x/%3fk%3d${PRIVATE}` }));
  await settle();
  await settle();
  const persistedEvents = sanitizedEvents(events);
  assert.ok(persistedEvents.responses.length && persistedEvents.requests.length, "setup: the create request and response were logged");
  // Test order and runner assertion.
  const order = persistedTestOrder({ path: "accept", checkout_url: `${ORIGIN}/x/checkout/${encoded}`, final_url: `${ORIGIN}/x/receipt/`, error: `goto /x/${encoded}`, verification: { verified: false, [`note /x/${encoded}`]: `see %252Fx%252F%253Fk%253D${PRIVATE}` }, evidence: { steps: [{ step: "opened_checkout", label: `open /x/${encoded}` }], events: persistedEvents } });
  const runner = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", page: "checkout", actual: `goto /x/${encoded}`, evidence: { label: `open /x/${encoded}`, labels: { [`open /x/${encoded}`]: true }, events: persistedEvents } });
  // QC rows: a document hop from a path holding an encoded query drops
  // utm_medium on the next document hop (failing hop and coverage name the
  // paths), and a rendered tag name holds an encoded query.
  const { observation } = await liveAttempt({
    page: pageAnswering({ tags: [{ name: "syn_tag", value: "syn_v" }, { name: `syn_tag${encoded}`, value: "syn_v" }], inline: false, pins: [] }),
    during: (observer, seeds) => {
      const all = new URLSearchParams(seeds);
      const dropped = new URLSearchParams(seeds);
      dropped.delete("utm_medium");
      for (const target of [`${ORIGIN}/x/${encoded}/?${all}`, `${ORIGIN}/x/next/?${dropped}`]) observer.onFrameNavigated(target, { url: target, newDocument: true });
    },
  });
  const built = [...(await rowsOf(observation)).values()];
  const url = built.find((row) => row.id === "tracking.url:checkout:url");
  assert.deepEqual(resultOf(url), ["warning", "url_param_dropped"], "setup: the drop is named");
  assert.deepEqual(url.members.find((entry) => entry.key === "utm_medium").failing_hop, { from: `${ORIGIN}/x/<query-redacted>`, to: `${ORIGIN}/x/next/` });
  const qcResults = built.map(redactPersisted);
  const qcAssertions = built.map(trackingQaAssertion).map(redactPersisted);
  assert.deepEqual(qcResults, built, "the persisted rows equal the rows as built");
  const verdict = fullVerdict({ assertions: [runner, ...qcAssertions], measuredAt });
  verdict.test_orders = [order];
  verdict.qc_results = qcResults;
  for (const [root, value] of [["event log", persistedEvents], ["test order", order], ["runner assertion", runner], ["QC rows", qcResults], ["qc.* assertions", qcAssertions], ["verdict", verdict]]) {
    assert.equal(holdsPrivate(value), false, `${root}: no query value in any encoding`);
  }
  assertNothingPrivatePersisted(withoutBodyMarkers(verdict), { markers: { private: PRIVATE } });
  assert.deepEqual((await readRows(qcResults)).map(resultOf), built.map(resultOf), "the persisted rows re-derive through the 1.0 reader");
});

// ---------------------------------------------------------------------------
// Persisted values: everything from the first query to the end of the string

const QUERY_MARKER = "<query-redacted>";
const privacy = () => import("./qa-url-privacy.mjs");

// Text where what follows the query's "?" hides where the query ends (an
// encoded quote or space before the value, an encoded quoted second
// parameter, a quote inside a literal query), each with its projection.
const CUT_FORMS = Object.freeze([
  [`load /x/%3Fk%3D%22${PRIVATE}%22`, `load /x/${QUERY_MARKER}`],
  [`load /x/%3Fk%3D%20${PRIVATE}`, `load /x/${QUERY_MARKER}`],
  [`load /x/%3Fa%3D1%26b%3D%22${PRIVATE}%22 then`, `load /x/${QUERY_MARKER}`],
  [`load /x/%253Fk%253D%2522${PRIVATE}%2522 then`, `load /x/${QUERY_MARKER}`],
  [`see ${ORIGIN}/x/%3Fk%3D%22${PRIVATE}%22 then`, `see ${ORIGIN}/x/${QUERY_MARKER}`],
  [`see ${ORIGIN}/x/?k="${PRIVATE} more" then`, `see ${ORIGIN}/x/${QUERY_MARKER}`],
  [`load /x/?k=1 then /y/ "${PRIVATE}"`, `load /x/${QUERY_MARKER}`],
]);

test("persisted text: from the first query, found literally or by percent-decoding, to the end of the string is cut, whatever follows the \"?\" (encoded quote or space before the value, encoded quoted second parameter, quote inside a literal query); every URL before it keeps its origin+path", async () => {
  const { redactUrlQueriesInText } = await privacy();
  const { sanitizedEvents, persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  for (const [text, kept] of CUT_FORMS) {
    assert.equal(redactUrlQueriesInText(text), kept, text);
    const events = { requests: [], responses: [{ status: 400, url: `${ORIGIN}/api/v1/orders/`, body: { detail: { [text]: text } } }], failed: [{ url: `${ORIGIN}/x/`, failure: text }], console: [{ type: "error", text }], pageErrors: [text], navigations: [] };
    const persistedEvents = sanitizedEvents(events);
    const order = persistedTestOrder({ path: "accept", error: text, verification: { verified: false, [text]: text }, evidence: { steps: [{ step: "opened_checkout", label: text }], events: persistedEvents } });
    const assertion = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", actual: text, evidence: { labels: { [text]: true }, events: persistedEvents } });
    for (const [root, value] of [["event log", persistedEvents], ["test order", order], ["runner assertion", assertion]]) {
      assert.equal(holdsPrivate(value), false, `${text}: ${root}`);
      assertNothingPrivatePersisted(withoutBodyMarkers(value), { markers: { private: PRIVATE } });
    }
  }
});

test("persisted text: a string still decoding after the bounded rounds is replaced whole by the marker; a string over 16 KiB is cut to 16 KiB with a marker before it is projected; the projection of its own output is that output", async () => {
  const { redactUrlQueriesInText, redactPersisted } = await privacy();
  const deep = (depth) => `load /x/%${"25".repeat(depth)}3Fk=${PRIVATE}`;
  assert.equal(redactUrlQueriesInText(deep(7)), `load /x/${QUERY_MARKER}`);
  for (const depth of [8, 9, 16]) assert.equal(redactUrlQueriesInText(deep(depth)), QUERY_MARKER, `depth ${depth}`);
  const long = `${"a".repeat(20_000)}?k=${PRIVATE}`;
  const cut = redactUrlQueriesInText(long);
  assert.equal(cut.length, 16 * 1024);
  assert.ok(cut.endsWith("[truncated]") && !cut.includes(PRIVATE));
  assert.equal(redactUrlQueriesInText(`${"a".repeat(100)}?k=${"b".repeat(20_000)}`), `${"a".repeat(100)}${QUERY_MARKER}`);
  const inputs = [...CUT_FORMS.map(([text]) => text), ...QUERY_FORMS, ...ENCODED_QUERY_FORMS.map(([text]) => text), deep(7), deep(9), long, QUERY_MARKER, `see ${ORIGIN}/x/#frag then ${ORIGIN}/y/?k=1`, `${ORIGIN}/x/%3F`, "plain text, no query"];
  for (const text of inputs) {
    const once = redactUrlQueriesInText(text);
    assert.equal(redactUrlQueriesInText(once), once, `idempotent: ${text.slice(0, 80)}`);
    assert.equal(holdsPrivate(once), false, `no query value: ${text.slice(0, 80)}`);
  }
  const keyed = { [`load /x/?k=${PRIVATE}`]: 1, [`load /x/%3Fk%3D%22${PRIVATE}%22`]: 2, [`load /x/${QUERY_MARKER}`]: 3 };
  const projected = redactPersisted(keyed);
  assert.deepEqual(projected, { [`load /x/${QUERY_MARKER}`]: 1, [`load /x/${QUERY_MARKER} [2]`]: 2, [`load /x/${QUERY_MARKER} [3]`]: 3 });
  assert.deepEqual(redactPersisted(projected), projected, "idempotent over keys");
});

test("persisted text: projecting a 1,000,000-character string takes under 200 ms, whatever it holds (letters, \"://\" runs, percent runs, a query at the end)", async () => {
  const moduleUrl = new URL("./qa-url-privacy.mjs", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    import(${JSON.stringify(moduleUrl)}).then(({ redactUrlQueriesInText }) => {
      const size = 1_000_000;
      const inputs = {
        letters: "a".repeat(size),
        schemes: "a://".repeat(size / 4),
        percents: "%25".repeat(Math.floor(size / 3)),
        "query at the end": \`\${"x".repeat(size - 10)}?k=secret\`,
      };
      const timings = {};
      for (const [label, text] of Object.entries(inputs)) {
        const started = performance.now();
        const projected = redactUrlQueriesInText(text);
        timings[label] = { ms: performance.now() - started, length: projected.length };
      }
      parentPort.postMessage(timings);
    });
  `, { eval: true });
  let timer;
  try {
    const timings = await Promise.race([
      new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the projection did not finish within 10 s")), 10_000); }),
    ]);
    for (const [label, { ms, length }] of Object.entries(timings)) {
      assert.ok(ms < 200, `${label}: ${ms.toFixed(1)} ms`);
      assert.ok(length <= 16 * 1024, `${label}: bounded output (${length})`);
    }
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test("persisted verdict, one probe per root, for text whose query end is hidden: event log, test order, runner assertion, QC rows (hop paths, failing hop, coverage, tag names, ids) and their qc.* assertions hold no non-seed query value in any encoding, and the rows re-derive", async () => {
  const { captureCheckoutEvents, sanitizedEvents, persistedTestOrder } = await browserHooks();
  const { redactPersisted } = await privacy();
  const { trackingQaAssertion } = await tracking();
  const quoted = `%3Fk%3D%22${PRIVATE}%22`;
  const spaced = `%3Fk%3D%20${PRIVATE}`;
  const second = `%3Fa%3D1%26b%3D%22${PRIVATE}%22`;
  // Event log, through the actual listeners.
  const fake = navigationEventsPage();
  const events = captureCheckoutEvents(fake.page, null);
  fake.page.emit("console", { type: () => "error", text: () => `load /x/${quoted}` });
  fake.page.emit("pageerror", new Error(`load /x/${spaced}`));
  const create = fake.send(`${ORIGIN}/api/v1/orders/${quoted}`, { method: "POST", navigation: false, body: JSON.stringify({ [`/x/${second}`]: 1 }) });
  fake.respond(create, 400, JSON.stringify({ detail: { [`load /x/${second}`]: `see /x/${spaced}` }, payment_details: `declined at /x/${quoted}` }));
  await settle();
  await settle();
  const persistedEvents = sanitizedEvents(events);
  assert.ok(persistedEvents.responses.length && persistedEvents.requests.length, "setup: the create request and response were logged");
  // Test order and runner assertion.
  const order = persistedTestOrder({ path: "accept", checkout_url: `${ORIGIN}/x/checkout/${quoted}`, final_url: `${ORIGIN}/x/receipt/`, error: `goto /x/${spaced}`, verification: { verified: false, [`note /x/${second}`]: `see /x/${quoted}` }, evidence: { steps: [{ step: "opened_checkout", label: `open /x/${second}` }], events: persistedEvents } });
  const runner = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", page: "checkout", actual: `goto /x/${quoted}`, evidence: { label: `open /x/${spaced}`, labels: { [`open /x/${second}`]: true }, events: persistedEvents } });
  // QC rows: a document hop from a path holding a hidden-end query drops
  // utm_medium on the next document hop, the last hop's path holds one too,
  // and rendered tag names hold them.
  const { observation } = await liveAttempt({
    page: pageAnswering({ tags: [{ name: "syn_tag", value: "syn_v" }, { name: `syn_tag${quoted}`, value: "syn_v" }, { name: `syn_tag${second}`, value: "syn_v" }], inline: false, pins: [] }),
    during: (observer, seeds) => {
      const all = new URLSearchParams(seeds);
      const dropped = new URLSearchParams(seeds);
      dropped.delete("utm_medium");
      for (const target of [`${ORIGIN}/x/${quoted}/?${all}`, `${ORIGIN}/x/next/${spaced}/?${dropped}`]) observer.onFrameNavigated(target, { url: target, newDocument: true });
    },
  });
  const built = [...(await rowsOf(observation)).values()];
  const url = built.find((row) => row.id === "tracking.url:checkout:url");
  assert.deepEqual(resultOf(url), ["warning", "url_param_dropped"], "setup: the drop is named");
  assert.deepEqual(url.members.find((entry) => entry.key === "utm_medium").failing_hop, { from: `${ORIGIN}/x/${QUERY_MARKER}`, to: `${ORIGIN}/x/next/${QUERY_MARKER}` });
  const qcResults = built.map(redactPersisted);
  const qcAssertions = built.map(trackingQaAssertion).map(redactPersisted);
  assert.deepEqual(qcResults, built, "the persisted rows equal the rows as built");
  const verdict = fullVerdict({ assertions: [runner, ...qcAssertions], measuredAt });
  verdict.test_orders = [order];
  verdict.qc_results = qcResults;
  for (const [root, value] of [["event log", persistedEvents], ["test order", order], ["runner assertion", runner], ["observation", observation], ["QC rows", qcResults], ["qc.* assertions", qcAssertions], ["verdict", verdict]]) {
    assert.equal(holdsPrivate(value), false, `${root}: no query value in any encoding`);
  }
  assertNothingPrivatePersisted(withoutBodyMarkers(verdict), { markers: { private: PRIVATE } });
  assert.deepEqual((await readRows(qcResults)).map(resultOf), built.map(resultOf), "the persisted rows re-derive through the 1.0 reader");
});

// ---------------------------------------------------------------------------
// The verdict as `qa run` writes it: one projection for every persisted value

const nodeHooks = async () => (await import("./qa-node.mjs")).__qaNodeTestHooks;

// What finalizeQaRun needs from a resolved run: no packet (so no sidecar),
// no publish, the verdict written under a temporary output directory.
function finalizeInputs(topologies, outputDir) {
  const gate = { status: "not_applicable", reason: "synthetic run" };
  return {
    args: { _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, json: true },
    resolved: {
      topologies,
      packetPath: null,
      packet: null,
      mapId: "syn-map",
      localSpecId: null,
      publicRouteSlug: null,
      spec: { campaign: {} },
      specVersion: "v42",
      specHash: sha256("synthetic spec"),
      baseUrl: `${ORIGIN}/x/`,
      proxyBase: ORIGIN,
      themeGate: { ...gate, code: "theme_gate.not_applicable" },
      polishGate: { ...gate, code: "polish.not_applicable" },
    },
  };
}

function withOutputDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "qa-persisted-verdict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("persisted verdict: with no checkout URL, a query in the upsell page_id and funnel_id leaves no query value in the coverage assertion, its page or funnel evidence, or the verdict bytes written through maybeRunTestOrders", async (t) => {
  const { maybeRunTestOrders, finalizeQaRun } = await nodeHooks();
  const marker = "syn_verify_query_value_6b92";
  const topologies = [{
    funnel_id: `syn_funnel?key=${marker}`,
    pages: [
      { page_id: "checkout", page_type: "checkout" },
      { page_id: `syn_upsell?key=${marker}`, page_type: "upsell", url: `${ORIGIN}/x/upsell/` },
    ],
  }];
  const { args, resolved } = finalizeInputs(topologies, withOutputDir(t));
  const assertions = [];
  const orders = await maybeRunTestOrders({ args: { ...args, "test-order": "accept" }, resolved, runId: QA_RUN_ID, assertions });
  assert.equal(assertions.find((entry) => entry.id === "browser-test-order:checkout")?.actual, "missing", "setup: the run had no checkout URL");
  assert.ok(JSON.stringify(assertions).includes(marker), "setup: the coverage row as built names the query-bearing page and funnel");
  const result = await finalizeQaRun({ args, resolved, runId: QA_RUN_ID, startedAt: measuredAt, assertions, testOrders: orders.orders, qcResults: orders.qc_results });
  const bytes = readFileSync(result.local_path, "utf8");
  const persisted = JSON.parse(bytes);
  assert.ok(persisted.assertions.some((entry) => /upsell|coverage/.test(entry.id) && entry.id !== "browser-test-order:checkout"), "setup: the coverage assertion is persisted");
  assert.equal(bytes.includes(marker), false, "the verdict bytes hold no query value");
  assert.equal(holdsPrivate(persisted) || JSON.stringify(persisted).includes(marker), false);
  assert.equal(JSON.stringify(result.verdict).includes(marker), false, "the verdict the run returns is the persisted one");
  assert.deepEqual(JSON.parse(JSON.stringify(result.verdict)), persisted);
  assertNothingPrivatePersisted(persisted, { markers: { private: marker } });
});

test("persisted verdict: a query-bearing value at a key no runner projects (assertion, its evidence, a test order) leaves no non-seed query value in the bytes written, and the QC rows re-derive from the persisted verdict", async (t) => {
  const { finalizeQaRun } = await nodeHooks();
  const { redactPersisted } = await privacy();
  const { trackingQaAssertion } = await tracking();
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const { observation, seeds } = await liveAttempt();
  const built = [...(await rowsOf(observation)).values()];
  const qcResults = built.map(redactPersisted);
  const literal = `load ${ORIGIN}/x/?k=${PRIVATE}`;
  const encoded = `load /x/%253Fk%253D${PRIVATE}`;
  const assertions = [
    ...qcResults.map(trackingQaAssertion),
    {
      id: "syn-unprojected:checkout",
      family: "browser-test-order",
      page: "checkout",
      status: "warn",
      severity: "warn",
      expected: "synthetic",
      actual: literal,
      syn_unlisted_field: literal,
      evidence: { syn_unlisted_evidence: { [literal]: encoded, list: [encoded] } },
    },
  ];
  const testOrders = [{ path: "accept", syn_unlisted_field: encoded, [`note ${literal}`]: true }];
  const { args, resolved } = finalizeInputs([{ funnel_id: "syn_funnel", pages: [] }], withOutputDir(t));
  const result = await finalizeQaRun({ args, resolved, runId: QA_RUN_ID, startedAt: measuredAt, assertions, testOrders, qcResults });
  const bytes = readFileSync(result.local_path, "utf8");
  const persisted = JSON.parse(bytes);
  const unprojected = persisted.assertions.find((entry) => entry.id === "syn-unprojected:checkout");
  assert.equal(unprojected.syn_unlisted_field, `load ${ORIGIN}/x/${QUERY_MARKER}`, "the new key is persisted, cut at its query");
  assert.equal(persisted.test_orders[0].syn_unlisted_field, `load /x/${QUERY_MARKER}`);
  assert.equal(bytes.includes(PRIVATE), false);
  assert.equal(holdsPrivate(persisted), false, "no query value in any encoding");
  assertNothingPrivatePersisted(persisted, { markers: { private: PRIVATE } });
  assert.ok(Object.values(seeds).some((seed) => bytes.includes(seed)), "setup: the seed values are persisted as observed");
  const reread = readQaResults({
    stageEvidence: { qc_results: result.qc_results, qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: persisted,
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  assert.deepEqual(reread.map(resultOf), built.map(resultOf), "the rows re-derive through the 1.0 reader from the persisted verdict");
});

// ---------------------------------------------------------------------------
// Equality is between strings: a JSON value of any other type never equals
// its seed or literal

// The seeds liveAttempt's run generates (its random token is fixed).
async function liveSeeds(spec = null) {
  const { createTrackingSeedTable } = await tracking();
  return createTrackingSeedTable({ spec, random: () => Buffer.from([1, 2, 3, 4]) }).seeds;
}
const requestWith = (attribution) => JSON.stringify({ lines: [], attribution: { metadata: { syn_tag: "syn_v" }, ...attribution } });
const seededAttribution = (seeds) => Object.fromEntries(FIELDS.map((field) => [field, seeds[FIELD_PARAM[field] || field]]));

test("order attribution: a request field holding its seed inside an array, an object, or as a number or boolean differs from the seed, through capture and re-derivation", async () => {
  const seeds = await liveSeeds();
  const seed = seeds.utm_source;
  for (const value of [[seed], { 0: seed }, 12345, true]) {
    const label = JSON.stringify(value);
    const { observation } = await liveAttempt({ request: requestWith({ ...seededAttribution(seeds), utm_source: value }) });
    assert.deepEqual(observation.fields.filter((entry) => entry.field === "utm_source").map((entry) => [entry.source, entry.outcome]), [["request", "differs"]], `${label}: captured as differs`);
    const rows = await rowsOf(observation);
    const order = rows.get("tracking.order:checkout:order");
    assert.deepEqual(resultOf(order), ["warning", "order_attribution_differs"], `${label}: the order row`);
    assert.deepEqual(resultOf(order.members.find((entry) => entry.key === "utm_source")), ["warning", "order_attribution_differs"], `${label}: the utm_source member`);
    assert.deepEqual((await readRows([...rows.values()])).map(resultOf), [...rows.values()].map(resultOf), `${label}: the rows re-derive`);
  }
});

test("order attribution: a create response echoing its seed inside an array differs from the seed and is never a pass, through capture and re-derivation", async () => {
  const seeds = await liveSeeds();
  for (const value of [[seeds.utm_source], { 0: seeds.utm_source }, 12345]) {
    const label = JSON.stringify(value);
    const { observation } = await liveAttempt({ createBody: { ref_id: "synref1", attribution: { ...seededAttribution(seeds), utm_source: value } } });
    assert.deepEqual(observation.fields.filter((entry) => entry.field === "utm_source").map((entry) => [entry.source, entry.outcome]), [["request", "equal"], ["create_response", "differs"]], `${label}: captured as differs`);
    const rows = await rowsOf(observation);
    assert.deepEqual(resultOf(rows.get("tracking.order:checkout:order")), ["warning", "order_attribution_differs"], `${label}: the order row`);
    assert.deepEqual((await readRows([...rows.values()])).map(resultOf), [...rows.values()].map(resultOf), `${label}: the rows re-derive`);
  }
});

test("declared tags: request metadata holding the tag literal inside an array, an object or as a number differs from the literal (a warning, or a review with page-script involvement), never a pass, through capture and re-derivation", async () => {
  const seeds = await liveSeeds();
  for (const [value, inline, expected] of [
    [["syn_v"], false, ["warning", "tag_value_differs"]],
    [["syn_v"], true, ["review", "page_script_mapping"]],
    [{ 0: "syn_v" }, false, ["warning", "tag_value_differs"]],
    [7, false, ["warning", "tag_value_differs"]],
  ]) {
    const label = `${JSON.stringify(value)}, page script ${inline}`;
    const { observation } = await liveAttempt({
      page: pageAnswering({ ...TAG_READ, inline }),
      request: requestWith({ ...seededAttribution(seeds), metadata: { syn_tag: value } }),
    });
    assert.deepEqual(observation.names.filter((entry) => entry.tag_or_name === "syn_tag").map((entry) => entry.outcome), ["differs"], `${label}: captured as differs`);
    const rows = await rowsOf(observation);
    assert.deepEqual(resultOf(rows.get("tracking.tag:checkout:tag:syn_tag")), expected, `${label}: the tag row`);
    assert.deepEqual((await readRows([...rows.values()])).map(resultOf), [...rows.values()].map(resultOf), `${label}: the rows re-derive`);
  }
});

test("order attribution and declared tags: a request field or tag metadata value of null reads as missing, through capture and re-derivation", async () => {
  const seeds = await liveSeeds();
  const { observation } = await liveAttempt({ request: requestWith({ ...seededAttribution(seeds), utm_source: null }) });
  assert.deepEqual(observation.fields.filter((entry) => entry.field === "utm_source").map((entry) => [entry.source, entry.outcome]), [["request", "absent"]], "the field is captured as absent");
  const rows = await rowsOf(observation);
  const order = rows.get("tracking.order:checkout:order");
  assert.deepEqual(resultOf(order), ["warning", "order_attribution_missing"], "the order row");
  assert.deepEqual(resultOf(order.members.find((entry) => entry.key === "utm_source")), ["warning", "order_attribution_missing"], "the utm_source member");
  assert.deepEqual((await readRows([...rows.values()])).map(resultOf), [...rows.values()].map(resultOf), "the order rows re-derive");

  const tagged = await liveAttempt({
    page: pageAnswering({ ...TAG_READ, inline: false }),
    request: requestWith({ ...seededAttribution(seeds), metadata: { syn_tag: null } }),
  });
  assert.deepEqual(tagged.observation.names.filter((entry) => entry.tag_or_name === "syn_tag").map((entry) => entry.outcome), ["absent"], "the tag is captured as absent");
  const tagRows = await rowsOf(tagged.observation);
  assert.deepEqual(resultOf(tagRows.get("tracking.tag:checkout:tag:syn_tag")), ["warning", "tag_missing"], "the tag row");
  assert.deepEqual((await readRows([...tagRows.values()])).map(resultOf), [...tagRows.values()].map(resultOf), "the tag rows re-derive");
});

// ---------------------------------------------------------------------------
// A preserve name the persisted projection would change is not seeded

test("tracking.preserve: a name holding a query, encoded query, fragment, \"%\" or \"://\" is not seeded and is listed as not tested under its persisted form; the other rows pass and re-derive from their persisted form", async () => {
  const { redactPersisted } = await privacy();
  const { trackingQaAssertion, trackingSeedPlan } = await tracking();
  for (const [name, listed] of [
    ["oid?x", `oid${QUERY_MARKER}`],
    ["oid%3Fx", `oid${QUERY_MARKER}`],
    ["oid#x", "oid#x"],
    ["oid%41", "oid%41"],
    ["https://syn.example/oid", "https://syn.example/oid"],
  ]) {
    const spec = { analytics: { params: { tracking: { preserve: [name, "syn_name"] } } } };
    const { observation, seeds } = await liveAttempt({ spec });
    assert.deepEqual(Object.keys(seeds).sort(), [...URL_KEYS, "syn_name"].sort(), `${name}: only the other names are seeded`);
    assert.deepEqual(observation.preserve, [listed, "syn_name"], `${name}: the observation keeps the name's persisted form`);
    assert.deepEqual(trackingSeedPlan(observation.preserve).excluded, [listed], `${name}: the persisted form is excluded the same way`);
    const built = [...(await rowsOf(observation)).values()];
    assert.deepEqual(built.map(resultOf), [["pass", null], ["pass", null], ["pass", null]], `${name}: the rows read as before`);
    const url = built.find((row) => row.id === "tracking.url:checkout:url");
    const order = built.find((row) => row.id === "tracking.order:checkout:order");
    assert.deepEqual(resultOf(url.members.find((entry) => entry.key === listed)), ["excluded", "not_seeded_by_policy"], `${name}: listed as not tested on the URL row`);
    assert.deepEqual(resultOf(order.members.find((entry) => entry.key === listed)), ["excluded", "not_seeded_by_policy"], `${name}: listed as not tested on the order row`);
    const persisted = built.map(redactPersisted);
    assert.deepEqual(persisted, built, `${name}: the persisted rows equal the rows as built`);
    assert.deepEqual(built.map(trackingQaAssertion).map(redactPersisted), built.map(trackingQaAssertion), `${name}: and so do their qc.* assertions`);
    assert.deepEqual((await readRows(persisted)).map(resultOf), built.map(resultOf), `${name}: the persisted rows re-derive`);
  }
});

// ---------------------------------------------------------------------------
// The persisted projection keeps a URL's own text before its query

test("persisted text: an absolute URL keeps its own text up to its first \"?\" or \"#\" (host case, port and scheme as written), and a non-http URL is never turned into \"null\"", async () => {
  const { redactPersisted, redactUrlQueriesInText } = await privacy();
  for (const [text, kept] of [
    ["https://Shop.Example:443/a/b?x=1", `https://Shop.Example:443/a/b${QUERY_MARKER}`],
    ["https://Shop.Example:443/a/b#top", "https://Shop.Example:443/a/b"],
    ["https://Shop.Example:443/a/b", "https://Shop.Example:443/a/b"],
    ["see HTTPS://Shop.Example/A/B#top then", "see HTTPS://Shop.Example/A/B then"],
    ["x://#", "x://"],
    ["file:///p?q", `file:///p${QUERY_MARKER}`],
    ["file:///p#q", "file:///p"],
    ["blob://Syn.Example/A", "blob://Syn.Example/A"],
  ]) {
    assert.equal(redactUrlQueriesInText(text), kept, text);
    assert.deepEqual(redactPersisted({ [text]: [text] }), { [kept]: [kept] }, `${text}: as a key and a value`);
  }
});

// A synthetic "name:secret" userinfo, assembled at run time so the source
// never holds a literal credential-shaped URL.
const USER_PASS = ["user", "pass"].join(":");

test("persisted text: an absolute URL loses its userinfo, in free text and in object keys, and keeps the rest of its text as written, including an \"@\" in its path", async () => {
  const { redactPersisted, redactUrlQueriesInText } = await privacy();
  for (const [text, kept] of [
    [`https://${USER_PASS}@Shop.Example:8443/a?x=1`, `https://Shop.Example:8443/a${QUERY_MARKER}`],
    [`load failed: https://${USER_PASS}@Shop.Example:8443/a?x=1 (net)`, `load failed: https://Shop.Example:8443/a${QUERY_MARKER}`],
    [`error at https://${USER_PASS}@Shop.Example:8443/a#top (net)`, "error at https://Shop.Example:8443/a (net)"],
    ["https://user@host/p", "https://host/p"],
    ["https://user@host", "https://host"],
    ["https://a@b:c@host/p", "https://host/p"],
    ["https://host/p@q/r", "https://host/p@q/r"],
    ["https://user@host/p@q", "https://host/p@q"],
  ]) {
    assert.equal(redactUrlQueriesInText(text), kept, text);
    assert.deepEqual(redactPersisted({ [text]: [text], error: text }), { [kept]: [kept], error: kept }, `${text}: as a key and a value`);
  }
});

test("persisted text: a scheme-relative URL loses its userinfo in an assertion, an evidence key, a console entry and a test-order error, and keeps the rest of its text as written; a \"//\" inside a path is not a URL", async () => {
  const { redactPersisted, redactUrlQueriesInText } = await privacy();
  const { captureCheckoutEvents, sanitizedEvents, persistedTestOrder } = await browserHooks();
  for (const [text, kept] of [
    ["load //syn_user:syn_pass@Shop.Example:443/P#frag", "load //Shop.Example:443/P#frag"],
    ["//syn_user:syn_pass@Shop.Example:443/P#frag", "//Shop.Example:443/P#frag"],
    ["src=\"//syn_user:syn_pass@Shop.Example/P\" then", "src=\"//Shop.Example/P\" then"],
    ["url(//syn_user:syn_pass@Shop.Example/P) and src=//syn_user@Shop.Example", "url(//Shop.Example/P) and src=//Shop.Example"],
    ["<p>//syn_user:syn_pass@Shop.Example/P</p>", "<p>//Shop.Example/P</p>"],
    ["<//syn_user:syn_pass@Shop.Example/P>", "<//Shop.Example/P>"],
    ["load //syn_user:syn_pass@Shop.Example/P?k=1", `load //Shop.Example/P${QUERY_MARKER}`],
    ["load //Shop.Example/P#a@b", "load //Shop.Example/P#a@b"],
    ["see https://syn_user@Shop.Example/a then //syn_user:syn_pass@Shop.Example/b", "see https://Shop.Example/a then //Shop.Example/b"],
    ["/a//b@c", "/a//b@c"],
    ["load /a//b@c/d", "load /a//b@c/d"],
    ["https://Shop.Example/a//b@c", "https://Shop.Example/a//b@c"],
  ]) {
    assert.equal(redactUrlQueriesInText(text), kept, text);
    assert.equal(redactUrlQueriesInText(kept), kept, `${text}: its projection projects to itself`);
    const fake = navigationEventsPage();
    const events = captureCheckoutEvents(fake.page, null);
    fake.page.emit("console", { type: () => "error", text: () => text });
    await settle();
    const persistedEvents = sanitizedEvents(events);
    assert.equal(persistedEvents.console.at(-1).text, kept, `${text}: console entry`);
    const order = persistedTestOrder({ path: "accept", error: text, evidence: { steps: [{ step: "opened_checkout", label: text }], events: persistedEvents } });
    assert.equal(order.error, kept, `${text}: test-order error`);
    const assertion = redactPersisted({ id: "browser-test-order:checkout", family: "browser-test-order", actual: text, evidence: { labels: { [text]: true }, events: persistedEvents } });
    assert.equal(assertion.actual, kept, `${text}: assertion text`);
    assert.deepEqual(Object.keys(assertion.evidence.labels), [kept], `${text}: evidence key`);
    for (const value of [persistedEvents, order, assertion]) assert.equal(JSON.stringify(value).includes("syn_pass"), false, `${text}: no credential persisted`);
  }
});

test("verdict discovery: a persisted verdict whose assertion URLs carry the deploy URL with uppercase letters still scores the deploy match", async () => {
  const { redactPersisted } = await privacy();
  const { qaVerdictCandidateScore } = await import("./qa-verdict-discovery.mjs");
  const packet = { deploy: { preview_url: "https://Preview.Syn-Example.test:8443/Campaign" } };
  for (const url of ["https://Preview.Syn-Example.test:8443/Campaign/checkout/", "https://Preview.Syn-Example.test:8443/Campaign/checkout/?k=1#top"]) {
    const verdict = redactPersisted({ schema_version: "1.0", assertions: [{ id: "syn:checkout", url }] });
    assert.ok(verdict.assertions[0].url.startsWith(packet.deploy.preview_url), `${url}: kept as written before its query`);
    assert.equal(qaVerdictCandidateScore({ verdict }, packet) - qaVerdictCandidateScore({ verdict }, {}), 25, `${url}: the deploy match scores`);
  }
});

// ---------------------------------------------------------------------------
// The persisted projection ends on any input

test("persisted values: a toJSON returning its own input, a toJSON returning a value holding its input, a self-referencing object or array, and a 10,000-deep object all project without throwing; toJSON is called once per value", async () => {
  const { redactPersisted, CIRCULAR, TOO_DEEP } = await privacy();
  let calls = 0;
  const own = { note: `load /x/?k=${PRIVATE}` };
  own.toJSON = function toJSON() {
    calls += 1;
    return this;
  };
  const projected = redactPersisted({ own });
  assert.equal(calls, 1, "toJSON returning its input is called once");
  assert.equal(projected.own.note, `load /x/${QUERY_MARKER}`);

  calls = 0;
  const wrapping = {
    toJSON() {
      calls += 1;
      return { inner: this, note: `load /x/?k=${PRIVATE}` };
    },
  };
  assert.deepEqual(redactPersisted(wrapping), { inner: CIRCULAR, note: `load /x/${QUERY_MARKER}` });
  assert.equal(calls, 1, "toJSON returning a value that holds its input is called once");

  const self = { name: "syn" };
  self.self = self;
  self.list = [self];
  assert.deepEqual(redactPersisted(self), { name: "syn", self: CIRCULAR, list: [CIRCULAR] });
  const shared = { name: "syn" };
  assert.deepEqual(redactPersisted({ a: shared, b: shared }), { a: { name: "syn" }, b: { name: "syn" } }, "a value held twice, not inside itself, is projected both times");

  let deep = { leaf: `load /x/?k=${PRIVATE}` };
  for (let level = 0; level < 10_000; level += 1) deep = { next: deep };
  const bounded = redactPersisted(deep);
  const text = JSON.stringify(bounded);
  assert.ok(text.includes(JSON.stringify(TOO_DEEP)), "the nesting past the bound is the marker");
  assert.equal(text.includes(PRIVATE), false);
  assert.equal(typeof TOO_DEEP, "string");
  assert.equal(typeof CIRCULAR, "string");
});

// ---------------------------------------------------------------------------
// One persisted projection for assertions and QC rows

test("persisted QC rows: the browser runner has one projection for assertions and QC rows, and the QC rows a run returns stay identical to the qc.* assertions of the verdict it writes", async (t) => {
  const hooks = await browserHooks();
  assert.equal(Object.hasOwn(hooks, "persistedAssertion") || Object.hasOwn(hooks, "persistedQcResult"), false, "no second projection helper");
  const { redactPersisted } = await privacy();
  const { finalizeQaRun } = await nodeHooks();
  const { trackingQaAssertion } = await tracking();
  const spec = { analytics: { params: { tracking: { preserve: ["oid?x", "syn_name"] } } } };
  const { observation } = await liveAttempt({ spec, page: pageAnswering({ tags: [{ name: "syn_tag", value: "syn_v" }, { name: "syn_tag%3Fk%3D1", value: "syn_v" }], inline: false, pins: [] }) });
  const built = [...(await rowsOf(observation)).values()];
  const qcResults = built.map(redactPersisted);
  const { args, resolved } = finalizeInputs([{ funnel_id: "syn_funnel", pages: [] }], withOutputDir(t));
  const result = await finalizeQaRun({ args, resolved, runId: QA_RUN_ID, startedAt: measuredAt, assertions: qcResults.map(trackingQaAssertion), testOrders: [], qcResults });
  const persisted = JSON.parse(readFileSync(result.local_path, "utf8"));
  const byResult = new Map(persisted.assertions.filter((entry) => entry.id.startsWith("qc.")).map((entry) => [entry.evidence.qc.result_id, entry]));
  assert.equal(byResult.size, result.qc_results.length, "one qc.* assertion per row");
  for (const row of result.qc_results) {
    const assertion = byResult.get(row.id);
    assert.ok(assertion, `${row.id}: has its qc.* assertion`);
    assert.deepEqual(assertion.evidence.qc, trackingQaAssertion(row).evidence.qc, `${row.id}: its qc.* evidence is the row's`);
    assert.deepEqual(assertion.evidence.qc.observation, row.observation, `${row.id}: the same observation`);
  }
});
