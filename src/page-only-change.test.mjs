// #720 and #707: a change that touches only some pages owes QA on those pages
// (Polish advisory); a change that touches commerce owes the full Polish and
// QA. The fixture is a recorded campaign (record build keeps the commerce
// signature), then a rebuild after one edit; doctor --ci, readback's
// evidence_debt and the QA page scope read what that edit owes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildManifestEntries, computeBuildFingerprint } from "./built-site-scope.mjs";
import { recordQaStageOutcome } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { assessEvidenceDebt } from "./evidence-debt.mjs";
import { demoteStages } from "./input-refresh.mjs";
import { __qaNodeTestHooks, applyQaPageScope } from "./qa-node.mjs";
import { runReadbackCommand } from "./readback.mjs";
import { recordStageCommand } from "./stage-record.mjs";

const cli = new URL("../bin/campaigns-os.mjs", import.meta.url).pathname;
const SLUG = "synthetic-campaign";

const PAGES = Object.freeze({
  landing: `<!doctype html><html><head><meta name="next-page-type" content="product"></head><body><h1>Landing headline</h1><a href="../checkout/">Order now</a></body></html>\n`,
  checkout: `<!doctype html><html><head><meta name="next-page-type" content="checkout"></head><body><h1>Checkout</h1><form data-next-checkout="form"><button type="submit">Pay</button></form></body></html>\n`,
  upsell1: `<!doctype html><html><head><meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="../receipt/"></head><body><h1>Add a second bottle</h1><div data-next-package-id="12"><button data-next-upsell-action="add">Yes</button></div></body></html>\n`,
  receipt: `<!doctype html><html><head><meta name="next-page-type" content="receipt"></head><body><h1>Thank you</h1></body></html>\n`,
});

function fixture(t, { spec = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "page-only-change-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "_site", SLUG);
  const writePage = (page, html) => {
    mkdirSync(join(output, page), { recursive: true });
    writeFileSync(join(output, page, "index.html"), html);
  };
  for (const [page, html] of Object.entries(PAGES)) writePage(page, html);
  mkdirSync(join(root, "_data"), { recursive: true });
  const config = { [SLUG]: { sdk_version: "0.4.40", store_name: "Synthetic Store" } };
  const writeConfig = () => writeFileSync(join(root, "_data", "campaigns.json"), JSON.stringify(config));
  writeConfig();
  writeFileSync(join(root, "missing-spec.json"), JSON.stringify(spec));
  mkdirSync(join(root, "src", SLUG), { recursive: true });
  const original = computeBuildFingerprint(output);
  const packet = {
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: SLUG },
    spec: { map_id: "synthetic-map", local_path: "missing-spec.json" },
    assembly: { target_repo: ".", output_dir: `src/${SLUG}` },
  };
  const packetPath = join(root, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  const report = {
    schema_version: "campaign-runtime-assembly-report/v0",
    run_id: "synthetic-run", generated_at: "2026-10-23T00:00:00Z", status: "prepared",
    identity: { map_id: "synthetic-map", public_route_slug: SLUG, campaign_directory: SLUG, live_url_path: `/${SLUG}/`, spec_hash: "synthetic-spec" },
    inputs: { packet_path: "campaign-runtime.build.json", context_path: ".campaign-runtime/build-context.json", spec_path: "missing-spec.json", source: { kind: "html_funnel", root: "source" }, target_repo: "." },
    template_family: { value: "olympus", locked: true },
    decisions: [], evidence: [], blockers: [], warnings: [],
    next: { stage: "build", owner: "build", action: "Record build" },
    stages: {},
  };
  for (const key of ["prepare_build", "doctor", "setup", "assembly", "polish", "deploy", "qa"]) report.stages[key] = { stage: key, status: "completed" };
  Object.assign(report.stages.assembly, { build_fingerprint: original.fingerprint, build_manifest: buildManifestEntries(original) });
  Object.assign(report.stages.polish, { source_build_fingerprint: original.fingerprint });
  Object.assign(report.stages.qa, {
    evidence: { qc_build_fingerprint: original.fingerprint, qc_results: [] },
    purchase_proof: { order_paths_executed: 3, declared_depth: "common" },
  });
  mkdirSync(join(root, ".campaign-runtime"), { recursive: true });
  const reportPath = join(root, ".campaign-runtime", "assembly-report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const readReport = () => JSON.parse(readFileSync(reportPath, "utf8"));
  const recordBuild = () => recordStageCommand({ _: ["record", "build"], packet: packetPath });
  // The recorded campaign: record build keeps the commerce signature of F0.
  recordBuild();
  assert.ok(readReport().stages.assembly.commerce_signature, "setup: record build keeps a commerce signature");
  return {
    root, output, packet, packetPath, reportPath, readReport, recordBuild, writePage, config, writeConfig, original,
    debt: () => assessEvidenceDebt({ packet, packetPath, report: readReport() }),
  };
}

function ci(f, ...flags) {
  const result = spawnSync(process.execPath, [cli, "doctor", "--packet", f.packetPath, "--no-live-refs", "--ci", ...flags], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
  assert.equal(result.error, undefined);
  return result;
}

// The two reports a developer reads after a copy edit on top of an unreviewed
// commerce change: `record build` says page-only, and doctor --ci counts every
// rebuild since the last QA. The CI report has to say why they differ.
test("doctor --ci names its basis and the unreviewed rebuild behind a page-only edit", (t) => {
  const f = fixture(t);
  const report = f.readReport();
  report.stages.qa.checked_at = "2026-10-23T00:00:00Z";
  writeFileSync(f.reportPath, JSON.stringify(report));
  const tracked = PAGES.upsell1.replace("</body>", "<script src=\"/tracking.js\"></script></body>");
  f.writePage("upsell1", tracked);
  f.recordBuild();
  const commerceBuild = f.readReport().stages.assembly.build_fingerprint;
  f.writePage("upsell1", tracked.replace("Add a second bottle", "Add a third bottle"));
  f.recordBuild();
  const assembly = f.readReport().stages.assembly;
  assert.equal(assembly.build_changes.at(-1).kind, "page_only", "the latest rebuild alone is page-only");
  const debt = f.debt();
  assert.equal(debt.qa.change.kind, "commerce_affecting");
  assert.equal(debt.qa.reviewed_at, "2026-10-23T00:00:00Z");
  assert.equal(debt.qa.change.commerce_rebuild.build_fingerprint, commerceBuild);
  const { stdout, status } = ci(f);
  assert.equal(status, 3);
  assert.match(stdout, /Change found: commerce-affecting/);
  // The commerce rebuild as the latest change has nothing page-only to explain.
  const latest = fixture(t);
  latest.writePage("upsell1", PAGES.upsell1.replace("</body>", "<script src=\"/tracking.js\"></script></body>"));
  latest.recordBuild();
  assert.doesNotMatch(ci(latest).stdout, /The latest change alone/);
  assert.match(stdout, /QA change is read against the build it last checked \(`[0-9a-f]{12}`, 2026-10-23\), counting every rebuild since\./);
  assert.match(stdout, /The latest change alone is page-only\. Polish and QA still owe the full stage for an earlier rebuild recorded \d{4}-\d{2}-\d{2} \(`[0-9a-f]{12}`\) since that check\./);
});

test("a blocked full QA does not date a review it never made", (t) => {
  const f = fixture(t);
  const report = f.readReport();
  Object.assign(report.stages.qa, { status: "blocked", checked_at: "2026-10-30T00:00:00Z" });
  writeFileSync(f.reportPath, JSON.stringify(report));
  copyEdit(f);
  f.recordBuild();
  const { qa } = f.debt();
  assert.equal(qa.status, "owed");
  assert.equal(qa.reviewed_at, undefined);
});

test("a recorded build with no markup hashes reads as commerce-affecting, and a later record build does not clear it", (t) => {
  const f = fixture(t);
  const report = f.readReport();
  delete report.stages.assembly.commerce_signature;
  writeFileSync(f.reportPath, JSON.stringify(report));
  copyEdit(f);
  f.recordBuild();
  assert.ok(f.readReport().stages.assembly.commerce_signature, "record build keeps hashes from here on");
  assert.equal(f.debt().qa.change.kind, "commerce_affecting");
  assert.equal(f.debt().qa.scope, "full", "the rebuild since the last QA was read without hashes, so it still owes the full stage");
  assert.match(ci(f).stdout, /predates the markup hashes page-only changes are read from \(Campaigns OS 1\.62\)/);
});

test("doctor warns when records say complete and no build is here to compare", (t) => {
  const f = fixture(t);
  rmSync(f.output, { recursive: true, force: true });
  const doctored = doctorPacket(f.packetPath);
  assert.ok(doctored.warnings.some((issue) => issue.code === "built_output.absent"));
  assert.equal(ci(f).status, 4, "doctor --ci already reads an absent build as unknown");
});

const copyEdit = (f) => f.writePage("upsell1", PAGES.upsell1.replace("Add a second bottle", "Add a third bottle"));

test("a copy edit on one upsell page owes QA on that page and Polish is advisory, before and after record build", (t) => {
  const f = fixture(t);
  copyEdit(f);
  // Before record build: the PR check reads the drift from the recorded build.
  let json = JSON.parse(ci(f, "--json").stdout).ci;
  assert.equal(json.status, "owed");
  assert.equal(json.exit_code, 3);
  assert.equal(json.polish.status, "owed");
  assert.equal(json.polish.advisory, true);
  assert.equal(json.qa.scope, "pages");
  assert.deepEqual(json.qa.owed_pages, [{ page_id: "upsell1", built_path: "upsell1/index.html" }]);
  assert.equal(json.changes.kind, "page_only");
  let markdown = ci(f);
  assert.equal(markdown.status, 3);
  assert.match(markdown.stdout, /Change found: page-only\. It owes QA on `upsell1`; Polish is advisory\./);
  assert.match(markdown.stdout, /Owed stages: qa \(changed pages only\)\./);
  assert.match(markdown.stdout, /- Advisory polish:/);
  assert.match(markdown.stdout, /Remedy: run `campaigns-os record build --packet <packet>` for the rebuilt output, then run `campaigns-os qa run --packet <packet> --page upsell1`/);
  assert.doesNotMatch(markdown.stdout, /polish capture/);

  // After record build the changed-page list survives (#707): the build
  // record keeps the rebuild, and each owed stage reads its change.
  const recorded = f.recordBuild();
  assert.ok(recorded.ready.some((line) => /this rebuild is page-only \(changed pages: upsell1\)/.test(line)), recorded.ready.join("\n"));
  const report = f.readReport();
  assert.equal(report.stages.polish.status, "required");
  assert.equal(report.stages.polish.owed_since_build_fingerprint, f.original.fingerprint);
  assert.deepEqual(report.stages.assembly.build_changes.map((entry) => [entry.from_build_fingerprint, entry.kind, entry.changed_pages.map((page) => page.page_id)]),
    [[f.original.fingerprint, "page_only", ["upsell1"]]]);
  const readback = runReadbackCommand({ _: ["readback", f.root], json: true });
  assert.equal(readback.exitCode, 0);
  const debt = JSON.parse(readback.text).evidence_debt;
  assert.deepEqual(debt.changes.changed_pages, [], "the manifest now describes the rebuilt output");
  assert.deepEqual(debt.polish.change.changed_pages, [{ page_id: "upsell1", built_path: "upsell1/index.html" }]);
  assert.deepEqual(debt.qa.change.changed_pages, [{ page_id: "upsell1", built_path: "upsell1/index.html" }]);
  json = JSON.parse(ci(f, "--json").stdout).ci;
  assert.equal(json.status, "owed");
  assert.equal(json.polish.reason, "stage_required_by_build");
  assert.equal(json.polish.advisory, true);
  assert.deepEqual(json.qa.owed_pages.map((page) => page.page_id), ["upsell1"]);
  markdown = ci(f);
  assert.match(markdown.stdout, /- Changed page: `upsell1` \(`upsell1\/index\.html`\)/);
  assert.match(markdown.stdout, /Remedy: run `campaigns-os qa run --packet <packet> --page upsell1` against that build\./);

  // Doctor carries stale Polish evidence as advisory (local-preview-policy.mjs
  // has the unit cases). This fixture never captured page load, so its
  // hidden eager-media checkpoint reads malformed: that is not evidence for
  // an older build, and it stays a block.
  const doctor = doctorPacket(f.packetPath);
  assert.equal(doctor.derived.evidence_debt.polish.advisory, true);
  assert.equal(doctor.derived.polish_checkpoint_gate.code, "polish.hidden_eager_media.capture_malformed");
  assert.equal(doctor.derived.polish_gate.status, "blocked");
});

test("a page-scoped QA run on the changed page makes the evidence check current", { timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.recordBuild();
  const topologies = [{ funnel_id: "main", pages: ["landing", "checkout", "upsell1", "receipt"].map((page, index) => ({
    page_id: `${page}_page`, page_type: page === "landing" ? "landing" : page, order: index + 1, url: `http://127.0.0.1:9/${SLUG}/${page}/`,
  })) }];
  const scoped = applyQaPageScope(topologies, { pages: ["upsell1"], baseUrl: `http://127.0.0.1:9/${SLUG}/`, debt: f.debt(), report: f.readReport() });
  assert.deepEqual(scoped.topologies[0].pages.map((page) => page.page_id), ["upsell1_page"], "the run checks only the named page");
  assert.deepEqual(scoped.scope.owed_pages, ["upsell1"]);
  assert.deepEqual(scoped.scope.excluded.map((page) => page.page_id), ["landing_page", "checkout_page", "receipt_page"]);

  // The run itself, against no server: the page check fails to connect,
  // which is fine here; the record is what pays the debt.
  const outputDir = mkdtempSync(join(tmpdir(), "page-only-qa-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const spec = { campaign: {}, funnels: [{ id: "main", pages: topologies[0].pages.map((page) => ({ id: page.page_id, type: page.page_type })) }] };
  const resolved = {
    themeGate: { status: "not_applicable", code: "theme_gate.policy_off", reason: "synthetic fixture" },
    polishGate: { status: "not_applicable", code: "polish.not_applicable", reason: "synthetic fixture" },
    checkpointGates: [], qaWaivers: {}, analyticsCaptureTarget: { url: null }, brandContract: null, brandContractStatus: "not_evaluated",
    packetPath: null, mapId: "synthetic-map", publicRouteSlug: SLUG, proxyBase: "https://proxy.example.invalid",
    baseUrl: `http://127.0.0.1:9/${SLUG}/`, spec, rawSpec: spec, specVersion: "4.3", specHash: "sha256:synthetic",
    topologies: scoped.topologies, excludedPages: [], pageScope: scoped.scope,
  };
  const args = { _: ["qa", "run"], "output-dir": outputDir, "no-post-verdict": true, "no-remit": true, "no-live-refs": true, "analytics-correctness": "false", json: true };
  const result = await __qaNodeTestHooks.runResolvedQa(args, resolved);
  assert.deepEqual(result.page_scope.pages, ["upsell1_page"]);
  const verdict = JSON.parse(readFileSync(result.local_path, "utf8"));
  assert.deepEqual(verdict.assertions.filter((entry) => entry.id.startsWith("page-scope:")).map((entry) => [entry.id, entry.status, entry.actual]).sort(),
    [["page-scope:checkout_page", "skipped", "outside_page_scope"], ["page-scope:landing_page", "skipped", "outside_page_scope"], ["page-scope:receipt_page", "skipped", "outside_page_scope"]]);

  // The stage record: the verdict, its page scope, and the purchase proof of
  // the full run it extends. A passing verdict stands in for the run here.
  const passing = { ...result, verdict: { ...result.verdict, disposition: "ready", campaign_slug: "synthetic-map" } };
  assert.equal(recordQaStageOutcome({ _: ["qa", "run"], packet: f.packetPath }, passing), true);
  const qa = f.readReport().stages.qa;
  assert.equal(qa.evidence.qc_build_fingerprint, f.readReport().stages.assembly.build_fingerprint);
  assert.deepEqual(qa.evidence.page_scope, { pages: ["upsell1_page"], owed_pages: ["upsell1"], base_build_fingerprint: f.original.fingerprint });
  assert.deepEqual(qa.purchase_proof, { order_paths_executed: 3, declared_depth: "common" });

  const json = JSON.parse(ci(f, "--json").stdout).ci;
  assert.equal(json.status, "current");
  assert.equal(json.exit_code, 0);
  assert.equal(json.qa.status, "current");
  assert.equal(json.polish.advisory, true, "Polish stays reported");
  const markdown = ci(f);
  assert.equal(markdown.status, 0);
  assert.match(markdown.stdout, /Owed stages: none\./);
  assert.match(markdown.stdout, /- Advisory polish:/);
  assert.doesNotMatch(markdown.stdout, /Remedy:/);
});

for (const [label, edit, reason] of [
  ["a package ref on the upsell page", (f) => f.writePage("upsell1", PAGES.upsell1.replace('data-next-package-id="12"', 'data-next-package-id="13"')), "commerce_markup_changed"],
  ["the upsell order (the accept route)", (f) => f.writePage("upsell1", PAGES.upsell1.replace('content="../receipt/"', 'content="../upsell2/"')), "commerce_markup_changed"],
  ["the SDK pin in the campaign's Page Kit config", (f) => { f.config[SLUG].sdk_version = "0.4.41"; f.writeConfig(); copyEdit(f); }, "campaign_config_changed"],
  ["copy on the checkout page", (f) => f.writePage("checkout", PAGES.checkout.replace("<h1>Checkout</h1>", "<h1>Secure checkout</h1>")), "checkout_page"],
  ["a shared script", (f) => { mkdirSync(join(f.output, "assets"), { recursive: true }); writeFileSync(join(f.output, "assets", "app.js"), "window.x = 1;\n"); }, "unmapped_file"],
  ["a new page (a route change)", (f) => f.writePage("upsell2", PAGES.upsell1), "page_added"],
]) {
  test(`a change to ${label} still owes the full Polish and QA`, (t) => {
    const f = fixture(t);
    edit(f);
    for (const recorded of [false, true]) {
      if (recorded) f.recordBuild();
      const json = JSON.parse(ci(f, "--json").stdout).ci;
      assert.equal(json.status, "owed", `${label} (record build ${recorded})`);
      assert.equal(json.polish.status, "owed");
      assert.equal(json.polish.advisory, false);
      assert.equal(json.qa.scope, "full");
      assert.ok(json.qa.change.reasons.some((entry) => entry.code === reason), JSON.stringify(json.qa.change.reasons));
      const markdown = ci(f);
      assert.equal(markdown.status, 3);
      assert.match(markdown.stdout, /Change found: commerce-affecting \(.+\)\. It owes the full Polish and QA\./);
      assert.match(markdown.stdout, /Owed stages: polish, qa\./);
      assert.doesNotMatch(markdown.stdout, /--page/);
    }
    assert.throws(() => applyQaPageScope([{ pages: [{ page_id: "upsell1", url: `http://127.0.0.1:9/${SLUG}/upsell1/` }] }],
      { pages: ["upsell1"], baseUrl: `http://127.0.0.1:9/${SLUG}/`, debt: f.debt(), report: f.readReport() }),
    /owes a full QA run/);
  });
}

test("a page-scoped run must cover every changed page, and runs only against the recorded build", (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.writePage("landing", PAGES.landing.replace("Landing headline", "A new headline"));
  const base = `http://127.0.0.1:9/${SLUG}/`;
  const topologies = [{ pages: ["landing", "upsell1"].map((page) => ({ page_id: page, url: `${base}${page}/` })) }];
  assert.throws(() => applyQaPageScope(topologies, { pages: ["upsell1"], baseUrl: base, debt: f.debt(), report: f.readReport() }),
    /record build/, "an unrecorded rebuild is recorded first");
  f.recordBuild();
  assert.throws(() => applyQaPageScope(topologies, { pages: ["upsell1"], baseUrl: base, debt: f.debt(), report: f.readReport() }),
    /QA is owed on landing, upsell1; add --page landing\./);
  assert.throws(() => applyQaPageScope(topologies, { pages: ["upsel1"], baseUrl: base, debt: f.debt(), report: f.readReport() }),
    /"upsel1" is not a page of this campaign's QA topology/);
  const scoped = applyQaPageScope(topologies, { pages: ["upsell1", "landing"], baseUrl: base, debt: f.debt(), report: f.readReport() });
  assert.deepEqual(scoped.scope.owed_pages, ["landing", "upsell1"]);
});

test("rebuilds accumulate per stage: QA paid on one page still reads a later page-only change from its own build", (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.recordBuild();
  const afterFirst = f.readReport().stages.assembly.build_fingerprint;
  // Stand-in for a page-scoped QA record on the first rebuild.
  const report = f.readReport();
  report.stages.qa.evidence = { qc_build_fingerprint: afterFirst, qc_results: [], page_scope: { pages: ["upsell1"], owed_pages: ["upsell1"], base_build_fingerprint: f.original.fingerprint } };
  writeFileSync(f.reportPath, JSON.stringify(report));
  f.writePage("landing", PAGES.landing.replace("Landing headline", "A new headline"));
  f.recordBuild();
  const debt = f.debt();
  assert.deepEqual(debt.qa.owed_pages.map((page) => page.page_id), ["landing"], "QA owes only the page changed since its build");
  assert.deepEqual(debt.polish.change.changed_pages.map((page) => page.page_id), ["landing", "upsell1"], "Polish reads both rebuilds since its review");
  assert.equal(debt.polish.advisory, true);
  assert.equal(f.readReport().stages.assembly.build_changes.length, 2);
});

test("qa run --page from the CLI: argv refusals, then a commerce change stops before any page is checked", (t) => {
  // A spec whose pages the QA topology knows.
  const f = fixture(t, { spec: { funnels: [{ id: "main", pages: ["landing", "checkout", "upsell1", "receipt"]
    .map((page, index) => ({ id: page, type: page === "landing" ? "landing" : page, order: index + 1, page_url: `${page}/` })) }] } });
  const run = (...flags) => spawnSync(process.execPath, [cli, "qa", "run", ...flags, "--no-post-verdict", "--no-remit", "--no-live-refs", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off", CAMPAIGNS_OS_LIFECYCLE_LOG: "" },
  });
  const noPacket = run("--page", "upsell1", "--base-url", `http://127.0.0.1:9/${SLUG}/`);
  assert.notEqual(noPacket.status, 0);
  assert.match(noPacket.stderr, /--page needs --packet/);
  const withOrders = run("--packet", f.packetPath, "--page", "upsell1", "--test-order", "common");
  assert.notEqual(withOrders.status, 0);
  assert.match(withOrders.stderr, /--page cannot be combined with --test-order/);
  const withBeacons = run("--packet", f.packetPath, "--page", "upsell1", "--vendor-beacons", "live");
  assert.notEqual(withBeacons.status, 0);
  assert.match(withBeacons.stderr, /--page cannot be combined with --vendor-beacons/);
  assert.doesNotMatch(withBeacons.stderr, /add --test-order/);
  // --page=<id> is refused rather than read as an unknown key, which would
  // widen the run to a full QA.
  const joined = run("--packet", f.packetPath, "--page=upsell1");
  assert.notEqual(joined.status, 0);
  assert.match(joined.stderr, /--page=… is not accepted: a flag takes its value as the next argument/);
  assert.match(run("--packet", f.packetPath, "--test-order=common").stderr, /`--test-order <value>`/);
  assert.match(run("--packet", f.packetPath, "--=upsell1").stderr, /--=… is not accepted: the flag name is missing before =/);
  const empty = run("--packet", f.packetPath, "--page");
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /--page takes a page id/);

  // --page repeats: every value is read, not only the last.
  copyEdit(f);
  f.recordBuild();
  const repeated = run("--packet", f.packetPath, "--page", "nope", "--page", "upsell1", "--base-url", `http://127.0.0.1:9/${SLUG}/`);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /"nope" is not a page of this campaign's QA topology/);

  // A package ref change.
  f.writePage("upsell1", PAGES.upsell1.replace('data-next-package-id="12"', 'data-next-package-id="13"'));
  f.recordBuild();
  const before = readFileSync(f.reportPath, "utf8");
  const commerce = run("--packet", f.packetPath, "--page", "upsell1", "--base-url", `http://127.0.0.1:9/${SLUG}/`);
  assert.notEqual(commerce.status, 0);
  assert.match(commerce.stderr, /commerce-affecting \(commerce_markup_changed\), so it owes a full QA run/);
  assert.equal(readFileSync(f.reportPath, "utf8"), before, "the QA stage is not recorded");
  assert.equal(spawnSync("ls", [join(f.root, "qa-output")]).status !== 0, true, "no verdict is written");
});

// Review of #720: a page-only change extends only a completed review.
const editReport = (f, change) => {
  const report = f.readReport();
  change(report.stages);
  writeFileSync(f.reportPath, JSON.stringify(report));
};

test("a page-only change after a blocked full QA owes a full QA run; Polish stays advisory", (t) => {
  const f = fixture(t);
  editReport(f, (stages) => Object.assign(stages.qa, { status: "blocked", blockers: ["checkout broken"] }));
  copyEdit(f);
  for (const recorded of [false, true]) {
    if (recorded) f.recordBuild();
    const json = JSON.parse(ci(f, "--json").stdout).ci;
    assert.equal(json.status, "owed", `record build ${recorded}`);
    assert.equal(json.qa.status, "owed");
    assert.equal(json.qa.scope, "full", "a blocked QA extends nothing");
    assert.deepEqual(json.qa.owed_pages, []);
    assert.equal(json.polish.advisory, true, "Polish completed, so it stays advisory");
    const markdown = ci(f);
    assert.equal(markdown.status, 3);
    assert.match(markdown.stdout, /Change found: page-only, but .+\. It owes a full QA run; Polish is advisory\./);
    assert.match(markdown.stdout, /Owed stages: qa\./);
    assert.doesNotMatch(markdown.stdout, /--page/);
  }
  const base = `http://127.0.0.1:9/${SLUG}/`;
  assert.throws(() => applyQaPageScope([{ pages: [{ page_id: "upsell1", url: `${base}upsell1/` }] }],
    { pages: ["upsell1"], baseUrl: base, debt: f.debt(), report: f.readReport() }),
  /page-only, but the QA recorded before it did not complete, so it owes a full QA run/);
});

test("a blocked Polish is not advisory for a page-only change, before or after record build", (t) => {
  const f = fixture(t);
  editReport(f, (stages) => Object.assign(stages.polish, { status: "blocked", blockers: ["layout broken"] }));
  copyEdit(f);
  for (const recorded of [false, true]) {
    if (recorded) f.recordBuild();
    const json = JSON.parse(ci(f, "--json").stdout).ci;
    assert.equal(json.polish.status, "owed", `record build ${recorded}`);
    assert.equal(json.polish.advisory, false, `record build ${recorded}`);
    assert.equal(json.qa.scope, "pages", "QA completed, so it can still be paid on the changed page");
    const markdown = ci(f);
    assert.equal(markdown.status, 3);
    assert.match(markdown.stdout, /It owes the full Polish, and QA on `upsell1`\./);
    assert.match(markdown.stdout, /Owed stages: polish, qa \(changed pages only\)\./);
  }
});

test("a Polish a spec change made owed again is not advisory for a later page-only change", (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.recordBuild();
  assert.equal(f.debt().polish.advisory, true, "setup: a page-only change alone leaves Polish advisory");
  editReport(f, (stages) => Object.assign(stages, demoteStages({ stages }, { causes: ["spec"], by: "record spec", now: "2026-10-30T00:00:00Z" }).report.stages));
  f.writePage("upsell1", PAGES.upsell1.replace("Add a second bottle", "Add a fourth bottle"));
  for (const recorded of [false, true]) {
    if (recorded) f.recordBuild();
    const debt = f.debt();
    assert.equal(debt.polish.status, "owed", `record build ${recorded}`);
    assert.equal(debt.polish.advisory, false, `record build ${recorded}: the spec change owes the full Polish`);
  }
});

test("a page-scoped run that did not complete stays page-scoped from the full QA it extended", (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.recordBuild();
  const afterFirst = f.readReport().stages.assembly.build_fingerprint;
  // Stand-in for a blocked page-scoped QA record on the first rebuild.
  editReport(f, (stages) => Object.assign(stages.qa, {
    status: "blocked", blockers: ["upsell copy overflows"], checked_at: "2026-10-30T00:00:00Z",
    evidence: { qc_build_fingerprint: afterFirst, qc_results: [], page_scope: { pages: ["upsell1"], owed_pages: ["upsell1"], base_build_fingerprint: f.original.fingerprint } },
  }));
  // The fix, plus a second page-only edit.
  f.writePage("landing", PAGES.landing.replace("Landing headline", "A new headline"));
  f.recordBuild();
  const debt = f.debt();
  assert.equal(debt.qa.scope, "pages");
  assert.equal(debt.qa.change.since_build_fingerprint, f.original.fingerprint, "read from the completed QA's build");
  assert.equal(debt.qa.reviewed_at, undefined, "the blocked run's date is not that QA's");
  assert.deepEqual(debt.qa.owed_pages.map((page) => page.page_id), ["landing", "upsell1"], "the unpaid page stays owed");
  const base = `http://127.0.0.1:9/${SLUG}/`;
  const topologies = [{ pages: ["landing", "upsell1"].map((page) => ({ page_id: page, url: `${base}${page}/` })) }];
  assert.throws(() => applyQaPageScope(topologies, { pages: ["landing"], baseUrl: base, debt, report: f.readReport() }), /add --page upsell1/);
  const scoped = applyQaPageScope(topologies, { pages: ["landing", "upsell1"], baseUrl: base, debt, report: f.readReport() });
  assert.equal(scoped.scope.base_build_fingerprint, f.original.fingerprint);
});

test("a page-scoped run refuses QA that an input change owes, or whose inputs cannot be confirmed", (t) => {
  const f = fixture(t);
  copyEdit(f);
  f.recordBuild();
  const base = `http://127.0.0.1:9/${SLUG}/`;
  const topologies = [{ pages: [{ page_id: "upsell1", url: `${base}upsell1/` }] }];
  const scope = (qaInputCurrency) => applyQaPageScope(topologies, { pages: ["upsell1"], baseUrl: base, debt: f.debt(), report: f.readReport(), qaInputCurrency });
  assert.throws(() => scope("owed"), /an input change \(the brief's qa_policy or the CampaignSpec\) owes QA again, so it owes a full QA run/);
  assert.throws(() => scope("unknown"), /cannot be confirmed current, so it owes a full QA run/);
  assert.deepEqual(scope("current").scope.owed_pages, ["upsell1"]);
});

// `record baseline`: a funnel from before markup hashes, accepted as the
// starting point by a named person, so small checks work without a test order.
const ACCEPTED = { "accepted-by": "Pat Rivera", reason: "Live and selling since before markup hashes" };
const recordBaseline = (f, extra = {}) => recordStageCommand({ _: ["record", "baseline"], packet: f.packetPath, ...ACCEPTED, ...extra });

function legacyFixture(t) {
  const f = fixture(t);
  const report = f.readReport();
  delete report.stages.assembly.commerce_signature;
  writeFileSync(f.reportPath, JSON.stringify(report));
  copyEdit(f);
  f.recordBuild();
  return f;
}

test("a baseline is its own status, keeps no purchase proof, and says what it is", (t) => {
  const f = legacyFixture(t);
  assert.equal(f.debt().qa.scope, "full", "before it, the first change on a pre-1.62 build owes everything");
  const before = f.readReport().stages.qa;
  assert.ok(before.purchase_proof);
  const result = recordBaseline(f);
  assert.equal(result.record.accepted_by, "Pat Rivera");
  const report = f.readReport();
  for (const key of ["polish", "qa"]) {
    assert.equal(report.stages[key].status, "baseline_accepted");
    assert.equal(report.stages[key].completed_at, undefined, "never completed");
  }
  assert.equal(report.stages.qa.purchase_proof, undefined, "the old purchase proof stops counting");
  assert.equal(report.stages.qa.verdict_run_id, undefined);
  assert.deepEqual(report.stages.qa.history.at(-1).purchase_proof, before.purchase_proof, "it is kept in history");
  const debt = f.debt();
  assert.equal(debt.qa.status, "current");
  assert.equal(debt.qa.baseline.accepted_by, "Pat Rivera");
  assert.equal(debt.polish.status, "current");
  const { stdout, status } = ci(f);
  assert.equal(status, 0);
  assert.match(stdout, /QA rests on a baseline Pat Rivera accepted on \d{4}-\d{2}-\d{2}, not a test\. No purchase has been tested since\./);
  assert.ok(doctorPacket(f.packetPath).warnings.some((issue) => issue.code === "qa.baseline_accepted"));
  const readback = runReadbackCommand({ _: ["readback", f.root], json: true, packet: f.packetPath });
  assert.equal(JSON.parse(readback.text).evidence_debt.qa.baseline.accepted_by, "Pat Rivera");
});

test("after a baseline a copy edit owes QA on that page, the pass stays a baseline, and it never gains purchase proof", (t) => {
  const f = legacyFixture(t);
  recordBaseline(f);
  f.writePage("landing", PAGES.landing.replace("Landing headline", "A new headline"));
  f.recordBuild();
  const debt = f.debt();
  assert.equal(debt.qa.scope, "pages");
  assert.deepEqual(debt.qa.owed_pages.map((page) => page.page_id), ["landing"]);
  assert.equal(debt.polish.advisory, true);
  assert.equal(debt.qa.baseline.accepted_by, "Pat Rivera", "a change owed on pages still rests on the baseline");
  const base = `http://127.0.0.1:9/${SLUG}/`;
  const scoped = applyQaPageScope([{ pages: [{ page_id: "landing", url: `${base}landing/` }] }], { pages: ["landing"], baseUrl: base, debt, report: f.readReport() });
  const verdict = { run_id: "page-run", campaign_slug: "synthetic-map", disposition: "ready", completed_at: "2026-11-08T00:00:00Z", assertions: [], spec_hash: null, qc_results: [] };
  assert.equal(recordQaStageOutcome({ _: ["qa", "run"], packet: f.packetPath }, { verdict, page_scope: scoped.scope }), true);
  const qa = f.readReport().stages.qa;
  assert.equal(qa.status, "baseline_accepted", "a page-scoped pass proves those pages, not the funnel");
  assert.equal(qa.purchase_proof, undefined);
  assert.equal(qa.completed_at, undefined);
  assert.ok(qa.baseline_accepted_at);
});

test("a blocked run leaves QA resting on the baseline, and the reports keep saying so", (t) => {
  const f = legacyFixture(t);
  recordBaseline(f);
  const blocked = { run_id: "full-blocked", campaign_slug: "synthetic-map", disposition: "blocked", completed_at: "2026-11-08T00:00:00Z", assertions: [{ id: "x", status: "fail", actual: "broken" }], spec_hash: null, qc_results: [], test_orders: [] };
  assert.equal(recordQaStageOutcome({ _: ["qa", "run"], packet: f.packetPath }, { verdict: blocked }), true);
  const qa = f.readReport().stages.qa;
  assert.equal(qa.status, "blocked");
  assert.ok(qa.baseline_accepted_at, "a run that proved nothing does not end the baseline");
  assert.equal(f.debt().qa.baseline.accepted_by, "Pat Rivera");
  assert.ok(doctorPacket(f.packetPath).warnings.some((issue) => issue.code === "qa.baseline_accepted"));
});

test("a baseline over a blocked QA keeps what was blocking it, and a moved build names record build then baseline", (t) => {
  const f = legacyFixture(t);
  const report = f.readReport();
  Object.assign(report.stages.qa, { status: "blocked", blockers: ["checkout total wrong"] });
  Object.assign(report.stages.polish, { status: "skipped", skip_reason: "no design source" });
  writeFileSync(f.reportPath, JSON.stringify(report));
  const moved = legacyFixture(t);
  copyEdit(moved);
  moved.writePage("landing", PAGES.landing.replace("Landing headline", "Moved"));
  assert.throws(() => recordBaseline(moved), (error) => {
    assert.doesNotMatch(error.message, /polish capture/);
    assert.match(error.message, /record baseline|baseline again/);
    return true;
  });
  const result = recordBaseline(f);
  assert.deepEqual(f.readReport().commerce_baseline.replaced_qa.blockers, ["checkout total wrong"]);
  assert.equal(f.readReport().commerce_baseline.replaced_polish.skip_reason, "no design source");
  assert.ok(result.ready.some((line) => /The QA this replaces was blocked \(1 blocker/.test(line)));
});

test("a commerce change after a baseline owes the full stages, and a second baseline is refused", (t) => {
  const f = legacyFixture(t);
  recordBaseline(f);
  f.writePage("upsell1", PAGES.upsell1.replace("</body>", "<script src=\"/tracking.js\"></script></body>"));
  f.recordBuild();
  const debt = f.debt();
  assert.equal(debt.qa.status, "owed");
  assert.equal(debt.qa.scope, "full");
  assert.equal(debt.qa.change.kind, "commerce_affecting");
  assert.throws(() => recordBaseline(f), /a funnel gets one/);
});

test("a full QA ends the baseline, and the funnel does not get another", (t) => {
  const f = legacyFixture(t);
  recordBaseline(f);
  const verdict = { run_id: "full-run", campaign_slug: "synthetic-map", disposition: "ready", completed_at: "2026-11-08T00:00:00Z", assertions: [], spec_hash: null, qc_results: [], test_orders: [] };
  assert.equal(recordQaStageOutcome({ _: ["qa", "run"], packet: f.packetPath }, { verdict }), true);
  const report = f.readReport();
  assert.equal(report.stages.qa.status, "completed");
  assert.equal(report.stages.qa.baseline_accepted_at, undefined);
  assert.equal(f.debt().qa.baseline, undefined);
  assert.ok(report.commerce_baseline, "kept, so it stays one time per funnel");
  assert.throws(() => recordBaseline(f), /a funnel gets one/);
});

test("a baseline is refused for a funnel with hashes, one not handed off, and one with nothing owed", (t) => {
  const hashed = fixture(t);
  hashed.writePage("upsell1", PAGES.upsell1.replace("</body>", "<script src=\"/tracking.js\"></script></body>"));
  hashed.recordBuild();
  assert.throws(() => recordBaseline(hashed), /only for records from before those hashes/);

  const fresh = legacyFixture(t);
  const report = fresh.readReport();
  for (const key of ["deploy", "qa"]) { report.stages[key].status = "pending"; delete report.stages[key].history; }
  writeFileSync(fresh.reportPath, JSON.stringify(report));
  assert.throws(() => recordBaseline(fresh), /already handed off/);

  assert.throws(() => recordBaseline(fixture(t)), /only for records from before those hashes/, "an unchanged funnel has nothing to accept");
});

test("a baseline needs a named person and a reason, and a dry run writes nothing", (t) => {
  const f = legacyFixture(t);
  assert.throws(() => recordBaseline(f, { "accepted-by": "operator" }), /--accepted-by needs the named person/);
  assert.throws(() => recordBaseline(f, { "accepted-by": "Claude Code" }), /--accepted-by needs the named person/);
  assert.throws(() => recordBaseline(f, { reason: true }), /--reason needs/);
  const before = readFileSync(f.reportPath, "utf8");
  assert.equal(recordBaseline(f, { "dry-run": true }).status, "dry_run");
  assert.equal(readFileSync(f.reportPath, "utf8"), before);
});

test("a spec change after a baseline owes the stage again", (t) => {
  const f = legacyFixture(t);
  recordBaseline(f);
  assert.equal(doctorPacket(f.packetPath).derived.input_currency.stages.qa, "current");
  const specPath = join(f.root, "missing-spec.json");
  writeFileSync(specPath, JSON.stringify({ ...JSON.parse(readFileSync(specPath, "utf8")), edited: true }));
  assert.equal(doctorPacket(f.packetPath).derived.input_currency.stages.qa, "owed");
});
