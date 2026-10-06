// Regression tests for two defects. First, a load failure other than
// ERR_MODULE_NOT_FOUND for the exact specifier was read as a missing module.
// Second, `next` added a warnings[] entry for an open QC result. Every setup
// is synthetic and uses the shared QC test factory unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, afterEach } from "node:test";

import {
  BUILD_FP,
  QA_RUN_ID,
  assertNoNetworkAttempts,
  campaignFixture,
  fullVerdict,
  handoffOf,
  installQaStage,
  polishStandIn,
  qaAssertionFor,
  qaObservation,
  qaRederive,
  qaRowFor,
  qaStandIns,
  runNext,
  twoCellFixture,
} from "./qc-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const E = "evidence_not_reproducible";
const NOT_CAPTURED = "not_captured_by_this_version";

// ---------------------------------------------------------------------------
// Only ERR_MODULE_NOT_FOUND for the registered specifier itself reads
// not_captured_by_this_version. A throw at load, a syntax error or a missing
// transitive import is a failed load, which every reader turns into
// evidence_not_reproducible, never not_captured and never pass.

test("registry load classification: only the exact missing specifier reads not_captured_by_this_version; a throw, a syntax error or a missing transitive import reads evidence_not_reproducible, never pass", async (t) => {
  const { QC_CHECK_REGISTRY, loadQcRederivers } = await import("./qc-check-registry.mjs");
  const { handoffCoverage, readMediaWeight, readQaResults } = await import("./qc-results.mjs");

  const dir = mkdtempSync(join(tmpdir(), "qc-mutation-0-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleAt = (name, source) => {
    const path = join(dir, name);
    if (source != null) writeFileSync(path, source);
    return pathToFileURL(path).href;
  };
  const exportsBoth = "export const rederiveQcResult = () => null;\nexport const MEDIA_WEIGHT_QC_RULES = { thresholds: {}, vocabulary: {}, evaluate: () => [] };\nexport const READABILITY_QC_RULES = { thresholds: {}, vocabulary: {}, evaluate: () => [] };\n";
  const cases = [
    ["exact specifier missing", moduleAt("absent.mjs", null), "missing", NOT_CAPTURED],
    ["throws at load", moduleAt("throws.mjs", `throw new Error("synthetic load failure");\n${exportsBoth}`), "failed", E],
    ["syntax error", moduleAt("syntax.mjs", `export const = ;\n${exportsBoth}`), "failed", E],
    ["transitive import missing", moduleAt("transitive.mjs", `import "./absent-dependency.mjs";\n${exportsBoth}`), "failed", E],
  ];
  const control = moduleAt("control.mjs", exportsBoth);

  // The registry's own seam: the shipped table with every QA and Polish
  // module pointed at one temporary file, imported by the default importer.
  const registryAt = (href) => Object.fromEntries(Object.entries(QC_CHECK_REGISTRY)
    .filter(([, entry]) => entry.leg === "qa" || entry.leg === "polish")
    .map(([check, entry]) => [check, Object.freeze({ ...entry, module: href })]));
  const statuses = (rederivers) => [...new Set(Object.values(rederivers).map((entry) => entry.status))];

  const loadedControl = await loadQcRederivers({ registry: registryAt(control) });
  assert.deepEqual(statuses(loadedControl), ["loaded"], "control: a module that loads reads loaded");

  // The readers' inputs: a recorded QA leg and Polish leg that hold their QC
  // evidence, one stored QA pass row, and a media_weight record.
  const report = {
    stages: {
      qa: { stage: "qa", status: "completed", evidence: { qc_results: [] } },
      polish: { stage: "polish", status: "completed", evidence: { visual_review: { page_load: {}, media_weight: {}, readability: {} } } },
    },
  };
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const passRow = qaRowFor(qaObservation({ check: "tracking.order", key: "utm_source", outcome: "reachable" }), { measured_at: measuredAt });
  const qaRead = (rederivers) => readQaResults({
    stageEvidence: { qc_results: [passRow], qc_build_fingerprint: BUILD_FP },
    stage: { identity: { verdict_run_id: QA_RUN_ID } },
    fullVerdict: fullVerdict({ assertions: [qaAssertionFor(passRow)], measuredAt }),
    currentBuild: BUILD_FP,
    rederivers,
  });
  const evidence = twoCellFixture([{ path: "/runtime-packet-demo/img/hero.jpg", bytes: 100_000 }]);
  const mwRead = (rederivers) => readMediaWeight({ record: evidence.record, pageLoad: evidence.pageLoad, currentBuild: BUILD_FP, rederivers });

  // Controls: the same inputs read pass with a loaded rederiver, so the
  // assertions below are not vacuous.
  assert.deepEqual(qaRead({ "tracking.order": { status: "loaded", rederive: qaRederive } }).map((row) => row.result), ["pass"], "control: the stored QA row reads pass when its rederiver loads");
  assert.ok(mwRead({ "media.weight": { status: "loaded", rederive: polishStandIn() } }).some((row) => row.result === "pass"), "control: the media_weight record yields a pass when its rules load");

  for (const [label, href, status, reasonCode] of cases) {
    const rederivers = await loadQcRederivers({ registry: registryAt(href) });
    assert.deepEqual(statuses(rederivers), [status], `${label}: every check reads ${status} (${JSON.stringify(rederivers)})`);

    const coverage = handoffCoverage({ report, spec: {}, results: [], rederivers });
    assert.ok(coverage.length > 0, `${label}: coverage lists the silent checks`);
    assert.deepEqual([...new Set(coverage.map((entry) => entry.result))], ["unexercised"], `${label}: coverage reads unexercised`);
    assert.deepEqual([...new Set(coverage.map((entry) => entry.reason_code))], [reasonCode], `${label}: coverage reads ${reasonCode} (${JSON.stringify(coverage)})`);

    const qaRows = qaRead(rederivers);
    assert.deepEqual(qaRows.map((row) => [row.result, row.reason_code]), [["unexercised", reasonCode]], `${label}: the stored QA pass reads unexercised / ${reasonCode}, never pass`);

    const mwRows = mwRead(rederivers);
    assert.equal(mwRows.some((row) => row.result === "pass"), false, `${label}: no media_weight result reads pass`);
    if (status === "failed") {
      assert.ok(mwRows.length > 0, `${label}: a failed rules load lists the record's results`);
      assert.deepEqual([...new Set(mwRows.map((row) => [row.result, row.reason_code].join(" ")))], [`unexercised ${E}`], `${label}: every media_weight result reads unexercised / ${E}`);
    } else {
      assert.deepEqual(mwRows, [], `${label}: a missing rules module yields no media_weight rows (coverage lists them)`);
    }
  }
});

// ---------------------------------------------------------------------------
// `next` adds nothing to warnings[], errors[] or ready[] for QC results; they
// appear only in qc_handoff. An open QA warning in qc_handoff leaves
// all three equal to the same packet's with no QC results.

test("next surfaces: an open QA warning in qc_handoff leaves next warnings[], errors[] and ready[] equal to the same packet with no QC results", async (t) => {
  const f = campaignFixture();
  t.after(f.cleanup);
  const measuredAt = new Date(Date.now() - 60_000).toISOString();
  const standIns = { qa: qaStandIns() };

  installQaStage(f, { observations: [qaObservation({ key: "store_terms", outcome: "unreachable" })], measuredAt });
  const open = await runNext(f, standIns);
  const openHandoff = handoffOf(open);
  assert.ok((openHandoff.open || []).some((entry) => entry.leg === "qa"), `the QA warning is open: ${JSON.stringify(openHandoff.open)}`);

  // The same packet and QA stage, with no QC results recorded.
  installQaStage(f, { observations: [qaObservation({ key: "store_terms", outcome: "unreachable" })], measuredAt, evidence: {} });
  const none = await runNext(f, standIns);
  assert.deepEqual(handoffOf(none).open || [], [], "no QC result is open without QC results");

  assert.deepEqual(open.warnings, none.warnings, "warnings[] equal");
  assert.deepEqual(open.errors, none.errors, "errors[] equal");
  assert.deepEqual(open.ready, none.ready, "ready[] equal");
});
