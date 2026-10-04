// Tracking parameters (1.1): regression rows for the observer and its rules,
// beside the frozen fixture rows in qa-tracking-params.test.mjs. Each group
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
  const navigate = (url) => {
    observer.onNavigationRequest(url);
    observer.onFrameNavigated(url);
  };
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
  const { persistedTestOrder, persistedAssertion } = await browserHooks();
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
  assertNothingPrivatePersisted(persistedAssertion(assertion), { markers: { private: PRIVATE } });
  const qc = { id: "qc.tracking.url:checkout:url", evidence: { qc: { observation: { hops: [] } } } };
  assert.equal(persistedAssertion(qc), qc, "a qc.* assertion is left exactly as built");
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
  observer.onNavigationRequest(`${ORIGIN}/x/upsell/`);
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
  assert.ok(uses >= 15, `the observer's uses are visited (${uses})`);
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
