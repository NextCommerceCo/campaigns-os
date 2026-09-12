import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assessPurchaseProofCoverage, buildNextActions, orderRunRecordFileNames, readRunRecordsForTarget } from "./cli.mjs";
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

// Remit is POST-only and the receiver holds one record per run_id, refusing a
// second POST for an id it already has. A closeout run while the session still
// holds that id would spend it on the interim record, and the session's own
// close — the record carrying every attempt — would be refused.
test("a blocked attempt keeps the session open, so the printed closeout leaves the remit to it", () => {
  const [closeout] = buildQaCloseoutActions({
    packetPath: "/campaigns/demo/campaign-runtime.build.json",
    localPath: "qa-output/demo/RUN1.json",
    runSessionActive: true,
    disposition: "blocked",
  });
  assert.match(closeout.command, /--no-remit/);
  // The flag has to reach the command, not only the prose beside it.
  assert.match(closeout.command, /--qa-verdict qa-output\/demo\/RUN1\.json --no-remit --json$/);
  assert.match(closeout.description, /--no-remit/);
});

// A terminal verdict auto-ends the session in the same process, BEFORE the
// operator can run this command: the record is assembled, the session cleared,
// and the id spent. The command then mints its own run_id, so there is nothing
// to collide with — and a local-only record here would be actively harmful,
// since a newer closed record buries a failed auto-end remit that still needs
// recovering.
for (const disposition of ["ready", "ready_with_exceptions"]) {
  test(`a ${disposition} attempt auto-ends the session, so the printed closeout still remits`, () => {
    const [closeout] = buildQaCloseoutActions({
      packetPath: "/campaigns/demo/campaign-runtime.build.json",
      localPath: "qa-output/demo/RUN1.json",
      runSessionActive: true,
      disposition,
    });
    assert.doesNotMatch(closeout.command, /--no-remit/);
  });
}

test("with no run session the printed closeout owns its run id and remits", () => {
  for (const disposition of ["blocked", "ready", null]) {
    const [closeout] = buildQaCloseoutActions({
      packetPath: "/campaigns/demo/campaign-runtime.build.json",
      localPath: "qa-output/demo/RUN1.json",
      disposition,
    });
    assert.doesNotMatch(closeout.command, /--no-remit/);
  }
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

test("next picker done closeout shell-quotes a packet path that needs it", () => {
  const actions = buildNextActions({ ...BASE, packetPath: "/camp aigns/demo/campaign-runtime.build.json", result: { stage: "done" }, ambient: null });
  const closeout = actions.find((action) => action.id === "run_record_closeout");
  assert.match(closeout.command, /--packet '\/camp aigns\/demo\/campaign-runtime\.build\.json'/);
});

test("explicit post-polish next stages emit one resolved owned-checkpoint action", () => {
  const capture = {
    id: "polish.hidden_eager_media.capture",
    kind: "command",
    command: "campaigns-os polish capture --packet <packet> --base-url <url>",
    description: "Capture current page-load evidence.",
  };
  const input = {
    packetPath: "/campaigns/demo/campaign-runtime.build.json",
    packet: { deploy: { preview_url: "https://preview.example/demo/" } },
    themeGate: { status: "pass" },
    polishGate: {
      status: "blocked",
      owned_checkpoint_id: "polish.hidden_eager_media",
      required_actions: [capture],
    },
    polishCheckpointGate: {
      status: "blocked",
      id: "polish.hidden_eager_media",
      required_actions: [capture],
    },
    ambient: null,
  };

  for (const stage of ["deploy", "qa"]) {
    const actions = buildNextActions({ ...input, result: { stage, divergences: [] } });
    const captureActions = actions.filter((action) => action.command?.startsWith("campaigns-os polish capture"));
    assert.equal(captureActions.length, 1, `${stage} must not duplicate an owned checkpoint action`);
    assert.equal(captureActions[0].id, "checkpoint.polish.hidden_eager_media.capture");
    assert.equal(
      captureActions[0].command,
      "campaigns-os polish capture --packet /campaigns/demo/campaign-runtime.build.json --base-url https://preview.example/demo/",
    );
  }
});

// A matching, current, closed Run Record already IS the closeout. Demanding a
// second one is the failure the 2026-09-11 shadow-campaign validation run
// recorded: `next` returned stage "done" and still emitted a required
// run_record_closeout after QA had assembled, closed and remitted the record.
// Suppression is narrow on purpose — see src/run-record-closeout.mjs.

const satisfied = { satisfied: true, reason_code: "satisfied", record_id: "run_1_abcd", record_path: "/t/.campaign-runtime/run-records/run_1_abcd.json", detail: "closed and remitted" };

function doneActions(closeout, extra = {}) {
  return buildNextActions({ ...BASE, result: { stage: "done" }, ambient: null, runRecordCloseout: closeout, ...extra });
}

test("a satisfied closeout replaces the required demand with a non-required record pointer", () => {
  const actions = doneActions(satisfied);
  assert.equal(actions.find((action) => action.id === "run_record_closeout"), undefined);
  const pointer = actions.find((action) => action.id === "run_record_present");
  assert.ok(pointer, "next must still say where the durable record is");
  assert.notEqual(pointer.required, true);
  assert.match(pointer.description, /run_1_abcd/);
});

for (const reason of ["no_record", "foreign_campaign", "stale_predates_evidence", "outdated_artifacts"]) {
  test(`closeout stays required for ${reason}`, () => {
    const actions = doneActions({ satisfied: false, reason_code: reason, record_id: null, record_path: null, detail: `detail for ${reason}` });
    const closeout = actions.find((action) => action.id === "run_record_closeout");
    assert.ok(closeout, `${reason} must still demand a Run Record`);
    assert.equal(closeout.required, true);
    assert.match(closeout.description, new RegExp(reason));
  });
}

test("an unassessed closeout keeps the unconditional required demand", () => {
  const closeout = doneActions(null).find((action) => action.id === "run_record_closeout");
  assert.ok(closeout);
  assert.equal(closeout.required, true);
});

test("a failed remit recovers the existing record instead of minting a second one", () => {
  const actions = doneActions({ satisfied: false, reason_code: "remit_failed", record_id: "run_1_abcd", record_path: "/t/run_1_abcd.json", detail: "remit failed" });
  assert.equal(actions.find((action) => action.id === "run_record_closeout"), undefined);
  const recovery = actions.find((action) => action.id === "run_record_remit_recovery");
  assert.ok(recovery);
  assert.equal(recovery.required, true);
  assert.match(recovery.command, /run-record --packet \/campaigns\/demo\/campaign-runtime\.build\.json --run-id run_1_abcd/);
});

test("a pending remit also recovers the existing record", () => {
  const actions = doneActions({ satisfied: false, reason_code: "remit_incomplete", record_id: "run_1_abcd", record_path: "/t/run_1_abcd.json", detail: "remit pending" });
  assert.ok(actions.find((action) => action.id === "run_record_remit_recovery"));
});

test("an ambient run session still wins at done, satisfied or not", () => {
  const actions = buildNextActions({ ...BASE, result: { stage: "done" }, ambient: { session: { packet: BASE.packetPath } }, runRecordCloseout: satisfied });
  const runEnd = actions.find((action) => action.id === "run_end");
  assert.ok(runEnd);
  assert.equal(runEnd.required, true);
  assert.equal(actions.find((action) => action.id === "run_record_closeout"), undefined);
});

// `--test-order off` is a legitimate diagnostic. It is not purchase proof, and
// a report whose QA stage records zero executed order paths must not be
// presented as satisfying a declared common/full depth.

test("done advises when purchase-proof coverage cannot be determined", () => {
  const actions = doneActions(satisfied, { purchaseProof: { state: "unknown", declared_depth: "common", reason: "This report predates purchase-proof coverage." } });
  const advisory = actions.find((action) => action.id === "purchase_proof_unknown");
  assert.ok(advisory, "an absent summary is unknown, and unknown is advisory");
  assert.notEqual(advisory.required, true);
});

test("done emits no purchase-proof advisory when coverage is satisfied or not required", () => {
  for (const state of ["satisfied", "not_required"]) {
    const actions = doneActions(satisfied, { purchaseProof: { state, declared_depth: state === "satisfied" ? "common" : "off" } });
    assert.equal(actions.find((action) => action.id === "purchase_proof_unknown"), undefined);
  }
});

// Kilo review, PR #315: the records scan read only the newest 50 file names, so
// an older matching record read as `no_record` / `foreign_campaign` and the
// operator was asked to re-make a record that already existed.
function seedRecords(count, { matchingIndex }) {
  const base = mkdtempSync(join(tmpdir(), "campaigns-os-records-"));
  const dir = join(base, ".campaign-runtime", "run-records");
  mkdirSync(dir, { recursive: true });
  const start = 1_757_000_000_000;
  for (let index = 0; index < count; index += 1) {
    // index 0 is the OLDEST, so the matching record sits far outside any
    // newest-N window.
    const runId = `run_${start + index * 1000}_${String(index).padStart(8, "0")}`;
    const identity = index === matchingIndex
      ? { map_id: "demo-map-01", campaign_slug: "demo-route" }
      : { map_id: "other-map-99", campaign_slug: "other-route" };
    writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ run_id: runId, created_at: new Date(start + index * 1000).toISOString(), identity }));
  }
  return base;
}

test("the records scan reaches a matching record far older than the newest 50", () => {
  const base = seedRecords(60, { matchingIndex: 0 });
  const entries = readRunRecordsForTarget(base);
  assert.equal(entries.length, 60);
  const matching = entries.filter((entry) => entry.record?.identity?.map_id === "demo-map-01");
  assert.equal(matching.length, 1, "the oldest matching record must survive the scan bound");
});

test("the records scan returns newest first and tolerates a malformed file beside good ones", () => {
  const base = seedRecords(3, { matchingIndex: 0 });
  writeFileSync(join(base, ".campaign-runtime", "run-records", "run_9999999999999_bad.json"), "{ not json");
  const entries = readRunRecordsForTarget(base);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].record, null, "the newest name is the malformed one, and it reads as null rather than throwing");
  assert.ok(entries.slice(1).every((entry) => entry.record));
  const stamps = entries.slice(1).map((entry) => Number(/^run_(\d+)_/.exec(entry.record.run_id)[1]));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a));
});

// Kilo review, PR #315: lexicographic ordering only matched numeric ordering
// while every run id carried the same digit count.
test("run id ordering survives a change of timestamp digit length", () => {
  const names = [
    "run_999999999999_aaaaaaaa.json",
    "run_1757000000000_bbbbbbbb.json",
    "run_10000000000000_cccccccc.json",
  ];
  assert.deepEqual(orderRunRecordFileNames(names), [
    "run_10000000000000_cccccccc.json",
    "run_1757000000000_bbbbbbbb.json",
    "run_999999999999_aaaaaaaa.json",
  ]);
  // A lexicographic reverse sort would have put the 12-digit id first.
  assert.notDeepEqual(orderRunRecordFileNames(names), [...names].sort().reverse());
});

test("an unparseable record name sorts last rather than displacing a timestamped one", () => {
  assert.deepEqual(
    orderRunRecordFileNames(["notes.json", "run_1757000000000_bbbbbbbb.json", "run_1757000001000_cccccccc.json"]),
    ["run_1757000001000_cccccccc.json", "run_1757000000000_bbbbbbbb.json", "notes.json"],
  );
});

// Kilo review, PR #315: the packet won over the report without the two ever
// being compared, so a corrupted mirror could quietly decide the gate.
test("a packet/report order-path depth disagreement reads as unknown, not as the packet's value", () => {
  const result = assessPurchaseProofCoverage({
    packet: { qa: { proof_policy: { order_path_depth: "common" } } },
    report: { proof_policy: { order_path_depth: "off" }, stages: { qa: { purchase_proof: { order_paths_executed: 2 } } } },
  });
  assert.equal(result.state, "unknown");
  // No single declared depth exists when the two sides disagree; both are
  // exposed structurally, not only inside the prose reason.
  assert.equal(result.declared_depth, null);
  assert.deepEqual(result.declared_depths, { packet: "common", report: "off" });
  assert.match(result.reason, /"common".*"off"/);
});

test("the purchase_proof_unknown action names both sides of a depth disagreement from the structured field", () => {
  const purchaseProof = assessPurchaseProofCoverage({
    packet: { qa: { proof_policy: { order_path_depth: "common" } } },
    report: { proof_policy: { order_path_depth: "off" } },
  });
  const actions = doneActions(satisfied, { purchaseProof });
  const advisory = actions.find((action) => action.id === "purchase_proof_unknown");
  assert.ok(advisory);
  assert.match(advisory.description, /packet declares an order path depth of "common"/);
  assert.match(advisory.description, /report mirrors "off"/);
  assert.doesNotMatch(advisory.description, /"unspecified"/);
});

test("every coverage shape carries declared_depths beside declared_depth", () => {
  const shapes = [
    assessPurchaseProofCoverage({ packet: { qa: { proof_policy: { order_path_depth: "off" } } } }),
    assessPurchaseProofCoverage({ packet: { qa: { proof_policy: { order_path_depth: "common" } } }, report: {} }),
    assessPurchaseProofCoverage({ packet: { qa: { proof_policy: { order_path_depth: "common" } } }, report: { stages: { qa: { purchase_proof: { order_paths_executed: 1 } } } } }),
    assessPurchaseProofCoverage({ packet: { qa: { proof_policy: { order_path_depth: "common" } } }, report: { stages: { qa: { purchase_proof: { order_paths_executed: 0 } } } } }),
  ];
  for (const shape of shapes) {
    assert.deepEqual(Object.keys(shape.declared_depths).sort(), ["packet", "report"]);
    assert.equal(shape.declared_depths.packet, shape.declared_depth);
  }
});

test("a disagreement is unknown in the other direction too, and never not_required", () => {
  const result = assessPurchaseProofCoverage({
    packet: { qa: { proof_policy: { order_path_depth: "off" } } },
    report: { proof_policy: { order_path_depth: "common" } },
  });
  assert.equal(result.state, "unknown");
});

test("matching depths on both sides still assess normally", () => {
  const satisfied = assessPurchaseProofCoverage({
    packet: { qa: { proof_policy: { order_path_depth: "common" } } },
    report: { proof_policy: { order_path_depth: "COMMON" }, stages: { qa: { purchase_proof: { order_paths_executed: 1 } } } },
  });
  assert.equal(satisfied.state, "satisfied");
});
