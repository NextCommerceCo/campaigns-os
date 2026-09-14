import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverQaVerdicts,
  qaVerdictCandidateScore,
  qaVerdictCandidateTime,
  qaVerdictDir,
  qaVerdictIdentifiers,
  qaVerdictIdentityMatch,
  qaVerdictPathHints,
} from "./qa-verdict-discovery.mjs";

const PACKET = { spec: { map_id: "map-1" }, campaign: { public_route_slug: "/demo/" }, deploy: { preview_url: "https://preview.example" } };

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-verdict-discovery-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const writeJson = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

test("identifiers are the map id and the slug as identity; a verdict matches on either", () => {
  assert.deepEqual(qaVerdictIdentifiers(PACKET), ["map-1", "demo"]);
  assert.deepEqual(qaVerdictIdentifiers({ spec: { map_id: "same" }, campaign: { public_route_slug: "same" } }), ["same"]);
  assert.deepEqual(qaVerdictIdentifiers({}), []);
  assert.equal(qaVerdictIdentityMatch({ campaign_slug: "map-1" }, PACKET), true);
  assert.equal(qaVerdictIdentityMatch({ campaign_slug: "demo" }, PACKET), true);
  assert.equal(qaVerdictIdentityMatch({ campaign_slug: "other" }, PACKET), false);
  assert.equal(qaVerdictIdentityMatch({}, PACKET), false);
  assert.equal(qaVerdictDir("/repo", "demo"), "/repo/qa-output/demo");
});

test("path hints are the *.json strings the report's qa stage records", () => {
  const report = {
    stages: { qa: { outputs: ["qa-output/demo/run_1.json", "notes.txt"], verdict_path: "/abs/run_2.json", artifacts: [{ file: "qa-output/demo/run_3.json?x" }] } },
    qa: { local_output: "qa-output/demo/run_1.json" },
  };
  // Report-level qa first, then the stage, in key order, de-duplicated.
  assert.deepEqual(qaVerdictPathHints(report), ["qa-output/demo/run_1.json", "/abs/run_2.json", "qa-output/demo/run_3.json?x"]);
  assert.deepEqual(qaVerdictPathHints(null), []);
});

test("discoverQaVerdicts walks the report's hints and every root's qa-output identifier directories once", () => withDir((dir) => {
  const repo = join(dir, "repo");
  const byMap = join(qaVerdictDir(repo, "map-1"), "run_a.json");
  const bySlug = join(qaVerdictDir(repo, "demo"), "run_b.json");
  const foreign = join(qaVerdictDir(repo, "demo"), "run_c.json");
  const untrusted = join(qaVerdictDir(repo, "demo"), "run_d.json");
  writeJson(byMap, { campaign_slug: "map-1", verdict: "ready", completed_at: "2026-09-14T00:00:00Z" });
  writeJson(bySlug, { campaign_slug: "demo", verdict: "blocked" });
  writeJson(foreign, { campaign_slug: "someone-else", verdict: "ready" });
  writeJson(untrusted, { campaign_slug: "demo", verdict: "ready", trusted: false });
  writeFileSync(join(qaVerdictDir(repo, "demo"), "not-json.txt"), "x");
  writeFileSync(join(qaVerdictDir(repo, "demo"), "broken.json"), "{ not json");
  const reportPath = join(repo, ".campaign-runtime/assembly-report.json");
  const report = { stages: { qa: { outputs: ["../qa-output/demo/run_b.json", "../qa-output/missing.json"] } } };

  const found = discoverQaVerdicts({ packet: PACKET, report, reportPath, roots: [repo, repo, null], withDigest: true });
  const byPath = Object.fromEntries(found.map((candidate) => [candidate.path, candidate]));
  // The hinted file is found once, as the report's, even though the walk sees it too.
  assert.equal(found.filter((candidate) => candidate.path === bySlug).length, 1);
  assert.equal(byPath[bySlug].source, "assembly_report");
  assert.equal(byPath[bySlug].repoRelPath, null);
  assert.equal(byPath[bySlug].sha256, createHash("sha256").update(readFileSync(bySlug)).digest("hex"));
  assert.equal(byPath[byMap].source, "qa_output");
  assert.equal(byPath[byMap].repoRelPath, "qa-output/map-1/run_a.json");
  assert.equal(byPath[byMap].identityMatch, true);
  assert.equal(byPath[foreign].identityMatch, false, "listed, but not this campaign's");
  assert.equal(byPath[untrusted].trusted, false);
  assert.equal(byPath[untrusted].identityMatch, true);
  assert.equal(byPath[join(qaVerdictDir(repo, "demo"), "broken.json")].verdict, null, "a non-JSON file is listed without a verdict");
  assert.equal(found.some((candidate) => candidate.path.endsWith("not-json.txt")), false);
  assert.equal(found.some((candidate) => candidate.path.endsWith("missing.json")), false);
  // Without a digest request no hashing happens.
  assert.equal(discoverQaVerdicts({ packet: PACKET, roots: [repo] }).every((candidate) => candidate.sha256 === null), true);
  // No packet: no identifier directories, only hints.
  assert.deepEqual(discoverQaVerdicts({ report, reportPath, roots: [repo] }).map((candidate) => candidate.source), ["assembly_report"]);
}));

test("candidate scoring prefers the map id over the slug, then the schema and a visited deploy origin; time breaks ties", () => {
  const score = (verdict) => qaVerdictCandidateScore({ verdict }, PACKET);
  assert.equal(score({ campaign_slug: "map-1" }), 100);
  assert.equal(score({ campaign_slug: "demo" }), 80);
  assert.equal(score({ campaign_slug: "demo", schema_version: "campaigns-os-qa-verdict/v0" }), 90);
  assert.equal(score({ campaign_slug: "demo", assertions: [{ url: "https://preview.example/checkout/" }] }), 105);
  assert.equal(score({ campaign_slug: "other" }), 0);
  assert.equal(qaVerdictCandidateTime({ verdict: { completed_at: "2026-09-14T00:00:00.000Z" }, mtimeMs: 5 }), Date.parse("2026-09-14T00:00:00.000Z"));
  assert.equal(qaVerdictCandidateTime({ verdict: { completed_at: "not a date" }, mtimeMs: 5 }), 5);
});
