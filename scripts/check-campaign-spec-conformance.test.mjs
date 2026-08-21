import test from "node:test";
import assert from "node:assert/strict";

import { FIXTURES_DIR, evaluateFixture, evaluateFixtureDir } from "./check-campaign-spec-conformance.mjs";

test("evaluateFixture splits validateSpec output by severity", () => {
  // Empty object: normalize rejects it (missing funnels[]) → exactly one
  // Normalize error-severity violation, no warnings.
  const { errors, warnings } = evaluateFixture({});
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ruleId, "Normalize");
  assert.equal(errors[0].severity, "error");
  assert.deepEqual(warnings, []);
});

test("evaluateFixture reports zero errors for a minimal conformant spec", () => {
  const spec = {
    schema_version: "4.3",
    campaign: { ref_id: 1, slug: "conformance-test", payment_env_key: "test_key" },
    runtime: { sdk_version: "0.4.37" },
    funnels: [
      {
        id: "f1",
        name: "F",
        hypothesis: "minimal conformant spec for the gate's own test",
        weight: 100,
        pages: [
          { id: "l", type: "landing", next_page: "ty" },
          { id: "ty", type: "thankyou" },
        ],
      },
    ],
  };
  const { errors } = evaluateFixture(spec);
  assert.deepEqual(errors, []);
});

test("the shipped contracts fixtures all pass with zero error-severity violations", () => {
  const results = evaluateFixtureDir(FIXTURES_DIR);
  assert.ok(results.length >= 10, `expected the 10 contracts fixtures, found ${results.length}`);
  for (const { name, errors } of results) {
    assert.deepEqual(errors, [], `${name} has error-severity violations`);
  }
});

test("a broken fixture file surfaces as a ParseError instead of crashing the run", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "spec-conformance-"));
  try {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    const results = evaluateFixtureDir(dir);
    assert.equal(results.length, 1);
    assert.equal(results[0].errors[0].ruleId, "ParseError");
    assert.equal(results[0].errors[0].severity, "error");
    assert.equal(results[0].errors[0].path, "");
    assert.deepEqual(results[0].errors[0].data, { file: "bad.json" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
