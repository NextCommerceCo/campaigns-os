import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CommercialParityLimitError,
  createCommercialParityReport,
  diffCommercialParity,
  extractCommercialClaims,
  recurringClaimAbsences,
  serializeCommercialFindings,
} from "./commercial-parity.mjs";

test("extracts the deployed sibling cadence sentence without treating trailing less-than copy as decorative", () => {
  const capture = extractCommercialClaims(`
    <div data-next-package-toggle>
      <strong data-next-package-id="5">Game Club</strong>
      Your first charge of $29.99, then $59.98 every two months, less than $30 per game!
    </div>
  `, { pageId: "checkout" });

  assert.deepEqual(capture.recurrence_claims, [{
    package_id: 5,
    amount: "59.98",
    interval_count: 2,
    interval: "month",
  }]);
});

test("extractor enforces independent byte, node, and depth limits", () => {
  assert.throws(
    () => extractCommercialClaims("123456", { limits: { max_html_bytes: 5 } }),
    (error) => error instanceof CommercialParityLimitError && error.code === "commercial_html_bytes_limit",
  );
  assert.throws(
    () => extractCommercialClaims("<i></i><i></i>", { limits: { max_nodes: 1 } }),
    (error) => error instanceof CommercialParityLimitError && error.code === "commercial_html_nodes_limit",
  );
  assert.throws(
    () => extractCommercialClaims("<i><b></b></i>", { limits: { max_depth: 1 } }),
    (error) => error instanceof CommercialParityLimitError && error.code === "commercial_html_depth_limit",
  );
  assert.throws(
    () => extractCommercialClaims(`
      <i data-next-display="bundle.main.price" data-next-format="currency">$1.00</i>
      <i data-next-display="bundle.alt.price" data-next-format="currency">$2.00</i>
    `, { limits: { max_claims: 1 } }),
    (error) => error instanceof CommercialParityLimitError && error.code === "commercial_html_claims_limit",
  );
});

test("raw-text close matching cannot promote script-shaped text into authored claims", () => {
  const capture = extractCommercialClaims(`
    <script>const fake = '</scripture><span data-next-display="bundle.fake.price" data-next-format="currency">$999.00</span>';</script>
    <span data-next-display="bundle.main.price" data-next-format="currency">$10.00</span>
  `);

  assert.deepEqual(capture.price_claims, [{ binding: "bundle.main.price", value: "10.00" }]);
});

test("nested governed price nodes select only the terminal contract field", () => {
  let html = `<span data-next-display="bundle.terminal.price" data-next-format="currency">$10.00</span>`;
  for (let index = 0; index < 1_000; index += 1) {
    html = `<span data-next-display="bundle.outer${index}.price" data-next-format="currency">${html}</span>`;
  }

  const capture = extractCommercialClaims(html, {
    limits: { max_depth: 1_100, max_nodes: 1_100 },
  });
  assert.deepEqual(capture.price_claims, [{ binding: "bundle.terminal.price", value: "10.00" }]);
});

test("malformed package markers invalidate recurrence extraction instead of borrowing a sibling binding", () => {
  const capture = extractCommercialClaims(`
    <div data-next-package-toggle>
      <span data-next-package-id="5">Package five</span>
      <span data-next-package-id="bogus">$99 every month</span>
    </div>
  `, { pageId: "checkout" });

  assert.deepEqual(capture.recurrence_claims, []);
  assert.deepEqual(capture.extraction_errors, [{ type: "malformed-package-id" }]);
});

test("ambiguous price bindings stay unresolved instead of creating precision false positives", () => {
  const capture = extractCommercialClaims(`
    <span data-next-display="bundle.main.price" data-next-format="currency">$10.01</span>
    <span data-next-display="bundle.alt.price" data-next-format="currency">$20.01</span>
  `, { pageId: "checkout" });
  const journey = {
    pages: [{
      page_id: "checkout",
      representative_total: { state: "Exact", value: "10.00" },
      rows: [],
      offers: [],
    }],
  };
  const report = createCommercialParityReport([capture], journey);

  assert.deepEqual(diffCommercialParity(capture, journey), []);
  assert.equal(report.compared_price_claims, 0);
  assert.equal(report.unresolved_price_claims, 2);
  assert.equal(report.coverage_complete, false);
});

test("malformed vouchers and unlabeled multi-page captures are explicit incomplete evidence", () => {
  const malformed = extractCommercialClaims(
    `<div data-next-bundle-vouchers='not-json'></div>`,
    { pageId: "checkout" },
  );
  const unlabeled = extractCommercialClaims(
    `<span data-next-display="bundle.main.price" data-next-format="currency">$10.00</span>`,
  );
  const journey = {
    pages: ["checkout", "upsell"].map((pageId) => ({
      page_id: pageId,
      representative_total: { state: "Exact", value: "10.00" },
      rows: [],
      offers: [],
    })),
  };
  const report = createCommercialParityReport([malformed, unlabeled], journey);

  assert.equal(report.invalid_capture_count, 1);
  assert.deepEqual(report.invalid_captures, [{ index: 0, page_id: "checkout" }]);
  assert.equal(report.unmatched_page_count, 1);
  assert.equal(report.missing_page_count, 2);
  assert.equal(report.coverage_complete, false);
});

test("commercial claim totals exclude valid captures that do not match a normalized page", () => {
  const matched = {
    page_id: "checkout",
    price_claims: [{ binding: "bundle.main.price", value: "10.00" }],
    recurrence_claims: [{ package_id: 5, amount: "29.99", interval_count: 1, interval: "month" }],
    vouchers: [{ code: "SAVE10" }],
  };
  const unmatched = {
    page_id: "other-page",
    price_claims: [{ binding: "bundle.other.price", value: "99.00" }],
    recurrence_claims: [{ package_id: 9, amount: "99.00", interval_count: 1, interval: "year" }],
    vouchers: [{ code: "GHOST" }],
  };
  const journey = {
    pages: [{
      page_id: "checkout",
      representative_total: { state: "Exact", value: "10.00" },
      rows: [{
        package_id: 5,
        state: "Exact",
        recurrence: {
          state: "Exact",
          amount: { state: "Exact", value: "29.99" },
          interval_count: 1,
          interval: "month",
        },
      }],
      offers: [{
        code: "SAVE10",
        calculation_evidence: "calculated_pair",
        state: "Exact",
        status: "Applied",
      }],
    }],
  };

  const report = createCommercialParityReport([matched, unmatched], journey);

  assert.deepEqual(report.unmatched_pages, [{ page_id: "other-page" }]);
  assert.equal(report.extracted_price_claims, 1);
  assert.equal(report.compared_price_claims, 1);
  assert.equal(report.unresolved_price_claims, 0);
  assert.equal(report.extracted_recurrence_claims, 1);
  assert.equal(report.compared_recurrence_claims, 1);
  assert.equal(report.unresolved_recurrence_claims, 0);
  assert.equal(report.extracted_voucher_claims, 1);
  assert.equal(report.compared_voucher_claims, 1);
  assert.equal(report.unresolved_voucher_claims, 0);
  assert.equal(report.coverage_complete, false);
});

test("serialized price captures must use the governed terminal binding grammar", () => {
  const report = createCommercialParityReport([{
    page_id: "checkout",
    price_claims: [{ binding: "bundle.main.originalPrice", value: "10.00" }],
    recurrence_claims: [],
    vouchers: [],
  }], {
    pages: [{
      page_id: "checkout",
      representative_total: { state: "Exact", value: "9.00" },
      rows: [],
      offers: [],
    }],
  });

  assert.equal(report.invalid_capture_count, 1);
  assert.equal(report.coverage_complete, false);
  assert.deepEqual(report.findings, []);
});

test("recurrence and voucher claims make coverage incomplete until one Exact truth is provable", () => {
  const capture = {
    page_id: "checkout",
    price_claims: [],
    recurrence_claims: [{ package_id: 5, amount: "59.98", interval_count: 2, interval: "month" }],
    vouchers: [{ code: "SAVE10" }],
  };
  const page = {
    page_id: "checkout",
    representative_total: { state: "Exact", value: "10.00" },
    rows: [],
    offers: [],
  };
  const report = createCommercialParityReport([capture], { pages: [page] });

  assert.equal(report.extracted_recurrence_claims, 1);
  assert.equal(report.compared_recurrence_claims, 0);
  assert.equal(report.unresolved_recurrence_claims, 1);
  assert.equal(report.extracted_voucher_claims, 1);
  assert.equal(report.compared_voucher_claims, 0);
  assert.equal(report.unresolved_voucher_claims, 1);
  assert.equal(report.coverage_complete, false);
  assert.deepEqual(report.findings, []);
});

test("a voucher the plan cannot price leaves the page's price claims unresolved, not mismatched", () => {
  // An upsell priced by a live voucher shows the voucher price; the plan only
  // knows the list price because the voucher has no calculated pair.
  const capture = {
    page_id: "upsell",
    price_claims: [{ binding: "bundle.upsell.price", value: "29.99" }],
    recurrence_claims: [],
    vouchers: [{ code: "FIRE" }],
  };
  const page = {
    page_id: "upsell",
    representative_total: { state: "Exact", value: "39.99" },
    rows: [],
    offers: [],
  };
  const report = createCommercialParityReport([capture], { pages: [page] });

  assert.deepEqual(report.findings, []);
  assert.equal(report.compared_price_claims, 0);
  assert.equal(report.unresolved_price_claims, 1);
  assert.equal(report.unresolved_voucher_claims, 1);
  assert.equal(report.coverage_complete, false);

  // A voucher the plan does price still lets the price claim be compared.
  const priced = createCommercialParityReport([{ ...capture, vouchers: [{ code: "SAVE10" }] }], {
    pages: [{
      ...page,
      offers: [{ code: "SAVE10", calculation_evidence: "calculated_pair", state: "Exact", status: "Applied" }],
    }],
  });
  assert.equal(priced.compared_price_claims, 1);
  assert.deepEqual(priced.findings.map((finding) => finding.type), ["price-claim-mismatch"]);
});

test("multiple distinct quantity recurrence truths are unresolved regardless of row order", () => {
  const capture = {
    page_id: "checkout",
    price_claims: [],
    recurrence_claims: [{ package_id: 5, amount: "59.98", interval_count: 30, interval: "day" }],
    vouchers: [],
  };
  const recurrence = (amount) => ({
    package_id: 5,
    state: "Exact",
    recurrence: {
      state: "Exact",
      amount: { state: "Exact", value: amount },
      interval_count: 30,
      interval: "day",
    },
  });
  const basePage = {
    page_id: "checkout",
    representative_total: { state: "Exact", value: "10.00" },
    offers: [],
  };
  for (const rows of [
    [recurrence("29.99"), recurrence("59.98")],
    [recurrence("59.98"), recurrence("29.99")],
  ]) {
    const report = createCommercialParityReport([capture], { pages: [{ ...basePage, rows }] });
    assert.equal(report.compared_recurrence_claims, 0);
    assert.equal(report.unresolved_recurrence_claims, 1);
    assert.equal(report.coverage_complete, false);
    assert.deepEqual(report.findings, []);
  }
});

test("commercial finding assertions have deterministic type-specific ids", () => {
  const capture = {
    page_id: "checkout",
    price_claims: [{ binding: "bundle.main.price", value: "10.01" }],
    recurrence_claims: [{ package_id: 5, amount: "59.98", interval_count: 2, interval: "month" }],
    vouchers: [{ code: "SAVE10" }],
  };
  const journey = {
    pages: [{
      page_id: "checkout",
      representative_total: { state: "Exact", value: "10.00" },
      rows: [{
        package_id: 5,
        state: "Exact",
        recurrence: {
          state: "Exact",
          amount: { state: "Exact", value: "29.99" },
          interval_count: 30,
          interval: "day",
        },
      }],
      offers: [{
        code: "SAVE10",
        calculation_evidence: "calculated_pair",
        state: "Exact",
        status: "Not applied",
      }],
    }],
  };
  const report = createCommercialParityReport([capture], journey);

  assert.deepEqual(report.assertions.map((assertion) => assertion.id), [
    "price-claim-mismatch:checkout:bundle.main.price",
    "cadence-disclosure-mismatch:checkout:package-5",
    "voucher-not-applied:checkout:SAVE10",
  ]);
  assert.ok(report.assertions.every((assertion) => (
    assertion.family === "pricing"
    && assertion.status === "warn"
    && assertion.severity === "warn"
  )));
});

test("commercial findings collapse deterministically to the remaining verdict assertion budget", () => {
  const findings = ["one", "two", "three"].map((suffix) => ({
    type: "price-claim-mismatch",
    page_id: suffix,
    binding: `bundle.${suffix}.price`,
    claimed: "10.01",
    calculated: "10.00",
  }));

  const limited = serializeCommercialFindings(findings, { maxAssertions: 2 });
  assert.equal(limited.assertions.length, 2);
  assert.equal(limited.assertions[0].id, "price-claim-mismatch:one:bundle.one.price");
  assert.equal(limited.assertions[1].id, "commercial-parity:additional-findings");
  assert.equal(limited.assertions[1].evidence.omitted_finding_count, 2);
  assert.equal(limited.omittedFindingCount, 2);

  assert.deepEqual(serializeCommercialFindings(findings, { maxAssertions: 0 }), {
    assertions: [],
    omittedFindingCount: 3,
  });
});

test("supported self-referencing commercial parity export resolves", async () => {
  const exported = await import("@nextcommerce/campaigns-os/commercial-parity");
  assert.equal(exported.extractCommercialClaims, extractCommercialClaims);
});

test("recurring claim absences skip a capture with no page id instead of keying it as null", () => {
  const rendered = (pageId) => ({
    ...extractCommercialClaims(`<div data-next-package-toggle><strong data-next-package-id="5">Club</strong></div>`, pageId === undefined ? {} : { pageId }),
    rendered_package_refs: ["5"],
  });
  const subscriptions = new Map([["null", new Set(["5"])], ["checkout", new Set(["5"])]]);
  assert.deepEqual(recurringClaimAbsences([rendered(undefined)], subscriptions), []);
  assert.deepEqual(recurringClaimAbsences([{ ...rendered(undefined), page_id: "" }], subscriptions), []);
  // The page-keyed capture is still read.
  assert.deepEqual(recurringClaimAbsences([rendered("checkout")], subscriptions).map((entry) => [entry.page_id, entry.package_id]), [["checkout", "5"]]);
});

const STARTER_UPSELL = new URL("../fixtures/certified-families/_site/apollo-mv-single-step/upsell-single/index.html", import.meta.url);

function packagePricePage(rows = [{ package_id: 3, state: "Exact", unit_price: { state: "Exact", value: "49.99" } }], extra = {}) {
  return { page_id: "upsell", representative_total: { state: "Exact", value: "49.99" }, rows, offers: [], ...extra };
}

function renderedCapture(rendered, extra = {}) {
  return { page_id: "upsell", price_claims: [], recurrence_claims: [], vouchers: [], rendered_package_prices: rendered, ...extra };
}

function renderedClaim(text, overrides = {}) {
  return { binding: "package.price", package_id: 3, filled: true, text, ...overrides };
}

test("a starter page's placeholder package.price is listed as a claim, and is never compared", () => {
  const html = readFileSync(STARTER_UPSELL, "utf8");
  assert.match(html, /data-next-display="package\.price"[^>]*>\$9\.99/, "precondition: the starter holds a placeholder price");
  const capture = extractCommercialClaims(html, { pageId: "upsell" });

  assert.deepEqual(capture.price_claims, []);
  assert.ok(capture.package_price_claims.length > 0);
  assert.equal(JSON.stringify(capture.package_price_claims).includes("9.99"), false, "the placeholder text is not kept");

  // The placeholder differs from the calculated price, and nothing reports it.
  const report = createCommercialParityReport([capture], {
    pages: [packagePricePage([{ package_id: 77, state: "Exact", unit_price: { state: "Exact", value: "49.99" } }])],
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.compared_price_claims, 0);
  assert.equal(report.unresolved_price_claims, capture.package_price_claims.length);
  assert.deepEqual(report.package_price_claims.unresolved, { package_price_not_rendered: capture.package_price_claims.length });
  assert.equal(report.coverage_complete, false);
});

test("package.price claims take the SDK's package scope, and only visible price nodes count", () => {
  const { package_price_claims: claims } = extractCommercialClaims(`
    <div data-next-package-id="3">
      <span data-next-display="package.price" data-next-format="currency">$9.99</span>
      <span data-next-display="package.price">$9.99</span>
      <span data-next-display="package.8.price">$0.00</span>
      <span data-next-display="package.price" data-next-package-id="4">$0.00</span>
      <span data-next-display="package.name">Knife</span>
      <span data-next-display="package.price_retail" data-next-format="currency">$19.99</span>
      <span data-next-display="package.price" data-next-format="number">1</span>
      <del><span data-next-display="package.price" data-next-package-id="5">$1.00</span></del>
      <span hidden data-next-display="package.price" data-next-package-id="6">$1.00</span>
    </div>
    <span data-next-display="package.price">$1.00</span>
  `);
  assert.deepEqual(claims, [
    { binding: "package.price", package_id: 3 },
    { binding: "package.8.price", package_id: 8 },
    { binding: "package.price", package_id: 4 },
    { binding: "package.price", package_id: null },
  ]);
});

test("a filled package.price is compared per unit with what calculate charges", () => {
  const matching = createCommercialParityReport([renderedCapture([renderedClaim("$49.99"), renderedClaim("USD 49.99", { binding: "package.3.price" })])], { pages: [packagePricePage()] });
  assert.deepEqual(matching.findings, []);
  assert.equal(matching.extracted_price_claims, 2);
  assert.equal(matching.compared_price_claims, 2);
  assert.equal(matching.unresolved_price_claims, 0);
  assert.equal(matching.coverage_complete, true);

  // A page printing the list price beside a live offer: the shopper pays less.
  const offered = createCommercialParityReport([renderedCapture([renderedClaim("$89.99")], { url: "https://shop.example/upsell/" })], { pages: [packagePricePage()] });
  assert.deepEqual(offered.findings, [{
    type: "price-claim-mismatch",
    page_id: "upsell",
    url: "https://shop.example/upsell/",
    binding: "package.3.price",
    package_id: 3,
    claimed: "89.99",
    calculated: "49.99",
  }]);
  assert.deepEqual(offered.assertions.map((entry) => [entry.id, entry.status, entry.severity, entry.expected, entry.actual, entry.evidence.package_id]), [
    ["price-claim-mismatch:upsell:package.3.price", "warn", "warn", "49.99", "89.99", 3],
  ]);
});

test("a package.price that cannot be proven is unresolved under a named code, never a mismatch", () => {
  const unresolved = (claim, page = packagePricePage(), extra = {}) => {
    const report = createCommercialParityReport([renderedCapture([claim], extra)], { pages: [page] });
    assert.deepEqual(report.findings, []);
    assert.equal(report.compared_price_claims, 0);
    assert.equal(report.unresolved_price_claims, 1);
    assert.equal(report.coverage_complete, false);
    return Object.keys(report.package_price_claims.unresolved);
  };

  assert.deepEqual(unresolved(renderedClaim(null, { filled: false })), ["package_price_not_filled"]);
  assert.deepEqual(unresolved(renderedClaim("$49.99", { package_id: null })), ["package_price_unresolved"], "no package scope");
  assert.deepEqual(unresolved(renderedClaim("$49.99", { package_id: 99 })), ["package_price_unresolved"], "no row for the package");
  assert.deepEqual(unresolved(renderedClaim("N/A")), ["package_price_unresolved"], "the SDK wrote its error text");
  assert.deepEqual(unresolved(renderedClaim("49,99 €")), ["package_price_unresolved"], "a decimal comma is unread, not wrong");
  assert.deepEqual(unresolved(renderedClaim(null)), ["package_price_unresolved"], "a price multiplied by a live quantity keeps no text");
  assert.deepEqual(unresolved(renderedClaim("$49.99"), packagePricePage([{ package_id: 3, state: "Exact" }])), ["package_price_unresolved"], "a response without unit_price");
  assert.deepEqual(unresolved(renderedClaim("$49.99"), packagePricePage([{ package_id: 3, state: "Unresolved", unit_price: { state: "Exact", value: "49.99" } }])), ["package_price_unresolved"], "a row that is not exact");
  assert.deepEqual(unresolved(renderedClaim("$49.99"), packagePricePage([
    { package_id: 3, state: "Exact", unit_price: { state: "Exact", value: "49.99" } },
    { package_id: 3, state: "Exact", unit_price: { state: "Exact", value: "44.99" } },
  ])), ["package_price_unresolved"], "two unit prices for one package");
  assert.deepEqual(unresolved(renderedClaim("$49.99"), packagePricePage(), { vouchers: [{ code: "FIRE" }] }), ["package_price_unresolved"], "a voucher the plan cannot price");

  // Two rows that agree still give one truth.
  const agreeing = createCommercialParityReport([renderedCapture([renderedClaim("$49.99")])], {
    pages: [packagePricePage([
      { package_id: 3, state: "Exact", unit_price: { state: "Exact", value: "49.99" } },
      { package_id: 3, state: "Exact", unit_price: { state: "Exact", value: "49.99" } },
    ])],
  });
  assert.equal(agreeing.compared_price_claims, 1);
});

test("a run in another currency leaves rendered package prices uncompared", () => {
  const report = createCommercialParityReport([renderedCapture([renderedClaim("$89.99")])], { pages: [packagePricePage()] }, {
    unresolvedMoneyClaims: "static_source_not_in_run_currency",
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.unresolved_price_claims, 1);
  assert.equal(report.unresolved_money_claims_reason, "static_source_not_in_run_currency");
});

test("source claims the rendered page did not show stay outstanding, and do not read as covered", () => {
  const source = [{ binding: "package.price", package_id: 3 }, { binding: "package.8.price", package_id: 8 }];
  const none = createCommercialParityReport([renderedCapture([], { package_price_claims: source })], { pages: [packagePricePage()] });
  assert.deepEqual(none.findings, []);
  assert.equal(none.extracted_price_claims, 2);
  assert.equal(none.compared_price_claims, 0);
  assert.equal(none.unresolved_price_claims, 2);
  assert.deepEqual(none.package_price_claims, { extracted: 2, compared: 0, unresolved: { package_price_not_visible: 2 } });
  assert.equal(none.coverage_complete, false);

  // A page with no such claim at all has nothing outstanding.
  const empty = createCommercialParityReport([renderedCapture([])], { pages: [packagePricePage()] });
  assert.equal(empty.extracted_price_claims, 0);
  assert.equal(empty.coverage_complete, true);

  // Once any is visible the rendered read is the authority: a responsive
  // duplicate hidden by CSS is not an outstanding claim.
  const some = createCommercialParityReport([renderedCapture([renderedClaim("$49.99")], { package_price_claims: source })], { pages: [packagePricePage()] });
  assert.deepEqual(some.package_price_claims, { extracted: 1, compared: 1, unresolved: {} });
  assert.equal(some.coverage_complete, true);
});

test("the package price counters add up when no comparison was made at all", () => {
  const capture = renderedCapture([renderedClaim("$49.99"), renderedClaim("$44.99")]);
  const currency = createCommercialParityReport([capture], { pages: [packagePricePage()] }, { unresolvedMoneyClaims: "static_source_not_in_run_currency" });
  assert.deepEqual(currency.package_price_claims, { extracted: 2, compared: 0, unresolved: { static_source_not_in_run_currency: 2 } });
  const overLimit = createCommercialParityReport([capture], { pages: [packagePricePage()] }, { countsOnly: true });
  assert.deepEqual(overLimit.package_price_claims, { extracted: 2, compared: 0, unresolved: { commercial_aggregate_claim_limit: 2 } });
});

test("a malformed rendered price invalidates the capture instead of reading as coverage", () => {
  const report = createCommercialParityReport([renderedCapture([{ binding: "bundle.main.price", package_id: 3, filled: true, text: "$1.00" }])], { pages: [packagePricePage()] });
  assert.equal(report.invalid_capture_count, 1);
  assert.equal(report.coverage_complete, false);
});
