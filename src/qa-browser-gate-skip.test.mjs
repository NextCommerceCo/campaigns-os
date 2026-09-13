import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __qaNodeTestHooks, BROWSER_SKIPPED_GATE_BLOCKED } from "./qa-node.mjs";

const { runResolvedQa, browserSkippedByGate, reportBrowserSkippedByGate } = __qaNodeTestHooks;

const PAGE_URL = "https://preview.example.test/gate-skip/checkout/";

function resolvedFixture({ checkpointGates = [], themeGate = null, polishGate = null } = {}) {
  return {
    themeGate: themeGate || {
      status: "pass",
      code: "theme_gate.brand_layer_present",
      reason: "Fixture theme gate passes.",
    },
    polishGate: polishGate || {
      status: "not_applicable",
      code: "polish.not_applicable",
      reason: "Fixture has no assembly report.",
    },
    checkpointGates,
    qaWaivers: {},
    analyticsCaptureTarget: { url: null, source: "unresolved" },
    brandContract: null,
    brandContractStatus: "not_evaluated",
    packetPath: null,
    packet: null,
    mapId: "gate-skip",
    publicRouteSlug: "gate-skip",
    proxyBase: "https://proxy.example.test",
    baseUrl: "https://preview.example.test/",
    specPath: null,
    specSource: "test",
    portalManaged: false,
    rawSpec: { campaign: { ref_id: 4242 } },
    spec: { campaign: { ref_id: 4242 } },
    specVersion: "4.3",
    specHash: "sha256:gate-skip",
    templateFamily: null,
    commerceStructureContract: null,
    topologies: [{
      funnel_id: "default",
      funnel_name: "Default",
      weight: 100,
      pages: [{
        page_id: "checkout",
        page_type: "checkout",
        label: "Checkout",
        url: PAGE_URL,
      }],
    }],
  };
}

const blockedCheckpoint = () => [{
  id: "page_kit.store_profile",
  status: "blocked",
  code: "page_kit.store_profile.mismatch",
  reason: "Fixture forces a blocked checkpoint gate.",
  required_actions: [],
}];

// Runs the gate-blocked path the way the CLI does, and captures the stderr the
// run wrote. The runner's own consent notice can share the channel, so the
// assertions filter for the browser line rather than assuming it is alone.
async function runBlocked(args, resolved) {
  const outputDir = mkdtempSync(join(tmpdir(), "qa-gate-skip-"));
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const result = await runResolvedQa({
      _: ["qa", "run"],
      "output-dir": outputDir,
      "no-post-verdict": true,
      ...args,
    }, resolved);
    return { result, browserLines: written.filter((line) => line.includes("Browser QA was requested")) };
  } finally {
    process.stderr.write = realWrite;
    rmSync(outputDir, { recursive: true, force: true });
  }
}

test("a --browser run a blocked checkpoint gate refused stamps the verdict and says so once", async () => {
  const { result, browserLines } = await runBlocked({ browser: true }, resolvedFixture({ checkpointGates: blockedCheckpoint() }));

  // The gate decision and the exit-code contract are unchanged: still blocked,
  // still no rendered page. Only the silence is fixed.
  assert.equal(result.verdict.disposition, "blocked");
  assert.deepEqual(result.verdict.tested_urls, []);

  assert.equal(result.verdict.browser.requested, true);
  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["page_kit.store_profile"]);
  assert.match(result.verdict.browser.reason, /no browser launched/);
  assert.match(result.verdict.browser.reason, /checkpoint waive/);
  // The CLI result payload carries the same stamp for --json readers.
  assert.deepEqual(result.browser, result.verdict.browser);

  assert.equal(browserLines.length, 1, "the downgrade is announced exactly once");
  assert.equal(browserLines[0], `[campaigns-os] ${result.verdict.browser.reason}\n`);
});

test("a blocked checkpoint gate without --browser stamps nothing and stays silent", async () => {
  const { result, browserLines } = await runBlocked({}, resolvedFixture({ checkpointGates: blockedCheckpoint() }));

  assert.equal(result.verdict.disposition, "blocked");
  assert.equal("browser" in result.verdict, false, "a run that never asked for a browser pass makes no browser claim");
  assert.equal(result.browser, null);
  assert.deepEqual(browserLines, []);
});

test("the blocked theme gate names the theme gate and the action that clears it", async () => {
  const { result, browserLines } = await runBlocked({ browser: true }, resolvedFixture({
    themeGate: {
      status: "blocked",
      code: "theme_gate.starter_palette_only",
      reason: "Fixture forces a blocked theme gate.",
      commerce_pages: [],
      required_actions: [],
    },
  }));

  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["theme_gate.starter_palette_only"]);
  assert.match(result.verdict.browser.reason, /the theme gate \(theme_gate\.starter_palette_only\)/);
  assert.match(result.verdict.browser.reason, /--theme-waive/);
  assert.equal(browserLines.length, 1);
});

test("the blocked polish gate names the polish gate and re-running Polish", async () => {
  const { result } = await runBlocked({ browser: true }, resolvedFixture({
    polishGate: {
      status: "blocked",
      code: "polish.assembly_source_package_stale",
      reason: "Fixture forces a blocked polish gate.",
      problems: [],
      required_actions: [],
    },
  }));

  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["polish.assembly_source_package_stale"]);
  assert.match(result.verdict.browser.reason, /Re-run Polish/);
});

test("the stamp is only ever built for a run that asked for a browser pass", () => {
  const blocked = {
    args: { browser: true },
    blockedBy: ["page_kit.sdk_version"],
    gateLabel: "checkpoint gate",
    clears: "Clear it.",
  };
  assert.equal(browserSkippedByGate({ ...blocked, args: {} }), null);
  assert.equal(browserSkippedByGate({ ...blocked, args: { browser: "true" } }), null, "only the parsed boolean flag counts");
  const stamp = browserSkippedByGate(blocked);
  assert.deepEqual(stamp.blocked_by, ["page_kit.sdk_version"]);
  assert.equal(stamp.requested, true);
});

test("the skip notice stays silent in JSON mode, where the stamp is already emitted", () => {
  const written = [];
  const write = (message) => written.push(message);
  const stamp = browserSkippedByGate({
    args: { browser: true },
    blockedBy: ["page_kit.store_profile"],
    gateLabel: "checkpoint gate",
    clears: "Clear it.",
  });

  assert.equal(reportBrowserSkippedByGate({ json: true, browser: true }, stamp, write), false);
  assert.deepEqual(written, []);
  assert.equal(reportBrowserSkippedByGate({ browser: true }, stamp, write), true);
  assert.equal(written.length, 1);
  assert.equal(written[0], `[campaigns-os] ${stamp.reason}\n`);
  // Nothing to say when no browser pass was requested.
  assert.equal(reportBrowserSkippedByGate({ browser: true }, null, write), false);
  assert.equal(written.length, 1);
});
