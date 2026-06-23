import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePolishGate, POLISH_PRODUCER } from "./polish-gate.mjs";

const FINGERPRINT = "sha256:build-current";
const SOURCE_PACKAGE_FINGERPRINT = "sha256:source-package-current";

function baseReport(polish = { stage: "polish", status: "required" }, overrides = {}) {
  const report = {
    stages: {
      assembly: { stage: "assembly", status: "completed", build_fingerprint: FINGERPRINT },
      polish,
    },
  };
  return {
    ...report,
    ...overrides,
    stages: {
      ...report.stages,
      ...(overrides.stages || {}),
    },
  };
}

function sourceAwareReport(polish, overrides = {}) {
  return baseReport(polish, {
    design_source_package: { material_fingerprint: SOURCE_PACKAGE_FINGERPRINT },
    ...overrides,
    stages: {
      assembly: {
        stage: "assembly",
        status: "completed",
        build_fingerprint: FINGERPRINT,
        source_package_material_fingerprint: SOURCE_PACKAGE_FINGERPRINT,
      },
      ...(overrides.stages || {}),
    },
  });
}

function sourceFreshnessWaiver(reason = "Operator confirmed current source change is reference-only for this rerun") {
  return {
    scope: "assembly_source_package_freshness",
    reason,
    applies_to: ["stages.assembly.source_package_material_fingerprint"],
    waived_by: "operator",
    waived_at: "2026-06-22T00:00:00.000Z",
    review_condition: "Expires after this run.",
  };
}

function validEvidence(overrides = {}) {
  return {
    visual_review: { screenshots: ["qa-output/checkout-desktop.png", "qa-output/checkout-mobile.png"] },
    brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: true, promo_codes: "none", fonts: "design fonts only", colors: "tokenized" } },
    checkout_review: { field_labels: "checked", phone_alignment: "checked", payment_display: "checked", bump_compare_price_rule: "checked" },
    template_residue_review: { next_blue: "not found", starter_favicon: "not found", lorem: "not found" },
    commerce_flow_review: { shop_single_step: "direct-entry force-package/product-selector limitation reviewed" },
    issues: [],
    commands: ["next-campaigns-polish"],
    ...overrides,
  };
}

function validPolish(overrides = {}) {
  return {
    stage: "polish",
    status: "completed_with_warnings",
    performed_by: POLISH_PRODUCER,
    source_build_fingerprint: FINGERPRINT,
    completed_at: "2026-06-22T00:00:00.000Z",
    evidence: validEvidence(),
    ...overrides,
  };
}

test("polish gate blocks missing or pending polish after build", () => {
  assert.equal(evaluatePolishGate({ report: baseReport(undefined) }).code, "polish.evidence_missing");
  assert.equal(evaluatePolishGate({ report: baseReport({ stage: "polish", status: "required" }) }).code, "polish.evidence_missing");
});

test("polish gate blocks build self-certified polish", () => {
  const report = baseReport(validPolish({
    performed_by: "next-campaigns-build",
    commands: ["next-campaigns-build"],
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.self_certified");
});

test("polish gate blocks stale polish evidence", () => {
  const report = baseReport(validPolish({ source_build_fingerprint: "sha256:old-build" }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.stale");
});

test("polish gate blocks when assembly lacks current source package fingerprint", () => {
  const report = baseReport(validPolish(), {
    design_source_package: { material_fingerprint: SOURCE_PACKAGE_FINGERPRINT },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.assembly_source_package_fingerprint_missing");
  assert.equal(gate.source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
});

test("polish gate blocks when source package changed after assembly", () => {
  const report = baseReport(validPolish(), {
    design_source_package: { material_fingerprint: SOURCE_PACKAGE_FINGERPRINT },
    stages: {
      assembly: {
        stage: "assembly",
        status: "completed",
        build_fingerprint: FINGERPRINT,
        source_package_material_fingerprint: "sha256:old-source-package",
      },
    },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.assembly_source_package_stale");
  assert.equal(gate.assembly_source_package_material_fingerprint, "sha256:old-source-package");
  assert.equal(gate.source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
});

test("polish gate accepts explicit waiver for source package changed after assembly", () => {
  const waiver = sourceFreshnessWaiver();
  const report = baseReport(validPolish({
    source_package_material_fingerprint: SOURCE_PACKAGE_FINGERPRINT,
  }), {
    design_source_package: { material_fingerprint: SOURCE_PACKAGE_FINGERPRINT },
    waivers: [waiver],
    stages: {
      assembly: {
        stage: "assembly",
        status: "completed",
        build_fingerprint: FINGERPRINT,
        source_package_material_fingerprint: "sha256:old-source-package",
      },
    },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "waived");
  assert.equal(gate.code, "polish.assembly_source_package_waived");
  assert.equal(gate.waiver, waiver);
  assert.equal(gate.assembly_source_package_material_fingerprint, "sha256:old-source-package");
  assert.equal(gate.current_source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
});

test("polish gate rejects source freshness waiver without attribution or review bounds", () => {
  const report = baseReport(validPolish({
    source_package_material_fingerprint: SOURCE_PACKAGE_FINGERPRINT,
  }), {
    design_source_package: { material_fingerprint: SOURCE_PACKAGE_FINGERPRINT },
    waivers: [
      {
        scope: "assembly_source_package_freshness",
        reason: "Operator confirmed the source change does not require rebuilding this run.",
        applies_to: ["stages.assembly.source_package_material_fingerprint"],
      },
    ],
    stages: {
      assembly: {
        stage: "assembly",
        status: "completed",
        build_fingerprint: FINGERPRINT,
        source_package_material_fingerprint: "sha256:old-source-package",
      },
    },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.assembly_source_package_stale");
  assert.equal(gate.waiver, undefined);
});

test("polish gate blocks missing source package fingerprint when current source package exists", () => {
  const report = sourceAwareReport(validPolish());
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.source_package_material_fingerprint_missing");
  assert.equal(gate.source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
});

test("polish gate blocks stale source package fingerprint", () => {
  const report = sourceAwareReport(validPolish({
    source_package_material_fingerprint: "sha256:old-source-package",
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.source_package_stale");
  assert.equal(gate.source_package_material_fingerprint, "sha256:old-source-package");
  assert.equal(gate.current_source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
});

test("polish gate blocks incomplete evidence categories", () => {
  const evidence = validEvidence();
  delete evidence.checkout_review;
  const report = baseReport(validPolish({ evidence }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("checkout_review")));
});

test("polish gate blocks weak favicon evidence when brief blocks template favicons", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      brand_review: { logo_checked: true, favicon: "checked", colors: ["#123456"] },
    }),
  }), {
    build_brief: {
      artifact: {
        template_residue_policy: { block_template_favicon: true },
      },
    },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("brand_review.favicon")));
});

test("polish gate blocks favicon evidence that says the source is missing and template favicon remains", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      brand_review: { logo_checked: true, favicon: "source favicon missing; template favicon retained", colors: ["#123456"] },
    }),
  }), {
    build_brief: {
      artifact: {
        template_residue_policy: { block_template_favicon: true },
      },
    },
  });
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("brand_review.favicon")));
});

test("polish gate blocks negative checkout field and bump compare evidence", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      checkout_review: {
        field_labels: "placeholders stripped; empty fields are unlabeled",
        phone_alignment: "checked",
        payment_display: "checked",
        bump_compare_price_rule: { equal_compare_price_found: true },
      },
    }),
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("field_labels")));
  assert.ok(gate.problems.some((problem) => problem.includes("bump_compare_price_rule")));
});

test("polish gate accepts harmless compare-price wording in bump evidence", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      checkout_review: {
        field_labels: "visible labels confirmed",
        phone_alignment: "checked",
        payment_display: "checked",
        bump_compare_price_rule: {
          verdict: "passed",
          summary: {
            note: "compare price uses same currency as list; no equal compare price found",
            layout: "same price compare layout checked against the source",
          },
        },
      },
    }),
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "polish.evidence_current");
});

test("polish gate blocks concrete equal compare-price text evidence", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      checkout_review: {
        field_labels: "visible labels confirmed",
        phone_alignment: "checked",
        payment_display: "checked",
        bump_compare_price_rule: "equal compare price found on no-discount bump",
      },
    }),
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("bump_compare_price_rule")));
});

test("polish gate blocks starter favicon residue evidence", () => {
  const report = baseReport(validPolish({
    evidence: validEvidence({
      template_residue_review: { next_blue: "not found", starter_favicon: "images/favicon.png found", lorem: "not found" },
    }),
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("starter_favicon")));
});

test("polish gate passes current structured polish evidence", () => {
  const gate = evaluatePolishGate({ report: baseReport(validPolish()) });
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "polish.evidence_current");
  assert.equal(gate.build_fingerprint, FINGERPRINT);
  assert.equal(gate.warnings.length, 1);
  assert.equal(gate.warnings[0].code, "polish.source_package_material_fingerprint_unavailable");
});

test("polish gate passes current build and source package fingerprints", () => {
  const report = sourceAwareReport(validPolish({
    source_package_material_fingerprint: SOURCE_PACKAGE_FINGERPRINT,
  }));
  const gate = evaluatePolishGate({ report });
  assert.equal(gate.status, "pass");
  assert.equal(gate.code, "polish.evidence_current");
  assert.equal(gate.build_fingerprint, FINGERPRINT);
  assert.equal(gate.source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
  assert.equal(gate.current_source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
  assert.equal(gate.assembly_source_package_material_fingerprint, SOURCE_PACKAGE_FINGERPRINT);
  assert.deepEqual(gate.warnings, []);
});

test("polish gate blocks when brand_bleed evidence is missing (A3)", () => {
  const evidence = validEvidence();
  delete evidence.brand_review.brand_bleed;
  const gate = evaluatePolishGate({ report: baseReport(validPolish({ evidence })) });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.code, "polish.evidence_incomplete");
  assert.ok(gate.problems.some((problem) => problem.includes("brand_review.brand_bleed")));
});

test("polish gate blocks a residual cloned-source sale code (A3)", () => {
  const gate = evaluatePolishGate({ report: baseReport(validPolish({
    evidence: validEvidence({ brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: "promo sale code SPRING still present from sibling campaign" } }),
  })) });
  assert.equal(gate.status, "blocked");
  assert.ok(gate.problems.some((problem) => problem.includes("brand_review.brand_bleed")));
});

test("polish gate blocks a hardcoded non-token color bleed (A3)", () => {
  const gate = evaluatePolishGate({ report: baseReport(validPolish({
    evidence: validEvidence({ brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: { cleared: false, note: "hardcoded #C670FE purple still on Most Popular pill" } } }),
  })) });
  assert.equal(gate.status, "blocked");
  assert.ok(gate.problems.some((problem) => problem.includes("brand_review.brand_bleed")));
});

test("polish gate blocks a free-form 'cleared: false' brand_bleed string (A3)", () => {
  for (const wording of ["cleared: false", "not cleared", "de-brand pass: bleed found"]) {
    const gate = evaluatePolishGate({ report: baseReport(validPolish({
      evidence: validEvidence({ brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: wording } }),
    })) });
    assert.equal(gate.status, "blocked", `"${wording}" must block`);
    assert.ok(gate.problems.some((problem) => problem.includes("brand_review.brand_bleed")));
  }
});

test("polish gate accepts a cleared brand_bleed attestation (A3)", () => {
  const gate = evaluatePolishGate({ report: baseReport(validPolish({
    evidence: validEvidence({ brand_review: { logo_checked: true, favicon: "not-template", colors: ["#123456"], brand_bleed: "promo banner stripped, design fonts only, colors tokenized, no prior favicon" } }),
  })) });
  assert.equal(gate.status, "pass");
});
