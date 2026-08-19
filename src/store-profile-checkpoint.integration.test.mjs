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

function fixture({ campaigns = "matching", scaffolded = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "store-profile-checkpoint-"));
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
  Object.assign(spec.campaign, {
    store_url: "https://merchant-shop.com",
    store_terms: "https://merchant-shop.com/terms",
    store_privacy: "https://merchant-shop.com/privacy",
    store_contact: "https://merchant-shop.com/contact",
    store_returns: "https://merchant-shop.com/returns",
    store_shipping: "https://merchant-shop.com/shipping",
    available_payment_methods: ["card", "paypal", "klarna", "apple_pay", "google_pay"],
  });
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
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.setup.status = scaffolded ? "completed" : "pending";
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);

  if (campaigns === "missing") {
    rmSync(join(targetRepo, "_data"), { recursive: true, force: true });
  } else {
    const entry = Object.fromEntries([
      "store_name", "store_url", "store_terms", "store_privacy", "store_contact",
      "store_returns", "store_shipping", "store_phone", "store_phone_tel",
    ].map((field) => [field, spec.campaign[field]]));
    if (campaigns === "mismatch") entry.store_url = "https://wrong-merchant.test/";
    mkdirSync(join(targetRepo, "_data"), { recursive: true });
    writeJson(join(targetRepo, "_data/campaigns.json"), { [packet.campaign.public_route_slug]: entry });
  }
  return { dir, packetPath, targetRepo, reportPath };
}

function storeGate(result) {
  return result.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
}

test("doctor and next block a scaffolded Store Profile mismatch with exact repair/waiver actions", () => {
  const { dir, packetPath } = fixture({ campaigns: "mismatch" });
  try {
    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.errors.some((issue) => issue.code === "page_kit.store_profile"), true);
    assert.equal(storeGate(doctor).status, "blocked");
    assert.deepEqual(storeGate(doctor).blocker_fields, ["store_url"]);

    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    const nextGate = next.gates.find((gate) => gate.id === "page_kit.store_profile");
    assert.equal(next.stage, "doctor-blocked");
    assert.equal(nextGate.status, "blocked");
    assert.ok(next.next_actions.some((action) => action.id === "checkpoint.page_kit.store_profile.waive" && action.command.includes(packetPath)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint waive records bounded top-level history, stales doctor, and yields ready_with_waivers across doctor/next", () => {
  const { dir, packetPath, targetRepo, reportPath } = fixture({ campaigns: "mismatch" });
  try {
    assert.throws(() => checkpointWaive({ _: ["checkpoint", "waive"], packet: packetPath, gate: "page_kit.store_profile", reason: "Approved I-16 exception" }), /--waived-by/);
    mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
    writeJson(join(targetRepo, ".campaign-runtime/doctor-output.json"), { ok: true, status: "ready" });

    const result = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.store_profile",
      reason: "Approved I-16 exception for this exact merchant configuration",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    assert.equal(result.action, "checkpoint-waive");
    assert.equal(result.gate, "page_kit.store_profile");
    const report = readJson(reportPath);
    assert.equal(report.waivers.length, 1);
    assert.equal(report.waivers[0].waived_by, "Jordan Lee");
    assert.equal(report.waivers[0].review_condition, "Re-evaluate before production launch");
    assert.equal(report.waivers[0].subject.target_path, "_data/campaigns.json");
    assert.equal(JSON.stringify(report.waivers[0]).includes(dir), false);
    assert.ok(report.evidence.some((line) => /page_kit\.store_profile.*Jordan Lee/.test(line)));
    const sidecar = readJson(join(targetRepo, ".campaign-runtime/doctor-output.json"));
    assert.equal(sidecar.stale, true);
    assert.equal(sidecar.stale_marked_by, "checkpoint waive");

    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.ok, true, JSON.stringify(doctor.errors, null, 2));
    assert.equal(doctor.status, "ready_with_waivers");
    assert.equal(storeGate(doctor).status, "waived");
    assert.equal(doctor.warnings.some((issue) => issue.code === "page_kit.store_profile.waived"), true);
    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.status, "ready_with_waivers");
    assert.equal(next.gates.find((gate) => gate.id === "page_kit.store_profile").status, "waived");

    const reportWithPolishBlocker = readJson(reportPath);
    reportWithPolishBlocker.stages.assembly.status = "completed";
    reportWithPolishBlocker.stages.assembly.build_fingerprint = "sha256:test-build";
    reportWithPolishBlocker.stages.polish.status = "required";
    reportWithPolishBlocker.stages.polish.required_by = "build";
    reportWithPolishBlocker.stages.polish.required_for = ["qa"];
    writeJson(reportPath, reportWithPolishBlocker);
    const independentlyBlocked = doctorPacket(packetPath);
    assert.equal(storeGate(independentlyBlocked).status, "waived");
    assert.equal(independentlyBlocked.ok, false);
    assert.equal(independentlyBlocked.status, "blocked");
    assert.equal(independentlyBlocked.errors.some((issue) => issue.code === "polish.evidence_missing"), true);

    reportWithPolishBlocker.stages.assembly.status = "pending";
    delete reportWithPolishBlocker.stages.assembly.build_fingerprint;
    reportWithPolishBlocker.stages.polish.status = "pending";
    delete reportWithPolishBlocker.stages.polish.required_by;
    delete reportWithPolishBlocker.stages.polish.required_for;
    writeJson(reportPath, reportWithPolishBlocker);

    const campaignsPath = join(targetRepo, "_data/campaigns.json");
    const campaigns = readJson(campaignsPath);
    campaigns["runtime-packet-demo"].store_url = readJson(join(dir, "campaignspec.v42.basic.json")).campaign.store_url;
    writeJson(campaignsPath, campaigns);
    const corrected = doctorPacket(packetPath);
    assert.equal(storeGate(corrected).status, "pass");
    assert.equal(storeGate(corrected).waiver, null);
    assert.deepEqual(storeGate(corrected).waiver_assessment, {
      active: null,
      inert_counts: { stale: 0, foreign: 0, malformed: 0, expired: 0 },
    });
    assert.equal(readJson(reportPath).waivers.length, 1, "historical decision remains in the report");
    assert.equal(corrected.warnings.some((issue) => issue.code === "page_kit.store_profile.waiver_inert"), false);
    assert.deepEqual(corrected.warnings, []);
    assert.equal(corrected.status, "ready");
    const correctedNext = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(correctedNext.status, "ready");
    assert.equal(correctedNext.warnings.some((issue) => issue.code === "page_kit.store_profile.waiver_inert"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor treats an absent pre-scaffold target entry as not_applicable, then blocks malformed packet-ready config", () => {
  const before = fixture({ campaigns: "missing", scaffolded: false });
  try {
    const doctor = doctorPacket(before.packetPath);
    assert.equal(storeGate(doctor).status, "not_applicable");
    assert.equal(doctor.errors.some((issue) => issue.code.startsWith("page_kit.store_profile")), false);
  } finally {
    rmSync(before.dir, { recursive: true, force: true });
  }

  const outputExists = fixture({ campaigns: "missing", scaffolded: true });
  try {
    const report = readJson(outputExists.reportPath);
    report.stages.setup.status = "pending";
    report.stages.assembly.status = "pending";
    writeJson(outputExists.reportPath, report);
    const doctor = doctorPacket(outputExists.packetPath);
    assert.equal(doctor.derived.scaffold_required, false);
    assert.equal(storeGate(doctor).status, "blocked");
    assert.equal(storeGate(doctor).code, "page_kit.store_profile.target_unavailable");
    assert.equal(storeGate(doctor).waivable, false);
  } finally {
    rmSync(outputExists.dir, { recursive: true, force: true });
  }

  const malformed = fixture({ campaigns: "missing", scaffolded: true });
  try {
    mkdirSync(join(malformed.targetRepo, "_data"), { recursive: true });
    writeFileSync(join(malformed.targetRepo, "_data/campaigns.json"), "not-json");
    const doctor = doctorPacket(malformed.packetPath);
    assert.equal(storeGate(doctor).status, "blocked");
    assert.equal(storeGate(doctor).waivable, false);
    assert.throws(() => checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: malformed.packetPath,
      gate: "page_kit.store_profile",
      reason: "Cannot waive missing evidence",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    }), /not waivable/i);
  } finally {
    rmSync(malformed.dir, { recursive: true, force: true });
  }
});

test("checkpoint waive refuses a clean checkpoint and unknown gates", () => {
  const { dir, packetPath } = fixture();
  try {
    assert.throws(() => checkpointWaive({ _: ["checkpoint", "waive"], packet: packetPath, gate: "unknown", reason: "x", "waived-by": "Jordan Lee", "review-condition": "Review before launch" }), /Unknown checkpoint gate/);
    assert.throws(() => checkpointWaive({ _: ["checkpoint", "waive"], packet: packetPath, gate: "page_kit.store_profile", reason: "x", "waived-by": "Jordan Lee", "review-condition": "Review before launch" }), /is not blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint waive refuses an unbounded decision at the operator boundary", () => {
  const { dir, packetPath } = fixture({ campaigns: "mismatch" });
  try {
    assert.throws(() => checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.store_profile",
      reason: "Approved exception",
      "waived-by": "Jordan Lee",
    }), /expires_at or review_condition/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint waive refuses compound automation identities", () => {
  for (const waivedBy of [
    "Codex Agent",
    "Automation Runner",
    "System Operator",
    "GitHub Actions Runner",
    "Claude Code",
  ]) {
    const { dir, packetPath, reportPath } = fixture({ campaigns: "mismatch" });
    try {
      assert.throws(() => checkpointWaive({
        _: ["checkpoint", "waive"],
        packet: packetPath,
        gate: "page_kit.store_profile",
        reason: "Attempted automated decision",
        "waived-by": waivedBy,
        "review-condition": "Review before launch",
      }), /named human/i, waivedBy);
      assert.equal((readJson(reportPath).waivers || []).length, 0, `${waivedBy} must not write history`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("doctor, next, and the retained sidecar expose only the governed campaigns projection", () => {
  const { dir, packetPath, targetRepo } = fixture();
  const sentinels = {
    store_email: "private-email-sentinel@merchant.test",
    gtm_id: "GTM-PRIVATE-SENTINEL",
    fb_pixel_id: "private-pixel-sentinel",
    arbitrary_secret: "private-arbitrary-sentinel",
  };
  try {
    const campaignsPath = join(targetRepo, "_data/campaigns.json");
    const campaigns = readJson(campaignsPath);
    Object.assign(campaigns["runtime-packet-demo"], sentinels);
    writeJson(campaignsPath, campaigns);

    const doctor = doctorPacket(packetPath);
    const next = nextStage(null, { _: ["next"], packet: packetPath });
    const sidecar = readJson(join(targetRepo, ".campaign-runtime/doctor-output.json"));
    assert.deepEqual(doctor.derived.page_kit_campaign_config, {
      status: "ok",
      public_route_slug: "runtime-packet-demo",
      target_path: "_data/campaigns.json",
    });
    for (const [key, value] of Object.entries(sentinels)) {
      for (const [label, output] of [["doctor", doctor], ["next", next], ["sidecar", sidecar]]) {
        const serialized = JSON.stringify(output);
        assert.equal(serialized.includes(key), false, `${label} leaked ${key}`);
        assert.equal(serialized.includes(value), false, `${label} leaked the ${key} value`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor, next, and the retained sidecar publish only safe waiver attribution and inert counts", () => {
  const { dir, packetPath, targetRepo, reportPath } = fixture({ campaigns: "mismatch" });
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.store_profile",
      reason: "Bounded exact-state exception",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before launch",
    });
    const report = readJson(reportPath);
    const base = report.waivers[0];
    const taint = (record, label) => ({
      ...record,
      private_token: `${label}-private-token`,
      nested: { secret: `${label}-nested-secret` },
      absolute_path: `/private/tmp/${label}-waiver-secret`,
    });
    const stale = taint({ ...base, state_fingerprint: `sha256:${"0".repeat(64)}` }, "stale");
    const foreign = taint({ ...base, subject: { ...base.subject, public_route_slug: "foreign" } }, "foreign");
    const malformed = taint({ ...base, waived_at: "not-an-iso-timestamp" }, "malformed");
    const expired = taint({
      ...base,
      waived_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-02T00:00:00.000Z",
    }, "expired");
    const active = taint(base, "active");
    report.waivers = [stale, foreign, malformed, expired, active];
    writeJson(reportPath, report);

    const doctor = doctorPacket(packetPath);
    const next = nextStage(null, { _: ["next"], packet: packetPath });
    const sidecar = readJson(join(targetRepo, ".campaign-runtime/doctor-output.json"));
    const gate = storeGate(doctor);
    assert.equal(gate.status, "waived");
    assert.deepEqual(gate.waiver, {
      scope: "page_kit.store_profile",
      subject: { public_route_slug: "runtime-packet-demo", target_path: "_data/campaigns.json" },
      state_fingerprint: base.state_fingerprint,
      reason: "Bounded exact-state exception",
      waived_by: "Jordan Lee",
      waived_at: base.waived_at,
      review_condition: "Re-evaluate before launch",
    });
    assert.deepEqual(gate.waiver_assessment, {
      active: gate.waiver,
      inert_counts: { stale: 1, foreign: 1, malformed: 1, expired: 1 },
    });
    const inertWarning = doctor.warnings.find((issue) => issue.code === "page_kit.store_profile.waiver_inert");
    assert.deepEqual(inertWarning.detail.counts, { stale: 1, foreign: 1, malformed: 1, expired: 1 });
    assert.equal(next.gates.find((item) => item.id === "page_kit.store_profile").waiver.waived_by, "Jordan Lee");

    for (const [label, output] of [["doctor", doctor], ["next", next], ["sidecar", sidecar]]) {
      const serialized = JSON.stringify(output);
      for (const sentinel of [
        "private_token", "absolute_path", "active-private-token", "foreign-nested-secret",
        "/private/tmp/malformed-waiver-secret",
      ]) assert.equal(serialized.includes(sentinel), false, `${label} leaked ${sentinel}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
