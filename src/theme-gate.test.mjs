import assert from "node:assert/strict";
import { test } from "node:test";

import { commercePagesFromScope, evaluateThemeGate, themeWaiverFrom } from "./theme-gate.mjs";

const COMMERCE_SCOPE = {
  built_pages: [
    { page_id: "p_presell", type: "presell", role: "visual" },
    { page_id: "p_checkout", type: "checkout", role: "runtime" },
    { page_id: "p_upsell", type: "upsell", role: "runtime" },
    { page_id: "p_receipt", type: "thankyou", role: "runtime" },
  ],
};

const VISUAL_ONLY_SCOPE = {
  built_pages: [
    { page_id: "p_presell", type: "presell", role: "visual" },
    { page_id: "p_landing", type: "landing", role: "visual" },
  ],
};

const GENERATABLE_CONTEXT_THEME = {
  policy: "inspect_only",
  generated: { can_generate: true },
};

test("commercePagesFromScope picks commerce types and runtime roles", () => {
  const pages = commercePagesFromScope(COMMERCE_SCOPE);
  assert.deepEqual(pages.map((page) => page.page_id), ["p_checkout", "p_upsell", "p_receipt"]);
  assert.deepEqual(commercePagesFromScope(VISUAL_ONLY_SCOPE), []);
  assert.deepEqual(commercePagesFromScope(null), []);
});

test("gate blocks when a generatable theme is not applied to commerce pages", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "needs_review", load_order: "unknown", commerce_pages: [] },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: COMMERCE_SCOPE,
    packetPath: "/tmp/packet.json",
  });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "theme_gate.generatable_not_applied");
  const commands = gate.required_actions.filter((action) => action.command).map((action) => action.command);
  assert.ok(commands.some((command) => command.includes("theme generate --packet /tmp/packet.json")));
  assert.ok(commands.some((command) => command.includes("theme waive --packet /tmp/packet.json")));
});

test("gate passes when the brand layer is applied after next-core", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "applied", load_order: "after-next-core", commerce_pages: ["checkout/"] },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: COMMERCE_SCOPE,
  });
  assert.equal(gate.status, "pass");
});

test("gate blocks an applied theme with wrong load order", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "applied", load_order: "unknown" },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: COMMERCE_SCOPE,
  });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "theme_gate.load_order");
});

test("gate is waived by a recorded report waiver and by an ephemeral CLI waiver", () => {
  const recorded = evaluateThemeGate({
    reportTheme: { status: "needs_review", waiver: { reason: "merchant supplied no brand kit", waived_by: "operator" } },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: COMMERCE_SCOPE,
  });
  assert.equal(recorded.status, "waived");
  assert.equal(recorded.waiver.reason, "merchant supplied no brand kit");

  const ephemeral = evaluateThemeGate({
    reportTheme: { status: "needs_review" },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: COMMERCE_SCOPE,
    waive: "starter palette approved for this test",
  });
  assert.equal(ephemeral.status, "waived");
  assert.equal(ephemeral.waiver.waived_by, "cli_flag");
});

test("gate is not applicable with policy off or without commerce pages", () => {
  const off = evaluateThemeGate({
    reportTheme: { status: "needs_review" },
    contextTheme: { ...GENERATABLE_CONTEXT_THEME, policy: "off" },
    scope: COMMERCE_SCOPE,
  });
  assert.equal(off.status, "not_applicable");

  const visualOnly = evaluateThemeGate({
    reportTheme: { status: "needs_review" },
    contextTheme: GENERATABLE_CONTEXT_THEME,
    scope: VISUAL_ONLY_SCOPE,
  });
  assert.equal(visualOnly.status, "not_applicable");
});

test("gate passes a skipped theme when nothing is generatable", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "skipped" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: false } },
    scope: COMMERCE_SCOPE,
  });
  assert.equal(gate.status, "pass");
});

test("gate demands a decision for needs_review without a generatable artifact", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "needs_review" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: false } },
    scope: COMMERCE_SCOPE,
  });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "theme_gate.needs_decision");
});

test("themeWaiverFrom prefers the ephemeral flag and validates shape", () => {
  assert.equal(themeWaiverFrom({ waiver: { reason: "" } }), null);
  assert.equal(themeWaiverFrom(null), null);
  assert.equal(themeWaiverFrom({ waiver: { reason: "ok" } }).reason, "ok");
  assert.equal(themeWaiverFrom({ waiver: { reason: "ok" } }, "flag wins").waived_by, "cli_flag");
});
