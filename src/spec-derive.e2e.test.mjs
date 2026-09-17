// End-to-end: a REAL `npx campaign-init` scaffold (network: npm registry and
// the starter-template download), prepare-build, `page-kit sync` (seeds the
// scaffold from the spec), then a bump lane: the repo pin moves and a GTM id
// lands in _data/campaigns.json, doctor reports the pin as `repo_newer`
// (advisory, #413), `spec derive` writes both into the spec, doctor passes
// the pin gate exactly. Opt in with CAMPAIGNS_OS_E2E_SCAFFOLD=1; the hermetic
// equivalent in spec-derive.test.mjs replays the same states.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function sdkGate(doctorJson) {
  return doctorJson.derived.checkpoint_gates.find((gate) => gate.id === "page_kit.sdk_version");
}

test("spec derive writes a bumped repo pin and the repo's GTM id into the spec on a real campaign-init scaffold", { skip: ENABLED ? false : "set CAMPAIGNS_OS_E2E_SCAFFOLD=1 (needs the network)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-derive-e2e-"));
  try {
    const slug = "acme-glow";
    const campaign = join(dir, slug);
    mkdirSync(campaign);
    execFileSync("npm", ["init", "-y"], { cwd: campaign, stdio: "ignore" });
    execFileSync("npm", ["i", "next-campaign-page-kit"], { cwd: campaign, stdio: "ignore" });
    execFileSync("npx", ["campaign-init", "--non-interactive", "--template", "olympus", "--slug", slug, "--name", "Acme Glow"], { cwd: campaign, stdio: "ignore" });

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
    const specPath = join(dir, "campaignspec.json");
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    cpSync(join(ROOT, "examples/source-html"), join(dir, "source"), { recursive: true });

    run(["prepare-build", "--spec", "../campaignspec.json", "--source", "../source", "--target", ".", "--template-family", "olympus", "--no-run-session"], campaign);
    const packet = join(campaign, "campaign-runtime.build.json");

    // A scaffold's pin is the starter's seed: derive refuses it and says so.
    const seeded = run(["spec", "derive", "--packet", packet, "--dry-run", "--json"], campaign).stdout;
    assert.ok(JSON.parse(seeded).not_derived.some((row) => row.reason === "scaffold_seed"), seeded);

    // page-kit sync seeds the scaffold from the spec (the #412 lane).
    const sync = run(["page-kit", "sync", "--packet", packet], campaign);
    assert.match(sync.stdout, /^Status: SYNCED\n/);
    assert.match(sync.stdout, /- sdk_version: "0\.4\.38" -> "0\.4\.36"/);

    // The bump lane: the repo pin moves first and an id lands in the repo.
    const campaignsPath = join(campaign, "_data/campaigns.json");
    const campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
    campaigns[slug].sdk_version = "0.4.38";
    campaigns[slug].gtm_id = "GTM-E2E0001";
    writeFileSync(campaignsPath, `${JSON.stringify(campaigns, null, 2)}\n`);
    const before = JSON.parse(run(["doctor", "--packet", packet, "--json"], campaign, { allowFailure: true }).stdout);
    assert.equal(sdkGate(before).code, "page_kit.sdk_version.repo_newer");
    assert.equal(sdkGate(before).advisory_actions[0].command, "campaigns-os spec derive --packet <packet>");

    const derive = run(["spec", "derive", "--packet", packet], campaign);
    assert.equal(derive.status, 0);
    assert.match(derive.stdout, /^Status: (DERIVED|PARTIAL)\n/);
    assert.match(derive.stdout, /- global_config\.sdk_version: "0\.4\.36" -> "0\.4\.38"  \(from _data\/campaigns\.json\[acme-glow\]\.sdk_version\)/);
    assert.match(derive.stdout, /- analytics\.providers\.gtm\.containerId: \(absent\) -> "GTM-E2E0001"/);

    const written = JSON.parse(readFileSync(specPath, "utf8"));
    assert.equal(written.global_config.sdk_version, "0.4.38");
    assert.deepEqual(written.analytics, { providers: { gtm: { enabled: true, containerId: "GTM-E2E0001" } } });
    assert.equal(written.campaign.store_url, "https://acmeglow.example", "authored/store fields untouched");
    assert.deepEqual(written.offers, spec.offers);

    const after = JSON.parse(run(["doctor", "--packet", packet, "--json"], campaign, { allowFailure: true }).stdout);
    assert.equal(sdkGate(after).code, "page_kit.sdk_version.pass");

    // The starter's page tree carries the family's pages, not the spec's:
    // every spec page it does state binds, the rest are reported by name.
    const tree = readdirSync(join(campaign, "src", slug)).filter((name) => name.endsWith(".html"));
    const result = JSON.parse(run(["spec", "derive", "--packet", packet, "--json"], campaign).stdout);
    for (const row of result.not_derived) assert.equal(row.reason, "page_file_not_found", JSON.stringify(row));
    for (const row of result.unchanged.filter((entry) => entry.page_id)) assert.ok(tree.includes(row.source), row.source);
    // eslint-disable-next-line no-console
    console.log(`${derive.stdout}\npage tree: ${tree.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
