import { test } from "node:test";
import assert from "node:assert/strict";
import { qaResolveNextProofLines, shouldPublishVerdict } from "./qa-node.mjs";

// Publishing the QA verdict to the Campaign Map QA portal is the default shape:
// LLM/agent UIs are the primary interface, so a run should land in the portal
// without the operator needing to know a flag.

test("publishes by default (no flags)", () => {
  assert.equal(shouldPublishVerdict({}), true);
});

test("explicit --post-verdict still opts in", () => {
  assert.equal(shouldPublishVerdict({ "post-verdict": true }), true);
});

test("--no-post-verdict opts out", () => {
  assert.equal(shouldPublishVerdict({ "no-post-verdict": true }), false);
});

test("--local-only opts out", () => {
  assert.equal(shouldPublishVerdict({ "local-only": true }), false);
});

test("--post-verdict false opts out", () => {
  assert.equal(shouldPublishVerdict({ "post-verdict": "false" }), false);
  assert.equal(shouldPublishVerdict({ "post-verdict": "off" }), false);
  assert.equal(shouldPublishVerdict({ "post-verdict": "no" }), false);
});

test("unrelated flags do not affect the default", () => {
  assert.equal(shouldPublishVerdict({ browser: true, "test-order": "common" }), true);
});

test("qa resolve names the next proof command when a base URL is known", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    packet_path: "/tmp/campaign-runtime.build.json",
    base_url: "http://localhost:4173/simple-home-watch/",
  });

  assert.match(lines[0], /Next expected proof:/);
  assert.match(lines[0], /campaigns-os qa run --packet \/tmp\/campaign-runtime\.build\.json/);
  assert.match(lines[0], /--browser --test-order common/);
  assert.match(lines[1], /publishes to the portal by default/);
});

test("qa resolve asks for a tested URL before browser and typed-card proof", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    base_url: null,
  });

  assert.match(lines[0], /provide --base-url/);
  assert.match(lines[0], /--browser --test-order common/);
  assert.match(lines[1], /Localhost on any port/);
  assert.match(lines[1], /non-localhost preview\/production origins still need SDK origin allowlist/);
});

test("qa resolve preserves custom proxy base in the next proof command", () => {
  const lines = qaResolveNextProofLines({
    map_id: "shw-round-2",
    proxy_base: "https://campaign-map.example.test/qa proxy",
    spec_source: "https://campaign-map.example.test/qa%20proxy/api/spec/shw-round-2",
    base_url: "https://preview.example.test/simple-home-watch/",
  });

  assert.match(lines[0], /campaigns-os qa run shw-round-2/);
  assert.match(lines[0], /--proxy-base 'https:\/\/campaign-map\.example\.test\/qa proxy'/);
  assert.match(lines[0], /--base-url https:\/\/preview\.example\.test\/simple-home-watch\//);
  assert.match(lines[0], /--browser --test-order common/);
});
