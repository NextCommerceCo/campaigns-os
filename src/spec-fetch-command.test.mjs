import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { specFetchCommand } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { specMaterialHash } from "./spec-identity.mjs";
import { RUNTIME_STATE_IGNORE_MARKER, RUNTIME_STATE_REQUIRED_IGNORED_PATHS } from "./runtime-state-ignore.mjs";

const MAP_ID = "synthetic-map";
const SPEC = { spec_identity: { map_id: MAP_ID }, campaign: { public_route_slug: "synthetic" }, funnels: [] };
const CACHE = `.campaign-runtime/fetched-specs/${MAP_ID}.json`;

function fixture(t, { boundSpec = SPEC, spec = { map_id: MAP_ID, local_path: CACHE }, gitignore = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "campaigns-os-spec-fetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packetPath = join(root, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify({
    schema_version: "campaign-runtime-build-packet/v0",
    campaign: { public_route_slug: "synthetic" },
    spec,
    assembly: { target_repo: ".", output_dir: "src/synthetic" },
  }));
  mkdirSync(join(root, ".campaign-runtime"));
  writeFileSync(join(root, ".campaign-runtime/assembly-report.json"), JSON.stringify({ identity: { spec_material_hash: specMaterialHash(boundSpec) }, stages: {} }));
  if (gitignore) writeFileSync(join(root, ".gitignore"), gitignore);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true, data: SPEC }) };
  };
  return {
    root, packetPath, calls, fetchImpl,
    cachePath: join(root, CACHE),
    run: (args = {}) => specFetchCommand({ _: ["spec", "fetch"], packet: packetPath, ...args }, { fetchImpl }),
  };
}

test("spec fetch restores a missing Map copy and reports that it matches the records", async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.status, "restored");
  assert.equal(result.bound, "matches");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(JSON.parse(readFileSync(f.cachePath, "utf8")), SPEC);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /\/api\/spec\/synthetic-map$/);
});

test("spec fetch never replaces a copy on disk and sends nothing", async (t) => {
  const f = fixture(t);
  const derived = { ...SPEC, derived_edit: true };
  mkdirSync(dirname(f.cachePath), { recursive: true });
  writeFileSync(f.cachePath, JSON.stringify(derived));
  const result = await f.run();
  assert.equal(result.status, "present");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.cachePath, "utf8")), derived);
  assert.equal(result.bound, "differs", "a copy that differs from the bound spec is still named");
});

test("spec fetch says so when the Map has moved since the records were made", async (t) => {
  const f = fixture(t, { boundSpec: { ...SPEC, campaign: { public_route_slug: "synthetic", edited: true } } });
  const result = await f.run();
  assert.equal(result.ok, true, "the copy is restored; the mismatch is the doctor's to report");
  assert.equal(result.bound, "differs");
  assert.deepEqual(result.warnings.map((issue) => issue.code), ["spec.fetch.differs_from_records"]);
});

test("spec fetch makes the copy committable in a repository with an older managed block", async (t) => {
  const older = [RUNTIME_STATE_IGNORE_MARKER, CACHE.replace(/[^/]+$/, ""), ...RUNTIME_STATE_REQUIRED_IGNORED_PATHS].join("\n");
  const f = fixture(t, { gitignore: `${older}\n` });
  const result = await f.run();
  assert.deepEqual(result.gitignore.removed_entries, [".campaign-runtime/fetched-specs/"]);
  assert.ok(!readFileSync(join(f.root, ".gitignore"), "utf8").includes("fetched-specs"));
});

test("spec fetch refuses a packet set up from a local file and writes nothing", async (t) => {
  const f = fixture(t, { spec: { map_id: MAP_ID, local_path: "exports/spec.json" } });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.fetch.not_saved_map"]);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.cachePath), false);
  const noMap = fixture(t, { spec: { local_spec_id: "6f1e1c5e-0000-4000-8000-000000000000", local_path: "spec.json" } });
  assert.deepEqual((await noMap.run()).errors.map((issue) => issue.code), ["spec.fetch.not_saved_map"]);
});

test("a failed fetch writes nothing and reports the failure", async (t) => {
  const f = fixture(t);
  const result = await specFetchCommand({ _: ["spec", "fetch"], packet: f.packetPath }, {
    fetchImpl: async () => ({ ok: false, status: 404, statusText: "Not Found" }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.fetch.failed"]);
  assert.equal(existsSync(f.cachePath), false);
});

test("spec fetch refuses a spec that identifies another campaign and writes nothing", async (t) => {
  for (const data of [{ ...SPEC, spec_identity: { map_id: "another-map" } }, { ...SPEC, spec_identity: { map_id: MAP_ID, public_route_slug: "another-route" } }]) {
    const f = fixture(t);
    const result = await specFetchCommand({ _: ["spec", "fetch"], packet: f.packetPath }, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["spec.fetch.identity_mismatch"]);
    assert.equal(existsSync(f.cachePath), false);
  }
});

test("a corrupt copy or report is a reported failure, not a crash", async (t) => {
  const copy = fixture(t);
  mkdirSync(dirname(copy.cachePath), { recursive: true });
  writeFileSync(copy.cachePath, "{ not json");
  assert.deepEqual((await copy.run()).errors.map((issue) => issue.code), ["spec.fetch.failed"]);
  const report = fixture(t);
  writeFileSync(join(report.root, ".campaign-runtime/assembly-report.json"), "{ not json");
  assert.deepEqual((await report.run()).errors.map((issue) => issue.code), ["spec.fetch.failed"]);
  assert.equal(report.calls.length, 0);
});

test("the text result carries the comparison and the .gitignore change", async (t) => {
  const older = [RUNTIME_STATE_IGNORE_MARKER, ".campaign-runtime/fetched-specs/", ...RUNTIME_STATE_REQUIRED_IGNORED_PATHS].join("\n");
  const f = fixture(t, { gitignore: `${older}\n` });
  const { ready } = await f.run();
  assert.ok(ready.some((line) => /matches the spec the campaign's records were made against/.test(line)));
  assert.ok(ready.some((line) => /Took fetched-specs\/ out of the managed \.gitignore block/.test(line)));
});

test("spec fetch warns when it cannot update .gitignore, because the copy may not be committable", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".gitignore"));
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((issue) => issue.code), ["spec.fetch.gitignore_not_updated"]);
});

test("spec fetch refuses a --proxy-base with no value before anything is sent", async (t) => {
  const f = fixture(t);
  for (const value of [true, "", "   "]) await assert.rejects(f.run({ "proxy-base": value }), /--proxy-base needs a URL/);
  assert.equal(f.calls.length, 0);
});

test("spec fetch refuses an unknown flag before doing anything", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ force: true }), /Unknown flag for spec fetch: --force/);
  assert.equal(f.calls.length, 0);
});

const specPathIssue = (result) => result.errors.find((issue) => issue.code === "spec.local_path");

test("doctor names spec fetch when a saved Map's copy is missing, and not for a local file", (t) => {
  const saved = fixture(t);
  assert.match(specPathIssue(doctorPacket(saved.packetPath)).message, /campaigns-os spec fetch --packet/);
  const local = fixture(t, { spec: { map_id: MAP_ID, local_path: "exports/spec.json" } });
  assert.doesNotMatch(specPathIssue(doctorPacket(local.packetPath)).message, /spec fetch/);
});
