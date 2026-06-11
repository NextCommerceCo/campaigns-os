import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { __qaNodeTestHooks, GATE_SUPPRESSED_FAMILIES } from "./qa-node.mjs";
import { evaluateThemeGate } from "./theme-gate.mjs";

const {
  themeGateAssertion,
  themeGateScopeFromTopologies,
  residueSeverityForThemeGate,
  supportedPaymentMethodsFromSpec,
  themeGateSummary,
  templateBrandContractAssertion,
} = __qaNodeTestHooks;

const commerceTopologies = [{
  funnel_id: "default",
  pages: [
    { page_id: "presell", page_type: "presell" },
    { page_id: "checkout", page_type: "checkout" },
    { page_id: "upsell-1", page_type: "upsell" },
    { page_id: "receipt", page_type: "thankyou" },
  ],
}];

test("theme gate scope derives commerce pages from spec topologies", () => {
  const scope = themeGateScopeFromTopologies(commerceTopologies);
  assert.deepEqual(scope.built_pages.map((page) => page.page_id), ["checkout", "upsell-1", "receipt"]);
  assert.ok(scope.built_pages.every((page) => page.role === "runtime"));
  // thankyou is preserved as its spec type; the gate treats it as commerce
  assert.equal(scope.built_pages.at(-1).type, "thankyou");
  assert.deepEqual(themeGateScopeFromTopologies([]), { built_pages: [] });
});

test("blocked theme gate maps to a single blocker assertion with reason and required actions", () => {
  // The recovery-relief-stack-v1 dogfood shape: generatable theme, never applied.
  const gate = evaluateThemeGate({
    reportTheme: { status: "needs_review", load_order: "unknown" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: true } },
    scope: themeGateScopeFromTopologies(commerceTopologies),
    packetPath: "campaign-runtime.build.json",
  });
  assert.equal(gate.status, "blocked");

  const result = themeGateAssertion(gate);
  assert.equal(result.id, gate.code);
  assert.equal(result.family, "theme_gate");
  assert.equal(result.status, "fail");
  assert.equal(result.severity, "blocker");
  assert.equal(result.evidence.reason, gate.reason);
  assert.ok(result.evidence.required_actions.length >= 1);
  assert.ok(result.evidence.required_actions.some((action) => /theme generate --packet campaign-runtime\.build\.json/.test(action.command || "")));
});

test("waived theme gate maps to a pass assertion carrying the waiver", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "needs_review" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: true } },
    scope: themeGateScopeFromTopologies(commerceTopologies),
    packetPath: "campaign-runtime.build.json",
    waive: "starter palette approved for this rerun",
  });
  assert.equal(gate.status, "waived");

  const result = themeGateAssertion(gate);
  assert.equal(result.family, "theme_gate");
  assert.equal(result.status, "pass");
  assert.equal(result.severity, undefined);
  assert.equal(result.evidence.waiver.reason, "starter palette approved for this rerun");
  assert.equal(result.evidence.waiver.waived_by, "cli_flag");
});

test("pass and not_applicable theme gates map to audit-trail pass assertions", () => {
  const pass = evaluateThemeGate({
    reportTheme: { status: "applied", load_order: "after-next-core" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: true } },
    scope: themeGateScopeFromTopologies(commerceTopologies),
  });
  assert.equal(pass.status, "pass");
  const passAssertion = themeGateAssertion(pass);
  assert.equal(passAssertion.status, "pass");
  assert.equal(passAssertion.id, "theme_gate.applied");

  // No packet artifacts at all (map-id/--spec flow): not_applicable, run proceeds.
  const notApplicable = evaluateThemeGate({
    reportTheme: null,
    contextTheme: null,
    scope: themeGateScopeFromTopologies(commerceTopologies),
  });
  assert.equal(notApplicable.status, "not_applicable");
  const naAssertion = themeGateAssertion(notApplicable);
  assert.equal(naAssertion.status, "pass");
  assert.equal(naAssertion.family, "theme_gate");
});

test("residue severity downgrades to warn only for waived/not_applicable gates", () => {
  assert.equal(residueSeverityForThemeGate("pass"), "blocker");
  assert.equal(residueSeverityForThemeGate("blocked"), "blocker");
  assert.equal(residueSeverityForThemeGate("waived"), "warn");
  assert.equal(residueSeverityForThemeGate("not_applicable"), "warn");
});

test("supported payment methods read both spec lists, normalize object/string forms, null when undeclared", () => {
  assert.deepEqual(
    supportedPaymentMethodsFromSpec({ campaign: {
      available_payment_methods: ["apple_pay", "bankcard", "google_pay"],
      available_express_payment_methods: ["apple_pay", "google_pay"],
    } }),
    ["apple_pay", "bankcard", "google_pay"],
  );
  assert.deepEqual(
    supportedPaymentMethodsFromSpec({ campaign: {
      available_payment_methods: [{ code: "card" }, { code: "PayPal" }],
      available_express_payment_methods: ["Apple-Pay"],
    } }),
    ["card", "paypal", "apple_pay"],
  );
  // unknown != empty: undeclared methods mean chrome residue checks do not run
  assert.equal(supportedPaymentMethodsFromSpec({ campaign: {} }), null);
  assert.equal(supportedPaymentMethodsFromSpec(null), null);
});

test("GATE_SUPPRESSED_FAMILIES matches the families the QA runner actually emits", () => {
  // Drift guard: collect every `family: "..."` literal from the two emitter
  // modules. Adding a new assertion family without updating the suppressed
  // list (or vice versa) fails here instead of silently changing the
  // gate-blocked verdict shape.
  const emitted = new Set();
  for (const module of ["./qa-node.mjs", "./qa-browser.mjs"]) {
    const source = readFileSync(fileURLToPath(new URL(module, import.meta.url)), "utf8");
    for (const match of source.matchAll(/family:\s*"([a-z_-]+)"/g)) emitted.add(match[1]);
  }
  emitted.delete("theme_gate"); // the gate's own assertion is never suppressed
  assert.deepEqual(
    [...emitted].sort(),
    [...GATE_SUPPRESSED_FAMILIES].sort(),
    "GATE_SUPPRESSED_FAMILIES must equal the set of non-theme_gate families emitted by qa-node.mjs + qa-browser.mjs",
  );
});

test("theme gate summary keeps waiver and required actions only when present", () => {
  const blocked = themeGateSummary({ status: "blocked", code: "theme_gate.x", reason: "r", waiver: null, required_actions: [{ id: "a" }] });
  assert.deepEqual(Object.keys(blocked), ["status", "code", "reason", "required_actions"]);
  const pass = themeGateSummary({ status: "pass", code: "theme_gate.applied", reason: "r", waiver: null, required_actions: [] });
  assert.deepEqual(Object.keys(pass), ["status", "code", "reason"]);
});

test("custom and undecided families emit visible skipped brand-contract assertions", () => {
  const custom = templateBrandContractAssertion({ templateFamily: "custom", brandContractStatus: "none" });
  assert.equal(custom.status, "skipped");
  assert.equal(custom.family, "template_residue");
  assert.match(custom.actual, /family is custom/);

  const undecided = templateBrandContractAssertion({ templateFamily: "undecided", brandContractStatus: "none" });
  assert.equal(undecided.status, "skipped");
  assert.equal(undecided.evidence.reason, "doctor exempts undecided/custom template families");
});
