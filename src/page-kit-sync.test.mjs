import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkpointWaive, doctorPacket, nextStage, pageKitSyncCommand, pageKitSyncTextLines } from "./cli.mjs";
import { DOCTOR_SIDECAR_REL_PATH } from "./doctor-sidecar.mjs";
import { evaluatePageKitSdkVersion, resolveSpecSdkPin } from "./page-kit-sdk-version.mjs";
import { stageRealPackageInstall } from "./package-install-fixture.mjs";
import { evaluatePageKitStoreProfile, PAGE_KIT_SYNC_COMMAND } from "./page-kit-store-profile.mjs";
import {
  applyPageKitSync,
  formatSyncValue,
  PAGE_KIT_SYNC_FIELDS,
  planPageKitSync,
} from "./page-kit-sync.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = new URL("../examples/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// What `campaign-init` seeds for a route (captured from a real olympus
// scaffold on 2026-09-15): the starter family's demo store profile and pin,
// plus three non-governed keys sync must never touch.
const SCAFFOLD_ENTRY = Object.freeze({
  name: "Acme Glow",
  description: "Olympus checkout funnel",
  entry_url: "presell",
  sdk_version: "0.4.38",
  store_name: "Next Commerce",
  store_url: "https://demo.29next.com/",
  store_terms: "https://demo.29next.com/terms-conditions/",
  store_privacy: "https://demo.29next.com/privacy-policy/",
  store_contact: "https://demo.29next.com/contact/",
  store_returns: "https://demo.29next.com/returns/",
  store_shipping: "https://demo.29next.com/shipping/",
  store_phone: "1 (888) 831-6810",
  store_phone_tel: "tel:+18888316810",
  gtm_id: "",
  fb_pixel_id: "",
  og_image: "",
});

// The example CampaignSpec's own Store Profile values, for a target that
// already matches it on every field but the pin.
const SPEC_TARGET_MATCH = Object.freeze({
  store_name: "Example Store",
  store_url: "https://store.example.com",
  store_terms: "https://store.example.com/terms",
  store_privacy: "https://store.example.com/privacy",
  store_contact: "https://store.example.com/contact",
  store_returns: "https://store.example.com/returns",
  store_shipping: "https://store.example.com/shipping",
  store_phone: "1-800-555-0100",
  store_phone_tel: "tel:+18005550100",
});

// The same entry after a merchant has replaced the demo values by hand: the
// uncarried-field tests use it so "left as it is" is not confused with the
// demo-residue state, which sync reports separately.
const NON_DEMO_ENTRY = Object.freeze({
  ...SCAFFOLD_ENTRY,
  store_name: "Someone Else",
  store_url: "https://someone.example/",
  store_terms: "https://someone.example/terms",
  store_privacy: "https://someone.example/privacy",
  store_contact: "https://someone.example/contact",
  store_returns: "https://someone.example/returns",
  store_shipping: "https://someone.example/shipping",
  store_phone: "1-800-555-0111",
  store_phone_tel: "tel:+18005550111",
});

const SPEC = Object.freeze({
  campaign: {
    store_name: "Acme Glow",
    store_url: "https://acmeglow.example",
    store_terms: "https://acmeglow.example/terms",
    store_privacy: "https://acmeglow.example/privacy",
    store_contact: "https://acmeglow.example/contact",
    store_returns: "https://acmeglow.example/returns",
    store_shipping: "https://acmeglow.example/shipping",
    store_phone: "1-800-555-0199",
    store_phone_tel: "tel:+18005550199",
  },
  global_config: { sdk_version: "0.4.36" },
});

test("planPageKitSync diffs every governed field the spec carries, and nothing else", () => {
  const plan = planPageKitSync({ spec: SPEC, entry: SCAFFOLD_ENTRY });
  assert.deepEqual(plan.changes.map((row) => row.field), [...PAGE_KIT_SYNC_FIELDS]);
  assert.deepEqual(plan.unchanged, []);
  assert.deepEqual(plan.not_in_spec, []);
  assert.deepEqual(plan.not_synced, []);
  const storeUrl = plan.changes.find((row) => row.field === "store_url");
  assert.deepEqual(storeUrl, {
    field: "store_url",
    before: "https://demo.29next.com/",
    after: "https://acmeglow.example",
    source: "campaign.store_url",
  });
  const sdk = plan.changes.find((row) => row.field === "sdk_version");
  assert.deepEqual(sdk, { field: "sdk_version", before: "0.4.38", after: "0.4.36", source: "global_config.sdk_version" });
});

test("planPageKitSync leaves fields the spec does not carry alone and reports them", () => {
  const spec = { campaign: { store_url: "https://acmeglow.example", store_name: "   " }, global_config: { sdk_version: "0.4.38" } };
  const plan = planPageKitSync({ spec, entry: NON_DEMO_ENTRY });
  assert.deepEqual(plan.changes.map((row) => row.field), ["store_url"]);
  assert.deepEqual(plan.unchanged.map((row) => row.field), ["sdk_version"]);
  // A blank spec string is "not carried", same as an absent key.
  assert.deepEqual(plan.not_in_spec, [
    "store_name", "store_terms", "store_privacy", "store_contact",
    "store_returns", "store_shipping", "store_phone", "store_phone_tel",
  ]);
});

test("planPageKitSync normalizes spec values the way the gate compares them", () => {
  const spec = { campaign: { store_name: "  Acme Glow \n" } };
  const plan = planPageKitSync({ spec, entry: { store_name: "Acme Glow" } });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.unchanged.map((row) => row.field), ["store_name"]);
  assert.ok(plan.not_in_spec.includes("sdk_version"));
});

test("resolveSpecSdkPin prefers the canonical pin, accepts the alias, refuses conflicts and invalid pins", () => {
  assert.deepEqual(resolveSpecSdkPin({ global_config: { sdk_version: "0.4.36" }, runtime: { sdk_version: "0.4.36" } }), {
    value: "0.4.36", source: "global_config.sdk_version", status: "ok", has_canonical: true, has_alias: true, invalid_declarations: [],
  });
  assert.deepEqual(resolveSpecSdkPin({ runtime: { sdk_version: "0.4.35" } }), {
    value: "0.4.35", source: "runtime.sdk_version", status: "ok", has_canonical: false, has_alias: true, invalid_declarations: [],
  });
  assert.equal(resolveSpecSdkPin({}).status, "spec_missing");
  assert.equal(resolveSpecSdkPin({ global_config: { sdk_version: "0.4.36" }, runtime: { sdk_version: "0.4.35" } }).status, "spec_conflict");
  assert.equal(resolveSpecSdkPin({ global_config: { sdk_version: "v0.4.36" } }).status, "spec_invalid");
  assert.equal(resolveSpecSdkPin({ global_config: { sdk_version: "0.4.36-beta.1" } }).status, "spec_invalid");
});

test("planPageKitSync never writes an invalid or conflicting SDK pin; it reports why", () => {
  const conflict = planPageKitSync({
    spec: { campaign: {}, global_config: { sdk_version: "0.4.36" }, runtime: { sdk_version: "0.4.35" } },
    entry: NON_DEMO_ENTRY,
  });
  assert.deepEqual(conflict.changes, []);
  assert.equal(conflict.not_synced.length, 1);
  assert.equal(conflict.not_synced[0].field, "sdk_version");
  assert.equal(conflict.not_synced[0].reason, "spec_conflict");
  const invalid = planPageKitSync({ spec: { global_config: { sdk_version: "latest" } }, entry: NON_DEMO_ENTRY });
  assert.equal(invalid.not_synced[0].reason, "spec_invalid");
});

test("applyPageKitSync edits the named entry in place, preserves key order, and touches no other entry", () => {
  const campaigns = {
    other: { name: "Other", store_url: "https://demo.29next.com/", sdk_version: "0.4.38" },
    "acme-glow": { ...SCAFFOLD_ENTRY },
  };
  const plan = planPageKitSync({ spec: SPEC, entry: campaigns["acme-glow"] });
  applyPageKitSync(campaigns, "acme-glow", plan);
  assert.deepEqual(Object.keys(campaigns["acme-glow"]), Object.keys(SCAFFOLD_ENTRY));
  assert.equal(campaigns["acme-glow"].store_url, "https://acmeglow.example");
  assert.equal(campaigns["acme-glow"].sdk_version, "0.4.36");
  assert.equal(campaigns["acme-glow"].gtm_id, "");
  assert.equal(campaigns["acme-glow"].entry_url, "presell");
  assert.deepEqual(campaigns.other, { name: "Other", store_url: "https://demo.29next.com/", sdk_version: "0.4.38" });
});

test("applyPageKitSync appends a governed field the entry lacks and refuses a non-governed one", () => {
  const campaigns = { r: { name: "R" } };
  applyPageKitSync(campaigns, "r", { changes: [{ field: "store_url", before: undefined, after: "https://acmeglow.example" }] });
  assert.deepEqual(campaigns.r, { name: "R", store_url: "https://acmeglow.example" });
  assert.throws(
    () => applyPageKitSync(campaigns, "r", { changes: [{ field: "gtm_id", before: "", after: "GTM-X" }] }),
    /Refusing to write "gtm_id"/,
  );
  assert.equal(campaigns.r.gtm_id, undefined);
  assert.throws(() => applyPageKitSync(campaigns, "missing", { changes: [] }), /no object entry for "missing"/);
});

test("both page-kit gates name page-kit sync as the target repair, with the packet placeholder", () => {
  const targetLoad = { status: "ok", public_route_slug: "acme-glow", target_path: "_data/campaigns.json", entry: SCAFFOLD_ENTRY };
  const profile = evaluatePageKitStoreProfile({ specCampaign: SPEC.campaign, targetLoad });
  assert.equal(profile.status, "blocked");
  const profileRepair = profile.required_actions.find((action) => action.id === "repair_target");
  assert.equal(profileRepair.kind, "command");
  assert.equal(profileRepair.command, PAGE_KIT_SYNC_COMMAND);
  assert.equal(PAGE_KIT_SYNC_COMMAND, "campaigns-os page-kit sync --packet <packet>");
  // Demo residue offers no waiver, so sync is the only action.
  assert.deepEqual(profile.required_actions.map((action) => action.id), ["repair_target"]);

  const sdk = evaluatePageKitSdkVersion({ spec: SPEC, targetLoad });
  assert.equal(sdk.status, "blocked");
  const sdkRepair = sdk.required_actions.find((action) => action.id === "repair_target");
  assert.equal(sdkRepair.kind, "command");
  assert.equal(sdkRepair.command, PAGE_KIT_SYNC_COMMAND);
  assert.match(sdkRepair.description, /0\.4\.36/);

  const missingPin = evaluatePageKitSdkVersion({ spec: SPEC, targetLoad: { ...targetLoad, entry: { name: "x" } } });
  assert.equal(missingPin.code, "page_kit.sdk_version.target_missing");
  assert.equal(missingPin.required_actions[0].command, PAGE_KIT_SYNC_COMMAND);
});

test("a spec-side Store Profile defect keeps the repair an edit: sync cannot make the target authoritative", () => {
  const targetLoad = { status: "ok", public_route_slug: "acme-glow", target_path: "_data/campaigns.json", entry: SCAFFOLD_ENTRY };
  const gate = evaluatePageKitStoreProfile({ specCampaign: { ...SPEC.campaign, store_name: ["not", "a", "string"] }, targetLoad });
  assert.equal(gate.status, "blocked");
  const repair = gate.required_actions.find((action) => action.id === "repair_target");
  assert.equal(repair.kind, "edit");
  assert.equal(repair.command, null);
  assert.match(repair.description, /store_name/);
  assert.match(repair.description, /page-kit sync/);
});

// A packet-shaped fixture around the examples: the target entry is replaced
// with what campaign-init seeds so the two gates block exactly as they do on a
// fresh scaffold, without the network the real scaffold needs.
function fixture({ entry = SCAFFOLD_ENTRY, spec: specPatch = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "page-kit-sync-"));
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
  const targetRepo = join(dir, "target-page-kit");
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  spec.global_config.sdk_version = "0.4.36";
  for (const funnel of spec.funnels || []) {
    for (const page of funnel.pages || []) delete page.sdk_hints;
  }
  if (specPatch) specPatch(spec);
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
  if (entry) campaigns[packet.campaign.public_route_slug] = { ...entry, name: "Runtime Packet Demo" };
  else delete campaigns[packet.campaign.public_route_slug];
  // Keep a second route so "other entries are untouched" is observable.
  campaigns["other-route"] = { name: "Other", store_url: "https://demo.29next.com/", sdk_version: "0.4.38" };
  writeJson(campaignsPath, campaigns);

  const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
  const report = readJson(new URL("assembly-report.example.json", EXAMPLES));
  report.identity.map_id = packet.spec.map_id;
  report.identity.public_route_slug = packet.campaign.public_route_slug;
  report.stages.setup.status = "skipped";
  report.stages.deploy.status = "skipped";
  report.evidence = [];
  writeJson(reportPath, report);
  return { dir, packetPath, targetRepo, specPath, campaignsPath, slug: packet.campaign.public_route_slug };
}

function pageKitGates(result) {
  return Object.fromEntries(
    result.derived.checkpoint_gates
      .filter((gate) => gate.id.startsWith("page_kit."))
      .map((gate) => [gate.id, gate.status]),
  );
}

test("page-kit sync takes a scaffold-seeded target from two blocked gates to two passes, touching nothing else", () => {
  const { dir, packetPath, campaignsPath, slug } = fixture();
  try {
    const before = doctorPacket(packetPath);
    assert.deepEqual(pageKitGates(before), { "page_kit.sdk_version": "blocked", "page_kit.store_profile": "blocked" });
    const profileGate = before.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
    assert.ok(profileGate.state.discrepancies.some((row) => row.kind === "demo_residue"));
    assert.equal(profileGate.waivable, false, "demo residue is unwaivable; sync is the only way through");

    // The blocked `next` hands the operator the sync command with the real packet.
    const next = nextStage(null, { _: ["next"], packet: packetPath, "no-write": true });
    assert.equal(next.stage, "doctor-blocked");
    const syncActions = next.next_actions.filter((action) => action.id.endsWith(".repair_target"));
    assert.deepEqual(syncActions.map((action) => action.id).sort(), [
      "checkpoint.page_kit.sdk_version.repair_target",
      "checkpoint.page_kit.store_profile.repair_target",
    ]);
    for (const action of syncActions) {
      assert.equal(action.kind, "command");
      assert.equal(action.command, `campaigns-os page-kit sync --packet ${packetPath}`);
    }

    const untouchedBefore = readJson(campaignsPath);
    const dry = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath, "dry-run": true });
    assert.equal(dry.ok, true);
    assert.equal(dry.status, "dry_run");
    assert.equal(dry.written, false);
    assert.equal(dry.changes.length, 10);
    assert.deepEqual(readJson(campaignsPath), untouchedBefore, "--dry-run writes nothing");
    assert.deepEqual(pageKitGates(doctorPacket(packetPath)), { "page_kit.sdk_version": "blocked", "page_kit.store_profile": "blocked" });

    const synced = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(synced.ok, true);
    assert.equal(synced.status, "synced");
    assert.equal(synced.written, true);
    assert.deepEqual(synced.changes.map((row) => [row.field, row.before, row.after]), [
      ["store_name", "Next Commerce", "Example Store"],
      ["store_url", "https://demo.29next.com/", "https://store.example.com"],
      ["store_terms", "https://demo.29next.com/terms-conditions/", "https://store.example.com/terms"],
      ["store_privacy", "https://demo.29next.com/privacy-policy/", "https://store.example.com/privacy"],
      ["store_contact", "https://demo.29next.com/contact/", "https://store.example.com/contact"],
      ["store_returns", "https://demo.29next.com/returns/", "https://store.example.com/returns"],
      ["store_shipping", "https://demo.29next.com/shipping/", "https://store.example.com/shipping"],
      ["store_phone", "1 (888) 831-6810", "1-800-555-0100"],
      ["store_phone_tel", "tel:+18888316810", "tel:+18005550100"],
      ["sdk_version", "0.4.38", "0.4.36"],
    ]);
    assert.deepEqual(synced.not_in_spec, []);
    assert.deepEqual(synced.not_synced, []);
    assert.match(synced.next, /^campaigns-os doctor --packet /);

    const after = readJson(campaignsPath);
    // Non-governed keys and key order survive; the other route is byte-identical.
    assert.deepEqual(Object.keys(after[slug]), Object.keys(untouchedBefore[slug]));
    assert.equal(after[slug].description, "Olympus checkout funnel");
    assert.equal(after[slug].entry_url, "presell");
    assert.equal(after[slug].gtm_id, "");
    assert.deepEqual(after["other-route"], untouchedBefore["other-route"]);
    assert.ok(readFileSync(campaignsPath, "utf8").endsWith("}\n"));

    const doctorAfter = doctorPacket(packetPath);
    assert.deepEqual(pageKitGates(doctorAfter), { "page_kit.sdk_version": "pass", "page_kit.store_profile": "pass" });
    assert.equal(doctorAfter.errors.some((issue) => issue.code.startsWith("page_kit.")), false);
    assert.equal(doctorAfter.warnings.some((issue) => issue.code.startsWith("page_kit.store_profile")), false, "no waiver, no target_only warning");

    const again = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(again.status, "unchanged");
    assert.equal(again.written, false);
    assert.equal(again.unchanged.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync exits 2 with a named reason when the entry is missing, and writes nothing", () => {
  const { dir, packetPath, campaignsPath } = fixture({ entry: null });
  try {
    const before = readFileSync(campaignsPath, "utf8");
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "page_kit.sync.entry_missing");
    assert.equal(result.errors[0].detail.target_status, "entry_missing");
    assert.match(result.errors[0].message, /has no entry for "runtime-packet-demo"/);
    assert.equal(readFileSync(campaignsPath, "utf8"), before);

    const cli = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath], { encoding: "utf8" });
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /^Status: BLOCKED/);
    assert.match(cli.stdout, /\[page_kit\.sync\.entry_missing\]/);

    const json = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--json"], { encoding: "utf8" });
    assert.equal(json.status, 2);
    assert.equal(JSON.parse(json.stdout).errors[0].code, "page_kit.sync.entry_missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync exits 2 when the spec is missing and reports a missing target file by name", () => {
  const { dir, packetPath, specPath, campaignsPath } = fixture();
  try {
    rmSync(specPath);
    const noSpec = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(noSpec.ok, false);
    assert.deepEqual(noSpec.errors.map((issue) => issue.code), ["page_kit.sync.spec_missing"]);

    const packet = readJson(packetPath);
    delete packet.spec.local_path;
    writeJson(packetPath, packet);
    const noPath = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.deepEqual(noPath.errors.map((issue) => issue.code), ["page_kit.sync.spec_missing"]);
    assert.match(noPath.errors[0].message, /spec\.local_path/);

    rmSync(campaignsPath);
    const noFile = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.ok(noFile.errors.some((issue) => issue.code === "page_kit.sync.entry_missing" && issue.detail.target_status === "file_missing"));
    assert.equal(spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync writes the alias pin when the canonical one is absent, and refuses a conflicting pair", () => {
  const aliasOnly = fixture({
    spec: (spec) => {
      delete spec.global_config.sdk_version;
      spec.runtime = { sdk_version: "0.4.35" };
    },
  });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: aliasOnly.packetPath });
    const sdk = result.changes.find((row) => row.field === "sdk_version");
    assert.deepEqual(sdk, { field: "sdk_version", before: "0.4.38", after: "0.4.35", source: "runtime.sdk_version" });
    assert.equal(readJson(aliasOnly.campaignsPath)[aliasOnly.slug].sdk_version, "0.4.35");
    assert.equal(pageKitGates(doctorPacket(aliasOnly.packetPath))["page_kit.sdk_version"], "pass");
  } finally {
    rmSync(aliasOnly.dir, { recursive: true, force: true });
  }

  const conflict = fixture({
    spec: (spec) => {
      spec.runtime = { sdk_version: "0.4.35" };
    },
  });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: conflict.packetPath });
    assert.equal(result.ok, true, "the Store Profile fields still sync");
    assert.equal(result.changes.some((row) => row.field === "sdk_version"), false);
    assert.deepEqual(result.not_synced.map((row) => [row.field, row.reason]), [["sdk_version", "spec_conflict"]]);
    assert.deepEqual(result.warnings.map((issue) => issue.code), ["page_kit.sync.sdk_version_not_synced"]);
    assert.equal(readJson(conflict.campaignsPath)[conflict.slug].sdk_version, "0.4.38", "the target pin is left as it was");
    assert.equal(readJson(conflict.campaignsPath)[conflict.slug].store_url, "https://store.example.com");
    const text = pageKitSyncTextLines(result);
    assert.ok(text.some((line) => line.startsWith("Warnings:")));
    assert.ok(text.some((line) => /sdk_version was not written: .*global_config is canonical/.test(line)));
  } finally {
    rmSync(conflict.dir, { recursive: true, force: true });
  }
});

test("page-kit sync CLI prints the field-by-field diff and a doctor pointer, and --json is the result document", () => {
  const { dir, packetPath } = fixture();
  try {
    const dry = execFileSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--dry-run"], { encoding: "utf8" });
    assert.match(dry, /^Status: DRY RUN\n/);
    assert.match(dry, /Changes \(dry run, nothing written\): 10\n/);
    assert.match(dry, /- store_url: "https:\/\/demo\.29next\.com\/" -> "https:\/\/store\.example\.com"  \(from campaign\.store_url\)\n/);
    assert.match(dry, /- sdk_version: "0\.4\.38" -> "0\.4\.36"  \(from global_config\.sdk_version\)\n/);
    assert.match(dry, /Next: campaigns-os doctor --packet /);

    const json = JSON.parse(execFileSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--json"], { encoding: "utf8" }));
    assert.equal(json.action, "page-kit sync");
    assert.equal(json.status, "synced");
    assert.equal(json.written, true);
    assert.equal(json.changes.length, 10);
    assert.equal(json.target_path, "_data/campaigns.json");

    const text = execFileSync("node", [CLI, "page-kit", "sync", "--packet", packetPath], { encoding: "utf8" });
    assert.match(text, /^Status: UNCHANGED\n/);
    assert.match(text, /Changes: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit without a subcommand, or with an unknown one, is an error naming the sync form", () => {
  const out = spawnSync("node", [CLI, "page-kit", "--packet", "x"], { encoding: "utf8" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /Unknown page-kit subcommand\. Use: campaigns-os page-kit sync --packet/);
  const typo = spawnSync("node", [CLI, "page-kit", "synk", "--packet", "x"], { encoding: "utf8" });
  assert.match(typo.stderr, /Unknown page-kit subcommand/);
});

test("planPageKitSync reports a non-string spec value as not synced, treats a non-object entry as empty, and refuses an invalid alias pin", () => {
  // A non-string spec value cannot make the target authoritative, and doctor
  // blocks on it as spec_invalid_type: it is reported, not silently treated
  // as absent, and the target is left alone.
  const nonString = planPageKitSync({
    spec: { campaign: { store_name: ["not", "a", "string"], store_url: 42, store_phone: "1-800-555-0199" } },
    entry: NON_DEMO_ENTRY,
  });
  assert.deepEqual(nonString.changes.map((row) => row.field), ["store_phone"]);
  assert.deepEqual(nonString.not_synced.map((row) => [row.field, row.reason]), [
    ["store_name", "spec_invalid_type"],
    ["store_url", "spec_invalid_type"],
  ]);
  assert.equal(nonString.not_in_spec.includes("store_name"), false);

  // An entry that is not an object plans as if every governed field were absent.
  for (const entry of [null, undefined, "string", ["array"]]) {
    const plan = planPageKitSync({ spec: SPEC, entry });
    assert.equal(plan.changes.length, 10, String(entry));
    assert.ok(plan.changes.every((row) => row.before === undefined), String(entry));
    assert.deepEqual(plan.unchanged, []);
  }

  // The alias pin is validated the same way as the canonical one.
  assert.equal(resolveSpecSdkPin({ runtime: { sdk_version: "latest" } }).status, "spec_invalid");
  assert.equal(resolveSpecSdkPin({ global_config: { sdk_version: "0.4.36" }, runtime: { sdk_version: "v0.4.36" } }).status, "spec_invalid");
});

test("applyPageKitSync refuses a campaigns.json root that is not an object keyed by slug", () => {
  const plan = { changes: [{ field: "store_url", before: undefined, after: "https://acmeglow.example" }] };
  for (const root of [null, "text", 7, [{ "acme-glow": {} }]]) {
    assert.throws(() => applyPageKitSync(root, "acme-glow", plan), /root must be an object keyed by public route slug/, String(root));
  }
  // A slug that resolves to a non-object entry is refused too, not coerced.
  assert.throws(() => applyPageKitSync({ "acme-glow": "string" }, "acme-glow", plan), /no object entry for "acme-glow"/);
  assert.throws(() => applyPageKitSync({ "acme-glow": ["array"] }, "acme-glow", plan), /no object entry for "acme-glow"/);
});

test("a target_invalid_type Store Profile blocker alone still routes to page-kit sync, and sync repairs it", () => {
  // The target holds a number where a string belongs: not demo residue, not
  // a mismatch, and not waivable, but the spec value is a string so writing
  // it over the target is exactly the repair.
  const entry = { ...SCAFFOLD_ENTRY, ...SPEC.campaign, store_name: 12345 };
  const targetLoad = { status: "ok", public_route_slug: "acme-glow", target_path: "_data/campaigns.json", entry };
  const gate = evaluatePageKitStoreProfile({ specCampaign: SPEC.campaign, targetLoad });
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.state.discrepancies.map((row) => [row.field, row.kind]), [["store_name", "target_invalid_type"]]);
  assert.equal(gate.waivable, false);
  const repair = gate.required_actions.find((action) => action.id === "repair_target");
  assert.equal(repair.kind, "command");
  assert.equal(repair.command, PAGE_KIT_SYNC_COMMAND);
  assert.match(repair.description, /\(store_name\)/);
  assert.deepEqual(gate.required_actions.map((action) => action.id), ["repair_target"]);

  const plan = planPageKitSync({ spec: SPEC, entry });
  assert.deepEqual(plan.changes.map((row) => [row.field, row.before, row.after]), [
    ["store_name", 12345, "Acme Glow"],
    ["sdk_version", "0.4.38", "0.4.36"],
  ]);
  const campaigns = { "acme-glow": entry };
  applyPageKitSync(campaigns, "acme-glow", plan);
  const repaired = evaluatePageKitStoreProfile({ specCampaign: SPEC.campaign, targetLoad: { ...targetLoad, entry: campaigns["acme-glow"] } });
  assert.equal(repaired.status, "pass");
});

test("page-kit sync reports an unparseable spec and a missing route slug as named errors, together, writing nothing", () => {
  const { dir, packetPath, specPath, campaignsPath } = fixture();
  try {
    const before = readFileSync(campaignsPath, "utf8");
    writeFileSync(specPath, "{ not json");
    const invalid = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, "blocked");
    assert.deepEqual(invalid.errors.map((issue) => issue.code), ["page_kit.sync.spec_invalid"]);
    assert.match(invalid.errors[0].message, /not valid JSON/);
    assert.equal(readFileSync(campaignsPath, "utf8"), before);

    // Every precondition failure is reported in one pass: the spec error and
    // the entry error both land, and the entry error names the missing slug.
    const packet = readJson(packetPath);
    delete packet.campaign.public_route_slug;
    writeJson(packetPath, packet);
    const noSlug = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(noSlug.ok, false);
    assert.ok(!noSlug.public_route_slug, "the slug normalizes to empty, so the entry cannot be named");
    assert.deepEqual(noSlug.errors.map((issue) => issue.code), [
      "page_kit.sync.route_slug_missing",
      "page_kit.sync.spec_invalid",
      "page_kit.sync.entry_missing",
    ]);
    assert.match(noSlug.errors[2].message, /has no entry for "<public-route-slug>"/);
    const text = pageKitSyncTextLines(noSlug);
    assert.equal(text[0], "Status: BLOCKED");
    assert.ok(text.some((line) => line === `Target: ${campaignsPath}[<public-route-slug>]`));
    assert.equal(text.filter((line) => line.startsWith("- [page_kit.sync.")).length, 3);
    // The error branch returns before the change/next lines.
    assert.equal(text.some((line) => line.startsWith("Changes")), false);
    assert.equal(text.some((line) => line.startsWith("Next:")), false);
    assert.equal(readFileSync(campaignsPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync names each malformed target state and omits the Target line when no target repo is set", () => {
  const { dir, packetPath, campaignsPath, slug } = fixture();
  try {
    const run = () => pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    const only = (result) => {
      assert.equal(result.ok, false);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].code, "page_kit.sync.entry_missing");
      return result.errors[0];
    };

    writeFileSync(campaignsPath, "{ nope");
    const invalidJson = only(run());
    assert.equal(invalidJson.detail.target_status, "invalid_json");
    assert.match(invalidJson.message, /is not valid JSON; repair the file/);
    assert.equal(readFileSync(campaignsPath, "utf8"), "{ nope", "a broken file is never rewritten");

    writeFileSync(campaignsPath, "[]\n");
    const rootNotObject = only(run());
    assert.equal(rootNotObject.detail.target_status, "root_not_object");
    assert.match(rootNotObject.message, /root must be an object keyed by public route slug/);

    writeJson(campaignsPath, { [slug]: "string", "other-route": { name: "Other" } });
    const entryNotObject = only(run());
    assert.equal(entryNotObject.detail.target_status, "entry_not_object");
    assert.match(entryNotObject.message, new RegExp(`\\["${slug}"\\] must be an object`));

    const packet = readJson(packetPath);
    packet.assembly.target_repo = "does-not-exist";
    writeJson(packetPath, packet);
    const repoMissing = only(run());
    assert.equal(repoMissing.detail.target_status, "target_repo_missing");
    assert.match(repoMissing.message, /Target repo does not exist: does-not-exist/);
    assert.equal(repoMissing.message.includes("not set"), false);

    delete packet.assembly.target_repo;
    writeJson(packetPath, packet);
    const repoUnset = run();
    assert.equal(repoUnset.target_repo, null);
    assert.equal(repoUnset.campaigns_path, null);
    assert.match(only(repoUnset).message, /\(assembly\.target_repo not set\)/);
    const text = pageKitSyncTextLines(repoUnset);
    assert.equal(text.some((line) => line.startsWith("Target:")), false, "no campaigns path, no Target line");
    assert.ok(text.some((line) => line.startsWith("Spec:")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync keeps the file's own indentation and does not add a trailing newline the file lacked", () => {
  const { dir, packetPath, campaignsPath, slug } = fixture();
  try {
    const campaigns = readJson(campaignsPath);
    // A hand-formatted file: four-space indent, no trailing newline.
    writeFileSync(campaignsPath, JSON.stringify(campaigns, null, 4));
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.status, "synced");
    const text = readFileSync(campaignsPath, "utf8");
    assert.equal(text.endsWith("\n"), false, "no trailing newline was invented");
    assert.match(text, /^\{\n {4}"/, "four-space indent survives");
    assert.equal(text.includes("\n  \""), false, "nothing was re-indented to two spaces");
    const expected = structuredClone(campaigns);
    Object.assign(expected[slug], {
      store_name: "Example Store",
      store_url: "https://store.example.com",
      store_terms: "https://store.example.com/terms",
      store_privacy: "https://store.example.com/privacy",
      store_contact: "https://store.example.com/contact",
      store_returns: "https://store.example.com/returns",
      store_shipping: "https://store.example.com/shipping",
      store_phone: "1-800-555-0100",
      store_phone_tel: "tel:+18005550100",
      sdk_version: "0.4.36",
    });
    assert.equal(text, JSON.stringify(expected, null, 4), "byte-identical to the same document re-serialized at the file's indent");

    // Tabs are an indent too.
    writeFileSync(campaignsPath, `${JSON.stringify(readJson(campaignsPath), null, "\t")}\n`);
    const spec = readJson(join(dir, "campaignspec.v42.basic.json"));
    spec.global_config.sdk_version = "0.4.35";
    writeJson(join(dir, "campaignspec.v42.basic.json"), spec);
    assert.equal(pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath }).status, "synced");
    const tabbed = readFileSync(campaignsPath, "utf8");
    assert.match(tabbed, /^\{\n\t"/);
    assert.ok(tabbed.endsWith("}\n"));
    assert.equal(readJson(campaignsPath)[slug].sdk_version, "0.4.35");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync stamps the retained doctor sidecar stale after a write, and leaves it alone on dry-run and unchanged", () => {
  const { dir, packetPath, targetRepo } = fixture();
  try {
    const sidecarPath = join(targetRepo, DOCTOR_SIDECAR_REL_PATH);
    const sidecar = { schema_version: "campaigns-os-doctor-output/v1", ok: false, status: "blocked", errors: [{ code: "page_kit.store_profile" }] };
    writeJson(sidecarPath, sidecar);

    pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath, "dry-run": true });
    assert.deepEqual(readJson(sidecarPath), sidecar, "a dry run changes no doctor input, so the snapshot stays as it was");

    const synced = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(synced.written, true);
    const stamped = readJson(sidecarPath);
    assert.equal(stamped.stale, true);
    assert.equal(stamped.stale_marked_by, "page-kit sync");
    assert.match(stamped.stale_marked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stamped.stale_reason, /page-kit sync rewrote _data\/campaigns\.json\[runtime-packet-demo\]/);
    assert.match(stamped.stale_reason, /campaigns-os doctor/);
    // The original fields survive the stamp.
    assert.equal(stamped.status, "blocked");
    assert.deepEqual(stamped.errors, sidecar.errors);

    writeJson(sidecarPath, sidecar);
    const again = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(again.status, "unchanged");
    assert.deepEqual(readJson(sidecarPath), sidecar, "nothing written, nothing to stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync text prints written changes with (absent) befores, the unchanged list, and the not-in-spec list", () => {
  assert.equal(formatSyncValue(undefined), "(absent)");
  assert.equal(formatSyncValue(""), "\"\"");
  assert.equal(formatSyncValue(null), "null");
  assert.equal(formatSyncValue("0.4.36"), "\"0.4.36\"");

  // The entry lacks store_returns, the spec does not carry store_shipping
  // (and the target holds a non-demo value for it), and store_phone already
  // matches: one row for each printer branch.
  const entry = { ...SCAFFOLD_ENTRY, store_phone: "1-800-555-0100", store_shipping: "https://store.example.com/shipping-legacy" };
  delete entry.store_returns;
  const { dir, packetPath, campaignsPath, slug } = fixture({
    entry,
    spec: (spec) => {
      delete spec.campaign.store_shipping;
    },
  });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.status, "synced");
    const lines = pageKitSyncTextLines(result);
    assert.equal(lines[0], "Status: SYNCED");
    assert.ok(lines.includes("Changes written: 8"), lines.join("\n"));
    assert.ok(lines.includes('- store_returns: (absent) -> "https://store.example.com/returns"  (from campaign.store_returns)'), lines.join("\n"));
    assert.ok(lines.includes("Unchanged: store_phone"), lines.join("\n"));
    assert.ok(lines.includes("Not in spec (left as they are): store_shipping"), lines.join("\n"));
    assert.equal(lines.some((line) => line.startsWith("Warnings:")), false);
    assert.equal(lines.at(-1), `Next: campaigns-os doctor --packet ${packetPath}`);

    // The field the spec does not carry keeps its (demo) target value; doctor
    // reports it as a target-only warning rather than a blocker.
    const after = readJson(campaignsPath)[slug];
    assert.equal(after.store_shipping, "https://store.example.com/shipping-legacy");
    assert.equal(after.store_returns, "https://store.example.com/returns");
    assert.deepEqual(Object.keys(after).at(-1), "store_returns", "the appended field lands at the end of the entry");
    const doctor = doctorPacket(packetPath);
    const profile = doctor.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.store_profile");
    assert.equal(profile.status, "pass");
    assert.deepEqual(profile.warning_fields, ["store_shipping"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo residue in a field the spec does not carry is reported as not synced, and the gate does not name sync for it", () => {
  // The one state sync cannot end: doctor blocks on demo residue without a
  // waiver, and there is no spec value to write over it. Sync must say so
  // rather than print a clean "left as it is", and the gate must send the
  // operator to the spec, not back to sync.
  const spec = { campaign: { ...SPEC.campaign }, global_config: { sdk_version: "0.4.36" } };
  delete spec.campaign.store_phone_tel;
  const plan = planPageKitSync({ spec, entry: SCAFFOLD_ENTRY });
  assert.equal(plan.changes.some((row) => row.field === "store_phone_tel"), false);
  assert.equal(plan.not_in_spec.includes("store_phone_tel"), false);
  assert.deepEqual(plan.not_synced.map((row) => [row.field, row.reason]), [["store_phone_tel", "demo_residue_not_in_spec"]]);
  assert.match(plan.not_synced[0].detail, /campaign\.store_phone_tel/);

  // A non-demo target value in an uncarried field is still simply left alone.
  const benign = planPageKitSync({ spec, entry: { ...SCAFFOLD_ENTRY, store_phone_tel: "tel:+15551234567" } });
  assert.deepEqual(benign.not_synced, []);
  assert.ok(benign.not_in_spec.includes("store_phone_tel"));

  const targetLoad = { status: "ok", public_route_slug: "acme-glow", target_path: "_data/campaigns.json", entry: SCAFFOLD_ENTRY };
  const gate = evaluatePageKitStoreProfile({ specCampaign: spec.campaign, targetLoad });
  assert.equal(gate.status, "blocked");
  const repair = gate.required_actions.find((action) => action.id === "repair_target");
  assert.equal(repair.kind, "edit");
  assert.equal(repair.command, null);
  assert.match(repair.description, /store_phone_tel/);

  // Once the spec carries the field, the same residue is sync-repairable again.
  const carried = evaluatePageKitStoreProfile({ specCampaign: SPEC.campaign, targetLoad });
  assert.equal(carried.required_actions.find((action) => action.id === "repair_target").command, PAGE_KIT_SYNC_COMMAND);
});

test("page-kit sync warns about demo residue the spec cannot replace and still writes the rest", () => {
  const { dir, packetPath, campaignsPath, slug } = fixture({ spec: (spec) => { delete spec.campaign.store_returns; } });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.ok, true);
    // Written, but doctor will still block: the status says so instead of SYNCED.
    assert.equal(result.status, "partial");
    assert.equal(result.written, true);
    assert.equal(result.changes.length, 9);
    assert.deepEqual(result.not_synced.map((row) => [row.field, row.reason]), [["store_returns", "demo_residue_not_in_spec"]]);
    assert.deepEqual(result.warnings.map((issue) => issue.code), ["page_kit.sync.store_returns_not_synced"]);
    assert.equal(readJson(campaignsPath)[slug].store_returns, "https://demo.29next.com/returns/");
    const text = pageKitSyncTextLines(result);
    assert.equal(text[0], "Status: PARTIAL");
    assert.ok(text.some((line) => /^Partial: store_returns could not be made spec-authoritative/.test(line)));
    assert.ok(text.some((line) => /store_returns was not written: .*campaign\.store_returns/.test(line)));
    assert.equal(text.some((line) => line.startsWith("Not in spec")), false);
    // Doctor still blocks on that one field, and sends the operator to the spec.
    const doctor = doctorPacket(packetPath);
    const gate = doctor.derived.checkpoint_gates.find((row) => row.id === "page_kit.store_profile");
    assert.equal(gate.status, "blocked");
    assert.deepEqual(gate.blocker_fields, ["store_returns"]);
    assert.equal(gate.required_actions.find((action) => action.id === "repair_target").kind, "edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a conflicting spec pin makes the run partial, not synced", () => {
  const { dir, packetPath } = fixture({ spec: (spec) => { spec.runtime = { sdk_version: "0.4.35" }; } });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.status, "partial");
    assert.equal(result.written, true);
    const cli = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--dry-run"], { encoding: "utf8" });
    assert.equal(cli.status, 0, "the write side succeeded; the spec defect is a warning, not an exit code");
    assert.match(cli.stdout, /^Status: PARTIAL\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync refuses a spec that identifies another campaign, and writes nothing", () => {
  const foreignSlug = fixture({ spec: (spec) => { spec.spec_identity.public_route_slug = "someone-elses-route"; } });
  try {
    const before = readFileSync(foreignSlug.campaignsPath, "utf8");
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: foreignSlug.packetPath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["page_kit.sync.spec_identity_mismatch"]);
    assert.match(result.errors[0].message, /"someone-elses-route".*"runtime-packet-demo"/);
    assert.equal(readFileSync(foreignSlug.campaignsPath, "utf8"), before);
    assert.equal(spawnSync("node", [CLI, "page-kit", "sync", "--packet", foreignSlug.packetPath], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(foreignSlug.dir, { recursive: true, force: true });
  }

  const foreignMap = fixture({ spec: (spec) => { spec.spec_identity.map_id = "another-map-zz99"; } });
  try {
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: foreignMap.packetPath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["page_kit.sync.spec_identity_mismatch"]);
    assert.match(result.errors[0].message, /spec_identity\.map_id "another-map-zz99"/);
  } finally {
    rmSync(foreignMap.dir, { recursive: true, force: true });
  }

  // A spec with no identity block at all is accepted: there is nothing to
  // contradict the packet, and doctor's own identity check still runs later.
  const anonymous = fixture({ spec: (spec) => { delete spec.spec_identity; } });
  try {
    assert.equal(pageKitSyncCommand({ _: ["page-kit", "sync"], packet: anonymous.packetPath }).ok, true);
  } finally {
    rmSync(anonymous.dir, { recursive: true, force: true });
  }
});

test("page-kit sync treats a non-object spec and an unreadable packet as structured errors", () => {
  const { dir, packetPath, specPath, campaignsPath } = fixture();
  try {
    const before = readFileSync(campaignsPath, "utf8");
    for (const body of ["null", "[]", "\"str\"", "42"]) {
      writeFileSync(specPath, body);
      const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
      assert.equal(result.ok, false, body);
      assert.deepEqual(result.errors.map((issue) => issue.code), ["page_kit.sync.spec_invalid"], body);
      assert.match(result.errors[0].message, /must be a JSON object/);
    }
    // A parser message quoting the file's own bytes is flattened to one line.
    writeFileSync(specPath, "{\u001b[31m\n\"x\": ");
    const bad = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(bad.errors[0].code, "page_kit.sync.spec_invalid");
    assert.doesNotMatch(bad.errors[0].message, /[\u0000-\u001f]/);
    assert.equal(readFileSync(campaignsPath, "utf8"), before);

    const missing = spawnSync("node", [CLI, "page-kit", "sync", "--packet", join(dir, "nope.json"), "--json"], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).errors[0].code, "page_kit.sync.packet_invalid");
    writeFileSync(packetPath, "[]");
    const array = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.deepEqual(array.errors.map((issue) => issue.code), ["page_kit.sync.packet_invalid"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync keeps CRLF line endings, reports a re-serialized file, and skips whitespace-only deltas", () => {
  const crlf = fixture();
  try {
    const original = readFileSync(crlf.campaignsPath, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(crlf.campaignsPath, original);
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: crlf.packetPath });
    assert.equal(result.status, "synced");
    assert.deepEqual(result.warnings, [], "a faithful round trip earns no reformat warning");
    const after = readFileSync(crlf.campaignsPath, "utf8");
    assert.ok(after.includes("\r\n"));
    assert.equal(after.includes("\n") && !after.includes("\r\n"), false);
    assert.equal(after.split("\r\n").length, original.split("\r\n").length);
    assert.equal(JSON.parse(after)[crlf.slug].store_url, "https://store.example.com");
  } finally {
    rmSync(crlf.dir, { recursive: true, force: true });
  }

  const minified = fixture();
  try {
    writeFileSync(minified.campaignsPath, JSON.stringify(readJson(minified.campaignsPath)));
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: minified.packetPath });
    assert.equal(result.status, "synced");
    assert.deepEqual(result.warnings.map((issue) => issue.code), ["page_kit.sync.file_reformatted"]);
    assert.match(result.warnings[0].message, /2-space indentation/);
    const text = pageKitSyncTextLines(result);
    assert.ok(text.some((line) => /file_reformatted/.test(line)));
  } finally {
    rmSync(minified.dir, { recursive: true, force: true });
  }

  const padded = fixture({ entry: { ...SCAFFOLD_ENTRY, store_name: "  Example Store \n" } });
  try {
    const dry = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: padded.packetPath, "dry-run": true });
    // The gate normalizes before comparing, so the padded name already passes;
    // reporting it as a change would describe a diff doctor never saw.
    assert.equal(dry.changes.some((row) => row.field === "store_name"), false);
    assert.ok(dry.unchanged.some((row) => row.field === "store_name"));
  } finally {
    rmSync(padded.dir, { recursive: true, force: true });
  }
});

test("planPageKitSync refuses spec values a template would put into an href unescaped, and the demo value itself", () => {
  const spec = {
    campaign: {
      ...SPEC.campaign,
      store_terms: "javascript:alert(1)",
      store_privacy: "ftp://acmeglow.example/privacy",
      store_contact: "not a url",
      store_phone_tel: "tel:1;evil",
      store_returns: "https://demo.29next.com/returns/",
      store_name: "Acme\u0007Glow",
    },
    global_config: { sdk_version: "0.4.36" },
  };
  const plan = planPageKitSync({ spec, entry: SCAFFOLD_ENTRY });
  assert.deepEqual(plan.changes.map((row) => row.field), ["store_url", "store_shipping", "store_phone", "sdk_version"]);
  assert.deepEqual(Object.fromEntries(plan.not_synced.map((row) => [row.field, row.reason])), {
    store_terms: "not_http_url",
    store_privacy: "not_http_url",
    store_contact: "not_http_url",
    store_phone_tel: "not_tel_uri",
    store_returns: "demo_residue",
    store_name: "control_characters",
  });
  for (const row of plan.not_synced) assert.match(row.detail, new RegExp(`campaign\\.${row.field}`));

  // The gate sends the operator to the spec for every one of those, not to sync.
  const targetLoad = { status: "ok", public_route_slug: "acme-glow", target_path: "_data/campaigns.json", entry: SCAFFOLD_ENTRY };
  const gate = evaluatePageKitStoreProfile({ specCampaign: spec.campaign, targetLoad });
  assert.equal(gate.status, "blocked");
  const repair = gate.required_actions.find((action) => action.id === "repair_target");
  assert.equal(repair.kind, "edit");
  for (const field of ["store_terms (not_http_url)", "store_phone_tel (not_tel_uri)", "store_returns (demo_residue)", "store_name (control_characters)"]) {
    assert.ok(repair.description.includes(field), repair.description);
  }
  // A target whose invalid-type field has no spec value is not sync-repairable either.
  const typed = evaluatePageKitStoreProfile({
    specCampaign: { store_url: "https://acmeglow.example" },
    targetLoad: { ...targetLoad, entry: { ...NON_DEMO_ENTRY, store_url: "https://acmeglow.example", store_phone: 123 } },
  });
  assert.equal(typed.status, "blocked");
  assert.equal(typed.required_actions.find((action) => action.id === "repair_target").kind, "edit");
});

test("page-kit sync rejects --dry-run with a value instead of writing", () => {
  const { dir, packetPath, campaignsPath } = fixture();
  try {
    const before = readFileSync(campaignsPath, "utf8");
    for (const argv of [["--dry-run", "true"], ["--dry-run", "yes"]]) {
      const run = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, ...argv], { encoding: "utf8" });
      assert.notEqual(run.status, 0, argv.join(" "));
      assert.match(run.stderr, /--dry-run takes no value/);
    }
    assert.equal(readFileSync(campaignsPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync refuses to write through a symlink that leaves the target repo, and follows one that stays inside", () => {
  const { dir, packetPath, targetRepo, campaignsPath } = fixture();
  try {
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    const outsideFile = join(outside, "campaigns.json");
    const original = readFileSync(campaignsPath, "utf8");
    writeFileSync(outsideFile, original);
    rmSync(campaignsPath);
    symlinkSync(outsideFile, campaignsPath);
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((issue) => issue.code), ["page_kit.sync.target_escapes_repo"]);
    assert.equal(readFileSync(outsideFile, "utf8"), original);
    assert.ok(lstatSync(campaignsPath).isSymbolicLink(), "the link itself is untouched");

    // A link that resolves inside the repo is followed: the destination file
    // is rewritten and the link stays a link.
    rmSync(campaignsPath);
    const insideFile = join(targetRepo, "config", "campaigns.json");
    mkdirSync(dirname(insideFile), { recursive: true });
    writeFileSync(insideFile, original);
    symlinkSync(insideFile, campaignsPath);
    const ok = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(ok.status, "synced");
    assert.equal(ok.campaigns_path, realpathSync(insideFile));
    assert.ok(lstatSync(campaignsPath).isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(insideFile, "utf8"))["runtime-packet-demo"].store_url, "https://store.example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync keeps the file's permission bits", () => {
  const { dir, packetPath, campaignsPath } = fixture();
  try {
    chmodSync(campaignsPath, 0o600);
    pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(statSync(campaignsPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Printed commands are spelled for the install they come from. From a
// consumer install, doctor's Required actions and next's next_actions carry
// `npx campaigns-os page-kit sync …`; the checkout keeps the bare form.
test("doctor and next spell the page-kit sync repair with the consumer install's npx prefix", () => {
  const installRoot = realpathSync(mkdtempSync(join(tmpdir(), "campaigns-os-pkg-sync-")));
  const { dir, packetPath } = fixture();
  try {
    const pkgCli = join(stageRealPackageInstall(installRoot), "bin", "campaigns-os.mjs");
    const env = { ...process.env, PATH: "/usr/bin:/bin" };
    const doctor = spawnSync(process.execPath, [pkgCli, "doctor", "--packet", packetPath], { cwd: installRoot, encoding: "utf8", env });
    assert.equal(doctor.status, 2, doctor.stderr);
    assert.match(doctor.stdout, /^- \[page_kit\.store_profile\] npx campaigns-os page-kit sync --packet /m);
    assert.match(doctor.stdout, /^- \[page_kit\.sdk_version\] npx campaigns-os page-kit sync --packet /m);
    assert.doesNotMatch(doctor.stdout, /(?<!npx )campaigns-os page-kit sync/);

    const next = spawnSync(process.execPath, [pkgCli, "next", "--packet", packetPath, "--json", "--no-write"], { cwd: installRoot, encoding: "utf8", env });
    const parsed = JSON.parse(next.stdout);
    assert.equal(parsed.stage, "doctor-blocked");
    for (const id of ["checkpoint.page_kit.store_profile.repair_target", "checkpoint.page_kit.sdk_version.repair_target"]) {
      const action = parsed.next_actions.find((row) => row.id === id);
      assert.ok(action, id);
      assert.equal(action.command, `npx campaigns-os page-kit sync --packet ${packetPath}`);
    }
    assert.doesNotMatch(JSON.stringify(parsed.next_actions), /(?<!npx )campaigns-os (?:page-kit|checkpoint|doctor) /);

    // The same doctor from the checkout keeps the bare, tested form.
    const checkout = spawnSync("node", [CLI, "doctor", "--packet", packetPath], { encoding: "utf8" });
    assert.match(checkout.stdout, /^- \[page_kit\.store_profile\] campaigns-os page-kit sync --packet /m);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync leaves a field alone while a named-human waiver covers its gate, and says who waived it", () => {
  const { dir, packetPath, campaignsPath, slug, targetRepo } = fixture();
  try {
    // Only the pin differs, so the sdk gate is a waivable exact mismatch.
    const campaigns = readJson(campaignsPath);
    campaigns[slug] = { ...campaigns[slug], ...Object.fromEntries(Object.entries(SPEC_TARGET_MATCH)) };
    writeJson(campaignsPath, campaigns);
    mkdirSync(join(targetRepo, ".campaign-runtime"), { recursive: true });
    const recorded = checkpointWaive({
      _: ["checkpoint", "waive"],
      packet: packetPath,
      gate: "page_kit.sdk_version",
      reason: "Intentional pin for compatibility testing",
      "waived-by": "Jordan Lee",
      "review-condition": "Re-evaluate before production launch",
    });
    assert.equal(recorded.gate, "page_kit.sdk_version");

    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.status, "partial");
    assert.equal(result.written, false, "nothing else needed writing");
    assert.deepEqual(result.not_synced.map((row) => [row.field, row.reason]), [["sdk_version", "waived"]]);
    assert.match(result.not_synced[0].detail, /Jordan Lee/);
    assert.equal(readJson(campaignsPath)[slug].sdk_version, "0.4.38", "the waived pin is exactly as the human accepted it");
    assert.ok(result.report_path.endsWith("assembly-report.json"));

    // Doctor still reads the waiver as active: sync did not disturb it.
    const doctor = doctorPacket(packetPath);
    assert.equal(doctor.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version").status, "waived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync warns that a terminal build is now stale and points at the rebuild", () => {
  const { dir, packetPath, targetRepo } = fixture();
  try {
    const reportPath = join(targetRepo, ".campaign-runtime/assembly-report.json");
    const report = readJson(reportPath);
    report.stages.assembly.status = "completed";
    writeJson(reportPath, report);
    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath });
    assert.equal(result.status, "synced");
    assert.deepEqual(result.warnings.map((issue) => issue.code), ["page_kit.sync.build_stale"]);
    assert.match(result.next, /then rebuild/);
    const dry = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath, "dry-run": true });
    assert.equal(dry.status, "unchanged");
    assert.deepEqual(dry.warnings, [], "a run that wrote nothing staled nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page-kit sync rejects unknown flags and accepts --report, and allows mailto: for store_contact only", () => {
  const { dir, packetPath, campaignsPath } = fixture({ spec: (spec) => {
    spec.campaign.store_contact = "mailto:support@store.example.com";
    spec.campaign.store_returns = "mailto:returns@store.example.com";
  } });
  try {
    const before = readFileSync(campaignsPath, "utf8");
    const typo = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--dryrun"], { encoding: "utf8" });
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /Unknown flag for page-kit sync: --dryrun\./);
    assert.match(typo.stderr, /Known flags: --packet, --dry-run, --json, --report/);
    const equals = spawnSync("node", [CLI, "page-kit", "sync", "--packet", packetPath, "--dry-run=true"], { encoding: "utf8" });
    assert.match(equals.stderr, /not --flag=value/);
    assert.equal(readFileSync(campaignsPath, "utf8"), before);

    const result = pageKitSyncCommand({ _: ["page-kit", "sync"], packet: packetPath, report: join(dir, "target-page-kit/.campaign-runtime/assembly-report.json") });
    assert.ok(result.changes.some((row) => row.field === "store_contact" && row.after === "mailto:support@store.example.com"));
    assert.deepEqual(result.not_synced.map((row) => [row.field, row.reason]), [["store_returns", "not_http_url"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate's edit action separates target-side defects from spec-side ones", () => {
  const targetLoad = {
    status: "ok",
    public_route_slug: "acme-glow",
    target_path: "_data/campaigns.json",
    entry: { ...NON_DEMO_ENTRY, store_phone: 123, store_returns: "https://demo.29next.com/returns/" },
  };
  // The spec carries neither field: both are target-side repairs.
  const gate = evaluatePageKitStoreProfile({ specCampaign: { store_url: NON_DEMO_ENTRY.store_url }, targetLoad });
  assert.equal(gate.status, "blocked");
  const repair = gate.required_actions.find((action) => action.id === "repair_target");
  assert.equal(repair.kind, "edit");
  assert.match(repair.description, /^Remove or correct _data\/campaigns\.json\[acme-glow\]\.store_returns, store_phone/);
  assert.match(repair.description, /or add campaign\.store_returns, campaign\.store_phone to the spec and run page-kit sync/);
  assert.doesNotMatch(repair.description, /Repair the CampaignSpec/);
  // Mixed: one target-side, one spec-side, both named on their own side.
  const mixed = evaluatePageKitStoreProfile({ specCampaign: { store_url: NON_DEMO_ENTRY.store_url, store_returns: "javascript:x" }, targetLoad });
  const mixedRepair = mixed.required_actions.find((action) => action.id === "repair_target");
  assert.match(mixedRepair.description, /Remove or correct .*\.store_phone/);
  assert.match(mixedRepair.description, /Repair the CampaignSpec Store Profile field\(s\) store_returns \(not_http_url\)/);
});
