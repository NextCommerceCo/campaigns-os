import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldPublishVerdict } from "./qa-node.mjs";

// Publishing the QA verdict to the Campaign Map QA portal is the default shape:
// LLM/agent UIs are the primary interface, so a run should land in the portal
// without the operator needing to know a flag.

test("publishes by default (no flags)", () => {
  assert.equal(shouldPublishVerdict({}), true);
});

test("explicit --post-verdict still opts in", () => {
  assert.equal(shouldPublishVerdict({ "post-verdict": true }), true);
});

test("--no-post-verdict opts out", () => {
  assert.equal(shouldPublishVerdict({ "no-post-verdict": true }), false);
});

test("--local-only opts out", () => {
  assert.equal(shouldPublishVerdict({ "local-only": true }), false);
});

test("--post-verdict false opts out", () => {
  assert.equal(shouldPublishVerdict({ "post-verdict": "false" }), false);
  assert.equal(shouldPublishVerdict({ "post-verdict": "off" }), false);
  assert.equal(shouldPublishVerdict({ "post-verdict": "no" }), false);
});

test("unrelated flags do not affect the default", () => {
  assert.equal(shouldPublishVerdict({ browser: true, "test-order": "common" }), true);
});
