import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { specDeriveCommand } from "./cli.mjs";
import { doctorPacket } from "./doctor/inspect.mjs";
import { evaluatePageKitAnalyticsVendors, PAGE_KIT_ANALYTICS_VENDORS_SCOPE } from "./page-kit-analytics-vendors.mjs";

const SLUG = "acme";
const load = (entry) => ({ status: "ok", public_route_slug: SLUG, target_path: "_data/campaigns.json", entry });
const codes = (result) => result.findings.map((finding) => [finding.code.replace(`${PAGE_KIT_ANALYTICS_VENDORS_SCOPE}.`, ""), finding.vendor]);

test("a declared vendor with no, an empty or a placeholder key, and a key the spec does not declare, are advisories", () => {
  const spec = {
    analytics: {
      vendors: {
        ga4: { enabled: true, id: "G-AB12CD34EF" },
        tiktok: { enabled: true, id: "CABCDEFGHIJ1234567890" },
        northbeam: { enabled: true, id: "nb-1" },
        triplewhale: { enabled: true, id: "acme.myshopify.com" },
        snap: { enabled: true, id: "snap-1" },
      },
    },
  };
  const result = evaluatePageKitAnalyticsVendors({
    spec,
    targetLoad: load({
      ga4_id: "G-AB12CD34EF",
      tiktok_pixel_id: "  ",
      triplewhale_name: "store.example.com",
      snap_pixel_id: "snap-2",
      pinterest_tag_id: "2612345678901",
    }),
  });
  assert.equal(result.status, "advisory");
  assert.deepEqual(result.vendors, ["ga4", "triplewhale", "tiktok", "northbeam", "snap", "pinterest"]);
  assert.deepEqual(codes(result), [
    ["key_placeholder", "triplewhale"],
    ["key_missing", "tiktok"],
    ["key_missing", "northbeam"],
    ["id_mismatch", "snap"],
    ["undeclared", "pinterest"],
  ]);
  const byVendor = Object.fromEntries(result.findings.map((finding) => [finding.vendor, finding]));
  assert.match(byVendor.tiktok.message, /declares analytics\.vendors\.tiktok, but _data\/campaigns\.json\[acme\]\.tiktok_pixel_id is absent or empty, so the template never loads TikTok/);
  assert.match(byVendor.pinterest.message, /pinterest_tag_id switches Pinterest on, but the CampaignSpec does not declare analytics\.vendors\.pinterest/);
  assert.deepEqual(byVendor.pinterest.repair, { kind: "command", command: "campaigns-os spec derive --packet <packet>" });
  assert.deepEqual(byVendor.tiktok.repair, { kind: "edit", target: "_data/campaigns.json[acme].tiktok_pixel_id" });
  // Findings name keys and vendors, never a value read from campaigns.json.
  for (const finding of result.findings) {
    assert.doesNotMatch(finding.message, /store\.example\.com|snap-2|2612345678901/);
  }
});

test("an authored off is reported against the Map, not spec derive, and a matching entry is clean", () => {
  const off = evaluatePageKitAnalyticsVendors({
    spec: { analytics: { vendors: { axon: { enabled: false, id: "axon-key" } } } },
    targetLoad: load({ axon_event_key: "axon-key" }),
  });
  assert.deepEqual(codes(off), [["undeclared", "axon"]]);
  assert.match(off.findings[0].message, /turns analytics\.vendors\.axon off \(enabled: false\)/);
  assert.equal(off.findings[0].repair.kind, "edit");

  const disabled = evaluatePageKitAnalyticsVendors({
    spec: { analytics: { mode: "disabled", vendors: { ga4: { enabled: true, id: "G-AB12CD34EF" } } } },
    targetLoad: load({ ga4_id: "G-AB12CD34EF", taboola_account_id: 1234567 }),
  });
  assert.deepEqual(codes(disabled), [["undeclared", "ga4"], ["undeclared", "taboola"]], "a numeric key switches the vendor on too");
  assert.match(disabled.findings[0].message, /turns analytics off/);

  const clean = evaluatePageKitAnalyticsVendors({
    spec: { analytics: { vendors: { ga4: { enabled: true, id: "G-AB12CD34EF" } } } },
    targetLoad: load({ ga4_id: " G-AB12CD34EF ", tiktok_pixel_id: "", gtm_id: "GTM-ABC1234" }),
  });
  assert.equal(clean.status, "ok");
  assert.deepEqual(clean.vendors, ["ga4"]);
  assert.deepEqual(clean.findings, []);
});

test("nothing is compared without a readable spec or target entry", () => {
  for (const [spec, targetLoad] of [
    [null, load({ ga4_id: "G-AB12CD34EF" })],
    [{}, { status: "entry_missing", public_route_slug: SLUG, entry: null }],
    [{}, { status: "file_missing", public_route_slug: SLUG, entry: null }],
  ]) {
    const result = evaluatePageKitAnalyticsVendors({ spec, targetLoad });
    assert.equal(result.status, "not_applicable");
    assert.deepEqual(result.findings, []);
  }
  const empty = evaluatePageKitAnalyticsVendors({ spec: {}, targetLoad: load({ name: "Acme" }) });
  assert.equal(empty.status, "ok");
  assert.deepEqual(empty.vendors, []);
});

const EXAMPLES = new URL("../examples/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("doctor reports the vendor advisories as warnings, and spec derive clears the undeclared one", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-analytics-vendors-"));
  try {
    for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) cpSync(new URL(file, EXAMPLES), join(dir, file));
    cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
    cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
    const packetPath = join(dir, "build-packet.basic.json");
    const slug = readJson(packetPath).campaign.public_route_slug;
    const specPath = join(dir, "campaignspec.v42.basic.json");
    const spec = readJson(specPath);
    spec.analytics = { vendors: { tiktok: { enabled: true, id: "CABCDEFGHIJ1234567890" } } };
    writeJson(specPath, spec);
    const campaignsPath = join(dir, "target-page-kit/_data/campaigns.json");
    const campaigns = readJson(campaignsPath);
    campaigns[slug] = { ...campaigns[slug], ga4_id: "G-AB12CD34EF" };
    writeJson(campaignsPath, campaigns);

    const vendorWarnings = (doctor) => doctor.warnings
      .filter((issue) => issue.code.startsWith(`${PAGE_KIT_ANALYTICS_VENDORS_SCOPE}.`))
      .map((issue) => [issue.code, issue.detail.vendor]);
    const before = doctorPacket(packetPath);
    assert.ok(before.derived.doctor_checks.includes(PAGE_KIT_ANALYTICS_VENDORS_SCOPE));
    assert.deepEqual(vendorWarnings(before), [
      ["page_kit.analytics_vendors.undeclared", "ga4"],
      ["page_kit.analytics_vendors.key_missing", "tiktok"],
    ]);
    assert.equal(before.errors.some((issue) => issue.code.startsWith(PAGE_KIT_ANALYTICS_VENDORS_SCOPE)), false, "advisory only");
    assert.equal(readJson(campaignsPath)[slug].ga4_id, "G-AB12CD34EF", "doctor writes nothing");

    specDeriveCommand({ _: ["spec", "derive"], packet: packetPath });
    assert.deepEqual(vendorWarnings(doctorPacket(packetPath)), [["page_kit.analytics_vendors.key_missing", "tiktok"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
