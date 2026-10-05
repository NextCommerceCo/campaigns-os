// Node rows for read-time input currency (Brief answers persist),
// the brief material fingerprint, the stage history archive, and two of the
// Spec refresh effective-status readers: F2.1-W4, W11, W19, W26, W27, B16, B24, I1,
// I4, I11, I16, I18; F2.2-B14, B15, I1, I3.
//
// The interfaces below are imported inside each test so
// a missing module or export fails that row alone:
//   assessInputCurrency({report, briefMaterial, specMaterial}) from
//     src/input-currency.mjs, returning the derived.input_currency shape
//     {brief:{bound,current,status}, spec:{...}, stages:{assembly,polish,qa},
//      reasons:{assembly,polish,qa}};
//   briefMaterialFingerprint(normalizedBrief) from src/build-brief.mjs,
//     returning {presentation, qa_policy};
//   archiveStageRecord(stage, previous, incoming, {by, reason}) from
//     src/stage-ledger.mjs;
//   qaGatePassedForCurrentBuild(report, gate, {buildFingerprint, qaCurrency})
//     and readQaResults({..., qaCurrency}).
//
// API assumption (briefMaterial / specMaterial): the current input values are
// passed as briefMaterial = {presentation, qa_policy} (each "sha256:<64 hex>")
// and specMaterial = "sha256:<64 hex>", the same shapes as the stage stamps
// source_brief_material and source_spec_material_hash.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

// The no-network guard of src/qc-test-factories.mjs is installed by this
// import, before any module under test is loaded (they are imported inside
// each test below).
import {
  BUILD_FP,
  QA_RUN_ID,
  assertNoNetworkAttempts,
  fullVerdict,
  qaAssertionFor,
  qaObservation,
  qaRowFor,
  qaStandIns,
  resultsOf,
} from "./qc-test-factories.mjs";
import { ROOT, readJson, reverseKeys, sha256Text, SHA256_PATTERN, withNetworkGuard } from "./input-test-factories.mjs";

afterEach(() => assertNoNetworkAttempts());
after(() => assertNoNetworkAttempts());

const EXAMPLE_BRIEF = join(ROOT, "examples/campaign-build-brief.single-variant-gadget.yaml");
const EXAMPLE_SPEC = join(ROOT, "examples/campaignspec.v42.basic.json");

const BRIEF_ZERO = Object.freeze({ presentation: sha256Text("synthetic brief presentation zero"), qa_policy: sha256Text("synthetic brief qa_policy zero") });
const BRIEF_ONE = Object.freeze({ presentation: sha256Text("synthetic brief presentation one"), qa_policy: sha256Text("synthetic brief qa_policy one") });
const SPEC_ONE = sha256Text("synthetic spec material one");
const SPEC_TWO = sha256Text("synthetic spec material two");
const BUILD_ZERO = sha256Text("synthetic build zero");
const BUILD_ONE = sha256Text("synthetic build one");
const COMPLETED_AT = "2026-10-05T10:00:00.000Z";

async function currencyModule() {
  const module = await import("./input-currency.mjs");
  assert.equal(typeof module.assessInputCurrency, "function", "src/input-currency.mjs exports assessInputCurrency");
  return module;
}

async function buildBriefExport(name) {
  const module = await import("./build-brief.mjs");
  assert.equal(typeof module[name], "function", `src/build-brief.mjs exports ${name}`);
  return module[name];
}

async function archiveExport() {
  const { archiveStageRecord } = await import("./stage-ledger.mjs");
  assert.equal(typeof archiveStageRecord, "function", "src/stage-ledger.mjs exports archiveStageRecord");
  return archiveStageRecord;
}

// A completed assembly, polish or qa record stamped with `brief` and `spec`.
function stamped(key, { brief = BRIEF_ONE, spec = SPEC_ONE, ...extra } = {}) {
  return {
    stage: key,
    status: "completed",
    completed_at: COMPLETED_AT,
    ...(key === "assembly" ? { build_fingerprint: BUILD_ONE } : {}),
    ...(key === "polish" ? { source_build_fingerprint: BUILD_ONE } : {}),
    source_brief_material: { ...brief },
    source_spec_material_hash: spec,
    ...extra,
  };
}

// A synthetic Assembly Report whose brief and spec bindings are current
// unless overridden; every stage but the ones given is terminal and unstamped
// (prepare_build, setup, deploy) or pending (doctor).
function syntheticReport({ assembly, polish, qa, buildBrief, identity, generatedAt = "2026-10-05T08:00:00.000Z" } = {}) {
  return {
    schema_version: "campaigns-os-assembly-report/v0",
    generated_at: generatedAt,
    status: "completed",
    identity: { public_route_slug: "runtime-packet-demo", spec_material_hash: SPEC_ONE, ...identity },
    build_brief: buildBrief === undefined
      ? { mode: "guided_draft", status: "complete", material: { ...BRIEF_ONE }, input_sha256: null }
      : buildBrief,
    stages: {
      prepare_build: { stage: "prepare_build", status: "completed" },
      doctor: { stage: "doctor", status: "pending" },
      setup: { stage: "setup", status: "completed" },
      assembly: assembly ?? stamped("assembly"),
      polish: polish ?? stamped("polish"),
      deploy: { stage: "deploy", status: "completed" },
      qa: qa ?? stamped("qa"),
    },
  };
}

// The shipped example brief, normalized from a file at `path` written from
// `value` by `serialize`; _meta.generated_at set to `generatedAt` when given.
async function normalizeBrief(dir, name, value, serialize = (v) => `${JSON.stringify(v, null, 2)}\n`, generatedAt = null) {
  const create = await buildBriefExport("createCampaignBuildBriefArtifact");
  const path = join(dir, name);
  writeFileSync(path, serialize(value));
  const result = create({ inputPath: path, inputSource: "operator_flag", spec: readJson(EXAMPLE_SPEC) });
  assert.deepEqual(result.errors, [], `setup: ${name} normalizes without errors`);
  if (generatedAt) result.artifact._meta.generated_at = generatedAt;
  return result.artifact;
}

async function exampleBriefValue() {
  const load = await buildBriefExport("loadCampaignBuildBriefFile");
  return load(EXAMPLE_BRIEF).value;
}

async function withTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), "input-currency-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// API assumption (archiveStageRecord): `stage` is the stage record whose
// history[] receives the entry (capped at PRODUCER_STAGE_HISTORY_LIMIT = 5,
// oldest first evicted, dedup kept). The function either updates
// stage.history in place or returns the updated stage record; the record
// carrying history[] afterwards is what each row reads.
function archiveInto(archiveStageRecord, stage, previous, incoming, options) {
  const returned = archiveStageRecord(stage, previous, incoming, options);
  return returned && typeof returned === "object" && Array.isArray(returned.history) ? returned : stage;
}

// Seven completed assembly records with pairwise different identity fields.
function assemblyRecord(index) {
  return {
    stage: "assembly",
    status: "completed",
    inputs: [],
    outputs: [`_site/runtime-packet-demo/landing/index.html#${index}`],
    commands: ["campaigns-os record build"],
    blockers: [],
    warnings: [],
    completed_at: `2026-10-0${index}T10:00:00.000Z`,
    recorded_by: "campaigns-os record build",
    performed_by: "next-campaigns-build",
    build_fingerprint: sha256Text(`synthetic build ${index}`),
    source_package_material_fingerprint: sha256Text("synthetic design source package"),
    source_brief_material: { ...BRIEF_ONE },
    source_spec_material_hash: SPEC_ONE,
    evidence: { build_environment: "production" },
  };
}

// The closed history entry field list, without the
// three archive fields.
const ENTRY_RECORD_FIELDS = Object.freeze([
  "status", "completed_at", "recorded_by", "performed_by",
  "build_fingerprint", "source_build_fingerprint", "source_package_material_fingerprint",
  "source_brief_material", "source_spec_material_hash",
  "verdict_run_id", "checked_at", "purchase_proof",
  "outputs", "evidence",
]);
const ARCHIVE_OPTIONS = Object.freeze({ by: "record build", reason: "rerecorded" });

test("F2.1-W4: briefMaterialFingerprint is equal for both partitions across reversed key order, tab indent and an explicit default", async () => {
  await withNetworkGuard(() => withTemp(async (dir) => {
    const briefMaterialFingerprint = await buildBriefExport("briefMaterialFingerprint");
    const value = await exampleBriefValue();
    const plain = structuredClone(value);
    if (plain.template_residue_policy) delete plain.template_residue_policy.block_placeholders;
    const variant = reverseKeys(structuredClone(plain));
    variant.template_residue_policy = { ...(variant.template_residue_policy || {}), block_placeholders: true };
    // One brief file at one path, normalized, rewritten as the variant, and
    // normalized again: only the content's serialization differs.
    const first = await normalizeBrief(dir, "brief.json", plain);
    const plainBytes = readFileSync(join(dir, "brief.json"), "utf8");
    const second = await normalizeBrief(dir, "brief.json", variant, (v) => `${JSON.stringify(v, null, "\t")}\n`);
    assert.notEqual(readFileSync(join(dir, "brief.json"), "utf8"), plainBytes, "setup: the two versions of the file differ in bytes");
    assert.equal(Object.hasOwn(plain.template_residue_policy || {}, "block_placeholders"), false, "setup: the plain file omits the default");
    const a = briefMaterialFingerprint(first);
    const b = briefMaterialFingerprint(second);
    assert.deepEqual(Object.keys(a).sort(), ["presentation", "qa_policy"], "both partitions are fingerprinted");
    assert.match(a.presentation, SHA256_PATTERN);
    assert.match(a.qa_policy, SHA256_PATTERN);
    assert.deepEqual(b, a);
  }));
});

test("F2.1-W11: a legacy report (no binding, no stamps) whose normalized brief predates assembly completed_at reads assembly unknown", async () => {
  await withNetworkGuard(() => withTemp(async (dir) => {
    const { assessInputCurrency } = await currencyModule();
    const briefMaterialFingerprint = await buildBriefExport("briefMaterialFingerprint");
    const normalized = await normalizeBrief(dir, "brief.json", await exampleBriefValue(), undefined, "2026-10-05T08:00:00.000Z");
    const briefMaterial = briefMaterialFingerprint(normalized);
    const report = syntheticReport({
      buildBrief: { mode: "guided_draft", status: "complete" },
      assembly: { stage: "assembly", status: "completed", completed_at: "2026-10-05T10:00:00.000Z", build_fingerprint: BUILD_ONE },
      generatedAt: "2026-10-05T08:00:00.000Z",
    });
    assert.ok(Date.parse(normalized._meta.generated_at) < Date.parse(report.stages.assembly.completed_at), "setup: the brief predates the build");
    const currency = assessInputCurrency({ report, briefMaterial, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  }));
});

test("F2.1-I1: a legacy report whose normalized brief is later than assembly completed_at reads assembly unknown", async () => {
  await withNetworkGuard(() => withTemp(async (dir) => {
    const { assessInputCurrency } = await currencyModule();
    const briefMaterialFingerprint = await buildBriefExport("briefMaterialFingerprint");
    const normalized = await normalizeBrief(dir, "brief.json", await exampleBriefValue(), undefined, "2026-10-05T11:00:00.000Z");
    const briefMaterial = briefMaterialFingerprint(normalized);
    const report = syntheticReport({
      buildBrief: { mode: "guided_draft", status: "complete" },
      assembly: { stage: "assembly", status: "completed", completed_at: "2026-10-05T10:00:00.000Z", build_fingerprint: BUILD_ONE },
      generatedAt: "2026-10-05T11:00:00.000Z",
    });
    assert.ok(Date.parse(normalized._meta.generated_at) > Date.parse(report.stages.assembly.completed_at), "setup: the brief is later than the build");
    const currency = assessInputCurrency({ report, briefMaterial, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  }));
});

test("F2.1-W19: archiveStageRecord called six times on one stage with distinct records keeps history.length 5", async () => {
  await withNetworkGuard(async () => {
    const archiveStageRecord = await archiveExport();
    let stage = { stage: "assembly", status: "completed", history: [] };
    for (let index = 1; index <= 6; index += 1) {
      stage = archiveInto(archiveStageRecord, stage, assemblyRecord(index), assemblyRecord(index + 1), ARCHIVE_OPTIONS);
    }
    assert.equal(stage.history.length, 5);
  });
});

test("F2.1-W26: archiveStageRecord skips a call whose previous record equals the incoming one, so history.length is 1", async () => {
  await withNetworkGuard(async () => {
    const archiveStageRecord = await archiveExport();
    const r1 = assemblyRecord(1);
    const r2 = assemblyRecord(2);
    let stage = { stage: "assembly", status: "completed", history: [] };
    stage = archiveInto(archiveStageRecord, stage, r1, r2, ARCHIVE_OPTIONS);
    stage = archiveInto(archiveStageRecord, stage, r2, r2, ARCHIVE_OPTIONS);
    assert.equal(stage.history.length, 1);
  });
});

test("F2.1-W27: after six archives of r1..r6 the oldest entry is evicted, and history[0] is r2 projected onto the closed entry field list", async () => {
  await withNetworkGuard(async () => {
    const archiveStageRecord = await archiveExport();
    const records = Array.from({ length: 7 }, (_, index) => assemblyRecord(index + 1));
    let stage = { stage: "assembly", status: "completed", history: [] };
    for (let index = 0; index < 6; index += 1) {
      stage = archiveInto(archiveStageRecord, stage, records[index], records[index + 1], ARCHIVE_OPTIONS);
    }
    assert.ok(stage.history.length > 0, "setup: history holds archived entries");
    const { archived_at: _at, archived_by: _by, reason_code: _code, ...rest } = stage.history[0];
    const projected = Object.fromEntries(ENTRY_RECORD_FIELDS.filter((field) => Object.hasOwn(records[1], field)).map((field) => [field, records[1][field]]));
    assert.deepEqual(rest, projected);
  });
});

test("F2.1-B24: after six distinct rerecorded history entries evict the input-driven one, assembly owed by input_change still reads owed", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const archiveStageRecord = await archiveExport();
    // F2.1-B10's state: the brief changed (record brief demoted assembly and
    // wrote input_change), then record build replayed the unchanged output.
    let assembly = stamped("assembly", {
      build_fingerprint: BUILD_ONE,
      input_change: {
        at: "2026-10-05T09:00:00.000Z",
        reason: "brief_presentation_changed",
        superseded_build_fingerprint: BUILD_ONE,
        superseded_inputs: { brief_material: { ...BRIEF_ZERO }, spec_material_hash: SPEC_ONE },
      },
      history: [{
        archived_at: "2026-10-05T09:00:00.000Z",
        archived_by: "record brief",
        reason_code: "brief_presentation_changed",
        ...assemblyRecord(1),
        build_fingerprint: BUILD_ONE,
        source_brief_material: { ...BRIEF_ZERO },
      }],
    });
    const records = Array.from({ length: 7 }, (_, index) => assemblyRecord(index + 1));
    for (let index = 0; index < 6; index += 1) {
      assembly = archiveInto(archiveStageRecord, assembly, records[index], records[index + 1], ARCHIVE_OPTIONS);
    }
    assert.equal(assembly.history.length, 5, "setup: the history is at its cap");
    assert.deepEqual(assembly.history.map((entry) => entry.reason_code), Array(5).fill("rerecorded"), "setup: only rerecorded entries remain; the input-driven entry was evicted");
    const currency = assessInputCurrency({ report: syntheticReport({ assembly }), briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "owed");
  });
});

test("F2.1-B16: a completed assembly whose brief presentation stamp is sha256:abc (not 64 hex), other stamps current, reads unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const assembly = stamped("assembly", { brief: { ...BRIEF_ONE, presentation: "sha256:abc" } });
    const currency = assessInputCurrency({ report: syntheticReport({ assembly }), briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  });
});

test("F2.1-I4: report.build_brief.material.presentation = \"abc\" reads input_currency.brief.status unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const report = syntheticReport({ buildBrief: { mode: "guided_draft", status: "complete", material: { ...BRIEF_ONE, presentation: "abc" }, input_sha256: null } });
    const currency = assessInputCurrency({ report, briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.brief.status, "unknown");
  });
});

test("F2.1-I11: stages.assembly.status completed_unrecognized with stamps equal to the current values reads unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const assembly = stamped("assembly", { status: "completed_unrecognized" });
    const currency = assessInputCurrency({ report: syntheticReport({ assembly }), briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  });
});

test("F2.1-I16: stages.assembly.source_spec_material_hash = \"abc\", other stamps current, reads unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const assembly = stamped("assembly", { spec: "abc" });
    const currency = assessInputCurrency({ report: syntheticReport({ assembly }), briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  });
});

test("F2.1-I18: a completed assembly with current stamps and input_change.at = \"yesterday\" reads unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const assembly = stamped("assembly", {
      input_change: {
        at: "yesterday",
        reason: "brief_presentation_changed",
        superseded_build_fingerprint: BUILD_ZERO,
        superseded_inputs: { brief_material: { ...BRIEF_ZERO }, spec_material_hash: SPEC_ONE },
      },
    });
    const currency = assessInputCurrency({ report: syntheticReport({ assembly }), briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  });
});

test("F2.2-I1: a legacy report without identity.spec_material_hash and with unstamped stages reads assembly unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const report = syntheticReport({
      identity: { spec_material_hash: undefined },
      buildBrief: { mode: "guided_draft", status: "complete" },
      assembly: { stage: "assembly", status: "completed", completed_at: COMPLETED_AT, build_fingerprint: BUILD_ONE },
      polish: { stage: "polish", status: "completed", completed_at: COMPLETED_AT, source_build_fingerprint: BUILD_ONE },
      qa: { stage: "qa", status: "completed", completed_at: COMPLETED_AT },
    });
    delete report.identity.spec_material_hash;
    const currency = assessInputCurrency({ report, briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_ONE });
    assert.equal(currency.stages.assembly, "unknown");
  });
});

test("F2.2-I3: a QA stage without source_spec_material_hash, with report identity unequal to the current spec, reads qa unknown", async () => {
  await withNetworkGuard(async () => {
    const { assessInputCurrency } = await currencyModule();
    const { source_spec_material_hash: _dropped, ...qa } = stamped("qa");
    const report = syntheticReport({ qa, identity: { spec_material_hash: SPEC_ONE } });
    const currency = assessInputCurrency({ report, briefMaterial: { ...BRIEF_ONE }, specMaterial: SPEC_TWO });
    assert.equal(currency.stages.qa, "unknown");
  });
});

// API assumption (F2.2-B14, reader 7): qaGatePassedForCurrentBuild takes the
// QA currency as `qaCurrency` beside `buildFingerprint`. The setup's spec edit
// makes the QA spec stamp differ from the current spec, which reads `owed`
// by the read-time input currency rules; that currency is passed.
test("F2.2-B14: a QA gate passing for the current build reads qaGatePassedForCurrentBuild false once the spec is edited", async () => {
  await withNetworkGuard(async () => {
    const { QA_GATE_PLACEHOLDER_TEXT_RESIDUE, qaGateEvidence, qaGatePassedForCurrentBuild } = await import("./stage-ledger.mjs");
    const qa = stamped("qa", {
      verdict_run_id: QA_RUN_ID,
      evidence: { source_build_fingerprint: BUILD_ONE, gates: { [QA_GATE_PLACEHOLDER_TEXT_RESIDUE]: { status: "pass" } }, qc_results: [], qc_build_fingerprint: BUILD_ONE },
    });
    const report = syntheticReport({ qa });
    assert.deepEqual(qaGateEvidence(report, QA_GATE_PLACEHOLDER_TEXT_RESIDUE), { status: "pass", source_build_fingerprint: BUILD_ONE }, "setup: QA recorded a pass for the current build");
    assert.equal(report.stages.assembly.build_fingerprint, BUILD_ONE, "setup: the current build is the one QA judged");
    assert.notEqual(report.stages.qa.source_spec_material_hash, SPEC_TWO, "setup: the edited spec differs from the QA spec stamp");
    assert.equal(qaGatePassedForCurrentBuild(report, QA_GATE_PLACEHOLDER_TEXT_RESIDUE, { buildFingerprint: BUILD_ONE, qaCurrency: "owed" }), false);
  });
});

// API assumption (F2.2-B15, reader 8): readQaResults takes `qaCurrency`
// beside `currentBuild`; the setup's spec edit reads QA `owed`, which is
// passed. Omitted, rows bind by the build fingerprint alone.
test("F2.2-B15: QA rows bound to the current build read the reason-code set {stale_binding} once the spec is edited", async () => {
  await withNetworkGuard(async () => {
    const { readQaResults } = await import("./qc-results.mjs");
    const measuredAt = new Date(Date.now() - 60_000).toISOString();
    const observations = [
      qaObservation({ check: "policy.availability", key: "store_terms", outcome: "unreachable" }),
      qaObservation({ check: "policy.presence", key: "store_privacy", outcome: "reachable" }),
    ];
    const rows = observations.map((observation) => qaRowFor(observation, { measured_at: measuredAt }));
    const assertions = rows.map((row) => qaAssertionFor(row));
    const stage = {
      stage: "qa",
      status: "completed",
      outputs: [],
      identity: { verdict_run_id: QA_RUN_ID },
      source_brief_material: { ...BRIEF_ONE },
      source_spec_material_hash: SPEC_ONE,
      evidence: { qc_results: rows, qc_build_fingerprint: BUILD_FP },
    };
    const read = (extra) => resultsOf(readQaResults({ stageEvidence: stage.evidence, stage, fullVerdict: fullVerdict({ assertions, measuredAt }), currentBuild: BUILD_FP, qcStandIns: { qa: qaStandIns() }, ...extra }));
    const control = read({});
    assert.equal(control.length, 2, "setup: both QA rows are read");
    assert.deepEqual(control.map((row) => row.reason_code).sort(), [null, "policy_unreachable"].sort(), "setup: the rows reproduce and are bound to the current build");
    const results = read({ qaCurrency: "owed" });
    assert.ok(results.length > 0, "setup: the reader returned QA rows");
    assert.deepEqual([...new Set(results.map((row) => row.reason_code))].sort(), ["stale_binding"]);
  });
});
