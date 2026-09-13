import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __qaNodeTestHooks, BROWSER_SKIPPED_GATE_BLOCKED, MAX_BROWSER_SKIP_ACTIONS } from "./qa-node.mjs";

const { runResolvedQa, browserSkippedByGate, reportBrowserSkippedByGate, gateClearingHint } = __qaNodeTestHooks;

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

// Shaped like page-kit-store-profile.mjs's blocked, waivable result: the
// repair command first, the waive command only because the state is waivable.
const blockedCheckpoint = () => [{
  id: "page_kit.store_profile",
  status: "blocked",
  code: "page_kit.store_profile.mismatch",
  reason: "Fixture forces a blocked checkpoint gate.",
  waivable: true,
  required_actions: [
    {
      id: "align_store_profile",
      kind: "manual",
      command: null,
      description: "Align the target _data/campaigns.json Store Profile fields with the CampaignSpec.",
    },
    {
      id: "waive_checkpoint",
      kind: "command",
      command: "campaigns-os checkpoint waive --gate page_kit.store_profile --reason <why> --waived-by <named human>",
      description: "Record a bounded waiver for this exact state.",
    },
  ],
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
  // The repair guidance is the gate's own required_actions, not prose written
  // at the notice: this state is waivable, so the waive command is among them.
  assert.match(result.verdict.browser.reason, /Align the target _data\/campaigns\.json Store Profile fields/);
  assert.match(result.verdict.browser.reason, /campaigns-os checkpoint waive --gate page_kit\.store_profile/);
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
      required_actions: [
        {
          id: "generate_brand_layer",
          kind: "command",
          command: "campaigns-os theme generate --packet campaign-runtime.build.json",
          description: "Generate the brand layer from the CampaignSpec brand.",
        },
      ],
    },
  }));

  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["theme_gate.starter_palette_only"]);
  assert.match(result.verdict.browser.reason, /the theme gate \(theme_gate\.starter_palette_only\)/);
  assert.match(result.verdict.browser.reason, /campaigns-os theme generate --packet campaign-runtime\.build\.json/);
  assert.equal(browserLines.length, 1);
});

test("a stale-assembly polish blocker is told to re-run Build, which is what clears it", async () => {
  // The regression this guards: a hand-written "re-run Polish" is wrong here.
  // polish-gate.mjs blocks polish.assembly_source_package_stale until BUILD
  // refreshes the assembly's source-package fingerprint, and says so in its
  // required_actions. The notice must carry that, not a plausible guess.
  const { result } = await runBlocked({ browser: true }, resolvedFixture({
    polishGate: {
      status: "blocked",
      code: "polish.assembly_source_package_stale",
      reason: "The Design Source Package changed after Build. Re-run Build against the current source package before Polish.",
      problems: [],
      required_actions: [{
        id: "rerun_build",
        kind: "skill",
        command: "next-campaigns-build",
        description: "Re-run Build/Assembly against the current Design Source Package.",
      }],
    },
  }));

  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["polish.assembly_source_package_stale"]);
  assert.match(result.verdict.browser.reason, /next-campaigns-build/);
  assert.doesNotMatch(result.verdict.browser.reason, /[Rr]e-run Polish/);
});

test("the clearing hint quotes the gate and never invents a repair", () => {
  // Nothing published: the notice sends the reader to the gate rather than
  // guessing, and in particular does not offer a waiver.
  const silent = gateClearingHint([{ status: "blocked", code: "page_kit.sdk_version.conflicting_declarations" }]);
  assert.match(silent, /required_actions on the verdict/);
  assert.doesNotMatch(silent, /waive/);

  // Manual-only actions carry no command; the instruction is used instead.
  const manual = gateClearingHint([{
    required_actions: [{ id: "repair_waiver", kind: "manual", command: null, description: "Correct the waiver's\n expires_at on the assembly report." }],
  }]);
  // Flattened into one line, because this becomes a single stderr line.
  assert.match(manual, /Correct the waiver's expires_at on the assembly report\./);
  assert.doesNotMatch(manual, /\n/);

  // A gate that DID publish steps the notice cannot render is its own case:
  // the repairs are on the verdict, so calling that "no actions" would hide
  // them.
  const unrenderable = gateClearingHint([{
    required_actions: [{ id: "opaque", kind: "manual", command: null, description: "   " }],
  }]);
  assert.match(unrenderable, /published repair steps this notice could not render/);
  assert.match(unrenderable, /required_actions on the verdict/);
  assert.notEqual(unrenderable, silent, "an unpublished gate and an unrenderable one must not read the same");

  // Long action lists are capped at exactly MAX_BROWSER_SKIP_ACTIONS and say
  // that the verdict has the rest.
  assert.equal(MAX_BROWSER_SKIP_ACTIONS, 3, "the cap this test's expectations are written against");
  const many = gateClearingHint([{
    required_actions: [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, kind: "command", command: `cmd-${n}` })),
  }]);
  assert.match(many, /cmd-1; cmd-2; cmd-3 \(and the rest of the gate's required_actions on the verdict\)/);
  assert.doesNotMatch(many, /cmd-4/);

  // Duplicates are one repair: deduplication happens before the cap, so three
  // distinct repairs published six times claim no "rest" the reader cannot
  // find.
  const duplicated = gateClearingHint([{
    required_actions: ["cmd-a", "cmd-b", "cmd-a", "cmd-c", "cmd-b", "cmd-c"].map((command, index) => ({ id: `a${index}`, kind: "command", command })),
  }]);
  assert.equal(duplicated, "The gate's required actions clear it: cmd-a; cmd-b; cmd-c. Then re-run with --browser.");
});

test("a non-waivable checkpoint blocker is told its manual repair and offered no waiver", async () => {
  // page-kit-store-profile.mjs and polish-page-load.mjs both publish
  // waivable: false states with manual-only repairs. The notice must carry the
  // instruction and must not suggest a waiver checkpointWaive would refuse.
  const { result, browserLines } = await runBlocked({ browser: true }, resolvedFixture({
    checkpointGates: [{
      id: "page_kit.sdk_version",
      status: "blocked",
      code: "page_kit.sdk_version.conflicting_declarations",
      reason: "CampaignSpec and the target campaigns entry declare different SDK versions.",
      waivable: false,
      required_actions: [{
        id: "align_sdk_version",
        kind: "manual",
        command: null,
        description: "Fix the conflicting SDK version declarations so both sides name one released version.",
      }],
    }],
  }));

  assert.equal(result.verdict.browser.status, BROWSER_SKIPPED_GATE_BLOCKED);
  assert.deepEqual(result.verdict.browser.blocked_by, ["page_kit.sdk_version"]);
  assert.match(result.verdict.browser.reason, /Fix the conflicting SDK version declarations/);
  assert.doesNotMatch(result.verdict.browser.reason, /waive/i);
  assert.equal(browserLines.length, 1);
  assert.doesNotMatch(browserLines[0], /waive/i);
});

test("the stamp is only ever built for a run that asked for a browser pass", () => {
  const blocked = {
    args: { browser: true },
    blockedBy: ["page_kit.sdk_version"],
    gateLabel: "checkpoint gate",
    gates: [{ status: "blocked", code: "page_kit.sdk_version.expected_observed_mismatch", required_actions: [] }],
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
    gates: [{ status: "blocked", code: "page_kit.store_profile.mismatch", required_actions: [] }],
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
