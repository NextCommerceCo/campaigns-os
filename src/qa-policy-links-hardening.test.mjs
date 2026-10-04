// Policy links (contract §1.4): time bounds, partial anchor reads and URL
// identity, in node. Nothing here reaches a network or a browser: anchors are
// read through a fake CDP session whose Runtime.evaluate runs the reader's
// expression against a fake DOM in a vm context, availability probes call an
// injected fetchImpl, and every deadline runs on an injected virtual clock, so
// the timings are exact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";
import vm from "node:vm";

import {
  createPolicyLinkBudget,
  policyLinkNotRequestedRows,
  policyLinkQaAssertion,
  probePolicyUrl,
  readPageAnchors,
  rederiveQcResult,
  runPolicyLinkChecks,
} from "./qa-policy-links.mjs";
import { redactPersisted } from "./qa-url-privacy.mjs";
import { loadQcRederivers } from "./qc-check-registry.mjs";
import { buildQcResult, readQaResults } from "./qc-results.mjs";

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const measuredAt = "2026-01-01T00:00:00.000Z";

// Every request goes through the injected fetch; the global one refuses.
const globalFetch = globalThis.fetch;
const refusedGlobalFetches = [];
globalThis.fetch = async (input) => {
  refusedGlobalFetches.push(String(input));
  throw new TypeError("policy link hardening tests: the global fetch is not used");
};
afterEach(() => {
  assert.deepEqual(refusedGlobalFetches.splice(0), [], "only the injected fetch was called");
});
test.after(() => {
  globalThis.fetch = globalFetch;
});

// ---------------------------------------------------------------------------
// Virtual clock

// A clock whose time moves only when every pending promise has settled and a
// timer is due: run(operation) settles the operation's microtasks, then jumps
// to the next timer, until the operation settles.
function virtualClock() {
  let time = 0;
  let order = 0;
  const timers = [];
  const clock = {
    now: () => time,
    setTimer: (callback, ms) => {
      const timer = { at: time + Math.max(0, Number(ms) || 0), order: order++, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    sleep: (ms) => new Promise((resolve) => clock.setTimer(resolve, ms)),
    async run(operation) {
      let settled = false;
      const result = Promise.resolve().then(operation);
      result.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        if (settled) break;
        if (!timers.length) {
          // Nothing on this clock is due: the operation waits on something
          // else, which the test's own timeout bounds.
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        timers.sort((a, b) => a.at - b.at || a.order - b.order);
        const next = timers.shift();
        time = Math.max(time, next.at);
        next.callback();
      }
      return result;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------
// Fake CDP and DOM

// A browser context whose CDP sessions read `anchors` ({href, text}) from a
// fake document at `baseURI`, or never answer Runtime.evaluate when `stall`.
function fakeContext({ anchors = [], baseURI = "https://store.example.invalid/", stall = false } = {}) {
  const opened = [];
  const context = {
    opened,
    async newCDPSession() {
      const session = {
        detached: false,
        async send(method, params) {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          if (method !== "Runtime.evaluate") throw new Error(`unexpected CDP method ${method}`);
          if (stall) return new Promise(() => {});
          const document = {
            baseURI,
            querySelectorAll(selector) {
              assert.equal(selector, "a[href]");
              return anchors.map(({ href, text }) => ({ href: new URL(href, baseURI).href, textContent: text, getAttribute: () => href }));
            },
          };
          const value = vm.runInContext(params.expression, vm.createContext({ document, URL }));
          // returnByValue: the value as JSON.
          return { result: { value: JSON.parse(JSON.stringify(value)) } };
        },
        async detach() {
          session.detached = true;
        },
      };
      opened.push(session);
      return session;
    },
  };
  return context;
}

// ---------------------------------------------------------------------------
// Injected fetch

// routes: (url) => { status, location?, type?, delayMs?, stallCancel? } or
// undefined (refused). Every call is recorded with the clock time it began.
function fakeFetch(clock, routes, calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, redirect: init.redirect, at: clock.now() });
    const answer = routes(String(url));
    if (!answer) throw new TypeError(`policy link hardening tests: no route for ${url}`);
    if (answer.delayMs) await clock.sleep(answer.delayMs);
    const headers = new Headers({ "content-type": answer.type ?? "text/html; charset=utf-8" });
    if (answer.location) headers.set("location", answer.location);
    return {
      status: answer.status,
      headers,
      body: { cancel: () => (answer.stallCancel ? new Promise(() => {}) : Promise.resolve()) },
    };
  };
}

const TERMS = "https://store.example.invalid/terms";
const htmlAt = (target) => (url) => (url === target ? { status: 200 } : undefined);

const rowsById = (rows) => new Map(rows.map((row) => [row.id, row]));
function assertRow(rows, id, result, reasonCode) {
  const row = rowsById(rows).get(id);
  assert.ok(row, `${id} is listed`);
  assert.deepEqual([row.result, row.reason_code], [result, reasonCode], `${id} reads ${result} / ${reasonCode}`);
  const rederived = rederiveQcResult(row.observation);
  assert.ok(rederived, `${id} re-derives from its stored observation`);
  assert.deepEqual([rederived.result, rederived.reason_code], [result, reasonCode], `${id} re-derives to ${result} / ${reasonCode}`);
  return row;
}

const availabilityObservation = (block, { field = "store_terms", scheme = "https" } = {}) => ({
  check: "policy.availability",
  field,
  configured: block.chain[0]?.url ?? null,
  configured_query_sha256: block.chain[0]?.query_sha256 ?? null,
  scheme,
  availability: block,
});

// ---------------------------------------------------------------------------
// Run budget

test("policy links: two stalled anchor reads and a slow redirect chain end within the 20 s run budget, and what did not finish reads unexercised", { timeout: 30_000 }, async () => {
  const clock = virtualClock();
  const spec = { campaign: { store_terms: TERMS } };
  const calls = [];
  const routes = (url) => {
    const step = /\/terms(?:\/(\d))?$/.exec(new URL(url).pathname);
    if (!step) return undefined;
    const index = Number(step[1] ?? 0);
    return index < 4 ? { status: 302, location: `/terms/${index + 1}`, delayMs: 4_000 } : { status: 200, delayMs: 4_000 };
  };
  const context = fakeContext({ stall: true });
  const { rows, elapsed } = await clock.run(async () => {
    const started = clock.now();
    const budget = createPolicyLinkBudget({ clock });
    const pages = [];
    for (let visit = 0; visit < 2; visit += 1) {
      const anchors = await readPageAnchors(context, {}, { spec, budget });
      pages.push(anchors ? { read: true, anchors } : { read: false, anchors: null });
    }
    const result = await runPolicyLinkChecks({ spec, pages, fetchImpl: fakeFetch(clock, routes, calls), measuredAt, budget });
    return { rows: result.rows, elapsed: clock.now() - started };
  });
  assert.ok(elapsed <= 20_000, `the policy link checks added ${elapsed} ms, at most 20,000`);
  assert.equal(context.opened.length, 2, "both anchor reads started");
  // The reads take 5 s each; the probe gets the 10 s left: requests at 10, 14
  // and 18 s, the third cut at 20 s.
  assert.deepEqual(calls.map(({ at }) => at), [10_000, 14_000, 18_000], "no request starts once the budget is spent");
  assertRow(rows, "policy.presence:campaign:store_terms", "unexercised", "pages_not_read");
  const availability = assertRow(rows, "policy.availability:campaign:store_terms", "unexercised", "network_unavailable");
  assert.deepEqual(availability.observation.availability.chain.map(({ status }) => status), [302, 302]);
});

test("policy links: once the run budget is spent, no anchor read opens a session and no probe sends a request", { timeout: 30_000 }, async () => {
  const clock = virtualClock();
  const spec = { campaign: { store_terms: TERMS } };
  const calls = [];
  const stalled = fakeContext({ stall: true });
  const answering = fakeContext({ anchors: [{ href: TERMS, text: "Terms" }] });
  const { rows, elapsed, lastRead } = await clock.run(async () => {
    const started = clock.now();
    const budget = createPolicyLinkBudget({ clock });
    const pages = [];
    for (let visit = 0; visit < 4; visit += 1) {
      const anchors = await readPageAnchors(stalled, {}, { spec, budget });
      pages.push(anchors ? { read: true, anchors } : { read: false, anchors: null });
    }
    const anchors = await readPageAnchors(answering, {}, { spec, budget });
    pages.push(anchors ? { read: true, anchors } : { read: false, anchors: null });
    const result = await runPolicyLinkChecks({ spec, pages, fetchImpl: fakeFetch(clock, htmlAt(TERMS), calls), measuredAt, budget });
    return { rows: result.rows, elapsed: clock.now() - started, lastRead: anchors };
  });
  assert.equal(elapsed, 20_000, "four 5 s reads spend the 20 s budget");
  assert.equal(lastRead, null, "the fifth read is not made");
  assert.equal(answering.opened.length, 0, "the fifth read opened no CDP session");
  assert.deepEqual(calls, [], "the probe sent no request");
  assertRow(rows, "policy.presence:campaign:store_terms", "unexercised", "pages_not_read");
  assertRow(rows, "policy.availability:campaign:store_terms", "unexercised", "network_unavailable");
});

test("policy links: the run budget charges the anchor reads and the probes, not the page visits between them", async () => {
  const clock = virtualClock();
  const spec = { campaign: { store_terms: TERMS } };
  const calls = [];
  const context = fakeContext({ anchors: [{ href: TERMS, text: "Terms" }] });
  const rows = await clock.run(async () => {
    const budget = createPolicyLinkBudget({ clock });
    const pages = [];
    for (let visit = 0; visit < 3; visit += 1) {
      // A page visit that takes 30 s on its own.
      await clock.sleep(30_000);
      pages.push({ read: true, anchors: await readPageAnchors(context, {}, { spec, budget }) });
    }
    return (await runPolicyLinkChecks({ spec, pages, fetchImpl: fakeFetch(clock, (url) => (url === TERMS ? { status: 200, delayMs: 1_000 } : undefined), calls), measuredAt, budget })).rows;
  });
  assert.equal(calls.length, 1);
  assertRow(rows, "policy.presence:campaign:store_terms", "pass", null);
  assertRow(rows, "policy.availability:campaign:store_terms", "pass", null);
});

// ---------------------------------------------------------------------------
// Per-URL deadline

const slowChain = ({ finalDelayMs, stallCancel }) => (url) => {
  const step = /\/terms(?:\/(\d))?$/.exec(new URL(url).pathname);
  if (!step) return undefined;
  const index = Number(step[1] ?? 0);
  return index < 3 ? { status: 302, location: `/terms/${index + 1}`, delayMs: 4_700 } : { status: 200, delayMs: finalDelayMs, stallCancel };
};

test("policy links: three 4.7 s redirects, an 850 ms final response and a body cancel that never settles read network_unavailable at the 15 s deadline", { timeout: 30_000 }, async () => {
  const clock = virtualClock();
  const calls = [];
  const { block, elapsed } = await clock.run(async () => {
    const started = clock.now();
    const probed = await probePolicyUrl(TERMS, { fetchImpl: fakeFetch(clock, slowChain({ finalDelayMs: 850, stallCancel: true }), calls), clock });
    return { block: probed, elapsed: clock.now() - started };
  });
  assert.ok(elapsed <= 15_000, `the probe ended by its 15 s deadline (took ${elapsed} ms)`);
  assert.equal(calls.length, 4);
  assert.equal(block.outcome, "network_unavailable", "a response whose cancel completes after the deadline is not accepted");
  assert.deepEqual(block.chain.map(({ status }) => status), [302, 302, 302]);
  const derived = rederiveQcResult(availabilityObservation(block));
  assert.deepEqual([derived?.result, derived?.reason_code], ["unexercised", "network_unavailable"]);
});

test("policy links: a final response whose body cancel settles before the 15 s deadline is accepted", { timeout: 30_000 }, async () => {
  const clock = virtualClock();
  const calls = [];
  const block = await clock.run(() => probePolicyUrl(TERMS, { fetchImpl: fakeFetch(clock, slowChain({ finalDelayMs: 850, stallCancel: false }), calls), clock }));
  assert.equal(block.outcome, "redirected_elsewhere", "the 200 at 14.95 s is accepted (it ends on /terms/3)");
  assert.deepEqual(block.chain.map(({ status }) => status), [302, 302, 302, 200]);
});

// A request's 5 s covers its body cancel: the 1 s cancel wait is accepted
// only when it ends inside that request's 5 s.
test("policy links: a body cancel that never settles is waited for 1 s inside its request's 5 s, and only then is the response accepted", { timeout: 30_000 }, async () => {
  const run = async (finalDelayMs) => {
    const clock = virtualClock();
    const calls = [];
    const routes = (url) => (url === TERMS ? { status: 302, location: "/terms/", delayMs: 4_700 } : url === `${TERMS}/` ? { status: 200, delayMs: finalDelayMs, stallCancel: true } : undefined);
    return clock.run(async () => {
      const started = clock.now();
      const probed = await probePolicyUrl(TERMS, { fetchImpl: fakeFetch(clock, routes, calls), clock });
      return { block: probed, elapsed: clock.now() - started };
    });
  };
  // The second request starts at 4.7 s; its 5 s end at 9.7 s.
  const inTime = await run(1_000);
  assert.deepEqual([inTime.elapsed, inTime.block.outcome], [6_700, "pass"], "headers at 5.7 s, cancel wait over at 6.7 s: accepted");
  const late = await run(4_700);
  assert.deepEqual([late.elapsed, late.block.outcome], [9_700, "network_unavailable"], "headers at 9.4 s, cancel wait cut at 9.7 s: not accepted");
});

// A clock whose timers never fire: time moves only when the injected fetch
// says a response took that long. Every deadline race then settles with its
// operation, so only the probe's own reading of the clock can refuse a
// response that completed late.
function steppedClock() {
  let time = 0;
  const armed = new Set();
  return {
    armed,
    now: () => time,
    advance: (ms) => { time += ms; },
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      armed.add(timer);
      return timer;
    },
    clearTimer: (timer) => { armed.delete(timer); },
  };
}

// routes: (url) => { status, location?, takesMs }. The response resolves at
// once, with the clock moved on by takesMs.
function steppedFetch(clock, routes, calls) {
  return async (url) => {
    calls.push({ url: String(url), at: clock.now() });
    const answer = routes(String(url));
    if (!answer) throw new TypeError(`policy link hardening tests: no route for ${url}`);
    clock.advance(answer.takesMs);
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    if (answer.location) headers.set("location", answer.location);
    return { status: answer.status, headers, body: { cancel: () => Promise.resolve() } };
  };
}

test("policy links: a final HTML 200 that completes at or after its URL's 15 s deadline reads network_unavailable, even when no timer fired; one that completes before it reads pass", async () => {
  const configured = "http://store.example.invalid/terms";
  // Three 4 s redirects within the pass allowances (scheme, www., trailing
  // slash); the final request starts at 12 s, so its end is the 15 s deadline,
  // not its own 5 s.
  const routesFor = (finalMs) => (url) => ({
    [configured]: { status: 301, location: "https://store.example.invalid/terms", takesMs: 4_000 },
    "https://store.example.invalid/terms": { status: 301, location: "https://www.store.example.invalid/terms", takesMs: 4_000 },
    "https://www.store.example.invalid/terms": { status: 301, location: "https://www.store.example.invalid/terms/", takesMs: 4_000 },
    "https://www.store.example.invalid/terms/": { status: 200, takesMs: finalMs },
  })[url];
  const run = async (finalMs) => {
    const clock = steppedClock();
    const calls = [];
    const spec = { campaign: { store_terms: configured } };
    const { rows } = await runPolicyLinkChecks({ spec, pages: [], fetchImpl: steppedFetch(clock, routesFor(finalMs), calls), measuredAt, budget: createPolicyLinkBudget({ clock }) });
    assert.equal(clock.armed.size, 0, `final ${finalMs} ms: every deadline race settled with its response, before its timer`);
    assert.deepEqual(calls.map(({ at }) => at), [0, 4_000, 8_000, 12_000], `final ${finalMs} ms: four requests`);
    return rows;
  };
  const inTime = await run(2_999);
  const row = assertRow(inTime, "policy.availability:campaign:store_terms", "pass", null);
  assert.deepEqual(row.observation.availability.chain.map(({ status }) => status), [301, 301, 301, 200]);
  for (const finalMs of [3_000, 3_500]) {
    const late = await run(finalMs);
    const lateRow = assertRow(late, "policy.availability:campaign:store_terms", "unexercised", "network_unavailable");
    assert.deepEqual(lateRow.observation.availability.chain.map(({ status }) => status), [301, 301, 301], `final at ${12_000 + finalMs} ms: the late response is not in the chain`);
  }
});

// ---------------------------------------------------------------------------
// Anchor text is compared in full

async function presenceRun(anchors, campaign) {
  const spec = { campaign };
  const context = fakeContext({ anchors });
  const read = await readPageAnchors(context, {}, { spec });
  const result = await runPolicyLinkChecks({
    spec,
    pages: [read ? { read: true, anchors: read } : { read: false, anchors: null }],
    fetchImpl: fakeFetch(virtualClock(), htmlAt(campaign.store_terms), []),
    measuredAt,
  });
  return { read, rows: result.rows };
}

test("policy links: a declared 1,025-character label on an anchor pointing elsewhere reads destination_mismatch", async () => {
  const label = "A".repeat(1_025);
  const { rows } = await presenceRun(
    [{ href: TERMS, text: "Terms" }, { href: "https://store.example.invalid/contact", text: label }],
    { store_terms: TERMS, footer_links: [{ label, url: TERMS, required: true }] },
  );
  const row = assertRow(rows, "policy.presence:campaign:store_terms", "warning", "destination_mismatch");
  assert.equal(row.observation.presence.label_anchor_mismatch_pages, 1);
});

test("policy links: a wording hint after character 1,024 of an anchor pointing elsewhere reads possible_policy_link_mismatch", async () => {
  const { rows } = await presenceRun(
    [{ href: TERMS, text: "Terms" }, { href: "https://store.example.invalid/contact", text: `${"x ".repeat(512)}Terms` }],
    { store_terms: TERMS },
  );
  const row = assertRow(rows, "policy.presence:campaign:store_terms", "review", "possible_policy_link_mismatch");
  assert.equal(row.observation.presence.hint_anchor_elsewhere, 1);
});

test("policy links: anchor text never leaves the page; the read keeps only the matching fields", async () => {
  const marker = "Synthetic hardening text 5d2e";
  const { read } = await presenceRun(
    [{ href: TERMS, text: `${marker} terms` }, { href: "https://store.example.invalid/about", text: marker }],
    { store_terms: TERMS, footer_links: [{ label: marker, url: TERMS, required: true }] },
  );
  assert.deepEqual(read, [
    { href: TERMS, label_fields: [], hint_fields: ["store_terms"] },
    { href: "https://store.example.invalid/about", label_fields: ["store_terms"], hint_fields: [] },
  ]);
  assert.equal(JSON.stringify(read).includes(marker), false);
});

test("policy links: a page with an anchor text over 1 MiB is not read, so presence reads pages_not_read", async () => {
  const { read, rows } = await presenceRun(
    [{ href: TERMS, text: "Terms" }, { href: "https://store.example.invalid/about", text: "x".repeat(1_048_577) }],
    { store_terms: TERMS },
  );
  assert.equal(read, null);
  assertRow(rows, "policy.presence:campaign:store_terms", "unexercised", "pages_not_read");
});

// ---------------------------------------------------------------------------
// URL identity: decisions compare raw URLs, never their stored projection

async function availabilityRun(configured, routes) {
  const calls = [];
  const spec = { campaign: { store_terms: configured } };
  const { rows } = await runPolicyLinkChecks({ spec, pages: [], fetchImpl: fakeFetch(virtualClock(), routes, calls), measuredAt });
  return { rows, calls, row: rowsById(rows).get("policy.availability:campaign:store_terms") };
}

test("policy links: terms%3Fone redirecting to terms%3Ftwo, with scheme and www. differences, reads redirected_elsewhere", async () => {
  const configured = "http://example.invalid/terms%3Fone";
  const { row, calls, rows } = await availabilityRun(configured, (url) => ({
    [configured]: { status: 301, location: "https://www.example.invalid/terms%3Ftwo" },
    "https://www.example.invalid/terms%3Ftwo": { status: 200 },
  })[url]);
  assert.deepEqual(calls.map(({ url }) => url), [configured, "https://www.example.invalid/terms%3Ftwo"]);
  assertRow(rows, row.id, "review", "redirected_elsewhere");
  // The stored chain is the projection: both paths read the same there.
  const stored = row.observation.availability.chain.map(({ url }) => new URL(url).pathname);
  assert.equal(stored[0], stored[1], "the stored paths are identical; only the raw-URL hashes tell them apart");
  const persisted = JSON.stringify(row);
  for (const raw of ["%3Fone", "%3Ftwo", "?one", "?two"]) assert.equal(persisted.includes(raw), false, `nothing stored holds ${raw}`);
});

test("policy links: /terms redirecting to https://www./terms/ still reads pass (scheme, www. and trailing slash allowed)", async () => {
  const configured = "http://example.invalid/terms";
  const { rows, row } = await availabilityRun(configured, (url) => ({
    [configured]: { status: 301, location: "https://www.example.invalid/terms/" },
    "https://www.example.invalid/terms/": { status: 200 },
  })[url]);
  assertRow(rows, row.id, "pass", null);
});

test("policy links: a redirect to another host with the same path and query, ending in HTML 200, reads redirected_elsewhere", async () => {
  const configured = "https://store.example.invalid/terms?v=1";
  for (const elsewhere of [
    "https://other.example.invalid/terms?v=1",
    "https://www.other.example.invalid/terms?v=1",
    "https://shop.store.example.invalid/terms?v=1",
    "https://store.example.invalid:8443/terms?v=1",
  ]) {
    const { rows, row, calls } = await availabilityRun(configured, (url) => ({
      [configured]: { status: 302, location: elsewhere },
      [elsewhere]: { status: 200 },
    })[url]);
    assert.deepEqual(calls.map(({ url }) => url), [configured, elsewhere], `${elsewhere}: both requests are made`);
    assert.deepEqual(row.observation.availability.chain.map(({ status }) => status), [302, 200], `${elsewhere}: the chain ends in a 200`);
    assert.equal(row.observation.availability.content_type, "text/html", `${elsewhere}: the final response is HTML`);
    assertRow(rows, row.id, "review", "redirected_elsewhere");
  }
});

test("policy links: a redirect that changes only the scheme or a leading www. of the host, query kept, still reads pass", async () => {
  for (const [configured, final] of [
    ["https://store.example.invalid/terms?v=1", "http://store.example.invalid/terms?v=1"],
    ["https://store.example.invalid/terms?v=1", "https://www.store.example.invalid/terms?v=1"],
    ["https://www.store.example.invalid/terms?v=1", "https://store.example.invalid/terms?v=1"],
    ["https://www.store.example.invalid/terms?v=1", "http://store.example.invalid/terms/?v=1"],
  ]) {
    const { rows, row } = await availabilityRun(configured, (url) => ({
      [configured]: { status: 301, location: final },
      [final]: { status: 200 },
    })[url]);
    assert.deepEqual(row.observation.availability.chain.map(({ status }) => status), [301, 200], `${configured} → ${final}: the redirect is followed`);
    assertRow(rows, row.id, "pass", null);
  }
});

test("policy links: /a%3Fone redirecting to /a%3Ftwo is not a loop; back to /a%3Fone is", async () => {
  const configured = "https://example.invalid/a%3Fone";
  const two = "https://example.invalid/a%3Ftwo";
  const notLoop = await availabilityRun(configured, (url) => ({ [configured]: { status: 302, location: "/a%3Ftwo" }, [two]: { status: 200 } })[url]);
  assert.deepEqual(notLoop.calls.map(({ url }) => url), [configured, two]);
  assertRow(notLoop.rows, notLoop.row.id, "review", "redirected_elsewhere");
  const loop = await availabilityRun(configured, (url) => ({ [configured]: { status: 302, location: "/a%3Ftwo" }, [two]: { status: 302, location: "/a%3Fone" } })[url]);
  assert.deepEqual(loop.calls.map(({ url }) => url), [configured, two], "the repeat is found before it is requested again");
  assertRow(loop.rows, loop.row.id, "review", "redirect_loop");
});

test("policy links: a stored chain whose URL hashes disagree with its unredacted URL does not re-derive", async () => {
  const { row } = await availabilityRun(TERMS, htmlAt(TERMS));
  assert.equal(row.result, "pass");
  const observation = structuredClone(row.observation);
  observation.availability.chain_identity[0].path_sha256 = sha256("/elsewhere");
  assert.equal(rederiveQcResult(observation), null);
});

// ---------------------------------------------------------------------------
// A stored configured value is consistent with its class

const RUN_ID = "policy-links-hardening-run";
const BUILD = sha256("policy links hardening build");

// The 1.0 QA reader over stored rows and their verdict assertions, with the
// real module from the registry.
async function readStored(rows) {
  return readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD },
    stage: { identity: { verdict_run_id: RUN_ID } },
    fullVerdict: {
      schema_version: "1.0",
      run_id: RUN_ID,
      started_at: measuredAt,
      completed_at: measuredAt,
      runtime: "campaigns-os-node-qa@0.0.0-test",
      assertions: rows.map(policyLinkQaAssertion),
      test_orders: [],
      exceptions: [],
    },
    currentBuild: BUILD,
    rederivers: await loadQcRederivers(),
  });
}

const COMPLETE_PRESENCE = Object.freeze({
  pages_expected: 1,
  pages_read: 1,
  pages_with_match: 1,
  path_match_query_differs: 0,
  label_declared: false,
  label_anchor_mismatch_pages: 0,
  hint_anchor_elsewhere: 0,
});
const NON_HTTP_BLOCK = Object.freeze({ chain: [], chain_identity: [], final: null, final_query_sha256: null, status: null, content_type: null, outcome: "non_http_destination", next_hop: null });

// The presence and availability observations of `configured` stored under
// `scheme`, with complete presence counts and a match on the only page.
const storedIdentity = (configured, scheme) => [
  { check: "policy.presence", field: "store_terms", configured, configured_query_sha256: null, scheme, presence: { ...COMPLETE_PRESENCE } },
  { check: "policy.availability", field: "store_terms", configured, configured_query_sha256: null, scheme, availability: structuredClone(NON_HTTP_BLOCK) },
];

// A stored row claiming the result its consistent twin (tel:+15550100, scheme
// other) derives, with `observation` and its configured value in the state.
function claimedRow(observation) {
  const twin = { ...observation, configured: "tel:+15550100", scheme: "other" };
  const derived = rederiveQcResult(twin);
  assert.ok(derived, "setup: the consistent twin re-derives");
  return buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: { ...derived.state, configured: observation.configured },
    observation,
    members: derived.members,
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
}

// Each configured value stored under `scheme` neither re-derives nor reads,
// through the reader, as anything but not reproducible.
async function assertRefused(values, scheme) {
  const actual = [];
  const expected = [];
  for (const configured of values) {
    const observations = storedIdentity(configured, scheme);
    const rows = observations.map(claimedRow);
    assert.equal(rows[0].result, "pass", "setup: the stored presence row claims pass");
    const read = await readStored(rows);
    actual.push({
      configured,
      rederived: observations.map((observation) => [observation.check, rederiveQcResult(observation)?.result ?? null]),
      read: read.map((row) => [row.id, row.result, row.reason_code]).sort(),
    });
    expected.push({
      configured,
      rederived: observations.map((observation) => [observation.check, null]),
      read: rows.map((row) => [row.id, "unexercised", "evidence_not_reproducible"]).sort(),
    });
  }
  assert.deepEqual(actual, expected, `values stored as ${scheme} neither re-derive nor read as reproducible`);
}

test("policy links: a relative configured value stored as scheme other, with complete presence counts, never reads pass", async () => {
  await assertRefused(["/terms"], "other");
});

test("policy links: relative and scheme-less configured values stored as scheme other are refused", async () => {
  await assertRefused(["terms.html", "//example.test/terms", "example.test/terms"], "other");
});

test("policy links: http(s) and mailto configured values stored as scheme other are refused", async () => {
  await assertRefused(["https://example.test/terms", "mailto:a@b.test"], "other");
});

// A stored presence row whose observation counts more matching pages than
// pages read, claiming the result those counts would decide (pass) with the
// state they would give.
test("policy links: a stored presence observation with pages_with_match above pages_read neither re-derives nor reads as anything but not reproducible", async () => {
  for (const [read, withMatch] of [[1, 2], [2, 3]]) {
    const counts = { ...COMPLETE_PRESENCE, pages_expected: read, pages_read: read };
    const consistent = { check: "policy.presence", field: "store_terms", configured: TERMS, configured_query_sha256: null, scheme: "https", presence: { ...counts, pages_with_match: read } };
    const derived = rederiveQcResult(consistent);
    assert.deepEqual([derived?.result, derived?.reason_code], ["pass", null], "setup: the consistent counts derive pass");
    const observation = { ...consistent, presence: { ...counts, pages_with_match: withMatch } };
    const row = buildQcResult({
      check: derived.check,
      leg: "qa",
      subject: derived.subject,
      result: derived.result,
      reason_code: derived.reason_code,
      state: { ...derived.state, pages_with_match: withMatch },
      observation,
      members: derived.members,
      accept_eligible: derived.accept_eligible,
      coverage: derived.coverage,
      measured_at: measuredAt,
    });
    const label = `pages_read ${read}, pages_with_match ${withMatch}`;
    assert.equal(rederiveQcResult(observation), null, `${label}: does not re-derive`);
    const stored = await readStored([row]);
    assert.deepEqual(stored.map((entry) => [entry.id, entry.result, entry.reason_code]), [[row.id, "unexercised", "evidence_not_reproducible"]], `${label}: the reader reads it as not reproducible`);
  }
});

// One field configured as `configured`, its anchor on the only page and every
// http(s) request answered with an HTML 200.
async function produced(configured) {
  const spec = { campaign: { store_terms: configured } };
  const pages = [{ read: true, anchors: [{ href: configured, label_fields: [], hint_fields: [] }] }];
  const { rows } = await runPolicyLinkChecks({ spec, pages, fetchImpl: fakeFetch(virtualClock(), () => ({ status: 200 }), []), measuredAt });
  return rows;
}

const ORIGIN = "https://example.test";
// The persisted-verdict projection cuts a longer string to 16,384 characters.
const PROJECTION_BOUND = 16 * 1024;
const PRODUCED = Object.freeze({
  http: ["http://example.test/terms", "http://Example.TEST:8080/terms/?b=2&a=1#top"],
  https: [
    `${ORIGIN}/terms`,
    "https://user:secret@www.example.test/terms?ref=synthetic",
    `${ORIGIN}/terms%3Fone`,
    `${ORIGIN}/terms%3Cquery-redacted%3E`,
    `${ORIGIN}/x%${"25".repeat(10)}41`,
    `${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length - 1)}`,
    `${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length)}`,
    `${ORIGIN}/${"a%2F".repeat(PROJECTION_BOUND / 4)}`,
  ],
  mailto: [
    "mailto:Help@Example.test",
    "mailto:a%2525b@example.test",
    "mailto:a%23b@example.test",
    "mailto:a%3Fb@example.test",
    "mailto:a%0Ab@example.test",
    `mailto:${"a%25".repeat(PROJECTION_BOUND / 4)}@example.test`,
  ],
  other: [
    "tel:+15550100",
    "sms:+15550100?body=synthetic",
    "urn:isbn:0000000000",
    "data:text/html,<b>terms</b>",
    "blob:https://example.test/terms",
    "file:///terms",
    "foo://host.example.test/terms",
    "ws://example.test/terms%3Fone",
    "ftp://user@example.test/terms",
    `tel:${"1".repeat(PROJECTION_BOUND)}`,
  ],
});

// Values whose stored form the projection changes: a redacted path keeps the
// marker, a value the projection replaces whole or leaves as no URL of its
// class keeps its scheme (and host) with the marker, a long one is cut.
const STORED_AS = Object.freeze({
  [`${ORIGIN}/terms%3Fone`]: `${ORIGIN}/terms<query-redacted>`,
  [`${ORIGIN}/x%${"25".repeat(10)}41`]: `${ORIGIN}/<query-redacted>`,
  [`${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length - 1)}`]: `${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length - 1)}`,
  [`${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length)}`]: `${ORIGIN}/${"a".repeat(PROJECTION_BOUND - ORIGIN.length - 1 - "[truncated]".length)}[truncated]`,
  "mailto:a%2525b@example.test": "mailto:<query-redacted>",
  "mailto:a%3Fb@example.test": "mailto:a<query-redacted>",
  "file:///terms": "file:<query-redacted>",
  "foo://host.example.test/terms": "foo:<query-redacted>",
  "ws://example.test/terms%3Fone": "ws://example.test/terms<query-redacted>",
  "ftp://user@example.test/terms": "ftp://example.test/terms",
});

test("policy links: every configured value the producer stores reads back as itself, and its rows re-derive to the same results", async () => {
  for (const [scheme, values] of Object.entries(PRODUCED)) {
    for (const configured of values) {
      const label = `${scheme} ${configured.slice(0, 60)}`;
      const rows = await produced(configured);
      assert.deepEqual(rows.map((row) => row.check).sort(), ["policy.availability", "policy.presence"], `${label}: both rows are written`);
      const stored = rows[0].observation.configured;
      assert.ok(rows.every((row) => row.observation.scheme === scheme && row.observation.configured === stored), `${label}: stored as ${scheme}`);
      assert.ok(stored.length <= PROJECTION_BOUND, `${label}: the stored value is within the projection bound`);
      if (Object.hasOwn(STORED_AS, configured)) assert.equal(stored, STORED_AS[configured], `${label}: stored value`);
      for (const row of rows) {
        const rederived = rederiveQcResult(row.observation);
        assert.deepEqual([rederived?.result, rederived?.reason_code], [row.result, row.reason_code], `${label}: ${row.check} re-derives`);
      }
      const read = await readStored(rows);
      assert.deepEqual(
        read.map((row) => [row.id, row.result, row.reason_code, row.state_fingerprint]).sort(),
        rows.map((row) => [row.id, row.result, row.reason_code, row.state_fingerprint]).sort(),
        `${label}: the reader reads each row unchanged`,
      );
      // Configured as its stored value, it is stored the same way.
      const again = await produced(stored);
      assert.deepEqual(again.map((row) => [row.observation.scheme, row.observation.configured]), rows.map(() => [scheme, stored]), `${label}: the stored value reads back as itself`);
    }
  }
});

// The 1.0 QA reader over rows and a verdict persisted as a QA run persists
// them: each through the persisted-verdict projection.
async function readPersisted(rows) {
  const persistedRows = rows.map(redactPersisted);
  return readQaResults({
    stageEvidence: { qc_results: persistedRows, qc_build_fingerprint: BUILD },
    stage: { identity: { verdict_run_id: RUN_ID } },
    fullVerdict: redactPersisted({
      schema_version: "1.0",
      run_id: RUN_ID,
      started_at: measuredAt,
      completed_at: measuredAt,
      runtime: "campaigns-os-node-qa@0.0.0-test",
      assertions: rows.map(policyLinkQaAssertion),
      test_orders: [],
      exceptions: [],
    }),
    currentBuild: BUILD,
    rederivers: await loadQcRederivers(),
  });
}

// Values of 16,384, 16,385 and 1,000,000 characters whose host (http, https)
// or scheme (other) alone is longer than the projection's bound.
const OVERSIZED = [PROJECTION_BOUND, PROJECTION_BOUND + 1, 1_000_000].flatMap((length) => [
  ["http", `http://${"a".repeat(length - "http://".length)}`],
  ["https", `https://${"a".repeat(length - "https://".length)}`],
  ["other", `${"a".repeat(length - "://host".length)}://host`],
]);

for (const [scheme, configured] of OVERSIZED) {
  test(`policy links: a ${configured.length}-character ${scheme} value with an oversized ${scheme === "other" ? "scheme" : "host"} is stored within the bound, and both rows read back from the persisted verdict with their results`, async () => {
    const rows = await produced(configured);
    assert.deepEqual(rows.map((row) => row.check).sort(), ["policy.availability", "policy.presence"], "both rows are written");
    assert.equal(rows.find((row) => row.check === "policy.presence").result, "pass", "the anchor on the only page is a match");
    const stored = rows[0].observation.configured;
    assert.deepEqual(
      rows.map((row) => [row.observation.scheme, row.observation.configured === stored, redactPersisted(stored) === stored, stored.length <= PROJECTION_BOUND]),
      rows.map(() => [scheme, true, true, true]),
      "stored as its class, within the bound, unchanged by the persisted-verdict projection",
    );
    const read = await readPersisted(rows);
    assert.deepEqual(
      read.map((row) => [row.id, row.result, row.reason_code, row.state_fingerprint]).sort(),
      rows.map((row) => [row.id, row.result, row.reason_code, row.state_fingerprint]).sort(),
      "the reader reads each persisted row unchanged",
    );
    // Configured as its stored value, it is stored the same way.
    const again = await produced(stored);
    assert.deepEqual(again.map((row) => [row.observation.scheme, row.observation.configured]), rows.map(() => [scheme, stored]), "the stored value reads back as itself");
  });
}

// ---------------------------------------------------------------------------
// A stored observation has exactly the keys the producer writes

// The row the reader would accept for `valid`, storing `observation` instead:
// it claims the result, reason code, coverage and accept eligibility `valid`
// derives, and `state` (by default the state `valid` derives).
function claimedFrom(valid, observation, state = undefined) {
  const derived = rederiveQcResult(valid);
  assert.ok(derived, "setup: the producer's observation re-derives");
  return buildQcResult({
    check: derived.check,
    leg: "qa",
    subject: derived.subject,
    result: derived.result,
    reason_code: derived.reason_code,
    state: state ?? derived.state,
    observation,
    members: derived.members,
    accept_eligible: derived.accept_eligible,
    coverage: derived.coverage,
    measured_at: measuredAt,
  });
}

const readEntries = (read) => read.map((row) => [row.id, row.result, row.reason_code]);
const notReproducible = (row) => [[row.id, "unexercised", "evidence_not_reproducible"]];

// Each changed observation is refused by re-derivation, and its row, claiming
// what the producer's observation derives, reads as not reproducible.
async function assertEachRefused(cases) {
  const actual = [];
  const expected = [];
  for (const { label, valid, observation, state } of cases) {
    const row = claimedFrom(valid, observation, state);
    actual.push([label, rederiveQcResult(observation), readEntries(await readStored([row]))]);
    expected.push([label, null, notReproducible(row)]);
  }
  assert.deepEqual(actual, expected);
}

// The stored objects of an observation as [label, path]: the observation, its
// block and, in an availability block, each chain hop, each chain_identity
// entry and the next hop.
function storedObjects(observation) {
  const block = observation.check === "policy.presence" ? "presence" : "availability";
  const objects = [["observation", []], [block, [block]]];
  if (block === "availability") {
    const { chain, chain_identity: ids, next_hop: nextHop } = observation.availability;
    chain.forEach((_, index) => objects.push([`chain[${index}]`, ["availability", "chain", index]]));
    ids.forEach((_, index) => objects.push([`chain_identity[${index}]`, ["availability", "chain_identity", index]]));
    if (nextHop) objects.push(["next_hop", ["availability", "next_hop"]]);
  }
  return objects;
}

const objectAt = (value, path) => path.reduce((inner, key) => inner[key], value);
function changedAt(observation, path, change) {
  const copy = structuredClone(observation);
  change(objectAt(copy, path));
  return copy;
}

// Producer rows: a passing presence row and a passing two-hop availability
// row; a redirect loop (its block keeps the next hop); the run-scope rows.
async function producerRows() {
  const configured = "http://example.invalid/terms";
  const passing = await availabilityRun(configured, (url) => ({
    [configured]: { status: 301, location: "https://www.example.invalid/terms/" },
    "https://www.example.invalid/terms/": { status: 200 },
  })[url]);
  const loop = await availabilityRun(TERMS, (url) => ({
    [TERMS]: { status: 302, location: "/terms/a" },
    [`${TERMS}/a`]: { status: 302, location: "/terms" },
  })[url]);
  const presence = (await produced(TERMS)).find((row) => row.check === "policy.presence");
  const notRequested = policyLinkNotRequestedRows({ campaign: { store_terms: TERMS } }, [{ pages: [{}] }], { measuredAt });
  const rows = [presence, passing.row, loop.row, ...notRequested];
  assert.deepEqual(
    rows.map((row) => [row.id, row.result, row.reason_code]),
    [
      ["policy.presence:campaign:store_terms", "pass", null],
      ["policy.availability:campaign:store_terms", "pass", null],
      ["policy.availability:campaign:store_terms", "review", "redirect_loop"],
      ["policy.presence:campaign:store_terms", "excluded", "browser_checks_not_requested"],
      ["policy.availability:campaign:store_terms", "excluded", "browser_checks_not_requested"],
    ],
    "setup: the producer rows",
  );
  assert.ok(loop.row.observation.availability.next_hop, "setup: the loop's block keeps its next hop");
  return rows;
}

test("policy links: producer rows round-trip through re-derivation and the reader with their stored shape", async () => {
  for (const row of await producerRows()) {
    const rederived = rederiveQcResult(row.observation);
    assert.deepEqual([rederived?.result, rederived?.reason_code], [row.result, row.reason_code], `${row.id} ${row.result} re-derives`);
    assert.deepEqual(readEntries(await readStored([row])), [[row.id, row.result, row.reason_code]], `${row.id} ${row.result} reads back`);
    assert.deepEqual(readEntries(await readStored([claimedFrom(row.observation, structuredClone(row.observation))])), [[row.id, row.result, row.reason_code]], `setup: ${row.id} ${row.result} rebuilt from its observation reads back`);
  }
});

test("policy links: a stored observation with an extra key at any level is refused by re-derivation and read as not reproducible", async () => {
  const cases = [];
  for (const row of await producerRows()) {
    for (const [level, path] of storedObjects(row.observation)) {
      cases.push({
        label: `${row.id} ${row.result}: extra key on ${level}`,
        valid: row.observation,
        observation: changedAt(row.observation, path, (object) => { object.extra = true; }),
      });
    }
  }
  assert.ok(cases.length >= 15, "setup: every level of every producer row");
  await assertEachRefused(cases);
});

test("policy links: run_scope stored as null or another value on a row the producer writes without it is refused", async () => {
  const [presence, availability] = await producerRows();
  await assertEachRefused([presence, availability].flatMap((row) => [null, "browser_checks_not_requested_extra"].map((runScope) => ({
    label: `${row.id}: run_scope ${runScope}`,
    valid: row.observation,
    observation: { ...structuredClone(row.observation), run_scope: runScope },
  }))));
});

test("policy links: a stored observation missing any key at any level is refused by re-derivation and read as not reproducible", async () => {
  const cases = [];
  for (const row of await producerRows()) {
    for (const [level, path] of storedObjects(row.observation)) {
      for (const key of Object.keys(objectAt(row.observation, path))) {
        // Without run_scope, a run-scope presence observation is the shape the
        // producer writes for a browser run (and reads as that).
        if (level === "observation" && key === "run_scope") continue;
        cases.push({
          label: `${row.id} ${row.result}: ${level} without ${key}`,
          valid: row.observation,
          observation: changedAt(row.observation, path, (object) => { delete object[key]; }),
        });
      }
    }
  }
  assert.ok(cases.length >= 60, "setup: every key of every level");
  await assertEachRefused(cases);
});

// ---------------------------------------------------------------------------
// Final responses

test("policy links: a redirect status with no usable Location ends the chain and reads unexpected_status, never pass", async () => {
  for (const [label, answer] of [
    ["302 without Location", { status: 302 }],
    ["301 with a blank Location", { status: 301, location: " " }],
    ["307 to mailto:", { status: 307, location: "mailto:help@store.example.invalid" }],
    ["308 to an unparseable URL", { status: 308, location: "http://" }],
    ["303 to javascript:", { status: 303, location: "javascript:void(0)" }],
  ]) {
    const { rows, row, calls } = await availabilityRun(TERMS, (url) => (url === TERMS ? answer : undefined));
    assert.deepEqual(calls.map(({ url }) => url), [TERMS], `${label}: one request`);
    const { availability } = row.observation;
    assert.deepEqual(
      [availability.chain.map(({ status }) => status), availability.status, availability.content_type, availability.next_hop],
      [[answer.status], answer.status, "text/html", null],
      `${label}: the redirect response is the final one, with HTML headers and no next hop`,
    );
    assertRow(rows, row.id, "review", "unexpected_status");
    const claimed = structuredClone(row.observation);
    claimed.availability.outcome = "pass";
    assert.equal(rederiveQcResult(claimed), null, `${label}: a stored pass for it does not re-derive`);
  }
});

test("policy links: a 200 whose media type only begins like an HTML type reads non_html_response; HTML types with parameters or in upper case pass", async () => {
  for (const type of ["text/htmlx", "text/html-sandboxed", "application/htmlx", "application/xhtml+xmlx", "text/xhtml"]) {
    const { rows, row } = await availabilityRun(TERMS, (url) => (url === TERMS ? { status: 200, type } : undefined));
    assert.equal(row.observation.availability.content_type, type, `${type}: stored as the media type`);
    assertRow(rows, row.id, "review", "non_html_response");
    const claimed = structuredClone(row.observation);
    claimed.availability.outcome = "pass";
    assert.equal(rederiveQcResult(claimed), null, `${type}: a stored pass for it does not re-derive`);
  }
  for (const [type, stored] of [
    ["text/html; charset=utf-8", "text/html"],
    ["TEXT/HTML", "text/html"],
    ["text/html", "text/html"],
    ["application/xhtml+xml", "application/xhtml+xml"],
    ["Application/XHTML+XML; charset=utf-8", "application/xhtml+xml"],
  ]) {
    const { rows, row } = await availabilityRun(TERMS, (url) => (url === TERMS ? { status: 200, type } : undefined));
    assert.equal(row.observation.availability.content_type, stored, `${type}: stored as ${stored}`);
    assertRow(rows, row.id, "pass", null);
  }
});

// ---------------------------------------------------------------------------
// A stored chain never repeats a request

test("policy links: a stored chain that repeats a hop is refused by re-derivation and read as not reproducible", async () => {
  const configured = "http://example.invalid/terms";
  const direct = (await availabilityRun(TERMS, htmlAt(TERMS))).row;
  const redirected = (await availabilityRun(configured, (url) => ({
    [configured]: { status: 301, location: "https://www.example.invalid/terms/" },
    "https://www.example.invalid/terms/": { status: 200 },
  })[url])).row;
  assert.deepEqual([direct.result, redirected.result], ["pass", "pass"], "setup: both chains pass");
  // `index` is repeated in place, as a redirect when it is not the last hop.
  const repeated = (row, index, status) => {
    const observation = structuredClone(row.observation);
    const { chain, chain_identity: ids } = observation.availability;
    chain.splice(index, 0, { ...chain[index], status });
    ids.splice(index, 0, { ...ids[index] });
    return observation;
  };
  const cases = [
    ["the only hop, first as a 302", direct, repeated(direct, 0, 302)],
    ["the first hop of two", redirected, repeated(redirected, 0, 301)],
    ["the last hop of two, first as a 301", redirected, repeated(redirected, 1, 301)],
  ].map(([label, row, observation]) => ({
    label,
    valid: row.observation,
    observation,
    // The state such a chain would give: the stored hops, the same final.
    state: { ...rederiveQcResult(row.observation).state, chain: observation.availability.chain.map(({ url, query_sha256: querySha, status }) => ({ url, query_sha256: querySha, status })) },
  }));
  assert.ok(cases.every(({ observation }) => new Set(observation.availability.chain_identity.map(({ url_sha256: url }) => url)).size < observation.availability.chain.length), "setup: each chain repeats a request");
  await assertEachRefused(cases);
});
