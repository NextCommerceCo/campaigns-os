// Unit 1.4 fixture rows, leg QB: policy link presence read from the rendered
// anchors of `qa run --browser`'s page checks (runBrowserChecks), each against
// a loopback stub campaign. Every configured http policy URL is a loopback
// page of the same stub, so the run's availability probes reach only
// loopback; every value is synthetic.
//
// The stub logs every request it serves. Chromium only loads the campaign
// pages: nothing on them loads a policy page, so every request for /policy/
// is an availability probe, and each row compares that log exactly (one GET
// per distinct configured http URL, none for a mailto: value). A policy page
// sends its headers and then a slow body (64 chunks of 16 KiB, one every
// 40 ms); the probes read headers only, so each probe's connection closes
// within 1 s of its headers, before the body ends (contract §1.4 Inputs).
//
// Coverage (rules in src/qa-policy-links.test.mjs): presence counts pages
// ({observed: pages_read, expected: pages_expected, limits: [] or
// ["pages_not_read"]}); availability is {1, 1, []} when a response decided it
// and {0, null, []} for a mailto: value. Every row is checked against its
// expected result, reason code, members, coverage and state in the producer's
// rows and again in the reader's.
//
// API assumption (every row): runBrowserChecks(topologies, args, options)
// takes the CampaignSpec as options.spec and an array as options.qcResults.
// After the page checks it pushes, for each non-empty campaign.store_* policy
// field, one presence and one availability row (full
// campaigns-os-qc-result/v0 rows, buildQcResult) into options.qcResults, and
// nothing else for a spec without content parameters, and returns each row's
// toQaAssertion(row, { family: "browser-runtime" }) under the contract's
// assertion id among the assertions it already returns (none of which is a
// qc.* assertion). The expected pages are the topology pages.
//
// Ids: the subject is {check: "policy.presence" | "policy.availability",
// page: "campaign", key: <field>} (contract §1.4 Accepts), so the row id
// follows the 1.0 qcResultId as <check>:campaign:<field>; the verdict
// assertion id is the contract's qc.<check>:<field>, naming the row in
// evidence.qc.result_id. Rows do not aggregate: members is [].
//
// API assumption (observation): a presence row's observation carries {check,
// field, configured, configured_query_sha256, scheme, presence: {pages_expected,
// pages_read, pages_with_match, path_match_query_differs, label_declared,
// label_anchor_mismatch_pages, hint_anchor_elsewhere}} and an availability
// row's {check, field, configured, configured_query_sha256, scheme,
// availability: {chain, final, final_query_sha256, status, content_type,
// outcome}}, as described in src/qa-policy-links.test.mjs (configured is
// origin+path; a query is kept only as "sha256:" + the hex sha256 of its
// sorted "key=value" pairs joined with "&"; outcome "pass" on a pass). The
// rows compare those named fields exactly. hint_anchor_elsewhere counts the
// anchors whose text is a hint word for the field (case-insensitive) and
// that point elsewhere, whether or not footer_links declares a label.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";

// The guards go in before anything loads a module under test: loopback-only
// fetch (every redirect hop checked), node:http(s), sockets and WebSocket for
// node, and every Chromium context Playwright launches. This file does not
// import src/qc-test-factories.mjs, whose guard refuses loopback fetches too,
// because the run's availability probes fetch the loopback policy pages.
import { assertLoopbackOnly, chromiumAvailable, installBrowserGuard, installNodeGuard, sha256 } from "./qa-tracking-params-fixtures.mjs";

installNodeGuard();
afterEach(() => assertLoopbackOnly());
after(async () => {
  assertLoopbackOnly();
  if (stub) await stub.close();
});

const available = await chromiumAvailable();
const browserTest = available ? test : test.skip;
if (!available) {
  test.skip("Playwright Chromium is unavailable; policy link browser rows skipped (run `npm run qa:install-browser`)", () => {});
}

// One runBrowserChecks call per run: a browser launch, each page's load (up to
// the 10 s browser timeout plus its 5 s settle) and the availability probes
// (at most 15 s). 120 s covers that worst case for two pages.
const T = { timeout: 120_000 };
const ARGS = Object.freeze({ "browser-timeout": 10_000 });
const PAGE = "campaign";
const RUN_ID = "qa-policy-links-synthetic-run";
const BUILD = sha256("synthetic policy links build");
const OPERATOR = "Jordan Lee";
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// Anchor text nobody may store (link text is never persisted).
const LINK_TEXT_MARKER = "Synthetic footer link 7c41";
// The QA verdict mapping of each result (contract 1.0 vocabulary table).
const ASSERTION_STATUS = Object.freeze({
  pass: ["pass", "info"],
  warning: ["warn", "warn"],
  review: ["manual_review", "warn"],
  unexercised: ["manual_review", "warn"],
  excluded: ["skipped", "info"],
});

// ---------------------------------------------------------------------------
// The loopback stub

const POLICY_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Synthetic policy</title></head><body><p>Synthetic policy page.</p></body></html>";
const page = ({ head = "", body }) => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic campaign</title>${head}</head><body><main><h1>Synthetic campaign</h1></main><footer>${body}</footer></body></html>`;
const anchor = (href, text = LINK_TEXT_MARKER) => `<a href="${href}">${text}</a>`;
const NEUTRAL = anchor("/about/");

// B10's second page renders the mislabelled anchor once `b10Second` is set.
let b10Second = false;
const CASES = {
  // <base> makes the relative href resolve to /policy/terms.
  "/w1/": () => page({ head: "<base href=\"/policy/\">", body: anchor("terms") + NEUTRAL }),
  "/w3/": () => page({ body: anchor("/policy/terms/") + NEUTRAL }),
  "/w5/": () => page({ body: anchor("mailto:x@example.invalid", "Email us") + NEUTRAL }),
  "/b1/": () => page({ body: NEUTRAL }),
  "/b2/": () => page({ body: anchor("/policy/contact", "Terms") + NEUTRAL }),
  "/b5/": () => page({ body: anchor("/policy/terms?version=1") + NEUTRAL }),
  "/b6/": () => page({ body: anchor("/about/", "Terms") }),
  "/b10/a/": () => page({ body: anchor("/policy/contact", "Terms") + NEUTRAL }),
  "/b10/b/": () => page({ body: (b10Second ? anchor("/policy/contact", "Terms") : "") + NEUTRAL }),
  "/i6/": () => page({ body: anchor("/policy/terms") + anchor("/about/", "Terms") }),
  "/i10/a/": () => page({ body: anchor("/policy/terms") + NEUTRAL }),
  // /i10/b/ is never answered (below).
};
const POLICY_PATHS = new Set(["/policy/terms", "/policy/privacy", "/policy/contact"]);
const BODY_CHUNK = Buffer.alloc(16 * 1024, " ");
const BODY_CHUNKS = 64;
const BODY_EVERY_MS = 40;
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

// A policy page: its headers at once, then the slow body. Lists the response
// in `ends` with a promise of how its connection ended ({ finished, afterMs }:
// whether the whole body was sent, and how long after the headers it closed).
function slowPolicyPage(response, path, ends, drips) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.flushHeaders();
  const headersAt = performance.now();
  let sent = 0;
  const drip = setInterval(() => {
    if (sent === BODY_CHUNKS) {
      clearInterval(drip);
      response.end();
      return;
    }
    response.write(sent === 0 ? Buffer.concat([Buffer.from(POLICY_HTML), BODY_CHUNK]) : BODY_CHUNK);
    sent += 1;
  }, BODY_EVERY_MS);
  drips.add(drip);
  const closed = new Promise((resolve) => response.once("close", () => {
    clearInterval(drip);
    drips.delete(drip);
    resolve({ finished: response.writableFinished, afterMs: performance.now() - headersAt });
  }));
  ends.push({ path, closed });
}

let stub = null;
async function stubServer() {
  if (stub) return stub;
  const log = [];
  const ends = [];
  const held = new Set();
  const drips = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    log.push({ method: request.method, path: `${url.pathname}${url.search}` });
    if (POLICY_PATHS.has(url.pathname)) return slowPolicyPage(response, `${url.pathname}${url.search}`, ends, drips);
    if (url.pathname === "/i10/b/") return held.add(response);
    const render = CASES[url.pathname];
    if (!render) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(render());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub = {
    base: `http://127.0.0.1:${server.address().port}`,
    log,
    ends,
    close: () => new Promise((resolve) => {
      for (const drip of drips) clearInterval(drip);
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
  return stub;
}

// One runBrowserChecks call over a one-funnel topology of `paths`
// ({ id, path }), with `campaign` as the spec's campaign block.
async function runPages(pages, campaign) {
  await installBrowserGuard();
  const server = await stubServer();
  const { runBrowserChecks } = await import("./qa-browser.mjs");
  const topologies = [{
    funnel_id: "default",
    funnel_name: "Default",
    pages: pages.map((entry, index) => ({ page_id: entry.id, page_type: "landing", order: index + 1, url: `${server.base}${entry.path}` })),
  }];
  const start = server.log.length;
  const endsStart = server.ends.length;
  const qcResults = [];
  const assertions = await runBrowserChecks(topologies, { ...ARGS }, { spec: { campaign: structuredClone(campaign) }, qcResults });
  assert.ok(Array.isArray(assertions), "runBrowserChecks still returns its assertions");
  const policyRequests = server.log.slice(start).filter((entry) => POLICY_PATHS.has(new URL(entry.path, "http://127.0.0.1").pathname));
  return { assertions, qcResults, policyRequests, policyEnds: server.ends.slice(endsStart) };
}

const url = (path) => `${stub.base}${path}`;

// ---------------------------------------------------------------------------
// Reading the 1.4 rows of a run

const idOf = (check, field) => `${check}:${PAGE}:${field}`;
const assertionIdOf = (check, field) => `qc.${check}:${field}`;
const subjectOf = (check, field) => ({ check, page: PAGE, key: field });
const byFirst = (a, b) => String(a[0]).localeCompare(String(b[0]));

function verdictOf(assertions, measuredAt) {
  return { schema_version: "1.0", run_id: RUN_ID, started_at: measuredAt, completed_at: measuredAt, runtime: `campaigns-os-node-qa@${PACKAGE_VERSION}`, assertions };
}

// The run's complete QC result set is exactly one presence and one
// availability row per field in `fields`, its complete qc.* assertion set
// exactly their assertions (paired by evidence.qc.result_id), every row a
// full QA row with its pinned subject and no members, every assertion
// carrying its row's observation with the verdict mapping of its result,
// nothing persisted holding link text or a raw query, and the complete set
// re-derives through the 1.0 QA reader with the real module from the
// registry. Returns { rows: Map(id -> row), read: Map(id -> read row) }.
async function policyRows(run, fields, { forbidden = [] } = {}) {
  const ids = fields.flatMap((field) => [idOf("policy.availability", field), idOf("policy.presence", field)]).sort();
  const rows = run.qcResults;
  assert.deepEqual(rows.map((row) => row?.id).sort(), ids, "the run's QC results are exactly a presence and an availability row per configured field");
  const qcAssertions = run.assertions.filter((entry) => String(entry?.id || "").startsWith("qc."));
  assert.deepEqual(
    qcAssertions.map((entry) => [entry.evidence?.qc?.result_id, entry.id]).sort(byFirst),
    ids.map((id) => {
      const [check, , field] = id.split(":");
      return [id, assertionIdOf(check, field)];
    }),
    "the run's qc.* assertions are exactly one qc.<check>:<field> assertion per row",
  );
  for (const row of rows) {
    const paired = qcAssertions.find((entry) => entry.evidence?.qc?.result_id === row.id);
    const [check, , field] = row.id.split(":");
    assert.deepEqual(
      [row.schema, row.check, row.leg, row.producer, row.subject, row.members],
      ["campaigns-os-qc-result/v0", check, "qa", "campaigns-os qa run", subjectOf(check, field), []],
      `${row.id} is a full QA row with its pinned subject and no members`,
    );
    assert.deepEqual(
      [paired.family, paired.page, paired.status, paired.severity],
      ["browser-runtime", PAGE, ...ASSERTION_STATUS[row.result]],
      `${row.id} paired assertion`,
    );
    assert.deepEqual(paired.evidence.qc.observation, row.observation, `${row.id} assertion carries the row's observation`);
    const persisted = JSON.stringify([row, paired]);
    for (const text of [LINK_TEXT_MARKER, "Email us", ...forbidden]) assert.equal(persisted.includes(text), false, `${row.id}: nothing persisted holds ${JSON.stringify(text)}`);
  }

  const { loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { readQaResults } = await import("./qc-results.mjs");
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const read = readQaResults({
    stageEvidence: { qc_results: rows, qc_build_fingerprint: BUILD },
    stage: { identity: { verdict_run_id: RUN_ID } },
    fullVerdict: verdictOf(qcAssertions, measuredAt),
    currentBuild: BUILD,
    rederivers: await loadQcRederivers(),
  });
  const project = (entry) => [entry.id, entry.subject, entry.result, entry.reason_code, entry.state_fingerprint, entry.members, entry.accept_eligible, entry.coverage];
  assert.deepEqual(read.map(project).sort(byFirst), rows.map(project).sort(byFirst), "the 1.0 QA reader re-derives exactly the run's rows with the real module");
  return { rows: new Map(rows.map((row) => [row.id, row])), read: new Map(read.map((row) => [row.id, row])) };
}

const COUNT_KEYS = ["pages_expected", "pages_read", "pages_with_match", "path_match_query_differs", "label_declared", "label_anchor_mismatch_pages", "hint_anchor_elsewhere"];
const counts = (pagesExpected, pagesRead, withMatch, queryDiffers, labelDeclared, labelMismatchPages, hintElsewhere) => ({
  pages_expected: pagesExpected,
  pages_read: pagesRead,
  pages_with_match: withMatch,
  path_match_query_differs: queryDiffers,
  label_declared: labelDeclared,
  label_anchor_mismatch_pages: labelMismatchPages,
  hint_anchor_elsewhere: hintElsewhere,
});

const identityOf = (url) => {
  if (url == null || !/^https?:/.test(url)) return null;
  const { protocol, host, pathname } = new URL(url);
  return { url_sha256: sha256(`${protocol}//${host}${pathname}`), path_sha256: sha256(pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname), host_sha256: sha256(host.replace(/^www\./, "")) };
};

// The contract's presence accept state.
const presenceState = (reasonCode, configured, configuredQuery, presence) => ({
  reason_code: reasonCode,
  configured,
  configured_query_sha256: configuredQuery,
  configured_identity: identityOf(configured),
  pages_expected: presence.pages_expected,
  pages_read: presence.pages_read,
  pages_with_match: presence.pages_with_match,
  path_match_query_differs: presence.path_match_query_differs,
  label_anchor_mismatch_pages: presence.label_anchor_mismatch_pages,
  hint_anchor_elsewhere: presence.hint_anchor_elsewhere,
});

// One expected row, in the producer's rows and in the reader's: id, subject,
// result, reason code, members, accept eligibility and coverage exactly, and
// (when given) the state fingerprint of the contract's exact accept state.
function assertRowBoth(policy, check, field, { result, reasonCode, acceptEligible, coverage, fingerprint }) {
  const id = idOf(check, field);
  for (const [side, row] of [["producer", policy.rows.get(id)], ["reader", policy.read.get(id)]]) {
    assert.ok(row, `${side}: ${id} is listed`);
    assert.deepEqual(
      [row.id, row.subject, row.result, row.reason_code, row.members, row.accept_eligible, row.coverage],
      [id, subjectOf(check, field), result, reasonCode, [], acceptEligible, coverage],
      `${side}: ${id} reads ${result} / ${reasonCode}, accept_eligible ${acceptEligible}, no members, coverage ${JSON.stringify(coverage)}`,
    );
    if (fingerprint !== undefined) assert.equal(row.state_fingerprint, fingerprint, `${side}: ${id} is bound to the contract's exact ${check} state`);
  }
  return policy.rows.get(id);
}

// The presence row of `field`: result, reason code, accept eligibility,
// members and coverage (pages read of pages expected), the observation's
// identity fields and every presence count exactly, and the state fingerprint
// of the contract's exact accept state.
async function assertPresence(policy, field, { result, reasonCode, acceptEligible, presence, configured, query = null, scheme = "http" }) {
  const { qcStateFingerprint } = await import("./qc-results.mjs");
  const queryHash = query == null ? null : sha256(query);
  const coverage = { observed: presence.pages_read, expected: presence.pages_expected, limits: reasonCode === "pages_not_read" ? ["pages_not_read"] : [] };
  const fingerprint = qcStateFingerprint({ subject: subjectOf("policy.presence", field), state: presenceState(reasonCode, configured, queryHash, presence) });
  const row = assertRowBoth(policy, "policy.presence", field, { result, reasonCode, acceptEligible, coverage, fingerprint });
  const observation = row.observation || {};
  assert.deepEqual(
    [observation.check, observation.field, observation.scheme, observation.configured, observation.configured_query_sha256],
    ["policy.presence", field, scheme, configured, queryHash],
    `${row.id} observation identity`,
  );
  assert.deepEqual(Object.fromEntries(COUNT_KEYS.map((key) => [key, observation.presence?.[key]])), presence, `${row.id} presence counts`);
  return row;
}

// The availability row of a configured loopback policy page answering 200
// text/html directly: pass, with its one-hop chain and coverage {1, 1, []}.
async function assertAvailabilityPass(policy, field, { configured, query = null }) {
  const { qcStateFingerprint } = await import("./qc-results.mjs");
  const queryHash = query == null ? null : sha256(query);
  const availability = { chain: [{ url: configured, query_sha256: queryHash, status: 200 }], final: configured, final_query_sha256: queryHash, status: 200, content_type: "text/html", outcome: "pass" };
  const { outcome: _outcome, ...measured } = availability;
  const fingerprint = qcStateFingerprint({ subject: subjectOf("policy.availability", field), state: { reason_code: null, configured, configured_query_sha256: queryHash, configured_identity: identityOf(configured), ...measured, chain_identity: [identityOf(configured)], next_hop_identity: null } });
  const row = assertRowBoth(policy, "policy.availability", field, { result: "pass", reasonCode: null, acceptEligible: false, coverage: { observed: 1, expected: 1, limits: [] }, fingerprint });
  const observation = row.observation || {};
  assert.deepEqual(
    [observation.check, observation.field, observation.scheme, observation.configured, observation.configured_query_sha256],
    ["policy.availability", field, "http", configured, queryHash],
    `${row.id} observation identity`,
  );
  assert.deepEqual(Object.fromEntries(Object.keys(availability).map((key) => [key, observation.availability?.[key]])), availability, `${row.id} availability block`);
}

// Exactly one GET per distinct configured http URL (`paths`), each header-only:
// its connection closed within CLOSE_WITHIN_MS of its headers, before the slow
// body ended.
async function assertProbes(run, paths) {
  assert.deepEqual(
    run.policyRequests.map((entry) => `${entry.method} ${entry.path}`).sort(),
    paths.map((path) => `GET ${path}`).sort(),
    "the run's availability probes are exactly one GET per distinct configured http URL",
  );
  const ends = await Promise.all(run.policyEnds.map(async ({ path, closed }) => ({ path, ...(await endOf(closed)) })));
  assert.deepEqual(
    ends.map(({ path, finished, afterMs }) => [path, finished, afterMs <= CLOSE_WITHIN_MS]).sort(byFirst),
    [...paths].sort().map((path) => [path, false, true]),
    `every probe's connection closed within ${CLOSE_WITHIN_MS} ms of its headers, before its body ended (${ends.map(({ afterMs }) => Math.round(afterMs)).join(", ")} ms)`,
  );
}

// ---------------------------------------------------------------------------
// Rows

browserTest("F1.4-W1 relative href resolved via <base> equals store_terms: presence pass", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/w1/" }], { store_terms: url("/policy/terms") });
  const policy = await policyRows(run, ["store_terms"]);
  await assertPresence(policy, "store_terms", { result: "pass", reasonCode: null, acceptEligible: false, configured: url("/policy/terms"), presence: counts(1, 1, 1, 0, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertProbes(run, ["/policy/terms"]);
});

browserTest("F1.4-W3 configured /terms, rendered /terms/: presence pass", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/w3/" }], { store_terms: url("/policy/terms") });
  const policy = await policyRows(run, ["store_terms"]);
  await assertPresence(policy, "store_terms", { result: "pass", reasonCode: null, acceptEligible: false, configured: url("/policy/terms"), presence: counts(1, 1, 1, 0, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertProbes(run, ["/policy/terms"]);
});

browserTest("F1.4-W5 store_contact: \"mailto:x@example.invalid\" rendered as a mailto anchor: presence pass", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/w5/" }], { store_contact: "mailto:x@example.invalid" });
  const policy = await policyRows(run, ["store_contact"]);
  await assertPresence(policy, "store_contact", { result: "pass", reasonCode: null, acceptEligible: false, configured: "mailto:x@example.invalid", scheme: "mailto", presence: counts(1, 1, 1, 0, false, 0, 0) });
  // The mailto: value's availability is declared data: excluded, nothing read,
  // and no request.
  const availability = assertRowBoth(policy, "policy.availability", "store_contact", { result: "excluded", reasonCode: "non_http_destination", acceptEligible: false, coverage: { observed: 0, expected: null, limits: [] } });
  const observation = availability.observation || {};
  assert.deepEqual(
    [observation.check, observation.field, observation.scheme, observation.configured, observation.configured_query_sha256, observation.availability?.chain, observation.availability?.outcome],
    ["policy.availability", "store_contact", "mailto", "mailto:x@example.invalid", null, [], "non_http_destination"],
    `${availability.id} observation: the mailto: value, no request`,
  );
  await assertProbes(run, []);
});

browserTest("F1.4-B1 no visited page links store_privacy: presence warning (policy_link_absent)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/b1/" }], { store_privacy: url("/policy/privacy") });
  const policy = await policyRows(run, ["store_privacy"]);
  await assertPresence(policy, "store_privacy", { result: "warning", reasonCode: "policy_link_absent", acceptEligible: true, configured: url("/policy/privacy"), presence: counts(1, 1, 0, 0, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_privacy", { configured: url("/policy/privacy") });
  await assertProbes(run, ["/policy/privacy"]);
});

// B2 and B10: footer_links declares "Terms" for store_terms; the rendered
// "Terms" anchor points to the contact URL.
const mislabelledCampaign = () => ({
  store_terms: url("/policy/terms"),
  store_contact: url("/policy/contact"),
  footer_links: [{ label: "Terms", url: url("/policy/terms"), required: true }],
});

browserTest("F1.4-B2 footer_links label \"Terms\" -> store_terms; rendered \"Terms\" anchor points to the contact URL: presence warning (destination_mismatch)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/b2/" }], mislabelledCampaign());
  const policy = await policyRows(run, ["store_contact", "store_terms"]);
  await assertPresence(policy, "store_terms", { result: "warning", reasonCode: "destination_mismatch", acceptEligible: true, configured: url("/policy/terms"), presence: counts(1, 1, 0, 0, true, 1, 1) });
  // The anchor does reach the contact URL, and no contact label is declared.
  await assertPresence(policy, "store_contact", { result: "pass", reasonCode: null, acceptEligible: false, configured: url("/policy/contact"), presence: counts(1, 1, 1, 0, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertAvailabilityPass(policy, "store_contact", { configured: url("/policy/contact") });
  await assertProbes(run, ["/policy/contact", "/policy/terms"]);
});

browserTest("F1.4-B5 configured /terms?version=2; rendered /terms?version=1: presence warning (policy_link_query_differs)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/b5/" }], { store_terms: url("/policy/terms?version=2") });
  // Queries are compared in memory and kept only as hashes.
  const policy = await policyRows(run, ["store_terms"], { forbidden: ["version=1", "version=2"] });
  await assertPresence(policy, "store_terms", { result: "warning", reasonCode: "policy_link_query_differs", acceptEligible: true, configured: url("/policy/terms"), query: "version=2", presence: counts(1, 1, 0, 1, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms"), query: "version=2" });
  await assertProbes(run, ["/policy/terms?version=2"]);
});

browserTest("F1.4-B6 no matching anchor; no footer_links; an anchor with text \"Terms\" points elsewhere: presence warning, hint recorded (policy_link_absent)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/b6/" }], { store_terms: url("/policy/terms") });
  const policy = await policyRows(run, ["store_terms"]);
  await assertPresence(policy, "store_terms", { result: "warning", reasonCode: "policy_link_absent", acceptEligible: true, configured: url("/policy/terms"), presence: counts(1, 1, 0, 0, false, 0, 1) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertProbes(run, ["/policy/terms"]);
});

// Two runBrowserChecks calls of two pages each: twice the 120 s bound.
browserTest("F1.4-B10 accepted F1.4-B2; the mislabelled anchor now also renders on a second page: accept lapsed (state_changed)", { timeout: 240_000 }, async (t) => {
  const { assessQcAccepts, createQcAccept, qcAcceptAttribution } = await import("./qc-accept.mjs");
  await stubServer();
  t.after(() => { b10Second = false; });
  const pages = [{ id: "a", path: "/b10/a/" }, { id: "b", path: "/b10/b/" }];
  const id = idOf("policy.presence", "store_terms");

  // Every result of each run, with its exact expected values: store_terms
  // presence (the warning under accept), store_contact presence (the "Terms"
  // anchor reaches the contact URL on every page that renders it, and no
  // contact label is declared), both availability passes, and exactly one
  // header-only probe per configured URL.
  const assertRun = async (run, policy, { mislabelledPages }) => {
    await assertPresence(policy, "store_terms", { result: "warning", reasonCode: "destination_mismatch", acceptEligible: true, configured: url("/policy/terms"), presence: counts(2, 2, 0, 0, true, mislabelledPages, mislabelledPages) });
    await assertPresence(policy, "store_contact", { result: "pass", reasonCode: null, acceptEligible: false, configured: url("/policy/contact"), presence: counts(2, 2, mislabelledPages, 0, false, 0, 0) });
    await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
    await assertAvailabilityPass(policy, "store_contact", { configured: url("/policy/contact") });
    await assertProbes(run, ["/policy/contact", "/policy/terms"]);
  };

  b10Second = false;
  const first = await runPages(pages, mislabelledCampaign());
  const measured = await policyRows(first, ["store_contact", "store_terms"]);
  await assertRun(first, measured, { mislabelledPages: 1 });
  const accepted = measured.read.get(id);
  const attribution = qcAcceptAttribution({ reason: "known synthetic", acceptedBy: OPERATOR, now: new Date().toISOString() });
  const record = createQcAccept(accepted, { measuredAt: accepted.measured_at, attribution });
  assert.deepEqual(assessQcAccepts([record], [...measured.read.values()]).map(({ status, why }) => [status, why]), [["active", null]], "setup: the accept is active on the measured state");

  b10Second = true;
  const second = await runPages(pages, mislabelledCampaign());
  const current = await policyRows(second, ["store_contact", "store_terms"]);
  await assertRun(second, current, { mislabelledPages: 2 });
  assert.notEqual(current.read.get(id).state_fingerprint, accepted.state_fingerprint, "the state fingerprint moved");
  assert.deepEqual(assessQcAccepts([record], [...current.read.values()]).map(({ status, why }) => [status, why]), [["lapsed", "state_changed"]], "the accept lapses");
});

browserTest("F1.4-I6 matching anchor present; an anchor with text \"Terms\" also points elsewhere; no footer_links: presence review (possible_policy_link_mismatch)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "index", path: "/i6/" }], { store_terms: url("/policy/terms") });
  const policy = await policyRows(run, ["store_terms"]);
  await assertPresence(policy, "store_terms", { result: "review", reasonCode: "possible_policy_link_mismatch", acceptEligible: false, configured: url("/policy/terms"), presence: counts(1, 1, 1, 0, false, 0, 1) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertProbes(run, ["/policy/terms"]);
});

browserTest("F1.4-I10 two enabled pages; page A links store_terms; page B times out before its anchors are read: presence unexercised (pages_not_read)", T, async () => {
  await stubServer();
  const run = await runPages([{ id: "a", path: "/i10/a/" }, { id: "b", path: "/i10/b/" }], { store_terms: url("/policy/terms") });
  const policy = await policyRows(run, ["store_terms"]);
  await assertPresence(policy, "store_terms", { result: "unexercised", reasonCode: "pages_not_read", acceptEligible: false, configured: url("/policy/terms"), presence: counts(2, 1, 1, 0, false, 0, 0) });
  await assertAvailabilityPass(policy, "store_terms", { configured: url("/policy/terms") });
  await assertProbes(run, ["/policy/terms"]);
});
