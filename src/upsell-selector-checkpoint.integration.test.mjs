// The waiver escape hatch for the upsell selector-scope gate (#270), end to end
// through the packet doctor path and `campaigns-os checkpoint waive`.
//
// The gate is a blocker-with-waiver rather than a bare blocker because the
// alternative to an escape hatch is not a stricter gate — it is a dropped one,
// the first time a build has a cart-scoped selector on a post-purchase page for
// a reason nobody anticipated. The waiver keeps the decision named, bounded, and
// recorded in the assembly report instead of unwritten.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkpointWaive, doctorPacket, nextStage } from "./cli.mjs";
import { UPSELL_SELECTOR_SCOPE } from "./upsell-selector-scope.mjs";

const EXAMPLES = new URL("../examples/", import.meta.url);
const SLUG = "runtime-packet-demo";

const UNSCOPED_UPSELL_PAGE = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="next-page-type" content="upsell">
  <script src="https://cdn.example.test/campaign-cart@v0.4.18/dist/loader.js"></script>
</head><body>
  <div data-next-bundle-selector data-next-selector-id="upsell-bundle-1x" style="display:none">
    <div role="button" data-next-bundle-card data-next-bundle-id="oto-1x"
         data-next-bundle-items='[{"packageId":33,"quantity":1}]' data-next-selected="true"></div>
  </div>
  <div class="upsell-wrapper" data-next-upsell="offer">
    <div data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle"></div>
  </div>
</body></html>`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ upsellHtml = UNSCOPED_UPSELL_PAGE, assemblyComplete = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "upsell-selector-checkpoint-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) {
    cpSync(new URL(file, EXAMPLES), join(dir, file));
  }
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));

  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);

  const targetRepo = join(dir, "target-page-kit");
  writeJson(join(targetRepo, ".campaign-runtime/input/campaign-build-brief.normalized.json"), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  // The built page the gate reads. Assembly is left NOT terminal on purpose:
  // the field instance arrived during a later review round, so the gate must
  // not wait for a stage to be recorded before it looks at built markup.
  const builtUpsell = join(targetRepo, "_site", SLUG, "upsell", "index.html");
  mkdirSync(dirname(builtUpsell), { recursive: true });
  writeFileSync(builtUpsell, upsellHtml);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.deploy.status = "skipped";
  // Built output beside a "pending" assembly stage is itself a divergence the
  // ledger reports first, so tests that need to reach `next`'s action list
  // reconcile the stage; the doctor tests deliberately leave it pending.
  if (assemblyComplete) report.stages.assembly.status = "completed";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, targetRepo, reportPath, builtUpsell };
}

function gateOf(result) {
  return result.derived.checkpoint_gates.find((gate) => gate.id === UPSELL_SELECTOR_SCOPE);
}

test("the packet doctor blocks a built upsell page whose selector sells into the cart", () => {
  const { dir, packetPath } = fixture();
  try {
    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === UPSELL_SELECTOR_SCOPE), true);
    const gate = gateOf(doctor);
    assert.equal(gate.status, "blocked");
    assert.equal(gate.waivable, true);
    assert.deepEqual(gate.state.findings, [
      { page_id: "upsell", selector_id: "upsell-bundle-1x", occurrence: 0 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`next` offers the repair and the waiver, bound to this packet", () => {
  const { dir, packetPath } = fixture({ assemblyComplete: true });
  try {
    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.stage, "doctor-blocked");
    assert.equal(next.gates.find((gate) => gate.id === UPSELL_SELECTOR_SCOPE).status, "blocked");
    assert.ok(next.next_actions.some((action) => action.id === `checkpoint.${UPSELL_SELECTOR_SCOPE}.repair_selectors`));
    const waive = next.next_actions.find((action) => action.id === `checkpoint.${UPSELL_SELECTOR_SCOPE}.waive`);
    assert.ok(waive.command.includes(packetPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a named-human waiver clears the blocker and stays visible as an exception", () => {
  const { dir, packetPath, reportPath } = fixture();
  try {
    const result = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: UPSELL_SELECTOR_SCOPE,
      reason: "Legacy offer page reuses the cart selector; replacement is scheduled.",
      "waived-by": "Jordan Lee",
      "review-condition": "The offer page is rebuilt from the current template.",
    });
    assert.equal(result.ok, true);
    assert.equal(readJson(reportPath).waivers.length, 1);

    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === UPSELL_SELECTOR_SCOPE), false);
    const gate = gateOf(doctor);
    assert.equal(gate.status, "waived");
    assert.equal(gate.waiver.waived_by, "Jordan Lee");
    // Waived is never clean: the exception has to keep showing.
    assert.equal(doctor.warnings.some((issue) => issue.code === "built_output.upsell_selector_scope.waived"), true);
    assert.ok(doctor.ready.some((note) => note.includes("Jordan Lee")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the waiver goes inert as soon as the built markup changes", () => {
  const { dir, packetPath, builtUpsell } = fixture();
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: UPSELL_SELECTOR_SCOPE,
      reason: "Legacy offer page reuses the cart selector.",
      "waived-by": "Jordan Lee",
      "review-condition": "The offer page is rebuilt.",
    });
    writeFileSync(
      builtUpsell,
      UNSCOPED_UPSELL_PAGE.replace(
        "</body>",
        '<div data-next-bundle-selector data-next-selector-id="second-unscoped"></div></body>',
      ),
    );

    const doctor = doctorPacket(packetPath);
    assert.equal(gateOf(doctor).status, "blocked", "a second unscoped selector is a state nobody waived");
    assert.equal(gateOf(doctor).waiver_assessment.inert_counts.stale, 1);
    assert.ok(doctor.warnings.some((issue) => issue.code === "built_output.upsell_selector_scope.waiver_inert"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiving is refused when the gate is not blocked", () => {
  const { dir, packetPath } = fixture({
    upsellHtml: UNSCOPED_UPSELL_PAGE.replace(
      'data-next-bundle-selector data-next-selector-id="upsell-bundle-1x"',
      'data-next-bundle-selector data-next-upsell-context data-next-selector-id="upsell-bundle-1x"',
    ),
  });
  try {
    assert.equal(gateOf(doctorPacket(packetPath)).status, "pass");
    assert.throws(
      () => checkpointWaive({
        _: ["checkpoint", "waive"],
        packet: packetPath,
        gate: UPSELL_SELECTOR_SCOPE,
        reason: "Pre-emptive",
        "waived-by": "Jordan Lee",
        "review-condition": "never",
      }),
      /is not blocked/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
