import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgs } from "./cli.mjs";
import { REFUSED_INVOCATION } from "./lifecycle.mjs";
import { resolveCartEntryPage } from "./qa-cart-entry.mjs";
import { __qaBrowserTestHooks } from "./qa-browser.mjs";
import { __qaNodeTestHooks, runQaCli } from "./qa-node.mjs";

const { deriveEntryUrls, qaRunCurrency, runResolvedQa, withEntryCurrency } = __qaNodeTestHooks;
const { openCheckoutForPath } = __qaBrowserTestHooks;

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

test("the order runner's own load of the checkout carries ?currency=<CODE>; without --currency it is the plain URL", async () => {
  const loads = async (args) => {
    const page = { loads: [], url: () => "about:blank", goto: async (url) => { page.loads.push(url); }, waitForLoadState: async () => {}, waitForTimeout: async () => {} };
    await openCheckoutForPath({ page, checkoutPage: { page_id: "checkout", url: `${CHECKOUT_URL}?utm_source=newsletter` }, entry: null, args });
    return page.loads;
  };
  assert.deepEqual(await loads({ "browser-timeout": 1000, currency: "GBP" }), [`${CHECKOUT_URL}?utm_source=newsletter&currency=GBP`]);
  assert.deepEqual(await loads({ "browser-timeout": 1000 }), [`${CHECKOUT_URL}?utm_source=newsletter`]);
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

async function runWith(extraArgs) {
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
    const result = await runResolvedQa({ _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, "no-live-refs": true, json: true, ...extraArgs }, resolvedFixture(packetPath));
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
