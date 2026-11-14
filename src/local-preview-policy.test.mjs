import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPageOnlyChangeToCheckpoint, applyPageOnlyChangeToPolishGate, carried, carriedForwardMessage } from "./local-preview-policy.mjs";

test("page-only checkpoint carry keeps the original blocked status", () => {
  const debt = { polish: { advisory: true } };
  const checkpointGate = applyPageOnlyChangeToCheckpoint({ status: "blocked", code: "polish.hidden_eager_media.capture_stale" }, debt);
  const gate = carried({ status: "blocked", owned_checkpoint_only: true, reason: "The page-load capture belongs to the previous build." });
  const advisory = applyPageOnlyChangeToPolishGate(gate, { debt, checkpointGate });
  assert.equal(advisory.carried_forward.from_status, "blocked");

});

test("page-only advisory message retains the gate reason", () => {
  const reason = "The reviewed output fingerprint differs from the current build.";
  const gate = applyPageOnlyChangeToPolishGate({ status: "blocked", code: "polish.output_drift", reason }, { debt: { polish: { advisory: true } } });
  assert.ok(carriedForwardMessage(gate).includes(reason));
});
