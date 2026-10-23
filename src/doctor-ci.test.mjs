import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { assessEvidenceDebt } from "./evidence-debt.mjs";
import { doctorCommand } from "./doctor/inspect.mjs";
import { doctorCiFailure, formatDoctorCi } from "./doctor/ci.mjs";
import { openRunSession } from "./run-session.mjs";

const cli = new URL("../bin/campaigns-os.mjs", import.meta.url).pathname;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "doctor-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "_site", "synthetic-campaign");
  for (const page of ["landing", "checkout"]) {
    mkdirSync(join(output, page), { recursive: true });
    writeFileSync(join(output, page, "index.html"), `<main>${page} original</main>\n`);
  }
  const original = computeBuildFingerprint(output);
  assert.equal(original.ok, true);
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: "synthetic-campaign" },
    spec: { map_id: "synthetic-map", local_path: "missing-spec.json" },
    assembly: { target_repo: ".", output_dir: "src/synthetic-campaign" },
  };
  const packetPath = join(root, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  const report = { stages: {
    assembly: { status: "completed", build_fingerprint: original.fingerprint, build_manifest: buildManifestEntries(original) },
    polish: { status: "completed", source_build_fingerprint: original.fingerprint },
    qa: { status: "completed", evidence: { source_build_fingerprint: original.fingerprint } },
  } };
  mkdirSync(join(root, ".campaign-runtime"), { recursive: true });
  const reportPath = join(root, ".campaign-runtime", "assembly-report.json");
  const save = () => writeFileSync(reportPath, JSON.stringify(report));
  save();
  return { root, output, packet, packetPath, report, reportPath, save };
}

function run(f, ...flags) {
  const result = spawnSync(process.execPath, [cli, "doctor", "--packet", f.packetPath, "--no-live-refs", ...flags], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
  assert.equal(result.error, undefined);
  return result;
}

function jsonCi(f, expectedExit) {
  const result = run(f, "--ci", "--json");
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.ci, "--ci --json must add a ci object");
  assert.equal(payload.ci.exit_code, expectedExit);
  const { status, exit_code, ...debt } = payload.ci;
  assert.deepEqual(debt, assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report }));
  return payload;
}

test("doctor --ci matching evidence exits 0 despite unrelated spec errors", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.reportPath);
  const payload = jsonCi(f, 0);
  assert.equal(payload.ci.status, "current");
  assert.equal(payload.ci.polish.status, "current");
  assert.equal(payload.ci.qa.status, "current");
  assert.equal(payload.ok, false, "normal inspection still runs and reports unrelated errors");
  assert.ok(payload.errors.some((issue) => issue.code === "spec.local_path"));
  assert.deepEqual(readFileSync(f.reportPath), before, "CI inspection preserves recorded evidence");
  assert.match(run(f, "--ci").stdout, /spec\.local_path/);
});

test("doctor --ci page edited and rebuilt exits 3 and Markdown names page and remedy", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.output, "landing", "index.html"), "<main>landing revised</main>\n");
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.status, "owed");
  assert.equal(payload.ci.polish.status, "owed");
  assert.equal(payload.ci.qa.status, "owed");
  assert.deepEqual(payload.ci.changes.changed_pages, [{ page_id: "landing", built_path: "landing/index.html" }]);
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 3);
  assert.match(markdown.stdout, /^## Campaign evidence: owed \(exit 3\)/);
  assert.match(markdown.stdout, /Owed stages: polish, qa/);
  assert.match(markdown.stdout, /Changed page: `landing` \(`landing\/index\.html`\)/);
  assert.match(markdown.stdout, /polish capture/);
  assert.match(markdown.stdout, /record polish.*--evidence/);
  assert.match(markdown.stdout, /qa run/);
  t.diagnostic(`Observed page-edited stdout (exit ${markdown.status}):\n${markdown.stdout}`);
});

test("doctor --ci only QA bound to older build exits 3", (t) => {
  const f = fixture(t);
  f.report.stages.qa.evidence.source_build_fingerprint = "older-build";
  f.save();
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.status, "owed");
  assert.equal(payload.ci.polish.status, "current");
  assert.equal(payload.ci.qa.status, "owed");
  assert.deepEqual(payload.ci.changes.changed_pages, []);
});

test("doctor --ci rebuilt assembly cannot refresh older Polish/QA evidence", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.output, "landing", "index.html"), "<main>rebuilt</main>");
  const current = computeBuildFingerprint(f.output);
  f.report.stages.assembly.build_fingerprint = current.fingerprint;
  f.report.stages.assembly.build_manifest = buildManifestEntries(current);
  f.save();
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.polish.status, "owed");
  assert.equal(payload.ci.qa.status, "owed");
});

test("doctor --ci missing built output exits 4 and reports unknown reasons", (t) => {
  const f = fixture(t);
  rmSync(f.output, { recursive: true });
  const payload = jsonCi(f, 4);
  assert.equal(payload.ci.status, "unknown");
  assert.equal(payload.ci.polish.reason, "build_output_missing");
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 4);
  assert.match(markdown.stdout, /Unknown polish: `build_output_missing`/);
  assert.match(markdown.stdout, /Unknown qa: `build_output_missing`/);
});

for (const missing of ["manifest", "polish fingerprint", "qa fingerprint", "assembly fingerprint", "report"]) {
  test(`doctor --ci missing ${missing} exits 4`, (t) => {
    const f = fixture(t);
    if (missing === "manifest") delete f.report.stages.assembly.build_manifest;
    if (missing === "assembly fingerprint") delete f.report.stages.assembly.build_fingerprint;
    if (missing === "polish fingerprint") delete f.report.stages.polish.source_build_fingerprint;
    if (missing === "qa fingerprint") delete f.report.stages.qa.evidence.source_build_fingerprint;
    f.save();
    if (missing === "report") { rmSync(f.reportPath); f.report = null; }
    assert.equal(jsonCi(f, 4).ci.status, "unknown");
  });
}

test("doctor --ci any owed stage exits 3 even when another stage is unknown", (t) => {
  const f = fixture(t);
  delete f.report.stages.polish.source_build_fingerprint;
  f.report.stages.qa.evidence.source_build_fingerprint = "older-build";
  f.save();
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.status, "owed");
  assert.equal(payload.ci.polish.status, "unknown");
  assert.equal(payload.ci.qa.status, "owed");
});

test("ordinary doctor retains BASE exit and output for the same fixtures", (t) => {
  const f = fixture(t);
  for (const state of ["matching", "page changed", "qa old", "output absent"]) {
    if (state === "page changed") writeFileSync(join(f.output, "landing", "index.html"), "<main>changed</main>");
    if (state === "qa old") { f.report.stages.qa.evidence.source_build_fingerprint = "old"; f.save(); }
    if (state === "output absent") rmSync(f.output, { recursive: true });
    const ordinary = run(f, "--json");
    assert.equal(ordinary.status, 2, `${state}: BASE fixture has unrelated spec/setup errors`);
    const payload = JSON.parse(ordinary.stdout);
    assert.equal(Object.hasOwn(payload, "ci"), false);
    const ci = JSON.parse(run(f, "--ci", "--json").stdout);
    delete ci.ci;
    delete ci.generated_at;
    delete payload.generated_at;
    assert.deepEqual(ci, payload, `${state}: CI adds no changes to ordinary inspection fields`);
  }
});

test("doctor --ci packet usage errors exit 2", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--packet", join(f.root, "absent.json")], ["--packet", f.root]]) {
    const result = spawnSync(process.execPath, [cli, "doctor", "--ci", "--no-live-refs", "--json", ...args], { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).errors[0].code, "doctor.ci.packet");
    const markdown = spawnSync(process.execPath, [cli, "doctor", "--ci", "--no-live-refs", ...args], { cwd: f.root, encoding: "utf8" });
    assert.equal(markdown.status, 2);
    assert.match(markdown.stdout, /^## Campaign evidence: could not evaluate \(exit 2\)/);
  }
  writeFileSync(f.packetPath, "{ broken json");
  assert.equal(run(f, "--ci", "--json").status, 2);
});

test("doctor --ci catches inspection exceptions and prints an escaped unknown report", (t) => {
  const f = fixture(t);
  // Packet usage validation succeeds; an unreadable report throws later in
  // inspection, outside the packet preflight's catch.
  writeFileSync(f.reportPath, '![](//a.b)\n# PASS\n<img src=x>');
  const result = run(f, "--ci");
  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.match(result.stdout, /^## Campaign evidence: could not evaluate \(exit 4\)/);
  assert.equal(result.stderr, "");
  const json = JSON.parse(run(f, "--ci", "--json").stdout);
  assert.equal(json.exit_code, 4);
  assert.equal(json.errors[0].code, "doctor.ci.failed");
});

test("CI formatter escapes campaign text in every dynamic field and failure message", () => {
  const payload = '![](//a.b)\n# PASS\n[link](https://a.b)\n<img src=x>\n```\\`';
  for (const result of [
    doctorCiFailure(new Error(payload), { usage: true }),
    doctorCiFailure(new Error(payload)),
    { ci: { status: "owed", exit_code: 3, polish: { status: "unknown", reason: payload }, qa: { status: "owed" },
      changes: { status: "unknown", reason: payload, changed_pages: [{ page_id: payload, built_path: payload }] } },
      errors: [{ code: payload }], warnings: [] },
  ]) {
    const markdown = formatDoctorCi(result);
    assert.doesNotMatch(markdown, /!\[|\[[^\]\n]*\]\(|^# PASS|<img|```|https:\/\//m);
    assert.equal((markdown.match(/^## /gm) || []).length, 1);
    assert.match(markdown, /&#33;/, "the injected punctuation is encoded");
  }
});

test("doctor --ci formats session setup exceptions before dispatch without changing ordinary doctor", (t) => {
  const f = fixture(t);
  const payload = '![](//a.b)\n# PASS\n[link](https://a.b)\n<img src=x>';
  openRunSession(f.root, { runId: payload, packet: join(f.root, "other-packet.json") });
  const result = run(f, "--ci");
  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.match(result.stdout, /^## Campaign evidence: could not evaluate \(exit 4\)/);
  assert.match(result.stdout, /Conflicting active run session/);
  assert.doesNotMatch(result.stdout, /!\[|^# PASS|<img|https:\/\//m);
  assert.equal(result.stderr, "");
  const ordinary = run(f);
  assert.equal(ordinary.status, 1);
  assert.equal(ordinary.stdout, "");
  assert.match(ordinary.stderr, /Conflicting active run session/);
});

test("doctor --ci follows explicit report selection and context-bound reports", (t) => {
  const f = fixture(t);
  const alternate = join(f.root, "bound-report.json");
  writeFileSync(alternate, JSON.stringify(f.report));
  delete f.report.stages.qa.evidence.source_build_fingerprint;
  f.save();
  const explicit = JSON.parse(run(f, "--ci", "--json", "--report", alternate).stdout);
  assert.equal(explicit.ci.status, "current");
  writeFileSync(join(f.root, ".campaign-runtime", "build-context.json"), JSON.stringify({ report_path: "bound-report.json" }));
  const bound = JSON.parse(run(f, "--ci", "--json", "--strip-paths").stdout);
  assert.equal(bound.ci.status, "current");
});

test("ordinary doctorCommand preserves successful inspection result verbatim", (t) => {
  const f = fixture(t);
  const expected = { ok: true, status: "ready", errors: [], warnings: [], derived: {} };
  assert.equal(doctorCommand({ packet: f.packetPath }, { runDoctor: () => expected }), expected);
  assert.equal(Object.hasOwn(expected, "ci"), false);
  const ci = doctorCommand({ packet: f.packetPath, ci: true }, { runDoctor: () => ({ ...expected }) });
  assert.equal(ci.ci?.status, "current", "only --ci adds evidence debt to the successful inspection");
});
