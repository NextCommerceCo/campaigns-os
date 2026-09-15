// End-to-end: a REAL `npx campaign-init` scaffold (network: npm registry and
// the starter-template download), then prepare-build, doctor (blocked on the
// two page-kit gates), `page-kit sync`, doctor (both gates pass). Opt in with
// CAMPAIGNS_OS_E2E_SCAFFOLD=1; the hermetic equivalent in
// page-kit-sync.test.mjs replays what campaign-init seeded on 2026-09-15.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const ENABLED = process.env.CAMPAIGNS_OS_E2E_SCAFFOLD === "1";

function run(args, cwd, { allowFailure = false } = {}) {
  try {
    return { status: 0, stdout: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } }) };
  } catch (error) {
    if (!allowFailure) throw error;
    return { status: error.status, stdout: error.stdout ?? "" };
  }
}

function pageKitGates(doctorJson) {
  return Object.fromEntries(
    doctorJson.derived.checkpoint_gates
      .filter((gate) => gate.id.startsWith("page_kit."))
      .map((gate) => [gate.id, gate.status]),
  );
}

test("page-kit sync clears the two page-kit gates on a real campaign-init scaffold", { skip: ENABLED ? false : "set CAMPAIGNS_OS_E2E_SCAFFOLD=1 (needs the network)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "page-kit-sync-e2e-"));
  try {
    const slug = "acme-glow";
    const campaign = join(dir, slug);
    mkdirSync(campaign);
    execFileSync("npm", ["init", "-y"], { cwd: campaign, stdio: "ignore" });
    execFileSync("npm", ["i", "next-campaign-page-kit"], { cwd: campaign, stdio: "ignore" });
    execFileSync("npx", ["campaign-init", "--non-interactive", "--template", "olympus", "--slug", slug, "--name", "Acme Glow"], { cwd: campaign, stdio: "ignore" });

    const seeded = JSON.parse(readFileSync(join(campaign, "_data/campaigns.json"), "utf8"))[slug];
    assert.equal(seeded.store_url, "https://demo.29next.com/", "campaign-init still seeds the demo store profile");

    const spec = JSON.parse(readFileSync(join(ROOT, "examples/campaignspec.v42.basic.json"), "utf8"));
    spec.campaign.slug = slug;
    spec.campaign.name = "Acme Glow";
    spec.spec_identity.public_route_slug = slug;
    spec.spec_identity.map_id = `${slug}-e2e`;
    spec.campaign.store_name = "Acme Glow";
    spec.campaign.store_url = "https://acmeglow.example";
    for (const key of ["terms", "privacy", "contact", "returns", "shipping"]) spec.campaign[`store_${key}`] = `https://acmeglow.example/${key}`;
    spec.campaign.store_phone = "1-800-555-0199";
    spec.campaign.store_phone_tel = "tel:+18005550199";
    spec.global_config.sdk_version = "0.4.36";
    writeFileSync(join(dir, "campaignspec.json"), `${JSON.stringify(spec, null, 2)}\n`);
    cpSync(join(ROOT, "examples/source-html"), join(dir, "source"), { recursive: true });

    run(["prepare-build", "--spec", "../campaignspec.json", "--source", "../source", "--target", ".", "--template-family", "olympus", "--no-run-session"], campaign);
    const packet = join(campaign, "campaign-runtime.build.json");

    const before = JSON.parse(run(["doctor", "--packet", packet, "--json"], campaign, { allowFailure: true }).stdout);
    assert.deepEqual(pageKitGates(before), { "page_kit.sdk_version": "blocked", "page_kit.store_profile": "blocked" });
    const text = run(["doctor", "--packet", packet], campaign, { allowFailure: true }).stdout;
    assert.match(text, /- \[page_kit\.store_profile\] campaigns-os page-kit sync --packet /);
    assert.match(text, /- \[page_kit\.sdk_version\] campaigns-os page-kit sync --packet /);

    const sync = run(["page-kit", "sync", "--packet", packet], campaign);
    assert.equal(sync.status, 0);
    assert.match(sync.stdout, /^Status: SYNCED\n/);
    assert.match(sync.stdout, /Changes written: 10\n/);
    assert.match(sync.stdout, /- store_url: "https:\/\/demo\.29next\.com\/" -> "https:\/\/acmeglow\.example"/);
    assert.match(sync.stdout, /- sdk_version: "0\.4\.38" -> "0\.4\.36"/);

    const after = JSON.parse(run(["doctor", "--packet", packet, "--json"], campaign, { allowFailure: true }).stdout);
    assert.deepEqual(pageKitGates(after), { "page_kit.sdk_version": "pass", "page_kit.store_profile": "pass" });
    assert.equal(after.errors.some((issue) => issue.code.startsWith("page_kit.")), false);

    const entry = JSON.parse(readFileSync(join(campaign, "_data/campaigns.json"), "utf8"))[slug];
    assert.equal(entry.description, seeded.description, "non-governed keys untouched");
    assert.equal(entry.entry_url, seeded.entry_url);
    assert.deepEqual(Object.keys(entry), Object.keys(seeded));
    // eslint-disable-next-line no-console
    console.log(sync.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
