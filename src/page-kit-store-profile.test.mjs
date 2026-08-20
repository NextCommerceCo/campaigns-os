import assert from "node:assert/strict";
import test from "node:test";

import { createCheckpointWaiver } from "./checkpoint-waiver.mjs";
import {
  evaluatePageKitStoreProfile,
  isStoreProfileDiscrepancyWaivable,
  PAGE_KIT_STORE_PROFILE_FIELDS,
} from "./page-kit-store-profile.mjs";

const FIELDS = [
  "store_name",
  "store_url",
  "store_terms",
  "store_privacy",
  "store_contact",
  "store_returns",
  "store_shipping",
  "store_phone",
  "store_phone_tel",
];

function profile(prefix = "merchant") {
  return {
    store_name: "Merchant",
    store_url: `https://${prefix}.test/`,
    store_terms: `https://${prefix}.test/terms`,
    store_privacy: `https://${prefix}.test/privacy`,
    store_contact: `https://${prefix}.test/contact`,
    store_returns: `https://${prefix}.test/returns`,
    store_shipping: `https://${prefix}.test/shipping`,
    store_phone: "+1 555 010 1234",
    store_phone_tel: "tel:+15550101234",
  };
}

function evaluate(specCampaign, targetEntry, options = {}) {
  return evaluatePageKitStoreProfile({
    specCampaign,
    targetLoad: { status: "ok", public_route_slug: "merchant", target_path: "_data/campaigns.json", entry: targetEntry },
    waivers: [],
    required: true,
    ...options,
  });
}

test("store-profile evaluator always emits the fixed nine-field matrix in canonical order", () => {
  assert.deepEqual(PAGE_KIT_STORE_PROFILE_FIELDS, FIELDS);
  const gate = evaluate(profile(), profile());
  assert.equal(gate.status, "pass");
  assert.deepEqual(gate.matrix.map((row) => row.field), FIELDS);
  assert.ok(gate.matrix.every((row) => row.kind === "match"));
  assert.deepEqual(gate.blocker_fields, []);
  assert.deepEqual(gate.warning_fields, []);
});

test("store-profile evaluator classifies missing, mismatch, target-only, and both-empty fields", () => {
  const spec = profile();
  const target = profile();
  spec.store_terms = "https://merchant.test/right-terms";
  target.store_terms = "";
  target.store_privacy = "https://merchant.test/wrong-privacy";
  spec.store_contact = "";
  target.store_contact = "https://merchant.test/contact-only";
  spec.store_returns = "";
  target.store_returns = "";
  const gate = evaluate(spec, target);
  const byField = Object.fromEntries(gate.matrix.map((row) => [row.field, row.kind]));
  assert.equal(byField.store_terms, "target_missing");
  assert.equal(byField.store_privacy, "mismatch");
  assert.equal(byField.store_contact, "target_only");
  assert.equal(byField.store_returns, "both_empty");
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.blocker_fields, ["store_terms", "store_privacy"]);
  assert.deepEqual(gate.warning_fields, ["store_contact"]);
});

test("demo residue is detected in every governed URL and phone field without false suffix matches", () => {
  const spec = Object.fromEntries(FIELDS.map((field) => [field, ""]));
  const cases = [
    ...[
      "store_url",
      "store_terms",
      "store_privacy",
      "store_contact",
      "store_returns",
      "store_shipping",
    ].map((field) => ({ field, value: "https://DEMO.29NEXT.COM/path" })),
    { field: "store_phone", value: "+1 (888) 831-6810" },
    { field: "store_phone", value: "tel:+18888316810" },
    { field: "store_phone_tel", value: "+1 (888) 831-6810" },
    { field: "store_phone_tel", value: "tel:+18888316810" },
  ];
  for (const { field, value } of cases) {
    const gate = evaluate(spec, { ...spec, [field]: value });
    assert.equal(gate.status, "blocked", `${field} ${value}`);
    assert.deepEqual(
      gate.matrix.filter((row) => row.kind === "demo_residue").map((row) => row.field),
      [field],
      `${field} ${value}`,
    );
  }

  const productNameOnly = evaluate(spec, { ...spec, store_name: "Next Commerce" });
  assert.equal(productNameOnly.matrix.find((row) => row.field === "store_name").kind, "target_only");

  const negative = evaluate({ ...spec, store_url: "https://notdemo.test" }, { ...spec, store_url: "https://demo.29next.com.evil.test" });
  assert.equal(negative.matrix.find((row) => row.field === "store_url").kind, "mismatch");
});

test("normalization trims and NFC-normalizes strings without folding case, punctuation, or slashes", () => {
  const spec = profile();
  const target = profile();
  spec.store_name = "  Cafe\u0301  ";
  target.store_name = "Café";
  assert.equal(evaluate(spec, target).matrix[0].kind, "match");
  target.store_name = "CAFÉ";
  assert.equal(evaluate(spec, target).matrix[0].kind, "mismatch");
  target.store_name = "Café ";
  target.store_url = "https://merchant.test";
  assert.equal(evaluate(spec, target).matrix[1].kind, "mismatch");
});

test("non-string values block instead of being stringified", () => {
  const spec = profile();
  const target = profile();
  spec.store_name = 123;
  target.store_phone = { number: "+1 555 010 1234" };
  const gate = evaluate(spec, target);
  assert.equal(gate.status, "blocked");
  assert.equal(gate.matrix[0].kind, "spec_invalid_type");
  assert.equal(gate.matrix.find((row) => row.field === "store_phone").kind, "target_invalid_type");
  assert.equal(gate.waivable, false);
  assert.equal(gate.required_actions.some((action) => action.id === "waive_checkpoint"), false);
  assert.equal(JSON.stringify(gate).includes("[object Object]"), false);
});

test("fingerprints contain only canonical slug/path plus ordered discrepant fields and values", () => {
  const spec = profile();
  const target = { ...profile(), store_url: "https://wrong.test/" };
  const first = evaluate(spec, target);
  const same = evaluate(spec, target);
  const changed = evaluate(spec, { ...target, store_url: "https://another.test/" });
  assert.match(first.state_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.state_fingerprint, same.state_fingerprint);
  assert.notEqual(first.state_fingerprint, changed.state_fingerprint);
  assert.deepEqual(first.subject, { public_route_slug: "merchant", target_path: "_data/campaigns.json" });
  assert.deepEqual(first.state.discrepancies, [{ field: "store_url", kind: "mismatch", spec: "https://merchant.test/", target: "https://wrong.test/" }]);
});

test("an exact current waiver makes a blocker waived and visible, never clean", () => {
  const blocked = evaluate(profile(), { ...profile(), store_url: "https://wrong.test/" });
  const waiver = createCheckpointWaiver(blocked, {
    reason: "Approved I-16 exception",
    waivedBy: "Jordan Lee",
    now: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-08-21T00:00:00.000Z",
    reviewCondition: "Re-evaluate before production launch",
  });
  const rawWaiver = {
    ...waiver,
    private_token: "active-private-token",
    nested: { secret: "active-nested-secret" },
    absolute_path: "/private/tmp/active-waiver-secret",
  };
  const safeWaiver = {
    scope: blocked.scope,
    subject: blocked.subject,
    state_fingerprint: blocked.state_fingerprint,
    reason: waiver.reason,
    waived_by: waiver.waived_by,
    waived_at: waiver.waived_at,
    expires_at: waiver.expires_at,
    review_condition: waiver.review_condition,
  };
  const waived = evaluate(profile(), { ...profile(), store_url: "https://wrong.test/" }, { waivers: [rawWaiver], now: "2026-08-19T01:00:00.000Z" });
  assert.equal(waived.status, "waived");
  assert.deepEqual(waived.waiver, safeWaiver);
  assert.deepEqual(waived.waiver_assessment, {
    active: safeWaiver,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  });
  assert.equal(JSON.stringify(waived).includes("active-private-token"), false);
  assert.equal(JSON.stringify(waived).includes("active-nested-secret"), false);
  assert.equal(JSON.stringify(waived).includes("/private/tmp/active-waiver-secret"), false);
  assert.deepEqual(waived.blocker_fields, ["store_url"]);
  const corrected = evaluate(profile(), profile(), { waivers: [rawWaiver], now: "2026-08-19T01:00:00.000Z" });
  assert.equal(corrected.status, "pass");
  assert.equal(corrected.waiver, null);
  assert.deepEqual(corrected.waiver_assessment, {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  });
  const targetOnlySpec = { ...profile(), store_contact: "" };
  const targetOnly = evaluate(targetOnlySpec, profile(), { waivers: [rawWaiver], now: "2026-08-19T01:00:00.000Z" });
  assert.equal(targetOnly.status, "pass");
  assert.deepEqual(targetOnly.warning_fields, ["store_contact"]);
  assert.deepEqual(targetOnly.waiver_assessment, {
    active: null,
    inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
  });

  const specChanged = evaluate(
    { ...profile(), store_url: "https://changed-spec.test/" },
    { ...profile(), store_url: "https://wrong.test/" },
    { waivers: [rawWaiver], now: "2026-08-19T01:00:00.000Z" },
  );
  assert.equal(specChanged.status, "blocked");
  assert.equal(specChanged.waiver, null);
  assert.deepEqual(specChanged.waiver_assessment, {
    active: null,
    inert_counts: { stale: 1, foreign: 0, malformed: 0, expired: 0 },
  });
  assert.equal(JSON.stringify(specChanged).includes("active-private-token"), false);
});

test("inert waiver history publishes fixed counts without raw records", () => {
  const blocked = evaluate(profile(), { ...profile(), store_url: "https://wrong.test/" });
  const base = createCheckpointWaiver(blocked, {
    reason: "Review decision",
    waivedBy: "Jordan Lee",
    now: "2026-08-17T00:00:00.000Z",
    reviewCondition: "Review before launch",
  });
  const withSecrets = (record, label) => ({
    ...record,
    private_token: `${label}-private-token`,
    nested: { secret: `${label}-nested-secret` },
    absolute_path: `/private/tmp/${label}-waiver-secret`,
  });
  const stale = withSecrets({ ...base, state_fingerprint: `sha256:${"0".repeat(64)}` }, "stale");
  const foreign = withSecrets({ ...base, subject: { ...base.subject, public_route_slug: "foreign" } }, "foreign");
  const malformed = withSecrets({ ...base, waived_at: "not-an-iso-timestamp" }, "malformed");
  const expired = withSecrets(createCheckpointWaiver(blocked, {
    reason: "Expired decision",
    waivedBy: "Jordan Lee",
    now: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-18T00:00:00.000Z",
  }), "expired");
  const gate = evaluate(profile(), { ...profile(), store_url: "https://wrong.test/" }, {
    waivers: [stale, foreign, malformed, expired],
    now: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.waiver_assessment, {
    active: null,
    inert_counts: { stale: 1, foreign: 1, malformed: 1, expired: 1 },
  });
  const serialized = JSON.stringify(gate);
  for (const sentinel of [
    "private_token", "nested", "absolute_path",
    "stale-private-token", "foreign-nested-secret", "/private/tmp/malformed-waiver-secret",
  ]) assert.equal(serialized.includes(sentinel), false, sentinel);
});

test("missing target is pre-scaffold not_applicable but packet QA is a non-waivable blocker", () => {
  const targetLoad = { status: "file_missing", public_route_slug: "merchant", target_path: "_data/campaigns.json", entry: null };
  const beforeScaffold = evaluatePageKitStoreProfile({ specCampaign: profile(), targetLoad, required: false });
  assert.equal(beforeScaffold.status, "not_applicable");
  const packetQa = evaluatePageKitStoreProfile({ specCampaign: profile(), targetLoad, required: true });
  assert.equal(packetQa.status, "blocked");
  assert.equal(packetQa.waivable, false);
  assert.equal(packetQa.state_fingerprint, null);
});

test("packet QA cannot fetch around a missing or malformed local spec", () => {
  const targetLoad = { status: "ok", public_route_slug: "merchant", target_path: "_data/campaigns.json", entry: profile() };
  for (const specStatus of ["missing", "invalid_json", "root_not_object"]) {
    const gate = evaluatePageKitStoreProfile({ specCampaign: null, specStatus, targetLoad, required: true });
    assert.equal(gate.status, "blocked");
    assert.equal(gate.code, "page_kit.store_profile.spec_unavailable");
    assert.equal(gate.waivable, false);
    assert.equal(gate.state_fingerprint, null);
  }
});

test("waivability is decided by an enumerated kind set, not by how a kind is named", () => {
  for (const kind of ["demo_residue", "target_missing", "mismatch"]) {
    assert.equal(isStoreProfileDiscrepancyWaivable(kind), true, kind);
  }
  for (const kind of [
    "both_invalid_type",
    "spec_invalid_type",
    "target_invalid_type",
    "future_blocker_kind",
    "",
    null,
  ]) {
    assert.equal(isStoreProfileDiscrepancyWaivable(kind), false, String(kind));
  }

  // Every blocker kind, pinned to the waivability it is supposed to carry. The
  // set was previously derived from an "invalid_type" suffix, which quietly
  // decided this for any kind added later; this test is what makes a change to
  // the set deliberate.
  const waivableCases = [
    ["demo_residue", () => { const t = profile(); t.store_url = "https://demo.29next.com/"; return [profile(), t]; }],
    ["target_missing", () => { const t = profile(); t.store_returns = ""; return [profile(), t]; }],
    ["mismatch", () => { const t = profile(); t.store_name = "Other Merchant"; return [profile(), t]; }],
  ];
  for (const [kind, build] of waivableCases) {
    const [spec, target] = build();
    const gate = evaluate(spec, target);
    assert.equal(gate.status, "blocked", kind);
    assert.ok(gate.matrix.some((row) => row.kind === kind), `expected a ${kind} row`);
    assert.equal(gate.waivable, true, `${kind} must stay waivable by a named human`);
  }

  const nonWaivableCases = [
    ["spec_invalid_type", () => { const s = profile(); s.store_name = 123; return [s, profile()]; }],
    ["target_invalid_type", () => { const t = profile(); t.store_name = 123; return [profile(), t]; }],
    ["both_invalid_type", () => { const s = profile(); const t = profile(); s.store_name = 123; t.store_name = {}; return [s, t]; }],
  ];
  for (const [kind, build] of nonWaivableCases) {
    const [spec, target] = build();
    const gate = evaluate(spec, target);
    assert.equal(gate.status, "blocked", kind);
    assert.ok(gate.matrix.some((row) => row.kind === kind), `expected a ${kind} row`);
    assert.equal(gate.waivable, false, `${kind} must never be waivable`);
    assert.equal(gate.required_actions.some((action) => action.id === "waive_checkpoint"), false, kind);
  }

  // A single non-waivable row poisons an otherwise waivable set: a named human
  // cannot accept a divergence when part of the comparison is unreadable.
  const mixedSpec = profile();
  const mixedTarget = profile();
  mixedTarget.store_url = "https://demo.29next.com/";
  mixedTarget.store_name = 123;
  const mixed = evaluate(mixedSpec, mixedTarget);
  assert.equal(mixed.status, "blocked");
  assert.ok(mixed.matrix.some((row) => row.kind === "demo_residue"));
  assert.ok(mixed.matrix.some((row) => row.kind === "target_invalid_type"));
  assert.equal(mixed.waivable, false);
});
