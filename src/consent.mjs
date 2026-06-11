// Run Telemetry consent — machine/user-level opt-OUT, resolved through one
// shared resolver that EVERY remitting command calls (not a start-only
// prompt). See docs/workflow-findings-sidecar.md (Consent).
//
// Consent gates REMIT only. Local capture (the Run Record) always happens.
// Resolution precedence: env override > user-level config file > default.
// The DEFAULT is ON for the canonical NEXT endpoint only (announced at remit
// time with the endpoint and the opt-out command); any other endpoint stays
// fail-closed until explicitly consented. An unknown env value fails closed
// (no remit) with a warning, never a silent guess; a malformed config file
// also resolves OFF — an unreadable prior choice is never overridden by the
// default.

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

export function normalizeConsentScope(value) {
  if (!isNonEmptyString(value)) return null;
  const raw = value.trim();
  const normalizeUrl = (input) => {
    try {
      const url = new URL(input);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.origin}${path}`;
    } catch {
      return null;
    }
  };
  const direct = normalizeUrl(raw);
  if (direct) return direct;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    return normalizeUrl(`https://${raw}`);
  }
  return null;
}

// The canonical NEXT remit endpoint. Default-on consent applies ONLY to this
// scope; any other proxy base needs an explicit operator choice. Stored in
// NORMALIZED form (and asserted at module load) so a scheme change, typo, or
// trailing slash here cannot silently flip the default; compare requested
// scopes against this export, never against a string literal.
export const CANONICAL_REMIT_SCOPE = normalizeConsentScope("https://campaign-map.nextcommerce.com");
if (!CANONICAL_REMIT_SCOPE) {
  throw new Error("CANONICAL_REMIT_SCOPE failed to normalize; default-on consent would misfire.");
}

function assertConsentState(state) {
  if (state !== "on" && state !== "off") {
    throw new Error('Telemetry consent state must be "on" or "off".');
  }
}

function defaultWarn(message) {
  process.stderr.write(`${message}\n`);
}

function configState(state) {
  assertConsentState(state);
  return state === "on";
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

function fileConsentScope(config) {
  return normalizeConsentScope(config?.telemetry?.scope);
}

function scopeMatches(storedScope, requestedScope) {
  const requested = normalizeConsentScope(requestedScope);
  if (!requested) return true;
  const stored = normalizeConsentScope(storedScope);
  return Boolean(stored && stored === requested);
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
      enabled: configState(state),
      scope: normalizeConsentScope(proxyBase),
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
 * With no env and no usable file, the CANONICAL endpoint resolves to the
 * announced default: `{ state: "on", source: "default", resolved: true,
 * default_on: true }`. `resolved` is false only for the remaining
 * fail-closed defaults — a malformed config file, a scope mismatch, or a
 * non-canonical endpoint with no explicit choice — where an interactive
 * command may then prompt to set it.
 */
export function resolveConsent({
  env = process.env,
  configPath = resolveConfigPath(),
  proxyBase = null,
  warn = defaultWarn,
} = {}) {
  const raw = env[TELEMETRY_ENV_VAR];
  const parsed = parseEnvConsent(raw);
  // Normalized once; both the file-scope branch and the default branch
  // compare against this same value.
  const requestedScope = normalizeConsentScope(proxyBase);
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
    if (fileState === "off") return { state: "off", source: "file", resolved: true };
    if (fileState === "on") {
      const storedScope = fileConsentScope(config);
      if (scopeMatches(storedScope, requestedScope)) {
        return { state: "on", source: "file", resolved: true, scope: storedScope };
      }
      warn(`[campaigns-os] telemetry consent at ${configPath} is scoped to ${storedScope || "(unscoped)"}, not ${requestedScope}; treating telemetry as OFF until this endpoint is confirmed.`);
      return {
        state: "off",
        source: "default",
        resolved: false,
        scope_mismatch: true,
        consent_scope: storedScope,
        requested_scope: requestedScope,
      };
    }
  }

  // No env, no usable file → default ON for the canonical NEXT endpoint.
  // Run Telemetry is how the toolchain improves (capture is always local;
  // this gates only the remit), so an operator who never expressed a choice
  // shares by default and opts out with `campaigns-os telemetry off` or
  // CAMPAIGNS_OS_TELEMETRY=off. The grant is exactly two cases:
  //   1. proxyBase ABSENT (null/undefined/empty) — remitting commands fall
  //      back to the canonical default endpoint, so the scope IS canonical;
  //   2. proxyBase normalizes to the canonical scope.
  // A non-empty proxyBase that fails to normalize is NOT canonical — it
  // stays fail-closed like any other unapproved endpoint. The remit-time
  // announcement names the endpoint explicitly.
  // (An absent proxyBase always normalizes to a null requestedScope, so the
  // two cases below are disjoint: absent → canonical fallback; present →
  // must normalize to the canonical scope exactly.)
  const proxyBaseAbsent = !isNonEmptyString(proxyBase);
  if (proxyBaseAbsent || requestedScope === CANONICAL_REMIT_SCOPE) {
    return { state: "on", source: "default", resolved: true, default_on: true, scope: CANONICAL_REMIT_SCOPE };
  }
  return { state: "off", source: "default", resolved: false };
}

// Announce default-on telemetry at most once per process, naming the exact
// endpoint so the operator knows where the data goes before it goes there.
// Once-per-PROCESS is the designed semantic: the CLI is one-shot, so this is
// once per command for normal usage, while a long-lived harness importing
// remitting commands directly gets one announcement per process instead of
// stderr noise on every record. The injectable `write` keeps the contract
// testable without exposing the latch.
let defaultOnAnnounced = false;
export function announceDefaultOnTelemetry(endpoint, { write = (line) => process.stderr.write(line) } = {}) {
  if (defaultOnAnnounced) return false;
  defaultOnAnnounced = true;
  write(`[campaigns-os] Run telemetry is ON by default: anonymized run records are sent to ${endpoint || CANONICAL_REMIT_SCOPE} to improve templates, tooling, and guidance. Disable with \`campaigns-os telemetry off\` or CAMPAIGNS_OS_TELEMETRY=off.\n`);
  return true;
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
 * resolved state exists yet — which, under default-on for the canonical
 * endpoint, means the prompt effectively fires only for NON-canonical remit
 * scopes (staging/self-hosted) that need an explicit yes. Persists the
 * answer so later runs don't re-ask. Non-interactive unresolved callers stay
 * fail-closed OFF without blocking — telemetry never blocks a build. `ask`
 * is injectable for tests.
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
  const existing = resolveConsent({ env, configPath, proxyBase, warn: () => {} });
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
