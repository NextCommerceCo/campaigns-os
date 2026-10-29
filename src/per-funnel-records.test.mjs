// #719: one Page Kit project, several funnels, each with its own records.
//
// A project's first funnel keeps the default packet and the project-level
// .campaign-runtime/; every later funnel gets campaign-runtime-<route>.build.json
// and .campaign-runtime/funnels/<route>/ (src/campaign-workspace.mjs). These
// tests run real intakes of the shipped example for two routes in one target,
// take each funnel through setup, build, doctor and a QA record, and check that
// no command for one funnel changes a byte of the other's records. A project
// laid out the way 1.61.0 left it (one packet, no assembly.runtime_dir, records
// directly under .campaign-runtime/) must read and keep its records where they
// are.
//
// No network: qc-test-factories runs the CLI in process under its guard.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { assertNoNetworkAttempts, readJson, ROOT, runCli, writeJson } from "./qc-test-factories.mjs";
import {
  packetRuntimeRelPath,
  planFunnelWorkspace,
  resolveCampaignWorkspace,
  soleProjectPacket,
} from "./campaign-workspace.mjs";
import { parseArgs } from "./cli.mjs";
import { resolveProjection, runReadbackCommand } from "./readback.mjs";
import { createVerdict, SEVERITY, STATUS } from "./qa-verdict.mjs";
import { specMaterialHash } from "./spec-identity.mjs";

process.env.CAMPAIGNS_OS_TELEMETRY = "off";
afterEach(assertNoNetworkAttempts);

const EXAMPLE_SPEC = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
const FIRST = EXAMPLE_SPEC.spec_identity.public_route_slug;
const SECOND = "second-funnel";

// The example spec moved to another route (and Map) wholesale, SDK meta hints
// dropped so a hand-written built page can satisfy doctor.
function specFor(route) {
  const spec = JSON.parse(JSON.stringify(EXAMPLE_SPEC).split(FIRST).join(route));
  for (const funnel of spec.funnels || []) for (const page of funnel.pages || []) delete page.sdk_hints;
  return spec;
}

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-funnels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const target = join(dir, "target");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  return { dir, source, target };
}

// Every file under the target, by sha256, so "changed nothing" is a byte claim.
function snapshot(root, base = root, files = new Map()) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) snapshot(path, base, files);
    else files.set(relative(base, path).split("\\").join("/"), createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return files;
}

function changedBetween(before, after) {
  const changed = [];
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}

// `codes`: the exits the step may end with. Doctor exits 2 while the
// lifecycle still owes polish, and writes its output either way.
async function cli(argv, what, { codes = [0] } = {}) {
  const result = await runCli(argv);
  assert.equal(result.error, null, `${what}: did not throw: ${result.error?.stack || ""}`);
  assert.ok(codes.includes(result.exitCode), `${what}: exits ${codes.join(" or ")}, got ${result.exitCode}: ${result.stderr.slice(0, 800)} ${result.stdout.slice(0, 400)}`);
  return result;
}

// readback prints through its own writer, so it is called directly.
function readback(argv) {
  const { exitCode, text } = runReadbackCommand(parseArgs(["readback", ...argv]));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { exitCode, text, json };
}

// A real intake for one route, the prepare-build gate then made terminal the
// way a cleared Design Source Package leaves it (as src/stage-record.test.mjs
// withLifecycle does).
async function setUpFunnel(p, route, extra = []) {
  const spec = specFor(route);
  const specPath = join(p.dir, `${route}.campaignspec.json`);
  writeJson(specPath, spec);
  const prepared = await cli([
    "prepare-build", "--spec", specPath, "--source", p.source, "--target", p.target,
    "--template-family", "olympus", "--no-run-session", "--no-remit", ...extra, "--json",
  ], `prepare-build ${route}`);
  const { packetPath, reportPath, contextPath } = prepared.json;
  const report = readJson(reportPath);
  report.stages.prepare_build.status = "completed";
  report.stages.prepare_build.blockers = [];
  report.blockers = [];
  report.status = "prepared";
  writeJson(reportPath, report);
  return { route, spec, specPath, packetPath, reportPath, contextPath, packet: readJson(packetPath) };
}

// What setup produces: the campaign output directory and its _data entry,
// added beside any other funnel's.
function scaffold(p, f) {
  mkdirSync(resolve(p.target, f.packet.assembly.output_dir), { recursive: true });
  const dataPath = join(p.target, "_data/campaigns.json");
  const data = existsSync(dataPath) ? readJson(dataPath) : {};
  const entry = Object.fromEntries([
    "store_name", "store_url", "store_terms", "store_privacy", "store_contact",
    "store_returns", "store_shipping", "store_phone", "store_phone_tel",
  ].map((field) => [field, f.spec.campaign[field]]));
  entry.sdk_version = f.spec.runtime?.sdk_version || f.spec.global_config?.sdk_version;
  writeJson(dataPath, { ...data, [f.spec.campaign.slug]: entry });
}

// What page-kit build produces for one funnel: a page per CampaignSpec page
// under _site/<route>/.
function buildSite(p, f) {
  for (const page of f.spec.funnels.flatMap((funnel) => funnel.pages)) {
    const route = String(page.page_url || "").replace(/^\/+|\/+$/g, "");
    const file = join(p.target, "_site", f.route, route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><meta name="next-page-type" content="${page.type}"><title>${page.id}</title><script src="https://cdn.example.com/campaign-cart@v0.4.37/dist/loader.js"></script></head><body data-next-page="${page.id}"><h1>${page.id}</h1></body></html>\n`);
  }
}

// A full QA verdict for one funnel under qa-output/, to promote into the
// funnel's committed sidecar.
function writeVerdict(p, f) {
  const runId = `qa_${f.route}`;
  const verdict = createVerdict({
    runId,
    mapId: f.packet.spec.map_id,
    publicRouteSlug: f.route,
    specVersion: "4.2",
    specHash: specMaterialHash(f.spec),
    startedAt: "2026-10-20T10:00:00.000Z",
    completedAt: "2026-10-20T10:05:00.000Z",
    runtime: "campaigns-os-node-qa@test",
    baseUrl: `https://preview.example/${f.route}/`,
    assertions: [{ id: "route:entry", family: "funnel-flow", page: "landing", status: STATUS.pass, severity: SEVERITY.blocker, expected: "200", actual: "200", evidence: [] }],
  });
  const path = join(p.target, "qa-output", f.packet.spec.map_id, `${runId}.json`);
  writeJson(path, verdict);
  return path;
}

// Setup, build, doctor and a QA record for one funnel, each through the CLI.
async function runFunnel(p, f) {
  scaffold(p, f);
  await cli(["record", "setup", "--packet", f.packetPath, "--json"], `record setup ${f.route}`);
  buildSite(p, f);
  await cli(["record", "build", "--packet", f.packetPath, "--json"], `record build ${f.route}`);
  await cli(["doctor", "--packet", f.packetPath, "--write", "--no-live-refs", "--json"], `doctor --write ${f.route}`, { codes: [0, 2] });
  const verdictPath = writeVerdict(p, f);
  await cli(["qa", "promote", "--packet", f.packetPath, "--verdict", verdictPath, "--json"], `qa promote ${f.route}`);
  const report = readJson(f.reportPath);
  assert.equal(report.identity.public_route_slug, f.route, `${f.route}: its report names its own route`);
  assert.equal(report.stages.setup.status, "completed", `${f.route}: setup recorded in its own report`);
  assert.equal(report.stages.assembly.status, "completed", `${f.route}: build recorded in its own report`);
}

// The records one funnel owns, relative to the target: everything under its
// runtime directory (the first funnel's excludes the funnels/ tree), its
// packet, its built output and its full QA verdicts.
function ownedBy(f, files) {
  const runtime = packetRuntimeRelPath(f.packet);
  const own = (path) => runtime === ".campaign-runtime"
    ? path.startsWith(".campaign-runtime/") && !path.startsWith(".campaign-runtime/funnels/")
    : path.startsWith(`${runtime}/`);
  return new Map([...files].filter(([path]) => own(path)
    || path === relative(dirname(f.packetPath), f.packetPath)
    || path.startsWith(`_site/${f.route}/`)
    || path.startsWith(`qa-output/${f.packet.spec.map_id}/`)));
}

test("#719: a second funnel gets its own packet and runtime directory, and the first funnel's records are untouched", async (t) => {
  const p = project(t);
  const first = await setUpFunnel(p, FIRST);
  assert.equal(first.packetPath, join(p.target, "campaign-runtime.build.json"), "the first funnel keeps the default packet");
  assert.equal(first.packet.assembly.runtime_dir, undefined, "the first funnel records no runtime_dir");
  assert.equal(first.reportPath, join(p.target, ".campaign-runtime/assembly-report.json"));
  const afterFirst = snapshot(p.target);

  const second = await setUpFunnel(p, SECOND);
  assert.equal(second.packetPath, join(p.target, `campaign-runtime-${SECOND}.build.json`), "the second funnel's packet is named for its route");
  assert.equal(second.packet.assembly.runtime_dir, `.campaign-runtime/funnels/${SECOND}`);
  for (const [path, expected] of [
    [second.contextPath, "build-context.json"],
    [second.reportPath, "assembly-report.json"],
    [resolve(dirname(second.packetPath), second.packet.build_brief.normalized_path), "input/campaign-build-brief.normalized.json"],
    [resolve(dirname(second.packetPath), second.packet.design_source_package.path), "input/design-source-package.json"],
  ]) {
    assert.equal(path, join(p.target, ".campaign-runtime/funnels", SECOND, expected));
    assert.ok(existsSync(path), `${expected} written for the second funnel`);
  }
  assert.equal(readJson(second.contextPath).scaffold.handoff_artifact, `.campaign-runtime/funnels/${SECOND}/setup-handoff.json`);
  const firstFiles = ownedBy(first, afterFirst);
  assert.deepEqual(changedBetween(firstFiles, ownedBy(first, snapshot(p.target))), [], "setting up the second funnel changed none of the first funnel's records");
  assert.equal(readJson(first.packetPath).campaign.public_route_slug, FIRST, "the default packet still describes the first funnel");

  // Re-running setup for either funnel finds its own packet and directory again.
  assert.deepEqual(planFunnelWorkspace(p.target, SECOND), { packetPath: second.packetPath, runtimeRelPath: `.campaign-runtime/funnels/${SECOND}`, scoped: true });
  assert.deepEqual(planFunnelWorkspace(p.target, FIRST), { packetPath: first.packetPath, runtimeRelPath: ".campaign-runtime", scoped: false });
});

test("#719: two funnels each run setup, build, doctor and QA without changing the other's files", async (t) => {
  const p = project(t);
  const first = await setUpFunnel(p, FIRST);
  const second = await setUpFunnel(p, SECOND);

  await runFunnel(p, first);
  const firstDone = ownedBy(first, snapshot(p.target));
  const secondBefore = ownedBy(second, snapshot(p.target));

  // With the first funnel built and the second only prepared, next, doctor
  // --ci (the PR evidence check) and readback's evidence debt each answer for
  // the funnel the packet names.
  const nextFirst = await cli(["next", "--packet", first.packetPath, "--no-write", "--no-live-refs", "--json"], "next first");
  const nextSecond = await cli(["next", "--packet", second.packetPath, "--no-write", "--no-live-refs", "--json"], "next second");
  assert.equal(nextSecond.json.stage, "setup", "the second funnel still owes setup");
  assert.notEqual(nextFirst.json.stage, "setup", "the first funnel's setup is recorded in its own report");
  const ciFirst = await runCli(["doctor", "--packet", first.packetPath, "--ci", "--no-live-refs", "--json"]);
  const ciSecond = await runCli(["doctor", "--packet", second.packetPath, "--ci", "--no-live-refs", "--json"]);
  assert.equal(ciFirst.json.derived.assembly_report_path, first.reportPath);
  assert.equal(ciSecond.json.derived.assembly_report_path, second.reportPath);
  assert.equal(ciFirst.json.ci.polish.status, "owed", "the first funnel's build is recorded, so its polish is owed");
  assert.equal(ciSecond.json.ci.polish.status, "unknown", "the second funnel has nothing built to bind evidence to");
  assert.equal(ciSecond.json.ci.polish.reason, "build_output_missing", "the second funnel has no _site/<route>/ of its own yet");
  for (const [f, status] of [[first, "owed"], [second, "unknown"]]) {
    const projected = readback([p.target, "--packet", f.packetPath, "--json"]);
    assert.equal(projected.json.evidence_debt.polish.status, status, `${f.route}: readback evidence debt`);
  }

  await runFunnel(p, second);
  const afterSecond = snapshot(p.target);
  assert.deepEqual(changedBetween(firstDone, ownedBy(first, afterSecond)), [], "the second funnel's setup, build, doctor and QA changed none of the first funnel's files");
  assert.ok(changedBetween(secondBefore, ownedBy(second, afterSecond)).length > 0, "the second funnel's own records moved");

  // Each funnel's QA sidecar sits in its own runtime directory, beside its packet.
  assert.equal(readJson(join(p.target, ".campaign-runtime/qa-verdict.json")).campaign_slug, first.packet.spec.map_id);
  assert.equal(readJson(join(p.target, ".campaign-runtime/funnels", SECOND, "qa-verdict.json")).campaign_slug, second.packet.spec.map_id);
  // ...and each doctor output in its own.
  assert.equal(readJson(join(p.target, ".campaign-runtime/doctor-output.json")).derived.public_route_slug, FIRST);
  assert.equal(readJson(join(p.target, ".campaign-runtime/funnels", SECOND, "doctor-output.json")).derived.public_route_slug, SECOND);

  // A later command for the first funnel leaves the second's records alone.
  const secondDone = ownedBy(second, afterSecond);
  await cli(["doctor", "--packet", first.packetPath, "--write", "--no-live-refs", "--json"], "doctor --write first again", { codes: [0, 2] });
  await cli(["record", "build", "--packet", first.packetPath, "--json"], "record build first again");
  assert.deepEqual(changedBetween(secondDone, ownedBy(second, snapshot(p.target))), [], "the first funnel's later commands changed none of the second funnel's files");

  // Every --packet command resolves to that funnel's records.
  for (const f of [first, second]) {
    const workspace = resolveCampaignWorkspace(f.packetPath, { followContextPointer: true });
    assert.equal(workspace.reportPath, f.reportPath, `${f.route}: workspace report`);
    assert.equal(workspace.contextPath, f.contextPath, `${f.route}: workspace context`);
    const ci = await runCli(["doctor", "--packet", f.packetPath, "--ci", "--no-live-refs", "--json"]);
    assert.equal(ci.error, null);
    assert.ok(ci.json?.ci, `${f.route}: doctor --ci assessed evidence debt`);
    assert.equal(ci.json.derived.assembly_report_path, f.reportPath, `${f.route}: doctor --ci read its own report`);
  }
});

test("#719: without --packet, readback and tooling status refuse to pick among funnels and name the packets", async (t) => {
  const p = project(t);
  const first = await setUpFunnel(p, FIRST);
  const second = await setUpFunnel(p, SECOND);

  const refused = readback([p.target, "--json"]);
  assert.equal(refused.exitCode, 2, refused.text);
  assert.match(refused.text, /more than one funnel/);
  assert.ok(refused.text.includes(`campaign-runtime-${SECOND}.build.json (route ${SECOND})`), refused.text);
  assert.ok(refused.text.includes(`campaign-runtime.build.json (route ${FIRST})`), refused.text);
  assert.match(refused.text, /Pass --packet/);

  // Named, each projects its own records.
  for (const f of [first, second]) {
    const { paths } = resolveProjection(p.target, { packet: f.packetPath });
    assert.equal(paths.report, f.reportPath, `${f.route}: readback reads its report`);
    assert.equal(paths.context, f.contextPath, `${f.route}: readback reads its context`);
    const projected = readback([p.target, "--packet", f.packetPath, "--json"]);
    assert.equal(projected.exitCode, 0, projected.text);
    const reportRow = projected.json.artifacts.find((row) => row.key === "report");
    assert.equal(resolve(reportRow.path), f.reportPath);
    assert.equal(reportRow.state, "loaded");
  }

  assert.throws(() => soleProjectPacket(p.target), (error) => error.code === "MULTIPLE_FUNNEL_PACKETS"
    && error.message.includes(`campaign-runtime-${SECOND}.build.json (route ${SECOND})`)
    && error.message.includes("--packet"));
});

// What 1.61.0 left in a single-funnel project: the default packet with no
// assembly.runtime_dir and every record directly under .campaign-runtime/.
async function legacyProject(t) {
  const p = project(t);
  const first = await setUpFunnel(p, FIRST);
  const packet = readJson(first.packetPath);
  assert.equal(packet.assembly.runtime_dir, undefined);
  await runFunnel(p, first);
  return { p, first };
}

test("#719: a single-funnel project from the current layout reads its existing records unchanged", async (t) => {
  const { p, first } = await legacyProject(t);
  const before = snapshot(p.target);

  const workspace = resolveCampaignWorkspace(first.packetPath, { followContextPointer: true });
  assert.equal(workspace.runtimeDir, join(p.target, ".campaign-runtime"));
  assert.equal(workspace.reportPath, join(p.target, ".campaign-runtime/assembly-report.json"));
  assert.equal(workspace.contextPath, join(p.target, ".campaign-runtime/build-context.json"));
  assert.equal(workspace.doctorOutPath, join(p.target, ".campaign-runtime/doctor-output.json"));
  assert.equal(workspace.packetRuntimeDir, join(p.target, ".campaign-runtime"));

  const projected = readback([p.target, "--json"]);
  assert.equal(projected.exitCode, 0, projected.text);
  assert.equal(projected.json.packet_selection.selected, "campaign-runtime.build.json");
  for (const key of ["report", "context", "doctor", "qa_verdict"]) {
    const row = projected.json.artifacts.find((entry) => entry.key === key);
    assert.equal(row.state, "loaded", `${key} read where 1.61.0 wrote it`);
    assert.equal(row.path, join(p.target, ".campaign-runtime", basename(row.path)), `${key} at the project-level path`);
  }
  const next = await cli(["next", "--packet", first.packetPath, "--no-write", "--no-live-refs", "--json"], "next");
  assert.ok(next.json);
  assert.deepEqual(changedBetween(before, snapshot(p.target)), [], "reading the records changed nothing");
  assert.equal(soleProjectPacket(p.target), first.packetPath);

  // A rerun of setup for the same funnel keeps the project-level layout.
  assert.deepEqual(planFunnelWorkspace(p.target, FIRST), { packetPath: first.packetPath, runtimeRelPath: ".campaign-runtime", scoped: false });
  assert.ok(!existsSync(join(p.target, ".campaign-runtime/funnels")));
});

test("#719: adding a funnel to a single-funnel project leaves the existing funnel's records where they were", async (t) => {
  const { p, first } = await legacyProject(t);
  const before = ownedBy(first, snapshot(p.target));
  const second = await setUpFunnel(p, SECOND);
  await runFunnel(p, second);
  assert.deepEqual(changedBetween(before, ownedBy(first, snapshot(p.target))), [], "the existing funnel's records are byte-identical");
  assert.equal(resolveCampaignWorkspace(first.packetPath, { followContextPointer: true }).reportPath, join(p.target, ".campaign-runtime/assembly-report.json"));
  assert.equal(readJson(join(p.target, ".campaign-runtime/assembly-report.json")).identity.public_route_slug, FIRST);
});

test("#719: a packet whose runtime_dir names another funnel's records is refused, not followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-funnels-"));
  try {
    const packetPath = join(dir, "campaign-runtime-b.build.json");
    for (const runtime_dir of [".campaign-runtime/funnels/a", ".campaign-runtime/../elsewhere", "/abs", ".campaign-runtime/funnels/b/x"]) {
      writeJson(packetPath, { campaign: { public_route_slug: "b" }, assembly: { target_repo: ".", runtime_dir } });
      assert.throws(() => resolveCampaignWorkspace(packetPath, { followContextPointer: false }), /assembly\.runtime_dir/, runtime_dir);
    }
    writeJson(packetPath, { schema_version: "campaign-runtime-build-packet/v0", campaign: { public_route_slug: "b" }, assembly: { target_repo: ".", runtime_dir: ".campaign-runtime/funnels/a" } });
    const refused = readback([dir, "--packet", packetPath, "--json"]);
    assert.equal(refused.exitCode, 2, refused.text);
    assert.match(refused.text, /assembly\.runtime_dir/);
    writeJson(packetPath, { campaign: { public_route_slug: "b" }, assembly: { target_repo: ".", runtime_dir: ".campaign-runtime/funnels/b" } });
    assert.equal(resolveCampaignWorkspace(packetPath, { followContextPointer: false }).reportPath, join(dir, ".campaign-runtime/funnels/b/assembly-report.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#719: planFunnelWorkspace never hands one route another route's packet or records", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-funnels-"));
  try {
    // Empty project: the first funnel takes the defaults.
    assert.deepEqual(planFunnelWorkspace(dir, "alpha"), { packetPath: join(dir, "campaign-runtime.build.json"), runtimeRelPath: ".campaign-runtime", scoped: false });
    // Project-level records owned by alpha (by the report's identity): beta is scoped.
    writeJson(join(dir, ".campaign-runtime/assembly-report.json"), { identity: { public_route_slug: "alpha" } });
    writeJson(join(dir, "campaign-runtime.build.json"), { campaign: { public_route_slug: "alpha" }, assembly: {} });
    assert.deepEqual(planFunnelWorkspace(dir, "beta"), { packetPath: join(dir, "campaign-runtime-beta.build.json"), runtimeRelPath: ".campaign-runtime/funnels/beta", scoped: true });
    // An explicit --out keeps its path; the records still go to beta's own directory.
    assert.deepEqual(planFunnelWorkspace(dir, "beta", { packetPath: join(dir, "config/beta.json") }), { packetPath: join(dir, "config/beta.json"), runtimeRelPath: ".campaign-runtime/funnels/beta", scoped: true });
    // Records whose route cannot be read are never claimed.
    writeFileSync(join(dir, ".campaign-runtime/assembly-report.json"), "{ not json");
    rmSync(join(dir, "campaign-runtime.build.json"));
    assert.equal(planFunnelWorkspace(dir, "gamma").runtimeRelPath, ".campaign-runtime/funnels/gamma");
    // A route that cannot name a directory may still take a free project...
    const empty = mkdtempSync(join(tmpdir(), "campaigns-os-funnels-"));
    try {
      assert.equal(planFunnelWorkspace(empty, "a/b").runtimeRelPath, ".campaign-runtime");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // ...but never another funnel's.
    assert.throws(() => planFunnelWorkspace(dir, "../escape"), /cannot name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
