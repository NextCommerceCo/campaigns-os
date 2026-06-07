// Run Telemetry consent — machine/user-level opt-out, resolved through one
// shared resolver that EVERY remitting command calls (not a start-only
// prompt). See docs/workflow-findings-sidecar.md (Consent).
//
// Consent gates REMIT only. Local capture (the Run Record) always happens.
// Resolution precedence: env override > user-level config file > fail-closed
// default OFF. An unknown env value fails closed (no remit) with a warning,
// never a silent guess. Unknown + non-interactive (no file, no env, no TTY)
// is OFF — we never remit without an explicit yes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TELEMETRY_ENV_VAR = "CAMPAIGNS_OS_TELEMETRY";
export const TELEMETRY_CONFIG_SCHEMA = "campaigns-os-telemetry-config/v0";
const PACKAGE_NAME = "@nextcommerce/campaigns-os";

// Env override accepts exactly these tokens. Anything else is "unknown" and
// fails closed — strictness is the point (an env typo must not silently remit).
const ENV_TRUE = new Set(["1", "true", "on"]);
const ENV_FALSE = new Set(["0", "false", "off"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultWarn(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Parse the CAMPAIGNS_OS_TELEMETRY env value.
 * Returns `{ state: "on"|"off"|null, present, unknown }`.
 * - absent/empty: `{ state: null, present: false, unknown: false }`
 * - recognized:   `{ state, present: true, unknown: false }`
 * - anything else:`{ state: null, present: true, unknown: true }` (fail closed)
 */
export function parseEnvConsent(raw) {
  if (raw == null) return { state: null, present: false, unknown: false };
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "") return { state: null, present: false, unknown: false };
  if (ENV_TRUE.has(normalized)) return { state: "on", present: true, unknown: false };
  if (ENV_FALSE.has(normalized)) return { state: "off", present: true, unknown: false };
  return { state: null, present: true, unknown: true };
}

/**
 * User-level config path. Consent belongs to the operator/machine, not the
 * campaign. Honors XDG_CONFIG_HOME, else ~/.config/campaigns-os/config.json.
 */
export function resolveConfigPath({ env = process.env, home = homedir() } = {}) {
  const base = isNonEmptyString(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "campaigns-os", "config.json");
}

/**
 * Read the config file. Never throws — a missing file is `{ ok: false }`, a
 * malformed file is `{ malformed: true }` (the resolver treats that as OFF).
 */
export function readConfig(configPath) {
  if (!isNonEmptyString(configPath) || !existsSync(configPath)) {
    return { ok: false, config: null, malformed: false };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { ok: false, config: null, malformed: true };
    }
    return { ok: true, config, malformed: false };
  } catch {
    return { ok: false, config: null, malformed: true };
  }
}

function fileConsentState(config) {
  const telemetry = config?.telemetry;
  if (telemetry && typeof telemetry === "object") {
    if (telemetry.enabled === true) return "on";
    if (telemetry.enabled === false) return "off";
  }
  return null;
}

/**
 * Persist consent at user level. Records its own schema_version, the package
 * name, the proxy/endpoint scope, a timestamp, and the value source — so the
 * decision is auditable. Returns `{ configPath, config }`.
 */
export function writeConsentConfig(state, {
  configPath = resolveConfigPath(),
  proxyBase = null,
  source = "telemetry-command",
  now = new Date(),
} = {}) {
  const config = {
    schema_version: TELEMETRY_CONFIG_SCHEMA,
    package: PACKAGE_NAME,
    telemetry: {
      enabled: state === "on",
      scope: proxyBase || null,
      updated_at: now.toISOString(),
      source,
    },
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, config };
}

/**
 * The shared resolver every remitting command calls. Returns
 * `{ state: "on"|"off", source: "env"|"file"|"default", resolved }`.
 * `resolved` is false only when the state is the fail-closed default (no env,
 * no usable file) — an interactive command may then prompt to set it.
 */
export function resolveConsent({
  env = process.env,
  configPath = resolveConfigPath(),
  warn = defaultWarn,
} = {}) {
  const raw = env[TELEMETRY_ENV_VAR];
  const parsed = parseEnvConsent(raw);
  if (parsed.unknown) {
    warn(`[campaigns-os] ${TELEMETRY_ENV_VAR}="${raw}" is not a recognized value (use 1|true|on|0|false|off). Telemetry remit is OFF for safety.`);
    return { state: "off", source: "env", resolved: true };
  }
  if (parsed.state) {
    return { state: parsed.state, source: "env", resolved: true };
  }

  const { ok, config, malformed } = readConfig(configPath);
  if (malformed) {
    warn(`[campaigns-os] telemetry config at ${configPath} is malformed; treating telemetry as OFF.`);
    return { state: "off", source: "default", resolved: false };
  }
  if (ok) {
    const fileState = fileConsentState(config);
    if (fileState) return { state: fileState, source: "file", resolved: true };
  }

  // No env, no usable file → fail closed.
  return { state: "off", source: "default", resolved: false };
}

async function defaultAsk(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The up-front, ask-once prompt. Only prompts when interactive (TTY) AND no
 * explicit choice exists yet; persists the answer so later runs don't re-ask.
 * Non-interactive callers get the fail-closed default OFF without blocking —
 * telemetry never blocks a build. `ask` is injectable for tests.
 *
 * The [Y/n] capitalization makes "on" the default for an empty Enter, matching
 * the design's plainly-worded prompt.
 */
export async function promptAndPersistConsent({
  configPath = resolveConfigPath(),
  env = process.env,
  proxyBase = null,
  isTTY = Boolean(process.stdin && process.stdin.isTTY),
  ask = defaultAsk,
  now = new Date(),
} = {}) {
  // An explicit env/file decision is never overridden by a prompt.
  const existing = resolveConsent({ env, configPath, warn: () => {} });
  if (existing.resolved) return { ...existing, prompted: false };
  if (!isTTY) return { state: "off", source: "default", resolved: false, prompted: false };

  const answer = await ask(
    "Campaigns OS can send build telemetry to Next Commerce to improve templates, tools, and guidance. Share telemetry from this machine? [Y/n] (change any time): ",
  );
  const normalized = String(answer || "").trim().toLowerCase();
  const state = (normalized === "" || ["y", "yes", "1", "true", "on"].includes(normalized)) ? "on" : "off";
  writeConsentConfig(state, { configPath, proxyBase, source: "prompt", now });
  return { state, source: "file", resolved: true, prompted: true };
}
