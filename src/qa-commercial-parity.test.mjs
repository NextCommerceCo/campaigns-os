import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureCommercialClaims,
  commercialAssertionBudget,
  commercialIncompleteReasons,
  commercialSpecPages,
  createPageSourceLoader,
  planCommercialParity,
  resolveCommercialApiKey,
  runCommercialParity,
} from "./qa-commercial-parity.mjs";
import { __qaNodeTestHooks } from "./qa-node.mjs";
import { createVerdict } from "./qa-verdict.mjs";

function incompleteIds(result) {
  return result.assertions.map((entry) => entry.id).filter((id) => id.startsWith("commercial-parity:incomplete:"));
}

function provenAssertions(result) {
  return result.assertions.filter((entry) => !entry.id.startsWith("commercial-parity:incomplete:"));
}

function rawRecurringSpec() {
  return {
    schema_version: "4.3",
    campaign: {
      campaigns_api_key: "campaign-secret",
      currency: "USD",
    },
    funnels: [{
      id: "default",
      pages: [{
        id: "page_mt104ehn_11",
        type: "checkout",
        order: 1,
        enabled: true,
        packages: [{
          ref_id: "5",
          qty: 1,
          is_recurring: true,
          price_recurring: "29.99",
          interval: "day",
          interval_count: 30,
        }],
      }],
    }],
  };
}

function calculateBody(scenario) {
  const lines = scenario.lines.map((line) => ({
    package_id: line.package_id,
    quantity: line.quantity,
    discounts: [],
    subtotal: "29.99",
    original_package_price: "29.99",
    total_discount: "0.00",
    total: "29.99",
  }));
  return {
    ok: true,
    status: 200,
    data: {
      lines,
      offer_discounts: [],
      voucher_discounts: [],
      subtotal: "29.99",
      total_discount: "0.00",
      total: "29.99",
      currency: "USD",
    },
    calculated_at: "2026-08-24T00:00:00.000Z",
  };
}

test("runner plans from raw resolve data and preserves package-5 cadence into the verdict", async () => {
  const rawSpec = rawRecurringSpec();
  // This mirrors a resolver projection that retained package identity but not
  // recurrence fields. The runner must use rawSpec as its planning source.
  const strippedSpec = {
    campaign: {},
    funnels: [{ id: "default", pages: [{
      id: "page_mt104ehn_11",
      type: "checkout",
      packages: [{ ref_id: "5", qty: 1 }],
    }] }],
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    return new Response(JSON.stringify(calculateBody(body.scenario)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const capture = captureCommercialClaims({
    page_id: "page_mt104ehn_11",
    url: "https://preview.example.test/checkout/",
  }, `
    <div data-next-package-toggle>
      <strong data-next-package-id="5">Game Club</strong>
      Your first charge of $29.99, then $59.98 every two months, less than $30 per game!
    </div>
  `);
  const result = await runCommercialParity({
    resolved: {
      rawSpec,
      spec: strippedSpec,
      packet: { campaign: { api_key: "packet-secret" } },
      proxyBase: "https://proxy.example.test/",
      specHash: "ignored-computed-hash",
    },
    captures: [capture],
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === "https://proxy.example.test/api/price-preview"));
  assert.ok(requests.every((request) => request.options.headers["X-Campaign-Key"] === "packet-secret"));
  assert.ok(requests.every((request) => (
    JSON.stringify(Object.keys(request.body).sort()) === JSON.stringify(["scenario", "upsell"])
  )));
  assert.equal(result.commercial.status, "mismatch");
  assert.equal(result.commercial.coverage_complete, true);
  assert.deepEqual(result.commercial.finding_counts, { "cadence-disclosure-mismatch": 1 });
  assert.deepEqual(result.commercial.findings[0].calculated, {
    amount: "29.99",
    interval_count: 30,
    interval: "day",
  });
  assert.equal(result.assertions[0].id, "cadence-disclosure-mismatch:page_mt104ehn_11:package-5");
  assert.doesNotMatch(JSON.stringify(result), /packet-secret|campaign-secret/);
});

test("runner owns commercial assertion serialization at the supplied budget", async () => {
  const spec = rawRecurringSpec();
  const capture = captureCommercialClaims({ page_id: "page_mt104ehn_11" }, `
    <span data-next-display="bundle.main.price" data-next-format="currency">$30.00</span>
    <div data-next-package-toggle>
      <strong data-next-package-id="5">Game Club</strong>
      Your first charge of $29.99, then $59.98 every two months.
    </div>
  `);
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    maxAssertions: 1,
    fetchImpl: async (_url, options) => {
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    },
  });

  assert.equal(result.commercial.finding_count, 2);
  assert.equal(result.commercial.serialized_assertion_count, 1);
  assert.equal(result.commercial.omitted_assertion_count, 2);
  assert.deepEqual(result.assertions.map((assertion) => assertion.id), [
    "commercial-parity:additional-findings",
  ]);
});

test("commercial runner errors stay silent in JSON mode", () => {
  const written = [];
  const write = (message) => written.push(message);

  assert.equal(__qaNodeTestHooks.reportCommercialRunnerError({ json: true }, new Error("boom"), write), false);
  assert.deepEqual(written, []);
  assert.equal(__qaNodeTestHooks.reportCommercialRunnerError({}, new Error("boom"), write), true);
  assert.equal(written.length, 1);
  assert.match(written[0], /^\[campaigns-os\] Commercial parity could not complete: boom\n$/);
});

test("page source loader fetches each URL once and rejects an oversized streamed body", async () => {
  let fetches = 0;
  const loader = createPageSourceLoader({
    limits: { max_html_bytes: 5 },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("123456", { status: 200 });
    },
  });
  const page = { page_id: "checkout", url: "https://preview.example.test/checkout/" };
  const [first, second] = await Promise.all([loader(page), loader({ ...page, page_id: "duplicate" })]);

  assert.equal(fetches, 1);
  assert.equal(first, second);
  assert.equal(first.ok, false);
  assert.equal(first.error_code, "page_html_response_too_large");
});

test("page source loader stops network work after the aggregate retained-HTML ceiling", async () => {
  let fetches = 0;
  const loader = createPageSourceLoader({
    limits: { max_html_bytes: 8, max_aggregate_html_bytes: 5 },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("1234", { status: 200 });
    },
  });

  assert.equal((await loader({ page_id: "one", url: "https://example.test/one" })).ok, true);
  assert.equal((await loader({ page_id: "two", url: "https://example.test/two" })).error_code, "page_html_aggregate_limit");
  assert.equal((await loader({ page_id: "three", url: "https://example.test/three" })).error_code, "page_html_aggregate_limit");
  assert.equal(fetches, 2);
});

test("missing credentials and malformed proxy JSON are incomplete, never clean or mismatched", async () => {
  const rawSpec = rawRecurringSpec();
  delete rawSpec.campaign.campaigns_api_key;
  const capture = captureCommercialClaims({ page_id: "page_mt104ehn_11" }, "<main></main>");
  const missingKey = await runCommercialParity({
    resolved: { rawSpec, spec: rawSpec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(missingKey.commercial.status, "incomplete");
  assert.deepEqual(missingKey.commercial.issues, [{ code: "missing_campaigns_api_key", count: 1 }]);
  assert.deepEqual(incompleteIds(missingKey), ["commercial-parity:incomplete:missing_campaigns_api_key"]);
  assert.equal(missingKey.assertions.some((entry) => entry.id.startsWith("price-claim-mismatch")), false);

  const unsupportedEnv = await runCommercialParity({
    resolved: {
      packet: { campaign: { api_key_source: "env:GITHUB_TOKEN" } },
      rawSpec,
      spec: rawSpec,
      proxyBase: "https://proxy.example.test",
    },
    captures: [capture],
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.deepEqual(unsupportedEnv.commercial.issues, [{
    code: "unsupported_campaigns_api_key_source",
    count: 1,
  }]);
  assert.deepEqual(incompleteIds(unsupportedEnv), ["commercial-parity:incomplete:unsupported_campaigns_api_key_source"]);

  rawSpec.campaign.campaigns_api_key = "campaign-secret";
  const malformed = await runCommercialParity({
    resolved: { rawSpec, spec: rawSpec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  assert.equal(malformed.commercial.status, "incomplete");
  assert.equal(malformed.commercial.failed_scenarios, 2);
  assert.deepEqual(incompleteIds(malformed), ["commercial-parity:incomplete:price_preview_failed"]);
  assert.match(malformed.assertions[0].actual, /2 of 2 planned scenarios \(price_preview_invalid_json\)/);
});

test("incomplete coverage names its cause and its fix in a warn row, and stays warn-only", async () => {
  const rawSpec = rawRecurringSpec();
  delete rawSpec.campaign.campaigns_api_key;
  const result = await runCommercialParity({
    resolved: { rawSpec, spec: rawSpec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, "<main></main>")],
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });

  // A page with no calculated total is a consequence of the missing key, so
  // the only row is the key: one cause, one thing for the agent to do.
  const [row, ...others] = result.assertions;
  assert.deepEqual(others, []);
  assert.equal(row.id, "commercial-parity:incomplete:missing_campaigns_api_key");
  assert.equal(row.family, "pricing");
  assert.equal(row.status, "warn");
  assert.equal(row.severity, "warn");
  assert.match(row.actual, /0 of 2 planned calculate scenarios/);
  assert.match(row.actual, /Fix: Set campaign\.campaigns_api_key/);
  assert.equal(JSON.stringify(row).includes("campaign-secret"), false);

  // Reaches exceptions[] through the ordinary projection, without blocking.
  const verdict = createVerdict({
    runId: "run",
    mapId: "map",
    specVersion: "4.3",
    specHash: "hash",
    startedAt: "2026-11-07T00:00:00.000Z",
    completedAt: "2026-11-07T00:00:00.000Z",
    runtime: "node",
    assertions: result.assertions,
    commercial: result.commercial,
  });
  assert.equal(verdict.disposition, "ready_with_exceptions");
  assert.deepEqual(verdict.exceptions.map((entry) => [entry.id, entry.severity]), [[row.id, "warn"]]);
  assert.match(verdict.exceptions[0].actual, /Fix: /);
  assert.deepEqual(result.commercial.incomplete_reasons.map((entry) => entry.code), ["missing_campaigns_api_key"]);
});

test("each cause of incomplete coverage gets its own named row", async () => {
  const priced = async (_url, options) => {
    const { scenario } = JSON.parse(options.body);
    return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
  };
  const resolvedFor = (spec) => ({ rawSpec: spec, spec, proxyBase: "https://proxy.example.test" });
  const pageId = "page_mt104ehn_11";
  const claims = (html) => captureCommercialClaims({ page_id: pageId }, html);
  const readable = '<div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong> then $29.99 every 30 days</div>';

  // A page that was planned but never fetched.
  const notFetched = await runCommercialParity({ resolved: resolvedFor(rawRecurringSpec()), captures: [], fetchImpl: priced });
  assert.deepEqual(incompleteIds(notFetched), ["commercial-parity:incomplete:commercial_page_not_captured"]);
  assert.match(notFetched.assertions[0].actual, new RegExp(pageId));

  // A page whose markup could not be read.
  const malformed = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims(`${readable}<div data-next-package-id="not-a-number"></div>`)],
    fetchImpl: priced,
  });
  assert.deepEqual(incompleteIds(malformed), ["commercial-parity:incomplete:commercial_capture_invalid"]);

  // A fetched page the plan has no row for.
  const unmatched = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims(readable), captureCommercialClaims({ page_id: "elsewhere" }, "<main></main>")],
    fetchImpl: priced,
  });
  assert.deepEqual(incompleteIds(unmatched), ["commercial-parity:incomplete:commercial_capture_unmatched"]);

  // Calculate answers, but the page's package is not on the campaign.
  const notOnCampaign = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims(readable)],
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      status: 200,
      data: { lines: [], offer_discounts: [], voucher_discounts: [], subtotal: "0.00", total_discount: "0.00", total: "0.00", currency: "USD" },
    }), { status: 200 }),
  });
  assert.deepEqual(incompleteIds(notOnCampaign), ["commercial-parity:incomplete:commercial_page_not_exact"]);
  assert.match(notOnCampaign.assertions[0].actual, /page_mt104ehn_11 \(Unresolved: package not on campaign\)/);

  // Two bound prices on one page: nothing says which is the page's total.
  const twoBindings = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims(`${readable}
      <span data-next-display="bundle.a.price" data-next-format="currency">$29.99</span>
      <span data-next-display="bundle.b.price" data-next-format="currency">$29.99</span>`)],
    fetchImpl: priced,
  });
  assert.deepEqual(incompleteIds(twoBindings), ["commercial-parity:incomplete:commercial_claims_unresolved"]);
  assert.match(twoBindings.assertions[0].actual, /2 price, 0 recurring, 0 voucher/);

  // A cause that already writes its own row does not get a second one.
  const absent = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims('<div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong></div>')],
    fetchImpl: priced,
  });
  assert.deepEqual(incompleteIds(absent), []);
  assert.equal(absent.assertions.length, 1);
  assert.match(absent.assertions[0].id, /^commercial_parity\.recurring_claim_absent:/);

  // An exhausted budget costs that row, so the generic one still names the gap.
  const absentNoBudget = await runCommercialParity({
    resolved: resolvedFor(rawRecurringSpec()),
    captures: [claims('<div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong></div>')],
    fetchImpl: priced,
    maxAssertions: 0,
  });
  assert.deepEqual(incompleteIds(absentNoBudget), ["commercial-parity:incomplete:commercial_coverage_incomplete"]);
  assert.match(absentNoBudget.assertions[0].actual, /recurring_claim_absent/);
});

test("package.price claims reach the run as compared, mismatched or named as uncompared", async () => {
  const spec = rawRecurringSpec();
  const run = (capture) => runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    fetchImpl: async (_url, options) => {
      const { scenario } = JSON.parse(options.body);
      const body = calculateBody(scenario);
      body.data.lines = body.data.lines.map((line) => ({ ...line, original_unit_price: "39.99", unit_price: "29.99" }));
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const source = captureCommercialClaims({ page_id: "page_mt104ehn_11" }, `
    <div data-next-package-toggle data-next-package-id="5">
      <span data-next-display="package.price" data-next-format="currency">$9.99</span> then $29.99 every 30 days
    </div>
  `);
  const rendered = (text, filled = true) => [{ binding: "package.price", package_id: 5, filled, text }];

  // The placeholder source alone: nothing compared, and the row says why.
  const sourceOnly = await run(source);
  assert.equal(sourceOnly.commercial.status, "incomplete");
  assert.equal(sourceOnly.commercial.compared_price_claims, 0);
  assert.deepEqual(incompleteIds(sourceOnly), ["commercial-parity:incomplete:package_price_not_rendered"]);
  assert.match(sourceOnly.assertions[0].actual, /Fix: Re-run qa run with --browser/);

  const matched = await run({ ...source, rendered_package_prices: rendered("$29.99") });
  assert.equal(matched.commercial.status, "pass");
  assert.equal(matched.commercial.compared_price_claims, 1);
  assert.deepEqual(matched.commercial.package_price_claims, { extracted: 1, compared: 1, unresolved: {} });
  assert.deepEqual(matched.assertions, []);

  // Printed $39.99, the list price, against $29.99 after offers.
  const listPrice = await run({ ...source, rendered_package_prices: rendered("$39.99") });
  assert.equal(listPrice.commercial.status, "mismatch");
  assert.deepEqual(listPrice.assertions.map((entry) => [entry.id, entry.expected, entry.actual]), [
    ["price-claim-mismatch:page_mt104ehn_11:package.5.price", "29.99", "39.99"],
  ]);

  const unfilled = await run({ ...source, rendered_package_prices: rendered(null, false) });
  assert.equal(unfilled.commercial.status, "incomplete");
  assert.deepEqual(incompleteIds(unfilled), ["commercial-parity:incomplete:package_price_not_filled"]);
  assert.match(unfilled.assertions[0].actual, /placeholder price/);

  const noScope = await run({ ...source, rendered_package_prices: [{ binding: "package.price", package_id: null, filled: true, text: "$29.99" }] });
  assert.deepEqual(incompleteIds(noScope), ["commercial-parity:incomplete:package_price_unresolved"]);
});

test("package.price rows do not repeat a cause an earlier one explains, and bundle claims keep their own count", async () => {
  const spec = rawRecurringSpec();
  delete spec.campaign.campaigns_api_key;
  const noKey = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, '<div data-next-package-id="5"><span data-next-display="package.price">$9.99</span></div>')],
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.deepEqual(incompleteIds(noKey), ["commercial-parity:incomplete:missing_campaigns_api_key"]);

  const keyed = rawRecurringSpec();
  const both = await runCommercialParity({
    resolved: { rawSpec: keyed, spec: keyed, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, `
      <div data-next-package-toggle data-next-package-id="5"><span data-next-display="package.price">$9.99</span> then $29.99 every 30 days</div>
      <span data-next-display="bundle.a.price" data-next-format="currency">$29.99</span>
      <span data-next-display="bundle.b.price" data-next-format="currency">$29.99</span>
    `)],
    fetchImpl: async (_url, options) => new Response(JSON.stringify(calculateBody(JSON.parse(options.body).scenario)), { status: 200 }),
  });
  assert.deepEqual(incompleteIds(both), [
    "commercial-parity:incomplete:package_price_not_rendered",
    "commercial-parity:incomplete:commercial_claims_unresolved",
  ]);
  assert.match(both.assertions.at(-1).actual, /2 price, 0 recurring, 0 voucher/);
});

test("a stale page is named as stale, not as a page calculate could not price", () => {
  const commercial = { planned_scenarios: 1, issues: [], invalid_captures: [], missing_pages: [], unmatched_pages: [], unresolved_price_claims: 0, unresolved_recurrence_claims: 0, unresolved_voucher_claims: 0 };
  const reasons = commercialIncompleteReasons(commercial, {
    pages: [
      { page_id: "checkout", state: "Stale" },
      { page_id: "upsell", state: "Unresolved", reason: "Unresolved: package not on campaign" },
    ],
  });
  assert.deepEqual(reasons.map((entry) => entry.code), ["commercial_page_not_exact", "commercial_page_stale"]);
  assert.match(reasons[0].summary, /1 page\(s\): upsell \(Unresolved: package not on campaign\)/);
  assert.match(reasons[1].summary, /older spec or catalog data: checkout/);
  assert.doesNotMatch(reasons[1].fix, /Correct the spec/);
});

test("a page over the per-page claim limit is not also reported as unreadable", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages.push({ ...spec.funnels[0].pages[0], id: "page_two", order: 2 });
  const overLimit = { page_id: "page_mt104ehn_11", price_claims: [], recurrence_claims: [], vouchers: [], extraction_errors: [{ type: "commercial_html_claims_limit" }] };
  const run = (captures) => runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures,
    fetchImpl: async (_url, options) => new Response(JSON.stringify(calculateBody(JSON.parse(options.body).scenario)), { status: 200 }),
  });

  const alone = await run([overLimit, captureCommercialClaims({ page_id: "page_two" }, "<main></main>")]);
  assert.deepEqual(incompleteIds(alone), ["commercial-parity:incomplete:commercial_html_claims_limit"]);

  const both = await run([overLimit, { ...overLimit, page_id: "page_two", extraction_errors: [{ type: "malformed-voucher-json" }] }]);
  const row = both.commercial.incomplete_reasons.find((entry) => entry.code === "commercial_capture_invalid");
  assert.equal(row.count, 1);
  assert.match(row.summary, /1 page\(s\) could not be read for commercial claims: page_two\./);
});

test("rows a budget dropped from a batch are still named as a gap", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages[0].packages.push({ ...spec.funnels[0].pages[0].packages[0], ref_id: "6" });
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, `
      <div data-next-package-toggle><strong data-next-package-id="5">One</strong></div>
      <div data-next-package-toggle><strong data-next-package-id="6">Two</strong></div>
    `)],
    fetchImpl: async (_url, options) => new Response(JSON.stringify(calculateBody(JSON.parse(options.body).scenario)), { status: 200 }),
    maxAssertions: 1,
  });
  assert.equal(result.commercial.recurring_claim_absences.length, 2);
  assert.equal(result.assertions.filter((entry) => entry.id.startsWith("commercial_parity.recurring_claim_absent")).length, 1);
  assert.deepEqual(incompleteIds(result), ["commercial-parity:incomplete:commercial_coverage_incomplete"]);
});

test("the commercial budget keeps the verdict under the receiver's cap with every cause named", () => {
  assert.equal(commercialAssertionBudget(500, 100), 388);
  assert.equal(commercialAssertionBudget(500, 488), 0);
  assert.equal(commercialAssertionBudget(500, 900), 0);
  // Over-counts on purpose: every cause at once, which no single run reaches.
  const everyCause = commercialIncompleteReasons({
    planned_scenarios: 1,
    observed_claims: 1,
    claim_limit: 1,
    issues: ["missing_campaigns_api_key", "unsupported_campaigns_api_key_source", "price_preview_fetch_unavailable", "commercial_html_claims_limit", "commercial_aggregate_claim_limit", "commercial_scenario_limit", "commercial_runner_error", "price_preview_timeout"].map((code) => ({ code, count: 1 })),
    invalid_captures: [{ page_id: "a" }],
    missing_pages: [{ page_id: "b" }],
    unmatched_pages: [{ page_id: "c" }],
    unmatched_page_count: 1,
  });
  assert.equal(everyCause.length, 11);
  assert.ok(everyCause.length <= 500 - commercialAssertionBudget(500, 0));
});

test("a commercial pass or an empty plan writes no incomplete row", async () => {
  const spec = rawRecurringSpec();
  const pass = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, '<div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong> then $29.99 every 30 days</div>')],
    fetchImpl: async (_url, options) => {
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    },
  });
  assert.equal(pass.commercial.status, "pass");
  assert.deepEqual(pass.assertions, []);
  assert.equal(Object.hasOwn(pass.commercial, "incomplete_reasons"), false);
});

test("an empty commercial plan is explicitly not applicable", async () => {
  const result = await runCommercialParity({
    resolved: { rawSpec: { campaign: {}, funnels: [] }, spec: { campaign: {}, funnels: [] } },
  });
  assert.equal(result.commercial.status, "not_applicable");
  assert.equal(result.commercial.planned_scenarios, 0);
  assert.deepEqual(result.assertions, []);
});

test("legacy funnel_pages specs remain in automatic commercial scope", () => {
  const page = { id: "legacy-checkout", type: "checkout", packages: [{ ref_id: "1", qty: 1 }] };
  assert.deepEqual(commercialSpecPages({ funnel_pages: [page] }), [page]);
});

test("id-less pages are excluded before commercial scenario accounting", () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages.unshift({
    type: "checkout",
    packages: Array.from({ length: 300 }, (_, index) => ({ ref_id: String(index + 10), qty: 1 })),
  });

  const planning = planCommercialParity(spec);

  assert.deepEqual(planning.pages.map((page) => page.id), ["page_mt104ehn_11"]);
  assert.equal(planning.overflow, false);
  assert.equal(planning.observed_scenarios, 2);
  assert.equal(planning.plan.length, 2);
});

test("an all-id-less commercial spec is not applicable and performs no proxy work", async () => {
  const spec = {
    campaign: { campaigns_api_key: "campaign-secret" },
    funnels: [{
      id: "default",
      pages: [{ type: "checkout", packages: [{ ref_id: "5", qty: 1 }] }],
    }],
  };
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.commercial.status, "not_applicable");
  assert.equal(result.commercial.planned_scenarios, 0);
  assert.deepEqual(result.commercial.issues, []);
  assert.deepEqual(result.assertions, []);
});

test("spec-only resolve fallback uses the same spec for planning and proxy credentials", async () => {
  const spec = rawRecurringSpec();
  let requests = 0;
  const result = await runCommercialParity({
    resolved: { spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11" }, "<main></main>")],
    fetchImpl: async (_url, options) => {
      requests += 1;
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    },
  });

  assert.equal(requests, 2);
  assert.equal(result.commercial.status, "pass");
  assert.deepEqual(result.commercial.issues, []);
});

test("commercial API key resolution matches packet, spec, then declared-env precedence", () => {
  const rawSpec = rawRecurringSpec();
  const packetWins = resolveCommercialApiKey({
    packet: { campaign: { api_key: "packet-key", api_key_source: "env:CAMPAIGNS_API_KEY" } },
    rawSpec,
  }, { CAMPAIGNS_API_KEY: "env-key" });
  assert.deepEqual(packetWins, { value: "packet-key", source: "packet" });

  delete rawSpec.campaign.campaigns_api_key;
  rawSpec.campaign.api_key = "spec-key";
  assert.deepEqual(resolveCommercialApiKey({ rawSpec }, {}), { value: "spec-key", source: "spec" });

  delete rawSpec.campaign.api_key;
  assert.deepEqual(resolveCommercialApiKey({
    packet: { campaign: { api_key_source: "env:CAMPAIGNS_API_KEY" } },
    rawSpec,
  }, { CAMPAIGNS_API_KEY: "env-key" }), { value: "env-key", source: "env:CAMPAIGNS_API_KEY" });

  assert.deepEqual(resolveCommercialApiKey({
    packet: { campaign: { api_key_source: "env:GITHUB_TOKEN" } },
    rawSpec,
  }, { GITHUB_TOKEN: "must-not-leave-process" }), {
    value: null,
    source: "env:GITHUB_TOKEN",
    unsupported: true,
  });
});

test("scenario cap refuses an oversized plan before any proxy request", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages[0].packages = Array.from({ length: 256 }, (_, index) => ({
    ref_id: String(index + 1),
    qty: 1,
  }));
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims(
      { page_id: "page_mt104ehn_11" },
      '<span data-next-display="bundle.main.price" data-next-format="currency">$29.99</span>',
    )],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.commercial.planned_scenarios, 257);
  assert.deepEqual(result.commercial.issues, [{ code: "commercial_scenario_limit", count: 1 }]);
  assert.equal(result.commercial.status, "incomplete");
  assert.equal(result.commercial.checked_pages, 1);
  assert.equal(result.commercial.unmatched_page_count, 0);
  assert.equal(result.commercial.extracted_price_claims, 1);
  assert.equal(result.commercial.compared_price_claims, 0);
  assert.equal(result.commercial.unresolved_price_claims, 1);
});

test("aggregate claim cap emits no partial mismatch assertions and keeps the verdict publishable", async () => {
  const spec = rawRecurringSpec();
  let indexedVoucherReads = 0;
  const vouchers = new Proxy(
    Array.from({ length: 257 }, (_, index) => ({ code: `CODE${index}` })),
    {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) indexedVoucherReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const capture = {
    page_id: "page_mt104ehn_11",
    price_claims: [],
    recurrence_claims: [],
    vouchers,
  };
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(indexedVoucherReads, 0);
  assert.deepEqual(provenAssertions(result), []);
  assert.equal(result.commercial.status, "incomplete");
  assert.equal(result.commercial.observed_claims, 257);
  assert.equal(result.commercial.claim_limit, 256);
  assert.equal(result.commercial.extracted_voucher_claims, 257);
  assert.equal(result.commercial.compared_voucher_claims, 0);
  assert.equal(result.commercial.unresolved_voucher_claims, 257);
  assert.deepEqual(result.commercial.issues, [{ code: "commercial_aggregate_claim_limit", count: 1 }]);
  assert.deepEqual(result.commercial.findings, []);
});

test("simultaneous aggregate and scenario ceilings keep aggregate as the canonical first issue", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages[0].packages = Array.from({ length: 256 }, (_, index) => ({
    ref_id: String(index + 1),
    qty: 1,
  }));
  let indexedVoucherReads = 0;
  const vouchers = new Proxy(
    Array.from({ length: 257 }, (_, index) => ({ code: `CODE${index}` })),
    {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) indexedVoucherReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [{
      page_id: "page_mt104ehn_11",
      price_claims: [],
      recurrence_claims: [],
      vouchers,
    }],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(indexedVoucherReads, 0);
  assert.equal(result.commercial.planned_scenarios, 257);
  assert.equal(result.commercial.executed_scenarios, 0);
  assert.equal(result.commercial.extracted_voucher_claims, 257);
  assert.equal(result.commercial.unresolved_voucher_claims, 257);
  assert.equal(result.commercial.issues[0]?.code, "commercial_aggregate_claim_limit");
  assert.deepEqual(result.commercial.issues, [
    { code: "commercial_aggregate_claim_limit", count: 1 },
    { code: "commercial_scenario_limit", count: 1 },
  ]);
  assert.deepEqual(provenAssertions(result), []);
  assert.equal(result.commercial.status, "incomplete");
});

test("aggregate count-only overflow excludes unmatched claims without walking their elements", async () => {
  const spec = rawRecurringSpec();
  let indexedVoucherReads = 0;
  const unmatchedVouchers = new Proxy(
    Array.from({ length: 256 }, (_, index) => ({ code: `UNMATCHED${index}` })),
    {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) indexedVoucherReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [{
      page_id: "page_mt104ehn_11",
      price_claims: [],
      recurrence_claims: [],
      vouchers: [{ code: "MATCHED" }],
    }, {
      page_id: "other-page",
      price_claims: [],
      recurrence_claims: [],
      vouchers: unmatchedVouchers,
    }],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(indexedVoucherReads, 0);
  assert.equal(result.commercial.observed_claims, 257);
  assert.equal(result.commercial.extracted_voucher_claims, 1);
  assert.equal(result.commercial.compared_voucher_claims, 0);
  assert.equal(result.commercial.unresolved_voucher_claims, 1);
  assert.deepEqual(result.commercial.unmatched_pages, [{ page_id: "other-page" }]);
  assert.deepEqual(result.commercial.findings, []);
  assert.deepEqual(provenAssertions(result), []);
});

test("per-document and aggregate claim ceilings keep distinct issue codes", async () => {
  const spec = rawRecurringSpec();
  const html = Array.from({ length: 501 }, (_, index) => (
    `<span data-next-display="bundle.item${index}.price" data-next-format="currency">$29.99</span>`
  )).join("");
  const capture = captureCommercialClaims({ page_id: "page_mt104ehn_11" }, html);
  assert.equal(capture.extraction_errors?.[0]?.type, "commercial_html_claims_limit");

  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    fetchImpl: async (_url, options) => {
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    },
  });

  assert.deepEqual(result.commercial.issues, [{ code: "commercial_html_claims_limit", count: 1 }]);
  assert.equal(result.commercial.status, "incomplete");
});

test("simultaneous per-document and aggregate claim ceilings preserve both issues", async () => {
  const spec = rawRecurringSpec();
  const html = Array.from({ length: 501 }, (_, index) => (
    `<span data-next-display="bundle.item${index}.price" data-next-format="currency">$29.99</span>`
  )).join("");
  const limitedCapture = captureCommercialClaims({ page_id: "page_mt104ehn_11" }, html);
  assert.equal(limitedCapture.extraction_errors?.[0]?.type, "commercial_html_claims_limit");

  let indexedVoucherReads = 0;
  const vouchers = new Proxy(
    Array.from({ length: 257 }, (_, index) => ({ code: `CODE${index}` })),
    {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) indexedVoucherReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [limitedCapture, {
      page_id: "page_mt104ehn_11",
      price_claims: [],
      recurrence_claims: [],
      vouchers,
    }],
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  assert.equal(indexedVoucherReads, 0);
  assert.equal(result.commercial.invalid_capture_count, 1);
  assert.equal(result.commercial.extracted_voucher_claims, 257);
  assert.equal(result.commercial.unresolved_voucher_claims, 257);
  assert.deepEqual(result.commercial.issues, [
    { code: "commercial_aggregate_claim_limit", count: 1 },
    { code: "commercial_html_claims_limit", count: 1 },
  ]);
  assert.deepEqual(provenAssertions(result), []);
  assert.equal(result.commercial.status, "incomplete");
});

test("compact verdict evidence preserves sanitized missing, unmatched, invalid, and finding arrays", async () => {
  const spec = rawRecurringSpec();
  delete spec.campaign.campaigns_api_key;
  const invalid = captureCommercialClaims(
    { page_id: "page_mt104ehn_11", url: "https://preview.example.test/checkout/" },
    `<div data-next-bundle-vouchers='not-json'></div>`,
  );
  const unmatched = captureCommercialClaims({ page_id: "other-page" }, "<main></main>");
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [invalid, unmatched],
  });

  assert.deepEqual(result.commercial.invalid_captures, [{
    index: 0,
    page_id: "page_mt104ehn_11",
    url: "https://preview.example.test/checkout/",
  }]);
  assert.deepEqual(result.commercial.unmatched_pages, [{ page_id: "other-page" }]);
  assert.deepEqual(result.commercial.missing_pages, [{ page_id: "page_mt104ehn_11" }]);
  assert.deepEqual(result.commercial.findings, []);
});

function resolvedQaFixture({ packetPath, rawSpec, pageUrl }) {
  return {
    themeGate: {
      status: "not_applicable",
      code: "theme_gate.no_theme_context",
      reason: "Test fixture has no theme context.",
    },
    polishGate: {
      status: "not_applicable",
      code: "polish.not_applicable",
      reason: "Test fixture has no assembly report.",
    },
    checkpointGates: [],
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath,
    packet: null,
    mapId: "commercial-integration",
    publicRouteSlug: "commercial-integration",
    proxyBase: "https://proxy.example.test",
    baseUrl: "https://preview.example.test/",
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec,
    spec: rawSpec,
    specVersion: "4.3",
    specHash: "sha256:test",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: [{
      funnel_id: "default",
      funnel_name: "Default",
      weight: 100,
      pages: [{
        page_id: "page_mt104ehn_11",
        page_type: "checkout",
        label: "Checkout",
        url: pageUrl,
        packages: rawSpec.funnels[0].pages[0].packages,
      }],
    }],
  };
}

test("canonical resolved qa run fetches HTML once and writes deterministic commercial assertions into the verdict", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-commercial-qa-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({
    schema_version: "campaign-runtime-build-packet/v0",
  })}\n`);
  const originalFetch = globalThis.fetch;
  const rawSpec = rawRecurringSpec();
  const pageUrl = "https://preview.example.test/checkout/";
  let pageFetches = 0;
  let previewFetches = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === pageUrl && !options.method) {
      pageFetches += 1;
      return new Response(`
        <span data-next-display="bundle.main.price" data-next-format="currency">$30.00</span>
        <div data-next-package-toggle>
          <strong data-next-package-id="5">Game Club</strong>
          Your first charge of $29.99, then $59.98 every two months, less than $30 per game!
        </div>
      `, { status: 200 });
    }
    if (String(url) === "https://proxy.example.test/api/price-preview" && options.method === "POST") {
      previewFetches += 1;
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  };

  try {
    const resolved = resolvedQaFixture({ packetPath, rawSpec, pageUrl });
    const result = await __qaNodeTestHooks.runResolvedQa({
      _: ["qa", "run"],
      "output-dir": outputDir,
      "no-post-verdict": true,
    }, resolved);

    assert.equal(pageFetches, 1);
    assert.equal(previewFetches, 2);
    assert.equal(result.verdict.commercial.status, "mismatch");
    assert.deepEqual(
      result.verdict.assertions.filter((entry) => entry.family === "pricing").map((entry) => entry.id),
      [
        "price-claim-mismatch:page_mt104ehn_11:bundle.main.price",
        "cadence-disclosure-mismatch:page_mt104ehn_11:package-5",
      ],
    );
    assert.deepEqual(result.verdict.commercial.findings.map((finding) => finding.type), [
      "price-claim-mismatch",
      "cadence-disclosure-mismatch",
    ]);
    assert.equal(result.verdict.commercial.serialized_assertion_count, 2);
    assert.equal(result.verdict.commercial.omitted_assertion_count, 0);
    const sidecar = JSON.parse(readFileSync(result.qa_sidecar.path, "utf8"));
    assert.deepEqual(
      sidecar.assertions.filter((entry) => entry.family === "pricing").map((entry) => entry.id),
      [
        "price-claim-mismatch:page_mt104ehn_11:bundle.main.price",
        "cadence-disclosure-mismatch:page_mt104ehn_11:package-5",
      ],
    );
    assert.equal(sidecar.commercial, undefined, "the committed sidecar retains its strict allowlist projection");
    assert.doesNotMatch(JSON.stringify(result.verdict), /campaign-secret/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("a real qa run with no campaign key reports the gap in exceptions and the sidecar, and still exits ready", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "campaigns-os-commercial-qa-"));
  const packetPath = join(outputDir, "campaign-runtime.build.json");
  writeFileSync(packetPath, `${JSON.stringify({ schema_version: "campaign-runtime-build-packet/v0" })}\n`);
  const originalFetch = globalThis.fetch;
  const rawSpec = rawRecurringSpec();
  delete rawSpec.campaign.campaigns_api_key;
  const pageUrl = "https://preview.example.test/checkout/";
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === pageUrl && !options.method) {
      return new Response('<div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong> then $29.99 every 30 days</div>', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  };
  try {
    const result = await __qaNodeTestHooks.runResolvedQa({
      _: ["qa", "run"],
      "output-dir": outputDir,
      "no-post-verdict": true,
    }, resolvedQaFixture({ packetPath, rawSpec, pageUrl }));

    const id = "commercial-parity:incomplete:missing_campaigns_api_key";
    assert.equal(result.ok, true, "warn-only: the run is not blocked");
    assert.equal(result.verdict.disposition, "ready_with_exceptions");
    assert.equal(result.verdict.commercial.status, "incomplete");
    const exception = result.verdict.exceptions.find((entry) => entry.id === id);
    assert.equal(exception.severity, "warn");
    assert.match(exception.actual, /Fix: Set campaign\.campaigns_api_key/);
    assert.deepEqual(result.verdict.commercial.incomplete_reasons.map((entry) => entry.code), ["missing_campaigns_api_key"]);
    const sidecar = JSON.parse(readFileSync(result.qa_sidecar.path, "utf8"));
    assert.equal(sidecar.disposition, "ready_with_exceptions");
    assert.ok(sidecar.exceptions.some((entry) => entry.id === id), "the sidecar keeps the cause in the row's id");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("preflight overflow issues keep the aggregate-before-scenario order", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages.push({
    ...spec.funnels[0].pages[0],
    id: "page_mt104ehn_12",
    order: 2,
  });
  const capture = {
    page_id: "page_mt104ehn_11",
    price_claims: [],
    recurrence_claims: [],
    vouchers: [
      { code: "SAVE1", raw: "SAVE1" },
      { code: "SAVE2", raw: "SAVE2" },
    ],
  };
  let fetched = false;
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [capture],
    limits: { max_scenarios: 1, max_aggregate_claims: 1 },
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetched, false);
  // deepEqual on an array is order-sensitive: this pins the preflight push
  // order (aggregate first, then scenario) that operators and downstream
  // tooling read positionally.
  assert.deepEqual(result.commercial.issues, [
    { code: "commercial_aggregate_claim_limit", count: 1 },
    { code: "commercial_scenario_limit", count: 1 },
  ]);
  assert.equal(result.commercial.status, "incomplete");
});

test('concurrent HTML admission preserves page-order budget and duplicate URL identity', async () => {
  const releases = new Map();
  const calls = [];
  const loader = createPageSourceLoader({
    limits: { max_html_bytes: 8, max_aggregate_html_bytes: 5 },
    fetchImpl: url => {
      calls.push(url);
      return new Promise(resolve => releases.set(url, () => resolve(new Response(url.endsWith('/three') ? 'x' : 'abc'))));
    },
  });
  const first = loader({ url: 'https://example.test/one' });
  const second = loader({ url: 'https://example.test/two' });
  const third = loader({ url: 'https://example.test/three' });
  assert.equal(loader({ url: 'https://example.test/one' }), first);
  releases.get('https://example.test/three')();
  releases.get('https://example.test/two')();
  releases.get('https://example.test/one')();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[0].html, 'abc');
  assert.equal(results[1].error_code, 'page_html_aggregate_limit');
  assert.equal(results[2].error_code, 'page_html_aggregate_limit');
  assert.equal(calls.length, 3);
  assert.equal((await loader({ url: 'https://example.test/four' })).error_code, 'page_html_aggregate_limit');
  assert.equal(calls.length, 3);
});

test('a failed earlier request releases ordered admission for later pages', async () => {
  const loader = createPageSourceLoader({ fetchImpl: async url => {
    if (url.endsWith('/one')) throw new Error('unavailable');
    return new Response('ok');
  } });
  const [first, second] = await Promise.all([
    loader({ url: 'https://example.test/one' }), loader({ url: 'https://example.test/two' }),
  ]);
  assert.equal(first.error_code, 'page_fetch_error');
  assert.equal(second.html, 'ok');
});

test('bounded mapper retains input order and caps in-flight operations', { timeout: 2000 }, async () => {
  const { mapConcurrent } = await import('./qa-commercial-parity.mjs');
  let active = 0, peak = 0;
  const output = await mapConcurrent([0, 1, 2, 3, 4, 5, 6], 4, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (7 - value) * 2));
    active--;
    return value;
  });
  assert.deepEqual(output, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 4);
});

test('timed-out predecessor releases admission and cannot stall later HTML', { timeout: 2000 }, async () => {
  const loader = createPageSourceLoader({
    limits: { request_timeout_ms: 10 },
    fetchImpl: (url, { signal }) => url.endsWith('/one')
      ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true }))
      : Promise.resolve(new Response('ok')),
  });
  const results = await Promise.all([loader({ url: 'https://example.test/one' }), loader({ url: 'https://example.test/two' })]);
  assert.equal(results[0].error_code, 'page_fetch_timeout');
  assert.equal(results[1].html, 'ok');
});

test('exact-budget admission masks a later HTTP failure just as sequential loading does', async () => {
  const loader = createPageSourceLoader({
    limits: { max_aggregate_html_bytes: 3 },
    fetchImpl: async url => url.endsWith('/one') ? new Response('abc') : new Response('failure', { status: 500 }),
  });
  const results = await Promise.all([loader({ url: 'https://example.test/one' }), loader({ url: 'https://example.test/two' })]);
  assert.equal(results[0].html, 'abc');
  assert.equal(results[1].error_code, 'page_html_aggregate_limit');
});


test('a page fetch that ignores its abort signal still times out with the timeout code', { timeout: 2000 }, async () => {
  const loader = createPageSourceLoader({
    limits: { request_timeout_ms: 10 },
    fetchImpl: () => new Promise(() => {}),
  });
  const result = await loader({ url: 'https://example.test/hung' });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'page_fetch_timeout');
  assert.match(result.error, /10ms deadline/);
});

test('price preview aborts use a stable timeout code in commercial evidence', { timeout: 2000 }, async () => {
  const spec = rawRecurringSpec();
  const result = await runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: 'https://proxy.example.test' },
    captures: [captureCommercialClaims({ page_id: 'page_mt104ehn_11' }, '<main></main>')],
    limits: { request_timeout_ms: 10 },
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(result.commercial.status, 'incomplete');
  assert.deepEqual(result.commercial.issues.map(issue => issue.code), ['price_preview_timeout']);
});

test('page aborts during body streaming use timeout codes, while size errors retain their code', async () => {
  const loader = createPageSourceLoader({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('Aborted body', 'AbortError')); },
  })) });
  assert.equal((await loader({ url: 'https://example.test/body' })).error_code, 'page_fetch_timeout');
  const oversized = createPageSourceLoader({ limits: { max_html_bytes: 1 }, fetchImpl: async () => new Response('large') });
  assert.equal((await oversized({ url: 'https://example.test/large' })).error_code, 'page_html_response_too_large');
});

test("recurring claim absent: a rendered subscription package with no extracted rebill claim warns and names the package", async () => {
  const spec = rawRecurringSpec();
  spec.funnels[0].pages[0].packages.push({ ref_id: "6", qty: 1 });
  const run = (html) => runCommercialParity({
    resolved: { rawSpec: spec, spec, proxyBase: "https://proxy.example.test" },
    captures: [captureCommercialClaims({ page_id: "page_mt104ehn_11", url: "https://preview.example.test/checkout/" }, html)],
    fetchImpl: async (_url, options) => {
      const { scenario } = JSON.parse(options.body);
      return new Response(JSON.stringify(calculateBody(scenario)), { status: 200 });
    },
  });

  // The rebill copy is in an image, so nothing readable states the cadence.
  const absent = await run(`
    <div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong><img alt="" src="/rebill.png"></div>
    <div data-next-package-toggle><strong data-next-package-id="6">One-time</strong></div>
  `);
  const rows = absent.assertions.filter((entry) => entry.id.startsWith("commercial_parity.recurring_claim_absent"));
  assert.deepEqual(rows.map((entry) => [entry.id, entry.status, entry.severity, entry.evidence.package_id]), [
    ["commercial_parity.recurring_claim_absent:page_mt104ehn_11:package-5", "warn", "warn", "5"],
  ]);
  assert.match(rows[0].actual, /package 5/);
  assert.deepEqual(absent.commercial.recurring_claim_absences.map((entry) => entry.package_id), ["5"]);
  assert.ok(absent.commercial.issues.some((issue) => issue.code === "recurring_claim_absent"));
  assert.notEqual(absent.commercial.status, "pass");

  // A readable claim for the package: no row.
  const claimed = await run(`
    <div data-next-package-toggle><strong data-next-package-id="5">Game Club</strong> then $29.99 every 30 days</div>
  `);
  assert.equal(claimed.assertions.some((entry) => entry.id.startsWith("commercial_parity.recurring_claim_absent")), false);

  // The page renders only the one-time package: no row.
  const oneTime = await run(`<div data-next-package-toggle><strong data-next-package-id="6">One-time</strong></div>`);
  assert.equal(oneTime.assertions.some((entry) => entry.id.startsWith("commercial_parity.recurring_claim_absent")), false);
  assert.deepEqual(oneTime.commercial.recurring_claim_absences, []);
});
