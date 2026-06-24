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
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";

export const RUN_SESSION_SCHEMA = "campaigns-os-run-session/v0";
export const RUN_SESSION_REL_PATH = ".campaign-runtime/run-session.json";
export const RUN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Files that mark a project root. Session discovery never climbs ABOVE the
// nearest project root, so a stray session in an unrelated ancestor (e.g.
// $HOME or a shared /tmp) can't hijack commands run inside a real project.
const PROJECT_ROOT_MARKERS = [".git", "package.json"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isProjectRoot(dir) {
  return PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
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
 *
 * Scope is bounded to the project to prevent a stray ancestor session from
 * hijacking unrelated commands:
 *  - the walk STOPS at the nearest project root (a dir with .git/package.json),
 *    so a session in an ancestor ABOVE the project is never adopted;
 *  - a session located at $HOME, ANY ancestor of $HOME (e.g. /Users), or the
 *    filesystem root is never honored — those are shared dirs, not project roots.
 *
 * `home` is injectable for tests.
 */
export function isRunSessionStale(session, { now = new Date(), ttlMs = RUN_SESSION_TTL_MS } = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) return false;
  const activity = isNonEmptyString(session.updated_at) ? session.updated_at : session.started_at;
  const timestamp = Date.parse(activity || "");
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > ttlMs;
}

export function isRunSessionTerminal(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  return session.terminal === true
    || session.status === "terminal"
    || session.last_recommendation?.stage === "done";
}

export function findRunSession(cwd = process.cwd(), { home = homedir(), now = new Date(), ttlMs = RUN_SESSION_TTL_MS } = {}) {
  let dir = resolve(cwd);
  const { root } = parse(dir);
  const resolvedHome = resolve(home);
  // True when `dir` is $HOME itself or a strict ancestor of it (e.g. /Users).
  const isHomeOrAncestor = (d) => d === resolvedHome || resolvedHome.startsWith(d + sep);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, RUN_SESSION_REL_PATH);
    if (existsSync(candidate)) {
      // A session at the filesystem root, $HOME, or an ancestor of $HOME is not
      // a project session — honoring it would capture every command beneath it.
      if (dir === root || isHomeOrAncestor(dir)) return null;
      try {
        const session = JSON.parse(readFileSync(candidate, "utf8"));
        if (session && typeof session === "object" && !Array.isArray(session) && isNonEmptyString(session.run_id) && !isRunSessionStale(session, { now, ttlMs })) {
          return { session, path: candidate, dir };
        }
      } catch {
        // malformed session file => treat as no active session
      }
      return null;
    }
    // Don't climb past the project boundary: the session must live within the
    // project being built, not in an unrelated ancestor directory.
    if (isProjectRoot(dir)) break;
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
  const createdAt = now.toISOString();
  return {
    schema_version: RUN_SESSION_SCHEMA,
    run_id: runId,
    lifecycle_journal: lifecycleJournal,
    packet: isNonEmptyString(packet) ? packet : null,
    started_at: createdAt,
    updated_at: createdAt,
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
