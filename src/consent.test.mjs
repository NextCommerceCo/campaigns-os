import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  parseEnvConsent,
  promptAndPersistConsent,
  readConfig,
  resolveConfigPath,
  resolveConsent,
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

test("resolveConsent: file missing -> OFF (fail-closed default, unresolved)", async () => {
  await withTempDir((dir) => {
    const result = resolveConsent({ env: {}, configPath: join(dir, "config.json"), warn: quiet });
    assert.equal(result.state, "off");
    assert.equal(result.source, "default");
    assert.equal(result.resolved, false);
  });
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

test("promptAndPersistConsent: non-interactive never prompts and stays OFF", async () => {
  await withTempDir(async (dir) => {
    let asked = false;
    const result = await promptAndPersistConsent({
      configPath: join(dir, "config.json"),
      env: {},
      isTTY: false,
      ask: async () => { asked = true; return "y"; },
    });
    assert.equal(asked, false);
    assert.equal(result.state, "off");
    assert.equal(result.prompted, false);
  });
});

test("promptAndPersistConsent: interactive empty answer defaults ON and persists", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const result = await promptAndPersistConsent({ configPath, env: {}, isTTY: true, ask: async () => "" });
    assert.equal(result.state, "on");
    assert.equal(result.prompted, true);
    // persisted, so a later resolve reads it from file without re-asking
    assert.deepEqual([resolveConsent({ env: {}, configPath, warn: quiet }).state], ["on"]);
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

test("CLI: telemetry status defaults OFF when nothing is configured", async () => {
  await withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    delete env[TELEMETRY_ENV_VAR];
    const status = JSON.parse(execFileSync("node", [CLI, "telemetry", "status", "--json"], { encoding: "utf8", env }));
    assert.equal(status.state, "off");
    assert.equal(status.source, "default");
    assert.equal(status.resolved, false);
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
