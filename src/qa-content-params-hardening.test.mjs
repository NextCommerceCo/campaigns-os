// Content parameter check hardening, in node.
//
// Stored observations whose counts, targets and references do not reconcile
// never pass, through the module's re-derivation or the 1.0 QA reader with
// the real module from the registry. A review reference at a target's
// attribute and path is its own member, so the row never passes. The browser
// driver, run against a fake page and a fake protocol session, reads the
// document only through the isolated world: the page's own world answers
// with a spoofed reading that is never used. It uses a reading only from the
// document it asked for, never opens a context once the budget is spent, and
// reads a variant with fewer targets than the baseline as a count change.
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test.
import { assertExactMembers, assertLoopbackOnly, installNodeGuard } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard({ transports: false });
const { BUILD_FP, QA_RUN_ID, assertNoNetworkAttempts, fullVerdict, sha256 } = await import("./qc-test-factories.mjs");

afterEach(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});
after(() => {
  assertNoNetworkAttempts();
  assertLoopbackOnly();
});

const NAME = "reviews";
const PAGE = "index";
const ID = "content_param:index:reviews";
const ASSERTION_ID = "qc.content_param:reviews:index";
const E = "evidence_not_reproducible";
const EXPRESSION = "param.reviews";
const SECOND_EXPRESSION = "param.reviews == 'n'";
const UNSUPPORTED_EXPRESSION = "param.reviews || param.x";
const PATH_0 = "body>main[0]>section[0]";
const PATH_1 = "body>main[0]>section[1]";
const VISIBLE = Object.freeze({ present: true, visible: true, stable: true });
const HIDDEN = Object.freeze({ present: true, visible: false, stable: true });
const measuredAt = new Date(Date.now() - 60_000).toISOString();

const reference = (expression, form, elementPath) => ({ attr: "hide", expr_sha256: sha256(expression), form, prediction: "hidden", ...(elementPath ? { element_path: elementPath } : {}) });
const target = (expression, elementPath) => ({ attr: "hide", expr_sha256: sha256(expression), element_path: elementPath, baseline: { ...VISIBLE }, param_n: { ...HIDDEN } });
const observation = ({ references, targets, counts }) => ({ param: NAME, page: PAGE, readiness: { baseline: "ready", param_n: "ready" }, references, targets, counts });

// One target, visible at baseline and hidden with ?reviews=n: a pass.
const onePass = (counts = { baseline: 1, param_n: 1 }) => observation({ references: [reference(EXPRESSION, "presence")], targets: [target(EXPRESSION, PATH_0)], counts });
// Two targets, both visible at baseline and hidden with ?reviews=n: a pass.
const twoPass = () => observation({
  references: [reference(EXPRESSION, "presence", PATH_0), reference(SECOND_EXPRESSION, "equals", PATH_1)],
  targets: [target(EXPRESSION, PATH_0), target(SECOND_EXPRESSION, PATH_1)],
  counts: { baseline: 2, param_n: 2 },
});

async function storedRow(derived, observationValue) {
  const { buildQcResult } = await import("./qc-results.mjs");
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

// The 1.0 QA reader over one stored row and its verdict assertion, with the
// real module from the registry.
async function readRow(row) {
  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults, toQaAssertion } = await import("./qc-results.mjs");
  const results = readQaResults({
    stageEvidence: { qc_results: [row], qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: [{ ...toQaAssertion(row, { family: "browser-runtime" }), id: ASSERTION_ID }], measuredAt }),
    currentBuild: BUILD_FP,
    rederivers: await loadQcRederivers(),
  });
  assert.deepEqual(results.map((entry) => entry.id), [ID], "the reader lists exactly the stored id");
  return results[0];
}

// A stored row claiming pass for `incomplete`, built from the pass derived
// for its complete twin with the incomplete observation's counts, targets and
// members in the claimed state.
async function claimedPassRow(twin, incomplete, { keep = () => true } = {}) {
  const { rederiveQcResult } = await import("./qa-content-params.mjs");
  const derived = rederiveQcResult(twin);
  assert.equal(derived?.result, "pass", "setup: the complete twin passes");
  const claimed = {
    ...derived,
    members: derived.members.filter((member) => keep(member.key)),
    state: { ...derived.state, counts: { ...incomplete.counts }, targets: derived.state.targets.filter((entry) => keep(`${entry.attr}:${entry.element_path}`)) },
  };
  return storedRow(claimed, incomplete);
}

async function assertNeverPasses(twin, incomplete, options) {
  const { contentParamQcRow, rederiveQcResult } = await import("./qa-content-params.mjs");
  const derived = rederiveQcResult(incomplete);
  assert.notEqual(derived?.result ?? null, "pass", "re-derivation never passes the incomplete observation");
  assert.notEqual(contentParamQcRow(incomplete, { measuredAt })?.result ?? null, "pass", "the producer's row never passes it");
  const read = await readRow(await claimedPassRow(twin, incomplete, options));
  assert.deepEqual([read.result, read.reason_code], ["unexercised", E], "the QA reader reads the stored pass claim as not reproducible");
}

// ---------------------------------------------------------------------------
// Counts, targets and references reconcile

test("counts 0/0 with one target listed present in both contexts: never pass", async () => {
  await assertNeverPasses(onePass(), onePass({ baseline: 0, param_n: 0 }));
});

test("counts 2/2 with one target listed: never pass", async () => {
  await assertNeverPasses(onePass(), onePass({ baseline: 2, param_n: 2 }));
});

test("a second declared target reference with its target omitted from the list (counts 1/1): never pass", async () => {
  const incomplete = twoPass();
  incomplete.targets = incomplete.targets.slice(0, 1);
  incomplete.counts = { baseline: 1, param_n: 1 };
  await assertNeverPasses(twoPass(), incomplete, { keep: (key) => key === `hide:${PATH_0}` });
});

test("a second declared target reference with its target omitted from the list (counts 2/2): never pass", async () => {
  const incomplete = twoPass();
  incomplete.targets = incomplete.targets.slice(0, 1);
  await assertNeverPasses(twoPass(), incomplete, { keep: (key) => key === `hide:${PATH_0}` });
});

test("a target whose reference names another element: never pass", async () => {
  const incomplete = onePass();
  incomplete.references = [reference(EXPRESSION, "presence", PATH_1)];
  await assertNeverPasses(onePass(), incomplete);
});

// ---------------------------------------------------------------------------
// Members

function sharedKeyObservation() {
  return observation({
    references: [reference(EXPRESSION, "presence", PATH_0), { attr: "hide", expr_sha256: sha256(UNSUPPORTED_EXPRESSION), form: "unsupported", prediction: "unknown", element_path: PATH_0, both_attributes: false, mixed_cart: false }],
    targets: [target(EXPRESSION, PATH_0)],
    counts: { baseline: 1, param_n: 1 },
  });
}

test("a passing target plus an unsupported reference at the same attribute and path: review (unsupported_expression), both members listed", async () => {
  const { contentParamQcRow, rederiveQcResult } = await import("./qa-content-params.mjs");
  const members = { [`hide:${PATH_0}`]: ["pass", null], [`hide:${PATH_0}:review`]: ["review", "unsupported_expression"] };
  const derived = rederiveQcResult(sharedKeyObservation());
  assert.deepEqual([derived?.result, derived?.reason_code, derived?.accept_eligible], ["review", "unsupported_expression", false], "re-derivation reads review");
  assertExactMembers({ id: ID, members: derived.members }, members);

  const read = await readRow(contentParamQcRow(sharedKeyObservation(), { measuredAt }));
  assert.deepEqual([read.result, read.reason_code, read.accept_eligible], ["review", "unsupported_expression", false], "the QA reader reads the producer's row as review");
  assertExactMembers(read, members);

  // A stored row claiming pass on that observation (the review reference
  // folded into the target's member) is not reproduced.
  const claimed = await storedRow({
    ...derived,
    result: "pass",
    reason_code: null,
    members: [{ key: `hide:${PATH_0}`, result: "pass", reason_code: null }],
    accept_eligible: false,
    state: { ...derived.state, reason_code: null },
  }, sharedKeyObservation());
  const claimedRead = await readRow(claimed);
  assert.deepEqual([claimedRead.result, claimedRead.reason_code], ["unexercised", E], "the stored pass claim reads as not reproducible");
});

// ---------------------------------------------------------------------------
// The browser driver against a fake page and protocol session

const BASE = "http://127.0.0.1/synthetic/";
const SPEC = Object.freeze({ analytics: { params: { content: [{ name: NAME }] } } });
const TOPOLOGIES = Object.freeze([{ funnel_id: "default", pages: [{ page_id: PAGE, url: BASE }] }]);
const ISOLATED_CONTEXT = 41;
const withQueryParam = (url, key, value) => {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
};

// One fake browser. `pageWorld(variant)` is what the page's own world would
// report for the one hide section (a spoof); `isolated(variant)` is the
// isolated world's reading, which carries the URL the document was loaded at:
// the requested URL, or `landAt(url, variant)` when that returns one (a
// redirect or a page that replaced itself). `onGoto(url, variant)` runs on
// each navigation. Every call is logged.
function fakeBrowser({ pageWorld = () => ({ visible: true, stable: true }), isolated, landAt = () => null, onGoto = () => {} }) {
  const log = [];
  const newContext = async () => {
    log.push(["browser", "newContext"]);
    let variant = null;
    let loaded = null;
    const pageCall = (method) => {
      log.push(["page", method]);
    };
    const described = () => [{ hide: EXPRESSION, show: null, path: PATH_0 }];
    const handle = {
      evaluateHandle: async () => {
        pageCall("handle.evaluateHandle");
        return {};
      },
      evaluate: async () => {
        pageCall("handle.evaluate");
        return described();
      },
    };
    const page = {
      goto: async (url) => {
        variant = new URL(url).searchParams.get(NAME) === "n" ? "param_n" : "baseline";
        log.push(["page", "goto", variant, url]);
        onGoto(url, variant);
        loaded = landAt(url, variant) ?? url;
        return { status: () => 200 };
      },
      waitForFunction: async () => pageCall("waitForFunction"),
      evaluateHandle: async () => {
        pageCall("evaluateHandle");
        return handle;
      },
      evaluate: async () => {
        pageCall("evaluate");
        return [pageWorld(variant)];
      },
    };
    const session = {
      send: async (method, params = {}) => {
        log.push(["cdp", method, method === "Runtime.evaluate" ? params.contextId : params.worldName ?? null]);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
        if (method === "Page.createIsolatedWorld") {
          assert.equal(params.frameId, "main-frame", "the isolated world is created for the main frame");
          return { executionContextId: ISOLATED_CONTEXT };
        }
        if (method === "Runtime.evaluate") {
          if (params.contextId !== ISOLATED_CONTEXT) return { result: { value: { ready: true, elements: [{ hide: EXPRESSION, show: null, path: PATH_0, ...pageWorld(variant) }] } } };
          return { result: { value: { url: loaded, ...isolated(variant) } } };
        }
        return {};
      },
    };
    return {
      newPage: async () => page,
      newCDPSession: async (forPage) => {
        assert.equal(forPage, page, "the session is opened on the check's page");
        log.push(["context", "newCDPSession"]);
        return session;
      },
      close: async () => log.push(["context", "close"]),
    };
  };
  return { newContext, log };
}

async function runFake(browser) {
  const { runContentParamChecks } = await import("./qa-content-params.mjs");
  const { rows } = await runContentParamChecks({ topologies: TOPOLOGIES, spec: SPEC, newContext: browser.newContext, withQueryParam, measuredAt });
  assert.deepEqual(rows.map((row) => row.id), [ID], "one content_param row");
  return rows[0];
}

const reading = (visible, extra = {}) => ({ ready: true, elements: [{ hide: EXPRESSION, show: null, path: PATH_0, stable: true, visible, ...extra }] });

test("driver: the page world reports the target hidden with ?reviews=n, the isolated world reads it visible: warning (target_still_visible), no page-world read", async () => {
  const browser = fakeBrowser({
    pageWorld: (variant) => ({ visible: variant === "baseline", stable: true }),
    isolated: () => reading(true),
  });
  const row = await runFake(browser);
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], ["warning", "target_still_visible", true], "the row reads the isolated world");
  assertExactMembers(row, { [`hide:${PATH_0}`]: ["warning", "target_still_visible"] });
  assert.deepEqual(browser.log.filter(([kind]) => kind === "page").map(([, method]) => method), ["goto", "goto"], "the page's own world is never evaluated in");
  const reads = browser.log.filter(([kind, method]) => kind === "cdp" && method === "Runtime.evaluate");
  assert.deepEqual(reads.map(([, , contextId]) => contextId), [ISOLATED_CONTEXT, ISOLATED_CONTEXT], "every read runs in the isolated world");
  // Per load: the reader goes in before navigation, then the main frame's
  // isolated world is read.
  const perLoad = browser.log.map((entry) => entry.slice(0, 2).join(" "));
  const load = ["browser newContext", "context newCDPSession", "cdp Page.enable", "cdp Page.addScriptToEvaluateOnNewDocument", "page goto", "cdp Page.getFrameTree", "cdp Page.createIsolatedWorld", "cdp Runtime.evaluate", "context close"];
  assert.deepEqual(perLoad, [...load, ...load], "each load installs the reader before navigating and reads after");
  assert.deepEqual(browser.log.filter(([, method]) => method === "Page.addScriptToEvaluateOnNewDocument" || method === "Page.createIsolatedWorld").map(([, , world]) => world), Array(4).fill("campaigns-os-content-params"), "the installed reader and the read share one named world");
});

test("driver: an isolated-world reading without a stable flag: unexercised (readiness_timeout), never pass", async () => {
  const browser = fakeBrowser({
    pageWorld: (variant) => ({ visible: variant === "baseline", stable: true }),
    isolated: (variant) => (variant === "baseline" ? reading(true) : { ready: true, elements: [{ hide: EXPRESSION, show: null, path: PATH_0, visible: false }] }),
  });
  const row = await runFake(browser);
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "readiness_timeout"], "an incomplete reading is no ready state");
});

test("driver: the isolated world never sees the readiness signal: unexercised (readiness_timeout), even when the page world reports ready", async () => {
  const browser = fakeBrowser({
    pageWorld: (variant) => ({ visible: variant === "baseline", stable: true }),
    isolated: () => ({ ready: false, elements: [] }),
  });
  const row = await runFake(browser);
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "readiness_timeout"], "readiness is the isolated world's");
});

test("driver: a target the isolated world reads as replaced (stable false) with ?reviews=n: review (target_identity_unresolved)", async () => {
  const browser = fakeBrowser({
    pageWorld: (variant) => ({ visible: variant === "baseline", stable: true }),
    isolated: (variant) => (variant === "baseline" ? reading(true) : reading(false, { stable: false })),
  });
  const row = await runFake(browser);
  assert.deepEqual([row.result, row.reason_code], ["review", "target_identity_unresolved"], "the replaced target is unresolved");
  assertExactMembers(row, { [`hide:${PATH_0}`]: ["review", "target_identity_unresolved"] });
});

test("driver: an element with data-next-hide and an empty data-next-show, hidden with ?reviews=n: review (show_overrides_hide), never pass", async () => {
  const browser = fakeBrowser({
    pageWorld: (variant) => ({ visible: variant === "baseline", stable: true }),
    isolated: (variant) => ({ ready: true, elements: [{ hide: EXPRESSION, show: "", path: PATH_0, stable: true, visible: variant === "baseline" }] }),
  });
  const row = await runFake(browser);
  assert.notEqual(row.result, "pass", "an element carrying both attributes never passes");
  assert.deepEqual([row.result, row.reason_code], ["review", "show_overrides_hide"], "both attributes present, one of them empty");
});

// ---------------------------------------------------------------------------
// The document read is the one requested

// The working toggle: the section is visible at baseline and hidden with
// ?reviews=n wherever it is read.
const toggled = (variant) => reading(variant === "baseline");
const NOT_SERVED = Object.freeze({ baseline: "ready", param_n: "page_not_served" });

async function assertNotServed(landAt, readiness = NOT_SERVED) {
  const row = await runFake(fakeBrowser({ isolated: toggled, landAt }));
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], ["unexercised", "page_not_served", false], "a reading from another document is no reading of the requested page");
  assert.deepEqual(row.observation.readiness, readiness, "the load that did not end on the requested document reads page_not_served");
  assert.deepEqual(row.observation.counts, { baseline: null, param_n: null }, "nothing is counted");
  assertExactMembers(row, {});
}

test("driver: the ?reviews=n load lands on the same path without the parameter: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? BASE : null));
});

test("driver: the ?reviews=n load lands on another path, carrying ?reviews=n: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? `http://127.0.0.1/elsewhere/?${NAME}=n` : null));
});

test("driver: the ?reviews=n load lands on another origin with the same path and query: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? url.replace("127.0.0.1", "127.0.0.2") : null));
});

test("driver: the ?reviews=n page replaced itself with another path before it was read: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? "http://127.0.0.1/elsewhere/" : null));
});

test("driver: the ?reviews=n load lands on ?reviews=n&reviews=y: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? `${url}&${NAME}=y` : null));
});

test("driver: the ?reviews=n load lands on ?reviews=y: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "param_n" ? url.replace(`${NAME}=n`, `${NAME}=y`) : null));
});

test("driver: the baseline load lands on ?reviews=n: unexercised (page_not_served), never pass", async () => {
  await assertNotServed((url, variant) => (variant === "baseline" ? `${url}?${NAME}=n` : null), { baseline: "page_not_served", param_n: "ready" });
});

test("driver: a reading that carries no document URL: unexercised (page_not_served), never pass", async () => {
  const row = await runFake(fakeBrowser({ isolated: (variant) => ({ ...toggled(variant), url: undefined }) }));
  assert.deepEqual([row.result, row.reason_code], ["unexercised", "page_not_served"], "a reading that cannot name its document is not the requested page");
});

test("driver: the ?reviews=n load lands on the requested path with ?reviews=n, another parameter and a fragment: pass", async () => {
  const row = await runFake(fakeBrowser({ isolated: toggled, landAt: (url, variant) => (variant === "param_n" ? `${url}&syn=1#frag` : null) }));
  assert.deepEqual([row.result, row.reason_code], ["pass", null], "the requested document, with more query, is the requested page");
  assertExactMembers(row, { [`hide:${PATH_0}`]: ["pass", null] });
});

test("driver: neither load ends on the requested document and neither signals readiness: unexercised (page_not_served)", async () => {
  const row = await runFake(fakeBrowser({ isolated: () => ({ ready: false, elements: [] }), landAt: () => "http://127.0.0.1/elsewhere/" }));
  assert.deepEqual(row.observation.readiness, { baseline: "page_not_served", param_n: "page_not_served" }, "the document is checked before readiness");
});

// ---------------------------------------------------------------------------
// Counts and budget

test("driver: the ?reviews=n context has no matching target where the baseline has one: review (target_count_changed)", async () => {
  const row = await runFake(fakeBrowser({ isolated: (variant) => (variant === "baseline" ? reading(true) : { ready: true, elements: [] }) }));
  assert.deepEqual([row.result, row.reason_code, row.accept_eligible], ["review", "target_count_changed", false], "fewer targets with ?reviews=n is a count change");
  assert.deepEqual(row.observation.counts, { baseline: 1, param_n: 0 }, "one target at baseline, none with ?reviews=n");
  assertExactMembers(row, {});
});

test("driver: once the 60 s budget is spent no later pair opens a context: the later pair reads unexercised (budget_exhausted)", async () => {
  const { runContentParamChecks } = await import("./qa-content-params.mjs");
  const second = "second";
  let clock = 1_000_000;
  // The first pair's ?reviews=n navigation uses up the whole budget.
  const browser = fakeBrowser({ isolated: toggled, onGoto: (url, variant) => {
    if (variant === "param_n") clock += 60_000;
  } });
  const topologies = [{ funnel_id: "default", pages: [{ page_id: PAGE, url: BASE }, { page_id: second, url: "http://127.0.0.1/synthetic-second/" }] }];
  const { rows } = await runContentParamChecks({ topologies, spec: SPEC, newContext: browser.newContext, withQueryParam, now: () => clock, measuredAt });
  assert.deepEqual(rows.map((row) => [row.id, row.result, row.reason_code]), [
    [ID, "pass", null],
    [`content_param:${second}:${NAME}`, "unexercised", "budget_exhausted"],
  ], "the first pair is measured, the second is cut");
  assert.equal(browser.log.filter(([kind, method]) => kind === "browser" && method === "newContext").length, 2, "only the first pair's two contexts are opened");
  assert.deepEqual(browser.log.filter(([, method]) => method === "goto").map(([, , variant, url]) => [variant, url]), [["baseline", BASE], ["param_n", `${BASE}?${NAME}=n`]], "no load of the second page starts");
});
