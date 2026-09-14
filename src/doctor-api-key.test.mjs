import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctorPacket } from "./cli.mjs";

// Doctor's view of the Campaigns API key is a projection of the resolver the
// remit rails use, so the two cannot disagree about whether a value is a key.
// Doctor used to call any non-empty value "present"; the remit rail refused
// the same value on shape and never sent it.

function fixture(mutate, { specKey = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-api-key-"));
  cpSync(new URL("../examples", import.meta.url).pathname, join(dir, "examples"), { recursive: true });
  const packetPath = join(dir, "examples/build-packet.basic.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  mutate(packet);
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  if (!specKey) {
    // The example spec carries a fixture key, which outranks the env source.
    const specPath = join(dir, "examples", packet.spec.local_path);
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    delete spec.campaign.campaigns_api_key;
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
  }
  return { dir, packetPath };
}

const withEnv = (patch, fn) => {
  const previous = {};
  for (const [name, value] of Object.entries(patch)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
};

test("a packet key that is not a campaign-key shape is reported as refused, naming the field and never the value", () => {
  const { dir, packetPath } = fixture((packet) => { packet.campaign.campaigns_api_key = '{ "pasted": "json blob" }'; });
  try {
    const result = withEnv({ CAMPAIGNS_API_KEY: undefined }, () => doctorPacket(packetPath));
    const rejected = result.warnings.find((issue) => issue.code === "campaign.api_key_rejected");
    assert.ok(rejected, JSON.stringify(result.warnings.map((issue) => issue.code)));
    assert.match(rejected.message, /packet\.campaign\.campaigns_api_key/);
    assert.match(rejected.message, /^The Campaigns API key from packet\.campaign\.campaigns_api_key is not a campaign-key shape/);
    assert.match(rejected.message, /\. API-side package\/shipping\/offer confirmation is deferred\.$/);
    assert.doesNotMatch(rejected.message, /pasted/, "the value is never printed");
    assert.deepEqual(rejected.detail, { source: "packet.campaign.campaigns_api_key", kind: "malformed" });
    assert.equal(result.ready.some((line) => line.startsWith("Campaigns API key available")), false, "a refused key is not available");
    assert.equal(result.warnings.some((issue) => issue.code === "campaign.api_key_source"), false, "refused is its own finding, not a source warning too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a well-formed packet key is available with the storage warning, as before", () => {
  const { dir, packetPath } = fixture((packet) => { packet.campaign.campaigns_api_key = "pk_live_abcdefghij"; });
  try {
    const result = doctorPacket(packetPath);
    assert.ok(result.ready.includes("Campaigns API key available via packet.campaign.campaigns_api_key"));
    assert.ok(result.warnings.some((issue) => issue.code === "campaign.api_key_source" && /stored directly in the Build Packet/.test(issue.message)));
    assert.equal(result.warnings.some((issue) => issue.code === "campaign.api_key_rejected"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an env source that does not name a campaign key is refused, not read", () => {
  const { dir, packetPath } = fixture((packet) => { packet.campaign.api_key_source = "env:AWS_SECRET_ACCESS_KEY"; }, { specKey: false });
  try {
    const result = withEnv({ AWS_SECRET_ACCESS_KEY: "very-secret-value-12345" }, () => doctorPacket(packetPath));
    const rejected = result.warnings.find((issue) => issue.code === "campaign.api_key_rejected");
    assert.ok(rejected);
    assert.equal(rejected.detail.kind, "unsupported_env_name");
    assert.match(rejected.message, /env:AWS_SECRET_ACCESS_KEY/);
    assert.doesNotMatch(rejected.message, /very-secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset env source still explains itself under campaign.api_key_source", () => {
  const { dir, packetPath } = fixture(() => {}, { specKey: false });
  try {
    const result = withEnv({ CAMPAIGNS_API_KEY: undefined }, () => doctorPacket(packetPath));
    const source = result.warnings.find((issue) => issue.code === "campaign.api_key_source");
    assert.ok(source);
    assert.match(source.message, /Environment variable CAMPAIGNS_API_KEY is not set/);
    assert.equal(result.warnings.some((issue) => issue.code === "campaign.api_key_rejected"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
