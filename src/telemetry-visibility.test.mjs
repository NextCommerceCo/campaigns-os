// Run Telemetry visibility: tenant-scoped remit (X-Campaign-Key), stale-session
// closeout, and the `telemetry list` reader. These are the three gaps behind
// "telemetry isn't accumulating": records landed but were invisible to every
// tenant scope, sessions that never reached a ready `qa run` were abandoned,
// and nothing could read the store back.

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveCampaignsApiKeyValue } from "./cli.mjs";
import { buildRunSession, findRunSession, resolveRunSessionPath, writeRunSession } from "./run-session.mjs";
import { resolveRunRecordPath } from "./run-record.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-telemetry-vis-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-telemetry-vis-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Consent isolated per test: XDG_CONFIG_HOME keeps the operator's real config
// out, and an explicit env choice keeps the default-on canonical path from
// ever reaching the network.
function isolatedEnv(dir, telemetry = "off") {
  return { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_TELEMETRY: telemetry };
}

function seedPacket(dir, overrides = null) {
  const packetPath = join(dir, "campaign-runtime.build.json");
  cpSync(resolve(ROOT, "examples/build-packet.basic.json"), packetPath);
  if (overrides) {
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    writeFileSync(packetPath, `${JSON.stringify(overrides(packet), null, 2)}\n`);
  }
  return packetPath;
}

function runCli(cwd, args, env) {
  const result = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

// Server-backed tests MUST spawn the CLI asynchronously: a sync spawn blocks
// this process's event loop, so the in-process HTTP server could never accept
// the child's request and the child would time out (or hang) waiting on it.
const execFileAsync = promisify(execFile);
async function runCliAsync(cwd, args, env) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { encoding: "utf8", cwd, env, timeout: 60_000 });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function writeStaleSession(dir, { packet = null, hoursAgo = 13 } = {}) {
  const started = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const session = buildRunSession({ runId: `run_stale_${started.getTime()}`, lifecycleJournal: join(dir, ".campaign-runtime/command-lifecycle.jsonl"), packet, now: started });
  writeRunSession(dir, session);
  return session;
}

// Records requests so a test can assert on the headers the CLI actually sent.
async function withServer(handler, run) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = handler(req, body);
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? { ok: true }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// --- key resolution -------------------------------------------------------

test("resolveCampaignsApiKeyValue: packet, then packet-local CampaignSpec, then declared env source; null otherwise", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ campaign: { campaigns_api_key: "pk_spec" } }));
    const withPacketKey = { campaign: { campaigns_api_key: " pk_packet " }, spec: { local_path: "./spec.json" } };
    assert.equal(resolveCampaignsApiKeyValue(withPacketKey, packetPath, {}), "pk_packet");
    const legacyPacketKey = { campaign: { api_key: "pk_legacy" } };
    assert.equal(resolveCampaignsApiKeyValue(legacyPacketKey, packetPath, {}), "pk_legacy");
    const specOnly = { campaign: {}, spec: { local_path: "./spec.json" } };
    assert.equal(resolveCampaignsApiKeyValue(specOnly, packetPath, {}), "pk_spec");
    const envOnly = { campaign: { api_key_source: "env:MY_CAMPAIGN_KEY" } };
    assert.equal(resolveCampaignsApiKeyValue(envOnly, packetPath, { MY_CAMPAIGN_KEY: "pk_env" }), "pk_env");
    assert.equal(resolveCampaignsApiKeyValue(envOnly, packetPath, {}), null);
    const missingSpec = { campaign: {}, spec: { local_path: "./nope.json" } };
    assert.equal(resolveCampaignsApiKeyValue(missingSpec, packetPath, {}), null);
    assert.equal(resolveCampaignsApiKeyValue({}, packetPath, {}), null);
  });
});

// --- remit header ---------------------------------------------------------

test("CLI: run-record remit carries X-Campaign-Key from the packet and never puts the key in the body", async () => {
  await withTempDirAsync(async (dir) => {
    const packetPath = seedPacket(dir, (packet) => ({ ...packet, campaign: { ...packet.campaign, campaigns_api_key: "pk_public_test" } }));
    await withServer(() => ({ status: 200, body: { ok: true, stored: true } }), async (base, requests) => {
      const run = await runCliAsync(dir, ["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_hdr", "--proxy-base", base, "--json"], isolatedEnv(dir, "on"));
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout);
      assert.equal(out.record.remit_ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/api/runs");
      assert.equal(requests[0].headers["x-campaign-key"], "pk_public_test");
      assert.equal(JSON.stringify(JSON.parse(requests[0].body)).includes("pk_public_test"), false);
      assert.equal(JSON.stringify(out.record).includes("pk_public_test"), false);
    });
  });
});

test("CLI: run-record remit with no resolvable key sends no X-Campaign-Key and says the record is unscoped", async () => {
  await withTempDirAsync(async (dir) => {
    const packetPath = seedPacket(dir, (packet) => {
      const campaign = { ...packet.campaign };
      delete campaign.campaigns_api_key;
      delete campaign.api_key;
      delete campaign.api_key_source;
      return { ...packet, campaign, spec: { ...packet.spec, local_path: "./missing-spec.json" } };
    });
    await withServer(() => ({ status: 200, body: { ok: true } }), async (base, requests) => {
      const run = await runCliAsync(dir, ["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_nokey", "--proxy-base", base], isolatedEnv(dir, "on"));
      assert.equal(run.status, 0, run.stderr);
      const text = run.stdout;
      assert.equal(requests.length, 1);
      assert.equal("x-campaign-key" in requests[0].headers, false);
      assert.match(text, /Remit: ok -> \/api\/runs \(unscoped/);
    });
  });
});

// --- stale-session closeout ----------------------------------------------

test("CLI: run start closes out a stale session into its Run Record before opening a new one", () => {
  withTempDir((dir) => {
    const packetPath = seedPacket(dir);
    const stale = writeStaleSession(dir, { packet: packetPath });
    assert.equal(findRunSession(dir), null, "a stale session is not discoverable as active");

    const { status, stdout, stderr } = runCli(dir, ["run", "start", "--json"], isolatedEnv(dir));
    assert.equal(status, 0, stderr);
    const started = JSON.parse(stdout);
    assert.notEqual(started.session.run_id, stale.run_id);
    assert.match(stderr, new RegExp(`Stale run session ${stale.run_id} .* closed out: Run Record`));

    const recordPath = resolveRunRecordPath(stale.run_id, dir);
    assert.equal(existsSync(recordPath), true, "the stale session's Run Record was assembled");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.run_id, stale.run_id);
    assert.equal(record.remit_state, "skipped"); // consent OFF in this test; the send is gated as usual
    // and the new session is the one on disk now
    assert.equal(JSON.parse(readFileSync(resolveRunSessionPath(dir), "utf8")).run_id, started.session.run_id);
  });
});

test("CLI: run end with only a stale session reports the closeout instead of failing", () => {
  withTempDir((dir) => {
    const packetPath = seedPacket(dir);
    const stale = writeStaleSession(dir, { packet: packetPath });
    const { status, stdout } = runCli(dir, ["run", "end", "--json"], isolatedEnv(dir));
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.stale_closeout[0].run_id, stale.run_id);
    assert.ok(out.stale_closeout[0].record_path);
    assert.equal(existsSync(resolveRunSessionPath(dir)), false);
  });
});

test("CLI: a stale session whose packet is gone is cleared with a note and no Run Record", () => {
  withTempDir((dir) => {
    const stale = writeStaleSession(dir, { packet: join(dir, "vanished.json") });
    const { status, stderr } = runCli(dir, ["run", "start", "--json"], isolatedEnv(dir));
    assert.equal(status, 0);
    assert.match(stderr, /cleared without a Run Record: packet missing/);
    assert.equal(existsSync(resolveRunRecordPath(stale.run_id, dir)), false);
  });
});

test("CLI: run status reports a stale session file but never sweeps it", () => {
  withTempDir((dir) => {
    const stale = writeStaleSession(dir, { packet: seedPacket(dir) });
    const { status, stdout } = runCli(dir, ["run", "status"], isolatedEnv(dir));
    assert.equal(status, 0);
    assert.match(stdout, /No active run session/);
    assert.match(stdout, new RegExp(`stale run session file is present \\(${stale.run_id}`));
    assert.equal(existsSync(resolveRunSessionPath(dir)), true, "status is read-only");
  });
});

test("CLI: a fresh (non-stale) session is never swept by run start", () => {
  withTempDir((dir) => {
    const fresh = writeStaleSession(dir, { packet: seedPacket(dir), hoursAgo: 1 });
    const { status, stderr } = runCli(dir, ["run", "start", "--json"], isolatedEnv(dir));
    assert.notEqual(status, 0);
    assert.match(stderr, /already active/);
    assert.equal(JSON.parse(readFileSync(resolveRunSessionPath(dir), "utf8")).run_id, fresh.run_id);
  });
});

// --- telemetry list -------------------------------------------------------

test("CLI: telemetry list uses the admin key from env for the cross-tenant listing", async () => {
  await withTempDirAsync(async (dir) => {
    const runs = [{ run_id: "run_a", received_at: "2026-09-10T01:02:03.000Z", package_version: "0.1.0-alpha.0", primary_surface: "doctor", trusted: false, campaign_key_hash: null }];
    await withServer(() => ({ status: 200, body: { ok: true, scope: "admin", count: 1, total: 1, truncated: false, runs } }), async (base, requests) => {
      const env = { ...isolatedEnv(dir), CAMPAIGN_OPS_ADMIN_KEY: "admin_secret" };
      const run = await runCliAsync(dir, ["telemetry", "list", "--proxy-base", base, "--since", "2026-09-01T00:00:00Z", "--json"], env);
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout);
      assert.equal(out.scope, "admin");
      assert.equal(out.count, 1);
      assert.equal(out.runs[0].run_id, "run_a");
      assert.equal(requests[0].headers["x-campaigns-ops-admin-key"], "admin_secret");
      assert.equal("x-campaign-key" in requests[0].headers, false);
      assert.equal(requests[0].url, "/api/runs?since=2026-09-01T00%3A00%3A00Z");
      // and the human rendering marks unscoped rows
      const human = await runCliAsync(dir, ["telemetry", "list", "--proxy-base", base], env);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /run_a .* unscoped/);
    });
  });
});

test("CLI: telemetry list --packet lists the tenant scope with the packet's campaign key", async () => {
  await withTempDirAsync(async (dir) => {
    const packetPath = seedPacket(dir, (packet) => ({ ...packet, campaign: { ...packet.campaign, campaigns_api_key: "pk_tenant" } }));
    await withServer(() => ({ status: 200, body: { ok: true, scope: "tenant", count: 0, total: 0, truncated: false, runs: [] } }), async (base, requests) => {
      const run = await runCliAsync(dir, ["telemetry", "list", "--packet", packetPath, "--proxy-base", base], isolatedEnv(dir));
      assert.equal(run.status, 0, run.stderr);
      const text = run.stdout;
      assert.equal(requests[0].headers["x-campaign-key"], "pk_tenant");
      assert.equal("x-campaigns-ops-admin-key" in requests[0].headers, false);
      assert.match(text, /None in this tenant scope/);
    });
  });
});

test("CLI: telemetry list fails closed without any credential, and surfaces a receiver 401", async () => {
  await withTempDirAsync(async (dir) => {
    const env = isolatedEnv(dir);
    delete env.CAMPAIGN_OPS_ADMIN_KEY;
    const noCred = runCli(dir, ["telemetry", "list", "--proxy-base", "http://127.0.0.1:1"], env);
    assert.notEqual(noCred.status, 0);
    assert.match(noCred.stderr, /set CAMPAIGN_OPS_ADMIN_KEY/);
    await withServer(() => ({ status: 401, body: { ok: false, error: "listing_auth_required" } }), async (base) => {
      const denied = await runCliAsync(dir, ["telemetry", "list", "--proxy-base", base], { ...env, CAMPAIGN_OPS_ADMIN_KEY: "wrong" });
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /401/);
      assert.match(denied.stderr, /listing_auth_required/);
    });
  });
});

test("CLI: telemetry status distinguishes default-on from an unresolved (malformed) config", () => {
  withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env.CAMPAIGNS_OS_TELEMETRY;
    const defaultOn = runCli(dir, ["telemetry", "status"], env);
    assert.match(defaultOn.stdout, /ON by default/);
    assert.doesNotMatch(defaultOn.stdout, /defaults OFF/);
    const cfgDir = join(dir, "campaigns-os");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), "not json"); // malformed → resolver fails closed, unresolved
    const malformed = runCli(dir, ["telemetry", "status"], env);
    assert.match(malformed.stdout, /Telemetry: off/);
    assert.match(malformed.stdout, /could not be resolved/);
    assert.doesNotMatch(malformed.stdout, /defaults OFF/);
  });
});
