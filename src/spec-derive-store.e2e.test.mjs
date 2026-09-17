// End-to-end: `spec derive --from-store` against a REAL store's Admin API
// (network, credential). Opt in with CAMPAIGNS_OS_E2E_STORE=<subdomain> and
// the store's read token in <SUBDOMAIN>_ADMIN_TOKEN (the command's own
// default); the hermetic equivalent in spec-derive-store.test.mjs replays
// the same states against a fake Admin API. The run is a dry run then a
// write on a temp copy of the example campaign; the store is only read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { defaultStoreTokenEnvVar, normalizeStoreSubdomain, SPEC_DERIVE_STORE_FIELDS } from "./spec-derive-store.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");
const EXAMPLES = new URL("../examples/", import.meta.url);
const SUBDOMAIN = normalizeStoreSubdomain(process.env.CAMPAIGNS_OS_E2E_STORE || "");
const TOKEN_ENV = SUBDOMAIN ? defaultStoreTokenEnvVar(SUBDOMAIN) : null;
const ENABLED = Boolean(SUBDOMAIN && process.env[TOKEN_ENV]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(args, { allowFailure = false } = {}) {
  try {
    return { status: 0, stdout: execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: "off" } }) };
  } catch (error) {
    if (!allowFailure) throw error;
    return { status: error.status, stdout: error.stdout ?? "" };
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spec-derive-store-e2e-"));
  for (const file of ["build-packet.basic.json", "campaignspec.v42.basic.json"]) cpSync(new URL(file, EXAMPLES), join(dir, file));
  cpSync(new URL("source-html", EXAMPLES), join(dir, "source-html"), { recursive: true });
  cpSync(new URL("target-page-kit", EXAMPLES), join(dir, "target-page-kit"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  cpSync(new URL("../contracts/commerce-surface-catalog.json", import.meta.url), join(dir, "contracts/commerce-surface-catalog.json"));
  const packetPath = join(dir, "build-packet.basic.json");
  const packet = readJson(packetPath);
  packet.assembly.commerce_catalog.path = "contracts/commerce-surface-catalog.json";
  packet.assembly.commerce_catalog.required = false;
  writeJson(packetPath, packet);
  const specPath = join(dir, "campaignspec.v42.basic.json");
  const spec = readJson(specPath);
  const slug = packet.campaign.public_route_slug;
  const targetRepo = join(dir, "target-page-kit");
  const campaignsPath = join(targetRepo, "_data/campaigns.json");
  const campaigns = readJson(campaignsPath);
  campaigns[slug] = { name: "Runtime Packet Demo", entry_url: "landing", sdk_version: spec.global_config.sdk_version, ...spec.campaign, gtm_id: "", fb_pixel_id: "" };
  writeJson(campaignsPath, campaigns);
  const pageTree = join(targetRepo, "src", slug);
  mkdirSync(pageTree, { recursive: true });
  for (const name of ["landing", "checkout", "upsell", "receipt"]) writeFileSync(join(pageTree, `${name}.html`), `---\npage_layout: base.html\n---\n<h1>${name}</h1>\n`);
  return { dir, packetPath, specPath };
}

test("spec derive --from-store reads a real store and writes what it states into the spec", { skip: ENABLED ? false : "set CAMPAIGNS_OS_E2E_STORE=<subdomain> and <SUBDOMAIN>_ADMIN_TOKEN (needs the network and a store read token)" }, () => {
  const { dir, packetPath, specPath } = fixture();
  try {
    const before = readFileSync(specPath, "utf8");
    const dry = JSON.parse(run(["spec", "derive", "--packet", packetPath, "--from-store", SUBDOMAIN, "--dry-run", "--json"]).stdout);
    assert.equal(dry.ok, true, JSON.stringify(dry.errors));
    assert.equal(dry.store.store_read, "ok");
    assert.equal(dry.store.token_source, `env:${TOKEN_ENV}`);
    const token = process.env[TOKEN_ENV].trim();
    assert.equal(JSON.stringify(dry).includes(token), false, "the token never appears in the result");
    assert.equal(readFileSync(specPath, "utf8"), before, "a dry run writes nothing");
    // The example spec names another host, so at least the store name moves
    // and every store field is either planned or explained.
    const touched = new Set([...dry.changes, ...dry.unchanged, ...dry.not_derived].map((row) => row.field));
    for (const field of SPEC_DERIVE_STORE_FIELDS) assert.ok(touched.has(field), `${field} is accounted for`);
    assert.ok(dry.changes.some((row) => row.field === "campaign.store_name"), "the store's name replaces the example's");

    const written = JSON.parse(run(["spec", "derive", "--packet", packetPath, "--from-store", SUBDOMAIN, "--json"]).stdout);
    assert.equal(written.written, true);
    assert.deepEqual(written.changes.map((row) => [row.field, row.after]), dry.changes.map((row) => [row.field, row.after]), "dry run and write agree");
    const spec = readJson(specPath);
    for (const row of written.changes.filter((change) => change.field.startsWith("campaign.store_"))) {
      assert.equal(spec.campaign[row.field.slice("campaign.".length)], row.after);
    }
    const again = JSON.parse(run(["spec", "derive", "--packet", packetPath, "--from-store", SUBDOMAIN, "--json"]).stdout);
    assert.equal(again.changes.length, 0, "a second run is a no-op");

    // The wrong subdomain is a refusal, not a partial write.
    const wrong = run(["spec", "derive", "--packet", packetPath, "--from-store", `${SUBDOMAIN}-no-such-store-x`, "--store-token-source", `env:${TOKEN_ENV}`, "--json"], { allowFailure: true });
    assert.equal(wrong.status, 2);
    assert.match(JSON.parse(wrong.stdout).errors[0].code, /^spec\.derive\.store_(not_found|unauthorized|unreachable)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
