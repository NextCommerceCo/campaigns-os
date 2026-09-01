import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkpointWaive, doctorPacket, nextStage } from "./cli.mjs";

const EXAMPLES = new URL("../examples/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ specVersion = "0.4.18", targetVersion = "0.4.18", scaffolded = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdk-version-checkpoint-"));
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
  packet.deploy.preview_url = "https://preview.merchant-shop.com/runtime-packet-demo/";
  if (!scaffolded) packet.assembly.output_dir = "src/not-scaffolded-yet";
  const targetRepo = join(dir, "target-page-kit");
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  spec.runtime = { sdk_version: specVersion };
  delete spec.global_config.sdk_version;
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) delete page.sdk_hints;
  }
  writeJson(specPath, spec);

  const briefRelPath = "target-page-kit/.campaign-runtime/input/campaign-build-brief.normalized.json";
  packet.build_brief = { normalized_path: briefRelPath, status: "complete" };
  writeJson(packetPath, packet);
  writeJson(join(dir, briefRelPath), {
    schema_version: "campaigns-os-build-brief/v1",
    status: "complete",
    _meta: { mode: "guided_draft" },
    questions: [],
    gates: [],
    commerce_surfaces: { payment_methods_allowed: ["card"], hidden_payment_methods: [] },
    promo_urgency: { forbid_placeholders: true },
    template_residue_policy: { block_placeholders: true },
  });

  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[packet.campaign.public_route_slug].sdk_version = targetVersion;
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.setup.status = scaffolded ? "completed" : "pending";
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, targetRepo, reportPath, specPath, campaignsPath };
}

function sdkGate(result) {
  return result.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version");
}

test("doctor and next block an SDK-pin mismatch with exact repair and waiver actions", () => {
  const { dir, packetPath } = fixture({ specVersion: "0.4.36", targetVersion: "0.4.37" });
  try {
    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === "page_kit.sdk_version"), true);
    assert.equal(sdkGate(doctor).status, "blocked");
    assert.deepEqual(sdkGate(doctor).state, {
      expected: "0.4.36",
      observed: "0.4.37",
    });

    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.stage, "doctor-blocked");
    assert.equal(next.gates.find((gate) => gate.id === "page_kit.sdk_version").status, "blocked");
    assert.ok(next.next_actions.some((action) => action.id === "checkpoint.page_kit.sdk_version.repair_target"));
    assert.ok(next.next_actions.some((action) => action.id === "checkpoint.page_kit.sdk_version.waive" && action.command.includes(packetPath)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an SDK-pin waiver stays visible without masking a simultaneous Store Profile blocker", () => {
  const { dir, packetPath, targetRepo, reportPath, campaignsPath } = fixture({
    specVersion: "0.4.36",
    targetVersion: "0.4.37",
  });
  try {
    const campaigns = readJson(campaignsPath);
    campaigns["runtime-packet-demo"].store_url = "https://wrong-merchant.test/";
    writeJson(campaignsPath, campaigns);
    mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
    writeJson(join(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready" });

    const bothBlocked = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    for (const id of [
      "checkpoint.page_kit.sdk_version.repair_target",
      "checkpoint.page_kit.sdk_version.waive",
      "checkpoint.page_kit.store_profile.repair_target",
      "checkpoint.page_kit.store_profile.waive",
    ]) assert.ok(bothBlocked.next_actions.some((action) => action.id === id), id);

    const recorded = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional pin for compatibility testing",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    assert.equal(recorded.gate, "page_kit.sdk_version");
    assert.equal(recorded.waiver.waived_by, "Jordan Lee");
    const report = readJson(reportPath);
    assert.equal(report.waivers.length, 1);
    assert.deepEqual(report.waivers[0].subject, {
      public_route_slug: "runtime-packet-demo",
      target_path: "_data/campaigns.json",
    });
    assert.equal(readJson(join(targetRepo, ".campaign-runtime/doctor-output.json")).stale, true);

    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.ok, false, "the Store Profile blocker must remain active");
    assert.equal(sdkGate(doctor).status, "waived");
    assert.equal(doctor.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile").status, "blocked");
    assert.equal(doctor.warnings.some((issue) => issue.code === "page_kit.sdk_version.waived"), true);

    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.status, "blocked");
    assert.equal(next.gates.find((gate) => gate.id === "page_kit.sdk_version").status, "waived");
    assert.ok(next.next_actions.some((action) => action.id === "checkpoint.page_kit.store_profile.repair_target"));
    assert.equal(next.next_actions.some((action) => action.id.startsWith("checkpoint.page_kit.sdk_version")), false);

    campaigns["runtime-packet-demo"].store_url = "https://store.example.com";
    writeJson(campaignsPath, campaigns);
    const onlyWaived = doctorPacket(packetPath);
    assert.equal(onlyWaived.ok, true, JSON.stringify(onlyWaived.errors, null, 2));
    assert.equal(onlyWaived.status, "ready_with_waivers");

    campaigns["runtime-packet-demo"].sdk_version = "0.4.36";
    writeJson(campaignsPath, campaigns);
    const corrected = doctorPacket(packetPath);
    assert.equal(sdkGate(corrected).status, "pass");
    assert.deepEqual(sdkGate(corrected).waiver_assessment.inert_counts, {
      stale: 0,
      foreign: 0,
      malformed: 0,
      expired: 0,
    });
    assert.equal(corrected.warnings.some((issue) => issue.code === "page_kit.sdk_version.waiver_inert"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor enforces SDK declaration integrity and the Store Profile target-requiredness matrix", () => {
  const clean = fixture();
  try {
    const doctor = doctorPacket(clean.packetPath);
    assert.equal(sdkGate(doctor).status, "pass");
    assert.throws(() => checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: clean.packetPath,
      gate: "page_kit.sdk_version",
      reason: "No blocked pair",
      "waived-by": "Jordan Lee",
      "review-condition": "Review before launch",
    }), /is not blocked/);
  } finally {
    rmSync(clean.dir, { recursive: true, force: true });
  }

  const beforeScaffold = fixture({ scaffolded: false });
  try {
    rmSync(join(beforeScaffold.targetRepo, "_data"), { recursive: true, force: true });
    assert.equal(sdkGate(doctorPacket(beforeScaffold.packetPath)).status, "not_applicable");
  } finally {
    rmSync(beforeScaffold.dir, { recursive: true, force: true });
  }

  const packetReady = fixture();
  try {
    rmSync(join(packetReady.targetRepo, "_data"), { recursive: true, force: true });
    const gate = sdkGate(doctorPacket(packetReady.packetPath));
    assert.equal(gate.status, "blocked");
    assert.equal(gate.code, "page_kit.sdk_version.target_unavailable");
    assert.equal(gate.waivable, false);
  } finally {
    rmSync(packetReady.dir, { recursive: true, force: true });
  }

  for (const [legacyVersion, code] of [
    ["0.4.17", "page_kit.sdk_version.spec_conflict"],
    ["", "page_kit.sdk_version.spec_invalid"],
  ]) {
    const declaration = fixture();
    try {
      const spec = readJson(declaration.specPath);
      spec.global_config.sdk_version = legacyVersion;
      writeJson(declaration.specPath, spec);
      const gate = sdkGate(doctorPacket(declaration.packetPath));
      assert.equal(gate.status, "blocked", code);
      assert.equal(gate.code, code);
      assert.equal(gate.waivable, false);
    } finally {
      rmSync(declaration.dir, { recursive: true, force: true });
    }
  }
});

test("doctor and next keep both checkpoints visible when the packet-local spec is unavailable", () => {
  const cases = [
    {
      label: "missing file",
      expectedStatus: "missing",
      mutate: ({ specPath }) => rmSync(specPath),
    },
    {
      label: "invalid JSON",
      expectedStatus: "invalid_json",
      mutate: ({ specPath }) => writeFileSync(specPath, '{"private":"BAD_SPEC_PRIVATE_SENTINEL"'),
    },
    {
      label: "array root",
      expectedStatus: "root_not_object",
      mutate: ({ specPath }) => writeFileSync(specPath, '["BAD_SPEC_ARRAY_SENTINEL"]\n'),
    },
    {
      label: "null root",
      expectedStatus: "root_not_object",
      mutate: ({ specPath }) => writeFileSync(specPath, 'null\n'),
    },
    {
      label: "non-string local path",
      expectedStatus: "missing",
      mutate: ({ packetPath }) => {
        const packet = readJson(packetPath);
        packet.spec.local_path = { private: "BAD_SPEC_PATH_SENTINEL" };
        writeJson(packetPath, packet);
      },
    },
  ];

  for (const scenario of cases) {
    const state = fixture();
    const originalFetch = globalThis.fetch;
    let fetchHits = 0;
    globalThis.fetch = async () => {
      fetchHits += 1;
      throw new Error("doctor must not fetch around unavailable packet-local spec evidence");
    };
    try {
      scenario.mutate(state);
      const doctor = doctorPacket(state.packetPath);
      assert.equal(doctor.ok, false, scenario.label);
      assert.equal(doctor.errors.some((issue) => issue.code === "spec.local_path"), true, scenario.label);
      assert.deepEqual(
        doctor.derived.checkpoint_gates.map((gate) => gate.id),
        ["page_kit.sdk_version", "page_kit.store_profile"],
        scenario.label,
      );
      for (const gate of doctor.derived.checkpoint_gates) {
        assert.equal(gate.status, "blocked", scenario.label);
        assert.equal(gate.code, `${gate.id}.spec_unavailable`, scenario.label);
        assert.equal(gate.waivable, false, scenario.label);
        assert.equal(gate.state.spec_status, scenario.expectedStatus, scenario.label);
        assert.equal(gate.state_fingerprint, null, scenario.label);
        assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_spec"], scenario.label);
      }
      assert.equal(doctor.derived.doctor_checks.includes("campaign-spec.rule-registry"), false, scenario.label);
      assert.equal(doctor.derived.doctor_checks.filter((id) => id === "page_kit.sdk_version").length, 1, scenario.label);
      assert.equal(doctor.derived.doctor_checks.filter((id) => id === "page_kit.store_profile").length, 1, scenario.label);

      const next = nextStage(null, { _: ["next"], packet: state.packetPath, "no-write": true });
      assert.equal(next.stage, "doctor-blocked", scenario.label);
      for (const id of ["page_kit.sdk_version", "page_kit.store_profile"]) {
        assert.equal(next.gates.find((gate) => gate.id === id).status, "blocked", scenario.label);
        assert.ok(next.next_actions.some((action) => action.id === `checkpoint.${id}.repair_spec`), scenario.label);
      }
      assert.ok(next.next_actions.some((action) => action.id === "doctor_recheck"), scenario.label);
      for (const result of [doctor, next]) {
        assert.doesNotMatch(JSON.stringify(result), /BAD_SPEC_(PRIVATE|ARRAY|PATH)_SENTINEL/, scenario.label);
      }
      assert.equal(fetchHits, 0, scenario.label);

      if (scenario.expectedStatus === "invalid_json") {
        assert.throws(() => checkpointWaive({
          _: ["checkpoint", "waive"],
          packet: state.packetPath,
          gate: "page_kit.sdk_version",
          reason: "Invalid evidence cannot be accepted",
          "waived-by": "Jordan Lee",
          "review-condition": "Repair the local spec",
        }), /not waivable.*spec_unavailable/);
      }
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(state.dir, { recursive: true, force: true });
    }
  }
});

test("a valid packet-local spec runs the full doctor registry and each checkpoint exactly once", () => {
  const { dir, packetPath } = fixture();
  try {
    const doctor = doctorPacket(packetPath);
    assert.ok(doctor.derived.doctor_checks.includes("campaign-spec.rule-registry"));
    assert.equal(doctor.derived.doctor_checks.filter((id) => id === "page_kit.sdk_version").length, 1);
    assert.equal(doctor.derived.doctor_checks.filter((id) => id === "page_kit.store_profile").length, 1);
    assert.equal(doctor.derived.doctor_checks.filter((id) => id === "built_output.upsell_selector_scope").length, 1);
    assert.deepEqual(doctor.derived.checkpoint_gates.map(({ id, status }) => ({ id, status })), [
      { id: "page_kit.sdk_version", status: "pass" },
      { id: "page_kit.store_profile", status: "pass" },
      // No built _site/ in this fixture, so there is no built upsell page to
      // scan. The gate still runs and still reports, rather than being absent.
      { id: "built_output.upsell_selector_scope", status: "not_applicable" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor keeps malformed, expired, foreign-slug, and wrong-pair SDK decisions visible but inert", () => {
  const { dir, packetPath, reportPath } = fixture({ specVersion: "0.4.36", targetVersion: "0.4.37" });
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional pin",
      "waived-by": "Jordan Lee",
      "review-condition": "Review before launch",
    });
    const report = readJson(reportPath);
    const base = report.waivers[0];
    report.waivers = [
      { ...base, state_fingerprint: `sha256:${"0".repeat(64)}`, private_token: "wrong-pair-secret" },
      { ...base, subject: { ...base.subject, public_route_slug: "foreign" }, private_token: "foreign-secret" },
      { ...base, waived_at: "not-a-time", private_token: "malformed-secret" },
      {
        ...base,
        waived_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-02T00:00:00.000Z",
        private_token: "expired-secret",
      },
    ];
    writeJson(reportPath, report);

    const doctor = doctorPacket(packetPath);
    assert.equal(sdkGate(doctor).status, "blocked");
    assert.deepEqual(sdkGate(doctor).waiver_assessment, {
      active: null,
      inert_counts: { stale: 1, foreign: 1, malformed: 1, expired: 1 },
    });
    assert.deepEqual(
      doctor.warnings.find((issue) => issue.code === "page_kit.sdk_version.waiver_inert").detail.counts,
      { stale: 1, foreign: 1, malformed: 1, expired: 1 },
    );
    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.gates.find((gate) => gate.id === "page_kit.sdk_version").status, "blocked");
    for (const output of [doctor, next]) {
      assert.equal(JSON.stringify(output).includes("-secret"), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
