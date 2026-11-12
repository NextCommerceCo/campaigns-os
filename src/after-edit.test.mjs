import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { afterEditCommand, afterEditExitCode, afterEditTextLines } from "./after-edit.mjs";
import { specFetchCommand, specDeriveWithMapWriteback, specDeriveTextLines } from "./cli.mjs";
import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { recordCommand } from "./stage-record.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import { PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND } from "./page-kit-build-summary.mjs";
import { treeDigest, withNetworkGuard } from "./input-test-factories.mjs";
import { doctorCommand } from "./doctor/inspect.mjs";
import { formatDoctorCi } from "./doctor/ci.mjs";
import { openRunSession } from "./run-session.mjs";

const CLI = new URL("../bin/campaigns-os.mjs", import.meta.url).pathname;
const SLUG = "synthetic-campaign";
const PAGES = {
  landing: '<html><head><meta name="next-page-type" content="product"></head><body><h1>Example headline</h1><a href="../checkout/">Order</a></body></html>',
  checkout: '<html><head><meta name="next-page-type" content="checkout"></head><body><form data-next-checkout="form"><button type="submit">Pay</button></form></body></html>',
  upsell: '<html><head><meta name="next-page-type" content="upsell"></head><body><h1>Example offer</h1><div data-next-package-id="12"><button data-next-upsell-action="add">Yes</button></div></body></html>',
  receipt: '<html><head><meta name="next-page-type" content="receipt"></head><body>Thank you</body></html>',
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
function write(path, body) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
const writeJson = (path, body) => write(path, `${JSON.stringify(body, null, 2)}\n`);

async function fixture(t, { savedMap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "after-edit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "_site", SLUG);
  const packetPath = join(root, "campaign-runtime.build.json");
  const reportPath = join(root, ".campaign-runtime", "assembly-report.json");
  const contextPath = join(root, ".campaign-runtime", "build-context.json");
  const specPath = savedMap ? join(root, ".campaign-runtime", "fetched-specs", "synthetic-map.json") : join(root, "campaign-spec.json");
  const spec = {
    schema_version: "4.3", spec_identity: { map_id: "synthetic-map", public_route_slug: SLUG },
    campaign: { slug: SLUG, name: "Synthetic campaign" }, global_config: { sdk_version: "0.4.40" },
    funnels: [{ id: "main", pages: Object.keys(PAGES).map((id, index) => ({ id, type: id === "receipt" ? "thankyou" : id, page_url: `${id}/`, order: index + 1 })) }],
  };
  writeJson(specPath, spec);
  writeJson(packetPath, {
    schema_version: "campaign-runtime-build-packet/v0", campaign: { public_route_slug: SLUG },
    spec: { map_id: "synthetic-map", local_path: savedMap ? ".campaign-runtime/fetched-specs/synthetic-map.json" : "campaign-spec.json" },
    assembly: { target_repo: ".", output_dir: `src/${SLUG}` },
  });
  writeJson(join(root, "_data", "campaigns.json"), { [SLUG]: { sdk_version: "0.4.40", store_name: "Synthetic Store" } });
  const page = (id, html) => {
    write(join(root, "src", SLUG, `${id}.html`), `---\npage_type: ${id === "landing" || !(id in PAGES) ? "product" : id}\n---\n${html}`);
    write(join(output, id, "index.html"), html);
    // Deterministic ordering on filesystems with coarse timestamp precision.
    utimesSync(join(root, "src", SLUG, `${id}.html`), 1_000, 1_000);
    utimesSync(join(output, id, "index.html"), 2_000, 2_000);
  };
  for (const [id, html] of Object.entries(PAGES)) page(id, html);
  utimesSync(join(root, "_data", "campaigns.json"), 1_000, 1_000);
  const original = computeBuildFingerprint(output);
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0", run_id: "synthetic-run", generated_at: "2026-11-01T00:00:00Z", status: "prepared",
    identity: { map_id: "synthetic-map", public_route_slug: SLUG, campaign_directory: SLUG, live_url_path: `/${SLUG}/`, spec_hash: createHash("sha256").update(readFileSync(specPath)).digest("hex"), spec_material_hash: specMaterialHash(spec) },
    inputs: { packet_path: "campaign-runtime.build.json", context_path: ".campaign-runtime/build-context.json", spec_path: savedMap ? ".campaign-runtime/fetched-specs/synthetic-map.json" : "campaign-spec.json", source: { kind: "html_funnel", root: "source" }, target_repo: "." },
    template_family: { value: "olympus", locked: true }, decisions: [], evidence: [], blockers: [], warnings: [],
    next: { stage: "build", owner: "build", action: "Record build" }, stages: {},
  };
  for (const stage of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) report.stages[stage] = { stage, status: "completed" };
  Object.assign(report.stages.assembly, { build_fingerprint: original.fingerprint, build_manifest: buildManifestEntries(original) });
  Object.assign(report.stages.polish, { source_build_fingerprint: original.fingerprint });
  Object.assign(report.stages.qa, { evidence: { qc_build_fingerprint: original.fingerprint, qc_results: [] }, purchase_proof: { order_paths_executed: 3, declared_depth: "common" } });
  writeJson(reportPath, report);
  writeJson(contextPath, { spec: { active_pages: spec.funnels[0].pages }, page_map: [], scaffold: { required: false } });
  await recordCommand({ _: ["record", "build"], packet: packetPath });
  return { root, output, packetPath, reportPath, contextPath, specPath, spec, page };
}

const run = (f, flags = {}, options = {}) => afterEditCommand({ _: ["after-edit"], packet: f.packetPath, "no-live-refs": true, ...flags }, {
  specFetch: specFetchCommand, specDerive: specDeriveWithMapWriteback, specDeriveTextLines, ...options,
});
const step = (result, name) => result.steps.find((row) => row.step === name);
const output = (t, label, result) => t.diagnostic(`${label}\n${afterEditTextLines(result).join("\n")}`);

test("page-only copy edit records the rebuilt output and owes QA on that page (a)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  f.page("upsell", PAGES.upsell.replace("Example offer", "Revised offer"));
  const result = await run(f);
  assert.equal(result.stopped_at, null);
  assert.equal(afterEditExitCode(result), 3);
  assert.equal(step(result, "record_build").status, "done");
  assert.equal(step(result, "spec_derive").status, "not_needed");
  assert.equal(json(f.reportPath).stages.assembly.build_fingerprint, computeBuildFingerprint(f.output).fingerprint);
  assert.deepEqual(result.files, [".campaign-runtime/assembly-report.json"]);
  assert.equal(result.ci.qa.scope, "pages");
  assert.deepEqual(result.ci.qa.owed_pages.map((page) => page.page_id), ["upsell"]);
  assert.equal(step(result, "spec_derive").detail, "Spec is current.");
  assert.equal(step(result, "record_build").detail, [
    `Recorded the build (${result.ci.changes.current_build_fingerprint.slice(7, 19)}).`,
    "stages.assembly.build_changes: this rebuild is page-only (changed pages: upsell)",
  ].join("\n"));
  const doctor = doctorCommand({ _: ["doctor"], packet: f.packetPath, ci: true, "no-live-refs": true });
  assert.deepEqual(result.ci, doctor.ci);
  assert.equal(step(result, "owed").detail, formatDoctorCi(doctor));
  const lines = afterEditTextLines(result);
  assert.deepEqual(lines.slice(0, 4).map((line) => line.split(":")[0]), ["Spec copy", "Build", "Record build", "Spec"]);
  assert.equal(lines[4], `Owed:\n${formatDoctorCi(doctor)}`);
  assert.equal(lines[5], "Files to commit:\n- .campaign-runtime/assembly-report.json");
  assert.match(result.next, /qa run .* --page upsell$/);
  output(t, "CASE (a)", result);
}));

test("unchanged recorded funnel writes nothing, every step is not_needed (b)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  const before = treeDigest(f.root);
  const result = await run(f);
  assert.equal(afterEditExitCode(result), 0);
  assert.ok(result.steps.every((row) => row.status === "not_needed"));
  assert.deepEqual(result.files, []);
  assert.equal(result.next, null);
  assert.deepEqual(treeDigest(f.root), before);
}));

test("newer source stops before record build and names the build command (c)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  const source = join(f.root, "src", SLUG, "upsell.html");
  utimesSync(source, 3_000, 3_000);
  const before = treeDigest(f.root);
  const result = await run(f);
  assert.equal(afterEditExitCode(result), 2);
  assert.equal(result.stopped_at, "build_current");
  assert.match(step(result, "build_current").detail, /src\/synthetic-campaign\/upsell.html is newer/);
  assert.equal(result.next, PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND);
  assert.equal(step(result, "record_build").status, "not_run");
  assert.deepEqual(treeDigest(f.root), before);
  output(t, "CASE (c)", result);
}));

test("missing _site stops before records (d)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  rmSync(join(f.root, "_site"), { recursive: true });
  const before = treeDigest(f.root);
  const result = await run(f);
  assert.equal(afterEditExitCode(result), 2);
  assert.equal(result.stopped_at, "build_current");
  assert.equal(result.next, PAGE_KIT_BUILD_SUMMARY_CAPTURE_COMMAND);
  assert.deepEqual(treeDigest(f.root), before);
}));

test("new page previews without yes, then writes and records spec with yes (e)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  f.page("extra", '<html><head><meta name="next-page-type" content="product"></head><body>Extra</body></html>');
  const before = readFileSync(f.specPath, "utf8");
  const preview = await run(f);
  assert.equal(afterEditExitCode(preview), 2);
  assert.equal(preview.stopped_at, "spec_derive");
  assert.match(step(preview, "spec_derive").detail, /Pages added from the page tree: extra/);
  assert.match(preview.next, /after-edit .* --yes$/);
  assert.equal(readFileSync(f.specPath, "utf8"), before);
  assert.equal(step(preview, "owed").status, "not_run");
  output(t, "CASE (e without --yes)", preview);
  const applied = await run(f, { yes: true });
  assert.equal(applied.stopped_at, null, afterEditTextLines(applied).join("\n"));
  assert.equal(afterEditExitCode(applied), 3);
  assert.ok(json(f.specPath).funnels[0].pages.some((page) => page.id === "extra"));
  assert.equal(json(f.reportPath).identity.spec_material_hash, specMaterialHash(json(f.specPath)));
  assert.ok(json(f.contextPath).spec.active_pages.some((page) => page.id === "extra"));
  assert.ok(applied.files.includes("campaign-spec.json"));
  assert.ok(applied.files.includes("campaign-runtime.build.json"));
  assert.ok(applied.files.includes(".campaign-runtime/build-context.json"));
  assert.match(step(applied, "spec_derive").detail, /record spec: Bound/);
}));

test("package edit owes full Polish and QA with no network or orders (f)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  f.page("upsell", PAGES.upsell.replace('data-next-package-id="12"', 'data-next-package-id="13"'));
  const result = await run(f);
  assert.equal(afterEditExitCode(result), 3);
  assert.equal(result.stopped_at, null);
  assert.equal(result.ci.qa.scope, "full");
  assert.equal(result.ci.polish.advisory, false);
  assert.equal(result.ci.polish.status, "owed");
  assert.deepEqual(json(f.reportPath).stages.qa.purchase_proof, { order_paths_executed: 3, declared_depth: "common" });
  assert.match(afterEditTextLines(result).join("\n"), /It owes the full Polish and QA/);
  output(t, "CASE (f)", result);
}));

test("missing saved-Map spec is restored using standalone fetch and listed (g)", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t, { savedMap: true });
  rmSync(f.specPath);
  const requests = [];
  const result = await run(f, { "proxy-base": "https://proxy.example.invalid" }, { fetchImpl: async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => ({ ok: true, data: f.spec }) };
  } });
  assert.equal(result.stopped_at, null, afterEditTextLines(result).join("\n"));
  assert.equal(step(result, "spec").status, "done");
  assert.deepEqual(requests, ["https://proxy.example.invalid/api/spec/synthetic-map"]);
  assert.ok(result.files.includes(".campaign-runtime/fetched-specs/synthetic-map.json"));
  assert.deepEqual(json(f.specPath), f.spec);
}));

test("unknown flags and no-write refuse before packet read (h)", async () => withNetworkGuard(async () => {
  const noReads = { specFetch: () => assert.fail("fetch must not run"), specDerive: () => assert.fail("derive must not run") };
  await assert.rejects(afterEditCommand({ _: ["after-edit"], packet: "/not-a-packet", mystery: true }, noReads), /Unknown flag.*--mystery.*Known flags/);
  await assert.rejects(afterEditCommand({ _: ["after-edit"], packet: "/not-a-packet", "no-write": true }, noReads), /writes records.*doctor --ci.*read-only/);
  for (const flags of [["--mystery"], ["--no-write"], ["--run-qa"], ["--packet=missing"]]) {
    const result = spawnSync(process.execPath, [CLI, "after-edit", ...flags], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /ENOENT|Missing required --packet/);
  }
}));

test("CLI JSON prints one result and preserves owed and current exit codes", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  for (const [edit, code] of [[false, 0], [true, 3]]) {
    if (edit) f.page("upsell", PAGES.upsell.replace("Example offer", "Updated offer"));
    const child = spawnSync(process.execPath, [CLI, "after-edit", "--packet", f.packetPath, "--no-live-refs", "--json"], { encoding: "utf8" });
    assert.equal(child.status, code, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.action, "after-edit");
    assert.equal(result.ci.exit_code, code);
    assert.ok(["current", "owed", "unknown"].includes(result.ci.status));
    assert.equal(result.ci.errors, undefined);
    assert.equal(result.ci.derived, undefined);
  }
}));

test("unknown evidence has only the CI assessment and exits 4", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  const report = json(f.reportPath);
  delete report.stages.qa.evidence.qc_build_fingerprint;
  writeJson(f.reportPath, report);
  const result = await run(f);
  assert.equal(result.ci.status, "unknown");
  assert.equal(result.ci.errors, undefined);
  assert.equal(result.ci.derived, undefined);
  assert.equal(afterEditExitCode(result), 4);
}));

test("an unavailable assessment keeps ci null and the doctor's failure text and exit code", async (t) => withNetworkGuard(async () => {
  const f = await fixture(t);
  const result = await run(f, {}, { specDerive: async (...args) => {
    const plan = await specDeriveWithMapWriteback(...args);
    rmSync(f.packetPath);
    return plan;
  } });
  const doctor = doctorCommand({ _: ["doctor"], packet: f.packetPath, ci: true });
  assert.equal(result.ci, null);
  assert.equal(result.ok, false);
  assert.equal(afterEditExitCode(result), doctor.exit_code);
  assert.equal(afterEditExitCode(result), 2);
  assert.equal(step(result, "owed").detail, formatDoctorCi(doctor));
  assert.match(step(result, "owed").detail, /doctor.ci.packet.*ENOENT/);
}));

function childEnv(extra = {}) {
  const env = { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" };
  delete env.CAMPAIGNS_OS_LIFECYCLE_LOG;
  return { ...env, ...extra };
}

// Include directories so even an empty directory created before refusal is
// observable, as in lifecycle-effects.test.mjs.
const snapshot = (root) => ({ files: treeDigest(root), entries: readdirSync(root, { recursive: true }).sort() });

test("one completed after-edit journals once, including when its inner steps record build and spec", async (t) => withNetworkGuard(async () => {
  for (const selection of ["env", "ambient"]) {
    const f = await fixture(t);
    const session = selection === "ambient" ? openRunSession(f.root, { packet: f.packetPath }).found.session : null;
    const journal = session?.lifecycle_journal || join(f.root, "lifecycle.jsonl");
    if (selection === "ambient") f.page("extra", '<html><head><meta name="next-page-type" content="product"></head><body>Extra</body></html>');
    else f.page("upsell", PAGES.upsell.replace("Example offer", "Revised offer"));
    const child = spawnSync(process.execPath, [CLI, "after-edit", "--packet", f.packetPath, "--yes", "--no-live-refs", "--json"], {
      cwd: f.root, encoding: "utf8", env: childEnv(session ? {} : { CAMPAIGNS_OS_LIFECYCLE_LOG: journal }),
    });
    assert.equal(child.status, 3, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.stopped_at, null);
    assert.equal(step(result, "record_build").status, "done");
    if (session) assert.match(step(result, "spec_derive").detail, /record spec: Bound/);
    const entries = readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, "after-edit");
    assert.equal(entries[0].run_id, session?.run_id || null);
    t.diagnostic(`${selection} journal: ${JSON.stringify(entries)}`);
  }
}));

test("unknown flag, no-write and missing packet refuse without any file or journal write", async (t) => withNetworkGuard(async () => {
  for (const selection of ["env", "ambient"]) {
    const f = await fixture(t);
    const session = selection === "ambient" ? openRunSession(f.root, { packet: f.packetPath }).found.session : null;
    const journal = session?.lifecycle_journal || join(f.root, "lifecycle.jsonl");
    for (const [flags, message] of [
      [["--packet", f.packetPath, "--mystery"], /Unknown flag.*--mystery/],
      [["--packet", f.packetPath, "--no-write"], /writes records.*doctor --ci.*read-only/],
      [[], /Missing required --packet/],
    ]) {
      const before = snapshot(f.root);
      const child = spawnSync(process.execPath, [CLI, "after-edit", ...flags], {
        cwd: f.root, encoding: "utf8", env: childEnv(session ? {} : { CAMPAIGNS_OS_LIFECYCLE_LOG: journal }),
      });
      assert.equal(child.status, 1, child.stderr || child.stdout);
      assert.match(child.stderr, message);
      assert.deepEqual(snapshot(f.root), before);
      assert.equal(existsSync(journal), false);
    }
  }
}));
