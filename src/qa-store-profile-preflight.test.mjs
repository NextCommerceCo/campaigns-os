import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkpointWaive } from "./cli.mjs";
import { loadPageKitCampaignEntry } from "./page-kit-campaign-config.mjs";
import { __qaNodeTestHooks, runQaCli } from "./qa-node.mjs";

const EXAMPLES = new URL("../examples/", import.meta.url);
const STORE_FIELDS = [
  "store_name", "store_url", "store_terms", "store_privacy", "store_contact",
  "store_returns", "store_shipping", "store_phone", "store_phone_tel",
];
const PRIVATE_SENTINELS = Object.freeze({
  store_email: "private-email-sentinel@merchant.test",
  gtm_id: "GTM-PRIVATE-SENTINEL",
  fb_pixel_id: "private-pixel-sentinel",
  arbitrary_secret: "private-arbitrary-sentinel",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(baseUrl, { specVersion = "0.4.18", targetVersion = specVersion, storeMismatch = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qa-store-profile-"));
  const targetRepo = join(dir, "target-page-kit");
  mkdirSync(targetRepo, { recursive: true });
  const specPath = join(dir, "campaignspec.json");
  cpSync(new URL("campaignspec.v42.basic.json", EXAMPLES), specPath);
  const packetPath = join(dir, "campaign-runtime.build.json");
  const rawPacket = readJson(new URL("build-packet.basic.json", EXAMPLES));
  rawPacket.spec.local_path = "campaignspec.json";
  rawPacket.assembly.target_repo = "target-page-kit";
  rawPacket.deploy.preview_url = baseUrl;
  writeJson(packetPath, rawPacket);

  const spec = readJson(specPath);
  spec.runtime = { ...(spec.runtime || {}), sdk_version: specVersion };
  delete spec.global_config.sdk_version;
  writeJson(specPath, spec);
  const entry = Object.fromEntries(STORE_FIELDS.map((field) => [field, spec.campaign[field]]));
  if (storeMismatch) entry.store_url = "https://wrong-merchant.test/";
  entry.sdk_version = targetVersion;
  Object.assign(entry, PRIVATE_SENTINELS);
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  writeJson(campaignsPath, { [rawPacket.campaign.public_route_slug]: entry });

  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = rawPacket.spec.map_id;
  report.identity.public_route_slug = rawPacket.campaign.public_route_slug;
  report.stages.assembly.status = "pending";
  report.evidence = [];
  // QA's legacy theme/polish artifact reader is packet-adjacent; the new
  // checkpoint reader intentionally uses the target report below.
  const packetAdjacentReportPath = join(dir, ".campaign-runtime/assembly-report.json");
  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  writeJson(packetAdjacentReportPath, report);
  writeJson(reportPath, report);
  return { dir, packetPath, specPath, targetRepo, campaignsPath, reportPath, packetAdjacentReportPath };
}

function armFetchSentinel() {
  let hits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    hits += 1;
    const path = new URL(String(input)).pathname;
    const meta = path.includes("/checkout/")
      ? '<meta name="next-page-type" content="checkout"><meta name="next-success-url" content="/runtime-packet-demo/upsell/">'
      : path.includes("/upsell/")
        ? '<meta name="next-page-type" content="upsell"><meta name="next-upsell-accept-url" content="/runtime-packet-demo/receipt/"><meta name="next-upsell-decline-url" content="/runtime-packet-demo/receipt/">'
        : "";
    const links = path.includes("/landing/")
      ? '<a href="/runtime-packet-demo/checkout/">Continue</a>'
      : path.includes("/checkout/")
        ? '<a href="/runtime-packet-demo/upsell/">Submit</a>'
        : path.includes("/upsell/")
          ? '<a href="/runtime-packet-demo/receipt/">Accept</a><a href="/runtime-packet-demo/receipt/">Decline</a>'
          : "";
    return new Response(`<!doctype html><html><head><title>Fixture</title>${meta}</head><body><main>Fixture campaign</main>${links}</body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  return {
    baseUrl: "https://runtime-sentinel.invalid/runtime-packet-demo/",
    hits: () => hits,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

test("packet checkpoint blockers coexist and finalize a verdict before HTTP, browser, analytics, or typed orders", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath, targetRepo } = fixture(sentinel.baseUrl, { targetVersion: "0.4.19" });
  const priorExitCode = process.exitCode;
  try {
    const blocked = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "proxy-base": sentinel.baseUrl,
      browser: true,
      "test-order": "common",
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output"),
      "analytics-correctness": "true",
    });
    assert.equal(blocked.verdict.disposition, "blocked");
    const storeCheckpoint = blocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    const sdkCheckpoint = blocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version");
    for (const checkpoint of [storeCheckpoint, sdkCheckpoint]) {
      assert.equal(checkpoint.family, "api-metadata");
      assert.equal(checkpoint.status, "fail");
      assert.equal(checkpoint.severity, "blocker");
    }
    assert.deepEqual(sdkCheckpoint.evidence.state, { expected: "0.4.18", observed: "0.4.19" });
    assert.equal(process.exitCode, 4);
    assert.deepEqual(blocked.verdict.test_orders, []);
    assert.deepEqual(blocked.verdict.tested_urls, []);
    assert.equal(blocked.verdict.assertions.some((assertion) => assertion.id.startsWith("http:")), false);
    assert.equal(blocked.verdict.assertions.some((assertion) => assertion.family === "browser-test-order" && assertion.status !== "skipped"), false);
    assert.equal(blocked.verdict.assertions.some((assertion) => assertion.family === "analytics-correctness" && assertion.status === "skipped"), true);
    assert.equal(blocked.verdict.assertions.some((assertion) => assertion.family === "analytics-correctness" && assertion.status !== "skipped"), false);
    assert.deepEqual(
      blocked.verdict.assertions.find((assertion) => assertion.family === "analytics-correctness").evidence.blocked_by,
      ["page_kit.store_profile", "page_kit.sdk_version"],
    );
    assert.equal(sentinel.hits(), 0);
    assert.equal(existsSync(blocked.local_path), true, "an early checkpoint blocker must still write the durable local verdict");
    assert.equal(JSON.stringify(blocked.verdict).includes(dir), false);
    for (const [key, value] of Object.entries(PRIVATE_SENTINELS)) {
      const serialized = JSON.stringify(blocked.verdict);
      assert.equal(serialized.includes(key), false, `QA verdict leaked ${key}`);
      assert.equal(serialized.includes(value), false, `QA verdict leaked the ${key} value`);
    }

    // Armed control: correcting the one governed value lets the same public
    // run path reach static HTTP checks. This proves zero hits above came from
    // the checkpoint preflight rather than an unrelated no-op fixture.
    const campaignsPath = join(targetRepo, "_data/campaigns.json");
    const campaigns = readJson(campaignsPath);
    campaigns["runtime-packet-demo"].store_url = "https://store.example.com";
    campaigns["runtime-packet-demo"].sdk_version = "0.4.18";
    writeJson(campaignsPath, campaigns);
    const control = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "proxy-base": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output-control"),
      "analytics-correctness": "false",
    });
    assert.notEqual(control.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile").status, "fail");
    assert.equal(control.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version").status, "pass");
    assert.ok(sentinel.hits() > 0, "corrected control should arm and hit the HTTP server");
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exact SDK-pin waiver warns and runs only after every other checkpoint clears", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath, campaignsPath, reportPath } = fixture(sentinel.baseUrl, { targetVersion: "0.4.19" });
  const priorExitCode = process.exitCode;
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional compatibility pin for the current preview",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    const report = readJson(reportPath);
    report.waivers[0].private_token = "active-sdk-waiver-private-sentinel";
    report.waivers[0].nested = { secret: "active-sdk-waiver-nested-sentinel" };
    writeJson(reportPath, report);
    const blocked = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "proxy-base": sentinel.baseUrl,
      browser: true,
      "test-order": "common",
      "analytics-correctness": "true",
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output-blocked"),
    });
    const storeAssertion = blocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    const sdkAssertion = blocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version");
    assert.equal(storeAssertion.status, "fail", "the Store Profile blocker must remain active");
    assert.equal(sdkAssertion.status, "warn");
    assert.equal(sdkAssertion.waiver.waived_by, "Jordan Lee");
    assert.equal(blocked.verdict.disposition, "blocked");
    assert.deepEqual(
      blocked.verdict.assertions.find((assertion) => assertion.family === "analytics-correctness").evidence.blocked_by,
      ["page_kit.store_profile"],
    );
    assert.equal(sentinel.hits(), 0);
    assert.equal(JSON.stringify(blocked.verdict).includes("active-sdk-waiver-private-sentinel"), false);
    assert.equal(JSON.stringify(blocked.verdict).includes("active-sdk-waiver-nested-sentinel"), false);
    assert.equal(process.exitCode, 4);

    const campaigns = readJson(campaignsPath);
    campaigns["runtime-packet-demo"].store_url = "https://store.example.com";
    writeJson(campaignsPath, campaigns);
    const waived = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output-waived"),
      "analytics-correctness": "false",
    });
    assert.equal(waived.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version").status, "warn");
    assert.equal(waived.verdict.disposition, "ready_with_exceptions");
    assert.equal(JSON.stringify(waived.verdict).includes("active-sdk-waiver-private-sentinel"), false);
    assert.equal(JSON.stringify(waived.verdict).includes("active-sdk-waiver-nested-sentinel"), false);
    assert.ok(sentinel.hits() > 0, "the exact SDK exception should proceed to runtime QA once Store Profile clears");
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exact checkpoint waiver remains visible in QA and proceeds as ready_with_exceptions", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath, targetRepo, campaignsPath } = fixture(sentinel.baseUrl, { targetVersion: "0.4.19" });
  const priorExitCode = process.exitCode;
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.store_profile",
      reason: "Explicit I-16 exception for the current merchant configuration",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
    const report = readJson(reportPath);
    const base = report.waivers[0];
    const taint = (record, label) => ({
      ...record,
      private_token: `${label}-private-token`,
      nested: { secret: `${label}-nested-secret` },
      absolute_path: `/private/tmp/${label}-waiver-secret`,
    });
    report.waivers = [
      taint({ ...base, state_fingerprint: `sha256:${"0".repeat(64)}` }, "stale"),
      taint({ ...base, subject: { ...base.subject, public_route_slug: "foreign" } }, "foreign"),
      taint({ ...base, waived_at: "not-an-iso-timestamp" }, "malformed"),
      taint({ ...base, waived_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-02T00:00:00.000Z" }, "expired"),
      taint(base, "active"),
    ];
    writeJson(reportPath, report);
    const resolved = await runQaCli({
      _: ["qa", "resolve"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
    });
    const resolvedGate = resolved.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
    assert.deepEqual(resolvedGate.waiver_assessment.inert_counts, {
      stale: 1, foreign: 1, malformed: 1, expired: 1,
    });
    assert.equal(resolvedGate.waiver.waived_by, "Jordan Lee");
    assert.equal(resolvedGate.waiver.review_condition, "Re-evaluate before production launch");
    const resolvedSdkGate = resolved.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version");
    assert.equal(resolvedSdkGate.status, "blocked");
    const stillBlocked = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output"),
      "analytics-correctness": "false",
    });
    const storeWhileBlocked = stillBlocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    const sdkWhileBlocked = stillBlocked.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version");
    assert.equal(storeWhileBlocked.status, "warn");
    assert.equal(sdkWhileBlocked.status, "fail");
    assert.equal(stillBlocked.verdict.disposition, "blocked");
    assert.deepEqual(
      stillBlocked.verdict.assertions.find((assertion) => assertion.family === "analytics-correctness").evidence.blocked_by,
      ["page_kit.sdk_version"],
    );
    assert.equal(sentinel.hits(), 0, "a Store Profile waiver must not suppress the independent SDK blocker");

    const campaigns = readJson(campaignsPath);
    campaigns["runtime-packet-demo"].sdk_version = "0.4.18";
    writeJson(campaignsPath, campaigns);
    const result = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output-cleared"),
      "analytics-correctness": "false",
    });
    const checkpoint = result.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    assert.equal(checkpoint.status, "warn");
    assert.equal(checkpoint.waiver.waived_by, "Jordan Lee");
    assert.match(checkpoint.waiver.reason, /I-16/);
    assert.deepEqual(checkpoint.evidence.waiver_assessment.inert_counts, {
      stale: 1, foreign: 1, malformed: 1, expired: 1,
    });
    assert.equal(result.verdict.disposition, "ready_with_exceptions");
    assert.equal(result.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version").status, "pass");
    assert.ok(sentinel.hits() > 0, "waived checkpoint should continue to static runtime proof only after the SDK blocker clears");
    for (const [label, output] of [["qa resolve", resolved], ["QA verdict", result.verdict]]) {
      const serialized = JSON.stringify(output);
      for (const privateSentinel of [
        "private_token", "absolute_path", "active-private-token", "foreign-nested-secret",
        "/private/tmp/malformed-waiver-secret",
      ]) assert.equal(serialized.includes(privateSentinel), false, `${label} leaked ${privateSentinel}`);
    }
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packet QA reports missing campaigns.json as a non-waivable preflight blocker", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath, targetRepo } = fixture(sentinel.baseUrl);
  const priorExitCode = process.exitCode;
  try {
    rmSync(join(targetRepo, "_data"), { recursive: true, force: true });
    const resolved = await runQaCli({
      _: ["qa", "resolve"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
    });
    const resolvedGate = resolved.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
    const resolvedSdkGate = resolved.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version");
    assert.equal(resolvedGate.status, "blocked");
    assert.equal(resolvedGate.waivable, false);
    assert.equal(resolvedSdkGate.status, "blocked");
    assert.equal(resolvedSdkGate.code, "page_kit.sdk_version.target_unavailable");
    assert.equal(resolvedSdkGate.waivable, false);
    assert.equal(sentinel.hits(), 0);
    const result = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output"),
    });
    const checkpoint = result.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    const sdkCheckpoint = result.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version");
    assert.equal(checkpoint.status, "fail");
    assert.equal(checkpoint.evidence.waivable, false);
    assert.equal(checkpoint.evidence.state_fingerprint, null);
    assert.equal(sdkCheckpoint.status, "fail");
    assert.equal(sdkCheckpoint.evidence.waivable, false);
    assert.equal(sdkCheckpoint.evidence.state_fingerprint, null);
    assert.equal(sentinel.hits(), 0);
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packet QA never falls back to a remote spec before local Store Profile evidence exists", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath } = fixture(sentinel.baseUrl);
  const priorExitCode = process.exitCode;
  try {
    const packet = readJson(packetPath);
    delete packet.spec.local_path;
    writeJson(packetPath, packet);
    const result = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "proxy-base": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output"),
    });
    const checkpoint = result.verdict.assertions.find((assertion) => assertion.id === "page_kit.store_profile");
    const sdkCheckpoint = result.verdict.assertions.find((assertion) => assertion.id === "page_kit.sdk_version");
    assert.equal(checkpoint.status, "fail");
    assert.equal(checkpoint.evidence.code, "page_kit.store_profile.spec_unavailable");
    assert.equal(checkpoint.evidence.waivable, false);
    assert.equal(sdkCheckpoint.status, "fail");
    assert.equal(sdkCheckpoint.evidence.code, "page_kit.sdk_version.spec_unavailable");
    assert.equal(sdkCheckpoint.evidence.waivable, false);
    assert.equal(sentinel.hits(), 0, "remote spec fallback must remain behind packet-local checkpoint preflight");
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid SDK declarations and target values stay non-waivable and private", async () => {
  const sentinel = armFetchSentinel();
  const declaration = fixture(sentinel.baseUrl, { storeMismatch: false });
  try {
    const spec = readJson(declaration.specPath);
    spec.runtime.sdk_version = "0.4.18-rc.1";
    writeJson(declaration.specPath, spec);
    const resolved = await runQaCli({ _: ["qa", "resolve"], packet: declaration.packetPath, "base-url": sentinel.baseUrl });
    const gate = resolved.checkpoint_gates.find((candidate) => candidate.id === "page_kit.sdk_version");
    assert.equal(gate.status, "blocked");
    assert.equal(gate.code, "page_kit.sdk_version.spec_invalid");
    assert.equal(gate.waivable, false);
    assert.equal(gate.state_fingerprint, null);
    assert.equal(sentinel.hits(), 0);
  } finally {
    rmSync(declaration.dir, { recursive: true, force: true });
  }

  const target = fixture(sentinel.baseUrl, { storeMismatch: false });
  try {
    const campaigns = readJson(target.campaignsPath);
    campaigns["runtime-packet-demo"].sdk_version = { private_token: "private-sdk-target-sentinel" };
    writeJson(target.campaignsPath, campaigns);
    const resolved = await runQaCli({ _: ["qa", "resolve"], packet: target.packetPath, "base-url": sentinel.baseUrl });
    const gate = resolved.checkpoint_gates.find((candidate) => candidate.id === "page_kit.sdk_version");
    assert.equal(gate.status, "blocked");
    assert.equal(gate.code, "page_kit.sdk_version.target_invalid");
    assert.equal(gate.waivable, false);
    assert.equal(gate.observed_sdk_version, null);
    assert.equal(JSON.stringify(resolved).includes("private_token"), false);
    assert.equal(JSON.stringify(resolved).includes("private-sdk-target-sentinel"), false);
    assert.equal(sentinel.hits(), 0);
  } finally {
    sentinel.restore();
    rmSync(target.dir, { recursive: true, force: true });
  }
});

test("stale, foreign, malformed, and expired SDK decisions stay blocked and count-only in QA", async () => {
  const sentinel = armFetchSentinel();
  const { dir, packetPath, reportPath } = fixture(sentinel.baseUrl, { storeMismatch: false, targetVersion: "0.4.19" });
  const priorExitCode = process.exitCode;
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional compatibility pin",
      "waived-by": "Jordan Lee",
      "review-condition": "Review before launch",
    });
    const report = readJson(reportPath);
    const base = report.waivers[0];
    const taint = (record, label) => ({ ...record, private_token: `${label}-sdk-secret`, nested: { secret: `${label}-nested-sdk-secret` } });
    report.waivers = [
      taint({ ...base, state_fingerprint: `sha256:${"0".repeat(64)}` }, "stale"),
      taint({ ...base, subject: { ...base.subject, public_route_slug: "foreign" } }, "foreign"),
      taint({ ...base, waived_at: "not-a-time" }, "malformed"),
      taint({ ...base, waived_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-02T00:00:00.000Z" }, "expired"),
    ];
    writeJson(reportPath, report);
    const resolved = await runQaCli({ _: ["qa", "resolve"], packet: packetPath, "base-url": sentinel.baseUrl });
    const gate = resolved.checkpoint_gates.find((candidate) => candidate.id === "page_kit.sdk_version");
    assert.equal(gate.status, "blocked");
    assert.deepEqual(gate.waiver_assessment, {
      active: null,
      inert_counts: { stale: 1, foreign: 1, malformed: 1, expired: 1 },
    });
    const result = await runQaCli({
      _: ["qa", "run"],
      packet: packetPath,
      "base-url": sentinel.baseUrl,
      "no-post-verdict": true,
      "no-remit": true,
      "output-dir": join(dir, "qa-output"),
    });
    const assertion = result.verdict.assertions.find((candidate) => candidate.id === "page_kit.sdk_version");
    assert.equal(assertion.status, "fail");
    assert.deepEqual(assertion.evidence.waiver_assessment.inert_counts, { stale: 1, foreign: 1, malformed: 1, expired: 1 });
    assert.equal(sentinel.hits(), 0);
    assert.equal(process.exitCode, 4);
    for (const output of [resolved, result.verdict]) {
      assert.equal(JSON.stringify(output).includes("private_token"), false);
      assert.equal(JSON.stringify(output).includes("-sdk-secret"), false);
    }
  } finally {
    process.exitCode = priorExitCode;
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packet QA consumes packet, spec, campaign entry, and Assembly Report once for every gate and runtime plan", async () => {
  const sentinel = armFetchSentinel();
  const {
    dir,
    packetPath,
    specPath,
    targetRepo,
    campaignsPath,
    reportPath,
    packetAdjacentReportPath,
  } = fixture(sentinel.baseUrl, { storeMismatch: false, targetVersion: "0.4.19" });
  try {
    checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Snapshot SDK decision",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before launch",
    });
    const snapshotReport = readJson(reportPath);
    snapshotReport.theme = {
      status: "skipped",
      load_order: "not-applied",
      waiver: { reason: "snapshot theme waiver", waived_by: "Jordan Lee", waived_at: "2026-08-19T00:00:00.000Z" },
    };
    snapshotReport.stages.qa.waivers = {
      "analytics-correctness:purchase-fires": {
        reason: "snapshot QA waiver",
        waived_by: "Jordan Lee",
        waived_at: "2026-08-19T00:00:00.000Z",
      },
    };
    writeJson(reportPath, snapshotReport);
    const contradictoryReport = structuredClone(snapshotReport);
    contradictoryReport.waivers = [];
    contradictoryReport.theme.waiver.reason = "mutated theme waiver";
    contradictoryReport.stages.assembly.status = "completed";
    contradictoryReport.stages.qa.waivers["analytics-correctness:purchase-fires"].reason = "mutated QA waiver";
    writeJson(packetAdjacentReportPath, contradictoryReport);

    let packetReads = 0;
    let specReads = 0;
    let reportReads = 0;
    let campaignReads = 0;
    const readJsonFile = (path) => {
      const snapshot = readJson(path);
      if (path === packetPath) {
        packetReads += 1;
        if (packetReads === 1) {
          const changed = structuredClone(snapshot);
          changed.spec.map_id = "mutated-map-after-gate";
          changed.campaign.public_route_slug = "mutated-route-after-gate";
          writeJson(packetPath, changed);
        }
      } else if (path === specPath) {
        specReads += 1;
        if (specReads === 1) {
          const changed = structuredClone(snapshot);
          changed.spec_identity.map_id = "mutated-map-after-gate";
          changed.campaign.public_route_slug = "mutated-route-after-gate";
          changed.campaign.name = "Mutated campaign after gate";
          writeJson(specPath, changed);
        }
      } else if (path === reportPath) {
        reportReads += 1;
        if (reportReads === 1) writeJson(reportPath, contradictoryReport);
      }
      return snapshot;
    };
    const loadCampaignEntry = (input) => {
      campaignReads += 1;
      const snapshot = loadPageKitCampaignEntry(input);
      if (campaignReads === 1) {
        const changed = readJson(campaignsPath);
        changed["runtime-packet-demo"].store_url = "https://wrong-after-snapshot.test/";
        changed["runtime-packet-demo"].sdk_version = "0.4.18";
        writeJson(campaignsPath, changed);
      }
      return snapshot;
    };

    const resolved = await __qaNodeTestHooks.resolveQaInputs({
      _: ["qa", "resolve"],
      packet: packetPath,
      report: reportPath,
      "base-url": sentinel.baseUrl,
    }, { readJsonFile, loadCampaignEntry });
    assert.equal(packetReads, 1, "packet must be read exactly once for gate and runtime planning");
    assert.equal(specReads, 1, "local spec must be read exactly once for gate and runtime planning");
    assert.equal(campaignReads, 1, "the campaign entry must be read exactly once for both checkpoints");
    assert.equal(reportReads, 1, "the Assembly Report must be read exactly once for every gate and waiver consumer");
    assert.equal(resolved.mapId, "runtime-packet-demo-k9x2");
    assert.equal(resolved.publicRouteSlug, "runtime-packet-demo");
    assert.equal(resolved.packet.spec.map_id, "runtime-packet-demo-k9x2");
    assert.notEqual(resolved.spec.campaign.name, "Mutated campaign after gate");
    assert.equal(resolved.checkpointGates.find((gate) => gate.id === "page_kit.store_profile").status, "pass");
    assert.equal(resolved.checkpointGates.find((gate) => gate.id === "page_kit.sdk_version").status, "waived");
    assert.equal(resolved.themeGate.status, "waived");
    assert.equal(resolved.themeGate.waiver.reason, "snapshot theme waiver");
    assert.equal(resolved.polishGate.status, "not_applicable");
    assert.equal(resolved.qaWaivers["analytics-correctness:purchase-fires"].reason, "snapshot QA waiver");
    assert.ok(resolved.topologies.every((topology) => topology.pages.every((page) => page.url.includes("/runtime-packet-demo/"))));
  } finally {
    sentinel.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
