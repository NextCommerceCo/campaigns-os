import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgs } from "./cli.mjs";
import { REFUSED_INVOCATION } from "./lifecycle.mjs";
import { resolveCartEntryPage } from "./qa-cart-entry.mjs";
import { QA_RUN_CURRENCY, __qaBrowserTestHooks } from "./qa-browser.mjs";
import { __qaNodeTestHooks, runQaCli } from "./qa-node.mjs";
import { createTrackingRun } from "./qa-tracking-params.mjs";

const { deriveEntryUrls, qaRunCurrency, runPageChecks, runResolvedQa, withEntryCurrency } = __qaNodeTestHooks;
const { createSelectorProbeCache, enterCartViaLanding, openCheckoutForPath, pathCurrencyLoad, recoverCreatedOrder } = __qaBrowserTestHooks;

// The entry page already carries tracking params: --currency must keep them.
const LANDING_URL = "https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring%20sale";
const CHECKOUT_URL = "https://shop.example.com/offer/checkout/";

function topologies() {
  return [{
    funnel_id: "default",
    funnel_name: "Default",
    weight: 100,
    pages: [
      { page_id: "landing", page_type: "landing", order: 1, label: "Landing", url: LANDING_URL, expected_next_url: CHECKOUT_URL, packages: [] },
      { page_id: "checkout", page_type: "checkout", order: 2, label: "Checkout", url: CHECKOUT_URL, packages: [] },
    ],
  }];
}

test("--currency parses from the command line and is upper-cased; absent, there is no currency", async () => {
  const { result } = await runWith(parseArgs(["qa", "run", "--currency", "gbp"]));
  assert.equal(new URL(result.entry_urls[0].url).searchParams.get("currency"), "GBP");
  assert.equal(qaRunCurrency(parseArgs(["qa", "run", "--packet", "p.json", "--currency", "gbp"])), "GBP");
  assert.equal(qaRunCurrency(parseArgs(["qa", "run", "--currency", "Eur", "--json"])), "EUR");
  assert.equal(qaRunCurrency({ currency: "USD" }), "USD");
  assert.equal(qaRunCurrency(parseArgs(["qa", "run", "--packet", "p.json"])), null);
});

test("an invalid --currency is refused with a clear message, before anything resolves or is fetched", async () => {
  for (const argv of [["--currency"], ["--currency", "GB"], ["--currency", "GBPX"], ["--currency", "GBP,EUR"], ["--currency", "G1P"], ["--currency", " GBP"], ["--currency", "ÉUR"], ["--currency", "£"]]) {
    const args = parseArgs(["qa", "run", ...argv]);
    assert.throws(() => qaRunCurrency(args), (error) => {
      assert.equal(error.code, REFUSED_INVOCATION, argv.join(" "));
      assert.match(error.message, /^--currency takes one three-letter currency code, such as GBP or EUR \(got .+\)\. Run qa run once per currency\.$/);
      return true;
    });
  }
  assert.match(String(captureRefusal(() => qaRunCurrency(parseArgs(["qa", "run", "--currency"]))).message), /\(got no value\)/);

  // Through `qa run` itself: the packet does not exist and fetch is poisoned,
  // so the currency refusal can only win by being checked first.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => assert.fail(`no request before --currency is valid (got ${String(url)})`);
  try {
    await assert.rejects(
      runQaCli(parseArgs(["qa", "run", "--packet", join(tmpdir(), "missing-campaign-runtime.build.json"), "--currency", "pounds", "--no-post-verdict", "--json"])),
      (error) => error.code === REFUSED_INVOCATION && /^--currency takes one three-letter currency code/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function captureRefusal(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test("the entry URL carries ?currency=<CODE> beside its existing query; other pages and the input are unchanged", async () => {
  const run = await runWith({ currency: "GBP" });
  assert.deepEqual(run.result.page_urls.map((entry) => entry.url), [
    "https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP",
    CHECKOUT_URL,
  ]);

  const input = topologies();
  const { topologies: tagged, entryPages } = withEntryCurrency(input, "GBP");
  const landing = tagged[0].pages[0];
  assert.equal(landing.url, "https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP");
  const params = new URL(landing.url).searchParams;
  assert.equal(params.get("utm_source"), "newsletter");
  assert.equal(params.get("utm_campaign"), "spring sale");
  assert.equal(params.get("currency"), "GBP");
  assert.equal(tagged[0].pages[1].url, CHECKOUT_URL);
  assert.deepEqual([...entryPages], [landing]);
  assert.equal(input[0].pages[0].url, LANDING_URL, "the resolved topologies are not mutated");
  assert.deepEqual(deriveEntryUrls(tagged).map((entry) => entry.url), [landing.url]);

  // An entry URL that already names a currency gets the run's, once; a
  // fragment survives; a partial build enters at its first in-scope page.
  const named = withEntryCurrency([{ funnel_id: "a", pages: [{ page_id: "p", page_type: "presell", url: "https://shop.example.com/a/?currency=USD&ref=x#top" }] }], "EUR");
  assert.equal(named.topologies[0].pages[0].url, "https://shop.example.com/a/?currency=EUR&ref=x#top");
  const partial = withEntryCurrency([{ funnel_id: "b", partial_build_scope: true, pages: [{ page_id: "checkout", page_type: "checkout", url: CHECKOUT_URL }, { page_id: "up", page_type: "upsell", url: "https://shop.example.com/offer/upsell/" }] }], "EUR");
  assert.deepEqual(partial.topologies[0].pages.map((page) => page.url), [`${CHECKOUT_URL}?currency=EUR`, "https://shop.example.com/offer/upsell/"]);

  // The test-order runner enters through the same tagged page, and its own
  // load of a checkout carries the currency beside any query the URL has.
  const checkoutPage = tagged[0].pages[1];
  assert.equal(resolveCartEntryPage(tagged, checkoutPage).url, landing.url);
});

// The args runResolvedQa hands the order runner: the flag as typed, and the
// validated code under the key only qa-node.mjs sets.
function runArgs(code) {
  return { "browser-timeout": 1000, currency: code, [QA_RUN_CURRENCY]: code };
}

// A Playwright-shaped page for the cart-entry and checkout steps. `answers`
// are what successive page.evaluate calls return: the selector probe reads
// the checkout's selection surface, the entry page's control read returns no
// control, so the entry step stops (coded) right after the entry load.
function fakeRunnerPage(answers = []) {
  let at = "about:blank";
  const page = {
    loads: [],
    url: () => at,
    goto: async (url) => { page.loads.push(url); at = url; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    evaluate: async () => answers.shift(),
  };
  return page;
}

const SURFACE = { count: 1, kinds: { package_card: 1 }, excluded: 0 };
const NO_SURFACE = { count: 0, kinds: {}, excluded: 0 };

async function enterCart({ page, args, entryPage, selectorProbeCache = null, tracking = null, currencyLoad }) {
  return enterCartViaLanding({ page, checkoutPage: { page_id: "checkout", url: CHECKOUT_URL }, entryPage, selectedPackages: [], args, budget: () => 1000, selectorProbeCache, tracking, currencyLoad })
    .catch((error) => ({ error }));
}

test("the order runner's own load of the checkout carries ?currency=<CODE>; without --currency it is the plain URL", async () => {
  const loads = async (args) => {
    const page = fakeRunnerPage();
    await openCheckoutForPath({ page, checkoutPage: { page_id: "checkout", url: `${CHECKOUT_URL}?utm_source=newsletter` }, entry: null, args, currencyLoad: pathCurrencyLoad(args) });
    return page.loads;
  };
  assert.deepEqual(await loads(runArgs("GBP")), [`${CHECKOUT_URL}?utm_source=newsletter&currency=GBP`]);
  assert.deepEqual(await loads({ "browser-timeout": 1000 }), [`${CHECKOUT_URL}?utm_source=newsletter`]);
});

test("each order path carries ?currency=<CODE> on its first runner load only; later loads in that tab are the plain URL", async () => {
  // The probe is the path's first load: it carries the currency, and a later
  // runner load of the checkout in the same tab does not.
  const probed = fakeRunnerPage([SURFACE]);
  const currencyLoad = pathCurrencyLoad(runArgs("GBP"));
  const skipped = await enterCart({ page: probed, args: runArgs("GBP"), entryPage: null, currencyLoad });
  assert.match(String(skipped.skip), /checkout carries its own package selection surface/);
  assert.equal(await openCheckoutForPath({ page: probed, checkoutPage: { page_id: "checkout", url: CHECKOUT_URL }, entry: skipped, args: runArgs("GBP"), currencyLoad }), "already on checkout from the selector probe; not re-opened");
  await probed.goto("about:blank");
  await openCheckoutForPath({ page: probed, checkoutPage: { page_id: "checkout", url: CHECKOUT_URL }, entry: skipped, args: runArgs("GBP"), currencyLoad });
  assert.deepEqual(probed.loads, [`${CHECKOUT_URL}?currency=GBP`, "about:blank", CHECKOUT_URL]);

  // A later path of the same plan reuses the probe answer, so its first load
  // is the checkout opened directly: a new path, a new tab, the currency again.
  const cache = createSelectorProbeCache();
  cache.set(CHECKOUT_URL, SURFACE);
  const reused = fakeRunnerPage();
  const nextLoad = pathCurrencyLoad(runArgs("GBP"));
  const entry = await enterCart({ page: reused, args: runArgs("GBP"), entryPage: null, selectorProbeCache: cache, currencyLoad: nextLoad });
  await openCheckoutForPath({ page: reused, checkoutPage: { page_id: "checkout", url: CHECKOUT_URL }, entry, args: runArgs("GBP"), currencyLoad: nextLoad });
  assert.deepEqual(reused.loads, [`${CHECKOUT_URL}?currency=GBP`]);
});

test("the landing entry load carries ?currency=<CODE>: from the tagged entry URL, and as the path's first load when the probe answer is reused", async () => {
  const tagged = withEntryCurrency(topologies(), "GBP").topologies;
  const entryPage = resolveCartEntryPage(tagged, tagged[0].pages[1]);
  const taggedLanding = "https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP";
  assert.equal(entryPage.url, taggedLanding);

  // Probe loaded (first load, carries it), then the entry page as tagged.
  const page = fakeRunnerPage([NO_SURFACE, []]);
  const outcome = await enterCart({ page, args: runArgs("GBP"), entryPage, currencyLoad: pathCurrencyLoad(runArgs("GBP")) });
  assert.equal(outcome.error?.code, "cart_entry_control_missing");
  assert.deepEqual(page.loads, [`${CHECKOUT_URL}?currency=GBP`, taggedLanding]);

  // Probe answer reused: the entry load is the path's first, and carries the
  // currency even from an entry URL that was not tagged.
  const cache = createSelectorProbeCache();
  cache.set(CHECKOUT_URL, NO_SURFACE);
  const reused = fakeRunnerPage([[]]);
  await enterCart({ page: reused, args: runArgs("GBP"), entryPage: { page_id: "landing", url: LANDING_URL }, selectorProbeCache: cache, currencyLoad: pathCurrencyLoad(runArgs("GBP")) });
  assert.deepEqual(reused.loads, ["https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP"]);

  // Without --currency the same two paths load the resolved URLs.
  const plain = fakeRunnerPage([NO_SURFACE, []]);
  await enterCart({ page: plain, args: { "browser-timeout": 1000 }, entryPage: { page_id: "landing", url: LANDING_URL }, currencyLoad: pathCurrencyLoad({ "browser-timeout": 1000 }) });
  assert.deepEqual(plain.loads, [CHECKOUT_URL, LANDING_URL]);
});

test("the currency goes on before the tracking observer's seeds, and a seeded runner load keeps both", async () => {
  const run = createTrackingRun({ runId: "qa-currency-run", random: () => Buffer.from([1, 2, 3, 4]) });
  const tracking = run.observe("checkout");
  const page = fakeRunnerPage([SURFACE]);
  await enterCart({ page, args: runArgs("EUR"), entryPage: null, tracking, currencyLoad: pathCurrencyLoad(runArgs("EUR")) });
  assert.equal(page.loads.length, 1);
  const loaded = new URL(page.loads[0]);
  const keys = [...loaded.searchParams.keys()];
  assert.equal(keys[0], "currency");
  assert.equal(loaded.searchParams.get("currency"), "EUR");
  assert.deepEqual(keys.slice(1).sort(), Object.keys(run.seeds).sort());
  for (const [name, value] of Object.entries(run.seeds)) assert.equal(loaded.searchParams.get(name), value);
});

test("the receipt reload in recovery is the plain receipt URL, never a currency load", async () => {
  const visited = [];
  const page = {
    on() {},
    setDefaultTimeout() {},
    goto: async (url) => { visited.push(url); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    evaluate: async () => { throw new Error("stop after the reload"); },
    close: async () => {},
  };
  const receiptUrl = "https://shop.example.com/offer/receipt/?ref_id=ref-1";
  await recoverCreatedOrder({
    context: { newPage: async () => page },
    attempt: { ok: false, error: "receipt read failed", order: { path: "checkout", ok: true, ref_id: "ref-1", final_url: receiptUrl, verification: {}, evidence: {} } },
    checkoutPage: { page_id: "checkout", page_type: "checkout", url: CHECKOUT_URL },
    args: runArgs("GBP"),
  }).catch(() => null);
  assert.deepEqual(visited, [receiptUrl]);
});

test("the runner reads only the validated run currency: a raw --currency on args (qa parity, an unvalidated value) loads the plain URL", async () => {
  for (const args of [{ "browser-timeout": 1000, currency: "GBP" }, { "browser-timeout": 1000, currency: "gbp" }, { "browser-timeout": 1000, [QA_RUN_CURRENCY]: "gbp" }, { "browser-timeout": 1000, [QA_RUN_CURRENCY]: "GBP,EUR" }]) {
    const page = fakeRunnerPage();
    await openCheckoutForPath({ page, checkoutPage: { page_id: "checkout", url: CHECKOUT_URL }, entry: null, args, currencyLoad: pathCurrencyLoad(args) });
    assert.deepEqual(page.loads, [CHECKOUT_URL]);
  }
});

test("qa parity --currency is refused before anything is read or launched", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => assert.fail(`no request for a refused qa parity (got ${String(url)})`);
  try {
    for (const argv of [["--currency", "GBP"], ["--currency"]]) {
      await assert.rejects(
        runQaCli(parseArgs(["qa", "parity", "--fixture", join(tmpdir(), "missing-parity-fixture.json"), "--scenario", "s1", ...argv, "--no-post-verdict", "--json"])),
        (error) => error.code === REFUSED_INVOCATION && /^qa parity does not support --currency/.test(error.message),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("--legacy-api-test-order with --currency is refused before any request; an active --test-order still takes precedence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => assert.fail(`no request before the refusal (got ${String(url)})`);
  const missing = join(tmpdir(), "missing-campaign-runtime.build.json");
  try {
    await assert.rejects(
      runQaCli(parseArgs(["qa", "run", "--packet", missing, "--legacy-api-test-order", "accept", "--cart", "1:1", "--currency", "GBP", "--no-post-verdict", "--json"])),
      (error) => error.code === REFUSED_INVOCATION && /^--currency is not supported with --legacy-api-test-order/.test(error.message),
    );
    // The browser order runs instead of the legacy one, so the currency is
    // honoured and this run fails later (the packet is missing), not here.
    await assert.rejects(
      runQaCli(parseArgs(["qa", "run", "--packet", missing, "--test-order", "checkout", "--legacy-api-test-order", "accept", "--currency", "GBP", "--no-post-verdict", "--json"])),
      (error) => !/--currency/.test(error.message),
    );
    // runResolvedQa refuses it too, before the page fetches.
    await assert.rejects(
      runResolvedQa({ _: ["qa", "run"], "no-post-verdict": true, json: true, currency: "GBP", "legacy-api-test-order": "both", cart: "1:1" }, resolvedFixture(missing)),
      (error) => error.code === REFUSED_INVOCATION && /^--currency is not supported with --legacy-api-test-order/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an empty --currency value reads as no value, like a bare flag", () => {
  for (const args of [{ currency: "" }, { currency: true }, parseArgs(["qa", "run", "--currency", ""])]) {
    assert.match(String(captureRefusal(() => qaRunCurrency(args))?.message), /\(got no value\)/);
  }
  assert.match(String(captureRefusal(() => qaRunCurrency({ currency: "GB" }))?.message), /\(got "GB"\)/);
});

function resolvedFixture(packetPath) {
  const spec = {
    schema_version: "4.3",
    campaign: { currency: "USD" },
    funnels: [{ id: "default", pages: [
      { id: "landing", type: "landing", order: 1 },
      { id: "checkout", type: "checkout", order: 2 },
    ] }],
  };
  return {
    themeGate: { status: "not_applicable", code: "theme_gate.no_theme_context", reason: "Test fixture has no theme context." },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "Test fixture has no assembly report." },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath,
    packet: null,
    mapId: "currency-run",
    publicRouteSlug: "offer",
    proxyBase: "https://proxy.example.test",
    baseUrl: "https://shop.example.com/offer/",
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec: spec,
    spec,
    specVersion: "4.3",
    specHash: "sha256:test",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: topologies(),
  };
}

async function runWith(extraArgs, { topologies: entryTopologies = null } = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-currency-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  const fetched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).startsWith("https://shop.example.com/")) return new Response("<!doctype html><html><head><title>Offer</title></head><body></body></html>", { status: 200 });
    throw new Error(`Unexpected fetch: ${String(url)}`);
  };
  try {
    const resolved = resolvedFixture(packetPath);
    if (entryTopologies) resolved.topologies = entryTopologies;
    const result = await runResolvedQa({ _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, "no-live-refs": true, json: true, ...extraArgs }, resolved);
    const persisted = JSON.parse(readFileSync(result.local_path, "utf8"));
    return { result, persisted, fetched };
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
  }
}

// The verdict with the per-run values (ids, times, the currency's own row
// detail and the entry URL it changed) set aside, for comparing shapes.
function shape(verdict) {
  return verdict.assertions.map((entry) => ({ id: entry.id, family: entry.family, page: entry.page, status: entry.status, severity: entry.severity ?? null, keys: Object.keys(entry).sort() }));
}

test("--currency fetches the entry page with ?currency=<CODE> and the verdict records it on the entry page's http row", async () => {
  const { result, persisted, fetched } = await runWith({ currency: "gbp" });
  const landingFetches = fetched.filter((url) => url.startsWith("https://shop.example.com/offer/?"));
  assert.ok(landingFetches.length > 0);
  for (const url of landingFetches) assert.equal(url, "https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP");
  assert.ok(fetched.includes(CHECKOUT_URL), "a non-entry page is fetched as resolved");
  assert.deepEqual(result.entry_urls.map((entry) => entry.url), ["https://shop.example.com/offer/?utm_source=newsletter&utm_campaign=spring+sale&currency=GBP"]);

  // Where the currency shows in the persisted verdict JSON: the entry page's
  // http:<page_id> row, evidence.currency. Every URL query is redacted there.
  for (const verdict of [result.verdict, persisted]) {
    const landingRow = verdict.assertions.find((entry) => entry.id === "http:landing");
    assert.equal(landingRow.status, "pass");
    assert.deepEqual(landingRow.evidence, { currency: "GBP" });
    assert.equal(verdict.assertions.find((entry) => entry.id === "http:checkout").evidence, undefined);
    const rowsWithCurrency = verdict.assertions.filter((entry) => JSON.stringify(entry).includes("GBP"));
    assert.deepEqual(rowsWithCurrency.map((entry) => entry.id), ["http:landing"]);
  }
});

test("control: without --currency the run fetches the resolved URLs and the verdict has the same rows, with no currency detail", async () => {
  const plain = await runWith({});
  const gbp = await runWith({ currency: "GBP" });
  assert.deepEqual([...new Set(plain.fetched)].sort(), [CHECKOUT_URL, LANDING_URL].sort());
  assert.deepEqual(plain.result.entry_urls.map((entry) => entry.url), [LANDING_URL]);
  assert.deepEqual(plain.result.page_urls.map((entry) => entry.url), [LANDING_URL, CHECKOUT_URL]);
  assert.equal(plain.persisted.assertions.find((entry) => entry.id === "http:landing").evidence, undefined);
  assert.equal(JSON.stringify(plain.persisted).includes("currency\":\"GBP"), false);
  assert.deepEqual(Object.keys(plain.persisted).sort(), Object.keys(gbp.persisted).sort());
  // The one row-shape difference a currency run makes is that row's evidence.
  assert.deepEqual(gbp.persisted.assertions.find((entry) => entry.id === "http:landing").evidence, { currency: "GBP" });
  const withoutCurrencyDetail = shape(gbp.persisted).map((row) => (row.id === "http:landing" ? { ...row, keys: row.keys.filter((key) => key !== "evidence") } : row));
  assert.deepEqual(shape(plain.persisted), withoutCurrencyDetail);
  assert.equal(plain.persisted.disposition, gbp.persisted.disposition);
});

test("an entry URL that does not parse keeps its row status, and its http row says the currency was not applied", async () => {
  const unparseable = () => {
    const tree = topologies();
    tree[0].pages[0] = { ...tree[0].pages[0], url: "shop.example.com/offer/" };
    return tree;
  };
  const { topologies: tagged, entryPages, notApplied } = withEntryCurrency(unparseable(), "GBP");
  assert.equal(tagged[0].pages[0].url, "shop.example.com/offer/");
  assert.equal(entryPages.size, 0);
  assert.deepEqual([...notApplied.values()], [{ currency: "GBP", reason: "entry URL does not parse as an absolute URL" }]);

  const plain = await runWith({}, { topologies: unparseable() });
  const gbp = await runWith({ currency: "GBP" }, { topologies: unparseable() });
  assert.equal(gbp.fetched.some((url) => url.includes("currency=")), false);
  for (const verdict of [gbp.result.verdict, gbp.persisted]) {
    const row = verdict.assertions.find((entry) => entry.id === "http:landing");
    const plainRow = plain.persisted.assertions.find((entry) => entry.id === "http:landing");
    assert.equal(row.status, plainRow.status);
    assert.equal(row.severity, plainRow.severity);
    assert.deepEqual(row.evidence, { ...plainRow.evidence, currency_not_applied: { currency: "GBP", reason: "entry URL does not parse as an absolute URL" } });
    assert.equal(Object.hasOwn(row.evidence, "currency"), false);
  }
  assert.deepEqual(shape(plain.persisted), shape(gbp.persisted));
  assert.equal(plain.persisted.disposition, gbp.persisted.disposition);
});

test("an entry page whose fetch fails still records the currency beside the transport error", async () => {
  const page = { page_id: "landing", page_type: "landing", url: `${LANDING_URL}&currency=GBP` };
  const failing = async () => ({ ok: false, error_code: "http_status", status: 503, status_text: "Service Unavailable", error: "HTTP 503" });
  const { assertions } = await runPageChecks(page, {}, { sourceLoader: failing, bindingScriptLoader: async () => null, currency: "GBP" });
  const row = assertions.find((entry) => entry.id === "http:landing");
  assert.equal(row.status, "fail");
  assert.equal(row.actual, "503 Service Unavailable");
  assert.deepEqual(row.evidence, { transport_error: { code: "http_status", message: "HTTP 503" }, currency: "GBP" });

  const { assertions: unreached } = await runPageChecks(page, {}, { sourceLoader: async () => ({ ok: false, error_code: "fetch_failed", error: "connection reset" }), bindingScriptLoader: async () => null, currency: "GBP" });
  assert.deepEqual(unreached.find((entry) => entry.id === "http:landing").evidence, { transport_error: { code: "fetch_failed", message: "connection reset" }, currency: "GBP" });
});
