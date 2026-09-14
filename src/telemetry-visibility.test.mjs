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

import { describeCampaignKeyRejection, resolveCampaignsApiKeySource, resolveCampaignsApiKeyValue } from "./cli.mjs";
import { buildRunSession, findRunSession, findStaleRunSession, resolveRunSessionPath, writeRunSession } from "./run-session.mjs";
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
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ campaign: { campaigns_api_key: "pk_spec_key" } }));
    const withPacketKey = { campaign: { campaigns_api_key: " pk_packet " }, spec: { local_path: "./spec.json" } };
    assert.equal(resolveCampaignsApiKeyValue(withPacketKey, packetPath, {}), "pk_packet");
    const legacyPacketKey = { campaign: { api_key: "pk_legacy" } };
    assert.equal(resolveCampaignsApiKeyValue(legacyPacketKey, packetPath, {}), "pk_legacy");
    const specOnly = { campaign: {}, spec: { local_path: "./spec.json" } };
    assert.equal(resolveCampaignsApiKeyValue(specOnly, packetPath, {}), "pk_spec_key");
    const envOnly = { campaign: { api_key_source: "env:MY_CAMPAIGN_KEY" } };
    assert.equal(resolveCampaignsApiKeyValue(envOnly, packetPath, { MY_CAMPAIGN_KEY: "pk_env_key" }), "pk_env_key");
    assert.equal(resolveCampaignsApiKeyValue(envOnly, packetPath, {}), null);
    // The env source is restricted to variable names that name a campaign key,
    // so a packet cannot route an arbitrary secret into the header.
    const foreignEnv = { campaign: { api_key_source: "env:AWS_SECRET_ACCESS_KEY" } };
    assert.equal(resolveCampaignsApiKeyValue(foreignEnv, packetPath, { AWS_SECRET_ACCESS_KEY: "not-a-campaign-key-000001" }), null);
    // And the value must look like a token: no whitespace, JSON, URLs, or blobs.
    assert.equal(resolveCampaignsApiKeyValue({ campaign: { campaigns_api_key: "has space in it" } }, packetPath, {}), null);
    assert.equal(resolveCampaignsApiKeyValue({ campaign: { campaigns_api_key: "short" } }, packetPath, {}), null);
    assert.equal(resolveCampaignsApiKeyValue({ campaign: { campaigns_api_key: "https://x.test/k" } }, packetPath, {}), null);
    const missingSpec = { campaign: {}, spec: { local_path: "./nope.json" } };
    assert.equal(resolveCampaignsApiKeyValue(missingSpec, packetPath, {}), null);
    assert.equal(resolveCampaignsApiKeyValue({}, packetPath, {}), null);
  });
});

// A value that is present but the wrong shape is a different operator problem
// from no value at all, and the caller has to be able to say which — naming
// the SOURCE (the env var, or the packet field) and never the value.
// The documented default source is `env:CAMPAIGNS_API_KEY`. The gate that keeps
// a packet from pointing api_key_source at an arbitrary secret must accept a
// name that starts with CAMPAIGN, not only one that contains it later.
test("resolveCampaignsApiKeySource: accepts the documented CAMPAIGNS_API_KEY and CAMPAIGN_KEY names, and still refuses a foreign secret", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    for (const name of ["CAMPAIGNS_API_KEY", "CAMPAIGN_KEY", "MY_CAMPAIGN_KEY", "NEXT_CAMPAIGNS_API_KEY"]) {
      const resolved = resolveCampaignsApiKeySource({ campaign: { api_key_source: `env:${name}` } }, packetPath, { [name]: "pk_env_key_ok" });
      assert.equal(resolved.key, "pk_env_key_ok", name);
      assert.equal(resolved.origin, `env:${name}`);
    }
    for (const name of ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "campaigns_api_key"]) {
      const resolved = resolveCampaignsApiKeySource({ campaign: { api_key_source: `env:${name}` } }, packetPath, { [name]: "pk_env_key_ok" });
      assert.equal(resolved.key, null, name);
      assert.equal(resolved.rejected?.kind, "unsupported_env_name", name);
    }
  });
});

test("resolveCampaignsApiKeySource: reports the refused source for a present-but-malformed key, never its value", () => {
  withTempDir((dir) => {
    const packetPath = join(dir, "campaign-runtime.build.json");
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ campaign: { campaigns_api_key: "not a key at all" } }));

    const good = resolveCampaignsApiKeySource({ campaign: { api_key_source: "env:MY_CAMPAIGN_KEY" } }, packetPath, { MY_CAMPAIGN_KEY: "pk_env_key" });
    assert.equal(good.key, "pk_env_key");
    assert.equal(good.rejected, null);
    assert.equal(describeCampaignKeyRejection(good.rejected), null);

    // env source present but malformed → refused, and the message names the var
    const badEnv = resolveCampaignsApiKeySource({ campaign: { api_key_source: "env:MY_CAMPAIGN_KEY" } }, packetPath, { MY_CAMPAIGN_KEY: '{"key":"pk_live_x"}' });
    assert.equal(badEnv.key, null);
    assert.equal(badEnv.rejected.kind, "malformed");
    assert.equal(badEnv.rejected.source, "env:MY_CAMPAIGN_KEY");
    const envMessage = describeCampaignKeyRejection(badEnv.rejected);
    assert.match(envMessage, /env:MY_CAMPAIGN_KEY/);
    assert.doesNotMatch(envMessage, /pk_live_x/);

    // absent is NOT refused — it stays the "no key configured" case
    const absent = resolveCampaignsApiKeySource({ campaign: { api_key_source: "env:MY_CAMPAIGN_KEY" } }, packetPath, {});
    assert.equal(absent.key, null);
    assert.equal(absent.rejected, null);

    // packet field and CampaignSpec sources name themselves too
    const badPacket = resolveCampaignsApiKeySource({ campaign: { campaigns_api_key: "has space in it" } }, packetPath, {});
    assert.equal(badPacket.rejected.source, "packet.campaign.campaigns_api_key");
    assert.doesNotMatch(describeCampaignKeyRejection(badPacket.rejected), /has space in it/);
    // and a CampaignSpec source names the field the value actually came from,
    // not whichever field is checked first
    const badSpec = resolveCampaignsApiKeySource({ campaign: {}, spec: { local_path: "./spec.json" } }, packetPath, {});
    assert.equal(badSpec.rejected.source, "the packet-local CampaignSpec campaign.campaigns_api_key");
    writeFileSync(join(dir, "top.json"), JSON.stringify({ campaigns_api_key: "not a key at all" }));
    const badSpecTop = resolveCampaignsApiKeySource({ campaign: {}, spec: { local_path: "./top.json" } }, packetPath, {});
    assert.equal(badSpecTop.rejected.source, "the packet-local CampaignSpec campaigns_api_key");
    writeFileSync(join(dir, "legacy.json"), JSON.stringify({ campaign: { api_key: "not a key at all" } }));
    const badSpecLegacy = resolveCampaignsApiKeySource({ campaign: {}, spec: { local_path: "./legacy.json" } }, packetPath, {});
    assert.equal(badSpecLegacy.rejected.source, "the packet-local CampaignSpec campaign.api_key");
    writeFileSync(join(dir, "good-legacy.json"), JSON.stringify({ campaign: { api_key: "pk_spec_legacy" } }));
    const goodSpecLegacy = resolveCampaignsApiKeySource({ campaign: {}, spec: { local_path: "./good-legacy.json" } }, packetPath, {});
    assert.equal(goodSpecLegacy.key, "pk_spec_legacy");
    assert.equal(goodSpecLegacy.origin, "the packet-local CampaignSpec campaign.api_key");

    // an api_key_source pointed at a variable that does not name a campaign
    // key is refused by NAME, and its value is never read
    const foreign = resolveCampaignsApiKeySource({ campaign: { api_key_source: "env:AWS_SECRET_ACCESS_KEY" } }, packetPath, { AWS_SECRET_ACCESS_KEY: "not-a-campaign-key-000001" });
    assert.equal(foreign.key, null);
    assert.equal(foreign.rejected.kind, "unsupported_env_name");
    assert.doesNotMatch(describeCampaignKeyRejection(foreign.rejected), /not-a-campaign-key-000001/);
  });
});

test("CLI: telemetry list --packet refuses a malformed declared key by naming the env var, and makes no request", async () => {
  await withTempDirAsync(async (dir) => {
    const packetPath = seedPacket(dir, (packet) => ({
      ...packet,
      campaign: { ...packet.campaign, campaigns_api_key: undefined, api_key: undefined, api_key_source: "env:MY_CAMPAIGN_KEY" },
    }));
    await withServer(() => ({ status: 200, body: { ok: true, runs: [] } }), async (base, requests) => {
      const env = { ...isolatedEnv(dir), MY_CAMPAIGN_KEY: '{"key": "pk_live_secretish"}' };
      const run = await runCliAsync(dir, ["telemetry", "list", "--packet", packetPath, "--proxy-base", base], env);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /env:MY_CAMPAIGN_KEY/);
      assert.match(run.stderr, /not a campaign-key shape/);
      assert.doesNotMatch(run.stderr, /pk_live_secretish/); // the value never appears
      assert.equal(requests.length, 0); // refused before any request
    });
  });
});

test("CLI: telemetry list warns that the credential is in clear over loopback http, and says nothing on https", async () => {
  await withTempDirAsync(async (dir) => {
    await withServer(() => ({ status: 200, body: { ok: true, scope: "admin", runs: [], total: 0 } }), async (base) => {
      const env = { ...isolatedEnv(dir), CAMPAIGN_OPS_ADMIN_KEY: "admin_secret" };
      const loopback = await runCliAsync(dir, ["telemetry", "list", "--proxy-base", base, "--json"], env);
      assert.equal(loopback.status, 0, loopback.stderr);
      assert.match(loopback.stderr, /is plain http/);
      assert.match(loopback.stderr, /travels in clear to a local proxy/);
      assert.doesNotMatch(loopback.stderr, /admin_secret/);
      // https: the gate is silent. The canonical base is https, so this run
      // gets past the gate and fails later on the network instead.
      const secure = runCli(dir, ["telemetry", "list", "--proxy-base", "https://proxy.example.invalid", "--trust-proxy-base"], env);
      assert.doesNotMatch(secure.stderr, /is plain http/);
    });
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

// The credential warning belongs to a send. Under consent-off or --no-remit
// there is no send, so the key is never read and nothing is said about it —
// an opted-out operator must not be told anything travelled.
test("CLI: run-record says nothing about a refused key when no remit is attempted", () => {
  withTempDir((dir) => {
    const packetPath = seedPacket(dir, (packet) => {
      const campaign = { ...packet.campaign, api_key_source: "env:MY_CAMPAIGN_KEY" };
      delete campaign.campaigns_api_key;
      delete campaign.api_key;
      return { ...packet, campaign, spec: { ...packet.spec, local_path: "./missing-spec.json" } };
    });
    const env = { ...isolatedEnv(dir, "off"), MY_CAMPAIGN_KEY: "pk live secretish" };
    const off = runCli(dir, ["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_offkey"], env);
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stderr, /MY_CAMPAIGN_KEY/);
    assert.doesNotMatch(off.stderr, /campaign-key shape/);
    assert.match(off.stdout, /Remit: skipped/);

    const noRemit = runCli(dir, ["run-record", "--packet", packetPath, "--journal", join(dir, "wf2.jsonl"), "--run-id", "run_norem_key", "--no-remit"], { ...env, CAMPAIGNS_OS_TELEMETRY: "on" });
    assert.equal(noRemit.status, 0, noRemit.stderr);
    assert.doesNotMatch(noRemit.stderr, /MY_CAMPAIGN_KEY/);
    assert.match(noRemit.stdout, /Remit: skipped/);
  });
});

test("CLI: run-record warns that a declared key was refused on shape, names the env var, and remits unscoped", async () => {
  await withTempDirAsync(async (dir) => {
    const packetPath = seedPacket(dir, (packet) => {
      const campaign = { ...packet.campaign, api_key_source: "env:MY_CAMPAIGN_KEY" };
      delete campaign.campaigns_api_key;
      delete campaign.api_key;
      return { ...packet, campaign, spec: { ...packet.spec, local_path: "./missing-spec.json" } };
    });
    await withServer(() => ({ status: 200, body: { ok: true } }), async (base, requests) => {
      const env = { ...isolatedEnv(dir, "on"), MY_CAMPAIGN_KEY: "pk live secretish" }; // whitespace: not a key shape
      const run = await runCliAsync(dir, ["run-record", "--packet", packetPath, "--journal", join(dir, "wf.jsonl"), "--run-id", "run_badkey", "--proxy-base", base], env);
      assert.equal(run.status, 0, run.stderr); // the remit rail stays non-fatal
      assert.match(run.stderr, /env:MY_CAMPAIGN_KEY/);
      assert.match(run.stderr, /not a campaign-key shape/);
      assert.doesNotMatch(run.stderr, /secretish/); // the value never appears
      // the record still goes, but without the credential, and the summary
      // says the key was refused rather than "no key found"
      assert.equal(requests.length, 1);
      assert.equal("x-campaign-key" in requests[0].headers, false);
      assert.match(run.stdout, /refused on shape/);
      assert.match(run.stderr, /remit is attempted without a tenant scope/);
      assert.doesNotMatch(run.stdout, /no Campaigns API key found/);
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

test("CLI: stale closeout inherits the invoking command's --no-remit and --no-run-session", () => {
  withTempDir((dir) => {
    const packetPath = seedPacket(dir);
    const stale = writeStaleSession(dir, { packet: packetPath });
    // --no-run-session: no sweep at all, the stale file is left alone.
    const untouched = runCli(dir, ["run", "status", "--no-run-session"], isolatedEnv(dir, "on"));
    assert.equal(untouched.status, 0);
    assert.equal(existsSync(resolveRunSessionPath(dir)), true);
    // --no-remit on the ending command: consent is ON, the record is written, nothing is sent.
    const end = runCli(dir, ["run", "end", "--no-remit", "--proxy-base", "http://127.0.0.1:1", "--json"], isolatedEnv(dir, "on"));
    assert.equal(end.status, 0, end.stderr);
    const out = JSON.parse(end.stdout);
    assert.equal(out.ok, true);
    const record = JSON.parse(readFileSync(resolveRunRecordPath(stale.run_id, dir), "utf8"));
    assert.equal(record.consent_state, "on");
    assert.equal(record.remit_attempted, false);
    assert.equal(record.remit_state, "skipped");
  });
});

test("findStaleRunSession never adopts a session at $HOME, an ancestor of $HOME, or the filesystem root", () => {
  withTempDir((dir) => {
    writeStaleSession(dir, {});
    assert.ok(findStaleRunSession(dir), "a project dir is swept");
    assert.equal(findStaleRunSession(dir, { home: dir }), null, "$HOME itself is not");
    assert.equal(findStaleRunSession(dir, { home: join(dir, "deeper", "home") }), null, "an ancestor of $HOME is not");
    assert.equal(findStaleRunSession("/", { home: dir }), null, "the root is not");
  });
});

test("CLI: a stale session whose packet is gone is cleared with a note and no Run Record", () => {
  withTempDir((dir) => {
    const stale = writeStaleSession(dir, { packet: join(dir, "vanished.json") });
    const { status, stderr } = runCli(dir, ["run", "start", "--json"], isolatedEnv(dir));
    assert.equal(status, 0);
    assert.match(stderr, /cleared without a Run Record: packet missing/);
    assert.equal(existsSync(resolveRunRecordPath(stale.run_id, dir)), false);
    // and `run end` on such a session says ok:false — the file is gone but no record was produced
    const stale2 = writeStaleSession(dir, { packet: join(dir, "vanished-too.json") });
    const end = JSON.parse(runCli(dir, ["run", "end", "--json"], isolatedEnv(dir)).stdout);
    assert.equal(end.ok, false);
    assert.equal(end.stale_closeout[0].run_id, stale2.run_id);
    assert.match(end.stale_closeout[0].error, /packet missing/);
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
    const json = JSON.parse(runCli(dir, ["run", "status", "--json"], isolatedEnv(dir)).stdout);
    assert.equal(json.active, false);
    assert.equal(json.stale_session.run_id, stale.run_id);
    assert.ok(json.stale_session.session_path.endsWith(join(".campaign-runtime", "run-session.json"))); // cwd may be realpath'd (/private on macOS)
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
      assert.equal(out.returned, 1);
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

test("CLI: telemetry list never sends the admin key to a non-canonical, non-loopback base without --trust-proxy-base, and never over plain http", () => {
  withTempDir((dir) => {
    const env = { ...isolatedEnv(dir), CAMPAIGN_OPS_ADMIN_KEY: "admin_secret" };
    const remote = runCli(dir, ["telemetry", "list", "--proxy-base", "https://proxy.example.invalid"], env);
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /refusing to send the ops admin key to non-canonical https:\/\/proxy\.example\.invalid/);
    const plain = runCli(dir, ["telemetry", "list", "--proxy-base", "http://proxy.example.invalid"], env);
    assert.notEqual(plain.status, 0);
    assert.match(plain.stderr, /must be https/);
    // --trust-proxy-base is the explicit vouch; the request then fails on DNS, proving it got past the gate.
    const trusted = runCli(dir, ["telemetry", "list", "--proxy-base", "https://proxy.example.invalid", "--trust-proxy-base"], env);
    assert.notEqual(trusted.status, 0);
    assert.doesNotMatch(trusted.stderr, /refusing to send/);
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
