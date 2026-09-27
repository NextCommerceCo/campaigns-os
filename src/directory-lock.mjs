// A cross-process exclusive lock held as a directory.
//
// The lock directory and its owner record appear together: a holder builds
// `<lock>.staging-<token>/owner.json` beside the lock and renames the staging
// directory onto the lock path. The rename never replaces an existing entry,
// so of several processes exactly one publishes, and there is no moment at
// which the lock exists without the owner that holds it. Before entering its
// critical section the holder re-reads owner.json and requires its own token
// (fencing), and on release it only ever removes a directory that still
// carries its token.
//
// A lock left behind by a process that died is recovered: the owner's pid no
// longer exists, and one waiter claims recovery exclusively (the claim is
// published the same staged way) before renaming the abandoned lock away. An
// interrupted recovery claim fails closed rather than being stolen, which
// would reintroduce a check/rename race. A lock directory WITHOUT an owner
// record is never taken over: this module cannot produce one, so it belongs
// to an older writer that may still be alive between its mkdir and its owner
// write (#501). A waiter refuses it after a short grace, leaving it for the
// documented offline procedure. (See publishStagedDirectory for the one
// mixed-version race this cannot close, tracked in #514.)
//
// The lock is reentrant for its holder: code running inside `fn` (in the
// same async context) that asks for the same lock enters directly instead of
// waiting on itself. prepare-build holds the per-target lock and can reach
// stage writers that take it too.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const heldLocks = new AsyncLocalStorage();

const readOwner = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const exists = (path) => {
  try { lstatSync(path); return true; } catch { return false; }
};

// The reentrancy key names the lock directory through its real parent, so a
// holder that reached the target through a symlink still recognizes itself.
function lockKey(path) {
  const absolute = resolve(path);
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}

function stageOwnedDirectory(stagingPath, owner) {
  rmSync(stagingPath, { recursive: true, force: true });
  mkdirSync(stagingPath);
  try {
    writeFileSync(join(stagingPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

// rename(2) onto a non-empty directory fails with one of these; the holder
// may already have released by the time the error is seen, so they are
// contention whether or not the destination still exists.
const CONTENTION_CODES = new Set(["EEXIST", "ENOTEMPTY"]);
// Codes some platforms use for an existing destination (EPERM on Windows)
// that are also genuine failures: contention only while the destination
// exists.
const MAYBE_CONTENTION_CODES = new Set(["EPERM", "ENOTDIR", "EISDIR"]);

// Returns false when `dest` is held by someone else; throws on any other
// failure. The staging directory is gone either way.
function publishStagedDirectory(stagingPath, dest) {
  try {
    // rename(2) replaces an EMPTY destination directory, so never rename over
    // an existing entry. This module never leaves an empty directory at a
    // lock path; only an older release does, for the instant between its
    // mkdir and its owner write. A new writer's check-then-rename can land in
    // that instant and replace it, so running an older release and this one
    // on the same target at the same moment is not safe (#501; tracked in #514).
    if (exists(dest)) return false;
    try {
      renameSync(stagingPath, dest);
    } catch (error) {
      if (CONTENTION_CODES.has(error?.code)) return false;
      if (MAYBE_CONTENTION_CODES.has(error?.code) && exists(dest)) return false;
      throw error;
    }
    return true;
  } finally {
    rmSync(stagingPath, { recursive: true, force: true });
  }
}

// An ownerless lock is never taken over, so waiting out the whole budget on
// one only delays the refusal. A live older writer fills its owner within
// microseconds; one still ownerless after this grace is refused at once.
const OWNERLESS_GRACE_MS = 1000;

function createLock(path, { budgetMs, unavailable, now = Date.now, ownerlessGraceMs = OWNERLESS_GRACE_MS }) {
  const token = randomBytes(16).toString("hex");
  const start = now();
  const owner = { pid: process.pid, token };
  const ownerPath = join(path, "owner.json");
  const stagingPath = `${path}.staging-${token}`;

  const abandoned = () => {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const current = readOwner(ownerPath);
      if (!(Number.isInteger(current?.pid) && current.pid > 0 && typeof current.token === "string")) return false;
      try { process.kill(current.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    } catch {
      return false;
    }
  };

  const recover = () => {
    if (!abandoned()) return;
    const deadToken = readOwner(ownerPath)?.token;
    const claim = join(path, ".recovery");
    try {
      const claimStaging = `${path}.recovery-staging-${token}`;
      stageOwnedDirectory(claimStaging, owner);
      if (!publishStagedDirectory(claimStaging, claim)) return;
    } catch {
      return;
    }
    let moved = false;
    try {
      // Re-check under the claim: the owner must still be the same dead one.
      if (!abandoned() || readOwner(ownerPath)?.token !== deadToken) return;
      const tomb = `${path}.abandoned-${token}`;
      renameSync(path, tomb);
      moved = true;
      rmSync(tomb, { recursive: true, force: true });
    } catch {
      // Leave the lock for the next waiter or the offline procedure.
    } finally {
      if (!moved && readOwner(join(claim, "owner.json"))?.token === token) {
        try { rmSync(claim, { recursive: true, force: true }); } catch {}
      }
    }
  };

  const stage = () => stageOwnedDirectory(stagingPath, owner);
  // Publish, then fence on the token actually on disk.
  const publish = () => publishStagedDirectory(stagingPath, path) && readOwner(ownerPath)?.token === token;
  const heldBySelfProcess = () => readOwner(ownerPath)?.pid === process.pid;
  let ownerlessSince = null;
  const ownerless = () => {
    try {
      return lstatSync(path).isDirectory() && !exists(ownerPath);
    } catch {
      return false;
    }
  };
  // True once the budget is spent, or once the lock has stayed ownerless past
  // the grace period.
  const expired = () => {
    const current = now();
    if (ownerless()) {
      ownerlessSince ??= current;
      if (current - ownerlessSince >= ownerlessGraceMs) return true;
    } else {
      ownerlessSince = null;
    }
    return current - start >= budgetMs;
  };
  const fail = (error) => unavailable(error);
  const contended = () => Object.assign(new Error(`Lock is held: ${path}`), { code: "EEXIST" });

  const release = () => {
    if (readOwner(ownerPath)?.token !== token) return;
    const tomb = `${path}.released-${token}`;
    try { renameSync(path, tomb); } catch { return; }
    if (readOwner(join(tomb, "owner.json"))?.token === token) {
      rmSync(tomb, { recursive: true, force: true });
    } else {
      // Not ours after all: put it back rather than delete another holder's lock.
      try { renameSync(tomb, path); } catch {}
    }
  };

  return { token, stage, publish, recover, heldBySelfProcess, expired, fail, contended, release };
}

function reentrantKey(path) {
  const key = lockKey(path);
  const token = heldLocks.getStore()?.get(key);
  const held = Boolean(token) && readOwner(join(path, "owner.json"))?.token === token;
  return { key, held };
}

function runHolding(key, token, fn) {
  const held = new Map(heldLocks.getStore() ?? []);
  held.set(key, token);
  return heldLocks.run(held, fn);
}

// Options: budgetMs, unavailable(error) -> Error; test seams: now() for the
// budget clock, sleep(ms) between attempts, hooks.beforePublish() awaited
// between staging the owner and publishing the lock.
export async function withDirectoryLock(path, fn, options) {
  const { key, held } = reentrantKey(path);
  if (held) return fn();
  const lock = createLock(path, options);
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  while (true) {
    let acquired;
    try {
      lock.stage();
      if (options.hooks?.beforePublish) await options.hooks.beforePublish();
      acquired = lock.publish();
    } catch (error) {
      throw lock.fail(error);
    }
    if (acquired) break;
    if (lock.expired()) throw lock.fail(lock.contended());
    lock.recover();
    await sleep(20);
  }
  try {
    return await runHolding(key, lock.token, fn);
  } finally {
    lock.release();
  }
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// The synchronous form, for writers whose callers are synchronous. It blocks
// the event loop while it waits, so when the lock is held by this same
// process outside the caller's async context it refuses at once instead of
// waiting out its budget: that holder cannot run until this call returns.
export function withDirectoryLockSync(path, fn, options) {
  const { key, held } = reentrantKey(path);
  if (held) return fn();
  const lock = createLock(path, options);
  while (true) {
    let acquired;
    try {
      lock.stage();
      options.hooks?.beforePublish?.();
      acquired = lock.publish();
    } catch (error) {
      throw lock.fail(error);
    }
    if (acquired) break;
    if (lock.expired() || lock.heldBySelfProcess()) throw lock.fail(lock.contended());
    lock.recover();
    (options.sleep ?? sleepSync)(20);
  }
  try {
    return runHolding(key, lock.token, fn);
  } finally {
    lock.release();
  }
}
