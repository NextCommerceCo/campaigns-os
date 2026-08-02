import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNextActions } from "./cli.mjs";
import { buildQaCloseoutActions } from "./qa-node.mjs";

// #171: run-record closeout must be a REQUIRED next action at terminal
// stages and after qa run — the dogfood run ended with the session open and
// no durable Run Record, with nothing prompting otherwise.

const BASE = { packetPath: "/campaigns/demo/campaign-runtime.build.json", packet: {}, themeGate: null, polishGate: null };

test("next picker at done emits a required run-record closeout without an active session", () => {
  const actions = buildNextActions({ ...BASE, result: { stage: "done" }, ambient: null });
  const closeout = actions.find((action) => action.id === "run_record_closeout");
  assert.ok(closeout, "done stage must emit run_record_closeout when no run session is active");
  assert.equal(closeout.required, true);
  assert.match(closeout.command, /campaigns-os run-record --packet \/campaigns\/demo\/campaign-runtime\.build\.json/);
});

test("next picker at done emits a required run end with an active session", () => {
  const actions = buildNextActions({ ...BASE, result: { stage: "done" }, ambient: { session: { packet: "/campaigns/demo/campaign-runtime.build.json" } } });
  const runEnd = actions.find((action) => action.id === "run_end");
  assert.ok(runEnd, "done stage must emit run_end when a run session is active");
  assert.equal(runEnd.required, true);
});

test("qa run closeout action is required, names the packet and verdict, and survives blocked runs", () => {
  const actions = buildQaCloseoutActions({ packetPath: "/campaigns/demo/campaign-runtime.build.json", localPath: "qa-output/demo/RUN1.json" });
  assert.equal(actions.length, 1);
  const closeout = actions[0];
  assert.equal(closeout.id, "run_record_closeout");
  assert.equal(closeout.required, true);
  assert.match(closeout.command, /run-record --packet \/campaigns\/demo\/campaign-runtime\.build\.json --qa-verdict qa-output\/demo\/RUN1\.json/);
  assert.match(closeout.description, /including blocked/);
});

test("qa run closeout emits no action for packetless modes (site / parity)", () => {
  // run-record requires a Build Packet; a required-but-impossible command is
  // worse than none (Kilo review, PR #176).
  assert.deepEqual(buildQaCloseoutActions({}), []);
  assert.deepEqual(buildQaCloseoutActions({ localPath: "qa-output/demo/RUN1.json" }), []);
});

test("qa run closeout shell-quotes paths that need it", () => {
  const actions = buildQaCloseoutActions({ packetPath: "/camp aigns/demo/campaign-runtime.build.json", localPath: "qa-output/de mo/RUN1.json" });
  assert.match(actions[0].command, /--packet '\/camp aigns\/demo\/campaign-runtime\.build\.json'/);
  assert.match(actions[0].command, /--qa-verdict 'qa-output\/de mo\/RUN1\.json'/);
});
