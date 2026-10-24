// Stream P3 end-to-end rows: the shipped comparator through the real
// `polish capture`, `next` and `checkpoint accept` commands (package Chromium,
// the sealed source browser, local synthetic pages under fixtures/parity/).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { computeBuildFingerprint } from "../built-site-scope.mjs";
import { main } from "../cli.mjs";
import { computeDesignSourcePackageMaterialFingerprint } from "../design-source-package.mjs";
import { POLISH_PRODUCER } from "../polish-gate.mjs";
import { sha256Hex } from "../png-header.mjs";
import { readParityFile } from "./snapshot.mjs";

const browserTest = process.env.CAMPAIGNS_OS_REQUIRE_BROWSER === "1" ? test : test.skip;
// These rows run the real commands; no run record or stage observation leaves the machine.
process.env.CAMPAIGNS_OS_TELEMETRY = "off";
const fixture = (name) => readFileSync(new URL(`../../fixtures/parity/${name}`, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const SOURCE = fixture("parity-hero-source.html");
const HERO_BUILD = fixture("parity-hero-build.html");
// The build page with its heading at `size` (the source's is 32px).
const headingAt = (bytes, size) => {
  const text = bytes.toString();
  assert.match(text, /h1 \{[^}]*font-size: 32px;/);
  return Buffer.from(text.replace(/(h1 \{[^}]*font-size: )32px;/, `$1${size};`));
};

async function listen(t, handler) {
  const server = createServer(handler), sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.close(done); for (const socket of sockets) socket.destroy(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// A complete campaign target with one mapped page (`landing`), its source
// HTML recorded in the Design Source Package, and a build served locally.
// `rebuild(bytes)` replaces the built page and records the new build
// fingerprint; `capture()`, `next()` and `accept(refs)` run the commands.
async function campaign(t, buildBytes) {
  const dir = mkdtempSync(resolve(tmpdir(), "parity-e2e-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let served = buildBytes;
  const origin = await listen(t, (req, res) => {
    const svg = req.url.split("?")[0].endsWith(".svg");
    res.setHeader("content-type", svg ? "image/svg+xml" : "text/html");
    res.end(svg ? fixture("parity-art.svg") : served);
  });
  const examples = new URL("../../examples/", import.meta.url);
  const targetRepo = resolve(dir, "target"), packetPath = resolve(dir, "campaign-runtime.build.json");
  const reportPath = resolve(targetRepo, ".campaign-runtime/assembly-report.json");
  const packet = readJson(new URL("build-packet.basic.json", examples));
  packet.campaign.route_root = `/${packet.campaign.public_route_slug}/`; packet.assembly.target_repo = "target";
  packet.source_html.pages = [packet.source_html.pages[0]];
  packet.design_source_package = { path: "dsp.json" };
  writeJson(packetPath, packet);
  writeFileSync(resolve(dir, packet.spec.local_path), readFileSync(new URL(packet.spec.local_path, examples)));
  const sourceRoot = resolve(dir, packet.source_html.root); mkdirSync(sourceRoot);
  writeFileSync(resolve(sourceRoot, packet.source_html.pages[0].path), SOURCE); writeFileSync(resolve(sourceRoot, "parity-art.svg"), fixture("parity-art.svg"));
  const dsp = { surface_identity: [{ id: "landing", kind: "page", mappings: { campaign_spec_page_id: "landing" } }], contributions: [{ id: "html-funnel", kind: "html_funnel",
    source_refs: [{ id: "source-landing-html", kind: "html_file", path: "landing.html", sha256: `sha256:${sha256Hex(SOURCE)}` }],
    mappings: [{ surface_id: "landing", source_refs: ["source-landing-html"], screenshot_refs: [] }], screenshot_refs: [] }] };
  writeJson(resolve(dir, "dsp.json"), dsp);
  const builtRoot = resolve(targetRepo, "_site", packet.campaign.public_route_slug);
  mkdirSync(resolve(builtRoot, "landing"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRepo }).status, 0);
  const report = readJson(new URL("assembly-report.example.json", examples));
  Object.assign(report.identity, { map_id: packet.spec.map_id, public_route_slug: packet.campaign.public_route_slug });
  report.inputs.packet_path = "../campaign-runtime.build.json"; report.evidence = [];
  report.design_source_package = { material_fingerprint: computeDesignSourcePackageMaterialFingerprint(dsp) };
  report.stages.polish = { stage: "polish", status: "completed_with_warnings", performed_by: POLISH_PRODUCER,
    completed_at: "2026-01-01T00:00:00.000Z", evidence: { visual_review: { screenshots: ["qa-output/landing-desktop.png"] } } };
  writeJson(reportPath, report);
  writeJson(resolve(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready", retained: "preserve" });
  // A rebuild: new page bytes on disk and served, the assembly stage's build
  // fingerprint, and the polish stage recorded against that build.
  const rebuild = (bytes) => {
    served = bytes;
    writeFileSync(resolve(builtRoot, "landing/index.html"), bytes);
    const fingerprint = computeBuildFingerprint(builtRoot).fingerprint;
    const current = readJson(reportPath);
    Object.assign(current.stages.assembly, { status: "completed", build_fingerprint: fingerprint });
    current.stages.polish.source_build_fingerprint = fingerprint;
    writeJson(reportPath, current);
    return fingerprint;
  };
  rebuild(buildBytes);
  const run = async (argv) => {
    const output = [], log = console.log, error = console.error, exitCode = process.exitCode;
    console.log = (...values) => output.push(values.join(" ")); console.error = () => {}; process.exitCode = undefined;
    try { await main(argv); } finally { console.log = log; console.error = error; process.exitCode = exitCode; }
    return output.join("\n");
  };
  return {
    targetRepo, packetPath, reportPath, rebuild,
    report: () => readJson(reportPath),
    capture: async () => JSON.parse(await run(["polish", "capture", "--packet", packetPath, "--base-url", `${origin}/`, "--json"])),
    next: async () => ({ text: await run(["next", "--packet", packetPath]), json: JSON.parse(await run(["next", "--packet", packetPath, "--json"])) }),
    accept: async (refs) => JSON.parse(await run(["checkpoint", "accept", "--packet", packetPath, ...refs.flatMap((ref) => ["--result", ref]),
      "--reason", "Synthetic heading size accepted for the test", "--accepted-by", "Sam Synthetic", "--json"])),
  };
}

// The open parity.element entries of `next --json`, flattened to one entry
// per result (a design element warned at both viewports is one group).
const openParity = (json) => json.qc_handoff.open.filter((group) => group.check === "parity.element").flatMap((group) => group.results ?? [group]);
const openRow = (json, viewport, category) => openParity(json).find((entry) => entry.viewport === viewport && entry.key.startsWith(`${category}:`));
// The parts of `next` that select the stage and report status (without the
// per-run fingerprints and temporary paths the gates and commands carry).
const selection = (json) => ({ status: json.status, stage: json.stage ?? null,
  gates: json.gates.map((gate) => [gate.id, gate.status, gate.code ?? null]), next_actions: json.next_actions.map((action) => [action.id, action.kind, action.stage ?? null]) });
// The design element the comparator keyed a row by, read from the cell's
// local snapshot file: {text, selector_path}.
function designElement(f, viewport, text) {
  const cell = f.report().stages.polish.evidence.visual_review.element_parity.cells.find((c) => c.viewport === viewport);
  return readParityFile(cell.source_html.snapshot_ref, f.targetRepo).value.probe.elements.find((element) => element.text === text);
}

browserTest("P3-E1: hero badges moved into a row below the image read a geom gap_differs warning, accept-eligible; next names the first badge, its selector and the move; polish status and stage selection unchanged", async (t) => {
  const control = await campaign(t, SOURCE);
  const hero = await campaign(t, HERO_BUILD);
  await control.capture();
  await hero.capture();
  const controlNext = await control.next();
  const heroNext = await hero.next();
  assert.equal(openParity(controlNext.json).length, 0, "an identical build has no parity warning");

  const geom = openRow(heroNext.json, "desktop", "geom");
  assert.ok(geom, JSON.stringify(heroNext.json.qc_handoff.open));
  assert.match(geom.result_ref, /^parity\.element:landing:desktop:geom:el-[a-f0-9]{12}@[a-f0-9]{12}$/);
  assert.deepEqual([geom.result, geom.reason_code, geom.accept_eligible], ["warning", "gap_differs", true]);
  assert.deepEqual(geom.members, [{ key: "gap", result: "warning", reason_code: "gap_differs" }]);
  assert.deepEqual(openParity(heroNext.json).filter((entry) => entry.viewport === "desktop").map((entry) => entry.key), [geom.key], "the move reports once, where the layout changed");
  const badge = designElement(hero, "desktop", "Badge one");
  const line = heroNext.text.split("\n").find((text) => text.includes("moved"));
  t.diagnostic(`next Open warnings line: ${line}`);
  const moved = /^ {2}- Badge one \((.+)\): moved \+(\d+(?:\.\d+)?)px against the element above \(gap, tolerance 6px\)$/.exec(line);
  assert.ok(moved, heroNext.text);
  assert.equal(moved[1], badge.selector_path);
  assert.ok(Math.abs(Number(moved[2]) - 108) <= 1, `moved +${moved[2]}px is 108 px within the rendering tolerance`);
  assert.ok(heroNext.text.includes(`${geom.result_ref} Badge one (${badge.selector_path}): moved +${moved[2]}px`), "the desktop result line carries its own ref and summary");
  assert.match(heroNext.json.qc_handoff.accept_command, new RegExp(`--result ${geom.result_ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  assert.equal(hero.report().stages.polish.status, control.report().stages.polish.status);
  assert.deepEqual(selection(heroNext.json), selection(controlNext.json));
});

browserTest("P3-E2: the build heading at 30px against 32px reads a type: font_size warning of -2; at 32.4px there is no row", async (t) => {
  const f = await campaign(t, headingAt(HERO_BUILD, "30px"));
  await f.capture();
  const first = await f.next();
  const type = openRow(first.json, "desktop", "type");
  assert.ok(type, JSON.stringify(first.json.qc_handoff.open));
  assert.deepEqual([type.result, type.reason_code, type.accept_eligible], ["warning", "font_size_differs", true]);
  assert.deepEqual(type.members, [{ key: "font_size", result: "warning", reason_code: "font_size_differs" }]);
  const line = first.text.split("\n").find((text) => text.includes(type.result_ref));
  t.diagnostic(`next Open warnings line (30px): ${line}`);
  assert.ok(line.endsWith(`${type.result_ref} Synthetic headline: font-size 32px → 30px (−2px, tolerance 0.6px) [members: font_size warning (font_size_differs)]`), line);

  f.rebuild(headingAt(HERO_BUILD, "32.4px"));
  await f.capture();
  const second = await f.next();
  assert.equal(designElement(f, "desktop", "Synthetic headline").font_size_px, 32);
  assert.deepEqual(openParity(second.json).filter((entry) => entry.key.startsWith("type:")), [], "0.4 px is inside the 0.6 px tolerance");
  assert.equal(second.text.includes("font-size"), false);
});

browserTest("P3-E3: an accepted 30px heading warning lapses (state_changed) when the rebuilt heading measures 31px, and the row is open again", async (t) => {
  const f = await campaign(t, headingAt(HERO_BUILD, "30px"));
  await f.capture();
  const before = await f.next();
  const type = openRow(before.json, "desktop", "type");
  assert.ok(type, JSON.stringify(before.json.qc_handoff.open));
  const accepted = await f.accept([type.result_ref]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const afterAccept = await f.next();
  assert.ok(afterAccept.json.qc_handoff.accepted.some((entry) => entry.result_ref === type.result_ref), "the accept applies to the 30px warning");
  assert.equal(openRow(afterAccept.json, "desktop", "type"), undefined);

  f.rebuild(headingAt(HERO_BUILD, "31px"));
  await f.capture();
  const after = await f.next();
  const resultId = type.result_ref.split("@")[0];
  const lapsed = after.json.qc_handoff.lapsed.find((entry) => entry.result_id === resultId);
  assert.ok(lapsed, JSON.stringify(after.json.qc_handoff.lapsed));
  assert.equal(lapsed.why, "state_changed");
  t.diagnostic(`next Lapsed accepts line: ${after.text.split("\n").find((text) => text.includes("lapsed: state_changed"))}`);
  const reopened = openRow(after.json, "desktop", "type");
  assert.ok(reopened, "the row is open again");
  assert.equal(reopened.result_ref.split("@")[0], resultId);
  assert.notEqual(reopened.result_ref, type.result_ref, "the state fingerprint moved with the measured value");
  assert.match(after.text, /Synthetic headline: font-size 32px → 31px \(−1px, tolerance 0\.6px\)/);
  assert.equal(after.json.qc_handoff.accepted.some((entry) => entry.result_ref.startsWith(`${resultId}@`)), false);
});
