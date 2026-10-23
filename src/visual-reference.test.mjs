import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, get } from "node:http";
import { boundedInflate, readPngStructure } from "./png-header.mjs";
import { verifyReference, classifyProvenance } from "./visual-reference.mjs";
import { loadVisualDependencies } from "./visual-diff.mjs";
import { evaluateVisualReference, evaluateVisualDiff, compareVisualPair, writePolishPng } from "./polish-visual.mjs";
import { createRgbaPng, syntheticVisualFixture, syntheticHash } from "./polish-visual-fixtures.mjs";

const dependencies = await loadVisualDependencies();
const diffRows = [];
function diff(reference, { dependencies: deps = dependencies, viewport = "desktop" } = {}) {
  const shot = { status: "captured", truncated: false, treatment: { mask_cap_reached: false } };
  const cell = { viewport, width: viewport === "mobile" ? 390 : 1440, device_scale_factor: 1,
    status: "rendered", actual: shot, stabilized: shot,
    readiness: { fonts: { status: "settled" }, await: { status: "not_present" } } };
  const row = evaluateVisualDiff({ basis: "reference", page: { status: "compared" }, bands: [] }, {
    reference, build: cell, record: { dependencies: deps },
  });
  diffRows.push(row); return row;
}
async function verify(f, bytes, options = {}) {
  const path = f.write("ref.png", bytes);
  return { ...(await verifyReference({ ...f, path, decoder: dependencies.decoder, ...options })), viewport: options.viewport || "desktop", ref_id: "image" };
}
function decision(ref, result, reason) {
  const row = evaluateVisualReference(ref);
  assert.equal(row.result, result); assert.equal(row.reason_code, reason);
  return row;
}
function diffDecision(ref, result, reason, memberReason = null, options = {}) {
  const row = diff(ref, options);
  assert.equal(row.result, result); assert.equal(row.reason_code, reason);
  if (memberReason) assert.ok(row.members.some((m) => m.reason_code === memberReason));
  return row;
}
function unsupportedPair(reference, reason, viewport = "desktop") {
  const comparison = compareVisualPair({ reference, build: { viewport, width: viewport === "mobile" ? 390 : 1440, device_scale_factor: 1 },
    diff() { assert.fail("unsupported pair must not compare or resize"); } });
  assert.equal(comparison.status, "unsupported"); assert.equal(comparison.reason, reason); assert.deepEqual(comparison.artifacts, []);
}
function fixture(t) { const f = syntheticVisualFixture(); t.after(f.cleanup); return f; }

test("F3C-W3: decoded independent reference fills computed identity and records unknown capture treatment/state", async (t) => {
  const f = fixture(t), bytes = createRgbaPng(1440, 900), ref = await verify(f, bytes);
  assert.equal(ref.verification.level, "decoded");
  assert.match(ref.identity.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(ref.identity.sha256, syntheticHash(bytes));
  assert.equal(ref.identity.sha256_recorded, null);
  assert.equal(ref.css_width, 1440); assert.equal(ref.dpr, 1);
  decision(ref, "pass", null);
  const row = diffDecision(ref, "review", "visual_diff_diagnostic");
  assert.deepEqual(row.members, [{ key: "reference_capture", result: "review", reason_code: "reference_capture_unrecorded",
    observation: { unrecorded: ["treatment", "state", "crop_origin", "viewport_height"] } }]);
});
test("F3C-B1: current package capture is self-referential while verification stays pass", async (t) => {
  const f = fixture(t), png = createRgbaPng(1440, 900), file = writePolishPng(f.targetRepo, "captures", png);
  const ref = { ...await verifyReference({ ...f, path: resolve(f.targetRepo, file.path), decoder: dependencies.decoder }), viewport: "desktop" };
  const row = decision(ref, "warning", "self_referential");
  assert.deepEqual(ref.provenance.reasons, ["path_in_runtime_dir", "hash_equals_package_capture"]);
  assert.equal(row.members[0].result, "pass"); assert.equal(row.accept_eligible, true);
  diffDecision(ref, "review", "visual_diff_diagnostic", "basis_not_independent");
});
test("F3C-B1b: corrupt self-reference retains verification failure and cannot be accepted or compared", async (t) => {
  const f = fixture(t);
  for (const [dir, bytes, pathReason, verificationReason] of [
    [".campaign-runtime/evidence", Buffer.from("synthetic non-PNG"), "path_in_runtime_dir", "not_png"],
    ["_site/sample", createRgbaPng(390, 812).subarray(0, 33), "path_in_build_output", "truncated"],
  ]) {
    const path = resolve(f.targetRepo, dir, "ref.png"); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, bytes);
    const viewport = verificationReason === "truncated" ? "mobile" : "desktop";
    const ref = { ...await verifyReference({ ...f, path, decoder: dependencies.decoder }), viewport };
    const row = decision(ref, "warning", "self_referential");
    assert.deepEqual(ref.provenance.reasons, [pathReason]);
    assert.equal(ref.verification.reason, verificationReason);
    assert.deepEqual(row.members[0], { key: "verification", result: "unexercised", reason_code: "reference_unverifiable" });
    assert.equal(row.accept_eligible, false); // qcAcceptEligible's members_unresolved condition
    diffDecision(ref, "unexercised", "reference_not_usable", null, { viewport });
  }
});
test("F3C-B2: byte equality identifies a capture even inside the source root", async (t) => {
  const f = fixture(t), bytes = createRgbaPng(1440, 900);
  const ref = await verify(f, bytes, { buildCaptureHashes: [syntheticHash(bytes)] });
  const row = decision(ref, "warning", "self_referential");
  assert.deepEqual(row.members[0], { key: "verification", result: "pass", reason_code: null });
  assert.deepEqual(ref.provenance.reasons, ["hash_equals_package_capture"]);
  assert.equal(ref.verification.level, "decoded");
  diffDecision(ref, "review", "visual_diff_diagnostic", "basis_not_independent");
});
test("F3C-B3: source page identity checks campaign targets and built HTML independently", async (t) => {
  const f = fixture(t), path = f.write("page.html", Buffer.from("<p>synthetic</p>"));
  for (const [options, reason] of [
    [{ pageKitTargets: [path] }, "source_is_campaign_page"],
    [{ builtHtmlHashes: [syntheticHash(Buffer.from("<p>synthetic</p>"))] }, "hash_equals_built_html"],
  ]) {
    const ref = await verifyReference({ ...f, path, kind: "source_html", recorded: {}, ...options });
    decision(ref, "warning", "self_referential"); assert.deepEqual(ref.provenance.reasons, [reason]);
    assert.equal(ref.verification.level, "decoded");
    const shot = { status: "captured", treatment: {} }, cell = { status: "rendered", stabilized: shot };
    const diffRow = evaluateVisualDiff({ basis: "source_html", page: { status: "compared" }, bands: [] }, { record: { dependencies }, build: cell, basis: cell, reference: ref });
    assert.equal(diffRow.result, "review"); assert.equal(diffRow.reason_code, "visual_diff_diagnostic");
    assert.ok(diffRow.members.some((member) => member.reason_code === "basis_not_independent")); diffRows.push(diffRow);
    const linked = classifyProvenance({ ...f, path: f.write("other.png", createRgbaPng(1, 1)), recorded: f.recorded,
      linkedSource: { ...ref, kind: "html_file" } });
    assert.deepEqual(linked, { class: "self_referential", reasons: ["linked_source_self_referential"] });
  }
});
test("F3C-B4: 375 CSS pixels cannot compare against a 390-wide mobile capture", async (t) => {
  const ref = await verify(fixture(t), createRgbaPng(375, 812), { viewport: "mobile" });
  decision(ref, "pass", null);
  diffDecision(ref, "unexercised", "comparison_unsupported", "width_mismatch", { viewport: "mobile" });
  unsupportedPair(ref, "width_mismatch", "mobile");
});
test("F3C-B5: doubled pixel ratio and unknown pixel ratio are unsupported", async (t) => {
  const f = fixture(t);
  for (const [width, height, scale_factor, reason] of [[2880, 1800, 2, "dpr_mismatch"], [1440, 900, undefined, "dpr_unknown"]]) {
    const ref = await verify(f, createRgbaPng(width, height), { recorded: { ...f.recorded, scale_factor } });
    decision(ref, "pass", null);
    diffDecision(ref, "unexercised", "comparison_unsupported", reason);
    unsupportedPair(ref, reason);
  }
});
test("F3C-B8b: non-PNG reference fails structure and cannot be used as a basis", async (t) => {
  const ref = await verify(fixture(t), Buffer.from("synthetic non-PNG"));
  decision(ref, "unexercised", "reference_unverifiable"); assert.equal(ref.verification.reason, "not_png");
  diffDecision(ref, "unexercised", "reference_not_usable");
});
test("F3C-B10: signature and IHDR on a truncated PNG never establish header_checked", async (t) => {
  const png = createRgbaPng(1440, 900);
  const ref = await verify(fixture(t), png.subarray(0, 41 + Math.floor((png.length - 53) / 2)));
  assert.equal(ref.verification.level, "unverifiable"); assert.equal(ref.verification.reason, "truncated");
  decision(ref, "unexercised", "reference_unverifiable"); diffDecision(ref, "unexercised", "reference_not_usable");
});
test("F3C-B11: corrupt deflate with valid chunk CRCs fails decode; missing decoder stops at header_checked", async (t) => {
  const f = fixture(t), png = createRgbaPng(1440, 900, undefined, { idat: Buffer.from([1, 2, 3]) });
  const ref = await verify(f, png);
  assert.equal(ref.verification.reason, "decode_failed"); decision(ref, "unexercised", "reference_unverifiable");
  assert.equal(ref.verification.level, "unverifiable"); diffDecision(ref, "unexercised", "reference_not_usable");
  const absent = await verify(f, png, { decoder: { status: "missing" } });
  assert.equal(absent.verification.level, "header_checked"); decision(absent, "unexercised", "decoder_unavailable");
  diffDecision(absent, "unexercised", "diff_unavailable", "dependency_missing", { dependencies: { ...dependencies, decoder: { status: "missing" } } });
});
test("F3C-B12: recorded reference hash disagreement follows structural and decode checks", async (t) => {
  const f = fixture(t), ref = await verify(f, createRgbaPng(1440, 900), { recorded: { ...f.recorded, sha256: `sha256:${"0".repeat(64)}` } });
  assert.equal(ref.verification.reason, "recorded_hash_mismatch"); decision(ref, "unexercised", "reference_unverifiable");
  diffDecision(ref, "unexercised", "reference_not_usable");
});
test("F3C-B19: image comparison explicitly lists unrecorded reference state", async (t) => {
  const ref = await verify(fixture(t), createRgbaPng(1440, 900));
  decision(ref, "pass", null);
  const row = diffDecision(ref, "review", "visual_diff_diagnostic");
  assert.equal(row.members.find((m) => m.key === "reference_capture").reason_code, "reference_capture_unrecorded");
  assert.ok(row.members.find((m) => m.key === "reference_capture").observation.unrecorded.includes("state"));
});
test("F3C-I6: URL-only references stay local and report remote_not_fetched", async (t) => {
  let requests = 0, connections = 0;
  const receiver = createServer((req, res) => { requests++; res.end("synthetic"); });
  receiver.on("connection", () => { connections++; });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const url = `http://127.0.0.1:${receiver.address().port}/ref.png`;
  // Positive control: the receiver is reachable and counts real requests.
  await new Promise((resolve, reject) => get(url, { agent: false }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
  assert.equal(requests, 1); assert.equal(connections, 1); requests = 0; connections = 0;
  const f = fixture(t), ref = { ...await verifyReference({ ...f, url, decoder: dependencies.decoder }), viewport: "desktop" };
  assert.equal(ref.verification.reason, "remote_not_fetched"); decision(ref, "unexercised", "reference_unverifiable");
  await new Promise(setImmediate);
  assert.equal(requests, 0); assert.equal(connections, 0);
  diffDecision(ref, "unexercised", "reference_not_usable");
});
test("F3C-I7: missing capture time and source link remain provenance review", async (t) => {
  const ref = await verify(fixture(t), createRgbaPng(1440, 900), { recorded: { scale_factor: 1 } });
  const row = decision(ref, "review", "provenance_unknown");
  assert.deepEqual(ref.provenance.reasons, ["capture_time_unrecorded", "source_link_missing"]);
  assert.equal(row.members[0].result, "pass"); assert.equal(row.accept_eligible, false);
  diffDecision(ref, "review", "visual_diff_diagnostic", "basis_not_independent");
});
test("F3C-I11: tablet reference is decoded but viewport_not_captured precedes comparison", async (t) => {
  const ref = await verify(fixture(t), createRgbaPng(1440, 900), { viewport: "tablet" });
  decision(ref, "pass", null);
  diffDecision(ref, "unexercised", "comparison_unsupported", "viewport_not_captured");
  unsupportedPair(ref, "viewport_not_captured");
});
test("F3C-I14: stale package blocks image reference and its diff while source HTML remains usable", async (t) => {
  const f = fixture(t), ref = { ...await verify(f, createRgbaPng(1440, 900)), input_reason: "source_package_stale" };
  decision(ref, "unexercised", "source_package_stale"); diffDecision(ref, "unexercised", "reference_not_usable");
  const html = await verifyReference({ ...f, path: "page.html", kind: "source_html", recorded: { sha256: f.linkedSource.identity.sha256 } });
  decision(html, "pass", null);
  const shot = { status: "captured", treatment: {} };
  const cell = { status: "rendered", stabilized: shot };
  const unaffected = evaluateVisualDiff({ basis: "source_html", page: { status: "compared" }, bands: [] }, { record: { dependencies }, build: cell, basis: cell, reference: html });
  assert.equal(unaffected.result, "review"); assert.equal(unaffected.reason_code, "visual_diff_diagnostic");
  diffRows.push(unaffected);
});
test("F3C-I15: excessive IHDR area refuses before decode and excess inflate refuses at maxOutputLength", async (t) => {
  const f = fixture(t);
  const png = createRgbaPng(100000, 100000, undefined, { idat: Buffer.from([1]) });
  assert.ok(png.length < 1024);
  let decodes = 0;
  const ref = await verify(f, png, { decoder: { status: "available", decode() { decodes++; throw new Error("must not decode oversized input"); } } });
  assert.equal(decodes, 0);
  assert.equal(ref.verification.reason, "image_too_large"); decision(ref, "unexercised", "reference_unverifiable");
  assert.equal(ref.verification.level, "unverifiable"); diffDecision(ref, "unexercised", "reference_not_usable");
  const overflow = createRgbaPng(1440, 900, undefined, { raw: Buffer.alloc(900 * (1 + 1440 * 4) + 1) });
  const inflated = await verify(f, overflow);
  assert.equal(inflated.verification.reason, "decode_failed");
  decision(inflated, "unexercised", "reference_unverifiable"); diffDecision(inflated, "unexercised", "reference_not_usable");
  // Removing maxOutputLength changes this to the later decode_failed Error.
  // Assert zlib's allocation refusal itself, not eventual verifier rejection.
  assert.throws(() => boundedInflate(overflow, readPngStructure(overflow).ihdr), { code: "ERR_BUFFER_TOO_LARGE" });
});
test("Every reference diff row remains diagnostic or unexercised regardless of pixel score", () => {
  assert.ok(diffRows.length >= 12);
  assert.ok(diffRows.every((row) => !["pass", "warning"].includes(row.result) && !row.accept_eligible));
});

test("Reference decoding respects the shared budget and recorded pixel dimensions", async (t) => {
  const f = fixture(t), png = createRgbaPng(1440, 900);
  const exhausted = await verify(f, png, { budget: { remaining: () => 0 } });
  assert.equal(exhausted.verification.reason, "verify_budget_exhausted");
  const disagreement = await verify(f, png, { recorded: { ...f.recorded, width: 2880 } });
  assert.equal(disagreement.verification.reason, "recorded_dimensions_mismatch");
  const outside = syntheticVisualFixture(); t.after(outside.cleanup);
  const escaped = await verifyReference({ ...f, path: outside.write("outside.png", png), decoder: dependencies.decoder });
  assert.equal(escaped.verification.reason, "path_outside_source_root");
  const wrongDecoder = await verify(f, png, { decoder: { status: "available", decode: () => ({ width: 2, height: 2 }) } });
  assert.equal(wrongDecoder.verification.reason, "decode_failed");
});

test("Source HTML hash disagreement is provenance review beside successful read/hash verification", async (t) => {
  const f = fixture(t);
  const ref = await verifyReference({ ...f, path: "page.html", kind: "source_html", recorded: { sha256: `sha256:${"0".repeat(64)}` } });
  const row = decision(ref, "review", "provenance_unknown");
  assert.equal(row.members[0].result, "pass"); assert.deepEqual(ref.provenance.reasons, ["source_hash_mismatch"]);
});
test("Recorded-field and decoder lookups ignore inherited values and tolerate null metadata", async (t) => {
  const f = fixture(t), bytes = createRgbaPng(1440, 900);
  for (const recorded of [null, Object.create(f.recorded)]) {
    const ref = await verify(f, bytes, { recorded });
    assert.equal(ref.verification.level, "decoded"); assert.equal(ref.identity.captured_at, null); assert.equal(ref.identity.source_ref_id, null);
    assert.equal(ref.dpr, null); decision(ref, "review", "provenance_unknown");
  }
  let decodes = 0;
  const ref = await verify(f, bytes, { decoder: Object.create({ status: "available", decode() { decodes++; } }) });
  assert.equal(decodes, 0); assert.equal(ref.verification.level, "header_checked"); decision(ref, "unexercised", "decoder_unavailable");
  assert.doesNotThrow(() => classifyProvenance({ recorded: null }));
});
