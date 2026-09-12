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
//
// They also pin it to campaigns QA really would block. A family outside the
// certified set carries no brand contract, so the runner emits no palette
// assertion for it — warning that operator, and recommending a waiver to clear
// a block that will never happen, would be a worse failure than the silence
// this replaces.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNextActions, nextTinyPromptLines } from "./cli.mjs";
import { resolveTemplateBrandContract } from "./private-template-source.mjs";
import { contractHasPaletteResidueChecks } from "./template-brand-contract.mjs";

const ADVISORY_ID = "theme_gate.starter_palette_blocks_qa";
const PACKET = "/campaigns/demo/campaign-runtime.build.json";

// A certified family: the catalog carries contracts/template-brand-contract.olympus.v0.json,
// which lists forbidden computed colors AND the commerce selectors to inspect
// them on — so this is a campaign browser QA really would block.
const CERTIFIED_FAMILY = "olympus";
const packetFor = (family) => ({ assembly: { template_family: family } });

const BASE = { packetPath: PACKET, packet: packetFor(CERTIFIED_FAMILY), polishGate: null, polishCheckpointGate: null, prepareBuildGate: null, ambient: null };

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

function actionsFor(themeGate, stage, packet = BASE.packet) {
  return buildNextActions({ ...BASE, packet, themeGate, result: { stage, divergences: [] } });
}

function advisoryFor(themeGate, stage, packet = BASE.packet) {
  return actionsFor(themeGate, stage, packet).find((action) => action.id === ADVISORY_ID);
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

// The warning must be true, not merely well-intentioned. QA only emits
// `template-residue:*:style:*` rows for a family whose brand contract carries
// both forbidden computed colors and commerce selectors to inspect them on.
// A family outside the certified set resolves to no contract at all, so there
// is no starter palette to block on — and a waiver or a brand-layer rewrite
// recommended to clear a block that will never happen is worse than silence.

test("a family with palette-residue checks gets the warning", () => {
  // Guard the guard: this is the same fixture the cases above rely on, asserted
  // against the real contract rather than assumed.
  assert.equal(contractHasPaletteResidueChecks(resolveTemplateBrandContract(CERTIFIED_FAMILY)), true);
  assert.ok(advisoryFor(NOTHING_GENERATABLE, "qa", packetFor(CERTIFIED_FAMILY)));
});

test("a custom family gets no warning — QA emits no palette-residue rows for it", () => {
  assert.equal(resolveTemplateBrandContract("custom"), null, "custom must resolve to no brand contract");
  for (const stage of ["build", "polish", "deploy", "qa"]) {
    assert.equal(
      advisoryFor(NOTHING_GENERATABLE, stage, packetFor("custom")),
      undefined,
      `a custom-family campaign must not be warned at ${stage} about a block QA will never raise`,
    );
  }
});

test("an undecided or absent family gets no warning either", () => {
  for (const packet of [packetFor("undecided"), packetFor(""), {}, { assembly: {} }]) {
    assert.equal(advisoryFor(NOTHING_GENERATABLE, "qa", packet), undefined);
  }
});

test("the advisory and the browser runner share one palette-residue predicate", () => {
  // Not "does a contract exist": a contract with colors but no selectors, or
  // selectors but no colors, produces no palette assertion in the runner, so it
  // must produce no warning here.
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [] } }), false);
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["checkout"] }] } }), false);
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["checkout"] }] } }), true);
  // A page type residue inspection never runs against is not a reason to warn.
  assert.equal(contractHasPaletteResidueChecks({ qa_inspection: { forbidden_computed_colors: [{ token: "--brand", rgb: "rgb(10, 38, 92)" }], computed_style_checks: [{ id: "cta", selector: ".b", page_types: ["landing"] }] } }), false);
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
