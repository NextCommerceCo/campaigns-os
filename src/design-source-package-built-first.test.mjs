import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { assertNoNetworkAttempts, OPERATOR, readJson, ROOT, runCli, writeJson } from "./qc-test-factories.mjs";
import { BUILT_FIRST_LABEL, synthesizeHtmlFunnelDesignSourcePackage, evaluateDesignSourcePackageReadiness, validateDesignSourcePackage, computeDesignSourcePackageMaterialFingerprint, generateDesignSourcePackageReadback } from "./design-source-package.mjs";
import { parseArgs, prepareBuildRerunCommand } from "./cli.mjs";
import { runReadbackCommand } from "./readback.mjs";
import { applyQaPageScope } from "./qa-node.mjs";
import { assessEvidenceDebt } from "./evidence-debt.mjs";
import { evaluateDesignAccess } from "./parity/design-access.mjs";
import { evaluateElementParityCell } from "./parity/element-parity-record.mjs";
import { planQcAccepts, parseQcResultRef, buildQcHandoff } from "./qc-accept.mjs";
import { qcResultRef } from "./qc-results.mjs";

afterEach(assertNoNetworkAttempts);
const synthesize = (adopted = false, extra = {}) => synthesizeHtmlFunnelDesignSourcePackage({
  adopted, activePages: [{ id: "landing", type: "landing" }],
  mappings: [{ page_id: "landing", path: "landing.html", confidence: "high" }],
  generatedAt: "2026-01-01T00:00:00.000Z", ...extra,
});

// The checkpoint before built-first, pinned by commit. A shallow checkout (CI
// on a push to main fetches depth 1) does not hold it, so the comparison is
// skipped there, as src/polish-visual.test.mjs does for its pinned baseline.
const REVIEWED_CHECKPOINT = "b3fe6ea7a357d5a4737bbb5319c3a8e457e7f997";
test("the reviewed checkpoint blocks the same adopted four-page intake on twelve missing-source reasons", async (t) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${REVIEWED_CHECKPOINT}^{commit}`], { cwd: ROOT, stdio: "ignore" });
  } catch {
    t.skip(`Pinned checkpoint ${REVIEWED_CHECKPOINT} is absent from this checkout, or git is unavailable`);
    return;
  }
  const previousSource = execFileSync("git", ["show", `${REVIEWED_CHECKPOINT}:src/design-source-package.mjs`], { cwd: ROOT, encoding: "utf8" })
    .replace('"./design-file-reference.mjs"', JSON.stringify(new URL("./design-file-reference.mjs", import.meta.url).href));
  const previous = await import(`data:text/javascript;base64,${Buffer.from(previousSource).toString("base64")}`);
  const input = { adopted: true, generatedAt: "2026-01-01T00:00:00.000Z",
    activePages: ["landing", "checkout", "upsell", "receipt"].map((id) => ({ id, type: id === "receipt" ? "thankyou" : id })),
    mappings: ["landing", "checkout", "upsell", "receipt"].map((page_id) => ({ page_id, path: `${page_id}.html`, confidence: "high" })),
  };
  const before = previous.synthesizeHtmlFunnelDesignSourcePackage(input);
  assert.equal(before.readiness.status, "blocked");
  assert.equal(before.readiness.blocking_reasons.length, 12);
  assert.ok(before.readiness.blocking_reasons.every((reason) => /source_screenshot proof|Source TODO "capture-/.test(reason)));
  const after = synthesizeHtmlFunnelDesignSourcePackage(input);
  assert.equal(after.readiness.status, "ready");
  assert.deepEqual(after.readiness.blocking_reasons, []);
});

test("built first removes only screenshot debt and labels readiness; ordinary reasons are unchanged", () => {
  const ordinary = synthesize();
  assert.deepEqual(ordinary.readiness.blocking_reasons, [
    'Renderable primary_design surface "landing" has no qualifying claim with linked desktop and mobile source_screenshot proof.',
    'Source TODO "capture-landing-desktop" is blocked.',
    'Source TODO "capture-landing-mobile" is blocked.',
  ]);
  const built = synthesize(true);
  assert.equal(built.source_kind, "built_first");
  assert.equal(built.contributions[0].kind, "built_first");
  assert.deepEqual(built.readiness, { status: "ready", source_basis: "built_first", label: BUILT_FIRST_LABEL,
    blocking_reasons: [], gap_count: 0, todo_count: 0, waiver_count: 0, generated_at: built.generated_at });
  const schema = readJson(join(ROOT, "schemas/campaign-design-source-package.v0.schema.json"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.ok(validate(built), JSON.stringify(validate.errors));
  const unlabelled = structuredClone(built);
  delete unlabelled.readiness.label;
  assert.equal(validate(unlabelled), false, "built-first readiness requires its label");
  assert.equal(validateDesignSourcePackage(built, { verifyFingerprint: true }).ok, true);
  const withTodos = { ...built, source_todos: ordinary.source_todos };
  assert.equal(evaluateDesignSourcePackageReadiness(withTodos).status, "ready");
  withTodos.source_todos.push({ id: "other", kind: "other", status: "blocked" });
  assert.deepEqual(evaluateDesignSourcePackageReadiness(withTodos).blocking_reasons, ['Source TODO "other" is blocked.']);
  const gap = synthesize(true, { sourceGaps: [{ id: "example-gap", kind: "source_limitation", scope: "campaign", applies_to: ["campaign"], reason: "Example unresolved gap", status: "proposed", attributed_by: "Example operator" }] });
  assert.equal(gap.readiness.status, "blocked");
  assert.match(gap.readiness.blocking_reasons[0], /Source Gap/);
  assert.equal(evaluateDesignSourcePackageReadiness({ ...built, surface_identity: [] }).status, "pending");
});

test("built-first design access and parity are excluded and cannot be accepted", () => {
  const dsp = synthesize(true);
  const rows = [...evaluateDesignAccess({ activePages: [{ id: "landing" }], designSourcePackage: dsp }),
    ...evaluateElementParityCell({ page_id: "landing", viewport: "desktop", builtFirst: true })];
  for (const row of rows) {
    assert.equal(row.result, "excluded");
    assert.equal(row.reason_code, "built_first");
    assert.equal(row.accept_eligible, false);
    assert.throws(() => planQcAccepts({ refs: [parseQcResultRef(qcResultRef(row))], results: rows }), /only a warning can be accepted/);
  }
  assert.ok(buildQcHandoff({ results: rows }).coverage.filter((entry) => entry.result === "excluded").every((entry) => entry.text.includes("not applicable: built first")));
});

async function adoptedFixture(t, adopt = true, { mapSlug = "long-campaign-name", existingFunnel = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-built-first-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target");
  const source = join(target, "src/short");
  cpSync(join(ROOT, "examples/source-html"), source, { recursive: true });
  writeJson(join(target, "package.json"), { private: true, devDependencies: { "next-campaign-page-kit": "0.2.0" } });
  const spec = readJson(join(ROOT, "examples/campaignspec.v42.basic.json"));
  spec.spec_identity.public_route_slug = mapSlug;
  spec.campaign.slug = mapSlug;
  for (const funnel of spec.funnels) for (const page of funnel.pages) delete page.sdk_hints;
  const specPath = join(dir, "spec.json");
  writeJson(specPath, spec);
  if (existingFunnel) writeJson(join(target, "campaign-runtime.build.json"), { campaign: { public_route_slug: "other" }, assembly: {} });
  writeJson(join(target, "_data/campaigns.json"), { short: { ...spec.campaign, sdk_version: spec.global_config.sdk_version } });
  const args = ["prepare-build", "--spec", specPath, "--target", target, "--template-family", "olympus", "--no-run-session", "--no-remit", "--json"];
  const result = await runCli([...args, ...(adopt ? ["--adopt", "src/short"] : ["--route", "short", "--source", source])]);
  assert.equal(result.error, null, result.error?.stack);
  assert.equal(result.exitCode, 0, result.stdout);
  return { ...result.json, args, dir, target, source };
}

test("adopted route clears screenshot gate, labels doctor/next/readback, and refuses baseline and page-only first QA", async (t) => {
  const f = await adoptedFixture(t);
  const dsp = readJson(join(dirname(f.packetPath), f.packet.design_source_package.path));
  assert.equal(dsp.source_kind, "built_first");
  assert.equal(dsp.readiness.status, "ready");
  assert.ok(!f.report.stages.prepare_build.blockers.some((issue) => issue.code === "DESIGN_SOURCE_PACKAGE_NOT_READY"));
  // The built pages need no design screenshots. The fixture HTML is synthetic
  // inert output; the fingerprint is the same one doctor uses.
  for (const page of f.packet.source_html.pages) {
    const route = page.page_kit.public_route.replace(/^\/short\//, "");
    const file = join(f.target, "_site/short", route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '<!doctype html><html><head><title>Example</title></head><body><p>Example page</p></body></html>');
  }
  const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
  assert.equal(doctor.error, null, doctor.error?.stack);
  assert.equal(doctor.json.ok, true, JSON.stringify(doctor.json.errors));
  assert.ok(!doctor.json.errors.some((issue) => /DESIGN_SOURCE_PACKAGE|design_source_package/.test(issue.code)), JSON.stringify(doctor.json.errors));
  assert.equal(doctor.json.warnings.find((issue) => issue.code === "design_source.built_first")?.message, BUILT_FIRST_LABEL);
  const next = await runCli(["next", "--packet", f.packetPath, "--no-write", "--no-remit", "--json"]);
  assert.ok(next.json.prompt.includes(BUILT_FIRST_LABEL), next.stdout);
  assert.ok(runReadbackCommand(parseArgs(["readback", f.target, "--packet", f.packetPath])).text.includes(BUILT_FIRST_LABEL));
  const reportPath = join(f.target, ".campaign-runtime/funnels/short/assembly-report.json");
  const recorded = await runCli(["record", "build", "--packet", f.packetPath, "--json"]);
  assert.equal(recorded.error, null, recorded.error?.stack);
  const report = readJson(reportPath);
  const baseline = await runCli(["record", "baseline", "--packet", f.packetPath, "--accepted-by", OPERATOR, "--reason", "Synthetic legacy acceptance", "--dry-run", "--json"]);
  assert.match(`${baseline.error?.message || ""} ${baseline.stdout}`, /no completed deploy or QA/);
  const debt = assessEvidenceDebt({ packet: f.packet, packetPath: f.packetPath, report });
  assert.throws(() => applyQaPageScope([{ pages: [{ page_id: "landing", url: "http://127.0.0.1:9/short/landing/" }] }], {
    pages: ["landing"], baseUrl: "http://127.0.0.1:9/short/", debt, report,
  }), /full QA run/);
  t.diagnostic(`readiness: ${JSON.stringify(dsp.readiness)}`);
  t.diagnostic(`doctor/next/readback: ${BUILT_FIRST_LABEL}`);
});

test("route with source keeps screenshot blockers; --adopt cannot convert an existing package, even with --force", async (t) => {
  const f = await adoptedFixture(t, false);
  const dsp = readJson(join(dirname(f.packetPath), f.packet.design_source_package.path));
  assert.equal(dsp.source_kind, "html_funnel");
  assert.equal(dsp.readiness.status, "blocked");
  const doctor = await runCli(["doctor", "--packet", f.packetPath, "--no-live-refs", "--json"]);
  assert.doesNotMatch(JSON.stringify(doctor.json), /design_source\.built_first/, "ordinary doctor output, including its check trace, contains no built-first label");
  assert.ok(f.report.stages.prepare_build.blockers.some((issue) => issue.code === "DESIGN_SOURCE_PACKAGE_NOT_READY"));
  for (const extra of [[], ["--force"]]) {
    const result = await runCli([...f.args, "--adopt", "src/short", ...extra]);
    assert.match(result.error?.message || result.stdout, /cannot change its source kind/);
    assert.match(result.error?.message || result.stdout, /existing package is not built first/);
    assert.doesNotMatch(result.error?.message || result.stdout, /Built first is declared only by --adopt at intake/);
    assert.equal(readFileSync(join(dirname(f.packetPath), f.packet.design_source_package.path), "utf8"), JSON.stringify(dsp, null, 2) + "\n");
  }
});

// Commands below are produced from this test's synthetic inputs. Exercise the
// printed argv, rather than a second hand-written approximation of recovery.
function replayArgs(command) {
  const words = [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const start = words.findIndex((word) => ["start", "prepare-build", "build"].includes(word));
  assert.ok(start >= 0, command);
  return [...words.slice(start), "--no-run-session", "--no-remit", "--json"];
}

async function assertBuiltFirstReplay(f, argv) {
  const result = await runCli(argv);
  assert.equal(result.error, null, result.error?.stack);
  assert.ok(result.json?.packet, result.stdout);
  const dsp = readJson(join(dirname(result.json.packetPath), result.json.packet.design_source_package.path));
  assert.equal(dsp.source_kind, "built_first");
  assert.equal(result.json.context.intake.adopt, "src/short");
  return result;
}

for (const command of ["prepare-build", "start", "build"]) {
  test(`${command}: stored adoption and recovery argv replay the existing built-first package`, async (t) => {
    const f = await adoptedFixture(t);
    assert.equal(f.context.intake.adopt, "src/short");
    const intake = f.context.intake;
    const fromContext = [command, "--spec", join(f.target, intake.spec_path), "--target", f.target,
      "--template-family", intake.template_family, "--adopt", intake.adopt, "--no-run-session", "--no-remit", "--json"];
    await assertBuiltFirstReplay(f, fromContext);
    const rerun = prepareBuildRerunCommand({ packet: f.packet, packetPath: f.packetPath, context: f.context, targetRepo: f.target });
    assert.match(rerun.command, /--adopt src\/short/);
    assert.doesNotMatch(rerun.command, /--route|--source/);
    await assertBuiltFirstReplay(f, replayArgs(rerun.command));
  });
}

test("recovery fallback preserves the package's built-first declaration when intake provenance is absent", async (t) => {
  const f = await adoptedFixture(t);
  // The fallback otherwise prefers a remote Map ID. This fixture is local.
  const packet = structuredClone(f.packet);
  delete packet.spec.map_id;
  for (const context of [null, { ...f.context, intake: { ...f.context.intake, adopt: undefined } }]) {
    const rerun = prepareBuildRerunCommand({ packet, packetPath: f.packetPath, context, targetRepo: f.target });
    assert.match(rerun.command, /--adopt src\/short/);
    assert.doesNotMatch(rerun.command, /--route|--source/);
    await assertBuiltFirstReplay(f, replayArgs(rerun.command));
  }
});

test("saved-Map recovery preserves adoption and replays from its cached spec without fetching", async (t) => {
  const f = await adoptedFixture(t);
  const mapId = f.packet.spec.map_id;
  cpSync(join(f.dir, "spec.json"), join(f.target, `.campaign-runtime/fetched-specs/${mapId}.json`));
  const context = structuredClone(f.context);
  context.intake.spec_source = "cache";
  context.intake.spec_path = null;
  context.intake.map_id = mapId;
  const rerun = prepareBuildRerunCommand({ packet: f.packet, packetPath: f.packetPath, context, targetRepo: f.target });
  assert.match(rerun.command, /--map-id /);
  assert.match(rerun.command, /--adopt src\/short/);
  assert.doesNotMatch(rerun.command, /--route|--source/);
  await assertBuiltFirstReplay(f, [...replayArgs(rerun.command), "--cached-spec"]);
});

test("source remedy and next's prompt/action retain adoption through blocked intake recovery", async (t) => {
  const f = await adoptedFixture(t);
  const path = join(dirname(f.packetPath), f.packet.design_source_package.path);
  const dsp = readJson(path);
  dsp.source_gaps.push({ id: "example-gap", kind: "source_limitation", scope: "campaign", applies_to: ["campaign"], reason: "Example unresolved gap", status: "proposed", attributed_by: "Example operator" });
  const save = () => {
    dsp.readiness = evaluateDesignSourcePackageReadiness(dsp, { generatedAt: dsp.generated_at });
    dsp.readback = generateDesignSourcePackageReadback(dsp);
    dsp.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(dsp);
    writeJson(path, dsp);
  };
  save();
  const blocked = await assertBuiltFirstReplay(f, [...f.args, "--adopt", "src/short"]);
  const blocker = blocked.json.report.stages.prepare_build.blockers.find((issue) => issue.code === "DESIGN_SOURCE_PACKAGE_NOT_READY");
  assert.match(blocker.message, /rerun prepare-build\/start with --adopt src\/short/);
  assert.doesNotMatch(blocker.message, /--source/);
  const next = await runCli(["next", "--packet", f.packetPath, "--no-write", "--no-remit", "--json"]);
  assert.match(next.json.prompt, /--adopt src\/short/);
  const action = next.json.next_actions.find((row) => row.id === "rerun_prepare_build");
  assert.ok(action, next.stdout);
  assert.match(action.command, /--adopt src\/short/);
  assert.doesNotMatch(action.command, /--route|--source/);
  // Resolve the blocker, then run each printed recovery against the package.
  dsp.source_gaps = [];
  save();
  await assertBuiltFirstReplay(f, replayArgs(action.command));
  const adopt = blocker.message.match(/--adopt (src\/short)/)[1];
  await assertBuiltFirstReplay(f, [...f.args, "--adopt", adopt]);
  const promptAdopt = next.json.prompt.match(/--adopt (src\/short)/)[1];
  await assertBuiltFirstReplay(f, [...f.args, "--adopt", promptAdopt]);
});

test("--force regenerates stale built-first inputs only when --adopt is repeated", async (t) => {
  const f = await adoptedFixture(t);
  const source = join(f.source, "landing.html");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n<!-- Example source revision -->\n`);
  const stale = await runCli([...f.args, "--adopt", "src/short"]);
  assert.match(stale.error?.message || stale.stdout, /--force/);
  await assertBuiltFirstReplay(f, [...f.args, "--adopt", "src/short", "--force"]);
  const path = join(dirname(f.packetPath), f.packet.design_source_package.path);
  const before = readFileSync(path, "utf8");
  for (const command of ["prepare-build", "start", "build"]) for (const force of [[], ["--force"]]) {
    const withoutAdopt = await runCli([command, ...f.args.slice(1), "--route", "short", "--source", f.source, ...force]);
    assert.match(withoutAdopt.error?.message || withoutAdopt.stdout, /built first.*--adopt src\/short/);
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("Funnel rename advice preserves adoption and its argv accepts the existing package", async (t) => {
  const f = await adoptedFixture(t, true, { mapSlug: "short", existingFunnel: true });
  rmSync(f.packetPath);
  const printed = await runCli([...f.args.filter((arg) => arg !== "--json"), "--adopt", "src/short"]);
  assert.equal(printed.error, null, printed.error?.stack);
  const line = printed.stdout.split("\n").find((line) => line.startsWith("Funnel:"));
  assert.match(line, /re-run prepare-build with .*--force --adopt src\/short/);
  const targetPacket = line.match(/--out (\S+)/)[1];
  assert.notEqual(targetPacket, f.packetPath);
  // Carry out the printed rename and its stated cleanup on synthetic files,
  // then replay those same flags over the package the rename just created.
  rmSync(f.packetPath);
  rmSync(dirname(f.reportPath), { recursive: true, force: true });
  const flags = replayArgs(line.slice(line.indexOf("prepare-build with")).replace("prepare-build with", "prepare-build").replace(/\.$/, "")).slice(1);
  for (let replay = 0; replay < 2; replay += 1) await assertBuiltFirstReplay(f, [...f.args, ...flags]);
});
