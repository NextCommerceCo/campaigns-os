// Input currency over hostile and malformed data: brief keys that name
// Object.prototype members stay material, every closed shape a stage carries
// rejects extra, missing and mistyped keys (the stage reads unknown), intake
// with --force keeps every stage's history, and a fresh QA verdict stamped
// against the current inputs clears the stage's input change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { briefMaterialFingerprint, createCampaignBuildBriefArtifact } from "./build-brief.mjs";
import { assessInputCurrency, assessStageCurrency, detectedStageChange, inputStamps } from "./input-currency.mjs";
import { CLI, ROOT, readJson } from "./input-test-factories.mjs";
import { archiveForForceReset, archiveStageRecord, recordProducerStageOutcome } from "./stage-ledger.mjs";

const fp = (char) => `sha256:${char.repeat(64)}`;
const BRIEF = Object.freeze({ presentation: fp("a"), qa_policy: fp("b") });
const SPEC = fp("c");
const CURRENT = Object.freeze({ brief: BRIEF, spec: SPEC });
const clone = (value) => JSON.parse(JSON.stringify(value));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } });
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

// ---------------------------------------------------------------------------
// Brief keys named __proto__, constructor or prototype are data.

const briefWith = (json) => JSON.parse(`{"schema_version":"campaigns-os-build-brief/v1","brand":{"cta_style":"pill"},"qa_policy":{"enforcement":"fixed"},${json}}`);

for (const key of ["__proto__", "constructor", "prototype"]) {
  test(`a brief section named ${key} is presentation material: changing it changes the fingerprint`, () => {
    const one = briefMaterialFingerprint(briefWith(`"${key}":{"custom":"one"}`));
    const two = briefMaterialFingerprint(briefWith(`"${key}":{"custom":"two"}`));
    const none = briefMaterialFingerprint(briefWith(`"other":{}`));
    assert.notEqual(one.presentation, two.presentation);
    assert.notEqual(one.presentation, none.presentation);
    assert.equal(one.qa_policy, two.qa_policy);
  });
}

test("a qa_policy key named __proto__ is qa_policy material: changing it changes the fingerprint", () => {
  const brief = (value) => JSON.parse(`{"brand":{},"qa_policy":{"enforcement":"fixed","__proto__":{"depth":"${value}"}}}`);
  assert.notEqual(briefMaterialFingerprint(brief("one")).qa_policy, briefMaterialFingerprint(brief("two")).qa_policy);
});

test("a generated draft keeps a page id named __proto__ in design_authority and its field source", () => {
  const { artifact } = createCampaignBuildBriefArtifact({ activePages: [{ id: "__proto__", type: "checkout" }, { id: "landing", type: "landing" }], pageMappings: [] });
  assert.ok(Object.hasOwn(artifact.design_authority, "__proto__"), "design_authority keeps the __proto__ page");
  assert.equal(artifact.design_authority.__proto__.source, "template");
  assert.equal(Object.getPrototypeOf(artifact.design_authority), Object.prototype, "the page did not become the prototype");
  assert.equal(artifact._meta.field_sources["design_authority.__proto__.source"]?.kind, "default");
});

test("re-recording a stage whose evidence differs only under a __proto__ key archives the superseded record whole", () => {
  const previous = { stage: "polish", status: "completed", source_build_fingerprint: fp("d"), evidence: JSON.parse('{"notes":{"__proto__":{"checked":"one"}}}') };
  const incoming = { ...previous, evidence: JSON.parse('{"notes":{"__proto__":{"checked":"two"}}}') };
  const archived = archiveStageRecord(incoming, previous, incoming, { by: "record polish", reason: "rerecorded", at: "2026-10-05T00:00:00.000Z", stageKey: "polish" });
  assert.equal(archived.history?.length, 1, "the different evidence is a new record, not a re-record");
  assert.deepEqual(JSON.parse(JSON.stringify(archived.history[0].evidence)), { notes: JSON.parse('{"__proto__":{"checked":"one"}}') });
});

test("record brief over a changed __proto__ section demotes a build stamped against the earlier brief", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-shapes-"));
  try {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const prepared = runCli(["prepare-build", "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"), "--source", resolve(ROOT, "examples/source-html"),
      "--target", target, "--template-family", "olympus", "--no-run-session", "--json"], dir);
    assert.equal(prepared.status, 0, prepared.stderr);
    const packetPath = join(target, "campaign-runtime.build.json");
    const reportPath = join(target, ".campaign-runtime/assembly-report.json");
    const briefFile = join(target, "campaign-build-brief.json");
    const saveSection = (value) => {
      const brief = readJson(join(target, ".campaign-runtime/input/campaign-build-brief.normalized.json"));
      delete brief["__proto__"];
      const text = JSON.stringify(brief).replace(/^\{/, `{"__proto__":{"custom":"${value}"},`);
      writeFileSync(briefFile, text);
      const saved = runCli(["record", "brief", "--packet", packetPath, "--json"], dir);
      assert.equal(saved.status, 0, saved.stderr);
      return JSON.parse(saved.stdout);
    };
    saveSection("one");
    // A build recorded against the brief as saved now.
    const currency = JSON.parse(runCli(["doctor", "--packet", packetPath, "--no-live-refs", "--json"], dir).stdout).derived.input_currency;
    const report = readJson(reportPath);
    Object.assign(report.stages.assembly, {
      status: "completed", build_fingerprint: fp("1"), completed_at: "2026-10-05T00:00:00.000Z",
      source_brief_material: currency.brief.current, source_spec_material_hash: currency.spec.current,
    });
    writeJson(reportPath, report);
    const result = saveSection("two");
    assert.equal(result.outcome, "saved_with_invalidation", JSON.stringify(result).slice(0, 400));
    assert.equal(readJson(reportPath).stages.assembly.status, "required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Closed shapes: extra, missing and mistyped keys read unknown.

const INPUT_CHANGE = Object.freeze({
  at: "2026-10-05T00:00:00.000Z",
  reason: "brief_presentation_changed",
  superseded_build_fingerprint: fp("e"),
  superseded_inputs: { brief_material: { presentation: fp("f"), qa_policy: fp("b") }, spec_material_hash: SPEC },
});
const UNCHANGED_REASON = Object.freeze({ text: "Operator kept the output.", for_inputs: { brief_material: clone(BRIEF), spec_material_hash: SPEC } });

// A current assembly record carrying every closed shape: an input change
// whose superseded build differs from the output, and an operator reason.
const assembly = () => ({
  stage: "assembly",
  status: "completed",
  build_fingerprint: fp("1"),
  source_brief_material: clone(BRIEF),
  source_spec_material_hash: SPEC,
  input_change: clone(INPUT_CHANGE),
  unchanged_output_reason: clone(UNCHANGED_REASON),
});

const MALFORMED = Object.freeze([
  ["source_brief_material with an extra key", (r) => { r.source_brief_material.unexpected = true; }],
  ["source_brief_material missing qa_policy", (r) => { delete r.source_brief_material.qa_policy; }],
  ["source_brief_material as an array", (r) => { r.source_brief_material = [BRIEF.presentation, BRIEF.qa_policy]; }],
  ["source_spec_material_hash as a number", (r) => { r.source_spec_material_hash = 1; }],
  ["input_change with an extra key", (r) => { r.input_change.unexpected = true; }],
  ["input_change missing at", (r) => { delete r.input_change.at; }],
  ["input_change missing superseded_build_fingerprint", (r) => { delete r.input_change.superseded_build_fingerprint; }],
  ["input_change with a numeric reason", (r) => { r.input_change.reason = 1; }],
  ["input_change as an array", (r) => { r.input_change = [clone(INPUT_CHANGE)]; }],
  ["input_change.superseded_inputs with an extra key", (r) => { r.input_change.superseded_inputs.unexpected = null; }],
  ["input_change.superseded_inputs missing spec_material_hash", (r) => { delete r.input_change.superseded_inputs.spec_material_hash; }],
  ["input_change.superseded_inputs.brief_material with an extra key", (r) => { r.input_change.superseded_inputs.brief_material.unexpected = "absent"; }],
  ["input_change.superseded_inputs.brief_material missing presentation", (r) => { delete r.input_change.superseded_inputs.brief_material.presentation; }],
  ["unchanged_output_reason with an extra key", (r) => { r.unchanged_output_reason.unexpected = true; }],
  ["unchanged_output_reason missing for_inputs", (r) => { delete r.unchanged_output_reason.for_inputs; }],
  ["unchanged_output_reason with a numeric text", (r) => { r.unchanged_output_reason.text = 1; }],
  ["unchanged_output_reason.for_inputs with an extra key", (r) => { r.unchanged_output_reason.for_inputs.unexpected = SPEC; }],
  ["unchanged_output_reason.for_inputs.brief_material with an extra key", (r) => { r.unchanged_output_reason.for_inputs.brief_material.unexpected = "absent"; }],
]);

test("an assembly record carrying every closed shape well formed reads current", () => {
  assert.deepEqual(assessStageCurrency("assembly", assembly(), CURRENT), { currency: "current", reason: null });
});

for (const [name, mutate] of MALFORMED) {
  test(`an assembly record with ${name} reads unknown, not current`, () => {
    const record = assembly();
    mutate(record);
    assert.deepEqual(assessStageCurrency("assembly", record, CURRENT), { currency: "unknown", reason: "input_binding_unknown" });
  });
}

test("a QA record whose input_change carries an extra key reads unknown", () => {
  const qa = { stage: "qa", status: "completed", source_brief_material: clone(BRIEF), source_spec_material_hash: SPEC, input_change: { ...clone(INPUT_CHANGE), superseded_build_fingerprint: null, unexpected: true } };
  assert.equal(assessStageCurrency("qa", qa, CURRENT).currency, "unknown");
  delete qa.input_change.unexpected;
  assert.equal(assessStageCurrency("qa", qa, CURRENT).currency, "current");
});

test("bound brief material with an extra key reads brief status unknown", () => {
  const report = { build_brief: { material: { ...clone(BRIEF), unexpected: true } }, stages: {} };
  assert.equal(assessInputCurrency({ report, briefMaterial: BRIEF, specMaterial: SPEC }).brief.status, "unknown");
});

test("a verdict brief material with an extra key gives no brief stamp", () => {
  assert.equal(inputStamps({ briefMaterial: { ...clone(BRIEF), unexpected: true }, specMaterial: SPEC }).source_brief_material, null);
});

test("a malformed brief stamp is not a detected change", () => {
  const record = { status: "completed", source_brief_material: { presentation: fp("9"), qa_policy: fp("b"), unexpected: true }, source_spec_material_hash: SPEC };
  assert.equal(detectedStageChange("assembly", record, { briefMaterial: BRIEF, specMaterial: SPEC }), null);
});

test("a saved field equal to its previous value carries only a well-formed, matching previous field source", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-shapes-"));
  try {
    const file = join(dir, "campaign-build-brief.json");
    // Fields no open question names, so an equal value keeps its previous entry.
    writeJson(file, { schema_version: "campaigns-os-build-brief/v1", brief_mode: "guided", campaign_intent: { tone: "calm", audience: "returning buyers", conversion_goal: "checkout" } });
    const first = createCampaignBuildBriefArtifact({ inputPath: file }).artifact;
    const previous = clone(first);
    previous._meta.field_sources["campaign_intent.tone"].unexpected = true;
    previous._meta.field_sources["campaign_intent.audience"].kind = "inferred";
    previous._meta.field_sources["campaign_intent.conversion_goal"].value_fingerprint = fp("0");
    const sources = createCampaignBuildBriefArtifact({ inputPath: file, previousNormalizedBrief: previous }).artifact._meta.field_sources;
    for (const path of ["campaign_intent.tone", "campaign_intent.audience", "campaign_intent.conversion_goal"]) {
      assert.equal(Object.hasOwn(sources, path), false, `${path}: a malformed previous entry is not carried`);
    }
    const carried = createCampaignBuildBriefArtifact({ inputPath: file, previousNormalizedBrief: first }).artifact._meta.field_sources;
    assert.deepEqual(carried["campaign_intent.tone"], first._meta.field_sources["campaign_intent.tone"], "a well-formed entry is carried");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Intake with --force keeps every stage's history.

const ENTRY = Object.freeze({ archived_at: "2026-10-01T00:00:00.000Z", archived_by: "record build", reason_code: "rerecorded", status: "completed" });

test("the --force archive carries the existing history of every stage, not only build, Polish and QA", () => {
  const previous = { stages: {} };
  const reseeded = { stages: {} };
  for (const key of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) {
    previous.stages[key] = { stage: key, status: "pending", history: [{ ...ENTRY, status: `${key}-entry` }] };
    reseeded.stages[key] = { stage: key, status: "pending" };
  }
  const result = archiveForForceReset(previous, reseeded, { now: "2026-10-05T00:00:00.000Z", detectChange: () => null });
  for (const key of Object.keys(previous.stages)) {
    assert.deepEqual(result.stages[key].history, previous.stages[key].history, `stages.${key}.history is carried`);
  }
});

test("prepare-build --force keeps setup and deploy history in the reseeded report", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-shapes-"));
  try {
    const target = join(dir, "target");
    cpSync(resolve(ROOT, "examples/target-page-kit"), target, { recursive: true });
    const intake = (extra) => runCli(["prepare-build", "--spec", resolve(ROOT, "examples/campaignspec.v42.basic.json"), "--source", resolve(ROOT, "examples/source-html"),
      "--target", target, "--template-family", "olympus", "--no-run-session", ...extra, "--json"], dir);
    const first = intake([]);
    assert.equal(first.status, 0, first.stderr);
    const reportPath = join(target, ".campaign-runtime/assembly-report.json");
    const report = readJson(reportPath);
    report.stages.setup.history = [{ ...ENTRY, archived_by: "record polish" }];
    report.stages.deploy.history = [{ ...ENTRY, archived_by: "qa run" }];
    writeJson(reportPath, report);
    const forced = intake(["--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    const after = readJson(reportPath);
    assert.deepEqual(after.stages.setup.history, report.stages.setup.history);
    assert.deepEqual(after.stages.deploy.history, report.stages.deploy.history);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// record polish detects a change on any completed* record it replaces.

// A real intake and record setup / record build over hand-written pages, the
// prepare-build gate made terminal the way a cleared package leaves it.
function builtCampaign(dir) {
  const source = join(dir, "source");
  const target = join(dir, "target");
  const specPath = join(dir, "campaignspec.json");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
  for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
  writeJson(specPath, spec);
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  const prepared = runCli(["prepare-build", "--spec", specPath, "--source", source, "--target", target, "--template-family", "olympus", "--no-run-session", "--json"], dir);
  assert.equal(prepared.status, 0, prepared.stderr);
  const packetPath = join(target, "campaign-runtime.build.json");
  const reportPath = join(target, ".campaign-runtime/assembly-report.json");
  const report = readJson(reportPath);
  Object.assign(report.stages.prepare_build, { status: "completed", blockers: [] });
  report.blockers = [];
  report.status = "prepared";
  writeJson(reportPath, report);
  const packet = readJson(packetPath);
  mkdirSync(resolve(target, packet.assembly.output_dir), { recursive: true });
  const entry = Object.fromEntries(["store_name", "store_url", "store_terms", "store_privacy", "store_contact", "store_returns", "store_shipping", "store_phone", "store_phone_tel"].map((field) => [field, spec.campaign[field]]));
  entry.sdk_version = spec.runtime?.sdk_version || spec.global_config?.sdk_version;
  writeJson(join(target, "_data/campaigns.json"), { [spec.campaign.slug]: entry });
  assert.equal(runCli(["record", "setup", "--packet", packetPath], dir).status, 0);
  for (const page of spec.funnels.flatMap((funnel) => funnel.pages)) {
    const route = String(page.page_url || "").replace(/^\/+|\/+$/g, "");
    const file = join(target, "_site", packet.campaign.public_route_slug, route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><meta name="next-page-type" content="${page.type}"><title>${page.id}</title><script src="https://cdn.example.com/campaign-cart@v0.4.37/dist/loader.js"></script></head><body data-next-page="${page.id}"><h1>${page.id}</h1></body></html>\n`);
  }
  const built = runCli(["record", "build", "--packet", packetPath], dir);
  assert.equal(built.status, 0, built.stderr);
  return { packetPath, reportPath };
}

test("record polish over a completed_partial Polish stamped against an earlier brief records the input change", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-shapes-"));
  try {
    const { packetPath, reportPath } = builtCampaign(dir);
    const report = readJson(reportPath);
    const { assembly } = report.stages;
    Object.assign(report.stages.polish, {
      status: "completed_partial", source_build_fingerprint: assembly.build_fingerprint, completed_at: "2026-10-01T00:00:00.000Z",
      source_brief_material: { ...assembly.source_brief_material, presentation: fp("7") }, source_spec_material_hash: assembly.source_spec_material_hash,
    });
    writeJson(reportPath, report);
    const evidence = join(dir, "polish-evidence.json");
    writeJson(evidence, { status: "skipped", skip_reason: "Operator skipped Polish for this synthetic campaign." });
    const recorded = runCli(["record", "polish", "--packet", packetPath, "--evidence", evidence, "--json"], dir);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(readJson(reportPath).stages.polish.input_change?.reason, "brief_presentation_changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The QA write clears input_change when its verdict is stamped current.

test("a fresh QA verdict stamped against the current inputs omits input_change, even when the same write detects the previous stamps changed", () => {
  const report = {
    stages: {
      qa: { stage: "qa", status: "completed", verdict_run_id: "qa-old", checked_at: "2026-10-01T00:00:00.000Z", source_brief_material: { presentation: fp("7"), qa_policy: fp("b") }, source_spec_material_hash: SPEC },
    },
  };
  const inputs = {
    detectChange: (record) => detectedStageChange("qa", record, { briefMaterial: BRIEF, specMaterial: SPEC }) ? "brief_presentation_changed" : null,
    stampsCurrent: (record) => assessStageCurrency("qa", { ...record, status: "completed" }, CURRENT).currency === "current",
  };
  const updated = recordProducerStageOutcome(report, {
    stage: "qa", disposition: "ready", timestamp: "2026-10-05T00:00:00.000Z", command: "campaigns-os qa run",
    identity: { verdict_run_id: "qa-new" }, stamps: { source_brief_material: clone(BRIEF), source_spec_material_hash: SPEC }, inputs,
  });
  assert.equal(Object.hasOwn(updated.stages.qa, "input_change"), false, "the fresh verdict clears input_change");
  assert.equal(updated.stages.qa.history?.at(-1)?.reason_code, "brief_presentation_changed", "the superseded verdict is archived with the detected reason");
  assert.equal(assessStageCurrency("qa", updated.stages.qa, CURRENT).currency, "current");
});

test("a QA verdict stamped against earlier inputs records the detected input_change", () => {
  const report = { stages: { qa: { stage: "qa", status: "completed", verdict_run_id: "qa-old", source_brief_material: { presentation: fp("7"), qa_policy: fp("b") }, source_spec_material_hash: SPEC } } };
  const inputs = {
    detectChange: (record) => detectedStageChange("qa", record, { briefMaterial: BRIEF, specMaterial: SPEC }) ? "brief_presentation_changed" : null,
    stampsCurrent: () => false,
  };
  const updated = recordProducerStageOutcome(report, {
    stage: "qa", disposition: "ready", timestamp: "2026-10-05T00:00:00.000Z", identity: { verdict_run_id: "qa-new" },
    stamps: { source_brief_material: { presentation: fp("7"), qa_policy: fp("b") }, source_spec_material_hash: SPEC }, inputs,
  });
  assert.equal(updated.stages.qa.input_change?.reason, "brief_presentation_changed");
});
