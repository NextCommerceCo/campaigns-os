import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { assessEvidenceDebt } from "./evidence-debt.mjs";
import { doctorCommand } from "./doctor/inspect.mjs";
import { assessDoctorCi, doctorCiEvidenceLines, doctorCiFailure, formatDoctorCi } from "./doctor/ci.mjs";
import { openRunSession } from "./run-session.mjs";
import { recordStageCommand } from "./stage-record.mjs";
import { singleLineFragment } from "./text-safety.mjs";

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
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 0);
  assert.match(markdown.stdout, /spec\.local_path/);
  assert.match(markdown.stdout, /Owed stages: none\./);
  assert.doesNotMatch(markdown.stdout, /Remedy:/);
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
  assert.match(markdown.stdout, /Owed polish: the recorded build fingerprint differs from the current build\./);
  assert.match(markdown.stdout, /Owed qa: the recorded build fingerprint differs from the current build\./);
  assert.match(markdown.stdout, /Changed page: `landing` \(`landing\/index\.html`\)/);
  assert.match(markdown.stdout, /Remedy:/);
  assert.match(markdown.stdout, /polish capture/);
  assert.match(markdown.stdout, /record polish.*--evidence/);
  assert.match(markdown.stdout, /qa run/);
  const remedyCommands = [...markdown.stdout.split("\n").find((line) => line.startsWith("Remedy:")).matchAll(/`(campaigns-os [^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(remedyCommands, [
    "campaigns-os record build --packet <packet>",
    "campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>",
    "campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>",
    "campaigns-os qa run --packet <packet>",
  ], "the remedy must record the rebuilt output before capturing and recording new evidence");
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

for (const stage of ["qa", "polish"]) {
  test(`blocked ${stage} on the current build reads owed at full scope`, (t) => {
    const f = fixture(t);
    f.report.stages[stage].status = "blocked";
    f.save();
    const debt = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
    assert.equal(debt[stage].status, "owed");
    assert.equal(debt[stage].reason, "stage_blocked");
    assert.equal(debt[stage].matches_current_build, true);
    if (stage === "qa") {
      assert.equal(debt.qa.scope, "full");
      assert.deepEqual(debt.qa.owed_pages, []);
      assert.equal(debt.polish.status, "current");
    } else {
      assert.equal(debt.polish.advisory, false);
      assert.equal(debt.qa.status, "current");
    }
    const payload = jsonCi(f, 3);
    assert.equal(payload.ci.status, "owed");
    const markdown = formatDoctorCi(payload);
    assert.match(markdown, new RegExp(`Owed ${stage}: the last run on this build was blocked\\.`));
    const remedy = markdown.split("\n").find((line) => line.startsWith("Remedy:"));
    const commands = [...remedy.matchAll(/`(campaigns-os [^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual(commands, stage === "qa" ? ["campaigns-os qa run --packet <packet>"] : [
      "campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>",
      "campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>",
    ]);
    assert.doesNotMatch(remedy, /rebuild|record build/);
    assert.doesNotMatch(markdown, /record baseline/);
  });
}

test("blocked QA on an older build keeps fingerprint drift reason and full scope", (t) => {
  const f = fixture(t);
  const completed = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
  assert.equal(completed.qa.status, "current");
  assert.equal(completed.polish.status, "current");
  f.report.stages.qa.evidence.source_build_fingerprint = "older-build";
  const before = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
  f.report.stages.qa.status = "blocked";
  const after = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
  assert.equal(after.qa.status, "owed");
  assert.equal(after.qa.reason, "build_fingerprint_changed");
  assert.equal(after.qa.matches_current_build, false);
  assert.equal(after.qa.scope, "full");
  assert.equal(after.qa.scope, before.qa.scope);
});

test("blocked stages preserve unknown inputs and required stages keep their reason", (t) => {
  const f = fixture(t);
  const assess = (overrides = {}) => assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report, ...overrides });
  for (const stage of ["polish", "qa"]) f.report.stages[stage].status = "blocked";
  for (const overrides of [{ packet: null }, { packetPath: null }]) {
    const debt = assess(overrides);
    for (const stage of ["polish", "qa"]) {
      assert.equal(debt[stage].status, "unknown");
      assert.equal(debt[stage].reason, "packet_unavailable");
    }
  }
  const original = structuredClone(f.report);
  delete f.report.stages.polish.source_build_fingerprint;
  delete f.report.stages.qa.evidence.source_build_fingerprint;
  const missing = assess();
  for (const stage of ["polish", "qa"]) {
    assert.equal(missing[stage].status, "unknown");
    assert.equal(missing[stage].reason, "stage_build_fingerprint_missing");
    assert.equal(missing[stage].matches_current_build, null);
    Object.assign(f.report.stages[stage], { status: "required", required_by: "spec", blockers: ["Previous run blocked"] });
  }
  const required = assess();
  for (const stage of ["polish", "qa"]) {
    assert.equal(required[stage].status, "owed");
    assert.equal(required[stage].reason, "stage_required_by_spec");
  }
  f.report = original;
  delete f.report.stages.assembly.build_fingerprint;
  const noAssembly = assess();
  for (const stage of ["polish", "qa"]) {
    assert.equal(noAssembly[stage].status, "unknown");
    assert.equal(noAssembly[stage].reason, "assembly_build_fingerprint_missing");
    assert.equal(noAssembly[stage].matches_current_build, true);
  }
  rmSync(f.output, { recursive: true });
  const noBuild = assess();
  for (const stage of ["polish", "qa"]) {
    assert.equal(noBuild[stage].status, "unknown");
    assert.equal(noBuild[stage].reason, "build_output_missing");
  }
});

test("skipped Polish on the current build remains current", (t) => {
  const f = fixture(t);
  f.report.stages.polish.status = "skipped";
  const debt = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
  assert.equal(debt.polish.status, "current");
  assert.equal(debt.polish.reason, null);
  assert.equal(debt.polish.advisory, false);
  assert.equal(debt.qa.status, "current");
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

test("doctor --ci after record build reports required Polish and old QA as owed", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "missing-spec.json"), "{}");
  mkdirSync(join(f.root, "src", "synthetic-campaign"), { recursive: true });
  Object.assign(f.report, {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "synthetic-run", generated_at: "2026-10-23T00:00:00Z", status: "prepared",
    identity: { map_id: "synthetic-map", public_route_slug: "synthetic-campaign", campaign_directory: "synthetic-campaign", live_url_path: "/synthetic-campaign/", spec_hash: "synthetic-spec" },
    inputs: { packet_path: "campaign-runtime.build.json", context_path: ".campaign-runtime/build-context.json", spec_path: "missing-spec.json", source: { kind: "html_funnel", root: "source" }, target_repo: "." },
    template_family: { value: "olympus", locked: true },
    decisions: [], evidence: [], blockers: [], warnings: [],
    next: { stage: "build", owner: "build", action: "Record build" },
  });
  for (const key of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) {
    f.report.stages[key] = { stage: key, status: "completed", ...f.report.stages[key] };
  }
  f.save();
  const oldQa = structuredClone(f.report.stages.qa);
  writeFileSync(join(f.output, "landing", "index.html"), "<main>recorded revision</main>\n");
  recordStageCommand({ _: ["record", "build"], packet: f.packetPath });
  Object.assign(f.report, JSON.parse(readFileSync(f.reportPath, "utf8")));
  assert.equal(f.report.stages.polish.status, "required");
  assert.equal(f.report.stages.polish.required_by, "build");
  assert.equal(f.report.stages.polish.source_build_fingerprint, undefined);
  assert.deepEqual(f.report.stages.qa, oldQa);
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.polish.status, "owed");
  assert.equal(payload.ci.polish.reason, "stage_required_by_build");
  assert.equal(payload.ci.qa.status, "owed");
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 3);
  assert.match(markdown.stdout, /Owed stages: polish, qa/);
  assert.match(markdown.stdout, /Owed polish: the build requires this stage again\./);
  assert.doesNotMatch(markdown.stdout, /Unknown polish:/);
});

for (const [requiredBy, words] of [["build", "the build"], ["brief", "the brief"], ["spec", "the spec"], [undefined, "the lifecycle"]]) {
  for (const owed of [["polish"], ["qa"], ["polish", "qa"]]) {
    test(`doctor --ci matching ${owed.join(" and ")} required by ${requiredBy ?? "unknown source"} reuses the existing build`, (t) => {
      const f = fixture(t);
      for (const stage of owed) Object.assign(f.report.stages[stage], { status: "required", ...(requiredBy ? { required_by: requiredBy } : {}) });
      f.save();
      const payload = jsonCi(f, 3);
      for (const stage of owed) {
        assert.equal(payload.ci[stage].status, "owed");
        assert.equal(payload.ci[stage].matches_current_build, true);
      }
      const markdown = run(f, "--ci");
      assert.equal(markdown.status, 3);
      for (const stage of owed) assert.ok(markdown.stdout.includes(`Owed ${stage}: ${words} requires this stage again.`));
      const remedy = markdown.stdout.split("Remedy:")[1];
      assert.match(remedy, /re-run the required stages against the existing build/);
      assert.doesNotMatch(remedy, /rebuild|record build/);
      const commands = [...remedy.matchAll(/`(campaigns-os [^`]+)`/g)].map((match) => match[1]);
      assert.deepEqual(commands, [
        ...(owed.includes("polish") ? [
          "campaigns-os polish capture --packet <packet> --base-url <served-current-build-url>",
          "campaigns-os record polish --packet <packet> --evidence <polish-evidence.json>",
        ] : []),
        ...(owed.includes("qa") ? ["campaigns-os qa run --packet <packet>"] : []),
      ]);
    });
  }
}

test("doctor --ci fingerprint drift still requires recording the build alongside matching lifecycle debt", (t) => {
  const f = fixture(t);
  Object.assign(f.report.stages.polish, { status: "required", required_by: "brief" });
  f.report.stages.qa.evidence.source_build_fingerprint = "older-build";
  f.save();
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 3);
  assert.match(markdown.stdout, /Owed polish: the brief requires this stage again\./);
  assert.match(markdown.stdout, /Owed qa: the recorded build fingerprint differs from the current build\./);
  assert.match(markdown.stdout, /Remedy: rebuild, then run `campaigns-os record build/);
});

test("doctor --ci recorded handed-off funnel without built output is unknown, never current", (t) => {
  const f = fixture(t);
  f.report.stages.deploy = { status: "completed", source_build_fingerprint: f.report.stages.assembly.build_fingerprint };
  f.save();
  assert.equal(jsonCi(f, 0).ci.status, "current", "the handed-off funnel starts with matching evidence");
  rmSync(f.output, { recursive: true });
  const payload = jsonCi(f, 4);
  assert.equal(payload.ci.status, "unknown");
  for (const stage of ["polish", "qa"]) {
    assert.equal(payload.ci[stage].status, "unknown");
    assert.equal(payload.ci[stage].reason, "build_output_missing");
  }
  assert.equal(payload.ci.changes.reason, "build_output_missing");
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 4);
  assert.doesNotMatch(markdown.stdout, /Campaign evidence: current/);
  assert.match(markdown.stdout, /Unknown polish: `build_output_missing`/);
  assert.match(markdown.stdout, /Unknown qa: `build_output_missing`/);
  assert.match(markdown.stdout, /Remedy:/);
});

for (const [reason, sentence] of [
  ["packet_unavailable", "the build packet or its path is unavailable."],
  ["build_output_location_unknown", "the built output location cannot be determined."],
  ["build_output_missing", "the built output is missing."],
  ["build_output_unreadable", "the built output could not be read."],
  ["assembly_build_fingerprint_missing", "the assembly build fingerprint is missing."],
  ["build_output_pages_unresolved", "the built output could not be mapped to pages."],
  ["build_manifest_unavailable", "no usable assembly manifest is available."],
]) {
  test(`CI Markdown explains unknown page changes: ${reason}`, () => {
    for (const status of ["unknown", "owed"]) {
      const markdown = formatDoctorCi({ ci: {
        status, exit_code: status === "owed" ? 3 : 4,
        polish: { status, reason }, qa: { status, reason },
        changes: { status: "unknown", reason, changed_pages: [] },
      } });
      assert.equal(markdown.split("\n").find((line) => line.startsWith("Changed pages unavailable:")),
        `Changed pages unavailable: ${sentence}`);
      assert.ok(markdown.includes(`Unknown page changes: \`${reason}\``));
    }
  });
}

test("doctor --ci assets-only output with a valid manifest explains unresolved pages", (t) => {
  const f = fixture(t);
  rmSync(f.output, { recursive: true });
  mkdirSync(f.output, { recursive: true });
  writeFileSync(join(f.output, "styles.css"), "body { color: blue; }\n");
  const payload = jsonCi(f, 3);
  assert.equal(payload.ci.changes.reason, "build_output_pages_unresolved");
  assert.ok(payload.ci.changes.missing.includes("landing/index.html"), "the retained manifest is usable");
  const markdown = run(f, "--ci");
  assert.equal(markdown.status, 3);
  assert.match(markdown.stdout, /Changed pages unavailable: the built output could not be mapped to pages\./);
  assert.doesNotMatch(markdown.stdout, /no usable assembly manifest is available/);
});

for (const changed of [false, true]) {
  test(`doctor --ci legacy report without a manifest ${changed ? "owes both stages and exits 3" : "has current bindings and exits 0"}`, (t) => {
    const f = fixture(t);
    delete f.report.stages.assembly.build_manifest;
    f.save();
    if (changed) writeFileSync(join(f.output, "landing", "index.html"), "<main>legacy campaign revised</main>\n");
    const exit = changed ? 3 : 0;
    const status = changed ? "owed" : "current";
    const payload = jsonCi(f, exit);
    assert.equal(payload.ci.status, status);
    for (const name of ["polish", "qa"]) {
      assert.equal(payload.ci[name].status, status);
      assert.equal(payload.ci[name].matches_current_build, !changed);
      assert.equal(payload.ci[name].reason, changed ? "build_fingerprint_changed" : null);
    }
    assert.equal(payload.ci.changes.status, "unknown");
    assert.equal(payload.ci.changes.reason, "build_manifest_unavailable");
    const markdown = run(f, "--ci");
    assert.equal(markdown.status, exit);
    assert.match(markdown.stdout, changed ? /Owed stages: polish, qa\./ : /Owed stages: none\./);
    assert.match(markdown.stdout, /Unknown page changes: `build_manifest_unavailable`/);
    if (changed) assert.match(markdown.stdout, /Changed pages unavailable:/);
  });
}

for (const missing of ["polish fingerprint", "qa fingerprint", "assembly fingerprint", "report"]) {
  test(`doctor --ci missing ${missing} exits 4`, (t) => {
    const f = fixture(t);
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
  // A flag refused up front is a usage error too, never "evidence unknown".
  const joined = spawnSync(process.execPath, [cli, "doctor", "--ci", "--no-live-refs", "--json", `--packet=${f.packetPath}`], { cwd: f.root, encoding: "utf8" });
  assert.equal(joined.status, 2, joined.stderr || joined.stdout);
  assert.equal(JSON.parse(joined.stdout).errors[0].code, "doctor.ci.usage");
  const joinedMarkdown = spawnSync(process.execPath, [cli, "doctor", "--ci", "--no-live-refs", `--packet=${f.packetPath}`], { cwd: f.root, encoding: "utf8" });
  assert.match(joinedMarkdown.stdout, /Remedy: correct the command's flags/);
  assert.doesNotMatch(joinedMarkdown.stdout, /correct the packet/);
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
  const ci = doctorCommand({ packet: f.packetPath, ci: true }, { runDoctor: (packetPath, options) => {
    options.onEvidenceDebt(assessEvidenceDebt({ packet: f.packet, packetPath, report: f.report }));
    return { ...expected };
  } });
  assert.equal(ci.ci?.status, "current", "only --ci adds evidence debt to the successful inspection");
});

test("doctor --ci reads the evidence debt inspection assessed instead of assessing it again", (t) => {
  const f = fixture(t);
  const expected = { ok: true, status: "ready", errors: [], warnings: [], derived: {} };
  const inspected = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report: f.report });
  assert.equal(inspected.qa.status, "current");
  const owed = { ...inspected, qa: { ...inspected.qa, status: "owed" } };
  const ci = doctorCommand({ packet: f.packetPath, ci: true }, { runDoctor: (packetPath, options) => {
    options.onEvidenceDebt(owed);
    return { ...expected };
  } });
  assert.equal(ci.ci.status, "owed");
  assert.equal(ci.ci.qa, owed.qa);
});

// A funnel recorded before 1.62 whose rebuild `record build` has recorded.
function legacyCi(qa = {}, changes = {}) {
  const stage = { status: "owed", scope: "full", reason: "build_fingerprint_changed",
    change: { kind: "commerce_affecting", reasons: [{ code: "commerce_signature_unavailable" }] } };
  const build = "b".repeat(64);
  return assessDoctorCi({ polish: stage, qa: { ...stage, ...qa },
    changes: { status: "known", changed_pages: [], recorded_build_fingerprint: build, current_build_fingerprint: build, ...changes } });
}

test("baseline sign-off line follows the unchanged rebuild remedy only for legacy full QA debt", () => {
  for (const reason of ["build_fingerprint_changed", "stage_required_by_build"]) {
    const ci = legacyCi({ reason });
    assert.equal(Object.hasOwn(ci, "remedy"), false);
    const lines = formatDoctorCi({ ci }).split("\n");
    const index = lines.findIndex((line) => line.startsWith("Remedy:"));
    assert.match(lines[index], /^Remedy: rebuild, then run/);
    assert.equal(lines[index + 1], "This funnel was recorded before Campaigns OS 1.62, so instead of re-running the stages a named person can sign off to accept the current build as the starting point with `campaigns-os record baseline --packet <packet> --accepted-by <person> --reason <why>`; this tests nothing and needs a completed QA on record.");
  }
});

test("Polish owed, QA current offers no baseline line", () => {
  assert.doesNotMatch(formatDoctorCi({ ci: legacyCi({ status: "current" }) }), /record baseline/);
});

test("baseline sign-off waits for record build, which record baseline needs first", () => {
  for (const changes of [{ current_build_fingerprint: "c".repeat(64) }, { recorded_build_fingerprint: null }]) {
    const text = formatDoctorCi({ ci: legacyCi({}, changes) });
    assert.match(text, /^Remedy: rebuild, then run `campaigns-os record build/m);
    assert.doesNotMatch(text, /record baseline/, JSON.stringify(changes));
  }
});

test("a page-only change with an advisory Polish does not call an unknown QA current", () => {
  const polish = { status: "owed", advisory: true, reason: "stage_required_by_build", change: { kind: "page_only", reasons: [], changed_pages: [{ page_id: "landing" }] } };
  const changes = { status: "known", changed_pages: [] };
  const unknown = formatDoctorCi({ ci: assessDoctorCi({ polish, qa: { status: "unknown", reason: "stage_build_fingerprint_missing" }, changes }) });
  assert.match(unknown, /^Change found: page-only\. QA is unknown; Polish is advisory\.$/m);
  const current = formatDoctorCi({ ci: assessDoctorCi({ polish, qa: { status: "current" }, changes }) });
  assert.match(current, /^Change found: page-only\. QA is current; Polish is advisory\.$/m);
});

test("a blank page id never prints as its list position", () => {
  const ci = legacyCi({ browser_pages: ["", "checkout"] });
  const lines = doctorCiEvidenceLines(ci, singleLineFragment);
  assert.ok(lines.some((line) => line.includes("in a browser on")), "setup: the browser pages are listed");
  assert.doesNotMatch(lines.join("\n"), /in a browser on 0\b/);
});

test("legacy browser remedy keeps the required --browser flag", () => {
  const lines = formatDoctorCi({ ci: legacyCi({ browser_pages: ["checkout"] }) }).split("\n");
  assert.match(lines.find((line) => line.startsWith("Remedy:")), /`campaigns-os qa run --packet <packet> --browser`/);
});

test("baseline sign-off excludes page QA, unknown QA, input changes, and mixed or malformed reasons", () => {
  for (const qa of [
    { scope: "pages", owed_pages: [{ page_id: "landing" }] },
    { status: "unknown" },
    { reason: "stage_required_by_brief" },
    { reason: "stage_required_by_spec" },
    { reason: "stage_blocked" },
    { change: { reasons: [] } },
    { change: { reasons: [{ code: "commerce_signature_unavailable", path: "checkout/index.html" }] } },
    ...[{ code: "checkout_page" }, null, "commerce_signature_unavailable"].map((other) => ({
      change: { reasons: [{ code: "commerce_signature_unavailable" }, other] },
    })),
  ]) {
    assert.doesNotMatch(formatDoctorCi({ ci: legacyCi(qa) }), /record baseline/, JSON.stringify(qa));
  }
});
