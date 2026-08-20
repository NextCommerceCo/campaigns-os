import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCapture } from "./qa-analytics-parity.mjs";
import { __qaBrowserTestHooks, runAnalyticsParityChecks } from "./qa-browser.mjs";

const SECRET_PATTERN = /ref-secret|order-secret|fragment-secret/;

test("analytics parity input failures publish only query-free URL summaries", async () => {
  const candidateOnly = await runAnalyticsParityChecks({
    "analytics-candidate": "https://candidate.example/receipt/?ref_id=ref-secret&order_id=order-secret#fragment-secret",
  });
  const baselineOnly = await runAnalyticsParityChecks({
    "analytics-baseline": "https://baseline.example/receipt/?ref_id=ref-secret&order_id=order-secret#fragment-secret",
  });

  assert.equal(candidateOnly[0].url, "https://candidate.example/receipt/");
  assert.equal(candidateOnly[0].evidence.url, "https://candidate.example/receipt/");
  assert.match(candidateOnly[0].actual, /candidate=https:\/\/candidate\.example\/receipt\//);
  assert.equal(baselineOnly[0].url, "https://baseline.example/receipt/");
  assert.match(baselineOnly[0].actual, /baseline=https:\/\/baseline\.example\/receipt\//);
  assert.doesNotMatch(JSON.stringify({ candidateOnly, baselineOnly }), SECRET_PATTERN);
});

test("successful analytics parity projections redact every published URL", () => {
  const capture = normalizeCapture({
    events: [{
      layer: "dataLayer",
      data: { event: "dl_purchase", ecommerce: { value: 49.99, currency: "USD", transaction_id: "txn" } },
    }],
    tagFires: [],
  });
  const assertions = __qaBrowserTestHooks.analyticsParityCaptureAssertions({
    baseline: capture,
    candidate: capture,
    baselineUrl: "https://baseline.example/receipt/?ref_id=baseline-query-secret&order_id=baseline-order-secret",
    candidateUrl: "https://candidate.example/receipt/?ref_id=candidate-query-secret&order_id=candidate-order-secret",
  });

  const captureAssertion = assertions.find((item) => item.id === "analytics-parity:capture");
  assert.equal(captureAssertion.status, "pass");
  assert.equal(captureAssertion.url, "https://candidate.example/receipt/");
  assert.equal(captureAssertion.evidence.url, "https://candidate.example/receipt/");
  assert.equal(captureAssertion.evidence.baseline_url, "https://baseline.example/receipt/");
  assert.equal(captureAssertion.evidence.candidate_url, "https://candidate.example/receipt/");
  for (const item of assertions) {
    assert.equal(item.url, "https://candidate.example/receipt/", item.id);
    assert.equal(item.evidence.url, "https://candidate.example/receipt/", item.id);
  }
  assert.doesNotMatch(JSON.stringify(assertions), /query-secret|order-secret/);
});

test("analytics parity runner failures publish a fixed error and safe URL evidence", () => {
  const assertion = __qaBrowserTestHooks.analyticsParityRunnerFailureAssertion({
    baselineUrl: "https://baseline.example/receipt/?ref_id=baseline-query-secret&order_id=baseline-order-secret",
    candidateUrl: "https://candidate.example/receipt/?ref_id=candidate-query-secret&order_id=candidate-order-secret",
    error: new Error("raw-error-secret at https://candidate.example/receipt/?ref_id=raw-ref-secret"),
  });

  assert.equal(assertion.url, "https://candidate.example/receipt/");
  assert.equal(assertion.actual, "analytics capture could not be read from the settled page");
  assert.deepEqual(assertion.evidence, {
    url: "https://candidate.example/receipt/",
    baseline_url: "https://baseline.example/receipt/",
    candidate_url: "https://candidate.example/receipt/",
    error_code: "analytics_capture_unreadable",
  });
  assert.doesNotMatch(JSON.stringify(assertion), /query-secret|order-secret|raw-error-secret|raw-ref-secret/);
});

test("analytics correctness runner failures publish a fixed error and safe root URL", () => {
  const assertion = __qaBrowserTestHooks.analyticsCorrectnessRunnerFailureAssertion({
    url: "https://candidate.example/campaign/?ref_id=root-ref-secret&order_id=root-order-secret",
    error: new Error("raw-error-secret at https://candidate.example/campaign/?ref_id=raw-ref-secret"),
  });

  assert.equal(assertion.url, "https://candidate.example/campaign/");
  assert.equal(assertion.actual, "analytics capture could not be read from the settled page");
  assert.deepEqual(assertion.evidence, {
    url: "https://candidate.example/campaign/",
    error_code: "analytics_capture_unreadable",
  });
  assert.doesNotMatch(JSON.stringify(assertion), /root-ref-secret|root-order-secret|raw-error-secret|raw-ref-secret/);
});

test("successful analytics correctness projections redact every published root URL", () => {
  const assertions = __qaBrowserTestHooks.analyticsCorrectnessCaptureAssertions({
    capture: normalizeCapture({
      events: [],
      tagFires: [{ kind: "gtm", id: "GTM-ABC123", host: "googletagmanager.com", params: {} }],
    }),
    contract: { providers: { gtm: { enabled: true, containerId: "GTM-ABC123" } } },
    url: "https://candidate.example/campaign/?ref_id=root-ref-secret&order_id=root-order-secret",
  });

  const captureAssertion = assertions.find((item) => item.id === "analytics-correctness:capture");
  assert.equal(captureAssertion.status, "pass");
  for (const item of assertions) {
    assert.equal(item.url, "https://candidate.example/campaign/", item.id);
    assert.equal(item.evidence.url, "https://candidate.example/campaign/", item.id);
  }
  assert.doesNotMatch(JSON.stringify(assertions), /root-ref-secret|root-order-secret/);
});
