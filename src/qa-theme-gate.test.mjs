import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __qaNodeTestHooks, GATE_SUPPRESSED_FAMILIES } from "./qa-node.mjs";
import { evaluateThemeGate } from "./theme-gate.mjs";

const {
  polishGateAssertion,
  themeBlockedAssertions,
  themeGateAssertion,
  themeGateScopeFromTopologies,
  residueSeverityForThemeGate,
  supportedPaymentMethodsFromSpec,
  themeGateSummary,
  templateBrandContractAssertion,
  deriveEntryUrls,
  derivePageUrls,
  deriveTestedUrlsFromAssertions,
  resolvePayload,
  resolveThemeGate,
  mergeThemeGateScope,
  themeGateScopeSource,
  resolveQaInputsFromSite,
  checkpointGateSummary,
  hiddenEagerMediaGateAssertion,
  isRoutingMetaTag,
  unsupportedSdkMetaHint,
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

test("entry URL derivation prefers explicit top-of-funnel page types before route order fallback", () => {
  const entries = deriveEntryUrls([{
    funnel_id: "default",
    pages: [
      { page_id: "checkout", page_type: "checkout", url: "https://preview.test/shield/checkout/" },
      { page_id: "presell", page_type: "presell", url: "https://preview.test/shield/presell-running/" },
      { page_id: "receipt", page_type: "thankyou", url: "https://preview.test/shield/receipt/" },
    ],
  }]);

  assert.deepEqual(entries, [{
    funnel_id: "default",
    funnel_name: "default",
    page_id: "presell",
    page_type: "presell",
    label: null,
    url: "https://preview.test/shield/presell-running/",
  }]);

  assert.deepEqual(deriveEntryUrls([{ pages: [{ page_id: "checkout", page_type: "checkout", url: "https://preview.test/checkout/" }] }])[0].funnel_name, "default");
  assert.equal(deriveEntryUrls([{
    pages: [
      { page_id: "checkout", page_type: "checkout", url: "https://preview.test/checkout/" },
      { page_id: "product-offer", page_type: "product", url: "https://preview.test/product-offer/" },
    ],
  }])[0].page_id, "checkout");
});

test("page URL derivation returns the resolved URL set once per URL", () => {
  const urls = derivePageUrls([{
    funnel_id: "primary",
    pages: [
      { page_id: "presell", page_type: "presell", url: "https://preview.test/presell/" },
      { page_id: "checkout", page_type: "checkout", url: "https://preview.test/checkout/" },
    ],
  }, {
    funnel_id: "secondary",
    pages: [
      { page_id: "presell-b", page_type: "presell", url: "https://preview.test/presell/" },
    ],
  }]);

  assert.deepEqual(urls.map((entry) => [entry.funnel_id, entry.page_id, entry.url]), [
    ["primary", "presell", "https://preview.test/presell/"],
    ["primary", "checkout", "https://preview.test/checkout/"],
  ]);
});

test("tested URL derivation only includes pages with executed HTTP assertions", () => {
  const pageUrls = [
    {
      funnel_id: "default",
      page_id: "presell",
      page_type: "presell",
      label: "Presell",
      url: "https://preview.test/presell/",
    },
    {
      funnel_id: "default",
      page_id: "checkout",
      page_type: "checkout",
      label: "Checkout",
      url: "https://preview.test/checkout/",
    },
  ];
  const tested = deriveTestedUrlsFromAssertions([
    { id: "route-url:receipt", family: "funnel-flow", page: "receipt", status: "fail" },
    { id: "http:presell", family: "funnel-flow", page: "presell", url: "https://preview.test/presell/", status: "pass" },
  ], pageUrls);

  assert.deepEqual(tested, [pageUrls[0]]);
});

test("qa resolve payload reports resolved page URLs without claiming tested URLs", () => {
  const payload = resolvePayload({
    mapId: "shield-41x9",
    specSource: "campaign-spec.json",
    specVersion: "4.3",
    specHash: "sha256:abc",
    baseUrl: "https://preview.test/shield/",
    spec: { campaign: { name: "Shield", slug: "shield", ref_id: 1638 } },
    checkpointGates: [
      { id: "page_kit.store_profile", status: "pass" },
      { id: "page_kit.sdk_version", status: "pass" },
      { id: "polish.hidden_eager_media", status: "not_applicable" },
    ],
    themeGate: { status: "pass", code: "theme_gate.applied", reason: "ok" },
    polishGate: { status: "pass", code: "polish.evidence_current", reason: "ok" },
    topologies: [{
      funnel_id: "default",
      pages: [
        { page_id: "presell", page_type: "presell", url: "https://preview.test/shield/presell-running/" },
      ],
    }],
  });

  assert.deepEqual(payload.page_urls.map((entry) => entry.page_id), ["presell"]);
  assert.deepEqual(payload.tested_urls, []);
  assert.deepEqual(payload.checkpoint_gates.map((gate) => gate.id), [
    "page_kit.store_profile",
    "page_kit.sdk_version",
    "polish.hidden_eager_media",
  ]);
});

test("hidden eager-media checkpoint summary and assertion expose only the safe finite projection", () => {
  const gate = {
    id: "polish.hidden_eager_media",
    scope: "polish.hidden_eager_media",
    status: "blocked",
    code: "polish.hidden_eager_media",
    reason: "One hidden media element exceeds the threshold.",
    waivable: true,
    subject: {
      build_fingerprint: `sha256:${"a".repeat(64)}`,
      campaign_slug: "merchant",
      route_scope: "all",
      routes: ["/merchant/landing/?private=route"],
      viewports: ["desktop", "mobile", "private-viewport"],
      private_subject: "private-subject-sentinel",
    },
    state_fingerprint: `sha256:${"b".repeat(64)}`,
    state: {
      findings: [{
        code: "polish.hidden_eager_media",
        route: "/merchant/landing/?private=finding",
        viewport: "desktop",
        tag_name: "video",
        element_index: 0,
        sources: ["https://cdn.example.test/hero.mp4?private=source#fragment"],
        transferred_bytes: 2_000_000,
        threshold_bytes: 1_048_576,
        preload_attribute: "auto",
        hidden_by: ["display_none", "visibility_collapse", "private-hidden-token"],
        private_finding: "private-finding-sentinel",
      }],
      private_state: "private-state-sentinel",
    },
    findings: [],
    waiver: {
      scope: "polish.hidden_eager_media",
      subject: { private: "private-waiver-subject" },
      state_fingerprint: `sha256:${"b".repeat(64)}`,
      reason: "Named-human exception",
      waived_by: "Jordan Lee",
      waived_at: "2026-08-20T00:00:00.000Z",
      private_token: "private-waiver-sentinel",
    },
    waiver_assessment: { inert_counts: { stale: 1, foreign: 0, malformed: 0, expired: 0 } },
    required_actions: [{
      id: "polish.hidden_eager_media.capture",
      kind: "command",
      command: "campaigns-os polish capture --packet <packet> --base-url <url>",
      description: "Capture package-owned page-load evidence for every mapped route and fixed viewport.",
    }],
    private_gate: "private-gate-sentinel",
  };

  const summary = checkpointGateSummary(gate);
  const projected = JSON.stringify(summary);
  assert.deepEqual(summary.subject.routes, ["/merchant/landing/"]);
  assert.deepEqual(summary.subject.viewports, ["desktop", "mobile"]);
  assert.deepEqual(summary.state.findings[0].sources, ["https://cdn.example.test/hero.mp4"]);
  assert.deepEqual(summary.state.findings[0].hidden_by, ["display_none", "visibility_collapse"]);
  assert.deepEqual(summary.findings, summary.state.findings);
  assert.deepEqual(summary.waiver.subject, summary.subject);
  assert.doesNotMatch(projected, /private-/);

  const assertion = hiddenEagerMediaGateAssertion(gate);
  assert.equal(assertion.id, "polish.hidden_eager_media");
  assert.equal(assertion.family, "polish_gate");
  assert.equal(assertion.status, "fail");
  assert.equal(assertion.severity, "blocker");
  assert.doesNotMatch(JSON.stringify(assertion), /private-/);
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

test("blocked theme gate still records current polish gate evidence", () => {
  const gate = evaluateThemeGate({
    reportTheme: { status: "needs_review", load_order: "unknown" },
    contextTheme: { policy: "inspect_only", generated: { can_generate: true } },
    scope: themeGateScopeFromTopologies(commerceTopologies),
    packetPath: "campaign-runtime.build.json",
  });
  const polishGate = {
    status: "pass",
    code: "polish.evidence_current",
    reason: "Polish evidence is current.",
    build_fingerprint: "sha256:build",
    source_build_fingerprint: "sha256:build",
    performed_by: "next-campaigns-polish",
  };

  const assertions = themeBlockedAssertions(gate, polishGate);
  const polishAssertion = assertions.find((assertion) => assertion.family === "polish_gate");

  assert.equal(polishAssertion.id, "polish.evidence_current");
  assert.equal(polishAssertion.status, "pass");
  assert.equal(assertions.some((assertion) => assertion.family === "polish_gate" && assertion.status === "skipped"), false);
  assert.equal(assertions.some((assertion) => assertion.family === "theme_gate" && assertion.status === "fail"), true);
});

test("polish gate assertion keeps pass, waived, and not-applicable distinct", () => {
  const pass = polishGateAssertion({
    status: "pass",
    code: "polish.evidence_current",
    reason: "Polish evidence is current.",
    build_fingerprint: "sha256:build",
    source_build_fingerprint: "sha256:build",
    performed_by: "next-campaigns-polish",
  });
  assert.equal(pass.status, "pass");

  const waived = polishGateAssertion({
    status: "waived",
    code: "polish.assembly_source_package_waived",
    reason: "Polish evidence is current under source freshness waiver.",
    build_fingerprint: "sha256:build",
    source_build_fingerprint: "sha256:build",
    performed_by: "next-campaigns-polish",
    waiver: { reason: "source refresh accepted for this run" },
  });
  assert.equal(waived.status, "skipped");
  assert.equal(waived.id, "polish.assembly_source_package_waived");
  assert.equal(waived.evidence.waiver.reason, "source refresh accepted for this run");

  const notApplicable = polishGateAssertion({
    status: "not_applicable",
    code: "polish.not_applicable",
    reason: "Assembly is not completed yet; polish evidence is required after build completion.",
  });
  assert.equal(notApplicable.status, "skipped");
  assert.match(notApplicable.expected, /assembly report/);
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
  for (const module of ["./qa-node.mjs", "./qa-browser.mjs", "./qa-parity-capture.mjs"]) {
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

// --- H3.3: non-packet QA resolves scope from a built _site/ ---

function withTempSite(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-qa-site-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveQaInputsFromSite builds topologies + brand contract from a built _site/, gate does not block", () => {
  withTempSite((repo) => {
    for (const [route, html] of Object.entries({ "": "<h1>Landing</h1>", checkout: "<h1>Checkout</h1>", "upsell-1": "<h1>Upsell</h1>" })) {
      const dir = route ? join(repo, "_site", "acme", route) : join(repo, "_site", "acme");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html);
    }
    const resolved = resolveQaInputsFromSite({ site: repo, "base-url": "http://localhost:8080", family: "olympus", slug: "acme" });
    assert.equal(resolved.templateFamily, "olympus");
    assert.equal(resolved.brandContractStatus, "loaded");
    assert.ok(resolved.brandContract, "brand contract loaded for the QA residue gates");
    assert.equal(resolved.topologies[0].pages.length, 3);
    const checkout = resolved.topologies[0].pages.find((p) => p.page_type === "checkout");
    assert.equal(checkout.url, "http://localhost:8080/checkout/");
    // No theme artifacts exist for a built-site run -> the gate is non-blocking
    // (not_applicable), so browser QA still runs the residue/placeholder gates.
    assert.notEqual(resolved.themeGate.status, "blocked");
    assert.deepEqual(resolved.checkpointGates.map((gate) => [gate.id, gate.status]), [
      ["page_kit.store_profile", "not_applicable"],
      ["page_kit.sdk_version", "not_applicable"],
      ["polish.hidden_eager_media", "not_applicable"],
    ]);
    assert.equal(resolved.packetPath, null);
    assert.equal(resolved.builtSite.html_count, 3);
  });
});

test("resolveQaInputsFromSite requires --base-url", () => {
  withTempSite((repo) => {
    const dir = join(repo, "_site", "acme");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>Landing</h1>");
    assert.throws(() => resolveQaInputsFromSite({ site: repo, family: "olympus", slug: "acme" }), /base-url/);
  });
});

test("resolveQaInputsFromSite requires a loadable --family brand contract", () => {
  withTempSite((repo) => {
    const dir = join(repo, "_site", "acme");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>Landing</h1>");
    assert.throws(
      () => resolveQaInputsFromSite({ site: repo, "base-url": "http://localhost:8080", slug: "acme" }),
      /--family/,
    );
    assert.throws(
      () => resolveQaInputsFromSite({ site: repo, "base-url": "http://localhost:8080", family: "not-a-family", slug: "acme" }),
      /loadable template brand contract/,
    );
  });
});

test("failure routing uses the released next-failure-url spelling", () => {
  assert.equal(isRoutingMetaTag("next-failure-url"), true);
  assert.equal(isRoutingMetaTag("NEXT-FAILURE-URL"), true);
  assert.equal(isRoutingMetaTag("next-payment-failed-url"), false);
});

test("unsupported currency and predictive-address meta hints route to supported advisory mechanisms", () => {
  assert.match(unsupportedSdkMetaHint("next-currency").expected, /URL parameter/);
  assert.equal(
    unsupportedSdkMetaHint("next-predictive-address").expected,
    "window.nextConfig.addressConfig.enableAutocomplete",
  );
  assert.equal(unsupportedSdkMetaHint("next-page-type"), null);
});

// #274, at the QA seam. `qa resolve` listed seven commerce routes and then said
// `theme_gate.no_commerce_pages` in the same command's output. resolveThemeGate
// preferred the doctor's derived scope outright, so a thin one — a partial
// build, or a doctor-output.json written before the commerce pages existed —
// retired the gate on a funnel the spec plainly declares.
const renewaliftTopologies = [{
  funnel_id: "default",
  funnel_name: "Default",
  pages: [
    { page_id: "presell", page_type: "presell" },
    { page_id: "checkout", page_type: "checkout" },
    { page_id: "upsell", page_type: "upsell" },
    { page_id: "upsell-2", page_type: "upsell" },
    { page_id: "upsell-3", page_type: "upsell" },
    { page_id: "upsell-4", page_type: "upsell" },
    { page_id: "upsell-5", page_type: "upsell" },
    { page_id: "receipt", page_type: "thankyou" },
  ],
}];

function packetWithDoctorScope(scope) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-theme-gate-"));
  const packetPath = join(dir, "campaign-runtime.build.json");
  writeFileSync(packetPath, JSON.stringify({ campaign: { public_route_slug: "renewalift-device" } }));
  mkdirSync(join(dir, ".campaign-runtime"), { recursive: true });
  writeFileSync(
    join(dir, ".campaign-runtime", "doctor-output.json"),
    JSON.stringify({ derived: { scope } }),
  );
  writeFileSync(
    join(dir, ".campaign-runtime", "build-context.json"),
    JSON.stringify({ theme: { generated: { can_generate: true } } }),
  );
  return { dir, packetPath };
}

test("#274 regression: a thin doctor scope cannot retire the gate on a declared commerce funnel", () => {
  const { dir, packetPath } = packetWithDoctorScope({
    mode: "partial",
    built_pages: [{ page_id: "presell", type: "presell", role: "content" }],
    out_of_scope_pages: [],
  });
  try {
    const gate = resolveThemeGate({
      packetPath,
      topologies: renewaliftTopologies,
      waive: null,
      report: { theme: { status: "needs_review", load_order: "unknown" } },
    });

    assert.notEqual(gate.code, "theme_gate.no_commerce_pages");
    assert.notEqual(gate.status, "not_applicable");
    assert.equal(gate.status, "blocked");
    // The seven commerce routes the same command lists are the seven the gate sees.
    assert.deepEqual(gate.commerce_pages, [
      "checkout", "upsell", "upsell-2", "upsell-3", "upsell-4", "upsell-5", "receipt",
    ]);
    // The scope source is recorded rather than left unstated.
    assert.equal(gate.scope_source, "doctor_derived_scope+spec_topologies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a doctor scope that already covers the commerce funnel is used unchanged", () => {
  const built = [
    { page_id: "checkout", type: "checkout", role: "runtime" },
    { page_id: "upsell", type: "upsell", role: "runtime" },
    { page_id: "upsell-2", type: "upsell", role: "runtime" },
    { page_id: "upsell-3", type: "upsell", role: "runtime" },
    { page_id: "upsell-4", type: "upsell", role: "runtime" },
    { page_id: "upsell-5", type: "upsell", role: "runtime" },
    { page_id: "receipt", type: "thankyou", role: "runtime" },
  ];
  const { dir, packetPath } = packetWithDoctorScope({ mode: "full", built_pages: built });
  try {
    const gate = resolveThemeGate({
      packetPath,
      topologies: renewaliftTopologies,
      waive: null,
      report: { theme: { status: "applied", load_order: "after-next-core" } },
    });

    assert.equal(gate.status, "pass");
    assert.equal(gate.scope_source, "doctor_derived_scope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without doctor output the gate still reads the spec topologies, as before", () => {
  const gate = resolveThemeGate({
    packetPath: null,
    topologies: renewaliftTopologies,
    waive: null,
    report: { theme: { status: "applied", load_order: "after-next-core" } },
  });

  assert.equal(gate.scope_source, "spec_topologies");
  assert.equal(gate.status, "pass");
  assert.equal(gate.commerce_pages.length, 7);
});

test("scope merge is keyed on page identity, and out-of-scope pages already count", () => {
  const specScope = themeGateScopeFromTopologies(renewaliftTopologies);
  const doctorScope = {
    built_pages: [{ page_id: "presell", type: "presell", role: "content" }],
    out_of_scope_pages: specScope.built_pages,
  };

  // Every commerce page is already known to the doctor scope, so nothing is added.
  assert.equal(mergeThemeGateScope(doctorScope, specScope), doctorScope);
  assert.equal(themeGateScopeSource(doctorScope, specScope), "doctor_derived_scope");
  assert.equal(mergeThemeGateScope(null, specScope), specScope);
  assert.equal(themeGateScopeSource(null, specScope), "spec_topologies");
});
