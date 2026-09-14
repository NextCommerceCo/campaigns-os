import test from "node:test";
import assert from "node:assert/strict";

import { doctorErrorsAreOnlyPolishGate, gateIssue } from "./cli.mjs";

// One projection of a gate into an issue, for doctor (the gate's own code) and
// for `next` (next.<stage>.<code>). The codes and messages below are the ones
// the two commands have always emitted; the projection now lives in one place.
const themeGate = {
  status: "blocked",
  code: "theme_gate.starter_palette",
  reason: "The starter palette is still applied.",
  required_actions: [
    { id: "generate", kind: "command", command: "campaigns-os theme generate --packet p.json", description: "Generate." },
    { id: "manual", kind: "manual", command: null, description: "Apply by hand." },
  ],
};
const polishGate = { status: "blocked", code: "polish.evidence_missing", reason: "Polish evidence missing for current build. Run next-campaigns-polish before QA.", required_actions: [] };
const polishGateWithActions = { ...polishGate, code: "polish.assembly_source_package_stale", reason: "The Design Source Package changed after Build.", required_actions: [{ id: "build", kind: "command", command: "campaigns-os next build --packet p.json" }] };
const checkpointGate = { status: "blocked", code: "polish.hidden_eager_media.capture_malformed", reason: "Package-owned page-load evidence is missing or malformed.", required_actions: [{ id: "capture", kind: "command", command: "campaigns-os polish capture --packet p.json --base-url <url>" }] };

test("gateIssue: the theme gate is a doctor warning under its own code and a next error under next.<stage>.theme_gate", () => {
  assert.deepEqual(gateIssue("theme_gate", themeGate), {
    severity: "warning",
    code: "theme_gate.starter_palette",
    message: "The starter palette is still applied. Polish/deploy/QA are gated until resolved. Run: campaigns-os theme generate --packet p.json",
    detail: null,
  });
  assert.deepEqual(gateIssue("theme_gate", themeGate, { stage: "polish" }), {
    severity: "error",
    code: "next.polish.theme_gate",
    message: "The starter palette is still applied. Run: campaigns-os theme generate --packet p.json",
    detail: { theme_gate: themeGate },
  });
});

test("gateIssue: the polish gate is an error under its code for doctor and next.<stage>.<code> for next, naming the required action or the polish fallback", () => {
  assert.deepEqual(gateIssue("polish_gate", polishGate), {
    severity: "error",
    code: "polish.evidence_missing",
    message: "Polish evidence missing for current build. Run next-campaigns-polish before QA. Run next-campaigns-polish before QA.",
    detail: { polish_gate: polishGate },
  });
  assert.equal(gateIssue("polish_gate", polishGate, { stage: "qa" }).code, "next.qa.polish.evidence_missing");
  assert.equal(gateIssue("polish_gate", polishGateWithActions, { stage: "deploy" }).message, "The Design Source Package changed after Build. Required action: campaigns-os next build --packet p.json.");
});

test("gateIssue: the polish checkpoint carries its commands for doctor and its reason alone for next", () => {
  assert.equal(gateIssue("polish_checkpoint_gate", checkpointGate).message, "Package-owned page-load evidence is missing or malformed. Required action: campaigns-os polish capture --packet p.json --base-url <url>.");
  assert.deepEqual(gateIssue("polish_checkpoint_gate", checkpointGate, { stage: "qa" }), {
    severity: "error",
    code: "next.qa.polish.hidden_eager_media.capture_malformed",
    message: "Package-owned page-load evidence is missing or malformed.",
    detail: { polish_checkpoint_gate: checkpointGate },
  });
  assert.throws(() => gateIssue("other", checkpointGate), /Unknown gate kind/);
});

// "Doctor's only errors are the polish gates" used to be decoded from the
// code prefix: any error spelled polish.* counted, and a polish-gate error
// under another code would not. It now reads the gate the issue carries.
test("doctorErrorsAreOnlyPolishGate reads the gate on the issue, not the code prefix", () => {
  const polish = gateIssue("polish_gate", polishGate);
  const checkpoint = gateIssue("polish_checkpoint_gate", checkpointGate);
  const asIssue = ({ code, message, detail }) => (detail ? { code, message, detail } : { code, message });
  assert.equal(doctorErrorsAreOnlyPolishGate([asIssue(polish), asIssue(checkpoint)]), true);
  assert.equal(doctorErrorsAreOnlyPolishGate([asIssue(polish), { code: "spec.page_url_html_extension", message: "x" }]), false);
  assert.equal(doctorErrorsAreOnlyPolishGate([{ code: "polish.something_else", message: "spelled like a gate, not from one" }]), false);
  assert.equal(doctorErrorsAreOnlyPolishGate([]), false);
  assert.equal(doctorErrorsAreOnlyPolishGate(), false);
});
