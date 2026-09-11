import assert from "node:assert/strict";
import { test } from "node:test";

import { assessRunRecordCloseout, latestProducerTimestamp, reasonIsRemitRecovery } from "./run-record-closeout.mjs";

const PACKET = {
  spec: { map_id: "demo-map-01" },
  campaign: { public_route_slug: "demo-route" },
};

const VERDICT_SHA = "a".repeat(64);

function report({ qaCheckedAt = "2026-03-02T00:00:00.000Z", doctorCheckedAt = "2026-03-01T00:00:00.000Z" } = {}) {
  return {
    stages: {
      doctor: { stage: "doctor", status: "completed", checked_at: doctorCheckedAt },
      qa: { stage: "qa", status: "completed", checked_at: qaCheckedAt, outputs: [".campaign-runtime/qa-verdict.json"] },
    },
  };
}

function record(overrides = {}) {
  return {
    run_id: "run_1_aaaaaaaa",
    created_at: "2026-03-02T01:00:00.000Z",
    remit_state: "ok",
    identity: { map_id: "demo-map-01", campaign_slug: "demo-route" },
    artifacts: [{ kind: "qa_verdict", path: ".campaign-runtime/qa-verdict.json", sha256: VERDICT_SHA }],
    ...overrides,
  };
}

function assess(records, extra = {}) {
  return assessRunRecordCloseout({
    records,
    packet: PACKET,
    report: report(),
    currentQaVerdictDigests: [VERDICT_SHA],
    qaVerdictRecorded: true,
    ...extra,
  });
}

test("a matching, current, remitted record satisfies closeout", () => {
  const result = assess([{ path: "/t/run_1_aaaaaaaa.json", record: record() }]);
  assert.equal(result.satisfied, true);
  assert.equal(result.reason_code, "satisfied");
  assert.equal(result.record_id, "run_1_aaaaaaaa");
  assert.equal(result.record_path, "/t/run_1_aaaaaaaa.json");
});

test("an absent records directory is no_record, never an error", () => {
  const result = assess([]);
  assert.equal(result.satisfied, false);
  assert.equal(result.reason_code, "no_record");
  assert.equal(result.record_id, null);
});

test("records for another campaign never satisfy this packet's closeout", () => {
  const foreign = record({ identity: { map_id: "other-map", campaign_slug: "other-route" } });
  const result = assess([{ path: "/t/other.json", record: foreign }]);
  assert.equal(result.reason_code, "foreign_campaign");
});

test("a record matching only the slug is still foreign", () => {
  const halfMatch = record({ identity: { map_id: "other-map", campaign_slug: "demo-route" } });
  assert.equal(assess([{ path: "/t/h.json", record: halfMatch }]).reason_code, "foreign_campaign");
});

test("a record with no identity cannot satisfy closeout", () => {
  assert.equal(assess([{ path: "/t/n.json", record: record({ identity: {} }) }]).reason_code, "foreign_campaign");
});

test("a record older than the report's producer evidence is stale", () => {
  const old = record({ created_at: "2026-03-01T12:00:00.000Z" });
  const result = assess([{ path: "/t/old.json", record: old }]);
  assert.equal(result.reason_code, "stale_predates_evidence");
  assert.equal(result.record_id, "run_1_aaaaaaaa");
});

test("a record with an unparseable created_at cannot prove it is current", () => {
  const result = assess([{ path: "/t/x.json", record: record({ created_at: "not-a-time" }) }]);
  assert.equal(result.reason_code, "stale_predates_evidence");
});

test("a record referencing a different QA verdict is materially outdated", () => {
  const drifted = record({ artifacts: [{ kind: "qa_verdict", path: "x.json", sha256: "b".repeat(64) }] });
  assert.equal(assess([{ path: "/t/d.json", record: drifted }]).reason_code, "outdated_artifacts");
});

test("a record with no qa_verdict reference is outdated when the report records one", () => {
  const bare = record({ artifacts: [{ kind: "build_packet", path: "p.json", sha256: "c".repeat(64) }] });
  assert.equal(assess([{ path: "/t/b.json", record: bare }]).reason_code, "outdated_artifacts");
});

test("an uncomputable current verdict digest fails open to outdated_artifacts", () => {
  assert.equal(assess([{ path: "/t/u.json", record: record() }], { currentQaVerdictDigests: [] }).reason_code, "outdated_artifacts");
});

test("a record that references several QA attempts matches on the current one", () => {
  const multi = record({
    artifacts: [
      { kind: "qa_verdict", path: "attempt-1.json", sha256: "d".repeat(64) },
      { kind: "qa_verdict", path: "attempt-2.json", sha256: VERDICT_SHA },
    ],
  });
  assert.equal(assess([{ path: "/t/m.json", record: multi }]).satisfied, true);
});

test("an old-format report with no recorded verdict skips the verdict check", () => {
  const legacy = {
    stages: {
      doctor: { stage: "doctor", status: "completed" },
      qa: { stage: "qa", status: "completed_with_warnings", completed_at: "2026-03-02T00:00:00.000Z" },
    },
  };
  const result = assessRunRecordCloseout({
    records: [{ path: "/t/l.json", record: record({ artifacts: [] }) }],
    packet: PACKET,
    report: legacy,
    currentQaVerdictDigests: [],
    qaVerdictRecorded: false,
  });
  assert.equal(result.satisfied, true);
});

test("a failed remit is its own reason, distinct from a missing record", () => {
  const result = assess([{ path: "/t/f.json", record: record({ remit_state: "failed" }) }]);
  assert.equal(result.reason_code, "remit_failed");
  assert.equal(reasonIsRemitRecovery(result.reason_code), true);
  assert.equal(result.record_id, "run_1_aaaaaaaa");
});

test("a pending or unrecognized remit is incomplete, not success", () => {
  assert.equal(assess([{ path: "/t/p.json", record: record({ remit_state: "pending" }) }]).reason_code, "remit_incomplete");
  assert.equal(assess([{ path: "/t/q.json", record: record({ remit_state: "teleported" }) }]).reason_code, "remit_incomplete");
  assert.equal(assess([{ path: "/t/r.json", record: record({ remit_state: undefined }) }]).reason_code, "remit_incomplete");
});

test("a skipped remit under consent-off is a closed, local-only record", () => {
  const result = assess([{ path: "/t/s.json", record: record({ remit_state: "skipped" }) }]);
  assert.equal(result.satisfied, true);
  assert.match(result.detail, /consent off/);
});

test("the newest matching record decides, and an older good one cannot mask it", () => {
  const older = { path: "/t/old.json", record: record({ run_id: "run_old", created_at: "2026-03-02T01:00:00.000Z" }) };
  const newer = { path: "/t/new.json", record: record({ run_id: "run_new", created_at: "2026-03-02T05:00:00.000Z", remit_state: "failed" }) };
  const result = assess([older, newer]);
  assert.equal(result.reason_code, "remit_failed");
  assert.equal(result.record_id, "run_new");
});

test("a malformed record file is ignored, not fatal", () => {
  const result = assess([{ path: "/t/broken.json", record: null }, { path: "/t/good.json", record: record() }]);
  assert.equal(result.satisfied, true);
  assert.equal(assess([{ path: "/t/broken.json", record: null }]).reason_code, "no_record");
});

test("latestProducerTimestamp invents nothing for stages without timestamps", () => {
  assert.equal(latestProducerTimestamp({ stages: { qa: { status: "blocked" } } }), null);
  assert.equal(latestProducerTimestamp({}), null);
  assert.equal(
    latestProducerTimestamp({ stages: { doctor: { checked_at: "2026-03-01T00:00:00.000Z" }, qa: { checked_at: "2026-03-03T00:00:00.000Z" } } }),
    Date.parse("2026-03-03T00:00:00.000Z"),
  );
});
