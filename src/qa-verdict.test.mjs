import test from "node:test";
import assert from "node:assert/strict";

import { createVerdict, deriveExceptions, SEVERITY, STATUS } from "./qa-verdict.mjs";

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

test("createVerdict carries campaign base, entry URLs, and tested URLs when provided", () => {
  const verdict = createVerdict({
    ...baseVerdict,
    baseUrl: "https://preview.example.test/shield/",
    entryUrls: [
      {
        funnel_id: "default",
        page_id: "presell",
        page_type: "presell",
        url: "https://preview.example.test/shield/presell-running/",
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
  assert.deepEqual(verdict.tested_urls.map((entry) => entry.page_type), ["presell", "checkout"]);
});
