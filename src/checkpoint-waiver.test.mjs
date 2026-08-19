import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCheckpointWaiver,
  assessCheckpointWaivers,
  checkpointStateFingerprint,
  createCheckpointRegistry,
  createCheckpointWaiver,
  evaluateCheckpointRegistry,
  isNamedHuman,
} from "./checkpoint-waiver.mjs";

const SUBJECT = { public_route_slug: "exact", target_path: "_data/campaigns.json" };
const STATE = { discrepancies: [{ field: "store_url", kind: "mismatch", spec: "https://merchant.test", target: "https://wrong.test" }] };

function checkpoint(overrides = {}) {
  return {
    scope: "page_kit.store_profile",
    subject: SUBJECT,
    state_fingerprint: checkpointStateFingerprint({ scope: "page_kit.store_profile", subject: SUBJECT, state: STATE }),
    ...overrides,
  };
}

test("checkpoint fingerprints canonicalize object keys but retain array order", () => {
  const first = checkpointStateFingerprint({ scope: "scope", subject: { b: 2, a: 1 }, state: { rows: ["a", "b"] } });
  const same = checkpointStateFingerprint({ state: { rows: ["a", "b"] }, subject: { a: 1, b: 2 }, scope: "scope" });
  const reordered = checkpointStateFingerprint({ scope: "scope", subject: { a: 1, b: 2 }, state: { rows: ["b", "a"] } });
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, reordered);
});

test("checkpoint waiver assessment activates only the newest exact named-human decision", () => {
  const gate = checkpoint();
  const older = createCheckpointWaiver(gate, { reason: "Accepted for launch", waivedBy: "Avery Chen", now: "2026-08-18T00:00:00.000Z", reviewCondition: "Review before launch" });
  const newer = createCheckpointWaiver(gate, { reason: "Approved exception", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z", reviewCondition: "Review before launch" });
  const assessment = assessCheckpointWaivers([newer, older], gate, { now: "2026-08-19T01:00:00.000Z" });
  assert.deepEqual(assessment.active, newer);
  assert.deepEqual(assessment.stale, []);
  assert.deepEqual(assessment.foreign, []);
  assert.deepEqual(assessment.malformed, []);
  assert.deepEqual(assessment.expired, []);
});

test("equal waived_at timestamps select the later history entry", () => {
  const gate = checkpoint();
  const first = createCheckpointWaiver(gate, { reason: "First", waivedBy: "Avery Chen", now: "2026-08-19T00:00:00.000Z", reviewCondition: "Review before launch" });
  const later = createCheckpointWaiver(gate, { reason: "Later array record", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z", reviewCondition: "Review before launch" });
  assert.deepEqual(assessCheckpointWaivers([first, later], gate).active, later);
});

test("stale, foreign, malformed, and expired waiver records stay visible but inert", () => {
  const gate = checkpoint();
  const exact = createCheckpointWaiver(gate, { reason: "Expired decision", waivedBy: "Avery Chen", now: "2026-08-17T00:00:00.000Z", expiresAt: "2026-08-19T00:00:00.000Z", reviewCondition: "Review before launch" });
  const stale = { ...exact, expires_at: undefined, state_fingerprint: `sha256:${"0".repeat(64)}` };
  const foreign = { ...exact, expires_at: undefined, subject: { ...SUBJECT, public_route_slug: "other" } };
  const malformed = { ...exact, expires_at: undefined, waived_by: "operator" };
  const assessment = assessCheckpointWaivers([stale, foreign, malformed, exact], gate, { now: "2026-08-19T00:00:00.000Z" });
  assert.equal(assessment.active, null);
  assert.deepEqual(assessment.stale, [stale]);
  assert.deepEqual(assessment.foreign, [foreign]);
  assert.deepEqual(assessment.malformed, [malformed]);
  assert.deepEqual(assessment.expired, [exact]);
});

test("unrelated top-level waiver scopes are ignored rather than mislabeled foreign or malformed", () => {
  const gate = checkpoint();
  const unrelatedValid = {
    scope: "page_kit.sdk_version",
    subject: { public_route_slug: "exact", target_path: "_data/campaigns.json" },
    state_fingerprint: `sha256:${"1".repeat(64)}`,
    reason: "Separate approved exception",
    waived_by: "Jordan Lee",
    waived_at: "2026-08-19T00:00:00.000Z",
  };
  const unrelatedLegacy = { scope: "polish.source_freshness", waiver: "legacy-shape" };
  assert.deepEqual(assessCheckpointWaivers([unrelatedValid, unrelatedLegacy], gate), {
    active: null,
    stale: [],
    foreign: [],
    malformed: [],
    expired: [],
  });
});

test("checkpoint waiver creation rejects placeholders and append preserves history", () => {
  for (const value of [
    "", "x", "operator", "cli_flag", "agent", "automation", "system", "unknown", "anonymous", "n/a", "none",
    "bot", "AI", "ci", "github-actions", "GitHub Actions", "github_actions",
    "Codex Agent", "codex-agent", "codex_agent", "CodexAgent", "Automation Runner", "Automation_Runner",
    "System Operator", "SystemOperator", "GitHub Actions Runner", "GitHubActionsRunner",
    "Claude Code", "ClaudeCode", "Service Daemon", "Workflow Runner",
  ]) {
    assert.equal(isNamedHuman(value), false, value);
  }
  assert.equal(isNamedHuman("Jordan Lee"), true);
  assert.equal(isNamedHuman("Avery"), true, "real one-word human names remain valid");
  assert.equal(isNamedHuman("Claude"), true, "a product-name token can still be a real one-word human name");
  assert.throws(() => createCheckpointWaiver(checkpoint(), { reason: "because", waivedBy: "operator", reviewCondition: "Review before launch" }), /named human/i);
  assert.throws(() => createCheckpointWaiver(checkpoint(), { reason: " ", waivedBy: "Jordan Lee", reviewCondition: "Review before launch" }), /reason/i);
  assert.throws(
    () => createCheckpointWaiver(checkpoint(), { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z" }),
    /expires_at or review_condition/i,
  );
  assert.throws(
    () => createCheckpointWaiver(checkpoint(), { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z", reviewCondition: "  " }),
    /review_condition/i,
  );
  assert.throws(
    () => createCheckpointWaiver(checkpoint(), { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z", expiresAt: "2026-08-19T00:00:00.000Z" }),
    /later than waived_at/i,
  );
  const waiver = createCheckpointWaiver(checkpoint(), {
    reason: "Approved",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "  Re-evaluate before production launch.  ",
  });
  assert.equal(waiver.review_condition, "Re-evaluate before production launch.");
  assert.deepEqual(appendCheckpointWaiver({ waivers: [{ scope: "older" }] }, waiver).waivers, [{ scope: "older" }, waiver]);
  assert.deepEqual(appendCheckpointWaiver({}, waiver).waivers, [waiver]);
});

test("missing or malformed waiver bounds stay inert", () => {
  const gate = checkpoint();
  const exact = createCheckpointWaiver(gate, {
    reason: "Approved",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate before launch",
  });
  const missingBound = { ...exact };
  delete missingBound.review_condition;
  const blankReview = { ...exact, review_condition: " " };
  const invalidExpiry = { ...exact, review_condition: undefined, expires_at: "not-a-date" };
  const nonFutureExpiry = { ...exact, review_condition: undefined, expires_at: exact.waived_at };
  const assessment = assessCheckpointWaivers(
    [missingBound, blankReview, invalidExpiry, nonFutureExpiry],
    gate,
    { now: "2026-08-19T00:30:00.000Z" },
  );
  assert.equal(assessment.active, null);
  assert.deepEqual(assessment.malformed, [missingBound, blankReview, invalidExpiry, nonFutureExpiry]);
});

test("checkpoint registry rejects ambiguity and evaluates only a named gate", () => {
  const registry = createCheckpointRegistry([{ id: "page_kit.store_profile", evaluate: ({ value }) => value }]);
  assert.equal(evaluateCheckpointRegistry(registry, "page_kit.store_profile", { value: 42 }), 42);
  assert.throws(() => evaluateCheckpointRegistry(registry, "unknown", {}), /Unknown checkpoint gate/);
  assert.throws(() => createCheckpointRegistry([
    { id: "duplicate", evaluate: () => null },
    { id: "duplicate", evaluate: () => null },
  ]), /duplicate/);
});

test("invalid waiver timestamps are malformed and expiry is inclusive", () => {
  const gate = checkpoint();
  const valid = createCheckpointWaiver(gate, { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-08-19T00:00:00.000Z", reviewCondition: "Review before launch" });
  const invalidWaivedAt = { ...valid, waived_at: "not-a-date" };
  const invalidExpiry = { ...valid, expires_at: "not-a-date" };
  const expiresNow = { ...valid, expires_at: "2026-08-19T01:00:00.000Z" };
  const assessment = assessCheckpointWaivers([invalidWaivedAt, invalidExpiry, expiresNow], gate, { now: "2026-08-19T01:00:00.000Z" });
  assert.equal(assessment.active, null);
  assert.deepEqual(assessment.malformed, [invalidWaivedAt, invalidExpiry]);
  assert.deepEqual(assessment.expired, [expiresNow]);
  assert.throws(() => createCheckpointWaiver(gate, { reason: "Approved", waivedBy: "Jordan Lee", now: "not-a-date", reviewCondition: "Review before launch" }), /waived_at/);
  assert.throws(() => createCheckpointWaiver(gate, { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-08-19", reviewCondition: "Review before launch" }), /waived_at/);
  assert.throws(() => createCheckpointWaiver(gate, { reason: "Approved", waivedBy: "Jordan Lee", now: "2026-02-30T00:00:00.000Z", reviewCondition: "Review before launch" }), /waived_at/);
  assert.throws(() => createCheckpointWaiver(gate, { reason: "Approved", waivedBy: "Jordan Lee", expiresAt: "not-a-date" }), /expires_at/);
});
