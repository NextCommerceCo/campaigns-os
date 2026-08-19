import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePageKitSdkVersion,
  PAGE_KIT_SDK_VERSION_SCOPE,
} from "./page-kit-sdk-version.mjs";
import { createCheckpointWaiver } from "./checkpoint-waiver.mjs";

function targetLoad(sdkVersion = "0.4.37", overrides = {}) {
  return {
    status: "ok",
    public_route_slug: "merchant",
    target_path: "_data/campaigns.json",
    entry: { sdk_version: sdkVersion },
    ...overrides,
  };
}

test("SDK-pin evaluator passes an exact released runtime pin", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.37" } },
    targetLoad: targetLoad(),
  });

  assert.equal(PAGE_KIT_SDK_VERSION_SCOPE, "page_kit.sdk_version");
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "page_kit.sdk_version.pass");
  assert.equal(gate.expected_sdk_version, "0.4.37");
  assert.equal(gate.observed_sdk_version, "0.4.37");
  assert.equal(gate.expected_source, "runtime.sdk_version");
  assert.equal(gate.waivable, false);
  assert.equal(gate.waiver, null);
});

test("SDK-pin evaluator falls back to the legacy global_config declaration", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: { global_config: { sdk_version: "0.4.37" } },
    targetLoad: targetLoad(),
  });

  assert.equal(gate.status, "pass");
  assert.equal(gate.expected_sdk_version, "0.4.37");
  assert.equal(gate.expected_source, "global_config.sdk_version");
});

test("equal runtime and legacy declarations are valid and runtime is preferred", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: {
      runtime: { sdk_version: "0.4.37" },
      global_config: { sdk_version: "0.4.37" },
    },
    targetLoad: targetLoad(),
  });

  assert.equal(gate.status, "pass");
  assert.equal(gate.expected_source, "runtime.sdk_version");
});

test("differing runtime and legacy declarations block without a waiver lane", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: {
      runtime: { sdk_version: "0.4.37" },
      global_config: { sdk_version: "0.4.36" },
    },
    targetLoad: targetLoad(),
  });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "page_kit.sdk_version.spec_conflict");
  assert.equal(gate.waivable, false);
  assert.equal(gate.state_fingerprint, null);
  assert.equal(gate.expected_sdk_version, null);
  assert.equal(gate.observed_sdk_version, "0.4.37");
  assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_spec"]);

  const untrustedTarget = evaluatePageKitSdkVersion({
    spec: {
      runtime: { sdk_version: "0.4.37" },
      global_config: { sdk_version: "0.4.36" },
    },
    targetLoad: targetLoad({ private_token: "private-target-sentinel" }),
  });
  assert.equal(untrustedTarget.observed_sdk_version, null);
  assert.equal(JSON.stringify(untrustedTarget).includes("private_token"), false);
  assert.equal(JSON.stringify(untrustedTarget).includes("private-target-sentinel"), false);
});

test("present empty, non-string, prerelease, and non-canonical declarations are non-waivable", () => {
  const invalidCases = [
    { runtime: { sdk_version: "" } },
    { runtime: { sdk_version: " 0.4.37 " } },
    { runtime: { sdk_version: "v0.4.37" } },
    { runtime: { sdk_version: "0.4" } },
    { runtime: { sdk_version: "01.2.3" } },
    { runtime: { sdk_version: "0.4.37-beta.1" } },
    { runtime: { sdk_version: 37 } },
    { runtime: { sdk_version: null } },
    {
      runtime: { sdk_version: "0.4.37" },
      global_config: { sdk_version: "" },
    },
  ];

  for (const spec of invalidCases) {
    const gate = evaluatePageKitSdkVersion({ spec, targetLoad: targetLoad() });
    assert.equal(gate.status, "blocked", JSON.stringify(spec));
    assert.equal(gate.code, "page_kit.sdk_version.spec_invalid", JSON.stringify(spec));
    assert.equal(gate.waivable, false, JSON.stringify(spec));
    assert.equal(gate.state_fingerprint, null, JSON.stringify(spec));
    assert.equal(gate.expected_sdk_version, null, JSON.stringify(spec));
  }
});

test("a missing CampaignSpec SDK declaration is a non-waivable blocker", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: { runtime: {}, global_config: {} },
    targetLoad: targetLoad(),
  });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "page_kit.sdk_version.spec_missing");
  assert.equal(gate.waivable, false);
  assert.equal(gate.state_fingerprint, null);
  assert.equal(gate.expected_sdk_version, null);
  assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_spec"]);
});

test("an unavailable packet-local CampaignSpec is a non-waivable blocker", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: null,
    specStatus: "invalid_json",
    targetLoad: targetLoad(),
  });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "page_kit.sdk_version.spec_unavailable");
  assert.equal(gate.waivable, false);
  assert.equal(gate.state_fingerprint, null);
  assert.equal(gate.expected_sdk_version, null);
});

test("a missing target is pre-scaffold not_applicable and packet-ready blocked", () => {
  const missingTarget = targetLoad(undefined, { status: "file_missing", entry: null });
  const beforeScaffold = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.37" } },
    targetLoad: missingTarget,
    required: false,
  });
  const packetReady = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.37" } },
    targetLoad: missingTarget,
    required: true,
  });

  assert.equal(beforeScaffold.status, "not_applicable");
  assert.equal(beforeScaffold.code, "page_kit.sdk_version.not_applicable");
  assert.equal(packetReady.status, "blocked");
  assert.equal(packetReady.code, "page_kit.sdk_version.target_unavailable");
  assert.equal(packetReady.waivable, false);
  assert.equal(packetReady.state_fingerprint, null);
});

test("a missing or invalid target SDK pin is a non-waivable blocker", () => {
  const cases = [
    [{}, "page_kit.sdk_version.target_missing"],
    [{ sdk_version: "" }, "page_kit.sdk_version.target_invalid"],
    [{ sdk_version: "0.4" }, "page_kit.sdk_version.target_invalid"],
    [{ sdk_version: "0.4.37-rc.1" }, "page_kit.sdk_version.target_invalid"],
    [{ sdk_version: 37 }, "page_kit.sdk_version.target_invalid"],
  ];

  for (const [entry, code] of cases) {
    const gate = evaluatePageKitSdkVersion({
      spec: { runtime: { sdk_version: "0.4.37" } },
      targetLoad: targetLoad(undefined, { entry }),
    });
    assert.equal(gate.status, "blocked", JSON.stringify(entry));
    assert.equal(gate.code, code, JSON.stringify(entry));
    assert.equal(gate.waivable, false, JSON.stringify(entry));
    assert.equal(gate.state_fingerprint, null, JSON.stringify(entry));
    assert.equal(gate.observed_sdk_version, null, JSON.stringify(entry));
    assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_target"]);
  }
});

test("an exact released SDK pair mismatch is fingerprinted and waivable", () => {
  const gate = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.36" } },
    targetLoad: targetLoad("0.4.37", { public_route_slug: "/merchant/" }),
  });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, PAGE_KIT_SDK_VERSION_SCOPE);
  assert.equal(gate.waivable, true);
  assert.deepEqual(gate.subject, {
    public_route_slug: "merchant",
    target_path: "_data/campaigns.json",
  });
  assert.deepEqual(gate.state, {
    expected: "0.4.36",
    observed: "0.4.37",
  });
  assert.match(gate.state_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(gate.required_actions.map((action) => action.id), [
    "repair_target",
    "waive_checkpoint",
  ]);
});

test("an exact current named-human waiver is visible through the safe projection", () => {
  const blocked = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.36" } },
    targetLoad: targetLoad("0.4.37"),
  });
  const waiver = createCheckpointWaiver(blocked, {
    reason: "Intentional SDK pin for compatibility testing",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    reviewCondition: "Re-evaluate before production launch",
  });
  const rawWaiver = {
    ...waiver,
    private_token: "must-not-leak",
    nested: { secret: "also-private" },
  };
  const gate = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.36" } },
    targetLoad: targetLoad("0.4.37"),
    waivers: [rawWaiver],
    now: "2026-08-19T01:00:00.000Z",
  });

  assert.equal(gate.status, "waived");
  assert.equal(gate.code, "page_kit.sdk_version.waived");
  assert.equal(gate.waiver.waived_by, "Jordan Lee");
  assert.equal(gate.waiver.reason, "Intentional SDK pin for compatibility testing");
  assert.deepEqual(gate.waiver_assessment.inert_counts, {
    stale: 0,
    foreign: 0,
    malformed: 0,
    expired: 0,
  });
  assert.equal(JSON.stringify(gate).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(gate).includes("also-private"), false);
  assert.deepEqual(gate.required_actions, []);
});

test("malformed, expired, foreign-slug, and wrong-pair decisions remain inert while a clean pair ignores history", () => {
  const blocked = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.36" } },
    targetLoad: targetLoad("0.4.37"),
  });
  const base = createCheckpointWaiver(blocked, {
    reason: "Intentional SDK pin",
    waivedBy: "Jordan Lee",
    now: "2026-08-17T00:00:00.000Z",
    reviewCondition: "Review before launch",
  });
  const expired = createCheckpointWaiver(blocked, {
    reason: "Expired SDK pin decision",
    waivedBy: "Jordan Lee",
    now: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-18T00:00:00.000Z",
  });
  const waivers = [
    { ...base, state_fingerprint: `sha256:${"0".repeat(64)}`, private_token: "wrong-pair-secret" },
    { ...base, subject: { ...base.subject, public_route_slug: "foreign" }, private_token: "foreign-secret" },
    { ...base, waived_at: "not-a-time", private_token: "malformed-secret" },
    { ...expired, private_token: "expired-secret" },
  ];
  const stillBlocked = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.36" } },
    targetLoad: targetLoad("0.4.37"),
    waivers,
    now: "2026-08-19T00:00:00.000Z",
  });

  assert.equal(stillBlocked.status, "blocked");
  assert.deepEqual(stillBlocked.waiver_assessment, {
    active: null,
    inert_counts: { stale: 1, foreign: 1, malformed: 1, expired: 1 },
  });
  assert.equal(JSON.stringify(stillBlocked).includes("-secret"), false);

  const corrected = evaluatePageKitSdkVersion({
    spec: { runtime: { sdk_version: "0.4.37" } },
    targetLoad: targetLoad("0.4.37"),
    waivers,
    now: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(corrected.status, "pass");
  assert.deepEqual(corrected.waiver_assessment, {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  });
});
