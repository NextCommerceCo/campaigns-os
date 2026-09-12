// A campaign with no brand tokens passes the theme gate and then blocks QA.
//
// `evaluateThemeGate` returns pass/`theme_gate.nothing_generatable` (nothing to
// generate, so nothing to gate), while `residueSeverityForThemeGate("pass")`
// runs the template-residue checks at blocker severity — so the starter
// family's own palette on the commerce calls to action lands as
// `template-residue:<page>:style:*` blockers at `qa run`. Both halves are
// deliberate; what was missing is that nothing in between said so, and the
// decision got made after a failed QA run instead of before one.
//
// These cases pin the warning to the gate OUTCOME, not to a new field: the
// advisory exists exactly when the gate's code is `nothing_generatable`, and is
// absent when a waiver was recorded or a brand layer was applied.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNextActions, nextTinyPromptLines } from "./cli.mjs";

const ADVISORY_ID = "theme_gate.starter_palette_blocks_qa";
const PACKET = "/campaigns/demo/campaign-runtime.build.json";

const BASE = { packetPath: PACKET, packet: {}, polishGate: null, polishCheckpointGate: null, prepareBuildGate: null, ambient: null };

// The gate results below are the real shapes `evaluateThemeGate` returns for
// each case (see src/theme-gate.mjs).
const NOTHING_GENERATABLE = {
  status: "pass",
  code: "theme_gate.nothing_generatable",
  reason: "No generatable brand theme was found; the gate passes without a brand layer.",
  waiver: null,
  required_actions: [],
};
const WAIVED = {
  status: "waived",
  code: "theme_gate.waived",
  reason: "Theme gate waived: starter palette is acceptable for this campaign.",
  waiver: { reason: "starter palette is acceptable for this campaign", waived_by: "operator", waived_at: "2026-09-12T00:00:00.000Z" },
  required_actions: [],
};
const APPLIED = {
  status: "pass",
  code: "theme_gate.applied",
  reason: "Brand theme is applied after next-core.css on commerce pages.",
  waiver: null,
  required_actions: [],
};

function actionsFor(themeGate, stage) {
  return buildNextActions({ ...BASE, themeGate, result: { stage, divergences: [] } });
}

function advisoryFor(themeGate, stage) {
  return actionsFor(themeGate, stage).find((action) => action.id === ADVISORY_ID);
}

for (const stage of ["build", "polish", "deploy", "qa"]) {
  test(`next warns at ${stage} that a token-less build will block QA on the starter palette`, () => {
    const advisory = advisoryFor(NOTHING_GENERATABLE, stage);
    assert.ok(advisory, `stage ${stage} must carry the starter-palette warning before QA runs`);
    assert.match(advisory.description, /theme_gate\.nothing_generatable/);
    assert.match(advisory.description, /template-residue/);
    // The waive lane must be named as an exact command, not as prose.
    assert.match(advisory.description, /campaigns-os theme waive --packet \/campaigns\/demo\/campaign-runtime\.build\.json --reason/);
    // …and so must the alternative the docs already describe.
    assert.match(advisory.description, /brand-theme\.css/);
    assert.match(advisory.description, /after next-core\.css/);
    // Advisory, not a demand: QA keeps blocking and nothing auto-waives. A
    // `required` flag here would read as an instruction to waive.
    assert.notEqual(advisory.required, true);
    assert.equal(advisory.command, null);
    assert.equal(advisory.kind, "manual");
  });
}

test("the warning is read before the QA command it is about", () => {
  const actions = actionsFor(NOTHING_GENERATABLE, "qa");
  const warningAt = actions.findIndex((action) => action.id === ADVISORY_ID);
  const qaRunAt = actions.findIndex((action) => action.id === "qa_run");
  assert.ok(warningAt >= 0 && qaRunAt >= 0);
  assert.ok(warningAt < qaRunAt, "the starter-palette warning must precede qa_run in the action list");
});

test("a recorded waiver removes the warning — the decision is already made", () => {
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(advisoryFor(WAIVED, stage), undefined, `waived gate must not warn at ${stage}`);
  }
});

test("an applied brand layer removes the warning — there is no starter palette left to block on", () => {
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(advisoryFor(APPLIED, stage), undefined, `applied brand layer must not warn at ${stage}`);
  }
});

test("stages with no QA ahead of them do not carry the warning", () => {
  for (const stage of ["setup", "done"]) {
    assert.equal(advisoryFor(NOTHING_GENERATABLE, stage), undefined, `stage ${stage} must not warn`);
  }
});

test("the human prompt carries the warning, not only the JSON action list", () => {
  const next_actions = actionsFor(NOTHING_GENERATABLE, "qa");
  const lines = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: "pass" }], next_actions });
  const text = lines.join("\n");
  assert.match(text, /browser QA will BLOCK on the starter palette/);
  assert.match(text, /campaigns-os theme waive --packet/);
  // The stage's own prompt still prints: the warning is additive, not a
  // takeover of the tiny prompt.
  assert.match(text, /Next expected proof: browser QA \+ typed-card proof/);
});

test("the human prompt stays silent when the gate is waived or applied", () => {
  for (const gate of [WAIVED, APPLIED]) {
    const next_actions = actionsFor(gate, "qa");
    const text = nextTinyPromptLines({ stage: "qa", gates: [{ id: "theme_gate", status: gate.status }], next_actions }).join("\n");
    assert.doesNotMatch(text, /starter palette/);
  }
});

test("a blocked theme gate still owns the human prompt alone", () => {
  const text = nextTinyPromptLines({
    stage: "qa",
    gates: [{ id: "theme_gate", status: "blocked" }],
    next_actions: [{ id: "theme_gate.waive_theme", command: "campaigns-os theme waive --packet p --reason \"x\"" }],
  }).join("\n");
  assert.match(text, /Theme gate is BLOCKING this stage/);
  assert.doesNotMatch(text, /Next expected proof/);
});
