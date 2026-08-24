import assert from "node:assert/strict";
import test from "node:test";

import {
  CommercialParityLimitError,
  createCommercialParityReport,
  diffCommercialParity,
  extractCommercialClaims,
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
