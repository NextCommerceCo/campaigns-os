import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createVerdict, deriveExceptions, QA_ASSERTION_FAMILY_VOCABULARY, SEVERITY, STATUS, summarizePurchaseProof, validateVerdict } from "./qa-verdict.mjs";

const baseVerdict = {
  runId: "RUN1",
  mapId: "map-1",
  specVersion: "4.3",
  specHash: "abc123",
  startedAt: "2026-06-03T00:00:00.000Z",
  completedAt: "2026-06-03T00:01:00.000Z",
  runtime: "test-runtime",
  assertions: [],
};

test("deriveExceptions captures fail, warn, manual_review, and warning severity assertions", () => {
  const assertions = [
    { id: "a", family: "browser-runtime", page: "checkout", status: STATUS.PASS },
    { id: "b", family: "browser-runtime", page: "checkout", status: STATUS.FAIL, severity: SEVERITY.WARN, expected: "ok", actual: "bad" },
    { id: "c", family: "browser-runtime", page: "checkout", status: STATUS.MANUAL_REVIEW, severity: SEVERITY.WARN },
    { id: "d", family: "browser-runtime", page: "checkout", status: STATUS.WARN, severity: SEVERITY.WARN },
  ];

  assert.deepEqual(deriveExceptions(assertions).map((exception) => exception.id), ["b", "c", "d"]);
});

test("createVerdict populates exceptions by default for ready_with_exceptions runs", () => {
  const verdict = createVerdict({
    ...baseVerdict,
    assertions: [
      { id: "browser-load:checkout", family: "browser-runtime", page: "checkout", status: STATUS.PASS },
      { id: "browser-commerce-structure:checkout", family: "browser-runtime", page: "checkout", status: STATUS.FAIL, severity: SEVERITY.WARN },
    ],
  });

  assert.equal(verdict.disposition, "ready_with_exceptions");
  assert.deepEqual(verdict.exceptions.map((exception) => exception.id), ["browser-commerce-structure:checkout"]);
});

test("explicit empty exceptions remain explicit", () => {
  const verdict = createVerdict({
    ...baseVerdict,
    assertions: [
      { id: "manual", family: "browser-runtime", page: "checkout", status: STATUS.MANUAL_REVIEW, severity: SEVERITY.WARN },
    ],
    exceptions: [],
  });

  assert.equal(verdict.disposition, "ready_with_exceptions");
  assert.deepEqual(verdict.exceptions, []);
});

test("createVerdict carries campaign base, entry URLs, resolved page URLs, and tested URL alias", () => {
  const verdict = createVerdict({
    ...baseVerdict,
    baseUrl: Object("https://preview.example.test/shield/"),
    entryUrls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "https://preview.example.test/shield/presell-running/",
      },
    ],
    pageUrls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "https://preview.example.test/shield/presell-running/",
      },
      {
        funnel_id: "default",
        page_id: "checkout",
        page_type: "checkout",
        url: "https://preview.example.test/shield/checkout/",
      },
    ],
    testedUrls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "https://preview.example.test/shield/presell-running/",
      },
      {
        funnel_id: "default",
        page_id: "checkout",
        page_type: "checkout",
        url: "https://preview.example.test/shield/checkout/",
      },
    ],
  });

  assert.equal(verdict.base_url, "https://preview.example.test/shield/");
  assert.deepEqual(verdict.entry_urls.map((entry) => entry.url), ["https://preview.example.test/shield/presell-running/"]);
  assert.deepEqual(verdict.page_urls.map((entry) => entry.page_type), ["presell", "checkout"]);
  assert.deepEqual(verdict.tested_urls.map((entry) => entry.page_type), ["presell", "checkout"]);
});

test("createVerdict does not infer tested URLs from page URLs", () => {
  const verdict = createVerdict({
    ...baseVerdict,
    pageUrls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "https://preview.example.test/shield/presell-running/",
      },
    ],
  });

  assert.deepEqual(verdict.page_urls.map((entry) => entry.page_id), ["presell"]);
  assert.deepEqual(verdict.tested_urls, []);
});

test("createVerdict emits empty URL arrays consistently", () => {
  const verdict = createVerdict(baseVerdict);

  assert.deepEqual(verdict.entry_urls, []);
  assert.deepEqual(verdict.page_urls, []);
  assert.deepEqual(verdict.tested_urls, []);
});

// #170: the verdict campaign_slug field carries the Map ID for schema
// back-compat — the one identity confusion the docs warn about hardest. The
// true route slug now rides alongside it, additively.
test("createVerdict surfaces public_route_slug alongside the back-compat campaign_slug Map ID", () => {
  const verdict = createVerdict({ ...baseVerdict, publicRouteSlug: "shield" });

  assert.equal(verdict.campaign_slug, baseVerdict.mapId);
  assert.equal(verdict.public_route_slug, "shield");
});

test("createVerdict emits public_route_slug null when no route slug is known", () => {
  const verdict = createVerdict(baseVerdict);

  assert.equal(verdict.public_route_slug, null);
});

test("createVerdict carries the compact commercial evidence section", () => {
  const commercial = {
    schema_version: "campaigns-os-commercial-parity/v0",
    status: "mismatch",
    coverage_complete: true,
    finding_count: 1,
    findings: [{ type: "price-claim-mismatch" }],
  };
  const verdict = createVerdict({ ...baseVerdict, commercial });

  assert.deepEqual(verdict.commercial, commercial);
  assert.deepEqual(validateVerdict(verdict), []);
});

test("commercial disposition changes only for proven mismatches, not incomplete proof", () => {
  const pass = {
    id: "http:checkout",
    family: "funnel-flow",
    page: "checkout",
    status: STATUS.PASS,
  };
  const warn = {
    id: "browser:manual",
    family: "browser-runtime",
    page: "checkout",
    status: STATUS.WARN,
    severity: SEVERITY.WARN,
  };
  const blocker = {
    id: "http:checkout",
    family: "funnel-flow",
    page: "checkout",
    status: STATUS.FAIL,
    severity: SEVERITY.BLOCKER,
  };
  const disposition = (assertions, status) => createVerdict({
    ...baseVerdict,
    assertions,
    commercial: {
      schema_version: "campaigns-os-commercial-parity/v0",
      status,
      coverage_complete: status !== "incomplete",
      finding_count: status === "mismatch" ? 1 : 0,
      findings: status === "mismatch" ? [{ type: "price-claim-mismatch" }] : [],
    },
  }).disposition;

  assert.equal(disposition([pass], "incomplete"), "ready");
  assert.equal(disposition([pass], "mismatch"), "ready_with_exceptions");
  assert.equal(disposition([pass, warn], "incomplete"), "ready_with_exceptions");
  assert.equal(disposition([blocker], "mismatch"), "blocked");
});

test("commercial mismatch keeps an exception disposition when the flat assertion budget is exhausted", () => {
  const assertions = Array.from({ length: 500 }, (_, index) => ({
    id: `pass:${index}`,
    family: "funnel-flow",
    page: "campaign",
    status: STATUS.PASS,
    expected: "pass",
    actual: "pass",
  }));
  const verdict = createVerdict({
    ...baseVerdict,
    assertions,
    commercial: {
      schema_version: "campaigns-os-commercial-parity/v0",
      status: "mismatch",
      coverage_complete: true,
      finding_count: 1,
      omitted_assertion_count: 1,
      findings: [{ type: "price-claim-mismatch" }],
    },
  });

  assert.equal(verdict.assertions.length, 500);
  assert.equal(verdict.disposition, "ready_with_exceptions");
});

test("validateVerdict rejects a non-object commercial section", () => {
  const verdict = createVerdict(baseVerdict);
  verdict.commercial = [];

  assert.match(validateVerdict(verdict).join("\n"), /commercial: must be an object/);
});

test("QA_ASSERTION_FAMILY_VOCABULARY matches every family literal the runner emits", () => {
  // Drift guard for external consumers importing the vocabulary (the portal
  // proxy's verdict allowlist keys off it). Collect every `family: "..."`
  // literal from non-test runner source and require set equality: a new
  // emitter family missing from the vocabulary fails here, and so does a
  // vocabulary entry no emitter uses. An emitter that builds a family from a
  // constant or template instead of a literal must extend this scan.
  const srcDir = fileURLToPath(new URL("./", import.meta.url));
  const emitted = new Set();
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    // Strip comments so a family named in prose never counts as emitted; the
    // lookbehind keeps prefixed keys like template_family: out of the scan.
    const source = readFileSync(`${srcDir}${name}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const match of source.matchAll(/(?<![\w$])family:\s*["']([A-Za-z_-]+)["']/g)) {
      emitted.add(match[1]);
    }
  }
  assert.ok(emitted.size > 0, "expected the emitter scan to find family literals");
  assert.deepEqual(
    [...emitted].sort(),
    [...QA_ASSERTION_FAMILY_VOCABULARY].sort(),
    "QA_ASSERTION_FAMILY_VOCABULARY must equal the set of family literals emitted by src/*.mjs",
  );
});

// Purchase-proof summary: counts only, by design. This rides into the committed
// assembly report and the readback bundle, and the sidecar projection strips
// order ids, refs, emails and URLs from the verdict for exactly that reason —
// so the summary must carry none of them either.

test("summarizePurchaseProof counts order paths without carrying any order identity", () => {
  const summary = summarizePurchaseProof({
    verdict: {
      test_orders: [
        { path: "accept", ok: true, next_order_id: "1001", ref_id: "REF-1", qa_email: "qa@example.test", is_test: true, checkout_url: "https://example.test/checkout", verification: { verified: true } },
        { path: "accept", ok: true, next_order_id: "1002", ref_id: "REF-2", qa_email: "qa@example.test", is_test: true, checkout_url: "https://example.test/checkout", verification: { verified: false } },
      ],
    },
    proofPolicy: { order_path_depth: "common", typed_card_depth: "common" },
  });
  assert.deepEqual(summary, {
    declared_order_path_depth: "common",
    declared_typed_card_depth: "common",
    order_paths_executed: 2,
    orders_created: 2,
    orders_verified: 1,
    all_orders_test_mode: true,
  });
  const serialized = JSON.stringify(summary);
  for (const leak of ["1001", "1002", "REF-1", "REF-2", "example.test", "qa@"]) {
    assert.equal(serialized.includes(leak), false, `summary must not carry ${leak}`);
  }
});

test("summarizePurchaseProof reports an explicit zero for a --test-order off run", () => {
  const summary = summarizePurchaseProof({ verdict: { test_orders: [] }, proofPolicy: { order_path_depth: "common" } });
  assert.equal(summary.order_paths_executed, 0);
  assert.equal(summary.orders_created, 0);
  assert.equal(summary.all_orders_test_mode, null);
  assert.equal(summary.declared_typed_card_depth, null);
});

test("summarizePurchaseProof flags an order that is not in test mode", () => {
  const summary = summarizePurchaseProof({
    verdict: { test_orders: [{ next_order_id: "1", is_test: true }, { next_order_id: "2", is_test: false }] },
    proofPolicy: {},
  });
  assert.equal(summary.all_orders_test_mode, false);
  assert.equal(summary.declared_order_path_depth, null);
});

test("summarizePurchaseProof tolerates a malformed verdict", () => {
  assert.equal(summarizePurchaseProof({ verdict: null, proofPolicy: null }).order_paths_executed, 0);
  assert.equal(summarizePurchaseProof({ verdict: { test_orders: "nope" } }).order_paths_executed, 0);
});

// Kilo review, PR #315: `Number.isFinite(0)` is true, and the `??` chain stops
// at a literal 0 rather than falling through to the next field, so a run that
// received no ids at all reported every order as created.
test("summarizePurchaseProof does not count a numeric zero id as an order created", () => {
  const summary = summarizePurchaseProof({
    verdict: { test_orders: [{ next_order_id: 0, order_id: 0, ref_id: 0, is_test: true }, { next_order_id: 0, order_id: 0, ref_id: 0, is_test: true }] },
    proofPolicy: { order_path_depth: "common" },
  });
  assert.equal(summary.order_paths_executed, 2);
  assert.equal(summary.orders_created, 0);
});

test("summarizePurchaseProof still counts a positive numeric id", () => {
  const summary = summarizePurchaseProof({ verdict: { test_orders: [{ next_order_id: 1001, is_test: true }] } });
  assert.equal(summary.orders_created, 1);
});

test("deriveExceptions carries the per-finding cause label through to the exception", () => {
  const [exception] = deriveExceptions([
    {
      id: "http:checkout",
      family: "funnel-flow",
      page: "checkout",
      status: STATUS.FAIL,
      severity: SEVERITY.BLOCKER,
      cause: "pre_existing",
      cause_reason: "same_status_in_prior_run",
    },
  ]);
  assert.equal(exception.cause, "pre_existing");
  assert.equal(exception.cause_reason, "same_status_in_prior_run");
});

test("an assertion with no cause does not grow empty cause keys on the exception", () => {
  const [exception] = deriveExceptions([
    { id: "http:checkout", family: "funnel-flow", page: "checkout", status: STATUS.WARN, severity: SEVERITY.WARN },
  ]);
  assert.equal("cause" in exception, false);
  assert.equal("cause_reason" in exception, false);
});

test("createVerdict carries a cause summary when one is supplied, and omits it otherwise", () => {
  const summary = { schema_version: "campaigns-os-finding-cause/v0", total: 3, counts: { caused_by_change: 1, pre_existing: 2 }, prior_run_id: "qa_prior", comparison: "prior_run" };
  assert.deepEqual(createVerdict({ ...baseVerdict, causeSummary: summary }).cause_summary, summary);
  assert.equal("cause_summary" in createVerdict({ ...baseVerdict }), false);
});
