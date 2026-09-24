import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeBuildFingerprint } from "./built-site-scope.mjs";
import {
  annotateDoctorIssueCauses,
  annotateQaAssertionCauses,
  CAUSE_CLASSES,
  findPriorRunRecord,
  loadPriorQaVerdict,
} from "./finding-cause.mjs";
import {
  assertPolishCaptureBindingUnchanged,
  createPolishCaptureBinding,
  planPolishCapture,
} from "./polish-node.mjs";
import { isFindingAssertion } from "./qa-verdict.mjs";

const LOCAL_ID = "local-campaign-a";
const OTHER_LOCAL_ID = "local-campaign-b";
const ROUTE = "shared-route";
const PRIOR_RUN = "run_1757000000000_aaaaaaaa";
const OTHER_RUN = "run_1757000001000_bbbbbbbb";
const CURRENT_RUN = "run_1757000002000_cccccccc";
const SAVED_MAP_RUN = "run_1757000003000_dddddddd";

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "campaigns-os-local-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function polishFixture(t) {
  const targetRepo = scratch(t);
  const outputRoot = join(targetRepo, "_site", ROUTE);
  mkdirSync(join(outputRoot, "landing"), { recursive: true });
  writeFileSync(join(outputRoot, "landing", "index.html"), "<html><body>Local campaign</body></html>");
  const fingerprint = computeBuildFingerprint(outputRoot).fingerprint;
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: ROUTE, route_root: `/${ROUTE}/` },
    spec: { map_id: null, local_spec_id: LOCAL_ID },
    assembly: { target_repo: "." },
    source_html: {
      pages: [{
        page_id: "landing",
        path: "landing.html",
        page_kit: { public_route: `/${ROUTE}/landing/`, spec_route: "landing/" },
      }],
    },
  };
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "asm_local",
    identity: {
      map_id: null,
      local_spec_id: LOCAL_ID,
      public_route_slug: ROUTE,
      spec_hash: `sha256:${"b".repeat(64)}`,
      spec_material_hash: `sha256:${"c".repeat(64)}`,
    },
    inputs: { packet_path: "campaign-runtime.build.json" },
    stages: {
      assembly: { stage: "assembly", status: "completed", build_fingerprint: fingerprint },
      polish: { stage: "polish", status: "pending" },
    },
  };
  return {
    packet,
    report,
    plan: planPolishCapture({ packet, baseUrl: "http://127.0.0.1:4173" }),
    packetPath: join(targetRepo, "campaign-runtime.build.json"),
    targetRepo,
  };
}

test("local polish capture binds the explicit identity and the real built output", t => {
  const fixture = polishFixture(t);
  const binding = createPolishCaptureBinding(fixture);
  assert.equal(binding.packet.map_id, null);
  assert.equal(binding.packet.local_spec_id, LOCAL_ID);
  assert.equal(binding.report.identity.map_id, null);
  assert.equal(binding.report.identity.local_spec_id, LOCAL_ID);
  assert.equal(binding.report.assembly.output_fingerprint, fixture.report.stages.assembly.build_fingerprint);
  assert.doesNotThrow(() => assertPolishCaptureBindingUnchanged(binding, createPolishCaptureBinding(fixture)));
});

for (const [description, identity] of [
  ["another local campaign on the same route", { map_id: null, local_spec_id: OTHER_LOCAL_ID }],
  ["a saved Map with the same ID text", { map_id: LOCAL_ID }],
]) {
  test(`local polish capture refuses ${description}`, t => {
    const fixture = polishFixture(t);
    fixture.report.identity = { public_route_slug: ROUTE, ...identity };
    assert.throws(() => createPolishCaptureBinding(fixture), /matching packet and Assembly Report campaign identities/);
  });
}

test("changing both local identities during capture still refuses attachment of earlier proof", t => {
  const fixture = polishFixture(t);
  const initial = createPolishCaptureBinding(fixture);
  fixture.packet.spec.local_spec_id = OTHER_LOCAL_ID;
  fixture.report.identity.local_spec_id = OTHER_LOCAL_ID;
  const current = createPolishCaptureBinding(fixture);
  assert.throws(() => assertPolishCaptureBindingUnchanged(initial, current), /governing packet\/report state/);
});

function finding(page) {
  return { id: `http:${page}`, family: "funnel-flow", page, status: "fail", severity: "blocker" };
}

function writePriorRun(baseDir, {
  runId,
  localSpecId = null,
  mapId = null,
  page = "landing",
  errorCode = "built_output.page_missing",
  external = false,
}) {
  const identifier = localSpecId ? `local-spec-${localSpecId}` : mapId;
  const targetRepo = external ? join(baseDir, "target") : baseDir;
  const verdictRel = `qa-output/${identifier}/qa_${runId}.json`;
  const verdictPath = join(targetRepo, verdictRel);
  const verdict = {
    schema_version: "1.0",
    run_id: `qa_${runId}`,
    campaign_slug: identifier,
    ...(localSpecId ? { local_spec_id: localSpecId } : {}),
    public_route_slug: ROUTE,
    assertions: [finding(page)],
  };
  const sha256 = writeJson(verdictPath, verdict);
  writeJson(join(baseDir, ".campaign-runtime", "run-records", `${runId}.json`), {
    schema_version: "campaigns-os-run-record/v0",
    run_id: runId,
    identity: { map_id: mapId, ...(localSpecId ? { local_spec_id: localSpecId } : {}), campaign_slug: ROUTE },
    artifacts: [{ kind: "qa_verdict", path: external ? "external:qa_verdict" : `./${verdictRel}`, schema_version: "1.0", sha256 }],
    observations: { doctor: { status: "blocked", error_codes: [errorCode], warning_codes: [], ready_count: 0 } },
  });
  return { targetRepo, verdictPath };
}

for (const external of [false, true]) {
  test(`local QA and doctor causes ignore newer foreign identities with ${external ? "external" : "relative"} verdict references`, t => {
    const baseDir = scratch(t);
    const { targetRepo, verdictPath } = writePriorRun(baseDir, { runId: PRIOR_RUN, localSpecId: LOCAL_ID, external });
    writePriorRun(baseDir, { runId: OTHER_RUN, localSpecId: OTHER_LOCAL_ID, page: "checkout", errorCode: "checkout.unknown_field_binding", external });
    writePriorRun(baseDir, { runId: CURRENT_RUN, localSpecId: LOCAL_ID, page: "checkout", errorCode: "checkout.unknown_field_binding", external });
    writePriorRun(baseDir, { runId: SAVED_MAP_RUN, mapId: LOCAL_ID, page: "checkout", errorCode: "checkout.unknown_field_binding", external });
    const options = { baseDir, targetRepo, localSpecId: LOCAL_ID, currentRunId: CURRENT_RUN };

    assert.equal(findPriorRunRecord(options).run_id, PRIOR_RUN);
    assert.equal(findPriorRunRecord({ ...options, localSpecId: OTHER_LOCAL_ID }).run_id, OTHER_RUN);
    const lookup = loadPriorQaVerdict(options);
    assert.equal(lookup.reason, null);
    assert.equal(lookup.path, verdictPath);
    assert.equal(lookup.verdict.local_spec_id, LOCAL_ID);

    const assertions = [finding("landing"), finding("checkout")];
    const qa = annotateQaAssertionCauses(assertions, { ...options, isFinding: isFindingAssertion });
    assert.equal(qa.prior_run_id, PRIOR_RUN);
    assert.equal(qa.prior_qa_attempt_run_id, `qa_${PRIOR_RUN}`);
    assert.equal(assertions[0].cause, CAUSE_CLASSES.PRE_EXISTING);
    assert.equal(assertions[1].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);

    const errors = [{ code: "built_output.page_missing" }, { code: "checkout.unknown_field_binding" }];
    const doctor = annotateDoctorIssueCauses({ ...options, errors });
    assert.equal(doctor.prior_run_id, PRIOR_RUN);
    assert.equal(errors[0].cause, CAUSE_CLASSES.PRE_EXISTING);
    assert.equal(errors[1].cause, CAUSE_CLASSES.CAUSED_BY_CHANGE);
  });
}

test("a local campaign with only foreign history has no prior-run comparison", t => {
  const baseDir = scratch(t);
  writePriorRun(baseDir, { runId: OTHER_RUN, localSpecId: OTHER_LOCAL_ID });
  writePriorRun(baseDir, { runId: SAVED_MAP_RUN, mapId: LOCAL_ID });
  const options = { baseDir, localSpecId: LOCAL_ID };
  assert.equal(findPriorRunRecord(options), null);
  const assertions = [finding("landing")];
  const qa = annotateQaAssertionCauses(assertions, { ...options, isFinding: isFindingAssertion });
  assert.equal(qa.comparison, "no_prior_run");
  assert.equal(assertions[0].cause, CAUSE_CLASSES.UNKNOWN);
  const errors = [{ code: "built_output.page_missing" }];
  const doctor = annotateDoctorIssueCauses({ ...options, errors });
  assert.equal(doctor.comparison, "no_prior_run");
  assert.equal(errors[0].cause, CAUSE_CLASSES.UNKNOWN);
});
