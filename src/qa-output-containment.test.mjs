import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { __qaNodeTestHooks } from "./qa-node.mjs";

const { campaignOutputDir } = __qaNodeTestHooks;

test("campaignOutputDir keeps every artifact inside the operator's output directory", () => {
  assert.equal(
    campaignOutputDir("qa-output", "example-sdk04-offers"),
    resolve("qa-output", "example-sdk04-offers"),
  );
});

test("campaignOutputDir refuses a slug that escapes the output directory", () => {
  for (const slug of ["../../../../tmp/evil", "..", "/tmp/evil", "nested/../../escape", ""]) {
    assert.throws(
      () => campaignOutputDir("qa-output", slug),
      /escapes the output directory/,
      JSON.stringify(slug),
    );
  }
});
