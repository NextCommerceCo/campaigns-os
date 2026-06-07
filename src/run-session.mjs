// Run Telemetry — ambient run session for Campaigns OS.
// See docs/workflow-findings-sidecar.md (Run Telemetry).
//
// A run session makes telemetry AMBIENT: `run start` writes one small file to
// the project's .campaign-runtime/, and every subsequent command auto-discovers
// it (walking up from cwd) to share one run_id and one lifecycle journal —
// WITHOUT the operator threading --run-id / --lifecycle-journal on each call.
// `run end` assembles the aggregated Run Record and clears the session. This is
// the experience for "talk to your agent and build": the agent runs `run start`
// once, builds, then `run end`. No flag bookkeeping.
//
// The session file is transient, machine-local, and lives under the
// scrubber-ignored .campaign-runtime/. No network, no credentials.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";

export const RUN_SESSION_SCHEMA = "campaigns-os-run-session/v0";
export const RUN_SESSION_REL_PATH = ".campaign-runtime/run-session.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Canonical session path for a project root: <root>/.campaign-runtime/run-session.json */
export function resolveRunSessionPath(rootDir = process.cwd()) {
  return join(resolve(rootDir), RUN_SESSION_REL_PATH);
}

/**
 * Walk up from `cwd` to find an active run session, so commands run from a
 * subdirectory still share the project's session. Best-effort: never throws; a
 * missing or malformed session file simply means "no active session".
 * Returns `{ session, path, dir }` or null.
 */
export function findRunSession(cwd = process.cwd()) {
  let dir = resolve(cwd);
  const { root } = parse(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, RUN_SESSION_REL_PATH);
    if (existsSync(candidate)) {
      try {
        const session = JSON.parse(readFileSync(candidate, "utf8"));
        if (session && typeof session === "object" && !Array.isArray(session) && isNonEmptyString(session.run_id)) {
          return { session, path: candidate, dir };
        }
      } catch {
        // malformed session file => treat as no active session
      }
      return null;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

/** Mint the session's canonical run_id (same shape as the run-record minter). */
export function mintSessionRunId(now = new Date()) {
  return `run_${now.getTime()}_${randomBytes(4).toString("hex")}`;
}

/** Build the session object (its own schema_version, the run_id, the journal it owns, an optional packet, and a timestamp). */
export function buildRunSession({ runId, lifecycleJournal, packet = null, now = new Date() }) {
  return {
    schema_version: RUN_SESSION_SCHEMA,
    run_id: runId,
    lifecycle_journal: lifecycleJournal,
    packet: isNonEmptyString(packet) ? packet : null,
    started_at: now.toISOString(),
  };
}

/** Atomically write the session file under <rootDir>/.campaign-runtime/. */
export function writeRunSession(rootDir, session) {
  const path = resolveRunSessionPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** Remove the active session file so the next `run start` is clean. Non-fatal. */
export function clearRunSession(sessionPath) {
  try {
    rmSync(sessionPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
