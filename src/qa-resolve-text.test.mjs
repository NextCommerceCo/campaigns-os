import test from "node:test";
import assert from "node:assert/strict";

import { checkpointGateLines, themeGateLines } from "./qa-node.mjs";

// The checkpoint and theme-gate blocks of the `qa resolve` text report, as
// lines: assertable without a subprocess, and rendered by the one action rule
// doctor uses.
test("checkpointGateLines renders each gate, its waiver state and its actions with the packet substituted", () => {
  const gates = [{
    id: "page_kit.sdk_version",
    status: "blocked",
    code: "page_kit.sdk_version.mismatch",
    reason: "Target SDK version 0.4.38 does not match the CampaignSpec pin 0.4.18.",
    waiver: { waived_by: "ops@local", waived_at: "2026-09-14T00:00:00.000Z", reason: "known drift", expires_at: "2026-10-01T00:00:00.000Z", review_condition: "next release" },
    waiver_assessment: { inert_counts: { stale: 1, foreign: 0, malformed: 0, expired: 2 } },
    required_actions: [
      { id: "repair", kind: "edit", command: null, description: "Set the pin, then re-run doctor." },
      { id: "waive", kind: "command", command: "campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version", description: "Waive it." },
    ],
  }, {
    id: "page_kit.store_profile",
    status: "pass",
    code: "page_kit.store_profile.pass",
    reason: "Store profile is complete.",
    waiver: null,
    waiver_assessment: { inert_counts: {} },
    required_actions: [],
  }];
  assert.deepEqual(checkpointGateLines(gates, "/w/my packet.json"), [
    "Checkpoint page_kit.sdk_version: blocked (page_kit.sdk_version.mismatch) — Target SDK version 0.4.38 does not match the CampaignSpec pin 0.4.18.",
    "  Waiver: ops@local at 2026-09-14T00:00:00.000Z — known drift",
    "  Expires: 2026-10-01T00:00:00.000Z",
    "  Review condition: next release",
    "  Inert waiver decisions: stale=1, foreign=0, malformed=0, expired=2",
    "  Required actions:",
    "    - Set the pin, then re-run doctor.",
    "    - campaigns-os checkpoint waive --packet '/w/my packet.json' --gate page_kit.sdk_version",
    "Checkpoint page_kit.store_profile: pass (page_kit.store_profile.pass) — Store profile is complete.",
    "  Inert waiver decisions: stale=0, foreign=0, malformed=0, expired=0",
  ]);
  // No packet (a --site run): the template is printed as published.
  assert.equal(checkpointGateLines(gates, null)[7], "    - campaigns-os checkpoint waive --packet <packet> --gate page_kit.sdk_version");
  assert.deepEqual(checkpointGateLines([], "/w/p.json"), []);
  assert.deepEqual(checkpointGateLines(undefined, "/w/p.json"), []);
});

test("themeGateLines prints the actions and the ephemeral-waiver hint only for a blocked gate", () => {
  const blocked = {
    status: "blocked",
    code: "theme_gate.starter_palette",
    reason: "The starter palette is still applied.",
    required_actions: [{ id: "generate", kind: "command", command: "campaigns-os theme generate --packet <packet>", description: "Generate the brand theme." }, { id: "manual", command: null, description: "Apply the brand tokens by hand." }],
  };
  assert.deepEqual(themeGateLines(blocked), [
    "Theme gate: blocked (theme_gate.starter_palette) — The starter palette is still applied.",
    "Required actions:",
    "  - campaigns-os theme generate --packet <packet>",
    "  - Apply the brand tokens by hand.",
    'Or rerun with --theme-waive "<reason>" to record an ephemeral waiver for this run.',
  ]);
  assert.deepEqual(themeGateLines({ status: "pass", code: "theme_gate.pass", reason: "Brand theme applied." }), [
    "Theme gate: pass (theme_gate.pass) — Brand theme applied.",
  ]);
  assert.deepEqual(themeGateLines(null), []);
});
