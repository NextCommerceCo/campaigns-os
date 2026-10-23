import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertNoNetworkAttempts, campaignFixture, readJson, writeJson, ROOT } from "./qc-test-factories.mjs";

const { synthesizeHtmlFunnelDesignSourcePackage, serializeDesignSourcePackage, validateDesignSourcePackage } = await import("./design-source-package.mjs");
const { createCampaignBuildBriefArtifact } = await import("./build-brief.mjs");
const { resolveDesignFileReferences } = await import("./design-file-reference.mjs");
const { summarizeCampaignBrief } = await import("./brief-summary.mjs");
const { evaluateDesignAccess } = await import("./parity/design-access.mjs");
const { buildQcHandoff, qcHandoffTextLines } = await import("./qc-accept.mjs");
const { validatePacket } = await import("./doctor/checks.mjs");
const { doctorPacket } = await import("./doctor/inspect.mjs");
afterEach(assertNoNetworkAttempts);
const BASE = "505aada92c94cecf9106bb1fb1e818d9dadee46d";
let source = execFileSync("git", ["show", `${BASE}:src/doctor/checks.mjs`], { cwd: ROOT, encoding: "utf8", maxBuffer: 2 ** 22 });
source = source.replace(/from "(\.[^\"]+)"/g, (_, specifier) => `from ${JSON.stringify(new URL(specifier, new URL("./doctor/checks.mjs", import.meta.url)).href)}`);
const baseDoctor = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const A = "https://www.figma.com/design/SYNTHKEYA0001/synthetic-file?node-id=1-2";
const B = "https://www.figma.com/design/SYNTHKEYB0002/synthetic-other";
const MISSING = "A design file is recorded for this page, but this version of Campaigns OS cannot read design files. Element parity compares the built page with the page's source HTML export instead, so differences between the export and the design file are not checked. Nothing needs to change to continue. Where it matters, compare the export with the design file by hand.";
const now = "2026-08-22T10:00:00.000Z";
const canonical = (value) => JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const SHA_A = hash({ type: "figma", file_key: "SYNTHKEYA0001" });
const CID_A = `design-file-${SHA_A.slice(0, 12)}`;
function input(file = { file_url: A }) {
  return { activePages: [{ id: "landing", type: "landing" }], mappings: [{ page_id: "landing", path: "landing.html" }], manifest: { schema_version: "source-html-manifest/v0", pages: [{ page_id: "landing", path: "landing.html", ...(file ? { design_file: file } : {}) }] }, generatedAt: now };
}
function draft(args) {
  return createCampaignBuildBriefArtifact({ activePages: args.activePages, pageMappings: args.mappings, designFiles: resolveDesignFileReferences(args).pages }).artifact;
}
function rows(args, dsp = synthesizeHtmlFunnelDesignSourcePackage(args)) {
  return evaluateDesignAccess({ ...args, designSourcePackage: dsp, measured_at: now });
}
function assertMissing(args, dsp) {
  const actual = rows(args, dsp);
  const [row] = actual;
  const other = args.manifest?.pages[0]?.design_file?.file_url?.includes("design.example.test");
  const sha = other ? hash({ type: "other", url: "https://design.example.test/f/synthetic-b" }) : SHA_A;
  const subject = { check: "design.access", page: "landing", key: "file" };
  const state = { reason_code: "design_access_missing", recorded_identity_sha256: sha, declared_identity_sha256: sha, conflict_identities: [], conflict_frames: [] };
  assert.deepEqual(actual, [{ schema: "campaigns-os-qc-result/v0", id: "design.access:landing:file", check: "design.access", leg: "doctor", subject, result: "unexercised", reason_code: "design_access_missing", state,
    state_fingerprint: `sha256:${hash({ scope: "qc", subject, state })}`,
    observation: { type: other ? "other" : "figma", kind: null, declared_by: args.activePages[0].design_source ? "campaign_spec" : "source_html_manifest", frames_declared: Object.keys(args.manifest?.pages[0]?.design_file?.breakpoints || {}).sort(), reader: "none", recorded_contribution_id: `design-file-${sha.slice(0, 12)}` },
    members: [], accept_eligible: false, coverage: { observed: 1, expected: 1, limits: [] }, measured_at: now, producer: "campaigns-os doctor" }]);
  const text = qcHandoffTextLines(buildQcHandoff({ results: [row] }));
  assert.deepEqual(text.filter((line) => line.includes("design.access")), [`  - doctor design.access: unexercised (design_access_missing) x1 on landing — ${MISSING}`]);
  return row;
}

test("P1-W1: HTML export records the file, derivation, brief authority and exact unexercised Coverage text", (t) => {
  const mobile = A.replace("1-2", "3-4");
  const args = input({ type: "figma", file_url: A, breakpoints: { desktop: A, mobile } });
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
  const plain = synthesizeHtmlFunnelDesignSourcePackage(input(null));
  assert.equal(validateDesignSourcePackage(dsp).ok, true);
  const design = dsp.contributions[1];
  assert.equal(design.id, CID_A);
  assert.deepEqual(design, {
    id: CID_A, kind: "figma_frames", trust: "native", renderable: false,
    provenance: { source_type: "design_file", adapter: "design-file-reference", producer: "source_html_manifest", generator: null, generator_version: null, source_root: null, manifest_schema_version: "source-html-manifest/v0", manifest_path: null, manifest_sha256: null, producer_material_fingerprint: null, asset_crawl_schema_version: null },
    presentation_intent: { summary: "Design file the page's HTML export was produced from. Recorded as the design authority; this version does not read it." },
    source_refs: [{ id: `${CID_A}-file`, kind: "url", url: A, role: "design_file" }, { id: `${CID_A}-landing-frame-desktop`, kind: "url", url: A, role: "design_frame:desktop" }, { id: `${CID_A}-landing-frame-mobile`, kind: "url", url: mobile, role: "design_frame:mobile" }],
    screenshot_refs: [], reference_refs: [], mappings: [{ id: `${CID_A}-landing-coverage`, surface_id: "landing", coverage_role: "reference_only", confidence: "high", source_refs: [`${CID_A}-file`, `${CID_A}-landing-frame-desktop`, `${CID_A}-landing-frame-mobile`], screenshot_refs: [], reference_refs: [] }],
  });
  assert.deepEqual([design.kind, design.trust, design.renderable, design.provenance.producer], ["figma_frames", "native", false, "source_html_manifest"]);
  assert.deepEqual(design.source_refs.map((ref) => ref.role), ["design_file", "design_frame:desktop", "design_frame:mobile"]);
  assert.deepEqual([design.mappings[0].surface_id, design.mappings[0].coverage_role, design.mappings[0].confidence], ["landing", "reference_only", "high"]);
  assert.equal(dsp.contributions[0].mappings[0].derived_from, design.id);
  assert.deepEqual(dsp.readiness, plain.readiness);
  assert.deepEqual(dsp.source_todos, plain.source_todos);
  const brief = draft(args);
  t.diagnostic(JSON.stringify({ design_contribution: design, html_mapping: dsp.contributions[0].mappings[0], design_authority: brief.design_authority.landing }));
  assert.deepEqual(brief.design_authority.landing, { source: "design_file", reference: A, frames: { desktop: A, mobile }, derived_artifact: { source: "provided_design_export", reference: "landing.html" } });
  assert.ok(summarizeCampaignBrief({ brief, activePageIds: ["landing"] }).text.split("\n")[3].includes("landing follow the design file, built from its HTML export [default]"));
  assertMissing(args, dsp);
  assert.deepEqual(rows(input(null)), []);
  assert.deepEqual(buildQcHandoff({ results: [] }).coverage, []);
});

test("P1-W3: shared identity has page-local frame refs and first-page file URL, in either spec order", () => {
  const args = input({ file_url: A, breakpoints: { desktop: A } });
  const renamed = "https://www.figma.com/design/SYNTHKEYA0001/renamed?node-id=7-8";
  args.activePages.push({ id: "checkout", type: "checkout" });
  args.mappings.push({ page_id: "checkout", path: "checkout.html" });
  args.manifest.pages.push({ page_id: "checkout", path: "checkout.html", design_file: { file_url: renamed, breakpoints: { desktop: renamed } } });
  for (const firstUrl of [A, renamed]) {
    const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
    assert.equal(dsp.contributions.length, 2);
    const design = dsp.contributions[1];
    assert.equal(design.id, CID_A);
    assert.equal(design.source_refs[0].url, firstUrl);
    assert.deepEqual(design.source_refs, [
      { id: `${CID_A}-file`, kind: "url", url: firstUrl, role: "design_file" },
      ...args.activePages.map((page) => ({ id: `${CID_A}-${page.id}-frame-desktop`, kind: "url", url: page.id === "landing" ? A : renamed, role: "design_frame:desktop" })),
    ]);
    assert.deepEqual(design.mappings, args.activePages.map((page) => ({ id: `${CID_A}-${page.id}-coverage`, surface_id: page.id, coverage_role: "reference_only", confidence: "high", source_refs: [`${CID_A}-file`, `${CID_A}-${page.id}-frame-desktop`], screenshot_refs: [], reference_refs: [] })));
    assert.ok(dsp.contributions[0].mappings.every((mapping) => mapping.derived_from === design.id));
    const brief = draft(args);
    assert.deepEqual(brief.design_authority, Object.fromEntries([["landing", A], ["checkout", renamed]].map(([id, url]) => [id, { source: "design_file", reference: url, frames: { desktop: url }, derived_artifact: { source: "provided_design_export", reference: `${id}.html` } }])));
    assert.equal(new Set(design.mappings.flatMap((mapping) => mapping.source_refs.filter((id) => id !== `${design.id}-file`))).size, 2);
    args.activePages.reverse();
  }
});

test("P1-I1: a file without frames records only a file ref and cannot pass", () => {
  const args = input();
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
  assert.deepEqual(dsp.contributions[1].source_refs, [{ id: `${CID_A}-file`, kind: "url", url: A, role: "design_file" }]);
  assert.deepEqual(draft(args).design_authority.landing.frames, {});
  assertMissing(args, dsp);
});

test("P1-I2: a non-Figma file is opaque and identified by origin plus pathname", () => {
  const args = input({ file_url: "https://design.example.test/f/synthetic-b?x=1#frame" });
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
  assert.deepEqual([dsp.contributions[1].kind, dsp.contributions[1].trust], ["other", "opaque"]);
  assert.deepEqual(resolveDesignFileReferences(args).files[0].identity, { type: "other", url: "https://design.example.test/f/synthetic-b" });
  assertMissing(args, dsp);
});

test("P1-I3: a stated prepared authority and its summary are kept", (t) => {
  const fixture = campaignFixture();
  t.after(fixture.cleanup);
  const args = input();
  const path = join(fixture.dir, "stated-brief.json");
  const brief = draft(input(null));
  brief.brief_mode = "prepared";
  writeJson(path, brief);
  const before = createCampaignBuildBriefArtifact({ inputPath: path, activePages: args.activePages, pageMappings: args.mappings }).artifact;
  const after = createCampaignBuildBriefArtifact({ inputPath: path, activePages: args.activePages, pageMappings: args.mappings, designFiles: resolveDesignFileReferences(args).pages }).artifact;
  assert.equal(after.design_authority.landing.source, "provided_design_export");
  assert.deepEqual(after.design_authority, before.design_authority);
  assert.equal(summarizeCampaignBrief({ brief: after, activePageIds: ["landing"] }).text, summarizeCampaignBrief({ brief: before, activePageIds: ["landing"] }).text);
  assertMissing(args);
});

test("P1-I4: a skipped page's design declaration changes no package, brief or QC row", () => {
  const args = input();
  delete args.manifest.pages[0].path;
  args.manifest.pages[0].skip_reason = "template stock";
  args.mappings = [{ page_id: "landing", skip_reason: "template stock" }];
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
  const brief = draft(args);
  assert.deepEqual(rows(args, dsp), [], "the original skipped declaration must have no QC row");
  delete args.manifest.pages[0].design_file;
  assert.equal(serializeDesignSourcePackage(dsp), serializeDesignSourcePackage(synthesizeHtmlFunnelDesignSourcePackage(args)));
  assert.deepEqual(brief.design_authority, draft(args).design_authority);
  assert.deepEqual(rows(args, dsp), []);
});

function runGateFixture(t, { manifestFile = null, specFile = A, specFrames = null, producerKey = "SYNTHKEYA0001", valid = true, absent = false } = {}) {
  const fixture = campaignFixture();
  t.after(fixture.cleanup);
  const packet = readJson(fixture.packetPath);
  const spec = readJson(fixture.specPath);
  const activePages = spec.funnels.flatMap((funnel) => funnel.pages);
  if (specFile) activePages[0].design_source = { type: "figma", file_url: specFile, ...(specFrames ? { breakpoints: specFrames } : {}) };
  writeJson(fixture.specPath, spec);
  const manifest = { schema_version: "source-html-manifest/v0", generator: valid ? "figma-sections-export" : "synthetic-exporter", producer_provenance: valid ? { source_type: "semantic_figma_export", screenshot_fallback_used: false, semantic_section_count: 1, material_fingerprint: "a".repeat(64), figma_file_key: "SYNTHKEYA0001", section_exports: [{ section: "hero", type: "html", node_ids: { desktop: "1:2" } }] } : {}, files: [{ path: "section.html", role: "partial", sha256: "b".repeat(64) }, { path: "asset.png", role: "asset", sha256: "c".repeat(64) }], pages: packet.source_html.pages.map((page) => ({ page_id: page.page_id, path: page.path, ...(page.page_id === activePages[0].id && manifestFile ? { design_file: manifestFile } : {}) })) };
  const manifestPath = join(fixture.dir, "source-html/.campaigns-os/source-html-manifest.json");
  if (valid) manifest.producer_provenance.figma_file_key = producerKey;
  if (absent) rmSync(manifestPath, { force: true }); else writeJson(manifestPath, manifest);
  const args = { activePages, mappings: packet.source_html.pages, manifest: absent ? null : manifest, generatedAt: now };
  const dsp = synthesizeHtmlFunnelDesignSourcePackage(args);
  const dspPath = join(fixture.dir, "design-source-package.json");
  writeFileSync(dspPath, serializeDesignSourcePackage(dsp));
  packet.design_source_package = { path: "design-source-package.json", material_fingerprint: dsp.material_fingerprint };
  writeJson(fixture.packetPath, packet);
  const state = { context: null, report: readJson(fixture.reportPath) };
  const run = (fn) => {
    const errors = [], warnings = [], ready = [], derived = { doctor_checks: [], checkpoint_gates: [] };
    fn(packet, fixture.packetPath, errors, warnings, ready, derived, state);
    return { errors, warnings, ready, derived };
  };
  return { fixture, current: run(validatePacket), baseline: run(baseDoctor.validatePacket), dsp, args };
}

test("P1-W5: spec contribution records campaign_spec and the provenance gate equals BASE pass", (t) => {
  const { current, baseline, dsp } = runGateFixture(t);
  assert.equal(dsp.contributions[1].provenance.producer, "campaign_spec");
  assert.deepEqual(current.derived.checkpoint_gates, baseline.derived.checkpoint_gates);
  assert.ok(current.derived.checkpoint_gates.some((gate) => gate.id === "source_html.producer_provenance" && gate.status === "pass"));
});

test("P1-W6: filesystem mapping records spec authority without changing BASE provenance gates", (t) => {
  const { current, baseline, dsp, args } = runGateFixture(t, { valid: false, absent: true });
  assert.equal(dsp.contributions[1].provenance.producer, "campaign_spec");
  assert.deepEqual(current.derived.checkpoint_gates, baseline.derived.checkpoint_gates);
  assert.deepEqual(current.errors, baseline.errors);
  assert.deepEqual(current.derived.checkpoint_gates.filter((gate) => gate.id === "source_html.producer_provenance"), [], "BASE has no provenance checkpoint row when there is no manifest; retain that boundary");
  assertMissing(args, dsp);
});

test("P1-B1: doctor wires one conflict warning and leaves errors and provenance gate equal to BASE", (t) => {
  const { current, baseline } = runGateFixture(t, { manifestFile: { file_url: B } });
  assert.deepEqual(current.derived.checkpoint_gates, baseline.derived.checkpoint_gates);
  assert.deepEqual(current.errors, baseline.errors);
  assert.deepEqual(current.warnings.filter((issue) => issue.code.startsWith("built_output.design.access.")).map((issue) => issue.code), ["built_output.design.access.design_reference_conflict"]);
});

for (const [id, options] of [
  ["P1-B1", { manifestFile: { file_url: B } }],
  ["P1-B1b", { specFrames: { desktop: A }, manifestFile: { file_url: A, breakpoints: { desktop: A.replace("1-2", "5-6") } } }],
  ["P1-B2", { specFile: null, manifestFile: { file_url: A }, producerKey: "SYNTHKEYZ9999" }],
]) {
  test(`${id}: full doctor and next preserve status, errors, gates and selected stage on conflict`, (t) => {
    const conflict = runGateFixture(t, options);
    const plain = runGateFixture(t, { specFile: options.specFile === null ? null : A });
    assert.deepEqual(conflict.current.errors, conflict.baseline.errors);
    assert.deepEqual(conflict.current.derived.checkpoint_gates, conflict.baseline.derived.checkpoint_gates);
    const inspect = (fixture) => {
      const doctor = doctorPacket(fixture.packetPath);
      const command = spawnSync(process.execPath, [join(ROOT, "bin/campaigns-os.mjs"), "next", "--packet", fixture.packetPath, "--no-write", "--no-remit", "--json"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } });
      const next = JSON.parse(command.stdout);
      return { doctor, next };
    };
    const before = inspect(plain.fixture), after = inspect(conflict.fixture);
    const expectedStatus = (status) => status === "ready" ? "ready_with_warnings" : status;
    assert.equal(after.doctor.status, expectedStatus(before.doctor.status));
    assert.equal(after.next.status, expectedStatus(before.next.status));
    assert.equal(after.next.stage, before.next.stage);
    assert.deepEqual(after.doctor.errors, before.doctor.errors);
    assert.deepEqual(after.doctor.derived.checkpoint_gates, before.doctor.derived.checkpoint_gates);
    assert.deepEqual(after.doctor.warnings.filter((issue) => issue.code.startsWith("built_output.design.access.")).map((issue) => issue.code), ["built_output.design.access.design_reference_conflict"]);
  });
}
