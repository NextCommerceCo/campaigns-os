import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  announceDefaultOnTelemetry,
  CANONICAL_REMIT_SCOPE,
  normalizeConsentScope,
  parseEnvConsent,
  promptAndPersistConsent,
  readConfig,
  resolveConfigPath,
  resolveConsent,
  scopedConsentCommand,
  TELEMETRY_CONFIG_SCHEMA,
  TELEMETRY_ENV_VAR,
  writeConsentConfig,
} from "./consent.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/campaigns-os.mjs");

// Async-aware so callbacks that await (the prompt tests) finish before the
// temp dir is removed — `await run(dir)` is correct for sync callbacks too.
async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "campaigns-os-consent-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const quiet = () => {}; // swallow warnings in tests asserting state, not output

test("parseEnvConsent recognizes exactly 1|true|on / 0|false|off (case-insensitive)", () => {
  for (const v of ["1", "true", "on", "TRUE", " On "]) assert.equal(parseEnvConsent(v).state, "on", v);
  for (const v of ["0", "false", "off", "OFF", " Off "]) assert.equal(parseEnvConsent(v).state, "off", v);
  assert.deepEqual(parseEnvConsent(undefined), { state: null, present: false, unknown: false });
  assert.deepEqual(parseEnvConsent(""), { state: null, present: false, unknown: false });
  // anything else is unknown -> fail closed
  const banana = parseEnvConsent("banana");
  assert.equal(banana.state, null);
  assert.equal(banana.present, true);
  assert.equal(banana.unknown, true);
});

test("resolveConsent: file missing -> ON by default for the canonical endpoint", async () => {
  await withTempDir((dir) => {
    const result = resolveConsent({ env: {}, configPath: join(dir, "config.json"), warn: quiet });
    assert.equal(result.state, "on");
    assert.equal(result.source, "default");
    assert.equal(result.resolved, true);
    assert.equal(result.default_on, true);
  });
});

test("resolveConsent: default-on never applies to a non-canonical endpoint", async () => {
  await withTempDir((dir) => {
    const result = resolveConsent({
      env: {},
      configPath: join(dir, "config.json"),
      proxyBase: "https://staging.example.com",
      warn: quiet,
    });
    assert.equal(result.state, "off");
    assert.equal(result.source, "default");
    assert.equal(result.resolved, false, "non-canonical remit scope stays fail-closed until explicitly consented");
  });
});

test("resolveConsent: a non-empty proxyBase that fails to normalize is NOT granted default-on", async () => {
  await withTempDir((dir) => {
    const result = resolveConsent({
      env: {},
      configPath: join(dir, "config.json"),
      proxyBase: "::::not a url::::",
      warn: quiet,
    });
    assert.equal(result.state, "off", "an unparseable endpoint must not inherit canonical consent");
    assert.equal(result.resolved, false);
  });
});

// Single test owns the process-wide latch: the first call must announce
// (covering the null-endpoint canonical fallback in the same breath), every
// later call must be suppressed. No reset hook exists — the latch is
// deliberately once-per-process, so the test asserts exactly that.
test("announceDefaultOnTelemetry fires exactly once per process and names the endpoint", () => {
  const lines = [];
  const write = (line) => lines.push(line);
  assert.equal(announceDefaultOnTelemetry(null, { write }), true, "first call announces; null endpoint falls back to canonical");
  assert.equal(announceDefaultOnTelemetry("https://other.example.com", { write }), false, "second call is suppressed regardless of endpoint");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /campaign-map\.nextcommerce\.com/);
  assert.match(lines[0], /telemetry off/);
});

test("resolveConsent: env beats file (both directions)", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("off", { configPath });
    const onWins = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "on" }, configPath, warn: quiet });
    assert.deepEqual([onWins.state, onWins.source], ["on", "env"]);

    writeConsentConfig("on", { configPath });
    const offWins = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "off" }, configPath, warn: quiet });
    assert.deepEqual([offWins.state, offWins.source], ["off", "env"]);
  });
});

test("resolveConsent: file is honored when no env override", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("on", { configPath });
    const result = resolveConsent({ env: {}, configPath, warn: quiet });
    assert.deepEqual([result.state, result.source, result.resolved], ["on", "file", true]);
  });
});

test("resolveConsent: file consent is scoped to the proxy base it was granted for", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("on", { configPath, proxyBase: "https://proxy-a.test/" });

    const match = resolveConsent({ env: {}, configPath, proxyBase: "https://proxy-a.test", warn: quiet });
    assert.deepEqual([match.state, match.source, match.resolved], ["on", "file", true]);

    let warned = "";
    const mismatch = resolveConsent({ env: {}, configPath, proxyBase: "https://proxy-b.test", warn: (message) => { warned = message; } });
    assert.equal(mismatch.state, "off");
    assert.equal(mismatch.resolved, false);
    assert.equal(mismatch.scope_mismatch, true);
    assert.match(warned, /scoped to https:\/\/proxy-a\.test/);
  });
});

test("normalizeConsentScope repairs bare hosts and rejects malformed scopes", () => {
  assert.equal(normalizeConsentScope("proxy.test/"), "https://proxy.test");
  assert.equal(normalizeConsentScope("proxy.test/api/"), "https://proxy.test/api");
  assert.equal(normalizeConsentScope("https://proxy.test/api/"), "https://proxy.test/api");
  assert.equal(normalizeConsentScope("https://"), null);
  assert.equal(normalizeConsentScope("bad value"), null);
});

test("writeConsentConfig rejects invalid states instead of coercing to off", async () => {
  await withTempDir((dir) => {
    assert.throws(
      () => writeConsentConfig("maybe", { configPath: join(dir, "config.json") }),
      /must be "on" or "off"/,
    );
  });
});

test("resolveConsent: malformed file is safe -> OFF + warns", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{ this is not json");
    let warned = "";
    const result = resolveConsent({ env: {}, configPath, warn: (m) => { warned = m; } });
    assert.equal(result.state, "off");
    assert.equal(result.source, "default");
    assert.match(warned, /malformed/);
  });
});

test("resolveConsent: unknown env value fails closed -> OFF + warns", () => {
  let warned = "";
  const result = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "banana" }, configPath: "/nonexistent/config.json", warn: (m) => { warned = m; } });
  assert.equal(result.state, "off");
  assert.equal(result.source, "env"); // the unknown env value is what decided it
  assert.match(warned, /not a recognized value/);
});

test("writeConsentConfig + readConfig round-trip carries schema_version, package, scope, source, timestamp", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    const now = new Date("2026-06-07T00:00:00.000Z");
    writeConsentConfig("on", { configPath, proxyBase: "https://example.test", source: "telemetry-command", now });
    const { ok, config } = readConfig(configPath);
    assert.equal(ok, true);
    assert.equal(config.schema_version, TELEMETRY_CONFIG_SCHEMA);
    assert.equal(config.package, "@nextcommerce/campaigns-os");
    assert.equal(config.telemetry.enabled, true);
    assert.equal(config.telemetry.scope, "https://example.test");
    assert.equal(config.telemetry.source, "telemetry-command");
    assert.equal(config.telemetry.updated_at, "2026-06-07T00:00:00.000Z");
  });
});

test("writeConsentConfig repairs bare proxy host scopes", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("on", { configPath, proxyBase: "proxy.test/" });
    const { config } = readConfig(configPath);
    assert.equal(config.telemetry.scope, "https://proxy.test");
    const result = resolveConsent({ env: {}, configPath, proxyBase: "https://proxy.test", warn: quiet });
    assert.equal(result.state, "on");
  });
});

test("resolveConfigPath honors XDG_CONFIG_HOME", () => {
  assert.equal(
    resolveConfigPath({ env: { XDG_CONFIG_HOME: "/tmp/xdg" }, home: "/home/ignored" }),
    join("/tmp/xdg", "campaigns-os", "config.json"),
  );
  assert.equal(
    resolveConfigPath({ env: {}, home: "/home/me" }),
    join("/home/me", ".config", "campaigns-os", "config.json"),
  );
});

test("promptAndPersistConsent: canonical scope is default-on, so no prompt fires", async () => {
  await withTempDir(async (dir) => {
    let asked = false;
    const result = await promptAndPersistConsent({
      configPath: join(dir, "config.json"),
      env: {},
      isTTY: true,
      ask: async () => { asked = true; return "y"; },
    });
    assert.equal(asked, false, "default-on is already resolved; nothing to ask");
    assert.equal(result.state, "on");
    assert.equal(result.prompted, false);
  });
});

test("promptAndPersistConsent: non-interactive non-canonical scope stays OFF without prompting", async () => {
  await withTempDir(async (dir) => {
    let asked = false;
    const result = await promptAndPersistConsent({
      configPath: join(dir, "config.json"),
      env: {},
      proxyBase: "https://staging.example.com",
      isTTY: false,
      ask: async () => { asked = true; return "y"; },
    });
    assert.equal(asked, false);
    assert.equal(result.state, "off");
    assert.equal(result.prompted, false);
  });
});

test("promptAndPersistConsent: interactive non-canonical scope prompts; empty answer defaults ON and persists", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const proxyBase = "https://staging.example.com";
    const result = await promptAndPersistConsent({ configPath, env: {}, proxyBase, isTTY: true, ask: async () => "" });
    assert.equal(result.state, "on");
    assert.equal(result.prompted, true);
    // persisted, so a later resolve reads it from file without re-asking
    assert.deepEqual([resolveConsent({ env: {}, configPath, proxyBase, warn: quiet }).state], ["on"]);
  });
});

test("promptAndPersistConsent: explicit prior choice is never re-prompted", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("off", { configPath });
    let asked = false;
    const result = await promptAndPersistConsent({ configPath, env: {}, isTTY: true, ask: async () => { asked = true; return "y"; } });
    assert.equal(asked, false);
    assert.equal(result.state, "off");
    assert.equal(result.prompted, false);
  });
});

test("CLI: telemetry on/off/status round-trips via XDG_CONFIG_HOME", async () => {
  await withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env[TELEMETRY_ENV_VAR];

    const on = JSON.parse(execFileSync("node", [CLI, "telemetry", "on", "--json"], { encoding: "utf8", env }));
    assert.equal(on.state, "on");
    assert.equal(on.source, "file");

    const status = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--json"], { encoding: "utf8", env }));
    assert.equal(status.state, "on");
    assert.equal(status.config_present, true);

    const off = JSON.parse(execFileSync("node", [CLI, "telemetry", "off", "--json"], { encoding: "utf8", env }));
    assert.equal(off.state, "off");
  });
});

test("CLI: telemetry status defaults ON when nothing is configured", async () => {
  await withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env[TELEMETRY_ENV_VAR];
    const status = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--json"], { encoding: "utf8", env }));
    assert.equal(status.state, "on");
    assert.equal(status.source, "default");
    assert.equal(status.resolved, true);
    assert.equal(status.config_present, false);
  });
});

test("CLI: telemetry env override beats the stored file", async () => {
  await withTempDir((dir) => {
    const baseEnv = { ...process.env, XDG_CONFIG_HOME: dir };
    delete baseEnv[TELEMETRY_ENV_VAR];
    execFileSync("node", [CLI, "telemetry", "on", "--json"], { encoding: "utf8", env: baseEnv });
    const status = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--json"], { encoding: "utf8", env: { ...baseEnv, [TELEMETRY_ENV_VAR]: "off" } }));
    assert.equal(status.state, "off");
    assert.equal(status.source, "env");
  });
});

// --- Scoped file consent -----------------------------------------------------
// A file grant covers one endpoint. `telemetry on --proxy-base <url>` is the
// non-interactive way to grant a non-canonical receiver; the env override
// grants every endpoint and says so. Every remit below goes to a loopback
// receiver started in this process, with the env override absent.

async function startLoopbackReceiver() {
  const { createServer } = await import("node:http");
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch { payload = null; }
      posts.push({ method: request.method, url: request.url, payload });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, run_id: payload?.run_id ?? null }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    posts,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

function cliEnv(dir, overrides = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: dir, CAMPAIGNS_OS_LIFECYCLE_LOG: "", ...overrides };
  delete env[TELEMETRY_ENV_VAR];
  return env;
}

function runCli(argv, env, cwd = undefined) {
  try {
    return { status: 0, stdout: execFileSync("node", [CLI, ...argv], { encoding: "utf8", env, cwd, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

// The receiver answers from this process's event loop, so a command that
// remits to it must not block that loop: run it asynchronously.
const execFileAsync = promisify(execFile);
async function runCliAsync(argv, env, cwd = undefined) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], { encoding: "utf8", env, cwd });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

test("writeConsentConfig refuses a named scope that is not a URL instead of storing scope: null", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    assert.throws(() => writeConsentConfig("on", { configPath, proxyBase: "not a url" }), /consent scope is not a URL: not a url/);
    assert.equal(readConfig(configPath).ok, false);
    // The same input is refused for OFF: a malformed base is a typo to
    // surface, not something to drop silently.
    assert.throws(() => writeConsentConfig("off", { configPath, proxyBase: "not a url" }), /consent scope is not a URL: not a url/);
    assert.equal(readConfig(configPath).ok, false);
  });
});

test("writeConsentConfig stores an OFF record unscoped even when a base is named", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    // The prompt path passes the remit's base for a "no" answer too; an OFF
    // choice is machine-wide, so the record must not look like a grant.
    writeConsentConfig("off", { configPath, proxyBase: "http://127.0.0.1:4399", source: "prompt" });
    const { config } = readConfig(configPath);
    assert.deepEqual([config.telemetry.enabled, config.telemetry.scope], [false, null]);
    assert.equal(resolveConsent({ env: {}, configPath, proxyBase: "http://127.0.0.1:4399", warn: quiet }).state, "off");
    assert.equal(resolveConsent({ env: {}, configPath, warn: quiet }).state, "off");
  });
});

test("resolveConsent: the scope-mismatch warning names the command that grants the requested endpoint", async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, "config.json");
    writeConsentConfig("on", { configPath });
    let warned = "";
    const mismatch = resolveConsent({ env: {}, configPath, proxyBase: "http://127.0.0.1:4399/", warn: (message) => { warned = message; } });
    assert.equal(mismatch.state, "off");
    assert.equal(mismatch.scope_mismatch, true);
    assert.equal(mismatch.requested_scope, "http://127.0.0.1:4399");
    assert.match(warned, /run: campaigns-os telemetry on --proxy-base http:\/\/127\.0\.0\.1:4399$/);
    assert.doesNotMatch(warned, /until this endpoint is confirmed/);

    // A mismatch against the canonical endpoint names the bare command.
    writeConsentConfig("on", { configPath, proxyBase: "http://127.0.0.1:4399" });
    resolveConsent({ env: {}, configPath, proxyBase: CANONICAL_REMIT_SCOPE, warn: (message) => { warned = message; } });
    assert.match(warned, /run: campaigns-os telemetry on$/);
  });
});

test("resolveConsent: the env override says it bypasses scope checking for a non-canonical endpoint", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const bypassed = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "on" }, configPath: "/nonexistent/config.json", proxyBase: "http://127.0.0.1:4399", warn });
  assert.deepEqual([bypassed.state, bypassed.source, bypassed.scope_bypassed, bypassed.scope], ["on", "env", true, "http://127.0.0.1:4399"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CAMPAIGNS_OS_TELEMETRY=on bypasses consent scope checking/);
  assert.match(warnings[0], /campaigns-os telemetry on --proxy-base http:\/\/127\.0\.0\.1:4399/);

  // The canonical endpoint (named or implied) and env=off stay silent.
  warnings.length = 0;
  const canonical = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "on" }, configPath: "/nonexistent/config.json", proxyBase: CANONICAL_REMIT_SCOPE, warn });
  const implied = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "on" }, configPath: "/nonexistent/config.json", warn });
  const off = resolveConsent({ env: { [TELEMETRY_ENV_VAR]: "off" }, configPath: "/nonexistent/config.json", proxyBase: "http://127.0.0.1:4399", warn });
  assert.deepEqual([canonical.scope_bypassed, implied.scope_bypassed, off.state], [undefined, undefined, "off"]);
  assert.deepEqual(warnings, []);
});

test("scopedConsentCommand names --proxy-base only for a non-canonical scope", () => {
  assert.equal(scopedConsentCommand(CANONICAL_REMIT_SCOPE), "campaigns-os telemetry on");
  assert.equal(scopedConsentCommand(null), "campaigns-os telemetry on");
  assert.equal(scopedConsentCommand("http://127.0.0.1:4399/"), "campaigns-os telemetry on --proxy-base http://127.0.0.1:4399");
});

test("CLI: telemetry on --proxy-base writes a grant scoped to that base, and status reports the scope", async () => {
  await withTempDir((dir) => {
    const env = cliEnv(dir);
    const on = JSON.parse(execFileSync("node", [CLI, "telemetry", "on", "--proxy-base", "http://127.0.0.1:4399/", "--json"], { encoding: "utf8", env }));
    assert.equal(on.scope, "http://127.0.0.1:4399");
    assert.equal(on.scope_canonical, false);
    assert.deepEqual([on.state, on.source], ["on", "file"]);
    const stored = JSON.parse(readFileSync(resolveConfigPath({ env }), "utf8"));
    assert.equal(stored.telemetry.scope, "http://127.0.0.1:4399");

    // Checked against the canonical endpoint, the grant does not apply.
    const canonical = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }));
    assert.equal(canonical.scope, "http://127.0.0.1:4399");
    assert.equal(canonical.checked_endpoint, CANONICAL_REMIT_SCOPE);
    assert.deepEqual([canonical.state, canonical.scope_mismatch], ["off", true]);

    // Checked against the granted base, it does.
    const scoped = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--proxy-base", "http://127.0.0.1:4399", "--json"], { encoding: "utf8", env }));
    assert.deepEqual([scoped.state, scoped.source, scoped.scope_mismatch], ["on", "file", false]);

    const text = execFileSync("node", [CLI, "telemetry", "status"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
    assert.match(text, /^Scope: http:\/\/127\.0\.0\.1:4399$/m);
    assert.match(text, /Scope mismatch — the stored grant is for http:\/\/127\.0\.0\.1:4399, so remit to https:\/\/campaign-map\.nextcommerce\.com is OFF\. Consent to it with: campaigns-os telemetry on$/m);

    // Plain `telemetry on` re-scopes the grant to the canonical endpoint.
    const back = JSON.parse(execFileSync("node", [CLI, "telemetry", "on", "--json"], { encoding: "utf8", env }));
    assert.equal(back.scope, CANONICAL_REMIT_SCOPE);
    assert.equal(back.scope_canonical, true);
  });
});

test("CLI: telemetry on refuses a plain-http base that is not loopback, and writes nothing", async () => {
  await withTempDir((dir) => {
    const env = cliEnv(dir);
    const refused = runCli(["telemetry", "on", "--proxy-base", "http://example.invalid:8080"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /telemetry on: --proxy-base must be https \(or a loopback host for local testing\)/);
    assert.equal(readConfig(resolveConfigPath({ env })).ok, false);
  });
});

test("CLI: telemetry status --proxy-base applies the same transport rule as telemetry on", async () => {
  await withTempDir((dir) => {
    const env = cliEnv(dir);
    const refused = runCli(["telemetry", "status", "--proxy-base", "http://example.invalid:8080"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /telemetry status: --proxy-base must be https \(or a loopback host for local testing\)/);
    assert.doesNotMatch(refused.stdout, /Checked endpoint:/);
    const notUrl = runCli(["telemetry", "status", "--proxy-base", "not a url"], env);
    assert.equal(notUrl.status, 1);
    assert.match(notUrl.stderr, /telemetry status: --proxy-base is not a URL: not a url/);
  });
});

test("CLI: telemetry off takes no --proxy-base, and an OFF record after a scoped grant carries no scope", async () => {
  await withTempDir((dir) => {
    const env = cliEnv(dir);
    execFileSync("node", [CLI, "telemetry", "on", "--proxy-base", "http://127.0.0.1:4399", "--json"], { encoding: "utf8", env });

    const refused = runCli(["telemetry", "off", "--proxy-base", "http://127.0.0.1:4399"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /telemetry off: --proxy-base is not accepted; turning telemetry off applies to every endpoint\. To grant one endpoint instead, run: campaigns-os telemetry on --proxy-base http:\/\/127\.0\.0\.1:4399/);
    // The refusal wrote nothing: the scoped grant is still in place.
    const kept = readConfig(resolveConfigPath({ env })).config.telemetry;
    assert.deepEqual([kept.enabled, kept.scope], [true, "http://127.0.0.1:4399"]);

    const off = JSON.parse(execFileSync("node", [CLI, "telemetry", "off", "--json"], { encoding: "utf8", env }));
    assert.deepEqual([off.state, off.source, off.scope, off.scope_canonical], ["off", "file", null, false]);
    assert.equal(readConfig(resolveConfigPath({ env })).config.telemetry.scope, null);

    const offText = execFileSync("node", [CLI, "telemetry", "off"], { encoding: "utf8", env });
    assert.match(offText, /^Scope: every endpoint \(an OFF choice is not scoped\)$/m);

    // status shows no Scope: row for an OFF file — nothing reads as granted.
    const status = execFileSync("node", [CLI, "telemetry", "status"], { encoding: "utf8", env });
    assert.match(status, /^Telemetry: off \(source: file\)$/m);
    assert.doesNotMatch(status, /^Scope:/m);
    const scoped = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--proxy-base", "http://127.0.0.1:4399", "--json"], { encoding: "utf8", env }));
    assert.deepEqual([scoped.state, scoped.scope, scoped.scope_mismatch], ["off", null, false]);
  });
});

test("CLI: telemetry status names the endpoint the env override bypasses scope checking for", async () => {
  await withTempDir((dir) => {
    const env = { ...cliEnv(dir), [TELEMETRY_ENV_VAR]: "on" };
    const text = execFileSync("node", [CLI, "telemetry", "status", "--proxy-base", "http://127.0.0.1:4399"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
    assert.match(text, /^Telemetry: on \(source: env\) — CAMPAIGNS_OS_TELEMETRY bypasses scope checking for http:\/\/127\.0\.0\.1:4399$/m);
  });
});

test("CLI: a file grant scoped to a loopback receiver remits there without the env override, and nowhere else", async () => {
  await withTempDir(async (dir) => {
    const granted = await startLoopbackReceiver();
    const other = await startLoopbackReceiver();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scoped-consent-target", private: true }));
      const packetPath = join(dir, "campaign-runtime.build.json");
      writeFileSync(packetPath, readFileSync(resolve(ROOT, "examples/build-packet.basic.json")));
      const env = cliEnv(dir);

      const on = await runCliAsync(["telemetry", "on", "--proxy-base", granted.base, "--json"], env);
      assert.equal(on.status, 0, on.stderr);

      const landed = await runCliAsync(["run-record", "--packet", packetPath, "--run-id", "run_1789300000000_scoped", "--proxy-base", granted.base, "--json"], env, dir);
      assert.equal(landed.status, 0, landed.stderr);
      const record = JSON.parse(landed.stdout).record;
      assert.deepEqual([record.consent_state, record.consent_source, record.remit_state], ["on", "file", "ok"]);
      assert.equal(granted.posts.length, 1);
      assert.equal(granted.posts[0].payload.run_id, "run_1789300000000_scoped");

      // The same grant does not cover a different receiver: nothing is sent.
      const elsewhere = await runCliAsync(["run-record", "--packet", packetPath, "--run-id", "run_1789300000000_other", "--proxy-base", other.base], env, dir);
      assert.equal(elsewhere.status, 0, elsewhere.stderr);
      assert.match(elsewhere.stdout, /^Remit: skipped \(consent off\)\.$/m);
      assert.match(elsewhere.stdout, new RegExp(`^Consent: off \\(default\\) — file consent is scoped to ${granted.base.replace(/[.]/g, "\\.")}, not ${other.base.replace(/[.]/g, "\\.")}; consent to this endpoint with: campaigns-os telemetry on --proxy-base ${other.base.replace(/[.]/g, "\\.")}$`, "m"));
      assert.equal(other.posts.length, 0);
      assert.equal(granted.posts.length, 1);
    } finally {
      await granted.close();
      await other.close();
    }
  });
});

test("CLI: help lists --proxy-base on run end and on telemetry status|on, and off without it", () => {
  const help = execFileSync("node", [CLI, "help"], { encoding: "utf8", env: cliEnv(tmpdir()) });
  assert.match(help, /campaigns-os run end \[--packet <json>\] \[--no-remit\] \[--no-write\] \[--proxy-base <url>\] \[--json\]/);
  assert.match(help, /campaigns-os telemetry status\|on \[--proxy-base <url>\] \[--json\]/);
  assert.match(help, /campaigns-os telemetry off \[--json\] +# turn remit off for every endpoint \(takes no --proxy-base\)/);
});
